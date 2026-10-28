// Pure-function regression for the goal-decomposition prompt.
// Touches no board, no database, no CLI: the prompt builder is a pure function
// precisely so this surface can be measured at all (see core/decompose_lib.js).
// ⑤–⑩ 同样不起 CLI:看板服务端自己调用 Claude CLI 的参数、环境与输出解析(core/board-claude-cli.mjs);
// ⑨ 起一次本机 Python,只为拿执行线 verify_lib 的规则做逐条对照。

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { buildDecomposePrompt, lineMenu, DECOMPOSE_PLAN_SCHEMA } = require_(join(__dirname, "..", "core", "decompose_lib.js"));
let C = null, cliImportError = null;
try { C = await import(pathToFileURL(join(__dirname, "..", "core", "board-claude-cli.mjs")).href); }
catch (e) { cliImportError = e; }
const schemaErrorsOf = C?.schemaErrors;

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const GOAL = { id: 7, kind: "goal", subject: "把工单处理搬上看板", description: "背景说明一行", status: "not_started" };
const LINES = ["alpha", "coord"];
const HINTS = { alpha: "实装", coord: "协调/裁定/跑命令" };
const OUT = "C:/tmp/decompose/goal-7.json";
const base = (over = {}) =>
  buildDecomposePrompt({ goal: GOAL, outPath: OUT, lines: LINES, hints: HINTS, ...over });

console.log("[① the generated-content language is a fleet property]");
{
  const off = base();
  const on = base({ language: "English" });
  // ⚠ Both directions. Asserting only the "on" side stays green if the knob is
  //   hardwired ON; asserting only "off" stays green if it never works at all.
  ok("⭐unset ⇒ the prompt says nothing about language (the model mirrors it)",
     !/一律用/.test(off), (off.match(/一律用[^\n]*/) || ["(absent, as expected)"])[0]);
  ok("⭐set ⇒ one instruction line naming the language",
     /- \*\*卡片正文\(subject\/description\/acceptance\)一律用 English 书写\*\*。/.test(on),
     (on.match(/一律用[^\n]*/) || ["(missing)"])[0]);
  ok("the instruction sits INSIDE the rules block, not after the output contract",
     on.indexOf("一律用 English") > on.indexOf("拆解规则:") &&
     on.indexOf("一律用 English") < on.indexOf("只做一件事"));
  ok("whitespace-only language counts as unset (a knob set to \" \" must not emit a blank rule)",
     !/一律用/.test(base({ language: "   " })));
  ok("the language name is carried VERBATIM (not mapped through a table of known languages)",
     /一律用 日本語 书写/.test(base({ language: "日本語" })));
  ok("setting the language changes NOTHING else in the prompt",
     off.split("\n").filter((l) => !/一律用/.test(l)).join("\n") ===
     on.split("\n").filter((l) => !/一律用/.test(l)).join("\n"));
}

console.log("\n[② the line menu is built from config, never copied into prose]");
{
  const p = base();
  ok("every configured line appears in the menu with its hint",
     /- line 从这些里选(?:\([^)]*\))?:alpha \(实装\), coord \(协调\/裁定\/跑命令\);/.test(p),
     (p.match(/- line 从这些里选[^\n]*/) || ["(missing)"])[0]);
  ok("a line with no hint degrades to the bare id",
     lineMenu(["a", "b"], { a: "x" }) === "a (x), b", lineMenu(["a", "b"], { a: "x" }));
  // v0.22: the operator's display name rides along; the id the model must emit stays first.
  ok("⭐a label shows as id「label」 (hint) — the id is still what the model emits",
     lineMenu(["engine", "coord"], { engine: "代码" }, { engine: "引擎" }) === "engine「引擎」 (代码), coord",
     lineMenu(["engine", "coord"], { engine: "代码" }, { engine: "引擎" }));
  ok("labels reach the prompt through buildDecomposePrompt",
     base({ labels: { alpha: "实装线" } }).includes("alpha「实装线」 (实装)"));
  ok("the menu tells the model to emit the identifier before 「」",
     /填「」前面的标识/.test(base({ labels: { alpha: "实装线" } })));
  // The caller decides which lines enter the menu (the server passes implement lines only):
  // a review line handed in would be offered — so the pure function must not filter, and
  // the server's filter is pinned in servertest (source shape).
  ok("(contract) lineMenu offers exactly the lines it is given, in order",
     lineMenu(["b", "a"], {}) === "b, a");
  ok("the JSON shape offered to the model lists the same lines plus null",
     p.includes('"line":"alpha|coord|null"'),
     (p.match(/\{"tasks".*/) || ["(missing)"])[0].slice(0, 80));
  // ⚠ The measured failure this guards: a hand-copied list dropped one line in two
  //   places at once, and the decomposer cannot pick a line missing from its menu —
  //   that line silently starved. Adding a line to config must reach BOTH sites.
  const three = buildDecomposePrompt({ goal: GOAL, outPath: OUT, lines: ["alpha", "coord", "docs"], hints: HINTS });
  ok("⭐adding a line reaches the menu AND the JSON shape (both sites, by construction)",
     /coord \(协调\/裁定\/跑命令\), docs;/.test(three) && three.includes('"line":"alpha|coord|docs|null"'));
}

