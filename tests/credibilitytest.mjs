import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 合同 H1–H4「可信」(core/credibility.mjs):指纹 digest 与板侧只读核对(三态)、路径 / 提交号拒收、
// 再交付后旧结论 stale + changed_files、executor 报全 pass 徽标仍是自报、运行时家族判定(含未知)、
// required_checks 与自动通过的硬闸(含 based_on_stale_spec)、基线红单列、写入权限矩阵、旧桥不带新参数时行为不变。
// `node --test tests/credibilitytest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { openCredibility, canonicalFingerprint, normPath, normCommit, parseDelivery, verifyFingerprint, familyOf, gitQueryEnv } from "../core/credibility.mjs";
import { resolveGit } from "../core/git-program.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ERR = { NOT_FOUND: "NOT_FOUND", CONFLICT: "CONFLICT", BAD_INPUT: "BAD_INPUT" };
const err = (code, message) => Object.assign(new Error(message), { code });
const ctx = { err, ERR };
const sha = (x) => createHash("sha256").update(x).digest("hex");
const GIT = resolveGit({ env: process.env }).path;

/** 一个临时 git 仓:两个文件、一次提交。返回 { dir, head, blobs }。 */
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "credtest-repo-"));
  const g = (...a) => execFileSync(GIT, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "core.autocrlf=false", "-C", dir, ...a],
                                   { env: gitQueryEnv(HOST_ENV), windowsHide: true }).toString().trim();
  g("init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.txt"), "alpha\n");
  writeFileSync(join(dir, "b.txt"), "beta\n");
  g("add", "-A"); g("commit", "-q", "-m", "one");
  const base = g("rev-parse", "HEAD");
  writeFileSync(join(dir, "b.txt"), "beta two\n");
  g("add", "-A"); g("commit", "-q", "-m", "two");
  const head = g("rev-parse", "HEAD");
  return { dir, base, head, blobs: { "src/a.txt": sha("alpha\n"), "b.txt": sha("beta two\n") } };
}

// ── 纯函数 ───────────────────────────────────────────────────────────────────────
test("H1 digest:文件顺序无关;内容 / 正文一变 digest 就变;tree 与 verified 不进 digest", () => {
  const f1 = [{ path: "b.txt", sha256: "1".repeat(64) }, { path: "src/a.txt", sha256: "2".repeat(64) }];
  const a = canonicalFingerprint({ head_commit: "a".repeat(40), files: f1, evidence_sha256: "e" });
  const b = canonicalFingerprint({ head_commit: "a".repeat(40), files: [...f1].reverse(), evidence_sha256: "e" });
  assert.equal(a.digest, b.digest);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  assert.notEqual(a.digest, canonicalFingerprint({ head_commit: "a".repeat(40), files: [f1[0]], evidence_sha256: "e" }).digest);
  assert.notEqual(a.digest, canonicalFingerprint({ head_commit: "a".repeat(40), files: f1, evidence_sha256: "f" }).digest);
  assert.notEqual(a.digest, canonicalFingerprint({ head_commit: "b".repeat(40), files: f1, evidence_sha256: "e" }).digest);
});

test("H1 路径:相对工作仓、规范化;绝对路径 / 盘符 / .. / .git / 冒号 / 控制字符拒收", () => {
  assert.equal(normPath("src\\a.txt", ctx), "src/a.txt");
  assert.equal(normPath("./src//a.txt", ctx), "src/a.txt");
  for (const bad of ["/etc/passwd", "C:/x", "c:x", "\\\\host\\share\\x", "../x", "src/../../x", "a/..", ".git/config", "src/.GIT/x", "a:b", "a\u0000b", "a\nb", "", ".", "./"])
    assert.throws(() => normPath(bad, ctx), (e) => e.code === "BAD_INPUT", JSON.stringify(bad));
  assert.throws(() => parseDelivery({ files: [{ path: "../up", sha256: "1".repeat(64) }] }, ctx), /\.\./);
  assert.throws(() => parseDelivery({ files: [{ path: "x", sha256: "nothex" }] }, ctx), /sha256/);
  assert.throws(() => parseDelivery({ files: [{ path: "x", sha256: "1".repeat(64) }, { path: "./x", sha256: "2".repeat(64) }] }, ctx), /重复/);
  assert.throws(() => parseDelivery({ files: Array.from({ length: 51 }, (_, i) => ({ path: `f${i}`, sha256: "1".repeat(64) })) }, ctx), /50/);
});

