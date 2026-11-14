import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 合同 J3(第 9 波 9c)回执与桥:真看板 + 真 stdio 桥子进程,不连接模型;另有一组桥对「旧看板 / 假看板」的进程内对照(注入 send)。
//   `node --test tests/receiptstest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { freePort } from "./helpers/free-port.mjs";
import { createExecBridge } from "../core/mcp/exec-bridge.mjs";
import { checkAck, noticesIn, NOTICE_CODES } from "../core/receipts.mjs";
import { checkWhereHint } from "../core/connect.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BRIDGE = join(ROOT, "cli", "exec-mcp.mjs");

async function board() {
  const dir = mkdtempSync(join(tmpdir(), "receiptstest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines: [{ id: "alpha" }, { id: "ext", label: "外部", external: true }], roles: [], routes: ["default"], repo: dir }));
  const port = await freePort(), empty = join(dir, "empty");
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit",
           BOARD_CLAUDE_PROJECTS: empty, BOARD_CODEX_HOME: empty } });
  child.stdout.resume(); child.stderr.resume();
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
  const card = async (subject, line = "ext") => {
    const r = await api("POST", "/api/tasks", operator, { subject, line, description: "卡面材料", acceptance: "三句话" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task;
  };
  const get = async (id, tok = operator) => (await api("GET", `/api/tasks/${id}`, tok)).body?.task;
  const connectAs = async (body) => {
    const c = await api("POST", "/api/connect/codes", operator, body);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await api("POST", "/api/connect/redeem", null, { code: c.body.code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tokenFile = join(dir, `${r.body.executor_id}.token`); writeFileSync(tokenFile, r.body.token + "\n");
    return { id: r.body.executor_id, token: r.body.token, tokenFile };
  };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, card, get, connectAs, stop };
}

function bridge(args) {
  const child = spawn(process.execPath, [BRIDGE, ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: HOST_ENV });
  let buf = ""; const waiting = new Map(), got = new Map();
  child.stdout.setEncoding("utf8"); child.stderr.resume();
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
  const call = async (name, a) => (await request("tools/call", { name, arguments: a })).result.structuredContent;
  const end = async () => { child.stdin.end(); await new Promise((r) => child.once("close", r)); };
  return { request, send, call, end };
}
const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } };
async function openBridge(B, X) {
  const M = bridge(["--url", B.base, "--token-file", X.tokenFile, "--line", "ext"]);
  assert.ok((await M.request("initialize", INIT)).result);
  M.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return M;
}

