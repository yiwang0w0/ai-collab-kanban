import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
import { fixtureVersion } from "./http-version-fixture.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
const require=createRequire(import.meta.url), store=require("../core/store.js");
const handles=[], TMP=mkdtempSync(join(tmpdir(),"fleet-run-"));
const ROOT=fileURLToPath(new URL("../",import.meta.url));
function fixture() {
  const db=new DatabaseSync(":memory:"); handles.push(db); store.migrate(db);
  const id=store.add(db,{subject:"run fixture"});
  return {db,id};
}
function claim(db,id,opts={}) {
  const r=store.claimById(db,{id,worker:"worker-a",...opts});
  assert.equal(r.ok,true,JSON.stringify(r)); return r.task;
}
function callback(db,id,runId,op="report") {
  return store[op](db,{id,worker:"worker-a",runId,outcome:"done",evidence:"accepted"});
}
after(()=>{for(const db of handles)db.close();rmSync(TMP,{recursive:true,force:true});});

test("same-name reclaim receives a new ID; old report changes no row or history",()=>{
  const {db,id}=fixture(), first=claim(db,id);
  store.releaseHeldBy(db,"worker-a"); const second=claim(db,id);
  assert.notEqual(first.run_id,second.run_id);
  const before=store.get(db,id), events=store.events(db,{taskId:id});
  assert.throws(()=>callback(db,id,first.run_id),{code:"CONFLICT"});
  assert.deepEqual(store.get(db,id),before); assert.deepEqual(store.events(db,{taskId:id}),events);
  callback(db,id,second.run_id); assert.equal(store.get(db,id).status,"waiting");
});
for(const op of ["report","heartbeat","bumpAttempt"]) {
  test(op+" rejects missing/malformed IDs and stale runs",()=>{
    const {db,id}=fixture(), a=claim(db,id);
    for(const token of [undefined,null,"",42,"invalid"]) assert.throws(()=>callback(db,id,token,op),{code:"BAD_INPUT"});
    store.releaseHeldBy(db,"worker-a"); const b=claim(db,id), before=store.get(db,id);
    assert.throws(()=>callback(db,id,a.run_id,op),{code:"CONFLICT"});
    assert.deepEqual(store.get(db,id),before);
    callback(db,id,b.run_id,op);
  });
}
for (const op of ["report","heartbeat","bumpAttempt"]) {
  test(op+" fences a same-worker reclaim between pre-read and SQL write",()=>{
    const {db,id}=fixture(), first=claim(db,id); let switched=false, second;
    const switchRun=()=>{if(switched)return; switched=true;store.releaseHeldBy(db,"worker-a");second=claim(db,id);};
    // Deterministic interleaving of another writer before the first mutation.
    // report starts a transaction; heartbeat and retry are single gated UPDATEs.
    const proxy=new Proxy(db,{get(target,key){
      if(key==="exec")return sql=>{if(op==="report" && sql==="BEGIN IMMEDIATE")switchRun();return target.exec(sql);};
      if(key==="prepare")return sql=>{
        if(op!=="report" && /^UPDATE tasks SET (heartbeat_at|attempts=attempts)/.test(sql))switchRun();
        return target.prepare(sql);
      };
      const v=target[key];return typeof v==="function"?v.bind(target):v;
    }});
    assert.throws(()=>callback(proxy,id,first.run_id,op),{code:"CONFLICT"});
    assert.equal(switched,true);assert.equal(store.get(db,id).run_id,second.run_id);
    assert.equal(store.get(db,id).status,"in_progress");assert.equal(store.get(db,id).attempts,2);
    assert.equal(store.runs(db,id)[1].state,"running");
    callback(db,id,second.run_id);
  });
}
test("cross-task run IDs cannot authorize reports",()=>{
  const {db,id}=fixture(); const a=claim(db,id);
  const other=store.add(db,{subject:"other"}); claim(db,other);
  assert.throws(()=>callback(db,other,a.run_id),{code:"CONFLICT"});
});
test("retry stays within the claim and updates the ledger's last attempt",()=>{
  const {db,id}=fixture(), a=claim(db,id); callback(db,id,a.run_id,"bumpAttempt");
  const [run]=store.runs(db,id);
  assert.equal(run.first_attempt,1);assert.equal(run.last_attempt,2);assert.equal(run.run_id,a.run_id);
  callback(db,id,a.run_id);
  assert.equal(store.runs(db,id)[0].state,"ended");assert.ok(store.runs(db,id)[0].ended_at);
});
test("policy is hashed and immutable; next dispatch gets a fresh snapshot",()=>{
  const {db,id}=fixture(), agent=randomUUID();
  const a=claim(db,id,{runtime:"codex",agentInstanceId:agent,runContext:{role_id:"reviewer",tools:"read-only"}});
  const r=store.runs(db,id)[0];
  assert.equal(r.agent_instance_id,agent);assert.equal(r.task_uid,a.task_uid);
  assert.equal(r.policy_sha256,createHash("sha256").update(r.policy_json).digest("hex"));
  assert.throws(()=>db.exec("UPDATE task_runs SET policy_json='{}'"),/immutable/);
  assert.throws(()=>db.exec("DELETE FROM task_runs"),/append-only/);
  store.releaseHeldBy(db,"worker-a");claim(db,id,{runContext:{role_id:"implementer",tools:"write"}});
  assert.equal(store.runs(db,id)[0].policy.context.tools,"read-only");
  assert.equal(store.runs(db,id)[1].policy.context.tools,"write");
});
test("bad dispatch identity rolls back task, history and run creation",()=>{
  const {db,id}=fixture(), before=store.get(db,id), ev=store.events(db,{taskId:id});
  assert.throws(()=>claim(db,id,{agentInstanceId:"no"}),{code:"BAD_INPUT"});
  assert.deepEqual(store.get(db,id),before); assert.deepEqual(store.events(db,{taskId:id}),ev);
  assert.equal(store.runs(db,id).length,0);
});
test("child creation checks the original parent run within the add transaction",()=>{
  const {db,id}=fixture(), a=claim(db,id);
  store.releaseHeldBy(db,"worker-a"); const b=claim(db,id);
  const args={subject:"child",parentId:id,parentWorker:"worker-a"};
  assert.throws(()=>store.add(db,{...args,parentRunId:a.run_id}),{code:"CONFLICT"});
  assert.throws(()=>store.add(db,{...args,parentRunId:null}),{code:"BAD_INPUT"});
  const child=store.add(db,{...args,parentRunId:b.run_id});
  assert.equal(store.get(db,child).parent_id,id);
});
test("reaper ends old run; reclaimed run rejects delayed callbacks",()=>{
  const {db,id}=fixture(), a=claim(db,id);
  db.prepare("UPDATE tasks SET lease_until=1 WHERE id=?").run(id);store.reapExpired(db);
  assert.equal(store.runs(db,id)[0].state,"ended");
  const b=claim(db,id);assert.notEqual(a.run_id,b.run_id);
  assert.throws(()=>callback(db,id,a.run_id),{code:"CONFLICT"});
});
test("migration imports legacy in-flight dispatch exactly once",()=>{
  const {db,id}=fixture();
  db.prepare("UPDATE tasks SET status='in_progress',worker='legacy',attempts=3 WHERE id=?").run(id);
  store.migrate(db);const a=store.get(db,id);store.migrate(db);
  assert.equal(store.get(db,id).run_id,a.run_id);assert.equal(store.runs(db,id).length,1);
  const r=store.runs(db,id)[0];assert.equal(r.imported,1);assert.equal(r.agent_instance_id,null);
  assert.equal(r.first_attempt,3);
});
test("mismatched persisted run pointer refuses restart",()=>{
  const {db,id}=fixture();claim(db,id);
  db.prepare("UPDATE tasks SET run_id=? WHERE id=?").run(randomUUID(),id);
  assert.throws(()=>store.migrate(db),{code:"CONFLICT"});
});
test("public task edits cannot forge run IDs",()=>{
  const {db,id}=fixture();
  for(const k of ["run_id","runId"]) {
    assert.throws(()=>store.add(db,{subject:"forged",[k]:randomUUID()}),{code:"BAD_INPUT"});
    assert.throws(()=>store.update(db,{id,[k]:randomUUID()}),{code:"BAD_INPUT"});
  }
});

