// `node cli/upgrade-cli.mjs <claude|codex> [--to <版本>] [--yes]` — 升级看板调用的执行器 CLI。
//
// 默认干跑：只列出会做什么，什么都不改。加 --yes 才执行：
//   核对（体检现在通过、没有任务正在执行）→ 停下用这个 CLI 的执行线 → npm 全局安装指定版本
//   → 核对版本 → 体检 → 恢复执行线。
// 安装、版本核对、体检任何一步不过：装回原版本，再恢复执行线。装回也不成功时执行线保持停止，并给出手动命令。
// 不打断正在执行的任务，不重派任务，不调用模型。只处理 npm 全局安装的 CLI。
//   退出码：0 完成、已是目标版本或干跑 · 1 没有改动任何东西 · 2 升级失败，已回到原版本
//           · 3 装回原版本失败，执行线保持停止 · 4 CLI 已升级，有执行线没有恢复
//
// 流程写成 upgradeCli(deps)：tests/upgradeclitest.mjs 用假的 npm、假的 CLI、假的看板跑它，不真装任何东西。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyConfigDefaults, CODE_ROOT } from "../core/env.mjs";
import { boardUp, localBoard } from "../core/local-board.mjs";
import { CLIS, isVersion, localVersion, locateCli, npmManaged, readCliVersions } from "../core/cli-versions.mjs";

const USAGE = ["用法: node cli/upgrade-cli.mjs <claude|codex> [--to <版本>] [--yes]",
  "  --to <版本>   要装的版本，例如 2.1.300；不给就用上次查到的最新版本",
  "  --yes         执行。不加时是干跑，只列出会做什么"].join("\n");

/** 升级流程。deps 见文件末尾的 realDeps；返回 { code }，文字经 log 输出。 */
export async function upgradeCli({ cli, to = null, yes = false, deps, log = console.log }) {
  const info = await deps.versions();
  const name = info.name;
  if (info.state !== "found" || !info.current) { log(`${name} 的当前版本读不出，没有升级。下一步:node cli/doctor.mjs`); return { code: 1 }; }
  const target = to || info.latest;
  if (!target) { log(`还不知道 ${name} 的最新版本，没有升级。下一步:用 --to <版本> 指定`); return { code: 1 }; }
  if (!isVersion(target)) { log("--to 后面要跟一个版本号，例如 2.1.300"); return { code: 1 }; }
  if (target === info.current) { log(`${name} 已经是 ${target}，没有要做的`); return { code: 0 }; }
  if (!info.npm_managed) {
    log(`看板调用的 ${name} 不是 npm 全局安装的:${info.path}`);
    log("本命令只处理 npm 全局安装的 CLI。下一步:按这个 CLI 的官方说明升级，再运行 node cli/doctor.mjs");
    return { code: 1 };
  }
  const board = await deps.board();
  const names = (list) => list.map((l) => l.label).join("、");
  log(`${name}:当前 ${info.current}，目标 ${target}`);
  log(`  会停下再恢复的执行线:${names(board.lines) || "无"}`);
  log(`  安装命令:npm install -g ${info.package}@${target}`);
  log(`  任何一步失败:装回 ${info.current}，再恢复执行线`);
  if (!yes) { log("这是干跑，什么都没有改。加 --yes 执行"); return { code: 0, dry: true }; }
  if (board.in_progress > 0) { log(`有 ${board.in_progress} 个任务正在执行，没有升级。等它们结束后再运行，本命令不打断任务`); return { code: 1 }; }
  if (!(await deps.doctor({ record: false })).ok) { log("体检现在就有 FAIL，没有升级。下一步:node cli/doctor.mjs，修好后再运行"); return { code: 1 }; }

  const stopped = [];
  const resume = async () => {
    const failed = [];
    for (const l of stopped) try { await deps.startLine(l); } catch { failed.push(l); }
    return failed;
  };
  try { for (const l of board.lines) { await deps.stopLine(l); stopped.push(l); } }
  catch (e) {
    const failed = await resume();
    log(`执行线停不下来，没有升级:${e.message}`);
    if (failed.length) log(`这些执行线没有恢复:${names(failed)}。下一步:在面板启动它们`);
    return { code: 1 };
  }
  if (stopped.length) log(`已停下执行线:${names(stopped)}`);

  // 执行线已经停下：之后任何一步出错（包括没料到的异常）都走装回原版本这条路，不把执行线悄悄留在停止状态。
  let why = null;
  try {
    const done = await deps.install(info.package, target);
    if (!done.ok) why = `安装没有成功:${done.detail}`;
    else if ((await deps.currentVersion()) !== target) why = `安装后的版本不是 ${target}`;
    else if (!(await deps.doctor({ record: true })).ok) why = "升级后体检没有通过";
  } catch (e) { why = `升级中断:${e.message}`; }
  if (!why) {
    const failed = await resume();
    log(`${name} 已升级到 ${target}，体检通过` + (stopped.length && !failed.length ? "，执行线已恢复" : ""));
    if (failed.length) { log(`这些执行线没有恢复:${names(failed)}。下一步:在面板启动它们`); return { code: 4 }; }
    return { code: 0 };
  }

  log(`${why}。正在装回 ${info.current}`);
  let back = { ok: false, detail: "" }, restored = false;
  try { back = await deps.install(info.package, info.current); restored = back.ok && (await deps.currentVersion()) === info.current; }
  catch (e) { back = { ok: false, detail: e.message }; }
  if (!restored) {
    log(`装回 ${info.current} 没有成功` + (back.ok ? "" : `:${back.detail}`) + (stopped.length ? `。执行线保持停止:${names(stopped)}` : ""));
    log(`下一步:手动运行 npm install -g ${info.package}@${info.current}，node cli/doctor.mjs 通过后在面板启动执行线`);
    return { code: 3 };
  }
  const failed = await resume();
  log(`升级没有完成，已回到 ${info.current}` + (stopped.length && !failed.length ? "，执行线已恢复" : ""));
  if (failed.length) log(`这些执行线没有恢复:${names(failed)}。下一步:在面板启动它们`);
  return { code: 2 };
}

