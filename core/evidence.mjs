// 证据文件(合同 H5):执行者经桥上传截图,板按 sha256 存进数据目录的 evidence_files/(受管线禁读表登记了这个目录名)。
//   POST /api/tasks/:id/evidence           正文 = 图片原始字节(Content-Type 随意,不信);X-Run-Id 可带;X-Evidence-Note = encodeURIComponent 后的一行说明
//   GET  /api/tasks/:id/evidence/:sha256   只给操作员(面板会话 / 操作员令牌);别的身份一律 404
// 只收 png / jpeg / webp:按文件头判,不信扩展名与声明的类型(svg / html 自然不收);单个 ≤2MB,边收边数、超了就停,
//   只往临时文件写、不整包缓冲;每张卡 ≤10 个;同一张卡同哈希去重。只有当前持有这张卡的执行者能传;板从不按执行者给的路径读盘。
// 记录:{ sha256, bytes, mime, note, by, at, digest }。digest = 当时的指纹(合同 H1;由可信核心给,没有时为 null)。
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, openSync, writeSync, closeSync, renameSync, unlinkSync, existsSync, statSync, createReadStream } from "node:fs";
import { join } from "node:path";

export const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024, EVIDENCE_MAX_PER_CARD = 10, EVIDENCE_NOTE_MAX = 200;
const SHA_RE = /^[0-9a-f]{64}$/;
const DRAIN_MAX = 8 * 1024 * 1024;      // 拒收后最多再读掉这么多(让对方读得到应答),再多就断开
export const EVIDENCE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

/** 按文件头认类型;认不出 = null。至少要前 12 个字节。 */
export function sniffImage(head) {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head ?? []);
  if (b.length < 12) return null;
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** 路由分派:POST 集合、GET 单个(非纯数字的段;纯数字段是旧的 /evidence/:seq 交付记录接口,不归这里)。 */
const ROUTE = /^\/api\/tasks\/(\d+)\/evidence(?:\/((?!\d+$)[^/]*))?$/;
export const evidencePath = (p) => ROUTE.exec(p);

