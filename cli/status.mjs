// `node cli/status.mjs [--log]` (= npm run status) — one place to see whether the board on this
// machine is running, what needs attention and what to do next: computer, board service, each line,
// the last fault. The words are the home page's own (core/home-model.mjs):
// the same merged alerts, the same next steps. Read-only: it only sends GET requests and starts,
// stops and repairs nothing — when the board is down it gives one cause and one next step, and
// `--log` expands the end of its log.
//   exit code: 0 running, nothing marked red · 2 running, something red · 1 not running
import { localBoard } from "../core/local-board.mjs";
import { loadHomeModel } from "../core/home-model.mjs";
import { collapseRepeats, downCause, faultText, isLoopback, logLines, mergeLineFaults, probeBoard, readRunRecord } from "../core/board-run.mjs";

const USAGE = ["用法: node cli/status.mjs [--log]",
  "  --log    展开看板日志的最后 30 行，连续重复的行合并成一行",
  "相关命令:",
  "  启动看板          node cli/start.mjs --background",
  "  停止看板          node cli/stop.mjs",
  "  打开面板          node cli/open.mjs",
  "  体检              node cli/doctor.mjs",
  "  登录后自动启动    node cli/autostart.mjs"].join("\n");
const START = "node cli/start.mjs --background";

// Returns its exit code instead of calling process.exit(): see cli/open.mjs (Node 24 on Windows
// aborts in libuv when exiting that way after requests to a running board).
process.exitCode = await main();

async function main() {
  const args = process.argv.slice(2), showLog = args.includes("--log");
  if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); return 0; }
  if (args.some((a) => a !== "--log")) { console.error(USAGE); return 1; }
  const { url, dataDir, logFile, token } = localBoard();
  const probe = await probeBoard(url);
  if (probe.state !== "up") return notRunning({ url, dataDir, logFile, probe, showLog });
  let key;
  try { key = token(); }
  catch (e) { console.log("本机:电脑在线 · 看板服务有应答"); console.log(`  地址:${url}`); console.error(`  读不到更多状态:${e.message}`); return 2; }
  const read = async (path) => {
    const r = await fetch(url + path, { signal: AbortSignal.timeout(10000), headers: { "X-Board-Token": key } });
    const v = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(v.error || `读取失败，HTTP ${r.status}`), { status: r.status });
    return v;
  };
  const [setup, workers, meta, fleet, health] = await Promise.allSettled(
    ["/api/setup", "/api/workers", "/api/meta", "/api/fleet?limit=1", "/api/fleet/health"].map(read));
  const ok = (r) => (r.status === "fulfilled" ? r.value : null), why = (r) => (r.status === "rejected" ? r.reason.message : null);
  // 服务在线不等于状态可读；必需读取失败不能被可选的健康提醒掩盖。
  const unreadable = [["配置", setup], ["执行器", workers], ["本机状态", meta]].filter(([, r]) => r.status === "rejected");
  if (unreadable.length) {
    console.log("本机:电脑在线 · 看板服务有应答");
    console.log(`  地址:${url}`);
    const denied = unreadable.some(([, r]) => [401, 403].includes(r.reason?.status));
    console.error(`  ${denied ? "操作员授权未通过" : "状态读取受阻"}:${unreadable.map(([label, r]) => label + " " + why(r)).join("、")}`);
    console.log(denied ? "下一步:核对启动命令、数据目录和操作员授权，再重试；不要重建或公开令牌。" : "下一步:查看数据目录里的 board.log，排除读取问题后重试。");
    return 2;
  }
  const M = loadHomeModel(), name = ok(meta)?.node?.display_name, version = ok(setup)?.version, w = ok(workers);
  const s = M.homeStatus({ localName: name, nodes: ok(fleet)?.nodes || null, fleetError: why(fleet),
                           health: ok(health), healthError: why(health), setup: ok(setup) });
  const labels = w?.line_labels || {}, lineFaults = mergeLineFaults(w?.workers, { label: (l) => labels[l] || l });
  const alerts = [...s.alerts, ...lineFaults];
  console.log(`本机「${M.homeName(name, "本机")}」:电脑在线 · 看板服务正常`);
  console.log(`  地址:${url}${version ? " · 版本 " + version : ""}`);
  const lines = linesNow(w);
  if (lines) console.log(`  执行线:${lines}`);
  console.log(`  上次故障:${faultText(readRunRecord(dataDir).last_fault)}`);
  console.log(`  ${alerts.length === s.alerts.length ? s.line : alerts.length + " 项需要注意"}`);
  for (const a of alerts) console.log(`  ${a.tone === "bad" ? "✗" : "!"} ${a.where}:${a.what}。下一步:${a.next}`);
  if (showLog) {
    for (const f of lineFaults) if (f.log.length) { console.log("  执行线最近的日志:"); for (const l of collapseRepeats(f.log)) console.log("    " + l); }
    printLog(logFile, null);
  } else if (alerts.length) console.log("  详细日志:node cli/status.mjs --log");
  return alerts.some((a) => a.tone === "bad") ? 2 : 0;
}

