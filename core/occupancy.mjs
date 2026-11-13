// 公告板 v3 合同 I6「文件占用表」:谁在动哪些路径。只提示,不拦任何动作(领卡、声明、交付照常)。
// 占用的两种来源:
//   - 声明:操作者写在卡上的 touches(建卡 / 计划项 / POST /api/tasks/:id/touches);执行者经桥 declare_paths
//     给自己手上的卡声明(覆盖式,≤50;只在这一轮有效 —— 卡交付、退回、被回收或换了一轮就失效)。
//   - 交付:还没验收的卡(待验收)最近一次交付指纹里的 files(core/credibility.mjs 记的)。
// 路径规则同 H1(相对工作仓、规范化、不许越出);以 `/` 结尾 = 目录前缀(目录下的一切都算)。
// 表只由看板服务创建(server.mjs 打开库后 migrate);只存配置与「同一对卡同一路径只提醒一次」的记录。
import { normPath } from "./credibility.mjs";

export const PATHS_MAX = 50;
export const SNAPSHOT_TTL_MS = 2000;

/** 一条路径:相对工作仓;结尾的 `/`(或 `\`)保留为目录前缀。规则与错误码同 H1 的 normPath。 */
export function normTouch(v, { err, ERR }) {
  if (typeof v !== "string") throw err(ERR.BAD_INPUT, "路径要字符串");
  const dir = /[\\/]$/.test(v);
  let p;
  try { p = normPath(v, { err, ERR }); }
  catch (e) { throw err(ERR.BAD_INPUT, String(e?.message || e).replace("files[].path", "路径")); }
  return dir ? p + "/" : p;
}

/** 路径数组:≤50 项、去重保序。undefined / null = 不设(由调用方决定是否「清掉」)。 */
export function normTouches(v, ctx, field = "paths") {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > PATHS_MAX) throw ctx.err(ctx.ERR.BAD_INPUT, `${field} 要路径数组,最多 ${PATHS_MAX} 项`);
  const out = [];
  for (const x of v) { const p = normTouch(x, ctx); if (!out.includes(p)) out.push(p); }
  return out;
}

/** 两条路径重不重叠:相同、或一方是另一方的目录前缀。重叠时返回更具体的那条,否则 null。 */
export function overlapOf(a, b) {
  if (a === b) return a;
  const ad = a.endsWith("/"), bd = b.endsWith("/");
  if (ad && b.startsWith(a)) return b;
  if (bd && a.startsWith(b)) return a;
  return null;
}

/**
 * @param db        node:sqlite 句柄
 * @param err/ERR   store.err / store.ERR
 * @param filesOf   (taskId) => 最近一次交付指纹里的 files([{path, sha256}])
 * @param skip      (task) => true = 不算占用(第 8 波第一轮恒 false;取代落地后由 server 接「被取代的卡」)
 * @param clean     (标题) => 给人看的一行(脱敏、截断)
 * @param emit      (type, data) => SSE 事件
 */
