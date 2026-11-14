import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 合同 J1「收扫描」(第 9 波 9a):行为不变,只收开销。`node --test tests/scancosttest.mjs`
//   J1.1 task.live_note 不触发自动规则(看板:条件到了但只来了 live_note → 不放行;整板扫一来就放行)。
//   J1.2 自动规则按事件的 on 过滤、按卡扫;事件里没有卡号 = 整板;水位并进「这一拍动过的卡」;规则之间的连锁在同一次 flush 里跑完;
//        看板上关掉定时兜底(BOARD_INTEGRATE_SCAN_MS 很大)时,条件放行 / 引用过期 / 卡死(到阈值、清零后再卡死)/ 复审卡 / 核对卡 / 候选组装卡都当拍出现。
//   J1.3 卡死增量与从头全量重算同场对拍(随机序列 + 清零 / 改说明 / 断开 / 原因后写 / 换阈值 / 重开进程接着算);增量第二次不再读旧事件。
//   J1.4 同一张被引用卡一轮只算一次哈希(看板上:多张引用方同一被引用卡,各记一次 ref.stale)。
//   J1.5 整合扫 / 底提交扫跨轮缓存:目标没动不再跑 merge-base;目标动了 = 新结论;unknown 不沿用;scanFresh 拿到的是新鲜结果。
//   不调用任何模型;临时目录、临时 git 仓、假会话目录。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { freePort } from "./helpers/free-port.mjs";
import { openStuck } from "../core/stuck.mjs";
import { openAutocards } from "../core/autocards.mjs";
import { openIntegrate, normIntegrate, gitQuery } from "../core/integrate.mjs";
import { openBase, normBase } from "../core/basecommit.mjs";
import { gitQueryEnv } from "../core/credibility.mjs";
import { resolveGit } from "../core/git-program.mjs";

const require = createRequire(import.meta.url);
const store = require("../core/store.js");
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "scancost-")), dbs = [];
after(() => { for (const d of dbs) { try { d.close(); } catch {} } try { rmSync(TMP, { recursive: true, force: true }); } catch {} });
const GIT = resolveGit({ env: process.env }).path;
const sha = (x) => createHash("sha256").update(x).digest("hex");
const until = async (fn, ms = 4000, step = 50) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v || Date.now() > end) return v; await delay(step); } };

function freshDb() {
  const dir = join(TMP, "u" + Math.random().toString(16).slice(2)); mkdirSync(dir);
  const db = new DatabaseSync(join(dir, "b.db")); dbs.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  store.migrate(db);
  return { db, file: join(dir, "b.db") };
}

// ── J1.3 卡死:增量 × 从头全量,同场对拍 ─────────────────────────────────────────────────────────
test("J1.3 卡死增量 = 从头全量重算:随机序列(含清零、改说明、done 断开、联动、原因后写、换阈值)逐步对拍;重开进程从 stuck_state 接着算", async () => {
  const { db, file } = freshDb();
  let n = 3;
  const st = openStuck({ db, store, threshold: () => n });
  st.migrate();
  const ids = Array.from({ length: 6 }, (_, i) => store.add(db, { subject: "卡 " + i }));
  let seed = 20261114;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % k; };
  const runs = ["r1", "r2", "r3", "r4"], reasons = ["env_broken", "missing_input", "other"];
  const step = () => {
    const id = ids[rnd(ids.length)], r = rnd(100), run = runs[rnd(runs.length)];
    const ev = (kind, detail = {}, actor = "w") => store.appendEvent(db, { taskId: id, kind, actor, detail });
    if (r < 22) ev("reap");
    else if (r < 46) ev("report", { outcome: "wait", run_id: run });
    else if (r < 50) ev("report", { outcome: "done", run_id: run });
    else if (r < 62) ev("resolve", { disposition: "hand_back", verdict: "reject" }, "review");
    else if (r < 65) ev("resolve", { disposition: "hand_back" }, "cascade");
    else if (r < 67) ev("resolve", { disposition: "close" }, "operator");
    else if (r < 69) ev("resolve", { status: "not_started" }, "operator");
    else if (r < 71) ev("stuck.cleared", {}, "operator");
    else if (r < 73) ev("spec.changed", { version: 2 }, "operator");
    else if (r < 80) ev("heartbeat_noise", {});
    else if (r < 92) st.recordReason(id, run, reasons[rnd(reasons.length)]);   // 原因可能落在已折进的交回上(后写 / 覆盖)
    else if (r < 94) n = [0, 2, 2, 3, 5][rnd(5)];
    else st.sweep();                                                            // 顺手落盘
  };
  const same = (label) => { for (const id of ids) { const t = store.get(db, id); assert.deepEqual(st.compute(t), st.computeFull(t), `${label} #${id}`); } };
  let hits = 0;
  for (let i = 0; i < 1500; i++) {
    step();
    if (i % 3 === 0) same("第 " + i + " 步");
    for (const id of ids) if (st.computeFull(store.get(db, id))) hits++;
  }
  assert.ok(hits > 50, "序列里确实到过阈值:" + hits);
  n = 2; await st.sweep(); same("落盘后");
  // 重开进程:新实例从 stuck_state.calc 接着算(只读之后的事件),结果仍与全量相同
  const db2 = new DatabaseSync(file); dbs.push(db2);
  const st2 = openStuck({ db: db2, store, threshold: () => n }); st2.migrate();
  for (let i = 0; i < 200; i++) { step(); }
  for (const id of ids) { const t = store.get(db2, id); assert.deepEqual(st2.compute(t), st2.computeFull(t), `重开后 #${id}`); }
  assert.ok(db.prepare("SELECT COUNT(*) AS c FROM stuck_state WHERE calc IS NOT NULL").get().c >= 1, "计数落进了 stuck_state");
});

