// 对话式首页的存储:对话、消息、计划版本三张表。
// 消息与计划版本只追加(库层触发器挡 UPDATE 与 DELETE);计划的建卡标记记在对话行上,一个对话只写一次。
// 表只由看板服务创建(server.mjs 打开库后调用 migrate),store 的其他调用方不受影响。
// 这里不起进程、不建卡:协调线一轮的参数与执行在 coordinator-cli.mjs,按计划建卡在 server.mjs 的 apply 接口。
const crypto = require("crypto");
const store = require("./store.js");
const { err, ERR } = store;

// 一条用户消息随 argv 交给 CLI(Windows 命令行 32767 字符上限,见 server.mjs runCli),所以消息有长度上限。
const MESSAGE_MAX = 4000;
const TITLE_MAX = 60;
const PLAN_MAX_TASKS = 8;
const FIELD_MAX = Object.freeze({ subject: 200, summary: 500, description: 8000, acceptance: 4000, line: 64 });
const SNIPPET_MAX = 80;
const STATUSES = ["idle", "running", "failed"];
// 人能改的计划字段(合同 PUT /plans/:rev)。
const EDITABLE = Object.freeze(["enabled", "line", "subject"]);

const iso = (ms = Date.now()) => new Date(Number(ms)).toISOString();
const chars = (s) => [...String(s)].length;
const oneLine = (s, max) => {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return chars(flat) > max ? [...flat].slice(0, max - 1).join("") + "…" : flat;
};

/** 对话接口自己的拒绝:code 走 store 的分类(决定 HTTP 状态),conv_code 是合同里的机器码。 */
const refuse = (code, convCode, message, extra = {}) => Object.assign(err(code, message), { conv_code: convCode, ...extra });
const badPlan = (message, issues) => Object.assign(err(ERR.BAD_INPUT, message), { issues });

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    title_src TEXT NOT NULL DEFAULT 'auto',
    status TEXT NOT NULL DEFAULT 'idle',
    error TEXT,
    session_id TEXT NOT NULL,
    session_started INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    cwd TEXT,
    args_fp TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    usage_turns INTEGER NOT NULL DEFAULT 0,
    usage_cost REAL,
    usage_in INTEGER,
    usage_out INTEGER,
    usage_cr INTEGER,
    usage_cc INTEGER,
    applied_rev INTEGER,
    applied_at TEXT,
    applied_by TEXT,
    goal_id INTEGER,
    applied_task_ids TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    kind TEXT,
    plan_rev INTEGER,
    tools TEXT,
    usage TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS ix_conversation_messages ON conversation_messages(conversation_id, id)");
  // 计划版本:协调线一轮结束后由服务端生成,或由人改出新版本。raw 留协调线交回的原始结构化输出,只作审计。
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_plans (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    rev INTEGER NOT NULL,
    author TEXT NOT NULL,
    base_rev INTEGER,
    created_at TEXT NOT NULL,
    goal TEXT NOT NULL,
    goal_edited INTEGER NOT NULL DEFAULT 0,
    tasks TEXT NOT NULL,
    source_message_id INTEGER,
    raw TEXT,
    PRIMARY KEY (conversation_id, rev)
  )`);
  for (const t of ["conversation_messages", "conversation_plans"]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`);
  }
}

/** 看板启动时:上一个进程留下的「运行中」没有进程在跑了,标成失败并写明原因。返回被标记的对话号。 */
function recoverInterrupted(db, now = Date.now()) {
  const rows = db.prepare("SELECT id FROM conversations WHERE status='running'").all();
  for (const r of rows)
    db.prepare("UPDATE conversations SET status='failed', error=?, updated_at=? WHERE id=?")
      .run("看板重启时这一轮被中断,没有得到回复。重新发送即可。", iso(now), r.id);
  return rows.map((r) => Number(r.id));
}

const tx = (db, fn) => {
  const own = !db.isTransaction;
  db.exec(own ? "BEGIN IMMEDIATE" : "SAVEPOINT conversations_tx");
  try {
    const out = fn();
    db.exec(own ? "COMMIT" : "RELEASE conversations_tx");
    return out;
  } catch (e) {
    try { db.exec(own ? "ROLLBACK" : "ROLLBACK TO conversations_tx; RELEASE conversations_tx"); } catch {}
    throw e;
  }
};

function row(db, id) {
  const n = Number(id);
  const r = Number.isSafeInteger(n) && n > 0 ? db.prepare("SELECT * FROM conversations WHERE id=?").get(n) : null;
  if (!r) throw err(ERR.NOT_FOUND, `对话 ${id} 不存在`);
  return r;
}

