// 批准接口:把等人点头的事项汇成一张单子,并记下每次决定的来源与操作者。
// 本文件只管存储与校验:执行者发起的批准请求、决定记录、批准令牌、远程入口的审计与配置。
// 事项本身不另存一份:server.mjs 每次从卡片、版本、锁的现状算出来,决定也路由回各自原有的处理逻辑。
// 表只由看板服务创建(server.mjs 打开库后调用 migrate)。
const crypto = require("crypto");
const net = require("net");
const store = require("./store.js");
const { err, ERR } = store;
const { isUnsafeChar, hasUnsafeText } = require("./coord.js");

const KINDS = Object.freeze(["decision", "delivery", "release", "version", "lock", "request"]);
// 事项 id = 类型:对象:版本。对象的状态一变版本就变,同一个 id 只对应一个确定的状态:可以重放,不会落到新状态上。
const ID_RE = /^(decision|delivery|release|version|lock|request):([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_.-]{1,200})$/;
const RISKS = Object.freeze(["low", "medium", "high"]);
const ACTION_MAX = 300, NOTE_MAX = 500, DEVICE_MAX = 64, LABEL_MAX = 40, SUMMARY_MAX = 160;
const CLIENT_RE = /^[a-z][a-z0-9_.-]{0,31}$/;
// 每个执行者同时待批准的请求上限;批准令牌同时有效的上限。
const OPEN_REQUESTS_MAX = 20;
const LIVE_TOKENS_MAX = 20;
const TOKEN_RE = /^apr_[0-9a-f]{48}$/;
// 一行文字里的控制字符与双向控制符换成这个可见的占位(U+FFFD)。
const PLACEHOLDER = String.fromCodePoint(0xfffd);

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const iso = (ms) => new Date(Number(ms)).toISOString();
const chars = (s) => [...String(s)].length;

function appendOnly(db, t, key = "id") {
  // REPLACE 在冲突时删旧行却不触发 DELETE 触发器(recursive_triggers 没开):主键已存在的插入也在这里拒绝。
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_replace BEFORE INSERT ON ${t} WHEN EXISTS (SELECT 1 FROM ${t} WHERE ${key} = NEW.${key})
           BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
}

