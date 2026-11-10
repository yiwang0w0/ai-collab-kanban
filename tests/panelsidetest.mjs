import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../core/panel.html", import.meta.url), "utf8");

function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `未找到面板测试边界：${start}`);
  return source.slice(a, b);
}

function declaration(name) {
  const a = source.indexOf(`function ${name}(`), b = source.indexOf("\n}", a);
  assert.ok(a >= 0 && b > a, `未找到面板函数：${name}`);
  return source.slice(a, b + 2);
}

// 只模拟侧栏实际用到的节点操作，不安装浏览器或另建一套界面实现。
function fixture(extra = {}) {
  let clock = 1_800_000_000_000;
  const document = { activeElement: null, addEventListener() {} };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
      this.hidden = false; this.value = ""; this.className = ""; this.id = "";
      this.selectionStart = 0; this.selectionEnd = 0; this.text = ""; this.replacements = 0;
      this.style = { setProperty() {} };
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter((n) => !names.includes(n)).join(" "); },
        contains: (name) => this.className.split(/\s+/).includes(name),
        toggle: (name, on) => { if (on) this.classList.add(name); else this.classList.remove(name); },
      };
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map((e) => e.textContent ?? String(e)).join(""); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.replacements++; this.text = ""; this.children = nodes; }
    addEventListener() {}
    setAttribute(name, value) {
      if (name === "id") this.id = String(value);
      else if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      else this[name] = String(value);
    }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    matches(selector) {
      if (selector.startsWith("#")) return this.id === selector.slice(1);
      const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
      for (const [, name, , value] of selector.matchAll(/\[data-([\w-]+)(?:=(["'])(.*?)\2)?\]/g)) {
        const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (!(key in this.dataset) || (value !== undefined && this.dataset[key] !== value)) return false;
      }
      return true;
    }
    querySelectorAll(selector) {
      const found = [];
      for (const child of this.children) if (child instanceof Element) {
        if (child.matches(selector)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  document.createElement = (tag) => new Element(tag);
  const root = new Element("aside"); root.id = "task-side";
  for (const [tag, id] of [["h2", "task-side-title"], ["button", "task-side-close"], ["div", "task-side-body"]]) {
    const node = new Element(tag); node.id = id; root.append(node);
  }
  document.getElementById = (id) => root.id === id ? root : root.querySelector("#" + id);
  document.querySelector = (selector) => root.querySelector(selector);
  document.querySelectorAll = (selector) => root.querySelectorAll(selector);
  const task = { id: 7, task_uid: "fixture-node/task-7", subject: "侧栏任务", line: "engine", kind: "task",
    status: "in_progress", aggregate_version: 3, heartbeat_at: clock, lease_until: clock + 600_000,
    last_runtime: "codex", parent_id: null, blocked_by: [], ...extra };
  const context = vm.createContext({
    document, now: () => clock, tasks: [task], byId: new Map([[task.id, task]]),
    sideRef: { id: task.id, uid: task.task_uid, item: null }, sideSig: "", workers: [],
    meta: { wf_labels: { review: "审阅" } }, verdictDraft: new Map(), fleetApi: null, REVIEW_LINES: [],
    // 留言跟随用面板自己的 syncHandoff;方案包不在这些用例里,syncDecision 不会被走到。
    taskForView: (id) => context.byId.get(Number(id)), PROFILE_RELEASE_NOTE: "取消放行说明",
    homeMulti: () => false, homeLocalName: () => "本机", lineLabel: (line) => line,
    // 跨机数据:默认单机(没有多机列表、没有委派记录);用例按需放进夹具。
    homeFleet: null, homeActions: null, sideDetail: null, homeGet: async () => ({}), copyError: (e) => String(e?.message || e),
    history: { replaceState() {} }, location: { hash: "", pathname: "/", search: "" }, URLSearchParams,
    homeEl: (tag, text, cls) => {
      const node = new Element(tag);
      if (text !== undefined) node.textContent = text;
      if (cls) node.className = cls;
      return node;
    },
  });
  const pure = section("// ── home-model(pure;tests/hometest.mjs)──", "// ── /home-model ──");
  const side = section("function sideCard(){", "function sideFromHash(){");
  vm.runInContext([pure, declaration("ago"), declaration("localTime"), declaration("hbClass"), declaration("tick"), declaration("syncHandoff"), side].join("\n"), context);
  return { context, task, root, document, setTime: (value) => { clock = value; }, time: () => clock,
    body: document.getElementById("task-side-body"), state: () => document.getElementById("task-side-state") };
}

test("放行前的核对与放行按钮直接可见，执行者材料继续折叠；步骤条放行前后都在详细说明之外", () => {
  const f = fixture({ status: "not_started", released: false, execution_profile: {
    channel: "codex_cli", label: "订阅执行", model: "fixture-model", effort: "high",
    auth_kind: "chatgpt", billing_kind: "subscription", workspace: { path: "C:/fixture/project" },
    tools: "write", budget: { timeout_sec: 600 }, profile_digest: "fixture-digest", ready: true,
  } });
  Object.assign(f.context, { executionChannelName: (v) => v, executionAuthName: (v) => v,
    executionBillingName: (v) => v, effortName: (v) => v, executionBudgetText: () => "600 秒" });
  f.context.renderSide();
  const execution = f.document.getElementById("task-side-execution");
  const detail = f.document.getElementById("task-side-detail");
  assert.ok(f.body.children.includes(execution), "当前放行核对不能藏在关闭的详细说明中");
  assert.match(execution.textContent, /C:\/fixture\/project.*权限.*预算.*600 秒.*放行此任务/);
  assert.ok(execution.querySelector('[data-a="release"]'));
  assert.ok(!detail.open && !detail.querySelector("#task-side-execution"));
  assert.match(execution.textContent, /^放行前核对执行配置交给「engine」/, "节首写交给哪条线");
  assert.equal(execution.querySelector("details.side-rec"), null, "放行前核对时逐项记录摊开不收");
  f.task.released = true; f.task.aggregate_version++; f.context.renderSide();
  // 守的语义不变:操作者不用展开「给执行者看的详细说明」就能看到派发进度;放行后只把逐项记录折起来。
  const after = f.document.getElementById("task-side-execution"), folded = f.document.getElementById("task-side-detail");
  assert.ok(f.body.children.includes(after) && !folded.querySelector("#task-side-execution"), "放行后步骤条仍在详细说明之外");
  assert.ok(f.body.children.indexOf(after) === 1 && f.body.children.indexOf(folded) === 2, "步骤条紧跟给人看的小块，在详细说明之前");
  assert.ok(after.querySelector("ol.steps"), "步骤条常显");
  const record = after.querySelector("details.side-rec");
  assert.ok(record && !record.open && record.querySelector("summary").textContent === "逐项记录", "节内只有逐项记录折叠");
  assert.equal(after.querySelector('[data-a="release"]'), null);
});

test("只差放行的卡：放行核对区标成「要你做什么」，强调色只给这一节，按钮还是原来那一个", () => {
  const f = fixture({ status: "not_started", released: false, verification_repair_digest: "d".repeat(64),
    progress_blockers: [{ code: "NOT_RELEASED", message: "任务尚未放行", next_action: "核对任务后显式放行" }] });
  f.context.renderSide();
  const execution = f.document.getElementById("task-side-execution");
  assert.equal(f.state().textContent, "待放行"); assert.equal(f.document.getElementById("task-side-next").textContent, "下一步：核对后放行");
  assert.equal(execution.dataset.tone, "need"); assert.equal(execution.children[0].textContent, "要你做什么");
  assert.equal(f.body.querySelectorAll('[data-a="release"]').length, 1, "有且只有一个放行按钮");
  assert.equal(f.body.querySelectorAll('[data-tone="need"]').length, 1, "强调色左边条只给放行核对这一节");
  assert.equal(f.body.querySelector("textarea"), null);
  // 多了一条别的阻塞(祖先未放行):状态用服务端原因,带它指向的卡号按钮;放行不再是「要你做什么」。
  f.task.progress_blockers = [...f.task.progress_blockers, { code: "ANCESTOR_NOT_RELEASED", message: "祖先任务尚未放行", next_action: "先核对并放行祖先", related_task_ids: [3] }];
  const changes = f.body.replacements; f.context.renderSide();
  assert.equal(f.body.replacements, changes + 1, "主操作变了才重建");
  assert.equal(f.state().textContent, "祖先任务尚未放行"); assert.equal(f.document.getElementById("task-side-next").textContent, "下一步：先核对并放行祖先");
  assert.deepEqual(f.document.getElementById("task-side-related").children.map((b) => [b.tagName, b.textContent]), [["BUTTON", "#3"]]);
  assert.equal(f.body.querySelectorAll('[data-tone="need"]').length, 0);
  assert.equal(f.body.querySelectorAll('[data-a="release"]').length, 1, "核对区和放行按钮照旧可见");
});

test("待人工裁定的未开始卡：「要你做什么」写命令行里的处理位置，面板不给解闸按钮", () => {
  const f = fixture({ status: "not_started", released: true, human_gate: 1,
    progress_blockers: [{ code: "HUMAN_GATE", message: "待人工裁定，不会自动领取或送回重审", next_action: "由操作者裁定或显式解除人工闸" }] });
  f.context.renderSide();
  assert.equal(f.state().textContent, "待人工裁定");
  const need = f.body.querySelectorAll('[data-tone="need"]');
  assert.equal(need.length, 1); assert.match(need[0].textContent, /^要你做什么在命令行解除人工闸：python cli\/board\.py edit 7 --file gate\.json --version 3gate\.json 的内容：\{"humanGate": false\}$/);
  assert.deepEqual(need[0].querySelectorAll("code").map((c) => c.className), ["side-cmd", "side-cmd"], "命令用等宽样式");
  assert.equal(need[0].querySelectorAll("button").length, 0, "解除人工闸仍只在命令行");
});

test("卡版本变化重建后，已展开的折叠区仍是展开，没展开的不被打开；换一张卡从头看", () => {
  const f = fixture({ run_id: "current", released: true, description: "执行者材料", execution_trace: { run_id: "current", claimed_at: "2026-10-21T09:08:07.000Z" } });
  f.context.renderSide();
  const fold = (id) => f.document.getElementById(id);
  fold("task-side-rec").open = true; fold("task-side-detail").open = true; f.body.scrollTop = 240;
  // 执行回执变了、卡版本没变:只换步骤条那一节的内容,「逐项记录」照旧开着。
  let changes = f.body.replacements; const section = fold("task-side-execution"), record = fold("task-side-rec");
  f.task.execution_trace = { ...f.task.execution_trace, last_activity_at: "2026-10-21T09:10:00.000Z" }; f.context.renderSide();
  assert.equal(f.body.replacements, changes); assert.equal(fold("task-side-execution"), section);
  assert.notEqual(fold("task-side-rec"), record, "逐项记录随回执换新");
  assert.equal(fold("task-side-rec").open, true, "局部替换保留逐项记录的开合");
  assert.match(fold("task-side-rec").textContent, /最近输出观察/);
  // 卡版本变了:整栏重建,开合和滚动位置照原样恢复。
  const detail = fold("task-side-detail"); changes = f.body.replacements;
  f.task.aggregate_version++; f.task.description = "执行者材料（已补充）"; f.context.renderSide();
  assert.equal(f.body.replacements, changes + 1, "卡版本变化重建侧栏");
  assert.notEqual(fold("task-side-detail"), detail);
  assert.equal(fold("task-side-detail").open, true); assert.equal(fold("task-side-rec").open, true);
  assert.ok(!fold("task-side-more").open && !fold("task-side-tech").open, "原来收着的仍收着");
  assert.equal(f.body.scrollTop, 240, "滚动位置不丢");
  // 关掉再打开或换一张卡:不带上一张卡的开合。
  const other = { id: 8, task_uid: "fixture-node/task-8", subject: "另一张", line: "engine", kind: "task", status: "done", aggregate_version: 1, parent_id: null, blocked_by: [] };
  f.context.tasks.push(other); f.context.byId.set(8, other);
  f.context.sideRef = { id: 8, uid: other.task_uid, item: null }; f.context.sideSig = ""; f.context.renderSide();
  assert.ok(!fold("task-side-detail").open && !fold("task-side-rec").open);
});

test("进行中的卡：「现在」行下写心跳与最近输出，每秒原位更新；取不到写待核实", () => {
  const f = fixture({ run_id: "current", released: true, execution_trace: { run_id: "current", last_activity_at: "2026-10-21T09:08:07.000Z" } });
  f.context.renderSide();
  const beat = f.document.getElementById("task-side-beat"), changes = f.body.replacements;
  assert.ok(beat && !beat.hidden);
  assert.match(beat.textContent, /^心跳 0 秒前 · 最近输出 \d{2}:\d{2}$/);
  f.setTime(f.time() + 42_000); f.context.tick();
  assert.match(beat.textContent, /^心跳 42 秒前 · 最近输出 \d{2}:\d{2}$/);
  assert.equal(f.document.getElementById("task-side-beat"), beat); assert.equal(f.body.replacements, changes);
  f.task.execution_trace = { run_id: "previous", last_activity_at: "2026-10-21T09:08:07.000Z" }; f.task.heartbeat_at = null; f.context.tick();
  assert.equal(beat.textContent, "心跳 待核实 · 最近输出 待核实", "旧运行的输出不算本轮");
  // 心跳中断:下一步右边出现次按钮「去设置」;恢复后收起。按钮节点不重建。
  const go = f.document.getElementById("task-side-go");
  assert.ok(!go.hidden && go.textContent === "去设置" && go.dataset.go === "lines");
  f.task.heartbeat_at = f.time(); f.context.tick();
  assert.ok(go.hidden && f.document.getElementById("task-side-go") === go);
  f.task.execution_trace = { run_id: "current", process_state: "not_started" }; f.context.tick();
  assert.ok(!go.hidden && go.textContent === "看逐项记录" && go.dataset.go === "receipt");
  // 不在进行中的卡没有这一行。
  const idle = fixture({ status: "waiting", waiting_for: "review" }); idle.context.renderSide();
  assert.equal(idle.document.getElementById("task-side-beat").hidden, true);
});

test("写了留言后主按钮写「打回并交回原线」，留空是「通过」；未开始的卡有「编辑」", () => {
  const f = fixture({ status: "waiting", waiting_for: "review" });
  f.context.verdictDraft.set(7, "请补一条回归测试"); f.context.renderSide();
  const approve = () => f.body.querySelectorAll("button").find((b) => b.dataset.a === "approve");
  assert.equal(f.body.querySelector("textarea").value, "请补一条回归测试");
  assert.equal(approve().textContent, "打回并交回原线"); assert.equal(approve().classList.contains("handoff"), true);
  assert.equal(f.body.querySelectorAll("button").filter((b) => b.classList.contains("pri")).length, 1, "轮到人时有且只有一个主按钮");
  assert.ok(!f.body.textContent.includes("留空按") && !f.body.textContent.includes("取消放行说明"), "普通卡不写说明句");
  f.context.verdictDraft.delete(7); f.task.aggregate_version++; f.context.renderSide();
  assert.equal(approve().textContent, "通过"); assert.equal(approve().classList.contains("handoff"), false);
  // 显式执行配置卡保留取消放行那一句。
  const profiled = fixture({ status: "waiting", waiting_for: "review", execution_profile: { channel: "codex_cli" } });
  Object.assign(profiled.context, { executionChannelName: (v) => v, executionAuthName: (v) => v, executionBillingName: (v) => v, effortName: (v) => v, executionBudgetText: () => "600 秒" });
  profiled.context.renderSide();
  assert.ok(profiled.body.querySelector('[data-tone="need"]').textContent.endsWith("取消放行说明"));
  // 未开始和等待中的卡能编辑;进行中、已完成的不能。
  const editable = (extra) => { const x = fixture(extra); x.context.renderSide(); return x.body.querySelectorAll("button").filter((b) => b.dataset.edit === "7").map((b) => b.textContent); };
  assert.deepEqual(editable({ status: "not_started", released: true }), ["编辑"]);
  assert.deepEqual(editable({ status: "waiting", waiting_for: "review" }), ["编辑"]);
  assert.deepEqual(editable({ status: "in_progress" }), []); assert.deepEqual(editable({ status: "done" }), []);
});

test("目标卡：不画五步条，状态写子任务完成数并列出未完成的子卡，放行与目标专有操作沿用看板卡的数据属性", () => {
  const f = fixture({ kind: "goal", status: "not_started", released: false, verification_repair_digest: "d".repeat(64), line: null,
    progress_blockers: [{ code: "DESCENDANTS_UNFINISHED", message: "目标下仍有未完成任务，包含已归档任务", next_action: "核对并完成或明确调整任务归属", related_task_ids: [9] }] });
  for (const child of [{ id: 8, subject: "已完成的子任务", status: "done", parent_id: 7, blocked_by: [] }, { id: 9, subject: "未完成的子任务", status: "not_started", parent_id: 7, blocked_by: [] }]) {
    f.context.tasks.push(child); f.context.byId.set(child.id, child);
  }
  f.context.REVIEW_LINES = ["review"]; f.context.renderSide();
  const buttons = () => f.body.querySelectorAll("button");
  assert.equal(f.body.querySelector("ol.steps"), null, "目标卡没有 .steps");
  assert.equal(f.state().textContent, "待放行 · 子任务 1/2 完成");
  assert.deepEqual(f.document.getElementById("task-side-related").children.map((b) => b.textContent), ["#9"], "只列未完成的子卡");
  const release = buttons().filter((b) => b.dataset.a === "release");
  assert.deepEqual(release.map((b) => [b.textContent, b.dataset.id, b.dataset.version]), [["放行这个目标", "7", "3"]]);
  assert.equal(f.document.getElementById("task-side-execution").dataset.tone, "need");
  const more = f.document.getElementById("task-side-more").querySelectorAll("button");
  assert.deepEqual(more.map((b) => [b.textContent, b.dataset.pin ?? b.dataset.rev ?? b.dataset.edit ?? b.dataset.a ?? ""]),
    [["置顶", "7"], ["起评审卡", "7"], ["编辑", "7"], ["归档", "archive"], ["在「全部任务」中定位", ""]], "有子任务的目标不出重新拆解");
  assert.equal(more[0].dataset.on, "0");
  // 放行后:状态只写子任务完成数;置顶后按钮换字。没有子任务的目标给重新拆解。
  Object.assign(f.task, { released: true, pinned_at: "2026-10-21T09:00:00.000Z", aggregate_version: 4 }); f.context.renderSide();
  assert.equal(f.state().textContent, "子任务 1/2 完成"); assert.equal(f.document.getElementById("task-side-next").textContent, "下一步：推进未完成的子任务");
  assert.equal(buttons().filter((b) => b.dataset.a === "release").length, 0);
  const pin = buttons().find((b) => b.dataset.pin === "7");
  assert.deepEqual([pin.textContent, pin.dataset.on], ["已置顶 · 取消", "1"]);
  f.context.tasks.splice(1); f.context.renderSide();
  assert.equal(f.state().textContent, "还没有子任务");
  assert.deepEqual(buttons().filter((b) => b.dataset.dec === "7").map((b) => b.textContent), ["重新拆解"]);
  // 这些按钮由 document 上的处理器按数据属性接管,不依赖看板卡片这个祖先。
  for (const handler of ['e.target.closest("button[data-pin]")', 'e.target.closest("button[data-dec]")', 'e.target.closest("button[data-rev]")', 'e.target.closest("button[data-a]")'])
    assert.ok(source.includes("= " + handler + ";"), handler);
});

test("同一任务版本下，侧栏随时钟和心跳恢复更新而不重建内容", () => {
  const f = fixture(); f.context.renderSide();
  const state = f.state(), next = f.document.getElementById("task-side-next"), changes = f.body.replacements;
  assert.ok(state && next, "侧栏提供可独立更新的状态与下一步节点");
  assert.doesNotMatch(state.textContent, /心跳中断/);
  f.setTime(f.time() + 181_000); f.context.tick();
  assert.match(state.textContent, /心跳中断/);
  assert.equal(state.dataset.tone, "warn");
  assert.equal(f.body.replacements, changes, "每秒刷新不能重建侧栏");
  f.task.heartbeat_at = f.time(); f.context.renderSide();
  assert.doesNotMatch(state.textContent, /心跳中断/);
  assert.notEqual(state.dataset.tone, "warn");
  assert.equal(f.state(), state); assert.equal(f.document.getElementById("task-side-next"), next);
  assert.equal(f.body.replacements, changes, "相同结构签名的刷新仍原位更新");
  assert.equal(f.task.aggregate_version, 3);
});

test("局部状态刷新保留实际留言、焦点、选区和已按一次的确认按钮", () => {
  const f = fixture({ status: "waiting", waiting_for: "review" }); f.context.renderSide();
  const input = f.body.querySelector("textarea"), button = f.body.querySelectorAll("button").find((b) => b.dataset.a === "approve");
  assert.ok(input && button, "使用实际侧栏操作节点，而非额外添加的占位控件");
  input.value = "请保留这段未提交的意见"; input.focus(); input.setSelectionRange(2, 8);
  button.dataset.armed = "1"; button.classList.add("armed");
  const changes = f.body.replacements;
  f.context.updateSideLive(); f.context.renderSide(); f.context.tick();
  assert.equal(f.body.querySelector("textarea"), input);
  assert.equal(f.body.querySelectorAll("button").find((b) => b.dataset.a === "approve"), button);
  assert.equal(input.value, "请保留这段未提交的意见"); assert.equal(f.document.activeElement, input);
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 8);
  assert.equal(button.dataset.armed, "1"); assert.equal(button.classList.contains("armed"), true);
  assert.equal(f.body.replacements, changes);
});

test("侧栏关闭或没有任务时，实时刷新不触碰已有节点", () => {
  const f = fixture(); f.context.renderSide();
  const state = f.state(), content = state.textContent, changes = f.body.replacements;
  f.root.hidden = true; f.setTime(f.time() + 181_000); f.context.updateSideLive(); f.context.tick();
  assert.equal(state.textContent, content); assert.equal(f.body.replacements, changes);
  f.root.hidden = false; f.context.sideRef = null; f.context.updateSideLive();
  assert.equal(state.textContent, content); assert.equal(f.body.replacements, changes);
});

test("关联任务变化只刷新关联区域，保留留言、焦点和待确认按钮", () => {
  const f = fixture({ status: "waiting", waiting_for: "review", blocked_by: [9] });
  const dependency = { id: 9, subject: "待完成的前置任务", status: "not_started", parent_id: null, blocked_by: [] };
  f.context.tasks.push(dependency); f.context.byId.set(dependency.id, dependency); f.context.renderSide();
  const relations = f.document.getElementById("task-side-relations");
  assert.ok(relations, "关联任务拥有可独立更新的区域");
  assert.match(relations.textContent, /待完成的前置任务.*未开始/);
  const input = f.body.querySelector("textarea"), button = f.body.querySelectorAll("button").find((b) => b.dataset.a === "approve");
  input.value = "依赖更新时也不能丢掉这句话"; input.focus(); input.setSelectionRange(3, 9);
  button.dataset.armed = "1"; button.classList.add("armed");
  const changes = f.body.replacements;
  dependency.status = "done"; f.context.renderSide();
  assert.equal(f.document.getElementById("task-side-relations"), relations);
  assert.match(relations.textContent, /待完成的前置任务.*已完成/);
  assert.equal(f.body.replacements, changes, "关联状态变化不能重建整个侧栏");
  assert.equal(f.body.querySelector("textarea"), input);
  assert.equal(input.value, "依赖更新时也不能丢掉这句话"); assert.equal(f.document.activeElement, input);
  assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 9);
  assert.equal(f.body.querySelectorAll("button").find((b) => b.dataset.a === "approve"), button);
  assert.equal(button.dataset.armed, "1"); assert.equal(button.classList.contains("armed"), true);
});

test("派发与领取显示本地日期和时刻，不使用旧运行的进程时间", () => {
  const f = fixture({ run_id: "current", released: true, execution_trace: {
    run_id: "current", released_at: "2026-10-21T08:00:00.000Z", claimed_at: "2026-10-21T09:08:07.000Z",
    process_state: "unverified", work_state: "unverified",
  } });
  f.context.renderSide();
  const trace = f.document.getElementById("task-side-execution");
  assert.match(trace.textContent, /本轮领取\d{2}-\d{2} \d{2}:\d{2}/);
  f.task.execution_trace = { run_id: "previous", process_state: "observed", process_started_at: "2025-01-01T00:00:00.000Z" };
  f.context.renderSide();
  assert.ok(!trace.textContent.includes("01-01"));
  assert.match(trace.textContent, /进程观察待核实/);
});

// ── 跨机事项按任务归拢:侧栏 ──
const PC_A = "11111111-1111-4111-8111-111111111111", PC_B = "83d5fb7d-b622-44fc-a230-252f8f767824";
const fleetNodes = { nodes: [{ node_id: PC_A, display_name: "台式机 A", local: true }, { node_id: PC_B, display_name: "笔记本 B", local: false }], tasks: [] };
function fleetFixture(extra, actions) {
  const f = fixture(extra), calls = [];
  Object.assign(f.context, { homeFleet: { ...fleetNodes, tasks: [] }, homeMulti: () => true, homeActions: actions ? { enabled: true, ...actions } : null,
    fleetApi: { act: (...args) => calls.push(args), open: () => calls.push(["open"]), showTask() {}, evidence() {}, names: { commands: { poll_delegation: "查询委派回执" }, actions: { acknowledged: "协议回执已核验" } } } });
  return { ...f, calls };
}
const pri = (f) => f.body.querySelectorAll("button").filter((b) => b.classList.contains("pri"));

test("首页点开「收到委派」：侧栏写说明和来源电脑，只有一个主按钮「接收任务」，次按钮「拒绝」，验收条件折叠", () => {
  const incoming = { project_id: "demo", delegation_id: "d1", state: "received", identity_current: true, source_node_id: PC_B, version: 3,
    subject: "跑一次压测", description: "在 B 机上跑回放压测", acceptance: "错误率低于千分之一" };
  const f = fleetFixture({}, { incoming: [incoming] });
  f.context.sideRef = { action: { kind: "incoming", id: "d1" }, id: null, uid: null, item: { title: "跑一次压测" } };
  f.context.renderSide();
  assert.equal(f.document.getElementById("task-side-title").textContent, "跑一次压测");
  assert.equal(f.state().textContent, "收到委派 · 来自「笔记本 B」");
  assert.match(f.body.children[0].textContent, /^要做什么在 B 机上跑回放压测现在收到委派 · 来自「笔记本 B」下一步：接收或拒绝要你做什么接收任务拒绝$/);
  assert.deepEqual(pri(f).map((b) => b.textContent), ["接收任务"], "只有一个主按钮");
  assert.deepEqual(f.body.querySelectorAll("button").map((b) => [b.textContent, b.dataset.fleetCommand, b.disabled]), [["接收任务", "decide_delegation", false], ["拒绝", "decide_delegation", false]]);
  assert.equal(f.body.querySelectorAll('[data-tone="need"]').length, 1);
  const detail = f.document.getElementById("task-side-detail");
  assert.ok(detail && !detail.open && /验收条件错误率低于千分之一/.test(detail.textContent), "验收条件在默认折叠的详细说明里");
  // 记录的版本或状态变了才重建;处理完(记录不再待接收)按钮收走。
  let changes = f.body.replacements; f.context.renderSide();
  assert.equal(f.body.replacements, changes);
  incoming.version = 4; f.context.renderSide();
  assert.equal(f.body.replacements, changes + 1);
  incoming.state = "accepted_unconfirmed"; f.context.renderSide();
  assert.equal(f.state().textContent, "这件事已处理"); assert.equal(f.body.querySelectorAll("button").length, 0);
});

test("协议持有的待验收卡：主按钮是协议动作，「通过」收进「仍要手动处理」；等对端时给查询与重发", () => {
  const held = { status: "waiting", waiting_for: "review", result: "证据", task_uid: "u7",
    progress_blockers: [{ code: "DELEGATION_FINISH_HELD", message: "委派、取消或候选结果正在持有此任务", next_action: "按对应协议完成结算或人工恢复" }] };
  const binding = { relation_id: "r1", delegation_id: "d1", side: "target", state: "confirmed", task_uid: "u7", identity_current: 1, project_id: "demo", task_version: 3,
    task_status: "waiting", released: true, subject: "侧栏任务", execution_authorized: true, source_node_id: PC_B, target_node_id: PC_A, cancellation_state: null };
  // 没读到委派记录:只凭服务端的阻塞原因,「通过」也不作主按钮。
  const bare = fleetFixture(held, null);
  bare.context.renderSide();
  assert.equal(bare.body.querySelectorAll('[data-a="approve"]').length, 1, "通过按钮还在");
  assert.equal(pri(bare).length, 0, "协议持有时「通过」不是主按钮的样子");
  assert.equal(bare.body.children[0].querySelector('[data-a="approve"]'), null, "不在最上面「要你做什么」里");
  assert.equal(bare.body.querySelectorAll('[data-tone="need"]').length, 0);
  assert.equal(bare.document.getElementById("task-side-more").querySelector("summary").textContent, "仍要手动处理");
  assert.equal(bare.document.getElementById("task-side-next").textContent, "下一步：按对应协议完成结算或人工恢复");
  // 读到了:「要你做什么」就一个主按钮,是协议的这一步。
  const f = fleetFixture(held, { bindings: [binding] });
  f.context.renderSide();
  const need = f.body.querySelectorAll('[data-tone="need"]');
  assert.equal(need.length, 1);
  assert.deepEqual(need[0].querySelectorAll("button").map((b) => [b.textContent, b.className, b.dataset.fleetCommand]), [["封存并回传候选", "pri", "prepare_result"]]);
  assert.equal(f.state().textContent, "本机 · 执行已结束"); assert.equal(f.document.getElementById("task-side-next").textContent, "下一步：封存并回传候选");
  assert.ok(f.document.getElementById("task-side-more").querySelector('[data-a="approve"]'), "通过收进「仍要手动处理」");
  assert.deepEqual(pri(f).map((b) => b.textContent), ["封存并回传候选"], "整栏只有一个主按钮");
  const protocol = f.document.getElementById("task-side-protocol");
  assert.ok(protocol && !protocol.open && protocol.dataset.signature, "协议记录默认折叠，带签名供局部刷新");
  // 等对端:状态写等哪台电脑的什么,「更多操作」里有查询与重发;协议记录变化只换那一节。
  const sent = { project_id: "demo", direction: "outgoing", delegation_id: "d2", state: "pending", identity_current: true, source_node_id: PC_A, target_node_id: PC_B,
    source_task_uid: "u8", subject: "侧栏任务", description: "", acceptance: "" };
  const w = fleetFixture({ status: "not_started", released: true, task_uid: "u8" }, { outgoing: [sent], actions: [] });
  w.context.renderSide();
  assert.equal(w.state().textContent, "本机 · 等待「笔记本 B」接收任务"); assert.equal(w.document.getElementById("task-side-next").textContent, "下一步：无需操作");
  assert.equal(pri(w).length, 0, "等对端时没有主按钮");
  assert.deepEqual(w.document.getElementById("task-side-more").querySelectorAll("button").filter((b) => b.dataset.fleetCommand).map((b) => [b.textContent, b.dataset.fleetCommand]),
    [["查询对端回执", "poll_delegation"], ["重发", "resend_delegation"]]);
  assert.equal(w.body.querySelector('[data-a="release"]'), null);
  const section = w.document.getElementById("task-side-protocol"), changes = w.body.replacements;
  w.context.homeActions.actions = [{ action_id: "a1", command: "poll_delegation", state: "acknowledged", attempts: 1, last_error_code: null, result: { delegation_id: "d2" } }];
  w.context.renderSide();
  assert.equal(w.body.replacements, changes, "回执到了不重建整栏");
  assert.equal(w.document.getElementById("task-side-protocol"), section); assert.match(section.textContent, /查询委派回执 · 协议回执已核验/);
});

test("委派来的执行卡：放行只有协议那一个按钮，条件没满足时禁用", () => {
  const binding = { relation_id: "r1", delegation_id: "d1", side: "target", state: "confirmed", task_uid: "u7", identity_current: 1, project_id: "demo", task_version: 3,
    task_status: "not_started", released: false, subject: "侧栏任务", execution_authorized: false, source_node_id: PC_B, target_node_id: PC_A, cancellation_state: null };
  const f = fleetFixture({ status: "not_started", released: false, task_uid: "u7", verification_repair_digest: "d".repeat(64),
    progress_blockers: [{ code: "NOT_RELEASED", message: "任务尚未放行", next_action: "核对任务后显式放行" }] }, { bindings: [binding] });
  f.context.renderSide();
  assert.equal(f.body.querySelector('[data-a="release"]'), null, "不再出本机的「放行此任务」");
  assert.deepEqual(pri(f).map((b) => [b.textContent, b.dataset.fleetCommand, b.disabled]), [["放行此任务", "release_delegation", true]]);
  assert.equal(f.body.querySelectorAll('[data-tone="need"]').length, 0, "按钮禁用时不标强调色");
  binding.execution_authorized = true; f.context.renderSide();
  assert.deepEqual(pri(f).map((b) => [b.textContent, b.disabled]), [["放行此任务", false]]);
  assert.equal(f.body.querySelectorAll('[data-tone="need"]').length, 1);
});

test("其他电脑的卡：按任务编号从多机列表取当前行，行变了就重建；有「要做什么」「结果」，详细说明默认折叠", async () => {
  const f = fleetFixture({}, null), row = { read_only: true, task_uid: "remote-1", owner_name: "笔记本 B", subject: "远端卡", status: "in_progress",
    waiting_for: null, aggregate_version: 1, brief: "回放一小时流量", result_summary: null };
  let asked = 0;
  f.context.homeGet = async (path) => { asked++; assert.equal(path, "/api/fleet/task?uid=remote-1"); return { ...row, description: "完整说明", acceptance: "验收条件正文", result: null, verdict_note: null }; };
  f.context.homeFleet = null;
  f.context.sideRef = { uid: "remote-1", id: null, item: null }; f.context.sideSig = "";
  f.context.renderSide();
  assert.equal(f.state().textContent, "正在读取", "多机列表还没读到");
  f.context.homeFleet = { ...fleetNodes, tasks: [row] }; f.context.renderSide();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked, 1, "详情打开时只读一次");
  assert.equal(f.document.getElementById("task-side-title").textContent, "远端卡");
  assert.match(f.body.children[0].textContent, /^要做什么回放一小时流量现在笔记本 B · 已领取 · 开工待核实/);
  assert.match(f.body.children[0].textContent, /这张卡在「笔记本 B」上，这里只能查看。$/);
  const detail = f.document.getElementById("task-side-detail");
  assert.ok(!detail.open && /任务说明完整说明验收条件验收条件正文/.test(detail.textContent), "说明与验收条件只读、默认折叠");
  assert.equal(f.body.querySelectorAll("textarea").length + pri(f).length, 0, "这里只能查看");
  // 签名跟着当前行走:状态、版本、摘要变了就重建。
  let changes = f.body.replacements; f.context.renderSide();
  assert.equal(f.body.replacements, changes);
  Object.assign(row, { status: "waiting", waiting_for: "decision", aggregate_version: 2 }); f.context.renderSide();
  assert.equal(f.body.replacements, changes + 1);
  assert.equal(f.state().textContent, "笔记本 B · 执行方在等你决定"); assert.equal(f.document.getElementById("task-side-next").textContent, "下一步：到「笔记本 B」上处理");
  Object.assign(row, { status: "done", waiting_for: null, aggregate_version: 3, result_summary: "结论：通过" }); f.context.renderSide();
  assert.match(f.body.children[0].textContent, /结果结论：通过/);
  assert.equal(asked, 1);
});

test("单机环境：侧栏里没有任何跨机元素", () => {
  const f = fixture({ status: "not_started", released: true });
  f.context.renderSide();
  for (const id of ["task-side-protocol", "task-side-evidence", "task-side-computer"]) assert.equal(f.document.getElementById(id), null, id);
  assert.equal(f.body.querySelectorAll("button").filter((b) => b.dataset.fleetCommand || b.textContent === "分派").length, 0);
  // 有其他电脑、卡没被领取也没委派出去:「更多操作」里才有「分派」。
  const m = fleetFixture({ status: "not_started", released: true }, { peers: [{ node_id: PC_B, node_epoch: "e", projects: ["demo"] }] });
  m.context.renderSide();
  assert.deepEqual(m.document.getElementById("task-side-more").querySelectorAll("button").map((b) => b.textContent).filter((t) => t === "分派"), ["分派"]);
});