const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

function planOut(conv, p) {
  if (!p) return null;
  const applied = conv.applied_rev != null && Number(conv.applied_rev) === Number(p.rev)
    ? { at: conv.applied_at, by: conv.applied_by, goal_id: Number(conv.goal_id), task_ids: parse(conv.applied_task_ids, []) } : null;
  return { rev: Number(p.rev), author: p.author, base_rev: p.base_rev == null ? null : Number(p.base_rev), created_at: p.created_at,
           goal: parse(p.goal, { subject: "", description: "" }), tasks: parse(p.tasks, []), applied };
}
const latestPlanRow = (db, convId) =>
  db.prepare("SELECT * FROM conversation_plans WHERE conversation_id=? ORDER BY rev DESC LIMIT 1").get(Number(convId));

/** 最新一版计划(没有就是 null)。goal_edited 只在服务端用(告诉协调线别改),不进接口。 */
function latestPlan(db, convId) {
  const conv = row(db, convId), p = latestPlanRow(db, convId);
  return p ? { ...planOut(conv, p), goal_edited: !!p.goal_edited } : null;
}

function messageOut(m) {
  return { id: Number(m.id), role: m.role, text: m.text, created_at: m.created_at,
           tools: m.tools ? parse(m.tools, null) : null, plan_rev: m.plan_rev == null ? null : Number(m.plan_rev), kind: m.kind ?? null };
}

function conversationOut(db, r) {
  const plan = db.prepare("SELECT MAX(rev) AS rev FROM conversation_plans WHERE conversation_id=?").get(r.id);
  const last = db.prepare("SELECT text FROM conversation_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1").get(r.id);
  return { id: Number(r.id), title: r.title, status: r.status, goal_id: r.goal_id == null ? null : Number(r.goal_id),
           plan_rev: plan?.rev == null ? null : Number(plan.rev), plan_applied: r.applied_rev != null,
           updated_at: r.updated_at, last_snippet: oneLine(last?.text ?? "", SNIPPET_MAX),
           ...(r.status === "failed" && r.error ? { error: r.error } : {}),
           usage: { turns: Number(r.usage_turns), cost_usd: r.usage_cost ?? null, in: r.usage_in ?? null,
                    out: r.usage_out ?? null, cr: r.usage_cr ?? null, cc: r.usage_cc ?? null } };
}

/** 列表:新的在前。archived=true 只列已归档的,否则只列未归档的。 */
function list(db, { archived = false } = {}) {
  const rows = db.prepare(`SELECT * FROM conversations WHERE archived_at IS ${archived ? "NOT NULL" : "NULL"}
                           ORDER BY updated_at DESC, id DESC`).all();
  return rows.map((r) => conversationOut(db, r));
}

function get(db, id) { return conversationOut(db, row(db, id)); }

function detail(db, id) {
  const r = row(db, id);
  return { conversation: conversationOut(db, r),
           messages: db.prepare("SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY id").all(r.id).map(messageOut),
           plans: db.prepare("SELECT * FROM conversation_plans WHERE conversation_id=? ORDER BY rev").all(r.id).map((p) => planOut(r, p)) };
}

function cleanMessage(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw err(ERR.BAD_INPUT, "message 必须是非空字符串");
  if (chars(raw) > MESSAGE_MAX) throw err(ERR.BAD_INPUT, `一条消息最多 ${MESSAGE_MAX} 字,实际 ${chars(raw)} 字。请分几条发`);
  return raw.trim();
}

function insertMessage(db, convId, { role, text, kind = null, planRev = null, tools = null, usage = null }, now = Date.now()) {
  const r = db.prepare(`INSERT INTO conversation_messages (conversation_id, role, text, kind, plan_rev, tools, usage, created_at)
                        VALUES (?,?,?,?,?,?,?,?)`)
    .run(Number(convId), role, String(text), kind, planRev, tools ? JSON.stringify(tools) : null, usage ? JSON.stringify(usage) : null, iso(now));
  db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(iso(now), Number(convId));
  return messageOut(db.prepare("SELECT * FROM conversation_messages WHERE id=?").get(r.lastInsertRowid));
}

