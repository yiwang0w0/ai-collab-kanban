import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 合同 I10d「包」的状态机与 I10e「环境差」(第 8 波 8e):状态机每一格、drift 的三种来路(重报 / 提交核对 / 出包)、当事执行者以外 403、
// 操作者以外不能 ran、助手只见条数、核对卡防重与 release_pin、自动通过闸(带包的卡)、出包缺文件、md 导出不写 label、
// 「要本人做的事」的亲手跑 / fault 条目、target_env 三处入口与 env_gap / not_target_env、真 stdio 桥的六个新工具。
// 不调用任何模型。`node --test tests/packagestest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { derive, gapsOf, compareIssued, normFiles, normPins, tableDigest, composePin, STATES, PACKAGES_PER_CARD } from "../core/packages.mjs";
import { normTargetEnv, normDiffItems } from "../core/env-gap.mjs";
import { packageRelPath, hashUnder } from "../core/mcp/exec-bridge.mjs";
import { gitQueryEnv } from "../core/credibility.mjs";
import { resolveGit } from "../core/git-program.mjs";
import { freePort } from "./helpers/free-port.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ERR = { NOT_FOUND: "NOT_FOUND", CONFLICT: "CONFLICT", BAD_INPUT: "BAD_INPUT" };
const err = (code, message) => Object.assign(new Error(message), { code });
const ctx = { err, ERR };
const sha = (x) => createHash("sha256").update(x).digest("hex");
const GIT = resolveGit({ env: process.env }).path;
const until = async (fn, ms = 8000, step = 100) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v || Date.now() > end) return v; await delay(step); } };

// ── 纯函数:状态机每一格与 drift 的三种来路 ─────────────────────────────────────────
const F1 = { path: "deploy/run.ps1", sha256: sha("one"), bytes: 3 }, F2 = { path: "deploy/conf.json", sha256: sha("two"), bytes: 3 };
const files0 = [F1, F2].sort((a, b) => (a.path < b.path ? -1 : 1));
function walk(steps) {
  const evs = []; let id = 0;
  for (const [kind, data] of steps) evs.push({ id: ++id, kind, data, by: kind === "ran" ? "operator" : kind === "commit_check" ? "board" : "exe", at: `2026-11-14T00:00:${String(id).padStart(2, "0")}Z` });
  return derive({ id: 1, card_id: 9, name: "上线包", created_at: "x" }, evs);
}
const D0 = tableDigest(files0);
const declare = ["declare", { files: files0, expect: "页面能打开", pins: ["首页", "日志"] }];
const freeze = ["freeze", { digest: D0, files: files0 }];
const commit = ["commit", { sha: "a".repeat(40) }];
const issueOk = ["issue", { label: "共享盘「发布」夹", files: files0, match: true, diff: [], missing: [], extra: [] }];
const ranOk = ["ran", { result: "ok", note: null, release_pin: false }];

test("I10d 状态机每一格:draft → frozen → committed → issued → ran → pinned;状态从事实推,取最远一格", () => {
  assert.deepEqual(STATES, ["draft", "frozen", "committed", "issued", "ran", "pinned"]);
  assert.equal(walk([declare]).state, "draft");
  assert.equal(walk([declare, freeze]).state, "frozen");
  assert.equal(walk([declare, freeze, commit]).state, "committed", "提交还没核(verified null)也算到了这一格");
  assert.equal(walk([declare, freeze, commit, ["commit_check", { sha: "a".repeat(40), verified: true, mismatch: [] }]]).commit.verified, true);
  assert.equal(walk([declare, freeze, commit, issueOk]).state, "issued");
  assert.equal(walk([declare, freeze, issueOk]).state, "issued", "没报提交也能出包(committed 一格空着)");
  const ran = walk([declare, freeze, commit, issueOk, ranOk]);
  assert.equal(ran.state, "ran");
  assert.deepEqual(ran.pinned, { n: 0, total: 2, verified: 0, self: 0 });
  const half = walk([declare, freeze, commit, issueOk, ranOk, ["pin", { name: "首页", ok: true, verified: false }]]);
  assert.equal(half.state, "ran");
  assert.deepEqual(half.pinned, { n: 1, total: 2, verified: 0, self: 1 });
  const all = walk([declare, freeze, commit, issueOk, ranOk, ["pin", { name: "首页", ok: true, verified: false }], ["pin", { name: "日志", ok: false, verified: false }],
    ["pin", { name: "日志", ok: true, verified: true }]]);
  assert.equal(all.state, "pinned");
  assert.deepEqual(all.pinned, { n: 2, total: 2, verified: 1, self: 1 });
  assert.equal(walk([declare, freeze, issueOk, ["ran", { result: "failed" }]]).state, "ran", "跑失败也到了 ran 这一格");
  assert.equal(walk([declare, freeze, issueOk, ["ran", { result: "failed" }], ["pin", { name: "首页", ok: true }], ["pin", { name: "日志", ok: true }]]).state, "ran", "最近一次跑失败 = 不算钉住");
  const noPins = walk([["declare", { files: files0, pins: [] }], freeze, issueOk, ranOk]);
  assert.equal(noPins.state, "ran"); assert.deepEqual(gapsOf(noPins), [], "没有要钉的项:ran ok 即满足闸");
  assert.equal(walk([declare, freeze]).frozen.digest, D0);
  // 重新冻结 = 新的一轮:旧的提交 / 出包 / 跑都不算
  const files1 = [{ ...F1, sha256: sha("one-b") }, F2].sort((a, b) => (a.path < b.path ? -1 : 1));
  const re = walk([declare, freeze, commit, issueOk, ranOk, ["declare", { files: files1, pins: [] }], ["freeze", { digest: tableDigest(files1), files: files1 }]]);
  assert.deepEqual([re.state, re.drift, re.commit, re.issued, re.ran], ["frozen", false, null, null, null]);
});

