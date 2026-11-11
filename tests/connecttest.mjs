import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 凭码接入(core/connect.mjs):发码 / 兑换 / 重放 / 过期 / 未知码 / 限流 / 回环判定 / 撤销 / 线绑定 / 四态 / 鉴权。
// 前半段是真看板 + HTTP;后半段用临时库和假时钟测过期与锁定时长。`node --test tests/connecttest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { isLoopback, normalizeCode, createLimiter, openConnect, checkNote, CODE_TTL_MS } from "../core/connect.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function board(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "connecttest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines: [{ id: "alpha" }, { id: "ext", label: "外部", external: true }], roles: [], routes: ["default"], repo: dir }));
  const l = createServer(); await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const port = l.address().port; await new Promise((r) => l.close(r));
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit", ...extraEnv } });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, token, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j, headers: r.headers };
  };
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const operator = readFileSync(join(dir, "board_token"), "utf8").trim();
  const card = async (subject, line) => {
    const r = await api("POST", "/api/tasks", operator, { subject, line, description: "卡面材料", acceptance: "三句话" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task;
  };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, port, api, operator, card, stop, log: () => log };
}
const ex = async (B, id) => (await B.api("GET", "/api/executors", B.operator)).body.executors.find((e) => e.id === id);

test("发码、兑换、重放 410、未知码 404、撤销、线绑定、四态、鉴权", { timeout: 120000 }, async () => {
  const B = await board({ BOARD_COORD_STALE_MIN: "0.05", BOARD_CONNECT_WATCH_MS: "500" });
  try {
    // ── 角色:assistant 留着但现在拒绝;不认识的 kind 400
    assert.deepEqual([(await B.api("POST", "/api/connect/codes", B.operator, { kind: "claude", role: "assistant" })).body.code], ["ROLE_NOT_AVAILABLE"]);
    assert.equal((await B.api("POST", "/api/connect/codes", B.operator, { kind: "gpt" })).status, 400);
    assert.equal((await B.api("POST", "/api/connect/codes", B.operator, { kind: "zcode", line: "alpha" })).status, 409, "受管执行线不接码");

    // ── 不给 line:新建外部线,id 由 kind 派生;冲突加序号;免重启
    const c1 = await B.api("POST", "/api/connect/codes", B.operator, { kind: "zcode", label: "桌面 Zcode" });
    assert.equal(c1.status, 201, JSON.stringify(c1.body));
    assert.match(c1.body.code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    assert.deepEqual([c1.body.line, c1.body.executor_id, c1.body.role], ["zcode", "zcode", "executor"]);
    assert.ok(Date.parse(c1.body.expires_at) - Date.now() > 9 * 60000);
    const zs = JSON.parse(c1.body.snippets.mcp_config).mcp.servers["fleet-board"];
    assert.equal(zs.protocolVersion, "legacy"); assert.ok(zs.args.includes("--code") && zs.args.includes(c1.body.code));
    assert.match(c1.body.snippets.prompt, /wait_for_card[\s\S]*get_card[\s\S]*claim_card[\s\S]*report_result/);
    const workers = (await B.api("GET", "/api/workers", B.operator)).body;
    assert.equal(workers.line_external.zcode, true, "新线已加上且是外部执行线");
    const c2 = await B.api("POST", "/api/connect/codes", B.operator, { kind: "zcode" });
    assert.equal(c2.body.line, "zcode-2", "冲突加序号");
    const ids = [];
    for (const [kind, check] of [["claude", (s) => JSON.parse(s).mcpServers["fleet-board"].command],
                                 ["codex", (s) => /^\[mcp_servers\.fleet-board\]\ncommand = ".+"\nargs = \[/.test(s)],
                                 ["other", (s) => s.includes("--code")]]) {
      const c = await B.api("POST", "/api/connect/codes", B.operator, { kind, line: "ext" });
      assert.equal(c.status, 201); assert.ok(check(c.body.snippets.mcp_config), kind);
      assert.equal(c.body.line, "ext"); ids.push(c.body.executor_id);
    }
    assert.deepEqual(ids, ["ext", "ext-2", "ext-3"], "接已有外部线:执行者 id 先用线名,再加序号");
    let e = await ex(B, "zcode");
    assert.deepEqual([e.state, e.pending_code, e.connected_via, e.online, e.kind, e.label], ["offline", true, "code", false, "zcode", "桌面 Zcode"]);

    // ── 其它身份令牌调这些接口 → 403;兑换要回环且无需凭据
    const reg = await B.api("POST", "/api/coord/executors", B.operator, { id: "tok", name: "令牌登记", kind: "external" });
    const tok = reg.body.token, review = readFileSync(join(B.dir, "review_token"), "utf8").trim(), worker = readFileSync(join(B.dir, "worker_token"), "utf8").trim();
    for (const t of [tok, review, worker]) {
      assert.equal((await B.api("POST", "/api/connect/codes", t, { kind: "claude" })).status, 403);
      assert.equal((await B.api("GET", "/api/executors", t)).status, 403);
      assert.equal((await B.api("POST", "/api/executors/zcode/revoke", t, {})).status, 403);
    }
    assert.equal((await B.api("GET", "/api/executors")).status, 401, "不带令牌 401");
    assert.equal((await B.api("POST", "/api/connect/redeem", null, { code: c1.body.code }, { Origin: "http://evil.example" })).status, 403, "跨来源页面不能兑换");

    // ── 兑换:200 一次;重放 410 CODE_USED;小写、去连字符也认
    const r1 = await B.api("POST", "/api/connect/redeem", null, { code: c1.body.code.toLowerCase().replace("-", "") });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.match(r1.body.token, /^exe_[0-9a-f]{48}$/);
    assert.deepEqual([r1.body.executor_id, r1.body.line, r1.body.role], ["zcode", "zcode", "executor"]);
    const again = await B.api("POST", "/api/connect/redeem", null, { code: c1.body.code });
    assert.deepEqual([again.status, again.body.code], [410, "CODE_USED"]);
    assert.ok(!JSON.stringify(again.body).includes("exe_"), "重放拿不到令牌");
    const unknown = await B.api("POST", "/api/connect/redeem", null, { code: "ZZZZ-ZZZZ" });
    assert.deepEqual([unknown.status, unknown.body.code], [404, "CODE_UNKNOWN"]);
    const zt = r1.body.token;
    { // 库里没有码或令牌明文
      const raw = readFileSync(join(B.dir, "board.db")).toString("latin1");
      assert.ok(!raw.includes(zt) && !raw.includes(c1.body.code.replace("-", "")), "库里只存哈希");
    }

    // ── 执行者请求更新 last_seen → idle;别的线的卡领不走
    const mine = await B.card("本线的卡", "zcode"), other = await B.card("别的线的卡", "ext");
    assert.equal((await B.api("GET", "/api/coord", zt)).status, 200);
    e = await ex(B, "zcode");
    assert.deepEqual([e.state, e.online, e.pending_code], ["idle", true, false]);
    assert.ok(e.last_seen_at);
    const steal = await B.api("POST", `/api/tasks/${other.id}/claim`, zt, { expected_version: other.aggregate_version });
    assert.equal(steal.status, 403, "别的线的卡领不走");
    assert.equal((await B.api("POST", "/api/claim", zt, { line: "ext" })).status, 403);
    // ── 领卡 → working;心跳带 note → live_note;过期不心跳 → stalled
    const cl = await B.api("POST", `/api/tasks/${mine.id}/claim`, zt, { expected_version: mine.aggregate_version });
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    const run = cl.body.task.run_id;
    assert.equal((await B.api("POST", `/api/tasks/${mine.id}/heartbeat`, zt, { run_id: run, note: "x".repeat(121) })).status, 400, "note 超 120 字");
    assert.equal((await B.api("POST", `/api/tasks/${mine.id}/heartbeat`, zt, { run_id: run, note: "读第二章\n" + "y" })).status, 400, "note 不能换行");
    assert.equal((await B.api("POST", `/api/tasks/${mine.id}/heartbeat`, zt, { run_id: run, note: "正在读第二章" })).status, 200);
    let t = (await B.api("GET", `/api/tasks/${mine.id}`, B.operator)).body.task;
    assert.equal(t.live_note, "正在读第二章"); assert.ok(t.live_note_at);
    { // 外部执行者这一轮心跳过 = 「已启动」(流转 step 3 的依据):看板记下了这个 run
      const ro = new DatabaseSync(join(B.dir, "board.db"), { readOnly: true });
      try { assert.deepEqual(ro.prepare("SELECT run_id, task_id FROM task_run_heartbeats").all().map((r) => ({ ...r })), [{ run_id: run, task_id: mine.id }]); }
      finally { ro.close(); }
    }
    await B.api("POST", `/api/tasks/${mine.id}/heartbeat`, zt, { run_id: run, note: "改第三章" });
    t = (await B.api("GET", `/api/tasks/${mine.id}`, B.operator)).body.task;
    assert.equal(t.live_note, "改第三章", "下一条覆盖上一条");
    e = await ex(B, "zcode");
    assert.equal(e.state, "working"); assert.deepEqual(e.holding, [{ id: mine.id, subject: "本线的卡" }]);
    await delay(3600);                 // 卡死判定 0.05 分钟 = 3 秒
    e = await ex(B, "zcode");
    assert.equal(e.state, "stalled", "有卡但心跳超时");
    // ── 交付清 live_note;last_report 有值
    assert.equal((await B.api("POST", `/api/tasks/${mine.id}/report`, zt, { run_id: run, outcome: "done", evidence: "一。二。三。" })).status, 200);
    t = (await B.api("GET", `/api/tasks/${mine.id}`, B.operator)).body.task;
    assert.deepEqual([t.live_note, t.live_note_at], [null, null], "交付后清空");
    e = await ex(B, "zcode");
    assert.deepEqual([e.last_report.task_id, e.last_report.outcome], [mine.id, "done"]);
    // 令牌登记的执行者:connected_via token,不绑线
    assert.equal((await ex(B, "tok")).connected_via, "token");

    // ── 撤销:令牌立即失效;手上的卡放回;未兑换的码作废
    const card2 = await B.card("第二张", "zcode");
    const cl2 = await B.api("POST", `/api/tasks/${card2.id}/claim`, zt, { expected_version: card2.aggregate_version });
    assert.equal(cl2.status, 200);
    await B.api("POST", `/api/tasks/${card2.id}/heartbeat`, zt, { run_id: cl2.body.task.run_id, note: "做到一半" });
    const rv = await B.api("POST", "/api/executors/zcode/revoke", B.operator, {});
    assert.equal(rv.status, 200); assert.equal(rv.body.revoked, true); assert.deepEqual(rv.body.released, [card2.id]);
    assert.equal((await B.api("GET", "/api/coord", zt)).status, 401, "撤销后令牌立即失效");
    t = (await B.api("GET", `/api/tasks/${card2.id}`, B.operator)).body.task;
    assert.deepEqual([t.status, t.worker, t.live_note], ["not_started", null, null]);
    e = await ex(B, "zcode");
    assert.deepEqual([e.revoked, e.state, e.online], [true, "offline", false]);
    const rv2 = await B.api("POST", "/api/executors/zcode-2/revoke", B.operator, {});
    assert.equal(rv2.status, 200);
    const voided = await B.api("POST", "/api/connect/redeem", null, { code: c2.body.code });
    assert.deepEqual([voided.status, voided.body.code], [410, "CODE_EXPIRED"], "撤销后未兑换的码作废");
    assert.equal((await B.api("POST", "/api/executors/nobody/revoke", B.operator, {})).status, 404);

    // ── 限流:同一来源再连错到 5 次 → 429,锁期内对的码也不行
    const fresh = await B.api("POST", "/api/connect/codes", B.operator, { kind: "claude" });
    let last;
    for (let i = 0; i < 5; i++) last = await B.api("POST", "/api/connect/redeem", null, { code: "2222-2222" });
    assert.equal(last.status, 429, "连错 5 次就锁(本测试前面已有 2 次失败:重放与未知码)");
    const locked = await B.api("POST", "/api/connect/redeem", null, { code: fresh.body.code });
    assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get("retry-after")) > 0);
    assert.ok(!B.log().includes(zt) && !B.log().includes(fresh.body.code), "日志里没有令牌和码");
  } finally { await B.stop(); }
});