/** Each configured line once, by its label, in the panel's own words for its state. */
function linesNow(w) {
  if (!w || !Array.isArray(w.lines) || !w.lines.length) return "";
  const labels = w.line_labels || {}, workers = Array.isArray(w.workers) ? w.workers : [];
  return w.lines.map((l) => {
    const rows = workers.filter((x) => x.line === l);
    const state = rows.some((x) => x.external) ? "外部执行" : rows.some((x) => x.running) ? "运行中"
      : rows.some((x) => x.desired_running) ? "已请求启动，待核实" : "已停止";
    return (labels[l] || l) + " " + state;
  }).join("、");
}

/** 首页在看板断开时的那一条提示；读不到首页模型时用同一句话兜底。 */
function outage(probe, local, where) {
  try {
    const M = loadHomeModel();
    if (local || probe.state === "http" && ![502, 503, 504].includes(probe.status)) {
      const down = probe.state === "http" ? { kind: "error", status: probe.status } : { kind: "down", local: true };
      const a = M.homeStatus({ down }).alerts[0];
      return { what: a.what, next: a.next };
    }
    // 另一台电脑：有应答（拒绝连接、502 一类）说明电脑在线，是看板服务没有应答；完全连不上才是电脑的问题。
    const code = probe.state === "http" ? "REMOTE_" + probe.status : probe.state === "refused" ? "PEER_REFUSED" : "PEER_UNREACHABLE";
    const a = M.homeStatus({ nodes: [{ local: false, display_name: where, connection_state: "failed", projects: [{ error_code: code }] }] }).alerts[0];
    return { what: a.what, next: a.next };
  } catch {
    return { what: "电脑在线，看板服务没有应答", next: `在这台电脑上重新启动看板：${START}` };
  }
}

function notRunning({ url, dataDir, logFile, probe, showLog }) {
  const local = isLoopback(url), o = outage(probe, local, url);
  if (!local) {
    console.log(`${url}:${o.what}`);
    console.log(`下一步:${o.next}`);
    return 1;
  }
  const record = readRunRecord(dataDir), from = record.current?.log_from ?? null;
  const cause = downCause({ record, probe, lines: logLines(logFile, { from, n: 200 }) });
  console.log(`本机:${probe.state === "http" ? "电脑在线，" : ""}${o.what}`);
  console.log(`  地址:${url}`);
  console.log(`  原因:${cause.cause}`);
  console.log(`  已有的任务和结果保留在 ${dataDir}，重新启动后照原样回来。`);
  if (showLog) printLog(logFile, from); else console.log("  详细日志:node cli/status.mjs --log");
  console.log(`下一步:${cause.next || o.next}`);
  return 1;
}

function printLog(logFile, from) {
  const tail = collapseRepeats(logLines(logFile, { from, n: 30 }));
  if (!tail.length) { console.log(`  没有后台运行的日志:${logFile}`); return; }
  console.log(`  看板日志最后 ${tail.length} 行，文件 ${logFile}:`);
  for (const l of tail) console.log("    " + l);
}
