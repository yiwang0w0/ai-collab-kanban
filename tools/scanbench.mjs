// 本地基准(合同 J1.7):事件路径与列卡口的开销。不进 CI、不进 npm test;不调用任何模型。
//   node tools/scanbench.mjs [--root <仓库根>] [--cards 200,1000] [--events 30]
//   --root 默认 = 本仓库;要比改前,把旧提交 git archive 到别处再用 --root 指过去(数据合成用的是 --root 下的 store.js)。
// 做法:临时数据目录起一次看板(建表)→ 停 → 直接往库里合成 N 张卡(约 30% 已完成,其余未开始;每张未完成卡带 --events 条
//   卡死相关与无关的卡历史;约 20% 的卡引用 10 张规格卡之一)→ 再起看板,等启动那一轮整板扫跑完 → 测:
//   ① 单个 task.* 事件 → 规则跑完:操作者改一张未开始卡的摘要(POST /update),紧接着 GET /health;
//      自动规则在应答之后的同一拍里同步跑完,所以「紧随其后的 GET 比单独 GET 慢多少」≈ 规则耗时。
//   ② task.live_note:执行者心跳带 note(每张卡第一次立即推事件),同样看紧随其后的 GET。
//   ③ 列卡口:执行者 GET /api/tasks?status=not_started&claimable=1。
//   ④ 全板 taskOut:操作者 GET /api/tasks?archived=false。
//   --goals 20:卡挂到 20 张目标下(目标卡的子卡计数逐行算)。
//   --ledger 10000,100000:改测额度 GET /api/home/quota 与助手简报 GET /api/brief(见 ledgerOne)。
// 定时兜底设成一小时(两边一样),免得测的途中插进一次整板扫。端口用 tests/helpers/free-port.mjs。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { freePort } from "../tests/helpers/free-port.mjs";

const HERE = fileURLToPath(new URL("../", import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = resolve(arg("--root", HERE));
const SIZES = String(arg("--cards", "200,1000")).split(",").map(Number).filter((n) => n > 0);
const EVENTS = Number(arg("--events", "30"));
const GOALS = Number(arg("--goals", "0"));   // >0:卡平均挂到这么多张目标下(测 flow.goalCounts 等按目标的字段)
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:BOARD_|WORKER_|REVIEWER_|REVIEW_|KANBAN_)/i.test(k)));
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Number(s[Math.floor(s.length / 2)].toFixed(2)) : null; };
const ms = async (fn) => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

async function start(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "core/server.mjs")], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...ENV, BOARD_HOST: "127.0.0.1", BOARD_PORT: String(port), BOARD_CONFIG: join(dir, "fleet.json"), BOARD_DATA_DIR: dir, BOARD_DB: join(dir, "board.db"),
           BOARD_REPO: dir, BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_RESTART_MODE: "exit", BOARD_DELIVERABLE_GATE: "off",
           BOARD_INTEGRATE_SCAN_MS: "3600000", BOARD_REAP_MS: "3600000", BOARD_CLAUDE_PROJECTS: join(dir, "fake-projects"), BOARD_CODEX_HOME: join(dir, "fake-codex") } });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await delay(100); }
  const api = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { "X-Board-Token": token } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  return { base, api, stop: async () => { child.kill(); await closed; } };
}

