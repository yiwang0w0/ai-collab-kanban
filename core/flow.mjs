// 公告板 v3 合同 B 节「流转」:按卡的历史、任务派生字段(handed_back / last_actor / last_actor_kind)、
// 建卡对话的进度(conversation.progress 与那一条原位更新的 kind:"progress" 系统消息)。
// 只读 task_events / task_runs / tasks / conversations;自己只写一张可变小表 conversation_progress(每个对话至多一行)。
// 对话消息表是只追加的(库层触发器挡 UPDATE),所以「原位更新」的那条进度消息不放在消息表里,读详情时按位置并进 messages。
//
// ── step(历史条目)由事件 kind 判定 ─────────────────────────────────────────────
//   add → created                     release(action=release) → released   release(action=hold) → other(收回放行)
//   claim → claimed                   process_started → started             report → reported
//   resolve(disposition=close)→accepted  resolve(hand_back)→handed_back     resolve(hold_for_review) → other
//     旧事件没有 disposition:按 detail.status 判(done→accepted、not_started→handed_back、其余 other)
//   reopen → reopened                 reap、release(action=release_held) → reaped
//   其余(set_line / set_parent / report_overridden / review.* / 自动审阅的 decision.recorded / snapshot …)→ other
//   不出条目:evidence.recorded(report 已有一条)、resolve 自己的 decision.recorded(并进上一条 resolve 当原因)、
//   execution.* / run_identity(执行器内部观察,量大且不是流转)
// ── actor_kind ────────────────────────────────────────────────────────────────
//   human   : human / operator / local / panel / approval-token:*(人按的,经面板、操作员令牌或远程批准)
//   auto    : auto / review(自动审阅与审阅线的裁定)
//   executor: coord 登记过的执行者 id
//   line    : 配置里的线 id 或其并行槽 <线>@<k>;以及领取/启动/交付这几类事件里其余的执行方名字
//   system  : 其余(system / migration / lease-reaper / cascade / decompose… 看板自己做的)
// ── progress.step(子卡当前状态,与面板侧栏五步条 sideSteps 同义)───────────────────
//   5 完成        status=done                                 (sideSteps 第 5 步「人工验收」done)
//   4 已回传      status=waiting(待验收/待决定/等子卡…)       (第 4 步「回传」done,有 result)
//   3 已启动      status=in_progress 且当前 run 有 process_started (第 3 步「启动」observed);
//                 外部执行者(凭码/令牌接入,不发 process_started)= 当前 run 领取之后有过一次心跳(由 server 注入 heartbeatStarted)
//   2 已领取      status=in_progress,尚无本轮启动记录          (第 2 步「领取」done)
//   1 等领取      status=not_started 且已放行                  (第 1 步「放行」done)
//   0 未放行      status=not_started 且未放行

export const FLOW_COALESCE_MS = 2000;
const HUMAN = new Set(["human", "operator", "local", "panel"]);
const AUTO = new Set(["auto", "review"]);
const WORKER_KINDS = new Set(["claim", "process_started", "report"]);
const SKIP = new Set(["evidence.recorded", "run_identity"]);
const WAIT_TEXT = { review: "待验收", confirm: "待选择方案", decision: "待决定", dep: "等前置卡", rearm: "等子卡" };
const chars = (s) => [...String(s)];
export const cut = (s, max) => { const c = chars(String(s ?? "").replace(/\s+/g, " ").trim()); return c.length > max ? c.slice(0, max - 1).join("") + "…" : c.join(""); };

