// 公告板 v3 合同 I8「条件放行」与 I9「候选组装卡」:板按操作者事先写下的规则,在事件发生后做一个动作。
// 事件 → 动作只登记在本文件的 RULES 一处;每次动作先写触发记录(auto_triggers,主键 = 规则 + 键)再做,所以同一件事只做一次。
//   - release_on:卡上写了 release_on:{card, event:"done"|"delivered"}(只能写在未放行的卡上)。源卡完成 / 交付 → 板放行这张卡
//     (actor = rule,卡历史 release.auto)。放行走与人放行同一条路(执行配置核对、版本号),祖先未放行时照样领不走 —— 规则不绕闸。
//     源卡不在了或已归档 → 不触发,release_on.broken = true,由人处理。
//   - assemble:目标写了 integrate.target 且 assemble:true、直属子卡全部完成 → 在目标下出一张未放行的「候选组装」卡
//     (auto_kind:"assemble",线 = 目标的线)。说明由板拼:待合提交(按依赖先后)、每笔的已核 / 自报检查与没跑的必需检查、
//     文件重叠、基线红、最后一步「推后核远端」。只出一次;之后子卡重开再完成 → 重拼说明(放行后改说明照常 spec_version +1)。
// 板不合并、不推送、不改工作仓;说明里只写相对路径、短提交号与卡号,不写本机绝对路径。
import { createHash } from "node:crypto";
import { overlapOf } from "./occupancy.mjs";

export const EVENTS = ["done", "delivered"];
const sha = (x) => createHash("sha256").update(x).digest("hex");
const short = (h) => (typeof h === "string" && h ? h.slice(0, 12) : null);

/** release_on 参数:{card, event}。null = 撤销;undefined = 不设。卡号与事件形状在这里核,卡存不存在由调用方核。 */
export function normReleaseOn(v, { err, ERR }) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw err(ERR.BAD_INPUT, "release_on 要 {card, event}");
  for (const k of Object.keys(v)) if (!["card", "event"].includes(k)) throw err(ERR.BAD_INPUT, `release_on 不认识的字段 ${k}`);
  if (!Number.isSafeInteger(v.card) || v.card < 1) throw err(ERR.BAD_INPUT, "release_on.card 要卡号(正整数)");
  if (!EVENTS.includes(v.event)) throw err(ERR.BAD_INPUT, `release_on.event 只接受 ${EVENTS.join(" / ")}`);
  return { card: v.card, event: v.event };
}

const depsOf = (k) => { try { const d = typeof k.blocked_by === "string" ? JSON.parse(k.blocked_by) : k.blocked_by; return Array.isArray(d) ? d.map(Number) : []; } catch { return []; } };
/** 子卡按依赖先后排(只看同一组里的依赖;同层按卡号)。有环时剩下的按卡号接在后面。 */
export function topoOrder(kids) {
  const ids = new Set(kids.map((k) => Number(k.id))), byId = new Map(kids.map((k) => [Number(k.id), k]));
  const indeg = new Map(), next = new Map();
  for (const k of kids) { indeg.set(Number(k.id), 0); next.set(Number(k.id), []); }
  for (const k of kids) for (const d of depsOf(k)) if (ids.has(d) && d !== Number(k.id)) { indeg.set(Number(k.id), indeg.get(Number(k.id)) + 1); next.get(d).push(Number(k.id)); }
  const out = [], ready = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort((a, b) => a - b);
  while (ready.length) {
    const id = ready.shift(); out.push(byId.get(id));
    for (const n of next.get(id)) { indeg.set(n, indeg.get(n) - 1); if (indeg.get(n) === 0) { ready.push(n); ready.sort((a, b) => a - b); } }
  }
  for (const k of [...kids].sort((a, b) => a.id - b.id)) if (!out.includes(k)) out.push(k);
  return out;
}

const STATE_TEXT = { merged: "已在目标分支里", pending: "待合", unknown: "未核(没有提交 / 没有可读的工作仓 / 还没扫到)" };
const STATUS_TEXT = { pass: "通过", fail: "未通过", unverified: "未验证" };
/**
 * 候选组装卡的卡面(纯函数)。kids = 已按依赖排好的子卡信息:
 *   { id, title, head, state, verified:[{name,status}], self:[{name,status}], missing:[name], baseline:[{check, by}], paths:[相对路径] }
 * goal = { id, title };target = 目标分支引用名;target_sha = 扫到的当前提交(没扫到 = null)。
 */
