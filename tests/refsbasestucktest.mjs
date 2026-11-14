import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 合同 I10a–c(第 8 波第二轮 8d):引用规格某一版 + 复审卡 / 底提交前提 / 卡死检测。`node --test tests/refsbasestucktest.mjs`
//   I10a 钉版本与哈希、过期按哈希判、ref.stale 防重、REF_STALE(attention decide)、执行中 refs_stale、重钉 → 引用方说明版本 +1、
//        based_on_stale_ref 与自动通过闸、读范围(持卡执行者跨线只读被引用卡的几项;没引用 / 不再持卡读不到)、复审卡全程;
//   I10b base 三处入口、定时扫只读核 ok / missing / diverged / unknown、behind、BASE_GONE(attention fault)、执行中 base_gone、base_differs;
//   I10c 四种连续计数、reason_code、stuck_after 设置、STUCK(attention decide)、task.stuck 一次、清零(只追加)与改说明清零、排队领跳下一张;
//   写权限矩阵、助手视图、真 stdio 桥、计划项。不调用任何模型。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { freePort } from "./helpers/free-port.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { normRefs, composeReview } from "../core/refs.mjs";
import { normBase } from "../core/basecommit.mjs";
import { openStuck, checkReason, checkStuckAfter } from "../core/stuck.mjs";
import { specHash } from "../core/spec-version.mjs";

const require = createRequire(import.meta.url);
const store = require("../core/store.js");
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BRIDGE = join(ROOT, "cli", "exec-mcp.mjs");
const FAKE = join(ROOT, "tests", "helpers", "fake-coordinator-cli.mjs");
const TMP = mkdtempSync(join(tmpdir(), "refsbasestuck-")), dbs = [];
after(() => { for (const db of dbs) { try { db.close(); } catch {} } rmSync(TMP, { recursive: true, force: true }); });
const ctx = { err: store.err, ERR: store.ERR };
const until = async (fn, ms = 10000, step = 100) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v || Date.now() > end) return v; await delay(step); } };

