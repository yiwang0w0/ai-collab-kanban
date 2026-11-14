// 合同 J6 / J7(第 9 波 9e):批准额度、豁免、敏感标签、批量验收的记录。表都在 board.db,全部只追加(触发器拒改拒删)。
// 板只记数、指路、排队并明示:
//   · 批准额度 = 人批的一个带上限的许可。板只记「批了多少、执行者报用了多少」,算出剩余与状态;
//     不据此放行或拦任何动作,不判断「这次算不算在额度内」——用不用、停不停在执行者那一侧。
//   · 豁免只是一条记录:不让任何闸变绿。带未撤销豁免的卡不自动通过(server 经 cred.registerGate 登记)、不进批量。
//   · 敏感标签只由操作者(或经操作者确认的计划项)写;带标签的卡不进批量。
//   · 批量验收的资格是许可型门:任何一项读不到 / 判不出 = 不进(bulkCheck)。
import { createHash, randomBytes } from "node:crypto";

export const QUOTA_USES_MAX = 100, QUOTA_TTL_MAX = 10080, QUOTA_USD_MAX = 10000;
// 没写次数上限的额度,看板也只记这么多次用量(到了就算用完):只追加表不能无限长。
export const USE_ROWS_MAX = 100;
export const SENSITIVE = Object.freeze(["security", "waiver", "spend", "prod_write", "secret", "destructive", "other"]);
export const GRANT_STATES = Object.freeze(["active", "exhausted", "expired", "revoked"]);
const RULE_MAX = 64, NOTE_MAX = 200, VALUE_MAX = 2000, REVOKE_NOTE_MAX = 200;
const RUN_RE = /^[A-Za-z0-9_.:-]{1,80}$/, HASH_RE = /^[0-9a-fA-F]{64}$/;
const WAIVER_TTL_MAX_MS = 366 * 86400e3;
// 批量资格:徽标档位只认这三档(self_reported 与认不出的档位都不进);这些标记任一出现就不进。
const TRUSTED_LEVELS = new Set(["machine_verified", "cross_model_reviewed", "independent_rerun"]);
const BAD_FLAGS = ["stale", "fingerprint_mismatch", "fingerprint_missing", "based_on_stale_spec", "based_on_stale_ref", "spec_deviation", "not_target_env"];

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const iso = (ms) => new Date(Number(ms)).toISOString();
const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const chars = (s) => [...String(s)].length;
const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const pad = (n) => String(n).padStart(2, "0");
/** 给人看的时刻:本机时区的「年-月-日 时:分」。 */
export const whenText = (at) => { const d = new Date(Date.parse(at)); return Number.isFinite(d.getTime())
  ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : String(at ?? "?"); };

function appendOnly(db, t, key = "id") {
  // REPLACE 在冲突时删旧行却不触发 DELETE 触发器:主键已存在的插入也在这里拒绝(同 approvals.js)。
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_replace BEFORE INSERT ON ${t} WHEN EXISTS (SELECT 1 FROM ${t} WHERE ${key} = NEW.${key})
           BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
}

/** 额度(请求的 quota 与决定的 grant 同一形):{uses?(1–100 整数), usd?(>0,≤10000), ttl_minutes?(1–10080 整数)},至少一项。
 *  null / undefined = 不带额度(一次性)。返回 {uses, usd, ttl_minutes},没写的项为 null。 */