test("H1 提交号:只收完整十六进制(防选项注入);大写存小写", () => {
  assert.equal(normCommit("A".repeat(40), "head_commit", ctx), "a".repeat(40));
  assert.equal(normCommit("b".repeat(64), "head_commit", ctx), "b".repeat(64));
  assert.equal(normCommit(undefined, "head_commit", ctx), null);
  for (const bad of ["abc1234", "--output=x", "-c", "g".repeat(40), "a".repeat(41), "a".repeat(39) + " ", "HEAD", "a".repeat(40) + "^{tree}", 42, {}])
    assert.throws(() => normCommit(bad, "head_commit", ctx), (e) => e.code === "BAD_INPUT", JSON.stringify(bad));
});

test("H3 executor 的 checks:by / digest 一概不收,how 缺省 inferred,status 与 baseline 严格", () => {
  const p = parseDelivery({ checks: [{ name: "unit", status: "pass", how: "ran", by: "board", digest: "x" }, { name: "lint", status: "fail", baseline: true }] }, ctx);
  assert.deepEqual(p.checks, [{ name: "unit", status: "pass", how: "ran", baseline: false }, { name: "lint", status: "fail", how: "inferred", baseline: true }]);
  assert.throws(() => parseDelivery({ checks: [{ name: "u", status: "ok" }] }, ctx), /status/);
  assert.throws(() => parseDelivery({ checks: [{ name: "u", status: "pass", how: "guess" }] }, ctx), /how/);
  assert.throws(() => parseDelivery({ checks: [{ name: "u", status: "pass", baseline: "yes" }] }, ctx), /baseline/);
  assert.throws(() => parseDelivery({ checks: [{ name: "", status: "pass" }] }, ctx), /name/);
  assert.equal(parseDelivery({}, ctx).provided, false);
});

test("运行时家族:claude / codex / zcode 已知,其他与空 = 未知", () => {
  assert.equal(familyOf("claude"), "claude");
  assert.equal(familyOf("claude-opus-5"), "claude");
  assert.equal(familyOf("codex"), "codex");
  assert.equal(familyOf("zcode"), "zcode");
  for (const u of ["other", "", null, undefined, "bot", "gemini", "claudette"]) assert.equal(familyOf(u), null, String(u));
});

