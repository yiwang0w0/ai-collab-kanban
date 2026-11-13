// 公告板 v3 合同 I10d「包」的状态机:执行者把要交给人亲手跑的一组文件报成一个「包」,板记下每一步的事实,从事实推出状态。
//   draft     declare_package:当事执行者经桥报包名、文件(相对路径 + sha256 + 字节数,哈希由桥在执行者那一侧算 = 自报)、
//             expect、pins(要核对的项名)。同一张卡同名再报 = 覆盖(回到 draft)。每卡 ≤5 个包。
//   frozen    freeze_package:板冻结当前哈希表,记 frozen.digest(之后各步都与这张表比)。审阅 / 人工验收的结论绑这个 digest。
//   committed package_committed:执行者报提交号;线有可读工作仓时板在 30 秒定时扫里只读核该提交里各路径内容的 sha256
//             (单文件超 5MB 不核)→ commit.verified true / false / null。false = drift。
//   issued    issue_package:桥在执行者那一侧读出包目录里的文件、算哈希,只把哈希表与 label(给人看的位置说明,不是路径)传来;
//             板比对冻结表 → issued.match。match → 「要本人做的事」亲手跑;不 match → fault「先别跑」。
//   ran       POST /api/packages/:id/ran:只有操作者(人跑完了,结果 ok / failed)。
//   pinned    ran ok 且 pins.required 非空 → 板出一张核对卡(auto_kind:"pin",规则登记在 autocards.mjs 的 RULES);
//             核对卡的持卡者经桥 report_pin(自报,verified:false),审阅座席写的 verified:true;required 全 ok → pinned。
// 状态不存:每次读都从只追加的 package_events 推,取已达到的最远一格;drift 时写明停在哪一格之前、哪一步对不上。
// 重新冻结 = 新的一轮:旧冻结表上的提交 / 出包 / 跑 / 钉住都不再算。板不按执行者给的路径读盘;git 只读(约束同 credibility.mjs)。
// 表都在 board.db(packages、package_events),不往数据目录写新文件。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { normPath, normCommit, gitQueryEnv } from "./credibility.mjs";

export const PACKAGES_PER_CARD = 5, FILES_MAX = 50, PINS_MAX = 12, NAME_MAX = 80, EXPECT_MAX = 200, LABEL_MAX = 120, NOTE_MAX = 200;
export const EVENTS_PER_PACKAGE = 500, COMMIT_FILE_MAX = 5 * 1024 * 1024, BYTES_MAX = 2 ** 40;
export const STATES = ["draft", "frozen", "committed", "issued", "ran", "pinned"];
export const STATE_TEXT = { draft: "草稿", frozen: "已冻结", committed: "已提交", issued: "已出包", ran: "已跑", pinned: "已钉住" };
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_TIMEOUT_MS = 5000;
const sha256 = (x) => createHash("sha256").update(x).digest("hex");
const short = (h) => (typeof h === "string" && h ? h.slice(0, 12) : null);

/** 一行文字:去控制符与零宽 / 双向控制符,压空白。空 → null;超长 → 抛。 */
export function oneLine(v, max, field, { err, ERR }, { required = false } = {}) {
  if (v === undefined || v === null) { if (required) throw err(ERR.BAD_INPUT, `缺少 ${field}`); return null; }
  if (typeof v !== "string") throw err(ERR.BAD_INPUT, `${field} 要字符串`);
  let t = "";
  for (const ch of v) {
    const c = ch.codePointAt(0);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0x85) { t += " "; continue; }
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff || c === 0x061c) continue;
    t += ch;
  }
  t = t.replace(/\s+/g, " ").trim();
  if (!t) { if (required) throw err(ERR.BAD_INPUT, `${field} 不能为空`); return null; }
  if ([...t].length > max) throw err(ERR.BAD_INPUT, `${field} 最多 ${max} 字(单行)`);
  return t;
}

