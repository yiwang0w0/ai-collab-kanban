import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 公告板 v3 合同 B「流转」:卡历史(step / actor_kind / 打回原因)、任务派生字段(handed_back / last_actor)、
// 建卡对话的进度(conversation.progress、唯一一条原位更新的进度消息、2 秒合并推送、重启后重算)、鉴权。
// `node --test tests/flowtest.mjs`。不调用任何模型:协调线用 tests/helpers/fake-coordinator-cli.mjs 顶替。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FAKE = join(ROOT, "tests", "helpers", "fake-coordinator-cli.mjs");
const require = createRequire(import.meta.url);
const store = require(join(ROOT, "core", "store.js"));
const conversations = require(join(ROOT, "core", "conversations.js"));
const F = await import(pathToFileURL(join(ROOT, "core", "flow.mjs")).href);

// ── 库层:一张卡走完 建→放行→领→启动→交付→打回→再领→交付→通过 ─────────────────────────
function memory(t) {
  const db = new DatabaseSync(":memory:"); store.migrate(db); conversations.migrate(db); t.after(() => db.close());
  const sent = [];
  const flow = F.createFlow({ db, lines: () => ["alpha", "beta"], labels: () => ({ alpha: "开发" }), emit: (type, data) => sent.push({ type, ...data }), coalesceMs: 50 });
  t.after(() => flow.stop());
  return { db, flow, sent };
}
const version = (db, id) => store.get(db, id).aggregate_version;

