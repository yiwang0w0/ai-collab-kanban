// 公告板 v3 合同 H1–H4「可信」:指纹、结论绑指纹、检查项与徽标、基线红,以及「自动通过」的硬闸。
// 概念不变:看板 = 公告板。这里只登记事实并从事实推出徽标;看板不替谁跑命令。
//   - 指纹(H1):交付可带 base_commit / head_commit / files;digest 是比较用的唯一键。线配置了板可读的工作仓时,
//     板只做只读 git 查询(cat-file / rev-parse)核对:核过 true,核不了 null(= 自报),对不上 false。
//   - 结论(H2):审阅结论、验证记录(检查项)、人工验收都记下当时的 digest;再交付 digest 变了 → 旧的 stale。
//   - 检查项与徽标(H3):executor 报来的永远 by:"executor",只进「自报」;board / reviewer 只由受管宿主的独立凭据
//     与审阅座席写入(server.mjs 按身份决定,不看请求体里自称什么)。徽标每次读时从事实推出,不存任何人写的值。
//   - 基线红(H4):checks[].baseline=true 且 fail 的单列 baseline_failed,不算进 failed。
// 表只由看板服务创建(server.mjs 打开库后 migrate)。说明见 docs/可信度徽标.md 与 docs/接入说明.md「可信(合同 H1–H4)」。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

export const FILES_MAX = 50, CHECKS_MAX = 50, REQUIRED_MAX = 20, NAME_MAX = 80, PATH_MAX = 260;
export const STATUSES = ["pass", "fail", "unverified"];
export const HOWS = ["ran", "inferred"];
export const LEVELS = ["machine_verified", "cross_model_reviewed", "independent_rerun", "self_reported"];
export const VERIFIED_BY = new Set(["board", "reviewer"]);
const GIT_TIMEOUT_MS = 5000, GIT_TOTAL_MS = 20000, BLOB_MAX = 32 * 1024 * 1024;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const sha256 = (x) => createHash("sha256").update(x).digest("hex");
const bad = (err, ERR, msg) => err(ERR.BAD_INPUT, msg);

/** 运行时 / 执行者种类 → 家族。未知 = null(未知不算「另一家」)。 */
export function familyOf(runtime) {
  const s = String(runtime ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/^claude\b|^claude[-_]|^anthropic/.test(s) || s === "claude") return "claude";
  if (/^codex\b|^codex[-_]|^openai|^gpt/.test(s) || s === "codex") return "codex";
  if (/^zcode\b|^zcode[-_]/.test(s) || s === "zcode") return "zcode";
  return null;
}

/** 一行名字:去控制符与不可见字符,压空白;空 / 超长返回 null。 */
function cleanName(s) {
  if (typeof s !== "string") return null;
  let t = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) { t += " "; continue; }
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff || c === 0x061c) continue;
    t += ch;
  }
  t = t.replace(/\s+/g, " ").trim();
  return t && [...t].length <= NAME_MAX ? t : null;
}

/** 提交号:只收完整的 40 / 64 位十六进制(大小写不论,存小写)。别的一律拒收 —— 拼进 git 参数前的唯一入口。 */
export function normCommit(v, field, { err, ERR }) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !COMMIT_RE.test(v.toLowerCase())) throw bad(err, ERR, `${field} 只接受完整的 40 或 64 位十六进制提交号`);
  return v.toLowerCase();
}

/** 交付文件路径:一律相对工作仓;反斜杠当分隔符;去掉「.」段;绝对路径、盘符、`..`、`.git`、冒号、控制字符拒收。 */
export function normPath(v, { err, ERR }) {
  if (typeof v !== "string" || !v || v.length > PATH_MAX) throw bad(err, ERR, `files[].path 要 1–${PATH_MAX} 字的相对路径`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw bad(err, ERR, "files[].path 不能含控制字符");
  const s = v.replace(/\\/g, "/");
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.includes(":")) throw bad(err, ERR, `files[].path 必须相对工作仓(不收绝对路径、盘符与冒号):${JSON.stringify(v).slice(0, 80)}`);
  const parts = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw bad(err, ERR, `files[].path 不能含 ..:${JSON.stringify(v).slice(0, 80)}`);
    if (seg.toLowerCase() === ".git") throw bad(err, ERR, "files[].path 不能指向 .git");
    parts.push(seg);
  }
  if (!parts.length) throw bad(err, ERR, "files[].path 规范化后为空");
  return parts.join("/");
}

