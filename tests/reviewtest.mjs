import { fixtureVersion } from "./http-version-fixture.mjs";
// reviewtest — the auto-reviewer measured END TO END: a real board, the real
// loops/reviewer_loop.py, a stub CLI whose verdict the harness controls.
//
// What it pins, and why each assertion exists:
//   §1 the server mints THREE distinct tokens (operator / worker / review) —
//      one token was one capability, and a live deployment's agent self-approved
//      its own card with it.
//   §2 approve + green card-named verify → done, resolved_by=auto, and
//      verify_ok=true reaches the store. ⭐ This is the origin dead-branch pin:
//      the origin loop never passed the green verify into resolve, so
//      cascade-close via review was permanently unarmed — an assertion on
//      verify_ok goes red if the plumbing regresses.
//   §3 machine-evidence gate: acceptance demands machine output, evidence is
//      prose-only, the MODEL says approve — the gate must downgrade to
//      escalate (waiting/confirm + decision package, never done).
//   §4 reject → the card goes back to its line (not_started), loud note.
//   §5 card-named verify is RED → mechanical bounce BEFORE the model burns:
//      the stub must not have been invoked at all.
//   §6 the worker token cannot resolve (403) — the ruling face is not the
//      execution face, measured from the outside.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PY = process.env.PYTHON || "python";
const NL = String.fromCharCode(10);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  for (let p = 48700 + Math.floor(Math.random() * 100); ; p++) {
    const okP = await new Promise((res) => {
      const s = createServer();
      s.once("error", () => res(false));
      s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
    });
    if (okP) return p;
  }
}

const TMP = mkdtempSync(join(tmpdir(), "reviewtest-"));
const REGISTRY = join(TMP, "verify_registry.json");
writeFileSync(REGISTRY, JSON.stringify({
  "always-green": ["python", "-c", "import sys; sys.exit(0)"],
  "always-red":   ["python", "-c", "print('red evidence'); import sys; sys.exit(1)"],
}, null, 1), "utf8");

// Stub CLI: extracts the verdict-file path from the prompt, writes the verdict
// the harness put in REVIEW_STUB_JSON, and leaves an invocation marker.
const STUB = join(TMP, "review_stub.py");
writeFileSync(STUB, [
  "import sys, os, re, io, json",
  "argv = sys.argv",
  "io.open(os.environ.get('REVIEW_STUB_ARGV', os.devnull), 'w', encoding='utf-8').write(json.dumps(argv))",
  "prompt = argv[argv.index('-p') + 1]",
  "io.open(os.environ['REVIEW_STUB_MARK'], 'a', encoding='utf-8').write('invoked' + chr(10))",
  "m = re.search(r'\\u628a\\u5224\\u51b3\\u5199\\u8fdb\\u8fd9\\u4e2a\\u6587\\u4ef6[\\s\\S]*?\\n\\n\\s*(\\S+)', prompt)",
  "io.open(m.group(1), 'w', encoding='utf-8').write(os.environ['REVIEW_STUB_JSON'])",
  "print(json.dumps({'total_cost_usd': 0}))",
].join(NL), "utf8");
const MARK = join(TMP, "stub_invoked.log");
const ARGVF = join(TMP, "review_argv.json");

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let srv = null, out = "";
const boards = [];

// v0.23: the anti-affinity policy is on for this board. Cards claimed WITHOUT a runtime
// (every section before §7) have no author family and are never held — so the policy
// changes nothing for them, and §7 measures it with cards that name their runtime.
const CFGR = join(TMP, "fleet.config.json");
writeFileSync(CFGR, JSON.stringify({ review: { anti_affinity: "runtime" } }), "utf8");
// ⭐ 与 looptest 同一道隔离:本 harness 也可能从**另一条线的 loop 进程**里跑起来(验证命令继承
//   BOARD_* / WORKER_* —— 见 verify_lib.verify_environment),继承的部署面 env 会让隔离板加载部署配置、
//   让审阅线按别人的 runtime / 模型 / 身份起跑。先把三族整族剔掉,再逐项写回本 harness 自己的值;
//   BOARD_CONFIG 仍指向下面那份只声明反亲和的临时配置(没有 lines 键 = 内置线表,alpha 在那里)。
const HOST_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !/^(?:BOARD|WORKER|REVIEWER)_/i.test(k)));
const commonEnv = {
  ...HOST_ENV, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
  BOARD_PORT: String(PORT), BOARD_URL: BASE, BOARD_DATA_DIR: TMP,
  BOARD_DB: join(TMP, "t.db"), BOARD_ALLOW_UNPINNED: "1",   // isolated harness only
  BOARD_VERIFY_REGISTRY: REGISTRY, BOARD_CONFIG: CFGR,
  // 审阅座席与工作仓也要钉:§2b 断言 argv 里的 --add-dir 与写放行规则就是**这个仓**,
  //   而 WORKER_RUNTIME 若继承成 codex,§2 会走 codex 分支、桩一次都不会被调到。
  BOARD_REPO: ROOT, WORKER_RUNTIME: "claude",
};

