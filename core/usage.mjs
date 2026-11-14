// 卡片用量结算(开发板 #10):账本增量读取、分组汇总、结算事件。
// 只做文件读写,不依赖数据库与服务端,测试可以直接导入。
//
// 账本 <data>/usage_ledger.jsonl 只追加,里面有三种行:
//   用量行    没有 event 键。每一轮模型调用一行(尝试、续修、审阅、拆解、压缩、协调对话)。
//   结算事件  event="settlement"。卡变成 done 时由服务端写一条。卡号放在 settled_card 而不是
//             card:旧版服务端只按 card 归并,读到它会跳过,不会把它当成一轮用量。
//   其它事件  例如压缩印记 event="compact"。不带用量,不参与汇总。
// 未知值一律是 null:写的时候不记 0,汇总的时候也不当 0 加。
import { statSync, openSync, readSync, closeSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const PHASES = ["implement", "fix", "review", "decompose", "compact", "coord"];
export const COST_SOURCES = ["reported", "estimated", "external-reported", "unknown"];
export const GROUP_KEYS = ["card", "line", "model", "phase", "source", "pool"];
// 合同 J2.1:谁发起的这次调用。值域定死;写进来的值认不出 = "?"(不丢行)。seat = 外部协调席(目前没有写入方,留位)。
export const SOURCES = ["managed", "reviewer", "coordinator", "decompose", "compact", "external", "seat"];
/** 没配置 runtime 的 model 归这一池(只有账本,没有限流记录)。 */
export const OTHER_POOL = "other";
const TOKENS = ["calls", "in", "cc", "cr", "out"];
const METRICS = [...TOKENS, "duration_ms", "cost_usd"];
const CSV_COLUMNS = ["rows", "attempts", ...METRICS, "cost_source"];
const NL = "\n";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nonneg = (v) => { const n = num(v); return n === null || n < 0 ? null : n; };
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const isAttempt = (phase) => phase === "implement" || phase === "fix";
const badInput = (message) => Object.assign(new Error(message), { code: "BAD_INPUT" });

/** 本地时刻,与 Python 侧 datetime.now().isoformat(timespec="seconds") 同形。 */
export function localIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 时间范围的一端 → 毫秒。只有日期时按本地日历日算:起点取零点,终点取当天最后一毫秒。
 *  读不懂返回 NaN(调用方据此拒绝),没给返回 null。 */
export function parseTime(v, endOfDay = false) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (/^\d{12,14}$/.test(s)) return Number(s);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (day) {
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return endOfDay ? d.getTime() + 86400000 - 1 : d.getTime();
  }
  return Date.parse(s);
}

/** 线 = worker 去掉 @槽位 后缀;审阅座席归为 review;认不出来归为 "?"(不丢行)。 */
export function lineOf(worker) {
  const w = str(worker);
  if (!w) return "?";
  const base = w.split("@")[0];
  return base === "reviewer" ? "review" : base || "?";
}

/** 池的对照:pools = {ids:[runtime id], models:{model → runtime id}}(由配置的 runtimes[].models 得出)。
 *  没给对照(纯函数调用、旧调用方)时只认写进行里的池名。 */
