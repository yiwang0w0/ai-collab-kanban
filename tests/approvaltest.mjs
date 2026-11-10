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

const ROOT = fileURLToPath(new URL("../", import.meta.url));
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
    assert.ok(rows.length >= 18, `每次调用都审计:${rows.length}`);
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

    // 面板:待你批准的按钮走同一个决定接口,来源记为 panel;渲染只用事项自带的字段
    const html = readFileSync(join(ROOT, "core", "panel.html"), "utf8");
    assert.ok(html.includes('await post(`/api/approvals/${encodeURIComponent(b.dataset.apv)}/decide`,'));
    assert.ok(html.includes('source: { client: "panel" }'));
    // 这一块改成用节点拼、字走 textContent(不再整段 innerHTML):这里核对这一行要显示的字和按钮带的数据,
    //   节点层面(两押、备注、重画保护)在 tests/panelcoordtest.mjs。守的语义不变:只用事项自带的字段,标题不当 HTML。
    const a = html.indexOf("// ── coord-copy(pure;tests/panelcopytest.mjs)──"), z = html.indexOf("// ── /coord-copy ──", a);
    assert.ok(a > 0 && z > a);
    const view = new Function("copyLabel", html.slice(a, z) + ";return approvalRowView;")((l, v, f) => Object.hasOwn(l, v) ? l[v] : f);
    const row = view({ id: "request:9:1", kind: "request", title: "<x>", summary: "重启共享设备上的应用", risk: "high",
      created_at: new Date().toISOString(), expected_version: 1, actions: ["approve", "reject"], labels: { approve: "批准", reject: "拒绝" } });
    assert.deepEqual([row.id, row.kind, row.title, row.summary, row.version, row.actions.map((x) => [x.decision, x.label])],
      ["request:9:1", "执行者请求 · 高风险", "<x>", "重启共享设备上的应用", 1, [["approve", "批准"], ["reject", "拒绝"]]]);
    const draw = html.slice(html.indexOf("function renderApprovals(){"), html.indexOf("function renderApt(){"));
    assert.ok(draw.includes('C.head.approvals + " " + rows.length'), "小标题带件数");
    assert.ok(draw.includes("Object.assign(b.dataset, { apv: a.id, apvDecision: x.decision, apvVersion: String(a.version) });"), "按钮带事项 id、决定与版本");
    assert.ok(!draw.includes("innerHTML"), "标题按纯文本放,不拼 HTML");
  } finally { await B.stop(); }
});
