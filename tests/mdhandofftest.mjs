import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// md 交接(公告板 v3 第 3 波):队列文件的解析(畸形拒绝带行号、代码块、转义)、导出 → 导入往返、一律未放行、
// 按内容哈希去重、整份拒绝不部分导入、清洗与遮蔽、鉴权、board.py export-md / import-md / report-md。
// `node --test tests/mdhandofftest.mjs`。不调用任何模型。
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
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { freePort } from "./helpers/free-port.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const store = require(join(ROOT, "core", "store.js"));
const M = await import(pathToFileURL(join(ROOT, "core", "md-handoff.mjs")).href);
const PY = HOST_ENV.PYTHON || "python";

// 合成的敏感样串在运行时拼出来,源码里不出现它们的完整形状。
const BS = String.fromCharCode(92);
// 家目录下的路径:导出时家目录前缀换成 ~(N3);用户名用 .gitleaks.toml 放行的夹具名。
const HOME_DIR = ["C:", "Users", "fixture"].join(BS);
const PRIVATE_PATH = [HOME_DIR, "work", "plan.txt"].join(BS);
const HOME_REDACTED = ["~", "work", "plan.txt"].join(BS);
const TOKEN_LIKE = "gh" + "p_" + "Ab1".repeat(8);
const LONG_ID = "0123abcd".repeat(2);
const ESC = String.fromCharCode(27), RLO = String.fromCharCode(0x202e), ZW = String.fromCharCode(0x200b);

const QUEUE = [
  "# 队列说明(这一段导入时不读)",
  "",
  "## 写登录页",
  "",
  "### 说明",
  "做一个登录页。",
  "",
  "\\## 这一行以 # 开头,是正文",
  "",
  "### 验收",
  "能登录;",
  "```",
  "## 代码块里的井号不算标题",
  "```",
  "",
  "### 线",
  "alpha",
  "",
  "## 写登录接口",
  "",
  "### 说明",
  "后端接口。",
  "",
  "### 验收",
  "接口测试通过",
  "",
  "### 依赖",
  "- 写登录页",
  "",
].join("\n");

test("解析:节、小节、转义、代码块、依赖;文件说明不读", () => {
  const { sections, errors } = M.parseQueueMd(QUEUE);
  assert.deepEqual(errors, []);
  assert.equal(sections.length, 2);
  const [a, b] = sections;
  assert.equal(a.subject, "写登录页"); assert.equal(a.line, "alpha"); assert.equal(a.line_no, 3);
  assert.equal(a.description, "做一个登录页。\n\n## 这一行以 # 开头,是正文", "去掉转义的反斜杠");
  assert.match(a.acceptance, /```\n## 代码块里的井号不算标题\n```/);
  assert.deepEqual(b.deps, [{ title: "写登录页" }]); assert.equal(b.line, null);
});