test("一张卡走完全程:历史条目与 step、actor_kind、打回原因、handed_back、last_actor;对话进度随之变化", async (t) => {
  const { db, flow, sent } = memory(t);
  const goal = store.add(db, { subject: "目标", kind: "goal", released: 1, actor: "operator" });
  const id = store.add(db, { subject: "子卡甲", parentId: goal, line: "alpha", released: 0, actor: "operator" });
  const other = store.add(db, { subject: "子卡乙", parentId: goal, line: "beta", released: 1, actor: "operator" });
  const conv = conversations.create(db, { message: "做个目标", model: "m", effort: "high" }).conversation.id;
  conversations.markApplied(db, conv, 1, { by: "local", goalId: goal, taskIds: [id, other] });
  conversations.addSystemMessage(db, conv, { kind: "applied", text: "已按计划建卡" });
  const steps = () => flow.progressOf(conv).items.map((i) => i.step);
  assert.deepEqual(steps(), [0, 1], "未放行 0,已放行等领取 1");

  store.setReleased(db, { id, released: true, expectedVersion: version(db, id) });
  assert.deepEqual(steps(), [1, 1]);
  const claim = (worker) => { const r = store.claimById(db, { id, worker, runtime: "claude", agentInstanceId: randomUUID(), expectedVersion: version(db, id) });
                              assert.equal(r.ok, true, JSON.stringify(r)); return r.task; };
  let c = claim("alpha");
  assert.deepEqual(steps(), [2, 1], "领取后没有启动记录 = 2");
  assert.equal(flow.progressOf(conv).items[0].worker, "开发", "执行方按线的显示名");
  db.prepare("INSERT INTO task_events(at,task_id,kind,actor,detail) VALUES(?,?,?,?,?)")
    .run(new Date().toISOString(), id, "process_started", "alpha", JSON.stringify({ source: "worker_loop", run_id: c.run_id, runtime: "claude" }));
  assert.deepEqual(steps(), [3, 1], "本轮有启动记录 = 3");
  store.report(db, { id, worker: "alpha", runId: c.run_id, outcome: "done", evidence: "做完了" });
  let p = flow.progressOf(conv);
  assert.deepEqual([p.items[0].step, p.items[0].waiting_for], [4, "review"]);
  assert.match(flow.progressText(p), /^0\/2 完成 · #\d+ 待验收/);
  const reason = "缺少 C:\\Users\\you\\proj\\a.txt 的用例,先跑 `npm test` 再交 0123456789abcdef0123";
  store.resolve(db, { id, verdict: "reject", note: reason, resolvedBy: "human", expectedVersion: version(db, id) });
  assert.deepEqual(flow.taskFields({ id }), { handed_back: 1, last_actor: "你", last_actor_kind: "human" });
  assert.equal(flow.progressOf(conv).items[0].step, 1, "打回回到等领取");
  assert.match(flow.progressText(flow.progressOf(conv)), /已打回,等重领/);
  c = claim("alpha@2");
  store.report(db, { id, worker: "alpha@2", runId: c.run_id, outcome: "done", evidence: "补上了" });
  store.resolve(db, { id, verdict: "approve", resolvedBy: "human", expectedVersion: version(db, id) });

  const h = flow.history(id);
  assert.equal(h.task_id, id);
  assert.deepEqual(h.entries.map((e) => e.step),
    ["created", "released", "claimed", "started", "reported", "handed_back", "claimed", "reported", "accepted"]);
  assert.deepEqual(h.entries.map((e) => e.actor_kind), ["human", "human", "line", "line", "line", "human", "line", "line", "human"]);
  const back = h.entries.find((e) => e.step === "handed_back");
  assert.match(back.summary, /^你打回,回原线重做:缺少/, back.summary);
  assert.ok(!/Users|npm test|0123456789abcdef/.test(back.summary), `原因摘要去掉了路径、命令、长串:${back.summary}`);
  for (const e of h.entries) {
    assert.ok([...e.summary].length <= 120 && !e.summary.includes(c.run_id), e.summary);
    assert.ok(Number.isFinite(Date.parse(e.at)) && typeof e.kind === "string");
  }
  assert.equal(h.entries[2].actor, "开发"); assert.equal(h.entries[6].actor, "开发", "并行槽号不显示");
  assert.match(h.entries[2].summary, /领取\(claude\)/, "运行时由 task_runs 补");
  assert.deepEqual(flow.history(id, 2).entries.map((e) => e.step), ["reported", "accepted"], "limit 取最近的,仍旧→新");
  assert.deepEqual(flow.taskFields({ id }), { handed_back: 1, last_actor: "你", last_actor_kind: "human" });
  assert.deepEqual(flow.taskFields({ id: 9999 }), { handed_back: 0, last_actor: null, last_actor_kind: null });

  // 父目标自动完成 / 重开也反映在进度里。
  const o = store.claimById(db, { id: other, worker: "beta", runtime: "codex", agentInstanceId: randomUUID(), expectedVersion: version(db, other) }).task;
  store.report(db, { id: other, worker: "beta", runId: o.run_id, outcome: "done", evidence: "好了" });
  store.resolve(db, { id: other, verdict: "approve", resolvedBy: "human", expectedVersion: version(db, other) });
  store.completeGoals(db);
  p = flow.progressOf(conv);
  assert.deepEqual([p.done, p.total, p.goal_status], [2, 2, "done"]);
  assert.equal(flow.progressText(p), "全部完成 · 2/2");
  store.reopen(db, { id: other, expectedVersion: version(db, other), actor: "operator" });
  store.completeGoals(db);
  p = flow.progressOf(conv);
  assert.deepEqual([p.done, p.goal_status], [1, "not_started"]);
  assert.equal(flow.history(other).entries.at(-1).step, "reopened");

  // 合并:窗口内多次变化只推一次;签名没变不推;不认识的任务号不推。
  flow.notify("task.updated", { id: other }); flow.notify("task.claimed", { id }); flow.notify("goal.completed", { ids: [-goal] });
  flow.notify("task.updated", { id: 424242 }); flow.notify("conversation.changed", { id: conv });
  await delay(150);
  assert.deepEqual(sent, [{ type: "conversation.changed", id: conv }]);
  flow.notify("task.updated", { id }); await delay(150);
  assert.equal(sent.length, 1, "签名没变不再推");
  assert.equal(flow.progressOf(999), null);
});

// 外部执行者(凭码/令牌接入)的卡:connect 的表注入 flow,与 server.mjs 的接线同形。
async function extSetup(t) {
  const db = new DatabaseSync(":memory:"); store.migrate(db); conversations.migrate(db); t.after(() => db.close());
  const coord = require(join(ROOT, "core", "coord.js")); coord.migrate(db);
  const { openConnect } = await import(pathToFileURL(join(ROOT, "core", "connect.mjs")).href);
  const connect = openConnect({ db, coord, store }); connect.migrate();
  const flow = F.createFlow({ db, lines: () => ["alpha"], isExecutor: coord.isExecutor, coalesceMs: 50,
    heartbeatStarted: (x) => coord.isExecutor(db, x.worker) && connect.heartbeatSeen(x.run_id), liveNote: (x) => connect.liveNote(x) });
  t.after(() => flow.stop());
  coord.register(db, { id: "zc", name: "zc", kind: "external" });
  const goal = store.add(db, { subject: "目标", kind: "goal", released: 1, actor: "operator" });
  const ext = store.add(db, { subject: "外部卡", parentId: goal, line: "zc", released: 1, actor: "operator" });
  const man = store.add(db, { subject: "受管卡", parentId: goal, line: "alpha", released: 1, actor: "operator" });
  const conv = conversations.create(db, { message: "目标", model: "m", effort: "high" }).conversation.id;
  conversations.markApplied(db, conv, 1, { by: "local", goalId: goal, taskIds: [ext, man] });
  const item = (id) => flow.progressOf(conv).items.find((i) => i.id === id);
  const claim = (id, worker, runtime) => store.claimById(db, { id, worker, runtime, agentInstanceId: randomUUID(), expectedVersion: version(db, id) }).task;
  return { db, connect, flow, goal, ext, man, conv, item, claim };
}

test("外部执行者:领取之后有过心跳 = 已启动;受管线仍只认 process_started", async (t) => {
  const { db, connect, flow, conv, ext, man, item, claim } = await extSetup(t);
  const c = claim(ext, "zc", "zcode"), m = claim(man, "alpha", "claude");
  assert.deepEqual([item(ext).step, item(man).step], [2, 2], "刚领取:都还是 2");
  assert.equal(connect.markHeartbeat(ext, c.run_id), true, "本轮第一次心跳");
  assert.equal(connect.markHeartbeat(ext, c.run_id), false, "第二次不再算第一次");
  assert.equal(item(ext).step, 3, "外部执行者领取后心跳过 = 已启动");
  assert.equal(item(ext).started_via, "self_report", "依据是对方自报(面板写「在做 · 对方自报」)");
  assert.ok(!Number.isNaN(Date.parse(connect.heartbeatStartedAt(c.run_id))), "第一次心跳的时刻(侧栏「启动」取它)");
  const text = () => flow.progressText(flow.progressOf(conv));
  assert.ok(text().includes(`#${ext} zc 在做(自报)`), "进度消息与三处「对方自报」同口径:" + text());
  db.prepare("INSERT INTO task_events (task_id, at, kind, actor, detail) VALUES (?, ?, 'process_started', 'alpha', ?)")
    .run(man, new Date().toISOString(), JSON.stringify({ run_id: m.run_id }));
  assert.ok(text().includes(`#${man} alpha 在做`) && !text().includes(`#${man} alpha 在做(`), "受管线看板观察到进程:只写「在做」:" + text());
  db.prepare("DELETE FROM task_events WHERE task_id=? AND kind='process_started'").run(man);
  connect.markHeartbeat(man, m.run_id);
  assert.equal(item(man).step, 2, "受管线只认 process_started");
  assert.equal(item(man).started_via, null);
  store.report(db, { id: ext, worker: "zc", runId: c.run_id, outcome: "done", evidence: "好了" });
  store.resolve(db, { id: ext, verdict: "reject", note: "再改", resolvedBy: "human", expectedVersion: version(db, ext) });
  claim(ext, "zc", "zcode");
  assert.equal(item(ext).step, 2, "新一轮领取:还没心跳");
});

test("progress.items 带 live_note / live_note_at(connect 的表,绑本轮 run);换一句会改签名、同一句重报不改", async (t) => {
  const { db, connect, flow, ext, conv, item, claim } = await extSetup(t);
  const c = claim(ext, "zc", "zcode");
  assert.deepEqual([item(ext).live_note, item(ext).live_note_at], [null, null]);
  connect.setNote(ext, c.run_id, "读第二章");
  assert.equal(item(ext).live_note, "读第二章"); assert.ok(item(ext).live_note_at);
  const s1 = flow.sync(conv).sig;
  connect.setNote(ext, c.run_id, "读第二章");
  assert.equal(flow.sync(conv).sig, s1, "同一句重报不改签名(不推)");
  connect.setNote(ext, c.run_id, "改第三章");
  assert.notEqual(flow.sync(conv).sig, s1, "换一句要推给面板");
  store.report(db, { id: ext, worker: "zc", runId: c.run_id, outcome: "done", evidence: "好了" });
  connect.clearNote(ext);
  assert.deepEqual([item(ext).live_note, item(ext).live_note_at], [null, null], "交付后清空");
});

test("目标卡的 children_done / children_total 与 progress 的 done/total 同口径(直接子卡,未归档 + 完成后才归档的)", async (t) => {
  const { db, flow, goal, ext, man, conv, claim } = await extSetup(t);
  const m = claim(man, "alpha", "claude");
  store.report(db, { id: man, worker: "alpha", runId: m.run_id, outcome: "done", evidence: "好了" });
  store.resolve(db, { id: man, verdict: "approve", resolvedBy: "human", expectedVersion: version(db, man) });
  store.archive(db, { id: man });
  const gone = store.add(db, { subject: "作废卡", parentId: goal, line: "alpha", released: 0, actor: "operator" });
  store.archive(db, { id: gone, force: true });
  const kid = store.add(db, { subject: "孙卡", parentId: ext, line: "alpha", released: 1, actor: "operator" });
  const p = flow.progressOf(conv);
  assert.deepEqual([p.done, p.total], [1, 2], "完成后归档的算,未完成就归档的不算,孙卡不算");
  assert.deepEqual(flow.goalCounts(store.get(db, goal)), { children_done: p.done, children_total: p.total });
  assert.deepEqual([flow.goalCounts(store.get(db, ext)), flow.goalCounts(store.get(db, kid))], [{}, {}], "不是目标的卡没有这两个字段");
});

test("actor_kind 判定表、摘要清洗", () => {
  const ctx = { lines: ["alpha"], isExecutor: (a) => a === "zc-1" };
  const k = (a, kind = "resolve") => F.actorKindOf(a, kind, ctx);
  assert.deepEqual(["human", "operator", "local", "panel", "approval-token:ab12"].map((a) => k(a)), Array(5).fill("human"));
  assert.deepEqual([k("auto"), k("review"), k("zc-1", "claim"), k("alpha@3", "claim"), k("probe", "claim"), k("probe", "add")],
    ["auto", "auto", "executor", "line", "line", "system"]);
  assert.deepEqual(["system", "migration", "lease-reaper", "cascade"].map((a) => k(a)), Array(4).fill("system"));
  assert.equal(F.safeText("看 /Users/x/a.md 与 D:\\w\\b.js,id 9f86d081884c7d659a2feaa0c55ad015,令牌 exe_abcdefghijk"), "看 … 与 …,id …,令牌 …");
  assert.equal(F.entryOf({ at: "x", kind: "evidence.recorded", actor: "a", detail: {} }), null);
});

// F12:逐类样例。令牌样串全是明显的假值,且用拼接生成(源码里不出现完整形,免得撞仓库的秘密扫描规则)。
test("摘要清洗补全(F12):带空格路径、Git Bash / WSL 形、UNC、环境变量路径、常见令牌前缀", () => {
  const j = (...p) => p.join("");
  const cases = [
    ["Windows 带空格路径", j("改 C:", "\\Users\\you\\My Documents\\私密 文件.txt 之后重跑"), ["Documents", "私密", "文件.txt"]],
    ["Windows 正斜杠", j("看 D:", "/work/a b/c.md"), ["work", "c.md"]],
    ["Git Bash /c/Users", j("改 ", "/c/Users/you/Documents/secret.txt"), ["Users", "secret"]],
    ["WSL /mnt/c", j("在", "/mnt/c/Users/you/proj/x.env 里"), ["mnt", "proj"]],
    ["UNC", j("放到 \\\\", "fileserver\\share\\财务 资料\\q3.xlsx"), ["fileserver", "share", "q3"]],
    ["双斜杠 UNC", j("放到 //", "fileserver/share/q3.xlsx"), ["fileserver", "q3"]],
    ["file URL", j("打开 file:", "///D:/work/x.txt"), ["work", "fil"]],
    ["环境变量路径", j("读 %USERPROFILE%", "\\.ssh\\id_rsa"), ["ssh", "id_rsa", "USERPROFILE"]],
    ["~用户 路径", j("见 ~", "someone/notes.md"), ["someone", "notes"]],
    ["github_pat_", j("令牌 github", "_pat_", "11FAKEFAKE0000_fakefake"), ["github_pat", "FAKEFAKE"]],
    ["ghp_", j("令牌 gh", "p_", "FAKEFAKEFAKE0000"), ["ghp_", "FAKE"]],
    ["gho_", j("令牌 gh", "o_", "FAKEFAKEFAKE0000"), ["gho_", "FAKE"]],
    ["JWT 三段", j("头 ey", "JhbGciOi", ".", "eyJzdWIi", ".", "c2lnbmF0"), ["eyJ", "c2ln"]],
    ["AKIA", j("钥 AK", "IA", "FAKE0000FAKE"), ["AKIA", "FAKE"]],
    ["xoxb-", j("bot xo", "xb-", "0000-fake-fake"), ["xoxb", "fake"]],
    ["xoxp-", j("user xo", "xp-", "0000-fake-fake"), ["xoxp", "fake"]],
    ["sk-ant", j("用 sk", "-ant-", "fakefake0000"), ["sk-", "fakefake"]],
    ["sk-proj", j("用 sk", "-proj-", "FakeFake0000"), ["sk-", "Fake"]],
    ["exe_", j("令牌 ex", "e_", "fakefakefake"), ["exe_", "fakefake"]],
    ["长混排串", j("串 ", "FakeFakeFakeFakeFakeFakeFake"), ["FakeFake"]],
  ];
  for (const [name, input, leaks] of cases) {
    const out = F.redactText(input);
    for (const leak of leaks) assert.ok(!out.includes(leak), `${name}: 「${leak}」残留在 ${JSON.stringify(out)}`);
    assert.ok(out.includes("…"), `${name}: 应有遮蔽号`);
    assert.ok(!F.safeText(input, 200).includes(leaks[0]), `${name}: safeText 同源`);
  }
  // 不误伤:普通中文、短英文词、比例、版本号、纯小写长词、https 网址的主机名。
  for (const ok of ["3/5 完成 · 已打回", "测试没过,重跑 npm test", "v2.3.1 版本", "internationalization 问题", "见 https://example.com/docs"])
    assert.equal(F.redactText(ok), ok, `不应改动:${ok}`);
  assert.equal(F.safeText("看 /Users/x/a.md 与 D:\\w\\b.js,id 9f86d081884c7d659a2feaa0c55ad015,令牌 exe_abcdefghijk"), "看 … 与 …,id …,令牌 …");
  assert.equal(F.entryOf({ at: "x", kind: "resolve", actor: "cascade", detail: { cause_task_id: 3 } }).step, "accepted");
  assert.equal(F.entryOf({ at: "x", kind: "resolve", actor: "human", detail: { status: "not_started" } }).step, "handed_back", "旧事件无 disposition 按状态判");
  assert.equal(F.entryOf({ at: "x", kind: "release", actor: "alpha", detail: { action: "release_held" } }).step, "reaped");
});

test("gitleaks 历史例外:4908518 的本文件只放行这一提交 + 这一文件(合成占位名,4e35888 已改为 you)", () => {
  const toml = readFileSync(join(ROOT, ".gitleaks.toml"), "utf8");
  const at = toml.indexOf('commits = ["4908518c954127347cf92ce2c9b779a202b4cbb2"]');
  assert.ok(at > 0, "例外按完整提交号写");
  const block = toml.slice(toml.lastIndexOf("[[rules.allowlists]]", at), toml.indexOf("\n\n", at) > 0 ? toml.indexOf("\n\n", at) : undefined);
  assert.match(block, /condition = "AND"/, "提交与文件同时满足才放行");
  assert.match(block, /paths = \['''\^tests\[\\\\\/\]flowtest\\\.mjs\$'''\]/, "只限本文件");
  assert.ok(!/regexes|stopwords/.test(block), "不按内容宽放行");
  // 当前树里已经没有那个占位名
  assert.ok(!readFileSync(fileURLToPath(import.meta.url), "utf8").includes("Users\\\\" + "someone"));
});

test("性能:500 张卡 / 5000 条事件下的派生字段", (t) => {
  const { db, flow } = memory(t);
  const ins = db.prepare("INSERT INTO task_events(at,task_id,kind,actor,detail) VALUES(?,?,?,?,?)");
  const ids = [];
  db.exec("BEGIN");
  for (let i = 0; i < 500; i++) ids.push(store.add(db, { subject: `卡 ${i}`, released: 1, actor: "operator" }));
  const at = new Date().toISOString(), kinds = [["claim", "alpha", {}], ["report", "alpha", { outcome: "done" }], ["resolve", "human", { disposition: "hand_back" }]];
  for (let n = 0; n < 4500; n++) { const [kind, actor, detail] = kinds[n % 3]; ins.run(at, ids[n % 500], kind, actor, JSON.stringify(detail)); }
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM task_events").get().n, 5000);
  const time = (fn) => { const s = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - s) / 1e6; };
  const cold = time(() => ids.forEach((id) => flow.taskFields({ id })));
  const warm = time(() => ids.forEach((id) => flow.taskFields({ id })));
  ins.run(at, ids[0], "resolve", "human", JSON.stringify({ disposition: "hand_back" }));
  const step = time(() => ids.forEach((id) => flow.taskFields({ id })));
  const hist = time(() => flow.history(ids[0]));
  console.log(`# 性能 500 卡/5000 事件:首次建缓存+500 次读 ${cold.toFixed(1)}ms;热读 500 次 ${warm.toFixed(1)}ms;新增 1 条后 500 次读 ${step.toFixed(1)}ms;单卡历史 ${hist.toFixed(1)}ms`);
  assert.equal(flow.taskFields({ id: ids[0] }).handed_back, 4);
  assert.ok(warm < 500 && step < 500 && cold < 3000, `${cold} / ${warm} / ${step}`);
});

