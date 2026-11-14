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

// 合同 J1.3:计数增量算。stuck_state 另记「算到的最后事件 id(last_event_id)+ 各计数(calc,JSON)」;fieldOf / claimCheck / sweep
//   从那里接着读这张卡之后的新事件,不再每次从头读。task_events 只追加、id 递增(store.js),所以接着读与从头读结果相同;
//   reason_code 是另一张表(可后写、可覆盖),写它时这张卡的增量作废、下次从头算。computeFull = 从头全量重算(对拍用)。
const SCAN_KINDS = "('reap','report','resolve','stuck.cleared','spec.changed')";
const TRAIL_KEEP = 5;
const freshCalc = () => ({ last: 0, c: Object.fromEntries(KINDS.map((k) => [k, { count: 0, first: null }])), lastReason: null, trail: [] });
/** 一条事件折进计数(与从头算逐条同一套规则)。first 只留 {id, at}。 */
function fold(st, e, reasons, parse) {
  const fresh = () => ({ count: 0, first: null });
  const c = st.c;
  const bump = (k, reason = null, track = true) => { if (!c[k].count) c[k].first = { id: Number(e.id), at: e.at }; c[k].count++;
    if (track) st.trail.push({ at: e.at, kind: k, actor: e.actor ?? null, reason_code: reason }); };
  const reset = (ks) => { for (const k of ks) c[k] = fresh(); if (ks.includes("same_reason")) st.lastReason = null;
    if (ks.length === KINDS.length) st.trail = []; else st.trail = st.trail.filter((x) => !ks.includes(x.kind)); };
  const d = parse(e.detail);
  if (e.kind === "stuck.cleared" || e.kind === "spec.changed") reset(KINDS);
  else if (e.kind === "reap") bump("reaped");
  else if (e.kind === "report") {
    if (d.outcome === "done") reset(["reaped", "failed", "same_reason"]);
    else {
      const reason = d.run_id ? reasons().get(String(d.run_id)) ?? null : null;
      bump("failed", reason);
      if (reason && reason === st.lastReason) bump("same_reason", reason, false);
      else if (reason) { c.same_reason = fresh(); bump("same_reason", reason, false); st.lastReason = reason; }
      else { c.same_reason = fresh(); st.lastReason = null; }
    }
  } else if (e.kind === "resolve") {
    if (e.actor !== "cascade") {
      const disp = d.disposition || (d.status === "done" ? "close" : d.status === "not_started" ? "hand_back" : "hold");
      if (disp === "close") reset(KINDS);
      else if (disp === "hand_back") bump("handed_back");
    }
  }
  // trail 只用到末 5 条;清的时候整类清,所以每类留末 5 条就够(从头算与增量算的末 5 条相同)。
  if (st.trail.length > TRAIL_KEEP * KINDS.length * 2) {
    const keep = new Set(), per = new Map();
    for (let i = st.trail.length - 1; i >= 0; i--) { const k = st.trail[i].kind, n = per.get(k) || 0; if (n < TRAIL_KEEP) { keep.add(i); per.set(k, n + 1); } }
    st.trail = st.trail.filter((_, i) => keep.has(i));
  }
  st.last = Number(e.id);
}
/** 计数 → 对外的 stuck(到阈值才有)。 */
function verdict(st, n) {
  const c = st.c;
  const hit = KINDS.filter((k) => c[k].count >= n).sort((a, b) => c[b].count - c[a].count || KINDS.indexOf(a) - KINDS.indexOf(b))[0];
  if (!hit) return null;
  return { kind: hit, count: c[hit].count, since: c[hit].first.at, last: st.trail.slice(-5).map((x) => ({ ...x })), since_event: Number(c[hit].first.id) };
}

