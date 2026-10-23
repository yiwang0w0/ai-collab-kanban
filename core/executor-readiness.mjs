import {statSync} from "node:fs";
import {isAbsolute} from "node:path";
import {detectClaude,detectCodex,findOnPath} from "./config-setup.mjs";
import {readLegacyProcessStart} from "./task-execution-view.mjs";

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
  const key=JSON.stringify([run.runtime,started.detail.model,started.detail.effort]);
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
  result.push({runtime:run.runtime,model:started.detail.model,effort:started.detail.effort,state:"result_returned",task_id:run.task_id,observed_at:started.at,source:"worker_loop"});
 }
 return result;
}
