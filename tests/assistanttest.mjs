import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 助手角色(合同 E):给聊天机器人、可穿戴设备背后的常驻 AI 用——只读全板 + 挂未放行卡 + 被提醒。
// 权限矩阵(助手令牌逐项被拒;执行者令牌调不了助手接口;操作员不受影响)、post_card 一律未放行 + 上限 + posted_by、
// 简报纯函数的几种板面、真 stdio 桥的工具组与 wait_for_attention、撤销后立即失效、清洗。`node --test tests/assistanttest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { briefModel, briefText, briefOf, maxCharsOf, BRIEF_DEFAULT } from "../core/brief.mjs";
import { loadAttentionModel } from "../core/home-model.mjs";
import { ASSISTANT_PROMPT, ASSISTANT_OPEN_MAX, cardText } from "../core/connect.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BRIDGE = join(ROOT, "cli", "exec-mcp.mjs");
const cp = (...c) => String.fromCodePoint(...c);

async function board() {
  const dir = mkdtempSync(join(tmpdir(), "assistanttest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines: [{ id: "alpha" }, { id: "ext", label: "外部", external: true }], roles: [], routes: ["default"], repo: dir }));
  const l = createServer(); await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const port = l.address().port; await new Promise((r) => l.close(r));
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit" } });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const operator = readFileSync(join(dir, "board_token"), "utf8").trim();
  const worker = readFileSync(join(dir, "worker_token"), "utf8").trim();
  const card = async (subject, line, extra = {}) => {
    const r = await api("POST", "/api/tasks", operator, { subject, line, description: "卡面材料", acceptance: "三句话", ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task;
  };
  const connectAs = async (body) => {
    const c = await api("POST", "/api/connect/codes", operator, body);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await api("POST", "/api/connect/redeem", null, { code: c.body.code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: r.body.executor_id, line: r.body.line, role: r.body.role, token: r.body.token, issued: c.body };
  };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, worker, card, connectAs, stop, log: () => log };
}

/** 真 stdio 桥子进程;call() 按 id 等应答。 */
function bridge(args) {
  const child = spawn(process.execPath, [BRIDGE, ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: HOST_ENV });
  let buf = "", err = ""; const waiting = new Map(), got = new Map();
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { err += d; });
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else got.set(m.id, m);
    }
  });
  let next = 1;
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const request = (method, params) => { const id = next++; send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return got.has(id) ? Promise.resolve(got.get(id)) : new Promise((r) => waiting.set(id, r)); };
  const call = async (name, args) => (await request("tools/call", { name, arguments: args })).result;
  const end = async () => { child.stdin.end(); await new Promise((r) => child.once("close", r)); };
  return { request, send, call, end, stderr: () => err };
}
const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "chatbot", version: "1" } };
const ASSISTANT_TOOLS = ["get_brief", "list_cards", "get_card", "post_card", "wait_for_attention"];

