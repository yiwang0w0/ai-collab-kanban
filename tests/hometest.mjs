// Home view harness. The landing page answers "what needs me, what is running" — which card
// lands in which list, with which words, lives in a marked pure block inside core/panel.html
// (home-model) so it can be sliced out and run here, the same way tests/tltest.mjs runs the
// timeline geometry. The structural pins at the end hold the layout decisions that block
// cannot see: home is the default view, ids sit folded under 技术信息, hidden columns never
// animate.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const src = readFileSync(new URL("../core/panel.html", import.meta.url), "utf8");
const b0 = src.indexOf("// ── home-model(pure;tests/hometest.mjs)──"), b1 = src.indexOf("// ── /home-model ──");
assert.ok(b0 > 0 && b1 > b0, "home-model block not found in core/panel.html");
const M = new Function(src.slice(src.indexOf("\n", b0) + 1, b1) +
  ";return {homeName,homeStep,homeLists,homeStatus,homeHealthWhat,sideControls,newTaskBody,sideFallback,sideRelations,homeHealthAlerts};")();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NODE_B = "83d5fb7d-b622-44fc-a230-252f8f767824";
const at = (h) => `2026-10-08T${String(h).padStart(2, "0")}:00:00Z`;
const card = (id, extra) => ({ id, task_uid: "u" + id, subject: "卡 " + id, kind: "task", status: "waiting", updated_at: at(id), hb: "", ...extra });
const ids = (rows) => rows.map((r) => r.localId ?? r.key);

test("decisions and answers wait for me; a delivery waits for me only when no reviewer will take it", () => {
  const tasks = [
    card(4, { waiting_for: "review" }), card(3, { waiting_for: "review", review_hold: "same_family" }),
    card(2, { waiting_for: "decision" }), card(1, { waiting_for: "confirm" }),
    card(5, { waiting_for: "dep" }), card(6, { waiting_for: "rearm" }),
  ];
  const plain = M.homeLists({ tasks, localName: "台式机 A" });
  assert.deepEqual(ids(plain.mine), [1, 2, 3, 4], "confirm, then decision, then deliveries oldest first");
  assert.deepEqual(plain.mine.map((r) => r.next), ["选择方案", "给出决定", "确认验收", "确认验收"]);
  assert.equal(plain.running.length, 0, "dependency and re-review waits are machine-tended, not on the home lists");
  const reviewed = M.homeLists({ tasks, localName: "台式机 A", autoReview: true });
  assert.deepEqual(ids(reviewed.mine), [1, 2, 3], "a running reviewer takes deliveries — except one it may not judge");
  assert.deepEqual(reviewed.running.map((r) => [r.localId, r.state, r.next]), [[4, "等待自动审阅", "无需操作"]]);
  assert.ok(plain.mine.every((r) => r.computer === "台式机 A"));
});

test("a card the machine will not move is mine even with the reviewer running", () => {
  const why = (code, next_action) => ({ code, message: code, next_action });
  const tasks = [
    card(1, { waiting_for: "review", human_gate: 1, progress_blockers: [why("HUMAN_GATE", "由操作者裁定或显式解除人工闸")] }),
    card(2, { waiting_for: "review", progress_blockers: [why("DELIVERY_ALREADY_REVIEWED", "按既有审阅意见处理或补充新证据")] }),
    card(3, { waiting_for: "review", progress_blockers: [why("DELEGATION_FINISH_HELD", "按对应协议完成结算或人工恢复")] }),
    card(4, { waiting_for: "review" }),
    card(5, { waiting_for: "rearm", progress_blockers: [why("CHILDREN_UNFINISHED", "先推进未完成子任务")] }),
    card(6, { waiting_for: "rearm", progress_blockers: [why("NO_NEW_CHILD_RESULT", "核对审阅记录及子任务结果")] }),
    card(7, { waiting_for: "dep", progress_blockers: [why("DELIVERY_ALREADY_REVIEWED", "按既有审阅意见处理或补充新证据")] }),
    card(8, { waiting_for: "dep", human_gate: 1, progress_blockers: [why("HUMAN_GATE", "由操作者裁定或显式解除人工闸")] }),
    card(9, { status: "not_started", human_gate: 1, progress_blockers: [why("HUMAN_GATE", "由操作者裁定或显式解除人工闸")] }),
    card(10, { status: "not_started", released: 0, progress_blockers: [why("NOT_RELEASED", "核对任务后显式放行")] }),
  ];
  const { mine, running } = M.homeLists({ tasks, autoReview: true });
  assert.deepEqual(running.map((r) => [r.localId, r.state]), [[4, "等待自动审阅"]], "only an unheld, unjudged delivery is the reviewer's");
  assert.deepEqual(mine.map((r) => [r.localId, r.state, r.next]), [
    [1, "待你验收", "确认验收"], [2, "待你验收", "确认验收"], [3, "待你验收", "按对应协议完成结算或人工恢复"],
    [6, "重审受阻", "核对审阅记录及子任务结果"], [8, "待人工裁定", "由操作者裁定或显式解除人工闸"],
    [9, "待人工裁定", "由操作者裁定或显式解除人工闸"],
  ], "unfinished children and a judged dependency wait are the machine's; an unreleased card stays in 全部任务");
});