console.log("\n[③ a goal that continues an earlier goal decomposes WITH its record]");
{
  const prev = { id: 3, kind: "goal", subject: "前作目标", status: "done", result: "前作完成记录正文" };
  const cont = base({ prev });
  ok("⭐the predecessor is named, with its status in words",
     /⭐本目标衔接既往目标 #3「前作目标」\(已完成\)。/.test(cont),
     (cont.match(/⭐本目标衔接[^\n]*/) || ["(missing)"])[0]);
  ok("its completion record is carried (so finished work is not re-planned)",
     cont.includes("前作完成记录正文"));
  ok("an unfinished predecessor shows its raw status instead of 已完成",
     /\(waiting\)。/.test(base({ prev: { ...prev, status: "waiting" } })));
  ok("a predecessor with no record says so instead of going blank",
     /\(无完成记录\)/.test(base({ prev: { ...prev, result: "" } })));
  // ⚠ Parents are not always goals: an ordinary card can be a parent. Only a goal
  //   is a continuation, or every child card would drag its parent's text along.
  ok("⭐a non-goal parent is NOT treated as a continuation",
     !/衔接既往目标/.test(base({ prev: { id: 9, kind: "task", subject: "普通卡", status: "done" } })));
  ok("no predecessor ⇒ no continuation block at all", !/衔接既往目标/.test(base()));
  ok("a very long record is truncated (the prompt travels as one argv element)",
     base({ prev: { ...prev, result: "x".repeat(5000) } }).includes("x".repeat(1200)) &&
     !base({ prev: { ...prev, result: "x".repeat(5000) } }).includes("x".repeat(1201)));
}

console.log("\n[④ the output contract the server depends on]");
{
  const p = base();
  // 2026-10-28：拆解器不再有写工具。交付渠道从「Write 写结果文件」改成 CLI 的结构化输出：
  // --json-schema 给出计划结构，server 只读结果 JSON 的 structured_output（见 core/board-claude-cli.mjs）。
  // 提示词里若还点名输出文件或 Write 工具，模型会去调一个不存在的工具。
  ok("⭐提示词不再点名输出文件，也不再叫模型用 Write 工具",
     !p.includes(OUT) && !/Write/.test(p), (p.match(/[^\n]*(?:Write|goal-7\.json)[^\n]*/) || ["(无,符合预期)"])[0]);
  ok("⭐提示词要求用结构化输出交回结果、不写任何文件",
     /只做一件事:用结构化输出交回结果/.test(p) && /不写任何文件/.test(p),
     (p.match(/只做一件事[^\n]*/) || ["(missing)"])[0]);
  // 提示词里给模型看的结构与 --json-schema 是同一份:示例按 schema 校验必须无误(防两处各改各的)。
  const shape = (p.match(/\{"tasks".*\}/) || [""])[0];
  let shapeErrors = ["(示例不是 JSON)"];
  try { shapeErrors = DECOMPOSE_PLAN_SCHEMA && schemaErrorsOf ? schemaErrorsOf(JSON.parse(shape), DECOMPOSE_PLAN_SCHEMA) : ["(schema 或校验函数缺失)"]; } catch {}
  ok("⭐提示词里的 JSON 示例符合 DECOMPOSE_PLAN_SCHEMA(字段一致)", Array.isArray(shapeErrors) && shapeErrors.length === 0, shapeErrors.join(" · ").slice(0, 160));
  ok("it is told not to wrap the JSON in a code block (the server parses the final answer)",
     /不要包代码块/.test(p));
  ok("the goal's own subject and background are present",
     p.includes("目标 #7:把工单处理搬上看板") && p.includes("背景说明一行"));
  ok("a goal with an empty description simply omits the background line, no empty label",
     !/背景\/要求:/.test(buildDecomposePrompt(
       { goal: { ...GOAL, description: "" }, outPath: OUT, lines: LINES, hints: HINTS })));
  ok("the decomposer is told it does NOT do the work",
     /你\*\*不做这些活\*\*,只做拆解。/.test(p));
}