export function poolMap(runtimes = []) {
  const ids = [], models = {};
  for (const r of Array.isArray(runtimes) ? runtimes : []) {
    const id = str(r?.id);
    if (!id) continue;
    ids.push(id);
    for (const m of Array.isArray(r.models) ? r.models : []) { const mid = str(m?.id); if (mid && !Object.hasOwn(models, mid)) models[mid] = id; }
  }
  return { ids, models };
}
/** model → 池:查座席的 models 表;归不了 = other。 */
export function poolOfModel(model, pools) {
  const m = str(model);
  return m && pools && Object.hasOwn(pools.models || {}, m) ? pools.models[m] : OTHER_POOL;
}
/** 来源:写了且在值域里 = 原值;写了但认不出 = "?";没写(旧行)= 按 reported_by / phase / worker 推。 */
export function sourceOf(j, phase) {
  if (j.source !== undefined && j.source !== null) return SOURCES.includes(j.source) ? j.source : "?";
  if (str(j.reported_by) === "external") return "external";
  const worker = str(j.worker);
  if (phase === "review" || worker === "reviewer") return "reviewer";
  if (phase === "decompose") return "decompose";
  if (phase === "compact") return "compact";
  if (phase === "coord") return "coordinator";
  if ((phase === "implement" || phase === "fix") && worker) return "managed";
  return "?";
}
/** 池:写了且是配置里的 runtime id(或 other)= 原值;否则按 model 归池。没给对照 = 写了什么就是什么,没写 = other。 */
function poolOfRow(j, model, pools) {
  const given = str(j.pool);
  if (!pools) return given || OTHER_POOL;
  if (given && (given === OTHER_POOL || pools.ids.includes(given))) return given;
  return poolOfModel(model, pools);
}

/** 一行账本 JSON → 统一形状的用量行。带 event 键的不是用量行,返回 null。
 *  旧行没有新字段:阶段由已有信息推出,其余新字段读成 null;source / pool 按 J2.1 推。 */
export function normalizeRow(j, pools = null) {
  if (!j || typeof j !== "object" || Array.isArray(j) || j.event != null) return null;
  const worker = str(j.worker), given = str(j.phase), cost = num(j.cost_usd);
  const cardNumber = j.card == null ? null : Number(j.card);
  const phase = PHASES.includes(given) ? given
    : given === "initial" ? "implement"          // 尝试的首轮(#13 起写入的旧名)
    : given === "repair" ? "fix"                 // 同一次尝试里的续修轮
    : given === null ? (worker === "reviewer" ? "review" : "implement")
    : "?";
  const ts = str(j.ts), at = ts === null ? NaN : Date.parse(ts);
  const model = str(j.model) || "?";
  return {
    ts, at: Number.isFinite(at) ? at : null,
    card: Number.isSafeInteger(cardNumber) ? cardNumber : null,
    attempt: int(j.attempt), run_id: str(j.run_id), round: int(j.round),
    worker, line: str(j.line) || lineOf(worker), model, effort: str(j.effort), phase,
    source: sourceOf(j, phase), pool: poolOfRow(j, model, pools), reported_by: str(j.reported_by),
    calls: num(j.calls), in: num(j.in), cc: num(j.cc), cr: num(j.cr), out: num(j.out),
    duration_ms: nonneg(j.duration_ms),
    cost_usd: cost,
    cost_source: cost === null ? "unknown" : COST_SOURCES.includes(j.cost_source) ? j.cost_source : "reported",
    // 这一轮是否通过:显式 ok 优先;续修路径的旧行带 reason,passed 即通过;都没有就是未知。
    ok: j.ok === true ? true : j.ok === false ? false : typeof j.reason === "string" ? j.reason === "passed" : null,
    cli_version: str(j.cli_version),
  };
}

/** Claude CLI `--output-format json` 的结果对象 → append() 能直接展开的字段。
 *  拿不到的项是 null;费用来自 CLI 自己的回报,所以记 reported。 */
export function fromClaudeResult(j) {
  const u = j && typeof j === "object" && j.usage && typeof j.usage === "object" ? j.usage : {};
  const cost = j && typeof j === "object" ? nonneg(j.total_cost_usd) : null;
  return {
    calls: j && typeof j === "object" ? nonneg(j.num_turns) : null,
    in: nonneg(u.input_tokens), cc: nonneg(u.cache_creation_input_tokens),
    cr: nonneg(u.cache_read_input_tokens), out: nonneg(u.output_tokens),
    duration_ms: j && typeof j === "object" ? nonneg(j.duration_ms) : null,
    cost_usd: cost, cost_source: cost === null ? "unknown" : "reported",
    session_id: j && typeof j === "object" ? str(j.session_id) : null,
  };
}

