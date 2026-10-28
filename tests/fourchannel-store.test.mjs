import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {loadExecutionProfiles,getExecutionProfile,executionProfileSnapshot} from "../core/execution-profiles.mjs";

const require=createRequire(import.meta.url),store=require("../core/store.js");
const profiles=loadExecutionProfiles([{id:"claude-api",enabled:true,budget:{timeout_sec:120,max_turns:4,max_cost_usd:0.5}}],{dataDir:join(tmpdir(),"kanban-store-配置夹具")});
const binding={...executionProfileSnapshot(getExecutionProfile(profiles,"claude-api")),model:"claude-haiku-4-5",effort:"high",tools:"write",
 workspace:{label:"当前项目",path:join(tmpdir(),"kanban-store-工作仓夹具"),device:"1",inode:"2"}};
function fixture(t){
 const db=new DatabaseSync(":memory:");store.migrate(db);t.after(()=>db.close());
 const add=executionProfile=>store.add(db,{subject:"四通道存储夹具",line:"sample",released:1,...(executionProfile?{executionProfile}: {})});
 const claim=(id,{profile=binding,agentInstanceId=randomUUID(),force=false}={})=>{
  const worker="sample",task=store.get(db,id);
  const result=store.claimById(db,{id,worker,runtime:"claude",agentInstanceId,force,expectedVersion:task.aggregate_version,
   executionProfile:profile,runContext:{role_id:"sample",role_kind:"implement",tools:"write",...(profile?{execution_profile:profile}:{})}});
  assert.equal(result.ok,true,JSON.stringify(result));
  return {task:result.task,worker,agentInstanceId};
 };
 return {db,add,claim};
}
const eventArgs=(run,extra={})=>({id:run.task.id,worker:run.worker,runId:run.task.run_id,agentInstanceId:run.agentInstanceId,
 executionProfile:binding,eventId:randomUUID(),kind:"activity",model:binding.model,effort:binding.effort,...extra});
const startArgs=run=>({id:run.task.id,worker:run.worker,runId:run.task.run_id,agentInstanceId:run.agentInstanceId,
 runtime:"claude",attempt:run.task.attempts,pid:12345,model:binding.model,effort:binding.effort,executionProfile:binding});

test("执行配置固定到卡片和运行，旧卡不被 API 配置捡走，错配不消耗尝试",t=>{
 const f=fixture(t),legacy=f.add(),id=f.add(binding);
 assert.equal(store.taskExecutionProfile(f.db,legacy),null);assert.deepEqual(store.taskExecutionProfile(f.db,id),binding);
 assert.equal(store.matchesExecutionProfile(f.db,store.get(f.db,legacy),null),true);
 for(const change of [{execution_profile_id:"gpt-api"},{profile_digest:"f".repeat(64)},{runtime:"codex"},{model:"claude-opus-5"},{effort:"low"},{channel:"claude_cli"},
  {tools:"read-only"},{workspace:undefined},{workspace:{...binding.workspace,path:join(tmpdir(),"另一个工作仓")}},
  {workspace:{...binding.workspace,device:"3"}},{workspace:{...binding.workspace,inode:"4"}}]){
  const task=store.get(f.db,id),wrong={...binding,...change};
  assert.equal(store.matchesExecutionProfile(f.db,task,wrong),false);
  const refused=store.claimById(f.db,{id,worker:"sample",runtime:"claude",agentInstanceId:randomUUID(),executionProfile:wrong,expectedVersion:task.aggregate_version});
  assert.equal(refused.ok,false);assert.equal(refused.code,"CONFLICT");assert.equal(store.get(f.db,id).attempts,0);
 }
 const instance=randomUUID(),claimed=store.claim(f.db,"sample",5,{line:"sample",runtime:"claude",agentInstanceId:instance,
  executionProfile:binding,runContext:{role_id:"sample",role_kind:"implement",tools:"write",execution_profile:binding}});
 assert.equal(claimed.id,id,"任务池跳过更早的旧 CLI 卡");
 const run=store.runs(f.db,id).find(r=>r.run_id===claimed.run_id);assert.deepEqual(run.policy.context.execution_profile,binding);
 assert.equal(store.matchesExecutionProfile(f.db,store.get(f.db,id),{...binding,workspace:{...binding.workspace,label:"仅改显示名"}}),true,"显示标签不改变目录身份");
 const oldClaim=store.claim(f.db,"legacy-worker",5,{line:"sample",runtime:"claude",agentInstanceId:randomUUID()});
 assert.equal(oldClaim.id,legacy,"无执行配置的旧领取合同保留");
});