test("worker derived release is decided atomically from durable parent-run provenance",()=>{
  const {db,id}=fixture(), first=claim(db,id);
  const derive=(subject,extra={})=>store.add(db,{subject,parentId:id,parentRunId:first.run_id,parentWorker:"worker-a",workerDerived:true,...extra});
  assert.throws(()=>derive("wrong owner",{parentWorker:"other"}),{code:"CONFLICT"});
  assert.throws(()=>derive("stale",{parentRunId:randomUUID()}),{code:"CONFLICT"});
  const a=derive("first",{released:0}),b=derive("second",{released:1});
  assert.equal(store.get(db,a).released,true);assert.equal(store.get(db,b).released,false);
  assert.equal(store.events(db,{taskId:a}).find(e=>e.kind==="add").detail.parent_run_id,first.run_id);
  // 首案归档后来源仍在历史中；失败的创建不占用首案名额。
  store.archive(db,{id:a,expectedVersion:store.get(db,a).aggregate_version});
  const later=derive("later request",{released:1});assert.equal(store.get(db,later).released,false);
  for(const child of [b,later])store.archive(db,{id:child,expectedVersion:store.get(db,child).aggregate_version});
  store.releaseHeldBy(db,"worker-a");const next=claim(db,id);
  assert.throws(()=>derive("old run"),{code:"CONFLICT"});
  const c=derive("new run",{parentRunId:next.run_id,released:0});assert.equal(store.get(db,c).released,true);
  // 内部调用没有该可信来源标志，原来的显式放行参数保持不变。
  const internal=store.add(db,{subject:"internal",parentId:id,released:0});assert.equal(store.get(db,internal).released,false);
  const root=store.add(db,{subject:"root",kind:"goal"}),deep=store.add(db,{subject:"deep",parentId:root}),leaf=store.add(db,{subject:"leaf",parentId:deep});
  const run=claim(db,leaf);
  const up=store.add(db,{subject:"uplift first",parentId:leaf,parentRunId:run.run_id,parentWorker:"worker-a",workerDerived:true});
  const afterUp=store.add(db,{subject:"after uplift",parentId:leaf,parentRunId:run.run_id,parentWorker:"worker-a",workerDerived:true});
  assert.equal(store.get(db,up).parent_id,root);assert.equal(store.get(db,up).released,false);assert.equal(store.get(db,afterUp).released,false);
  const legacy=store.add(db,{subject:"legacy parent"}),oldRun=claim(db,legacy);
  const oldChild=store.add(db,{subject:"before upgrade",parentId:legacy});
  store.archive(db,{id:oldChild,expectedVersion:store.get(db,oldChild).aggregate_version});
  const unknown=store.add(db,{subject:"unknown prior origin",parentId:legacy,parentRunId:oldRun.run_id,parentWorker:"worker-a",workerDerived:true});
  assert.equal(store.get(db,unknown).released,false,"旧子卡缺少来源时保守待放行，归档不抹除历史");
});

