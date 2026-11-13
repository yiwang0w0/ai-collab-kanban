import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 首页「后台任务」与「建卡后自动开工」(合同 F)。`node --test tests/homebackgroundtest.mjs`。不调用任何模型:
// 协调线用 tests/helpers/fake-coordinator-cli.mjs 顶替,起线用 BOARD_SPAWN_ECHO(只记下要起的命令,不起进程)。
// 纯函数(core/home-background.mjs):三组归类与计数、计划归组、停止判定、逐线走闸;
// 真看板:GET /api/home/background 的形状与 who 字段、停止的两步、autostart 的 started/blocked、未勾选不起线、勾选记在数据目录、鉴权。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { backgroundModel, stopVerdict, runAutostart, autostartText, goalOf, DONE_MAX, holderAndLine, isRunning, attentionDecor,
         stageOf, quotaModel, unlocksOf, ONE_LINE_CODES, NOTE_FRESH_MS, typeAttention } from "../core/home-background.mjs";
import { loadAttentionModel } from "../core/home-model.mjs";
import { freePort } from "./helpers/free-port.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FAKE = join(ROOT, "tests", "helpers", "fake-coordinator-cli.mjs");
const NOW = Date.parse("2026-11-13T12:00:00Z");
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

// ── 纯函数 ─────────────────────────────────────────────────────────────────────
test("三组:运行中 = 执行中的非目标卡(按领取先后);已完成 = 24 小时内、最多 20 条、新的在前;归档的不算", () => {
  const tasks = [
    { id: 1, kind: "goal", subject: "计划甲", status: "in_progress", children_total: 3, children_done: 1 },
    { id: 2, kind: "task", parent_id: 1, subject: "子一", status: "in_progress", live_note: "读第二章", live_note_at: iso(1), updated_at: iso(2), heartbeat_at: NOW - 10000 },
    { id: 3, kind: "task", parent_id: 1, subject: "子二", status: "done", updated_at: iso(30), handed_back: 2 },
    { id: 4, kind: "task", subject: "散卡", status: "in_progress", updated_at: iso(5), heartbeat_at: NOW - 10000 },
    { id: 5, kind: "task", subject: "昨天的", status: "done", updated_at: iso(25 * 60) },
    { id: 6, kind: "task", subject: "归档的", status: "in_progress", archived_at: iso(1) },
    { id: 7, kind: "task", subject: "等验收", status: "waiting", waiting_for: "review" },
  ];
  const since = { 2: iso(10), 4: iso(40) };
  const m = backgroundModel({ tasks, attention: [{ kind: "review", task_id: 7, title: "等验收", type: "accept", verb: "验收" }], now: NOW,
    whoOf: (t) => ({ label: "L" + t.id, kind: "managed", runtime: "claude", model: null }), sinceOf: (t) => since[t.id] ?? null,
    stopOf: (t) => t.id === 2 ? { stoppable: true } : { stoppable: false, reason: "外部" } });
  assert.deepEqual(m.running.map((r) => r.task_id), [4, 2], "先领的在前");
  assert.deepEqual(m.running.find((r) => r.task_id === 2), { task_id: 2, title: "子一", goal: { id: 1, title: "计划甲" },
    who: { label: "L2", kind: "managed", runtime: "claude", model: null }, since: iso(10), live_note: "读第二章", live_note_at: iso(1), stoppable: true,
    holder: { kind: "ai", label: "L2", since: iso(10) }, one_line: { kind: "progress", code: null, params: {}, text: "读第二章", at: iso(1) } });
  assert.equal(m.running.find((r) => r.task_id === 4).stop_note, "外部");
  assert.deepEqual(m.done.map((d) => [d.task_id, d.handed_back, d.done_at]), [[3, 2, iso(30)]], "超过 24 小时的不进");
  assert.deepEqual(m.groups, [{ goal_id: 1, title: "计划甲", total: 3, done: 1, running: 1, queued: 0, stage: "execute", stage_detail: { done: 1, total: 3 } }], "组头:N 个任务 · M 个在跑 · 四段");
  assert.equal(m.done[0].resolved_by, null, "已完成行带 resolved_by(读不到 = null)");
  assert.equal(m.attention_total, 1); assert.equal(m.running_total, 2); assert.equal(m.queued_total, 0);
  assert.deepEqual([m.attention[0].type, m.attention[0].verb], ["accept", "验收"], "attention 原样(type / verb 由 server 从首页行对上)");
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, kind: "task", subject: "d" + i, status: "done", updated_at: iso(i) }));
  const d = backgroundModel({ tasks: many, now: NOW }).done;
  assert.equal(d.length, DONE_MAX); assert.equal(d[0].task_id, 100, "最近完成的在前");
  assert.equal(backgroundModel({ tasks: [{ id: 9, kind: "task", status: "done", updated_at: new Date(NOW + 60000).toISOString() }], now: NOW }).done.length, 0, "未来时刻不算");
});