test("参数形:refs / base / reason_code / stuck_after;说明哈希不带引用时与旧版逐字节相同;复审卡卡面只写短号与相对路径", () => {
  assert.equal(normRefs(undefined, ctx), undefined);
  assert.deepEqual(normRefs(null, ctx), []);
  assert.deepEqual(normRefs([3, { card: 4, review: true }, { card: 3, review: true }], ctx), [{ card: 3, review: true }, { card: 4, review: true }]);
  for (const bad of ["3", [0], [{ card: 2, x: 1 }], [{ card: 2, review: "yes" }], Array.from({ length: 9 }, (_, i) => i + 1)])
    assert.throws(() => normRefs(bad, ctx), (e) => e.code === "BAD_INPUT", JSON.stringify(bad));
  assert.deepEqual(normBase({ commit: "ABCDEF1" }, ctx), { commit: "abcdef1", onto: null });
  assert.deepEqual(normBase({ commit: "a".repeat(40), onto: "refs/heads/main" }, ctx), { commit: "a".repeat(40), onto: "refs/heads/main" });
  assert.equal(normBase(null, ctx), null);
  for (const bad of [{ commit: "abc12" }, { commit: "g".repeat(7) }, { commit: "a".repeat(41) }, { commit: "abcdef1", onto: "main" }, { commit: "abcdef1", x: 1 }, "abcdef1"])
    assert.throws(() => normBase(bad, ctx), (e) => e.code === "BAD_INPUT", JSON.stringify(bad));
  const bi = (m) => Object.assign(new Error(m), { code: "BAD_INPUT" });
  assert.equal(checkReason(undefined, bi), null);
  assert.equal(checkReason("env_broken", bi), "env_broken");
  for (const bad of ["Env", "a-b", "", "x".repeat(33), 5]) assert.throws(() => checkReason(bad, bi), /reason_code/);
  assert.deepEqual([0, 2, 3, 10].map(checkStuckAfter), [true, true, true, true]);
  assert.deepEqual([1, 11, -1, 2.5, "3", null].map(checkStuckAfter), [false, false, false, false, false, false]);
  const t = { subject: "s", description: "d", acceptance: "a", required_checks: [] };
  assert.equal(specHash(t), specHash(t, null));
  assert.notEqual(specHash(t), specHash(t, "refs:v1"));
  const c = composeReview({ x: { id: 7, title: "做功能" }, s: { id: 3, title: "规格" }, sVersion: 2,
    fp: { digest: "d".repeat(64), head_commit: "e".repeat(40), files: [{ path: "src/a.mjs", sha256: "0".repeat(64) }] }, verified: [], self: [{ name: "unit", status: "pass" }] });
  assert.match(c.description, /#3「规格」的说明 v2/);
  assert.ok(c.description.includes("dddddddddddd") && !c.description.includes("d".repeat(13)), "只写 12 位短号");
  assert.ok(c.description.includes("src/a.mjs") && c.description.includes("spec_conformance"));
});

// ── I10c 计数(直接对库,结构化事件) ──────────────────────────────────────────────────────────
function fx(threshold = 3) {
  const dir = join(TMP, "u" + Math.random().toString(16).slice(2)); mkdirSync(dir);
  const db = new DatabaseSync(join(dir, "b.db")); dbs.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  store.migrate(db);
  let n = threshold;
  const st = openStuck({ db, store, threshold: () => n });
  st.migrate();
  const id = store.add(db, { subject: "会卡死的卡" });
  const ev = (kind, detail = {}, actor = "w") => store.appendEvent(db, { taskId: id, kind, actor, detail });
  const kind = () => st.compute(store.get(db, id))?.kind ?? null, count = () => st.compute(store.get(db, id))?.count ?? 0;
  return { db, st, id, ev, kind, count, set: (v) => { n = v; } };
}
test("I10c 计数:只取结构化事件的连续次数;done 交付断开回收 / 失败 / 同原因,验收通过、清零、改说明断开全部", () => {
  const f = fx(3);
  f.ev("reap"); f.ev("reap");
  assert.equal(f.kind(), null);
  f.ev("reap");
  assert.deepEqual([f.kind(), f.count()], ["reaped", 3]);
  const s = f.st.compute(store.get(f.db, f.id));
  assert.equal(s.last.length, 3); assert.ok(s.since && s.last.every((x) => x.kind === "reaped"));
  f.ev("report", { outcome: "done", run_id: "r0" });
  assert.equal(f.kind(), null, "一次 done 交付断开回收");
  // 退回:done → 退回 连着三次 = handed_back 3(done 交付不断开它)
  for (let i = 0; i < 3; i++) { f.ev("report", { outcome: "done", run_id: "rd" + i }); f.ev("resolve", { disposition: "hand_back", verdict: "reject" }, "review"); }
  assert.deepEqual([f.kind(), f.count()], ["handed_back", 3]);
  f.ev("resolve", { disposition: "hand_back" }, "cascade");
  assert.equal(f.count(), 3, "联动不算");
  f.ev("spec.changed", { version: 2 }, "operator");
  assert.equal(f.kind(), null, "改说明清零");
  // 失败 + 同原因
  f.st.recordReason(f.id, "w1", "env_broken"); f.st.recordReason(f.id, "w2", "env_broken"); f.st.recordReason(f.id, "w3", "other");
  f.ev("report", { outcome: "wait", run_id: "w1" }); f.ev("report", { outcome: "wait", run_id: "w2" });
  assert.equal(f.kind(), null);
  f.ev("report", { outcome: "wait", run_id: "w3" });
  assert.deepEqual([f.kind(), f.count()], ["failed", 3], "非 done 交付 3 次");
  assert.deepEqual(f.st.compute(store.get(f.db, f.id)).last.map((x) => x.reason_code), ["env_broken", "env_broken", "other"]);
  f.ev("stuck.cleared", {}, "operator");
  assert.equal(f.kind(), null, "清零");
  f.set(2);
  f.st.recordReason(f.id, "w4", "x"); f.st.recordReason(f.id, "w5", "y");
  f.ev("report", { outcome: "wait", run_id: "w4" }); f.ev("report", { outcome: "wait", run_id: "w5" });
  assert.deepEqual([f.kind(), f.count()], ["failed", 2]);
  f.ev("stuck.cleared", {}, "operator");
  f.st.recordReason(f.id, "w6", "same"); f.st.recordReason(f.id, "w7", "same");
  f.ev("report", { outcome: "wait", run_id: "w6" }); f.ev("report", { outcome: "wait", run_id: "w7" });
  const sr = f.st.compute(store.get(f.db, f.id));
  assert.equal(sr.count, 2); assert.ok(["failed", "same_reason"].includes(sr.kind));
  f.ev("resolve", { disposition: "close", verdict: "approve" }, "operator");
  assert.equal(f.kind(), null, "验收通过断开全部");
  f.ev("reap"); f.ev("reap");
  assert.equal(f.kind(), "reaped");
  f.set(0);
  assert.equal(f.kind(), null, "0 = 关");
});

// ── HTTP:临时看板 ─────────────────────────────────────────────────────────────────────────────────────────
const git = (repo, ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", windowsHide: true, env: { ...HOST_ENV, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" } }).trim();
function workRepo(dir) {
  const repo = join(dir, "work"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  const commit = (name) => { writeFileSync(join(repo, name), name); git(repo, "add", name); git(repo, "commit", "-q", "-m", name); return git(repo, "rev-parse", "HEAD"); };
  return { repo, commit, git: (...a) => git(repo, ...a) };
}
async function board({ env = {}, prepare = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "refsbasestucktest-")), config = join(dir, "fleet.json"), repo = join(dir, "repo");
  mkdirSync(repo); mkdirSync(join(dir, "fake-projects")); mkdirSync(join(dir, "fake-codex"));
  const W = workRepo(dir);
  const extra = prepare ? prepare(W) : {};
  writeFileSync(config, JSON.stringify({ lines: [{ id: "alpha", label: "开发" }, { id: "ext", label: "外部", external: true, work_repo: W.repo },
    { id: "ext2", label: "外部二", external: true }, { id: "auto", label: "自动", external: true, accept: "auto" }], roles: [], routes: ["default"], repo }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir, BOARD_DB: join(dir, "board.db"),
           BOARD_REPO: repo, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit", BOARD_DELIVERABLE_GATE: "off",
           BOARD_INTEGRATE_SCAN_MS: "300", BOARD_CLAUDE_PROJECTS: join(dir, "fake-projects"), BOARD_CODEX_HOME: join(dir, "fake-codex"), ...env } });
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
  const tok = (n) => readFileSync(join(dir, n), "utf8").trim();
  const operator = tok("board_token"), worker = tok("worker_token"), review = tok("review_token");
  const get = async (id, t = operator) => (await api("GET", `/api/tasks/${id}`, t)).body?.task;
  const card = async (subject, line, extra = {}) => {
    const r = await api("POST", "/api/tasks", operator, { subject, ...(line ? { line } : {}), description: "说明", acceptance: "验收", ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task;
  };
  const connectAs = async (body) => {
    const c = await api("POST", "/api/connect/codes", operator, body);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await api("POST", "/api/connect/redeem", null, { code: c.body.code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: r.body.executor_id, token: r.body.token };
  };
  const claim = async (id, t) => api("POST", `/api/tasks/${id}/claim`, t, { expected_version: (await get(id)).aggregate_version });
  const report = async (id, t, body) => api("POST", `/api/tasks/${id}/report`, t, { run_id: (await get(id)).run_id, ...body });
  const resolve = async (id, verdict, note) => api("POST", `/api/tasks/${id}/resolve`, operator, { verdict, expected_version: (await get(id)).aggregate_version, allow_uncommitted: true, ...(note ? { note } : {}) });
  const edit = async (id, fields) => api("POST", `/api/tasks/${id}/update`, operator, { expected_version: (await get(id)).aggregate_version, ...fields });
  const release = async (id) => api("POST", `/api/tasks/${id}/release`, operator, { expected_version: (await get(id)).aggregate_version, released: true });
  const history = async (id) => (await api("GET", `/api/tasks/${id}/history`, operator)).body.entries;
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, worker, review, get, card, connectAs, claim, report, resolve, edit, release, history, stop, log: () => log, W, extra };
}
const codes = (t) => (t.progress_blockers || []).map((b) => b.code);

test("I10a 引用:钉版本与哈希、按哈希判过期、ref.stale 一次、REF_STALE(decide)、执行中 refs_stale、重钉 → 引用方说明 +1、based_on_stale_ref × 自动通过闸", { timeout: 150000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" }), A2 = await B.connectAs({ kind: "other", line: "auto" });
    const S = await B.card("规格", "alpha");
    const R = await B.card("照规格做", "ext", { refs: [S.id] });
    assert.deepEqual(R.refs.map((r) => [r.card, r.pinned.version, r.stale, r.review]), [[S.id, 1, false, false]]);
    assert.equal(R.refs[0].pinned.hash, R.refs[0].current.hash);
    assert.equal(R.refs[0].title, "规格");
    const v0 = R.spec_version;
    // 被引用卡改说明 → 过期(按哈希);ref.stale 只记一次
    assert.equal((await B.edit(S.id, { description: "说明 第二版" })).status, 200);
    assert.ok(await until(async () => (await B.history(R.id)).some((e) => e.kind === "ref.stale")), "引用方卡历史有 ref.stale");
    let r = await B.get(R.id);
    assert.deepEqual([r.refs[0].stale, r.refs[0].pinned.version, r.refs[0].current.version], [true, 1, 2]);
    const pb = r.progress_blockers.find((b) => b.code === "REF_STALE");
    assert.ok(pb, JSON.stringify(r.progress_blockers));
    assert.equal(pb.attention, "decide"); assert.deepEqual(pb.detail.refs, [{ card: S.id, pinned: 1, current: 2 }]);
    assert.ok(pb.message && pb.next_action);
    const c409 = await B.claim(R.id, X.token);
    assert.deepEqual([c409.status, c409.body.code], [409, "REF_STALE"], JSON.stringify(c409.body));
    const list = await B.api("GET", "/api/tasks?status=not_started&archived=false&claimable=1", B.operator);
    assert.ok(!list.body.tasks.some((t) => t.id === R.id), "列卡口同一判定");
    await B.edit(R.id, { summary: "碰一下引用方" });   // 再来几个 task.* 事件
    await delay(400);
    assert.equal((await B.history(R.id)).filter((e) => e.kind === "ref.stale").length, 1, "同一版本只记一次");
    // 重钉 → 不再过期;引用方说明版本 +1(已放行)
    const rp = await B.api("POST", `/api/tasks/${R.id}/refs/repin`, B.operator, { card: S.id });
    assert.equal(rp.status, 200, JSON.stringify(rp.body));
    assert.deepEqual([rp.body.changed, rp.body.task.refs[0].stale, rp.body.task.refs[0].pinned.version], [true, false, 2]);
    assert.equal(rp.body.task.spec_version, v0 + 1, "重钉让引用方说明版本 +1");
    assert.ok(!codes(rp.body.task).includes("REF_STALE"));
    assert.ok((await B.history(R.id)).some((e) => e.kind === "ref.repinned" && /重钉到 v2/.test(e.summary)));
    assert.equal((await B.api("POST", `/api/tasks/${R.id}/refs/repin`, B.operator, { card: S.id })).body.changed, false, "已是当前 = 不动");
    assert.equal((await B.api("POST", `/api/tasks/${R.id}/refs/repin`, B.operator, { card: 999 })).status, 404);
    // 执行中:被引用卡又改 → 心跳 refs_stale + next;板不强收
    const cl = await B.claim(R.id, X.token);
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    let hb = await B.api("POST", `/api/tasks/${R.id}/heartbeat`, X.token, { run_id: cl.body.task.run_id });
    assert.equal(hb.body.refs_stale, undefined, "没过期 = 不带");
    await B.edit(S.id, { description: "说明 第三版" });
    hb = await B.api("POST", `/api/tasks/${R.id}/heartbeat`, X.token, { run_id: cl.body.task.run_id });
    assert.deepEqual(hb.body.refs_stale, [{ card: S.id, pinned: 2, current: 3 }]); assert.match(hb.body.next, /规格已改/);
    assert.equal((await B.get(R.id)).status, "in_progress");
    // 交付时有过期引用 → based_on_stale_ref(任务字段 + 徽标 flags)
    const rr = await B.report(R.id, X.token, { outcome: "done", evidence: "做完了" });
    assert.equal(rr.status, 200, JSON.stringify(rr.body));
    r = await B.get(R.id);
    assert.equal(r.based_on_stale_ref, true);
    assert.ok(r.badge.flags.includes("based_on_stale_ref"), JSON.stringify(r.badge));
    assert.ok((await B.history(R.id)).some((e) => e.kind === "ref.stale_delivery"));
    // 自动通过闸:accept:auto 线上带过期引用的卡不自动通过(留在待验收);对照卡(引用当前版)自动通过
    const S2 = await B.card("另一份规格", "alpha");
    const bad = await B.card("引用会过期", "auto", { refs: [S2.id] }), good = await B.card("引用不过期", "auto", { refs: [S.id] });
    for (const id of [bad.id, good.id]) assert.equal((await B.claim(id, A2.token)).status, 200);
    await B.edit(S2.id, { description: "改了" });
    for (const id of [bad.id, good.id]) assert.equal((await B.report(id, A2.token, { outcome: "done", evidence: "交付 " + id })).status, 200);
    assert.deepEqual([(await B.get(bad.id)).status, (await B.get(bad.id)).waiting_for], ["waiting", "review"], "过期引用 → 转人工");
    assert.equal((await B.get(good.id)).status, "done", "对照:引用是当前版 → 自动通过 " + B.log().slice(-600));
    assert.match(B.log(), /based_on_stale_ref/);
    // 本人的显式裁定不受闸限制
    assert.equal((await B.resolve(bad.id, "approve")).status, 200);
    assert.equal((await B.get(bad.id)).status, "done");
    // 覆盖式写:保留原钉;清空;自己 / 不存在 / 已归档 拒收
    const keep = await B.api("POST", `/api/tasks/${R.id}/refs`, B.operator, { refs: [S.id, { card: S2.id, review: true }] });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    assert.deepEqual(keep.body.task.refs.map((x) => [x.card, x.pinned.version, x.review]), [[S.id, 2, false], [S2.id, 2, true]], "原有的钉不被覆盖悄悄重钉");
    assert.equal((await B.api("POST", `/api/tasks/${R.id}/refs`, B.operator, { refs: [R.id] })).status, 400);
    assert.equal((await B.api("POST", `/api/tasks/${R.id}/refs`, B.operator, { refs: [999999] })).status, 404);
    assert.equal((await B.api("POST", `/api/tasks/${R.id}/refs`, B.operator, {})).status, 400);
    const gone = await B.card("要归档的", "alpha");
    assert.equal((await B.api("POST", `/api/tasks/${gone.id}/archive`, B.operator, { expected_version: (await B.get(gone.id)).aggregate_version })).status, 200);
    assert.equal((await B.api("POST", `/api/tasks/${R.id}/refs`, B.operator, { refs: [gone.id] })).status, 409);
    assert.equal((await B.api("POST", "/api/tasks", B.operator, { subject: "引用归档卡", refs: [gone.id] })).status, 409);
    assert.deepEqual((await B.api("POST", `/api/tasks/${R.id}/refs`, B.operator, { refs: [] })).body.task.refs, []);
  } finally { await B.stop(); }
});