test("running cards name their executor and a silent one comes first with a warning", () => {
  const { running } = M.homeLists({ tasks: [
    card(1, { status: "in_progress", last_runtime: "codex", hb: "fresh" }),
    card(2, { status: "in_progress", last_runtime: "claude", hb: "dead" }),
    card(3, { status: "in_progress", last_runtime: "zcode", hb: "stale" }),
  ] });
  assert.deepEqual(running.map((r) => [r.localId, r.state, r.tone, r.next]), [
    [2, "Claude 已领取 · 开工待核实 · 心跳中断", "warn", "检查执行线"],
    [1, "Codex 已领取 · 开工待核实", "", "等待执行回执"],
    [3, "Zcode 已领取 · 开工待核实", "", "等待执行回执"],
  ]);
});

test("goals, queued and archived cards stay off the home lists; finished work goes to history, newest first", () => {
  const lists = M.homeLists({ tasks: [
    card(1, { kind: "goal", status: "in_progress" }), card(2, { status: "not_started" }),
    card(3, { waiting_for: "confirm", archived_at: at(9) }),
    card(4, { status: "done", resolved_by: "human" }), card(6, { status: "done", resolved_by: "auto" }),
    card(5, { status: "done", kind: "goal" }), card(7, { status: "done", resolved_by: "cascade" }),
  ] });
  assert.equal(lists.mine.length + lists.running.length, 0);
  assert.deepEqual(lists.history.map((r) => [r.localId, r.state]),
    [[7, "联动关闭"], [6, "自动通过"], [5, "目标完成"], [4, "手动通过"]]);
});

test("other computers: cached copies are handled where they live, and never show an id for a name", () => {
  const remote = [
    { read_only: true, task_uid: NODE_B + ":1", owner_name: "笔记本 B", subject: "回放压测", status: "in_progress", updated_at: at(1) },
    { read_only: true, task_uid: NODE_B + ":2", owner_name: NODE_B, subject: "端口冲突", status: "waiting", waiting_for: "decision", updated_at: at(2) },
    { read_only: true, task_uid: NODE_B + ":3", owner_name: "笔记本 B", subject: "B 的交付", status: "waiting", waiting_for: "review", updated_at: at(3) },
    { read_only: true, task_uid: NODE_B + ":4", owner_name: "笔记本 B", subject: "B 的预检", status: "done", updated_at: at(4) },
    { read_only: false, task_uid: "u9", owner_name: "台式机 A", subject: "本机副本", status: "waiting", waiting_for: "confirm", updated_at: at(5) },
  ];
  const lists = M.homeLists({ tasks: [], localName: "台式机 A", remote });
  assert.deepEqual(lists.running.map((r) => [r.title, r.computer, r.state]), [["回放压测", "笔记本 B", "已领取 · 开工待核实"]]);
  assert.deepEqual(lists.mine.map((r) => [r.title, r.computer, r.next]), [["端口冲突", "另一台电脑", "到「另一台电脑」上处理"]],
    "a decision there is shown here but done there; its own reviewer may take a delivery; this board's rows come from its own list");
  assert.deepEqual(lists.history.map((r) => r.title), ["B 的预检"]);
  const words = [...lists.mine, ...lists.running, ...lists.history].map((r) => [r.computer, r.state, r.next].join(" ")).join("\n");
  assert.equal(UUID.test(words), false, "a computer whose name is unknown never shows its id instead");
  assert.equal(M.homeName("  "), "另一台电脑");
});

test("cross-computer requests that wait for me open the global view, where they are handled", () => {
  // Shapes as core/fleet-actions.mjs catalog() sends them: delegations and proposals carry a
  // subject and a boolean identity_current; a result row carries ids and a 0/1 identity_current
  // only, its title and executing computer live on the binding with the same relation_id.
  const actions = { enabled: true,
    incoming: [{ delegation_id: "d1", subject: "跑一次压测", state: "received", source_node_id: NODE_B, identity_current: true },
               { delegation_id: "d2", subject: "已接收的", state: "accepted_unconfirmed", source_node_id: NODE_B, identity_current: true },
               { delegation_id: "d3", subject: "旧代次", state: "received", source_node_id: NODE_B, identity_current: false }],
    proposals: [{ relation_id: "r1", subject: "绑定", state: "pending", relation: { source_node_id: NODE_B }, identity_current: true }],
    bindings: [{ relation_id: "r2", subject: "交付回来了", source_node_id: "a", target_node_id: NODE_B, identity_current: 1 }],
    results: [{ result_id: "x1", relation_id: "r2", side: "source", state: "received", identity_current: 1 },
              { result_id: "x2", relation_id: "r2", side: "target", state: "received", identity_current: 1 },
              { result_id: "x3", relation_id: "r2", side: "source", state: "received", identity_current: 0 }] };
  const { mine } = M.homeLists({ tasks: [], actions, nodeNames: { [NODE_B]: "笔记本 B" } });
  assert.deepEqual(mine.map((r) => [r.title, r.computer, r.state, r.next, r.action]), [
    ["跑一次压测", "来自「笔记本 B」", "收到委派", "接收或拒绝", "fleet"],
    ["绑定", "来自「笔记本 B」", "待确认绑定", "核对后确认", "fleet"],
    ["交付回来了", "来自「笔记本 B」", "交付已回传", "查看交付", "fleet"],
  ]);
  assert.equal(M.homeLists({ actions: { enabled: false, incoming: actions.incoming } }).mine.length, 0);
});