test("计划归组:孙卡也归到目标;目标读不到不出组;标题过清洗", () => {
  const byId = new Map([[1, { id: 1, kind: "goal", subject: "C:\\Users\\you\\x 计划" }], [2, { id: 2, kind: "task", parent_id: 1 }], [3, { id: 3, kind: "task", parent_id: 2 }]]);
  const g = goalOf(byId.get(3), byId);
  assert.equal(g.id, 1); assert.ok(!g.title.includes("Users"), g.title);
  assert.equal(goalOf({ id: 4, parent_id: 99 }, byId), null);
  assert.equal(goalOf(byId.get(1), byId), null, "目标卡不属于自己");
});

test("停止判定:只给受管线槽位领着、该线至多一个槽在跑的卡", () => {
  const ctx = (o = {}) => ({ isExecutor: (w) => w === "zc", lineOfWorker: (w) => ({ alpha: "alpha", "alpha@2": "alpha", beta: "beta" })[w] ?? null,
                             external: (l) => l === "ext", liveSlots: () => 1, ...o });
  assert.deepEqual(stopVerdict({ status: "in_progress", worker: "alpha" }, ctx()), { stoppable: true, line: "alpha" });
  assert.deepEqual(stopVerdict({ status: "in_progress", worker: "alpha@2" }, ctx({ liveSlots: () => 0 })), { stoppable: true, line: "alpha" }, "进程已不在也能收回");
  assert.equal(stopVerdict({ status: "in_progress", worker: "zc" }, ctx()).reason, "外部 AI,只能在「接入的 AI」里撤销");
  assert.equal(stopVerdict({ status: "in_progress", worker: "someone" }, ctx()).stoppable, false, "不是看板起的进程");
  const two = stopVerdict({ status: "in_progress", worker: "alpha" }, ctx({ liveSlots: () => 2 }));
  assert.equal(two.stoppable, false); assert.match(two.reason, /2 个槽在跑/);
  assert.equal(stopVerdict({ status: "waiting", worker: "alpha" }, ctx()).stoppable, false);
});

test("自动开工逐线走闸:外部线不动、不是受管线 / 在跑 / 闸拦 / 起线抛错各有去处,同一条线只起一次", () => {
  const started = [];
  const r = runAutostart(["alpha", "ext", "alpha", "beta", "gamma", "delta", "run", null, "ghost"], {
    external: (l) => l === "ext", supervised: (l) => l !== "ghost", running: (l) => l === "run",
    gateOf: (l) => ({ beta: "座席未解禁", gamma: "源码闸没过(版本还没确认)" })[l] ?? null,
    start: (l) => { if (l === "delta") throw new Error("看板窗已过"); started.push(l); } });
  assert.deepEqual(started, ["alpha"]);
  assert.deepEqual(r, { started: ["alpha"], already_running: ["run"],
    blocked: [{ line: "beta", reason: "座席未解禁" }, { line: "gamma", reason: "源码闸没过(版本还没确认)" }, { line: "delta", reason: "看板窗已过" }, { line: "ghost", reason: "不是看板管的执行线" }] });
  assert.equal(autostartText({ started: ["alpha", "b2"], blocked: [{ line: "x", reason: "座席未解禁" }], already_running: [] }, (l) => ({ alpha: "开发" })[l]),
               "已让 2 条线开工(「开发」、「b2」);线「x」没起来:座席未解禁。");
  assert.equal(autostartText({ started: [], blocked: [], already_running: ["run"] }), "没有线开工;「run」本来就在跑。");
});

// ── 第 6 波「看清」(合同 G1–G4)纯函数 ─────────────────────────────────────────────────────────────────
const fresh = { heartbeat_at: NOW - 10000 };
const LS = { up: { managed: true, running: true, pool_down: false, seat: null }, down: { managed: true, running: false, pool_down: false, seat: null },
             seat: { managed: true, running: false, pool_down: false, seat: "SEAT_LOCKED" }, pool: { managed: true, running: false, pool_down: true, seat: null } };
const hl = (t, o = {}) => holderAndLine({ updated_at: iso(7), ...t }, { now: NOW, lineOf: (l) => LS[l] ?? null, lineLabel: (l) => "线" + l, ...o });

test("G1 运行中判定:已放行、未完成、不在本人手上;未放行 / 人工闸 / 目标 / 完成 / 在 attention 里的都不算", () => {
  const att = new Set([9]);
  assert.equal(isRunning({ id: 1, status: "in_progress" }, att), true);
  assert.equal(isRunning({ id: 2, status: "waiting", waiting_for: "review" }, att), true, "不在 attention 的等待 = 机器在处理");
  assert.equal(isRunning({ id: 3, status: "not_started", released: 1 }, att), true);
  assert.equal(isRunning({ id: 4, status: "not_started", released: 0 }, att), false);
  assert.equal(isRunning({ id: 5, status: "not_started", released: 1, human_gate: 1 }, att), false);
  assert.equal(isRunning({ id: 6, kind: "goal", status: "in_progress" }, att), false);
  assert.equal(isRunning({ id: 7, status: "done" }, att), false);
  assert.equal(isRunning({ id: 9, status: "waiting", waiting_for: "review" }, att), false, "在本人手上");
  assert.equal(isRunning({ id: 8, status: "in_progress", archived_at: iso(1) }, att), false);
});

