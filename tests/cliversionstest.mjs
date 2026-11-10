import "./harness-env.mjs";
// cliversionstest — 执行器 CLI 版本巡检（core/cli-versions.mjs）。
// `node tests/cliversionstest.mjs`
//
// 不真的联网、不运行真实 CLI：版本号由替身函数给出，registry 是本测试自己起的本机 HTTP 服务。
// 覆盖：版本比较；离线与超时记「未能查询」且不报错；一天一查的缓存；未实测与两种实测来源；给人看的一行。
import http from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, fetchLatest, isVersion, locateCli, npmManaged, parseVersion, readCliVersions, readTestedVersions,
         recordTestedVersion, testedState, versionLine, versionSettings } from "../core/cli-versions.mjs";

const TMP = mkdtempSync(join(tmpdir(), "cliversions-"));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const HOUR = 3600 * 1000, T0 = Date.parse("2026-11-10T01:00:00Z");
const fresh = (name) => { const d = join(TMP, name); mkdirSync(d, { recursive: true }); return d; };
// 替身：Claude CLI 在一个假路径上，版本由 run 给出；Codex 没有配置。
const located = (id) => (id === "claude" ? { state: "found", path: process.execPath } : { state: "not_configured", path: null });
const both = () => ({ state: "found", path: process.execPath });
const says = (text) => async () => text;
const SET = { checkHours: 24, registry: "http://registry.invalid" };
const registry = (versions, calls) => async (url) => {
  calls.push(url);
  const pkg = decodeURIComponent(url.split("/").slice(3, -1).join("/"));
  return { ok: true, status: 200, json: async () => ({ version: versions[pkg] }) };
};
const offline = (calls) => async (url) => { calls.push(url); throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); };
const claudeOf = (v) => v.clis.find((c) => c.id === "claude");

console.log("[① 版本号的读取与比较]");
ok("从 CLI 的输出里取版本号", parseVersion("2.1.300 (Claude Code)") === "2.1.300" && parseVersion("codex-cli 0.46.0\n") === "0.46.0" && parseVersion("v24.16.0") === "24.16.0");
ok("没有版本号的输出读成 null", parseVersion("command not found") === null && parseVersion("") === null && parseVersion(null) === null);
ok("⭐按数值比较，不按字符串：2.1.9 低于 2.1.10", compareVersions("2.1.9", "2.1.10") === -1 && compareVersions("2.10.0", "2.9.9") === 1 && compareVersions("1.0.0", "1.0.0") === 0);
ok("预发布版本低于同号正式版", compareVersions("1.0.0-beta.1", "1.0.0") === -1 && compareVersions("1.0.0", "1.0.0-beta.1") === 1);
ok("任一侧不是版本号时不下结论", compareVersions("latest", "1.0.0") === null && compareVersions("1.0.0", "") === null);
ok("整串才算版本号（缓存文件与命令行参数用它核）", isVersion("2.1.300") && !isVersion("2.1.300; rm -rf /") && !isVersion("latest") && !isVersion(" 2.1.300"));

console.log("[② 联网查到最新版本，一天一查]");
{
  const dataDir = fresh("daily"), calls = [];
  const fetchImpl = registry({ "@anthropic-ai/claude-code": "2.1.305" }, calls);
  const opts = { dataDir, settings: SET, locate: located, run: says("2.1.300 (Claude Code)"), fetchImpl };
  const first = claudeOf(await readCliVersions({ ...opts, now: T0 }));
  ok("⭐当前 2.1.300、最新 2.1.305、可升级、未实测", first.current === "2.1.300" && first.latest === "2.1.305" && first.latest_state === "ok"
     && first.update_available === true && first.tested.state === "none" && first.latest_checked_at === new Date(T0).toISOString(), JSON.stringify(first));
  ok("只查了配置了的 CLI 的那个包，地址里包名的斜杠已转义", calls.length === 1 && calls[0] === "http://registry.invalid/@anthropic-ai%2fclaude-code/latest", calls.join(" "));
  ok("结果写进数据目录的 probes 子目录", existsSync(join(dataDir, "probes", "cli_versions.json")));
  await readCliVersions({ ...opts, now: T0 + 23 * HOUR });
  ok("⭐一天之内再读不联网", calls.length === 1);
  const later = claudeOf(await readCliVersions({ ...opts, now: T0 + 25 * HOUR }));
  ok("过了一天再查一次，上次核对的时间跟着更新", calls.length === 2 && later.latest_checked_at === new Date(T0 + 25 * HOUR).toISOString());
  const forced = await readCliVersions({ ...opts, now: T0 + 25 * HOUR + 1000, network: "force" });
  ok("network:force 立即再查", calls.length === 3 && claudeOf(forced).latest === "2.1.305");
  const codex = forced.clis.find((c) => c.id === "codex");
  ok("没有配置的 CLI 不查、不显示", codex.state === "not_configured" && codex.latest_state === "not_checked" && versionLine(codex) === null);
  ok("给人看的一行：当前 / 最新 / 上次核对 / 是否实测过",
     /^Claude CLI 当前 2\.1\.300 · 最新 2\.1\.305，可升级 · 上次核对 \d\d-\d\d \d\d:\d\d · 未实测$/.test(versionLine(first)), versionLine(first));
  const same = claudeOf(await readCliVersions({ ...opts, run: says("2.1.305"), now: T0 + 26 * HOUR }));
  ok("当前已是最新时不提示升级", same.update_available === false && /最新 2\.1\.305 · /.test(versionLine(same)));
}

