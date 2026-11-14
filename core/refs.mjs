// 公告板 v3 合同 I10a「引用规格某一版」+ 复审卡。
// 概念不变:看板 = 公告板。引用只由操作者写(建卡 / 计划项 / POST /api/tasks/:id/refs 覆盖式;重钉 /refs/repin);
//   板只登记「这张卡是照 #S 的第几版说明做的」,并从事实推出:引用过期(按说明哈希判)、交付时是否基于过期引用、
//   复审卡(对照 #S 说明看 #X 这次交付)与复审结论。板不替谁跑命令,不读工作仓,说明里只写相对路径与短号。
//   - 钉:写入时取被引用卡当前的说明版本与哈希 pinned:{version, hash}(spec-version.mjs 的 observe)。覆盖式写入里原来就引用的卡
//     保留原来的钉(不借覆盖悄悄重钉);新加的钉到当前。钉的版本并进引用方自己的说明哈希 → 重钉 = 引用方说明版本 +1。
//   - 过期:被引用卡的说明哈希 ≠ 钉的哈希。事件 ref.stale 以〔引用方, 被引用卡, 版本〕防重;未开始的引用方领卡闸 REF_STALE。
//   - 读范围:持卡执行者可读它所持卡引用的卡(只给标题、说明、验收、说明版本),跨线也行;别的卡照旧。
//   - 复审卡:ref 带 review:true、引用方交付、两卡不同线 → 在引用方同一父卡下出一张未放行的卡(auto_kind:"spec_review",
//     线 = 被引用卡的线);同线不出(review_skipped:"same_line");被取代的引用方不出。〔X, S, digest〕一次。
//     复审卡被验收通过后,按它回报里名为 spec_conformance 的检查给 X 记 spec_review 结论;X 的 digest 或 S 的说明版本变 → 结论过期。
// 表都在 board.db(server.mjs 打开库后 migrate);事件 → 动作登记在 autocards.mjs 的 RULES(server 把这里的 sweep 交给它)。
import { createHash } from "node:crypto";

export const REFS_MAX = 8;
export const CONFORMANCE_CHECK = "spec_conformance";
const short = (h) => (typeof h === "string" && h ? h.slice(0, 12) : null);

/** refs 参数:[卡号] 或 [{card, review?}](可混用)。undefined = 不设;null 当空数组(清掉)。卡存不存在由 set 核。 */
export function normRefs(v, { err, ERR }) {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (!Array.isArray(v) || v.length > REFS_MAX) throw err(ERR.BAD_INPUT, `refs 要数组,最多 ${REFS_MAX} 项(卡号,或 {card, review?})`);
  const out = new Map();
  for (const x of v) {
    let card, review = false;
    if (Number.isSafeInteger(x)) card = x;
    else if (x && typeof x === "object" && !Array.isArray(x)) {
      for (const k of Object.keys(x)) if (!["card", "review"].includes(k)) throw err(ERR.BAD_INPUT, `refs 的项不认识的字段 ${k}`);
      card = x.card;
      if (x.review !== undefined && typeof x.review !== "boolean") throw err(ERR.BAD_INPUT, "refs[].review 只接受 true / false");
      review = x.review === true;
    } else throw err(ERR.BAD_INPUT, "refs 的每一项要卡号或 {card, review?}");
    if (!Number.isSafeInteger(card) || card < 1) throw err(ERR.BAD_INPUT, "refs[].card 要卡号(正整数)");
    out.set(card, { card, review: review || out.get(card)?.review === true });
  }
  return [...out.values()];
}

/**
 * 复审卡的卡面(纯函数)。x / s = {id, title, line};sVersion = 对照的说明版本;fp = X 当前指纹(credibility.fields 的 fingerprint);
 * verified / self = X 当前指纹上的已核 / 自报检查 [{name,status}];refStale = X 对 S 的引用是否已过期。
 */
