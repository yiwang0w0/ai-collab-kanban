import test from "node:test";
import assert from "node:assert/strict";
import {resolve,join} from "node:path";
import {tmpdir} from "node:os";
import {loadExecutionProfiles,getExecutionProfile,publicExecutionProfiles,executionProfileSnapshot,profileEnvironment} from "../core/execution-profiles.mjs";

const dataDir=resolve(tmpdir(),"kanban-配置夹具"),repoRoot=resolve(tmpdir(),"kanban-工作仓夹具");
const budget={timeout_sec:120,max_turns:4,max_cost_usd:0.5};
const env={PATH:process.env.PATH||process.env.Path||"",WORKER_CLAUDE_CLI:process.execPath,BOARD_CODEX_CMD:process.execPath,BOARD_CODEX_RELEASED:"1",
 KANBAN_ANTHROPIC_API_KEY:"fixture-anthropic-key",KANBAN_OPENAI_API_KEY:"fixture-openai-key"};
const runtimes=[{id:"claude",disabled:false},{id:"codex",disabled:false,release_env:"BOARD_CODEX_RELEASED",cmd_env:"BOARD_CODEX_CMD"}];
const load=raw=>loadExecutionProfiles(raw,{dataDir,env});
const apiProfiles=()=>load([{id:"claude-cli",budget},{id:"codex-cli",budget},{id:"claude-api",enabled:true,budget},{id:"gpt-api",enabled:true,budget,provider_spend_limit_confirmed:true}]);
const get=(profiles,id)=>getExecutionProfile(profiles,id);

test("旧设置保持 null 入口，四通道默认只展示、不启用 API",()=>{
 const profiles=load();assert.equal(profiles.length,4);assert.equal(getExecutionProfile(profiles,null,"claude"),null);assert.equal(getExecutionProfile(profiles,undefined,"codex"),null);
 assert.equal(get(profiles,"claude-cli").runtime,"claude");assert.equal(get(profiles,"codex-cli").runtime,"codex");
 for(const id of ["claude-api","gpt-api"]){assert.equal(get(profiles,id).enabled,false);assert.equal(get(profiles,id).budget,null);}
 assert.deepEqual(profileEnvironment(null,{env}),env);assert.ok(Object.isFrozen(profiles));assert.ok(Object.isFrozen(profiles[0]));
});

test("显式配置只接受已知通道、标识与预算；不可把密钥值当凭据引用",()=>{
 for(const invalid of [{},[{id:"claude-api",channel:"other"}],[{id:"new",label:"新通道",channel:"unknown"}],[{id:"claude-api",enabled:"true"}],[{id:"claude-api",credential_env:"sk-ant-actual-value"}],[{id:"claude-api",api_key:"秘密"}],[{id:"claude-api",budget:{timeout_sec:0}}],[{id:"claude-api",budget:{max_turns:1.5}}],[{id:"claude-api",budget:{max_cost_usd:-1}}],[{id:"claude-api",budget:{extra:1}}],[{id:"claude-api"},{id:"claude-api"}]]){
  assert.throws(()=>load(invalid),error=>error.code==="BAD_INPUT");
 }
 assert.throws(()=>getExecutionProfile(load(),"missing","claude"),{code:"BAD_INPUT"});assert.throws(()=>getExecutionProfile(load(),"","claude"),{code:"BAD_INPUT"});assert.throws(()=>getExecutionProfile(load(),"gpt-api","claude"),{code:"BAD_INPUT"});
 const partial=load([{id:"claude-api",enabled:true,budget:{timeout_sec:120}}]);assert.equal(get(partial,"claude-api").budget.max_turns,null);
 assert.equal(publicExecutionProfiles(partial,{env,runtimes,repoRoot}).find(p=>p.id==="claude-api").ready,false);
});

test("API 只有独立许可、凭据和完整预算齐备才配置就绪，不依赖 CLI 订阅闸",()=>{
 const profiles=apiProfiles();
 const unlocked=publicExecutionProfiles(profiles,{env,runtimes,repoRoot});assert.ok(unlocked.every(p=>p.ready));
 const locked=publicExecutionProfiles(profiles,{env:{...env,BOARD_CODEX_RELEASED:"0"},runtimes:[runtimes[0],{...runtimes[1],disabled:true}],repoRoot});
 assert.equal(locked.find(p=>p.id==="codex-cli").ready,false);assert.equal(locked.find(p=>p.id==="gpt-api").ready,true);
 const absent=publicExecutionProfiles(profiles,{env:{...env,KANBAN_OPENAI_API_KEY:""},runtimes,repoRoot}).find(p=>p.id==="gpt-api");
 assert.equal(absent.configured,false);assert.match(absent.reason,/独立 API 凭据/);
 const missingBudget=publicExecutionProfiles(load([{id:"claude-api",enabled:true}]),{env,runtimes,repoRoot}).find(p=>p.id==="claude-api");
 assert.equal(missingBudget.ready,false);assert.match(missingBudget.reason,/预算/);
});