test("I10a 读范围:持卡执行者可读所持卡引用的别线卡(只给几项);没引用的别线卡、不再持卡后都读不到;真 stdio 桥", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });
    const S = await B.card("别线的规格", "alpha"), other = await B.card("别线没被引用的", "alpha");
    const R = await B.card("引用别线规格", "ext", { refs: [S.id] });
    assert.equal((await B.api("GET", `/api/tasks/${S.id}`, X.token)).status, 404, "还没持卡:读不到");
    assert.equal((await B.claim(R.id, X.token)).status, 200);
    const v = await B.api("GET", `/api/tasks/${S.id}`, X.token);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.deepEqual(Object.keys(v.body.task).sort(), ["acceptance", "content_is_untrusted", "description", "id", "ref_view", "spec_version", "subject"].sort());
    assert.deepEqual([v.body.task.subject, v.body.task.description, v.body.task.spec_version], ["别线的规格", "说明", 1]);
    for (const sub of ["history", "runs", "export-md"]) assert.equal((await B.api("GET", `/api/tasks/${S.id}/${sub}`, X.token)).status, 404, `子资源 ${sub} 不给`);
    assert.equal((await B.api("GET", `/api/tasks/${other.id}`, X.token)).status, 404, "没引用的别线卡照旧读不到");
    // 真 stdio 桥:get_card 被引用卡 → ref_view;get_card 自己的卡带 refs
    const tokenFile = join(B.dir, "x.token"); writeFileSync(tokenFile, X.token);
    const M = spawn(process.execPath, [BRIDGE, "--url", B.base, "--token-file", tokenFile, "--line", "ext"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: HOST_ENV });
    let buf = ""; const waiting = new Map(); M.stdout.setEncoding("utf8");
    M.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
    let n = 1; const rpc = (method, params) => { const id = n++; M.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return new Promise((r) => waiting.set(id, r)); };
    const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
    try {
      await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
      M.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const tools = (await rpc("tools/list", {})).result.tools;
      for (const name of ["report_result", "ask_operator"]) assert.ok(tools.find((t) => t.name === name).inputSchema.properties.reason_code, `${name} 有 reason_code`);
      const g = (await call("get_card", { id: S.id })).structuredContent;
      assert.deepEqual([g.card.ref_view, g.card.subject, g.card.spec_version], [true, "别线的规格", 1]);
      assert.equal(g.card.status, undefined, "不给状态 / 交付");
      const mine = (await call("get_card", { id: R.id })).structuredContent;
      assert.deepEqual(mine.card.refs, [{ card: S.id, title: "别线的规格", pinned: 1, current: 1, stale: false, review: false }]);
      const no = await call("get_card", { id: other.id });
      assert.equal(no.isError, true); assert.equal(no.structuredContent.code, "NOT_FOUND");
      const bad = await call("ask_operator", { id: R.id, question: "缺输入", reason_code: "Bad-Code" });
      assert.equal(bad.isError, true, "桥先挡乱值");
      const ask = (await call("ask_operator", { id: R.id, question: "缺输入", reason_code: "missing_input" })).structuredContent;
      assert.equal(ask.status, "waiting");
    } finally { M.stdin.end(); await new Promise((r) => M.once("close", r)); }
    assert.equal((await B.api("GET", `/api/tasks/${S.id}`, X.token)).status, 404, "不再持卡后读不到");
  } finally { await B.stop(); }
});