function synth(dir, n) {
  const require = createRequire(join(ROOT, "core", "store.js"));
  const store = require(join(ROOT, "core", "store.js"));
  const db = new DatabaseSync(join(dir, "board.db"));
  db.exec("PRAGMA busy_timeout=5000");
  const kinds = ["reap", "report", "resolve", "heartbeat_note", "release", "claim"];
  const now = new Date().toISOString();
  db.exec("BEGIN");
  const specs = [];
  for (let i = 0; i < 10; i++) specs.push(store.add(db, { subject: `fixture spec ${i}`, description: "example", line: "alpha", released: 1 }));
  const ev = db.prepare("INSERT INTO task_events(at, task_id, kind, actor, detail) VALUES(?,?,?,?,?)");
  const ref = db.prepare("INSERT OR IGNORE INTO task_refs(task_id, card, review, pinned_version, pinned_hash, by_, at) VALUES(?,?,?,?,?,?,?)");
  const open = [], goals = [];
  for (let i = 0; i < GOALS; i++) goals.push(store.add(db, { subject: `fixture goal ${i}`, kind: "goal", released: 1 }));
  for (let i = 0; i < n; i++) {
    const id = store.add(db, { subject: `fixture card ${i}`, description: "example description", acceptance: "example", line: "alpha", released: 1,
                               ...(goals.length ? { parentId: goals[i % goals.length] } : {}) });
    if (i % 10 < 3) { db.prepare("UPDATE tasks SET status='done', resolved_at=? WHERE id=?").run(now, id); }
    else open.push(id);
    for (let k = 0; k < EVENTS; k++) {
      const kind = kinds[(i + k) % kinds.length];
      const detail = kind === "report" ? { outcome: k % 4 ? "wait" : "done", run_id: `r${k}` } : kind === "resolve" ? { disposition: "hand_back" } : {};
      ev.run(now, id, kind, kind === "resolve" ? "review" : "system", JSON.stringify(detail));
    }
    if (i % 5 === 0) ref.run(id, specs[i % specs.length], 0, 1, "0".repeat(64), "operator", now);
  }
  db.exec("COMMIT");
  db.close();
  return open;
}