// ── 路径 / 令牌样串的遮蔽(redactText;safeText = 遮蔽 + 截断)────────────────────────────
// 宁可多遮:遮掉的是给人看的摘要里的一段,不影响任何判定。可被别的模块复用(如 live_note)。
//   路径:X:\ 与 X:/(含 file:///)、UNC(\\主机\ 与 //主机/)、%VAR%\ 与 $VAR/ $env:VAR\、~ 与 ~用户/、
//         /c/… /mnt/c/… /Users/… /home/… 等绝对路径。路径段后面若紧跟「含 \ 或 / 的词」或「带扩展名的词」
//         (最多隔 3 个词),视为带空格的同一路径一起遮掉。
//   令牌:github_pat_ / gh[pousr]_ / exe_ apr_ tok_ pat_ / sk-(含 sk-ant- sk-proj-)/ xox[abposr]- / AKIA ASIA /
//         JWT 三段式(eyJ….….…)/ UUID / ≥12 位十六进制 / ≥20 位且含两类以上字符(大写、小写、数字)的串。
const STOP = String.raw`\s"'<>|),，;；、。:：`;
const SEG = `[^${STOP}]`;
const MORE = String.raw`(?:\s+${SEG}*[\\/]${SEG}*|(?:\s+${SEG}+){0,3}?\s+${SEG}*\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9]))*`;
const PATH_RES = [
  new RegExp(String.raw`file:\/\/\/?[^\s"'<>]*` + MORE, "gi"),
  new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]${SEG}*` + MORE, "g"),
  new RegExp(String.raw`(?:\\\\|(?<![:\w/])\/\/)[A-Za-z0-9._$-]+[\\/]${SEG}*` + MORE, "g"),
  new RegExp(String.raw`(?:%[A-Za-z_][A-Za-z0-9_]*%|\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*|~[A-Za-z0-9_.-]*)[\\/]${SEG}*` + MORE, "g"),
  new RegExp(String.raw`(?<![A-Za-z0-9_.\-/])\/(?:[a-z]|mnt\/[a-z]|Users|home|tmp|var|mnt|opt|root|private|etc|srv|usr|Volumes|workspace|data|cygdrive)\/${SEG}*` + MORE, "g"),
];
const TOKEN_RES = [
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{6,}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{6,}/g,
  /(?<![A-Za-z0-9])(?:exe|apr|tok|pat)_[A-Za-z0-9_-]{6,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/g,
  /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{6,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{8,}/g,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b[0-9a-f]{12,}\b/gi,
];
const mixedLong = (m) => [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(m)).length >= 2 ? "…" : m;
// N11:认证头后的串(含全小写)、内网地址(10/8、172.16/12、192.168/16、100.64/10,可带端口)、「密码 / password / passwd / secret」后的值。不遮邮箱。
const AUTH_HEADER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{6,}/gi;
const PRIVATE_IP_RE = new RegExp(String.raw`(?<![\d.])(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|` +
  String.raw`100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})(?::\d{1,5})?(?!\.?\d)`, "g");
const SECRET_KV_RE = /(?<![A-Za-z])(密码|password|passwd|secret)(\s*[:=：]\s*|\s+)[^\s"'<>,，;；。]+/gi;

/** 遮掉私有路径、令牌样串、长 ID / 哈希、反引号里的命令与 shell 提示行;不截断、不并空白。 */
export function redactText(s) {
  let t = String(s ?? "").replace(/`[^`]*`/g, "…").replace(AUTH_HEADER_RE, "$1 …").replace(SECRET_KV_RE, "$1$2…");
  for (const re of PATH_RES) t = t.replace(re, "…");
  for (const re of TOKEN_RES) t = t.replace(re, "…");
  t = t.replace(PRIVATE_IP_RE, "…");
  return t
    .replace(/(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{20,}/g, mixedLong)
    .replace(/^\s*(?:\$|PS>|>)\s.*$/gm, "…")
    .replace(/(?:…\s*){2,}/g, "…");
}

// ── md 导出用的轻量遮蔽(redactLight,N3):导出是给别的 AI 当任务读的,命令、引用、代码块、URL、提交号、长标识符都要原样留下。
//   只做两件事:令牌样串换成「…」;用户家目录前缀换成「~」。逐个匹配替换,不跨行、不吞整行、不合并省略号,换行原样。
//   令牌前缀要求比 redactText 长(exe_/apr_/tok_/pat_ 后 ≥16 位、sk- 后 ≥20 位),免得 tok_count 这类标识符被当成令牌。
const LIGHT_TOKEN_RES = [
  AUTH_HEADER_RE,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{16,}/g,
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9_])(?:exe|apr|tok|pat)_[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_])xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const HOME_RES = [
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|:*?`]+/gi,
  /(?<![A-Za-z0-9_.\-/])\/(?:mnt\/)?[a-z]\/Users\/[^/\s"'<>`]+/gi,
  /(?<![A-Za-z0-9_.\-/:])\/(?:Users|home)\/[^/\s"'<>`]+/g,
];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** home = 本机家目录(缺省 os.homedir()):不在 Users / home 下的家目录也按原样换成 ~。 */
export function redactLight(s, { home = null } = {}) {
  let t = String(s ?? "");
  for (const re of LIGHT_TOKEN_RES) t = t.replace(re, (m, p1) => (re === AUTH_HEADER_RE ? `${p1} …` : "…"));
  if (home && String(home).length > 3) {
    const parts = String(home).split(/[\\/]+/).filter(Boolean).map(escRe);
    const lead = /^[\\/]/.test(String(home)) ? "[\\\\/]" : "";
    t = t.replace(new RegExp(`(?<![A-Za-z0-9_])${lead}${parts.join("[\\\\/]+")}(?![A-Za-z0-9_.-])`, "gi"), "~");
  }
  for (const re of HOME_RES) t = t.replace(re, "~");
  return t;
}

/** 给人看的短句:redactText 之后并空白、截断到 max 字。 */
export function safeText(s, max = 60) {
  return cut(redactText(s), max);
}