test("H1 verified 三态:核过 true / 对不上 false / 核不了 null(只读 git,继承的 GIT_* 清掉)", { skip: !GIT && "没有 git" }, async () => {
  const R = gitRepo();
  try {
    const fp = (o) => ({ base_commit: null, head_commit: null, files: [], provided: true, ...o });
    const files = Object.entries(R.blobs).map(([path, sha256]) => ({ path, sha256 }));
    const ok = await verifyFingerprint({ git: GIT, repo: R.dir, fp: fp({ base_commit: R.base, head_commit: R.head, files }) });
    assert.equal(ok.verified, true, JSON.stringify(ok));
    assert.match(ok.tree, /^[0-9a-f]{40,64}$/);
    // 对不上:内容哈希不同、文件不在提交里、提交不存在
    assert.equal((await verifyFingerprint({ git: GIT, repo: R.dir, fp: fp({ head_commit: R.head, files: [{ path: "b.txt", sha256: sha("beta\n") }] }) })).verified, false);
    assert.equal((await verifyFingerprint({ git: GIT, repo: R.dir, fp: fp({ head_commit: R.head, files: [{ path: "nope.txt", sha256: "1".repeat(64) }] }) })).verified, false);
    const gone = await verifyFingerprint({ git: GIT, repo: R.dir, fp: fp({ head_commit: "0123456789abcdef0123456789abcdef01234567" }) });
    assert.equal(gone.verified, false); assert.match(gone.mismatch.join(), /不存在/);
    // 核不了:没有仓、目录不是仓、没给 head_commit 的文件、没有 git
    assert.equal((await verifyFingerprint({ git: GIT, repo: null, fp: fp({ head_commit: R.head }) })).verified, null);
    const plain = mkdtempSync(join(tmpdir(), "credtest-plain-"));
    assert.equal((await verifyFingerprint({ git: GIT, repo: plain, fp: fp({ head_commit: R.head }) })).verified, null);
    rmSync(plain, { recursive: true, force: true });
    assert.equal((await verifyFingerprint({ git: GIT, repo: R.dir, fp: fp({ files }) })).verified, null);
    assert.equal((await verifyFingerprint({ git: null, repo: R.dir, fp: fp({ head_commit: R.head }) })).verified, null);
    // 继承的 GIT_DIR 改不了查询的去处
    const keep = process.env.GIT_DIR; process.env.GIT_DIR = join(tmpdir(), "credtest-not-a-git-dir");
    try { assert.equal((await verifyFingerprint({ git: GIT, repo: R.dir, fp: fp({ head_commit: R.head, files }) })).verified, true); }
    finally { if (keep === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = keep; }
  } finally { rmSync(R.dir, { recursive: true, force: true }); }
});

/** 内存库上的 credibility(不起看板)。 */
function memCred() {
  const db = new DatabaseSync(":memory:");
  let t = 0;
  const c = openCredibility({ db, err, ERR, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString(), commandHash: (k) => sha("argv:" + k) });
  c.migrate();
  return c;
}
const deliver = (c, task, body, opts = {}) => c.recordDelivery(task, c.parseDelivery(body), { evidence: "正文", ...opts });

test("H3 徽标:executor 报全 pass 仍是 self_reported;已核检查才抬档;flags 与 provenance 从事实推出", async () => {
  const c = memCred(), task = { id: 1, line: "x" };
  await deliver(c, task, { checks: [{ name: "unit", status: "pass", how: "ran" }, { name: "e2e", status: "pass", how: "ran" }] }, { authorRuntime: "codex" });
  let f = c.fields(task);
  assert.equal(f.badge.level, "self_reported");
  assert.deepEqual(f.evidence_counts.self, { passed: 2, failed: 0, unverified: 0, baseline_failed: 0 });
  assert.deepEqual(f.evidence_counts.verified, { passed: 0, failed: 0, unverified: 0, baseline_failed: 0 });
  assert.ok(f.checks.every((x) => x.by === "executor"));
  // 审阅座席复跑一项 → machine_verified(没有 required_checks:至少一项已核实跑、没有失败)
  c.addVerifiedCheck(1, { name: "unit", ok: true, by: "reviewer", env: "reviewer:claude" });
  f = c.fields(task);
  assert.equal(f.badge.level, "machine_verified");
  assert.ok(f.badge.provenance.some((p) => p.what === "check:unit" && p.by === "reviewer" && p.digest === f.fingerprint.digest));
  assert.equal(f.checks.find((x) => x.by === "reviewer").command_hash, sha("argv:unit"));
  // 有 required_checks 且缺一项 → 只到 independent_rerun
  c.setRequired(1, ["unit", "e2e"], "operator");
  assert.equal(c.fields(task).badge.level, "independent_rerun");
  assert.equal(c.autoGate(task).ok, false);
  assert.match(c.autoGate(task).missing.join(), /e2e/);
  c.addVerifiedCheck(1, { name: "e2e", ok: true, by: "board", env: "host:test" });
  assert.equal(c.fields(task).badge.level, "machine_verified");
  assert.equal(c.autoGate(task).ok, true);
  // based_on_stale_spec(合同 H6 的字段,这里直接置):不自动通过,徽标带 flag
  assert.equal(c.autoGate(task, { staleSpec: true }).ok, false);
  assert.match(c.autoGate(task, { staleSpec: true }).missing.join(), /旧版说明/);
  assert.ok(c.fields(task, { staleSpec: true }).badge.flags.includes("based_on_stale_spec"));
  assert.ok(!c.fields(task).badge.flags.includes("based_on_stale_spec"));
  // 已核的失败 → 不满足
  c.addVerifiedCheck(1, { name: "e2e", ok: false, by: "board" });
  assert.equal(c.autoGate(task).ok, false);
  assert.throws(() => c.addVerifiedCheck(1, { name: "x", ok: true, by: "executor" }), /board \/ reviewer/);
});

test("H3 cross_model_reviewed:两边家族都已知且不同才算;未知不算;digest 不是当前不算", async () => {
  for (const [author, reviewer, want] of [["codex", "claude", "cross_model_reviewed"], ["claude", "claude", "self_reported"],
       ["other", "claude", "self_reported"], [null, "claude", "self_reported"], ["zcode", null, "self_reported"], ["zcode", "codex", "cross_model_reviewed"]]) {
    const c = memCred(), task = { id: 7 };
    await deliver(c, task, {}, { authorRuntime: author });
    c.addConclusion(7, { kind: "review", verdict: "approve", by: "reviewer", runtime: reviewer });
    assert.equal(c.fields(task).badge.level, want, `${author} ← ${reviewer}`);
    if (want === "cross_model_reviewed") {
      await deliver(c, task, {}, { authorRuntime: author, evidence: "改过的正文" });       // 再交付:结论不再是当前 digest
      const f = c.fields(task);
      assert.equal(f.badge.level, "self_reported");
      assert.ok(f.badge.flags.includes("stale"));
      assert.equal(f.conclusions[0].stale, true);
    }
  }
});

test("H2 再交付:旧结论与旧检查 stale,给 changed_files(两次 files 的差)", async () => {
  const c = memCred(), task = { id: 3 };
  const f1 = [{ path: "a.txt", sha256: "1".repeat(64) }, { path: "b.txt", sha256: "2".repeat(64) }, { path: "c.txt", sha256: "3".repeat(64) }];
  await deliver(c, task, { head_commit: "a".repeat(40), files: f1 }, { authorRuntime: "codex" });
  c.addVerifiedCheck(3, { name: "unit", ok: true, by: "reviewer" });
  c.addConclusion(3, { kind: "review", verdict: "reject", by: "reviewer", runtime: "claude" });
  c.addConclusion(3, { kind: "acceptance", verdict: "reject", by: "operator" });
  const d1 = c.currentDigest(3);
  assert.equal(c.fields(task).conclusions.every((x) => !x.stale), true);
  const f2 = [{ path: "a.txt", sha256: "1".repeat(64) }, { path: "b.txt", sha256: "9".repeat(64) }, { path: "d.txt", sha256: "4".repeat(64) }];
  await deliver(c, task, { head_commit: "b".repeat(40), files: f2 }, { authorRuntime: "codex" });
  const f = c.fields(task);
  assert.notEqual(f.fingerprint.digest, d1);
  assert.deepEqual(f.fingerprint.changed_files, ["b.txt", "c.txt", "d.txt"]);
  assert.ok(f.conclusions.every((x) => x.stale && x.digest === d1));
  assert.deepEqual(f.conclusions[0].changed_files, ["b.txt", "c.txt", "d.txt"]);
  assert.ok(f.checks.find((x) => x.name === "unit").stale);
  assert.equal(f.badge.level, "self_reported");             // 旧指纹上的复跑不再计入
  assert.deepEqual(f.badge.flags, ["stale"]);
  // 同名检查在新指纹上重跑过之后,stale 不再挂着
  c.addVerifiedCheck(3, { name: "unit", ok: true, by: "reviewer" });
  c.addConclusion(3, { kind: "review", verdict: "approve", by: "reviewer", runtime: "claude" });
  c.addConclusion(3, { kind: "acceptance", verdict: "approve", by: "operator" });
  assert.deepEqual(c.fields(task).badge.flags, []);
});

test("H4 基线红:baseline_failed 单列、不计入 failed;自报与已核分开;first_seen_commit", async () => {
  const c = memCred(), task = { id: 4 };
  await deliver(c, task, { base_commit: "c".repeat(40), checks: [{ name: "flaky", status: "fail", baseline: true }, { name: "unit", status: "fail" }, { name: "doc", status: "unverified" }] });
  c.addVerifiedCheck(4, { name: "lint", ok: false, by: "reviewer", baseline: true });
  const f = c.fields(task);
  assert.deepEqual(f.evidence_counts.self, { passed: 0, failed: 1, unverified: 1, baseline_failed: 1 });
  assert.deepEqual(f.evidence_counts.verified, { passed: 0, failed: 0, unverified: 0, baseline_failed: 1 });
  assert.equal(f.baseline.base_commit, "c".repeat(40));
  assert.deepEqual(f.baseline.red.map((r) => [r.check, r.by, r.first_seen_commit]).sort(), [["flaky", "executor", "c".repeat(40)], ["lint", "reviewer", "c".repeat(40)]]);
  assert.equal(f.baseline.self, 1); assert.equal(f.baseline.verified, 1);
  assert.ok(f.badge.flags.includes("baseline_red"));
});

test("H1 fingerprint_mismatch:徽标降到 self_reported 并标出;自动通过不放", async () => {
  const c = memCred(), task = { id: 5, line: "x" };
  // 用一个永远对不上的「仓」:没有 git 时核不了(null),这里直接测推导 —— 记一条 verified=false 的交付
  const R = GIT ? gitRepo() : null;
  try {
    const c2 = openCredibility({ db: new DatabaseSync(":memory:"), err, ERR, git: () => GIT, repoForLine: () => R?.dir ?? null });
    c2.migrate();
    await c2.recordDelivery(task, c2.parseDelivery({ head_commit: "0123456789abcdef0123456789abcdef01234567" }), { evidence: "x" });
    c2.addVerifiedCheck(5, { name: "unit", ok: true, by: "reviewer" });
    const f = c2.fields(task);
    if (GIT) {
      assert.equal(f.fingerprint.verified, false);
      assert.equal(f.badge.level, "self_reported");
      assert.ok(f.badge.flags.includes("fingerprint_mismatch"));
      assert.equal(c2.autoGate(task).ok, false);
    }
  } finally { if (R) rmSync(R.dir, { recursive: true, force: true }); }
  void c;
});

// ── 看板进程(HTTP + 真 stdio 桥)─────────────────────────────────────────────────
async function board({ repo, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "credibilitytest-")), config = join(dir, "fleet.json"), registry = join(dir, "verify_registry.json");
  writeFileSync(registry, JSON.stringify({ unit: ["node", "-e", "0"], e2e: ["node", "-e", "0"] }));
  writeFileSync(config, JSON.stringify({ lines: [
    { id: "alpha" },
    { id: "auto", label: "自动", external: true, accept: "auto", ...(repo ? { work_repo: repo } : {}) },
    { id: "hum", label: "人验", external: true, ...(repo ? { work_repo: repo } : {}) },
    { id: "oth", label: "其他", external: true },
  ], roles: [], routes: ["default"], repo: dir }));
  const BAD_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
  let port;
  do { const l = createServer(); await new Promise((r) => l.listen(0, "127.0.0.1", r)); port = l.address().port; await new Promise((r) => l.close(r)); } while (BAD_PORTS.has(port));
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit",
           BOARD_DELIVERABLE_GATE: "off", BOARD_VERIFY_REGISTRY: registry, ...extraEnv } });
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
  const claim = async (X, t) => {
    const cur = await get(t.id);
    const cl = await api("POST", `/api/tasks/${t.id}/claim`, X.token, { expected_version: cur.aggregate_version });
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    return cl.body.task.run_id;
  };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, worker, review, card, connectAs, get, claim, stop, log: () => log };
}

