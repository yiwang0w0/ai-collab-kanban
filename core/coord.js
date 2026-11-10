// 多执行者协作:执行者身份与令牌、心跳、各方状态、资源锁、事件流水、交接包。
// 执行者可以是看板的执行线,也可以是看板外的 AI 会话。令牌只存哈希,明文只在登记时返回一次。
// 表只由看板服务创建(server.mjs 打开库后调用 migrate),store 的其他调用方不受影响。
const crypto = require("crypto");
const store = require("./store.js");
const { err, ERR } = store;

const EXECUTOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EXECUTOR_KINDS = ["line", "external", "other"];
const NAME_MAX = 40;
// 执行者令牌领卡/续租时的租约上限(分钟)。操作员令牌仍按 store.MAX_LEASE_MIN。
const EXECUTOR_MAX_LEASE_MIN = 240;
// 各方状态 {current, done[], next[]} 的上限。超出即拒绝写入,不截断。
const STATUS_LIMITS = Object.freeze({ current: 300, item: 300, done: 50, next: 20, total: 16000 });
// 资源名是中性字符串(如 device:test-phone、build:apk);看板不解释它指什么。
const RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,79}$/;
const LOCK_MAX_MIN = 1440;
const PURPOSE_MAX = 120;
const REASON_MAX = 200;
// 事件流水:只追加,一行一件。正文不超过 300 字;产物按类型校验格式。
// 正文、锁用途、状态各项与 url / path 产物都不接受换行、控制字符与双向控制符(URL 解析器会吞掉换行、把 ESC 编码掉而不报错,所以另查原始串)。
const JOURNAL_BODY_MAX = 300;
const JOURNAL_KIND_RE = /^[a-z][a-z0-9_.-]{0,31}$/;
const ARTIFACT_MAX = 20;
const ARTIFACT_CHECK = Object.freeze({
  sha256: (v) => /^[0-9a-f]{64}$/.test(v),
  commit: (v) => /^[0-9a-f]{7,40}$/.test(v),
  path: (v) => v.length > 0 && v.length <= 260 && v.trim() === v && !hasUnsafeText(v),
  url: (v) => { try { const u = new URL(v); return ["http:", "https:"].includes(u.protocol) && v.length <= 500 && !u.username && !u.password && !hasUnsafeText(v); }
               catch { return false; } },
});
// 交接包里 done / next 各自的字数预算。超出预算的项整项换成指向 full_status 的指针,不从中间截断。
const HANDOFF_LIST_BUDGET = 2000;
const HANDOFF_RECENT_JOURNAL = 10;
// 看板自己写流水时用的执行者名;不允许登记成执行者 id。
const RESERVED_IDS = ["operator", "system"];

