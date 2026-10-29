import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../core/panel.html", import.meta.url), "utf8");
const start = source.indexOf("// ── display-copy(pure;tests/panelcopytest.mjs)──");
const end = source.indexOf("// ── /display-copy ──", start);
assert.ok(start >= 0 && end > start, "未找到纯展示文案测试边界");
const copy = new Function(source.slice(source.indexOf("\n", start) + 1, end) +
  "\nreturn { copyLabel, routeLabel, copyError, formatCount };")();

function panelSection(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `未找到面板测试边界：${start}`);
  return source.slice(a, b);
}
const readinessSource = panelSection("// ── runtime-readiness(pure;tests/panelcopytest.mjs) ──", "// ── /runtime-readiness ──");
const profileSource = panelSection("// ── execution-profile-copy(pure;tests/panelcopytest.mjs) ──", "// ── /execution-profile-copy ──");
const readiness = new Function(readinessSource + "\nreturn { runtimeReadiness, runtimeProbeKey };")();
const profileCopy = new Function(profileSource + "\nreturn {executionChannelName,executionAuthName,executionBillingName,executionBudgetText,taskExecutionChoices};")();

test("枚举按调用者语义域显示，未知值和原型键只使用中文兜底", () => {
  const delivery = Object.freeze({ accepted: "已接收", ready: "接收准备就绪" });
  const acceptance = Object.freeze({ accepted: "已验收", ready: "可提交验收" });
  assert.equal(copy.copyLabel(delivery, "accepted"), "已接收");
  assert.equal(copy.copyLabel(acceptance, "accepted"), "已验收");
  assert.equal(copy.copyLabel(delivery, "ready"), "接收准备就绪");
  assert.equal(copy.copyLabel(acceptance, "ready"), "可提交验收");
  for (const value of ["future_state", "constructor", "toString", "hasOwnProperty", "__proto__"])
    assert.equal(copy.copyLabel(delivery, value), "状态待核实", value);
  assert.equal(copy.copyLabel(delivery, "future_state", "其他操作"), "其他操作");
  assert.equal(copy.copyLabel(Object.create({ ready: "继承值不应显示" }), "ready"), "状态待核实");
});

test("路由显示与协议值分离，自定义配置和用户原文不改写", () => {
  assert.equal(copy.routeLabel("default"), "默认");
  for (const name of ["claude", "codex", "zcode"])
    assert.match(copy.routeLabel(name), new RegExp(name, "i"));
  const input = Object.freeze({ route: "Team-A / 自定义执行线", state: "future_state", note: "User text：保留原文" });
  const before = JSON.stringify(input);
  assert.equal(copy.routeLabel(input.route), input.route);
  assert.equal(copy.copyLabel({ ready: "已准备" }, input.state), "状态待核实");
  assert.equal(JSON.stringify(input), before);
});

test("用量显示使用中文计数单位，不改变计数值", () => {
  for (const [number, label] of [[0, "0"], [999, "999"], [1250, "1.3千"], [25000, "2.5万"], [2500000, "250.0万"], [200000000, "2.0亿"]]) {
    assert.equal(copy.formatCount(number), label);
    assert.equal(typeof number, "number");
  }
  // 推理强度改为分段控件(单选组):每一档的可见文字与无障碍名称都走 effortName;选中后标题里的当前档同步换成中文。
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /aria-label="\$\{esc\(effortName\(v\)\)\}"><span>\$\{esc\(effortName\(v\)\)\}<\/span>/);
  assert.ok(source.includes('const b = el.closest(".agent").querySelector(".cap b"); if (b) b.textContent = effortName(a.effort);'));
});

test("浏览器错误使用中文说明，中文消息及未知原始错误完整保留", () => {
  for (const error of [new TypeError("Failed to fetch"),
    Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
    new SyntaxError("Unexpected token '<', invalid JSON")]) {
    const message = copy.copyError(error);
    assert.match(message, /[\u3400-\u9fff]/, error.message);
    assert.notEqual(message, error.message);
  }
  const chinese = "任务版本已改变，请刷新后重新核对。";
  assert.equal(copy.copyError(new Error(chinese)), chinese);
  const original = "backend policy denied custom action";
  const error = new Error(original), displayed = copy.copyError(error);
  assert.match(displayed, /[\u3400-\u9fff]/);
  assert.ok(displayed.includes(original), "未知错误的原始信息必须保留，不能用泛化中文掩盖原因");
  assert.equal(error.message, original);
});

test("业务错误中的超时字样不是浏览器异常，不能掩盖原始原因", () => {
  const message = '未知的 handoff 目标 "timeout"';
  assert.equal(copy.copyError(message), message);
  assert.equal(copy.copyError(new Error(message)), message);
  for (const original of ['unknown target "timeout"', 'file network request failed.txt missing', 'backend: unexpected token in source'])
    assert.equal(copy.copyError(new Error(original)), "操作未完成。原始信息：" + original);
});