test("I10d drift 的三种来路:冻结后重报不同 / 提交核出不同 / 出包不同;写明停在哪一格之前、哪一步", () => {
  const changed = [{ ...F1, sha256: sha("changed") }, F2].sort((a, b) => (a.path < b.path ? -1 : 1));
  const a = walk([declare, freeze, ["declare", { files: changed, pins: [] }]]);
  assert.deepEqual([a.state, a.drift, a.drift_detail.before, a.drift_detail.step], ["draft", true, "frozen", "declare"]);
  const same = walk([declare, freeze, declare]);
  assert.deepEqual([same.state, same.drift], ["frozen", false], "重报同一份表不算 drift");
  const b = walk([declare, freeze, commit, ["commit_check", { sha: "a".repeat(40), verified: false, mismatch: ["deploy/run.ps1 的内容与冻结表不同"] }]]);
  assert.deepEqual([b.state, b.drift, b.drift_detail.before, b.drift_detail.step], ["frozen", true, "committed", "commit"]);
  assert.deepEqual(b.commit.mismatch, ["deploy/run.ps1 的内容与冻结表不同"]);
  const c = walk([declare, freeze, commit, ["issue", { label: "x", files: [], match: false, diff: [], missing: ["deploy/run.ps1"], extra: [] }]]);
  assert.deepEqual([c.state, c.drift, c.drift_detail.before, c.drift_detail.step], ["committed", true, "issued", "issue"]);
  assert.match(gapsOf(c)[0], /出包后的文件和预审时不一样/);
  // 结论绑 frozen.digest:重冻 / drift 后过期
  const con = walk([declare, freeze, ["conclusion", { kind: "review", verdict: "approve", digest: D0 }]]);
  assert.equal(con.conclusions[0].stale, false);
  assert.equal(walk([declare, freeze, ["conclusion", { kind: "review", verdict: "approve", digest: D0 }], ["declare", { files: changed, pins: [] }]]).conclusions[0].stale, true);
});