// 控制字符(C0、DEL、C1)、行/段分隔符与双向控制符:进了终端或日志会改写别的行、调换显示顺序。
// 码点用数字写,源码里不出现这些字符本身。
const isUnsafeCp = (c) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ||
  (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
const isUnsafeChar = (ch) => isUnsafeCp(ch.codePointAt(0));
const hasUnsafeText = (s) => { for (const ch of String(s)) if (isUnsafeChar(ch)) return true; return false; };

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const iso = (ms) => ms == null ? null : new Date(Number(ms)).toISOString();
const chars = (s) => [...String(s)].length;

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS coord_executors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    token_issued_at TEXT NOT NULL,
    last_seen INTEGER,
    stopped_at INTEGER,
    stop_seq INTEGER NOT NULL DEFAULT 0
  )`);
  // 锁:一行一次持有。未释放的行对同一资源唯一(部分唯一索引 = 库层互斥)。时刻都由服务端测。
  db.exec(`CREATE TABLE IF NOT EXISTS coord_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource TEXT NOT NULL,
    holder TEXT NOT NULL REFERENCES coord_executors(id),
    purpose TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    expected_end INTEGER NOT NULL,
    released_at INTEGER,
    released_by TEXT,
    release_reason TEXT,
    overdue_notified_at INTEGER
  )`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_coord_lock_held ON coord_locks(resource) WHERE released_at IS NULL");
  // 流水只追加:没有改写和删除接口,库层触发器也挡住 UPDATE 与 DELETE。
  db.exec(`CREATE TABLE IF NOT EXISTS coord_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    executor TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    artifacts TEXT NOT NULL DEFAULT '[]'
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS ix_coord_journal_executor ON coord_journal(executor, id)");
  db.exec(`CREATE TRIGGER IF NOT EXISTS coord_journal_no_update BEFORE UPDATE ON coord_journal
           BEGIN SELECT RAISE(ABORT, 'coord journal is append-only'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS coord_journal_no_delete BEFORE DELETE ON coord_journal
           BEGIN SELECT RAISE(ABORT, 'coord journal is append-only'); END`);
  // 交接记录只追加:同一执行者的同一次停止(stop_seq)只有一份;确认接手另记一张只追加的表。
  db.exec(`CREATE TABLE IF NOT EXISTS coord_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    executor TEXT NOT NULL REFERENCES coord_executors(id),
    stop_seq INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    package TEXT NOT NULL,
    full_status TEXT NOT NULL,
    UNIQUE(executor, stop_seq)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS coord_handoff_acks (
    handoff_id INTEGER PRIMARY KEY REFERENCES coord_handoffs(id),
    by TEXT NOT NULL,
    at TEXT NOT NULL
  )`);
  for (const t of ["coord_handoffs", "coord_handoff_acks"]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
  }
  // REPLACE(INSERT OR REPLACE / REPLACE INTO)在冲突时删掉旧行,而 recursive_triggers 没开时不触发上面的 DELETE 触发器:
  // 再加一道 BEFORE INSERT,主键或唯一键已存在就拒绝。自增插入时 NEW.id 还没有值,不受影响。
  for (const [t, hit] of [["coord_journal", "id = NEW.id"], ["coord_handoff_acks", "handoff_id = NEW.handoff_id"],
                          ["coord_handoffs", "id = NEW.id OR (executor = NEW.executor AND stop_seq = NEW.stop_seq)"]])
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_replace BEFORE INSERT ON ${t} WHEN EXISTS (SELECT 1 FROM ${t} WHERE ${hit})
             BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
  db.exec(`CREATE TABLE IF NOT EXISTS coord_status (
    executor_id TEXT PRIMARY KEY REFERENCES coord_executors(id),
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

const EMPTY_STATUS = Object.freeze({ current: "", done: [], next: [] });
function statusOf(db, id) {
  const r = db.prepare("SELECT status, updated_at FROM coord_status WHERE executor_id=?").get(String(id));
  if (!r) return { ...EMPTY_STATUS, done: [], next: [], updated_at: null };
  let st = {}; try { st = JSON.parse(r.status); } catch {}
  return { current: String(st.current ?? ""), done: Array.isArray(st.done) ? st.done : [],
           next: Array.isArray(st.next) ? st.next : [], updated_at: r.updated_at };
}

/** 校验并整份替换执行者自己的状态。任一项超限即 BAD_INPUT,说明哪一项、上限与实际值。 */
function setStatus(db, executorId, body = {}, now = Date.now()) {
  if (!getRow(db, executorId)) throw err(ERR.NOT_FOUND, `执行者 ${executorId} 未登记`);
  const L = STATUS_LIMITS;
  const over = (what, limit, got) => { throw Object.assign(err(ERR.BAD_INPUT,
    `状态超出上限,未写入:${what} 上限 ${limit},实际 ${got}。请精简后重写,看板不截断`), { limit, got, field: what }); };
  const current = body.current == null ? "" : body.current;
  if (typeof current !== "string") throw err(ERR.BAD_INPUT, "current 必须是字符串");
  if (chars(current) > L.current) over("current 字数", L.current, chars(current));
  if (hasUnsafeText(current)) throw err(ERR.BAD_INPUT, "current 不能含换行、控制字符或双向控制符,未写入");
  const list = (name, max) => {
    const v = body[name] == null ? [] : body[name];
    if (!Array.isArray(v)) throw err(ERR.BAD_INPUT, `${name} 必须是字符串数组`);
    if (v.length > max) over(`${name} 项数`, max, v.length);
    v.forEach((x, i) => {
      if (typeof x !== "string" || !x.trim()) throw err(ERR.BAD_INPUT, `${name}[${i}] 必须是非空字符串`);
      if (chars(x) > L.item) over(`${name}[${i}] 字数`, L.item, chars(x));
      if (hasUnsafeText(x)) throw err(ERR.BAD_INPUT, `${name}[${i}] 不能含换行、控制字符或双向控制符,未写入`);
    });
    return v;
  };
  const st = { current, done: list("done", L.done), next: list("next", L.next) };
  const text = JSON.stringify(st);
  if (chars(text) > L.total) over("整份状态字数", L.total, chars(text));
  const at = iso(now);
  db.prepare(`INSERT INTO coord_status (executor_id, status, updated_at) VALUES (?,?,?)
              ON CONFLICT(executor_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`)
    .run(String(executorId), text, at);
  return { ...st, updated_at: at };
}

function executorOut(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, kind: r.kind, created_at: r.created_at,
           token_issued_at: r.token_issued_at, last_seen: iso(r.last_seen),
           stopped_at: iso(r.stopped_at), active: r.stopped_at == null };
}

function getRow(db, id) {
  return db.prepare("SELECT * FROM coord_executors WHERE id=?").get(String(id));
}

/** 这个名字是不是已登记的执行者 id(领卡身份检查用)。 */
const isExecutor = (db, id) => (typeof id === "string" || typeof id === "number") && !!getRow(db, id);   // 数字落库时也会变成字符串

/** 操作员登记执行者。返回明文令牌(只此一次)。rotate=true 时为已登记的执行者换发令牌,旧令牌立即失效。 */
function register(db, { id, name, kind, rotate = false } = {}, now = Date.now()) {
  const eid = String(id ?? "").trim();
  if (!EXECUTOR_ID_RE.test(eid))
    throw err(ERR.BAD_INPUT, `执行者 id 只允许小写字母、数字、- 或 _,1-32 位,以字母或数字开头 —— 收到 ${JSON.stringify(id)}`);
  if (RESERVED_IDS.includes(eid)) throw err(ERR.BAD_INPUT, `执行者 id 不能用保留名 ${RESERVED_IDS.join(" / ")}`);
  const have = getRow(db, eid);
  // 换发令牌时没给的显示名与种类保持原样;只有新登记才用默认值(显示名 = id,种类 = external)。
  const nm = String(name ?? "").trim() || have?.name || eid;
  if (chars(nm) > NAME_MAX) throw err(ERR.BAD_INPUT, `显示名最多 ${NAME_MAX} 字`);
  kind = kind ?? have?.kind ?? "external";
  if (!EXECUTOR_KINDS.includes(kind)) throw err(ERR.BAD_INPUT, `kind 只接受 ${EXECUTOR_KINDS.join(" / ")} —— 收到 ${JSON.stringify(kind)}`);
  const token = "exe_" + crypto.randomBytes(24).toString("hex");
  const at = iso(now);
  if (have && !rotate) throw err(ERR.CONFLICT, `执行者 ${eid} 已登记;换发令牌请带 rotate:true`);
  if (have) db.prepare("UPDATE coord_executors SET name=?, kind=?, token_hash=?, token_issued_at=? WHERE id=?")
    .run(nm, kind, sha256(token), at, eid);
  else db.prepare("INSERT INTO coord_executors (id,name,kind,token_hash,created_at,token_issued_at) VALUES (?,?,?,?,?,?)")
    .run(eid, nm, kind, sha256(token), at, at);
  return { executor: executorOut(getRow(db, eid)), token, rotated: !!have };
}

/** 令牌 → 执行者;查不到返回 null。只按哈希比较,库里没有明文。 */
function byToken(db, token) {
  if (typeof token !== "string" || !token.startsWith("exe_")) return null;
  return executorOut(db.prepare("SELECT * FROM coord_executors WHERE token_hash=?").get(sha256(token)));
}

function lockOut(db, r, now = Date.now(), graceMs = 30 * 60000) {
  if (!r) return null;
  const name = db.prepare("SELECT name FROM coord_executors WHERE id=?").get(r.holder)?.name ?? r.holder;
  return { id: Number(r.id), resource: r.resource, holder: r.holder, holder_name: name, purpose: r.purpose,
           started_at: iso(r.started_at), expected_end: iso(r.expected_end),
           released_at: iso(r.released_at), released_by: r.released_by ?? null, release_reason: r.release_reason ?? null,
           overdue: r.released_at == null && now > Number(r.expected_end) + graceMs,
           overdue_notified_at: iso(r.overdue_notified_at) };
}
const heldRow = (db, resource) =>
  db.prepare("SELECT * FROM coord_locks WHERE resource=? AND released_at IS NULL").get(String(resource));

/** 加锁。已被占用 → {ok:false, holder};不抢锁、不排队。 */
function acquire(db, executorId, { resource, minutes, purpose } = {}, now = Date.now(), graceMs) {
  if (!getRow(db, executorId)) throw err(ERR.NOT_FOUND, `执行者 ${executorId} 未登记`);
  const res = String(resource ?? "");
  if (!RESOURCE_RE.test(res))
    throw err(ERR.BAD_INPUT, `资源名只允许字母、数字和 . _ : / @ -,1-80 位,以字母或数字开头 —— 收到 ${JSON.stringify(resource)}`);
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0 || mins > LOCK_MAX_MIN)
    throw err(ERR.BAD_INPUT, `预计时长 minutes 必须是 0 到 ${LOCK_MAX_MIN} 之间的分钟数`);
  const why = String(purpose ?? "").trim();
  if (!why) throw err(ERR.BAD_INPUT, "加锁必须写用途 purpose");
  if (chars(why) > PURPOSE_MAX) throw err(ERR.BAD_INPUT, `用途最多 ${PURPOSE_MAX} 字`);
  if (hasUnsafeText(why)) throw err(ERR.BAD_INPUT, "用途写成一行,不能含换行、控制字符或双向控制符");
  try {
    const r = db.prepare("INSERT INTO coord_locks (resource, holder, purpose, started_at, expected_end) VALUES (?,?,?,?,?)")
      .run(res, String(executorId), why, now, Math.round(now + mins * 60000));
    return { ok: true, lock: lockOut(db, db.prepare("SELECT * FROM coord_locks WHERE id=?").get(r.lastInsertRowid), now, graceMs) };
  } catch (e) {
    if (!/UNIQUE constraint/.test(String(e.message))) throw e;
    return { ok: false, holder: lockOut(db, heldRow(db, res), now, graceMs) };
  }
}

/** 释放。执行者只能释放自己持有的锁;操作员必须 force:true 并写理由。 */
function release(db, actor, { resource, force = false, reason } = {}, now = Date.now(), graceMs) {
  const row = heldRow(db, resource);
  if (!row) throw err(ERR.NOT_FOUND, `资源 ${JSON.stringify(resource)} 当前没有被锁`);
  if (actor.role === "operator") {
    const why = String(reason ?? "").trim();
    if (force !== true || !why) throw err(ERR.BAD_INPUT, "操作员强制释放需要 force:true 和理由 reason");
    if (chars(why) > REASON_MAX) throw err(ERR.BAD_INPUT, `理由最多 ${REASON_MAX} 字`);
    db.prepare("UPDATE coord_locks SET released_at=?, released_by='operator', release_reason=? WHERE id=? AND released_at IS NULL")
      .run(now, why, row.id);
  } else {
    if (row.holder !== actor.id) return { ok: false, holder: lockOut(db, row, now, graceMs) };
    db.prepare("UPDATE coord_locks SET released_at=?, released_by=? WHERE id=? AND released_at IS NULL").run(now, actor.id, row.id);
  }
  return { ok: true, lock: lockOut(db, db.prepare("SELECT * FROM coord_locks WHERE id=?").get(row.id), now, graceMs) };
}

function listLocks(db, { holder = null, all = false, limit = 50 } = {}, now = Date.now(), graceMs) {
  const rows = all
    ? db.prepare("SELECT * FROM coord_locks ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(500, Number(limit) || 50)))
    : holder == null ? db.prepare("SELECT * FROM coord_locks WHERE released_at IS NULL ORDER BY started_at, id").all()
    : db.prepare("SELECT * FROM coord_locks WHERE released_at IS NULL AND holder=? ORDER BY started_at, id").all(String(holder));
  return rows.map((r) => lockOut(db, r, now, graceMs));
}

/** 超过预计结束 graceMs 仍未释放的锁:每把只标记一次(overdue_notified_at),返回本次新标记的。不自动释放。 */
function sweepOverdue(db, now = Date.now(), graceMs = 30 * 60000) {
  const rows = db.prepare(`SELECT * FROM coord_locks WHERE released_at IS NULL AND overdue_notified_at IS NULL
                             AND expected_end + ? < ? ORDER BY id`).all(graceMs, now);
  const out = [];
  for (const r of rows) {
    const u = db.prepare("UPDATE coord_locks SET overdue_notified_at=? WHERE id=? AND overdue_notified_at IS NULL").run(now, r.id);
    if (u.changes) out.push(lockOut(db, { ...r, overdue_notified_at: now }, now, graceMs));
  }
  return out;
}

function journalOut(r) {
  let artifacts = []; try { artifacts = JSON.parse(r.artifacts || "[]"); } catch {}
  return { id: Number(r.id), at: r.at, executor: r.executor, kind: r.kind, body: r.body, artifacts };
}

function normalizeArtifacts(raw) {
  const list = raw == null ? [] : raw;
  if (!Array.isArray(list)) throw err(ERR.BAD_INPUT, "artifacts 必须是数组");
  if (list.length > ARTIFACT_MAX) throw err(ERR.BAD_INPUT, `产物最多 ${ARTIFACT_MAX} 个`);
  return list.map((a, i) => {
    // type 必须本身是字符串:数组会被 String() 和属性访问强转成合法类型名,然后原样(任意深度)入库。
    const type = a?.type, check = typeof type === "string" && Object.hasOwn(ARTIFACT_CHECK, type) ? ARTIFACT_CHECK[type] : null;
    if (!check) throw err(ERR.BAD_INPUT, `artifacts[${i}].type 只接受 ${Object.keys(ARTIFACT_CHECK).join(" / ")}`);
    let value = typeof a.value === "string" ? a.value : "";
    if (type === "sha256" || type === "commit") value = value.toLowerCase();
    if (!check(value)) throw err(ERR.BAD_INPUT, `artifacts[${i}] 不是有效的 ${type}:${JSON.stringify(String(a.value ?? "")).slice(0, 80)}`);
    return { type, value };
  });
}

/** 追加一条流水。时刻由服务端测;executor 由调用方按令牌给出(看板自己写时是 operator / system)。 */
function appendJournal(db, executor, { kind, body, artifacts } = {}, now = Date.now()) {
  const k = String(kind ?? "");
  if (!JOURNAL_KIND_RE.test(k)) throw err(ERR.BAD_INPUT, `kind 只允许小写字母开头的字母、数字和 . _ -,1-32 位 —— 收到 ${JSON.stringify(kind)}`);
  if (typeof body !== "string" || !body.trim()) throw err(ERR.BAD_INPUT, "body 必须是非空字符串");
  if (chars(body) > JOURNAL_BODY_MAX) throw err(ERR.BAD_INPUT, `正文最多 ${JOURNAL_BODY_MAX} 字,实际 ${chars(body)},未写入`);
  if (hasUnsafeText(body)) throw err(ERR.BAD_INPUT, "流水一行一件:正文不能含换行、控制字符或双向控制符,未写入");
  const arts = normalizeArtifacts(artifacts);
  const r = db.prepare("INSERT INTO coord_journal (at, executor, kind, body, artifacts) VALUES (?,?,?,?,?)")
    .run(iso(now), String(executor), k, body, JSON.stringify(arts));
  return journalOut(db.prepare("SELECT * FROM coord_journal WHERE id=?").get(r.lastInsertRowid));
}

/** 查流水:since = 流水编号(取其后)或 ISO 时刻(取其后);不给 since 时取最近 limit 条。均按编号升序返回。 */
function journal(db, { since = null, executor = null, limit = 50 } = {}) {
  const lim = Number(limit ?? 50);
  if (!Number.isInteger(lim) || lim < 1 || lim > 500) throw err(ERR.BAD_INPUT, "limit 必须是 1..500 的整数");
  const where = [], args = [];
  if (since != null && since !== "") {
    if (/^\d+$/.test(String(since))) { where.push("id > ?"); args.push(Number(since)); }
    else if (!Number.isNaN(Date.parse(String(since)))) { where.push("at > ?"); args.push(new Date(String(since)).toISOString()); }
    else throw err(ERR.BAD_INPUT, "since 必须是流水编号或 ISO 时刻");
  }
  if (executor != null && executor !== "") { where.push("executor = ?"); args.push(String(executor)); }
  const w = where.length ? " WHERE " + where.join(" AND ") : "";
  const rows = since != null && since !== ""
    ? db.prepare(`SELECT * FROM coord_journal${w} ORDER BY id LIMIT ?`).all(...args, lim)
    : db.prepare(`SELECT * FROM coord_journal${w} ORDER BY id DESC LIMIT ?`).all(...args, lim).reverse();
  return rows.map(journalOut);
}

/** 列表整项取舍:按方向逐项放入预算,第一项放不下就停;其余整项换成指针。 */
function pickWhole(list, field, budget, fromEnd) {
  const idx = list.map((_, i) => i);
  if (fromEnd) idx.reverse();
  const keep = new Set(); let used = 0;
  for (const i of idx) {
    const n = chars(list[i]);
    if (used + n > budget) break;
    keep.add(i); used += n;
  }
  return list.map((x, i) => keep.has(i) ? x : { omitted: true, see: `full_status.${field}[${i}]`, chars: chars(x) });
}

function handoffOut(db, r, { full = false } = {}) {
  if (!r) return null;
  const ack = db.prepare("SELECT by, at FROM coord_handoff_acks WHERE handoff_id=?").get(r.id);
  let pkg = {}; try { pkg = JSON.parse(r.package); } catch {}
  return { id: Number(r.id), executor: r.executor, stop_seq: Number(r.stop_seq), reason: r.reason, created_at: r.created_at,
           package: pkg, ack: ack ? { by: ack.by, at: ack.at } : null,
           ...(full ? { full_status: JSON.parse(r.full_status) } : {}) };
}

/** 停止执行者并生成交接记录。已停止(未再心跳)且此后没有新的状态、流水或锁变化时,返回那一次的记录,不再生成。 */
function stop(db, executorId, reason = "stop", now = Date.now(), graceMs) {
  const own = !db.isTransaction;
  db.exec(own ? "BEGIN IMMEDIATE" : "SAVEPOINT coord_stop");
  try {
    const r = getRow(db, executorId);
    if (!r) throw err(ERR.NOT_FOUND, `执行者 ${executorId} 未登记`);
    let created = false;
    const st = statusOf(db, r.id);
    const recent = db.prepare("SELECT id FROM coord_journal WHERE executor=? ORDER BY id DESC LIMIT ?")
      .all(r.id, HANDOFF_RECENT_JOURNAL).map((x) => Number(x.id)).reverse();
    const lastId = recent.length ? recent[recent.length - 1] : null;
    const locks = listLocks(db, { holder: r.id }, now, graceMs).map((l) =>
      ({ resource: l.resource, purpose: l.purpose, started_at: l.started_at, expected_end: l.expected_end, overdue: l.overdue }));
    // 已停止(多半是心跳中断)之后又写了状态、流水或动了锁:上一份交接包停在那一刻,已经过期,这次重新生成一份。
    // 写状态和流水不算心跳,所以「还在干活但 20 分钟没心跳」的执行者正好走到这里。
    let outdated = false;
    if (r.stopped_at != null) {
      const prev = db.prepare("SELECT package FROM coord_handoffs WHERE executor=? ORDER BY stop_seq DESC LIMIT 1").get(r.id);
      let p = null; try { p = JSON.parse(prev.package); } catch {}
      outdated = !p || p.status_updated_at !== st.updated_at || (p.journal?.last_id ?? null) !== lastId ||
        (p.locks || []).map((l) => l.resource).join(" ") !== locks.map((l) => l.resource).join(" ");
    }
    if (r.stopped_at == null || outdated) {
      const seq = Number(r.stop_seq) + 1;
      db.prepare("UPDATE coord_executors SET stopped_at=?, stop_seq=? WHERE id=?").run(now, seq, r.id);
      const pkg = {
        executor: { id: r.id, name: r.name, kind: r.kind }, reason, stopped_at: iso(now), status_updated_at: st.updated_at,
        goal: st.current,
        done: pickWhole(st.done, "done", HANDOFF_LIST_BUDGET, true),
        next: pickWhole(st.next, "next", HANDOFF_LIST_BUDGET, false),
        journal: { recent_ids: recent, last_id: lastId },
        locks,
      };
      db.prepare(`INSERT INTO coord_handoffs (executor, stop_seq, reason, created_at, package, full_status) VALUES (?,?,?,?,?,?)`)
        .run(r.id, seq, reason, iso(now), JSON.stringify(pkg), JSON.stringify({ current: st.current, done: st.done, next: st.next }));
      created = true;
    }
    const h = db.prepare("SELECT * FROM coord_handoffs WHERE executor=? ORDER BY stop_seq DESC LIMIT 1").get(r.id);
    db.exec(own ? "COMMIT" : "RELEASE coord_stop");
    return { handoff: handoffOut(db, h), created };
  } catch (e) {
    try { db.exec(own ? "ROLLBACK" : "ROLLBACK TO coord_stop; RELEASE coord_stop"); } catch {}
    throw e;
  }
}

/** 心跳超过 staleMs 的活动执行者:按停止处理,各生成一份交接记录。从未心跳过的不算。 */
function sweepStale(db, now = Date.now(), staleMs = 20 * 60000, graceMs) {
  const rows = db.prepare(`SELECT id FROM coord_executors WHERE stopped_at IS NULL AND last_seen IS NOT NULL AND last_seen + ? < ?`)
    .all(staleMs, now);
  return rows.map((x) => stop(db, x.id, "heartbeat_stale", now, graceMs)).filter((x) => x.created).map((x) => x.handoff);
}

function listHandoffs(db, { pending = false, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const rows = pending
    ? db.prepare(`SELECT h.* FROM coord_handoffs h LEFT JOIN coord_handoff_acks a ON a.handoff_id=h.id
                  WHERE a.handoff_id IS NULL ORDER BY h.id DESC LIMIT ?`).all(lim)
    : db.prepare("SELECT * FROM coord_handoffs ORDER BY id DESC LIMIT ?").all(lim);
  return rows.map((r) => handoffOut(db, r));
}

function getHandoff(db, id) {
  const r = db.prepare("SELECT * FROM coord_handoffs WHERE id=?").get(Number(id));
  if (!r) throw err(ERR.NOT_FOUND, `交接记录 #${id} 不存在`);
  return handoffOut(db, r, { full: true });
}

/** 下一个执行者确认接手。每份交接只确认一次。 */
function ackHandoff(db, executorId, id, now = Date.now()) {
  getHandoff(db, id);
  const have = db.prepare("SELECT by, at FROM coord_handoff_acks WHERE handoff_id=?").get(Number(id));
  if (have) throw err(ERR.CONFLICT, `交接记录 #${id} 已由 ${have.by} 于 ${have.at} 确认接手`);
  db.prepare("INSERT INTO coord_handoff_acks (handoff_id, by, at) VALUES (?,?,?)").run(Number(id), String(executorId), iso(now));
  return getHandoff(db, id);
}

function listExecutors(db) {
  return db.prepare("SELECT * FROM coord_executors ORDER BY id").all()
    .map((r) => ({ ...executorOut(r), status: statusOf(db, r.id) }));
}

/** 任意执行者心跳(含卡片心跳)都刷新 last_seen,并回到活动状态。 */
function touch(db, executorId, now = Date.now()) {
  db.prepare("UPDATE coord_executors SET last_seen=?, stopped_at=NULL WHERE id=?").run(now, String(executorId));
}

function executorLease(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, EXECUTOR_MAX_LEASE_MIN) : store.DEFAULT_LEASE_MIN;
}

