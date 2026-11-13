// 第 8 波面板(8c):合同 I11 的通用规则(阻塞条目自带「要本人做的事」的类型)与 I1–I9 在面板上的文案。`node --test tests/panelreltest.mjs`
//   I11:未开始的卡只要有一条带 attention 的阻塞 → 进「要本人做的事」,类型取它、一句话取 message、动词取 next_action;
//        面板 home-model 区(homeStep / homeAttnType)与 core/brief.mjs 的 kindOf 都只认这个字段,不逐码写。
//        DEP_ARCHIVED 由服务端带 attention:"fault"(迁过来后行为不变);第二轮的 REF_STALE / BASE_GONE / STUCK 经登记口带 attention 也走同一条。
//   文案:首页一句话新码(superseded / dep_archived / resource_busy / lock_held)、条件放行、计划组头「整合」段、关系标记、占用视图、确认处缺口。
//   不起看板、不调用任何模型;库是临时目录里的 node:sqlite。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { briefModel } from "../core/brief.mjs";
import { loadAttentionModel } from "../core/home-model.mjs";
import { typeAttention } from "../core/home-background.mjs";

const require = createRequire(import.meta.url);
const store = require("../core/store.js");
const source = readFileSync(new URL("../core/panel.html", import.meta.url), "utf8");
const briefSource = readFileSync(new URL("../core/brief.mjs", import.meta.url), "utf8");
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `未找到面板测试边界：${start}`);
  return source.slice(source.indexOf("\n", a) + 1, b);
}
const homeSrc = section("// ── home-model(pure;tests/hometest.mjs)──", "// ── /home-model ──");
const H = new Function(homeSrc + ";return { homeStep, homeLists, homeAttnType, homeAttnBlocker, homeGatedConfirm, sideControls };")();
const bgSrc = section("// ── bg-copy(pure;tests/panelcopytest.mjs)──", "// ── /bg-copy ──");
const BG = new Function(bgSrc + ";return { bgOneLineText, bgReleaseOnText, bgStageDots, BG_LINE };")();
const credSrc = section("// ── cred-copy(pure;tests/panelcopytest.mjs)──", "// ── /cred-copy ──");
const CRED = new Function(credSrc + ";return { credGaps, credFlags };")();
const relSrc = section("// ── rel-copy(pure;tests/panelreltest.mjs)──", "// ── /rel-copy ──");
const REL = new Function("bgReleaseOnText", relSrc + ";return { relMarks, relOccRows, relParseList, relCardNo, relBusy, relMinutes };")(BG.bgReleaseOnText);

const TMP = mkdtempSync(join(tmpdir(), "panelrel-")), dbs = [];
after(() => { for (const db of dbs) { try { db.close(); } catch {} } rmSync(TMP, { recursive: true, force: true }); });
const card = (id, extra) => ({ id, task_uid: "u" + id, subject: "卡 " + id, kind: "task", status: "not_started", released: 1, updated_at: "2026-11-14T00:00:0" + (id % 10) + "Z", hb: "", ...extra });
const B = (code, extra = {}) => ({ code, message: code + " 的原因", next_action: code + " 的下一步要做的事", ...extra });

