import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 合同 I1–I5(第 8 波 8a):卡之间的关系与「能不能领」的单一判定。`node --test tests/cardrelationstest.mjs`
//   I5 领卡判定收成 store.claimBlockers:排队领 / 按号领 / stuckWhy / 首页一句话 / 列卡口(桥 wait_for_card)同一组码;
//   I1 取代(只追加、沿链解析、环与链深、撤销、执行中心跳)/ I2 依赖重开 → basis_changed + ack、依赖归档 → DEP_ARCHIVED /
//   I3 同批 / I4 互斥资源 needs(执行中卡占、coord 锁占)/ 写权限矩阵 / 真 stdio 桥 / 计划项带 batch、needs。不调用任何模型。
// (仓里已有 tests/relationstest.mjs = 跨机关系图,与这里无关,所以本文件叫 cardrelationstest。)
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { freePort } from "./helpers/free-port.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { holderAndLine } from "../core/home-background.mjs";

const require = createRequire(import.meta.url);
const store = require("../core/store.js"), coord = require("../core/coord.js");
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BRIDGE = join(ROOT, "cli", "exec-mcp.mjs");
const FAKE = join(ROOT, "tests", "helpers", "fake-coordinator-cli.mjs");
const TMP = mkdtempSync(join(tmpdir(), "cardrelations-")), dbs = [];
after(() => { for (const db of dbs) { try { db.close(); } catch {} } rmSync(TMP, { recursive: true, force: true }); });

let serial = 0;
function fx() {
  const dir = join(TMP, "u" + serial++); mkdirSync(dir);
  const db = new DatabaseSync(join(dir, "b.db")); dbs.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  store.migrate(db); coord.migrate(db);
  const add = (subject, extra = {}) => store.add(db, { subject, ...extra });
  const raw = (id) => db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
  const set = (id, sql, ...a) => db.prepare(`UPDATE tasks SET ${sql} WHERE id=?`).run(...a, id);
  const codes = (id, ctx = {}) => store.claimBlockers(db, raw(id), ctx).map((b) => b.code);
  const why = (id) => store.stuckWhy(db, id).map((b) => b.code);
  return { db, add, raw, set, codes, why };
}
const fpLegacy = (rows) => createHash("sha256").update(JSON.stringify([rows])).digest("hex").slice(0, 16);

test("I5 重构前后等价:同一组卡,stuckWhy / claimBlockers / 按号领 / 挑卡给出同一组码(且与改造前各码一致)", () => {
  const { db, add, set, codes, why } = fx();
  const ok = add("能领");
  const unrel = add("未放行", { released: 0 });
  const dep = add("等依赖", { blockedBy: [ok] });
  const holder = add("持锁", { lockKey: "k1" }), locked = add("同锁", { lockKey: "k1" });
  const gated = add("人工闸", { humanGate: true });
  const spent = add("次数用尽"); set(spent, "attempts=?", 999);
  const parent = add("有子卡"), kid = add("子卡", { parentId: parent });
  assert.equal(store.claimById(db, { id: holder, worker: "w0" }).ok, true);
  // 改造前各处的码(手写的期望 = 旧逻辑):
  const expect = new Map([[unrel, ["NOT_RELEASED"]], [dep, ["DEPENDENCIES_UNFINISHED"]], [locked, ["LOCK_HELD"]],
                          [gated, ["HUMAN_GATE"]], [spent, ["ATTEMPT_LIMIT"]], [parent, ["CHILDREN_UNFINISHED"]], [ok, []], [kid, []]]);
  for (const [id, want] of expect) {
    assert.deepEqual(why(id), want, `stuckWhy #${id}`);
    assert.deepEqual(codes(id), want, `claimBlockers #${id}`);
    assert.deepEqual(codes(id, { claimant: true, executionProfile: null, noProgress: {} }), want, `领卡方视角 #${id}`);
  }
  for (const [id, want] of expect) {
    if (!want.length) continue;
    const r = store.claimById(db, { id, worker: "w1" });
    assert.equal(r.ok, false); assert.equal(r.blocker.code, want[0]); assert.deepEqual(r.blockers.map((b) => b.code), want);
    assert.ok(typeof r.why === "string" && r.why.includes(`#${id}`), "原 why 保留");
  }
  // 依赖卡的旧 why 文本与 related_task_ids 形不变
  assert.equal(store.claimById(db, { id: dep, worker: "w1" }).why, `#${dep} 依赖未完成: #${ok}`);
  assert.deepEqual(store.stuckWhy(db, dep)[0], { code: "DEPENDENCIES_UNFINISHED", action: "claim", message: "依赖任务尚未完成", next_action: "核对依赖任务与定义", related_task_ids: [ok] });
  assert.equal(store.claimById(db, { id: dep, worker: "w1" }).code, store.ERR.CONFLICT);
  // 挑卡:只会挑到能领的(ok 先于 kid)
  const got = store.claim(db, "w2");
  assert.equal(got.id, ok);
});

