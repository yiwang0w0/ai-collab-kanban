// 本机桌面端对话清单(只读)+ 操作者勾选「要整合的对话」(只存 {source,id,added_at})。
// 两个来源:
//   claude = <projects 根>/<项目目录>/<uuid>.jsonl(只看第一层,子代理的 <uuid>/subagents/… 不算对话)
//   codex  = <codex 根>/sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl,标题取 <codex 根>/session_index.jsonl
// 只读纪律:
//   · 不写这两个根下的任何文件;不返回正文,只回标题(截断到 80 字)与元数据。
//   · 不跟随链接:readdir 的 Dirent 是符号链接 / 联接的一律跳过,文件用 lstat;目录再用 realpath 核一次仍在根内。
//   · 不整读:先按 mtime 排序、按 days 筛,再按需读「头 64KB + 尾 512KB」;读过的按 (mtime,size) 缓存。
// ⚠ 标题来源(实测格式,2026-11):Claude 的 custom-title / ai-title 行随对话反复追加,取最后一条
//   (custom 优先于 ai);都没有 → 首条真人消息兜底。Codex 用 session_index 里同 id 的最后一条 thread_name,
//   没有 → 首条 user_message 兜底。
import { readdirSync, lstatSync, realpathSync, openSync, readSync, closeSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, sep } from "node:path";

export const SOURCES = ["claude", "codex"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 实测两种文件名:rollout-<时刻>-<id>.jsonl 与 rollout-<时刻>-<id>_<另一 uuid>.jsonl(id 都是第一个,与 session_meta.id 一致)
const CODEX_FILE = /^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.jsonl$/i;
const HEAD = 64 * 1024, TAIL = 512 * 1024, CODEX_META_MAX = 1024 * 1024;
const TITLE_MAX = 80, CACHE_MAX = 5000;
export const LIMIT_DEFAULT = 50, LIMIT_MAX = 200, SELECTED_MAX = 50;

const clip = (s) => {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return null;
  const cps = [...t];
  return cps.length > TITLE_MAX ? cps.slice(0, TITLE_MAX).join("") : t;
};
/** 首条消息兜底:跳过 <command-name>…、<system-reminder>…、<environment_context>… 这类注入块。 */
const humanText = (s) => (typeof s === "string" && s.trim() && !s.trim().startsWith("<") ? clip(s) : null);

function readRange(path, start, len) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
}
const lines = (text) => text.split("\n");
const parse = (ln) => { if (!ln || !ln.trim()) return null; try { const d = JSON.parse(ln); return d && typeof d === "object" ? d : null; } catch { return null; } };

/** 目录项:只要真目录 / 真文件,链接一律不碰。 */
function entries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return null; }
}
function inside(root, dir) {
  try { const r = realpathSync(root), d = realpathSync(dir); return d === r || d.startsWith(r.endsWith(sep) ? r : r + sep); }
  catch { return false; }
}

