import {createHash} from "node:crypto";
import {isAbsolute,join,relative,resolve} from "node:path";
import {detectClaude} from "./config-setup.mjs";

const CHANNELS=Object.freeze({
 claude_cli:{runtime:"claude",auth_kind:"subscription",billing_kind:"claude_subscription",budget_enforcement:"cli_controls"},
 codex_cli:{runtime:"codex",auth_kind:"chatgpt",billing_kind:"chatgpt_subscription",budget_enforcement:"cli_timeout_only"},
 claude_agent_sdk:{runtime:"claude",auth_kind:"api_key",billing_kind:"anthropic_api",budget_enforcement:"sdk_cost_turn_timeout"},
 codex_sdk_api:{runtime:"codex",auth_kind:"api_key",billing_kind:"openai_api",budget_enforcement:"provider_spend_limit_required"},
});
const DEFAULTS=[
 {id:"claude-cli",label:"Claude CLI",channel:"claude_cli",enabled:true},
 {id:"codex-cli",label:"Codex CLI",channel:"codex_cli",enabled:true},
 {id:"claude-api",label:"Claude API（Agent SDK）",channel:"claude_agent_sdk",enabled:false,credential_env:"KANBAN_ANTHROPIC_API_KEY"},
 {id:"gpt-api",label:"GPT API（Codex SDK）",channel:"codex_sdk_api",enabled:false,credential_env:"KANBAN_OPENAI_API_KEY"},
];
const FIELDS=new Set(["id","label","channel","enabled","credential_env","auth_home","budget","provider_spend_limit_confirmed"]);
const BUDGET_FIELDS=new Set(["timeout_sec","max_turns","max_cost_usd"]);
const record=value=>!!value&&typeof value==="object"&&!Array.isArray(value);
const api=profile=>profile.auth_kind==="api_key";
const fail=message=>{throw Object.assign(new Error(message),{code:"BAD_INPUT"});};
const envValue=(env,name)=>Object.entries(env||{}).find(([key])=>key.toUpperCase()===name.toUpperCase())?.[1];
const valuePresent=value=>typeof value==="string"&&value.trim().length>0;
const inside=(parent,child)=>{const r=relative(resolve(parent),resolve(child));return r===""||r!==".."&&!r.startsWith("..\\")&&!r.startsWith("../")&&!isAbsolute(r);};
const completeBudget=budget=>!!budget&&Object.values(budget).every(value=>typeof value==="number"&&Number.isFinite(value)&&value>0);
function budgetOf(value){
 if(value==null)return null;
 if(!record(value)||Object.keys(value).some(key=>!BUDGET_FIELDS.has(key)))fail("执行配置的预算字段无效");
 const budget={timeout_sec:value.timeout_sec??null,max_turns:value.max_turns??null,max_cost_usd:value.max_cost_usd??null};
 for(const [key,amount] of Object.entries(budget)){
  if(amount===null)continue;
  if(typeof amount!=="number"||!Number.isFinite(amount)||amount<=0||key!=="max_cost_usd"&&!Number.isSafeInteger(amount))fail("执行配置的预算、时限和轮次须为明确的正数");
 }
 return Object.freeze(budget);
}

