import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 公告板 v3 合同 C「效率」:固定时钟的合成数据 → GET /api/efficiency 的各个数。
// 跨期边界、时段并集与峰值并行、重开后再完成、只自动通过、打回两次、无 work_spans 的旧卡、账本缺失、
// 空区间、目标卡 / 父卡不计、鉴权、board.py efficiency。`node --test tests/efficiencytest.mjs`。不调用任何模型。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { freePort } from "./helpers/free-port.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const store = require(join(ROOT, "core", "store.js"));
const E = await import(pathToFileURL(join(ROOT, "core", "efficiency.mjs")).href);
const { openLedger } = await import(pathToFileURL(join(ROOT, "core", "usage.mjs")).href);
const PY = HOST_ENV.PYTHON || "python";

// 本地时区的 2026-11-<d> h:mm。现在 = 11-11(周三)12:00 ⇒ 本周 11-09..11-16,上周 11-02..11-09。
const T = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
const iso = (t) => new Date(t).toISOString();
const H = 3600000;
const NOW = T(11, 12);

function fixture(t, { ledgerRows = null } = {}) {
  const db = new DatabaseSync(":memory:"); store.migrate(db); t.after(() => db.close());
  // 卡经 store.add 建(带本节点身份),再把时刻等列直接改成合成值。
  const setTask = db.prepare(`UPDATE tasks SET kind=?, parent_id=?, line=?, status=?, created_at=?, updated_at=?, resolved_at=?, work_spans=?, attempts=?, heartbeat_at=?, last_runtime=? WHERE id=?`);
  const card = ({ kind = "task", parent = null, line = null, status = "done", created, resolved = null, spans = [], attempts = 1, heartbeat = null, runtime = null }) => {
    const id = store.add(db, { subject: "卡", released: 1, actor: "operator" });
    setTask.run(kind, parent, line, status, iso(created), iso(resolved ?? created), resolved == null ? null : iso(resolved),
      JSON.stringify(spans.map(([w, s, e]) => (e == null ? { w, s: iso(s) } : { w, s: iso(s), e: iso(e) }))), attempts, heartbeat, runtime, id);
    return id;
  };
  const insEv = db.prepare("INSERT INTO task_events (at, task_id, kind, actor, detail) VALUES (?,?,?,?,?)");
  const ev = (id, at, kind, actor, detail = {}) => insEv.run(iso(at), id, kind, actor, JSON.stringify(detail));
  const work = (id, line, claimAt, reportAt) => { ev(id, claimAt, "claim", line); ev(id, reportAt, "report", line, { outcome: "done" }); };
  const close = (id, at, by) => ev(id, at, "resolve", by, { disposition: "close" });
  const back = (id, at) => ev(id, at, "resolve", "human", { disposition: "hand_back" });

  // A:跨期 —— 11-08 22:00 领取、11-09 02:00 交付(时段一半在上周一半在本周),人 05:00 通过(等 3h)。
  const A = card({ line: "alpha", created: T(3, 10), resolved: T(9, 5), spans: [["alpha", T(8, 22), T(9, 2)]], runtime: "claude" });
  work(A, "alpha", T(8, 22), T(9, 2)); close(A, T(9, 5), "human");
  // B:上周自动通过,本周被人重开、再做、人通过 —— 只算本周完成一次,不算一次通过。
  const B = card({ line: "alpha", created: T(2, 9), resolved: T(10, 15), spans: [["alpha", T(4, 10), T(4, 12)], ["alpha", T(10, 10), T(10, 11, 15)]], attempts: 2, runtime: "claude" });
  work(B, "alpha", T(4, 10), T(4, 12)); close(B, T(4, 13), "auto");
  ev(B, T(10, 9), "reopen", "operator");
  work(B, "alpha", T(10, 10), T(10, 11, 15)); close(B, T(10, 15), "human");
  // C:被打回两次,第三次自动通过。运行时以 task_runs 为准(last_runtime 写的是 claude)。
  const C = card({ line: "beta", created: T(10, 8), resolved: T(10, 14, 30), attempts: 3, runtime: "claude",
                   spans: [["beta", T(10, 9), T(10, 10)], ["beta", T(10, 11), T(10, 12)], ["beta", T(10, 13), T(10, 14)]] });
  work(C, "beta", T(10, 9), T(10, 10)); back(C, T(10, 10, 30));
  work(C, "beta", T(10, 11), T(10, 12)); back(C, T(10, 12, 30));
  work(C, "beta", T(10, 13), T(10, 14)); close(C, T(10, 14, 30), "auto");
  db.prepare(`INSERT INTO task_runs (run_id, task_id, task_uid, owner_node_id, executor_node_id, worker, role_id, runtime, policy_json, policy_sha256, started_at, first_attempt, last_attempt, state)
              VALUES ('r-c', ?, 'u', 'n', 'n', 'beta', 'beta', 'codex', '{}', 'x', ?, 3, 3, 'ended')`).run(C, iso(T(10, 13)));
  // 目标 G(不计)下挂 D;父卡 P(下面挂着 C,不计)。
  const G = card({ kind: "goal", created: T(1, 9), resolved: T(10, 16), attempts: 0 });
  const P = card({ line: "beta", created: T(1, 9), resolved: T(10, 17), attempts: 0 });
  db.prepare("UPDATE tasks SET parent_id=? WHERE id=?").run(P, C);
  // D:只有自动通过。与 C、B 的时段交叠 → 11:00-11:15 三条同时在跑。
  const D = card({ parent: G, line: "beta", created: T(10, 9), resolved: T(10, 11, 40), spans: [["beta", T(10, 9, 30), T(10, 11, 30)]], runtime: "codex" });
  work(D, "beta", T(10, 9, 30), T(10, 11, 30)); close(D, T(10, 11, 40), "auto");
  // O:上周完成的旧卡,派发过但没有 work_spans、也没有领取事件 → 上周 ai_work_ms 未知。
  const O = card({ line: "alpha", created: T(4, 8), resolved: T(5, 8), attempts: 1 });
  // S:还在做,心跳停在 10:05(超过 20 分钟)→ 卡住;时段开着,算到现在。
  const S = card({ line: "alpha", status: "in_progress", created: T(11, 9), spans: [["alpha", T(11, 10), null]], heartbeat: T(11, 10, 5), runtime: "claude" });
  ev(S, T(11, 10), "claim", "alpha");

  let ledger = null;
  if (ledgerRows !== false) {
    const dir = mkdtempSync(join(tmpdir(), "efftest-")), file = join(dir, "usage_ledger.jsonl");
    t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    const row = (o) => JSON.stringify({ model: "m", phase: "implement", attempt: 1, cost_source: "reported", ...o }) + "\n";
    writeFileSync(file, (ledgerRows || [
      row({ ts: iso(T(9, 1)), card: A, worker: "alpha", duration_ms: H, cost_usd: 0.5 }),
      row({ ts: iso(T(10, 9, 30)), card: C, worker: "beta", duration_ms: H / 2, cost_usd: 0.25 }),
      row({ ts: iso(T(10, 10)), card: null, worker: "coord", phase: "coord", duration_ms: 60000, cost_usd: 0.01 }),
      row({ ts: iso(T(4, 11)), card: B, worker: "alpha", duration_ms: null, cost_usd: 0.1 }),   // 上周:耗时未知
    ].join("")) || "", "utf8");
    ledger = openLedger(file);
  }
  let clock = NOW;
  const eff = E.createEfficiency({ db, ledger, lines: () => ["alpha", "beta"], labels: () => ({ alpha: "开发" }), clock: () => clock });
  return { db, eff, ev, ids: { A, B, C, D, G, P, O, S }, setClock: (v) => { clock = v; } };
}