test("I10a 复审卡:不同线才出(同线 review_skipped)、未放行、review_of、〔X,S,digest〕防重、未开始重拼 / 已开始另出、结论 conform / deviates、过期、SPEC_DEVIATION、被取代不出", { timeout: 200000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" }), Y = await B.connectAs({ kind: "other", line: "ext2" });
    const goal = (await B.api("POST", "/api/tasks", B.operator, { subject: "目标", kind: "goal" })).body.task;
    const S = await B.card("规格(ext2 线)", "ext2");
    const same = await B.card("同线规格", "ext");
    const R = await B.card("照规格做(ext 线)", "ext", { parentId: goal.id, refs: [{ card: S.id, review: true }, { card: same.id, review: true }] });
    assert.deepEqual(R.refs.map((r) => [r.card, r.review, r.review_skipped ?? null]), [[S.id, true, null], [same.id, true, "same_line"]]);
    const reviewCards = async () => (await B.api("GET", "/api/tasks?archived=false", B.operator)).body.tasks.filter((t) => t.auto_kind === "spec_review");
    const deliver = async (id, tok, ev, extra = {}) => {
      const c = await B.claim(id, tok); assert.equal(c.status, 200, JSON.stringify(c.body));
      const r = await B.report(id, tok, { outcome: "done", evidence: ev, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body));
    };
    await deliver(R.id, X.token, "第一次交付", { files: [{ path: "src/a.mjs", sha256: "a".repeat(64) }] });
    const rc = await until(async () => { const l = await reviewCards(); return l.length ? l : null; });
    assert.equal(rc?.length, 1, "只出一张(同线那张不出)");
    let card = rc[0];
    const D1 = (await B.get(R.id)).fingerprint.digest;
    assert.deepEqual([card.line, !!card.released, card.parent_id, card.status], ["ext2", false, goal.id, "not_started"]);
    assert.deepEqual(card.review_of, { card: R.id, digest: D1, spec: { card: S.id, version: 1 } });
    assert.ok(card.description.includes(`#${S.id}`) && card.description.includes("src/a.mjs") && card.description.includes(D1.slice(0, 12)));
    assert.ok(!card.description.includes(B.dir), "不写本机路径");
    await B.edit(R.id, { summary: "再来一个事件" }); await delay(500);
    assert.equal((await reviewCards()).length, 1, "同一 digest 不再出");
    // X 再交付(digest 变):旧复审卡未开始 → 重拼说明,仍是一张
    assert.equal((await B.resolve(R.id, "reject", "再改改")).status, 200);
    await deliver(R.id, X.token, "第二次交付", { files: [{ path: "src/b.mjs", sha256: "b".repeat(64) }] });
    const D2 = (await B.get(R.id)).fingerprint.digest;
    assert.notEqual(D1, D2);
    card = await until(async () => { const l = await reviewCards(); return l.length === 1 && l[0].review_of.digest === D2 ? l[0] : null; });
    assert.ok(card, "重拼并改指到新 digest");
    assert.ok(card.description.includes("src/b.mjs"));
    // 复审卡开始了 → 再交付另出一张
    assert.equal((await B.release(card.id)).status, 200);
    assert.equal((await B.claim(card.id, Y.token)).status, 200);
    assert.equal((await B.resolve(R.id, "reject", "第三次")).status, 200);
    await deliver(R.id, X.token, "第三次交付");
    const D3 = (await B.get(R.id)).fingerprint.digest;
    const two = await until(async () => { const l = await reviewCards(); return l.length === 2 ? l : null; });
    assert.ok(two, "已开始的不动,另出一张 " + B.log().slice(-1500));
    const fresh = two.find((t) => t.id !== card.id);
    assert.equal(fresh.review_of.digest, D3);
    // 复审结论:spec_conformance=fail → 复审卡被验收通过后,X 记 deviates;X 待验收 → SPEC_DEVIATION(进「要本人做的事」)
    assert.equal((await B.report(card.id, Y.token, { outcome: "done", evidence: "与说明不符:少了导出", checks: [{ name: "spec_conformance", status: "fail", how: "ran" }] })).status, 200);
    assert.equal((await B.resolve(card.id, "approve")).status, 200);
    let x = await until(async () => { const t = await B.get(R.id); return t.spec_review ? t : null; });
    assert.deepEqual([x.spec_review.verdict, x.spec_review.by_card, x.spec_review.spec, x.spec_review.digest], ["deviates", card.id, { card: S.id, version: 1 }, D2]);
    assert.equal(x.spec_review.stale, true, "看的是 D2,X 现在是 D3 → 过期");
    assert.ok(!x.badge.flags.includes("spec_deviation"), "过期结论不计入徽标");
    assert.ok(!codes(x).includes("SPEC_DEVIATION"));
    // 第二张复审卡(看 D3)判 fail → 有效 deviates
    assert.equal((await B.release(fresh.id)).status, 200);
    assert.equal((await B.claim(fresh.id, Y.token)).status, 200);
    assert.equal((await B.report(fresh.id, Y.token, { outcome: "done", evidence: "不符", checks: [{ name: "spec_conformance", status: "fail", how: "ran" }] })).status, 200);
    assert.equal((await B.resolve(fresh.id, "approve")).status, 200);
    x = await until(async () => { const t = await B.get(R.id); return t.spec_review?.by_card === fresh.id ? t : null; });
    assert.equal(x.spec_review.stale, false);
    assert.ok(x.badge.flags.includes("spec_deviation"), JSON.stringify(x.badge));
    const dev = x.progress_blockers.find((b) => b.code === "SPEC_DEVIATION");
    assert.ok(dev, JSON.stringify(x.progress_blockers)); assert.equal(dev.attention, "decide");
    const bg = await B.api("GET", "/api/home/background", B.operator);
    assert.ok(bg.body.attention.some((a) => a.task_id === R.id), "待验收的 X 在「要本人做的事」里");
    assert.ok((await B.history(R.id)).some((e) => e.kind === "spec.reviewed" && /与说明不符/.test(e.summary)));
    // 规格版本变 → 结论过期
    await B.edit(S.id, { description: "规格改了" });
    x = await until(async () => { const t = await B.get(R.id); return t.spec_review?.stale ? t : null; });
    assert.ok(x && !x.badge.flags.includes("spec_deviation"));
    // conform 例:另一张引用方
    const R2 = await B.card("另一张照规格做", "ext", { refs: [{ card: S.id, review: true }] });
    await deliver(R2.id, X.token, "交付");
    const c2 = await until(async () => (await reviewCards()).find((t) => t.review_of.card === R2.id) || null);
    assert.equal((await B.release(c2.id)).status, 200); assert.equal((await B.claim(c2.id, Y.token)).status, 200);
    assert.equal((await B.report(c2.id, Y.token, { outcome: "done", evidence: "符合", checks: [{ name: "spec_conformance", status: "pass", how: "ran" }] })).status, 200);
    assert.equal((await B.resolve(c2.id, "approve")).status, 200);
    const y = await until(async () => { const t = await B.get(R2.id); return t.spec_review ? t : null; });
    assert.equal(y.spec_review.verdict, "conform"); assert.ok(y.badge.flags.includes("spec_reviewed"));
    // 被取代的引用方不出复审卡
    const R3 = await B.card("会被取代", "ext", { refs: [{ card: S.id, review: true }] }), neu = await B.card("新做法", "ext");
    assert.equal((await B.claim(R3.id, X.token)).status, 200);
    assert.equal((await B.api("POST", `/api/tasks/${R3.id}/supersede`, B.operator, { by: neu.id })).status, 200);
    assert.equal((await B.report(R3.id, X.token, { outcome: "done", evidence: "交了" })).status, 200);
    await delay(800);
    assert.ok(!(await reviewCards()).some((t) => t.review_of.card === R3.id), "被取代的卡不出复审卡");
  } finally { await B.stop(); }
});