function migrate(db) {
  // 执行者主动发起的批准请求:只追加。是否已决定看 approval_decisions。
  db.exec(`CREATE TABLE IF NOT EXISTS approval_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    executor TEXT NOT NULL,
    action TEXT NOT NULL,
    risk TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  appendOnly(db, "approval_requests");
  // 决定记录:一项一行,主键就是事项 id,所以同一项不可能被决定两次。只追加。
  db.exec(`CREATE TABLE IF NOT EXISTS approval_decisions (
    approval_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    object_id TEXT NOT NULL,
    version TEXT NOT NULL,
    decision TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL,
    via TEXT NOT NULL,
    client TEXT NOT NULL,
    device TEXT,
    ip TEXT,
    at TEXT NOT NULL,
    journal_id INTEGER,
    result TEXT NOT NULL DEFAULT '{}'
  )`);
  appendOnly(db, "approval_decisions", "approval_id");
  // 批准令牌:只存 sha256。吊销写 revoked_at,不删行。
  db.exec(`CREATE TABLE IF NOT EXISTS approval_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT
  )`);
  // 远程入口的每一次调用:只追加。
  db.exec(`CREATE TABLE IF NOT EXISTS remote_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    ip TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    token_id INTEGER,
    note TEXT NOT NULL DEFAULT ''
  )`);
  appendOnly(db, "remote_audit");
}

/** 白话一行:空白折成一个空格,超长截断并留「…」。折叠后剩下的控制字符与双向控制符换成可见的占位:
 *  标题与摘要会进终端、控制台日志和远程客户端,ESC 之类能改写屏幕上别的事项。 */
function oneLine(text, max = SUMMARY_MAX) {
  const a = [...String(text ?? "").replace(/\s+/g, " ").trim()].map((ch) => isUnsafeChar(ch) ? PLACEHOLDER : ch);
  return a.length > max ? a.slice(0, max - 1).join("") + "…" : a.join("");
}
const makeId = (kind, object, version) => `${kind}:${object}:${version}`;
function parseId(raw) {
  const m = ID_RE.exec(String(raw ?? ""));
  if (!m) throw err(ERR.BAD_INPUT, `事项 id 要写成 类型:对象:版本,类型是 ${KINDS.join(" / ")} —— 收到 ${JSON.stringify(String(raw ?? "")).slice(0, 80)}`);
  return { kind: m[1], object: m[2], version: m[3] };
}

/** 决定请求体:{decision, note?, source:{client, device?}, expected_version}。 */
function normalizeDecision(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw err(ERR.BAD_INPUT, "请求正文必须是 JSON 对象");
  const decision = body.decision;
  if (!["approve", "reject"].includes(decision)) throw err(ERR.BAD_INPUT, "decision 只接受 approve 或 reject");
  const note = body.note == null ? "" : body.note;
  if (typeof note !== "string") throw err(ERR.BAD_INPUT, "note 必须是字符串");
  if (chars(note.trim()) > NOTE_MAX) throw err(ERR.BAD_INPUT, `note 最多 ${NOTE_MAX} 字`);
  const src = body.source;
  if (!src || typeof src !== "object" || Array.isArray(src)) throw err(ERR.BAD_INPUT, "source 必须是 {client, device?}");
  const client = typeof src.client === "string" ? src.client : "";
  if (!CLIENT_RE.test(client)) throw err(ERR.BAD_INPUT, "source.client 只允许小写字母开头的字母、数字和 . _ -,1-32 位");
  let device = null;
  if (src.device != null && src.device !== "") {
    if (typeof src.device !== "string" || chars(src.device) > DEVICE_MAX || hasUnsafeText(src.device) || src.device.trim() !== src.device)
      throw err(ERR.BAD_INPUT, `source.device 必须是不含控制字符、首尾无空白的字符串,最多 ${DEVICE_MAX} 字`);
    device = src.device;
  }
  const ev = body.expected_version;
  if (ev === undefined || ev === null || ev === "" || !["number", "string"].includes(typeof ev))
    throw err(ERR.BAD_INPUT, "expected_version 必填:用列表里这一项的 expected_version");
  return { decision, note: note.trim(), source: { client, device }, expected_version: ev };
}

function decisionOut(r) {
  if (!r) return null;
  let result = {}; try { result = JSON.parse(r.result || "{}"); } catch {}
  return { approval_id: r.approval_id, kind: r.kind, object_id: r.object_id, version: r.version, decision: r.decision,
           note: r.note, actor: r.actor, via: r.via, source: { client: r.client, device: r.device ?? null },
           ip: r.ip ?? null, at: r.at, journal_id: r.journal_id == null ? null : Number(r.journal_id), result };
}
const decisionOf = (db, id) => decisionOut(db.prepare("SELECT * FROM approval_decisions WHERE approval_id=?").get(String(id)));
function listDecisions(db, { limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  return db.prepare("SELECT * FROM approval_decisions ORDER BY at DESC, rowid DESC LIMIT ?").all(lim).map(decisionOut);
}
/** 写决定记录。主键冲突 = 这一项已经决定过。 */
function recordDecision(db, rec, now = Date.now()) {
  const { kind, object, version } = parseId(rec.approval_id);
  try {
    db.prepare(`INSERT INTO approval_decisions (approval_id, kind, object_id, version, decision, note, actor, via, client, device, ip, at, journal_id, result)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(rec.approval_id, kind, object, version, rec.decision, rec.note || "", String(rec.actor), String(rec.via),
           rec.source.client, rec.source.device ?? null, rec.ip ?? null, iso(now), rec.journal_id ?? null, JSON.stringify(rec.result ?? {}));
  } catch (e) {
    if (/UNIQUE|PRIMARY KEY|append-only/.test(String(e.message))) throw err(ERR.CONFLICT, `${rec.approval_id} 已经决定过,不能再决定`);
    throw e;
  }
  return decisionOf(db, rec.approval_id);
}

function requestOut(r) {
  if (!r) return null;
  return { id: Number(r.id), executor: r.executor, action: r.action, risk: r.risk, created_at: r.created_at,
           approval_id: makeId("request", r.id, 1) };
}
const OPEN_SQL = `SELECT r.* FROM approval_requests r
  LEFT JOIN approval_decisions d ON d.approval_id = 'request:' || r.id || ':1'
  WHERE d.approval_id IS NULL`;