test("the device line is one sentence when all is well and lists what needs attention when not", () => {
  const local = { node_id: "a", display_name: "台式机 A", local: true, connection_state: "local" };
  const b = (state, name = "笔记本 B") => ({ node_id: NODE_B, display_name: name, local: false, connection_state: state });
  const ok = M.homeStatus({ localName: "台式机 A", nodes: [local, b("recent")], health: { issues: [] }, setup: { complete: true, steps: [] } });
  assert.deepEqual([ok.tone, ok.alerts.length, ok.line], ["ok", 0, "2 台电脑正常：台式机 A（本机）、笔记本 B 最近已同步"]);
  assert.equal(M.homeStatus({ localName: "台式机 A", nodes: [local] }).line, "本机「台式机 A」运行正常",
    "one computer is the ordinary case, not a missing second one");
  assert.equal(M.homeStatus({ nodes: [local, b("syncing")] }).tone, "ok", "catching up is not a fault");
  const bad = M.homeStatus({ localName: "台式机 A", nodes: [local, b("failed", NODE_B)], fleetError: "x",
    health: { issues: [{ code: "STORAGE_LOW", level: "problem", next_action: "inspect_storage_before_new_work", count: 2 },
                       { code: "SCHEDULER_LOCK_ORPHAN", level: "notice", next_action: "no_such_action", count: 1 }] },
    setup: { complete: false, done: 3, total: 4, steps: [{ state: "done", title: "起来" }, { state: "todo", title: "定义你自己的线" }] } });
  assert.equal(bad.tone, "bad");
  assert.equal(bad.line, "2 台电脑 · 5 项需要注意");
  assert.deepEqual(bad.alerts.map((a) => [a.tone, a.where, a.what, a.go]), [
    ["bad", "另一台电脑", "同步失败", "fleet"],
    ["warn", "多机视图", "暂时读不到", null],
    ["bad", "台式机 A", "磁盘空间不足（2 项）", null],
    ["warn", "台式机 A", "调度器运行锁异常", null],
    ["warn", "看板设置", "还差 1 步：定义你自己的线", "settings"],
  ]);
  assert.equal(bad.alerts[2].next, "先腾出磁盘空间再派新任务");
  assert.equal(M.homeHealthWhat("SOMETHING_NEW"), "运行检查报告了问题", "an unknown code still says something, never the code");
  assert.equal(UUID.test(JSON.stringify(bad)), false);
  // A step the server does in one request carries its button onto home, with the server's own
  // detail as the next step and its confirm text; the count is not prefixed by one computer.
  const bless = { state: "todo", title: "确认当前版本", detail: "点一下,表示「这个版本我认可」",
    action: { type: "api", method: "POST", path: "/api/setup/bless", label: "确认当前版本", body: { confirm_tree: "t1" }, confirm: "你正在确认版本 t1" } };
  const fresh = M.homeStatus({ localName: "台式机 A", nodes: [local], health: { issues: [] },
                               setup: { complete: false, done: 3, total: 4, steps: [{ state: "done", title: "起来" }, bless] } });
  assert.equal(fresh.line, "1 项需要注意");
  assert.deepEqual(fresh.alerts.map((a) => [a.what, a.next, a.go, a.action]), [
    ["还差 1 步：确认当前版本", "点一下,表示「这个版本我认可」", null,
     { path: "/api/setup/bless", body: { confirm_tree: "t1" }, confirm: "你正在确认版本 t1", label: "确认当前版本" }],
  ]);
  const quick = M.homeStatus({ nodes: [local], setup: { complete: false, done: 2, total: 4,
    steps: [{ state: "todo", title: "定义你自己的线", action: { type: "quick", kind: "propose-lines" } }] } });
  assert.deepEqual(quick.alerts.map((a) => [a.go, a.action]), [["settings", undefined]], "other steps still go to the guide, which now lives on 设置");
});

test("layout pins: home is the landing view, ids fold under 技术信息, hidden columns never animate", () => {
  assert.match(src, /HOME_VIEWS\.includes\(v\) \? v : "home"/, "an unknown or missing saved view lands on home");
  assert.match(src, /<main class="home" id="home-view" data-view-panel="home">/);
  assert.match(src, /<main class="home" id="history-view" data-view-panel="history" hidden>/);
  assert.match(src, /<div id="board-view" data-view-panel="board" hidden>/);
  const show = src.slice(src.indexOf(" async function showTask(uid){"), src.indexOf(" function nextStep("));
  assert.ok(show.length > 0);
  for (const label of ["终端身份", "任务 UID", "运行"])
    assert.equal(show.split(`["${label}"`).length - 1, 1, `${label} appears once in the detail, inside 技术信息`);
  assert.ok(show.includes('techIds([["终端身份",t.owner_node_id]'), "the detail's ids are built by techIds");
  assert.ok(show.includes("evidence(t.evidence,tech)"), "receipts and delegation history render inside 技术信息");
  assert.ok(!src.includes('el("p",n.node_id,"fleet-id")') && src.includes('techIds([["终端身份",n.node_id]])'),
    "the global view folds a computer's id too");
  assert.ok(show.includes("evidence(t.evidence,tech);body.append(tech);"), "the folded block is appended to the detail");
  assert.ok(src.includes('const boardShown = () => !document.getElementById("board-view").hidden;'),
    "visibility is read from the 全部任务 panel itself");
  assert.ok(src.includes("if (!REDUCED.matches && boardShown())") && src.includes("!document.hidden && boardShown()"),
    "FLIP measures and plays only while the columns are visible");
  assert.ok(src.includes("if (v === \"board\") { if (homeReady) render(); }"),
    "the columns' shell is never built before meta arrives");
  // One computer: no global-view button in the header, and the detail drops which computer,
  // where the data came from, an unbound project and the cross-computer actions.
  assert.match(src, /<button type="button" id="fleet-open" hidden>全局视图<\/button>/);
  assert.ok(src.includes('document.getElementById("fleet-open").hidden = !homeMulti() && !homeFleetError;'));
  assert.ok(show.includes("multi=homeMulti()||t.read_only") && show.includes("if(multi||t.project_id)taskActions(t,body,id);"));
});

