import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 凭码接入(core/connect.mjs):发码 / 兑换 / 重放 / 过期 / 未知码 / 错码延迟 / 回环判定 / 撤销 / 线绑定 / 四态 / 鉴权,
// 以及安全复审(11-11)各条:绑线严格化与读接口按线过滤(F1/F2)、撤销断 SSE 并放锁(F3/F8)、live_note 去重节流清洗(F4/F7)、
// 令牌文件缺省位置(F5)、错码闸门(F6)、建线推迟与待兑换上限(F9)、远程摘要(F13)、PowerShell 片段(P3)。
// 前半段是真看板 + HTTP;后半段用临时库和假时钟。`node --test tests/connecttest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { isLoopback, normalizeCode, createWrongCodeGate, openConnect, checkNote, cleanText, psQuote, defaultTokenDir,
         CODE_TTL_MS, PENDING_MAX } from "../core/connect.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const cp = (...c) => String.fromCodePoint(...c);
const CODE_SHAPE = /^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/;

// 进程内的单元测试共用一个临时数据目录(store.js 在加载时读 BOARD_DATA_DIR / BOARD_DB);每个测试开头清空,库是新的。
const UNIT = mkdtempSync(join(tmpdir(), "connectunit-"));
process.env.BOARD_DATA_DIR = UNIT; process.env.BOARD_DB = join(UNIT, "board.db");
process.on("exit", () => { try { rmSync(UNIT, { recursive: true, force: true }); } catch {} });
const requireCjs = createRequire(import.meta.url);
function unitDb() {
  for (const f of readdirSync(UNIT)) rmSync(join(UNIT, f), { recursive: true, force: true });
  const store = requireCjs("../core/store.js"), coord = requireCjs("../core/coord.js");
  const db = store.open(); coord.migrate(db);
  return { store, coord, db };
}
const freePort = async (host = "127.0.0.1") => {
  const l = createServer(); await new Promise((r) => l.listen(0, host, r));
  const port = l.address().port; await new Promise((r) => l.close(r)); return port;
};
async function board(extraEnv = {}, extraConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), "connecttest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines: [{ id: "alpha" }, { id: "ext", label: "外部", external: true }], roles: [], routes: ["default"], repo: dir, ...extraConfig }));
  const port = await freePort();
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
  /** 发码并兑换,返回 {id, line, token}。 */
  const connectAs = async (body) => {
    const c = await api("POST", "/api/connect/codes", operator, body);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await api("POST", "/api/connect/redeem", null, { code: c.body.code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: r.body.executor_id, line: r.body.line, token: r.body.token };
  };
  /** 打开一条 SSE,事件收进 events;服务端断开时 closed=true。 */
  const sse = async (token) => {
    const ac = new AbortController();
    const r = await fetch(base + "/api/events", { headers: { "X-Board-Token": token }, signal: ac.signal });
    const out = { status: r.status, events: [], closed: false, abort: () => ac.abort() };
    if (r.status !== 200) { try { await r.body?.cancel(); } catch {} out.closed = true; return out; }
    (async () => {
      const dec = new TextDecoder(); let buf = "";
      try {
        for await (const c of r.body) {
          buf += dec.decode(c, { stream: true }); let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const m = /^data: (.*)$/m.exec(frame); if (m) try { out.events.push(JSON.parse(m[1])); } catch {}
          }
        }
      } catch {}
      out.closed = true;
    })();
    return out;
  };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, port, api, operator, card, connectAs, sse, stop, log: () => log };
}
const ex = async (B, id) => (await B.api("GET", "/api/executors", B.operator)).body.executors.find((e) => e.id === id);
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await delay(50); } return !!(await fn()); };

