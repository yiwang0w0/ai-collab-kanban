// 本机看板的运行记录、停机原因与日志摘要。守护（cli/start.mjs）起停各写一笔，cli/status.mjs 只读。
//
// 记录放在 <data>/probes/board_run.json，干净退出标记放在同目录 board_clean_exit.json：执行线的拒绝规则已覆盖 probes 子目录
// （loops/verify_lib.py 的 PROTECTED 含 probes/**），模型读不到也改不了。记录只含枚举值、时间和数字，
// 读取时逐项校验，不合格的部分按「没有记录」处理，不把文件里的文字直接显示给人。
// 写不出来不影响看板启动：调用方一律吞掉写入错误。
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { CODE_ROOT } from "./env.mjs";

const STATES = ["running", "stopped", "exited"];
const FAULT_KINDS = ["exit", "restart_loop", "interrupted"];
const START = "node cli/start.mjs --background";

const iso = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const whole = (v) => (Number.isSafeInteger(v) ? v : null);

/** 数据目录，与 core/local-board.mjs 同一规则；不读配置文件。 */
export const localDataDir = (env = process.env) => env.BOARD_DATA_DIR || join(CODE_ROOT, "core", ".data");
export const runRecordFile = (dataDir) => join(dataDir, "probes", "board_run.json");

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== "ESRCH"; }
}
const bootedAt = () => Date.now() - uptime() * 1000;

// 干净退出标记：看板服务（core/server.mjs）走完自己的停止或重启收尾、调用 process.exit 之前写一笔。
// 是不是正常停止以它为准，不以退出码为准：Windows 上 process.exit 之后 libuv 可能中止，退出码会变；
// 守护也可能在看板收尾之后、写结束之前被结束。守护每次拉起看板前清掉它，所以标记只说明最近一次看板进程。
const CLEAN_KINDS = ["stop", "restart"];
export const cleanExitFile = (dataDir) => join(dataDir, "probes", "board_clean_exit.json");

function readCleanExit(dataDir) {
  let m = null;
  try { m = JSON.parse(readFileSync(cleanExitFile(dataDir), "utf8")); } catch {}
  return m && whole(m.pid) > 0 && iso(m.at) && CLEAN_KINDS.includes(m.kind) ? { pid: m.pid, at: iso(m.at), kind: m.kind } : null;
}

/** 看板服务有序退出前调用。kind: stop 停止 · restart 重启。 */
export function noteCleanExit(dataDir, { pid = process.pid, now = Date.now(), kind } = {}) {
  if (!CLEAN_KINDS.includes(kind)) return false;
  writeJson(cleanExitFile(dataDir), { pid, at: new Date(now).toISOString(), kind });
  return true;
}
export function clearCleanExit(dataDir) { rmSync(cleanExitFile(dataDir), { force: true }); }

/** 记录里这次运行（started_at 之后）有没有干净退出标记。 */
const endedCleanly = (cur, clean) => !!(cur && clean && Date.parse(clean.at) >= Date.parse(cur.started_at));

/** { current, last_fault, clean_exit }，各项各自校验，缺失或不合格为 null。 */
export function readRunRecord(dataDir) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(runRecordFile(dataDir), "utf8")); } catch {}
  const c = raw?.current, f = raw?.last_fault;
  const current = c && whole(c.pid) > 0 && iso(c.started_at) && STATES.includes(c.state)
    ? { pid: c.pid, started_at: iso(c.started_at), state: c.state, ended_at: iso(c.ended_at), exit_code: whole(c.exit_code),
        log_from: whole(c.log_from) >= 0 ? whole(c.log_from) : null } : null;
  const last_fault = f && FAULT_KINDS.includes(f.kind) && iso(f.at)
    ? { kind: f.kind, at: iso(f.at), exit_code: whole(f.exit_code), started_at: iso(f.started_at) } : null;
  return { current, last_fault, clean_exit: readCleanExit(dataDir) };
}

function writeJson(file, value) {
  const tmp = file + ".tmp";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}
const writeRunRecord = (dataDir, record) => writeJson(runRecordFile(dataDir), record);

/** 守护结束时用：这个看板进程有没有走完有序退出。 */
export function cleanExitOf(dataDir, pid) {
  const m = readCleanExit(dataDir);
  return m && m.pid === pid ? m : null;
}

/** 守护启动时记一笔。上一笔还写着「运行中」而进程已不在：那次运行留下了干净退出标记，按正常停止处理；
 *  没有标记，说明没有走到停止，记成一次中断。
 *  另一个守护还活着时不接管它的记录（owned:false），本守护之后也不写结束。 */
