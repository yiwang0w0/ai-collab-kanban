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
  ";return {homeName,homeStep,homeLists,homeStatus,homeHealthWhat,sideControls,newTaskBody,sideFallback,sideRelations,homeHealthAlerts,fleetLinks,fleetStep,fleetInbox,fleetUids,homeNodeLabels,homeLineFaults,homeLogLines,homeLastFault,homeLastFaultTip};")();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NODE_B = "83d5fb7d-b622-44fc-a230-252f8f767824";
const at = (h) => `2026-10-08T${String(h).padStart(2, "0")}:00:00Z`;
const card = (id, extra) => ({ id, task_uid: "u" + id, subject: "卡 " + id, kind: "task", status: "waiting", updated_at: at(id), hb: "", ...extra });
const ids = (rows) => rows.map((r) => r.localId ?? r.key);

test("助手挂上的未放行卡:「待我处理」写「<名称> 挂上 · 待你放行」,排在待放行那一档;没有来源的照旧写「待放行」", () => {
  const nr = [{ code: "NOT_RELEASED", message: "NOT_RELEASED", next_action: "核对任务后显式放行" }];
  const tasks = [card(1, { status: "not_started", released: 0, progress_blockers: nr, posted_by: { executor_id: "asst-bot", label: "手表助手" } }),
                 card(2, { status: "not_started", released: 0, progress_blockers: nr, posted_by: { executor_id: "asst-bot", label: "  " } }),
                 card(3, { status: "waiting", waiting_for: "review", posted_by: { executor_id: "asst-bot", label: "手表助手" } })];
  assert.deepEqual(M.homeLists({ tasks }).mine.map((r) => [r.localId, r.state, r.next, r.rank]),
    [[3, "待你验收", "通过或打回", 2], [1, "手表助手 挂上 · 待你放行", "核对后放行", 5], [2, "待放行", "核对后放行", 5]],
    "放行之后就是普通的卡,来源不再改状态文案");
});

test("decisions and answers wait for me; a delivery waits for me only when no reviewer will take it", () => {
  const tasks = [
    card(4, { waiting_for: "review" }), card(3, { waiting_for: "review", review_hold: "same_family" }),
    card(2, { waiting_for: "decision" }), card(1, { waiting_for: "confirm" }),
    card(5, { waiting_for: "dep" }), card(6, { waiting_for: "rearm" }),
  ];
  const plain = M.homeLists({ tasks, localName: "台式机 A" });
  assert.deepEqual(ids(plain.mine), [1, 2, 3, 4], "confirm, then decision, then deliveries oldest first");
  assert.deepEqual(plain.mine.map((r) => r.next), ["选择方案", "同意或否决", "通过或打回", "通过或打回"]);
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
    [1, "待你验收", "通过或打回"], [2, "待你验收", "通过或打回"], [3, "待你验收", "按对应协议完成结算或人工恢复"],
    [6, "重审受阻", "核对审阅记录及子任务结果"], [8, "待人工裁定", "由操作者裁定或显式解除人工闸"],
    [9, "待人工裁定", "由操作者裁定或显式解除人工闸"], [10, "待放行", "核对后放行"],
  ], "unfinished children and a judged dependency wait are the machine's; a card that only lacks its release waits for me, last");
});

test("只差放行的卡进「待我处理」；祖先未放行或还有别的阻塞的不进；未放行的目标卡进", () => {
  const why = (code, extra) => ({ code, message: code, next_action: "按服务端给的做", ...extra });
  const tasks = [
    card(1, { status: "not_started", released: 0, progress_blockers: [why("NOT_RELEASED")] }),
    card(2, { status: "not_started", released: 0, parent_id: 5, progress_blockers: [why("NOT_RELEASED"), why("ANCESTOR_NOT_RELEASED", { related_task_ids: [5] })] }),
    card(3, { status: "not_started", released: 0, progress_blockers: [why("NOT_RELEASED"), why("DEPENDENCIES_UNFINISHED", { related_task_ids: [1] })] }),
    card(4, { status: "not_started", released: 1 }),
    card(5, { kind: "goal", status: "not_started", released: 0, progress_blockers: [why("DESCENDANTS_UNFINISHED", { related_task_ids: [2] })] }),
    card(6, { kind: "goal", status: "not_started", released: 1, progress_blockers: [why("DESCENDANTS_UNFINISHED", { related_task_ids: [9] })] }),
    card(7, { kind: "goal", status: "not_started", released: 0, progress_blockers: [why("GOAL_WITHOUT_CHILDREN")] }),
    card(8, { status: "not_started", released: 0, human_gate: 1, progress_blockers: [why("NOT_RELEASED"), why("HUMAN_GATE")] }),
  ];
  const { mine, running } = M.homeLists({ tasks });
  assert.deepEqual(mine.map((r) => [r.localId, r.state, r.next, r.rank]),
    [[8, "待人工裁定", "按服务端给的做", 4], [1, "待放行", "核对后放行", 5], [5, "待放行", "核对后放行", 5]],
    "人工闸先于放行；祖先未放行的子卡、依赖未完成的卡、已放行的卡、已放行或没有子任务的目标都不进");
  assert.equal(running.length, 0);
  assert.equal(M.homeStep(tasks[0], { remoteName: "笔记本 B" }).lane, null, "另一台电脑的卡在它自己那里放行");
  assert.equal(M.homeStep(card(9, { status: "not_started", released: 0 })).lane, null, "服务端没给「尚未放行」这一条就不猜");
});

test("侧栏次按钮去哪、受阻原因：心跳中断去执行线，进程未启动看逐项记录，受阻带服务端原因", () => {
  const run = { status: "in_progress", run_id: "r" };
  assert.equal(M.homeStep({ ...run, hb: "dead" }).go, "lines");
  const cold = M.homeStep({ ...run, hb: "fresh", execution_trace: { run_id: "r", process_state: "not_started" } });
  assert.deepEqual([cold.next, cold.go], ["检查启动回执", "receipt"]);
  assert.equal(M.homeStep({ ...run, hb: "fresh" }).go, undefined, "正常在跑的卡没有次按钮");
  // 「已启动」口径(合同 B 裁定):外部执行者领取后心跳过 = 在做,写明对方自报;受管线不变(心跳不能证明开工)
  assert.match(M.homeStep({ ...run, hb: "fresh", self_reported_started_at: "2026-11-11T00:00:00Z" }).state, /在做 · 对方自报$/);
  assert.match(M.homeStep({ ...run, hb: "fresh" }).state, /开工待核实$/, "受管线只有心跳 = 仍待核实");
  assert.match(M.homeStep({ ...run, hb: "fresh", self_reported_started_at: "x", execution_trace: { run_id: "r", process_state: "observed" } }).state, /进程已启动/, "观察到进程时以观察为准");
  const stuck = M.homeStep({ status: "waiting", waiting_for: "rearm",
    progress_blockers: [{ code: "NO_NEW_CHILD_RESULT", message: "未观察到上次审阅之后的新子任务结果", next_action: "核对审阅记录及子任务结果" }] });
  assert.deepEqual([stuck.lane, stuck.state, stuck.why, stuck.next], ["mine", "重审受阻", "未观察到上次审阅之后的新子任务结果", "核对审阅记录及子任务结果"]);
  assert.equal("why" in M.homeStep({ status: "waiting", waiting_for: "dep", progress_blockers: [{ code: "HUMAN_GATE", next_action: "裁定" }] }), false, "服务端没写原因就不出这一行");
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
  // 每条带上这件事的种类、编号和原记录:侧栏按它打开,不再跳去全局视图。
  assert.deepEqual(mine.map((r) => [r.kind, r.id, r.record === (r.kind === "incoming" ? actions.incoming[0] : r.kind === "proposal" ? actions.proposals[0] : actions.results[0])]),
    [["incoming", "d1", true], ["proposal", "r1", true], ["result", "x1", true]]);
  assert.equal(M.homeLists({ actions: { enabled: false, incoming: actions.incoming } }).mine.length, 0);
});

