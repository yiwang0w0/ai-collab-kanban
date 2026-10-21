"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, realpathSync, statSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join, resolve, relative, isAbsolute } = require("node:path");
const dgate = require("./deliverable_gate.js");

const digest = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const RULES_VERSION = digest([__filename, join(__dirname, "deliverable_gate.js"), join(__dirname, "../cli/check-delivery.mjs")].map(path => readFileSync(path, "utf8")).join("\n"));

function createDeliveryGate({ repoRoot, gateOff = false, cacheMs = 10000, log = console } = {}) {
  const REPO_ROOT = resolve(repoRoot);
  const GATE_OFF = gateOff;
  const console = log;
let extractor = null;
try {
  const top = execFileSync("git", ["-C", REPO_ROOT, "--no-lazy-fetch", "ls-tree", "-z", "HEAD"],
                           { maxBuffer: 8 * 1024 * 1024, timeout: 5000, windowsHide: true }).toString("utf8");
  const prefixes = dgate.topLevelPrefixes(top);
  if (prefixes.length) extractor = dgate.makeExtractor({ prefixes });
  else console.error("⚠ 交付物闸不可测:HEAD 没有顶层条目(空仓?)" +
    (GATE_OFF ? "—— 已显式关闭,结案不做入库核对" : "—— 结案将被拒绝(fail-closed);确属无 git 部署请显式 BOARD_DELIVERABLE_GATE=off"));
} catch (e) {
  console.error(`⚠ 交付物闸不可测:读不到宿主仓 HEAD(${e.message})` +
    (GATE_OFF ? "—— 已显式关闭,结案不做入库核对" : "—— 结案将被拒绝(fail-closed);确属无 git 部署请显式 BOARD_DELIVERABLE_GATE=off"));
}
let _headCache = { at: 0, set: null };
const headFiles = () => {
  if (_headCache.set && Date.now() - _headCache.at < cacheMs) return _headCache.set;
  let set = null;
  try {
    // ⚠ -z mandatory (same reason as above).
    const out = execFileSync("git", ["-C", REPO_ROOT, "--no-lazy-fetch", "ls-tree", "-r", "--name-only", "-z", "HEAD"],
                             { maxBuffer: 64 * 1024 * 1024, timeout: 5000, windowsHide: true });
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
    out = execFileSync("git", ["-C", REPO_ROOT, "--no-lazy-fetch", "status", "--porcelain", "-z"],
                       { maxBuffer: 64 * 1024 * 1024, timeout: 5000, windowsHide: true }).toString("utf8");
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
  return { get extractor() { return extractor; }, uncommittedOf, absentOf, unnamedOf, dirtyFiles, headFiles };
}

function assertDelivery(t, gate, refuse = (message) => { throw new Error(message); }) {
    const { uncommittedOf, absentOf, unnamedOf } = gate;
    const left = uncommittedOf(t);
    // null = the gate could not measure. Refusing here is the point:
    // "unmeasurable ⇒ pass" would make every git hiccup a free close.
    if (left === null)
      refuse(
        `通过被拦: 交付物闸不可测(读不到宿主仓 HEAD/git)—— 不可测不等于没有违规。` +
        `\n  修复 git 环境后重试;确属无 git 部署,用 BOARD_DELIVERABLE_GATE=off 显式关闸(每次通过都会记录);` +
        `\n  或对这一张卡人工担责:resolve 带 allow_uncommitted:true 并在裁定里写明理由。`);
    if (left.length)
      refuse(
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
      refuse(
        `通过被拦: 证据点名了 ${ab.named} 个交付物,但**一个都不存在**(工作树里没有,HEAD 里也没有)—— 声称的交付没有实物。` +
        `\n  ${ab.absent.join("\n  ")}` +
        `\n  ⚠若这些只是引用别处的路径而不是本卡的交付,在 resolve 时带 allow_uncommitted:true 并写明。`);
    // The reverse blind spot: "touched but never named". Attribution is by
    // TIME (work_spans) — on a shared work tree, "is the tree dirty" cannot
    // attribute.
    const unnamed = unnamedOf(t);
    if (unnamed === null)
      refuse(
        `通过被拦: 交付物闸不可测(读不到 git status)—— 不可测不等于没有违规。` +
        `\n  修复 git 环境后重试;或 resolve 带 allow_uncommitted:true 人工担责并写明理由。`);
    if (unnamed.length)
      refuse(
        `通过被拦: 本卡作业区间内有 ${unnamed.length} 个文件被改动却**未入库、且证据里一个都没点名**` +
        ` —— 纯文字描述不算交付。先 commit(或在证据里点名并说明为何不入库)再通过。` +
        `\n  ${unnamed.join("\n  ")}` +
        `\n  ⚠若这些改动不属于本卡(共享工作树上别的线在途),在 resolve 时带 allow_uncommitted:true 并写明归属。`);
}

function git(repoRoot, ...args) {
  return execFileSync("git", ["-C", repoRoot, "--no-lazy-fetch", ...args], {
    encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fileRecord(root, path) {
  const absolute = resolve(root, path), rel = relative(root, absolute);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + require("node:path").sep))
    throw new Error("交付物路径超出工作区");
  if (!existsSync(absolute)) return { path, sha256: null };
  const actual = realpathSync(absolute), actualRel = relative(root, actual);
  if (isAbsolute(actualRel) || actualRel === ".." || actualRel.startsWith(".." + require("node:path").sep))
    throw new Error("交付物链接指向工作区之外");
  const info = statSync(actual);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("交付物不是可检查的常规文件");
  return { path, sha256: digest(readFileSync(actual)) };
}

function dirtyPaths(status) {
  const out = [], records = status.split("\0");
  for (let i = 0; i < records.length; i++) {
    const match = /^(..) (.+)$/s.exec(records[i]);
    if (!match) continue;
    out.push(match[2]);
    if (/[RC]/.test(match[1])) i++;
  }
  return out;
}

function candidate(root, paths) {
  const head = git(root, "rev-parse", "--verify", "HEAD").trim();
  const status = git(root, "status", "--porcelain", "-z");
  const artifacts = paths.map(path => fileRecord(root, path));
  const dirty = [...new Set(dirtyPaths(status))].sort().map(path => fileRecord(root, path));
  return { head, artifacts, worktree_clean: status.length === 0, fingerprint: digest(JSON.stringify({ head, artifacts, status, dirty })) };
}

// 路径来自操作员配置，分支来自宿主动作上下文；不接受浏览器指定工作目录。
function resolveWorktree(repoRoot, headBranch) {
  if (typeof headBranch !== "string" || !headBranch || headBranch.startsWith("-") || /[\x00-\x20]/.test(headBranch))
    throw new Error("分支无效");
  const ref = headBranch.startsWith("refs/heads/") ? headBranch : "refs/heads/" + headBranch;
  const matches = git(repoRoot, "worktree", "list", "--porcelain", "-z").split("\0\0").filter(Boolean).map(record => {
    const fields = record.split("\0");
    return { path: fields.find(x => x.startsWith("worktree "))?.slice(9), branch: fields.find(x => x.startsWith("branch "))?.slice(7) };
  }).filter(record => record.branch === ref && record.path);
  if (matches.length !== 1) throw new Error("分支未唯一对应到本地工作区");
  const root = realpathSync(matches[0].path);
  if (git(root, "symbolic-ref", "HEAD").trim() !== ref) throw new Error("工作区分支发生变化");
  return root;
}

// 每次完成检查都重新读取 Git 和文件；旧回执不能因十秒缓存而继续通过。
function checkDelivery(task, { repoRoot } = {}) {
  try {
    if (!task || typeof task.result !== "string" || !task.result.trim() || typeof repoRoot !== "string")
      throw new Error("缺少交付证据或工作区");
    const root = realpathSync(resolve(repoRoot));
    const gate = createDeliveryGate({ repoRoot: root, cacheMs: 0, log: { error() {}, log() {} } });
    if (!gate.extractor || gate.headFiles() === null || gate.dirtyFiles() === null)
      throw new Error("无法读取 Git");
    const paths = gate.extractor.extractPaths(task.result).sort();
    const before = candidate(root, paths);
    const violations = [];
    if (!before.worktree_clean) violations.push({ code: "uncommitted", message: "工作区仍有未提交变更；单任务试点需先提交再验收。" });
    if (!before.artifacts.some(item => item.sha256)) violations.push({ code: "no_artifact", message: "请在交付说明中点名至少一个可检查的实际产物。" });
    assertDelivery(task, gate, message => {
      const code = message.includes("作业区间") ? "unnamed" : message.includes("一个都不存在") ? "absent" : message.includes("不可测") ? "unmeasurable" : "uncommitted";
      violations.push({ code, message });
    });
    const after = candidate(root, paths);
    if (before.fingerprint !== after.fingerprint) throw new Error("检查期间工作区发生变化");
    return { format: "ai-fleet-delivery-check/v1", status: violations.some(v => v.code === "unmeasurable") ? "unmeasurable" : violations.length ? "fail" : "pass",
      ...after, rules_version: RULES_VERSION, violations };
  } catch {
    return { format: "ai-fleet-delivery-check/v1", status: "unmeasurable", rules_version: RULES_VERSION,
      violations: [{ code: "unmeasurable", message: "交付检查不可测，请核对仓库、文件权限与 Git 环境。" }] };
  }
}

module.exports = { createDeliveryGate, assertDelivery, checkDelivery, resolveWorktree, RULES_VERSION };