test("HTTP protocol rejects old workers and stale child/report/retry/heartbeat writes",async()=>{
  const listener=createServer();await new Promise(r=>listener.listen(0,"127.0.0.1",r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  const config=join(TMP,"fleet.config.json");
  writeFileSync(config,JSON.stringify({lines:[{id:"alpha",role:{kind:"implement",tools:"write"}}]}));
  const proc=spawn(process.execPath,[join(ROOT,"core/server.mjs")],{
    env:{...HOST_ENV,BOARD_PORT:String(port),BOARD_DATA_DIR:TMP,BOARD_DB:join(TMP,"http.db"),
      BOARD_CONFIG:config,BOARD_ALLOW_UNPINNED:"1",BOARD_RESTART_MODE:"exit"},
    windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let out="";proc.stdout.on("data",b=>out+=b);proc.stderr.on("data",b=>out+=b);
  const base="http://127.0.0.1:"+port;
  try {
    // Windows CI 冷启动可能超过十秒；只等待同一子进程，不重启或重试任何协议写入。
    let ready=false,lastProbe="未收到健康响应";
    const startupDeadline=Date.now()+30000;
    while(Date.now()<startupDeadline) {
      if(proc.exitCode!==null||proc.signalCode!==null)break;
      try {
        const response=await fetch(base+"/health",{signal:AbortSignal.timeout(500)});
        ready=response.ok;lastProbe="HTTP "+response.status;
      } catch(error) {lastProbe=error.message;}
      if(ready)break;
      await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(ready,true,`隔离服务未就绪；退出码=${proc.exitCode}，信号=${proc.signalCode}，最后探测=${lastProbe}\n${out}`);
    const op=readFileSync(join(TMP,"board_token"),"utf8").trim(), wk=readFileSync(join(TMP,"worker_token"),"utf8").trim();
    async function api(method,path,body,token=op) {
      body=await fixtureVersion(base,token,method,path,body);
      const r=await fetch(base+path,{method,headers:{"Content-Type":"application/json","X-Board-Token":token},
        body:method==="GET"?undefined:JSON.stringify(body||{})});
      return {status:r.status,body:await r.json().catch(()=>null)};
    }
    const meta=await api("GET","/api/meta");assert.equal(meta.body.worker_protocol_version,2);
    const injected=await api("POST","/api/tasks",{subject:"需要人裁定的白名单夹具",summary:"摘要",description:"说明",acceptance:"验收",line:"alpha",
      actor:"forged",maxAttempts:99,humanGate:false,released:0,evidencePath:"forged",lockKey:"forged",treeMode:"hierarchical",weight:"heavy",oneofKey:"forged",provesParent:true,
      parentRunId:randomUUID(),parentWorker:"forged",workerDerived:true,executionProfile:{credential:"forged"},unknown_field:"forged"});
    assert.equal(injected.status,201,JSON.stringify(injected));
    const clean=injected.body.task;assert.equal(clean.max_attempts,3);assert.equal(clean.human_gate,true);assert.equal(clean.released,true);
    assert.equal(clean.summary,"摘要");assert.equal(clean.description,"说明");assert.equal(clean.acceptance,"验收");
    for(const key of ["evidence_path","lock_key","oneof_key"])assert.equal(clean[key],null);
    assert.equal(clean.weight,"standard");assert.equal(clean.tree_mode,"legacy");assert.equal(clean.proves_parent,false);
    const added=(await api("GET","/api/task-events?task_id="+clean.id)).body.events.find(e=>e.kind==="add");
    assert.equal(added.actor,"operator");assert.equal(added.detail.parent_run_id,undefined);assert.equal(added.detail.execution_profile,undefined);
    assert.equal((await api("POST","/api/tasks",{subject:"worker config",execution_profile_id:"forged"},wk)).status,403);
    const goal=await api("POST","/api/tasks",{subject:"合法演示目标",kind:"goal",line:"alpha"});assert.equal(goal.status,201);assert.equal(goal.body.task.kind,"goal");
    const created=await api("POST","/api/tasks",{subject:"HTTP fixture",line:"alpha"});
    assert.equal(created.status,201,JSON.stringify(created));
    const id=created.body.task.id, common={worker:"worker-a",line:"alpha"};
    assert.equal((await api("POST","/api/claim",common,wk)).status,400);
    assert.equal((await api("GET","/api/tasks/"+id)).body.task.status,"not_started");
    const identity={worker_protocol_version:2,agent_instance_id:randomUUID()};
    const claimed=await api("POST","/api/claim",{...common,...identity,runContext:{tools:"unrestricted"}},wk);
    assert.equal(claimed.status,200,JSON.stringify(claimed));
    const a=claimed.body.task, path="/api/tasks/"+id;
    for(const endpoint of ["report","heartbeat","attempt"]) {
      const body={worker:"worker-a",outcome:"done",evidence:"x"};
      assert.equal((await api("POST",path+"/"+endpoint,body,wk)).status,400);
      assert.equal((await api("POST",path+"/"+endpoint,{...body,run_id:randomUUID()},wk)).status,409);
    }
    assert.equal((await api("POST","/api/tasks",{subject:"bad",parentId:id,worker:"worker-a"},wk)).status,400);
    assert.equal((await api("POST","/api/tasks",{subject:"old",parentId:id,parent_run_id:randomUUID(),worker:"worker-a"},wk)).status,409);
    const child=await api("POST","/api/tasks",{subject:"valid child",summary:"派生摘要",parent_id:id,parent_run_id:a.run_id,worker:"worker-a",
      actor:"forged",maxAttempts:99,humanGate:true,released:0,kind:"goal",needsBash:true,verifyCmd:"forged",route:"forged",blockedBy:[clean.id],executionProfile:{credential:"forged"},workerDerived:false,unknown_field:"forged"},wk);
    assert.equal(child.status,201,JSON.stringify(child)); assert.equal(child.body.task.parent_id,id);
    assert.equal(child.body.task.kind,"task");assert.equal(child.body.task.human_gate,false);assert.equal(child.body.task.max_attempts,3);assert.equal(child.body.task.needs_bash,false);
    assert.equal(child.body.task.verify_cmd,null);assert.equal(child.body.task.route,"default");assert.deepEqual(child.body.task.blocked_by,[]);assert.equal(child.body.task.released,true);
    const childAdd=(await api("GET","/api/task-events?task_id="+child.body.task.id)).body.events.find(e=>e.kind==="add");
    assert.equal(childAdd.actor,"worker");assert.equal(childAdd.detail.parent_run_id,a.run_id);
    const candidate=await api("POST","/api/tasks",{subject:"second derived",parentId:id,parent_run_id:a.run_id,worker:"worker-a",released:1},wk);
    assert.equal(candidate.status,201);assert.equal(candidate.body.task.released,false);
    assert.equal((await api("POST","/api/tasks/"+candidate.body.task.id+"/archive",{})).status,200);
    const childPath="/api/tasks/"+child.body.task.id;
    const cc=await api("POST",childPath+"/claim",{worker:"worker-a"});
    assert.equal(cc.status,200,JSON.stringify(cc));
    await api("POST",childPath+"/report",{worker:"worker-a",run_id:cc.body.task.run_id,outcome:"done",evidence:"child completed"});
    assert.equal((await api("POST",childPath+"/resolve",{verdict:"approve"})).status,200);
    const delivered=await api("POST",path+"/report",{worker:"worker-a",run_id:a.run_id,outcome:"done",evidence:"old round"},wk);
    assert.equal(delivered.status,200);
    const rejected=await api("POST",path+"/resolve",{verdict:"reject",note:"new input"});
    assert.equal(rejected.status,200,JSON.stringify(rejected));
    const next=await api("POST",path+"/claim",{worker:"worker-a",force:true});
    assert.equal(next.status,200,JSON.stringify(next));assert.notEqual(next.body.task.run_id,a.run_id);
    for(const endpoint of ["report","heartbeat","attempt"]) {
      assert.equal((await api("POST",path+"/"+endpoint,{worker:"worker-a",run_id:a.run_id,outcome:"done",evidence:"obsolete"},wk)).status,409);
    }
    assert.equal((await api("POST","/api/tasks",{subject:"late child",parentId:id,parent_run_id:a.run_id,worker:"worker-a"},wk)).status,409);
    const history=await api("GET",path+"/runs"); assert.equal(history.body.runs.length,2);
    assert.equal(history.body.runs[0].agent_instance_id,identity.agent_instance_id);
    assert.equal(history.body.runs[0].state,"ended");assert.equal(history.body.runs[1].state,"running");
    assert.equal(history.body.runs[0].policy.context.enforcement,"unattested");
    assert.equal(history.body.runs[0].policy.context.tools,"write");
    const unassigned=await api("POST","/api/tasks",{subject:"unassigned"});
    const picked=await api("POST","/api/claim",{...identity,worker:"alpha-2",line:"alpha"},wk);
    assert.equal(picked.status,200);assert.equal(picked.body.task.id,unassigned.body.task.id);
    const unassignedRuns=await api("GET","/api/tasks/"+picked.body.task.id+"/runs");
    assert.equal(unassignedRuns.body.runs[0].role_id,"alpha");
    assert.equal(unassignedRuns.body.runs[0].worker,"alpha-2");
  } finally {
    if(proc.exitCode===null&&proc.signalCode===null){proc.kill();await new Promise(r=>proc.once("exit",r));}
  }
});


test("HTTP claim identity enforces canonical v4 UUIDs and uses the loaded charter snapshot",()=>{
  const source=readFileSync(join(ROOT,"core/server.mjs"),"utf8"),charter=join(TMP,"claim-charter.md");
  // 领取上下文从原任务授权事件读取续修策略，抽取服务函数时也使用真实隔离任务库。
  const {db,id}=fixture(), task={...store.get(db,id),line:"dev"};
  writeFileSync(charter,"original charter");let reads=0;
  const role={kind:"implement",tools:"write",charter:"claim-charter.md",seat:null};
  const context=vm.createContext({CFG:{lines:[{id:"dev",role}]},ROLES:[],CODE_ROOT:TMP,store,db,resolve,createHash,
    normalizeRole:value=>value??null,readFileSync:path=>{reads++;return readFileSync(path);}});
  vm.runInContext(source.slice(source.indexOf("let LINES, SUPERVISED,"),source.indexOf("try { rebuildLines(); }"))+
    source.slice(source.indexOf("const WORKER_PROTOCOL_VERSION = 2;"),source.indexOf("const server = http.createServer")),context);
  vm.runInContext("rebuildLines()",context);assert.equal(reads,1);
  const good="550e8400-e29b-41d4-a716-446655440000";
  for(const bad of [good.toUpperCase(),good.replace("41d4","11d4"),good.replace("a716","0716"),"bad",null])
    assert.throws(()=>context.claimIdentity({worker_protocol_version:2,agent_instance_id:bad},"worker"),{code:"BAD_INPUT"});
  assert.throws(()=>context.claimIdentity({worker_protocol_version:1,agent_instance_id:good},"worker"),{code:"BAD_INPUT"});
  writeFileSync(charter,"changed on disk");
  const run=context.claimIdentity({worker_protocol_version:2,agent_instance_id:good,line:"dev"},"worker").runContextForTask(task);
  assert.equal(run.charter_sha256,createHash("sha256").update("original charter").digest("hex"));assert.equal(reads,1);
  assert.deepEqual(run.verification_repair,{max_rounds:1,legacy_retry:false});
  vm.runInContext("rebuildLines()",context);assert.equal(reads,2);
  assert.equal(context.claimIdentity({line:"dev"},"operator").runContextForTask(task).charter_sha256,
    createHash("sha256").update("changed on disk").digest("hex"));
  rmSync(charter);
  assert.throws(()=>vm.runInContext("rebuildLines()",context),{code:"ENOENT"});
  const prior=context.claimIdentity({line:"dev"},"operator").runContextForTask(task);
  assert.equal(prior.charter_sha256,createHash("sha256").update("changed on disk").digest("hex"));assert.equal(reads,3);
  assert.equal(context.claimIdentity({line:"plain"},"operator").runContextForTask({...task,line:"plain"}).charter_sha256,null);
});