export function composeReview({ x, s, sVersion, fp = null, verified = [], self = [], refStale = false }) {
  const ST = { pass: "通过", fail: "未通过", unverified: "未验证" };
  const fmt = (xs) => (xs.length ? xs.map((c) => `${c.name} ${ST[c.status] || c.status}`).join("、") : "无");
  const L = [];
  L.push(`看板出的复审卡:对照 #${s.id}「${s.title}」的说明 v${sVersion},看 #${x.id}「${x.title}」这次交付是否照它做的。只读核对,不改交付。`);
  L.push("");
  L.push(`#${x.id} 这次交付:指纹 ${short(fp?.digest) || "(没有)"}${fp?.head_commit ? ` · 提交 ${short(fp.head_commit)}` : " · 没有交付提交"}${fp?.base_commit ? ` · 底 ${short(fp.base_commit)}` : ""}`);
  const files = (fp?.files || []).map((f) => f.path).slice(0, 20);
  L.push(files.length ? `改动文件(${(fp?.files || []).length} 个):${files.join("、")}${(fp?.files || []).length > 20 ? " …" : ""}` : "改动文件:交付没有列文件");
  L.push(`已核检查:${fmt(verified)};自报检查:${fmt(self)}`);
  L.push(refStale ? `注意:#${x.id} 钉的 #${s.id} 说明已经过期(#${s.id} 在钉之后改过),这次交付照的是旧版。` : `#${x.id} 钉的 #${s.id} 说明是当前版(v${sVersion})。`);
  L.push("");
  L.push(`回报方式:report_result 的 checks 里给一项 name=${CONFORMANCE_CHECK}:符合 = pass,不符合 = fail;偏差逐条写在交付正文里。`);
  return {
    // 标题带交付指纹短号:同一父卡下标题唯一(另出一张时不撞)。
    subject: `复审:#${x.id} 是否照 #${s.id} 说明 v${sVersion}(交付 ${short(fp?.digest)?.slice(0, 8) || "无指纹"})`.slice(0, 120),
    description: L.join("\n"),
    acceptance: `交付带 checks 一项 ${CONFORMANCE_CHECK}(pass / fail);fail 时正文写出与说明不符的地方。`,
  };
}

/**
 * @param db / store  库与 store.js
 * @param spec        spec-version(observe:{version, hash})
 * @param cred        credibility(fields / currentDigest)
 * @param clean       (s, max) => 给人看的一行(脱敏)
 * @param afterEdit   (id, by) => 说明改了之后(spec 版本核对)
 */