test("内置界面不再混用旧英文提示，不误判注释、样式类或机器字段", () => {
  // 仅检查已知内置展示位置；recommended 类名、worker 标识等不属于漏译。
  const display = source.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(display, />\s*Final ruling\s*</);
  assert.doesNotMatch(display, /ev\("ev",\s*"evidence\s*\/\s*reason"/);
  assert.doesNotMatch(display, />\s*recommended(?:\s*:|\s*<)/i);
  assert.doesNotMatch(display, /(?:title|placeholder|aria-label)="[^"\n]*原 Agent[^"\n]*"/);
  assert.doesNotMatch(display, />[^<>\n]*worker 守则[^<>\n]*</);
  assert.doesNotMatch(display, /["`][^"`\n]*(?:交回原 Agent|装 worker 守则)[^"`\n]*["`]/);
});

test("新建任务、加线与时间轴控件具有明确中文无障碍名称", () => {
  const labels = {
    "home-new-title": "任务标题", "home-new-desc": "任务说明",
    "line-add-label": "执行线显示名称", "line-add-id": "执行线标识", "line-add-hint": "执行线用途",
    "tl-date": "时间轴日期", "tl-prev": "上一天", "tl-next": "下一天",
  };
  for (const [id, name] of Object.entries(labels)) {
    const tag = [...source.matchAll(/<(?:input|textarea|button)\b[^>]*>/g)]
      .map((match) => match[0]).find((value) => value.includes(`id="${id}"`));
    assert.ok(tag, id);
    assert.ok(tag.includes(`aria-label="${name}"`) || tag.includes(`aria-label='${name}'`), id);
  }
});

test("本批文案调整保留 ef2ad8f 的原 Kanban 暖色变量", () => {
  const palettes = [...source.matchAll(/:root\s*\{([^}]+)\}/g)]
    .map((match) => Object.fromEntries([...match[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)]
      .map((entry) => [entry[1], entry[2].toLowerCase()])));
  assert.deepEqual(palettes, [
    { bg: "#f7f2e8", panel: "#fffcf6", panel2: "#f1e9dc", line: "#ddcfbb", fg: "#332b23",
      dim: "#756652", dim2: "#726451", accent: "#9b530b", cc: "#80572c", l0: "#936544",
      ok: "#396a4c", warn: "#7f5d0e", bad: "#b74332" },
    { bg: "#1e1a16", panel: "#27211c", panel2: "#312920", line: "#574737", fg: "#f4eadb",
      dim: "#c2b19a", dim2: "#a7957d", accent: "#e7ab5c", cc: "#c99760", l0: "#cfb18b",
      ok: "#8db394", warn: "#d7b765", bad: "#f08a77" },
  ]);
});

test("执行器安装、配置和启用各自按事实显示，接入检查不能替代真实任务", () => {
  const agent = { runtime: "codex", model: "allowed-model", effort: "high" };
  const unknown = readiness.runtimeReadiness({}, agent);
  assert.deepEqual([unknown.installation, unknown.configured, unknown.enabled, unknown.realTask],
    ["待核实", "待核实", "待核实", "待核实"]);
  const seat = { disabled: true, readiness: { installation: "available", command_configured: false, enabled: false } };
  const locked = readiness.runtimeReadiness(seat, agent);
  assert.deepEqual([locked.installation, locked.configured, locked.enabled, locked.realTask],
    ["已检测", "待配置", "未启用", "待核实"]);
  assert.match(locked.next, /本机配置 CLI/);
  const failed = readiness.runtimeReadiness({ disabled: false }, agent, { state: "failed" });
  assert.equal(failed.installation, "待核实", "门禁或参数失败不能推出未安装");
  assert.match(failed.next, /接入检查未通过/);
  const passed = readiness.runtimeReadiness({ disabled: false }, agent, { state: "passed" });
  assert.equal(passed.installation, "已检测");
  assert.equal(passed.configured, "待核实", "探测不能替服务端断言配置状态");
  assert.equal(passed.realTask, "待核实", "无模型调用的检查不是真实任务验证");
  assert.equal(readiness.runtimeReadiness({ readiness: { installation: "unavailable" } }, agent).installation, "未找到 CLI");
});

test("真实任务状态只认同一执行器、模型和强度的受管结果回传", () => {
  const agent = { runtime: "codex", model: "allowed-model", effort: "high" };
  const result = { ...agent, state: "result_returned", source: "worker_loop", task_id: 42, observed_at: "2026-10-23T00:00:00Z" };
  const displayed = readiness.runtimeReadiness({ disabled: false, readiness: { installation: "available", command_configured: true } }, agent, null, [result]);
  assert.equal(displayed.realTask, "已回传结果（任务 #42）");
  assert.match(displayed.next, /不代表人工验收或当前登录有效/);
  for (const mismatch of [{ runtime: "claude" }, { model: "other-model" }, { effort: "low" },
    { state: "claimed" }, { source: "fixture" }, { task_id: null }, { task_id: -1 }]) {
    assert.equal(readiness.runtimeReadiness({}, agent, null, [{ ...result, ...mismatch }]).realTask, "待核实", JSON.stringify(mismatch));
  }
  assert.equal(readiness.runtimeReadiness({}, { ...agent, model: "new-model" }, null, [result]).realTask, "待核实");
});

test("原设置弹层展示接入事实但保留原模型值域、权限禁用和 CAS 保存", () => {
  const agents = [{ runtime: "codex", model: "allowed-model", effort: "high", window: false }];
  const before = JSON.stringify(agents);
  const cfg = { innerHTML: "", style: {}, classList: { add() {} } };
  const context = vm.createContext({
    workers: [{ line: "work", running: false, desired_running: false, settings: { agents, rev: 7 } }],
    RUNTIMES: [{ id: "codex", label: "Codex CLI", disabled: true,
      models: [{ id: "allowed-model", label: "允许的模型" }], efforts: ["high"],
      readiness: { installation: "available", command_configured: true, enabled: false } }],
    MODELS: [], EFFORTS: ["high"], EXECUTION_PROFILES: [], cfgAgents: agents, cfgProbes: new Map(), cfgLine: "work", cfgReadiness: null,
    cfgSingle: false, cfgLegacy: false, MAXP: 1, cfg, cfgAnchor: { getBoundingClientRect: () => ({ left: 400, bottom: 200 }) },
    innerWidth: 1280, esc: (value) => String(value), lineColor: () => "var(--cc)", lineLabel: () => "任务执行线",
    effortName: () => "高",
  });
  vm.runInContext(readinessSource + "\n" + profileSource + "\n" + panelSection("function renderCfg(){", "async function probeCfgAgent("), context);
  context.renderCfg();
  assert.match(cfg.innerHTML, /执行线：已停止/);
  assert.match(cfg.innerHTML, /<dt>启用<\/dt><dd[^>]*>未启用<\/dd>/);
  assert.match(cfg.innerHTML, /<dt>真实任务<\/dt><dd>待核实<\/dd>/);
  assert.match(cfg.innerHTML, /value="codex" selected disabled/);
  assert.match(cfg.innerHTML, /value="allowed-model" selected/);
  assert.match(cfg.innerHTML, /检查接入（不调用模型）/);
  assert.match(cfg.innerHTML, /不领取任务、不验证登录，也不调用模型/);
  assert.equal(JSON.stringify(agents), before);
  assert.ok(source.includes('post(`/api/workers/${cfgLine}/settings`, { agents: cfgAgents, rev: cfgRev })'));
  const addedStyles = source.slice(source.indexOf('#cfg .runtime-state{'), source.indexOf('#cfg #cfg-add{'));
  assert.ok(addedStyles.includes('font-size:var(--fs-sm)'), '新增中文状态沿用至少12px的字号变量');
  assert.doesNotMatch(addedStyles, /(?:font-size|gap|padding|margin):[^}]*\d+(?:px|rem)/, '新增展示复用字号与间距变量');
  assert.match(source, /cfgProbes\.clear\(\)/, '重新打开不沿用旧探测状态');
});

function readinessFixture(handler) {
  const calls = []; let renders = 0;
  const context = vm.createContext({
    cfgAgents: [{ runtime: "codex", model: "allowed-model", effort: "high" }], cfgRev: 7,
    cfgLine: "work", cfgReadinessRequest: 4, cfgReadiness: null,
    RUNTIMES: [{ id: "codex", disabled: true, models: [{ id: "allowed-model" }] }],
    workers: [{ line: "work", settings: { agents: [{ runtime: "codex", model: "saved-model" }], rev: 7 } }],
    cfg: { classList: { contains: () => true } }, renderCfg: () => { renders++; }, copyError: copy.copyError,
    fetch: async (path) => { calls.push(path); return { ok: true, json: async () => handler() }; },
  });
  vm.runInContext(panelSection("async function loadCfgReadiness(", "function effortName("), context);
  return { context, calls, renders: () => renders };
}

test("打开原设置时才读取一次事实，不覆盖智能体草稿、模型值域和 CAS 版本", async () => {
  const result = { runtime: "codex", model: "allowed-model", effort: "high", state: "result_returned", source: "worker_loop", task_id: 42 };
  const f = readinessFixture(() => ({
    runtimes: [{ id: "codex", disabled: false, models: [{ id: "not-allowed" }],
      readiness: { installation: "available", command_configured: true, enabled: true } }],
    workers: [{ line: "work", settings: { agents: [], rev: 99 }, runtime_verifications: [result] }],
  }));
  const before = JSON.stringify(f.context.cfgAgents), models = JSON.stringify(f.context.RUNTIMES[0].models);
  await f.context.loadCfgReadiness("work", before, 4);
  assert.deepEqual(f.calls, ["/api/workers?readiness=1"]);
  assert.equal(JSON.stringify(f.context.cfgAgents), before);
  assert.equal(f.context.cfgRev, 7);
  assert.equal(f.context.workers[0].settings.rev, 7);
  assert.equal(JSON.stringify(f.context.RUNTIMES[0].models), models);
  assert.equal(f.context.RUNTIMES[0].disabled, true, "事实读取不改选择许可");
  assert.equal(f.context.workers[0].runtime_verifications[0].task_id, 42);
  assert.equal(f.context.cfgReadiness.state, "loaded");
  assert.equal(f.context.cfgReadiness.verifications[0].task_id, 42);
  assert.equal(f.renders(), 1);
  assert.ok(source.includes("loadCfgReadiness(line, JSON.stringify(cfgAgents), ++cfgReadinessRequest)"));
});

test("切换执行线或配置后，迟到的接入事实不覆盖当前设置", async () => {
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const f = readinessFixture(() => pending), before = JSON.stringify(f.context.cfgAgents);
  const read = f.context.loadCfgReadiness("work", before, 4);
  f.context.cfgAgents[0].model = "new-model";
  complete({ runtimes: [{ id: "codex", readiness: { installation: "available" } }], workers: [] });
  await read;
  assert.equal(f.context.cfgReadiness.state, "stale");
  assert.equal(f.context.RUNTIMES[0].readiness, undefined);
  assert.equal(f.context.cfgAgents[0].model, "new-model");
  const other = readinessFixture(() => ({ runtimes: [], workers: [] }));
  other.context.cfgLine = "other-line";
  await other.context.loadCfgReadiness("work", JSON.stringify(other.context.cfgAgents), 4);
  assert.equal(other.context.cfgReadiness, null);
  assert.equal(other.renders(), 0);
});

function probeFixture(handler) {
  const calls = [], probes = new Map(); let renders = 0;
  const context = vm.createContext({
    cfgAgents: [{ runtime: "codex", model: "allowed-model", effort: "high" }], cfgLine: "work", cfgProbes: probes,
    cfg: { classList: { contains: () => true } }, renderCfg: () => { renders++; },
    copyError: copy.copyError, post: async (path, body) => { calls.push({ path, body: JSON.parse(JSON.stringify(body)) }); return handler(path, body); },
  });
  vm.runInContext(readinessSource + "\n" + panelSection("async function probeCfgAgent(", "/** Save ="), context);
  return { context, calls, probes, renders: () => renders };
}

test("设置接入检查只复用 non-live 探测，不保存设置、不启动或领取任务", async () => {
  const f = probeFixture(async () => ({ ok: true, live: false, out: "synthetic CLI diagnostic", err: "" }));
  await f.context.probeCfgAgent(0);
  assert.deepEqual(f.calls, [{ path: "/api/workers/work/probe-runtime", body: {
    runtime: "codex", model: "allowed-model", effort: "high", live: false, timeout_ms: 30_000,
  } }]);
  const probe = [...f.probes.values()][0];
  assert.equal(probe.state, "passed");
  assert.match(probe.detail, /未调用模型/);
  assert.equal(readiness.runtimeReadiness({}, f.context.cfgAgents[0], probe).realTask, "待核实");
  assert.equal(f.renders(), 2);
});

test("旧配置的接入检查不覆盖新配置，失败诊断保留原始原因", async () => {
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const f = probeFixture(() => pending);
  const first = f.context.probeCfgAgent(0);
  await f.context.probeCfgAgent(0);
  assert.equal(f.calls.length, 1, "同一配置的检查未完成时不重复派发");
  f.context.cfgAgents[0].model = "new-model";
  complete({ ok: false, live: false, out: "synthetic gate failed", err: "version mismatch" });
  await first;
  assert.equal(f.probes.get(readiness.runtimeProbeKey("work", f.context.cfgAgents[0])), undefined);
  const old = [...f.probes.values()][0];
  assert.equal(old.state, "failed");
  assert.match(old.detail, /不据此推断是否已安装/);
  assert.match(old.detail, /synthetic gate failed\nversion mismatch/);
  const failed = probeFixture(async () => { throw new Error("backend policy denied custom action"); });
  await failed.context.probeCfgAgent(0);
  assert.match([...failed.probes.values()][0].detail, /backend policy denied custom action/);
});

test("四通道文案区分订阅与 API 计费，不把促销或未知预算写成已验证", () => {
  assert.equal(profileCopy.executionChannelName("claude_agent_sdk"), "Claude API（Agent SDK）");
  assert.equal(profileCopy.executionChannelName("codex_sdk_api"), "GPT API（Codex SDK）");
  assert.equal(profileCopy.executionAuthName("api_key"), "独立 API 凭据");
  assert.match(profileCopy.executionBillingName("anthropic_api"), /促销归属待账单确认/);
  for (const value of ["constructor", "toString", "unknown"])
    assert.match(profileCopy.executionChannelName(value), /待核实/);
  assert.match(profileCopy.executionBudgetText(null), /待你确认/);
  assert.match(profileCopy.executionBudgetText({ max_cost_usd: 0, timeout_sec: 120, max_turns: 2 }), /不能派发/);
  const budget = profileCopy.executionBudgetText({ max_cost_usd: 0.5, timeout_sec: 120, max_turns: 2 }, "provider_spend_limit_required");
  assert.match(budget, /供应商项目花费限制/); assert.match(budget, /本机不提供金额硬封顶/);
  assert.match(budget, /工具步骤预算 2/); assert.doesNotMatch(budget, /最多 2 轮/);
  const cliBudget = profileCopy.executionBudgetText({ max_cost_usd: 0.5, timeout_sec: 120, max_turns: 4 }, "cli_timeout_only");
  assert.match(cliBudget, /内部轮次与金额上限无法强制/); assert.match(cliBudget, /不能视为已满足 4 轮授权/);
});

test("新任务只选择当前执行线已配置组合，显式配置必须先核对再放行", () => {
  const rows = [{ line: "work", settings: { agents: [
    { runtime: "claude", model: "allowed", effort: "high", execution_profile_id: "claude-api" },
    { runtime: "claude", model: "allowed", effort: "high", execution_profile_id: "claude-api" },
    { runtime: "codex", model: "allowed-gpt", effort: "low", execution_profile_id: "gpt-api" },
  ] } }, { line: "other", settings: { agents: [{ runtime: "codex", model: "foreign", effort: "low", execution_profile_id: "foreign" }] } }];
  const choices = profileCopy.taskExecutionChoices("work", rows);
  assert.equal(choices.length, 2); assert.ok(choices.every((c) => c.model !== "foreign"));
  const build = new Function(profileSource + "\n" + panelSection("function newTaskBody(", "/** 只展示当前可见列表") + "\nreturn newTaskBody;")();
  const cfg = { lines: ["work"], choices }, input = { title: " 样本 ", line: "work", execution_profile_id: "claude-api", model: "allowed", effort: "high" };
  assert.deepEqual(build(input, cfg), { body: { subject: "样本", description: "", line: "work", execution_profile_id: "claude-api", model: "allowed", effort: "high", released: false } });
  for (const mismatch of [{ execution_profile_id: "foreign" }, { model: "foreign" }, { effort: "max" }])
    assert.match(build({ ...input, ...mismatch }, cfg).error, /当前执行线已配置/);
  assert.deepEqual(build({ title: "旧卡", line: "work" }, cfg), { body: { subject: "旧卡", description: "", line: "work" } });
});

test("同名模型的 CLI 与 API 回传和探测互不冒认", async () => {
  const api = { runtime: "claude", model: "same", effort: "high", execution_profile_id: "claude-api" };
  const event = { ...api, task_id: 9, state: "result_returned", source: "worker_loop" };
  assert.match(readiness.runtimeReadiness({}, api, null, [{ ...event, execution_profile_id: undefined }]).realTask, /待核实/);
  assert.match(readiness.runtimeReadiness({}, { ...api, execution_profile_id: "claude-cli" }, null, [event]).realTask, /待核实/);
  assert.equal(readiness.runtimeReadiness({}, api, null, [event]).realTask, "已回传结果（任务 #9）");
  assert.notEqual(readiness.runtimeProbeKey("work", api), readiness.runtimeProbeKey("work", { ...api, execution_profile_id: "claude-cli" }));
  const f = probeFixture(async () => ({ ok: true, live: false }));
  f.context.cfgAgents[0].execution_profile_id = "gpt-api";
  await f.context.probeCfgAgent(0);
  assert.equal(f.calls[0].body.execution_profile_id, "gpt-api"); assert.equal(f.calls[0].body.live, false);
});

test("API 配置沿用原设置及模型声明，不受 CLI 订阅闸误禁也不解禁 CLI", () => {
  const agent = { runtime: "codex", model: "declared", effort: "high", window: false, execution_profile_id: "gpt-api" };
  const profile = { id: "gpt-api", label: "GPT API", runtime: "codex", channel: "codex_sdk_api", auth_kind: "api_key", billing_kind: "openai_api", enabled: false, configured: false, ready: false, budget: null, reason: "预算和凭据尚未准备" };
  const context = vm.createContext({
    workers: [{ line: "work", settings: { agents: [agent], rev: 3 } }], cfgLine: "work", cfgAgents: [agent], cfgReadiness: null, cfgProbes: new Map(),
    EXECUTION_PROFILES: [profile], RUNTIMES: [{ id: "codex", label: "Codex CLI", disabled: true, models: [{ id: "declared", label: "允许模型" }], efforts: ["high"] }], MODELS: [], EFFORTS: ["high"],
    cfgSingle: false, cfgLegacy: false, MAXP: 1, cfg: { innerHTML: "", style: {}, classList: { add() {} } }, cfgAnchor: { getBoundingClientRect: () => ({ left: 300, bottom: 200 }) }, innerWidth: 1280,
    esc: String, lineColor: () => "var(--cc)", lineLabel: () => "试用线", effortName: () => "高",
  });
  vm.runInContext(readinessSource + "\n" + profileSource + "\n" + panelSection("function renderCfg(){", "async function probeCfgAgent("), context);
  context.renderCfg();
  assert.match(context.cfg.innerHTML, /value="gpt-api" selected/);
  assert.match(context.cfg.innerHTML, /value="codex" selected>/, "API 不继承 CLI 订阅解禁状态");
  assert.match(context.cfg.innerHTML, /value="declared" selected/);
  assert.match(context.cfg.innerHTML, /预算和凭据尚未准备/);
  assert.match(context.cfg.innerHTML, /待你确认金额、时限和轮次/);
  assert.equal(context.RUNTIME_IDS, undefined); assert.equal(context.RUNTIMES[0].disabled, true);
  assert.equal(agent.execution_profile_id, "gpt-api");
});

test("侧栏显示固定执行快照和模型活动，放行只复用原接口与两押版本保护", () => {
  class Element {
    constructor(tag, text) { this.tag = tag; this.text = text || ""; this.children = []; this.dataset = {}; }
    append(...nodes) { this.children.push(...nodes); }
    get textContent() { return this.text + this.children.map((n) => n.textContent).join(""); }
  }
  const context = vm.createContext({ homeEl: (tag, text) => new Element(tag, text), localTime: (value) => value, effortName: () => "高" });
  vm.runInContext(profileSource + "\n" + panelSection("function sideExecution(t){", "function sideRelationshipBox(t){"), context);
  const card = { id: 4, status: "not_started", released: false, aggregate_version: 7, execution_profile: {
    execution_profile_id: "claude-api", profile_digest: "a".repeat(64), configuration_changed: true, label: "API 样本", channel: "claude_agent_sdk", auth_kind: "api_key", billing_kind: "anthropic_api", model: "allowed", effort: "high", tools: "write", budget: null, workspace: { path: "C:/隔离/中文 工作仓" },
  } };
  const section = context.sideExecution(card), button = section.children.find((n) => n.tag === "button");
  assert.match(section.textContent, /C:\/隔离\/中文 工作仓/); assert.match(section.textContent, /Claude API（Agent SDK）/);
  assert.match(section.textContent, /促销归属待账单确认/); assert.match(section.textContent, /待你确认/);
  assert.match(section.textContent, /allowed · 高/);
  assert.equal(button.dataset.a, "release"); assert.equal(button.dataset.version, "7");
  assert.equal(button.dataset.executionProfileDigest, "a".repeat(64), "确认摘要来自正在显示的卡片，不从其他设置取值");
  assert.match(section.textContent, /放行前核对执行配置/); assert.match(section.textContent, /第二次确认不会自动接受另一份配置/);
  const withoutDigest = context.sideExecution({ ...card, execution_profile: { ...card.execution_profile, profile_digest: null } });
  assert.equal(withoutDigest.children.find((n) => n.tag === "button").disabled, true, "缺少摘要不能放行");
  assert.equal(context.sideExecution({ ...card, execution_profile: undefined }).children.some((n) => n.tag === "button"), false, "旧卡不新增放行路径");
  const active = context.sideExecution({ ...card, status: "in_progress", run_id: "run", execution_trace: { run_id: "run", model_activity_at: "2026-10-27T00:00:00Z" } });
  assert.match(active.textContent, /最近模型活动/); assert.match(active.textContent, /进程、心跳和输出不等于有效工作/);
  assert.ok(source.includes('a === "archive" || a === "release") && b.dataset.armed !== "1"'));
  assert.ok(source.includes('released: true, expected_version: Number(b.dataset.version)'));
  assert.ok(source.includes('confirm_execution_profile_digest: b.dataset.executionProfileDigest'), "两押提交原按钮绑定的摘要，配置变化不静默确认");
});

test("写了指示的卡按放行状态显示：未放行说明须放行后再跑，已放行保留原文案", () => {
  // 直接执行卡片里这一段徽标代码，不另抄一份判断。
  const badge = new Function("t", "meta2", panelSection('  if ((t.last_verdict || t.verdict) && t.status === "not_started")', "  // ⭐ Human-gated") +
    '\nreturn meta2.join("");');
  const card = { last_verdict: "reject", status: "not_started" };
  assert.equal(badge({ ...card, released: 0 }, []), '<span class="tag tocoord">你写了指示 · 已退回原线，放行后才会再跑</span>');
  assert.equal(badge({ ...card, released: 1 }, []), '<span class="tag tocoord">你写了指示 · 回原线继续</span>');
  assert.equal(badge({ ...card, released: 1, status: "waiting" }, []), "", "显示条件不变：不在未开始状态不出徽标");
});

test("方案确认提示：执行失败会退回原线，显式执行配置卡补取消放行一句，普通卡一字不变", () => {
  // 直接执行面板里的 syncDecision 和同一个常量，不另抄判断；scope 只给提示框和回执框两个替身。
  const syncDecision = (draft) => new Function("decisionChoice", "outcomeDraft", "receiptDraft",
    panelSection("const PROFILE_RELEASE_NOTE", "\n") + "\n" +
    panelSection("function syncDecision(scope, t){", "\nfunction upsert(") + "\nreturn syncDecision;")(...draft);
  const hint = (card, outcome) => {
    const h = { textContent: "" }, receipt = { value: "原始回执" };
    const scope = {
      querySelector: (sel) => sel === "[data-hoh]" ? h : sel === `[data-handoff-receipt="${card.id}"]` ? receipt : null,
      querySelectorAll: () => [],
    };
    syncDecision([new Map([[card.id, "A"]]), new Map([[card.id, outcome]]), new Map([[card.id, "原始回执"]])])(scope, card);
    return h.textContent;
  };
  const card = { id: 7, decision_package: { options: [{ key: "A", kind: "apply", ready: true }] } };
  const profile = { execution_profile: { profile_digest: "a".repeat(64) } };
  const note = "显式执行配置卡会同时取消放行，你重新核对放行后才会再次计费运行。";
  const failed = "本次会记录为已尝试执行但失败：保留错误回执、把本轮文件归档到交接目录，并交回原智能体修正；不会冒充已应用。";
  assert.equal(hint(card, "failure"), failed, "普通卡文案不变");
  assert.equal(hint({ ...card, ...profile }, "failure"), failed + note);
  // 执行成功只在服务端判定退回原线(confirm_destination=hand_back)时补；留在等待中交复核的不补。
  // 文案也按同一去向说：留在等待中的不说交回原智能体；拿不到去向时不猜，也不补取消放行。
  const succeeded = "本次会记录为执行成功：保留回执、把文件归档到交接目录，并交回原智能体做结果验证。";
  const held = "本次会记录为执行成功：保留回执、把文件归档到交接目录；卡留在等待中，等你复核结果，原智能体不会接手。";
  const unknown = "本次会记录为执行成功：保留回执、把文件归档到交接目录；卡的后续去向由服务端判定，提交后以卡片状态为准。";
  assert.equal(hint({ ...card, ...profile, confirm_destination: "hold_for_review" }, "success"), held);
  assert.equal(hint({ ...card, confirm_destination: "hold_for_review" }, "success"), held, "普通卡同样留在等待中");
  for (const c of [card, { ...card, ...profile }])
    assert.ok(!hint({ ...c, confirm_destination: "hold_for_review" }, "success").includes("交回原智能体"),
      "留在等待中的卡不交回原智能体，提示不能这样说");
  assert.equal(hint({ ...card, ...profile, confirm_destination: "hand_back" }, "success"), succeeded + note);
  assert.equal(hint({ ...card, confirm_destination: "hand_back" }, "success"), succeeded, "普通卡文案不变");
  // 旧服务端不给 confirm_destination；null 或不认识的值同样只给中性说法。
  for (const dest of [undefined, null, "close"]) {
    const text = hint({ ...card, ...profile, ...(dest === undefined ? {} : { confirm_destination: dest }) }, "success");
    assert.equal(text, unknown, String(dest));
    assert.ok(!text.includes(note), "去向未知不补取消放行：" + String(dest));
  }
});

test("方案弹窗「执行成功」小字按服务端去向写，拿不到去向时用中性说法", () => {
  // 直接执行面板里的 openDecisionModal，只换掉 DOM 与周边函数，看它实际写出的小字。
  const small = (t) => {
    const box = { innerHTML: "", querySelector: () => null };
    const context = { draftVersions: new Map(), decisionSnapshot: null, structuredClone,
      document: { getElementById: (id) => id === "decision-modal-b" ? box : { textContent: "" } },
      decisionPanel: () => "", verdictDraft: new Map(), receiptDraft: new Map(), syncHandoff() {},
      decisionModal: { querySelector: () => null, classList: { add() {} } } };
    vm.createContext(context);
    vm.runInContext(panelSection("function openDecisionModal(t){", '\ndocument.addEventListener("dblclick"'), context);
    context.openDecisionModal({ id: 7, aggregate_version: 1, subject: "s", ...t });
    const m = box.innerHTML.match(/<span>执行成功<small>([^<]*)<\/small><\/span>/);
    assert.ok(m, "未找到执行成功选项");
    return m[1];
  };
  assert.equal(small({ confirm_destination: "hold_for_review" }), "已应用;留在等待中,等你复核结果");
  assert.ok(!small({ confirm_destination: "hold_for_review" }).includes("交回"), "留在等待中的卡不说交回智能体");
  assert.equal(small({ confirm_destination: "hand_back" }), "已应用;交回智能体做结果验证");
  for (const t of [{}, { confirm_destination: null }, { confirm_destination: "close" }])
    assert.equal(small(t), "已应用;后续去向由服务端判定", JSON.stringify(t));
});

test("回执区句末与补充指示框按执行结果和服务端去向说：留在等待中不说交回原智能体，退回原线保留原句，去向未知用中性说法", () => {
  // 直接执行面板里的 syncDecision 与同段的 receiptFateNote，不另抄判断；scope 只给回执去向、补充指示框和提示框替身。
  const syncDecision = new Function("decisionChoice", "outcomeDraft", "receiptDraft",
    panelSection("const PROFILE_RELEASE_NOTE", "\n") + "\n" +
    panelSection("function syncDecision(scope, t){", "\nfunction upsert(") + "\nreturn syncDecision;");
  const run = (card, outcome, pick = "A") => {
    const fate = { textContent: "" }, vin = { placeholder: "" };
    const nodes = { [`[data-receipt-fate="${card.id}"]`]: fate, [`[data-vin="${card.id}"]`]: vin,
      "[data-hoh]": { textContent: "" }, [`[data-handoff-receipt="${card.id}"]`]: { value: "原始回执" } };
    const scope = { querySelector: (sel) => nodes[sel] ?? null, querySelectorAll: () => [] };
    syncDecision(new Map([[card.id, pick]]), new Map(outcome ? [[card.id, outcome]] : []),
      new Map([[card.id, "原始回执"]]))(scope, card);
    return { fate: fate.textContent, vin: vin.placeholder };
  };
  const card = { id: 7, decision_package: { options: [
    { key: "A", kind: "apply", ready: true }, { key: "B", kind: "none" }, { key: "C", kind: "apply", ready: false }] } };
  const back = "回执会逐字交回原智能体。", vinBack = "可选:补充给原智能体的一句指示";
  const held = "回执原文留在卡上,供你复核,原智能体不会接手。";
  const unknown = "回执的后续去向由服务端判定,提交后以卡片状态为准。";
  const hold = { ...card, confirm_destination: "hold_for_review" }, handBack = { ...card, confirm_destination: "hand_back" };
  // 执行成功 × hold_for_review：卡留在等待中，回执留在卡上供复核，不交回原智能体。
  assert.equal(run(hold, "success").fate, held);
  assert.ok(!run(hold, "success").fate.includes("交回原智能体"), "留在等待中的卡不交回原智能体，回执去向不能这样说");
  assert.equal(run(hold, "success").vin, "可选:补充一句说明,随回执留在卡上供你复核");
  assert.ok(!run(hold, "success").vin.includes("原智能体"), "留在等待中的卡，补充指示也到不了原智能体");
  // 执行成功 × hand_back，以及执行失败(服务端一律退回原线)：保留原句。
  assert.deepEqual(run(handBack, "success"), { fate: back, vin: vinBack });
  for (const c of [hold, handBack, card])
    assert.deepEqual(run(c, "failure"), { fate: back, vin: vinBack }, "执行失败一律退回原线：" + String(c.confirm_destination));
  // 旧服务端不给 confirm_destination；null 或不认识的值同样只给中性说法，不说交回、也不说留在卡上。
  for (const dest of [undefined, null, "close"]) {
    const r = run({ ...card, ...(dest === undefined ? {} : { confirm_destination: dest }) }, "success");
    assert.equal(r.fate, unknown, String(dest));
    assert.ok(!r.fate.includes("交回原智能体") && !r.fate.includes("留在卡上"), "去向未知不猜：" + String(dest));
    assert.equal(r.vin, "可选:补充一句说明", String(dest));
  }
  // 还没选执行结果：hand_back 两种结果都退回，照原句；其余把成功与失败分开说。
  assert.deepEqual(run(handBack, ""), { fate: back, vin: vinBack });
  assert.equal(run(hold, "").fate, "执行失败时回执会逐字交回原智能体;执行成功时" + held);
  assert.equal(run(card, "").fate, "执行失败时回执会逐字交回原智能体;执行成功时" + unknown);
  assert.equal(run(hold, "").vin, "可选:补充一句说明");
  // 不含文件的方案、文件未补齐的方案都退回原线：补充指示框照旧。
  assert.equal(run(hold, "", "B").vin, vinBack);
  assert.equal(run(hold, "", "C").vin, vinBack);
  // 弹窗里这句只留占位，由 syncDecision 填写；不再写死「交回原智能体」。
  const box = { innerHTML: "", querySelector: () => null };
  const context = { draftVersions: new Map(), decisionSnapshot: null, structuredClone,
    document: { getElementById: (id) => id === "decision-modal-b" ? box : { textContent: "" } },
    decisionPanel: () => "", verdictDraft: new Map(), receiptDraft: new Map(), syncHandoff() {},
    decisionModal: { querySelector: () => null, classList: { add() {} } } };
  vm.createContext(context);
  vm.runInContext(panelSection("function openDecisionModal(t){", '\ndocument.addEventListener("dblclick"'), context);
  context.openDecisionModal({ id: 7, aggregate_version: 1, subject: "s", confirm_destination: "hold_for_review" });
  assert.ok(box.innerHTML.includes('不要粘贴密钥或客户明细;<span data-receipt-fate="7"></span></div>'), "回执去向占位不在提示句末");
  assert.ok(!box.innerHTML.includes(back), "弹窗不再写死交回原智能体");
  assert.ok(!source.includes("请先填写执行回执,再交回智能体"), "缺回执提示不预设交回原智能体");
});

// ══ 文案闸(卡 #16):给 docs/style-guide.md「不写注释性语句」装一个机器闸 ══════════════
//  为什么:卡 #9 清掉了二十多句注释性文案,但规则落地只有纪律 —— 下一个写引导步骤、错误文案或页脚
//  说明的人(人或模型)照旧能写回「(开始干活前需要)」「—— 其实…」,没有任何机器会出声。文案最容易
//  悄悄回潮:#9 清掉的那些,有好几句就是历次迭代一层层加上去的。
//
//  ⚠ 这个闸**不是全量扫描**,够得到的面只有下面三个;够不到的明说,不假装:
//   A core/server.mjs 的上手引导四个函数(blessStep / upgradeState / setupState / acceptPreview)里的
//     字面量 —— 这一面是全量的:那几个函数产出的 title/detail/hint/label/confirm 全从这里来。
//   B core/panel.html 的 HTML 文本节点(按 `>…<` 取)—— 属性值永远不在这两个尖括号之间,所以
//     title= / aria-label / placeholder 结构上就不在扫描里(style-guide 明说悬停说明允许写解释);
//     SVG 的 <title> 与执行器设置的「说明」折叠区(cfg-about)同理剔除。
//   C core/panel.html 里走**文本通道**的字面量:往前 120 字符内出现 textContent / confirm( /
//     alert( / live( / homeEl( 的那些。innerHTML 的模板汤不在内 —— 模板里
//     `title="${a ? `…` : `…`}"` 这种插值,字面量自己看不出落在属性里,硬扫会把允许写解释的悬停
//     文案判成违规。
//  判据与白名单都在这个文件里:改规则要连白名单一起改,白名单每条必须写理由。
const CJK_ONE = /[一-鿿]/;
const cjkCount = (s) => (s.match(/[一-鿿]/g) || []).length;
const BANNED_WORDS = ["意思是", "也就是", "就是说", "你正在", "其实", "说白了", "换句话说"];
/** 一条文案三种判法;返回命中的规则(空数组 = 合规)。纯函数,红绿两侧用的都是它。 */
function copyText(text) {
  const src = String(text); let out = "";
  for (let i = 0; i < src.length; i++) {
    if (src.slice(i, i + 2) !== "${") { out += src[i]; continue; }
    let end = i + 2, depth = 1, quote = "";
    for (; end < src.length && depth; end++) {
      const ch = src[end];
      if (quote) {
        if (ch === "\\") end++;
        else if (ch === quote) quote = "";
      } else if ('"\'`'.includes(ch)) quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    // 只遮住闭合的插值代码；不执行表达式，未闭合时保留原文供闸检查。
    if (!depth) { out += "X"; i = end - 1; }
    else out += src[i];
  }
  return out;
}

function copyFindings(text) {
  // 插值当一个无汉字的占位符:代码里的括号、模板里的表达式都不是文案。
  const t = copyText(text);
  const hits = [];
  for (const w of BANNED_WORDS) if (t.includes(w)) hits.push(`解释词「${w}」`);
  if (t.includes("——")) hits.push("破折号旁白");
  // 整句就是一对括号 = 占位选项的写法(「(不指定线 · 谁都能领)」),不是给句子加的旁白。
  const whole = /^\s*[(（][^)）]*[)）]\s*$/.test(t.trim());
  if (!whole) for (const m of t.matchAll(/[(（]([^)）]*)[)）]/g))
    if (cjkCount(m[1]) >= 6) { hits.push(`括号里的补充说明「${m[1].slice(0, 14)}」`); break; }
  return hits;
}