export function openOccupancy({ db, err, ERR, filesOf = () => [], skip = () => false, clean = (s) => String(s ?? ""), emit = () => {}, now = () => new Date().toISOString() }) {
  const ctx = { err, ERR };
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS occ_touches (task_id INTEGER PRIMARY KEY, paths_json TEXT NOT NULL, by_ TEXT, at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS occ_declared (task_id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, paths_json TEXT NOT NULL, by_ TEXT, at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS occ_overlap_events (a INTEGER NOT NULL, b INTEGER NOT NULL, path TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (a, b, path))`);
  }
  const parse = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };
  let memo = null, memoAt = 0;
  const invalidate = () => { memo = null; };

  /** 操作者写的 touches。空数组 / null = 清掉。 */
  function setTouches(id, paths, by) {
    if (!paths || !paths.length) db.prepare("DELETE FROM occ_touches WHERE task_id=?").run(Number(id));
    else db.prepare("INSERT INTO occ_touches(task_id, paths_json, by_, at) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET paths_json=excluded.paths_json, by_=excluded.by_, at=excluded.at")
      .run(Number(id), JSON.stringify(paths), by == null ? null : String(by), now());
    invalidate();
    return paths && paths.length ? paths : [];
  }
  const touchesOf = (id) => parse(db.prepare("SELECT paths_json FROM occ_touches WHERE task_id=?").get(Number(id))?.paths_json);

  /** 执行者声明(覆盖式)。持卡核对由调用方做(server:卡在执行中、持有者是这个执行者、run 对得上)。 */
  function declare(id, runId, paths, by) {
    if (!paths.length) db.prepare("DELETE FROM occ_declared WHERE task_id=?").run(Number(id));
    else db.prepare("INSERT INTO occ_declared(task_id, run_id, paths_json, by_, at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET run_id=excluded.run_id, paths_json=excluded.paths_json, by_=excluded.by_, at=excluded.at")
      .run(Number(id), String(runId), JSON.stringify(paths), by == null ? null : String(by), now());
    invalidate();
    return paths;
  }
  /** 这一轮还有效的执行者声明:卡在执行中、run_id 是声明时那一轮。别的情况 = 已失效(返回 [])。 */
  function declaredOf(t) {
    if (!t || t.status !== "in_progress" || !t.run_id) return [];
    const r = db.prepare("SELECT run_id, paths_json FROM occ_declared WHERE task_id=?").get(Number(t.id));
    return r && r.run_id === String(t.run_id) ? parse(r.paths_json) : [];
  }

  const stateOf = (t) => (t.status === "waiting" && t.waiting_for === "review" ? "delivered" : "running");
  /** 一张卡此刻占着的路径(entries)。未开始的卡只有操作者写的 touches(给「领之前看一眼」用),不进占用表。 */
  function entriesOf(t, { forTable = true } = {}) {
    if (!t || t.archived_at || t.status === "done" || t.kind === "goal" || skip(t)) return [];
    const active = t.status === "in_progress" || t.status === "waiting";
    if (forTable && !active) return [];
    const base = { id: Number(t.id), title: clean(t.subject), line: t.line ?? null, state: active ? stateOf(t) : "queued" };
    const out = [], seen = new Set();
    const add = (path, source) => { if (seen.has(path)) return; seen.add(path); out.push({ ...base, path, source }); };
    for (const p of touchesOf(t.id)) add(p, "declared");
    for (const p of declaredOf(t)) add(p, "declared");
    if (t.status === "waiting" && t.waiting_for === "review") for (const f of filesOf(t.id) || []) if (f && typeof f.path === "string") add(f.path, "delivered");
    return out;
  }

  /** 全板占用:{ rows:[{path, cards:[{id,title,line,state,source}]}], overlaps:[{path, cards:[ids]}], entries }。2 秒内与写入后失效。 */
  function snapshot() {
    if (memo && Date.now() - memoAt < SNAPSHOT_TTL_MS) return memo;
    const tasks = db.prepare("SELECT * FROM tasks WHERE archived_at IS NULL AND status IN ('in_progress','waiting') ORDER BY id").all();
    const entries = tasks.flatMap((t) => entriesOf(t));
    const byPath = new Map();
    for (const e of entries) {
      if (!byPath.has(e.path)) byPath.set(e.path, []);
      const list = byPath.get(e.path);
      if (!list.some((c) => c.id === e.id)) list.push({ id: e.id, title: e.title, line: e.line, state: e.state, source: e.source });
    }
    const rows = [...byPath.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([path, cards]) => ({ path, cards }));
    const ov = new Map();
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      if (a.id === b.id) continue;
      const p = overlapOf(a.path, b.path);
      if (p == null) continue;
      if (!ov.has(p)) ov.set(p, new Set());
      ov.get(p).add(a.id).add(b.id);
    }
    const overlaps = [...ov.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([path, ids]) => ({ path, cards: [...ids].sort((x, y) => x - y) }));
    memo = { rows, overlaps, entries }; memoAt = Date.now();
    return memo;
  }

  /** 一张卡与别的卡的重叠:[{path, with:[{id, line}]}](任务对象、领卡 / 声明 / 交付应答同形)。 */
  function overlapsFor(t) {
    const mine = entriesOf(t, { forTable: false });
    if (!mine.length) return [];
    const others = snapshot().entries.filter((e) => e.id !== Number(t.id));
    const m = new Map();
    for (const a of mine) for (const b of others) {
      const p = overlapOf(a.path, b.path);
      if (p == null) continue;
      if (!m.has(p)) m.set(p, new Map());
      m.get(p).set(b.id, b.line);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([path, w]) => ({ path, with: [...w.entries()].sort((x, y) => x[0] - y[0]).map(([id, line]) => ({ id, line })) }));
  }

  /** 记下重叠并发事件 occupancy.overlap:同一对卡同一路径只记一次(表里有就不再发)。返回 overlapsFor 的结果。 */
  function note(t) {
    invalidate();
    const out = overlapsFor(t);
    const ins = db.prepare("INSERT OR IGNORE INTO occ_overlap_events(a, b, path, at) VALUES(?,?,?,?)");
    for (const o of out) for (const w of o.with) {
      const a = Math.min(Number(t.id), w.id), b = Math.max(Number(t.id), w.id);
      if (ins.run(a, b, o.path, now()).changes) emit("occupancy.overlap", { path: o.path, ids: [a, b] });
    }
    return out;
  }
  const eventCount = () => Number(db.prepare("SELECT COUNT(*) AS n FROM occ_overlap_events").get()?.n || 0);

  return { migrate, normTouches: (v, field) => normTouches(v, ctx, field), setTouches, touchesOf, declare, declaredOf, snapshot, overlapsFor, note, invalidate, eventCount };
}
