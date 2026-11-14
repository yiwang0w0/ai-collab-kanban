// 公告板 v3 合同 J2.2 / J2.3「池读数」:额度条的真数据源。
// 看板自己的账本只覆盖板内调用,算不出供应商那边还剩多少;读数由操作者或执行者**自报**(在各自那一侧看到的百分比),
// 看板只记、只显示(以及之后 J5 开关的依据,默认关)。「池用完」仍只认限流时记下的那条硬事实(server 的 poolState),
// 读数再高也不会把池标成 down,读数再低也不会把 down 清掉。
// 表 pool_readings 在 board.db,只追加(改 / 删由触发器拒绝),不往数据目录写新文件。

export const READING_FRESH_MS = 60 * 60 * 1000;          // 超过 60 分钟 = stale;60 分钟内操作者的压过执行者的
export const RESETS_PAST_SLACK_MS = 10 * 60 * 1000;      // resets_at 最多可以早于现在 10 分钟(两边时钟差 + 刚好重置)
export const RESETS_FUTURE_MAX_MS = 35 * 86400 * 1000;   // 也不收 35 天以后的(没有哪个窗这么长,多半是写错)
export const WINDOW_MAX = 16, NOTE_MAX = 80;
export const QUOTA_LOW_DEFAULT = 90, QUOTA_LOW_MIN = 50, QUOTA_LOW_MAX = 99;
export const LEDGER_EXCLUDES = ["bridge_executors_without_usage", "coordinator_seat", "desktop_sessions"];
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** prefs.quota_low_at 的校验:50–99 的整数。 */
export const checkQuotaLowAt = (v) => Number.isInteger(v) && v >= QUOTA_LOW_MIN && v <= QUOTA_LOW_MAX;

/** POST /api/pools/reading 的正文 → 规范后的一条;不合规抛 BAD_INPUT(ctx.err / ctx.ERR)。
 *  poolIds = 配置里的 runtime id(另认 "other");clean = 给 note 的脱敏函数。 */
export function checkReading(b, { poolIds = [], now = Date.now(), clean = (s) => s, err, ERR }) {
  const bad = (m) => err(ERR.BAD_INPUT, m);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("正文要是 {pool, window, used_pct, resets_at?, note?}");
  for (const k of Object.keys(b)) if (!["pool", "window", "used_pct", "resets_at", "note"].includes(k)) throw bad(`不认识的字段 ${k}`);
  const pools = [...poolIds, "other"];
  if (typeof b.pool !== "string" || !pools.includes(b.pool)) throw bad(`pool 只能是 ${pools.join(" / ")}`);
  const window = typeof b.window === "string" && !CONTROL.test(b.window) ? b.window.trim() : "";
  if (!window || [...window].length > WINDOW_MAX) throw bad(`window 要 1–${WINDOW_MAX} 字、单行,例如 "5h" / "7d"`);
  if (typeof b.used_pct !== "number" || !Number.isFinite(b.used_pct) || b.used_pct < 0 || b.used_pct > 100) throw bad("used_pct 要 0 到 100 的数字");
  let resets_at = null;
  if (b.resets_at !== undefined && b.resets_at !== null) {
    const t = typeof b.resets_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(b.resets_at) ? Date.parse(b.resets_at) : NaN;
    if (!Number.isFinite(t)) throw bad("resets_at 要写成 ISO 时刻,例如 2026-11-14T18:00:00Z");
    if (t < now - RESETS_PAST_SLACK_MS) throw bad("resets_at 早于现在 10 分钟以上:这个窗已经重置过了,请报重置后的读数");
    if (t > now + RESETS_FUTURE_MAX_MS) throw bad("resets_at 不能晚于 35 天以后");
    resets_at = new Date(t).toISOString();
  }
  let note = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string" || CONTROL.test(b.note) || [...b.note].length > NOTE_MAX) throw bad(`note 要单行、${NOTE_MAX} 字以内`);
    note = String(clean(b.note.trim())).slice(0, NOTE_MAX * 2) || null;
  }
  return { pool: b.pool, window, used_pct: Math.round(b.used_pct * 10) / 10, resets_at, note };
}

