import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 批准接口:待批准事项、决定路由、远程入口与批准令牌。`node --test tests/approvaltest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer, connect } from "node:net";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// 不起服务、直接测 approvals.js 的用例用内存库。
const approvals = createRequire(import.meta.url)("../core/approvals.js");
const memdb = () => { const db = new DatabaseSync(":memory:"); approvals.migrate(db); return db; };
// 控制字符与双向控制符一律用码点拼出来,源码里不出现这些字符本身。
const cp = (...n) => String.fromCodePoint(...n);
const isUnsafeCp = (c) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
const hasUnsafe = (text) => [...String(text)].some((ch) => isUnsafeCp(ch.codePointAt(0)));
const freePort = async (host = "127.0.0.1") => {
  const l = createServer(); await new Promise((r) => l.listen(0, host, r));
  const port = l.address().port; await new Promise((r) => l.close(r)); return port;
};

/** 临时看板:配置额外键、数据目录里的预置文件、环境变量都可指定。 */
async function board({ config = {}, files = {}, env = {}, expectExit = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "approvaltest-")), repo = join(dir, "repo"), cfg = join(dir, "fleet.json");
  mkdirSync(repo);
  writeFileSync(cfg, JSON.stringify({ lines: [{ id: "alpha" }, { id: "ext", external: true }], roles: [], routes: ["default"], repo, ...config }));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: cfg, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: repo, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1",
           BOARD_RESTART_MODE: "exit", BOARD_DELIVERABLE_GATE: "off", ...env } });
  let logs = ""; const add = (v) => { logs = (logs + String(v)).slice(-20000); };
  child.stdout.on("data", add); child.stderr.on("data", add);
  let exitCode = null; const closed = new Promise((r) => child.once("close", (c) => { exitCode = c; r(); }));
  const base = `http://127.0.0.1:${port}`;
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  if (expectExit) { await Promise.race([closed, delay(15000)]); cleanup(); return { exitCode, logs }; }
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  const operator = readFileSync(join(dir, "board_token"), "utf8").trim();
  const register = async (id) => {
    const r = await api("POST", "/api/coord/executors", operator, { id, name: id, kind: "external" });
    assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.token;
  };
  const card = async (body) => {
    const r = await api("POST", "/api/tasks", operator, body);
    assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.task;
  };
  /** 执行者领卡再交付:outcome=done → 待验收,wait → 待裁定。 */
  const deliver = async (token, subject, outcome, evidence) => {
    const t = await card({ subject, line: "ext" });
    const got = await api("POST", `/api/tasks/${t.id}/claim`, token, { expected_version: t.aggregate_version });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const rep = await api("POST", `/api/tasks/${t.id}/report`, token, { run_id: got.body.task.run_id, outcome, evidence });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    return (await api("GET", `/api/tasks/${t.id}`, operator)).body.task;
  };
  const list = async (token = operator) => {
    const r = await api("GET", "/api/approvals", token); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.approvals;
  };
  const decide = (id, body, token = operator) => api("POST", `/api/approvals/${encodeURIComponent(id)}/decide`, token, body);
  const journal = async () => (await api("GET", "/api/coord/journal?limit=200", operator)).body.entries;
  const cli = (...argv) => {
    const r = spawnSync(HOST_ENV.PYTHON || "python", [join(ROOT, "cli", "board.py"), ...argv], { encoding: "utf8", windowsHide: true, cwd: dir, timeout: 60000,
      env: { ...HOST_ENV, BOARD_URL: base, BOARD_DATA_DIR: dir, BOARD_CONFIG: cfg, PYTHONIOENCODING: "utf-8" } });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const stop = async () => { child.kill(); await closed; cleanup(); };
  return { dir, base, port, api, operator, register, card, deliver, list, decide, journal, cli, stop, logs: () => logs };
}

const PROFILE = { config: { gated_subtree: ".", execution_profiles: [{ id: "claude-api", enabled: true, budget: { timeout_sec: 120, max_turns: 4, max_cost_usd: 0.5 } }] },
  files: { "worker_settings.json": { alpha: { rev: 0, desired_running: false,
    agents: [{ runtime: "claude", model: "claude-haiku-4-5", effort: "high", window: false, execution_profile_id: "claude-api" }] } } },
  env: { KANBAN_ANTHROPIC_API_KEY: "fixture-only", BOARD_COORD_OVERDUE_GRACE_MIN: "0" } };
const src = (client, device) => ({ client, ...(device ? { device } : {}) });

