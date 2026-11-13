// 公告板 v3 合同 I10b「底提交前提」:卡可带 base:{commit, onto?:"refs/heads/…"}(只由操作者写:建卡 / 计划项 / POST /api/tasks/:id/base)。
// 板只读核(调用约束同 integrate.mjs:--no-replace-objects、清继承的 GIT_*、5 秒超时;不检出、不执行仓内任何东西),
//   只在定时扫里跑(server 把 scan 并进整合阶段那一次 30 秒定时扫;写入后立刻异步补扫一次);请求路径与领卡事务里只读缓存。
//   state:ok / missing(工作仓里没有这个提交)/ diverged(给了 onto 而 commit 不是它的祖先)/ unknown(线没有可读工作仓、
//   超时、onto 不存在、还没扫到);behind = onto 比 commit 多几笔(封顶 999)。
//   missing / diverged → 领卡闸 BASE_GONE(要本人看:fault);unknown 与 behind 只显示。交付指纹的 base_commit 与 base.commit 不同 → flags base_differs。
// 表在 board.db(server.mjs 打开库后 migrate)。
import { gitQuery, normTarget } from "./integrate.mjs";

const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const FULL_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const BEHIND_MAX = 999;

/** base 参数:{commit, onto?}。null = 撤销;undefined = 不设。commit 只验形(7–40 位十六进制,存小写)。 */
export function normBase(v, ctx) {
  const { err, ERR } = ctx;
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw err(ERR.BAD_INPUT, "base 要 {commit, onto?}");
  for (const k of Object.keys(v)) if (!["commit", "onto"].includes(k)) throw err(ERR.BAD_INPUT, `base 不认识的字段 ${k}`);
  if (typeof v.commit !== "string" || !COMMIT_RE.test(v.commit.toLowerCase())) throw err(ERR.BAD_INPUT, "base.commit 要 7–40 位十六进制提交号");
  const onto = v.onto === undefined || v.onto === null ? null : normTarget(v.onto, ctx);
  return { commit: v.commit.toLowerCase(), onto };
}

/**
 * @param repoForLine (line) => 板可读的工作仓 | null(与 credibility / integrate 同一个)
 * @param query       注入点(测试计数用):(git, repo, args) => Promise<{ok, code, out, broken}>
 */