test("J1.3 卡死增量:清零 / 改说明 / done 断开回收但不断开退回 / 验收通过 —— 三种算法(增量、全量、重开)一致;第二次算不再读旧事件", () => {
  const { db } = freshDb();
  // 计数用的库代理:记下 task_events 查询返回了几行(增量第二次应为 0)。
  let evRows = 0;
  const proxy = { prepare: (sql) => { const s = db.prepare(sql); if (!/FROM task_events/.test(sql)) return s;
                    return { all: (...a) => { const r = s.all(...a); evRows += r.length; return r; }, get: (...a) => s.get(...a), run: (...a) => s.run(...a) }; },
                  exec: (s) => db.exec(s), get isTransaction() { return db.isTransaction; } };
  const st = openStuck({ db: proxy, store, threshold: () => 2 }); st.migrate();
  const id = store.add(db, { subject: "会卡死" });
  const ev = (kind, detail = {}, actor = "w") => store.appendEvent(db, { taskId: id, kind, actor, detail });
  const both = (label) => { const t = store.get(db, id); const a = st.compute(t), b = st.computeFull(t); assert.deepEqual(a, b, label); return a; };
  for (let i = 0; i < 40; i++) ev("heartbeat_noise");
  ev("reap"); ev("reap");
  assert.equal(both("回收 2 次").kind, "reaped");
  evRows = 0; both("再算一次");
  const t = store.get(db, id); evRows = 0; st.compute(t);
  assert.equal(evRows, 0, "没有新事件:增量一行都不读");
  ev("report", { outcome: "done", run_id: "d1" });
  assert.equal(both("done 断开回收"), null);
  ev("resolve", { disposition: "hand_back" }, "review"); ev("report", { outcome: "done", run_id: "d2" }); ev("resolve", { disposition: "hand_back" }, "review");
  assert.deepEqual([both("退回 2 次(done 不断开)").kind, both("x").count], ["handed_back", 2]);
  ev("stuck.cleared", {}, "operator");
  assert.equal(both("清零"), null);
  ev("reap"); ev("reap"); assert.equal(both("清零后再卡死").kind, "reaped");
  ev("spec.changed", { version: 3 }, "operator");
  assert.equal(both("改说明"), null);
  st.recordReason(id, "w1", "same"); ev("report", { outcome: "wait", run_id: "w1" });
  ev("report", { outcome: "wait", run_id: "w2" });
  assert.equal(both("w2 没原因").kind, "failed");
  st.recordReason(id, "w2", "same");                                  // 原因后写:同原因 2 次
  const sr = both("原因后写");
  assert.deepEqual([sr.kind, sr.count], ["failed", 2]);
  assert.deepEqual(sr.last.map((x) => x.reason_code), ["same", "same"]);
  ev("resolve", { disposition: "close" }, "operator");
  assert.equal(both("验收通过"), null);
});

