import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 第 8 波第二轮面板(8f,合同 I10f)与四件后端小项。`node --test tests/panelround2test.mjs`
//   面板(纯函数,从 panel.html 切出来跑):引用「引用 #S · 钉 vN」/ 过期 /「交付后出复审卡」、复审卡标签与 review_of、spec_review(一致 / 不符 / 未判 / 过期)、
//     底提交(在 / 不在了 / 分叉了 / 未核 · 落后 n)、卡死(四种 kind 各一句 + 最近几步)、包(六格流水线 / drift / 「我跑完了」出不出 / 卡面一个弱标记)、
//     环境差(目标环境 / 验证跑在别处 / 差异小表)、徽标新标记与 ⓘ、确认处缺口、按钮字「重钉」「清零继续」按码取而类型仍来自 attention、
//     首页包条目、流转条 has_options、首页一句话 waiting_dep 拼卡号;写入口只走操作者接口(源码核对)。
//   后端:①未放行的自动出卡不计入目标结案(放行后照常计);②复审判「不符」进自动通过闸(经 cred.registerGate,本人显式裁定不受限);
//     ③流转条目带 has_options;④审阅座席写的包核对项在卡历史里写成审阅座席核过;⑤目标组头「执行 n/m」不数看板自动出的卡。
//   不调用任何模型;临时看板的数据目录、工作仓都在临时目录里,会话目录指向空的假目录。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { freePort } from "./helpers/free-port.mjs";

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const store = require(join(ROOT, "core", "store.js"));
const conversations = require(join(ROOT, "core", "conversations.js"));
const decision = require(join(ROOT, "core", "decision_lib.js"));
const F = await import(pathToFileURL(join(ROOT, "core", "flow.mjs")).href);
const source = readFileSync(new URL("../core/panel.html", import.meta.url), "utf8");
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `未找到面板测试边界:${start}`);
  return source.slice(source.indexOf("\n", a) + 1, b);
}
const H = new Function(section("// ── home-model(pure;tests/hometest.mjs)──", "// ── /home-model ──") + ";return { homeLists, homeStep, homeAttnType };")();
const BG = new Function(section("// ── bg-copy(pure;tests/panelcopytest.mjs)──", "// ── /bg-copy ──") + ";return { bgOneLineText, bgReleaseOnText };")();
const CRED = new Function(section("// ── cred-copy(pure;tests/panelcopytest.mjs)──", "// ── /cred-copy ──") + ";return { credGaps, credFlags, credBadge };")();
const FLOW = new Function(section("// ── flow-copy(pure;tests/panelcopytest.mjs)──", "// ── /flow-copy ──") + ";return { flowPhrase };")();
const REL = new Function("bgReleaseOnText", section("// ── rel-copy(pure;tests/panelreltest.mjs)──", "// ── /rel-copy ──") +
  ";return { relMarks, r2RefMark, r2ReviewOfText, r2SpecReview, r2BaseText, r2StuckText, r2StuckSteps, r2PkgMark, r2PkgCells, r2PkgDrift, r2CanRan, r2PkgRanText," +
  " r2EnvMark, r2EnvRows, r2Marks, r2AttnVerb, r2DeviationLine, r2PkgAttnRows, r2PkgDetailRows, r2RefsBody };")(BG.bgReleaseOnText);
/** 只切出一个函数来跑(常量都在函数里,所以单独也能跑)。 */
const lone = (name) => { const a = source.indexOf("function " + name + "("), b = source.indexOf("\n}", a); return new Function(source.slice(a, b + 2) + ";return " + name + ";")(); };

const TMP = mkdtempSync(join(tmpdir(), "panelround2-")), dbs = [];
after(() => { for (const db of dbs) { try { db.close(); } catch {} } rmSync(TMP, { recursive: true, force: true }); });
const until = async (fn, ms = 15000, step = 150) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v || Date.now() > end) return v; await delay(step); } };