test("I1 取代:旧卡不可领(SUPERSEDED)、依赖沿链解析到最新一张、环 / 自己 / 归档被拒、撤销复原、表只追加", () => {
  const { db, add, set, codes, why } = fx();
  const x = add("旧做法"), y = add("新做法"), z = add("用它的结果", { blockedBy: [x] });
  assert.deepEqual(store.supersede(db, { id: x, by: y }), { id: x, superseded_by: y, changed: true });
  assert.deepEqual(codes(x), ["SUPERSEDED"]);
  assert.deepEqual(store.stuckWhy(db, x)[0].detail, { by: y });
  assert.deepEqual(store.depsSatisfied(db, store.get(db, z)), { ok: false, broken: false, pending: [y], archived: [] }, "依赖沿取代链走到新卡");
  set(x, "status='done'");
  assert.deepEqual(codes(z), ["DEPENDENCIES_UNFINISHED"], "旧卡做完也不算:以链上最新一张为准");
  set(y, "status='done'");
  assert.deepEqual(codes(z), [], "新卡做完 → 下游可领");
  set(x, "status='not_started'"); set(y, "status='not_started'");
  assert.throws(() => store.supersede(db, { id: y, by: x }), /取代环/);
  assert.throws(() => store.supersede(db, { id: x, by: x }), /它自己/);
  assert.throws(() => store.supersede(db, { id: x, by: 99999 }), (e) => e.code === "NOT_FOUND");
  const old = add("归档的"); store.archive(db, { id: old });
  assert.throws(() => store.supersede(db, { id: z, by: old }), /已归档/);
  const w = add("再新"); store.supersede(db, { id: y, by: w });
  assert.deepEqual(store.resolveSuperseded(db, x), { id: w, broken: false, hops: 2 }, "多跳");
  assert.deepEqual(store.relationFields(db, store.get(db, y)).supersedes, [x]);
  assert.equal(store.supersede(db, { id: x, by: null }).changed, true, "撤销 = 追加一行");
  assert.deepEqual(codes(x), []);
  assert.deepEqual(store.depsSatisfied(db, store.get(db, z)).pending, [x]);
  assert.equal(store.supersede(db, { id: x, by: null }).changed, false, "已撤销再撤 = 不写");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM task_supersedes WHERE old_id=?").get(x).c, 2);
  assert.throws(() => db.prepare("UPDATE task_supersedes SET by_id=NULL").run(), /只追加/);
  assert.throws(() => db.prepare("DELETE FROM task_supersedes").run(), /只追加/);
  // 绕过写入口塞进一个环 → 解析判 broken,依赖它的卡落拒绝侧(BROKEN_DEPENDENCIES)
  const p = add("p"), q = add("q"), r = add("依赖 p", { blockedBy: [p] });
  for (const [a, b] of [[p, q], [q, p]]) db.prepare("INSERT INTO task_supersedes (at, old_id, by_id, actor) VALUES (?,?,?,?)").run(new Date().toISOString(), a, b, "fixture");
  assert.deepEqual(codes(r), ["BROKEN_DEPENDENCIES"]);
  assert.deepEqual(why(r), ["BROKEN_DEPENDENCIES"]);
  // 历史里有人话
  const evs = store.events(db, { taskId: x }).map((e) => e.kind);
  assert.ok(evs.includes("supersede") && evs.includes("supersede.revoked"));
});

