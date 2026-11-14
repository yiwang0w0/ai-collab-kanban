// 首页「后台任务」(合同 F)与第 6 波「看清」(合同 G1–G4):GET /api/home/background 的组装、「停止」能不能按的判定、
// 「建卡后自动开工」的逐线走闸、GET /api/home/quota 的额度条。
// 本文件全是纯函数:库、时钟、进程表都由 server 注入(whoOf / sinceOf / stopOf / lineOf / gateOf / start),这里不读不写。
// 只读状态字段,不解析回报正文;判不出的一律给 null / none,不编。
// 「要本人做的事」不另写判定:server 把助手简报那一份(core/brief.mjs 的 briefModel,底下是首页 homeLists + 线故障)传进来原样放进 attention。
import { redactText, cut } from "./flow.mjs";
import { effectiveReadings, stateOf, runwayOf, readingOut, ledgerOut, QUOTA_LOW_DEFAULT } from "./pool-readings.mjs";

export const DONE_WINDOW_MS = 24 * 3600000;   // 「已完成」= 近 24 小时内完成的
export const DONE_MAX = 20, RUNNING_MAX = 100;
const TITLE_MAX = 80;
const clean = (s, max = TITLE_MAX) => cut(redactText(String(s ?? "")), max);

// ── G1:运行中 = 「已放行、未完成、不在本人手上」的全部卡,面板与接口同一份 ──────────────────────────────
export const NOTE_FRESH_MS = 15 * 60000;   // live_note 多久内算「新鲜」:超过就不当作一句实时进度
export const ONE_LINE_CODES = ["stalled", "line_stopped", "seat_not_ready", "pool_down", "source_gate", "wip_limit",
  "waiting_dep", "waiting_review_auto", "waiting_peer", "rearm", "unclaimed",
  // 合同 I5(第 8 波):被取代 / 依赖没做完就归档 / 要的资源被占 / 执行锁被占(原先混在 waiting_dep 里)。
  "superseded", "dep_archived", "resource_busy", "lock_held"];
const DEP_BLOCKERS = new Set(["DEPENDENCIES_UNFINISHED", "ANCESTOR_NOT_RELEASED", "CHILDREN_UNFINISHED"]);