export function normQuota(raw, bad, what = "quota") {
  if (raw === undefined || raw === null) return null;
  if (!isPlain(raw)) throw bad(`${what} 要是对象 {uses?, usd?, ttl_minutes?}`);
  for (const k of Object.keys(raw)) if (!["uses", "usd", "ttl_minutes"].includes(k)) throw bad(`${what} 不认识的键 ${k}`);
  const out = { uses: null, usd: null, ttl_minutes: null };
  if (raw.uses != null) {
    if (!Number.isSafeInteger(raw.uses) || raw.uses < 1 || raw.uses > QUOTA_USES_MAX) throw bad(`${what}.uses 要 1–${QUOTA_USES_MAX} 的整数`);
    out.uses = raw.uses;
  }
  if (raw.usd != null) {
    if (typeof raw.usd !== "number" || !Number.isFinite(raw.usd) || raw.usd <= 0 || raw.usd > QUOTA_USD_MAX) throw bad(`${what}.usd 要大于 0、不超过 ${QUOTA_USD_MAX} 的数字`);
    out.usd = round6(raw.usd);
  }
  if (raw.ttl_minutes != null) {
    if (!Number.isSafeInteger(raw.ttl_minutes) || raw.ttl_minutes < 1 || raw.ttl_minutes > QUOTA_TTL_MAX) throw bad(`${what}.ttl_minutes 要 1–${QUOTA_TTL_MAX} 的整数`);
    out.ttl_minutes = raw.ttl_minutes;
  }
  if (out.uses == null && out.usd == null && out.ttl_minutes == null) throw bad(`${what} 至少写 uses / usd / ttl_minutes 中的一项`);
  return out;
}
/** 决定时的 grant:只能改小、不能改大(请求写了的那一项,grant 不能比它大);请求没写的项 grant 可以加上(= 更严)。
 *  grant 不给 = 照请求批。proposed 为 null(请求没带额度 = 一次性)时 grant 不能凭空给额度。 */
export function finalGrant(rawGrant, proposed, bad) {
  if (rawGrant === undefined || rawGrant === null) return proposed ? { ...proposed } : null;
  if (!proposed) throw bad("这个请求没带额度(一次性),决定时不能凭空给额度:grant 只能把请求里的额度改小");
  const g = normQuota(rawGrant, bad, "grant");
  for (const k of ["uses", "usd", "ttl_minutes"])
    if (g[k] != null && proposed[k] != null && g[k] > proposed[k]) throw bad(`grant.${k}=${g[k]} 大于请求的 ${proposed[k]}:批准时只能改小,不能改大`);
  return { uses: g.uses ?? proposed.uses, usd: g.usd ?? proposed.usd, ttl_minutes: g.ttl_minutes ?? proposed.ttl_minutes };
}
/** use 正文:{run_id(1–80 位字母数字与 _ . : -), usd?(0–10000)}。 */
export function normUse(body, bad) {
  if (!isPlain(body)) throw bad("正文要是 {run_id, usd?}");
  for (const k of Object.keys(body)) if (!["run_id", "usd"].includes(k)) throw bad(`不认识的字段 ${k}`);
  if (typeof body.run_id !== "string" || !RUN_RE.test(body.run_id)) throw bad("run_id 必填:1–80 位字母、数字与 _ . : -(这一次用在哪一轮,自报)");
  let usd = null;
  if (body.usd !== undefined && body.usd !== null) {
    if (typeof body.usd !== "number" || !Number.isFinite(body.usd) || body.usd < 0 || body.usd > QUOTA_USD_MAX) throw bad(`usd 要 0–${QUOTA_USD_MAX} 的数字`);
    usd = round6(body.usd);
  }
  return { run_id: body.run_id, usd };
}
/** 敏感标签:数组,每项在 SENSITIVE 里;未知值 → 400。去重、按固定顺序。空数组 = 清掉。 */
export function normSensitive(v, bad) {
  if (!Array.isArray(v) || v.length > SENSITIVE.length * 2) throw bad(`sensitive 要数组,取值只有 ${SENSITIVE.join(" / ")}`);
  for (const x of v) if (typeof x !== "string" || !SENSITIVE.includes(x)) throw bad(`未知的敏感标签 ${JSON.stringify(x).slice(0, 40)}:只有 ${SENSITIVE.join(" / ")}`);
  return SENSITIVE.filter((s) => v.includes(s));
}

/**
 * @param db    node:sqlite 句柄
 * @param err / ERR  store.err / store.ERR
 * @param clean (s) => 去控制字符 + 过 redactText 的一行(server 传 connect.cleanText)
 */