// 白名单:例外必须被说出来,不能悄悄通过。键 = 文件 + 原文片段;line 只作人看的坐标。
//   ⚠ 行号会随每次改动漂移,用行号当键会在无关改动之后静默失配 —— 所以键是原文。
//   每条都要有 why,而且必须真的还被命中(下面断言「没有多余条目」:失效的例外要删,不能攒着)。
const COPY_ALLOW = [
  { file: "core/panel.html", line: 2460, text: "(再点该卡节点=恢复全图)",
    why: "时间轴图例:括号里是「点哪里会怎样」的图形编码,图例本身就是对照表,不是正文旁白" },
  { file: "core/panel.html", line: 2461, text: "(时刻见悬浮/时变小字)",
    why: "同上:时间轴坐标轴的图例,整行都是「符号=含义」的对照表" },
];

/** 取出一段源码里的字符串字面量(带行号与它前面的上下文)。注释里的引号不算字面量:
 *  先按最朴素的方式把行注释与块注释换成空白 —— 剔错只会少扫,不会把注释判成文案。 */
function literalsOf(src, { context = 0 } = {}) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
                   .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, " "));
  const out = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  for (let m; (m = re.exec(clean));) {
    const text = m[1] ?? m[2] ?? m[3] ?? "";
    if (!CJK_ONE.test(text)) continue;
    out.push({ text, line: clean.slice(0, m.index).split("\n").length,
               before: context ? clean.slice(Math.max(0, m.index - context), m.index) : "" });
  }
  return out;
}

