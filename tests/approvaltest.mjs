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
import { createServer } from "node:net";
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