// ── Claude
function scanClaude(root) {
  const top = entries(root);
  if (!top) return null;
  const out = [];
  for (const d of top) {
    if (!d.isDirectory() || d.isSymbolicLink()) continue;
    const dir = join(root, d.name);
    if (!inside(root, dir)) continue;
    for (const f of entries(dir) || []) {
      if (!f.isFile() || f.isSymbolicLink() || !f.name.endsWith(".jsonl")) continue;
      const id = f.name.slice(0, -6);
      if (!UUID.test(id)) continue;
      const path = join(dir, f.name);
      let st; try { st = lstatSync(path); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ source: "claude", id: id.toLowerCase(), path, dirName: d.name, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}
function claudeMeta(f) {
  let custom = null, ai = null, first = null, project = null, origin = null, tokens = null;
  const headText = readRange(f.path, 0, Math.min(HEAD, f.size));
  for (const ln of lines(headText)) {
    const d = parse(ln); if (!d) continue;
    if (!project && typeof d.cwd === "string") project = d.cwd;
    if (!origin && typeof d.entrypoint === "string") origin = d.entrypoint;
    if (d.type === "custom-title") custom = clip(d.customTitle) || custom;
    if (d.type === "ai-title") ai = clip(d.aiTitle) || ai;
    if (!first && d.type === "user" && !d.isMeta && !d.toolUseResult && !d.isCompactSummary && !d.isSidechain) {
      const c = d.message?.content;
      if (typeof c === "string") first = humanText(c);
      else if (Array.isArray(c)) for (const b of c) if (!first && b?.type === "text") first = humanText(b.text);
    }
  }
  if (f.size > HEAD) {
    const start = Math.max(HEAD, f.size - TAIL);
    const tailText = readRange(f.path, start, f.size - start);
    const tailLines = lines(tailText);
    if (start > HEAD) tailLines.shift();               // 第一行可能被截断
    // 头 64KB 被超长行占满时,cwd / entrypoint 从尾部任一行取(每条消息行都带)
    if (!project) { const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(tailText); if (m) { try { project = JSON.parse(m[1]); } catch {} } }
    if (!origin) { const m = /"entrypoint":"([a-z0-9_-]{1,40})"/i.exec(tailText); if (m) origin = m[1]; }
    for (const ln of tailLines) {
      if (!ln.includes('"type":"custom-title"') && !ln.includes('"type":"ai-title"') && !ln.includes('"usage"')
          && !ln.includes("compact_boundary")) continue;
      const d = parse(ln); if (!d) continue;
      if (d.type === "custom-title") custom = clip(d.customTitle) || custom;
      else if (d.type === "ai-title") ai = clip(d.aiTitle) || ai;
      else if (d.subtype === "compact_boundary") tokens = null;
      else if (d.type === "assistant" && d.message?.usage) tokens = usageTokens(d.message.usage);
    }
  } else {
    for (const ln of lines(headText)) {
      const d = parse(ln);
      if (d?.subtype === "compact_boundary") tokens = null;
      else if (d?.type === "assistant" && d.message?.usage) tokens = usageTokens(d.message.usage);
    }
  }
  return { title: custom || ai || first, project: project || f.dirName, origin, approx_tokens: tokens };
}
const usageTokens = (u) => {
  const n = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ── Codex
function scanCodex(root) {
  const sessions = join(root, "sessions");
  if (!entries(sessions)) return null;
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4 || !inside(sessions, dir)) return;
    for (const e of entries(dir) || []) {
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      const m = CODEX_FILE.exec(e.name); if (!m) continue;
      let st; try { st = lstatSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ source: "codex", id: m[1].toLowerCase(), path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  walk(sessions, 0);
  return out;
}
let codexIndex = { key: null, map: new Map() };
function codexTitles(root) {
  const p = join(root, "session_index.jsonl");
  let st; try { st = lstatSync(p); } catch { return new Map(); }
  if (!st.isFile()) return new Map();
  const key = `${p}|${st.mtimeMs}|${st.size}`;
  if (codexIndex.key === key) return codexIndex.map;
  const map = new Map();
  try {
    for (const ln of lines(readFileSync(p, "utf8"))) {
      const d = parse(ln);
      if (d && typeof d.id === "string" && UUID.test(d.id)) { const t = clip(d.thread_name); if (t) map.set(d.id.toLowerCase(), t); }
    }
  } catch {}
  codexIndex = { key, map };
  return map;
}
function codexMeta(f, titles) {
  // 首行 session_meta 可能带几十 KB 的 base_instructions:读到第一个换行为止(上限 1MB)
  let text = readRange(f.path, 0, Math.min(f.size, CODEX_META_MAX));
  const nl = text.indexOf("\n");
  const meta = parse(nl >= 0 ? text.slice(0, nl) : text);
  const pl = meta?.type === "session_meta" ? meta.payload || {} : {};
  const sub = (pl.source && typeof pl.source === "object" && "subagent" in pl.source)
              || pl.thread_source === "subagent" || pl.thread_source === "guardian_review";
  let first = null;
  for (const ln of lines(text.slice(0, HEAD + Math.max(nl, 0)))) {
    if (first) break;
    if (!ln.includes("user_message")) continue;
    const d = parse(ln);
    if (d?.type === "event_msg" && d.payload?.type === "user_message") first = humanText(d.payload.message);
  }
  let tokens = null;
  const start = Math.max(0, f.size - TAIL);
  const tl = lines(readRange(f.path, start, f.size - start)); if (start > 0) tl.shift();
  for (const ln of tl) {
    if (!ln.includes("token_count")) continue;
    const d = parse(ln);
    const u = d?.payload?.type === "token_count" ? d.payload.info?.last_token_usage : null;
    if (u && Number.isFinite(u.input_tokens) && u.input_tokens > 0) tokens = u.input_tokens;
  }
  return { title: titles.get(f.id) || first, project: typeof pl.cwd === "string" ? pl.cwd : null,
           origin: typeof pl.thread_source === "string" ? pl.thread_source : null, approx_tokens: tokens, subagent: !!sub };
}

// ── 历史消息(只读)
const MSG_TEXT_MAX = 4000, MSG_CHUNK = 1024 * 1024, MSG_SCAN_MAX = 32 * 1024 * 1024;
export const MSG_LIMIT_DEFAULT = 50, MSG_LIMIT_MAX = 200;
function readBuf(path, start, len) {
  const fd = openSync(path, "r");
  try { const buf = Buffer.alloc(len); const n = readSync(fd, buf, 0, len, start); return buf.subarray(0, n); }
  finally { closeSync(fd); }
}
const msgText = (s) => { const cps = [...String(s).trim()]; return cps.length > MSG_TEXT_MAX ? cps.slice(0, MSG_TEXT_MAX).join("") : cps.join(""); };
const stamp = (d) => (typeof d.timestamp === "string" ? d.timestamp : null);
const visible = (t) => typeof t === "string" && t.trim() && !t.trim().startsWith("<");
/** Claude 一行 → {role,text,at,tools} | {tools:n}(只有工具调用) | null */
function claudeMsg(d) {
  if (d.isSidechain) return null;
  if (d.type === "user") {
    if (d.isMeta || d.isCompactSummary || d.toolUseResult) return null;
    const c = d.message?.content;
    const parts = typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text) : [];
    const text = parts.filter(visible).join("\n");
    return text ? { role: "user", text: msgText(text), at: stamp(d), tools: 0 } : null;
  }
  if (d.type === "assistant") {
    const c = Array.isArray(d.message?.content) ? d.message.content : [];
    const tools = c.filter((b) => b?.type === "tool_use" || b?.type === "server_tool_use").length;
    const text = c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
    if (text) return { role: "assistant", text: msgText(text), at: stamp(d), tools };
    return tools ? { tools } : null;
  }
  return null;
}
const CODEX_TOOL_ITEMS = new Set(["function_call", "custom_tool_call", "tool_search_call", "local_shell_call", "web_search_call"]);
/** Codex 一行(response_item)→ 同上形 */
function codexMsg(d) {
  if (d.type !== "response_item" || !d.payload) return null;
  const p = d.payload;
  if (CODEX_TOOL_ITEMS.has(p.type)) return { tools: 1 };
  if (p.type !== "message" || (p.role !== "user" && p.role !== "assistant")) return null;
  const want = p.role === "user" ? "input_text" : "output_text";
  const text = (Array.isArray(p.content) ? p.content : []).filter((b) => b?.type === want).map((b) => b.text)
    .filter(visible).join("\n").trim();
  return text ? { role: p.role, text: msgText(text), at: stamp(d), tools: 0 } : null;
}

// ── 桌面会话登记成线的继承表:数据目录(不进 git),运行时增删;手写的 lineage.json 由看板另读、照旧生效
export const DESK_LINEAGE_FILE = "desktop_lineage.json";
/** → { <线 id>: { session, source, label, created_at } };坏文件 / 坏项一律忽略。 */
export function loadDeskLineage(dataDir) {
  const out = {};
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, DESK_LINEAGE_FILE), "utf8"));
    for (const [k, v] of Object.entries(raw?.lines || {}))
      if (/^[a-z0-9][a-z0-9_-]{0,31}$/.test(k) && v && SOURCES.includes(v.source) && typeof v.session === "string" && UUID.test(v.session))
        out[k] = { session: v.session.toLowerCase(), source: v.source, label: typeof v.label === "string" ? v.label : "",
                   created_at: typeof v.created_at === "string" ? v.created_at : null, via: "desktop" };
  } catch {}
  return out;
}
export function saveDeskLineage(dataDir, lines) {
  const file = join(dataDir, DESK_LINEAGE_FILE), tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify({ version: 1, lines }, null, 1), "utf8");
  renameSync(tmp, file);
}

