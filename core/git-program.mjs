// git-program — the ONE place the Node side resolves which Git program the host runs
// (the Python side is core/git_program.py; same rules, kept in step by hostcommittest).
//
// Why not launch "git" by name: Node's spawn/execFile look in the process's CURRENT
// DIRECTORY before PATH on Windows. When the board repo is the work repo, or sits inside
// it, that directory is inside the model's write allowance — a git.exe dropped there would
// be run by the host.
//
// Rules (resolve once per process, then always spawn the absolute path):
//   1. host configuration first: env WORKER_HOST_GIT, or fleet.config `host_git`; it must
//      be an absolute path.
//   2. otherwise search ONLY the absolute directories of PATH; empty and relative entries
//      mean "the current directory" and are skipped.
//   3. a .bat/.cmd result (its arguments would be re-parsed by cmd.exe), or a program
//      inside the work repo / data directory, is refused.
//   4. children get NoDefaultCurrentDirectoryInExePath=1, so Git's own child lookups skip
//      the current directory as well.
// Resolution never throws: callers get { path } or { path: null, reason } and treat a
// missing program the way they already treat "git is not installed".
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

const WIN = process.platform === "win32";
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };

export const isBatch = (p) => [".bat", ".cmd"].includes(extname(String(p || "")).toLowerCase());

/** Is `child` at or under `parent`? Compared on the literal AND the resolved path. */
export function within(child, parent) {
  for (const c of new Set([resolve(child), real(child)]))
    for (const p of new Set([resolve(parent), real(parent)])) {
      const r = relative(p, c);
      if (r === "" || (!r.startsWith("..") && !isAbsolute(r))) return true;
    }
  return false;
}

const envValue = (env, name) => {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? "" : String(env[key] ?? "");
};

/** First `git` in the ABSOLUTE directories of PATH (never the current directory). */
export function searchPath(name, env = process.env) {
  const names = WIN
    ? (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => name + ext)
    : [name];
  for (const raw of envValue(env, "PATH").split(delimiter)) {
    const dir = raw.trim().replace(/^"|"$/g, "");
    if (!dir || !isAbsolute(dir) || (WIN && !/^(?:[A-Za-z]:|\\\\)/.test(dir))) continue;
    for (const candidate of names) {
      const target = join(dir, candidate);
      if (isFile(target)) return target;
    }
  }
  return null;
}

const refusal = (program, roots) => {
  if (isBatch(program))
    return `Git 程序是 .bat/.cmd 包装器,参数会经 cmd.exe 解释;请把 WORKER_HOST_GIT(或 fleet.config 的 host_git)设为 git 可执行文件的绝对路径:${program}`;
  for (const root of roots)
    if (root && within(program, root))
      return `Git 程序位于工作仓或数据目录内,模型可以改写它;请改用其外的 Git:${program}`;
  return null;
};

/** { path } on success, { path: null, reason } otherwise. `roots` = work repo, data dir. */
export function resolveGit({ env = process.env, roots = [], configured } = {}) {
  let found;
  if (configured) {
    if (!isAbsolute(String(configured))) return { path: null, reason: `配置的 Git 程序必须是绝对路径:${configured}` };
    found = String(configured);
  } else {
    found = searchPath("git", env);
    if (!found)
      return { path: null, reason: "PATH 的绝对目录里找不到 Git 程序;请安装 Git,或把 WORKER_HOST_GIT(或 fleet.config 的 host_git)设为 git 可执行文件的绝对路径" };
  }
  let why = refusal(found, roots);
  if (why) return { path: null, reason: why };
  let program = real(found);
  if (WIN && basename(dirname(program)).toLowerCase() === "cmd") {
    // Git for Windows: PATH usually carries cmd\git.exe; pin bin\git.exe of the same install.
    const sibling = join(dirname(dirname(program)), "bin", "git.exe");
    if (isFile(sibling)) program = real(sibling);
  }
  why = refusal(program, roots);
  if (why) return { path: null, reason: why };
  if (!isFile(program)) return { path: null, reason: `Git 实际程序不可用:${program}` };
  return { path: program };
}

/** A copy of `env` for Git children, with NoDefaultCurrentDirectoryInExePath=1. */
export function gitEnvironment(env = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(env))
    if (key.toUpperCase() !== "NODEFAULTCURRENTDIRECTORYINEXEPATH" && value !== undefined) result[key] = value;
  result.NoDefaultCurrentDirectoryInExePath = "1";
  return result;
}

/** `git(args, options)` — execFileSync on the resolved absolute path. Throws a plain
 *  GIT_UNAVAILABLE error when nothing safe was resolved, so existing catch blocks
 *  ("no git / not a repo") keep handling it. */
export function gitRunner(resolved) {
  return (args, options = {}) => {
    if (!resolved?.path) {
      const error = new Error("GIT_UNAVAILABLE: " + (resolved?.reason || "Git 程序未解析"));
      error.code = "GIT_UNAVAILABLE";
      throw error;
    }
    return execFileSync(resolved.path, args, { windowsHide: true, ...options, env: gitEnvironment(options.env || process.env) });
  };
}