// ── J1.2 自动规则:按 on 过滤、按卡、水位、连锁 ───────────────────────────────────────────────────
function autoFx(extraRules) {
  const { db } = freshDb();
  const calls = [];
  const integ = { goals: () => [], kidsOf: () => [], summary: () => null, scan: async () => {} };
  let A = null;
  const rules = extraRules((type, data) => A.kick(type, data), calls);
  A = openAutocards({ db, store, cred: {}, integ, occ: { touchesOf: () => [] }, release: () => {}, rules });
  A.migrate();
  return { db, A, calls };
}
test("J1.2 sweep 按事件:on 对不上的规则不跑;带卡号 = 按卡;没卡号的 task.* = 整板;水位并进新事件的卡;sweep() = 整板", async () => {
  const f = autoFx((kick, calls) => [
    { name: "on_task", on: ["task.*"], run: (s) => { calls.push(["task", s ? [...s.ids].sort((a, b) => a - b) : null]); } },
    { name: "on_pkg", on: ["package.changed"], run: (s) => { calls.push(["pkg", s ? [...s.pkgs] : null]); } },
  ]);
  await f.A.sweep();                              // 第一轮(立水位)= 整板
  assert.deepEqual(f.calls.splice(0), [["task", null], ["pkg", null]]);
  f.A.kick("task.updated", { id: 5 }); await f.A.flush();
  assert.deepEqual(f.calls.splice(0), [["task", [5]]], "只跑 task.* 的规则,只看 #5");
  f.A.kick("package.changed", { id: 7, package_id: 3 }); await f.A.flush();
  assert.deepEqual(f.calls.splice(0), [["pkg", [3]]], "包事件只跑包规则");
  f.A.kick("task.reaped", { count: 2 }); await f.A.flush();
  assert.deepEqual(f.calls.splice(0), [["task", null], ["pkg", null]], "不知道动了哪张卡 = 整板");
  f.A.kick("task.rearmed", { ids: [8, 9] }); await f.A.flush();
  assert.deepEqual(f.calls.splice(0), [["task", [8, 9]]], "ids 数组按卡");
  const other = store.add(f.db, { subject: "别处改了的卡" });   // store 在卡历史里记一条,但没发事件
  f.A.kick("task.updated", { id: 5 }); await f.A.flush();
  assert.deepEqual(f.calls.splice(0), [["task", [5, other].sort((a, b) => a - b)]], "水位:新事件的卡并进这一拍");
  f.A.kick("task.updated", { id: 5 }); f.A.kick("task.updated", { id: 6 }); await f.A.flush();
  assert.deepEqual(f.calls.splice(0), [["task", [5, 6]]], "同一拍的多次合并成一轮");
  f.A.kick(); await f.A.flush();
  assert.deepEqual(f.calls.splice(0), [["task", null], ["pkg", null]], "不带参数 = 整板(设置变了)");
  await f.A.flush(); await f.A.flush();          // 没攒下事件时 flush 空跑:之后的事件照常处理(不会卡住)
  f.A.kick("task.updated", { id: 4 }); await f.A.flush();
  assert.deepEqual(f.calls.splice(0), [["task", [4]]], "空跑 flush 之后照常");
  assert.deepEqual(f.A.RULES.map((r) => [r.name, r.on]).slice(0, 3), [["release_on", ["task.*"]], ["assemble", ["task.*", "integrate.scan"]], ["pin", ["package.changed", "task.*"]]]);
});

test("J1.2 连锁:规则的动作发出的事件(放行 → 新的 task.*)在同一次 flush 里由别的规则按卡接着处理;sweep 进行中再来的整板请求排在后面", async () => {
  const f = autoFx((kick, calls) => [
    { name: "first", on: ["task.*"], run: (s) => { calls.push(["first", s ? [...s.ids] : null]); if (s && s.ids.has(5)) kick("task.released", { id: 6 }); } },
    { name: "second", on: ["task.*"], run: async (s) => { await delay(5); calls.push(["second", s ? [...s.ids] : null]); } },
  ]);
  await f.A.sweep(); f.calls.splice(0);
  f.A.kick("task.resolved", { id: 5 });
  await f.A.flush();
  assert.deepEqual(f.calls.splice(0), [["first", [5]], ["second", [5]], ["first", [6]], ["second", [6]]], "放行发出的事件在同一次 flush 里接着跑");
  const p = f.A.sweep(); await delay(2); f.A.sweep(); await p;
  assert.deepEqual(f.calls.map((c) => c[1]), [null, null, null, null], "进行中再要整板:跑完这轮再整板一轮");
});

// ── J1.5 整合扫 / 底提交扫跨轮缓存 ─────────────────────────────────────────────────────────────────
function gitRepo() {
  const dir = mkdtempSync(join(TMP, "repo-"));
  const g = (...a) => execFileSync(GIT, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "core.autocrlf=false", "-C", dir, ...a],
                                   { env: gitQueryEnv(HOST_ENV), windowsHide: true }).toString().trim();
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n"); g("add", "-A"); g("commit", "-q", "-m", "c1");
  const c1 = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "side");
  writeFileSync(join(dir, "b.txt"), "two\n"); g("add", "-A"); g("commit", "-q", "-m", "c2");
  const c2 = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  writeFileSync(join(dir, "c.txt"), "three\n"); g("add", "-A"); g("commit", "-q", "-m", "c3");
  return { dir, c1, c2, g };
}
const ERR = { NOT_FOUND: "NOT_FOUND", CONFLICT: "CONFLICT", BAD_INPUT: "BAD_INPUT" };
const err = (code, message) => Object.assign(new Error(message), { code });
const ctx = { err, ERR };

