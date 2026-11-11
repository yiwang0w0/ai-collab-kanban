import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 桌面端对话清单 GET /api/desktop-sessions 与勾选 PUT /api/desktop-sessions/selection。
// 真看板 + 合成夹具(临时目录 + BOARD_CLAUDE_PROJECTS / BOARD_CODEX_HOME),不碰本机真对话,不连接模型。
// `node --test tests/desksessionstest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer, connect } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BODY = "BODY_MARKER_不应出现";          // 正文标记:任何响应里都不许出现
const freePort = async (host = "127.0.0.1") => {
  const l = createServer(); await new Promise((r) => l.listen(0, host, r));
  const port = l.address().port; await new Promise((r) => l.close(r)); return port;
};
const J = (o) => JSON.stringify(o);
const ago = (days) => new Date(Date.now() - days * 86400000);
const touch = (p, d) => utimesSync(p, d, d);

/** 合成夹具:返回各对话的 id 与路径。 */
function fixtures(base) {
  const claude = join(base, "claude-projects"), codex = join(base, "codex-home");
  const P1 = join(claude, "C--demo-project"), P2 = join(claude, "C--other");
  mkdirSync(P1, { recursive: true }); mkdirSync(P2, { recursive: true });
  const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(),
                x: randomUUID(), y: randomUUID(), z: randomUUID(), w: randomUUID(), w2: randomUUID() };
  const user = (text, extra = {}) => J({ type: "user", cwd: "C:\\demo\\project", entrypoint: "claude-desktop", sessionId: "s",
                                          message: { role: "user", content: text }, ...extra });
  const asst = (n) => J({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: BODY + " 助手回复" }],
                                                      usage: { input_tokens: n, cache_creation_input_tokens: 10, cache_read_input_tokens: 100 } } });
  const paths = {};
  // A:custom-title 两次(后者为准)+ ai-title;custom 优先
  paths.a = join(P1, ids.a + ".jsonl");
  writeFileSync(paths.a, [J({ type: "ai-title", aiTitle: "自动标题 A" }), user("第一句 " + BODY), asst(5),
    J({ type: "custom-title", customTitle: "旧标题 A" }), user("第二句 " + BODY), asst(7),
    J({ type: "custom-title", customTitle: "  合成对话\n标题 A  " })].join("\n") + "\n");
  // B:无标题行 → 首条真人消息兜底;注入块与工具结果要跳过;超长截断到 80
  paths.b = join(P1, ids.b + ".jsonl");
  writeFileSync(paths.b, [user("<command-name>/clear</command-name>"), user("工具结果", { toolUseResult: { ok: 1 } }),
    J({ type: "user", isMeta: true, message: { content: "元消息" } }),
    user([...Array(120)].map((_, i) => String.fromCharCode(0x4e00 + i)).join("")), asst(1)].join("\n") + "\n");
  // C:大文件,标题与 usage 只在尾部;头部是超长行
  paths.c = join(P2, ids.c + ".jsonl");
  const pad = J({ type: "attachment", attachment: { blob: "p".repeat(90 * 1024) } });
  writeFileSync(paths.c, [pad, ...Array(12).fill(J({ type: "attachment", attachment: { blob: BODY + "q".repeat(100 * 1024) } })),
    user("尾部消息 " + BODY), asst(1000), J({ type: "custom-title", customTitle: "大文件标题 C" })].join("\n") + "\n");
  // D:损坏行混在中间 + 半截尾行
  paths.d = join(P2, ids.d + ".jsonl");
  writeFileSync(paths.d, ["{不是 JSON", "null", "[1,2]", J({ type: "ai-title", aiTitle: "损坏夹具 D" }), "{\"type\":\"user\",\"mess"].join("\n"));
  // 不该列出的:子代理目录、非 uuid 文件名、子目录里的同名 jsonl
  mkdirSync(join(P1, ids.a, "subagents"), { recursive: true });
  writeFileSync(join(P1, ids.a, "subagents", "agent-1.jsonl"), J({ type: "custom-title", customTitle: "子代理" }) + "\n");
  writeFileSync(join(P1, ids.a, randomUUID() + ".jsonl"), J({ type: "custom-title", customTitle: "嵌套" }) + "\n");
  writeFileSync(join(P1, "notes.jsonl"), J({ type: "custom-title", customTitle: "非对话" }) + "\n");
  touch(paths.a, ago(10)); touch(paths.b, ago(0.2)); touch(paths.c, ago(0.1)); touch(paths.d, ago(3));

  // Codex
  const day = join(codex, "sessions", "2026", "11", "01");
  mkdirSync(day, { recursive: true });
  const meta = (id, extra = {}) => J({ timestamp: "2026-11-01T00:00:00Z", type: "session_meta",
    payload: { id, session_id: id, cwd: "C:\\demo\\codex", originator: "Codex Desktop", source: "vscode", thread_source: "user",
               base_instructions: { text: BODY + "x".repeat(70 * 1024) }, ...extra } });
  const um = (t) => J({ type: "event_msg", payload: { type: "user_message", message: t } });
  const tc = (n) => J({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: n, output_tokens: 3 } } } });
  const am = J({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: BODY }] } });
  paths.x = join(day, `rollout-2026-11-01T10-00-00-${ids.x}.jsonl`);
  writeFileSync(paths.x, [meta(ids.x), um("Codex 首条 " + BODY), am, tc(321)].join("\n") + "\n");
  paths.y = join(day, `rollout-2026-11-01T11-00-00-${ids.y}.jsonl`);
  writeFileSync(paths.y, [meta(ids.y), um("<environment_context>env</environment_context>"), um("没有索引标题的 Codex 对话"), am].join("\n") + "\n");
  paths.z = join(day, `rollout-2026-11-01T12-00-00-${ids.z}.jsonl`);
  writeFileSync(paths.z, [meta(ids.z, { source: { subagent: { other: "guardian" } }, thread_source: "guardian_review", parent_thread_id: ids.x }), am].join("\n") + "\n");
  paths.w = join(day, `rollout-2026-11-01T13-00-00-${ids.w}_${ids.w2}.jsonl`);
  writeFileSync(paths.w, [meta(ids.w), um("双 uuid 文件名"), "{坏行", am].join("\n") + "\n");
  writeFileSync(join(codex, "session_index.jsonl"), [
    J({ id: ids.x, thread_name: "旧索引标题 X", updated_at: "2026-11-01T00:00:00Z" }), "{坏",
    J({ id: ids.z, thread_name: "子代理标题", updated_at: "2026-11-01T00:00:00Z" }),
    J({ id: ids.x, thread_name: "索引标题 X", updated_at: "2026-11-02T00:00:00Z" })].join("\n") + "\n");
  touch(paths.x, ago(0.05)); touch(paths.y, ago(20)); touch(paths.z, ago(0.01)); touch(paths.w, ago(0.3));
  return { claude, codex, ids, paths, P2 };
}