test("I10d 出包比对、各项上限与路径规则(复用 H1 的 normPath)、核对卡卡面不写本机路径与 label", () => {
  assert.equal(compareIssued(files0, files0).match, true);
  assert.deepEqual(compareIssued(files0, [F1], ["deploy/conf.json"]), { match: false, diff: [], missing: ["deploy/conf.json"], extra: [] });
  assert.deepEqual(compareIssued(files0, [{ ...F1, sha256: sha("x") }, F2]).diff, ["deploy/run.ps1"]);
  assert.deepEqual(compareIssued(files0, [F1]).missing, ["deploy/conf.json"], "没带也没说缺 = 缺");
  assert.deepEqual(normFiles([{ path: "a\\b.txt", sha256: "A".repeat(64), bytes: 1 }], ctx), [{ path: "a/b.txt", sha256: "a".repeat(64), bytes: 1 }]);
  for (const bad of [[], [{ path: "/abs", sha256: "a".repeat(64), bytes: 1 }], [{ path: "../x", sha256: "a".repeat(64), bytes: 1 }], [{ path: "C:/x", sha256: "a".repeat(64), bytes: 1 }],
                     [{ path: "x", sha256: "zz", bytes: 1 }], [{ path: "x", sha256: "a".repeat(64), bytes: -1 }], [{ path: "x", sha256: "a".repeat(64), bytes: 1, extra: 1 }],
                     [{ path: "x", sha256: "a".repeat(64), bytes: 1 }, { path: "./x", sha256: "b".repeat(64), bytes: 1 }],
                     Array.from({ length: 51 }, (_, i) => ({ path: "f" + i, sha256: "a".repeat(64), bytes: 0 }))])
    assert.throws(() => normFiles(bad, ctx), (e) => e.code === "BAD_INPUT", JSON.stringify(bad).slice(0, 80));
  assert.throws(() => normPins(Array.from({ length: 13 }, (_, i) => "p" + i), ctx), /12/);
  assert.deepEqual(normPins(["a", "a", " b "], ctx), ["a", "b"]);
  assert.equal(PACKAGES_PER_CARD, 5);
  const v = walk([declare, freeze, issueOk, ranOk]);
  const c = composePin({ card: { id: 9, title: "上线" }, pkg: v });
  assert.match(c.subject, /^核对:包「上线包」\(#9\)/);
  assert.match(c.description, /1\. 首页/); assert.match(c.description, /deploy\/run\.ps1 · /); assert.match(c.description, /只读核对/);
  assert.ok(c.description.includes(D0.slice(0, 12)));
  assert.ok(!c.description.includes("共享盘") && !/[A-Za-z]:[\\/]/.test(c.description), "核对卡不写 label 与本机路径");
  // 环境差的形状
  assert.equal(normTargetEnv("  生产  机房 ", ctx), "生产 机房");
  assert.equal(normTargetEnv(null, ctx), null); assert.equal(normTargetEnv("", ctx), null); assert.equal(normTargetEnv(undefined, ctx), undefined);
  assert.throws(() => normTargetEnv("x".repeat(41), ctx), /40/);
  assert.throws(() => normDiffItems(Array.from({ length: 21 }, () => ({ key: "k" })), ctx), /20/);
  assert.throws(() => normDiffItems([{ key: "k", here: "x".repeat(81) }], ctx), /80/);
  assert.deepEqual(normDiffItems([{ key: "node", here: "24", target: "22" }], ctx), [{ key: "node", here: "24", target: "22" }]);
  // 桥这一侧的路径规整与越界
  assert.equal(packageRelPath("a\\b"), "a/b");
  for (const bad of ["/x", "C:/x", "../x", ".git/config", "a:b", ""]) assert.throws(() => packageRelPath(bad), /BAD_INPUT|路径|相对/, bad);
});

test("桥这一侧算哈希:root 下的普通文件;找不到 = null;不出 root", () => {
  const d = mkdtempSync(join(tmpdir(), "pkgtest-hash-"));
  try {
    mkdirSync(join(d, "sub")); writeFileSync(join(d, "sub", "a.txt"), "hello");
    assert.deepEqual(hashUnder(d, "sub/a.txt"), { path: "sub/a.txt", sha256: sha("hello"), bytes: 5 });
    assert.equal(hashUnder(d, "sub/none.txt"), null);
    assert.equal(hashUnder(d, "sub"), null, "目录不是文件");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── 看板进程 ────────────────────────────────────────────────────────────────────
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pkgtest-repo-"));
  const g = (...a) => execFileSync(GIT, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "core.autocrlf=false", "-C", dir, ...a],
                                   { env: gitQueryEnv(HOST_ENV), windowsHide: true }).toString().trim();
  g("init", "-q", "-b", "main");
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "run.ps1"), "one"); writeFileSync(join(dir, "deploy", "conf.json"), "two");
  g("add", "-A"); g("commit", "-q", "-m", "c1");
  const good = g("rev-parse", "HEAD");
  writeFileSync(join(dir, "deploy", "run.ps1"), "one-changed"); g("add", "-A"); g("commit", "-q", "-m", "c2");
  const bad = g("rev-parse", "HEAD");
  return { dir, good, bad };
}
async function board({ repo = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "packagestest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines: [
    { id: "alpha", label: "甲", external: true, ...(repo ? { work_repo: repo } : {}) },
    { id: "auto", label: "自动", external: true, accept: "auto" },
  ], roles: [], routes: ["default"], repo: dir }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit",
           BOARD_DELIVERABLE_GATE: "off", BOARD_INTEGRATE_SCAN_MS: "300", BOARD_REAP_MS: "600000" } });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { j = text; }
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
    const cl = await api("POST", `/api/tasks/${id}/claim`, X.token, { expected_version: (await get(id)).aggregate_version });
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    return cl.body.task.run_id;
  };
  const report = async (X, id, run, extra = {}) => {
    const r = await api("POST", `/api/tasks/${id}/report`, X.token, { run_id: run, outcome: "done", evidence: "做完了", ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const dbRead = (sql, ...a) => { const d = new DatabaseSync(join(dir, "board.db"), { readOnly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, worker, review, card, connectAs, get, claim, report, dbRead, stop, log: () => log };
}
const pf = (sub) => [{ path: "deploy/run.ps1", sha256: sha(sub ?? "one"), bytes: 3 }, { path: "deploy/conf.json", sha256: sha("two"), bytes: 3 }];

test("I10d 看板:各步只收当事执行者、ran 只收操作者、GET 包详情的读者、助手只见条数、卡历史与 SSE、md 导出、等验收时仍是当事执行者", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" }), Y = await B.connectAs({ kind: "claude", line: "alpha" });
    const S = await B.connectAs({ kind: "claude", role: "assistant" });
    const T = await B.card("上线", "alpha");
    // 还没人领:谁都不是当事执行者
    assert.equal((await B.api("POST", `/api/tasks/${T.id}/packages`, X.token, { name: "上线包", files: pf() })).status, 403, "没领的卡不能报包");
    const run = await B.claim(X, T.id);
    // SSE:订一条,稍后核 package.changed
    const ac = new AbortController(); let sse = "";
    const es = await fetch(B.base + "/api/events", { headers: { "X-Board-Token": B.operator }, signal: ac.signal });
    (async () => { try { for await (const c of es.body) sse += Buffer.from(c).toString("utf8"); } catch {} })();
    // 写权限矩阵:declare
    for (const [who, tk, code] of [["别的执行者", Y.token, 403], ["操作者", B.operator, 403], ["worker", B.worker, 403], ["review", B.review, 403], ["助手", S.token, 403]])
      assert.equal((await B.api("POST", `/api/tasks/${T.id}/packages`, tk, { name: "上线包", files: pf() })).status, code, who);
    assert.equal((await B.api("POST", `/api/tasks/${T.id}/packages`, X.token, { name: "坏", files: [{ path: "../x", sha256: "a".repeat(64), bytes: 1 }] })).status, 400);
    const d = await B.api("POST", `/api/tasks/${T.id}/packages`, X.token, { name: "上线包", files: pf(), expect: "页面能打开", pins: ["首页"] });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const P = d.body.package;
    assert.deepEqual([P.state, P.drift, P.files.length, P.expect, P.expect_by], ["draft", false, 2, "页面能打开", "executor"]);
    // 每卡 ≤5 个包(同名重报 = 覆盖,不占名额)
    for (let i = 2; i <= 5; i++) assert.equal((await B.api("POST", `/api/tasks/${T.id}/packages`, X.token, { name: "包" + i, files: pf() })).status, 200);
    assert.equal((await B.api("POST", `/api/tasks/${T.id}/packages`, X.token, { name: "包6", files: pf() })).status, 409, "第 6 个包");
    assert.equal((await B.api("POST", `/api/tasks/${T.id}/packages`, X.token, { name: "上线包", files: pf(), expect: "页面能打开", pins: ["首页"] })).status, 200, "同名重报照收");
    // freeze / issue / ran 的先后与权限
    assert.equal((await B.api("POST", `/api/packages/${P.id}/issue`, X.token, { label: "共享盘", files: pf() })).status, 409, "没冻结不能出包");
    assert.equal((await B.api("POST", `/api/packages/${P.id}/freeze`, Y.token, {})).status, 403);
    const fz = await B.api("POST", `/api/packages/${P.id}/freeze`, X.token, {});
    assert.equal(fz.body.package.state, "frozen");
    assert.equal((await B.api("POST", `/api/packages/${P.id}/ran`, B.operator, { result: "ok" })).status, 409, "没出包不能记跑完");
    const is = await B.api("POST", `/api/packages/${P.id}/issue`, X.token, { label: "共享盘「发布」夹 C:\\Users\\user\\x", files: pf() });
    assert.equal(is.status, 200, JSON.stringify(is.body));
    assert.equal(is.body.package.state, "issued");
    assert.ok(!is.body.package.issued.label.includes("Users"), "label 脱敏:" + is.body.package.issued.label);
    for (const [who, tk] of [["执行者", X.token], ["review", B.review], ["worker", B.worker], ["助手", S.token]])
      assert.equal((await B.api("POST", `/api/packages/${P.id}/ran`, tk, { result: "ok" })).status, 403, who);
    // 「要本人做的事」:亲手跑一条(做什么 / 在哪 = label / 期待 = 对方写的 / 解锁下游)
    const down = await B.card("下游", "alpha", { blockedBy: [T.id] });
    const bg = (await B.api("GET", "/api/home/background", B.operator)).body;
    const item = bg.attention.find((a) => a.package?.id === P.id);
    assert.ok(item, JSON.stringify(bg.attention).slice(0, 800));
    assert.deepEqual([item.type, item.task_id, item.detail.what, item.detail.expect, item.detail.expect_by], ["hands", T.id, "跑包「上线包」", "页面能打开", "executor"]);
    assert.match(item.detail.where, /共享盘/);
    assert.deepEqual(item.detail.unlocks.map((u) => u.id), [down.id]);
    assert.ok(!bg.attention_type_mismatch, "类型与首页对得上");
    const brief = (await B.api("GET", "/api/brief", S.token)).body;
    assert.ok(brief.text.includes("去做 #" + T.id), brief.text);
    assert.ok(!JSON.stringify(brief).includes("共享盘"), "助手的简报里没有 label");
    // 读者:操作者全量、当事执行者、别人 403;助手只有 packages_count
    assert.equal((await B.api("GET", `/api/tasks/${T.id}/packages`, B.operator)).body.packages.length, 5);
    assert.equal((await B.api("GET", `/api/tasks/${T.id}/packages`, X.token)).status, 200);
    for (const tk of [Y.token, S.token, B.worker, B.review]) assert.equal((await B.api("GET", `/api/tasks/${T.id}/packages`, tk)).status, 403);
    assert.equal((await B.api("GET", `/api/packages/${P.id}`, Y.token)).status, 403);
    const asView = (await B.api("GET", `/api/tasks/${T.id}`, S.token)).body.task;
    assert.equal(asView.packages_count, 5); assert.equal(asView.packages, undefined);
    const tv = await B.get(T.id);
    assert.equal(tv.packages_count, 5);
    assert.deepEqual(tv.packages.find((x) => x.id === P.id), { id: P.id, name: "上线包", state: "issued", drift: false, pinned: { n: 0, total: 1 } });
    // 交付后(等验收)仍是当事执行者;验收通过后不是
    await B.report(X, T.id, run);
    const ran = await B.api("POST", `/api/packages/${P.id}/ran`, B.operator, { result: "ok", note: "跑过了" });
    assert.equal(ran.status, 200, JSON.stringify(ran.body)); assert.equal(ran.body.package.state, "ran");
    assert.ok(!(await B.api("GET", "/api/home/background", B.operator)).body.attention.some((a) => a.package?.id === P.id), "跑过之后不再列");
    assert.equal((await B.api("POST", `/api/packages/${P.id}/freeze`, X.token, {})).status, 200, "等验收时 X 仍是当事执行者");
    // 卡历史、SSE、md 导出(只写包名、状态、冻结短号;不写 label)
    const hist = JSON.stringify((await B.api("GET", `/api/tasks/${T.id}/history`, B.operator)).body);
    for (const w of ["报了包", "冻结了包", "出了包", "记下跑完了包"]) assert.ok(hist.includes(w), w);
    assert.ok(await until(() => sse.includes("package.changed")), "SSE 有 package.changed");
    ac.abort();
    const md = (await B.api("GET", `/api/tasks/${T.id}/export-md`, B.operator)).body;
    assert.match(md, /### 包/);
    assert.match(md, new RegExp(`- 上线包 · 已跑 · 冻结 ${fz.body.package.frozen.digest.slice(0, 12)}`));
    assert.ok(!md.includes("共享盘"), "md 不写 label");
    const ap = await B.api("POST", `/api/tasks/${T.id}/resolve`, B.operator, { verdict: "approve", note: "", expected_version: (await B.get(T.id)).aggregate_version });
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    assert.equal((await B.api("POST", `/api/packages/${P.id}/freeze`, X.token, {})).status, 403, "完成后不再是当事执行者");
    assert.equal(B.dbRead("SELECT COUNT(*) AS n FROM package_events WHERE kind='conclusion'")[0].n >= 1, true, "人工验收的结论绑了 frozen.digest");
  } finally { await B.stop(); }
});

test("I10d 看板:drift 三种来路(重报 / 提交只读核 / 出包缺文件)与 fault 条目;核对卡防重、release_pin、钉住", { skip: !GIT && "没有 git", timeout: 120000 }, async () => {
  const R = gitRepo();
  const B = await board({ repo: R.dir });
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" }), Y = await B.connectAs({ kind: "claude", line: "alpha" });
    const G = (await B.api("POST", "/api/goals", B.operator, { subject: "目标" })).body.task;
    const T = await B.card("包卡", "alpha", { parentId: G.id });
    await B.api("POST", `/api/tasks/${G.id}/release`, B.operator, { released: true, expected_version: G.aggregate_version });
    await B.claim(X, T.id);
    const P = (await B.api("POST", `/api/tasks/${T.id}/packages`, X.token, { name: "包", files: pf(), pins: ["首页", "日志"] })).body.package;
    await B.api("POST", `/api/packages/${P.id}/freeze`, X.token, {});
    // ① 提交只读核:内容对得上 = verified true;对不上 = false → drift
    assert.equal((await B.api("POST", `/api/packages/${P.id}/commit`, X.token, { commit: "xyz" })).status, 400);
    await B.api("POST", `/api/packages/${P.id}/commit`, X.token, { commit: R.good });
    let v = await until(async () => { const x = (await B.api("GET", `/api/packages/${P.id}`, B.operator)).body.package; return x.commit.verified !== null ? x : null; });
    assert.deepEqual([v?.commit.verified, v?.state, v?.drift], [true, "committed", false], B.log().slice(-1500));
    await B.api("POST", `/api/packages/${P.id}/commit`, X.token, { commit: R.bad });
    v = await until(async () => { const x = (await B.api("GET", `/api/packages/${P.id}`, B.operator)).body.package; return x.commit.verified !== null ? x : null; });
    assert.deepEqual([v.commit.verified, v.state, v.drift, v.drift_detail.step, v.drift_detail.before], [false, "frozen", true, "commit", "committed"]);
    await B.api("POST", `/api/packages/${P.id}/commit`, X.token, { commit: R.good });
    await until(async () => (await B.api("GET", `/api/packages/${P.id}`, B.operator)).body.package.commit.verified === true);
    // ② 出包缺文件 → 不 match → fault 条目「先别跑」
    const miss = await B.api("POST", `/api/packages/${P.id}/issue`, X.token, { label: "U 盘", files: [pf()[0]], missing: ["deploy/conf.json"] });
    assert.deepEqual([miss.body.package.issued.match, miss.body.package.drift, miss.body.package.drift_detail.step, miss.body.package.issued.missing], [false, true, "issue", ["deploy/conf.json"]]);
    let bg = (await B.api("GET", "/api/home/background", B.operator)).body;
    const fault = bg.attention.find((a) => a.package?.id === P.id);
    assert.deepEqual([fault?.type, fault?.detail.what], ["fault", "出包后的文件和预审时不一样,先别跑"]);
    assert.ok(!bg.attention_type_mismatch);
    // 出包对上 → 亲手跑
    await B.api("POST", `/api/packages/${P.id}/issue`, X.token, { label: "U 盘", files: pf() });
    bg = (await B.api("GET", "/api/home/background", B.operator)).body;
    assert.equal(bg.attention.find((a) => a.package?.id === P.id)?.type, "hands");
    // ③ 冻结后重报不同的文件 → drift(停在冻结之前)
    const re = await B.api("POST", `/api/tasks/${T.id}/packages`, X.token, { name: "包", files: pf("one-b"), pins: ["首页", "日志"] });
    assert.deepEqual([re.body.package.state, re.body.package.drift, re.body.package.drift_detail.step], ["draft", true, "declare"]);
    assert.equal((await B.api("POST", `/api/tasks/${T.id}/packages`, X.token, { name: "包", files: pf(), pins: ["首页", "日志"] })).body.package.drift, false, "改回同一份表:不再 drift");
    // 跑完(ok + release_pin)→ 核对卡:同父卡、同线、auto_kind pin、按操作者放行;只出一次
    assert.equal((await B.api("POST", `/api/packages/${P.id}/pin`, X.token, { name: "首页", ok: true })).status, 403, "没有核对卡 / 不是持卡者");
    const rr = await B.api("POST", `/api/packages/${P.id}/ran`, B.operator, { result: "ok", release_pin: true });
    assert.equal(rr.status, 200, JSON.stringify(rr.body));
    const pins = async () => (await B.api("GET", "/api/tasks?archived=all", B.operator)).body.tasks.filter((t) => t.auto_kind === "pin");
    const list = await until(async () => { const a = await pins(); return a.length && a[0].released ? a : null; });
    assert.equal(list?.length, 1, B.log().slice(-1500));
    const PC = list[0];
    assert.deepEqual([PC.parent_id, PC.line, !!PC.released, PC.status], [G.id, "alpha", true, "not_started"]);
    assert.match(PC.description, /1\. 首页/); assert.ok(!PC.description.includes("U 盘"), "核对卡不写 label");
    assert.ok(B.dbRead("SELECT actor FROM task_events WHERE task_id=? AND kind='release'", PC.id).some((e) => e.actor === "operator"), "按操作者放行");
    await B.api("POST", `/api/packages/${P.id}/ran`, B.operator, { result: "ok" });
    await delay(800);
    assert.equal((await pins()).length, 1, "同一冻结轮只出一张核对卡");
    assert.equal(B.dbRead("SELECT COUNT(*) AS n FROM auto_triggers WHERE rule='pin'")[0].n, 1);
    // 钉住:核对卡持卡者(自报)/ 审阅座席(已核);别人 403;不是要核的项 400
    await B.claim(Y, PC.id);
    assert.equal((await B.api("POST", `/api/packages/${P.id}/pin`, X.token, { name: "首页", ok: true })).status, 403);
    assert.equal((await B.api("POST", `/api/packages/${P.id}/pin`, B.operator, { name: "首页", ok: true })).status, 403);
    assert.equal((await B.api("GET", `/api/packages/${P.id}`, Y.token)).status, 200, "核对卡持卡者能读包");
    assert.equal((await B.api("POST", `/api/packages/${P.id}/pin`, Y.token, { name: "别的", ok: true })).status, 400);
    let pv = (await B.api("POST", `/api/packages/${P.id}/pin`, Y.token, { name: "首页", ok: true })).body.package;
    assert.deepEqual(pv.pinned, { n: 1, total: 2, verified: 0, self: 1 });
    pv = (await B.api("POST", `/api/packages/${P.id}/pin`, B.review, { name: "日志", ok: true })).body.package;
    assert.deepEqual([pv.state, pv.pinned], ["pinned", { n: 2, total: 2, verified: 1, self: 1 }]);
    assert.deepEqual((await B.get(T.id)).packages[0].pinned, { n: 2, total: 2 });
    // 不带 release_pin 的核对卡默认未放行(另一张卡另一个包)
    const T2 = await B.card("包卡二", "alpha");
    await B.claim(X, T2.id);
    const P2 = (await B.api("POST", `/api/tasks/${T2.id}/packages`, X.token, { name: "二", files: pf(), pins: ["一项"] })).body.package;
    await B.api("POST", `/api/packages/${P2.id}/freeze`, X.token, {});
    await B.api("POST", `/api/packages/${P2.id}/issue`, X.token, { label: "桌面", files: pf() });
    await B.api("POST", `/api/packages/${P2.id}/ran`, B.operator, { result: "ok" });
    const pc2 = await until(async () => (await pins()).find((t) => t.description.includes(`#${T2.id}`)));
    assert.ok(pc2); assert.equal(!!pc2.released, false, "默认未放行");
    assert.equal(pc2.parent_id, null);
  } finally { await B.stop(); rmSync(R.dir, { recursive: true, force: true }); }
});

test("I10d 自动通过闸(只对带包的卡):包没跑 / 没钉齐 / drift → 不自动通过,缺口进 package_gaps;全满足的对照卡自动通过;不带包的卡同现状", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "auto" });
    const plain = await B.card("不带包", "auto");
    await B.report(X, plain.id, await B.claim(X, plain.id));
    assert.equal((await B.get(plain.id)).status, "done", "不带包的卡:accept:auto 同现状");
    // 带包、没跑 → 留在等验收
    const A = await B.card("带包没跑", "auto");
    const runA = await B.claim(X, A.id);
    const PA = (await B.api("POST", `/api/tasks/${A.id}/packages`, X.token, { name: "甲", files: pf() })).body.package;
    await B.api("POST", `/api/packages/${PA.id}/freeze`, X.token, {});
    await B.report(X, A.id, runA);
    let a = await B.get(A.id);
    assert.deepEqual([a.status, a.waiting_for], ["waiting", "review"], "带包没跑:不自动通过");
    assert.ok(a.package_gaps.some((g) => /包「甲」还没跑/.test(g)), JSON.stringify(a.package_gaps));
    assert.match(B.log(), new RegExp(`#${A.id} 线 auto accept:auto 未自动完成\\(可信闸\\)`));
    // 对照:同样的包全满足(出包、跑 ok、没有要钉的项)→ 自动通过
    const C = await B.card("带包全满足", "auto");
    const runC = await B.claim(X, C.id);
    const PC = (await B.api("POST", `/api/tasks/${C.id}/packages`, X.token, { name: "丙", files: pf() })).body.package;
    await B.api("POST", `/api/packages/${PC.id}/freeze`, X.token, {});
    await B.api("POST", `/api/packages/${PC.id}/issue`, X.token, { label: "共享盘", files: pf() });
    await B.api("POST", `/api/packages/${PC.id}/ran`, B.operator, { result: "ok" });
    assert.deepEqual((await B.get(C.id)).package_gaps, []);
    await B.report(X, C.id, runC);
    assert.equal((await B.get(C.id)).status, "done", "全满足:自动通过");
    // 钉住没齐 / 跑失败 → 转人工
    const D = await B.card("钉住没齐", "auto");
    const runD = await B.claim(X, D.id);
    const PD = (await B.api("POST", `/api/tasks/${D.id}/packages`, X.token, { name: "丁", files: pf(), pins: ["首页"] })).body.package;
    await B.api("POST", `/api/packages/${PD.id}/freeze`, X.token, {});
    await B.api("POST", `/api/packages/${PD.id}/issue`, X.token, { label: "共享盘", files: pf() });
    await B.api("POST", `/api/packages/${PD.id}/ran`, B.operator, { result: "failed" });
    await B.report(X, D.id, runD);
    const dd = await B.get(D.id);
    assert.equal(dd.status, "waiting");
    assert.ok(dd.package_gaps.some((g) => /跑了,结果是失败/.test(g)), JSON.stringify(dd.package_gaps));
    // 人的显式裁定不受闸限制
    const ok = await B.api("POST", `/api/tasks/${D.id}/resolve`, B.operator, { verdict: "approve", note: "", expected_version: dd.aggregate_version });
    assert.equal(ok.status, 200); assert.equal((await B.get(D.id)).status, "done");
  } finally { await B.stop(); }
});