const nullsListed = (m) => {
  for (const [k, v] of Object.entries(m)) if (k !== "unknown") assert.equal(v === null, m.unknown.includes(k), `${k}=${v} 与 unknown 一致`);
};

test("本周对上周:各个数按口径算出;未知列进 unknown;主句", (t) => {
  const { eff } = fixture(t);
  const r = eff.compute();
  assert.equal(r.period.from.slice(0, 16), "2026-11-09T00:00"); assert.equal(r.period.to.slice(0, 16), "2026-11-16T00:00");
  assert.equal(r.previous.from.slice(0, 16), "2026-11-02T00:00"); assert.equal(r.previous.to.slice(0, 16), "2026-11-09T00:00");
  const n = r.now;
  assert.equal(n.done, 4, "A、B、C、D;目标 G、父卡 P 不计");
  assert.equal(n.lead_ms_median, Math.round(((6.5 + 139) / 2) * H));
  assert.equal(n.cycle_ms_median, Math.round(6.25 * H), "B 的首次领取在上周:cycle 从首次领取算");
  assert.equal(n.handed_back, 2);
  assert.equal(n.first_pass_rate, 0.5, "A、D 一次通过;B 重开过、C 打回过");
  assert.equal(n.auto_accept_rate, 0.5, "通过 4 次,自动 2 次");
  assert.equal(n.human_actions, 5, "A 通过、B 重开 + 通过、C 两次打回");
  assert.equal(n.wait_human_ms_total, Math.round((3 + 3.75 + 0.5 + 0.5) * H));
  assert.equal(n.wait_human_ms_median, Math.round(1.75 * H));
  assert.equal(n.ai_work_ms, Math.round(10.25 * H), "A 只算本周那 2h;S 算到现在");
  assert.equal(n.parallel_peak, 3);
  assert.equal(n.parallel_avg, 1.28, "10.25h ÷ 并集 8h");
  assert.equal(n.stalled, 1);
  assert.equal(n.model_ms, H + H / 2 + 60000); assert.equal(n.cost_usd, 0.76);
  assert.deepEqual(n.unknown, []);
  nullsListed(n);

  const p = r.prev;
  assert.equal(p.done, 1, "只有 O;B 后来重开再完成,resolved_at 已是本周");
  assert.equal(p.lead_ms_median, 24 * H);
  assert.equal(p.cycle_ms_median, null, "O 没有领取事件");
  assert.equal(p.ai_work_ms, null, "O 派发过却没有 work_spans → 未知,不当 0");
  assert.equal(p.parallel_avg, null); assert.equal(p.parallel_peak, null);
  assert.equal(p.stalled, null, "过去的区间不知道当时的心跳");
  assert.equal(p.model_ms, null, "上周账本那一行耗时未知"); assert.equal(p.cost_usd, 0.1);
  assert.equal(p.auto_accept_rate, 1); assert.equal(p.first_pass_rate, 1);
  assert.deepEqual([p.wait_human_ms_total, p.wait_human_ms_median, p.human_actions], [0, null, 0]);
  assert.deepEqual(p.unknown.sort(), ["ai_work_ms", "cycle_ms_median", "model_ms", "parallel_avg", "parallel_peak", "stalled", "wait_human_ms_median"]);
  nullsListed(p);

  assert.deepEqual(r.daily, [{ date: "2026-11-09", created: 0, done: 1 }, { date: "2026-11-10", created: 2, done: 3 }, { date: "2026-11-11", created: 1, done: 0 },
    ...[12, 13, 14, 15].map((d) => ({ date: `2026-11-${d}`, created: 0, done: 0 }))], "区间内还没到的日子也补 0");
  assert.equal(r.headline, "本周完成 4 张 · 打回 2 次 · AI 干了 10.3 小时 · 你操作 5 次 · 平均同时 1.3 条线在跑");
  assert.deepEqual(r.groups, []);
});