async function board(dir, { claude, codex, config = {} }) {
  const cfg = join(dir, "fleet.json"), repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(cfg, J({ lines: [{ id: "alpha" }, { id: "ext", external: true }], roles: [], routes: ["default"], repo, ...config }));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: cfg, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: repo, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit",
           BOARD_CLAUDE_PROJECTS: claude, BOARD_CODEX_HOME: codex } });
  let logs = ""; child.stdout.on("data", (v) => { logs = (logs + v).slice(-20000); }); child.stderr.on("data", (v) => { logs = (logs + v).slice(-20000); });
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(base + "/health")).ok; } catch {} if (!up) await delay(100); }
  assert.ok(up, "看板没起来:" + logs);
  const tok = (n) => readFileSync(join(dir, n), "utf8").trim();
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : J(body) }), signal: AbortSignal.timeout(15000) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    return { status: r.status, body: j, text };
  };
  const stop = async () => { child.kill(); await closed; };
  return { base, api, operator: tok("board_token"), worker: tok("worker_token"), review: tok("review_token"), stop, logs: () => logs };
}

test("清单:两家解析、标题来源、排序、过滤与上限、不返回正文、损坏行不报错", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "desksessions-")), F = fixtures(dir);
  const B = await board(dir, F);
  try {
    const all = await B.api("GET", "/api/desktop-sessions?limit=200", B.operator);
    assert.equal(all.status, 200, all.text);
    assert.ok(!all.text.includes("BODY_MARKER"), "响应里不许有对话正文");
    assert.deepEqual(all.body.unavailable, []);
    assert.equal(all.body.truncated, false);
    const byId = Object.fromEntries(all.body.sessions.map((s) => [s.id, s]));
    // 子代理线程、嵌套目录、非 uuid 文件不列;最新的在前(Z 最新但是子代理)
    assert.deepEqual(all.body.sessions.map((s) => s.id), [F.ids.x, F.ids.c, F.ids.b, F.ids.w, F.ids.d, F.ids.a, F.ids.y]);
    assert.equal(byId[F.ids.a].title, "合成对话 标题 A", "custom-title 取最后一条,空白折叠");
    assert.equal(byId[F.ids.a].project, "C:\\demo\\project");
    assert.equal(byId[F.ids.a].origin, "claude-desktop");
    assert.equal(byId[F.ids.a].approx_tokens, 117, "最后一轮 usage = input + cache_creation + cache_read");
    assert.equal([...byId[F.ids.b].title].length, 80, "首条真人消息兜底并截到 80 字");
    assert.ok(byId[F.ids.b].title.startsWith(String.fromCharCode(0x4e00)), "跳过注入块 / 工具结果 / 元消息");
    assert.equal(byId[F.ids.c].title, "大文件标题 C", "标题只在尾部也能取到");
    assert.equal(byId[F.ids.c].approx_tokens, 1110);
    assert.equal(byId[F.ids.c].project, "C:\\demo\\project", "头部被超长行占满时从尾部取 cwd");
    assert.equal(byId[F.ids.d].title, "损坏夹具 D", "损坏行跳过");
    assert.equal(byId[F.ids.d].project, "C--other", "没有 cwd 时用项目目录名");
    assert.equal(byId[F.ids.x].title, "索引标题 X", "Codex 标题取索引里同 id 的最后一条");
    assert.equal(byId[F.ids.x].approx_tokens, 321);
    assert.equal(byId[F.ids.x].project, "C:\\demo\\codex");
    assert.equal(byId[F.ids.y].title, "没有索引标题的 Codex 对话", "无索引 → 首条 user_message,跳过注入块");
    assert.equal(byId[F.ids.w].title, "双 uuid 文件名", "rollout-…-<id>_<uuid>.jsonl 的 id 取第一个");
    for (const s of all.body.sessions) {
      assert.deepEqual(Object.keys(s).sort(), ["approx_tokens", "id", "line", "line_forked", "line_forked_at", "origin", "project", "selected", "size_bytes", "source", "start_blocked", "title", "updated_at"]);
      assert.equal(s.selected, false); assert.equal(s.line, null);
      assert.ok(s.size_bytes > 0 && !Number.isNaN(Date.parse(s.updated_at)));
    }
    const c = await B.api("GET", "/api/desktop-sessions?source=claude", B.operator);
    assert.ok(c.body.sessions.every((s) => s.source === "claude") && c.body.sessions.length === 4);
    const x = await B.api("GET", "/api/desktop-sessions?source=codex&days=1", B.operator);
    assert.deepEqual(x.body.sessions.map((s) => s.id), [F.ids.x, F.ids.w], "days 按最后活动时间筛");
    const q = await B.api("GET", "/api/desktop-sessions?q=" + encodeURIComponent("标题"), B.operator);
    assert.deepEqual(q.body.sessions.map((s) => s.id).sort(), [F.ids.x, F.ids.c, F.ids.a, F.ids.y].sort(), "q 只按标题过滤,不看正文");
    assert.equal((await B.api("GET", "/api/desktop-sessions?q=BODY_MARKER", B.operator)).body.sessions.length, 0, "正文不参与过滤");
    const lim = await B.api("GET", "/api/desktop-sessions?limit=2", B.operator);
    assert.deepEqual([lim.body.sessions.length, lim.body.truncated], [2, true]);
    assert.equal((await B.api("GET", "/api/desktop-sessions?limit=9999", B.operator)).status, 200, "超上限按 200 收");
    for (const bad of ["source=gpt", "days=-1", "days=abc", "limit=0", "limit=1.5", "q=" + "长".repeat(201)])
      assert.equal((await B.api("GET", "/api/desktop-sessions?" + bad, B.operator)).status, 400, bad);
    // 只读:两个根下没有多出任何文件
    assert.equal(existsSync(join(F.codex, "desktop_sessions_selected.json")), false);
  } finally { await B.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("鉴权:只认操作员;执行线/审阅线/执行者/批准令牌与远程入口都拒绝", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "desksessions-auth-")), F = fixtures(dir);
  const rport = await freePort("127.0.0.2");
  const B = await board(dir, { ...F, config: { remote_access: { enabled: true, listen: [`127.0.0.2:${rport}`], allow_ips: ["127.0.0.2/32"] } } });
  try {
    const reg = await B.api("POST", "/api/coord/executors", B.operator, { id: "ext", name: "外部", kind: "external" });
    assert.equal(reg.status, 201, reg.text);
    const apr = await B.api("POST", "/api/approval-tokens", B.operator, { label: "phone" });
    assert.equal(apr.status, 201, apr.text);
    const put = { add: [{ source: "claude", id: F.ids.a }] };
    assert.equal((await B.api("GET", "/api/desktop-sessions")).status, 401);
    assert.equal((await B.api("PUT", "/api/desktop-sessions/selection", null, put)).status, 401);
    for (const [who, t, code] of [["执行线", B.worker, 403], ["审阅线", B.review, 403], ["执行者", reg.body.token, 403], ["批准令牌", apr.body.token, 401]]) {
      const g = await B.api("GET", "/api/desktop-sessions", t);
      assert.equal(g.status, code, who + " GET " + g.text);
      assert.ok(!g.text.includes(F.ids.a), who + " 拿不到清单");
      assert.equal((await B.api("PUT", "/api/desktop-sessions/selection", t, put)).status, code, who + " PUT");
    }
    assert.equal((await B.api("GET", "/api/desktop-sessions?selected=1", B.operator)).body.sessions.length, 0, "被拒的写没有落地");
    // 远程入口:批准令牌 / 操作员令牌都到不了这个接口
    for (let i = 0; i < 50; i++) { const ok = await new Promise((r) => { const s = connect({ host: "127.0.0.2", port: rport }); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); }); if (ok) break; await delay(100); }
    const remote = (token, method = "GET", path = "/api/desktop-sessions", body) => new Promise((ok, ko) => {
      const q = http.request({ host: "127.0.0.2", port: rport, path, method, localAddress: "127.0.0.2", timeout: 8000,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) } },
        (r) => { let b = ""; r.setEncoding("utf8"); r.on("data", (c) => { b += c; }); r.on("end", () => ok({ status: r.statusCode, text: b })); });
      q.on("error", ko); if (body) q.write(J(body)); q.end();
    });
    for (const t of [apr.body.token, B.operator]) {
      const r = await remote(t);
      assert.ok(r.status >= 400 && !r.text.includes(F.ids.a), "远程 GET 被拒:" + r.status);
      assert.ok((await remote(t, "PUT", "/api/desktop-sessions/selection", put)).status >= 400, "远程 PUT 被拒");
    }
    assert.equal((await B.api("GET", "/api/desktop-sessions?selected=1", B.operator)).body.sessions.length, 0);
  } finally { await B.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("目录缺失:进 unavailable,不报错", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "desksessions-none-"));
  const B = await board(dir, { claude: join(dir, "no-claude"), codex: join(dir, "no-codex") });
  try {
    const r = await B.api("GET", "/api/desktop-sessions", B.operator);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.sessions, []);
    assert.deepEqual(r.body.unavailable.map((u) => u.source), ["claude", "codex"]);
    assert.ok(r.body.unavailable.every((u) => typeof u.reason === "string" && !u.reason.includes(dir)), "原因里不带路径");
    const c = await B.api("GET", "/api/desktop-sessions?source=codex", B.operator);
    assert.deepEqual(c.body.unavailable.map((u) => u.source), ["codex"]);
  } finally { await B.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("勾选:增删幂等、不存在的 id 拒绝、上限 50、SSE、重启保留、missing 标记", { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "desksessions-sel-")), F = fixtures(dir);
  const extra = Array.from({ length: 50 }, () => randomUUID());
  for (const id of extra) writeFileSync(join(F.P2, id + ".jsonl"), J({ type: "ai-title", aiTitle: "批量" }) + "\n");
  let B = await board(dir, F);
  try {
    const sel = (body, t = B.operator) => B.api("PUT", "/api/desktop-sessions/selection", t, body);
    // SSE:改动推 desktop-sessions.changed
    const ac = new AbortController();
    const sse = await fetch(B.base + "/api/events", { headers: { "X-Board-Token": B.operator }, signal: ac.signal });
    let seen = ""; const reader = sse.body.getReader(); const dec = new TextDecoder();
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; seen += dec.decode(value); } } catch {} })();
    const A = { source: "claude", id: F.ids.a }, X = { source: "codex", id: F.ids.x };
    let r = await sel({ add: [A, X] });
    assert.deepEqual([r.status, r.body], [200, { selected: 2 }], r.text);
    for (let i = 0; i < 50 && !seen.includes("desktop-sessions.changed"); i++) await delay(100);
    assert.ok(seen.includes('"type":"desktop-sessions.changed"'), "勾选改动推 SSE");
    assert.deepEqual((await sel({ add: [A, { source: "claude", id: F.ids.a.toUpperCase() }] })).body, { selected: 2 }, "重复 add 幂等");
    assert.deepEqual((await sel({ remove: [{ source: "claude", id: randomUUID() }] })).body, { selected: 2 }, "remove 不存在的项幂等");
    assert.deepEqual((await sel({})).body, { selected: 2 });
    const nf = await sel({ add: [{ source: "claude", id: randomUUID() }] });
    assert.deepEqual([nf.status, nf.body.code], [400, "NOT_FOUND"], "本机没有的对话不收");
    assert.equal((await sel({ add: [{ source: "codex", id: F.ids.z }] })).status, 400, "Codex 子代理线程不收");
    assert.equal((await sel({ add: [{ source: "codex", id: F.ids.a }] })).status, 400, "来源对不上不收");
    for (const bad of [{ add: "x" }, { add: [{ source: "gpt", id: F.ids.a }] }, { add: [{ source: "claude", id: "../x" }] },
                       { add: [{ source: "claude", id: F.ids.a + "\n" }] }, [1], "{坏"])
      assert.equal((await sel(bad)).status, 400, J(bad));
    // selected=1:只列勾选的,不受 days 限制(A 是 10 天前的)
    const only = await B.api("GET", "/api/desktop-sessions?selected=1&days=1", B.operator);
    assert.deepEqual(only.body.sessions.map((s) => [s.id, s.selected]).sort(), [[F.ids.a, true], [F.ids.x, true]].sort());
    const full = await B.api("GET", "/api/desktop-sessions?source=claude&limit=200", B.operator);
    assert.equal(full.body.sessions.find((s) => s.id === F.ids.a).selected, true);
    assert.equal(full.body.sessions.find((s) => s.id === F.ids.b).selected, false);
    // 上限 50:超了 400,原状不变
    const over = await sel({ add: extra.map((id) => ({ source: "claude", id })) });
    assert.equal(over.status, 400); assert.match(over.body.error, /50/);
    assert.equal((await B.api("GET", "/api/desktop-sessions?selected=1", B.operator)).body.sessions.length, 2, "超限整批不落地");
    assert.deepEqual((await sel({ add: extra.slice(0, 48).map((id) => ({ source: "claude", id })) })).body, { selected: 50 });
    assert.equal((await sel({ add: [{ source: "claude", id: extra[49] }] })).status, 400);
    assert.deepEqual((await sel({ remove: extra.slice(0, 48).map((id) => ({ source: "claude", id })) })).body, { selected: 2 });
    // 存储只有 {source,id,added_at},在数据目录里
    const stored = JSON.parse(readFileSync(join(dir, "desktop_sessions_selected.json"), "utf8"));
    assert.deepEqual(stored.items.map((x) => Object.keys(x).sort()), [["added_at", "id", "source"], ["added_at", "id", "source"]]);
    ac.abort(); await pump;
    // 重启保留
    await B.stop(); B = await board(dir, F);
    assert.equal((await B.api("GET", "/api/desktop-sessions?selected=1", B.operator)).body.sessions.length, 2, "重启后勾选还在");
    // 文件不在了 → missing:true,可被 remove
    unlinkSync(F.paths.a);
    const m = await B.api("GET", "/api/desktop-sessions?selected=1", B.operator);
    const gone = m.body.sessions.find((s) => s.id === F.ids.a);
    assert.equal(gone.missing, true); assert.equal(gone.selected, true); assert.equal(gone.title, null);
    assert.equal(m.body.sessions.find((s) => s.id === F.ids.x).missing, undefined);
    assert.deepEqual((await B.api("PUT", "/api/desktop-sessions/selection", B.operator, { remove: [A] })).body, { selected: 1 });
    assert.equal((await B.api("PUT", "/api/desktop-sessions/selection", B.operator, { add: [A] })).status, 400, "文件不在了就不能再勾");
  } finally { await B.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 历史与登记成线(合同 D 节)
const TOOL_IN = "TOOL_INPUT_MARK", TOOL_OUT = "TOOL_RESULT_MARK", THINK = "THINK_MARK", META = "META_MARK";
const hash8 = (id) => createHash("sha256").update(id).digest("hex").slice(0, 8);
function historyFixtures(F) {
  const h = randomUUID(), big = randomUUID(), cx = randomUUID();
  const ts = (i) => new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
  const u = (i, content, extra = {}) => J({ type: "user", timestamp: ts(i), message: { role: "user", content }, ...extra });
  const a = (i, content) => J({ type: "assistant", timestamp: ts(i), message: { role: "assistant", content } });
  const tool = { type: "tool_use", id: "t", name: "Bash", input: { command: TOOL_IN } };
  writeFileSync(join(F.P2, h + ".jsonl"), [
    J({ type: "custom-title", customTitle: "历史夹具" }),
    u(1, "问一"),
    a(2, [{ type: "thinking", thinking: THINK }, { type: "text", text: "答一" }, tool]),
    a(3, [tool]),
    u(4, [{ type: "tool_result", tool_use_id: "t", content: TOOL_OUT }], { toolUseResult: { stdout: TOOL_OUT } }),
    a(5, [tool]),
    a(6, [{ type: "text", text: "答二" }]),
    u(7, META, { isMeta: true }),
    u(8, "<command-name>/x</command-name>"),
    u(9, [{ type: "text", text: "问二" }]),
    "{坏行",
    a(10, [{ type: "text", text: "长".repeat(5000) }]),
    J({ type: "attachment", attachment: { content: META } }),
  ].join("\n") + "\n");
  writeFileSync(join(F.P2, big + ".jsonl"), [
    J({ type: "custom-title", customTitle: "大体量" }), u(1, "问"),
    J({ type: "assistant", message: { content: [{ type: "text", text: "答" }], usage: { input_tokens: 250000 } } })].join("\n") + "\n");
  const day = join(F.codex, "sessions", "2026", "11", "02"); mkdirSync(day, { recursive: true });
  const ri = (i, payload) => J({ timestamp: ts(i), type: "response_item", payload });
  writeFileSync(join(day, `rollout-2026-11-02T10-00-00-${cx}.jsonl`), [
    J({ timestamp: ts(0), type: "session_meta", payload: { id: cx, cwd: "C:\\demo\\codex", source: "vscode", thread_source: "user" } }),
    ri(1, { type: "message", role: "developer", content: [{ type: "input_text", text: META }] }),
    ri(2, { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>" + META + "</environment_context>" }] }),
    ri(3, { type: "message", role: "user", content: [{ type: "input_text", text: "Codex 问" }] }),
    ri(4, { type: "reasoning", summary: [{ type: "summary_text", text: THINK }] }),
    ri(5, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex 答" }] }),
    ri(6, { type: "function_call", name: "shell", arguments: TOOL_IN }),
    ri(7, { type: "function_call_output", output: TOOL_OUT }),
    ri(8, { type: "custom_tool_call", name: "apply_patch", input: TOOL_IN }),
    ri(9, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex 完" }] }),
  ].join("\n") + "\n");
  return { h, big, cx };
}

test("历史:只给文字、工具折叠成个数、分页游标、单条截 4000 字", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "desksessions-hist-")), F = fixtures(dir), H = historyFixtures(F);
  const B = await board(dir, F);
  try {
    const all = await B.api("GET", `/api/desktop-sessions/claude/${H.h}/messages?limit=200`, B.operator);
    assert.equal(all.status, 200, all.text);
    for (const mark of [TOOL_IN, TOOL_OUT, THINK, META, "command-name"]) assert.ok(!all.text.includes(mark), "不含 " + mark);
    const flat = all.body.messages.map((x) => [x.role, x.text.slice(0, 3), x.tools]);
    assert.deepEqual(flat, [["user", "问一", 0], ["assistant", "答一", 3], ["assistant", "答二", 0], ["user", "问二", 0], ["assistant", "长长长", 0]]);
    assert.equal(all.body.next_before, null);
    assert.equal([...all.body.messages[4].text].length, 4000, "单条截到 4000 字");
    assert.deepEqual(Object.keys(all.body.messages[0]).sort(), ["at", "role", "text", "tools"]);
    assert.equal(all.body.messages[0].at, new Date(Date.UTC(2026, 10, 1, 0, 1)).toISOString());
    // 分页:每页 2 条,拼起来与一次取完相同
    const pages = []; let before = null;
    for (let i = 0; i < 10; i++) {
      const r = await B.api("GET", `/api/desktop-sessions/claude/${H.h}/messages?limit=2${before ? "&before=" + before : ""}`, B.operator);
      assert.equal(r.status, 200, r.text);
      pages.unshift(...r.body.messages);
      before = r.body.next_before;
      if (before === null) break;
      assert.ok(Number.isInteger(before) && before > 0);
    }
    assert.deepEqual(pages, all.body.messages, "分页拼回与一次取完相同");
    const cx = await B.api("GET", `/api/desktop-sessions/codex/${H.cx}/messages`, B.operator);
    assert.equal(cx.status, 200, cx.text);
    for (const mark of [TOOL_IN, TOOL_OUT, THINK, META]) assert.ok(!cx.text.includes(mark), "Codex 不含 " + mark);
    assert.deepEqual(cx.body.messages.map((x) => [x.role, x.text, x.tools]),
                     [["user", "Codex 问", 0], ["assistant", "Codex 答", 2], ["assistant", "Codex 完", 0]]);
    assert.equal((await B.api("GET", `/api/desktop-sessions/claude/${randomUUID()}/messages`, B.operator)).status, 404);
    assert.equal((await B.api("GET", `/api/desktop-sessions/codex/${F.ids.z}/messages`, B.operator)).status, 404, "子代理线程不给看");
    for (const bad of ["before=0", "before=-1", "before=abc", "before=99999999999", "limit=0"])
      assert.equal((await B.api("GET", `/api/desktop-sessions/claude/${H.h}/messages?${bad}`, B.operator)).status, 400, bad);
    assert.ok(!B.logs().includes("问一") && !B.logs().includes("Codex 答"), "正文不进看板日志");
    assert.ok(!existsSync(join(dir, "desktop_lineage.json")), "看历史不落盘");
  } finally { await B.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// F10:超长单行。模块层用很小的读取上限(块 4KB / 单行 64KB / 每页 128KB)把「一行比每页上限还长」造出来,
// 真看板层用缺省上限(单行 4MB)放一条 5MB 的行。
test("历史超长单行(F10):游标严格前进直到 null、给「这条太长,已省略」、工具结果超长行静默跳过、正文不外泄", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desksessions-long-"));
  try {
    const { createDesktopSessions, MSG_OMITTED_TEXT } = await import(new URL("../core/desktop-sessions.mjs", import.meta.url).href);
    const root = join(dir, "claude"), proj = join(root, "p1"), id = randomUUID();
    mkdirSync(proj, { recursive: true });
    const X = "X".repeat(300 * 1024), Y = "Y".repeat(90 * 1024);
    const u = (t, content, extra = {}) => J({ type: "user", message: { role: "user", content }, timestamp: t, ...extra });
    const a = (t, text) => J({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, timestamp: t });
    writeFileSync(join(proj, id + ".jsonl"), [
      u("2026-11-01T00:00:01Z", "第一"),
      u("2026-11-01T00:00:02Z", [{ type: "text", text: X }]),                                   // 比每页上限还长
      a("2026-11-01T00:00:03Z", "第二"),
      u("2026-11-01T00:00:04Z", [{ type: "tool_result", tool_use_id: "t", content: X }]),     // 工具结果:本来就不显示
      a("2026-11-01T00:00:05Z", Y),                                                           // 超单行上限、没超每页上限
      u("2026-11-01T00:00:06Z", "第三"),
    ].join("\n") + "\n");
    const ds = createDesktopSessions({ claudeRoot: root, codexRoot: join(dir, "nocodex"), dataDir: dir,
                                       readLimits: { chunk: 4096, line: 64 * 1024, scan: 128 * 1024 } });
    for (const limit of [200, 1]) {
      const got = []; let before = null, prev = Infinity, pages = 0;
      for (;;) {
        const r = ds.messages("claude", id, { limit, before });
        pages++;
        assert.ok(pages < 50, `limit=${limit}: 翻页不收敛`);
        assert.ok(!JSON.stringify(r).includes("XXXX") && !JSON.stringify(r).includes("YYYY"), "超长行正文不外泄");
        got.unshift(...r.messages);
        if (r.next_before === null) break;
        assert.ok(r.next_before < prev, `limit=${limit}: next_before 必须严格变小(${r.next_before} ≥ ${prev})`);
        prev = before = r.next_before;
      }
      assert.deepEqual(got.map((m) => [m.role, m.text, !!m.omitted]),
        [["user", "第一", false], ["user", MSG_OMITTED_TEXT, true], ["assistant", "第二", false], ["assistant", MSG_OMITTED_TEXT, true], ["user", "第三", false]],
        `limit=${limit}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("历史超长单行(F10)真看板:5MB 的一行给占位、翻页到 null", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "desksessions-long2-")), F = fixtures(dir);
  const id = randomUUID(), proj = join(F.claude, "plong"); mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, id + ".jsonl"), [
    J({ type: "user", message: { role: "user", content: "前" }, timestamp: "2026-11-01T00:00:01Z" }),
    J({ type: "user", message: { role: "user", content: [{ type: "text", text: "Z".repeat(5 * 1024 * 1024) }] }, timestamp: "2026-11-01T00:00:02Z" }),
    J({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "后" }] }, timestamp: "2026-11-01T00:00:03Z" }),
  ].join("\n") + "\n");
  const B = await board(dir, F);
  try {
    const r = await B.api("GET", `/api/desktop-sessions/claude/${id}/messages?limit=200`, B.operator);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.deepEqual(r.body.messages.map((m) => [m.role, m.text]), [["user", "前"], ["user", "这条太长,已省略"], ["assistant", "后"]]);
    assert.equal(r.body.next_before, null);
    assert.ok(!r.text.includes("ZZZZ"));
  } finally { await B.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("登记成线:建线/重复 409/未知会话/大体量确认/解除/手写 lineage.json 兼容/鉴权/重启保留", { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "desksessions-lines-")), F = fixtures(dir), H = historyFixtures(F);
  // 旧的手写 lineage.json:没有 source 字段 = claude
  writeFileSync(join(dir, "lineage.json"), J({ _comment: "手写", hand1: { session: F.ids.b, anchor: "docs/x.md" } }));
  let B = await board(dir, { ...F, config: { lines: [{ id: "alpha" }, { id: "hand1" }] } });
  try {
    const reg = await B.api("POST", "/api/coord/executors", B.operator, { id: "ext1", name: "外部", kind: "external" });
    assert.equal(reg.status, 201, reg.text);
    const post = (body, t = B.operator) => B.api("POST", "/api/desktop-sessions/lines", t, body);
    for (const t of [B.worker, B.review, reg.body.token]) {
      assert.equal((await post({ source: "claude", id: F.ids.a }, t)).status, 403);
      assert.equal((await B.api("GET", `/api/desktop-sessions/claude/${H.h}/messages`, t)).status, 403);
      assert.equal((await B.api("DELETE", "/api/desktop-sessions/lines/hand1", t)).status, 403);
    }
    assert.equal((await post({ source: "claude", id: F.ids.a }, null)).status, 401);
    const r = await post({ source: "claude", id: F.ids.a.toUpperCase() });
    assert.equal(r.status, 201, r.text);
    const lineA = "claude-" + hash8(F.ids.a);
    assert.deepEqual(r.body.line, { id: lineA, label: "Claude 会话 " + hash8(F.ids.a), runtime: "claude",
                                    lineage: { source: "claude", session_id_hash: hash8(F.ids.a), forked: false } });
    assert.equal(r.body.approx_tokens, 117); assert.equal(r.body.threshold_tokens, 200000);
    assert.ok(!r.text.toLowerCase().includes(F.ids.a), "不回会话 id 原文");
    assert.ok(!r.text.includes("合成对话"), "缺省显示名不用会话标题");
    const dup = await post({ source: "claude", id: F.ids.a });
    assert.deepEqual([dup.status, dup.body.code], [409, "ALREADY_A_LINE"]);
    const handDup = await post({ source: "claude", id: F.ids.b });
    assert.deepEqual([handDup.status, handDup.body.code, handDup.body.line], [409, "ALREADY_A_LINE", "hand1"], "手写 lineage.json 的会话也算已登记");
    for (const bad of [{ source: "claude", id: randomUUID() }, { source: "codex", id: F.ids.z }, { source: "gpt", id: F.ids.a }, { source: "codex", id: F.ids.a }]) {
      const x = await post(bad);
      assert.deepEqual([x.status, x.body.code], [400, "SESSION_UNKNOWN"], J(bad));
    }
    const lg = await post({ source: "claude", id: H.big });
    assert.deepEqual([lg.status, lg.body.code, lg.body.approx_tokens], [400, "NEEDS_CONFIRM_LARGE", 250000]);
    assert.ok(!lg.text.includes(H.big));
    assert.equal((await post({ source: "claude", id: H.big, confirm_large: true, label: "大会话" })).status, 201);
    const c = await post({ source: "codex", id: F.ids.x, label: "Codex 线" });
    assert.equal(c.status, 201, c.text);
    const lineX = "codex-" + hash8(F.ids.x);
    assert.equal(c.body.line.runtime, "codex");
    const ws = await B.api("GET", "/api/workers", B.operator);
    const wX = ws.body.workers.find((w) => w.line === lineX), wA = ws.body.workers.find((w) => w.line === lineA);
    assert.equal(wX.settings.agents[0].runtime, "codex", "运行时 = 会话来源");
    assert.equal(wA.settings.agents[0].runtime, "claude");
    assert.equal(wX.running, false, "登记不等于启动");
    assert.deepEqual([wA.lineage.configured, wA.lineage.forked], [true, false]);
    assert.equal(ws.body.workers.find((w) => w.line === "hand1").lineage.anchor, "docs/x.md", "手写项照旧生效");
    assert.ok(!JSON.stringify(ws.body).includes(F.ids.a), "/api/workers 不带会话 id");
    const list = async () => Object.fromEntries((await B.api("GET", "/api/desktop-sessions?limit=200", B.operator)).body.sessions.map((s) => [s.id, s.line?.id ?? null]));
    let L = await list();
    assert.deepEqual([L[F.ids.a], L[F.ids.x], L[F.ids.b], L[F.ids.c]], [lineA, lineX, "hand1", null]);
    // 接口补充:顶层阈值;列表项 line = {id,label};登记了但起不来(Codex 座席未解禁)带 start_blocked,能起的为 null
    const full = (await B.api("GET", "/api/desktop-sessions?limit=200", B.operator)).body;
    assert.deepEqual([full.threshold_tokens, full.threshold_bytes], [200000, 4 * 1024 * 1024]);
    const row = Object.fromEntries(full.sessions.map((s) => [s.id, s]));
    assert.deepEqual(row[F.ids.a].line, { id: lineA, label: "Claude 会话 " + hash8(F.ids.a) });
    assert.deepEqual(row[F.ids.x].line, { id: lineX, label: "Codex 线" });
    assert.equal(row[F.ids.a].start_blocked, null, "Claude 座席能起");
    assert.equal(row[F.ids.c].start_blocked, null, "没登记的也是 null");
    assert.equal(row[F.ids.x].start_blocked?.code, "SEAT_LOCKED", J(row[F.ids.x].start_blocked));
    assert.match(row[F.ids.x].start_blocked.message, /BOARD_CODEX_RELEASED/);
    assert.equal(c.body.start_blocked?.code, "SEAT_LOCKED", "201 里也带");
    assert.equal(r.body.start_blocked, null);
    assert.deepEqual([row[F.ids.a].line_forked, row[F.ids.a].line_forked_at], [false, null], "还没从会话起步");
    // 线第一次领卡时 fork 出一个会话副本(这里用另一个已有会话的 id 充当副本):清单默认不列副本,line_forked 变真
    const fk = await B.api("POST", `/api/workers/${lineA}/forked`, B.operator, { session_id: F.ids.d });
    assert.equal(fk.status, 200, fk.text);
    const after = Object.fromEntries((await B.api("GET", "/api/desktop-sessions?limit=200", B.operator)).body.sessions.map((s) => [s.id, s]));
    assert.equal(after[F.ids.d], undefined, "看板自己 fork 出来的副本默认不列(与原会话同标题,会被再登记成第二条线)");
    assert.ok(after[F.ids.a], "原会话照列");
    assert.equal(after[F.ids.a].line_forked, true); assert.ok(!Number.isNaN(Date.parse(after[F.ids.a].line_forked_at)));
    const withForks = (await B.api("GET", "/api/desktop-sessions?limit=200&include_forks=1", B.operator)).body.sessions;
    assert.ok(withForks.some((s) => s.id === F.ids.d), "include_forks=1 才列副本");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "desktop_forks.json"), "utf8")).forks, ["claude:" + F.ids.d], "副本进只增不减的清单");
    const fc = await post({ source: "claude", id: F.ids.d });
    assert.deepEqual([fc.status, fc.body.code], [409, "FORK_COPY"], "副本不能登记成线");
    const stored =JSON.parse(readFileSync(join(dir, "desktop_lineage.json"), "utf8"));
    assert.deepEqual(Object.keys(stored.lines).sort(), [lineA, lineX, "claude-" + hash8(H.big)].sort(), "数据目录里只存面板登记的");
    // 重启保留
    await B.stop(); B = await board(dir, { ...F, config: JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8")) });
    L = await list();
    assert.deepEqual([L[F.ids.a], L[F.ids.x], L[F.ids.b]], [lineA, lineX, "hand1"], "重启后继承还在");
    assert.equal((await B.api("POST", "/api/desktop-sessions/lines", B.operator, { source: "claude", id: F.ids.a })).status, 409);
    // 解除
    const del = await B.api("DELETE", `/api/desktop-sessions/lines/${lineA}`, B.operator);
    assert.deepEqual([del.status, del.body.line], [200, { id: lineA, lineage: null }], del.text);
    assert.equal((await list())[F.ids.a], null);
    assert.ok((await B.api("GET", "/api/workers", B.operator)).body.workers.some((w) => w.line === lineA && !w.lineage), "线保留、继承解除");
    assert.equal((await B.api("DELETE", `/api/desktop-sessions/lines/${lineA}`, B.operator)).status, 404);
    // W1:解除登记后副本仍不列、仍登记不成线(清单只增不减)
    const ids = async () => new Set((await B.api("GET", "/api/desktop-sessions?limit=200", B.operator)).body.sessions.map((s) => s.id));
    assert.ok(!(await ids()).has(F.ids.d), "解除登记后副本也不回到清单");
    assert.deepEqual((await post({ source: "claude", id: F.ids.d })).body.code, "FORK_COPY");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "desktop_forks.json"), "utf8")).forks, ["claude:" + F.ids.d], "解除登记不清清单");
    const hd = await B.api("DELETE", "/api/desktop-sessions/lines/hand1", B.operator);
    assert.deepEqual([hd.status, hd.body.code], [409, "LINEAGE_HANDWRITTEN"]);
    assert.equal((await B.api("DELETE", "/api/desktop-sessions/lines/alpha", B.operator)).status, 404);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "desktop_lineage.json"), "utf8")).lines).sort(), [lineX, "claude-" + hash8(H.big)].sort());
    // P6:解除后同一会话可以重新登记(沿用原来那条线,不新建、不改显示名)
    const again = await post({ source: "claude", id: F.ids.a, label: "新名字" });
    assert.equal(again.status, 201, again.text);
    assert.deepEqual([again.body.line.id, again.body.line.label, again.body.reattached], [lineA, "Claude 会话 " + hash8(F.ids.a), true]);
    assert.equal((await list())[F.ids.a], lineA);
    assert.ok(Object.keys(JSON.parse(readFileSync(join(dir, "desktop_lineage.json"), "utf8")).lines).includes(lineA));
    assert.equal(JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8")).lines.filter((l) => l.id === lineA).length, 1, "不重复建线");
    assert.equal((await post({ source: "claude", id: F.ids.a })).status, 409, "再登记一次仍 409");
    // F11:label 清掉换行、ESC、控制符、零宽与双向控制字符,限 24 字
    const dirty = await post({ source: "claude", id: F.ids.c, label: "a\nFAKE 日志行\u001b[31m\u202e名\u200b字\u200f\ufeff\u061c" });
    assert.equal(dirty.status, 201, dirty.text);
    assert.equal(dirty.body.line.label, "a FAKE 日志行[31m名字");
    const cfgLabel = JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8")).lines.find((l) => l.id === "claude-" + hash8(F.ids.c)).label;
    assert.equal(cfgLabel, "a FAKE 日志行[31m名字");
    assert.ok(!/\nFAKE/.test(B.logs()) && !B.logs().includes("\u001b") && !B.logs().includes("\u202e"), "日志里不出现伪造行与控制符");
    await B.api("DELETE", `/api/desktop-sessions/lines/claude-${hash8(F.ids.c)}`, B.operator);
    const long = await post({ source: "claude", id: F.ids.c });   // 重新登记沿用旧名;另找一个会话测限长
    assert.equal(long.status, 201, long.text);
    const lim = await post({ source: "codex", id: F.ids.y, label: "长".repeat(40) });
    if (lim.status === 201) assert.equal([...lim.body.line.label].length, 24, "限 24 字");
    else assert.fail("限长用例没登记上:" + lim.text);
    assert.ok(!B.logs().includes(F.ids.a) && !B.logs().includes(F.ids.x), "日志不带会话 id");
  } finally { await B.stop(); rmSync(dir, { recursive: true, force: true }); }
});
