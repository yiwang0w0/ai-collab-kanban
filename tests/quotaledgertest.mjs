import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 公告板 v3 合同 J2「账本与额度条」(9b):账本的 source / pool 两列(旧行推列、分组、各写入方)、池读数(权限矩阵、校验、
// 有效读数的取法、过期)、/api/home/quota 的 state / readings / ledger / runway、prefs quota_low_at、助手简报的池一行(不泄露)。
// `node --test tests/quotaledgertest.mjs`。不调用任何模型;读数全是用例里自造的数字。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openLedger, normalizeRow, poolMap, poolOfModel, sourceOf, SOURCES, GROUP_KEYS, localIso, usageHttp } from "../core/usage.mjs";
import { checkReading, effectiveReadings, stateOf, runwayOf, checkQuotaLowAt, ledgerOut, READING_FRESH_MS } from "../core/pool-readings.mjs";
import { quotaModel } from "../core/home-background.mjs";
import { briefPools } from "../core/brief.mjs";
import { freePort } from "./helpers/free-port.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PY = HOST_ENV.PYTHON || "python";
const NL = "\n";
const line = (o) => JSON.stringify(o) + NL;
const RUNTIMES = [{ id: "claude", models: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }] }, { id: "codex", models: [{ id: "gpt-5.6-sol" }] }];
const POOLS = poolMap(RUNTIMES);
const ERR = { BAD_INPUT: "BAD_INPUT" };
const err = (code, message) => Object.assign(new Error(message), { code });
const NOW = Date.parse("2026-11-14T12:00:00Z");
const ago = (min) => new Date(NOW - min * 60000).toISOString();

