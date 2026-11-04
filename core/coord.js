// 多执行者协作:执行者身份与令牌、心跳、各方状态。
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
  EXECUTOR_ID_RE, EXECUTOR_KINDS, EXECUTOR_MAX_LEASE_MIN,
};