test("看板:指纹核对 + 自报检查抬不动徽标 + required_checks 闸 + 旧桥行为不变 + 乱值拒收", { skip: !GIT && "没有 git" }, async () => {
  const R = gitRepo();
  const B = await board({ repo: R.dir });
  try {
    const A = await B.connectAs({ kind: "codex", line: "auto" });
    const files = Object.entries(R.blobs).map(([path, sha256]) => ({ path, sha256 }));
    // ① 旧桥(不带新参数)在 accept:auto 线上:照旧交付即完成
    const old = await B.card("旧桥交付", "auto");
    const r0 = await B.api("POST", `/api/tasks/${old.id}/report`, A.token, { run_id: await B.claim(A, old), outcome: "done", evidence: "一。二。三。" });
    assert.equal(r0.status, 200, JSON.stringify(r0.body));
    let t = await B.get(old.id);
    assert.equal(t.status, "done");
    assert.equal(t.badge.level, "self_reported");
    assert.equal(t.fingerprint.verified, null);
    assert.match(t.fingerprint.evidence_sha256, /^[0-9a-f]{64}$/);
    // ② 带指纹 + 全 pass 的自报检查(连 by:"board" 也写上):verified=true,徽标仍是自报
    const fp = await B.card("带指纹", "auto");
    const r1 = await B.api("POST", `/api/tasks/${fp.id}/report`, A.token, { run_id: await B.claim(A, fp), outcome: "done", evidence: "做完了",
      base_commit: R.base, head_commit: R.head.toUpperCase(), files,
      checks: [{ name: "unit", status: "pass", how: "ran", by: "board" }, { name: "e2e", status: "pass", how: "ran", by: "reviewer" }],
      host_verify: { key: "unit", ok: true }, badge: { level: "machine_verified" } });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    t = await B.get(fp.id);
    assert.equal(t.fingerprint.verified, true, JSON.stringify(t.fingerprint));
    assert.equal(t.fingerprint.head_commit, R.head);
    assert.ok(t.fingerprint.tree);
    assert.equal(t.badge.level, "self_reported");
    assert.ok(t.checks.length === 2 && t.checks.every((c) => c.by === "executor"), JSON.stringify(t.checks));
    assert.equal(t.evidence_counts.verified.passed, 0);
    // ③ 对不上:声称的文件内容与提交里的不同 → 交付照收,flag fingerprint_mismatch,不自动通过
    const mm = await B.card("对不上", "auto");
    const r2 = await B.api("POST", `/api/tasks/${mm.id}/report`, A.token, { run_id: await B.claim(A, mm), outcome: "done", evidence: "做完了",
      head_commit: R.head, files: [{ path: "b.txt", sha256: sha("beta\n") }] });
    assert.equal(r2.status, 200);
    t = await B.get(mm.id);
    assert.equal(t.fingerprint.verified, false);
    assert.ok(t.badge.flags.includes("fingerprint_mismatch"));
    assert.equal(t.status, "waiting");
    // ④ required_checks:执行者自报全 pass 也不自动通过 → 留在等待中给人
    const rq = await B.card("要必需检查", "auto", { required_checks: ["unit", " unit ", "e2e"] });
    assert.deepEqual((await B.get(rq.id)).required_checks, ["unit", "e2e"]);
    const r3 = await B.api("POST", `/api/tasks/${rq.id}/report`, A.token, { run_id: await B.claim(A, rq), outcome: "done", evidence: "做完了",
      checks: [{ name: "unit", status: "pass", how: "ran" }, { name: "e2e", status: "pass", how: "ran" }] });
    assert.equal(r3.status, 200);
    t = await B.get(rq.id);
    assert.equal(t.status, "waiting");
    assert.equal(t.waiting_for, "review");
    assert.match(B.log(), new RegExp(`#${rq.id} 线 auto accept:auto 未自动完成\\(可信闸\\)`));
    // ⑤ 乱值拒收:提交号、越界路径 —— 不收这次交付,卡还在执行中
    const bad = await B.card("乱值", "auto");
    const run = await B.claim(A, bad);
    for (const extra of [{ head_commit: "--output=/tmp/x" }, { base_commit: "abc123" }, { files: [{ path: "../../etc/passwd", sha256: "1".repeat(64) }] },
                         { files: [{ path: "C:/Windows/x", sha256: "1".repeat(64) }] }, { checks: [{ name: "x", status: "green" }] }]) {
      const r = await B.api("POST", `/api/tasks/${bad.id}/report`, A.token, { run_id: run, outcome: "done", evidence: "x", ...extra });
      assert.equal(r.status, 400, JSON.stringify([extra, r.body]));
    }
    assert.equal((await B.get(bad.id)).status, "in_progress");
    // ⑥ history(操作员)给出可信字段
    const h = await B.api("GET", `/api/tasks/${fp.id}/history`, B.operator);
    assert.equal(h.status, 200);
    for (const k of ["fingerprint", "checks", "evidence_counts", "badge", "baseline", "required_checks", "conclusions"]) assert.ok(Object.hasOwn(h.body, k), k);
    assert.ok(Array.isArray(h.body.entries ?? h.body.history ?? []));
  } finally { await B.stop(); rmSync(R.dir, { recursive: true, force: true }); }
});