// ── 账本:旧行推列 · 写入方 · 分组 ─────────────────────────────────────────────────────────────
test("J2.1 旧形账本读出 source / pool;认不出的 source = ?、不丢行;reported_by 读时保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "quotaledger-old-")), file = join(dir, "usage_ledger.jsonl");
  try {
    const base = { ts: "2026-11-10T10:00:00", card: 1, calls: 1, in: 10, cc: 0, cr: 0, out: 1 };
    writeFileSync(file, [
      { ...base, worker: "alpha", model: "claude-opus-5", attempt: 1 },                                 // 最老的行:没有 phase → implement → managed
      { ...base, worker: "alpha@2", model: "gpt-5.6-sol", phase: "initial" },                             // → managed / codex
      { ...base, worker: "alpha", model: "claude-opus-5", phase: "repair" },                             // → managed(fix)
      { ...base, worker: "reviewer", model: "claude-sonnet-5", attempt: null },                         // 旧审阅行(无 phase)→ reviewer
      { ...base, worker: "decompose", model: "claude-opus-5", phase: "decompose" },
      { ...base, worker: "alpha", model: "claude-opus-5", phase: "compact" },
      { ...base, worker: "coordinator", model: "claude-opus-5", phase: "coord" },
      { ...base, worker: "agent-x", model: "local-llm", phase: "implement", reported_by: "external" },    // 外部自报 → external / other
      { ...base, worker: "alpha", model: "claude-opus-5", phase: "lunch" },                              // 认不出的阶段 → source ?
      { ...base, worker: "alpha", model: "claude-opus-5", phase: "implement", source: "bogus" },         // 写了认不出的 source → ?
      { ...base, worker: "alpha", model: "claude-opus-5", phase: "implement", source: "managed", pool: "zz" },   // 写了不认的池 → 按 model
      { ...base, worker: "alpha", model: "claude-opus-5", phase: "implement", source: "seat", pool: "other" },  // 写了 other 就是 other
    ].map(line).join(""), "utf8");
    const L = openLedger(file, { pools: POOLS });
    const key = (by) => Object.fromEntries(L.group(by).groups.map((g) => [g.key, g.rows]));
    assert.deepEqual(key("source"), { "?": 2, compact: 1, coordinator: 1, decompose: 1, external: 1, managed: 4, reviewer: 1, seat: 1 }, "12 行一行不丢");
    assert.deepEqual(key("pool"), { claude: 9, codex: 1, other: 2 });
    assert.equal(L.group("source").total.rows, 12);
    // 单行:reported_by 保留;没给对照时只认写进来的池名
    const ext = normalizeRow({ ...base, worker: "agent-x", model: "gpt-5.6-sol", reported_by: "external" }, POOLS);
    assert.deepEqual([ext.source, ext.pool, ext.reported_by], ["external", "codex", "external"]);
    assert.deepEqual([normalizeRow({ ...base, worker: "alpha", model: "claude-opus-5" }).pool, normalizeRow({ ...base, pool: "codex" }).pool], ["other", "codex"]);
    assert.equal(sourceOf({ worker: null }, "implement"), "?", "没有 worker 的实现行认不出来源");
    assert.deepEqual(GROUP_KEYS.slice(-2), ["source", "pool"]);
    assert.deepEqual(SOURCES, ["managed", "reviewer", "coordinator", "decompose", "compact", "external", "seat"]);
    assert.equal(poolOfModel("claude-haiku-4-5", POOLS), "other", "不在座席 models 表里 = other");
    // HTTP:by=source / by=pool 走同一个分组;by 写错仍 400(说明里列出新键)
    const http = (q) => usageHttp(L, "/api/usage", new URLSearchParams(q));
    assert.equal(JSON.parse(http("by=pool").body).groups.find((g) => g.key === "codex").rows, 1);
    assert.equal(JSON.parse(http("by=source").body).by, "source");
    const bad = http("by=runtime");
    assert.equal(bad.status, 400); assert.match(JSON.parse(bad.body).error, /source \| pool/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("J2.1 写入方补列:append 只写值域里的 source、按 model 补 pool;appendExternal 记 external;poolWindows 按池按窗合计", () => {
  const dir = mkdtempSync(join(tmpdir(), "quotaledger-write-")), file = join(dir, "usage_ledger.jsonl");
  try {
    const L = openLedger(file, { pools: POOLS });
    L.append({ phase: "decompose", source: "decompose", worker: "decompose", model: "claude-opus-5", in: 5 });
    L.append({ phase: "coord", source: "nonsense", worker: "coordinator", model: "gpt-5.6-sol" });
    L.appendExternal([{ model: "local-llm", in: 3, out: 1, cost_usd: 0.2 }], { task: { id: 4, attempts: 1, line: "ext" }, worker: "agent-x", runId: "r", outcome: "done" });
    const rows = readFileSync(file, "utf8").split(NL).filter(Boolean).map((s) => JSON.parse(s));
    assert.deepEqual(rows.map((r) => [r.source ?? "(无)", r.pool]), [["decompose", "claude"], ["(无)", "codex"], ["external", "other"]], "认不出的 source 不写,读时按 phase 推");
    assert.equal(L.group("source").groups.find((g) => g.key === "coordinator").rows, 1);
    // 近 5 小时 / 7 天:窗外的行不算;未知词元不当 0;一行都没有已知费用 = null
    const now = Date.now(), at = (h) => localIso(new Date(now - h * 3600e3));
    appendFileSync(file, [
      { ts: at(1), card: 9, worker: "alpha", phase: "implement", model: "claude-opus-5", in: 100, cc: 0, cr: 0, out: 50, cost_usd: 0.5 },
      { ts: at(2), card: 9, worker: "alpha", phase: "implement", model: "claude-opus-5", in: null, out: null },
      { ts: at(30), card: 9, worker: "alpha", phase: "fix", model: "claude-opus-5", in: 1000, out: 0 },
      { ts: at(24 * 8), card: 9, worker: "alpha", phase: "fix", model: "claude-opus-5", in: 99999 },
      { ts: at(3), card: 9, worker: "alpha@2", phase: "implement", model: "gpt-5.6-sol", in: null },
    ].map(line).join(""), "utf8");
    const w = L.poolWindows(now);
    const claude = w.get("claude"), codex = w.get("codex");
    // claude 5h:上面 decompose 的 5 + 一小时前的 150(两小时前那行词元未知,不当 0,但算一次调用);7d 再加 1000;8 天前的不算
    assert.deepEqual(claude.windows.map((x) => [x.label, x.tokens, x.usd, x.calls]), [["5h", 155, 0.5, 3], ["7d", 1155, 0.5, 4]]);
    assert.equal(claude.rate_per_h, 31);
    assert.deepEqual(codex.windows.map((x) => [x.label, x.tokens, x.usd, x.calls]), [["5h", null, null, 2], ["7d", null, null, 2]], "codex 只有未知词元 → null,不是 0");
    assert.equal(codex.rate_per_h, null);
    assert.deepEqual(ledgerOut(undefined).windows, [{ label: "5h", tokens: null, usd: null, calls: 0 }, { label: "7d", tokens: null, usd: null, calls: 0 }]);
    assert.deepEqual(ledgerOut(claude).excludes, ["bridge_executors_without_usage", "coordinator_seat", "desktop_sessions"]);
    assert.equal(ledgerOut(claude).coverage, "board_only");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("J2.1 Python 写入方:worker_loop 记 managed + 起线给的池,reviewer_loop 记 reviewer + 审阅座席的池", () => {
  const pydir = mkdtempSync(join(tmpdir(), "quotaledger-py-"));
  try {
    const py = spawnSync(PY, ["-I", "-B", "-X", "utf8", "-", ROOT, pydir], {
      cwd: ROOT, windowsHide: true, encoding: "utf8", timeout: 60000,
      env: { ...HOST_ENV, BOARD_CONFIG: join(pydir, "missing-config.json"), BOARD_REPO: pydir, BOARD_DATA_DIR: pydir,
             BOARD_VERIFY_REGISTRY: join(pydir, "missing-registry.json"), WORKER_RUNTIME: "codex", WORKER_MODEL: "gpt-5.6-sol",
             WORKER_EFFORT: "high", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
      input: [
        "import sys,pathlib,json",
        "folder=pathlib.Path(sys.argv[2])",
        "sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))",
        "import worker_loop as w",
        "w.log=lambda *a:None; w.API_MODE=False; w.PROFILE_MODE=False; w.LEDGER=str(folder/'ledger.jsonl')",
        "w.LAST_ACCT={'sid':'s-1','t0':None,'usage':{'calls':1,'in':5,'cc':0,'cr':0,'out':5}}",
        "a=w.acct_attempt({'id':7,'run_id':'r-7'},'alpha@2',1,'gpt-5.6-sol','high')",
        "import reviewer_loop as r",
        "r.log=lambda *a:None; r.LEDGER=w.LEDGER; r.MODEL='gpt-5.6-sol'",
        "b=r.acct_review({'id':7,'line':'alpha'},None,duration_ms=10)",
        "print(json.dumps({'a':a,'b':b,'ledger':w.LEDGER}))",
      ].join(NL),
    });
    assert.equal(py.status, 0, py.stdout + NL + py.stderr);
    const out = JSON.parse(py.stdout.trim().split(NL).pop());
    assert.deepEqual([out.a.source, out.a.pool, out.b.source, out.b.pool], ["managed", "codex", "reviewer", "codex"]);
    const L = openLedger(out.ledger, { pools: POOLS });
    assert.deepEqual(L.group("source").groups.map((g) => [g.key, g.rows]), [["managed", 1], ["reviewer", 1]]);
    assert.deepEqual(L.group("pool").groups.map((g) => [g.key, g.rows]), [["codex", 2]]);
  } finally { rmSync(pydir, { recursive: true, force: true }); }
});

// ── 池读数:校验 · 有效读数 · 状态 · 推算 ──────────────────────────────────────────────────────
test("J2.2 读数校验:pool 只认配置的 runtime id 或 other;window ≤16 单行;used_pct 0–100;resets_at 合法且不早于现在 10 分钟;note ≤80", () => {
  const ck = (b) => checkReading(b, { poolIds: ["claude", "codex"], now: NOW, clean: (s) => s.replace(/C:\\\S+/g, "…"), err, ERR });
  assert.deepEqual(ck({ pool: "claude", window: " 5h ", used_pct: 41.66 }), { pool: "claude", window: "5h", used_pct: 41.7, resets_at: null, note: null });
  assert.equal(ck({ pool: "other", window: "7d", used_pct: 0, resets_at: "2026-11-14T11:55:00Z" }).resets_at, "2026-11-14T11:55:00.000Z", "早 5 分钟内可以");
  assert.equal(ck({ pool: "codex", window: "7d", used_pct: 100, note: "看 C:\\Users\\you\\x 页面" }).note, "看 … 页面", "note 过脱敏");
  for (const b of [null, [], { pool: "zcode", window: "5h", used_pct: 1 }, { pool: "claude", window: "", used_pct: 1 },
    { pool: "claude", window: "x".repeat(17), used_pct: 1 }, { pool: "claude", window: "5h\n", used_pct: 1 }, { pool: "claude", window: "5h", used_pct: -1 },
    { pool: "claude", window: "5h", used_pct: 100.1 }, { pool: "claude", window: "5h", used_pct: "40" }, { pool: "claude", window: "5h", used_pct: NaN },
    { pool: "claude", window: "5h", used_pct: 1, resets_at: "明天" }, { pool: "claude", window: "5h", used_pct: 1, resets_at: "2026-11-14T11:49:00Z" },
    { pool: "claude", window: "5h", used_pct: 1, resets_at: "2027-01-01T00:00:00Z" }, { pool: "claude", window: "5h", used_pct: 1, note: "x".repeat(81) },
    { pool: "claude", window: "5h", used_pct: 1, note: "a\u2028b" }, { pool: "claude", window: "5h", used_pct: 1, by_role: "operator" }])
    assert.throws(() => ck(b), { code: "BAD_INPUT" }, JSON.stringify(b));
  assert.deepEqual([checkQuotaLowAt(50), checkQuotaLowAt(99), checkQuotaLowAt(49), checkQuotaLowAt(100), checkQuotaLowAt(90.5), checkQuotaLowAt("90")], [true, true, false, false, false, false]);
});

test("J2.2 有效读数:每〔池, 窗〕最新一条;60 分钟内操作者压过执行者;超过 60 分钟 stale", () => {
  const r = (id, window, pct, role, min) => ({ id, pool: "claude", window, used_pct: pct, resets_at: null, by_role: role, by_id: role === "executor" ? "x" : null, at: ago(min) });
  const rows = [r(1, "5h", 30, "operator", 50), r(2, "5h", 70, "executor", 5),        // 操作者 50 分钟前 vs 执行者 5 分钟前 → 操作者
                r(3, "7d", 10, "operator", 61), r(4, "7d", 20, "executor", 30),       // 操作者已过 60 分钟 → 执行者的最新
                r(5, "1h", 5, "executor", 90)];                                       // 只有一条且过期
  const eff = Object.fromEntries(effectiveReadings(rows, NOW).map((e) => [e.window, [e.row.id, e.stale]]));
  assert.deepEqual(eff, { "5h": [1, false], "7d": [4, false], "1h": [5, true] });
  assert.deepEqual(effectiveReadings([r(1, "5h", 30, "executor", 10), r(2, "5h", 40, "executor", 2)], NOW).map((e) => e.row.id), [2], "同为执行者取最新");
  assert.equal(READING_FRESH_MS, 3600000);
});

test("J2.3 state:down 只认限流记录;low / ok 只来自新鲜读数(≥ quota_low_at = low);没有新鲜读数 = unknown", () => {
  const e = (pct, stale = false) => ({ window: "5h", row: { used_pct: pct }, stale });
  assert.equal(stateOf({ down: true, effective: [e(1)] }), "down", "读数再低也不清 down");
  assert.equal(stateOf({ effective: [e(89.9)] }), "ok");
  assert.equal(stateOf({ effective: [e(90)] }), "low", "默认低位线 90");
  assert.equal(stateOf({ effective: [e(60)], lowAt: 60 }), "low");
  assert.equal(stateOf({ effective: [e(99, true)] }), "unknown", "过期读数不算");
  assert.equal(stateOf({ effective: [e(99, true), e(10)] }), "ok", "新鲜的那一窗说了算;过期的 99 不让它变 low");
  assert.equal(stateOf({ effective: [] }), "unknown");
});

test("J2.3 runway:同一窗最近两次读数的斜率推到 100%;不足两次、斜率 ≤ 0、较新的一次过期 = unknown;多窗取最短", () => {
  const r = (id, window, pct, min) => ({ id, window, used_pct: pct, by_role: "executor", at: ago(min) });
  assert.deepEqual(runwayOf([], NOW), { basis: "unknown", minutes: null });
  assert.deepEqual(runwayOf([r(1, "5h", 40, 10)], NOW), { basis: "unknown", minutes: null }, "只有一次");
  assert.deepEqual(runwayOf([r(1, "5h", 40, 30), r(2, "5h", 40, 10)], NOW), { basis: "unknown", minutes: null }, "斜率 0");
  assert.deepEqual(runwayOf([r(1, "5h", 50, 30), r(2, "5h", 40, 10)], NOW), { basis: "unknown", minutes: null }, "斜率 < 0(重置过)");
  assert.deepEqual(runwayOf([r(1, "5h", 20, 200), r(2, "5h", 40, 100)], NOW), { basis: "unknown", minutes: null }, "较新那次已过期");
  // 20 分钟涨 10 个点 → 0.5 点/分;从 10 分钟前的 60% 到 100% 要 80 分钟,还剩 70
  assert.deepEqual(runwayOf([r(1, "5h", 50, 30), r(2, "5h", 60, 10)], NOW), { basis: "projected", minutes: 70 });
  assert.deepEqual(runwayOf([r(1, "5h", 50, 30), r(2, "5h", 60, 10), r(3, "7d", 10, 40), r(4, "7d", 90, 20)], NOW).minutes, 0, "7d 那窗推出来已经到顶:取最短,下限 0");
  assert.deepEqual(runwayOf([r(1, "5h", 10, 99), r(2, "5h", 50, 30), r(3, "5h", 60, 10)], NOW), { basis: "projected", minutes: 70 }, "只取最近两次");
});

test("J2.3 quotaModel:给了 readings / ledger 才出新字段;旧调用方的输出不变;other 池只有 ledger", () => {
  const legacy = quotaModel({ now: NOW, pools: [{ id: "claude", label: "Claude", exhausted_at: null, until: null }] });
  assert.deepEqual(Object.keys(legacy.pools[0]), ["id", "label", "windows", "state", "runway"]);
  const rows = [{ id: 1, window: "5h", used_pct: 50, resets_at: "2026-11-14T15:00:00.000Z", by_role: "operator", by_id: null, at: ago(30) },
                { id: 2, window: "5h", used_pct: 60, resets_at: null, by_role: "executor", by_id: "x", at: ago(10) },
                { id: 3, window: "7d", used_pct: 95, resets_at: null, by_role: "executor", by_id: "x", at: ago(120) }];
  const q = quotaModel({ now: NOW, labelOf: (r) => (r.by_role === "operator" ? "你" : "对方"), pools: [
    { id: "claude", label: "Claude", exhausted_at: null, until: null, readings: rows, ledger: null },
    { id: "codex", label: "Codex", exhausted_at: ago(5), until: ago(-295), readings: rows, ledger: null },
    { id: "other", label: "其他", readings: [], ledger: { windows: [{ label: "5h", tokens: 7, usd: null, calls: 1 }], rate_per_h: 1 } }] });
  const [c, x, o] = q.pools;
  assert.equal(c.state, "ok", "7d 的 95% 已过期,不让它变 low");
  assert.deepEqual(c.windows, [{ label: "5h", used_pct: 50, resets_at: "2026-11-14T15:00:00.000Z" }], "旧字段 windows = 新鲜读数(操作者那条压过执行者)");
  assert.deepEqual(c.readings, [{ window: "5h", used_pct: 50, resets_at: "2026-11-14T15:00:00.000Z", by: "operator", by_label: "你", at: ago(30), stale: false },
                                { window: "7d", used_pct: 95, resets_at: null, by: "executor", by_label: "对方", at: ago(120), stale: true }]);
  assert.deepEqual(c.runway, { basis: "projected", minutes: 70 }, "推算用最近两次(不分谁报的)");
  assert.deepEqual([x.state, x.windows[0].label, x.runway.basis], ["down", "看板暂停到", "unknown"], "down 时读数照列,state 仍是 down");
  assert.equal(x.readings.length, 2);
  assert.deepEqual([o.state, o.readings, o.ledger.windows[0].tokens, o.ledger.windows[1].calls, o.ledger.rate_per_h], ["unknown", [], 7, 0, 1]);
  assert.ok(!("total" in q), "不合成一个数");
});

test("J2.4 助手简报的池一行:state + 最新新鲜读数百分比;不带 by_label、note、模型、会话", () => {
  const quota = { pools: [
    { id: "claude", label: "Claude", state: "low", readings: [{ window: "5h", used_pct: 91.4, by: "executor", by_label: "agent-secret-name", at: ago(5), stale: false, note: "note-secret" },
                                                          { window: "7d", used_pct: 40, by: "operator", by_label: "你", at: ago(20), stale: false }],
      ledger: { windows: [{ label: "5h", tokens: 123456, usd: 1, calls: 3 }] }, model: "claude-opus-5" },
    { id: "codex", label: "Codex", state: "unknown", readings: [{ window: "7d", used_pct: 77, by: "executor", by_label: "x", at: ago(200), stale: true }] },
    { id: "other", label: "其他", state: "bogus", readings: [] }] };
  const p = briefPools(quota);
  assert.deepEqual(p.map((x) => [x.pool, x.state, x.window, x.used_pct, x.line]),
    [["claude", "low", "5h", 91, "Claude:偏低 · 5h 91%"], ["codex", "unknown", null, null, "Codex:待核实"], ["other", "unknown", null, null, "其他:待核实"]]);
  const text = JSON.stringify(p);
  for (const leak of ["agent-secret-name", "note-secret", "claude-opus-5", "123456", "by_label", "session"]) assert.ok(!text.includes(leak), `不泄露 ${leak}`);
  assert.deepEqual(briefPools(null), []);
});

// ── 真看板:权限矩阵 · 四种状态 · 账本分组 · 简报 ───────────────────────────────────────────────
async function board() {
  const dir = mkdtempSync(join(tmpdir(), "quotaledgertest-")), cfg = join(dir, "fleet.json"), repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(cfg, JSON.stringify({ lines: [{ id: "alpha" }, { id: "ext", external: true }], roles: [], routes: ["default"], repo }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: cfg, BOARD_DATA_DIR: dir, BOARD_DB: join(dir, "board.db"),
           BOARD_REPO: repo, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit", BOARD_DELIVERABLE_GATE: "off" } });
  let logs = ""; const add = (v) => { logs = (logs + String(v)).slice(-20000); };
  child.stdout.on("data", add); child.stderr.on("data", add);
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  const tok = (n) => readFileSync(join(dir, n), "utf8").trim();
  const operator = tok("board_token");
  const redeem = async (body) => {
    const c = await api("POST", "/api/connect/codes", operator, body);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await api("POST", "/api/connect/redeem", null, { code: c.body.code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, tok, redeem, stop, logs: () => logs, ledger: join(dir, "usage_ledger.jsonl") };
}

test("J2 真看板:读数权限矩阵、额度接口四种状态、prefs quota_low_at、账本分组、外部自报带列、简报池一行", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const O = B.operator;
    const reg = await B.api("POST", "/api/coord/executors", O, { id: "agent-x", name: "agent-x", kind: "external" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const X = reg.body.token;                                                                 // 用令牌直接登记的执行者(不绑线)
    const bound = await B.redeem({ kind: "codex", line: "ext", label: "外部甲" });              // 凭码接入、绑线的执行者
    const asst = await B.redeem({ kind: "claude", role: "assistant" });
    const W = B.tok("worker_token"), R = B.tok("review_token");

    // ── 初始:没有读数 = unknown(旧字段形状不变);other 池没有行就不列
    let q = (await B.api("GET", "/api/home/quota", O)).body;
    assert.deepEqual(Object.keys(q).sort(), ["generated_at", "pools"]);
    assert.deepEqual(q.pools.map((p) => [p.id, p.state, p.windows[0].used_pct, p.runway.basis]), [["claude", "unknown", null, "unknown"], ["codex", "unknown", null, "unknown"]]);
    assert.deepEqual(q.pools[0].ledger.windows.map((w) => [w.label, w.tokens, w.calls]), [["5h", null, 0], ["7d", null, 0]]);
    assert.equal(q.pools[0].ledger.coverage, "board_only");

    // ── 权限矩阵:操作者 / 执行者 / 绑线执行者可写;助手、worker 令牌、审阅令牌 403;没令牌 401
    const reading = (pct, window = "5h", pool = "claude") => ({ pool, window, used_pct: pct });
    const w1 = await B.api("POST", "/api/pools/reading", X, reading(40));
    assert.equal(w1.status, 201, JSON.stringify(w1.body));
    assert.deepEqual([w1.body.reading.by, w1.body.pool.state], ["executor", "ok"]);
    assert.equal((await B.api("POST", "/api/pools/reading", bound.token, reading(10, "7d", "codex"))).status, 201, "绑线执行者也可写");
    for (const [who, t] of [["助手", asst.token], ["worker 令牌", W], ["审阅令牌", R]]) {
      const r = await B.api("POST", "/api/pools/reading", t, reading(1, "1h"));
      assert.equal(r.status, 403, `${who} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal((await B.api("POST", "/api/pools/reading", null, reading(1, "1h"))).status, 401);
    assert.equal((await B.api("POST", "/api/pools/reading", X, reading(41))).status, 429, "同一写入方同一〔池, 窗〕10 秒内只收一条");
    assert.equal((await B.api("POST", "/api/pools/reading", X, { pool: "zcode", window: "5h", used_pct: 1 })).status, 400);
    assert.equal((await B.api("POST", "/api/pools/reading", X, { pool: "claude", window: "5h", used_pct: 101 })).status, 400);
    // 只有操作者能列读数;绑线执行者的读被 404(F2),别的 403
    for (const [who, t, want] of [["执行者", X, 403], ["绑线执行者", bound.token, 404], ["助手", asst.token, 403], ["worker", W, 403], ["审阅", R, 403]])
      assert.equal((await B.api("GET", "/api/pools/readings", t)).status, want, who);

    // ── ok → low(操作者的读数压过执行者的)→ 改低位线 → down(限流记录)
    const op = await B.api("POST", "/api/pools/reading", O, { pool: "claude", window: "5h", used_pct: 92, resets_at: new Date(Date.now() + 3600e3).toISOString(), note: "看了 C:\\Users\\example\\fixture-hidden-dir\\deep\\x 页面" });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    q = (await B.api("GET", "/api/home/quota", O)).body;
    let c = q.pools.find((p) => p.id === "claude");
    assert.equal(c.state, "low");
    assert.deepEqual(c.readings.map((r) => [r.window, r.used_pct, r.by, r.by_label, r.stale]), [["5h", 92, "operator", "你", false]]);
    assert.deepEqual(c.windows.map((w) => [w.label, w.used_pct]), [["5h", 92]], "面板在读的旧字段跟着有值");
    assert.ok(!JSON.stringify(q).includes("fixture-hidden-dir"), "note 不进额度接口");
    const list = (await B.api("GET", "/api/pools/readings", O)).body.readings;
    assert.deepEqual(list.map((r) => [r.pool, r.window, r.by, r.by_label]), [["claude", "5h", "operator", "你"], ["codex", "7d", "executor", "外部甲"], ["claude", "5h", "executor", "agent-x"]]);
    assert.ok(!list[0].note.includes("fixture-hidden-dir"), "note 过脱敏:" + list[0].note);
    // prefs:默认 90,PUT 50–99;改到 95 → 92% 变 ok
    assert.equal((await B.api("GET", "/api/home/prefs", O)).body.quota_low_at, 90);
    for (const bad of [49, 100, 90.5, "95", null]) assert.equal((await B.api("PUT", "/api/home/prefs", O, { quota_low_at: bad })).status, 400, JSON.stringify(bad));
    for (const t of [X, asst.token, W, R]) assert.equal((await B.api("PUT", "/api/home/prefs", t, { quota_low_at: 95 })).status, 403);
    assert.deepEqual((await B.api("PUT", "/api/home/prefs", O, { quota_low_at: 95 })).body, { autostart: false, stuck_after: 3, quota_low_at: 95, bulk_lines: [] });
    assert.equal((await B.api("GET", "/api/home/quota", O)).body.pools.find((p) => p.id === "claude").state, "ok");
    // codex:有新鲜读数是 ok;记了限流 = down(读数照列)
    assert.equal((await B.api("GET", "/api/home/quota", O)).body.pools.find((p) => p.id === "codex").state, "ok");
    assert.equal((await B.api("POST", "/api/pools/exhausted", O, { runtime: "codex" })).status, 200);
    q = (await B.api("GET", "/api/home/quota", O)).body;
    const cx = q.pools.find((p) => p.id === "codex");
    assert.deepEqual([cx.state, cx.windows[0].label, cx.readings.length], ["down", "看板暂停到", 1]);
    assert.ok(Date.parse(cx.windows[0].resets_at) > Date.now());
    // 读数是只追加表:库里改不了、删不了
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(B.dir, "board.db"));
    try {
      assert.throws(() => db.exec("UPDATE pool_readings SET used_pct=0"), /append-only/);
      assert.throws(() => db.exec("DELETE FROM pool_readings"), /append-only/);
    } finally { db.close(); }

    // ── 账本:外部执行者交付自报 → source external、pool 按 model;按 source / pool 分组;额度接口的 ledger 有数
    const card = await B.api("POST", "/api/tasks", O, { subject: "外部自报", line: "alpha" });
    const id = card.body.task.id;
    const claim = await B.api("POST", `/api/tasks/${id}/claim`, X, { expected_version: card.body.task.aggregate_version });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    const rep = await B.api("POST", `/api/tasks/${id}/report`, X, { run_id: claim.body.task.run_id, outcome: "done", evidence: "交付说明",
      usage: [{ model: "claude-sonnet-5", in: 100, out: 20, cost_usd: 0.1 }, { model: "local-llm", in: 7 }] });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    appendFileSync(B.ledger, line({ ts: localIso(), card: id, worker: "alpha", model: "gpt-5.6-sol", phase: "initial", in: 30, cc: 0, cr: 0, out: 3 }), "utf8");   // 旧形一行
    const mine = readFileSync(B.ledger, "utf8").split(NL).filter(Boolean).map((s) => JSON.parse(s)).filter((j) => j.reported_by === "external");
    assert.deepEqual(mine.map((j) => [j.source, j.pool]), [["external", "claude"], ["external", "other"]]);
    const by = async (k) => Object.fromEntries((await B.api("GET", `/api/usage?by=${k}`, O)).body.groups.map((g) => [g.key, g.rows]));
    assert.deepEqual(await by("source"), { external: 2, managed: 1 });
    assert.deepEqual(await by("pool"), { claude: 1, codex: 1, other: 1 });
    q = (await B.api("GET", "/api/home/quota", O)).body;
    assert.deepEqual(q.pools.map((p) => p.id), ["claude", "codex", "other"], "账本里有 other 的行 → other 池列出来");
    const other = q.pools.find((p) => p.id === "other");
    assert.deepEqual([other.state, other.label, other.readings, other.ledger.windows[0].tokens], ["unknown", "其他", [], 7]);
    assert.deepEqual(q.pools.find((p) => p.id === "claude").ledger.windows.map((w) => [w.label, w.tokens, w.usd, w.calls]), [["5h", 120, 0.1, 1], ["7d", 120, 0.1, 1]]);

    // ── 助手简报:每池一行;不带 by_label、note、模型
    const brief = (await B.api("GET", "/api/brief", asst.token)).body;
    assert.deepEqual(brief.pools.map((p) => [p.pool, p.state, p.used_pct]), [["claude", "ok", 92], ["codex", "down", 10], ["other", "unknown", null]]);
    const text = JSON.stringify(brief.pools);
    for (const leak of ["外部甲", "agent-x", "fixture-hidden-dir", "claude-sonnet-5", "local-llm", "by_label"]) assert.ok(!text.includes(leak), `简报不泄露 ${leak}`);
    assert.equal((await B.api("GET", "/api/home/quota", asst.token)).status, 403, "助手读不到额度接口全文");
  } catch (e) { e.message += "\n" + B.logs().slice(-3000); throw e; }
  finally { await B.stop(); }
});

// ── 联合用例(9c 的真 stdio 桥 × 9b 的接口):report_pool → POST /api/pools/reading → 额度接口;report_result.usage → 账本 source / pool ──
function stdioBridge(args) {
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
  const call = async (name, a) => (await request("tools/call", { name, arguments: a })).result.structuredContent;
  const end = async () => { child.stdin.end(); await new Promise((r) => child.once("close", r)); };
  return { request, send, call, end };
}

test("J2 × J3 联合:真桥 report_pool 记成执行者读数、额度接口跟着变;真桥 report_result.usage 入账带 source=external 与按模型归的池", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.redeem({ kind: "claude", line: "ext", label: "桌面甲" });
    const tokenFile = join(B.dir, "bridge.token"); writeFileSync(tokenFile, X.token + "\n");
    const M = stdioBridge(["--url", B.base, "--token-file", tokenFile, "--line", "ext"]);
    try {
      assert.ok((await M.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } })).result);
      M.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      // report_pool:桥照 J2.2 的正文形转给看板;看板记成执行者读数(by_label = 登记名)
      const r = await M.call("report_pool", { pool: "codex", window: "7d", used_pct: 93.5, note: "fixture note" });
      assert.ok(!r.code, JSON.stringify(r));
      let q = (await B.api("GET", "/api/home/quota", B.operator)).body;
      const cx = q.pools.find((p) => p.id === "codex");
      assert.deepEqual([cx.state, cx.readings.map((x) => [x.window, x.used_pct, x.by, x.by_label])], ["low", [["7d", 93.5, "executor", "桌面甲"]]]);
      const bad = await M.call("report_pool", { pool: "zcode", window: "7d", used_pct: 1 });
      assert.ok(bad.code, "看板拒收的池名桥要明示:" + JSON.stringify(bad));
      // report_result.usage:走 appendExternal → source external,pool 按模型归(座席 models 表里有的归该池,没有的 other)
      // 桥的 usage 是单个对象:两张卡各交一次(一个认得的模型、一个认不出的模型)
      const deliver = async (subject, usage) => {
        const c = await B.api("POST", "/api/tasks", B.operator, { subject, line: "ext", description: "卡面", acceptance: "一句" });
        assert.equal(c.status, 201, JSON.stringify(c.body));
        const g = await M.call("get_card", { id: c.body.task.id });
        assert.ok(!(await M.call("claim_card", { id: c.body.task.id, expected_version: g.card.aggregate_version })).code);
        const rep = await M.call("report_result", { id: c.body.task.id, outcome: "done", evidence: "交付", usage });
        assert.equal(rep.usage_recorded, 1, JSON.stringify(rep));
        return c.body.task.id;
      };
      const ids = [await deliver("联合:桥自报用量 甲", { model: "gpt-5.6-sol", in: 40, out: 4 }), await deliver("联合:桥自报用量 乙", { model: "fixture-unknown-model", in: 9 })];
      const rows = readFileSync(B.ledger, "utf8").split(NL).filter(Boolean).map((x) => JSON.parse(x)).filter((x) => ids.includes(x.card));
      assert.deepEqual(rows.map((x) => [x.source, x.pool, x.reported_by]), [["external", "codex", "external"], ["external", "other", "external"]], "模型认不出 → other");
      q = (await B.api("GET", "/api/home/quota", B.operator)).body;
      assert.deepEqual(q.pools.find((p) => p.id === "codex").ledger.windows.map((w) => [w.label, w.tokens, w.calls]), [["5h", 44, 1], ["7d", 44, 1]]);
      const by = (await B.api("GET", "/api/usage?by=source", B.operator)).body.groups.map((x) => [x.key, x.rows]);
      assert.deepEqual(by, [["external", 2]]);
      // 助手令牌、worker 令牌(座席派生令牌走同一个 worker 角色分支)写读数被拒;被拒的不改额度接口
      const asst = await B.redeem({ kind: "claude", role: "assistant" });
      for (const [who, t] of [["助手", asst.token], ["worker", B.tok("worker_token")]])
        assert.equal((await B.api("POST", "/api/pools/reading", t, { pool: "claude", window: "5h", used_pct: 99 })).status, 403, who);
      assert.equal((await B.api("GET", "/api/home/quota", B.operator)).body.pools.find((p) => p.id === "claude").state, "unknown", "被拒的读数没落下");
    } finally { await M.end(); }
  } finally { await B.stop(); }
});
