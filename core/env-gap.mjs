// 公告板 v3 合同 I10e「环境差」:卡可带 target_env(目标环境标签,只由操作者写);执行者可经桥 report_env_diff 报它那边与目标环境
// 有哪些不同(自报,覆盖式)。env_gap 由 core/credibility.mjs 从已核检查的 env 推出(徽标 flag not_target_env 也在那里)。
// 表都在 board.db(card_target_env 只存当前值并在卡历史记每次改动;card_env_diff 只存最近一次自报),不往数据目录写新文件。
import { oneLine } from "./packages.mjs";

export const TARGET_ENV_MAX = 40, DIFF_ITEMS_MAX = 20, DIFF_TEXT_MAX = 80;

/** target_env:单行 ≤40;null / 空串 = 撤销;undefined = 不设。 */
export function normTargetEnv(v, ctx) {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && !v.trim())) return null;
  return oneLine(v, TARGET_ENV_MAX, "target_env", ctx, { required: true });
}
/** report_env_diff 的 items:[{key, here, target}],≤20 项,各单行 ≤80。 */
export function normDiffItems(v, ctx, clean = (s) => s) {
  if (!Array.isArray(v) || v.length > DIFF_ITEMS_MAX) throw ctx.err(ctx.ERR.BAD_INPUT, `items 要数组,最多 ${DIFF_ITEMS_MAX} 项`);
  return v.map((x) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) throw ctx.err(ctx.ERR.BAD_INPUT, "items 的每一项要 {key, here, target}");
    for (const k of Object.keys(x)) if (!["key", "here", "target"].includes(k)) throw ctx.err(ctx.ERR.BAD_INPUT, `items 的项里不认识的字段 ${k}`);
    const key = oneLine(x.key, DIFF_TEXT_MAX, "items[].key", ctx, { required: true });
    const here = oneLine(x.here ?? "", DIFF_TEXT_MAX, "items[].here", ctx);
    const target = oneLine(x.target ?? "", DIFF_TEXT_MAX, "items[].target", ctx);
    return { key: clean(key), here: here == null ? null : clean(here), target: target == null ? null : clean(target) };
  });
}

export function openEnvGap({ db, store, now = () => new Date().toISOString() }) {
  const ctx = { err: store.err, ERR: store.ERR };
  function migrate() {
    db.exec(`CREATE TABLE IF NOT EXISTS card_target_env (task_id INTEGER PRIMARY KEY, target_env TEXT NOT NULL, by_ TEXT, at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS card_env_diff (task_id INTEGER PRIMARY KEY, items_json TEXT NOT NULL, by_ TEXT, at TEXT NOT NULL)`);
  }
  const targetOf = (id) => db.prepare("SELECT target_env FROM card_target_env WHERE task_id=?").get(Number(id))?.target_env ?? null;
  /** 写 / 撤销(谁能写由 server 核:只有操作者)。变了才记一条卡历史。 */
  function setTarget(id, v, by) {
    const before = targetOf(id);
    if (v == null) db.prepare("DELETE FROM card_target_env WHERE task_id=?").run(Number(id));
    else db.prepare("INSERT INTO card_target_env(task_id, target_env, by_, at) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET target_env=excluded.target_env, by_=excluded.by_, at=excluded.at")
      .run(Number(id), v, by == null ? null : String(by), now());
    if (before !== (v ?? null)) try { store.appendEvent(db, { taskId: Number(id), kind: "target_env.set", actor: by || "operator", detail: { target_env: v ?? null } }); } catch {}
    return v ?? null;
  }
  /** 执行者自报的环境差(覆盖式)。谁能报由 server 核(当事执行者)。 */
  function setDiff(id, items, by) {
    db.prepare("INSERT INTO card_env_diff(task_id, items_json, by_, at) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET items_json=excluded.items_json, by_=excluded.by_, at=excluded.at")
      .run(Number(id), JSON.stringify(items), by == null ? null : String(by), now());
    try { store.appendEvent(db, { taskId: Number(id), kind: "env_diff.reported", actor: by || "executor", detail: { count: items.length } }); } catch {}
    return diffOf(id);
  }
  function diffOf(id) {
    const r = db.prepare("SELECT items_json, at FROM card_env_diff WHERE task_id=?").get(Number(id));
    if (!r) return null;
    let items = []; try { items = JSON.parse(r.items_json); } catch {}
    return { by: "executor", items, at: r.at };
  }
  return { migrate, normTarget: (v) => normTargetEnv(v, ctx), normItems: (v, clean) => normDiffItems(v, ctx, clean), targetOf, setTarget, setDiff, diffOf };
}