/** 文件哈希表:[{path, sha256, bytes}],≤50,路径规则同 H1(normPath),同一路径不许出现两次。 */
export function normFiles(v, ctx, { min = 1, field = "files" } = {}) {
  if (!Array.isArray(v) || v.length > FILES_MAX || v.length < min) throw ctx.err(ctx.ERR.BAD_INPUT, `${field} 要 ${min}–${FILES_MAX} 项的数组`);
  const out = [], seen = new Set();
  for (const x of v) {
    if (!x || typeof x !== "object" || Array.isArray(x)) throw ctx.err(ctx.ERR.BAD_INPUT, `${field} 的每一项要 {path, sha256, bytes}`);
    for (const k of Object.keys(x)) if (!["path", "sha256", "bytes"].includes(k)) throw ctx.err(ctx.ERR.BAD_INPUT, `${field} 的项里不认识的字段 ${k}`);
    let path;
    try { path = normPath(x.path, ctx); } catch (e) { throw ctx.err(ctx.ERR.BAD_INPUT, String(e?.message || e).replace("files[].path", `${field}[].path`)); }
    const h = typeof x.sha256 === "string" ? x.sha256.toLowerCase() : "";
    if (!SHA256_RE.test(h)) throw ctx.err(ctx.ERR.BAD_INPUT, `${field}[].sha256 要 64 位十六进制:${path}`);
    if (!Number.isSafeInteger(x.bytes) || x.bytes < 0 || x.bytes > BYTES_MAX) throw ctx.err(ctx.ERR.BAD_INPUT, `${field}[].bytes 要非负整数:${path}`);
    if (seen.has(path)) throw ctx.err(ctx.ERR.BAD_INPUT, `${field} 里路径重复:${path}`);
    seen.add(path); out.push({ path, sha256: h, bytes: x.bytes });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** pins:要核对的项名,≤12,去重保序;每项单行 ≤80。 */
export function normPins(v, ctx) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > PINS_MAX) throw ctx.err(ctx.ERR.BAD_INPUT, `pins 要名字数组,最多 ${PINS_MAX} 项`);
  const out = [];
  for (const x of v) { const n = oneLine(x, NAME_MAX, "pins[]", ctx, { required: true }); if (!out.includes(n)) out.push(n); }
  return out;
}