function attemptKey(r, index) {
  if (r.attempt !== null) return `${r.card ?? "-"}|${r.run_id || "legacy"}:${r.attempt}`;
  return isAttempt(r.phase) ? `row:${index}` : null;   // 没有尝试号的实现行各算一次;审阅等不算尝试
}

class Sum {
  constructor() {
    this.rows = 0; this.keys = new Set(); this.sources = {};
    this.total = Object.fromEntries(METRICS.map((k) => [k, 0]));
    this.missing = Object.fromEntries(METRICS.map((k) => [k, 0]));
  }
  add(r, index) {
    this.rows++;
    const key = attemptKey(r, index);
    if (key) this.keys.add(key);
    for (const k of METRICS) { if (r[k] === null) this.missing[k]++; else this.total[k] += r[k]; }
    this.sources[r.cost_source] = (this.sources[r.cost_source] || 0) + 1;
  }
  /** 合计里只要有一行未知,该项就是 null;已知部分的和放在 known,未知行数放在 unknown。
   *  一行都没有也是 null:没有记账记录不等于用量为零。 */
  out() {
    const o = { rows: this.rows, attempts: this.keys.size }, known = {}, unknown = {};
    const value = (k) => (k === "cost_usd" ? Math.round(this.total[k] * 1e6) / 1e6 : this.total[k]);
    for (const k of METRICS) {
      const miss = this.missing[k];
      o[k] = this.rows === 0 || miss ? null : value(k);
      if (miss) { unknown[k] = miss; if (miss < this.rows) known[k] = value(k); }
    }
    const named = Object.keys(this.sources).filter((s) => s !== "unknown");
    o.cost_source = named.length === 0 ? "unknown" : named.length === 1 ? named[0] : "mixed";
    o.cost_sources = { ...this.sources };
    o.known = known; o.unknown = unknown;
    return o;
  }
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;      // 表格软件会把这些开头当公式;模型名等可能来自外部自报
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}
const csvLine = (cells) => cells.map(csvCell).join(",");

/** 分组汇总 → CSV。第一列是分组维度,未知值是空格子。 */
export function groupsCsv(g) {
  const lines = [csvLine([g.by, ...CSV_COLUMNS])];
  for (const x of g.groups) lines.push(csvLine([x.key, ...CSV_COLUMNS.map((k) => x[k])]));
  return lines.join(NL) + NL;
}

/** 单卡结算 → CSV:每个「阶段 × 模型」一行,再加 failed(失败尝试)与 total 两行。 */
export function settlementCsv(s) {
  const lines = [csvLine(["card", "phase", "model", ...CSV_COLUMNS])];
  for (const x of s.by) lines.push(csvLine([s.card, x.phase, x.model, ...CSV_COLUMNS.map((k) => x[k])]));
  lines.push(csvLine([s.card, "failed", "*", ...CSV_COLUMNS.map((k) => s.failed[k])]));
  lines.push(csvLine([s.card, "total", "*", ...CSV_COLUMNS.map((k) => s.totals[k])]));
  return lines.join(NL) + NL;
}

function cleanRow(row, pools = null) {
  const cost = nonneg(row.cost_usd), session = str(row.session_id);
  const out = {
    ts: str(row.ts) || localIso(),
    card: int(row.card), attempt: int(row.attempt),
    worker: str(row.worker), line: str(row.line), model: str(row.model), effort: str(row.effort),
    sid: str(row.sid) || (session ? session.slice(0, 8) : null), session_id: session,
    calls: nonneg(row.calls), in: nonneg(row.in), cc: nonneg(row.cc), cr: nonneg(row.cr), out: nonneg(row.out),
    phase: str(row.phase), duration_ms: nonneg(row.duration_ms),
    cost_usd: cost,
    cost_source: cost === null ? "unknown" : COST_SOURCES.includes(row.cost_source) ? row.cost_source : "reported",
    cli_version: str(row.cli_version),
  };
  if (str(row.run_id)) out.run_id = str(row.run_id);
  if (row.ok === true || row.ok === false) out.ok = row.ok;
  if (str(row.reported_by)) out.reported_by = str(row.reported_by);
  // 合同 J2.1:source 只写值域里的值(写入方各自给);pool 没给时按 model 归池(给了对照才归)。
  if (SOURCES.includes(row.source)) out.source = row.source;
  const pool = str(row.pool) ? str(row.pool).slice(0, 40) : pools ? poolOfModel(out.model, pools) : null;
  if (pool) out.pool = pool;
  if (str(row.note)) out.note = str(row.note).slice(0, 400);
  return out;
}