export function openEvidence({ db, store, dir, cleanText = (s) => String(s), digestOf = () => null, emit = () => {}, clock = () => new Date().toISOString() }) {
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS task_evidence_files (
      task_id INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT NOT NULL,
      note TEXT, by TEXT NOT NULL, at TEXT NOT NULL, digest TEXT, PRIMARY KEY (task_id, sha256))`);
  }
  const memo = new Map(), q = (sql) => { let st = memo.get(sql); if (!st) memo.set(sql, st = db.prepare(sql)); return st; };
  const out = (r) => ({ sha256: r.sha256, bytes: Number(r.bytes), mime: r.mime, note: r.note ?? null, by: r.by, at: r.at, digest: r.digest ?? null });
  const listOf = (id) => q("SELECT * FROM task_evidence_files WHERE task_id=? ORDER BY at, sha256").all(Number(id)).map(out);
  const countOf = (id) => Number(q("SELECT count(*) n FROM task_evidence_files WHERE task_id=?").get(Number(id)).n);
  const referenced = (sha) => !!q("SELECT 1 FROM task_evidence_files WHERE sha256=? LIMIT 1").get(sha);

  function send(res, code, body, extra = {}) {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  }
  /** 拒收:先把剩下的正文读掉(只数不存),读完再应答——对方还在写时就应答并关连接,对方会读到连接被重置而不是拒收原因。
   *  多于 DRAIN_MAX 就不再等:应答带 Connection: close 后断开。 */
  function refuse(req, res, code, body) {
    if (req.complete) return send(res, code, body);
    let drained = 0, done = false;
    const answer = (extra) => { if (done || res.writableEnded || res.destroyed) return; done = true; send(res, code, body, extra); };
    req.removeAllListeners("data");
    req.on("data", (c) => { drained += c.length; if (drained > DRAIN_MAX) { answer({ Connection: "close" }); req.destroy(); } });
    req.once("end", () => answer());
    req.once("close", () => answer());
    req.resume();
  }
  function noteOf(req) {
    const raw = req.headers["x-evidence-note"];
    if (raw === undefined) return { note: null };
    let text;
    try { text = decodeURIComponent(String(raw)); } catch { return { error: "X-Evidence-Note 要 encodeURIComponent 编码" }; }
    if ([...text.trim()].length > EVIDENCE_NOTE_MAX) return { error: `note 最多 ${EVIDENCE_NOTE_MAX} 字` };
    return { note: cleanText(text) || null };   // 单行、去零宽与双向控制符、遮蔽路径与令牌样串
  }

  async function upload(req, res, id, role) {
    if (role !== "executor") return refuse(req, res, 403, { code: "NOT_HOLDER", error: "只有持有这张卡的执行者能传证据" });
    const t = store.get(db, id);
    // 绑线执行者:别的线的卡一律当不存在(与读接口同一口径)。
    if (!t || (req.boundLine && t.line !== req.boundLine)) return refuse(req, res, 404, { error: "不存在" });
    if (t.status !== "in_progress" || t.worker !== req.executor.id)
      return refuse(req, res, 403, { code: "NOT_HOLDER", error: `卡 #${id} 不在你手上(只有持有这张卡的执行者能传证据)` });
    const runId = req.headers["x-run-id"];
    if (runId !== undefined && String(runId) !== String(t.run_id)) return refuse(req, res, 409, { code: "RUN_CHANGED", error: "run_id 与卡上这一轮不一致" });
    const n = noteOf(req);
    if (n.error) return refuse(req, res, 400, { code: "BAD_INPUT", error: n.error });
    if (countOf(id) >= EVIDENCE_MAX_PER_CARD) return refuse(req, res, 409, { code: "TOO_MANY", error: `每张卡最多 ${EVIDENCE_MAX_PER_CARD} 个证据文件` });
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > EVIDENCE_MAX_BYTES) return refuse(req, res, 413, { code: "TOO_LARGE", error: "单个证据文件最多 2MB" });

    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    const fd = openSync(tmp, "wx");
    const hash = createHash("sha256");
    let size = 0, head = Buffer.alloc(0), mime = null, failed = null, closed = false;
    const cleanup = () => { if (!closed) { closed = true; try { closeSync(fd); } catch {} } try { unlinkSync(tmp); } catch {} };
    const result = await new Promise((resolve) => {
      const stop = (code, body) => { if (failed) return; failed = true; cleanup(); resolve({ code, body }); };
      req.on("data", (c) => {
        if (failed) return;
        size += c.length;
        if (size > EVIDENCE_MAX_BYTES) return stop(413, { code: "TOO_LARGE", error: "单个证据文件最多 2MB" });
        if (!mime) {
          head = Buffer.concat([head, c]).subarray(0, 12);
          if (head.length >= 12 && !(mime = sniffImage(head)))
            return stop(415, { code: "UNSUPPORTED_TYPE", error: "只收 png / jpeg / webp(按文件头判断;svg、html 等一律不收)" });
        }
        hash.update(c);
        try { writeSync(fd, c); } catch { stop(500, { error: "证据文件写不进数据目录" }); }
      });
      req.once("end", () => {
        if (failed) return;
        if (!mime) return stop(415, { code: "UNSUPPORTED_TYPE", error: "只收 png / jpeg / webp(文件太短,认不出文件头)" });
        resolve(null);
      });
      req.once("error", () => stop(400, { error: "上传中断" }));
      req.once("aborted", () => stop(400, { error: "上传中断" }));
    });
    if (result) return refuse(req, res, result.code, result.body);
    closeSync(fd); closed = true;
    const sha = hash.digest("hex"), final = join(dir, sha);
    // 落库前再核一次:上传期间卡被收回 / 换手 / 被别的上传占满,就不记。
    const now = store.get(db, id);
    const existing = q("SELECT * FROM task_evidence_files WHERE task_id=? AND sha256=?").get(id, sha);
    if (existing) { cleanup(); return send(res, 200, { evidence: out(existing), deduped: true, count: countOf(id) }); }
    if (!now || now.status !== "in_progress" || now.worker !== req.executor.id || String(now.run_id) !== String(t.run_id)) {
      cleanup(); return send(res, 409, { code: "NOT_HOLDER", error: `卡 #${id} 在上传期间已不在你手上,没有记下` });
    }
    if (countOf(id) >= EVIDENCE_MAX_PER_CARD) { cleanup(); return send(res, 409, { code: "TOO_MANY", error: `每张卡最多 ${EVIDENCE_MAX_PER_CARD} 个证据文件` }); }
    if (existsSync(final)) cleanup(); else renameSync(tmp, final);
    let digest = null; try { digest = digestOf(now) ?? null; } catch {}
    const rec = { sha256: sha, bytes: size, mime, note: n.note, by: req.executor.id, at: clock(), digest };
    q("INSERT INTO task_evidence_files (task_id, sha256, bytes, mime, note, by, at, digest) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, sha, size, mime, rec.note, rec.by, rec.at, digest);
    emit("task.evidence", { id });
    return send(res, 201, { evidence: rec, deduped: false, count: countOf(id) });
  }

  function download(req, res, id, sha, role) {
    if (role !== "operator") return send(res, 404, { error: "不存在" });   // 助手、执行者(含绑线)、受管线、审阅令牌:不说「无权」
    if (!SHA_RE.test(sha ?? "")) return send(res, 400, { code: "BAD_INPUT", error: "sha256 要 64 位小写十六进制" });
    const r = q("SELECT * FROM task_evidence_files WHERE task_id=? AND sha256=?").get(id, sha);
    const file = join(dir, sha);
    let st = null; try { st = r ? statSync(file) : null; } catch {}
    if (!r || !st?.isFile()) return send(res, 404, { error: "不存在" });
    res.writeHead(200, { "Content-Type": r.mime, "Content-Length": st.size, "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": EVIDENCE_CSP, "Content-Disposition": `inline; filename="evidence-${sha.slice(0, 12)}.${EXT[r.mime] || "bin"}"`,
      "Cache-Control": "private, no-store", "Cross-Origin-Resource-Policy": "same-origin" });
    return createReadStream(file).pipe(res);
  }

  /** server 的分派行调这里;返回 true = 已处理。 */
  async function route(req, res, p, m, role) {
    const mt = evidencePath(p);
    if (!mt) return false;
    const id = Number(mt[1]);
    if (mt[2] === undefined) {
      if (m !== "POST") { send(res, 405, { error: "方法不允许" }); return true; }
      await upload(req, res, id, role); return true;
    }
    if (m !== "GET" && m !== "HEAD") { send(res, 405, { error: "方法不允许" }); return true; }
    download(req, res, id, mt[2], role); return true;
  }
  /** 任务对象上的字段:evidence 列表 + 件数。 */
  const fields = (t) => { const ev = t ? listOf(t.id) : []; return { evidence: ev, evidence_count: ev.length }; };
  return { migrate, route, fields, listOf, countOf, referenced };
}
