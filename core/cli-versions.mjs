// 执行器 CLI 版本巡检：看板实际调用的 Claude CLI（原生可执行文件）与 Codex CLI（BOARD_CODEX_CMD）的
// 本机版本、npm 上的最新版本、本部署实测过的版本。只运行 `<cli> --version`，不调用模型。
//
// 最新版本向 npm registry 查询，一天一次，结果缓存在 <data>/probes/cli_versions.json。离线或超时记
// 「未能查询」，不报错，一小时后再试。可配置：fleet.config.json 的 cli_versions.check_hours 与
// cli_versions.registry，或环境变量 BOARD_CLI_VERSION_CHECK_HOURS 与 BOARD_CLI_VERSION_REGISTRY（环境变量优先）；
// check_hours 为 0 时不联网。
//
// 「实测过的版本」清单在 <data>/probes/cli_tested.json，由 recordTestedVersion 写入：读写边界探针
// （tests/cli-boundary-probe.mjs）通过后记 boundary-probe，doctor 通过后记 doctor（只核对了参数）。
// 两个文件都在 probes 子目录：执行线的拒绝规则已覆盖它（loops/verify_lib.py 的 PROTECTED 含 probes/**），
// 模型改不了这份清单。文件内容读取时逐项校验，不合格的条目丢弃。
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { detectClaude, findOnPath } from "./config-setup.mjs";
import { loadConfig } from "./env.mjs";
import { shortTime } from "./board-run.mjs";

export const CLIS = Object.freeze([
  Object.freeze({ id: "claude", name: "Claude CLI", package: "@anthropic-ai/claude-code" }),
  Object.freeze({ id: "codex", name: "Codex CLI", package: "@openai/codex" }),
]);
const DEFAULT_REGISTRY = "https://registry.npmjs.org", HOUR = 3600 * 1000;
const SEMVER = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?/;
const SOURCES = ["boundary-probe", "doctor"];
const iso = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

/** 文本里的第一个版本号，例如 `2.1.300 (Claude Code)`、`codex-cli 0.46.0`；没有返回 null。 */
export function parseVersion(text) {
  const m = SEMVER.exec(String(text ?? ""));
  return m ? m[0] : null;
}
/** 整串就是一个版本号才算数（来自缓存文件、命令行参数的值用它核）。 */
export const isVersion = (v) => typeof v === "string" && new RegExp("^" + SEMVER.source + "$").test(v);

/** -1 / 0 / 1；任一侧不是版本号返回 null。带预发布后缀的版本低于同号正式版。 */
export function compareVersions(a, b) {
  if (!isVersion(a) || !isVersion(b)) return null;
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  if (x[4] === y[4]) return 0;
  if (!x[4] || !y[4]) return x[4] ? -1 : 1;
  return x[4] < y[4] ? -1 : 1;
}