test("主句时长措辞:不到 1 分钟 / 整分钟(向下取整)/ 一位小数小时;面板与 board.py 都只读 headline", () => {
  assert.equal(E.aiSpan(0), " 0 分钟");
  assert.equal(E.aiSpan(59999), "不到 1 分钟");
  assert.equal(E.aiSpan(60000), " 1 分钟");
  assert.equal(E.aiSpan(53 * 60000 + 59000), " 53 分钟");
  assert.equal(E.aiSpan(H - 1), " 59 分钟", "不会写出 60 分钟");
  assert.equal(E.aiSpan(H), " 1.0 小时");
  assert.equal(E.aiSpan(10.26 * H), " 10.3 小时");
  const panel = readFileSync(join(ROOT, "core", "panel.html"), "utf8");
  assert.ok(!/AI 干了/.test(panel), "面板不另拼主句里的 AI 时长");
  const py = readFileSync(join(ROOT, "cli", "board.py"), "utf8");
  assert.ok(py.includes('print(d["headline"])') && !/AI 干了/.test(py), "board.py 原样打印 headline");
});

test("分解:按线、按运行时、按天、按周", (t) => {
  const { eff } = fixture(t);
  const line = eff.compute({ by: "line" }).groups;
  assert.deepEqual(line.map((g) => [g.key, g.label, g.done, g.handed_back, g.stalled, g.model_ms]),
    [["alpha", "开发", 2, 0, 1, H], ["beta", "beta", 2, 2, 0, H / 2]]);
  const rt = eff.compute({ by: "runtime" }).groups;
  assert.deepEqual(rt.map((g) => [g.key, g.done, g.handed_back]), [["claude", 2, 0], ["codex", 2, 2]], "C 按 task_runs 归 codex");
  const day = eff.compute({ by: "day" }).groups;
  assert.deepEqual(day.map((g) => [g.key, g.done, g.ai_work_ms]), [["2026-11-09", 1, 2 * H], ["2026-11-10", 3, 6.25 * H], ["2026-11-11", 0, 2 * H]]);
  assert.equal(day[0].stalled, null); assert.equal(day[2].stalled, 1, "只有包含现在的那一段数卡住");
  for (const g of day) nullsListed(g);
  const wk = eff.compute({ from: "2026-11-02", to: "2026-11-15", by: "week" });
  assert.deepEqual(wk.groups.map((g) => [g.key, g.done]), [["2026-11-02", 1], ["2026-11-09", 4]]);
  assert.equal(wk.headline.startsWith("本期完成 5 张"), true, wk.headline);
  assert.equal(wk.previous.from.slice(0, 10), "2026-10-19", "上期 = 紧邻的等长区间");
  assert.throws(() => eff.compute({ by: "model" }), /by 只能是/);
  assert.throws(() => eff.compute({ from: "2026-11-02" }), /一起给/);
  assert.throws(() => eff.compute({ from: "2026-11-09", to: "2026-11-02" }), /晚于/);
});

