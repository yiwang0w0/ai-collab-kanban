// `node cli/status.mjs` — one command that answers "现在怎么了,怎么拉起来", for the
// moments the home page can't answer because the page itself is what's down.
//
// It distinguishes the two failures people confuse (交接说明 第 4 批): 这台电脑在不在
// (the machine is up — you are running this on it) and 看板服务正不正常 (the board
// answers /health or it does not). Everything else folds into one line per problem,
// each with the command that addresses it. Read-only: nothing here starts, stops or
// repairs — those stay with start/stop/open and the panel.
import { boardUp, localBoard } from "../core/local-board.mjs";
import { existsSync, readFileSync, statSync } from "node:fs";

const { url, port, dataDir, logFile, token } = localBoard();

const out = [];
let problems = 0;

async function main() {
  // ① The board service itself.
  const up = await boardUp(url);
  if (up) out.push(`✓ 看板服务正常(${url})`);
  else {
    problems++;
    const listening = existsSync(logFile) ? `日志: ${logFile}` : "没有找到运行日志";
    out.push(`✗ 看板服务没有应答(${port} 端口无人监听)—— 这台电脑是开着的,是看板停了。`);
    out.push(`  下一步: node cli/start.mjs --background   (${listening})`);
  }

  // ② Authenticated reads — only meaningful when the board answers.
  if (up) {
    let tok = "";
    try { tok = token(); } catch (e) { tok = ""; out.push(`✗ 读不到操作员令牌: ${e.message}`); problems++; }
    const get = async (path) => {
      // Connection: close — the default keep-alive pool leaves an open handle, and
      // process.exit over a live undici socket trips a libuv assertion on Windows
      // (measured: exit=127 after a fully printed report). One-shot command, no pool.
      const r = await fetch(url + path, { headers: { "X-Board-Token": tok, Connection: "close" }, signal: AbortSignal.timeout(5000), cache: "no-store" });
      const v = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(Error(v.error || `HTTP ${r.status}`), { code: r.status });
      return v;
    };
    try {
      const counts = await get("/api/meta");
      const c = counts.counts;
      out.push(`✓ 数据可读: 未开始 ${c.not_started} · 进行中 ${c.in_progress} · 等待中 ${c.waiting} · 已完成 ${c.done}(任务与结果都在)`);
    } catch (e) {
      problems++;
      out.push(`✗ 数据读不了(${e.message})—— 多为令牌不对: 重新配对 node cli/open.mjs`);
    }
    try {
      const health = await get("/api/fleet/health");
      // One line per kind of problem, however many records are behind it — the same
      // folding the home page does; each carries the command that addresses it.
      const issues = health.issues || [];
      if (!issues.length) out.push("✓ 运行检查没有发现问题");
      else for (const i of issues) {
        problems++;
        const n = i.count > 1 ? `（${i.count} 项）` : "";
        out.push(`✗ ${HEALTH_WORDS[i.code] || i.code}${n} —— 下一步: ${NEXT_WORDS[i.next_action] || "看板运行日志"}`);
      }
    } catch (e) {
      problems++;
      out.push(`✗ 运行检查读不了(${e.message})`);
    }
  } else {
    // The data directory is the operator's reassurance that nothing was lost: its
    // database file is the tasks and results, untouched by the service being down.
    const db = existsSync(`${dataDir}\\board.db`) || existsSync(`${dataDir}/board.db`);
    out.push(db ? `  数据完好: ${dataDir}(任务与结果都在,重启后原样回来)`
                : `  还没有数据目录(${dataDir})—— 首次安装跑 node cli/setup.mjs`);
  }

  console.log(out.join("\n"));
  // ⚠ No process.exit()/reallyExit() here. This process has fetched over undici; both
  //   exits, over the pooled (or closing) socket, trip a libuv assertion on Windows and
  //   the crash code 127 overwrites ours (measured: exit()=127, reallyExit()=127,
  //   natural drain=0). Let the loop drain; exitCode carries the verdict.
  process.exitCode = problems ? 1 : 0;
}

const HEALTH_WORDS = {
  BROKER_INTERRUPTED: "有一次执行分派中断", BROKER_PREPARED_STALE: "有执行分派长时间没有启动",
  CALL_BUDGET_OVERRUN: "调用额度记账超出上限", CALL_BUDGET_EXHAUSTED: "调用额度已用完",
  STORAGE_LOW: "磁盘空间不足", STORAGE_UNAVAILABLE: "读不到磁盘空间",
  DELIVERY_BLOCKED: "有跨机交付操作受阻", DELIVERY_RETRY_PENDING: "有跨机交付在等待重发",
  SCHEDULER_ATTENTION: "调度器的停止情况待核对", SCHEDULER_HEARTBEAT_STALE: "调度器心跳超时",
  NODE_ATTENTION: "节点运行器的停止情况待核对", NODE_HEARTBEAT_STALE: "节点运行器心跳超时",
  NODE_SYNC_RETRY: "同步正在重试", NODE_SYNC_PENDING: "同步有积压",
  NODE_SYNC_OBSERVATION_STALE: "同步状态长时间没有更新", NODE_COMPONENT_STOPPED: "节点组件已停止",
  NODE_COMPONENTS_MISSING: "节点组件没有上报", CLOCK_UNKNOWN: "时间记录对不上", STALE_EPOCH_RECORD: "有旧代次的遗留记录",
};
const NEXT_WORDS = {
  dispatch_stale_then_reconcile: "核对后在面板恢复这次分派", review_prepared_dispatch: "核对没有启动的分派",
  inspect_call_quota_ledger: "核对额度记账(mcp-admin)", review_explicit_call_budget: "决定是否追加额度",
  inspect_storage_before_new_work: "先腾出磁盘空间再派新任务", inspect_storage_observation: "检查数据盘",
  review_fleet_action: "在面板全局视图核对受阻操作", check_peer_then_resume_same_action: "检查对端电脑后重发原操作",
  review_scheduler_stop_evidence: "核对调度器的停止证明", review_node_stop_evidence: "核对节点运行器的停止证明",
  inspect_scheduler_owner: "检查调度器进程(node cli/node-runtime.mjs status)", inspect_node_runtime: "检查节点运行器(node cli/node-runtime.mjs status)",
  inspect_scheduler_lock: "检查调度器运行锁", inspect_node_lock: "检查节点运行锁",
  verify_stop_before_lock_recovery: "确认进程已停止,再恢复运行锁",
  inspect_node_sync_then_peer: "检查本机同步和对端", inspect_sync_backlog: "查看同步积压(面板全局视图)",
  check_local_clock: "核对两台电脑的系统时间", review_epoch_recovery: "核对代次恢复记录",
};

main();
