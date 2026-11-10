import { harnessEnvironment } from "./harness-env.mjs";
// upgradeclitest — 执行器 CLI 升级流程（cli/upgrade-cli.mjs）。
// `node tests/upgradeclitest.mjs`
//
// 全部用替身，不真的安装或升级任何东西：假 npm 只改一个变量（「装上的版本」），假 CLI 报出这个变量，
// 假看板记下停线与起线，假体检按当前装上的版本给结论。最后用一个假的 npm 入口脚本跑一次真实的
// 安装函数，核对它发出的命令行；命令行入口只测用法与拒绝，不带 --yes 以外的任何真实改动。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmInstall, upgradeCli } from "../cli/upgrade-cli.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_ENV = harnessEnvironment(), TMP = mkdtempSync(join(tmpdir(), "upgradecli-"));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const PKG = "@anthropic-ai/claude-code", OLD = "2.1.300", NEW = "2.1.305";

/** 一套替身。events 按发生顺序记下每一步；running 是当前在跑的执行线。 */
function world({ latest = NEW, npm_managed = true, in_progress = 0, lines = ["engine", "review"], npmFails = [], npmNoop = [],
                 doctorFailsOn = [], stopFails = [], startFails = [], currentThrowsOnce = false } = {}) {
  const w = { installed: OLD, events: [], running: new Set(lines), out: [], recorded: [] };
  let threw = false;
  w.deps = {
    versions: async () => ({ id: "claude", name: "Claude CLI", package: PKG, state: "found", path: "C:/npm/node_modules/" + PKG + "/bin/claude.exe",
                             current: w.installed, latest, npm_managed }),
    board: async () => ({ up: true, in_progress, lines: [...w.running].map((line) => ({ line, label: line === "engine" ? "引擎" : "审阅" })) }),
    stopLine: async (l) => { if (stopFails.includes(l.line)) throw new Error("停止请求被拒绝"); w.events.push("stop " + l.line); w.running.delete(l.line); },
    startLine: async (l) => { if (startFails.includes(l.line)) throw new Error("启动请求被拒绝"); w.events.push("start " + l.line); w.running.add(l.line); },
    // 假 npm：失败名单里的版本装不上；空转名单里的版本说装上了、实际没变。
    install: async (pkg, version) => {
      w.events.push(`npm install -g ${pkg}@${version}`);
      if (npmFails.includes(version)) return { ok: false, detail: "E404 没有这个版本" };
      if (!npmNoop.includes(version)) w.installed = version;
      return { ok: true, detail: "" };
    },
    // 假 CLI：报出装上的版本。
    currentVersion: async () => { if (currentThrowsOnce && !threw) { threw = true; throw new Error("版本读取出错"); } return w.installed; },
    doctor: async ({ record }) => {
      const okNow = !doctorFailsOn.includes(w.installed);
      w.events.push(`doctor ${w.installed}${record ? " record" : ""} ${okNow ? "pass" : "fail"}`);
      if (okNow && record) w.recorded.push(w.installed);
      return { ok: okNow };
    },
  };
  w.run = (opts = {}) => upgradeCli({ cli: "claude", deps: w.deps, log: (s) => w.out.push(s), ...opts });
  w.text = () => w.out.join("\n");
  return w;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("[① 默认干跑]");
{
  const w = world(), r = await w.run();
  ok("⭐不带 --yes：列出当前、目标、会停的执行线、安装命令和失败时的做法，什么都不做", r.code === 0 && r.dry === true && w.events.length === 0
     && w.installed === OLD && /当前 2\.1\.300，目标 2\.1\.305/.test(w.text()) && /会停下再恢复的执行线:引擎、审阅/.test(w.text())
     && w.text().includes(`npm install -g ${PKG}@${NEW}`) && /装回 2\.1\.300/.test(w.text()) && /这是干跑，什么都没有改。加 --yes 执行/.test(w.text()), w.text());
  const pinned = world({ latest: null }), r2 = await pinned.run({ to: "2.1.302" });
  ok("--to 指定版本时用它，不需要知道最新版本", r2.code === 0 && /目标 2\.1\.302/.test(pinned.text()) && pinned.events.length === 0);
}

console.log("[② 升级成功]");
{
  const w = world(), r = await w.run({ yes: true });
  ok("⭐顺序：体检 → 停线 → 安装 → 体检并记录 → 恢复线", r.code === 0 && same(w.events,
     ["doctor 2.1.300 pass", "stop engine", "stop review", `npm install -g ${PKG}@${NEW}`, "doctor 2.1.305 record pass", "start engine", "start review"]), w.events.join(" | "));
  ok("装上的是目标版本，原先在跑的执行线都回来了，新版本记进了实测清单", w.installed === NEW && same([...w.running].sort(), ["engine", "review"]) && same(w.recorded, [NEW]));
  ok("结尾一句说明结果", /Claude CLI 已升级到 2\.1\.305，体检通过，执行线已恢复/.test(w.text()), w.out.slice(-1)[0]);
  const idle = world({ lines: [] }), r2 = await idle.run({ yes: true });
  ok("没有执行线在跑（或看板没有运行）时照样升级，不停也不起任何线", r2.code === 0 && idle.installed === NEW
     && !idle.events.some((e) => /^(stop|start) /.test(e)), idle.events.join(" | "));
}

console.log("[③ 失败后回到原版本]");
{
  const w = world({ doctorFailsOn: [NEW] }), r = await w.run({ yes: true });
  ok("⭐升级后体检不过：装回原版本，再恢复执行线（退出码 2）", r.code === 2 && w.installed === OLD && same(w.events,
     ["doctor 2.1.300 pass", "stop engine", "stop review", `npm install -g ${PKG}@${NEW}`, "doctor 2.1.305 record fail",
      `npm install -g ${PKG}@${OLD}`, "start engine", "start review"]), w.events.join(" | "));
  ok("报告里说了原因和结果，没通过体检的版本不进实测清单", /升级后体检没有通过。正在装回 2\.1\.300/.test(w.text())
     && /升级没有完成，已回到 2\.1\.300，执行线已恢复/.test(w.text()) && w.recorded.length === 0, w.text());
  const e404 = world({ npmFails: [NEW] }), r2 = await e404.run({ yes: true });
  ok("⭐npm 装不上目标版本：报出 npm 的原因，装回原版本，恢复执行线", r2.code === 2 && e404.installed === OLD && /安装没有成功:E404 没有这个版本/.test(e404.text())
     && same([...e404.running].sort(), ["engine", "review"]) && !e404.events.some((e) => /record/.test(e)), e404.text());
  const noop = world({ npmNoop: [NEW] }), r3 = await noop.run({ yes: true });
  ok("⭐npm 说装上了、CLI 报的版本却没变：按失败处理，不拿没变的版本去跑体检", r3.code === 2 && /安装后的版本不是 2\.1\.305/.test(noop.text())
     && !noop.events.some((e) => /record/.test(e)) && same([...noop.running].sort(), ["engine", "review"]), noop.events.join(" | "));
  const thrown = world({ currentThrowsOnce: true }), r4 = await thrown.run({ yes: true });
  ok("执行线停下之后出了没料到的错：同样装回原版本并恢复执行线，不把线留在停止状态", r4.code === 2 && thrown.installed === OLD
     && /升级中断:版本读取出错/.test(thrown.text()) && same([...thrown.running].sort(), ["engine", "review"]), thrown.text());
}

console.log("[④ 装回原版本也失败]");
{
  const w = world({ doctorFailsOn: [NEW], npmFails: [OLD] }), r = await w.run({ yes: true });
  ok("⭐退出码 3：执行线保持停止，不在一个没通过体检的 CLI 上起线", r.code === 3 && w.running.size === 0 && !w.events.some((e) => e.startsWith("start ")), w.events.join(" | "));
  ok("报告给出手动命令和之后的步骤", /装回 2\.1\.300 没有成功:E404 没有这个版本。执行线保持停止:引擎、审阅/.test(w.text())
     && w.text().includes(`下一步:手动运行 npm install -g ${PKG}@${OLD}，node cli/doctor.mjs 通过后在面板启动执行线`), w.text());
}

console.log("[⑤ 不动任何东西的拒绝]");
{
  const untouched = (w) => w.installed === OLD && !w.events.some((e) => /^(stop|start|npm) /.test(e));
  const busy = world({ in_progress: 2 }), r1 = await busy.run({ yes: true });
  ok("⭐有任务正在执行：不升级、不停线，不打断任务", r1.code === 1 && untouched(busy) && busy.events.length === 0 && /有 2 个任务正在执行，没有升级/.test(busy.text()), busy.text());
  const sick = world({ doctorFailsOn: [OLD] }), r2 = await sick.run({ yes: true });
  ok("⭐升级前体检就不过：不升级（否则分不清是谁弄坏的）", r2.code === 1 && untouched(sick) && /体检现在就有 FAIL，没有升级/.test(sick.text()));
  const native = world({ npm_managed: false }), r3 = await native.run({ yes: true });
  ok("⭐看板调用的 CLI 不是 npm 全局安装的：不处理，下一步与面板同一说法", r3.code === 1 && native.events.length === 0 && /不是 npm 全局安装的/.test(native.text())
     && native.text().includes("下一步:按这个 CLI 的官方说明升级，再运行 node cli/doctor.mjs") && !/自己的方式/.test(native.text()), native.text());
  const current = world({ latest: OLD }), r4 = await current.run({ yes: true });
  ok("已经是目标版本：没有要做的（退出码 0）", r4.code === 0 && current.events.length === 0 && /已经是 2\.1\.300/.test(current.text()));
  const unknown = world({ latest: null }), r5 = await unknown.run({ yes: true });
  ok("不知道最新版本又没给 --to：不升级，提示用 --to", r5.code === 1 && unknown.events.length === 0 && /用 --to <版本> 指定/.test(unknown.text()));
  const junk = world(), r6 = await junk.run({ yes: true, to: "latest && calc" });
  ok("⭐--to 不是版本号：不升级，这个值到不了 npm", r6.code === 1 && junk.events.length === 0);
  const stuck = world({ stopFails: ["review"] }), r7 = await stuck.run({ yes: true });
  ok("有一条执行线停不下来：已停的那条恢复，不安装", r7.code === 1 && same(stuck.events, ["doctor 2.1.300 pass", "stop engine", "start engine"])
     && stuck.installed === OLD && same([...stuck.running].sort(), ["engine", "review"]), stuck.events.join(" | "));
  const half = world({ startFails: ["review"] }), r8 = await half.run({ yes: true });
  ok("升级成功但有执行线没恢复：退出码 4，点名那条线", r8.code === 4 && half.installed === NEW && /这些执行线没有恢复:审阅。下一步:在面板启动它们/.test(half.text()), half.text());
}

console.log("[⑥ 真实的安装函数与命令行入口：假 npm，不真装]");
{
  // 假的 npm 入口脚本：把收到的参数记进文件；参数里的版本是 0.0.1 时以失败退出。
  const seen = join(TMP, "npm-argv.json"), fakeNpm = join(TMP, "fake-npm-cli.js");
  writeFileSync(fakeNpm, `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));
if (process.argv.some((a) => a.endsWith("@0.0.1"))) { console.error("npm error code ETARGET"); process.exit(1); }\n`);
  const done = await npmInstall(PKG, "9.9.9", { npmCli: fakeNpm });
  ok("⭐发给 npm 的参数恰好是 install -g 包名@版本", done.ok === true && same(JSON.parse(readFileSync(seen, "utf8")), ["install", "-g", `${PKG}@9.9.9`]), readFileSync(seen, "utf8"));
  const failed = await npmInstall(PKG, "0.0.1", { npmCli: fakeNpm });
  ok("npm 以失败退出：ok:false，带上 npm 的最后一行", failed.ok === false && /ETARGET/.test(failed.detail), JSON.stringify(failed));
  rmSync(seen);
  const refused = [await npmInstall("left-pad", "1.0.0", { npmCli: fakeNpm }), await npmInstall(PKG, "latest", { npmCli: fakeNpm }),
                   await npmInstall(PKG, "1.0.0", { npmCli: join(TMP, "missing.js") })];
  ok("⭐别的包名、不是版本号的版本、找不到 npm：都不运行任何东西", refused.every((r) => r.ok === false) && !existsSync(seen));

  const cli = (args, env = {}) => {
    const r = spawnSync(process.execPath, [join(ROOT, "cli", "upgrade-cli.mjs"), ...args], { encoding: "utf8", windowsHide: true, timeout: 60000,
      env: { ...HOST_ENV, BOARD_CONFIG: join(TMP, "none.json"), BOARD_DATA_DIR: join(TMP, "data"), BOARD_PORT: "1", BOARD_NPM_CLI: fakeNpm,
             BOARD_CLI_VERSION_CHECK_HOURS: "0", ...env } });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const usage = [cli([]), cli(["gemini"]), cli(["claude", "--force"]), cli(["claude", "--to"])];
  ok("没给 CLI 名、不认识的名字、不认识的参数、--to 后面没有值：打印用法，退出码 1", usage.every((r) => r.code === 1 && /用法: node cli\/upgrade-cli\.mjs/.test(r.out)));
  // node 自己当「看板调用的 Claude CLI」：它不在 npm 的包目录里，带 --yes 也只会被拒绝。
  const notNpm = cli(["claude", "--to", "9.9.9", "--yes"], { WORKER_CLAUDE_CLI: process.execPath });
  ok("⭐命令行入口带 --yes：CLI 不是 npm 全局安装的就拒绝，假 npm 一次都没被调用", notNpm.code === 1 && /不是 npm 全局安装的/.test(notNpm.out) && !existsSync(seen), notNpm.out.slice(-200));
  const none = cli(["codex", "--yes"]);
  ok("没有配置的 CLI：读不出当前版本，不升级", none.code === 1 && /Codex CLI 的当前版本读不出，没有升级/.test(none.out) && !existsSync(seen), none.out.slice(-200));
}

try { rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${"─".repeat(56)}\nresult: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