export function openBase({ db, store, git = () => null, repoForLine = () => null, query = gitQuery, now = () => new Date().toISOString() }) {
  const ctx = { err: store.err, ERR: store.ERR };
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS task_base (task_id INTEGER PRIMARY KEY, commit_ TEXT NOT NULL, onto TEXT, by_ TEXT, at TEXT NOT NULL)`);
  }
  const get = (id) => { const r = db.prepare("SELECT commit_, onto, at FROM task_base WHERE task_id=?").get(Number(id)); return r ? { commit: r.commit_, onto: r.onto ?? null, at: r.at } : null; };
  function set(id, v, by = "operator") {
    const t = store.get(db, Number(id));
    if (!t) throw store.err(store.ERR.NOT_FOUND, `卡 #${id} 不存在`);
    const before = get(id);
    if (!v) { if (before) { db.prepare("DELETE FROM task_base WHERE task_id=?").run(Number(id)); store.appendEvent(db, { taskId: Number(id), kind: "base.set", actor: by, detail: { commit: null, onto: null } }); } return null; }
    if (before && before.commit === v.commit && before.onto === v.onto) return get(id);
    db.prepare("INSERT INTO task_base(task_id, commit_, onto, by_, at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET commit_=excluded.commit_, onto=excluded.onto, by_=excluded.by_, at=excluded.at")
      .run(Number(id), v.commit, v.onto, String(by), now());
    store.appendEvent(db, { taskId: Number(id), kind: "base.set", actor: by, detail: { commit: v.commit.slice(0, 12), onto: v.onto } });
    return get(id);
  }

  // 缓存:按(工作仓, commit, onto)→ {state, behind};每次扫描整体换新。scannedAt = 最近一次扫完的时刻。
  let cache = new Map(), scannedAt = null, running = null, runs = 0;
  const key = (repo, commit, onto) => [repo, commit, onto || ""].join("\u0000");

  /** 任务对象的 base:{commit, onto, state, behind, checked_at}|null(只读缓存)。 */
  function fieldOf(t) {
    const b = t ? get(t.id) : null;
    if (!b) return null;
    const repo = repoForLine(t.line);
    const c = repo ? cache.get(key(repo, b.commit, b.onto)) : null;
    return { commit: b.commit, onto: b.onto, state: c?.state ?? "unknown", behind: c?.behind ?? null, checked_at: c ? scannedAt : null };
  }
  const gone = (t) => { const f = fieldOf(t); return f && (f.state === "missing" || f.state === "diverged") ? f : null; };
  /** 领卡闸(登记口):missing / diverged → BASE_GONE。 */
  function claimCheck(t) {
    if (!t || t.status !== "not_started" || t.archived_at) return null;
    const f = gone(t);
    if (!f) return null;
    const what = f.state === "missing" ? `底提交 ${f.commit.slice(0, 12)} 在工作仓里没有了` : `底提交 ${f.commit.slice(0, 12)} 已不在 ${f.onto} 上(分叉了)`;
    return { code: "BASE_GONE", attention: "fault", detail: { state: f.state, commit: f.commit, onto: f.onto }, message: what,
             why: `#${t.id} 的${what} —— 先确认底,改 base 或撤销后再领`, next_action: "确认底提交:改 base 或撤销" };
  }
  function heartbeatExtra(t) {
    const f = t && t.status === "in_progress" ? gone(t) : null;
    return f ? { base_gone: { state: f.state }, next: "底变了,停手问人(ask_operator)" } : {};
  }
  /** 交付指纹的 base_commit 与卡上的 base.commit 不同(卡上的可以是短号:按前缀比)。 */
  function differs(t, fp) {
    const b = t ? get(t.id) : null;
    const fb = typeof fp?.base_commit === "string" ? fp.base_commit.toLowerCase() : null;
    return !!(b && fb && !fb.startsWith(b.commit));
  }

  /** 定时扫(不在请求路径上;同一时刻只跑一份)。只看没归档、没完成的卡。 */
  let again = false;
  function scan() {
    if (running) { again = true; return running; }       // 扫的途中又有写入:这一遍扫完再补一遍
    running = (async () => { do { again = false; await scanOnce(); } while (again); })().finally(() => { running = null; });
    return running;
  }
  async function scanOnce() {
    {
      const g = git(), next = new Map();
      if (g) {
        const rows = db.prepare("SELECT b.task_id, b.commit_, b.onto, t.line FROM task_base b JOIN tasks t ON t.id=b.task_id WHERE t.archived_at IS NULL AND t.status<>'done'").all();
        for (const r of rows) {
          const repo = repoForLine(r.line);
          if (!repo) continue;
          const k = key(repo, r.commit_, r.onto);
          if (next.has(k)) continue;
          runs++;
          const a = await query(g, repo, ["rev-parse", "--verify", "--quiet", `${r.commit_}^{commit}`]);
          const full = a.ok ? a.out.trim().toLowerCase() : "";
          if (!a.ok || !FULL_RE.test(full)) { next.set(k, { state: a.broken || a.ok ? "unknown" : "missing", behind: null }); continue; }
          if (!r.onto) { next.set(k, { state: "ok", behind: null }); continue; }
          runs++;
          const o = await query(g, repo, ["rev-parse", "--verify", "--quiet", `${r.onto}^{commit}`]);
          const ontoSha = o.ok ? o.out.trim().toLowerCase() : "";
          if (!FULL_RE.test(ontoSha)) { next.set(k, { state: "unknown", behind: null }); continue; }
          runs++;
          const m = await query(g, repo, ["merge-base", "--is-ancestor", full, ontoSha]);
          if (!m.ok) { next.set(k, { state: m.code === 1 && !m.broken ? "diverged" : "unknown", behind: null }); continue; }
          runs++;
          const c = await query(g, repo, ["rev-list", "--count", `${full}..${ontoSha}`]);
          const n = c.ok ? Number(c.out.trim()) : NaN;
          next.set(k, { state: "ok", behind: Number.isSafeInteger(n) ? Math.min(n, BEHIND_MAX) : null });
        }
      }
      cache = next; scannedAt = now();
    }
  }

  return { migrate, normBase: (v) => normBase(v, ctx), set, get, fieldOf, claimCheck, heartbeatExtra, differs, scan, gitRuns: () => runs };
}