/** 执行者发起批准请求:动作描述(白话一行)+ 风险等级。 */
function addRequest(db, executor, { action, risk } = {}, now = Date.now()) {
  if (typeof action !== "string" || !action.trim()) throw err(ERR.BAD_INPUT, "action 必须是非空字符串:要做什么");
  // 换行与制表符照旧折成空格;其余控制字符与双向控制符直接拒绝,不让它进只追加的请求表。
  if (hasUnsafeText(action.replace(/\s+/g, " "))) throw err(ERR.BAD_INPUT, "action 不能含控制字符或双向控制符");
  const text = oneLine(action, Infinity);
  if (chars(text) > ACTION_MAX) throw err(ERR.BAD_INPUT, `action 最多 ${ACTION_MAX} 字,实际 ${chars(text)}`);
  if (!RISKS.includes(risk)) throw err(ERR.BAD_INPUT, `risk 只接受 ${RISKS.join(" / ")}`);
  const open = db.prepare(`SELECT COUNT(*) n FROM (${OPEN_SQL}) WHERE executor=?`).get(String(executor)).n;
  if (open >= OPEN_REQUESTS_MAX) throw err(ERR.CONFLICT, `${executor} 已有 ${open} 个请求在等批准,上限 ${OPEN_REQUESTS_MAX}`);
  const r = db.prepare("INSERT INTO approval_requests (executor, action, risk, created_at) VALUES (?,?,?,?)")
    .run(String(executor), text, risk, iso(now));
  return requestOut(db.prepare("SELECT * FROM approval_requests WHERE id=?").get(r.lastInsertRowid));
}
const getRequest = (db, id) => requestOut(db.prepare("SELECT * FROM approval_requests WHERE id=?").get(Number(id)));
const openRequests = (db) => db.prepare(OPEN_SQL + " ORDER BY r.id").all().map(requestOut);

function tokenOut(r) {
  if (!r) return null;
  return { id: Number(r.id), label: r.label, created_at: r.created_at, revoked_at: r.revoked_at ?? null,
           last_used_at: r.last_used_at ?? null, active: r.revoked_at == null };
}
/** 操作员生成批准令牌。明文只在这里返回一次,库里只存 sha256。 */
function createToken(db, { label } = {}, now = Date.now()) {
  const name = typeof label === "string" ? label.trim() : "";
  if (!name || chars(name) > LABEL_MAX || hasUnsafeText(name)) throw err(ERR.BAD_INPUT, `label 必填,不含控制字符,最多 ${LABEL_MAX} 字`);
  const live = db.prepare("SELECT COUNT(*) n FROM approval_tokens WHERE revoked_at IS NULL").get().n;
  if (live >= LIVE_TOKENS_MAX) throw err(ERR.CONFLICT, `有效的批准令牌已有 ${live} 枚,上限 ${LIVE_TOKENS_MAX};先吊销不用的`);
  const token = "apr_" + crypto.randomBytes(24).toString("hex");
  const r = db.prepare("INSERT INTO approval_tokens (label, token_hash, created_at) VALUES (?,?,?)").run(name, sha256(token), iso(now));
  return { token, record: tokenOut(db.prepare("SELECT * FROM approval_tokens WHERE id=?").get(r.lastInsertRowid)) };
}
const listTokens = (db) => db.prepare("SELECT * FROM approval_tokens ORDER BY id").all().map(tokenOut);
function revokeToken(db, id, now = Date.now()) {
  const r = db.prepare("SELECT * FROM approval_tokens WHERE id=?").get(Number(id));
  if (!r) throw err(ERR.NOT_FOUND, `批准令牌 #${id} 不存在`);
  if (r.revoked_at) throw err(ERR.CONFLICT, `批准令牌 #${id} 已于 ${r.revoked_at} 吊销`);
  db.prepare("UPDATE approval_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(iso(now), Number(id));
  return tokenOut(db.prepare("SELECT * FROM approval_tokens WHERE id=?").get(Number(id)));
}
/** 明文 → 有效的批准令牌记录;查不到或已吊销返回 null。只按哈希比较。 */
function tokenByValue(db, token, now = Date.now()) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const r = db.prepare("SELECT * FROM approval_tokens WHERE token_hash=? AND revoked_at IS NULL").get(sha256(token));
  if (!r) return null;
  db.prepare("UPDATE approval_tokens SET last_used_at=? WHERE id=?").run(iso(now), r.id);
  return tokenOut({ ...r, last_used_at: iso(now) });
}