test("空区间:done=0、比率为 null 并列进 unknown;账本缺失 → 模型耗时 / 费用未知", (t) => {
  const { eff } = fixture(t, { ledgerRows: false });
  const r = eff.compute({ from: "2026-01-05", to: "2026-01-11" });
  const n = r.now;
  assert.deepEqual([n.done, n.handed_back, n.human_actions, n.ai_work_ms, n.parallel_peak, n.wait_human_ms_total], [0, 0, 0, 0, 0, 0]);
  for (const k of ["first_pass_rate", "auto_accept_rate", "lead_ms_median", "cycle_ms_median", "parallel_avg", "model_ms", "cost_usd", "stalled"])
    assert.ok(n[k] === null && n.unknown.includes(k), k);
  nullsListed(n);
  assert.equal(r.headline, "本期完成 0 张 · 打回 0 次 · AI 干了 0 分钟 · 你操作 0 次", "平均并行未知 → 那一段省略");
  assert.equal(r.daily.length, 7);
  const w = eff.compute();
  assert.deepEqual([w.now.model_ms, w.now.cost_usd], [null, null], "没有账本 = 未知,不是 0");
  assert.ok(w.now.unknown.includes("model_ms"));
});

test("区间上限(P5):by=day ≤92 天、by=week ≤2 年,超出 400 并说明;其余仍 ≤400 天", (t) => {
  const { eff } = fixture(t, { ledgerRows: false });
  const q = (s) => E.efficiencyHttp(eff, new URLSearchParams(s), "operator");
  assert.equal(q("from=2026-08-01&to=2026-10-31&by=day").status, 200, "整 92 天可以");
  const day = q("from=2026-08-01&to=2026-11-01&by=day");
  assert.equal(day.status, 400); assert.match(day.body.error, /by=day.*92 天/);
  assert.equal(q("from=2024-11-02&to=2026-11-01&by=week").status, 200, "整 2 年可以");
  const wk = q("from=2024-11-01&to=2026-11-02&by=week");
  assert.equal(wk.status, 400); assert.match(wk.body.error, /by=week.*2 年/);
  assert.equal(q("from=2025-11-01&to=2026-11-01&by=line").status, 200);
  assert.equal(q("from=2025-01-01&to=2026-11-01&by=line").status, 400, "line / runtime / 不分解仍是 400 天");
  assert.equal(q("from=2025-01-01&to=2026-11-01").status, 400);
});