test("文案闸区分嵌套模板表达式和表达式之外的可见旁白", () => {
  for (const text of [
    '下载 ${esc(copyLabel({apply:"执行文件",rollback:"回退文件",compare:"对照文件"}))}',
    '${esc(why || `看板已更新到 ${rev}`)},这页还是旧的。',
    '状态 ${choose({label:"内部(表达式里有六个汉字说明)",other:"}\\\""})}',
  ]) assert.deepEqual(copyFindings(text), [], text);
  for (const text of ['${choose({label:"状态"})}(开始干活前需要)', '${why} —— 其实还没保存'])
    assert.ok(copyFindings(text).length, text);
});

test("文案闸：引导与面板的可见文案里没有注释性语句（规则见 docs/style-guide.md）", () => {
  const serverSrc = readFileSync(new URL("../core/server.mjs", import.meta.url), "utf8");
  const fnSlice = (head) => {
    const a = serverSrc.indexOf(head);
    assert.ok(a >= 0, `未找到函数：${head}`);
    const b = serverSrc.indexOf("\n}", a);
    assert.ok(b > a, `未找到函数结尾：${head}`);
    return serverSrc.slice(a, b);
  };
  const found = [];
  // ── A 面:上手引导的四个函数
  for (const head of ["function blessStep() {", "function upgradeState() {", "function setupState() {",
                      "function acceptPreview(tree, prev) {"])
    for (const lit of literalsOf(fnSlice(head)))
      for (const rule of copyFindings(lit.text)) found.push({ file: "core/server.mjs", ...lit, rule });

  // ── B 面:panel.html 的 HTML 文本节点
  const panelText = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<title>[\s\S]*?<\/title>/g, " ")
    .replace(/<details class="cfg-about"[\s\S]*?<\/details>/g, " ");
  for (const m of panelText.matchAll(/>([^<>\n]+)</g)) {
    const text = m[1].trim();
    if (!CJK_ONE.test(text)) continue;
    for (const rule of copyFindings(text))
      found.push({ file: "core/panel.html", text, rule, line: panelText.slice(0, m.index).split("\n").length });
  }
  // ── C 面:走文本通道的字面量(允许跨一行:textContent = 常和文案分行写)
  const CHANNEL = /(?:textContent|confirm\(|alert\(|live\(|homeEl\()[\s\S]{0,120}$/;
  for (const lit of literalsOf(source, { context: 140 })) {
    if (!CHANNEL.test(lit.before) || /title=|aria-label=|placeholder/.test(lit.before)) continue;
    for (const rule of copyFindings(lit.text)) found.push({ file: "core/panel.html", ...lit, rule });
  }

  const allowed = (f) => COPY_ALLOW.find((a) => a.file === f.file && f.text.includes(a.text));
  const hit = new Set();
  const left = found.filter((f) => { const a = allowed(f); if (a) { hit.add(a.text); return false; } return true; });
  assert.deepEqual(left.map((f) => `${f.file}:${f.line} ${f.rule} ← ${f.text.slice(0, 60)}`), [],
    "界面正文只写状态和下一步动作:括号里的补充说明、破折号夹的旁白、「意思是/你正在」这类解释都不进正文" +
    "(确实需要的解释放 title= 或文档)。要破例就写进 COPY_ALLOW,并写明理由。");
  for (const a of COPY_ALLOW) {
    assert.ok(a.why && a.why.length > 8, `白名单缺理由:${a.file} ${a.text}`);
    assert.ok(/^core\/[\w.-]+$/.test(a.file) && Number.isInteger(a.line), `白名单要写文件与行号:${a.text}`);
    assert.ok(hit.has(a.text), `白名单有多余条目(代码里已经没有了,删掉它):${a.file}:${a.line} ${a.text}`);
  }
});

test("文案闸的阴性对照：卡 #9 之前的那些写法逐条被判出来", () => {
  // 逐字取自 28c04da 之前的 core/server.mjs(setupState / blessStep)与 core/panel.html。
  //   闸自己也要有对照:不先证明它抓得住,全绿只说明「没扫到」。
  const BEFORE = [
    ["确认当前版本(开始干活前需要)", "括号补充"],
    ["你正在看它 —— 端口 47824", "解释词 + 破折号"],
    ['生成的示例配置已经带了 "gated_subtree": "."(意思是:盯住整棵代码树)。看板重启读到它之后,这一步才能做', "意思是"],
    ["看板目录得是一个 git 仓库 —— 「确认版本」就是记下它当前的 git 树哈希", "破折号旁白"],
    ["在这之前自动拉取会拒绝起线(exit 3)—— 那是门在挡没确认过的代码,不是故障", "破折号旁白"],
    ["先做上一步 —— 你的线就写在那份配置里", "破折号旁白"],
    ["点一下,表示「这个版本我认可」—— 点之前会先列出版本号", "破折号旁白"],
    ["看板已更新到 r1 —— 这页还是旧的。你有没保存的输入,所以没有自动刷新。", "破折号旁白"],
    ["上限 3 个(全线共享额度)；新加的智能体照抄智能体 1 的设置", "括号补充"],
    ["队外(未放行/祖先未放行/待人工)5 张(已收起)", "括号补充"],
    ["在单独的控制台窗口里运行（便于直接看执行过程）", "括号补充"],
    ["目标下的评审卡 #7 还没通过。现在拆解 = 实现一个没人接受的方案。仍要现在拆?(正史会记下这次是强制的)", "括号补充"],
    ["这些按钮不是马上执行:它们在板上留一条请求,没人接手时请求会一直等着(5 分钟后变黄提醒你)。", "括号补充"],
  ];
  for (const [text, why] of BEFORE)
    assert.ok(copyFindings(text).length > 0, `闸没抓住(${why}):${text.slice(0, 40)}`);
  // ⚠ 三条规则抓不到的两类(写在这里,免得把闸当成全覆盖):
  //   · 名词定义句:「「线」= 一条自动领卡、一张接一张干下去的流水线」—— 没有括号、没有破折号、
  //     没有解释词,机器判不出来「这是定义」。
  //   · 短括号:「此模型固定单档(座席裁定)」只有 4 个汉字,低于 ≥6 的门槛。
  //   门槛要是降到 4,`(交付即完成)`(4)、`(已收起)`(3) 这类状态标签就会被误判 —— 宁可少抓,不乱抓。
  for (const blind of ["「线」= 一条自动领卡、一张接一张干下去的流水线", "此模型固定单档(座席裁定)"])
    assert.deepEqual(copyFindings(blind), [], `这是已知盲区,别假装抓到了:${blind}`);
  // 合规的写法必须放过去,否则这个闸只会逼人把话写得更含糊。
  for (const good of [
    "端口 47824", "确认当前版本", "这个版本还没确认过", "先做第二步生成配置,再重启看板",
    '配置里要有 "gated_subtree" 这个键', "重启看板让新值生效", "已确认版本 b1946a98f0cd",
    "读不到代码的版本(fatal: not a git repository)", "(不指定线 · 谁都能领)", "队外 5 张(已收起)",
    "重启看板,让它读到新配置。\n\n卡、事件、账本都在库里,不会丢;在跑的线会先停下,起来后照原样恢复。",
    "看板还没回来(超过 30 秒)。看它的日志:<数据目录>/board.log",
  ]) assert.deepEqual(copyFindings(good), [], `合规文案被误判:${good.slice(0, 40)}`);
});
