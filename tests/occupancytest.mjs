import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 合同 I6–I9(第 8 波 8b):文件占用表(声明 / 交付两种来源、目录前缀、重叠应答与事件去重、执行者只能声明自己持的卡、
// 轮次结束后声明失效)、「整合」阶段(临时 git 仓三态、缓存不在请求路径跑 git、ref 名乱值 400)、条件放行(触发一次、撤销、
// 源卡归档 broken、不绕祖先放行闸、首页「要本人做的事」不列)、候选组装卡(只出一次、待合清单与缺的必需检查、重开后重拼)、
// 写权限矩阵、真 stdio 桥 declare_paths 与不带新字段的旧用法。不调用任何模型。`node --test tests/occupancytest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { normTouch, normTouches, overlapOf, PATHS_MAX } from "../core/occupancy.mjs";
import { normTarget, normIntegrate, openIntegrate, gitQuery } from "../core/integrate.mjs";
import { normReleaseOn, topoOrder, composeAssemble } from "../core/autocards.mjs";
import { stageOf } from "../core/home-background.mjs";
import { gitQueryEnv } from "../core/credibility.mjs";
import { resolveGit } from "../core/git-program.mjs";
import { freePort } from "./helpers/free-port.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ERR = { NOT_FOUND: "NOT_FOUND", CONFLICT: "CONFLICT", BAD_INPUT: "BAD_INPUT" };
const err = (code, message) => Object.assign(new Error(message), { code });
const ctx = { err, ERR };
const sha = (x) => createHash("sha256").update(x).digest("hex");
const GIT = resolveGit({ env: process.env }).path;

/** 临时 git 仓:main 上 c1 → c3;side 分支从 c1 出 c2、c4(都没合进 main)。 */
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "occtest-repo-"));
  const g = (...a) => execFileSync(GIT, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "core.autocrlf=false", "-C", dir, ...a],
                                   { env: gitQueryEnv(HOST_ENV), windowsHide: true }).toString().trim();
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n"); g("add", "-A"); g("commit", "-q", "-m", "c1");
  const c1 = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "side");
  writeFileSync(join(dir, "b.txt"), "two\n"); g("add", "-A"); g("commit", "-q", "-m", "c2");
  const c2 = g("rev-parse", "HEAD");
  writeFileSync(join(dir, "b.txt"), "four\n"); g("add", "-A"); g("commit", "-q", "-m", "c4");
  const c4 = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  writeFileSync(join(dir, "c.txt"), "three\n"); g("add", "-A"); g("commit", "-q", "-m", "c3");
  const c3 = g("rev-parse", "HEAD");
  return { dir, c1, c2, c3, c4 };
}
const until = async (fn, ms = 8000, step = 100) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v || Date.now() > end) return v; await delay(step); } };

// ── 纯函数 ───────────────────────────────────────────────────────────────────────
test("I6 路径:规则同 H1;结尾 / 保留为目录前缀;≤50 去重;重叠 = 相同或目录前缀(取更具体的那条)", () => {
  assert.equal(normTouch("src\\a.txt", ctx), "src/a.txt");
  assert.equal(normTouch("./src//", ctx), "src/");
  assert.equal(normTouch("docs\\", ctx), "docs/");
  for (const bad of ["/etc/x", "C:/x", "../x", "a/../../x", ".git/config", "a:b", "", "/", 7])
    assert.throws(() => normTouch(bad, ctx), (e) => e.code === "BAD_INPUT", JSON.stringify(bad));
  assert.deepEqual(normTouches(["a", "./a", "b/"], ctx), ["a", "b/"]);
  assert.equal(normTouches(null, ctx), null);
  assert.throws(() => normTouches(Array.from({ length: PATHS_MAX + 1 }, (_, i) => "f" + i), ctx), /50/);
  assert.throws(() => normTouches("a.txt", ctx), /数组/);
  assert.equal(overlapOf("a.txt", "a.txt"), "a.txt");
  assert.equal(overlapOf("src/", "src/x/y.mjs"), "src/x/y.mjs");
  assert.equal(overlapOf("src/x/", "src/"), "src/x/");
  assert.equal(overlapOf("src", "src/x"), null, "没有 / 结尾的不是目录前缀");
  assert.equal(overlapOf("srcx/a", "src/"), null);
});