test("J3.1 拉取回执:谁、哪一版、5 秒节流;领卡 / 开始;只给操作者(执行者、助手视图反向断言)", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "claude", line: "ext", label: "桌面甲" });
    const A = await B.connectAs({ kind: "other", role: "assistant", label: "随身助手" });
    const c = await B.card("回执卡");
    assert.deepEqual((await B.get(c.id)).receipts, { read: null, claimed_at: null, started_at: null, acked_spec_version: null, notices: [] }, "没人拉取过");
    // peek=1(桥自己核卡)不算拉取
    assert.equal((await B.api("GET", `/api/tasks/${c.id}?peek=1`, X.token)).status, 200);
    assert.equal((await B.get(c.id)).receipts.read, null, "peek=1 不记拉取");
    const M = await openBridge(B, X);
    try {
      const g = await M.call("get_card", { id: c.id });
      const r1 = (await B.get(c.id)).receipts;
      assert.equal(r1.read.executor_label, "桌面甲");
      assert.equal(r1.read.version, g.card.spec_version);
      assert.ok(Date.parse(r1.read.at) > 0);
      // 节流:5 秒内再拉一次同一版 → 不写库(at 不变)
      await M.call("get_card", { id: c.id });
      assert.equal((await B.get(c.id)).receipts.read.at, r1.read.at, "5 秒内重复拉取不再写");
      // 改说明 → 新版本 → 新的一行(不受旧版的节流影响)
      const cur = await B.get(c.id);
      const up = await B.api("POST", `/api/tasks/${c.id}/update`, B.operator, { expected_version: cur.aggregate_version, description: "卡面材料(改)" });
      assert.equal(up.status, 200, JSON.stringify(up.body));
      const g2 = await M.call("get_card", { id: c.id });
      assert.ok(g2.card.spec_version > g.card.spec_version, "说明版本 +1");
      assert.equal((await B.get(c.id)).receipts.read.version, g2.card.spec_version, "read 跟到新版");
      // 过了节流窗口同一版再拉 → at 往后
      const before = (await B.get(c.id)).receipts.read.at;
      await delay(5200);
      await M.call("get_card", { id: c.id });
      assert.ok(Date.parse((await B.get(c.id)).receipts.read.at) > Date.parse(before), "过了 5 秒再拉取会更新时刻");
      // 领卡 → claimed_at;第一次心跳 → started_at;带 seen → acked_spec_version
      const cl = await M.call("claim_card", { id: c.id, expected_version: g2.card.aggregate_version });
      assert.ok(cl.run_id);
      let rc = (await B.get(c.id)).receipts;
      assert.ok(rc.claimed_at, "领过 = claimed_at");
      assert.equal(rc.started_at, null, "还没心跳 = 没开始(自报)");
      await M.call("heartbeat", { id: c.id });
      rc = (await B.get(c.id)).receipts;
      assert.ok(rc.started_at, "第一次心跳 = 开始(自报)");
      assert.equal(rc.acked_spec_version, g2.card.spec_version, "桥自动带 get_card 给过的版本");
      // 反向断言:执行者、助手看不到 receipts(单卡与列表都看)
      assert.equal("receipts" in (await B.get(c.id, X.token)), false, "执行者视图没有 receipts");
      assert.equal((await B.api("GET", "/api/tasks?status=in_progress&archived=false", X.token)).body.tasks.some((t) => "receipts" in t), false, "执行者列表没有 receipts");
      assert.equal("receipts" in (await B.get(c.id, A.token)), false, "助手视图没有 receipts");
      assert.ok((await B.api("GET", "/api/tasks?archived=false", B.operator)).body.tasks.every((t) => "receipts" in t), "操作者列表每张卡都有 receipts");
      assert.equal("receipts" in (await M.call("get_card", { id: c.id })).card, false, "桥的卡面没有 receipts");
    } finally { await M.end(); }
  } finally { await B.stop(); }
});

test("J3.2 提示 sent / acked:应答里给过即记 sent(同 run 同 code 一次);ack 只追加;未知码 400;不带 ack = 已送达 · 未确认", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "ext", label: "桌面乙" });
    const c = await B.card("要被取代的"), neu = await B.card("取代它的");
    const M = await openBridge(B, X);
    try {
      const g = await M.call("get_card", { id: c.id });
      const cl = await M.call("claim_card", { id: c.id, expected_version: g.card.aggregate_version });
      const h0 = await M.call("heartbeat", { id: c.id });
      assert.equal("notices" in h0, false, "没有提示就不带 notices");
      assert.equal((await B.api("POST", `/api/tasks/${c.id}/supersede`, B.operator, { by: neu.id })).status, 200);
      const h1 = await M.call("heartbeat", { id: c.id });
      assert.deepEqual(h1.notices, ["superseded"]);
      assert.match(h1.ack_hint, /ack/);
      assert.equal(h1.superseded.by, neu.id);
      let n = (await B.get(c.id)).receipts.notices;
      assert.equal(n.length, 1); assert.equal(n[0].code, "superseded"); assert.ok(n[0].sent_at); assert.equal(n[0].acked_at, null, "已送达 · 未确认");
      const sent = n[0].sent_at;
      await delay(20);
      await M.call("heartbeat", { id: c.id });
      n = (await B.get(c.id)).receipts.notices;
      assert.deepEqual([n.length, n[0].sent_at], [1, sent], "同一 run 同一 code 只记第一次");
      // 未知码:桥里就拒;直接打接口 400,且这次心跳不落盘(不改租约 / 不记确认)
      assert.equal((await M.call("heartbeat", { id: c.id, ack: ["spec_changed"] })).code, "BAD_INPUT");
      const raw = await B.api("POST", `/api/tasks/${c.id}/heartbeat`, X.token, { run_id: cl.run_id, ack: ["nope"] });
      assert.equal(raw.status, 400, JSON.stringify(raw.body));
      assert.equal((await B.api("POST", `/api/tasks/${c.id}/heartbeat`, X.token, { run_id: cl.run_id, ack: "superseded" })).status, 400, "ack 要数组");
      assert.equal((await B.get(c.id)).receipts.notices[0].acked_at, null);
      // 确认
      const h2 = await M.call("heartbeat", { id: c.id, ack: ["superseded", "superseded"] });
      assert.deepEqual(h2.acked, ["superseded"], "新看板回 acked;重复的码去重");
      n = (await B.get(c.id)).receipts.notices;
      assert.ok(Date.parse(n[0].acked_at) >= Date.parse(n[0].sent_at));
      // 只追加:库里不能改不能删(触发器)
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(B.dir, "board.db"));
      try {
        assert.equal(db.prepare("SELECT COUNT(*) n FROM notice_acks WHERE task_id=?").get(c.id).n, 1);
        assert.throws(() => db.prepare("DELETE FROM notice_acks").run(), /只追加/);
        assert.throws(() => db.prepare("UPDATE notice_acks SET code='x'").run(), /只追加/);
      } finally { db.close(); }
      // 别人的卡 ack 不进:持有者核对仍在 store.heartbeat(409),ack 不落
      const Y = await B.connectAs({ kind: "zcode", line: "ext", label: "桌面丙" });
      assert.notEqual((await B.api("POST", `/api/tasks/${c.id}/heartbeat`, Y.token, { run_id: cl.run_id, ack: ["base_gone"] })).status, 200);
      assert.equal((await B.get(c.id)).receipts.notices.length, 1);
    } finally { await M.end(); }
  } finally { await B.stop(); }
});