test("解析:畸形的节逐条给行号", () => {
  const bad = [
    "## 缺验收", "### 说明", "有说明", "",          // 1-4:缺验收
    "## 坏小节", "随手写的字", "### 说明", "x", "### 验收", "y", "### 验证", "z",   // 5-12:标题后有正文(6)、不认识的小节(11)
    "## 坏线", "### 说明", "x", "### 验收", "y", "### 线", "Alpha Team", "### 说明", "again",   // 13-21:线名非法、说明写两次(20)
    "##    ", "### 说明", "x", "### 验收", "y",   // 22:空标题
    "## 没闭合", "### 说明", "```", "x",
  ].join("\n");
  const { errors } = M.parseQueueMd(bad);
  const at = (n) => errors.filter((e) => e.line === n).map((e) => e.error).join(" | ");
  assert.match(at(1), /缺「### 验收」/);
  assert.match(at(6), /标题与第一个小节之间只能空着/);
  assert.match(at(11), /不认识的小节「验证」/);
  assert.match(at(18), /「线」要写一条线名/);
  assert.match(at(20), /写了两次/);
  assert.match(at(22), /标题是空的/);
  assert.ok(errors.some((e) => /没有闭合/.test(e.error)));
  assert.match(M.parseQueueMd("只有说明,没有节").errors[0].error, /没有任何「## 标题」节/);
});

test("解析(N7):``` 与 ~~~ 分开计;同种且不短于开围栏才关;标题以 \\# 起头去掉一个反斜杠(N4)", () => {
  const BT = "`".repeat(3), TL = "~".repeat(3);
  const md = ["## " + BS + "#12 修复", "### 说明", BT, TL, "## 代码块里", BT, "### 验收", "ok", ""].join("\n");
  const { sections, errors } = M.parseQueueMd(md);
  assert.deepEqual(errors, []); assert.equal(sections.length, 1);
  assert.equal(sections[0].subject, "#12 修复");
  assert.equal(sections[0].description, [BT, TL, "## 代码块里", BT].join("\n"), "~~~ 关不了 ``` 开的代码块");
  const long = M.parseQueueMd(["## a", "### 说明", "````", BT, "## 仍在块里", "````", "### 验收", "ok"].join("\n"));
  assert.deepEqual([long.errors, long.sections[0].description], [[], ["````", BT, "## 仍在块里", "````"].join("\n")], "短于开围栏不关");
  assert.match(M.parseQueueMd(["## a", "### 说明", TL, "x"].join("\n")).errors.at(-1).error, /~~~.*没有闭合/);
});

test("清洗:控制字符、双向控制、零宽去掉,换行保留", () => {
  assert.equal(M.cleanBlock(`a${ESC}[31m${RLO}b${ZW}\r\nc d`), "a[31mb\nc\nd");
});

// ── 库层:导入(未放行、去重、整份拒绝)与导出(遮蔽、目标 + 子卡、往返)─────────────────────
function fixture(t) {
  const db = new DatabaseSync(":memory:"); store.migrate(db); t.after(() => db.close());
  const md = M.openMdHandoff({ db, store, lines: () => ["alpha", "beta"] }); md.migrate();
  const count = () => db.prepare("SELECT COUNT(*) c FROM tasks").get().c;
  return { db, md, count };
}

test("导入:一律未放行;依赖按节标题接上;同一文件再导不重复建卡并回已存在的卡号", (t) => {
  const { db, md, count } = fixture(t);
  const goal = store.add(db, { subject: "登录", kind: "goal", released: 1, actor: "operator" });
  const r = md.importMd({ text: QUEUE, line: "beta", goal });
  assert.equal(r.created.length, 2); assert.deepEqual(r.existing, []);
  const [a, b] = r.created.map((c) => store.get(db, c.id));
  assert.equal(a.released, false); assert.equal(b.released, false, "一律未放行");
  assert.equal(a.line, "alpha", "节里写的线优先"); assert.equal(b.line, "beta", "没写线 = --line");
  assert.equal(a.parent_id, goal); assert.deepEqual(b.blocked_by, [a.id], "依赖接到同一文件前面那一节建的卡");
  const n = count();
  const again = md.importMd({ text: QUEUE, line: "beta", goal });
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.existing.map((c) => c.id), [a.id, b.id], "按内容哈希去重,回已存在的卡号");
  assert.equal(count(), n, "没有多建");
  // 内容改了一个字 = 新内容 → 建新卡(只建改了的那一节和依赖它的那一节)
  //   (同一目标下标题不能重名,所以这里连标题一起改;只改正文、标题不变时库会拒绝 → 整份回滚,见下一个用例)
  const changed = md.importMd({ text: QUEUE.replace("## 写登录接口", "## 写登录接口(二版)").replace("后端接口。", "后端接口(改)。"), line: "beta", goal });
  assert.deepEqual(changed.existing.map((c) => c.id), [a.id]); assert.equal(changed.created.length, 1);
});

test("导入:任何一节不合格 = 整份拒绝、不部分导入,错误带行号;线 / 依赖 / 目标也在建卡前核", (t) => {
  const { db, md, count } = fixture(t);
  const before = count();
  const half = QUEUE + "\n## 第三节\n### 说明\n只有说明\n";
  assert.throws(() => md.importMd({ text: half }), (e) => {
    assert.equal(e.code, store.ERR.BAD_INPUT);
    assert.ok(e.errors.some((x) => x.line === 30 && /缺「### 验收」/.test(x.error)), JSON.stringify(e.errors));
    return true;
  });
  assert.equal(count(), before, "前两节合格也没有建");
  const unknownLine = QUEUE.replace("### 线\nalpha", "### 线\ngamma");
  assert.throws(() => md.importMd({ text: unknownLine }), (e) => e.errors.some((x) => x.line === 3 && /线 gamma 不在/.test(x.error)));
  const badDep = QUEUE.replace("- 写登录页", "#999, 还没出现的节");
  assert.throws(() => md.importMd({ text: badDep }), (e) => e.errors.filter((x) => x.line === 27).length === 2);
  assert.throws(() => md.importMd({ text: QUEUE, goal: 999 }), /不存在/);
  assert.throws(() => md.importMd({ text: QUEUE, line: "nope" }), /不是这块看板上的线/);
  assert.equal(count(), before);
});

test("导入:库拒绝某一节(同一目标下已有同名子卡)→ 整份回滚并点名那一节", (t) => {
  const { db, md, count } = fixture(t);
  const goal = store.add(db, { subject: "登录", kind: "goal", released: 1, actor: "operator" });
  store.add(db, { subject: "写登录接口", parentId: goal, actor: "operator" });
  const before = count();
  assert.throws(() => md.importMd({ text: QUEUE, goal }), (e) => e.errors?.[0]?.line === 19);
  assert.equal(count(), before, "第一节也回滚了");
});

test("导出:遮掉令牌 / 长 ID / 私有路径、清控制字符;目标号 = 目标 + 全部直接子卡;导出再导入往返一致", (t) => {
  const { db, md } = fixture(t);
  const goal = store.add(db, { subject: "上线", kind: "goal", description: "整体目标", released: 1, actor: "operator" });
  const a = store.add(db, { subject: `整理文档${ESC}[2J`, parentId: goal, line: "alpha", released: 1, actor: "operator",
    description: `见 ${PRIVATE_PATH} 与 ${TOKEN_LIKE},编号 ${LONG_ID}${RLO}\n# 以井号开头的一行`, acceptance: "文档齐全" });
  const b = store.add(db, { subject: "补测试", parentId: goal, blockedBy: [a], released: 1, actor: "operator", description: "加用例", acceptance: "全绿" });
  const run = store.claimById(db, { id: a, worker: "alpha", runtime: "claude", agentInstanceId: randomUUID(), expectedVersion: store.get(db, a).aggregate_version }).task.run_id;
  store.report(db, { id: a, worker: "alpha", runId: run, outcome: "done", evidence: `改了 ${PRIVATE_PATH}` });
  store.resolve(db, { id: a, verdict: "reject", note: "再补一段", resolvedBy: "human", expectedVersion: store.get(db, a).aggregate_version });

  const one = md.exportMd(a);
  for (const secret of [PRIVATE_PATH, HOME_DIR, TOKEN_LIKE, ESC, RLO]) assert.ok(!one.includes(secret), `导出里不含 ${JSON.stringify(secret.slice(0, 6))}`);
  assert.match(one, /^## 整理文档\[2J$/m);
  assert.match(one, /^\\# 以井号开头的一行$/m, "正文里的 # 行转义");
  assert.ok(one.includes(`### 回报\n\n`) && one.includes(`· alpha · 交付\n\n改了 ${HOME_REDACTED}`), one);
  assert.match(one, /### 裁定\n\n#### 第 1 次 · .* · human · 打回\n\n再补一段/);
  assert.equal(md.exportMd(424242), null);

  const whole = md.exportMd(goal);
  assert.match(whole, /^# 目标 #\d+:上线$/m); assert.match(whole, /直接子卡 2 张/);
  assert.equal((whole.match(/^## /gm) || []).length, 2, "一卡一节");
  assert.match(whole, new RegExp(`## 补测试[\\s\\S]*### 依赖\\n\\n#${a}`));

  // 往返:导出的文件原样导入到新目标下,标题 / 说明 / 验收 / 线 / 依赖一致;回报、裁定小节被跳过
  const g2 = store.add(db, { subject: "上线(副本)", kind: "goal", released: 1, actor: "operator" });
  const r = md.importMd({ text: whole, goal: g2 });
  assert.equal(r.created.length, 2);
  const [a2, b2] = r.created.map((c) => store.get(db, c.id));
  assert.equal(a2.subject, "整理文档[2J"); assert.equal(a2.line, "alpha"); assert.equal(a2.acceptance, "文档齐全");
  assert.equal(a2.description, `见 ${HOME_REDACTED} 与 …,编号 ${LONG_ID}\n# 以井号开头的一行`, "家目录换成 ~、令牌遮掉、长 ID 原样(N3)");
  assert.equal(b2.description, "加用例"); assert.deepEqual(b2.blocked_by, [a], "依赖写的是卡号,照原卡号接");
  assert.equal(a2.released, false);
  assert.deepEqual(md.importMd({ text: whole, goal: g2 }).existing.map((c) => c.id), [a2.id, b2.id]);
});

const claimReport = (db, id, worker, evidence) => {
  const run = store.claimById(db, { id, worker, runtime: "claude", agentInstanceId: randomUUID(), expectedVersion: store.get(db, id).aggregate_version }).task.run_id;
  store.report(db, { id, worker, runId: run, outcome: "done", evidence });
};
const h2Count = (md) => (md.match(/^## /gm) || []).length;

test("导出(N1):执行方名带换行与 ## / ### 也只占一行;导出再导入卡数不变", (t) => {
  const { db, md } = fixture(t);
  const goal = store.add(db, { subject: "目标", kind: "goal", released: 1, actor: "operator" });
  const a = store.add(db, { subject: "正常卡", parentId: goal, released: 1, actor: "operator", description: "x", acceptance: "y" });
  const evil = "w\n## 伪造的卡\n### 说明\n被注入\n### 验收\n无\n### 回报\n#### z";
  claimReport(db, a, evil, "交了");
  const one = md.exportMd(a), whole = md.exportMd(goal);
  assert.equal(h2Count(one), 1, one); assert.equal(h2Count(whole), 1, whole);
  assert.ok(!/^### 说明\n\n被注入/m.test(whole) && !/^## 伪造的卡/m.test(whole), whole);
  assert.match(one, /^#### 第 1 次 · .* · w ## 伪造的卡 ### 说明 被注入 ### 验收 无 ### 回报 #### z · 交付$/m);
  const g2 = store.add(db, { subject: "目标(副本)", kind: "goal", released: 1, actor: "operator" });
  const r = md.importMd({ text: whole, goal: g2 });
  assert.deepEqual(r.created.map((c) => c.subject), ["正常卡"], "只建出原有的那一张");
});

test("导出(N3/N4/N7):代码块、$ 命令、引用、反引号、URL、提交号、长标识符、空行原样往返;只遮令牌、家目录换成 ~", (t) => {
  const { db, md } = fixture(t);
  const BT = "`".repeat(3), TL = "~".repeat(3), SHA = "0123456789abcdef".repeat(2) + "01234567";
  const desc = [
    "  缩进的第一行", "> 注意:不要动 main", "$ npm test", "跑 `npm test` 看 https://github.com/org/repo/pull/12",
    `提交 ${SHA},函数 boundExecutorMayReadAndMore 要改名`, "", "", BT + "js", "# 代码里的注释", "### 验收", "", "", "## 伪造节", BT,
    BS + "#tag 原文就带反斜杠", BS + BS + "## 两个反斜杠", TL + " 波浪围栏", BT, TL,
    `令牌 ${TOKEN_LIKE} 与路径 ${PRIVATE_PATH} 换掉`].join("\n");
  const subj = "#12 修复 `x`";
  const goal = store.add(db, { subject: "目标", kind: "goal", released: 1, actor: "operator" });
  const a = store.add(db, { subject: subj, parentId: goal, released: 1, actor: "operator", description: desc, acceptance: "跑\n$ npm test\n全绿" });
  const b = store.add(db, { subject: "#13 第二张", parentId: goal, released: 1, actor: "operator", description: "未闭合\n" + BT + "\n## 这不是节", acceptance: "ok" });
  const one = md.exportMd(a);
  assert.match(one, /^## \\#12 修复 `x`$/m, "标题以 # 开头转义");
  const want = desc.replace(TOKEN_LIKE, "…").replace(PRIVATE_PATH, HOME_REDACTED);
  // 单卡往返
  const r1 = md.importMd({ text: one });
  assert.equal(r1.created.length, 1, JSON.stringify(r1));
  const a1 = store.get(db, r1.created[0].id);
  assert.equal(a1.subject, subj); assert.equal(a1.description, want); assert.equal(a1.acceptance, "跑\n$ npm test\n全绿");
  assert.equal(a1.description.split("\n").length, desc.split("\n").length, "行数不变");
  // 目标往返:两张都以 # 起头;第二张的代码块没闭合也不吞后面的节
  const whole = md.exportMd(goal);
  assert.equal(h2Count(whole), 2, whole);
  const g2 = store.add(db, { subject: "目标(副本)", kind: "goal", released: 1, actor: "operator" });
  const r = md.importMd({ text: whole, goal: g2 });
  assert.deepEqual(r.created.map((c) => c.subject), [subj, "#13 第二张"]);
  assert.equal(store.get(db, r.created[0].id).description, want);
  assert.equal(store.get(db, r.created[1].id).description, "未闭合\n" + BT + "\n## 这不是节");
});

test("导入(N5):同内容的卡已归档 → 重新建一张并点名旧卡;未归档照旧回已存在", (t) => {
  const { db, md } = fixture(t);
  const first = md.importMd({ text: QUEUE }).created;
  assert.deepEqual(md.importMd({ text: QUEUE }).existing.map((c) => c.id), first.map((c) => c.id));
  store.archive(db, { id: first[0].id, force: true });
  const again = md.importMd({ text: QUEUE });
  assert.equal(again.created.length, 2, JSON.stringify(again)); assert.equal(again.created[0].replaces_archived, first[0].id);
  assert.notEqual(again.created[0].id, first[0].id);
  assert.equal(again.created[1].replaces_archived, undefined, "依赖它的那一节内容(依赖卡号)变了,是普通新建");
  assert.deepEqual(again.existing, []);
});

test("导入(N6):--goal 只收目标卡的正整数卡号", (t) => {
  const { db, md, count } = fixture(t);
  const goal = store.add(db, { subject: "目标", kind: "goal", released: 1, actor: "operator" });
  const plain = store.add(db, { subject: "普通卡", released: 1, actor: "operator" });
  const before = count();
  for (const g of [plain, true, "1e0", 1.5, "01", -1, " 1"]) assert.throws(() => md.importMd({ text: QUEUE, goal: g }), (e) => e.code === store.ERR.BAD_INPUT, JSON.stringify(g));
  assert.equal(count(), before);
  assert.equal(md.importMd({ text: QUEUE, goal: String(goal) }).created.length, 2, "纯数字串可以");
});

// ── 服务层:真看板上的鉴权与 board.py 三个子命令 ─────────────────────────────────────────

test("真看板:鉴权;board.py export-md / import-md / report-md", { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mdhandofftest-"));
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
    const call = async (m, path, t, body) => {
      const r = await fetch(base + path, { method: m, headers: { ...(t ? { "X-Board-Token": t } : {}), "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
      return { status: r.status, body: j, text, type: r.headers.get("content-type") || "" };
    };
    const op = tok("board_token");
    const cli = (...argv) => { const r = spawnSync(PY, [join(ROOT, "cli", "board.py"), ...argv], { encoding: "utf8", windowsHide: true, cwd: dir, timeout: 60000,
      env: { ...HOST_ENV, BOARD_URL: base, BOARD_DATA_DIR: dir, BOARD_CONFIG: cfg, PYTHONIOENCODING: "utf-8" } }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };

    const made = await call("POST", "/api/tasks", op, { subject: "交接卡", line: "alpha", description: `看 ${PRIVATE_PATH}`, acceptance: "能跑" });
    assert.equal(made.status, 201, JSON.stringify(made.body) + logs.slice(-600));
    const id = made.body.task.id;

    // 鉴权:只给操作员。执行线 / 审阅令牌 403,无令牌 401;执行者令牌 403。
    const exe = join(dir, "exe.token");
    let r = cli("exec", "register", "md-ext", "--kind", "external", "--save", exe);
    assert.equal(r.code, 0, r.out);
    for (const [t, code] of [[tok("worker_token"), 403], [tok("review_token"), 403], [null, 401], [tok("exe.token"), 403]]) {
      assert.equal((await call("GET", `/api/tasks/${id}/export-md`, t)).status, code, `export ${code}`);
      assert.equal((await call("POST", "/api/tasks/import-md", t, { text: QUEUE })).status, code, `import ${code}`);
    }
    const ex = await call("GET", `/api/tasks/${id}/export-md`, op);
    assert.equal(ex.status, 200); assert.match(ex.type, /^text\/markdown/); assert.ok(!ex.text.includes(PRIVATE_PATH));
    assert.equal((await call("GET", "/api/tasks/424242/export-md", op)).status, 404);
    assert.equal((await call("POST", "/api/tasks/import-md", op, { text: 5 })).status, 400);

    // board.py import-md:建成未放行;再导一次 = 已存在;畸形文件逐条给行号、退出码非 0、一张不建
    const q = join(dir, "queue.md"); writeFileSync(q, QUEUE, "utf8");
    r = cli("import-md", q, "--line", "alpha");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /已建 #\d+\(未放行\):写登录页  ← 第 3 行/); assert.match(r.out, /新建 2 张 · 已存在 0 张/);
    r = cli("import-md", q, "--line", "alpha");
    assert.equal(r.code, 0, r.out); assert.match(r.out, /新建 0 张 · 已存在 2 张/);
    const all = async () => (await call("GET", "/api/tasks?archived=all", op)).body.tasks;
    const n = (await all()).length;
    assert.equal((await all()).filter((t) => /^写登录/.test(t.subject)).every((t) => t.released === false || t.released === 0), true);
    const badq = join(dir, "bad.md"); writeFileSync(badq, QUEUE + "\n## 少验收\n### 说明\nx\n", "utf8");
    r = cli("import-md", badq);
    assert.notEqual(r.code, 0); assert.match(r.out, /整份没有导入/); assert.match(r.out, /第 30 行:「少验收」:缺「### 验收」/);
    assert.equal((await all()).length, n, "畸形文件一张不建");

    // board.py report-md:执行者领卡后,把一份 md 当回报交付(= done --file);导出里出现这次回报
    await call("POST", `/api/tasks/${id}/release`, op, { released: true, expected_version: (await call("GET", `/api/tasks/${id}`, op)).body.task.aggregate_version });
    const ver = (await call("GET", `/api/tasks/${id}`, op)).body.task.aggregate_version;
    r = cli("take", String(id), "--version", String(ver), "--token-file", exe);
    assert.equal(r.code, 0, r.out);
    const run = /--run (\S+)/.exec(r.out)?.[1]; assert.ok(run, r.out);
    const rep = join(dir, "report.md"); writeFileSync(rep, "## 改了什么\n加了交接说明\n\n## 跑了什么\n本地自测\n", "utf8");
    assert.notEqual(cli("report-md", String(id), "--token-file", exe).code, 0, "缺文件参数拒绝");
    r = cli("report-md", String(id), rep, "--run", run, "--token-file", exe);
    assert.equal(r.code, 0, r.out); assert.match(r.out, new RegExp(`#${id} → 等待中/待验收`));
    const out = join(dir, "out.md");
    r = cli("export-md", String(id), "--out", out);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /已导出 #\d+ 到 .*\(1 节\)/);
    const text = readFileSync(out, "utf8");
    assert.match(text, /### 回报\n\n#### 第 1 次 · .* · md-ext · 交付\n\n\\## 改了什么\n加了交接说明/);
    assert.ok(!text.includes(PRIVATE_PATH));
    assert.match(cli("export-md", "424242").out, /404/);
  } finally { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});
