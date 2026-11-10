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
import { spawnSync } from "node:child_process";

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
  const cli = (...argv) => {
    const r = spawnSync(HOST_ENV.PYTHON || "python", [join(ROOT, "cli", "board.py"), ...argv], { encoding: "utf8", windowsHide: true, cwd: dir, timeout: 60000,
      env: { ...HOST_ENV, BOARD_URL: base, BOARD_DATA_DIR: dir, BOARD_CONFIG: config, PYTHONIOENCODING: "utf-8" } });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  return { dir, base, api, operator, worker, register, card, take, cli, stop, logs: () => logs };
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

test("各方状态:整份写入带 updated_at,超限拒绝且不截断", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const tok = await B.register("agent-c");
    const ok = await B.api("POST", "/api/coord/status", tok, { current: "整理接口", done: ["读完文档"], next: ["写测试", "提交"] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.status.updated_at);
    const long = "字".repeat(301);
    for (const body of [{ current: long }, { done: [long] }, { next: Array.from({ length: 21 }, (_, i) => "步骤" + i) }]) {
      const r = await B.api("POST", "/api/coord/status", tok, body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /上限/);
      assert.ok(r.body.limit > 0 && r.body.got > r.body.limit);
    }
    const ex = (await B.api("GET", "/api/coord", B.operator)).body.executors.find((x) => x.id === "agent-c");
    assert.deepEqual([ex.status.current, ex.status.done, ex.status.next], ["整理接口", ["读完文档"], ["写测试", "提交"]], "超限写入没有改动原状态");
    assert.equal((await B.api("POST", "/api/coord/status", B.operator, { current: "x" })).status, 403, "操作员不代写执行者状态");
  } finally { await B.stop(); }
});

test("资源锁:占用返回 409 带持有者,只有持有者能释放,操作员强制释放必须写理由", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const a = await B.register("agent-d"), b = await B.register("agent-e");
    const got = await B.api("POST", "/api/coord/locks", a, { resource: "device:test-phone", minutes: 20, purpose: "跑界面测试" });
    assert.equal(got.status, 201, JSON.stringify(got.body));
    assert.ok(Math.abs(Date.parse(got.body.lock.started_at) - Date.now()) < 5000, "开始时刻由服务端测");
    const clash = await B.api("POST", "/api/coord/locks", b, { resource: "device:test-phone", minutes: 5, purpose: "改设备配置" });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.holder.holder, "agent-d");
    assert.equal(clash.body.holder.purpose, "跑界面测试");
    assert.ok(clash.body.holder.expected_end);
    assert.equal((await B.api("POST", "/api/coord/locks/release", b, { resource: "device:test-phone" })).status, 403, "非持有者不能释放");
    assert.equal((await B.api("POST", "/api/coord/locks", B.operator, { resource: "build:apk", minutes: 5, purpose: "x" })).status, 403, "加锁需要执行者令牌");
    assert.equal((await B.api("POST", "/api/coord/locks/release", a, { resource: "device:test-phone" })).status, 200);
    assert.equal((await B.api("POST", "/api/coord/locks", b, { resource: "device:test-phone", minutes: 5, purpose: "改设备配置" })).status, 201, "释放后另一方可加锁");
    assert.equal((await B.api("POST", "/api/coord/locks/release", B.operator, { resource: "device:test-phone", force: true })).status, 400, "强制释放必须写理由");
    const forced = await B.api("POST", "/api/coord/locks/release", B.operator, { resource: "device:test-phone", force: true, reason: "持有者会话已结束" });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.equal(forced.body.lock.released_by, "operator");
    assert.equal(forced.body.lock.release_reason, "持有者会话已结束");
    const all = (await B.api("GET", "/api/coord/locks?all=1", a)).body.locks;
    assert.ok(all.some((l) => l.released_by === "operator" && l.release_reason === "持有者会话已结束"), "强制释放留有记录");
    const jr = (await B.api("GET", "/api/coord/journal?executor=operator", a)).body.entries;
    assert.ok(jr.some((e) => e.kind === "lock.force_release" && e.body.includes("持有者会话已结束")), "强制释放写入流水");
    assert.equal((await B.api("POST", "/api/coord/locks", a, { resource: "bad name", minutes: 5, purpose: "x" })).status, 400);
  } finally { await B.stop(); }
});