test("待批准事项:六类都列出来,决定路由回原有逻辑,版本冲突 409,同一项不能决定两次", { timeout: 120000 }, async () => {
  const B = await board(PROFILE);
  try {
    const ex = await B.register("agent-a");
    const delivered = await B.deliver(ex, "交付卡", "done", "改好了\n\n## 给人看的结果\n导出按钮修好了\n");
    const asked = await B.deliver(ex, "两种做法选一种", "wait", "两种做法都可以,请人来定");
    const held = await B.card({ subject: "按配置放行的卡", line: "alpha", execution_profile_id: "claude-api", model: "claude-haiku-4-5", effort: "high" });
    assert.equal(held.released, false);
    assert.equal((await B.api("POST", "/api/coord/locks", ex, { resource: "device:test-phone", minutes: 0.01, purpose: "界面回归" })).status, 201);
    const rq = await B.api("POST", "/api/approvals/request", ex, { action: "重启共享设备上的应用", risk: "high" });
    assert.equal(rq.status, 201, JSON.stringify(rq.body));
    assert.equal((await B.api("POST", "/api/approvals/request", B.operator, { action: "x", risk: "low" })).status, 403, "请求批准只属于执行者");
    assert.equal((await B.api("POST", "/api/approvals/request", ex, { action: "x", risk: "urgent" })).status, 400);
    await delay(1200);

    const items = await B.list();
    const by = Object.fromEntries(items.map((a) => [a.kind, a]));
    assert.deepEqual(Object.keys(by).sort(), ["decision", "delivery", "lock", "release", "request", "version"], JSON.stringify(items));
    for (const a of items) {
      for (const k of ["id", "kind", "summary", "detail_ref", "created_at", "expected_version", "actions"]) assert.ok(a[k] != null && a[k] !== "", `${a.kind}.${k}`);
      assert.equal(a.id.split(":").slice(2).join(":"), String(a.expected_version), "expected_version 与 id 的版本段一致");
    }
    assert.equal(by.delivery.id, `delivery:${delivered.id}:${delivered.aggregate_version}`);
    assert.equal(by.delivery.summary, delivered.result_summary, "优先用 result_summary");
    assert.equal(by.request.summary, "重启共享设备上的应用");
    assert.equal(by.request.risk, "high");
    assert.deepEqual(by.release.actions, ["approve", "reject"], by.release.blocked);
    assert.equal((await B.list(ex)).length, items.length, "执行者可读列表");

    // 交付卡:旧版本 409,执行者不能决定,正确版本通过,同一项再决定 409
    const bad = await B.decide(by.delivery.id, { decision: "approve", source: src("panel"), expected_version: by.delivery.expected_version - 1 });
    assert.equal(bad.status, 409, JSON.stringify(bad.body));
    assert.equal(bad.body.current.id, by.delivery.id);
    assert.equal((await B.decide(by.delivery.id, { decision: "approve", source: src("panel"), expected_version: by.delivery.expected_version }, ex)).status, 403);
    assert.equal((await B.decide(by.delivery.id, { decision: "approve", expected_version: by.delivery.expected_version })).status, 400, "source 必填");
    const ok = await B.decide(by.delivery.id, { decision: "approve", source: src("panel"), expected_version: by.delivery.expected_version });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.result.status, "done");
    assert.equal((await B.api("GET", `/api/tasks/${delivered.id}`, B.operator)).body.task.status, "done");
    const again = await B.decide(by.delivery.id, { decision: "approve", source: src("panel"), expected_version: by.delivery.expected_version });
    assert.equal(again.status, 409); assert.equal(again.body.decision.decision, "approve");
    // 卡片被别处改过:旧 id 落空,409 带当前项
    const stale = await B.api("POST", `/api/tasks/${asked.id}/update`, B.operator, { acceptance: "补一条验收", expected_version: asked.aggregate_version });
    assert.equal(stale.status, 200, JSON.stringify(stale.body));
    const moved = await B.decide(by.decision.id, { decision: "reject", source: src("cli"), expected_version: by.decision.expected_version });
    assert.equal(moved.status, 409); assert.notEqual(moved.body.current.id, by.decision.id);
    const rej = await B.decide(moved.body.current.id, { decision: "reject", source: src("cli"), expected_version: moved.body.current.expected_version });
    assert.equal(rej.status, 200, JSON.stringify(rej.body));
    assert.equal(rej.body.result.status, "not_started", "否决 = 原有 resolve reject:回到未开始");
    // 放行确认 → 原有 release 路(带执行配置摘要)
    const rel = await B.decide(by.release.id, { decision: "approve", source: src("panel"), expected_version: by.release.expected_version });
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    assert.equal((await B.api("GET", `/api/tasks/${held.id}`, B.operator)).body.task.released, true);
    // 逾期锁 → 原有强制释放(写理由、写流水)
    const lk = await B.decide(by.lock.id, { decision: "approve", note: "持有者已离开", source: src("panel"), expected_version: by.lock.expected_version });
    assert.equal(lk.status, 200, JSON.stringify(lk.body));
    const lock = (await B.api("GET", "/api/coord/locks?all=1", B.operator)).body.locks.find((l) => l.resource === "device:test-phone");
    assert.equal(lock.released_by, "operator"); assert.equal(lock.release_reason, "持有者已离开");
    // 执行者请求:拒绝只留记录,执行者按 id 查到结果
    assert.equal((await B.decide(by.request.id, { decision: "reject", note: "改天再做", source: src("panel"), expected_version: 1 })).status, 200);
    const seen = await B.api("GET", `/api/approvals/${encodeURIComponent(by.request.id)}`, ex);
    assert.equal(seen.status, 200); assert.equal(seen.body.approval, null); assert.equal(seen.body.decision.decision, "reject");
    assert.equal(seen.body.decision.note, "改天再做");
    // 版本确认 → 原有 bless(写 accepted_rev)
    const bl = await B.decide(by.version.id, { decision: "approve", source: src("panel"), expected_version: by.version.expected_version });
    assert.equal(bl.status, 200, JSON.stringify(bl.body));
    assert.equal(readFileSync(join(B.dir, "accepted_rev"), "utf8").trim(), by.version.expected_version);
    assert.deepEqual(await B.list(), [], "全部决定后列表为空");
    // 决定记录只追加
    const db = new DatabaseSync(join(B.dir, "board.db"));
    assert.throws(() => db.prepare("DELETE FROM approval_decisions").run(), /append-only/);
    assert.throws(() => db.prepare("UPDATE approval_requests SET risk='low'").run(), /append-only/);
    db.close();
  } finally { await B.stop(); }
});