/** 建对话并写入第 1 条用户消息;对话直接进入「运行中」(调用方随后起这一轮)。 */
function create(db, { message, model, effort, cwd = null } = {}, now = Date.now()) {
  const text = cleanMessage(message);
  return tx(db, () => {
    const r = db.prepare(`INSERT INTO conversations (title, status, session_id, model, effort, cwd, created_at, updated_at)
                          VALUES (?, 'running', ?, ?, ?, ?, ?, ?)`)
      .run(oneLine(text, 30) || "新对话", crypto.randomUUID(), String(model), String(effort), cwd, iso(now), iso(now));
    const turn = insertMessage(db, r.lastInsertRowid, { role: "user", text }, now);
    return { conversation: get(db, r.lastInsertRowid), turn };
  });
}

/** 续一条用户消息:同一对话同一时刻只跑一轮,正在跑就是 TURN_RUNNING。 */
function beginTurn(db, id, { message } = {}, now = Date.now()) {
  const text = cleanMessage(message);
  return tx(db, () => {
    const r = row(db, id);
    const u = db.prepare("UPDATE conversations SET status='running', error=NULL, updated_at=? WHERE id=? AND status<>'running'").run(iso(now), r.id);
    if (!u.changes) throw refuse(ERR.CONFLICT, "TURN_RUNNING", "协调线还在回复上一条消息");
    return insertMessage(db, r.id, { role: "user", text }, now);
  });
}

/** 起这一轮要用的会话参数(只在服务端用,不进接口)。 */
function session(db, id) {
  const r = row(db, id);
  return { id: Number(r.id), session_id: r.session_id, resume: !!r.session_started, model: r.model, effort: r.effort,
           status: r.status, applied: r.applied_rev != null, goal_id: r.goal_id == null ? null : Number(r.goal_id) };
}

function setSessionFacts(db, id, { cwd = null, argsFp = null } = {}) {
  db.prepare("UPDATE conversations SET cwd=?, args_fp=? WHERE id=?").run(cwd, argsFp, Number(id));
}

/** 还没得到回复的用户消息(最后一条协调线消息之后的),不含 exceptId 这一条。上一轮失败或被停止时会有。 */
function unanswered(db, id, exceptId, limit = 3) {
  const last = db.prepare("SELECT MAX(id) AS id FROM conversation_messages WHERE conversation_id=? AND role='coordinator'").get(Number(id));
  return db.prepare(`SELECT text FROM conversation_messages WHERE conversation_id=? AND role='user' AND id>? AND id<>? ORDER BY id DESC LIMIT ?`)
    .all(Number(id), Number(last?.id ?? 0), Number(exceptId), limit).map((m) => m.text).reverse();
}

const numberOrNull = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
/** 把一轮的用量累计到对话上。未知的项不计入(保持 null),不当成 0。 */
function addUsage(db, id, usage) {
  if (!usage) return;
  const add = (col, v) => { if (numberOrNull(v) != null) db.prepare(`UPDATE conversations SET ${col}=COALESCE(${col},0)+? WHERE id=?`).run(v, Number(id)); };
  db.prepare("UPDATE conversations SET usage_turns=usage_turns+1 WHERE id=?").run(Number(id));
  add("usage_cost", usage.cost_usd); add("usage_in", usage.in); add("usage_out", usage.out); add("usage_cr", usage.cr); add("usage_cc", usage.cc);
}

/** 协调线交回的计划 → 存储形。结构已由 schema 查过,这里查语义:张数、字数、依赖序号只能指向排在前面的卡。
 *  线名不在这里判:不在实现线里的线名原样留在计划上,建卡时降为「不指定线」并记进 demoted。 */