// ── 服务层:真看板 + 假协调线 ─────────────────────────────────────────────────────────
const freePort = async () => {
  const l = createServer(); await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const port = l.address().port; await new Promise((r) => l.close(r)); return port;
};
async function boot(dir) {
  const repo = join(dir, "repo"), cfg = join(dir, "fleet.json"), log = join(dir, "coordinator-calls.jsonl");
  mkdirSync(repo, { recursive: true });
  writeFileSync(cfg, JSON.stringify({ lines: [{ id: "alpha", label: "开发" }, { id: "beta" }, { id: "rev", role: { kind: "review" } }], roles: [], routes: ["default"], repo }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: cfg, BOARD_DATA_DIR: dir, BOARD_DB: join(dir, "board.db"),
           BOARD_REPO: repo, BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit", BOARD_ALLOW_UNPINNED: "1",
           BOARD_COORDINATOR_CLI_ARGV: JSON.stringify([process.execPath, FAKE]), CONVTEST_LOG: log } });
  let logs = ""; const add = (v) => { logs = (logs + String(v)).slice(-20000); };
  child.stdout.on("data", add); child.stderr.on("data", add);
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const token = (name) => readFileSync(join(dir, name), "utf8").trim();
  const api = async (method, path, tok, body) => {
    const r = await fetch(base + path, { method, headers: { ...(tok ? { "X-Board-Token": tok } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  const operator = token("board_token");
  const detail = async (id) => (await api("GET", `/api/conversations/${id}`, operator)).body;
  const settle = async (id) => {
    for (let i = 0; i < 300; i++) { const d = await detail(id); if (d.conversation.status !== "running") return d; await delay(100); }
    throw new Error(`对话 ${id} 一直在运行中\n${logs}`);
  };
  const listen = () => {
    const seen = { text: "" }, ac = new AbortController();
    fetch(base + "/api/events", { headers: { "X-Board-Token": operator }, signal: ac.signal }).then(async (r) => {
      const reader = r.body.getReader(), dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; seen.text += dec.decode(value, { stream: true }); }
    }).catch(() => {});
    return { seen, close: () => ac.abort() };
  };
  const stop = async () => { child.kill(); await closed; };
  return { api, token, operator, detail, settle, listen, stop, logs: () => logs };
}

test("建卡对话:progress、唯一的进度消息原位更新、2 秒合并推送、重启后重算;history 鉴权;未建卡 progress=null", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "flowtest-"));
  let b = await boot(dir);
  try {
    const plain = (await b.api("POST", "/api/conversations", b.operator, { message: "随便聊聊" })).body.conversation.id;
    let d = await b.settle(plain);
    assert.equal(d.conversation.progress, null, "未建卡的对话 progress=null");
    assert.ok(!d.messages.some((m) => m.kind === "progress"));

    const conv = (await b.api("POST", "/api/conversations", b.operator, { message: "【计划】把导出做成可配置的" })).body.conversation.id;
    await b.settle(conv);
    const applied = await b.api("POST", `/api/conversations/${conv}/plans/1/apply`, b.operator, { expected_rev: 1 });
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    const ids = applied.body.task_ids;
    d = await b.detail(conv);
    let p = d.conversation.progress;
    assert.deepEqual([p.goal_id, p.total, p.done], [applied.body.goal_id, 4, 0]);
    assert.deepEqual(p.items.map((i) => [i.id, i.n, i.step, i.released]), [[ids[0], 1, 1, true], [ids[1], 2, 1, true], [ids[2], 3, 0, false], [ids[3], 4, 1, true]]);
    for (const i of p.items) assert.deepEqual(Object.keys(i).sort(), ["handed_back", "id", "line", "live_note", "live_note_at", "n", "released", "runtime", "started_via", "status", "step", "subject", "updated_at", "waiting_for", "worker"]);
    assert.ok(p.items.every((i) => i.live_note === null && i.live_note_at === null), "没人报进度时 live_note 为 null");
    const progressMsgs = (dd) => dd.messages.filter((m) => m.kind === "progress");
    let pm = progressMsgs(d);
    assert.equal(pm.length, 1);
    const kinds = d.messages.map((m) => m.kind);
    assert.equal(kinds.indexOf("progress"), kinds.indexOf("applied") + 1, "进度消息紧跟建卡消息");
    assert.match(pm[0].text, /^0\/4 完成 · /);
    const first = pm[0];

    // 两次变化落在同一个 2 秒窗口里 → 只推一次 conversation.changed。
    await delay(2300);   // 建卡那次变化的合并窗口先走完
    const sse = b.listen(); await delay(400);
    const pushes = () => sse.seen.text.split(`"type":"conversation.changed","id":${conv}}`).length - 1;
    const card = async (id) => (await b.api("GET", `/api/tasks/${id}`, b.operator)).body.task;
    let k = await card(ids[0]);
    const took = await b.api("POST", `/api/tasks/${ids[0]}/claim`, b.operator, { worker: "alpha", expected_version: k.aggregate_version });
    assert.equal(took.status, 200, JSON.stringify(took.body));
    const rep = await b.api("POST", `/api/tasks/${ids[0]}/report`, b.operator, { worker: "alpha", run_id: took.body.task.run_id, outcome: "done", evidence: "做完了" });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    await delay(1000);
    assert.equal(pushes(), 0, "窗口未到不推");
    await delay(1800);
    assert.equal(pushes(), 1, `窗口内两次变化只推一次\n${sse.seen.text.slice(-600)}`);
    d = await b.detail(conv); pm = progressMsgs(d);
    assert.equal(pm.length, 1); assert.equal(pm[0].id, first.id); assert.equal(pm[0].created_at, first.created_at);
    assert.ok(pm[0].updated_at > first.updated_at); assert.match(pm[0].text, new RegExp(`#${ids[0]} 待验收`));
    assert.equal(d.conversation.progress.items[0].step, 4);

    // 打回:任务对象带 handed_back / last_actor;history 有原因摘要。
    k = await card(ids[0]);
    const back = await b.api("POST", `/api/tasks/${ids[0]}/resolve`, b.operator, { verdict: "reject", note: "导出列顺序不对", expected_version: k.aggregate_version });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    k = await card(ids[0]);
    assert.deepEqual([k.handed_back, k.last_actor, k.last_actor_kind], [1, "你", "human"]);
    const listed = (await b.api("GET", "/api/tasks", b.operator)).body.tasks.find((x) => x.id === ids[0]);
    assert.deepEqual([listed.handed_back, listed.last_actor_kind], [1, "human"]);
    const h = await b.api("GET", `/api/tasks/${ids[0]}/history`, b.operator);
    assert.equal(h.status, 200);
    assert.deepEqual(h.body.entries.map((e) => e.step), ["created", "claimed", "reported", "handed_back"]);
    assert.match(h.body.entries[3].summary, /打回.*导出列顺序不对/);
    await delay(2600);
    assert.equal(pushes(), 2); sse.close();

    // 鉴权:执行线 / 审阅线令牌、无令牌都拒;不存在的卡 404;limit 越界 400。
    for (const [tok, code] of [[b.token("worker_token"), 403], [b.token("review_token"), 403], [null, 401]])
      assert.equal((await b.api("GET", `/api/tasks/${ids[0]}/history`, tok)).status, code);
    assert.equal((await b.api("GET", `/api/conversations/${conv}`, b.token("worker_token"))).status, 403);
    assert.equal((await b.api("GET", "/api/tasks/99999/history", b.operator)).status, 404);
    assert.equal((await b.api("GET", `/api/tasks/${ids[0]}/history?limit=0`, b.operator)).status, 400);
    assert.deepEqual((await b.api("GET", `/api/tasks/${ids[0]}/history?limit=1`, b.operator)).body.entries.map((e) => e.step), ["handed_back"]);

    // 重启:从库里重算,进度消息仍只有一条、不重复、内容一致。
    const before = progressMsgs(await b.detail(conv))[0];
    await b.stop();
    b = await boot(dir);
    d = await b.detail(conv); pm = progressMsgs(d);
    assert.equal(pm.length, 1); assert.deepEqual([pm[0].id, pm[0].text, pm[0].created_at], [before.id, before.text, before.created_at]);
    assert.match(pm[0].text, /已打回,等重领/);
    assert.equal(d.conversation.progress.items[0].handed_back, 1);
  } finally { await b.stop(); try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});
