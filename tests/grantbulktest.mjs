import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 合同 J6 / J7(第 9 波 9e):批准额度(quota / grant / use / revoke)、豁免、敏感标签、批量验收,以及 9c / 8f 留下的四条后续。
// 真看板子进程 + 真 stdio 桥;另有纯函数与 store 的进程内用例。不调用任何模型(协调线接 tests/helpers/fake-coordinator-cli.mjs)。
//   `node --test tests/grantbulktest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { normQuota, finalGrant, normUse, normSensitive, openApprovalQuota, bulkCheck, bulkListDigest, SENSITIVE } from "../core/approval-quota.mjs";
import { briefApprovals } from "../core/brief.mjs";
import { createExecBridge } from "../core/mcp/exec-bridge.mjs";
import { freePort } from "./helpers/free-port.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FAKE = join(ROOT, "tests", "helpers", "fake-coordinator-cli.mjs");
const sha = (x) => createHash("sha256").update(x).digest("hex");
const ERR = { NOT_FOUND: "NOT_FOUND", CONFLICT: "CONFLICT", BAD_INPUT: "BAD_INPUT" };
const err = (code, message) => Object.assign(new Error(message), { code });
const bad = (m) => err("BAD_INPUT", m);
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code, code);

async function board({ lines = null, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "grantbulktest-")), config = join(dir, "fleet.json"), empty = join(dir, "empty"), repo = join(dir, "repo");
  mkdirSync(empty); mkdirSync(repo);
  writeFileSync(config, JSON.stringify({ lines: lines ?? [
    { id: "alpha", label: "甲", external: true }, { id: "beta", label: "乙", external: true },
    { id: "auto", label: "自动", external: true, accept: "auto" }, { id: "rv", label: "审", external: true, role: { kind: "review" } },
    { id: "plan", label: "计划线" },
  ], roles: [], routes: ["default"], repo }));
  const port = await freePort(), log = join(dir, "coordinator-calls.jsonl");
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: repo, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit",
           BOARD_DELIVERABLE_GATE: "off", BOARD_REAP_MS: "600000", BOARD_CLAUDE_PROJECTS: empty, BOARD_CODEX_HOME: empty,
           BOARD_COORDINATOR_CLI_ARGV: JSON.stringify([process.execPath, FAKE]), CONVTEST_LOG: log, ...env } });
  let out = ""; child.stdout.on("data", (d) => { out = (out + d).slice(-20000); }); child.stderr.on("data", (d) => { out = (out + d).slice(-20000); });
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
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
    const tokenFile = join(dir, `${r.body.executor_id}.token`); writeFileSync(tokenFile, r.body.token + "\n");
    return { id: r.body.executor_id, line: r.body.line, token: r.body.token, tokenFile };
  };
  const get = async (id, tk = operator) => (await api("GET", `/api/tasks/${id}`, tk)).body?.task;
  const claim = async (X, id) => {
    const cl = await api("POST", `/api/tasks/${id}/claim`, X.token, { expected_version: (await get(id)).aggregate_version });
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    return cl.body.task.run_id;
  };
  const deliver = async (X, id, extra = {}) => {
    const run = await claim(X, id);
    const r = await api("POST", `/api/tasks/${id}/report`, X.token, { run_id: run, outcome: "done", evidence: "做完了", ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return run;
  };
  const rw = () => { const d = new DatabaseSync(join(dir, "board.db")); d.exec("PRAGMA busy_timeout=5000"); return d; };
  const dbAll = (sql, ...a) => { const d = rw(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  /** 测试夹具:在当前指纹上补一条看板跑过的通过检查(= 受管宿主 host_verify 记下的 by:"board" 检查;测试里起不了受管座席)。 */
  const boardCheck = (id, name = "unit", env = null) => {
    const d = rw();
    try {
      const cur = d.prepare("SELECT digest, base_commit FROM cred_deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1").get(Number(id));
      d.prepare("INSERT INTO cred_checks(task_id, name, status, by_, how, digest, command_hash, env, baseline, base_commit, at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(Number(id), name, "pass", "board", "ran", cur.digest, null, env, 0, cur.base_commit ?? null, new Date().toISOString());
    } finally { d.close(); }
  };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, worker, review, card, connectAs, get, claim, deliver, dbAll, rw, boardCheck, stop, log: () => out };
}

function bridge(args) {
  const child = spawn(process.execPath, [join(ROOT, "cli", "exec-mcp.mjs"), ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: HOST_ENV });
  let buf = ""; const waiting = new Map(), got = new Map();
  child.stdout.setEncoding("utf8"); child.stderr.resume();
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else got.set(m.id, m);
    }
  });
  let next = 1;
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const request = (method, params) => { const id = next++; send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return got.has(id) ? Promise.resolve(got.get(id)) : new Promise((r) => waiting.set(id, r)); };
  const call = async (name, a) => (await request("tools/call", { name, arguments: a })).result;
  const end = async () => { child.stdin.end(); await new Promise((r) => child.once("close", r)); };
  return { request, send, call, end };
}
const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } };

// ── 纯函数 ────────────────────────────────────────────────────────────────────────
test("J6 纯函数:quota 的范围(有限、非负、上限)、grant 只能改小、一次性不能凭空给、use 正文;J7 敏感标签值域;简报计数", () => {
  assert.equal(normQuota(undefined, bad), null);
  assert.deepEqual(normQuota({ uses: 3 }, bad), { uses: 3, usd: null, ttl_minutes: null });
  assert.deepEqual(normQuota({ uses: 100, usd: 1.5, ttl_minutes: 10080 }, bad), { uses: 100, usd: 1.5, ttl_minutes: 10080 });
  for (const q of [{}, { uses: 0 }, { uses: 101 }, { uses: 1.5 }, { usd: 0 }, { usd: -1 }, { usd: Infinity }, { usd: NaN }, { usd: 10001 }, { usd: "1" },
                   { ttl_minutes: 0 }, { ttl_minutes: 10081 }, { ttl_minutes: 2.5 }, { extra: 1 }, [], "x"])
    throwsCode(() => normQuota(q, bad), "BAD_INPUT");
  const P = { uses: 3, usd: 5, ttl_minutes: 60 };
  assert.deepEqual(finalGrant(undefined, P, bad), P, "不带 grant = 照请求批");
  assert.deepEqual(finalGrant({ uses: 2 }, P, bad), { uses: 2, usd: 5, ttl_minutes: 60 });
  assert.deepEqual(finalGrant({ usd: 1 }, { uses: 3, usd: null, ttl_minutes: null }, bad), { uses: 3, usd: 1, ttl_minutes: null }, "请求没写的项可以加上(更严)");
  for (const g of [{ uses: 4 }, { usd: 5.01 }, { ttl_minutes: 61 }]) throwsCode(() => finalGrant(g, P, bad), "BAD_INPUT");
  throwsCode(() => finalGrant({ uses: 1 }, null, bad), "BAD_INPUT");
  assert.equal(finalGrant(undefined, null, bad), null, "一次性请求批准 = 没有额度");
  assert.deepEqual(normUse({ run_id: "r-1:x" }, bad), { run_id: "r-1:x", usd: null });
  for (const u of [{}, { run_id: "" }, { run_id: "有中文" }, { run_id: "x".repeat(81) }, { run_id: "r", usd: -0.1 }, { run_id: "r", usd: 10001 }, { run_id: "r", x: 1 }])
    throwsCode(() => normUse(u, bad), "BAD_INPUT");
  assert.deepEqual(normSensitive(["spend", "security", "spend"], bad), ["security", "spend"], "去重、固定顺序");
  assert.deepEqual(normSensitive([], bad), []);
  for (const v of [["nope"], "security", [1], null]) throwsCode(() => normSensitive(v, bad), "BAD_INPUT");
  assert.deepEqual(SENSITIVE, ["security", "waiver", "spend", "prod_write", "secret", "destructive", "other"]);
  assert.deepEqual(briefApprovals({ grants: 2, waivers: 0, bulk: 3 }), { grants_active: 2, waivers: 0, bulk_ready: 3, line: "进行中的批准额度 2 条 · 豁免 0 条 · 可批量验收 3 件" });
  assert.deepEqual(briefApprovals({ grants: 1, waivers: null, bulk: undefined }), { grants_active: 1, waivers: null, line: "进行中的批准额度 1 条 · 豁免 ? 条" }, "quiet 不出可批量;读不到写 ?");
});