export function composeAssemble({ goal, target, target_sha = null, kids = [] }) {
  const L = [];
  L.push(`看板按目标 #${goal.id}「${goal.title}」的子卡拼出的候选组装清单。看板不合并、不推送:请在你的工作仓里照单做。`);
  L.push(`目标分支:${target}${target_sha ? `(扫到时在 ${short(target_sha)})` : "(还没扫到当前提交)"}`);
  L.push("");
  const todo = kids.filter((k) => k.state !== "merged"), done = kids.filter((k) => k.state === "merged");
  L.push(`待合提交(按依赖先后,${todo.length} 笔):`);
  if (!todo.length) L.push("  (没有:子卡的提交都已在目标分支里)");
  todo.forEach((k, i) => {
    L.push(`${i + 1}. #${k.id}「${k.title}」 — ${k.head ? "提交 " + short(k.head) : "没有交付提交(只有交付正文),要人确认怎么合"} · ${STATE_TEXT[k.state] || STATE_TEXT.unknown}`);
    const fmt = (xs) => xs.map((c) => `${c.name} ${STATUS_TEXT[c.status] || c.status}`).join("、");
    L.push(`   已核检查:${k.verified.length ? fmt(k.verified) : "无"};自报检查:${k.self.length ? fmt(k.self) : "无"}`);
    if (k.missing.length) L.push(`   没跑的必需检查:${k.missing.join("、")}`);
  });
  if (done.length) L.push(`已在目标分支里(不用再合):${done.map((k) => `#${k.id}${k.head ? " " + short(k.head) : ""}`).join("、")}`);
  L.push("");
  // 文件重叠:两张以上子卡都动了的路径(交付的 files + 操作者写的 touches)。
  const ov = new Map();
  for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++)
    for (const a of kids[i].paths) for (const b of kids[j].paths) {
      const p = overlapOf(a, b); if (p == null) continue;
      if (!ov.has(p)) ov.set(p, new Set()); ov.get(p).add(kids[i].id).add(kids[j].id);
    }
  L.push(ov.size ? "文件重叠(合的时候留意冲突):" : "文件重叠:无");
  for (const [p, ids] of [...ov.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) L.push(`  ${p}(${[...ids].sort((x, y) => x - y).map((n) => "#" + n).join("、")})`);
  const red = kids.flatMap((k) => k.baseline.map((b) => `#${k.id} ${b.check}(${b.by === "executor" ? "自报" : "已核"})`));
  L.push(red.length ? `基线已红:${red.join("、")}` : "基线已红:无");
  L.push("");
  L.push(`最后一步:推送后核远端 —— 用 git ls-remote 看远端的 ${target} 是不是你推的那个提交;对不上就别当作已合。`);
  return {
    subject: `候选组装:${goal.title}`.slice(0, 120),
    description: L.join("\n"),
    acceptance: "按清单逐笔合入目标分支、补跑没跑的必需检查;推送后远端的目标分支等于你推的提交。",
  };
}

/**
 * @param db / store    库与 store.js
 * @param cred          credibility(fields / currentDigest / currentFiles)
 * @param integ         integrate(get / summary / kidsOf / scan)
 * @param occ           occupancy(touchesOf)
 * @param release       (id) => 放行(与人放行同一条路;不满足就抛错)
 * @param afterEdit     (id) => 说明改了之后(spec 版本核对)
 * @param deliveredSince (taskId, at) => 这之后有过交付(outcome=done)
 * @param clean         (s, max) => 给人看的一行
 */
export function openAutocards({ db, store, cred, integ, occ, release, afterEdit = () => {}, deliveredSince = () => false,
                                clean = (s) => String(s ?? ""), emit = () => {}, log = () => {}, now = () => new Date().toISOString() }) {
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS release_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, kind TEXT NOT NULL,
      source INTEGER, event TEXT, by_ TEXT, at TEXT NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS release_rules_task ON release_rules(task_id, id)");
    db.exec(`CREATE TABLE IF NOT EXISTS auto_triggers (rule TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, result TEXT, PRIMARY KEY (rule, key))`);
    db.exec(`CREATE TABLE IF NOT EXISTS auto_cards (task_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, goal_id INTEGER NOT NULL, sig TEXT, at TEXT NOT NULL)`);
  }
  const trigger = (rule, key) => db.prepare("SELECT at, result FROM auto_triggers WHERE rule=? AND key=?").get(rule, String(key)) || null;
  /** 先写触发记录再做:写不进(已有)= 已经做过,返回 false。 */
  const claimTrigger = (rule, key, result = "pending") => db.prepare("INSERT OR IGNORE INTO auto_triggers(rule, key, at, result) VALUES(?,?,?,?)").run(rule, String(key), now(), result).changes > 0;
  const settle = (rule, key, result) => db.prepare("UPDATE auto_triggers SET result=? WHERE rule=? AND key=?").run(String(result).slice(0, 300), rule, String(key));

  // ── release_on ────────────────────────────────────────────────────────────────
  const currentRule = (id) => { const r = db.prepare("SELECT * FROM release_rules WHERE task_id=? ORDER BY id DESC LIMIT 1").get(Number(id)); return r && r.kind === "set" ? r : null; };
  /** 写 / 撤销。只能写在未放行、未开始的卡上;源卡要存在、未归档、不是自己。撤销随时可以(没有就是空操作)。 */
  function setReleaseOn(id, v, by) {
    const t = store.get(db, Number(id));
    if (!t) throw store.err(store.ERR.NOT_FOUND, `卡 #${id} 不存在`);
    if (v === null) {
      if (currentRule(id)) db.prepare("INSERT INTO release_rules(task_id, kind, by_, at) VALUES(?,?,?,?)").run(Number(id), "revoke", by == null ? null : String(by), now());
      return null;
    }
    if (t.released || t.status !== "not_started") throw store.err(store.ERR.CONFLICT, `release_on 只能写在未放行、未开始的卡上(#${id} ${t.released ? "已放行" : "不在未开始"})`);
    if (t.kind === "goal") throw store.err(store.ERR.BAD_INPUT, "release_on 不写在目标卡上(目标没有领取这回事)");
    if (Number(v.card) === Number(id)) throw store.err(store.ERR.BAD_INPUT, "release_on.card 不能是这张卡自己");
    const src = store.get(db, Number(v.card));
    if (!src) throw store.err(store.ERR.NOT_FOUND, `release_on.card #${v.card} 不存在`);
    if (src.archived_at) throw store.err(store.ERR.CONFLICT, `release_on.card #${v.card} 已归档`);
    db.prepare("INSERT INTO release_rules(task_id, kind, source, event, by_, at) VALUES(?,?,?,?,?,?)").run(Number(id), "set", Number(v.card), v.event, by == null ? null : String(by), now());
    return { card: Number(v.card), event: v.event };
  }
  /** 任务对象的 release_on:{card, event, broken, fired, failed};没写 = null。 */
  function releaseOnOf(t) {
    const r = t ? currentRule(t.id) : null;
    if (!r) return null;
    const src = store.get(db, Number(r.source)), trig = trigger("release_on", r.id);
    const failed = trig && String(trig.result || "").startsWith("failed") ? String(trig.result).slice("failed:".length).trim() || "放行没成功" : null;
    return { card: Number(r.source), event: r.event, broken: !src || !!src.archived_at, fired: !!trig && !failed && trig.result !== "pending", failed, at: r.at };
  }
  /** 「等条件放行」:未放行、未开始、规则有效且还没触发。首页「要本人做的事」不列这种卡(server 以阻塞码 RELEASE_ON_PENDING 表达)。 */
  function awaitsRule(t) {
    if (!t || t.released || t.status !== "not_started" || t.archived_at) return false;
    const r = releaseOnOf(t);
    return !!r && !r.broken && !r.fired && !r.failed;
  }

  async function sweepReleaseOn() {
    const rules = db.prepare(`SELECT r.* FROM release_rules r WHERE r.id = (SELECT MAX(id) FROM release_rules x WHERE x.task_id = r.task_id) AND r.kind='set'`).all();
    for (const r of rules) {
      if (trigger("release_on", r.id)) continue;
      const t = store.get(db, Number(r.task_id));
      if (!t || t.archived_at || t.released || t.status !== "not_started") continue;
      const src = store.get(db, Number(r.source));
      if (!src || src.archived_at) continue;                         // broken:不触发,由人处理
      const hit = src.status === "done" || (r.event === "delivered" && ((src.status === "waiting" && src.waiting_for === "review") || deliveredSince(src.id, r.at)));
      if (!hit) continue;
      if (!claimTrigger("release_on", r.id)) continue;
      let ok = true, why = null;
      try { release(Number(r.task_id)); } catch (e) { ok = false; why = String(e?.message || e).split("\n")[0].slice(0, 200); }
      settle("release_on", r.id, ok ? "ok" : "failed: " + why);
      try { store.appendEvent(db, { taskId: Number(r.task_id), kind: "release.auto", actor: "rule", detail: { source: Number(r.source), event: r.event, ok, ...(why ? { error: why } : {}) } }); } catch {}
      emit("release.auto", { id: Number(r.task_id), source: Number(r.source), event: r.event, ok });
      log(ok ? `#${r.task_id} 按条件放行(#${r.source} ${r.event === "done" ? "已完成" : "已交付"})` : `#${r.task_id} 条件到了但没能放行:${why}`);
    }
  }

  // ── assemble ──────────────────────────────────────────────────────────────────
  const autoRow = (id) => db.prepare("SELECT * FROM auto_cards WHERE task_id=?").get(Number(id)) || null;
  const isAuto = (id) => !!autoRow(id);
  const autoKindOf = (id) => autoRow(id)?.kind ?? null;

  function kidInfo(k, target, summary) {
    const f = cred.fields(k);
    const cur = (f.checks || []).filter((c) => !c.stale);
    const last = (by) => { const m = new Map(); for (const c of cur) if (by(c.by)) m.set(c.name, c); return [...m.values()].map((c) => ({ name: c.name, status: c.status })); };
    const verified = last((b) => b === "board" || b === "reviewer"), self = last((b) => b === "executor");
    const missing = (f.required_checks || []).filter((n) => !verified.some((c) => c.name === n && c.status === "pass"));
    const s = summary?.kids.find((x) => x.id === Number(k.id));
    const paths = [...new Set([...(f.fingerprint?.files || []).map((x) => x.path), ...occ.touchesOf(k.id)])];
    return { id: Number(k.id), title: clean(k.subject, 60), head: f.fingerprint?.head_commit ?? null, state: s?.state ?? "unknown",
             verified, self, missing, baseline: (f.baseline?.red || []).map((b) => ({ check: b.check, by: b.by })), paths, blocked_by: k.blocked_by };
  }
  async function sweepAssemble() {
    for (const g of integ.goals()) {
      if (!g.assemble) continue;
      const goal = store.get(db, Number(g.id));
      if (!goal || goal.archived_at) continue;
      const kids = integ.kidsOf(goal.id);
      if (!kids.length || !kids.every((k) => k.status === "done")) continue;
      const sig = sha(JSON.stringify([g.target, ...kids.map((k) => [Number(k.id), cred.currentDigest(k.id)])]));
      const existing = db.prepare("SELECT * FROM auto_cards WHERE goal_id=? AND kind='assemble'").get(Number(goal.id));
      if (existing && existing.sig === sig) continue;
      await integ.scan();                                            // 拼之前刷新一次整合状态(不在请求路径上)
      const summary = integ.summary(goal.id);
      const info = topoOrder(kids).map((k) => kidInfo(k, g.target, summary));
      const card = composeAssemble({ goal: { id: Number(goal.id), title: clean(goal.subject, 60) }, target: g.target, target_sha: summary?.target_sha ?? null, kids: info });
      if (!existing) {
        if (!claimTrigger("assemble", goal.id)) continue;            // 只出一次
        let id = null;
        try {
          id = store.add(db, { subject: card.subject, description: card.description, acceptance: card.acceptance, kind: "task",
                               parentId: Number(goal.id), line: goal.line ?? null, released: 0, actor: "rule" });
          db.prepare("INSERT INTO auto_cards(task_id, kind, goal_id, sig, at) VALUES(?,?,?,?,?)").run(id, "assemble", Number(goal.id), sig, now());
          settle("assemble", goal.id, "ok:" + id);
        } catch (e) { settle("assemble", goal.id, "failed: " + String(e?.message || e).split("\n")[0]); log(`目标 #${goal.id} 的候选组装卡没建成:${String(e?.message || e).split("\n")[0].slice(0, 160)}`); continue; }
        emit("task.created", { id, auto_kind: "assemble" });
        log(`目标 #${goal.id} 的子卡都完成了:出候选组装卡 #${id}(未放行)`);
        continue;
      }
      // 子卡重开再完成:重拼说明(走现有编辑路;放行后改说明 → spec_version +1)。卡归档了就不动;改不了(执行中等)只出声。
      db.prepare("UPDATE auto_cards SET sig=? WHERE task_id=?").run(sig, existing.task_id);
      const t = store.get(db, Number(existing.task_id));
      if (!t || t.archived_at) continue;
      if (t.description === card.description) continue;
      try {
        afterEdit(t.id, null);
        store.update(db, { id: t.id, description: card.description, expectedVersion: t.aggregate_version, actor: "rule" });
        afterEdit(t.id, "system");
        emit("task.updated", { id: t.id, auto_kind: "assemble" });
        log(`目标 #${goal.id} 的子卡有变:重拼候选组装卡 #${t.id} 的说明`);
      } catch (e) { log(`候选组装卡 #${t.id} 的说明没能重拼:${String(e?.message || e).split("\n")[0].slice(0, 160)}`); }
    }
  }

  // 事件 → 动作的唯一登记处。每条规则自己按「触发记录」防重;sweep 由 server 在 task.* 事件后与定时器上调用(不在请求路径上等它)。
  const RULES = [
    { name: "release_on", on: ["task.*"], run: sweepReleaseOn },
    { name: "assemble", on: ["task.*", "integrate.scan"], run: sweepAssemble },
  ];
  let running = null, again = false;
  function sweep() {
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; for (const r of RULES) { try { await r.run(); } catch (e) { log(`自动规则 ${r.name} 出错:${String(e?.message || e).split("\n")[0].slice(0, 160)}`); } } } while (again);
    })().finally(() => { running = null; });
    return running;
  }

  return { migrate, setReleaseOn, releaseOnOf, awaitsRule, isAuto, autoKindOf, sweep, RULES: RULES.map((r) => ({ name: r.name, on: r.on })) };
}