test("资源锁逾期:标出、只发一次通知、不自动释放", { timeout: 60000 }, async () => {
  const B = await board({ BOARD_COORD_OVERDUE_GRACE_MIN: "0", BOARD_REAP_MS: "200" });
  const ctl = new AbortController();
  try {
    const a = await B.register("agent-f");
    let sse = "";
    const ev = await fetch(B.base + "/api/events", { headers: { "X-Board-Token": B.operator }, signal: ctl.signal });
    const reading = (async () => { const rd = ev.body.getReader(); const dec = new TextDecoder();
      try { for (;;) { const { value, done } = await rd.read(); if (done) break; sse += dec.decode(value); } } catch {} })();
    assert.equal((await B.api("POST", "/api/coord/locks", a, { resource: "build:apk", minutes: 0.01, purpose: "打包" })).status, 201);
    await delay(2500);
    const held = (await B.api("GET", "/api/coord/locks", a)).body.locks;
    assert.equal(held.length, 1, "逾期不自动释放");
    assert.equal(held[0].overdue, true);
    assert.ok(held[0].overdue_notified_at);
    ctl.abort(); await reading;
    assert.equal(sse.split("coord.lock_overdue").length - 1, 1, "逾期通知只发一次");
  } finally { ctl.abort(); await B.stop(); }
});