const EXTERNAL_ALIASES = { in: "input_tokens", out: "output_tokens", cc: "cache_creation_input_tokens", cr: "cache_read_input_tokens" };
const EXTERNAL_TEXT = /^[\w.:\/@+\-\[\] ]{1,80}$/;

/** 校验外部执行者自报的用量(一个对象,或最多 50 个对象的数组)。格式不对抛 BAD_INPUT。
 *  没给的项保持 null,不替对方补 0。 */
export function externalRows(payload) {
  const list = Array.isArray(payload) ? payload : [payload];
  if (!list.length || list.length > 50) throw badInput("usage 要给 1 到 50 条用量");
  return list.map((p, i) => {
    const at = list.length > 1 ? `usage[${i}]` : "usage";
    if (!p || typeof p !== "object" || Array.isArray(p)) throw badInput(`${at} 必须是对象`);
    const row = {};
    for (const k of METRICS) {
      const v = p[k] ?? (EXTERNAL_ALIASES[k] ? p[EXTERNAL_ALIASES[k]] : undefined);
      if (v === null || v === undefined) { row[k] = null; continue; }
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw badInput(`${at}.${k} 必须是不小于 0 的数字;不知道就不要写这一项`);
      if (k !== "cost_usd" && !Number.isInteger(v)) throw badInput(`${at}.${k} 必须是整数`);
      row[k] = v;
    }
    for (const k of ["model", "effort", "cli_version", "session_id"]) {
      const v = p[k];
      if (v === null || v === undefined || v === "") { row[k] = null; continue; }
      if (typeof v !== "string" || !EXTERNAL_TEXT.test(v)) throw badInput(`${at}.${k} 只能是 80 字以内的字母、数字和 . : / @ + - [ ] 空格`);
      row[k] = v;
    }
    const phase = p.phase ?? "implement";
    if (!PHASES.includes(phase)) throw badInput(`${at}.phase 只能是 ${PHASES.join(" / ")}`);
    row.phase = phase;
    return row;
  });
}

let defaultLedger = null;

