// 公告板 v3 合同 I10c「卡死检测」。计数只取结构化事件(task_events),不解析回报文本;从上次清零算起的连续次数:
//   reaped        租约过期被回收(事件 reap)
//   handed_back   被审阅座席或本人退回(事件 resolve,disposition = hand_back;联动关闭不算)
//   failed        非 done 的交付(事件 report,outcome = wait;ask_operator 也是)
//   same_reason   连续带同一 reason_code 的交回 / 等待(report_result / ask_operator 的可选 reason_code,按这一轮 run_id 记)
// 断开:清零(事件 stuck.cleared,操作者经 POST /api/tasks/:id/stuck/clear;审计只追加 = task_events 本身)、说明版本变了(事件 spec.changed)、
//   卡被验收通过(resolve 结案)。一次 done 交付断开 reaped / failed / same_reason;handed_back 只在验收通过时断开
//   (退回总跟在一次 done 交付后面,按 done 交付断开它就永远到不了阈值)。
// 阈值 = 板设置 stuck_after(默认 3,2–10,0 = 关;只有操作者能改,存在首页设置里)。到阈值:卡挂 stuck、未开始时领卡闸 STUCK
//   (排队领跳过、按号领 409)、事件 task.stuck(同一段连续只记一次)。板不强收执行中的卡,也不自动续跑同一张。
export const REASON_RE = /^[a-z0-9_]{1,32}$/;
export const STUCK_DEFAULT = 3, STUCK_MIN = 2, STUCK_MAX = 10;
const KINDS = ["reaped", "handed_back", "failed", "same_reason"];
export const KIND_TEXT = { reaped: "被回收", handed_back: "被退回", failed: "交回没做完", same_reason: "以同一原因停下" };

/** reason_code:不给 / null = 没带;否则要 [a-z0-9_]{1,32}。 */
export function checkReason(v, badInput) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !REASON_RE.test(v)) throw badInput("reason_code 只接受 1–32 位小写字母、数字与下划线");
  return v;
}
/** stuck_after:0 = 关;否则 2–10 的整数。 */
export function checkStuckAfter(v) {
  return Number.isSafeInteger(v) && (v === 0 || (v >= STUCK_MIN && v <= STUCK_MAX));
}