test("daily 补齐区间内每一天;groups 里 key 为 null 的 label 是「未指定」", (t) => {
  const { eff, db } = fixture(t);
  const id = store.add(db, { subject: "卡", released: 1, actor: "operator" });
  db.prepare("UPDATE tasks SET line=NULL, last_runtime=NULL, status='done', created_at=?, updated_at=?, resolved_at=?, attempts=0 WHERE id=?")
    .run(iso(T(10, 8)), iso(T(10, 9)), iso(T(10, 9)), id);
  for (const by of ["line", "runtime"]) {
    const g = eff.compute({ by }).groups.find((x) => x.key === null);
    assert.ok(g, `${by}: 有 key=null 的组`); assert.equal(g.label, "未指定", by); assert.equal(g.done, 1);
  }
  const r = eff.compute({ from: "2026-11-01", to: "2026-11-30" });
  assert.equal(r.daily.length, 30, "11 月整月 30 天,包括还没到的日子");
  assert.deepEqual(r.daily.slice(-2), [{ date: "2026-11-29", created: 0, done: 0 }, { date: "2026-11-30", created: 0, done: 0 }]);
  assert.deepEqual(r.daily.map((d) => d.date), [...new Set(r.daily.map((d) => d.date))], "不重日");
});

test("缓存:同一事件水位与区间直接回同一份;新事件 / 卡变化 / 时间走过时间片就重算", (t) => {
  const { eff, ev, ids, setClock, db } = fixture(t);
  const a = eff.compute(), b = eff.compute();
  assert.equal(a, b, "热读命中缓存");
  ev(ids.D, T(11, 11), "reopen", "operator");
  const c = eff.compute();
  assert.notEqual(c, a); assert.equal(c.now.human_actions, 6);
  db.prepare("UPDATE tasks SET heartbeat_at=?, updated_at=? WHERE id=?").run(NOW, iso(NOW), ids.S);
  assert.equal(eff.compute().now.stalled, 0, "心跳更新(卡表签名变)即重算");
  setClock(NOW + 60000);
  assert.ok(eff.compute().now.ai_work_ms > c.now.ai_work_ms, "本期还开着:进行中的时段随时间变长");
});

test("卡住:外部执行者以 卡心跳 与 执行者最后一次请求(lastSeen)较晚者为准", (t) => {
  const { db, ids } = fixture(t);
  db.prepare("UPDATE tasks SET worker=? WHERE id=?").run("ext-z", ids.S);     // S 的卡心跳停在 10:05(已超时)
  let seen = null;
  const eff = E.createEfficiency({ db, lines: () => ["alpha", "beta"], clock: () => NOW, openTtlMs: 1,
                                   lastSeen: (w) => (w === "ext-z" ? seen : null) });
  assert.equal(eff.compute().now.stalled, 1, "没有执行者请求记录 → 只看卡心跳 → 卡住");
  seen = NOW - 60000;
  db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(iso(NOW - 1), ids.S);   // 换卡表签名,绕开缓存
  assert.equal(eff.compute().now.stalled, 0, "执行者 1 分钟前还在请求(桥在轮询)→ 不算卡住");
  seen = NOW - 30 * 60000;
  db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(iso(NOW - 2), ids.S);
  assert.equal(eff.compute().now.stalled, 1, "执行者也 30 分钟没动静 → 卡住");
});

