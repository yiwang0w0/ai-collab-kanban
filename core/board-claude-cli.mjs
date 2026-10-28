// 看板服务端自己起的 Claude CLI（一键拆解、上下文压缩）：参数、环境与输出解析，全部是纯函数。
//
// 为什么单独成模块：server.mjs 一导入就开始监听，桩 CLI 又看不到参数（见 decompose_lib.js 文件头），
// 写在 server 里的参数与环境没有任何机器覆盖。抽出来由 tests/decomposetest.mjs 直接断言。
//
// 结构防线（不靠提示词）：
//  · 可用工具用 --tools 白名单给出：拆解只有 Read/Glob/Grep，压缩一个都没有。新版本 CLI 新增的写工具、
//    联网工具不在白名单里就不会出现；--disallowedTools 再显式拒绝一遍，作为纵深。
//  · --permission-mode dontAsk：未预先放行的调用一律拒绝，也盖过用户设置里的 defaultMode。
//  · --strict-mcp-config 且不给 --mcp-config：用户配置的 MCP 服务器一个都不加载（MCP 工具不在 --tools 管辖内）。
//  · 路径拒绝规则：整个数据目录、验证登记簿、全部执行配置的认证目录，Read／Edit 各一条。写法与执行线
//    （loops/verify_lib.py 的 deny_path / auth_home_deny_rules）相同，tests/decomposetest.mjs ⑨ 逐条对照。
//    执行线只能按文件名逐条钉（它要往 <data>/evidence 写证据，整目录 Read 拒绝会连写入一起挡掉）；
//    这里的两个调用都不往数据目录写任何东西，所以整目录拒绝，是执行线 PROTECTED 清单的超集，也不必另抄一份清单。
//  · 环境：先按旧线同一规则剔除全部配置登记的凭据变量（profileEnvironment(null,{profiles})），
//    再剔除看板自身的令牌类变量；标准登录变量保留，这两个调用本来就沿用用户的默认登录。
import {isAbsolute,resolve} from "node:path";
import {profileEnvironment} from "./execution-profiles.mjs";

/** 拆解器可用的全部工具（只读）。 */
export const DECOMPOSE_TOOLS=Object.freeze(["Read","Glob","Grep"]);
/** 显式拒绝的写工具、执行工具与联网工具（白名单之外的纵深；名称取自 Claude Code 2.1.234 的内置工具清单）。 */
export const DENIED_TOOLS=Object.freeze(["Bash","PowerShell","Edit","Write","NotebookEdit","WebFetch","WebSearch","Task",
 "Skill","Artifact","Workflow","SendMessage","RemoteTrigger","PushNotification","CronCreate","CronDelete","ScheduleWakeup",
 "EnterWorktree","ExitWorktree","Monitor","DesignSync","TaskCreate","TaskUpdate","TaskStop"]);