test("公开配置和快照不含认证路径、变量名或密钥；摘要绑定配置而不绑定密钥值",()=>{
 const profiles=apiProfiles(),profile=get(profiles,"claude-api"),snapshot=executionProfileSnapshot(profile);
 assert.equal(snapshot.execution_profile_id,"claude-api");assert.equal(snapshot.channel,"claude_agent_sdk");assert.equal(snapshot.enabled,true);assert.match(snapshot.profile_digest,/^[a-f0-9]{64}$/);
 const publicJson=JSON.stringify([publicExecutionProfiles(profiles,{env,runtimes,repoRoot}),snapshot]);
 for(const privateValue of [dataDir,profile.auth_home,profile.credential_env,env.KANBAN_ANTHROPIC_API_KEY,env.KANBAN_OPENAI_API_KEY])assert.equal(publicJson.includes(privateValue),false,privateValue);
 const changed=get(load([{id:"claude-api",enabled:true,budget:{...budget,max_turns:5}}]),"claude-api");assert.notEqual(executionProfileSnapshot(changed).profile_digest,snapshot.profile_digest);
 assert.equal(executionProfileSnapshot(loadExecutionProfiles([{id:"claude-api",enabled:true,budget}],{dataDir,env:{...env,KANBAN_ANTHROPIC_API_KEY:"rotated"}}).find(p=>p.id==="claude-api")).profile_digest,snapshot.profile_digest);
});

test("显式 CLI 清除 API 认证与第三方路由，仅修改本次子环境",()=>{
 const profiles=load([{id:"claude-cli",budget},{id:"codex-cli",budget}]),original={...env,ANTHROPIC_API_KEY:"wrong-api",ANTHROPIC_AUTH_TOKEN:"wrong-token",ANTHROPIC_BASE_URL:"https://other.invalid",CLAUDE_CODE_OAUTH_TOKEN:"wrong-oauth",OPENAI_API_KEY:"wrong-openai",OPENAI_BASE_URL:"https://other.invalid",CODEX_API_KEY:"wrong-codex",WORKER_BOARD_TOKEN:"loop-only-token",WORKER_TIMEOUT_SEC:"120",BOARD_URL:"http://127.0.0.1:47824"};
 const before=JSON.stringify(original),child=profileEnvironment(get(profiles,"claude-cli"),{env:original,repoRoot,dataDir});
 for(const key of ["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_BASE_URL","CLAUDE_CODE_OAUTH_TOKEN","OPENAI_API_KEY","OPENAI_BASE_URL","CODEX_API_KEY","KANBAN_ANTHROPIC_API_KEY","KANBAN_OPENAI_API_KEY"])assert.equal(Object.hasOwn(child,key),false,key);
 assert.equal(child.CLAUDE_CONFIG_DIR,get(profiles,"claude-cli").auth_home);assert.equal(child.WORKER_BOARD_TOKEN,"loop-only-token");assert.equal(child.WORKER_TIMEOUT_SEC,"120");assert.equal(child.BOARD_URL,original.BOARD_URL);assert.equal(JSON.stringify(original),before);
 assert.throws(()=>profileEnvironment(get(profiles,"codex-cli"),{env:{...original,BOARD_CODEX_RELEASED:"0"},repoRoot,dataDir}),{code:"BAD_INPUT"});
});