/** 看板会调用的那个 CLI 文件。state: found · not_found · wrapper（只有包装器，没有原生文件）· not_configured。 */
export function locateCli(id, env = process.env) {
  const win = process.platform === "win32";
  if (id === "codex") {
    const p = env.BOARD_CODEX_CMD;
    if (!p) return { state: "not_configured", path: null };
    if (!isAbsolute(p) || !existsSync(p)) return { state: "not_found", path: null };
    return /\.(cmd|bat|ps1)$/i.test(p) ? { state: "wrapper", path: null } : { state: "found", path: p };
  }
  let target = null;
  try { target = detectClaude(env); } catch {}
  if (target && !isAbsolute(target)) target = findOnPath(target, { env });
  if (!target || !existsSync(target)) return { state: "not_found", path: null };
  if (!win || /\.exe$/i.test(target)) return { state: "found", path: target };
  // npm 的包装器旁边的原生文件，执行线与 doctor 用的是同一个落点。
  const native = join(dirname(target), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return existsSync(native) ? { state: "found", path: native } : { state: "wrapper", path: null };
}

/** 这个文件是不是 npm 全局安装的那个包里的（升级命令只处理这种）。 */
export function npmManaged(id, path) {
  const pkg = CLIS.find((c) => c.id === id)?.package;
  if (!pkg || typeof path !== "string") return false;
  return path.replace(/\\/g, "/").toLowerCase().includes("/node_modules/" + pkg.toLowerCase() + "/");
}

const seen = new Map();   // path|mtime|size → version：同一个文件只问一次
/** 运行 `<cli> --version` 取版本号；读不出返回 null。 */
export async function localVersion(path, { run = runVersion } = {}) {
  let key = path;
  try { const st = statSync(path); key = `${path}|${st.mtimeMs}|${st.size}`; } catch { return null; }
  if (run === runVersion && seen.has(key)) return seen.get(key);
  let version = null;
  try { version = parseVersion(await run(path)); } catch {}
  if (run === runVersion && version) seen.set(key, version);
  return version;
}
function runVersion(path) {
  return new Promise((resolve, reject) => {
    execFile(path, ["--version"], { cwd: dirname(path), encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 65536 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/** 查询间隔（小时）与 registry。环境变量优先，其次配置文件，最后默认一天、npm 官方 registry。 */
export function versionSettings({ env = process.env, config = null } = {}) {
  const cfg = (config ?? loadConfig())?.cli_versions || {};
  const hours = [env.BOARD_CLI_VERSION_CHECK_HOURS, cfg.check_hours].map((v) => (v === "" || v == null ? NaN : Number(v))).find((n) => Number.isFinite(n) && n >= 0);
  const registry = [env.BOARD_CLI_VERSION_REGISTRY, cfg.registry].find((v) => typeof v === "string" && /^https?:\/\/[^\s]+$/.test(v));
  return { checkHours: hours ?? 24, registry: (registry || DEFAULT_REGISTRY).replace(/\/+$/, "") };
}

/** npm registry 上这个包的最新版本。失败抛错，由调用方记成「未能查询」。 */
export async function fetchLatest(pkg, { registry = DEFAULT_REGISTRY, timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${registry}/${pkg.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`registry HTTP ${r.status}`);
  const version = (await r.json())?.version;
  if (!isVersion(version)) throw new Error("registry 没有给出版本号");
  return version;
}

const cacheFile = (dataDir) => join(dataDir, "probes", "cli_versions.json");
const testedFile = (dataDir) => join(dataDir, "probes", "cli_tested.json");
function readJSON(file) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }
function writeJSON(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(value, null, 1) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(file + ".tmp", file);
}
function readCache(dataDir) {
  const raw = readJSON(cacheFile(dataDir))?.latest, out = {};
  for (const { id } of CLIS) {
    const e = raw?.[id];
    if (e && iso(e.checked_at) && ["ok", "unavailable"].includes(e.state))
      out[id] = { state: e.state, checked_at: iso(e.checked_at), latest: isVersion(e.latest) ? e.latest : null, ok_at: iso(e.ok_at) };
  }
  return out;
}

/** 本部署实测过的版本清单。 */
export function readTestedVersions(dataDir) {
  const raw = readJSON(testedFile(dataDir))?.tested;
  return (Array.isArray(raw) ? raw : []).filter((t) => t && CLIS.some((c) => c.id === t.cli) && isVersion(t.version)
    && SOURCES.includes(t.source) && iso(t.at) && typeof t.platform === "string")
    .map((t) => ({ cli: t.cli, version: t.version, platform: t.platform, source: t.source, at: iso(t.at) }));
}
/** 记一笔「这个版本测过了」。source: boundary-probe 读写边界探针通过 · doctor 体检通过（只核对了参数）。同一条重复记只更新时间。 */
export function recordTestedVersion(dataDir, { cli, version, source, at = new Date().toISOString(), platform = process.platform }) {
  if (!CLIS.some((c) => c.id === cli) || !isVersion(version) || !SOURCES.includes(source) || !iso(at)) throw new Error("实测记录的内容不合格");
  const same = (t) => t.cli === cli && t.version === version && t.platform === platform && t.source === source;
  const tested = [...readTestedVersions(dataDir).filter((t) => !same(t)), { cli, version, platform, source, at: iso(at) }];
  writeJSON(testedFile(dataDir), { format: "ai-collab-cli-tested/v1", tested });
  return tested;
}
/** state: boundary 读写边界已实测 · contract 只核对过参数 · none 未实测。 */
export function testedState(list, cli, version, platform = process.platform) {
  const hits = list.filter((t) => t.cli === cli && t.version === version && t.platform === platform);
  const hit = hits.find((t) => t.source === "boundary-probe") || hits.find((t) => t.source === "doctor");
  return hit ? { state: hit.source === "boundary-probe" ? "boundary" : "contract", at: hit.at } : { state: "none", at: null };
}

/** 两个 CLI 的「当前 / 最新 / 上次核对 / 是否实测过」。network: never 只读缓存 · stale 缓存过期才查 · force 立即查。
 *  write:false 时不写缓存（doctor 只读）。任何一步失败都落在字段里，不抛错。 */
export async function readCliVersions({ dataDir, env = process.env, now = Date.now(), network = "stale", settings = null, write = true,
                                        fetchImpl = fetch, run = undefined, locate = locateCli, timeoutMs = 5000 } = {}) {
  const { checkHours, registry } = settings || versionSettings({ env });
  const cache = readCache(dataDir), tested = readTestedVersions(dataDir);
  let changed = false;
  const clis = await Promise.all(CLIS.map(async (cli) => {
    const where = locate(cli.id, env);
    const current = where.path ? await localVersion(where.path, run ? { run } : {}) : null;
    let entry = cache[cli.id] || null;
    const age = entry ? now - Date.parse(entry.checked_at) : Infinity;
    const due = network === "force" || (network === "stale" && checkHours > 0 && age >= (entry?.state === "ok" ? checkHours : Math.min(checkHours, 1)) * HOUR);
    if (due && where.state !== "not_configured") {
      const at = new Date(now).toISOString();
      try { entry = { state: "ok", checked_at: at, latest: await fetchLatest(cli.package, { registry, timeoutMs, fetchImpl }), ok_at: at }; }
      catch { entry = { state: "unavailable", checked_at: at, latest: entry?.latest ?? null, ok_at: entry?.ok_at ?? null }; }
      cache[cli.id] = entry; changed = true;
    }
    const cmp = entry?.latest && current ? compareVersions(current, entry.latest) : null;
    // 安装来源只按找到的那个文件判:在 npm 包里 = npm-global,在别处 = native,没找到 = unknown。升级命令只给 npm 安装的。
    const npm = npmManaged(cli.id, where.path);
    const source = where.state === "found" && where.path ? (npm ? "npm-global" : "native") : "unknown";
    return { id: cli.id, name: cli.name, package: cli.package, state: where.state, path: where.path, current,
             install_source: source, npm_managed: npm, upgrade_hint: source === "npm-global" ? `npm install -g ${cli.package}@latest` : null,
             latest: entry?.latest ?? null, latest_state: entry ? entry.state : "not_checked", latest_checked_at: entry?.checked_at ?? null,
             latest_ok_at: entry?.ok_at ?? null, update_available: cmp == null ? null : cmp < 0,
             tested: current ? testedState(tested, cli.id, current) : { state: "none", at: null } };
  }));
  if (changed && write) try { writeJSON(cacheFile(dataDir), { format: "ai-collab-cli-versions-cache/v1", latest: cache }); } catch {}
  return { format: "ai-collab-cli-versions/v1", checked_at: new Date(now).toISOString(), check_hours: checkHours, clis };
}

/** 给人看的一行：当前 / 最新 / 上次核对 / 是否实测过。没有配置的 CLI 返回 null（不显示）。
 *  说法与面板（core/panel.html 的 cliVersionCells）相同；找不到或读不出版本时带下一步。 */
export function versionLine(c) {
  if (!c || c.state === "not_configured") return null;
  const doctor = "下一步:运行 node cli/doctor.mjs 查看原因";
  if (c.state !== "found") return `${c.name} 没有找到可以直接启动的 CLI 程序。${doctor}`;
  if (!c.current) return `${c.name} 版本读不出。${doctor}`;
  const latest = c.latest_state === "ok" ? c.latest + (c.update_available ? "，可升级" : "")
    : c.latest_state === "unavailable" ? "未能查询" + (c.latest ? `，上次查到 ${c.latest}` : "") : "未查询";
  const tested = c.tested?.state === "boundary" ? "已实测" : c.tested?.state === "contract" ? "参数已核对，读写权限范围未实测" : "未实测";
  return `${c.name} 当前 ${c.current} · 最新 ${latest} · 上次核对 ${c.latest_checked_at ? shortTime(c.latest_checked_at) : "无"} · ${tested}`;
}
