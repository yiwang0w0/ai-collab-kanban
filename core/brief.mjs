// 看板简报(合同 E):GET /api/brief 与助手的 get_brief 同一份。给聊天机器人、可穿戴设备背后的常驻 AI 看近况用。
// 「等你处理」不另写判定:取首页「待我处理」那一栏(panel.html 的 home-model 区 homeLists,server 用 core/home-model.mjs 切出来跑)
// 加执行线故障(同一区的 homeLineFaults);这里只把那两份结果折成条目与一段短文。
// 本文件全是纯函数:固定输入 → 固定输出,不读时钟(now 由调用方给)、不碰库。text 与条目里的标题都过 redactText,长度硬上限。
import { redactText, cut } from "./flow.mjs";

export const BRIEF_DEFAULT = 280, BRIEF_MIN = 80, BRIEF_MAX = 600;
export const RECENT_MS = 24 * 3600000;          // 「刚完成」= 24 小时内完成的
const LIST_MAX = 20, RECENT_MAX = 5, TITLE_MAX = 60;
export const KIND_WORD = { review: "待验收", decision: "等你决定", release: "待放行", stalled: "AI 卡住", line_fault: "线故障", blocked: "受阻", other: "待处理" };

/** max_chars 参数:缺省 280;要 80–600 的整数,其余抛 BAD_INPUT。 */
export function maxCharsOf(raw) {
  if (raw === null || raw === undefined || raw === "") return BRIEF_DEFAULT;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < BRIEF_MIN || n > BRIEF_MAX)
    throw Object.assign(new Error(`max_chars 要 ${BRIEF_MIN}–${BRIEF_MAX} 的整数`), { code: "BAD_INPUT" });
  return n;
}
const clean = (s, max = TITLE_MAX) => cut(redactText(String(s ?? "")), max);

/** 「待我处理」的一行是哪一类。卡看卡本身的状态,不看状态文案(文案会改)。 */
function kindOf(row, t) {
  if (row.action === "executor") return "stalled";
  if (row.action === "approval") return row.kind === "request" ? "decision" : "blocked";
  if (!t) return "other";
  if (t.status === "not_started") return t.human_gate ? "decision" : "release";
  if (t.status === "waiting") return t.waiting_for === "review" ? "review" : ["confirm", "decision"].includes(t.waiting_for) ? "decision" : "blocked";
  return "other";
}

/**
 * 简报的条目。lists = homeLists(...) 的结果;faults = homeLineFaults(...);tasks = 本板未归档的卡(带 who:在做的那一方的显示名);
 * headline = 效率主句(读不到 = null)。返回 { headline, attention, doing, done_recent }。
 */
export function briefModel({ lists = {}, faults = [], tasks = [], headline = null, now = 0 } = {}) {
  const byId = new Map(tasks.map((t) => [Number(t.id), t]));
  const attention = [];
  for (const row of Array.isArray(lists.mine) ? lists.mine : []) {
    const t = row.localId != null ? byId.get(Number(row.localId)) : null;
    attention.push({ kind: kindOf(row, t), ...(t ? { task_id: Number(t.id) } : {}), title: clean(row.title), since: row.updated || null,
                     ...(t?.posted_by?.label ? { posted_by: clean(t.posted_by.label, 24) } : {}) });
  }
  for (const f of Array.isArray(faults) ? faults : []) attention.push({ kind: "line_fault", title: clean(f.what), since: null });
  const doing = tasks.filter((t) => t.status === "in_progress" && !t.archived_at && t.kind !== "goal")
    .sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")) || a.id - b.id)
    .map((t) => ({ task_id: Number(t.id), title: clean(t.subject), who: clean(t.who || t.worker || t.line || "未指定", 24) }));
  const done_recent = tasks.filter((t) => t.status === "done" && t.kind !== "goal" && now - Date.parse(t.updated_at) <= RECENT_MS && Date.parse(t.updated_at) <= now)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id).slice(0, RECENT_MAX)
    .map((t) => ({ task_id: Number(t.id), title: clean(t.subject), at: t.updated_at }));
  return { headline: typeof headline === "string" && headline.trim() ? clean(headline, 160) : null,
           attention: attention.slice(0, LIST_MAX), attention_total: attention.length, doing: doing.slice(0, LIST_MAX), doing_total: doing.length, done_recent };
}

// 卡住与线故障的标题自己就说了是什么事(「X 卡住了 · 手上有 #n」「线 A 崩溃」),不再缀类别词,标题多给几个字。
const SELF_SAID = new Set(["stalled", "line_fault"]);
const named = (a, w) => SELF_SAID.has(a.kind) ? "「" + cut(a.title, w + 6) + "」"
  : (a.task_id ? "#" + a.task_id : "") + "「" + cut(a.title, w) + "」" + (KIND_WORD[a.kind] || "");
/** 一段给小屏幕看的中文:等你处理几件(最要紧的一两件点名)、在做几件、刚完成什么、本周效率主句。 */
export function briefText(m, maxChars = BRIEF_DEFAULT) {
  const max = Math.min(BRIEF_MAX, Math.max(BRIEF_MIN, Number(maxChars) || BRIEF_DEFAULT));
  const n = m.attention_total ?? m.attention.length, d = m.doing_total ?? m.doing.length, r = m.done_recent;
  const build = ({ names = 2, w = 16, recent = true, eff = true }) => {
    const seg = [];
    seg.push(n ? `等你处理 ${n} 件:` + m.attention.slice(0, names).map((a) => named(a, w)).join("、") + (n > names ? " 等" : "") : "没有等你处理的事");
    seg.push(d ? `在做 ${d} 件` : "没有在做的卡");
    if (recent && r.length) seg.push(`刚完成 #${r[0].task_id}「${cut(r[0].title, w)}」` + (r.length > 1 ? ` 等 ${r.length} 张` : ""));
    if (eff) seg.push(m.headline || "本周效率暂无数据");
    return redactText(seg.join("。") + "。").replace(/\s+/g, " ").trim();
  };
  // 放不下就逐级收:标题缩短 → 只点名一件 → 去掉「刚完成」→ 去掉效率主句 → 硬截。
  for (const o of [{}, { w: 10 }, { names: 1, w: 10 }, { names: 1, w: 10, recent: false }, { names: 1, w: 8, recent: false, eff: false }]) {
    const t = build(o);
    if ([...t].length <= max) return t;
  }
  return cut(build({ names: 1, w: 8, recent: false, eff: false }), max);
}

/** GET /api/brief 的应答体。 */
export function briefOf(input, maxChars = BRIEF_DEFAULT) {
  const m = briefModel(input);
  return { text: briefText(m, maxChars), headline: m.headline, attention: m.attention, attention_total: m.attention_total,
           doing: m.doing, doing_total: m.doing_total, done_recent: m.done_recent, generated_at: Number.isFinite(input.now) ? new Date(input.now).toISOString() : null };
}