test("鉴权:只给操作员;其余 403;坏参数 400", (t) => {
  const { eff } = fixture(t);
  const q = (s) => new URLSearchParams(s);
  assert.equal(E.efficiencyHttp(eff, q(""), "operator").status, 200);
  for (const role of ["worker", "review", "executor", null]) assert.equal(E.efficiencyHttp(eff, q(""), role).status, 403, String(role));
  assert.equal(E.efficiencyHttp(eff, q("by=x"), "operator").status, 400);
  assert.equal(E.efficiencyHttp(eff, q("from=昨天&to=今天"), "operator").status, 400);
});

test("性能:2000 张卡 / 2 万事件的冷算与热读", (t) => {
  const db = new DatabaseSync(":memory:"); store.migrate(db); t.after(() => db.close());
  const setTask = db.prepare("UPDATE tasks SET line=?, status=?, created_at=?, updated_at=?, resolved_at=?, work_spans=?, attempts=1 WHERE id=?");
  const insTask = { run: (...a) => { const id = store.add(db, { subject: "卡", released: 1, actor: "operator" }); setTask.run(...a, id); return { lastInsertRowid: id }; } };
  const insEv = db.prepare("INSERT INTO task_events (at, task_id, kind, actor, detail) VALUES (?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 2000; i++) {
    const s = T(1, 0) + i * 9 * 60000, e = s + 40 * 60000;
    const id = Number(insTask.run(i % 2 ? "alpha" : "beta", "done", iso(s - H), iso(e), iso(e + 60000), JSON.stringify([{ w: "alpha", s: iso(s), e: iso(e) }])).lastInsertRowid);
    for (let k = 0; k < 10; k++) {
      const kind = ["claim", "report", "resolve", "release", "set_line"][k % 5];
      insEv.run(iso(s + k * 1000), id, kind, kind === "resolve" || kind === "release" ? "human" : "alpha", JSON.stringify(kind === "resolve" ? { disposition: k < 5 ? "hand_back" : "close" } : kind === "report" ? { outcome: "done" } : kind === "release" ? { action: "release" } : {}));
    }
  }
  db.exec("COMMIT");
  const eff = E.createEfficiency({ db, clock: () => T(14, 0), lines: () => ["alpha", "beta"] });
  const time = (fn) => { const s = process.hrtime.bigint(); const v = fn(); return [Number(process.hrtime.bigint() - s) / 1e6, v]; };
  const range = { from: "2026-11-01", to: "2026-11-14", by: "day" };
  const [cold, r] = time(() => eff.compute(range));
  const [warm] = time(() => eff.compute(range));
  const [other] = time(() => eff.compute({ by: "line" }));
  console.log(`# 性能 2000 卡/20000 事件:冷算(建事件缓存 + by=day 13 段)${cold.toFixed(1)}ms;热读 ${warm.toFixed(2)}ms;换区间(事件缓存已热,by=line)${other.toFixed(1)}ms`);
  assert.equal(r.now.done + r.prev.done, 2000);
  assert.ok(cold < 5000 && warm < 50 && other < 3000, `${cold} / ${warm} / ${other}`);

  // P5 最坏情况:上限处的分段数(by=day 92 段、by=week 2 年 ≈105 段)与「每次换一个 from/to」。
  // 卡表快照只在数据变了时重读:换区间不重读卡表、不重扫事件。
  const loads0 = eff.stats().task_loads;
  const [d92] = time(() => eff.compute({ from: "2026-08-15", to: "2026-11-14", by: "day" }));
  const [w2y] = time(() => eff.compute({ from: "2024-11-15", to: "2026-11-14", by: "week" }));
  const [many] = time(() => { for (let i = 0; i < 20; i++) eff.compute({ from: `2026-0${1 + (i % 8)}-0${1 + (i % 9)}`, to: "2026-11-14", by: i % 2 ? "line" : null }); });
  console.log(`# P5 最坏:by=day 92 段 ${d92.toFixed(1)}ms;by=week 2 年 ${w2y.toFixed(1)}ms;20 个不同区间合计 ${many.toFixed(1)}ms`);
  assert.equal(eff.stats().task_loads, loads0, "换区间不重读卡表");
  assert.ok(eff.stats().event_scans <= 1, "事件只在建缓存时扫一遍");
  assert.ok(d92 < 3000 && w2y < 3000 && many < 6000, `${d92} / ${w2y} / ${many}`);
});