test("J1.5 整合扫跨轮缓存:目标没动只读一次目标 sha、不再跑 merge-base;目标动了 = 新结论;unknown 不沿用;scanFresh 等在跑的一轮后再扫,拿到新鲜结果", { skip: !GIT && "没有 git" }, async () => {
  const R = gitRepo();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, kind TEXT, parent_id INTEGER, status TEXT, line TEXT, archived_at TEXT, blocked_by TEXT)");
  const ins = db.prepare("INSERT INTO tasks (id, kind, parent_id, status, line) VALUES (?,?,?,?,?)");
  ins.run(1, "goal", null, "in_progress", null); ins.run(2, "task", 1, "done", "alpha"); ins.run(3, "task", 1, "done", "alpha"); ins.run(4, "task", 1, "in_progress", "alpha");
  const heads = { 2: R.c1, 3: R.c2, 4: "0123456789abcdef0123456789abcdef01234567" };
  const seen = []; let slow = 0;
  const I = openIntegrate({ db, err, ERR, git: () => GIT, repoForLine: (l) => (l === "alpha" ? R.dir : null), headOf: (id) => heads[id] ?? null,
    query: async (...a) => { seen.push(a[2][0]); if (slow) await delay(slow); return gitQuery(...a); } });
  I.migrate();
  I.set(1, normIntegrate({ target: "refs/heads/main" }, ctx), "operator");
  await I.scan();
  assert.deepEqual(seen.splice(0).sort(), ["merge-base", "merge-base", "rev-parse"]);
  assert.deepEqual(I.summary(1).kids.map((k) => [k.id, k.state]), [[2, "merged"], [3, "pending"]]);
  await I.scan();
  assert.deepEqual(seen.splice(0), ["rev-parse"], "目标没动:只读目标 sha,结论沿用");
  assert.equal(I.reusedRuns(), 2);
  assert.deepEqual(I.summary(1).kids.map((k) => [k.id, k.state]), [[2, "merged"], [3, "pending"]], "沿用的结论与上一轮相同");
  // 目标动了(side 合进 main):新 sha 新键,照常核 → c2 变成已合
  R.g("merge", "-q", "--no-edit", "side");
  await I.scanFresh();
  assert.deepEqual(I.summary(1).kids.map((k) => [k.id, k.state]), [[2, "merged"], [3, "merged"]]);
  assert.equal(seen.splice(0).filter((x) => x === "merge-base").length, 2, "目标动了:两张都重核");
  // unknown 不沿用:不在仓里的提交每轮都再核
  db.prepare("UPDATE tasks SET status='done' WHERE id=4").run();
  await I.scan(); seen.splice(0);
  await I.scan();
  assert.deepEqual(seen.splice(0).sort(), ["merge-base", "rev-parse"], "unknown 那张下轮再核");
  // scanFresh:一轮正在跑(它开始时 #5 还没完成)→ 等它跑完再扫一轮,结果里有 #5
  ins.run(5, "task", 1, "in_progress", "alpha"); heads[5] = R.c2;
  slow = 150;
  const running = I.scan();
  await delay(30);
  db.prepare("UPDATE tasks SET status='done' WHERE id=5").run();
  await I.scanFresh(); await running;
  slow = 0;
  assert.equal(I.summary(1).kids.find((k) => k.id === 5)?.state, "merged", "scanFresh 的结果是新鲜的(不是缓存里没有 #5 的那轮)");
});

test("J1.5 底提交扫跨轮缓存:commit 每轮都核在不在;同一 onto 多张卡只读一次;祖先 / 差几笔沿用;onto 动了重算", { skip: !GIT && "没有 git" }, async () => {
  const R = gitRepo();
  const { db } = freshDb();
  const seen = [];
  const B = openBase({ db, store, git: () => GIT, repoForLine: () => R.dir, query: (...a) => { seen.push(a[2][0]); return gitQuery(...a); } });
  B.migrate();
  const a = store.add(db, { subject: "底一" }), b = store.add(db, { subject: "底二" }), m = store.add(db, { subject: "底没了" });
  B.set(a, normBase({ commit: R.c1, onto: "refs/heads/main" }, { err: store.err, ERR: store.ERR }));
  B.set(b, normBase({ commit: R.c1.slice(0, 10), onto: "refs/heads/main" }, { err: store.err, ERR: store.ERR }));
  B.set(m, normBase({ commit: "0123456789abcdef0123", onto: null }, { err: store.err, ERR: store.ERR }));
  await B.scan();
  const first = seen.splice(0);
  assert.equal(first.filter((x) => x === "rev-parse").length, 4, "commit ×3 + onto ×1(两张卡共用):" + first.join(","));
  assert.deepEqual([B.fieldOf(store.get(db, a)).state, B.fieldOf(store.get(db, a)).behind, B.fieldOf(store.get(db, b)).behind, B.fieldOf(store.get(db, m)).state], ["ok", 1, 1, "missing"]);
  await B.scan();
  assert.deepEqual(seen.splice(0).sort(), ["rev-parse", "rev-parse", "rev-parse", "rev-parse"], "onto 没动:不再跑 merge-base / rev-list;commit 仍每轮核");
  assert.equal(B.fieldOf(store.get(db, a)).behind, 1);
  R.g("commit", "-q", "--allow-empty", "-m", "c5");
  await B.scan();
  assert.equal(B.fieldOf(store.get(db, a)).behind, 2, "onto 动了:差几笔重算");
  assert.ok(seen.includes("rev-list"));
});