/** 直接发 HTTP:可指定本端地址(127.0.0.x 回环别名模拟不同来源)。 */
const raw = (port, { method = "GET", path = "/api/approvals", token, headers = {}, body, local = "127.0.0.2", host = "127.0.0.2" } = {}) =>
  new Promise((ok, ko) => {
    const q = http.request({ host, port, path, method, localAddress: local, timeout: 8000,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers } },
      (r) => { let b = ""; r.setEncoding("utf8"); r.on("data", (c) => { b += c; });
               r.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} ok({ status: r.statusCode, body: j }); }); });
    q.on("error", ko); q.on("timeout", () => q.destroy(new Error("timeout")));
    if (body !== undefined) q.write(typeof body === "string" ? body : JSON.stringify(body));
    q.end();
  });
const refused = (port, host = "127.0.0.2") => new Promise((ok) => {
  const s = connect({ host, port }); s.once("connect", () => { s.destroy(); ok(false); }); s.once("error", () => ok(true));
});

test("远程入口:关闭时不监听;打开后只认白名单来源与批准令牌,越权路径与浏览器请求被拒,每次调用都审计", { timeout: 120000 }, async () => {
  const rport = await freePort("127.0.0.2");
  const off = await board({ config: { remote_access: { enabled: false, listen: [`127.0.0.2:${rport}`], allow_ips: ["127.0.0.2"] } } });
  try {
    assert.equal(await refused(rport), true, "关闭时不监听,写了 listen 也不读");
    assert.equal((await off.api("GET", "/api/approval-tokens", off.operator)).body.remote.enabled, false);
  } finally { await off.stop(); }
  const wild = await board({ config: { remote_access: { enabled: true, listen: [`0.0.0.0:${rport}`], allow_ips: ["127.0.0.2"] } }, expectExit: true });
  assert.equal(wild.exitCode, 1, wild.logs); assert.match(wild.logs, /通配地址/);

  const B = await board({ config: { remote_access: { enabled: true, listen: [`127.0.0.2:${rport}`], allow_ips: ["127.0.0.2/32"] } } });
  try {
    for (let i = 0; i < 50 && await refused(rport); i++) await delay(100);
    const ex = await B.register("agent-r");
    const made = await B.api("POST", "/api/approval-tokens", B.operator, { label: "phone" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const tok = made.body.token;
    assert.match(tok, /^apr_[0-9a-f]{48}$/);
    assert.equal((await B.api("POST", "/api/approval-tokens", ex, { label: "x" })).status, 403, "执行者不能生成批准令牌");
    const listed = await B.api("GET", "/api/approval-tokens", B.operator);
    assert.ok(!JSON.stringify(listed.body).includes(tok), "列表不含明文");
    assert.deepEqual(listed.body.remote.listening, [`127.0.0.2:${rport}`]);
    const db = new DatabaseSync(join(B.dir, "board.db"), { readOnly: true });
    assert.equal(db.prepare("SELECT token_hash FROM approval_tokens WHERE id=?").get(made.body.record.id).token_hash,
                 createHash("sha256").update(tok).digest("hex"), "库里只存哈希");
    db.close();
    assert.equal((await B.api("GET", "/api/approvals", tok)).status, 401, "本机接口不认批准令牌");

    assert.equal((await raw(rport, { token: tok, local: "127.0.0.3" })).status, 403, "不在白名单的来源被拒");
    assert.equal((await raw(rport, {})).status, 401);
    assert.equal((await raw(rport, { token: B.operator })).status, 401, "不接受操作员令牌");
    assert.equal((await raw(rport, { headers: { "X-Board-Token": B.operator } })).status, 401);
    assert.equal((await raw(rport, { token: ex })).status, 401, "不接受执行者令牌");
    const ls = await raw(rport, { token: tok });
    assert.equal(ls.status, 200, JSON.stringify(ls.body)); assert.ok(Array.isArray(ls.body.approvals));
    for (const [method, path] of [["GET", "/api/tasks"], ["GET", "/api/coord"], ["GET", "/api/approval-tokens"], ["GET", "/"],
                                  ["POST", "/api/tasks"], ["POST", "/api/approvals/request"], ["POST", "/api/setup/bless"]])
      assert.equal((await raw(rport, { token: tok, method, path, ...(method === "POST" ? { body: {} } : {}) })).status, 403, `${method} ${path}`);
    assert.equal((await raw(rport, { token: tok, headers: { Origin: "http://192.0.2.10" } })).status, 403, "跨源请求被拒");
    assert.equal((await raw(rport, { token: tok, headers: { "Sec-Fetch-Mode": "cors" } })).status, 403);
    const sm = await raw(rport, { token: tok, path: "/api/summary" });
    assert.equal(sm.status, 200);
    for (const k of ["board", "executors", "locks", "journal"]) assert.ok(k in sm.body, k);
    assert.ok(sm.body.executors.some((x) => x.id === "agent-r"));

    const rq = (await B.api("POST", "/api/approvals/request", ex, { action: "改共享端口", risk: "medium" })).body.request;
    const path = `/api/approvals/${encodeURIComponent(rq.approval_id)}/decide`;
    assert.equal((await raw(rport, { token: tok, method: "POST", path, body: { decision: "approve", source: { client: "phone-app" }, expected_version: 2 } })).status, 409, "版本不符 409");
    const d = await raw(rport, { token: tok, method: "POST", path, body: { decision: "approve", source: { client: "phone-app", device: "test-device" }, expected_version: 1 } });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.decision.via, "remote"); assert.equal(d.body.decision.ip, "127.0.0.2");
    assert.equal(d.body.decision.actor, `approval-token:${made.body.record.id}`);
    assert.deepEqual(d.body.decision.source, { client: "phone-app", device: "test-device" });
    assert.equal((await raw(rport, { token: tok, method: "POST", path, body: { decision: "reject", source: { client: "phone-app" }, expected_version: 1 } })).status, 409, "不能重复决定");
    const j = (await B.journal()).find((e) => e.kind === "approval.decided");
    assert.match(j.body, /来源 phone-app\/test-device,经 remote 127\.0\.0\.2/);

    assert.equal((await B.api("POST", `/api/approval-tokens/${made.body.record.id}/revoke`, B.operator, {})).status, 200);
    assert.equal((await raw(rport, { token: tok })).status, 401, "吊销后失效");
    const adb = new DatabaseSync(join(B.dir, "board.db"), { readOnly: true });
    const rows = adb.prepare("SELECT * FROM remote_audit ORDER BY id").all(); adb.close();
    assert.equal(rows.filter((r) => r.token_id === made.body.record.id).length, 12, `已认证的调用每次一行:${rows.length}`);
    assert.equal(rows.filter((r) => r.token_id == null && r.note === "auth").length, 1, "未认证的拒绝按来源与原因聚合");
    assert.ok(rows.some((r) => r.status === 403 && r.note === "ip" && r.ip === "127.0.0.3"));
    assert.ok(rows.some((r) => r.status === 403 && r.note === "browser"));
    assert.ok(rows.some((r) => r.status === 403 && r.note === "path" && r.path === "/api/tasks"));
    assert.ok(rows.some((r) => r.status === 200 && r.method === "POST" && r.token_id === made.body.record.id));
  } finally { await B.stop(); }
});

test("流水记下来源与操作者;board.py approvals / approval-token;面板按钮走同一个决定接口", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const ex = await B.register("agent-c");
    const tf = join(B.dir, "agent.tok"); writeFileSync(tf, ex + "\n");
    const ask = async (action) => (await B.api("POST", "/api/approvals/request", ex, { action, risk: "low" })).body.request.approval_id;
    const [r1, r2, r3] = [await ask("清理构建缓存"), await ask("换测试设备的系统语言"), await ask("重启共享端口上的服务")];
    let c = B.cli("approvals", "ls");
    assert.equal(c.code, 0, c.out);
    for (const id of [r1, r2, r3]) assert.ok(c.out.includes(id), c.out);
    assert.match(c.out, /清理构建缓存/);
    assert.notEqual(B.cli("approvals", "approve", r1, "--token-file", tf).code, 0, "执行者令牌不能决定");
    assert.equal((c = B.cli("approvals", "approve", r1)).code, 0, c.out);
    assert.match(c.out, new RegExp(`已批准 ${r1}`));
    const note = join(B.dir, "note.txt"); writeFileSync(note, "等这批测试跑完再换", "utf8");
    assert.equal((c = B.cli("approvals", "reject", r2, "--file", note, "--device", "desk-1")).code, 0, c.out);
    c = B.cli("approvals", "approve", r2);
    assert.notEqual(c.code, 0); assert.match(c.out, /409/);
    assert.equal((await B.decide(r3, { decision: "approve", source: src("panel"), expected_version: 1 })).status, 200);

    const decided = (await B.journal()).filter((e) => e.kind === "approval.decided");
    assert.equal(decided.length, 3);
    assert.ok(decided.every((e) => e.executor === "operator"));
    assert.match(decided[0].body, new RegExp(`^批准 ${r1}。操作者 operator,来源 cli,经 local`));
    assert.match(decided[1].body, new RegExp(`^拒绝 ${r2}。操作者 operator,来源 cli/desk-1,经 local`));
    assert.match(decided[2].body, /来源 panel,经 local/);
    const asked = (await B.journal()).filter((e) => e.kind === "approval.requested");
    assert.deepEqual(asked.map((e) => e.executor), ["agent-c", "agent-c", "agent-c"]);
    const recs = (await B.api("GET", "/api/approvals/decisions", B.operator)).body.decisions;
    const rec2 = recs.find((d) => d.approval_id === r2);
    assert.deepEqual(rec2.source, { client: "cli", device: "desk-1" });
    assert.equal(rec2.note, "等这批测试跑完再换"); assert.equal(rec2.via, "local"); assert.equal(rec2.journal_id, decided[1].id);

    const save = join(B.dir, "apr.tok");
    assert.equal((c = B.cli("approval-token", "create", "--label", "phone", "--save", save)).code, 0, c.out);
    const tok = readFileSync(save, "utf8").trim();
    assert.match(tok, /^apr_/); assert.ok(!c.out.includes(tok), "存文件时不在屏幕上显示令牌");
    assert.notEqual(B.cli("approval-token", "create", "--label", "x", "--token-file", tf).code, 0, "执行者不能生成批准令牌");
    assert.match((c = B.cli("approval-token", "ls")).out, /远程入口:已关闭[^]*#1\s+phone\s+有效/);
    assert.equal(B.cli("approval-token", "revoke", "1").code, 0);
    assert.match(B.cli("approval-token", "ls").out, /#1\s+phone\s+已吊销/);
    assert.notEqual(B.cli("approval-token", "revoke", "1").code, 0, "已吊销的再吊销 409");

    // 修复前已经入库、带终端转义的请求:列表接口与命令行输出里都不再有控制字符
    const ldb = new DatabaseSync(join(B.dir, "board.db")); ldb.exec("PRAGMA busy_timeout=5000");
    ldb.prepare("INSERT INTO approval_requests (executor, action, risk, created_at) VALUES (?,?,?,?)")
      .run("agent-c", "旧数据" + cp(0x1b) + "[1A" + cp(0x1b) + "[2K", "low", new Date().toISOString());
    ldb.close();
    assert.ok(!hasUnsafe(JSON.stringify((await B.list()).map((a) => [a.title, a.summary]))), "列表里的标题与摘要不带控制字符");
    c = B.cli("approvals", "ls");
    assert.ok(c.out.includes("旧数据") && !hasUnsafe(c.out.replace(/[\r\n]/g, "")), `命令行输出不带控制字符:${JSON.stringify(c.out)}`);

    // 面板:待你批准的按钮走同一个决定接口,来源记为 panel;渲染只用事项自带的字段
    const html = readFileSync(join(ROOT, "core", "panel.html"), "utf8");
    assert.ok(html.includes('await post(`/api/approvals/${encodeURIComponent(b.dataset.apv)}/decide`,'));
    assert.ok(html.includes('source: { client: "panel" }'));
    const a = html.indexOf("function renderApprovals(){"), z = html.indexOf("\n}\n", a) + 3;
    const box = { innerHTML: "" };
    const env = { document: { getElementById: () => box }, esc: (x) => String(x ?? "").replace(/[&<>"']/g, (ch) => "&#" + ch.charCodeAt(0) + ";"),
      copyLabel: (l, v, f) => Object.hasOwn(l, v) ? l[v] : f, localTime: (i) => i.slice(11, 16),
      APV_KIND: { request: "执行者请求" }, APV_RISK: { high: "高风险" } };
    const render = new Function(...Object.keys(env), "let approvalData;" + html.slice(a, z) +
      ";return (d) => { approvalData = d; renderApprovals(); return document.getElementById(\"approvals\").innerHTML; };")(...Object.values(env));
    const out = render({ approvals: [{ id: "request:9:1", kind: "request", title: "<x>", summary: "重启共享设备上的应用", risk: "high",
      created_at: new Date().toISOString(), expected_version: 1, actions: ["approve", "reject"], labels: { approve: "批准", reject: "拒绝" } }] });
    assert.match(out, /待你批准 1[^]*执行者请求 · 高风险[^]*data-apv="request:9:1" data-apv-decision="approve" data-apv-version="1">批准/);
    assert.ok(!out.includes("<x>"), "标题转义");
  } finally { await B.stop(); }
});

const remoteBoard = async (extra = {}) => {
  const rport = await freePort("127.0.0.2");
  const B = await board({ config: { remote_access: { enabled: true, listen: [`127.0.0.2:${rport}`], allow_ips: ["127.0.0.2/32"] } }, ...extra });
  for (let i = 0; i < 50 && await refused(rport); i++) await delay(100);
  const audit = () => { const db = new DatabaseSync(join(B.dir, "board.db"), { readOnly: true });
    try { return db.prepare("SELECT * FROM remote_audit ORDER BY id").all(); } finally { db.close(); } };
  return { B, rport, audit };
};

test("协作安全:远程入口对未认证就被拒的请求不逐条写审计,按来源与原因聚合并有总量上限", { timeout: 120000 }, async () => {
  const { B, rport, audit } = await remoteBoard({ env: { BOARD_REMOTE_AUDIT_WINDOW_MS: "3000" } });
  try {
    for (let i = 0; i < 30; i++) assert.equal((await raw(rport, { path: "/x" + "a".repeat(150), local: "127.0.0.3" })).status, 403);
    // 已认证的调用照旧一次一行
    const tok = (await B.api("POST", "/api/approval-tokens", B.operator, { label: "phone" })).body;
    for (let i = 0; i < 3; i++) assert.equal((await raw(rport, { token: tok.token })).status, 200);
    for (let i = 0; i < 30; i++) assert.equal((await raw(rport, { path: "/y" + i })).status, 401);
    let rows = audit();
    assert.ok(rows.filter((r) => r.ip === "127.0.0.3").length <= 2, `白名单外来源 30 次请求不应各写一行:${rows.filter((r) => r.ip === "127.0.0.3").length}`);
    const anon = rows.filter((r) => r.ip === "127.0.0.2" && r.token_id == null);
    assert.ok(anon.length <= 2, `无令牌 30 次请求不应各写一行:${anon.length}`);
    // 很多不同来源:每个窗口合计也有上限
    for (let i = 4; i < 94; i++) assert.equal((await raw(rport, { path: "/z", local: `127.0.0.${i}` })).status, 403);
    // 窗口结束后补汇总行:行数有界,次数一次不丢
    const counted = (list) => list.filter((r) => r.token_id == null)
      .reduce((n, r) => n + (/ \+(\d+)$/.test(r.note) ? Number(/ \+(\d+)$/.exec(r.note)[1]) : 1), 0);
    for (let i = 0; i < 60 && counted(rows = audit()) < 150; i++) await delay(250);
    assert.equal(counted(rows), 150, `汇总后次数应等于请求数:${JSON.stringify(rows.map((r) => [r.ip, r.note]))}`);
    assert.ok(rows.some((r) => r.ip === "127.0.0.3" && r.note === "ip +29"), "同一来源同一原因:第一条加一行汇总");
    assert.ok(rows.some((r) => r.ip === "*" && /^denied \+\d+$/.test(r.note)), "来源很多时超出上限的并成一行");
    assert.ok(rows.filter((r) => r.token_id == null).length < 90, `未认证请求的审计行数有上限:${rows.length}`);
    assert.equal(rows.filter((r) => r.token_id === tok.record.id && r.status === 200).length, 3, "已认证的调用每次一行");
  } finally { await B.stop(); }
});

test("协作安全:同一来源的失败请求不能把有效批准令牌锁在门外", { timeout: 120000 }, async () => {
  const { B, rport } = await remoteBoard();
  try {
    const tok = (await B.api("POST", "/api/approval-tokens", B.operator, { label: "phone" })).body.token;
    for (let i = 0; i < 12; i++) assert.equal((await raw(rport, { path: "/x" })).status, 401, "不带令牌的请求不计入失败次数");
    assert.equal((await raw(rport, { token: tok })).status, 200, "12 次无令牌请求之后,有效令牌照常");
    const bad = "apr_" + "0".repeat(48);
    for (let i = 0; i < 10; i++) assert.equal((await raw(rport, { token: bad })).status, 401);
    assert.equal((await raw(rport, { token: bad })).status, 429, "无效令牌失败满 10 次后被限流");
    assert.equal((await raw(rport, { token: tok })).status, 200, "有效令牌先认证,不受同一来源的失败计数影响");
    assert.equal((await raw(rport, { token: tok, path: "/api/summary" })).status, 200);
  } finally { await B.stop(); }
});

/** 裸 TCP 分两次写正文:第一段写到 cut 字节,隔一会儿再写剩下的。 */
const rawSplit = (port, { path, token, body, cut, local = "127.0.0.2", host = "127.0.0.2" }) => new Promise((ok, ko) => {
  const buf = Buffer.from(body, "utf8");
  const s = connect({ host, port, localAddress: local });
  let out = Buffer.alloc(0);
  s.on("data", (c) => { out = Buffer.concat([out, c]); });
  s.on("error", ko);
  s.on("close", () => { const text = out.toString("utf8"); const m = /^HTTP\/1\.1 (\d+)/.exec(text);
    const tail = text.slice(text.indexOf("\r\n\r\n") + 4);   // 响应可能是分块编码:取第一个 { 到最后一个 }
    let j = null; try { j = JSON.parse(tail.slice(tail.indexOf("{"), tail.lastIndexOf("}") + 1)); } catch {} ok({ status: m ? Number(m[1]) : 0, body: j }); });
  s.once("connect", async () => {
    s.setNoDelay(true);
    s.write(`POST ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${buf.length}\r\nConnection: close\r\n\r\n`);
    s.write(buf.subarray(0, cut));
    await delay(300);
    s.write(buf.subarray(cut));
  });
});

test("协作安全:远程决定的正文跨分片到达时,多字节字符不被改坏;4KB 上限按字节算", { timeout: 120000 }, async () => {
  const { B, rport } = await remoteBoard();
  try {
    const ex = await B.register("agent-u");
    const tok = (await B.api("POST", "/api/approval-tokens", B.operator, { label: "phone" })).body.token;
    const rq = (await B.api("POST", "/api/approvals/request", ex, { action: "换测试设备的系统语言", risk: "low" })).body.request;
    const note = "请先补上回归测试再送审";
    const body = JSON.stringify({ decision: "reject", note, source: { client: "phone-app" }, expected_version: 1 });
    const at = Buffer.from(body.slice(0, body.indexOf("补")), "utf8").length + 1;   // 切在「补」的 3 个字节中间
    const d = await rawSplit(rport, { path: `/api/approvals/${encodeURIComponent(rq.approval_id)}/decide`, token: tok, body, cut: at });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.decision.note, note, "跨分片的汉字原样写进决定记录");
    // 1500 个汉字 = 4500 字节 > 4KB:按字节拒绝(按字符数只有 1500 多,会被放过)
    const rq2 = (await B.api("POST", "/api/approvals/request", ex, { action: "第二个请求", risk: "low" })).body.request;
    const big = await raw(rport, { token: tok, method: "POST", path: `/api/approvals/${encodeURIComponent(rq2.approval_id)}/decide`,
      body: JSON.stringify({ decision: "reject", note: "字".repeat(400), pad: "字".repeat(1100), source: { client: "phone-app" }, expected_version: 1 }) });
    assert.equal(big.status, 400, `超过 4KB(字节)的正文应拒绝:${JSON.stringify(big.body)}`);
  } finally { await B.stop(); }
});

test("协作安全:只追加的批准表挡住 REPLACE(整行替换),重复决定仍是 409", () => {
  const db = memdb(), t0 = 1_800_000_000_000;
  const rq = approvals.addRequest(db, "agent-a", { action: "重启共享设备上的应用", risk: "high" }, t0);
  const rec = { approval_id: rq.approval_id, decision: "reject", note: "改天", actor: "operator", via: "local", source: { client: "cli", device: null } };
  approvals.recordDecision(db, rec, t0 + 1000);
  approvals.audit(db, { ip: "127.0.0.2", method: "GET", path: "/api/approvals", status: 200, tokenId: 1 }, t0);
  const tries = {
    "决定记录 INSERT OR REPLACE": () => db.prepare(`INSERT OR REPLACE INTO approval_decisions (approval_id,kind,object_id,version,decision,actor,via,client,at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(rq.approval_id, "request", "1", "1", "approve", "operator", "local", "cli", "2026-01-01T00:00:00.000Z"),
    "决定记录 REPLACE INTO": () => db.prepare(`REPLACE INTO approval_decisions (approval_id,kind,object_id,version,decision,actor,via,client,at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(rq.approval_id, "request", "1", "1", "approve", "operator", "local", "cli", "2026-01-01T00:00:00.000Z"),
    "批准请求 替换": () => db.prepare("INSERT OR REPLACE INTO approval_requests (id,executor,action,risk,created_at) VALUES (?,?,?,?,?)").run(rq.id, "agent-a", "别的动作", "low", rq.created_at),
    "远程审计 替换": () => db.prepare("INSERT OR REPLACE INTO remote_audit (id,at,ip,method,path,status) VALUES (1,?,?,?,?,?)").run("2026-01-01T00:00:00.000Z", "127.0.0.9", "GET", "/", 200),
  };
  for (const [what, run] of Object.entries(tries)) assert.throws(run, /append-only/, what);
  assert.equal(approvals.decisionOf(db, rq.approval_id).decision, "reject");
  assert.equal(approvals.getRequest(db, rq.id).action, "重启共享设备上的应用");
  assert.equal(approvals.listAudit(db)[0].ip, "127.0.0.2");
  assert.throws(() => approvals.recordDecision(db, { ...rec, decision: "approve" }, t0 + 2000), (e) => e.code === "CONFLICT", "同一项再决定仍按 409 报");
  // 正常追加不受影响
  assert.equal(approvals.addRequest(db, "agent-a", { action: "第二个请求", risk: "low" }, t0 + 3000).id, rq.id + 1);
  approvals.audit(db, { ip: "127.0.0.2", method: "GET", path: "/api/summary", status: 200, tokenId: 1 }, t0 + 4000);
  assert.equal(approvals.listAudit(db).length, 2);
});

test("协作安全:待批准事项的一行文字不带控制字符与双向覆盖符;执行者请求里直接拒绝", () => {
  const db = memdb(), ESC = cp(0x1b);
  const raw = "a" + ESC + "[1Ab" + cp(8) + "c" + cp(7) + "d" + cp(0x9b) + "e" + cp(0x202e) + "f" + cp(0x2066) + "g" + cp(0x2028) + "h" + cp(9) + "i" + cp(13, 10) + "j";
  const line = approvals.oneLine(raw);
  assert.ok(!hasUnsafe(line), `oneLine 留下了控制字符:${JSON.stringify(line)}`);
  assert.match(line, /^a.\[1Ab.c.d.e.f.g.h i j$/u, "可见文字与空白折叠照旧,控制字符换成可见的占位");
  for (const action of ["整理日志" + ESC + "[1A" + ESC + "[2K", "清缓存" + cp(0x9b) + "2J", "改名" + cp(0x202e) + "gnp.exe", "退格" + cp(8), "隔离" + cp(0x2067) + "x"])
    assert.throws(() => approvals.addRequest(db, "agent-a", { action, risk: "low" }), (e) => e.code === "BAD_INPUT", JSON.stringify(action));
  assert.equal(approvals.openRequests(db).length, 0, "被拒的请求没有入库");
  assert.equal(approvals.addRequest(db, "agent-a", { action: "重启" + cp(9) + "共享设备" + cp(10) + "上的" + cp(0x2028) + "应用", risk: "low" }).action, "重启 共享设备 上的 应用", "换行、制表符、行分隔符照旧折成空格");
});

test("协作安全:通配监听与 allow_ips 全开按解析后的地址判断,等价写法不能绕过", () => {
  const cfg = (extra) => approvals.parseRemoteConfig({ enabled: true, listen: ["127.0.0.2:47830"], allow_ips: ["127.0.0.2"], ...extra });
  for (const l of ["0.0.0.0:47830", "[::]:47830", "[::0]:47830", "[0:0:0:0:0:0:0:0]:47830", "[::0.0.0.0]:47830",
                   "[0:0:0:0:0:0:0.0.0.0]:47830", "[::ffff:0.0.0.0]:47830", "[::ffff:0:0]:47830", "[0:0:0:0:0:ffff:0:0]:47830"])
    assert.throws(() => cfg({ listen: [l] }), /通配地址/, `listen ${l} 应按通配地址拒绝`);
  assert.equal(cfg({ listen: ["[::0.0.0.0]:47830"], allow_wildcard_listen: true }).allow_wildcard_listen, true, "显式开关照旧放行");
  for (const l of ["127.0.0.2:47830", "[::1]:47830", "[::ffff:127.0.0.2]:47830", "100.64.0.10:47830"]) assert.equal(cfg({ listen: [l] }).enabled, true, l);
  for (const a of ["0.0.0.0/0", "::/0", "::ffff:0.0.0.0/96", "::ffff:0:0/96", "::/1", "::/80", "::ffff:0:0/95"])
    assert.throws(() => cfg({ allow_ips: [a] }), /不接受/, `allow_ips ${a} 放行全部 IPv4,应拒绝`);
  for (const a of ["192.0.2.0/28", "0.0.0.0/1", "::1", "2001:db8::/32", "::/96", "::ffff:192.0.2.0/124"]) assert.equal(cfg({ allow_ips: [a] }).enabled, true, a);
  const mapped = cfg({ allow_ips: ["::ffff:192.0.2.0/124"] });
  assert.deepEqual([mapped.allows("192.0.2.5"), mapped.allows("::ffff:192.0.2.5"), mapped.allows("192.0.2.77"), mapped.allows("8.8.8.8")], [true, true, false, false]);
});