test("发码、兑换、重放 410、未知码 404、撤销、线绑定、四态、鉴权", { timeout: 120000 }, async () => {
  const B = await board({ BOARD_COORD_STALE_MIN: "0.05", BOARD_CONNECT_WATCH_MS: "500" });
  try {
    // ── 角色:assistant 留着但现在拒绝;不认识的 kind 400
    assert.deepEqual([(await B.api("POST", "/api/connect/codes", B.operator, { kind: "claude", role: "assistant" })).body.code], ["ROLE_NOT_AVAILABLE"]);
    assert.equal((await B.api("POST", "/api/connect/codes", B.operator, { kind: "gpt" })).status, 400);
    assert.equal((await B.api("POST", "/api/connect/codes", B.operator, { kind: "zcode", line: "alpha" })).status, 409, "受管执行线不接码");

    // ── 不给 line:线名由 kind 派生、冲突加序号;线推迟到兑换成功时才建(F9)
    const c1 = await B.api("POST", "/api/connect/codes", B.operator, { kind: "zcode", label: "桌面 Zcode" });
    assert.equal(c1.status, 201, JSON.stringify(c1.body));
    assert.match(c1.body.code, CODE_SHAPE, "码长 10 位 XXXXX-XXXXX");
    assert.deepEqual([c1.body.line, c1.body.executor_id, c1.body.role], ["zcode", "zcode", "executor"]);
    assert.ok(Date.parse(c1.body.expires_at) - Date.now() > 9 * 60000);
    const zs = JSON.parse(c1.body.snippets.mcp_config).mcp.servers["fleet-board"];
    assert.equal(zs.protocolVersion, "legacy"); assert.ok(zs.args.includes("--code") && zs.args.includes(c1.body.code));
    assert.match(c1.body.snippets.prompt, /wait_for_card[\s\S]*get_card[\s\S]*claim_card[\s\S]*report_result/);
    assert.equal((await B.api("GET", "/api/workers", B.operator)).body.line_external.zcode, undefined, "没兑换前线还没建(F9)");
    const c2 = await B.api("POST", "/api/connect/codes", B.operator, { kind: "zcode" });
    assert.equal(c2.body.line, "zcode-2", "冲突加序号(待兑换的名字也占着)");
    const ids = [];
    for (const [kind, check] of [["claude", (s) => JSON.parse(s).mcpServers["fleet-board"].command],
                                 ["codex", (s) => /^\[mcp_servers\.fleet-board\]\ncommand = ".+"\nargs = \[/.test(s)],
                                 ["other", (s) => s.startsWith("& '") && s.includes("'--code'")]]) {
      const c = await B.api("POST", "/api/connect/codes", B.operator, { kind, line: "ext" });
      assert.equal(c.status, 201); assert.ok(check(c.body.snippets.mcp_config), kind);
      assert.equal(c.body.line, "ext"); ids.push(c.body.executor_id);
      // F5:令牌文件缺省不在看板数据目录里,在当前用户应用数据目录下的看板专用子目录
      const cfg = c.body.snippets.mcp_config.replace(/\\\\/g, "/").replace(/\\/g, "/");
      assert.ok(!cfg.toLowerCase().includes(B.dir.replace(/\\/g, "/").toLowerCase()), `${kind}:snippet 不含数据目录`);
      assert.match(cfg, /ai-fleet-board\/executors\/[0-9a-f]{8}\/ext(-\d)?\.token/, kind);
    }
    assert.deepEqual(ids, ["ext", "ext-2", "ext-3"], "接已有外部线:执行者 id 先用线名,再加序号");
    // F9:同时待兑换的码最多 5 个(c1、c2 与上面 3 个)
    const sixth = await B.api("POST", "/api/connect/codes", B.operator, { kind: "claude" });
    assert.deepEqual([sixth.status, sixth.body.code], [409, "TOO_MANY_PENDING_CODES"]);
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

    // ── 兑换:200 一次;重放 410 CODE_USED;小写、去连字符也认;兑换成功才建线
    const r1 = await B.api("POST", "/api/connect/redeem", null, { code: c1.body.code.toLowerCase().replace("-", "") });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.match(r1.body.token, /^exe_[0-9a-f]{48}$/);
    assert.deepEqual([r1.body.executor_id, r1.body.line, r1.body.role], ["zcode", "zcode", "executor"]);
    assert.equal((await B.api("GET", "/api/workers", B.operator)).body.line_external.zcode, true, "兑换成功后线已建且是外部执行线");
    const again = await B.api("POST", "/api/connect/redeem", null, { code: c1.body.code });
    assert.deepEqual([again.status, again.body.code], [410, "CODE_USED"]);
    assert.ok(!JSON.stringify(again.body).includes("exe_"), "重放拿不到令牌");
    const unknown = await B.api("POST", "/api/connect/redeem", null, { code: "ZZZZZ-ZZZZZ" });
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
    // ── 领卡 → working;心跳带 note → live_note(清洗后);过期不心跳 → stalled
    const cl = await B.api("POST", `/api/tasks/${mine.id}/claim`, zt, { expected_version: mine.aggregate_version });
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    const run = cl.body.task.run_id;
    assert.equal((await B.api("POST", `/api/tasks/${mine.id}/heartbeat`, zt, { run_id: run, note: "x".repeat(121) })).status, 400, "note 超 120 字");
    assert.equal((await B.api("POST", `/api/tasks/${mine.id}/heartbeat`, zt, { run_id: run, note: "读第二章\ny" })).status, 200, "换行被清成空格,不再拒");
    let t = (await B.api("GET", `/api/tasks/${mine.id}`, B.operator)).body.task;
    assert.equal(t.live_note, "读第二章 y");
    assert.equal((await B.api("POST", `/api/tasks/${mine.id}/heartbeat`, zt, { run_id: run, note: "正在读第二章" })).status, 200);
    t = (await B.api("GET", `/api/tasks/${mine.id}`, B.operator)).body.task;
    assert.equal(t.live_note, "正在读第二章"); assert.ok(t.live_note_at);
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

    // ── 错码(F6):不锁定。连错多少次,对的码照样立即成功;每个错码应答至少等 200ms
    const fresh = await B.api("POST", "/api/connect/codes", B.operator, { kind: "claude" });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    for (let i = 0; i < 6; i++) {
      const t0 = Date.now(), w = await B.api("POST", "/api/connect/redeem", null, { code: "22222-22222" });
      assert.equal(w.status, 404); assert.ok(Date.now() - t0 >= 180, "错码应答延迟 200ms");
    }
    // 同一时刻 25 个错码:至多 20 个在延迟,其余立即 429;其间对的码仍立即 200
    const burst = Array.from({ length: 25 }, () => B.api("POST", "/api/connect/redeem", null, { code: "33333-33333" }));
    await delay(50);
    const t0 = Date.now(), ok = await B.api("POST", "/api/connect/redeem", null, { code: fresh.body.code });
    assert.equal(ok.status, 200, "错码再多也不挡对的码"); assert.ok(Date.now() - t0 < 1000);
    const st = (await Promise.all(burst)).map((r) => r.status);
    assert.ok(st.filter((s) => s === 404).length <= 20 && st.filter((s) => s === 429).length >= 5, JSON.stringify(st));
    assert.ok(!B.log().includes(zt) && !B.log().includes(fresh.body.code), "日志里没有令牌和码");
  } finally { await B.stop(); }
});

test("绑线执行者(F1/F2):随手领不领未指定线的卡;读接口按线过滤;别人的 live_note 不给;令牌登记的执行者不变", { timeout: 90000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });          // 绑 ext
    const Y = await B.connectAs({ kind: "other", line: "ext" });          // 同线另一个(ext-2)
    const Z = await B.connectAs({ kind: "codex" });                       // 新线 codex
    assert.deepEqual([X.id, Y.id, Z.line], ["ext", "ext-2", "codex"]);
    const N = await B.card("没指定线的卡", null);
    // F1:随手领只领 line 恰好等于本线的卡
    const r0 = await B.api("POST", "/api/claim", X.token, {});
    assert.ok(r0.status === 204 || (r0.status === 200 && !r0.body?.task), `不该领到未指定线的卡:${r0.status} ${JSON.stringify(r0.body)}`);
    assert.equal((await B.api("GET", `/api/tasks/${N.id}`, B.operator)).body.task.status, "not_started");
    const E = await B.card("本线的卡", "ext"), O = await B.card("别的线的卡", "codex");
    const r1 = await B.api("POST", "/api/claim", X.token, {});
    assert.equal(r1.status, 200); assert.equal(r1.body.task.id, E.id, "本线的卡照常领得到");
    const oc = await B.api("POST", "/api/claim", Z.token, {});
    assert.equal(oc.body.task.id, O.id);
    assert.equal((await B.api("POST", `/api/tasks/${O.id}/heartbeat`, Z.token, { run_id: oc.body.task.run_id, note: "在改第二节" })).status, 200);
    assert.equal((await B.api("POST", `/api/tasks/${E.id}/heartbeat`, X.token, { run_id: r1.body.task.run_id, note: "在核对验收" })).status, 200);
    // F2:别的线、未指定线的卡与子资源一律 404;列表只给本线
    for (const path of [`/api/tasks/${O.id}`, `/api/tasks/${N.id}`, `/api/tasks/${O.id}/runs`, `/api/tasks/${O.id}/history`, `/api/tasks/${O.id}/related`,
                        `/api/tasks/${E.id}/related`, "/api/task-events", `/api/task-events?task_id=${O.id}`, "/api/events", "/api/workers", "/api/usage",
                        "/api/setup", "/api/meta", "/api/context", "/api/requests", "/api/pools", "/api/review/pending", "/api/approvals",
                        "/api/approvals/decisions", "/api/coord/locks", "/api/coord/journal", "/api/coord/executors"])
      assert.equal((await B.api("GET", path, X.token)).status, 404, `X GET ${path}`);
    const ls = (await B.api("GET", "/api/tasks?status=in_progress", X.token)).body;
    assert.deepEqual(ls.tasks.map((t) => t.id), [E.id], "列表只有本线"); assert.equal(ls.archived_count, undefined, "全板计数不给");
    assert.deepEqual((await B.api("GET", "/api/tasks?line=codex", X.token)).body.tasks, [], "问别的线 = 空表");
    assert.deepEqual((await B.api("GET", "/api/tasks?archived=all", X.token)).body.tasks.map((t) => t.id), [E.id]);
    assert.equal((await B.api("GET", `/api/tasks/${E.id}`, X.token)).body.task.live_note, "在核对验收", "持卡者看得到自己的 live_note");
    assert.equal((await B.api("GET", `/api/tasks/${E.id}/runs`, X.token)).status, 200);
    const yv = (await B.api("GET", `/api/tasks/${E.id}`, Y.token)).body.task;
    assert.deepEqual([yv.id, yv.live_note, yv.live_note_at], [E.id, null, null], "同线别人的 live_note 不给");
    assert.equal((await B.api("GET", "/api/tasks?status=in_progress", Y.token)).body.tasks[0].live_note, null);
    assert.equal((await B.api("GET", `/api/tasks/${O.id}`, B.operator)).body.task.live_note, "在改第二节", "操作员照常看得到");
    // /api/coord:只看到自己
    const co = (await B.api("GET", "/api/coord", X.token)).body;
    assert.deepEqual(co.executors.map((e) => e.id), ["ext"]); assert.deepEqual(co.external_lines, ["ext"]);
    assert.ok(co.journal.every((j) => j.executor === "ext"));
    // 自己发起的批准请求可以查,别人的不行
    const mineReq = (await B.api("POST", "/api/approvals/request", X.token, { action: "重启共享设备上的应用", risk: "low" })).body.request;
    const zReq = (await B.api("POST", "/api/approvals/request", Z.token, { action: "改端口", risk: "low" })).body.request;
    assert.equal((await B.api("GET", `/api/approvals/${mineReq.approval_id}`, X.token)).status, 200);
    assert.equal((await B.api("GET", `/api/approvals/${zReq.approval_id}`, X.token)).status, 404);
    // 令牌登记的执行者(不绑线)行为不变:读得到别的线、随手领照旧「本名线 或 未指定线」
    const tok = (await B.api("POST", "/api/coord/executors", B.operator, { id: "tok", name: "令牌登记", kind: "external" })).body.token;
    const tv = await B.api("GET", `/api/tasks/${O.id}`, tok);
    assert.deepEqual([tv.status, tv.body.task.live_note], [200, "在改第二节"]);
    assert.equal((await B.api("GET", "/api/task-events", tok)).status, 200);
    const tc = await B.api("POST", "/api/claim", tok, {});
    assert.equal(tc.body?.task?.id, N.id, "旧执行者照旧领得到未指定线的卡");
  } finally { await B.stop(); }
});