// ── 看板:定时兜底关掉,事件路径当拍处理 ──────────────────────────────────────────────────────────────
async function board({ repo = null, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scancosttest-")), config = join(dir, "fleet.json");
  mkdirSync(join(dir, "fake-projects")); mkdirSync(join(dir, "fake-codex"));
  writeFileSync(config, JSON.stringify({ lines: [
    { id: "alpha", label: "甲", external: true, ...(repo ? { work_repo: repo } : {}) },
    { id: "beta", label: "乙", external: true, ...(repo ? { work_repo: repo } : {}) },
  ], roles: [], routes: ["default"], repo: dir }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit",
           BOARD_DELIVERABLE_GATE: "off", BOARD_INTEGRATE_SCAN_MS: "3600000", BOARD_REAP_MS: "3600000",
           BOARD_CLAUDE_PROJECTS: join(dir, "fake-projects"), BOARD_CODEX_HOME: join(dir, "fake-codex"), ...env } });
  let log = ""; child.stdout.on("data", (d) => { log = (log + d).slice(-40000); }); child.stderr.on("data", (d) => { log = (log + d).slice(-40000); });
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  await delay(300);   // 启动时那一轮整板扫跑完(之后一小时内没有定时兜底)
  const tok = (n) => readFileSync(join(dir, n), "utf8").trim();
  const operator = tok("board_token");
  const get = async (id) => (await api("GET", `/api/tasks/${id}`, operator)).body?.task;
  const card = async (subject, line, extra = {}) => {
    const r = await api("POST", "/api/tasks", operator, { subject, ...(line ? { line } : {}), description: "说明", acceptance: "验收", ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task;
  };
  const connectAs = async (body) => {
    const c = await api("POST", "/api/connect/codes", operator, body);
    const r = await api("POST", "/api/connect/redeem", null, { code: c.body.code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: r.body.executor_id, token: r.body.token };
  };
  const claim = async (X, id) => { const c = await api("POST", `/api/tasks/${id}/claim`, X.token, { expected_version: (await get(id)).aggregate_version }); assert.equal(c.status, 200, JSON.stringify(c.body)); return c.body.task; };
  const report = async (X, id, body) => { const r = await api("POST", `/api/tasks/${id}/report`, X.token, { run_id: (await get(id)).run_id, ...body }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const deliver = async (X, id, extra = {}) => { await claim(X, id); return report(X, id, { outcome: "done", evidence: "做完了", ...extra }); };
  const resolve = async (id, verdict, note = "") => { const r = await api("POST", `/api/tasks/${id}/resolve`, operator, { verdict, note, expected_version: (await get(id)).aggregate_version, allow_uncommitted: true }); assert.equal(r.status, 200, JSON.stringify(r.body)); };
  const edit = async (id, fields) => api("POST", `/api/tasks/${id}/update`, operator, { expected_version: (await get(id)).aggregate_version, ...fields });
  const history = async (id) => (await api("GET", `/api/tasks/${id}/history`, operator)).body.entries;
  const all = async () => (await api("GET", "/api/tasks?archived=all", operator)).body.tasks;
  const dbWrite = (sql, ...a) => { const d = new DatabaseSync(join(dir, "board.db")); try { d.exec("PRAGMA busy_timeout=5000"); return d.prepare(sql).run(...a); } finally { d.close(); } };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, api, operator, get, card, connectAs, claim, report, deliver, resolve, edit, history, all, dbWrite, stop, log: () => log };
}

test("J1.1 看板:只来 task.live_note 不跑自动规则(这张卡的卡死事件已够阈值也不记 task.stuck);别的事件一来按水位补上;按卡扫不碰没动过的卡,整板扫才放行", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    const S = await B.card("源", "alpha");
    await B.deliver(X, S.id); await B.resolve(S.id, "approve");
    const T = await B.card("等源", "alpha", { released: false });
    const H = await B.card("在跑的卡", "alpha"), Z = await B.card("不相干的卡", "alpha");
    const run = (await B.claim(X, H.id)).run_id;
    assert.equal((await B.api("POST", `/api/tasks/${H.id}/heartbeat`, X.token, { run_id: run })).status, 200);   // 第一次心跳 = task.started
    await delay(300);
    // 绕过写入口直接写库(不发事件):H 的回收事件够阈值(3)、T 的条件放行规则(源已完成)。之后只来 live_note。
    const at = new Date().toISOString();
    for (let i = 0; i < 3; i++) B.dbWrite("INSERT INTO task_events(at, task_id, kind, actor, detail) VALUES(?,?,?,?,?)", at, H.id, "reap", "system", "{}");
    B.dbWrite("INSERT INTO release_rules(task_id, kind, source, event, by_, at) VALUES(?,?,?,?,?,?)", T.id, "set", S.id, "done", "operator", at);
    const stuckOf = async () => (await B.history(H.id)).filter((e) => e.kind === "task.stuck").length;
    assert.equal((await B.api("POST", `/api/tasks/${H.id}/heartbeat`, X.token, { run_id: run, note: "进度 1" })).status, 200);
    await delay(800);
    assert.equal(await stuckOf(), 0, "只有 live_note:不跑卡死规则");
    assert.equal(!!(await B.get(T.id)).released, false, "只有 live_note:不跑条件放行");
    // 不相干的卡来一个事件:按卡扫 + 水位(H 有新的卡历史)→ H 的 task.stuck 补上;T / S 没动过,不碰
    assert.equal((await B.edit(Z.id, { summary: "碰一下" })).status, 200);
    assert.ok(await until(async () => (await stuckOf()) === 1), "水位把 H 并进这一拍");
    await delay(300);
    assert.equal(!!(await B.get(T.id)).released, false, "按卡扫:没动过的卡不碰");
    // 联合(9a × 9b):只改额度低位线 quota_low_at 不触发整板扫(只有 stuck_after 变了才扫);池读数事件 pool.changed 不是 task.*,也不扫
    assert.equal((await B.api("PUT", "/api/home/prefs", B.operator, { quota_low_at: 80 })).status, 200);
    const pr = await B.api("POST", "/api/pools/reading", X.token, { pool: "claude", window: "5h", used_pct: 40 });
    assert.equal(pr.status, 201, JSON.stringify(pr.body));
    await delay(500);
    assert.equal(!!(await B.get(T.id)).released, false, "改额度设置 / 池读数(pool.changed)不触发自动规则");
    // 整板扫(改 stuck_after = kickAutoRules() 不带参数)→ 放行
    assert.equal((await B.api("PUT", "/api/home/prefs", B.operator, { stuck_after: 4 })).status, 200);
    assert.ok(await until(async () => !!(await B.get(T.id)).released), "整板扫放行了 " + B.log().slice(-800));
  } finally { await B.stop(); }
});

test("J1.2 看板当拍:条件放行、引用过期(多张引用方各一次)、卡死到阈值 / 清零后再卡死 / 改说明清零、复审卡、核对卡 —— 定时兜底关着也都出现", { timeout: 180000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    // 条件放行
    const S = await B.card("源", "alpha");
    const T = await B.card("等源完成", "alpha", { release_on: { card: S.id, event: "done" } });
    await B.deliver(X, S.id); await B.resolve(S.id, "approve");
    assert.ok(await until(async () => !!(await B.get(T.id)).released), "条件放行当拍");
    // 引用过期:两张引用方,被引用卡一改各记一次
    const P = await B.card("规格", "beta");
    const R1 = await B.card("照规格一", "alpha", { refs: [P.id] }), R2 = await B.card("照规格二", "alpha", { refs: [P.id] });
    assert.equal((await B.edit(P.id, { description: "第二版" })).status, 200);
    for (const r of [R1, R2]) assert.ok(await until(async () => (await B.history(r.id)).some((e) => e.kind === "ref.stale")), `#${r.id} ref.stale 当拍`);
    await B.edit(R1.id, { summary: "再来一个事件" }); await delay(300);
    assert.equal((await B.history(R1.id)).filter((e) => e.kind === "ref.stale").length, 1, "同一版本只记一次");
    // 卡死:阈值 2;到阈值 → task.stuck;清零 → null;再卡死另记;改说明清零
    assert.equal((await B.api("PUT", "/api/home/prefs", B.operator, { stuck_after: 2 })).status, 200);
    const K = await B.card("老卡住", "alpha");
    const loop = async () => { await B.claim(X, K.id); await B.report(X, K.id, { outcome: "wait", evidence: "缺东西", reason_code: "missing_input" }); await B.resolve(K.id, "reject", "再试 " + Math.random()); };
    const stuckEvents = async () => (await B.history(K.id)).filter((e) => e.kind === "task.stuck").length;
    await loop(); await loop();
    assert.ok(await until(async () => (await stuckEvents()) === 1), "到阈值当拍记 task.stuck");
    assert.ok((await B.get(K.id)).stuck);
    assert.equal((await B.api("POST", `/api/tasks/${K.id}/stuck/clear`, B.operator, { note: "看过了" })).status, 200);
    assert.equal((await B.get(K.id)).stuck, null, "清零");
    await loop(); await loop();
    assert.ok(await until(async () => (await stuckEvents()) === 2), "清零后再卡死另记一次");
    assert.equal((await B.edit(K.id, { description: "改了说明" })).status, 200);
    assert.ok(await until(async () => (await B.get(K.id)).stuck === null), "改说明清零");
    // 复审卡:X 引用别线的规格(review)→ 交付当拍出复审卡
    const S2 = await B.card("别线规格", "beta");
    const RX = await B.card("照别线规格", "alpha", { refs: [{ card: S2.id, review: true }] });
    await B.deliver(X, RX.id, { files: [{ path: "src/a.mjs", sha256: "a".repeat(64) }] });
    assert.ok(await until(async () => (await B.all()).some((t) => t.auto_kind === "spec_review" && t.review_of?.card === RX.id)), "复审卡当拍");
    // 核对卡:包 ran ok + pins → 当拍出核对卡
    const PK = await B.card("包卡", "alpha");
    await B.claim(X, PK.id);
    const files = [{ path: "deploy/run.ps1", sha256: sha("one"), bytes: 3 }];
    const pkg = (await B.api("POST", `/api/tasks/${PK.id}/packages`, X.token, { name: "包", files, pins: ["首页"] })).body.package;
    assert.equal((await B.api("POST", `/api/packages/${pkg.id}/freeze`, X.token, {})).status, 200);
    assert.equal((await B.api("POST", `/api/packages/${pkg.id}/issue`, X.token, { label: "fixture", files })).status, 200);
    assert.equal((await B.api("POST", `/api/packages/${pkg.id}/ran`, B.operator, { result: "ok" })).status, 200);
    assert.ok(await until(async () => (await B.all()).some((t) => t.auto_kind === "pin")), "核对卡当拍 " + B.log().slice(-600));
  } finally { await B.stop(); }
});

test("J1.2 看板当拍:候选组装卡(子卡都完成 → 出卡,扫整合用 scanFresh 的新鲜结果)", { skip: !GIT && "没有 git", timeout: 120000 }, async () => {
  const R = gitRepo();
  const B = await board({ repo: R.dir });
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    const G = (await B.api("POST", "/api/goals", B.operator, { subject: "整合目标", integrate: { target: "refs/heads/main", assemble: true } })).body.task;
    const k1 = await B.card("子一", "alpha", { parentId: G.id }), k2 = await B.card("子二", "alpha", { parentId: G.id });
    await B.api("POST", `/api/tasks/${G.id}/release`, B.operator, { released: true, expected_version: (await B.get(G.id)).aggregate_version });
    await B.deliver(X, k1.id, { head_commit: R.c1 }); await B.resolve(k1.id, "approve");
    await B.deliver(X, k2.id, { head_commit: R.c2 }); await B.resolve(k2.id, "approve");
    const A = await until(async () => (await B.all()).find((t) => t.auto_kind === "assemble"), 8000);
    assert.ok(A, "候选组装卡当拍 " + B.log().slice(-800));
    assert.match(A.description, new RegExp(`#${k2.id}「子二」 — 提交 ${R.c2.slice(0, 12)} · 待合`), "子二是新鲜扫到的「待合」,不是「未核」");
    assert.match(A.description, new RegExp(`已在目标分支里\\(不用再合\\):#${k1.id}`));
  } finally { await B.stop(); }
});