console.log("[③ 离线与超时：记「未能查询」，不报错]");
{
  const dataDir = fresh("offline"), calls = [];
  const opts = { dataDir, settings: SET, locate: located, run: says("2.1.300"), fetchImpl: offline(calls) };
  let threw = false, v = null;
  try { v = claudeOf(await readCliVersions({ ...opts, now: T0 })); } catch { threw = true; }
  ok("⭐离线不抛错，最新版本记未能查询，当前版本照常给出", !threw && v.latest_state === "unavailable" && v.latest === null && v.current === "2.1.300"
     && v.update_available === null, JSON.stringify(v));
  ok("给人看的一行写「未能查询」", /最新 未能查询 · 上次核对 \d\d-\d\d \d\d:\d\d · 未实测$/.test(versionLine(v)), versionLine(v));
  await readCliVersions({ ...opts, now: T0 + 30 * 60 * 1000 });
  ok("查不到之后一小时内不反复联网", calls.length === 1);
  await readCliVersions({ ...opts, now: T0 + 61 * 60 * 1000 });
  ok("一小时后再试一次", calls.length === 2);
  // 先查到过，再离线：保留上次查到的版本，并说明这次没查到。
  const good = [];
  await readCliVersions({ ...opts, now: T0 + 2 * HOUR, network: "force", fetchImpl: registry({ "@anthropic-ai/claude-code": "2.1.305" }, good) });
  const stale = claudeOf(await readCliVersions({ ...opts, now: T0 + 30 * HOUR }));
  ok("⭐查到过之后离线：记未能查询，并带上上次查到的版本", stale.latest_state === "unavailable" && stale.latest === "2.1.305"
     && /最新 未能查询，上次查到 2\.1\.305/.test(versionLine(stale)), versionLine(stale));
  // 超时：一个永不应答、只认中止信号的 registry。
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  // 中止信号自己的计时器不留住进程（真实请求有连接留着）；替身没有连接，这里用一个计时器留住。
  const t = Date.now(), keep = setTimeout(() => {}, 10000);
  const timed = claudeOf(await readCliVersions({ dataDir: fresh("timeout"), settings: SET, locate: located, run: says("2.1.300"), fetchImpl: hang, timeoutMs: 200, now: T0 }));
  clearTimeout(keep);
  ok("⭐registry 不应答：到时限就记未能查询，不一直等", timed.latest_state === "unavailable" && Date.now() - t < 5000, `${Date.now() - t}ms`);
}