/** 心跳新鲜度,与面板 hbClass 同一判据:租约过了 / 没有心跳 / 静默超过 3 分钟 = dead,超过 1 分钟 = stale。 */
export function hbOf(t, now) {
  if (!t || t.status !== "in_progress") return "";
  if (t.lease_until && now > t.lease_until) return "dead";
  if (!t.heartbeat_at) return "dead";
  const age = (now - t.heartbeat_at) / 1000;
  return age > 180 ? "dead" : age > 60 ? "stale" : "fresh";
}
const blockersOf = (t) => (Array.isArray(t?.progress_blockers) ? t.progress_blockers : []).filter((b) => b && typeof b.code === "string");
const idsOf = (b) => (Array.isArray(b?.related_task_ids) ? b.related_task_ids : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
const depLabel = (ids) => ids.length ? "等 " + ids.slice(0, 3).map((n) => "#" + n).join("、") + (ids.length > 3 ? " 等" : "") : "等依赖";
const oneLine = (kind, code = null, params = {}, text = null, at = null) => ({ kind, code, params, text, at });

/** 这张卡算不算「运行中」:已放行、未完成、不在本人手上(attentionIds = 要本人做的事里出现的卡号)。目标卡不算。 */
export function isRunning(t, attentionIds = new Set()) {
  if (!t || t.archived_at || t.kind === "goal" || t.status === "done") return false;
  if (attentionIds.has(Number(t.id))) return false;
  if (t.status === "in_progress" || t.status === "waiting") return true;
  if (t.status === "not_started") return !!t.released && !t.human_gate;
  return false;
}

/**
 * 一行的 holder 与 one_line。ctx:{ now, who(= whoOf 的结果), since(= sinceOf), lineOf(line) → 线的现况 | null,
 * lineLabel(line) → 显示名, sourceGate() → 源码闸没过 = true }。线的现况 = { managed, running, pool_down, seat:座席闸码 | null }。
 */
export function holderAndLine(t, ctx = {}) {
  const now = ctx.now ?? 0, bl = blockersOf(t), ls = t.line ? (ctx.lineOf?.(t.line) ?? null) : null;
  const updated = t.updated_at || null;
  if (t.status === "in_progress") {
    const holder = { kind: "ai", label: ctx.who?.label ? String(ctx.who.label) : t.worker ? clean(t.worker, 32) : "AI", since: ctx.since ?? null };
    if (hbOf(t, now) === "dead") {
      if (ls?.managed && !ls.running) return { holder, one_line: oneLine("blocked", "line_stopped", { line: t.line }) };
      return { holder, one_line: oneLine("blocked", "stalled", { heartbeat_at: t.heartbeat_at ? new Date(t.heartbeat_at).toISOString() : null }) };
    }
    const at = Date.parse(t.live_note_at || "");
    if (typeof t.live_note === "string" && t.live_note.trim() && Number.isFinite(at) && now - at <= NOTE_FRESH_MS)
      return { holder, one_line: oneLine("progress", null, {}, clean(t.live_note, 120), t.live_note_at) };
    return { holder, one_line: oneLine("none") };
  }
  if (t.status === "waiting") {
    if (t.waiting_for === "review") return { holder: { kind: "reviewer", label: "自动审阅", since: updated }, one_line: oneLine("waiting", "waiting_review_auto") };
    if (t.waiting_for === "rearm") {
      const kids = idsOf(bl.find((b) => b.code === "CHILDREN_UNFINISHED"));
      return { holder: { kind: "dep", label: depLabel(kids), since: updated }, one_line: oneLine("waiting", "rearm", { ids: kids }) };
    }
    return { holder: { kind: "dep", label: "等待中", since: updated }, one_line: oneLine("none") };
  }
  // 未开始、已放行:跨机等对端 → 等依赖 → 同树在途上限 → 排队(看线能不能来领)。
  const released = t.execution_trace?.released_at || updated;
  if (bl.some((b) => b.code === "DELEGATION_NOT_READY"))
    return { holder: { kind: "peer", label: "对端电脑", since: released }, one_line: oneLine("waiting", "waiting_peer") };
  const holder = { kind: "queue", label: t.line ? clean(ctx.lineLabel?.(t.line) || t.line, 32) : "未指定线", since: released };
  // 合同 I5:码与参数取自 progress_blockers(= store.claimBlockers);文案在面板按 code + params 拼,这里不写句子。
  const sup = bl.find((b) => b.code === "SUPERSEDED"), supBy = Number(sup?.detail?.by);
  if (sup) return { holder, one_line: oneLine("blocked", "superseded", { by: Number.isSafeInteger(supBy) ? supBy : null }) };
  const arch = bl.find((b) => b.code === "DEP_ARCHIVED");
  if (arch) return { holder: { kind: "dep", label: depLabel(idsOf(arch)), since: released }, one_line: oneLine("blocked", "dep_archived", { ids: idsOf(arch) }) };
  const dep = bl.find((b) => DEP_BLOCKERS.has(b.code));
  if (dep) return { holder: { kind: "dep", label: depLabel(idsOf(dep)), since: released }, one_line: oneLine("waiting", "waiting_dep", { ids: idsOf(dep) }) };
  const lock = bl.find((b) => b.code === "LOCK_HELD");
  if (lock) return { holder: { kind: "dep", label: depLabel(idsOf(lock)), since: released }, one_line: oneLine("waiting", "lock_held", { ids: idsOf(lock) }) };
  const busy = bl.find((b) => b.code === "RESOURCE_BUSY");
  if (busy) {
    const rs = (Array.isArray(busy.detail?.resources) ? busy.detail.resources : []).filter((r) => r && typeof r.resource === "string");
    const names = [...new Set(rs.map((r) => clean(r.resource, 80)))];
    return { holder: { kind: "dep", label: names.length ? "等资源 " + names.slice(0, 2).join("、") : "等资源", since: released },
             one_line: oneLine("waiting", "resource_busy", { resources: names, ids: idsOf(busy),
               locks: [...new Set(rs.filter((r) => r.kind === "lock" && Number.isSafeInteger(r.lock_id)).map((r) => r.lock_id))] }) };
  }
  const wip = bl.find((b) => b.code === "ROOT_WIP_LIMIT");
  if (wip) return { holder, one_line: oneLine("blocked", "wip_limit", { ids: idsOf(wip) }) };
  if (bl.length) return { holder, one_line: oneLine("none") };   // 别的阻塞(次数上限、任务树…):原因在侧栏,这里不编
  if (ls?.managed && !ls.running) {
    if (ctx.sourceGate?.()) return { holder, one_line: oneLine("blocked", "source_gate", { line: t.line }) };
    if (ls.seat) return { holder, one_line: oneLine("blocked", "seat_not_ready", { line: t.line, seat: String(ls.seat) }) };
    if (ls.pool_down) return { holder, one_line: oneLine("blocked", "pool_down", { line: t.line }) };
    return { holder, one_line: oneLine("blocked", "line_stopped", { line: t.line }) };
  }
  const rel = Date.parse(released || "");
  if (Number.isFinite(rel) && rel <= now) return { holder, one_line: oneLine("waiting", "unclaimed", { minutes: Math.floor((now - rel) / 60000) }) };
  return { holder, one_line: oneLine("none") };
}
/** 排队 = holder 为 queue / dep 的行(组头「排队 M」,排在后面、弱化)。 */
export const isQueued = (r) => r?.holder?.kind === "queue" || r?.holder?.kind === "dep";

// ── G2:要本人做的事 = briefModel 的 attention 原样 + type / verb / evidence / detail,不另写判定 ───────────────
// type / verb 只有一份:panel.html home-model 区的 homeAttnType(homeLists 写在每一行上),server 按行对上后放进条目;
//   这里只读条目上的 type,不再自己从 kind 推(第 6 波欠账:原先面板与这里各有一张对照表)。
const UNLOCKS_MAX = 5, ASK_MAX = 200;
const oneText = (v) => typeof v === "string" && v.trim() ? cut(redactText(v.replace(/\s+/g, " ").trim()), ASK_MAX) : null;
/** 一句证据:只取结构化字段(自动审阅看过没有、方案个数、打回次数);只有自报时写「<执行者> 自报完成 · 未经复核」;没有 = null。 */
export function evidenceOf(type, t, who) {
  if (!t) return null;
  const seg = [];
  if (type === "accept") {
    if (t.auto_review_at) seg.push("自动审阅看过,留给你验收");
    else if (who?.label) seg.push(clean(who.label, 24) + " 自报完成 · 未经复核");
  }
  if ((type === "decide" || type === "confirm") && Array.isArray(t.decision_package?.options) && t.decision_package.options.length)
    seg.push("有 " + t.decision_package.options.length + " 个方案可选");
  const back = Number(t.handed_back) || 0;
  if (back > 0 && ["accept", "decide", "confirm"].includes(type)) seg.push("打回过 " + back + " 次");
  return seg.length ? seg.join(" · ") : null;
}
/** 解锁的下游 = blocked_by 里有本卡号的未完成卡(现有依赖关系),按卡号,≤5 条 + 总数。 */
export function unlocksOf(t, work = []) {
  if (!t) return { unlocks: [], unlocks_total: 0 };
  const id = Number(t.id), out = [];
  for (const x of work) {
    if (!x || x.archived_at || x.status === "done" || Number(x.id) === id) continue;
    let deps; try { deps = typeof x.blocked_by === "string" ? JSON.parse(x.blocked_by) : x.blocked_by; } catch { deps = null; }
    if (Array.isArray(deps) && deps.map(Number).includes(id)) out.push({ id: Number(x.id), title: clean(x.subject, 60) });
  }
  out.sort((a, b) => a.id - b.id);
  return { unlocks: out.slice(0, UNLOCKS_MAX), unlocks_total: out.length };
}
/** 来源:助手挂的卡 = posted_by。origin 是对方自报(G6),只认两个值,缺省 = null(面板不写来源措辞);quote 只跟「本人原话」走。 */
export function sourceOf(t) {
  const p = t?.posted_by;
  if (!p || typeof p.label !== "string" || !p.label.trim()) return null;
  const origin = p.origin === "operator_said" || p.origin === "ai_inferred" ? p.origin : null;
  const quote = origin === "operator_said" ? oneText(p.quote) : null;
  return { label: clean(p.label, 24), origin, ...(quote ? { quote } : {}) };
}
/** server 把首页判定的 type / verb(homeLists 写在行上的那一份)按顺序对到 attention 条目上。条数对不上就都不给 type,
 *  并在应答里标 attention_type_mismatch:true(面板据此决定怎么显示;第 7 波欠账⑥:原先只打一行日志)。
 *  shown = 截过的条目;allCount = 截前条数;kinds = [{type, verb}](先 mine 各行、后线故障,与 briefModel 同序)。 */
export function typeAttention(shown = [], allCount = 0, kinds = []) {
  const typed = kinds.length === allCount;
  return { attention: shown.map((a, i) => (typed ? { ...a, ...kinds[i] } : a)), mismatch: !typed };
}
/** 一条 attention 加上 G2 的四个字段。work = 本板未归档的非目标卡(找下游用)。
 *  合同 I10d:包的条目(带 package_id)—— packageOf(id) 给 { name, label, expect, why? }:做什么 = 跑包「名」(fault = 为什么先别跑),
 *  实物在哪 = label,期待 = expect(expect_by:"executor" = 对方写的),解锁 = 依赖这张卡的下游。 */
export function attentionDecor(a, t, { work = [], whoOf = () => null, packageOf = () => null } = {}) {
  const type = typeof a?.type === "string" ? a.type : null, ask = t?.ask && typeof t.ask === "object" ? t.ask : null;
  const pk = a?.package_id != null ? packageOf(Number(a.package_id)) : null;
  if (pk) return { ...a, type, verb: typeof a?.verb === "string" ? a.verb : null, evidence: null,
    package: { id: Number(a.package_id), name: oneText(pk.name), frozen: pk.frozen ?? null },
    detail: { what: pk.why ? oneText(pk.why) : oneText(`跑包「${pk.name}」`), where: oneText(pk.label), expect: oneText(pk.expect),
              expect_by: pk.expect ? "executor" : null, ...unlocksOf(t, work), source: sourceOf(t) } };
  const why = blockersOf(t).find((b) => b.code !== "NOT_RELEASED" && typeof b.message === "string" && b.message.trim());
  return { ...a, type, verb: typeof a?.verb === "string" ? a.verb : null, evidence: evidenceOf(type, t, t ? whoOf(t) : null),
           detail: { what: oneText(ask?.what) ?? (why ? clean(why.message, ASK_MAX) : null), where: oneText(ask?.where), expect: oneText(ask?.expect),
                     ...unlocksOf(t, work), source: sourceOf(t) } };
}

// ── G4:计划组头的流水线四段 ───────────────────────────────────────────────────────────────────────────
export const STAGES = ["decompose", "execute", "integrate", "accept", "done"];
/**
 * 由目标卡与它的直属子卡得出所在段:目标完成 = done;没有子卡、或拆好了还没放行 = decompose;
 * 子卡没做完 = execute(没做完的全都在等本人验收 / 裁定时 = accept);子卡全做完而目标还没收尾 = accept。
 * 「整合」(合同 I7):目标写了 integrate 时,integ = server 从缓存给的汇总 { merged, pending, unknown, target, target_sha, all_done }
 *   (all_done = 除候选组装卡外的直属子卡全完成);全完成且有待合 = integrate。stage_detail.integrate 照实给;没写 integrate 的目标同现状。
 * 读不到计数 = null。
 */
export function stageOf(goal, kids = [], integ = null) {
  if (!goal) return { stage: null, stage_detail: null };
  const total = Number.isInteger(goal.children_total) ? goal.children_total : null, done = Number.isInteger(goal.children_done) ? goal.children_done : null;
  const base = total === null || done === null ? null : { done, total };
  const detail = base && integ ? { ...base, integrate: { merged: integ.merged | 0, pending: integ.pending | 0, unknown: integ.unknown | 0,
    target: typeof integ.target === "string" ? integ.target : null, target_sha: typeof integ.target_sha === "string" ? integ.target_sha : null } } : base;
  if (goal.status === "done") return { stage: "done", stage_detail: detail };
  if (!detail) return { stage: null, stage_detail: null };
  if (integ && integ.all_done === true && (integ.pending | 0) > 0) return { stage: "integrate", stage_detail: detail };
  if (total === 0 || (goal.status === "not_started" && !goal.released)) return { stage: "decompose", stage_detail: detail };
  if (done < total) {
    const open = kids.filter((k) => k && !k.archived_at && k.status !== "done");
    const human = open.length > 0 && open.every((k) => k.status === "waiting" && ["review", "confirm", "decision"].includes(k.waiting_for));
    return { stage: human ? "accept" : "execute", stage_detail: detail };
  }
  return { stage: "accept", stage_detail: detail };
}

// ── G3 / J2.3:额度条(只读)───────────────────────────────────────────────────────────────────────────
/**
 * pools = [{ id, label, exhausted_at, until, readings?, ledger? }]:
 *   exhausted_at / until = server 的 poolState(看板只在调用被限流时记「用完」;until 是看板自定的复查时刻,不是供应商的重置时刻);
 *   readings = 这一池近 7 天的池读数行(合同 J2.2,自报;core/pool-readings.mjs);ledger = 账本按池按窗的合计(usage.mjs poolWindows 的一项)。
 * down 只来自限流记录;low / ok 只来自新鲜读数(任一窗 used_pct ≥ lowAt = low);没有新鲜读数 = unknown(「待核实」),不当作 ok。
 * 旧字段保持兼容(G3 面板在读):windows[] = down 时一格「看板暂停到」,ok / low 时 = 各窗新鲜读数,unknown 时一格空的「用量」;
 * runway 的 basis / minutes。新字段(J2.3)readings / ledger 只在调用方给了 readings 或 ledger 时出现(纯函数旧调用方的输出不变)。
 * labelOf(row) = 读数的 by_label(操作者「你」/ 执行者的登记名;由 server 给,已脱敏)。
 */
export function quotaModel({ pools = [], now = 0, lowAt = QUOTA_LOW_DEFAULT, labelOf = () => null } = {}) {
  return { pools: pools.map((p) => {
    const down = !!p.exhausted_at, until = Date.parse(p.until || "");
    const base = { id: String(p.id), label: clean(p.label || p.id, 24) };
    const extended = Object.hasOwn(p, "readings") || Object.hasOwn(p, "ledger");
    if (!extended)
      return { ...base, windows: [{ label: down ? "看板暂停到" : "用量", used_pct: null, resets_at: down && Number.isFinite(until) ? new Date(until).toISOString() : null }],
               state: down ? "down" : "unknown", runway: { minutes: null, basis: "unknown" } };
    const rows = Array.isArray(p.readings) ? p.readings : [];
    const eff = effectiveReadings(rows, now), state = stateOf({ down, effective: eff, lowAt });
    const fresh = eff.filter((e) => !e.stale);
    const windows = state === "down" ? [{ label: "看板暂停到", used_pct: null, resets_at: Number.isFinite(until) ? new Date(until).toISOString() : null }]
      : state === "unknown" ? [{ label: "用量", used_pct: null, resets_at: null }]
      : fresh.map((e) => ({ label: e.window, used_pct: e.row.used_pct, resets_at: e.row.resets_at ?? null }));
    const runway = state === "down" ? { basis: "unknown", minutes: null } : runwayOf(rows, now);
    return { ...base, windows, state, runway, readings: eff.map((e) => readingOut(e, labelOf)), ledger: ledgerOut(p.ledger) };
  }), generated_at: Number.isFinite(now) ? new Date(now).toISOString() : null };
}

/** 往上找所属目标(最多 10 层):{ id, title } 或 null。目标卡自己不算属于自己。 */
export function goalOf(t, byId) {
  let cur = t, g = 0;
  while (cur && cur.parent_id != null && g++ < 10) {
    const up = byId.get(Number(cur.parent_id));
    if (!up) return null;
    if (up.kind === "goal") return { id: Number(up.id), title: clean(up.subject, 60) };
    cur = up;
  }
  return null;
}

/**
 * 应答体。tasks = 本板未归档的卡(taskOut 形:带 live_note / handed_back / children_done / children_total);
 * attention = briefModel(...).attention(已截到 20 条),attentionTotal = 截前条数;
 * whoOf(t) → { label, kind:"managed"|"external", runtime, model } | null;sinceOf(t) → 这一轮领取时刻 | null;
 * stopOf(t) → { stoppable, reason? }。now = 毫秒。
 */
export function backgroundModel({ tasks = [], attention = [], attentionTotal = null, now = 0,
                                  whoOf = () => null, sinceOf = () => null, stopOf = () => ({ stoppable: false }),
                                  lineOf = () => null, lineLabel = (l) => l, sourceGate = () => false, attentionIds = null,
                                  integrationOf = () => null, packageOf = () => null } = {}) {
  const live = tasks.filter((t) => t && !t.archived_at);
  const byId = new Map(live.map((t) => [Number(t.id), t]));
  const work = live.filter((t) => t.kind !== "goal");
  // G2:attention 原样(同一份判定)+ type / verb / evidence / detail。
  attention = attention.map((a) => attentionDecor(a, a?.task_id != null ? byId.get(Number(a.task_id)) ?? null : null, { work, whoOf, packageOf }));
  // G1:运行中 = 已放行、未完成、不在本人手上;在跑的(ai / reviewer / peer)按开始先后在前,排队的(queue / dep)在后。
  // attentionIds = 截到 20 条之前的全部卡号(server 从 homeLists 给);没给就用 attention 里的。
  const attIds = new Set(attentionIds ? [...attentionIds].map(Number) : attention.filter((a) => a?.task_id != null).map((a) => Number(a.task_id)));
  let gate; const gateOnce = () => (gate ??= !!sourceGate());
  const running = work.filter((t) => isRunning(t, attIds)).map((t) => {
    const busy = t.status === "in_progress", s = busy ? stopOf(t) || {} : { stoppable: false };
    const who = busy ? whoOf(t) ?? null : null, since = busy ? sinceOf(t) ?? null : null;
    const h = holderAndLine(t, { now, who, since, lineOf, lineLabel, sourceGate: gateOnce });
    return { task_id: Number(t.id), title: clean(t.subject), goal: goalOf(t, byId), who, since,
             live_note: typeof t.live_note === "string" ? t.live_note : null, live_note_at: t.live_note_at ?? null,
             stoppable: s.stoppable === true, ...(busy && s.reason ? { stop_note: String(s.reason) } : {}),
             holder: h.holder, one_line: h.one_line };
  }).sort((a, b) => isQueued(a) - isQueued(b) || String(a.holder.since || "~").localeCompare(String(b.holder.since || "~")) || a.task_id - b.task_id);
  const done = work.filter((t) => {
    if (t.status !== "done") return false;
    const at = Date.parse(t.updated_at);
    return Number.isFinite(at) && at <= now && now - at <= DONE_WINDOW_MS;
  }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id).slice(0, DONE_MAX)
    .map((t) => ({ task_id: Number(t.id), title: clean(t.subject), goal: goalOf(t, byId), who: whoOf(t) ?? null,
                   done_at: t.updated_at, handed_back: Number(t.handed_back) || 0, resolved_by: t.resolved_by ?? null }));
  // 组:出现在三组里任何一项所属的目标。total / done 用目标卡上与流转条同口径的 children_total / children_done(直属子卡);
  // running = 「运行中」里归到这个目标、不在排队的张数;queued = 排队的张数;stage / stage_detail = G4 流水线四段。
  // 目标读不到(已归档等)就不出组,行上的 goal 照旧。
  const order = [], seen = new Set();
  const note = (g) => { if (g && !seen.has(g.id)) { seen.add(g.id); order.push(g.id); } };
  for (const a of attention) if (a?.task_id != null) { const t = byId.get(Number(a.task_id)); note(t?.kind === "goal" ? null : t && goalOf(t, byId)); }
  for (const r of running) note(r.goal);
  for (const d of done) note(d.goal);
  const groups = order.map((id) => byId.get(id)).filter(Boolean).map((g) => ({
    goal_id: Number(g.id), title: clean(g.subject, 60),
    total: Number.isInteger(g.children_total) ? g.children_total : null, done: Number.isInteger(g.children_done) ? g.children_done : null,
    running: running.filter((r) => r.goal?.id === Number(g.id) && !isQueued(r)).length,
    queued: running.filter((r) => r.goal?.id === Number(g.id) && isQueued(r)).length,
    ...stageOf(g, work.filter((k) => Number(k.parent_id) === Number(g.id)), integrationOf(g) ?? null) }));
  return { attention, attention_total: attentionTotal ?? attention.length,
           running: running.slice(0, RUNNING_MAX), running_total: running.length, queued_total: running.filter(isQueued).length, done, groups,
           generated_at: Number.isFinite(now) ? new Date(now).toISOString() : null };
}

/**
 * 「停止」能不能按。只有受管线(看板自己起的进程)上、这一轮由该线槽位领着的卡才能停:
 *   外部执行者 → 不能(只能在「接入的 AI」里撤销);领卡方不是任何受管线的槽位 → 不能(看板没有它的进程);
 *   该线这一刻有 2 个以上槽在跑 → 不能(现有停线是整条线停,会连带别的槽手上的卡;到设置里停)。
 * ctx:{ isExecutor(worker), lineOfWorker(worker) → 受管线 id | null, external(line), liveSlots(line) → 在跑的槽数 }
 */
export function stopVerdict(t, ctx) {
  if (!t || t.status !== "in_progress") return { stoppable: false, reason: "这张卡不在执行中" };
  if (ctx.isExecutor(t.worker)) return { stoppable: false, reason: "外部 AI,只能在「接入的 AI」里撤销" };
  const line = ctx.lineOfWorker(t.worker);
  if (!line || ctx.external(line)) return { stoppable: false, reason: "领这张卡的不是看板起的执行线,看板停不了它" };
  const n = ctx.liveSlots(line);
  if (n > 1) return { stoppable: false, line, reason: `这条线有 ${n} 个槽在跑,停止会连带别的卡;要停到设置里停整条线` };
  return { stoppable: true, line };
}

/**
 * 建卡后自动开工:对计划里用到的线逐条走闸、起线。顺序 = 线在 lines 里第一次出现的顺序。
 * deps:{ external(line), supervised(line), running(line), gateOf(line) → 拦下的原因 | null, start(line)(抛错 = 没起来,用错误信息作原因) }
 * 返回 { started:[线], blocked:[{line, reason}], already_running:[线] };外部线不进任何一组(等对方来领)。
 */
export function runAutostart(lines, deps) {
  const out = { started: [], blocked: [], already_running: [] };
  for (const line of [...new Set((lines || []).filter((x) => typeof x === "string" && x))]) {
    if (deps.external(line)) continue;
    if (!deps.supervised(line)) { out.blocked.push({ line, reason: "不是看板管的执行线" }); continue; }
    if (deps.running(line)) { out.already_running.push(line); continue; }
    const gate = deps.gateOf(line);
    if (gate) { out.blocked.push({ line, reason: String(gate) }); continue; }
    try { deps.start(line); out.started.push(line); }
    catch (e) { out.blocked.push({ line, reason: cut(String(e?.message || e), 160) }); }
  }
  return out;
}

/** 对话里那条 system 消息:「已让 2 条线开工;线「X」没起来:座席未解禁。」 labelOf(line) → 显示名。 */
export function autostartText(r, labelOf = (l) => l) {
  const name = (l) => "「" + (labelOf(l) || l) + "」";
  const seg = [];
  seg.push(r.started.length ? `已让 ${r.started.length} 条线开工(${r.started.map(name).join("、")})` : "没有线开工");
  if (r.already_running.length) seg.push(`${r.already_running.map(name).join("、")}本来就在跑`);
  for (const b of r.blocked) seg.push(`线${name(b.line)}没起来:${b.reason}`);
  return redactText(seg.join(";") + "。");
}
