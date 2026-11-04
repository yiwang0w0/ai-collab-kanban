// 多执行者协作:执行者身份与令牌、心跳、各方状态、资源锁、事件流水。
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
const JOURNAL_BODY_MAX = 300;
const JOURNAL_KIND_RE = /^[a-z][a-z0-9_.-]{0,31}$/;
const ARTIFACT_MAX = 20;
const ARTIFACT_CHECK = Object.freeze({
  sha256: (v) => /^[0-9a-f]{64}$/.test(v),
  commit: (v) => /^[0-9a-f]{7,40}$/.test(v),
  path: (v) => v.length > 0 && v.length <= 260 && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v),
  url: (v) => { try { const u = new URL(v); return ["http:", "https:"].includes(u.protocol) && v.length <= 500 && !u.username && !u.password; }
               catch { return false; } },
});
// 看板自己写流水时用的执行者名;不允许登记成执行者 id。
const RESERVED_IDS = ["operator", "system"];

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
  const list = (name, max) => {
    const v = body[name] == null ? [] : body[name];
    if (!Array.isArray(v)) throw err(ERR.BAD_INPUT, `${name} 必须是字符串数组`);
    if (v.length > max) over(`${name} 项数`, max, v.length);
    v.forEach((x, i) => {
      if (typeof x !== "string" || !x.trim()) throw err(ERR.BAD_INPUT, `${name}[${i}] 必须是非空字符串`);
      if (chars(x) > L.item) over(`${name}[${i}] 字数`, L.item, chars(x));
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

/** 操作员登记执行者。返回明文令牌(只此一次)。rotate=true 时为已登记的执行者换发令牌,旧令牌立即失效。 */
function register(db, { id, name, kind = "external", rotate = false } = {}, now = Date.now()) {
  const eid = String(id ?? "").trim();
  if (!EXECUTOR_ID_RE.test(eid))
    throw err(ERR.BAD_INPUT, `执行者 id 只允许小写字母、数字、- 或 _,1-32 位,以字母或数字开头 —— 收到 ${JSON.stringify(id)}`);
  if (RESERVED_IDS.includes(eid)) throw err(ERR.BAD_INPUT, `执行者 id 不能用保留名 ${RESERVED_IDS.join(" / ")}`);
  const nm = String(name ?? "").trim() || eid;
  if (chars(nm) > NAME_MAX) throw err(ERR.BAD_INPUT, `显示名最多 ${NAME_MAX} 字`);
  if (!EXECUTOR_KINDS.includes(kind)) throw err(ERR.BAD_INPUT, `kind 只接受 ${EXECUTOR_KINDS.join(" / ")} —— 收到 ${JSON.stringify(kind)}`);
  const token = "exe_" + crypto.randomBytes(24).toString("hex");
  const at = iso(now);
  const have = getRow(db, eid);
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
    const type = a?.type, check = Object.hasOwn(ARTIFACT_CHECK, String(type)) ? ARTIFACT_CHECK[type] : null;
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
    ? db.prepare("SELECT id, run_id FROM tasks WHERE status='in_progress' AND worker=? ORDER BY id").all(r.id)
    : db.prepare("SELECT id, run_id FROM tasks WHERE status='in_progress' AND worker=? AND id=?").all(r.id, Number(taskId));
  if (taskId != null && !cards.length)
    throw err(ERR.CONFLICT, `卡 #${taskId} 不是 ${r.id} 正在进行的卡,未续租`);
  const renewed = cards.map((c) => {
    const h = store.heartbeat(db, { id: c.id, worker: r.id, runId: c.run_id, leaseMin: executorLease(leaseMin) });
    return { id: c.id, lease_until: h.task?.lease_until ?? null };
  });
  return { executor: executorOut(getRow(db, r.id)), renewed };
}

module.exports = {
  migrate, register, byToken, listExecutors, heartbeat, touch, executorLease, executorOut,
  statusOf, setStatus, STATUS_LIMITS,
  acquire, release, listLocks, sweepOverdue, RESOURCE_RE, LOCK_MAX_MIN,
  appendJournal, journal, ARTIFACT_CHECK, JOURNAL_BODY_MAX, RESERVED_IDS,
  EXECUTOR_ID_RE, EXECUTOR_KINDS, EXECUTOR_MAX_LEASE_MIN,
};