test("G1 holder 各 kind 与 one_line 各 code:只读状态字段,判不出 = none", () => {
  const codes = new Set();
  const seen = (r) => { if (r.one_line.code) codes.add(r.one_line.code); return r; };
  // ai:progress(新鲜的 live_note)/ 过期 live_note = none / 心跳中断 = stalled / 心跳中断且线没在跑 = line_stopped
  let r = seen(hl({ status: "in_progress", line: "up", worker: "up", live_note: "跑测试", live_note_at: iso(2), ...fresh }, { who: { label: "开发" }, since: iso(9) }));
  assert.deepEqual(r, { holder: { kind: "ai", label: "开发", since: iso(9) }, one_line: { kind: "progress", code: null, params: {}, text: "跑测试", at: iso(2) } });
  r = hl({ status: "in_progress", line: "up", live_note: "旧的", live_note_at: new Date(NOW - NOTE_FRESH_MS - 1000).toISOString(), ...fresh });
  assert.deepEqual(r.one_line, { kind: "none", code: null, params: {}, text: null, at: null }, "过期的进度不当实时进度");
  r = seen(hl({ status: "in_progress", line: "up", heartbeat_at: NOW - 200000 }));
  assert.deepEqual([r.one_line.kind, r.one_line.code], ["blocked", "stalled"]);
  r = seen(hl({ status: "in_progress", line: "down", heartbeat_at: NOW - 200000 }));
  assert.equal(r.one_line.code, "line_stopped");
  // reviewer / dep(rearm、waiting_dep)/ peer
  r = seen(hl({ status: "waiting", waiting_for: "review" }));
  assert.deepEqual([r.holder, r.one_line.code], [{ kind: "reviewer", label: "自动审阅", since: iso(7) }, "waiting_review_auto"]);
  r = seen(hl({ status: "waiting", waiting_for: "rearm", progress_blockers: [{ code: "CHILDREN_UNFINISHED", related_task_ids: [12, 13] }] }));
  assert.deepEqual([r.holder.kind, r.holder.label, r.one_line.code, r.one_line.params], ["dep", "等 #12、#13", "rearm", { ids: [12, 13] }]);
  r = seen(hl({ status: "not_started", released: 1, line: "up", progress_blockers: [{ code: "DEPENDENCIES_UNFINISHED", related_task_ids: [12] }] }));
  assert.deepEqual([r.holder.kind, r.holder.label, r.one_line.code], ["dep", "等 #12", "waiting_dep"]);
  r = seen(hl({ status: "not_started", released: 1, line: "up", progress_blockers: [{ code: "DELEGATION_NOT_READY" }] }));
  assert.deepEqual([r.holder.kind, r.one_line.code], ["peer", "waiting_peer"]);
  // queue:同树在途上限 / 源码闸 / 座席 / 额度池 / 线停 / 没人领(n 分钟)/ 别的阻塞 = none
  r = seen(hl({ status: "not_started", released: 1, line: "up", progress_blockers: [{ code: "ROOT_WIP_LIMIT", related_task_ids: [3] }] }));
  assert.deepEqual([r.holder.kind, r.one_line.kind, r.one_line.code], ["queue", "blocked", "wip_limit"]);
  r = seen(hl({ status: "not_started", released: 1, line: "down" }, { sourceGate: () => true }));
  assert.equal(r.one_line.code, "source_gate", "线没在跑时,源码闸先说");
  assert.equal(seen(hl({ status: "not_started", released: 1, line: "seat" })).one_line.code, "seat_not_ready");
  assert.equal(seen(hl({ status: "not_started", released: 1, line: "pool" })).one_line.code, "pool_down");
  assert.equal(hl({ status: "not_started", released: 1, line: "down" }).one_line.code, "line_stopped");
  r = seen(hl({ status: "not_started", released: 1, line: "up", execution_trace: { released_at: iso(12) } }));
  assert.deepEqual([r.holder, r.one_line], [{ kind: "queue", label: "线up", since: iso(12) }, { kind: "waiting", code: "unclaimed", params: { minutes: 12 }, text: null, at: null }]);
  assert.equal(hl({ status: "not_started", released: 1, line: "up", progress_blockers: [{ code: "ATTEMPT_LIMIT" }] }).one_line.kind, "none", "别的阻塞不编原因");
  assert.equal(hl({ status: "not_started", released: 1, line: "up" }, { sourceGate: () => true }).one_line.code, "unclaimed", "线在跑就不看源码闸");
  assert.deepEqual([...codes].sort(), [...ONE_LINE_CODES].sort(), "每个 code 至少一例");
  // 整份应答:排队的在后,组里 running 只数在跑的、queued 数排队的
  const m = backgroundModel({ now: NOW, tasks: [
    { id: 1, kind: "goal", subject: "G", status: "in_progress", released: 1, children_total: 2, children_done: 0 },
    { id: 2, parent_id: 1, subject: "排队", status: "not_started", released: 1, line: "up", updated_at: iso(30) },
    { id: 3, parent_id: 1, subject: "在跑", status: "in_progress", line: "up", ...fresh, updated_at: iso(1) }], lineOf: (l) => LS[l] });
  assert.deepEqual(m.running.map((x) => [x.task_id, x.holder.kind]), [[3, "ai"], [2, "queue"]]);
  assert.deepEqual([m.groups[0].running, m.groups[0].queued, m.queued_total], [1, 1, 1]);
  const cut = backgroundModel({ now: NOW, attentionIds: [2], tasks: [{ id: 2, subject: "x", status: "not_started", released: 1 }] });
  assert.equal(cut.running.length, 0, "attention 截到 20 条之外的卡也不进运行中(server 传全量卡号)");
});