function normalizeCoordinatorPlan(raw) {
  const issues = [], flag = (n, field, message) => issues.push({ n, field, message });
  const text = (v) => typeof v === "string" ? v.trim() : "";
  const limit = (n, field, value) => { if (chars(value) > FIELD_MAX[field]) flag(n, field, `${field} 最多 ${FIELD_MAX[field]} 字,实际 ${chars(value)} 字`); };
  const goal = { subject: text(raw?.goal?.subject), description: text(raw?.goal?.description) };
  if (!goal.subject) flag(null, "goal.subject", "目标标题不能为空");
  limit(null, "subject", goal.subject); limit(null, "description", goal.description);
  const list = Array.isArray(raw?.tasks) ? raw.tasks : [];
  if (!list.length) flag(null, "tasks", "计划里没有子任务");
  if (list.length > PLAN_MAX_TASKS) flag(null, "tasks", `子任务最多 ${PLAN_MAX_TASKS} 张,实际 ${list.length} 张`);
  const tasks = list.map((t, i) => {
    const n = i + 1;
    const task = { n, subject: text(t?.subject), summary: text(t?.summary), description: text(t?.description), acceptance: text(t?.acceptance),
                   line: null, after: [], needs_confirm: t?.needs_confirm === true, needs_bash: t?.needs_bash === true, enabled: true, edited: [] };
    if (!task.subject) flag(n, "subject", "标题不能为空");
    for (const field of ["subject", "summary", "description", "acceptance"]) limit(n, field, task[field]);
    const line = text(t?.line);
    if (line && line !== "null") { task.line = line; limit(n, "line", line); }
    const after = Array.isArray(t?.after) ? t.after : [];
    for (const a of after) {
      if (!Number.isInteger(a) || a < 1 || a >= n) flag(n, "after", `after 只能填排在第 ${n} 张前面的卡的序号,收到 ${JSON.stringify(a)}`);
      else if (!task.after.includes(a)) task.after.push(a);
    }
    task.after.sort((a, b) => a - b);
    return task;
  });
  return issues.length ? { ok: false, issues } : { ok: true, plan: { goal, tasks } };
}