test("撤销(F3/F8):断开该执行者的 SSE、释放它的锁;面板会话退出 / 执行者注销与换发同样断开", { timeout: 90000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });
    assert.equal((await B.sse(X.token)).status, 404, "绑线执行者不给 SSE(桥是轮询)");
    assert.equal((await B.api("POST", "/api/coord/locks", X.token, { resource: "repo:main", purpose: "改主干", minutes: 30 })).status, 201);
    // 令牌登记的执行者:SSE 照给;撤销后服务端主动断开,之后的事件收不到
    const tok = (await B.api("POST", "/api/coord/executors", B.operator, { id: "tok", kind: "external" })).body.token;
    const s = await B.sse(tok); assert.equal(s.status, 200);
    const op = await B.sse(B.operator);
    await B.card("撤销前", "alpha");
    assert.ok(await until(() => s.events.some((e) => e.type === "task.created"), 3000), "撤销前收得到");
    assert.equal((await B.api("POST", "/api/executors/tok/revoke", B.operator, {})).status, 200);
    assert.ok(await until(() => s.closed, 1000), "撤销后 1 秒内连接被服务端关闭");
    const n = s.events.length;
    await B.card("撤销后", "alpha"); await delay(300);
    assert.equal(s.events.length, n, "撤销后的事件收不到");
    assert.equal(op.closed, false, "操作员的 SSE 不受影响");
    // F8:撤销放锁
    const rv = await B.api("POST", "/api/executors/ext/revoke", B.operator, {});
    assert.deepEqual(rv.body.released_locks, ["repo:main"]);
    const lock = (await B.api("GET", "/api/coord/locks?all=1", B.operator)).body.locks.find((l) => l.resource === "repo:main");
    assert.ok(lock.released_at, "撤销后锁已释放"); assert.equal(lock.release_reason, "执行者被撤销");
    assert.ok(await until(() => op.events.some((e) => e.type === "coord.lock" && e.op === "revoke_release"), 2000));
    // 注销 / 换发:旧令牌的 SSE 断开
    const t2 = (await B.api("POST", "/api/coord/executors", B.operator, { id: "tok2", kind: "external" })).body.token;
    const s2 = await B.sse(t2);
    assert.equal((await B.api("POST", "/api/coord/executors", B.operator, { id: "tok2", rotate: true })).status, 200);
    assert.ok(await until(() => s2.closed, 1000), "换发后旧令牌的 SSE 断开");
    const t3 = (await B.api("POST", "/api/coord/executors", B.operator, { id: "tok3", kind: "external" })).body.token;
    const s3 = await B.sse(t3);
    assert.equal((await B.api("DELETE", "/api/coord/executors/tok3", B.operator)).status, 200);
    assert.ok(await until(() => s3.closed, 1000), "注销后 SSE 断开");
    // 面板会话:退出连接后它的 SSE 断开
    const code = (await B.api("POST", "/api/pair/code", B.operator, {})).body.code;
    const panel = (await B.api("POST", "/api/pair", null, { code }, { Origin: B.base })).body.token;
    const ps = await B.sse(panel); assert.equal(ps.status, 200);
    assert.deepEqual((await B.api("POST", "/api/pair/revoke", panel, {})).body, { revoked: 1 });
    assert.ok(await until(() => ps.closed, 1000), "面板会话退出后 SSE 断开");
    assert.equal(op.closed, false);
    op.abort();
  } finally { await B.stop(); }
});