test("I10b 底提交:三处入口、定时扫只读核 ok / behind / missing / diverged / unknown、BASE_GONE(fault)、执行中 base_gone、base_differs", { timeout: 150000 }, async () => {
  const B = await board({ prepare: (W) => { const c1 = W.commit("a.txt"), c2 = W.commit("b.txt"); W.git("checkout", "-q", "-b", "side", c1); const c3 = W.commit("c.txt"); W.git("checkout", "-q", "main"); return { c1, c2, c3 }; } });
  try {
    const { c1, c2, c3 } = B.extra;
    const X = await B.connectAs({ kind: "other", line: "ext" });
    const ok = await B.card("底在", "ext", { base: { commit: c1.slice(0, 10), onto: "refs/heads/main" } });
    const gone = await B.card("底没了", "ext", { base: { commit: "deadbeefdeadbeef" } });
    const div = await B.card("分叉", "ext", { base: { commit: c3, onto: "refs/heads/main" } });
    const norepo = await B.card("线没有工作仓", "ext2", { base: { commit: c1 } });
    const st = async (id) => (await B.get(id)).base?.state;
    assert.ok(await until(async () => (await st(ok.id)) === "ok" && (await st(gone.id)) === "missing" && (await st(div.id)) === "diverged"), JSON.stringify(await B.get(ok.id)));
    const o = await B.get(ok.id);
    assert.deepEqual([o.base.commit, o.base.onto, o.base.behind], [c1.slice(0, 10), "refs/heads/main", 1]);
    assert.ok(o.base.checked_at);
    assert.equal(await st(norepo.id), "unknown");
    assert.ok(!codes(await B.get(norepo.id)).includes("BASE_GONE"), "unknown 不拦");
    assert.ok(!codes(o).includes("BASE_GONE"), "behind 不拦");
    for (const [t, state] of [[gone, "missing"], [div, "diverged"]]) {
      const x = await B.get(t.id), b = x.progress_blockers.find((y) => y.code === "BASE_GONE");
      assert.ok(b, JSON.stringify(x.progress_blockers)); assert.deepEqual([b.attention, b.detail.state], ["fault", state]);
      const r = await B.claim(t.id, X.token);
      assert.deepEqual([r.status, r.body.code], [409, "BASE_GONE"]);
    }
    // 接口写 / 撤销;乱值 400
    const ch = await B.api("POST", `/api/tasks/${gone.id}/base`, B.operator, { base: { commit: c2 } });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    assert.ok(await until(async () => (await st(gone.id)) === "ok"), "写入后立刻补扫");
    assert.equal((await B.api("POST", `/api/tasks/${gone.id}/base`, B.operator, { base: { commit: "xyz" } })).status, 400);
    assert.equal((await B.api("POST", `/api/tasks/${gone.id}/base`, B.operator, {})).status, 400);
    assert.equal((await B.api("POST", `/api/tasks/${div.id}/base`, B.operator, { base: null })).body.task.base, null);
    assert.ok((await B.history(gone.id)).some((e) => e.kind === "base.set"));
    // 执行中变成 diverged → 心跳 base_gone + next;板不强收
    const run = await B.card("执行中底分叉", "ext", { base: { commit: c2, onto: "refs/heads/main" } });
    assert.ok(await until(async () => (await st(run.id)) === "ok"));
    const cl = await B.claim(run.id, X.token); assert.equal(cl.status, 200);
    B.W.git("reset", "-q", "--hard", c1);           // main 退回 c1:c2 不再是 main 的祖先
    assert.ok(await until(async () => (await st(run.id)) === "diverged"));
    const hb = await B.api("POST", `/api/tasks/${run.id}/heartbeat`, X.token, { run_id: cl.body.task.run_id });
    assert.deepEqual(hb.body.base_gone, { state: "diverged" }); assert.match(hb.body.next, /底变了/);
    // 交付指纹的 base_commit 与卡上的不同 → base_differs(只提示)
    const rr = await B.report(run.id, X.token, { outcome: "done", evidence: "做完", base_commit: c1 });
    assert.equal(rr.status, 200, JSON.stringify(rr.body));
    assert.ok((await B.get(run.id)).badge.flags.includes("base_differs"));
    assert.ok(!(await B.get(ok.id)).badge, "没交付的卡没有徽标");
  } finally { await B.stop(); }
});

