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
import { backgroundModel, stopVerdict, runAutostart, autostartText, goalOf, DONE_MAX } from "../core/home-background.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FAKE = join(ROOT, "tests", "helpers", "fake-coordinator-cli.mjs");
const NOW = Date.parse("2026-11-13T12:00:00Z");
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

// ── 纯函数 ─────────────────────────────────────────────────────────────────────
test("三组:运行中 = 执行中的非目标卡(按领取先后);已完成 = 24 小时内、最多 20 条、新的在前;归档的不算", () => {
  const tasks = [
    { id: 1, kind: "goal", subject: "计划甲", status: "in_progress", children_total: 3, children_done: 1 },
    { id: 2, kind: "task", parent_id: 1, subject: "子一", status: "in_progress", live_note: "读第二章", live_note_at: iso(1), updated_at: iso(2) },
    { id: 3, kind: "task", parent_id: 1, subject: "子二", status: "done", updated_at: iso(30), handed_back: 2 },
    { id: 4, kind: "task", subject: "散卡", status: "in_progress", updated_at: iso(5) },
    { id: 5, kind: "task", subject: "昨天的", status: "done", updated_at: iso(25 * 60) },
    { id: 6, kind: "task", subject: "归档的", status: "in_progress", archived_at: iso(1) },
    { id: 7, kind: "task", subject: "等验收", status: "waiting", waiting_for: "review" },
  ];
  const since = { 2: iso(10), 4: iso(40) };
  const m = backgroundModel({ tasks, attention: [{ kind: "review", task_id: 7, title: "等验收" }], now: NOW,
    whoOf: (t) => ({ label: "L" + t.id, kind: "managed", runtime: "claude", model: null }), sinceOf: (t) => since[t.id] ?? null,
    stopOf: (t) => t.id === 2 ? { stoppable: true } : { stoppable: false, reason: "外部" } });
  assert.deepEqual(m.running.map((r) => r.task_id), [4, 2], "先领的在前");
  assert.deepEqual(m.running.find((r) => r.task_id === 2), { task_id: 2, title: "子一", goal: { id: 1, title: "计划甲" },
    who: { label: "L2", kind: "managed", runtime: "claude", model: null }, since: iso(10), live_note: "读第二章", live_note_at: iso(1), stoppable: true });
  assert.equal(m.running.find((r) => r.task_id === 4).stop_note, "外部");
  assert.deepEqual(m.done.map((d) => [d.task_id, d.handed_back, d.done_at]), [[3, 2, iso(30)]], "超过 24 小时的不进");
  assert.deepEqual(m.groups, [{ goal_id: 1, title: "计划甲", total: 3, done: 1, running: 1 }], "组头:N 个任务 · M 个在跑");
  assert.equal(m.attention_total, 1); assert.equal(m.running_total, 2);
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

// ── 真看板 ─────────────────────────────────────────────────────────────────────
const freePort = async () => {
  const l = createServer(); await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const port = l.address().port; await new Promise((r) => l.close(r)); return port;
};
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
    assert.deepEqual(bg.attention, brief.attention, "attention 与助手简报同一份");
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
    assert.deepEqual(Object.keys(bg).sort(), ["attention", "attention_total", "done", "generated_at", "groups", "running", "running_total"]);
    const run = bg.running.find((r) => r.task_id === b1);
    assert.deepEqual({ ...run, since: !!run.since }, { task_id: b1, title: "甲", goal: { id: rb.body.goal_id, title: "导出功能改造" },
      who: { label: "开发", kind: "managed", runtime: "claude", model: "claude-opus-5" }, since: true, live_note: null, live_note_at: null, stoppable: true });
    const xr = bg.running.find((r) => r.task_id === extCard.id);
    assert.deepEqual([xr.who, xr.live_note, xr.stoppable, xr.stop_note], [{ label: "外部甲", kind: "external", runtime: "codex", model: null }, "正在读第二章", false, "外部 AI,只能在「接入的 AI」里撤销"]);
    const dn = bg.done.find((d) => d.task_id === a1);
    assert.deepEqual([dn.who, dn.handed_back, dn.goal.id], [{ label: "开发", kind: "managed", runtime: "claude", model: null }, 0, ra.body.goal_id], "做完的卡:谁做的取最后一次领取,运行时取卡上记的;模型读不到给 null");
    assert.deepEqual(bg.groups.find((g) => g.goal_id === rb.body.goal_id), { goal_id: rb.body.goal_id, title: "导出功能改造", total: 2, done: 0, running: 1 });
    assert.ok(!bg.running.some((r) => r.task_id === b2), "没领的不算运行中");

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
      for (const [m, p, body] of [["GET", "/api/home/background"], ["GET", "/api/home/prefs"], ["PUT", "/api/home/prefs", { autostart: false }], ["POST", `/api/home/background/${extCard.id}/stop`, {}]]) {
        const r = await b.api(m, p, tok, body);
        assert.ok([401, 403, 404].includes(r.status), `${who} ${m} ${p} → ${r.status}`);   // 绑线执行者的读在前面就被 404(F2),其余 403/401
      }
    }
    assert.deepEqual((await b.api("GET", "/api/home/prefs", O)).body, { autostart: true }, "被拒的写没生效");
  } catch (e) { e.message += "\n" + b.logs().slice(-3000); throw e; }
  finally { await b.stop(); }
});