test("I11 通用规则:带 attention 的阻塞 → 进「要本人做的事」,类型取它,一句话 = message,下一步 = next_action;不带的不进", () => {
  const tasks = [
    card(1, { progress_blockers: [B("DEP_ARCHIVED", { attention: "fault", message: "依赖任务没做完就被归档", next_action: "恢复依赖任务、改依赖或用新卡取代它" })] }),
    card(2, { progress_blockers: [B("REF_STALE", { attention: "decide", message: "引用的规格改过了", next_action: "重钉" })] }),
    card(3, { progress_blockers: [B("BASE_GONE", { attention: "fault" })] }),
    card(4, { progress_blockers: [B("STUCK", { attention: "decide", message: "连着被回收 3 次" })] }),
    card(5, { progress_blockers: [B("DEP_ARCHIVED")] }),                                      // 没带 attention:不按码猜
    card(6, { released: 0, progress_blockers: [B("NOT_RELEASED"), B("BASE_GONE", { attention: "fault" })] }),   // 未放行也一样:先看 attention
    card(7, { progress_blockers: [B("SOMETHING", { attention: "bogus" })] }),                 // 认不出的值不算
    card(8, { human_gate: 1, progress_blockers: [B("HUMAN_GATE"), B("STUCK", { attention: "decide" })] }),   // 人工闸照旧优先
  ];
  const { mine } = H.homeLists({ tasks });
  const got = Object.fromEntries(mine.map((r) => [r.localId, [r.type, r.verb, r.state, r.why ?? null, r.next]]));
  assert.deepEqual(got[1], ["fault", "查看", "受阻 · 要你看", "依赖任务没做完就被归档", "恢复依赖任务、改依赖或用新卡取代它"], "DEP_ARCHIVED 迁到通用规则后仍是故障类");
  assert.deepEqual(got[2], ["decide", "重钉", "待你裁定", "引用的规格改过了", "重钉"], "动词取 next_action(短动词)");
  assert.deepEqual(got[3].slice(0, 2), ["fault", "查看"], "next_action 是一句话时按钮用类的动词,那句在下一步里");
  assert.equal(got[3][4], "BASE_GONE 的下一步要做的事");
  assert.deepEqual(got[4].slice(0, 4), ["decide", "去裁定", "待你裁定", "连着被回收 3 次"]);
  assert.equal(got[5], undefined, "没带 attention 的阻塞不进栏:面板里没有逐码的分支");
  assert.deepEqual(got[6].slice(0, 2), ["fault", "查看"]);
  assert.equal(got[7], undefined);
  assert.deepEqual(got[8].slice(0, 3), ["decide", "去裁定", "待人工裁定"]);
  // 别的电脑的卡只能在它那边处理:不进本机这一栏
  assert.equal(H.homeStep(tasks[0], { remoteName: "另一台" }).lane, null);
  // 单独调 homeAttnType(server 给线故障行补类型时也走它)
  assert.deepEqual(H.homeAttnType({}, tasks[1]), { type: "decide", verb: "重钉" });
});

test("I11 服务端:DEP_ARCHIVED 带 attention:fault;登记口来的阻塞带的 attention 原样进 progress_blockers;经 home-model 与简报各自归类", () => {
  const db = new DatabaseSync(join(TMP, "a.db")); dbs.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000"); store.migrate(db);
  const gone = store.add(db, { subject: "会被归档" }), waits = store.add(db, { subject: "永远等", blockedBy: [gone] });
  store.archive(db, { id: gone });
  const pb = store.stuckWhy(db, waits);
  assert.deepEqual(pb.map((b) => [b.code, b.attention]), [["DEP_ARCHIVED", "fault"]]);
  assert.equal(store.claimBlockers(db, store.get(db, waits)).find((b) => b.code === "DEP_ARCHIVED").attention, "fault");
  // 模拟第二轮(8d)经登记口出的码:REF_STALE / STUCK = decide,BASE_GONE = fault;乱值不带出去。
  const plain = store.add(db, { subject: "引用过期" }), base = store.add(db, { subject: "底没了" }), stuck = store.add(db, { subject: "卡死" }), odd = store.add(db, { subject: "乱值" });
  const want = new Map([[plain, ["REF_STALE", "decide"]], [base, ["BASE_GONE", "fault"]], [stuck, ["STUCK", "decide"]], [odd, ["ODD", "urgent"]]]);
  const off = store.registerClaimCheck("panelrel-test", (_db, t) => {
    const w = want.get(Number(t.id));
    return w ? { code: w[0], attention: w[1], message: w[0] + " 的原因", next_action: "查看原因" } : null;
  });
  try {
    for (const [id, [code, att]] of want) {
      const b = store.stuckWhy(db, id).find((x) => x.code === code);
      assert.ok(b, code);
      assert.equal(b.attention, att === "urgent" ? undefined : att, code);
    }
    const tasks = [waits, plain, base, stuck, odd].map((id) => ({ ...store.get(db, id), progress_blockers: store.stuckWhy(db, id), hb: "" }));
    const M = loadAttentionModel();
    const lists = M.homeLists({ tasks });
    const typeOf = Object.fromEntries(lists.mine.map((r) => [r.localId, r.type]));
    assert.deepEqual(typeOf, { [waits]: "fault", [plain]: "decide", [base]: "fault", [stuck]: "decide" }, "乱值的卡不进栏");
    // 简报:fault → blocked,decide → decision(brief.mjs 的 kindOf 也只认 attention)
    const kinds = Object.fromEntries(briefModel({ lists, tasks }).attention.map((a) => [a.task_id, a.kind]));
    assert.deepEqual(kinds, { [waits]: "blocked", [plain]: "decision", [base]: "blocked", [stuck]: "decision" });
    // /api/home/background 的 type 来自同一份(按序对上;条数一致不标 mismatch)
    const shown = briefModel({ lists, tasks }).attention;
    const typed = typeAttention(shown, shown.length, lists.mine.map((r) => ({ type: r.type, verb: r.verb })));
    assert.equal(typed.mismatch, false);
    assert.deepEqual(typed.attention.map((a) => a.type), lists.mine.map((r) => r.type));
  } finally { off(); }
});

