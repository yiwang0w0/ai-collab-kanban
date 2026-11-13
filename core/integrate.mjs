// 公告板 v3 合同 I7「整合」阶段(只读):目标卡上可写 integrate:{target:"refs/heads/…", assemble?:bool}(操作者写)。
// 看板对每张已完成子卡最近一次交付的 head_commit,只读核它是不是 target 的祖先:merged / pending / unknown
// (没有提交、没有板可读的工作仓、git 超时或报错)。结果按(工作仓, target 当前 sha, head)缓存,由定时扫(默认 30 秒)
// 刷新;请求路径上只读缓存,从不跑 git。板不合并、不推送、不检出,不执行仓内任何东西(调用约束同 credibility.mjs)。
// 没写 integrate 的目标:不出这一段,行为同现状。表只由看板服务创建(server.mjs 打开库后 migrate)。
import { execFile } from "node:child_process";
import { gitQueryEnv } from "./credibility.mjs";

export const REF_MAX = 200;
const GIT_TIMEOUT_MS = 5000;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** target:只收 `refs/heads/…` 形的完整引用名(拼进 git 参数前的唯一入口)。乱值 → BAD_INPUT。 */
export function normTarget(v, { err, ERR }) {
  const bad = () => err(ERR.BAD_INPUT, "integrate.target 只接受 refs/heads/ 开头的完整分支引用名(字母、数字、. _ - /,不含 .. 与 //)");
  if (typeof v !== "string" || v.length > REF_MAX || !v.startsWith("refs/heads/")) throw bad();
  const rest = v.slice("refs/heads/".length);
  if (!rest || !/^[A-Za-z0-9._/-]+$/.test(rest) || rest.includes("..") || rest.includes("//") || rest.endsWith("/") || rest.endsWith(".")
      || rest.split("/").some((s) => !s || s.startsWith(".") || s.startsWith("-") || s.endsWith(".lock")) || v.includes("@{")) throw bad();
  return v;
}
/** integrate 参数:{target, assemble?}。null = 撤销;undefined = 不设。 */
export function normIntegrate(v, ctx) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw ctx.err(ctx.ERR.BAD_INPUT, "integrate 要 {target, assemble?}");
  for (const k of Object.keys(v)) if (!["target", "assemble"].includes(k)) throw ctx.err(ctx.ERR.BAD_INPUT, `integrate 不认识的字段 ${k}`);
  if (v.assemble !== undefined && typeof v.assemble !== "boolean") throw ctx.err(ctx.ERR.BAD_INPUT, "integrate.assemble 只接受 true / false");
  return { target: normTarget(v.target, ctx), assemble: v.assemble === true };
}

/** 一次只读 git 查询。返回 { ok, code, out, broken }(broken = 超时 / 起不来 = 核不了)。 */
export function gitQuery(git, repo, args) {
  const argv = ["--no-replace-objects", "-c", "core.fsmonitor=false", "-C", repo, ...args];
  return new Promise((resolve) => {
    execFile(git, argv, { env: gitQueryEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true, shell: false }, (e, stdout) => {
      if (!e) return resolve({ ok: true, code: 0, out: String(stdout) });
      const broken = e.killed || typeof e.code !== "number";
      resolve({ ok: false, code: typeof e.code === "number" ? e.code : null, out: "", broken });
    });
  });
}

/**
 * @param db          node:sqlite 句柄
 * @param git         () => git 程序路径 | null
 * @param repoForLine (line) => 板可读的工作仓 | null(与 credibility 同一个)
 * @param headOf      (taskId) => 最近一次交付的 head_commit | null
 * @param isAuto      (taskId) => 是不是看板自动出的候选组装卡(不算子卡)
 * @param query       注入点(测试计数用):(git, repo, args) => Promise<{ok, code, out, broken}>
 */
