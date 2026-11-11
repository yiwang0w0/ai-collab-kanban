// 公告板 v3 合同 C 节「效率」:GET /api/efficiency 的汇总(本期对上期、分解、逐日、一句主句)。
// 全部由已落库的数据算:tasks(created_at / resolved_at / work_spans / attempts / heartbeat_at)、
// task_events(只追加)、task_runs(运行时)、用量账本(core/usage.mjs)。只读,不写库。
// 口径的人话说明在 docs/效率口径.md;这里是判定表。
//
// ── 事件归类:复用 core/flow.mjs 的 entryOf(step 与 actor_kind 一套判定,不另写)──────────
//   claimed     → 首次领取(cycle 的起点)          reported → 交付(wait_human 的起点)
//   accepted    → 通过;actor_kind=auto 计进 auto_accept_rate 的分子,cascade(联动关闭)两边都不计
//   handed_back → 打回(handed_back、first_pass)   reopened → 重开(first_pass)
//   human_actions = actor_kind=human 且 kind ∈ resolve / release / reopen(裁定 / 放行与收回 / 重开)
// ── 卡的归属 ───────────────────────────────────────────────────────────────────
//   done 只数「非目标卡」:kind='goal' 不计;下面挂着子卡的父卡也不计(它的工作已经算在子卡里)。
//   当前 status 必须是 done:重开后 resolved_at 仍留着旧值,不能单看它。
//   其余量(打回、操作、AI 时长)按事件 / 时段本身落在哪一期算,目标卡上的也算。
// ── 未知 ───────────────────────────────────────────────────────────────────────
//   每个为 null 的字段都列进 unknown,不当 0。区间里有「派发过(attempts>0)却没有 work_spans」的旧卡
//   → ai_work_ms / parallel_* 为 null;账本在区间里没有行或有一行缺耗时 / 费用 → model_ms / cost_usd 为 null;
//   过去的区间不知道当时谁的心跳超时 → stalled 为 null(只有区间末尾在现在之后才数)。
//   不设「人工要多久」的基线:看板里没有这类数据,编一个就是造数。
import { entryOf } from "./flow.mjs";
import { parseTime } from "./usage.mjs";

export const BY = ["day", "week", "line", "runtime"];
const METRIC_KEYS = ["done", "lead_ms_median", "cycle_ms_median", "handed_back", "stalled", "ai_work_ms", "model_ms",
  "wait_human_ms_total", "wait_human_ms_median", "human_actions", "first_pass_rate", "auto_accept_rate",
  "parallel_avg", "parallel_peak", "cost_usd"];
const HUMAN_ACTION_KINDS = new Set(["resolve", "release", "reopen"]);
const DAY = 86400000;
const MAX_SPAN_MS = 400 * DAY;

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};
const ratio = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
const ms = (s) => { const v = Date.parse(s ?? ""); return Number.isFinite(v) ? v : null; };

