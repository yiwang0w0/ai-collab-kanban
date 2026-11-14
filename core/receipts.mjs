// 合同 J3(第 9 波 9c)回执:看板发给执行者的东西,对方「拉取过 / 应答里给过 / 确认过」各记一笔。
//   回执只说明发生过这几件事,不说明模型读懂了;措辞一律「拉取过」,不说「读过」。看板不据此放行或拦任何动作。
//   表都在 board.db(不往数据目录写新文件):
//   - card_reads(task_id, executor, spec_version, via, first_at, last_at):执行者令牌 GET /api/tasks/:id 时 upsert(同一〔卡, 执行者, 版本, 来路〕5 秒节流)。
//       via = "card"(读自己线上的卡)| "ref"(绑线执行者经引用读别线的卡,只读视图;记在被读的那张卡上,单列在 ref_reads,不进 read)。
//   - notice_sent(task_id, run_id, code, at):板在心跳应答里给过某条提示即记一笔(同一 run 同一 code 只记第一次)。
//   - notice_acks(task_id, run_id, code, at):心跳带 ack:[code] 时只追加(触发器拒改、拒删)。
//   operator_note:人交回 / 打回 / 裁定时写给执行者的那段话(tasks.last_note,过 redactText),带时刻与种类;桥的 get_card 原样带出。
import { redactText } from "./flow.mjs";

export const NOTICE_CODES = ["superseded", "basis_changed", "refs_stale", "base_gone"];
export const READ_THROTTLE_MS = 5000;
export const OPERATOR_NOTE_MAX = 2000;

const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());