test("I10c 卡死:stuck_after 设置(只有操作者)、reason_code、到阈值 STUCK(decide)+ task.stuck 一次、排队领跳下一张、清零(只追加)、改说明清零、0 = 关", { timeout: 150000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" }), A = await B.connectAs({ kind: "other", role: "assistant", label: "助手" });
    assert.deepEqual((await B.api("GET", "/api/home/prefs", B.operator)).body, { autostart: false, stuck_after: 3, quota_low_at: 90, bulk_lines: [] });
    for (const bad of [{ stuck_after: 1 }, { stuck_after: 11 }, { stuck_after: "2" }, { stuck_after: 2, x: 1 }, {}])
      assert.equal((await B.api("PUT", "/api/home/prefs", B.operator, bad)).status, 400, JSON.stringify(bad));
    for (const t of [X.token, A.token, B.worker, B.review]) assert.equal((await B.api("PUT", "/api/home/prefs", t, { stuck_after: 2 })).status, 403);
    assert.deepEqual((await B.api("PUT", "/api/home/prefs", B.operator, { stuck_after: 2 })).body, { autostart: false, stuck_after: 2, quota_low_at: 90, bulk_lines: [] });
    const k = await B.card("老卡住", "ext"), next = await B.card("下一张", "ext");
    const loop = async (reason) => {
      const c = await B.claim(k.id, X.token); assert.equal(c.status, 200, JSON.stringify(c.body));
      const r = await B.report(k.id, X.token, { outcome: "wait", evidence: "缺东西", reason_code: reason }); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await B.resolve(k.id, "reject", "再试 " + Math.random())).status, 200);
    };
    // 乱 reason_code → 400,卡仍在执行中
    const c0 = await B.claim(k.id, X.token); assert.equal(c0.status, 200);
    assert.equal((await B.report(k.id, X.token, { outcome: "wait", evidence: "x", reason_code: "Bad Code" })).status, 400);
    assert.equal((await B.get(k.id)).status, "in_progress");
    assert.equal((await B.report(k.id, X.token, { outcome: "wait", evidence: "缺东西", reason_code: "missing_input" })).status, 200);
    assert.equal((await B.resolve(k.id, "reject", "再试一次")).status, 200);
    assert.equal((await B.get(k.id)).stuck, null);
    await loop("missing_input");
    const t = await B.get(k.id);
    assert.ok(t.stuck, JSON.stringify(t));
    assert.ok(t.stuck.count >= 2 && t.stuck.last.length >= 2 && t.stuck.since);
    const sb = t.progress_blockers.find((b) => b.code === "STUCK");
    assert.ok(sb); assert.equal(sb.attention, "decide"); assert.match(sb.message, /连着.+ \d 次/);
    assert.deepEqual([(await B.claim(k.id, X.token)).status, (await B.claim(k.id, X.token)).body.code], [409, "STUCK"]);
    const q = await B.api("POST", "/api/claim", X.token, {});
    assert.equal(q.body?.task?.id, next.id, "排队领跳过卡死的,领下一张");
    assert.ok(await until(async () => (await B.history(k.id)).some((e) => e.kind === "task.stuck")));
    await B.edit(next.id, { summary: "多几个事件" }); await delay(400);
    assert.equal((await B.history(k.id)).filter((e) => e.kind === "task.stuck").length, 1, "task.stuck 只记一次");
    // 受管线(worker 令牌):卡死的领不到,跳下一张
    const m1 = await B.card("受管线卡死", "alpha"), m2 = await B.card("受管线下一张", "alpha");
    for (let i = 0; i < 2; i++) {
      const g = await B.api("POST", "/api/claim", B.worker, { worker: "alpha", line: "alpha", worker_protocol_version: 2, agent_instance_id: randomUUID() });
      assert.equal(g.body?.task?.id, m1.id, JSON.stringify(g.body));
      assert.equal((await B.api("POST", `/api/tasks/${m1.id}/report`, B.worker, { worker: "alpha", run_id: g.body.task.run_id, outcome: "wait", evidence: "停下" })).status, 200);
      assert.equal((await B.resolve(m1.id, "reject", "第 " + i + " 次")).status, 200);
    }
    assert.ok((await B.get(m1.id)).stuck);
    const g2 = await B.api("POST", "/api/claim", B.worker, { worker: "alpha", line: "alpha", worker_protocol_version: 2, agent_instance_id: randomUUID() });
    assert.equal(g2.body?.task?.id, m2.id, "受管线领不到就跳下一张,不续跑同一张");
    // 清零:审计只追加;清了能领
    const cl = await B.api("POST", `/api/tasks/${k.id}/stuck/clear`, B.operator, { note: "看过了\n继续" });
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    assert.equal(cl.body.task.stuck, null); assert.ok(cl.body.was);
    assert.ok(!codes(cl.body.task).includes("STUCK"));
    assert.equal((await B.api("POST", `/api/tasks/${k.id}/stuck/clear`, B.operator, {})).status, 200, "再清一次也只是追加");
    assert.equal((await B.history(k.id)).filter((e) => e.kind === "stuck.cleared").length, 2);
    assert.ok((await B.history(k.id)).some((e) => /清零:看过了 继续/.test(e.summary)), "note 压成一行");
    // 改说明(放行后说明版本变)也清零
    await loop("missing_input"); await loop("missing_input");
    assert.ok((await B.get(k.id)).stuck);
    assert.equal((await B.edit(k.id, { description: "补上了输入" })).status, 200);
    assert.equal((await B.get(k.id)).stuck, null, "改说明清零");
    // 0 = 关
    await loop("x"); await loop("x");
    assert.ok((await B.get(k.id)).stuck);
    assert.equal((await B.api("PUT", "/api/home/prefs", B.operator, { stuck_after: 0 })).status, 200);
    assert.equal((await B.get(k.id)).stuck, null);
    assert.equal((await B.api("GET", "/api/home/prefs", B.operator)).body.stuck_after, 0, "存在首页设置里");
  } finally { await B.stop(); }
});

