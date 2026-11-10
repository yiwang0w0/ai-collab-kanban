import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 卡片用量结算:账本旧行兼容、分组与导出、结算事件、未知值与外部自报。
// `node --test tests/usagetest.mjs`。模型一律不调用:用量行由用例直接写进临时账本。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { openLedger, usageHttp, groupsCsv, parseTime, externalRows, fromClaudeResult, append } from "../core/usage.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PY = HOST_ENV.PYTHON || "python";
const NL = "\n";
const line = (object) => JSON.stringify(object) + NL;
const old = (card, extra = {}) => line({ ts: "2026-09-02T10:00:00", card, attempt: 1, worker: "alpha",
  model: "claude-opus-5", effort: "high", sid: "t", calls: 1, in: 1000, cc: 50, cr: 200000, out: 300, note: null, ...extra });
const parse = (file) => readFileSync(file, "utf8").split(NL).filter(Boolean).map((s) => JSON.parse(s));

async function board() {
  const dir = mkdtempSync(join(tmpdir(), "usagetest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines: [{ id: "alpha" }, { id: "ext", external: true }], roles: [], routes: ["default"], repo: dir }));
  const l = createServer(); await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const port = l.address().port; await new Promise((r) => l.close(r));
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit",
           BOARD_DELIVERABLE_GATE: "off" } });   // 临时目录不是 git 仓,交付物闸测不了;与结算无关,显式关掉
  let logs = ""; const add = (v) => { logs = (logs + String(v)).slice(-20000); };
  child.stdout.on("data", add); child.stderr.on("data", add);
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  const raw = (method, path, token, body) => fetch(base + path, { method,
    headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
  const api = async (method, path, token, body) => {
    const r = await raw(method, path, token, body);
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const operator = readFileSync(join(dir, "board_token"), "utf8").trim();
  const ledger = join(dir, "usage_ledger.jsonl");
  const task = async (id) => (await api("GET", `/api/tasks/${id}`, operator)).body.task;
  const card = async (subject) => {
    const r = await api("POST", "/api/tasks", operator, { subject, line: "alpha" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task;
  };
  const register = async (id) => {
    const r = await api("POST", "/api/coord/executors", operator, { id, name: id, kind: "external" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.token;
  };
  const take = async (token, id) => {
    const r = await api("POST", `/api/tasks/${id}/claim`, token, { expected_version: (await task(id)).aggregate_version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.task;
  };
  const approve = async (id) => {
    const r = await api("POST", `/api/tasks/${id}/resolve`, operator, { verdict: "approve", resolved_by: "human", expected_version: (await task(id)).aggregate_version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.task.status, "done", JSON.stringify(r.body.task));
    return r.body.task;
  };
  const settlements = (id) => (existsSync(ledger) ? parse(ledger) : []).filter((j) => j.event === "settlement" && j.settled_card === id);
  const cli = (...argv) => {
    const r = spawnSync(PY, [join(ROOT, "cli", "board.py"), ...argv], { encoding: "utf8", windowsHide: true, cwd: dir, timeout: 60000,
      env: { ...HOST_ENV, BOARD_URL: base, BOARD_DATA_DIR: dir, BOARD_CONFIG: config, PYTHONIOENCODING: "utf-8" } });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, raw, api, operator, ledger, task, card, register, take, approve, settlements, cli, stop, logs: () => logs };
}

test("旧行照常可读;按卡、线、模型、阶段分组,支持时间范围与 CSV", () => {
  const dir = mkdtempSync(join(tmpdir(), "usagetest-fold-")), file = join(dir, "usage_ledger.jsonl");
  try {
    writeFileSync(file,
      old(1) + old(1, { in: 500, out: 100 })                                         // 旧行:同一次尝试两轮
      + old(2, { worker: "alpha@2", model: "gpt-5.6-sol", ts: "2026-09-03T09:00:00" })
      + line({ ts: "t", event: "compact", worker: "alpha", before: 9 }) + "{broken json" + NL
      + old(3, { run_id: "r1", round: 1, phase: "initial", reason: "test_failure", ts: "2026-09-04T08:00:00" })   // #13 的写法
      + old(3, { run_id: "r1", round: 2, phase: "repair", reason: "passed", ts: "2026-09-04T08:05:00" })
      + old(3, { worker: "reviewer", attempt: null, ts: "2026-09-04T09:00:00", in: 70, out: 7, cc: null, cr: 10 })   // 旧的审阅行:没有 phase
      + line({ ts: "2026-09-05T00:00:00", card: 3, attempt: null, worker: "reviewer", line: "review", model: "claude-opus-5", effort: "high",
               calls: 2, in: 10, cc: 0, cr: 0, out: 5, phase: "review", duration_ms: 1500, cost_usd: 0.25, cost_source: "reported", cli_version: "2.1.300" }),
      "utf8");
    const L = openLedger(file);

    // 面板在用的旧形状:数值与改造前一致;审阅用量记到被审的卡上,但不算一次尝试。
    const cards = L.cards();
    assert.deepEqual(Object.keys(cards), ["1", "2", "3"], "压缩印与坏行不产生卡");
    assert.deepEqual({ ...cards["1"] }, { rows: 2, calls: 2, in: 1500, cc: 100, cr: 400000, out: 400, rounds: 2, attempts: 1 });
    assert.equal(cards["3"].rows, 2); assert.equal(cards["3"].attempts, 1); assert.equal(cards["3"].in, 2080);
    assert.equal(cards["3"].cc, null, "有一行缓存写未知 ⇒ 卡面该项未知,不是把未知当 0 加出来的 100");
    assert.deepEqual(L.stats().broken, 1); assert.equal(L.stats().events, 1);

    const key = (g) => Object.fromEntries(g.groups.map((x) => [x.key, x]));
    const phase = key(L.group("phase"));
    assert.deepEqual(Object.keys(phase).sort(), ["fix", "implement", "review"], "initial→implement,repair→fix,无 phase 的审阅行→review");
    assert.equal(phase.implement.rows, 4); assert.equal(phase.implement.attempts, 3);
    assert.equal(phase.fix.rows, 1); assert.equal(phase.fix.in, 1000);
    assert.deepEqual([phase.review.rows, phase.review.attempts, phase.review.calls, phase.review.in], [2, 0, 3, 80]);
    const byLine = key(L.group("line"));
    assert.deepEqual([byLine.alpha.rows, byLine.review.rows], [5, 2], "alpha@2 归入 alpha,审阅座席归入 review");
    const model = key(L.group("model"));
    assert.deepEqual([model["claude-opus-5"].rows, model["gpt-5.6-sol"].rows], [6, 1]);
    const day = L.group("card", { from: parseTime("2026-09-04"), to: parseTime("2026-09-04", true) });
    assert.deepEqual(day.groups.map((x) => [x.key, x.rows]), [["3", 3]], "只日期的范围按本地日历日,含当天最后一刻");
    assert.equal(day.total.rows, 3);

    const csv = groupsCsv(L.group("phase")).split(NL);
    assert.equal(csv[0], "phase,rows,attempts,calls,in,cc,cr,out,duration_ms,cost_usd,cost_source");
    assert.ok(csv.includes("review,2,0,3,80,,10,12,,,reported"), "未知项导出为空格子:" + csv.join(" | "));

    // 增量:只归并新追加的行;新阶段、新模型即时出现。
    appendFileSync(file, line({ ts: "2026-09-06T00:00:00", card: 2, worker: "decompose", model: "=cmd", phase: "decompose", calls: 1, in: 9, cc: 0, cr: 0, out: 1 }), "utf8");
    assert.equal(key(L.group("phase")).decompose.in, 9);
    assert.deepEqual([L.cards()["2"].rows, L.cards()["2"].in], [1, 1009], "拆解用量记到卡上,不虚增执行轮数");
    assert.ok(groupsCsv(L.group("model")).includes(NL + "'=cmd,"), "公式开头的格子加前缀,表格软件不会执行");

    const http = (path, query = "") => usageHttp(L, path, new URLSearchParams(query));
    assert.deepEqual(Object.keys(JSON.parse(http("/api/usage").body)), ["cards"], "不带参数时仍是旧形状");
    assert.equal(http("/api/usage", "by=bogus").status, 400);
    assert.equal(http("/api/usage", "by=line&from=昨天").status, 400);
    assert.equal(http("/api/usage", "format=csv").type, "text/csv; charset=utf-8");
    assert.equal(JSON.parse(http("/api/usage", "by=line&to=2026-09-03").body).total.rows, 3);
    assert.equal(http("/api/usage/nothing").status, 404);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("卡完成时写一条结算事件:同一次完成只写一次、只追加;重开后再完成带序号", { timeout: 90000 }, async () => {
  const B = await board();
  try {
    const token = await B.register("agent-a"), t = await B.card("结算用例");
    const run1 = await B.take(token, t.id);
    // 两次尝试(旧式行,不带结果)+ 一次审阅,由用例直接写进账本,不调用模型。
    appendFileSync(B.ledger,
      old(t.id, { run_id: run1.run_id, attempt: 1, duration_ms: 2000 })
      + old(t.id, { run_id: run1.run_id, attempt: 2, in: 400, out: 40, duration_ms: 3000 })
      + line({ ts: "2026-09-02T11:00:00", card: t.id, attempt: null, worker: "reviewer", model: "claude-fable-5", effort: "high",
               calls: 1, in: 20, cc: 0, cr: 0, out: 2, phase: "review", duration_ms: 500, cost_usd: 0.5, cost_source: "reported" }), "utf8");
    const rep = await B.api("POST", `/api/tasks/${t.id}/report`, token, { run_id: run1.run_id, outcome: "done", evidence: "交付说明" });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    assert.equal(B.settlements(t.id).length, 0, "还没完成,不结算");
    const done1 = await B.approve(t.id);

    let events = B.settlements(t.id);
    assert.equal(events.length, 1, B.logs());
    const first = events[0];
    assert.deepEqual([first.seq, first.resolved_at, first.resolved_by, first.rows_through], [1, done1.resolved_at, "human", 3]);
    assert.deepEqual([first.totals.rows, first.totals.attempts, first.totals.in, first.totals.duration_ms], [3, 2, 1420, 5500]);
    assert.deepEqual(first.by.map((x) => [x.phase, x.model, x.rows, x.in]), [["implement", "claude-opus-5", 2, 1400], ["review", "claude-fable-5", 1, 20]]);
    assert.deepEqual([first.failed.attempts, first.failed.rows, first.failed.in], [1, 1, 1000], "被后一次尝试取代的那次单列为失败");
    assert.equal(first.totals.cost_usd, null); assert.equal(first.totals.known.cost_usd, 0.5);

    // 之后的任何看板变动都不会给同一次完成再写一条;旧形状不受影响。
    const snapshot = readFileSync(B.ledger);
    await B.card("另一张卡");
    const legacy = await B.api("GET", "/api/usage", B.operator);
    assert.deepEqual(Object.keys(legacy.body), ["cards"]);
    assert.deepEqual([legacy.body.cards[t.id].rows, legacy.body.cards[t.id].attempts, legacy.body.cards[t.id].in], [2, 2, 1420]);
    const view = await B.api("GET", `/api/usage/card/${t.id}`, B.operator);
    assert.equal(view.status, 200);
    assert.deepEqual([view.body.settlements.length, view.body.totals.in, view.body.failed.attempts], [1, 1420, 1]);
    assert.ok(readFileSync(B.ledger).equals(snapshot), "没有新的完成 ⇒ 账本一个字节不变");

    // 重开后再完成:再写一条,序号 2;此前的内容原样保留(只追加)。
    const re = await B.api("POST", `/api/tasks/${t.id}/reopen`, B.operator, { expected_version: (await B.task(t.id)).aggregate_version });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    assert.equal(B.settlements(t.id).length, 1, "重开本身不结算");
    const run2 = await B.take(token, t.id);
    appendFileSync(B.ledger, old(t.id, { run_id: run2.run_id, attempt: 3, in: 30, out: 3, duration_ms: 1000 }), "utf8");
    const rep2 = await B.api("POST", `/api/tasks/${t.id}/report`, token, { run_id: run2.run_id, outcome: "done", evidence: "返工后的交付说明" });
    assert.equal(rep2.status, 200, JSON.stringify(rep2.body));
    const done2 = await B.approve(t.id);
    events = B.settlements(t.id);
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);
    assert.notEqual(done2.resolved_at, done1.resolved_at);
    assert.deepEqual([events[1].totals.rows, events[1].totals.in, events[1].rows_through], [4, 1450, 4], "结算是这张卡到此刻的累计");
    assert.equal(events[1].failed.attempts, 1, "上一次结算前的最后一次尝试把卡送到了完成,不算失败");
    assert.ok(readFileSync(B.ledger).subarray(0, snapshot.length).equals(snapshot), "此前的账本内容原样保留");
    assert.deepEqual(events[0], first);
  } finally { await B.stop(); }
});

test("未知值是 null 不是 0;外部执行者随交付自报用量", { timeout: 120000 }, async () => {
  // 模块层:未知不当 0 加;没有记录的卡是未知,不是零用量。
  const dir = mkdtempSync(join(tmpdir(), "usagetest-null-")), file = join(dir, "usage_ledger.jsonl");
  try {
    const L = openLedger(file, { makeDefault: true });
    assert.equal(append({ phase: "coord", worker: "coordinator", model: "claude-opus-5", ...fromClaudeResult({ num_turns: 2, total_cost_usd: 0.3,
      duration_ms: 900, session_id: "abcdef0123", usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 100 } }) }).ok, true);
    assert.equal(append({ phase: "compact", worker: "alpha", model: "claude-opus-5" }).ok, true);
    const [a, b] = parse(file);
    assert.deepEqual([a.calls, a.in, a.cc, a.cr, a.out, a.cost_usd, a.cost_source, a.duration_ms, a.sid], [2, 7, null, 100, 3, 0.3, "reported", 900, "abcdef01"]);
    assert.deepEqual([b.calls, b.in, b.cc, b.cr, b.out, b.duration_ms, b.cost_usd, b.cost_source, b.cli_version, b.card],
      [null, null, null, null, null, null, null, "unknown", null, null], "没给的项写 null");
    const total = L.group("phase").total;
    assert.deepEqual([total.rows, total.in, total.cost_usd, total.cost_source], [2, null, null, "reported"]);
    assert.deepEqual([total.known.in, total.unknown.in, total.known.cost_usd, total.unknown.cost_usd], [7, 1, 0.3, 1]);
    const empty = L.card(404);
    assert.deepEqual([empty.totals.rows, empty.totals.in, empty.totals.cost_usd, empty.failed.attempts, empty.failed.in], [0, null, null, 0, null]);
    assert.throws(() => externalRows({ in: -1 }), { code: "BAD_INPUT" });
    assert.throws(() => externalRows({ model: "=HYPERLINK(1)" }), { code: "BAD_INPUT" });
    assert.throws(() => externalRows({ phase: "lunch" }), { code: "BAD_INPUT" });
    assert.deepEqual(externalRows({ input_tokens: 5 })[0], { calls: null, in: 5, cc: null, cr: null, out: null, duration_ms: null, cost_usd: null,
      model: null, effort: null, cli_version: null, session_id: null, phase: "implement" });
  } finally { rmSync(dir, { recursive: true, force: true }); }

  // 记账函数(Python 侧):新字段写进账本;读不到的写 None;订阅通道的费用只是按单价表的估算。
  const pydir = mkdtempSync(join(tmpdir(), "usagetest-py-"));
  const py = spawnSync(PY, ["-I", "-B", "-X", "utf8", "-", ROOT, pydir], {
    cwd: ROOT, windowsHide: true, encoding: "utf8", timeout: 60000,
    env: { ...HOST_ENV, BOARD_CONFIG: join(pydir, "missing-config.json"), BOARD_REPO: pydir, BOARD_DATA_DIR: pydir,
           BOARD_VERIFY_REGISTRY: join(pydir, "missing-registry.json"), WORKER_RUNTIME: "codex", WORKER_MODEL: "fixture-model",
           WORKER_EFFORT: "high", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
    input: [
      "import sys,pathlib,json,os",
      "folder=pathlib.Path(sys.argv[2])",
      "sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))",
      "import worker_loop as w",
      "w.log=lambda *a:None; w.API_MODE=False; w.PROFILE_MODE=False; w.RUNTIME='claude'; w.LEDGER=str(folder/'ledger.jsonl')",
      "task={'id':7,'run_id':'r-7'}",
      "w.LAST_ACCT={'sid':'s-1','t0':None,'usage':{'calls':2,'in':1000000,'cc':0,'cr':0,'out':0}}",
      "known=w.acct_attempt(task,'alpha',1,'claude-opus-5','high',duration_ms=1234)",
      "w.LAST_ACCT={'sid':None,'t0':None,'usage':{'calls':None,'in':None,'cc':None,'cr':None,'out':None}}",
      "blind=w.acct_attempt(task,'alpha',2,'claude-opus-5','high',round_number=2,phase='repair',reason='passed')",
      "w.LAST_ACCT={'sid':'s-2','t0':None,'usage':{'calls':1,'in':5,'cc':0,'cr':0,'out':5}}",
      "unpriced=w.acct_attempt(task,'alpha',3,'fixture-model','high',duration_ms=5)",
      "import reviewer_loop as r",
      "r.log=lambda *a:None; r.LEDGER=w.LEDGER; r.MODEL='claude-fable-5'",
      "seen=r.claude_result_usage(json.dumps({'num_turns':3,'total_cost_usd':0.42,'session_id':'rev-1','usage':{'input_tokens':11,'output_tokens':4}}))",
      "review=r.acct_review({'id':7,'line':'alpha'},seen['usage'],sid=seen['sid'],duration_ms=800,cost_usd=seen['cost_usd'])",
      "nothing=r.claude_result_usage('不是 JSON')",
      "lost=r.acct_review({'id':7,'line':'alpha'},nothing['usage'],duration_ms=10,cost_usd=nothing['cost_usd'])",
      "print(json.dumps({'known':known,'blind':blind,'unpriced':unpriced,'review':review,'lost':lost,'ledger':w.LEDGER}))",
    ].join(NL),
  });
  assert.equal(py.status, 0, py.stdout + NL + py.stderr);
  const rows = JSON.parse(py.stdout.trim().split(NL).pop());
  assert.deepEqual([rows.known.duration_ms, rows.known.cost_usd, rows.known.cost_source, rows.known.cli_version, rows.known.phase], [1234, 5, "estimated", null, "initial"]);
  assert.deepEqual([rows.blind.in, rows.blind.duration_ms, rows.blind.cost_usd, rows.blind.cost_source], [null, null, null, "unknown"]);
  assert.deepEqual([rows.unpriced.cost_usd, rows.unpriced.cost_source], [null, "unknown"], "单价表里没有的模型不估价");
  assert.deepEqual([rows.review.card, rows.review.phase, rows.review.calls, rows.review.in, rows.review.cc, rows.review.cost_usd, rows.review.cost_source, rows.review.duration_ms],
    [7, "review", 3, 11, null, 0.42, "reported", 800], "审阅记到被审的卡上");
  assert.deepEqual([rows.lost.in, rows.lost.cost_usd, rows.lost.cost_source], [null, null, "unknown"]);
  const fromPython = openLedger(rows.ledger).card(7);
  assert.deepEqual(fromPython.by.map((x) => [x.phase, x.model, x.rows]),
    [["implement", "claude-opus-5", 1], ["implement", "fixture-model", 1], ["fix", "claude-opus-5", 1], ["review", "claude-fable-5", 2]]);
  assert.deepEqual([fromPython.totals.in, fromPython.totals.known.in, fromPython.totals.unknown.in], [null, 1000016, 2]);
  rmSync(pydir, { recursive: true, force: true });

  // 整条路:外部执行者用命令行交付并自报;格式不对的自报连同交付一起被拒。
  const B = await board();
  try {
    const token = await B.register("agent-x"), tokenFile = join(B.dir, "agent-x.token");
    writeFileSync(tokenFile, token + NL, "utf8");
    const t = await B.card("外部自报"), run = await B.take(token, t.id);
    const bad = await B.api("POST", `/api/tasks/${t.id}/report`, token, { run_id: run.run_id, outcome: "done", evidence: "交付说明", usage: { in: "很多" } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal((await B.task(t.id)).status, "in_progress", "自报格式不对 ⇒ 这次交付没有落下");
    const evidence = join(B.dir, "evidence.md"), usage = join(B.dir, "usage.json");
    writeFileSync(evidence, "交付说明:改了什么、跑了什么。", "utf8");
    writeFileSync(usage, JSON.stringify([{ model: "gpt-5.6-sol", calls: 4, in: 1200, out: 300, cost_usd: 0.9, duration_ms: 60000, cli_version: "0.164.0" },
                                         { model: "local-llm", phase: "fix", in: 50 }]), "utf8");
    let r = B.cli("done", String(t.id), "--run", run.run_id, "--file", evidence, "--usage", usage, "--token-file", tokenFile);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /已自报用量 2 条/);
    const mine = parse(B.ledger).filter((j) => j.card === t.id);
    assert.deepEqual(mine.map((j) => [j.worker, j.line, j.attempt, j.phase, j.cost_usd, j.cost_source, j.reported_by, j.ok]),
      [["agent-x", "alpha", 1, "implement", 0.9, "external-reported", "external", true], ["agent-x", "alpha", 1, "fix", null, "unknown", "external", true]]);
    assert.deepEqual([mine[1].calls, mine[1].out, mine[1].cc, mine[1].duration_ms, mine[1].cli_version], [null, null, null, null, null], "对方没写的项是 null,不替它补 0");
    await B.approve(t.id);
    const settled = B.settlements(t.id)[0];
    assert.deepEqual([settled.totals.rows, settled.totals.in, settled.totals.out, settled.totals.known.out, settled.totals.cost_usd, settled.totals.cost_source],
      [2, 1250, null, 300, null, "external-reported"]);

    r = B.cli("usage", "card", String(t.id));
    assert.equal(r.code, 0, r.out); assert.match(r.out, /implement · gpt-5\.6-sol/); assert.match(r.out, /输出 ≥300/); assert.match(r.out, /结算 第 1 次/);
    r = B.cli("usage", "ls", "--by", "model");
    assert.equal(r.code, 0, r.out); assert.match(r.out, /gpt-5\.6-sol.*费用 \$0\.9000\(自报\)/); assert.match(r.out, /local-llm.*输出 未知.*费用 未知/);
    const out = join(B.dir, "usage.csv");
    r = B.cli("usage", "csv", "--by", "model", "--out", out);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readFileSync(out, "utf8").split(NL).slice(0, 3),
      ["model,rows,attempts,calls,in,cc,cr,out,duration_ms,cost_usd,cost_source", "gpt-5.6-sol,1,1,4,1200,,,300,60000,0.9,external-reported", "local-llm,1,1,,50,,,,,,unknown"]);
    r = B.cli("usage", "csv", "--card", String(t.id));
    assert.equal(r.code, 0, r.out); assert.match(r.out, new RegExp(`${t.id},total,\\*,2,1,,1250,`));
    const web = await B.raw("GET", "/api/usage?by=phase&format=csv", B.operator);
    assert.equal(web.status, 200); assert.match(web.headers.get("content-type"), /^text\/csv/);
    assert.match(await web.text(), /^phase,rows,/);
  } finally { await B.stop(); }
});