test("live_note(F4/F7):内容没变不推;同一张卡 5 秒内的变化合并成一次;清洗零宽、双向控制、路径与令牌样串;label 同样清洗", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext", label: "正常" + cp(0x200f, 0x200b) + "名字" });
    assert.equal((await ex(B, X.id)).label, "正常名字", "label 去掉零宽与双向控制符");
    const E = await B.card("卡", "ext");
    const cl = await B.api("POST", "/api/claim", X.token, {});
    const run = cl.body.task.run_id, op = await B.sse(B.operator);
    const notes = () => op.events.filter((e) => e.type === "task.live_note" && e.id === E.id).length;
    for (let i = 0; i < 10; i++) assert.equal((await B.api("POST", `/api/tasks/${E.id}/heartbeat`, X.token, { run_id: run, note: "同一句" })).status, 200);
    await delay(400);
    assert.equal(notes(), 1, "同 note 连发 10 次只推 1 个事件");
    for (const note of ["第二句", "第三句", "第四句"]) await B.api("POST", `/api/tasks/${E.id}/heartbeat`, X.token, { run_id: run, note });
    await delay(300);
    assert.equal(notes(), 1, "5 秒窗口内的变化先不推");
    assert.ok(await until(() => notes() === 2, 6000), "窗口末尾合并推一次");
    await delay(300); assert.equal(notes(), 2);
    assert.equal((await B.api("GET", `/api/tasks/${E.id}`, B.operator)).body.task.live_note, "第四句", "最后的内容落库");
    const dirty = "a" + cp(0x200f) + "b" + cp(0x61c) + "c" + cp(0xfeff) + "d" + cp(0x202e) + "e 改 C:\\Users\\you\\proj\\.env 令牌 exe_" + "a".repeat(48);
    assert.equal((await B.api("POST", `/api/tasks/${E.id}/heartbeat`, X.token, { run_id: run, note: dirty })).status, 200);
    const got = (await B.api("GET", `/api/tasks/${E.id}`, B.operator)).body.task.live_note;
    assert.ok(got.startsWith("abcde 改 …"), got); assert.ok(!/you|exe_|\.env/.test(got), got);
    op.abort();
  } finally { await B.stop(); }
});

