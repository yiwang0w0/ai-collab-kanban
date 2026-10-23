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
const readiness = new Function(readinessSource + "\nreturn { runtimeReadiness, runtimeProbeKey };")();

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
  assert.match(source, /aria-valuetext="\$\{esc\(effortName\(a\.effort\)\)\}"/);
  assert.ok(source.includes('el.setAttribute("aria-valuetext", effortName(a.effort))'));
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
    MODELS: [], EFFORTS: ["high"], cfgAgents: agents, cfgProbes: new Map(), cfgLine: "work", cfgReadiness: null,
    cfgSingle: false, cfgLegacy: false, MAXP: 1, cfg, cfgAnchor: { getBoundingClientRect: () => ({ left: 400, bottom: 200 }) },
    innerWidth: 1280, esc: (value) => String(value), lineColor: () => "var(--cc)", lineLabel: () => "任务执行线",
    effortName: () => "高",
  });
  vm.runInContext(readinessSource + "\n" + panelSection("function renderCfg(){", "async function probeCfgAgent("), context);
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