/** 与 verify_lib.deny_path 同一写法：Windows 盘符形原样（正斜杠），其余绝对路径拼成 `//abs`（单斜杠是项目根相对）。 */
export function denyPath(absPath){
 const p=String(absPath).replace(/\\/g,"/");
 if(/^[A-Za-z]:\//.test(p))return p;
 const full=resolve(p).replace(/\\/g,"/");
 return /^[A-Za-z]:\//.test(full)?full:"//"+full.replace(/^\/+/,"");
}

/** 与 verify_lib.auth_home_deny_rules 等价：每个认证目录 Read／Edit `/**` 各一条，按写法去重。
 *  不是绝对路径就抛错（未知值落拒绝侧，调用方不起 CLI）。 */
export function authHomeDenyRules(homes){
 if(!Array.isArray(homes)||!homes.every(home=>typeof home==="string"&&home.trim()&&isAbsolute(home)))
  throw new Error("认证目录必须是绝对路径数组");
 const rules=[],seen=new Set();
 for(const home of homes){
  const path=denyPath(home).replace(/\/+$/,"");
  if(seen.has(path))continue;
  seen.add(path);
  rules.push(`Read(${path}/**)`,`Edit(${path}/**)`);
 }
 return rules;
}

/** 整个数据目录、验证登记簿与全部认证目录的拒绝规则。 */
export function boardDenyRules({dataDir,registry,authHomes}){
 if(typeof dataDir!=="string"||!isAbsolute(dataDir)||typeof registry!=="string"||!isAbsolute(registry))
  throw new Error("数据目录与验证登记簿必须是绝对路径");
 const data=denyPath(dataDir).replace(/\/+$/,""),reg=denyPath(registry);
 return [`Read(${data}/**)`,`Edit(${data}/**)`,`Read(${reg})`,`Edit(${reg})`,...authHomeDenyRules(authHomes)];
}

// 看板自身的令牌类变量：看板把令牌写在数据目录的文件里，正常不在 server 进程环境中；万一从别的
// 进程继承下来（例如座席的 WORKER_BOARD_TOKEN），也不交给模型进程。KANBAN_ 前缀是看板的凭据命名空间。
const BOARD_SECRET=/^(?:(?:BOARD|WORKER|REVIEW|REVIEWER)_(?:.*_)?TOKEN|KANBAN_.*(?:KEY|TOKEN))$/i;

/** CLI 子进程环境。profiles 传全部执行配置。 */
export function boardCliEnvironment({env=process.env,profiles=[]}={}){
 const base=profileEnvironment(null,{env,profiles});
 const output=Object.fromEntries(Object.entries(base).filter(([key])=>!BOARD_SECRET.test(key)));
 output.PYTHONIOENCODING="utf-8";
 return output;
}

const lockdown=scope=>["--permission-mode","dontAsk","--strict-mcp-config","--no-chrome",
 "--disallowedTools",...DENIED_TOOLS,...boardDenyRules(scope)];

/** 一键拆解：只读工作仓，最终回答就是计划 JSON（server 从 --output-format json 的 result 里取，模型不写文件）。
 *  提示词紧跟 -p：放在任何可变参数 flag 之后会被吞成那个 flag 的取值。 */
export function decomposeCliArgs({prompt,model,repoRoot,dataDir,registry,authHomes}){
 if(typeof repoRoot!=="string"||!isAbsolute(repoRoot))throw new Error("工作仓必须是绝对路径");
 return ["-p",String(prompt),"--model",String(model),"--effort","high","--output-format","json",
  "--tools",...DECOMPOSE_TOOLS,"--allowedTools",...DECOMPOSE_TOOLS,"--add-dir",repoRoot,
  ...lockdown({dataDir,registry,authHomes})];
}

/** 上下文压缩的两步（让会话写压缩指示、再 /compact）：都只需要模型产出文字，不给任何工具。 */
export function compactCliArgs({prompt,sessionId,model,effort,dataDir,registry,authHomes}){
 return ["-p",String(prompt),"--resume",String(sessionId),"--model",String(model),
  ...(effort?["--effort",String(effort)]:[]),"--tools","",...lockdown({dataDir,registry,authHomes})];
}

/** --output-format json 的结果消息（--verbose 时是消息数组，取最后一条 result）。 */
export function cliResult(stdout){
 let value;
 try{value=JSON.parse(String(stdout||"").trim());}catch{return {ok:false,reason:"CLI 输出不是 JSON"};}
 const result=Array.isArray(value)?value.findLast(item=>item?.type==="result"):value;
 if(!result||result.type!=="result")return {ok:false,reason:"CLI 输出里没有 result 消息"};
 if(result.is_error||result.subtype!=="success")
  return {ok:false,reason:`CLI 未成功结束(${result.subtype||"is_error"}):${String(result.result||"").slice(0,200)}`};
 if(typeof result.result!=="string")return {ok:false,reason:"result 不是文字"};
 return {ok:true,text:result.result};
}

/** 拆解计划：从最终回答里取第一个 { 到最后一个 } 解析（原先读结果文件时的同一提取）。 */
export function decomposePlanOf(stdout){
 const result=cliResult(stdout);
 if(!result.ok)return result;
 const match=result.text.match(/\{[\s\S]*\}/);
 let plan;
 try{plan=JSON.parse(match?match[0]:result.text);}
 catch(error){return {ok:false,reason:`拆解结果不是合法 JSON:${error.message}`};}
 if(!plan||typeof plan!=="object"||Array.isArray(plan))return {ok:false,reason:"拆解结果不是合法 JSON 对象"};
 return {ok:true,plan};
}