test("远程摘要(F13):不带凭码接入的执行者明细与撤销记录", { timeout: 60000 }, async () => {
  const rport = await freePort("127.0.0.2");
  const B = await board({}, { remote_access: { enabled: true, listen: [`127.0.0.2:${rport}`], allow_ips: ["127.0.0.2/32"] } });
  try {
    const X = await B.connectAs({ kind: "zcode", label: "桌面某某" });
    await B.api("POST", "/api/coord/executors", B.operator, { id: "tok", kind: "external" });
    assert.equal((await B.api("POST", `/api/executors/${X.id}/revoke`, B.operator, {})).status, 200);
    const apr = (await B.api("POST", "/api/approval-tokens", B.operator, { label: "phone" })).body.token;
    const sm = await new Promise((ok, ko) => {
      const q = http.request({ host: "127.0.0.2", port: rport, path: "/api/summary", localAddress: "127.0.0.2", timeout: 8000,
        headers: { Authorization: `Bearer ${apr}` } }, (r) => { let b = ""; r.setEncoding("utf8"); r.on("data", (c) => { b += c; }); r.on("end", () => ok({ status: r.statusCode, body: JSON.parse(b) })); });
      q.on("error", ko); q.end();
    });
    assert.equal(sm.status, 200, JSON.stringify(sm.body));
    assert.deepEqual(sm.body.executors.map((e) => e.id), ["tok"], "令牌登记的照旧,凭码接入的不列");
    assert.equal(sm.body.code_executors, 1);
    assert.ok(!JSON.stringify(sm.body).includes("桌面某某") && !sm.body.journal.some((j) => j.kind === "executor.revoke"), "没有显示名和撤销记录");
  } finally { await B.stop(); }
});

