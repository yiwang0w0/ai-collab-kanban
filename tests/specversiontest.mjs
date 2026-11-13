import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 说明的版本确认(合同 H6):放行前改不计、放行后改 +1(spec_history 留版本 / 哈希 / 时刻 / 谁);get_card / claim_card 带 spec_version;
// heartbeat 带 seen_spec_version 记 acked,落后时应答带 spec_changed;交付时落后(或没带且领取后改过)→ based_on_stale_spec + 卡历史一条;
// 没改过说明的老桥交付不被标;执行者与助手改不了说明;真 stdio 桥按 get_card 看过的版本自动带 seen。`node --test tests/specversiontest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { specHash, checkSeen } from "../core/spec-version.mjs";
import { freePort } from "./helpers/free-port.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BRIDGE = join(ROOT, "cli", "exec-mcp.mjs");

async function board({ lines = [{ id: "alpha" }, { id: "ext", label: "外部", external: true }], env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "specversiontest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines, roles: [], routes: ["default"], repo: dir }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit", ...env } });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const operator = readFileSync(join(dir, "board_token"), "utf8").trim();
  const get = async (id, tok = operator) => (await api("GET", `/api/tasks/${id}`, tok)).body.task;
  const card = async (subject, line, extra = {}) => {
    const r = await api("POST", "/api/tasks", operator, { subject, line, description: "第一版说明", acceptance: "三句话", ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task;
  };
  const edit = async (id, fields) => {
    const t = await get(id);
    const r = await api("POST", `/api/tasks/${id}/update`, operator, { expected_version: t.aggregate_version, ...fields });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.task;
  };
  const connectAs = async (body) => {
    const c = await api("POST", "/api/connect/codes", operator, body);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await api("POST", "/api/connect/redeem", null, { code: c.body.code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: r.body.executor_id, token: r.body.token };
  };
  const claim = async (id, tok) => {
    const t = await get(id);
    const r = await api("POST", `/api/tasks/${id}/claim`, tok, { expected_version: t.aggregate_version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.task;
  };
  const history = async (id) => (await api("GET", `/api/tasks/${id}/history`, operator)).body.entries;
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, operator, get, card, edit, connectAs, claim, history, stop, log: () => log };
}

test("内容哈希:标题 / 说明 / 验收 / 必需检查;必需检查缺失 = 空、顺序不算修改;seen 只收正整数", () => {
  const t = { subject: "a", description: "b", acceptance: "c" };
  assert.equal(specHash(t), specHash({ ...t, required_checks: [] }), "缺失按空处理");
  assert.equal(specHash({ ...t, required_checks: ["x", "y"] }), specHash({ ...t, required_checks: '["y","x"]' }), "数组或 JSON 文本、顺序无关");
  assert.notEqual(specHash(t), specHash({ ...t, required_checks: ["x"] }));
  for (const k of ["subject", "description", "acceptance"]) assert.notEqual(specHash(t), specHash({ ...t, [k]: "改" }), k);
  assert.equal(specHash(t), specHash({ ...t, line: "alpha", summary: "别的字段" }), "只看四项");
  const bad = (m) => Object.assign(new Error(m), { code: "BAD_INPUT" });
  assert.equal(checkSeen(undefined, bad), null); assert.equal(checkSeen(null, bad), null); assert.equal(checkSeen(3, bad), 3);
  for (const v of [0, -1, 1.5, "2", true]) assert.throws(() => checkSeen(v, bad), /seen_spec_version/);
});

test("放行前改不计;放行后改 +1,spec_history 记 by;执行者与助手改不了说明", { timeout: 90000 }, async () => {
  const B = await board();
  try {
    const t = await B.card("先不放行", "ext", { released: false });
    await B.edit(t.id, { description: "放行前改一次" });
    await B.edit(t.id, { acceptance: "放行前又改" });
    let now = await B.get(t.id);
    assert.equal(now.spec_version, 1); assert.deepEqual(now.spec_history, [], "放行前不记版本");
    const rel = await B.api("POST", `/api/tasks/${t.id}/release`, B.operator, { expected_version: now.aggregate_version, released: true });
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    now = await B.get(t.id);
    assert.equal(now.spec_version, 1);
    assert.deepEqual(now.spec_history.map((h) => [h.version, h.by]), [[1, "release"]]);
    assert.equal(now.spec_history[0].hash, specHash(now));
    await B.edit(t.id, { description: "放行后第一次改" });
    await B.edit(t.id, { subject: "放行后改标题" });
    await B.edit(t.id, { line: "alpha" });                                  // 改线不是说明
    now = await B.get(t.id);
    assert.equal(now.spec_version, 3);
    assert.deepEqual(now.spec_history.map((h) => [h.version, h.by]), [[1, "release"], [2, "operator"], [3, "operator"]]);
    assert.ok((await B.history(t.id)).some((e) => /改了说明\(现为 v3\)/.test(e.summary)), "卡的历史里有改说明的条目");

    const created = await B.card("建卡即放行", "ext");
    assert.equal(created.spec_version, 1);
    assert.deepEqual((await B.get(created.id)).spec_history.map((h) => h.version), [1]);

    const X = await B.connectAs({ kind: "other", line: "ext" });
    const A = await B.connectAs({ kind: "other", role: "assistant" });
    for (const tok of [X.token, A.token]) {
      const cur = await B.get(created.id);
      const r = await B.api("POST", `/api/tasks/${created.id}/update`, tok, { expected_version: cur.aggregate_version, description: "偷改" });
      assert.equal(r.status, 403, "执行者 / 助手改不了说明");
    }
    assert.equal((await B.get(created.id)).spec_version, 1);
  } finally { await B.stop(); }
});

test("心跳带 seen 记 acked、落后时 spec_changed;旧版交付被标 based_on_stale_spec;没改过的老式交付不被标;seen 乱值 400", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });

    // ① 领卡后操作员追加说明 → 心跳(不带 seen)落后;带 seen=2 后不再落后;按 seen=2 交付 → 不标
    const a = await B.card("会改说明的卡", "ext");
    const ca = await B.claim(a.id, X.token);
    assert.equal(ca.spec_version, 1, "领卡应答带 spec_version");
    const hb0 = await B.api("POST", `/api/tasks/${a.id}/heartbeat`, X.token, { run_id: ca.run_id });
    assert.equal(hb0.body.spec_version, 1); assert.ok(!("spec_changed" in hb0.body));
    await B.edit(a.id, { description: "第一版说明\n补充:还要附截图" });       // 执行中只允许尾部追加
    const hb1 = await B.api("POST", `/api/tasks/${a.id}/heartbeat`, X.token, { run_id: ca.run_id });
    assert.deepEqual(hb1.body.spec_changed, { current: 2, yours: 1 });
    const hb2 = await B.api("POST", `/api/tasks/${a.id}/heartbeat`, X.token, { run_id: ca.run_id, seen_spec_version: 2 });
    assert.equal(hb2.status, 200); assert.ok(!("spec_changed" in hb2.body));
    assert.equal((await B.get(a.id)).acked_spec_version, 2);
    const ra = await B.api("POST", `/api/tasks/${a.id}/report`, X.token, { run_id: ca.run_id, outcome: "done", evidence: "做完了" });
    assert.equal(ra.status, 200, JSON.stringify(ra.body));
    assert.equal((await B.get(a.id)).based_on_stale_spec, false, "心跳确认过 v2,交付没带 seen 也不算旧版");

    // ② 领卡后改说明,交付带 seen=1 → 标旧版 + 历史一条
    const b = await B.card("旧版交付", "ext");
    const cb = await B.claim(b.id, X.token);
    await B.edit(b.id, { description: "第一版说明\n追加一条" });
    const big = await B.api("POST", `/api/tasks/${b.id}/report`, X.token, { run_id: cb.run_id, outcome: "done", evidence: "x", seen_spec_version: 9 });
    assert.equal(big.status, 400, "比当前还新的版本 = 乱值");
    assert.equal((await B.get(b.id)).status, "in_progress", "乱值不收这次交付");
    const zero = await B.api("POST", `/api/tasks/${b.id}/heartbeat`, X.token, { run_id: cb.run_id, seen_spec_version: 0 });
    assert.equal(zero.status, 400);
    const rb = await B.api("POST", `/api/tasks/${b.id}/report`, X.token, { run_id: cb.run_id, outcome: "done", evidence: "按旧说明做完", seen_spec_version: 1 });
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    const tb = await B.get(b.id);
    assert.equal(tb.based_on_stale_spec, true); assert.equal(tb.spec_version, 2); assert.equal(tb.acked_spec_version, 1);
    assert.ok((await B.history(b.id)).some((e) => /基于旧版说明\(对方确认到 v1,当前 v2\)/.test(e.summary)), "卡的历史里记一条");

    // ③ 没带 seen、领取后改过 → 标旧版
    const c = await B.card("没带 seen", "ext");
    const cc = await B.claim(c.id, X.token);
    await B.edit(c.id, { description: "第一版说明\n又追加" });
    await B.api("POST", `/api/tasks/${c.id}/report`, X.token, { run_id: cc.run_id, outcome: "done", evidence: "x" });
    assert.equal((await B.get(c.id)).based_on_stale_spec, true);

    // ④ 老式交付(不带 seen、说明没改过)→ 不标;放行前改过也不算
    const d = await B.card("老桥", "ext", { released: false });
    await B.edit(d.id, { description: "放行前改的" });
    const dv = await B.get(d.id);
    await B.api("POST", `/api/tasks/${d.id}/release`, B.operator, { expected_version: dv.aggregate_version, released: true });
    const cd = await B.claim(d.id, X.token);
    await B.api("POST", `/api/tasks/${d.id}/heartbeat`, X.token, { run_id: cd.run_id });
    const rd = await B.api("POST", `/api/tasks/${d.id}/report`, X.token, { run_id: cd.run_id, outcome: "done", evidence: "x" });
    assert.equal(rd.status, 200);
    const td = await B.get(d.id);
    assert.equal(td.based_on_stale_spec, false); assert.equal(td.spec_version, 1);
    assert.ok(!(await B.history(d.id)).some((e) => /旧版说明|改了说明/.test(e.summary)));
  } finally { await B.stop(); }
});