/** 打开一本账。makeDefault=true 时,模块级的 append(row) 写进这一本。 */
export function openLedger(file, { makeDefault = false, pools = null } = {}) {
  let offset, rows, legacy, legacyKeys, settled, settledKeys, mark, stats;
  let dirty = false;
  const reset = () => {
    offset = 0; rows = []; legacy = new Map(); legacyKeys = new Map();
    settled = new Map(); settledKeys = new Set(); mark = ""; stats = { broken: 0, events: 0 };
  };
  reset();

  function registerSettlement(j) {
    const id = Number(j.settled_card);
    if (!Number.isSafeInteger(id)) return;
    const key = `${id}|${j.resolved_at ?? ""}`;
    if (settledKeys.has(key)) return;            // 自己刚写的那条读回来时不重复登记
    settledKeys.add(key);
    if (!settled.has(id)) settled.set(id, []);
    settled.get(id).push(j);
    if (typeof j.resolved_at === "string" && j.resolved_at > mark) mark = j.resolved_at;
  }

  // 面板卡面用的旧形状。词元照旧逐行累加(含审阅等记到这张卡上的用量);
  // 行数、轮数、尝试数只数实现与续修,审阅一次不算一次尝试。
  function foldLegacy(j, r) {
    const c = legacy.get(r.card) || { rows: 0, calls: 0, in: 0, cc: 0, cr: 0, out: 0, rounds: 0, attempts: 0 };
    if (isAttempt(r.phase)) {
      c.rows++; c.rounds = c.rows;
      const keys = legacyKeys.get(r.card) || new Set();
      keys.add(Number.isSafeInteger(j.attempt) ? `${j.run_id || "legacy"}:${j.attempt}` : `unknown:${c.rows}`);
      legacyKeys.set(r.card, keys); c.attempts = keys.size;
    }
    for (const k of TOKENS)
      c[k] = c[k] === null || j[k] === null || j[k] === undefined ? null : c[k] + (Number(j[k]) || 0);
    legacy.set(r.card, c);
  }

  function fold(j) {
    if (!j || typeof j !== "object" || Array.isArray(j)) { stats.broken++; return; }
    if (j.event === "settlement") return registerSettlement(j);
    if (j.event != null) { stats.events++; return; }
    const r = normalizeRow(j, pools);
    rows.push(r);
    if (r.card !== null) foldLegacy(j, r);
  }

  /** 只读新增的部分。写入方可能正写到一半:只归并到最后一个换行,残行留到下次。 */
  function refresh() {
    let size;
    try { size = statSync(file).size; } catch { return; }      // 还没有账本 = 没有用量
    if (size < offset) reset();                                 // 被替换或截短 → 从头归并
    if (size === offset) return;
    let buf;
    try {
      const fd = openSync(file, "r");
      try { buf = Buffer.alloc(size - offset); readSync(fd, buf, 0, buf.length, offset); }
      finally { closeSync(fd); }
    } catch { return; }
    const cut = buf.lastIndexOf(10);
    if (cut < 0) return;
    offset += cut + 1;
    for (const line of buf.subarray(0, cut).toString("utf8").split(NL)) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { stats.broken++; continue; }   // 坏行跳过,不致命
      fold(j);
    }
  }

  function writeLine(object) {
    const text = JSON.stringify(object) + NL;
    try { appendFileSync(file, text, "utf8"); }
    catch (e) {
      if (e.code !== "ENOENT") throw e;
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, text, "utf8");
    }
  }

  /** 追加一行用量。记账不该打断主流程:写不进去返回 {ok:false},不抛。 */
  function append(row) {
    try {
      const clean = cleanRow(row && typeof row === "object" ? row : {}, pools);
      writeLine(clean);
      return { ok: true, row: clean };
    } catch (e) {
      console.warn(`用量记账写入失败(${e.message})—— 不阻塞本次操作`);
      return { ok: false, error: String(e.message || e) };
    }
  }

  /** 外部执行者交付时自报的用量。卡号、尝试号、执行者、线由服务端按交付本身填写,
   *  对方只提供数字;有费用时来源记 external-reported。 */
  function appendExternal(list, { task, worker, runId, outcome }) {
    const written = [];
    for (const p of list) {
      const r = append({ ...p, card: Number(task?.id), attempt: int(task?.attempts), worker, line: task?.line,
        run_id: runId, ok: outcome === "done", reported_by: "external", source: "external",
        cost_source: p.cost_usd === null ? "unknown" : "external-reported" });
      if (r.ok) written.push(r.row);
    }
    return written;
  }

  function cards() { refresh(); return Object.fromEntries(legacy); }

  /** 按 card | line | model | phase | source | pool 分组;from / to 是毫秒(含两端)。带时间范围时,
   *  时刻读不出来的行不计入。
   *  by=card 时每组另有 attempts_failed(范围内有行的失败尝试数,判据同 settlementOf;卡号未知为 null)
   *  与 settled(这张卡有没有结算事件,不看范围),total 另有 attempts_failed,顶层另有 settled(已结算卡在范围内的合计)。 */
  function group(by, { from = null, to = null } = {}) {
    if (!GROUP_KEYS.includes(by)) throw badInput(`by 只能是 ${GROUP_KEYS.join(" | ")}`);
    refresh();
    const map = new Map(), total = new Sum(), ranged = from !== null || to !== null, perCard = by === "card";
    // 失败尝试按整张卡的历史判(与单卡结算一致),再看它的行有没有落在范围内:行号 → 这次尝试的编号。
    const failedRow = new Map(), failedBy = new Map(), settledSum = new Sum(), settledCards = new Set();
    if (perCard) {
      const mineBy = new Map();
      rows.forEach((r, index) => { if (r.card !== null) { if (!mineBy.has(r.card)) mineBy.set(r.card, []); mineBy.get(r.card).push([r, index]); } });
      for (const [id, mine] of mineBy)
        attemptRuns(id, mine).forEach((a, n) => { if (a.failed) for (const [, index] of a.rows) failedRow.set(index, n); });
    }
    rows.forEach((r, index) => {
      if (ranged && (r.at === null || (from !== null && r.at < from) || (to !== null && r.at > to))) return;
      const key = perCard ? (r.card === null ? "?" : String(r.card)) : r[by] ?? "?";
      if (!map.has(key)) map.set(key, new Sum());
      map.get(key).add(r, index); total.add(r, index);
      if (!perCard || r.card === null) return;
      if (failedRow.has(index)) { if (!failedBy.has(key)) failedBy.set(key, new Set()); failedBy.get(key).add(failedRow.get(index)); }
      if (settled.has(r.card)) { settledSum.add(r, index); settledCards.add(r.card); }
    });
    const order = perCard
      ? (a, b) => (a === "?") - (b === "?") || Number(a) - Number(b)
      : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const cardFields = (key) => (key === "?" ? { attempts_failed: null, settled: false }
      : { attempts_failed: failedBy.get(key)?.size || 0, settled: settled.has(Number(key)) });
    const groups = [...map.keys()].sort(order).map((key) => ({ key, ...map.get(key).out(), ...(perCard ? cardFields(key) : {}) }));
    if (!perCard) return { by, from, to, groups, total: total.out() };
    const failedAll = groups.reduce((n, g) => n + (g.attempts_failed || 0), 0);
    return { by, from, to, groups, total: { ...total.out(), attempts_failed: failedAll },
             settled: { cards: settledCards.size, ...settledSum.out() } };
  }

  /** 一张卡的各次尝试,按出现顺序,每次带 failed。mine = 这张卡的 [行, 行号],按账本顺序。
   *  失败尝试 = 最后一轮明确没通过的尝试;旧行不带结果时,后面又开了新尝试的那一次算失败
   *  (上一次结算之前的最后一次尝试除外:那一次把卡送到了完成)。 */
  function attemptRuns(id, mine) {
    const attempts = [], seen = new Map();
    mine.forEach(([r, index], n) => {
      if (!isAttempt(r.phase)) return;
      const key = attemptKey(r, index);
      if (!seen.has(key)) { seen.set(key, { first: n, last: n, ok: null, rows: [] }); attempts.push(seen.get(key)); }
      const a = seen.get(key);
      a.last = n; a.ok = r.ok; a.rows.push([r, index]);
    });
    const cuts = (settled.get(id) || []).map((s) => Number(s.rows_through)).filter(Number.isFinite);
    attempts.forEach((a, n) => {
      const next = attempts[n + 1];
      const superseded = !!next && !cuts.some((c) => a.last < c && c <= next.first);
      a.failed = a.ok === false || (a.ok === null && superseded);
    });
    return attempts;
  }

  /** 某张卡到此刻为止的结算:合计、「阶段 × 模型」明细、失败尝试单列(判据见 attemptRuns)。 */
  function settlementOf(id) {
    const mine = [];
    rows.forEach((r, index) => { if (r.card === id) mine.push([r, index]); });
    const totals = new Sum(), failed = new Sum(), by = new Map();
    mine.forEach(([r, index]) => {
      totals.add(r, index);
      const gk = JSON.stringify([r.phase, r.model]);
      if (!by.has(gk)) by.set(gk, { phase: r.phase, model: r.model, sum: new Sum() });
      by.get(gk).sum.add(r, index);
    });
    for (const a of attemptRuns(id, mine)) if (a.failed) for (const [r, index] of a.rows) failed.add(r, index);
    const rank = (p) => { const i = PHASES.indexOf(p); return i < 0 ? PHASES.length : i; };
    return {
      card: id, rows_through: mine.length,
      first_ts: mine.length ? mine[0][0].ts : null, last_ts: mine.length ? mine[mine.length - 1][0].ts : null,
      totals: totals.out(),
      by: [...by.values()].sort((a, b) => rank(a.phase) - rank(b.phase) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
        .map((x) => ({ phase: x.phase, model: x.model, ...x.sum.out() })),
      failed: failed.out(),
    };
  }

  /** 单卡结算(此刻重算)+ 已写下的结算事件。 */
  function card(id) {
    refresh();
    return { ...settlementOf(id), settlements: [...(settled.get(id) || [])] };
  }

  /** 给已完成的卡写结算事件。doneCards = [{id, resolved_at, resolved_by, line}]。
   *  同一张卡的同一次完成(卡号 + resolved_at)只写一条;重开后再完成是新的 resolved_at,
   *  再写一条,seq 加一。合计是这张卡到此刻的累计,不是两次结算之间的差。 */
  function settle(doneCards, { now = new Date() } = {}) {
    refresh();
    const written = [], when = (t) => String(t.resolved_at ?? "");
    let failedAny = false;
    const list = [...(doneCards || [])].sort((a, b) =>
      when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : Number(a.id) - Number(b.id));
    for (const t of list) {
      const id = Number(t.id);
      if (!Number.isSafeInteger(id) || settledKeys.has(`${id}|${t.resolved_at ?? ""}`)) continue;
      const s = settlementOf(id);
      const event = { ts: localIso(now), event: "settlement", settled_card: id, seq: (settled.get(id)?.length || 0) + 1,
        resolved_at: t.resolved_at ?? null, resolved_by: t.resolved_by ?? null, line: t.line ?? null,
        rows_through: s.rows_through, first_ts: s.first_ts, last_ts: s.last_ts,
        totals: s.totals, by: s.by, failed: s.failed };
      try { writeLine(event); }
      catch (e) { failedAny = true; console.warn(`卡 #${id} 的用量结算写入失败(${e.message})—— 下次再试`); continue; }
      registerSettlement(event);
      written.push(event);
    }
    dirty = failedAny;
    return written;
  }

  /** 已结算到的最晚 resolved_at。服务端据此只查「此后完成的卡」;上次有写入失败时回到空串,
   *  让下一次把全部已完成的卡重新对一遍。 */
  const watermark = () => (dirty ? "" : mark);

  /** 合同 J2.3:各池「看板记到的」近 5 小时 / 7 天合计(只覆盖板内记了账的调用)。
   *  tokens = 窗内各行已知词元(in + cc + cr + out)之和,窗内一行都没有已知词元 = null;usd 同理(没有任何已知费用 = null);
   *  calls = 窗内的账本行数(一行 = 一轮模型调用);rate_per_h = 5 小时窗的 tokens ÷ 5(tokens 为 null 时 null)。
   *  返回 Map(pool → {windows:[{label, tokens, usd, calls}], rate_per_h})。只列窗内有行的池。 */
  function poolWindows(now = Date.now()) {
    refresh();
    const WINDOWS = [["5h", 5 * 3600e3], ["7d", 7 * 86400e3]], out = new Map();
    for (const r of rows) {
      if (r.at === null || r.at > now) continue;
      for (const [label, span] of WINDOWS) {
        if (now - r.at > span) continue;
        if (!out.has(r.pool)) out.set(r.pool, Object.fromEntries(WINDOWS.map(([l]) => [l, { label: l, tokens: null, usd: null, calls: 0 }])));
        const w = out.get(r.pool)[label];
        w.calls++;
        const known = ["in", "cc", "cr", "out"].filter((k) => r[k] !== null);
        if (known.length) w.tokens = (w.tokens || 0) + known.reduce((n, k) => n + r[k], 0);
        if (r.cost_usd !== null) w.usd = Math.round(((w.usd || 0) + r.cost_usd) * 1e6) / 1e6;
      }
    }
    const result = new Map();
    for (const [pool, ws] of out) {
      const windows = WINDOWS.map(([l]) => ws[l]);
      result.set(pool, { windows, rate_per_h: windows[0].tokens === null ? null : Math.round(windows[0].tokens / 5) });
    }
    return result;
  }

  const ledger = { file, refresh, append, appendExternal, cards, group, card, settle, watermark, poolWindows,
    poolOf: (model) => (pools ? poolOfModel(model, pools) : OTHER_POOL),
    stats: () => ({ ...stats, rows: rows.length, offset }) };
  if (makeDefault) defaultLedger = ledger;
  return ledger;
}