test("API 子环境只注入本家独立凭据，保留宿主绑定并设置明确预算",()=>{
 const profiles=apiProfiles(),original={...env,ANTHROPIC_API_KEY:"stale-anthropic",OPENAI_API_KEY:"stale-openai",CODEX_API_KEY:"stale-codex",WORKER_BOARD_TOKEN:"loop-only-token",BOARD_URL:"http://127.0.0.1:47824",MY_OTHER_API_KEY:"unrelated-private-key"};
 for(const [id,key,wanted,unwanted] of [["claude-api","ANTHROPIC_API_KEY",env.KANBAN_ANTHROPIC_API_KEY,"OPENAI_API_KEY"],["gpt-api","OPENAI_API_KEY",env.KANBAN_OPENAI_API_KEY,"ANTHROPIC_API_KEY"]]){
  const profile=get(profiles,id),child=profileEnvironment(profile,{env:original,repoRoot,dataDir});
  assert.equal(child[key],wanted);assert.equal(Object.hasOwn(child,unwanted),false);assert.equal(Object.hasOwn(child,"MY_OTHER_API_KEY"),false);assert.equal(Object.hasOwn(child,"CODEX_API_KEY"),false);
  assert.equal(child.WORKER_BOARD_TOKEN,"loop-only-token");assert.equal(child.WORKER_TIMEOUT_SEC,"120");assert.equal(child.WORKER_MAX_TURNS,"4");assert.equal(child.WORKER_MAX_BUDGET_USD,"0.5");assert.equal(child.WORKER_RATE_MAX_WAITS,"0");
  const snapshot=JSON.parse(child.WORKER_EXECUTION_PROFILE);assert.equal(snapshot.execution_profile_id,id);assert.equal(snapshot.runtime,profile.runtime);assert.equal(snapshot.enabled,true);assert.equal(JSON.stringify(snapshot).includes(wanted),false);
 }
 assert.throws(()=>profileEnvironment(get(load(),"claude-api"),{env:original,repoRoot,dataDir}),{code:"BAD_INPUT"});
 assert.throws(()=>profileEnvironment(get(profiles,"gpt-api"),{env:{...original,KANBAN_OPENAI_API_KEY:""},repoRoot,dataDir}),{code:"BAD_INPUT"});
});

test("认证目录只接受明确绝对路径，禁止通道之间或与工作仓重叠",()=>{
 assert.throws(()=>load([{id:"claude-api",auth_home:"相对目录"}]),{code:"BAD_INPUT"});
 assert.throws(()=>load([{id:"claude-api",auth_home:join(dataDir,"auth","claude-cli")}]),{code:"BAD_INPUT"});
 const profiles=load([{id:"claude-api",enabled:true,budget,auth_home:join(repoRoot,".private-auth")}]);
 assert.equal(publicExecutionProfiles(profiles,{env,runtimes,repoRoot}).find(p=>p.id==="claude-api").ready,false);
 assert.throws(()=>profileEnvironment(get(profiles,"claude-api"),{env,repoRoot,dataDir}),{code:"BAD_INPUT"});
});

test("金额控制边界明确：所有显式通道须有预算，GPT API 须确认供应商上限",()=>{
 const defaults=load(),facts=publicExecutionProfiles(defaults,{env,runtimes,repoRoot});
 for(const id of ["claude-cli","codex-cli"]){
  const profile=get(defaults,id),fact=facts.find(p=>p.id===id);assert.equal(fact.ready,false);assert.match(fact.reason,/预算/);
  assert.throws(()=>profileEnvironment(profile,{env,repoRoot,dataDir}),error=>error.code==="BAD_INPUT"&&/预算/.test(error.message));
 }
 assert.deepEqual(profileEnvironment(null,{env}),env,"未指定配置的旧 CLI 环境不受新预算门影响");
 const pending=load([{id:"gpt-api",enabled:true,budget}]),waiting=get(pending,"gpt-api");
 assert.equal(waiting.provider_spend_limit_confirmed,false);
 const publicWaiting=publicExecutionProfiles(pending,{env,runtimes,repoRoot}).find(p=>p.id==="gpt-api");
 assert.equal(publicWaiting.ready,false);assert.equal(publicWaiting.budget_enforcement,"provider_spend_limit_required");assert.match(publicWaiting.reason,/本地 SDK 仅控制时限与步数/);assert.match(publicWaiting.reason,/供应商项目/);
 assert.throws(()=>profileEnvironment(waiting,{env,repoRoot,dataDir}),error=>error.code==="BAD_INPUT"&&/金额上限/.test(error.message));
 assert.throws(()=>load([{id:"gpt-api",provider_spend_limit_confirmed:"yes"}]),{code:"BAD_INPUT"});
 const profiles=apiProfiles(),confirmed=get(profiles,"gpt-api"),snapshot=executionProfileSnapshot(confirmed);
 assert.equal(snapshot.provider_spend_limit_confirmed,true);assert.equal(snapshot.budget_enforcement,"provider_spend_limit_required");assert.notEqual(snapshot.profile_digest,executionProfileSnapshot(waiting).profile_digest);
 const expected={"claude-cli":"cli_controls","codex-cli":"cli_controls","claude-api":"sdk_cost_turn_timeout","gpt-api":"provider_spend_limit_required"};
 for(const profile of profiles){assert.equal(executionProfileSnapshot(profile).budget_enforcement,expected[profile.id]);assert.equal(profileEnvironment(profile,{env:{...env,WORKER_RATE_MAX_WAITS:"24"},repoRoot,dataDir}).WORKER_RATE_MAX_WAITS,"0");}
 const irrelevant=get(load([{id:"claude-api",provider_spend_limit_confirmed:true}]),"claude-api");assert.equal(irrelevant.provider_spend_limit_confirmed,false);
});