test("写权限矩阵:新接口只有操作者;助手挂卡带 refs / base 400;worker 派生卡带 403;助手视图不出新字段", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" }), A = await B.connectAs({ kind: "other", role: "assistant", label: "助手" });
    const S = await B.card("规格", "ext"), a = await B.card("甲", "ext", { refs: [S.id], base: { commit: "abcdef1" } });
    for (const [who, token] of [["执行者", X.token], ["助手", A.token], ["worker", B.worker], ["审阅", B.review]]) {
      for (const [path, body] of [[`/api/tasks/${a.id}/refs`, { refs: [] }], [`/api/tasks/${a.id}/refs/repin`, { card: S.id }], [`/api/tasks/${a.id}/base`, { base: null }], [`/api/tasks/${a.id}/stuck/clear`, {}]]) {
        const r = await B.api("POST", path, token, body);
        assert.equal(r.status, 403, `${who} ${path} ${JSON.stringify(r.body)}`);
      }
    }
    const t = await B.get(a.id);
    assert.equal(t.refs.length, 1); assert.equal(t.base.commit, "abcdef1"); assert.ok(!(await B.history(a.id)).some((e) => e.kind === "stuck.cleared"), "什么都没写进去");
    for (const k of ["refs", "base"]) {
      const r = await B.api("POST", "/api/assistant/cards", A.token, { subject: "助手挂的", description: "", acceptance: "", [k]: k === "refs" ? [S.id] : { commit: "abcdef1" } });
      assert.equal(r.status, 400, `助手带 ${k}: ${JSON.stringify(r.body)}`);
      const w = await B.api("POST", "/api/tasks", B.worker, { subject: "派生", parentId: a.id, parent_run_id: "x", worker: "w", [k]: k === "refs" ? [S.id] : { commit: "abcdef1" } });
      assert.equal(w.status, 403, `worker 带 ${k}: ${JSON.stringify(w.body)}`);
    }
    const av = (await B.api("GET", `/api/tasks/${a.id}`, A.token)).body.task;
    for (const k of ["refs", "base", "stuck", "spec_review", "review_of", "based_on_stale_ref"]) assert.equal(Object.hasOwn(av, k), false, `助手看不到 ${k}`);
    // 建卡乱值 400
    assert.equal((await B.api("POST", "/api/tasks", B.operator, { subject: "坏引用", refs: "3" })).status, 400);
    assert.equal((await B.api("POST", "/api/tasks", B.operator, { subject: "坏底", base: { commit: "zz" } })).status, 400);
  } finally { await B.stop(); }
});