export function openPoolReadings({ db, now = () => new Date().toISOString() }) {
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS pool_readings (id INTEGER PRIMARY KEY AUTOINCREMENT, pool TEXT NOT NULL, window TEXT NOT NULL,
      used_pct REAL NOT NULL, resets_at TEXT, note TEXT, by_role TEXT NOT NULL CHECK (by_role IN ('operator','executor')), by_id TEXT, at TEXT NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS pool_readings_pool ON pool_readings(pool, window, id)");
    db.exec("CREATE TRIGGER IF NOT EXISTS pool_readings_no_update BEFORE UPDATE ON pool_readings BEGIN SELECT RAISE(ABORT, 'pool_readings is append-only'); END");
    db.exec("CREATE TRIGGER IF NOT EXISTS pool_readings_no_delete BEFORE DELETE ON pool_readings BEGIN SELECT RAISE(ABORT, 'pool_readings is append-only'); END");
  }
  /** 追加一条(谁能写由 server 核:操作者或执行者)。 */
  function add(r, { role, id = null }) {
    const at = now();
    const info = db.prepare("INSERT INTO pool_readings(pool, window, used_pct, resets_at, note, by_role, by_id, at) VALUES(?,?,?,?,?,?,?,?)")
      .run(r.pool, r.window, r.used_pct, r.resets_at, r.note, role, id == null ? null : String(id), at);
    return { id: Number(info.lastInsertRowid), ...r, by_role: role, by_id: id == null ? null : String(id), at };
  }
  /** 最近的读数(新的在前),给操作者的 GET /api/pools/readings。 */
  const recent = (limit = 50) => db.prepare("SELECT * FROM pool_readings ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(200, limit | 0)));
  /** 某池近 sinceMs 毫秒内的读数(旧的在前)。有效读数与推算只需要近的:超过 7 天的不读。 */
  const forPool = (pool, sinceIso) => db.prepare("SELECT * FROM pool_readings WHERE pool=? AND at>=? ORDER BY id").all(String(pool), String(sinceIso));
  /** 近期有读数的池(给「other 有读数就列出来」用)。 */
  const poolsSince = (sinceIso) => db.prepare("SELECT DISTINCT pool FROM pool_readings WHERE at>=?").all(String(sinceIso)).map((r) => r.pool);
  return { migrate, add, recent, forPool, poolsSince };
}

const ms = (iso) => Date.parse(iso || "");
/**
 * 有效读数:每个窗取最新一条;但 60 分钟内有操作者的读数时,取最新的那条操作者读数(压过更新的执行者读数)。
 * rows = 同一池的读数(任意顺序);返回 [{window, row, stale}],按窗名排序。
 */
export function effectiveReadings(rows = [], now = Date.now()) {
  const byWindow = new Map();
  for (const r of rows) { if (!byWindow.has(r.window)) byWindow.set(r.window, []); byWindow.get(r.window).push(r); }
  const out = [];
  for (const [window, list] of byWindow) {
    const sorted = [...list].sort((a, b) => ms(a.at) - ms(b.at) || a.id - b.id);
    const latest = sorted[sorted.length - 1];
    const op = [...sorted].reverse().find((r) => r.by_role === "operator" && now - ms(r.at) <= READING_FRESH_MS);
    const row = op || latest;
    out.push({ window, row, stale: !(now - ms(row.at) <= READING_FRESH_MS) });
  }
  return out.sort((a, b) => (a.window < b.window ? -1 : a.window > b.window ? 1 : 0));
}

/** 状态:down 只来自限流记录;low / ok 只来自新鲜读数(任一窗 ≥ lowAt = low);没有新鲜读数 = unknown。 */
export function stateOf({ down = false, effective = [], lowAt = QUOTA_LOW_DEFAULT }) {
  if (down) return "down";
  const fresh = effective.filter((e) => !e.stale);
  if (!fresh.length) return "unknown";
  return fresh.some((e) => e.row.used_pct >= lowAt) ? "low" : "ok";
}

/**
 * 推算还能跑多久:同一窗最近两次读数(不分谁报的)的斜率推到 100%,从现在算起。
 * 不足两次、两次同一时刻、斜率 ≤ 0、较新的那次已 stale = 这个窗推不出;各窗里取最短的。都推不出 = unknown。
 */
export function runwayOf(rows = [], now = Date.now()) {
  const byWindow = new Map();
  for (const r of rows) { if (!byWindow.has(r.window)) byWindow.set(r.window, []); byWindow.get(r.window).push(r); }
  let best = null;
  for (const list of byWindow.values()) {
    if (list.length < 2) continue;
    const [a, b] = [...list].sort((x, y) => ms(x.at) - ms(y.at) || x.id - y.id).slice(-2);
    const dt = (ms(b.at) - ms(a.at)) / 60000;
    if (!(dt > 0) || now - ms(b.at) > READING_FRESH_MS) continue;
    const slope = (b.used_pct - a.used_pct) / dt;           // 百分点 / 分钟
    if (!(slope > 0)) continue;
    const minutes = Math.max(0, Math.round((100 - b.used_pct) / slope - (now - ms(b.at)) / 60000));
    if (best === null || minutes < best) best = minutes;
  }
  return best === null ? { basis: "unknown", minutes: null } : { basis: "projected", minutes: best };
}

/** 读数行 → 接口里的一项(by_label 由调用方给:操作者「你」,执行者用登记名)。note 不进额度接口。 */
export const readingOut = (e, labelOf = () => null) => ({ window: e.window, used_pct: e.row.used_pct, resets_at: e.row.resets_at ?? null,
  by: e.row.by_role === "operator" ? "operator" : "executor", by_label: labelOf(e.row), at: e.row.at, stale: e.stale });

/** 账本摘要(没有任何行的池 = 两个窗都是 tokens / usd null、calls 0)。 */
export function ledgerOut(w) {
  const empty = (label) => ({ label, tokens: null, usd: null, calls: 0 });
  const windows = ["5h", "7d"].map((l) => w?.windows?.find((x) => x.label === l) || empty(l))
    .map((x) => ({ label: x.label, tokens: x.tokens ?? null, usd: x.usd ?? null, calls: x.calls | 0 }));
  return { windows, rate_per_h: w?.rate_per_h ?? null, coverage: "board_only", excludes: [...LEDGER_EXCLUDES] };
}
