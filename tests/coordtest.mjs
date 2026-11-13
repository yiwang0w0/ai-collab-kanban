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
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { freePort } from "./helpers/free-port.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// 不起服务、直接测 coord.js 的用例用内存库。
const coord = createRequire(import.meta.url)("../core/coord.js");
const memdb = () => { const db = new DatabaseSync(":memory:"); coord.migrate(db); return db; };
const badInput = (fn, what) => assert.throws(fn, (e) => e.code === "BAD_INPUT", what);
// 控制字符与双向控制符一律用码点拼出来,源码里不出现这些字符本身。
const cp = (...n) => String.fromCodePoint(...n);
const isUnsafeCp = (c) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
const hasUnsafe = (text) => [...String(text)].some((ch) => isUnsafeCp(ch.codePointAt(0)));

// fetch 拒绝浏览器「坏端口」表里的端口(6000、6665–6669、10080 等):随机端口撞上就重取,免得整套偶发红。
async function board(env = {}, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "coordtest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines: [{ id: "alpha" }, { id: "ext", external: true }], roles: [], routes: ["default"], repo: dir, ...extra }));
  const port = await freePort("127.0.0.1");
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
    assert.equal(rot.body.executor.name, "执行者甲", "换发令牌不改显示名");
    assert.equal((await B.api("POST", "/api/coord/executors", B.operator, { id: "agent-o", name: "乙", kind: "other" })).status, 201);
    const rot2 = await B.api("POST", "/api/coord/executors", B.operator, { id: "agent-o", rotate: true });
    assert.deepEqual([rot2.body.executor.name, rot2.body.executor.kind], ["乙", "other"], "换发令牌不改种类");
    const rot3 = await B.api("POST", "/api/coord/executors", B.operator, { id: "agent-o", rotate: true, name: "丙", kind: "external" });
    assert.deepEqual([rot3.body.executor.name, rot3.body.executor.kind], ["丙", "external"], "换发时明确给了才改");
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
    // F11 补充:加线接口的显示名与本地会话登记同一个清洗 —— 换行 / ESC / 双向控制 / 零宽去掉,不进配置文件与日志
    const cp = (...c) => String.fromCodePoint(...c);
    const dirty = await B.api("POST", "/api/config/lines", B.operator, { id: "ext4", external: true, label: "a" + cp(0x0a) + "FAKE" + cp(0x1b) + "[31m" + cp(0x202e, 0x200b) + "b" });
    assert.equal(dirty.status, 201, JSON.stringify(dirty.body));
    assert.equal(dirty.body.line.label, "a FAKE[31mb");
    const disk = JSON.parse(readFileSync(join(B.dir, "fleet.json"), "utf8")).lines.find((l) => l.id === "ext4");
    assert.equal(disk.label, "a FAKE[31mb");
    assert.ok(!B.logs().includes("\nFAKE"), "日志里没有被换行伪造出的独立行");
    assert.equal((await B.api("POST", "/api/config/lines", B.operator, { id: "ext5", external: true, label: "字".repeat(25) })).status, 400, "超长仍报错,不悄悄截断");
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

test("资源锁:锁表每条带 lock_id;释放带 lock_id / holder 时与当前记录比对,不一致 409 LOCK_CHANGED 且不释放", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const a = await B.register("agent-la"), b = await B.register("agent-lb");
    const first = (await B.api("POST", "/api/coord/locks", a, { resource: "device:lab-1", minutes: 20, purpose: "跑界面测试" })).body.lock;
    const listed = (await B.api("GET", "/api/coord/locks", B.operator)).body.locks;
    assert.deepEqual(listed.map((l) => [l.lock_id, l.id]), [[first.id, first.id]], "锁表每条带 lock_id,就是锁记录编号");
    const held = async () => (await B.api("GET", "/api/coord/locks", B.operator)).body.locks.find((l) => l.resource === "device:lab-1");
    // 面板看到的是 agent-la 那一次持有;之后换了人又加了锁:按旧编号或旧持有者强制释放都拒绝。
    assert.equal((await B.api("POST", "/api/coord/locks/release", a, { resource: "device:lab-1" })).status, 200);
    const second = (await B.api("POST", "/api/coord/locks", b, { resource: "device:lab-1", minutes: 20, purpose: "改设备配置" })).body.lock;
    assert.notEqual(second.lock_id, first.lock_id);
    for (const stale of [{ lock_id: first.lock_id }, { holder: "agent-la" }, { lock_id: second.lock_id, holder: "agent-la" }]) {
      const r = await B.api("POST", "/api/coord/locks/release", B.operator, { resource: "device:lab-1", force: true, reason: "持有者会话已结束", ...stale });
      assert.equal(r.status, 409, `${JSON.stringify(stale)} → ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "LOCK_CHANGED");
      assert.deepEqual([r.body.lock.lock_id, r.body.lock.holder], [second.lock_id, "agent-lb"], "应答带当前那条记录");
      assert.equal((await held())?.lock_id, second.lock_id, "不一致时不释放");
    }
    // 持有者自己释放也认这两个字段。
    assert.equal((await B.api("POST", "/api/coord/locks/release", b, { resource: "device:lab-1", lock_id: first.lock_id })).body.code, "LOCK_CHANGED");
    assert.equal((await B.api("POST", "/api/coord/locks/release", B.operator, { resource: "device:lab-1", force: true, reason: "x", lock_id: "abc" })).status, 400, "lock_id 不是正整数");
    assert.equal((await B.api("POST", "/api/coord/locks/release", B.operator, { resource: "device:lab-1", force: true, reason: "x", holder: 7 })).status, 400, "holder 不是字符串");
    const ok = await B.api("POST", "/api/coord/locks/release", B.operator,
      { resource: "device:lab-1", force: true, reason: "持有者会话已结束", lock_id: String(second.lock_id), holder: "agent-lb" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.lock.released_by, "operator");
    assert.equal(await held(), undefined);
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

test("协作安全:共享 worker 令牌不能冒用已登记执行者的 id 领卡、续租、交付", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const tok = await B.register("agent-s1");
    const t = await B.card("执行者的卡", "ext");
    const got = await B.take(tok, t.id);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const run = (await B.api("GET", `/api/tasks/${t.id}`, B.worker)).body.task.run_id;
    assert.ok(run, "run_id 对已认证角色可读,所以身份不能只靠它");
    const hb = await B.api("POST", `/api/tasks/${t.id}/heartbeat`, B.worker, { worker: "agent-s1", run_id: run });
    assert.equal(hb.status, 409, `worker 令牌冒名续租:${JSON.stringify(hb.body)}`);
    const rep = await B.api("POST", `/api/tasks/${t.id}/report`, B.worker, { worker: "agent-s1", run_id: run, outcome: "done", evidence: "伪造" });
    assert.equal(rep.status, 409, `worker 令牌冒名交付:${JSON.stringify(rep.body)}`);
    await B.card("外部线上的另一张", "ext");
    const cl = await B.api("POST", "/api/claim", B.worker, { worker: "agent-s1", line: "ext", worker_protocol_version: 2, agent_instance_id: randomUUID() });
    assert.equal(cl.status, 409, `worker 令牌冒名领卡:${JSON.stringify(cl.body)}`);
    const still = (await B.api("GET", `/api/tasks/${t.id}`, B.operator)).body.task;
    assert.deepEqual([still.status, still.worker], ["in_progress", "agent-s1"], "卡没有被冒名改动");
    const own = await B.api("POST", `/api/tasks/${t.id}/report`, tok, { run_id: run, outcome: "done", evidence: "执行者自己的交付" });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    // 纯数字的执行者 id:worker 写成数字,落库时同样会变成这个 id
    const num = await B.register("777");
    const t3 = await B.card("数字 id 的卡", "ext");
    const got3 = await B.take(num, t3.id);
    assert.equal(got3.status, 200, JSON.stringify(got3.body));
    const hb3 = await B.api("POST", `/api/tasks/${t3.id}/heartbeat`, B.worker, { worker: 777, run_id: got3.body.task.run_id });
    assert.equal(hb3.status, 409, `worker 写成数字也不能冒名:${JSON.stringify(hb3.body).slice(0, 120)}`);
  } finally { await B.stop(); }
});

test("协作安全:worker 只接受字符串或数字,数组、嵌套数组、布尔、null 写法不能绕过身份检查冒用执行者 id", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    // String() 之后这些写法都会变成一个合法的名字:["agent-s2"]、[["agent-s2"]] → agent-s2,true → "true",null → "null"。
    const toks = {}; for (const id of ["agent-s2", "true", "null"]) toks[id] = await B.register(id);
    for (const [id, worker] of [["agent-s2", ["agent-s2"]], ["agent-s2", [["agent-s2"]]], ["true", true], ["null", null]]) {
      const what = `worker 写成 ${JSON.stringify(worker)}`, brief = (r) => JSON.stringify(r.body).slice(0, 160);
      const t = await B.card(`${id} 的卡`, "ext");
      const got = await B.take(toks[id], t.id);
      assert.equal(got.status, 200, JSON.stringify(got.body));
      const run = got.body.task.run_id;
      const hb = await B.api("POST", `/api/tasks/${t.id}/heartbeat`, B.worker, { worker, run_id: run });
      assert.equal(hb.status, 400, `${what} 续租:${brief(hb)}`);
      const spare = await B.card(`${id} 线上的另一张`, "ext");
      const cl = await B.api("POST", "/api/claim", B.worker, { worker, line: "ext", worker_protocol_version: 2, agent_instance_id: randomUUID() });
      assert.equal(cl.status, 400, `${what} 领卡:${brief(cl)}`);
      const rep = await B.api("POST", `/api/tasks/${t.id}/report`, B.worker, { worker, run_id: run, outcome: "done", evidence: "伪造" });
      assert.equal(rep.status, 400, `${what} 交付:${brief(rep)}`);
      const still = (await B.api("GET", `/api/tasks/${t.id}`, B.operator)).body.task;
      assert.deepEqual([still.status, still.worker], ["in_progress", id], `${what}:卡没有被冒名改动`);
      const other = (await B.api("GET", `/api/tasks/${spare.id}`, B.operator)).body.task;
      assert.equal(other.status, "not_started", `${what}:另一张没有被冒名领走`);
      // 收掉这两张,下一种写法从干净的线开始
      assert.equal((await B.api("POST", `/api/tasks/${t.id}/report`, toks[id], { run_id: run, outcome: "done", evidence: "执行者自己的交付" })).status, 200);
      assert.equal((await B.take(toks[id], spare.id)).status, 200);
    }
    // 操作员与执行者令牌同样只接受字符串或数字
    const t9 = await B.card("类型检查", "ext");
    assert.equal((await B.take(B.operator, t9.id, { worker: ["agent-s2"] })).status, 400, "操作员令牌也不接受数组");
    assert.equal((await B.take(toks["agent-s2"], t9.id, { worker: { toString: "agent-s2" } })).status, 400, "执行者令牌也不接受对象");
    // 请求里没写 worker 时,落库比对用的名字是 "undefined":这个 id 不能登记;修复前已登记的也不能被这样冒用。
    assert.equal((await B.api("POST", "/api/coord/executors", B.operator, { id: "undefined" })).status, 400, "undefined 是保留名");
    const db = new DatabaseSync(join(B.dir, "board.db")); db.exec("PRAGMA busy_timeout=5000");
    const at = new Date().toISOString();
    db.prepare("INSERT INTO coord_executors (id,name,kind,token_hash,created_at,token_issued_at) VALUES (?,?,?,?,?,?)")
      .run("undefined", "undefined", "external", createHash("sha256").update("exe_" + "1".repeat(48)).digest("hex"), at, at);
    db.close();
    const held = await B.take(B.operator, t9.id, { worker: "undefined" });
    assert.equal(held.status, 200, JSON.stringify(held.body));
    const hbU = await B.api("POST", `/api/tasks/${t9.id}/heartbeat`, B.worker, { run_id: held.body.task.run_id });
    assert.equal(hbU.status, 409, `不写 worker 也不能冒用名为 undefined 的执行者:${JSON.stringify(hbU.body).slice(0, 160)}`);
    const repU = await B.api("POST", `/api/tasks/${t9.id}/report`, B.worker, { run_id: held.body.task.run_id, outcome: "done", evidence: "伪造" });
    assert.equal(repU.status, 409, `不写 worker 的交付:${JSON.stringify(repU.body).slice(0, 160)}`);
  } finally { await B.stop(); }
});

test("协作安全:执行者 id 不能与受管执行线的座位同名,同名的旧登记不能领卡续租交付", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const clash = await B.api("POST", "/api/coord/executors", B.operator, { id: "alpha", kind: "line" });
    assert.equal(clash.status, 409, `与受管线同名的登记应拒绝:${JSON.stringify(clash.body)}`);
    assert.equal((await B.api("POST", "/api/coord/executors", B.operator, { id: "ext", kind: "line" })).status, 201, "外部执行线没有受管座位,同名可以登记");
    await B.register("zeta");
    assert.equal((await B.api("POST", "/api/config/lines", B.operator, { id: "zeta" })).status, 409, "反方向:受管线不能与已登记执行者同名");
    assert.equal((await B.api("POST", "/api/config/lines", B.operator, { id: "zeta", external: true })).status, 201, "外部执行线可以与执行者同名");
    // 修复前已经同名的旧登记:直接写库造一行,它的令牌不能再以座位名义动卡。
    const legacy = "exe_" + "0".repeat(48);
    const db = new DatabaseSync(join(B.dir, "board.db"));
    db.exec("PRAGMA busy_timeout=5000");
    const at = new Date().toISOString();
    db.prepare("INSERT INTO coord_executors (id,name,kind,token_hash,created_at,token_issued_at) VALUES (?,?,?,?,?,?)")
      .run("alpha", "alpha", "line", createHash("sha256").update(legacy).digest("hex"), at, at);
    db.close();
    const t = await B.card("受管线上的卡");
    const held = await B.take(B.operator, t.id, { worker: "alpha" });
    assert.equal(held.status, 200, JSON.stringify(held.body));
    const run = held.body.task.run_id;
    assert.equal((await B.api("GET", "/api/coord", legacy)).status, 200, "旧令牌仍能读");
    const rep = await B.api("POST", `/api/tasks/${t.id}/report`, legacy, { run_id: run, outcome: "done", evidence: "伪造" });
    assert.equal(rep.status, 409, `同名执行者替座位交付:${JSON.stringify(rep.body).slice(0, 200)}`);
    assert.equal((await B.api("POST", "/api/coord/heartbeat", legacy, {})).status, 409, "同名执行者不能替座位批量续租");
    const t2 = await B.card("受管线上的另一张");
    assert.equal((await B.take(legacy, t2.id)).status, 409, "同名执行者不能以座位名领卡");
    const still = (await B.api("GET", `/api/tasks/${t.id}`, B.operator)).body.task;
    assert.equal(still.status, "in_progress");
  } finally { await B.stop(); }
});

test("协作安全:流水产物的 type 必须是字符串,数组与嵌套数组不能冒充合法类型", () => {
  const db = memdb(), sha = "a".repeat(64);
  coord.register(db, { id: "agent-t" });
  let deep = "sha256"; for (let i = 0; i < 50; i++) deep = [deep];
  for (const type of [["sha256"], [[["sha256"]]], deep, { toString: () => "sha256" }, 7, null])
    badInput(() => coord.appendJournal(db, "agent-t", { kind: "note", body: "x", artifacts: [{ type, value: sha }] }), JSON.stringify(type).slice(0, 40));
  badInput(() => coord.appendJournal(db, "agent-t", { kind: "note", body: "x", artifacts: [null] }), "产物项为 null");
  const ok = coord.appendJournal(db, "agent-t", { kind: "note", body: "x", artifacts: [{ type: "sha256", value: sha.toUpperCase() }] });
  assert.deepEqual(ok.artifacts, [{ type: "sha256", value: sha }]);
  assert.equal(coord.journal(db, {}).length, 1, "被拒的都没有入库");
});

test("协作安全:心跳中断生成交接包之后又写了状态与流水,再 stop 拿到的是新的交接包", () => {
  const db = memdb(), t0 = 1_800_000_000_000, min = 60000;
  coord.register(db, { id: "agent-w" });
  coord.touch(db, "agent-w", t0);
  coord.setStatus(db, "agent-w", { current: "开工:跑回归" }, t0 + min);
  coord.acquire(db, "agent-w", { resource: "device:test-phone", minutes: 60, purpose: "回归" }, t0 + 2 * min);
  const swept = coord.sweepStale(db, t0 + 21 * min, 20 * min);
  assert.deepEqual(swept.map((h) => [h.reason, h.stop_seq, h.package.goal]), [["heartbeat_stale", 1, "开工:跑回归"]]);
  const j = coord.appendJournal(db, "agent-w", { kind: "note", body: "回归跑完" }, t0 + 38 * min);
  coord.release(db, { role: "executor", id: "agent-w" }, { resource: "device:test-phone" }, t0 + 38.5 * min);
  coord.setStatus(db, "agent-w", { current: "收尾完成", done: ["回归全绿", "报告已提交"] }, t0 + 39 * min);
  const s = coord.stop(db, "agent-w", "stop", t0 + 40 * min);
  assert.equal(s.created, true, "中断之后写过最终状态:这次 stop 重新生成");
  assert.deepEqual([s.handoff.reason, s.handoff.stop_seq, s.handoff.package.goal], ["stop", 2, "收尾完成"]);
  assert.deepEqual(s.handoff.package.done, ["回归全绿", "报告已提交"]);
  assert.deepEqual(s.handoff.package.journal.recent_ids, [j.id]);
  assert.deepEqual(s.handoff.package.locks, [], "已释放的锁不再出现在交接包里");
  assert.deepEqual(coord.getHandoff(db, s.handoff.id).full_status.done, ["回归全绿", "报告已提交"]);
  const again = coord.stop(db, "agent-w", "stop", t0 + 41 * min);
  assert.deepEqual([again.created, again.handoff.id], [false, s.handoff.id], "没有新内容时重复 stop 仍是同一份");
  assert.equal(coord.listHandoffs(db).length, 2);
  // 只多了一条流水也算有新内容
  coord.appendJournal(db, "agent-w", { kind: "note", body: "补一条" }, t0 + 42 * min);
  assert.equal(coord.stop(db, "agent-w", "stop", t0 + 43 * min).handoff.stop_seq, 3);
});

test("协作安全:不带 lease 的心跳只往后续租,不把长租约缩成默认的 30 分钟", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const tok = await B.register("agent-l");
    const long = await B.card("长租约的卡", "ext"), short = await B.card("短租约的卡", "ext");
    assert.equal((await B.take(tok, long.id, { lease_minutes: 240 })).status, 200);
    assert.equal((await B.take(tok, short.id, { lease_minutes: 1 })).status, 200);
    const left = (r, id) => (r.body.renewed.find((x) => x.id === id).lease_until - Date.now()) / 60000;
    const hb = await B.api("POST", "/api/coord/heartbeat", tok, {});
    assert.equal(hb.status, 200, JSON.stringify(hb.body));
    assert.ok(left(hb, long.id) > 235, `长租约在无 lease 心跳后不应变短:剩 ${left(hb, long.id).toFixed(1)} 分`);
    assert.ok(left(hb, short.id) > 29 && left(hb, short.id) < 31, `短租约续到默认 30 分:剩 ${left(hb, short.id).toFixed(1)} 分`);
    const one = await B.api("POST", "/api/coord/heartbeat", tok, { task_id: long.id });
    assert.ok(left(one, long.id) > 235, "只续一张时同样不缩短");
    const set = await B.api("POST", "/api/coord/heartbeat", tok, { task_id: long.id, lease_minutes: 60 });
    assert.ok(left(set, long.id) > 59 && left(set, long.id) < 61, "明确给了 lease 就按给的值");
  } finally { await B.stop(); }
});

test("协作安全:卡片级心跳不带 lease_minutes 时同样只往后续租,明确给值仍按给的值", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    const tok = await B.register("agent-k");
    const long = await B.card("长租约的卡", "ext"), short = await B.card("短租约的卡", "ext");
    const gl = await B.take(tok, long.id, { lease_minutes: 240 }), gs = await B.take(tok, short.id, { lease_minutes: 1 });
    assert.deepEqual([gl.status, gs.status], [200, 200]);
    const runL = gl.body.task.run_id, runS = gs.body.task.run_id;
    /** 卡片级心跳,返回续完之后剩下的分钟数 */
    const beat = async (token, id, body) => {
      const r = await B.api("POST", `/api/tasks/${id}/heartbeat`, token, body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return (r.body.task.lease_until - Date.now()) / 60000;
    };
    let left = await beat(tok, long.id, { run_id: runL });
    assert.ok(left > 235, `240 分钟领的卡,不带 lease_minutes 的卡片级心跳后不应变短:剩 ${left.toFixed(1)} 分`);
    left = await beat(tok, short.id, { run_id: runS });
    assert.ok(left > 29 && left < 31, `短租约续到默认 30 分:剩 ${left.toFixed(1)} 分`);
    for (const bad of [null, 0, -5, "abc"]) {
      left = await beat(tok, long.id, { run_id: runL, lease_minutes: bad });
      assert.ok(left > 235, `lease_minutes 写成 ${JSON.stringify(bad)} 等于没给,不缩租:剩 ${left.toFixed(1)} 分`);
    }
    const viaCoord = await B.api("POST", "/api/coord/heartbeat", tok, { task_id: long.id, lease_minutes: null });
    assert.ok((viaCoord.body.renewed[0].lease_until - Date.now()) / 60000 > 235, "协作心跳里 lease_minutes 写成 null 同样等于没给");
    left = await beat(tok, long.id, { run_id: runL, lease_minutes: 60 });
    assert.ok(left > 59 && left < 61, `明确给了 lease_minutes 就按给的值:剩 ${left.toFixed(1)} 分`);
    left = await beat(tok, long.id, { run_id: runL, lease_minutes: 1000 });
    assert.ok(left > 239 && left < 241, `执行者令牌的上限仍是 240 分:剩 ${left.toFixed(1)} 分`);
    // 共享 worker 令牌走同一条路由:没给只往后续;每次都带 lease_minutes 的(worker 循环)按给的值,行为不变
    await B.card("手工执行线的卡");
    const cl = await B.api("POST", "/api/claim", B.worker, { worker: "manual-w", line: "alpha", lease_minutes: 120, worker_protocol_version: 2, agent_instance_id: randomUUID() });
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    const w = { worker: "manual-w", run_id: cl.body.task.run_id };
    left = await beat(B.worker, cl.body.task.id, w);
    assert.ok(left > 115, `worker 令牌不带 lease_minutes 也不缩租:剩 ${left.toFixed(1)} 分`);
    left = await beat(B.worker, cl.body.task.id, { ...w, lease_minutes: 45 });
    assert.ok(left > 44 && left < 46, `worker 带 lease_minutes 的心跳照旧按给的值:剩 ${left.toFixed(1)} 分`);
  } finally { await B.stop(); }
});

test("协作安全:只追加的协作表挡住 REPLACE(整行替换),不只是 UPDATE 与 DELETE", () => {
  const db = memdb(), t0 = 1_800_000_000_000;
  coord.register(db, { id: "agent-p" }); coord.register(db, { id: "agent-q" });
  const j = coord.appendJournal(db, "agent-p", { kind: "note", body: "原始正文" }, t0);
  const h = coord.stop(db, "agent-p", "stop", t0 + 1000).handoff;
  coord.ackHandoff(db, "agent-q", h.id, t0 + 2000);
  const tries = {
    "流水 INSERT OR REPLACE": () => db.prepare("INSERT OR REPLACE INTO coord_journal (id,at,executor,kind,body) VALUES (?,?,?,?,?)").run(j.id, j.at, "operator", "approval.decided", "被替换的正文"),
    "流水 REPLACE INTO": () => db.prepare("REPLACE INTO coord_journal (id,at,executor,kind,body) VALUES (?,?,?,?,?)").run(j.id, j.at, "operator", "x", "y"),
    "交接 按主键替换": () => db.prepare("INSERT OR REPLACE INTO coord_handoffs (id,executor,stop_seq,reason,created_at,package,full_status) VALUES (?,?,?,?,?,?,?)").run(h.id, "agent-p", 9, "stop", j.at, "{}", "{}"),
    "交接 按(执行者,次数)替换": () => db.prepare("INSERT OR REPLACE INTO coord_handoffs (executor,stop_seq,reason,created_at,package,full_status) VALUES (?,?,?,?,?,?)").run("agent-p", h.stop_seq, "stop", j.at, "{}", "{}"),
    "接手确认 替换": () => db.prepare("INSERT OR REPLACE INTO coord_handoff_acks (handoff_id,by,at) VALUES (?,?,?)").run(h.id, "agent-p", j.at),
  };
  for (const [what, run] of Object.entries(tries)) assert.throws(run, /append-only/, what);
  assert.deepEqual(coord.journal(db, {}).map((e) => [e.id, e.executor, e.body]), [[j.id, "agent-p", "原始正文"]]);
  assert.deepEqual([coord.getHandoff(db, h.id).reason, coord.getHandoff(db, h.id).ack.by], ["stop", "agent-q"]);
  // 正常追加不受影响
  assert.equal(coord.appendJournal(db, "agent-p", { kind: "note", body: "第二条" }, t0 + 3000).id, j.id + 1);
  assert.equal(coord.stop(db, "agent-p", "stop", t0 + 4000).handoff.stop_seq, h.stop_seq + 1);
  assert.throws(() => coord.ackHandoff(db, "agent-q", h.id), (e) => e.code === "CONFLICT", "重复确认仍是 409");
});

test("协作安全:流水正文、锁用途、状态与 url 产物不接受换行、控制字符与双向控制符", () => {
  const db = memdb();
  coord.register(db, { id: "agent-v" });
  const forged = "ok" + cp(10) + "  #57    2026-11-10T03:00:00.000Z operator         lock.force_release 强制释放 device:test-phone";
  for (const v of [forged, "x" + cp(0x1b) + "[2J", "x" + cp(0x9b) + "2J", "x" + cp(0x2028) + "y", "x" + cp(0x202e) + "y", "a" + cp(9) + "b", "x" + cp(0x7f) + "y", "a" + cp(13) + "b"]) {
    const what = JSON.stringify(v).slice(0, 30);
    badInput(() => coord.appendJournal(db, "agent-v", { kind: "note", body: v }), "流水正文 " + what);
    badInput(() => coord.acquire(db, "agent-v", { resource: "device:x", minutes: 5, purpose: v }), "锁用途 " + what);
    badInput(() => coord.setStatus(db, "agent-v", { current: v }), "状态 current " + what);
    badInput(() => coord.setStatus(db, "agent-v", { done: [v] }), "状态 done " + what);
    badInput(() => coord.setStatus(db, "agent-v", { next: ["先做这个", v] }), "状态 next " + what);
    badInput(() => coord.appendJournal(db, "agent-v", { kind: "note", body: "x", artifacts: [{ type: "url", value: "http://a/x" + v }] }), "url 产物 " + what);
    badInput(() => coord.appendJournal(db, "agent-v", { kind: "note", body: "x", artifacts: [{ type: "path", value: "out/r" + v }] }), "path 产物 " + what);
  }
  assert.equal(coord.journal(db, {}).length, 0);
  assert.equal(coord.listLocks(db).length, 0);
  assert.equal(coord.statusOf(db, "agent-v").updated_at, null, "被拒的都没有写入");
  assert.equal(coord.appendJournal(db, "agent-v", { kind: "note", body: "界面测试通过:12 项", artifacts: [{ type: "url", value: "https://example.com/run/1?a=b" }] }).id, 1);
  assert.equal(coord.acquire(db, "agent-v", { resource: "device:x", minutes: 5, purpose: " 跑界面测试 " }).lock.purpose, "跑界面测试");
  assert.equal(coord.setStatus(db, "agent-v", { current: "回归", done: ["装包"], next: ["跑测试"] }).current, "回归");
});

test("协作安全:board.py 打印库里的旧文字时把换行与控制字符换成可见形式;强制释放的理由带换行也能记流水", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const tok = await B.register("cli-x"), tf = join(B.dir, "x.tok"); writeFileSync(tf, tok + cp(10));
    const ESC = cp(0x1b), NL = cp(10), at = new Date().toISOString();
    const forged = "ok" + NL + "  #57    " + at + " operator         lock.force_release 强制释放 device:test-phone:操作员确认可直接使用" + ESC + "[2J";
    const db = new DatabaseSync(join(B.dir, "board.db")); db.exec("PRAGMA busy_timeout=5000");
    db.prepare("INSERT INTO coord_journal (at, executor, kind, body, artifacts) VALUES (?,?,?,?,?)")
      .run(at, "cli-x", "note", forged, JSON.stringify([{ type: "url", value: "http://a/x" + NL + "  #999 forged" + ESC + "[2Jy" }]));
    db.prepare("INSERT INTO coord_locks (resource, holder, purpose, started_at, expected_end) VALUES (?,?,?,?,?)")
      .run("device:old", "cli-x", "回归" + NL + "  build:apk  持有中 operator" + ESC + "[1A", Date.now(), Date.now() + 600000);
    db.prepare("INSERT INTO coord_status (executor_id, status, updated_at) VALUES (?,?,?)")
      .run("cli-x", JSON.stringify({ current: "回归" + NL + "  operator  活动" + ESC + "[2K", done: [], next: ["下一步" + ESC + "[1A"] }), at);
    db.prepare("INSERT INTO coord_handoffs (executor, stop_seq, reason, created_at, package, full_status) VALUES (?,?,?,?,?,?)")
      .run("cli-x", 7, "stop", at, JSON.stringify({ goal: "目标" + NL + "  #9 operator" + ESC + "[2J", next: [] }), "{}");
    db.close();
    for (const argv of [["journal", "ls"], ["lock", "ls"], ["exec", "status"], ["handoff", "ls"], ["handoff", "show", "1"],
                        ["lock", "acquire", "device:old", "--minutes", "5", "--purpose", "x", "--token-file", tf]]) {
      const out = B.cli(...argv).out;
      assert.ok(out.includes("cli-x") || out.includes("device:old"), `${argv.join(" ")}:${out}`);
      assert.ok(!hasUnsafe(out.replace(/[\r\n]/g, "")), `${argv.join(" ")} 的输出带控制字符:${JSON.stringify(out)}`);
      assert.ok(!/^ +#(57|999|9) /m.test(out) && !/^ +(build:apk|operator) /m.test(out), `${argv.join(" ")} 的输出里出现了伪造的行:${out}`);
    }
    // 操作员强制释放的理由文件里有换行:锁照常释放,流水记成一行
    const why = join(B.dir, "why.txt"); writeFileSync(why, "持有者会话已结束" + NL + "已当面确认");
    const r = B.cli("lock", "release", "device:old", "--force", "--file", why);
    assert.equal(r.code, 0, r.out);
    const jr = (await B.api("GET", "/api/coord/journal?executor=operator", tok)).body.entries;
    assert.ok(jr.some((e) => e.kind === "lock.force_release" && e.body.includes("持有者会话已结束 已当面确认")), JSON.stringify(jr));
  } finally { await B.stop(); }
});

test("协作安全:board.py journal ls 的查询参数做 URL 编码,带 + 时区的 --since 可用", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const tok = await B.register("cli-y"), tf = join(B.dir, "y.tok"); writeFileSync(tf, tok + cp(10));
    assert.equal((await B.api("POST", "/api/coord/journal", tok, { kind: "note", body: "带时区查询" })).status, 201);
    const since = new Date(Date.now() - 3600000 + 9 * 3600000).toISOString().replace("Z", "+09:00");   // 一小时前,写成 +09:00
    const r = B.cli("journal", "ls", "--since", since, "--token-file", tf);
    assert.equal(r.code, 0, `--since ${since}:${r.out}`);
    assert.match(r.out, /带时区查询/);
    const none = B.cli("journal", "ls", "--since", since, "--executor", "nobody&limit=500", "--token-file", tf);
    assert.equal(none.code, 0, none.out);
    assert.ok(!none.out.includes("带时区查询"), "值里的 & 不会混进别的参数");
  } finally { await B.stop(); }
});

test("协作安全:操作员可以注销执行者;在持卡或持锁时拒绝,其他令牌与远程入口不能注销,留流水", { timeout: 120000 }, async () => {
  const rport = await freePort("127.0.0.2");
  const B = await board({}, { remote_access: { enabled: true, listen: [`127.0.0.2:${rport}`], allow_ips: ["127.0.0.0/8"] } });
  try {
    const del = (id, token) => B.api("DELETE", `/api/coord/executors/${encodeURIComponent(id)}`, token);
    const ids = async () => (await B.api("GET", "/api/coord/executors", B.operator)).body.executors.map((e) => e.id);
    const tok = await B.register("agent-d"), other = await B.register("agent-e");
    // 只有操作员能注销
    const apr = (await B.api("POST", "/api/approval-tokens", B.operator, { label: "phone" })).body.token;
    assert.equal((await del("agent-d", B.worker)).status, 403, "worker 令牌不能注销");
    assert.equal((await del("agent-d", tok)).status, 403, "执行者不能注销自己");
    assert.equal((await del("agent-d", other)).status, 403, "执行者不能注销别人");
    assert.equal((await del("agent-d", apr)).status, 401, "本机接口不认批准令牌");
    let remote = null;
    for (let i = 0; i < 50 && !remote; i++) {
      try { remote = await fetch(`http://127.0.0.2:${rport}/api/coord/executors/agent-d`, { method: "DELETE", headers: { Authorization: `Bearer ${apr}` } }); }
      catch { await delay(100); }
    }
    assert.equal(remote?.status, 403, "远程入口不开放注销");
    assert.equal((await del("nobody", B.operator)).status, 404, "没登记的 id 是 404");
    assert.ok((await ids()).includes("agent-d"), "被拒的都没有注销成");
    // 还持有进行中的卡:409
    await B.api("POST", "/api/coord/status", tok, { current: "跑回归", next: ["提交报告"] });
    await B.api("POST", "/api/coord/journal", tok, { kind: "note", body: "注销之前写的流水" });
    const t = await B.card("执行者手上的卡", "ext");
    const got = await B.take(tok, t.id);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const held = await del("agent-d", B.operator);
    assert.equal(held.status, 409, `在持卡时不能注销:${JSON.stringify(held.body).slice(0, 200)}`);
    assert.match(held.body.error, new RegExp(`#${t.id}`), "写明是哪张卡");
    assert.equal((await B.api("POST", `/api/tasks/${t.id}/report`, tok, { run_id: got.body.task.run_id, outcome: "done", evidence: "交付" })).status, 200);
    // 还持有未释放的锁:409
    assert.equal((await B.api("POST", "/api/coord/locks", tok, { resource: "device:test-phone", minutes: 5, purpose: "回归" })).status, 201);
    const locked = await del("agent-d", B.operator);
    assert.equal(locked.status, 409, `在持锁时不能注销:${JSON.stringify(locked.body).slice(0, 200)}`);
    assert.match(locked.body.error, /device:test-phone/, "写明是哪把锁");
    assert.equal((await B.api("GET", "/api/coord", tok)).status, 200, "被拒之后令牌照常");
    assert.equal((await B.api("POST", "/api/coord/locks/release", tok, { resource: "device:test-phone" })).status, 200);
    // 都放掉之后可以注销:令牌立即失效,列表里不再有它,留一条操作员流水;它写过的流水与锁记录还在
    const gone = await del("agent-d", B.operator);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.executor.id, "agent-d");
    assert.equal((await B.api("GET", "/api/coord", tok)).status, 401, "注销后令牌失效");
    assert.deepEqual(await ids(), ["agent-e"]);
    const jr = (await B.api("GET", "/api/coord/journal?limit=200", B.operator)).body.entries;
    const note = jr.find((e) => e.kind === "executor.unregister");
    assert.ok(note && note.executor === "operator" && note.body.includes("agent-d"), `注销要留流水:${JSON.stringify(jr.map((e) => [e.executor, e.kind]))}`);
    assert.equal(note.id, gone.body.journal_id);
    assert.ok(jr.some((e) => e.executor === "agent-d" && e.body === "注销之前写的流水"), "它写过的流水不删");
    const locks = (await B.api("GET", "/api/coord/locks?all=1", B.operator)).body.locks;
    assert.deepEqual(locks.map((x) => [x.resource, x.holder]), [["device:test-phone", "agent-d"]], "锁记录不删");
    assert.equal((await del("agent-d", B.operator)).status, 404, "已注销的再注销是 404");
    const db = new DatabaseSync(join(B.dir, "board.db"), { readOnly: true });
    const row = db.prepare("SELECT token_hash FROM coord_executors WHERE id='agent-d'").get(); db.close();
    assert.notEqual(row?.token_hash, createHash("sha256").update(tok).digest("hex"), "库里不再留着旧令牌的哈希");
    // 同一个 id 可以重新登记:新令牌可用,旧令牌仍无效,状态从空白开始
    const again = await B.api("POST", "/api/coord/executors", B.operator, { id: "agent-d", name: "新的甲" });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal((await B.api("GET", "/api/coord", tok)).status, 401);
    const me = (await B.api("GET", "/api/coord/executors", again.body.token)).body.executors.find((e) => e.id === "agent-d");
    assert.deepEqual([me.name, me.kind, me.status.current, me.last_seen], ["新的甲", "external", "", null]);
    assert.equal((await B.api("POST", "/api/coord/stop", again.body.token, {})).status, 201, "重新登记后照常停止并生成交接包");
    // 命令行:exec unregister
    const tf = join(B.dir, "e.tok"); writeFileSync(tf, other + cp(10));
    assert.notEqual(B.cli("exec", "unregister", "agent-e", "--token-file", tf).code, 0, "执行者令牌不能用命令行注销");
    const c = B.cli("exec", "unregister", "agent-e");
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /已注销执行者 agent-e/);
    assert.equal((await B.api("GET", "/api/coord", other)).status, 401);
    assert.notEqual(B.cli("exec", "unregister", "agent-e").code, 0, "再注销一次报 404");
  } finally { await B.stop(); }
});