export function openApprovalQuota({ db, err, ERR, clean = (s) => String(s ?? ""), now = () => Date.now() }) {
  const bad = (m) => err(ERR.BAD_INPUT, m);
  const conflict = (m, extra = {}) => Object.assign(err(ERR.CONFLICT, m), extra);
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS approval_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('proposed','granted','revoked')),
      uses INTEGER, usd REAL, ttl_minutes INTEGER, expires_at TEXT,
      by_role TEXT NOT NULL, by_id TEXT, via TEXT, note TEXT NOT NULL DEFAULT '', at TEXT NOT NULL)`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS approval_grants_one ON approval_grants(request_id, kind)");
    appendOnly(db, "approval_grants");
    db.exec(`CREATE TABLE IF NOT EXISTS grant_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, executor TEXT NOT NULL, run_id TEXT NOT NULL, usd REAL, at TEXT NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS grant_uses_req ON grant_uses(request_id, id)");
    appendOnly(db, "grant_uses");
    db.exec(`CREATE TABLE IF NOT EXISTS waivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rule TEXT NOT NULL, value_hash TEXT, scope_card INTEGER, scope_line TEXT,
      note TEXT NOT NULL DEFAULT '', granted_by TEXT NOT NULL, via TEXT NOT NULL, at TEXT NOT NULL, expires_at TEXT,
      CHECK ((scope_card IS NULL) <> (scope_line IS NULL)))`);
    appendOnly(db, "waivers");
    db.exec(`CREATE TABLE IF NOT EXISTS waiver_revocations (
      waiver_id INTEGER PRIMARY KEY, by_ TEXT NOT NULL, via TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', at TEXT NOT NULL)`);
    appendOnly(db, "waiver_revocations", "waiver_id");
    db.exec(`CREATE TABLE IF NOT EXISTS card_sensitive (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, tags_json TEXT NOT NULL, by_ TEXT NOT NULL, at TEXT NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS card_sensitive_task ON card_sensitive(task_id, id)");
    appendOnly(db, "card_sensitive");
    db.exec(`CREATE TABLE IF NOT EXISTS bulk_runs (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, by_ TEXT NOT NULL, items_json TEXT NOT NULL, result_json TEXT NOT NULL)`);
    appendOnly(db, "bulk_runs");
  }

  // ── 批准额度 ────────────────────────────────────────────────────────────────
  const q = {};
  const prep = (k, sql) => (q[k] ??= db.prepare(sql));
  const rowsOf = (rid) => prep("rows", "SELECT * FROM approval_grants WHERE request_id=? ORDER BY id").all(Number(rid));
  const quotaOf = (r) => r ? { uses: r.uses == null ? null : Number(r.uses), usd: r.usd == null ? null : Number(r.usd), ttl_minutes: r.ttl_minutes == null ? null : Number(r.ttl_minutes) } : null;
  const insGrant = (rid, kind, qv, { byRole, byId = null, via = null, note = "", expiresAt = null }, ms) =>
    prep("ins", `INSERT INTO approval_grants(request_id, kind, uses, usd, ttl_minutes, expires_at, by_role, by_id, via, note, at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(Number(rid), kind, qv?.uses ?? null, qv?.usd ?? null, qv?.ttl_minutes ?? null, expiresAt, byRole, byId, via, note, iso(ms));
  /** 执行者发起请求时写下提议的额度(与请求同一事务,由 server 包)。 */
  const propose = (rid, quota, executor, ms = now()) => { if (quota) insGrant(rid, "proposed", quota, { byRole: "executor", byId: String(executor) }, ms); };
  const proposedOf = (rid) => quotaOf(rowsOf(rid).find((r) => r.kind === "proposed"));
  /** 人批准时写下最终额度;到期时刻 = 决定时刻 + ttl_minutes(没写 = 不到期)。返回写下的那一份。 */
  function recordGrant(rid, final, { by = "operator", via = null } = {}, ms = now()) {
    if (!final) return null;
    const expiresAt = final.ttl_minutes != null ? iso(ms + final.ttl_minutes * 60000) : null;
    insGrant(rid, "granted", final, { byRole: "operator", byId: by, via, expiresAt }, ms);
    return { ...final, expires_at: expiresAt };
  }
  const expiresFor = (final, ms) => final?.ttl_minutes != null ? iso(ms + final.ttl_minutes * 60000) : null;
  /** 一个请求的额度现况。没有提议也没有批下的额度 → null(一次性请求照旧)。state 只在批下之后有。 */
  function grantView(rid, ms = now()) {
    const rows = rowsOf(rid);
    const p = rows.find((r) => r.kind === "proposed"), g = rows.find((r) => r.kind === "granted"), rv = rows.find((r) => r.kind === "revoked");
    if (!p && !g) return null;
    const out = { request_id: Number(rid), approval_id: `request:${Number(rid)}:1`, proposed: quotaOf(p), granted: null, state: null, used: null, remaining: null, revoked_at: null };
    if (!g) return out;
    const uses = prep("uses", "SELECT COUNT(*) n, COALESCE(SUM(usd),0) usd, MAX(at) last FROM grant_uses WHERE request_id=?").get(Number(rid));
    const n = Number(uses.n), spent = round6(uses.usd);
    const cap = quotaOf(g);
    const expired = g.expires_at != null && Date.parse(g.expires_at) <= ms;
    const exhausted = (cap.uses != null && n >= cap.uses) || (cap.usd != null && spent >= cap.usd - 1e-9) || n >= USE_ROWS_MAX;
    out.granted = { ...cap, expires_at: g.expires_at ?? null, at: g.at, by: g.by_id ?? "operator", via: g.via ?? null };
    out.state = rv ? "revoked" : expired ? "expired" : exhausted ? "exhausted" : "active";
    out.used = { uses: n, usd: spent, last_at: uses.last ?? null };
    out.remaining = { uses: cap.uses == null ? null : Math.max(0, cap.uses - n), usd: cap.usd == null ? null : round6(Math.max(0, cap.usd - spent)), expires_at: g.expires_at ?? null };
    out.revoked_at = rv?.at ?? null;
    return out;
  }
  /** 执行者报一次用量。只在 active 时收;收下后可能就此 exhausted。板只计数,不判断这次该不该用。 */
  function use(rid, executor, u, ms = now()) {
    const own = !db.isTransaction;
    if (own) db.exec("BEGIN IMMEDIATE");
    try {
      const v = grantView(rid, ms);
      if (!v?.granted) throw conflict(`request:${rid}:1 没有批下的额度(还没决定、被拒绝,或是一次性批准):看板不收用量`, { grantCode: "NOT_GRANTED", grant: v });
      if (v.state !== "active") throw conflict(`request:${rid}:1 的额度已${{ exhausted: "用完", expired: "到期", revoked: "撤销" }[v.state]}(${v.state}):看板不再收用量`, { grantCode: v.state.toUpperCase(), grant: v });
      if (v.granted.usd != null && u.usd == null) throw bad("这份额度有金额上限:每次报用量要带 usd(自报的花费;没花钱写 0)");
      prep("use", "INSERT INTO grant_uses(request_id, executor, run_id, usd, at) VALUES(?,?,?,?,?)").run(Number(rid), String(executor), u.run_id, u.usd, iso(ms));
      if (own) db.exec("COMMIT");
    } catch (e) { if (own) { try { db.exec("ROLLBACK"); } catch {} } throw e; }
    return grantView(rid, ms);
  }
  /** 撤销 = 操作者追加一行(revoked)。已撤销的不能再撤。 */
  function revoke(rid, { by = "operator", via = null, note = "" } = {}, ms = now()) {
    const v = grantView(rid, ms);
    if (!v?.granted) throw err(ERR.NOT_FOUND, `request:${rid}:1 没有批下的额度,无可撤销`);
    if (v.state === "revoked") throw conflict(`request:${rid}:1 的额度已于 ${v.revoked_at} 撤销`, { grantCode: "REVOKED", grant: v });
    if (typeof note !== "string" || chars(note) > REVOKE_NOTE_MAX) throw bad(`note 最多 ${REVOKE_NOTE_MAX} 字`);
    insGrant(rid, "revoked", null, { byRole: "operator", byId: by, via, note: clean(note) }, ms);
    return grantView(rid, ms);
  }
  /** 批下过额度的请求(新的在前)。只给操作者的接口用。 */
  function listGrants(ms = now(), { limit = 100 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    return prep("list", "SELECT request_id FROM approval_grants WHERE kind='granted' ORDER BY id DESC LIMIT ?").all(lim).map((r) => grantView(r.request_id, ms));
  }
  const countActiveGrants = (ms = now()) => prep("allg", "SELECT request_id FROM approval_grants WHERE kind='granted'").all()
    .filter((r) => grantView(r.request_id, ms)?.state === "active").length;

  // ── 豁免 ────────────────────────────────────────────────────────────────────
  /** 豁免正文:{rule(≤64), value?(原值,只存哈希)| value_hash?(64 位十六进制), scope:{card} | {line}, note?(≤200), expires_at?(ISO,一年内)}。 */
  function normWaiver(b, { cardOk = () => true, lineOk = () => true } = {}, ms = now()) {
    if (!isPlain(b)) throw bad("正文要是 {rule, value? | value_hash?, scope:{card} | {line}, note?, expires_at?}");
    for (const k of Object.keys(b)) if (!["rule", "value", "value_hash", "scope", "note", "expires_at"].includes(k)) throw bad(`不认识的字段 ${k}`);
    if (typeof b.rule !== "string" || !b.rule.trim() || chars(b.rule.trim()) > RULE_MAX) throw bad(`rule 必填:被豁免的规则名,一行,≤${RULE_MAX} 字`);
    const rule = clean(b.rule).slice(0, RULE_MAX * 2);
    if (!rule) throw bad("rule 过滤后为空");
    if (b.value !== undefined && b.value_hash !== undefined) throw bad("value 与 value_hash 只给一个(看板只存哈希)");
    let valueHash = null;
    if (b.value !== undefined && b.value !== null) {
      if (typeof b.value !== "string" || !b.value || chars(b.value) > VALUE_MAX) throw bad(`value 要 1–${VALUE_MAX} 字的字符串(看板只存它的 sha256,不存原值)`);
      valueHash = sha256(b.value);
    } else if (b.value_hash !== undefined && b.value_hash !== null) {
      if (typeof b.value_hash !== "string" || !HASH_RE.test(b.value_hash)) throw bad("value_hash 要 64 位十六进制(sha256)");
      valueHash = b.value_hash.toLowerCase();
    }
    const s = b.scope;
    if (!isPlain(s) || Object.keys(s).length !== 1 || !["card", "line"].includes(Object.keys(s)[0])) throw bad("scope 要 {card: 卡号} 或 {line: 线名},只给一项");
    let card = null, line = null;
    if (s.card !== undefined) { if (!Number.isSafeInteger(s.card) || s.card < 1) throw bad("scope.card 要卡号"); if (!cardOk(s.card)) throw err(ERR.NOT_FOUND, `卡 #${s.card} 不存在或已归档`); card = s.card; }
    else { if (typeof s.line !== "string" || !lineOk(s.line)) throw bad(`scope.line 不是看板上的线:${JSON.stringify(s.line).slice(0, 40)}`); line = s.line; }
    if (b.note !== undefined && b.note !== null && (typeof b.note !== "string" || chars(b.note) > NOTE_MAX)) throw bad(`note 最多 ${NOTE_MAX} 字`);
    const note = b.note ? [...clean(b.note)].slice(0, NOTE_MAX).join("") : "";
    let expiresAt = null;
    if (b.expires_at !== undefined && b.expires_at !== null) {
      const t = typeof b.expires_at === "string" ? Date.parse(b.expires_at) : NaN;
      if (!Number.isFinite(t) || t <= ms || t > ms + WAIVER_TTL_MAX_MS) throw bad("expires_at 要 ISO 时刻,晚于现在、一年以内(不写 = 不到期)");
      expiresAt = iso(t);
    }
    return { rule, value_hash: valueHash, card, line, note, expires_at: expiresAt };
  }
  function waiverOut(r) {
    if (!r) return null;
    const rv = prep("wrv", "SELECT * FROM waiver_revocations WHERE waiver_id=?").get(Number(r.id));
    return { id: Number(r.id), rule: r.rule, value_hash: r.value_hash ?? null, scope: r.scope_card != null ? { card: Number(r.scope_card) } : { line: r.scope_line },
             note: r.note, granted_by: r.granted_by, via: r.via, at: r.at, expires_at: r.expires_at ?? null,
             revoked_at: rv?.at ?? null, ...(rv ? { revoked_by: rv.by_, revoke_note: rv.note } : {}) };
  }
  const waiverRow = (id) => prep("w1", "SELECT * FROM waivers WHERE id=?").get(Number(id));
  function addWaiver(w, { by = "operator", via = "local" } = {}, ms = now()) {
    const r = prep("wins", "INSERT INTO waivers(rule, value_hash, scope_card, scope_line, note, granted_by, via, at, expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(w.rule, w.value_hash, w.card, w.line, w.note, String(by), String(via), iso(ms), w.expires_at);
    return waiverOut(waiverRow(r.lastInsertRowid));
  }
  function revokeWaiver(id, { by = "operator", via = "local", note = "" } = {}, ms = now()) {
    const r = waiverRow(id);
    if (!r) throw err(ERR.NOT_FOUND, `豁免 #${id} 不存在`);
    if (typeof note !== "string" || chars(note) > REVOKE_NOTE_MAX) throw bad(`note 最多 ${REVOKE_NOTE_MAX} 字`);
    const prior = prep("wrv", "SELECT * FROM waiver_revocations WHERE waiver_id=?").get(Number(id));
    if (prior) throw conflict(`豁免 #${id} 已于 ${prior.at} 撤销`);
    prep("wrvins", "INSERT INTO waiver_revocations(waiver_id, by_, via, note, at) VALUES(?,?,?,?,?)").run(Number(id), String(by), String(via), clean(note), iso(ms));
    return waiverOut(waiverRow(id));
  }
  /** 豁免列表(新的在前)。card / line 只取覆盖它的;active=true 只取未撤销且未到期的。 */
  function listWaivers({ card = null, line = null, active = false, limit = 200 } = {}, ms = now()) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 200));
    let rows = prep("wall", "SELECT * FROM waivers ORDER BY id DESC LIMIT 2000").all();
    if (card != null) rows = rows.filter((r) => Number(r.scope_card) === Number(card) || (line != null && r.scope_line === line));
    else if (line != null) rows = rows.filter((r) => r.scope_line === line);
    let out = rows.map(waiverOut);
    if (active) out = out.filter((w) => !w.revoked_at && !(w.expires_at && Date.parse(w.expires_at) <= ms));
    return out.slice(0, lim);
  }
  /** 盖住这张卡的未撤销豁免(到期了也算:豁免下做过的活不因到期就当没豁免过 —— 拒绝侧)。 */
  function waiversFor(t) {
    if (!t || t.id == null) return [];
    const rows = prep("wfor", `SELECT w.* FROM waivers w LEFT JOIN waiver_revocations v ON v.waiver_id = w.id
                               WHERE v.waiver_id IS NULL AND (w.scope_card = ? OR (w.scope_line IS NOT NULL AND w.scope_line = ?)) ORDER BY w.id`)
      .all(Number(t.id), t.line == null ? null : String(t.line));
    return rows.map((r) => ({ id: Number(r.id), rule: r.rule, at: r.at, expires_at: r.expires_at ?? null, granted_by: r.granted_by }));
  }
  /** 卡对象的 waivers 项(合同 J6):[{id, rule, at, expires_at}]。 */
  const cardWaivers = (t) => waiversFor(t).map(({ id, rule, at, expires_at }) => ({ id, rule, at, expires_at }));
  /** 自动通过闸(经 cred.registerGate 登记):有豁免 = 不自动通过,缺口写「已豁免:规则 X(谁、何时)」。 */
  const waiverGaps = (t) => waiversFor(t).map((w) => `已豁免:规则 ${w.rule}(${w.granted_by === "operator" ? "操作者" : w.granted_by}、${whenText(w.at)})`);
  const countActiveWaivers = (ms = now()) => listWaivers({ active: true, limit: 500 }, ms).length;

  // ── 敏感标签 ────────────────────────────────────────────────────────────────
  function setSensitive(taskId, tags, by = "operator", ms = now()) {
    prep("sins", "INSERT INTO card_sensitive(task_id, tags_json, by_, at) VALUES(?,?,?,?)").run(Number(taskId), JSON.stringify(tags), String(by), iso(ms));
    return storedSensitive(taskId);
  }
  function storedSensitive(taskId) {
    const r = prep("s1", "SELECT tags_json FROM card_sensitive WHERE task_id=? ORDER BY id DESC LIMIT 1").get(Number(taskId));
    if (!r) return [];
    let v = []; try { v = JSON.parse(r.tags_json); } catch { v = ["other"]; }   // 读坏了 = 当作有标签(拒绝侧)
    return Array.isArray(v) ? SENSITIVE.filter((s) => v.includes(s)) : ["other"];
  }
  /** 卡对象的 sensitive:写下的标签 ∪(有未撤销豁免 → waiver)。 */
  function sensitiveOf(t) {
    const s = storedSensitive(t.id);
    if (!s.includes("waiver") && waiversFor(t).length) return SENSITIVE.filter((x) => x === "waiver" || s.includes(x));
    return s;
  }

  // ── 批量验收 ────────────────────────────────────────────────────────────────
  const newBulkId = () => "bk_" + randomBytes(6).toString("hex");
  function recordBulk(id, by, items, result, ms = now()) {
    prep("bins", "INSERT INTO bulk_runs(id, at, by_, items_json, result_json) VALUES(?,?,?,?,?)").run(String(id), iso(ms), String(by), JSON.stringify(items), JSON.stringify(result));
  }
  const listBulk = (limit = 20) => prep("bl", "SELECT * FROM bulk_runs ORDER BY at DESC, rowid DESC LIMIT ?").all(Math.max(1, Math.min(200, Number(limit) || 20)))
    .map((r) => { let items = [], result = {}; try { items = JSON.parse(r.items_json); result = JSON.parse(r.result_json); } catch {} return { id: r.id, at: r.at, by: r.by_, items, result }; });

  return { migrate, propose, proposedOf, recordGrant, expiresFor, grantView, use, revoke, listGrants, countActiveGrants,
           normWaiver, addWaiver, revokeWaiver, listWaivers, waiversFor, cardWaivers, waiverGaps, countActiveWaivers,
           setSensitive, storedSensitive, sensitiveOf, newBulkId, recordBulk, listBulk };
}