/** required_checks:名字数组,≤20 项,每项一行 ≤80 字,去重保序。null / undefined = 不设。 */
export function normRequired(v, { err, ERR }) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > REQUIRED_MAX) throw bad(err, ERR, `required_checks 要名字数组,最多 ${REQUIRED_MAX} 项`);
  const out = [];
  for (const x of v) {
    const n = cleanName(x);
    if (!n) throw bad(err, ERR, `required_checks 的每一项要 1–${NAME_MAX} 字的单行名字`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** 指纹的规范形与 digest。files 按路径排序(顺序无关);tree 与 verified 是板核出来的,不进 digest。
 *  evidence_sha256 = 交付正文的哈希:没带提交号与文件的旧桥交付也有一个会随内容变的 digest。 */
export function canonicalFingerprint({ base_commit = null, head_commit = null, files = [], evidence_sha256 = null }) {
  const f = [...files].map((x) => ({ path: x.path, sha256: x.sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const body = { v: 1, base_commit: base_commit || null, head_commit: head_commit || null, files: f, evidence_sha256: evidence_sha256 || null };
  return { ...body, digest: sha256(JSON.stringify(body)) };
}

/** 交付请求里的 H1 / H3 参数(全部可选)。先校验,不合规就不收这次交付(由调用方在 store.report 之前调)。 */
export function parseDelivery(b, { err, ERR }) {
  const ctx = { err, ERR };
  const base_commit = normCommit(b.base_commit, "base_commit", ctx);
  const head_commit = normCommit(b.head_commit, "head_commit", ctx);
  let files = [];
  if (b.files !== undefined && b.files !== null) {
    if (!Array.isArray(b.files) || b.files.length > FILES_MAX) throw bad(err, ERR, `files 要数组,最多 ${FILES_MAX} 项`);
    const seen = new Set();
    for (const x of b.files) {
      if (!x || typeof x !== "object" || Array.isArray(x)) throw bad(err, ERR, "files 的每一项要 {path, sha256}");
      const path = normPath(x.path, ctx);
      const h = typeof x.sha256 === "string" ? x.sha256.toLowerCase() : "";
      if (!SHA256_RE.test(h)) throw bad(err, ERR, `files[].sha256 要 64 位十六进制:${path}`);
      if (seen.has(path)) throw bad(err, ERR, `files 里路径重复:${path}`);
      seen.add(path); files.push({ path, sha256: h });
    }
  }
  let checks = [];
  if (b.checks !== undefined && b.checks !== null) {
    if (!Array.isArray(b.checks) || b.checks.length > CHECKS_MAX) throw bad(err, ERR, `checks 要数组,最多 ${CHECKS_MAX} 项`);
    for (const c of b.checks) {
      if (!c || typeof c !== "object" || Array.isArray(c)) throw bad(err, ERR, "checks 的每一项要 {name, status, how, baseline?}");
      const name = cleanName(c.name);
      if (!name) throw bad(err, ERR, `checks[].name 要 1–${NAME_MAX} 字的单行名字`);
      if (!STATUSES.includes(c.status)) throw bad(err, ERR, `checks[].status 只接受 ${STATUSES.join(" / ")}`);
      const how = c.how === undefined || c.how === null ? "inferred" : c.how;
      if (!HOWS.includes(how)) throw bad(err, ERR, `checks[].how 只接受 ${HOWS.join(" / ")}`);
      if (c.baseline !== undefined && c.baseline !== null && typeof c.baseline !== "boolean") throw bad(err, ERR, "checks[].baseline 只接受 true / false");
      // by / digest / command_hash / env 一概不收:执行者报的永远是自报(by:"executor")。
      checks.push({ name, status: c.status, how, baseline: c.baseline === true });
    }
  }
  return { base_commit, head_commit, files, checks, provided: !!(base_commit || head_commit || files.length) };
}

// ── 只读 git ─────────────────────────────────────────────────────────────────────
/** 继承的 GIT_* 一律清掉(GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_* 能把查询改道);不弹提示、不拿可选锁。 */
export function gitQueryEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^GIT_/i.test(k) && v !== undefined) out[k] = v;
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_OPTIONAL_LOCKS = "0";
  out.NoDefaultCurrentDirectoryInExePath = "1";
  return out;
}

function gitOnce(git, repo, args, deadline) {
  const left = Math.min(GIT_TIMEOUT_MS, deadline - Date.now());
  if (left <= 0) return Promise.resolve({ ok: false, broken: true });
  // --no-replace-objects:replace 引用不能换掉被核的对象;core.fsmonitor=false:即使配置了也不起监视进程。
  //   cat-file / rev-parse 不读索引、不触发钩子;不检出、不执行仓内任何东西。
  const argv = ["--no-replace-objects", "-c", "core.fsmonitor=false", "-C", repo, ...args];
  return new Promise((resolve) => {
    execFile(git, argv, { env: gitQueryEnv(), timeout: left, maxBuffer: BLOB_MAX, encoding: "buffer", windowsHide: true, shell: false },
      (e, stdout) => {
        if (!e) return resolve({ ok: true, out: stdout });
        // 超时 / 起不来 / 输出过大 = 核不了;正常退出码非 0 = 这一项对不上(仓本身先核过能读)。
        const broken = e.killed || typeof e.code !== "number" || e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        resolve({ ok: false, broken });
      });
  });
}

/** 板侧核指纹。返回 { verified:true|false|null, tree, mismatch:[...] }。 */
export async function verifyFingerprint({ git, repo, fp }) {
  const none = { verified: null, tree: null, mismatch: [] };
  if (!fp.provided || !git || !repo) return none;
  const deadline = Date.now() + GIT_TOTAL_MS;
  const sane = await gitOnce(git, repo, ["rev-parse", "--git-dir"], deadline);
  if (!sane.ok) return none;                       // 不是仓 / 读不了 = 核不了
  const mismatch = [];
  let unknown = false;
  for (const [field, sha] of [["base_commit", fp.base_commit], ["head_commit", fp.head_commit]]) {
    if (!sha) continue;
    const r = await gitOnce(git, repo, ["cat-file", "-t", sha], deadline);
    if (!r.ok) { if (r.broken) unknown = true; else mismatch.push(`${field} 在工作仓里不存在`); continue; }
    if (String(r.out).trim() !== "commit") mismatch.push(`${field} 不是提交`);
  }
  let tree = null;
  if (fp.head_commit && !mismatch.length) {
    const r = await gitOnce(git, repo, ["rev-parse", "--verify", "--quiet", `${fp.head_commit}^{tree}`], deadline);
    if (r.ok) tree = String(r.out).trim() || null; else if (r.broken) unknown = true;
    for (const f of fp.files) {
      const b = await gitOnce(git, repo, ["cat-file", "blob", `${fp.head_commit}:${f.path}`], deadline);
      if (!b.ok) { if (b.broken) unknown = true; else mismatch.push(`${f.path} 不在 head_commit 里`); continue; }
      if (sha256(b.out) !== f.sha256) mismatch.push(`${f.path} 的 sha256 与 head_commit 里的内容不同`);
    }
  } else if (fp.files.length && !fp.head_commit) unknown = true;   // 没给 head_commit:文件无处可核
  if (mismatch.length) return { verified: false, tree, mismatch };
  if (unknown) return { verified: null, tree, mismatch: [] };
  return { verified: true, tree, mismatch: [] };
}

// ── 存储与推导 ────────────────────────────────────────────────────────────────────
/**
 * @param db           node:sqlite 句柄
 * @param err / ERR    store.err / store.ERR(错误交给 server 的统一映射)
 * @param git          () => git 程序绝对路径 | null
 * @param repoForLine  (line) => 板可读的工作仓绝对路径 | null
 * @param commandHash  (verifyKey) => 登记簿里该键命令的 sha256 | null(板自己读登记簿,不采信调用方)
 */
export function openCredibility({ db, err, ERR, git = () => null, repoForLine = () => null, commandHash = () => null, now = () => new Date().toISOString() }) {
  const ctx = { err, ERR };
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS cred_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, run_id TEXT, at TEXT NOT NULL, digest TEXT NOT NULL,
      base_commit TEXT, head_commit TEXT, tree TEXT, files_json TEXT NOT NULL, evidence_sha256 TEXT, verified INTEGER,
      mismatch_json TEXT, author_runtime TEXT, author_family TEXT)`);
    db.exec("CREATE INDEX IF NOT EXISTS cred_deliveries_task ON cred_deliveries(task_id, id)");
    db.exec(`CREATE TABLE IF NOT EXISTS cred_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, by_ TEXT NOT NULL,
      how TEXT NOT NULL, digest TEXT, command_hash TEXT, env TEXT, baseline INTEGER NOT NULL DEFAULT 0, base_commit TEXT, at TEXT NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS cred_checks_task ON cred_checks(task_id, id)");
    db.exec(`CREATE TABLE IF NOT EXISTS cred_conclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, kind TEXT NOT NULL, verdict TEXT NOT NULL, by_ TEXT NOT NULL,
      runtime TEXT, family TEXT, digest TEXT, at TEXT NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS cred_conclusions_task ON cred_conclusions(task_id, id)");
    db.exec(`CREATE TABLE IF NOT EXISTS cred_required (
      task_id INTEGER PRIMARY KEY, names_json TEXT NOT NULL, by_ TEXT, at TEXT NOT NULL)`);
  }

  const deliveries = (id) => db.prepare("SELECT * FROM cred_deliveries WHERE task_id=? ORDER BY id").all(Number(id));
  const current = (id) => db.prepare("SELECT * FROM cred_deliveries WHERE task_id=? ORDER BY id DESC LIMIT 1").get(Number(id)) || null;
  const currentDigest = (id) => current(id)?.digest ?? null;
  const filesOf = (row) => { try { return JSON.parse(row?.files_json || "[]"); } catch { return []; } };

  function requiredOf(id) {
    const r = db.prepare("SELECT names_json FROM cred_required WHERE task_id=?").get(Number(id));
    try { return r ? JSON.parse(r.names_json) : []; } catch { return []; }
  }
  /** 写 required_checks。谁能写由 server 按身份决定(建卡 / 建计划 / 操作员接口);这里只存。空数组 = 清掉。 */
  function setRequired(id, names, by) {
    if (!names || !names.length) { db.prepare("DELETE FROM cred_required WHERE task_id=?").run(Number(id)); return []; }
    db.prepare("INSERT INTO cred_required(task_id, names_json, by_, at) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET names_json=excluded.names_json, by_=excluded.by_, at=excluded.at")
      .run(Number(id), JSON.stringify(names), by == null ? null : String(by), now());
    return names;
  }

  /** 一次交付(outcome=done):记指纹(板核)与执行者自报的 checks;受管宿主的验证(hostCheck)记成 by:"board"。 */
  async function recordDelivery(task, parsed, { runId = null, evidence = "", authorRuntime = null, hostCheck = null } = {}) {
    const fp0 = canonicalFingerprint({ base_commit: parsed.base_commit, head_commit: parsed.head_commit, files: parsed.files,
                                       evidence_sha256: sha256(String(evidence ?? "")) });
    const repo = parsed.provided ? repoForLine(task.line) : null;
    const v = await verifyFingerprint({ git: git(), repo, fp: { ...parsed } });
    const at = now();
    db.prepare(`INSERT INTO cred_deliveries(task_id, run_id, at, digest, base_commit, head_commit, tree, files_json, evidence_sha256, verified, mismatch_json, author_runtime, author_family)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(Number(task.id), runId == null ? null : String(runId), at, fp0.digest, fp0.base_commit, fp0.head_commit, v.tree,
           JSON.stringify(fp0.files), fp0.evidence_sha256, v.verified == null ? null : v.verified ? 1 : 0,
           v.mismatch.length ? JSON.stringify(v.mismatch) : null, authorRuntime == null ? null : String(authorRuntime), familyOf(authorRuntime));
    const ins = db.prepare("INSERT INTO cred_checks(task_id, name, status, by_, how, digest, command_hash, env, baseline, base_commit, at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    for (const c of parsed.checks)
      ins.run(Number(task.id), c.name, c.status, "executor", c.how, fp0.digest, null, null, c.baseline ? 1 : 0, fp0.base_commit, at);
    if (hostCheck) addVerifiedCheck(task.id, { ...hostCheck, by: "board" });
    return { digest: fp0.digest, verified: v.verified };
  }

  /** board / reviewer 的检查(绑当前 digest、命令哈希与环境标签)。只由 server 在受信身份的路径上调用。 */
  function addVerifiedCheck(id, { name, ok, by, env = null, key = null, baseline = false }) {
    if (!VERIFIED_BY.has(by)) throw new Error("addVerifiedCheck 只收 board / reviewer");
    const n = cleanName(name);
    if (!n) return null;
    const cur = current(id);
    db.prepare("INSERT INTO cred_checks(task_id, name, status, by_, how, digest, command_hash, env, baseline, base_commit, at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(Number(id), n, ok ? "pass" : "fail", by, "ran", cur?.digest ?? null, commandHash(key ?? n), env == null ? null : String(env).slice(0, 80),
           baseline ? 1 : 0, cur?.base_commit ?? null, now());
    return n;
  }

  /** 结论:kind = review(审阅座席)| acceptance(人工验收);verdict = approve | reject。 */
  function addConclusion(id, { kind, verdict, by, runtime = null }) {
    db.prepare("INSERT INTO cred_conclusions(task_id, kind, verdict, by_, runtime, family, digest, at) VALUES(?,?,?,?,?,?,?,?)")
      .run(Number(id), kind, verdict, by, runtime == null ? null : String(runtime), familyOf(runtime), currentDigest(id), now());
  }

  function changedBetween(oldRow, newRow) {
    if (!oldRow || !newRow) return null;
    const a = new Map(filesOf(oldRow).map((f) => [f.path, f.sha256])), b = new Map(filesOf(newRow).map((f) => [f.path, f.sha256]));
    const out = [];
    for (const [p, h] of b) if (a.get(p) !== h) out.push(p);
    for (const p of a.keys()) if (!b.has(p)) out.push(p);
    return out.sort();
  }

  /** 卡的可信字段(任务对象 / 卡详情 / history 共用)。staleSpec = 合同 H6 的 based_on_stale_spec(缺失 = false)。 */
  function fields(task, { staleSpec = false } = {}) {
    const id = Number(task?.id);
    const required_checks = requiredOf(id);
    const all = deliveries(id);
    const cur = all.length ? all[all.length - 1] : null;
    const D = cur?.digest ?? null;
    const byDigest = new Map(); for (const d of all) byDigest.set(d.digest, d);   // 同一 digest 取最近一次
    const checkRows = db.prepare("SELECT * FROM cred_checks WHERE task_id=? ORDER BY id").all(id);
    const conclRows = db.prepare("SELECT * FROM cred_conclusions WHERE task_id=? ORDER BY id").all(id);
    const checks = checkRows.slice(-100).map((c) => ({ name: c.name, status: c.status, by: c.by_, how: c.how, digest: c.digest,
      command_hash: c.command_hash, env: c.env, baseline: !!c.baseline, at: c.at, stale: c.digest !== D }));
    const conclusions = conclRows.slice(-50).map((c) => {
      const stale = c.digest !== D;
      return { kind: c.kind, verdict: c.verdict, by: c.by_, runtime_family: c.family, digest: c.digest, at: c.at, stale,
               changed_files: stale ? changedBetween(byDigest.get(c.digest), cur) : null };
    });
    // 当前 digest 上、每组每个名字取最近一条。
    const latest = (group) => { const m = new Map();
      for (const c of checkRows) if (c.digest === D && D != null && (group === "verified" ? VERIFIED_BY.has(c.by_) : c.by_ === "executor")) m.set(c.name, c);
      return m; };
    const ver = latest("verified"), self = latest("self");
    const count = (m) => { const o = { passed: 0, failed: 0, unverified: 0, baseline_failed: 0 };
      for (const c of m.values()) {
        if (c.status === "pass") o.passed++;
        else if (c.status === "fail") { if (c.baseline) o.baseline_failed++; else o.failed++; }
        else o.unverified++;
      }
      return o; };
    const evidence_counts = { verified: count(ver), self: count(self) };
    const fingerprint = cur ? { base_commit: cur.base_commit, head_commit: cur.head_commit, tree: cur.tree, files: filesOf(cur), digest: cur.digest,
      verified: cur.verified == null ? null : cur.verified === 1, evidence_sha256: cur.evidence_sha256,
      mismatch: cur.mismatch_json ? JSON.parse(cur.mismatch_json) : [], changed_files: all.length > 1 ? changedBetween(all[all.length - 2], cur) : null,
      delivered_at: cur.at } : null;
    // H4 基线红:当前 digest 上 baseline=true 且 fail 的检查(自报与已核各自)。first_seen_commit = 本卡最早报出它基线红时的底提交。
    let baseline = null;
    if (cur) {
      const red = [];
      for (const [group, m] of [["verified", ver], ["self", self]])
        for (const c of m.values()) if (c.status === "fail" && c.baseline) {
          const first = checkRows.find((x) => x.name === c.name && x.baseline && x.status === "fail" && (group === "verified" ? VERIFIED_BY.has(x.by_) : x.by_ === "executor"));
          red.push({ check: c.name, by: c.by_, first_seen_commit: first?.base_commit ?? null });
        }
      baseline = { base_commit: cur.base_commit, red, self: red.filter((r) => r.by === "executor").length, verified: red.filter((r) => r.by !== "executor").length };
    }
    const badge = cur ? badgeOf({ cur, ver, conclRows, required_checks, baseline, staleSpec, checkRows, D }) : null;
    return { fingerprint, checks, evidence_counts, badge, baseline, required_checks, conclusions };
  }

  function badgeOf({ cur, ver, conclRows, required_checks, baseline, staleSpec, checkRows, D }) {
    const mismatch = cur.verified === 0;
    const ranPass = [...ver.values()].filter((c) => c.how === "ran" && c.status === "pass");
    const ranAll = [...ver.values()].filter((c) => c.how === "ran");
    const reqMet = required_checks.length > 0 && required_checks.every((n) => { const c = ver.get(n); return c && c.how === "ran" && c.status === "pass"; });
    // 没有 required_checks 时:至少一项已核实跑,且已核实跑的没有一项(非基线)失败。
    const noReq = required_checks.length === 0 && ranAll.length > 0 && ranAll.every((c) => c.status === "pass" || (c.status === "fail" && c.baseline));
    const cross = conclRows.filter((c) => c.kind === "review" && c.verdict === "approve" && c.digest === D && c.family && cur.author_family && c.family !== cur.author_family);
    let level = "self_reported";
    const provenance = [{ what: "fingerprint", by: cur.verified === 1 ? "board" : "executor", at: cur.at, digest: cur.digest }];
    if (!mismatch && (reqMet || noReq)) {
      level = "machine_verified";
      for (const c of (reqMet ? required_checks.map((n) => ver.get(n)) : ranAll)) provenance.push({ what: `check:${c.name}`, by: c.by_, at: c.at, digest: c.digest });
    } else if (!mismatch && cross.length) {
      level = "cross_model_reviewed";
      const c = cross[cross.length - 1]; provenance.push({ what: `review:${c.family}`, by: c.by_, at: c.at, digest: c.digest });
    } else if (!mismatch && ranPass.length) {
      level = "independent_rerun";
      for (const c of ranPass) provenance.push({ what: `check:${c.name}`, by: c.by_, at: c.at, digest: c.digest });
    }
    const flags = [];
    // stale = 有旧指纹上的检查或结论,而当前指纹上还没有同名检查 / 同类结论顶替它(「只重审变了的」还没做完)。
    const freshCheck = new Set(checkRows.filter((c) => c.digest === D).map((c) => c.name));
    const freshKind = new Set(conclRows.filter((c) => c.digest === D).map((c) => c.kind));
    if (checkRows.some((c) => c.digest != null && c.digest !== D && !freshCheck.has(c.name)) ||
        conclRows.some((c) => c.digest != null && c.digest !== D && !freshKind.has(c.kind))) flags.push("stale");
    if (baseline?.red.length) flags.push("baseline_red");
    if (mismatch) flags.push("fingerprint_mismatch");
    if (staleSpec === true) flags.push("based_on_stale_spec");
    return { level, flags, provenance };
  }

  /** 自动通过的硬闸(合同 H3):不满足返回 missing(给人看的逐条原因),调用方转人工验收。
   *  required_checks 为空 = 规则同现状,只多两条:指纹对不上、基于旧版说明 都不自动通过。 */
  function autoGate(task, { staleSpec = false } = {}) {
    const id = Number(task.id);
    const missing = [];
    const required = requiredOf(id);
    const cur = current(id);
    // 板手里最近一次记下的指纹,得是卡上这一次交付的(同一轮、同一份交付正文)。这次交付的指纹没记上(写库失败等),
    //   current 就还是上一次交付的 —— 拿它当「当前」会让旧指纹上的检查替新交付作保。对不上 → 不自动通过,转人工。
    //   一次指纹都没记过的卡(旧路径交付)不在此列,规则同现状。
    //   交付正文为 null 时卡上存的是 "null"、指纹按空串算(两处各自的既有写法),两种都认。
    const bodyOk = task.result == null || cur?.evidence_sha256 === sha256(String(task.result))
      || (task.result === "null" && cur?.evidence_sha256 === sha256(""));
    if (cur && (cur.run_id !== (task.run_id ?? null) || !bodyOk))
      missing.push("这次交付的指纹没记上,看板手里只有上一次交付的指纹");
    if (required.length && !missing.length) {
      const D = cur?.digest ?? null;
      const rows = D == null ? [] : db.prepare("SELECT * FROM cred_checks WHERE task_id=? AND digest=? ORDER BY id").all(id, D);
      const last = new Map(); for (const c of rows) if (VERIFIED_BY.has(c.by_)) last.set(c.name, c);
      for (const n of required) {
        const c = last.get(n);
        if (!c) missing.push(`必需检查「${n}」没有看板或审阅座席在当前指纹上的结果`);
        else if (c.status !== "pass") missing.push(`必需检查「${n}」在当前指纹上未通过(${c.status})`);
      }
    }
    if (cur && cur.verified === 0) missing.push("指纹与工作仓对不上(fingerprint_mismatch)");
    if (staleSpec === true) missing.push("交付基于旧版说明(based_on_stale_spec)");
    return { ok: missing.length === 0, missing };
  }

  return { migrate, parseDelivery: (b) => parseDelivery(b, ctx), normRequired: (v) => normRequired(v, ctx), requiredOf, setRequired,
           recordDelivery, addVerifiedCheck, addConclusion, fields, autoGate, currentDigest };
}