test("联合(9a × 9c):引用过期在事件当拍记 ref.stale;执行中心跳带 note 给出 refs_stale(回执记 sent),再带 ack + note 记确认 —— live_note 不重跑规则,ref.stale 仍只一次;operator_note 照出", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    const S = await B.card("规格", "beta"), R = await B.card("照规格", "alpha", { refs: [S.id] });
    const run = (await B.claim(X, R.id)).run_id;
    assert.equal((await B.edit(S.id, { description: "第二版" })).status, 200);
    assert.ok(await until(async () => (await B.history(R.id)).some((e) => e.kind === "ref.stale")), "ref.stale 当拍");
    const hb1 = await B.api("POST", `/api/tasks/${R.id}/heartbeat`, X.token, { run_id: run, note: "看到了" });
    assert.equal(hb1.status, 200); assert.ok(Array.isArray(hb1.body.refs_stale) && hb1.body.refs_stale.length === 1, JSON.stringify(hb1.body));
    const hb2 = await B.api("POST", `/api/tasks/${R.id}/heartbeat`, X.token, { run_id: run, note: "读过新版", ack: ["refs_stale"] });
    assert.equal(hb2.status, 200); assert.deepEqual(hb2.body.acked, ["refs_stale"]);
    await delay(400);
    assert.equal((await B.history(R.id)).filter((e) => e.kind === "ref.stale").length, 1, "live_note 不重跑规则;同一版本只一次");
    const t = await B.get(R.id);
    const n = t.receipts.notices.find((x) => x.code === "refs_stale");
    assert.ok(n && n.sent_at && n.acked_at, JSON.stringify(t.receipts));
    await B.report(X, R.id, { outcome: "done", evidence: "做完了" });
    await B.resolve(R.id, "reject", "再看一下第二版");
    const t2 = await B.get(R.id);
    assert.equal(t2.operator_note?.text, "再看一下第二版");
    assert.equal(t2.stuck, null, "一次退回不到阈值(增量计数)");
  } finally { await B.stop(); }
});