test("联合(8a 取代 × 8e 包):被取代的卡,它的包不再进「要本人做的事」、跑完也不出核对卡;对照卡照常", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    const prep = async (subject) => {
      const T = await B.card(subject, "alpha");
      await B.claim(X, T.id);
      const P = (await B.api("POST", `/api/tasks/${T.id}/packages`, X.token, { name: "包", files: pf(), pins: ["首页"] })).body.package;
      await B.api("POST", `/api/packages/${P.id}/freeze`, X.token, {});
      await B.api("POST", `/api/packages/${P.id}/issue`, X.token, { label: "共享盘", files: pf() });
      return { T, P };
    };
    const old = await prep("旧卡"), ctl = await prep("对照卡");
    const att = async () => (await B.api("GET", "/api/home/background", B.operator)).body.attention.filter((a) => a.package).map((a) => a.package.id);
    assert.deepEqual((await att()).sort(), [old.P.id, ctl.P.id].sort(), "取代之前两条都在");
    const neu = await B.card("新卡", "alpha");
    const sup = await B.api("POST", `/api/tasks/${old.T.id}/supersede`, B.operator, { by: neu.id });
    assert.equal(sup.status, 200, JSON.stringify(sup.body));
    assert.deepEqual(await att(), [ctl.P.id], "被取代的卡的包不再列");
    for (const x of [old, ctl]) assert.equal((await B.api("POST", `/api/packages/${x.P.id}/ran`, B.operator, { result: "ok" })).status, 200);
    const pins = async () => (await B.api("GET", "/api/tasks?archived=all", B.operator)).body.tasks.filter((t) => t.auto_kind === "pin");
    const got = await until(async () => { const a = await pins(); return a.length ? a : null; });
    assert.equal(got?.length, 1, B.log().slice(-1200));
    assert.match(got[0].description, new RegExp(`#${ctl.T.id}「对照卡」`));
    await delay(800);
    assert.equal((await pins()).length, 1, "被取代的卡不出核对卡");
  } finally { await B.stop(); }
});