test("回环判定、码的正规形、note 清洗、PowerShell 引号、令牌目录", () => {
  for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopback(a), true, a);
  for (const a of ["192.168.1.2", "10.0.0.1", "::ffff:10.0.0.1", "0.0.0.0", "", null, undefined, "::", "fe80::1", "128.0.0.1", "127.0.0.256", "localhost"])
    assert.equal(isLoopback(a), false, String(a));
  assert.equal(normalizeCode("abcde-fghjk"), "ABCDEFGHJK");
  assert.equal(normalizeCode("ab cd ef gh jk"), "ABCDEFGHJK");
  for (const c of ["ABCDE-FGHJ0", "ABCDE-FGHJI", "ABCD-EFGH", "ABCDE-FGHJKM", 1234567890, null, "A".repeat(40)]) assert.equal(normalizeCode(c), null, String(c));
  const bad = (m) => Object.assign(Error(m), { code: "BAD_INPUT" });
  assert.equal(checkNote("  在跑测试 ", bad), "在跑测试");
  assert.equal(checkNote(null, bad), "");
  assert.throws(() => checkNote(5, bad)); assert.throws(() => checkNote("字".repeat(121), bad));
  // F7:零宽 / LRM RLM ALM / BOM / 2060-2064 / 双向控制去掉;C0 C1 与行分隔符换空格
  for (const c of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x061c, 0xfeff, 0x2060, 0x2064, 0x202a, 0x202e, 0x2066, 0x2069])
    assert.equal(checkNote("a" + cp(c) + "b", bad), "ab", c.toString(16));
  for (const c of [0x0a, 0x0d, 0x1b, 0x7f, 0x9b, 0x2028, 0x2029]) assert.equal(checkNote("a" + cp(c) + "b", bad), "a b", c.toString(16));
  for (const [raw, leak] of [["在改 C:\\Users\\you\\My Documents\\私密 文件.txt 里", /you|私密|文件/], ["改 /c/Users/you/proj/.env", /you|\.env/],
                             ["令牌 exe_" + "0".repeat(48), /exe_/], ["github_pat_11ABCDEFG123456", /github_pat/], ["%USERPROFILE%\\.ssh\\id_rsa", /ssh|id_rsa/]]) {
    const out = cleanText(raw); assert.ok(!leak.test(out), `${raw} → ${out}`); assert.ok(out.includes("…"));
  }
  // P3:每个参数单引号字面量,单引号(含弯单引号)写两遍
  assert.equal(psQuote("a b&c%d!e^f"), "'a b&c%d!e^f'");
  assert.equal(psQuote("it's"), "'it''s'");
  assert.equal(psQuote("x" + cp(0x2019) + "y"), "'x" + cp(0x2019, 0x2019) + "y'");
  // F5:缺省令牌目录在应用数据目录下,不在数据目录里;不同数据目录不同子目录
  const w = defaultTokenDir("D:\\board-data", { env: { LOCALAPPDATA: "C:\\L" }, platform: "win32", home: "C:\\H" });
  assert.match(w, /^C:\\L[\\/]ai-fleet-board[\\/]executors[\\/][0-9a-f]{8}$/);
  assert.notEqual(w, defaultTokenDir("D:\\other", { env: { LOCALAPPDATA: "C:\\L" }, platform: "win32", home: "C:\\H" }));
});