/**
 * opts: { claudeRoot, codexRoot, dataDir }
 * 返回 { list, select }。
 */
export function createDesktopSessions({ claudeRoot, codexRoot, dataDir }) {
  const cache = new Map();   // path -> { mtimeMs, size, meta }
  const SEL_FILE = join(dataDir, "desktop_sessions_selected.json");

  const metaOf = (f, titles) => {
    const c = cache.get(f.path);
    if (c && c.mtimeMs === f.mtimeMs && c.size === f.size) return c.meta;
    let meta;
    try { meta = f.source === "claude" ? claudeMeta(f) : codexMeta(f, titles); }
    catch { meta = { title: null, project: null, origin: null, approx_tokens: null, unreadable: true }; }
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, meta });
    return meta;
  };
  // Codex 的标题来自索引,索引变了缓存里的标题就旧了:取标题时再按索引覆盖一次
  const titled = (f, meta, titles) => (f.source === "codex" && titles.get(f.id) ? { ...meta, title: titles.get(f.id) } : meta);

  function scan(sources) {
    const files = [], unavailable = [];
    for (const s of sources) {
      const got = s === "claude" ? scanClaude(claudeRoot) : scanCodex(codexRoot);
      if (got === null) unavailable.push({ source: s, reason: s === "claude" ? "找不到 Claude 对话目录" : "找不到 Codex 对话目录" });
      else files.push(...got);
    }
    return { files, unavailable };
  }

  // ── 勾选存取
  function loadSelected() {
    try {
      const raw = JSON.parse(readFileSync(SEL_FILE, "utf8"));
      const items = Array.isArray(raw?.items) ? raw.items : [];
      return items.filter((x) => x && SOURCES.includes(x.source) && typeof x.id === "string" && UUID.test(x.id))
                  .map((x) => ({ source: x.source, id: x.id.toLowerCase(), added_at: typeof x.added_at === "string" ? x.added_at : null }));
    } catch { return []; }
  }
  function saveSelected(items) {
    const tmp = SEL_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 1), "utf8");
    renameSync(tmp, SEL_FILE);
  }
  const keyOf = (x) => `${x.source}:${x.id}`;

  function row(f, meta, selected, line = null) {
    return { source: f.source, id: f.id, title: meta.title ?? null, project: meta.project ?? null,
             updated_at: new Date(f.mtimeMs).toISOString(), size_bytes: f.size, approx_tokens: meta.approx_tokens ?? null,
             origin: meta.origin ?? null, selected, line };
  }

  /** { source:"claude"|"codex"|"all", days:number|null, q:string|null, limit:number, selectedOnly:boolean,
   *    lineOf:(source,id)=>string|null —— 已登记成哪条线(看板的继承表给) } */
  function list({ source = "all", days = null, q = null, limit = LIMIT_DEFAULT, selectedOnly = false, lineOf = () => null } = {}) {
    const sources = source === "all" ? SOURCES : [source];
    const { files, unavailable } = scan(sources);
    const titles = sources.includes("codex") ? codexTitles(codexRoot) : new Map();
    const sel = loadSelected();
    const selKeys = new Set(sel.map(keyOf));
    const needle = q ? q.toLowerCase() : null;
    const cutoff = days != null && !selectedOnly ? Date.now() - days * 86400000 : -Infinity;
    const pool = files.filter((f) => f.mtimeMs >= cutoff && (!selectedOnly || selKeys.has(keyOf(f))))
                      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out = [];
    let truncated = false;
    for (const f of pool) {
      const meta = titled(f, metaOf(f, titles), titles);
      if (meta.subagent) continue;
      if (needle && !(meta.title || "").toLowerCase().includes(needle)) continue;
      if (out.length >= limit) { truncated = true; break; }
      out.push(row(f, meta, selKeys.has(keyOf(f)), lineOf(f.source, f.id)));
    }
    if (selectedOnly) {
      // 已勾选但文件不在了:照样列出并标 missing,可被取消
      const seen = new Set(pool.map(keyOf));
      for (const x of sel) {
        if (!sources.includes(x.source) || seen.has(keyOf(x))) continue;
        if (needle) continue;                                 // 没有标题可比对
        if (out.length >= limit) { truncated = true; break; }
        out.push({ source: x.source, id: x.id, title: null, project: null, updated_at: null, size_bytes: null,
                   approx_tokens: null, origin: null, selected: true, line: lineOf(x.source, x.id), missing: true });
      }
    }
    return { sessions: out, truncated, unavailable };
  }

  /** 本机确实存在、且是会出现在清单里的对话(Codex 子代理线程不算)。 */
  function locate(source, id) {
    if (!SOURCES.includes(source) || typeof id !== "string" || !UUID.test(id)) return null;
    const { files } = scan([source]);
    const f = files.find((x) => x.id === id.toLowerCase());
    if (!f) return null;
    const titles = source === "codex" ? codexTitles(codexRoot) : new Map();
    const meta = titled(f, metaOf(f, titles), titles);
    return meta.subagent ? null : { file: f, meta };
  }
  const exists = (source, id) => !!locate(source, id);
  /** 清单里的那一行(登记成线时看体量用;不含正文)。 */
  function info(source, id) {
    const hit = locate(source, id);
    return hit ? row(hit.file, hit.meta, false) : null;
  }

  /**
   * 只读看历史:从 before(字节位置,缺省 = 文件尾)往前读,凑够 limit 条 user / assistant 文字,按时间正序返回。
   * 工具调用折叠进它前面那条 assistant 的 tools 计数(前面没有 assistant 文字时补一条空文字的);
   * 工具结果、元消息、<…> 注入块、思考一律不给。游标是字节位置:会话文件只追加,位置在之后的追加下仍有效。
   * 正文只在内存里过一遍:不缓存、不写日志、不落盘。
   */
  function messages(source, id, { limit = 50, before = null } = {}) {
    const hit = locate(source, id);
    if (!hit) return null;
    const f = hit.file;
    if (before != null && (!Number.isInteger(before) || before <= 0 || before > f.size))
      throw Object.assign(new Error("before 游标无效(要用上一页给的 next_before)"), { status: 400 });
    const conv = source === "claude" ? claudeMsg : codexMsg;
    const out = [];                       // 倒序收集
    let pending = 0;                      // 已见到、还没归到某条 assistant 上的工具调用数
    const flush = () => { if (pending) { out.push({ role: "assistant", text: "", at: null, tools: pending }); pending = 0; } };
    let pos = before ?? f.size, tail = Buffer.alloc(0), scanned = 0;
    for (;;) {
      if (scanned >= MSG_SCAN_MAX) { flush(); return { messages: out.reverse(), next_before: pos + tail.length || null }; }
      const start = Math.max(0, pos - MSG_CHUNK);
      const buf = Buffer.concat([readBuf(f.path, start, pos - start), tail]);
      scanned += pos - start;
      const segs = [];
      let s0 = 0;
      for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) { segs.push([s0, i]); s0 = i + 1; }
      segs.push([s0, buf.length]);
      const first = start > 0 ? 1 : 0;    // start>0 时第一段是半行,留到下一块拼完整
      for (let k = segs.length - 1; k >= first; k--) {
        const [a, b] = segs[k];
        if (b <= a) continue;
        const d = parse(buf.subarray(a, b).toString("utf8"));
        const m = d ? conv(d) : null;
        if (!m) continue;
        if (!m.role) { pending += m.tools; continue; }
        if (m.role === "assistant") { out.push({ ...m, tools: m.tools + pending }); pending = 0; }
        else { flush(); out.push(m); }
        if (out.length >= limit) {
          const lineStart = start + a;
          return { messages: out.slice(0, limit).reverse(), next_before: lineStart > 0 ? lineStart : null };
        }
      }
      // 到这里 out 不足 limit 条,flush 最多补 1 条,不会超
      if (start === 0) { flush(); return { messages: out.reverse(), next_before: null }; }
      tail = buf.subarray(segs[0][0], segs[0][1]);
      pos = start;
    }
  }

  /** add/remove: [{source,id}];返回 { selected } 或抛 {status, error}。 */
  function select({ add = [], remove = [] } = {}) {
    const bad = (error) => Object.assign(new Error(error), { status: 400 });
    if (!Array.isArray(add) || !Array.isArray(remove)) throw bad("add 与 remove 必须是数组");
    if (add.length + remove.length > 200) throw bad("一次最多改 200 项");
    const norm = (x, what) => {
      if (!x || typeof x !== "object" || !SOURCES.includes(x.source) || typeof x.id !== "string" || !UUID.test(x.id))
        throw bad(`${what} 的每一项要是 {source:"claude"|"codex", id:<对话 uuid>}`);
      return { source: x.source, id: x.id.toLowerCase() };
    };
    const adds = add.map((x) => norm(x, "add")), removes = remove.map((x) => norm(x, "remove"));
    let items = loadSelected();
    const dropKeys = new Set(removes.map(keyOf));
    items = items.filter((x) => !dropKeys.has(keyOf(x)));
    const have = new Set(items.map(keyOf));
    const fresh = [];
    for (const a of adds) {
      if (have.has(keyOf(a))) continue;                       // 重复 add = 幂等
      if (!exists(a.source, a.id)) throw Object.assign(bad(`本机没有这个对话:${a.source} ${a.id}`), { code: "NOT_FOUND" });
      have.add(keyOf(a)); fresh.push({ ...a, added_at: new Date().toISOString() });
    }
    const next = [...items, ...fresh];
    if (next.length > SELECTED_MAX) throw bad(`最多勾选 ${SELECTED_MAX} 个对话(这次之后会是 ${next.length} 个),先取消一些`);
    const before = loadSelected();
    const changed = before.length !== next.length || before.some((x, i) => keyOf(x) !== keyOf(next[i]));
    if (changed) saveSelected(next);
    return { selected: next.length, changed };
  }

  return { list, select, info, messages };
}
