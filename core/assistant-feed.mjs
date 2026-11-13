// 助手的提醒游标(合同 G6):给聊天机器人、可穿戴设备背后的常驻 AI 用的「已确认到哪」。
//   提醒流:每次读简报时,把当前「等你处理」的每一件与 24 小时内完成的卡各记一行(同一件只记一次),拿一个只增不减的序号。
//     「同一件」= 类别 + 卡号 + 标题 + 进入该状态的时刻;卡被打回后再交付是新的一件,拿新序号。表在 board.db 里(assistant_feed)。
//   游标:服务器发的不透明串。普通是「N」;静音(quiet)期间是「N~U」——N 以下全部送过,U 以下的紧急件送过(N 与 U 之间的
//     非紧急件还没送,切回 normal 时补发)。客户端把上次拿到的游标原样当 since 交回来,看板就把它记成这个令牌「已确认到哪」。
//   持久化:按令牌的哈希(不存令牌本身)记在数据目录的 assistant_cursors.json(受管线禁读表登记了这个文件名);
//     撤销令牌时删掉它的游标。不带 since 重连 = 从记下的位置续发:不重刷全部,也不丢。
//   since 只是序号:它只决定从提醒流的哪里开始给,给出去的内容与不带 since 时同一份(助手本来就看得到的「等你处理」),
//     借它读不到角色之外的东西;不是看板发过的值(格式不对、超出当前最大序号、U 小于 N)一律 BAD_CURSOR。
import { readFileSync, writeFileSync, renameSync } from "node:fs";

/** 紧急类:线故障、AI 卡住(心跳超时)、受阻。quiet 模式只给这几类。 */
export const URGENT = new Set(["line_fault", "stalled", "blocked"]);
export const MODES = ["normal", "quiet"];
export const CHANGES_MAX = 50;
const FEED_KEEP = 2000;                     // 提醒流只留最近这么多行(当前还在的件不删)
const CURSOR_RE = /^(\d{1,15})(?:~(\d{1,15}))?$/;

const badCursor = (msg) => Object.assign(new Error(msg), { code: "BAD_CURSOR" });

/** 一件提醒的身份。与桥里「同一连接只提醒一次」用的是同一个键。 */
export const attnKey = (a) => [a.kind, a.task_id ?? "", a.title, a.since ?? ""].join("|");

/** mode 参数:缺省 normal;其余抛 BAD_INPUT。 */
export function modeOf(raw) {
  if (raw === null || raw === undefined || raw === "") return "normal";
  if (!MODES.includes(raw)) throw Object.assign(new Error("mode 只接受 normal / quiet"), { code: "BAD_INPUT" });
  return raw;
}

/** since 参数 → { n, u };不给 → null。max = 当前最大序号:超出的不是看板发过的值。 */
export function parseCursor(raw, max) {
  if (raw === null || raw === undefined || raw === "") return null;
  const m = typeof raw === "string" ? CURSOR_RE.exec(raw) : null;
  if (!m) throw badCursor("since 要原样交回看板给的 cursor");
  const n = Number(m[1]), u = m[2] === undefined ? n : Number(m[2]);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(u) || n > max || u > max || u < n) throw badCursor("since 不是看板发过的 cursor");
  return { n, u };
}
export const cursorText = ({ n, u }) => (u > n ? `${n}~${u}` : String(n));

/**
 * db:node:sqlite 库;file:游标文件(数据目录下);clock:毫秒时钟。
 * 返回 { migrate, max, sync, rowsAfter, stored, ack, dropExecutor, pick }。
 */