test("I11 只有一份:home-model 与 brief.mjs 里不再按 DEP_ARCHIVED 逐码写分支;homeStep 的 waiting_for=dep 死分支已删", () => {
  assert.ok(!/DEP_ARCHIVED/.test(homeSrc), "home-model 区不出现 DEP_ARCHIVED");
  assert.ok(!/DEP_ARCHIVED/.test(briefSource), "brief.mjs 不出现 DEP_ARCHIVED");
  assert.ok(/b\?\.attention === "fault"/.test(briefSource) && /homeAttnBlocker\(blockers\)/.test(homeSrc) && /homeAttnBlocker\(t\.progress_blockers\)/.test(homeSrc));
  assert.ok(!/waiting_for === "dep"/.test(homeSrc));
  assert.equal(H.homeStep(card(9, { status: "waiting", waiting_for: "dep" })).state, "等待处理", "认不出的等待写「等待处理」,不当成机器在管");
});

test("第 7 波欠账②:审过、自动通过被拦的卡(confirm 没有方案包)写「审阅已过 · 自动通过被拦 · 待你验收」,类是验收,按钮是通过 / 打回", () => {
  const held = card(1, { status: "waiting", waiting_for: "confirm", auto_review_at: "x", conclusions: [{ kind: "review", verdict: "approve", stale: false }] });
  const s = H.homeStep(held);
  assert.deepEqual([s.lane, s.state, s.next], ["mine", "审阅已过 · 自动通过被拦 · 待你验收", "核对缺口后通过或打回"]);
  assert.equal(H.homeStep({ ...held, conclusions: [] }).state, "审阅看过 · 待你验收");
  assert.deepEqual(H.homeAttnType({}, held), { type: "accept", verb: "验收" });
  assert.equal(H.sideControls(held, { mine: true }).kind, "accept", "侧栏给的是通过 / 打回");
  const pkg = { ...held, decision_package: { options: [{ key: "A" }] } };
  assert.deepEqual([H.homeStep(pkg).state, H.homeAttnType({}, pkg).type, H.sideControls(pkg, { mine: true }).kind], ["待你选择方案", "confirm", "package"], "有方案包的照旧是选方案");
  // 侧栏步骤条与看板卡面的字跟着改
  assert.ok(source.includes('human ? (homeGatedConfirm(t) ? "待验收" :'));
  assert.ok(source.includes('txt: homeGatedConfirm(t) ? "待你验收 · 审阅看过" : progressWaitLabel(t)'));
});