// ── 服务层:真看板上的鉴权与 board.py efficiency ───────────────────────────────────────

test("真看板:GET /api/efficiency 鉴权、形状;board.py efficiency 打印主句与对照表", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "efficiencytest-"));
  const repo = join(dir, "repo"), cfg = join(dir, "fleet.json");
  mkdirSync(repo, { recursive: true });
  writeFileSync(cfg, JSON.stringify({ lines: [{ id: "alpha", label: "开发" }, { id: "rev", role: { kind: "review" } }], roles: [], routes: ["default"], repo }));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: cfg, BOARD_DATA_DIR: dir, BOARD_DB: join(dir, "board.db"),
                BOARD_REPO: repo, BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit", BOARD_ALLOW_UNPINNED: "1",
                BOARD_COORDINATOR_CLI_ARGV: JSON.stringify([process.execPath, join(ROOT, "tests", "helpers", "fake-coordinator-cli.mjs")]) };
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
  let logs = ""; child.stdout.on("data", (v) => { logs += v; }); child.stderr.on("data", (v) => { logs += v; });
  const closed = new Promise((r) => child.once("close", r));
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
    const tok = (name) => readFileSync(join(dir, name), "utf8").trim();
    const get = async (path, t) => { const r = await fetch(base + path, { headers: t ? { "X-Board-Token": t } : {} }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
    const op = tok("board_token");
    const made = await fetch(base + "/api/tasks", { method: "POST", headers: { "X-Board-Token": op, "Content-Type": "application/json" }, body: JSON.stringify({ subject: "一张卡", line: "alpha" }) });
    assert.equal(made.status, 201);
    const ok = await get("/api/efficiency", op);
    assert.equal(ok.status, 200, JSON.stringify(ok.body) + logs.slice(-800));
    assert.deepEqual(Object.keys(ok.body).sort(), ["daily", "groups", "headline", "now", "period", "prev", "previous"]);
    assert.equal(ok.body.now.done, 0); assert.ok(ok.body.now.unknown.includes("first_pass_rate"));
    assert.ok(ok.body.daily.some((d) => d.created === 1), "今天新挂 1 张");
    for (const [t, code] of [[tok("worker_token"), 403], [tok("review_token"), 403], [null, 401]])
      assert.equal((await get("/api/efficiency", t)).status, code);
    assert.equal((await get("/api/efficiency?by=nope", op)).status, 400);
    assert.equal((await get("/api/efficiency?by=line&from=2026-11-01&to=2026-11-07", op)).status, 200);

    const cli = (...argv) => { const r = spawnSync(PY, [join(ROOT, "cli", "board.py"), ...argv], { encoding: "utf8", windowsHide: true, cwd: dir, timeout: 60000,
      env: { ...HOST_ENV, BOARD_URL: base, BOARD_DATA_DIR: dir, BOARD_CONFIG: cfg, PYTHONIOENCODING: "utf-8" } }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
    const out = cli("efficiency", "--by", "line");
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^本周完成 0 张 · 打回 0 次/);
    assert.match(out.out, /一次通过率\s+未知\s+未知/, "未知不当 0");
    assert.match(out.out, /逐日 新挂\/完成:/);
    const bad = cli("efficiency", "--by", "nope");
    assert.notEqual(bad.code, 0); assert.match(bad.out, /by 只能是/);
  } finally { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});