test("SDK 观察保留未知用量与费用，同一事件重送幂等且不能改内容",t=>{
 const f=fixture(t),id=f.add(binding),run=f.claim(id),before=store.get(f.db,id);
 const started=store.recordProcessStarted(f.db,startArgs(run));assert.ok(Number.isFinite(Date.parse(started.recorded_at)));
 const activity=eventArgs(run,{requestId:"fixture-request-1",sessionId:"fixture-session-1"});
 const first=store.recordExecutionEvent(f.db,activity),again=store.recordExecutionEvent(f.db,{...activity});assert.deepEqual(again,first);
 const unknown={input_tokens:null,output_tokens:null,cached_input_tokens:null,calls:null};
 const terminal=eventArgs(run,{kind:"terminal",requestId:"fixture-request-1",sessionId:"fixture-session-1",status:"success",usage:unknown,costUsd:null});
 const end=store.recordExecutionEvent(f.db,terminal);assert.deepEqual(store.recordExecutionEvent(f.db,{...terminal,usage:{...unknown}}),end);
 assert.throws(()=>store.recordExecutionEvent(f.db,{...terminal,status:"failed"}),{code:"CONFLICT"});
 assert.throws(()=>store.recordExecutionEvent(f.db,eventArgs(run,{kind:"terminal",status:"success",usage:{calls:-1}})),{code:"BAD_INPUT"});
 const history=store.events(f.db,{taskId:id}),observations=history.filter(e=>e.kind.startsWith("execution."));
 assert.deepEqual(observations.map(e=>e.kind),["execution.activity","execution.terminal"]);
 assert.deepEqual(observations[1].detail.usage,unknown);assert.equal(observations[1].detail.cost_usd,null);
 assert.equal(observations[1].detail.channel,binding.channel);assert.equal(observations[1].detail.profile_digest,binding.profile_digest);
 const after=store.get(f.db,id);for(const key of ["status","attempts","lease_until","aggregate_version"])assert.equal(after[key],before[key],key);
});

test("新配置同轮相同报告幂等，内容变化拒绝，旧无配置重复报告保持原拒绝",t=>{
 const f=fixture(t),id=f.add(binding),run=f.claim(id),args={id,worker:run.worker,runId:run.task.run_id,outcome:"done",evidence:"合成结果，不调用模型"};
 const first=store.report(f.db,args);assert.equal(first.status,"waiting");assert.equal(first.waiting_for,"review");
 assert.deepEqual(store.report(f.db,{...args}),first);
 assert.throws(()=>store.report(f.db,{...args,evidence:"不同结果"}),{code:"CONFLICT"});
 assert.throws(()=>store.report(f.db,{...args,outcome:"wait"}),{code:"CONFLICT"});
 assert.equal(store.events(f.db,{taskId:id}).filter(e=>e.kind==="report").length,1);
 const legacy=f.add(),legacyRun=f.claim(legacy,{profile:null}),old={id:legacy,worker:legacyRun.worker,runId:legacyRun.task.run_id,outcome:"done",evidence:"旧协议合成结果"};
 store.report(f.db,old);assert.throws(()=>store.report(f.db,old),{code:"CONFLICT"});
});

test("换轮后拒收旧启动、SDK 观察和结果，当前运行仍须匹配实例和配置",t=>{
 const f=fixture(t),id=f.add(binding),old=f.claim(id);
 assert.deepEqual(store.releaseHeldBy(f.db,old.worker),[id]);
 const held=store.get(f.db,id);assert.equal(held.released,false);assert.match(held.result,/结果未知/);
 store.setReleased(f.db,{id,released:true,expectedVersion:held.aggregate_version,executionProfile:binding});
 const current=f.claim(id,{force:true});assert.notEqual(current.task.run_id,old.task.run_id);
 assert.throws(()=>store.recordProcessStarted(f.db,startArgs(old)),{code:"CONFLICT"});
 assert.throws(()=>store.recordExecutionEvent(f.db,eventArgs(old)),{code:"CONFLICT"});
 assert.throws(()=>store.report(f.db,{id,worker:old.worker,runId:old.task.run_id,outcome:"done",evidence:"过期结果"}),{code:"CONFLICT"});
 assert.throws(()=>store.recordExecutionEvent(f.db,eventArgs(current,{agentInstanceId:old.agentInstanceId})),{code:"CONFLICT"});
 assert.throws(()=>store.recordExecutionEvent(f.db,eventArgs(current,{executionProfile:{...binding,profile_digest:"a".repeat(64)}})),{code:"CONFLICT"});
 const accepted=store.recordExecutionEvent(f.db,eventArgs(current));assert.equal(accepted.run_id,current.task.run_id);
 const events=store.events(f.db,{taskId:id}).filter(e=>["execution.activity","execution.terminal"].includes(e.kind));assert.equal(events.length,1);assert.equal(events[0].detail.run_id,current.task.run_id);
 assert.equal(store.get(f.db,id).status,"in_progress");assert.equal(store.get(f.db,id).attempts,2);
});