test("联合(8a 依赖归档 / 8b·H3 必需检查 / 8c 通用 attention × 8e 包):同场时首页后台的类型对得上(无 attention_type_mismatch),自动通过闸的缺口两边都列", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" }), Z = await B.connectAs({ kind: "codex", line: "auto" });
    // 8a:依赖没做完就被归档 → 下游 DEP_ARCHIVED(8c 规则:attention fault)
    const dep = await B.card("依赖", "alpha"), kid = await B.card("下游", "alpha", { blockedBy: [dep.id] });
    assert.equal((await B.api("POST", `/api/tasks/${dep.id}/archive`, B.operator, { expected_version: (await B.get(dep.id)).aggregate_version, force: true })).status, 200);
    // 8e:一张亲手跑、一张出包不符
    const T1 = await B.card("包一", "alpha"); await B.claim(X, T1.id);
    const P1 = (await B.api("POST", `/api/tasks/${T1.id}/packages`, X.token, { name: "甲", files: pf() })).body.package;
    await B.api("POST", `/api/packages/${P1.id}/freeze`, X.token, {});
    await B.api("POST", `/api/packages/${P1.id}/issue`, X.token, { label: "共享盘", files: pf() });
    const T2 = await B.card("包二", "alpha"); await B.claim(X, T2.id);
    const P2 = (await B.api("POST", `/api/tasks/${T2.id}/packages`, X.token, { name: "乙", files: pf() })).body.package;
    await B.api("POST", `/api/packages/${P2.id}/freeze`, X.token, {});
    await B.api("POST", `/api/packages/${P2.id}/issue`, X.token, { label: "共享盘", files: [], missing: ["deploy/run.ps1", "deploy/conf.json"] });
    const bg = (await B.api("GET", "/api/home/background", B.operator)).body;
    assert.ok(!bg.attention_type_mismatch, "类型对得上");
    const byTask = new Map(bg.attention.map((a) => [`${a.task_id}:${a.package?.id ?? "-"}`, a.type]));
    assert.equal(byTask.get(`${kid.id}:-`), "fault", JSON.stringify(bg.attention).slice(0, 600));
    assert.equal(byTask.get(`${T1.id}:${P1.id}`), "hands");
    assert.equal(byTask.get(`${T2.id}:${P2.id}`), "fault");
    // H3 必需检查 × 包闸:同一张 accept:auto 的卡,两种缺口都列,不自动通过
    const A = await B.card("双缺口", "auto", { required_checks: ["unit"] });
    const run = await B.claim(Z, A.id);
    const PA = (await B.api("POST", `/api/tasks/${A.id}/packages`, Z.token, { name: "丙", files: pf() })).body.package;
    await B.api("POST", `/api/packages/${PA.id}/freeze`, Z.token, {});
    await B.report(Z, A.id, run);
    assert.equal((await B.get(A.id)).status, "waiting");
    const line = B.log().split(String.fromCharCode(10)).find((l) => l.includes(`#${A.id} 线 auto accept:auto 未自动完成`)) || "";
    assert.ok(line.includes("必需检查「unit」") && line.includes("包「丙」还没跑"), line);
  } finally { await B.stop(); }
});