export function openAssistantFeed({ db, file, clock = Date.now }) {
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_feed (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, task_id INTEGER, title TEXT NOT NULL, at INTEGER NOT NULL)`);
  }
  const max = () => Number(db.prepare("SELECT COALESCE(MAX(seq), 0) m FROM assistant_feed").get().m);

  /** 把这一刻的件记进提醒流(已有的不动),返回 key → seq。entries:[{ key, kind, task_id?, title }]。 */
  function sync(entries) {
    const ins = db.prepare("INSERT INTO assistant_feed (key, kind, task_id, title, at) VALUES (?,?,?,?,?)");
    const get = db.prepare("SELECT seq FROM assistant_feed WHERE key=?");
    const out = new Map(), t = clock();
    const own = !db.isTransaction;
    db.exec(own ? "BEGIN IMMEDIATE" : "SAVEPOINT assistant_feed_sync");
    try {
      for (const e of entries) {
        if (out.has(e.key)) continue;
        let r = get.get(e.key);                               // 先查再插:冲突的插入也会吃掉自增序号
        if (!r) { ins.run(e.key, e.kind, e.task_id ?? null, e.title, t); r = get.get(e.key); }
        out.set(e.key, Number(r.seq));
      }
      const floor = max() - FEED_KEEP;
      if (floor > 0) db.prepare("DELETE FROM assistant_feed WHERE seq<? AND key NOT IN (SELECT value FROM json_each(?))").run(floor, JSON.stringify([...out.keys()]));
      db.exec(own ? "COMMIT" : "RELEASE assistant_feed_sync");
    } catch (e) { try { db.exec(own ? "ROLLBACK" : "ROLLBACK TO assistant_feed_sync; RELEASE assistant_feed_sync"); } catch {} throw e; }
    return out;
  }
  /** 提醒流里序号大于 n 的最近 limit 行(旧 → 新)。 */
  const rowsAfter = (n, limit = CHANGES_MAX * 4) =>
    db.prepare("SELECT seq, kind, task_id, title, at FROM assistant_feed WHERE seq>? ORDER BY seq DESC LIMIT ?").all(n, limit).reverse();

  // ── 游标文件:{ "<令牌哈希>": { executor_id, n, u, at } }。坏文件当空(重连从头给一遍,不丢)。
  function load() {
    try { const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
    catch { return {}; }
  }
  function save(v) { const tmp = file + ".tmp"; writeFileSync(tmp, JSON.stringify(v), "utf8"); renameSync(tmp, file); }
  /** 这个令牌记下的位置;没有或已不合当前提醒流(库被换过)→ null。 */
  function stored(hash) {
    const r = load()[hash];
    if (!r) return null;
    const n = Number(r.n), u = Number(r.u), m = max();
    return Number.isSafeInteger(n) && Number.isSafeInteger(u) && n >= 0 && u >= n && u <= m ? { n, u } : null;
  }
  /** 记「已确认到哪」= 见过的最大 since(两段各取大)。 */
  function ack(hash, executorId, cur) {
    const all = load(), prev = all[hash];
    const n = Math.max(cur.n, Number(prev?.n) || 0), u = Math.max(cur.u, Number(prev?.u) || 0, n);
    if (prev && prev.n === n && prev.u === u && prev.executor_id === executorId) return;
    all[hash] = { executor_id: String(executorId), n, u, at: new Date(clock()).toISOString() };
    save(all);
  }
  /** 撤销 / 重新兑换时删掉这个执行者的全部游标。返回删了几条。 */
  function dropExecutor(executorId) {
    const all = load(); let k = 0;
    for (const [h, r] of Object.entries(all)) if (r?.executor_id === String(executorId)) { delete all[h]; k++; }
    if (k) save(all);
    return k;
  }

  /**
   * 按游标挑件。attention = 这一刻的「等你处理」全量(未截断),done = 24 小时内完成的卡 [{task_id,title,at}];
   * cur = { n, u }(null = 从头);mode = normal | quiet。
   * → { items(这一刻还在、游标之后、本模式该给的件), cursor(下一次交回的串), muted(静音压下没给的件数), changes(提醒流游标之后的行) }
   */
  function pick({ attention, done = [], cur, mode = "normal" }) {
    const entries = [...attention.map((a) => ({ key: attnKey(a), kind: a.kind, task_id: a.task_id, title: a.title })),
                     ...done.map((d) => ({ key: ["done", d.task_id, d.at].join("|"), kind: "done", task_id: d.task_id, title: d.title }))];
    const seqOf = sync(entries), top = max(), c = cur ?? { n: 0, u: 0 };
    const fresh = (kind, seq) => seq > c.n && !(URGENT.has(kind) && seq <= c.u);
    const allowed = (kind) => mode === "normal" || URGENT.has(kind);
    const items = [], seen = new Set(); let muted = 0;
    for (const a of attention) {
      const key = attnKey(a), seq = seqOf.get(key);
      if (seen.has(key) || !fresh(a.kind, seq)) continue;
      seen.add(key);
      if (allowed(a.kind)) items.push(a); else muted++;
    }
    const changes = rowsAfter(c.n).filter((r) => fresh(r.kind, r.seq) && allowed(r.kind)).slice(-CHANGES_MAX)
      .map((r) => ({ at: new Date(Number(r.at)).toISOString(), kind: r.kind, ...(r.task_id != null ? { task_id: Number(r.task_id) } : {}), title: r.title }));
    const next = mode === "normal" ? { n: top, u: top } : { n: c.n, u: top };
    return { items, cursor: cursorText(next), muted, changes };
  }

  return { migrate, max, sync, rowsAfter, stored, ack, dropExecutor, pick };
}