test("首页一句话新码:按 code + params 拼(不解析文本);参数缺时有兜底;条件放行四态", () => {
  const one = (code, params) => BG.bgOneLineText({ kind: "blocked", code, params });
  assert.equal(one("superseded", { by: 12 }), "已被 #12 取代，不会再被领");
  assert.equal(one("superseded", { by: null }), BG.BG_LINE.superseded);
  assert.equal(one("dep_archived", { ids: [3, 4] }), "依赖 #3、#4 没做完就被归档了");
  assert.equal(one("dep_archived", { ids: [1, 2, 3, 4] }), "依赖 #1、#2、#3 等 4 张 没做完就被归档了");
  assert.equal(one("lock_held", { ids: [7] }), "执行锁被 #7 占着");
  assert.equal(one("resource_busy", { resources: ["db:main"], ids: [5], locks: [] }), "被 #5 占着", "资源名在 holder 那一格里,这里不重复");
  assert.equal(one("resource_busy", { resources: ["gpu"], ids: [], locks: [2] }), "被 协作锁 占着");
  assert.equal(one("resource_busy", {}), BG.BG_LINE.resource_busy);
  for (const c of ["superseded", "dep_archived", "resource_busy", "lock_held"]) assert.ok(BG.BG_LINE[c], c);
  assert.deepEqual(BG.bgReleaseOnText({ card: 4, event: "done" }), { key: "pending", text: "等 #4 完成后自动放行", tone: "" });
  assert.equal(BG.bgReleaseOnText({ card: 4, event: "delivered" }).text, "等 #4 交付后自动放行");
  assert.equal(BG.bgReleaseOnText({ card: 4, event: "done", fired: true }).text, "已按条件放行（#4 完成）");
  assert.equal(BG.bgReleaseOnText({ card: 4, event: "done", broken: true }).text, "条件放行失效：#4 已被取代或归档 · 回到待放行");
  assert.deepEqual(BG.bgReleaseOnText({ card: 4, event: "done", failed: "执行配置核对没过" }), { key: "failed", text: "按条件放行没成 · 回到待放行", tone: "warn", tip: "执行配置核对没过" });
  assert.equal(BG.bgReleaseOnText(null), null);
  // 条件坏了 → 回到「要本人做的事」的待放行,写明
  const nr = [B("NOT_RELEASED")];
  const s = H.homeStep(card(1, { released: 0, progress_blockers: nr, release_on: { card: 4, event: "done", broken: true } }));
  assert.deepEqual([s.lane, s.state, s.why], ["mine", "条件放行失效 · 待你放行", undefined], "怎么坏的写在关系标记里,不重复");
  // 等条件的卡(服务端多一条 RELEASE_ON_PENDING)不进栏
  assert.equal(H.homeStep(card(2, { released: 0, progress_blockers: [...nr, B("RELEASE_ON_PENDING")], release_on: { card: 4, event: "done" } })).lane, null);
  // 候选组装卡:未放行照「放行」类进栏,写明是板出的
  const asm = card(3, { released: 0, progress_blockers: nr, auto_kind: "assemble" });
  assert.equal(H.homeStep(asm).state, "候选组装 · 板出的 · 待你放行");
  assert.equal(H.homeAttnType({}, asm).type, "release");
});

test("计划组头:写了 integrate 的目标亮出「整合」段并写「待合 n · 已在 m」;没写的同现状", () => {
  const g = (stage, integrate) => ({ stage, stage_detail: { done: 3, total: 3, ...(integrate ? { integrate } : {}) } });
  const ig = { merged: 2, pending: 1, unknown: 0, target: "refs/heads/main", target_sha: "abc" };
  assert.deepEqual(BG.bgStageDots(g("integrate", ig)).map((d) => [d.key, d.label, d.state]),
    [["decompose", "拆解", "done"], ["execute", "执行 3/3", "done"], ["integrate", "整合 待合 1 · 已在 2", "now"], ["accept", "验收", "todo"]]);
  assert.equal(BG.bgStageDots(g("execute", { ...ig, unknown: 1 })).find((d) => d.key === "integrate").label, "整合 待合 1 · 已在 2 · 未核 1");
  assert.equal(BG.bgStageDots(g("execute", ig)).find((d) => d.key === "integrate").state, "todo");
  assert.equal(BG.bgStageDots(g("accept", ig)).find((d) => d.key === "integrate").state, "done");
  assert.deepEqual(BG.bgStageDots(g("execute", null)).map((d) => d.key), ["decompose", "execute", "accept"], "没写 integrate 不画整合段");
});

