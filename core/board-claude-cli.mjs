// 看板服务端自己起的 Claude CLI（一键拆解、上下文压缩）：参数、环境与输出解析，全部是纯函数。
//
// 为什么单独成模块：server.mjs 一导入就开始监听，桩 CLI 又看不到参数（见 decompose_lib.js 文件头），
// 写在 server 里的参数与环境没有任何机器覆盖。抽出来由 tests/decomposetest.mjs 直接断言。
//
// 结构防线（不靠提示词）：
//  · 可用工具用 --tools 白名单给出：拆解只有 Read/Glob/Grep，压缩一个都没有。新版本 CLI 新增的写工具、
//    联网工具不在白名单里就不会出现；--disallowedTools 再显式拒绝一遍，作为纵深。
//  · --permission-mode dontAsk：未预先放行的调用一律拒绝，也盖过用户设置里的 defaultMode。dontAsk 下
//    cwd 与 --add-dir 范围内的读取不需要放行规则，所以读范围 = 看板自建的空 cwd + 工作仓。
//  · 不给 --allowedTools：不带路径的 `Read` 放行规则会放行任意路径的读取（2026-10-28 spike P1 实测越界读成功）。
//    越界读只靠 dontAsk 的范围与下面的路径拒绝规则挡。
//  · --setting-sources ""：不读用户、项目、本地设置，其中的 allow 规则（会放宽读范围）与 hooks 都不进来；
//    订阅登录不在设置里，不受影响（实测）。靠 settings.json 的 apiKeyHelper／env 登录的部署会响亮失败。
//  · --strict-mcp-config 且不给 --mcp-config：用户配置的 MCP 服务器一个都不加载（MCP 工具不在 --tools 管辖内）。
//  · 路径拒绝规则：整个数据目录、验证登记簿、全部执行配置的认证目录，Read／Edit 各一条。写法与执行线
//    （loops/verify_lib.py 的 deny_path / auth_home_deny_rules）相同，tests/decomposetest.mjs ⑨ 逐条对照。
//    执行线只能按文件名逐条钉（它要往 <data>/evidence 写证据，整目录 Read 拒绝会连写入一起挡掉）；
//    这里的两个调用都不往数据目录写任何东西，所以整目录拒绝，是执行线 PROTECTED 清单的超集，也不必另抄一份清单。
//  · 环境：先按旧线同一规则剔除全部配置登记的凭据变量（profileEnvironment(null,{profiles})），
//    再剔除看板自身的令牌类变量；标准登录变量保留，这两个调用本来就沿用用户的默认登录。
import {createRequire} from "node:module";
import {isAbsolute,resolve} from "node:path";
import {profileEnvironment} from "./execution-profiles.mjs";

const {DECOMPOSE_PLAN_SCHEMA}=createRequire(import.meta.url)("./decompose_lib.js");

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

const lockdown=scope=>["--permission-mode","dontAsk","--setting-sources","","--strict-mcp-config","--no-chrome",
 "--disallowedTools",...DENIED_TOOLS,...boardDenyRules(scope)];

/** 一键拆解：只读工作仓，计划经 --json-schema 的结构化输出交回（server 只读 structured_output，模型不写文件）。
 *  另关掉斜杠命令与技能（提示词从不是斜杠命令），不落会话文件（拆解不续接）。
 *  提示词紧跟 -p：放在任何可变参数 flag 之后会被吞成那个 flag 的取值。 */
export function decomposeCliArgs({prompt,model,repoRoot,dataDir,registry,authHomes}){
 if(typeof repoRoot!=="string"||!isAbsolute(repoRoot))throw new Error("工作仓必须是绝对路径");
 return ["-p",String(prompt),"--model",String(model),"--effort","high","--output-format","json",
  "--json-schema",JSON.stringify(DECOMPOSE_PLAN_SCHEMA),"--tools",...DECOMPOSE_TOOLS,"--add-dir",repoRoot,
  "--disable-slash-commands","--no-session-persistence",...lockdown({dataDir,registry,authHomes})];
}

/** 上下文压缩的两步（让会话写压缩指示、再 /compact）：都只需要模型产出文字，不给任何工具。
 *  不加 --disable-slash-commands：它连 /compact 一起关掉（2026-10-28 实测 init 里斜杠命令变成 0 条）。 */
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
 return {ok:true,result};
}

const typeOk=(type,value)=>type==="null"?value===null:type==="integer"?Number.isInteger(value):
 type==="array"?Array.isArray(value):type==="object"?!!value&&typeof value==="object"&&!Array.isArray(value):typeof value===type;

/** 按 schema 的子集（type、required、properties、additionalProperties:false、items、minLength、minimum）
 *  校验，返回错误列表（空 = 合格）。只为 DECOMPOSE_PLAN_SCHEMA 这一份服务，不是通用 JSON Schema 实现：
 *  CLI 会按 --json-schema 强制一次，server 收到后不信它、再按同一份 schema 查一次。 */
export function schemaErrors(value,schema,path="$"){
 const types=[schema.type].flat().filter(Boolean);
 if(types.length&&!types.some(type=>typeOk(type,value)))return [`${path} 应为 ${types.join("/")}`];
 const errors=[];
 if(typeof value==="string"&&schema.minLength!=null&&value.length<schema.minLength)errors.push(`${path} 不能为空`);
 if(typeof value==="number"&&schema.minimum!=null&&value<schema.minimum)errors.push(`${path} 不能小于 ${schema.minimum}`);
 if(Array.isArray(value)&&schema.items)value.forEach((item,i)=>errors.push(...schemaErrors(item,schema.items,`${path}[${i}]`)));
 if(typeOk("object",value)){
  for(const key of schema.required||[])if(!Object.hasOwn(value,key))errors.push(`${path}.${key} 缺失`);
  for(const [key,item] of Object.entries(value)){
   if(schema.properties&&Object.hasOwn(schema.properties,key))errors.push(...schemaErrors(item,schema.properties[key],`${path}.${key}`));
   else if(schema.additionalProperties===false)errors.push(`${path}.${key} 不在结构里`);
  }
 }
 return errors;
}

/** 拆解计划：只认结果 JSON 的 structured_output（--json-schema 的产物），再按同一份 schema 校验结构。
 *  不从 result 正文里抠 JSON：说明文字里出现花括号或分隔符时，正文提取会取错或失败（spike T4／ADV1），
 *  structured_output 缺失本身就是「CLI 没按契约交回」的内部失败，回退到正文只会把它藏起来。 */
export function decomposePlanOf(stdout){
 const answer=cliResult(stdout);
 if(!answer.ok)return answer;
 if(!Object.hasOwn(answer.result,"structured_output"))return {ok:false,reason:"CLI 结果里没有 structured_output(结构化输出没交回)"};
 const plan=answer.result.structured_output,errors=schemaErrors(plan,DECOMPOSE_PLAN_SCHEMA);
 if(errors.length)return {ok:false,reason:`structured_output 不合计划结构:${errors.slice(0,5).join("；")}`};
 return {ok:true,plan};
}
