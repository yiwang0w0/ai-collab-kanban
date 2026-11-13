// 首页「后台任务」(合同 F):GET /api/home/background 的组装、「停止」能不能按的判定、「建卡后自动开工」的逐线走闸。
// 本文件全是纯函数:库、时钟、进程表都由 server 注入(whoOf / sinceOf / stopOf / gateOf / start),这里不读不写。
// 「等你处理」不另写判定:server 把助手简报那一份(core/brief.mjs 的 briefModel,底下是首页 homeLists + 线故障)传进来原样放进 attention。
import { redactText, cut } from "./flow.mjs";

export const DONE_WINDOW_MS = 24 * 3600000;   // 「已完成」= 近 24 小时内完成的
export const DONE_MAX = 20, RUNNING_MAX = 100;
const TITLE_MAX = 80;
const clean = (s, max = TITLE_MAX) => cut(redactText(String(s ?? "")), max);

/** 往上找所属目标(最多 10 层):{ id, title } 或 null。目标卡自己不算属于自己。 */
export function goalOf(t, byId) {
  let cur = t, g = 0;
  while (cur && cur.parent_id != null && g++ < 10) {
    const up = byId.get(Number(cur.parent_id));
    if (!up) return null;
    if (up.kind === "goal") return { id: Number(up.id), title: clean(up.subject, 60) };
    cur = up;
  }
  return null;
}

/**
 * 应答体。tasks = 本板未归档的卡(taskOut 形:带 live_note / handed_back / children_done / children_total);
 * attention = briefModel(...).attention(已截到 20 条),attentionTotal = 截前条数;
 * whoOf(t) → { label, kind:"managed"|"external", runtime, model } | null;sinceOf(t) → 这一轮领取时刻 | null;
 * stopOf(t) → { stoppable, reason? }。now = 毫秒。
 */
export function backgroundModel({ tasks = [], attention = [], attentionTotal = null, now = 0,
                                  whoOf = () => null, sinceOf = () => null, stopOf = () => ({ stoppable: false }) } = {}) {
  const live = tasks.filter((t) => t && !t.archived_at);
  const byId = new Map(live.map((t) => [Number(t.id), t]));
  const work = live.filter((t) => t.kind !== "goal");
  const running = work.filter((t) => t.status === "in_progress").map((t) => {
    const s = stopOf(t) || {};
    return { task_id: Number(t.id), title: clean(t.subject), goal: goalOf(t, byId), who: whoOf(t) ?? null, since: sinceOf(t) ?? null,
             live_note: typeof t.live_note === "string" ? t.live_note : null, live_note_at: t.live_note_at ?? null,
             stoppable: s.stoppable === true, ...(s.reason ? { stop_note: String(s.reason) } : {}) };
  }).sort((a, b) => String(a.since || "~").localeCompare(String(b.since || "~")) || a.task_id - b.task_id);
  const done = work.filter((t) => {
    if (t.status !== "done") return false;
    const at = Date.parse(t.updated_at);
    return Number.isFinite(at) && at <= now && now - at <= DONE_WINDOW_MS;
  }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id).slice(0, DONE_MAX)
    .map((t) => ({ task_id: Number(t.id), title: clean(t.subject), goal: goalOf(t, byId), who: whoOf(t) ?? null,
                   done_at: t.updated_at, handed_back: Number(t.handed_back) || 0 }));
  // 组:出现在三组里任何一项所属的目标。total / done 用目标卡上与流转条同口径的 children_total / children_done(直属子卡);
  // running = 「运行中」里归到这个目标的张数。目标读不到(已归档等)就不出组,行上的 goal 照旧。
  const order = [], seen = new Set();
  const note = (g) => { if (g && !seen.has(g.id)) { seen.add(g.id); order.push(g.id); } };
  for (const a of attention) if (a?.task_id != null) { const t = byId.get(Number(a.task_id)); note(t?.kind === "goal" ? null : t && goalOf(t, byId)); }
  for (const r of running) note(r.goal);
  for (const d of done) note(d.goal);
  const groups = order.map((id) => byId.get(id)).filter(Boolean).map((g) => ({
    goal_id: Number(g.id), title: clean(g.subject, 60),
    total: Number.isInteger(g.children_total) ? g.children_total : null, done: Number.isInteger(g.children_done) ? g.children_done : null,
    running: running.filter((r) => r.goal?.id === Number(g.id)).length }));
  return { attention, attention_total: attentionTotal ?? attention.length,
           running: running.slice(0, RUNNING_MAX), running_total: running.length, done, groups,
           generated_at: Number.isFinite(now) ? new Date(now).toISOString() : null };
}