test("关系标记:取代 / 同批 / 资源与占用方 / 条件放行 / 依赖重开 / 改同一处 / 整合 / 候选组装;不用强调色", () => {
  const t = card(5, {
    superseded_by: 9, supersedes: [2], auto_kind: "assemble",
    batch: { key: "夜间", members: [{ id: 5, title: "本卡", status: "waiting" }, { id: 6, title: "另一张", status: "done" }, { id: 7, title: "第三张", status: "in_progress" }], done: 1, total: 3 },
    needs: ["db:main"], progress_blockers: [{ code: "RESOURCE_BUSY", detail: { resources: [{ resource: "db:main", kind: "card", card_id: 8, holder: "w", minutes: 75 }] } }],
    release_on: { card: 4, event: "done" }, basis_changed: [{ dep: 3, at: "x", kind: "reopened" }],
    overlaps: [{ path: "core/a.js", with: [{ id: 11, line: "l" }] }, { path: "docs/", with: [{ id: 11, line: "l" }, { id: 12, line: "m" }] }],
    integration: { state: "pending", target: "refs/heads/main" },
  });
  const m = Object.fromEntries(REL.relMarks(t).map((x) => [x.key, x]));
  assert.equal(m.superseded.text, "已被 #9 取代");
  assert.equal(m.supersedes.text, "取代 #2");
  assert.equal(m.assemble.text, "候选组装 · 板出的");
  assert.equal(m.batch.text, "同批「夜间」1/3");
  assert.ok(m.batch.tip.includes("#7 第三张 · 在做"));
  assert.equal(m.busy.text, "资源「db:main」被 #8 占着 · 1 小时 15 分");
  assert.equal(m.needs, undefined, "被占时只写占用方");
  assert.equal(m.release_on.text, "等 #4 完成后自动放行");
  assert.equal(m.basis.text, "依赖 #3 重开过");
  assert.equal(m.overlap.text, "与 #11、#12 改同一处");
  assert.ok(m.overlap.tip.includes("只提示，不拦"));
  assert.equal(m.integration.text, "待合");
  assert.ok(REL.relMarks(t).every((x) => ["", "quiet", "warn"].includes(x.tone)), "强调色不给关系标记");
  assert.deepEqual(REL.relMarks(card(1, {})), []);
  assert.equal(Object.fromEntries(REL.relMarks(card(1, { needs: ["a", "b"] })).map((x) => [x.key, x.text])).needs, "要资源 a、b");
  assert.deepEqual(["merged", "unknown"].map((s) => REL.relMarks(card(1, { integration: { state: s } }))[0].text), ["已在目标分支", "未核"]);
  assert.equal(REL.relBusy(card(1, { progress_blockers: [{ code: "RESOURCE_BUSY", detail: { resources: [{ resource: "x", kind: "lock", lock_id: 3, holder: "h", minutes: null }] } }] }))[0].who, "协作锁（h）");
});

test("确认处缺口多两类(不拦人):同批还有 n 张没完成、与 #N 改同一处;徽标标记 fingerprint_missing", () => {
  const t = card(5, { status: "waiting", waiting_for: "review",
    batch: { key: "夜间", members: [{ id: 5, status: "waiting" }, { id: 6, status: "done" }, { id: 7, status: "not_started" }], done: 1, total: 3 },
    overlaps: [{ path: "core/a.js", with: [{ id: 11 }] }, { path: "core/b.js", with: [{ id: 11 }] }],
    badge: { level: "self_reported", flags: ["fingerprint_missing"], provenance: [] } });
  const g = CRED.credGaps(t);
  assert.ok(g.includes("同批「夜间」还有 1 张没完成"), JSON.stringify(g));
  assert.ok(g.includes("与 #11 改同一处：core/a.js、core/b.js"), JSON.stringify(g));
  assert.ok(g.includes("这次交付没记上指纹"));
  assert.deepEqual(CRED.credFlags(t).map((f) => [f.key, f.text]), [["fingerprint_missing", "这次交付没记上指纹"]]);
  assert.deepEqual(CRED.credGaps(card(5, { batch: { key: "k", members: [{ id: 5, status: "waiting" }, { id: 6, status: "done" }], done: 1, total: 2 } })), [], "只剩自己不算");
});