test("the device line is one sentence when all is well and lists what needs attention when not", () => {
  const local = { node_id: "a", display_name: "台式机 A", local: true, connection_state: "local" };
  const b = (state, name = "笔记本 B") => ({ node_id: NODE_B, display_name: name, local: false, connection_state: state });
  const ok = M.homeStatus({ localName: "台式机 A", nodes: [local, b("recent")], health: { issues: [] }, setup: { complete: true, steps: [] } });
  assert.deepEqual([ok.tone, ok.alerts.length, ok.line], ["ok", 0, "2 台电脑正常：本机 台式机 A、笔记本 B 最近已同步"]);
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
    ["bad", "台式机 A", "磁盘空间不足，共 2 项", null],
    ["warn", "台式机 A", "调度器运行锁异常", null],
    ["warn", "看板设置", "还差 1 步：定义你自己的线", "settings"],
  ]);
  assert.equal(bad.alerts[2].next, "先腾出磁盘空间再派新任务");
  assert.equal(M.homeHealthWhat("SOMETHING_NEW"), "运行检查报告了问题", "an unknown code still says something, never the code");
  assert.equal(UUID.test(JSON.stringify(bad)), false);
  // A step the server does in one request carries its button onto home, with the server's own
  // detail as the next step and its confirm text; the count is not prefixed by one computer.
  // 夹具逐字抄服务端当下的文案(卡 #16 清掉了「点一下,表示…」与「你正在…」两种注释式写法);
  //   断言钉的语义不变:服务端一次请求能做完的引导步骤,把按钮和它自己的 detail 带上首页。
  const bless = { state: "todo", title: "确认当前版本", detail: "这个版本还没确认过",
    action: { type: "api", method: "POST", path: "/api/setup/bless", label: "确认当前版本", body: { confirm_tree: "t1" }, confirm: "确认版本 t1" } };
  const fresh = M.homeStatus({ localName: "台式机 A", nodes: [local], health: { issues: [] },
                               setup: { complete: false, done: 3, total: 4, steps: [{ state: "done", title: "起来" }, bless] } });
  assert.equal(fresh.line, "1 项需要注意");
  assert.deepEqual(fresh.alerts.map((a) => [a.what, a.next, a.go, a.action]), [
    ["还差 1 步：确认当前版本", "这个版本还没确认过", null,
     { path: "/api/setup/bless", body: { confirm_tree: "t1" }, confirm: "确认版本 t1", label: "确认当前版本" }],
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
    assert.equal(M.sideControls({ id: 9, status, released: 1 }).kind, "none", status + " has nothing to rule on");
  assert.equal(M.sideControls(w({ waiting_for: "review" }), { remote: true, mine: true }).kind, "none", "another computer's cache is read-only");
  assert.equal(M.sideControls(null).kind, "none");
  // 未开始的卡两种轮到人的情形:人工闸、还没放行。远端卡照旧只读。
  const q = (extra) => ({ id: 9, status: "not_started", ...extra });
  assert.deepEqual(M.sideControls(q({ human_gate: 1, released: 0 }), { mine: true }), { kind: "gate", primary: true }, "人工闸先于放行");
  assert.deepEqual(M.sideControls(q({ released: 0 }), { mine: true }), { kind: "release", primary: true });
  assert.deepEqual(M.sideControls(q({ released: 0 }), { mine: false }), { kind: "release", primary: false }, "还有别的阻塞时放行不是主操作");
  assert.equal(M.sideControls(w({ waiting_for: "review", human_gate: 1 }), { mine: true }).kind, "accept", "等待中的人工闸卡照旧是通过");
  for (const extra of [{ human_gate: 1 }, { released: 0 }])
    assert.equal(M.sideControls(q(extra), { remote: true, mine: true }).kind, "none", "远端卡仍为 none");
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
  // 选择器后面加了协作区批准行的备注(#approvals input);守的语义不变:没发出去的新建任务标题拦住自动刷新。
  assert.ok(src.includes('querySelectorAll("textarea, #line-add input, #line-add select, #home-new input, #approvals input")'),
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
  // 协作区的三样:批准行的备注(#approvals input)、只显示一次的新令牌(#apt-new 没带 hidden)、展开中的强制释放理由。
  const coord = { notes: [], tokenShown: false, lockForm: false, codeShown: false };
  const document = { querySelectorAll: (sel) => sel.split(",").flatMap((part) => {
    part = part.trim();
    if (part === "textarea") return els.filter((e) => e.tagName === "TEXTAREA");
    if (part === "#approvals input") return coord.notes;
    const m = part.match(/^#(line-add|home-new) (input|select)$/);
    assert.ok(m, "选择器多了没造过的部分:" + part);
    return els.filter((e) => e.scope === m[1] && e.tagName === m[2].toUpperCase());
  }), querySelector: (sel) => {
    const hit = sel.split(",").map((part) => part.trim()).some((part) => {
      if (part === "#apt-new:not([hidden])") return coord.tokenShown;
      if (part === "#coord [data-lock-form]") return coord.lockForm;
      if (part === "#ai-code:not([hidden]) .ac-code") return coord.codeShown;
      assert.fail("选择器多了没造过的部分:" + part);
    });
    return hit ? {} : null;
  } };
  const [hasUnsavedInput, holdReload] = new Function("document", src.slice(a, b) + "\nreturn [hasUnsavedInput, holdReload];")(document);
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
  // 协作区:写了一半的批准备注、还开着的新令牌、展开中的强制释放理由,各自都拦。
  assert.ok(src.slice(a, b).includes('document.querySelector("#apt-new:not([hidden]), #coord [data-lock-form]")'), "选择器含 #apt-new 与展开中的理由");
  coord.notes = [{ tagName: "INPUT", type: "text", value: "  " }];
  assert.equal(hasUnsavedInput(), false, "批准备注只有空白不算");
  coord.notes = [{ tagName: "INPUT", type: "text", value: "持有者已离开" }];
  assert.equal(hasUnsavedInput(), true, "批准行写了备注");
  coord.notes = []; coord.tokenShown = true;
  assert.equal(hasUnsavedInput(), true, "新令牌只显示一次,还开着就不自动刷新");
  coord.tokenShown = false; coord.lockForm = true;
  assert.equal(hasUnsavedInput(), true, "强制释放的理由框开着,空着也算");
  coord.lockForm = false;
  assert.equal(hasUnsavedInput(), false);
  // 接入码正在显示(没过期):码只在发码应答里出现一次 → 自动刷新同样拦下(holdReload),两处刷新判定都用它
  assert.equal(holdReload(), false); coord.codeShown = true;
  assert.equal(holdReload(), true, "接入码显示期间不自动刷新");
  coord.codeShown = false; coord.tokenShown = true;
  assert.equal(holdReload(), true, "没保存的输入照旧拦"); coord.tokenShown = false;
  assert.equal(src.split("if (holdReload()){").length - 1, 2, "换版本与重启后两处都用 holdReload");
  // 新令牌显示框是文本块不是输入框:不被 textarea / input 的判定带走,靠 #apt-new 的显隐判。
  assert.match(src, /<code class="apt-token" id="apt-new-token" tabindex="0" aria-label="新生成的批准令牌"><\/code>/);
  assert.ok(src.includes('document.getElementById("apt-new-token").textContent = r.token;') && src.includes('document.getElementById("apt-new").hidden = true;'));
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
  assert.deepEqual(M.sideFallback({ ...base, status: "waiting", waiting_for: "dep" }, o), { state: "等待中 · 依赖完成", next: "依赖完成" });
  const rearm = M.sideFallback({ ...base, status: "waiting", waiting_for: "rearm" }, { ...o, wfLabels: { rearm: "等待重审" } });
  assert.deepEqual(rearm, { state: "等待中 · 等待重审", next: "等待重审" }, "下一步直接用状态词");
  assert.ok(!rearm.next.includes("等待等待"));
  const side = src.slice(src.indexOf("function renderSide(){"), src.indexOf("function sideFromHash(){"));
  assert.ok(side.includes("sideTaskStep(t, item)"), "侧栏使用同一状态与下一步计算");
});

test("未开始的卡为什么没被领：服务端原因、无进展、线未启动，都不是才写排队中", () => {
  const base = { id: 2, line: "engine", released: true, status: "not_started" };
  const o = { lineName: (l) => ({ engine: "引擎" })[l] || l };
  const dep = { code: "DEPENDENCIES_UNFINISHED", message: "依赖任务尚未完成", next_action: "核对依赖任务与定义", related_task_ids: [4, 9] };
  assert.deepEqual(M.sideFallback({ ...base, released: false, progress_blockers: [{ code: "NOT_RELEASED", message: "任务尚未放行", next_action: "核对任务后显式放行" }, dep] }, o),
    { state: "依赖任务尚未完成", next: "核对依赖任务与定义", related: [4, 9] }, "「尚未放行」之外的第一条原因原样写，带它指向的卡号");
  assert.deepEqual(M.sideFallback({ ...base, progress_blockers: [{ code: "ATTEMPT_LIMIT", message: "累计派发次数已达到上限", next_action: "人工核对失败原因并补充输入或调整任务" }] }, o),
    { state: "累计派发次数已达到上限", next: "人工核对失败原因并补充输入或调整任务" }, "原因不指向别的卡就不带 related");
  assert.deepEqual(M.sideFallback({ ...base, no_progress: { since: at(1) } }, { ...o, lineState: "stopped" }),
    { state: "无进展，已暂停派发", next: "补充任务说明或推进依赖" }, "无进展先于线的状态");
  assert.deepEqual(M.sideFallback(base, { ...o, lineState: "stopped" }), { state: "「引擎」未启动", next: "启动执行线", go: "lines" });
  for (const lineState of ["running", "external", null])
    assert.deepEqual(M.sideFallback(base, { ...o, lineState }), { state: "排队中", next: "等待「引擎」领取" }, String(lineState));
  // 目标卡:状态写子任务完成数。
  const goal = { id: 3, kind: "goal", status: "not_started", released: true };
  assert.deepEqual(M.sideFallback(goal, { children: { done: 1, total: 3 } }), { state: "子任务 1/3 完成", next: "推进未完成的子任务" });
  assert.deepEqual(M.sideFallback(goal, { children: { done: 3, total: 3 } }), { state: "子任务 3/3 完成", next: "无需操作" }, "全部完成后由看板收尾，不写内部用语");
  assert.equal(M.sideFallback(goal, { children: { done: 0, total: 0 } }).state, "还没有子任务");
  // 调用处用执行线接口算出线的状态再传入。
  const step = src.slice(src.indexOf("function sideLineState(line){"), src.indexOf("/** 进行中的卡:最近一次心跳"));
  assert.ok(step.includes("workers.find((x) => x.line === line)") && step.includes("lineState: sideLineState(t.line)"));
});

test("刷新后保留：留言、方案选择、执行结果、回执和草稿版本写进本标签页，读回后恢复", () => {
  const a = src.indexOf('const DRAFTS_KEY = "tb_drafts_v1";'), b = src.indexOf("\nrestoreDrafts();\n", a);
  assert.ok(a > 0 && b > a, "drafts block not found");
  const NAMES = ["verdictDraft", "decisionChoice", "receiptDraft", "outcomeDraft", "draftVersions"];
  const boot = (sessionStorage) => {
    const maps = NAMES.map(() => new Map());
    const api = new Function("sessionStorage", ...NAMES, src.slice(a, b) + ";return { persistDrafts, restoreDrafts };")(sessionStorage, ...maps);
    return { api, maps: Object.fromEntries(NAMES.map((n, i) => [n, maps[i]])) };
  };
  const mem = new Map(), storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  const first = boot(storage);
  first.maps.verdictDraft.set(7, "请补一条测试"); first.maps.verdictDraft.set(8, "   ");
  first.maps.decisionChoice.set(9, "B"); first.maps.outcomeDraft.set(9, "failure"); first.maps.receiptDraft.set(9, "exit 1");
  first.maps.draftVersions.set(7, 3); first.maps.draftVersions.set(9, 12); first.maps.draftVersions.set(20, 4);
  first.api.persistDrafts({ new: { title: "草稿标题" } });
  const stored = JSON.parse(mem.get("tb_drafts_v1"));
  for (const key of ["vin", "choice", "outcome", "receipt", "versions"]) assert.ok(Object.hasOwn(stored, key), key);
  assert.deepEqual(stored, { vin: { 7: "请补一条测试" }, choice: { 9: "B" }, outcome: { 9: "failure" }, receipt: { 9: "exit 1" },
    versions: { 7: 3, 9: 12 }, new: { title: "草稿标题" } }, "只有空白的留言不存；没有草稿的卡不留版本");
  const again = boot(storage); again.api.restoreDrafts();
  assert.deepEqual([...again.maps.decisionChoice], [[9, "B"]]);
  assert.deepEqual([...again.maps.outcomeDraft], [[9, "failure"]]);
  assert.deepEqual([...again.maps.receiptDraft], [[9, "exit 1"]]);
  assert.deepEqual([...again.maps.verdictDraft], [[7, "请补一条测试"]]);
  assert.deepEqual([...again.maps.draftVersions], [[7, 3], [9, 12]]);
  // 存储读写都抛错时照常工作,只是不保留;存进去的脏数据不进草稿。
  const broken = boot({ getItem() { throw Error("denied"); }, setItem() { throw Error("denied"); } });
  broken.maps.decisionChoice.set(1, "A"); broken.api.persistDrafts(); broken.api.restoreDrafts();
  assert.deepEqual([...broken.maps.decisionChoice], [[1, "A"]]);
  mem.set("tb_drafts_v1", JSON.stringify({ choice: { x: "A", 5: 9 }, versions: { 5: "3" }, receipt: null }));
  const dirty = boot(storage); dirty.api.restoreDrafts();
  assert.deepEqual([dirty.maps.decisionChoice.size, dirty.maps.draftVersions.size, dirty.maps.receiptDraft.size], [0, 0, 0]);
  // 结构钉:三处输入都落盘;启动时读回;侧栏恢复后有方案草稿就重开方案弹窗;纯数字的 #task= 按卡号打开。
  for (const line of ["receiptDraft.set(Number(receiptId), e.target.value);\n    persistDrafts();",
    "outcomeDraft.set(Number(outcomeId), e.target.value);\n    persistDrafts();", "decisionChoice.set(Number(id), e.target.value);\n  persistDrafts();"])
    assert.ok(src.includes(line), line);
  const boot2 = src.slice(src.indexOf("function sideAfterRefresh(){"), src.indexOf("// ── 首页「新建任务」(第 3 批)"));
  assert.ok(boot2.includes("if (t && decisionChoice.has(t.id) && t.status === \"waiting\" && t.decision_package?.options?.length) openDecisionModal(t);"));
  const hash = src.slice(src.indexOf("function sideFromHash(){"), src.indexOf("function sideAfterRefresh(){"));
  assert.ok(hash.includes("if (/^\\d+$/.test(ref)) {") && hash.includes("openSide({ id, uid: null, item: null });"), "批准接口给的 /#task=卡号 链接能打开");
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

test("视觉底座：侧栏底色两种模式都有定义，两押上膛字色跟主题走，首页页脚不带括号补充", () => {
  const roots = [...src.matchAll(/:root\{([^}]+)\}/g)].slice(0, 2);
  assert.equal(roots.length, 2);
  for (const root of roots) assert.match(root[1], /--bg2:\s*#[0-9a-f]{6}/, "浅色与深色都定义 --bg2");
  const armed = src.match(/button\.armed\{[^}]*\}/);
  assert.ok(armed && !armed[0].includes("#1a1a1a") && armed[0].includes("color:var(--bg)!important"), "上膛态的字用纸色，不写死深色");
  assert.ok(!src.includes("（其中"), "页脚文案不带全角括号补充");
  assert.ok(src.includes('(held ? "，其中 " + held + " 项未放行" : "")'));
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
  // 文案按「只说一遍、不带括号」改过;守的语义不变:断开时只有一条告警,断开前的告警不并列。
  assert.deepEqual([down.tone, down.line, down.alerts.length], ["bad", "下面是断开前的内容", 1],
    "断开前的设备、磁盘与设置告警不能冒充现状");
  assert.deepEqual([down.alerts[0].where, down.alerts[0].what, down.alerts[0].next, down.alerts[0].copy],
    ["台式机 A", "看板服务从 14:05 起没有应答", "重新启动看板：node cli/start.mjs --background", "node cli/start.mjs --background"]);
  assert.match(down.alerts[0].tip, /已有任务和结果都保留/, "保留数据这一句进悬停说明，不进正文");
  assert.equal(down.alerts[0].cmd, "node cli/status.mjs --log", "查看日志的命令折叠在告警行里");
  const away = M.homeStatus({ ...before, down: { since: "14:05", kind: "unreachable", local: false } });
  assert.equal(away.alerts[0].what, "从 14:05 起连不上「台式机 A」上的看板", "远程页面不能把服务断开直接断言成电脑在线");
  assert.equal(away.alerts[0].next, "到那台电脑上运行 node cli/status.mjs");
  const err = M.homeStatus({ ...before, down: { since: "14:05", kind: "error", status: 500, local: true } });
  assert.deepEqual([err.line, err.alerts[0].what, err.alerts[0].copy], ["下面是断开前的内容", "看板服务从 14:05 起出错，返回 HTTP 500", null]);
  for (const s of [down, away, err]) {
    assert.match(s.alerts[0].what, /从 14:05 起/);
    assert.doesNotMatch(JSON.stringify(s), /[（）]/, "断开的原因、下一步和状态行都不带全角括号");
  }
  assert.equal(M.homeStatus({ ...before, down: { kind: "unreachable", local: true } }).alerts[0].what, "看板服务没有应答", "不知道从几点起就不写时刻");
  // 页头只留短状态,原因和下一步不说第二遍。
  assert.ok(src.includes('const downText = () => boardDown && boardDown.kind === "error" ? "出错" : "已断开";'));
  assert.ok(src.includes('live(false, "看板还没回来。下一步：查看 board.log", "日志：" + log)'), "30 秒提示：一句状态加一句下一步，日志路径进悬停说明");
  assert.ok(src.includes("el.textContent = txt; el.title = title || \"\";"), "live() 的第三个入参只进 title");
});

test("执行线故障按原因合并：同因的线一条，外部线与运行中的线不算，待核实是警告", () => {
  // 样例与预期输出取自运维线 core/board-run.mjs 的 mergeLineFaults(同输入同输出);两处合并后只留这一份。
  const workers = [
    { line: "engine", running: true, desired_running: true, exit_code: null, stop_reason: null, stop_text: "", last_log: ["领取 #4"] },
    { line: "design", running: false, desired_running: false, exit_code: 3, stop_reason: null, stop_text: "启动被拒绝", last_log: ["源码闸拒绝启动", "源码闸拒绝启动"] },
    { line: "review", running: false, desired_running: false, exit_code: 3, stop_reason: null, stop_text: "启动被拒绝", last_log: [] },
    { line: "qa", running: false, desired_running: false, exit_code: 3, stop_reason: null, stop_text: "启动被拒绝", last_log: ["源码闸拒绝启动  "] },
    { line: "docs", running: false, desired_running: true, exit_code: 1, stop_reason: { reason: "crash", at: "2026-11-10T05:00:00.000Z" }, stop_text: "崩溃 · 2026-11-10 05:00:00Z", last_log: ["Traceback", "", 7] },
    { line: "ops", running: false, desired_running: true, exit_code: null, stop_reason: null, stop_text: "", last_log: [] },
    { line: "ext", running: false, external: true, desired_running: true, exit_code: 3, stop_reason: null, stop_text: "启动被拒绝" },
    { line: "idle", running: false, desired_running: false, exit_code: 0, stop_reason: { reason: "by_user", at: "2026-11-10T04:00:00.000Z" }, stop_text: "用户停止 · 2026-11-10 04:00:00Z" },
    null, { running: false, exit_code: 3 },
  ];
  const labels = { engine: "引擎", design: "设计", review: "审阅" };
  assert.deepEqual(M.homeLineFaults(workers, labels), [
    { tone: "bad", where: "执行线", what: "设计、审阅、qa 启动被拒绝", next: "运行 node cli/doctor.mjs 找出原因，修好后在面板启动执行线",
      lines: ["design", "review", "qa"], log: ["设计：源码闸拒绝启动", "设计：源码闸拒绝启动", "qa：源码闸拒绝启动"] },
    { tone: "bad", where: "执行线", what: "docs 崩溃", next: "运行 node cli/status.mjs --log 查看最近日志，修好后在面板启动执行线",
      lines: ["docs"], log: ["docs：Traceback"] },
    { tone: "warn", where: "执行线", what: "ops 已请求启动，待核实", next: "稍后再运行 node cli/status.mjs；仍未运行就在面板重新启动执行线",
      lines: ["ops"], log: [] },
  ], "三条线同因合成一条；外部线、运行中的线、正常停止的线不算");
  assert.deepEqual(M.homeLineFaults(null), []);
  assert.deepEqual(M.homeLineFaults([{ line: "toString", running: false, exit_code: 3, stop_reason: null }], {})[0].what, "toString 启动被拒绝", "线名对不上显示名时原样写，不取原型上的键");
  assert.deepEqual(M.homeLogLines(["设计：源码闸拒绝启动", "设计：源码闸拒绝启动", "qa：源码闸拒绝启动", "设计：源码闸拒绝启动"]),
    ["设计：源码闸拒绝启动  ×2", "qa：源码闸拒绝启动", "设计：源码闸拒绝启动"], "只合并连续重复的行");
  assert.deepEqual(M.homeLogLines(undefined), []);
  // 首页:故障接在其余告警之后,计数算进状态行;断开时只出断开一条。
  const local = { node_id: "a", display_name: "台式机 A", local: true, connection_state: "local" };
  const setup = { complete: false, done: 3, total: 4, steps: [{ state: "todo", title: "定义你自己的线" }] };
  const s = M.homeStatus({ localName: "台式机 A", nodes: [local], setup, workers, lineLabels: labels });
  assert.deepEqual(s.alerts.map((a) => [a.tone, a.where, a.go]), [["warn", "看板设置", "settings"], ["bad", "执行线", "lines"], ["bad", "执行线", "lines"], ["warn", "执行线", "lines"]]);
  assert.deepEqual([s.tone, s.line], ["bad", "4 项需要注意"]);
  assert.equal(s.alerts[1].what, "设计、审阅、qa 启动被拒绝");
  const down = M.homeStatus({ localName: "台式机 A", nodes: [local], setup, workers, lineLabels: labels, down: { since: "14:05", kind: "unreachable", local: true } });
  assert.deepEqual(down.alerts.map((a) => a.where), ["台式机 A"], "断开时不并列执行线故障");
  assert.equal(M.homeStatus({ localName: "台式机 A", nodes: [local] }).alerts.length, 0, "不传 workers 时与原来一样");
  // 命令行与首页读同一份。
  const model = readFileSync(new URL("../core/home-model.mjs", import.meta.url), "utf8");
  assert.ok(model.includes("return { homeStatus, homeName, homeLineFaults, homeLogLines };"));
});

test("订阅额度用完被看板停下的线：单列一种原因，不建议重启，首页这一条不给去设置的按钮", () => {
  // 服务端在池不可用时带着运行意图把线停下:desired_running 仍为真,停止原因是随看板停止,另给 pool_blocked。
  const stopped = { reason: "stopped-with-board", at: "2026-11-10T05:00:00.000Z" };
  const workers = [
    { line: "engine", running: false, desired_running: true, pool_blocked: true, exit_code: null, stop_reason: stopped, stop_text: "随看板停止 · 2026-11-10 05:00:00Z", last_log: [] },
    { line: "design", running: false, desired_running: true, pool_blocked: true, exit_code: null, stop_reason: stopped, stop_text: "随看板停止 · 2026-11-10 05:00:00Z", last_log: [] },
    { line: "ops", running: false, desired_running: true, pool_blocked: false, exit_code: null, stop_reason: null, stop_text: "", last_log: [] },
    // 没想跑的线:池不可用也不算故障。在跑的线(切到另一个池)不算。
    { line: "idle", running: false, desired_running: false, pool_blocked: true, exit_code: 0, stop_reason: { reason: "stopped-by-user", at: "2026-11-10T04:00:00.000Z" }, stop_text: "用户停止" },
    { line: "moved", running: true, desired_running: true, pool_blocked: false, exit_code: null, stop_reason: null, stop_text: "" },
  ];
  const faults = M.homeLineFaults(workers, { engine: "引擎", design: "设计" });
  assert.deepEqual(faults, [
    { tone: "warn", where: "执行线", what: "引擎、设计 订阅额度用完，已暂停", next: "无需操作，额度恢复后看板自动启动", lines: ["engine", "design"], log: [], go: null },
    { tone: "warn", where: "执行线", what: "ops 已请求启动，待核实", next: "稍后再运行 node cli/status.mjs；仍未运行就在面板重新启动执行线", lines: ["ops"], log: [] },
  ]);
  assert.doesNotMatch(faults[0].next, /重新启动|重启/, "池没恢复前重启不起作用,不建议");
  // 崩溃和启动被拒绝优先于池:那是要人处理的故障。
  assert.equal(M.homeLineFaults([{ line: "x", running: false, desired_running: true, pool_blocked: true, exit_code: 1, stop_reason: { reason: "crash", at: "2026-11-10T05:00:00.000Z" }, stop_text: "崩溃" }])[0].tone, "bad");
  const local = { node_id: "a", display_name: "台式机 A", local: true, connection_state: "local" };
  const s = M.homeStatus({ localName: "台式机 A", nodes: [local], workers, lineLabels: {} });
  assert.deepEqual(s.alerts.map((a) => [a.what, a.go]), [["engine、design 订阅额度用完，已暂停", null], ["ops 已请求启动，待核实", "lines"]]);
  // 设置页那一行的状态词和告警说同一件事。
  assert.ok(src.includes('!w.desired_running ? "已停止" : w.pool_blocked === true ? "额度用完，已暂停" : "已请求启动，待核实"'));
});

test("上次故障一句话：字段不合格不出，只写发生了什么，可能的原因进悬停说明", () => {
  assert.equal(M.homeLastFault({ kind: "exit", at: "2026-11-10T05:00:00.000Z", exit_code: 3 }), "看板服务退出，退出码 3");
  assert.equal(M.homeLastFault({ kind: "exit", at: "2026-11-10T05:00:00.000Z", exit_code: null }), "看板服务被结束");
  assert.equal(M.homeLastFault({ kind: "restart_loop", at: "2026-11-10T05:00:00.000Z" }), "看板连续重启，已停止自动重启");
  assert.equal(M.homeLastFault({ kind: "interrupted", at: "2026-11-10T05:00:00.000Z" }), "看板运行中断");
  for (const bad of [null, undefined, "x", {}, { kind: "exit" }, { at: "2026-11-10T05:00:00.000Z" }]) assert.equal(M.homeLastFault(bad), null);
  // 正文不写内部说法和猜测的原因:可能的原因只进这一行的 title。
  for (const kind of ["exit", "restart_loop", "interrupted"])
    assert.doesNotMatch(M.homeLastFault({ kind, at: "2026-11-10T05:00:00.000Z", exit_code: 1 }), /守护|重起|可能/);
  assert.equal(M.homeLastFaultTip({ kind: "interrupted", at: "2026-11-10T05:00:00.000Z" }), "可能是关机、断电或进程被结束");
  assert.equal(M.homeLastFaultTip({ kind: "restart_loop", at: "2026-11-10T05:00:00.000Z" }), "");
  assert.equal(M.homeLastFaultTip({ kind: "exit", at: "2026-11-10T05:00:00.000Z", exit_code: 3 }), "");
  for (const bad of [null, {}, { kind: "interrupted" }]) assert.equal(M.homeLastFaultTip(bad), "");
  // 第三波:悬停说明取 /api/setup 的 last_fault.reason;退出类的退出码已在正文里,不重复。执行线行的兜底只写状态与时刻,退出码进技术信息。
  assert.deepEqual([M.homeLastFaultTip({ kind: "restart_loop", at: "2026-11-10T05:00:00.000Z", reason: "短时间内重启次数超过上限" }),
    M.homeLastFaultTip({ kind: "exit", at: "2026-11-10T05:00:00.000Z", exit_code: 3, reason: "退出码 3" })], ["短时间内重启次数超过上限", ""]);
  assert.ok(src.includes('"已停止" + (w.stop_reason?.at ? " · " + localTime(w.stop_reason.at) : "")') && src.includes('"技术信息：退出码 " + w.exit_code') && !src.includes("已停止，退出码"));
  assert.ok(src.includes('tip = homeLastFaultTip(fault);'), "原因放在这一行的 title");
  assert.ok(src.includes('const fault = boardDown ? null : lastSetup?.last_fault || meta.last_fault, faultText = homeLastFault(fault);'), "断开时不出这一行");
  assert.ok(src.includes('last.dataset.tone = "quiet"; if (tip) last.title = tip;'));
});

test("结构钉：触摸目标、手机任务面板的焦点、核对弹窗的主按钮、日志一层滚动、未保存的编辑浮层", () => {
  const style = src.slice(src.indexOf("<style>"), src.indexOf("</style>"));
  // 触摸:折叠标题至少 40px。计划旧版、技术信息、最近流水三处补进最后那一块触摸规则。
  const touch = style.slice(style.lastIndexOf("@media (max-width:620px),(pointer:coarse){"));
  assert.ok(touch.includes(".coord-fold > summary,.fleet-tech > summary{padding:11px 0}"), "技术信息的折叠标题");
  assert.ok(touch.includes(".plan-old > summary{padding-block:11px}"), "计划旧版的折叠条只加上下，左右内边距照旧");
  assert.ok(touch.includes(".coord-fold.coord-sec > summary{padding:13px 0}"), "最近流水字号小，多垫才到 40");
  // 没有悬停可看全文的地方不截断。
  assert.ok(touch.includes(".coord-ex .ex-now{display:block;-webkit-line-clamp:none;line-clamp:none;overflow:visible}"));
  assert.ok(touch.includes(".hand-row .cr-sum{white-space:normal}"));
  // 手机上任务面板打开:被盖住的对话区和输入区不在 Tab 顺序和读屏里;焦点进面板,收起回到开关。
  const phone = style.slice(style.indexOf("  @media (max-width:620px){\n    #home-view > .home-status{"), style.indexOf("  @media (prefers-reduced-motion: reduce){ .chat-list"));
  assert.ok(phone.includes(".chat-shell.work-open :is(.chat-flow,.chat-compose){visibility:hidden}"));
  const work = src.slice(src.indexOf("function chatWork(open){"), src.indexOf("/** 发一条消息。"));
  assert.ok(work.includes("if (!toggle.offsetParent || open === was) return;"), "桌面宽度开关不显示，不挪焦点");
  assert.ok(work.includes('if (open) (work.querySelector("button:not([disabled]), [tabindex]:not([tabindex=\'-1\'])") || toggle).focus({ preventScroll: true });'));
  assert.ok(work.includes("else if (inside || !document.activeElement || document.activeElement === document.body) toggle.focus({ preventScroll: true });"));
  // 核对弹窗里真正提交的那一个是主按钮;关闭不是。
  assert.ok(src.includes('<button type="submit" id="fleet-action-submit" class="pri">确认提交</button>'));
  assert.ok(src.includes('<button type="button" id="fleet-action-close">关闭</button>'));
  // 首页状态条里展开日志:只留日志自己那一层滚动。
  assert.ok(style.includes("#home-view > .home-status:has(.hs-log[open]){max-height:none}"));
  // 批准行的按钮式标题与同列文字标题同一行高。
  assert.match(style, /button\.cr-link\{[^}]*line-height:1\.5\}/);
  // 浅色对比度:对话列表悬停时第二行小字用墨色。
  assert.ok(style.includes('.cl-item:hover:not([aria-current="true"]) .cl-s{color:var(--fg)}'));
  // 编辑浮层里说明或验收条件改了没保存:再点「编辑」「改执行线」不重填。
  const edit = src.slice(src.indexOf("function openEdit(anchor, taskId){"), src.indexOf("/** 编辑浮层里有没有改了还没保存的说明或验收条件。 */"));
  const guard = edit.indexOf('if (epop.classList.contains("show") && editDirty()) {'), fill = edit.indexOf("epop.innerHTML = `");
  assert.ok(guard > 0 && fill > guard, "先判未保存，再重填");
  assert.ok(edit.slice(guard, fill).includes('if (n) n.textContent = "先保存或关闭";') && edit.slice(guard, fill).includes("return;"));
});

test("告警行组件：首页与设置页共用，日志走 textContent，展开状态按原因记住；接口缺席的两类读取不进 refresh 的并行读取", () => {
  const row = src.slice(src.indexOf("function homeAlertRow(a){"), src.indexOf("/** Other computers known to this board"));
  assert.ok(row.includes("pre.textContent = homeLogLines(a.log).join(String.fromCharCode(10));"), "日志是执行线的原始输出，只按纯文本放");
  assert.ok(!/innerHTML\s*=/.test(row) && !row.includes("insertAdjacentHTML(\"afterbegin\", a"), "告警行不把数据拼成 HTML");
  assert.ok(row.includes("if (a.tip) row.title = a.tip;") && row.includes('fold("日志命令", homeEl("code", a.cmd, "hs-cmd"))'));
  assert.ok(row.includes('if (!String(a.what).includes(a.where)) what.append(homeEl("b", a.where, "hs-where"), " ");'), "原因里已经写了是哪里，就不再重复一遍");
  assert.ok(row.includes("d.open = homeLogOpen.has(key);") && row.includes('key = a.where + " " + a.what'), "重建后照原样展开");
  assert.equal(row.split("row.append(b);").length - 1, 3, "三种按钮");
  assert.ok(/if \(a\.action\)\{[^]*?\n  else if \(a\.go\)\{[^]*?\n  else if \(a\.copy\)\{/.test(row), "三种按钮互斥：一条告警最多一个");
  const rig = src.slice(src.indexOf("function renderRig(){"), src.indexOf("let MODELS = []"));
  assert.ok(rig.includes('homeFill(document.getElementById("rig-faults"), JSON.stringify(faults), () => faults.map((a) => homeAlertRow(a)));'));
  assert.ok(!rig.includes("last_log") && !rig.includes("sl.tail"), "执行线行里不再写日志");
  assert.ok(rig.includes("w.stop_reason?.at ? localTime(w.stop_reason.at)"), "停止时间取服务端记下的时刻");
  assert.match(src, /<div class="rig-faults" id="rig-faults"><\/div>\s*<div class="rig" id="rig"><\/div>/);
  assert.ok(src.includes("healthError: homeHealthError, setup: lastSetup, workers, lineLabels: LINE_LABELS,"), "首页把执行线交给 homeStatus");
  const refresh = src.slice(src.indexOf("async function refresh(){"), src.indexOf("function live(on, txt, title){"));
  const all = refresh.slice(refresh.indexOf("await Promise.all(["), refresh.indexOf("]);"));
  assert.ok(all.includes('fetch("/api/usage")') && !all.includes("/api/usage/card") && !all.includes("/api/usage?by=") && !all.includes("/api/cli-versions"),
    "单卡用量、用量汇总与 CLI 版本不进每次刷新的并行读取");
  assert.ok(src.includes('else if (v === "settings") { loadHomeExtras(true); cliVersionsLoad();') && src.includes('if (v === "history") historyUsageLoad();'));
  assert.ok(src.includes("if (homeView === \"settings\" && !document.hidden && Date.now() - cliVersions.at >= 600000) cliVersionsLoad();"), "停留在设置页时最多十分钟读一次");
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
  assert.deepEqual(apart.map((a) => a.what), ["节点运行器心跳超时", "同步正在重试", "磁盘空间不足，共 2 项"]);
  assert.equal(M.homeHealthAlerts([i("NODE_SYNC_RETRY", "inspect_node_sync_then_peer")], { skip: ["NODE_SYNC_RETRY"] }).length, 0);
  assert.deepEqual(M.homeHealthAlerts([i("FUTURE_ISSUE", "future"), i("FUTURE_ISSUE", "future")]).map((a) => a.what),
    ["运行检查报告了问题，共 2 项"], "未知家族的重复记录不导致整页渲染失败");
});

test("远端电脑连不上与电脑在线但看板没有应答分开说明", () => {
  const local = { node_id: "a", display_name: "台式机 A", local: true, connection_state: "local" };
  const peer = (name, code) => ({ node_id: NODE_B, display_name: name, local: false, connection_state: "failed", projects: [{ project_id: "p", error_code: code }] });
  const s = M.homeStatus({ localName: "台式机 A", nodes: [local, peer("笔记本 B", "PEER_UNREACHABLE"), peer("台式机 C", "REMOTE_502"),
                                                          peer("台式机 D", "PEER_REFUSED"), peer("台式机 E", "NETWORK_ERROR")],
    health: { issues: [{ code: "NODE_SYNC_RETRY", level: "notice", next_action: "inspect_node_sync_then_peer", count: 1 }] } });
  assert.deepEqual(s.alerts.map((a) => [a.where, a.what]), [
    ["笔记本 B", "连不上这台电脑"],
    ["台式机 C", "电脑在线，但它的看板服务没有应答"],
    ["台式机 D", "电脑在线，但它的看板服务没有应答"],
    ["台式机 E", "同步失败"],
  ], "同一次故障的本机同步重试不再单独提示");
  assert.match(s.alerts[1].next, /node cli\/status\.mjs/);
  assert.deepEqual(M.homeStatus({ nodes: [local], fleetError: "x", healthError: "y" }).alerts.map((a) => a.what), ["多机视图和运行检查暂时读不到"]);
});

test("页面经匿名健康探测确认故障，成功读取和实时重连都可恢复", () => {
  assert.ok(src.includes('await window.fetch("/health", { cache: "no-store", credentials: "omit" })'));
  const r = src.slice(src.indexOf("async function refresh(){"), src.indexOf("function live(on, txt, title){"));
  assert.ok(r.includes("const p = await probeBoard();") && r.includes("if (restartPending) return;") && r.includes("boardDown = null;"));
  assert.ok(r.includes("if (wasDown) loadHomeExtras(true);"), "恢复后重新读取设备与运行检查，不展示断开前旧值");
  assert.ok(r.includes("if (lastGoodRead > started) return;") && r.includes('if (liveOpen) live(true, "实时");'), "过时的失败不能覆盖新成功");
  const sse = src.slice(src.indexOf('const es = window.boardSession.events("/api/events");'), src.indexOf("// ⭐ Event kinds are NOT enumerated here."));
  assert.ok(sse.includes("if (boardDown) refresh();") && sse.includes("if (!restartPending) refresh();"));
  assert.ok(src.includes('document.getElementById("home-view").classList.toggle("stale", !!boardDown);'));
  assert.ok(src.includes("navigator.clipboard.writeText(a.copy)"));
});

test("首页卡只露标题、所属电脑、状态和下一步；长串编号只在侧栏折叠的「技术信息」里", () => {
  const lists = M.homeLists({ localName: NODE_B, tasks: [
    card(1, { task_uid: NODE_B, run_id: NODE_B, status: "in_progress", last_runtime: "codex", hb: "fresh" }),
    card(2, { task_uid: NODE_B, waiting_for: "review" }), card(3, { task_uid: NODE_B, status: "done", resolved_by: "auto" }) ],
    remote: [{ read_only: true, task_uid: NODE_B + ":9", owner_name: NODE_B, subject: "远端卡", status: "waiting", waiting_for: "decision", updated_at: at(2) }] });
  const shown = [...lists.mine, ...lists.running, ...lists.history].map((r) => [r.title, r.computer, r.state, r.next]);
  assert.equal(shown.length, 4);
  assert.equal(UUID.test(JSON.stringify(shown)), false, "卡面四样里没有长串编号");
  const face = src.slice(src.indexOf("function homeCard(item, lane){"), src.indexOf("/** Rebuild one list only when what it shows changed"));
  assert.ok(face.length > 0);
  for (const field of ["item.title", "item.computer", "item.state", "item.next"]) assert.ok(face.includes(field), "卡面写 " + field);
  for (const hidden of ["uid", "localId", "item.key", "run_id"]) assert.ok(!face.includes(hidden), "卡面不读 " + hidden);
  const side = src.slice(src.indexOf("function renderSide(){"), src.indexOf("function sideFromHash(){"));
  assert.ok(side.includes("out.push(sideTech(t));") && !side.includes("UID"), "侧栏正文只留短卡号");
  const tech = src.slice(src.indexOf("function sideTech(t){"), src.indexOf("/** 「协议记录」:默认折叠"));
  assert.ok(tech.includes('homeEl("details"') && tech.includes('homeEl("summary", "技术信息")') && tech.includes('["任务 UID", t.task_uid]'),
    "任务 UID、运行号在默认折叠的「技术信息」里");
});

test("手动建卡：原表单、编号和处理器都在，入口是输入框操作行里的次要按钮", () => {
  const cut = (open, close) => { const i = src.indexOf(open), j = src.indexOf(close, i); assert.ok(i > 0 && j > i, open); return src.slice(i, j); };
  const acts = cut('<div class="chat-acts">', "</div>");
  assert.match(acts, /<button type="button" id="home-new-open">.*手动建卡<\/button>/, "入口在输入框的操作行里，不是主按钮");
  assert.equal(src.split('id="home-new-open"').length - 1, 1, "入口只有一个");
  assert.ok(acts.indexOf('id="home-new-open"') < acts.indexOf('id="chat-send" class="pri"'), "发送是这一行唯一的主按钮");
  const form = cut('<form id="home-new-form" class="form-panel" hidden', "</form>");
  for (const id of ["home-new-title", "home-new-desc", "home-new-line", "home-new-execution", "home-new-profile", "home-new-model", "home-new-preview", "home-new-err", "home-new-cancel", "home-new-x"])
    assert.ok(form.includes(`id="${id}"`), "表单里还有 " + id);
  assert.match(form, /<button type="submit" class="pri">.*创建任务<\/button>/);
  const show = cut("function newShow(on){", "function newSave(){");
  assert.ok(show.includes('getElementById("home-new-form").hidden = !on') && show.includes('getElementById("home-new-open").hidden = on'), "按下入口展开表单并收起入口");
  for (const wired of ['document.getElementById("home-new-open").addEventListener("click", () => newShow(true));',
    'document.getElementById("home-new-cancel").addEventListener("click", newClear);', 'document.getElementById("home-new-x").addEventListener("click", newClear);',
    'document.getElementById("home-new-form").addEventListener("input", newSave);'])
    assert.ok(src.includes(wired), wired);
  const submit = cut('getElementById("home-new-form").addEventListener("submit"', "finally { btn.disabled = false; }");
  assert.ok(submit.includes("newTaskBody(") && submit.includes('await post("/api/tasks", r.body)') && submit.includes("openSide({ id: j.task.id"), "提交照旧直接建卡并打开任务侧栏");
  assert.deepEqual(M.newTaskBody({ title: " 手动建的卡 ", line: "engine" }, { lines: ["engine", "review"], reviewLines: ["review"] }),
    { body: { subject: "手动建的卡", description: "", line: "engine" } });
});

test("对话与计划卡：夹具进去，勾选、合计、已建卡三态、要提交的改动和输入框上方那一行都由纯函数算出", async () => {
  const c0 = src.indexOf("// ── chat-model(pure;tests/hometest.mjs)──"), c1 = src.indexOf("// ── /chat-model ──");
  assert.ok(c0 > 0 && c1 > c0, "chat-model block not found in core/panel.html");
  const C = new Function(src.slice(src.indexOf("\n", c0) + 1, c1) + ";return {planView,planEdit,planPutBody,chatTimeline,chatStateLine,chatCanSend,chatListLine,chatListNeed,chatWaited};")();
  const task = (n, extra) => ({ n, subject: "第 " + n + " 步", summary: "摘要 " + n, description: "", acceptance: "", line: "engine", after: [],
    needs_confirm: false, needs_bash: false, enabled: true, edited: [], ...extra });
  const plan = { rev: 2, author: "coordinator", base_rev: 1, created_at: at(3), goal: { subject: "<b>目标</b>", description: "说明" }, applied: null,
    tasks: [task(1), task(2, { after: [1], line: "design", needs_confirm: true }), task(3, { after: [1, 2], line: "ghost", enabled: false, edited: ["enabled"] })] };
  const opts = { lines: ["engine", "design"], lineName: (l) => ({ engine: "引擎", design: "设计" })[l] || l };

  // 勾选态:显示已存版本的勾选、执行线、依赖和确认;不在可用范围的线标出来
  const open = C.planView(plan, opts);
  assert.deepEqual([open.state, open.editable, open.canApply, open.dirty], ["open", true, true, 0]);
  assert.deepEqual(open.tasks.map((t) => [t.n, t.enabled, t.lineName, t.lineKnown, t.after, t.needsConfirm]),
    [[1, true, "引擎", true, [], false], [2, true, "设计", true, [1], true], [3, false, "ghost", false, [1, 2], false]]);
  assert.equal(open.total, "将建 1 张目标卡、2 张子任务卡，其中 1 张要你确认后放行；1 项不建");
  assert.equal(open.goal.subject, "<b>目标</b>", "协调线写的字原样带出，页面按纯文本放");

  // 本地改动:逐行标出,合计跟着变;发消息或建卡前要 PUT 的只有改了的字段
  const draft = C.planEdit(plan, C.planEdit(plan, null, 1, { enabled: false }), 2, { line: null });
  const edited = C.planView(plan, { ...opts, draft });
  assert.deepEqual(edited.tasks.map((t) => [t.enabled, t.line, t.changed, t.afterOff]),
    [[false, "engine", ["enabled"], []], [true, null, ["line"], [1]], [false, "ghost", [], []]]);
  assert.deepEqual([edited.dirty, edited.tasks[1].lineName, edited.total], [2, "不指定线", "将建 1 张目标卡、1 张子任务卡，其中 1 张要你确认后放行；2 项不建"]);
  assert.deepEqual(C.planPutBody(plan, draft), { expected_rev: 2, tasks: [{ n: 1, enabled: false }, { n: 2, line: null }] });
  assert.equal(C.planPutBody(plan, null), null, "没有改动就不发 PUT（服务端对无变化的 PUT 也会出新版本）");
  const none = C.planView(plan, { ...opts, draft: C.planEdit(plan, draft, 2, { enabled: false }) });
  assert.deepEqual([none.canApply, none.total], [false, "至少勾选 1 项才能建卡"]);
  assert.equal(C.planEdit(plan, C.planEdit(plan, null, 1, { enabled: false }), 1, { enabled: true }), null, "改回原值 = 没有改动");
  const stale = { rev: 1, tasks: { 1: { enabled: false } } };
  assert.deepEqual([C.planPutBody(plan, stale), C.planView(plan, { ...opts, draft: stale }).dirty], [null, 0], "别的版本上的改动不显示也不提交");

  // 已建卡态:只读,给出目标卡号和子任务卡号;本地改动不再叠上去。要你确认的卡建好后不放行:
  // 看板的卡还没读到时按计划里标的张数写,读到了按还没放行的卡号写,都放行了就不再提。
  const built = { ...plan, applied: { at: at(4), by: "panel", goal_id: 12, task_ids: [13, 14] } };
  const applied = C.planView(built, { ...opts, draft });
  assert.deepEqual([applied.state, applied.editable, applied.canApply, applied.dirty, applied.total, applied.applied],
    ["applied", false, false, 0, "已建 1 张目标卡、2 张子任务卡，其中 1 张要你确认后放行", { goalId: 12, taskIds: [13, 14], pending: [] }]);
  const waiting = C.planView(built, { ...opts, pending: [14] }), released = C.planView(built, { ...opts, pending: [] });
  assert.deepEqual([waiting.total, waiting.applied.pending], ["已建 1 张目标卡、2 张子任务卡，其中 1 张要你确认后放行", [14]]);
  assert.equal(released.total, "已建 1 张目标卡、2 张子任务卡");
  // 旧版本、这个对话已按别的版本建过卡:都不能改也不能建
  const old = C.planView(plan, { ...opts, latest: false, draft }), locked = C.planView(plan, { ...opts, appliedRev: 1 });
  assert.deepEqual([old.state, old.editable, old.canApply, old.dirty], ["old", false, false, 0]);
  assert.deepEqual([locked.state, locked.canApply, locked.total], ["locked", false, "这个对话已按第 1 版建过卡"]);

  // 消息流:带 plan_rev 的消息后面跟那一版;人改出的版本没有消息,按时间插入;只有最新一版可以操作
  const messages = [{ id: 1, role: "user", text: "做", created_at: at(1) }, { id: 2, role: "coordinator", text: "好", created_at: at(2), plan_rev: 1 },
    { id: 3, role: "user", text: "再改", created_at: at(5) }];
  const plans = [{ ...plan, rev: 1, created_at: at(2) }, { ...plan, rev: 2, author: "human", created_at: at(4) }];
  assert.deepEqual(C.chatTimeline(messages, plans).map((x) => x.kind === "plan" ? "计划" + x.plan.rev + (x.latest ? "*" : "") : "消息" + x.message.id),
    ["消息1", "消息2", "计划1", "计划2*", "消息3"]);
  // 重试带 retry_of、服务端不追加消息:消息流不再合并紧挨着的同一句,存了几条就显示几条;回复中带出这一轮开始的时刻,已等待的时长按秒、分写
  const retried = [...messages, { id: 4, role: "user", text: " 再改 ", created_at: at(6) }, { id: 5, role: "coordinator", text: "改好了", created_at: at(7) },
    { id: 6, role: "user", text: "再改", created_at: at(8) }];
  assert.deepEqual(C.chatTimeline(retried, []).map((x) => x.message.id), [1, 2, 3, 4, 5, 6], "紧挨着的同一句也各自显示");
  assert.deepEqual([C.chatStateLine({ conversation: { status: "running" }, since: at(6) }).since, C.chatWaited(45000), C.chatWaited(185000), C.chatWaited(120000), C.chatWaited(NaN)],
    [at(6), "已等待 45 秒", "已等待 3 分 5 秒", "已等待 2 分", ""]);

  // 输入框上方那一行:协调线不可用的原因照服务端给的写;失败的一轮只有对话上的 error;一条消息最多 4000 字
  // reason 用服务端真会给的一条(core/config-setup.mjs 的 resolveClaudeCli:找不到 Claude CLI)。GET /api/coordinator 只在
  // 找不到 CLI 或当前版本没确认时给 available:false;登录失效不在这里,表现为那一轮 failed + error。句末的句号不叠。
  const NO_CLI = "找不到 Claude CLI。先安装 Claude Code;装好仍找不到时,把 WORKER_CLAUDE_CLI 设成 claude 可执行文件的完整路径后重启看板";
  const ok = { available: true }, down = { available: false, reason: NO_CLI };
  for (const reason of [NO_CLI, NO_CLI + "。"])
    assert.equal(C.chatStateLine({ coordinator: { ...down, reason } }).text, "协调线现在不可用：" + NO_CLI + "。可以先用「手动建卡」。");
  assert.deepEqual([C.chatCanSend({ coordinator: down, text: "做" }), C.chatCanSend({ coordinator: ok, text: "做" }), C.chatCanSend({ coordinator: ok, text: "  " })], [false, true, false]);
  const failed = C.chatStateLine({ coordinator: ok, conversation: { status: "failed", error: "协调线超时" } });
  assert.deepEqual([failed.text, failed.act], ["上一轮没有完成：协调线超时", "retry"]);
  assert.deepEqual([C.chatStateLine({ coordinator: ok, conversation: { status: "running" } }).act, C.chatCanSend({ coordinator: ok, conversation: { status: "running" }, text: "做" })], ["stop", false]);
  const long = "字".repeat(4001);
  assert.deepEqual([C.chatCanSend({ coordinator: ok, text: "字".repeat(4000) }), C.chatCanSend({ coordinator: ok, text: long })], [true, false]);
  assert.equal(C.chatStateLine({ coordinator: ok, text: long }).text, "这条消息 4001 字，一条最多 4000 字。删短或分几条发。");
  assert.equal(C.chatStateLine({ coordinator: ok, conversation: { status: "idle" }, text: "做" }), null);

  // 对话列表:四种状态里只有「计划第 N 版 · 待建卡」标成轮到你;正在回复、上一轮失败时即使有计划也不标
  const rows = [{ status: "running", plan_rev: 1, plan_applied: false }, { status: "failed", plan_rev: 1, plan_applied: false },
    { status: "idle", plan_rev: 2, plan_applied: false }, { status: "idle", plan_rev: 2, plan_applied: true }];
  assert.deepEqual(rows.map((c) => [C.chatListLine(c), C.chatListNeed(c)]),
    [["协调线正在回复", false], ["上一轮没有完成", false], ["计划第 2 版 · 待建卡", true], ["已建卡", false]]);
  assert.deepEqual([C.chatListNeed(null), C.chatListNeed({ status: "idle", plan_rev: null, plan_applied: false })], [false, false], "还没有计划的对话不标");
  assert.ok(src.includes('if (chatListNeed(c)) b.dataset.need = "";') && src.includes(".cl-item[data-need] .cl-s{color:var(--accent)}"));

  // 页面只用 textContent 放协调线的字:消息与计划卡这一段不拼 HTML
  const dom = src.slice(src.indexOf("function chatMessage(m){"), src.indexOf("function chatSync(){"));
  assert.ok(dom.length > 0 && !dom.includes("innerHTML") && !dom.includes("insertAdjacentHTML"), "消息与计划卡不拼 HTML");
  assert.ok(dom.includes('homeEl("p", String(m.text), "msg-text")') && dom.includes('homeEl("h3", v.goal.subject)') && dom.includes('homeEl("b", t.n + ". " + t.subject)'));
  // 建卡只走 apply;本地改动先 PUT 成新版本
  const apply = src.slice(src.indexOf("async function chatPlanApply(){"), src.indexOf("function chatBadge("));
  assert.ok(apply.indexOf("await chatPlanFlush()") > 0 && apply.indexOf("await chatPlanFlush()") < apply.indexOf('"/apply"'), "建卡前先把本地改动存成新版本");
  assert.ok(src.includes("async function chatBeforeSend(){ await chatPlanFlush(); }"), "发消息前也先存");
  // 对话列表:当前对话下面「改名」「归档」走 PATCH;已归档的另读一份,收在「已归档」折叠里;触摸屏上 Enter 不发
  const acts = src.slice(src.indexOf("function chatItemActs(c, archived){"), src.indexOf("/** 图标节点"));
  assert.ok(acts.includes('chatApi("PATCH", "/api/conversations/" + encodeURIComponent(id), { title })') && acts.includes('{ archived })') &&
    acts.includes('archived ? "取消归档" : "归档"') && !acts.includes("innerHTML"));
  assert.ok(src.includes('chatApi("GET", "/api/conversations?archived=1")') && src.includes('fold.append(homeEl("summary", "已归档 " + chatArchRows.length), ...list);'));
  assert.ok(src.includes("e.keyCode === 229 || CHAT_TOUCH.matches) return;") && src.includes('chatInput.enterKeyHint = touch ? "enter" : "send";'));

  // 实时事件(真实处理段切出来跑):对话有变只重读对话;版本确认了(code.accepted)对话区也立即重读——
  // 协调线能不能用跟着版本确认变,不等 5 秒的读取间隔;其余事件照旧只刷新看板。
  const h0 = src.indexOf('es.addEventListener("change", (e) => {'), h1 = src.indexOf("\n});", h0);
  assert.ok(h0 > 0 && h1 > h0, "实时事件的处理段没找到");
  const heard = (type) => {
    const did = [];
    new Function("es", "chatChanged", "refresh", "noteRestart", src.slice(h0, h1 + 4))(
      { addEventListener: (_, handle) => handle({ data: JSON.stringify({ type }) }) }, () => did.push("对话"), () => did.push("看板"), () => did.push("重启"));
    return did;
  };
  assert.deepEqual([heard("conversation.changed"), heard("code.accepted"), heard("task.created"), heard("board.restarting")],
    [["对话"], ["对话", "看板"], ["看板"], ["重启"]]);

  // 发送被拒(真实的 chatSend 切出来跑,接口换成替身):409 COORDINATOR_UNAVAILABLE 不写「没有发出去 · 重试」
  // (这时重试也发不出去),输入框上方照服务端给的原因写「协调线现在不可用」,字留在输入框里;别的拒绝照旧。
  const s0 = src.indexOf("async function chatSend(text, retryOf = null){"), s1 = src.indexOf("/** 发消息前要先做完的事", s0);
  assert.ok(s0 > 0 && s1 > s0, "chatSend 没找到");
  const sendRefused = async (error) => {
    const input = { value: "把导出做成可配置的" };
    const run = new Function("chatInput", "chatCanSend", "chatApi", "chatErrorText", `
      let chatCoord = { available: true }, chatData = null, chatSending = false, chatFail = null, chatNote = null, chatStick = true, chatId = null;
      const renderChat = () => {}, chatLoad = async () => {}, chatGrow = () => {}, chatDraftSave = () => {}, chatStore = () => ({}), chatSave = () => {},
        chatBeforeSend = async () => {}, chatPath = () => "";
      ${src.slice(s0, s1)}
      return chatSend().then(() => ({ coordinator: chatCoord, fail: chatFail?.why || null }));`);
    const after = await run(input, C.chatCanSend, async () => { throw error; }, (e) => "看板的原话：" + e.message);
    return [C.chatStateLine({ ...after, text: input.value }), input.value];
  };
  const [refused, stillTyped] = await sendRefused(Object.assign(Error("这个版本还没确认过。确认当前版本后协调线才能用"), { status: 409, code: "COORDINATOR_UNAVAILABLE" }));
  assert.deepEqual([refused.text, refused.act, stillTyped],
    ["协调线现在不可用：这个版本还没确认过。确认当前版本后协调线才能用。可以先用「手动建卡」。", null, "把导出做成可配置的"]);
  const [running] = await sendRefused(Object.assign(Error("协调线还在回复上一条消息"), { status: 409, code: "TURN_RUNNING" }));
  assert.deepEqual([running.text, running.act], ["没有发出去：看板的原话：协调线还在回复上一条消息", "resend"]);
});

test("对话「重试」带 retry_of 重跑上一条你的消息、不重发正文;409 RETRY_NOT_APPLICABLE 退回普通发送并写一行原因", async () => {
  const c0 = src.indexOf("// ── chat-model(pure;tests/hometest.mjs)──"), c1 = src.indexOf("// ── /chat-model ──");
  const C = new Function(src.slice(src.indexOf("\n", c0) + 1, c1) + ";return {chatStateLine,chatCanSend};")();
  // 真实的 chatSend 与 chatRetryTurn 切出来跑,接口换成替身
  const s0 = src.indexOf("async function chatSend(text, retryOf = null){"), s1 = src.indexOf("/** 发消息前要先做完的事", s0);
  const r0 = src.indexOf("/** 「重试」失败的一轮"), r1 = src.indexOf("/** 当前对话在列表里的两个动作", r0);
  assert.ok(s0 > 0 && s1 > s0 && r0 > 0 && r1 > r0, "chatSend / chatRetryTurn 没找到");
  const messages = [{ id: 7, role: "user", text: "做导出" }, { id: 8, role: "coordinator", text: "好" }, { id: 9, role: "user", text: "再改成可配置" }];
  const retry = async (answer) => {
    const calls = [], input = { value: "正在写的下一句" };
    const run = new Function("chatInput", "chatCanSend", "chatApi", "chatErrorText", "chatData", `
      let chatCoord = { available: true }, chatSending = false, chatFail = null, chatNote = null, chatStick = true, chatId = 3;
      const renderChat = () => {}, chatLoad = async () => {}, chatGrow = () => {}, chatDraftSave = () => {}, chatStore = () => ({}), chatSave = () => {},
        chatBeforeSend = async () => {}, chatPath = (rest = "") => "/api/conversations/3" + rest;
      ${src.slice(s0, s1)}
      ${src.slice(r0, r1)}
      return chatRetryTurn().then(() => ({ fail: chatFail, note: chatNote }));`);
    const after = await run(input, C.chatCanSend, async (method, path, body) => { calls.push([method, path, body]); return answer(body); }, (e) => e.message,
      { conversation: { status: "failed", error: "协调线超时" }, messages });
    return { calls, ...after, typed: input.value };
  };
  // 接受:只发一次 retry_of(上一条你的消息的 id),不带正文;输入框里正在写的字不动
  const ok = await retry(() => ({ turn: { id: 9, status: "running" } }));
  assert.deepEqual(ok.calls, [["POST", "/api/conversations/3/messages", { retry_of: 9 }]]);
  assert.deepEqual([ok.fail, ok.note, ok.typed], [null, null, "正在写的下一句"]);
  // 409 RETRY_NOT_APPLICABLE:退回普通发送(原文作为一条新消息),状态行下写一行原因
  const refused = await retry((body) => {
    if (body.retry_of) throw Object.assign(Error("这条消息不能重试:它已经得到协调线的回复"), { status: 409, code: "RETRY_NOT_APPLICABLE" });
    return { turn: { id: 10, status: "running" } };
  });
  assert.deepEqual(refused.calls.map((c) => c[2]), [{ retry_of: 9 }, { message: "再改成可配置" }]);
  assert.equal(refused.note, "没能按原条重试（这条消息不能重试:它已经得到协调线的回复），已把这句作为新消息发出。");
  const shown = C.chatStateLine({ coordinator: { available: true }, conversation: { status: "running" }, note: refused.note });
  assert.deepEqual([shown.text, shown.act, shown.note], ["协调线正在回复", "stop", refused.note]);
  assert.equal(C.chatStateLine({ coordinator: { available: true }, conversation: { status: "idle" }, note: refused.note }).text, refused.note, "没有别的状态时单独一行");
  // 别的拒绝不退回普通发送:写「没有发出去」,再按「重试」仍带 retry_of
  const busy = await retry(() => { throw Object.assign(Error("协调线还在回复上一条消息"), { status: 409, code: "TURN_RUNNING" }); });
  assert.deepEqual([busy.calls.length, busy.fail.why, busy.fail.retryOf, busy.note], [1, "协调线还在回复上一条消息", 9, null]);
  assert.ok(src.includes("chatSend(chatFail?.text, chatFail?.retryOf ?? null)"), "「没有发出去」的重试沿用原来那次的 retry_of");
});

test("Zcode 线以 /api/zcode/status 的 line 为准,没有 line 时才按卡与线名 zcode 判断", () => {
  const z0 = src.indexOf("function zcodeLines(){"), z1 = src.indexOf("function renderZcode(){", z0);
  assert.ok(z0 > 0 && z1 > z0, "zcodeLines 没找到");
  const lines = (status, tasks, LINES = ["zcode", "engine", "glm"]) =>
    [...new Function("tasks", "zcodeStatusSlot", "LINES", src.slice(z0, z1) + "\nreturn zcodeLines();")(tasks, { value: status }, LINES)];
  const zcard = { line: "glm", zcode: { request_state: "dispatched" } };
  assert.deepEqual(lines({ configured: true, line: "engine", loop: {} }, [zcard]), ["engine"], "服务端给了 line 就只认它,不再看卡");
  assert.deepEqual(lines({ configured: true, line: null, loop: {} }, [zcard]), ["glm"], "line 为 null:退回按卡判断");
  assert.deepEqual(lines({ configured: true, loop: {} }, []), ["zcode"], "旧服务端没有 line、也没有卡:已配置就认线名 zcode");
  assert.deepEqual(lines({ configured: false, line: null, loop: {} }, []), [], "没配置、没有卡:没有 Zcode 线");
});

// ── 跨机事项按任务归拢:fleetLinks / fleetStep ──
// 记录形状同 core/fleet-actions.mjs 的 catalog()(tests/fleetactionstest.mjs 走的那份):委派带 source_task_uid、
// 绑定带 task_uid 与 relation_id、交付只带编号、文件与结案在 delivery / delivery.closure 里。
const NODE_A = "11111111-1111-4111-8111-111111111111", PCS = { [NODE_A]: "台式机 A", [NODE_B]: "笔记本 B" };
const sent = (state, extra) => ({ project_id: "demo", direction: "outgoing", delegation_id: "d1", state, identity_current: true, source_node_id: NODE_A,
  target_node_id: NODE_B, source_task_uid: "u1", target_task_uid: null, version: null, subject: "跑压测", description: "说明", acceptance: "验收", ...extra });
const bound = (extra) => ({ relation_id: "r1", delegation_id: "d1", side: "source", state: "confirmed", task_uid: "u1", identity_current: 1, project_id: "demo",
  task_version: 5, task_status: "waiting", released: true, subject: "跑压测", execution_authorized: false, binding_authorized: true, source_approved: true,
  source_node_id: NODE_A, target_node_id: NODE_B, cancellation_state: null, ...extra });
const back = (extra) => ({ result_id: "x1", relation_id: "r1", sequence: 1, side: "source", identity_current: 1, state: "received", project_id: "demo",
  source_task_version: 7, review_state: "pending_evidence", ...extra });
const delivery = (extra, closure) => ({ enabled: true, receivers: [], profiles: [], targets: [], artifacts: [], verifications: [],
  closure: closure ? { enabled: true, policies: [], integrations: [], completions: [], ...closure } : { enabled: false }, ...extra });
const fleet = (actions, uid = "u1", names = PCS) => M.fleetStep(M.fleetLinks({ enabled: true, ...actions }, uid), names);

test("等对端的五种状态：写明等哪台电脑的什么，进「正在执行」，下一步「无需操作」", () => {
  const done = { command: "register_completion", state: "acknowledged", result: { completion_id: "c1" } };
  const waits = [
    ["等待「笔记本 B」接收任务", { outgoing: [sent("pending")] }, ["poll_delegation", "resend_delegation"]],
    ["等待「笔记本 B」接收任务", { outgoing: [sent("received")] }, ["poll_delegation", "resend_delegation"]],
    ["等待「笔记本 B」确认绑定", { outgoing: [sent("accepted_unconfirmed")], bindings: [bound({ state: "prepared" })] }, ["poll_binding", "send_binding_proposal"]],
    ["等待「笔记本 B」回传交付", { bindings: [bound()] }, ["send_source_ready"]],
    ["等待「笔记本 B」停止回执", { bindings: [bound({ cancellation_state: "requested" })] }, ["poll_cancellation", "resend_cancellation"]],
    ["等待「笔记本 B」结案回执", { bindings: [bound()], results: [back({ state: "accepted" })], actions: [done],
      delivery: delivery({}, { completions: [{ completion_id: "c1", result_id: "x1", phase: "ready", side: "source", project_id: "demo", note: "通过" }] }) }, ["poll_completion"]],
  ];
  for (const [state, actions, more] of waits) {
    const s = fleet(actions);
    assert.deepEqual([s.lane, s.state, s.next, s.primary], ["running", state, "无需操作", null]);
    assert.deepEqual(s.more.map((a) => a.command), more, state + " 的查询与重发");
    assert.equal(s.hold, true, "协议还持有这张卡");
  }
  assert.deepEqual(fleet({ outgoing: [sent("pending")] }).more.map((a) => a.label), ["查询对端回执", "重发"]);
  assert.equal(fleet({ outgoing: [sent("pending")] }, "u1", {}).state, "等待「另一台电脑」接收任务", "电脑名读不到不露编号");
  assert.equal(UUID.test(JSON.stringify(waits.map(([, a]) => { const s = fleet(a); return [s.state, s.next, s.more.map((x) => [x.label, x.review])]; }))), false, "状态和核对正文里没有长串编号");
  assert.equal(fleet({ outgoing: [sent("mystery")] }).state, "待核实", "词表外的状态");
  // 与这张卡无关的记录不带出来;没有委派记录的卡流程不说话。
  assert.equal(M.fleetLinks({ enabled: true, outgoing: [sent("pending")] }, "u9").any, false);
  assert.equal(fleet({ outgoing: [sent("pending")] }, "u9").lane, null);
  assert.equal(M.fleetLinks({ enabled: false, outgoing: [sent("pending")] }, "u1").any, false);
});

test("轮到本机：primary 是唯一下一步，命令和版本号取自对应记录；重新登记前的旧记录不给 primary", () => {
  const cmd = (s) => s.primary && [s.primary.command, s.primary.args];
  // 来源卡
  assert.deepEqual(cmd(fleet({ outgoing: [sent("accepted_unconfirmed", { binding_draft: { ready: true, review_digest: "g", target_node_id: NODE_B, target_task_uid: "t9", source_topology_revision: 1, target_topology_revision: 2 } })] })),
    ["propose_binding", { delegation_id: "d1", review_digest: "g" }]);
  assert.deepEqual(cmd(fleet({ bindings: [bound({ state: "prepared", source_approved: false })] })), ["approve_binding", { id: "r1" }]);
  // 按钮写动作,核对正文写按下去会发生什么;协议规则本身不进正文。
  const resume = fleet({ bindings: [bound({ state: "prepared", source_approved: false })] });
  assert.deepEqual([resume.state, resume.next, resume.primary.label], ["绑定待本机确认", "确认绑定", "确认绑定"]);
  assert.equal(resume.primary.review.split("\n").pop(), "重新提交本机对这次绑定的确认；对方电脑仍须独立确认。");
  assert.deepEqual(resume.others.map((a) => [a.label, a.command, a.review.split("\n").pop()]), [["撤回未确认绑定", "cancel_binding", "撤回这次绑定申请，对方电脑不再需要确认。"]]);
  const pending = fleet({ bindings: [bound({ side: "target", source_node_id: NODE_B, target_node_id: NODE_A, state: "prepared" })] });
  assert.deepEqual(pending.others.map((a) => [a.label, a.command]), [["重新提交本机确认", "approve_binding"], ["撤回未确认绑定", "cancel_binding"]]);
  assert.ok(![resume.primary, ...resume.others, ...pending.others].some((a) => /恢复|未知结果/.test(a.label + a.review)), "不写「恢复」「未知结果」这类协议内的说法");
  const grant = fleet({ bindings: [bound()], results: [back()], delivery: delivery({ receivers: [{ project_id: "demo", mapping_id: "m1", repo_id: "repo", base_commit: "abc" }] }) });
  assert.deepEqual([grant.lane, grant.state, grant.primary.label, cmd(grant)], ["mine", "交付已回传", "授权接收文件 · repo", ["register_artifact_target", { result_id: "x1", mapping_id: "m1" }]]);
  const reject = grant.more.find((a) => a.command === "reject_result");
  assert.deepEqual([reject.label, reject.args, reject.note, reject.required], ["要求返工", { result_id: "x1", expected_version: 7 }, true, true], "返工的版本取交付记录的 source_task_version，处理说明必填");
  assert.equal(grant.delivery, "文件未收到 · 检查未开始");
  const artifact = { transfer_id: "tr1", result_id: "x1", state: "received", side: "source", bytes: 10, project_id: "demo", repo_id: "repo", base_commit: "abc", mapping_id: "m1" };
  const verify = fleet({ bindings: [bound()], results: [back()], delivery: delivery({ artifacts: [artifact] }) });
  assert.deepEqual([cmd(verify), verify.delivery], [["verify_artifact", { id: "tr1" }], "文件已收齐 · 检查未开始"]);
  const merged = { integration_id: "i1", result_id: "x1", verification_id: "v1", phase: "settled", project_id: "demo", ref: "refs/heads/main", context_current: true, source_task_version: 8, fixture_runs: 0 };
  const accept = fleet({ bindings: [bound()], results: [back()], delivery: delivery({ artifacts: [{ ...artifact, state: "accepted" }] }, { integrations: [merged] }) });
  assert.deepEqual([cmd(accept), accept.primary.label, accept.primary.required], [["prepare_completion", { integration_id: "i1", expected_version: 8, allow_fixture: false }], "确认候选验收", true],
    "验收的版本取合并记录的 source_task_version");
  assert.deepEqual(accept.others.map((a) => a.command), ["request_cancellation", "check_integration"], "其余步骤进 others");
  // 执行卡
  const proposal = { relation_id: "r2", descriptor_digest: "dd", state: "pending", identity_current: true, project_id: "demo", task_version: 9, subject: "绑定", description: "说明", acceptance: "验收",
    relation: { source_node_id: NODE_B, source_task_uid: "s1", target_task_uid: "u1", source_topology_revision: 1, target_topology_revision: 2 } };
  const confirm = fleet({ proposals: [proposal] });
  assert.deepEqual([confirm.lane, confirm.state, confirm.primary.label, cmd(confirm)], ["mine", "待确认绑定", "确认绑定", ["accept_binding_proposal", { relation_id: "r2", descriptor_digest: "dd", expected_version: 9 }]]);
  assert.deepEqual(confirm.more.map((a) => [a.label, a.command]), [["拒绝", "decline_binding_proposal"]]);
  const target = (extra) => bound({ side: "target", source_node_id: NODE_B, target_node_id: NODE_A, task_status: "not_started", released: false, ...extra });
  const held = fleet({ bindings: [target()] }), free = fleet({ bindings: [target({ execution_authorized: true })] });
  assert.deepEqual([held.lane, held.state, held.primary.command, held.primary.disabled], ["running", "待放行 · 等待双方就绪", "release_delegation", true], "放行条件没满足时按钮禁用");
  assert.deepEqual([held.next, held.why, free.why], ["无需操作", "双方就绪、当前权限或本地结构尚未满足放行条件", undefined], "没满足的原因随状态走，写在「现在」那一行");
  assert.deepEqual([free.lane, cmd(free), free.primary.disabled, free.role], ["mine", ["release_delegation", { relation_id: "r1", expected_version: 5 }], false, "target"]);
  assert.deepEqual(cmd(fleet({ bindings: [target({ task_status: "waiting", released: true })] })), ["prepare_result", { relation_id: "r1", expected_version: 5 }]);
  // 首页点开、本机没有对应卡的一件事
  const inbox = M.fleetInbox("incoming", { project_id: "demo", delegation_id: "d7", state: "received", identity_current: true, source_node_id: NODE_B, version: 3, subject: "跑压测", description: "说明", acceptance: "验收" }, PCS);
  assert.deepEqual([inbox.state, inbox.primary.label, inbox.primary.args, inbox.secondary.label, inbox.secondary.args.decision],
    ["收到委派 · 来自「笔记本 B」", "接收任务", { delegation_id: "d7", expected_version: 3, decision: "accept" }, "拒绝", "reject"]);
  assert.ok(inbox.primary.review.includes("来源电脑：笔记本 B") && !UUID.test(inbox.primary.review), "核对正文写电脑名");
  assert.deepEqual(inbox.primary.tech, [["委派", "d7"], ["来源终端", NODE_B]], "编号在 tech 里");
  // 这台电脑重新登记前的旧记录:只读
  const old = fleet({ proposals: [{ ...proposal, identity_current: false }], bindings: [target({ execution_authorized: true, identity_current: 0 })] });
  assert.deepEqual([old.lane, old.primary, old.more, old.others, old.readonly], [null, null, [], [], true]);
  assert.equal(M.fleetInbox("proposal", { ...proposal, identity_current: false }, PCS).primary, null);
  // 状态写给人看的说法;「节点代次」只留在技术信息里。
  assert.deepEqual([old.state, old.next], ["这台电脑重新登记前的旧记录", "无需操作"]);
  assert.deepEqual([M.fleetInbox("proposal", { ...proposal, identity_current: false }, PCS).state, M.fleetInbox("proposal", { ...proposal, identity_current: false }, PCS).next],
    ["这台电脑重新登记前的旧记录", "无需操作"]);
  assert.ok(!src.includes("旧节点代次"), "面板正文里不出现「节点代次」");
  assert.deepEqual(M.homeNodeLabels([["a", "笔记本"], ["b", "笔记本"], ["c", NODE_B]]), { a: "笔记本", b: "笔记本 2", c: "另一台电脑" }, "下拉里只写电脑名，重名才加序号");
});

test("首页：发出委派的本机卡进「正在执行」并写电脑名；落在本机卡上的跨机事项不另出一条", () => {
  const tasks = [card(1, { status: "not_started", released: 1 }), card(2, { waiting_for: "review" })];
  const proposal = { relation_id: "r2", descriptor_digest: "dd", state: "pending", identity_current: true, project_id: "demo", task_version: 9, subject: "绑定",
    relation: { source_node_id: NODE_B, target_task_uid: "u2" } };
  const lists = M.homeLists({ tasks, localName: "台式机 A", nodeNames: PCS, actions: { enabled: true, outgoing: [sent("pending")], proposals: [proposal] } });
  assert.deepEqual(lists.running.map((r) => [r.localId, r.state, r.next]), [[1, "等待「笔记本 B」接收任务", "无需操作"]]);
  assert.deepEqual(lists.mine.map((r) => [r.localId, r.state, r.next, r.action]), [[2, "待确认绑定", "核对后确认", undefined]], "本机卡上写着同一件事，不再出一条跨机事项");
  assert.deepEqual(M.homeLists({ tasks, actions: { enabled: false, outgoing: [sent("pending")] } }).running, [], "没有跨机配置时照旧");
  assert.deepEqual([...M.fleetUids({ enabled: true, outgoing: [sent("pending")], proposals: [proposal], bindings: [bound({ task_uid: "u3" })] })].sort(), ["u1", "u2", "u3"]);
});

test("协议持有的待验收卡：homeStep 返回 hold，「通过」不是下一步", () => {
  const why = (code) => ({ code, message: code, next_action: "按对应协议完成结算或人工恢复" });
  for (const code of ["DELEGATION_FINISH_HELD", "TOPOLOGY_FINISH_HELD"]) {
    const s = M.homeStep(card(1, { waiting_for: "review", progress_blockers: [why(code)] }), { autoReview: true });
    assert.deepEqual([s.lane, s.state, s.next, s.hold], ["mine", "待你验收", "按对应协议完成结算或人工恢复", true]);
  }
  assert.equal(M.homeStep(card(1, { waiting_for: "review", progress_blockers: [why("CANCELLATION_HELD")] })).hold, undefined, "别的阻塞不算协议持有");
  assert.equal(M.homeStep(card(1, { waiting_for: "review" })).hold, undefined);
});

test("跨机结构钉：核对正文不拼编号，编号进技术信息；侧栏经 fleetApi.act 打开同一个核对弹窗", () => {
  const a = src.indexOf(" function openAction(label,projectId,command,args,review,{"), b = src.indexOf(' $("fleet-action-close")', a);
  assert.ok(a > 0 && b > a, "openAction not found");
  const open = src.slice(a, b);
  assert.ok(open.includes("if(tech?.length)actionBody.append(techIds(tech));"), "编号由 techIds 放进默认折叠的「技术信息」");
  assert.ok(!/task_uid|node_id|relation_id/.test(open), "核对正文不拼任务编号、终端编号、关系编号");
  assert.ok(open.includes('actionSubmit.textContent=sent?"重试同一请求":"确认提交"') && src.includes("arguments:{...draft.arguments,"), "确认提交与提交的参数不变");
  const view = src.slice(src.indexOf("// Global read view stays within the existing operator panel."));
  for (const old of ["来源终端：", "目标终端：", "来源任务：", "目标任务：", "对象：", "\n关系："])
    assert.ok(!view.includes(old + '"+'), "全局视图的核对正文不再拼「" + old + "」加编号");
  for (const id of ['["来源终端",r.source_node_id]', '["目标终端",r.target_node_id]', '["来源任务",d.source_task_uid]', '["本机任务",d.target_task_uid]', '["关系",r.relation_id]'])
    assert.ok(view.includes(id), "编号改由 tech 带出：" + id);
  assert.ok(!view.includes(".slice(0,8)") && view.includes("homeNodeLabels([...ownerNames])"), "电脑下拉不带终端编号前 8 位");
  assert.ok(src.includes("fleetApi={showTask,open:openFleet,act:openAction,evidence:taskEvidence,names:{history:historyStates,commands:commandNames,actions:actionStates}};"));
  assert.ok(src.includes('placeholder="标题或任务编号"'));
  // 刷新后保留:任务详情写进 #fleet-task=,关闭时清掉;处理说明按「命令 + 对象」存草稿,提交过的连编号一起存。
  assert.ok(src.includes('p.set("fleet-task",uid)') && src.includes("detailGeneration++;fleetHash(null);"));
  assert.ok(open.includes('const key=command+":"+JSON.stringify(args)') && open.includes("action_id:sent?saved.action_id:crypto.randomUUID()"));
  assert.ok(src.includes("saveActionDraft(draft.key,{action_id:draft.action_id,note:draft.input?draft.input.value:\"\",sent:true});"));
  // 全局视图里的本机任务直达侧栏;三段长文默认折叠。
  const next = src.slice(src.indexOf(" function nextStep(t,card,body){"), src.indexOf(" function openFleet(){"));
  assert.ok(next.includes("detail.close();dialog.close();openSide({id:card.id,uid:null,item:null});") && !next.includes("locateOnBoard"));
  assert.ok(src.includes("if(t.local_id!==null&&byId.has(t.local_id)){dialog.close();openSide({id:t.local_id,uid:null,item:null});}else showTask(t.task_uid);"));
  assert.ok(src.includes('long.append(el("summary","给执行者看的详细说明"));') && src.includes('const locate=el("button","在「全部任务」中定位")'));
  // 首页跨机事项点开进侧栏,不再打开全局视图。
  const item = src.slice(src.indexOf("function openHomeItem(item){"), src.indexOf("function sideCard(){"));
  assert.ok(item.includes("openSide({ action: { kind: item.kind, id: item.id }") && !item.includes("fleetApi"));
});

test("执行者请求与逾期锁进「待我处理」，到设置页处理；任务类批准事项卡片已在列表里，不重复进", () => {
  const tasks = [card(2, { waiting_for: "decision" }), card(4, { waiting_for: "review" })];
  // 形状照 GET /api/approvals:任务类带 detail_ref.type = task;锁的标题是资源名;请求的摘要是执行者要做的事。
  const approvals = [
    { id: "decision:2:5", kind: "decision", title: "#2 卡 2", summary: "卡 2", detail_ref: { type: "task", id: 2 }, created_at: at(2) },
    { id: "delivery:4:3", kind: "delivery", title: "#4 卡 4", summary: "卡 4", detail_ref: { type: "task", id: 4 }, created_at: at(4) },
    { id: "release:9:1.a.0", kind: "release", title: "#9 卡 9", summary: "卡 9", detail_ref: { type: "task", id: 9 }, created_at: at(9) },
    { id: "version:bless:abc", kind: "version", title: "确认当前版本", summary: "确认版本 abc", detail_ref: { type: "setup" }, created_at: at(1) },
    { id: "lock:7:1790000000000", kind: "lock", title: "device:test-phone", summary: "device:test-phone 已逾期:甲 · 回归", detail_ref: { type: "lock", id: 7, resource: "device:test-phone" }, created_at: at(6) },
    { id: "request:3:1", kind: "request", title: "ext-a 请求批准", summary: "重启共享设备上的应用", risk: "high", detail_ref: { type: "request", id: 3 }, created_at: at(5) },
  ];
  const { mine } = M.homeLists({ tasks, localName: "台式机 A", approvals });
  assert.deepEqual(mine.map((r) => [r.localId ?? r.key, r.title, r.state, r.next]), [
    [2, "卡 2", "执行方在等你决定", "同意或否决"],
    ["approval:request:3:1", "重启共享设备上的应用", "执行者请求", "到设置页处理"],
    [4, "卡 4", "待你验收", "通过或打回"],
    ["approval:lock:7:1790000000000", "device:test-phone", "逾期锁", "到设置页处理"],
  ], "任务类三种和版本确认都不另出一条");
  assert.ok(mine.filter((r) => r.action === "approval").every((r) => r.computer === "台式机 A" && r.uid === null && r.localId === null));
  assert.deepEqual(M.homeLists({ tasks }).mine.map((r) => r.localId), [2, 4], "不传 approvals 时照旧");
  assert.deepEqual(M.homeLists({ tasks, approvals: null }).mine.map((r) => r.localId), [2, 4]);
  // 首页的两个状态词与设置页「待你批准」的种类词是同一对。
  const c0 = src.indexOf("// ── coord-copy(pure;tests/panelcopytest.mjs)──"), c1 = src.indexOf("// ── /coord-copy ──");
  const kinds = new Function("copyLabel", src.slice(src.indexOf("\n", c0) + 1, c1) + ";return COORD_COPY.apvKind;")(() => "");
  assert.deepEqual([kinds.request, kinds.lock], ["执行者请求", "逾期锁"]);
  // 点开:切到设置页并滚到「待你批准」;页签标题的待裁计数加上这两类。
  const open = src.slice(src.indexOf("function openHomeItem(item){"), src.indexOf("function sideCard(){"));
  assert.ok(open.includes('if (item.action === "approval") {') && open.includes('setView("settings");') && open.includes('document.getElementById("approvals")?.scrollIntoView({ block: "start" })'));
  assert.ok(src.includes('const asks = (approvalData?.approvals || []).filter((a) => a && (a.kind === "request" || a.kind === "lock")).length;'));
  assert.ok(src.includes('document.title = c.waiting > 0 || asks > 0 ? `(${(c.waiting || 0) + asks} 待裁)AI 协作看板` : "AI 协作看板";'));
  assert.ok(src.includes("approvals: approvalData?.approvals || [],"), "首页把批准事项交给 homeLists");
});

test("接入的 AI 卡住了：进「待我处理」，写名称与手上的卡号，点开到设置里那一行；已撤销、在做、空闲的不进", () => {
  // 形状照合同 A 的 GET /api/executors(state:working|idle|stalled|offline;revoked;holding:[{id,subject}])。
  const executors = [
    { id: "zcode-2", label: "Zcode 甲", state: "stalled", revoked: false, holding: [{ id: 12, subject: "改表" }, { id: 15, subject: "补测" }], last_seen_at: "2026-11-11T01:00:00Z" },
    { id: "claude", label: "", state: "stalled", revoked: false, holding: [] },
    { id: "codex", label: "Codex 乙", state: "stalled", revoked: true, holding: [{ id: 3 }] },
    { id: "w1", label: "在做的", state: "working", holding: [{ id: 4 }] }, { id: "w2", state: "idle" }, null,
  ];
  const mine = M.homeLists({ tasks: [], executors }).mine;
  assert.deepEqual(mine.map((r) => [r.action, r.id, r.title, r.state]),
    [["executor", "claude", "claude 卡住了", "卡住"], ["executor", "zcode-2", "Zcode 甲 卡住了 · 手上有 #12、#15", "卡住"]], "同档按等待先后:没有时刻的排前");
  assert.deepEqual(M.homeLists({ tasks: [], executors: null }).mine, [], "接口不在 = 不出这一类");
  const open = src.slice(src.indexOf("function openHomeItem(item){"), src.indexOf("\n}", src.indexOf("function openHomeItem(item){")));
  assert.ok(open.includes('if (item.action === "executor") { aiGo(item.id); return; }'));
  assert.ok(src.includes('executors: (typeof aiSlot === "object" && aiSlot?.value?.executors) || [],'), "首页把接入的 AI 交给 homeLists");
});

test("首页右栏 = 后台任务三组(等你处理 / 运行中 / 已完成),已完成默认折叠;强调色只给等你处理;停止先确认再发", () => {
  const aside = src.slice(src.indexOf('<aside class="home-work" id="home-work" aria-label="后台任务">'), src.indexOf("</aside>", src.indexOf('id="home-work"')));
  assert.ok(aside.length > 100, "右栏标成「后台任务」");
  const pos = ["data-lane=\"mine\"", "data-lane=\"running\"", "data-lane=\"done\""].map((k) => aside.indexOf(k));
  assert.ok(pos.every((p) => p > 0) && pos[0] < pos[1] && pos[1] < pos[2], "自上而下:等你处理、运行中、已完成");
  assert.ok(aside.includes(">等你处理 <span class=\"n\" id=\"home-mine-n\">") && aside.includes(">运行中 <span class=\"n\" id=\"home-running-n\">"));
  assert.ok(aside.includes('id="home-done-t" aria-expanded="false"') && aside.includes('<div class="home-list" id="home-done" hidden></div>'), "已完成默认折叠");
  // 新加的样式里不用强调色(强调色只给「等你处理」)
  const css = src.slice(src.indexOf("/* 后台任务(合同 F)"), src.indexOf("@media (prefers-reduced-motion: reduce){ .bg-fold"));
  assert.ok(css.length > 200 && !css.includes("--accent"), "后台任务样式不用 --accent");
  const stop = src.slice(src.indexOf("async function bgStop("), src.indexOf("/** 「已完成」:默认折叠"));
  assert.ok(stop.indexOf("confirm(bgStopConfirm(r))") >= 0 && stop.indexOf("confirm(") < stop.indexOf('fetch("/api/home/background/'), "先确认再停");
  // live_note 到了只换「运行中」那一行的小字(与卡面、流转条同一个就地换字函数)
  const paint = src.slice(src.indexOf("function liveNotePaint("), src.indexOf("// SSE: pushed on change only"));
  assert.ok(paint.includes('.hrow[data-bg-id="${id}"] .hcard') && paint.includes("n.textContent = text;"));
  assert.ok(src.includes("bgLoadSoon();   // 后台任务"), "refresh 里重读后台任务(事件驱动,不另造事件)");
  assert.ok(src.includes('<p class="coord-seat" id="set-coordinator" hidden></p>'), "设置里协调线一行(只读)");
});