function audit(db, { ip, method, path, status, tokenId = null, note = "" } = {}, now = Date.now()) {
  db.prepare("INSERT INTO remote_audit (at, ip, method, path, status, token_id, note) VALUES (?,?,?,?,?,?,?)")
    .run(iso(now), String(ip || "?").slice(0, 64), String(method || "?").slice(0, 10), String(path || "").slice(0, 200),
         Number(status) || 0, tokenId == null ? null : Number(tokenId), String(note || "").slice(0, 40));
}
function listAudit(db, { limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  return db.prepare("SELECT * FROM remote_audit ORDER BY id DESC LIMIT ?").all(lim)
    .map((r) => ({ id: Number(r.id), at: r.at, ip: r.ip, method: r.method, path: r.path, status: Number(r.status),
                   token_id: r.token_id == null ? null : Number(r.token_id), note: r.note }));
}

// ── 远程入口配置:remote_access: {enabled, listen: [], allow_ips: [], allow_wildcard_listen?}
const normalizeIp = (addr) => { const s = String(addr || ""); const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s); return m ? m[1] : s; };
// 通配地址按解析后的地址判断,不按字面:::0.0.0.0、0:0:0:0:0:0:0.0.0.0、::ffff:0.0.0.0(IPv4 映射的通配)同样是监听全部网卡。
const WILDCARDS = new net.BlockList();
WILDCARDS.addAddress("0.0.0.0", "ipv4"); WILDCARDS.addAddress("::", "ipv6"); WILDCARDS.addAddress("::ffff:0.0.0.0", "ipv6");
const isWildcard = (host) => { const fam = net.isIP(host); return !!fam && WILDCARDS.check(host, fam === 4 ? "ipv4" : "ipv6"); };
function parseListen(entry) {
  let host, port;
  if (typeof entry === "string") {
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(entry) || /^([^:[\]]+):(\d+)$/.exec(entry);
    if (!m) throw new Error(`listen 项要写成 "地址:端口" 或 "[IPv6地址]:端口",收到 ${JSON.stringify(entry)}`);
    host = m[1]; port = Number(m[2]);
  } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    host = String(entry.host ?? ""); port = Number(entry.port);
  } else throw new Error(`listen 项要写成 "地址:端口",收到 ${JSON.stringify(entry)}`);
  if (!net.isIP(host)) throw new Error(`listen 地址必须是 IP 字面量,收到 ${JSON.stringify(host)}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`listen 端口必须是 1-65535 的整数,收到 ${JSON.stringify(entry)}`);
  return { host, port };
}
/** 关闭(或没写)时只返回 {enabled:false},其余键不读,行为和没有这项配置时完全一样。打开时任何一项不合格都抛错。 */
function parseRemoteConfig(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw) || raw.enabled !== true) return Object.freeze({ enabled: false });
  if (!Array.isArray(raw.listen) || !raw.listen.length) throw new Error("enabled 为 true 时 listen 必须是非空数组");
  const listen = raw.listen.map(parseListen);
  const wildcardOk = raw.allow_wildcard_listen === true;
  for (const l of listen)
    if (isWildcard(l.host) && !wildcardOk)
      throw new Error(`listen 不接受通配地址 ${l.host};只监听 VPN 或局域网网卡的地址,确需监听全部网卡另加 allow_wildcard_listen:true`);
  if (!Array.isArray(raw.allow_ips) || !raw.allow_ips.length) throw new Error("enabled 为 true 时 allow_ips 必须是非空数组");
  const list = new net.BlockList(), allow = [];
  for (const e of raw.allow_ips) {
    const s = String(e ?? "").trim();
    const m = /^([^/]+)\/(\d{1,3})$/.exec(s);
    const addr = m ? m[1] : s, fam = net.isIP(addr);
    if (!fam) throw new Error(`allow_ips 项必须是 IP 或 CIDR,收到 ${JSON.stringify(e)}`);
    const type = fam === 4 ? "ipv4" : "ipv6";
    if (m) {
      const bits = Number(m[2]);
      if (bits < 1 || bits > (fam === 4 ? 32 : 128)) throw new Error(`allow_ips 前缀长度不合格(不接受 /0):${s}`);
      // IPv4 来源是按 ::ffff:a.b.c.d 与 IPv6 前缀比较的:盖住整个 ::ffff:0:0/96 的 IPv6 前缀等于放行全部 IPv4,也就是 /0。
      if (fam === 6) {
        const one = new net.BlockList(); one.addSubnet(addr, bits, type);
        if (one.check("::ffff:0.0.0.0", "ipv6") && one.check("::ffff:255.255.255.255", "ipv6"))
          throw new Error(`allow_ips 这一项放行了全部 IPv4 来源(等于 /0),不接受:${s}`);
      }
      list.addSubnet(addr, bits, type);
    } else list.addAddress(addr, type);
    allow.push(s);
  }
  const allows = (ip) => { const a = normalizeIp(ip), fam = net.isIP(a); return !!fam && list.check(a, fam === 4 ? "ipv4" : "ipv6"); };
  return Object.freeze({ enabled: true, listen, allow_ips: allow, allow_wildcard_listen: wildcardOk, allows });
}
const formatListen = (l) => (net.isIP(l.host) === 6 ? `[${l.host}]` : l.host) + ":" + l.port;

module.exports = {
  migrate, KINDS, RISKS, oneLine, makeId, parseId, normalizeDecision,
  decisionOf, listDecisions, recordDecision,
  addRequest, getRequest, openRequests, OPEN_REQUESTS_MAX, ACTION_MAX, NOTE_MAX,
  createToken, listTokens, revokeToken, tokenByValue, LIVE_TOKENS_MAX,
  audit, listAudit, normalizeIp, parseRemoteConfig, formatListen,
};