test("P3:kind=other 的命令行片段贴进 PowerShell,路径里有 & ' % ! ^ 空格也不被切开", { skip: process.platform !== "win32", timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "connectps-")), odd = join(dir, "a&b'c %d! e^f");
  mkdirSync(odd);
  const bridge = join(odd, "argv.mjs");
  writeFileSync(bridge, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const { store, coord, db } = unitDb();
  try {
    const C = openConnect({ db, coord, store, hooks: { lineTaken: (id) => id === "ext", isExternalLine: (id) => id === "ext", managedName: () => false,
      snippetBase: () => ({ node: process.execPath, bridge, url: "http://127.0.0.1:1", tokenDir: join(odd, "tok&en") }) } });
    C.migrate();
    const r = C.issueCode({ kind: "other", line: "ext" });
    const cmd = r.body.snippets.mcp_config;
    const ps = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    assert.equal(ps.status, 0, ps.stderr);
    const argv = JSON.parse(ps.stdout.trim().split(/\r?\n/).pop());
    assert.deepEqual(argv, ["--url", "http://127.0.0.1:1", "--line", "ext", "--code", r.body.code, "--token-file", join(odd, "tok&en").replace(/\\/g, "/") + "/ext.token"]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("过期、建线推迟与回收、待兑换上限、错码闸门(临时库 + 假时钟)", async () => {
  const { store, coord, db } = unitDb();
  try {
    let now = Date.parse("2026-11-11T00:00:00Z");
    const clock = () => now, lines = new Set(["ext"]);
    let release = []; const sleep = () => new Promise((r) => release.push(r));   // 错码延迟由测试手动放行
    const gate = createWrongCodeGate({ max: 2, sleep });
    const C = openConnect({ db, coord, store, clock, gate,
      hooks: { lineTaken: (id) => lines.has(id), isExternalLine: (id) => lines.has(id), managedName: () => false,
               addExternalLine: (id) => lines.add(id), snippetBase: () => ({ node: "node", bridge: "b.mjs", url: "http://127.0.0.1:1", tokenDir: "d" }) } });
    C.migrate();
    const flush = async () => { await delay(0); const r = release; release = []; r.forEach((f) => f()); await delay(0); };
    // F9:不给 line 时线推迟到兑换;过期没兑换不留线,名字回收
    const a = C.issueCode({ kind: "codex" });
    assert.equal(a.body.line, "codex"); assert.ok(!lines.has("codex"), "发码时不建线");
    now += CODE_TTL_MS + 1;
    const pe = C.redeem(a.body.code); await flush();
    const exp = await pe;
    assert.deepEqual([exp.status, exp.body.code], [410, "CODE_EXPIRED"]);
    assert.ok(!lines.has("codex"), "过期没兑换不留线");
    const a2 = C.issueCode({ kind: "codex" });
    assert.equal(a2.body.executor_id, "codex", "过期没兑换的名字被回收,不变成 codex-2");
    assert.equal((await C.redeem(a2.body.code)).status, 200);
    assert.ok(lines.has("codex"), "兑换成功时才建线");
    assert.equal(C.lineOf("codex"), "codex");
    const b = C.issueCode({ kind: "other", line: "ext" });
    assert.equal(b.body.executor_id, "ext");
    now += CODE_TTL_MS - 1;
    assert.equal((await C.redeem(b.body.code)).status, 200, "有效期内最后一刻还能兑换");
    // 待兑换上限 5
    const pend = Array.from({ length: PENDING_MAX }, () => C.issueCode({ kind: "claude" }));
    assert.ok(pend.every((p) => p.status === 201));
    assert.deepEqual([C.issueCode({ kind: "claude" }).status], [409]);
    now += CODE_TTL_MS + 1;
    assert.equal(C.issueCode({ kind: "claude" }).status, 201, "过期后名额腾出");
    // F6:错码在闸门里等;名额(这里 2)满了立即 429;对的码不排队、不受影响
    const c = C.issueCode({ kind: "zcode" });
    const w1 = C.redeem("44444-44444"), w2 = C.redeem("55555-55555");
    await delay(0);
    assert.equal(gate.inflight, 2);
    const w3 = await C.redeem("66666-66666");
    assert.deepEqual([w3.status, w3.body.code], [429, "RATE_LIMITED"]);
    assert.equal((await C.redeem(c.body.code)).status, 200, "闸门满时对的码仍立即成功");
    await flush();
    assert.deepEqual([(await w1).status, (await w2).status], [404, 404]);
    assert.equal(gate.inflight, 0);
    for (let i = 0; i < 10; i++) { const p = C.redeem("77777-77777"); await flush(); assert.equal((await p).status, 404, "不锁定"); }
    const d = C.issueCode({ kind: "zcode" });
    assert.equal((await C.redeem(d.body.code)).status, 200, "连错之后对的码照样成功");
    // setNote 只在变化时返回 true
    assert.equal(C.setNote(1, "r1", "x"), true); assert.equal(C.setNote(1, "r1", "x"), false); assert.equal(C.setNote(1, "r2", "x"), true);
    assert.equal(C.setNote(1, "r2", ""), true); assert.equal(C.setNote(1, "r2", ""), false);
    // 库里只有码的哈希
    for (const r of db.prepare("SELECT code_hash FROM connect_codes").all()) assert.match(r.code_hash, /^[0-9a-f]{64}$/);
  } finally { db.close(); }
});

test("live_note 事件节流(假时钟外的真定时器,窗口缩短)", async () => {
  const { store, coord, db } = unitDb();
  try {
    const got = [];
    const C = openConnect({ db, coord, store, noteEmitMs: 300, emit: (type, d) => { if (type === "task.live_note") got.push(d.id); }, hooks: {} });
    C.migrate();
    C.noteChanged(7); C.noteChanged(7); C.noteChanged(7); C.noteChanged(8);
    assert.deepEqual(got, [7, 8], "各卡第一次立即推");
    await delay(100); C.noteChanged(7);
    assert.deepEqual(got, [7, 8], "窗口内不推");
    await delay(350);
    assert.deepEqual(got, [7, 8, 7], "窗口末尾合并推一次");
    await delay(400);
    assert.deepEqual(got, [7, 8, 7], "之后没有多余事件");
  } finally { db.close(); }
});