test("协作安全:与受管线同名的旧登记注销之后,共享 worker 令牌可以再用这个座位名", { timeout: 60000 }, async () => {
  const B = await board();
  try {
    // 手工用共享 worker 令牌跑 alpha 线,手上有一张卡
    await B.card("受管线上的卡");
    const cl = await B.api("POST", "/api/claim", B.worker, { worker: "alpha", line: "alpha", worker_protocol_version: 2, agent_instance_id: randomUUID() });
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    const beat = () => B.api("POST", `/api/tasks/${cl.body.task.id}/heartbeat`, B.worker, { worker: "alpha", run_id: cl.body.task.run_id, lease_minutes: 30 });
    assert.equal((await beat()).status, 200, "没有同名登记时照常续租");
    // 修复前留下的同名登记(直接写库):共享令牌从此用不了这个座位名
    const db = new DatabaseSync(join(B.dir, "board.db")); db.exec("PRAGMA busy_timeout=5000");
    const at = new Date().toISOString();
    db.prepare("INSERT INTO coord_executors (id,name,kind,token_hash,created_at,token_issued_at) VALUES (?,?,?,?,?,?)")
      .run("alpha", "alpha", "line", createHash("sha256").update("exe_" + "2".repeat(48)).digest("hex"), at, at);
    db.close();
    assert.equal((await beat()).status, 409, "有同名登记时,共享令牌对已持有的卡续租也被拒");
    // 操作员注销这条旧登记:alpha 名下进行中的卡是座位的(同名执行者领不了卡),不挡注销
    const gone = await B.api("DELETE", "/api/coord/executors/alpha", B.operator);
    assert.equal(gone.status, 200, `同名旧登记应能注销:${JSON.stringify(gone.body).slice(0, 200)}`);
    assert.equal((await beat()).status, 200, "注销后共享令牌恢复续租");
    assert.equal((await B.api("GET", "/api/coord", "exe_" + "2".repeat(48))).status, 401, "旧登记的令牌失效");
    const still = (await B.api("GET", `/api/tasks/${cl.body.task.id}`, B.operator)).body.task;
    assert.deepEqual([still.status, still.worker], ["in_progress", "alpha"], "座位手上的卡不受影响");
  } finally { await B.stop(); }
});