test("I1 无进展闸:旧依赖被取代、新卡做完 → 指纹的 deps 分量变了,重新派发不被挡;没用到取代的卡指纹与旧版逐字节相同", () => {
  const { db, add, set, raw } = fx();
  const x = add("旧依赖"), z = add("下游", { blockedBy: [x] });
  set(x, "status='done', verdict='approve'");
  assert.equal(store.stateFingerprint(db, raw(z)).deps, fpLegacy([[x, "done", "approve"]]), "旧口径不变");
  assert.equal(store.claimById(db, { id: z, worker: "w", treeRev: "t", extra: null }).ok, true);
  set(z, "status='not_started', worker=NULL, lease_until=NULL");      // 交回、指纹留着
  assert.ok(store.noProgressHold(db, raw(z), { treeRev: "t" }), "什么都没变 → 挡");
  const y = add("新依赖"); store.supersede(db, { id: x, by: y });
  assert.deepEqual(store.claimBlockers(db, raw(z), { noProgress: { treeRev: "t" } }).map((b) => b.code), ["DEPENDENCIES_UNFINISHED"]);
  set(y, "status='done'");
  assert.equal(store.noProgressHold(db, raw(z), { treeRev: "t" }), null, "取代 + 新卡完成 = 新输入");
  const r = store.claimById(db, { id: z, worker: "w", treeRev: "t", extra: null });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("I2 依赖重开:已完成 / 执行中 / 已交付的下游挂 basis_changed + dep.reopened,未开始的不挂;ack 清掉;依赖没做完就归档 → DEP_ARCHIVED", () => {
  const { db, add, set, codes, why } = fx();
  const d = add("依赖");
  set(d, "status='done', verdict='approve'");
  const done = add("已完成的下游", { blockedBy: [d] }), run = add("执行中的下游", { blockedBy: [d] });
  const wait = add("已交付的下游", { blockedBy: [d] }), idle = add("未开始的下游", { blockedBy: [d] }), other = add("无关");
  set(done, "status='done'"); set(wait, "status='waiting', waiting_for='review'");
  assert.equal(store.claimById(db, { id: run, worker: "w" }).ok, true);
  const r = store.reopen(db, { id: d });
  assert.deepEqual(r.basis_changed, [done, run, wait]);
  for (const id of [done, run, wait]) {
    const bc = store.basisChanged(db, id);
    assert.deepEqual(bc.map((x) => [x.dep, x.kind]), [[d, "reopened"]]);
    assert.ok(store.events(db, { taskId: id }).some((e) => e.kind === "dep.reopened" && (typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail).dep === d));
  }
  assert.deepEqual(store.basisChanged(db, idle), [], "未开始的照现状由依赖判定挡住");
  assert.deepEqual(codes(idle), ["DEPENDENCIES_UNFINISHED"]);
  assert.deepEqual(store.basisChanged(db, other), []);
  assert.deepEqual(store.ackBasis(db, { id: done }), { id: done, acked: 1 });
  assert.deepEqual(store.basisChanged(db, done), []);
  assert.deepEqual(store.ackBasis(db, { id: done }), { id: done, acked: 0 }, "没东西可确认 = 不写");
  assert.equal(store.reopen(db, { id: d }).changed, false, "未开始再重开 = 什么都不记");
  assert.equal(store.basisChanged(db, run).length, 1);
  // 沿取代链:下游等的是旧卡,旧卡被新卡取代,新卡重开 → 下游也挂
  const o = add("旧"), n = add("新"); store.supersede(db, { id: o, by: n }); set(n, "status='done'");
  const via = add("经取代链的下游", { blockedBy: [o] }); set(via, "status='done'");
  assert.deepEqual(store.reopen(db, { id: n }).basis_changed, [via]);
  // 归档:没做完 → DEP_ARCHIVED(带卡号);做完了再归档 → 依赖照样满足
  const a1 = add("会被归档的依赖"), down = add("等它", { blockedBy: [a1] });
  store.archive(db, { id: a1 });
  assert.deepEqual(codes(down), ["DEP_ARCHIVED"]);
  const sw = store.stuckWhy(db, down)[0];
  assert.deepEqual([sw.code, sw.detail, sw.related_task_ids], ["DEP_ARCHIVED", { ids: [a1] }, [a1]]);
  assert.match(store.claimById(db, { id: down, worker: "w" }).why, /归档/);
  const a2 = add("做完再归档"), down2 = add("等它 2", { blockedBy: [a2] });
  set(a2, "status='done'"); store.archive(db, { id: a2 });
  assert.deepEqual(why(down2), []);
});

test("I3 同批:依赖指向批里任何一张 = 等全批完成;批内成员不等自己;≤20 张;名字规则;任务对象 batch", () => {
  const { db, add, set, codes, raw } = fx();
  const b1 = add("批一", { batch: "b" }), b2 = add("批二", { batch: "b" }), c = add("下游", { blockedBy: [b1] });
  set(b1, "status='done'");
  assert.deepEqual(store.depsSatisfied(db, store.get(db, c)).pending, [b2], "只依赖了 b1,也要等 b2");
  set(b2, "status='done'");
  assert.deepEqual(codes(c), []);
  const m1 = add("同批甲", { batch: "m" }), m2 = add("同批乙", { batch: "m", blockedBy: [m1] });
  assert.deepEqual(store.depTargets(db, raw(m2)).targets.map((x) => x.id), [m1], "批内依赖不把自己算进去(否则自锁)");
  const rf = store.relationFields(db, store.get(db, b1));
  assert.deepEqual(rf.batch, { key: "b", members: [{ id: b1, title: "批一", status: "done" }, { id: b2, title: "批二", status: "done" }], done: 2, total: 2 });
  assert.equal(store.relationFields(db, store.get(db, c)).batch, null);
  for (let i = 0; i < 20; i++) add("大批 " + i, { batch: "big" });
  assert.throws(() => add("第 21 张", { batch: "big" }), /上限 20/);
  assert.throws(() => store.update(db, { id: c, batch: "big" }), /上限 20/);
  assert.throws(() => add("坏名", { batch: "a\nb" }), /控制字符/);
  assert.throws(() => add("坏型", { batch: 3 }), /字符串/);
  store.update(db, { id: c, batch: "  新批 " });
  assert.equal(raw(c).batch_key, "新批");
  store.update(db, { id: c, batch: "" });
  assert.equal(raw(c).batch_key, null, "空串 = 移出批");
  // 批里一张没做完就被归档:依赖它所在批的下游 → DEP_ARCHIVED(归档不是完成)
  const g1 = add("g1", { batch: "g" }), g2 = add("g2", { batch: "g" }), gd = add("等 g", { blockedBy: [g1] });
  set(g1, "status='done'"); store.archive(db, { id: g2 });
  assert.deepEqual(codes(gd), ["DEP_ARCHIVED"]);
});

test("I4 互斥资源:被执行中的卡占 / 被 coord 锁占 → RESOURCE_BUSY(detail 谁、哪张卡或哪把锁、多久);释放后可领;挑卡跳到下一张", () => {
  const { db, add, codes } = fx();
  assert.equal(store.REL_NAME_RE.source, coord.RESOURCE_RE.source, "资源名规则与 coord 锁同一条");
  const n1 = add("占着 db:x", { needs: ["db:x"] }), n2 = add("也要 db:x", { needs: ["db:x", "db:z"] }), n4 = add("不要资源");
  assert.equal(store.claimById(db, { id: n1, worker: "w1" }).ok, true);
  assert.deepEqual(codes(n2), ["RESOURCE_BUSY"]);
  const sw = store.stuckWhy(db, n2)[0];
  const r0 = sw.detail.resources[0];
  assert.deepEqual([r0.resource, r0.kind, r0.card_id, r0.holder, r0.lock_id], ["db:x", "card", n1, "w1", null]);
  assert.ok(Number.isInteger(r0.minutes) && typeof r0.since === "string");
  assert.deepEqual(sw.related_task_ids, [n1]);
  assert.match(store.claimById(db, { id: n2, worker: "w2" }).why, /db:x/);
  assert.equal(store.claim(db, "w2").id, n4, "排队领跳过被占的卡去领下一张");
  // coord 锁
  coord.register(db, { id: "ex1", name: "执行者一", kind: "other" });
  const n3 = add("要 db:y", { needs: ["db:y"] });
  assert.deepEqual(codes(n3), []);
  assert.equal(coord.acquire(db, "ex1", { resource: "db:y", minutes: 5, purpose: "fixture" }).ok, true);
  const lk = store.stuckWhy(db, n3)[0].detail.resources[0];
  assert.deepEqual([lk.resource, lk.kind, lk.holder, lk.card_id], ["db:y", "lock", "ex1", null]);
  assert.ok(Number.isInteger(lk.lock_id));
  coord.release(db, { id: "ex1" }, { resource: "db:y" });
  assert.deepEqual(codes(n3), [], "锁放了 → 可领");
  // 写入口
  assert.throws(() => add("坏资源", { needs: ["bad name"] }), /资源名/);
  assert.throws(() => add("太多", { needs: Array.from({ length: 9 }, (_, i) => "r" + i) }), /最多声明 8/);
  assert.deepEqual(store.setNeeds(db, { id: n4, needs: ["b", "a", "a"] }), { id: n4, needs: ["a", "b"] });
  assert.deepEqual(store.relationFields(db, store.get(db, n4)).needs, ["a", "b"]);
  assert.deepEqual(store.setNeeds(db, { id: n4, needs: [] }).needs, []);
  assert.equal(db.prepare("SELECT needs FROM tasks WHERE id=?").get(n4).needs, null);
  // lock_key 行为不动
  const k1 = add("k1", { lockKey: "same" }), k2 = add("k2", { lockKey: "same" });
  store.claimById(db, { id: k1, worker: "w3" });
  assert.deepEqual(codes(k2), ["LOCK_HELD"]);
});

test("I5 登记口:registerClaimCheck 的码进同一份判定(stuckWhy 带 detail、按号领拒绝);注销后消失", () => {
  const { db, add, codes, why } = fx();
  const a = add("被登记的检查拦住");
  const off = store.registerClaimCheck("fixture", (_db, t) => t.subject.includes("拦住") ? { code: "FIXTURE_HOLD", detail: { n: 1 }, why: "登记口拦住" } : null);
  try {
    assert.deepEqual(codes(a), ["FIXTURE_HOLD"]);
    assert.deepEqual(store.stuckWhy(db, a)[0].detail, { n: 1 });
    const r = store.claimById(db, { id: a, worker: "w" });
    assert.deepEqual([r.ok, r.blocker.code, r.why], [false, "FIXTURE_HOLD", "登记口拦住"]);
  } finally { off(); }
  assert.deepEqual(why(a), []);
});

// ── HTTP:临时看板 ─────────────────────────────────────────────────────────────────────────────────────────
async function board({ lines = [{ id: "alpha" }, { id: "ext", label: "外部", external: true }], env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cardrelationstest-")), config = join(dir, "fleet.json"), repo = join(dir, "repo");
  mkdirSync(repo); mkdirSync(join(dir, "fake-projects")); mkdirSync(join(dir, "fake-codex"));
  writeFileSync(config, JSON.stringify({ lines, roles: [], routes: ["default"], repo }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir, BOARD_DB: join(dir, "board.db"),
           BOARD_REPO: repo, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit",
           BOARD_CLAUDE_PROJECTS: join(dir, "fake-projects"), BOARD_CODEX_HOME: join(dir, "fake-codex"), ...env } });
  let log = ""; child.stdout.on("data", (d) => { log = (log + d).slice(-20000); }); child.stderr.on("data", (d) => { log = (log + d).slice(-20000); });
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
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, worker, review, get, card, connectAs, claim, stop, log: () => log };
}

test("HTTP:四处同一组码(progress_blockers / 按号领 409 的 code·detail·blockers / claimable 列卡 / 首页一句话)+ 任务对象关系字段 + 心跳", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });
    const busyHolder = await B.card("占着资源", "ext", { needs: ["db:fixture"] });
    const busy = await B.card("要同一资源", "ext", { needs: ["db:fixture"], batch: "b1" });
    const free = await B.card("能领", "ext");
    assert.deepEqual([busy.needs, busy.batch.key, busy.batch.total], [["db:fixture"], "b1", 1], "建卡带 batch / needs(操作者)");
    assert.equal((await B.claim(busyHolder.id, X.token)).status, 200);
    // 排队领(/api/claim,执行者令牌只从自己的线挑):编号更小的「要同一资源」被占 → 跳过去领下一张
    const pc = await B.api("POST", `/api/claim`, X.token, {});
    assert.equal(pc.body?.task?.id, free.id, pc.status + " " + JSON.stringify(pc.body));
    assert.ok(busy.id < free.id);
    const old = await B.card("被取代的", "ext"), neu = await B.card("取代它的", "ext");
    const sup = await B.api("POST", `/api/tasks/${old.id}/supersede`, B.operator, { by: neu.id });
    assert.equal(sup.status, 200, JSON.stringify(sup.body));
    assert.deepEqual([sup.body.task.superseded_by, (await B.get(neu.id)).supersedes], [neu.id, [old.id]]);
    // 四处:progress_blockers 码 = 409 的 blockers 码;409 带 code / detail,原 error 文本保留
    for (const [t, code] of [[busy, "RESOURCE_BUSY"], [old, "SUPERSEDED"]]) {
      const pb = (await B.get(t.id)).progress_blockers.map((b) => b.code);
      const r = await B.claim(t.id, X.token);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, code); assert.ok(r.body.detail && typeof r.body.detail === "object");
      assert.equal(r.body.error, r.body.why); assert.ok(r.body.error.includes(`#${t.id}`));
      assert.deepEqual(r.body.blockers.map((b) => b.code), pb, `#${t.id} 两处同一组码`);
      assert.equal(holderAndLine({ ...(await B.get(t.id)), released: 1 }, { now: Date.now() }).one_line.code, code === "SUPERSEDED" ? "superseded" : "resource_busy");
    }
    assert.deepEqual((await B.claim(old.id, X.token)).body.detail, { by: neu.id });
    // claimable=1:只列能领的;执行者不带参数(旧桥的用法)也被过滤;操作者不带参数照旧全列
    const ids = (r) => r.body.tasks.map((t) => t.id).sort((a, b) => a - b);
    const want = [neu.id];
    assert.deepEqual(ids(await B.api("GET", "/api/tasks?status=not_started&archived=false&claimable=1", B.operator)), want);
    assert.deepEqual(ids(await B.api("GET", "/api/tasks?status=not_started&archived=false&line=ext", X.token)), want, "旧桥的列卡口:服务端过滤");
    assert.ok(ids(await B.api("GET", "/api/tasks?status=not_started&archived=false", B.operator)).includes(busy.id), "操作者照旧看全部");
    // 心跳:执行中被取代 → superseded + next;板不强收
    const neu2 = await B.card("取代执行中的", "ext");
    const s2 = await B.api("POST", `/api/tasks/${busyHolder.id}/supersede`, B.operator, { by: neu2.id });
    assert.equal(s2.status, 200);
    const run = (await B.get(busyHolder.id)).run_id;
    const hb = await B.api("POST", `/api/tasks/${busyHolder.id}/heartbeat`, X.token, { run_id: run });
    assert.equal(hb.status, 200, JSON.stringify(hb.body));
    assert.deepEqual(hb.body.superseded, { by: neu2.id }); assert.match(hb.body.next, /停手/);
    assert.equal((await B.get(busyHolder.id)).status, "in_progress", "不强收");
    // 依赖重开 → 执行中的下游心跳带 basis_changed;操作者 ack 后消失
    const dep = await B.card("依赖", "ext");
    const down = await B.card("下游", "ext", { blockedBy: [dep.id] });
    const dc = await B.claim(dep.id, X.token);
    assert.equal(dc.status, 200, JSON.stringify(dc.body));
    assert.equal((await B.api("POST", `/api/tasks/${dep.id}/report`, X.token, { run_id: dc.body.task.run_id, outcome: "done", evidence: "ok" })).status, 200);
    const rs = await B.api("POST", `/api/tasks/${dep.id}/resolve`, B.operator, { verdict: "approve", expected_version: (await B.get(dep.id)).aggregate_version, allow_uncommitted: true });
    assert.equal(rs.status, 200, JSON.stringify(rs.body));
    assert.equal((await B.claim(down.id, X.token)).status, 200);
    const ro = await B.api("POST", `/api/tasks/${dep.id}/reopen`, B.operator, { expected_version: (await B.get(dep.id)).aggregate_version });
    assert.equal(ro.status, 200, JSON.stringify(ro.body));
    assert.deepEqual(ro.body.basis_changed, [down.id]);
    const hb2 = await B.api("POST", `/api/tasks/${down.id}/heartbeat`, X.token, { run_id: (await B.get(down.id)).run_id });
    assert.deepEqual(hb2.body.basis_changed.map((x) => [x.dep, x.kind]), [[dep.id, "reopened"]]);
    assert.deepEqual((await B.get(down.id)).basis_changed.map((x) => x.dep), [dep.id]);
    const hist = (await B.api("GET", `/api/tasks/${down.id}/history`, B.operator)).body.entries;
    assert.ok(hist.some((e) => /依赖 #\d+ 被重开/.test(e.summary)), "卡历史有人话");
    assert.equal((await B.api("POST", `/api/tasks/${down.id}/basis/ack`, B.operator, {})).body.acked, 1);
    assert.deepEqual((await B.get(down.id)).basis_changed, []);
    // 依赖没做完就归档 → DEP_ARCHIVED;首页「要本人做的事」归 fault
    const gone = await B.card("会被归档", "alpha"), stuck = await B.card("永远等", "alpha", { blockedBy: [gone.id] });
    assert.equal((await B.api("POST", `/api/tasks/${gone.id}/archive`, B.operator, { expected_version: (await B.get(gone.id)).aggregate_version })).status, 200);
    const st = await B.get(stuck.id);
    assert.deepEqual(st.progress_blockers.map((b) => b.code), ["DEP_ARCHIVED"]);
    const bg = await B.api("GET", "/api/home/background", B.operator);
    assert.equal(bg.status, 200);
    const att = bg.body.attention.find((a) => a.task_id === stuck.id);
    assert.ok(att, "进「要本人做的事」 " + JSON.stringify(bg.body.attention));
    assert.equal(att.type, "fault");
    const brief = await B.api("GET", "/api/brief", B.operator);
    assert.equal(brief.body.attention.find((a) => a.task_id === stuck.id)?.kind, "blocked");
    // 同批经 update 改、needs 专门接口
    const up = await B.api("POST", `/api/tasks/${neu.id}/update`, B.operator, { expected_version: (await B.get(neu.id)).aggregate_version, batch: "b1" });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal((await B.get(busy.id)).batch.total, 2);
    const nd = await B.api("POST", `/api/tasks/${neu.id}/needs`, B.operator, { needs: ["db:other"] });
    assert.deepEqual([nd.status, nd.body.needs], [200, ["db:other"]]);
    assert.equal((await B.api("POST", `/api/tasks/${neu.id}/needs`, B.operator, { needs: ["bad name"] })).status, 400);
    assert.equal((await B.api("POST", `/api/tasks/${neu.id}/supersede`, B.operator, { by: neu.id })).status, 400);
    assert.equal((await B.api("POST", `/api/tasks/${neu.id}/supersede`, B.operator, {})).status, 400);
    assert.equal((await B.api("POST", `/api/tasks/999999/supersede`, B.operator, { by: neu.id })).status, 404);
  } finally { await B.stop(); }
});