/** npm 全局安装一个指定版本。不经 shell：用当前的 node 直接运行 npm 的入口脚本。 */
export function npmInstall(pkg, version, { npmCli = process.env.BOARD_NPM_CLI || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") } = {}) {
  if (!isVersion(version) || !CLIS.some((c) => c.package === pkg)) return Promise.resolve({ ok: false, detail: "包名或版本号不合格" });
  if (!existsSync(npmCli)) return Promise.resolve({ ok: false, detail: `找不到 npm 的入口脚本 ${npmCli}，用 BOARD_NPM_CLI 指向 npm-cli.js` });
  return new Promise((done) => {
    execFile(process.execPath, [npmCli, "install", "-g", `${pkg}@${version}`], { encoding: "utf8", windowsHide: true, timeout: 600000, maxBuffer: 8 << 20 },
      (error, stdout, stderr) => done(error
        ? { ok: false, detail: String(stderr || error.message).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 200) || "npm 退出码非零" }
        : { ok: true, detail: "" }));
  });
}

function realDeps(cli) {
  const { url, dataDir, token } = localBoard();
  const call = async (method, path, body) => {
    const r = await fetch(url + path, { method, signal: AbortSignal.timeout(30000),
      headers: { "X-Board-Token": token(), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const v = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(v.error || `看板返回 ${r.status}`);
    return v;
  };
  return {
    versions: async () => {
      const c = (await readCliVersions({ dataDir, network: "stale" })).clis.find((x) => x.id === cli);
      return { ...c, npm_managed: npmManaged(cli, c.path) };
    },
    // 正在运行、并且有槽位在用这个 CLI 的执行线；看板没有运行时没有执行线要停。
    board: async () => {
      if (!(await boardUp(url))) return { up: false, in_progress: 0, lines: [] };
      const [w, m] = await Promise.all([call("GET", "/api/workers"), call("GET", "/api/meta")]);
      const lines = (w.workers || []).filter((x) => x.running && !x.external && (x.slots || []).some((s) => s.running && s.runtime === cli))
        .map((x) => ({ line: x.line, label: w.line_labels?.[x.line] || x.line, route: x.route }));
      return { up: true, in_progress: Number(m.counts?.in_progress) || 0, lines };
    },
    stopLine: (l) => call("POST", `/api/workers/${l.line}/stop`, {}),
    startLine: (l) => call("POST", `/api/workers/${l.line}/start`, l.route ? { route: l.route } : {}),
    install: (pkg, version) => npmInstall(pkg, version),
    currentVersion: async () => { const where = locateCli(cli); return where.path ? localVersion(where.path) : null; },
    doctor: ({ record }) => new Promise((done) => {
      execFile(process.execPath, [join(CODE_ROOT, "cli", "doctor.mjs"), ...(record ? ["--record-tested"] : [])],
        { encoding: "utf8", windowsHide: true, timeout: 300000, maxBuffer: 8 << 20 }, (error) => done({ ok: !error }));
    }),
  };
}

async function main(argv) {
  const cli = argv[0], rest = argv.slice(1), i = rest.indexOf("--to");
  const to = i >= 0 ? rest[i + 1] : null, yes = rest.includes("--yes");
  const known = rest.every((a, k) => a === "--yes" || a === "--to" || (i >= 0 && k === i + 1));
  if (!CLIS.some((c) => c.id === cli) || !known || (i >= 0 && !to)) { console.error(USAGE); return 1; }
  applyConfigDefaults();
  try { return (await upgradeCli({ cli, to, yes, deps: realDeps(cli) })).code; }
  catch (e) { console.error(`没有升级:${e.message}`); return 1; }
}

// 直接运行才执行；被测试引入时只提供函数。不调用 process.exit()，原因见 cli/open.mjs。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