test("助手权限矩阵:只读简报与卡面、挂未放行卡;其余逐项被拒;执行者调不了助手接口;操作员不受影响", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const linesBefore = JSON.parse(readFileSync(join(B.dir, "fleet.json"), "utf8")).lines.length;
    const A = await B.connectAs({ kind: "other", role: "assistant", label: "小" + cp(0x200b) + "助手" });
    assert.equal(A.role, "assistant"); assert.equal(A.line, null, "助手不绑线");
    assert.equal(A.issued.line, null);
    assert.equal(A.issued.snippets.prompt, ASSISTANT_PROMPT);
    assert.doesNotMatch(A.issued.snippets.mcp_config, /--line/, "助手的配置片段不带 --line");
    assert.equal(JSON.parse(readFileSync(join(B.dir, "fleet.json"), "utf8")).lines.length, linesBefore, "发码与兑换都不建线");
    const listed = (await B.api("GET", "/api/executors", B.operator)).body.executors.find((e) => e.id === A.id);
    assert.deepEqual([listed.role, listed.line, listed.label, listed.holding], ["assistant", null, "小助手", []], "名称清掉零宽字符");

    // 一个绑线执行者,手上有卡并写了 live_note(别人的 live_note 助手看不到)
    const X = await B.connectAs({ kind: "other", line: "ext" });
    const held = await B.card("外部线在做的卡", "ext");
    const cl = await B.api("POST", `/api/tasks/${held.id}/claim`, X.token, { expected_version: held.aggregate_version });
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    assert.equal((await B.api("POST", `/api/tasks/${held.id}/heartbeat`, X.token, { run_id: cl.body.task.run_id, note: "在改登录页" })).status, 200);
    const other = await B.card("受管线的卡", "alpha");

    // ── 允许
    const brief = await B.api("GET", "/api/brief", A.token);
    assert.equal(brief.status, 200, JSON.stringify(brief.body));
    assert.equal(typeof brief.body.text, "string");
    assert.ok([...brief.body.text].length <= BRIEF_DEFAULT);
    assert.deepEqual(brief.body.doing.map((d) => [d.task_id, d.who]), [[held.id, "其他 AI"]], "在做的卡写执行方显示名(没给名称 = 种类名)");
    const list = await B.api("GET", "/api/tasks", A.token);
    assert.equal(list.status, 200);
    const seen = list.body.tasks.find((t) => t.id === held.id);
    assert.equal(seen.subject, "外部线在做的卡");
    for (const k of ["live_note", "result", "execution_trace", "run_id", "decision_package", "history_refs"]) assert.ok(!(k in seen), `助手看不到 ${k}`);
    assert.ok(list.body.tasks.some((t) => t.id === other.id), "全板只读:别的线的卡也看得到");
    const one = await B.api("GET", `/api/tasks/${held.id}`, A.token);
    assert.equal(one.status, 200); assert.ok(!("live_note" in one.body.task));
    assert.equal((await B.api("GET", `/api/tasks/${held.id}/history`, A.token)).status, 200, "历史摘要可读");
    assert.deepEqual((await B.api("GET", "/api/connect/me", A.token)).body, { executor_id: A.id, role: "assistant", line: null });

    // ── 读接口拒绝(含 SSE、会话清单与正文、运行记录、证据与裁定附件、设置、协作、接入管理)
    for (const p of ["/api/events", `/api/tasks/${held.id}/runs`, `/api/tasks/${held.id}/evidence/1`, `/api/tasks/${held.id}/decisions/1`,
                     `/api/tasks/${held.id}/export-md`, "/api/coord", "/api/coord/executors", "/api/executors", "/api/workers", "/api/approvals",
                     "/api/desktop-sessions", "/api/desktop-sessions/claude/00000000-0000-4000-8000-000000000000/messages",
                     "/api/conversations", "/api/conversations/1", "/api/efficiency", "/api/usage", "/api/fleet", "/api/journal", "/api/setup", "/api/auth"]) {
      const r = await B.api("GET", p, A.token);
      assert.equal(r.status, 403, `GET ${p} → ${r.status}`);
    }
    // ── 写接口拒绝(领卡、交付、续租、裁定、放行、建普通卡、改配置、接入管理、协作、批准请求)
    for (const [p, body] of [["/api/claim", {}], [`/api/tasks/${other.id}/claim`, { expected_version: other.aggregate_version }],
                             [`/api/tasks/${held.id}/report`, { run_id: cl.body.task.run_id, outcome: "done", evidence: "x" }],
                             [`/api/tasks/${held.id}/heartbeat`, { run_id: cl.body.task.run_id }],
                             [`/api/tasks/${held.id}/resolve`, { verdict: "pass" }], [`/api/tasks/${other.id}/release`, { released: false, expected_version: 1 }],
                             [`/api/tasks/${other.id}/update`, { subject: "改" }], ["/api/tasks", { subject: "直接建卡" }],
                             ["/api/workers/alpha/settings", {}], ["/api/workers/alpha/start", {}], ["/api/connect/codes", { kind: "claude" }],
                             [`/api/executors/${X.id}/revoke`, {}], ["/api/coord/heartbeat", {}], ["/api/coord/locks", { resource: "r", purpose: "p", minutes: 5 }],
                             ["/api/approvals/request", { action: "重启", risk: "low" }], ["/api/pair/code", {}], ["/api/tasks/import-md", {}]]) {
      const r = await B.api("POST", p, A.token, body);
      assert.equal(r.status, 403, `POST ${p} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    // ── 执行者令牌、worker 令牌调不了助手接口;操作员能看简报,不走助手挂卡口
    assert.equal((await B.api("POST", "/api/assistant/cards", X.token, { subject: "s", description: "d", acceptance: "a" })).status, 403);
    assert.equal((await B.api("GET", "/api/brief", X.token)).status, 404, "绑线执行者:白名单外一律 404");
    assert.equal((await B.api("GET", "/api/brief", B.worker)).status, 403);
    assert.equal((await B.api("POST", "/api/assistant/cards", B.operator, { subject: "s", description: "d", acceptance: "a" })).status, 403);
    assert.equal((await B.api("GET", "/api/brief", B.operator)).status, 200);
    assert.equal((await B.api("GET", `/api/tasks/${held.id}`, B.operator)).body.task.live_note, "在改登录页", "操作员照旧看得到 live_note");
    assert.equal((await B.api("GET", "/api/connect/me", B.operator)).status, 403);
    assert.equal((await B.api("GET", "/api/brief?max_chars=50", B.operator)).status, 400, "max_chars 越界 400");

    // ── 撤销后立即失效
    assert.equal((await B.api("POST", `/api/executors/${A.id}/revoke`, B.operator, {})).status, 200);
    assert.equal((await B.api("GET", "/api/brief", A.token)).status, 401);
    assert.equal((await B.api("POST", "/api/assistant/cards", A.token, { subject: "s", description: "d", acceptance: "a" })).status, 401);
    assert.ok(!B.log().includes(A.token), "令牌不进看板日志");
  } finally { await B.stop(); }
});

test("post_card:一律未放行、记 posted_by、首页「待我处理」写「<名称> 挂上 · 待你放行」、同时最多 20 张、清洗", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const A = await B.connectAs({ kind: "claude", role: "assistant", label: "随身助手" });
    const post = (b) => B.api("POST", "/api/assistant/cards", A.token, b);
    assert.equal((await post({ subject: "s", description: "d", acceptance: "a", released: true })).status, 400, "不认识的字段(含 released)400");
    assert.equal((await post({ subject: "  ", description: "d", acceptance: "a" })).status, 400);
    assert.equal((await post({ subject: "s", description: "d" })).status, 400, "acceptance 要字符串");
    assert.equal((await post({ subject: "s", description: "d", acceptance: "a", line: "nope" })).status, 400, "未知线 400");
    const r = await post({ subject: "买" + cp(0x202e) + "牛奶\n明早", description: "第一行\n第二行" + cp(0x200b), acceptance: "买到", line: "alpha" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body, { id: r.body.id, released: false });
    const t = (await B.api("GET", `/api/tasks/${r.body.id}`, B.operator)).body.task;
    assert.deepEqual([t.released, t.subject, t.description, t.line], [false, "买牛奶 明早", "第一行\n第二行", "alpha"], "双向控制符与零宽去掉,标题断行换空格,正文保留换行");
    assert.deepEqual(t.posted_by, { executor_id: A.id, label: "随身助手" });
    const brief = (await B.api("GET", "/api/brief", B.operator)).body;
    const item = brief.attention.find((a) => a.task_id === r.body.id);
    assert.deepEqual([item.kind, item.posted_by], ["release", "随身助手"]);
    assert.match(brief.text, /待放行/);
    // 首页「待我处理」同一份切片:状态写「<名称> 挂上 · 待你放行」
    const M = loadAttentionModel();
    const tasks = (await B.api("GET", "/api/tasks", B.operator)).body.tasks.map((x) => ({ ...x, hb: "" }));
    const row = M.homeLists({ tasks }).mine.find((m) => m.localId === r.body.id);
    assert.equal(row.state, "随身助手 挂上 · 待你放行");
    // 上限:同时在板上的未放行卡 20 张
    for (let i = 1; i < ASSISTANT_OPEN_MAX; i++) assert.equal((await post({ subject: "第 " + i, description: "", acceptance: "" })).status, 201);
    const over = await post({ subject: "第 21 张", description: "", acceptance: "" });
    assert.deepEqual([over.status, over.body.code], [409, "TOO_MANY_POSTED"]);
    // 操作员放行一张后又能挂
    const rel = await B.api("POST", `/api/tasks/${r.body.id}/release`, B.operator, { released: true, expected_version: t.aggregate_version });
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    assert.equal((await post({ subject: "放行后再挂一张", description: "", acceptance: "" })).status, 201);
    // 历史里记的是助手
    const h = (await B.api("GET", `/api/tasks/${r.body.id}/history`, B.operator)).body.entries;
    assert.equal(h[0].step, "created"); assert.equal(h[0].actor_kind, "executor");
  } finally { await B.stop(); }
});

test("真 stdio 桥:助手只拿到五个工具;get_brief / post_card / wait_for_attention(有事即回、到时 none、同一件只提醒一次);撤销后失效", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const c = await B.api("POST", "/api/connect/codes", B.operator, { kind: "other", role: "assistant", label: "手表助手" });
    assert.equal(c.status, 201);
    const tokenFile = join(B.dir, "cred", "assistant.token");
    const M = bridge(["--url", B.base, "--code", c.body.code, "--token-file", tokenFile]);
    try {
      const init = await M.request("initialize", INIT);
      assert.equal(init.result.serverInfo.name, "ai-fleet-board-assistant", JSON.stringify(init));
      M.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = (await M.request("tools/list")).result.tools.map((t) => t.name);
      assert.deepEqual(tools, ASSISTANT_TOOLS, "助手拿不到 claim_card / report_result 等执行者工具");
      assert.equal((await M.request("tools/call", { name: "claim_card", arguments: { id: 1, expected_version: 1 } })).error.message, "Unknown tool");
      assert.ok(!readFileSync(tokenFile, "utf8").includes(c.body.code));

      const empty = await M.call("get_brief", {});
      assert.equal(empty.isError, false);
      assert.equal(empty.structuredContent.text, "没有等你处理的事。没有在做的卡。" + empty.structuredContent.headline + "。");
      const none = await M.call("wait_for_attention", { timeout_sec: 1 });
      assert.deepEqual(none.structuredContent.none, true, "空板到时 none");

      const posted = await M.call("post_card", { subject: "周五前订会议室", description: "三个人", acceptance: "订好" });
      assert.equal(posted.isError, false, JSON.stringify(posted));
      assert.equal(posted.structuredContent.released, false);
      const first = await M.call("wait_for_attention", { timeout_sec: 5 });
      assert.deepEqual(first.structuredContent.items.map((i) => [i.kind, i.task_id]), [["release", posted.structuredContent.id]], "有事即回");
      const again = await M.call("wait_for_attention", { timeout_sec: 1 });
      assert.equal(again.structuredContent.none, true, "同一件事只提醒一次");

      // 有卡待验收时返回:执行者领卡、交付 → 待验收
      const X = await B.connectAs({ kind: "other", line: "ext" });
      const t = await B.card("外部线的活", "ext");
      const cl = await B.api("POST", `/api/tasks/${t.id}/claim`, X.token, { expected_version: t.aggregate_version });
      const waiting = M.call("wait_for_attention", { timeout_sec: 20 });
      await delay(300);
      assert.equal((await B.api("POST", `/api/tasks/${t.id}/report`, X.token, { run_id: cl.body.task.run_id, outcome: "done", evidence: "一。二。三。" })).status, 200);
      const review = await waiting;
      assert.deepEqual(review.structuredContent.items.map((i) => [i.kind, i.task_id]), [["review", t.id]]);

      const cards = await M.call("list_cards", {});
      assert.ok(cards.structuredContent.cards.some((x) => x.id === posted.structuredContent.id && x.posted_by === "手表助手" && x.released === false));
      const one = await M.call("get_card", { id: t.id });
      assert.equal(one.structuredContent.card.status, "waiting");
      assert.ok(one.structuredContent.card.history.length >= 2);
      assert.ok(!("result" in one.structuredContent.card) && !("evidence" in one.structuredContent.card), "不含证据全文");

      const id = (await B.api("GET", "/api/executors", B.operator)).body.executors.find((e) => e.role === "assistant").id;
      assert.equal((await B.api("POST", `/api/executors/${id}/revoke`, B.operator, {})).status, 200);
      const dead = await M.call("get_brief", {});
      assert.deepEqual([dead.isError, dead.structuredContent.code], [true, "UNAUTHENTICATED"], "撤销后立即失效");
    } finally { await M.end(); }
    assert.doesNotMatch(M.stderr(), /exe_[0-9a-f]{8}/, "桥的诊断输出不带令牌");
  } finally { await B.stop(); }
});

// ── 简报纯函数 ─────────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-11-11T12:00:00Z");
const M = loadAttentionModel();
const T = (id, extra) => ({ id, task_uid: "u" + id, kind: "task", subject: "卡 " + id, status: "not_started", released: 1, updated_at: "2026-11-11T10:00:00.000Z", hb: "", ...extra });
const make = ({ tasks = [], executors = [], workers = [], headline = null, max } = {}) =>
  briefOf({ lists: M.homeLists({ tasks, executors }), faults: M.homeLineFaults(workers, {}), tasks, headline, now: NOW }, max);

test("简报:空板、有待验收、有卡住的 AI、线故障、未知效率;同输入同输出;长度硬上限;清洗", () => {
  const empty = make({ headline: "本周完成 0 张 · 打回 0 次 · 你操作 0 次" });
  assert.equal(empty.text, "没有等你处理的事。没有在做的卡。本周完成 0 张 · 打回 0 次 · 你操作 0 次。");
  assert.deepEqual([empty.attention, empty.doing, empty.done_recent], [[], [], []]);
  assert.equal(make().text, "没有等你处理的事。没有在做的卡。本周效率暂无数据。", "效率未知写「暂无数据」,不当 0");

  const tasks = [
    T(12, { subject: "修登录页", status: "waiting", waiting_for: "review", updated_at: "2026-11-11T09:00:00.000Z" }),
    T(13, { subject: "整理周报", status: "in_progress", worker: "ext", who: "桌面 Zcode" }),
    T(9, { subject: "改配色", status: "done", updated_at: "2026-11-11T11:00:00.000Z" }),
    T(8, { subject: "上周的事", status: "done", updated_at: "2026-11-01T11:00:00.000Z" }),
    T(15, { subject: "订会议室", released: 0, progress_blockers: [{ code: "NOT_RELEASED" }], posted_by: { executor_id: "asst-bot", label: "手表助手" } }),
  ];
  const executors = [{ id: "zc", label: "Zcode", state: "stalled", holding: [{ id: 20, subject: "x" }], last_seen_at: "2026-11-11T08:00:00.000Z" }];
  const workers = [{ line: "alpha", running: false, desired_running: true, stop_reason: { reason: "crash" }, stop_text: "崩溃 · 刚才", exit_code: 1 }];
  const b = make({ tasks, executors, workers, headline: "本周完成 3 张 · 打回 1 次 · 你操作 4 次" });
  assert.deepEqual(b.attention.map((a) => [a.kind, a.task_id ?? null]), [["stalled", null], ["review", 12], ["release", 15], ["line_fault", null]],
                   "顺序同首页「待我处理」(卡住与待验收同档,等得久的在前;待放行排后),线故障接在最后");
  assert.equal(b.attention[2].posted_by, "手表助手");
  assert.deepEqual(b.doing, [{ task_id: 13, title: "整理周报", who: "桌面 Zcode" }]);
  assert.deepEqual(b.done_recent.map((d) => d.task_id), [9], "刚完成 = 24 小时内");
  assert.equal(b.text, "等你处理 4 件:「Zcode 卡住了 · 手上有 #20」、#12「修登录页」待验收 等。在做 1 件。刚完成 #9「改配色」。本周完成 3 张 · 打回 1 次 · 你操作 4 次。");
  assert.equal(make({ tasks, executors, workers, headline: "本周完成 3 张 · 打回 1 次 · 你操作 4 次" }).text, b.text, "纯函数:同输入同输出");

  // 长度硬上限:标题再长、件数再多也不超过 max_chars;放不下先收标题、再少点名、再去掉「刚完成」与效率主句
  const many = Array.from({ length: 30 }, (_, i) => T(100 + i, { subject: "很长很长的标题".repeat(10) + i, status: "waiting", waiting_for: "review" }));
  for (const max of [80, 120, 280, 600]) {
    const t = make({ tasks: many, headline: "本周完成 3 张 · 打回 1 次 · 你操作 4 次", max }).text;
    assert.ok([...t].length <= max, `max ${max}: ${[...t].length}`);
    assert.match(t, /^等你处理 30 件/);
  }
  // 清洗:标题里的路径与令牌样串不进 text 与条目
  const leak = make({ tasks: [T(5, { subject: "看 C:\\Users\\example\\secret.txt 用 " + "exe_" + "0123456789abcdef".repeat(2), status: "waiting", waiting_for: "decision" })] });
  for (const s of [leak.text, leak.attention[0].title]) { assert.doesNotMatch(s, /Users|secret|exe_/); assert.match(s, /…/); }
  assert.equal(leak.attention[0].kind, "decision");

  assert.equal(maxCharsOf(null), 280); assert.equal(maxCharsOf("120"), 120);
  for (const v of ["79", "601", "1.5", "x"]) assert.throws(() => maxCharsOf(v), /max_chars/);
  assert.equal(briefText(briefModel({ now: NOW }), 80), "没有等你处理的事。没有在做的卡。本周效率暂无数据。");
});

test("卡面清洗(cardText):标题断行换空格、正文留换行;零宽与双向控制符去掉", () => {
  assert.equal(cardText("a\u202eb\u200bc\r\nd"), "abc d");
  assert.equal(cardText("一\r\n二\u2028三\t四\u0007", { multiline: true }), "一\n二三\t四");
});