/** 只规范化本机配置；不创建目录、不登录、不读取认证文件或调用模型。 */
export function loadExecutionProfiles(raw,{dataDir,env=process.env}={}){
 if(typeof dataDir!=="string"||!isAbsolute(dataDir)||dataDir.includes("\0"))fail("执行配置需要明确的本机数据目录");
 if(raw!==undefined&&(!Array.isArray(raw)||raw.length>64))fail("execution_profiles 必须是至多 64 项的数组");
 const entries=new Map(DEFAULTS.map(profile=>[profile.id,{...profile}])),seen=new Set();
 for(const entry of raw||[]){
  if(!record(entry)||Object.keys(entry).some(key=>!FIELDS.has(key))||typeof entry.id!=="string"||!/^[a-z][a-z0-9_-]{0,63}$/.test(entry.id))fail("执行配置需要有效标识和已知字段");
  if(seen.has(entry.id))fail("执行配置标识不能重复");seen.add(entry.id);
  const previous=entries.get(entry.id);
  if(previous&&entry.channel!==undefined&&entry.channel!==previous.channel)fail("内置执行配置不能更换通道，请使用新的配置标识");
  entries.set(entry.id,{...previous,...entry});
 }
 const profiles=[...entries.values()].map(entry=>{
  const channel=CHANNELS[entry.channel];
  if(!channel)fail("执行配置的通道无效");
  if(typeof entry.label!=="string"||!entry.label.trim()||entry.label.length>80)fail("执行配置需要简短的显示名称");
  if(entry.enabled!==undefined&&typeof entry.enabled!=="boolean")fail("执行配置 enabled 必须是布尔值");
  if(entry.provider_spend_limit_confirmed!==undefined&&typeof entry.provider_spend_limit_confirmed!=="boolean")fail("供应商项目金额上限的确认值必须是布尔值");
  const credentialEnv=entry.credential_env??(channel.runtime==="claude"?"KANBAN_ANTHROPIC_API_KEY":"KANBAN_OPENAI_API_KEY");
  if(typeof credentialEnv!=="string"||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(credentialEnv))fail("执行配置的凭据引用必须是环境变量名称，不能是密钥值");
  if(entry.auth_home!==undefined&&(typeof entry.auth_home!=="string"||!isAbsolute(entry.auth_home)||entry.auth_home.includes("\0")))fail("执行配置的认证目录须为本机绝对路径");
  return Object.freeze({id:entry.id,label:entry.label.trim(),channel:entry.channel,...channel,enabled:entry.enabled??false,
   credential_env:channel.auth_kind==="api_key"?credentialEnv:null,auth_home:resolve(entry.auth_home||join(dataDir,"auth",entry.id)),budget:budgetOf(entry.budget),
   provider_spend_limit_confirmed:entry.channel==="codex_sdk_api"&&entry.provider_spend_limit_confirmed===true});
 });
 for(let i=0;i<profiles.length;i++)for(let j=0;j<i;j++){
  const a=profiles[i],b=profiles[j];
  if(inside(a.auth_home,b.auth_home)||inside(b.auth_home,a.auth_home))fail("执行配置须使用互相分离的认证目录，不能覆盖其他通道登录");
 }
 // env 仅由调用方显式传入以保持合同一致，配置读取本身不绑定或保存密钥。
 void env;
 return Object.freeze(profiles);
}

export function getExecutionProfile(profiles,id,runtime){
 if(id==null)return null;
 if(typeof id!=="string"||!id)fail("执行配置标识无效");
 const profile=profiles.find(item=>item.id===id);
 if(!profile)fail("所选执行配置不存在，请重新读取设置");
 if(runtime!==undefined&&profile.runtime!==runtime)fail("执行配置与所选运行时不匹配");
 return profile;
}

/** 摘要固定私有配置身份，但不含凭据值、认证目录或凭据引用名。 */
export function executionProfileSnapshot(profile){
 if(profile==null)return null;
 const digest=createHash("sha256").update(JSON.stringify(profile)).digest("hex");
 return Object.freeze({execution_profile_id:profile.id,label:profile.label,runtime:profile.runtime,channel:profile.channel,enabled:profile.enabled,
  auth_kind:profile.auth_kind,billing_kind:profile.billing_kind,budget_enforcement:profile.budget_enforcement,
  provider_spend_limit_confirmed:profile.provider_spend_limit_confirmed,budget:profile.budget?{...profile.budget}:null,profile_digest:digest});
}

/** 仅反映配置条件，不把文件、凭据存在或许可启用当作登录／真实任务成功。 */
export function publicExecutionProfiles(profiles,{env=process.env,runtimes=[],repoRoot}={}){
 return profiles.map(profile=>{
  const seat=runtimes.find(item=>item.id===profile.runtime);
  const unlocked=!!seat&&!seat.disabled&&(!seat.release_env||envValue(env,seat.release_env)==="1");
  const commandConfigured=profile.runtime==="claude"?!!detectClaude(env):valuePresent(envValue(env,seat?.cmd_env||"BOARD_CODEX_CMD"));
  const configured=api(profile)?valuePresent(envValue(env,profile.credential_env)):commandConfigured;
  const enabled=profile.enabled&&(api(profile)||unlocked);
  const separated=!repoRoot||!inside(repoRoot,profile.auth_home)&&!inside(profile.auth_home,repoRoot);
  const hasBudget=completeBudget(profile.budget);
  const providerLimit=profile.channel!=="codex_sdk_api"||profile.provider_spend_limit_confirmed;
  const ready=enabled&&configured&&separated&&hasBudget&&providerLimit;
  const reason=!enabled?"尚未启用；需操作者明确许可":!configured?api(profile)?"尚未配置本通道的独立 API 凭据":"尚未配置本机 CLI":!separated?"认证目录与工作仓重叠，需要分离":!hasBudget?"尚未确认金额上限、时限和轮次预算":!providerLimit?"本地 SDK 仅控制时限与步数；金额须在供应商项目设置上限后由操作者确认":"配置齐全；登录、模型可用性与真实任务仍待核实";
  return {id:profile.id,label:profile.label,runtime:profile.runtime,channel:profile.channel,auth_kind:profile.auth_kind,billing_kind:profile.billing_kind,
   budget_enforcement:profile.budget_enforcement,provider_spend_limit_confirmed:profile.provider_spend_limit_confirmed,
   enabled,configured,ready,reason,budget:profile.budget?{...profile.budget}:null};
 });
}