test("side panel controls follow the board card rule: no more power, no less", () => {
  const w = (extra) => ({ id: 9, status: "waiting", ...extra });
  assert.deepEqual(M.sideControls(w({ waiting_for: "review" }), { mine: true }), { kind: "accept", primary: true }, "a delivery: one 通过");
  assert.deepEqual(M.sideControls(w({ waiting_for: "decision" }), { mine: true }), { kind: "decide", primary: true }, "a question: 同意 / 否决");
  assert.equal(M.sideControls(w({ waiting_for: "confirm", decision_package: { options: [{ key: "A" }] } }), { mine: true }).kind, "package",
    "options open the existing decision modal");
  assert.equal(M.sideControls(w({ waiting_for: "dep" })).kind, "accept",
    "the board shows 通过 on every waiting card without options; so does the side panel");
  assert.equal(M.sideControls(w({ waiting_for: "dep" }), { mine: false }).primary, false, "but folded when the next step is not mine");
  for (const status of ["not_started", "in_progress", "done"])
    assert.equal(M.sideControls({ id: 9, status }).kind, "none", status + " has nothing to rule on");
  assert.equal(M.sideControls(w({ waiting_for: "review" }), { remote: true, mine: true }).kind, "none", "another computer's cache is read-only");
  assert.equal(M.sideControls(null).kind, "none");
});

test("new task: a title, a configured working line, and no internal ids", () => {
  const cfg = { lines: ["engine", "design", "review"], reviewLines: ["review"] };
  assert.equal(M.newTaskBody({ title: "  ", line: "engine" }, cfg).error, "先写一个标题:要做什么。");
  assert.equal(M.newTaskBody({ title: "修首页", line: "review" }, cfg).error, "选一条执行线。",
    "review lines judge other work; they take no new task");
  assert.equal(M.newTaskBody({ title: "修首页", line: "nope" }, cfg).error, "选一条执行线。");
  assert.deepEqual(M.newTaskBody({ title: " 修首页 ", description: " 首页加按钮 ", line: "design" }, cfg),
    { body: { subject: "修首页", description: "首页加按钮", line: "design" } }, "trimmed, and nothing but what the operator typed");
});

test("side panel pins: the board's own buttons, the note beside the button, drafts kept", () => {
  // Same ruling buttons and attributes as a board card: the document-level handler gives them the
  // same two-press, expected_version, operator credential and human gate.
  const box = src.slice(src.indexOf("function sideControlsBox(t, ctl){"), src.indexOf("function renderSide(){"));
  assert.ok(box.length > 0 && box.includes('ok.dataset.a = "approve"') && box.includes('no.dataset.a = "reject"') && box.includes("b.dataset.openDecision"));
  assert.ok(!box.includes("/resolve") && !box.includes("post("), "the side panel never calls resolve itself");
  // A task's note box can appear twice (board card and side panel): the pressed button reads its own.
  assert.equal(src.split("document.querySelector(`textarea[data-vin=").length - 1, 1, "one document-wide lookup left: the fallback inside noteBox");
  assert.ok(src.includes("const hasNote = ((noteBox(id, b) || {}).value") && src.includes("const ta = noteBox(id, b);")
    && src.includes("const extra = (noteBox(id, decide)?.value"), "approve, reject and decide all read the note beside the button");
  assert.ok(src.includes('<aside class="side" id="task-side" hidden data-task-scope'), "the side panel is a note scope");
  // Home and history cards open the side panel: no stacked dialog, no jump to 全部任务.
  const open = src.slice(src.indexOf("function openHomeItem(item){"), src.indexOf("function sideCard(){"));
  assert.ok(open.includes("openSide(") && !open.includes("fleetApi.showTask") && !open.includes("locateOnBoard"));
  // A refresh keeps the open task (#task=) and unsent words (sessionStorage, try-wrapped).
  assert.ok(src.includes('p.set("task", uid)') && src.includes('window.addEventListener("hashchange", sideFromHash)'));
  assert.ok(src.includes("verdictDraft.set(Number(id), e.target.value);" + String.fromCharCode(10) + "  persistDrafts();"));
  assert.ok(src.includes("function loadDrafts(){ try {") && src.includes("sessionStorage.setItem(DRAFTS_KEY"));
  assert.ok(src.includes('querySelectorAll("textarea, #line-add input, #line-add select, #home-new input")'),
    "an unsent new-task title holds the page against an automatic reload too");
  // Creating a task is a plain POST /api/tasks through the panel's post(): no release key, no internal id.
  const at = src.indexOf('getElementById("home-new-form").addEventListener("submit"');
  const sub = src.slice(at, at + 1400);
  assert.ok(at > 0 && sub.includes('await post("/api/tasks", r.body)') && !sub.includes("released"));
});