test("G2 attention:type / verb 只读条目上的(首页 homeAttnType 那一份);证据只取结构化字段、解锁的下游、来源措辞所需字段", () => {
  const work = [
    { id: 20, subject: "下游甲", status: "not_started", blocked_by: "[10]" }, { id: 21, subject: "下游乙", status: "not_started", blocked_by: "[10,11]" },
    { id: 22, subject: "完成的下游", status: "done", blocked_by: "[10]" }, { id: 23, subject: "坏字段", status: "not_started", blocked_by: "{" }];
  const who = () => ({ label: "实现线" });
  // 条目上的 type / verb = 首页 homeLists 写在行上的那一份;这里用同一个函数给,不另写对照表。
  const { homeAttnType } = loadAttentionModel();
  const D = (a, t) => attentionDecor({ ...a, ...homeAttnType(a.row || {}, t) }, t, { work, whoOf: who });
  const acc = D({ kind: "review", task_id: 10, title: "交付" }, { id: 10, status: "waiting", waiting_for: "review", handed_back: 2 });
  assert.deepEqual([acc.type, acc.verb, acc.evidence], ["accept", "验收", "实现线 自报完成 · 未经复核 · 打回过 2 次"]);
  assert.deepEqual([acc.detail.unlocks, acc.detail.unlocks_total], [[{ id: 20, title: "下游甲" }, { id: 21, title: "下游乙" }], 2], "完成的、字段坏的不算下游");
  assert.equal(D({ kind: "review", task_id: 10 }, { id: 10, status: "waiting", waiting_for: "review", auto_review_at: iso(1) }).evidence, "自动审阅看过,留给你验收");
  const dec = D({ kind: "decision", task_id: 11 }, { id: 11, status: "waiting", waiting_for: "decision" });
  assert.deepEqual([dec.type, dec.verb, dec.evidence, dec.detail.what, dec.detail.source], ["decide", "去裁定", null, null, null], "没有 ask = decide;没证据 = null");
  const hands = D({ kind: "decision", task_id: 12 }, { id: 12, status: "waiting", waiting_for: "decision",
    ask: { needs: "hands", what: "插上\n测试机", where: "C:\\Users\\you\\box", expect: "灯亮" } });
  assert.deepEqual([hands.type, hands.verb, hands.detail.what, hands.detail.expect], ["hands", "去做", "插上 测试机", "灯亮"]);
  assert.ok(!hands.detail.where.includes("Users\\you"), "where 过脱敏:" + hands.detail.where);
  const conf = D({ kind: "decision", task_id: 13 }, { id: 13, status: "waiting", waiting_for: "confirm", decision_package: { options: [1, 2, 3] } });
  assert.deepEqual([conf.type, conf.verb, conf.evidence], ["confirm", "确认", "有 3 个方案可选"]);
  const rel = D({ kind: "release", task_id: 14 }, { id: 14, status: "not_started", posted_by: { label: "助手甲", origin: "operator_said", quote: "明天前\n改好" } });
  assert.deepEqual([rel.type, rel.verb, rel.detail.source], ["release", "放行", { label: "助手甲", origin: "operator_said", quote: "明天前 改好" }]);
  assert.deepEqual(D({ kind: "release", task_id: 15 }, { id: 15, posted_by: { label: "助手甲" } }).detail.source, { label: "助手甲", origin: null }, "缺 origin = null,面板不写来源措辞");
  assert.deepEqual(D({ kind: "release", task_id: 15 }, { id: 15, posted_by: { label: "助手甲", origin: "made_up", quote: "x" } }).detail.source, { label: "助手甲", origin: null }, "认不出的 origin 不认");
  assert.equal(D({ kind: "release", task_id: 15 }, { id: 15, posted_by: { label: "助手甲", origin: "ai_inferred", quote: "x" } }).detail.source.quote, undefined, "原话只跟本人原话走");
  assert.deepEqual([D({ kind: "line_fault", title: "x", row: { action: "line_fault" } }, null).type, D({ kind: "stalled", row: { action: "executor" } }, null).verb], ["fault", "查看"]);
  assert.equal(D({ kind: "blocked", row: { action: "approval", kind: "lock" } }, null).type, "confirm", "逾期锁这类不落在卡上的 = 确认");
  const blk = D({ kind: "blocked", task_id: 16 }, { id: 16, status: "waiting", waiting_for: "dep", progress_blockers: [{ code: "BROKEN_DEPENDENCIES", message: "依赖字段损坏" }] });
  assert.deepEqual([blk.type, blk.detail.what], ["fault", "依赖字段损坏"], "受阻卡 = 故障要你看,what 用服务端的原因");
  assert.equal(D({ kind: "blocked", task_id: 17 }, { id: 17, status: "waiting", waiting_for: "dep", human_gate: 1 }).type, "decide");
  assert.deepEqual([attentionDecor({ kind: "other" }, null).type, attentionDecor({ kind: "other" }, null).verb], [null, null], "条目上没有 type 就不给,这里不另判");
  assert.equal(unlocksOf({ id: 1 }, Array.from({ length: 8 }, (_, i) => ({ id: 30 + i, subject: "d", status: "not_started", blocked_by: [1] }))).unlocks.length, 5, "≤5 条");
});