test("真 stdio 桥:get_card / claim_card 带 spec_version,heartbeat 回 spec_changed,重读后 report_result 自动带上看过的版本", { timeout: 90000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });
    const tokenFile = join(B.dir, "x.token"); writeFileSync(tokenFile, X.token);
    const t = await B.card("桥上的卡", "ext");
    const M = spawn(process.execPath, [BRIDGE, "--url", B.base, "--token-file", tokenFile, "--line", "ext"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: HOST_ENV });
    let buf = ""; const waiting = new Map(); M.stdout.setEncoding("utf8");
    M.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
    let n = 1; const rpc = (method, params) => { const id = n++; M.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return new Promise((r) => waiting.set(id, r)); };
    const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result.structuredContent;
    try {
      await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
      M.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const w = await call("wait_for_card", { timeout_sec: 2 });
      assert.equal(w.card.spec_version, 1);
      const g = await call("get_card", { id: t.id });
      assert.equal(g.card.spec_version, 1);
      const c = await call("claim_card", { id: t.id, expected_version: g.card.aggregate_version });
      assert.equal(c.spec_version, 1);
      await B.edit(t.id, { description: "第一版说明\n补一句" });
      const hb = await call("heartbeat", { id: t.id });
      assert.deepEqual(hb.spec_changed, { current: 2, yours: 1 }); assert.match(hb.next, /get_card/);
      assert.equal((await call("get_card", { id: t.id })).card.spec_version, 2);
      const r = await call("report_result", { id: t.id, outcome: "done", evidence: "按新版做完" });
      assert.equal(r.status, "waiting");
      assert.equal((await B.get(t.id)).based_on_stale_spec, false, "重读过 v2,桥自动带 seen=2");
    } finally { M.stdin.end(); await new Promise((r) => M.once("close", r)); }
  } finally { await B.stop(); }
});