test("换版本自动刷新只被真没保存的输入拦下:空表单不拦,勾选框按默认勾选态判,填了字才拦", () => {
  const a = src.indexOf("const fieldChanged = "), b = src.indexOf("function showRevBar(", a);
  assert.ok(a > 0 && b > a, "hasUnsavedInput block not found");
  // 控件照面板里加线表单与新建任务表单的真实标记造:类型、默认勾选、默认选项都从标记读,不手写。
  const block = (open, close) => { const i = src.indexOf(open), j = src.indexOf(close, i); assert.ok(i > 0 && j > i, open); return src.slice(i, j); };
  const forms = { "line-add": block('<form class="line-add" id="line-add"', "</form>"), "home-new": block('<section class="home-new" id="home-new">', "</section>") };
  const attr = (s, k) => (s.match(new RegExp(`\\s${k}="([^"]*)"`)) || [])[1];
  const els = [];
  for (const [scope, html] of Object.entries(forms)) {
    for (const [, s] of html.matchAll(/<input\b([^>]*)>/g)) {
      const type = attr(s, "type") || "text", checked = /\schecked\b/.test(s);
      els.push({ scope, tagName: "INPUT", id: attr(s, "id"), type, value: type === "checkbox" ? "on" : (attr(s, "value") || ""), checked, defaultChecked: checked });
    }
    for (const [, s, body] of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const options = [...body.matchAll(/<option\b([^>]*)>/g)].map(([, o]) => ({ defaultSelected: /\sselected\b/.test(o) }));
      els.push({ scope, tagName: "SELECT", id: attr(s, "id"), type: "select-one", value: "x", options,
        selectedIndex: options.length ? Math.max(0, options.findIndex((o) => o.defaultSelected)) : -1 });
    }
    for (const [, s, body] of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g))
      els.push({ scope, tagName: "TEXTAREA", id: attr(s, "id"), type: "textarea", value: body });
  }
  const document = { querySelectorAll: (sel) => sel.split(",").flatMap((part) => {
    part = part.trim();
    if (part === "textarea") return els.filter((e) => e.tagName === "TEXTAREA");
    const m = part.match(/^#(line-add|home-new) (input|select)$/);
    assert.ok(m, "选择器多了没造过的部分:" + part);
    return els.filter((e) => e.scope === m[1] && e.tagName === m[2].toUpperCase());
  }) };
  const hasUnsavedInput = new Function("document", src.slice(a, b) + "\nreturn hasUnsavedInput;")(document);
  const el = (id) => { const e = els.find((x) => x.id === id); assert.ok(e, id); return e; };
  assert.equal(el("line-add-ro").type, "checkbox"); assert.equal(el("line-add-auto").value, "on");
  assert.equal(hasUnsavedInput(), false, "空表单:两个勾选框的 value 恒为 on,不算没保存的输入");
  el("line-add-id").value = "   ";
  assert.equal(hasUnsavedInput(), false, "只有空白不算");
  for (const id of ["line-add-id", "line-add-label", "line-add-hint", "line-add-charter", "home-new-title", "home-new-desc"]) {
    el(id).value = "docs";
    assert.equal(hasUnsavedInput(), true, id + " 填了字");
    el(id).value = "";
  }
  el("line-add-ro").checked = true;
  assert.equal(hasUnsavedInput(), true, "勾上「只读」= 偏离默认");
  el("line-add-ro").checked = false; el("line-add-kind").selectedIndex = 1;
  assert.equal(hasUnsavedInput(), true, "身份改成评审 = 偏离默认");
  el("line-add-kind").selectedIndex = 0; el("home-new-line").selectedIndex = 2;
  assert.equal(hasUnsavedInput(), false, "新建任务的下拉由代码填值,不算");
});