export function openRefs({ db, store, spec, cred, clean = (s) => String(s ?? ""), afterEdit = () => {}, emit = () => {}, log = () => {},
                           now = () => new Date().toISOString() }) {
  const ERR = store.ERR, err = store.err;
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS task_refs (task_id INTEGER NOT NULL, card INTEGER NOT NULL, review INTEGER NOT NULL DEFAULT 0,
      pinned_version INTEGER NOT NULL, pinned_hash TEXT NOT NULL, by_ TEXT, at TEXT NOT NULL, PRIMARY KEY (task_id, card))`);
    db.exec("CREATE INDEX IF NOT EXISTS task_refs_card ON task_refs(card)");
    db.exec(`CREATE TABLE IF NOT EXISTS ref_stale_seen (task_id INTEGER NOT NULL, card INTEGER NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL,
      at TEXT NOT NULL, PRIMARY KEY (task_id, card, hash))`);
    db.exec(`CREATE TABLE IF NOT EXISTS ref_runs (task_id INTEGER NOT NULL, run_id TEXT NOT NULL, stale INTEGER NOT NULL, cards_json TEXT NOT NULL,
      at TEXT NOT NULL, PRIMARY KEY (task_id, run_id))`);
    db.exec(`CREATE TABLE IF NOT EXISTS spec_review_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, card INTEGER, x INTEGER NOT NULL, s INTEGER NOT NULL,
      digest TEXT NOT NULL, s_version INTEGER NOT NULL, at TEXT NOT NULL, result TEXT, UNIQUE (x, s, digest))`);
    db.exec("CREATE INDEX IF NOT EXISTS spec_review_cards_card ON spec_review_cards(card)");
    db.exec(`CREATE TABLE IF NOT EXISTS spec_review_results (by_card INTEGER PRIMARY KEY, x INTEGER NOT NULL, s INTEGER NOT NULL, s_version INTEGER NOT NULL,
      digest TEXT NOT NULL, verdict TEXT NOT NULL, at TEXT NOT NULL)`);
  }
  const rowsOf = (id) => db.prepare("SELECT * FROM task_refs WHERE task_id=? ORDER BY card").all(Number(id));
  const event = (taskId, kind, actor, detail) => { try { store.appendEvent(db, { taskId: Number(taskId), kind, actor: actor || "system", detail }); } catch {} };
  const current = (card) => { try { return spec.observe(Number(card)); } catch { return null; } };

  /** 并进引用方说明哈希的部分:[[card, 钉的哈希, review]];没有引用 = null(哈希与旧版相同)。 */
  function pinsOf(id) {
    const r = rowsOf(id);
    return r.length ? JSON.stringify(["refs:v1", r.map((x) => [Number(x.card), x.pinned_hash, x.review ? 1 : 0])]) : null;
  }

  /** 覆盖式写入(操作者 / 计划)。原来就引用的卡保留原钉;新加的钉到当前。返回写后的 refs 行。 */
  function set(id, refs, by = "operator") {
    const t = store.get(db, Number(id));
    if (!t) throw err(ERR.NOT_FOUND, `卡 #${id} 不存在`);
    for (const r of refs) {
      if (r.card === Number(id)) throw err(ERR.BAD_INPUT, "refs 不能引用这张卡自己");
      const s = store.get(db, r.card);
      if (!s) throw err(ERR.NOT_FOUND, `refs 里的卡 #${r.card} 不存在`);
      if (s.archived_at) throw err(ERR.CONFLICT, `refs 里的卡 #${r.card} 已归档`);
    }
    const before = new Map(rowsOf(id).map((r) => [Number(r.card), r]));
    const ownsTransaction = !db.isTransaction;
    db.exec(ownsTransaction ? "BEGIN IMMEDIATE" : "SAVEPOINT refs_set");
    try {
      db.prepare("DELETE FROM task_refs WHERE task_id=?").run(Number(id));
      const ins = db.prepare("INSERT INTO task_refs(task_id, card, review, pinned_version, pinned_hash, by_, at) VALUES(?,?,?,?,?,?,?)");
      for (const r of refs) {
        const old = before.get(r.card);
        const pin = old ? { version: Number(old.pinned_version), hash: old.pinned_hash } : current(r.card);
        ins.run(Number(id), r.card, r.review ? 1 : 0, pin.version, pin.hash, old ? old.by_ : String(by), old ? old.at : now());
      }
      db.exec(ownsTransaction ? "COMMIT" : "RELEASE refs_set");
    } catch (e) { try { db.exec(ownsTransaction ? "ROLLBACK" : "ROLLBACK TO refs_set; RELEASE refs_set"); } catch {} throw e; }
    const after = rowsOf(id).map((r) => Number(r.card));
    if (JSON.stringify([...before.keys()].sort((a, b) => a - b)) !== JSON.stringify(after) || refs.some((r) => (before.get(r.card)?.review ? 1 : 0) !== (r.review ? 1 : 0)))
      event(id, "refs.set", by, { cards: after, review: refs.filter((r) => r.review).map((r) => r.card) });
    return refsOf(store.get(db, Number(id)));
  }

  /** 重钉一张被引用卡到它当前的说明(操作者)。 */
  function repin(id, card, by = "operator") {
    const row = db.prepare("SELECT * FROM task_refs WHERE task_id=? AND card=?").get(Number(id), Number(card));
    if (!row) throw err(ERR.NOT_FOUND, `#${id} 没有引用 #${card}`);
    const cur = current(card);
    if (!cur) throw err(ERR.NOT_FOUND, `被引用卡 #${card} 不存在`);
    if (cur.hash === row.pinned_hash) return { changed: false, card: Number(card), pinned: { version: cur.version, hash: cur.hash } };
    db.prepare("UPDATE task_refs SET pinned_version=?, pinned_hash=?, by_=?, at=? WHERE task_id=? AND card=?").run(cur.version, cur.hash, String(by), now(), Number(id), Number(card));
    event(id, "ref.repinned", by, { card: Number(card), from: Number(row.pinned_version), to: cur.version });
    return { changed: true, card: Number(card), pinned: { version: cur.version, hash: cur.hash } };
  }

  const reviewRowOf = (cardId) => db.prepare("SELECT * FROM spec_review_cards WHERE card=?").get(Number(cardId)) || null;
  const isReviewCard = (id) => !!reviewRowOf(id);

  /** 任务对象的 refs:[{card, title, pinned, current, stale, review, review_skipped?}]。 */
  function refsOf(t) {
    if (!t) return [];
    return rowsOf(t.id).map((r) => {
      const s = store.get(db, Number(r.card)), cur = current(r.card);
      const out = { card: Number(r.card), title: s ? clean(s.subject, 60) : null, pinned: { version: Number(r.pinned_version), hash: r.pinned_hash },
                    current: cur ? { version: cur.version, hash: cur.hash } : null, stale: !cur || cur.hash !== r.pinned_hash, review: !!r.review };
      if (r.review && s && (s.line ?? null) === (t.line ?? null)) out.review_skipped = "same_line";
      return out;
    });
  }
  const staleOf = (t) => refsOf(t).filter((r) => r.stale).map((r) => ({ card: r.card, pinned: r.pinned.version, current: r.current?.version ?? null }));

  /** 领卡闸(经 store.registerClaimCheck 登记):未开始的引用方有引用过期 → REF_STALE(要本人裁定)。 */
  function claimCheck(t) {
    if (!t || t.status !== "not_started" || t.archived_at) return null;
    const st = staleOf(t);
    if (!st.length) return null;
    const f = st[0];
    return { code: "REF_STALE", attention: "decide", detail: { refs: st }, related: st.map((x) => x.card),
             message: `引用的 #${f.card} 说明已改(钉 v${f.pinned} · 现 v${f.current ?? "?"})${st.length > 1 ? ` 等 ${st.length} 张` : ""}`,
             why: `#${t.id} 引用的 #${st.map((x) => x.card).join(" #")} 说明在钉之后改过 —— 先看新版,重钉或改引用后再领`,
             next_action: "看过新版说明后重钉,或改引用" };
  }
  /** 执行中心跳的附加应答。 */
  function heartbeatExtra(t) {
    const st = t && t.status === "in_progress" ? staleOf(t) : [];
    return st.length ? { refs_stale: st, next: `规格已改:引用的 #${st.map((x) => x.card).join(" #")} 说明变了,先读新版(get_card 被引用的卡)` } : {};
  }

  /** 交付(report)时记这一轮是否基于过期引用。只记有引用的卡。 */
  function onDelivery(t, runId, outcome) {
    if (!t || !runId || outcome !== "done") return null;
    const rs = refsOf(t);
    if (!rs.length) return null;
    const st = rs.filter((r) => r.stale).map((r) => r.card);
    db.prepare("INSERT INTO ref_runs(task_id, run_id, stale, cards_json, at) VALUES(?,?,?,?,?) ON CONFLICT(task_id, run_id) DO UPDATE SET stale=excluded.stale, cards_json=excluded.cards_json, at=excluded.at")
      .run(Number(t.id), String(runId), st.length ? 1 : 0, JSON.stringify(st), now());
    if (st.length) event(t.id, "ref.stale_delivery", "system", { run_id: String(runId), cards: st });
    return { stale: st.length > 0, cards: st };
  }
  const deliveryOf = (t) => (t?.run_id ? db.prepare("SELECT * FROM ref_runs WHERE task_id=? AND run_id=?").get(Number(t.id), String(t.run_id)) : null);
  const basedOnStaleRef = (t) => Number(deliveryOf(t)?.stale) === 1;
  /** 自动通过闸的附加缺口(只对带 refs 的卡):交付基于过期引用。 */
  function gateMissing(t) {
    if (!t || !rowsOf(t.id).length) return [];
    const d = deliveryOf(t);
    if (!d || Number(d.stale) !== 1) return [];
    let cards = []; try { cards = JSON.parse(d.cards_json); } catch {}
    return [`交付时引用的 #${cards.join(" #")} 说明已改,这次照的是旧版(based_on_stale_ref)`];
  }

  /** 持卡执行者能不能读这张被引用卡:它此刻持有(执行中)一张引用了它的卡。 */
  const readableBy = (executorId, cardId) => !!db.prepare(`SELECT 1 FROM task_refs r JOIN tasks t ON t.id=r.task_id
    WHERE r.card=? AND t.status='in_progress' AND t.worker=? AND t.archived_at IS NULL LIMIT 1`).get(Number(cardId), String(executorId));
  /** 被引用卡给持卡执行者看的那几项。 */
  const refView = (s) => ({ id: Number(s.id), subject: s.subject, description: s.description ?? "", acceptance: s.acceptance ?? "",
                            spec_version: current(s.id)?.version ?? null, ref_view: true, content_is_untrusted: true });

  // ── 复审结论 ──────────────────────────────────────────────────────────────────────
  function resultsOf(xId) {
    return db.prepare("SELECT * FROM spec_review_results WHERE x=? ORDER BY at, by_card").all(Number(xId));
  }
  const freshOf = (r, xId) => r.digest === cred.currentDigest(xId) && Number(r.s_version) === Number(current(r.s)?.version);
  /** X 的 spec_review(最近一条)+ 每个 S 的最近一条是否仍有效(给 flags 用)。 */
  function reviewFields(t) {
    const all = resultsOf(t.id);
    if (!all.length) return { spec_review: null, flags: [] };
    const last = all[all.length - 1];
    const perS = new Map(); for (const r of all) perS.set(Number(r.s), r);
    const flags = new Set();
    for (const r of perS.values()) if (freshOf(r, t.id)) { if (r.verdict === "conform") flags.add("spec_reviewed"); else if (r.verdict === "deviates") flags.add("spec_deviation"); }
    return { spec_review: { verdict: last.verdict, by_card: Number(last.by_card), spec: { card: Number(last.s), version: Number(last.s_version) }, digest: last.digest,
                            stale: !freshOf(last, t.id), at: last.at }, flags: [...flags] };
  }
  /** X 待验收且有有效的 deviates 结论 → 一条进「要本人做的事」的阻塞(I11:attention 字段;面板按通用规则走)。 */
  function reviewBlockers(t) {
    if (!t || t.status !== "waiting" || t.waiting_for !== "review") return [];
    const all = resultsOf(t.id), perS = new Map(); for (const r of all) perS.set(Number(r.s), r);
    const dev = [...perS.values()].filter((r) => r.verdict === "deviates" && freshOf(r, t.id));
    if (!dev.length) return [];
    const r = dev[0];
    return [{ code: "SPEC_DEVIATION", action: "review", attention: "decide", related_task_ids: dev.map((x) => Number(x.by_card)),
              detail: { by_card: Number(r.by_card), spec: { card: Number(r.s), version: Number(r.s_version) } },
              message: `复审卡 #${r.by_card} 判定这次交付与 #${r.s} 说明 v${r.s_version} 不符`, next_action: "看复审结论后通过或打回" }];
  }
  /** 第 8 波第二轮(8f):有效(没过期)的「与规格不符」结论 → 自动通过闸的缺口,一条一张复审卡;经可信核心的 registerGate 登记。
   *  本人显式裁定不受限(闸只管自动通过),确认处照列。 */
  function deviationMissing(t) {
    if (!t) return [];
    const perS = new Map(); for (const r of resultsOf(t.id)) perS.set(Number(r.s), r);
    return [...perS.values()].filter((r) => r.verdict === "deviates" && freshOf(r, t.id))
      .map((r) => `复审卡 #${r.by_card} 判这次交付与 #${r.s} 说明 v${r.s_version} 不符(spec_deviation)`);
  }
  /** 复审卡任务对象的 review_of。 */
  function reviewOf(t) {
    const r = t ? reviewRowOf(t.id) : null;
    return r ? { card: Number(r.x), digest: r.digest, spec: { card: Number(r.s), version: Number(r.s_version) } } : null;
  }

  // ── 自动规则(登记在 autocards.mjs 的 RULES)─────────────────────────────────────────
  /** 引用过期 → 事件 ref.stale(〔引用方, 被引用卡, 版本(哈希)〕一次)+ 引用方卡历史一条。 */
  async function sweepStale() {
    const rows = db.prepare("SELECT r.* FROM task_refs r JOIN tasks t ON t.id=r.task_id WHERE t.archived_at IS NULL").all();
    for (const r of rows) {
      const cur = current(r.card);
      if (!cur || cur.hash === r.pinned_hash) continue;
      const ins = db.prepare("INSERT OR IGNORE INTO ref_stale_seen(task_id, card, version, hash, at) VALUES(?,?,?,?,?)").run(Number(r.task_id), Number(r.card), cur.version, cur.hash, now());
      if (!ins.changes) continue;
      event(r.task_id, "ref.stale", "system", { card: Number(r.card), pinned: Number(r.pinned_version), current: cur.version });
      emit("ref.stale", { id: Number(r.task_id), card: Number(r.card), pinned: Number(r.pinned_version), current: cur.version });
    }
  }
  function kidChecks(xId) {
    const f = cred.fields(store.get(db, Number(xId)));
    const cur = (f.checks || []).filter((c) => !c.stale);
    const last = (pick) => { const m = new Map(); for (const c of cur) if (pick(c.by)) m.set(c.name, c); return [...m.values()].map((c) => ({ name: c.name, status: c.status })); };
    return { fp: f.fingerprint, verified: last((b) => b === "board" || b === "reviewer"), self: last((b) => b === "executor") };
  }
  /** 引用方交付 → 复审卡;复审卡验收通过 → 给引用方记结论。 */
  async function sweepReviews() {
    const rows = db.prepare(`SELECT r.task_id, r.card FROM task_refs r JOIN tasks t ON t.id=r.task_id
      WHERE r.review=1 AND t.archived_at IS NULL AND (t.status='done' OR (t.status='waiting' AND t.waiting_for='review'))`).all();
    for (const r of rows) {
      const x = store.get(db, Number(r.task_id)), s = store.get(db, Number(r.card));
      if (!x || !s || s.archived_at) continue;
      if ((s.line ?? null) === (x.line ?? null)) continue;                     // 同线不出(review_skipped:"same_line")
      if (typeof store.supersededBy === "function" && store.supersededBy(db, Number(x.id)) != null) continue;   // 被取代的卡不出
      if (isReviewCard(x.id)) continue;                                         // 复审卡自己不再派生复审卡
      const D = cred.currentDigest(x.id);
      if (!D) continue;
      if (db.prepare("SELECT 1 FROM spec_review_cards WHERE x=? AND s=? AND digest=?").get(Number(x.id), Number(s.id), D)) continue;
      const sv = current(s.id)?.version ?? 1;
      const { fp, verified, self } = kidChecks(x.id);
      const refStale = staleOf(x).some((q) => q.card === Number(s.id));
      const card = composeReview({ x: { id: Number(x.id), title: clean(x.subject, 60), line: x.line ?? null }, s: { id: Number(s.id), title: clean(s.subject, 60), line: s.line ?? null },
                                   sVersion: sv, fp, verified, self, refStale });
      const prev = db.prepare("SELECT * FROM spec_review_cards WHERE x=? AND s=? AND card IS NOT NULL ORDER BY id DESC LIMIT 1").get(Number(x.id), Number(s.id));
      const pt = prev ? store.get(db, Number(prev.card)) : null;
      if (pt && !pt.archived_at && pt.status === "not_started") {
        // 旧复审卡还没开始:重拼说明、改指到这次的 digest(放行后改说明照常 spec_version +1)。
        try {
          afterEdit(pt.id, null);
          if (pt.description !== card.description || pt.subject !== card.subject)
            store.update(db, { id: pt.id, subject: card.subject, description: card.description, expectedVersion: pt.aggregate_version, actor: "rule" });
          db.prepare("UPDATE spec_review_cards SET digest=?, s_version=?, at=? WHERE id=?").run(D, sv, now(), prev.id);
          afterEdit(pt.id, "system");
          emit("task.updated", { id: Number(pt.id), auto_kind: "spec_review" });
          log(`#${x.id} 又交付了:重拼未开始的复审卡 #${pt.id} 的说明`);
        } catch (e) { log(`复审卡 #${pt.id} 的说明没能重拼:${String(e?.message || e).split("\n")[0].slice(0, 160)}`); }
        continue;
      }
      const claim = db.prepare("INSERT OR IGNORE INTO spec_review_cards(card, x, s, digest, s_version, at) VALUES(NULL,?,?,?,?,?)").run(Number(x.id), Number(s.id), D, sv, now());
      if (!claim.changes) continue;
      const rid = Number(claim.lastInsertRowid);
      try {
        const id = store.add(db, { subject: card.subject, description: card.description, acceptance: card.acceptance, kind: "task",
                                   ...(x.parent_id != null ? { parentId: Number(x.parent_id) } : {}), line: s.line ?? null, released: 0, actor: "rule" });
        db.prepare("UPDATE spec_review_cards SET card=?, result='ok' WHERE id=?").run(id, rid);
        event(x.id, "spec_review.created", "rule", { card: id, spec: { card: Number(s.id), version: sv }, digest: D });
        emit("task.created", { id, auto_kind: "spec_review" });
        log(`#${x.id} 交付了:出复审卡 #${id}(对照 #${s.id} 说明 v${sv};未放行)`);
      } catch (e) {
        db.prepare("UPDATE spec_review_cards SET result=? WHERE id=?").run("failed: " + String(e?.message || e).split("\n")[0].slice(0, 200), rid);
        log(`#${x.id} 的复审卡没建成:${String(e?.message || e).split("\n")[0].slice(0, 160)}`);
      }
    }
    // 复审卡验收通过(done)→ 给 X 记结论(每张复审卡一次)。
    const done = db.prepare(`SELECT c.* FROM spec_review_cards c JOIN tasks t ON t.id=c.card
      WHERE t.status='done' AND NOT EXISTS (SELECT 1 FROM spec_review_results r WHERE r.by_card=c.card)`).all();
    for (const c of done) {
      const f = cred.fields(store.get(db, Number(c.card)));
      const hit = (f.checks || []).filter((k) => !k.stale && k.name === CONFORMANCE_CHECK).pop();
      const verdict = hit?.status === "pass" ? "conform" : hit?.status === "fail" ? "deviates" : "unknown";
      const ins = db.prepare("INSERT OR IGNORE INTO spec_review_results(by_card, x, s, s_version, digest, verdict, at) VALUES(?,?,?,?,?,?,?)")
        .run(Number(c.card), Number(c.x), Number(c.s), Number(c.s_version), c.digest, verdict, now());
      if (!ins.changes) continue;
      event(c.x, "spec.reviewed", "rule", { by_card: Number(c.card), verdict, spec: { card: Number(c.s), version: Number(c.s_version) } });
      emit("task.updated", { id: Number(c.x) });
      log(`复审卡 #${c.card} 验收通过:#${c.x} 对照 #${c.s} 说明 v${c.s_version} = ${verdict}`);
    }
  }

  /** 任务对象上的字段(引用方 refs / based_on_stale_ref;复审卡 review_of;X 的 spec_review)与给徽标的 flags。 */
  function fields(t) {
    const refs = refsOf(t), rv = reviewFields(t);
    const flags = [...rv.flags];
    const stale = refs.length ? basedOnStaleRef(t) : false;
    if (stale) flags.push("based_on_stale_ref");
    return { refs, based_on_stale_ref: stale, review_of: reviewOf(t), spec_review: rv.spec_review, flags };
  }

  return { migrate, normRefs: (v) => normRefs(v, { err, ERR }), set, repin, pinsOf, refsOf, staleOf, claimCheck, heartbeatExtra, onDelivery,
           basedOnStaleRef, gateMissing, deviationMissing, readableBy, refView, isReviewCard, reviewOf, reviewFields, reviewBlockers, fields, sweepStale, sweepReviews };
}
