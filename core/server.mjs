import conflictGuide from './conflicts.js';
import {readFleetHealth} from './fleet-health.mjs';
import {inspectionError} from './inspection.mjs';
import {zcodeStatus,zcodeTaskField} from './zcode-status.mjs';
// Board HTTP layer — REST + SSE + static hosting. Zero dependencies
// (node:http / node:sqlite only).
//
// Start: node core/server.mjs
// Panel: http://127.0.0.1:47824
//
// Binds loopback only and authenticates all operational reads/writes. Anonymous
// access is limited to the pairing shell, health, and worker protocol discovery.
// Non-loopback binding remains refused; use the separate peer gateway for federation.

import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, createReadStream, openSync, readSync, closeSync, renameSync, unlinkSync, mkdirSync, chmodSync, mkdtempSync } from "node:fs";
import { randomUUID, createHash, randomInt, timingSafeEqual } from "node:crypto";
import { execFile, execFileSync, execSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";
import { createRequire } from "node:module";
import { nodeTooOld, backfillEnv, SEAT_KEYS } from "./env.mjs";
import { buildConfig, writeNewConfig, resolveClaudeCli } from "./config-setup.mjs";
import { resolveGit, gitRunner } from "./git-program.mjs";
import {readFleetView,readFleetTask,readFleetEvidencePage} from "./fleet-view.mjs";
import {readFleetProgress} from "./fleet-progress.mjs";
import {openFleetActions,loadFleetActionsConfig} from "./fleet-actions.mjs";
import {PeerError} from "./federation/protocol.mjs";
import {writePrivateText} from "./private-json.mjs";
import {taskExecutionView} from "./task-execution-view.mjs";
import {executorReadiness,runtimeVerifications} from "./executor-readiness.mjs";
import {readCliVersions} from "./cli-versions.mjs";
import {openConnect,isLoopback,defaultTokenDir} from "./connect.mjs";
import { faultReason, noteCleanExit, readRunRecord } from "./board-run.mjs";
import {loadExecutionProfiles,getExecutionProfile,publicExecutionProfiles,executionProfileSnapshot,profileEnvironment} from "./execution-profiles.mjs";
import {boardCliEnvironment,decomposeCliArgs,compactCliArgs,decomposePlanOf,cliResult} from "./board-claude-cli.mjs";
import {coordinatorSystemPrompt,buildTurnContent,buildRepairContent,coordinatorCliArgs,coordinatorCliEnvironment,argsFingerprint,
  coordinatorTurnOf,mergeTools,coordinatorCommand,runCoordinatorCli} from "./coordinator-cli.mjs";
import {directoryIdentity} from "./artifacts/git-workspace.mjs";
import {openLedger,usageHttp,externalRows,fromClaudeResult} from "./usage.mjs";
import {createDesktopSessions,SOURCES as DESK_SOURCES,LIMIT_DEFAULT as DESK_LIMIT_DEFAULT,LIMIT_MAX as DESK_LIMIT_MAX,
        MSG_LIMIT_DEFAULT as DESK_MSG_LIMIT_DEFAULT,MSG_LIMIT_MAX as DESK_MSG_LIMIT_MAX,loadDeskLineage,saveDeskLineage,cleanLineLabel} from "./desktop-sessions.mjs";
import {createFlow} from "./flow.mjs";
import {createEfficiency,efficiencyHttp} from "./efficiency.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
// ── Preflight: the one failure a newcomer could not read. store.js requires node:sqlite,
//    which requires Node 24 for transaction state; older runtimes can fail with a module
//    resolution stack trace that names nothing a person can act on. One sentence instead.
//    (python and git are already checked where they are used — the messages there are
//    readable; this is the only one that was not.)
if (nodeTooOld()) {
  console.error(`需要 Node ≥ 24.0.0(看板需要 SQLite 事务状态接口),当前 ${process.version} —— 升级 Node 后再启动。`
    + " node cli/doctor.mjs 可以一次看全所有前提。");
  process.exit(1);
}
const store = require_("./store.js");
const coord = require_("./coord.js");
const approvals = require_("./approvals.js");
const conversations = require_("./conversations.js");
const decision = require_("./decision_lib.js");
const decompose = require_("./decompose_lib.js");
const dgate = require_("../gates/deliverable_gate.js");

const CODE_ROOT = resolve(__dirname, "..");
const isAbsolutePath = (p) => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(p));
const LOOPS_DIR = join(__dirname, "..", "loops");

// ── Fleet configuration ───────────────────────────────────────────────────────
// The fleet vocabulary (lines, routes, seats) is the OPERATOR's, not this file's.
// BOARD_CONFIG points at a JSON file; default <BOARD repo>/fleet.config.json — the
// config is the board operator's file and lives with the BOARD install, never in
// the work repo (v0.3: it used to follow BOARD_REPO, which sent a deployment
// looking for its config inside the WORK repo). A MISSING file falls back to
// built-in defaults; a PRESENT-BUT-BROKEN file refuses startup (an operator
// config error is deterministic — silently running on defaults would wear the
// operator's config as a costume).
//
// v0.3: the config is the single DEPLOYMENT source of truth too — optional keys
// `port` / `repo` / `gated_subtree` replace the env choreography that produced a
// whole class of measured incidents (a moved port whose clients knocked on the
// default; a second shell missing the gate env). Env vars still WIN when set;
// the config is the floor under them, written once, read by server and every
// client alike (core/env.mjs · core/board_env.py).
const CONFIG_FILE = process.env.BOARD_CONFIG || join(CODE_ROOT, "fleet.config.json");
const BUILTIN_CONFIG = {
  lines: [
    // label = what the operator sees (Chinese); id = what machines use (CLI, config, slot names)
    { id: "alpha", hint: "开发", label: "开发" },
    { id: "coord", hint: "协调/裁定/跑命令", label: "协调" },
  ],
  // Built-in single-seat roles ("review" only; reorg was retired by operator
  // ruling 2026-09-02 — long dead upstream, never shipped here) join SUPERVISED
  // here AND their loop scripts exist under loops/. Empty until those ship.
  roles: [],
  routes: [store.DEFAULT_ROUTE],
  max_parallel: 3,
  default_agent: { runtime: "claude", model: "claude-opus-5", effort: "high", window: false },
  // Seat declarations. A seat declares its own capabilities (models + effort
  // domains); the code branches on the DECLARATION, never on the seat id — a new
  // runtime is "add a seat + a worker-loop adapter", not an edit spree.
  runtimes: [
    { id: "claude", label: "Claude Code",
      models: [
        { id: "claude-opus-5",    label: "Opus 5" },
        { id: "claude-sonnet-5",  label: "Sonnet 5" },
        { id: "claude-haiku-4-5", label: "Haiku 4.5" },
      ],
      efforts: ["low", "medium", "high", "xhigh", "max"] },
    // Reference second seat (measured values from the origin deployment; treat as
    // an EXAMPLE, not an endorsement). Ships locked: release_env must be "1" at
    // runtime AND cmd_env must point at the CLI before it can save or start.
    { id: "codex", label: "Codex CLI",
      release_env: "BOARD_CODEX_RELEASED", cmd_env: "BOARD_CODEX_CMD",
      models: [
        { id: "gpt-5.6-sol",         label: "5.6-sol",  efforts: ["low", "medium", "high", "xhigh"] },
        { id: "gpt-5.3-codex-spark", label: "Spark",    efforts: ["xhigh"] },
      ],
      efforts: ["low", "medium", "high", "xhigh"] },
  ],
  decompose_models: [{ id: "claude-opus-5", label: "Opus 5" }],
  // Natural language for generated card text. Null = mirror the board's own language.
  language: null,
};
let CFG = BUILTIN_CONFIG;
if (existsSync(CONFIG_FILE)) {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    CFG = { ...BUILTIN_CONFIG, ...raw };
    if (!Array.isArray(CFG.lines) || !CFG.lines.length) throw new Error("lines[] must be a non-empty array");
    if (!Array.isArray(CFG.routes) || !CFG.routes.length) throw new Error("routes[] must be a non-empty array");
    if (!Array.isArray(CFG.runtimes) || !CFG.runtimes.length) throw new Error("runtimes[] must be a non-empty array");
    if (CFG.host_auto_commit != null && typeof CFG.host_auto_commit !== "boolean") throw new Error("host_auto_commit 必须是布尔值");
    if (CFG.host_git != null && (typeof CFG.host_git !== "string" || !isAbsolutePath(CFG.host_git))) throw new Error("host_git 必须是 git 可执行文件的绝对路径");
    if (CFG.host_commit_timeout_sec != null && !(Number.isInteger(CFG.host_commit_timeout_sec) && CFG.host_commit_timeout_sec >= 10 && CFG.host_commit_timeout_sec <= 86400))
      throw new Error("host_commit_timeout_sec 必须是 10 到 86400 之间的整数(秒)");
  } catch (e) {
    console.error(`拒绝启动:${CONFIG_FILE} 存在但不可用 —— ${e.message}`);
    process.exit(1);
  }
}
// The codex seat's switches may live in the config (`npm run setup -- --codex`). Env still
// wins; seatUnlocked/seatCmdOk read process.env and the loops inherit it, so this is the
// whole wiring.
const BACKFILLED = backfillEnv(CFG, SEAT_KEYS);   // dropped from a respawned successor's env (restartBoard)
// Deployment keys (env > config > default). REPO_ROOT anchors the deliverable
// gate and the workers' cwd; the board's own code stays anchored at CODE_ROOT.
const REPO_ROOT = process.env.BOARD_REPO || (CFG.repo ? resolve(String(CFG.repo)) : CODE_ROOT);
const CFG_GATED_SUBTREE = process.env.BOARD_GATED_SUBTREE || (CFG.gated_subtree ? String(CFG.gated_subtree) : "");
// Git is never launched by name — Node looks in the process's current directory before
// PATH on Windows, and that directory can sit inside the model's write allowance. Resolved
// ONCE here (host config first: env WORKER_HOST_GIT, then fleet.config host_git; else the
// absolute directories of PATH), refused when it is a .bat/.cmd or lives inside the work
// repo / data directory; every call below spawns the absolute path. See core/git-program.mjs.
const GIT = resolveGit({ roots: [REPO_ROOT, store.DATA_DIR], configured: process.env.WORKER_HOST_GIT || CFG.host_git });
if (!GIT.path) console.error(`⚠ Git 不可用:${GIT.reason} —— 依赖 Git 的检查(交付闸、版本确认、未提交改动提示)按测不了处理`);
const runGit = gitRunner(GIT);
// Snapshot of the deployment keys AS READ AT BOOT — the setup guide compares it
// against the file on disk to answer "I edited the config, why nothing changed".
const CFG_AT_BOOT = { port: CFG.port ?? null, repo: CFG.repo ?? null, gated_subtree: CFG.gated_subtree ?? null };
// Migration hint: a config sitting where the OLD default looked (the work repo)
// is silently ignored now — say so once, loudly, instead of wearing defaults.
if (!process.env.BOARD_CONFIG && REPO_ROOT !== CODE_ROOT &&
    !existsSync(CONFIG_FILE) && existsSync(join(REPO_ROOT, "fleet.config.json")))
  console.error(`⚠ ${join(REPO_ROOT, "fleet.config.json")} 不再被读取 —— 配置属于看板安装,` +
                `请移到 ${CONFIG_FILE}(或用 BOARD_CONFIG 显式指定)`);

// ── Handoff targets (operator ruling 2026-09-01: hand-executed deliverables are
//    not necessarily SQL). The operator AUTHORIZES local directories as classified
//    destinations — fleet.config `handoff_targets`, or BOARD_HANDOFF_DIR which
//    synthesizes one default target (serial admission pattern, any file type).
//    Only declared directories are ever written; unknown target ids refuse.
const HANDOFF_TARGETS = decision.normalizeTargets(
  Array.isArray(CFG.handoff_targets) && CFG.handoff_targets.length
    ? CFG.handoff_targets
    : process.env.BOARD_HANDOFF_DIR
      ? [{ id: "default", label: "交接目录", dir: process.env.BOARD_HANDOFF_DIR }]
      : []);
if (Array.isArray(CFG.handoff_targets) && CFG.handoff_targets.length !== HANDOFF_TARGETS.length) {
  console.error("拒绝启动:handoff_targets 含不可用行(每行需要 id + dir,id 不可重复)");
  process.exit(1);
}
const DECISION_CTX = { repoRoot: REPO_ROOT, targets: HANDOFF_TARGETS };

// ── Deliverable-existence gate (kills "done yet never committed" at close time) ──
// It closes only on `approve` with an empty human note — the same criterion as
// store.resolve. ⭐ A hand-written copy of that criterion used to live here; it had
// ALREADY diverged (the copy judged the raw note, the store judged the synthesized
// one — the panel sends empty notes, so copy said "close" while store said "hand
// back", and the gate could 409 on a card that wasn't closing). The copy is gone:
// the destination is decided ONCE, in the resolve endpoint, from
// store.legacyDisposition / confirmDestination. Not "watched for divergence" —
// simply not held twice.
//
// Prefix wiring (INCIDENT-4 hardening): the path extractor needs the HOST repo's
// top-level names — hardcoded prefixes are blind on any other repo. Built once at
// startup from `git ls-tree -z HEAD` (⚠ -z is mandatory: plain ls-tree quotes
// non-ASCII paths and CJK files silently fall out).
// ⭐ Unmeasurable is NOT "no violations" — they are different states (flagged by
//   an outside review; also CONTRIBUTING rule 4: unknown values fall on the
//   refusing side). When the gate cannot see HEAD, closes REFUSE by default;
//   a deliberately git-less deployment says so explicitly with
//   BOARD_DELIVERABLE_GATE=off, and every close under "off" logs.
const GATE_OFF = process.env.BOARD_DELIVERABLE_GATE === "off";
let extractor = null;
try {
  const top = runGit(["-C", REPO_ROOT, "--no-lazy-fetch", "ls-tree", "-z", "HEAD"],
                           { maxBuffer: 8 * 1024 * 1024 }).toString("utf8");
  const prefixes = dgate.topLevelPrefixes(top);
  if (prefixes.length) extractor = dgate.makeExtractor({ prefixes });
  else console.error("⚠ 交付物闸不可测:HEAD 没有顶层条目(空仓?)" +
    (GATE_OFF ? "—— 已显式关闭,结案不做入库核对" : "—— 结案将被拒绝(fail-closed);确属无 git 部署请显式 BOARD_DELIVERABLE_GATE=off"));
} catch (e) {
  console.error(`⚠ 交付物闸不可测:读不到宿主仓 HEAD(${e.message})` +
    (GATE_OFF ? "—— 已显式关闭,结案不做入库核对" : "—— 结案将被拒绝(fail-closed);确属无 git 部署请显式 BOARD_DELIVERABLE_GATE=off"));
}
let _warnedShellCmd = false;
const warnShellCmdOnce = () => {
  if (_warnedShellCmd) return; _warnedShellCmd = true;
  console.error("⚠ fingerprint_extra_cmd 是字符串 —— 经 shell 执行。配置属于 operator 的信任域;" +
    "若这份配置会由对话 / agent 代改,请改成数组形(如 [\"python\", \"tools/x.py\"]),数组不经 shell。");
};
let _headCache = { at: 0, set: null };
const headFiles = () => {
  if (_headCache.set && Date.now() - _headCache.at < 10000) return _headCache.set;
  let set = null;
  try {
    // ⚠ -z mandatory (same reason as above).
    const out = runGit(["-C", REPO_ROOT, "--no-lazy-fetch", "ls-tree", "-r", "--name-only", "-z", "HEAD"],
                             { maxBuffer: 64 * 1024 * 1024 });
    set = new Set(out.toString("utf8").split("\0").filter(Boolean));
  } catch { set = null; }        // no git / not a repo → the gate is silently off (closures not blocked)
  _headCache = { at: Date.now(), set };
  return set;
};
// Return contract: string[] = measured violations (possibly none); null = the
// gate could not measure — the CALLER decides, and the default decision is
// refuse (409). GATE_OFF converts null to a logged pass.
const uncommittedOf = (t) => {
  if (!extractor) {
    if (!GATE_OFF) return null;
    console.log(`交付物闸显式关闭(BOARD_DELIVERABLE_GATE=off)—— #${t?.id} 结案未做入库核对`);
    return [];
  }
  const head = headFiles();
  if (!head || head.size === 0) {
    if (!GATE_OFF) return null;              // unmeasurable ≠ no violations
    console.log(`交付物闸显式关闭(BOARD_DELIVERABLE_GATE=off)—— #${t?.id} 结案未做入库核对(HEAD 不可读)`);
    return [];
  }
  // ⭐ Only the worker's delivered RESULT is read. description holds requirements,
  //   history and dependencies — probes from earlier investigations, other cards'
  //   in-flight files, reference specs all legitimately appear there. Mixing it in
  //   blocks closure on things THIS card never touched (measured). The gate's
  //   subject is "named in the delivery yet absent from HEAD" — not "mentioned
  //   anywhere".
  const text = String(t?.result || "");
  return extractor.uncommittedDeliverables(text, {
    inHead: (p) => head.has(p),
    onDisk: (p) => { try { return existsSync(join(REPO_ROOT, p)); } catch { return false; } },
  });
};
// Named-and-nonexistent (v0.16.1). Same measurability contract; returns {named, absent}
// so the caller can apply this repo's ruling: refuse only when NOTHING named exists.
const absentOf = (t) => {
  if (!extractor) return null;
  const head = headFiles();
  if (!head || head.size === 0) return null;
  const text = String(t?.result || "");
  const judg = { inHead: (p) => head.has(p),
                 onDisk: (p) => { try { return existsSync(join(REPO_ROOT, p)); } catch { return false; } } };
  return { named: extractor.extractPaths(text).length, absent: extractor.absentDeliverables(text, judg) };
};
// ── The describe-don't-name blind spot (INCIDENT-4's second half) ─────────────
// Measured: an attempt's evidence described behavior in detail, named not one file,
// and rode 29 uncommitted lines through to done — silence was being rewarded.
/** Uncommitted files in the work tree, [{path, mtimeMs}]. ⚠ -z mandatory (plain
 *  porcelain quotes non-ASCII paths and drops them wholesale). */
const dirtyFiles = () => {
  let out;
  try {
    // --no-optional-locks: a status read must not rewrite .git/index (the host's per-card
    // commit pins the index of the work repo while a card is in flight).
    out = runGit(["-C", REPO_ROOT, "--no-lazy-fetch", "--no-optional-locks", "status", "--porcelain", "-z"],
                       { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  } catch { return null; }        // unmeasurable ⇒ null ⇒ callers pass
  const rows = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    // `XY <path>`. A rename's OLD name arrives as the next element; it is not
    // "something touched now", so it is not picked up — picking it up inflates the
    // result toward false positives (the #1 way gates get switched off).
    const m = /^(..) (.+)$/s.exec(rec);
    if (!m) continue;
    const p = m[2];
    let mt = NaN;
    try { mt = statSync(join(REPO_ROOT, p)).mtimeMs; } catch { continue; }  // deleted → out of scope
    rows.push({ path: p, mtimeMs: mt });
  }
  return rows;
};
/** This card's LAST work span {startMs,endMs}; an open span ends "now". */
const spanOf = (t) => {
  let a = [];
  try { a = JSON.parse(t?.work_spans || "[]"); } catch { return null; }
  const last = Array.isArray(a) ? a[a.length - 1] : null;
  if (!last || !last.s) return null;
  const s = Date.parse(last.s), e = last.e ? Date.parse(last.e) : Date.now();
  return Number.isFinite(s) ? { startMs: s, endMs: Number.isFinite(e) ? e : Date.now() } : null;
};
/** Uncommitted files touched inside this worker's span that the evidence never names.
 *  Same return contract as uncommittedOf: null = unmeasurable, caller refuses. */
const unnamedOf = (t) => {
  if (!extractor) return GATE_OFF ? [] : null;
  const dirty = dirtyFiles();
  if (!dirty) {
    if (!GATE_OFF) return null;              // unmeasurable ≠ no violations
    console.log(`交付物闸显式关闭(BOARD_DELIVERABLE_GATE=off)—— #${t?.id} 结案未做作业区间核对(git status 不可读)`);
    return [];
  }
  return extractor.unnamedTouched(dirty, extractor.extractPaths(String(t?.result || "")), spanOf(t));
};

// SQL repo paths resolve only inside the server. The browser-facing object carries
// file names, hashes and controlled download endpoints — never source paths.
const taskOut = (t) => { if(!t)return t; const profile=taskProfilePreview(t),repair=taskRepairPreview(t);return {
  ...t,
  history_refs:store.taskHistoryRefs(db,t.id),
  ...flow.taskFields(t),   // 合同 B:handed_back / last_actor / last_actor_kind(core/flow.mjs,增量缓存)
  ...flow.goalCounts(t),   // 目标卡:children_done / children_total(与 conversation.progress 同口径,首页右栏组头用)
  execution_trace: taskExecutionView(db, t),
  verification_repair:repair.policy,
  ...(repair.digest?{verification_repair_digest:repair.digest}:{}),
  ...(profile ? {execution_profile:profile} : {}),
  progress_blockers: store.stuckWhy(db,t),
  // 执行者 heartbeat 带的临时进度(core/connect.mjs):只在这次 run 执行中时有值,不进历史。
  ...connect.liveNote(t),
  // Zcode 线的卡:最近一个分派请求的状态、拒收码与白话及其来源、派发次数(core/zcode-status.mjs)。别的卡没有这个键。
  ...zcodeTaskField(db, t, CFG.zcode_worker_config ?? null),
  decision_package: decision.publicDecisionPackage(t, DECISION_CTX),
  // ⭐ The panel's button captions come FROM the server-side criterion. If the panel
  //   computed its own, that would be a second copy of the formula — able to say
  //   "hold" on screen while actually handing back. Meaningless outside waiting, so
  //   not computed there (list loops hundreds of rows).
  confirm_destination: t.status === "waiting" ? store.confirmDestination(db, t) : null,
  // ⭐ Whether the no-progress brake is currently holding this card, computed by the
  //   SAME function claim uses — a panel that decided this for itself would be a
  //   second copy of the criterion, free to show "waiting its turn" for a card the
  //   queue will never hand out. Only for cards that could otherwise be claimed and
  //   have been dispatched before; every other row skips it (list loops hundreds).
  no_progress: (t.status === "not_started" && t.dispatch_fp)
    ? store.noProgressHold(db, t, fpContext()) : null,
  // ⭐ v0.23: the anti-affinity hold, from the SAME criterion /api/review/pending applies —
  //   a panel deciding this for itself would be a second copy. Only for delivered cards;
  //   an author of unknown family (no last_runtime) is never held.
  review_hold: (REVIEW_ANTI_AFFINITY && t.status === "waiting" && t.waiting_for === "review"
                && t.last_runtime && t.last_runtime === reviewSeatRuntime()) ? "same_family" : null,
}; };

const HOST = process.env.BOARD_HOST || "127.0.0.1";
const PORT = Number(process.env.BOARD_PORT || CFG.port || 47824);
const STARTED = Date.now();
// Which code this process is actually running. Read once at boot and compared
// against the disk on every /api/setup: `git pull` changes the files, not the
// live process, and every "I updated but nothing changed" is that gap. The
// board can see the gap itself, so it should say so instead of letting the
// operator find out through a refused line or a missing endpoint.
const codeRev = () => {
  try {
    return runGit(["-C", CODE_ROOT, "rev-parse", "--short", "HEAD"],
                        { encoding: "utf8", windowsHide: true }).trim();
  } catch { return null; }
};
// BOARD_TEST_BOOT_REV pretends this process booted from another revision, so the
// upgrade path can be exercised without rewriting git history. Test-only, and it
// says so on startup — an escape hatch that hides is a trap.
const BOOT_REV = process.env.BOARD_TEST_BOOT_REV || codeRev();
if (process.env.BOARD_TEST_BOOT_REV)
  console.error(`⚠ BOARD_TEST_BOOT_REV=${process.env.BOARD_TEST_BOOT_REV} —— 假装本进程跑的是别的版本(仅测试用)`);
// ⭐ How the board comes back after the panel's 「更新」/「重启看板」 (v0.18).
//   `exit`: leave with code 75 and let whoever started us start us again — `npm start`
//   (cli/start.mjs, which sets BOARD_SUPERVISED=1 and relaunches in the same terminal), pm2
//   (`pm_id`) or systemd (`INVOCATION_ID`). Preferred: the log stays where it was and Ctrl+C
//   keeps working. `respawn` (bare `node core/server.mjs`): this process starts its successor
//   itself — DETACHED, because on Windows a non-detached child is killed with its parent
//   (libuv's kill-on-close job; measured: the successor died before its first log line, twice)
//   — with the same node flags, argv, cwd and env, its output appended to <data>/board.log
//   (a detached process has left the console). BOARD_RESTART_MODE overrides the guess.
const RESTART_MODE = ["respawn", "exit"].includes(process.env.BOARD_RESTART_MODE || "")
  ? process.env.BOARD_RESTART_MODE
  : ((process.env.BOARD_SUPERVISED || process.env.pm_id !== undefined || process.env.INVOCATION_ID) ? "exit" : "respawn");
if (process.env.BOARD_RESTART_MODE && process.env.BOARD_RESTART_MODE !== RESTART_MODE)
  console.error(`⚠ BOARD_RESTART_MODE=${process.env.BOARD_RESTART_MODE} 不认识(只认 respawn / exit)—— 按 ${RESTART_MODE} 处理`);

// ── No-progress brake context (v0.11) ───────────────────────────────────────
// The two fingerprint components the store cannot compute for itself, because they
// describe the world OUTSIDE the database.
//
//   treeRev  the repository the work lands in. `HEAD:` (the tree) rather than HEAD
//            (the commit) — the same content re-committed is not new information for
//            a worker, and this is the caliber the source gate already uses.
//   extra    whatever THIS deployment considers part of the state, produced by a
//            command it configures. The public board deliberately has no idea what
//            the string means: a private deployment that must not dispatch again
//            until, say, a script's checksum or a target environment changes puts
//            that here, and this repo never learns the concept.
//
// ⚠ Cached briefly. Without it a busy board runs git once per claim per line; with
//   it, a change made in the last few seconds can cost ONE skipped dispatch, which
//   the next round undoes. That trade only works because the brake is an
//   availability mechanism — a wrong hold is a delay, never a wrong answer.
const FP_TTL_MS = 5000;
let fpCache = { at: 0, treeRev: null, extra: null };
const fpContext = () => {
  if (Date.now() - fpCache.at < FP_TTL_MS) return { treeRev: fpCache.treeRev, extra: fpCache.extra };
  let treeRev = null, extra = null;
  try {
    treeRev = runGit(["-C", REPO_ROOT, "--no-lazy-fetch", "rev-parse", "HEAD:"],
                           { encoding: "utf8", windowsHide: true }).trim() || null;
  } catch { treeRev = null; }
  const cmd = CFG.fingerprint_extra_cmd;
  if (cmd) {
    try {
      // ⭐ Two spellings (v0.16.1). An ARRAY is argv and runs without a shell —
      //   ["python", "tools/x.py"]. A STRING runs through the shell, which is fine for a
      //   file the operator typed, and not fine the day "let your Claude edit fleet.config"
      //   puts an agent's hand on it (external audit 2026-09-07). The string form stays
      //   (existing configs keep working) and says so once at startup.
      const opts = { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true, timeout: 5000 };
      const out = Array.isArray(cmd)
        ? execFileSync(String(cmd[0]), cmd.slice(1).map(String), opts)
        : (warnShellCmdOnce(), execSync(String(cmd), opts));
      extra = String(out).split(/\r?\n/)[0].trim() || null;
    } catch (e) {
      // ⭐ A broken hook must not silently become "state never changes" — that would
      //   turn a misconfigured command into a board-wide dispatch freeze. Report it
      //   and fall back to null, which reads as "this component tells us nothing".
      console.error(`⚠ fingerprint_extra_cmd 跑失败,本轮指纹不含它: ${String(e.message).slice(0, 90)}`);
      extra = null;
    }
  }
  fpCache = { at: Date.now(), treeRev, extra };
  return { treeRev, extra };
};

const db = store.open();
coord.migrate(db);
// 凭码接入(core/connect.mjs):线、座位名与加线逻辑在本文件里,以钩子交给它;COORD_STALE_MS 在后面定义,取值时再读。
const connect = openConnect({ db, coord, store, emit: (type, data) => emit(type, data), staleMs: () => COORD_STALE_MS, hooks: {
  lineTaken: (id) => LINES.includes(id) || ROLES.includes(id) || id === "review",
  isExternalLine: (id) => LINES.includes(id) && LINE_EXTERNAL[id] === true,
  managedName: (id) => isManagedSeatName(id),
  addExternalLine: (id, label) => { const added = addLine(id, "", label, null, null, true); emit("config.lines", { line: added.id });
    console.log(`线已加入: ${added.id}「${added.label}」· 外部执行(凭码接入)—— 已写入 ${CONFIG_FILE},无需重启`); },
  snippetBase: () => ({ node: process.execPath, bridge: join(__dirname, "..", "cli", "exec-mcp.mjs"), url: `http://127.0.0.1:${PORT}`,
                        // 令牌文件缺省放在当前用户应用数据目录下的看板专用子目录,不在看板数据目录里(F5;board_token 在数据目录)。
                        tokenDir: defaultTokenDir(store.DATA_DIR) }),
} });
connect.migrate();
approvals.migrate(db);
conversations.migrate(db);
// 合同 B「流转」:卡历史、任务派生字段、建卡对话的进度(core/flow.mjs)。线名与显示名在读时取(配置可热改)。
const flow = createFlow({ db, isExecutor: coord.isExecutor, lines: () => SUPERVISED || [], labels: () => LINE_LABEL || {},
                          emit: (type, data) => emit(type, data),
                          // 外部执行者的「已启动」= 这一轮领取后有过心跳(合同 B 订正;受管线仍只认 process_started);
                          // 流转条行下那行字 = 行项自己的 live_note(connect 的表)。
                          heartbeatStarted: (t) => coord.isExecutor(db, t.worker) && connect.heartbeatSeen(t.run_id),
                          liveNote: (t) => connect.liveNote(t) });
// 上一个进程留下的「运行中」对话已经没有进程在跑:标成失败并写明原因(面板上看到的是「重新发送即可」)。
{ const cut = conversations.recoverInterrupted(db);
  if (cut.length) console.log(`对话 ${cut.map((id) => "#" + id).join(" ")} 的上一轮在看板重启时被中断,已标为失败`); }
// Opt-in trusted local configuration; ordinary view-only startup performs no new migration.
const fleetActions = process.env.BOARD_FLEET_ACTIONS_CONFIG
  ? openFleetActions(db,{config:loadFleetActionsConfig(process.env.BOARD_FLEET_ACTIONS_CONFIG)}) : null;
const pumpFleetActions=()=>fleetActions?.tick().catch(()=>{}); // each delivery retains a fixed error code
const fleetActionsTimer=fleetActions?setInterval(pumpFleetActions,5000):null;
fleetActionsTimer?.unref();
if(fleetActions)setImmediate(pumpFleetActions);
async function stopFleetActions(){if(fleetActionsTimer)clearInterval(fleetActionsTimer);await fleetActions?.close();}


// ── Worker supervision: one loop child process per line; the panel's switches
//    drive these.
// Single-seat roles (auto-review, re-orchestration). They join the supervised set
// but NOT LINES (= the claim routing/context unit): they claim no cards and hold no
// persistent session. Gated on config AND on their loop scripts existing.
const ROLES = (CFG.roles || []).filter((r) => ["review"].includes(r));
// ── Auto-review anti-affinity (v0.23, docs/方案-身份分配.md §3.2). `review.anti_affinity`:
//    "runtime" = the auto-reviewer never judges a delivery made by its own runtime family.
//    Such cards stay in 待验收 for a human or another family's reviewer, VISIBLY: the panel
//    marks them 待异族审阅 and /api/review/pending lists them as `held` — never a silent
//    drop. Absent = exactly today's behaviour. Closed domain: anything else refuses startup.
//    Why a policy and not a default: the measured asymmetry (Claude reviewing Codex helps,
//    Codex reviewing Claude hurts) means the operator must place the families; this knob
//    only guarantees the reviewer is not the author's own family.
const REVIEW_ANTI_AFFINITY = (() => {
  const v = CFG.review?.anti_affinity;
  if (v == null || v === "" || v === false) return null;
  if (v === "runtime") return "runtime";
  console.error(`拒绝启动:${CONFIG_FILE} 的 review.anti_affinity 只接受 "runtime" —— 收到 ${JSON.stringify(v)}`);
  process.exit(1);
})();

// ── 远程批准入口(remote_access,默认关闭)。关闭或没写时其余键一概不读,行为与没有这项时完全一样;
//    打开时配置有一处不合格就拒绝启动:监听地址必须显式写 IP,通配地址要另加 allow_wildcard_listen。
const REMOTE = (() => {
  try { return approvals.parseRemoteConfig(CFG.remote_access); }
  catch (e) { console.error(`拒绝启动:${CONFIG_FILE} 的 remote_access ${e.message}`); process.exit(1); }
})();

// ⭐ The line menu is BUILT from config (never copied into prose). A hand-copied
//   list once dropped one line in two places at once — the decomposition model
//   cannot pick a line missing from its menu, so the omission silently starved that
//   line. Add a line in config and the name shows up everywhere by construction.
//   The menu itself is built in decompose_lib.js (one definition, and the tested
//   one) — a second copy here is exactly how the two-places-one-fix rot starts.
//
// v0.4: the registry is REBUILDABLE, not frozen at boot. Every consumer reads
// these bindings at call time (badRoutable, the decompose menu, the reconciler,
// /api/workers), and per-line runtime state is lazy (settingsOf / slotsOf look
// up by name) — so adding a line is: persist to the config, rebuild, announce.
// No restart, no dropped SSE clients, no in-flight worker touched.
// ── Line identity (v0.22.0): `lines[].role` says what a line IS, in config, not in a
//    runtime setting. Four keys, three of them closed domains:
//      kind    implement (default) | review — picks the worker's prompt frame; the
//              decomposer's menu lists implement lines only.
//      tools   write (default; review defaults to read-only) | read-only — the ONE piece
//              a machine enforces: the Claude seat's argv (no Edit, work repo under an
//              Edit deny), the codex seat's --sandbox read-only.
//      charter a .md relative to THIS repo (operator ruling 2026-09-28: the board repo),
//              inlined verbatim into every prompt with its sha256. It must sit inside the
//              gated subtree: the source gate is what pins it, and a charter nobody
//              blessed is not a charter. Prose = discipline; "which version was accepted"
//              = structure.
//      seat    {runtime, model, effort} — agents[0] the first time the line starts; after
//              that worker_settings wins and the panel shows the drift.
//    Why on lines[] and not a new table: the line is already the claim filter, the
//    decompose menu key, the badge and the ledger dimension — an identity hung on the same
//    key appears everywhere the board already forks on the line, by construction.
//    Measured basis for the defaults (docs/方案-身份分配.md §1.3): cross-model review is
//    asymmetric, and structured adversarial review of the DESIGN scored highest — so the
//    other family belongs on a read-only review line, not on the code-stage reviewer.
const ROLE_KINDS = ["implement", "review"];
const TOOL_PROFILES = ["write", "read-only"];
function normalizeRole(raw, lineId) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw store.err(store.ERR.BAD_INPUT, `线 ${lineId} 的 role 必须是对象 {kind, tools, charter, seat}`);
  const kind = raw.kind == null || raw.kind === "" ? "implement" : String(raw.kind);
  if (!ROLE_KINDS.includes(kind))
    throw store.err(store.ERR.BAD_INPUT, `线 ${lineId} 的 role.kind 只接受 ${ROLE_KINDS.join(" / ")} —— 收到 ${JSON.stringify(raw.kind)}`);
  const tools = raw.tools == null || raw.tools === "" ? (kind === "review" ? "read-only" : "write") : String(raw.tools);
  if (!TOOL_PROFILES.includes(tools))
    throw store.err(store.ERR.BAD_INPUT, `线 ${lineId} 的 role.tools 只接受 ${TOOL_PROFILES.join(" / ")} —— 收到 ${JSON.stringify(raw.tools)}`);
  let charter = null;
  if (raw.charter != null && String(raw.charter).trim() !== "") {
    charter = String(raw.charter).trim().replace(/\\/g, "/");
    if (isAbsolutePath(charter) || charter.split("/").includes(".."))
      throw store.err(store.ERR.BAD_INPUT, `线 ${lineId} 的 role.charter 必须是看板仓相对路径(不能是绝对路径或含 ..)—— 收到 ${JSON.stringify(raw.charter)}`);
    if (!/\.md$/i.test(charter))
      throw store.err(store.ERR.BAD_INPUT, `线 ${lineId} 的 role.charter 只接受 .md —— 收到 ${JSON.stringify(raw.charter)}`);
    const abs = resolve(CODE_ROOT, charter);
    if (!existsSync(abs))
      throw store.err(store.ERR.BAD_INPUT, `线 ${lineId} 的章程不存在: ${charter}(相对看板仓根 ${CODE_ROOT};章程住看板仓,不住工作仓)`);
    if (CFG_GATED_SUBTREE) {
      const gate = resolve(CODE_ROOT, CFG_GATED_SUBTREE === "." ? "." : CFG_GATED_SUBTREE);
      const rel = relative(gate, abs);
      if (rel.startsWith("..") || isAbsolutePath(rel))
        throw store.err(store.ERR.BAD_INPUT, `线 ${lineId} 的章程 ${charter} 不在受闸子树 ${CFG_GATED_SUBTREE} 之内 —— 没人验收过的章程不算章程`);
    }
  }
  let seat = null;
  if (raw.seat != null) {
    if (typeof raw.seat !== "object" || Array.isArray(raw.seat))
      throw store.err(store.ERR.BAD_INPUT, `线 ${lineId} 的 role.seat 必须是对象 {runtime, model, effort}`);
    seat = { runtime: String(raw.seat.runtime || ""), model: String(raw.seat.model || ""), effort: String(raw.seat.effort || "") };
    // The seat's runtime/model/effort are judged against the seat DECLARATIONS, which are
    // built later in this file — assertRoleSeat runs right after them (and in addLine).
  }
  return { kind, tools, charter, seat };
}
let LINES, SUPERVISED, LINE_HINT, LINE_LABEL, LINE_ACCEPT, LINE_ROLE, LINE_CHARTER_HASH, IMPL_LINES, REVIEW_LINES, LINE_EXTERNAL;
function rebuildLines() {
  // Bind charter bytes to the loaded configuration before publishing any new maps.
  // Claim runs inside a writer transaction and must not perform filesystem reads.
  const roles = Object.fromEntries(CFG.lines.map((l) => [l.id, normalizeRole(l.role, l.id)]));
  const charterHashes = Object.fromEntries(Object.entries(roles).map(([id, role]) => [id,
    role?.charter ? createHash("sha256").update(readFileSync(resolve(CODE_ROOT, role.charter))).digest("hex") : null]));
  LINES = CFG.lines.map((l) => String(l.id));
  SUPERVISED = [...LINES, ...ROLES];
  LINE_HINT = Object.fromEntries(CFG.lines.map((l) => [l.id, l.hint || ""]));
  // v0.21: display name (Chinese welcome; the id stays a machine contract) and the line's
  // acceptance policy — "human" (default: a delivery waits for the operator's 通过) or "auto"
  // (the operator decided once, in the config, that deliveries on this line complete on
  // report; the close gates still run; human-gated cards are never auto-completed).
  LINE_LABEL = Object.fromEntries(CFG.lines.map((l) => [l.id, String(l.label || "").trim()]));
  LINE_ACCEPT = Object.fromEntries(CFG.lines.map((l) => [l.id, l.accept === "auto" ? "auto" : "human"]));
  // 外部执行线:卡交给看板外的执行者(持执行者令牌领取),看板不启动它的进程。
  LINE_EXTERNAL = Object.fromEntries(CFG.lines.map((l) => [l.id, l.external === true]));
  // v0.22: identity (null = a plain line, exactly as before this version).
  LINE_ROLE = roles;
  LINE_CHARTER_HASH = charterHashes;
  IMPL_LINES = LINES.filter((id) => (LINE_ROLE[id]?.kind || "implement") === "implement");
  REVIEW_LINES = LINES.filter((id) => LINE_ROLE[id]?.kind === "review");
}
try { rebuildLines(); }
catch (e) {   // a PRESENT-but-broken identity refuses startup, like any other config error
  console.error(`拒绝启动:${CONFIG_FILE} 存在但不可用 —— ${e.message}`);
  process.exit(1);
}

// Line ids are machine contracts: the same shape badLine's route regex admits,
// and renaming is deliberately NOT offered — cards reference the id, a rename
// would orphan them. Removal is not offered either (running slots, cards on the
// line); an unused line costs nothing.
const LINE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Add a line: validate → persist to the config file (atomic) → rebuild → the
 *  caller announces. Throws store.err on refusal (unknown/duplicate/role/shape). */
function addLine(idRaw, hintRaw, labelRaw, acceptRaw, roleRaw = null, externalRaw = false) {
  const id = String(idRaw ?? "").trim();
  const hint = String(hintRaw ?? "").trim();
  const label = String(labelRaw ?? "").trim();
  const accept = acceptRaw == null || acceptRaw === "" ? "human" : String(acceptRaw);
  if (label.length > 24) throw store.err(store.ERR.BAD_INPUT, "显示名最多 24 字");
  if (!["human", "auto"].includes(accept)) throw store.err(store.ERR.BAD_INPUT, `accept 只接受 human / auto —— 收到 ${JSON.stringify(acceptRaw)}`);
  if (!LINE_ID_RE.test(id))
    throw store.err(store.ERR.BAD_INPUT, `线名只允许小写字母/数字/-/_,1-32 位,且以字母或数字开头 —— 收到 ${JSON.stringify(id)}`);
  if (LINES.includes(id) || ROLES.includes(id) || ["review"].includes(id))
    throw store.err(store.ERR.CONFLICT, `线 ${id} 已存在(或与角色座席同名)`);
  if (hint.length > 80)
    throw store.err(store.ERR.BAD_INPUT, "hint 最多 80 字");
  // v0.22: the identity is validated BEFORE anything is persisted (same gate as boot).
  const role = normalizeRole(roleRaw, id);
  assertRoleSeat(role, id);
  const roleDisk = role ? { kind: role.kind, tools: role.tools,
                            ...(role.charter ? { charter: role.charter } : {}),
                            ...(role.seat ? { seat: role.seat } : {}) } : null;
  // Persist FIRST: a line that exists in memory but not on disk would vanish on
  // the next restart with every card on it stranded on a name nobody claims.
  let onDisk = {};
  if (existsSync(CONFIG_FILE)) onDisk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));   // broken = throws = refuse
  const lines = Array.isArray(onDisk.lines) && onDisk.lines.length
    ? onDisk.lines : BUILTIN_CONFIG.lines.map((l) => ({ ...l }));
  if (externalRaw != null && typeof externalRaw !== "boolean") throw store.err(store.ERR.BAD_INPUT, "external 只接受 true / false");
  const external = externalRaw === true;
  if (!external && coord.isExecutor(db, id))
    throw store.err(store.ERR.CONFLICT, `线 ${id} 与已登记的执行者同名;受管执行线的座位名就是线 id,换一个线名或配成外部执行线`);
  lines.push({ id, ...(hint ? { hint } : {}), ...(label ? { label } : {}), ...(accept === "auto" ? { accept } : {}),
               ...(roleDisk ? { role: roleDisk } : {}), ...(external ? { external } : {}) });
  const next = { ...onDisk, lines };
  const tmp = CONFIG_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, CONFIG_FILE);
  CFG = { ...CFG, lines };     // never mutate BUILTIN_CONFIG through the alias
  rebuildLines();
  return { id, hint, label, accept, role, external };
}

const workers = new Map();   // slotKey -> { line, slot, proc, startedAt, route, log: [] }
// Parallel slots: slot 1's worker name = the line name itself (fully compatible
// with existing cards/leases/display). Slot 2+ = line@k.
const slotKey = (line, k) => k <= 1 ? line : `${line}@${k}`;
const slotsOf = (line) => { const out = [];
  for (const w of workers.values()) if (w.line === line) out.push(w);
  return out.sort((a, b) => a.slot - b.slot); };

// ⭐ The crash-backoff LADDER lives in a ledger keyed by slot identity (slotKey) —
//   not on the process container. Containers are rebuilt on every restart, so a
//   count kept there only survived if "whoever rebuilt writes it back"; with
//   parallel slots the restarter is whichever timer fires first (workerStart
//   rebuilds ALL missing slots — deliberately idempotent), so the other slot's
//   timer early-returns and nobody writes its count ⇒ slots ≥2 backed off at the
//   base forever: unattended nights restarted every 30s, each restart claiming a
//   card and waking a model — the backoff produced what it exists to prevent.
//   The fix: the count is written AT CRASH TIME against the slot identity,
//   independent of who restarts it.
// ⭐ A gate REFUSING to start is not a crash. Refusals are DETERMINISTIC — retrying
//   in an unchanged environment reproduces them letter for letter. Fed into the
//   backoff ladder, one line's ladder climbed to 457 restarts while the ledger
//   showed ~50 real work items in the same period (≈400 restarts died at the gate
//   producing nothing, and the panel only said "stopped, code=2"). Refusals carry a
//   dedicated exit code and the board STOPS WITH THE REASON instead of restarting.
//   ⚠ This number PAIRS with the python side (gates_lib.EXIT_REFUSED). Change one
//   alone and refusals silently degrade back to crash handling.
const REFUSED_EXIT = 3;
// ⭐ AN EXIT CODE IS NOT A STOP REASON. One code carries three meanings: a tree-kill
//   makes a human stop look like code 1, a board shutdown looks the same, and both
//   then look like a crash — which is the one meaning that triggers a restart. So the
//   SIDE THAT INITIATES a stop writes the reason down BEFORE killing anything, and
//   the exit handler only fills in what nobody claimed.
const STOP_REASON = Object.freeze({
  BY_USER: "stopped-by-user",
  WITH_BOARD: "stopped-with-board",
  CRASH: "crash",
  EXIT_NORMAL: "exit-normal",
});
const STOP_REASON_SET = new Set(Object.values(STOP_REASON));
const crashLadder = new Map();   // slotKey -> consecutive crashes (next delay = base * 2^(n-1))
// A maintenance boot revives nothing on its own. `everStarted` is what separates
// "intent from before this boot" (do not act on it) from "started during this
// session" (the reconciler may bring it back after a seat swap).
const NO_REVIVE = !!process.env.BOARD_NO_RESTORE;
const everStarted = new Set();
const noReviveSaid = new Set();   // say it once per line, not every reconcile tick
// A HUMAN touching start/stop resets the ladder — the ledger outlives containers,
// so the old "new container = no count" semantics must be kept explicitly.
// ⛔ Never call from the auto-restart path (exit → setTimeout → workerStart): it
//   would erase the ladder.
const resetLadder = (line) => { for (let k = 1; k <= MAX_PARALLEL; k++) crashLadder.delete(slotKey(line, k)); };

// Absolute deadline (resolved ONCE at server start; never reinterpreted).
//   · ISO form (2026-08-20T01:00, date given) = absolute. A PAST time STAYS past
//     (= already expired; rolling it forward would let a post-deadline restart run
//     until tomorrow — measured).
//   · HH:MM = human convenience: rolled once at startup to "the next such time",
//     absolute thereafter.
//   · Unparsable input is LOUDLY ignored (never silently dropped).
const BOARD_UNTIL_AT = (() => {
  const v = (process.env.BOARD_UNTIL || "").trim();
  if (!v) return null;
  if (v.includes("T")) {
    const t = Date.parse(v);
    if (Number.isNaN(t)) { console.error(`BOARD_UNTIL 解析不能: ${v} —— 忽略`); return null; }
    return t;
  }
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) { console.error(`BOARD_UNTIL 形不正(ISO 或 HH:MM): ${v} —— 忽略`); return null; }
  const d = new Date(); d.setHours(+m[1], +m[2], 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
})();
const localIso = (ms) => { const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// Routing regexes check CHARACTER CLASS only; narrowing to known line names happens
// here. Unknown values fall to the refusal side (a permission gate, so allowlist —
// an unknown name passing through grows a ghost line in settings).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ── Setup guide (v0.6) ───────────────────────────────────────────────────────
// Six steps to a working deployment, each one MEASURED here and now. States:
//   done    — measured true
//   todo    — measured false; `hint` says what to do, `action` offers the way
//   blocked — an earlier decision is missing (say which), acting now is useless
//   unknown — could not measure (git missing, unreadable file). NEVER "done":
//             the whole product's polarity is that unmeasurable is not fine.
/** The config as it is ON DISK right now (the process read its copy at boot). */
function diskConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return null; }
}
/** Deployment keys changed on disk since boot → a restart is pending. Measured,
 *  not remembered: this is the answer to "I edited the config, why nothing
 *  changed" — only lines are hot-reloadable, port/repo/gated_subtree are not. */
function configDrift() {
  const d = diskConfig();
  if (!d) return null;
  const differs = ["port", "repo", "gated_subtree"]
    .filter((k) => String(d[k] ?? "") !== String(CFG_AT_BOOT[k] ?? ""));
  return differs.length ? differs : null;
}

function blessStep() {
  if (!CFG_GATED_SUBTREE) {
    const d = diskConfig();
    if (d && d.gated_subtree)
      return { state: "todo",
               detail: "配置已经写好了,但看板是在那之前起的",
               action: { type: "api", method: "POST", path: "/api/setup/restart", label: "重启看板",
                         confirm: "重启看板,让它读到新配置。\n\n卡、事件、账本都在库里,不会丢;在跑的线会先停下,起来后照原样恢复。" } };
    return { state: "blocked",
             detail: "先做第二步生成配置,再重启看板",
             hint: '配置里要有 "gated_subtree" 这个键' };
  }
  const revFile = join(store.DATA_DIR, "accepted_rev");
  let head = null;
  try {
    const spec = CFG_GATED_SUBTREE === "." ? "" : CFG_GATED_SUBTREE;
    head = runGit(["-C", CODE_ROOT, "--no-lazy-fetch", "rev-parse", `HEAD:${spec}`],
                        { encoding: "utf8", windowsHide: true }).trim();
  } catch (e) {
    return { state: "unknown", detail: `读不到代码的版本(${String(e.message).slice(0, 60)})`,
             hint: "看板目录需要是一个 git 仓库" };
  }
  let accepted = null;
  try { accepted = readFileSync(revFile, "utf8").trim(); } catch {}
  if (!accepted)
    return { state: "todo", detail: "这个版本还没确认过",
             hint: "命令行也行:python cli/board.py bless",
             action: acceptAction(acceptPreview(head, accepted)) };
  if (accepted !== head)
    return { state: "todo", detail: "代码有更新,确认记录还停在旧版本",
             action: acceptAction(acceptPreview(head, accepted)) };
  return { state: "done", detail: `已确认版本 ${accepted.slice(0, 12)}` + (CFG_GATED_SUBTREE === "." ? "" : `(${CFG_GATED_SUBTREE})`) };
}

// ── Accepting code from the panel (v0.18) ────────────────────────────────────
// The source gate's record is a human act either way — `board.py bless` or the panel's
// 「确认当前版本」 button (「接受当前代码」 before v0.24). Both show the same thing first (this
// tree, the previously accepted one, `git diff --stat` between them), and the button carries
// the tree the human SAW
// (`confirm_tree`): if the disk moved in between, the server refuses. What you looked at is
// what you accept — a button that accepts "whatever is there now" would be the one-click the
// gate exists to prevent.
const gatedTree = () => {
  if (!CFG_GATED_SUBTREE) return { err: "还没配置要盯住的代码范围(gated_subtree)" };
  try {
    const spec = CFG_GATED_SUBTREE === "." ? "" : CFG_GATED_SUBTREE;
    return { tree: runGit(["-C", CODE_ROOT, "--no-lazy-fetch", "rev-parse", `HEAD:${spec}`],
                                { encoding: "utf8", windowsHide: true }).trim() };
  } catch (e) { return { err: String(e.message).slice(0, 60) }; }
};
const acceptedFile = () => join(store.DATA_DIR, "accepted_rev");
const readAccepted = () => { try { return readFileSync(acceptedFile(), "utf8").trim() || null; } catch { return null; } };
const statCache = new Map();   // "prev→tree" -> stat lines; trees are immutable, so is their diff
function treeStat(prev, tree) {
  if (!prev || !tree || prev === tree) return [];
  const k = `${prev}→${tree}`;
  if (!statCache.has(k)) {
    let lines;
    try {
      lines = runGit(["-C", CODE_ROOT, "--no-lazy-fetch", "diff", "--stat=90", prev, tree], { encoding: "utf8", windowsHide: true })
        .split("\n").map((l) => l.trimEnd()).filter(Boolean);
    } catch (e) { lines = [`(git diff --stat 失败:${String(e.message).slice(0, 60)})`]; }
    if (statCache.size > 32) statCache.clear();
    statCache.set(k, lines);
  }
  return statCache.get(k);
}
/** What the panel shows BEFORE it asks — one copy, written here, never in the panel. */
function acceptPreview(tree, prev) {
  const stat = treeStat(prev, tree);
  const files = prev && prev !== tree ? Math.max(0, stat.length - 1) : (prev ? 0 : null);   // last stat line = summary
  const shown = stat.slice(0, 14).map((l) => "  " + l);
  const confirm = [
    `确认版本 ${tree.slice(0, 12)}` + (CFG_GATED_SUBTREE === "." ? "" : `(${CFG_GATED_SUBTREE})`) +
      (prev ? `(上次确认的是 ${prev.slice(0, 12)})` : "(首次确认)"),
    ...(prev && prev !== tree ? ["", "上次确认 → 这次,改了什么:", ...shown, ...(stat.length > 14 ? [`  …还有 ${stat.length - 14} 行`] : [])] : []),
    "", "确认之后执行线才会用这个版本起跑。",
  ].join("\n");
  return { tree, prev, files, stat, confirm };
}
const acceptAction = (pv) => pv ? { type: "api", method: "POST", path: "/api/setup/bless", label: "确认当前版本",
                                    body: { confirm_tree: pv.tree }, confirm: pv.confirm } : null;
function acceptTree(confirmTree, who) {
  const { tree, err } = gatedTree();
  if (err) throw store.err(store.ERR.CONFLICT, `读不到代码的版本(${err})`);
  if (!confirmTree || confirmTree !== tree)
    throw store.err(store.ERR.CONFLICT,
      `你看到的版本(${String(confirmTree || "").slice(0, 12) || "空"})和磁盘上现在的(${tree.slice(0, 12)})不一致 —— 刷新页面,看过之后再按一次`);
  const prev = readAccepted();
  mkdirSync(store.DATA_DIR, { recursive: true });
  writeFileSync(acceptedFile(), tree + "\n", "utf8");
  let dirty = 0;
  try {
    dirty = runGit(["-C", CODE_ROOT, "--no-lazy-fetch", "--no-optional-locks", "status", "--short", "--", CFG_GATED_SUBTREE === "." ? "." : CFG_GATED_SUBTREE],
                         { encoding: "utf8", windowsHide: true }).split("\n").filter((l) => l.trim()).length;
  } catch {}
  console.log(`已确认 ${CFG_GATED_SUBTREE} = ${tree}(${who})` + (prev ? `,上次 ${prev.slice(0, 12)}` : ",首次")
    + (dirty ? ` ⚠ 工作树有 ${dirty} 处未提交改动 —— 闸锚的是 HEAD,起线前先 commit` : ""));
  emit("code.accepted", { tree, prev, by: who, dirty });
  return { accepted: tree, prev, dirty, files: acceptPreview(tree, prev).files };
}

/** 更新到新代码之前的那一步:受闸子树有新树且还没确认过,就按人看到的树确认。面板「更新」与批准接口共用。 */
const acceptForUpgrade = (confirmTree, who) => {
  const g = gatedTree();
  return g.tree && readAccepted() !== g.tree ? acceptTree(confirmTree, who).accepted : null;
};

/** What it takes for a `git pull` to actually be in effect: the gate's record, this process
 *  and the sentries all keep running old code, and none announces itself. Measured, so the
 *  panel can — and since v0.18 the panel offers ONE button for it: accept the tree you were
 *  shown, stop the lines with their intent kept, restart, and the lines come back; sentries
 *  reconnect on their own and re-exec themselves when the board tells them they are stale.
 *  The human still decides — the confirm text says what changed and what a restart
 *  interrupts — but decides once, on one button. */
function upgradeState() {
  const onDisk = codeRev();
  if (!BOOT_REV || !onDisk)
    return { measurable: false, pending: false, running: BOOT_REV, on_disk: onDisk, steps: [], apply: null };
  if (onDisk === BOOT_REV) {
    const stale = [...sentries.values()].filter((s) => s.rev && s.rev !== onDisk);
    // Server current, a sentry not: the board already told it (sentry.stale on connect) —
    // a v0.18+ sentry re-runs itself, an older one prints the event for its coordinator.
    return { measurable: true, pending: stale.length > 0, running: BOOT_REV, on_disk: onDisk, apply: null,
             steps: stale.length ? [{ key: "sentries", title: "有通知进程还在跑旧代码", state: "todo",
               detail: `${stale.length} 个的版本是 ${[...new Set(stale.map((s) => s.rev))].join("/")},磁盘上是 ${onDisk}`,
               hint: "老版的通知进程由挂它的 Claude 停掉重跑" }] : [] };
  }
  const bl = blessStep();
  const g = gatedTree();
  const pv = g.tree ? acceptPreview(g.tree, readAccepted()) : null;
  const c = store.counts(db);
  const live = SUPERVISED.filter((l) => slotsOf(l).some((w) => w.proc));
  // ⭐ v0.19 (self-audit P2-2): what comes back is what the boot restore starts — the lines
  //   with desired_running — not "the lines that have a process right now". Say both sets.
  const want = SUPERVISED.filter((l) => settingsOf(l).desired_running);
  const keep = "卡、事件、账本都在库里,不会丢" + (live.length ? `;在跑的线(${live.join(" ")})先停下` : "")
    + (want.length ? `;新进程起来后会起这些线:${want.join(" ")}` : ";没有线设为自动拉取,起来后不会起线");
  const interrupt = c.in_progress
    ? `⚠ 有 ${c.in_progress} 张卡正在跑:更新会打断它们,卡回到「未开始」由线重领。想等它们交付再更新,就先取消。` : "";
  const needAccept = bl.state !== "done" && !!pv;
  const steps = [
    { key: "bless", title: "确认新版本", state: bl.state === "done" ? "done" : bl.state === "blocked" ? "blocked" : "todo",
      detail: bl.state === "done" ? bl.detail
            : pv && pv.files != null ? `上次确认 → 这次改了 ${pv.files} 个文件`
            : pv ? "首次确认" : bl.detail },
    { key: "restart", title: "重启看板", state: "todo",
      detail: `进程跑的是 ${BOOT_REV},磁盘上已经是 ${onDisk}`, hint: keep + (interrupt ? "。" + interrupt : "") },
    ...(sentries.size ? [{ key: "sentries", title: "通知进程", state: "done",
      detail: `${sentries.size} 个连着,重启后会自动重连并换成新代码` }] : []),
  ];
  const apply = {
    path: needAccept ? "/api/upgrade/apply" : "/api/setup/restart", label: "更新到新代码",
    body: needAccept ? { confirm_tree: pv.tree } : {}, in_progress: c.in_progress, lines: { stop: live, resume: want },
    confirm: [`把看板从 ${BOOT_REV} 更新到 ${onDisk}。`, "",
              ...(needAccept ? [pv.confirm] : bl.state === "done" ? ["新代码已经确认过了。"] : [bl.detail]),
              "", `接着看板会自己重启:${keep}。`, ...(interrupt ? ["", interrupt] : [])].join("\n"),
  };
  return { measurable: true, pending: true, running: BOOT_REV, on_disk: onDisk, steps, apply };
}

function setupState() {
  const c = store.counts(db);
  const builtinIds = BUILTIN_CONFIG.lines.map((l) => l.id).join(",");          // the comparison key (machine ids)
  const builtinNames = BUILTIN_CONFIG.lines.map((l) => l.label ? `「${l.label}」` : l.id).join("");   // what the guide shows
  const custom = LINES.join(",") !== builtinIds;
  const hasConfig = existsSync(CONFIG_FILE);
  const steps = [
    { key: "board", title: "看板已经起来了", state: "done",
      detail: `端口 ${PORT}` },
    { key: "config", title: "有一份属于你的配置", ...(hasConfig
        ? (() => { const drift = configDrift();
                   return drift
                     ? { state: "done", detail: `${CONFIG_FILE} ⚠ ${drift.join("/")} 改过了,看板还在用启动时读到的旧值`,
                         hint: "重启看板让新值生效",
                         drift: true, action: { type: "api", method: "POST", path: "/api/setup/restart", label: "重启看板",
                                                confirm: "重启看板,让它读到改过的配置。\n\n卡、事件、账本都在库里,不会丢;在跑的线会先停下,起来后照原样恢复。" } }
                     : { state: "done", detail: CONFIG_FILE }; })()
        : { state: "todo", detail: "生成一份属于你的配置文件",
            action: { type: "api", method: "POST", path: "/api/setup/init-config", label: "生成配置文件" } }) },
    { key: "lines", title: "定义你自己的线", ...(custom
        ? { state: "done", detail: `线: ${LINES.join(" / ")}` }
        : !hasConfig
          ? { state: "blocked", detail: "先做上一步生成配置" }
          : { state: "todo", detail: `内置的 ${builtinNames} 只是占位,换成你自己的活分几条`,
              hint: "用上面的「加线」框直接加,或按下面的按钮让你的 Claude 替你起草几条",
              action: { type: "quick", kind: "propose-lines", label: "让我的 Claude 替我起草线路" } }) },
    { key: "bless", title: "确认当前版本", ...blessStep() },
  ];
  const doneN = steps.filter((s) => s.state === "done").length;
  const fault = lastFault();
  return { steps, done: doneN, total: steps.length, complete: doneN === steps.length,
           version: BOOT_REV, sentries: sentries.size, upgrade: upgradeState(), ...(fault ? { last_fault: fault } : {}) };
}
/** 上次故障:守护写的运行记录(core/board-run.mjs,是否正常停止按干净退出标记判定),每次请求现读。
 *  kind: exit · restart_loop · interrupted;reason 与 cli/status.mjs 的「原因」同一句。没有记录返回 null(不给字段)。 */
function lastFault() {
  let f = null;
  try { f = readRunRecord(store.DATA_DIR).last_fault; } catch {}
  return f ? { kind: f.kind, at: f.at, exit_code: f.exit_code, reason: faultReason(f) } : null;
}

const badLine = (res, line, allowed) => allowed.includes(line) ? false
  : (json(res, 400, { error: `未知的线名: ${line}`, allowed }), true);
// ⭐ The value domain of the two DESTINATION columns (route / line). **One criterion,
//   one place.** Why strict: claim filters `route=? AND (line IS NULL OR line=?)` —
//   a stray value produces a card that sits in not_started FOREVER, claimable by
//   nobody, with no error anywhere. Not "broken" but "never starts", and the screen
//   looks perfectly normal.
// ⚠ There are THREE write roads (create / update / reopen). Writing the check at
//   each site is how one gets missed (measured: create and update carried two
//   copies of the same check while reopen sailed through). All three call THIS.
const ROUTES = CFG.routes.map(String);
if (!ROUTES.includes(store.DEFAULT_ROUTE)) {
  console.error(`拒绝启动:routes ${JSON.stringify(ROUTES)} 不含默认路由 ` +
    `"${store.DEFAULT_ROUTE}"(BOARD_DEFAULT_ROUTE)—— 用默认路由建的卡将永远无人可领`);
  process.exit(1);
}
// Ladder starting rungs. A card may say WHICH RUNG TO START ON, never a model name
// — model names on cards would hand quota allocation to whoever writes cards. The
// value gate sits in the SAME function as route/line: the three write roads already
// converge here; a separate function would split "which one do I call" for the next
// road added.
const WEIGHTS = ["light", "standard", "heavy"];
// ⚠ line and route treat null OPPOSITELY — aligning them breaks one or the other:
//   · `line: null` is LEGAL (no line = any line's worker may claim; schema allows NULL).
//   · `route: null` is INVALID: schema is NOT NULL DEFAULT — wanting the default
//     means OMITTING the key. Letting null through writes the string "null" (store
//     coerces) which never falls to the default ⇒ ghost card.
//   · `weight: null` sits on route's side (same schema shape, same judgment).
function badRoutable(res, b) {
  if (b.line !== undefined && b.line !== null && badLine(res, b.line, LINES)) return true;
  if (b.route !== undefined && !ROUTES.includes(b.route)) {
    json(res, 400, { error: `未知的路由: ${b.route}`, allowed: ROUTES });
    return true;
  }
  if (b.weight !== undefined && !WEIGHTS.includes(b.weight)) {
    json(res, 400, { error: `未知的起跑档(weight): ${b.weight}`, allowed: WEIGHTS });
    return true;
  }
  return false;
}
// ⭐ Pick-a-card /api/claim carries NO badRoutable gate — ruled, with reasons:
//   ① a stray line there is already legal idiom (the filter is `line IS NULL OR
//     line=?`, so line:'drain' means "only give me line-less cards" — drain
//     procedures use exactly this);
//   ② the gate would catch only a SUBSET of the symptom: typo `design` for `alpha`
//     is inside the domain and looks identical to "that shelf is just empty" —
//     a gate that cannot tell the two apart leaves only false reassurance;
//   ③ what stands instead is MISS VISIBILITY: one 204 says nothing, but "how many
//     consecutive misses with the same filter, and what the filter was" does —
//     an empty shelf eventually refills and the counter resets; a typo never does.
// ⛔ On a hit the record is DELETED. Kept, it becomes a permanently red badge that
//   everyone learns to ignore = same as absent.
const claimMiss = new Map();   // worker → { n, since, at, route, line }
const MISS_MAX = 64;           // record cap (the while below drops the oldest)
function noteClaim(worker, opts, hit) {
  const w = String(worker || "");
  if (!w) return;                       // empty worker is refused by the store (400) — not recorded
  if (hit) { claimMiss.delete(w); return; }
  const prev = claimMiss.get(w);
  // ⚠ Defaults are written with the SAME expressions store.claim uses
  //   (`route || DEFAULT` / `line || worker`). A different expression would desync
  //   the record from the filter actually used — the "should match but 0 results"
  //   investigation gets harder, the same two-copies trap again.
  claimMiss.set(w, { n: (prev?.n || 0) + 1, since: prev?.since ?? Date.now(), at: Date.now(),
                     route: opts.route || store.DEFAULT_ROUTE, line: opts.line || w });
  // ⚠ Keys are caller-chosen strings — never unbounded. Overflow drops the OLDEST
  //   miss (what we show is "misses still happening"). ⛔ The just-written key is
  //   excluded from eviction — with equal timestamps, insertion order could evict it.
  while (claimMiss.size > MISS_MAX) {
    let old = null;
    for (const [k, v] of claimMiss) if (k !== w && (!old || v.at < old[1].at)) old = [k, v];
    if (!old) break;
    claimMiss.delete(old[0]);
  }
}
// Interpreter for the loops. Host config wins; otherwise probe once at boot —
// bare Ubuntu ships only `python3`, and guessing wrong used to surface as a
// spawn 'error' with no context instead of a plain sentence at startup.
const PY = process.env.BOARD_PYTHON || (() => {
  for (const c of ["python", "python3"]) {
    try { execFileSync(c, ["-c", "print(1)"], { stdio: "ignore", windowsHide: true }); return c; }
    catch {}
  }
  console.error("⚠ 找不到 python/python3 —— worker 线将无法启动(设 BOARD_PYTHON 指向解释器)");
  return "python";
})();
// ⭐ Crash-backoff BASE (default 30s; then ×2 per step, 15-minute cap is fixed).
//   Only tests shrink it (the 30s→60s ladder cannot be observed without real
//   waiting otherwise). ⛔ Never shrink in production: it directly scales how fast
//   a crash loop burns quota on unattended nights.
const CRASH_BACKOFF_MS = Math.max(1, Number(process.env.BOARD_CRASH_BACKOFF_MS) || 30_000);
const SETTINGS_FILE = join(store.DATA_DIR, "worker_settings.json");

// ── 用量账本:归并、分组与结算都在 core/usage.mjs ───────────────────────────
// usage_ledger.jsonl 只追加;模块记住末个完整行的字节位置,只归并新行。
const USAGE_FILE = join(store.DATA_DIR, "usage_ledger.jsonl");
const usageLedger = openLedger(USAGE_FILE, { makeDefault: true });
const refreshUsage = () => usageLedger.refresh();
// 结算钩子:给「已完成但还没结算」的卡各写一条结算事件(同一次完成只写一条)。
function settleUsage() {
  try {
    usageLedger.settle(db.prepare("SELECT id, line, resolved_at, resolved_by FROM tasks " +
      "WHERE status='done' AND resolved_at IS NOT NULL AND resolved_at>=? ORDER BY resolved_at, id").all(usageLedger.watermark()));
  } catch (e) { console.error("用量结算失败:", e.message); }
}
// 合同 C「效率」:本期对上期的汇总(core/efficiency.mjs,只读;卡死判定沿用 COORD_STALE_MS)。
const efficiency = createEfficiency({ db, ledger: usageLedger, lines: () => SUPERVISED || [], labels: () => LINE_LABEL || {},
                                     isExecutor: coord.isExecutor, staleMs: () => COORD_STALE_MS });
const MAX_PARALLEL = Math.max(1, Number(CFG.max_parallel) || 3);
const DEFAULT_AGENT = { ...CFG.default_agent };
const DEFAULT_SET = { agents: [{ ...DEFAULT_AGENT }], rev: 0 };
const EXECUTION_PROFILES = loadExecutionProfiles(CFG.execution_profiles,{dataDir:store.DATA_DIR});
const profileOf = agent => getExecutionProfile(EXECUTION_PROFILES,agent?.execution_profile_id,agent?.runtime);
const profileForAgent = (agent,line) => {
  const p=profileOf(agent);if(!p)return null;
  const base=executionProfileSnapshot(p),identity=directoryIdentity(REPO_ROOT);
  const workspace={label:"当前项目",path:identity.root,device:identity.device,inode:identity.inode};
  const tools=LINE_ROLE[line]?.tools||"write";
  // 本人放行的目录身份与权限也是执行身份的一部分，重启或改配置不能沿用旧授权。
  const profile_digest=createHash("sha256").update(JSON.stringify({profile_digest:base.profile_digest,workspace,tools})).digest("hex");
  return {...base,model:agent.model,effort:agent.effort,workspace,tools,profile_digest};
};
const profileFacts = () => publicExecutionProfiles(EXECUTION_PROFILES,{runtimes:RUNTIMES,repoRoot:REPO_ROOT});
function taskProfilePreview(task){
  const fixed=store.taskExecutionProfile(db,task.id);if(!fixed)return null;
  let shown=fixed,ready=true,reason="";
  if(task.status==="not_started"&&!task.released){
    const agent=settingsOf(task.line).agents.find(a=>a.execution_profile_id===fixed.execution_profile_id&&a.model===fixed.model&&a.effort===fixed.effort);
    const fact=profileFacts().find(p=>p.id===fixed.execution_profile_id);
    if(agent){shown=profileForAgent(agent,task.line);ready=!!fact?.ready;reason=fact?.reason||"执行配置不可用";}
    else{ready=false;reason="执行线已更换配置，请核对任务原先选择的通道与模型";}
  }
  return {...shown,ready,reason,configuration_changed:shown.profile_digest!==fixed.profile_digest};
}
// 只有本人核对本次预览后，才把新默认轮数写进放行记录；旧调用保持一轮。
function taskRepairPreview(task) {
  if (task.status === "not_started" && !task.released) {
    const configured=Number(process.env.BOARD_VERIFY_REPAIR_ROUNDS ?? 3);
    const maxChars=Number(process.env.BOARD_EVIDENCE_MAX_CHARS ?? 4000);
    const policy={max_rounds:Number.isSafeInteger(configured)&&configured>0?configured:1,legacy_retry:false,
      evidence_contract:{version:1,max_chars:Number.isSafeInteger(maxChars)&&maxChars>0?maxChars:4000}};
    return {policy,digest:createHash("sha256").update(JSON.stringify(policy)).digest("hex")};
  }
  return {policy:store.taskVerificationRepair(db,task,{fromRun:task.status!=="not_started"})};
}
const DECOMPOSE_MODELS = CFG.decompose_models;
// Natural language for GENERATED content (decomposed cards today; other generators
// later). Empty = say nothing, and the generator mirrors the prompt's own language.
const LANGUAGE = String(CFG.language || "").trim();
// 对话式首页的协调线(core/coordinator-cli.mjs):模型、强度、每次调用的时限。缺省 = 拆解用的第一个模型、high、420 秒
// (2026-11-10 拆解评测两轮:claude-opus-5/high 质量最好,单轮最长 265〜356 秒,180 秒不够)。
// 写了但写错就拒绝启动,与其他配置错误同一规则。
const COORDINATOR = (() => {
  const raw = CFG.coordinator ?? {};
  try {
    if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("必须是对象 {model, effort, timeout_sec}");
    const model = raw.model ?? DECOMPOSE_MODELS?.[0]?.id ?? BUILTIN_CONFIG.decompose_models[0].id;
    const effort = raw.effort ?? "high", timeout = raw.timeout_sec ?? 420;
    if (typeof model !== "string" || !model.trim()) throw new Error("model 必须是非空字符串");
    if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("effort 只接受 low / medium / high / xhigh / max");
    if (typeof timeout !== "number" || !(timeout > 0) || timeout > 3600) throw new Error("timeout_sec 必须是 0 到 3600 之间的秒数");
    return { model: model.trim(), effort, timeout_sec: timeout };
  } catch (e) { console.error(`拒绝启动:${CONFIG_FILE} 的 coordinator ${e.message}`); process.exit(1); }
})();
// 测试与 mock 用:整条基础命令由 JSON 数组给出(与 WORKER_CLI_ARGV、REVIEWER_CLI_ARGV 同一做法)。不设就找 Claude CLI。
const COORDINATOR_ARGV = (() => {
  const raw = process.env.BOARD_COORDINATOR_CLI_ARGV;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string" && x)) throw new Error("必须是非空字符串数组");
    return v;
  } catch (e) { console.error(`拒绝启动:BOARD_COORDINATOR_CLI_ARGV 读不了(${e.message})`); process.exit(1); }
})();

// Seats. A seat may declare release_env (must be "1" to unlock) and cmd_env (host
// must point it at the CLI). Locked seats are visible but refuse save/start —
// visibility without permission is how permission stays a HUMAN act.
const seatUnlocked = (r) => !r.release_env || process.env[r.release_env] === "1";
const seatCmdOk = (r) => !r.cmd_env || !!process.env[r.cmd_env];
const RUNTIMES = CFG.runtimes.map((r) => ({
  ...r, disabled: !seatUnlocked(r),
  label: seatUnlocked(r) ? r.label : `${r.label}(未解禁)`,
}));
const RUNTIME_IDS = RUNTIMES.map((r) => r.id);
const EFFORTS = RUNTIMES[0]?.efforts || ["low", "medium", "high"];
const MODELS = RUNTIMES[0]?.models || [];

// ── Subscription-pool state. "Exhausted" is detected by the API's rate-limit
//    FAILURE, never predicted by dollar/token arithmetic (INCIDENT-8).
const POOL_IDS = RUNTIME_IDS;
const POOL_HOLD_MS = Math.max(100, Number(process.env.BOARD_POOL_HOLD_MS) || 5 * 60 * 60 * 1000);
const POOL_RECONCILE_MS = Math.max(50, Number(process.env.BOARD_POOL_RECONCILE_MS) || 5000);
const POOL_FILE = join(store.DATA_DIR, "pool_state.json");
const POOL_STOP_FILE = join(store.DATA_DIR, "pool_global_stop.json");
const emptyPools = () => Object.fromEntries(POOL_IDS.map((p) => [p, { exhausted_at: null, until: null }]));
const validPoolEntry = (v) => {
  const a = Date.parse(v?.exhausted_at || ""), u = Date.parse(v?.until || "");
  return Number.isFinite(a) && Number.isFinite(u) && u > a
    ? { exhausted_at: new Date(a).toISOString(), until: new Date(u).toISOString() }
    : { exhausted_at: null, until: null };
};
let poolState = emptyPools();
try {
  const raw = JSON.parse(readFileSync(POOL_FILE, "utf8"));
  for (const p of POOL_IDS) poolState[p] = validPoolEntry(raw?.[p]);
} catch { /* first run / broken file: start empty; next save restores the shape */ }
const poolDown = (p) => !!poolState[p]?.exhausted_at; // even past `until`, down until a probe succeeds
const bothPoolsDown = () => POOL_IDS.every(poolDown);
function savePools() {
  const tmp = POOL_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(poolState, null, 1), "utf8");
  renameSync(tmp, POOL_FILE);
}
function markPoolDown(runtime, observedAt = Date.now()) {
  const at = Number(observedAt);
  const now = Date.now();
  // A badly skewed loop clock must not extend the hold window into the future.
  const safeAt = Number.isFinite(at) && Math.abs(at - now) <= 5 * 60 * 1000 ? at : now;
  poolState[runtime] = { exhausted_at: new Date(safeAt).toISOString(),
                         until: new Date(safeAt + POOL_HOLD_MS).toISOString() };
  savePools();
  return poolState[runtime];
}
function clearPool(runtime) {
  poolState[runtime] = { exhausted_at: null, until: null };
  savePools();
}
function updateGlobalStopMarker(reason = "pool-state-change") {
  if (bothPoolsDown()) {
    const next = Math.min(...POOL_IDS.map((p) => Date.parse(poolState[p].until)));
    const body = { active: true, reason: "all pools exhausted",
                   observed_at: new Date().toISOString(), next_recheck_at: new Date(next).toISOString(),
                   trigger: reason };
    const tmp = POOL_STOP_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(body, null, 1), "utf8"); renameSync(tmp, POOL_STOP_FILE);
  } else {
    try { unlinkSync(POOL_STOP_FILE); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  }
}

// Saved settings stay untouched; only the SPAWN maps a seat onto the other pool.
function failoverAgent(ag, runtime) {
  const seat = seatOf(runtime);
  if (!seat || !seat.models?.length) return null;
  const model = seat.models[0].id;
  const dom = effortsFor(runtime, model);
  // ⭐ Failover preserves WORKING STRENGTH: keep the effort when the target seat
  //   declares it; otherwise take the seat's HIGHEST declared tier (domains are
  //   declared low→high, so the last entry is the top). The earlier draft fell
  //   back to "high", silently DOWNGRADING a max slot on every pool switch — a
  //   policy nobody chose, visible only in the ledger weeks later.
  const effort = dom.includes(ag.effort) ? ag.effort : dom[dom.length - 1];
  return { ...ag, runtime, model, effort };
}
function effectiveAgents(line, st = settingsOf(line)) {
  // Roles are single-seat but share the same runtime branches as ordinary lines:
  // only agents[0] is taken; failover, model mapping and gates run the same road.
  const single = ROLES.includes(line);
  const src = single ? [st.agents[0]] : st.agents;
  const mapOne = (ag) => {
    const rt = ag.runtime || RUNTIME_IDS[0];
    const profile=profileOf(ag);
    if(profile)return profile.auth_kind==="api_key"||!poolDown(rt)?ag:null;
    if(bothPoolsDown())return null;
    if (!poolDown(rt)) return ag;
    const other = POOL_IDS.find((p) => p !== rt && !poolDown(p));
    if (!other) return null;
    const seat = seatOf(other);
    if (!seat || seat.disabled || !seatCmdOk(seat)) return null;
    return failoverAgent(ag, other);
  };
  const mapped = src.map(mapOne);
  return mapped.every(Boolean) ? mapped : null;
}
/** Seats and their model/effort domains. ⭐ THE single resolver — the save gate, the
 *  probe and the panel all go through it (write the domain twice and the UI offers
 *  a forbidden rung the day only one copy is fixed). */
const seatOf = (rt) => RUNTIMES.find((r) => r.id === (rt || RUNTIME_IDS[0]));
const effortsFor = (rt, modelId) => {
  const seat = seatOf(rt);
  if (!seat) return EFFORTS;
  const m = (seat.models || []).find((x) => x.id === modelId);
  return (m && m.efforts) || seat.efforts || EFFORTS;
};
/** v0.22: an identity's seat is judged by the seat DECLARATIONS — the same resolver as the
 *  save gate, so a role naming a model its seat does not declare fails at config time, not
 *  at the first start. A LOCKED seat passes here (the declaration is fine; unlocking is a
 *  separate human act) and roleSeatDefault falls back loudly. */
function assertRoleSeat(role, lineId) {
  if (!role?.seat) return;
  const s = role.seat, rt = seatOf(s.runtime);
  if (!rt) throw store.err(store.ERR.BAD_INPUT, `线 ${lineId} 的 role.seat: 未知运行时 ${JSON.stringify(s.runtime)}(座席表: ${RUNTIME_IDS.join("/")})`);
  if (!(rt.models || []).some((m) => m.id === s.model))
    throw store.err(store.ERR.BAD_INPUT, `线 ${lineId} 的 role.seat: ${rt.label} 没有模型 ${JSON.stringify(s.model)}`);
  const dom = effortsFor(s.runtime, s.model);
  if (!dom.includes(s.effort))
    throw store.err(store.ERR.BAD_INPUT, `线 ${lineId} 的 role.seat: ${s.model} 的强度必须是 ${dom.join("/")}(座席宣言值域)—— 收到 ${JSON.stringify(s.effort)}`);
}
for (const id of LINES) {
  try { assertRoleSeat(LINE_ROLE[id], id); }
  catch (e) { console.error(`拒绝启动:${CONFIG_FILE} 存在但不可用 —— ${e.message}`); process.exit(1); }
}
/** agents[0] for a line that was never configured from the panel: the identity's seat when
 *  it names one and that seat is unlocked; otherwise the global default — said once on the
 *  console, and visible on /api/workers as seat_drift. Never silently. */
const roleSeatWarned = new Set();
function roleSeatDefault(line) {
  const seat = LINE_ROLE?.[line]?.seat;
  if (!seat) return DEFAULT_AGENT;
  const rt = seatOf(seat.runtime);
  if (rt && !rt.disabled) return agentOf(seat);
  if (!roleSeatWarned.has(line)) {
    roleSeatWarned.add(line);
    console.error(`⚠ 线 ${line} 的身份缺省座席 ${seat.runtime} 未解禁 —— 首次启动改用全局缺省 ` +
                  `${DEFAULT_AGENT.runtime}/${DEFAULT_AGENT.model};解禁后在面板改回(/api/workers 的 seat_drift 会一直标着)`);
  }
  return DEFAULT_AGENT;
}
/** v0.23: which runtime family the auto-review seat is SAVED to run on — the anti-affinity
 *  criterion the panel and /api/review/pending share. The live reviewer names its own
 *  runtime on the query (`?runtime=`), which wins when given (pool failover can move it). */
const reviewSeatRuntime = () => settingsOf("review").agents?.[0]?.runtime || RUNTIME_IDS[0];
/** Does the line's effective agents[0] differ from the seat its identity names? */
const seatDrift = (line, st) => {
  const seat = LINE_ROLE?.[line]?.seat;
  if (!seat) return false;
  const a = st.agents?.[0] || {};
  return ["runtime", "model", "effort"].some((k) => String(a[k] ?? "") !== String(seat[k] ?? ""));
};

// ───────── Line lineage: inheriting memory from a desktop conversation ─────────
// A worker's session is born from randomUUID = a newcomer who knows NOTHING. Each
// line can be forked ONCE (--fork-session) from a designated desktop conversation:
// the original stays untouched, the live context fits the window, and resume across
// project dirs is measured to work.
// ⚠ Conversation ids are PERSONAL. In source they enter git and leave with a push
//   (measured on the origin). They live in .data/ (gitignored); the template is
//   examples/lineage.example.json. Absent = no inheritance, board runs fine.
const LINEAGE_FILE = join(store.DATA_DIR, "lineage.json");
// 面板登记的(POST /api/desktop-sessions/lines)另存 desktop_lineage.json,运行时增删;手写 lineage.json 照旧生效,
// 同名时手写为准、且面板解除不了(LINEAGE_HAND)。没写 source 的手写项按 claude。
let LINEAGE = { ...loadDeskLineage(store.DATA_DIR) };
const LINEAGE_HAND = new Set();
try {
  const raw = JSON.parse(readFileSync(LINEAGE_FILE, "utf8"));
  for (const [k, v] of Object.entries(raw))
    if (!k.startsWith("_") && v && v.session) { LINEAGE[k] = v; LINEAGE_HAND.add(k); }
} catch { /* fine to be absent; the startup log says so */ }
// BOARD_CLAUDE_PROJECTS: test-only escape hatch. A harness must never plant a transcript
// under the operator's real ~/.claude/projects, so it points this at a temp dir instead.
const PROJECTS = process.env.BOARD_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");
// BOARD_CODEX_HOME: 同上,测试把 Codex 根目录(含 session_index.jsonl 与 sessions/)指到临时目录。
const CODEX_HOME = process.env.BOARD_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex");
// 桌面端对话清单(只读)与操作者勾选;勾选存在数据目录(不进 git)。见 core/desktop-sessions.mjs。
const deskSessions = createDesktopSessions({ claudeRoot: PROJECTS, codexRoot: CODEX_HOME, dataDir: store.DATA_DIR });
let settings = {};
try { settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")); } catch {}
// One-time migration: legacy {model,effort,window,parallel,runtime} → agents[]
// (parallel copies). Legacy keys are DELETED and written back — kept, they are
// "the same fact in two places" and will drift.
const agentOf = (src) => ({
  runtime: src?.runtime || DEFAULT_AGENT.runtime, model: src?.model || DEFAULT_AGENT.model,
  effort: src?.effort || DEFAULT_AGENT.effort, window: !!src?.window,
  ...(src?.execution_profile_id!==undefined?{execution_profile_id:src.execution_profile_id}:{}) });
{
  let migrated = false;
  for (const [ln, e] of Object.entries(settings)) {
    if (!e || typeof e !== "object" || Array.isArray(e.agents)) continue;
    const n = Math.max(1, Math.min(MAX_PARALLEL, Number(e.parallel) || 1));
    e.agents = Array.from({ length: n }, () => agentOf(e));
    for (const k of ["model", "effort", "window", "parallel", "runtime"]) delete e[k];
    migrated = true;
    console.log(`worker_settings: ${ln} 旧形 → agents[${n}] 迁移`);
  }
  if (migrated) writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
}
const settingsOf = (line) => {
  const saved = settings[line] || {};
  const raw = { ...DEFAULT_SET, ...saved };
  // v0.22: a never-configured line starts on its identity's seat (roleSeatDefault), not on
  // the global default — the identity is the operator's declaration of what runs here.
  // ⚠ "Never configured" is judged on what was SAVED, not on `raw`: DEFAULT_SET already
  //   carries a non-empty agents[], so testing raw.agents made the identity seat unreachable
  //   (caught by servertest Q2-2 — the fallback's console line never appeared).
  raw.agents = (Array.isArray(saved.agents) && saved.agents.length ? saved.agents : [roleSeatDefault(line)]).map(agentOf);
  return raw;
};

/** The line's persistent session id; minted and persisted on first use. */
function sessionOf(line) {
  if (!settings[line]?.session_id) {
    settings[line] = { ...settingsOf(line), session_id: randomUUID() };
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
  }
  return settings[line].session_id;
}

/** Whether the line has been forked from its desktop conversation yet. */
function lineageOf(line) {
  const L = LINEAGE[line];
  if (!L) return null;
  return { ...L, forked: !!settings[line]?.forked_from };
}
function markForked(line, newSessionId) {
  settings[line] = { ...settingsOf(line), session_id: newSessionId,
                     forked_from: LINEAGE[line]?.session || null,
                     forked_at: new Date().toISOString() };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
  emit("worker.changed", { line });
  return settings[line];
}

/** Find the transcript file. Scanning beats composing the slug (slugs rot). */
function transcriptOf(sid) {
  try {
    for (const d of readdirSync(PROJECTS)) {
      const p = join(PROJECTS, d, sid + ".jsonl");
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

// transcript path → incremental fold state; see contextOf.
const ctxFold = new Map();

/**
 * The line's real context size.
 * ⭐ The gauge is the LAST assistant turn's usage (input + cache_creation +
 *   cache_read) — what actually entered the model that turn. File bytes are only a
 *   rough hint.
 */
function contextOf(line) {
  // ⚠ A listing read must not MINT a session (sessionOf allocates when absent).
  //   Lines without persistent sessions would grow ghost ids — peek only.
  const sid = settings[line]?.session_id || null;
  if (!sid) return { line, session_id: null, transcript: null, exists: false, no_session: true,
                     bytes: 0, messages: 0, tokens: null, last_compact: null, compactions: 0 };
  const path = transcriptOf(sid);
  const out = { line, session_id: sid, transcript: path, exists: !!path,
                bytes: 0, messages: 0, tokens: null, last_compact: null, compactions: 0 };
  if (!path) return out;
  // ⭐ Incremental fold (v0.12.1), the shape refreshUsage uses above: the transcript is
  //   append-only, so remember the byte offset of the last COMPLETE line per file and
  //   fold only what is new. The full read this replaced was synchronous and ran for
  //   EVERY supervised line on EVERY panel refresh (15 s timer + each SSE change) and
  //   on every worker claim cycle; a long session's transcript reaches tens of MB and
  //   that parse blocked the event loop the workers' claims were queued behind
  //   (external review 2026-09-07). The scan is a strict left-to-right reduction with
  //   no look-back, so folding it incrementally is exact, not approximate.
  const size = statSync(path).size;
  out.bytes = size;
  let st = ctxFold.get(path);
  if (!st || size < st.offset)            // first sight, or truncated (shorter than our offset) → refold
    st = { offset: 0, messages: 0, lastUsage: null, compactions: 0, last_compact: null };
  const fold = (ln) => {
    if (!ln.trim()) return;
    let d; try { d = JSON.parse(ln); } catch { return; }
    st.messages++;
    const u = d.message?.usage;
    if (u) st.lastUsage = u;
    // ⭐ Crossing a compaction boundary RESETS the gauge. Usage before the boundary
    //   is the PRE-compaction context, not the current one (reading it once
    //   produced the lie "compacted yet grew").
    if (d.subtype === "compact_boundary" || d.compactMetadata) st.lastUsage = null;
    if (d.compactMetadata) {
      st.compactions++;
      st.last_compact = {
        trigger: d.compactMetadata.trigger,
        pre: d.compactMetadata.preTokens, post: d.compactMetadata.postTokens,
        dropped: d.compactMetadata.cumulativeDroppedTokens,
        at: d.timestamp || null,
      };
    }
  };
  if (size > st.offset) {
    let text = null;
    try {
      const fd = openSync(path, "r");
      const buf = Buffer.alloc(size - st.offset);
      readSync(fd, buf, 0, buf.length, st.offset);
      closeSync(fd);
      text = buf.toString("utf8");
    } catch { text = null; }                // unreadable this tick: report what we had
    if (text != null) {
      const NL10 = String.fromCharCode(10);
      // ⚠ The writer may be mid-line. Fold up to the last newline; a non-empty tail is
      //   folded only if it already parses as a whole JSON line (a file whose last line
      //   lacks its newline), otherwise it waits, complete, for the next pass.
      const cut = text.lastIndexOf(NL10);
      const head = cut >= 0 ? text.slice(0, cut + 1) : "";
      const tail = cut >= 0 ? text.slice(cut + 1) : text;
      for (const ln of head.split(NL10)) fold(ln);
      let consumed = head;
      if (tail.trim()) { try { JSON.parse(tail); fold(tail); consumed = text; } catch {} }
      st.offset += Buffer.byteLength(consumed, "utf8");
    }
  }
  ctxFold.set(path, st);
  out.messages = st.messages; out.compactions = st.compactions; out.last_compact = st.last_compact;
  const lastUsage = st.lastUsage;
  if (lastUsage) out.tokens = (lastUsage.input_tokens || 0)
    + (lastUsage.cache_creation_input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0);
  else if (out.last_compact) out.tokens = out.last_compact.post;   // right after compaction = no next turn yet
  return out;
}

const runCli = (args, timeout = 600000) => new Promise((resolve) => {
  // 用哪个可执行文件:与对话的协调线同一个帮助函数(config-setup.mjs 的 resolveClaudeCli,规则同执行线)。
  // WORKER_CLAUDE_CLI 写了就以它为准;PATH 上只有 npm 的 .cmd 包装器时改用旁边的原生可执行文件;
  // 都没有就不起进程,把写给人看的原因放进 stderr 交回(调用方会把它带进报错)。
  const cli = resolveClaudeCli(process.env);
  if (!cli.exe) return resolve({ code: 1, stdout: "", stderr: cli.reason });
  const CLAUDE_CLI = cli.exe;
  // ⭐ The prompt rides argv (-p) on the claude seat, and Windows CreateProcess caps a
  //   command line at 32767 UTF-16 chars: over budget, execFile dies with an opaque
  //   spawn error. Same caliber as the zcode gate (zcode-profile.mjs) and the two loop
  //   scripts — refuse BEFORE spawning, naming the knob to turn (external audit
  //   2026-10-05). Per arg: UTF-16 length ×2 +3 (quotes + separator), conservative.
  if (args.reduce((n, a) => n + a.length * 2 + 3, CLAUDE_CLI.length) > 30000)
    return resolve({ code: 1, stdout: "",
      stderr: "提示词 argv 超过 Windows 30000 字符预算(32767 上限)—— 调小相应预算后重试,已拒发" });
  // 看板直接起 claude 的唯一出口(一键拆解、上下文压缩)。环境与执行线旧线同一规则:剔除全部配置登记的
  // 凭据变量,另去掉看板自身的令牌类变量;标准登录变量保留(board-claude-cli.mjs)。
  // cwd 是看板自建的空目录:dontAsk 下 cwd 范围内的读取不需要放行规则,继承 server 的工作目录(可能是
  // 用户主目录)就等于把那一片交给拆解器读。
  execFile(CLAUDE_CLI, args, { timeout, maxBuffer: 8 << 20, windowsHide: true, cwd: boardCliCwd(),
                               env: boardCliEnvironment({ env: process.env, profiles: EXECUTION_PROFILES }) },
    // ran = 模型进程起跑过(用量记账据此判断要不要记一行);上面两处没起进程就交回的没有这个键。
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "",
                                       ran: !String(err?.syscall || "").startsWith("spawn") }));
});
// 本进程第一次起 CLI 时在系统临时目录下新建,看板不往里写任何东西(拆解 --no-session-persistence;压缩
// --resume 按会话 id 续写原转录,2026-10-28 实测该目录跑完仍为空)。
let BOARD_CLI_CWD = null;
const boardCliCwd = () => BOARD_CLI_CWD || (BOARD_CLI_CWD = mkdtempSync(join(tmpdir(), "kanban-board-cli-")));
// 两个调用共用的路径拒绝范围:整个数据目录、验证登记簿、全部执行配置的认证目录(与 slotEnv 下传的同一组)。
const boardCliScope = () => ({ dataDir: resolve(store.DATA_DIR),
  registry: resolve(process.env.BOARD_VERIFY_REGISTRY || join(CODE_ROOT, "core", "verify_registry.json")),
  authHomes: EXECUTION_PROFILES.map((p) => resolve(p.auth_home)) });

/**
 * 按计划建子卡:一键拆解(decomposeGoal)与对话的按计划建卡(applyConversationPlan)共用这一段。
 * 按顺序建,`after` 序号换成已建卡的卡号。调用方负责目标卡、事务与事件。
 */
function createPlanChildren(goalId, list, { actor = null } = {}) {
  // Create in order; `after` indices translate to already-created ids.
  const made = [];
  // ⭐ This is a WRITE ROAD with no HTTP counterpart to 400 at — the line values come
  //   from a MODEL's output. Out-of-domain lines fall to null (= no line): the
  //   reversible failure. A stray value stored raw would never match claim's filter
  //   and rot silently in not_started — the exact pathology the domain gate exists
  //   for. ⚠ Three-state preserved: "model said unsure" (null) and "model emitted an
  //   out-of-domain name" (typo) are DIFFERENT things — the latter is recorded on
  //   the card face and counted in the response (never silently converted).
  const demoted = [];
  const held = [];   // 建好没放行的卡号(needs_confirm)
  list.forEach((t, i) => {
    const deps = (t.after || []).map((n) => made[Number(n) - 1]).filter((x) => x != null);
    const want = t.line && t.line !== "null" ? String(t.line) : null;
    // The domain is the implement lines (v0.22): a review line named here is out of
    // domain exactly like a typo — the card is recorded, not silently converted.
    const line = (want === null || IMPL_LINES.includes(want)) ? want : null;
    let description = String(t.description || "");
    if (want !== null && line === null) {
      demoted.push({ n: i + 1, subject: String(t.subject || "(无题)"), line: want });
      description += String.fromCharCode(10, 10) +
        `⚠拆解时给的线名「${want}」不在实现线可选表内(${IMPL_LINES.join("/")};评审线不接实现卡),已落为「不指定线」` +
        "——谁都能领,但没人被点名。请人工确认该派给哪条线。";
    }
    // 只有对话计划带 needs_confirm(拆解的 schema 里没有这个字段):这张卡建好不放行,线领不到;
    //   操作者看过、确认后放行。不挂人工闸(人工闸是「等人裁定」,这里等的是放行这一下)。
    const hold = t.needs_confirm === true;
    if (hold)
      description += String.fromCharCode(10, 10) +
        "⚠这张卡涉及需要人确认的动作(生产数据、迁移、删除、推送或花钱),建卡时没有放行。要操作者确认后放行。";
    made[i] = store.add(db, {
      subject: String(t.subject || "(无题)"), description,
      // 给人看的「要做什么」:拆解计划里带就带上,没带就是 null(退路在 store.cardBrief)。
      //   schema 里它是可选项 —— 旧模型、旧计划不出这个字段也不该让整次拆解失败。
      summary: t.summary,
      acceptance: String(t.acceptance || ""), line,
      needsBash: !!t.needs_bash, blockedBy: deps, kind: "task", parentId: goalId,
      // The release valve moved to worker start/stop (ruling): decomposed children
      // are claimable from birth; "not yet" is expressed by not starting that
      // line's worker.
      released: hold ? 0 : 1,
      // v0.23: a decompose that overrode the review gate says so on every child's `add`
      // event — "ran because the human forced it" must not read like a plain decompose.
      // 对话的按计划建卡写 operator(人按下的)。
      ...(actor ? { actor } : {}),
    });
    if (hold) held.push(made[i]);
  });
  return { made, demoted, held };
}

/**
 * Decompose a goal into child tasks.
 * The LLM only PRODUCES A PLAN — the server creates the cards. Letting the
 * decomposer hit the board API makes failure and partial application inseparable.
 * 2026-10-28:计划经 --json-schema 的结构化输出交回(只读 structured_output,不从正文抠 JSON),
 * 不再是模型写的文件。拆解器只有 Read/Glob/Grep,没有任何写工具,不挂 core/,数据目录与认证目录
 * 拒读(board-claude-cli.mjs)。结构化输出缺失或不合结构是内部失败(500);线名不在实现线内照旧
 * 落为「不指定线」并记在卡面上(下方 demoted)。
 */
async function decomposeGoal(goalId, model, forced = false) {
  const g = store.get(db, goalId);
  // Missing-id checks are classified too — untyped, this would fall to 400 and
  // punch a hole in the "missing ids are 404" ruling (found by grep once).
  if (!g) throw store.err(store.ERR.NOT_FOUND, `目标 ${goalId} 不存在`);
  if (g.kind !== "goal") throw store.err(store.ERR.BAD_INPUT, `#${goalId} 不是目标`);

  // ⭐ The prompt is assembled in decompose_lib.js so it can be MEASURED. Built here
  //   it was unreachable by any harness: this module listens on import, and neither a
  //   .cmd stub (Node refuses to spawn one) nor a Node stub (it rejects the unknown
  //   flags before any preload) can observe the arguments. See that file's header.
  const prompt = decompose.buildDecomposePrompt({
    goal: g,
    prev: g.parent_id != null ? store.get(db, g.parent_id) : null,
    // v0.22: the menu is the IMPLEMENT lines only — a review line takes no implementation
    // card (its worker would refuse to write code by construction), and a menu that offers
    // it is a de-facto permission. Labels ride along so the model sees the operator's word.
    lines: IMPL_LINES, hints: LINE_HINT, labels: LINE_LABEL, language: LANGUAGE,
  });

  const cliModel = model || DECOMPOSE_MODELS[0].id, cliStarted = Date.now();
  const r = await runCli(decomposeCliArgs({ prompt, model: cliModel,
                                            repoRoot: resolve(REPO_ROOT), ...boardCliScope() }));
  // 用量结算:拆解这一轮记到目标卡上(phase=decompose)。没拆成的一轮也花了额度,所以在判结果之前记;
  //   结果消息读不出来时各项是 null(未知),耗时退到墙钟。进程没起跑不记。
  if (r.ran) {
    const seen = fromClaudeResult(cliResult(r.stdout).result);
    usageLedger.append({ phase: "decompose", card: Number(goalId), worker: "decompose", model: cliModel, effort: "high",
                         ...seen, duration_ms: seen.duration_ms ?? Date.now() - cliStarted });
  }
  // The failures below are OUR internal failures (child would not start /
  // did not honor the contract). The request is fine, so a 400 would tell the
  // caller "resending is pointless" — a lie ⇒ INTERNAL 500.
  const parsed = decomposePlanOf(r.stdout);
  if (!parsed.ok)
    throw store.err(store.ERR.INTERNAL, `拆解没给出可用的结果(rc=${r.code}):${parsed.reason}。尾部:${(r.stdout + r.stderr).slice(-400)}`);
  const d = parsed.plan;
  const list = Array.isArray(d.tasks) ? d.tasks : [];
  // ⚠ "Zero children" is internal too: the prompt says "emit exactly 1 if it will
  //   not split", so an empty array means the upstream ignored instructions — not
  //   that the goal was badly written (≠ BAD_INPUT).
  if (!list.length) throw store.err(store.ERR.INTERNAL, "拆解结果里没有子任务");

  const { made, demoted } = createPlanChildren(goalId, list, forced ? { actor: "decompose(forced)" } : {});
  emit("goal.decomposed", { id: goalId, made });
  // demoted = children whose line name was dropped (empty = normal): the one
  // machine-readable mouth for "the model misspelled a line" — the card face has it
  // too, but that is for humans.
  return { goal: goalId, model: model || DECOMPOSE_MODELS[0].id, made, count: made.length,
           demoted, forced: !!forced };
}

/**
 * v0.23: the plan-review card — the first station of the pipeline (方案 → 对抗评审 → 拆解 →
 * 实现 → 自动审阅 → 人), built from primitives the board already has: one child card on a
 * review-kind line, under the goal. Its evidence IS the review (no file protocol beside the
 * board — operator ruling 2026-09-28). The decompose gate holds until it is done. One
 * pending review card per goal: a second request is a CONFLICT, not a duplicate.
 */
function pipelineReview(goalId, lineRaw) {
  const g = store.get(db, goalId);
  if (!g) throw store.err(store.ERR.NOT_FOUND, `目标 ${goalId} 不存在`);
  if (g.kind !== "goal") throw store.err(store.ERR.BAD_INPUT, `#${goalId} 不是目标`);
  let line = lineRaw == null || lineRaw === "" ? null : String(lineRaw);
  if (line && !REVIEW_LINES.includes(line))
    throw store.err(store.ERR.BAD_INPUT, `线 ${line} 不是评审线(role.kind=review)—— 评审线有: ${REVIEW_LINES.join("/") || "(无)"}`);
  if (!line) line = REVIEW_LINES[0] || null;
  if (!line)
    throw store.err(store.ERR.CONFLICT, "没有配置评审线(lines[].role.kind=review)—— 先加一条:面板加线框选「评审」,或 python cli/board.py lines add <线> --kind review");
  const pending = store.openChildrenOnLines(db, goalId, REVIEW_LINES);
  if (pending.length)
    throw store.err(store.ERR.CONFLICT, `目标 #${goalId} 下已有未完成的评审卡 #${pending.join(" #")}`);
  const NL = String.fromCharCode(10);
  const description = [
    `评审对象:目标 #${goalId}「${g.subject}」的方案。方案正文在目标卡上(python cli/board.py show ${goalId});`,
    "若方案是仓库里的文件(docs/方案-<slug>.md),按目标卡写的路径与提交读它。",
    "",
    "只输出:会在哪里崩、哪些假设没有验证、哪些数字是拍的。按严重度排序,每条引方案原句或 文件:行。",
    "不夸,不给替代方案,不改任何文件。逐条核对过而没有问题的也写「核对过:…」。",
  ].join(NL);
  const acceptance = "证据逐条引用方案原句(或 文件:行),列出会崩的点与未验证的假设并按严重度排序;没有改动任何文件;核对过而无问题的项也写明。";
  const id = store.add(db, { subject: `对抗评审:${g.subject}`.slice(0, 200), description, acceptance,
                             line, parentId: goalId, humanGate: false, released: 1, kind: "task" });
  console.log(`目标 #${goalId} 起评审卡 #${id} → 线 ${line}`);
  return { goal: goalId, line, task: taskOut(store.get(db, id)) };
}

/**
 * One-click context tidy = two steps:
 *  ① the conversation writes its OWN handover memo (it knows best what to keep)
 *  ② `/compact <memo>` flows into the same conversation.
 * Both pass headless (measured: compact_boundary lands in the transcript).
 */
async function compactLine(line, note) {
  const sid = sessionOf(line);
  // The line exists (badLine passed) but has no conversation yet = the BOARD STATE
  // refuses ⇒ CONFLICT (it passes once the line has run).
  if (!transcriptOf(sid)) throw store.err(store.ERR.CONFLICT, `${line} 还没有会话记录,没什么可压缩的`);
  const before = contextOf(line);
  let memo = (note || "").trim();
  // 用量结算:压缩的两步各记一行(phase=compact,记在这条线上,不挂卡)。这两步不带 --output-format json,
  //   词元与费用读不到,记 null(未知),耗时取墙钟。进程没起跑不记。
  const account = (run, started, model, effort = null) => {
    if (run.ran) usageLedger.append({ phase: "compact", worker: line, line, model, effort, session_id: sid,
                                      duration_ms: Date.now() - started });
  };
  // 两步都只要模型产出文字:不给任何工具(--tools ""),拒绝规则与拆解同一组(board-claude-cli.mjs)。
  //   被续接的会话里有卡面正文,压缩这一步不该成为它伸手调工具的机会。
  if (!memo) {
    const askModel = settingsOf(line).agents[0].model, askStarted = Date.now();
    const ask = await runCli(compactCliArgs({ prompt:
      "接下来要对你自己这个会话做 /compact。请只输出一段【压缩指示】,告诉压缩程序哪些必须保留:" +
      "正在做的任务与其编号、已确认的事实与实测数字、踩过的坑与结论、未完成的下一步、" +
      "以及任何再问一遍代价很大的东西。不要复述全部历史,不要寒暄,不要用代码块,300 字以内。",
      sessionId: sid, model: askModel, effort: "low", ...boardCliScope() }));
    account(ask, askStarted, askModel, "low");
    memo = (ask.stdout || "").trim().slice(0, 1200);
  }
  if (!memo) memo = "保留当前任务、已确认的事实与数字、未完成的下一步。";
  const compactModel = settingsOf(line).agents[0].model, compactStarted = Date.now();
  const r = await runCli(compactCliArgs({ prompt: "/compact " + memo, sessionId: sid,
                                          model: compactModel, ...boardCliScope() }));
  account(r, compactStarted, compactModel);
  const after = contextOf(line);
  const did = after.compactions > before.compactions;
  // ⭐ The reported numbers come from the transcript's compactMetadata (pre/post).
  //   Our own gauge reads only the LAST turn and would pick up the memo-writing turn
  //   added just before compaction — it once produced "compacted yet grew".
  return { line, memo, cli_code: r.code, compactions: after.compactions, compacted: did,
           before: did ? after.last_compact.pre : before.tokens,
           after: did ? after.last_compact.post : after.tokens,
           dropped: did ? after.last_compact.dropped : 0,
           note: did ? "已压缩" :
                 "CLI 返回了,但转录里没有新的 compact 记录 —— 请看 memo 是否被当成普通提问" };
}
function setSettings(line, patch) {
  const cur = settingsOf(line);
  const next = { ...cur };
  // Settings accept agents[] (per-slot) only. Legacy keys are refused BY NAME —
  // silently ignoring them creates "200 yet zero columns changed" no-op accidents.
  // All refusals here are BAD_INPUT (same body, same result, forever).
  for (const k of ["model", "effort", "window", "parallel", "runtime"])
    if (patch[k] !== undefined)
      throw store.err(store.ERR.BAD_INPUT, `${k} 已迁入 agents[] —— 请整体提交 agents(旧档已自动迁移)`);
  if (patch.agents !== undefined) {
    if (!Array.isArray(patch.agents) || !patch.agents.length)
      throw store.err(store.ERR.BAD_INPUT, "agents 必须是非空数组");
    const single = ROLES.includes(line);
    if (patch.agents.length > (single ? 1 : MAX_PARALLEL))
      throw store.err(store.ERR.BAD_INPUT,
                      single ? `${line} 职务单线 —— 只能单槽`
                             : `并行上限 ${MAX_PARALLEL}(全线共享额度)`);
    // ⭐ CAS: agents[] can ONLY be written compare-and-swap. The panel does
    //   read-modify-write and the board is touched from more than one screen —
    //   without rev, last-write-wins silently reverts someone's fix and nobody sees
    //   it until the next start. ⚠ Compare and write complete INSIDE this
    //   synchronous block (an await between them un-CASes the CAS).
    //   · rev mismatch = CONFLICT (409): re-read and the same edit passes.
    //   · rev missing  = BAD_INPUT (400): the body is wrong, forever.
    const curRev = Number(cur.rev || 0);
    if (patch.rev === undefined)
      throw store.err(store.ERR.BAD_INPUT,
        `保存必须带 rev(当前 ${curRev})—— 先读取再提交,避免两处面板互相覆盖`);
    if (Number(patch.rev) !== curRev)
      throw store.err(store.ERR.CONFLICT,
        `设置已被他处改动(你基于 rev ${patch.rev},现在是 ${curRev})—— 重新读取后再保存`);
    next.agents = patch.agents.map((a, i) => {
      const rt = seatOf(a?.runtime);
      if (!rt) throw store.err(store.ERR.BAD_INPUT, `智能体 ${i + 1}：未知运行时 ${a?.runtime}`);
      const profile=profileOf(a);
      if(profile&&ROLES.includes(line))throw store.err(store.ERR.BAD_INPUT,"执行配置适用于普通任务执行线；自动审阅职务保持原入口");
      // ⚠ A locked seat refuses with BAD_INPUT: unlocking is a separate human act;
      //   resending later does not pass ⇒ the caller may give up (4xx, not 409).
      if (rt.disabled && profile?.auth_kind!=="api_key") throw store.err(store.ERR.BAD_INPUT,
        `智能体 ${i + 1}：${rt.label} —— 未获解禁(${rt.release_env} 闸),保存拒绝`);
      // ⭐ Models AND rungs are judged by the SEAT's declaration (judging by the
      //   global tables would let a codex slot save a claude model and die with a
      //   400 only at start).
      if (!(rt.models || []).some((m) => m.id === a?.model))
        throw store.err(store.ERR.BAD_INPUT, `智能体 ${i + 1}：${rt.label} 没有模型 ${a?.model}`);
      const dom = effortsFor(a?.runtime, a?.model);
      if (!dom.includes(a?.effort))
        throw store.err(store.ERR.BAD_INPUT,
          `智能体 ${i + 1}：${a?.model} 的强度必须是 ${dom.join("/")}(座席宣言值域)`);
      return { runtime: a.runtime || RUNTIME_IDS[0], model: a.model, effort: a.effort, window: !!a.window,
        ...(profile?{execution_profile_id:profile.id}:{}) };
    });
    next.rev = curRev + 1;
  }
  settings[line] = next;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
  emit("worker.changed", { line });
  return next;
}

/** "Wanted running" is a SETTING, not the presence of a process. Without it, every
 *  dev restart silently halts the processing chain (measured twice). */
function setDesired(line, on) {
  settings[line] = { ...settingsOf(line), desired_running: !!on };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
}

/**
 * Write down WHY a line stopped. The initiator calls this BEFORE the tree kill; the
 * exit handler only fills in unexplained exits. `last_stop` survives a board restart
 * (that is the only way "stopped with the board" can still be told afterwards), while
 * the per-slot copy keeps parallel slots from being judged separately by exit code
 * during one stop of the line.
 * Unknown values throw: a reason nobody defined must not reach the ledger.
 */
function recordStop(line, reason, targets = []) {
  if (!STOP_REASON_SET.has(reason)) throw new Error(`未知 stop_reason: ${reason}`);
  const event = { reason, at: new Date().toISOString() };
  for (const w of targets) w.stopReason = event;
  settings[line] = { ...settingsOf(line), last_stop: event };
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8"); }
  catch (e) { console.error(`${line} stop_reason 无法持久化:`, e.message); }
  return event;
}

/** A stored reason is only usable if BOTH parts survive — an unparseable timestamp or
 *  an unknown reason reads as "no reason", never as a guess. */
const validStop = (v) => v && STOP_REASON_SET.has(v.reason) && Number.isFinite(Date.parse(v.at || ""))
  ? { reason: v.reason, at: new Date(Date.parse(v.at)).toISOString() } : null;

/** The one place a reason becomes words. The panel renders this string and maps
 *  nothing itself — two mapping tables would drift.
 *  只写状态与时刻(docs/style-guide.md「不写注释性语句」),不带括号补充;退出码在同一条记录的 exit_code 字段。 */
function stopText(stop, exitCode) {
  const s = validStop(stop);
  if (!s) return exitCode === REFUSED_EXIT ? "启动被拒绝" : (exitCode == null ? "" : "已停止");
  const at = s.at.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
  if (s.reason === STOP_REASON.BY_USER) return `用户停止 · ${at}`;
  if (s.reason === STOP_REASON.WITH_BOARD) return `随看板停止 · ${at}`;
  if (s.reason === STOP_REASON.EXIT_NORMAL) return `正常结束 · ${at}`;
  return `崩溃 · ${at}`;
}

const loopScriptOf = (line) =>
  line === "review" ? join(LOOPS_DIR, "reviewer_loop.py")
  : join(LOOPS_DIR, "worker_loop.py");

function workerStart(line, route = store.DEFAULT_ROUTE, agentsOverride = null) {
  // ⭐ An EXPIRED window refuses new starts. Measured before this check: with
  //   BOARD_UNTIL in the past, start returned 200 and the slot came up with NO
  //   --until at all — the operator's deadline, once passed, silently became "no
  //   deadline ever". The crash-restart path already checked expiry; a guard on
  //   one entry point is not a guard (INCIDENT-11's shape, again).
  if (BOARD_UNTIL_AT && Date.now() >= BOARD_UNTIL_AT)
    throw store.err(store.ERR.CONFLICT,
      `看板窗已过(BOARD_UNTIL=${localIso(BOARD_UNTIL_AT)})—— 不再起新线。` +
      `要继续:换个 BOARD_UNTIL 重启看板,或不设截止`);
  if (LINE_EXTERNAL?.[line])
    throw store.err(store.ERR.CONFLICT, `${line} 是外部执行线:由持执行者令牌的外部执行者领卡,看板不启动进程`);
  everStarted.add(line);          // this boot has acted on the line (see NO_REVIVE)
  const st = settingsOf(line);
  const isReview = line === "review";
  // The loop script must exist (an incomplete install can lack loops/). Spawning a
  // missing file exits 2 and CLIMBS THE CRASH LADDER — refuse by name instead.
  const script = loopScriptOf(line);
  if (!existsSync(script))
    throw store.err(store.ERR.INTERNAL,
      `${line}: loop 脚本缺失(${script})—— loops/ 组件未安装,无从启动`);
  // Parallel applies to worker lines only (roles are single-seat). Settings are
  // read at start — changing them mid-run does not add/remove slots ("stop then
  // start to apply" is the standing contract).
  const agents = agentsOverride || effectiveAgents(line, st);
  if (!agents) throw store.err(store.ERR.CONFLICT,
    `${line} 当前没有可执行座席(池失效或该线无对应 runtime 分支)—— 保留运行意图,等待池复查`);
  const want = agents.length;
  const missing = [];
  for (let k = 1; k <= want; k++) if (!workers.get(slotKey(line, k))?.proc) missing.push(k);
  // Start/stop refusals are CONFLICT: the request is right; today's BOARD says no —
  // the same request passes once the board changes.
  if (!missing.length) throw store.err(store.ERR.CONFLICT, `${line} 已经在跑了(${want} 槽全在)`);
  // The unattended-night deadline. ⭐ Passed down as an ABSOLUTE local timestamp.
  //   ⚠ Prior art: the ISO was GENERATED above while an old HH:MM regex FILTERED it
  //   here → args=[] → the deadline silently dropped, and 253 self-tests stayed
  //   green because none of them read the child's argv. Lesson: fix the producer,
  //   then COUNT THE CONSUMERS. Now the only check is "is there a resolved
  //   absolute deadline"; no regex remains.
  const untilArgs = (BOARD_UNTIL_AT && Date.now() < BOARD_UNTIL_AT)
    ? ["--until", localIso(BOARD_UNTIL_AT)] : [];
  // Seat prerequisites are checked AT THE START REQUEST, by name (a missing CLI
  // path would exit 2 and climb the ladder loudly-but-illegibly). ⚠ The worker-side
  // gate STAYS — start roads that bypass this function (manual runs, tests) must
  // hit the same criterion; that duplication IS the defense.
  for (const k of missing) {
    const ag0 = agents[k - 1];
    const seat = seatOf(ag0.runtime);
    const profile=profileOf(ag0);
    if(profile){const fact=profileFacts().find(p=>p.id===profile.id);if(!fact?.ready)throw store.err(store.ERR.CONFLICT,fact?.reason||"执行配置尚未就绪");}
    if (profile?.auth_kind!=="api_key" && seat?.cmd_env && !process.env[seat.cmd_env])
      throw store.err(store.ERR.BAD_INPUT,
        `智能体 ${k} 使用 ${seat.id} 座席，但宿主没有配置 ${seat.cmd_env}（必须是绝对路径）—— 拒绝启动`);
    // window=true opens a cmd.exe console — a Windows-only affordance. On POSIX it
    // would spawn a literal "cmd" (ENOENT) and, pre-error-handler, took the board
    // down with it. Refuse by name instead of failing mysteriously.
    if (ag0.window && process.platform !== "win32")
      throw store.err(store.ERR.BAD_INPUT,
        `智能体 ${k} 配置了 window=true（打开控制台窗口），此功能仅适用于 Windows —— 拒绝启动`);
  }
  for (const k of missing) startSlot(line, k, route, agents[k - 1], untilArgs, isReview);
  setDesired(line, true);
  return workerInfo(line);
}

/** The environment the child ACTUALLY receives. ⭐ THE single assembly point — the
 *  runtime probe calls the same function. A probe assembling its own env copy
 *  cannot detect "passes on the desktop, dies under server start" (it would be
 *  measuring the room next door). */
function slotEnv(line, k, ag, isReview) {
  const profile=profileOf(ag),lg=profile?null:lineageOf(line);
  const environment={ ...process.env, PYTHONIOENCODING: "utf-8",WORKER_NODE:process.execPath,
           // ⭐ Tell the child WHERE THIS BOARD IS. A child must never guess its
           //   parent's address: the loop's BOARD_URL default is the standard port, so
           //   a board on any other port used to spawn workers that talked to whatever
           //   was listening on the default one. Measured during extraction: a smoke
           //   board on a spare port spawned a slot that went knocking on the machine's
           //   REAL board (refused only because the data dir's token did not match).
           //   The port is known here; passing it removes the guess.
           BOARD_URL: `http://127.0.0.1:${PORT}`,
           // Same principle for the gate env and the work repo: the server KNOWS
           // the resolved values — pass them so a supervised child never depends
           // on the shell it happened to inherit (a second shell missing
           // BOARD_GATED_SUBTREE was a measured cold-walkthrough trap).
           ...(CFG_GATED_SUBTREE ? { BOARD_GATED_SUBTREE: CFG_GATED_SUBTREE } : {}),
           BOARD_REPO: REPO_ROOT,
           // 仅宿主配置显式启用；旧部署与审阅循环始终保持关闭。
           WORKER_HOST_COMMIT: !isReview && CFG.host_auto_commit === true ? "1" : "0",
           // 宿主提交用的 Git 程序与 commit 上限:环境变量已设者优先(随上面的 ...process.env 下传),否则取配置。
           ...(!process.env.WORKER_HOST_GIT && CFG.host_git ? { WORKER_HOST_GIT: String(CFG.host_git) } : {}),
           ...(!process.env.WORKER_HOST_COMMIT_TIMEOUT_SEC && CFG.host_commit_timeout_sec != null
             ? { WORKER_HOST_COMMIT_TIMEOUT_SEC: String(CFG.host_commit_timeout_sec) } : {}),
           WORKER_PROTECTED_PATHS:JSON.stringify([store.DATA_DIR,CONFIG_FILE,
             process.env.BOARD_VERIFY_REGISTRY||join(CODE_ROOT,"core","verify_registry.json"),
             ...EXECUTION_PROFILES.map(p=>p.auth_home),process.env.BOARD_FLEET_ACTIONS_CONFIG,
             process.env.BOARD_PROGRESS_CONFIG].filter(Boolean).map(p=>resolve(p))),
           // 全部执行配置的认证目录（旧线、审阅线与显式配置都下传）：Claude CLI 座席据此为每个目录生成
           // Read／Edit 拒绝规则。不用 WORKER_PROTECTED_PATHS：那份含整个数据目录，整目录拒绝会连证据写入一起挡掉。
           WORKER_AUTH_HOMES:JSON.stringify(EXECUTION_PROFILES.map(p=>resolve(p.auth_home))),
           WORKER_MODEL: ag.model, WORKER_EFFORT: ag.effort,
           WORKER_RUNTIME: ag.runtime || RUNTIME_IDS[0],
           REVIEWER_MODEL: ag.model, REVIEWER_EFFORT: ag.effort,
           // ⭐ v0.22: the line's identity, handed down the same way as the seat — the loop
           //   never reads fleet.config for it (one reader of the config, not two). Absent
           //   keys = the loop's own defaults (implement / write / no charter), so a plain
           //   line is exactly what it was before this version.
           ...(!isReview && LINE_ROLE?.[line] ? {
             WORKER_ROLE_KIND: LINE_ROLE[line].kind,
             WORKER_TOOL_PROFILE: LINE_ROLE[line].tools,
             ...(LINE_ROLE[line].charter ? { WORKER_CHARTER: LINE_ROLE[line].charter } : {}),
           } : {}),
           // v0.23: the reviewer is told the policy so its startup line can say it; the
           // criterion itself lives in the server (/api/review/pending decides what is held).
           ...(isReview && REVIEW_ANTI_AFFINITY ? { REVIEWER_ANTI_AFFINITY: REVIEW_ANTI_AFFINITY } : {}),
           ...(isReview ? {} : k === 1 ? {
             WORKER_SESSION: sessionOf(line),
             // Not yet forked → the first run forks from the desktop conversation.
             // 只在本槽的运行时与会话来源一致时下传(Claude 会话交给 Codex 进程 fork 不了)。
             ...(lg && !lg.forked && (lg.source || "claude") === (ag.runtime || RUNTIME_IDS[0]) ? { WORKER_FORK_FROM: lg.session } : {}),
             // 已 fork 过:Codex 线据此续接自己的会话(Claude 线看转录在不在,不需要这个)
             ...(lg && lg.forked ? { WORKER_LINEAGE_FORKED: "1" } : {}),
             ...(lg?.anchor ? { WORKER_ANCHOR: lg.anchor } : {}),
           } : {
             // Extra slots (2+) run a FRESH session per card. The persistent
             // session is slot 1's private property — two processes resuming the
             // same session corrupt the transcript. Only the anchor is passed.
             ...(lg ? { WORKER_ANCHOR: lg.anchor } : {}),
           }) };
  if(profile){delete environment.WORKER_SESSION;delete environment.WORKER_FORK_FROM;delete environment.WORKER_ANCHOR;}
  const result=profileEnvironment(profile,{env:environment,repoRoot:REPO_ROOT,dataDir:store.DATA_DIR,profiles:EXECUTION_PROFILES});
  if(profile)result.WORKER_EXECUTION_PROFILE=JSON.stringify(profileForAgent(ag,line));
  return result;
}

function startSlot(line, k, route, ag, untilArgs, isReview) {
  const key = slotKey(line, k);
  const args = isReview
    ? [loopScriptOf(line), "--interval", "300", ...untilArgs]
    : [loopScriptOf(line), "--as", line,
       ...(k > 1 ? ["--worker", key] : []),
       "--route", route, "--interval", "60", ...untilArgs];
  const env = slotEnv(line, k, ag, isReview);
  // A spawned seat has an identity-bound credential, never a shared runtime assertion.
  const workerToken = isReview ? null : randomUUID().replace(/-/g, "");
  env.WORKER_BOARD_TOKEN = workerToken || "";
  // ⭐ The KEY NAMES of the WORKER_*/REVIEWER_* env the child actually receives
  //   (values withheld — WORKER_SESSION is a real conversation id and slot tails go
  //   out over HTTP). Without this, "slot 2 gets no WORKER_SESSION" never appears
  //   in argv and becomes an unobservable property — and unobservable contracts get
  //   silently deleted by the next rewrite.
  // ⚠ Read from `env` ITSELF, not the assembled diff: a WORKER_SESSION inherited
  //   from the parent process is the same one to the child — listing only the diff
  //   would make "not passed" a lie.
  const envKeys = Object.keys(env).filter((n) => /^(WORKER|REVIEWER|REORG)_/.test(n)).sort();
  // Test hook: BOARD_SPAWN_ECHO=1 skips the spawn and logs the assembled argv.
  //   The deadline bug (producer/filter divergence) is detectable only by reading
  //   what actually reaches the child — the harness reads this echo and asserts
  //   --until/--worker existence (deleting them turns it red = detection ability).
  if (process.env.BOARD_SPAWN_ECHO) {
    // Slot config echoed too — "did each slot really get its own model/effort" is
    // only assertable from here (env does not show in argv).
    workers.set(key, { line, slot: k, echo: true, proc: null, startedAt: Date.now(), route,
                       settings: ag, workerToken, log: ["[spawn-echo] " + JSON.stringify([PY, ...args]) +
                                           " [slot-cfg] " + JSON.stringify({ slot: k, ...ag }) +
                                           " [slot-env] " + JSON.stringify(envKeys)] });
    emit("worker.changed", { line, running: false });
    return;
  }
  // window=true opens a real console (when the human wants to watch). stdout then
  // does not flow here, so the panel's log tail stays empty.
  // ⭐ On POSIX the child gets ITS OWN PROCESS GROUP (detached). Without it, the
  //   stop path's kill(-pid) targets a group that does not exist and ALWAYS throws
  //   ESRCH — the POSIX tree-kill had plausibly never worked, and CI stayed green
  //   only because the test stubs are single processes. Windows keeps the default:
  //   the tree is walked by taskkill /T, no group needed.
  const proc = ag.window
    ? spawn("cmd", ["/c", "start", `worker:${key}`, "cmd", "/k", PY, ...args],
            { cwd: __dirname, env, windowsVerbatimArguments: false })
    : spawn(PY, args, { cwd: __dirname, env, detached: process.platform !== "win32" });
  const w = { line, slot: k, proc, startedAt: Date.now(), route, log: [], settings: ag, workerToken, detached: ag.window };
  // ⚠ Without this handler a spawn failure (interpreter missing, ENOENT) is an
  //   unhandled 'error' event and KILLS THE WHOLE BOARD — the supervisor dying of
  //   one child's absence. Record it like any other unexplained stop.
  proc.on("error", (e) => {
    w.workerToken = null;
    w.log.push(`[spawn 失败: ${e.message}]`);
    if (w.proc) { w.proc = null; w.exitedAt = Date.now(); w.exitCode = -1; }
    if (!validStop(w.stopReason)) recordStop(line, STOP_REASON.CRASH, [w]);
    console.error(`${key} spawn 失败:`, e.message);
    emit("worker.changed", { line, running: false });
  });
  const push = (b) => {
    for (const ln of String(b).split(/\r?\n/)) if (ln.trim()) w.log.push(ln.trim());
    if (w.log.length > 60) w.log.splice(0, w.log.length - 60);
    emit("worker.log", { line });
  };
  proc.stdout.on("data", push);
  proc.stderr.on("data", push);
  proc.on("exit", (code) => {
    // A window launcher may exit while its console loop continues; stop/restart still revokes.
    if (!w.detached || code !== 0) w.workerToken = null;
    w.log.push(`[进程退出 code=${code}]`);
    w.proc = null; w.exitedAt = Date.now(); w.exitCode = code;
    // If the initiator already put a reason down, the OS's code=1 must not overwrite it
    // with "crash". Only an unexplained exit is classified here; refusals keep their
    // own road below and are deliberately left without a recorded reason.
    let stop = validStop(w.stopReason);
    if (!stop && code !== REFUSED_EXIT)
      stop = recordStop(line, code === 0 ? STOP_REASON.EXIT_NORMAL : STOP_REASON.CRASH, [w]);
    // A loop dying does not kill the model CLI it spawned — an orphaned model keeps
    // writing files with nobody reading its output. Sweep the tree, return the cards.
    if (process.platform === "win32")
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
    else try { process.kill(-proc.pid, "SIGKILL"); } catch {}   // group kill; gone already = fine
    try {
      // ⭐ Reclaim by the SLOT's worker name — reclaiming by line name would return
      //   OTHER slots' in-flight cards too.
      const freed = store.releaseHeldBy(db, key);
      if (freed.length) {
        w.log.push(`[在途 ${freed.join(",")} 回收至未开始]`);
        emit("task.reaped", { count: freed.length });
      }
    } catch (e) { console.error(`${key} 退出后的返还失败:`, e.message); }

    // ⭐ A GATE REFUSAL is not a crash — no backoff, no restart. Refusal criteria
    //   are deterministic (dirty tree / unaccepted revision / unknown runtime /
    //   missing CLI...): the same environment dies at the same spot every time.
    //   Standing still until a human fixes it IS correct. ⛔ The gate itself is
    //   never loosened — only the aftermath was wrong.
    //   ⭐ Intent (desired_running) drops too: kept, the panel shows a line that
    //   "wants to run but won't", and people press start repeatedly without
    //   reading the reason.
    if (code === REFUSED_EXIT) {
      setDesired(line, false);
      resetLadder(line);
      w.log.push("[⛔ 门拒绝启动(exit 3)—— **不自动重启**。" +
                 "修好上方给出的理由后再按『启动』(梯子已复位)]");
      console.log(`${key} 拒绝启动(exit ${code})—— 不自动重启;理由见 log 尾`);
      emit("worker.changed", { line, running: false });
      return;
    }

    // ⭐ A crash (exit≠0) auto-restarts with backoff. Measured: one uncaught
    //   exception silently stopped two lines for 5.5 hours — desired_running was
    //   true and nobody restarted them.
    //   · exit 0 (deadline / --once) does not restart · human stops don't either
    //   · past the deadline: no · surplus slots after shrinking parallel: no
    //   · backoff 30s → 1m → 2m → 4m → 8m → cap 15m; a run alive >10min resets.
    const stillWanted = () => {
      const cur = settingsOf(line);
      const eff = effectiveAgents(line, cur);
      return cur.desired_running && !!eff && k <= eff.length;
    };
    // ⭐ The criterion is the RECORDED REASON, not the exit code. Measured on this
    //   port before the change: a pool failover stops the line with the intent kept,
    //   the tree kill returns non-zero, and the line was booked as a crash — the ladder
    //   climbed on an orderly, intentional stop.
    if(ag.execution_profile_id){
      setDesired(line,false);resetLadder(line);
      w.log.push("[独立执行配置已停线；本轮未回报结果须本人核对，不自动重启或重新收费]");
      emit("worker.changed",{line,running:false});return;
    }
    if (stop?.reason === STOP_REASON.CRASH && stillWanted() && !shuttingDown &&
        !(BOARD_UNTIL_AT && Date.now() >= BOARD_UNTIL_AT)) {
      const lived = Date.now() - w.startedAt;
      // ⭐ The rung is FIXED HERE, in the ledger, at crash time (independent of
      //   restart success or of who restarts).
      const n = (lived > 600_000 ? 0 : (crashLadder.get(key) || 0)) + 1;
      crashLadder.set(key, n);
      const delay = Math.min(900_000, CRASH_BACKOFF_MS * 2 ** (n - 1));
      w.log.push(`[判定为 crash —— ${Math.round(delay / 1000)} 秒后第 ${n} 次自动重启]`);
      console.log(`${key} crash(code=${code})—— ${Math.round(delay / 1000)}s 后第 ${n} 次自动重启`);
      setTimeout(() => {
        if (!stillWanted() || workers.get(key)?.proc || shuttingDown) return;
        if (BOARD_UNTIL_AT && Date.now() >= BOARD_UNTIL_AT) return;
        try {
          workerStart(line, w.route);       // rebuild only the missing slots (idempotent — keep this property)
          // ⛔ Do not write the count here: the early return above (another slot's
          //   timer already rebuilt this one) can skip this line, creating "a slot
          //   nobody counts for". The log is the witness of an ACTUAL rebuild.
          workers.get(key)?.log.push(`[自动重启(第 ${n} 次)]`);
        } catch (e) { console.error(`${key} 自动重启失败:`, e.message); }
      }, delay).unref?.();
    }
    emit("worker.changed", { line, running: false });
  });
  workers.set(key, w);
  emit("worker.changed", { line, running: true });
}

async function workerStop(line, { keepIntent = false,
                                  reason = keepIntent ? STOP_REASON.WITH_BOARD : STOP_REASON.BY_USER } = {}) {
  if (!keepIntent) setDesired(line, false);   // a human stop stays stopped across restarts
  const lineSlots = slotsOf(line);
  const slots = lineSlots.filter((w) => w.proc || w.echo);
  for (const w of lineSlots) w.workerToken = null; // revoke before asynchronous tree kill
  // ⭐ Booked BEFORE the tree kill — this ORDER is the mechanism, not a preference: a
  //   kill returns non-zero, and whoever reads the code afterwards would call it a
  //   crash. Written across the line's whole slot set, so a line that was backing off
  //   from an earlier crash does not keep showing that crash after being stopped.
  const stop = recordStop(line, reason, lineSlots);
  if (!slots.length) {
    // ⭐ This used to THROW 409 — but setDesired had already run, so the screen said
    //   "operation failed" while the stop had actually taken effect = a lie people
    //   kept re-pressing (measured: "I can't stop it" — every stop had worked and
    //   every one reported failure). ⭐⭐ Worse, the throw skipped the tail of this
    //   function: resetLadder never ran (stopping a crash-backing line kept its
    //   ladder) and releaseHeldBy never ran (a dead slot's in-flight cards stayed
    //   attached to a stopped line). Stop is a request for a STATE; already there =
    //   success. Idempotent.
    resetLadder(line);
    const idle = [];
    for (let k = 1; k <= MAX_PARALLEL; k++) idle.push(...store.releaseHeldBy(db, slotKey(line, k)));
    if (idle.length) {
      console.log(`${line} 停止(进程本就不在): 在途 ${idle.join(",")} 已回收至未开始`);
      emit("task.reaped", { count: idle.length });
    }
    emit("worker.changed", { line, running: false });
    return { line, stopping: false, already_idle: true, intent_cleared: !keepIntent,
             tree_killed: 0, released: idle,
             stop_reason: stop, stop_text: stopText(stop, null),
             note: keepIntent ? "进程本就不在(内部调用·重启意图保留)"
                              : "进程本就不在 —— 自动重启的意图已清除,不会再起来" };
  }
  // ⭐ proc.kill() kills ONE process. The model CLI under the loop survives losing
  //   its parent and keeps editing files (measured). "Stop" that does not stop is a
  //   lie, so the whole TREE goes down.
  // ⭐⭐ Order matters: firing taskkill and immediately proc.kill() lets the parent
  //   die before taskkill walks the tree — grandchildren re-parent and escape /T
  //   (measured: 3/3 orphans that way, 0/3 when awaited). An orphan = an unattended
  //   model rewriting the repo. "Actually dead" outranks "fast".
  let treeKilled = 0;
  for (const w of slots) {
    if (!w.proc) { workers.delete(slotKey(line, w.slot)); continue; }   // spawn-echo leftovers
    const pid = w.proc.pid;
    try {
      if (process.platform === "win32") {
        await new Promise((r) => {
          const t = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
          t.on("exit", r); t.on("error", r);
          setTimeout(r, 8000);        // do not wait forever for taskkill either
        });
        treeKilled++;
      } else { process.kill(-pid, "SIGKILL"); treeKilled++; }
    } catch (e) { console.error(`树杀失败(${slotKey(line, w.slot)} pid=${pid}):`, e.message); }
    try { if (w.proc && !w.proc.killed) w.proc.kill(); } catch {}
  }
  // We know we killed them — no reason to wait 30 minutes for leases. ⭐ Reclaim
  // under EVERY slot name up to the cap: leases of old slots left over after
  // shrinking parallel get swept here too.
  const freed = [];
  resetLadder(line);                    // human stop ⇒ next start begins at the base
  for (let k = 1; k <= MAX_PARALLEL; k++) freed.push(...store.releaseHeldBy(db, slotKey(line, k)));
  if (freed.length) { console.log(`${line} 停止: 在途 ${freed.join(",")} 已回收至未开始`); emit("task.reaped", { count: freed.length }); }
  return { line, stopping: true, tree_killed: treeKilled, released: freed,
           stop_reason: stop, stop_text: stopText(stop, null) };
}

async function probePool(runtime) {
  // Result injection only under explicit test mode; production always makes the
  // minimal real call.
  if (process.env.BOARD_POOL_TEST_MODE === "1" && process.env.BOARD_POOL_TEST_PROBE)
    return { ok: process.env.BOARD_POOL_TEST_PROBE === "ok", detail: "injected-test-probe" };
  const loop = join(LOOPS_DIR, "worker_loop.py");
  if (!existsSync(loop))
    return { ok: false, code: -1, detail: "loops/worker_loop.py 未安装 —— 无法探测池" };
  const ag = runtime === RUNTIME_IDS[0] ? DEFAULT_AGENT
    : (failoverAgent(DEFAULT_AGENT, runtime) || DEFAULT_AGENT);
  const args = [loop, "--probe-runtime", "--live", "--as", LINES[0]];
  return await new Promise((resolve) => {
    execFile(PY, args, { env: slotEnv(LINES[0], 1, ag, false), cwd: __dirname,
                         encoding: "utf8", timeout: 660_000, maxBuffer: 4 << 20 },
      (e, so, se) => resolve({ ok: !e, code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
                               detail: ((so || "") + (se || "")).slice(-1200) }));
  });
}

let poolReconciling = null;
function schedulePoolReconcile(reason) {
  setTimeout(() => { void reconcilePools(reason); }, 0).unref?.();
}
async function reconcilePools(reason = "timer") {
  if (poolReconciling) return poolReconciling;
  poolReconciling = (async () => {
    const now = Date.now();
    // ⭐ Snapshot what a pass can change. The pass used to emit pool.changed
    //   UNCONDITIONALLY at its end — on the timer that is one broadcast every
    //   reconcile tick with nothing changed, and the SSE sentry prints a line
    //   per event (a deployment filed it: "pool.changed every 5 seconds drowns
    //   the sentry"). "changed" now means changed: pools or live slots differ
    //   from the snapshot, or the pass was explicitly requested (non-timer).
    const poolSnap = () => JSON.stringify({ pools: poolState,
      live: [...workers.entries()].filter(([, w]) => w.proc || w.echo).map(([k]) => k).sort() });
    const before = poolSnap();
    // `until` is not "assume fine after this" — it is the time of the next MINIMAL
    // PROBE. Success unlocks; failure pushes to the next hold window.
    for (const p of POOL_IDS) {
      if (!poolDown(p) || Date.parse(poolState[p].until) > now) continue;
      const pr = await probePool(p);
      if (pr.ok) { clearPool(p); console.log(`池复查 ${p}: 成功 → 解禁`); }
      else { markPoolDown(p, Date.now()); console.error(`池复查 ${p}: 失败 → 下个冷却窗再查: ${redact(pr.detail)}`); }
    }
    updateGlobalStopMarker(reason);

    for (const line of SUPERVISED) {
      const st = settingsOf(line);
      if (!st.desired_running) continue;
      const plan = effectiveAgents(line, st);
      const active = slotsOf(line).filter((w) => w.proc || w.echo);
      const same = !!plan && active.length === plan.length && active.every((w, i) => {
        const a = plan[i], b = w.settings || {};
        return ["runtime", "model", "effort", "window"].every((k) => (a[k] ?? DEFAULT_AGENT[k]) === (b[k] ?? DEFAULT_AGENT[k]));
      });
      if (same) continue;
      // ⭐ A maintenance boot (BOARD_NO_RESTORE) must not be undone from here. The boot
      //   path skips reviving last night's intent — but this reconciler runs on a timer
      //   and would start the very same lines seconds later, because "wants to run and
      //   has no slots" is exactly what it exists to fix. Measured: a board booted with
      //   the flag printed "reviving nothing" and then started the line 5s later.
      //   ⚠ The condition is NOT the flag alone: once a line has been started in THIS
      //   process (a human pressed start, or a normal boot restored it), the reconciler
      //   must still be able to bring it back after a seat swap. What the flag forbids
      //   is reviving intent that predates this boot.
      if (!active.length && NO_REVIVE && !everStarted.has(line)) {
        if (!noReviveSaid.has(line)) {
          noReviveSaid.add(line);
          console.log(`池调度: ${line} 想跑但本次是维护重启(BOARD_NO_RESTORE)—— 不代替人把它拉起来`);
        }
        continue;
      }
      const route = active[0]?.route || store.DEFAULT_ROUTE;
      if (active.length) {
        // A seat swap is an orderly stop, not a crash — say so, or the tree kill's
        // non-zero code books a crash and the backoff ladder climbs on a healthy line.
        try { await workerStop(line, { keepIntent: true, reason: STOP_REASON.WITH_BOARD }); }
        catch (e) { console.error(`池调度停止 ${line} 失败:`, e.message); continue; }
        const deadline = Date.now() + 10_000;
        while (slotsOf(line).some((w) => w.proc) && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 50));
      }
      if (!plan) {
        console.log(`池调度: ${line} 停止(无可执行座席;运行意图保留)`);
        continue;
      }
      try {
        workerStart(line, route, plan);
        console.log(`池调度: ${line} → ${plan.map((a) => a.runtime).join("/")}`);
      } catch (e) { console.error(`池调度启动 ${line} 失败:`, e.message); }
    }
    if (reason !== "timer" || poolSnap() !== before)
      emit("pool.changed", { reason, pools: poolState, global_stop: bothPoolsDown() });
  })().catch((e) => { console.error("池巡检失败:", e.message); })   // ⭐ v0.19: a throw here used to be an unhandled rejection = the board dies of its own timer
    .finally(() => { poolReconciling = null; });
  return poolReconciling;
}

function workerInfo(line) {
  const st = settingsOf(line);
  // `last_stop` is stripped here too: it is a PERSISTENCE key, not a settings key.
  // Left in, it would ride out inside `settings` alongside the structured
  // stop_reason below — two copies of the same fact, one of them stale.
  const { session_id, forked_from, last_stop, ...safeSet } = st;   // withheld from the wire
  const slots = slotsOf(line);
  const w = workers.get(line);                          // slot 1 (compatibility lead)
  const lg = LINEAGE[line];
  const runningSlots = slots.filter((s2) => s2.proc);
  // "Running on stale settings" is stated from the REAL DIFF (it used to display
  // whenever running, sticking after stop→start = a false alarm). Compared: the
  // settings snapshotted at start vs saved settings, process-relevant keys only;
  // a parallel-count mismatch counts as stale too.
  const KEYS = ["model", "effort", "window", "runtime", "execution_profile_id"];
  const eff = effectiveAgents(line, st);
  const wantNow = eff?.length || 0;
  // Staleness compares SLOT AGAINST SLOT (changing only slot 2's model is caught).
  const stale = runningSlots.some((s2) => {
      const curAg = eff?.[(s2.slot || 1) - 1];
      return !curAg || KEYS.some((k2) => (s2.settings?.[k2] ?? DEFAULT_AGENT[k2]) !== (curAg[k2] ?? DEFAULT_AGENT[k2]));
    }) || (runningSlots.length > 0 && runningSlots.length !== wantNow);
  const mainStop = w ? validStop(w.stopReason) : validStop(last_stop);
  return {
    line, running: runningSlots.length > 0, pid: w?.proc?.pid ?? null,
    desired_running: !!st.desired_running,
    started_at: w?.startedAt ?? null, route: w?.route ?? store.DEFAULT_ROUTE,
    // ⚠ session_id / forked_from are REAL conversation ids; the panel never used
    //   them (grep = 0), so they are not returned. What is worth returning is the
    //   boolean "inherited or not".
    settings: safeSet, has_session: !!st.session_id, detached: !!w?.detached,
    pool_blocked: !eff, pool_failover: runningSlots.some((s2) =>
      (s2.settings?.runtime || RUNTIME_IDS[0]) !== (st.agents[(s2.slot || 1) - 1]?.runtime || RUNTIME_IDS[0])),
    stale_settings: stale,
    // v0.22: the identity (null for a plain line) and whether agents[0] left its seat.
    role: LINE_ROLE?.[line] || null, seat_drift: seatDrift(line, st), external: !!LINE_EXTERNAL?.[line],
    // ⭐ While a container for this run exists, only ITS reason counts; the persisted
    //   last_stop is read only when there is no container (after a board restart —
    //   which is the case "stopped with the board" exists to survive). Reading the
    //   persisted one too eagerly makes a start REFUSAL display the previous user stop.
    stop_reason: mainStop, stop_text: stopText(mainStop, w?.exitCode ?? null),
    slots: slots.map((s2) => {
      const slotStop = validStop(s2.stopReason);
      return { slot: s2.slot, worker: slotKey(line, s2.slot),
        running: !!s2.proc, pid: s2.proc?.pid ?? null, started_at: s2.startedAt,
        exit_code: s2.proc ? null : (s2.exitCode ?? null),
        runtime: s2.settings?.runtime || RUNTIME_IDS[0],
        stop_reason: slotStop, stop_text: stopText(slotStop, s2.exitCode ?? null),
        tail: s2.log?.length ? s2.log[s2.log.length - 1] : "" };
    }),
    lineage: lg ? { configured: true, forked: !!st.forked_from, anchor: lg.anchor,
                    forked_at: st.forked_at || null } : null,
    exit_code: w?.proc ? null : (w?.exitCode ?? null),
    last_log: w?.log?.slice(-6) ?? [],
  };
}

// ── SSE: push on change only. Countdown/heartbeat freshness is computed client-
//    side; no per-second broadcasting.
const clients = new Set();
// SSE clients that declared themselves sentries (watchers/sse_watch.py), each
// with the code revision IT is running — a sentry that reconnected after an
// upgrade is still executing the old file, and that is invisible without asking.
// A subset of `clients`; emit() still broadcasts to everyone.
const sentries = new Map();   // res -> { rev, at }
// ⚠ Receivers must NOT hand-maintain an event-type list — a type added later
//   silently stops arriving (measured: the server emitted 16 kinds, the panel
//   subscribed to 8; verdicts, lease reclaims, pins and reopens never arrived, and
//   the 15s fallback poll made it look merely "slow"). The frame is ONE kind
//   (`change`), the type rides in the data — new types arrive by construction.
//   Worker stdout is high-frequency, so it gets its own frame (`log`) for
//   receiver-side throttling.
// 每条 SSE 连接记着它建立时用的凭据(只记哈希与种类)。凭据被撤销 / 注销 / 换发 / 面板会话退出或过期后,
// dropRevokedSse() 把这条连接从服务端关掉(F3):HTTP 请求立即 401,长连接也不能继续收全板事件。
const sseAuth = new Map();   // res -> { kind:"panel"|"executor"|"static", hash }
function sseStillValid(a) {
  if (a.kind === "panel") { const v = panelSessions.get(a.hash); return !!v && panelLive(v); }
  if (a.kind === "executor") return !!db.prepare("SELECT 1 FROM coord_executors WHERE token_hash=? AND removed_at IS NULL").get(a.hash);
  return true;               // board_token / worker / review 令牌:进程内不撤销
}
function dropRevokedSse() {
  let n = 0;
  for (const [res, a] of sseAuth) if (!sseStillValid(a)) { sseAuth.delete(res); clients.delete(res); sentries.delete(res); try { res.end(); } catch {} n++; }
  return n;
}
function emit(type, data = {}) {
  const wire = String(type).endsWith(".log") ? "log" : "change";
  if (wire === "change") settleUsage();          // 卡变成 done 的每条路都经过这里
  const payload = `event: ${wire}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch {} }
  if (wire === "change") flow.notify(type, data);   // 子卡变化 → 建卡对话的进度(2 秒合并后推 conversation.changed)
}

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(s);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  // Broken JSON is the CALLER's to fix ⇒ it declares BAD_INPUT. Left as a bare
  // SyntaxError it falls to the untyped-400 fallback, and every mis-send rings the
  // [unclassified] alarm with the same face as a real gap — normalized alarms stop
  // being read.
  req.on("end", () => {
    let body;
    try { body = b ? JSON.parse(b) : {}; }
    catch { return reject(store.err(store.ERR.BAD_INPUT, "请求正文不是有效的 JSON，请检查输入格式。")); }
    // worker 在入口正规化一次:只接受字符串或数字,统一成字符串;下面的身份检查与 store 的比对、落库看的是同一个值。
    // 数组、布尔、null 经 String() 会变成合法的名字(["a"] → "a"、true → "true"),检查按原值、落库按 String() 就能冒名。
    if (body && typeof body === "object" && !Array.isArray(body) && body.worker !== undefined) {
      if (typeof body.worker !== "string" && typeof body.worker !== "number")
        return reject(store.err(store.ERR.BAD_INPUT, "worker 必须是字符串或数字"));
      body.worker = String(body.worker);
    }
    // Covers claim, report, heartbeat and derived-card writes, before state changes.
    if (req.boardRole === "worker" && body?.worker !== undefined &&
        (req.workerSeat ? body.worker !== req.workerSeat.worker : workers.get(body.worker)?.workerToken))
      return reject(store.err(store.ERR.CONFLICT, "worker identity does not match its credential"));
    // 已登记的执行者 id 只属于它自己的 exe_ 令牌:共享 worker 令牌不能把 worker 写成它。
    // 没写 worker 时也按 store 会用的名字查(String(undefined) = "undefined"),不留「没写就不查」的口子。
    if (req.boardRole === "worker" && !req.workerSeat && coord.isExecutor(db, String(body?.worker)))
      return reject(store.err(store.ERR.CONFLICT, "worker identity belongs to a registered executor"));
    // 执行者只能以自己的 id 领卡、续租、交付;不给 worker 时按令牌补上。
    if (req.boardRole === "executor" && body && typeof body === "object" && !Array.isArray(body)) {
      if (body.worker !== undefined && body.worker !== req.executor.id)
        return reject(store.err(store.ERR.CONFLICT, "执行者身份与令牌不一致"));
      // 与 worker 分支对称:id 与受管座位同名的(修复前登记的)执行者不能以座位名义领卡、续租、交付。
      if (isManagedSeatName(req.executor.id))
        return reject(store.err(store.ERR.CONFLICT, "执行者 id 与受管执行线的座位同名,不能以它领卡、续租或交付;请操作员用别的 id 重新登记"));
      body.worker = req.executor.id;
      // 正数按执行者上限截断;不是正数的当作没给(领卡用默认值,心跳只往后续)。在这里换成默认的 30 分钟的话,
      // 下游分不出「明确给了 30」和「没给」,心跳会把长租约缩短。
      if (body.lease_minutes !== undefined) {
        const n = Number(body.lease_minutes);
        body.lease_minutes = Number.isFinite(n) && n > 0 ? coord.executorLease(n) : undefined;
      }
    }
    resolve(body);
  });
  // ⚠ Transport failures (disconnects) stay untyped — they are not about the
  //   caller's request; if the fallback ever reports one, THAT is when to think.
  req.on("error", reject);
});

/**
 * The status code is decided in ONE place — and the DECLARATION rides with it.
 * ⚠ The mapping table lives in store.httpStatusFor, but every additional CALLER of
 *   the mapping is a chance to drop `typed` and silently return 400. Measured: the
 *   claim refusal (claimById returns {ok:false, code} without throwing) bypassed
 *   the catch, called the mapping directly, and unclassified errors there raised no
 *   alarm — the "silent 400" the taxonomy had eliminated, back through a non-throw
 *   road. ⛔ Never call store.httpStatusFor() directly for `.status`; go through here.
 * @param {*} e the error (or a {code, message} refusal)
 * @param {string} where attached to the report so console readers can locate the road
 */
function statusFor(e, where) {
  const { status, typed } = store.httpStatusFor(e);
  const msg = String((e && (e.message || e.why)) || e || "");
  const at = where ? ` @${where}` : "";
  // ⚠ Untyped errors fall to 400 but NOT silently — silence is how "unclassified
  //   keeps accumulating" stays invisible.
  if (!typed) console.warn(`[未分类错误] 已按 400 返回(无分类)${at}: ${msg.slice(0, 160)}`);
  // ⭐ Internal failures (5xx) always reach the console too. Typing them silences
  //   the untyped warning ⇒ without this line, classifying an error would make a
  //   visible failure QUIETER — worse than the starting point.
  if (status >= 500) console.error(`[内部失败] 已按 ${status} 返回${at}: ${msg.slice(0, 300)}`);
  return status;
}


// ───────────────────────── The local write-endpoint gate ─────────────────────
// Loopback can be forwarded. A token lives in the local data directory; browsers
// pair explicitly and carry it in headers. No anonymous response contains it.
// (An adversary who can already execute code on this machine wins regardless —
//  that is outside this threat model. The target is "pages from other origins" and
//  "random local scripts without the token".)
const TOKEN_FILE = join(store.DATA_DIR, "board_token");
// ⭐ Three tokens, three capability classes (v0.2, after a live incident: an
//   interactive agent granted the board FOLDER read board_token and self-approved
//   its own card with resolved_by:'codex'). One token was one capability —
//   "worker" and "ruler" were the same word. Now:
//     board_token  = operator, full power (explicit panel pairing, board.py, humans)
//     worker_token = the EXECUTION face only: claim / report / heartbeat /
//                    attempt / derived-card create / own-line compact / forked /
//                    pool report. A worker loop compromised through card text
//                    can no longer close or re-scope anything.
//     review_token = the RULING face of the auto-reviewer: resolve with
//                    resolved_by=auto, autoreview, pool report. It cannot claim,
//                    cannot edit, and cannot impersonate a human ruling.
//   Endpoints not on a token's list refuse (unknown falls on the refusing side).
const mintToken = (file) => {
  let t = "", present = false;
  try { t = readFileSync(file, "utf8").trim(); present = true; } catch (e) { if (e.code !== "ENOENT") present = true; }
  // ⭐ 0600 (v0.16.0). Default mode left the operator token world-readable on a multi-user
  //   host — the very neighbour the threat model names (external audit 2026-09-07). Existing
  //   files are read as-is (升级不重写在跑部署); POSIX platforms still tighten them to 0600.
  if (!t) {
    t = randomUUID().replace(/-/g, "");
    // ⭐ Windows 忽略 POSIX 权限位:新铸令牌改走与联邦/MCP 凭据同一条独占 DACL
    //   创建路(外部审计 2026-10-05)。保护创建失败即启动失败,不回退到无保护写入。
    //   独占创建不覆盖:先清掉"存在但读为空白"的残留(旧 writeFileSync 的覆盖语义),
    //   正常路径(文件本不存在)不经过这一步。
    if (process.platform === "win32") {
      if (present) { try { unlinkSync(file); } catch {} }
      writePrivateText(file, t);
    } else {
      writeFileSync(file, t, { encoding: "utf8", mode: 0o600 });
    }
  }
  if (process.platform !== "win32") { try { chmodSync(file, 0o600); } catch {} }
  return t;
};
const BOARD_TOKEN = mintToken(TOKEN_FILE);
const WORKER_TOKEN = mintToken(join(store.DATA_DIR, "worker_token"));
const REVIEW_TOKEN = mintToken(join(store.DATA_DIR, "review_token"));

// ── One-time pairing codes (v0.24, 一句话安装). `node cli/open.mjs` — which reads
//    board_token from the data directory, like every local CLI — asks for a code and opens
//    /#pair=<code>; the page trades the code for a PANEL CREDENTIAL (below) on this origin.
//    One code at a time: 6 digits, single use, 10 minutes, burned after 5 wrong guesses.
//    The trade requires an allowed Origin, so a page from another site cannot even try. A
//    local process can forge that header, but it still needs the code — shown once by the
//    command and used once by the page — within 5 guesses (5 in 10^6).
const PAIR_TTL_MS = 10 * 60 * 1000, PAIR_MAX_FAILURES = 5;
let pairing = null;   // { code, expires, failures }
function mintPairCode() {
  pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expires: Date.now() + PAIR_TTL_MS, failures: 0 };
  return { code: pairing.code, expires_at: new Date(pairing.expires).toISOString() };
}
/** Is this the live code? Using it, letting it expire and the fifth wrong guess retire it. */
function redeemPairCode(raw) {
  const p = pairing, code = typeof raw === "string" ? raw : "";
  if (!p) return false;
  if (Date.now() > p.expires) { pairing = null; return false; }
  if (/^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(code), Buffer.from(p.code))) { pairing = null; return true; }
  if (++p.failures >= PAIR_MAX_FAILURES) pairing = null;
  return false;
}
// ── Panel credentials. A browser paired by code holds its OWN operator credential, never
//    board_token: 退出连接 revokes it, it lapses 30 days after it was issued (pair again with
//    node cli/open.mjs), and `--forget-browsers` drops them all. What a browser remembers can
//    leak with its profile — or to whoever serves a page on this address while the board is
//    stopped — so what it holds must be one revocable, expiring credential, not the master
//    key the CLIs and loops use. Kept as sha256 in a private file: the list opens nothing.
const PANEL_FILE = join(store.DATA_DIR, "panel_sessions.json");
const PANEL_TTL_MS = 30 * 24 * 60 * 60 * 1000, PANEL_MAX = 10;
const sha256 = (t) => createHash("sha256").update(String(t)).digest("hex");
const panelSessions = new Map();   // sha256 → { issued_at }, oldest first
try {
  for (const [h, v] of Object.entries(JSON.parse(readFileSync(PANEL_FILE, "utf8")).sessions || {}))
    if (/^[0-9a-f]{64}$/.test(h) && Date.parse(v?.issued_at) > 0) panelSessions.set(h, { issued_at: v.issued_at });
} catch { /* none yet, or unreadable: every browser pairs again — never a reason to refuse startup */ }
const panelLive = (v) => Date.now() - Date.parse(v.issued_at) <= PANEL_TTL_MS;
function savePanelSessions() {
  // The private-file helper only creates: write a fresh private file, then swap it in.
  const tmp = `${PANEL_FILE}.${randomUUID()}.tmp`;
  const text = JSON.stringify({ format: "ai-fleet-panel-sessions/v1", sessions: Object.fromEntries(panelSessions) }, null, 1);
  if (process.platform === "win32") writePrivateText(tmp, text);
  else writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(tmp, PANEL_FILE);
}
function mintPanelCredential() {
  for (const [h, v] of panelSessions) if (!panelLive(v)) panelSessions.delete(h);
  while (panelSessions.size >= PANEL_MAX) panelSessions.delete(panelSessions.keys().next().value);
  dropRevokedSse();          // 被挤掉 / 过期的面板会话,它的 SSE 一并断开
  const credential = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  panelSessions.set(sha256(credential), { issued_at: new Date().toISOString() });
  savePanelSessions();
  return credential;
}
const isPanelCredential = (tok) => {
  if (typeof tok !== "string" || !/^[0-9a-f]{64}$/.test(tok)) return false;
  const v = panelSessions.get(sha256(tok));
  return !!v && panelLive(v);
};
/** An anonymous caller's body: small JSON, or null. Excess is read and dropped, so the
 *  socket stays usable for the refusal. */
const readSmallJson = (req, max = 1024) => new Promise((resolve) => {
  // 分片按字节收齐后整体解码:逐片解码会把跨分片的多字节字符改成 U+FFFD(JSON 照样能解析)。上限也按字节算。
  const chunks = []; let size = 0, over = false;
  req.on("data", (c) => { if (!over) { size += c.length; over = size > max; if (!over) chunks.push(c); } });
  req.on("end", () => { if (over) return resolve(null); const b = Buffer.concat(chunks).toString("utf8");
                        try { resolve(b ? JSON.parse(b) : {}); } catch { resolve(null); } });
  req.on("error", () => resolve(null));
});

const WORKER_WRITES = (p) =>
  p === "/api/claim" || p === "/api/tasks" || p === "/api/pools/exhausted" ||
  /^\/api\/tasks\/\d+\/(?:report|heartbeat|attempt|process-started|execution-event)$/.test(p) ||
  /^\/api\/context\/[a-z0-9_-]+\/compact$/.test(p) ||
  /^\/api\/workers\/[a-z0-9_-]+\/forked$/.test(p);
// 执行者令牌:读看板、领卡、续租、交付、写自己的状态和流水、加锁与释放自己的锁、确认交接。
//   裁定、bless、起停线、改设置都不在这里。
const EXECUTOR_WRITES = (p) =>
  p === "/api/claim" ||
  /^\/api\/tasks\/\d+\/(?:claim|heartbeat|report)$/.test(p) ||
  /^\/api\/coord\/(?:heartbeat|status|stop|journal|locks|locks\/release)$/.test(p) ||
  /^\/api\/coord\/handoffs\/\d+\/ack$/.test(p) ||
  p === "/api/approvals/request";
const REVIEW_WRITES = (p) =>
  p === "/api/pools/exhausted" ||
  /^\/api\/tasks\/\d+\/(?:resolve|autoreview)$/.test(p);
// Requests with a foreign Origin are refused; no Origin (curl / CLI) is judged by
// token. BOARD_EXTRA_ORIGINS widens the allowed browser origins, never supplies
// credentials or replaces authentication. Keep the management UI off peer forwards.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`,
  ...(process.env.BOARD_EXTRA_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
]);

/** Trim absolute paths / usernames / upstream hosts while keeping enough to
 *  diagnose. */
function redact(text) {
  if (text == null) return text;
  return String(text)
    .replace(/[A-Za-z]:[\\/](?:[^\s"'`]*[\\/])?/g, (m) => {
      const parts = m.split(/[\\/]/).filter(Boolean);
      return parts.length <= 2 ? m : `…/${parts.slice(-2).join("/")}/`;
    })
    .replace(/\/(?:home|Users)\/[^\s/"']+/gi, "~");
}

/** Authenticate a write. Returns the caller's ROLE ("operator"/"worker"/"review")
 *  or null after refusing. The role check lives HERE, at the single choke point —
 *  per-endpoint "remember to add it" forgets exactly one. */
/** The deliverable gates that stand between "waiting" and "done" — measured ONLY when closing.
 *  One function, two callers: the human's 通过 (resolve route) and a line's accept:"auto" on
 *  report (v0.21). Throws store.err(CONFLICT) with the reason a human can act on. */
function closeGateOrThrow(t) {
    const left = uncommittedOf(t);
    // null = the gate could not measure. Refusing here is the point:
    // "unmeasurable ⇒ pass" would make every git hiccup a free close.
    if (left === null)
      throw store.err(store.ERR.CONFLICT,
        `通过被拦: 交付物闸不可测(读不到宿主仓 HEAD/git)—— 不可测不等于没有违规。` +
        `\n  修复 git 环境后重试;确属无 git 部署,用 BOARD_DELIVERABLE_GATE=off 显式关闸(每次通过都会记录);` +
        `\n  或对这一张卡人工担责:resolve 带 allow_uncommitted:true 并在裁定里写明理由。`);
    if (left.length)
      throw store.err(store.ERR.CONFLICT,
        `通过被拦: 证据里点名的 ${left.length} 个交付物在工作树里存在,但**没有入库**(HEAD 里找不到)` +
        ` —— 先 commit 再通过,否则这张卡对别人是空的。` +
        `\n  ${left.join("\n  ")}` +
        `\n  ⚠若这些路径确实不该入库(例如实数据文件),在 resolve 时带 allow_uncommitted:true 并在裁定里写明理由。`);
    // ⭐ The other half of INCIDENT-1 (v0.16.1, external audit): a delivery whose
    //   named files exist NOWHERE — not on disk, not in HEAD. The comment above
    //   rules out reporting every absent path (typos, command fragments: false
    //   positives get the gate switched off), and that ruling stands. So this fires
    //   only when the evidence names files and NONE of them exists anywhere: that is
    //   not a typo, that is a fictional delivery. One real deliverable next to a typo
    //   still closes. Unmeasurable here is already refused above (uncommittedOf).
    const ab = absentOf(t);
    if (ab && ab.named > 0 && ab.absent.length === ab.named)
      throw store.err(store.ERR.CONFLICT,
        `通过被拦: 证据点名了 ${ab.named} 个交付物,但**一个都不存在**(工作树里没有,HEAD 里也没有)—— 声称的交付没有实物。` +
        `\n  ${ab.absent.join("\n  ")}` +
        `\n  ⚠若这些只是引用别处的路径而不是本卡的交付,在 resolve 时带 allow_uncommitted:true 并写明。`);
    // The reverse blind spot: "touched but never named". Attribution is by
    // TIME (work_spans) — on a shared work tree, "is the tree dirty" cannot
    // attribute.
    const unnamed = unnamedOf(t);
    if (unnamed === null)
      throw store.err(store.ERR.CONFLICT,
        `通过被拦: 交付物闸不可测(读不到 git status)—— 不可测不等于没有违规。` +
        `\n  修复 git 环境后重试;或 resolve 带 allow_uncommitted:true 人工担责并写明理由。`);
    if (unnamed.length)
      throw store.err(store.ERR.CONFLICT,
        `通过被拦: 本卡作业区间内有 ${unnamed.length} 个文件被改动却**未入库、且证据里一个都没点名**` +
        ` —— 纯文字描述不算交付。先 commit(或在证据里点名并说明为何不入库)再通过。` +
        `\n  ${unnamed.join("\n  ")}` +
        `\n  ⚠若这些改动不属于本卡(共享工作树上别的线在途),在 resolve 时带 allow_uncommitted:true 并写明归属。`);
}

// ── 绑线执行者(凭码接入)的读接口白名单(F2)。只有桥用得到的这几条;卡与它的子资源再按线核,别的线一律 404。
const BOUND_TASK_READ = /^\/api\/tasks\/(\d+)(?:\/(?:runs|history|decisions\/\d+|evidence\/\d+))?$/;
function boundExecutorMayRead(req, p) {
  if (p === "/api/coord" || p === "/api/tasks") return true;
  const mt = BOUND_TASK_READ.exec(p);
  if (mt) return store.get(db, Number(mt[1]))?.line === req.boundLine;
  // 自己发起的批准请求可以查结果;别的事项不给。
  const ma = /^\/api\/approvals\/request:(\d{1,15}):[A-Za-z0-9_.-]{1,200}$/.exec(p);
  if (ma) return db.prepare("SELECT executor FROM approval_requests WHERE id=?").get(Number(ma[1]))?.executor === req.executor.id;
  return false;
}
/** 给绑线执行者的卡:别人的 live_note 不给(只给持卡者本人与操作员)。其它读者原样。 */
function forReader(req, t) {
  if (!t || !req.boundLine || t.worker === req.executor.id) return t;
  return { ...t, live_note: null, live_note_at: null };
}
function guardAuthentication(req, res) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    json(res, 403, { error: "跨来源的看板请求被拒绝", origin });
    return null;
  }
  const tok = req.headers["x-board-token"];
  const bound = [...workers.entries()].find(([,w]) => w.workerToken && tok === w.workerToken);
  req.workerSeat = bound ? { worker:bound[0], runtime:bound[1].settings.runtime,
    line:bound[1].line,executionProfile:profileForAgent(bound[1].settings,bound[1].line) } : null;
  let role = tok === BOARD_TOKEN || isPanelCredential(tok) ? "operator"
             : tok === WORKER_TOKEN || bound ? "worker"
             : tok === REVIEW_TOKEN ? "review" : null;
  // 执行者令牌:只按哈希查登记表;只有上面三类都不匹配时才查。
  req.executor = role ? null : coord.byToken(db, tok);
  if (req.executor) { role = "executor"; connect.seen(req.executor.id); }   // last_seen_at:每次执行者请求都算
  req.boardRole = role;
  if (!role) {
    // ⚠ Echoing TOKEN_FILE raw would hand an unauthenticated caller an absolute
    //   path with the username in it. "Remember to redact at echo time" fails at
    //   exactly one site — this one, once.
    json(res, 401, { error: "缺少或错误的 X-Board-Token", hint: "请使用本机凭据；管理面板需要先配对。" });
    return null;
  }
  return role;
}
function guardWrite(req, res, p) {
  const role = guardAuthentication(req, res);
  if (!role) return null;
  const allowed = role === "operator" || (role === "worker" ? WORKER_WRITES(p)
                : role === "executor" ? EXECUTOR_WRITES(p) : REVIEW_WRITES(p));
  if (!allowed) {
    json(res, 403, { error: `${role} 令牌无权执行此操作 —— 裁定/编辑/治理动作只属于 operator 令牌(board_token)`,
                     role, path: p });
    return null;
  }
  return role;
}

if (process.env.BOARD_EXTRA_ORIGINS?.trim()) console.warn("⚠ BOARD_EXTRA_ORIGINS 扩大了允许来源；所有任务、节点身份和事件接口仍需认证，不要将管理面板用作 peer 转发。");
const WORKER_PROTOCOL_VERSION = 2;
// Shared/manual worker credentials attest execution permission, not a runtime family.
// Only a bound spawned-seat credential or an explicit operator act may stamp runtime.
function stampedRuntime(req, role, workerName, selfReported) {
  if (req.workerSeat) return req.workerSeat.runtime;
  if (role !== "operator") return null;
  const seat = workers.get(String(workerName || ""))?.settings;
  if (seat && RUNTIME_IDS.includes(seat.runtime)) return seat.runtime;
  return RUNTIME_IDS.includes(selfReported) ? selfReported : null;
}
function claimIdentity(body, role, seat=null) {
  if (role === "worker" && (body.worker_protocol_version !== WORKER_PROTOCOL_VERSION ||
      typeof body.agent_instance_id !== "string" ||
      !store.UUID_RE.test(body.agent_instance_id)))
    throw store.err(store.ERR.BAD_INPUT, "执行器协议需要版本 2 和 agent_instance_id；请先升级 worker，再领取任务");
  return { agentInstanceId:body.agent_instance_id ?? null, executionProfile:seat?.executionProfile??null, runContextForTask: task => {
    const roleId = task.line || body.line || body.worker;
    const role = LINE_ROLE[roleId] || {kind:"implement",tools:"write",charter:null,seat:null};
    return { role_id:roleId, role_kind:role.kind, tools:role.tools,
      charter:role.charter, charter_sha256:LINE_CHARTER_HASH[roleId] ?? null,
      seat:role.seat, enforcement:"unattested", worker_protocol_version:body.worker_protocol_version ?? null,
      verification_repair:store.taskVerificationRepair(db,task,{fromRun:false}),
      ...(seat?.executionProfile?{execution_profile:seat.executionProfile}:{}) };
  }};
}

// ── 多执行者协作(/api/coord/*)。读:任何已认证角色;写:见 EXECUTOR_WRITES 与各分支的角色要求。
const envMinutes = (name, dflt) => { const n = Number(process.env[name]); return process.env[name] && Number.isFinite(n) && n >= 0 ? n : dflt; };
// 锁超过预计结束多久算逾期(默认 30 分钟)。
const COORD_GRACE_MS = envMinutes("BOARD_COORD_OVERDUE_GRACE_MIN", 30) * 60000;
// 执行者心跳中断多久按停止处理并生成交接记录(默认 20 分钟)。
const COORD_STALE_MS = envMinutes("BOARD_COORD_STALE_MIN", 20) * 60000;
const asExecutor = (req, res) => {
  if (req.boardRole === "executor") return req.executor;
  json(res, 403, { error: "此操作需要执行者令牌", role: req.boardRole });
  return null;
};
// 受管(非外部)执行线第 1 个座位的 worker 名就是线 id,角色座席同理:执行者 id 与它们同名,执行者令牌就等同那个座位的凭据。
function isManagedSeatName(id) {
  return (LINES.includes(id) && !LINE_EXTERNAL?.[id]) || ROLES.includes(id) || workers.has(id);
}
const asOperator = (req, res) => {
  if (req.boardRole === "operator") return true;
  json(res, 403, { error: "此操作只属于操作员令牌", role: req.boardRole });
  return false;
};
/** 操作员强制释放锁之后的记账:控制台一行、流水一条。协作接口与批准接口共用。 */
function noteForceRelease(lock) {
  console.log(`协作锁 ${lock.resource} 被操作员强制释放(持有者 ${lock.holder}):${lock.release_reason}`);
  // 理由可以是多行;流水一行一件,所以折成一行再记。
  coord.appendJournal(db, "operator", { kind: "lock.force_release", body: approvals.oneLine(`强制释放 ${lock.resource}:${lock.release_reason}`, 300) });
}
/** 释放请求带的 lock_id / holder 与当前记录不一致(409 LOCK_CHANGED)时的一句话。协作接口与批准接口共用。 */
const lockChangedText = (l) => `锁已变化，没有释放:${l.resource} 现在是 ${l.holder_name} 持有的锁记录 #${l.lock_id}。刷新后再决定`;
async function coordRoute(req, res, url, p, m, boardRole) {
  const now = Date.now();
  // 绑线执行者(凭码接入):只看到自己——自己的登记、自己的锁、自己写的流水、自己的交接;外部线只列本线(F2)。
  if (m === "GET" && p === "/api/coord" && req.boundLine) {
    const me = req.executor.id;
    return json(res, 200, { executors: coord.listExecutors(db).filter((e) => e.id === me), locks: coord.listLocks(db, { holder: me }, now, COORD_GRACE_MS),
                            journal: coord.journal(db, { executor: me, limit: 30 }), handoffs: coord.listHandoffs(db, { pending: true }).filter((h) => h.executor === me),
                            stale_min: COORD_STALE_MS / 60000, overdue_grace_min: COORD_GRACE_MS / 60000, external_lines: [req.boundLine],
                            executor_max_lease_min: coord.EXECUTOR_MAX_LEASE_MIN, status_limits: coord.STATUS_LIMITS, now: Date.now() });
  }
  if (m === "GET" && p === "/api/coord")
    return json(res, 200, { executors: coord.listExecutors(db), locks: coord.listLocks(db, {}, now, COORD_GRACE_MS),
                            journal: coord.journal(db, { limit: 30 }), handoffs: coord.listHandoffs(db, { pending: true }),
                            stale_min: COORD_STALE_MS / 60000,
                            overdue_grace_min: COORD_GRACE_MS / 60000, external_lines: LINES.filter((l) => LINE_EXTERNAL[l]),
                            executor_max_lease_min: coord.EXECUTOR_MAX_LEASE_MIN, status_limits: coord.STATUS_LIMITS, now: Date.now() });
  if (m === "GET" && p === "/api/coord/executors") return json(res, 200, { executors: coord.listExecutors(db) });
  if (m === "POST" && p === "/api/coord/executors") {
    if (!asOperator(req, res)) return;
    const b = await readBody(req);
    if (isManagedSeatName(String(b.id ?? "").trim()))
      throw store.err(store.ERR.CONFLICT, `执行者 id ${String(b.id).trim()} 与受管执行线(或角色座席)同名;换一个 id,或把那条线配成外部执行线`);
    const r = coord.register(db, { id: b.id, name: b.name, kind: b.kind ?? undefined, rotate: b.rotate === true });
    if (r.rotated) dropRevokedSse();      // 换发:旧令牌建立的 SSE 断开
    emit("coord.executor", { id: r.executor.id });
    return json(res, r.rotated ? 200 : 201, r);
  }
  // 注销:只属于操作员(guardWrite 已把 worker、执行者、审阅令牌挡在 403;批准令牌本机不认,远程入口不开放这条路径)。
  const mx = p.match(/^\/api\/coord\/executors\/([^/]+)$/);
  if (mx && m === "DELETE") {
    if (!asOperator(req, res)) return;
    let id;
    try { id = decodeURIComponent(mx[1]); } catch { throw store.err(store.ERR.BAD_INPUT, "执行者 id 的 URL 编码无效"); }
    // id 与受管座位同名的(修复前登记的)执行者领不了卡:这个名字下进行中的卡是座位的,不挡注销。锁只可能是执行者自己的。
    const r = coord.unregister(db, id, { cardsBelongToSeat: isManagedSeatName(id) }, now);
    dropRevokedSse();                     // 注销:它的 SSE 断开
    console.log(`协作:操作员注销执行者 ${r.executor.id}`);
    emit("coord.executor", { id: r.executor.id, op: "unregister" });
    return json(res, 200, r);
  }
  if (m === "POST" && p === "/api/coord/heartbeat") {
    const ex = asExecutor(req, res); if (!ex) return;
    const b = await readBody(req);
    return json(res, 200, coord.heartbeat(db, ex.id, { taskId: b.task_id ?? null, leaseMin: b.lease_minutes }));
  }
  if (m === "GET" && p === "/api/coord/locks")
    return json(res, 200, { locks: coord.listLocks(db, { all: url.searchParams.get("all") === "1",
                            holder: url.searchParams.get("holder"), limit: url.searchParams.get("limit") }, now, COORD_GRACE_MS),
                            overdue_grace_min: COORD_GRACE_MS / 60000 });
  if (m === "POST" && p === "/api/coord/locks") {
    const ex = asExecutor(req, res); if (!ex) return;
    const b = await readBody(req);
    const r = coord.acquire(db, ex.id, { resource: b.resource, minutes: b.minutes, purpose: b.purpose }, now, COORD_GRACE_MS);
    if (!r.ok) return json(res, 409, { error: `资源 ${r.holder.resource} 已被 ${r.holder.holder_name} 占用`, holder: r.holder });
    emit("coord.lock", { resource: r.lock.resource, holder: ex.id, op: "acquire" });
    return json(res, 201, { lock: r.lock });
  }
  if (m === "POST" && p === "/api/coord/locks/release") {
    if (boardRole !== "operator" && !asExecutor(req, res)) return;
    const b = await readBody(req);
    const actor = boardRole === "operator" ? { role: "operator" } : { role: "executor", id: req.executor.id };
    const r = coord.release(db, actor, { resource: b.resource, force: b.force, reason: b.reason, lockId: b.lock_id, holder: b.holder }, now, COORD_GRACE_MS);
    if (!r.ok && r.changed) return json(res, 409, { code: "LOCK_CHANGED", error: lockChangedText(r.lock), lock: r.lock });
    if (!r.ok) return json(res, 403, { error: `只有持有者 ${r.holder.holder_name} 能释放 ${r.holder.resource}`, holder: r.holder });
    if (actor.role === "operator") noteForceRelease(r.lock);
    emit("coord.lock", { resource: r.lock.resource, holder: r.lock.holder, op: actor.role === "operator" ? "force_release" : "release" });
    return json(res, 200, { lock: r.lock });
  }
  if (m === "GET" && p === "/api/coord/journal") {
    const q = url.searchParams;
    const entries = coord.journal(db, { since: q.get("since"), executor: q.get("executor"), limit: q.has("limit") ? Number(q.get("limit")) : 50 });
    return json(res, 200, { entries, last_id: entries.length ? entries[entries.length - 1].id : null });
  }
  if (m === "POST" && p === "/api/coord/journal") {
    const ex = asExecutor(req, res); if (!ex) return;
    const b = await readBody(req);
    const entry = coord.appendJournal(db, ex.id, { kind: b.kind, body: b.body, artifacts: b.artifacts });
    emit("coord.journal", { id: entry.id, executor: ex.id });
    return json(res, 201, { entry });
  }
  if (m === "POST" && p === "/api/coord/stop") {
    const ex = asExecutor(req, res); if (!ex) return;
    const r = coord.stop(db, ex.id, "stop", now, COORD_GRACE_MS);
    if (r.created) emit("coord.handoff", { id: r.handoff.id, executor: ex.id, reason: "stop" });
    return json(res, r.created ? 201 : 200, r);
  }
  if (m === "GET" && p === "/api/coord/handoffs")
    return json(res, 200, { handoffs: coord.listHandoffs(db, { pending: url.searchParams.get("pending") === "1", limit: url.searchParams.get("limit") }) });
  const mh = p.match(/^\/api\/coord\/handoffs\/(\d+)(\/ack)?$/);
  if (mh && m === "GET" && !mh[2]) return json(res, 200, { handoff: coord.getHandoff(db, Number(mh[1])) });
  if (mh && m === "POST" && mh[2]) {
    const ex = asExecutor(req, res); if (!ex) return;
    const h = coord.ackHandoff(db, ex.id, Number(mh[1]), now);
    emit("coord.ack", { id: h.id, by: ex.id });
    return json(res, 200, { handoff: h });
  }
  if (m === "POST" && p === "/api/coord/status") {
    const ex = asExecutor(req, res); if (!ex) return;
    const b = await readBody(req);
    let st;
    try { st = coord.setStatus(db, ex.id, b); }
    catch (e) { if (e.limit != null) return json(res, 400, { error: e.message, field: e.field, limit: e.limit, got: e.got }); throw e; }
    emit("coord.status", { id: ex.id });
    return json(res, 200, { status: st, limits: coord.STATUS_LIMITS });
  }
  return json(res, m === "GET" || m === "POST" ? 404 : 405, { error: "未知的协作接口" });
}

/** 人的裁定:面板「通过/打回」、board.py approve/reject 与批准接口走的同一段逻辑。返回 store 的裁定结果。 */
function resolveTask(id, b, boardRole) {
  // verify_ok is the RULER's declaration (ran the verify just now, was it
  // green) — the store links only when true; undeclared = no linkage.
  const t = store.get(db, id);
  if (!t) throw store.err(store.ERR.NOT_FOUND, `卡 #${id} 不存在`);
  store.assertExpectedVersion(db,id,b.expected_version);
  // The handoff archive is an external side effect BEFORE the state change:
  // validate everything store.resolve would refuse FIRST, or "ruling failed"
  // can still have copied SQL = half-application.
  if (!["approve", "reject"].includes(b.verdict))
    throw store.err(store.ERR.BAD_INPUT, "verdict 必须是 approve 或 reject");
  // ⭐ resolved_by caller domain (v0.2, incident pin): human / auto only —
  //   'cascade' is store-internal bookkeeping; anything else is a caller
  //   MINTING an authority (measured on a live deployment: an interactive
  //   agent resolved its own card with resolved_by:'codex' and the board
  //   accepted it). Role × value must also agree: the review token rules
  //   only as auto; the operator token rules only as human.
  const rb = b.resolved_by == null ? "human" : String(b.resolved_by);
  if (!["human", "auto"].includes(rb))
    throw store.err(store.ERR.BAD_INPUT,
      `resolved_by 只接受 human / auto(cascade 由系统内部记账)—— 收到 ${JSON.stringify(rb)}。` +
      `裁定身份不是自我声明:worker 令牌不能 resolve,review 令牌只能以 auto 裁定`);
  if (boardRole === "review" && rb !== "auto")
    throw store.err(store.ERR.BAD_INPUT, "review 令牌只能以 resolved_by=auto 裁定(机器审阅不得冒充人的裁定)");
  if (boardRole === "operator" && rb === "auto")
    throw store.err(store.ERR.BAD_INPUT,
      "operator 令牌不能以 resolved_by=auto 裁定 —— auto 专属审阅线(review_token);人的裁定写 human");
  if (t.status !== "waiting")
    throw store.err(store.ERR.CONFLICT, `卡 #${id} 状态是 ${t.status},没有待裁定的产出`);
  // ⭐ Re-entry gate: hold_for_review KEEPS the card in waiting, so the
  //   one-shot protection above stops working — resending the same POST would
  //   re-run archiveOptionFiles, overwrite the receipt and wake the reviewer
  //   again. Plugged by SERVER STATE (plugging it in the panel's render
  //   condition would dress discipline as structure). ⚠ The key is the new
  //   column's confirm_pending — keying on the old pair (waiting_for==review
  //   && decision_choice) would wrongly bounce cards carrying a previous
  //   round's leftover choice.
  if (b.selected_option != null && t.confirm_pending === true)
    throw store.err(store.ERR.CONFLICT,
      "本卡的执行确认已经提交,正在等待复核(v0.1 由人在面板完成)—— 不能重复确认。" +
      "要改判请用「无需后续 · 通过」,或等审阅出结果。");

  // ══ ① pure validation phase (ZERO side effects) ═══════════════════════
  let archive = null;
  const said = String(b.note || "").trim();
  let resolveNote = said;
  let plan = null;
  if (b.selected_option != null) {
    if ((b.resolved_by || "human") !== "human")
      throw store.err(store.ERR.BAD_INPUT, "A/B/C 最终选择只接受人的裁定");
    const pkg = decision.normalizeDecisionPackage(t?.decision_package, t?.verdict_note);
    const opt = pkg?.options.find((x) => x.key === String(b.selected_option).toUpperCase());
    if (!opt) throw store.err(store.ERR.BAD_INPUT, `选择的方案 ${b.selected_option} 不存在`);
    const publicOpt = decision.publicDecisionPackage(t, DECISION_CTX)
      ?.options.find((x) => x.key === opt.key);
    // Field names generalized with the handoff ruling: executed / outcome /
    // receipt (an option's files can be anything a human applies by hand —
    // SQL, configs, uploads...).
    const fallbackAction = opt.kind === "apply" && b.executed === true
      ? "confirm_executed" : opt.kind === "none" ? "continue" : "";
    const decisionAction = String(b.decision_action || fallbackAction).trim();
    if (!new Set(["continue", "request_completion", "confirm_executed"]).has(decisionAction))
      throw store.err(store.ERR.BAD_INPUT, "decision_action 必须是 continue / request_completion / confirm_executed");
    let receipt = "", outcome = "";
    if (decisionAction === "request_completion") {
      if (opt.kind !== "apply" || publicOpt?.ready !== false)
        throw store.err(store.ERR.BAD_INPUT, "只有文件尚未补齐的方案才能交回智能体补齐");
    } else if (opt.kind === "apply") {
      if (decisionAction !== "confirm_executed" || b.executed !== true)
        throw store.err(store.ERR.BAD_INPUT, "该方案含需人手应用的文件;未执行时只能交回智能体补齐,不能确认已执行");
      if (!publicOpt?.ready)
        throw store.err(store.ERR.BAD_INPUT, "该方案的文件尚未补齐,不能确认已执行;请选择交回智能体补齐");
      receipt = String(b.receipt || "").trim();
      if (!receipt)
        throw store.err(store.ERR.BAD_INPUT, "确认已执行时必须填写执行回执");
      if (receipt.length > 4000)
        throw store.err(store.ERR.BAD_INPUT, "执行回执不能超过 4000 字");
      outcome = String(b.outcome || "").trim().toLowerCase();
      if (!new Set(["success", "failure"]).has(outcome))
        throw store.err(store.ERR.BAD_INPUT, "确认已执行时必须明确 outcome=success 或 failure");
    } else {
      if (decisionAction !== "continue")
        throw store.err(store.ERR.BAD_INPUT, "不含文件的方案只能使用 continue");
    }
    plan = { opt, publicOpt, decisionAction, receipt, outcome };
  }

  // ══ ② the destination is decided in THIS ONE PLACE ════════════════════
  //   ⚠ The deliverable gate used to judge the RAW b.note while the store
  //     judged the synthesized note built later — two criteria, already
  //     diverged. The judgment moved BEFORE the side effects and uses the
  //     same single function as the store.
  const disp =
    // ⚠ Key names copied EXPLICITLY: the body uses snake_case resolved_by;
    //   legacyDisposition destructures camelCase resolvedBy — passed raw, it
    //   falls to the default "human" and an auto approve turns into a
    //   hand-back (caught red once). Importing the same function removes the
    //   divergence only when the INPUTS are the same too.
    b.selected_option == null
      ? store.legacyDisposition({ verdict: b.verdict, note: b.note,
                                  resolvedBy: b.resolved_by || "human" })
    : (plan.decisionAction === "confirm_executed" && plan.outcome === "success")
        ? store.confirmDestination(db, t)
        : "hand_back";

  // ══ ③ deliverable-existence gate — measured ONLY when closing ═════════
  //   Real story: a card closed without it; only the consumers were
  //   committed and HEAD's build was broken for four days.
  //   ⚠ Only UNCOMMITTED counts. Paths absent from disk too (command-line
  //     fragments, typos) are not reported — false positives blocking
  //     closure get the gate itself switched off.
  if (disp === "close" && b.allow_uncommitted !== true) closeGateOrThrow(t);

  const r = store.resolveWithPreparation(db, { id, verdict:b.verdict, expectedVersion:b.expected_version,
    resolvedBy:b.resolved_by || "human", verifyOk:b.verify_ok, selectedOption:b.selected_option,
    disposition:disp }, ()=>{
      // Known-stale commands refuse before copying; commit rechecks under the
      // write lock. File preparation never holds the SQLite writer lock.
      let receiptBlock = null;
      if (plan) {
        const { opt, decisionAction, receipt, outcome } = plan;
        const extra = said ? `\n补充指示:${said}` : "";
        if (decisionAction === "request_completion") {
          resolveNote = `采用方案 ${opt.key} 的方向:${opt.title}。卡内文件尚未补齐;` +
            `请原 Agent 补齐完整、可下载、符合 handoff 目标准入名形的文件后重新送审。` + extra;
        } else if (opt.kind === "apply") {
          try {
            archive = decision.archiveOptionFiles(t, opt.key, DECISION_CTX);
          } catch (e) {
            const msg = String(e.message || e);
            throw store.err(msg.includes("同名异内容") ? store.ERR.CONFLICT : store.ERR.BAD_INPUT, msg);
          }
          resolveNote = outcome === "failure"
            ? `采用方案 ${opt.key}:${opt.title}。用户已实际尝试应用,但执行失败;` +
              `本次不视为已应用,禁止沿成功路径继续。请原 Agent 根据下面的原始回执修正文件;` +
              `不要覆盖已归档的失败版本,修正版使用下一个序号并重新送审。` +
              `\n\n—— 执行回执(失败 · 用户填写)——\n${receipt}` + extra
            : `采用方案 ${opt.key}:${opt.title}。文件已由用户应用成功;` +
              (disp === "hold_for_review"
                ? `**本卡不交回原 Agent** —— 留在等待中,复核通过后方可完成(v0.1 复核由人在面板完成)。`
                : `请按该方案继续并根据下面的回执完成验证。`) +
              `\n\n—— 执行回执(成功 · 用户填写)——\n${receipt}` + extra;
          // ⭐ The receipt survives as ONE block. The four existing carriers do
          //   not live through a cycle (markAutoReviewed erases, the next report
          //   overwrites) — and a silently vanished "was applied to production"
          //   is the doorway to a re-run.
          receiptBlock = { option: opt.key, outcome, receipt, said,
                           files: archive || [], at: new Date().toISOString(), consumed_at: null };
        } else {
          resolveNote = `采用方案 ${opt.key}:${opt.title}。请按该方案继续。` + extra;
        }
      }

      return {note:resolveNote,sqlArchive:archive,sqlReceipt:receiptBlock};
    });
  emit("task.resolved", r);
  return r;
}
/** 放行 / 收回:显式执行配置的卡要带本人核对过的配置摘要。面板、board.py 与批准接口共用。 */
function releaseTask(id, b) {
  const task=store.get(db,id),preview=task?taskProfilePreview(task):null;
  let executionProfile=null;
  if(preview&&b.released!==false&&!task.released){
    if(!preview.ready)throw store.err(store.ERR.CONFLICT,preview.reason);
    if(b.confirm_execution_profile_digest!==preview.profile_digest)throw store.err(store.ERR.CONFLICT,"执行配置已变化，请重新核对通道、工作目录和预算后放行");
    const {ready,reason,configuration_changed,...fixed}=preview;executionProfile=fixed;
  }
  let verificationRepair=null;
  if(task&&b.released!==false&&!task.released&&b.confirm_verification_repair_digest!==undefined){
    const repair=taskRepairPreview(task);
    if(b.confirm_verification_repair_digest!==repair.digest)throw store.err(store.ERR.CONFLICT,"验证续修轮数已变化，请重新核对后放行");
    verificationRepair=repair.policy;
  }
  const r = store.setReleased(db, { id, expectedVersion:b.expected_version, released: b.released !== false,executionProfile,verificationRepair });
  emit("task.released", r);
  return r;
}

// ── 批准接口(/api/approvals)。待批准事项不另存一份:每次从卡片、版本、锁和执行者请求的现状算出来。
//    事项 id = 类型:对象:版本,expected_version 与 id 的版本段相同;对象一变,旧 id 就不再出现。
const approvalSeenAt = new Map();   // 版本类事项没有自带时刻,记进程内第一次看到它的时刻
const seenAt = (id) => {
  if (!approvalSeenAt.has(id)) { if (approvalSeenAt.size > 200) approvalSeenAt.clear(); approvalSeenAt.set(id, new Date().toISOString()); }
  return approvalSeenAt.get(id);
};
const APPROVE_REJECT = Object.freeze(["approve", "reject"]);
/** 一张卡对应的待批准事项:等待中且待裁定 / 待验收,或显式执行配置的卡等本人放行。route 是决定时要用的内部数据。 */
function taskApprovalEntry(t) {
  if (!t || t.archived_at) return null;
  const ref = { type: "task", id: t.id, api: `/api/tasks/${t.id}`, panel: `/#task=${t.id}` };
  const title = approvals.oneLine(`#${t.id} ${t.subject}`);
  if (t.status === "waiting" && (t.waiting_for === "decision" || t.waiting_for === "review")) {
    const kind = t.waiting_for === "decision" ? "decision" : "delivery";
    return { item: { id: approvals.makeId(kind, t.id, t.aggregate_version), kind, title,
                     summary: approvals.oneLine(t.result_summary || t.summary || t.subject), detail_ref: ref,
                     created_at: t.updated_at, expected_version: t.aggregate_version, actions: [...APPROVE_REJECT],
                     labels: kind === "decision" ? { approve: "同意", reject: "否决" } : { approve: "通过", reject: "打回" } },
             route: { taskId: t.id } };
  }
  if (t.status === "not_started" && !t.released) {
    const pv = taskProfilePreview(t);
    if (!pv) return null;
    const rp = taskRepairPreview(t);
    // 放行确认绑定本人看到的执行配置摘要:配置变了版本段就变,旧 id 批不下去。
    const version = `${t.aggregate_version}.${pv.profile_digest.slice(0, 16)}.${rp.digest ? rp.digest.slice(0, 16) : "0"}`;
    // 摘要绑定的是工作目录、权限与预算,所以事项要把它们给批准者看(远程入口读不到卡片详情)。
    // 跑过又被收回放行的卡(租约到期、执行线停下、打回、重开)再次等放行时,带上收回时写进 result 的说明,摘要加标记:
    // 上一轮的结果未知,再放行可能重复计费或重复副作用,不能和首次放行长得一样。
    const rerun = Number(t.attempts) > 0 || !!t.result;
    const held = String(t.result || "").split("—— 当前运行状态 ——").pop();
    return { item: { id: approvals.makeId("release", t.id, version), kind: "release", title,
                     summary: approvals.oneLine((rerun ? "【再次放行】" : "") + (pv.configuration_changed ? "【配置已变化】" : "") +
                       `${pv.label || pv.execution_profile_id} · ${pv.model} · ${pv.effort}:${t.summary || t.subject}`),
                     detail_ref: ref, created_at: t.created_at, expected_version: version,
                     actions: pv.ready ? [...APPROVE_REJECT] : ["reject"], labels: { approve: "按此配置放行", reject: "暂不放行" },
                     execution_profile: { id: pv.execution_profile_id, label: pv.label ?? null, channel: pv.channel ?? null, model: pv.model, effort: pv.effort,
                                          workspace_path: pv.workspace?.path ?? null, tools: pv.tools ?? null, budget: pv.budget ?? null,
                                          budget_enforcement: pv.budget_enforcement ?? null, configuration_changed: !!pv.configuration_changed },
                     ...(rerun ? { rerun: true, held_note: approvals.oneLine(held, 300) } : {}),
                     ...(pv.ready ? {} : { blocked: pv.reason }) },
             route: { taskId: t.id, version: t.aggregate_version, profileDigest: pv.profile_digest, repairDigest: rp.digest } };
  }
  return null;
}
// 「这棵树待确认」会重复出现(回滚、撤销后重做):版本段带上次确认记录的写入时刻,每确认一次就换一个 id,
// 旧的决定记录不会把同一棵树的下一次确认滤掉。首次确认(还没有记录)为 0。
const acceptedStamp = () => { try { return Math.floor(statSync(acceptedFile()).mtimeMs); } catch { return 0; } };
// 事项要带原确认界面给人看的东西:上次确认的树、git diff --stat 的文件清单(前 14 行)。只有两个短哈希的摘要等于不看 diff 就确认。
const versionChanges = (pv) => ({ prev: pv.prev, files: pv.files, stat: pv.stat.slice(0, 14), more: Math.max(0, pv.stat.length - 14) });
/** 版本确认:代码已更新待重启(升级)优先;否则看板版本待确认(bless)。 */
function versionApprovalEntry(op = null) {
  const up = upgradeState();
  if (up.pending && up.apply) {
    if (op && op !== "upgrade") return null;
    const tree = up.apply.body?.confirm_tree || null;
    // 待重启的更新只属于这个进程(重启后就不再待更新):版本段带进程启动时刻,回退后再次更新到同一提交也是新的 id。
    const version = `${up.on_disk}.${tree ? tree.slice(0, 16) : "0"}.${STARTED}`;
    const id = approvals.makeId("version", "upgrade", version);
    // tree 非空 = 受闸子树的新树还没确认过:批准更新会先把它写进确认记录(acceptForUpgrade)。这一步要写在摘要里,并带上改动清单。
    const pv = tree ? acceptPreview(tree, readAccepted()) : null;
    return { item: { id, kind: "version", title: "更新看板代码",
                     summary: `从 ${up.running} 更新到 ${up.on_disk},随后重启看板` +
                       (pv ? `;同时确认受闸代码版本 ${tree.slice(0, 12)}` + (pv.files != null ? `(上次确认后改了 ${pv.files} 个文件)` : "(首次确认)") : ""),
                     detail_ref: { type: "setup", api: "/api/setup" }, created_at: seenAt(id), expected_version: version,
                     actions: [...APPROVE_REJECT], labels: { approve: "更新并重启", reject: "暂不更新" }, in_progress: up.apply.in_progress,
                     confirm: up.apply.confirm, lines: up.apply.lines, ...(pv ? { accepts_tree: tree, changes: versionChanges(pv) } : {}) },
             route: { op: "upgrade", tree } };
  }
  if (op && op !== "bless") return null;
  const bl = blessStep();
  if (bl.state !== "todo" || bl.action?.path !== "/api/setup/bless") return null;
  const tree = bl.action.body.confirm_tree, pv = acceptPreview(tree, readAccepted());
  const version = `${tree}.${acceptedStamp()}`;
  const id = approvals.makeId("version", "bless", version);
  return { item: { id, kind: "version", title: "确认当前版本",
                   summary: `确认版本 ${tree.slice(0, 12)}` + (pv.files != null ? `,上次确认后改了 ${pv.files} 个文件` : ",首次确认"),
                   detail_ref: { type: "setup", api: "/api/setup" }, created_at: seenAt(id), expected_version: version,
                   actions: [...APPROVE_REJECT], labels: { approve: "确认此版本", reject: "暂不确认" },
                   confirm: pv.confirm, changes: versionChanges(pv) },
           route: { op: "bless", tree } };
}
/** 逾期的资源锁:问人要不要强制释放。版本段 = 这次持有的预计结束时刻(毫秒)。 */
function lockApprovalEntry(l) {
  if (!l || l.released_at || !l.overdue) return null;
  const end = Date.parse(l.expected_end);
  return { item: { id: approvals.makeId("lock", l.id, end), kind: "lock", title: l.resource,
                   summary: approvals.oneLine(`${l.resource} 已逾期:${l.holder_name} · ${l.purpose}`),
                   detail_ref: { type: "lock", id: l.id, lock_id: l.lock_id, holder: l.holder, resource: l.resource, api: "/api/coord/locks" },
                   created_at: l.overdue_notified_at || new Date(end + COORD_GRACE_MS).toISOString(), expected_version: end,
                   actions: [...APPROVE_REJECT], labels: { approve: "强制释放", reject: "保留" } },
           route: { resource: l.resource, lockId: l.id } };
}
function requestApprovalEntry(r) {
  if (!r) return null;
  // summary 只有 160 字,而 action 最长 300 字:决定是对整段 action 生效的,所以事项另带完整的 action。
  return { item: { id: r.approval_id, kind: "request", title: `${r.executor} 请求批准`, summary: approvals.oneLine(r.action),
                   action: approvals.oneLine(r.action, approvals.ACTION_MAX), risk: r.risk, executor: r.executor, detail_ref: { type: "request", id: r.id, api: `/api/approvals/${r.approval_id}` },
                   created_at: r.created_at, expected_version: 1, actions: [...APPROVE_REJECT], labels: { approve: "批准", reject: "拒绝" } },
           route: { requestId: r.id } };
}
function approvalEntries() {
  const now = Date.now(), out = [];
  for (const t of store.list(db, { archived: "false" }).tasks) { const e = taskApprovalEntry(t); if (e) out.push(e); }
  const v = versionApprovalEntry(); if (v) out.push(v);
  for (const l of coord.listLocks(db, {}, now, COORD_GRACE_MS)) { const e = lockApprovalEntry(l); if (e) out.push(e); }
  for (const r of approvals.openRequests(db)) out.push(requestApprovalEntry(r));
  // 拒绝了的版本、锁、放行确认不改对象状态,靠决定记录不再列出;卡片类决定后版本已变。
  return out.filter((e) => !approvals.decisionOf(db, e.item.id))
            .sort((a, b) => String(a.item.created_at).localeCompare(String(b.item.created_at)));
}
/** 某一对象当前对应的事项(没有待批准的返回 null);对象本身不存在抛 NOT_FOUND。 */
function currentApprovalEntry(kind, object) {
  if (kind === "decision" || kind === "delivery" || kind === "release") {
    const t = /^\d+$/.test(object) ? store.get(db, Number(object)) : null;
    if (!t) throw store.err(store.ERR.NOT_FOUND, `卡 #${object} 不存在`);
    return taskApprovalEntry(t);
  }
  if (kind === "version") {
    if (!["bless", "upgrade"].includes(object)) throw store.err(store.ERR.NOT_FOUND, `没有 ${object} 这种版本确认`);
    return versionApprovalEntry(object);
  }
  if (kind === "lock") {
    if (!/^\d+$/.test(object) || !db.prepare("SELECT 1 FROM coord_locks WHERE id=?").get(Number(object)))
      throw store.err(store.ERR.NOT_FOUND, `锁记录 #${object} 不存在`);
    const l = coord.listLocks(db, {}, Date.now(), COORD_GRACE_MS).find((x) => x.id === Number(object));
    return lockApprovalEntry(l);
  }
  const r = /^\d+$/.test(object) ? approvals.getRequest(db, Number(object)) : null;
  if (!r) throw store.err(store.ERR.NOT_FOUND, `批准请求 #${object} 不存在`);
  return requestApprovalEntry(r);
}
const approvalList = () => {
  const items = approvalEntries().map((e) => e.item);
  return { approvals: items, count: items.length, now: new Date().toISOString() };
};
function approvalOne(rawId) {
  const ref = approvals.parseId(rawId);
  const decision = approvals.decisionOf(db, rawId);
  let item = null;
  if (!decision) {
    try { const e = currentApprovalEntry(ref.kind, ref.object); if (e && e.item.id === rawId) item = e.item; }
    catch (e) { if (e.code !== store.ERR.NOT_FOUND) throw e; }
  }
  if (!item && !decision) throw store.err(store.ERR.NOT_FOUND, `${rawId} 不在待批准列表里,也没有决定记录`);
  return { approval: item, decision };
}
const DECISION_VERB = Object.freeze({ approve: "批准", reject: "拒绝" });
const approvalConflict = (msg, extra = {}) => Object.assign(store.err(store.ERR.CONFLICT, msg), extra);
/** 决定一项:先核对它仍是列表里那个版本,再路由到这类事项原有的处理逻辑,最后在同一事务里写流水与决定记录。
 *  who = {actor, via, ip?}:via 由凭据决定(local 命令行令牌 / panel 面板会话 / remote 批准令牌),source 是客户端自报。
 *  拒绝版本确认、逾期锁、放行确认与执行者请求不改对象状态,只留决定记录;同一项不能决定两次(决定记录的主键)。 */
function decideApproval(rawId, body, who) {
  const ref = approvals.parseId(rawId);
  const d = approvals.normalizeDecision(body);
  const prior = approvals.decisionOf(db, rawId);
  if (prior) throw approvalConflict(`${rawId} 已于 ${prior.at} 经 ${prior.via} ${DECISION_VERB[prior.decision]},不能再决定`, { decision: prior });
  const entry = currentApprovalEntry(ref.kind, ref.object);
  const current = entry ? entry.item : null;
  if (!entry || current.kind !== ref.kind) throw approvalConflict(`${rawId} 已不在待批准列表里,刷新后再看`, { current });
  if (current.id !== rawId) throw approvalConflict(`${rawId} 已经变化,当前是 ${current.id};刷新后按新版本决定`, { current });
  if (String(d.expected_version) !== String(current.expected_version))
    throw approvalConflict(`expected_version 与这一项不一致:当前是 ${current.expected_version}`, { current });
  if (!current.actions.includes(d.decision))
    throw approvalConflict(current.blocked || `这一项现在不能${DECISION_VERB[d.decision]}`, { current });
  const r = entry.route, now = Date.now(), approve = d.decision === "approve";
  // 远程入口的再次放行:这张卡跑过,上次运行中断、结果未知,放行被收回(事项带 rerun)。再放行可能重复计费或重复副作用,
  // 远程客户端要在正文里明确带 confirm_rerun:true 才放行(客户端应当先把 held_note 给人看)。拒绝不需要;本机面板与命令行不变。
  if (who.via === "remote" && approve && ref.kind === "release" && current.rerun && body.confirm_rerun !== true)
    throw approvalConflict(`这张卡跑过,上次运行中断、结果未知,放行已被收回(${current.held_note || "没有留下说明"})。` +
      "再次放行可能重复计费或重复副作用:远程入口要求决定正文带 confirm_rerun:true", { current, needs_confirm_rerun: true });
  let result = {}, after = null;
  if (ref.kind === "decision" || ref.kind === "delivery") {
    // 与面板、board.py 的 approve/reject 同一条路:note 是给执行者的指示,写了就交回原线(store.legacyDisposition)。
    resolveTask(r.taskId, { verdict: d.decision, note: d.note, resolved_by: "human", expected_version: current.expected_version }, "operator");
    const t = store.get(db, r.taskId);
    result = { task_id: t.id, status: t.status, waiting_for: t.waiting_for ?? null, aggregate_version: t.aggregate_version };
  } else if (ref.kind === "release") {
    if (approve) releaseTask(r.taskId, { released: true, expected_version: r.version,
      confirm_execution_profile_digest: r.profileDigest, confirm_verification_repair_digest: r.repairDigest });
    const t = store.get(db, r.taskId);
    // 再次放行在决定记录里写明;远程入口确认过的另记 confirm_rerun。
    result = { task_id: t.id, released: !!t.released, aggregate_version: t.aggregate_version,
               ...(approve && current.rerun ? { rerun: true, ...(body.confirm_rerun === true ? { confirm_rerun: true } : {}) } : {}) };
  } else if (ref.kind === "version" && approve) {
    if (r.op === "bless") result = acceptTree(r.tree, `approval-${who.via}`);
    else {
      const c = store.counts(db);
      if (c.in_progress > 0)
        throw approvalConflict(`有 ${c.in_progress} 张卡正在跑,现在更新会打断它们;等它们交付后再批准`, { needs_force: true, in_progress: c.in_progress });
      result = { restarting: true, mode: RESTART_MODE, from: BOOT_REV, to: codeRev(), accepted: acceptForUpgrade(r.tree, `approval-${who.via}`) };
      after = () => setTimeout(() => { void restartBoard("approval-upgrade"); }, 80);
    }
  } else if (ref.kind === "lock" && approve) {
    // note 的上限是 500 字,锁理由是 200 字:理由取 note 折成一行后的前 200 字,全文留在决定记录的 note 里。
    // 没写 note 时不拿一句固定的话冒充理由:写明「未写理由」和是谁、经哪条通道决定的。
    const why = approvals.oneLine(d.note, coord.REASON_MAX) || `经批准接口强制释放(未写理由;${who.actor} 经 ${who.via})`;
    // 决定正文可带客户端看到的 lock_id / holder,与事项对应的那次持有比对;不一致 409 LOCK_CHANGED,不释放、不留决定。
    const rr = coord.release(db, { role: "operator" }, { resource: r.resource, force: true, reason: why,
      lockId: body.lock_id ?? r.lockId, holder: body.holder }, now, COORD_GRACE_MS);
    if (!rr.ok) throw approvalConflict(lockChangedText(rr.lock), { current, lock_code: "LOCK_CHANGED", lock: rr.lock });
    noteForceRelease(rr.lock);
    emit("coord.lock", { resource: rr.lock.resource, holder: rr.lock.holder, op: "force_release" });
    result = { resource: rr.lock.resource, released_at: rr.lock.released_at };
  } else if (ref.kind === "request") {
    result = { action: current.action };   // 决定记录里留下被批准 / 拒绝的原文,事后能对账
  }
  const src = d.source.client + (d.source.device ? "/" + d.source.device : "");
  const text = approvals.oneLine(`${DECISION_VERB[d.decision]} ${rawId}。操作者 ${who.actor},来源 ${src},经 ${who.via}` +
                                 (who.ip ? ` ${who.ip}` : "") + `。${current.summary}`, 300);
  let rec;
  db.exec("BEGIN IMMEDIATE");
  try {
    const j = coord.appendJournal(db, "operator", { kind: "approval.decided", body: text }, now);
    rec = approvals.recordDecision(db, { approval_id: rawId, decision: d.decision, note: d.note, actor: who.actor, via: who.via,
                                         source: d.source, ip: who.ip ?? null, journal_id: j.id, result }, now);
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  console.log(`批准接口:${text}`);
  emit("approval.decided", { id: rawId, decision: d.decision, via: who.via });
  return { decision: rec, result, after };
}
const decisionErrorBody = (e) => ({ error: String(e?.message || e),
  ...(e?.current !== undefined ? { current: e.current } : {}), ...(e?.decision ? { decision: e.decision } : {}),
  ...(e?.needs_force ? { needs_force: true, in_progress: e.in_progress } : {}),
  ...(e?.needs_confirm_rerun ? { needs_confirm_rerun: true } : {}),
  ...(e?.lock_code ? { code: e.lock_code, lock: e.lock } : {}),
  ...(Number.isSafeInteger(e?.current_version) ? { expected_version: e.expected_version, current_version: e.current_version } : {}) });
function sendDecision(res, id, body, who) {
  let out;
  try { out = decideApproval(id, body, who); }
  catch (e) { return json(res, statusFor(e, "approvals.decide"), decisionErrorBody(e)); }
  json(res, out.after ? 202 : 200, { decision: out.decision, result: out.result });
  out.after?.();
}
const decodeApprovalId = (raw) => {
  try { return decodeURIComponent(raw); } catch { throw store.err(store.ERR.BAD_INPUT, "事项 id 的 URL 编码无效"); }
};
async function approvalsRoute(req, res, url, p, m, boardRole) {
  if (m === "GET" && p === "/api/approvals") return json(res, 200, approvalList());
  // 执行者主动请求批准(例如「重启共享设备上的应用」):只追加的记录,决定后执行者按 approval_id 查结果。
  if (m === "POST" && p === "/api/approvals/request") {
    const ex = asExecutor(req, res); if (!ex) return;
    const b = await readBody(req);
    const r = approvals.addRequest(db, ex.id, { action: b.action, risk: b.risk });
    coord.appendJournal(db, ex.id, { kind: "approval.requested", body: approvals.oneLine(`请求批准 ${r.approval_id}(${r.risk}):${r.action}`, 300) });
    emit("approval.requested", { id: r.approval_id, executor: ex.id });
    return json(res, 201, { request: r });
  }
  if (m === "GET" && p === "/api/approvals/decisions")
    return json(res, 200, { decisions: approvals.listDecisions(db, { limit: url.searchParams.get("limit") }) });
  const md = p.match(/^\/api\/approvals\/([^/]+)$/);
  if (md && m === "GET") return json(res, 200, approvalOne(decodeApprovalId(md[1])));
  const mdd = p.match(/^\/api\/approvals\/([^/]+)\/decide$/);
  if (mdd && m === "POST") {
    if (!asOperator(req, res)) return;
    const id = decodeApprovalId(mdd[1]), b = await readBody(req);
    return sendDecision(res, id, b, { actor: "operator", via: isPanelCredential(req.headers["x-board-token"]) ? "panel" : "local" });
  }
  return json(res, m === "GET" || m === "POST" ? 404 : 405, { error: "未知的批准接口" });
}

// ── 批准令牌(操作员生成与吊销,只给远程入口用)。本机接口不认它,远程入口只认它。
async function approvalTokensRoute(req, res, url, p, m) {
  if (!asOperator(req, res)) return;
  if (m === "GET" && p === "/api/approval-tokens")
    return json(res, 200, { tokens: approvals.listTokens(db), remote: remoteStatus(), audit: approvals.listAudit(db, { limit: 20 }) });
  if (m === "POST" && p === "/api/approval-tokens") {
    const b = await readBody(req);
    const r = approvals.createToken(db, { label: b.label });
    coord.appendJournal(db, "operator", { kind: "approval.token", body: approvals.oneLine(`生成批准令牌 #${r.record.id}:${r.record.label}`, 300) });
    emit("approval.token", { id: r.record.id, op: "create" });
    return json(res, 201, r);
  }
  const mr = p.match(/^\/api\/approval-tokens\/(\d+)\/revoke$/);
  if (mr && m === "POST") {
    const t = approvals.revokeToken(db, Number(mr[1]));
    coord.appendJournal(db, "operator", { kind: "approval.token", body: approvals.oneLine(`吊销批准令牌 #${t.id}:${t.label}`, 300) });
    emit("approval.token", { id: t.id, op: "revoke" });
    return json(res, 200, { token: t });
  }
  return json(res, m === "GET" || m === "POST" ? 404 : 405, { error: "未知的批准令牌接口" });
}

// ── 远程入口(可选,默认关闭)。另起监听,只接受 allow_ips 里的来源和批准令牌,只开放批准接口与只读摘要。
//    没有 TLS:只在 VPN 或可信局域网里用。浏览器请求一律拒绝;已认证的调用写 remote_audit(决定一次一行,成功的只读查询按令牌按窗口聚合),未认证的拒绝聚合后写。
const remoteServers = [];
const remoteState = { listening: [], errors: [] };
const REMOTE_FAIL_WINDOW_MS = 10 * 60000, REMOTE_FAIL_MAX = 10;
const remoteFails = new Map();   // ip -> { n, first }:无效令牌的失败计数,按来源地址限流(只拦无效令牌)
const remoteThrottled = (ip) => {
  const f = remoteFails.get(ip);
  if (f && Date.now() - f.first > REMOTE_FAIL_WINDOW_MS) { remoteFails.delete(ip); return false; }
  return !!f && f.n >= REMOTE_FAIL_MAX;
};
const remoteFail = (ip) => {
  const f = remoteFails.get(ip);
  if (!f || Date.now() - f.first > REMOTE_FAIL_WINDOW_MS) { if (remoteFails.size > 1000) remoteFails.clear(); remoteFails.set(ip, { n: 1, first: Date.now() }); }
  else f.n++;
};
// 没通过认证就被拒的请求(路径无效、来源不在白名单、浏览器、限流、无效令牌)不逐条落库:remote_audit 只追加、删不掉,
// 不能让未认证的来源决定它长多快。每个(来源,原因)每个窗口只写第一条,其余在内存里计数,窗口结束补一行「原因 +N」;
// 全部来源合计每个窗口最多 REMOTE_DENY_ROWS_MAX 个(来源,原因),超出的并成一行来源为 * 的「denied +N」。
const REMOTE_DENY_WINDOW_MS = Number(process.env.BOARD_REMOTE_AUDIT_WINDOW_MS) > 0 ? Number(process.env.BOARD_REMOTE_AUDIT_WINDOW_MS) : 60000;
const REMOTE_DENY_ROWS_MAX = 20;
const remoteDenied = new Map();   // "来源 原因" -> { rec, first, more }
const remoteDenyWindow = { start: 0, rows: 0, dropped: 0 };
function flushRemoteDenied(now = Date.now(), all = false) {
  for (const [k, e] of remoteDenied) {
    if (!all && now - e.first < REMOTE_DENY_WINDOW_MS) continue;
    remoteDenied.delete(k);
    if (e.more) approvals.audit(db, { ...e.rec, note: `${e.rec.note} +${e.more}` }, now);
  }
  if (all || now - remoteDenyWindow.start >= REMOTE_DENY_WINDOW_MS) {
    if (remoteDenyWindow.dropped) approvals.audit(db, { ip: "*", method: "*", path: "", status: 0, note: `denied +${remoteDenyWindow.dropped}` }, now);
    Object.assign(remoteDenyWindow, { start: now, rows: 0, dropped: 0 });
  }
}
function auditRemoteDenied(rec, now = Date.now()) {
  flushRemoteDenied(now);
  const k = `${rec.ip} ${rec.note}`, e = remoteDenied.get(k);
  if (e) { e.more++; return; }
  if (remoteDenyWindow.rows >= REMOTE_DENY_ROWS_MAX) { remoteDenyWindow.dropped++; return; }
  remoteDenyWindow.rows++;
  remoteDenied.set(k, { rec, first: now, more: 0 });
  approvals.audit(db, rec, now);
}
// 已认证的只读查询(客户端每几秒查一次列表或摘要):一次一行的话,一枚令牌一天就是上万行删不掉的记录。
// 成功的 GET 按路径类别分三类:列表、只读摘要、单项查询(不分是哪一项)。每个(令牌,来源,类别)每个窗口只写第一条,
// 其余在内存里计数,窗口结束补一行「poll +N」,路径写类别(窗口长度与上面相同)。
// 不成功的调用(越权路径、查不到的单项)和每一次决定(写)仍一次一行。
const remotePollKind = (p) => p === "/api/approvals" || p === "/api/summary" ? p : "/api/approvals/:id";
const remotePolls = new Map();   // "令牌编号 来源 类别" -> { rec, kind, first, more }
function flushRemotePolls(now = Date.now(), all = false) {
  for (const [k, e] of remotePolls) {
    if (!all && now - e.first < REMOTE_DENY_WINDOW_MS) continue;
    remotePolls.delete(k);
    if (e.more) approvals.audit(db, { ...e.rec, path: e.kind, note: `poll +${e.more}` }, now);
  }
}
function auditRemotePoll(rec, now = Date.now()) {
  flushRemotePolls(now);
  const kind = remotePollKind(rec.path), k = `${rec.tokenId} ${rec.ip} ${kind}`, e = remotePolls.get(k);
  if (e) { e.more++; return; }
  remotePolls.set(k, { rec, kind, first: now, more: 0 });
  approvals.audit(db, rec, now);
}
/** 把还只在内存里的计数全部落成汇总行。停止与重启在退出前调用:不然当前窗口里「+N」的次数跟着进程一起没了。
 *  进程被强杀(任务管理器、kill -9)时走不到这里,当前窗口的计数会丢,首条仍在库里。 */
function flushRemoteAudit() {
  for (const flush of [flushRemoteDenied, flushRemotePolls]) {
    try { flush(Date.now(), true); }
    catch (e) { console.error(`远程入口审计写入失败:${e.message}`); }
  }
}
const remoteStatus = () => REMOTE.enabled
  ? { enabled: true, listen: REMOTE.listen.map(approvals.formatListen), allow_ips: REMOTE.allow_ips,
      listening: [...remoteState.listening], errors: [...remoteState.errors] }
  : { enabled: false, listen: [], allow_ips: [], listening: [], errors: [] };
function remoteSummary() {
  const now = Date.now();
  return { board: { counts: store.counts(db), version: BOOT_REV, uptime_sec: Math.floor((now - STARTED) / 1000) },
           // 凭码接入的执行者明细与撤销记录不进远程摘要(F13):批准令牌持有者只看到个数。
           approvals: approvalEntries().length, executors: coord.listExecutors(db).filter((e) => !connect.isCodeExecutor(e.id)),
           code_executors: coord.listExecutors(db).filter((e) => connect.isCodeExecutor(e.id)).length,
           locks: coord.listLocks(db, {}, now, COORD_GRACE_MS),
           journal: coord.journal(db, { limit: 40 }).filter((j) => j.kind !== "executor.revoke" && !connect.isCodeExecutor(j.executor)).slice(-20),
           now: new Date(now).toISOString() };
}
async function remoteHandler(req, res) {
  const ip = approvals.normalizeIp(req.socket.remoteAddress), m = String(req.method || "");
  let p = "", status = 0, tokenId = null, note = "";
  const send = (code, body, headers = {}) => {
    status = code;
    // 没通过认证的来源不留长连接,免得空闲连接占满 maxConnections。
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
                          "X-Content-Type-Options": "nosniff", ...(tokenId == null ? { Connection: "close" } : {}), ...headers });
    res.end(JSON.stringify(body));
  };
  try {
    try { p = new URL(req.url, "http://remote.invalid").pathname; }
    catch { p = String(req.url || "").slice(0, 200); note = "url"; return send(400, { error: "请求路径无效" }); }
    if (!REMOTE.allows(ip)) { note = "ip"; return send(403, { error: "来源地址不在允许列表里" }); }
    // 原生客户端不带这几个头;带了就是浏览器(跨源)发起的,一律拒绝,也不回任何 CORS 头。
    if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined || req.headers["sec-fetch-mode"] !== undefined) {
      note = "browser"; return send(403, { error: "远程入口不接受浏览器发起的请求" });
    }
    // 先认令牌:有效令牌不受同一来源的失败计数影响,否则同地址的任何一方发几个坏请求就能把持有者锁在门外。
    // 失败计数只拦后续的无效令牌;不带令牌的请求不可能是在猜令牌,不计数。
    const bearer = /^Bearer ([A-Za-z0-9_]{1,128})$/.exec(String(req.headers.authorization || ""));
    const tok = bearer ? approvals.tokenByValue(db, bearer[1]) : null;
    if (!tok && bearer && remoteThrottled(ip)) { note = "throttled"; return send(429, { error: "认证失败次数过多,稍后再试" }, { "Retry-After": "600" }); }
    if (!tok) { if (bearer) remoteFail(ip); note = "auth"; return send(401, { error: "缺少或无效的批准令牌" }); }
    tokenId = tok.id;
    if (m === "GET" && p === "/api/approvals") return send(200, approvalList());
    if (m === "GET" && p === "/api/summary") return send(200, remoteSummary());
    const md = p.match(/^\/api\/approvals\/([^/]+)(\/decide)?$/);
    if (md && !["request", "decisions"].includes(md[1])) {
      const id = decodeApprovalId(md[1]);
      if (m === "GET" && !md[2]) return send(200, approvalOne(id));
      if (m === "POST" && md[2]) {
        const b = await readSmallJson(req, 4096);
        if (b === null) { note = "body"; return send(400, { error: "请求正文必须是 4KB 以内的 JSON" }); }
        let out;
        try { out = decideApproval(id, b, { actor: `approval-token:${tok.id}`, via: "remote", ip }); }
        catch (e) { note = "decide"; return send(statusFor(e, "remote.decide"), decisionErrorBody(e)); }
        send(out.after ? 202 : 200, { decision: out.decision, result: out.result });
        out.after?.();
        return;
      }
    }
    note = "path"; return send(403, { error: "远程入口不开放此接口" });
  } catch (e) {
    note = note || "error";
    if (!res.headersSent) send(statusFor(e, "remote"), { error: String(e?.message || e) });
  } finally {
    try {
      if (tokenId == null) auditRemoteDenied({ ip, method: m, path: p, status, note });
      else if (m === "GET" && status === 200) auditRemotePoll({ ip, method: m, path: p, status, tokenId, note });
      else approvals.audit(db, { ip, method: m, path: p, status, tokenId, note });
    }
    catch (e) { console.error(`远程入口审计写入失败:${e.message}`); }
  }
}
// 连接按来源分池,在 connection 事件上就分(这时还没读任何数据):只有一个不分来源的总名额时,白名单外的主机
// 不用令牌、开满空闲连接就能把持有有效令牌的人挡在门外。
//   白名单外的来源合用一个小池;池里的连接最多留 REMOTE_OUTSIDE_LIFE_MS(够读完请求头、回一个 403),池满时新连接直接断开。
//   白名单内每个来源各有上限,一个来源占满自己的名额不影响别的来源。全部监听合计。
const REMOTE_OUTSIDE_POOL = 32, REMOTE_OUTSIDE_LIFE_MS = 2000, REMOTE_PER_SOURCE = 16;
const remoteConns = { outside: 0, bySource: new Map() };
function admitRemoteConnection(sock) {
  const ip = approvals.normalizeIp(sock.remoteAddress);
  if (!REMOTE.allows(ip)) {
    if (remoteConns.outside >= REMOTE_OUTSIDE_POOL) return sock.destroy();
    remoteConns.outside++;
    const timer = setTimeout(() => sock.destroy(), REMOTE_OUTSIDE_LIFE_MS);
    sock.once("close", () => { clearTimeout(timer); remoteConns.outside--; });
    return;
  }
  const n = remoteConns.bySource.get(ip) || 0;
  if (n >= REMOTE_PER_SOURCE) return sock.destroy();
  remoteConns.bySource.set(ip, n + 1);
  sock.once("close", () => {
    const left = (remoteConns.bySource.get(ip) || 1) - 1;
    if (left > 0) remoteConns.bySource.set(ip, left); else remoteConns.bySource.delete(ip);
  });
}
function startRemote() {
  if (!REMOTE.enabled) return;
  for (const l of REMOTE.listen) {
    const where = approvals.formatListen(l);
    const srv = http.createServer(remoteHandler);
    srv.requestTimeout = 15000; srv.headersTimeout = 10000; srv.keepAliveTimeout = 5000; srv.maxHeadersCount = 50;
    srv.maxConnections = 256;   // 总上限照旧;白名单外最多占其中 REMOTE_OUTSIDE_POOL 个
    srv.on("connection", admitRemoteConnection);
    srv.on("error", (e) => {
      remoteState.errors.push(`${where} ${e.code || e.message}`);
      console.error(`⚠ 远程批准入口 ${where} 监听失败:${e.message}`);
    });
    srv.listen(l.port, l.host, () => {
      remoteState.listening.push(where);
      console.log(`远程批准入口 http://${where}  允许来源 ${REMOTE.allow_ips.join(", ")}  只开放批准接口与只读摘要;没有 TLS,只在 VPN 或可信局域网里用`);
    });
    remoteServers.push(srv);
  }
  // 没有新请求时也要把上一个窗口的计数补成汇总行。
  setInterval(() => { try { flushRemoteDenied(); flushRemotePolls(); } catch (e) { console.error(`远程入口审计写入失败:${e.message}`); } }, REMOTE_DENY_WINDOW_MS).unref();
}
// 先关监听、断开连接,再落汇总:顺序反过来的话,落完之后进来的请求又只留在内存里。
const closeRemote = () => Promise.all(remoteServers.map((s) => new Promise((r) => {
  if (!s.listening) return r();
  s.close(() => r()); s.closeAllConnections?.();
}))).then(flushRemoteAudit);

// ── 对话式首页:对话、协调线一轮、按计划建卡(接口与安全边界见 docs/对话式首页.md)。
//    只认面板会话或操作员令牌;执行者令牌、批准令牌、远程入口都进不来。
//    协调线只有只读工具,计划经结构化输出交回(core/coordinator-cli.mjs);建卡只发生在 apply,由人按下。
// 协调线的工作目录:专用空目录,不在工作仓、看板仓和数据目录里(dontAsk 下 cwd 范围内可读)。
// 路径按数据目录固定,看板重启后不变:CLI 的系统提示里带 cwd,变了前缀缓存就失效。
const COORDINATOR_CWD = join(tmpdir(), "kanban-coordinator-" + createHash("sha256").update(resolve(store.DATA_DIR)).digest("hex").slice(0, 16));
function coordinatorCwd() {
  mkdirSync(COORDINATOR_CWD, { recursive: true });
  if (readdirSync(COORDINATOR_CWD).length)
    throw new Error("协调线的工作目录里出现了文件,为避免被当成资料读进去,这一轮没有启动。清空该目录后重试");
  return COORDINATOR_CWD;
}
/** 协调线现在能不能用。CLI 找不到、或当前版本还没确认(与执行线同一道源码闸)时不可用,reason 写给人看。 */
function coordinatorState() {
  const base = { runtime: "claude", model: COORDINATOR.model, effort: COORDINATOR.effort };
  const cli = coordinatorCommand({ env: process.env, argv: COORDINATOR_ARGV });
  if (!cli.ok) return { info: { available: false, reason: cli.reason, ...base }, cli: null };
  if (process.env.BOARD_ALLOW_UNPINNED !== "1") {
    const bl = blessStep();
    if (bl.state !== "done")
      return { info: { available: false, reason: `${bl.detail}。确认当前版本后协调线才能用`, ...base }, cli: null };
  }
  return { info: { available: true, ...base }, cli };
}
/** 给协调线的看板摘要:各实现线的运行状态与未完成卡数、未完成的目标标题。 */
function coordinatorBoardFacts() {
  const facts = conversations.boardFacts(db);
  return { lines: IMPL_LINES.map((id) => ({ id, label: LINE_LABEL[id] || "", open: facts.open[id] || 0,
             state: LINE_EXTERNAL[id] ? "external" : slotsOf(id).some((w) => w.proc) ? "running" : "stopped" })),
           unassigned: facts.unassigned, goals: facts.goals };
}
const coordinatorRuns = new Map();   // 对话号 -> { stop, finished }:同一对话同一时刻只有一轮
/** 起一轮(调用方已把对话置为运行中并写入用户消息)。结束时只有 finishCoordinatorTurn / finishRepairTurn 一处写库。
 *  交回的计划没过检查时,同一轮里再起一次(--resume 同一会话,内容是检查结果)请它就地修正,只一次;
 *  stop 停正在跑的那一次,停过就不再起修正。修正那一次参数除内容与会话参数外与首次相同(前缀缓存照旧命中)。 */
function startCoordinatorTurn(convId, userMessage, cli) {
  const started = Date.now();
  let current, stopAsked = false;
  const launch = (content, resume) => {
    try {
      const s = conversations.session(db, convId), cwd = coordinatorCwd();
      const args = coordinatorCliArgs({
        content: content(), model: s.model, effort: s.effort, repoRoot: resolve(REPO_ROOT),
        systemPrompt: coordinatorSystemPrompt({ lines: IMPL_LINES, hints: LINE_HINT, labels: LINE_LABEL, language: LANGUAGE }),
        sessionId: s.session_id, resume: resume ?? s.resume, ...boardCliScope() });
      conversations.setSessionFacts(db, convId, { cwd, argsFp: argsFingerprint(args) });
      current = runCoordinatorCli({ argv: [cli.exe, ...cli.prefix, ...args], cwd, timeoutMs: COORDINATOR.timeout_sec * 1000,
                                    env: coordinatorCliEnvironment({ env: process.env, profiles: EXECUTION_PROFILES }) });
    } catch (e) {
      current = { stop: async () => false, done: Promise.resolve({ refused: `协调线这一轮没有启动:${String(e?.message || e)}` }) };
    }
    return current.done;
  };
  // 首次成功后会话已经存在,修正那一次一律续接(首轮也是)。
  const repair = (issues) => (stopAsked || shuttingDown ? Promise.resolve({ stopped: true, skipped: true })
    : launch(() => buildRepairContent({ issues, lines: IMPL_LINES }), true)).then((r) => ({ r, wallMs: Date.now() - started }));
  const finished = launch(() => buildTurnContent({ board: coordinatorBoardFacts(), plan: conversations.latestPlan(db, convId),
                                                   pending: conversations.unanswered(db, convId, userMessage.id), message: userMessage.text }))
    .then((r) => finishCoordinatorTurn(convId, r, Date.now() - started, repair))
    .catch((e) => {
      console.error(`[内部失败] 对话 #${convId} 的一轮收尾出错:${String(e?.message || e).slice(0, 300)}`);
      try { conversations.failTurn(db, convId, "看板内部出错,这一轮没有记录下来。重新发送即可"); } catch {}
    })
    .finally(() => { coordinatorRuns.delete(convId); emit("conversation.changed", { id: convId }); });
  coordinatorRuns.set(convId, { stop: () => { stopAsked = true; return current.stop(); }, finished });
}
/** 用量结算:协调线每轮记一行(phase=coord)。对话已按计划建过卡就记到那张目标卡上,否则不挂卡。
 *  被停止、超时、输出过大的一轮进程也跑过,只是用量读不到:各项记 null(未知),耗时取墙钟。从不抛错。
 *  费用记这一轮的差额(conversations.roundUsage,与记到对话上的是同一个值),不是 CLI 的会话累计 total_cost_usd;
 *  所以要在这一轮的 completeTurn / failTurn 之前调用。 */
function accountCoordinatorTurn(convId, usage, wallMs, note = null, cliCost = null) {
  try {
    const s = conversations.session(db, convId), u = conversations.roundUsage(db, convId, usage, cliCost) || {};
    usageLedger.append({ phase: "coord", worker: "coordinator", card: s.goal_id, model: s.model, effort: s.effort,
      session_id: s.session_id, calls: u.num_turns, in: u.in, cc: u.cc, cr: u.cr, out: u.out,
      duration_ms: u.duration_ms ?? wallMs, cost_usd: u.cost_usd, cost_source: u.cost_usd == null ? "unknown" : "reported", note });
  } catch (e) { console.warn(`对话 #${convId} 的用量记账失败(${String(e?.message || e).slice(0, 200)})—— 不影响这一轮`); }
}
function finishCoordinatorTurn(convId, r, wallMs, repair = null) {
  // 进程起跑过的一轮(没被拒发、不是起不来),下面每条出路各记一行账本;消息上的用量照旧。
  if (r.stopped) {
    if (!r.refused && !r.spawnError) accountCoordinatorTurn(convId, null, wallMs, "这一轮被停止,用量未知");
    return conversations.stopTurn(db, convId);
  }
  if (r.refused) return conversations.failTurn(db, convId, r.refused);
  if (r.spawnError) return conversations.failTurn(db, convId, `协调线没有启动:${redact(r.spawnError)}`);
  if (r.timedOut) {
    accountCoordinatorTurn(convId, null, wallMs, "这一轮超时被终止,用量未知");
    return conversations.failTurn(db, convId, `协调线这一轮超过 ${COORDINATOR.timeout_sec} 秒没有结束,已停止。可以重新发送,或把问题拆小一些`);
  }
  if (r.overflow) {
    accountCoordinatorTurn(convId, null, wallMs, "这一轮输出过大被终止,用量未知");
    return conversations.failTurn(db, convId, "协调线这一轮的输出太大,已停止。把问题拆小一些再发");
  }
  const parsed = coordinatorTurnOf(r.stdout);
  // 计划没过检查(依赖越界或指向自己、张数、字数、线名不在实现线里):同一轮里交回去就地修正一次,用量等两次都结束再记。
  const issues = parsed.ok && repair && !conversations.session(db, convId).applied
    ? conversations.coordinatorPlanIssues(parsed.turn.plan, { implLines: IMPL_LINES }) : [];
  if (issues.length) {
    console.log(`对话 #${convId}:协调线交回的计划没过检查(${issues.length} 项),同一轮里交回去就地修正一次`);
    return repair(issues).then(({ r: again, wallMs: total }) => finishRepairTurn(convId, parsed, again, total));
  }
  const usage = parsed.usage ? { ...parsed.usage, wall_ms: wallMs } : null;
  accountCoordinatorTurn(convId, parsed.usage, wallMs, parsed.usage ? null : "结果消息里没有用量", parsed.cliCost);
  if (!parsed.ok) {
    const tail = redact(String(r.stderr || "").replace(/\s+/g, " ").trim()).slice(-200);
    // 续接失败(会话文件不在了):不悄悄另开新会话,那样会丢掉上文而人不知道。
    const reason = /No conversation found/i.test(tail) ? "续接不到这次对话之前的会话记录,这次对话不能继续。请开新对话"
      : redact(parsed.reason) + (r.code ? `(退出码 ${r.code}${tail ? ",输出尾部:" + tail : ""})` : "");
    return conversations.failTurn(db, convId, reason, { usage, cliCost: parsed.cliCost });
  }
  if (parsed.usage?.denials) console.log(`对话 #${convId}:协调线这一轮有 ${parsed.usage.denials} 次工具调用被拒`);
  conversations.completeTurn(db, convId, { reply: parsed.turn.reply, title: parsed.turn.title ?? null, plan: parsed.turn.plan,
                                           tools: parsed.tools, usage, cliCost: parsed.cliCost });
}
/** 就地修正那一次结束。用量、工具数按两次合计,账本记一行(注明含一次修正);没起来的那一次不计。
 *  修正那一次按结构交回了计划:以它的回复与计划为准,completeTurn 再查一遍,仍不过记 plan_rejected。
 *  被停止(或看板停止时没再起):按停止收尾。其余出路(没起来、超时、输出过大、没按结构交回、plan 给了 null):
 *  退回首次的回复与计划照常收尾(没过检查的照旧记 plan_rejected,只有线名问题的照旧记下、建卡时降级)。 */
function finishRepairTurn(convId, first, r, wallMs) {
  const ran = !r.refused && !r.spawnError && !r.skipped;
  const second = ran && !r.stopped && !r.timedOut && !r.overflow ? coordinatorTurnOf(r.stdout) : null;
  const { usage, cliCost } = conversations.mergeRoundUsage(db, convId, ran ? [first, second ?? { usage: null, cliCost: null }] : [first]);
  const why = r.stopped ? "修正时被停止" : r.timedOut ? "修正超时" : r.overflow ? "修正输出过大" : !ran ? "修正没有起来"
    : !second?.ok ? "修正没有按结构交回" : second.turn.plan == null ? "修正没有给计划" : null;
  accountCoordinatorTurn(convId, usage, wallMs, `这一轮含一次计划就地修正${why ? `(${why})` : ""}`, cliCost);
  if (r.stopped) return conversations.stopTurn(db, convId);
  if (why) console.log(`对话 #${convId}:就地修正没有用上(${why}${r.code ? `,退出码 ${r.code}` : ""}),退回首次的结果`);
  const use = why ? first : second;
  conversations.completeTurn(db, convId, { reply: use.turn.reply, title: use.turn.title ?? first.turn.title ?? null, plan: use.turn.plan,
                                           tools: mergeTools(first, second), usage: { ...usage, wall_ms: wallMs }, cliCost, retried: !why });
}
/** 看板停止或重启前收掉在跑的协调线进程(留着就是没人看的模型进程)。 */
const stopCoordinatorRuns = () => Promise.all([...coordinatorRuns.values()].map(async (run) => { try { await run.stop(); await run.finished; } catch {} }));

/** 按计划建卡:同一对话只成功一次。目标卡、子卡、建卡标记与 system 消息在同一事务里,任何一步失败都不留半份。
 *  子卡复用拆解的建卡段(createPlanChildren):线名不在实现线里就降为「不指定线」并记进 demoted;
 *  needs_confirm 的子卡不放行,卡号记进 needs_release。 */
function applyConversationPlan(convId, rev, expectedRev, by) {
  let out;
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = conversations.planForApply(db, convId, rev, expectedRev);
    const enabled = plan.tasks.filter((t) => t.enabled);
    const position = new Map(enabled.map((t, i) => [t.n, i + 1]));
    // 依赖指向已停用的卡:那张卡不会建,先后关系带不上,写进 system 消息让人看到。
    const dropped = [];
    const list = enabled.map((t) => ({ ...t,
      after: t.after.filter((n) => position.has(n) || (dropped.push(`第 ${t.n} 张原本排在第 ${n} 张之后`), false)).map((n) => position.get(n)) }));
    // 目标卡建好即放行:人按下「按计划建卡」就是放行这一批。祖先未放行时子卡一张都领不到
    // (store 的祖先放行规则),而合同要求子卡建好即可领。要人确认的子卡各自不放行(createPlanChildren)。
    const goalId = store.add(db, { subject: plan.goal.subject, description: plan.goal.description, kind: "goal", released: 1, actor: "operator" });
    const made = createPlanChildren(goalId, list, { actor: "operator" });
    const demoted = made.demoted.map((d) => ({ ...d, n: enabled[d.n - 1].n }));
    conversations.markApplied(db, convId, rev, { by, goalId, taskIds: made.made });
    conversations.addSystemMessage(db, convId, { kind: "applied", text:
      `已按计划第 ${rev} 版建卡:目标 #${goalId},子卡 ${made.made.map((id) => "#" + id).join(" ")}。` +
      (made.held.length ? `${made.held.map((id) => "#" + id).join(" ")} 涉及要人确认的动作,没有放行,要操作者确认后放行。` : "") +
      demoted.map((d) => `第 ${d.n} 张的线名「${d.line}」不在实现线里,已改为不指定线。`).join("") +
      (dropped.length ? `${dropped.join(";")},被依赖的卡已停用,这些先后关系没有带上。` : "") });
    out = { goal_id: goalId, task_ids: made.made, demoted, needs_release: made.held };
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  emit("task.created", { id: out.goal_id });
  emit("goal.decomposed", { id: out.goal_id, made: out.task_ids });
  emit("conversation.changed", { id: convId });
  console.log(`对话 #${convId} 按计划第 ${rev} 版建卡:目标 #${out.goal_id},子卡 ${out.task_ids.length} 张(${by})`);
  return out;
}

// ── 桌面会话 → 来领任务的线。⚠ 会话 id 是个人信息:进继承表(数据目录),接口只回 sha256 前 8 位。
// 体量阈值 200k:按 Claude 默认上下文窗口取。超过它的副本第一轮就要先压缩(又一次模型调用)或直接装不下,
// 且每次冷缓存的续接都按全价输入计这 20 万以上的 token;所以要人明确确认。体量不明(没有 usage 记录)时按文件大小 4MB 兜底。
const DESK_LARGE_TOKENS = 200000, DESK_LARGE_BYTES = 4 * 1024 * 1024;
const sessionHash = (id) => createHash("sha256").update(String(id).toLowerCase()).digest("hex").slice(0, 8);
const deskLineIndex = () => new Map(Object.entries(LINEAGE).map(([line, v]) => [`${v.source || "claude"}:${String(v.session).toLowerCase()}`, line]));
const deskLineageEntries = () => Object.fromEntries(Object.entries(LINEAGE).filter(([k, v]) => !LINEAGE_HAND.has(k) && v.via === "desktop")
  .map(([k, v]) => [k, { session: v.session, source: v.source, label: v.label, created_at: v.created_at }]));
/** 新线的座席:运行时 = 会话来源;全局缺省正好是这个运行时就用全局缺省,否则取该座席第一个模型。 */
function deskAgent(source) {
  if ((DEFAULT_AGENT.runtime || RUNTIME_IDS[0]) === source) return agentOf(DEFAULT_AGENT);
  const seat = seatOf(source), md = seat.models?.[0];
  const efforts = md?.efforts || seat.efforts || EFFORTS;
  return agentOf({ runtime: source, model: md?.id, effort: efforts.includes("high") ? "high" : efforts[efforts.length - 1] });
}
/** 登记了但这条线起不来的原因(面板要说清楚):只用现有判定 —— 座席未解禁(seat.disabled,与保存闸同一判据)、
 *  座席缺命令路径(seatCmdOk,与 workerStart 同一判据)、执行配置未就绪(profileFacts)。判不出 → null,不猜。 */
function deskStartBlocked(line) {
  if (!LINES.includes(line) || LINE_EXTERNAL?.[line]) return null;
  for (const ag of settingsOf(line).agents || []) {
    const profile = profileOf(ag);
    if (profile) {
      const fact = profileFacts().find((p) => p.id === profile.id);
      if (fact && !fact.ready) return { code: "PROFILE_NOT_READY", message: fact.reason || "执行配置尚未就绪" };
      continue;
    }
    const seat = seatOf(ag.runtime);
    if (!seat) continue;
    if (seat.disabled)
      return { code: "SEAT_LOCKED", message: `${seat.id} 座席未解禁(宿主设 ${seat.release_env}=1 后重启看板才能起这条线);登记已保存` };
    if (!seatCmdOk(seat))
      return { code: "SEAT_CMD_MISSING", message: `${seat.id} 座席缺命令路径(宿主没有配置 ${seat.cmd_env});登记已保存` };
  }
  return null;
}
const deskLineRef = (line) => (line ? { id: line, label: LINE_LABEL?.[line] || line } : null);
/** POST /api/desktop-sessions/lines → [status, body] */
function deskLineAdd(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return [400, { error: "正文要是 {source, id, label?, confirm_large?}" }];
  const source = b.source, id = typeof b.id === "string" ? b.id.toLowerCase() : "";
  if (!DESK_SOURCES.includes(source)) return [400, { error: "source 只接受 claude / codex", code: "SESSION_UNKNOWN" }];
  if (b.label !== undefined && typeof b.label !== "string") return [400, { error: "label 要是字符串" }];
  if (b.confirm_large !== undefined && typeof b.confirm_large !== "boolean") return [400, { error: "confirm_large 只接受 true / false" }];
  if (!seatOf(source) || seatOf(source).id !== source) return [400, { error: `看板没有配置 ${source} 运行时`, code: "RUNTIME_UNAVAILABLE" }];
  const s = deskSessions.info(source, id);
  if (!s) return [400, { error: "本机没有这个会话(或它是子代理线程)", code: "SESSION_UNKNOWN" }];
  const hash = sessionHash(s.id), lineId = `${source}-${hash}`;
  const taken = deskLineIndex().get(`${source}:${s.id}`);
  // P6:解除继承后线还在(卡与历史保留)。同一会话再登记 = 把继承接回这条线,不新建、不改显示名。
  //    线 id 由会话 id 的哈希定,同名线就是这个会话当初建的;外部执行线 / 角色座席不会是这个形,保险起见也拒。
  const reattach = !taken && LINES.includes(lineId) && !LINEAGE[lineId] && !LINE_EXTERNAL?.[lineId] && !ROLES.includes(lineId);
  if (taken || (LINES.includes(lineId) && !reattach))
    return [409, { error: `这个会话已经登记成线 ${taken || lineId}`, code: "ALREADY_A_LINE", line: taken || lineId }];
  const size = { approx_tokens: s.approx_tokens, size_bytes: s.size_bytes, threshold_tokens: DESK_LARGE_TOKENS };
  const large = s.approx_tokens != null ? s.approx_tokens > DESK_LARGE_TOKENS : s.size_bytes > DESK_LARGE_BYTES;
  if (large && b.confirm_large !== true)
    return [400, { error: `这个会话体量约 ${s.approx_tokens ?? "未知"} token(阈值 ${DESK_LARGE_TOKENS}):副本的第一轮要把整段历史送进模型,费用高、可能先压缩。确认后带 confirm_large:true 再提交`,
                   code: "NEEDS_CONFIRM_LARGE", ...size }];
  // ⚠ 缺省显示名不用会话标题:标题会写进 fleet.config.json(可能进仓库)。显示名先清洗(F11)再限长。
  const label = cleanLineLabel(b.label || "") || `${source === "claude" ? "Claude" : "Codex"} 会话 ${hash}`;
  let added;
  if (reattach) added = { label: LINE_LABEL?.[lineId] || lineId };
  else {
    added = addLine(lineId, "", label, null, null, false);
    settings[lineId] = { ...settingsOf(lineId), agents: [deskAgent(source)] };
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
  }
  LINEAGE[lineId] = { session: s.id, source, label: added.label, created_at: new Date().toISOString(), via: "desktop" };
  saveDeskLineage(store.DATA_DIR, deskLineageEntries());
  emit("config.lines", { line: lineId });
  emit("desktop-sessions.changed", { line: lineId });
  console.log(`线已从桌面会话${reattach ? "重新登记(接回原线)" : "登记"}: ${lineId}「${added.label}」(${source},首次领卡以会话副本为起点;未启动)`);
  return [201, { line: { id: lineId, label: added.label, runtime: source,
                         lineage: { source, session_id_hash: hash, forked: !!lineageOf(lineId)?.forked } }, ...size,
                 start_blocked: deskStartBlocked(lineId), ...(reattach ? { reattached: true } : {}) }];
}

/** 桌面端对话清单与勾选:只属于操作员(面板会话或操作员令牌),与 /api/coordinator 同一档。
 *  远程批准入口只路由批准接口,到不了这里;批准令牌在本机接口上不认(401)。 */
async function desktopSessionsRoute(req, res, url, p, m, boardRole) {
  if (boardRole !== "operator")
    return json(res, 403, { error: "桌面对话清单只属于操作员(面板会话或操作员令牌)", role: boardRole });
  if (p === "/api/desktop-sessions" && m === "GET") {
    const qs = url.searchParams;
    const source = qs.get("source") || "all";
    if (source !== "all" && !DESK_SOURCES.includes(source)) return json(res, 400, { error: "source 只接受 claude / codex / all" });
    let days = null;
    if (qs.get("days") !== null) {
      days = Number(qs.get("days"));
      if (!Number.isFinite(days) || days <= 0 || days > 3650) return json(res, 400, { error: "days 要是 1〜3650 的数" });
    }
    let limit = DESK_LIMIT_DEFAULT;
    if (qs.get("limit") !== null) {
      limit = Number(qs.get("limit"));
      if (!Number.isInteger(limit) || limit < 1) return json(res, 400, { error: `limit 要是正整数(上限 ${DESK_LIMIT_MAX})` });
      limit = Math.min(limit, DESK_LIMIT_MAX);
    }
    const q = (qs.get("q") || "").trim();
    if (q.length > 200) return json(res, 400, { error: "q 最长 200 字" });
    const lineOf = deskLineIndex();
    const r = deskSessions.list({ source, days, q: q || null, limit, selectedOnly: qs.get("selected") === "1",
                                  lineOf: (s, id) => lineOf.get(`${s}:${id}`) || null });
    // 面板要用:顶层带大体量阈值;每项 line = {id,label}|null,start_blocked = 登记了但起不来的原因|null
    return json(res, 200, { ...r, threshold_tokens: DESK_LARGE_TOKENS, threshold_bytes: DESK_LARGE_BYTES,
                            sessions: r.sessions.map((x) => ({ ...x, line: deskLineRef(x.line), start_blocked: x.line ? deskStartBlocked(x.line) : null })) });
  }
  const mm = p.match(/^\/api\/desktop-sessions\/(claude|codex)\/([0-9a-fA-F-]{36})\/messages$/);
  if (mm && m === "GET") {
    const qs = url.searchParams;
    let limit = DESK_MSG_LIMIT_DEFAULT, before = null;
    if (qs.get("limit") !== null) {
      limit = Number(qs.get("limit"));
      if (!Number.isInteger(limit) || limit < 1) return json(res, 400, { error: `limit 要是正整数(上限 ${DESK_MSG_LIMIT_MAX})` });
      limit = Math.min(limit, DESK_MSG_LIMIT_MAX);
    }
    if (qs.get("before") !== null) {
      if (!/^[1-9][0-9]{0,15}$/.test(qs.get("before"))) return json(res, 400, { error: "before 游标无效(要用上一页给的 next_before)" });
      before = Number(qs.get("before"));
    }
    let r;
    try { r = deskSessions.messages(mm[1], mm[2], { limit, before }); }
    catch (e) { if (e.status) return json(res, e.status, { error: e.message }); throw e; }
    return r ? json(res, 200, r) : json(res, 404, { error: "本机没有这个对话", code: "SESSION_UNKNOWN" });
  }
  if (p === "/api/desktop-sessions/lines" && m === "POST") return json(res, ...deskLineAdd(await readBody(req)));
  const ml = p.match(/^\/api\/desktop-sessions\/lines\/([a-z0-9_-]+)$/);
  if (ml && m === "DELETE") {
    const line = ml[1];
    if (!LINEAGE[line]) return json(res, 404, { error: `线 ${line} 不是从桌面会话登记的线`, code: "NOT_A_DESKTOP_LINE" });
    if (LINEAGE_HAND.has(line))
      return json(res, 409, { error: `线 ${line} 的继承写在数据目录的 lineage.json 里(手写项),在面板解除不了;要解除就从那份文件删掉这一项再重启看板`, code: "LINEAGE_HANDWRITTEN" });
    const running = slotsOf(line).some((s) => s.proc);
    if (SUPERVISED.includes(line)) await workerStop(line);
    delete LINEAGE[line];
    saveDeskLineage(store.DATA_DIR, deskLineageEntries());
    emit("desktop-sessions.changed", { line });
    emit("worker.changed", { line });
    console.log(`线 ${line} 已解除桌面会话继承${running ? "并停线" : ""}(线、卡与历史保留)`);
    return json(res, 200, { line: { id: line, lineage: null }, stopped: running });
  }
  if (p === "/api/desktop-sessions/selection" && m === "PUT") {
    const b = await readBody(req);
    if (!b || typeof b !== "object" || Array.isArray(b)) return json(res, 400, { error: "正文要是 {add:[…], remove:[…]}" });
    let r;
    try { r = deskSessions.select({ add: b.add ?? [], remove: b.remove ?? [] }); }
    catch (e) { if (e.status) return json(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) }); throw e; }
    if (r.changed) emit("desktop-sessions.changed", { selected: r.selected });
    return json(res, 200, { selected: r.selected });
  }
  return json(res, p === "/api/desktop-sessions" || p === "/api/desktop-sessions/selection" ? 405 : 404, { error: "没有这个接口或不接受该方法" });
}

async function conversationsRoute(req, res, url, p, m, boardRole) {
  if (boardRole !== "operator")
    return json(res, 403, { error: "对话与协调线只属于操作员(面板会话或操作员令牌)", role: boardRole });
  try {
    if (m === "GET" && p === "/api/coordinator") return json(res, 200, coordinatorState().info);
    const turn = async (start) => {
      if (shuttingDown) return json(res, 503, { error: "看板正在停止,稍后再发" });
      const state = coordinatorState();
      if (!state.cli) return json(res, 409, { error: state.info.reason, code: "COORDINATOR_UNAVAILABLE" });
      const b = await readBody(req);
      return start(b, state.cli);
    };
    if (p === "/api/conversations") {
      if (m === "GET") {
        const archived = url.searchParams.get("archived") ?? "0";
        if (!["0", "1"].includes(archived)) return json(res, 400, { error: "archived 必须是 0 或 1" });
        return json(res, 200, { conversations: conversations.list(db, { archived: archived === "1" }) });
      }
      if (m === "POST") return await turn((b, cli) => {
        const made = conversations.create(db, { message: b.message, model: COORDINATOR.model, effort: COORDINATOR.effort });
        startCoordinatorTurn(made.conversation.id, made.turn, cli);
        emit("conversation.changed", { id: made.conversation.id });
        return json(res, 201, { conversation: made.conversation, turn: { id: made.turn.id, status: "running" } });
      });
      return json(res, 405, { error: "这个接口只接受 GET 和 POST" });
    }
    const mc = p.match(/^\/api\/conversations\/(\d+)(?:\/(messages|stop))?$/);
    if (mc) {
      const id = Number(mc[1]);
      if (!mc[2] && m === "GET") return json(res, 200, flow.decorateDetail(conversations.detail(db, id)));
      if (!mc[2] && m === "PATCH") {
        const b = await readBody(req);
        const conversation = conversations.patch(db, id, { title: b.title, archived: b.archived });
        emit("conversation.changed", { id });
        return json(res, 200, { conversation });
      }
      if (mc[2] === "messages" && m === "POST") return await turn((b, cli) => {
        // 带 retry_of:重试失败的那一轮,不追加消息,用那条消息的原文再跑(条件见 conversations.retryTurn)。
        const message = b.retry_of == null ? conversations.beginTurn(db, id, { message: b.message })
          : conversations.retryTurn(db, id, { retryOf: b.retry_of });
        startCoordinatorTurn(id, message, cli);
        emit("conversation.changed", { id });
        return json(res, 202, { turn: { id: message.id, status: "running" } });
      });
      if (mc[2] === "stop" && m === "POST") {
        conversations.get(db, id);                      // 不存在 → 404
        const run = coordinatorRuns.get(id);
        const stopped = run ? await run.stop() : false;
        if (run) await run.finished;
        return json(res, 200, { stopped: !!stopped });
      }
      return json(res, 405, { error: "这个接口不接受该方法" });
    }
    const mp = p.match(/^\/api\/conversations\/(\d+)\/plans\/(\d+)(\/apply)?$/);
    if (mp && !mp[3] && m === "PUT") {
      const b = await readBody(req);
      const plan = conversations.editPlan(db, Number(mp[1]), Number(mp[2]), b, { implLines: IMPL_LINES });
      emit("conversation.changed", { id: Number(mp[1]) });
      return json(res, 200, { plan });
    }
    if (mp && mp[3] && m === "POST") {
      const b = await readBody(req);
      const via = isPanelCredential(req.headers["x-board-token"]) ? "panel" : "local";
      return json(res, 201, applyConversationPlan(Number(mp[1]), Number(mp[2]), b.expected_rev, via));
    }
    return json(res, mp ? 405 : 404, { error: "未知的对话接口" });
  } catch (e) {
    // 合同里的机器码(TURN_RUNNING / PLAN_CONFLICT / PLAN_APPLIED)与逐项问题(issues)在这里带出;其余交给兜底。
    if (!e?.conv_code && !e?.issues) throw e;
    return json(res, statusFor(e, "conversations"), { error: String(e.message), ...(e.conv_code ? { code: e.conv_code } : {}),
      ...(e.issues ? { issues: e.issues } : {}), ...(e.current_rev != null ? { current_rev: e.current_rev } : {}) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const m = req.method;

  try {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    // Anonymous shell and protocol discovery carry no operational data.
    if (m === "GET" && ["/", "/panel.html"].includes(p)) {
      const html = String(await readFile(join(__dirname, "panel.html")));
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map(match => "'sha256-" + createHash("sha256").update(match[1]).digest("base64") + "'");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' " + scripts.join(" ") + "; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (m === "GET" && p === "/panel-auth.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(await readFile(join(__dirname, "panel-auth.js")));
    }
    if (m === "GET" && p === "/health") return json(res, 200, { status: "ok", port: PORT });
    if (m === "GET" && p === "/api/meta" && req.headers["x-board-token"] === undefined)
      return json(res, 200, { worker_protocol_version: WORKER_PROTOCOL_VERSION });
    // The pairing trade is anonymous by nature — the caller holds a code, not a token — so it
    // sits before the guard and checks the Origin itself (see mintPairCode).
    if (m === "POST" && p === "/api/pair") {
      const origin = req.headers.origin;
      if (!origin || !ALLOWED_ORIGINS.has(origin)) return json(res, 403, { error: "配对只接受本机看板页面发起的请求" });
      if (!redeemPairCode((await readSmallJson(req))?.code))
        return json(res, 401, { error: "配对码无效或已过期 —— 在看板电脑上的看板目录里重新运行 node cli/open.mjs" });
      const token = mintPanelCredential();
      console.log("面板已用一次性配对码连上(本机浏览器;退出连接即撤销,30 天后需重新配对)");
      return json(res, 200, { token, role: "operator", expires_at: new Date(Date.now() + PANEL_TTL_MS).toISOString() });
    }
    // 凭码兑换执行者令牌:持码的一方还没有令牌,所以在鉴权之前;只接本机回环、不接跨来源页面(core/connect.mjs)。
    if (m === "POST" && p === "/api/connect/redeem") {
      if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { code: "LOOPBACK_ONLY", error: "凭码兑换只接受本机回环地址发起的请求" });
      if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) return json(res, 403, { error: "跨来源的看板请求被拒绝" });
      const b = await readSmallJson(req, 1024);
      if (!b || typeof b !== "object" || Array.isArray(b)) return json(res, 400, { code: "BAD_INPUT", error: "请求正文必须是 1KB 以内的 JSON 对象 {code}" });
      const r = await connect.redeem(b.code);     // 对的码立即成功;错码延迟 200ms,同时在等的错码满 20 个就 429(不按来源)
      if (r.headers) for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      if (r.status === 200) console.log(`接入:执行者 ${r.body.executor_id} 已凭码换到令牌(线 ${r.body.line})`);
      return json(res, r.status, r.body);
    }
    // Authenticate every other request, including SSE and future read endpoints.
    const boardRole = m === "GET" || m === "HEAD" ? guardAuthentication(req,res) : guardWrite(req,res,p);
    if (!boardRole) return;
    // 凭码接入的执行者(绑线):读接口只开桥用得到的几条,且按线过滤;别的读接口(含 SSE、全量历史、设置、用量)一律 404(F2)。
    //   用令牌直接登记的执行者不绑线,行为不变。表见 docs/多执行者协作.md「绑线执行者能看到什么」。
    req.boundLine = boardRole === "executor" ? connect.lineOf(req.executor.id) : null;
    if (req.boundLine && (m === "GET" || m === "HEAD") && !boundExecutorMayRead(req, p))
      return json(res, 404, { error: "不存在" });
    if (m === "GET" && p === "/api/auth") {
      if (boardRole !== "operator") return json(res,403,{error:"管理面板需要操作员身份"});
      return json(res,200,{role:"operator"});
    }
    // guardWrite let only the operator through: worker/review tokens have no pairing write.
    if (m === "POST" && p === "/api/pair/code") return json(res, 201, mintPairCode());
    // 退出连接 revokes the caller's own panel credential; {all:true} (node cli/open.mjs
    // --forget-browsers) revokes every browser's. board_token itself is never revoked here.
    if (m === "POST" && p === "/api/pair/revoke") {
      const b = await readBody(req);
      const before = panelSessions.size;
      if (b.all === true) panelSessions.clear();
      else panelSessions.delete(sha256(req.headers["x-board-token"]));
      const revoked = before - panelSessions.size;
      if (revoked) { savePanelSessions(); dropRevokedSse(); }
      return json(res, 200, { revoked });
    }

    // The new fleet reads require the existing operator credential. No new page
    // receives an injected credential; the view uses explicit operator pairing.
    if (m === "GET" && (p === "/api/fleet" || p === "/api/fleet/task" || p === "/api/fleet/evidence")) {
      if (!guardWrite(req,res,p)) return;
      try {
        const value=p.endsWith("/evidence")?readFleetEvidencePage(db,url.searchParams.get("uid"),{section:url.searchParams.get("section"),cursor:url.searchParams.get("cursor"),limit:url.searchParams.has("limit")?Number(url.searchParams.get("limit")):100}):p.endsWith("/task")?readFleetTask(db,url.searchParams.get("uid")):readFleetView(db,{projectId:url.searchParams.get("project"),ownerNodeId:url.searchParams.get("owner"),query:url.searchParams.get("q")??"",limit:url.searchParams.has("limit")?Number(url.searchParams.get("limit")):1000});
        return json(res,200,value);
      } catch(e) {return json(res,e instanceof PeerError?e.status:503,{code:e instanceof PeerError?e.code:"FLEET_VIEW_UNAVAILABLE",error:e instanceof PeerError?e.message:"全局视图暂不可读；请检查数据库与升级状态"});}
    }
    if (m==="GET"&&p==="/api/fleet/health") {
      if(!guardWrite(req,res,p))return;
      try{return json(res,200,readFleetHealth(db));}
      catch(e){return json(res,503,inspectionError(e));}
    }
    // 执行器 CLI 的当前 / 最新 / 上次核对 / 是否实测过（core/cli-versions.mjs）。最新版本一天查一次，查不到记「未能查询」。
    if (m==="GET"&&p==="/api/cli-versions") {
      if(!guardWrite(req,res,p))return;
      try{return json(res,200,await readCliVersions({dataDir:store.DATA_DIR,network:url.searchParams.get("refresh")==="1"?"force":"stale"}));}
      catch{return json(res,503,{code:"CLI_VERSIONS_UNAVAILABLE",error:"执行器 CLI 版本暂时读不到"});}
    }
    if (m==="GET"&&p==="/api/fleet/progress") {
      if(!guardWrite(req,res,p))return;
      try{return json(res,200,readFleetProgress(process.env.BOARD_PROGRESS_CONFIG,{projectId:url.searchParams.get("project")}));}
      catch(e){return json(res,e instanceof PeerError?e.status:503,{code:e instanceof PeerError?e.code:"PROGRESS_UNAVAILABLE",error:e instanceof PeerError?e.message:"阶段进度暂不可读，请检查管理者配置"});}
    }
    if ((m==="GET"||m==="POST")&&p==="/api/fleet/actions") {
      if(m==="GET"&&!guardWrite(req,res,p))return;
      if(!fleetActions)return json(res,m==="GET"?200:409,{enabled:false,code:"ACTIONS_NOT_CONFIGURED",error:"尚未配置本机协调身份和对端连接，跨端操作未启用"});
      try {
        if(m==="GET")return json(res,200,fleetActions.catalog(url.searchParams.get("project")));
        if(shuttingDown)return json(res,503,{code:"ACTIONS_CLOSED",error:"看板正在停止，请稍后使用同一请求重试"});
        let body;try{body=await readBody(req);}catch{throw new PeerError("BAD_INPUT","请求必须是有效 JSON",400);}
        const result=fleetActions.enqueue(body);
        json(res,["pending","retry_pending"].includes(result.state)?202:200,result);
        setImmediate(pumpFleetActions);return;
      } catch(e) {
        const code=typeof e?.code==="string"&&/^[A-Z][A-Z0-9_]{0,63}$/.test(e.code)?e.code:"ACTION_FAILED";
        const reasons={BAD_INPUT:"操作参数无效",FORBIDDEN:"协调身份没有所需项目或操作权限",UNAUTHENTICATED:"协调身份已失效，请核对本机配置",POLICY_CHANGED:"角色策略已更新，需要重新授权协调身份",AUTHORIZATION_CHANGED:"权限已变化，旧请求已停止",PEER_NOT_CONFIGURED:"该项目尚未配置此对端",CONFLICT:"任务或回执版本已变化，请刷新后核对",REQUEST_CONFLICT:"请求编号已绑定其他操作",NOT_FOUND:"当前项目没有可操作的对象",CONFIRMATION_REQUIRED:"双方关系和就绪证明尚未满足操作条件",QUEUE_LIMIT:"操作记录已达到上限，需维护后继续"};
        const conflict=conflictGuide.describeConflict(e,{scope:"federation"});
        return json(res,e instanceof PeerError?e.status:409,{code,error:conflict?.message||reasons[code]||"操作未获准，请核对当前任务状态与权限",...(conflict?{conflict}:{})});
      }
    }
    // Zcode 独立执行循环的状态(core/zcode-status.mjs)。只读库与 zcode_worker_config 指向的配置;
    // 不启动循环、不取调度锁、不开 MCP 端口。门与上面的管理读接口相同:只给操作员(面板会话或 board_token)。
    if (m === "GET" && p === "/api/zcode/status") {
      if (!guardWrite(req, res, p)) return;
      return json(res, 200, zcodeStatus(db, { configFile: CFG.zcode_worker_config ?? null }));
    }
    // ── 凭码接入的管理面(core/connect.mjs):读写都只给操作员(面板会话或 board_token);执行者、worker、审阅令牌 403。
    if (p === "/api/connect/codes" || p === "/api/executors" || p.startsWith("/api/executors/")) {
      if (boardRole !== "operator") return json(res, 403, { error: "接入管理只属于操作员", role: boardRole });
      if (m === "POST" && p === "/api/connect/codes") {
        const r = connect.issueCode(await readBody(req));
        if (r.status === 201) console.log(`接入:为 ${r.body.executor_id} 发了一次性码(线 ${r.body.line},10 分钟有效)`);
        return json(res, r.status, r.body);
      }
      if (m === "GET" && p === "/api/executors") return json(res, 200, { executors: connect.list(), now: new Date().toISOString() });
      const mr = p.match(/^\/api\/executors\/([a-z0-9][a-z0-9_-]{0,31})\/revoke$/);
      if (m === "POST" && mr) {
        const r = connect.revoke(mr[1]);
        dropRevokedSse();         // 它已建立的 SSE 一并断开(F3)
        console.log(`接入:操作员撤销执行者 ${mr[1]}${r.released.length ? `,放回卡 ${r.released.join(",")}` : ""}${r.released_locks.length ? `,释放锁 ${r.released_locks.join(",")}` : ""}`);
        if (r.released.length) emit("task.reaped", { count: r.released.length });
        return json(res, 200, r);
      }
      return json(res, 404, { error: "不存在" });
    }
    // ── SSE
    if (m === "GET" && p === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);
      { const tok = String(req.headers["x-board-token"] ?? "");
        sseAuth.set(res, { kind: boardRole === "executor" ? "executor" : isPanelCredential(tok) ? "panel" : "static", hash: sha256(tok) }); }
      // ⭐ A sentry announces itself (`?as=sentry`) so "is the coordinator seat
      //   actually listening" becomes MEASURABLE — the setup guide and the
      //   request alarm both need it, and a panel tab is not a sentry. An older
      //   sentry without the marker simply does not count as one: unknown falls
      //   on the not-yet side, never on the "you're all set" side.
      const isSentry = url.searchParams.get("as") === "sentry";
      if (isSentry) {
        const rev = url.searchParams.get("rev") || null;
        sentries.set(res, { rev, at: Date.now() });
        // ⭐ v0.18: a sentry that reconnects after an upgrade is still running the old file. Tell
        //   it here, first thing: a v0.18+ sentry re-runs itself on this; an older one prints it
        //   for its coordinator. Nobody has to remember to remount.
        const now = codeRev();
        if (rev && now && rev !== now)
          try { res.write(`event: change\ndata: ${JSON.stringify({ type: "sentry.stale", your_rev: rev, board_rev: now })}\n\n`); } catch {}
      }
      // 保活时顺带复核凭据:面板会话 30 天到期这类没有撤销动作的失效,至多 25 秒后也断开。
      const ka = setInterval(() => { dropRevokedSse(); try { res.write(": ka\n\n"); } catch {} }, 25000);
      req.on("close", () => { clearInterval(ka); clients.delete(res); sentries.delete(res); sseAuth.delete(res); });
      return;
    }

    // ── The immutable task history. ⚠ Two endpoints, deliberately not one:
    //    /api/events is the SSE nudge ("something changed"), this is the RECORD.
    //    Mixing them would put a growing history into a push channel that exists to
    //    stay tiny.
    if (m === "GET" && p === "/api/task-events") {
      const taskIdRaw = url.searchParams.get("task_id");
      const afterRaw = url.searchParams.get("after");
      const limitRaw = url.searchParams.get("limit");
      const taskId = taskIdRaw == null ? null : Number(taskIdRaw);
      const after = afterRaw == null ? 0 : Number(afterRaw);
      const limit = limitRaw == null ? 20000 : Number(limitRaw);
      if (taskIdRaw != null && (!Number.isInteger(taskId) || taskId <= 0))
        return json(res, 400, { error: "task_id 必须是正整数" });
      if (!Number.isInteger(after) || after < 0)
        return json(res, 400, { error: "after 必须是非负整数" });
      if (!Number.isInteger(limit) || limit < 1 || limit > 50000)
        return json(res, 400, { error: "limit 必须是 1..50000" });
      const evs = store.events(db, { taskId, after, limit, metadataOnly:true });
      // `last_id` is the cursor for the next page; echoing `after` when the page is
      // empty is what lets a caller detect "no progress" instead of looping forever.
      return json(res, 200, { events: evs, last_id: evs.length ? evs[evs.length - 1].id : after });
    }

    if (m === "GET" && p === "/api/efficiency") { const r = efficiencyHttp(efficiency, url.searchParams, boardRole); return json(res, r.status, r.body); }
    // ── Per-card token usage (panel card faces). Read-only aggregation.
    if (m === "GET" && (p === "/api/usage" || p.startsWith("/api/usage/"))) {
      const r = usageHttp(usageLedger, p, url.searchParams);
      res.writeHead(r.status, { "Content-Type": r.type, "Cache-Control": "no-store" });
      return res.end(r.body);
    }

    // ── meta (the panel's bottom status line)
    // ── v0.6 setup guide: the panel walks a first-time operator to a working
    //    deployment. Every step is MEASURED on each request — never a stored
    //    checkmark. So the guide walks BACKWARD too (delete the config, break
    //    the bless, stop the sentry) instead of claiming a state that is gone,
    //    and "cannot measure" is its own state, never "done".
    if (m === "GET" && p === "/api/setup")
      return json(res, 200, setupState());
    // The ONLY one-button step: creating the config from the shipped example.
    // Pure creation, no governance meaning, never overwrites — same act and same
    // refusal as `node cli/init.mjs`.
    if (m === "POST" && p === "/api/setup/init-config") {
      if (existsSync(CONFIG_FILE))
        throw store.err(store.ERR.CONFLICT, `${CONFIG_FILE} 已存在 —— 不覆盖(你编辑过的配置就是你的配置)`);
      // Same builder as npm run setup, without its flags: a Claude line, no codex unlock.
      writeNewConfig(CONFIG_FILE, buildConfig());
      console.log(`配置已生成: ${CONFIG_FILE}(执行线: Claude)—— 改动 lines/port/repo 后重启生效;加线可免重启`);
      return json(res, 201, { config_file: CONFIG_FILE, setup: setupState() });
    }
    // ⭐ v0.18: the guide's 「确认当前版本」. Operator token (guardWrite ran above) AND the tree the
    //   human was shown — see acceptTree. Not a one-click "accept whatever is there".
    if (m === "POST" && p === "/api/setup/bless") {
      const b = await readBody(req);
      return json(res, 200, { ...acceptTree(b.confirm_tree, "panel"), setup: setupState() });
    }
    // ⭐ Restart from the panel (v0.18); /api/upgrade/apply = accept the shown tree, then restart.
    //   Refuses while cards are in flight unless the caller says it saw that (`force`) — the
    //   panel's confirm text names the count; a script calling blind does not get to interrupt.
    if (m === "POST" && (p === "/api/setup/restart" || p === "/api/upgrade/apply")) {
      const b = await readBody(req);
      const c = store.counts(db);
      if (c.in_progress > 0 && !b.force)
        return json(res, 409, { error: `有 ${c.in_progress} 张卡正在跑 —— 现在重启会打断它们(卡回到「未开始」由线重领)`,
                                in_progress: c.in_progress, needs_force: true, hint: "脚本调用请带 force:true;面板会先问你一次" });
      let accepted = null;
      if (p === "/api/upgrade/apply") accepted = acceptForUpgrade(b.confirm_tree, "panel-upgrade");
      const live = SUPERVISED.filter((l) => slotsOf(l).some((w) => w.proc));
      const want = SUPERVISED.filter((l) => settingsOf(l).desired_running);
      json(res, 202, { restarting: true, mode: RESTART_MODE, from: BOOT_REV, to: codeRev(), lines: { stop: live, resume: want },
                       log_path: RESTART_MODE === "respawn" ? join(store.DATA_DIR, "board.log") : null, accepted });
      setTimeout(() => { void restartBoard(p === "/api/upgrade/apply" ? "panel-upgrade" : "panel-restart"); }, 80);
      return;
    }
    // Stop from the command line (cli/stop.mjs, the other half of start.mjs --background): the
    // Ctrl+C path — lines stop with their intent kept, so the next start brings them back —
    // with the same in-flight refusal as restart.
    if (m === "POST" && p === "/api/setup/stop") {
      const b = await readBody(req);
      const c = store.counts(db);
      if (c.in_progress > 0 && !b.force)
        return json(res, 409, { error: `有 ${c.in_progress} 张卡正在跑 —— 现在停会打断它们(卡回到「未开始」,下次起板后由线重领)`,
                                in_progress: c.in_progress, needs_force: true });
      json(res, 202, { stopping: true });
      console.log("停止看板(操作员请求,node cli/stop.mjs)—— 线的运行意图保留,下次起板照原样恢复");
      setTimeout(() => { void stopWithBoard("operator-stop"); }, 80);
      return;
    }
    if (m === "GET" && p === "/api/meta") {
      return json(res, 200, {
        // Display labels: the one copy lives in store.js; panel and CLI keep none.
        status_labels: store.STATUS_LABEL, wf_labels: store.WF_LABEL,
        node: store.localNode(db), worker_protocol_version: WORKER_PROTOCOL_VERSION,
        counts: store.counts(db),
        archived_count: store.list(db, { archived: "all" }).tasks.filter((t) => t.archived_at).length,
        uptime_sec: Math.floor((Date.now() - STARTED) / 1000),
        server_now: Date.now(),
      });
    }

    // ── listing. archived must be explicit; archived_count always rides
    //    (guaranteed inside store.list).
    if (m === "GET" && p === "/api/tasks") {
      const q = {
        kind: url.searchParams.get("kind"),
        status: url.searchParams.get("status"),
        route: url.searchParams.get("route"),
        line: url.searchParams.get("line"),
        archived: url.searchParams.get("archived") || "false",
      };
      if (!["true", "false", "all"].includes(q.archived))
        return json(res, 400, { error: "archived 必须是 true/false/all" });
      if (q.status && !store.VALID_STATUS.has(q.status))
        return json(res, 400, { error: `status 必须是 ${store.STATUS.join("/")}` });
      // 绑线执行者只看本线:line 参数被改写成本线;问别的线 = 空表。
      const otherLine = !!(req.boundLine && q.line && q.line !== req.boundLine);
      if (req.boundLine) q.line = req.boundLine;
      const r = otherLine ? { tasks: [], archived_count: 0 } : store.list(db, q);
      if (req.boundLine) delete r.archived_count;                       // 全板计数不给绑线执行者
      // ⭐ The panel's claimable/frozen segmentation must share claim's criteria —
      //   numbers written twice rot once (the frozen segment rotted when the
      //   lifetime cap changed shape).
      return json(res, 200, { ...r, tasks: r.tasks.map((t) => forReader(req, taskOut(t))), server_now: Date.now(),
        caps: { lifetime_dispatch: store.LIFETIME_DISPATCH_CAP, wip_per_root: store.WIP_PER_ROOT } });
    }

    if (m === "POST" && p === "/api/tasks") {
      const b = await readBody(req);
      if(!b||typeof b!=="object"||Array.isArray(b))throw store.err(store.ERR.BAD_INPUT,"建卡请求必须是 JSON 对象");
      // 先保留执行配置的角色闸；白名单外字段统一丢弃，不成为 store 的内部参数。
      // 例外是下面几个闸门字段：收紧的取值照收，否则「先不放行」「加人工闸」会被当成没写。
      if(b.execution_profile_id!==undefined&&boardRole!=="operator")return json(res,403,{error:"任务执行配置只能由操作者选择"});
      const allowed=boardRole==="operator"
        ? ["subject","summary","description","acceptance","line","route","parentId","parent_id","blockedBy","verifyCmd","needsBash","kind","execution_profile_id","model","effort"]
        : ["subject","summary","description","acceptance","line","parentId","parent_id","parent_run_id","worker"];
      const fields=Object.fromEntries(allowed.filter(key=>Object.hasOwn(b,key)).map(key=>[key,b[key]]));
      fields.actor=boardRole;
      // 三个闸门字段，操作者与 worker(派生卡)都收，只收会收紧的取值：
      // released 为 0/false、humanGate 为 1/true、maxAttempts 不大于默认。
      // 放宽方向不在建卡时生效(仍走 release / edit)，建好后在响应里点名；取值类型不对直接 400，
      // 不交给真假值判断(字符串 "0" 是真值，会被当成放行)。
      for(const key of ["released","humanGate"])
        if(Object.hasOwn(b,key)&&![true,false,1,0].includes(b[key]))
          throw store.err(store.ERR.BAD_INPUT,`${key} 只接受 true/false(或 1/0)，收到 ${JSON.stringify(b[key])}`);
      if(Object.hasOwn(b,"maxAttempts")&&!(Number.isSafeInteger(b.maxAttempts)&&b.maxAttempts>=1))
        throw store.err(store.ERR.BAD_INPUT,`maxAttempts=${JSON.stringify(b.maxAttempts)} 不合法：要 ≥1 的整数`);
      if(b.released===false||b.released===0)fields.released=0;
      if(b.humanGate===true||b.humanGate===1)fields.humanGate=true;
      if(b.maxAttempts<=store.DEFAULT_MAX_ATTEMPTS)fields.maxAttempts=b.maxAttempts;
      if(boardRole==="operator"){
        // lockKey 只给这张卡加互斥(同键的卡不同时跑)，照收。worker 不收：它能借别人的键挡住别的卡。
        if(Object.hasOwn(b,"lockKey")&&b.lockKey!==null){
          if(typeof b.lockKey!=="string"||b.lockKey.length>200)
            throw store.err(store.ERR.BAD_INPUT,`lockKey 要 200 字以内的字符串，收到 ${JSON.stringify(b.lockKey).slice(0,60)}`);
          if(b.lockKey.trim())fields.lockKey=b.lockKey;
        }
        // weight 是起跑档(决定首轮的模型与强度)：不高于默认的照收，更高的不在建卡时生效，建好后点名。
        if(Object.hasOwn(b,"weight")){
          if(!WEIGHTS.includes(b.weight))
            throw store.err(store.ERR.BAD_INPUT,`未知的起跑档(weight): ${JSON.stringify(b.weight)}；可用 ${WEIGHTS.join(" / ")}`);
          if(WEIGHTS.indexOf(b.weight)<=WEIGHTS.indexOf("standard"))fields.weight=b.weight;
        }
      }
      if(b.execution_profile_id!==undefined){
        if(!fields.line)throw store.err(store.ERR.BAD_INPUT,"选择执行配置时必须指定执行线");
        const agent=settingsOf(fields.line).agents.find(a=>a.execution_profile_id===fields.execution_profile_id&&a.model===fields.model&&a.effort===fields.effort);
        if(!agent)throw store.err(store.ERR.BAD_INPUT,"所选执行配置、模型和强度不属于该执行线");
        fields.executionProfile=profileForAgent(agent,fields.line);fields.released=0;fields.maxAttempts=1;
      }
      // Worker-token creation is for DERIVED cards only (the out-of-scope-work
      // channel): a parent is mandatory. A worker minting root goals would be a
      // worker re-scoping the board.
      if (boardRole === "worker" && fields.parentId == null && fields.parent_id == null)
        return json(res, 403, { error: "worker 令牌只能创建派生卡(必须带 parentId)—— 立根目标是 operator 的动作" });
      if (fields.parentId != null && fields.parent_id != null && Number(fields.parentId) !== Number(fields.parent_id))
        throw store.err(store.ERR.BAD_INPUT, "parentId 与 parent_id 不一致");
      fields.parentId = fields.parentId ?? fields.parent_id;
      if (boardRole === "worker") {
        fields.parentRunId = fields.parent_run_id ?? null;
        fields.parentWorker = fields.worker ?? null;
        fields.workerDerived = true;
      }
      if (badRoutable(res, fields)) return;   // creation entrance for route/line domains (ONE criterion)
      const id = store.add(db, fields);
      emit("task.created", { id });
      const made = taskOut(store.get(db, id));
      // 建成的卡比请求更严的地方逐项点名(放宽没有生效、执行配置卡固定未放行等)，不静默。
      const notApplied = [];
      if((b.released===true||b.released===1)&&!made.released)
        notApplied.push("released：这张卡建成未放行；核对后用 release 放行");
      if((b.humanGate===false||b.humanGate===0)&&made.human_gate)
        notApplied.push("humanGate:false 未生效：标题命中人工裁定字样，卡带人工闸；要开闸请建卡后用 edit");
      if(b.maxAttempts>made.max_attempts)
        notApplied.push(`maxAttempts:${b.maxAttempts} 未生效：建卡不放宽尝试次数，现为 ${made.max_attempts}；要放宽请建卡后用 edit`);
      if(boardRole==="operator"&&Object.hasOwn(b,"weight")&&made.weight!==b.weight)
        notApplied.push(`weight:${b.weight} 未生效：建卡不抬高起跑档，现为 ${made.weight}；要调请建卡后用 edit`);
      return json(res, 201, { task: made, ...(notApplied.length ? { not_applied: notApplied } : {}) });
    }

    // ── goals
    if (m === "POST" && p === "/api/goals") {
      const b = await readBody(req);
      // ⭐ 白名单:目标卡只取 subject / description / parentId(面板只传这三项)。原先整个请求体展开进
      //   store.add,客户端可以在建卡记录(add 事件)里写进伪造的执行配置快照、actor、尝试次数等;
      //   未知字段一律不进 store.add。route/line/weight 也因此到不了这里,原先的 badRoutable 闸不再需要。
      const fields = Object.fromEntries(["subject", "description", "parentId"]
        .filter((key) => Object.hasOwn(b, key)).map((key) => [key, b[key]]));
      const id = store.add(db, { ...fields, kind: "goal", released: 0 });
      emit("task.created", { id });
      return json(res, 201, { task: taskOut(store.get(db, id)) });
    }
    const mg = p.match(/^\/api\/goals\/(\d+)\/decompose$/);
    if (mg && m === "POST") {
      const b = await readBody(req);
      // ⭐ v0.23 decompose gate: an unfinished review card under this goal means the plan is
      //   still being contested — decomposing now implements a plan nobody accepted yet. The
      //   human may override (`force`); the override is written on the children's history
      //   (actor), distinct from a plain decompose. 409 = passes once the review card closes
      //   — the same shape as the restart refusals (needs_force + hint). Without a review
      //   line configured there is nothing to wait for, and this is a no-op.
      const pending = store.openChildrenOnLines(db, Number(mg[1]), REVIEW_LINES);
      if (pending.length && !b.force)
        return json(res, 409, { error: `目标 #${mg[1]} 下还有未完成的评审卡 #${pending.join(" #")}`,
                                needs_force: true, pending_review: pending,
                                hint: "等评审卡通过、改好方案再拆;确实要现在拆,带 force 重发" });
      if (pending.length) console.log(`目标 #${mg[1]} 强制拆解:评审卡 #${pending.join(" #")} 未完成(操作者 force)`);
      return json(res, 200, await decomposeGoal(Number(mg[1]), b.model, pending.length > 0));
    }
    const mpl = p.match(/^\/api\/goals\/(\d+)\/pipeline$/);
    if (mpl && m === "POST") {
      const b = await readBody(req);
      const r = pipelineReview(Number(mpl[1]), b.line);
      emit("task.created", { id: r.task.id });
      return json(res, 201, r);
    }
    const mr = p.match(/^\/api\/tasks\/(\d+)\/related$/);
    if (mr && m === "GET") {
      // ids alone serve only callers who hold the full board (the panel). Loops do
      // not, so rows are returned too (ids stay for the panel).
      const ids = store.relatedIds(db, Number(mr[1]));
      return json(res, 200, { ids, tasks: ids.map((i) => taskOut(store.get(db, i))).filter(Boolean) });
    }

    // ── context management
    if (m === "GET" && p === "/api/context")
      return json(res, 200, { lines: SUPERVISED.map(contextOf) });
    const mc = p.match(/^\/api\/context\/([a-z0-9_-]+)\/compact$/);
    if (mc && m === "POST") {
      if (badLine(res, mc[1], SUPERVISED)) return;
      // Lines without a persistent session (review = fresh per judgment) have
      // nothing to fold — do not mint a ghost session.
      if (!settings[mc[1]]?.session_id)
        return json(res, 400, { error: `${mc[1]} 没有持续会话可压缩` });
      const b = await readBody(req);
      const r = await compactLine(mc[1], b.note);
      emit("context.compacted", { line: mc[1] });
      return json(res, 200, r);
    }

    // Auto-review targets (waiting, unreviewed or moved-since-review)
    if (m === "GET" && p === "/api/review/pending") {
      // v0.23: the reviewer says which runtime it IS (`?runtime=`); with anti-affinity on, the
      // cards its own family delivered come back as `held`, never silently dropped. No
      // runtime given = the saved review seat's (an older reviewer keeps working as before).
      const rt = url.searchParams.get("runtime") || reviewSeatRuntime();
      const all = store.pendingReview(db);
      const isHeld = (t) => !!REVIEW_ANTI_AFFINITY && !!t.last_runtime && t.last_runtime === rt;
      return json(res, 200, { tasks: all.filter((t) => !isHeld(t)).map(t=>({...t,history_refs:store.taskHistoryRefs(db,t.id)})),
                              held: all.filter(isHeld).map((t) => ({ id: t.id, last_runtime: t.last_runtime })),
                              anti_affinity: REVIEW_ANTI_AFFINITY, reviewer_runtime: rt });
    }

    // Pool rate-limit reporting. `until` is recomputed from the server's own hold
    // constant — the caller's value is never authoritative. The response returns
    // before scheduling, so a self-stopping loop and this HTTP call cannot deadlock.
    if (m === "GET" && p === "/api/pools")
      return json(res, 200, { pools: poolState, global_stop: bothPoolsDown(),
                              marker: bothPoolsDown() ? "pool_global_stop.json" : null });
    if (m === "POST" && p === "/api/pools/exhausted") {
      const b = await readBody(req);
      if(req.workerSeat?.executionProfile)return json(res,403,{error:"独立执行配置不会触发共享池切换或额外付费探测"});
      if (!POOL_IDS.includes(b.runtime))
        return json(res, 400, { error: `runtime 必须是 ${POOL_IDS.join("/")}` });
      const observed = Date.parse(b.exhausted_at || "");
      const entry = markPoolDown(b.runtime, observed);
      updateGlobalStopMarker(`reported:${b.runtime}`);
      schedulePoolReconcile(`reported:${b.runtime}`);
      return json(res, 200, { marked: true, runtime: b.runtime, entry,
                              pools: poolState, global_stop: bothPoolsDown() });
    }

    const mf = p.match(/^\/api\/workers\/([a-z0-9_-]+)\/forked$/);
    if (mf && m === "POST") {
      const b = await readBody(req);
      // review never forks (no inertia by design) — worker lines only.
      if (badLine(res, mf[1], LINES)) return;
      // session_id goes into settings and later into glob + --resume; unshaped, a
      // single `*` turns transcript scanning into all-files.
      if (!UUID_RE.test(String(b.session_id || "")))
        return json(res, 400, { error: "session_id 必须是 UUID", got: String(b.session_id || "").slice(0, 40) });
      return json(res, 200, { settings: markForked(mf[1], b.session_id) });
    }
    // ── v0.5: operator requests — a panel button addressed to the coordinator
    //    seat. POST creates the durable row and wakes the seat through the SSE
    //    sentry (request.created); the seat acks/dones through board.py (operator
    //    token — it IS the operator's agent). Worker/review tokens 403 by list.
    if (m === "GET" && p === "/api/requests")
      return json(res, 200, { requests: store.listRequests(db, { open: url.searchParams.get("open") === "1" }) });
    if (m === "POST" && p === "/api/requests") {
      const b = await readBody(req);
      const r = store.addRequest(db, { kind: b.kind, params: b.params });
      emit("request.created", { id: r.id, kind: r.kind, params: r.params });
      console.log(`快捷指令 #${r.id} ${r.kind} —— 已广播给协调席(哨挂着才收得到)`);
      return json(res, 201, { request: r });
    }
    const mrq = p.match(/^\/api\/requests\/(\d+)\/(ack|done)$/);
    if (mrq && m === "POST") {
      const b = await readBody(req);
      const r = mrq[2] === "ack" ? store.ackRequest(db, Number(mrq[1]))
                                 : store.doneRequest(db, Number(mrq[1]), b.note);
      emit(`request.${mrq[2]}`, { id: r.id, kind: r.kind });
      return json(res, 200, { request: r });
    }
    // ── v0.4: add a line without a restart (operator token only — the worker and
    //    review allowlists do not carry this path, so they 403 by construction).
    if (m === "POST" && p === "/api/config/lines") {
      const b = await readBody(req);
      const added = addLine(b.id, b.hint, b.label, b.accept, b.role, b.external ?? false);
      emit("config.lines", { line: added.id });
      console.log(`线已加入: ${added.id}${added.label ? "「" + added.label + "」" : ""}${added.hint ? "(" + added.hint + ")" : ""}${added.accept === "auto" ? " · 交付即完成" : ""}`
        + (added.role ? ` · 身份 ${added.role.kind}${added.role.tools === "read-only" ? "·只读" : ""}${added.role.charter ? " · 章程 " + added.role.charter : ""}` : "")
        + ` —— 已写入 ${CONFIG_FILE},无需重启`);
      return json(res, 201, { line: added, lines: LINES, line_hints: LINE_HINT, line_labels: LINE_LABEL, line_accept: LINE_ACCEPT,
                              line_roles: LINE_ROLE, impl_lines: IMPL_LINES, line_external: LINE_EXTERNAL });
    }
    if (m === "GET" && p === "/api/workers") {
      const inspect = url.searchParams.get("readiness") === "1";
      const listed = SUPERVISED.map(line => {
        const info = workerInfo(line);
        if(inspect)info.runtime_verifications=runtimeVerifications(db,Array.from({length:MAX_PARALLEL},(_,i)=>slotKey(line,i+1)));
        return info;
      });
      return json(res, 200, { workers: listed, lines: LINES,
                              execution_profiles:profileFacts(),workspace:{label:"当前项目",path:REPO_ROOT},
                              line_hints: LINE_HINT, line_labels: LINE_LABEL, line_accept: LINE_ACCEPT, routes: ROUTES,
                              line_external: LINE_EXTERNAL,
                              // v0.22: id → identity (null = plain line); the implement subset the decomposer sees.
                              line_roles: LINE_ROLE, impl_lines: IMPL_LINES,
                              // v0.23: the review lines (pipeline targets) and the anti-affinity policy.
                              review_lines: REVIEW_LINES, review_anti_affinity: REVIEW_ANTI_AFFINITY,
                              models: MODELS, efforts: EFFORTS, weights: WEIGHTS,
                              max_parallel: MAX_PARALLEL, runtimes: inspect ? RUNTIMES.map(r=>({...r,readiness:executorReadiness(r,{enabled:seatUnlocked(r)})})) : RUNTIMES,
                              decompose_models: DECOMPOSE_MODELS,
                              // Handoff targets as id/label/rules ONLY — their
                              // directories never go over the wire.
                              handoff_targets: HANDOFF_TARGETS.map((t) => ({
                                id: t.id, label: t.label, exts: t.exts,
                                name_pattern: t.namePattern.source })),
                              pools: poolState, global_stop: bothPoolsDown(),
                              // ⭐ Emitted as a SIBLING of the supervision table (not
                              //   merged into workerInfo): merged, it only shows on
                              //   SUPERVISED rows — and the one thing worth showing,
                              //   an unknown name firing blind, would be the row
                              //   that vanishes.
                              claim_misses: [...claimMiss.entries()]
                                .map(([worker, v]) => ({ worker, ...v }))
                                .sort((a, b) => b.n - a.n) });
    }
    // Runtime REALITY CHECK. ⭐ Measured with the same env the server really spawns
    //   with (slotEnv shared). Passing from a desktop shell means nothing if the
    //   child's env/cwd/PATH differ. ⚠ Probes fire even on LOCKED seats (read-only,
    //   claims nothing, writes nothing to the board): evidence must be producible
    //   BEFORE release, or it's chicken-and-egg.
    const mpr = p.match(/^\/api\/workers\/([a-z0-9_-]+)\/probe-runtime$/);
    if (mpr && m === "POST") {
      if (badLine(res, mpr[1], SUPERVISED)) return;
      const b = await readBody(req);
      const loop = join(LOOPS_DIR, "worker_loop.py");
      if (!existsSync(loop))
        return json(res, 500, { error: "loops/worker_loop.py 未安装 —— 无从探测" });
      const st0 = settingsOf(mpr[1]);
      const ag = { ...(st0.agents[0] || DEFAULT_AGENT),
                   ...(b.runtime ? { runtime: b.runtime } : {}),
                   ...(b.model ? { model: b.model } : {}),
                   ...(b.effort ? { effort: b.effort } : {}) };
      if(b.execution_profile_id!==undefined)ag.execution_profile_id=b.execution_profile_id;
      const selectedProfile=profileOf(ag);
      if(selectedProfile&&b.live)return json(res,403,{error:"执行配置的真实验证须使用有预算的新任务卡；接入检查不调用模型"});
      if(selectedProfile){const fact=profileFacts().find(p=>p.id===selectedProfile.id);if(!fact?.ready)return json(res,200,{line:mpr[1],agent:ag,live:false,ok:false,code:3,out:fact?.reason||"执行配置尚未就绪",err:""});}
      const seat = seatOf(ag.runtime);
      if (!seat) return json(res, 400, { error: `未知运行时 ${ag.runtime}` });
      if (!(seat.models || []).some((x) => x.id === ag.model))
        return json(res, 400, { error: `${seat.label} 没有模型 ${ag.model}` });
      const dom = effortsFor(ag.runtime, ag.model);
      if (!dom.includes(ag.effort))
        return json(res, 400, { error: `${ag.model} 的强度必须是 ${dom.join("/")}` });
      const args = [loop, "--probe-runtime", "--as", mpr[1],
                    ...(b.live ? ["--live"] : [])];
      const out = await new Promise((resolve) => {
        execFile(PY, args, { env: slotEnv(mpr[1], 1, ag, false), cwd: __dirname,
                             encoding: "utf8", timeout: Number(b.timeout_ms) || 300_000,
                             maxBuffer: 4 << 20 },
          (e, so, se) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
                                   out: String(so || ""), err: String(se || "").slice(-2000) }));
      });
      return json(res, 200, { line: mpr[1], agent: ag, live: !!b.live,
                              ok: out.code === 0, ...out });
    }
    const ms = p.match(/^\/api\/workers\/([a-z0-9_-]+)\/settings$/);
    if (ms && m === "POST") {
      if (badLine(res, ms[1], SUPERVISED)) return;
      const b = await readBody(req);
      const next = setSettings(ms[1], b);
      const info = workerInfo(ms[1]);
      return json(res, 200, { line: ms[1], settings: next,
        note: !info.running ? "已保存"
            : info.stale_settings ? "已保存,但当前进程还在用旧设置 —— 停止再启动才生效"
            : "已保存(与运行中的进程一致)" });
    }
    const mw = p.match(/^\/api\/workers\/([a-z0-9_-]+)\/(start|stop)$/);
    if (mw && m === "POST") {
      if (badLine(res, mw[1], SUPERVISED)) return;
      const b = await readBody(req);
      let r;
      // HUMAN start/stop resets the ladder (auto-restarts do not).
      //   ⚠ Reset only on SUCCESS — a start bounced with "already running" must not
      //   fold the running slots' ladder, or repeated pressing disables the backoff.
      if (mw[2] === "start") {
        // A mistyped route 400s HERE — passed through, claim's route filter makes
        // the line run forever with "nothing claimable": silent starvation with no
        // stateable reason.
        if (b.route !== undefined && !ROUTES.includes(b.route))
          throw store.err(store.ERR.BAD_INPUT,
            `route 只接受 ${ROUTES.join("/")} —— 收到 ${JSON.stringify(b.route)}`);
        r = workerStart(mw[1], b.route || store.DEFAULT_ROUTE); resetLadder(mw[1]);
      }
      else r = await workerStop(mw[1]);   // stop resets inside workerStop (one place, internal calls included)
      return json(res, 200, r);
    }

    if (p === "/api/coord" || p.startsWith("/api/coord/")) return await coordRoute(req, res, url, p, m, boardRole);
    if (p === "/api/desktop-sessions" || p.startsWith("/api/desktop-sessions/"))
      return await desktopSessionsRoute(req, res, url, p, m, boardRole);
    if (p === "/api/coordinator" || p === "/api/conversations" || p.startsWith("/api/conversations/"))
      return await conversationsRoute(req, res, url, p, m, boardRole);
    if (p === "/api/approvals" || p.startsWith("/api/approvals/")) return await approvalsRoute(req, res, url, p, m, boardRole);
    if (p === "/api/approval-tokens" || p.startsWith("/api/approval-tokens/")) return await approvalTokensRoute(req, res, url, p, m);

    // Pick-a-card claim (no id) — this is what the worker loop hits.
    // Empty queue = 204, not an error: the worker should sleep, not retry.
    if (m === "POST" && p === "/api/claim") {
      const b = await readBody(req);
      if(req.workerSeat?.executionProfile&&b.line!==req.workerSeat.line)throw store.err(store.ERR.CONFLICT,"执行配置只能领取本执行线任务");
      { const bound = boardRole === "executor" ? connect.lineOf(req.executor.id) : null;      // 凭码接入:只从自己的线挑
        if (bound && b.line != null && b.line !== bound) return json(res, 403, { error: `此执行者只接线 ${bound} 的卡` });
        if (bound) b.line = bound; }
      // All pools down = global stop. During a single-pool switchover race, no new
      // card goes to a process of the exhausted runtime either.
      if (req.workerSeat?.executionProfile?.auth_kind!=="api_key" && (bothPoolsDown() || (POOL_IDS.includes(b.runtime) && poolDown(b.runtime))))
        return json(res, 503, { error: bothPoolsDown() ? "全部池额度耗尽 —— 全局停止领卡"
                                                    : `${b.runtime} 池额度耗尽 —— 等 server 切换座席`,
                                pools: poolState });
      // ⛔ NO badRoutable here (ruled; reasons at claimMiss above — the harness
      //   watches that stray values do NOT 400).
      // Runtime is credential-bound; a shared worker token cannot attest a family.
      // Reset on every server claim so an unknown new run cannot inherit an old badge.
      const rt = stampedRuntime(req, boardRole, b.worker, b.runtime);
      const identity = claimIdentity(b, boardRole,req.workerSeat);
      // 绑线执行者:只领 line 恰好等于本线的卡(line 为空的卡不算,F1);受管线与旧执行者仍是「本线 或 未指定线」。
      const got = store.claim(db, b.worker, b.lease_minutes || store.DEFAULT_LEASE_MIN,
                              { route: b.route, line: b.line, strictLine: !!req.boundLine, runtime: rt, resetRuntime:true, ...identity, ...fpContext() });
      noteClaim(b.worker, { route: b.route, line: b.line }, !!got);
      if (!got) {
        // ⭐ Empty-handed, but WHY. Same rule the pool gate follows (503 must not wear
        //   204's face): a queue emptied by the no-progress brake looks exactly like
        //   an empty queue from the line's log, and nobody asks about a quiet board.
        //   204 keeps meaning "there is genuinely nothing"; a 200 with no task and a
        //   `held` list means "there are cards, and none of them has anything new".
        //   Clients already branch on `!body.task`, so this adds a reason without
        //   changing what anyone must handle.
        const held = store.heldByNoProgress(db, { route: b.route, line: b.line }, fpContext())
          .filter((hid) => !req.boundLine || store.get(db, hid)?.line === req.boundLine);   // 绑线执行者不看别处的卡号
        if (held.length) return json(res, 200, { task: null, held: held.length, held_ids: held.slice(0, 20) });
        res.writeHead(204); return res.end();
      }
      emit("task.claimed", { id: got.id, worker: b.worker });
      return json(res, 200, { task: taskOut(got) });
    }

    // Ruling attachments are sourced only from the structured package, and every
    // download/view re-runs the allowed-roots/real-file/link guards.
    const msql = p.match(/^\/api\/tasks\/(\d+)\/decision-attachment\/([A-Za-z0-9_-]+)\/(\d+)$/);
    if (msql && m === "GET") {
      const t = store.get(db, Number(msql[1]));
      if (!t) return json(res, 404, { error: "任务不存在" });
      try {
        const src = decision.decisionAttachmentSource(t, msql[2], Number(msql[3]), DECISION_CTX);
        const encoded = encodeURIComponent(src.name).replaceAll("'", "%27");
        const executable = src.role === "apply" || src.role === "rollback";
        res.writeHead(200, {
          "Content-Type": executable ? "application/octet-stream" : "text/plain; charset=utf-8",
          "Content-Length": src.bytes,
          // companions are viewable as body text only; the direct endpoint must not
          // re-wrap them as executable attachments.
          "Content-Disposition": `${executable ? "attachment" : "inline"}; filename="attachment"; filename*=UTF-8''${encoded}`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        });
        return createReadStream(src.path).pipe(res);
      } catch (e) {
        return json(res, 404, { error: String(e.message || e) });
      }
    }

    const historyPath=p.match(/^\/api\/tasks\/(\d+)\/(decisions|evidence)\/(\d+)$/);
    if(historyPath){
      if(m!=="GET")return json(res,405,{error:"方法不允许"});
      const id=Number(historyPath[1]);
      if(!store.get(db,id))return json(res,404,{error:"不存在"});
      const record=store.taskHistoryRecord(db,{id,kind:historyPath[2],seq:Number(historyPath[3])});
      return record?json(res,200,{[historyPath[2]==="decisions"?"decision":"evidence"]:record}):json(res,404,{error:"不存在"});
    }
    const mt = p.match(/^\/api\/tasks\/(\d+)(?:\/(claim|heartbeat|attempt|process-started|execution-event|report|resolve|update|autoreview|pin|release|archive|reopen|runs|history))?$/);
    if (mt) {
      const id = Number(mt[1]);
      const action = mt[2];

      // 合同 B:按卡的历史(人话条目,旧→新)。只给操作员(面板会话或操作员令牌)。
      if (m === "GET" && action === "history") {
        if (boardRole !== "operator") return json(res, 403, { error: "卡的历史只给操作员(面板会话或操作员令牌)", role: boardRole });
        const raw = url.searchParams.get("limit"), limit = raw == null ? 100 : Number(raw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return json(res, 400, { error: "limit 必须是 1..1000" });
        if (!store.get(db, id)) return json(res, 404, { error: "不存在" });
        return json(res, 200, flow.history(id, limit));
      }
      if (m === "GET" && action === "runs") {
        if (!store.get(db,id)) return json(res,404,{error:"不存在"});
        return json(res,200,{runs:store.runs(db,id)});
      }
      if (m === "GET" && !action) {
        const t = store.get(db, id);
        return t ? json(res, 200, { task: forReader(req, taskOut(t)) }) : json(res, 404, { error: "不存在" });
      }
      if (m !== "POST") return json(res, 405, { error: "方法不允许" });
      const b = await readBody(req);

      const versioned = new Set(["claim","resolve","autoreview","update","pin","release","reopen","archive"]);
      if(versioned.has(action)) store.requireExpectedVersion(b.expected_version);

      if (action === "claim") {
        // 凭码接入的执行者绑一条线:别的线的卡领不走(桥里也筛,这里是服务端的门)。
        const bound = boardRole === "executor" ? connect.lineOf(req.executor.id) : null;
        if (bound && store.get(db, id)?.line !== bound) return json(res, 403, { error: `此执行者只接线 ${bound} 的卡`, id });
        // ⭐ This endpoint claims THE GIVEN id (it used to call pick-a-card and
        //   occupy a different card). Refusals come back with the reason named.
        const r = store.claimById(db, { id, worker: b.worker, expectedVersion:b.expected_version, ...claimIdentity(b, boardRole,req.workerSeat),
                                        leaseMin: b.lease_minutes || store.DEFAULT_LEASE_MIN,
                                        // Operator-only direct claims remain an explicit trusted act.
                                        runtime: stampedRuntime(req, boardRole, b.worker, b.runtime), resetRuntime:true,
                                        // ⭐ force = a person saying "run it anyway". Operator-only:
                                        //   guardWrite already restricts this endpoint, and a worker
                                        //   able to force its own re-dispatch would own the brake.
                                        force: boardRole === "operator" && b.force === true,
                                        ...fpContext() });
        // Refusal codes come from the store's typing. This is the one code-deciding
        // site that does NOT pass the catch (claimById returns instead of throwing)
        // — hence it goes through statusFor, so unclassified refusals still raise
        // the alarm.
        if (!r.ok) return json(res, statusFor({ code: r.code, message: r.why }, "claim"), { error: r.why, id });
        emit("task.claimed", { id, worker: b.worker });
        return json(res, 200, { task: taskOut(r.task) });
      }
      if (action === "heartbeat") {
        // 没给 lease_minutes(或给的不是正数)的心跳只往后续:取默认租约与这张卡现有剩余时间里较长的。store 在没给时
        // 按默认 30 分钟改写,会把更长的租约缩短,到点被回收(与 coord.heartbeat 同一条规则)。明确给了正数就按给的值:
        // worker 循环每次都带,行为不变。持有者与 run 的核对仍在 store.heartbeat 里。
        let lease = b.lease_minutes;
        if (!(Number.isFinite(Number(lease)) && Number(lease) > 0)) {
          const left = (Number(db.prepare("SELECT lease_until FROM tasks WHERE id=?").get(id)?.lease_until) - Date.now()) / 60000;
          lease = Math.max(store.DEFAULT_LEASE_MIN, Number.isFinite(left) ? left : 0);
          if (boardRole === "executor") lease = Math.min(lease, coord.EXECUTOR_MAX_LEASE_MIN);
        }
        const note = b.note === undefined ? undefined : connect.checkNote(b.note);   // 先校验:不合规就不续租
        const r = store.heartbeat(db, { id, worker: b.worker, runId: b.run_id, leaseMin: lease });
        if (boardRole === "executor") {
          coord.touch(db, req.executor.id);
          // 外部执行者这一轮第一次心跳 = 「已启动」(合同 B 订正);推一个 task.* 让流转条与首页跟着亮。
          if (connect.markHeartbeat(id, b.run_id)) emit("task.started", { id });
        }
        // note = 临时进度(live_note):覆盖上一条,不进历史;只有它变时才推一个事件给面板。
        //   没变不推;同一张卡至多 5 秒推一次,窗口内的变化合并(F4,connect.noteChanged)。
        if (note !== undefined && connect.setNote(id, b.run_id, note)) connect.noteChanged(id);
        return json(res, 200, r);       // no SSE for heartbeats: freshness is client-side
      }
      if (action === "process-started") {
        // 仅受管宿主的独立凭据可记录；操作员、共享 worker 和模型文本不能代填观察。
        if(boardRole!=="worker"||!req.workerSeat)
          return json(res,403,{error:"进程启动记录仅接受本次受管执行器的独立凭据"});
        if(b.runtime!==req.workerSeat.runtime)
          throw store.err(store.ERR.CONFLICT,"启动记录的执行器与凭据不一致");
        const seat=seatOf(b.runtime);
        if(!seat?.models?.some(model=>model.id===b.model)||!effortsFor(b.runtime,b.model).includes(b.effort))
          throw store.err(store.ERR.BAD_INPUT,"启动记录的模型或推理强度不在现有允许范围");
        const r=store.recordProcessStarted(db,{id,worker:b.worker,runId:b.run_id,agentInstanceId:b.agent_instance_id,
          runtime:b.runtime,attempt:b.attempt,pid:b.pid,model:b.model,effort:b.effort,executionProfile:req.workerSeat.executionProfile});
        emit("task.process_started",{id});
        return json(res,200,r);
      }
      if(action==="execution-event"){
        if(boardRole!=="worker"||!req.workerSeat?.executionProfile)return json(res,403,{error:"SDK 观察仅接受本次受管执行配置的独立凭据"});
        const profile=req.workerSeat.executionProfile;
        if(b.execution_profile_id!==profile.execution_profile_id||b.profile_digest!==profile.profile_digest)throw store.err(store.ERR.CONFLICT,"SDK 事件的执行配置与凭据不一致");
        const result=store.recordExecutionEvent(db,{id,worker:b.worker,runId:b.run_id,agentInstanceId:b.agent_instance_id,executionProfile:profile,eventId:b.event_id,kind:b.kind,model:b.model,effort:b.effort,requestId:b.request_id??null,sessionId:b.session_id??null,status:b.status??null,usage:b.usage??null,costUsd:b.cost_usd??null});
        emit("task.execution_observed",{id});return json(res,200,result);
      }
      if (action === "report") {
        const selfUsage = b.usage == null ? null : externalRows(b.usage);   // 先校验:格式不对就不收这次交付
        const r = store.report(db, { id, worker: b.worker, runId: b.run_id, outcome: b.outcome, evidence: b.evidence });
        connect.clearNote(id);          // 交付即清掉临时进度
        if (selfUsage) usageLedger.appendExternal(selfUsage, { task: store.get(db, id), worker: b.worker, runId: b.run_id, outcome: b.outcome });
        emit("task.reported", r);
        // ⭐ v0.21 (user ruling 2026-09-09): on a line configured accept:"auto" a delivery completes
        //   without a human click — the operator decided that ONCE, in the config, for the whole
        //   line. Same close gates as a human's 通过 (closeGateOrThrow); a refusal leaves the card
        //   in 等待中 for a human, loudly. Human-gated cards are never auto-completed.
        const after = store.get(db, id);
        if (b.outcome === "done" && after && after.status === "waiting" && after.waiting_for === "review"
            && LINE_ACCEPT[after.line] === "auto" && Number(after.human_gate) === 0) {
          try {
            closeGateOrThrow(after);
            const rr = store.resolve(db, { id, verdict: "approve", resolvedBy: "auto", disposition: "close",
                                           note: `线「${LINE_LABEL[after.line] || after.line}」配置 accept:auto —— 交付即完成(交付物闸照常检查过)` });
            emit("task.resolved", rr);
            console.log(`#${id} 线 ${after.line} accept:auto → 已完成`);
          } catch (e) {
            console.log(`#${id} 线 ${after.line} accept:auto 未能自动完成 —— 留在等待中给人:${String(e.message).split("\n")[0].slice(0, 120)}`);
          }
        }
        return json(res, 200, { task: store.get(db, id) });
      }
      if (action === "resolve") {
        resolveTask(id, b, boardRole);
        return json(res, 200, { task: taskOut(store.get(db, id)) });
      }
      if (action === "attempt") {
        // Self-retry round n: the card stays in_progress (not released); only
        // attempts advances.
        const r = store.bumpAttempt(db, { id, worker: b.worker, runId: b.run_id });
        emit("task.attempt", r);
        return json(res, 200, r);
      }
      if (action === "autoreview") {
        // expected_version is mandatory; the older timestamp check is retained
        // as an additional compatibility guard, never as a replacement.
        const r = store.markAutoReviewed(db, { id, note: b.note,
                                               decisionPackage: b.decision_package, expectedVersion:b.expected_version,
                                               expectUpdatedAt: b.expect_updated_at ?? null });
        emit("task.autoreviewed", r);
        return json(res, 200, r);
      }
      if (action === "update") {
        // prev_line is the provenance column stamped by line moves — direct writes
        // are refused (the single-assignment invariant, guarded API-side too).
        if (b.prev_line !== undefined || b.prevLine !== undefined)
          return json(res, 400, { error: "prev_line 是来历列,由移线自动盖章 —— 不可直写" });
        // Domain gate at the single mandatory pass (the store does not know
        // LINES/ROUTES — layers do not cross).
        if (badRoutable(res, b)) return;
        const r = store.update(db, { ...b, id, expectedVersion:b.expected_version });
        emit("task.updated", { id });
        return json(res, 200, { task: store.get(db, id), ...r });
      }
      if (action === "pin") {
        const r = store.setPinned(db, { id, expectedVersion:b.expected_version, pinned: b.pinned !== false });
        emit("task.pinned", r);
        return json(res, 200, { task: store.get(db, id) });
      }
      if (action === "release") {
        releaseTask(id, b);
        return json(res, 200, { task: taskOut(store.get(db, id)) });
      }
      if (action === "reopen") {
        // ⚠ This road used to sail through (store.reopen writes the given line
        //   verbatim) — gating only create and update still allowed ghost cards
        //   from here.
        if (badRoutable(res, b)) return;
        const r = store.reopen(db, { id, expectedVersion:b.expected_version, line: b.line });
        emit("task.reopened", r);
        return json(res, 200, { task: store.get(db, id), ...r });
      }
      if (action === "archive") {
        const r = store.archive(db, {
          id, expectedVersion:b.expected_version,
          restore: b.restore === true,
          force: b.force === true,
        });
        emit("task.archived", r);
        return json(res, 200, { task: store.get(db, id) });
      }
    }

    return json(res, 404, { error: "没有这个端点" });
  } catch (e) {
    const msg = String(e?.message || e);
    // Codes split by the TYPE the store attached (never by prose matching — a
    // one-character wording fix once degraded 409 to 400 with every check still
    // green). The mapping table is store.httpStatusFor, ONE place; the mapping AND
    // the declaration are unified in statusFor() above — calling the raw mapping
    // here would recreate "this road silently 400s".
    const conflict=conflictGuide.describeConflict(e);
    return json(res, statusFor(e, "兜底"), { error: msg, ...(conflict?{code:e.code,conflict}:{}), ...(Number.isSafeInteger(e?.current_version) ? {expected_version:e.expected_version,current_version:e.current_version} : {}) });
  }
});

// No authentication exists. Exposed on 0.0.0.0, anyone on the LAN can rewrite
// cards and drive the workers. Not a "be careful" thing — a non-loopback host
// REFUSES to start. The admonition is a gate.
if (!["127.0.0.1", "::1", "localhost"].includes(HOST)) {
  console.error(`拒绝启动:BOARD_HOST=${HOST} 不是回环地址。`);
  console.error("这个服务没有任何鉴权 —— 绑到非回环地址等于把任务队列的写权限交给整个网络。");
  console.error("确实要这么做的话,请先给写端点加上鉴权,再改这里的判断。");
  process.exit(1);
}

// Lease reaping never depends on claim traffic: even with every worker dead, the
// board converges to a correct state.
const REAP_MS = Number(process.env.BOARD_REAP_MS || 30000);
connect.watch(Number(process.env.BOARD_CONNECT_WATCH_MS || 10000));   // 在线/离线、working/stalled 变化 → executor.changed
setInterval(() => {
  try {
    const n = store.reapExpired(db);
    if (n) { console.log(`租约到期 ${n} 件 回收至未开始`); emit("task.reaped", { count: n }); }
    for (const h of coord.sweepStale(db, Date.now(), COORD_STALE_MS, COORD_GRACE_MS)) {
      console.log(`执行者 ${h.executor} 心跳中断,已生成交接记录 #${h.id}`);
      emit("coord.handoff", { id: h.id, executor: h.executor, reason: h.reason });
    }
    for (const l of coord.sweepOverdue(db, Date.now(), COORD_GRACE_MS)) {
      console.log(`协作锁逾期: ${l.resource}(持有者 ${l.holder},预计结束 ${l.expected_end})—— 不自动释放`);
      coord.appendJournal(db, "system", { kind: "lock.overdue", body: `${l.resource} 已逾期,持有者 ${l.holder}` });
      emit("coord.lock_overdue", { resource: l.resource, holder: l.holder, expected_end: l.expected_end });
    }
    // Complement pair — always swept in THIS order.
    const dr = store.deferToRearm(db);
    if (dr.length) { console.log(`子任务卡未齐 → 转入等待重审: #${dr.join(" #")}`); emit("task.deferred", { ids: dr }); }
    const ra = store.rearmDone(db);
    if (ra.length) { console.log(`子任务卡齐全 → 送回重审: #${ra.join(" #")}`); emit("task.rearmed", { ids: ra }); }
    const gc = store.completeGoals(db);
    if (gc.length) {
      const done = gc.filter((x) => x > 0), reop = gc.filter((x) => x < 0).map((x) => -x);
      if (done.length) console.log(`目标完成: #${done.join(" #")}`);
      if (reop.length) console.log(`目标重开(子任务卡有未完): #${reop.join(" #")}`);
      emit("goal.completed", { ids: gc });
    }
  } catch (e) { console.error("回收失败:", e.message); }
}, REAP_MS).unref?.();

// Pool patrol. Hold window and cadence are injectable for isolated tests;
// production defaults 5h / 5s.
try { savePools(); updateGlobalStopMarker("server-start"); }
catch (e) { console.error("池全局停止标记初始化失败:", e.message); }
setInterval(() => { void reconcilePools("timer"); }, POOL_RECONCILE_MS).unref?.();

// ⭐ EADDRINUSE used to be an uncaught stack trace. One line — and when this process is the
//   successor of a panel restart, give the predecessor a few seconds to let go of the port
//   instead of dying on the race.
let bindTries = 0;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && process.env.BOARD_RESTARTED_FROM && bindTries++ < 20)
    return void setTimeout(() => server.listen(PORT, HOST), 250);
  console.error(e.code === "EADDRINUSE" ? `端口 ${PORT} 已被占用 —— 是不是已经有一个看板在跑?` : `监听失败: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`看板 http://${HOST}:${PORT}  DB=${store.DB_PATH}`);
  if (process.env.BOARD_RESTARTED_FROM) {
    // Under a supervisor the env only says "supervised"; the previous process left the real
    // revision and trigger in <data>/restart_from (see restartBoard). Read once, then remove.
    let from = process.env.BOARD_RESTARTED_FROM, trig = process.env.BOARD_RESTART_TRIGGER || "panel";
    const rf = join(store.DATA_DIR, "restart_from");
    try { const [r0, t0] = readFileSync(rf, "utf8").trim().split(/\s+/); if (r0) from = r0; if (t0) trig = t0; unlinkSync(rf); } catch {}
    console.log(`↻ 由「更新」重启接手: ${from} → ${BOOT_REV}(${trig})`);
  }
  console.log(`状态四值: ${store.STATUS.join(" / ")}`);
  console.log(`配置: ${existsSync(CONFIG_FILE) ? CONFIG_FILE : "(内置缺省)"}  线=${LINES.map((l) =>
      l + (LINE_ROLE[l] ? `[${LINE_ROLE[l].kind}${LINE_ROLE[l].tools === "read-only" ? "·只读" : ""}${LINE_ROLE[l].charter ? "·章程" : ""}]` : "")).join(",")}  路由=${ROUTES.join(",")}`
    + (REVIEW_ANTI_AFFINITY ? `  审阅反亲和=${REVIEW_ANTI_AFFINITY}` : "")
    // A knob that silently does nothing is worse than no knob: say it out loud when set.
    + (LANGUAGE ? `  生成语言=${LANGUAGE}` : ""));
  console.log(HANDOFF_TARGETS.length
    ? `handoff 目标: ${HANDOFF_TARGETS.map((t) => `${t.id}→${t.dir}`).join("  ")}`
    : "未配置 handoff 目标 —— apply 方案归档将拒绝(声明 handoff_targets 或 BOARD_HANDOFF_DIR)");
  // ⭐ Trust boundary, said at startup (v0.17.0). Inside the work repo, the tokens and the
  //   registry are within a worker's reach. The Claude seat is fenced by the deny rules the
  //   loops pass (measured); the codex seat is not. Name the case, do not imply the other.
  {
    const inside = (p) => { const r = relative(REPO_ROOT, resolve(p)); return r !== "" && !r.startsWith("..") && !isAbsolutePath(r); };
    const reg = process.env.BOARD_VERIFY_REGISTRY || join(CODE_ROOT, "core", "verify_registry.json");
    const exposed = [store.DATA_DIR, reg].filter(inside);
    if (exposed.length)
      console.log(`⚠ 令牌目录 / 登记簿在工作仓之内(${exposed.map((x) => relative(REPO_ROOT, resolve(x))).join(", ")})—— Claude 座席由 deny 规则封住;codex 座席只有提示词纪律(见 SECURITY.md)`);
  }

  // ── Startup recovery inventory. After a machine dies, the first question is
  //    "what is left hanging" — answered NOW, not after the first 30s sweep
  //    (resuming work without noticing the crash is the dangerous part).
  try {
    const c = store.counts(db);
    const inflight = store.list(db, { status: "in_progress" }).tasks;
    const reaped = store.reapExpired(db);
    const still = store.list(db, { status: "in_progress" }).tasks;
    console.log(`盘点: 未开始 ${c.not_started} / 进行中 ${inflight.length} / 等待中 ${c.waiting} / 已完成 ${c.done}`);
    if (reaped) {
      console.log(`  ⚠ 租约已过期的 ${reaped} 件回收至未开始(worker 在上次运行中失联):`);
      for (const t of inflight.filter((t) => !still.some((s) => s.id === t.id)))
        console.log(`     #${t.id} [${t.worker}] ${t.subject.slice(0, 46)}`);
    }
    if (still.length) {
      console.log(`  租约仍在有效期内的 ${still.length} 件保持进行中(可能是别处还活着的 worker):`);
      for (const t of still) {
        const left = Math.round(((t.lease_until || 0) - Date.now()) / 1000);
        console.log(`     #${t.id} [${t.worker}] 租约还剩 ${left}s — ${t.subject.slice(0, 40)}`);
      }
      console.log("     若机器刚重启过,这些 worker 其实已经死了,等租约到期会自动回收。");
    }
    // Undelivered evidence files = "produced, then died before reporting". Kept and
    // announced, never deleted.
    const evDir = join(store.DATA_DIR, "evidence");
    const orphanEv = existsSync(evDir) ? readdirSync(evDir).filter((f) => f.startsWith("task-")) : [];
    if (orphanEv.length)
      console.log(`  未交回的证据文件 ${orphanEv.length} 个还在 .data/evidence/(上次可能产出后没来得及报告)`);
    const dr = store.deferToRearm(db);
    if (dr.length) console.log(`  子任务卡未齐、却排在确认队列的父卡 → 转入等待重审: #${dr.join(" #")}`);
    const ra = store.rearmDone(db);
    if (ra.length) console.log(`  子任务卡已齐、仍在等待人工的父卡 → 送回重审: #${ra.join(" #")}`);
    const gc = store.completeGoals(db);
    if (gc.length) console.log(`  目标状态收敛: ${gc.map((x) => x > 0 ? "#" + x + " 完成" : "#" + (-x) + " 重开").join(" ")}`);
    flow.syncAll();   // 建卡对话的进度消息按库重算(重启不丢、不重复)
  } catch (e) { console.error("启动盘点失败:", e.message); }

  // ⭐ Deliverable-gate coverage (v0.16.1). assertCoverage has existed since the gate was
  //   written and nothing ever called it — the loud "green while blind" warning was dead
  //   code (external audit). Sample the most recent closed cards' evidence: if the
  //   extractor pulls zero paths out of ALL of them, this repo's layout is not covered and
  //   the gate would pass everything. Say so here, where the operator is looking.
  try {
    if (extractor) {
      const samples = store.list(db, { status: "done" }).tasks.slice(-20).map((t) => t.result).filter(Boolean);
      const cov = dgate.assertCoverage(extractor, samples);
      if (cov.warning) console.error(`⚠ ${cov.warning}`);
      else if (cov.sampled) console.log(`交付物闸覆盖检查:最近 ${cov.sampled} 张已完成卡的证据里都能提出仓内路径`);
    }
  } catch (e) { console.error("交付物闸覆盖检查失败:", e.message); }

  // ── Intent restoration. Returning cards without returning lines silently halts
  //    the processing chain on every dev restart (measured; hours unnoticed).
  //    ⚠ The goal is "never silently stopped" — NOT restoring also states its reason.
  const cfgLineage = Object.keys(LINEAGE);
  console.log(cfgLineage.length
    ? `记忆继承的配置: ${cfgLineage.join(" ")}(未继承的线在初次启动时 fork)`
    : `无记忆继承配置 —— 各线以全新身份开始(参见 examples/lineage.example.json)`);

  // A maintenance restart (reloading new code) must not revive anything — measured:
  // the deadline exit deliberately keeps intent, and a code-reload restart picked
  // up LAST NIGHT's intent and pulled every line up inside the operator's "I am not
  // starting anything" window. The flag skips revival only; intent is kept for the
  // next normal start.
  if (process.env.BOARD_NO_RESTORE) {
    console.log("BOARD_NO_RESTORE=1 —— 维护重启,不复活任何线(意图保留)");
  } else {
  const want = SUPERVISED.filter((l) => settingsOf(l).desired_running && !LINE_EXTERNAL?.[l]);
  if (!want.length) console.log("自动拉取: 停止中(上次是手动停的,或还没启动过)");
  else {
    console.log(`恢复自动拉取: ${want.join(" ")}`);
    for (const l of want) {
      try { workerStart(l); console.log(`  ${l} 启动`); }
      catch (e) { console.error(`  ${l} 恢复失败: ${e.message}`); }
    }
  }
  }
  schedulePoolReconcile("server-start");
  startRemote();
});

// Taking the board down takes its workers with it — left behind, unattended models
// keep running.
let shuttingDown = false;
async function stopWithBoard(trigger) {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopFleetActions();
  await stopCoordinatorRuns();
  const live = SUPERVISED.filter((l) => slotsOf(l).some((w) => w.proc));
  if (live.length) {
    console.log(`退出(${trigger}): 正在停止 worker ${live.join(" ")}(意图保留)…`);
    // keepIntent — a board restart should come back as it was; this is not a human stop.
    for (const l of live) {
      try { await workerStop(l, { keepIntent: true, reason: STOP_REASON.WITH_BOARD }); } catch {}
    }
  }
  flushRemoteAudit();   // 远程入口当前窗口的拒绝计数,退出前落库(restartBoard 走 closeRemote)
  // Orderly from here on: the wrapper reads this marker, not the exit code (core/board-run.mjs).
  try { noteCleanExit(store.DATA_DIR, { kind: "stop" }); } catch {}
  process.exit(0);
}
/** The panel's 「更新」/「重启看板」 (v0.18). Same shutdown as stopWithBoard — lines stopped with
 *  their intent kept, so the successor restores them — then either exit 75 for an outer
 *  supervisor or start the successor ourselves (RESTART_MODE). */
async function restartBoard(trigger) {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopFleetActions();
  await stopCoordinatorRuns();
  const live = SUPERVISED.filter((l) => slotsOf(l).some((w) => w.proc));
  if (live.length) {
    console.log(`重启(${trigger}): 先停 worker ${live.join(" ")}(意图保留,新进程起来后照原样恢复)…`);
    for (const l of live) {
      try { await workerStop(l, { keepIntent: true, reason: STOP_REASON.WITH_BOARD }); } catch {}
    }
  }
  emit("board.restarting", { trigger, mode: RESTART_MODE, from: BOOT_REV, to: codeRev(),
                             log_path: RESTART_MODE === "respawn" ? join(store.DATA_DIR, "board.log") : null });
  await new Promise((r) => setTimeout(r, 150));   // let that event and the 202 leave the socket
  for (const c of clients) { try { c.end(); } catch {} }   // open SSE streams would hold close() forever
  await closeRemote();
  await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
  try { noteCleanExit(store.DATA_DIR, { kind: "restart" }); } catch {}
  if (RESTART_MODE === "exit") {
    // The supervisor cannot know which revision this process ran (it only sees exit 75); leave
    // it in the data dir on the way out so the successor's boot line reads "old → new" (v0.20).
    try { writeFileSync(join(store.DATA_DIR, "restart_from"), `${BOOT_REV || "?"} ${trigger}\n`, "utf8"); } catch {}
    console.log(`重启(${trigger}): 以 exit 75 退出,交给外层(npm start 守护 / pm2 / systemd)在原地重起`);
    process.exit(75);
  }
  // Bare `node core/server.mjs`: nobody outside will restart us, so start the successor here.
  // Detached (see RESTART_MODE) — which means it has left this console: its output goes to a
  // file, and this line says which one.
  const logPath = join(store.DATA_DIR, "board.log");
  let logFd = "ignore";
  try { logFd = openSync(logPath, "a", 0o600); /* same mode as the tokens next to it */ } catch (e) { console.error(`打不开 ${logPath}(${e.message})—— 新进程的日志将丢弃`); }
  // Keys this process only backfilled from its config must not reach the successor as env —
  // env wins, so an edited config would be ignored after the very restart meant to read it.
  const env = { ...process.env, BOARD_RESTARTED_FROM: BOOT_REV || "?", BOARD_RESTART_TRIGGER: trigger };
  for (const k of BACKFILLED) delete env[k];
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    cwd: process.cwd(), detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true, env,
  });
  child.once("spawn", () => {
    child.unref();
    console.log(`重启(${trigger}): 新进程 pid ${child.pid} 接手 ${HOST}:${PORT},本进程退出。`
      + `它已脱离本终端:日志在 ${logPath};要停它用面板或 kill ${child.pid}(想让日志留在终端、Ctrl+C 照旧,用 npm start 起板)`);
    process.exit(0);
  });
  child.once("error", (e) => {
    console.error(`重启(${trigger}): 起不了新进程(${e.message})—— 本进程已停止服务,请手动重新执行原来的启动命令`);
    process.exit(1);
  });
}
// ⭐ A named function, not a body inlined in the handler, because an external SIGTERM
//   on Windows is TerminateProcess: the handler below never runs, so this path could
//   not be measured at all. Tests trigger the same path from inside the process.
const testShutdownMs = Number(process.env.BOARD_TEST_SHUTDOWN_MS || 0);
if (testShutdownMs > 0) setTimeout(() => { void stopWithBoard("test-timer"); }, testShutdownMs).unref?.();
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { void stopWithBoard(sig); });
}