/**
 * 批量验收的资格(合同 J7):全部满足才进;任何一项读不到 / 判不出(抛错、缺字段、认不出的值)= 不进,原因写「判不出:…」。
 * ctx:{ lines() → bulk_lines 数组;entry() → 这张卡当前的批准事项(taskApprovalEntry)或 null;decided(id) → 决定记录或 null;
 *       out() → 任务对象(taskOut);gate(o) → {ok, missing}(所有登记的自动通过闸);reviewLines → 审阅线名数组;
 *       deliverer() → 交付者(最近一次领卡的身份)或 null }
 * 返回 {ok, why:[进的依据], excluded:[不进的原因], item?:{approval_id, expected_version}, o}。
 */
export function bulkCheck(t, ctx) {
  const why = [], excluded = [];
  const step = (label, fn) => { try { const r = fn(); if (r) excluded.push(r); } catch { excluded.push(`判不出:${label}`); } };
  let entry = null, o = null;
  step("是否待本人验收", () => {
    if (!t || t.archived_at || t.status !== "waiting" || t.waiting_for !== "review") return "不是待本人验收的卡(裁定、放行、亲手做、故障一律不进)";
    if (Number(t.human_gate)) return "带人工闸(要本人裁定)";
    entry = ctx.entry();
    if (!entry || entry.item?.kind !== "delivery" || !entry.item.id) return "批准列表里没有这张卡的验收项";
    if (ctx.decided(entry.item.id)) return "这一项已经决定过";
    why.push("待本人验收");
  });
  step("线", () => {
    const lines = ctx.lines();
    if (!Array.isArray(lines)) throw new Error("bulk_lines");
    if (!t?.line || !lines.includes(t.line)) return `线「${t?.line ?? "未指定"}」没开批量验收`;
    why.push(`线 ${t.line} 开了批量验收`);
  });
  step("任务对象", () => { o = ctx.out(); if (!o || typeof o !== "object") throw new Error("taskOut"); });
  if (!o) return { ok: false, why, excluded, o: null };
  step("自动通过闸", () => {
    const g = ctx.gate(o);
    if (!g || typeof g.ok !== "boolean" || !Array.isArray(g.missing)) throw new Error("gate");
    if (!g.ok) return `自动通过的闸没全过:${g.missing.join(";").slice(0, 240)}`;
    why.push("登记的自动通过闸全过");
  });
  step("可信度徽标", () => {
    const b = o.badge;
    if (!b || typeof b.level !== "string" || !Array.isArray(b.flags) || !Array.isArray(b.provenance)) return "读不到可信度徽标";
    if (b.level === "self_reported") return "徽标只凭自报";
    if (!TRUSTED_LEVELS.has(b.level)) return `判不出:徽标档位 ${b.level}`;
    why.push(`徽标 ${b.level}`);
  });
  step("标记", () => {
    const flags = Array.isArray(o.badge?.flags) ? o.badge.flags : null;
    if (!flags || !Array.isArray(o.package_gaps)) throw new Error("flags");
    const hit = BAD_FLAGS.filter((f) => flags.includes(f));
    if (o.based_on_stale_spec === true && !hit.includes("based_on_stale_spec")) hit.push("based_on_stale_spec");
    if (o.based_on_stale_ref === true && !hit.includes("based_on_stale_ref")) hit.push("based_on_stale_ref");
    if (o.package_gaps.length) hit.push("package_gaps");
    if (hit.length) return `带标记:${hit.join(" / ")}`;
  });
  step("敏感标签", () => {
    if (!Array.isArray(o.sensitive)) throw new Error("sensitive");
    if (o.sensitive.length) return `带敏感标签:${o.sensitive.join(" / ")}`;
  });
  step("豁免", () => {
    if (!Array.isArray(o.waivers)) throw new Error("waivers");
    if (o.waivers.length) return `带豁免 ${o.waivers.length} 条`;
  });
  // 自批排除:结论与推荐必须出自交付者以外的一方或确定性规则。看板能分清的三种自批 + 交付者判不出。
  step("自批", () => {
    const who = ctx.deliverer();
    if (!who) return "判不出交付者";
    if ((ctx.reviewLines || []).includes(t.line)) return "自批:交付出自审阅线,审阅结论也出自审阅座席";
    const grounds = Array.isArray(o.badge?.provenance) ? o.badge.provenance.slice(1) : null;
    if (!grounds) throw new Error("provenance");
    if (grounds.some((p) => p?.by === "executor")) return "自批:徽标的依据出自交付者自报";
    if (Array.isArray(o.conclusions) && o.conclusions.some((c) => !c.stale && (c.by === "executor" || c.by === who))) return "自批:结论出自交付者本人";
    why.push("结论与依据不出自交付者");
  });
  const ok = excluded.length === 0;
  return { ok, why, excluded, o, ...(entry ? { item: { approval_id: entry.item.id, expected_version: entry.item.expected_version } } : {}) };
}
/** 一项的指纹:审后任何一样变了(事项版本、交付指纹、徽标、标记、敏感标签、豁免、线、闸)都换值。 */
export function bulkDigest(t, o, item, gateOk) {
  return sha256(JSON.stringify({ a: item.approval_id, v: String(item.expected_version), fp: o.fingerprint?.digest ?? null,
    lv: o.badge?.level ?? null, fl: [...(o.badge?.flags ?? [])].sort(), s: o.sensitive ?? null, w: (o.waivers ?? []).map((w) => w.id),
    l: t.line ?? null, g: gateOk === true, sv: o.spec_version ?? null }));
}
/** 整张清单的指纹:按 approval_id 排序后的「事项 id | 版本 | 指纹」。POST 交回的 items 算出来必须等于 GET 给的 list_digest。 */
export function bulkListDigest(items) {
  return sha256([...items].map((i) => `${i.approval_id}|${String(i.expected_version)}|${i.digest}`).sort().join("\n"));
}