/** threshold() => 当前 stuck_after。 */
export function openStuck({ db, store, threshold = () => STUCK_DEFAULT, emit = () => {}, log = () => {}, clean = (s) => String(s ?? ""), now = () => new Date().toISOString() }) {
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS stuck_reasons (task_id INTEGER NOT NULL, run_id TEXT NOT NULL, reason_code TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (task_id, run_id))`);
    // 「现在是不是卡死」的上一次观察:不卡死 → 卡死 的那一下记一次 task.stuck(同一段卡死只记一次,清零或断开后再卡死另记)。
    db.exec(`CREATE TABLE IF NOT EXISTS stuck_state (task_id INTEGER PRIMARY KEY, active INTEGER NOT NULL, kind TEXT, count INTEGER, at TEXT NOT NULL)`);
    // 合同 J1.3:增量计数(旧库补列;NULL = 没算过,下次从头算)。按 (task_id, id) 取一张卡某个 id 之后的事件。
    const cols = new Set(db.prepare("PRAGMA table_info(stuck_state)").all().map((c) => c.name));
    if (!cols.has("last_event_id")) db.exec("ALTER TABLE stuck_state ADD COLUMN last_event_id INTEGER");
    if (!cols.has("calc")) db.exec("ALTER TABLE stuck_state ADD COLUMN calc TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS ix_task_events_task_id ON task_events(task_id, id)");
  }
  /** 交回 / 等待时带的 reason_code(这一轮一次;交付前由 server 校验)。 */
  function recordReason(taskId, runId, code) {
    if (!code || !runId) return;
    db.prepare("INSERT OR REPLACE INTO stuck_reasons(task_id, run_id, reason_code, at) VALUES(?,?,?,?)").run(Number(taskId), String(runId), code, now());
    invalidate(taskId);   // 原因可能落在已折进计数的交回上:这张卡下次从头算
  }
  const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

  // 增量:内存里一份(进程内),stuck_state.calc 一份(sweep 时写;重启后从它接着算)。在事务里读到的事件可能回滚,不记进内存。
  const mem = new Map();
  function invalidate(taskId) {
    mem.delete(Number(taskId));
    try { db.prepare("UPDATE stuck_state SET last_event_id=NULL, calc=NULL WHERE task_id=?").run(Number(taskId)); } catch {}
  }
  const loadCalc = (id) => {
    const m = mem.get(id); if (m) return m;
    const r = db.prepare("SELECT last_event_id, calc FROM stuck_state WHERE task_id=?").get(id);
    if (r && r.calc != null && r.last_event_id != null) {
      try { const st = JSON.parse(r.calc); if (st && st.c && Array.isArray(st.trail) && Number(st.last) === Number(r.last_event_id)) return st; } catch {}
    }
    return null;
  };
  /** 这张卡的计数(接着上次算到的地方读新事件)。 */
  function calcOf(id) {
    id = Number(id);
    const base = loadCalc(id);
    const evs = db.prepare(`SELECT id, at, kind, actor, detail FROM task_events WHERE task_id=? AND id>? AND kind IN ${SCAN_KINDS} ORDER BY id`).all(id, base ? base.last : 0);
    if (base && !evs.length) { if (!db.isTransaction && !mem.has(id)) mem.set(id, base); return base; }
    const st = base ? structuredClone(base) : freshCalc();
    let rs = null;
    const reasons = () => (rs ??= new Map(db.prepare("SELECT run_id, reason_code FROM stuck_reasons WHERE task_id=?").all(id).map((r) => [r.run_id, r.reason_code])));
    for (const e of evs) fold(st, e, reasons, parse);
    if (!db.isTransaction) mem.set(id, st);
    return st;
  }
  /** 从事件推出 stuck:{kind, count, since, last:[…]≤5, since_event} | null(增量)。 */
  function compute(t) {
    const n = threshold();
    if (!t || !n || t.archived_at || t.status === "done") return null;
    return verdict(calcOf(t.id), n);
  }
  /** 从头全量重算(不读也不写增量;测试对拍用)。 */
  function computeFull(t) {
    const n = threshold();
    if (!t || !n || t.archived_at || t.status === "done") return null;
    const st = freshCalc(), id = Number(t.id);
    const evs = db.prepare(`SELECT id, at, kind, actor, detail FROM task_events WHERE task_id=? AND kind IN ${SCAN_KINDS} ORDER BY id`).all(id);
    const rs = new Map(db.prepare("SELECT run_id, reason_code FROM stuck_reasons WHERE task_id=?").all(id).map((r) => [r.run_id, r.reason_code]));
    for (const e of evs) fold(st, e, () => rs, parse);
    return verdict(st, n);
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
  /** 不卡死 → 卡死 的那一下记一次 task.stuck;卡死 → 不卡死 只改观察记录。scope = null:全部未完成卡(定时兜底);
   *  {ids:Set} = 只看这一拍动过的卡(合同 J1.2)。顺手把算到的计数落进 stuck_state(重启后接着算)。 */
  async function sweep(scope = null) {
    const rows = scope
      ? db.prepare("SELECT * FROM tasks WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...scope.ids].map(Number)))
      : db.prepare(`SELECT t.* FROM tasks t WHERE (t.archived_at IS NULL AND t.status<>'done')
      OR EXISTS (SELECT 1 FROM stuck_state s WHERE s.task_id=t.id AND s.active=1)`).all();
    const stateOf = db.prepare("SELECT active, last_event_id FROM stuck_state WHERE task_id=?");
    for (const t of rows) {
      const row = stateOf.get(Number(t.id)), was = Number(row?.active ?? 0) === 1;
      const s = compute(t);
      // 计数落盘:只在有新进展时写(compute 对已完成 / 归档的卡不算,这里也不为它们补算)。
      const st = mem.get(Number(t.id));
      if (st && Number(row?.last_event_id ?? -1) !== st.last && !db.isTransaction)
        db.prepare("INSERT INTO stuck_state(task_id, active, kind, count, at, last_event_id, calc) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET last_event_id=excluded.last_event_id, calc=excluded.calc")
          .run(Number(t.id), 0, null, null, now(), st.last, JSON.stringify(st));
      if (!s) { if (was) db.prepare("UPDATE stuck_state SET active=0, at=? WHERE task_id=?").run(now(), Number(t.id)); continue; }
      if (was) continue;
      db.prepare("INSERT INTO stuck_state(task_id, active, kind, count, at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET active=1, kind=excluded.kind, count=excluded.count, at=excluded.at")
        .run(Number(t.id), 1, s.kind, s.count, now());
      store.appendEvent(db, { taskId: Number(t.id), kind: "task.stuck", actor: "system", detail: { kind: s.kind, count: s.count, since: s.since } });
      emit("task.stuck", { id: Number(t.id), kind: s.kind, count: s.count });
      log(`#${t.id} ${sentence(s)}:卡死了,等本人裁定`);
    }
  }
  return { migrate, recordReason, compute, computeFull, fieldOf, claimCheck, clear, sweep, sentence, invalidate };
}