test("联合(8d 引用 × 8e 包):同一张卡既带包又带引用,两道自动通过闸各自生效、互不吞掉;都满足才自动通过", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const Z = await B.connectAs({ kind: "codex", line: "auto" });
    const S = await B.card("规格", "alpha"), S2 = await B.card("会改的规格", "alpha");
    const edit = async (id, fields) => B.api("POST", `/api/tasks/${id}/update`, B.operator, { expected_version: (await B.get(id)).aggregate_version, ...fields });
    const withPkg = async (subject, refs, finish) => {
      const T = await B.card(subject, "auto", { refs });
      const run = await B.claim(Z, T.id);
      const P = (await B.api("POST", `/api/tasks/${T.id}/packages`, Z.token, { name: "包", files: pf() })).body.package;
      await B.api("POST", `/api/packages/${P.id}/freeze`, Z.token, {});
      if (finish) { await B.api("POST", `/api/packages/${P.id}/issue`, Z.token, { label: "共享盘", files: pf() }); await B.api("POST", `/api/packages/${P.id}/ran`, B.operator, { result: "ok" }); }
      return { T, run };
    };
    const staleRef = await withPkg("引用过期 · 包全满足", [S2.id], true);
    const pkgOpen = await withPkg("引用当前 · 包没跑", [S.id], false);
    const both = await withPkg("引用过期 · 包没跑", [S2.id], false);
    const ok = await withPkg("引用当前 · 包全满足", [S.id], true);
    assert.equal((await edit(S2.id, { description: "改了" })).status, 200);
    for (const x of [staleRef, pkgOpen, both, ok]) await B.report(Z, x.T.id, x.run);
    const why = (id) => B.log().split(String.fromCharCode(10)).find((l) => l.includes(`#${id} 线 auto accept:auto 未自动完成`)) || "";
    assert.equal((await B.get(staleRef.T.id)).status, "waiting");
    assert.ok(why(staleRef.T.id).includes("based_on_stale_ref") && !why(staleRef.T.id).includes("包「"), why(staleRef.T.id));
    assert.equal((await B.get(pkgOpen.T.id)).status, "waiting");
    assert.ok(why(pkgOpen.T.id).includes("包「包」还没跑") && !why(pkgOpen.T.id).includes("based_on_stale_ref"), why(pkgOpen.T.id));
    assert.equal((await B.get(both.T.id)).status, "waiting");
    assert.ok(why(both.T.id).includes("based_on_stale_ref") && why(both.T.id).includes("包「包」还没跑"), "两条缺口都列:" + why(both.T.id));
    assert.equal((await B.get(ok.T.id)).status, "done", "都满足才自动通过 " + B.log().slice(-600));
  } finally { await B.stop(); }
});