test("事件流水:只追加,产物按格式校验,数据库层挡住改写与删除,可按 since/执行者/条数查", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const a = await B.register("agent-g"), b = await B.register("agent-h");
    const sha = "a".repeat(64);
    const e1 = await B.api("POST", "/api/coord/journal", a, { kind: "test.run", body: "界面测试通过",
      artifacts: [{ type: "sha256", value: sha.toUpperCase() }, { type: "commit", value: "abc1234" },
                  { type: "path", value: "out/report.txt" }, { type: "url", value: "https://example.com/run/1" }] });
    assert.equal(e1.status, 201, JSON.stringify(e1.body));
    assert.equal(e1.body.entry.artifacts[0].value, sha);
    assert.ok(Math.abs(Date.parse(e1.body.entry.at) - Date.now()) < 5000, "时刻由服务端测");
    for (const bad of [{ kind: "x", body: "y".repeat(301) }, { kind: "x", body: "y", artifacts: [{ type: "sha256", value: "abc" }] },
                       { kind: "x", body: "y", artifacts: [{ type: "commit", value: "xyz1234" }] },
                       { kind: "x", body: "y", artifacts: [{ type: "url", value: "ftp://h/x" }] },
                       { kind: "x", body: "y", artifacts: [{ type: "path", value: "a\nb" }] },
                       { kind: "x", body: "y", artifacts: [{ type: "file", value: "a" }] }])
      assert.equal((await B.api("POST", "/api/coord/journal", a, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    await B.api("POST", "/api/coord/journal", b, { kind: "note", body: "乙的第一条" });
    await B.api("POST", "/api/coord/journal", a, { kind: "note", body: "甲的第二条" });
    const all = (await B.api("GET", "/api/coord/journal", b)).body;
    assert.deepEqual(all.entries.map((x) => x.executor), ["agent-g", "agent-h", "agent-g"]);
    assert.deepEqual((await B.api("GET", `/api/coord/journal?since=${e1.body.entry.id}`, a)).body.entries.map((x) => x.body), ["乙的第一条", "甲的第二条"]);
    assert.deepEqual((await B.api("GET", "/api/coord/journal?executor=agent-g&limit=1", a)).body.entries.map((x) => x.body), ["甲的第二条"]);
    assert.equal((await B.api("POST", "/api/coord/journal", B.operator, { kind: "note", body: "x" })).status, 403);
    for (const m of ["PUT", "DELETE", "PATCH"]) assert.notEqual((await B.api(m, `/api/coord/journal`, a, {})).status, 200);
    const db = new DatabaseSync(join(B.dir, "board.db"));
    db.exec("PRAGMA busy_timeout=5000");
    assert.throws(() => db.prepare("UPDATE coord_journal SET body='改' WHERE id=?").run(e1.body.entry.id), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM coord_journal").run(), /append-only/);
    db.close();
    assert.equal((await B.api("GET", "/api/coord/journal", a)).body.entries[0].body, "界面测试通过");
  } finally { await B.stop(); }
});

test("交接包:显式 stop 只生成一份,列表整项保留或整项换成指针,下一个执行者 ack 一次", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const a = await B.register("agent-i"), b = await B.register("agent-j");
    const done = Array.from({ length: 10 }, (_, i) => String(i).repeat(300));
    const next = ["先核对设备配置", "再跑界面测试"];
    assert.equal((await B.api("POST", "/api/coord/status", a, { current: "完成界面回归", done, next })).status, 200);
    const j = (await B.api("POST", "/api/coord/journal", a, { kind: "note", body: "跑到一半" })).body.entry;
    assert.equal((await B.api("POST", "/api/coord/locks", a, { resource: "device:test-phone", minutes: 30, purpose: "回归" })).status, 201);
    const s1 = await B.api("POST", "/api/coord/stop", a, {});
    assert.equal(s1.status, 201, JSON.stringify(s1.body));
    const pkg = s1.body.handoff.package;
    assert.equal(pkg.goal, "完成界面回归");
    assert.deepEqual(pkg.next, next);
    const kept = pkg.done.filter((x) => typeof x === "string"), ptr = pkg.done.filter((x) => typeof x !== "string");
    assert.equal(pkg.done.length, 10);
    assert.ok(kept.length > 0 && ptr.length > 0);
    assert.deepEqual(kept, done.slice(10 - kept.length), "保留的是最近的整项,一字不改");
    assert.deepEqual(ptr.map((x) => x.see), done.slice(0, ptr.length).map((_, i) => `full_status.done[${i}]`));
    assert.deepEqual(pkg.journal.recent_ids, [j.id]);
    assert.deepEqual(pkg.locks.map((l) => l.resource), ["device:test-phone"]);
    const s2 = await B.api("POST", "/api/coord/stop", a, {});
    assert.equal(s2.status, 200);
    assert.equal(s2.body.created, false);
    assert.equal(s2.body.handoff.id, s1.body.handoff.id, "同一次停止只生成一份");
    const full = (await B.api("GET", `/api/coord/handoffs/${s1.body.handoff.id}`, b)).body.handoff;
    assert.deepEqual(full.full_status.done, done, "指针指向的整份状态完整保存");
    assert.equal((await B.api("GET", "/api/coord/handoffs?pending=1", b)).body.handoffs.length, 1);
    assert.equal((await B.api("POST", `/api/coord/handoffs/${s1.body.handoff.id}/ack`, B.operator, {})).status, 403);
    const ack = await B.api("POST", `/api/coord/handoffs/${s1.body.handoff.id}/ack`, b, {});
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    assert.equal(ack.body.handoff.ack.by, "agent-j");
    assert.equal((await B.api("POST", `/api/coord/handoffs/${s1.body.handoff.id}/ack`, b, {})).status, 409, "只确认一次");
    assert.equal((await B.api("GET", "/api/coord/handoffs?pending=1", b)).body.handoffs.length, 0);
    const db = new DatabaseSync(join(B.dir, "board.db"));
    db.exec("PRAGMA busy_timeout=5000");
    assert.throws(() => db.prepare("UPDATE coord_handoffs SET reason='x'").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM coord_handoff_acks").run(), /append-only/);
    db.close();
  } finally { await B.stop(); }
});

test("交接包:心跳超过 N 分钟自动生成,只生成一份;再次心跳后重新计", { timeout: 60000 }, async () => {
  const B = await board({ BOARD_COORD_STALE_MIN: "0.02", BOARD_REAP_MS: "200" });
  try {
    const a = await B.register("agent-k");
    await B.register("agent-never");
    assert.equal((await B.api("POST", "/api/coord/heartbeat", a, {})).status, 200);
    await delay(3000);
    let hs = (await B.api("GET", "/api/coord/handoffs", a)).body.handoffs;
    assert.deepEqual(hs.map((h) => [h.executor, h.reason, h.stop_seq]), [["agent-k", "heartbeat_stale", 1]], "从未心跳过的执行者不算中断");
    assert.equal((await B.api("POST", "/api/coord/heartbeat", a, {})).status, 200);
    const ex = (await B.api("GET", "/api/coord", a)).body.executors.find((x) => x.id === "agent-k");
    assert.equal(ex.active, true, "再次心跳回到活动");
    await delay(3000);
    hs = (await B.api("GET", "/api/coord/handoffs", a)).body.handoffs;
    assert.deepEqual(hs.map((h) => h.stop_seq), [2, 1]);
  } finally { await B.stop(); }
});

test("board.py 协作子命令:--token-file 选执行者令牌,旧用法照常", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const ta = join(B.dir, "a.tok"), tb = join(B.dir, "b.tok"), body = join(B.dir, "body.txt"), why = join(B.dir, "why.txt");
    writeFileSync(body, "设备上的界面测试跑完", "utf8"); writeFileSync(why, "演练结束", "utf8");
    let r = B.cli("exec", "register", "cli-a", "--kind", "external", "--name", "agent-one", "--save", ta);
    assert.equal(r.code, 0, r.out);
    const tok = readFileSync(ta, "utf8").trim();
    assert.match(tok, /^exe_/); assert.ok(!r.out.includes(tok), "存文件时不在屏幕上显示令牌");
    assert.equal(B.cli("exec", "register", "cli-b", "--save", tb).code, 0);
    assert.equal((r = B.cli("lock", "acquire", "device:test-phone", "--minutes", "10", "--purpose", "ui-test", "--token-file", ta)).code, 0, r.out);
    r = B.cli("lock", "acquire", "device:test-phone", "--minutes", "5", "--purpose", "reconfig", "--token-file", tb);
    assert.notEqual(r.code, 0); assert.match(r.out, /409.*cli-a.*ui-test/);
    assert.equal((r = B.cli("journal", "add", "--kind", "test.run", "--file", body, "--artifact", "commit:abc1234", "--artifact", "path:out/r.txt", "--token-file", ta)).code, 0, r.out);
    assert.notEqual(B.cli("journal", "add", "--kind", "x", "--file", body, "--artifact", "sha256:zz", "--token-file", ta).code, 0);
    assert.match(B.cli("journal", "ls", "--executor", "cli-a", "--token-file", tb).out, /设备上的界面测试跑完.*commit:abc1234/);
    const t = await B.card("命令行领卡");
    r = B.cli("take", String(t.id), "--version", String(t.aggregate_version), "--lease", "45", "--token-file", ta);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /已领 #/);
    assert.match((r = B.cli("exec", "heartbeat", "--lease", "60", "--token-file", ta)).out, new RegExp(`续租 1 张 #${t.id}`), r.out);
    writeFileSync(join(B.dir, "st.json"), JSON.stringify({ current: "回归", done: ["装包"], next: ["跑测试"] }), "utf8");
    assert.equal((r = B.cli("exec", "status", "--file", join(B.dir, "st.json"), "--token-file", ta)).code, 0, r.out);
    assert.match(B.cli("exec", "status").out, /cli-a.*回归.*跑测试/);
    r = B.cli("exec", "stop", "--token-file", ta);
    assert.equal(r.code, 0, r.out);
    const hid = r.out.match(/交接记录 #(\d+)/)[1];
    assert.match(B.cli("handoff", "ls", "--token-file", tb).out, new RegExp(`#${hid}.*cli-a.*回归`));
    assert.equal((r = B.cli("handoff", "ack", hid, "--token-file", tb)).code, 0, r.out);
    assert.notEqual(B.cli("lock", "release", "device:test-phone", "--token-file", tb).code, 0, "非持有者不能释放");
    assert.equal((r = B.cli("lock", "release", "device:test-phone", "--force", "--file", why)).code, 0, r.out);
    assert.match(B.cli("lock", "ls", "--all").out, /device:test-phone\s+已释放/);
    assert.equal(B.cli("ls").code, 0, "旧用法照常");
    assert.notEqual(B.cli("approve", String(t.id), "--version", "1", "--token-file", ta).code, 0, "执行者令牌不能裁定");
  } finally { await B.stop(); }
});