/** actor_kind 判定(见文件头)。eventKind 用来认出「领取/启动/交付」里的执行方。 */
export function actorKindOf(actor, eventKind, { lines = [], isExecutor = () => false } = {}) {
  const a = String(actor ?? "");
  if (HUMAN.has(a) || a.startsWith("approval-token:")) return "human";
  if (AUTO.has(a)) return "auto";
  if (a === "executor") return "executor";
  if (a === "worker") return "line";
  try { if (isExecutor(a)) return "executor"; } catch {}
  const base = a.replace(/@\d+$/, "");
  if (lines.includes(base)) return "line";
  if (WORKER_KINDS.has(eventKind)) return "line";
  return "system";
}

/** 显示用的执行方名字:人 →「你」,自动审阅 →「自动审阅」,看板自己 →「看板」,线 → 线的显示名(并行槽号去掉);
 *  执行者 → 登记时的显示名(nameOf),没有再用同名线的显示名,都没有才用 id。 */
export function actorLabel(actor, kind, labels = {}, nameOf = null) {
  const a = String(actor ?? "");
  if (kind === "human") return a.startsWith("approval-token:") ? "你(远程批准)" : "你";
  if (kind === "auto") return "自动审阅";
  if (kind === "system") return "看板";
  const base = a.replace(/@\d+$/, "");
  let name = null;
  if (kind === "executor") { try { name = nameOf?.(base) || null; } catch {} name = name || labels[base] || null; }
  return cut(name || (kind === "line" && labels[base]) || (a === "worker" ? "执行线" : a === "executor" ? "执行者" : base), 32);
}

const PKG_STEP = { declare: "报了包", freeze: "冻结了包", commit: "报了包的提交", commit_check: "核了包的提交", issue: "出了包",
  ran: "记下跑完了包", pin: "报了包的一项核对", pin_card: "为包出了核对卡" };
const PKG_STATE = { draft: "草稿", frozen: "已冻结", committed: "已提交", issued: "已出包", ran: "已跑", pinned: "已钉住" };
const dispositionOf = (d) => d.disposition || (d.status === "done" ? "close" : d.status === "not_started" ? "hand_back" : "hold");

