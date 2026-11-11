// md 交接(公告板 v3 第 3 波):给只会读写文件的 AI 用 —— 卡面导出成一份 md、一份 md 队列文件批量挂卡。
//   导出:GET  /api/tasks/:id/export-md   一张卡一节;目标号 = 目标(写在文件头)+ 全部直接子卡,一卡一节。
//         全部文字先去控制字符,再过 redactText(遮掉令牌、长 ID / 哈希、私有路径、反引号里的命令)。
//   导入:POST /api/tasks/import-md { text, line?, goal? }   一律未放行(由操作者在面板放行);
//         任何一节解析失败 = 整份拒绝并逐条给出行号,不部分导入;同一内容(标题 + 说明 + 验收 + 线 + 依赖 + 目标)
//         再导一次不重复建卡,回已存在的卡号(内容哈希存在 md_imports 表)。
//   回报:board.py report-md = 现有 done 的别名(执行者 report,四节证据合同照旧),这里不另开接口。
// 格式全文见 docs/接入说明.md「只会读写文件的 AI」一节。
import { createHash } from "node:crypto";
import { redactText } from "./flow.mjs";

export const MAX_TEXT = 256 * 1024;      // 一份队列文件的上限(字符)
export const MAX_SECTIONS = 100;          // 一份文件最多挂这么多张卡
const SUBJECT_MAX = 200;

// 小节名 → 卡面字段。导出才有的小节(回报 / 裁定)导入时跳过,往返不报错。
const FIELD_OF = { "说明": "description", "验收": "acceptance", "线": "line", "依赖": "deps" };
const EXPORT_ONLY = new Set(["回报", "裁定"]);

