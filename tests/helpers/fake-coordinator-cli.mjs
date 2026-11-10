// convtest 用的假协调线 CLI。经 BOARD_COORDINATOR_CLI_ARGV=[node, 本文件] 接进看板,不调用任何模型。
// 每次被调用都把 argv、cwd、pid 追加到 CONVTEST_LOG(JSON 行);按[用户消息]里的标记决定交回什么:
//   【计划】四张卡的计划(含一个不在实现线里的线名)   【坏计划】依赖指向后面的卡(过不了服务端检查)
//   【无结构】result 里没有 structured_output          【慢】起一个子进程后一直不结束(测停止与超时)
//   【登录失效】真实 CLI 登录失效时的输出形状
//   其余:只回一句话,plan 为 null
import { appendFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const content = valueOf("-p") || "";
const message = content.slice(content.lastIndexOf("[用户消息]"));
const sessionId = valueOf("--session-id") || valueOf("--resume");
const slow = message.includes("【慢】");
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
else turn = { reply: `收到:${message.slice("[用户消息]".length).trim().slice(0, 40)}`, plan: null };

const result = {
  type: "result", subtype: "success", is_error: false, session_id: sessionId, num_turns: 3, duration_ms: 1200,
  total_cost_usd: 0.0125, usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 333, cache_creation_input_tokens: 44 },
  permission_denials: [], result: JSON.stringify(turn),
  ...(message.includes("【无结构】") ? {} : { structured_output: turn }),
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