test("G4 stage:由目标与直属子卡的状态得出;整合从不给出;读不到 = null", () => {
  const g = (o) => ({ id: 1, kind: "goal", status: "in_progress", released: 1, children_total: 3, children_done: 1, ...o });
  assert.deepEqual(stageOf(g({ children_total: 0, children_done: 0 })), { stage: "decompose", stage_detail: { done: 0, total: 0 } });
  assert.equal(stageOf(g({ status: "not_started", released: 0 })).stage, "decompose", "拆好了还没放行");
  assert.deepEqual(stageOf(g({}), [{ status: "in_progress" }, { status: "done" }, { status: "not_started" }]), { stage: "execute", stage_detail: { done: 1, total: 3 } });
  assert.equal(stageOf(g({}), [{ status: "waiting", waiting_for: "review" }, { status: "done" }, { status: "waiting", waiting_for: "decision" }]).stage, "accept");
  assert.equal(stageOf(g({ children_done: 3 })).stage, "accept", "子卡全完、目标没收尾");
  assert.equal(stageOf(g({ status: "done", children_done: 3 })).stage, "done");
  assert.deepEqual(stageOf(g({ children_total: undefined })), { stage: null, stage_detail: null });
  assert.deepEqual(stageOf(null), { stage: null, stage_detail: null });
});

test("第 7 波欠账⑥:首页行的 type 按顺序对到 attention 上;条数对不上就都不给 type,并标 attention_type_mismatch", () => {
  const all = [{ kind: "review", task_id: 1 }, { kind: "decision", task_id: 2 }, { kind: "line_fault" }];
  const kinds = [{ type: "accept", verb: "验收" }, { type: "decide", verb: "去裁定" }, { type: "fault", verb: "查看" }];
  const ok = typeAttention(all.slice(0, 2), all.length, kinds);
  assert.equal(ok.mismatch, false);
  assert.deepEqual(ok.attention.map((a) => [a.task_id, a.type, a.verb]), [[1, "accept", "验收"], [2, "decide", "去裁定"]], "截过的条目也按原顺序对上");
  const bad = typeAttention(all, all.length, kinds.slice(0, 2));
  assert.equal(bad.mismatch, true);
  assert.ok(bad.attention.every((a) => a.type === undefined && a.verb === undefined), "对不上不另判、不给 type");
  assert.deepEqual(typeAttention([], 0, []), { attention: [], mismatch: false });
});

test("G3 quota:各池各一段;没记用完 = unknown(待核实)不当 ok;used_pct 与 runway 一律未知", () => {
  const q = quotaModel({ now: NOW, pools: [{ id: "claude", label: "Claude", exhausted_at: null, until: null },
    { id: "codex", label: "Codex", exhausted_at: iso(10), until: iso(-290) }, { id: "x" }] });
  assert.deepEqual(q.pools[0], { id: "claude", label: "Claude", windows: [{ label: "用量", used_pct: null, resets_at: null }], state: "unknown", runway: { minutes: null, basis: "unknown" } });
  assert.deepEqual([q.pools[1].state, q.pools[1].windows[0]], ["down", { label: "看板暂停到", used_pct: null, resets_at: iso(-290) }]);
  assert.deepEqual([q.pools[2].label, q.pools[2].state], ["x", "unknown"], "没有显示名用 id");
  assert.equal(q.generated_at, new Date(NOW).toISOString());
  assert.ok(!("total" in q) && !("used_pct" in q), "不合成一个数");
});