test("看板:写入权限 —— 执行者(绑线 / 凭码)、助手、共享 worker、审阅令牌都改不了 required_checks,写不了 board / reviewer 的检查", async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "claude", line: "hum" });
    const S = await B.connectAs({ kind: "claude", role: "assistant" });
    const t = await B.card("权限", "hum", { required_checks: ["unit"] });
    for (const [who, tk] of [["executor", X.token], ["assistant", S?.token], ["worker", B.worker], ["review", B.review]]) {
      const r = await B.api("POST", `/api/tasks/${t.id}/required-checks`, tk, { required_checks: [] });
      assert.equal(r.status, 403, who + " " + JSON.stringify(r.body));
    }
    // 建卡带 required_checks:只给操作者。worker 的派生卡也不收;助手挂卡不认识这个字段
    assert.equal((await B.api("POST", "/api/tasks", B.worker, { subject: "派生", parentId: t.id, required_checks: ["x"] })).status, 403);
    assert.equal((await B.api("POST", "/api/tasks", X.token, { subject: "x", required_checks: ["x"] })).status, 403);
    assert.equal((await B.api("POST", "/api/assistant/cards", S.token, { subject: "s", description: "d", acceptance: "a", required_checks: ["x"] })).status, 400);
    assert.deepEqual((await B.get(t.id)).required_checks, ["unit"]);
    // 执行者交付带 host_verify 不记成 board(只认受管座席的独立凭据;共享 worker 令牌同理,见 server.mjs 的 req.workerSeat 判据)
    const run = await B.claim(X, t);
    assert.equal((await B.api("POST", `/api/tasks/${t.id}/report`, X.token, { run_id: run, outcome: "done", evidence: "x", host_verify: { key: "unit", ok: true } })).status, 200);
    let c = await B.get(t.id);
    assert.equal(c.checks.length, 0);
    assert.equal(c.badge.level, "self_reported");
    // 操作员可以改(放行后也只有操作员)
    const ok = await B.api("POST", `/api/tasks/${t.id}/required-checks`, B.operator, { required_checks: ["unit", "e2e"] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.task.required_checks, ["unit", "e2e"]);
    assert.equal((await B.api("POST", `/api/tasks/${t.id}/required-checks`, B.operator, { required_checks: "unit" })).status, 400);
    // 审阅座席走它现有的身份:review 令牌 resolve 带 verify_key 记 by:"reviewer";必需检查缺 e2e → 判通过也不结案,转人工
    c = await B.get(t.id);
    const rv = await B.api("POST", `/api/tasks/${t.id}/resolve`, B.review, { verdict: "approve", resolved_by: "auto", note: "审过", runtime: "codex",
      verify_key: "unit", verify_ok: true, expected_version: c.aggregate_version });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.equal(rv.body.held_for_human, true);
    assert.match(rv.body.missing.join(), /e2e/);
    c = await B.get(t.id);
    assert.equal(c.status, "waiting");
    const vc = c.checks.find((x) => x.by === "reviewer");
    assert.ok(vc && vc.status === "pass" && vc.how === "ran" && vc.digest === c.fingerprint.digest && vc.command_hash === sha(JSON.stringify(["node", "-e", "0"])), JSON.stringify(c.checks));
    assert.equal(c.badge.level, "cross_model_reviewed");   // 写作方 claude(凭码 kind)≠ 审阅 codex
    // 人(操作员)的显式裁定不受硬闸限制(不写附言 = 就此通过);验收结论绑 digest
    const hu = await B.api("POST", `/api/tasks/${t.id}/resolve`, B.operator, { verdict: "approve", note: "", expected_version: c.aggregate_version });
    assert.equal(hu.status, 200, JSON.stringify(hu.body));
    c = await B.get(t.id);
    assert.equal(c.status, "done");
    assert.ok(c.conclusions.some((x) => x.kind === "acceptance" && x.by === "operator" && x.digest === c.fingerprint.digest && !x.stale));
  } finally { await B.stop(); }
});

