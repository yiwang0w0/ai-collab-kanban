import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 执行者令牌的 MCP stdio 桥(cli/exec-mcp.mjs):真看板 + 真 stdio 子进程,不连接模型。`node --test tests/execmcptest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BRIDGE = join(ROOT, "cli", "exec-mcp.mjs");

async function board() {
  const dir = mkdtempSync(join(tmpdir(), "execmcptest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines: [{ id: "alpha" }, { id: "ext", label: "外部", external: true }], roles: [], routes: ["default"], repo: dir }));
  const l = createServer(); await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const port = l.address().port; await new Promise((r) => l.close(r));
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit" } });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { "X-Board-Token": token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const operator = readFileSync(join(dir, "board_token"), "utf8").trim();
  const card = async (subject, line) => {
    const r = await api("POST", "/api/tasks", operator, { subject, line, description: "卡面材料", acceptance: "三句话" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task;
  };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, card, stop };
}

/** 起一个桥子进程;call() 按 id 等应答。 */
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
const INIT = { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "zcode", version: "0.16.9" } };

test("桥:握手、只看本线、领卡、续租、交付都走执行者令牌", { timeout: 90000 }, async () => {
  const B = await board();
  try {
    const reg = await B.api("POST", "/api/coord/executors", B.operator, { id: "ext", name: "外部桌面", kind: "external" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const tokenFile = join(B.dir, "ext.token"); writeFileSync(tokenFile, reg.body.token + "\n");
    const mine = await B.card("本线的卡", "ext"), other = await B.card("别的线的卡", "alpha");
    const M = bridge(["--url", B.base, "--token-file", tokenFile, "--line", "ext"]);
    try {
      const init = await M.request("initialize", INIT);
      assert.equal(init.result.protocolVersion, "2025-11-25", "客户端要的版本不支持时回最新的已支持版本");
      assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
      M.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const list = await M.request("tools/list");
      assert.deepEqual(list.result.tools.map((t) => t.name), ["list_cards", "get_card", "claim_card", "heartbeat", "report_result"]);
      assert.ok(!("line" in list.result.tools[0].inputSchema.properties), "固定了 --line 就不给 line 参数");
      const ls = await M.call("list_cards", {});
      assert.equal(ls.isError, false, JSON.stringify(ls));
      assert.deepEqual(ls.structuredContent.cards.map((c) => c.id), [mine.id], "只列本线未开始的卡");
      const foreign = await M.call("get_card", { id: other.id });
      assert.equal(foreign.isError, true); assert.equal(foreign.structuredContent.code, "NOT_FOUND");
      const steal = await M.call("claim_card", { id: other.id, expected_version: other.aggregate_version });
      assert.equal(steal.isError, true, "别的线的卡领不走");
      assert.equal((await B.api("GET", `/api/tasks/${other.id}`, B.operator)).body.task.status, "not_started");
      const bad = await M.call("claim_card", { id: mine.id, expected_version: "1" });
      assert.equal(bad.structuredContent.code, "BAD_INPUT", "类型不对在桥里就拒");
      const card = (await M.call("get_card", { id: mine.id })).structuredContent.card;
      assert.equal(card.acceptance, "三句话");
      const claim = await M.call("claim_card", { id: mine.id, expected_version: card.aggregate_version });
      assert.equal(claim.isError, false, JSON.stringify(claim));
      assert.equal(claim.structuredContent.card.worker, "ext", "持有者是令牌认定的执行者");
      assert.equal((await M.call("heartbeat", { id: mine.id })).isError, false);
      const rep = await M.call("report_result", { id: mine.id, outcome: "done", evidence: "第一句。第二句。第三句。" });
      assert.equal(rep.isError, false, JSON.stringify(rep));
      const after = (await B.api("GET", `/api/tasks/${mine.id}`, B.operator)).body.task;
      assert.deepEqual([after.status, after.waiting_for, after.worker, after.result], ["waiting", "review", "ext", "第一句。第二句。第三句。"]);
      assert.equal((await M.call("report_result", { id: mine.id, outcome: "done", evidence: "再交一次" })).isError, true, "交过的卡不能再交");
      assert.ok(!M.stderr().includes(reg.body.token));
    } finally { await M.end(); }
    // 令牌失效(换发)后,新连接在握手阶段就失败
    assert.equal((await B.api("POST", "/api/coord/executors", B.operator, { id: "ext", rotate: true })).status, 200);
    const N = bridge(["--url", B.base, "--token-file", tokenFile]);
    try {
      const init = await N.request("initialize", INIT);
      assert.match(init.error?.message ?? "", /^UNAUTHENTICATED/, JSON.stringify(init));
    } finally { await N.end(); }
  } finally { await B.stop(); }
});

test("桥的启动参数:只接回环地址和 exe_ 执行者令牌,错误文案不带令牌", { timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "execmcpargs-"));
  try {
    const exe = join(dir, "exe.token"), op = join(dir, "op.token");
    writeFileSync(exe, "exe_" + "a".repeat(48) + "\n"); writeFileSync(op, "f".repeat(32) + "\n");
    const run = (...a) => spawnSync(process.execPath, [BRIDGE, ...a], { input: "", encoding: "utf8", windowsHide: true, env: HOST_ENV, timeout: 20000 });
    for (const url of ["http://example.com:47914", "http://127.0.0.1:47914/api", "https://127.0.0.1:47914"]) {
      const r = run("--url", url, "--token-file", exe);
      assert.equal(r.status, 1); assert.match(r.stderr, /BAD_ENDPOINT/, url);
    }
    const o = run("--url", "http://127.0.0.1:47914", "--token-file", op);
    assert.equal(o.status, 1); assert.match(o.stderr, /BAD_CREDENTIAL/); assert.ok(!o.stderr.includes("f".repeat(32)), "不回显令牌文件内容");
    const missing = run("--url", "http://127.0.0.1:47914", "--token-file", join(dir, "nope.token"));
    assert.equal(missing.status, 1); assert.match(missing.stderr, /BAD_CREDENTIAL/); assert.ok(!missing.stderr.includes(dir), "不回显路径");
    assert.equal(run("--url", "http://127.0.0.1:47914").status, 1, "缺 --token-file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