test("面板协作区:逾期锁与待接手交接标出,外部执行线不出启动按钮", () => {
  const src = readFileSync(join(ROOT, "core", "panel.html"), "utf8");
  assert.match(src, /data-toc="set-coord"/);
  assert.match(src, /fetch\("\/api\/coord"\)/);
  // 协作区改成用节点拼、字走 textContent(不再整段 innerHTML):这里核对每一行要显示的字,
  //   节点层面(逾期行的警示色、重画保护、强制释放)在 tests/panelcoordtest.mjs。守的语义不变:逾期锁与待接手的交接标出,执行者名不当 HTML。
  const a = src.indexOf("// ── coord-copy(pure;tests/panelcopytest.mjs)──"), b = src.indexOf("// ── /coord-copy ──", a);
  assert.ok(a > 0 && b > a);
  const V = new Function("copyLabel", src.slice(a, b) + ";return { coordExecView, coordLockView, coordHandoffView };")((l, v, f) => Object.hasOwn(l, v) ? l[v] : f);
  const t = new Date().toISOString();
  const lock = V.coordLockView({ resource: "device:test-phone", holder: "a", holder_name: "甲", purpose: "回归", started_at: t, expected_end: t, overdue: true }, Date.now());
  assert.deepEqual([lock.state.tone, lock.state.label], ["warn", "逾期"]);
  const hand = V.coordHandoffView({ id: 3, executor: "a", reason: "heartbeat_stale", created_at: t, package: { goal: "回归", next: ["跑测试"] } });
  assert.deepEqual([hand.reason, hand.state.label], ["心跳中断", "待接手"]);
  const ex = V.coordExecView({ id: "a", name: "<甲>", kind: "external", active: false, last_seen: t, status: { current: "回归", next: ["跑测试"] } }, Date.now(), 20);
  assert.deepEqual([ex.name, ex.kind, ex.state.label], ["<甲>", "外部执行", "已停止"]);
  const draw = src.slice(src.indexOf("function renderCoord(){"), src.indexOf("function renderApprovals(){"));
  assert.ok(draw.includes('if (l.state.tone === "warn") row.dataset.tone = "warn";'), "逾期的锁行带警示色左边条");
  assert.ok(draw.includes('C.head.execs + (ext ? " · " + C.head.external + "：" + ext : "")'), "外部执行线写在执行者小标题里");
  assert.ok(!draw.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n").includes("innerHTML"), "执行者名按纯文本放,不拼 HTML");
  const rig = src.slice(src.indexOf("function renderRig(){"), src.indexOf("let MODELS = []"));
  assert.match(rig, /w\.external \? `<span class="wk-acts"><\/span><\/div>`/, "外部执行线不渲染齿轮与启动按钮");
});