/** 只清字符、不改语义:换行与制表保留;别的控制字符、行/段分隔符(换成换行)、零宽、双向控制符、BOM 去掉。 */
export function cleanBlock(s) {
  let out = "";
  for (const ch of String(s ?? "").replace(/\r\n?/g, "\n")) {
    const c = ch.codePointAt(0);
    if (c === 0x0a || c === 0x09) out += ch;
    else if (c === 0x2028 || c === 0x2029) out += "\n";
    else if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x061c || c === 0x180e || (c >= 0x200b && c <= 0x200f) ||
             (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff || (c >= 0xfff9 && c <= 0xfffb)) continue;
    else out += ch;
  }
  return out;
}
/** 导出用:清字符 + 遮蔽。 */
const safe = (s) => redactText(cleanBlock(s));
/** 正文里以 # 开头的行加反斜杠,导入时去掉 —— 正文不会被当成节或小节的标题。 */
const escapeBody = (s) => String(s).split("\n").map((l) => /^\s{0,3}#/.test(l) ? "\\" + l.replace(/^\s+/, "") : l).join("\n");
const unescapeLine = (l) => l.replace(/^\\(?=#)/, "");
const trimBlock = (lines) => { const a = [...lines]; while (a.length && !a[0].trim()) a.shift(); while (a.length && !a.at(-1).trim()) a.pop(); return a.join("\n"); };

/** 解析一份队列文件。→ { sections:[{ line_no, subject, description, acceptance, line, deps:[{id}|{title,line_no}] }], errors:[{line, error}] }
 *  第一个「## 」之前是文件说明(随便写,导入时不读);每节 = 「## 标题」+ 「### 说明」「### 验收」(必有)+ 可选「### 线」「### 依赖」。
 *  标题与第一个小节之间只能空着或写引用行(「> 」开头,导出的卡面信息);``` 围起来的代码块里的 # 不算标题。 */
export function parseQueueMd(textRaw) {
  const errors = [], sections = [];
  const text = cleanBlock(textRaw);
  if (text.length > MAX_TEXT) return { sections, errors: [{ line: 1, error: `文件超过 ${MAX_TEXT / 1024} KB` }] };
  const lines = text.split("\n");
  let sec = null, sub = null, fence = false;
  const close = () => {
    if (!sec) return;
    if (sub) sec.parts[sub.name] = trimBlock(sub.body);
    sub = null;
    const s = sec; sections.push(s); sec = null;
    const bad = (msg, at = s.line_no) => errors.push({ line: at, error: `「${s.subject || "(无标题)"}」:${msg}` });
    if (!s.subject) bad("标题是空的");
    else if (s.subject.length > SUBJECT_MAX) bad(`标题超过 ${SUBJECT_MAX} 字`);
    for (const need of ["说明", "验收"]) if (!s.parts[need]) bad(`缺「### ${need}」小节或内容为空`);
    if (s.parts["线"] !== undefined) {
      const ln = s.parts["线"].trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(ln)) bad(`「线」要写一条线名(小写字母/数字/-/_),收到 ${JSON.stringify(ln.slice(0, 40))}`, s.at["线"]);
    }
    s.deps = [];
    if (s.parts["依赖"] !== undefined) {
      for (const raw of s.parts["依赖"].split(/[\n,，、]/)) {
        const item = raw.replace(/^\s*[-*]\s+/, "").trim();
        if (!item) continue;
        const num = /^#(\d{1,9})$/.exec(item);
        s.deps.push(num ? { id: Number(num[1]) } : { title: item });
      }
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], no = i + 1;
    if (/^\s{0,3}(```|~~~)/.test(raw)) fence = !fence;
    const h2 = !fence && /^## (?!#)(.*)$/.exec(raw), h3 = !fence && /^### (?!#)(.*)$/.exec(raw);
    if (h2) {
      close();
      if (sections.length >= MAX_SECTIONS) { errors.push({ line: no, error: `一份文件最多 ${MAX_SECTIONS} 节` }); break; }
      sec = { line_no: no, subject: h2[1].trim(), parts: {}, at: {} };
      continue;
    }
    if (!sec) continue;                                     // 文件说明:不读
    if (h3) {
      if (sub) sec.parts[sub.name] = trimBlock(sub.body);
      const name = h3[1].trim();
      if (!FIELD_OF[name] && !EXPORT_ONLY.has(name)) {
        errors.push({ line: no, error: `「${sec.subject}」:不认识的小节「${name}」(只认 说明 / 验收 / 线 / 依赖)` });
        sub = { name: "\u0000skip", body: [] }; continue;
      }
      if (sec.parts[name] !== undefined || sec.at[name]) errors.push({ line: no, error: `「${sec.subject}」:小节「${name}」写了两次` });
      sec.at[name] = no;
      sub = { name: EXPORT_ONLY.has(name) ? "\u0000skip" : name, body: [] };
      continue;
    }
    if (!sub) {
      if (raw.trim() && !/^\s*>/.test(raw)) errors.push({ line: no, error: `「${sec.subject}」:标题与第一个小节之间只能空着(或写「> 」开头的引用行)` });
      continue;
    }
    sub.body.push(unescapeLine(raw));
  }
  if (fence) errors.push({ line: lines.length, error: "代码块(```)没有闭合" });
  close();
  for (const s of sections) { delete s.parts["\u0000skip"]; }
  if (!sections.length && !errors.length) errors.push({ line: 1, error: "文件里没有任何「## 标题」节" });
  return { sections: sections.map((s) => ({ line_no: s.line_no, subject: s.subject, description: s.parts["说明"] ?? "",
    acceptance: s.parts["验收"] ?? "", line: s.parts["线"] !== undefined ? s.parts["线"].trim() : null, deps: s.deps, dep_line: s.at["依赖"] ?? s.line_no })),
    errors: errors.sort((a, b) => a.line - b.line) };
}

/** 一节的内容哈希:标题 + 说明 + 验收 + 实际落到的线 + 解析后的依赖卡号 + 目标。 */
export function sectionHash({ subject, description, acceptance, line, deps, goal }) {
  return createHash("sha256").update(JSON.stringify(["md-import:v1", subject, description, acceptance, line ?? null,
    [...deps].sort((a, b) => a - b), goal ?? null])).digest("hex");
}

export function openMdHandoff({ db, store, lines = () => [] }) {
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS md_imports (
      hash TEXT PRIMARY KEY, task_id INTEGER NOT NULL, at TEXT NOT NULL)`);
  }
  const err = (msg, extra = {}) => Object.assign(store.err(store.ERR.BAD_INPUT, msg), extra);

  /** 导入。→ { created:[{id,subject,line_no}], existing:[{id,subject,line_no}] };解析 / 校验失败抛 BAD_INPUT,带 errors[]。 */
  function importMd({ text, line = null, goal = null, actor = "operator" }) {
    if (typeof text !== "string" || !text.trim()) throw err("text 要是一份 md 文件的全文");
    if (line != null && (typeof line !== "string" || !lines().includes(line))) throw err(`--line ${JSON.stringify(line)} 不是这块看板上的线`);
    let goalId = null;
    if (goal != null) {
      goalId = Number(goal);
      const g = Number.isInteger(goalId) && goalId > 0 ? store.get(db, goalId) : null;
      if (!g) throw err(`--goal #${goal} 不存在`);
      if (g.archived_at) throw err(`--goal #${goal} 已归档`);
    }
    const { sections, errors } = parseQueueMd(text);
    const titleAt = new Map();
    sections.forEach((s, i) => {
      const eff = s.line ?? line;
      if (eff != null && !lines().includes(eff)) errors.push({ line: s.line_no, error: `「${s.subject}」:线 ${eff} 不在这块看板上` });
      for (const d of s.deps) {
        if (d.id != null) {
          const t = store.get(db, d.id);
          if (!t) errors.push({ line: s.dep_line, error: `「${s.subject}」:依赖的 #${d.id} 不存在` });
          else if (t.archived_at) errors.push({ line: s.dep_line, error: `「${s.subject}」:依赖的 #${d.id} 已归档` });
        } else if (!titleAt.has(d.title)) {
          errors.push({ line: s.dep_line, error: `「${s.subject}」:依赖「${d.title}」要么写 #卡号,要么写本文件里排在它前面的节标题` });
        }
      }
      if (titleAt.has(s.subject)) errors.push({ line: s.line_no, error: `「${s.subject}」:本文件里已有同名的节(第 ${sections[titleAt.get(s.subject)].line_no} 行)` });
      else titleAt.set(s.subject, i);
    });
    if (errors.length) throw err(`md 文件有 ${errors.length} 处问题,整份没有导入`, { errors: errors.sort((a, b) => a.line - b.line) });

    const created = [], existing = [], idOf = new Map();
    const findStmt = db.prepare("SELECT task_id FROM md_imports WHERE hash=?");
    const putStmt = db.prepare("INSERT INTO md_imports (hash, task_id, at) VALUES (?,?,?) ON CONFLICT(hash) DO UPDATE SET task_id=excluded.task_id, at=excluded.at");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const s of sections) {
        const deps = s.deps.map((d) => d.id ?? idOf.get(d.title));
        const eff = s.line ?? line;
        const hash = sectionHash({ subject: s.subject, description: s.description, acceptance: s.acceptance, line: eff, deps, goal: goalId });
        const prior = findStmt.get(hash);
        const still = prior && store.get(db, Number(prior.task_id));
        if (still) { idOf.set(s.subject, still.id); existing.push({ id: still.id, subject: still.subject, line_no: s.line_no }); continue; }
        const id = store.add(db, { subject: s.subject, description: s.description, acceptance: s.acceptance,
          ...(eff ? { line: eff } : {}), blockedBy: deps, ...(goalId ? { parentId: goalId } : {}), released: 0, actor });
        putStmt.run(hash, id, new Date().toISOString());
        idOf.set(s.subject, id); created.push({ id, subject: s.subject, line_no: s.line_no });
      }
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      // 建卡时被库拒绝(如同一目标下已有同名子卡):整份回滚,点名是哪一节。
      const at = sections[created.length + existing.length];
      if (at && !e.errors) e.errors = [{ line: at.line_no, error: `「${at.subject}」:${e.message}` }];
      throw e;
    }
    return { created, existing };
  }

  const recordsStmt = db.prepare("SELECT at, actor, kind, detail FROM task_events WHERE task_id=? AND kind IN ('evidence.recorded','decision.recorded') ORDER BY id");
  const kidsStmt = db.prepare("SELECT id FROM tasks WHERE parent_id=? ORDER BY id");
  const VERDICT = { approve: "通过", reject: "打回" };
  const OUTCOME = { done: "交付", wait: "等你决定" };
  const at16 = (s) => String(s || "").replace("T", " ").slice(0, 16);

  function section(t) {
    const out = [`## ${safe(t.subject).replace(/\n/g, " ")}`, ""];
    const meta = [`卡号 #${t.id}`, `状态 ${store.STATUS_LABEL[t.status] || t.status}` +
      (t.status === "waiting" && t.waiting_for ? `/${store.WF_LABEL[t.waiting_for] || t.waiting_for}` : ""),
      t.released ? "已放行" : "未放行", ...(t.archived_at ? ["已归档"] : [])];
    out.push(`> ${meta.join(" · ")}`, "");
    out.push("### 说明", "", escapeBody(safe(t.description || t.summary || "").trim() || "(未写)"), "");
    out.push("### 验收", "", escapeBody(safe(t.acceptance || "").trim() || "(未写)"), "");
    if (t.line) out.push("### 线", "", t.line, "");
    let deps = t.blocked_by;
    if (!Array.isArray(deps)) { try { deps = JSON.parse(deps || "[]"); } catch { deps = []; } }
    if (!Array.isArray(deps)) deps = [];
    if (deps.length) out.push("### 依赖", "", deps.map((d) => `#${Number(d)}`).join(", "), "");
    const ev = [], dec = [];
    for (const r of recordsStmt.all(t.id)) {
      let d = {}; try { d = JSON.parse(r.detail || "{}"); } catch {}
      if (r.kind === "evidence.recorded") {
        if (!String(d.evidence ?? "").trim()) continue;
        ev.push([`#### 第 ${ev.length + 1} 次 · ${at16(r.at)} · ${safe(d.worker || r.actor || "-")} · ${OUTCOME[d.outcome] || safe(d.outcome || d.source || "-")}`, "",
          escapeBody(safe(d.evidence).trim()), ""]);
      } else {
        const note = String(d.note ?? "").trim();
        const verdict = VERDICT[d.verdict] || (d.verdict ? safe(d.verdict) : "裁定");
        if (!note && !d.verdict) continue;
        dec.push([`#### 第 ${dec.length + 1} 次 · ${at16(r.at)} · ${safe(d.resolved_by || r.actor || "-")} · ${verdict}`, "",
          note ? escapeBody(safe(note)) : "(没写说明)", ""]);
      }
    }
    if (ev.length) out.push("### 回报", "", ...ev.flat());
    if (dec.length) out.push("### 裁定", "", ...dec.flat());
    return out.join("\n");
  }

  /** 导出。目标号 → 文件头写目标,下面一卡一节(全部直接子卡,含已归档的,卡面上标出)。 */
  function exportMd(id) {
    const t = store.get(db, Number(id));
    if (!t) return null;
    const now = new Date().toISOString();
    const head = ["<!-- 看板 md 交接文件。导入:python cli/board.py import-md <本文件> [--line 线] [--goal 目标号];" +
      "导入一律未放行。「回报」「裁定」小节导入时跳过。 -->"];
    if (t.kind === "goal") {
      const kids = kidsStmt.all(t.id).map((r) => store.get(db, Number(r.id))).filter(Boolean);
      head.push(`# 目标 #${t.id}:${safe(t.subject).replace(/\n/g, " ")}`, "",
        `> 导出于 ${at16(now)} · 直接子卡 ${kids.length} 张 · 令牌、长 ID、私有路径已遮掉`, "");
      const goalText = safe(t.description || t.summary || "").trim();
      if (goalText) head.push(escapeBody(goalText), "");
      if ((t.acceptance || "").trim()) head.push("目标验收:", "", escapeBody(safe(t.acceptance).trim()), "");
      return [...head, ...kids.map(section)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    }
    head.push(`# 卡 #${t.id}`, "", `> 导出于 ${at16(now)} · 令牌、长 ID、私有路径已遮掉`, "");
    return [...head, section(t)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  return { migrate, importMd, exportMd };
}