/** 心跳:更新 last_seen,并为该执行者持有的进行中卡续租。taskId 给定时只续这一张。
 *  已停止的执行者再次心跳 = 回到活动状态;之前生成的交接记录不受影响。 */
function heartbeat(db, executorId, { taskId = null, leaseMin } = {}, now = Date.now()) {
  const r = getRow(db, executorId);
  if (!r) throw err(ERR.NOT_FOUND, `执行者 ${executorId} 未登记`);
  touch(db, r.id, now);
  const cards = taskId == null
    ? db.prepare("SELECT id, run_id, lease_until FROM tasks WHERE status='in_progress' AND worker=? ORDER BY id").all(r.id)
    : db.prepare("SELECT id, run_id, lease_until FROM tasks WHERE status='in_progress' AND worker=? AND id=?").all(r.id, Number(taskId));
  if (taskId != null && !cards.length)
    throw err(ERR.CONFLICT, `卡 #${taskId} 不是 ${r.id} 正在进行的卡,未续租`);
  // 没给 lease 的心跳只往后续:取默认租约与这张卡现有剩余时间里较长的。按默认 30 分钟直接改写,
  // 会把 240 分钟领的卡缩成 30 分钟,半小时后被回收。明确给了 lease 就按给的值。
  const given = Number.isFinite(Number(leaseMin)) && Number(leaseMin) > 0;
  const renewed = cards.map((c) => {
    const keep = Math.min(Math.max(store.DEFAULT_LEASE_MIN, (Number(c.lease_until) - now) / 60000), EXECUTOR_MAX_LEASE_MIN);
    const h = store.heartbeat(db, { id: c.id, worker: r.id, runId: c.run_id, leaseMin: given ? executorLease(leaseMin) : keep });
    return { id: c.id, lease_until: h.task?.lease_until ?? null };
  });
  return { executor: executorOut(getRow(db, r.id)), renewed };
}

module.exports = {
  migrate, register, byToken, isExecutor, listExecutors, heartbeat, touch, executorLease, executorOut,
  statusOf, setStatus, STATUS_LIMITS,
  acquire, release, listLocks, sweepOverdue, RESOURCE_RE, LOCK_MAX_MIN, REASON_MAX,
  appendJournal, journal, ARTIFACT_CHECK, JOURNAL_BODY_MAX, RESERVED_IDS,
  stop, sweepStale, listHandoffs, getHandoff, ackHandoff, HANDOFF_LIST_BUDGET,
  EXECUTOR_ID_RE, EXECUTOR_KINDS, EXECUTOR_MAX_LEASE_MIN, isUnsafeChar, hasUnsafeText,
};