test("I7 target:只收 refs/heads/… 的完整引用名;乱值一律 BAD_INPUT", () => {
  for (const ok of ["refs/heads/main", "refs/heads/claude/home-v2-int", "refs/heads/a.b_c-1"]) assert.equal(normTarget(ok, ctx), ok);
  for (const bad of ["main", "refs/tags/v1", "refs/heads/", "refs/heads/a..b", "refs/heads/a//b", "refs/heads/-x", "refs/heads/.x", "refs/heads/x.lock",
                     "refs/heads/a b", "refs/heads/x^{tree}", "refs/heads/x@{1}", "refs/heads/x/", "--output=x", "refs/heads/" + "a".repeat(200), 1, null])
    assert.throws(() => normTarget(bad, ctx), (e) => e.code === "BAD_INPUT", JSON.stringify(bad));
  assert.deepEqual(normIntegrate({ target: "refs/heads/main" }, ctx), { target: "refs/heads/main", assemble: false });
  assert.equal(normIntegrate(null, ctx), null);
  assert.throws(() => normIntegrate({ target: "refs/heads/main", assemble: "yes" }, ctx), /assemble/);
  assert.throws(() => normIntegrate({ target: "refs/heads/main", extra: 1 }, ctx), /extra/);
});

test("I8 release_on 形状;I9 拓扑序与候选组装卡面(不写本机绝对路径)", () => {
  assert.deepEqual(normReleaseOn({ card: 3, event: "done" }, ctx), { card: 3, event: "done" });
  assert.equal(normReleaseOn(null, ctx), null);
  for (const bad of [{ card: 0, event: "done" }, { card: 3, event: "merged" }, { card: "3", event: "done" }, { card: 3, event: "done", x: 1 }, [], "3"])
    assert.throws(() => normReleaseOn(bad, ctx), (e) => e.code === "BAD_INPUT", JSON.stringify(bad));
  const order = topoOrder([{ id: 5, blocked_by: "[7]" }, { id: 7, blocked_by: "[]" }, { id: 6, blocked_by: "[99]" }]).map((k) => k.id);
  assert.deepEqual(order, [6, 7, 5], "依赖在前;组外依赖不算;同层按卡号");
  const k = (o) => ({ id: 1, title: "t", head: null, state: "unknown", verified: [], self: [], missing: [], baseline: [], paths: [], ...o });
  const c = composeAssemble({ goal: { id: 9, title: "目标" }, target: "refs/heads/main", target_sha: "f".repeat(40), kids: [
    k({ id: 2, title: "甲", head: "a".repeat(40), state: "pending", verified: [{ name: "unit", status: "pass" }], self: [{ name: "e2e", status: "pass" }], missing: ["e2e"], paths: ["src/a.mjs"] }),
    k({ id: 3, title: "乙", head: null, state: "unknown", paths: ["src/"], baseline: [{ check: "lint", by: "executor" }] }),
    k({ id: 4, title: "丙", head: "b".repeat(40), state: "merged" })] });
  assert.match(c.subject, /^候选组装:目标/);
  assert.match(c.description, /1\. #2「甲」 — 提交 aaaaaaaaaaaa · 待合/);
  assert.match(c.description, /没跑的必需检查:e2e/);
  assert.match(c.description, /已核检查:unit 通过;自报检查:e2e 通过/);
  assert.match(c.description, /#3「乙」 — 没有交付提交/);
  assert.match(c.description, /已在目标分支里\(不用再合\):#4 bbbbbbbbbbbb/);
  assert.match(c.description, /src\/a\.mjs\(#2、#3\)/);
  assert.match(c.description, /基线已红:#3 lint\(自报\)/);
  assert.match(c.description, /推送后核远端/);
  assert.ok(!/[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\//.test(c.description), "不写本机绝对路径");
});

test("I7 stageOf:目标写了 integrate、子卡全完成且有待合 = integrate;stage_detail.integrate 照实给;没写同现状", () => {
  const g = { id: 1, kind: "goal", status: "in_progress", released: 1, children_total: 3, children_done: 3 };
  const integ = { merged: 1, pending: 1, unknown: 1, target: "refs/heads/main", target_sha: "a".repeat(40), all_done: true };
  assert.deepEqual(stageOf(g, [], integ), { stage: "integrate", stage_detail: { done: 3, total: 3, integrate: { merged: 1, pending: 1, unknown: 1, target: "refs/heads/main", target_sha: "a".repeat(40) } } });
  assert.equal(stageOf(g, [], { ...integ, pending: 0 }).stage, "accept", "没有待合 = 照旧");
  assert.equal(stageOf({ ...g, children_done: 2 }, [{ status: "in_progress" }], { ...integ, all_done: false }).stage, "execute");
  assert.equal(stageOf({ ...g, children_total: 4 }, [{ status: "not_started" }], integ).stage, "integrate", "候选组装卡还开着不影响(all_done 不算它)");
  assert.deepEqual(stageOf(g), { stage: "accept", stage_detail: { done: 3, total: 3 } }, "没写 integrate 同现状");
});

test("I7 只读核:merged / pending / unknown 三态;请求路径(summary / childField)不跑 git,只有定时扫跑(计数桩)", { skip: !GIT && "没有 git" }, async () => {
  const R = gitRepo();
  try {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, kind TEXT, parent_id INTEGER, status TEXT, line TEXT, archived_at TEXT, blocked_by TEXT)");
    const ins = db.prepare("INSERT INTO tasks (id, kind, parent_id, status, line) VALUES (?,?,?,?,?)");
    ins.run(1, "goal", null, "in_progress", null);
    ins.run(2, "task", 1, "done", "alpha"); ins.run(3, "task", 1, "done", "alpha"); ins.run(4, "task", 1, "done", "alpha");
    ins.run(5, "task", 1, "done", "alpha"); ins.run(6, "task", 1, "done", "norepo");
    const heads = { 2: R.c1, 3: R.c2, 4: null, 5: "0123456789abcdef0123456789abcdef01234567", 6: R.c1 };
    let calls = 0;
    const I = openIntegrate({ db, err, ERR, git: () => GIT, repoForLine: (l) => (l === "alpha" ? R.dir : null), headOf: (id) => heads[id] ?? null,
                              query: (...a) => { calls++; return gitQuery(...a); } });
    I.migrate();
    I.set(1, normIntegrate({ target: "refs/heads/main" }, ctx), "operator");
    for (let i = 0; i < 5; i++) { I.summary(1); I.childField({ id: 2, parent_id: 1, status: "done", line: "alpha" }); }
    assert.equal(calls, 0, "请求路径不跑 git");
    assert.equal(I.summary(1).unknown, 5, "扫之前都是未核");
    await I.scan();
    const used = calls;
    assert.ok(used >= 3, String(used));
    const s = I.summary(1);
    assert.deepEqual([s.merged, s.pending, s.unknown, s.target, s.target_sha, s.all_done], [1, 1, 3, "refs/heads/main", R.c3, true]);
    assert.deepEqual(s.kids.map((k) => [k.id, k.state]), [[2, "merged"], [3, "pending"], [4, "unknown"], [5, "unknown"], [6, "unknown"]]);
    assert.deepEqual(I.childField({ id: 3, parent_id: 1, status: "done", line: "alpha" }), { state: "pending", target: "refs/heads/main" });
    assert.equal(I.childField({ id: 3, parent_id: 1, status: "in_progress", line: "alpha" }), null, "没完成的子卡没有 integration");
    for (let i = 0; i < 5; i++) I.summary(1);
    assert.equal(calls, used, "读缓存不再跑 git");
    assert.equal(I.summary(99), null, "没写 integrate 的目标 = null");
    // 目标分支不存在:全部未核
    I.set(1, normIntegrate({ target: "refs/heads/nope" }, ctx), "operator");
    await I.scan();
    assert.equal(I.summary(1).unknown, 5);
  } finally { rmSync(R.dir, { recursive: true, force: true }); }
});

// ── 看板进程(HTTP + 真 stdio 桥)─────────────────────────────────────────────────
async function board({ repo = null, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "occupancytest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines: [
    { id: "alpha", label: "甲", external: true, ...(repo ? { work_repo: repo } : {}) },
    { id: "beta", label: "乙", external: true, ...(repo ? { work_repo: repo } : {}) },
  ], roles: [], routes: ["default"], repo: dir }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit",
           BOARD_DELIVERABLE_GATE: "off", BOARD_INTEGRATE_SCAN_MS: "300", BOARD_REAP_MS: "600000", ...extraEnv } });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const tok = (n) => readFileSync(join(dir, n), "utf8").trim();
  const operator = tok("board_token"), worker = tok("worker_token"), review = tok("review_token");
  const card = async (subject, line, extra = {}) => {
    const r = await api("POST", "/api/tasks", operator, { subject, line, description: "卡面材料", acceptance: "三句话", ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task;
  };
  const connectAs = async (body) => {
    const c = await api("POST", "/api/connect/codes", operator, body);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await api("POST", "/api/connect/redeem", null, { code: c.body.code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: r.body.executor_id, line: r.body.line, token: r.body.token };
  };
  const get = async (id) => (await api("GET", `/api/tasks/${id}`, operator)).body.task;
  const claim = async (X, id) => {
    const cur = await get(id);
    const cl = await api("POST", `/api/tasks/${id}/claim`, X.token, { expected_version: cur.aggregate_version });
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    return cl.body;
  };
  const deliver = async (X, id, extra = {}) => {
    const run = (await claim(X, id)).task.run_id;
    const r = await api("POST", `/api/tasks/${id}/report`, X.token, { run_id: run, outcome: "done", evidence: "做完了", ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const approve = async (id) => {
    const r = await api("POST", `/api/tasks/${id}/resolve`, operator, { verdict: "approve", note: "", expected_version: (await get(id)).aggregate_version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const release = async (id, released = true) => {
    const r = await api("POST", `/api/tasks/${id}/release`, operator, { released, expected_version: (await get(id)).aggregate_version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const dbRead = (sql, ...a) => { const d = new DatabaseSync(join(dir, "board.db"), { readOnly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, worker, review, card, connectAs, get, claim, deliver, approve, release, dbRead, stop, log: () => log };
}

test("I6 看板:声明 / 交付两种来源、目录前缀、领卡 / 声明 / 交付应答带 overlaps、事件去重、只能声明自己持的卡、轮次结束后声明失效", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" }), Y = await B.connectAs({ kind: "claude", line: "beta" });
    const S = await B.connectAs({ kind: "claude", role: "assistant" });
    const A = await B.card("改 src", "alpha", { touches: ["src/", "README.md"] });
    assert.deepEqual(A.touches, ["src/", "README.md"]);
    const Bc = await B.card("改文档", "beta");
    assert.deepEqual((await B.claim(X, A.id)).overlaps, [], "领卡应答带 overlaps(此刻没人重叠)");
    const runB = (await B.claim(Y, Bc.id)).task.run_id;
    // 执行者声明:只能给自己这一轮持的卡
    assert.equal((await B.api("POST", `/api/tasks/${A.id}/paths`, Y.token, { paths: ["x"] })).status, 404, "别的线的卡:绑线执行者看不到");
    const notMine = await B.card("别人的", "beta");
    assert.equal((await B.api("POST", `/api/tasks/${notMine.id}/paths`, Y.token, { paths: ["x"] })).status, 409, "没领的卡不能声明");
    assert.equal((await B.api("POST", `/api/tasks/${Bc.id}/paths`, Y.token, { paths: ["x"], run_id: "run-other" })).status, 409, "run 对不上");
    assert.equal((await B.api("POST", `/api/tasks/${Bc.id}/paths`, Y.token, { paths: ["../x"] })).status, 400);
    assert.equal((await B.api("POST", `/api/tasks/${Bc.id}/paths`, Y.token, { paths: Array.from({ length: 51 }, (_, i) => "f" + i) })).status, 400);
    const d1 = await B.api("POST", `/api/tasks/${Bc.id}/paths`, Y.token, { paths: ["src/a.txt", "docs/"], run_id: runB });
    assert.equal(d1.status, 200, JSON.stringify(d1.body));
    assert.deepEqual(d1.body.overlaps, [{ path: "src/a.txt", with: [{ id: A.id, line: "alpha" }] }], "目录前缀 src/ 覆盖 src/a.txt");
    // 占用表(操作员):声明来源、两张卡、重叠
    let occ = (await B.api("GET", "/api/occupancy", B.operator)).body;
    assert.deepEqual(occ.overlaps, [{ path: "src/a.txt", cards: [A.id, Bc.id] }]);
    const rowA = occ.rows.find((r) => r.path === "src/");
    assert.deepEqual(rowA.cards.map((c) => [c.id, c.line, c.state, c.source]), [[A.id, "alpha", "running", "declared"]]);
    assert.ok(occ.rows.some((r) => r.path === "docs/" && r.cards[0].id === Bc.id));
    // 任务对象同形 overlaps
    assert.deepEqual((await B.get(A.id)).overlaps, [{ path: "src/a.txt", with: [{ id: Bc.id, line: "beta" }] }]);
    // 事件去重:同一对卡同一路径只记一次
    await B.api("POST", `/api/tasks/${Bc.id}/paths`, Y.token, { paths: ["src/a.txt", "docs/"] });
    await B.api("POST", `/api/tasks/${Bc.id}/paths`, Y.token, { paths: ["src/a.txt"] });
    assert.deepEqual(B.dbRead("SELECT a, b, path FROM occ_overlap_events ORDER BY path").map((r) => [r.a, r.b, r.path]), [[A.id, Bc.id, "src/a.txt"]]);
    // 绑线执行者读占用表:别的线的卡只有卡号与线,没有标题
    const occX = (await B.api("GET", "/api/occupancy", X.token)).body;
    const other = occX.rows.flatMap((r) => r.cards).find((c) => c.id === Bc.id);
    assert.equal(other.title, null);
    assert.equal(occX.rows.flatMap((r) => r.cards).find((c) => c.id === A.id).title, "改 src");
    // 助手:读不到占用表;简报里只有重叠条数
    assert.equal((await B.api("GET", "/api/occupancy", S.token)).status, 403);
    const brief = (await B.api("GET", "/api/brief", S.token)).body;
    assert.equal(brief.occupancy_overlaps, 1);
    assert.ok(!JSON.stringify((await B.api("GET", `/api/tasks/${A.id}`, S.token)).body).includes("src/a.txt"), "助手看到的卡面没有路径");
    // 交付:这一轮的声明失效,交付的 files 进占用表(state delivered);应答带 overlaps
    const rep = await B.api("POST", `/api/tasks/${Bc.id}/report`, Y.token, { run_id: runB, outcome: "done", evidence: "做完",
      files: [{ path: "src/b.txt", sha256: "1".repeat(64) }] });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    assert.deepEqual(rep.body.overlaps, [{ path: "src/b.txt", with: [{ id: A.id, line: "alpha" }] }]);
    occ = (await B.api("GET", "/api/occupancy", B.operator)).body;
    assert.ok(!occ.rows.some((r) => r.path === "docs/" || r.path === "src/a.txt"), "交付后这一轮的声明失效:" + JSON.stringify(occ.rows));
    assert.deepEqual(occ.rows.find((r) => r.path === "src/b.txt").cards.map((c) => [c.id, c.state, c.source]), [[Bc.id, "delivered", "delivered"]]);
    // 验收后不再占用
    await B.approve(Bc.id);
    occ = (await B.api("GET", "/api/occupancy", B.operator)).body;
    assert.ok(!occ.rows.some((r) => r.cards.some((c) => c.id === Bc.id)));
    assert.deepEqual(occ.overlaps, []);
    // 不拦:有重叠照样能领、能交付
    const C2 = await B.card("同处", "beta", { touches: ["src/"] });
    const cl = await B.claim(Y, C2.id);
    assert.deepEqual(cl.overlaps, [{ path: "src/", with: [{ id: A.id, line: "alpha" }] }]);
    // 操作者改 touches(专门接口)
    const tw = await B.api("POST", `/api/tasks/${A.id}/touches`, B.operator, { touches: ["lib/"] });
    assert.equal(tw.status, 200, JSON.stringify(tw.body));
    assert.deepEqual(tw.body.task.touches, ["lib/"]);
    assert.equal((await B.api("POST", `/api/tasks/${A.id}/touches`, B.operator, { touches: ["C:/abs"] })).status, 400);
  } finally { await B.stop(); }
});

test("I7 / I9 看板:整合三态与 stage=integrate;候选组装卡只出一次、待合清单 + 缺的必需检查、重开再完成后重拼;ref 名乱值 400", { skip: !GIT && "没有 git", timeout: 120000 }, async () => {
  const R = gitRepo();
  const B = await board({ repo: R.dir });
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    for (const bad of ["main", "refs/heads/a..b", "refs/tags/v1", "--upload-pack=x"]) {
      assert.equal((await B.api("POST", "/api/goals", B.operator, { subject: "g", integrate: { target: bad } })).status, 400, bad);
    }
    const plain = (await B.api("POST", "/api/goals", B.operator, { subject: "不写整合" })).body.task;
    assert.equal(plain.integrate, null);
    const gr = await B.api("POST", "/api/goals", B.operator, { subject: "整合目标", integrate: { target: "refs/heads/main", assemble: true } });
    assert.equal(gr.status, 201, JSON.stringify(gr.body));
    const G = gr.body.task;
    assert.deepEqual(G.integrate, { target: "refs/heads/main", assemble: true });
    assert.equal((await B.api("POST", `/api/tasks/${G.id}/integrate`, B.operator, { integrate: { target: "refs/heads/x y" } })).status, 400);
    // k1 已在 main 里;k2(要必需检查 unit,只有自报)在 side 上待合,依赖 k1;k3 没有提交
    const k1 = await B.card("子一", "alpha", { parentId: G.id });
    const k2 = await B.card("子二", "alpha", { parentId: G.id, blockedBy: [k1.id], required_checks: ["unit"] });
    const k3 = await B.card("子三", "alpha", { parentId: G.id });
    await B.release(G.id);
    await B.deliver(X, k1.id, { head_commit: R.c1 }); await B.approve(k1.id);
    await B.deliver(X, k2.id, { head_commit: R.c2, files: [{ path: "b.txt", sha256: sha("two\n") }], checks: [{ name: "unit", status: "pass", how: "ran" }] }); await B.approve(k2.id);
    await B.deliver(X, k3.id); await B.approve(k3.id);
    // 候选组装卡:未放行、挂在目标下、auto_kind
    const autos = async () => (await B.api("GET", "/api/tasks?archived=all", B.operator)).body.tasks.filter((t) => t.auto_kind === "assemble");
    const list = await until(async () => { const a = await autos(); return a.length ? a : null; });
    assert.equal(list?.length, 1, B.log().slice(-2000));
    const A = list[0];
    assert.equal(A.parent_id, G.id); assert.equal(!!A.released, false); assert.equal(A.status, "not_started");
    assert.match(A.description, new RegExp(`#${k2.id}「子二」 — 提交 ${R.c2.slice(0, 12)} · 待合`));
    assert.match(A.description, new RegExp(`已在目标分支里\\(不用再合\\):#${k1.id} ${R.c1.slice(0, 12)}`));
    assert.match(A.description, new RegExp(`#${k3.id}「子三」 — 没有交付提交`));
    assert.match(A.description, /没跑的必需检查:unit/, "k2 只有自报的 unit");
    assert.match(A.description, /自报检查:unit 通过/);
    assert.match(A.description, /推送后核远端/);
    assert.ok(!A.description.includes(R.dir) && !A.description.includes(B.dir), "说明里不写本机路径");
    const order = [...A.description.matchAll(/^\d+\. #(\d+)/gm)].map((m) => Number(m[1]));
    assert.deepEqual(order, [k2.id, k3.id], "待合清单按依赖先后(已合的不在待合里)");
    // 整合三态、子卡 integration、组头 stage = integrate
    const bg = await until(async () => { const b = (await B.api("GET", "/api/home/background", B.operator)).body; const g = b.groups.find((x) => x.goal_id === G.id);
      return g?.stage === "integrate" ? g : null; });
    assert.ok(bg, JSON.stringify((await B.api("GET", "/api/home/background", B.operator)).body.groups));
    assert.deepEqual(bg.stage_detail.integrate, { merged: 1, pending: 1, unknown: 1, target: "refs/heads/main", target_sha: R.c3 });
    assert.deepEqual((await B.get(k1.id)).integration, { state: "merged", target: "refs/heads/main" });
    assert.deepEqual((await B.get(k2.id)).integration, { state: "pending", target: "refs/heads/main" });
    assert.deepEqual((await B.get(k3.id)).integration, { state: "unknown", target: "refs/heads/main" });
    assert.equal((await B.get(A.id)).integration, null, "候选组装卡自己不算子卡");
    // 再扫几轮也只出一次
    await delay(900);
    assert.equal((await autos()).length, 1);
    // 子卡重开再完成(换了提交)→ 重拼说明;仍只有一张
    const re = await B.api("POST", `/api/tasks/${k2.id}/reopen`, B.operator, { expected_version: (await B.get(k2.id)).aggregate_version });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    await B.deliver(X, k2.id, { head_commit: R.c4 }); await B.approve(k2.id);
    const again = await until(async () => { const t = await B.get(A.id); return t.description.includes(R.c4.slice(0, 12)) ? t : null; });
    assert.ok(again, (await B.get(A.id)).description);
    assert.equal((await autos()).length, 1);
    assert.equal(B.dbRead("SELECT COUNT(*) AS n FROM auto_triggers WHERE rule='assemble'")[0].n, 1, "触发记录防重");
  } finally { await B.stop(); rmSync(R.dir, { recursive: true, force: true }); }
});

test("I8 看板:条件放行只触发一次、撤销、delivered、源卡归档 broken、不绕祖先放行闸;「要本人做的事」不列等条件的卡", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    const S = await B.card("源", "alpha");
    const T = await B.card("等源完成", "alpha", { release_on: { card: S.id, event: "done" } });
    assert.equal(!!T.released, false, "条件放行的卡建成未放行");
    let t = await B.get(T.id);
    assert.deepEqual([t.release_on.card, t.release_on.event, t.release_on.broken, t.release_on.fired], [S.id, "done", false, false]);
    assert.ok(t.progress_blockers.some((b) => b.code === "RELEASE_ON_PENDING" && b.related_task_ids[0] === S.id), JSON.stringify(t.progress_blockers));
    const U = await B.card("普通待放行", "alpha", { released: false });
    const att = async () => (await B.api("GET", "/api/home/background", B.operator)).body.attention.map((a) => a.task_id);
    let ids = await att();
    assert.ok(ids.includes(U.id), "对照:普通未放行卡在「要本人做的事」里");
    assert.ok(!ids.includes(T.id), "等条件的卡不列");
    // 交付不触发 done;验收后触发
    await B.deliver(X, S.id);
    await delay(400);
    assert.equal(!!(await B.get(T.id)).released, false);
    await B.approve(S.id);
    t = await until(async () => { const x = await B.get(T.id); return x.released ? x : null; });
    assert.ok(t, "源卡完成后板放行");
    assert.equal(t.release_on.fired, true);
    assert.ok(!t.progress_blockers.some((b) => b.code === "RELEASE_ON_PENDING"));
    const evs = B.dbRead("SELECT kind, actor FROM task_events WHERE task_id=? ORDER BY id", T.id);
    assert.ok(evs.some((e) => e.kind === "release" && e.actor === "rule"), JSON.stringify(evs));
    assert.equal(evs.filter((e) => e.kind === "release.auto").length, 1);
    const hist = (await B.api("GET", `/api/tasks/${T.id}/history`, B.operator)).body;
    assert.ok(JSON.stringify(hist).includes("按条件自动放行"), JSON.stringify(hist).slice(0, 600));
    // 只触发一次:收回放行后不再自动放
    await B.release(T.id, false);
    await delay(600);
    assert.equal(!!(await B.get(T.id)).released, false);
    assert.equal(B.dbRead("SELECT COUNT(*) AS n FROM task_events WHERE task_id=? AND kind='release.auto'", T.id)[0].n, 1);
    // 已放行的卡不能再写;目标卡、乱事件拒收
    const rel = await B.card("已放行", "alpha");
    assert.equal((await B.api("POST", `/api/tasks/${rel.id}/release-on`, B.operator, { release_on: { card: S.id, event: "done" } })).status, 409);
    assert.equal((await B.api("POST", `/api/tasks/${U.id}/release-on`, B.operator, { release_on: { card: S.id, event: "merged" } })).status, 400);
    assert.equal((await B.api("POST", `/api/tasks/${U.id}/release-on`, B.operator, { release_on: { card: 99999, event: "done" } })).status, 404);
    assert.equal((await B.api("POST", "/api/tasks", B.operator, { subject: "x", line: "alpha", released: true, release_on: { card: S.id, event: "done" } })).status, 400);
    // 撤销
    const S2 = await B.card("源二", "alpha");
    const V = await B.card("撤销的", "alpha", { released: false });
    assert.equal((await B.api("POST", `/api/tasks/${V.id}/release-on`, B.operator, { release_on: { card: S2.id, event: "done" } })).status, 200);
    const rv = await B.api("POST", `/api/tasks/${V.id}/release-on`, B.operator, { release_on: null });
    assert.equal(rv.status, 200); assert.equal(rv.body.task.release_on, null);
    await B.deliver(X, S2.id); await B.approve(S2.id);
    await delay(600);
    assert.equal(!!(await B.get(V.id)).released, false, "撤销后不触发");
    // delivered
    const S3 = await B.card("源三", "alpha");
    const W = await B.card("等交付", "alpha", { release_on: { card: S3.id, event: "delivered" } });
    await B.deliver(X, S3.id);
    assert.ok(await until(async () => (await B.get(W.id)).released), "交付即放行");
    // 源卡归档 → broken,不触发,回到「要本人做的事」
    const S4 = await B.card("源四", "alpha");
    const Z = await B.card("源会归档", "alpha", { release_on: { card: S4.id, event: "done" } });
    const ar = await B.api("POST", `/api/tasks/${S4.id}/archive`, B.operator, { expected_version: (await B.get(S4.id)).aggregate_version, force: true });
    assert.equal(ar.status, 200, JSON.stringify(ar.body));
    t = await B.get(Z.id);
    assert.equal(t.release_on.broken, true);
    assert.ok(!t.progress_blockers.some((b) => b.code === "RELEASE_ON_PENDING"));
    ids = await att();
    assert.ok(ids.includes(Z.id), "条件坏了:交给人");
    // 不绕祖先放行闸:目标未放行,条件到了只放行这张卡本身,照样领不走
    const G = (await B.api("POST", "/api/goals", B.operator, { subject: "未放行的目标" })).body.task;
    const S5 = await B.card("源五", "alpha");
    const C = await B.card("祖先未放行", "alpha", { parentId: G.id, release_on: { card: S5.id, event: "done" } });
    await B.deliver(X, S5.id); await B.approve(S5.id);
    assert.ok(await until(async () => (await B.get(C.id)).released), "条件到了照样放行这张卡");
    assert.equal(!!(await B.get(G.id)).released, false, "不顺手放行祖先");
    const cl = await B.api("POST", `/api/tasks/${C.id}/claim`, X.token, { expected_version: (await B.get(C.id)).aggregate_version });
    assert.equal(cl.status, 409, JSON.stringify(cl.body));
    assert.match(cl.body.error, /祖先/);
  } finally { await B.stop(); }
});

test("写权限矩阵:touches / release-on / integrate 只给操作者;declare_paths 只给持卡执行者;worker 派生卡带新字段 403;助手挂卡带 400", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    const S = await B.connectAs({ kind: "claude", role: "assistant" });
    const G = (await B.api("POST", "/api/goals", B.operator, { subject: "目标" })).body.task;
    const t = await B.card("权限", "alpha", { released: false });
    const bodies = { touches: { touches: ["a"] }, "release-on": { release_on: { card: G.id, event: "done" } }, integrate: { integrate: { target: "refs/heads/main" } } };
    for (const [path, body] of Object.entries(bodies))
      for (const [who, tk] of [["executor", X.token], ["assistant", S.token], ["worker", B.worker], ["review", B.review]]) {
        const id = path === "integrate" ? G.id : t.id;
        const r = await B.api("POST", `/api/tasks/${id}/${path}`, tk, body);
        assert.equal(r.status, 403, `${who} ${path} ${JSON.stringify(r.body)}`);
      }
    for (const [who, tk] of [["operator", B.operator], ["worker", B.worker], ["review", B.review], ["assistant", S.token]])
      assert.equal((await B.api("POST", `/api/tasks/${t.id}/paths`, tk, { paths: ["a"] })).status, 403, who);
    // worker 派生卡带新字段 → 403;助手挂卡带 → 400
    const parent = await B.card("父", "alpha");
    for (const k of ["touches", "release_on", "integrate"]) {
      const v = k === "touches" ? ["a"] : k === "release_on" ? { card: G.id, event: "done" } : { target: "refs/heads/main" };
      assert.equal((await B.api("POST", "/api/tasks", B.worker, { subject: "派生", parentId: parent.id, [k]: v })).status, 403, k);
      assert.equal((await B.api("POST", "/api/assistant/cards", S.token, { subject: "s", description: "d", acceptance: "a", [k]: v })).status, 400, k);
    }
    // integrate 只写在目标卡上
    assert.equal((await B.api("POST", `/api/tasks/${t.id}/integrate`, B.operator, { integrate: { target: "refs/heads/main" } })).status, 400);
    assert.equal((await B.api("POST", `/api/tasks/${G.id}/integrate`, B.operator, { integrate: { target: "refs/heads/main" } })).status, 200);
    assert.equal((await B.api("POST", `/api/tasks/${G.id}/integrate`, B.operator, { integrate: null })).body.task.integrate, null);
    // 写入都没生效
    const after = await B.get(t.id);
    assert.deepEqual([after.touches, after.release_on], [[], null]);
  } finally { await B.stop(); }
});

/** 真 stdio 桥子进程(与 credibilitytest 同形)。 */
function bridge(args) {
  const child = spawn(process.execPath, [join(ROOT, "cli", "exec-mcp.mjs"), ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: HOST_ENV });
  let buf = "", errText = ""; const waiting = new Map(), got = new Map();
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { errText += d; });
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else got.set(m.id, m);
    }
  });
  let next = 1;
  const send = (m) => child.stdin.write(JSON.stringify(m) + String.fromCharCode(10));
  const request = (method, params) => { const id = next++; send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return got.has(id) ? Promise.resolve(got.get(id)) : new Promise((r) => waiting.set(id, r)); };
  const call = async (name, a) => (await request("tools/call", { name, arguments: a })).result;
  const end = async () => { child.stdin.end(); await new Promise((r) => child.once("close", r)); };
  return { request, send, call, end, stderr: () => errText };
}
const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "occtest", version: "1" } };
const toolJson = (r) => JSON.parse(r.content[0].text);

test("真 stdio 桥:declare_paths 声明并带回 overlaps;不带新字段的旧用法(领卡、交付)照旧", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" }), Y = await B.connectAs({ kind: "claude", line: "beta" });
    const tf = join(B.dir, "exe_token.txt"); writeFileSync(tf, X.token);
    const M = bridge(["--url", B.base, "--token-file", tf]);
    try {
      assert.ok((await M.request("initialize", INIT)).result, M.stderr());
      M.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = (await M.request("tools/list")).result.tools;
      const dp = tools.find((x) => x.name === "declare_paths");
      assert.deepEqual(dp.inputSchema.required, ["card_id", "paths"]);
      const other = await B.card("乙线", "beta", { touches: ["src/"] });
      await B.claim(Y, other.id);
      const a = await B.card("甲线", "alpha");
      const c = await M.call("claim_card", { id: a.id, expected_version: (await B.get(a.id)).aggregate_version });
      assert.ok(!c.isError, JSON.stringify(c));
      assert.deepEqual(toolJson(c).overlaps, []);
      const d = await M.call("declare_paths", { card_id: a.id, paths: ["src/x.mjs", "lib/"] });
      assert.ok(!d.isError, JSON.stringify(d));
      assert.deepEqual(toolJson(d).paths, ["src/x.mjs", "lib/"]);
      assert.deepEqual(toolJson(d).overlaps, [{ path: "src/x.mjs", with: [{ id: other.id, line: "beta" }] }]);
      assert.ok((await M.call("declare_paths", { card_id: a.id, paths: "src" })).isError, "桥这一侧先挡");
      assert.ok((await M.call("declare_paths", { card_id: a.id, paths: ["../up"] })).isError, "看板拒收越界路径");
      const r = await M.call("report_result", { id: a.id, outcome: "done", evidence: "旧用法交付" });
      assert.ok(!r.isError, JSON.stringify(r));
      assert.equal(toolJson(r).status, "waiting");
      assert.deepEqual(toolJson(r).overlaps, [], "交付后声明失效、没有交付文件 = 不重叠");
      assert.ok((await M.call("declare_paths", { card_id: a.id, paths: ["x"] })).isError, "交付后这张卡不在手上,不能再声明");
      // 旧用法:不声明、不带新字段,领卡交付照旧
      const b = await B.card("甲线二", "alpha");
      assert.ok(!(await M.call("claim_card", { id: b.id, expected_version: (await B.get(b.id)).aggregate_version })).isError);
      const r2 = await M.call("report_result", { id: b.id, outcome: "done", evidence: "x" });
      assert.ok(!r2.isError); assert.equal(toolJson(r2).status, "waiting");
    } finally { await M.end(); }
  } finally { await B.stop(); }
});