test("手机看板一次一栏:默认等待中有卡优先,定位与筛选切到命中卡所在的栏,选择只存本标签页且读写包 try", () => {
  const c0 = src.indexOf("// ── board-col(pure;tests/hometest.mjs)──"), c1 = src.indexOf("// ── /board-col ──");
  assert.ok(c0 > 0 && c1 > c0, "board-col block not found in core/panel.html");
  const B = new Function(src.slice(src.indexOf("\n", c0) + 1, c1) + ";return {boardColAuto,boardColForHits};")();
  const COLS = ["goal", "not_started", "in_progress", "waiting", "done"];
  const has = (...keys) => Object.fromEntries(keys.map((k) => [k, true]));
  assert.equal(B.boardColAuto(COLS, has("not_started", "waiting"), null), "waiting", "等待中有卡:先看等待中");
  assert.equal(B.boardColAuto(COLS, has("in_progress", "done"), null), "in_progress", "等待中没卡:按栏的顺序第一个有卡的");
  assert.equal(B.boardColAuto(COLS, {}, null), "waiting", "全空停在等待中");
  assert.equal(B.boardColAuto(COLS, has("not_started", "waiting"), "not_started"), "not_started", "自动挑过的栏还有卡就不跳");
  assert.equal(B.boardColAuto(COLS, has("waiting"), "not_started"), "waiting", "自动挑过的栏空了才重挑");
  const hits = (...keys) => new Set(keys);
  assert.equal(B.boardColForHits(COLS, "waiting", hits("not_started")), "not_started", "当前栏没命中:去命中卡所在的栏");
  assert.equal(B.boardColForHits(COLS, "goal", hits("in_progress", "waiting")), "waiting", "命中多栏:等待中优先(哪怕进行中排在前面)");
  assert.equal(B.boardColForHits(COLS, "goal", hits("done", "in_progress")), "in_progress", "再按栏的顺序");
  assert.equal(B.boardColForHits(COLS, "not_started", hits("not_started", "waiting")), "not_started", "当前栏有命中就不动");
  assert.equal(B.boardColForHits(COLS, "done", hits()), "done", "一张都没命中不动");

  // 选中状态:sessionStorage 读写都包 try,存储抛错时照常能换栏;只认五栏的键。
  const s0 = src.indexOf('const BOARD_COL_KEY = "tb_board_col";'), s1 = src.indexOf('document.getElementById("board-seg").addEventListener("change"', s0);
  assert.ok(s0 > 0 && s1 > s0);
  const fakeDom = () => {
    const cols = { dataset: {} }, on = new Set();
    const shell = new Map(COLS.map((k) => [k, { col: { classList: { toggle: (c, v) => { if (c === "on") v ? on.add(k) : on.delete(k); } } } }]));
    const radios = COLS.map((value) => ({ value, checked: false }));
    return { cols, on, shell, radios, document: { getElementById: (id) => (assert.equal(id, "cols"), cols), querySelectorAll: () => radios } };
  };
  const load = (storage) => {
    const d = fakeDom();
    const api = new Function("COLS", "sessionStorage", "document", "shell", src.slice(s0, s1) +
      ";return {setBoardCol, applyBoardCol, state: () => [boardCol, boardColMine]};")(COLS, storage, d.document, d.shell);
    return { ...d, api };
  };
  const broken = { getItem() { throw Error("denied"); }, setItem() { throw Error("denied"); } };
  const b = load(broken);
  assert.deepEqual(b.api.state(), [null, false], "存储读不了:当没选过");
  b.api.setBoardCol("done");
  assert.deepEqual(b.api.state(), ["done", true], "存储写不了:照样换栏");
  assert.equal(b.cols.dataset.col, "done");
  assert.deepEqual([...b.on], ["done"]);
  assert.deepEqual(b.radios.filter((r) => r.checked).map((r) => r.value), ["done"]);
  b.api.setBoardCol("bogus");
  assert.deepEqual(b.api.state(), ["done", true], "不认识的键不收");
  const mem = new Map([["tb_board_col", "in_progress"]]);
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  const r = load(store);
  assert.deepEqual(r.api.state(), ["in_progress", true], "刷新后照旧显示你选的栏");
  r.api.setBoardCol("goal");
  assert.equal(mem.get("tb_board_col"), "goal");
  mem.set("tb_board_col", "__proto__");
  assert.deepEqual(load(store).api.state(), [null, false], "存的值不是五栏之一:当没选过");

  // 结构钉:控件在栏上方、桌面不出现;≤620px 只藏没选中的栏,且只在脚本选定后;页脚留白不退;
  // 定位与筛选先切栏;你选过就不再自动挑;隐藏栏里量出 0×0 的卡不演 FLIP;选栏不清高亮。
  assert.ok(src.includes('<div class="seg board-seg" id="board-seg" role="radiogroup" aria-label="选择显示的栏"></div>\n<div class="cols" id="cols"></div>'));
  assert.ok(src.includes(".seg.board-seg{display:none}"));
  const segCss = src.slice(src.indexOf(".seg.board-seg{display:none}"), src.indexOf("/* ── 触摸:窄屏与粗指针"));
  const m620 = segCss.indexOf("@media (max-width:620px){");
  assert.ok(m620 > 0 && segCss.indexOf(".seg.board-seg{display:flex", m620) > m620
    && segCss.indexOf(".cols[data-col] > .col:not(.on){display:none}", m620) > m620, "选栏只在 ≤620px 生效");
  assert.match(src, /@media \(max-width:620px\)\{ \.cols\{padding-bottom:112px\} \}/, "手机上最后一行不被固定页脚压住");
  assert.ok(src.includes("\n  setBoardCol(taskColumn(task));"), "按卡号定位先切到卡所在的栏");
  assert.ok(src.includes("\n  const to = boardColForHits(COLS, boardCol, new Set(hit.map(taskColumn)));\n  if (to && to !== boardCol) setBoardCol(to);"),
    "按标题筛选切到命中卡所在的栏");
  assert.ok(src.includes("\n  if (!boardColMine) boardCol = boardColAuto(COLS, colHas, boardCol);\n  applyBoardCol();"), "你选过就不再自动挑");
  assert.ok(src.includes("if (r.width || r.height) first.set(id, r);") && src.includes("if (!b.width && !b.height) continue;"));
  assert.ok(src.includes("#task-side, #edit, #pick, .modal, #board-bar, #board-seg"));
});

test("side panel says what any card is doing, not only the two home lanes", () => {
  const base = { id: 2, line: "engine", released: true };
  const o = { lineName: (l) => ({ engine: "引擎" })[l] || l, wfLabels: { dep: "依赖完成" } };
  assert.deepEqual(M.sideFallback({ ...base, status: "not_started" }, o), { state: "排队中", next: "等待「引擎」领取" });
  assert.deepEqual(M.sideFallback({ ...base, status: "not_started", last_verdict: "approve" }, o),
    { state: "已打回 · 排队中", next: "等待「引擎」继续" }, "handed back with a note: say so");
  assert.deepEqual(M.sideFallback({ ...base, status: "not_started", released: false }, o), { state: "未放行", next: "放行后才会被领取" });
  assert.deepEqual(M.sideFallback({ ...base, status: "done" }, o), { state: "已完成", next: "无需操作" });
  assert.deepEqual(M.sideFallback({ ...base, status: "waiting", waiting_for: "dep" }, o), { state: "等待中 · 依赖完成", next: "等待依赖完成" });
  const side = src.slice(src.indexOf("function renderSide(){"), src.indexOf("function sideFromHash(){"));
  assert.ok(side.includes("sideTaskStep(t, item)"), "侧栏使用同一状态与下一步计算");
});