// ══ ⑤–⑩ 看板服务端自己起的 Claude CLI（一键拆解、上下文压缩）的参数、环境与输出解析 ══════════
// server.mjs 一导入就监听，桩 CLI 又看不到参数（见 decompose_lib.js 文件头），所以参数与环境
// 由 core/board-claude-cli.mjs 的纯函数组装，这里直接断言；server 只按源码形钉住它确实调用这些函数。
if (cliImportError) ok("core/board-claude-cli.mjs 可导入", false, String(cliImportError.message).slice(0, 120));
const { loadExecutionProfiles, profileEnvironment } = await import(pathToFileURL(join(__dirname, "..", "core", "execution-profiles.mjs")).href);

// flag 后面紧跟的取值（到下一个 -- 开头的元素为止）；同一 flag 出现多次时合并。
const valuesOf = (args, flag) => {
  const out = [];
  args.forEach((a, i) => {
    if (a !== flag) return;
    for (let j = i + 1; j < args.length && !String(args[j]).startsWith("--"); j++) out.push(args[j]);
  });
  return out;
};
const DATA = "C:\\kanban-fixture\\repo\\core\\.data";
const REG = "C:\\kanban-fixture\\repo\\core\\verify_registry.json";
const REPO = "C:\\kanban-fixture\\repo";
const PROFILES = loadExecutionProfiles([{ id: "claude-prod", label: "生产 API", channel: "claude_agent_sdk",
  credential_env: "CLAUDE_PROD_KEY", auth_home: "D:\\私人登录\\claude-prod\\" }], { dataDir: DATA });
const HOMES = PROFILES.map((p) => p.auth_home);
const SCOPE = { dataDir: DATA, registry: REG, authHomes: HOMES };
const WRITE_OR_NET = ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"];
const PATH_RULES = ["Read(C:/kanban-fixture/repo/core/.data/**)", "Edit(C:/kanban-fixture/repo/core/.data/**)",
  "Read(C:/kanban-fixture/repo/core/verify_registry.json)", "Edit(C:/kanban-fixture/repo/core/verify_registry.json)",
  "Read(D:/私人登录/claude-prod/**)", "Edit(D:/私人登录/claude-prod/**)",
  "Read(C:/kanban-fixture/repo/core/.data/auth/claude-cli/**)", "Edit(C:/kanban-fixture/repo/core/.data/auth/claude-cli/**)"];

