// 看板简报(合同 E):GET /api/brief 与助手的 get_brief 同一份。给聊天机器人、可穿戴设备背后的常驻 AI 看近况用。
// 「等你处理」不另写判定:取首页「待我处理」那一栏(panel.html 的 home-model 区 homeLists,server 用 core/home-model.mjs 切出来跑)
// 加执行线故障(同一区的 homeLineFaults);这里只把那两份结果折成条目与一段短文。
// 本文件全是纯函数:固定输入 → 固定输出,不读时钟(now 由调用方给)、不碰库。text 与条目里的标题都过 redactText,长度硬上限。
// 第 6 波(合同 G6):text 只写等本人处理的件,每件一行、动词开头;效率主句只在 headline。mode=quiet 只留紧急类(URGENT)。
import { redactText, cut } from "./flow.mjs";
import { URGENT } from "./assistant-feed.mjs";

export const BRIEF_DEFAULT = 280, BRIEF_MIN = 80, BRIEF_MAX = 600;
export const RECENT_MS = 24 * 3600000;          // 「刚完成」= 24 小时内完成的
const LIST_MAX = 20, RECENT_MAX = 5, TITLE_MAX = 60;
export const KIND_WORD = { review: "待验收", decision: "等你决定", release: "待放行", stalled: "AI 卡住", line_fault: "线故障", blocked: "受阻", other: "待处理" };
/** text 每行开头的动词。hands = ask_operator needs:"hands"(等你亲手做;条目上 kind 仍是 decision,另带 needs)。 */
export const KIND_VERB = { review: "验收", decision: "裁定", hands: "去做", release: "放行", stalled: "查看", line_fault: "查看", blocked: "处理", other: "处理" };

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
  // 合同 I11:未开始的卡有带 attention 的阻塞 → 按它归类(fault → blocked,decide → decision),不逐码写分支。
  if (t.status === "not_started") {
    if (t.human_gate) return "decision";
    const att = (Array.isArray(t.progress_blockers) ? t.progress_blockers : []).find((b) => b?.attention === "fault" || b?.attention === "decide")?.attention;
    return att === "fault" ? "blocked" : att === "decide" ? "decision" : "release";
  }
  if (t.status === "waiting") return t.waiting_for === "review" ? "review" : ["confirm", "decision"].includes(t.waiting_for) ? "decision" : "blocked";
  return "other";
}

/**
 * 简报的条目。lists = homeLists(...) 的结果;faults = homeLineFaults(...);tasks = 本板未归档的卡(带 who:在做的那一方的显示名);
 * headline = 效率主句(读不到 = null)。返回 { headline, attention, doing, done_recent }。
 */
export function briefModel({ lists = {}, faults = [], tasks = [], headline = null, now = 0, packages = [] } = {}) {
  const byId = new Map(tasks.map((t) => [Number(t.id), t]));
  const attention = [];
  for (const row of Array.isArray(lists.mine) ? lists.mine : []) {
    const t = row.localId != null ? byId.get(Number(row.localId)) : null;
    const kind = kindOf(row, t);
    attention.push({ kind, ...(t ? { task_id: Number(t.id) } : {}), title: clean(row.title), since: row.updated || null,
                     ...(t?.posted_by?.label ? { posted_by: clean(t.posted_by.label, 24) } : {}),
                     // 合同 G5:执行者 ask_operator 说要本人亲手做(任务对象上的 ask.needs);没有 = 按裁定。
                     ...(kind === "decision" && t?.ask?.needs === "hands" ? { needs: "hands" } : {}) });
  }
  // 合同 I10d:包出了、还没跑(core/packages.mjs 的 attentionItems,排在「待我处理」各行之后、线故障之前)。
  //   亲手跑 = 等你亲手做(kind decision + needs hands);出包对不上 = 受阻(blocked,先别跑)。条目只带 package_id
  //   (label / expect 不进简报与助手的提醒流;首页 G2 的 detail 由 home-background 按 package_id 取)。
  for (const p of Array.isArray(packages) ? packages : []) {
    if (!p || (p.kind !== "hands" && p.kind !== "fault")) continue;
    attention.push({ kind: p.kind === "hands" ? "decision" : "blocked", task_id: Number(p.task_id), title: clean(p.title), since: p.since || null,
                     ...(p.kind === "hands" ? { needs: "hands" } : {}), package_id: Number(p.package.id) });
  }
  for (const f of Array.isArray(faults) ? faults : []) attention.push({ kind: "line_fault", title: clean(f.what), since: null });
  const doing = tasks.filter((t) => t.status === "in_progress" && !t.archived_at && t.kind !== "goal")
    .sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")) || a.id - b.id)
    .map((t) => ({ task_id: Number(t.id), title: clean(t.subject), who: clean(t.who || t.worker || t.line || "未指定", 24) }));
  const done_recent = tasks.filter((t) => t.status === "done" && t.kind !== "goal" && now - Date.parse(t.updated_at) <= RECENT_MS && Date.parse(t.updated_at) <= now)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id).slice(0, RECENT_MAX)
    .map((t) => ({ task_id: Number(t.id), title: clean(t.subject), at: t.updated_at }));
  const recent = tasks.filter((t) => t.status === "done" && t.kind !== "goal" && now - Date.parse(t.updated_at) <= RECENT_MS && Date.parse(t.updated_at) <= now)
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || a.id - b.id)
    .map((t) => ({ task_id: Number(t.id), title: clean(t.subject), at: t.updated_at }));
  const out = { headline: typeof headline === "string" && headline.trim() ? clean(headline, 160) : null,
           attention: attention.slice(0, LIST_MAX), attention_total: attention.length, doing: doing.slice(0, LIST_MAX), doing_total: doing.length, done_recent };
  // 提醒流(core/assistant-feed.mjs)要全量:不进应答体,不可枚举。
  Object.defineProperty(out, "all", { value: { attention, done: recent }, enumerable: false });
  return out;
}