export function openIntegrate({ db, err, ERR, git = () => null, repoForLine = () => null, headOf = () => null, isAuto = () => false,
                                query = gitQuery, now = () => new Date().toISOString() }) {
  const ctx = { err, ERR };
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS integrate_cfg (task_id INTEGER PRIMARY KEY, target TEXT NOT NULL, assemble INTEGER NOT NULL DEFAULT 0, by_ TEXT, at TEXT NOT NULL)`);
  }
  function set(id, cfg, by) {
    if (!cfg) db.prepare("DELETE FROM integrate_cfg WHERE task_id=?").run(Number(id));
    else db.prepare("INSERT INTO integrate_cfg(task_id, target, assemble, by_, at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET target=excluded.target, assemble=excluded.assemble, by_=excluded.by_, at=excluded.at")
      .run(Number(id), cfg.target, cfg.assemble ? 1 : 0, by == null ? null : String(by), now());
    return cfg || null;
  }
  const get = (id) => { const r = db.prepare("SELECT target, assemble FROM integrate_cfg WHERE task_id=?").get(Number(id)); return r ? { target: r.target, assemble: !!r.assemble } : null; };
  const goals = () => db.prepare("SELECT c.task_id AS id, c.target, c.assemble FROM integrate_cfg c JOIN tasks t ON t.id=c.task_id WHERE t.archived_at IS NULL").all();
  const kidsOf = (goalId) => db.prepare("SELECT * FROM tasks WHERE parent_id=? AND archived_at IS NULL ORDER BY id").all(Number(goalId)).filter((k) => !isAuto(k.id));

  // 缓存:目标 sha 按(仓, target);判定按(仓, target sha, head)。每次扫描整体换新(旧键自然丢掉,不无限长)。
  let targets = new Map(), states = new Map(), scannedAt = null, running = null, runs = 0;
  const tkey = (repo, target) => repo + "\u0000" + target, skey = (repo, sha, head) => repo + "\u0000" + sha + "\u0000" + head;

  /** 一张已完成子卡的整合状态(只读缓存)。 */
  function stateOf(kid, target) {
    const head = headOf(kid.id), repo = repoForLine(kid.line);
    if (!head || !repo) return { state: "unknown", target, head: head || null };
    const t = targets.get(tkey(repo, target));
    if (!t?.sha) return { state: "unknown", target, head };
    return { state: states.get(skey(repo, t.sha, head)) ?? "unknown", target, head, target_sha: t.sha };
  }
  /** 目标的整合汇总(只读缓存):{ merged, pending, unknown, target, target_sha, all_done, kids:[{id, state, head}] }。没写 integrate = null。 */
  function summary(goalId) {
    const cfg = get(goalId);
    if (!cfg) return null;
    const kids = kidsOf(goalId);
    const out = { merged: 0, pending: 0, unknown: 0, target: cfg.target, target_sha: null, assemble: cfg.assemble,
                  all_done: kids.length > 0 && kids.every((k) => k.status === "done"), kids: [], checked_at: scannedAt };
    for (const k of kids) {
      if (k.status !== "done") continue;
      const s = stateOf(k, cfg.target);
      out[s.state]++;
      if (s.target_sha && !out.target_sha) out.target_sha = s.target_sha;
      out.kids.push({ id: Number(k.id), state: s.state, head: s.head });
    }
    return out;
  }
  /** 子卡任务对象的 integration:{state, target}。父卡没写 integrate、或子卡没完成 = null。 */
  function childField(t) {
    if (!t || t.parent_id == null || t.status !== "done" || isAuto(t.id)) return null;
    const cfg = get(t.parent_id);
    if (!cfg) return null;
    const s = stateOf(t, cfg.target);
    return { state: s.state, target: cfg.target };
  }

  /** 定时扫(不在请求路径上):核每个写了 integrate 的目标下已完成子卡的 head 是否为 target 的祖先。同一时刻只跑一份。 */
  function scan() {
    if (running) return running;
    running = (async () => {
      const g = git();
      const nt = new Map(), ns = new Map();
      if (g) {
        for (const goal of goals()) {
          for (const k of kidsOf(goal.id)) {
            if (k.status !== "done") continue;
            const head = headOf(k.id), repo = repoForLine(k.line);
            if (!head || !repo || !SHA_RE.test(head)) continue;
            const tk = tkey(repo, goal.target);
            if (!nt.has(tk)) {
              runs++;
              const r = await query(g, repo, ["rev-parse", "--verify", "--quiet", `${goal.target}^{commit}`]);
              const sha = r.ok ? r.out.trim().toLowerCase() : "";
              nt.set(tk, { sha: SHA_RE.test(sha) ? sha : null });
            }
            const sha = nt.get(tk).sha;
            if (!sha) continue;
            const sk = skey(repo, sha, head);
            if (ns.has(sk)) continue;
            runs++;
            const r = await query(g, repo, ["merge-base", "--is-ancestor", head, sha]);
            // 0 = 是祖先(已合);1 = 不是(待合);别的(提交不在仓里、超时)= 核不了。
            ns.set(sk, r.ok ? "merged" : r.code === 1 && !r.broken ? "pending" : "unknown");
          }
        }
      }
      targets = nt; states = ns; scannedAt = now();
    })().finally(() => { running = null; });
    return running;
  }

  /** 一次「从现在起」的扫描:正有一轮在跑时,它开始时看到的子卡可能还没完成(结果里没有它们)—— 等它跑完再从头扫一轮。
   *  候选组装卡拼说明前用它(全套负载下实测:拼进了还没扫到的「未核」,之后说明不再重拼)。 */
  const scanFresh = () => (running ? running.then(() => scan(), () => scan()) : scan());
  return { migrate, normIntegrate: (v) => normIntegrate(v, ctx), set, get, goals, kidsOf, summary, childField, scan, scanFresh, gitRuns: () => runs };
}
