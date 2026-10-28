// The goal-decomposition prompt, as a pure function.
//
// Why it lives in its own module: server.mjs starts listening the moment it is
// imported, so anything built inside it can only be observed by spawning a real CLI
// — and a .cmd stub cannot be spawned at all (Node refuses .bat/.cmd without a
// shell, measured), while a Node stub never sees the arguments (Node rejects the
// unknown flags before any preload runs, also measured). The result was a whole
// generated surface with NO machine coverage: the line menu, the "continues an
// earlier goal" block and the output language could each break silently.
// Pulling the string-building out makes it a pure function with a test, following
// the same shape as decision_lib.js.
//
// The board's own display language is Chinese; the language the GENERATED CARDS are
// written in is a fleet property (`language` in fleet.config.json). Absent = say
// nothing, and the model mirrors the prompt's language, which is what every
// existing deployment already gets.
"use strict";

const NL = String.fromCharCode(10);

/** The line menu shown to the decomposer. BUILT from config — a hand-copied list
 *  once silently dropped a line, and nothing could tell. v0.22: the operator's display
 *  name rides along in 「」 when there is one; the id stays what the model must emit. The
 *  CALLER decides which lines enter the menu (the server passes implement lines only —
 *  a review line takes no implementation card). */
function lineMenu(lines, hints = {}, labels = {}) {
  return lines.map((l) => {
    const name = labels[l] ? `${l}「${labels[l]}」` : l;
    return hints[l] ? `${name} (${hints[l]})` : name;
  }).join(", ");
}

/**
 * @param goal     the goal card (subject/description/id required)
 * @param prev     the goal this one continues, or null. Only a card whose kind is
 *                 "goal" counts; anything else is ignored.
 * @param lines    line ids offered (the implement lines, in config order)
 * @param hints    line id -> hint text
 * @param labels   line id -> display name (v0.22; "" / absent = id only)
 * @param language natural language for generated card text ("" = say nothing)
 *
 * 2026-10-28：拆解器不再有写工具，计划经 CLI 的结构化输出交回（--json-schema 用下面的
 * DECOMPOSE_PLAN_SCHEMA，server 只读结果 JSON 的 structured_output，见 core/board-claude-cli.mjs）。
 * 旧调用方传的 outPath 不再使用。
 */
function buildDecomposePrompt({ goal, prev = null, lines, hints = {}, labels = {}, language = "" }) {
  const lang = String(language || "").trim();
  return [
    "把下面这个目标拆成可以独立交付的子任务。你**不做这些活**,只做拆解。",
    "",
    `目标 #${goal.id}:${goal.subject}`,
    goal.description ? "背景/要求:" + NL + goal.description : "",
    // ⭐ Goals may CONTINUE earlier goals: when hung under a completed goal, the
    //   decomposition thinks WITH the predecessor's completion record — continue,
    //   don't re-plan or redo what is done.
    ...(prev && prev.kind === "goal"
      ? ["",
         `⭐本目标衔接既往目标 #${prev.id}「${prev.subject}」(${prev.status === "done" ? "已完成" : prev.status})。`,
         "拆解时接着它的成果想:已完成的事不要重做,新子任务要说清与前作产出的衔接点。",
         "前作完成记录:",
         String(prev.result || "(无完成记录)").slice(0, 1200)]
      : []),
    "",
    "拆解规则:",
    "- **一张卡 = 一个可独立验收的产出**。复合的要切开。",
    // 给人看的那一行:人看卡时最先看到它,所以要求白话、不写文件行号。没写也能建卡(schema 里是可选),
    //   但那张卡在面板上就只剩标题 —— 说清这件事,比默默替它从 description 截一段好。
    "- 每张卡写一句 summary:给人看的「要做什么」,一两行白话,不写文件行号、不写实现细节。",
    "- 顺序有依赖就用 after 指出前置(填同一批里的序号,从 1 开始);没有就不填。",
    "- 每张卡要写清 acceptance:怎么判这活干没干成,能给可执行命令就给。",
    `- line 从这些里选(填「」前面的标识):${lineMenu(lines, hints, labels)};拿不准就填 null,谁都能领。`,
    "- 要跑命令的卡把 needs_bash 设成 true;只读写文件的不要设。",
    "- 涉及生产数据、DB migration、删除、push、花钱的,**在 description 里显式写明需要人确认**。",
    "- 别拆太碎:3〜8 张为宜。拆不动就只出 1 张。",
    ...(lang ? [`- **卡片正文(subject/description/acceptance)一律用 ${lang} 书写**。`] : []),
    "",
    "只做一件事:用结构化输出交回结果(结构见下),不写任何文件。",
    "",
    "内容是 JSON,不要包代码块:",
    '{"tasks":[{"subject":"...","summary":"...","description":"...","acceptance":"...","line":"' +
      lines.join("|") + '|null","needs_bash":false,"after":[]}]}',
  ].filter(Boolean).join(NL);
}

/** 计划的结构（CLI 的 --json-schema 与 server 收到 structured_output 后的结构校验共用这一份）。
 *  字段与上面提示词里的示例一一对应（decomposetest ④ 按本 schema 校验那个示例）。只管结构：line 不做
 *  枚举，线名是否在实现线内、after 序号是否越界、是否一张都没有，仍由 server 做语义判断
 *  （线名打错要记在卡面上，不能被 CLI 悄悄纠正）。 */
const freeze = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const DECOMPOSE_PLAN_SCHEMA = freeze({
  type: "object", additionalProperties: false, required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["subject", "description", "acceptance", "line", "needs_bash", "after"],
        properties: {
          subject: { type: "string", minLength: 1 },
          // 给人看的「要做什么」。**可选**(不进 required):旧计划、旧模型不出这个字段时整次拆解照旧成立,
          //   卡上只剩标题(退路在 store.cardBrief),不该为一行文案把整批卡废掉。
          summary: { type: "string" },
          description: { type: "string" },
          acceptance: { type: "string" },
          line: { type: ["string", "null"] },
          needs_bash: { type: "boolean" },
          after: { type: "array", items: { type: "integer", minimum: 1 } },
        },
      },
    },
  },
});

module.exports = { buildDecomposePrompt, lineMenu, DECOMPOSE_PLAN_SCHEMA };