console.log("\n[⑤ 一键拆解的 CLI 参数:没有写工具,只读工具也挡住数据目录与全部认证目录]");
if (C) {
  const a = C.decomposeCliArgs({ prompt: "拆解提示词", model: "claude-fixture", repoRoot: REPO, ...SCOPE });
  ok("提示词紧跟 -p(不落在任何可变参数 flag 之后,不会被吞成工具名)", a[0] === "-p" && a[1] === "拆解提示词");
  ok("⭐可用工具集合只有 Read/Glob/Grep(--tools 白名单,新出的写工具不会自动出现)",
     JSON.stringify(valuesOf(a, "--tools")) === JSON.stringify(["Read", "Glob", "Grep"]), JSON.stringify(valuesOf(a, "--tools")));
  ok("⭐参数里没有 acceptEdits,权限模式是 dontAsk(未预先放行的一律拒绝)",
     !a.includes("acceptEdits") && JSON.stringify(valuesOf(a, "--permission-mode")) === '["dontAsk"]', JSON.stringify(valuesOf(a, "--permission-mode")));
  // 不带路径的 `--allowedTools Read` 会放行任意路径的读取(2026-10-28 spike P1 实测越界读成功):
  // 越界只能靠 dontAsk(读范围 = cwd + --add-dir)与路径拒绝规则挡,所以 --allowedTools 一项都不给。
  ok("⭐不带 --allowedTools(没有不带路径的 Read/Glob/Grep 放行;越界由 dontAsk 与拒绝规则挡)",
     !a.includes("--allowedTools") && !a.includes("--allowed-tools"), JSON.stringify(valuesOf(a, "--allowedTools")));
  ok("⭐只挂工作仓一个目录,不再挂 core/", JSON.stringify(valuesOf(a, "--add-dir")) === JSON.stringify([REPO]), JSON.stringify(valuesOf(a, "--add-dir")));
  let schemaArg = null; try { schemaArg = JSON.parse(valuesOf(a, "--json-schema")[0]); } catch {}
  ok("⭐结果走结构化输出:--output-format json + --json-schema(与 decompose_lib 的 DECOMPOSE_PLAN_SCHEMA 相同)",
     JSON.stringify(valuesOf(a, "--output-format")) === '["json"]' && !!DECOMPOSE_PLAN_SCHEMA &&
     JSON.stringify(schemaArg) === JSON.stringify(DECOMPOSE_PLAN_SCHEMA), String(valuesOf(a, "--json-schema")[0]).slice(0, 80));
  ok("不加载任何 MCP 服务器(--strict-mcp-config,且不给 --mcp-config)", a.includes("--strict-mcp-config") && !a.includes("--mcp-config"));
  ok("⭐不读用户/项目/本地设置(--setting-sources \"\":其中的 allow 规则与 hooks 不进来)",
     JSON.stringify(valuesOf(a, "--setting-sources")) === '[""]', JSON.stringify(valuesOf(a, "--setting-sources")));
  ok("拆解关掉斜杠命令与技能(--disable-slash-commands),不落会话文件(--no-session-persistence)",
     a.includes("--disable-slash-commands") && a.includes("--no-session-persistence"));
  const deny = valuesOf(a, "--disallowedTools");
  ok("⭐显式拒绝 Bash/PowerShell/Edit/Write/NotebookEdit/WebFetch/WebSearch/Task", WRITE_OR_NET.every((t) => deny.includes(t)),
     WRITE_OR_NET.filter((t) => !deny.includes(t)).join(" ") || "全部在");
  ok("⭐拒绝规则含整个数据目录、登记簿与每个执行配置的认证目录(Read/Edit 各一条,盘符形)",
     PATH_RULES.every((r) => deny.includes(r)), PATH_RULES.filter((r) => !deny.includes(r)).join(" ") || "全部在");
  ok("模型与档位照旧", JSON.stringify(valuesOf(a, "--model")) === '["claude-fixture"]' && JSON.stringify(valuesOf(a, "--effort")) === '["high"]');
}