try {
  srv = spawn(process.execPath, [join(ROOT, "core", "server.mjs")], {
    env: commonEnv, stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", (b) => (out += b));
  srv.stderr.on("data", (b) => (out += b));
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
    await sleep(250);
  }

  const tok = (f) => { try { return readFileSync(join(TMP, f), "utf8").trim(); } catch { return ""; } };
  const OP = tok("board_token"), WK = tok("worker_token"), RV = tok("review_token");
  const receipts = new Map();
  const api = async (m, p, b, t = OP) => {
    b=await fixtureVersion(BASE,t,m,p,b);
    if (p === "/api/claim") b={worker_protocol_version:2,agent_instance_id:"11111111-1111-4111-8111-111111111111",...b};
    const mutation=p.match(/^\/api\/tasks\/(\d+)\/(report|heartbeat|attempt)$/);
    if (mutation) b={run_id:receipts.get(Number(mutation[1])),...b};
    const result=await fetch(BASE + p, { method: m,
    headers: { "Content-Type": "application/json", "X-Board-Token": t },
    body: m === "GET" ? undefined : JSON.stringify(b ?? {}) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    if (result.status<400 && /\/claim$/.test(p) && result.body?.task) receipts.set(result.body.task.id,result.body.task.run_id);
    return result;
  };

  console.log(NL + "[§1 三令牌铸造]");
  ok("R1 三个令牌文件都在且互不相同",
     OP && WK && RV && OP !== WK && OP !== RV && WK !== RV,
     `op=${OP.slice(0, 6)}… wk=${WK.slice(0, 6)}… rv=${RV.slice(0, 6)}…`);

  /** create -> claim -> report(done) — the card lands in waiting/review. */
  const toWaiting = async ({ subject, acceptance, evidence, verify }) => {
    const c = await api("POST", "/api/tasks", { subject, line: "alpha", humanGate: false,
      ...(acceptance ? { acceptance } : {}),
      ...(verify ? { verifyCmd: verify } : {}) });   // camelCase — store.add's field name
    const id = c.body.task.id;
    if (c.status >= 400) console.log("  (create failed:", c.status, JSON.stringify(c.body), ")");
    await api("POST", "/api/claim", { worker: "alpha", line: "alpha", route: "default" }, WK);
    await api("POST", `/api/tasks/${id}/report`, { worker: "alpha", outcome: "done", evidence }, WK);
    return id;
  };

  // 其他配置自定义到数据目录之外的认证目录(server 经 WORKER_AUTH_HOMES 下传全部配置的认证目录)。
  const OTHER_AUTH = join(dirname(TMP), basename(TMP) + "-其他配置认证");
  const runReviewer = (verdict) => {
    try { rmSync(MARK, { force: true }); } catch {}
    const r = spawnSync(PY, [join(ROOT, "loops", "reviewer_loop.py"), "--once", "--interval", "1"], {
      env: { ...commonEnv,
             REVIEWER_CLI_ARGV: JSON.stringify(["python", STUB]),
             WORKER_AUTH_HOMES: JSON.stringify([OTHER_AUTH]),
             REVIEW_STUB_JSON: JSON.stringify(verdict),
             REVIEW_STUB_MARK: MARK, REVIEW_STUB_ARGV: ARGVF,
             REVIEWER_PARALLEL: "1", REVIEWER_LIMIT: "6" },
      encoding: "utf8", timeout: 120000 });
    return (r.stdout || "") + (r.stderr || "");
  };

  console.log(NL + "[§2 approve×绿验证 → done · resolved_by=auto · verify_ok 真的落库]");
  const idA = await toWaiting({
    subject: "r-approve", verify: "always-green",
    acceptance: "① 跑 selftest 全绿",
    evidence: "已完成。" });
  const logA = runReviewer({ verdict: "approve", reason: "证据成立", checked: ["Read x → y"],
                             summary: "", options: [], recommend: "" });
  const tA = (await api("GET", `/api/tasks/${idA}`)).body.task;
  ok("R2 卡结案且 resolved_by=auto(审阅线用 review_token 裁定成功)",
     tA.status === "done" && tA.resolved_by === "auto", `${tA.status}/${tA.resolved_by}`);
  ok("R3 ⭐绿验证随判决落库:verify_ok === true(origin 死分支修正的钉子)",
     tA.verify_ok === true, `verify_ok=${JSON.stringify(tA.verify_ok)}`);
  ok("R4 stub 被调用过(判决确实出自模型路径)", existsSync(MARK), logA.slice(-200));

  console.log(NL + "[§2b 审阅座席的 argv:--tools 白名单 + dontAsk + 拒绝规则(v0.17.0 / v0.24.0)]");
  {
    let av = []; try { av = JSON.parse(readFileSync(ARGVF, "utf8")); } catch {}
    const i = av.indexOf("--disallowedTools"); const rules = i >= 0 ? av.slice(i + 1) : [];
    // flag 后面紧跟的取值(到下一个 -- 开头的元素为止);--tools / --allowedTools 都是可变长的。
    const valuesOf = (args, flag) => {
      const out = [];
      args.forEach((a, k) => {
        if (a !== flag) return;
        for (let j = k + 1; j < args.length && !String(args[j]).startsWith("--"); j++) out.push(args[j]);
      });
      return out;
    };
    const WINP = process.platform === "win32";
    const sameList = (a, b) => WINP
      ? JSON.stringify(a.map((s) => String(s).toLowerCase())) === JSON.stringify(b.map((s) => String(s).toLowerCase()))
      : JSON.stringify(a) === JSON.stringify(b);
    const outFwd = (WINP ? "" : "/") + join(TMP, "review").replace(/\\/g, "/");
    // v0.21.2: per-file rules, `//`-absolute on POSIX (see looptest ⑭ for the measurement).
    const dataFwd = (process.platform === "win32" ? "" : "/") + TMP.replace(/\\/g, "/");
    ok("R4b ⭐审阅的真 argv 带 --disallowedTools,钉住令牌与登记簿(逐文件,Read+Edit)",
       i >= 0 && rules.includes(`Read(${dataFwd}/board_token)`) && rules.includes(`Edit(${dataFwd}/board_token)`)
       && rules.some((r) => /verify_registry\.json\)$/.test(r)), rules.slice(0, 2).join(" ") || "(no argv)");
    // (`review_token` legitimately shares the prefix — test the directory, not the substring.)
    const authFwd = (process.platform === "win32" ? "" : "/") + OTHER_AUTH.replace(/\\/g, "/");
    ok("R4d ⭐审阅的真 argv 同样拒绝其他配置的认证目录(Read+Edit 整目录,兼容约定变更:无执行配置的线也拒)",
       rules.includes(`Read(${authFwd}/**)`) && rules.includes(`Edit(${authFwd}/**)`), rules.slice(-2).join(" ") || "(no argv)");
    ok("R4c 判决目录 <data>/review 不被任何规则盖住(否则审阅写不出判决文件)",
       rules.length > 0 && rules.every((r) => !r.includes(`${dataFwd}/review/`) && !r.endsWith(`${dataFwd}/review)`)
                                               && !r.endsWith(`${dataFwd}/**)`) && !r.endsWith(`${dataFwd}/*)`)));
    // ── v0.24.0:读写边界进 argv(2026-10-28 spike 实测:不带路径的 `--allowedTools Read`
    //    等于放行任意路径的读取;dontAsk 下 cwd 与 --add-dir 内的读不需要放行规则)。
    ok("R4e ⭐可用工具由 --tools 白名单给出(Read/Glob/Grep/Write,没有 Edit、没有 Bash)",
       sameList(valuesOf(av, "--tools"), ["Read", "Glob", "Grep", "Write"]), JSON.stringify(valuesOf(av, "--tools")));
    ok("R4f ⭐权限模式是 dontAsk;argv 里没有 acceptEdits / plan / --dangerously-*",
       sameList(valuesOf(av, "--permission-mode"), ["dontAsk"]) && !av.includes("acceptEdits")
       && !av.includes("plan") && !av.some((a) => String(a).startsWith("--dangerously")),
       JSON.stringify(valuesOf(av, "--permission-mode")));
    ok("R4g ⭐--allowedTools 里没有任何不带路径的工具名(裸 Read 会放行任意路径的读取 —— spike P1 实测越界读成功)",
       av.length > 0 && valuesOf(av, "--allowedTools").every((r) => /^(?:Read|Edit)\(.+\)$/.test(r)),
       JSON.stringify(valuesOf(av, "--allowedTools")));
    ok("R4h ⭐写放行只有判决目录一条 Edit(…/**):「只写判决文件」从提示词约束变成结构约束",
       sameList(valuesOf(av, "--allowedTools"), [`Edit(${outFwd}/**)`]), JSON.stringify(valuesOf(av, "--allowedTools")));
    ok("R4i ⭐读范围 = 工作仓 + 判决目录(越界读靠 dontAsk 拒,不靠提示词)",
       sameList(valuesOf(av, "--add-dir"), [ROOT, join(TMP, "review")]), JSON.stringify(valuesOf(av, "--add-dir")));
    ok("R4j ⭐不读用户/项目/本地设置(--setting-sources \"\"),不加载任何 MCP(--strict-mcp-config 且无 --mcp-config)",
       sameList(valuesOf(av, "--setting-sources"), [""]) && av.includes("--strict-mcp-config") && !av.includes("--mcp-config"),
       JSON.stringify(valuesOf(av, "--setting-sources")));
  }

  console.log(NL + "[§3 机器产出闸:验收要机器、证据纯散文、模型说 approve → 机械降 escalate]");
  const idB = await toWaiting({
    subject: "r-gate",
    acceptance: "① 跑 servertest 并贴出 PASS 计数 ② 文案更新",
    evidence: "我做完了,一切正常。" });
  runReviewer({ verdict: "approve", reason: "看起来没问题", checked: [],
                summary: "", options: [], recommend: "" });
  const tB = (await api("GET", `/api/tasks/${idB}`)).body.task;
  ok("R5 卡没有结案 —— 停在 waiting/confirm 等人",
     tB.status === "waiting" && tB.waiting_for === "confirm", `${tB.status}/${tB.waiting_for}`);
  ok("R6 裁定包来自 auto-review 且推荐 A(三方案齐)",
     tB.decision_package?.source === "auto-review" &&
     tB.decision_package?.recommend === "A" &&
     (tB.decision_package?.options || []).length === 3,
     JSON.stringify({ src: tB.decision_package?.source, rec: tB.decision_package?.recommend }));

  console.log(NL + "[§3b 空验收 + 模型 approve → 机械转人工(v0.16.1)]");
  const idB2 = await toWaiting({ subject: "r-empty-acc", evidence: "做完了,一切正常。" });
  runReviewer({ verdict: "approve", reason: "看起来没问题", checked: [], summary: "", options: [], recommend: "" });
  const tB2 = (await api("GET", `/api/tasks/${idB2}`)).body.task;
  ok("R6b ⭐没有验收标准的卡不能被自动通过 —— 停在 waiting/confirm", tB2.status === "waiting" && tB2.waiting_for === "confirm", `${tB2.status}/${tB2.waiting_for}`);
  ok("R6c 裁定包说明是空验收,两个方案,推荐补写验收", /空验收/.test(tB2.decision_package?.reason || "") && (tB2.decision_package?.options || []).length === 2 && tB2.decision_package?.recommend === "A",
     JSON.stringify({ rec: tB2.decision_package?.recommend, n: (tB2.decision_package?.options || []).length }));

  console.log(NL + "[§4 reject → 打回原线]");
  const idC = await toWaiting({ subject: "r-reject", evidence: "试了但没做完。" });
  runReviewer({ verdict: "reject", reason: "缺 X,重做时先补 Y", checked: [],
                summary: "", options: [], recommend: "" });
  const tC = (await api("GET", `/api/tasks/${idC}`)).body.task;
  ok("R7 卡回到 not_started(带指示,不是结案)", tC.status === "not_started", tC.status);

  console.log(NL + "[§5 卡指名验证为红 → 机械打回,模型一次都不烧]");
  const idD = await toWaiting({
    subject: "r-mech", verify: "always-red", evidence: "自称全绿。PASS 99" });
  const logD = runReviewer({ verdict: "approve", reason: "(不该被问到)", checked: [],
                             summary: "", options: [], recommend: "" });
  const tD = (await api("GET", `/api/tasks/${idD}`)).body.task;
  ok("R8 红验证 → 机械打回(not_started)", tD.status === "not_started", tD.status);
  ok("R9 ⭐stub 未被调用(先验后审:红了不烧模型)", !existsSync(MARK), logD.slice(-160));

  console.log(NL + "[§5b codex 审阅的输出 schema 必须过 strict 校验(不跑模型也能判)]");
  {
    // ⭐ This whole class of bug is invisible to the harness above: the stub CLI
    //   exercises the CLAUDE branch, which builds no schema, so the codex branch's
    //   schema was never executed by anything until a live deployment attached a
    //   codex review seat — and the API refused the request BEFORE the model ran,
    //   which on the board looked like the worker had failed (INCIDENTS-13).
    //   Strict structured outputs require, for every object: required lists EVERY
    //   property, and additionalProperties is false. That is machine-checkable
    //   here, offline, in milliseconds.
    const schemaPath = join(ROOT, "loops", "codex_review_schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const faults = [];
    (function walk(node, path){
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (!node || typeof node !== "object") return;
      if (node.type === "object" || node.properties){
        const props = Object.keys(node.properties || {});
        const req = node.required || [];
        const missing = props.filter((p) => !req.includes(p));
        const stray = req.filter((r) => !props.includes(r));
        if (missing.length) faults.push(`${path}: required 少了 ${missing.join(",")}`);
        if (stray.length) faults.push(`${path}: required 里有 properties 没有的键 ${stray.join(",")}`);
        if (node.additionalProperties !== false) faults.push(`${path}: additionalProperties 必须是 false`);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    })(schema, "$");
    ok("R12 ⭐schema 每个对象都合 strict:required 覆盖全部属性 · additionalProperties=false",
       faults.length === 0, faults.join(" | ") || "(全部合规)");
    // ⚠ This file is sent to the API verbatim — it is NOT one of our own configs.
    //   No `_comment` keys, no notes: an unknown keyword risks the same
    //   "refused before the model runs" failure, invisible without a live call.
    //   (Caught while fixing INCIDENT-13: the fix's own explanatory key was
    //   about to ship inside the schema.) Explanations belong in the harness,
    //   the loop's comments and INCIDENTS.md — never in the wire payload.
    const ALLOWED = new Set(["$schema", "type", "properties", "required",
                             "additionalProperties", "items", "enum", "description"]);
    const strays = [];
    (function walkKeys(node, path){
      if (Array.isArray(node)) return node.forEach((v, i) => walkKeys(v, `${path}[${i}]`));
      if (!node || typeof node !== "object") return;
      const inProps = /\.properties$/.test(path);   // property NAMES are free-form
      for (const [k, v] of Object.entries(node)){
        if (!inProps && !ALLOWED.has(k)) strays.push(`${path}.${k}`);
        walkKeys(v, `${path}.${k}`);
      }
    })(schema, "$");
    ok("R12b ⭐schema 里没有自造关键字(这份文件原样发给 API,注释请写在别处)",
       strays.length === 0, strays.join(" | ") || "(只有标准关键字)");
    // An optional field must be spelled "required + nullable" — the fix that got
    // us here. Pin the shape so nobody re-optionalises it by dropping it again.
    const fileItem = schema.properties.options.items.properties.files.items;
    ok("R13 可选字段的写法是「留在 required + 类型可为 null」,不是「从 required 里拿掉」",
       fileItem.required.includes("archive_name") &&
       Array.isArray(fileItem.properties.archive_name.type) &&
       fileItem.properties.archive_name.type.includes("null"),
       JSON.stringify(fileItem.properties.archive_name));
    // Cross-file contract: the kinds the schema lets the model emit must be the
    // kinds the loop's own validator accepts. Two places, one meaning.
    const src = readFileSync(join(ROOT, "loops", "reviewer_loop.py"), "utf8");
    const m = src.match(/kind not in \(([^)]*)\)/);
    const accepted = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort() : null;
    const declared = [...(schema.properties.options.items.properties.kind.enum || [])].sort();
    ok("R14 schema 允许的 kind 与 reviewer_loop 校验器接受的 kind 是同一组(跨文件契约)",
       !!accepted && JSON.stringify(accepted) === JSON.stringify(declared),
       `schema=${JSON.stringify(declared)} loop=${JSON.stringify(accepted)}`);
  }

  console.log(NL + "[§6 令牌分权的外测面]");
  const idE = await toWaiting({ subject: "r-authz", evidence: "test" });
  const rw = await api("POST", `/api/tasks/${idE}/resolve`,
                       { verdict: "approve", note: "", resolved_by: "auto" }, WK);
  ok("R10 ⭐worker 令牌 resolve → 403(执行面拿不到裁定面)", rw.status === 403, `HTTP ${rw.status}`);
  const rv2 = await api("POST", `/api/tasks/${idE}/resolve`,
                        { verdict: "approve", note: "", resolved_by: "human" }, RV);
  ok("R11 review 令牌冒充 human → 400(机器审阅不得冒充人)", rv2.status === 400, `HTTP ${rv2.status}`);

  console.log(NL + "[§7 反亲和(v0.23):同家族交付的卡留给人,真审阅出声跳过;另一家族照审]");
  {
    // Claim BY ID with a runtime (operator token — claim-by-id is not on the worker's list).
    const deliverAs = async (subject, runtime) => {
      const id = (await api("POST", "/api/tasks", { subject, line: "alpha", humanGate: false })).body.task.id;
      const c = await api("POST", `/api/tasks/${id}/claim`, { worker: "alpha", runtime });
      if (c.status >= 400) console.log("  (claim failed:", c.status, JSON.stringify(c.body), ")");
      await api("POST", `/api/tasks/${id}/report`, { worker: "alpha", outcome: "done", evidence: "rc=0 PASS 1" }, WK);
      return id;
    };
    const same = await deliverAs("r-same-family", "claude");     // the stub reviewer runs as claude
    const other = await deliverAs("r-other-family", "codex");
    const log7 = runReviewer({ verdict: "reject", reason: "缺证据" });
    const ts = (await api("GET", `/api/tasks/${same}`)).body.task;
    const to = (await api("GET", `/api/tasks/${other}`)).body.task;
    ok("R12 ⭐同家族的卡被跳过:仍在待验收、卡面 review_hold=same_family、日志说明原因(每卡一次)",
       ts?.status === "waiting" && ts?.waiting_for === "review" && ts?.review_hold === "same_family" &&
       new RegExp(`跳过 #${same}:`).test(log7) && (log7.match(new RegExp(`跳过 #${same}:`, "g")) || []).length === 1,
       `status=${ts?.status}/${ts?.waiting_for} hold=${ts?.review_hold}`);
    ok("R12b ⭐另一家族(codex 交付)的卡照审:被打回原线",
       to?.status === "not_started" && to?.last_verdict === "reject", `status=${to?.status} verdict=${to?.last_verdict}`);
    ok("R12c 审阅启动行写明反亲和已开", /反亲和=runtime/.test(log7));
  }

} catch (e) {
  console.error("harness itself fell over:", e);
  fail++;
} finally {
  try { srv?.kill(); } catch {}
  await sleep(400);
  if (fail) console.log(`${NL}──── server output tail ────${NL}` + out.slice(-1500));
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`${NL}${"─".repeat(56)}${NL}result: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