/** 冻结表的 digest:按路径排序的 {path, sha256}(字节数不进;内容一样就是同一份)。 */
export function tableDigest(files) {
  const f = [...files].map((x) => ({ path: x.path, sha256: x.sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(JSON.stringify({ v: 1, files: f }));
}

/** 出包核对:与冻结表比。返回 { match, diff:[path], missing:[path], extra:[path] }。 */
export function compareIssued(frozenFiles, files, missing = []) {
  const want = new Map(frozenFiles.map((f) => [f.path, f.sha256])), got = new Map(files.map((f) => [f.path, f.sha256]));
  const diff = [], miss = [...new Set(missing)].filter((p) => want.has(p)), extra = [];
  for (const [p, h] of want) { if (miss.includes(p)) continue; if (!got.has(p)) miss.push(p); else if (got.get(p) !== h) diff.push(p); }
  for (const p of got.keys()) if (!want.has(p)) extra.push(p);
  return { match: !diff.length && !miss.length && !extra.length, diff: diff.sort(), missing: miss.sort(), extra: extra.sort() };
}

/** 从一个包的事件(按 id 升序)推出包的公开形状。纯函数(测试直接调)。 */
export function derive(pkg, evs) {
  const last = (kind, after = 0, pred = () => true) => {
    for (let i = evs.length - 1; i >= 0; i--) { const e = evs[i]; if (e.id <= after) break; if (e.kind === kind && pred(e)) return e; }
    return null;
  };
  const decl = last("declare"), frz = last("freeze");
  const files = decl ? decl.data.files : [];
  const pinsRequired = decl ? decl.data.pins || [] : [];
  const frozen = frz ? { digest: frz.data.digest, at: frz.at } : null;
  const base = frz ? frz.id : 0;
  const cm = frz ? last("commit", base) : null;
  const ck = cm ? last("commit_check", cm.id, (e) => e.data.sha === cm.data.sha) : null;
  const commit = cm ? { sha: cm.data.sha, verified: ck ? ck.data.verified : null, ...(ck?.data.mismatch?.length ? { mismatch: ck.data.mismatch } : {}), at: cm.at } : null;
  const is = frz ? last("issue", base) : null;
  const issued = is ? { label: is.data.label, match: is.data.match, at: is.at, ...(is.data.match ? {} : { diff: is.data.diff, missing: is.data.missing, extra: is.data.extra }) } : null;
  const rn = is ? last("ran", is.id) : null;
  const ran = rn ? { result: rn.data.result, at: rn.at, note: rn.data.note ?? null } : null;
  const okRun = rn && rn.data.result === "ok" ? rn : null;
  // 钉住与核对卡都按冻结轮算(同一轮里再跑一次不另出核对卡、已报的项照算);只有最近一次运行是 ok 时才算钉住。
  const got = [];
  if (frz) for (const e of evs) if (e.id > base && e.kind === "pin") got.push({ name: e.data.name, ok: e.data.ok, by: e.by, verified: !!e.data.verified, at: e.at });
  // 每个必需项:有已核的取最近一条已核,否则取最近一条自报。
  let n = 0, a = 0, b = 0;
  for (const name of pinsRequired) {
    const mine = got.filter((g) => g.name === name);
    const pick = [...mine].reverse().find((g) => g.verified) || [...mine].reverse()[0];
    if (okRun && pick?.ok) { n++; if (pick.verified) a++; else b++; }
  }
  const pinCard = frz ? last("pin_card", base) : null;
  const pinned = { n, total: pinsRequired.length, verified: a, self: b };

  // 状态:取已达到的最远一格;drift 写明停在哪一格之前、哪一步对不上。
  let state = "draft", drift = null;
  if (frozen) {
    if (decl && decl.id > frz.id && tableDigest(files) !== frozen.digest)
      drift = { before: "frozen", step: "declare", why: "冻结之后重报的文件与冻结表不同,须重新冻结" };
    else {
      state = "frozen";
      if (commit) {
        if (commit.verified === false) drift = { before: "committed", step: "commit", why: "提交里的内容与冻结表不同" };
        else state = "committed";
      }
      if (!drift && issued) {
        if (!issued.match) drift = { before: "issued", step: "issue", why: "出包后的文件和预审时不一样,先别跑" };
        else state = "issued";
      }
      if (!drift && issued?.match && ran) state = "ran";
      if (state === "ran" && ran.result === "ok" && pinned.total > 0 && n === pinned.total) state = "pinned";
    }
  }
  const conclusions = evs.filter((e) => e.kind === "conclusion").slice(-20)
    .map((e) => ({ kind: e.data.kind, verdict: e.data.verdict, digest: e.data.digest, at: e.at, stale: !frozen || e.data.digest !== frozen.digest || !!drift }));
  return {
    id: Number(pkg.id), card_id: Number(pkg.card_id), name: pkg.name, state, drift: !!drift, drift_detail: drift,
    files, frozen, commit, issued, ran,
    pins: { required: pinsRequired, got: got.slice(-50) }, pinned,
    expect: decl?.data.expect ?? null, expect_by: decl?.data.expect ? "executor" : null,
    pin_card: pinCard ? Number(pinCard.data.card_id) : null, conclusions,
    declared_by: decl?.by ?? null, updated_at: evs.length ? evs[evs.length - 1].at : pkg.created_at,
  };
}

/** 自动通过闸里这一个包的缺口(空 = 满足):ran ok、pins 全 ok、无 drift。 */
export function gapsOf(v) {
  const out = [], who = `包「${v.name}」`;
  if (v.drift) out.push(`${who}对不上:${v.drift_detail.why}(停在「${STATE_TEXT[v.drift_detail.before]}」之前)`);
  if (!v.ran) out.push(`${who}还没跑(停在「${STATE_TEXT[v.state]}」)`);
  else if (v.ran.result !== "ok") out.push(`${who}跑了,结果是失败`);
  else if (v.pinned.total && v.pinned.n < v.pinned.total) out.push(`${who}钉住 ${v.pinned.n}/${v.pinned.total}`);
  return out;
}

/** 核对卡的卡面(纯函数):要核的项、文件相对路径、冻结摘要短号、「只读核对」。不写 label、不写本机路径。 */
export function composePin({ card, pkg }) {
  const L = [];
  L.push(`看板为卡 #${card.id}「${card.title}」的包「${pkg.name}」出的核对卡。包已由本人跑过(结果 ok),请只读核对下面每一项,逐项用 report_pin 报结果。`);
  L.push(`冻结摘要:${short(pkg.frozen?.digest) || "(无)"}`);
  L.push("");
  L.push(`要核的项(${pkg.pins.required.length} 项):`);
  pkg.pins.required.forEach((n, i) => L.push(`${i + 1}. ${n}`));
  L.push("");
  L.push(`包里的文件(${pkg.files.length} 个,相对路径 · sha256 短号):`);
  for (const f of pkg.files) L.push(`  ${f.path} · ${short(f.sha256)}`);
  L.push("");
  L.push("只读核对:不改文件、不重跑包、不推送;看不到就报 ok=false 并在交付正文里写明。");
  return {
    subject: `核对:包「${pkg.name}」(#${card.id})`.slice(0, 120),
    description: L.join("\n"),
    acceptance: `每一项都经 report_pin 报了结果(package_id ${pkg.id})。`,
  };
}

/** 只读 git(返回字节;约束同 credibility / integrate:--no-replace-objects、清继承 GIT_*、超时、不检出、不执行仓内东西)。 */
export function gitBytes(git, repo, args, max = COMMIT_FILE_MAX + 1024) {
  const argv = ["--no-replace-objects", "-c", "core.fsmonitor=false", "-C", repo, ...args];
  return new Promise((resolve) => {
    execFile(git, argv, { env: gitQueryEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: max, encoding: "buffer", windowsHide: true, shell: false }, (e, stdout) => {
      if (!e) return resolve({ ok: true, out: stdout });
      resolve({ ok: false, code: typeof e.code === "number" ? e.code : null, broken: e.killed || typeof e.code !== "number" });
    });
  });
}

/**
 * @param db / store      库与 store.js
 * @param isExecutor      (worker) => 是不是登记的外部执行者
 * @param git / repoForLine 只读核提交用(与 credibility 同一个)
 * @param clean           (s) => 一行、脱敏(label / expect / note)
 * @param emit            (type, data) => SSE
 * @param query           注入点(测试计数用):(git, repo, args) => Promise<{ok, out, code, broken}>
 */
export function openPackages({ db, store, isExecutor = () => false, git = () => null, repoForLine = () => null, clean = (s) => String(s ?? ""),
                               emit = () => {}, query = gitBytes, now = () => new Date().toISOString(), log = () => {} }) {
  const ctx = { err: store.err, ERR: store.ERR };
  const { err, ERR } = ctx;
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS packages (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, name TEXT NOT NULL,
      created_by TEXT, created_at TEXT NOT NULL, UNIQUE(card_id, name))`);
    db.exec(`CREATE TABLE IF NOT EXISTS package_events (id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL, card_id INTEGER NOT NULL,
      kind TEXT NOT NULL, data_json TEXT NOT NULL, by_ TEXT, at TEXT NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS package_events_pkg ON package_events(package_id, id)");
    db.exec("CREATE INDEX IF NOT EXISTS packages_card ON packages(card_id, id)");
  }
  const row = (id) => db.prepare("SELECT * FROM packages WHERE id=?").get(Number(id)) || null;
  const rowsOf = (cardId) => db.prepare("SELECT * FROM packages WHERE card_id=? ORDER BY id").all(Number(cardId));
  const eventsOf = (id) => db.prepare("SELECT * FROM package_events WHERE package_id=? ORDER BY id").all(Number(id))
    .map((e) => { let data = {}; try { data = JSON.parse(e.data_json); } catch {} return { id: e.id, kind: e.kind, data, by: e.by_, at: e.at }; });
  const view = (id) => { const r = row(id); return r ? derive(r, eventsOf(r.id)) : null; };
  const listFor = (cardId) => rowsOf(cardId).map((r) => derive(r, eventsOf(r.id)));
  const countFor = (cardId) => Number(db.prepare("SELECT COUNT(*) AS n FROM packages WHERE card_id=?").get(Number(cardId))?.n || 0);

  /** 「当事执行者」:现在持这张卡的,或卡在等验收 / 等裁定时最近一次交付它的外部执行者(卡上的 worker 就是最近交付的那一方)。受管线不算。 */
  function partyOf(t) {
    if (!t || t.archived_at || !t.worker || !isExecutor(t.worker)) return null;
    if (t.status === "in_progress") return String(t.worker);
    if (t.status === "waiting" && ["review", "decision", "confirm"].includes(t.waiting_for)) return String(t.worker);
    return null;
  }

  function append(pkg, kind, data, by) {
    const n = Number(db.prepare("SELECT COUNT(*) AS n FROM package_events WHERE package_id=?").get(Number(pkg.id))?.n || 0);
    if (n >= EVENTS_PER_PACKAGE) throw err(ERR.CONFLICT, `包 #${pkg.id} 的记录已达上限 ${EVENTS_PER_PACKAGE} 条(换个包名重报)`);
    db.prepare("INSERT INTO package_events(package_id, card_id, kind, data_json, by_, at) VALUES(?,?,?,?,?,?)")
      .run(Number(pkg.id), Number(pkg.card_id), kind, JSON.stringify(data), by == null ? null : String(by), now());
  }
  /** 每次变化:卡历史一条 + SSE package.changed。 */
  function changed(pkg, step, by, extra = {}) {
    const v = view(pkg.id);
    try { store.appendEvent(db, { taskId: Number(pkg.card_id), kind: "package.changed", actor: by || "system",
      detail: { package_id: Number(pkg.id), name: v.name, step, state: v.state, drift: v.drift, ...extra } }); } catch {}
    emit("package.changed", { id: Number(pkg.card_id), package_id: Number(pkg.id), state: v.state, drift: v.drift, step });
    return v;
  }

  // ── 执行者的各步(谁能报由 server 核:当事执行者;这里只核形状与先后)──────────────────────────
  function declare(cardId, b, by) {
    const name = oneLine(b?.name, NAME_MAX, "name", ctx, { required: true });
    const files = normFiles(b?.files, ctx);
    const expect = b?.expect === undefined || b?.expect === null ? null : clean(oneLine(b.expect, EXPECT_MAX, "expect", ctx)) || null;
    const pins = normPins(b?.pins, ctx);
    let pkg = db.prepare("SELECT * FROM packages WHERE card_id=? AND name=?").get(Number(cardId), name);
    if (!pkg) {
      if (countFor(cardId) >= PACKAGES_PER_CARD) throw err(ERR.CONFLICT, `每张卡最多 ${PACKAGES_PER_CARD} 个包(同名重报 = 覆盖)`);
      const r = db.prepare("INSERT INTO packages(card_id, name, created_by, created_at) VALUES(?,?,?,?)").run(Number(cardId), name, by == null ? null : String(by), now());
      pkg = row(Number(r.lastInsertRowid));
    }
    append(pkg, "declare", { files, expect, pins }, by);
    return changed(pkg, "declare", by);
  }
  function freeze(pkgId, by) {
    const pkg = row(pkgId); if (!pkg) throw err(ERR.NOT_FOUND, `包 #${pkgId} 不存在`);
    const v = view(pkg.id);
    if (!v.files.length) throw err(ERR.CONFLICT, `包 #${pkgId} 还没报文件`);
    const digest = tableDigest(v.files);
    if (v.frozen && v.frozen.digest === digest && !v.drift) return { ...v, unchanged: true };   // 同一份表再冻一次 = 不动
    append(pkg, "freeze", { digest, files: v.files }, by);
    return changed(pkg, "freeze", by, { digest: short(digest) });
  }
  function commit(pkgId, sha, by) {
    const pkg = row(pkgId); if (!pkg) throw err(ERR.NOT_FOUND, `包 #${pkgId} 不存在`);
    const c = normCommit(sha, "commit", ctx);
    if (!c) throw err(ERR.BAD_INPUT, "commit 要完整的 40 或 64 位十六进制提交号");
    if (!view(pkg.id).frozen) throw err(ERR.CONFLICT, `包 #${pkgId} 还没冻结(先 freeze_package)`);
    append(pkg, "commit", { sha: c }, by);
    return changed(pkg, "commit", by, { commit: short(c) });
  }
  function issue(pkgId, b, by) {
    const pkg = row(pkgId); if (!pkg) throw err(ERR.NOT_FOUND, `包 #${pkgId} 不存在`);
    const label = clean(oneLine(b?.label, LABEL_MAX, "label", ctx, { required: true }));
    if (!label) throw err(ERR.BAD_INPUT, "label 要一行给人看的位置说明(不是路径)");
    const files = normFiles(b?.files ?? [], ctx, { min: 0 });
    let missing = [];
    if (b?.missing !== undefined && b?.missing !== null) {
      if (!Array.isArray(b.missing) || b.missing.length > FILES_MAX) throw err(ERR.BAD_INPUT, `missing 要路径数组,最多 ${FILES_MAX} 项`);
      missing = b.missing.map((p) => normPath(p, ctx));
    }
    const v = view(pkg.id);
    if (!v.frozen) throw err(ERR.CONFLICT, `包 #${pkgId} 还没冻结(先 freeze_package)`);
    const frz = eventsOf(pkg.id).filter((e) => e.kind === "freeze").pop();
    const cmp = compareIssued(frz.data.files, files, missing);
    append(pkg, "issue", { label, files, match: cmp.match, diff: cmp.diff, missing: cmp.missing, extra: cmp.extra }, by);
    return changed(pkg, "issue", by, { match: cmp.match });
  }
  // ── 操作者:跑完了 ─────────────────────────────────────────────────────────────────────────
  function ran(pkgId, b, by = "operator") {
    const pkg = row(pkgId); if (!pkg) throw err(ERR.NOT_FOUND, `包 #${pkgId} 不存在`);
    if (!["ok", "failed"].includes(b?.result)) throw err(ERR.BAD_INPUT, "result 只接受 ok / failed");
    if (b.release_pin !== undefined && typeof b.release_pin !== "boolean") throw err(ERR.BAD_INPUT, "release_pin 只接受 true / false");
    const note = b.note === undefined || b.note === null ? null : clean(oneLine(b.note, NOTE_MAX, "note", ctx)) || null;
    const v = view(pkg.id);
    if (!v.issued) throw err(ERR.CONFLICT, `包 #${pkgId} 还没出包(先由执行者 issue_package),没有可跑的东西`);
    append(pkg, "ran", { result: b.result, note, release_pin: b.release_pin === true }, by);
    return changed(pkg, "ran", by, { result: b.result });
  }
  // ── 钉住:核对卡的持卡者(自报)或审阅座席(已核)──────────────────────────────────────────────
  function pin(pkgId, b, { by, verified }) {
    const pkg = row(pkgId); if (!pkg) throw err(ERR.NOT_FOUND, `包 #${pkgId} 不存在`);
    const name = oneLine(b?.name, NAME_MAX, "name", ctx, { required: true });
    if (typeof b?.ok !== "boolean") throw err(ERR.BAD_INPUT, "ok 只接受 true / false");
    const v = view(pkg.id);
    if (!v.ran || v.ran.result !== "ok") throw err(ERR.CONFLICT, `包 #${pkgId} 还没有一次 ok 的运行,没有可钉的`);
    if (!v.pins.required.includes(name)) throw err(ERR.BAD_INPUT, `「${name}」不是这个包要核的项(${v.pins.required.join("、") || "没有要核的项"})`);
    append(pkg, "pin", { name, ok: b.ok, verified: !!verified }, by);
    return changed(pkg, "pin", by, { pin: name, ok: b.ok, verified: !!verified });
  }
  /** 审阅 / 人工验收的结论绑每个包当时的 frozen.digest(之后重冻 / drift → 过期)。 */
  function noteConclusion(cardId, { kind, verdict }, by) {
    for (const v of listFor(cardId)) if (v.frozen) append(row(v.id), "conclusion", { kind, verdict, digest: v.frozen.digest }, by);
  }

  // ── 读 ───────────────────────────────────────────────────────────────────────────────────
  const summaryOf = (v) => ({ id: v.id, name: v.name, state: v.state, drift: v.drift, pinned: { n: v.pinned.n, total: v.pinned.total } });
  const summaryFor = (cardId) => listFor(cardId).map(summaryOf);
  /** 任务对象的字段(一次推导两处用):packages 摘要、packages_count、package_gaps(自动通过闸的缺口;没有包 = [])。 */
  function cardFields(cardId) { const all = listFor(cardId); return { packages: all.map(summaryOf), packages_count: all.length, package_gaps: all.flatMap(gapsOf) }; }
  /** 自动通过闸(只对带包的卡):缺口逐条。没有包 = []。 */
  const gateMissing = (cardId) => listFor(cardId).flatMap(gapsOf);
  /** 核对卡的持卡者要看的:这个核对卡是哪个包的(当前冻结轮)。 */
  function pinCardOf(pkgId) { const v = view(pkgId); return v?.pin_card ?? null; }

  /** 「要本人做的事」的包条目:出包了、还没跑 → match 且无 drift = 亲手跑;不然 = fault。tasks = 未归档的卡。 */
  function attentionItems(tasks) {
    const out = [];
    for (const t of tasks) {
      if (!t || t.archived_at) continue;
      // 被取代的卡(合同 I1):它的包不再要人跑,不进「要本人做的事」。
      if (typeof store.supersededBy === "function" && store.supersededBy(db, Number(t.id)) != null) continue;
      for (const v of listFor(t.id)) {
        if (!v.issued || v.ran) continue;
        const pkg = { id: v.id, name: v.name, label: v.issued.label, expect: v.expect, expect_by: v.expect_by, frozen: short(v.frozen?.digest) };
        if (v.issued.match && !v.drift) out.push({ kind: "hands", task_id: Number(t.id), title: `跑包「${v.name}」`, since: v.issued.at, package: pkg });
        else out.push({ kind: "fault", task_id: Number(t.id), title: `包「${v.name}」出包后的文件和预审时不一样,先别跑`, since: v.issued.at,
                        package: { ...pkg, why: v.drift_detail?.why ?? null } });
      }
    }
    return out;
  }

  /** 要出核对卡的包:ran ok(当前出包之后)、pins.required 非空、这一轮还没有核对卡。autocards 的 RULES 调用。 */
  function pinCandidates() {
    const out = [];
    const ids = db.prepare("SELECT DISTINCT package_id FROM package_events WHERE kind='ran'").all().map((r) => r.package_id);
    for (const id of ids) {
      const v = view(id);
      if (!v || !v.ran || v.ran.result !== "ok" || !v.pins.required.length || v.pin_card != null || v.drift || !v.frozen) continue;
      const rn = [...eventsOf(id)].reverse().find((e) => e.kind === "ran");
      out.push({ pkg: v, release_pin: !!rn?.data.release_pin, key: `${id}:${v.frozen.digest}` });
    }
    return out;
  }
  function recordPinCard(pkgId, cardId) { const pkg = row(pkgId); append(pkg, "pin_card", { card_id: Number(cardId) }, "rule"); return changed(pkg, "pin_card", "rule", { pin_card: Number(cardId) }); }

  // ── 定时扫:只读核报来的提交(与 integrate 同一个 30 秒扫;请求路径上从不跑 git)──────────────────────
  const settled = new Map();   // (仓, 提交, 冻结 digest) → 已核出 true / false 的结果(null 不缓存,下轮再核)
  let running = null, runs = 0;
  function scan() {
    if (running) return running;
    running = (async () => {
      const g = git();
      if (!g) return;
      const ids = db.prepare("SELECT DISTINCT package_id FROM package_events WHERE kind='commit'").all().map((r) => r.package_id);
      for (const id of ids) {
        const v = view(id);
        if (!v?.commit || v.commit.verified !== null || !v.frozen) continue;
        const card = store.get(db, v.card_id);
        const repo = card ? repoForLine(card.line) : null;
        if (!repo) continue;
        const key = repo + "\u0000" + v.commit.sha + "\u0000" + v.frozen.digest;
        let res = settled.get(key);
        if (!res) {
          const frzFiles = eventsOf(id).filter((e) => e.kind === "freeze").pop()?.data.files || [];
          res = await verifyCommit(g, repo, v.commit.sha, frzFiles);
          if (res.verified !== null) settled.set(key, res);
        }
        if (res.verified === null) continue;
        append(row(id), "commit_check", { sha: v.commit.sha, verified: res.verified, mismatch: res.mismatch }, "board");
        changed(row(id), "commit_check", "system", { verified: res.verified });
      }
    })().catch((e) => log(`包的提交核对出错:${String(e?.message || e).split("\n")[0].slice(0, 160)}`)).finally(() => { running = null; });
    return running;
  }
  async function verifyCommit(g, repo, sha, files) {
    runs++;
    const t = await query(g, repo, ["cat-file", "-t", sha]);
    if (!t.ok) return t.broken ? { verified: null, mismatch: [] } : { verified: false, mismatch: ["提交在工作仓里不存在"] };
    if (String(t.out).trim() !== "commit") return { verified: false, mismatch: ["不是提交"] };
    const mismatch = []; let unknown = false;
    for (const f of files) {
      runs++;
      const s = await query(g, repo, ["cat-file", "-s", `${sha}:${f.path}`]);
      if (!s.ok) { if (s.broken) unknown = true; else mismatch.push(`${f.path} 不在这个提交里`); continue; }
      const size = Number(String(s.out).trim());
      if (!Number.isFinite(size) || size > COMMIT_FILE_MAX) { unknown = true; continue; }     // 单文件超 5MB 不核
      runs++;
      const b = await query(g, repo, ["cat-file", "blob", `${sha}:${f.path}`]);
      if (!b.ok) { unknown = true; continue; }
      if (sha256(b.out) !== f.sha256) mismatch.push(`${f.path} 的内容与冻结表不同`);
    }
    if (mismatch.length) return { verified: false, mismatch };
    return { verified: unknown ? null : true, mismatch: [] };
  }

  return { migrate, partyOf, declare, freeze, commit, issue, ran, pin, noteConclusion, view, listFor, summaryFor, cardFields, countFor, gateMissing,
           pinCardOf, attentionItems, pinCandidates, recordPinCard, scan, gitRuns: () => runs, row };
}