console.log("\n[⑥ CLI 子进程环境:剔除登记凭据与看板自身令牌,标准登录变量照常]");
if (C) {
  const ENV = { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\fixture", BOARD_PYTHON: "C:\\py\\python.exe",
    CLAUDE_PROD_KEY: "sk-FAKE-prod", claude_prod_key: "sk-FAKE-prod-lower", KANBAN_ANTHROPIC_API_KEY: "sk-FAKE-kanban",
    KANBAN_OPENAI_API_KEY: "sk-FAKE-openai", WORKER_BOARD_TOKEN: "FAKE-board-token", BOARD_TOKEN: "FAKE-op-token",
    REVIEW_TOKEN: "FAKE-review-token", KANBAN_PANEL_TOKEN: "FAKE-panel",
    ANTHROPIC_API_KEY: "sk-ant-standard", CLAUDE_CONFIG_DIR: "C:\\Users\\fixture\\.claude",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-standard", ANTHROPIC_BASE_URL: "https://example.invalid", PYTHONIOENCODING: "cp932" };
  const e = C.boardCliEnvironment({ env: ENV, profiles: PROFILES });
  const gone = ["CLAUDE_PROD_KEY", "claude_prod_key", "KANBAN_ANTHROPIC_API_KEY", "KANBAN_OPENAI_API_KEY"];
  ok("⭐全部配置登记的凭据变量(含自定义名、大小写不同)都不在", gone.every((k) => !(k in e)), gone.filter((k) => k in e).join(" ") || "全部剔除");
  ok("⭐看板自身的令牌类变量不在(WORKER_BOARD_TOKEN、BOARD_TOKEN、REVIEW_TOKEN、KANBAN_*TOKEN)",
     ["WORKER_BOARD_TOKEN", "BOARD_TOKEN", "REVIEW_TOKEN", "KANBAN_PANEL_TOKEN"].every((k) => !(k in e)));
  ok("任何值里都不含假凭据串", !Object.values(e).some((v) => /FAKE/.test(String(v))));
  ok("⭐标准登录变量与普通变量照常(ANTHROPIC_API_KEY、CLAUDE_CONFIG_DIR、CLAUDE_CODE_OAUTH_TOKEN、ANTHROPIC_BASE_URL、PATH、BOARD_PYTHON)",
     ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "PATH", "USERPROFILE", "BOARD_PYTHON"].every((k) => e[k] === ENV[k]));
  ok("PYTHONIOENCODING 固定 utf-8", e.PYTHONIOENCODING === "utf-8");
  const legacy = profileEnvironment(null, { env: ENV, profiles: PROFILES });
  ok("⭐复用旧线规则:结果是 profileEnvironment(null,{profiles}) 的子集,多删的只有看板令牌",
     Object.keys(e).every((k) => k === "PYTHONIOENCODING" || e[k] === legacy[k]) &&
     Object.keys(legacy).filter((k) => !(k in e)).every((k) => /TOKEN$/i.test(k)),
     Object.keys(legacy).filter((k) => !(k in e)).join(" "));
}

console.log("\n[⑦ 只从 CLI 的 structured_output 取拆解计划(不再从正文抠 JSON)]");
if (C) {
  const task = { subject: "写一行说明", description: "d", acceptance: "a", line: null, needs_bash: false, after: [] };
  const res = (structured, over = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false,
    result: structured === undefined ? "" : JSON.stringify(structured), permission_denials: [],
    ...(structured === undefined ? {} : { structured_output: structured }), ...over });
  const p1 = C.decomposePlanOf(res({ tasks: [task, { ...task, subject: "第二张", line: "alpha", after: [1] }] }));
  ok("⭐structured_output 就是计划", p1.ok && p1.plan?.tasks?.[1]?.subject === "第二张" && p1.plan.tasks[1].after[0] === 1, JSON.stringify(p1).slice(0, 120));
  // spike ADV1:说明文字里带花括号时,贪婪 {…} 提取会解析失败;T4:模型把分隔符写进说明文字。
  const textOnly = C.decomposePlanOf(res(undefined, { result: '说明里有 {a:1},计划如下 {"tasks":[' + JSON.stringify(task) + "]}" }));
  ok("⭐只有 result 正文、没有 structured_output → 不成功(正文里的 JSON 不再被采用)",
     !textOnly.ok && /structured_output/.test(textOnly.reason || ""), textOnly.reason);
  for (const [label, bad] of [["缺字段", { tasks: [{ subject: "x" }] }], ["类型错", { tasks: [{ ...task, after: ["1"] }] }],
                               ["多余字段", { tasks: [{ ...task, budget_usd: 20 }] }], ["空标题", { tasks: [{ ...task, subject: "" }] }],
                               ["不是对象", ["tasks"]], ["after 非正整数", { tasks: [{ ...task, after: [0] }] }]]) {
    const r = C.decomposePlanOf(res(bad));
    ok(`structured_output 不合 schema(${label})→ 不成功,原因写明`, !r.ok && /不合计划结构/.test(r.reason || ""), r.reason);
  }
  ok("--verbose 的消息数组形取最后一条 result", C.decomposePlanOf(JSON.stringify([{ type: "system", subtype: "init" }, JSON.parse(res({ tasks: [task] }))])).ok);
  const err = C.decomposePlanOf(res({ tasks: [task] }, { is_error: true, subtype: "error_max_budget_usd" }));
  ok("⭐CLI 报错(is_error / subtype 非 success)不当成计划,即使带着 structured_output", !err.ok && /error_max_budget_usd/.test(err.reason || ""), err.reason);
  ok("stdout 不是 JSON(例如桩 CLI 崩了)→ 不成功", !C.decomposePlanOf("SyntaxError: boom").ok && !C.decomposePlanOf("").ok);
}