test("领取、启动许可、进程与输出观察分开，不接受旧运行观察", () => {
  const base = { status: "in_progress", run_id: "current", hb: "fresh" };
  const step = (trace) => M.homeStep({ ...base, execution_trace: { run_id: "current", ...trace } });
  assert.equal(step({}).state, "已领取 · 开工待核实");
  assert.equal(step({ launch_requested_at: at(1) }).state, "已请求启动 · 开工待核实");
  assert.equal(step({ process_state: "observed" }).state, "进程已启动 · 开工待核实");
  assert.equal(step({ work_state: "activity_observed" }).state, "已领取 · 有输出记录");
  assert.equal(step({ process_state: "not_started" }).next, "检查启动回执");
  assert.equal(step({ run_id: "previous", process_state: "observed" }).state, "已领取 · 开工待核实");
  assert.equal(M.homeStep({ ...base, attempts: 9, heartbeat_at: at(8), work_spans: [{ s: at(1) }] }).state, "已领取 · 开工待核实");
  assert.equal(M.homeStep({ ...base, status: "waiting", waiting_for: "review", execution_trace: { process_state: "observed" } }).state, "待你验收");
});

test("侧栏关联复用父子与依赖，列表外任务不猜原因", () => {
  const rows = [
    { id: 1, subject: "目标", status: "waiting" },
    { id: 2, subject: "当前", parent_id: 1, blocked_by: [4, 99, 4] },
    { id: 3, subject: "子任务", parent_id: 2, status: "not_started" },
    { id: 4, subject: "前置检查", status: "done" },
  ];
  const groups = M.sideRelations(rows[1], rows);
  assert.deepEqual(groups.map((g) => [g.label, g.items.map((r) => r.id)]), [["父任务", [1]], ["子任务", [3]], ["前置依赖", [4, 99]]]);
  assert.deepEqual(groups[2].items[1], { id: 99, title: "当前列表不可见", status: null, visible: false });
  assert.deepEqual(M.sideRelations(null, rows), []);
  const box = src.slice(src.indexOf("function sideRelationshipBox(t){"), src.indexOf("function renderSide(){"));
  assert.ok(box.includes("openSide(") && box.includes("fleetApi.showTask(t.task_uid)"));
  assert.ok(!box.includes("post(") && !box.includes("fetch("), "查看关联不能触发派发或写入");
  assert.ok(src.includes("领取不等于模型已开工") && !src.includes("●启动 ■开工"));
});