test("回环判定、码的正规形、note 校验", () => {
  for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopback(a), true, a);
  for (const a of ["192.168.1.2", "10.0.0.1", "::ffff:10.0.0.1", "0.0.0.0", "", null, undefined, "::", "fe80::1", "128.0.0.1", "127.0.0.256", "localhost"])
    assert.equal(isLoopback(a), false, String(a));
  assert.equal(normalizeCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizeCode("ab cd ef gh"), "ABCDEFGH");
  for (const c of ["ABCD-EFG0", "ABCD-EFGI", "ABCD", 12345678, null, "A".repeat(40)]) assert.equal(normalizeCode(c), null, String(c));
  const bad = (m) => Object.assign(Error(m), { code: "BAD_INPUT" });
  assert.equal(checkNote("  在跑测试 ", bad), "在跑测试");
  assert.equal(checkNote(null, bad), "");
  assert.throws(() => checkNote("a" + String.fromCharCode(0x2028) + "b", bad)); assert.throws(() => checkNote(5, bad)); assert.throws(() => checkNote("字".repeat(121), bad));
});

test("过期与锁定时长(临时库 + 假时钟)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "connectunit-"));
  process.env.BOARD_DATA_DIR = dir; process.env.BOARD_DB = join(dir, "board.db");
  const require = createRequire(import.meta.url);
  const store = require("../core/store.js"), coord = require("../core/coord.js");
  const db = store.open();
  try {
    coord.migrate(db);
    let now = Date.parse("2026-11-11T00:00:00Z");
    const clock = () => now, lines = new Set(["ext"]);
    const C = openConnect({ db, coord, store, clock, limiter: createLimiter({ clock }),
      hooks: { lineTaken: (id) => lines.has(id), isExternalLine: (id) => lines.has(id), managedName: () => false,
               addExternalLine: (id) => lines.add(id), snippetBase: () => ({ node: "node", bridge: "b.mjs", url: "http://127.0.0.1:1", tokenDir: "d" }) } });
    C.migrate();
    const a = C.issueCode({ kind: "codex" });
    assert.equal(a.body.line, "codex"); assert.ok(lines.has("codex"));
    now += CODE_TTL_MS + 1;
    const exp = C.redeem(a.body.code, "127.0.0.1");
    assert.deepEqual([exp.status, exp.body.code], [410, "CODE_EXPIRED"]);
    const b = C.issueCode({ kind: "other", line: "ext" });
    assert.equal(b.body.executor_id, "ext");
    now += CODE_TTL_MS - 1;
    assert.equal(C.redeem(b.body.code, "127.0.0.1").status, 200, "有效期内最后一刻还能兑换");

    for (let i = 0; i < 5; i++) C.redeem("3333-3333", "127.0.0.1");   // 上面成功一次已清零;连错 5 次 → 锁 60 秒
    const c = C.issueCode({ kind: "claude" });
    assert.equal(C.redeem(c.body.code, "127.0.0.1").status, 429);
    assert.equal(C.redeem(c.body.code, "::1").status, 200, "按来源分开计数");
    const d = C.issueCode({ kind: "claude" });
    now += 59000; assert.equal(C.redeem(d.body.code, "127.0.0.1").status, 429);
    now += 1001; assert.equal(C.redeem(d.body.code, "127.0.0.1").status, 200, "锁 1 分钟后解开");
    // 库里只有码的哈希
    for (const r of db.prepare("SELECT code_hash FROM connect_codes").all()) assert.match(r.code_hash, /^[0-9a-f]{64}$/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