test("看板:审阅满足必需检查 → 照常自动通过;再交付后旧结论 stale + changed_files;家族未知不算另一家", async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "oth" });
    const t = await B.card("满足", "oth", { required_checks: ["unit"] });
    const files1 = [{ path: "a.txt", sha256: "1".repeat(64) }, { path: "b.txt", sha256: "2".repeat(64) }];
    assert.equal((await B.api("POST", `/api/tasks/${t.id}/report`, X.token, { run_id: await B.claim(X, t), outcome: "done", evidence: "第一版", files: files1 })).status, 200);
    let c = await B.get(t.id);
    assert.equal(c.fingerprint.verified, null);          // 外部线没配工作仓 = 核不了 = 自报
    // 审阅打回(机械):验证失败也记一条已核检查
    let rv = await B.api("POST", `/api/tasks/${t.id}/resolve`, B.review, { verdict: "reject", resolved_by: "auto", note: "红", runtime: "claude",
      verify_key: "unit", verify_ok: false, expected_version: c.aggregate_version });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    c = await B.get(t.id);
    assert.equal(c.evidence_counts.verified.failed, 1);
    const d1 = c.fingerprint.digest;
    // 再交付:改了 b、加了 c
    const files2 = [{ path: "a.txt", sha256: "1".repeat(64) }, { path: "b.txt", sha256: "3".repeat(64) }, { path: "c.txt", sha256: "4".repeat(64) }];
    assert.equal((await B.api("POST", `/api/tasks/${t.id}/report`, X.token, { run_id: await B.claim(X, t), outcome: "done", evidence: "第二版", files: files2 })).status, 200);
    c = await B.get(t.id);
    assert.notEqual(c.fingerprint.digest, d1);
    assert.deepEqual(c.fingerprint.changed_files, ["b.txt", "c.txt"]);
    const old = c.conclusions.find((x) => x.kind === "review");
    assert.ok(old.stale && old.digest === d1);
    assert.deepEqual(old.changed_files, ["b.txt", "c.txt"]);
    assert.ok(c.checks.find((x) => x.by === "reviewer").stale);
    assert.ok(c.badge.flags.includes("stale"));
    // 审阅在新指纹上跑过 unit 并判通过 → 必需检查齐了,照常自动通过;写作方 other = 未知家族,不算另一家
    rv = await B.api("POST", `/api/tasks/${t.id}/resolve`, B.review, { verdict: "approve", resolved_by: "auto", note: "绿", runtime: "claude",
      verify_key: "unit", verify_ok: true, expected_version: c.aggregate_version });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.ok(!rv.body.held_for_human);
    c = await B.get(t.id);
    assert.equal(c.status, "done");
    assert.equal(c.badge.level, "machine_verified");
    assert.ok(!c.badge.flags.includes("stale"));
    // 没有 required_checks、家族未知、没有复跑:审阅通过照常结案(规则同现状),徽标照实给 self_reported
    const t2 = await B.card("无必需", "oth");
    assert.equal((await B.api("POST", `/api/tasks/${t2.id}/report`, X.token, { run_id: await B.claim(X, t2), outcome: "done", evidence: "x",
      checks: [{ name: "flaky", status: "fail", how: "ran", baseline: true }] })).status, 200);
    c = await B.get(t2.id);
    assert.deepEqual(c.evidence_counts.self, { passed: 0, failed: 0, unverified: 0, baseline_failed: 1 });
    assert.ok(c.badge.flags.includes("baseline_red"));
    rv = await B.api("POST", `/api/tasks/${t2.id}/resolve`, B.review, { verdict: "approve", resolved_by: "auto", note: "看过", runtime: "claude", expected_version: c.aggregate_version });
    assert.equal(rv.status, 200);
    c = await B.get(t2.id);
    assert.equal(c.status, "done");
    assert.equal(c.badge.level, "self_reported");
  } finally { await B.stop(); }
});