test("J6 只追加表与到期:六张表触发器拒改拒删拒 REPLACE;ttl 到点 expired、用完 exhausted、撤销 revoked 后 use 都 409", () => {
  const db = new DatabaseSync(":memory:");
  let clock = Date.parse("2026-11-14T00:00:00Z");
  const aq = openApprovalQuota({ db, err, ERR, now: () => clock });
  aq.migrate();
  aq.propose(1, { uses: 2, usd: null, ttl_minutes: 1 }, "x1");
  assert.equal(aq.grantView(1).state, null, "还没批");
  throwsCode(() => aq.use(1, "x1", { run_id: "r", usd: null }), "CONFLICT");
  aq.recordGrant(1, { uses: 2, usd: null, ttl_minutes: 1 }, { by: "operator", via: "local" });
  assert.equal(aq.grantView(1).state, "active");
  assert.deepEqual(aq.use(1, "x1", { run_id: "r", usd: null }).remaining, { uses: 1, usd: null, expires_at: "2026-11-14T00:01:00.000Z" });
  clock += 61000;
  assert.equal(aq.grantView(1).state, "expired");
  assert.throws(() => aq.use(1, "x1", { run_id: "r", usd: null }), (e) => e.code === "CONFLICT" && e.grantCode === "EXPIRED");
  aq.propose(2, { uses: 1, usd: null, ttl_minutes: null }, "x1"); aq.recordGrant(2, { uses: 1, usd: null, ttl_minutes: null });
  assert.equal(aq.use(2, "x1", { run_id: "r", usd: null }).state, "exhausted");
  assert.throws(() => aq.use(2, "x1", { run_id: "r", usd: null }), (e) => e.grantCode === "EXHAUSTED");
  aq.propose(3, { uses: null, usd: 1, ttl_minutes: null }, "x1"); aq.recordGrant(3, { uses: null, usd: 1, ttl_minutes: null });
  throwsCode(() => aq.use(3, "x1", { run_id: "r", usd: null }), "BAD_INPUT");
  assert.equal(aq.use(3, "x1", { run_id: "r", usd: 0.4 }).state, "active");
  assert.equal(aq.use(3, "x1", { run_id: "r", usd: 0.6 }).state, "exhausted", "金额到上限 = 用完");
  aq.propose(4, { uses: 5, usd: null, ttl_minutes: null }, "x1"); aq.recordGrant(4, { uses: 5, usd: null, ttl_minutes: null });
  assert.equal(aq.revoke(4, { note: "不用了" }).state, "revoked");
  assert.throws(() => aq.use(4, "x1", { run_id: "r", usd: null }), (e) => e.grantCode === "REVOKED");
  assert.throws(() => aq.revoke(4), (e) => e.code === "CONFLICT");
  assert.equal(aq.countActiveGrants(), 0);
  const w = aq.addWaiver(aq.normWaiver({ rule: "r1", value: "原值", scope: { card: 7 } }));
  aq.setSensitive(7, ["spend"]); aq.recordBulk("bk_x", "operator", [], {});
  for (const [t, where] of [["approval_grants", "id=1"], ["grant_uses", "id=1"], ["waivers", `id=${w.id}`], ["card_sensitive", "id=1"], ["bulk_runs", "id='bk_x'"]]) {
    assert.throws(() => db.exec(`UPDATE ${t} SET at='x' WHERE ${where}`), /append-only/, t + " 拒改");
    assert.throws(() => db.exec(`DELETE FROM ${t} WHERE ${where}`), /append-only/, t + " 拒删");
  }
  aq.revokeWaiver(w.id);
  assert.throws(() => db.exec(`DELETE FROM waiver_revocations`), /append-only/);
  assert.throws(() => db.exec(`INSERT OR REPLACE INTO waiver_revocations(waiver_id, by_, via, note, at) VALUES(${w.id},'x','x','','x')`), /append-only/, "REPLACE 不能顶掉撤销记录");
  assert.throws(() => db.exec(`INSERT OR REPLACE INTO bulk_runs(id, at, by_, items_json, result_json) VALUES('bk_x','x','x','[]','{}')`), /append-only/);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM waivers").all()).includes("原值"), false, "豁免只存哈希");
  assert.equal(db.prepare("SELECT value_hash FROM waivers").get().value_hash, sha("原值"));
});

test("J7 批量资格(纯函数):任何一项读不到 / 判不出 = 不进;每一项各一个反例", () => {
  const T = { id: 5, status: "waiting", waiting_for: "review", line: "alpha", human_gate: 0 };
  const O = { badge: { level: "machine_verified", flags: [], provenance: [{ what: "fingerprint", by: "executor" }, { what: "check:unit", by: "board" }] },
              package_gaps: [], sensitive: [], waivers: [], conclusions: [], fingerprint: { digest: "d" } };
  const ctx = (over = {}) => ({ lines: () => ["alpha"], entry: () => ({ item: { id: "delivery:5:3", kind: "delivery", expected_version: 3 } }), decided: () => null,
    out: () => O, gate: () => ({ ok: true, missing: [] }), reviewLines: ["rv"], deliverer: () => "exe-1", ...over });
  const ok = bulkCheck(T, ctx());
  assert.equal(ok.ok, true, JSON.stringify(ok.excluded));
  assert.deepEqual(ok.item, { approval_id: "delivery:5:3", expected_version: 3 });
  const no = (t, c, re) => { const v = bulkCheck(t, c); assert.equal(v.ok, false); assert.ok(v.excluded.some((x) => re.test(x)), `${re}:${JSON.stringify(v.excluded)}`); };
  no({ ...T, waiting_for: "decision" }, ctx(), /不是待本人验收/);
  no({ ...T, status: "in_progress" }, ctx(), /不是待本人验收/);
  no({ ...T, human_gate: 1 }, ctx(), /人工闸/);
  no(T, ctx({ entry: () => null }), /没有这张卡的验收项/);
  no(T, ctx({ decided: () => ({}) }), /已经决定过/);
  no(T, ctx({ lines: () => [] }), /没开批量/);
  no(T, ctx({ lines: () => null }), /判不出:线/);
  no(T, ctx({ out: () => { throw new Error("x"); } }), /判不出:任务对象/);
  no(T, ctx({ gate: () => ({ ok: false, missing: ["必需检查「lint」…"] }) }), /闸没全过/);
  no(T, ctx({ gate: () => { throw new Error("x"); } }), /判不出:自动通过闸/);
  no(T, ctx({ gate: () => ({ ok: true }) }), /判不出:自动通过闸/);
  no(T, ctx({ out: () => ({ ...O, badge: null }) }), /读不到可信度徽标/);
  no(T, ctx({ out: () => ({ ...O, badge: { ...O.badge, level: "self_reported" } }) }), /只凭自报/);
  no(T, ctx({ out: () => ({ ...O, badge: { ...O.badge, level: "future_level" } }) }), /判不出:徽标档位/);
  for (const f of ["stale", "fingerprint_mismatch", "based_on_stale_spec", "based_on_stale_ref", "spec_deviation", "not_target_env"])
    no(T, ctx({ out: () => ({ ...O, badge: { ...O.badge, flags: [f] } }) }), new RegExp(f));
  no(T, ctx({ out: () => ({ ...O, based_on_stale_spec: true }) }), /based_on_stale_spec/);
  no(T, ctx({ out: () => ({ ...O, package_gaps: ["包「x」还没跑"] }) }), /package_gaps/);
  no(T, ctx({ out: () => ({ ...O, package_gaps: undefined }) }), /判不出:标记/);
  no(T, ctx({ out: () => ({ ...O, sensitive: ["prod_write"] }) }), /敏感标签/);
  no(T, ctx({ out: () => ({ ...O, sensitive: undefined }) }), /判不出:敏感标签/);
  no(T, ctx({ out: () => ({ ...O, waivers: [{ id: 1 }] }) }), /带豁免/);
  no(T, ctx({ out: () => ({ ...O, waivers: undefined }) }), /判不出:豁免/);
  // 自批排除:交付者判不出 / 审阅线自己交付 / 依据出自交付者 / 结论出自交付者
  no(T, ctx({ deliverer: () => null }), /判不出交付者/);
  no({ ...T, line: "rv" }, ctx({ lines: () => ["rv"] }), /自批:交付出自审阅线/);
  no(T, ctx({ out: () => ({ ...O, badge: { ...O.badge, provenance: [O.badge.provenance[0], { what: "check:u", by: "executor" }] } }) }), /自批:徽标的依据/);
  no(T, ctx({ out: () => ({ ...O, conclusions: [{ kind: "review", by: "exe-1", stale: false }] }) }), /自批:结论出自交付者/);
  assert.equal(bulkListDigest([{ approval_id: "a", expected_version: 1, digest: "x" }, { approval_id: "b", expected_version: 2, digest: "y" }]),
               bulkListDigest([{ approval_id: "b", expected_version: "2", digest: "y" }, { approval_id: "a", expected_version: 1, digest: "x" }]), "与顺序无关");
});

