// `node cli/stop.mjs [--force]` (= npm run stop) — stop the board on this machine, the way
// Ctrl+C would: lines stop with their intent kept, so the next start brings them back.
// A card in flight would be interrupted (it returns to 「未开始」 and its line claims it
// again later), so that needs --force — the same question the panel's restart asks.
import { boardUp, localBoard, sleep } from "../core/local-board.mjs";

// ⭐ Returns its exit code instead of calling process.exit(): see cli/open.mjs (Node 24 on
//   Windows aborts in libuv when exiting that way after two requests to a running board).
process.exitCode = await main();

async function main() {
  const force = process.argv.includes("--force");
  const { url, token } = localBoard();
  if (!(await boardUp(url))) { console.log(`看板没有在运行:${url}`); return 0; }
  let r;
  try {
    r = await fetch(url + "/api/setup/stop", { method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "X-Board-Token": token(), "Content-Type": "application/json" }, body: JSON.stringify({ force }) });
  } catch (e) { console.error(`没有停下:${e.message}`); return 1; }
  const v = await r.json().catch(() => ({}));
  if (r.status === 409 && v.needs_force) {
    console.log(`${v.error}\n仍要停止:node cli/stop.mjs --force`);
    return 1;
  }
  if (r.status !== 202) { console.error(`没有停下，看板返回 ${r.status}:${v.error || "没有接受停止请求"}`); return 1; }
  for (let waited = 0; waited < 20_000; waited += 300) {
    await sleep(300);
    if (!(await boardUp(url, 800))) { console.log("看板已停止。再启动:node cli/start.mjs --background"); return 0; }
  }
  console.error(`看板已接受停止请求，20 秒后 ${url} 仍在应答。下一步:node cli/status.mjs --log`);
  return 1;
}