test("联合(9a × 9c):执行者拉卡面(card_reads 写库)与心跳带 ack(notice_acks 写库)不发 task.*,不触发自动规则;下一个真事件按水位补上", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    const S = await B.card("规格", "beta"), R = await B.card("照规格", "alpha", { refs: [S.id] }), Z = await B.card("不相干", "alpha");
    const run = (await B.claim(X, R.id)).run_id;
    assert.equal((await B.api("POST", `/api/tasks/${R.id}/heartbeat`, X.token, { run_id: run })).status, 200);   // task.started
    await B.edit(S.id, { description: "第二版" });                                                                  // 给出 refs_stale 提示的前提
    await delay(300);
    const at = new Date().toISOString();
    for (let i = 0; i < 3; i++) B.dbWrite("INSERT INTO task_events(at, task_id, kind, actor, detail) VALUES(?,?,?,?,?)", at, R.id, "reap", "system", "{}");
    const stuckOf = async () => (await B.history(R.id)).filter((e) => e.kind === "task.stuck").length;
    assert.equal((await B.api("GET", `/api/tasks/${R.id}`, X.token)).status, 200);                                   // 记 card_reads
    const hb = await B.api("POST", `/api/tasks/${R.id}/heartbeat`, X.token, { run_id: run, ack: ["refs_stale"] });     // 记 notice_sent / notice_acks
    assert.equal(hb.status, 200, JSON.stringify(hb.body));
    await delay(800);
    assert.equal(await stuckOf(), 0, "回执写库不触发规则");
    const rc = (await B.get(R.id)).receipts;
    assert.ok(rc.read && rc.notices.some((n) => n.code === "refs_stale"), JSON.stringify(rc));
    assert.equal((await B.edit(Z.id, { summary: "碰一下" })).status, 200);
    assert.ok(await until(async () => (await stuckOf()) === 1), "下一个真事件按水位补上");
  } finally { await B.stop(); }
});