test("8f 后续:父卡 rearm 的 CHILDREN_UNFINISHED 不计登记跳过的子卡(与目标结案同一规则);抛错照常计;放行后照常计", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grantbulk-store-"));
  const keep = { d: process.env.BOARD_DATA_DIR, b: process.env.BOARD_DB };
  process.env.BOARD_DATA_DIR = dir; process.env.BOARD_DB = join(dir, "t.db");
  try {
    const store = createRequire(import.meta.url)("../core/store.js");
    const db = store.open();
    const run = (id) => store.get(db, id).run_id;
    const mk = () => { const id = store.add(db, { subject: "父", line: "engine" }); store.claimById(db, { id, worker: "engine" });
      store.report(db, { id, worker: "engine", runId: run(id), outcome: "done", evidence: "e" }); store.markAutoReviewed(db, { id, note: "转人" }); return id; };
    const finish = (id) => { store.claimById(db, { id, worker: "engine" }); store.report(db, { id, worker: "engine", runId: run(id), outcome: "done", evidence: "子" });
      store.resolve(db, { id, verdict: "approve", note: "", resolvedBy: "auto" }); };
    const P = mk();
    const k1 = store.add(db, { subject: "子 1", line: "engine", parentId: P });
    const auto = store.add(db, { subject: "复审卡(未放行)", line: "engine", parentId: P, released: 0 });
    finish(k1);
    const codes = () => store.stuckWhy(db, store.get(db, P)).map((b) => b.code);
    // 没登记跳过:未放行的那张照常计 → 不送回重审
    assert.equal(store.get(db, P).waiting_for, "confirm");
    assert.deepEqual(store.rearmDone(db), []);
    let skipThrows = false;
    const off = store.registerGoalSkip("grantbulktest", (r) => { if (skipThrows) throw new Error("判不出"); return Number(r.id) === auto && !Number(r.released) && r.status === "not_started"; });
    try {
      // 判定抛错 = 照常计
      skipThrows = true;
      assert.deepEqual(store.rearmDone(db), [], "判定函数抛错 = 照常计");
      skipThrows = false;
      // 先看 stuckWhy:放回重审之前把父卡挪到 rearm 的状态下看 CHILDREN_UNFINISHED
      assert.deepEqual(store.rearmDone(db), [P], "未放行的自动出卡不拖住父卡送回重审");
      assert.equal(store.get(db, P).waiting_for, "review");
      // 放行后照常计:父卡再次审过转人 → 有放行了的未完成子卡 → 不送回;stuckWhy 列出 CHILDREN_UNFINISHED
      store.markAutoReviewed(db, { id: P, note: "再转人" });
      db.prepare("UPDATE tasks SET released=1 WHERE id=?").run(auto);
      db.prepare("UPDATE tasks SET waiting_for='rearm' WHERE id=?").run(P);
      assert.ok(codes().includes("CHILDREN_UNFINISHED"), "放行后照常计:" + codes());
      assert.deepEqual(store.rearmDone(db), []);
      db.prepare("UPDATE tasks SET released=0 WHERE id=?").run(auto);
      assert.ok(!codes().includes("CHILDREN_UNFINISHED"), "未放行的不计:" + codes());
    } finally { off(); }
    assert.ok(codes().includes("CHILDREN_UNFINISHED"), "登记撤掉 = 照常计");
    db.close();
  } finally {
    if (keep.d === undefined) delete process.env.BOARD_DATA_DIR; else process.env.BOARD_DATA_DIR = keep.d;
    if (keep.b === undefined) delete process.env.BOARD_DB; else process.env.BOARD_DB = keep.b;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ── 真看板 ────────────────────────────────────────────────────────────────────────
test("J6 批准额度:请求带 quota、grant 只能改小、一次性不能凭空给、只有当事执行者能报 use、用完 / 撤销后 409、remaining;五种令牌", { timeout: 180000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha", label: "甲方" }), Y = await B.connectAs({ kind: "claude", line: "alpha" });
    const U = await B.connectAs({ kind: "claude" });   // 不绑线的执行者
    const S = await B.connectAs({ kind: "claude", role: "assistant" });
    const before = (await B.api("GET", "/api/approvals", B.operator)).body.count;
    for (const q of [{ uses: 0 }, { uses: 101 }, { usd: -1 }, { ttl_minutes: 10081 }, { extra: 1 }, {}, "x"])
      assert.equal((await B.api("POST", "/api/approvals/request", X.token, { action: "重启共享设备上的应用", risk: "low", quota: q })).status, 400, JSON.stringify(q));
    assert.equal((await B.api("GET", "/api/approvals", B.operator)).body.count, before, "quota 不合规 = 请求不建");
    // 一次性(不带 quota):事项形状同旧版;决定时 grant 400;批准后 use 409
    const one = (await B.api("POST", "/api/approvals/request", X.token, { action: "一次性的事", risk: "low" })).body.request;
    assert.equal("quota" in one, false);
    let item = (await B.api("GET", "/api/approvals", B.operator)).body.approvals.find((a) => a.id === one.approval_id);
    assert.equal("quota" in item, false, "没带 quota 的事项不多键");
    const dec = (id, extra = {}) => B.api("POST", `/api/approvals/${id}/decide`, B.operator, { decision: "approve", source: { client: "fixture" }, expected_version: 1, ...extra });
    assert.equal((await dec(one.approval_id, { grant: { uses: 1 } })).status, 400, "一次性不能凭空给额度");
    assert.equal((await dec(one.approval_id)).status, 200);
    const u0 = await B.api("POST", `/api/approvals/${one.approval_id}/use`, X.token, { run_id: "r1" });
    assert.deepEqual([u0.status, u0.body.code], [409, "NOT_GRANTED"]);
    assert.equal("grant" in (await B.api("GET", `/api/approvals/${one.approval_id}`, X.token)).body, false);
    // 带额度
    const rq = await B.api("POST", "/api/approvals/request", X.token, { action: "跑一次付费接口", risk: "medium", quota: { uses: 3, usd: 5, ttl_minutes: 60 } });
    assert.equal(rq.status, 201, JSON.stringify(rq.body));
    const A = rq.body.request.approval_id;
    assert.deepEqual(rq.body.request.quota, { uses: 3, usd: 5, ttl_minutes: 60 });
    item = (await B.api("GET", "/api/approvals", B.operator)).body.approvals.find((a) => a.id === A);
    assert.deepEqual(item.quota, { uses: 3, usd: 5, ttl_minutes: 60 });
    for (const g of [{ uses: 4 }, { usd: 6 }, { ttl_minutes: 61 }, { uses: 0 }])
      assert.equal((await dec(A, { grant: g })).status, 400, "grant 不能改大:" + JSON.stringify(g));
    assert.equal((await B.api("POST", `/api/approvals/${A}/decide`, B.operator, { decision: "reject", source: { client: "fixture" }, expected_version: 1, grant: { uses: 1 } })).status, 400, "拒绝时不带 grant");
    assert.equal((await B.api("GET", `/api/approvals/${A}`, B.operator)).body.decision, null, "被拒的决定都没留下");
    const ok = await dec(A, { grant: { uses: 2, usd: 1 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual({ ...ok.body.decision.result.quota, expires_at: typeof ok.body.decision.result.quota.expires_at }, { uses: 2, usd: 1, ttl_minutes: 60, expires_at: "string" }, "最终额度写进决定记录");
    let g = (await B.api("GET", `/api/approvals/${A}`, X.token)).body.grant;
    assert.equal(g.state, "active");
    assert.deepEqual([g.remaining.uses, g.remaining.usd], [2, 1]);
    assert.equal(g.remaining.expires_at, ok.body.decision.result.quota.expires_at);
    // 写权限:只有当事执行者
    for (const [who, tk] of [["别的执行者", Y.token], ["不绑线的执行者", U.token], ["操作者", B.operator], ["worker", B.worker], ["审阅", B.review], ["助手", S.token]]) {
      const r = await B.api("POST", `/api/approvals/${A}/use`, tk, { run_id: "r1", usd: 0.1 });
      assert.equal(r.status, 403, who);
    }
    assert.equal((await B.api("POST", `/api/approvals/${A}/use`, Y.token, { run_id: "r1", usd: 0.1 })).body.code, "NOT_PARTY");
    assert.equal((await B.api("POST", `/api/approvals/${A}/use`, X.token, { run_id: "r1" })).status, 400, "带金额上限的额度每次要报 usd");
    assert.equal((await B.api("POST", `/api/approvals/${A}/use`, X.token, { run_id: "坏 id", usd: 0 })).status, 400);
    assert.equal((await B.api("POST", "/api/approvals/request:999999:1/use", X.token, { run_id: "r1", usd: 0 })).status, 404);
    let u = await B.api("POST", `/api/approvals/${encodeURIComponent(A)}/use`, X.token, { run_id: "r1", usd: 0.4 });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.deepEqual([u.body.grant.state, u.body.grant.remaining.uses, u.body.grant.remaining.usd], ["active", 1, 0.6]);
    assert.match(u.body.note, /看板只计数/);
    u = await B.api("POST", `/api/approvals/${A}/use`, X.token, { run_id: "r2", usd: 0.7 });
    assert.deepEqual([u.status, u.body.grant.state, u.body.grant.remaining.usd], [200, "exhausted", 0], "超出金额照记(事已发生),状态到用完");
    u = await B.api("POST", `/api/approvals/${A}/use`, X.token, { run_id: "r3", usd: 0 });
    assert.deepEqual([u.status, u.body.code, u.body.grant.state], [409, "EXHAUSTED", "exhausted"]);
    // 撤销:只有操作者;撤销后 use 409
    const R = (await B.api("POST", "/api/approvals/request", X.token, { action: "改共享配置", risk: "high", quota: { uses: 5 } })).body.request.approval_id;
    assert.equal((await dec(R)).status, 200);
    for (const tk of [X.token, Y.token, B.worker, B.review, S.token]) assert.equal((await B.api("POST", `/api/approvals/${R}/revoke`, tk, {})).status, 403);
    const rv = await B.api("POST", `/api/approvals/${R}/revoke`, B.operator, { note: "不用了" });
    assert.deepEqual([rv.status, rv.body.grant.state], [200, "revoked"]);
    assert.equal((await B.api("POST", `/api/approvals/${R}/revoke`, B.operator, {})).status, 409);
    u = await B.api("POST", `/api/approvals/${R}/use`, X.token, { run_id: "r1" });
    assert.deepEqual([u.status, u.body.code], [409, "REVOKED"]);
    // 列表只给操作者
    const gl = await B.api("GET", "/api/approvals/grants", B.operator);
    assert.equal(gl.status, 200);
    assert.deepEqual(gl.body.grants.map((x) => [x.approval_id, x.state]), [[R, "revoked"], [A, "exhausted"]]);
    assert.equal(gl.body.grants[0].executor_label, "甲方");
    for (const tk of [X.token, U.token, B.worker, B.review, S.token]) assert.notEqual((await B.api("GET", "/api/approvals/grants", tk)).status, 200);
    // 绑线执行者只能查自己的请求
    assert.equal((await B.api("GET", `/api/approvals/${A}`, Y.token)).status, 404);
    // 只追加:真库上改 / 删都被拒
    const d = B.rw();
    try {
      assert.throws(() => d.exec("UPDATE approval_grants SET uses=99"), /append-only/);
      assert.throws(() => d.exec("DELETE FROM grant_uses"), /append-only/);
    } finally { d.close(); }
    // 简报只给计数(进行中的额度 = 0:一份用完、一份撤销)
    const br = (await B.api("GET", "/api/brief", S.token)).body;
    assert.deepEqual([br.approvals.grants_active, br.approvals.waivers, br.approvals.bulk_ready], [0, 0, 0]);
    assert.equal(JSON.stringify(br).includes("付费接口"), false, "简报不给额度内容");
    const R2 = (await B.api("POST", "/api/approvals/request", X.token, { action: "另一件", risk: "low", quota: { uses: 2 } })).body.request.approval_id;
    await dec(R2);
    assert.equal((await B.api("GET", "/api/brief", S.token)).body.approvals.grants_active, 1);
    assert.equal("bulk_ready" in (await B.api("GET", "/api/brief?mode=quiet", S.token)).body.approvals, false, "quiet 不出可批量验收");
    assert.match(B.log(), /批准接口:批准/);
  } finally { await B.stop(); }
});

test("J6 豁免 + J7 敏感标签:只有操作者写;只存哈希;豁免不让闸变绿(accept:auto 与审阅通过都转人工、缺口写已豁免);敏感标签值域与自动含 waiver;计划 needs_confirm → other", { timeout: 180000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "auto" }), Z = await B.connectAs({ kind: "codex", line: "alpha" });
    const S = await B.connectAs({ kind: "claude", role: "assistant" });
    const T = await B.card("要豁免的卡", "auto"), C = await B.card("对照卡", "auto");
    // 写权限
    const W = { rule: "fixture-rule", value: "fixture-secret-value", scope: { card: T.id }, note: "见 C:\\Users\\user\\notes.txt" };
    for (const [who, tk] of [["执行者", X.token], ["助手", S.token], ["worker", B.worker], ["审阅", B.review]]) {
      assert.equal((await B.api("POST", "/api/waivers", tk, W)).status, 403, who);
      assert.notEqual((await B.api("GET", "/api/waivers", tk)).status, 200, who + " 读");
    }
    for (const b of [{ ...W, rule: "x".repeat(65) }, { ...W, value_hash: "a".repeat(64) }, { ...W, scope: { card: T.id, line: "auto" } }, { ...W, scope: {} },
                     { ...W, note: "长".repeat(201) }, { ...W, expires_at: "2020-01-01T00:00:00Z" }, { ...W, scope: { line: "ghost" } }, { ...W, extra: 1 }])
      assert.equal((await B.api("POST", "/api/waivers", B.operator, b)).status, 400, JSON.stringify(b).slice(0, 80));
    assert.equal((await B.api("POST", "/api/waivers", B.operator, { ...W, scope: { card: 999999 } })).status, 404);
    const add = await B.api("POST", "/api/waivers", B.operator, W);
    assert.equal(add.status, 201, JSON.stringify(add.body));
    const w = add.body.waiver;
    assert.equal(w.value_hash, sha("fixture-secret-value"));
    assert.ok(!w.note.includes("Users"), "note 过脱敏:" + w.note);
    assert.equal(JSON.stringify(B.dbAll("SELECT * FROM waivers")).includes("fixture-secret-value"), false, "库里不存原值");
    let t = await B.get(T.id);
    assert.deepEqual(t.waivers, [{ id: w.id, rule: "fixture-rule", at: w.at, expires_at: null }]);
    assert.deepEqual(t.sensitive, ["waiver"], "有未撤销豁免 → 自动含 waiver");
    assert.deepEqual((await B.get(C.id)).waivers, []);
    assert.equal("waivers" in (await B.get(T.id, S.token)), false, "助手看不到豁免");
    // 豁免不让闸变绿:accept:auto 的线,带豁免的卡交付后不自动完成;对照卡照常完成
    await B.deliver(X, T.id); await B.deliver(X, C.id);
    assert.equal((await B.get(C.id)).status, "done", "对照:无豁免照常自动完成 " + B.log().slice(-400));
    t = await B.get(T.id);
    assert.deepEqual([t.status, t.waiting_for], ["waiting", "review"], "带豁免不自动通过");
    assert.match(B.log(), /已豁免:规则 fixture-rule\(操作者、\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/);
    // 审阅判通过也一样:转人工,缺口里写已豁免
    const rr = await B.api("POST", `/api/tasks/${T.id}/resolve`, B.review, { verdict: "approve", resolved_by: "auto", note: "审过", runtime: "claude", expected_version: t.aggregate_version });
    assert.equal(rr.status, 200, JSON.stringify(rr.body));
    assert.equal(rr.body.held_for_human, true);
    assert.ok(rr.body.missing.some((m) => /^已豁免:规则 fixture-rule\(操作者、/.test(m)), JSON.stringify(rr.body.missing));
    // 本人显式通过照常(豁免不拦人)
    const tt = await B.get(T.id);
    assert.equal(tt.status, "waiting");
    // 撤销:只有操作者;撤销后卡上不再有豁免与 waiver 标签
    for (const tk of [X.token, S.token, B.worker, B.review]) assert.equal((await B.api("POST", `/api/waivers/${w.id}/revoke`, tk, {})).status, 403);
    const rvk = await B.api("POST", `/api/waivers/${w.id}/revoke`, B.operator, { note: "用完了" });
    assert.equal(rvk.status, 200); assert.ok(rvk.body.waiver.revoked_at);
    assert.equal((await B.api("POST", `/api/waivers/${w.id}/revoke`, B.operator, {})).status, 409);
    t = await B.get(T.id);
    assert.deepEqual([t.waivers, t.sensitive], [[], []]);
    // 按线的豁免盖住线上所有卡
    const L = (await B.api("POST", "/api/waivers", B.operator, { rule: "line-rule", scope: { line: "alpha" } })).body.waiver;
    const A1 = await B.card("甲线卡", "alpha");
    assert.deepEqual((await B.get(A1.id)).waivers.map((x) => x.id), [L.id]);
    assert.deepEqual((await B.api("GET", `/api/waivers?card=${A1.id}`, B.operator)).body.waivers.map((x) => x.id), [L.id]);
    assert.equal((await B.api("GET", "/api/waivers?active=1", B.operator)).body.waivers.length, 1);
    assert.equal((await B.api("GET", "/api/brief", S.token)).body.approvals.waivers, 1, "助手只拿计数");
    assert.equal(JSON.stringify((await B.api("GET", "/api/brief", S.token)).body).includes("line-rule"), false, "简报不给规则名");
    // 敏感标签:只有操作者;未知值 400;固定顺序;空数组清掉
    const K = await B.card("敏感卡", "alpha");
    for (const [who, tk] of [["执行者", Z.token], ["助手", S.token], ["worker", B.worker], ["审阅", B.review]])
      assert.equal((await B.api("POST", `/api/tasks/${K.id}/sensitive`, tk, { sensitive: ["spend"] })).status, 403, who);
    assert.equal((await B.api("POST", `/api/tasks/${K.id}/sensitive`, B.operator, { sensitive: ["nope"] })).status, 400);
    assert.equal((await B.api("POST", `/api/tasks/${K.id}/sensitive`, B.operator, { tags: ["spend"] })).status, 400);
    const sv = await B.api("POST", `/api/tasks/${K.id}/sensitive`, B.operator, { sensitive: ["spend", "security"] });
    assert.deepEqual([sv.status, sv.body.task.sensitive], [200, ["security", "waiver", "spend"]], "线豁免 → 自动含 waiver(固定顺序)");
    assert.deepEqual((await B.api("POST", `/api/tasks/${K.id}/sensitive`, B.operator, { sensitive: [] })).body.task.sensitive, ["waiver"]);
    // 建卡带 sensitive:只有操作者;worker 派生卡 403;助手挂卡 400(不认识的字段);未知值 400 不建卡
    const made = await B.card("建卡就带", "beta", { sensitive: ["prod_write"] });
    assert.deepEqual(made.sensitive, ["prod_write"]);
    assert.equal((await B.api("POST", "/api/tasks", B.operator, { subject: "坏", line: "beta", sensitive: ["x"] })).status, 400);
    assert.equal((await B.api("POST", "/api/tasks", B.worker, { subject: "派生", parentId: made.id, sensitive: ["spend"] })).status, 403);
    assert.equal((await B.api("POST", "/api/assistant/cards", S.token, { subject: "s", description: "d", acceptance: "a", sensitive: ["spend"] })).status, 400);
    assert.deepEqual((await B.card("默认", "beta")).sensitive, [], "默认没有标签");
    // 计划项 needs_confirm:true 而没写 sensitive → ["other"](协调线接假 CLI;先撤掉甲线的豁免,免得 waiver 混进来)
    assert.equal((await B.api("POST", `/api/waivers/${L.id}/revoke`, B.operator, {})).status, 200);
    const conv = await B.api("POST", "/api/conversations", B.operator, { message: "【计划】把导出做成可配置的" });
    assert.equal(conv.status, 201, JSON.stringify(conv.body));
    let dd; for (let i = 0; i < 300; i++) { dd = (await B.api("GET", `/api/conversations/${conv.body.conversation.id}`, B.operator)).body; if (dd.conversation.status !== "running") break; await delay(100); }
    const ap = await B.api("POST", `/api/conversations/${conv.body.conversation.id}/plans/${dd.plans.at(-1).rev}/apply`, B.operator, { expected_rev: dd.plans.at(-1).rev });
    assert.equal(ap.status, 201, JSON.stringify(ap.body));
    const held = ap.body.needs_release;
    assert.equal(held.length, 1, JSON.stringify(ap.body));
    assert.deepEqual((await B.get(held[0])).sensitive, ["other"]);
    for (const id of ap.body.task_ids.filter((i) => i !== held[0])) assert.deepEqual((await B.get(id)).sensitive, []);
    assert.deepEqual(B.dbAll("SELECT by_ FROM card_sensitive WHERE task_id=?", held[0]).map((r) => r.by_), ["operator"]);
  } finally { await B.stop(); }
});

test("J7 批量验收:默认全关;bulk_lines 只操作者写且校验;资格每一项各一个反例;list_digest 对不上整次拒;审后变了只退出那一项;via bulk + 批号;bulk_runs 只追加", { timeout: 240000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" }), XB = await B.connectAs({ kind: "codex", line: "beta" });
    const XR = await B.connectAs({ kind: "claude", line: "rv" }), S = await B.connectAs({ kind: "claude", role: "assistant" });
    // 默认:prefs 带 bulk_lines:[],GET 清单空
    assert.deepEqual((await B.api("GET", "/api/home/prefs", B.operator)).body, { autostart: false, stuck_after: 3, quota_low_at: 90, bulk_lines: [] });
    const E1 = await B.card("可批 1", "alpha"), E2 = await B.card("可批 2", "alpha");
    for (const c of [E1, E2]) { await B.deliver(X, c.id); B.boardCheck(c.id); }
    let L = (await B.api("GET", "/api/home/bulk", B.operator)).body;
    assert.deepEqual(L.items, []);
    assert.ok(L.excluded.find((x) => x.task_id === E1.id).why.some((w) => /没开批量/.test(w)), JSON.stringify(L.excluded));
    // bulk_lines:只有操作者;线名要是看板上的线
    for (const tk of [X.token, S.token, B.worker, B.review]) {
      assert.equal((await B.api("PUT", "/api/home/prefs", tk, { bulk_lines: ["alpha"] })).status, 403);
      assert.ok([403, 404].includes((await B.api("GET", "/api/home/bulk", tk)).status), "读也拒(绑线执行者按读白名单 404)");
      assert.equal((await B.api("POST", "/api/home/bulk", tk, { items: [], list_digest: "x" })).status, 403);
    }
    for (const v of [["ghost"], "alpha", ["alpha", "alpha"], [1]]) assert.equal((await B.api("PUT", "/api/home/prefs", B.operator, { bulk_lines: v })).status, 400, JSON.stringify(v));
    assert.deepEqual((await B.api("PUT", "/api/home/prefs", B.operator, { bulk_lines: ["alpha", "rv"] })).body, { autostart: false, stuck_after: 3, quota_low_at: 90, bulk_lines: ["alpha", "rv"] });
    // 反例,各一项:线没开 / 闸没过(必需检查缺)/ 只凭自报 / 标记(not_target_env)/ 敏感标签 / 豁免 / 自批(审阅线自己交付)/ 不是待验收(等你决定)
    const nLine = await B.card("线没开", "beta"); await B.deliver(XB, nLine.id); B.boardCheck(nLine.id);
    const nGate = await B.card("闸没过", "alpha", { required_checks: ["lint"] }); await B.deliver(X, nGate.id); B.boardCheck(nGate.id);
    const nSelf = await B.card("只凭自报", "alpha"); await B.deliver(X, nSelf.id);
    const nFlag = await B.card("不是目标环境", "alpha", { target_env: "生产" }); await B.deliver(X, nFlag.id); B.boardCheck(nFlag.id, "unit", "host:fixture");
    const nSens = await B.card("敏感", "alpha", { sensitive: ["spend"] }); await B.deliver(X, nSens.id); B.boardCheck(nSens.id);
    const nWaive = await B.card("豁免", "alpha"); await B.deliver(X, nWaive.id); B.boardCheck(nWaive.id);
    assert.equal((await B.api("POST", "/api/waivers", B.operator, { rule: "r", scope: { card: nWaive.id } })).status, 201);
    const nRv = await B.card("审阅线自己交付", "rv"); await B.deliver(XR, nRv.id); B.boardCheck(nRv.id);
    const nAsk = await B.card("等你决定", "alpha");
    { const run = await B.claim(X, nAsk.id); assert.equal((await B.api("POST", `/api/tasks/${nAsk.id}/report`, X.token, { run_id: run, outcome: "wait", evidence: "要人定" })).status, 200); }
    L = (await B.api("GET", "/api/home/bulk", B.operator)).body;
    assert.deepEqual(L.items.map((i) => i.task_id).sort(), [E1.id, E2.id].sort(), JSON.stringify(L, null, 1).slice(0, 3000));
    const why = (id) => (L.excluded.find((x) => x.task_id === id)?.why ?? ["(没列)"]).join(";");
    assert.match(why(nLine.id), /没开批量/);
    assert.match(why(nGate.id), /闸没全过.*lint/);
    assert.match(why(nSelf.id), /只凭自报/);
    assert.match(why(nFlag.id), /not_target_env/);
    assert.match(why(nSens.id), /敏感标签:spend/);
    assert.match(why(nWaive.id), /带豁免/);
    assert.match(why(nRv.id), /自批:交付出自审阅线/);
    assert.equal(L.items.some((i) => i.task_id === nAsk.id) || L.excluded.some((x) => x.task_id === nAsk.id), false, "裁定类不进(也不列)");
    for (const i of L.items) { assert.match(i.approval_id, /^delivery:\d+:\d+$/); assert.match(i.digest, /^[0-9a-f]{64}$/); assert.ok(i.why.length >= 4); }
    assert.equal((await B.api("GET", "/api/brief", S.token)).body.approvals.bulk_ready, 2);
    // list_digest 对不上(交回的清单少一项 / 改一项)→ 整次拒绝,什么都不做
    const pick = (i) => ({ approval_id: i.approval_id, expected_version: i.expected_version, digest: i.digest });
    const items = L.items.map(pick);
    let r = await B.api("POST", "/api/home/bulk", B.operator, { items: items.slice(0, 1), list_digest: L.list_digest });
    assert.deepEqual([r.status, r.body.code], [409, "LIST_CHANGED"]);
    r = await B.api("POST", "/api/home/bulk", B.operator, { items: [{ ...items[0], digest: "0".repeat(64) }, items[1]], list_digest: L.list_digest });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "LIST_CHANGED");
    for (const b of [{}, { items: [], list_digest: L.list_digest }, { items: [{ ...items[0], approval_id: "decision:1:1" }], list_digest: "x" }, { items, list_digest: L.list_digest, x: 1 }])
      assert.equal((await B.api("POST", "/api/home/bulk", B.operator, b)).status, 400, JSON.stringify(b).slice(0, 80));
    assert.deepEqual([(await B.get(E1.id)).status, (await B.get(E2.id)).status], ["waiting", "waiting"], "被拒的整次一张没动");
    // 审后变了:E2 在列表给出之后被标了敏感 → 只退出 E2,E1 照常通过
    assert.equal((await B.api("POST", `/api/tasks/${E2.id}/sensitive`, B.operator, { sensitive: ["other"] })).status, 200);
    r = await B.api("POST", "/api/home/bulk", B.operator, { items, list_digest: L.list_digest });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.done.map((x) => x.task_id), [E1.id]);
    assert.deepEqual(r.body.changed.map((x) => x.task_id), [E2.id]);
    assert.deepEqual(r.body.failed, []);
    assert.match(r.body.bulk_id, /^bk_[0-9a-f]{12}$/);
    assert.equal((await B.get(E1.id)).status, "done");
    assert.equal((await B.get(E2.id)).status, "waiting", "变了的那一项不处理");
    const decs = (await B.api("GET", "/api/approvals/decisions", B.operator)).body.decisions;
    const d1 = decs.find((d) => d.approval_id === items.find((i) => i.approval_id.startsWith(`delivery:${E1.id}:`)).approval_id);
    assert.deepEqual([d1.via, d1.result.bulk_id, d1.source.client, d1.note], ["bulk", r.body.bulk_id, "bulk", ""], "via bulk + 批号;不带 note(带 note 的通过 = 交回原线)");
    const runs = B.dbAll("SELECT * FROM bulk_runs");
    assert.equal(runs.length, 1);
    assert.equal(JSON.parse(runs[0].result_json).done.length, 1);
    const d = B.rw(); try { assert.throws(() => d.exec("UPDATE bulk_runs SET by_='x'"), /append-only/); assert.throws(() => d.exec("DELETE FROM bulk_runs"), /append-only/); } finally { d.close(); }
    // 同一份清单再交一次:E1 已决定 → 审后变了,不重复决定
    r = await B.api("POST", "/api/home/bulk", B.operator, { items, list_digest: L.list_digest });
    assert.deepEqual([r.body.done.length, r.body.changed.length], [0, 2]);
    // 关掉 = 空清单
    await B.api("PUT", "/api/home/prefs", B.operator, { bulk_lines: [] });
    assert.deepEqual((await B.api("GET", "/api/home/bulk", B.operator)).body.items, []);
  } finally { await B.stop(); }
});

