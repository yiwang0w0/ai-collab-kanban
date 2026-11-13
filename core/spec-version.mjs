// 说明的版本确认(合同 H6)。卡的 subject / description / acceptance / required_checks 在放行之后每改一次,spec_version +1,
// 留 spec_history:[{version, hash, at, by}]。放行之前的修改不计:第一次看到这张卡处于已放行时记 v1(基线)。
// 领卡时记下当时的版本;heartbeat / report 可带 seen_spec_version,板记 acked_spec_version;
// 交付时 seen < 当前(或没带、且领取后改过)→ 这一轮 based_on_stale_spec:true,卡的历史里记一条。
//
// 改动从哪条路来都认:server 在每个 task.* 事件与读卡时调 observe(),按内容哈希判「改过没有」,不依赖每条编辑路记得调用。
//   代价:两次观察之间的多次修改合成一次 +1(by 写观察到它的那一方)。操作员的编辑接口自己先调一次,by 写 operator。
// 自动通过的判定不在这里(H3/H4 的闸读任务对象上的 based_on_stale_spec)。
import { createHash } from "node:crypto";

const asList = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) { try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; } }
  return [];
};
/** 说明的内容哈希:标题、说明、验收、必需检查(缺失 = 空;名字去重排序,顺序不算修改)。 */
export function specHash(t) {
  const checks = [...new Set(asList(t?.required_checks).map((x) => String(x)))].sort();
  return createHash("sha256").update(JSON.stringify(["spec:v1", String(t?.subject ?? ""), String(t?.description ?? ""),
    String(t?.acceptance ?? ""), checks])).digest("hex");
}

/** seen_spec_version:不给 / null = 没带;否则要正整数。 */
export function checkSeen(v, badInput) {
  if (v === undefined || v === null) return null;
  if (!Number.isSafeInteger(v) || v < 1) throw badInput("seen_spec_version 要正整数(get_card / claim_card 应答里的 spec_version)");
  return v;
}