/** 本地时区的日零点 / 周一零点(本地日历计算,夏令时下也按日历日)。 */
export function dayStart(t) { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
export function addDays(t, n) { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); }
export function weekStart(t) { const d = new Date(dayStart(t)); return addDays(d.getTime(), -((d.getDay() + 6) % 7)); }
const pad = (n) => String(n).padStart(2, "0");
export function localDate(t) { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function localStamp(t) {
  const d = new Date(t), off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", a = Math.abs(off);
  return `${localDate(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** from / to(查询串)→ 本期与上期的毫秒区间,左闭右开。只给日期时 to 含当天整天。
 *  缺省 = 本周(周一零点起 7 个日历日)对上周。读不懂抛 BAD_INPUT。 */
export function periodOf(fromRaw, toRaw, now) {
  const bad = (m) => Object.assign(new Error(m), { code: "BAD_INPUT" });
  const has = (v) => v != null && v !== "";
  if (!has(fromRaw) && !has(toRaw)) {
    const a = weekStart(now), b = addDays(a, 7);
    return { from: a, to: b, prevFrom: addDays(a, -7), prevTo: a, label: "本周", prevLabel: "上周" };
  }
  if (!has(fromRaw) || !has(toRaw)) throw bad("from 与 to 要一起给(都不给 = 本周对上周)");
  const from = parseTime(fromRaw);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(toRaw).trim());
  const to = dateOnly ? parseTime(toRaw, true) + 1 : parseTime(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw bad("from / to 要写成 2026-11-10 或 2026-11-10T08:30:00 这样的时刻");
  if (to <= from) throw bad("to 必须晚于 from");
  if (to - from > MAX_SPAN_MS) throw bad("区间最长 400 天");
  return { from, to, prevFrom: from - (to - from), prevTo: from, label: "本期", prevLabel: "上期" };
}

/** 区间 [a,b) 与时段列表求交 → { total, union, peak }。时段已裁到区间内。 */
export function overlap(spans) {
  let total = 0, union = 0, peak = 0, depth = 0, open = 0;
  const pts = [];
  for (const [s, e] of spans) { if (e <= s) continue; total += e - s; pts.push([s, 1], [e, -1]); }
  pts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);   // 同一时刻先结束后开始:首尾相接不算同时
  for (const [t, d] of pts) {
    if (depth === 0 && d > 0) open = t;
    depth += d;
    if (depth > peak) peak = depth;
    if (depth === 0 && d < 0) union += t - open;
  }
  return { total, union, peak };
}

export function createEfficiency({ db, ledger = null, lines = () => [], labels = () => ({}), isExecutor = () => false,
                                   staleMs = () => 20 * 60000, clock = Date.now, cacheSize = 32, openTtlMs = 30000 } = {}) {
  const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

  // ── 事件增量缓存:每张卡只留归类后的轻量条目 { at, kind, step, ak, cascade }。与 flow 相同的做法:
  //    只扫 id 大于上次的新事件;max(id) 变小(库被换掉)→ 整个重建。
  const evs = new Map();
  let seen = 0;
  const scan = db.prepare("SELECT id, at, task_id, kind, actor, detail FROM task_events WHERE id>? ORDER BY id LIMIT 5000");
  const maxIdStmt = db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM task_events");
  const RELEVANT = new Set(["claim", "report", "resolve", "reopen", "release"]);
  function refresh() {
    const top = Number(maxIdStmt.get().m);
    if (top < seen) { evs.clear(); seen = 0; }
    if (top === seen) return top;
    const ctx = { lines: lines() || [], labels: {}, isExecutor: (a) => isExecutor(db, a) };
    for (;;) {
      const rows = scan.all(seen);
      if (!rows.length) break;
      for (const r of rows) {
        seen = Number(r.id);
        if (!RELEVANT.has(r.kind)) continue;
        const at = ms(r.at);
        if (at === null) continue;
        const en = entryOf({ at: r.at, kind: r.kind, actor: r.actor, detail: parse(r.detail) }, ctx);
        if (!en) continue;
        const id = Number(r.task_id);
        if (!evs.has(id)) evs.set(id, []);
        evs.get(id).push({ at, kind: r.kind, step: en.step, ak: en.actor_kind, cascade: r.actor === "cascade" });
      }
      if (rows.length < 5000) break;
    }
    return top;
  }

  const tasksStmt = db.prepare("SELECT id, kind, parent_id, line, status, created_at, resolved_at, work_spans, attempts, heartbeat_at, last_runtime FROM tasks");
  const parentsStmt = db.prepare("SELECT DISTINCT parent_id AS p FROM tasks WHERE parent_id IS NOT NULL");
  const runtimeStmt = db.prepare("SELECT task_id, runtime FROM task_runs ORDER BY started_at, rowid");
  const sigStmt = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),'') AS u FROM tasks");

  function loadTasks(now) {
    const parents = new Set(parentsStmt.all().map((r) => Number(r.p)));
    const rt = new Map();
    for (const r of runtimeStmt.all()) if (r.runtime) rt.set(Number(r.task_id), String(r.runtime));
    return tasksStmt.all().map((t) => {
      let raw = []; try { raw = JSON.parse(t.work_spans || "[]"); } catch {}
      const spans = [];
      let spanUnknown = false;
      if (Array.isArray(raw)) raw.forEach((sp, i) => {
        const s = ms(sp?.s);
        if (s === null) { spanUnknown = true; return; }
        let e = ms(sp?.e);
        // 没有结束时刻:只有最后一段、卡仍在执行中才是「还在干」,算到现在;其余是断掉的旧记录,不猜。
        if (e === null) { if (i === raw.length - 1 && t.status === "in_progress") e = now; else { spanUnknown = true; return; } }
        spans.push([s, e]);
      });
      const id = Number(t.id);
      return { id, goal: t.kind === "goal", parent: parents.has(id), line: t.line ?? null, status: t.status,
               created: ms(t.created_at), resolved: ms(t.resolved_at), spans, spanUnknown, attempts: Number(t.attempts) || 0,
               heartbeat: t.heartbeat_at == null ? null : Number(t.heartbeat_at),
               runtime: rt.get(id) || t.last_runtime || null };
    });
  }

  /** 账本在 [a,b) 的合计 → { model_ms, cost_usd }(null = 未知)。cards 给出时只算这些卡的行。 */
  function ledgerSum(a, b, cards = null) {
    if (!ledger) return { model_ms: null, cost_usd: null };
    if (!cards) { const t = ledger.group("phase", { from: a, to: b - 1 }).total; return { model_ms: t.duration_ms, cost_usd: t.cost_usd }; }
    const g = ledger.group("card", { from: a, to: b - 1 }).groups.filter((x) => x.key !== "?" && cards.has(Number(x.key)));
    if (!g.length) return { model_ms: null, cost_usd: null };
    const sum = (k) => g.some((x) => x[k] == null) ? null : g.reduce((n, x) => n + x[k], 0);
    const c = sum("cost_usd");
    return { model_ms: sum("duration_ms"), cost_usd: c == null ? null : Math.round(c * 1e6) / 1e6 };
  }

  /** 一组卡在 [a,b) 的 Metrics。 */
  function metrics(tasks, a, b, now, { cards = null } = {}) {
    const inR = (t) => t !== null && t >= a && t < b;
    const done = tasks.filter((t) => !t.goal && !t.parent && t.status === "done" && inR(t.resolved));
    const lead = [], cycle = [], wait = [];
    let firstPass = 0, handedBack = 0, humanActions = 0, accepted = 0, autoAccepted = 0, spansUnknown = false;
    const clipped = [], end = Math.min(b, now);
    for (const t of done) {
      const ev = evs.get(t.id) || [];
      if (t.created !== null) lead.push(t.resolved - t.created);
      const claim = ev.find((e) => e.step === "claimed");
      if (claim && claim.at <= t.resolved) cycle.push(t.resolved - claim.at);
      if (!ev.some((e) => e.step === "handed_back" || e.step === "reopened")) firstPass++;
    }
    for (const t of tasks) {
      const ev = evs.get(t.id) || [];
      let lastReport = null, active = false;
      for (const e of ev) {
        const here = inR(e.at);
        if (here && e.step === "claimed") active = true;
        if (here && e.step === "handed_back") handedBack++;
        if (here && e.ak === "human" && HUMAN_ACTION_KINDS.has(e.kind)) humanActions++;
        if (here && e.step === "accepted" && !e.cascade) { accepted++; if (e.ak === "auto") autoAccepted++; }
        if (e.step === "reported") lastReport = e.at;
        else if (e.kind === "resolve") {
          if (e.ak === "human") { if (lastReport !== null && here) wait.push(e.at - lastReport); lastReport = null; }
          else if (e.step !== "other") lastReport = null;   // 自动通过 / 打回:没有等人;自动「交审阅」之后还在等人
        }
      }
      for (const [s, e] of t.spans) { const x = Math.max(s, a), y = Math.min(e, end); if (y > x) { clipped.push([x, y]); active = true; } }
      if (inR(t.resolved) && t.status === "done") active = true;
      if (active && t.attempts > 0 && (t.spanUnknown || !t.spans.length)) spansUnknown = true;
    }
    const ov = overlap(clipped);
    const led = ledgerSum(a, b, cards);
    const open = b > now;   // 区间末尾还没到:现在的心跳状态就是「区间末」的状态
    const stale = staleMs();
    const m = {
      done: done.length,
      lead_ms_median: median(lead),
      cycle_ms_median: median(cycle),
      handed_back: handedBack,
      stalled: open ? tasks.filter((t) => t.status === "in_progress" && (t.heartbeat === null || now - t.heartbeat > stale)).length : null,
      ai_work_ms: spansUnknown ? null : ov.total,
      model_ms: led.model_ms,
      wait_human_ms_total: wait.reduce((n, x) => n + x, 0),
      wait_human_ms_median: median(wait),
      human_actions: humanActions,
      first_pass_rate: ratio(firstPass, done.length),
      auto_accept_rate: ratio(autoAccepted, accepted),
      parallel_avg: spansUnknown || !ov.union ? null : Math.round((ov.total / ov.union) * 100) / 100,
      parallel_peak: spansUnknown ? null : ov.peak,
      cost_usd: led.cost_usd,
    };
    m.unknown = METRIC_KEYS.filter((k) => m[k] === null);
    return m;
  }

  function daily(tasks, a, b, now) {
    const out = [], stop = Math.min(b, Math.max(a, addDays(dayStart(now), 1)));
    for (let d = a; d < stop; d = addDays(d, 1)) {
      const e = Math.min(addDays(d, 1), b), inR = (t) => t !== null && t >= d && t < e;
      out.push({ date: localDate(d),
        created: tasks.filter((t) => !t.goal && inR(t.created)).length,
        done: tasks.filter((t) => !t.goal && !t.parent && t.status === "done" && inR(t.resolved)).length });
    }
    return out;
  }

  function groupsOf(by, tasks, a, b, now) {
    if (!by) return [];
    if (by === "day" || by === "week") {
      const out = [], stop = Math.min(b, Math.max(a + 1, now));
      for (let s = by === "day" ? dayStart(a) : weekStart(a); s < stop; s = addDays(s, by === "day" ? 1 : 7)) {
        const x = Math.max(s, a), y = Math.min(addDays(s, by === "day" ? 1 : 7), b);
        const key = localDate(s);
        out.push({ key, label: by === "day" ? key : `${key} 起一周`, ...metrics(tasks, x, y, now) });
      }
      return out;
    }
    const keyOf = by === "line" ? (t) => t.line ?? "" : (t) => t.runtime ?? "";
    const lab = labels() || {};
    const buckets = new Map();
    for (const t of tasks) { const k = keyOf(t); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(t); }
    const out = [];
    for (const [key, list] of buckets) {
      const m = metrics(list, a, b, now, { cards: new Set(list.map((t) => t.id)) });
      // 区间里什么都没发生的组不列(不做排名,也不列一长串 0)。
      if (!m.done && !m.handed_back && !m.human_actions && m.ai_work_ms === 0 && !m.stalled && m.model_ms == null && m.cost_usd == null) continue;
      const label = by === "line" ? (key ? (lab[key] || key) : "未指定线") : (key || "未知运行时");
      out.push({ key: key || null, label, ...m });
    }
    return out.sort((x, y) => String(x.key ?? "￿").localeCompare(String(y.key ?? "￿")));
  }

  function headline(label, m) {
    const parts = [`${label}完成 ${m.done} 张`, `打回 ${m.handed_back} 次`];
    if (m.ai_work_ms !== null) parts.push(`AI 干了 ${(m.ai_work_ms / 3600000).toFixed(1)} 小时`);
    parts.push(`你操作 ${m.human_actions} 次`);
    if (m.parallel_avg !== null) parts.push(`平均同时 ${m.parallel_avg.toFixed(1)} 条线在跑`);
    return parts.join(" · ");
  }

  // ── 结果缓存:键 = 事件最大 id + 卡表签名(条数、最晚 updated_at)+ 账本读到的位置 + 区间 + by;
  //    区间末尾在现在之后时再加一个 openTtlMs 的时间片(进行中的时段与心跳随时间变)。
  const cache = new Map();
  function compute({ from = null, to = null, by = null } = {}) {
    if (by != null && by !== "" && !BY.includes(by)) throw Object.assign(new Error(`by 只能是 ${BY.join(" | ")}`), { code: "BAD_INPUT" });
    const now = clock();
    const P = periodOf(from, to, now);
    ledger?.refresh?.();
    const top = refresh();
    const sig = sigStmt.get();
    const key = JSON.stringify([top, sig.n, sig.u, ledger?.stats?.().offset ?? null, P.from, P.to, by || null,
      P.to > now ? Math.floor(now / openTtlMs) : null]);
    if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
    const tasks = loadTasks(now);
    const nowM = metrics(tasks, P.from, P.to, now), prevM = metrics(tasks, P.prevFrom, P.prevTo, now);
    const out = {
      period: { from: localStamp(P.from), to: localStamp(P.to) },
      previous: { from: localStamp(P.prevFrom), to: localStamp(P.prevTo) },
      now: nowM, prev: prevM,
      groups: groupsOf(by || null, tasks, P.from, P.to, now),
      daily: daily(tasks, P.from, P.to, now),
      headline: headline(P.label, nowM),
    };
    cache.set(key, out);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    return out;
  }

  return { compute, refresh, metrics, cacheSize: () => cache.size };
}

/** GET /api/efficiency 的应答。role 来自 guardAuthentication:只给操作员(面板会话或操作员令牌)。 */
export function efficiencyHttp(eff, query, role) {
  if (role !== "operator") return { status: 403, body: { error: "效率汇总只给操作员(面板会话或操作员令牌)", role } };
  try {
    return { status: 200, body: eff.compute({ from: query.get("from"), to: query.get("to"), by: query.get("by") }) };
  } catch (e) {
    if (e?.code === "BAD_INPUT") return { status: 400, body: { error: e.message } };
    throw e;
  }
}