test("联合(9a × 8f):未放行的复审卡不拖住目标结案、放行后目标重开(completeGoals 未改,仍在回收定时里整板跑);复审判 deviates 的当拍,被复审卡出 spec_deviation(「复审」闸 deviationMissing 读同一条结论)", { timeout: 150000 }, async () => {
  const B = await board({ env: { BOARD_REAP_MS: "500" } });   // 自动规则的定时兜底仍关着;只有回收定时(目标结案在这里)开着
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" }), Y = await B.connectAs({ kind: "claude", line: "beta" });
    const G = (await B.api("POST", "/api/goals", B.operator, { subject: "目标" })).body.task;
    await B.api("POST", `/api/tasks/${G.id}/release`, B.operator, { released: true, expected_version: (await B.get(G.id)).aggregate_version });
    const S = await B.card("别线规格", "beta");
    const K = await B.card("子卡", "alpha", { parentId: G.id, refs: [{ card: S.id, review: true }] });
    await B.deliver(X, K.id, { files: [{ path: "src/a.mjs", sha256: "a".repeat(64) }] });
    const RC = await until(async () => (await B.all()).find((t) => t.auto_kind === "spec_review" && t.parent_id === G.id));
    assert.ok(RC && !RC.released, "复审卡当拍出在目标下、未放行");
    await B.resolve(K.id, "approve");
    assert.ok(await until(async () => (await B.get(G.id)).status === "done", 6000), "未放行的复审卡不拖住目标结案");
    // 放行复审卡 → 目标重开(它照常计了)
    await B.api("POST", `/api/tasks/${RC.id}/release`, B.operator, { released: true, expected_version: (await B.get(RC.id)).aggregate_version });
    assert.ok(await until(async () => (await B.get(G.id)).status !== "done", 6000), "放行后目标重开");
    // 复审卡判 deviates → 当拍记结论;被复审卡(已完成)出 spec_deviation 标记
    await B.claim(Y, RC.id);
    await B.report(Y, RC.id, { outcome: "done", evidence: "不符:少了一节", checks: [{ name: "spec_conformance", status: "fail", how: "ran" }] });
    await B.resolve(RC.id, "approve");
    const k = await until(async () => { const t = await B.get(K.id); return t.spec_review?.verdict === "deviates" ? t : null; });
    assert.ok(k, "deviates 当拍记下 " + B.log().slice(-600));
    assert.ok(k.badge.flags.includes("spec_deviation"), JSON.stringify(k.badge));
  } finally { await B.stop(); }
});