test("9c 后续:执行者视图里的 last_note / verdict_note 过脱敏(worker 视图决定不改);worker 与审阅令牌读不到 receipts(反向断言)", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    const T = await B.card("打回卡", "alpha");
    await B.deliver(X, T.id);
    const t = await B.get(T.id);
    const NOTE = "按 C:\\Users\\user\\private\\plan.md 第三节改 · token exe_" + "a".repeat(48);
    const rj = await B.api("POST", `/api/tasks/${T.id}/resolve`, B.operator, { verdict: "reject", note: NOTE, expected_version: t.aggregate_version });
    assert.equal(rj.status, 200, JSON.stringify(rj.body));
    const raw = (await B.get(T.id)).last_note;
    assert.ok(raw.includes("private"), "操作者视图是原话:" + raw);
    for (const [where, task] of [["GET 卡", await B.get(T.id, X.token)],
                                 ["GET 列表", (await B.api("GET", "/api/tasks?status=not_started", X.token)).body.tasks.find((x) => x.id === T.id)]]) {
      assert.ok(task, where);
      for (const k of ["last_note", "verdict_note"]) {
        const v = String(task[k] ?? "");
        assert.ok(!v.includes("Users") && !v.includes("private") && !v.includes("a".repeat(48)), `${where} ${k} 已遮:${v}`);
      }
    }
    // 领卡应答也走同一遮蔽
    const cl = await B.api("POST", `/api/tasks/${T.id}/claim`, X.token, { expected_version: (await B.get(T.id)).aggregate_version });
    assert.equal(cl.status, 200, JSON.stringify(cl.body));
    assert.ok(!String(cl.body.task.last_note ?? "").includes("private"), "领卡应答已遮");
    const hb = await B.api("POST", `/api/tasks/${T.id}/heartbeat`, X.token, { run_id: cl.body.task.run_id });
    assert.ok(!String(hb.body.task?.last_note ?? "").includes("private"), "续租应答已遮");
    // worker 视图决定不改(操作者本机起的进程)
    assert.ok(String((await B.get(T.id, B.worker)).last_note).includes("private"), "worker 视图原样");
    // receipts 只给操作者
    assert.ok("receipts" in (await B.get(T.id)));
    for (const [who, tk] of [["worker", B.worker], ["审阅", B.review], ["执行者", X.token]]) {
      assert.equal("receipts" in (await B.get(T.id, tk)), false, who + " GET 卡");
      const list = (await B.api("GET", "/api/tasks", tk)).body.tasks;
      assert.ok(list.length > 0, who);
      assert.equal(list.some((x) => "receipts" in x), false, who + " GET 列表");
    }
  } finally { await B.stop(); }
});