// ── 真看板 ─────────────────────────────────────────────────────────────────────
async function board() {
  const dir = mkdtempSync(join(tmpdir(), "homebgtest-")), repo = join(dir, "repo"), cfg = join(dir, "fleet.json"), log = join(dir, "coordinator-calls.jsonl");
  mkdirSync(repo);
  writeFileSync(cfg, JSON.stringify({ lines: [{ id: "alpha", label: "开发" }, { id: "beta" }, { id: "ext", label: "外部", external: true }], roles: [], routes: ["default"], repo }));
  // beta 存成 Codex 座席(这块看板上 Codex 未解禁):自动开工时 beta 必须被座席闸拦下。
  writeFileSync(join(dir, "worker_settings.json"), JSON.stringify({ beta: { rev: 0, desired_running: false, agents: [{ runtime: "codex", model: "gpt-5.6-sol", effort: "high", window: false }] } }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: cfg, BOARD_DATA_DIR: dir, BOARD_DB: join(dir, "board.db"),
           BOARD_REPO: repo, BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit", BOARD_ALLOW_UNPINNED: "1", BOARD_SPAWN_ECHO: "1", BOARD_DELIVERABLE_GATE: "off",
           BOARD_COORDINATOR_CLI_ARGV: JSON.stringify([process.execPath, FAKE]), CONVTEST_LOG: log } });
  let logs = ""; const add = (v) => { logs = (logs + String(v)).slice(-20000); };
  child.stdout.on("data", add); child.stderr.on("data", add);
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  const operator = readFileSync(join(dir, "board_token"), "utf8").trim();
  const detail = async (id) => (await api("GET", `/api/conversations/${id}`, operator)).body;
  const settle = async (id) => {
    for (let i = 0; i < 300; i++) { const d = await detail(id); if (d.conversation.status !== "running") return d; await delay(100); }
    throw new Error(`对话 ${id} 一直在运行中\n${logs}`);
  };
  /** 一个对话 → 协调线交回好计划(甲 alpha、乙 beta)→ 返回 { id, rev }。 */
  const planned = async () => {
    const c = await api("POST", "/api/conversations", operator, { message: "【先坏后好】把导出做成可配置的" });
    assert.equal(c.status, 201, JSON.stringify(c.body) + logs);
    const d = await settle(c.body.conversation.id);
    assert.equal(d.plans.length, 1, JSON.stringify(d.messages) + logs);
    return { id: c.body.conversation.id, rev: d.plans[0].rev };
  };
  const stop = async () => {
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    child.kill(); await closed;
    for (const cwd of new Set(calls.map((c) => c.cwd)))
      if (resolve(dirname(cwd)) === resolve(tmpdir()) && basename(cwd).startsWith("kanban-coordinator-")) try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return { dir, api, operator, detail, planned, stop, logs: () => logs, token: (n) => readFileSync(join(dir, n), "utf8").trim() };
}