/** 返回宿主 loop 环境；SDK 子进程仍须移除 BOARD／WORKER 身份秘密。profiles 传入全部配置，以剔除每个配置的凭据变量。 */
export function profileEnvironment(profile,{env=process.env,repoRoot,dataDir,profiles=[]}={}){
 // 旧线与审阅线（无执行配置）只剔除配置里登记的凭据变量名（含自定义名称）：这些是 API 通道专用的密钥，
 // 不该进 CLI 子进程或验证命令。标准名（ANTHROPIC_API_KEY、CLAUDE_CONFIG_DIR 等）不按名称规则剔除，
 // 旧 CLI 线可能本来就靠用户环境里的这些变量登录；配置把某个标准名登记成 credential_env 时，该名同样剔除。
 if(profile==null){
  const configured=new Set(profiles.map(item=>item?.credential_env?.toUpperCase()).filter(Boolean));
  return Object.fromEntries(Object.entries(env).filter(([key])=>!configured.has(key.toUpperCase())));
 }
 if(!profile.enabled)fail("所选执行配置尚未启用");
 if(repoRoot&&(inside(repoRoot,profile.auth_home)||inside(profile.auth_home,repoRoot)))fail("认证目录与工作仓必须分离");
 if(!completeBudget(profile.budget))fail("所选执行配置尚未确认金额上限、时限和轮次预算，未启动调用");
 if(api(profile)&&!valuePresent(envValue(env,profile.credential_env)))fail("API 通道缺少独立凭据，未启动调用");
 if(profile.channel==="codex_sdk_api"&&!profile.provider_spend_limit_confirmed)fail("本地 SDK 仅控制时限与步数；请先在供应商项目设置金额上限并由操作者明确确认，未启动调用");
 if(profile.channel==="codex_cli"&&(envValue(env,"BOARD_CODEX_RELEASED")!=="1"||!valuePresent(envValue(env,"BOARD_CODEX_CMD"))))fail("Codex CLI 尚未获原订阅座席许可或缺少命令配置");
 // 所有配置的凭据变量（含自定义名称）都不进宿主环境；当前 API 配置只在下方按标准名注入一次。
 const credentialNames=new Set([profile,...profiles].map(item=>item?.credential_env?.toUpperCase()).filter(Boolean));
 const output=Object.fromEntries(Object.entries(env).filter(([key,value])=>typeof value==="string"&&
  !/^(?:ANTHROPIC_|OPENAI_|AZURE_OPENAI_|CLAUDE_CODE_(?:OAUTH_TOKEN|USE_)|CLAUDE_CONFIG_DIR$|CODEX_(?:API_KEY|HOME)$|KANBAN_.*(?:KEY|TOKEN)$)/i.test(key)&&
  !credentialNames.has(key.toUpperCase())&&
  (/^(?:BOARD_|WORKER_|REVIEWER_)/.test(key)||!/(?:_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_SECRET_KEY|_PASSWORD)$/i.test(key))));
 if(profile.runtime==="claude")output.CLAUDE_CONFIG_DIR=profile.auth_home;else output.CODEX_HOME=profile.auth_home;
 if(api(profile))output[profile.runtime==="claude"?"ANTHROPIC_API_KEY":"OPENAI_API_KEY"]=envValue(env,profile.credential_env);
 output.WORKER_EXECUTION_PROFILE=JSON.stringify(executionProfileSnapshot(profile));
 output.WORKER_PROFILE_AUTH_HOME=profile.auth_home;
 if(profile.budget?.timeout_sec)output.WORKER_TIMEOUT_SEC=String(profile.budget.timeout_sec);
 if(profile.budget?.max_turns)output.WORKER_MAX_TURNS=String(profile.budget.max_turns);
 if(profile.budget?.max_cost_usd)output.WORKER_MAX_BUDGET_USD=String(profile.budget.max_cost_usd);
 output.WORKER_RATE_MAX_WAITS="0";
 void dataDir;
 return output;
}