test("桥 use_approval:真 stdio 桥走通(剩余、用完后 CONFLICT、非当事执行者 FORBIDDEN);旧看板 404 / 405 / 无码 403 → UNSUPPORTED_BY_BOARD", { timeout: 180000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" }), Y = await B.connectAs({ kind: "claude", line: "alpha" });
    const A = (await B.api("POST", "/api/approvals/request", X.token, { action: "跑两次付费接口", risk: "low", quota: { uses: 2 } })).body.request.approval_id;
    assert.equal((await B.api("POST", `/api/approvals/${A}/decide`, B.operator, { decision: "approve", source: { client: "fixture" }, expected_version: 1, grant: { uses: 1 } })).status, 200);
    const M = bridge(["--url", B.base, "--token-file", X.tokenFile, "--line", "alpha"]);
    try {
      assert.ok((await M.request("initialize", INIT)).result);
      M.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = (await M.request("tools/list")).result.tools;
      const t = tools.find((x) => x.name === "use_approval");
      assert.ok(t, "有 use_approval");
      assert.match(t.description, /不据此放行或拦任何动作/);
      assert.match(tools.find((x) => x.name === "get_card").description, /by:"auto" = 自动审阅写的/);
      let r = await M.call("use_approval", { approval_id: A });
      assert.equal(r.isError, true); assert.equal(r.structuredContent.code, "BAD_INPUT", "要 card_id 或 run_id");
      r = await M.call("use_approval", { approval_id: A, run_id: "r-fixture" });
      assert.equal(r.isError, false, JSON.stringify(r));
      assert.deepEqual([r.structuredContent.state, r.structuredContent.remaining.uses], ["exhausted", 0]);
      r = await M.call("use_approval", { approval_id: A, run_id: "r-fixture" });
      assert.deepEqual([r.isError, r.structuredContent.code], [true, "CONFLICT"], "用完后再报 = 被拒,不说成不支持");
      // 卡上用:桥取那张卡这一轮的 run_id
      const B2 = (await B.api("POST", "/api/approvals/request", X.token, { action: "再一件", risk: "low", quota: { uses: 3 } })).body.request.approval_id;
      await B.api("POST", `/api/approvals/${B2}/decide`, B.operator, { decision: "approve", source: { client: "fixture" }, expected_version: 1 });
      const C = await B.card("卡上用", "alpha");
      const cl = await M.call("claim_card", { id: C.id, expected_version: (await B.get(C.id)).aggregate_version });
      assert.equal(cl.isError, false, JSON.stringify(cl));
      r = await M.call("use_approval", { approval_id: B2, card_id: C.id });
      assert.equal(r.structuredContent.state, "active");
      assert.equal(B.dbAll("SELECT run_id FROM grant_uses WHERE request_id=? ", Number(B2.split(":")[1]))[0].run_id, cl.structuredContent.run_id);
    } finally { await M.end(); }
    const MY = bridge(["--url", B.base, "--token-file", Y.tokenFile, "--line", "alpha"]);
    try {
      await MY.request("initialize", INIT);
      const r = await MY.call("use_approval", { approval_id: A, run_id: "r1" });
      assert.deepEqual([r.isError, r.structuredContent.code], [true, "FORBIDDEN"], "非当事执行者 = 看板拒了,不是不支持");
    } finally { await MY.end(); }
  } finally { await B.stop(); }
  // 旧看板(注入 send):没有 /use → 404 / 405,或执行者写白名单里没有 → 无码 403
  const dir = mkdtempSync(join(tmpdir(), "grantbulk-bridge-")), tokenFile = join(dir, "x.token");
  writeFileSync(tokenFile, "exe_" + "0".repeat(48));
  try {
    for (const [status, body, want] of [[404, { error: "未知的批准接口" }, "UNSUPPORTED_BY_BOARD"], [405, { error: "x" }, "UNSUPPORTED_BY_BOARD"],
                                        [403, { error: "executor 令牌无权执行此操作" }, "UNSUPPORTED_BY_BOARD"], [403, { code: "NOT_PARTY", error: "不是你的" }, "FORBIDDEN"],
                                        [404, { code: "GRANT_NOT_FOUND", error: "没有" }, "NOT_FOUND"], [409, { code: "EXHAUSTED", error: "用完", grant: { state: "exhausted" } }, "CONFLICT"]]) {
      const calls = [];
      const send = async (_b, _t, method, path, b) => { calls.push({ method, path, b });
        if (path === "/api/connect/me") return { status: 404, body: {} };
        if (path === "/api/coord") return { status: 200, body: {} };
        if (/\/use$/.test(path)) return { status, body };
        return { status: 404, body: {} }; };
      const h = createExecBridge({ url: "http://127.0.0.1:1/", tokenFile, send });
      await h({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
      const r = (await h({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "use_approval", arguments: { approval_id: "request:3:1", run_id: "r1", usd: 0.5 } } })).result;
      assert.equal(r.structuredContent.code, want, `${status} ${JSON.stringify(body)}`);
      if (want === "UNSUPPORTED_BY_BOARD") assert.match(r.structuredContent.message, /看板版本不支持/);
      assert.deepEqual(calls.find((c) => /\/use$/.test(c.path)), { method: "POST", path: "/api/approvals/request%3A3%3A1/use", b: { run_id: "r1", usd: 0.5 } });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 与 9a(收扫描:kick + flush,按卡扫)的联合用例:定时兜底关掉(整合扫与回收定时都设成一小时),只靠事件当拍 ──────────
const NO_TIMER = { BOARD_INTEGRATE_SCAN_MS: "3600000", BOARD_REAP_MS: "3600000" };
test("联合 9a (a)(b):批量验收通过的卡当拍触发以它 done 为条件的放行;加豁免当拍让自动通过闸不过、卡退出批量(不靠兜底)", { timeout: 180000 }, async () => {
  const B = await board({ env: NO_TIMER });
  try {
    const X = await B.connectAs({ kind: "codex", line: "alpha" });
    assert.equal((await B.api("PUT", "/api/home/prefs", B.operator, { bulk_lines: ["alpha"] })).status, 200);
    const E = [await B.card("批 1", "alpha"), await B.card("批 2", "alpha"), await B.card("批 3", "alpha")];
    for (const c of E) { await B.deliver(X, c.id); B.boardCheck(c.id); }
    const T = await B.card("等批 2 完成", "beta", { release_on: { card: E[1].id, event: "done" } });
    assert.equal(T.released, false);
    let L = (await B.api("GET", "/api/home/bulk", B.operator)).body;
    assert.equal(L.items.length, 3, JSON.stringify(L.excluded));
    const r = await B.api("POST", "/api/home/bulk", B.operator, { items: L.items.map(({ approval_id, expected_version, digest }) => ({ approval_id, expected_version, digest })), list_digest: L.list_digest });
    assert.deepEqual([r.status, r.body.done.length], [200, 3], JSON.stringify(r.body));
    let t; for (let i = 0; i < 20; i++) { t = await B.get(T.id); if (t.released) break; await delay(100); }
    assert.equal(t.released, true, "批量通过 = 逐张 task.resolved(各带卡号)→ 条件放行当拍触发 " + B.log().slice(-600));
    // (b) 一张已可批的卡,加按线的豁免 → 闸当拍不过(闸在读时现算,不等任何扫描)
    const W = await B.card("可批", "alpha"); await B.deliver(X, W.id); B.boardCheck(W.id);
    L = (await B.api("GET", "/api/home/bulk", B.operator)).body;
    assert.ok(L.items.some((i) => i.task_id === W.id));
    assert.equal((await B.api("POST", "/api/waivers", B.operator, { rule: "joint-rule", scope: { line: "alpha" } })).status, 201);
    L = (await B.api("GET", "/api/home/bulk", B.operator)).body;
    const why = L.excluded.find((x) => x.task_id === W.id)?.why.join(";") ?? "";
    assert.match(why, /闸没全过.*已豁免:规则 joint-rule/);
    assert.match(why, /带豁免/);
  } finally { await B.stop(); }
});

test("联合 9a (c):父卡 rearm 不计未放行的复审卡 —— 真看板上由回收定时整板跑(不在 kick + flush 里),结果与 store 单测一致", { timeout: 180000 }, async () => {
  const B = await board({ env: { BOARD_INTEGRATE_SCAN_MS: "3600000", BOARD_REAP_MS: "400" } });
  try {
    const XA = await B.connectAs({ kind: "codex", line: "alpha" }), XB = await B.connectAs({ kind: "codex", line: "beta" });
    const S = await B.card("规格", "alpha"), P = await B.card("父卡", "alpha");
    await B.deliver(XA, P.id);
    const p0 = await B.get(P.id);
    assert.equal((await B.api("POST", `/api/tasks/${P.id}/autoreview`, B.review, { note: "审过,转人", expected_version: p0.aggregate_version })).status, 200);
    const K = await B.card("子卡(照规格做)", "beta", { parentId: P.id, refs: [{ card: S.id, review: true }] });
    await B.deliver(XB, K.id);
    // 子卡交付 → 复审卡当拍出现(9a 的按卡扫),挂在父卡下、未放行
    let rc; for (let i = 0; i < 30; i++) { rc = B.dbAll("SELECT id, released, status, parent_id FROM tasks WHERE parent_id=? AND id<>?", P.id, K.id)[0]; if (rc) break; await delay(100); }
    assert.ok(rc, "复审卡出来了 " + B.log().slice(-600));
    assert.deepEqual([rc.released, rc.status], [0, "not_started"]);
    const k = await B.get(K.id);
    assert.equal((await B.api("POST", `/api/tasks/${K.id}/resolve`, B.operator, { verdict: "approve", expected_version: k.aggregate_version })).status, 200);
    let p; for (let i = 0; i < 40; i++) { p = await B.get(P.id); if (p.waiting_for === "review") break; await delay(150); }
    assert.equal(p.waiting_for, "review", "未放行的复审卡不拖住父卡送回重审:" + p.waiting_for + " " + JSON.stringify(p.progress_blockers));
  } finally { await B.stop(); }
});