test("停止或租约到期后显式配置须重新放行，旧卡回收与既有结果保持",t=>{
 const f=fixture(t),profileId=f.add(binding),legacyId=f.add();
 const first=f.claim(profileId);f.claim(legacyId,{profile:null});
 f.db.prepare("UPDATE tasks SET result=? WHERE id=?").run("先前已保存的结果",profileId);
 assert.deepEqual(store.releaseHeldBy(f.db,"sample").sort((a,b)=>a-b),[profileId,legacyId]);
 const stopped=store.get(f.db,profileId);assert.equal(stopped.status,"not_started");assert.equal(stopped.released,false);assert.match(stopped.result,/先前已保存的结果/);assert.match(stopped.result,/结果未知/);
 assert.equal(store.get(f.db,legacyId).released,true,"旧无配置卡仍按原规则回到已放行队列");
 const released=store.events(f.db,{taskId:profileId}).find(event=>event.kind==="release");
 assert.equal(released.detail.recovery_required,true);assert.equal(released.detail.result_state,"unknown");assert.equal(released.detail.run_id,first.task.run_id);assert.equal(released.detail.released,false);
 assert.equal(store.claim(f.db,"other-api",5,{line:"sample",runtime:"claude",agentInstanceId:randomUUID(),executionProfile:binding}),null,"另一实例不能自动续跑已消费的显式任务");
 const expiredProfile=f.add(binding),expiredLegacy=f.add();f.claim(expiredProfile);f.claim(expiredLegacy,{profile:null});
 f.db.prepare("UPDATE tasks SET lease_until=? WHERE id IN (?,?)").run(Date.now()-1000,expiredProfile,expiredLegacy);
 assert.equal(store.reapExpired(f.db),2);
 assert.equal(store.get(f.db,expiredProfile).released,false);assert.match(store.get(f.db,expiredProfile).result,/结果未知/);assert.equal(store.get(f.db,expiredLegacy).released,true);
 const reaped=store.events(f.db,{taskId:expiredProfile}).find(event=>event.kind==="reap");assert.equal(reaped.detail.result_state,"unknown");assert.equal(reaped.detail.recovery_reason,"lease_expired");
 assert.equal(store.reapExpired(f.db),0,"重复收尾不产生新的回收或调用许可");
});

test("显式配置卡打回、通过并备注或重开后撤回放行，同一配置须本人重新放行才能再次领取",t=>{
 const f=fixture(t),pool=()=>store.claim(f.db,"sample",5,{line:"sample",runtime:"claude",agentInstanceId:randomUUID(),executionProfile:binding,
  runContext:{role_id:"sample",role_kind:"implement",tools:"write",execution_profile:binding}});
 const deliver=(id,profile=binding)=>{const run=f.claim(id,{profile});store.report(f.db,{id,worker:run.worker,runId:run.task.run_id,outcome:"done",evidence:"合成结果，不调用模型"});};
 const version=id=>store.get(f.db,id).aggregate_version;
 for(const [label,act] of [
  ["打回并备注",id=>store.resolve(f.db,{id,verdict:"reject",note:"请补一处说明",expectedVersion:version(id)})],
  ["通过并备注",id=>store.resolve(f.db,{id,verdict:"approve",note:"通过，备注一句",expectedVersion:version(id)})],
  ["关闭后重开",id=>{store.resolve(f.db,{id,verdict:"approve",expectedVersion:version(id)});assert.equal(store.get(f.db,id).status,"done");store.reopen(f.db,{id,expectedVersion:version(id)});}],
 ]){
  const id=f.add(binding);deliver(id);act(id);
  const back=store.get(f.db,id);assert.equal(back.status,"not_started",label);assert.equal(back.released,false,label);
  assert.match(back.result,/合成结果/,label);assert.match(back.result,/重新放行/,label);
  assert.equal(store.events(f.db,{taskId:id}).at(-1).detail.released,false,label+"：历史记录撤回后的放行状态");
  assert.equal(pool(),null,label+"：同一配置不能不经重新放行就再次计费领取");
  store.setReleased(f.db,{id,released:true,expectedVersion:back.aggregate_version,executionProfile:binding});
  assert.equal(pool()?.id,id,label+"：本人重新放行后可再领取");
 }
 const legacy=f.add();deliver(legacy,null);store.resolve(f.db,{id:legacy,verdict:"reject",note:"旧卡打回",expectedVersion:version(legacy)});
 assert.equal(store.get(f.db,legacy).released,true,"旧无配置卡打回后仍按原规则保持放行");
});