// ── 面板纯函数 ─────────────────────────────────────────────────────────────────────────────────────
test("引用:「引用 #S · 钉 vN」、过期「现 vM · 已过期」、review 写「交付后出复审卡」、same_line 说明进 tip;关系标记三处同一份", () => {
  const ok = REL.r2RefMark({ card: 3, title: "规格", pinned: { version: 2, hash: "a" }, current: { version: 2, hash: "a" }, stale: false, review: false });
  assert.deepEqual([ok.key, ok.card, ok.text, ok.tone], ["ref", 3, "引用 #3 · 钉 v2", ""]);
  const st = REL.r2RefMark({ card: 3, pinned: { version: 2 }, current: { version: 4 }, stale: true, review: true });
  assert.equal(st.text, "引用 #3 · 钉 v2 · 现 v4 · 已过期 · 交付后出复审卡");
  assert.equal(st.tone, "warn"); assert.match(st.tip, /重钉/);
  const same = REL.r2RefMark({ card: 5, pinned: { version: 1 }, current: { version: 1 }, stale: false, review: true, review_skipped: "same_line" });
  assert.equal(same.text, "引用 #5 · 钉 v1", "同线不出复审卡:正文不写「交付后出复审卡」");
  assert.match(same.tip, /同一条线/);
  assert.equal(REL.r2RefMark({ card: "x" }), null);
  const marks = REL.relMarks({ id: 9, refs: [{ card: 3, pinned: { version: 1 }, current: { version: 2 }, stale: true, review: false }] });
  assert.deepEqual(marks.map((m) => [m.key, m.text, m.card]), [["ref", "引用 #3 · 钉 v1 · 现 v2 · 已过期", 3]]);
  // 单独切出来也能跑(常量不在函数外)
  assert.equal(lone("r2RefMark")({ card: 7, pinned: { version: 1 }, stale: false }).text, "引用 #7 · 钉 v1");
});