test("I10e 环境差:target_env 只由操作者写(建卡 / 专门接口;worker 派生卡 403、助手挂卡 400)、执行者 checks 带 env 只算自报、env_gap 与 not_target_env、report_env_diff 只收当事执行者", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" }), Y = await B.connectAs({ kind: "claude", line: "alpha" });
    const S = await B.connectAs({ kind: "claude", role: "assistant" });
    const T = await B.card("环境", "alpha", { target_env: "reviewer:claude" });
    assert.equal(T.target_env, "reviewer:claude");
    assert.deepEqual(T.env_gap, { target: "reviewer:claude", verified_in: [], same: null });
    const parent = await B.card("父", "alpha");
    assert.equal((await B.api("POST", "/api/tasks", B.worker, { subject: "派生", parentId: parent.id, target_env: "x" })).status, 403);
    assert.equal((await B.api("POST", "/api/assistant/cards", S.token, { subject: "s", description: "d", acceptance: "a", target_env: "x" })).status, 400);
    assert.equal((await B.api("POST", "/api/tasks", B.operator, { subject: "长", line: "alpha", target_env: "x".repeat(41) })).status, 400);
    for (const tk of [X.token, B.worker, B.review, S.token]) assert.equal((await B.api("POST", `/api/tasks/${T.id}/target-env`, tk, { target_env: "x" })).status, 403);
    // report_env_diff:当事执行者才收
    const run = await B.claim(X, T.id);
    assert.equal((await B.api("POST", `/api/tasks/${T.id}/env-diff`, Y.token, { items: [{ key: "node" }] })).status, 403);
    const ed = await B.api("POST", `/api/tasks/${T.id}/env-diff`, X.token, { items: [{ key: "node", here: "24", target: "22" }] });
    assert.equal(ed.status, 200, JSON.stringify(ed.body));
    assert.deepEqual((await B.get(T.id)).env_diff.items, [{ key: "node", here: "24", target: "22" }]);
    assert.equal((await B.get(T.id)).env_diff.by, "executor");
    // 执行者 checks 带 env = 自报,不进 verified_in
    await B.report(X, T.id, run, { checks: [{ name: "unit", status: "pass", how: "ran", env: "reviewer:claude" }] });
    let t = await B.get(T.id);
    assert.equal(t.checks.find((c) => c.by === "executor").env, "reviewer:claude");
    assert.deepEqual(t.env_gap.verified_in, [], "自报的 env 不算");
    assert.equal((await B.api("POST", `/api/tasks/${T.id}/report`, X.token, { run_id: run, outcome: "done", evidence: "x", checks: [{ name: "u", status: "pass", env: "x".repeat(81) }] })).status, 400);
    // 审阅座席跑过(env = reviewer:claude)= 目标环境 → same true,机器验证不带 not_target_env
    const rv = await B.api("POST", `/api/tasks/${T.id}/resolve`, B.review, { verdict: "approve", resolved_by: "auto", note: "审过", runtime: "claude",
      verify_key: "unit", verify_ok: true, expected_version: t.aggregate_version });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    t = await B.get(T.id);
    assert.deepEqual(t.env_gap, { target: "reviewer:claude", verified_in: ["reviewer:claude"], same: true });
    assert.equal(t.badge.level, "machine_verified");
    assert.ok(!t.badge.flags.includes("not_target_env"));
    // 改目标环境 → same false → not_target_env;撤销 → null,不挂 flag
    const ch = await B.api("POST", `/api/tasks/${T.id}/target-env`, B.operator, { target_env: "生产" });
    assert.equal(ch.status, 200);
    assert.deepEqual(ch.body.task.env_gap.same, false);
    assert.ok(ch.body.task.badge.flags.includes("not_target_env"), JSON.stringify(ch.body.task.badge));
    const off = (await B.api("POST", `/api/tasks/${T.id}/target-env`, B.operator, { target_env: null })).body.task;
    assert.deepEqual([off.target_env, off.env_gap.same, off.badge.flags.includes("not_target_env")], [null, null, false]);
    const hist = JSON.stringify((await B.api("GET", `/api/tasks/${T.id}/history`, B.operator)).body);
    assert.ok(hist.includes("设目标环境") && hist.includes("撤销了目标环境") && hist.includes("报了与目标环境的差"), hist.slice(0, 400));
  } finally { await B.stop(); }
});