console.log("\n[⑧ 上下文压缩的 CLI 参数:不给任何工具]");
if (C) {
  for (const [label, effort] of [["写压缩指示", "low"], ["/compact", undefined]]) {
    const a = C.compactCliArgs({ prompt: label === "/compact" ? "/compact 保留任务" : "写一段压缩指示", sessionId: "sid-fixture", model: "claude-fixture", effort, ...SCOPE });
    ok(`⭐${label}:--tools "" 关掉全部内置工具,没有 --allowedTools/--add-dir/acceptEdits`,
       JSON.stringify(valuesOf(a, "--tools")) === '[""]' && !a.includes("--allowedTools") && !a.includes("--add-dir") && !a.includes("acceptEdits"),
       JSON.stringify(valuesOf(a, "--tools")));
    const deny = valuesOf(a, "--disallowedTools");
    ok(`${label}:仍显式拒绝写/联网工具并带路径拒绝规则,不加载 MCP,权限模式 dontAsk`,
       WRITE_OR_NET.every((t) => deny.includes(t)) && PATH_RULES.every((r) => deny.includes(r)) &&
       a.includes("--strict-mcp-config") && JSON.stringify(valuesOf(a, "--permission-mode")) === '["dontAsk"]');
    ok(`${label}:接着同一会话(--resume),提示词紧跟 -p`, a[0] === "-p" && JSON.stringify(valuesOf(a, "--resume")) === '["sid-fixture"]' &&
       (effort ? JSON.stringify(valuesOf(a, "--effort")) === '["low"]' : !a.includes("--effort")));
    // --disable-slash-commands 会连 /compact 一起关掉(2026-10-28 实测 init 的 slash_commands 变成 0 条),压缩不能加。
    ok(`⭐${label}:不读用户/项目/本地设置(--setting-sources ""),不加 --disable-slash-commands(会关掉 /compact)`,
       JSON.stringify(valuesOf(a, "--setting-sources")) === '[""]' && !a.includes("--disable-slash-commands"));
  }
}

console.log("\n[⑨ 路径拒绝规则与执行线(loops/verify_lib.py)等价]");
if (C) {
  const PY = [process.env.BOARD_PYTHON, process.env.PYTHON, "python", "py", "python3"].filter(Boolean).find((c) => {
    try { execFileSync(c, ["-c", "print(1)"], { stdio: "ignore", windowsHide: true }); return true; } catch { return false; }
  });
  ok("找到 Python 解释器(对照执行线的规则需要它)", !!PY);
  if (PY) {
    const homes = [...HOMES, "D:/私人登录/claude-prod", "E:\\另一处\\登录\\"];
    const paths = [DATA, REG, "D:\\私人登录\\x\\", "c:\\lower\\case", "relative\\dir"];
    const script = "import sys,json\nsys.path.insert(0,sys.argv[1])\nimport verify_lib as v\ns=json.loads(sys.argv[2])\n" +
      "print(json.dumps({'deny_path':[v.deny_path(p) for p in s['paths']],'auth':v.auth_home_deny_rules({'WORKER_AUTH_HOMES':json.dumps(s['homes'])}),'cli':v.cli_deny_rules(s['data'],s['registry'])}))";
    const py = JSON.parse(execFileSync(PY, ["-I", "-c", script, join(__dirname, "..", "loops"), JSON.stringify({ paths, homes, data: DATA, registry: REG })],
      { encoding: "utf8", windowsHide: true }));
    ok("⭐denyPath 与 verify_lib.deny_path 逐条相同", JSON.stringify(paths.map(C.denyPath)) === JSON.stringify(py.deny_path),
       JSON.stringify(paths.map(C.denyPath)) + " vs " + JSON.stringify(py.deny_path));
    ok("⭐认证目录规则与 verify_lib.auth_home_deny_rules 逐条相同(含去重、去尾斜杠)",
       JSON.stringify(C.authHomeDenyRules(homes)) === JSON.stringify(py.auth), JSON.stringify(C.authHomeDenyRules(homes)).slice(0, 200));
    const js = C.boardDenyRules(SCOPE);
    ok("登记簿两条与 verify_lib.cli_deny_rules 相同", py.cli.slice(-2).every((r) => js.includes(r)), JSON.stringify(py.cli.slice(-2)));
    const dataForm = C.denyPath(DATA);
    ok("⭐执行线的每条数据目录规则都被拆解器的整目录规则覆盖(拆解器不往数据目录写,不必逐文件留出件箱)",
       js.includes(`Read(${dataForm}/**)`) && js.includes(`Edit(${dataForm}/**)`) &&
       py.cli.slice(0, -2).every((r) => r.startsWith(`Read(${dataForm}/`) || r.startsWith(`Edit(${dataForm}/`)), String(py.cli.length));
    let threw = false; try { C.authHomeDenyRules(["relative/home"]); } catch { threw = true; }
    ok("认证目录不是绝对路径 → 抛错(未知值落拒绝侧,与 Python 的 ValueError 同口径)", threw);
  }
}