test("HTTP:写权限矩阵 —— 新接口只有操作者;助手挂卡带关系字段 400;worker 派生卡带 403;执行者 / 审阅令牌 403", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });
    const A = await B.connectAs({ kind: "other", role: "assistant", label: "助手" });
    const a = await B.card("甲", "ext"), b = await B.card("乙", "ext");
    for (const [who, token] of [["执行者", X.token], ["助手", A.token], ["worker", B.worker], ["审阅", B.review]]) {
      for (const [path, body] of [[`/api/tasks/${a.id}/supersede`, { by: b.id }], [`/api/tasks/${a.id}/needs`, { needs: ["db:x"] }], [`/api/tasks/${a.id}/basis/ack`, {}]]) {
        const r = await B.api("POST", path, token, body);
        assert.equal(r.status, 403, `${who} ${path} ${JSON.stringify(r.body)}`);
      }
    }
    assert.equal((await B.get(a.id)).superseded_by, null, "什么都没写进去");
    for (const k of ["batch", "needs", "supersede"]) {
      const r = await B.api("POST", "/api/assistant/cards", A.token, { subject: "助手挂的", description: "", acceptance: "", [k]: k === "needs" ? ["db:x"] : "x" });
      assert.equal(r.status, 400, `助手带 ${k}: ${JSON.stringify(r.body)}`);
    }
    for (const k of ["batch", "needs", "supersedes"]) {
      const r = await B.api("POST", "/api/tasks", B.worker, { subject: "派生", parentId: a.id, parent_run_id: "x", worker: "w", [k]: k === "needs" ? ["db:x"] : "x" });
      assert.equal(r.status, 403, `worker 带 ${k}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await B.api("POST", "/api/tasks", B.operator, { subject: "操作者建卡时写取代", supersedes: [a.id] })).status, 400, "取代不在建卡时写");
    assert.equal((await B.api("POST", "/api/tasks", B.operator, { subject: "坏批", batch: 7 })).status, 400);
    assert.equal((await B.api("POST", "/api/tasks", B.operator, { subject: "坏资源", needs: "db:x" })).status, 400);
    // 操作者 ok
    assert.equal((await B.api("POST", `/api/tasks/${a.id}/supersede`, B.operator, { by: b.id })).status, 200);
    assert.equal((await B.api("POST", `/api/tasks/${a.id}/supersede`, B.operator, { by: null })).body.superseded_by, null);
  } finally { await B.stop(); }
});

test("真 stdio 桥:wait_for_card 不再交出领不了的卡;heartbeat 转出 superseded;不带新字段的旧用法照常", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });
    const tokenFile = join(B.dir, "x.token"); writeFileSync(tokenFile, X.token);
    const holder = await B.card("先占着资源", "ext", { needs: ["db:fixture"] });
    assert.equal((await B.claim(holder.id, X.token)).status, 200);
    const blocked = await B.card("要同一资源(编号更小,旧桥会先交出它)", "ext", { needs: ["db:fixture"] });
    const ok = await B.card("能领的", "ext");
    assert.ok(blocked.id < ok.id);
    const M = spawn(process.execPath, [BRIDGE, "--url", B.base, "--token-file", tokenFile, "--line", "ext"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: HOST_ENV });
    let buf = ""; const waiting = new Map(); M.stdout.setEncoding("utf8");
    M.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
    let n = 1; const rpc = (method, params) => { const id = n++; M.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return new Promise((r) => waiting.set(id, r)); };
    const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result.structuredContent;
    try {
      await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
      M.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const w = await call("wait_for_card", { timeout_sec: 2 });
      assert.equal(w.card.id, ok.id, "跳过被占资源的那张");
      const g = await call("get_card", { id: blocked.id });
      assert.ok(g.card.blockers.includes("RESOURCE_BUSY"), "卡面里看得到原因(阻塞码) " + JSON.stringify(g.card.blockers));
      const c = await call("claim_card", { id: ok.id, expected_version: (await call("get_card", { id: ok.id })).card.aggregate_version });
      assert.ok(c.run_id);
      const plain = await call("heartbeat", { id: ok.id });
      assert.equal(plain.superseded, undefined, "没被取代 = 不带");
      const neu = await B.card("取代它", "ext");
      assert.equal((await B.api("POST", `/api/tasks/${ok.id}/supersede`, B.operator, { by: neu.id })).status, 200);
      const hb = await call("heartbeat", { id: ok.id });
      assert.deepEqual(hb.superseded, { by: neu.id }); assert.match(hb.next, /停手/);
      assert.equal((await call("get_card", { id: ok.id })).card.superseded_by, neu.id);
      const r = await call("report_result", { id: ok.id, outcome: "wait", evidence: "已被取代,停在第一步" });
      assert.equal(r.status, "waiting");
      const l = await call("list_cards", {});
      assert.ok(l.cards.every((x) => x.id !== blocked.id), "列卡口同一判定");
    } finally { M.stdin.end(); await new Promise((r) => M.once("close", r)); }
  } finally { await B.stop(); }
});

test("计划项带 batch / needs:合规的设上,不合规的静默不设(同 required_checks 先例)", { timeout: 120000 }, async () => {
  const log = join(TMP, "coord-calls.jsonl");
  const B = await board({ lines: [{ id: "alpha", label: "开发" }], env: { BOARD_COORDINATOR_CLI_ARGV: JSON.stringify([process.execPath, FAKE]), CONVTEST_LOG: log } });
  try {
    const made = await B.api("POST", "/api/conversations", B.operator, { message: "【关系】三张卡" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.conversation.id;
    let d;
    for (let i = 0; i < 300; i++) { d = (await B.api("GET", `/api/conversations/${id}`, B.operator)).body; if (d.conversation.status !== "running") break; await delay(100); }
    assert.equal(d.plans.length, 1, JSON.stringify(d.conversation));
    const ap = await B.api("POST", `/api/conversations/${id}/plans/1/apply`, B.operator, { expected_rev: 1 });
    assert.equal(ap.status, 201, JSON.stringify(ap.body));
    const kids = await Promise.all(ap.body.task_ids.map((t) => B.get(t)));
    assert.deepEqual(kids.map((k) => [k.subject, k.batch?.key ?? null, k.needs]),
      [["甲", "b1", ["db:fixture"]], ["乙", "b1", []], ["丙", null, []]]);
    assert.ok(existsSync(log));
  } finally { await B.stop(); }
});

// ── 与 8b(合同 I6–I9)的联合:被取代的卡不算占用、不进候选组装清单;条件放行的源卡被取代 → broken;同批在候选组装清单里标批名与 n/m。
const until = async (fn, ms = 10000, step = 100) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v || Date.now() > end) return v; await delay(step); } };
test("联合(8a × 8b):取代 × 占用表 / 条件放行 / 候选组装;同批 × 候选组装", { timeout: 150000 }, async () => {
  const B = await board({ env: { BOARD_DELIVERABLE_GATE: "off" } });
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });
    const deliver = async (id) => {
      const c = await B.claim(id, X.token); assert.equal(c.status, 200, JSON.stringify(c.body));
      assert.equal((await B.api("POST", `/api/tasks/${id}/report`, X.token, { run_id: c.body.task.run_id, outcome: "done", evidence: "做完了" })).status, 200);
      const r = await B.api("POST", `/api/tasks/${id}/resolve`, B.operator, { verdict: "approve", expected_version: (await B.get(id)).aggregate_version, allow_uncommitted: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };
    // 取代 × 占用表:两张执行中的卡都写了同一路径 → 重叠;一张被取代 → 占用表不再算它
    const p1 = await B.card("动 a", "ext", { touches: ["src/a.mjs"] }), p2 = await B.card("也动 a", "ext", { touches: ["src/a.mjs"] });
    for (const id of [p1.id, p2.id]) assert.equal((await B.claim(id, X.token)).status, 200);
    let occ = (await B.api("GET", "/api/occupancy", B.operator)).body;
    assert.deepEqual(occ.overlaps.find((o) => o.path === "src/a.mjs")?.cards, [p1.id, p2.id], JSON.stringify(occ));
    const nx = await B.card("取代「动 a」", "ext");
    assert.equal((await B.api("POST", `/api/tasks/${p1.id}/supersede`, B.operator, { by: nx.id })).status, 200);
    occ = (await B.api("GET", "/api/occupancy", B.operator)).body;
    assert.ok(!occ.rows.some((r) => r.cards.some((c) => c.id === p1.id)), "被取代的卡不计入占用 " + JSON.stringify(occ));
    assert.ok(!occ.overlaps.some((o) => o.path === "src/a.mjs"));
    // 取代 × 条件放行:源卡被取代 → broken,源卡做完也不放行(不顺链)
    const S = await B.card("源", "ext"), S2 = await B.card("源的新版", "ext");
    const T = await B.card("等源完成", "ext", { release_on: { card: S.id, event: "done" } });
    assert.ok((await B.get(T.id)).progress_blockers.filter((b) => b.code === "RELEASE_ON_PENDING").length === 1, "只出一条");
    assert.equal((await B.api("POST", `/api/tasks/${S.id}/supersede`, B.operator, { by: S2.id })).status, 200);
    let t = await B.get(T.id);
    assert.equal(t.release_on.broken, true);
    assert.ok(!t.progress_blockers.some((b) => b.code === "RELEASE_ON_PENDING"), "broken 了就交给人");
    assert.equal((await B.api("POST", `/api/tasks/${S.id}/supersede`, B.operator, { by: null })).status, 200);
    assert.equal((await B.get(T.id)).release_on.broken, false, "撤销取代 → 条件恢复有效");
    assert.equal((await B.api("POST", `/api/tasks/${S.id}/supersede`, B.operator, { by: S2.id })).status, 200);
    await deliver(S2.id);
    await delay(800);
    t = await B.get(T.id);
    assert.deepEqual([!!t.released, t.release_on.fired], [false, false], "不沿取代链去等新卡");
    // 取代 × 候选组装 + 同批:k3 被 k4 取代且没做完 → 不挡组装、不进清单;k1 / k2 同批 → 标「同批「gb」2/2」
    const gr = await B.api("POST", "/api/goals", B.operator, { subject: "整合目标", integrate: { target: "refs/heads/main", assemble: true } });
    assert.equal(gr.status, 201, JSON.stringify(gr.body));
    const G = gr.body.task;
    const k1 = await B.card("子一", "ext", { parentId: G.id, batch: "gb" }), k2 = await B.card("子二", "ext", { parentId: G.id, batch: "gb" });
    const k3 = await B.card("子三(会被取代)", "ext", { parentId: G.id }), k4 = await B.card("子四(取代子三)", "ext", { parentId: G.id });
    assert.equal((await B.api("POST", `/api/tasks/${G.id}/release`, B.operator, { released: true, expected_version: (await B.get(G.id)).aggregate_version })).status, 200);
    assert.equal((await B.api("POST", `/api/tasks/${k3.id}/supersede`, B.operator, { by: k4.id })).status, 200);
    for (const id of [k1.id, k2.id, k4.id]) await deliver(id);
    const autos = async () => (await B.api("GET", "/api/tasks?archived=all", B.operator)).body.tasks.filter((x) => x.auto_kind === "assemble");
    const list = await until(async () => { const a = await autos(); return a.length ? a : null; });
    assert.equal(list?.length, 1, "子三被取代,其余做完 → 出候选组装卡 " + B.log().slice(-1500));
    const A = list[0];
    assert.ok(!A.description.includes(`#${k3.id}「`), "被取代的卡不列进清单 " + A.description);
    assert.ok(A.description.includes(`#${k4.id}「`));
    for (const k of [k1, k2]) assert.match(A.description, new RegExp(`#${k.id}「[^」]+」 — [^\n]*同批「gb」2/2`), A.description);
    assert.ok(!new RegExp(`#${k4.id}「[^」]+」 — [^\n]*同批`).test(A.description));
  } finally { await B.stop(); }
});