function insertPlan(db, convId, { author, baseRev, goal, goalEdited = false, tasks, sourceMessageId = null, raw = null }, now = Date.now()) {
  const next = Number(latestPlanRow(db, convId)?.rev ?? 0) + 1;
  db.prepare(`INSERT INTO conversation_plans (conversation_id, rev, author, base_rev, created_at, goal, goal_edited, tasks, source_message_id, raw)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(Number(convId), next, author, baseRev ?? null, iso(now), JSON.stringify(goal), goalEdited ? 1 : 0, JSON.stringify(tasks),
         sourceMessageId, raw == null ? null : JSON.stringify(raw));
  db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(iso(now), Number(convId));
  return next;
}

/** 一轮正常结束:追加协调线消息(带用量),有合格的计划就生成新版本。
 *  计划不合格、或对话已经建过卡时不生成版本,另追加一条 system 消息说明。 */
function completeTurn(db, id, { reply, title = null, plan = null, rawPlan = null, tools = null, usage = null } = {}, now = Date.now()) {
  return tx(db, () => {
    const r = row(db, id);
    let checked = null, note = null;
    if (plan != null && r.applied_rev != null)
      note = { kind: "plan_ignored", text: "这次对话已经建过卡,这一轮给出的计划没有记录。要再拆一批,请开新对话。" };
    else if (plan != null) {
      checked = normalizeCoordinatorPlan(plan);
      if (!checked.ok) note = { kind: "plan_rejected",
        text: "这一轮给出的计划没有通过检查,没有记录:" + checked.issues.slice(0, 5).map((x) => (x.n ? `第 ${x.n} 张 ` : "") + x.message).join(";") + "。可以让协调线重出。" };
    }
    const prev = Number(latestPlanRow(db, r.id)?.rev ?? 0);
    const planRev = checked?.ok ? prev + 1 : null;
    const message = insertMessage(db, r.id, { role: "coordinator", text: reply, planRev, tools, usage }, now);
    if (checked?.ok)
      insertPlan(db, r.id, { author: "coordinator", baseRev: prev || null, goal: checked.plan.goal, tasks: checked.plan.tasks,
                             sourceMessageId: message.id, raw: rawPlan ?? plan }, now);
    if (note) insertMessage(db, r.id, { role: "system", ...note }, now);
    addUsage(db, r.id, usage);
    const named = !r.usage_turns && r.title_src === "auto" && typeof title === "string" && title.trim() ? oneLine(title, TITLE_MAX) : null;
    db.prepare("UPDATE conversations SET status='idle', error=NULL, session_started=1, title=COALESCE(?, title), updated_at=? WHERE id=?")
      .run(named, iso(now), r.id);
    return { plan_rev: planRev, note: note?.kind ?? null };
  });
}

/** 一轮没有得到可用的结果:状态记为失败,原因写成人话。
 *  会话还没成功过一轮就换一个新的会话号,下一条消息从头开始:失败的首轮有没有落下会话文件看板无从知道
 *  (登录失效时 CLI 也会带回会话号),续接可能找不到会话,重用旧号可能撞上半截的会话。成功过的会话保持续接。 */
function failTurn(db, id, reason, { usage = null } = {}, now = Date.now()) {
  return tx(db, () => {
    const r = row(db, id);
    addUsage(db, r.id, usage);
    db.prepare(`UPDATE conversations SET status='failed', error=?, updated_at=?, session_id=? WHERE id=?`)
      .run(oneLine(reason, 400), iso(now), r.session_started ? r.session_id : crypto.randomUUID(), r.id);
  });
}

/** 这一轮被人停止:回到空闲,追加一条 system 消息。会话号的处理与失败相同。 */
function stopTurn(db, id, now = Date.now()) {
  return tx(db, () => {
    const r = row(db, id);
    insertMessage(db, r.id, { role: "system", kind: "stopped", text: "这一轮已停止。" }, now);
    db.prepare("UPDATE conversations SET status='idle', error=NULL, updated_at=?, session_id=? WHERE id=?")
      .run(iso(now), r.session_started ? r.session_id : crypto.randomUUID(), r.id);
  });
}

function patch(db, id, body = {}, now = Date.now()) {
  return tx(db, () => {
    const r = row(db, id);
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim()) throw err(ERR.BAD_INPUT, "title 必须是非空字符串");
      if (chars(body.title.trim()) > TITLE_MAX) throw err(ERR.BAD_INPUT, `标题最多 ${TITLE_MAX} 字`);
      db.prepare("UPDATE conversations SET title=?, title_src='human' WHERE id=?").run(body.title.trim(), r.id);
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== "boolean") throw err(ERR.BAD_INPUT, "archived 必须是布尔值");
      db.prepare("UPDATE conversations SET archived_at=? WHERE id=?").run(body.archived ? iso(now) : null, r.id);
    }
    if (body.title === undefined && body.archived === undefined) throw err(ERR.BAD_INPUT, "没有可改的字段:只接受 title、archived");
    return get(db, r.id);
  });
}

/** :rev 与 expected_rev 都必须是最新一版;已建卡的计划不能再动。 */
function currentPlan(db, r, rev, expectedRev) {
  if (r.applied_rev != null) throw refuse(ERR.CONFLICT, "PLAN_APPLIED", `这份计划已经建过卡(目标 #${r.goal_id}),不能再改或再建`);
  const latest = latestPlanRow(db, r.id);
  if (!latest) throw err(ERR.NOT_FOUND, `对话 ${r.id} 还没有计划`);
  if (!Number.isInteger(expectedRev)) throw err(ERR.BAD_INPUT, "expected_rev 必须是整数(你看到的最新版本号)");
  if (Number(rev) !== Number(latest.rev) || expectedRev !== Number(latest.rev))
    throw refuse(ERR.CONFLICT, "PLAN_CONFLICT", `计划已经更新到第 ${latest.rev} 版,请按最新一版再操作`, { current_rev: Number(latest.rev) });
  return latest;
}

/** 人改计划:出新版本 rev+1(author:"human")。只能改 enabled、line、subject 和目标标题;改过的字段记进 edited。 */
function editPlan(db, id, rev, body = {}, { implLines = [] } = {}, now = Date.now()) {
  return tx(db, () => {
    const r = row(db, id), latest = currentPlan(db, r, rev, body?.expected_rev);
    const goal = parse(latest.goal, {}), tasks = parse(latest.tasks, []);
    const issues = [], flag = (n, field, message) => issues.push({ n, field, message });
    let goalEdited = !!latest.goal_edited;
    if (body.goal !== undefined) {
      const subject = body.goal?.subject;
      if (body.goal == null || typeof body.goal !== "object" || Array.isArray(body.goal)) flag(null, "goal", "goal 必须是对象");
      else if (subject !== undefined) {
        if (typeof subject !== "string" || !subject.trim()) flag(null, "goal.subject", "目标标题不能为空");
        else if (chars(subject.trim()) > FIELD_MAX.subject) flag(null, "goal.subject", `目标标题最多 ${FIELD_MAX.subject} 字`);
        else if (subject.trim() !== goal.subject) { goal.subject = subject.trim(); goalEdited = true; }
      }
    }
    const edits = body.tasks === undefined ? [] : body.tasks;
    if (!Array.isArray(edits)) flag(null, "tasks", "tasks 必须是数组");
    const seen = new Set();
    for (const e of Array.isArray(edits) ? edits : []) {
      const task = tasks.find((t) => t.n === e?.n);
      if (!task) { flag(e?.n ?? null, "n", `计划里没有第 ${JSON.stringify(e?.n)} 张`); continue; }
      if (seen.has(task.n)) { flag(task.n, "n", `第 ${task.n} 张写了两次`); continue; }
      seen.add(task.n);
      const mark = (field, value) => { if (task[field] !== value) { task[field] = value; if (!task.edited.includes(field)) task.edited.push(field); } };
      if (e.enabled !== undefined) {
        if (typeof e.enabled !== "boolean") flag(task.n, "enabled", "enabled 必须是布尔值"); else mark("enabled", e.enabled);
      }
      if (e.line !== undefined) {
        if (e.line !== null && !implLines.includes(e.line))
          flag(task.n, "line", `线只能从实现线里选(${implLines.join(" / ") || "无"})或留空,收到 ${JSON.stringify(e.line)}`);
        else mark("line", e.line);
      }
      if (e.subject !== undefined) {
        if (typeof e.subject !== "string" || !e.subject.trim()) flag(task.n, "subject", "标题不能为空");
        else if (chars(e.subject.trim()) > FIELD_MAX.subject) flag(task.n, "subject", `标题最多 ${FIELD_MAX.subject} 字`);
        else mark("subject", e.subject.trim());
      }
    }
    if (issues.length) throw badPlan("计划的改动没有通过检查", issues);
    insertPlan(db, r.id, { author: "human", baseRev: Number(latest.rev), goal, goalEdited, tasks }, now);
    return planOut(row(db, r.id), latestPlanRow(db, r.id));
  });
}

/** 建卡前的检查:版本、是否已建卡、至少一张启用、依赖序号有效。返回要建的计划(调用方在同一事务里建卡并 markApplied)。 */
function planForApply(db, id, rev, expectedRev) {
  const r = row(db, id), latest = currentPlan(db, r, rev, expectedRev);
  const plan = planOut(r, latest), issues = [];
  if (!plan.goal?.subject) issues.push({ n: null, field: "goal.subject", message: "目标标题不能为空" });
  if (!plan.tasks.some((t) => t.enabled)) issues.push({ n: null, field: "enabled", message: "至少保留 1 张要建的卡" });
  for (const t of plan.tasks)
    for (const a of t.after || [])
      if (!Number.isInteger(a) || a < 1 || a >= t.n) issues.push({ n: t.n, field: "after", message: `依赖序号 ${JSON.stringify(a)} 无效` });
  if (issues.length) throw badPlan("这份计划现在不能建卡", issues);
  return plan;
}

/** 写建卡标记。一个对话只写得进一次(带前态条件的 UPDATE);写不进就是已经建过。 */
function markApplied(db, id, rev, { by, goalId, taskIds }, now = Date.now()) {
  const u = db.prepare(`UPDATE conversations SET applied_rev=?, applied_at=?, applied_by=?, goal_id=?, applied_task_ids=?, updated_at=?
                        WHERE id=? AND applied_rev IS NULL`)
    .run(Number(rev), iso(now), String(by), Number(goalId), JSON.stringify(taskIds), iso(now), Number(id));
  if (!u.changes) throw refuse(ERR.CONFLICT, "PLAN_APPLIED", "这份计划已经建过卡,不能再建");
  return { at: iso(now), by: String(by), goal_id: Number(goalId), task_ids: taskIds };
}

function addSystemMessage(db, id, { kind, text }, now = Date.now()) {
  return insertMessage(db, id, { role: "system", kind, text }, now);
}

/** 给协调线的看板摘要用:各线未完成的卡数、未完成的目标标题(卡面文字,调用方标为资料)。 */
function boardFacts(db, { goalLimit = 8 } = {}) {
  const open = {}; let unassigned = 0;
  for (const r of db.prepare(`SELECT line, COUNT(*) AS n FROM tasks WHERE kind='task' AND status<>'done' AND archived_at IS NULL GROUP BY line`).all()) {
    if (r.line == null) unassigned = Number(r.n); else open[r.line] = Number(r.n);
  }
  const goals = db.prepare(`SELECT id, subject FROM tasks WHERE kind='goal' AND status<>'done' AND archived_at IS NULL ORDER BY id DESC LIMIT ?`)
    .all(goalLimit).map((g) => ({ id: Number(g.id), subject: oneLine(g.subject, 60) }));
  return { open, unassigned, goals };
}

module.exports = {
  migrate, recoverInterrupted, list, get, detail, create, beginTurn, session, setSessionFacts, unanswered,
  completeTurn, failTurn, stopTurn, patch, latestPlan, editPlan, planForApply, markApplied, addSystemMessage,
  normalizeCoordinatorPlan, boardFacts, addUsage,
  MESSAGE_MAX, TITLE_MAX, PLAN_MAX_TASKS, FIELD_MAX, STATUSES, EDITABLE,
};