// requiredOf(id):必需检查不在 tasks 表上(可信核心自己的表),由 server 接上;任务对象自己带了就用自己的。
export function openSpecVersion({ db, store, clock = () => new Date().toISOString(), appendEvent = null, requiredOf = () => [] }) {
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS spec_versions (
      task_id INTEGER NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL,
      PRIMARY KEY (task_id, version))`);
    // 每一轮(run)一行:领卡时的版本、对方确认到的版本、交付时的判定。
    db.exec(`CREATE TABLE IF NOT EXISTS spec_runs (
      task_id INTEGER NOT NULL, run_id TEXT NOT NULL, claimed_version INTEGER NOT NULL, acked_version INTEGER,
      reported_version INTEGER, reported_seen INTEGER, stale INTEGER, reported_at TEXT,
      PRIMARY KEY (task_id, run_id))`);
  }
  const memo = new Map(), q = (sql) => { let st = memo.get(sql); if (!st) memo.set(sql, st = db.prepare(sql)); return st; };
  const lastStmt = () => q("SELECT version, hash, at, by FROM spec_versions WHERE task_id=? ORDER BY version DESC LIMIT 1");
  const histStmt = () => q("SELECT version, hash, at, by FROM spec_versions WHERE task_id=? ORDER BY version");
  const putStmt = () => q("INSERT OR IGNORE INTO spec_versions (task_id, version, hash, at, by) VALUES (?,?,?,?,?)");
  const runStmt = () => q("SELECT * FROM spec_runs WHERE task_id=? AND run_id=?");
  const event = (taskId, kind, actor, detail) => { try { appendEvent?.(db, { taskId, kind, actor, detail }); } catch {} };

  /** 核对一次:已放行且没有基线 → 记 v1;有基线且内容变了 → +1(并记历史一条)。返回当前 {version, hash}。 */
  function observe(tOrId, by = "system") {
    const t = typeof tOrId === "object" && tOrId ? tOrId : store.get(db, Number(tOrId));
    if (!t) return null;
    const id = Number(t.id), last = lastStmt().get(id);
    let rq = t.required_checks; if (rq == null) { try { rq = requiredOf(id); } catch { rq = []; } }
    const hash = specHash({ ...t, required_checks: rq });
    if (!last) {
      if (!Number(t.released)) return { version: 1, hash };       // 放行前:不记版本,修改不计
      putStmt().run(id, 1, hash, clock(), "release");
      return { version: 1, hash };
    }
    if (last.hash === hash) return { version: Number(last.version), hash };
    const version = Number(last.version) + 1;
    putStmt().run(id, version, hash, clock(), String(by || "system"));
    event(id, "spec.changed", by || "system", { version, from: Number(last.version) });
    return { version, hash };
  }
  const versionOf = (t) => observe(t).version;

  /** 任务对象上的字段。 */
  function fields(t) {
    if (!t) return {};
    const cur = observe(t);
    const history = histStmt().all(Number(t.id)).map((r) => ({ version: Number(r.version), hash: r.hash, at: r.at, by: r.by }));
    const run = t.run_id ? runStmt().get(Number(t.id), String(t.run_id)) : null;
    return {
      spec_version: cur.version,
      spec_history: history,
      acked_spec_version: run ? Math.max(Number(run.claimed_version), Number(run.acked_version ?? 0)) : null,
      based_on_stale_spec: !!(run && Number(run.stale) === 1),
    };
  }
  /** 这张卡当前这一轮的交付是否基于旧版说明(给自动通过的闸用)。 */
  const staleOf = (id) => { const t = store.get(db, Number(id)); return !!t && fields(t).based_on_stale_spec; };

  /** 领卡成功后:记下这一轮领到时的版本。 */
  function onClaim(t) {
    if (!t?.run_id) return null;
    const v = versionOf(t);
    q("INSERT OR IGNORE INTO spec_runs (task_id, run_id, claimed_version) VALUES (?,?,?)").run(Number(t.id), String(t.run_id), v);
    return v;
  }
  function runRow(t, runId) {
    let r = runStmt().get(Number(t.id), String(runId));
    if (!r) {   // 升级前领的卡、或别的路领的:以第一次见到时的版本当领取版本
      q("INSERT OR IGNORE INTO spec_runs (task_id, run_id, claimed_version) VALUES (?,?,?)").run(Number(t.id), String(runId), versionOf(t));
      r = runStmt().get(Number(t.id), String(runId));
    }
    return r;
  }
  /** seen 不能超过当前版本(版本只增不减,超过的只能是乱值)。 */
  function assertSeen(t, seen, badInput) {
    if (seen !== null && seen > versionOf(t)) throw badInput(`seen_spec_version ${seen} 比卡上的版本 ${versionOf(t)} 还新,没有这个版本`);
  }
  /** 心跳(持有者核对已过):记确认到的版本;落后时给 spec_changed。 */
  function onHeartbeat(t, runId, seen) {
    if (!t || !runId) return {};
    const current = versionOf(t), r = runRow(t, runId);
    if (seen !== null && seen > Number(r.acked_version ?? 0))
      q("UPDATE spec_runs SET acked_version=? WHERE task_id=? AND run_id=?").run(seen, Number(t.id), String(runId));
    const yours = seen ?? Math.max(Number(r.claimed_version), Number(r.acked_version ?? 0));
    return { spec_version: current, ...(yours < current ? { spec_changed: { current, yours } } : {}) };
  }
  /** 交付前算判定(t = 交付前的卡);交付落盘后再 record()。 */
  function judgeReport(t, runId, seen) {
    if (!t || !runId) return null;
    const current = versionOf(t), r = runRow(t, runId);
    const base = seen ?? Math.max(Number(r.claimed_version), Number(r.acked_version ?? 0));
    return { task_id: Number(t.id), run_id: String(runId), current, seen, base, stale: base < current };
  }
  function record(j, actor) {
    if (!j) return;
    q("UPDATE spec_runs SET reported_version=?, reported_seen=?, stale=?, reported_at=?, acked_version=MAX(COALESCE(acked_version,0), ?) WHERE task_id=? AND run_id=?")
      .run(j.current, j.seen, j.stale ? 1 : 0, clock(), j.seen ?? 0, j.task_id, j.run_id);
    if (j.stale) event(j.task_id, "spec.stale_delivery", actor, { run_id: j.run_id, current: j.current, seen: j.seen, base: j.base });
  }
  return { migrate, observe, fields, staleOf, onClaim, onHeartbeat, judgeReport, record, assertSeen, specHash };
}