console.log("[④ 可配置：间隔、registry、不联网]");
{
  ok("默认一天一查、npm 官方 registry", JSON.stringify(versionSettings({ env: {}, config: {} })) === JSON.stringify({ checkHours: 24, registry: "https://registry.npmjs.org" }));
  ok("配置文件可改，环境变量优先", JSON.stringify(versionSettings({ env: { BOARD_CLI_VERSION_CHECK_HOURS: "6" }, config: { cli_versions: { check_hours: 48, registry: "https://npm.example.test/" } } }))
     === JSON.stringify({ checkHours: 6, registry: "https://npm.example.test" }));
  ok("不合格的取值回到默认", JSON.stringify(versionSettings({ env: { BOARD_CLI_VERSION_CHECK_HOURS: "often", BOARD_CLI_VERSION_REGISTRY: "ftp://x" }, config: {} }))
     === JSON.stringify({ checkHours: 24, registry: "https://registry.npmjs.org" }));
  const calls = [], fetchImpl = registry({ "@anthropic-ai/claude-code": "2.1.305" }, calls);
  const off = claudeOf(await readCliVersions({ dataDir: fresh("never"), settings: { checkHours: 0, registry: SET.registry }, locate: located, run: says("2.1.300"), fetchImpl, now: T0 }));
  ok("⭐check_hours 为 0：不联网，最新版本写「未查询」", calls.length === 0 && off.latest_state === "not_checked" && /最新 未查询 · 上次核对 无/.test(versionLine(off)), versionLine(off));
  const dir = fresh("readonly");
  await readCliVersions({ dataDir: dir, settings: SET, locate: located, run: says("2.1.300"), fetchImpl, now: T0, network: "never", write: false });
  ok("⭐network:never（doctor 用）：不联网，也不在数据目录里写任何东西", calls.length === 0 && !existsSync(join(dir, "probes")));
}

console.log("[⑤ 实测过的版本]");
{
  const dataDir = fresh("tested"), opts = { dataDir, settings: { checkHours: 0, registry: SET.registry }, locate: located, run: says("2.1.300") };
  ok("清单为空时是未实测", claudeOf(await readCliVersions(opts)).tested.state === "none");
  recordTestedVersion(dataDir, { cli: "claude", version: "2.1.300", source: "doctor", at: "2026-11-09T00:00:00Z" });
  const contract = claudeOf(await readCliVersions(opts));
  ok("⭐doctor 通过后记的是「参数已核对」，不算读写边界实测", contract.tested.state === "contract" && /参数已核对，读写权限范围未实测$/.test(versionLine(contract)), versionLine(contract));
  recordTestedVersion(dataDir, { cli: "claude", version: "2.1.300", source: "boundary-probe", at: "2026-11-09T01:00:00Z" });
  const boundary = claudeOf(await readCliVersions(opts));
  ok("⭐边界探针通过后是「已实测」", boundary.tested.state === "boundary" && /已实测$/.test(versionLine(boundary)), versionLine(boundary));
  ok("⭐换一个版本就回到未实测", claudeOf(await readCliVersions({ ...opts, run: says("2.1.301") })).tested.state === "none");
  ok("别的平台测过的不算", testedState(readTestedVersions(dataDir), "claude", "2.1.300", "linux-other").state === "none");
  recordTestedVersion(dataDir, { cli: "claude", version: "2.1.300", source: "doctor", at: "2026-11-10T00:00:00Z" });
  ok("同一条重复记只更新时间，不增加条目", readTestedVersions(dataDir).length === 2
     && readTestedVersions(dataDir).find((t) => t.source === "doctor").at === "2026-11-10T00:00:00.000Z");
  let threw = 0;
  for (const bad of [{ cli: "other", version: "1.0.0", source: "doctor" }, { cli: "claude", version: "latest", source: "doctor" }, { cli: "claude", version: "1.0.0", source: "trust-me" }])
    try { recordTestedVersion(dataDir, bad); } catch { threw++; }
  ok("不认识的 CLI、不是版本号、不认识的来源都不记", threw === 3 && readTestedVersions(dataDir).length === 2);
  writeFileSync(join(dataDir, "probes", "cli_tested.json"), JSON.stringify({ tested: [{ cli: "claude", version: "2.1.300", source: "made-up", at: "x", platform: process.platform }, "junk"] }));
  writeFileSync(join(dataDir, "probes", "cli_versions.json"), "{not json");
  const dirty = claudeOf(await readCliVersions(opts));
  ok("⭐清单或缓存被写坏：不合格的条目丢弃，按未实测、未查询处理，不报错", dirty.tested.state === "none" && dirty.latest_state === "not_checked");
}

