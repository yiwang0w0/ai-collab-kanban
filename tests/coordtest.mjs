import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 多执行者协作:执行者令牌、心跳、外部执行线。`node --test tests/coordtest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function board(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "coordtest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines: [{ id: "alpha" }, { id: "ext", external: true }], roles: [], routes: ["default"], repo: dir }));
  const l = createServer(); await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const port = l.address().port; await new Promise((r) => l.close(r));
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1",
           BOARD_RESTART_MODE: "exit", ...env } });
  let logs = ""; const add = (v) => { logs = (logs + String(v)).slice(-20000); };
  child.stdout.on("data", add); child.stderr.on("data", add);
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
  const register = async (id, kind = "external") => {
    const r = await api("POST", "/api/coord/executors", operator, { id, name: id, kind });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.token;
  };
  const card = async (subject, line = "alpha") => {
    const r = await api("POST", "/api/tasks", operator, { subject, line });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task;
  };
  const take = async (token, id, extra = {}) => {
    const t = (await api("GET", `/api/tasks/${id}`, operator)).body.task;
    return api("POST", `/api/tasks/${id}/claim`, token, { expected_version: t.aggregate_version, ...extra });
  };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, worker, register, card, take, stop, logs: () => logs };
}

test("执行者令牌:只存哈希、只显示一次,权限只到执行面", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const reg = await B.api("POST", "/api/coord/executors", B.operator, { id: "agent-a", name: "执行者甲", kind: "external" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const tok = reg.body.token;
    assert.match(tok, /^exe_[0-9a-f]{48}$/);
    const list = await B.api("GET", "/api/coord", tok);
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes(tok) && !JSON.stringify(list.body).includes("token_hash"));
    const db = new DatabaseSync(join(B.dir, "board.db"), { readOnly: true });
    const row = db.prepare("SELECT * FROM coord_executors WHERE id='agent-a'").get(); db.close();
    assert.equal(row.token_hash, createHash("sha256").update(tok).digest("hex"));
    assert.ok(!Object.values(row).includes(tok), "库里不存明文令牌");
    assert.equal((await B.api("POST", "/api/coord/executors", B.operator, { id: "agent-a" })).status, 409, "重复登记拒绝");
    assert.equal((await B.api("POST", "/api/coord/executors", B.worker, { id: "agent-z" })).status, 403, "worker 令牌不能登记");
    assert.equal((await B.api("POST", "/api/coord/executors", tok, { id: "agent-z" })).status, 403, "执行者不能登记");

    const t = await B.card("执行者领卡");
    assert.equal((await B.api("GET", "/api/tasks", tok)).status, 200, "执行者可读看板");
    const mismatch = await B.take(tok, t.id, { worker: "someone-else" });
    assert.equal(mismatch.status, 409, "worker 与令牌不一致拒绝");
    const got = await B.take(tok, t.id);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.task.worker, "agent-a");
    const v = got.body.task.aggregate_version;
    for (const [path, body] of [[`/api/tasks/${t.id}/resolve`, { verdict: "approve", expected_version: v }],
                                [`/api/tasks/${t.id}/release`, { released: false, expected_version: v }],
                                ["/api/workers/alpha/start", {}], ["/api/workers/alpha/stop", {}],
                                ["/api/workers/alpha/settings", {}], ["/api/setup/bless", {}],
                                ["/api/config/lines", { id: "zz" }], ["/api/tasks", { subject: "x" }]]) {
      const r = await B.api("POST", path, tok, body);
      assert.equal(r.status, 403, `${path} 应拒绝执行者:${r.status}`);
    }
    const rep = await B.api("POST", `/api/tasks/${t.id}/report`, tok, { run_id: got.body.task.run_id, outcome: "done", evidence: "交付说明" });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    assert.equal(rep.body.task.status, "waiting");
    const rot = await B.api("POST", "/api/coord/executors", B.operator, { id: "agent-a", rotate: true });
    assert.equal(rot.status, 200);
    assert.equal((await B.api("GET", "/api/coord", tok)).status, 401, "换发后旧令牌失效");
  } finally { await B.stop(); }
});

test("心跳续租:更新 last_seen,续执行者持有的卡,租约有上限", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const tok = await B.register("agent-b");
    const t = await B.card("续租卡");
    const got = await B.take(tok, t.id, { lease_minutes: 1 });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const before = got.body.task.lease_until;
    assert.ok(before - Date.now() < 70000, "领取时可指定较短租约");
    const hb = await B.api("POST", "/api/coord/heartbeat", tok, { lease_minutes: 100 });
    assert.equal(hb.status, 200, JSON.stringify(hb.body));
    assert.deepEqual(hb.body.renewed.map((x) => x.id), [t.id]);
    assert.ok(hb.body.renewed[0].lease_until - Date.now() > 99 * 60000, "续到 100 分钟");
    assert.ok(hb.body.executor.last_seen);
    const capped = await B.api("POST", "/api/coord/heartbeat", tok, { lease_minutes: 100000 });
    const left = capped.body.renewed[0].lease_until - Date.now();
    assert.ok(left <= 240 * 60000 + 2000 && left > 239 * 60000, `执行者租约上限 240 分钟:${left}`);
    assert.equal((await B.api("POST", "/api/coord/heartbeat", B.operator, {})).status, 403, "心跳需要执行者令牌");
    assert.equal((await B.api("POST", "/api/coord/heartbeat", tok, { task_id: 99999 })).status, 409, "不是自己的卡不续");
  } finally { await B.stop(); }
});

test("外部执行线:接口标出,看板拒绝启动", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const w = await B.api("GET", "/api/workers", B.operator);
    assert.equal(w.body.line_external.ext, true);
    assert.equal(w.body.workers.find((x) => x.line === "ext").external, true);
    assert.equal(w.body.workers.find((x) => x.line === "alpha").external, false);
    const st = await B.api("POST", "/api/workers/ext/start", B.operator, {});
    assert.equal(st.status, 409, JSON.stringify(st.body));
    const add = await B.api("POST", "/api/config/lines", B.operator, { id: "ext2", external: true });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.equal(add.body.line_external.ext2, true);
    assert.equal((await B.api("POST", "/api/config/lines", B.operator, { id: "ext3", external: "yes" })).status, 400);
  } finally { await B.stop(); }
});