/** 真 stdio 桥子进程(与 occupancytest 同形)。 */
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
const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pkgtest", version: "1" } };
const toolJson = (r) => JSON.parse(r.content[0].text);

test("真 stdio 桥:declare_package 在本侧算哈希(只传相对路径 / sha256 / 字节数)、freeze、issue_package 同路径优先再按文件名、缺文件不 match、report_pin、report_env_diff", { timeout: 120000 }, async () => {
  const B = await board();
  const work = mkdtempSync(join(tmpdir(), "pkgtest-work-")), out = mkdtempSync(join(tmpdir(), "pkgtest-out-"));
  try {
    mkdirSync(join(work, "deploy")); writeFileSync(join(work, "deploy", "run.ps1"), "one"); writeFileSync(join(work, "deploy", "conf.json"), "two");
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    const tf = join(B.dir, "exe_token.txt"); writeFileSync(tf, X.token);
    const M = bridge(["--url", B.base, "--token-file", tf]);
    try {
      assert.ok((await M.request("initialize", INIT)).result, M.stderr());
      M.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const names = (await M.request("tools/list")).result.tools.map((x) => x.name);
      for (const n of ["declare_package", "freeze_package", "package_committed", "issue_package", "report_pin", "report_env_diff"]) assert.ok(names.includes(n), n);
      const T = await B.card("桥", "alpha", { target_env: "生产" });
      assert.ok(!(await M.call("claim_card", { id: T.id, expected_version: (await B.get(T.id)).aggregate_version })).isError);
      assert.ok((await M.call("declare_package", { card_id: T.id, name: "包", files: ["deploy/none.txt"], root: work })).isError, "找不到文件");
      assert.ok((await M.call("declare_package", { card_id: T.id, name: "包", files: ["../x"], root: work })).isError, "越界路径本侧先挡");
      assert.ok((await M.call("declare_package", { card_id: T.id, name: "包", files: ["deploy/run.ps1"], root: "relative" })).isError, "root 要绝对路径");
      const d = await M.call("declare_package", { card_id: T.id, name: "包", files: ["deploy\\run.ps1", "deploy/conf.json"], root: work, expect: "能跑", pins: ["首页"] });
      assert.ok(!d.isError, JSON.stringify(d));
      const P = toolJson(d).package;
      assert.deepEqual(P.files, [{ path: "deploy/conf.json", sha256: sha("two"), bytes: 3 }, { path: "deploy/run.ps1", sha256: sha("one"), bytes: 3 }]);
      const ev = JSON.stringify(B.dbRead("SELECT data_json FROM package_events"));
      assert.ok(!ev.includes(work) && !ev.includes("pkgtest-work"), "看板这边没有执行者的本机路径");
      assert.equal(toolJson(await M.call("freeze_package", { package_id: P.id })).package.state, "frozen");
      // 出包:run.ps1 同相对路径;conf.json 只在出包目录顶层(按文件名找到)
      mkdirSync(join(out, "deploy")); writeFileSync(join(out, "deploy", "run.ps1"), "one"); writeFileSync(join(out, "conf.json"), "two");
      let is = await M.call("issue_package", { package_id: P.id, dir: out, label: "共享盘「发布」夹" });
      assert.ok(!is.isError, JSON.stringify(is));
      assert.deepEqual([toolJson(is).match, toolJson(is).missing], [true, []]);
      // 缺文件 → 不 match
      rmSync(join(out, "conf.json"));
      is = await M.call("issue_package", { package_id: P.id, dir: out, label: "共享盘「发布」夹" });
      assert.deepEqual([toolJson(is).match, toolJson(is).missing, toolJson(is).package.drift], [false, ["deploy/conf.json"], true]);
      // 同路径优先于文件名:同路径的内容不对就是不对(不会退去找同名的对的那份)
      writeFileSync(join(out, "conf.json"), "two"); writeFileSync(join(out, "deploy", "run.ps1"), "tampered"); writeFileSync(join(out, "run.ps1"), "one");
      is = await M.call("issue_package", { package_id: P.id, dir: out, label: "x" });
      assert.equal(toolJson(is).match, false);
      writeFileSync(join(out, "deploy", "run.ps1"), "one");
      assert.equal(toolJson(await M.call("issue_package", { package_id: P.id, dir: out, label: "x" })).match, true);
      // report_pin:还没有核对卡 → 看板 403
      assert.ok((await M.call("report_pin", { package_id: P.id, name: "首页", ok: true })).isError);
      // report_env_diff
      const ed = await M.call("report_env_diff", { card_id: T.id, items: [{ key: "node", here: "24", target: "22" }] });
      assert.ok(!ed.isError, JSON.stringify(ed));
      assert.deepEqual(toolJson(ed).env_diff.items, [{ key: "node", here: "24", target: "22" }]);
      // 旧用法照旧:report_result 不带新字段;checks 可带 env
      const r = await M.call("report_result", { id: T.id, outcome: "done", evidence: "交付", checks: [{ name: "unit", status: "pass", how: "ran", env: "本机" }] });
      assert.ok(!r.isError, JSON.stringify(r));
      assert.equal((await B.get(T.id)).checks[0].env, "本机");
    } finally { await M.end(); }
  } finally { await B.stop(); rmSync(work, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});