test("占用视图:重叠的排前面,其余按路径;卡写成「#id 标题 · 线 · 在改 · 声明」;写入口的输入解析", () => {
  const rows = REL.relOccRows({ rows: [
    { path: "z.md", cards: [{ id: 1, title: "甲", line: "l1", state: "running", source: "declared" }] },
    { path: "a.md", cards: [{ id: 2, title: null, line: "l2", state: "delivered", source: "delivered" }] },
    { path: "m/", cards: [{ id: 1, title: "甲", line: "l1", state: "running", source: "declared" }, { id: 3, title: "丙", line: "l1", state: "running", source: "declared" }] },
  ], overlaps: [{ path: "m/", cards: [1, 3] }] });
  assert.deepEqual(rows.map((r) => [r.path, r.overlap]), [["m/", true], ["a.md", false], ["z.md", false]]);
  assert.equal(rows[1].cards[0].text, "#2 · l2 · 已交付待验收 · 交付", "别线的卡没有标题就只写卡号");
  assert.equal(rows[0].cards[1].text, "#3 丙 · l1 · 在改 · 声明");
  assert.deepEqual(REL.relOccRows(null), []);
  assert.deepEqual(REL.relParseList(" a , b\nc\r\n\na，b "), ["a", "b", "c"]);
  assert.deepEqual([REL.relCardNo("#12"), REL.relCardNo(" 7 "), REL.relCardNo(""), Number.isNaN(REL.relCardNo("x1")), Number.isNaN(REL.relCardNo("0"))], [12, 7, null, true, true]);
  assert.deepEqual([REL.relMinutes(5), REL.relMinutes(60), REL.relMinutes(0), REL.relMinutes(null)], ["5 分", "1 小时", "不到 1 分", ""]);
});

test("写入口只走操作者接口、收在「关系与占用…」对话框;首页不摊开;占用入口在「全部任务」工具条;不出替执行者执行 / 代批的入口", () => {
  for (const p of ['"/supersede"', '"/needs"', '"/touches"', '"/release-on"', '"/integrate"', '"/basis/ack"', '"/update", { expected_version: t.aggregate_version, batch:'])
    assert.ok(source.includes(p), p);
  assert.ok(source.includes('<button type="button" class="ghost" id="occ-open"'), "占用入口在看板工具条");
  assert.ok(source.includes('acts += `<button data-rel-edit="${t.id}"'), "看板卡的入口在展开区的动作里,不在卡面");
  assert.ok(source.includes('item("改关系与占用…", () => relDialogOpen(t.id)'), "侧栏一节的入口在「其他」菜单里");
  assert.ok(!/替执行者|代批|代为执行/.test(section("// ── rel-copy(pure;tests/panelreltest.mjs)──", "// ── /rel-copy ──")));
  const dom = source.slice(source.indexOf("// ── 第 8 波「关系与占用」(合同 I1–I9)的画面"), source.indexOf("// 证据图:GET /api/tasks/:id/evidence/:sha256"));
  assert.ok(dom.length > 1000 && !/替执行者|代批|代为执行/.test(dom));
  assert.ok(!/\/(claim|report|resolve)"/.test(dom), "关系与占用的画面不发领卡 / 交付 / 裁定请求");
  // attention_type_mismatch:组头旁一个弱提示,说明在悬停
  assert.ok(source.includes('id="home-mine-mm" hidden') && source.includes('bgData.attention_type_mismatch === true'));
});