/** threshold() => 当前 stuck_after。 */
export function openStuck({ db, store, threshold = () => STUCK_DEFAULT, emit = () => {}, log = () => {}, clean = (s) => String(s ?? ""), now = () => new Date().toISOString() }) {
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS stuck_reasons (task_id INTEGER NOT NULL, run_id TEXT NOT NULL, reason_code TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (task_id, run_id))`);
    // 「现在是不是卡死」的上一次观察:不卡死 → 卡死 的那一下记一次 task.stuck(同一段卡死只记一次,清零或断开后再卡死另记)。
    db.exec(`CREATE TABLE IF NOT EXISTS stuck_state (task_id INTEGER PRIMARY KEY, active INTEGER NOT NULL, kind TEXT, count INTEGER, at TEXT NOT NULL)`);
  }
  /** 交回 / 等待时带的 reason_code(这一轮一次;交付前由 server 校验)。 */
  function recordReason(taskId, runId, code) {
    if (!code || !runId) return;
    db.prepare("INSERT OR REPLACE INTO stuck_reasons(task_id, run_id, reason_code, at) VALUES(?,?,?,?)").run(Number(taskId), String(runId), code, now());
  }
  const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

  /** 从事件推出 stuck:{kind, count, since, last:[…]≤5, since_event} | null。 */
  function compute(t) {
    const n = threshold();
    if (!t || !n || t.archived_at || t.status === "done") return null;
    const evs = db.prepare(`SELECT id, at, kind, actor, detail FROM task_events WHERE task_id=? AND kind IN ('reap','report','resolve','stuck.cleared','spec.changed') ORDER BY id`).all(Number(t.id));
    const reasons = new Map(db.prepare("SELECT run_id, reason_code FROM stuck_reasons WHERE task_id=?").all(Number(t.id)).map((r) => [r.run_id, r.reason_code]));
    const fresh = () => ({ count: 0, first: null });
    let c = Object.fromEntries(KINDS.map((k) => [k, fresh()])), lastReason = null, trail = [];
    const bump = (k, e, reason = null, track = true) => { if (!c[k].count) c[k].first = e; c[k].count++; if (track) trail.push({ at: e.at, kind: k, actor: e.actor ?? null, reason_code: reason }); };
    const reset = (ks) => { for (const k of ks) c[k] = fresh(); if (ks.includes("same_reason")) lastReason = null;
                            if (ks.length === KINDS.length) trail = []; else trail = trail.filter((x) => !ks.includes(x.kind)); };
    for (const e of evs) {
      const d = parse(e.detail);
      if (e.kind === "stuck.cleared" || e.kind === "spec.changed") reset(KINDS);
      else if (e.kind === "reap") bump("reaped", e);
      else if (e.kind === "report") {
        if (d.outcome === "done") reset(["reaped", "failed", "same_reason"]);
        else {
          const reason = d.run_id ? reasons.get(String(d.run_id)) ?? null : null;
          bump("failed", e, reason);
          if (reason && reason === lastReason) bump("same_reason", e, reason, false);
          else if (reason) { c.same_reason = fresh(); bump("same_reason", e, reason, false); lastReason = reason; }
          else { c.same_reason = fresh(); lastReason = null; }
        }
      } else if (e.kind === "resolve") {
        if (e.actor === "cascade") continue;
        const disp = d.disposition || (d.status === "done" ? "close" : d.status === "not_started" ? "hand_back" : "hold");
        if (disp === "close") reset(KINDS);
        else if (disp === "hand_back") bump("handed_back", e);
      }
    }
    const hit = KINDS.filter((k) => c[k].count >= n).sort((a, b) => c[b].count - c[a].count || KINDS.indexOf(a) - KINDS.indexOf(b))[0];
    if (!hit) return null;
    return { kind: hit, count: c[hit].count, since: c[hit].first.at, last: trail.slice(-5), since_event: Number(c[hit].first.id) };
  }
  /** 任务对象的 stuck(不带内部的 since_event)。 */
  function fieldOf(t) { const s = compute(t); if (!s) return null; const { since_event, ...pub } = s; return pub; }
  const sentence = (s) => `连着${KIND_TEXT[s.kind]} ${s.count} 次`;

  /** 领卡闸(登记口):未开始的卡到阈值 → STUCK(要本人裁定)。 */
  function claimCheck(t) {
    if (!t || t.status !== "not_started") return null;
    const s = compute(t);
    if (!s) return null;
    const { since_event, ...pub } = s;
    return { code: "STUCK", attention: "decide", detail: pub, message: sentence(s),
             why: `#${t.id} ${sentence(s)}(自 ${s.since} 起)—— 看过原因后清零再领,或改说明 / 拆卡`,
             next_action: "看过原因后清零继续,或改说明 / 拆卡" };
  }
  /** 清零:追加一条 stuck.cleared(审计只追加)。 */
  function clear(id, { note = null, by = "operator" } = {}) {
    const t = store.get(db, Number(id));
    if (!t) throw store.err(store.ERR.NOT_FOUND, `卡 #${id} 不存在`);
    const before = fieldOf(t);
    store.appendEvent(db, { taskId: Number(id), kind: "stuck.cleared", actor: by, detail: { ...(note ? { note: clean(note, 200) } : {}), was: before ? { kind: before.kind, count: before.count } : null } });
    return { cleared: true, was: before };
  }
  /** 不卡死 → 卡死 的那一下记一次 task.stuck;卡死 → 不卡死 只改观察记录。 */
  async function sweep() {
    const rows = db.prepare(`SELECT t.* FROM tasks t WHERE (t.archived_at IS NULL AND t.status<>'done')
      OR EXISTS (SELECT 1 FROM stuck_state s WHERE s.task_id=t.id AND s.active=1)`).all();
    for (const t of rows) {
      const s = compute(t), was = Number(db.prepare("SELECT active FROM stuck_state WHERE task_id=?").get(Number(t.id))?.active ?? 0) === 1;
      if (!s) { if (was) db.prepare("UPDATE stuck_state SET active=0, at=? WHERE task_id=?").run(now(), Number(t.id)); continue; }
      if (was) continue;
      db.prepare("INSERT INTO stuck_state(task_id, active, kind, count, at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET active=1, kind=excluded.kind, count=excluded.count, at=excluded.at")
        .run(Number(t.id), 1, s.kind, s.count, now());
      store.appendEvent(db, { taskId: Number(t.id), kind: "task.stuck", actor: "system", detail: { kind: s.kind, count: s.count, since: s.since } });
      emit("task.stuck", { id: Number(t.id), kind: s.kind, count: s.count });
      log(`#${t.id} ${sentence(s)}:卡死了,等本人裁定`);
    }
  }
  return { migrate, recordReason, compute, fieldOf, claimCheck, clear, sweep, sentence };
}