console.log("[⑥ 找到看板实际调用的那个文件]");
{
  ok("WORKER_CLAUDE_CLI 指向原生文件：就是它", locateCli("claude", { WORKER_CLAUDE_CLI: process.execPath }).path === process.execPath);
  ok("没有设置也不在 PATH 上：没有找到", locateCli("claude", { PATH: TMP }).state === "not_found");
  ok("没有设 BOARD_CODEX_CMD：Codex 没有配置", locateCli("codex", {}).state === "not_configured");
  ok("BOARD_CODEX_CMD 指向存在的原生文件：就是它；指向包装器或不存在的文件都不算", locateCli("codex", { BOARD_CODEX_CMD: process.execPath }).path === process.execPath
     && locateCli("codex", { BOARD_CODEX_CMD: join(TMP, "missing.exe") }).state === "not_found");
  const cmd = join(TMP, "codex.cmd"); writeFileSync(cmd, "@echo off\n");
  ok("包装器脚本不当作被巡检的 CLI", locateCli("codex", { BOARD_CODEX_CMD: cmd }).state === "wrapper");
  ok("是不是 npm 全局安装的包里的文件", npmManaged("claude", "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe")
     && npmManaged("codex", "/usr/lib/node_modules/@openai/codex/bin/codex") && !npmManaged("claude", "C:\\Users\\u\\.local\\bin\\claude.exe"));
  const real = await readCliVersions({ dataDir: fresh("realrun"), settings: { checkHours: 0, registry: SET.registry }, locate: both });
  ok("真的运行一次 --version（用 node 自己当替身）读出版本号", claudeOf(real).current === process.version.slice(1), JSON.stringify(claudeOf(real)));
  const lost = versionLine({ ...claudeOf(real), state: "wrapper", path: null });
  ok("⭐只有包装器时，一行里说没有找到可以直接启动的程序，并给出下一步（与面板同一说法）",
     lost === "Claude CLI 没有找到可以直接启动的 CLI 程序。下一步:运行 node cli/doctor.mjs 查看原因", lost);
  const mute = versionLine({ ...claudeOf(real), current: null });
  ok("版本读不出时同样给出下一步", mute === "Claude CLI 版本读不出。下一步:运行 node cli/doctor.mjs 查看原因", mute);
}

console.log("[⑦ 真的发 HTTP 请求：本机替身 registry]");
{
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/@openai%2fcodex/latest") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ name: "@openai/codex", version: "0.47.0" })); }
    if (req.url === "/@anthropic-ai%2fclaude-code/latest") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ version: "not-a-version" })); }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  ok("⭐registry 给出最新版本", (await fetchLatest("@openai/codex", { registry: base })) === "0.47.0" && seen[0] === "/@openai%2fcodex/latest", seen.join(" "));
  let refused = 0;
  for (const pkg of ["@anthropic-ai/claude-code", "@nobody/none"]) try { await fetchLatest(pkg, { registry: base }); } catch { refused++; }
  ok("registry 给的不是版本号、或返回 404：都不采用", refused === 2);
  const live = await readCliVersions({ dataDir: fresh("http"), settings: { checkHours: 24, registry: base }, locate: both, run: says("0.46.0"), now: T0 });
  const codex = live.clis.find((c) => c.id === "codex");
  ok("⭐一个包查到、一个包查不到：各记各的，互不影响", codex.latest === "0.47.0" && codex.update_available === true && claudeOf(live).latest_state === "unavailable");
  await new Promise((r) => server.close(r));
  const down = await readCliVersions({ dataDir: fresh("refused"), settings: { checkHours: 24, registry: base }, locate: both, run: says("0.46.0"), now: T0 });
  ok("⭐registry 连不上（端口已关）：两个都记未能查询，不报错", down.clis.every((c) => c.latest_state === "unavailable" && c.current === "0.46.0"));
  const cache = JSON.parse(readFileSync(join(TMP, "http", "probes", "cli_versions.json"), "utf8"));
  ok("缓存里只有版本号、状态和时间，没有路径", JSON.stringify(Object.keys(cache.latest.codex).sort()) === JSON.stringify(["checked_at", "latest", "ok_at", "state"]));
}

try { rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${"─".repeat(56)}\nresult: ${pass} PASS / ${fail} FAIL`);
// 不在这里直接 process.exit:上面刚向一个已关的端口发过请求,Windows 上此刻退出 libuv 会中止
// (src\win\async.c 的断言,退出码 127;Node 24.16 实测,断言全过也一样)。记下退出码让事件循环自己收完,5 秒还没收完再强制退出。
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 5000).unref();
