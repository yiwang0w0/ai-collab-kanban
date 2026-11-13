// convtest 用的假协调线 CLI。经 BOARD_COORDINATOR_CLI_ARGV=[node, 本文件] 接进看板,不调用任何模型。
// 每次被调用都把 argv、cwd、pid 追加到 CONVTEST_LOG(JSON 行);按[用户消息]里的标记决定交回什么:
//   【计划】四张卡的计划(含一个不在实现线里的线名)   【坏计划】依赖指向后面的卡(过不了服务端检查)
//   【无结构】result 里没有 structured_output          【慢】起一个子进程后一直不结束(测停止与超时)
//   【登录失效】真实 CLI 登录失效时的输出形状
//   【先坏后好】首次交坏计划(依赖指向自己、线名不在菜单),看板就地修正那一次交好计划
//   【先失败】这块看板第一次见到时同【无结构】(这一轮失败),之后同「其余」(测 retry_of 重跑)
//   其余:只回一句话,plan 为 null
// 看板的就地修正(内容以 [看板检查] 开头)没有[用户消息]:按会话号取这个会话上一条用户消息,按同一标记作答;
// 【计划】【坏计划】修正时照旧交回原样(线名 ghost、依赖越界都不改)。
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const content = valueOf("-p") || "";
const sessionId = valueOf("--session-id") || valueOf("--resume");
const repair = content.startsWith("[看板检查]");
const messageFile = process.env.CONVTEST_LOG + ".messages.json";
const earlier = (() => { try { return JSON.parse(readFileSync(messageFile, "utf8")); } catch { return {}; } })();
const message = repair ? String(earlier[sessionId] || "") : content.slice(content.lastIndexOf("[用户消息]"));
if (!repair) writeFileSync(messageFile, JSON.stringify({ ...earlier, [sessionId]: message }));
const slow = message.includes("【慢】");
const failedOnce = process.env.CONVTEST_LOG + ".failed-once";
const failFirst = message.includes("【先失败】") && !existsSync(failedOnce);
if (failFirst) writeFileSync(failedOnce, "");
const child = slow ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" }) : null;

appendFileSync(process.env.CONVTEST_LOG, JSON.stringify({
  argv, cwd: process.cwd(), cwd_entries: readdirSync(process.cwd()), pid: process.pid, child: child?.pid ?? null,
  env_keys: Object.keys(process.env),
}) + "\n");

const task = (subject, line, after, extra = {}) => ({
  subject, summary: `${subject}的一句话说明`, description: `goal: ${subject}\nctx(file:line): 待定位\ndo: 做\naccept(cmd -> expect): 待定\nlimits: 无`,
  acceptance: "待定", line, after, needs_confirm: false, needs_bash: false, ...extra,
});
const plan = (tasks) => ({ goal: { subject: "导出功能改造", description: "把导出做成可配置的" }, tasks });
let turn;
if (message.includes("【计划】")) turn = { reply: "计划出好了,请过目。", title: "导出功能改造", plan: plan([
  task("梳理现有导出入口", "alpha", []),
  task("补导出配置项", "ghost", [1]),
  task("迁移旧导出记录", null, [1, 2], { needs_confirm: true, needs_bash: true }),
  task("写使用说明", "alpha", [3]),
]) };
else if (message.includes("【坏计划】")) turn = { reply: "改好了。", plan: plan([task("甲", "alpha", [2]), task("乙", "alpha", [])]) };
else if (message.includes("【先坏后好】")) turn = repair
  ? { reply: "修正好了,请过目。", plan: plan([task("甲", "alpha", []), task("乙", "beta", [1])]) }
  : { reply: "计划出好了。", title: "先坏后好", plan: plan([task("甲", "alpha", []), task("乙", "ghost", [2])]) };
// 【关系】(cardrelationstest,合同 I3 / I4):计划项带 batch / needs;第 2 张资源名不合规、第 3 张批名是空白 → 建卡时静默不设。
else if (message.includes("【关系】")) turn = { reply: "计划出好了。", title: "关系", plan: plan([
  task("甲", "alpha", [], { batch: "b1", needs: ["db:fixture"] }),
  task("乙", "alpha", [], { batch: "b1", needs: ["bad name!"] }),
  task("丙", "alpha", [1], { batch: "  ", needs: [] }),
]) };
else turn = { reply: `收到:${message.slice("[用户消息]".length).trim().slice(0, 40)}`, plan: null };

// 用量与真实 CLI 同形(2026-11-10 CLI 2.1.322 实测):usage 是这一轮各次调用之和;
// --resume 续接同一会话时 total_cost_usd 与 modelUsage 是会话累计(上一轮退出时记下的 + 这一轮)。
// 每轮固定花 0.0125、词元 11/22/333/44;累计记在 CONVTEST_LOG 旁的文件里,按会话号分开。
const ROUND = { cost: 0.0125, in: 11, out: 22, cr: 333, cc: 44 };
const costFile = process.env.CONVTEST_LOG + ".cost.json";
const saved = (() => { try { return JSON.parse(readFileSync(costFile, "utf8")); } catch { return {}; } })();
const prior = argv.includes("--resume") && saved[sessionId] ? saved[sessionId] : { cost: 0, in: 0, out: 0, cr: 0, cc: 0 };
const total = Object.fromEntries(Object.keys(ROUND).map((k) => [k, prior[k] + ROUND[k]]));
if (!slow && !message.includes("【登录失效】")) writeFileSync(costFile, JSON.stringify({ ...saved, [sessionId]: total }));
const result = {
  type: "result", subtype: "success", is_error: false, session_id: sessionId, num_turns: 3, duration_ms: 1200,
  total_cost_usd: total.cost, usage: { input_tokens: ROUND.in, output_tokens: ROUND.out, cache_read_input_tokens: ROUND.cr, cache_creation_input_tokens: ROUND.cc },
  modelUsage: { "claude-opus-5": { inputTokens: total.in, outputTokens: total.out, cacheReadInputTokens: total.cr,
                                   cacheCreationInputTokens: total.cc, costUSD: total.cost } },
  permission_denials: [], result: JSON.stringify(turn),
  ...(message.includes("【无结构】") || failFirst ? {} : { structured_output: turn }),
};
const use = (name) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });
if (message.includes("【登录失效】")) {
  // 真实 CLI 登录失效时的形状(2026-11-10 实测):subtype 仍是 success,is_error 为真,退出码 1,带会话号。
  const said = "Failed to authenticate: OAuth session expired and could not be refreshed";
  process.stdout.write(JSON.stringify([
    { type: "system", subtype: "init", session_id: sessionId },
    { type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: said }] } },
    { type: "result", subtype: "success", is_error: true, session_id: sessionId, num_turns: 1, total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, permission_denials: [], result: said },
  ]));
  process.exitCode = 1;
} else if (!slow) process.stdout.write(JSON.stringify([
  { type: "system", subtype: "init", session_id: sessionId },
  use("Read"), use("Grep"), use("Read"), use("StructuredOutput"), result,
]));
else setTimeout(() => {}, 600000);