/** 心跳的 ack:不给 / null → null;要数组、≤4 项、每项是四个提示码之一(未知码 → BAD_INPUT,整次心跳不收)。去重保序。 */
export function checkAck(v, badInput) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > NOTICE_CODES.length) throw badInput(`ack 要数组,最多 ${NOTICE_CODES.length} 项`);
  const out = [];
  for (const c of v) {
    if (typeof c !== "string" || !NOTICE_CODES.includes(c)) throw badInput(`ack 只接受 ${NOTICE_CODES.join(" / ")}`);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** 心跳应答里给了哪些提示(键在 → 给过)。 */
export function noticesIn(r) {
  return NOTICE_CODES.filter((c) => {
    const v = r?.[c];
    return Array.isArray(v) ? v.length > 0 : v != null && v !== false;
  });
}

/**
 * deps:db、clock、nameOf(executorId) → 显示名。
 */
export function openReceipts({ db, clock = Date.now, nameOf = (id) => String(id) }) {
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS card_reads (
      task_id INTEGER NOT NULL, executor TEXT NOT NULL, spec_version INTEGER NOT NULL, via TEXT NOT NULL DEFAULT 'card' CHECK(via IN ('card','ref')),
      first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY (task_id, executor, spec_version, via))`);
    db.exec("CREATE INDEX IF NOT EXISTS ix_card_reads_task ON card_reads(task_id, via, last_at)");
    db.exec(`CREATE TABLE IF NOT EXISTS notice_sent (
      task_id INTEGER NOT NULL, run_id TEXT NOT NULL, code TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (task_id, run_id, code))`);
    db.exec(`CREATE TABLE IF NOT EXISTS notice_acks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, run_id TEXT NOT NULL, code TEXT NOT NULL, at INTEGER NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS ix_notice_acks_run ON notice_acks(task_id, run_id, code, at)");
    db.exec(`CREATE TRIGGER IF NOT EXISTS notice_acks_append_only_u BEFORE UPDATE ON notice_acks BEGIN SELECT RAISE(ABORT, 'notice_acks 只追加'); END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS notice_acks_append_only_d BEFORE DELETE ON notice_acks BEGIN SELECT RAISE(ABORT, 'notice_acks 只追加'); END`);
  }

  // 节流:同一〔卡, 执行者, 版本, 来路〕5 秒内只写一次库(桥的 heartbeat / report 每次都会先读卡)。
  const lastWrite = new Map();
  /** 执行者拉取了一次卡面。version 不是正整数(旧卡没有说明版本)记 0。返回这次是否写了库。 */
  function noteRead(taskId, executorId, version, via = "card") {
    const v = Number.isSafeInteger(version) && version > 0 ? version : 0, w = via === "ref" ? "ref" : "card";
    const key = `${Number(taskId)}|${executorId}|${v}|${w}`, t = clock(), prev = lastWrite.get(key);
    if (prev != null && t - prev < READ_THROTTLE_MS) return false;
    lastWrite.set(key, t);
    if (lastWrite.size > 5000) for (const [k, at] of lastWrite) if (t - at >= READ_THROTTLE_MS) lastWrite.delete(k);
    db.prepare(`INSERT INTO card_reads (task_id, executor, spec_version, via, first_at, last_at) VALUES (?,?,?,?,?,?)
                ON CONFLICT(task_id, executor, spec_version, via) DO UPDATE SET last_at=excluded.last_at`)
      .run(Number(taskId), String(executorId), v, w, t, t);
    return true;
  }

  /** 心跳应答里给过的提示记 sent(同一 run 同一 code 只记第一次)。 */
  function noteSent(taskId, runId, codes) {
    if (runId == null || runId === "" || !codes?.length) return;
    const st = db.prepare("INSERT OR IGNORE INTO notice_sent (task_id, run_id, code, at) VALUES (?,?,?,?)"), t = clock();
    for (const c of codes) if (NOTICE_CODES.includes(c)) st.run(Number(taskId), String(runId), c, t);
  }
  /** 心跳带的 ack:只追加。调用方先 checkAck、心跳落盘(持有者与 run 已核)之后再调。 */
  function recordAcks(taskId, runId, codes) {
    if (runId == null || runId === "" || !codes?.length) return [];
    const st = db.prepare("INSERT INTO notice_acks (task_id, run_id, code, at) VALUES (?,?,?,?)"), t = clock();
    for (const c of codes) st.run(Number(taskId), String(runId), c, t);
    return codes;
  }

  let readQ = null, refQ = null, runQ = null, sentQ = null, ackQ = null;
  /**
   * 任务对象的 receipts(只给操作者;调用方负责只在操作者的读里加)。o = taskOut 的结果(要 id / status / run_id /
   * self_reported_started_at / acked_spec_version)。
   */
  function of(o) {
    if (!o || o.id == null) return null;
    readQ ??= db.prepare("SELECT executor, spec_version, last_at FROM card_reads WHERE task_id=? AND via='card' ORDER BY last_at DESC, spec_version DESC LIMIT 1");
    refQ ??= db.prepare("SELECT executor, spec_version, last_at FROM card_reads WHERE task_id=? AND via='ref' ORDER BY last_at DESC LIMIT 5");
    runQ ??= db.prepare("SELECT started_at FROM task_runs WHERE run_id=?");
    sentQ ??= db.prepare("SELECT code, at FROM notice_sent WHERE task_id=? AND run_id=? ORDER BY at, code");
    ackQ ??= db.prepare("SELECT MIN(at) at FROM notice_acks WHERE task_id=? AND run_id=? AND code=? AND at>=?");
    const id = Number(o.id), r = readQ.get(id);
    const view = (x) => ({ executor_label: nameOf(x.executor), version: x.spec_version > 0 ? x.spec_version : null, at: iso(x.last_at) });
    const live = o.status !== "not_started" && o.run_id != null && o.run_id !== "";
    let claimed_at = null;
    if (live) { try { claimed_at = runQ.get(String(o.run_id))?.started_at ?? null; } catch { claimed_at = null; } }
    const notices = live ? sentQ.all(id, String(o.run_id)).map((s) => ({ code: s.code, sent_at: iso(s.at),
      acked_at: iso(ackQ.get(id, String(o.run_id), s.code, s.at)?.at ?? null) })) : [];
    const refs = refQ.all(id).map(view);
    return { read: r ? view(r) : null, claimed_at, started_at: o.self_reported_started_at ?? null,
             acked_spec_version: Number.isSafeInteger(o.acked_spec_version) ? o.acked_spec_version : null, notices,
             ...(refs.length ? { ref_reads: refs } : {}) };
  }

  let noteQ = null;
  /**
   * operator_note:最近一次裁定(resolve)写的话 = tasks.last_note(只存这一轮的原话,空串 = 这一轮人没写)。
   * kind:打回 / 退回原线(disposition hand_back)= "handback";通过、留待审阅等 = "verdict";by:人 = "operator",自动审阅 = "auto"。
   * 过 redactText(遮私有路径、令牌样串),超长截断并标 truncated。没有 → null。
   */
  function operatorNote(t) {
    const text = typeof t?.last_note === "string" ? t.last_note.trim() : "";
    if (!text || t.id == null) return null;
    noteQ ??= db.prepare("SELECT at, actor, detail FROM task_events WHERE task_id=? AND kind='resolve' ORDER BY id DESC LIMIT 1");
    const ev = noteQ.get(Number(t.id));
    let disposition = null; try { disposition = JSON.parse(ev?.detail ?? "{}").disposition ?? null; } catch {}
    const red = redactText(text), cut = [...red];
    const at = ev?.at ? (Number.isFinite(Date.parse(ev.at)) ? new Date(Date.parse(ev.at)).toISOString() : String(ev.at)) : null;
    return { text: cut.length > OPERATOR_NOTE_MAX ? cut.slice(0, OPERATOR_NOTE_MAX).join("") + "…" : red,
             at, kind: disposition === "hand_back" ? "handback" : "verdict",
             by: ev ? (ev.actor === "human" || ev.actor === "operator" ? "operator" : "auto") : null,
             ...(cut.length > OPERATOR_NOTE_MAX ? { truncated: true } : {}) };
  }

  return { migrate, noteRead, noteSent, recordAcks, of, operatorNote, checkAck, noticesIn };
}