/** 一条事件 → 一条历史条目(或 null = 不出条目)。runtimeOf(run_id) 由 task_runs 补运行时。 */
export function entryOf(e, ctx = {}) {
  if (SKIP.has(e.kind) || e.kind.startsWith("execution.")) return null;
  const d = e.detail || {};
  if (e.kind === "decision.recorded" && d.source !== "autoreview") return null;
  // 执行方停下时把卡放回(release_held)的 actor 也是执行方,与领取同一判法。
  const actor_kind = actorKindOf(e.actor, e.kind === "release" && d.action === "release_held" ? "claim" : e.kind, ctx);
  const who0 = actorLabel(e.actor, actor_kind, ctx.labels, ctx.executorName);
  // 执行方(线 / 执行者)的名字与动作之间空一格(「Claude 无头 领取」);「你」「看板」「自动审阅」照旧紧连。
  const who = actor_kind === "line" || actor_kind === "executor" ? who0 + " " : who0;
  const runtime = d.runtime || (d.run_id && ctx.runtimeOf ? ctx.runtimeOf(d.run_id) : null);
  const rt = runtime ? `(${cut(runtime, 16)})` : "";
  let step = "other", summary;
  switch (e.kind) {
    case "add": step = "created"; summary = `${who}建卡${d.released ? ",已放行" : ",未放行"}`; break;
    case "release":
      if (d.action === "release") { step = "released"; summary = `${who}放行,等执行方领取`; }
      else if (d.action === "hold") summary = `${who}收回放行`;
      else { step = "reaped"; summary = `${who}停下,卡退回等领取`; }
      break;
    case "claim": step = "claimed"; summary = `${who}领取${rt}`; break;
    case "process_started": step = "started"; summary = `${who}启动了执行${rt}`; break;
    case "report": step = "reported";
      summary = d.outcome === "done" ? `${who}交付,等验收` : `${who}交回,等你决定`; break;
    case "report_overridden": summary = `交付改为等你决定${d.reason ? ":" + safeText(d.reason, 50) : ""}`; break;
    case "resolve": {
      const disp = dispositionOf(d);
      if (e.actor === "cascade") { step = "accepted"; summary = `联动关闭${d.cause_task_id ? `(因 #${d.cause_task_id} 通过)` : ""}`; }
      else if (disp === "close") { step = "accepted"; summary = `${who}${actor_kind === "auto" ? "" : "验收"}通过`; }
      else if (disp === "hand_back") { step = "handed_back"; summary = d.verdict === "approve" ? `${who}通过并附指示,退回原线继续` : `${who}打回,回原线重做`; }
      else summary = `${who}裁定后交审阅`;
      break;
    }
    case "reopen": step = "reopened"; summary = `${who}重新打开`; break;
    case "reap": step = "reaped"; summary = "租约超时,收回等重新领取"; break;
    case "set_line": summary = `${who}改线:${d.to == null ? "不指定线" : cut(ctx.labels?.[d.to] || d.to, 24)}`; break;
    case "set_parent": summary = d.to == null ? `${who}从目标上摘下` : `${who}挂到 #${d.to}`; break;
    case "review.rearmed": summary = "子卡齐了,送回重审"; break;
    case "review.rearm_blocked": summary = "子卡未齐,暂不重审"; break;
    case "decision.recorded": summary = `自动审阅看过${d.note ? ":" + safeText(d.note, 50) : ",等你确认"}`; break;
    case "execution.configured": summary = `${who}设置了执行配置`; break;
    case "snapshot": summary = "旧数据导入时的状态"; break;
    case "unattested": summary = "旧执行记录(无启动凭据)"; break;
    case "node_recovery": summary = "节点恢复"; break;
    // 合同 H6(core/spec-version.mjs):放行后说明改了一版;交付时对方确认到的版本落后。
    // 不是从编辑接口来的修改(由事件或读卡时的核对发现)actor 是 system:不写成「看板改了」。
    case "spec.changed": summary = `${actor_kind === "system" ? "说明有改动" : who + "改了说明"}(现为 v${Number(d.version) || "?"})`; break;
    case "spec.stale_delivery": summary = `${who}的交付基于旧版说明(对方确认到 v${Number(d.base) || "?"},当前 v${Number(d.current) || "?"})`; break;
    // 合同 I8(core/autocards.mjs):操作者事先写的条件到了,板按同一条放行路放行(或没能放行)。
    case "release.auto": summary = d.ok === false ? `条件到了(#${Number(d.source) || "?"} ${d.event === "done" ? "完成" : "交付"}),但没能自动放行${d.error ? ":" + safeText(d.error, 50) : ""}`
      : `按条件自动放行(#${Number(d.source) || "?"} ${d.event === "done" ? "已完成" : "已交付"})`; break;
    // 合同 I1–I4(第 8 波):取代、依赖作废、同批、互斥资源。
    case "supersede": summary = `${who}标记为被 #${Number(d.by) || "?"} 取代`; break;
    case "supersede.revoked": summary = `${who}撤销了取代`; break;
    case "dep.reopened": summary = `依赖 #${Number(d.dep) || "?"} 被重开,这张卡做的前提可能变了`; break;
    case "basis.ack": summary = `${who}确认已看过依赖的变化`; break;
    case "batch.set": summary = d.to ? `${who}放进批「${safeText(d.to, 24)}」` : `${who}移出了批`; break;
    case "needs.set": summary = Array.isArray(d.to) && d.to.length ? `${who}设了要独占的资源:${safeText(d.to.join("、"), 60)}` : `${who}清掉了要独占的资源`; break;
    // 合同 I10a–c(第 8 波第二轮):引用、复审卡、底提交、卡死。
    case "refs.set": summary = Array.isArray(d.cards) && d.cards.length ? `${who}设了引用:${d.cards.map((n) => "#" + Number(n)).join("、")}` : `${who}清掉了引用`; break;
    case "ref.stale": summary = `引用的 #${Number(d.card) || "?"} 说明改了(钉 v${Number(d.pinned) || "?"} · 现 v${Number(d.current) || "?"})`; break;
    case "ref.repinned": summary = `${who}把引用 #${Number(d.card) || "?"} 重钉到 v${Number(d.to) || "?"}`; break;
    case "ref.stale_delivery": summary = `交付时引用的 ${Array.isArray(d.cards) ? d.cards.map((n) => "#" + Number(n)).join("、") : "卡"} 说明已改,照的是旧版`; break;
    case "spec_review.created": summary = `看板出了复审卡 #${Number(d.card) || "?"}(对照 #${Number(d.spec?.card) || "?"} 说明 v${Number(d.spec?.version) || "?"})`; break;
    case "spec.reviewed": summary = `复审卡 #${Number(d.by_card) || "?"} 的结论:${d.verdict === "conform" ? "符合说明" : d.verdict === "deviates" ? "与说明不符" : "没给出结论"}`; break;
    case "base.set": summary = d.commit ? `${who}设了底提交 ${safeText(d.commit, 12)}${d.onto ? `(在 ${safeText(d.onto, 40)} 上)` : ""}` : `${who}撤销了底提交`; break;
    case "task.stuck": summary = `卡死了:连着${({ reaped: "被回收", handed_back: "被退回", failed: "交回没做完", same_reason: "以同一原因停下" })[d.kind] || "出问题"} ${Number(d.count) || "?"} 次`; break;
    case "stuck.cleared": summary = `${who}把卡死计数清零${d.note ? ":" + safeText(d.note, 50) : ""}`; break;
    // 合同 I10d(core/packages.mjs):包的每一步;I10e(core/env-gap.mjs):目标环境、执行者自报的环境差。
    // 8f:审阅座席经 /api/packages/:id/pin 写的核对项(verified = 已核)不写成「自动审阅报了…」,写明是审阅座席核过的;核对卡持卡者报的写「自报」。
    case "package.changed": summary = d.step === "pin" && (d.verified === true || actor_kind === "auto")
        ? `审阅座席核过包「${safeText(d.name, 30)}」的「${safeText(d.pin, 30)}」:${d.ok === false ? "没通过" : "通过"}(已核 · ${PKG_STATE[d.state] || "?"})`
        : d.step === "pin" ? `${who}报了包「${safeText(d.name, 30)}」的「${safeText(d.pin, 30)}」:${d.ok === false ? "没通过" : "通过"}(自报 · ${PKG_STATE[d.state] || "?"})`
        : `${actor_kind === "system" ? "看板" : who}${PKG_STEP[d.step] || "更新了包"}「${safeText(d.name, 30)}」(${PKG_STATE[d.state] || "?"}${d.drift ? " · 对不上" : ""})`; break;
    case "target_env.set": summary = d.target_env ? `${who}设目标环境:${safeText(d.target_env, 40)}` : `${who}撤销了目标环境`; break;
    case "env_diff.reported": summary = `${who}报了与目标环境的差 ${Number(d.count) || 0} 项(自报)`; break;
    default: summary = `记录:${cut(e.kind, 24)}`;
  }
  return { at: e.at, kind: e.kind, actor: who0, actor_kind, step, summary: cut(summary, 120) };
}

/** 一张卡的事件(旧→新)→ 条目。resolve 之后紧跟的 decision.recorded(source=resolve)里的 note 是裁定原文,并进打回条目当原因。 */
export function entriesOf(evs, ctx = {}) {
  const out = []; let lastResolve = null;
  for (const e of evs) {
    if (e.kind === "decision.recorded" && e.detail?.source === "resolve") {
      const note = safeText(e.detail.note, 60);
      if (lastResolve && note && lastResolve.step !== "accepted") lastResolve.summary = cut(`${lastResolve.summary}:${note}`, 120);
      lastResolve = null; continue;
    }
    const en = entryOf(e, ctx);
    if (!en) continue;
    out.push(en);
    lastResolve = e.kind === "resolve" ? en : null;
  }
  return out;
}

/** 子卡当前状态 → step 0..5(见文件头)。started = 当前 run 有 process_started。 */
export function stepOf(t, started) {
  if (t.status === "done") return 5;
  if (t.status === "waiting") return 4;
  if (t.status === "in_progress") return started ? 3 : 2;
  return t.released ? 1 : 0;
}

// heartbeatStarted(t) → 外部执行者这一轮是否已心跳过;liveNote(t) → { live_note, live_note_at }(connect 的表)。都由 server 注入,缺省不改行为。
// executorName(id) → 执行者登记时的显示名;selfStarts(taskId) → [{ run_id, at }] 每一轮第一次执行者心跳(connect 的表)。
// hasOptions(t) → 这张卡有没有方案包(与任务对象 decision_package 同一判法;8f:流转条区分「选方案」与「审过被拦待验收」);
// isAuto(id) → 是不是看板自动出的卡(8f:目标组头「执行 n/m」不数它们)。都由 server 注入,缺省不改行为。
export function createFlow({ db, isExecutor = () => false, lines = () => [], labels = () => ({}), emit = () => {}, coalesceMs = FLOW_COALESCE_MS,
                             heartbeatStarted = () => false, liveNote = () => ({ live_note: null, live_note_at: null }),
                             executorName = () => null, selfStarts = () => [], hasOptions = null, isAuto = () => false } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_progress (
    conversation_id INTEGER PRIMARY KEY, after_message_id INTEGER, text TEXT NOT NULL, sig TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const ctx = () => ({ lines: lines() || [], labels: labels() || {}, isExecutor: (a) => isExecutor(db, a), executorName });
  const runtimeStmt = db.prepare("SELECT runtime FROM task_runs WHERE run_id=?");
  const runtimeOf = (runId) => { try { return runtimeStmt.get(String(runId))?.runtime ?? null; } catch { return null; } };
  const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

  // ── 任务派生字段:增量缓存。每次读只扫 id 大于上次的新事件(一条走主键的范围查询),不按卡扫全量。
  //    库被换掉(恢复)时 max(id) 会变小 → 整个重建。
  const fields = new Map();
  let seen = 0;
  const scan = db.prepare("SELECT id, at, task_id, kind, actor, detail FROM task_events WHERE id>? ORDER BY id LIMIT 5000");
  const maxId = db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM task_events");
  function refresh() {
    const top = Number(maxId.get().m);
    if (top < seen) { fields.clear(); seen = 0; }
    if (top === seen) return;
    const c = ctx();
    for (;;) {
      const rows = scan.all(seen);
      if (!rows.length) break;
      for (const r of rows) {
        seen = Number(r.id);
        const e = { at: r.at, kind: r.kind, actor: r.actor, detail: parse(r.detail) };
        if (e.kind === "decision.recorded" && e.detail.source === "resolve") continue;
        const en = entryOf(e, c);
        if (!en) continue;
        const f = fields.get(Number(r.task_id)) || { handed_back: 0, last_actor: null, last_actor_kind: null };
        if (en.step === "handed_back") f.handed_back += 1;
        f.last_actor = en.actor; f.last_actor_kind = en.actor_kind;
        fields.set(Number(r.task_id), f);
      }
      if (rows.length < 5000) break;
    }
  }
  /** 任务对象(列表与详情)要并进的三项。 */
  function taskFields(t) {
    refresh();
    return fields.get(Number(t?.id)) || { handed_back: 0, last_actor: null, last_actor_kind: null };
  }

  const evStmt = db.prepare("SELECT id, at, task_id, kind, actor, detail FROM task_events WHERE task_id=? ORDER BY id");
  /** GET /api/tasks/:id/history:旧→新,最多 limit 条(取最近的 limit 条)。 */
  function history(taskId, limit = 100) {
    const evs = evStmt.all(Number(taskId)).map((r) => ({ at: r.at, kind: r.kind, actor: r.actor, detail: parse(r.detail) }));
    const cx = { ...ctx(), runtimeOf };
    const entries = entriesOf(evs, cx);
    // 外部执行者没有 process_started:每一轮领取后第一次心跳补一条「<名称> 自报开始」(step=started),写明看板没有观察到进程。
    //   只认这一轮的领取方是执行者的心跳(受管线的心跳不算启动);按时刻插到对应位置(同一时刻排在已有条目之后)。
    let starts = []; try { starts = selfStarts(Number(taskId)) || []; } catch {}
    for (const hb of starts) {
      const claim = evs.find((e) => e.kind === "claim" && String(e.detail?.run_id ?? "") === String(hb.run_id));
      if (!claim || actorKindOf(claim.actor, "claim", cx) !== "executor" || !hb.at) continue;
      const name = actorLabel(claim.actor, "executor", cx.labels, cx.executorName);
      const en = { at: hb.at, kind: "self_report_started", actor: name, actor_kind: "executor", step: "started",
                   summary: cut(`${name} 自报开始(看板没有观察到进程)`, 120) };
      const t = Date.parse(hb.at);
      let i = entries.length;
      while (i > 0 && Date.parse(entries[i - 1].at) > t) i--;
      entries.splice(i, 0, en);
    }
    return { task_id: Number(taskId), entries: entries.slice(Math.max(0, entries.length - limit)) };
  }

  // ── 对话进度
  const convStmt = db.prepare("SELECT id, goal_id, applied_rev, applied_task_ids FROM conversations WHERE id=?");
  const kidsStmt = db.prepare("SELECT * FROM tasks WHERE parent_id=? AND (archived_at IS NULL OR status='done') ORDER BY id");
  const goalStmt = db.prepare("SELECT id, status FROM tasks WHERE id=?");
  const planStmt = db.prepare("SELECT tasks FROM conversation_plans WHERE conversation_id=? AND rev=?");
  const startedStmt = db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='process_started' AND json_extract(detail,'$.run_id')=? LIMIT 1");
  const lastClaimStmt = db.prepare("SELECT actor, detail FROM task_events WHERE task_id=? AND kind='claim' ORDER BY id DESC LIMIT 1");

  function progressOf(convId) {
    const c = convStmt.get(Number(convId));
    if (!c || c.goal_id == null) return null;
    const goalId = Number(c.goal_id), cx = ctx();
    // n = 计划里的序号:建卡时按启用的计划条目顺序一一建卡,applied_task_ids 与之同序。后来另挂到目标上的卡没有 n。
    const ids = parse(c.applied_task_ids), planTasks = (() => { try { return JSON.parse(planStmt.get(c.id, c.applied_rev)?.tasks || "[]"); } catch { return []; } })();
    const enabled = Array.isArray(planTasks) ? planTasks.filter((t) => t.enabled !== false) : [];
    const nOf = new Map(Array.isArray(ids) ? ids.map((id, i) => [Number(id), enabled[i]?.n ?? i + 1]) : []);
    refresh();
    const items = kidsStmt.all(goalId).map((t) => {
      // started_via:看板观察到的进程启动 = "process";外部执行者领取后心跳过(对方自报,看板没观察到进程)= "self_report"
      const observed = t.status === "in_progress" && t.run_id ? !!startedStmt.get(t.id, String(t.run_id)) : false;
      const selfReported = !observed && t.status === "in_progress" && t.run_id ? !!heartbeatStarted(t) : false;
      const started = observed || selfReported;
      let note = { live_note: null, live_note_at: null };
      try { const n = liveNote(t) || {}; note = { live_note: n.live_note ?? null, live_note_at: n.live_note_at ?? null }; } catch {}
      let worker = null, runtime = null;
      if (t.status === "in_progress") { worker = t.worker; runtime = (t.run_id && runtimeOf(t.run_id)) || t.last_runtime || null; }
      else if (t.status !== "not_started") {
        const lc = lastClaimStmt.get(t.id);
        worker = lc ? lc.actor : t.worker || null;
        runtime = t.last_runtime || (lc && parse(lc.detail).runtime) || null;
      }
      const wk = worker == null ? null : actorLabel(worker, actorKindOf(worker, "claim", cx), cx.labels, cx.executorName);
      // has_options(8f):只在等你确认时给 —— false = 没有方案包(审阅看过、自动通过被拦,转人工验收),不是选方案。
      let opts = null;
      if (t.status === "waiting" && t.waiting_for === "confirm" && typeof hasOptions === "function") { try { opts = !!hasOptions(t); } catch { opts = null; } }
      return { id: Number(t.id), n: nOf.get(Number(t.id)) ?? null, subject: cut(t.subject, 80), line: t.line ?? null,
               status: t.status, waiting_for: t.status === "waiting" ? (t.waiting_for ?? null) : null, released: !!t.released,
               ...(opts === null ? {} : { has_options: opts }),
               step: stepOf(t, started), started_via: observed ? "process" : selfReported ? "self_report" : null, worker: wk, runtime: runtime ? String(runtime) : null,
               handed_back: fields.get(Number(t.id))?.handed_back ?? 0, ...note, updated_at: t.updated_at };
    });
    const goal = goalStmt.get(goalId);
    return { goal_id: goalId, goal_status: goal?.status ?? null, total: items.length, done: items.filter((i) => i.step === 5).length, items };
  }

  /** 进度消息的一句话:「3/5 完成 · #12 待验收 · #13 Zcode 在做(自报)」。要人做的排前面,最多列 3 项。 */
  function progressText(p) {
    if (!p.total) return "目标下暂时没有子卡";
    const head = p.goal_status === "done" ? `全部完成 · ${p.done}/${p.total}` : `${p.done}/${p.total} 完成`;
    const rank = (i) => i.step === 4 && ["review", "confirm", "decision"].includes(i.waiting_for) ? 0 : i.step === 4 ? 1
      : i.step >= 2 ? 2 : i.step === 0 ? 3 : 4;
    const open = p.items.filter((i) => i.step < 5).sort((a, b) => rank(a) - rank(b) || a.id - b.id);
    const say = (i) => i.step === 4 ? `#${i.id} ${i.waiting_for === "confirm" && i.has_options === false ? "审过被拦,待验收" : WAIT_TEXT[i.waiting_for] || "等待中"}`
      // 外部执行者的「在做」依据是它领卡后的心跳 → 写「在做(自报)」,与流转条/首页/侧栏的「对方自报」同一口径(合同 B 裁定)
      : i.step >= 2 ? `#${i.id} ${i.worker || "执行方"} ${i.step === 3 ? (i.started_via === "self_report" ? "在做(自报)" : "在做") : "已领取"}`
      : i.step === 0 ? `#${i.id} 未放行` : i.handed_back ? `#${i.id} 已打回,等重领` : `#${i.id} 等领取`;
    const shown = open.slice(0, 3).map(say);
    if (open.length > 3) shown.push(`另 ${open.length - 3} 张未完`);
    return cut([head, ...shown].join(" · "), 200);
  }
  // live_note 进签名(换了一句要推给面板),live_note_at 不进(同一句重报不推)。
  const sigOf = (p) => JSON.stringify([p.goal_status, p.items.map(({ updated_at, live_note_at, ...rest }) => rest)]);

  const rowStmt = db.prepare("SELECT * FROM conversation_progress WHERE conversation_id=?");
  const appliedMsgStmt = db.prepare("SELECT id FROM conversation_messages WHERE conversation_id=? AND kind='applied' ORDER BY id DESC LIMIT 1");
  const lastMsgStmt = db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM conversation_messages WHERE conversation_id=?");
  /** 按库里当前状态重算并落盘(签名没变就不写)。返回 { progress, row, sig }。 */
  function sync(convId) {
    const p = progressOf(convId);
    if (!p) return { progress: null, row: null, sig: null };
    const sig = sigOf(p), text = progressText(p), at = new Date().toISOString();
    let row = rowStmt.get(Number(convId));
    if (!row) {
      const after = appliedMsgStmt.get(Number(convId))?.id ?? lastMsgStmt.get(Number(convId)).m;
      db.prepare("INSERT OR IGNORE INTO conversation_progress (conversation_id, after_message_id, text, sig, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .run(Number(convId), Number(after), text, sig, at, at);
      row = rowStmt.get(Number(convId));
    } else if (row.sig !== sig || row.text !== text) {
      db.prepare("UPDATE conversation_progress SET text=?, sig=?, updated_at=? WHERE conversation_id=?").run(text, sig, at, Number(convId));
      row = rowStmt.get(Number(convId));
    }
    return { progress: p, row, sig };
  }
  const messageOf = (convId, row) => ({ id: `progress-${convId}`, role: "system", kind: "progress", text: row.text,
    created_at: row.created_at, updated_at: row.updated_at, tools: null, plan_rev: null });

  /** GET /api/conversations/:id 的返回:并进 conversation.progress 与那一条进度消息(放在建卡消息之后)。 */
  function decorateDetail(detail) {
    const id = detail?.conversation?.id;
    const { progress, row } = sync(id);
    if (!progress) return { ...detail, conversation: { ...detail.conversation, progress: null } };
    const { goal_status, ...pub } = progress;
    const msgs = detail.messages.filter((m) => m.kind !== "progress");
    const at = msgs.findIndex((m) => m.id === Number(row.after_message_id));
    msgs.splice(at < 0 ? msgs.length : at + 1, 0, messageOf(id, row));
    return { ...detail, conversation: { ...detail.conversation, progress: pub }, messages: msgs };
  }

  // ── 子卡变化 → 推 conversation.changed。同一对话 coalesceMs 内只推一次(首个变化起计时,窗口内的并进这一次);
  //    签名与上次推的相同(心跳、无关字段)就不推。lastSent 只在内存:重启后第一次变化照推一次,不会丢。
  const timers = new Map(), lastSent = new Map();
  const parentStmt = db.prepare("SELECT parent_id FROM tasks WHERE id=?");
  const appliedStmt = db.prepare("SELECT id, goal_id FROM conversations WHERE goal_id IS NOT NULL");
  function convsFor(ids) {
    const byGoal = new Map(appliedStmt.all().map((r) => [Number(r.goal_id), Number(r.id)]));
    if (!byGoal.size) return [];
    if (ids == null) return [...byGoal.values()];
    const out = new Set();
    for (const raw of ids) {
      let cur = Math.abs(Number(raw)), hops = 0;
      while (Number.isSafeInteger(cur) && cur > 0 && hops++ < 32) {
        if (byGoal.has(cur)) { out.add(byGoal.get(cur)); break; }
        cur = Number(parentStmt.get(cur)?.parent_id ?? 0);
      }
    }
    return [...out];
  }
  function flush(convId) {
    timers.delete(convId);
    try {
      const { sig } = sync(convId);
      if (sig == null || lastSent.get(convId) === sig) return;
      lastSent.set(convId, sig);
      emit("conversation.changed", { id: convId });
    } catch (e) { console.warn(`对话 #${convId} 的进度刷新失败(${String(e?.message || e).slice(0, 160)})`); }
  }
  function schedule(convId) {
    if (timers.has(convId)) return;
    const h = setTimeout(() => flush(convId), coalesceMs); h.unref?.(); timers.set(convId, h);
  }
  /** 由 server 的 emit 调用。只看 task.* / goal.*;conversation.* 不看(自己推的,免得绕圈)。 */
  function notify(type, data = {}) {
    const t = String(type);
    if (!t.startsWith("task.") && !t.startsWith("goal.")) return;
    try {
      const ids = [data.id, ...(Array.isArray(data.ids) ? data.ids : []), ...(Array.isArray(data.made) ? data.made : [])]
        .filter((v) => Number.isFinite(Number(v)) && Number(v) !== 0);
      for (const c of convsFor(ids.length ? ids : null)) schedule(c);
    } catch (e) { console.warn(`进度通知失败(${String(e?.message || e).slice(0, 160)})`); }
  }
  /** 启动时:每个已建卡对话按库重算一次(只写库,不推;此时还没有订阅者)。 */
  function syncAll() {
    for (const r of appliedStmt.all()) { try { sync(r.id); } catch (e) { console.warn(`对话 #${r.id} 的进度重算失败(${String(e?.message || e).slice(0, 160)})`); } }
  }
  function stop() { for (const t of timers.values()) { try { clearTimeout(t); } catch {} } timers.clear(); }

  /** 目标卡的 d/n:直接子卡,未归档 + 完成后才归档的。首页右栏组头与流水线「执行 n/m」用。
   *  8f:看板自动出的卡(候选组装 / 核对卡 / 复审卡)不数 —— 候选组装归「整合」段;对话流转条(progressOf)照旧列出它们。 */
  const kidCountStmt = db.prepare("SELECT id, status FROM tasks WHERE parent_id=? AND (archived_at IS NULL OR status='done')");
  function goalCounts(t) {
    if (t?.kind !== "goal") return {};
    const rows = kidCountStmt.all(Number(t.id)).filter((r) => { try { return !isAuto(Number(r.id)); } catch { return true; } });
    return { children_done: rows.filter((r) => r.status === "done").length, children_total: rows.length };
  }

  return { history, taskFields, goalCounts, progressOf, progressText, sync, syncAll, decorateDetail, notify, stop, refresh };
}
