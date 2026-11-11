import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../core/panel.html", import.meta.url), "utf8");
const start = source.indexOf("// ── display-copy(pure;tests/panelcopytest.mjs)──");
const end = source.indexOf("// ── /display-copy ──", start);
assert.ok(start >= 0 && end > start, "未找到纯展示文案测试边界");
const copy = new Function(source.slice(source.indexOf("\n", start) + 1, end) +
  "\nreturn { copyLabel, routeLabel, copyError, formatCount, usageValue, usageCostMark, usageDuration, usageMerge, usageTop, USAGE_PHASE, cliVersionCells, zcodeView, zcodeCardRows, usageSince, usagePath, usageCardFlag, usageGroupRow };")();

function panelSection(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `未找到面板测试边界：${start}`);
  return source.slice(a, b);
}
const readinessSource = panelSection("// ── runtime-readiness(pure;tests/panelcopytest.mjs) ──", "// ── /runtime-readiness ──");
const profileSource = panelSection("// ── execution-profile-copy(pure;tests/panelcopytest.mjs) ──", "// ── /execution-profile-copy ──");
// 设置页协作区的文案表与纯函数:用到 display-copy 的 copyLabel,其余自足。
const coordSource = panelSection("// ── coord-copy(pure;tests/panelcopytest.mjs)──", "// ── /coord-copy ──");
const coord = new Function("copyLabel", coordSource +
  "\nreturn { COORD_COPY, armedLabel, coordExecView, coordLockView, coordLockCheck, coordHandoffView, coordHandoffPack, coordJournalView, approvalRowView, aptRemoteLine, aptTokenView };")(copy.copyLabel);
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

test("用量的数：未知不当 0，有已知部分写「不少于」，费用带来源标记", () => {
  // 形状照用量接口的一组汇总:有未知行的项是 null,已知部分的和在 known。
  const full = { rows: 3, attempts: 2, calls: 14, in: 12000, cc: 800, cr: 90000, out: 3400, duration_ms: 200000, cost_usd: 0.4213, cost_source: "reported", cost_sources: { reported: 3 }, known: {}, unknown: {} };
  assert.equal(copy.usageValue(full, "in"), "1.2万");
  assert.equal(copy.usageValue(full, ["in", "out"]), "1.5万", "词元 = 输入 + 输出");
  assert.equal(copy.usageValue(full, "attempts"), "2");
  assert.equal(copy.usageValue(full, "duration_ms"), "3 分 20 秒");
  assert.equal(copy.usageValue(full, "cost_usd") + copy.usageCostMark(full), "0.42 美元");
  const partial = { ...full, in: null, cost_usd: null, known: { in: 5000, cost_usd: 0.2 }, unknown: { in: 1, out: 0, cost_usd: 1 } };
  assert.equal(copy.usageValue(partial, "in"), "不少于 5.0千", "有未知行：只有已知部分，不写成确数");
  assert.equal(copy.usageValue(partial, ["in", "out"]), "不少于 8.4千", "和里有一项不全，整个和就是下限");
  assert.equal(copy.usageValue(partial, "cost_usd"), "不少于 0.20 美元");
  const blank = { rows: 2, attempts: 1, calls: null, in: null, cc: null, cr: null, out: null, duration_ms: null, cost_usd: null, cost_source: "unknown", cost_sources: { unknown: 2 }, known: {}, unknown: { in: 2 } };
  for (const key of ["in", "out", "cr", "cc", "calls", "duration_ms", "cost_usd"]) assert.equal(copy.usageValue(blank, key), "待核实", key);
  assert.equal(copy.usageValue(blank, ["in", "out"]), "待核实");
  assert.ok(!/(^|[^.\d])0($|[^.\d])/.test(["in", "out", "cost_usd", "duration_ms"].map((k) => copy.usageValue(blank, k)).join(" ")), "未知的数不显示成 0");
  assert.equal(copy.usageValue(undefined, "in"), "待核实");
  assert.equal(copy.usageValue({ ...full, cost_usd: 0.0042 }, "cost_usd"), "0.0042 美元", "不到一分钱的费用不抹成 0.00");
  assert.equal(copy.usageValue({ ...full, cost_usd: 0 }, "cost_usd"), "0.00 美元", "确知为 0 才写 0");
  // 五种费用来源。
  const mark = (cost_source, cost_sources = {}) => copy.usageCostMark({ cost_source, cost_sources });
  assert.equal(mark("reported"), "");
  assert.equal(mark("estimated"), " · 估算");
  assert.equal(mark("mixed", { reported: 2, estimated: 1 }), " · 含估算");
  assert.equal(mark("mixed", { reported: 2, "external-reported": 1 }), "", "混合但没有估算行，不标估算");
  assert.equal(mark("external-reported"), " · 外部自报");
  assert.equal(copy.usageValue(blank, "cost_usd") + copy.usageCostMark(blank), "待核实", "来源未知：费用只写待核实");
  assert.equal(copy.usageValue({ ...partial, cost_source: "estimated" }, "cost_usd") + copy.usageCostMark({ ...partial, cost_source: "estimated" }), "不少于 0.20 美元 · 估算");
  // 耗时与阶段名。
  assert.deepEqual([999, 59000, 60000, 200000, 3600000, 5400000, 86399000].map(copy.usageDuration), ["1 秒", "59 秒", "1 分", "3 分 20 秒", "1 小时", "1 小时 30 分", "24 小时"]);
  assert.deepEqual(copy.USAGE_PHASE, { implement: "实现", fix: "续修", review: "审阅", decompose: "拆解", compact: "压缩", coord: "协调", "?": "待核实" });
  // 合并:rows 为 0 的组不参与(没有失败尝试 = 浪费为 0);有未知行的项只剩下限。
  const none = { rows: 0, attempts: 0, in: null, out: null, known: {}, unknown: {} };
  assert.deepEqual(copy.usageMerge([none, none], ["in", "out"]), { rows: 0, known: {}, in: 0, out: 0 });
  assert.equal(copy.usageValue(copy.usageMerge([none], ["in", "out"]), ["in", "out"]), "0");
  assert.equal(copy.usageValue(copy.usageMerge([full, none, full], ["in", "out"]), ["in", "out"]), "3.1万");
  assert.equal(copy.usageValue(copy.usageMerge([full, partial], ["in", "out"]), ["in", "out"]), "不少于 2.4万");
  // 最贵的几张:费用有未知行的按已知部分排;费用全未知的不进榜;"?" 单列。
  const g = (key, cost_usd, known = {}) => ({ key, rows: 1, cost_usd, known });
  const top = copy.usageTop([g("1", 0.5), g("2", null, { cost_usd: 2 }), g("3", null), g("?", 9), g("4", 1.5), g("5", null)], 2);
  assert.deepEqual([top.rows.map((x) => x.key), top.unknown, top.loose.key], [["2", "4"], 2, "?"]);
  assert.deepEqual(copy.usageTop([]), { rows: [], unknown: 0, loose: null });
  // 第三波:时间范围按本地日历日给 since;分组路径;按卡的失败尝试与结算;按线等分组行里未知写「待核实」不写 0。
  const now = new Date(2026, 10, 10, 9, 30);
  assert.deepEqual(["today", "7d", "all", "x"].map((r) => copy.usageSince(r, now)), ["2026-11-10", "2026-11-04", "", ""]);
  assert.deepEqual([copy.usagePath("line", "7d", now), copy.usagePath("bogus", "all", now, true)], ["/api/usage?by=line&since=2026-11-04", "/api/usage?by=card&format=csv"]);
  assert.deepEqual([copy.usageCardFlag({ attempts_failed: 2, settled: true }), copy.usageCardFlag({ attempts_failed: 0, settled: false }),
    copy.usageCardFlag({ attempts_failed: null, settled: false }), copy.usageCardFlag({ rows: 1 })], ["失败尝试 2 次 · 已结算", "未结算", "失败尝试待核实 · 未结算", ""]);
  const zc = copy.usageGroupRow({ key: "zcode", rows: 1, attempts: 1, in: null, out: null, cost_usd: null, cost_source: "unknown", known: {}, unknown: { in: 1, out: 1, cost_usd: 1 } }, "Zcode");
  assert.deepEqual([zc.name, zc.attempts, zc.cost, zc.tokens], ["Zcode", "1 次", "待核实", "待核实"], "Zcode 账本行的词元与费用是未知,不是 0");
});