export function noteRunStart(dataDir, { pid = process.pid, now = Date.now(), alive = pidAlive, booted = bootedAt(), logFrom = null } = {}) {
  const prev = readRunRecord(dataDir), cur = prev.current;
  let last_fault = prev.last_fault;
  if (cur && cur.state === "running" && cur.pid !== pid) {
    if (Date.parse(cur.started_at) >= booted && alive(cur.pid)) return { owned: false };
    if (!endedCleanly(cur, prev.clean_exit))
      last_fault = { kind: "interrupted", at: new Date(now).toISOString(), exit_code: null, started_at: cur.started_at };
  }
  writeRunRecord(dataDir, { current: { pid, started_at: new Date(now).toISOString(), state: "running", ended_at: null, exit_code: null,
                                       log_from: whole(logFrom) >= 0 ? whole(logFrom) : null }, last_fault });
  return { owned: true };
}

/** 守护结束时记一笔。kind: stopped 正常停止 · exit 非零退出或被结束 · restart_loop 连续重启后放弃。 */
export function noteRunEnd(dataDir, { pid = process.pid, now = Date.now(), kind, code = null } = {}) {
  const prev = readRunRecord(dataDir);
  if (!prev.current || prev.current.pid !== pid || !["stopped", ...FAULT_KINDS].includes(kind)) return false;
  const at = new Date(now).toISOString();
  writeRunRecord(dataDir, {
    current: { ...prev.current, state: kind === "stopped" ? "stopped" : "exited", ended_at: at, exit_code: whole(code) },
    last_fault: kind === "stopped" ? prev.last_fault : { kind, at, exit_code: whole(code), started_at: prev.current.started_at } });
  return true;
}

/** 本地时间的「月-日 时:分」。 */
export function shortTime(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "时间待核实";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一次故障的一句话。 */
export function faultText(f) {
  if (!f) return "没有记录";
  const what = f.kind === "exit" ? (f.exit_code == null ? "看板服务被结束" : `看板服务退出，退出码 ${f.exit_code}`)
    : f.kind === "restart_loop" ? "看板连续请求重启，守护停止重起"
    : "看板运行中断，可能是关机、断电或进程被结束";
  return `${shortTime(f.at)} ${what}`;
}

/** 看板在不在应答：up 正常 · http 有应答但不是看板的正常应答 · refused 端口没有程序监听 · timeout 超时 · unreachable 连不上。 */
export async function probeBoard(url, ms = 1500, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(url + "/health", { signal: AbortSignal.timeout(ms), cache: "no-store" });
    if (r.ok && (await r.json().catch(() => null))?.status === "ok") return { state: "up" };
    return { state: "http", status: r.status };
  } catch (e) {
    const code = e?.cause?.code || e?.code || "";
    if (e?.name === "TimeoutError" || /TIMEOUT/.test(code)) return { state: "timeout" };
    return { state: code === "ECONNREFUSED" ? "refused" : "unreachable" };
  }
}

export function isLoopback(url) {
  try { return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(url).hostname.toLowerCase()); }
  catch { return false; }
}

/** 日志从 from 字节起的最后 n 行；from 为空或超出文件时取末尾 64KB。按字节切，切断的首行丢弃。 */
export function logLines(file, { from = null, n = 30 } = {}) {
  if (!existsSync(file)) return [];
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size, cap = 64 * 1024;
    const start = from != null && from <= size ? Math.max(from, size - cap) : Math.max(0, size - cap);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (start > 0 && start !== from) lines.shift();
    return lines.map((l) => l.trimEnd()).filter(Boolean).slice(-n);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** 连续重复的行合并成一行，带次数。 */
export function collapseRepeats(lines) {
  const out = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && last.line === line) last.count += 1; else out.push({ line, count: 1 });
  }
  return out.map((x) => (x.count > 1 ? `${x.line}  ×${x.count}` : x.line));
}

/** 日志里认得出的启动失败原因；认不出返回 null。日志原文只在「启动被拒绝」里引用一句。 */
export function logHint(lines) {
  for (const line of [...lines].reverse()) {
    const port = /端口 (\d+) 已被占用/.exec(line);
    if (port) return { cause: `端口 ${port[1]} 已被别的程序占用`,
                       next: `关掉占用端口 ${port[1]} 的程序，或在配置里换一个端口，再运行 ${START}` };
    const refused = /拒绝启动[:：]\s*(.+)$/.exec(line);
    if (refused) return { cause: `启动被拒绝：${refused[1].slice(0, 160)}`,
                          next: `按上面这一句修好后运行 ${START}；拿不准就先运行 node cli/doctor.mjs` };
    if (/不再重起/.test(line)) return { cause: "看板连续请求重启，守护停止重起", next: "运行 node cli/status.mjs --log 查看每次重启前的日志" };
  }
  return null;
}