test("暖色主题沿用原有色彩变量，浅深两种模式的常用文字保持可读", () => {
  const roots = [...src.matchAll(/:root\{([^}]+)\}/g)].slice(0, 2);
  assert.equal(roots.length, 2);
  const luminance = (hex) => {
    const rgb = hex.slice(1).match(/../g).map((c) => parseInt(c, 16) / 255)
      .map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  for (const root of roots) {
    const tokens = Object.fromEntries([...root[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
    const bg = tokens.bg.slice(1).match(/../g).map((c) => parseInt(c, 16));
    assert.ok(bg[0] > bg[1] && bg[1] > bg[2], "底色为暖色，不借用其他工作台的冷灰底");
    for (const name of ["fg", "dim", "dim2", "accent", "cc", "ok", "warn", "bad"]) {
      const a = luminance(tokens[name]), b = luminance(tokens.panel2);
      assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, name + " 小字号文字对比度不足");
    }
  }
});

test("推理强度初次渲染和拖动后共用中文展示，协议值不变", () => {
  const start = src.indexOf("function effortName(value){"), end = src.indexOf("function renderCfg(){", start);
  const copyStart = src.indexOf("// ── display-copy(pure;tests/panelcopytest.mjs)──"), copyEnd = src.indexOf("// ── /display-copy ──", copyStart);
  const name = new Function(src.slice(copyStart, copyEnd) + "\n" + src.slice(start, end) + ";return effortName;")();
  assert.equal(name("high"), "高"); assert.equal(name("max"), "最高");
  assert.ok(src.includes("esc(effortName(a.effort))") && src.includes("b.textContent = effortName(a.effort)"));
  assert.ok(src.includes("a.effort = domOf(a)[Number(el.value)] || a.effort"), "写回的仍是允许域中的机器值");
});

test("服务没有应答时只显示一条故障与恢复命令，不并列旧告警", () => {
  const local = { node_id: "a", display_name: "台式机 A", local: true, connection_state: "local" };
  const before = { localName: "台式机 A", nodes: [local, { node_id: NODE_B, display_name: "笔记本 B", local: false, connection_state: "failed" }],
    health: { issues: [{ code: "STORAGE_LOW", level: "problem", next_action: "inspect_storage_before_new_work", count: 1 }] },
    setup: { complete: false, done: 3, total: 4, steps: [{ state: "todo", title: "定义你自己的线" }] } };
  const down = M.homeStatus({ ...before, down: { since: "14:05", kind: "unreachable", status: null, local: true } });
  assert.deepEqual([down.tone, down.line, down.alerts.length], ["bad", "看板服务没有应答，下面是断开前的内容", 1],
    "断开前的设备、磁盘与设置告警不能冒充现状");
  assert.deepEqual([down.alerts[0].where, down.alerts[0].what, down.alerts[0].copy],
    ["台式机 A", "电脑在线，看板服务没有应答（14:05 起）", "node cli/start.mjs --background"]);
  assert.match(down.alerts[0].next, /已有任务和结果都保留/);
  const away = M.homeStatus({ ...before, down: { since: "14:05", kind: "unreachable", local: false } });
  assert.equal(away.alerts[0].what, "连不上「台式机 A」上的看板（14:05 起）", "远程页面不能把服务断开直接断言成电脑在线");
  assert.match(away.alerts[0].next, /电脑关着就先开机/);
  const err = M.homeStatus({ ...before, down: { since: "14:05", kind: "error", status: 500, local: true } });
  assert.deepEqual([err.line, err.alerts[0].what, err.alerts[0].copy], ["看板服务出错，下面是出错前的内容", "看板服务出错（HTTP 500）（14:05 起）", null]);
});

test("同一故障家族合并原因、症状和优先下一步，未知代码仍可显示", () => {
  const i = (code, next_action, level = "problem", count = 1) => ({ code, level, next_action, count });
  const dead = M.homeHealthAlerts([i("SCHEDULER_HEARTBEAT_STALE", "inspect_scheduler_owner"), i("SCHEDULER_LOCK_MISSING", "inspect_scheduler_owner")], { here: "台式机 A" });
  assert.deepEqual(dead.map((a) => [a.tone, a.where, a.what, a.next]), [["bad", "台式机 A", "调度器可能已经停了：心跳超时、没有运行锁", "检查调度器进程"]]);
  const first = M.homeHealthAlerts([i("SCHEDULER_HEARTBEAT_STALE", "inspect_scheduler_owner"), i("SCHEDULER_LOCK_ORPHAN", "verify_stop_before_lock_recovery")]);
  assert.deepEqual([first.length, first[0].next], [1, "确认进程已停止，再恢复运行锁"]);
  assert.equal(M.homeHealthAlerts([i("SCHEDULER_LOCK_MISMATCH", "inspect_scheduler_lock"), i("SCHEDULER_OWNER_UNKNOWN", "inspect_node_runtime", "notice")])[0].what,
    "调度器状态待核对：运行锁与记录不符、看不出进程还在不在", "没有停止证据时不能断言已经停机");
  const apart = M.homeHealthAlerts([i("NODE_HEARTBEAT_STALE", "inspect_node_runtime"), i("NODE_SYNC_RETRY", "inspect_node_sync_then_peer", "notice"),
                                    i("STORAGE_LOW", "inspect_storage_before_new_work", "problem", 2)]);
  assert.deepEqual(apart.map((a) => a.what), ["节点运行器心跳超时", "同步正在重试", "磁盘空间不足（2 项）"]);
  assert.equal(M.homeHealthAlerts([i("NODE_SYNC_RETRY", "inspect_node_sync_then_peer")], { skip: ["NODE_SYNC_RETRY"] }).length, 0);
  assert.deepEqual(M.homeHealthAlerts([i("FUTURE_ISSUE", "future"), i("FUTURE_ISSUE", "future")]).map((a) => a.what),
    ["运行检查报告了问题（2 项）"], "未知家族的重复记录不导致整页渲染失败");
});

test("远端电脑连不上与电脑在线但看板没有应答分开说明", () => {
  const local = { node_id: "a", display_name: "台式机 A", local: true, connection_state: "local" };
  const peer = (name, code) => ({ node_id: NODE_B, display_name: name, local: false, connection_state: "failed", projects: [{ project_id: "p", error_code: code }] });
  const s = M.homeStatus({ localName: "台式机 A", nodes: [local, peer("笔记本 B", "PEER_UNREACHABLE"), peer("台式机 C", "REMOTE_502"),
                                                          peer("台式机 D", "PEER_REFUSED"), peer("台式机 E", "NETWORK_ERROR")],
    health: { issues: [{ code: "NODE_SYNC_RETRY", level: "notice", next_action: "inspect_node_sync_then_peer", count: 1 }] } });
  assert.deepEqual(s.alerts.map((a) => [a.where, a.what]), [
    ["笔记本 B", "连不上这台电脑（可能关机或断网）"],
    ["台式机 C", "电脑在线，但它的看板服务没有应答"],
    ["台式机 D", "电脑在线，但它的看板服务没有应答"],
    ["台式机 E", "同步失败"],
  ], "同一次故障的本机同步重试不再单独提示");
  assert.match(s.alerts[1].next, /node cli\/status\.mjs/);
  assert.deepEqual(M.homeStatus({ nodes: [local], fleetError: "x", healthError: "y" }).alerts.map((a) => a.what), ["多机视图和运行检查暂时读不到"]);
});

test("页面经匿名健康探测确认故障，成功读取和实时重连都可恢复", () => {
  assert.ok(src.includes('await window.fetch("/health", { cache: "no-store", credentials: "omit" })'));
  const r = src.slice(src.indexOf("async function refresh(){"), src.indexOf("function live(on, txt){"));
  assert.ok(r.includes("const p = await probeBoard();") && r.includes("if (restartPending) return;") && r.includes("boardDown = null;"));
  assert.ok(r.includes("if (wasDown) loadHomeExtras(true);"), "恢复后重新读取设备与运行检查，不展示断开前旧值");
  assert.ok(r.includes("if (lastGoodRead > started) return;") && r.includes('if (liveOpen) live(true, "实时");'), "过时的失败不能覆盖新成功");
  const sse = src.slice(src.indexOf('const es = window.boardSession.events("/api/events");'), src.indexOf("// ⭐ Event kinds are NOT enumerated here."));
  assert.ok(sse.includes("if (boardDown) refresh();") && sse.includes("if (!restartPending) refresh();"));
  assert.ok(src.includes('document.getElementById("home-view").classList.toggle("stale", !!boardDown);'));
  assert.ok(src.includes("navigator.clipboard.writeText(a.copy)"));
});