test("J3.3 operator_note:打回时写的话经真桥 get_card 到得了执行者(过 redact,带 at / kind);再领时仍在", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "claude", line: "ext", label: "桌面甲" });
    const c = await B.card("要打回的卡");
    const M = await openBridge(B, X);
    try {
      const g = await M.call("get_card", { id: c.id });
      assert.equal("operator_note" in g.card, false, "没裁定过 = 没有 operator_note");
      await M.call("claim_card", { id: c.id, expected_version: g.card.aggregate_version });
      await M.call("report_result", { id: c.id, outcome: "done", evidence: "交付正文" });
      const NOTE = "第二条按周算;日志在 C:\\Users\\example\\fixture\\out.log 里看 token exe_" + "0".repeat(48);
      const v = (await B.get(c.id)).aggregate_version;
      assert.equal((await B.api("POST", `/api/tasks/${c.id}/resolve`, B.operator, { verdict: "reject", note: NOTE, expected_version: v })).status, 200);
      const g2 = await M.call("get_card", { id: c.id });
      const on = g2.card.operator_note;
      assert.ok(on, "打回后 get_card 带 operator_note");
      assert.match(on.text, /第二条按周算/);
      assert.ok(!on.text.includes("example") && !on.text.includes("0".repeat(20)), "路径与令牌样串遮掉:" + on.text);
      assert.equal(on.kind, "handback"); assert.equal(on.by, "operator"); assert.ok(Date.parse(on.at) > 0);
      // 再领:仍能读到;执行中 heartbeat 照常
      await M.call("claim_card", { id: c.id, expected_version: g2.card.aggregate_version });
      assert.match((await M.call("get_card", { id: c.id })).card.operator_note.text, /第二条按周算/);
      // 下一次裁定没写话 → operator_note 消失(last_note 空串 = 这一轮人没说话)
      await M.call("report_result", { id: c.id, outcome: "done", evidence: "第二轮" });
      const v2 = (await B.get(c.id)).aggregate_version;
      assert.equal((await B.api("POST", `/api/tasks/${c.id}/resolve`, B.operator, { verdict: "approve", expected_version: v2, allow_uncommitted: true })).status, 200);
      assert.equal((await B.get(c.id)).operator_note, null);
    } finally { await M.end(); }
  } finally { await B.stop(); }
});