test("复审卡:标签「对照规格复审 · 板出的」、review_of 写明复审哪张卡的哪次交付对照哪张卡第几版;被复审的卡 spec_review 一致 / 不符 / 未判 / 过期", () => {
  const ro = { card: 12, digest: "d".repeat(64), spec: { card: 3, version: 2 } };
  assert.equal(REL.r2ReviewOfText(ro), "复审 #12 交付 dddddddd · 对照 #3 说明 v2");
  const m = REL.r2Marks({ id: 20, auto_kind: "spec_review", review_of: ro });
  assert.equal(m[0].key, "spec_review_card"); assert.equal(m[0].text, "对照规格复审 · 板出的"); assert.match(m[0].tip, /复审 #12 交付 dddddddd/);
  assert.equal(REL.r2Marks({ id: 21, auto_kind: "pin" })[0].text, "核对卡 · 板出的");
  const sr = (verdict, stale) => REL.r2SpecReview({ verdict, by_card: 20, spec: { card: 3, version: 2 }, digest: "e".repeat(64), stale });
  assert.deepEqual([sr("conform", false).text, sr("deviates", false).text, sr("unknown", false).text, sr("deviates", true).text],
    ["对照规格 · 一致", "对照规格 · 不符", "对照规格 · 未判", "对照规格 · 不符 · 已过期"]);
  assert.equal(sr("deviates", false).tone, "warn"); assert.equal(sr("deviates", true).tone, "quiet");
  // 有效的一致 / 不符走徽标标记(不在关系标记里重复);过期或未判在关系标记里写
  const keys = (x) => REL.r2Marks({ id: 12, spec_review: { verdict: x.v, by_card: 20, spec: { card: 3, version: 2 }, stale: x.s } }).map((k) => k.key);
  assert.deepEqual([keys({ v: "deviates", s: false }), keys({ v: "deviates", s: true }), keys({ v: "unknown", s: false })], [[], ["spec_review"], ["spec_review"]]);
  const fl = CRED.credFlags({ badge: { level: "self_reported", flags: ["spec_reviewed", "spec_deviation", "based_on_stale_ref", "base_differs"] },
    spec_review: { verdict: "deviates", by_card: 20, spec: { card: 3, version: 2 } }, refs: [{ card: 3, stale: true }] });
  assert.deepEqual(fl.map((f) => f.text), ["对照规格复审 · 一致", "复审判与规格不符", "照的是过期的引用", "交付的底与卡上的不同"]);
  assert.match(fl[2].tip, /#3/);
});

test("底提交三态 + 未核 + 落后;卡死四种 kind 各一句与最近几步", () => {
  const b = (state, behind = null, onto = "refs/heads/main") => REL.r2BaseText({ commit: "ABCDEF1234", onto, state, behind });
  assert.deepEqual([b("ok").text, b("missing").text, b("diverged").text, b("unknown").text, b("ok", 3).text, b("ok", 999).text],
    ["底 abcdef1 · 在", "底 abcdef1 · 不在了", "底 abcdef1 · 分叉了", "底 abcdef1 · 未核", "底 abcdef1 · 在 · 落后 3", "底 abcdef1 · 在 · 落后 999+"]);
  assert.deepEqual([b("missing").tone, b("diverged").tone, b("unknown").tone, b("ok").tone], ["warn", "warn", "quiet", ""]);
  assert.equal(REL.r2BaseText({ commit: "zz" }), null);
  assert.deepEqual(["reaped", "handed_back", "failed", "same_reason"].map((k) => REL.r2StuckText({ kind: k, count: 3 })),
    ["卡死 · 连续 3 次被回收（租约过期）", "卡死 · 连续 3 次被退回", "卡死 · 连续 3 次交回没做完", "卡死 · 连续 3 次以同一原因停下"]);
  assert.deepEqual(REL.r2StuckSteps({ last: [{ at: "t1", kind: "failed", reason_code: "env_broken" }, { at: "t2", kind: "reaped", reason_code: null }] }),
    [{ at: "t1", text: "交回没做完 · 原因码 env_broken" }, { at: "t2", text: "租约过期被回收" }]);
  const m = REL.r2Marks({ id: 1, stuck: { kind: "reaped", count: 3, last: [] }, base: { commit: "abcdef1", state: "missing" } });
  assert.deepEqual(m.map((x) => [x.key, x.tone]), [["base", "warn"], ["stuck", "warn"]]);
});

test("包:六格流水线(已提交可空着、drift 停在哪一格之前、跑失败、钉住 n/N 已核 a / 自报 b)、drift 一句话、「我跑完了」出不出、卡面一个弱标记", () => {
  const cells = (p) => REL.r2PkgCells(p).map((c) => c.state);
  assert.deepEqual(cells({ state: "draft", pinned: { n: 0, total: 0 } }), ["done", "todo", "todo", "todo", "todo", "skip"]);
  assert.deepEqual(cells({ state: "issued", commit: null, issued: { match: true }, pinned: { n: 0, total: 2 } }), ["done", "done", "skip", "done", "todo", "todo"], "没报提交也能出包:已提交那格空着");
  const drift = { state: "frozen", drift: true, drift_detail: { before: "issued", step: "issue", why: "出包后的文件和预审时不一样,先别跑" },
                  issued: { match: false, diff: ["a.sql"], missing: ["b.sql"] }, pinned: { n: 0, total: 0 } };
  assert.deepEqual(cells(drift), ["done", "done", "todo", "drift", "todo", "skip"], "停在出包之前:已提交没到(todo),出包那格标对不上");
  assert.equal(REL.r2PkgDrift(drift), "停在「出包」之前 · 出包对不上：出包后的文件和预审时不一样,先别跑（a.sql、b.sql（缺））");
  assert.deepEqual(cells({ state: "ran", commit: { sha: "a" }, issued: { match: true }, ran: { result: "failed" }, pinned: { n: 0, total: 1 } }), ["done", "done", "done", "done", "fail", "todo"]);
  const pinned = REL.r2PkgCells({ state: "pinned", commit: { sha: "a" }, issued: { match: true }, ran: { result: "ok" }, pinned: { n: 2, total: 2, verified: 1, self: 1 } });
  assert.equal(pinned[5].label, "钉住 2/2（已核 1 / 自报 1）");
  assert.deepEqual([REL.r2CanRan({ issued: { match: true } }), REL.r2CanRan({ issued: { match: false } }), REL.r2CanRan({ issued: { match: true }, ran: { result: "ok" } }),
                    REL.r2CanRan({ issued: { match: true }, drift: true }), REL.r2CanRan({})], [true, false, false, false, false]);
  assert.equal(REL.r2PkgRanText({ ran: { result: "ok", note: "在测试机跑的" } }), "本人跑过 · 成功 · 在测试机跑的");
  const mark = REL.r2PkgMark({ packages: [{ name: "迁移", state: "issued", drift: false, pinned: { n: 0, total: 1 } }, { name: "回滚", state: "frozen", drift: true, pinned: { n: 0, total: 0 } }] });
  assert.equal(mark.text, "包 2 · 待你跑 1 · 对不上 1"); assert.equal(mark.tone, "warn");
  assert.equal(REL.r2PkgMark({ packages: [] }), null);
  assert.deepEqual(CRED.credGaps({ id: 1, package_gaps: ["包「迁移」还没跑(停在「已出包」)"] }), ["包「迁移」还没跑(停在「已出包」)"], "package_gaps 原文进确认处");
});

test("环境差:目标环境 / 验证跑在别处 / 在这里验过;差异小表(对方报的);not_target_env 进徽标 ⓘ", () => {
  const base = { target_env: "测试机", env_diff: { by: "executor", items: [{ key: "node", here: "24", target: "22" }], at: "t" } };
  assert.equal(REL.r2EnvMark({ ...base, env_gap: { target: "测试机", verified_in: ["本机"], same: false } }).text, "目标环境 测试机 · 验证跑在 本机，不是目标环境 · 差 1 项");
  assert.equal(REL.r2EnvMark({ ...base, env_gap: { target: "测试机", verified_in: ["测试机"], same: true } }).text, "目标环境 测试机 · 在这里验过");
  assert.equal(REL.r2EnvMark({ target_env: "测试机", env_gap: { same: null } }).text, "目标环境 测试机");
  assert.equal(REL.r2EnvMark({ env_gap: { same: false } }), null, "没写目标环境不画");
  assert.deepEqual(REL.r2EnvRows(base), [{ key: "node", here: "24", target: "22" }]);
  const b = CRED.credBadge({ target_env: "测试机", env_gap: { verified_in: ["本机"] }, badge: { level: "machine_verified", flags: ["not_target_env"], provenance: [] } });
  assert.ok(b.tip.includes("验证不是在目标环境「测试机」里跑的（跑在 本机）"), b.tip);
  assert.ok(!CRED.credFlags({ badge: { level: "machine_verified", flags: ["not_target_env"] } }).length, "not_target_env 不另画标记,只进 ⓘ");
});

test("确认处缺口:照的是过期引用、复审判不符(没过期才列)、包的缺口;按钮字按码取「重钉」「清零继续」,类型仍来自 attention", () => {
  const t = { id: 4, based_on_stale_ref: true, refs: [{ card: 3, stale: true, pinned: { version: 1 }, current: { version: 2 } }],
              spec_review: { verdict: "deviates", by_card: 20, spec: { card: 3, version: 2 }, stale: false }, package_gaps: ["包「迁移」钉住 0/1"] };
  assert.deepEqual(CRED.credGaps(t), ["交付时引用的说明已改，照的是旧版：#3（钉 v1 · 现 v2）", "复审卡 #20 判这次交付与 #3 说明 v2 不符", "包「迁移」钉住 0/1"]);
  assert.ok(!CRED.credGaps({ ...t, based_on_stale_ref: false, package_gaps: [], spec_review: { ...t.spec_review, stale: true } }).length, "过期的不符不列");
  const B = (code, attention) => ({ code, attention, message: code + " 原因", next_action: code + " 的下一步要做的事" });
  const tasks = [{ id: 1, subject: "a", kind: "task", status: "not_started", released: 1, updated_at: "1", hb: "", progress_blockers: [B("REF_STALE", "decide")] },
                 { id: 2, subject: "b", kind: "task", status: "not_started", released: 1, updated_at: "2", hb: "", progress_blockers: [B("STUCK", "decide")] },
                 { id: 3, subject: "c", kind: "task", status: "not_started", released: 1, updated_at: "3", hb: "", progress_blockers: [B("BASE_GONE", "fault")] }];
  const { mine } = H.homeLists({ tasks });
  const got = mine.map((r) => [r.localId, r.type, REL.r2AttnVerb(tasks.find((x) => x.id === r.localId), r.verb)]);
  assert.deepEqual(got, [[1, "decide", "重钉"], [2, "decide", "清零继续"], [3, "fault", "查看"]]);
  assert.equal(REL.r2AttnVerb({ ...tasks[0], status: "waiting" }, "验收"), "验收", "不是未开始的卡不换字");
  assert.equal(lone("r2AttnVerb")(tasks[1], "去裁定"), "清零继续");
  assert.equal(REL.r2DeviationLine({ progress_blockers: [{ code: "SPEC_DEVIATION", detail: { by_card: 20, spec: { card: 3, version: 2 } } }] }), "复审卡 #20 判这次交付与 #3 说明 v2 不符");
  assert.equal(REL.r2DeviationLine({ progress_blockers: [] }), null);
});

test("首页包条目:照接口 attention 的 package / detail 显示,类型与动词照接口给的;展开区 what / where / expect(对方写的)/ 解锁", () => {
  const att = [{ kind: "decision", task_id: 4, title: "跑包「迁移」", since: "s", package_id: 7, type: "hands", verb: "去做",
                 package: { id: 7, name: "迁移", frozen: "abc" }, detail: { what: "跑包「迁移」", where: "共享盘「发布」里今天那份", expect: "表多一列", expect_by: "executor", unlocks: [{ id: 9, title: "下游" }], unlocks_total: 1 } },
               { kind: "blocked", task_id: 4, title: "包「回滚」出包后的文件和预审时不一样,先别跑", package_id: 8, type: "fault", verb: "查看", package: { id: 8, name: "回滚" }, detail: { what: "出包后的文件和预审时不一样,先别跑" } },
               { kind: "review", task_id: 5, title: "别的卡", type: "accept" }];
  const rows = REL.r2PkgAttnRows(att);
  assert.deepEqual(rows.map((r) => [r.key, r.localId, r.type, r.verb, r.state]), [["pkg:7", 4, "hands", "去做", "出包了 · 待你亲手跑"], ["pkg:8", 4, "fault", "查看", "出包后对不上 · 先别跑"]]);
  assert.deepEqual(REL.r2PkgDetailRows(att[0].detail), [["做什么", "跑包「迁移」"], ["实物在哪", "共享盘「发布」里今天那份"], ["期待看到什么（对方写的）", "表多一列"], ["做完解锁", "#9 下游"]]);
});

test("流转条:has_options:false =「审阅已过 · 自动通过被拦 · 待你验收」(读不到判通过的结论 =「审阅看过 · 待你验收」);有方案照旧;首页一句话 waiting_dep 拼卡号", () => {
  const item = { id: 3, status: "waiting", waiting_for: "confirm", has_options: false };
  assert.equal(FLOW.flowPhrase(item, undefined, { conclusions: [{ kind: "review", verdict: "approve", stale: false }] }).text, "审阅已过 · 自动通过被拦 · 待你验收");
  assert.equal(FLOW.flowPhrase(item).text, "审阅看过 · 待你验收");
  assert.equal(FLOW.flowPhrase({ ...item, has_options: true }).text, "待你选择方案");
  assert.equal(FLOW.flowPhrase({ id: 3, status: "waiting", waiting_for: "confirm" }).text, "待你选择方案", "旧服务端没有这个字段:照旧");
  assert.equal(BG.bgOneLineText({ kind: "waiting", code: "waiting_dep", params: { ids: [3, 4] } }), "等 #3、#4 做完后才会被领");
  assert.equal(BG.bgOneLineText({ kind: "waiting", code: "waiting_dep", params: {} }), "依赖做完后才会被领");
});

test("写入口只走操作者接口:重钉 / 清零 / 引用 / 底提交 / 目标环境 / 我跑完了;首页一行不发写请求;对话框的引用一项 ≤8、覆盖式", () => {
  for (const p of ['"/refs/repin"', '"/stuck/clear"', 'base + "/refs"', 'base + "/base"', 'base + "/target-env"', '"/api/packages/" + p.id + "/ran"'])
    assert.ok(source.includes(p), p);
  assert.ok(!/\/api\/packages\/[^"]*\/(freeze|commit|issue|pin)"/.test(source), "面板不碰执行者的包接口");
  const attn = source.slice(source.indexOf("function bgAttnRow("), source.indexOf("\n}", source.indexOf("function bgAttnRow(")));
  assert.ok(!/fetch\(|relPost\(|chatApi\(/.test(attn), "要本人做的事这一行不发写请求");
  assert.deepEqual(REL.r2RefsBody([{ card: "#3", review: true }, { card: "4" }, { card: "" }, { card: "3" }]), { refs: [{ card: 3, review: true }, 4] });
  assert.match(REL.r2RefsBody([{ card: "x" }]).error, /正整数/);
  assert.match(REL.r2RefsBody(Array.from({ length: 9 }, (_, i) => ({ card: String(i + 1) }))).error, /最多 8/);
  assert.ok(source.includes('id="stuck-after"') && source.includes('"/api/home/prefs", { stuck_after:'), "设置页「连续几次算卡死」走 /api/home/prefs");
});

// ── 后端小项(库层)────────────────────────────────────────────────────────────────────────────────────
function memory(t, opts = {}) {
  const db = new DatabaseSync(":memory:"); store.migrate(db); conversations.migrate(db); dbs.push(db);
  const flow = F.createFlow({ db, lines: () => ["alpha"], coalesceMs: 50, ...opts });
  t.after(() => flow.stop());
  return { db, flow };
}
test("③ 流转条目带 has_options:等你确认而没有方案包 = false(进度一句写「审过被拦,待验收」);有方案包 = true;别的状态不带", (t) => {
  const { db, flow } = memory(t, { hasOptions: (x) => !!decision.normalizeDecisionPackage(x.decision_json, x.verdict_note)?.options?.length });   // 与 server 注入的同一判法
  const goal = store.add(db, { subject: "目标", kind: "goal", released: 1, actor: "operator" });
  const a = store.add(db, { subject: "审过被拦", parentId: goal, line: "alpha", released: 1, actor: "operator" });
  const b = store.add(db, { subject: "要选方案", parentId: goal, line: "alpha", released: 1, actor: "operator" });
  const c = store.add(db, { subject: "在做", parentId: goal, line: "alpha", released: 1, actor: "operator" });
  const pkg = JSON.stringify({ options: [{ key: "A", title: "甲" }, { key: "B", title: "乙" }] });
  db.prepare("UPDATE tasks SET status='waiting', waiting_for='confirm' WHERE id=?").run(a);
  db.prepare("UPDATE tasks SET status='waiting', waiting_for='confirm', decision_json=? WHERE id=?").run(pkg, b);
  const conv = conversations.create(db, { message: "目标", model: "m", effort: "high" }).conversation.id;
  conversations.markApplied(db, conv, 1, { by: "local", goalId: goal, taskIds: [a, b, c] });
  const p = flow.progressOf(conv), item = (id) => p.items.find((i) => i.id === id);
  assert.equal(item(a).has_options, false); assert.equal(item(b).has_options, true);
  assert.equal(Object.hasOwn(item(c), "has_options"), false, "不在等你确认的不带这个字段");
  const text = flow.progressText(p);
  assert.match(text, new RegExp(`#${a} 审过被拦,待验收`)); assert.match(text, new RegExp(`#${b} 待选择方案`));
});

test("④ 卡历史:审阅座席写的包核对项写成「审阅座席核过…(已核)」,核对卡持卡者报的写「(自报)」,别的步骤照旧", () => {
  const e = (actor, detail) => F.entryOf({ at: "t", kind: "package.changed", actor, detail }, { lines: [], isExecutor: (a) => a === "w1" });
  const rv = e("review", { step: "pin", name: "迁移", pin: "行数", ok: true, verified: true, state: "pinned" });
  assert.equal(rv.summary, "审阅座席核过包「迁移」的「行数」:通过(已核 · 已钉住)");
  assert.ok(!/自动审阅报了/.test(rv.summary));
  assert.equal(e("w1", { step: "pin", name: "迁移", pin: "行数", ok: false, verified: false, state: "ran" }).summary, "w1 报了包「迁移」的「行数」:没通过(自报 · 已跑)");
  assert.equal(e("operator", { step: "ran", name: "迁移", state: "ran" }).summary, "你记下跑完了包「迁移」(已跑)");
});

test("⑤ 目标组头「执行 n/m」:看板自动出的卡不数(候选组装归「整合」段);没注入判定 = 照旧", (t) => {
  const autoIds = new Set();
  const { db, flow } = memory(t, { isAuto: (id) => autoIds.has(Number(id)) });
  const goal = store.add(db, { subject: "目标", kind: "goal", released: 1, actor: "operator" });
  const k = store.add(db, { subject: "子", parentId: goal, released: 1, actor: "operator" });
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(k);
  const asm = store.add(db, { subject: "候选组装:目标", parentId: goal, released: 0, actor: "rule" }); autoIds.add(asm);
  const rv = store.add(db, { subject: "复审", parentId: goal, released: 0, actor: "rule" }); autoIds.add(rv);
  assert.deepEqual(flow.goalCounts(store.get(db, goal)), { children_done: 1, children_total: 1 });
  const plain = memory(t);
  const g2 = store.add(plain.db, { subject: "目标", kind: "goal", released: 1, actor: "operator" });
  store.add(plain.db, { subject: "子", parentId: g2, released: 1, actor: "operator" });
  store.add(plain.db, { subject: "另一张", parentId: g2, released: 0, actor: "rule" });
  assert.deepEqual(plain.flow.goalCounts(store.get(plain.db, g2)), { children_done: 0, children_total: 2 });
});

test("① 库层:登记的跳过判定在完成与重开两边都生效;判不出(抛错)= 照常计", () => {
  const db = new DatabaseSync(":memory:"); store.migrate(db); dbs.push(db);
  const skip = new Set();
  const off = store.registerGoalSkip("test_skip", (r) => { if (r.id === -1) throw Error("x"); return skip.has(Number(r.id)) && !Number(r.released) && r.status === "not_started"; });
  try {
    const goal = store.add(db, { subject: "目标", kind: "goal", released: 1, actor: "operator" });
    const k = store.add(db, { subject: "子", parentId: goal, released: 1, actor: "operator" });
    const a = store.add(db, { subject: "自动出的", parentId: goal, released: 0, actor: "rule" }); skip.add(a);
    db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(k);
    assert.deepEqual(store.completeGoals(db), [goal], "未放行的自动出卡不拖住结案");
    assert.equal(store.get(db, goal).status, "done");
    assert.ok(!store.stuckWhy(db, store.get(db, goal)).some((b) => b.code === "DESCENDANTS_UNFINISHED"));
    db.prepare("UPDATE tasks SET released=1 WHERE id=?").run(a);
    assert.deepEqual(store.completeGoals(db), [-goal], "放行后照常计:目标重开");
    assert.equal(store.get(db, goal).status, "not_started");
  } finally { off(); }
});

// ── 后端小项(临时看板)──────────────────────────────────────────────────────────────────────────────────
async function board() {
  const dir = mkdtempSync(join(tmpdir(), "panelround2test-")), config = join(dir, "fleet.json"), repo = join(dir, "repo");
  mkdirSync(repo); mkdirSync(join(dir, "fake-projects")); mkdirSync(join(dir, "fake-codex"));
  writeFileSync(config, JSON.stringify({ lines: [{ id: "alpha", label: "开发" }, { id: "ext", label: "外部", external: true }, { id: "ext2", label: "外部二", external: true }],
    roles: [], routes: ["default"], repo }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir, BOARD_DB: join(dir, "board.db"),
           BOARD_REPO: repo, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit", BOARD_DELIVERABLE_GATE: "off",
           BOARD_INTEGRATE_SCAN_MS: "300", BOARD_REAP_MS: "400", BOARD_CLAUDE_PROJECTS: join(dir, "fake-projects"), BOARD_CODEX_HOME: join(dir, "fake-codex") } });
  let log = ""; child.stdout.on("data", (d) => { log = (log + d).slice(-40000); }); child.stderr.on("data", (d) => { log = (log + d).slice(-40000); });
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const tok = (n) => readFileSync(join(dir, n), "utf8").trim();
  const operator = tok("board_token"), review = tok("review_token");
  const get = async (id) => (await api("GET", `/api/tasks/${id}`, operator)).body?.task;
  const card = async (subject, line, extra = {}) => {
    const r = await api("POST", "/api/tasks", operator, { subject, ...(line ? { line } : {}), description: "说明", acceptance: "验收", ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.task;
  };
  const connectAs = async (body) => {
    const c = await api("POST", "/api/connect/codes", operator, body); assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await api("POST", "/api/connect/redeem", null, { code: c.body.code }); assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: r.body.executor_id, token: r.body.token };
  };
  const claim = async (id, t) => api("POST", `/api/tasks/${id}/claim`, t, { expected_version: (await get(id)).aggregate_version });
  const report = async (id, t, body) => api("POST", `/api/tasks/${id}/report`, t, { run_id: (await get(id)).run_id, ...body });
  const resolve = async (id, verdict, note) => api("POST", `/api/tasks/${id}/resolve`, operator, { verdict, expected_version: (await get(id)).aggregate_version, allow_uncommitted: true, ...(note ? { note } : {}) });
  const release = async (id) => api("POST", `/api/tasks/${id}/release`, operator, { expected_version: (await get(id)).aggregate_version, released: true });
  const deliver = async (id, t, ev, extra = {}) => {
    const c = await claim(id, t); assert.equal(c.status, 200, JSON.stringify(c.body));
    const r = await report(id, t, { outcome: "done", evidence: ev, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, api, operator, review, get, card, connectAs, claim, report, resolve, release, deliver, stop, log: () => log };
}

test("① 看板:候选组装卡(未放行)不拖住目标结案、组头不数它;放行后照常计 → 目标重开", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });
    const gr = await B.api("POST", "/api/goals", B.operator, { subject: "整合目标", integrate: { target: "refs/heads/main", assemble: true } });
    assert.equal(gr.status, 201, JSON.stringify(gr.body));
    const G = gr.body.task;
    const k = await B.card("子卡", "ext", { parentId: G.id });
    assert.equal((await B.release(G.id)).status, 200);
    await B.deliver(k.id, X.token, "做完了");
    assert.equal((await B.resolve(k.id, "approve")).status, 200);
    const A = await until(async () => (await B.api("GET", "/api/tasks?archived=false", B.operator)).body.tasks.find((t) => t.auto_kind === "assemble") || null);
    assert.ok(A, "出了候选组装卡 " + B.log().slice(-1500));
    assert.deepEqual([A.parent_id, !!A.released, A.status], [G.id, false, "not_started"]);
    const g = await until(async () => { const x = await B.get(G.id); return x.status === "done" ? x : null; });
    assert.ok(g, "未放行的候选组装卡不拖住目标结案 " + JSON.stringify(await B.get(G.id)));
    assert.deepEqual([g.children_done, g.children_total], [1, 1], "组头「执行 n/m」不数看板自动出的卡");
    await delay(1200);
    assert.equal((await B.get(G.id)).status, "done", "定时扫几轮后仍是完成(没被候选组装卡重开)");
    // 放行后照常计:目标重开(候选组装卡没完成)
    assert.equal((await B.release(A.id)).status, 200);
    const re = await until(async () => { const x = await B.get(G.id); return x.status !== "done" ? x : null; });
    assert.ok(re, "放行后照常计入:目标重开");
  } finally { await B.stop(); }
});

test("② 看板:复审卡判「不符」且没过期 → 审阅判通过也不自动通过,缺口写明哪张复审卡判的;本人显式裁定照常通过", { timeout: 200000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" }), Y = await B.connectAs({ kind: "other", line: "ext2" });
    const S = await B.card("规格", "ext2");
    const R = await B.card("照规格做", "ext", { refs: [{ card: S.id, review: true }] });
    await B.deliver(R.id, X.token, "第一次交付", { files: [{ path: "src/a.mjs", sha256: "a".repeat(64) }] });
    const rc = await until(async () => (await B.api("GET", "/api/tasks?archived=false", B.operator)).body.tasks.find((t) => t.auto_kind === "spec_review" && t.review_of?.card === R.id) || null);
    assert.ok(rc, "出了复审卡");
    assert.equal((await B.release(rc.id)).status, 200);
    await B.deliver(rc.id, Y.token, "与说明不符", { checks: [{ name: "spec_conformance", status: "fail", how: "ran" }] });
    assert.equal((await B.resolve(rc.id, "approve")).status, 200);
    const x = await until(async () => { const t = await B.get(R.id); return t.spec_review && !t.spec_review.stale ? t : null; });
    assert.equal(x?.spec_review.verdict, "deviates");
    // 审阅座席判通过 → 闸不满足:不结案、转人工,缺口写明复审卡
    const rv = await B.api("POST", `/api/tasks/${R.id}/resolve`, B.review, { verdict: "approve", resolved_by: "auto", note: "审过", runtime: "codex", expected_version: x.aggregate_version });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.equal(rv.body.held_for_human, true, "与规格不符的卡不自动通过 " + JSON.stringify(rv.body));
    assert.ok(rv.body.missing.some((m) => m.includes(`复审卡 #${rc.id}`) && m.includes(`#${S.id}`)), JSON.stringify(rv.body.missing));
    const held = await B.get(R.id);
    assert.equal(held.status, "waiting");
    assert.ok(CRED.credGaps(held).some((g) => g.includes(`复审卡 #${rc.id}`)), "确认处照列:" + JSON.stringify(CRED.credGaps(held)));
    // 本人显式裁定不受闸限制
    assert.equal((await B.resolve(R.id, "approve")).status, 200);
    assert.equal((await B.get(R.id)).status, "done");
  } finally { await B.stop(); }
});