/** 给拆解、压缩、协调线对话等服务端代码用:往默认账本追加一行用量。
 *  row 的键:phase(必给)、card、worker、line、model、effort、calls、in、cc、cr、out、
 *  duration_ms、cost_usd、cost_source、cli_version、session_id、attempt、run_id、ok、note。
 *  不知道的项不要写或写 null。从不抛错。 */
export function append(row) {
  if (!defaultLedger) return { ok: false, error: "用量账本尚未打开" };
  return defaultLedger.append(row);
}

/** GET /api/usage 与 GET /api/usage/card/:id 的应答。query 是 URLSearchParams。
 *  不带任何参数时保持旧形状 {cards},面板卡面还在用。 */
export function usageHttp(ledger, pathname, query) {
  const reply = (status, body) => ({ status, type: "application/json; charset=utf-8", body: JSON.stringify(body) });
  const csv = (text) => ({ status: 200, type: "text/csv; charset=utf-8", body: text });
  const format = query.get("format") || "json";
  if (format !== "json" && format !== "csv") return reply(400, { error: "format 只能是 json 或 csv" });
  const one = /^\/api\/usage\/card\/(\d{1,15})$/.exec(pathname);
  if (one) {
    const s = ledger.card(Number(one[1]));
    return format === "csv" ? csv(settlementCsv(s)) : reply(200, s);
  }
  if (pathname !== "/api/usage") return reply(404, { error: "没有这个用量接口" });
  if (!["by", "from", "to", "since", "until", "format"].some((k) => query.has(k))) return reply(200, { cards: ledger.cards() });
  const by = query.get("by") || "card";
  if (!GROUP_KEYS.includes(by)) return reply(400, { error: `by 只能是 ${GROUP_KEYS.join(" | ")}` });
  // since / until 与 from / to 同义;两种写法同时给且不一致时不猜哪个算数。
  const end = (a, b) => (query.has(a) && query.has(b) && query.get(a) !== query.get(b) ? undefined : query.has(a) ? query.get(a) : query.get(b));
  const fromRaw = end("from", "since"), toRaw = end("to", "until");
  if (fromRaw === undefined || toRaw === undefined) return reply(400, { error: "from 与 since、to 与 until 是同一个意思,只写一个,或写成一样的值" });
  const from = parseTime(fromRaw), to = parseTime(toRaw, true);
  if (Number.isNaN(from) || Number.isNaN(to))
    return reply(400, { error: "from / to 要写成 2026-11-10 或 2026-11-10T08:30:00 这样的时刻" });
  const g = ledger.group(by, { from, to });
  return format === "csv" ? csv(groupsCsv(g)) : reply(200, g);
}