async function one(n) {
  const dir = mkdtempSync(join(tmpdir(), "scanbench-"));
  mkdirSync(join(dir, "fake-projects")); mkdirSync(join(dir, "fake-codex"));
  writeFileSync(join(dir, "fleet.json"), JSON.stringify({ lines: [{ id: "alpha", label: "fixture", external: true }], roles: [], routes: ["default"], repo: dir }));
  try {
    let B = await start(dir); await B.stop();          // 建表
    const open = synth(dir, n);
    B = await start(dir);
    await delay(n >= 1000 ? 8000 : 3000);               // 启动那一轮整板扫
    const operator = readFileSync(join(dir, "board_token"), "utf8").trim();
    const health = async () => ms(() => fetch(B.base + "/health").then((r) => r.text()));
    for (let i = 0; i < 5; i++) await health();
    const plain = []; for (let i = 0; i < 20; i++) plain.push(await health());
    // ① task.* 事件
    const after = [], post = [];
    for (let i = 0; i < 20; i++) {
      const id = open[(i * 7) % open.length];
      const t = (await B.api("GET", `/api/tasks/${id}`, operator)).body.task;
      post.push(await ms(() => B.api("POST", `/api/tasks/${id}/update`, operator, { expected_version: t.aggregate_version, summary: "bench " + i })));
      after.push(await health());
      await delay(50);
    }
    // ② live_note:5 个执行者各领一张、第一次心跳(task.started)后再带 note
    const notes = [];
    let exToken = null;
    for (let i = 0; i < 5; i++) {
      const c = await B.api("POST", "/api/connect/codes", operator, { kind: "other", line: "alpha" });
      const r = await B.api("POST", "/api/connect/redeem", null, { code: c.body.code });
      const tok = r.body.token; exToken ??= tok;
      // 新建一张(合成的卡多半已到卡死阈值,领不走)
      const t = (await B.api("POST", "/api/tasks", operator, { subject: "bench live note " + i, line: "alpha", description: "example", acceptance: "example" })).body.task;
      const id = t.id;
      const cl = await B.api("POST", `/api/tasks/${id}/claim`, tok, { expected_version: t.aggregate_version });
      if (cl.status !== 200) { console.error("claim", cl.status, JSON.stringify(cl.body).slice(0, 200)); continue; }
      await B.api("POST", `/api/tasks/${id}/heartbeat`, tok, { run_id: cl.body.task.run_id });
      await delay(n >= 1000 ? 1500 : 500);
      await B.api("POST", `/api/tasks/${id}/heartbeat`, tok, { run_id: cl.body.task.run_id, note: "bench note" });
      notes.push(await health());
      await delay(50);
    }
    // ③ 列卡口 ④ 全板 taskOut
    const list = []; for (let i = 0; i < 10; i++) list.push(await ms(() => B.api("GET", "/api/tasks?status=not_started&claimable=1", exToken)));
    const full = []; for (let i = 0; i < 5; i++) full.push(await ms(() => B.api("GET", "/api/tasks?archived=false", operator)));
    await B.stop();
    return { cards: n, events_per_card: EVENTS, health_ms: med(plain), update_post_ms: med(post), get_after_update_ms: med(after),
             rules_after_update_ms: Number((med(after) - med(plain)).toFixed(2)), get_after_live_note_ms: med(notes),
             rules_after_live_note_ms: notes.length ? Number((med(notes) - med(plain)).toFixed(2)) : null,
             list_claimable_ms: med(list), full_taskout_ms: med(full) };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// ⑤ 额度与简报(--ledger 10000,100000):账本合成 N 行(近 7 天内均匀分布,两池),200 张卡;
//   测操作者 GET /api/home/quota 与助手 GET /api/brief 的耗时(各 10 次取中位;第一次含账本首次归并,单列)。
async function ledgerOne(rowsN) {
  const dir = mkdtempSync(join(tmpdir(), "scanbench-l-"));
  mkdirSync(join(dir, "fake-projects")); mkdirSync(join(dir, "fake-codex"));
  writeFileSync(join(dir, "fleet.json"), JSON.stringify({ lines: [{ id: "alpha", label: "fixture", external: true }], roles: [], routes: ["default"], repo: dir }));
  try {
    let B = await start(dir); await B.stop();
    synth(dir, 200);
    const now = Date.now(), L = [];
    for (let i = 0; i < rowsN; i++) {
      const ts = new Date(now - Math.floor((i / rowsN) * 7 * 86400e3)).toISOString();
      L.push(JSON.stringify({ ts, card: null, attempt: null, worker: "alpha", line: "alpha", model: i % 2 ? "example-model-a" : "example-model-b", effort: null,
        sid: null, session_id: null, calls: 1, in: 100, cc: 10, cr: 20, out: 50, phase: "implement", duration_ms: 1000, cost_usd: 0.01,
        cost_source: "reported", cli_version: null, source: "managed", pool: i % 2 ? "claude" : "codex" }));
    }
    writeFileSync(join(dir, "usage_ledger.jsonl"), L.join(String.fromCharCode(10)) + String.fromCharCode(10));
    B = await start(dir);
    await delay(3000);
    const operator = readFileSync(join(dir, "board_token"), "utf8").trim();
    const c = await B.api("POST", "/api/connect/codes", operator, { kind: "other", role: "assistant", label: "fixture" });
    const as = (await B.api("POST", "/api/connect/redeem", null, { code: c.body.code })).body?.token;
    const q = await B.api("GET", "/api/home/quota", operator);
    const first = await ms(() => B.api("GET", "/api/home/quota", operator));
    const quota = []; for (let i = 0; i < 10; i++) quota.push(await ms(() => B.api("GET", "/api/home/quota", operator)));
    const brief = []; for (let i = 0; i < 10; i++) brief.push(await ms(() => B.api("GET", "/api/brief", as)));
    const bs = (await B.api("GET", "/api/brief", as)).status;
    await B.stop();
    return { ledger_rows: rowsN, quota_status: q.status, brief_status: bs, quota_second_ms: Number(first.toFixed(2)), quota_ms: med(quota), brief_ms: med(brief) };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

const out = [];
const LEDGER = arg("--ledger", null);
if (LEDGER) for (const n of String(LEDGER).split(",").map(Number).filter((x) => x > 0)) out.push(await ledgerOne(n));
else for (const n of SIZES) out.push(await one(n));
console.log(JSON.stringify(out, null, 2));
