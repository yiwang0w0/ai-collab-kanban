import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 证据文件(合同 H5):文件头伪装被拒、超 2MB 被拒且不落盘、第 11 个被拒、同哈希去重;只有持卡的执行者能传
// (非持卡者、助手、绑别的线的执行者、操作员都不行);读取只给操作员(带 nosniff 与沙箱 CSP),助手与执行者 404;sha256 乱值 400;
// 任务对象带 evidence 记录、助手只看件数;md 导出只写件数与哈希不带图;真 stdio 桥的 attach_evidence 在本侧先验。
// 测试图片全部现造(几十字节的合成文件头),不用任何真实截图。`node --test tests/evidencetest.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sniffImage, EVIDENCE_CSP } from "../core/evidence.mjs";
import { readEvidenceFile } from "../core/mcp/exec-bridge.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BRIDGE = join(ROOT, "cli", "exec-mcp.mjs");
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (tag) => Buffer.concat([PNG_HEAD, Buffer.from(`fixture-png-${tag}`)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fixture-jpeg-body")]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 fixture")]);
const sha = (b) => createHash("sha256").update(b).digest("hex");

async function board() {
  const dir = mkdtempSync(join(tmpdir(), "evidencetest-")), config = join(dir, "fleet.json");
  writeFileSync(config, JSON.stringify({ lines: [{ id: "alpha" }, { id: "ext", label: "外部", external: true }], roles: [], routes: ["default"], repo: dir }));
  const BAD_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
  let port;
  do { const l = createServer(); await new Promise((r) => l.listen(0, "127.0.0.1", r)); port = l.address().port; await new Promise((r) => l.close(r)); } while (BAD_PORTS.has(port));
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: config, BOARD_DATA_DIR: dir,
           BOARD_DB: join(dir, "board.db"), BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit" } });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  const upload = async (id, token, bytes, headers = {}) => {
    const r = await fetch(`${base}/api/tasks/${id}/evidence`, { method: "POST", body: bytes, signal: AbortSignal.timeout(15000),
      headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "image/png", ...headers } });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const operator = readFileSync(join(dir, "board_token"), "utf8").trim();
  const worker = readFileSync(join(dir, "worker_token"), "utf8").trim();
  const card = async (subject, line) => {
    const r = await api("POST", "/api/tasks", operator, { subject, line, description: "卡面材料", acceptance: "三句话" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.task;
  };
  const connectAs = async (body) => {
    const c = await api("POST", "/api/connect/codes", operator, body);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await api("POST", "/api/connect/redeem", null, { code: c.body.code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: r.body.executor_id, line: r.body.line, token: r.body.token };
  };
  const claim = async (t, token) => {
    const r = await api("POST", `/api/tasks/${t.id}/claim`, token, { expected_version: t.aggregate_version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.task;
  };
  const stored = () => existsSync(join(dir, "evidence_files")) ? readdirSync(join(dir, "evidence_files")) : [];
  const stop = async () => { child.kill(); await closed; try { rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, base, api, upload, operator, worker, card, connectAs, claim, stored, stop, log: () => log };
}

test("文件头判类型:png / jpeg / webp 认得;html、svg、短文件不认", () => {
  assert.equal(sniffImage(png("a")), "image/png");
  assert.equal(sniffImage(jpeg), "image/jpeg");
  assert.equal(sniffImage(webp), "image/webp");
  assert.equal(sniffImage(Buffer.from("<!doctype html><script>1</script>")), null);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImage(PNG_HEAD), null, "不足 12 字节不认");
});

test("上传:伪装被拒、超 2MB 不落盘、第 11 个被拒、同哈希去重、只有持卡者能传", { timeout: 120000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });           // 持卡者
    const Y = await B.connectAs({ kind: "other", line: "ext" });           // 同线的另一个执行者
    const Z = await B.connectAs({ kind: "codex" });                        // 绑别的线
    const A = await B.connectAs({ kind: "other", role: "assistant" });
    const t = await B.card("要截图的卡", "ext");
    const before = await B.upload(t.id, X.token, png("early"));
    assert.equal(before.status, 403, "还没领卡:不是持卡者");
    const held = await B.claim(t, X.token);

    // 文件头伪装:扩展名 / 声明类型是 png,内容是 html 或 svg
    for (const fake of [Buffer.from("<!doctype html><html><script>alert(1)</script></html>"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')]) {
      const r = await B.upload(t.id, X.token, fake, { "Content-Type": "image/png", "X-Evidence-Note": encodeURIComponent("shot.png") });
      assert.equal(r.status, 415, JSON.stringify(r.body)); assert.equal(r.body.code, "UNSUPPORTED_TYPE");
    }
    assert.deepEqual(B.stored(), [], "被拒的不落盘(连临时文件也不留)");

    // 超 2MB:声明了长度 → 立即拒;不声明长度、分块送 → 边收边数,超了就停
    const big = Buffer.concat([PNG_HEAD, Buffer.alloc(2 * 1024 * 1024)]);
    const r1 = await B.upload(t.id, X.token, big);
    assert.equal(r1.status, 413, JSON.stringify(r1.body));
    const streamed = await new Promise((resolve) => {
      const req = request(`${B.base}/api/tasks/${t.id}/evidence`, { method: "POST", headers: { "X-Board-Token": X.token, "Transfer-Encoding": "chunked" } }, (res) => {
        let s = ""; res.on("data", (d) => { s += d; }); res.on("end", () => resolve({ status: res.statusCode, body: s }));
      });
      req.on("error", (e) => resolve({ status: "reset", body: String(e.code) }));
      req.write(PNG_HEAD);
      const chunk = Buffer.alloc(256 * 1024);
      for (let i = 0; i < 10; i++) req.write(chunk);
      req.end();
    });
    assert.equal(streamed.status, 413, "读完再应答:对方读得到拒收原因,不是连接被重置 " + JSON.stringify(streamed));
    await delay(200);
    assert.deepEqual(B.stored(), [], "超 2MB 的不落盘");

    // 非持卡者、助手、绑别的线的执行者、操作员、受管线令牌
    assert.equal((await B.upload(t.id, Y.token, png("y"))).status, 403, "同线但不是持卡者");
    assert.equal((await B.upload(t.id, Z.token, png("z"))).status, 404, "绑别的线:别的线的卡当不存在");
    assert.equal((await B.upload(t.id, A.token, png("a"))).status, 403, "助手令牌不能传");
    assert.equal((await B.upload(t.id, B.operator, png("o"))).status, 403, "操作员也不代传");
    assert.equal((await B.upload(t.id, B.worker, png("w"))).status, 403, "受管线令牌不能传");
    assert.equal((await B.upload(t.id, X.token, png("run"), { "X-Run-Id": "not-this-run" })).status, 409, "run_id 对不上");
    assert.deepEqual(B.stored(), []);

    // 正常上传 + note 清洗 + 去重
    const note = "首页截图\n第二行" + String.fromCodePoint(0x202e) + " 在 C:\\Users\\you\\shots\\a.png";
    const ok1 = await B.upload(t.id, X.token, png(0), { "X-Run-Id": held.run_id, "X-Evidence-Note": encodeURIComponent(note) });
    assert.equal(ok1.status, 201, JSON.stringify(ok1.body));
    assert.equal(ok1.body.evidence.sha256, sha(png(0)));
    assert.equal(ok1.body.evidence.mime, "image/png");
    assert.equal(ok1.body.evidence.by, X.id);
    assert.equal(ok1.body.evidence.digest, null, "这张卡还没交付过(没有指纹)时 digest = null");
    assert.doesNotMatch(ok1.body.evidence.note, /\n|\u202e|Users/, "note 单行、去双向控制符、遮蔽路径");
    const dup = await B.upload(t.id, X.token, png(0));
    assert.equal(dup.status, 200); assert.equal(dup.body.deduped, true); assert.equal(dup.body.count, 1);
    assert.equal((await B.upload(t.id, X.token, jpeg)).status, 201);
    assert.equal((await B.upload(t.id, X.token, webp)).status, 201);
    for (let i = 1; i <= 7; i++) assert.equal((await B.upload(t.id, X.token, png(i))).status, 201);
    const eleventh = await B.upload(t.id, X.token, png(11));
    assert.equal(eleventh.status, 409); assert.equal(eleventh.body.code, "TOO_MANY");
    assert.equal(B.stored().length, 10, "按 sha256 存,10 个");
    assert.ok(B.stored().every((f) => /^[0-9a-f]{64}$/.test(f)), "文件名就是哈希,不带执行者给的名字");

    const task = (await B.api("GET", `/api/tasks/${t.id}`, B.operator)).body.task;
    assert.equal(task.evidence.length, 10); assert.equal(task.evidence_count, 10);
    assert.deepEqual(Object.keys(task.evidence[0]).sort(), ["at", "by", "bytes", "digest", "mime", "note", "sha256"]);
    const seenByAssistant = (await B.api("GET", `/api/tasks/${t.id}`, A.token)).body.task;
    assert.equal(seenByAssistant.evidence_count, 10); assert.ok(!("evidence" in seenByAssistant), "助手只看件数");
    const brief = await B.api("GET", "/api/brief", B.operator);
    assert.doesNotMatch(JSON.stringify(brief.body), new RegExp(sha(png(0))), "简报不带图");
  } finally { await B.stop(); }
});

test("读取:只给操作员(nosniff + 沙箱 CSP + 正确类型);助手与执行者 404;sha256 乱值 400;md 导出只写件数与哈希", { timeout: 90000 }, async () => {
  const B = await board();
  try {
    const X = await B.connectAs({ kind: "other", line: "ext" });
    const A = await B.connectAs({ kind: "other", role: "assistant" });
    const t = await B.card("读取", "ext");
    await B.claim(t, X.token);
    assert.equal((await B.upload(t.id, X.token, jpeg)).status, 201);
    const h = sha(jpeg), path = `/api/tasks/${t.id}/evidence/${h}`;
    const r = await fetch(B.base + path, { headers: { "X-Board-Token": B.operator } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/jpeg");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("content-security-policy"), EVIDENCE_CSP);
    assert.match(r.headers.get("content-security-policy"), /sandbox/);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(jpeg), "原样字节");
    for (const tok of [X.token, A.token, B.worker]) assert.equal((await B.api("GET", path, tok)).status, 404, "助手、执行者、受管线一律 404");
    for (const bad of ["..%2F..%2Fboard_token", "ABC", h.toUpperCase(), h.slice(0, 63), h + "0", "x".repeat(64)])
      assert.equal((await B.api("GET", `/api/tasks/${t.id}/evidence/${bad}`, B.operator)).status, 400, `乱值 ${bad.slice(0, 12)} → 400`);
    assert.equal((await B.api("GET", `/api/tasks/${t.id}/evidence/${sha(png("none"))}`, B.operator)).status, 404, "没记录的哈希 404");
    const other = await B.card("另一张", "alpha");
    assert.equal((await B.api("GET", `/api/tasks/${other.id}/evidence/${h}`, B.operator)).status, 404, "别的卡上没这张图 = 404(不按哈希跨卡读)");
    const md = await fetch(`${B.base}/api/tasks/${t.id}/export-md`, { headers: { "X-Board-Token": B.operator } }).then((x) => x.text());
    assert.match(md, /附图 1 张/); assert.match(md, new RegExp(h));
    assert.doesNotMatch(md, /data:image|base64|\/evidence\//, "导出不带图");
  } finally { await B.stop(); }
});

test("桥的 attach_evidence:本侧先验(绝对路径、≤2MB、文件头),再传字节;看板记下", { timeout: 90000 }, async () => {
  const B = await board();
  const files = mkdtempSync(join(tmpdir(), "evidencefiles-"));
  try {
    const good = join(files, "shot.png"), fake = join(files, "fake.png"), big = join(files, "big.png");
    writeFileSync(good, png("bridge")); writeFileSync(fake, "<svg/>xxxxxxxxxxxx"); writeFileSync(big, Buffer.concat([PNG_HEAD, Buffer.alloc(2 * 1024 * 1024)]));
    assert.ok(readEvidenceFile(good).equals(png("bridge")));
    assert.throws(() => readEvidenceFile(fake), (e) => e.code === "UNSUPPORTED_TYPE");
    assert.throws(() => readEvidenceFile(big), (e) => e.code === "TOO_LARGE");
    assert.throws(() => readEvidenceFile("shot.png"), (e) => e.code === "BAD_INPUT", "相对路径不收");
    assert.throws(() => readEvidenceFile(files), (e) => e.code === "BAD_INPUT", "目录不收");

    const X = await B.connectAs({ kind: "other", line: "ext" });
    const tokenFile = join(files, "x.token"); writeFileSync(tokenFile, X.token);
    const t = await B.card("桥附图", "ext");
    const M = spawn(process.execPath, [BRIDGE, "--url", B.base, "--token-file", tokenFile, "--line", "ext"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: HOST_ENV });
    let buf = ""; const waiting = new Map(); M.stdout.setEncoding("utf8");
    M.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
    let n = 1; const rpc = (method, params) => { const id = n++; M.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return new Promise((r) => waiting.set(id, r)); };
    const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
    try {
      await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
      M.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const card = (await call("get_card", { id: t.id })).structuredContent.card;
      assert.equal((await call("claim_card", { id: t.id, expected_version: card.aggregate_version })).isError, false);
      const bad = await call("attach_evidence", { card_id: t.id, path: fake });
      assert.equal(bad.isError, true); assert.equal(bad.structuredContent.code, "UNSUPPORTED_TYPE");
      const ok = await call("attach_evidence", { card_id: t.id, path: good, note: "首页" });
      assert.equal(ok.isError, false, JSON.stringify(ok));
      assert.equal(ok.structuredContent.sha256, sha(png("bridge")));
      assert.doesNotMatch(JSON.stringify(ok), /evidencefiles-/, "应答里不回显路径");
      const again = await call("attach_evidence", { card_id: t.id, path: good });
      assert.equal(again.structuredContent.deduped, true);
      const task = (await B.api("GET", `/api/tasks/${t.id}`, B.operator)).body.task;
      assert.deepEqual(task.evidence.map((e) => [e.sha256, e.note]), [[sha(png("bridge")), "首页"]]);
    } finally { M.stdin.end(); await new Promise((r) => M.once("close", r)); }
  } finally { await B.stop(); rmSync(files, { recursive: true, force: true }); }
});