/** 真 stdio 桥子进程;call() 按 id 等应答(与 assistanttest 同形)。 */
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
const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "credtest", version: "1" } };
const toolJson = (r) => JSON.parse(r.content[0].text);

test("真 stdio 桥:report_result 可带指纹 / 自报检查并原样转给看板;不带时与旧版相同", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "hum" });
    const tf = join(B.dir, "exe_token.txt"); writeFileSync(tf, X.token);
    const M = bridge(["--url", B.base, "--token-file", tf]);
    try {
      assert.ok((await M.request("initialize", INIT)).result, M.stderr());
      M.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = (await M.request("tools/list")).result.tools;
      const rr = tools.find((x) => x.name === "report_result");
      for (const k of ["base_commit", "head_commit", "files", "checks"]) assert.ok(rr.inputSchema.properties[k], k);
      assert.deepEqual(rr.inputSchema.required, ["id", "outcome", "evidence"]);
      // 带新参数
      const t1 = await B.card("桥一", "hum");
      const c1 = await M.call("claim_card", { id: t1.id, expected_version: (await B.get(t1.id)).aggregate_version });
      assert.ok(!c1.isError, JSON.stringify(c1));
      const r1 = await M.call("report_result", { id: t1.id, outcome: "done", evidence: "做完", head_commit: "a".repeat(40),
        files: [{ path: "src/x.mjs", sha256: "1".repeat(64) }], checks: [{ name: "unit", status: "pass", how: "ran" }] });
      assert.ok(!r1.isError, JSON.stringify(r1));
      let c = await B.get(t1.id);
      assert.deepEqual(c.fingerprint.files, [{ path: "src/x.mjs", sha256: "1".repeat(64) }]);
      assert.equal(c.fingerprint.head_commit, "a".repeat(40));
      assert.equal(c.checks[0].by, "executor");
      assert.equal(c.badge.level, "self_reported");
      // 桥这一侧先挡:数组形不对、提交号格式不对
      const t2 = await B.card("桥二", "hum");
      await M.call("claim_card", { id: t2.id, expected_version: (await B.get(t2.id)).aggregate_version });
      assert.ok((await M.call("report_result", { id: t2.id, outcome: "done", evidence: "x", files: "a.txt" })).isError);
      assert.ok((await M.call("report_result", { id: t2.id, outcome: "done", evidence: "x", head_commit: "HEAD" })).isError);
      // 每项的形状由看板核:混进 by 的检查在看板侧照样只记自报
      const r2 = await M.call("report_result", { id: t2.id, outcome: "done", evidence: "x", checks: [{ name: "u", status: "pass", by: "board" }] });
      assert.ok(!r2.isError, JSON.stringify(r2));
      c = await B.get(t2.id);
      assert.deepEqual(c.checks.map((x) => [x.name, x.by]), [["u", "executor"]]);
      // 不带新参数:与旧版相同(交付进待验收,fingerprint 只有正文哈希)
      const t3 = await B.card("桥三", "hum");
      await M.call("claim_card", { id: t3.id, expected_version: (await B.get(t3.id)).aggregate_version });
      const r3 = await M.call("report_result", { id: t3.id, outcome: "done", evidence: "旧用法" });
      assert.ok(!r3.isError, JSON.stringify(r3));
      assert.equal(toolJson(r3).status, "waiting");
      c = await B.get(t3.id);
      assert.deepEqual([c.fingerprint.head_commit, c.fingerprint.files, c.checks], [null, [], []]);
    } finally { await M.end(); }
  } finally { await B.stop(); }
});
