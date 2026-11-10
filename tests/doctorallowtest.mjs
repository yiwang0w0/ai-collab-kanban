import { harnessEnvironment } from "./harness-env.mjs";
// doctorallowtest — doctor 对写放行规则（--allowedTools）写法的核对。
// `node tests/doctorallowtest.mjs`
//
// 三种坏写法各有一组负面对照：不带路径的工具名、非绝对路径、放行目录是工作仓的上级目录。
// 每组都配一条写法正确的对照，证明报出来的是那一种坏写法，而不是什么都报。
// 最后用 loops/verify_lib.py 的真函数产出规则再核一遍：本部署实际发给 CLI 的规则应当合格。
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWriteAllowRules } from "../core/executor-readiness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_ENV = harnessEnvironment();
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const kinds = (rules, opts) => checkWriteAllowRules(rules, opts).map((f) => f.kind + ":" + f.rule);
const WIN = { repoRoot: "C:\\work\\proj", platform: "win32" }, POSIX = { repoRoot: "/home/u/proj", platform: "linux" };

console.log("[① 合格的写法不报]");
ok("Windows：工作仓与证据目录，盘符绝对路径", kinds(["Edit(C:/work/proj/**)", "Edit(C:/work/proj/core/.data/evidence/**)"], WIN).length === 0);
ok("POSIX：双斜杠绝对路径", kinds(["Edit(//home/u/proj/**)", "Edit(//var/board/evidence/**)"], POSIX).length === 0);
ok("规则为空不报写法问题", kinds([], WIN).length === 0);

console.log("[② 不带路径的工具名]");
ok("⭐Edit、Write、Read 不带路径各报一条", JSON.stringify(kinds(["Edit", "Write", "Read"], WIN)) === JSON.stringify(["bare_tool:Edit", "bare_tool:Write", "bare_tool:Read"]));
ok("空括号同样算不带路径", JSON.stringify(kinds(["Edit()", "Edit(  )"], WIN)) === JSON.stringify(["bare_tool:Edit()", "bare_tool:Edit(  )"]));
ok("(对照)同一工具带上绝对路径就不报", kinds(["Edit(C:/work/proj/**)"], WIN).length === 0);

console.log("[③ 非绝对路径]");
ok("⭐Windows：没有盘符的路径", JSON.stringify(kinds(["Edit(core/.data/evidence/**)", "Edit(/work/proj/**)"], WIN))
   === JSON.stringify(["relative_path:Edit(core/.data/evidence/**)", "relative_path:Edit(/work/proj/**)"]));
ok("⭐POSIX：单斜杠是项目根相对，不是绝对路径", JSON.stringify(kinds(["Edit(/home/u/proj/**)", "Edit(evidence/**)"], POSIX))
   === JSON.stringify(["relative_path:Edit(/home/u/proj/**)", "relative_path:Edit(evidence/**)"]));
ok("(对照)POSIX 双斜杠、Windows 盘符形不报", kinds(["Edit(//home/u/proj/**)"], POSIX).length === 0 && kinds(["Edit(C:/work/proj/**)"], WIN).length === 0);

console.log("[④ 放行目录是工作仓的上级目录]");
ok("⭐上一级目录、盘符根都报", JSON.stringify(kinds(["Edit(C:/work/**)", "Edit(C:/**)"], WIN))
   === JSON.stringify(["repo_ancestor:Edit(C:/work/**)", "repo_ancestor:Edit(C:/**)"]));
ok("Windows 路径不分大小写", JSON.stringify(kinds(["Edit(c:/WORK/**)"], WIN)) === JSON.stringify(["repo_ancestor:Edit(c:/WORK/**)"]));
ok("POSIX：上级目录与根目录都报", JSON.stringify(kinds(["Edit(//home/u/**)", "Edit(///**)"], POSIX))
   === JSON.stringify(["repo_ancestor:Edit(//home/u/**)", "repo_ancestor:Edit(///**)"]));
ok("(对照)工作仓自身、仓内子目录、名字相近的同级目录都不报",
   kinds(["Edit(C:/work/proj/**)", "Edit(C:/work/proj/sub/**)", "Edit(C:/work/proj2/**)", "Edit(C:/work/pro/**)"], WIN).length === 0);
ok("(对照)不知道工作仓时不判上级目录", kinds(["Edit(C:/**)"], { platform: "win32" }).length === 0);

console.log("[⑤ 真函数产出的规则合格]");
{
  const PY = HOST_ENV.PYTHON || "python";
  const repo = join(ROOT, "tests"), evidence = join(ROOT, "core", ".data", "evidence");
  const script = "import sys,json;sys.path.insert(0,sys.argv[1]);import verify_lib as v;print(json.dumps(v.cli_write_allow_rules(sys.argv[2:])))";
  let rules = null, detail = "";
  try { rules = JSON.parse(execFileSync(PY, ["-c", script, join(ROOT, "loops"), repo, evidence], { encoding: "utf8", windowsHide: true, timeout: 30000, env: { ...HOST_ENV, PYTHONIOENCODING: "utf-8" } })); }
  catch (e) { detail = String(e.message).slice(0, 160); }
  ok("verify_lib.cli_write_allow_rules 产出两条规则", Array.isArray(rules) && rules.length === 2, detail || JSON.stringify(rules));
  ok("⭐这两条规则在核对里合格", Array.isArray(rules) && checkWriteAllowRules(rules, { repoRoot: repo }).length === 0, JSON.stringify(rules));
  ok("(对照)同样两条规则，工作仓换成证据目录之下，证据目录就成了上级目录",
     Array.isArray(rules) && checkWriteAllowRules(rules, { repoRoot: join(evidence, "nested", "repo") }).some((f) => f.kind === "repo_ancestor"));
}

console.log(`\n${"─".repeat(56)}\nresult: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