test("执行器 CLI 四格：格子只写短状态、口径进 title，警示态都带下一步，判断不了新旧就不写，没配置的整行不出", () => {
  const when = (iso) => "T" + iso.slice(5, 10);
  const base = { id: "claude", name: "Claude CLI", state: "found", path: "C:/secret/path/claude.exe", current: "2.1.290", latest: "2.1.300", latest_state: "ok",
    latest_checked_at: "2026-11-10T00:00:00.000Z", update_available: true, tested: { state: "boundary", at: "2026-11-09T00:00:00.000Z" } };
  const cells = (c) => copy.cliVersionCells(c, when).cells.map((x) => [x.k, x.v, x.st]);
  assert.deepEqual(cells(base), [["当前", "2.1.290", "ok"], ["最新", "2.1.300", "warn"], ["上次核对", "T11-10", "ok"], ["实测", "已实测", "ok"]]);
  const up = copy.cliVersionCells(base, when);
  assert.equal(up.cells[1].badge, "可升级");
  assert.equal(up.next, "运行 node cli/upgrade-cli.mjs claude 查看会做什么，加 --yes 才执行");
  assert.equal(up.cells[3].title, "参数与读写权限范围都已实测；实测于 T11-09");
  assert.equal(copy.cliVersionCells({ ...base, npm_managed: false }, when).next, "按这个 CLI 的官方说明升级，再运行 node cli/doctor.mjs", "不是 npm 装的：写得出动作");
  assert.equal(copy.cliVersionCells({ ...base, npm_managed: true }, when).next, up.next);
  assert.ok(!JSON.stringify(up).includes("secret"), "可执行文件的路径不进正文");
  // 第三波:安装来源写在名字后面;npm 装的、服务端给了升级命令时,行下写这条命令供复制。
  const npm = copy.cliVersionCells({ ...base, install_source: "npm-global", npm_managed: true, upgrade_hint: "npm install -g @anthropic-ai/claude-code@latest" }, when);
  assert.deepEqual([npm.source, npm.next, npm.copy, copy.cliVersionCells({ ...base, install_source: "native", npm_managed: false }, when).source, up.source, up.copy],
    ["npm 全局安装", "升级命令", "npm install -g @anthropic-ai/claude-code@latest", "独立安装", "", undefined]);
  // 已是最新 / 判断不了。
  const same = copy.cliVersionCells({ ...base, current: "2.1.300", update_available: false }, when);
  assert.deepEqual([same.cells[1].st, same.cells[1].note, same.cells[1].badge, same.next], ["ok", "已是最新", undefined, null]);
  const unsure = copy.cliVersionCells({ ...base, update_available: null }, when);
  assert.deepEqual([unsure.cells[1].v, unsure.cells[1].st, unsure.next], ["2.1.300", "unknown", null]);
  assert.ok(!JSON.stringify(unsure).includes("已是最新") && !JSON.stringify(unsure).includes("可升级"), "update_available 为 null 时不判断新旧");
  // 最新格的三种查询状态。
  const offline = copy.cliVersionCells({ ...base, latest_state: "unavailable", update_available: true }, when);
  assert.deepEqual([offline.cells[1].v, offline.cells[1].note, offline.cells[1].st, offline.cells[2].st, offline.next], ["未能查询", "上次查到 2.1.300", "unknown", "unknown", null]);
  assert.equal(copy.cliVersionCells({ ...base, latest_state: "unavailable", latest: null }, when).cells[1].note, undefined);
  assert.deepEqual(cells({ ...base, latest: null, latest_state: "not_checked", latest_checked_at: null, update_available: null }).slice(1, 3),
    [["最新", "未查询", "unknown"], ["上次核对", "无", "unknown"]]);
  // 当前格读不到。
  assert.deepEqual(cells({ ...base, state: "wrapper", current: null, update_available: null })[0], ["当前", "未找到", "warn"]);
  assert.deepEqual(cells({ ...base, state: "not_found", current: null, update_available: null })[0], ["当前", "未找到", "warn"]);
  assert.deepEqual(cells({ ...base, current: null, update_available: null })[0], ["当前", "版本读不出", "warn"]);
  // 警示态不能只有一个三角:这两种情况行下都有一句下一步,即使查得到更新的版本也先说这一句。
  for (const broken of [{ state: "wrapper", current: null }, { state: "not_found", current: null }, { current: null }, { current: null, update_available: null }])
    assert.equal(copy.cliVersionCells({ ...base, ...broken }, when).next, "运行 node cli/doctor.mjs 查看原因", JSON.stringify(broken));
  assert.equal(copy.cliVersionCells({ ...base, state: "not_found", current: null }, when).cells[0].title, "没有找到可以直接启动的 CLI 程序");
  // 实测格:正文三态短词,口径说明在 title,三种状态都有。
  assert.deepEqual(cells({ ...base, tested: { state: "contract", at: "2026-11-09T00:00:00.000Z" } })[3], ["实测", "部分实测", "unknown"]);
  assert.equal(copy.cliVersionCells({ ...base, tested: { state: "contract", at: "2026-11-09T00:00:00.000Z" } }, when).cells[3].title, "参数已核对，读写权限范围未实测；实测于 T11-09");
  assert.deepEqual(cells({ ...base, tested: { state: "none", at: null } })[3], ["实测", "未实测", "unknown"]);
  assert.equal(copy.cliVersionCells({ ...base, tested: { state: "none", at: null } }, when).cells[3].title, "这个版本没有实测记录");
  for (const tested of [{ state: "boundary", at: null }, { state: "contract", at: null }, undefined])
    assert.ok(copy.cliVersionCells({ ...base, tested }, when).cells[3].title, "实测格总有悬停说明");
  const allCells = JSON.stringify(["wrapper", "not_found", "found"].flatMap((state) => ["boundary", "contract", "none"].map((t) => copy.cliVersionCells({ ...base, state, tested: { state: t, at: null } }, when).cells.map((x) => x.v))));
  assert.ok(!/原生可执行文件|读写边界/.test(allCells), "格子正文不写内部说法");
  assert.equal(copy.cliVersionCells({ ...base, state: "not_configured" }, when), null, "没有配置的 CLI 整行不出");
  assert.equal(copy.cliVersionCells(null), null);
  // 版本块不放升级按钮:只有「重新核对」和升级命令旁的「复制」(只写剪贴板,不执行)。
  const block = panelSection("function renderCliVersions(){", "/** The three fleet reads");
  assert.deepEqual([...block.matchAll(/homeEl\("button", ([^)]*)\)/g)].map((m) => m[1]), ['cliChecking ? "核对中…" : "重新核对"', '"复制"']);
  assert.ok(block.includes("navigator.clipboard.writeText(r.copy)") && !/fetch\(|post\(/.test(block.slice(block.indexOf("if (r.copy)"), block.indexOf("else if (r.next)"))));
  assert.ok(block.includes('badge.dataset.tone = "warn"') && block.includes('homeCmdText(homeEl("p", undefined, "cv-next"), r.next)'));
});

test("Zcode 只读块：没配置一句话；开关、预算、最近分派、心跳四格，读不到的写「待核实」；卡上写分派请求状态与拒收白话；执行线行不给齿轮、启动钮置灰", () => {
  const when = (iso) => "T" + iso.slice(11, 16);
  assert.deepEqual(copy.zcodeView({ configured: false, loop: { state: "not_configured", reason: "看板没有指向…" } }), { configured: false, text: "没有配置 Zcode", title: "看板没有指向…" });
  const v = copy.zcodeView({ configured: true, switches: { budget_enabled: true, launch_enabled: false, released_env: null }, budget: { used: 1, limit: 1, reserved: 0 },
    loop: { state: "budget_exhausted", reason: "调用预算已用完，1 / 1 次。", last_heartbeat_at: "2026-11-10T06:05:00.000Z" },
    last_dispatch: { task_id: 12, phase: "settled", outcome: "success", at: "2026-11-10T06:00:00.000Z" }, model: "GLM-5.3" }, when);
  assert.deepEqual([v.state.label, v.state.tone, v.reason, v.model, v.cells.map((c) => [c.k, c.v, c.st])], ["预算用完", "warn", "调用预算已用完，1 / 1 次。", "GLM-5.3", [
    ["开关", "预算已启用 · 启动已关闭", "warn"], ["预算", "已用 1 / 上限 1", "warn"], ["最近一次分派", "#12 · 已结算 · 成功 · T06:00", "ok"], ["心跳", "T06:05", "ok"]]]);
  const broken = copy.zcodeView({ configured: true, switches: { budget_enabled: null, launch_enabled: null, released_env: null }, budget: null, loop: { state: "future", reason: "" } });
  assert.deepEqual([broken.state.label, broken.cells.map((c) => c.v)], ["待核实", ["预算待核实 · 启动待核实", "待核实", "还没有分派", "没有心跳"]]);
  assert.deepEqual(copy.zcodeCardRows({ request_state: "cancelled", refusal_code: "VERIFY_UNSUPPORTED", refusal_text: "带登记验证的卡不能交给 Zcode", refusal_source: "request", dispatches: 0 }),
    [["Zcode 分派请求", "已撤回"], ["拒收原因", "带登记验证的卡不能交给 Zcode"], ["分派次数", "0 次"]]);
  assert.deepEqual([copy.zcodeCardRows(undefined), copy.zcodeCardRows({ request_state: null, dispatches: 0 })[0][1]], [null, "还没有分派请求"]);
  const rig = panelSection("function renderRig(){", "// ── coord-copy");
  const zc = rig.slice(rig.indexOf("if (zc.has(w.line))"), rig.indexOf("const slots ="));
  assert.ok(zc.includes("由独立循环执行") && zc.includes("<button type=\"button\" disabled") && !zc.includes("data-cfg") && !zc.includes("data-wk") && !zc.includes("xN"),
    "Zcode 线:没有齿轮和并行数,启动钮置灰、不带 data-wk");
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
    { bg: "#f7f2e8", bg2: "#f2ebdf", panel: "#fffcf6", panel2: "#f1e9dc", line: "#ddcfbb", fg: "#332b23",
      dim: "#756652", dim2: "#726451", accent: "#9b530b", cc: "#80572c", l0: "#936544",
      ok: "#396a4c", warn: "#7f5d0e", bad: "#b74332" },
    { bg: "#1e1a16", bg2: "#191511", panel: "#27211c", panel2: "#312920", line: "#463a2d", fg: "#f4eadb",
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
  const timeoutOnly = profileCopy.executionBudgetText({ max_cost_usd: null, timeout_sec: 600, max_turns: null }, "cli_timeout_only");
  assert.match(timeoutOnly, /总时限 600 秒.*单次执行/);
  assert.doesNotMatch(timeoutOnly, /待你确认|null|金额参考|不能派发/);
  assert.match(profileCopy.executionBudgetText({ timeout_sec: null }, "cli_timeout_only"), /待你确认时限.*不能派发/);
  assert.match(profileCopy.executionBudgetText({ timeout_sec: 600 }, "provider_spend_limit_required"), /待你确认金额.*不能派发/);
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
  const context = vm.createContext({ homeEl: (tag, text) => new Element(tag, text), localTime: (value) => value, effortName: () => "高", lineLabel: (line) => line,
    zcodeCardRows: copy.zcodeCardRows });
  vm.runInContext(profileSource + "\n" + panelSection("function sideExecution(t, need = false, protocol = false){", "function sideRelationshipBox(t){"), context);
  const card = { id: 4, status: "not_started", released: false, aggregate_version: 7,
    verification_repair: { max_rounds: 3 }, verification_repair_digest: "b".repeat(64), execution_profile: {
    execution_profile_id: "claude-api", profile_digest: "a".repeat(64), configuration_changed: true, label: "API 样本", channel: "claude_agent_sdk", auth_kind: "api_key", billing_kind: "anthropic_api", model: "allowed", effort: "high", tools: "write", budget: null, workspace: { path: "C:/隔离/中文 工作仓" },
  } };
  const section = context.sideExecution(card), button = section.children.find((n) => n.tag === "button");
  assert.match(section.textContent, /C:\/隔离\/中文 工作仓/); assert.match(section.textContent, /Claude API（Agent SDK）/);
  assert.match(section.textContent, /促销归属待账单确认/); assert.match(section.textContent, /待你确认/);
  assert.match(section.textContent, /allowed · 高/);
  assert.equal(button.dataset.a, "release"); assert.equal(button.dataset.version, "7");
  assert.equal(button.disabled, undefined);
  assert.equal(button.dataset.executionProfileDigest, "a".repeat(64), "确认摘要来自正在显示的卡片，不从其他设置取值");
  assert.equal(button.dataset.verificationRepairDigest, "b".repeat(64), "续修确认绑定当前卡片的策略摘要");
  assert.match(section.textContent, /放行前核对执行配置/); assert.match(section.textContent, /第二次确认不会自动接受另一份配置/);
  const withoutDigest = context.sideExecution({ ...card, execution_profile: { ...card.execution_profile, profile_digest: null } });
  assert.equal(withoutDigest.children.find((n) => n.tag === "button").disabled, true, "缺少摘要不能放行");
  // CLI 旧卡也沿用同一个放行入口确认续修策略；缺少新快照摘要时保持禁用。
  const legacy = { ...card, execution_profile: undefined };
  const legacyButtons = context.sideExecution(legacy).children.filter((n) => n.tag === "button");
  assert.equal(legacyButtons.length, 1, "不新增第二个放行入口");
  assert.equal(legacyButtons[0].dataset.a, "release");
  assert.equal(legacyButtons[0].dataset.executionProfileDigest, "");
  assert.equal(legacyButtons[0].dataset.verificationRepairDigest, "b".repeat(64));
  assert.equal(legacyButtons[0].disabled, undefined);
  assert.equal(context.sideExecution({ ...legacy, verification_repair_digest: undefined }).children.find((n) => n.tag === "button").disabled, true);
  assert.equal(context.sideExecution({ ...legacy, released: true }).children.some((n) => n.tag === "button"), false, "已放行旧卡不重复放行");
  const active = context.sideExecution({ ...card, status: "in_progress", run_id: "run", execution_trace: { run_id: "run", model_activity_at: "2026-10-27T00:00:00Z" } });
  assert.match(active.textContent, /最近模型活动/); assert.match(active.textContent, /进程、心跳和输出不等于有效工作/);
  assert.ok(source.includes('a === "archive" || a === "release") && b.dataset.armed !== "1"'));
  assert.ok(source.includes('released: true, expected_version: Number(b.dataset.version)'));
  assert.ok(source.includes('confirm_execution_profile_digest: b.dataset.executionProfileDigest'), "两押提交原按钮绑定的摘要，配置变化不静默确认");
  assert.ok(source.includes('confirm_verification_repair_digest: b.dataset.verificationRepairDigest'), "续修策略沿原放行请求提交，不自动扩大旧授权");
  // 目标卡沿用同一个放行入口,只换按钮上的字;只差放行时整节标成「要你做什么」,按钮还是那一个。
  const goal = context.sideExecution({ ...legacy, kind: "goal" }), goalButtons = goal.children.filter((n) => n.tag === "button");
  assert.deepEqual(goalButtons.map((n) => [n.textContent, n.dataset.a, n.dataset.version, n.dataset.verificationRepairDigest]), [["放行这个目标", "release", "7", "b".repeat(64)]]);
  const need = context.sideExecution(card, true);
  assert.equal(need.dataset.tone, "need"); assert.equal(need.children[0].textContent, "要你做什么");
  assert.equal(need.children.filter((n) => n.tag === "button").length, 1, "标成要你做什么不新增第二个放行入口");
  assert.equal(section.dataset.tone, undefined);
});

test("侧栏验收区不写说明句：按钮上的字随留言变，占位符不带括号，人工闸只写命令行里的处理位置", () => {
  const box = panelSection("function sideControlsBox(t, ctl){", "/** 这条线现在的样子");
  assert.ok(!source.includes("留空按「通过」= 结案") && !source.includes("按两次才生效。\" +"), "原说明句已删");
  assert.ok(!source.includes("(写了=打回继续)") && box.includes('"可选:补充给原执行方的一句指示"'), "占位符去掉括号里的内容");
  assert.ok(box.includes('if (ctl.kind === "accept" && t.execution_profile) box.append(homeEl("p", PROFILE_RELEASE_NOTE));'), "只在显式执行配置卡保留取消放行这一句");
  // 留言跟随:侧栏是留言范围,打字时按钮上的字同样跟着变;重建回填草稿后也同步一次。
  assert.ok(source.includes('e.target.closest(".card") || e.target.closest("[data-decision-scope]") || e.target.closest("[data-task-scope]");\n  if (scope) syncHandoff(scope);'));
  assert.ok(source.includes('syncHandoff(document.getElementById("task-side"));'));
  // 人工闸:面板没有解闸按钮,两押名单里也没有这个动作;处理位置写成 cli/board.py 实有的命令。
  assert.ok(!source.includes('"ungate"') && !source.includes("humanGate:false") && !source.includes("humanGate: false"), "面板不新增解除人工闸的权力");
  assert.ok(box.includes('"python cli/board.py edit " + t.id + " --file gate.json --version " + t.aggregate_version'));
  const cli = readFileSync(new URL("../cli/board.py", import.meta.url), "utf8");
  assert.ok(cli.includes("$P edit  <id> --file payload.json --version <aggregate_version>") && cli.includes('elif cmd == "edit":')
    && cli.includes("description / acceptance / line / route / humanGate / blockedBy"), "命令行的 edit 接受 humanGate，写法与面板上的命令一致");
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

test("协作区文案：执行者三态与已停止、锁的逾期与持有中、任务类批准只给「打开任务」、上膛的字、远程入口的句子", () => {
  const T = Date.parse("2026-11-10T06:00:00.000Z"), ago = (min) => new Date(T - min * 60000).toISOString();
  const ex = (extra) => ({ id: "a", name: "甲", kind: "external", active: true, last_seen: null, status: { current: "", done: [], next: [] }, ...extra });
  // 执行者:从未心跳「已登记」;有心跳「活动」;离心跳超时不到四分之一时警示色;停止了「已停止」。
  const state = (x, stale = 20) => { const v = coord.coordExecView(x, T, stale); return [v.state.label, v.state.tone, v.state.icon, v.seen]; };
  assert.deepEqual(state(ex()), ["已登记", "quiet", "wait", "还没有心跳"]);
  assert.deepEqual(state(ex({ last_seen: ago(0.5) })), ["活动", "ok", "success", "最后心跳 刚刚"]);
  assert.deepEqual(state(ex({ last_seen: ago(14) })), ["活动", "ok", "success", "最后心跳 14 分钟前"]);
  assert.deepEqual(state(ex({ last_seen: ago(15) })), ["活动", "warn", "warn", "最后心跳 15 分钟前"], "20 分钟超时:15 分钟起算接近");
  assert.equal(coord.coordExecView(ex({ last_seen: ago(15) }), T, 20).state.title, "超过 20 分钟没有心跳按停止处理");
  assert.deepEqual(state(ex({ last_seen: ago(30) }), 60), ["活动", "ok", "success", "最后心跳 30 分钟前"], "判定用接口给的 stale_min");
  assert.deepEqual(state(ex({ last_seen: ago(500) }), null), ["活动", "ok", "success", "最后心跳 8 小时 20 分前"], "没给 stale_min 就不判接近");
  assert.deepEqual(state(ex({ active: false, last_seen: ago(125) })), ["已停止", "quiet", "stop", "最后心跳 2 小时 5 分前"]);
  assert.deepEqual(state(ex({ active: false })), ["已停止", "quiet", "stop", "还没有心跳"]);
  const card = coord.coordExecView(ex({ kind: "line", status: { current: "  回归测试  ", next: ["跑测试", "", "写报告", 7] } }), T, 20);
  assert.deepEqual([card.name, card.id, card.kind, card.current, card.next, card.nextLabel], ["甲", "a", "执行线", "回归测试", ["跑测试", "写报告"], "下一步 2 项"]);
  const blank = coord.coordExecView(ex({ kind: "constructor", name: "" }), T, 20);
  assert.deepEqual([blank.name, blank.kind, blank.current, blank.next, blank.nextLabel], ["a", "待核实", "待核实", [], ""], "未知值写「待核实」,不显示机器字段、不写「–」");

  // 锁:逾期由服务端的 overdue 判;过了预计结束、还在宽限里的仍是「持有中」,只多一个 late。
  const lock = (extra) => ({ id: 7, resource: "device:test-phone", holder: "a", holder_name: "甲", purpose: "回归", started_at: ago(90), expected_end: ago(60), overdue: true, ...extra });
  const over = coord.coordLockView(lock(), T);
  assert.deepEqual([over.state.label, over.state.tone, over.state.icon, over.late], ["逾期", "warn", "warn", false]);
  assert.deepEqual([over.resource, over.holder, over.holderName, over.purpose, over.release], ["device:test-phone", "a", "甲", "回归", "强制释放"]);
  assert.equal(over.armed, "再按=确认强制释放 device:test-phone，持有者 甲");
  const held = coord.coordLockView(lock({ overdue: false, expected_end: new Date(T + 30 * 60000).toISOString() }), T);
  assert.deepEqual([held.state.label, held.state.tone, held.state.icon, held.late], ["持有中", "run", "wait", false]);
  assert.equal(coord.coordLockView(lock({ overdue: false, expected_end: ago(10) }), T).late, true, "过了预计结束、还没逾期");
  assert.deepEqual([coord.coordLockView(lock({ holder_name: "", purpose: " " }), T).holderName, coord.coordLockView(lock({ holder_name: "", holder: "", purpose: " " }), T).purpose], ["a", "待核实"]);
  // 第二下之前的核对。
  const locks = [lock()];
  assert.equal(coord.coordLockCheck(locks, "device:test-phone", "a", "7"), "");
  assert.equal(coord.coordLockCheck(locks, "device:test-phone", "b", "7"), "这把锁已换人，请重新核对");
  assert.equal(coord.coordLockCheck(locks, "device:test-phone", "a", "8"), "这把锁已重新加锁，请重新核对");
  assert.equal(coord.coordLockCheck([], "device:test-phone", "a", "7"), "这把锁已经释放");
  assert.equal(coord.coordLockCheck(null, "device:test-phone", "a", "7"), "这把锁已经释放");

  // 待你批准:任务类只给「打开任务」;版本确认、逾期锁、执行者请求留按钮。
  const apv = (kind, extra) => ({ id: kind + ":9:1", kind, title: "标题", summary: "摘要", created_at: ago(1), expected_version: 1,
    actions: ["approve", "reject"], labels: { approve: "通过", reject: "打回" }, detail_ref: { type: "task", id: 9 }, ...extra });
  for (const [kind, word] of [["decision", "待裁定"], ["delivery", "待验收"], ["release", "放行确认"]]) {
    const v = coord.approvalRowView(apv(kind));
    assert.deepEqual([v.kind, v.open, v.actions, v.note], [word, { type: "task", id: 9, label: "打开任务" }, [], null], kind);
  }
  const version = coord.approvalRowView(apv("version", { id: "version:upgrade:r2.0", detail_ref: { type: "setup" }, labels: { approve: "更新并重启", reject: "暂不更新" } }));
  assert.deepEqual(version.actions, [{ decision: "approve", label: "更新并重启", armed: "再按=确认更新并重启", primary: true, needsNote: false, review: false },
    { decision: "reject", label: "暂不更新", armed: "再按=确认暂不更新", primary: false, needsNote: false, review: false }]);
  assert.deepEqual([version.open, version.key, version.note], [null, "version:upgrade", { required: false, max: 500, label: "备注", placeholder: "备注，可不填" }]);
  const lk = coord.approvalRowView(apv("lock", { id: "lock:7:1790000000000", title: "device:test-phone", detail_ref: { type: "lock", id: 7, resource: "device:test-phone" }, labels: { approve: "强制释放", reject: "保留" } }));
  assert.deepEqual([lk.kind, lk.open, lk.key], ["逾期锁", { type: "lock", resource: "device:test-phone" }, "lock:7"]);
  assert.deepEqual(lk.actions.map((x) => [x.label, x.armed, x.needsNote]), [["强制释放", "再按=确认强制释放", true], ["保留", "再按=确认保留", false]]);
  assert.deepEqual(lk.note, { required: true, max: 200, label: "释放理由", placeholder: "释放理由，必填" }, "理由随备注进流水,上限跟服务端的强制释放理由一致");
  const req = coord.approvalRowView(apv("request", { risk: "high", detail_ref: { type: "request", id: 9 }, labels: undefined }));
  assert.deepEqual([req.kind, req.actions.map((x) => x.label)], ["执行者请求 · 高风险", ["批准", "拒绝"]]);
  const odd = coord.approvalRowView({ id: "future:1:1", kind: "future_kind", risk: "toString", title: "", summary: undefined, actions: ["approve", "escalate"], detail_ref: null });
  assert.deepEqual([odd.kind, odd.title, odd.summary, odd.blocked, odd.createdAt, odd.actions.map((x) => x.decision)], ["待核实 · 待核实", "待核实", "", "", null, ["approve"]],
    "未知的种类和风险写「待核实」,认不得的动作不给按钮");
  // 第三波:执行者请求写完整 action;放行确认的标记换成徽标并列出工作目录、权限、预算与收回原因;版本确认第一下展开的内容。
  const full = "重启共享设备上的应用并清掉".repeat(20);
  assert.equal(coord.approvalRowView(apv("request", { summary: full.slice(0, 159) + "…", action: full, detail_ref: { type: "request", id: 9 } })).summary, full);
  const rel = coord.approvalRowView(apv("release", { summary: "【再次放行】【配置已变化】Claude CLI · m · high:改首页", rerun: true, held_note: "租约到期，结果未知",
    execution_profile: { workspace_path: "C:\\work\\repo", tools: "read-only", budget: { max_cost_usd: 2, timeout_sec: 1800, max_turns: 30 }, configuration_changed: true } }));
  assert.deepEqual([rel.summary, rel.flags.map((f) => [f.label, f.tone]), rel.facts.map(([k, v]) => k + " " + v)],
    ["Claude CLI · m · high:改首页", [["再次放行", "warn"], ["配置已变化", "warn"]],
     ["工作目录 C:\\work\\repo", "权限 只读", "预算 金额上限 2 美元 · 时限 30 分钟 · 最多 30 轮", "收回原因 租约到期，结果未知"]]);
  const vr = coord.approvalRowView(apv("version", { id: "version:bless:t.0", detail_ref: { type: "setup" }, confirm: "确认版本 abc\n\n  a.js | 2 +-\n\n确认之后执行线才会用这个版本起跑。",
    changes: { prev: "p", files: 1, stat: ["a.js | 2 +-", " 1 file changed"], more: 0 } }));
  assert.deepEqual([vr.actions.map((x) => x.review), vr.review], [[true, false], { confirm: "确认版本 abc\n\n  a.js | 2 +-\n\n确认之后执行线才会用这个版本起跑。",
    head: "上次确认后改了 1 个文件", stat: ["a.js | 2 +-", "1 file changed"], more: "" }], "清单里有确认说明没写到的行时另列");

  // 上膛的字:再按=确认 + 原按钮文字。
  assert.equal(coord.armedLabel("更新并重启"), "再按=确认更新并重启");
  assert.equal(coord.armedLabel("吊销"), "再按=确认吊销");
  assert.equal(coord.armedLabel(" 批准 "), "再按=确认批准");

  // 远程入口那一句。
  assert.equal(coord.aptRemoteLine({ enabled: false, listening: [], allow_ips: [] }), "远程入口已关闭。在配置里打开 remote_access。");
  assert.equal(coord.aptRemoteLine(null), "远程入口已关闭。在配置里打开 remote_access。");
  assert.equal(coord.aptRemoteLine({ enabled: true, listening: ["192.168.1.5:47830"], allow_ips: ["192.168.1.20", "192.168.1.21"], errors: [] }),
    "远程入口：192.168.1.5:47830 · 允许来源 192.168.1.20、192.168.1.21");
  assert.equal(coord.aptRemoteLine({ enabled: true, listening: [], allow_ips: [], errors: ["0.0.0.0:47830"] }), "远程入口：未在监听 · 允许来源 未设置 · 监听失败 0.0.0.0:47830");
  const token = coord.aptTokenView({ id: 4, label: "手机", created_at: ago(600), last_used_at: ago(3), active: true }, T);
  assert.deepEqual([token.no, token.label, token.used, token.revoke], ["#4", "手机", "最近使用 3 分钟前", "吊销"]);
  assert.equal(coord.aptTokenView({ id: 5, label: "", created_at: ago(1) }, T).used, "未使用");

  // 交接与流水。
  const hand = { id: 3, executor: "a", reason: "heartbeat_stale", created_at: ago(5), package: { executor: { id: "a", name: "甲" }, goal: "回归首页", done: ["改了状态条"],
    next: ["跑测试", { omitted: true, see: "full_status.next[1]", chars: 400 }], journal: { recent_ids: [12, 13] }, locks: [{ resource: "device:test-phone", purpose: "回归", overdue: true }, { resource: "repo:main", purpose: "" }] } };
  const row = coord.coordHandoffView(hand, [{ holder: "a" }, { holder: "b" }]);
  assert.deepEqual([row.no, row.who, row.reason, row.goal, row.locks, row.state.label, row.state.tone, row.pack], ["#3", "甲", "心跳中断", "回归首页", "仍持有 1 把锁", "待接手", "quiet", "查看交接包"]);
  assert.equal(coord.coordHandoffView(hand, []).locks, "不持锁", "锁放掉以后不再写仍持有");
  assert.equal(coord.coordHandoffView(hand).locks, "仍持有 2 把锁", "没给现在的锁表就按交接包里记的算");
  assert.deepEqual([coord.coordHandoffView({ id: 4, executor: "x", reason: "stop", package: {} }).reason, coord.coordHandoffView({ id: 4, executor: "x", reason: "hasOwnProperty", package: {} }).reason], ["主动停止", "待核实"]);
  const pack = coord.coordHandoffPack({ ...hand, full_status: { done: ["改了状态条"], next: ["跑测试", "补 390 宽的截图"] } });
  assert.deepEqual(pack, { sections: [["已完成", ["改了状态条"]], ["下一步", ["跑测试", "补 390 宽的截图"]], ["交接时仍持有的锁", ["device:test-phone · 回归 · 逾期", "repo:main"]]],
    journal: "最近流水编号 #12 #13", ackLabel: "接手方运行", command: "board.py handoff ack 3" });
  assert.deepEqual(coord.coordHandoffPack(hand).sections[1], ["下一步", ["跑测试"]], "没有全文时只列交接包里整项保留的");
  assert.deepEqual(["operator", "system", "ext-a", ""].map((executor) => coord.coordJournalView({ at: ago(1), executor, body: "x" }).who), ["操作员", "看板", "ext-a", "待核实"]);
  // 文案表:空态与小标题逐句。
  const C = coord.COORD_COPY;
  assert.deepEqual([C.empty.journal, C.empty.locks, C.empty.handoffs, C.empty.approvals, C.empty.execs.join("")],
    ["还没有流水。", "没有被锁的资源。", "没有待接手的交接。", "没有要你批准的事项。", "用 board.py exec register 登记第一个执行者。"]);
  assert.deepEqual(C.head, { approvals: "待你批准", execs: "执行者", external: "外部执行线", locks: "资源锁", handoffs: "待接手的交接", journal: "最近流水" });
  assert.equal(C.unknown, "待核实");
});

// ══ 文案闸(卡 #16):给 docs/style-guide.md「不写注释性语句」装一个机器闸 ══════════════
//  为什么:卡 #9 清掉了二十多句注释性文案,但规则落地只有纪律 —— 下一个写引导步骤、错误文案或页脚
//  说明的人(人或模型)照旧能写回「(开始干活前需要)」「—— 其实…」,没有任何机器会出声。文案最容易
//  悄悄回潮:#9 清掉的那些,有好几句就是历次迭代一层层加上去的。
//
//  ⚠ 这个闸**不是全量扫描**,够得到的面只有下面四个;够不到的明说,不假装:
//   A core/server.mjs 的上手引导四个函数(blessStep / upgradeState / setupState / acceptPreview)与批准事项
//     四个函数(taskApprovalEntry / versionApprovalEntry / lockApprovalEntry / requestApprovalEntry)里的
//     字面量 —— 这一面是全量的:那几个函数产出的 title/detail/hint/label/confirm/summary 全从这里来。
//   D core/panel.html 的 coord-copy 段(设置页协作区的文案表与纯函数)—— 整段的字面量,全量。
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
  { file: "core/server.mjs", line: 2977, text: "—— 当前运行状态 ——",
    why: "taskApprovalEntry 里切分 result 用的分隔符,与 core/store.js 收回放行时写进 result 的标记同值;不显示给人看" },
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
  // ── A 面:上手引导的四个函数,加批准事项的四个函数(待你批准那几行的标题、摘要、按钮字都从这里来)
  for (const head of ["function blessStep() {", "function upgradeState() {", "function setupState() {",
                      "function acceptPreview(tree, prev) {", "function taskApprovalEntry(t) {",
                      "function versionApprovalEntry(op = null) {", "function lockApprovalEntry(l) {",
                      "function requestApprovalEntry(r) {"])
    for (const lit of literalsOf(fnSlice(head)))
      for (const rule of copyFindings(lit.text)) found.push({ file: "core/server.mjs", ...lit, rule });

  // ── D 面:设置页协作区的文案段(coord-copy),整段字面量
  const coordLits = literalsOf(coordSource), coordLine = source.slice(0, source.indexOf(coordSource)).split("\n").length - 1;
  assert.ok(coordLits.length > 60, "coord-copy 段的字面量没扫到");
  for (const lit of coordLits)
    for (const rule of copyFindings(lit.text)) found.push({ file: "core/panel.html", ...lit, line: lit.line + coordLine, rule });

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

// ── 流转条 / 首页按目标归组 / 卡详情「历史」(合同 B;core/panel.html 的 flow-copy 段) ──
const flowSource = panelSection("// ── flow-copy(pure;tests/panelcopytest.mjs)──", "// ── /flow-copy ──");
const flow = new Function(flowSource + "\nreturn { FLOW_STEP_NAMES, flowUsable, flowNeed, flowDots, flowPhrase, flowBack, flowTotal, homeGroups, historyRow, historyPick, flowItemNote, goalCountOf };")();

test("流转条行下那行字读行项自己的 live_note;目标组头 d/n 优先用服务端同口径的数", () => {
  const card = { status: "in_progress", live_note: "看板卡上的旧句" };
  assert.equal(flow.flowItemNote({ status: "in_progress", live_note: " 读第二章 " }, card), "读第二章");
  assert.equal(flow.flowItemNote({ status: "in_progress", live_note: null }, card), "", "行项给了 null 就不显示,不退到卡上的");
  assert.equal(flow.flowItemNote({ status: "waiting", live_note: "x" }, card), "", "只在进行中显示");
  assert.equal(flow.flowItemNote({ status: "in_progress" }, card), "看板卡上的旧句", "旧服务端没有这个键才看卡");
  const kids = [{ status: "done" }, { status: "in_progress" }, { status: "done", archived_at: "t" }];
  assert.deepEqual(flow.goalCountOf({ children_done: 2, children_total: 3 }, kids), { done: 2, total: 3 });
  assert.deepEqual(flow.goalCountOf({}, kids), { done: 1, total: 2 }, "没有服务端字段:按本地未归档子卡");
});

test("流转条：progress 缺或为 null 不画，五步点与侧栏同名，只有在等你的一步亮", () => {
  for (const p of [null, undefined, {}, { items: [] }, { items: "x" }]) assert.equal(flow.flowUsable(p), false);
  assert.equal(flow.flowUsable({ items: [{ id: 1 }] }), true);
  assert.deepEqual(flow.FLOW_STEP_NAMES, ["放行", "领取", "启动", "回传", "验收"]);
  const states = (item) => flow.flowDots(item).map((d) => d.state).join(",");
  assert.equal(states({ status: "not_started", released: false, step: 0 }), "now,todo,todo,todo,todo", "未放行 = 第一步轮到你");
  assert.equal(states({ status: "not_started", released: true, step: 1 }), "done,todo,todo,todo,todo");
  assert.equal(states({ status: "in_progress", released: true, step: 3 }), "done,done,done,todo,todo", "执行中不亮强调");
  assert.equal(states({ status: "waiting", waiting_for: "review", released: true, step: 4 }), "done,done,done,done,now", "待验收 = 最后一步轮到你");
  assert.equal(states({ status: "done", step: 5 }), "done,done,done,done,done");
  assert.equal(states({ status: "in_progress", step: "x" }), "todo,todo,todo,todo,todo", "step 不合格不猜");
});

test("流转条：当前状态短语与「已打回 n 次」", () => {
  const p = (item) => flow.flowPhrase(item, (l) => "线" + l);
  assert.deepEqual(p({ status: "in_progress", step: 3, runtime: "zcode", line: "a" }), { text: "Zcode 在做", need: false });
  assert.deepEqual(p({ status: "in_progress", step: 2, worker: "w-1" }), { text: "w-1 已领取", need: false });
  assert.deepEqual(p({ status: "in_progress", step: 3, line: "a" }), { text: "线a 在做", need: false });
  assert.deepEqual(p({ status: "in_progress", step: 3, worker: "zcode", started_via: "self_report" }), { text: "zcode 在做 · 对方自报", need: false }, "外部执行者:措辞标明证据是对方自报");
  assert.deepEqual(p({ status: "in_progress", step: 3, line: "a", started_via: "process" }), { text: "线a 在做", need: false });
  assert.deepEqual(p({ status: "waiting", waiting_for: "review", step: 4 }), { text: "待你验收", need: true });
  assert.deepEqual(p({ status: "waiting", waiting_for: "decision" }), { text: "待你决定", need: true });
  assert.deepEqual(p({ status: "waiting", waiting_for: "dep" }), { text: "等待中", need: false });
  assert.deepEqual(p({ status: "not_started", released: false, step: 0 }), { text: "待你放行", need: true });
  assert.deepEqual(p({ status: "not_started", released: true, step: 1 }), { text: "等领取", need: false });
  assert.deepEqual(p({ status: "not_started", released: true, step: 1, handed_back: 1 }), { text: "打回后排队", need: false });
  assert.deepEqual(p({ status: "done", step: 5 }), { text: "已完成", need: false });
  assert.equal(p({ status: "in_progress", step: 3, runtime: "constructor" }).text, "执行中", "原型键不当执行器名");
  assert.equal(flow.flowBack(1), "已打回 1 次");
  for (const n of [0, null, undefined, -1, 1.5, "2"]) assert.equal(flow.flowBack(n), "", String(n));
  assert.deepEqual(flow.flowTotal({ total: 5, done: 3, items: [] }), { done: 3, total: 5, text: "3/5 完成", ratio: 0.6 });
  assert.equal(flow.flowTotal({ items: [{ status: "done" }, { status: "waiting" }] }).text, "1/2 完成", "缺 total/done 按行数");
});

test("首页「正在执行」按目标归组：同一目标归进第一次出现的位置，不属于目标的照旧", () => {
  const items = [{ k: 1, g: 9 }, { k: 2 }, { k: 3, g: 9 }, { k: 4, g: 8 }];
  const info = { 9: { title: "目标甲", done: 2, total: 5 }, 8: { title: "目标乙", done: 0, total: 1 } };
  const groups = flow.homeGroups(items, (x) => x.g ?? null, (id) => info[id] || null);
  assert.deepEqual(groups.map((g) => [g.goal && g.goal.text, g.items.map((x) => x.k)]), [["2/5", [1, 3]], [null, [2]], ["0/1", [4]]]);
  assert.equal(groups[0].goal.title, "目标甲");
  assert.deepEqual(flow.homeGroups([{ k: 1, g: 7 }], (x) => x.g, () => null).map((g) => g.goal), [null], "目标读不到就不归组");
});

test("卡详情「历史」：时间 · 谁 · 做了什么，新的在上，最多 20 条", () => {
  assert.deepEqual(flow.historyRow({ at: "t", actor_kind: "human", step: "released", summary: "放行" }), { at: "t", who: "你", what: "放行", back: false });
  assert.deepEqual(flow.historyRow({ at: "t", actor_kind: "human", step: "handed_back", summary: "打回：缺测试" }), { at: "t", who: "你", what: "打回：缺测试", back: true });
  assert.equal(flow.historyRow({ actor_kind: "line", actor: "a", step: "claimed" }, (l) => "线" + l).who, "线a");
  assert.deepEqual(flow.historyRow({ at: "t", actor: "你", actor_kind: "human", step: "handed_back", summary: "你打回,回原线重做:缺测试" }),
    { at: "t", who: "你", what: "打回,回原线重做:缺测试", back: true }, "summary 以谁开头时不重复");
  assert.equal(flow.historyRow({ actor: "看板", actor_kind: "system", step: "reaped", summary: "租约超时,收回等重新领取" }).what, "租约超时,收回等重新领取");
  assert.equal(flow.historyRow({ actor_kind: "auto", step: "accepted" }).who, "自动审阅");
  assert.equal(flow.historyRow({ actor_kind: "system", step: "reaped" }).what, "回收", "没有 summary 按 step 写");
  assert.equal(flow.historyRow({ actor_kind: "system", step: "reaped" }).who, "看板");
  assert.equal(flow.historyRow({ actor_kind: "executor", actor: "zc-1", step: "constructor" }).what, "其他");
  const entries = Array.from({ length: 25 }, (_, i) => ({ n: i }));
  const short = flow.historyPick(entries);
  assert.equal(short.rows.length, 20); assert.equal(short.hidden, 5); assert.equal(short.rows[0].n, 24, "新的在上");
  assert.equal(flow.historyPick(entries, true).rows.length, 25);
  assert.deepEqual(flow.historyPick(null), { rows: [], hidden: 0 });
});

test("流转相关的界面接线：容错与文案", () => {
  assert.ok(source.includes('if (r.status === 404) { mine.missing = true;'), "history 接口 404 → 暂无记录");
  assert.ok(source.includes('"暂无记录"'));
  assert.ok(source.includes('homeEl("summary", "历史")'), "侧栏历史分节");
  assert.ok(source.includes('"显示全部（还有 " + pick.hidden + " 条）"'));
  assert.ok(source.includes('d.type.startsWith("task.") && d.id != null) flashMark(d.id)'), "SSE task.* 带卡号 → 刚更新标记");
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)\{ \.just\{animation:none;/);
  assert.ok(source.includes("if (flowBack(t.handed_back)) meta2.push("), "卡面打回次数徽标");
  assert.ok(source.includes('t.status === "in_progress" && typeof t.live_note === "string"'), "live_note 只在进行中显示");
  assert.match(source, /typeof t\.live_note === "string" && t\.live_note\.trim\(\)\)\n\s*body \+= `<p class="live-note"/, "看板卡的 live_note 在卡面上,不进默认折叠的展开区");
});

// ── 第 2 波:接入的 AI / 本地会话 / 效率(合同 A / D / C;core/panel.html 的 wave2-copy 段) ──
const w2Source = panelSection("// ── wave2-copy(pure;tests/panelcopytest.mjs)──", "// ── /wave2-copy ──");
const w2 = new Function(w2Source + "\nreturn { AI_KINDS, aiKindName, aiState, aiReport, aiCodeLeft, deskSize, deskLineRef, deskBlocked, deskRegisterConfirm, aiIssueError, deskRows, deskMsg, deskLineError, EFF_METRICS, effValue, effDelta, effGroupName, effDaily, effQuery };")();

test("接入的 AI：状态徽标六种，撤销优先，未知值写待核实", () => {
  const t = (e) => w2.aiState(e).text;
  assert.equal(t({ state: "working" }), "在做");
  assert.equal(t({ state: "idle" }), "空闲");
  assert.equal(t({ state: "stalled" }), "卡住");
  assert.equal(t({ state: "offline" }), "离线");
  assert.equal(t({ state: "working", revoked: true }), "已撤销", "撤销优先");
  assert.equal(t({ state: "offline", pending_code: true, last_seen_at: null }), "等待接入");
  assert.equal(t({ state: "offline", pending_code: true, last_seen_at: "2026-11-11T00:00:00Z" }), "离线", "接入过的再发码不算等待接入");
  for (const e of [null, {}, { state: "constructor" }, { state: "future" }]) assert.equal(t(e), "状态待核实");
  assert.equal(w2.aiState({ state: "stalled" }).tone, "warn", "卡住用警示色;强调色留给首页「待我处理」");
  assert.ok(!["working", "idle", "offline"].some((s) => w2.aiState({ state: s }).tone === "need"), "设置页徽标不用强调色");
  assert.equal(w2.aiKindName("zcode"), "Zcode"); assert.equal(w2.aiKindName("x"), "其他");
  assert.equal(w2.aiReport(null), "还没回报");
  assert.equal(w2.aiReport({ task_id: 12, at: "T", outcome: "done" }, (s) => "@" + s), "@T · 交付 #12");
  assert.equal(w2.aiReport({ task_id: 12, outcome: "wait" }), "停下等你决定 #12");
  const now = Date.parse("2026-11-11T00:00:00Z");
  assert.equal(w2.aiCodeLeft("2026-11-11T00:09:41Z", now), "9:41");
  assert.equal(w2.aiCodeLeft("2026-11-11T00:00:00Z", now), null, "到时 = 过期");
  assert.equal(w2.aiCodeLeft("x", now), null);
});

test("本地会话：体量、筛选排序、看历史一条、登记的错误码", () => {
  const c = (n) => n + "!";
  const th = { tokens: 200000, bytes: 4 * 1048576 };
  assert.deepEqual(w2.deskSize({ approx_tokens: 1000 }, c, th), { text: "约 1000! 词元", large: false });
  assert.equal(w2.deskSize({ approx_tokens: 200001 }, c, th).large, true, "阈值用服务端给的 threshold_tokens");
  assert.equal(w2.deskSize({ approx_tokens: 200001 }, c, { tokens: 300000 }).large, false, "阈值不写死:服务端给多少按多少");
  assert.equal(w2.deskSize({ approx_tokens: null, size_bytes: 5 * 1048576 }, String, th).large, true, "无用量记录按 threshold_bytes");
  assert.equal(w2.deskSize({ approx_tokens: 9e9 }).large, false, "服务端没给阈值就不标大(登记时服务端再判)");
  assert.ok(!source.includes("DESK_LARGE_TOKENS") && !source.includes("4 * 1024 * 1024"), "面板里没有硬编码的 200k / 4MB");
  // 列表项 line 的最终形 {id,label};label 缺或等于 id 时用面板线名
  assert.deepEqual(w2.deskLineRef({ id: "claude-1a2b3c4d", label: "Claude 会话 1a2b3c4d" }), { id: "claude-1a2b3c4d", label: "Claude 会话 1a2b3c4d" });
  assert.deepEqual(w2.deskLineRef({ id: "x", label: "x" }, (l) => "线" + l), { id: "x", label: "线x" });
  assert.deepEqual(w2.deskLineRef("x", (l) => "线" + l), { id: "x", label: "线x" }, "旧服务端给字符串也认");
  assert.equal(w2.deskLineRef(null), null); assert.equal(w2.deskLineRef({}), null);
  assert.equal(w2.deskBlocked({ code: "SEAT_LOCKED", message: "codex 座席未解禁" }), "起不来：codex 座席未解禁");
  assert.equal(w2.deskBlocked(null), "");
  const ask = w2.deskRegisterConfirm("约 30万 词元", "20万 词元", true);
  assert.ok(ask.includes("这条线带着那段会话的全部内容，它交付的证据其它执行者读得到"), "P1:确认框写明数据外流面");
  assert.ok(ask.includes("约 30万 词元") && ask.includes("超过 20万 词元"));
  assert.ok(!w2.deskRegisterConfirm("约 1千 词元", "", false).includes("体量"), "小会话不提体量");
  assert.match(w2.aiIssueError(409, { code: "TOO_MANY_PENDING_CODES", error: "x" }), /^已有 5 个接入码在等对方使用/);
  assert.match(w2.aiIssueError(400, { code: "ROLE_NOT_AVAILABLE" }), /还没开放/);
  assert.equal(w2.aiIssueError(500, {}), "没有发出接入码：状态 500");
  assert.equal(w2.deskSize({ approx_tokens: null, size_bytes: 2048 }).text, "2 KB");
  assert.deepEqual(w2.deskSize({}), { text: "体量待核实", large: false });
  const list = [{ source: "claude", id: "a", title: "甲 报表", updated_at: "2026-11-01" }, { source: "codex", id: "b", title: "乙", updated_at: "2026-11-09" },
                { source: "claude", id: "c", title: "丙 报表", updated_at: "2026-11-10" }, { source: "claude", id: "d", title: null, updated_at: "2026-11-11" }];
  assert.deepEqual(w2.deskRows(list, { source: "claude" }).map((s) => s.id), ["d", "c", "a"], "只留这一家,新的在前");
  assert.deepEqual(w2.deskRows(list, { source: "claude", q: "报表" }).map((s) => s.id), ["c", "a"]);
  assert.deepEqual(w2.deskRows(null), []);
  assert.deepEqual(w2.deskMsg({ role: "user", text: "做 X", tools: 0 }), { who: "你", text: "做 X", tools: "", at: "" });
  assert.equal(w2.deskMsg({ role: "assistant", text: "", tools: 3 }).tools, "用了 3 次工具");
  assert.equal(w2.deskLineError(404, { code: "SESSION_UNKNOWN" }), "这段会话读不到了");
  assert.equal(w2.deskLineError(404, { code: "NOT_A_DESKTOP_LINE", error: "线 x 不是从桌面会话登记的线" }), "线 x 不是从桌面会话登记的线", "解除被拒照应答文案");
  assert.equal(w2.deskLineError(409, { code: "ALREADY_A_LINE", line: "claude-1a2b3c4d" }), "这个会话已经登记成线 claude-1a2b3c4d");
  assert.equal(w2.deskLineError(409, { code: "LINEAGE_HANDWRITTEN", error: "写在手写配置里" }), "写在手写配置里", "照应答的原因写");
  assert.equal(w2.deskLineError(500, {}), "没有完成，状态 500");
});

test("效率：八个指标、未知写待核实、升降用文字、逐日细条、时间范围", () => {
  assert.deepEqual(w2.EFF_METRICS.map((m) => m[1]), ["完成", "打回", "一次通过率", "交付周期中位数", "等你的时长中位数", "你的操作次数", "AI 干活时长", "平均同时在跑"]);
  assert.equal(w2.effValue(null, "count"), "待核实", "未知不当 0");
  assert.equal(w2.effValue(0, "count", "张"), "0 张");
  assert.equal(w2.effValue(0.5, "rate"), "50%");
  assert.equal(w2.effValue(1.28, "avg", "条线"), "1.3 条线");
  assert.equal(w2.effValue(120000, "dur"), "2 分");
  assert.deepEqual(w2.effDelta(4, 1, "count", "张"), { dir: "up", text: "升 3 张" });
  assert.deepEqual(w2.effDelta(0.5, 1, "rate"), { dir: "down", text: "降 50 个百分点" });
  assert.deepEqual(w2.effDelta(2, 2, "count"), { dir: "flat", text: "持平" });
  assert.deepEqual(w2.effDelta(5, null, "count"), { dir: null, text: "待核实" }, "上期未知 = 不比");
  assert.deepEqual(w2.effDelta(90000, 60000, "dur").dir, "flat", "差不到一分钟算持平");
  assert.equal(w2.effGroupName({ key: null, label: "未指定" }, "line"), "未指定");
  assert.equal(w2.effGroupName({ key: "a" }, "line", (l) => "线" + l), "线a");
  assert.equal(w2.effGroupName({ key: "codex", label: "Codex" }, "runtime"), "Codex");
  const days = w2.effDaily([{ date: "2026-11-09", created: 0, done: 1 }, { date: "2026-11-10", created: 2, done: 4 }]);
  assert.deepEqual(days.map((d) => [d.hc, d.hd, d.tip]), [[0, 25, "11-09 新挂 0 · 完成 1"], [50, 100, "11-10 新挂 2 · 完成 4"]]);
  assert.deepEqual(w2.effDaily(null), []);
  assert.equal(w2.effQuery("week", "line"), "/api/efficiency?by=line", "缺省 = 本周对上周");
  assert.equal(w2.effQuery("d30", "runtime", new Date(2026, 10, 11)), "/api/efficiency?from=2026-10-13&to=2026-11-11&by=runtime", "近 30 天含今天");
  assert.equal(w2.effQuery("week", ""), "/api/efficiency");
});

test("第 2 波的界面接线：新文案、旧代劳按钮留着、接口缺席写一句", () => {
  for (const s of ['data-toc="set-ai">接入的 AI<', 'data-toc="set-desk">本地会话<', ">接入一个 AI<", "请协调席代劳(旧)",
                   "勾选的会话可以登记成一条来领任务的线；领卡时用它的副本，原会话不动。",
                   '"下一步：把配置粘到对方的 MCP 设置里，再把提示词发给它。"', '"要粘贴的配置"', '"开工提示词"', '"接入码已过期"', '"重新发码"',
                   '"这个版本还没有接入功能"', '"这个版本还没有本地会话功能"', '"这个版本还没有效率统计"', '"这段会话读不到了"',
                   '" · 还没启动"', '"去起线"', '"登记成线"', '"看历史"', '"更早"', '"本周对上周"', '"近 30 天对前 30 天"', '"按线"', '"按执行器"',
                   "docs/效率口径.md「每个数怎么算」"])
    assert.ok(source.includes(s), s);
  for (const q of ["propose-lines", "mount-sentries", "install-worker-constraints", "enable-review", "board-briefing"])
    assert.ok(source.includes(`data-quick="${q}"`), "旧代劳按钮保留:" + q);
  assert.ok(/<details class="ai-legacy" id="ai-legacy">(?![^]*<details class="ai-legacy"[^>]*open)/.test(source), "旧代劳默认折叠");
  assert.ok(!source.includes('id="set-quick"'), "旧一节的位置换成「接入的 AI」");
  assert.ok(source.includes('if (d.type === "executor.changed") aiLoad();'), "executor.changed 重读");
  assert.ok(source.includes('v.code === "NEEDS_CONFIRM_LARGE"') && source.includes("r = await send(true);"), "大体量先确认再带 confirm_large 重发");
  assert.ok(source.includes('<p class="home-eff" id="home-eff" hidden></p>'), "首页效率一行读不到不出");
  // 效率块不用强调色:箭头与差值都是 --dim
  assert.match(source, /\.eff-d,\.eff-arrow\{color:var\(--dim\)\}/);
});

test("接真接口后的收口:live_note 只改那一处、登记确认框、刚登记的线用 201 的显示名", () => {
  // F4 面板部分:task.live_note 在整页 refresh() 之前返回,只读那一张卡
  const h = source.slice(source.indexOf('es.addEventListener("change"'), source.indexOf("// Worker stdout arrives per line"));
  const at = h.indexOf('d.type === "task.live_note"');
  assert.ok(at > 0 && h.slice(at, at + 120).includes("liveNoteChanged(d.id); return;") && at < h.lastIndexOf("refresh();"), "live_note 不走整页刷新");
  const fn = source.slice(source.indexOf("function liveNoteChanged("), source.indexOf("// SSE: pushed on change only"));
  assert.ok(fn.includes('fetch("/api/tasks/" + id') && !fn.includes("refresh()") && !fn.includes("render()"), "只读一张卡,不重读、不重画整页");
  // 联调发现:设置页开着时卡的领取/交付要立刻反映到「接入的 AI」(不等 10 秒巡检)
  assert.ok(h.includes('if (homeView === "settings" && typeof d.type === "string" && d.type.startsWith("task.")) aiLoad();'));
  assert.ok(fn.includes(".live-note") && fn.includes(".fr-note") && fn.includes("createTextNode(text)"), "卡面与流转条行就地换字(文本通道)");
  // 登记成线:先确认(P1),确认过大体量就直接带 confirm_large;201 的 label 与 start_blocked 直接用
  const reg = source.slice(source.indexOf("async function deskRegister("), source.indexOf("async function deskUnlink("));
  assert.ok(reg.indexOf("confirm(deskRegisterConfirm(") < reg.indexOf("await send("), "先确认再发");
  assert.ok(reg.includes("s.line = deskLineRef(v.line, lineLabel)") && reg.includes("s.start_blocked = v.start_blocked"));
  assert.ok(source.includes("aiNote.textContent = aiIssueError(r.status, v);"), "发码错误码给人话");
  // 侧栏五步条「启动」:外部执行者取第一次心跳,title 写明看板没有观察到进程
  const ss = source.slice(source.indexOf("function sideSteps("), source.indexOf("function sideRelationshipBox("));
  assert.ok(ss.includes('steps.push(["启动", at(t.self_reported_started_at) || "对方自报", "done", "外部执行者自报，看板没有观察到进程"]);') && ss.includes("if (tip) li.title = tip;"));
});