test("J3.4 report_result.usage:只收数字与模型名,入账 external-reported;J3.5 where_hint:存进 ask、自报、助手不见 host_label", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "claude", line: "ext", label: "桌面甲" });
    const A = await B.connectAs({ kind: "other", role: "assistant", label: "随身助手" });
    const c = await B.card("记用量的卡"), d = await B.card("要人亲手做的卡");
    const M = await openBridge(B, X);
    try {
      let g = await M.call("get_card", { id: c.id });
      await M.call("claim_card", { id: c.id, expected_version: g.card.aggregate_version });
      for (const bad of [{ model: "x;rm" }, { in: -1 }, { in: 1.5 }, { cost_usd: "1" }, { tokens: 3 }, { model: "" }])
        assert.equal((await M.call("report_result", { id: c.id, outcome: "done", evidence: "e", usage: bad })).code, "BAD_INPUT", JSON.stringify(bad));
      assert.equal((await B.get(c.id)).status, "in_progress", "被拒的不落盘");
      const r = await M.call("report_result", { id: c.id, outcome: "done", evidence: "交付", usage: { model: "fixture-model-1", in: 120, out: 30, cc: 5, cr: 7, cost_usd: 0.0125, duration_ms: 4200, calls: 3 } });
      assert.equal(r.usage_recorded, 1);
      const ledger = join(B.dir, "usage_ledger.jsonl");
      assert.ok(existsSync(ledger));
      const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.card === c.id);
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].model, rows[0].in, rows[0].out, rows[0].cc, rows[0].cr, rows[0].calls, rows[0].cost_usd, rows[0].cost_source, rows[0].reported_by, rows[0].worker],
        ["fixture-model-1", 120, 30, 5, 7, 3, 0.0125, "external-reported", "external", X.id]);
      // where_hint
      g = await M.call("get_card", { id: d.id });
      await M.call("claim_card", { id: d.id, expected_version: g.card.aggregate_version });
      assert.equal((await M.call("ask_operator", { id: d.id, question: "q", where_hint: { app: "word" } })).code, "BAD_INPUT", "app 只认五个值");
      assert.equal((await M.call("ask_operator", { id: d.id, question: "q", where_hint: { host_label: "x".repeat(41) } })).code, "BAD_INPUT", "host_label ≤40");
      assert.equal((await M.call("ask_operator", { id: d.id, question: "q", where_hint: { approved: true } })).code, "BAD_INPUT", "不认识的键");
      const ask = await M.call("ask_operator", { id: d.id, question: "要你在那台机器上登录", needs: "hands", what: "登录一次",
        where_hint: { app: "codex", host_label: "二楼那台 C:\\Users\\example\nb" } });
      assert.equal(ask.where_hint.app, "codex", JSON.stringify(ask));
      const op = (await B.get(d.id)).ask;
      assert.equal(op.needs, "hands");
      assert.equal(op.where_hint.app, "codex"); assert.equal(op.where_hint.self_reported, true);
      assert.ok(op.where_hint.host_label.startsWith("二楼那台"), op.where_hint.host_label);
      assert.ok(!/example|\n/.test(op.where_hint.host_label), "压成一行、遮掉路径:" + op.where_hint.host_label);
      assert.equal(Object.keys(op.where_hint).some((k) => /approv|grant|allow/i.test(k)), false, "没有任何批准语义的字段");
      const av = (await B.get(d.id, A.token)).ask;
      assert.deepEqual(av.where_hint, { app: "codex", self_reported: true }, "助手不见 host_label");
      // 直接打接口:where_hint 配 done → 400
      const e = await B.card("再一张");
      const ge = await M.call("get_card", { id: e.id });
      const ce = await M.call("claim_card", { id: e.id, expected_version: ge.card.aggregate_version });
      assert.equal((await B.api("POST", `/api/tasks/${e.id}/report`, X.token, { run_id: ce.run_id, outcome: "done", evidence: "x", where_hint: { app: "codex" } })).status, 400);
      // 只有 where_hint、没有 needs 等 → 按 decision 记
      assert.equal((await M.call("ask_operator", { id: e.id, question: "选哪个", where_hint: { app: "claude-code" } })).where_hint.app, "claude-code");
      assert.deepEqual((await B.get(e.id)).ask, { needs: "decision", what: null, where: null, expect: null, where_hint: { app: "claude-code", host_label: null, self_reported: true } });
    } finally { await M.end(); }
  } finally { await B.stop(); }
});