// 卡住与线故障的标题自己就说了是什么事(「X 卡住了 · 手上有 #n」「线 A 崩溃」),不再带卡号。
const lineOf = (a, w) => (KIND_VERB[a.needs === "hands" ? "hands" : a.kind] || "处理") +
  (a.task_id && a.kind !== "stalled" && a.kind !== "line_fault" ? " #" + a.task_id : "") + "「" + cut(a.title, w) + "」";
const oneLine = (s) => redactText(s).replace(/\s+/g, " ").trim();
/**
 * 给小屏幕看的一段中文(合同 G6):只写等本人处理的件,每件一行、动词开头(验收 / 裁定 / 去做 / 放行 / 查看 / 处理);
 * 在做几件、刚完成什么、效率主句不进 text(效率主句在 headline,其余在条目里)。放不下就逐级收:标题缩短 → 少写几件,
 * 末行写「查看其余 N 件」。
 */
export function briefText(m, maxChars = BRIEF_DEFAULT) {
  const max = Math.min(BRIEF_MAX, Math.max(BRIEF_MIN, Number(maxChars) || BRIEF_DEFAULT));
  const items = Array.isArray(m.attention) ? m.attention : [], n = m.attention_total ?? items.length;
  if (!n) return "没有等你处理的事。";
  const fits = (t) => [...t].length <= max;
  for (let k = items.length; k >= 1; k--) {
    for (const w of [24, 16, 10, 6]) {
      const lines = items.slice(0, k).map((a) => oneLine(lineOf(a, w)));
      if (n > k) lines.push(`查看其余 ${n - k} 件`);
      const t = lines.join("\n");
      if (fits(t)) return t;
    }
  }
  return cut(`查看等你处理的 ${n} 件`, max);
}

/** GET /api/brief 的应答体。 */
export function briefOf(input, maxChars = BRIEF_DEFAULT, { mode = "normal" } = {}) {
  return briefFrom(briefModel(input), maxChars, { mode, now: input.now });
}
/** 同 briefOf,但用调用方已算好的 briefModel 结果(server 同一份结果还要给提醒流用)。
 *  mode=quiet:attention 与 text 只留紧急类(线故障、AI 卡住、受阻),另给 muted = 压下没写的件数。 */
export function briefFrom(m, maxChars = BRIEF_DEFAULT, { mode = "normal", now = null } = {}) {
  let attention = m.attention, total = m.attention_total, muted = null;
  if (mode === "quiet") {
    const all = m.all?.attention ?? m.attention, urgent = all.filter((a) => URGENT.has(a.kind));
    attention = urgent.slice(0, LIST_MAX); total = urgent.length; muted = all.length - urgent.length;
  }
  const v = { ...m, attention, attention_total: total };
  return { text: briefText(v, maxChars), headline: m.headline, attention, attention_total: total,
           doing: m.doing, doing_total: m.doing_total, done_recent: m.done_recent,
           ...(muted === null ? {} : { mode: "quiet", muted }), generated_at: Number.isFinite(now) ? new Date(now).toISOString() : null };
}