test("计划项带 refs / base:合规的设上,不合规的静默不设", { timeout: 120000 }, async () => {
  const log = join(TMP, "coord-calls.jsonl");
  const B = await board({ env: { BOARD_COORDINATOR_CLI_ARGV: JSON.stringify([process.execPath, FAKE]), CONVTEST_LOG: log } });
  try {
    const first = await B.card("先有的规格", "alpha");
    assert.equal(first.id, 1, "计划里写的卡号 1");
    const made = await B.api("POST", "/api/conversations", B.operator, { message: "【引用】三张卡" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.conversation.id;
    let d;
    for (let i = 0; i < 300; i++) { d = (await B.api("GET", `/api/conversations/${id}`, B.operator)).body; if (d.conversation.status !== "running") break; await delay(100); }
    assert.equal(d.plans.length, 1, JSON.stringify(d.conversation));
    const ap = await B.api("POST", `/api/conversations/${id}/plans/1/apply`, B.operator, { expected_rev: 1 });
    assert.equal(ap.status, 201, JSON.stringify(ap.body));
    const kids = await Promise.all(ap.body.task_ids.map((t) => B.get(t)));
    assert.deepEqual(kids.map((k) => [k.subject, k.refs.map((r) => r.card), k.base?.commit ?? null]),
      [["甲", [1], "abc1234"], ["乙", [1], null], ["丙", [], null]]);
  } finally { await B.stop(); }
});

// ── 联合(8d × 8c,合同 I11):真 8d 代码产出的三种阻塞带 attention,过首页 home-model(/api/home/background)与简报归类。
test("联合(8d × 8c):REF_STALE / BASE_GONE / STUCK 经通用规则进「要本人做的事」且类型对(decide / fault / decide),简报 decision / blocked / decision", { timeout: 150000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });
    assert.equal((await B.api("PUT", "/api/home/prefs", B.operator, { stuck_after: 2 })).status, 200);
    const S = await B.card("规格", "ext2");
    const ref = await B.card("引用会过期", "ext", { refs: [S.id] });
    const gone = await B.card("底没了", "ext", { base: { commit: "deadbeefdeadbeef" } });
    const k = await B.card("会卡死", "ext");
    await B.edit(S.id, { description: "改了" });
    for (let i = 0; i < 2; i++) {
      assert.equal((await B.claim(k.id, X.token)).status, 200);
      assert.equal((await B.report(k.id, X.token, { outcome: "wait", evidence: "缺输入", reason_code: "missing_input" })).status, 200);
      assert.equal((await B.resolve(k.id, "reject", "再试 " + i)).status, 200);
    }
    const want = [[ref.id, "REF_STALE", "decide", "decision"], [gone.id, "BASE_GONE", "fault", "blocked"], [k.id, "STUCK", "decide", "decision"]];
    const ok = await until(async () => {
      for (const [id, code] of want) if (!codes(await B.get(id)).includes(code)) return false;
      return true;
    });
    assert.ok(ok, JSON.stringify(await Promise.all(want.map(async ([id]) => codes(await B.get(id))))));
    const bg = (await B.api("GET", "/api/home/background", B.operator)).body;
    const brief = (await B.api("GET", "/api/brief", B.operator)).body;
    for (const [id, code, type, kind] of want) {
      const blk = (await B.get(id)).progress_blockers.find((b) => b.code === code);
      assert.equal(blk.attention, type, `${code} 带 attention`);
      const a = bg.attention.find((x) => x.task_id === id);
      assert.ok(a, `${code} #${id} 进「要本人做的事」 ` + JSON.stringify(bg.attention));
      assert.equal(a.type, type, `${code} 的类型`);
      assert.equal(brief.attention.find((x) => x.task_id === id)?.kind, kind, `${code} 简报归类`);
    }
    assert.equal(bg.attention_type_mismatch, undefined, "条数对得上");
  } finally { await B.stop(); }
});