test("J3.6 report_pool:这一版看板没有池读数接口 → 明示「看板版本不支持」,不静默吞", { timeout: 90000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "claude", line: "ext", label: "桌面甲" });
    const M = await openBridge(B, X);
    try {
      assert.equal((await M.call("report_pool", { pool: "claude", window: "7d", used_pct: 101 })).code, "BAD_INPUT");
      assert.equal((await M.call("report_pool", { pool: "claude", window: "7d", used_pct: 30, resets_at: "明天" })).code, "BAD_INPUT");
      const r = await M.call("report_pool", { pool: "claude", window: "7d", used_pct: 38.5 });
      if (r.code) { assert.equal(r.code, "UNSUPPORTED_BY_BOARD", JSON.stringify(r)); assert.match(r.message, /看板版本不支持/); }
      else assert.ok(r.reading, "看板支持时回读数:" + JSON.stringify(r));   // 9b 的接口已在时走这一支(联合用例另核)
    } finally { await M.end(); }
  } finally { await B.stop(); }
});

// ── 进程内:桥对「旧看板 / 假看板」(注入 send)。新字段在旧看板上一律明示不支持;report_pool 的正文形 = 合同 J2.2。
function fakeBridge(routes) {
  const dir = mkdtempSync(join(tmpdir(), "receiptstest-fake-")), tokenFile = join(dir, "t.token");
  writeFileSync(tokenFile, "exe_" + "a".repeat(48));
  const calls = [];
  const send = async (_base, _tok, method, path, body) => {
    calls.push({ method, path, body });
    for (const [re, fn] of routes) if (re.test(`${method} ${path}`)) return fn(body);
    return { status: 404, body: { error: "没有这个端点" } };
  };
  const h = createExecBridge({ url: "http://127.0.0.1:1/", tokenFile, line: "ext", send, pollMs: 5 });
  let id = 1;
  const call = async (name, a) => (await h({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: a } })).result.structuredContent;
  const init = async () => { await h({ jsonrpc: "2.0", id: id++, method: "initialize", params: INIT }); };
  return { call, init, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const CARD = { id: 7, subject: "s", status: "in_progress", line: "ext", released: 1, aggregate_version: 3, run_id: "r1", worker: "ext" };

test("J3.7 新桥对旧看板:ack / usage / where_hint 明示不支持;report_pool 404 / 403 / 405 → UNSUPPORTED_BY_BOARD;支持时正文形照 J2.2", async () => {
  const old = fakeBridge([
    [/^GET \/api\/coord$/, () => ({ status: 200, body: {} })],
    [/^GET \/api\/tasks\/7(?:\?peek=1)?$/, () => ({ status: 200, body: { task: CARD } })],
    [/^POST \/api\/tasks\/7\/heartbeat$/, () => ({ status: 200, body: { task: CARD, superseded: { by: 9 } } })],
    [/^POST \/api\/tasks\/7\/report$/, () => ({ status: 200, body: { task: { ...CARD, status: "waiting", waiting_for: "decision" } } })],
    [/^POST \/api\/pools\/reading$/, () => ({ status: 403, body: { error: "executor 令牌无权执行此操作" } })],
  ]);
  try {
    await old.init();
    const h = await old.call("heartbeat", { id: 7, ack: ["superseded"] });
    assert.match(h.ack_unsupported, /看板版本不支持/);
    assert.deepEqual(h.notices, ["superseded"], "旧看板给的提示照样交给模型");
    assert.deepEqual(old.calls.find((c) => c.path.endsWith("/heartbeat")).body.ack, ["superseded"]);
    const a = await old.call("ask_operator", { id: 7, question: "q", where_hint: { app: "zcode" } });
    assert.match(a.where_hint_unsupported, /看板版本不支持/);
    const rep = old.calls.filter((c) => c.path.endsWith("/report")).at(-1).body;
    assert.deepEqual(rep.where_hint, { app: "zcode" }, "where_hint 在交回正文顶层(旧看板忽略这个键,不拒收整次交回)");
    assert.equal("ask" in rep, false, "只给 where_hint 时 ask 不带(旧看板 ask 不认识的键会 400)");
    const u = await old.call("report_result", { id: 7, outcome: "done", evidence: "e", usage: { in: 1 } });
    assert.equal(u.usage_recorded, null); assert.match(u.usage_note, /不回执/);
    const p = await old.call("report_pool", { pool: "claude", window: "5h", used_pct: 10 });
    assert.equal(p.code, "UNSUPPORTED_BY_BOARD"); assert.match(p.message, /看板版本不支持/);
  } finally { old.done(); }
  for (const status of [404, 405]) {
    const f = fakeBridge([[/^GET \/api\/coord$/, () => ({ status: 200, body: {} })], [/^POST \/api\/pools\/reading$/, () => ({ status, body: { error: "x" } })]]);
    try { await f.init(); assert.equal((await f.call("report_pool", { pool: "claude", window: "5h", used_pct: 10 })).code, "UNSUPPORTED_BY_BOARD", String(status)); }
    finally { f.done(); }
  }
  const neu = fakeBridge([
    [/^GET \/api\/coord$/, () => ({ status: 200, body: {} })],
    [/^POST \/api\/pools\/reading$/, (b) => ({ status: 201, body: { reading: { ...b, by: "executor", at: "2026-01-01T00:00:00.000Z" } } })],
    [/^POST \/api\/tasks\/7\/heartbeat$/, () => ({ status: 200, body: { task: CARD, acked: ["base_gone"] } })],
    [/^GET \/api\/tasks\/7(?:\?peek=1)?$/, () => ({ status: 200, body: { task: CARD } })],
    [/^POST \/api\/pools\/reading-bad$/, () => ({ status: 500, body: {} })],
  ]);
  try {
    await neu.init();
    const r = await neu.call("report_pool", { pool: "codex", window: "7d", used_pct: 62.5, resets_at: "2026-01-02T00:00:00Z", note: "设置页看到的" });
    assert.equal(r.reading.used_pct, 62.5);
    assert.deepEqual(neu.calls.find((c) => c.path === "/api/pools/reading").body, { pool: "codex", window: "7d", used_pct: 62.5, resets_at: "2026-01-02T00:00:00Z", note: "设置页看到的" });
    assert.deepEqual((await neu.call("heartbeat", { id: 7, ack: ["base_gone"] })).acked, ["base_gone"]);
    assert.equal("notices" in (await neu.call("heartbeat", { id: 7 })), false);
  } finally { neu.done(); }
});

test("单元:ack / where_hint 的校验与提示码集合", () => {
  const bad = (m) => Object.assign(new Error(m), { code: "BAD_INPUT" });
  assert.deepEqual(NOTICE_CODES, ["superseded", "basis_changed", "refs_stale", "base_gone"]);
  assert.equal(checkAck(undefined, bad), null);
  assert.deepEqual(checkAck(["refs_stale", "refs_stale", "base_gone"], bad), ["refs_stale", "base_gone"]);
  assert.throws(() => checkAck(["spec_changed"], bad), /只接受/);
  assert.throws(() => checkAck(new Array(5).fill("base_gone"), bad), /最多/);
  assert.deepEqual(noticesIn({ superseded: { by: 1 }, basis_changed: [], refs_stale: [{ card: 2 }], base_gone: null }), ["superseded", "refs_stale"]);
  assert.equal(checkWhereHint(undefined, bad), null);
  assert.equal(checkWhereHint({}, bad), null, "两项都空 = 没给");
  assert.deepEqual(checkWhereHint({ app: "other", host_label: "  " }, bad), { app: "other", host_label: null });
  assert.throws(() => checkWhereHint({ app: "x" }, bad), /只接受/);
  assert.throws(() => checkWhereHint({ host_label: 1 }, bad), /字符串/);
  assert.throws(() => checkWhereHint([], bad), /对象/);
});