test("真看板:勾选记在数据目录;未勾选不起线;勾上后起 alpha、beta 被座席闸拦下;后台任务的形状、who、停止两步;鉴权", { timeout: 120000 }, async () => {
  const b = await board();
  try {
    const O = b.operator;
    // ── 勾选:看板级记住,初始不勾,只接受布尔
    assert.deepEqual((await b.api("GET", "/api/home/prefs", O)).body, { autostart: false });
    assert.equal((await b.api("PUT", "/api/home/prefs", O, { autostart: "yes" })).status, 400);
    assert.equal((await b.api("PUT", "/api/home/prefs", O, { autostart: true, x: 1 })).status, 400);
    assert.deepEqual((await b.api("PUT", "/api/home/prefs", O, { autostart: true })).body, { autostart: true });
    assert.deepEqual(JSON.parse(readFileSync(join(b.dir, "home_prefs.json"), "utf8")), { autostart: true }, "存在数据目录");
    assert.deepEqual((await b.api("GET", "/api/home/prefs", O)).body, { autostart: true });
    // 记住的勾选不替 apply 做主:只有请求里带 autostart:true 才起线

    // ── 未勾选(请求不带 autostart):建卡照旧,不起线、不写自动开工消息
    const A = await b.planned();
    const ra = await b.api("POST", `/api/conversations/${A.id}/plans/${A.rev}/apply`, O, { expected_rev: A.rev });
    assert.equal(ra.status, 201, JSON.stringify(ra.body));
    assert.equal(ra.body.autostart, undefined, "没勾就没有 autostart");
    let workers = (await b.api("GET", "/api/workers", O)).body.workers;
    assert.deepEqual(workers.filter((w) => w.desired_running).map((w) => w.line), [], "未勾选:一条线都不起");
    assert.ok(!(await b.detail(A.id)).messages.some((m) => m.kind === "autostart"));

    // ── 勾上:alpha 起(走 workerStart,spawn-echo 记下命令);beta 存的是未解禁的 Codex 座席 → 被拦下,原因进应答与对话
    const B = await b.planned();
    const rb = await b.api("POST", `/api/conversations/${B.id}/plans/${B.rev}/apply`, O, { expected_rev: B.rev, autostart: true });
    assert.equal(rb.status, 201, JSON.stringify(rb.body));
    assert.deepEqual(rb.body.autostart, { started: ["alpha"], blocked: [{ line: "beta", reason: "座席未解禁" }], already_running: [] });
    workers = (await b.api("GET", "/api/workers", O)).body.workers;
    const alpha = workers.find((w) => w.line === "alpha");
    assert.equal(alpha.desired_running, true); assert.match(alpha.slots[0].tail, /\[spawn-echo\]/, "走的是现有起线路径");
    assert.equal(workers.find((w) => w.line === "beta").desired_running, false);
    const sys = (await b.detail(B.id)).messages.filter((m) => m.kind === "autostart");
    assert.deepEqual(sys.map((m) => [m.role, m.text]), [["system", "已让 1 条线开工(「开发」);线「beta」没起来:座席未解禁。"]]);

    // ── 后台任务:受管线领一张(以 alpha 名义)、交付并验收另一张、外部执行者领一张并报进度
    const card = async (id) => (await b.api("GET", `/api/tasks/${id}`, O)).body.task;
    const [a1] = ra.body.task_ids, [b1, b2] = rb.body.task_ids;
    let k = await card(a1);
    const t2 = await b.api("POST", `/api/tasks/${a1}/claim`, O, { worker: "alpha", expected_version: k.aggregate_version });
    assert.equal(t2.status, 200, JSON.stringify(t2.body));
    const rp = await b.api("POST", `/api/tasks/${a1}/report`, O, { worker: "alpha", run_id: t2.body.task.run_id, outcome: "done", evidence: "做完了" });
    assert.equal(rp.status, 200, JSON.stringify(rp.body));
    let bg = (await b.api("GET", "/api/home/background", O)).body;
    assert.ok(bg.attention.some((x) => x.kind === "review" && x.task_id === a1), "交付了 → 等你处理(与简报同一份判定)");
    const brief = (await b.api("GET", "/api/brief", O)).body;
    const base = (a) => { const { type, verb, evidence, detail, ...rest } = a; return rest; };
    assert.deepEqual(bg.attention.map(base), brief.attention, "attention 与助手简报同一份(首页只在其上加 type / verb / evidence / detail)");
    const acc = bg.attention.find((x) => x.task_id === a1);
    assert.deepEqual([acc.type, acc.verb, acc.evidence], ["accept", "验收", "开发 自报完成 · 未经复核"], "只有自报 = 写明未经复核");
    assert.deepEqual(Object.keys(acc.detail).sort(), ["expect", "source", "unlocks", "unlocks_total", "what", "where"]);
    assert.ok(!bg.running.some((r) => r.task_id === a1), "在本人手上的卡不进运行中");
    k = await card(a1);
    const ok = await b.api("POST", `/api/tasks/${a1}/resolve`, O, { verdict: "approve", expected_version: k.aggregate_version });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    k = await card(b1);
    const took = await b.api("POST", `/api/tasks/${b1}/claim`, O, { worker: "alpha", expected_version: k.aggregate_version });
    assert.equal(took.status, 200, JSON.stringify(took.body));

    const c = await b.api("POST", "/api/connect/codes", O, { kind: "codex", line: "ext", label: "外部甲" });
    const ex = (await b.api("POST", "/api/connect/redeem", null, { code: c.body.code })).body;
    const extCard = (await b.api("POST", "/api/tasks", O, { subject: "外部做的卡", line: "ext", description: "卡面", acceptance: "一句" })).body.task;
    const xc = await b.api("POST", `/api/tasks/${extCard.id}/claim`, ex.token, { expected_version: extCard.aggregate_version });
    assert.equal(xc.status, 200, JSON.stringify(xc.body));
    assert.equal((await b.api("POST", `/api/tasks/${extCard.id}/heartbeat`, ex.token, { run_id: xc.body.task.run_id, note: "正在读第二章" })).status, 200);

    bg = (await b.api("GET", "/api/home/background", O)).body;
    assert.deepEqual(Object.keys(bg).sort(), ["attention", "attention_total", "done", "generated_at", "groups", "queued_total", "running", "running_total"]);
    const run = bg.running.find((r) => r.task_id === b1);
    assert.deepEqual({ ...run, since: !!run.since, holder: { ...run.holder, since: run.holder.since === run.since } }, { task_id: b1, title: "甲", goal: { id: rb.body.goal_id, title: "导出功能改造" },
      who: { label: "开发", kind: "managed", runtime: "claude", model: "claude-opus-5" }, since: true, live_note: null, live_note_at: null, stoppable: true,
      holder: { kind: "ai", label: "开发", since: true }, one_line: { kind: "none", code: null, params: {}, text: null, at: null } }, "没有进度 = none,不编");
    const xr = bg.running.find((r) => r.task_id === extCard.id);
    assert.deepEqual([xr.who, xr.live_note, xr.stoppable, xr.stop_note], [{ label: "外部甲", kind: "external", runtime: "codex", model: null }, "正在读第二章", false, "外部 AI,只能在「接入的 AI」里撤销"]);
    assert.deepEqual([xr.holder.kind, xr.holder.label, xr.one_line.kind, xr.one_line.text], ["ai", "外部甲", "progress", "正在读第二章"], "执行者心跳带的进度 = progress");
    const dn = bg.done.find((d) => d.task_id === a1);
    assert.deepEqual([dn.who, dn.handed_back, dn.goal.id], [{ label: "开发", kind: "managed", runtime: "claude", model: null }, 0, ra.body.goal_id], "做完的卡:谁做的取最后一次领取,运行时取卡上记的;模型读不到给 null");
    const q2 = bg.running.find((r) => r.task_id === b2);
    assert.ok(q2 && ["queue", "dep"].includes(q2.holder.kind), "已放行没人领 = 运行中里排队(G1;第 5 波不算)" + JSON.stringify(q2));
    assert.ok(bg.running.indexOf(q2) > bg.running.indexOf(run), "排队的排在后面");
    assert.deepEqual([q2.who, q2.since, q2.stoppable, q2.stop_note], [null, null, false, undefined], "排队的没有谁在做、没有停止");
    assert.deepEqual(bg.groups.find((g) => g.goal_id === rb.body.goal_id), { goal_id: rb.body.goal_id, title: "导出功能改造", total: 2, done: 0, running: 1, queued: 1,
      stage: "execute", stage_detail: { done: 0, total: 2 } });
    assert.equal(bg.queued_total, bg.running.filter((r) => ["queue", "dep"].includes(r.holder.kind)).length);

    // ── G3 额度条:只读池状态;没记用完 = 待核实(unknown),记了用完 = down;不合成一个数
    const q0 = (await b.api("GET", "/api/home/quota", O)).body;
    assert.deepEqual(Object.keys(q0).sort(), ["generated_at", "pools"]);
    assert.ok(q0.pools.length >= 2 && q0.pools.every((p) => p.state === "unknown" && p.windows.every((w) => w.used_pct === null) && p.runway.basis === "unknown"), JSON.stringify(q0));
    assert.equal((await b.api("POST", "/api/pools/exhausted", O, { runtime: "codex" })).status, 200);
    const q1 = (await b.api("GET", "/api/home/quota", O)).body;
    const cx = q1.pools.find((p) => p.id === "codex");
    assert.equal(cx.state, "down"); assert.ok(Date.parse(cx.windows[0].resets_at) > Date.now(), "看板暂停到的时刻");
    assert.ok(q1.pools.filter((p) => p.id !== "codex").every((p) => p.state === "unknown"), "各池各一段,别的池不受影响");

    // ── 停止:外部执行者的卡 409;受管线的卡两步(停该槽 → 收回卡),线的运行意图清掉
    const nx = await b.api("POST", `/api/home/background/${extCard.id}/stop`, O, {});
    assert.deepEqual([nx.status, nx.body.code], [409, "NOT_STOPPABLE"]);
    assert.equal((await b.api("POST", "/api/home/background/99999/stop", O, {})).status, 404);
    const st = await b.api("POST", `/api/home/background/${b1}/stop`, O, {});
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.deepEqual(st.body.steps.map((s) => [s.step, s.ok]), [["stop_slot", true], ["release_card", true]]);
    assert.deepEqual([st.body.ok, st.body.line, st.body.steps[1].status], [true, "alpha", "not_started"]);
    assert.equal((await card(b1)).status, "not_started", "卡收回到未开始");
    assert.equal((await b.api("GET", "/api/workers", O)).body.workers.find((w) => w.line === "alpha").desired_running, false, "这条线停下,不会自己再起来");
    assert.ok((await card(extCard.id)).status === "in_progress", "别人的卡不受影响");
    const again = await b.api("POST", `/api/home/background/${b1}/stop`, O, {});
    assert.deepEqual([again.status, again.body.code], [409, "NOT_STOPPABLE"], "不在执行中就没有停止");

    // ── 鉴权:执行者、助手、执行线、审阅令牌都读不到、改不了
    const ac = await b.api("POST", "/api/connect/codes", O, { kind: "claude", role: "assistant" });
    const as = (await b.api("POST", "/api/connect/redeem", null, { code: ac.body.code })).body;
    for (const [who, tok] of [["执行者", ex.token], ["助手", as.token], ["执行线", b.token("worker_token")], ["审阅", b.token("review_token")], ["无令牌", null]]) {
      for (const [m, p, body] of [["GET", "/api/home/background"], ["GET", "/api/home/prefs"], ["PUT", "/api/home/prefs", { autostart: false }], ["POST", `/api/home/background/${extCard.id}/stop`, {}], ["GET", "/api/home/quota"]]) {
        const r = await b.api(m, p, tok, body);
        assert.ok([401, 403, 404].includes(r.status), `${who} ${m} ${p} → ${r.status}`);   // 绑线执行者的读在前面就被 404(F2),其余 403/401
      }
    }
    assert.deepEqual((await b.api("GET", "/api/home/prefs", O)).body, { autostart: true }, "被拒的写没生效");
  } catch (e) { e.message += "\n" + b.logs().slice(-3000); throw e; }
  finally { await b.stop(); }
});