/** 执行线故障按原因合并：同一原因的多条线只出一条，各带一句下一步。纯函数，输入是 /api/workers 的 workers[]。
 *  停止原因的文字取服务端的 stop_text（原因变成文字只有那一处），这里不另译退出码。
 *  本模块不引入数据库，看板起不来时 status 仍能运行。 */
export function mergeLineFaults(workers, { label = (line) => line } = {}) {
  const groups = new Map();
  for (const w of Array.isArray(workers) ? workers : []) {
    if (!w || typeof w.line !== "string" || w.external || w.running) continue;
    const text = typeof w.stop_text === "string" ? w.stop_text.split(" · ")[0].trim() : "";
    const kind = !w.stop_reason && w.exit_code === 3 ? "refused" : w.stop_reason?.reason === "crash" ? "crash" : w.desired_running ? "pending" : null;
    if (!kind) continue;
    const what = kind === "pending" ? "已请求启动，待核实" : text || (kind === "refused" ? "启动被拒绝" : "崩溃"), key = kind + "|" + what;
    if (!groups.has(key)) groups.set(key, { kind, what, lines: [], log: [] });
    const group = groups.get(key);
    group.lines.push(w.line);
    for (const line of Array.isArray(w.last_log) ? w.last_log : [])
      if (typeof line === "string" && line.trim()) group.log.push(label(w.line) + "：" + line.trimEnd());
  }
  const NEXT = { refused: "运行 node cli/doctor.mjs 找出原因，修好后在面板启动执行线",
                 crash: "运行 node cli/status.mjs --log 查看最近日志，修好后在面板启动执行线",
                 pending: "稍后再运行 node cli/status.mjs；仍未运行就在面板重新启动执行线" };
  return [...groups.values()].map((g) => ({ tone: g.kind === "pending" ? "warn" : "bad", where: "执行线",
    what: g.lines.map(label).join("、") + " " + g.what, next: NEXT[g.kind], lines: g.lines, log: g.log }));
}

/** 本机看板没有应答时的一句原因和一句下一步。next 为 null 表示沿用首页的通用下一步。 */
export function downCause({ record, probe, lines = [], logMtime = null, alive = pidAlive, booted = bootedAt() }) {
  const cur = record?.current, hint = logHint(lines);
  const seeLog = "运行 node cli/status.mjs --log 查看日志";
  if (probe.state === "http")
    return { cause: `这个地址返回 HTTP ${probe.status}，不是看板的正常应答`, next: null };
  // 记录写着已结束，日志却在那之后还有新内容：之后看板用别的方式运行过（没有经过守护），这份记录说的不是最近一次。
  if (cur && cur.state !== "running" && cur.ended_at && logMtime != null && logMtime > Date.parse(cur.ended_at) + 5000)
    return { cause: "运行记录之后看板还运行过，最近一次停止的原因没有记录", next: `${seeLog}，再运行 ${START}` };
  if (cur?.state === "running" && Date.parse(cur.started_at) >= booted && alive(cur.pid))
    return probe.state === "timeout"
      ? { cause: `看板进程还在，进程号 ${cur.pid}，但没有应答`, next: `${seeLog}；确认卡住后结束这个进程，再运行 ${START}` }
      : { cause: `守护进程还在，进程号 ${cur.pid}，看板服务暂时没有监听端口`, next: `稍后再运行 node cli/status.mjs；仍然没有应答就${seeLog}` };
  if (cur?.state === "running" && endedCleanly(cur, record?.clean_exit))
    return { cause: `看板已在 ${shortTime(record.clean_exit.at)} 正常停止`, next: null };
  if (cur?.state === "running")
    return { cause: `${shortTime(cur.started_at)} 启动的看板运行中断，可能是关机、断电或进程被结束`, next: null };
  if (cur?.state === "stopped")
    return { cause: `看板已在 ${shortTime(cur.ended_at)} 正常停止`, next: null };
  if (cur?.state === "exited") {
    const exit = cur.exit_code == null ? "被结束" : `退出，退出码 ${cur.exit_code}`;
    return { cause: `看板服务在 ${shortTime(cur.ended_at)} ${exit}` + (hint ? `。${hint.cause}` : ""),
             next: hint?.next || `${seeLog}，修好后运行 ${START}` };
  }
  return hint ? { cause: hint.cause, next: hint.next } : { cause: "没有这块看板的运行记录", next: null };
}