/**
 * 「停止」能不能按。只有受管线(看板自己起的进程)上、这一轮由该线槽位领着的卡才能停:
 *   外部执行者 → 不能(只能在「接入的 AI」里撤销);领卡方不是任何受管线的槽位 → 不能(看板没有它的进程);
 *   该线这一刻有 2 个以上槽在跑 → 不能(现有停线是整条线停,会连带别的槽手上的卡;到设置里停)。
 * ctx:{ isExecutor(worker), lineOfWorker(worker) → 受管线 id | null, external(line), liveSlots(line) → 在跑的槽数 }
 */
export function stopVerdict(t, ctx) {
  if (!t || t.status !== "in_progress") return { stoppable: false, reason: "这张卡不在执行中" };
  if (ctx.isExecutor(t.worker)) return { stoppable: false, reason: "外部 AI,只能在「接入的 AI」里撤销" };
  const line = ctx.lineOfWorker(t.worker);
  if (!line || ctx.external(line)) return { stoppable: false, reason: "领这张卡的不是看板起的执行线,看板停不了它" };
  const n = ctx.liveSlots(line);
  if (n > 1) return { stoppable: false, line, reason: `这条线有 ${n} 个槽在跑,停止会连带别的卡;要停到设置里停整条线` };
  return { stoppable: true, line };
}

/**
 * 建卡后自动开工:对计划里用到的线逐条走闸、起线。顺序 = 线在 lines 里第一次出现的顺序。
 * deps:{ external(line), supervised(line), running(line), gateOf(line) → 拦下的原因 | null, start(line)(抛错 = 没起来,用错误信息作原因) }
 * 返回 { started:[线], blocked:[{line, reason}], already_running:[线] };外部线不进任何一组(等对方来领)。
 */
export function runAutostart(lines, deps) {
  const out = { started: [], blocked: [], already_running: [] };
  for (const line of [...new Set((lines || []).filter((x) => typeof x === "string" && x))]) {
    if (deps.external(line)) continue;
    if (!deps.supervised(line)) { out.blocked.push({ line, reason: "不是看板管的执行线" }); continue; }
    if (deps.running(line)) { out.already_running.push(line); continue; }
    const gate = deps.gateOf(line);
    if (gate) { out.blocked.push({ line, reason: String(gate) }); continue; }
    try { deps.start(line); out.started.push(line); }
    catch (e) { out.blocked.push({ line, reason: cut(String(e?.message || e), 160) }); }
  }
  return out;
}

/** 对话里那条 system 消息:「已让 2 条线开工;线「X」没起来:座席未解禁。」 labelOf(line) → 显示名。 */
export function autostartText(r, labelOf = (l) => l) {
  const name = (l) => "「" + (labelOf(l) || l) + "」";
  const seg = [];
  seg.push(r.started.length ? `已让 ${r.started.length} 条线开工(${r.started.map(name).join("、")})` : "没有线开工");
  if (r.already_running.length) seg.push(`${r.already_running.map(name).join("、")}本来就在跑`);
  for (const b of r.blocked) seg.push(`线${name(b.line)}没起来:${b.reason}`);
  return redactText(seg.join(";") + "。");
}