// 与可信核心(合同 H1–H4,core/credibility.mjs)的联合:真实交付路径置 based_on_stale_spec → 对方的自动通过硬闸不放;
// required_checks 走操作员接口改 = 说明改了一版;证据记录带对方的当前 digest。
test("联合:旧版说明的交付在 accept:auto 线上不自动通过(对照卡照常通过);改 required_checks 计版本;证据带当前 digest", { timeout: 120000 }, async () => {
  const B = await board({ lines: [{ id: "alpha" }, { id: "ext", label: "外部", external: true, accept: "auto" }], env: { BOARD_DELIVERABLE_GATE: "off" } });
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });
    // 对照:说明没改过 → 自动通过
    const ok = await B.card("对照卡", "ext");
    const co = await B.claim(ok.id, X.token);
    assert.equal((await B.api("POST", `/api/tasks/${ok.id}/report`, X.token, { run_id: co.run_id, outcome: "done", evidence: "做完了" })).status, 200);
    const tok = await B.get(ok.id);
    assert.equal(tok.status, "done", "没改过说明的交付照常自动通过 " + B.log().slice(-400));
    assert.equal(tok.based_on_stale_spec, false);
    // 旧版说明:领卡后改说明、交付没带 seen → 不自动通过,留在待验收
    const st = await B.card("改了说明的卡", "ext");
    const cs = await B.claim(st.id, X.token);
    await B.edit(st.id, { description: "第一版说明\n补:还要截图" });
    assert.equal((await B.api("POST", `/api/tasks/${st.id}/report`, X.token, { run_id: cs.run_id, outcome: "done", evidence: "按旧说明做完" })).status, 200);
    const tst = await B.get(st.id);
    assert.equal(tst.based_on_stale_spec, true);
    assert.deepEqual([tst.status, tst.waiting_for], ["waiting", "review"], "可信闸挡下,转人工验收");
    assert.ok(tst.badge?.flags?.includes("based_on_stale_spec"), "徽标带 based_on_stale_spec 标记 " + JSON.stringify(tst.badge));
    assert.match(B.log(), /可信闸/);

    // required_checks:放行前改不计;放行后改 +1(by operator)
    const rc = await B.card("必需检查", "ext", { released: false });
    assert.equal((await B.api("POST", `/api/tasks/${rc.id}/required-checks`, B.operator, { required_checks: ["unit"] })).status, 200);
    let t = await B.get(rc.id);
    assert.deepEqual([t.spec_version, t.spec_history.length], [1, 0]);
    await B.api("POST", `/api/tasks/${rc.id}/release`, B.operator, { expected_version: t.aggregate_version, released: true });
    assert.equal((await B.api("POST", `/api/tasks/${rc.id}/required-checks`, B.operator, { required_checks: ["unit", "lint"] })).status, 200);
    t = await B.get(rc.id);
    assert.equal(t.spec_version, 2);
    assert.deepEqual(t.spec_history.map((h) => h.by), ["release", "operator"]);
    assert.equal(t.spec_history[0].hash, specHash({ ...t, required_checks: ["unit"] }), "v1 的哈希含放行时的必需检查");
    assert.equal((await B.api("POST", `/api/tasks/${rc.id}/required-checks`, B.operator, { required_checks: ["lint", "unit"] })).status, 200);
    assert.equal((await B.get(rc.id)).spec_version, 2, "只换顺序不算修改");

    // 证据带当前 digest:先交付一次(outcome=done 才记指纹),打回再领,附图 → digest = 当前指纹
    const ev = await B.card("证据 digest", "alpha");
    const reg = await B.api("POST", "/api/coord/executors", B.operator, { id: "plainexec", name: "令牌登记", kind: "external" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const ce = await B.claim(ev.id, reg.body.token);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture-joint")]);
    const up = (tokn) => fetch(`${B.base}/api/tasks/${ev.id}/evidence`, { method: "POST", body: png, headers: { "X-Board-Token": tokn } }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const first = await up(reg.body.token);
    assert.equal(first.status, 201); assert.equal(first.body.evidence.digest, null, "还没交付过:没有指纹,digest = null");
    assert.equal((await B.api("POST", `/api/tasks/${ev.id}/report`, reg.body.token, { run_id: ce.run_id, outcome: "done", evidence: "第一次交付" })).status, 200);
    const d1 = (await B.get(ev.id)).fingerprint?.digest;
    assert.match(String(d1), /^[0-9a-f]{64}$/, "对方给了 digest");
    const cur = await B.get(ev.id);
    const rej = await B.api("POST", `/api/tasks/${ev.id}/resolve`, B.operator, { expected_version: cur.aggregate_version, verdict: "reject", note: "再做一轮" });
    assert.equal(rej.status, 200, JSON.stringify(rej.body));
    await B.claim(ev.id, reg.body.token);
    const second = await fetch(`${B.base}/api/tasks/${ev.id}/evidence`, { method: "POST", body: Buffer.concat([png, Buffer.from("2")]), headers: { "X-Board-Token": reg.body.token } }).then((r) => r.json());
    assert.equal(second.evidence.digest, d1, "证据记录带上传时的当前指纹");
  } finally { await B.stop(); }
});
