import {statSync} from "node:fs";
import {isAbsolute} from "node:path";
import {detectClaude,detectCodex,findOnPath} from "./config-setup.mjs";
import {readLegacyProcessStart,readSdkObservation} from "./task-execution-view.mjs";

/** 只读检查现有命令落点，不运行 CLI，不读取登录凭据或发起模型调用。 */
export function executorReadiness(seat,{env=process.env,enabled=true}={}){
 let command=null;
 try{command=seat.id==="claude"?detectClaude(env):seat.id==="codex"?detectCodex(env):null;}catch{}
 let installation="unknown";
 if(["claude","codex"].includes(seat.id)){
  if(command&&!isAbsolute(command))command=findOnPath(command,{env});
  try{installation=command&&statSync(command).isFile()?"available":"unavailable";}catch{installation="unavailable";}
 }
 return {command_configured:seat.cmd_env?!!env[seat.cmd_env]:!!command,enabled,installation};
}

/** 设置打开时才读取最近执行；结果回传不等于模型权限验收或当前登录有效。 */
export function runtimeVerifications(db,workerNames){
 if(!workerNames.length)return [];
 const placeholders=workerNames.map(()=>"?").join(","),result=[],seen=new Set();
 const hasBroker=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_dispatches'").get();
 // 只读最近 100 次运行，未找到证据仍为待核实，不作“从未成功”的反向判断。
 const runs=db.prepare(`SELECT * FROM task_runs WHERE worker IN (${placeholders}) AND imported=0 ORDER BY rowid DESC LIMIT 100`).all(...workerNames);
 for(const run of runs){
  if(hasBroker&&db.prepare("SELECT 1 FROM broker_dispatches WHERE run_id=?").get(run.run_id))continue;
  const started=readLegacyProcessStart(db,run,{attempt:run.last_attempt});
  if(!started)continue;
  const profile=JSON.parse(run.policy_json).context?.execution_profile??null;
  const sdk=readSdkObservation(db,run);
  if(profile?.auth_kind==="api_key"&&sdk?.terminal?.status!=="success")continue;
  const key=JSON.stringify([run.runtime,started.detail.model,started.detail.effort,profile?.execution_profile_id??null,profile?.profile_digest??null]);
  if(seen.has(key))continue;
  const task=db.prepare("SELECT task_uid,owner_node_id FROM tasks WHERE id=?").get(run.task_id);
  if(!task||task.task_uid!==run.task_uid||task.owner_node_id!==run.owner_node_id)continue;
  let returned=false;
  for(const e of db.prepare("SELECT actor,detail FROM task_events WHERE task_id=? AND kind='report' AND id>? ORDER BY id DESC").iterate(run.task_id,started.id)){
   let detail;try{detail=JSON.parse(e.detail);}catch{continue;}
   if(e.actor===run.worker&&detail.run_id===run.run_id&&detail.outcome==="done"){returned=true;break;}
  }
  if(!returned)continue;
  seen.add(key);
  result.push({runtime:run.runtime,model:started.detail.model,effort:started.detail.effort,state:"result_returned",task_id:run.task_id,observed_at:started.at,source:"worker_loop",...(profile?{execution_profile_id:profile.execution_profile_id,profile_digest:profile.profile_digest,channel:profile.channel}:{})});
 }
 return result;
}

/** 核对实际会发给 Claude CLI 的写放行规则（--allowedTools）的写法，返回发现的问题；空数组为合格。纯函数。
 *  bare_tool：不带路径的工具名，等于放行任意路径。relative_path：路径不是绝对形，CLI 按项目根相对解释。
 *  repo_ancestor：放行目录是工作仓的上级目录，工作仓之外也能写。只核写法，语义要用真实 CLI 量。 */
export function checkWriteAllowRules(rules,{repoRoot,platform=process.platform}={}){
 const win=platform==="win32",findings=[];
 const form=p=>{let v=String(p).replace(/\\/g,"/").replace(/\/+$/,"");if(!win)v="//"+v.replace(/^\/+/,"");return win?v.toLowerCase():v;};
 const repo=typeof repoRoot==="string"&&repoRoot?form(repoRoot):null;
 for(const rule of Array.isArray(rules)?rules:[]){
  const m=/^([A-Za-z_]+)\((.*)\)$/.exec(String(rule));
  if(!m||!m[2].trim()){findings.push({kind:"bare_tool",rule:String(rule)});continue;}
  const path=m[2];
  if(win?!/^[A-Za-z]:\//.test(path):!path.startsWith("//")){findings.push({kind:"relative_path",rule:String(rule)});continue;}
  const dir=form(path.replace(/\/\*{1,2}$/,""));
  if(repo&&dir!==repo&&repo.startsWith(dir.endsWith("/")?dir:dir+"/"))findings.push({kind:"repo_ancestor",rule:String(rule)});
 }
 return findings;
}