console.log("\n[⑩ server.mjs 确实用这些函数组装(源码形;server 一导入就监听,参数无法从外部观测)]");
{
  const srv = readFileSync(join(__dirname, "..", "core", "server.mjs"), "utf8");
  const cut = (from, to) => { const i = srv.indexOf(from); return i < 0 ? "" : srv.slice(i, srv.indexOf(to, i + from.length)); };
  const runCliSrc = cut("const runCli", "async function decomposeGoal");
  const decomposeSrc = cut("async function decomposeGoal", "function pipelineReview");
  const compactSrc = cut("async function compactLine", "function setSettings");
  ok("⭐runCli 的环境经 boardCliEnvironment 组装,不再整份展开 process.env",
     /boardCliEnvironment\(/.test(runCliSrc) && !/\.\.\.process\.env/.test(runCliSrc), runCliSrc.match(/env:[^\n]*/)?.[0] || "(无 env 行)");
  ok("⭐拆解经 decomposeCliArgs 组装参数、经 decomposePlanOf 取结果,不再出现 Write/acceptEdits/__dirname/结果文件",
     /runCli\(decomposeCliArgs\(/.test(decomposeSrc) && /decomposePlanOf\(/.test(decomposeSrc) &&
     !/"Write"|acceptEdits|__dirname|readFileSync\(out/.test(decomposeSrc));
  ok("⭐压缩的两次调用都经 compactCliArgs 组装", (compactSrc.match(/runCli\(compactCliArgs\(/g) || []).length === 2);
  const calls = srv.match(/runCli\([^)]{0,40}/g) || [];
  ok("server 里每个 runCli 调用点都经组装函数(没有手写参数数组)",
     calls.length >= 3 && calls.filter((c) => !/^runCli\((?:decomposeCliArgs|compactCliArgs)\(/.test(c) && !/^runCli\(args/.test(c)).length === 0, calls.join(" | "));
  ok("直接执行 CLAUDE_CLI 的只有 runCli 一处", (srv.match(/execFile\(CLAUDE_CLI/g) || []).length === 1);
  // dontAsk 下 cwd 与 --add-dir 范围内的读取不需要放行规则(spike P2/P4):cwd 若继承 server 的工作目录
  // (可能是用户主目录),那里就整片可读。所以 cwd 固定为看板进程自建的空目录。
  const cwdSrc = cut("const boardCliCwd", "\n}");
  ok("⭐runCli 的 cwd 是看板自建的空目录(boardCliCwd:mkdtemp 于系统临时目录),不继承 server 的工作目录",
     /cwd: boardCliCwd\(\)/.test(runCliSrc) && /mkdtempSync\(join\(tmpdir\(\)/.test(cwdSrc), cwdSrc.slice(0, 120) || "(没有 boardCliCwd)");
}

console.log(`\n${"─".repeat(56)}\nresult: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
