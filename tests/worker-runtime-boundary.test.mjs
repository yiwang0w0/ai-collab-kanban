import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// Actual HTTP and supervised-child credentials; no model/provider calls.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer as httpServer} from 'node:http';
import {createServer as netServer} from 'node:net';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fixtureVersion} from './http-version-fixture.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url)),TMP=mkdtempSync(join(tmpdir(),'fleet-runtime-auth-'));
const PY=HOST_ENV.PYTHON||'python';
let server,callback,base,operator,shared,output='';const seats=new Map();
async function api(token,method,path,body){
 body=await fixtureVersion(base,token,method,path,body);
 const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Board-Token':token},...(method==='GET'?{}:{body:JSON.stringify(body??{})})});
 return {status:r.status,body:await r.json().catch(()=>({}))};
}
const claim=(token,worker,runtime)=>api(token,'POST','/api/claim',{worker,runtime,worker_protocol_version:2,agent_instance_id:randomUUID()});
async function card(line){const r=await api(operator,'POST','/api/tasks',{subject:'Synthetic runtime boundary',...(line?{line}:{}),released:1});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.task;}
function evidence(task){
 const p=spawnSync(PY,['-c',"import sys,json;sys.path.insert(0,sys.argv[1]);import reviewer_loop as r;print(json.dumps(r.machine_evidence(json.loads(sys.argv[2]))))",join(ROOT,'loops'),JSON.stringify({...task,result:'PASS rc=0'})],{windowsHide:true,encoding:'utf8',timeout:15000,env:{...HOST_ENV,BOARD_DATA_DIR:TMP,BOARD_CONFIG:join(TMP,'fleet.json'),PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout.trim());
}
before(async()=>{
 callback=httpServer((req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{const b=JSON.parse(raw);seats.set(b.worker,b.token);res.end('ok');});});
 await new Promise(r=>callback.listen(0,'127.0.0.1',r));
 const stub=join(TMP,'seat.py');writeFileSync(stub,"import os,sys,json,urllib.request,time\nargs=sys.argv\nname=args[args.index('--worker')+1] if '--worker' in args else args[args.index('--as')+1]\ndata=json.dumps({'worker':name,'token':os.environ.get('WORKER_BOARD_TOKEN','')}).encode()\nurllib.request.urlopen(urllib.request.Request(os.environ['BOARD_RUNTIME_TEST_CALLBACK'],data=data),timeout=10).read()\ntime.sleep(90)\n");
 const original=join(ROOT,'core/server.mjs'),src=readFileSync(original,'utf8'),anchor='[loopScriptOf(line), "--as", line,';
 assert.equal(src.split(anchor).length,2);
 const fixture=join(TMP,'server.mjs');writeFileSync(fixture,src.replace(anchor,`[${JSON.stringify(stub)}, "--as", line,`).replaceAll('import.meta.url',JSON.stringify(pathToFileURL(original).href)).replace(/from\s+(['"])\.\/([^'"]+)\1/g,(_,q,p)=>'from '+JSON.stringify(pathToFileURL(join(dirname(original),p)).href)));
 const probe=netServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;
 const config=join(TMP,'fleet.json');writeFileSync(config,JSON.stringify({lines:[{id:'alpha'},{id:'beta'}],roles:[],routes:['default']}));
 const clean=HOST_ENV;
 server=spawn(process.execPath,[fixture],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...clean,BOARD_CONFIG:config,BOARD_DATA_DIR:TMP,BOARD_DB:join(TMP,'board.db'),BOARD_PORT:String(port),BOARD_PYTHON:PY,BOARD_ALLOW_UNPINNED:'1',BOARD_NO_RESTORE:'1',BOARD_POOL_TEST_MODE:'1',BOARD_POOL_TEST_PROBE:'ok',BOARD_CODEX_RELEASED:'1',BOARD_CODEX_CMD:process.execPath,WORKER_CLAUDE_CLI:process.execPath,BOARD_UNTIL:'2099-01-01T12:00',BOARD_RUNTIME_TEST_CALLBACK:`http://127.0.0.1:${callback.address().port}/`,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
 server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Fixture stopped before ready');try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,'Fixture ready');
 operator=readFileSync(join(TMP,'board_token'),'utf8').trim();shared=readFileSync(join(TMP,'worker_token'),'utf8').trim();
 for(const [line,runtime,model] of [['alpha','claude','claude-opus-5'],['beta','codex','gpt-5.3-codex-spark']]){
  const ws=(await api(operator,'GET','/api/workers')).body.workers.find(w=>w.line===line);
  const saved=await api(operator,'POST',`/api/workers/${line}/settings`,{agents:[{runtime,model,effort:runtime==='codex'?'xhigh':'high',window:false}],rev:ws.settings.rev});assert.equal(saved.status,200,JSON.stringify(saved.body));
  const started=await api(operator,'POST',`/api/workers/${line}/start`,{});assert.equal(started.status,200,JSON.stringify(started.body));
 }
 for(let i=0;i<100&&seats.size<2;i++)await delay(50);assert.equal(seats.size,2,'Both fixture children started');
});
after(async()=>{
 if(server?.exitCode===null){for(const line of ['alpha','beta'])await api(operator,'POST',`/api/workers/${line}/stop`,{}).catch(()=>{});const done=new Promise(r=>server.once('exit',r));server.kill();await done;}
 if(callback)await new Promise(r=>callback.close(r));
 for(const token of seats.values())if(token)assert.ok(!output.includes(token),'Credential must not appear in server logs');
 rmSync(TMP,{recursive:true,force:true});
});
test('P4 same shared worker token cannot rename itself into trusted Codex machine evidence',async()=>{
 const t=await card();const r=await claim(shared,'audit-hand-runner','codex');assert.equal(r.status,200);
 assert.equal(r.body.task.id,t.id);assert.equal(evidence(r.body.task).ok,false,'Invented PASS must not become machine evidence');assert.equal(r.body.task.last_runtime,null,'Unbound runtime cannot be trusted');
});
test('P4 supervised credentials bind the worker name and preserve both seat runtime stamps',async()=>{
 assert.ok(seats.get('alpha')&&seats.get('beta'),'Server hands each child a credential');assert.notEqual(seats.get('alpha'),shared);assert.notEqual(seats.get('alpha'),seats.get('beta'));
 for(const name of ['audit-hand-runner','beta']){const r=await claim(seats.get('alpha'),name,'codex');assert.equal(r.status,409,'Bound Claude token cannot rename into another identity');}
 for(const [worker,lie,want] of [['alpha','codex','claude'],['beta','claude','codex']]){
  const t=await card(worker);const r=await claim(seats.get(worker),worker,lie);assert.equal(r.status,200);assert.equal(r.body.task.id,t.id);assert.equal(r.body.task.last_runtime,want);assert.equal(evidence(r.body.task).ok,want==='codex');
  if(worker==='beta'){const forged=await api(seats.get('alpha'),'POST',`/api/tasks/${t.id}/report`,{worker:'beta',run_id:r.body.task.run_id,outcome:'done',evidence:'PASS rc=0'});assert.equal(forged.status,409,'Claude credential cannot report as Codex');}
  const report=await api(seats.get(worker),'POST',`/api/tasks/${t.id}/report`,{worker,run_id:r.body.task.run_id,outcome:'done',evidence:'Synthetic receipt'});assert.equal(report.status,200);
 }
 const impersonation=await claim(shared,'beta','codex');assert.equal(impersonation.status,409,'Shared token cannot borrow a registered seat');
});
test('P4 unbound claims clear a previous trusted runtime stamp on a new run',async()=>{
 const t=await card();const initial=await api(operator,'POST',`/api/tasks/${t.id}/claim`,{worker:'audit-hand-runner',runtime:'codex'});assert.equal(initial.status,200);
 const report=await api(shared,'POST',`/api/tasks/${t.id}/report`,{worker:'audit-hand-runner',run_id:initial.body.task.run_id,outcome:'done',evidence:'Synthetic old delivery'});assert.equal(report.status,200);
 const retry=await api(operator,'POST',`/api/tasks/${t.id}/resolve`,{verdict:'reject',resolved_by:'human',note:'Test next execution'});assert.equal(retry.status,200,JSON.stringify(retry.body));
 const r=await claim(shared,'audit-hand-runner','codex');assert.equal(r.status,200);assert.equal(r.body.task.id,t.id);assert.equal(r.body.task.last_runtime,null);assert.equal(evidence(r.body.task).ok,false);
});
test('设置只在显式读取时检查接入，探测和旧交付不冒充真实任务回传',async()=>{
 const ordinary=await api(operator,'GET','/api/workers');
 assert.ok(ordinary.body.runtimes.every(r=>!Object.hasOwn(r,'readiness')));
 const inspected=await api(operator,'GET','/api/workers?readiness=1');assert.equal(inspected.status,200);
 for(const runtime of inspected.body.runtimes){
  assert.equal(runtime.readiness.enabled,true);assert.equal(runtime.readiness.command_configured,true);
  assert.equal(runtime.readiness.installation,'available','夹具只证明命令文件存在，不证明它是可用模型');
 }
 assert.ok(inspected.body.workers.every(w=>w.runtime_verifications.length===0),'旧 report.done 没有宿主启动记录，仍待核实');
 assert.equal(JSON.stringify(inspected.body).includes(TMP),false,'不返回私有命令路径');
});
test('受管启动记录绑定当前身份和尝试，只展示进程，不推进任务或冒充模型响应',async()=>{
 const t=await card('alpha'),token=seats.get('alpha');
 const claimed=await claim(token,'alpha','claude');assert.equal(claimed.body.task.id,t.id);
 const task=claimed.body.task,runs=await api(operator,'GET',`/api/tasks/${t.id}/runs`),run=runs.body.runs.find(r=>r.run_id===task.run_id);
 const body={worker:'alpha',run_id:task.run_id,agent_instance_id:run.agent_instance_id,runtime:'claude',attempt:task.attempts,pid:12345,model:'claude-opus-5',effort:'high'},path=`/api/tasks/${t.id}/process-started`;
 for(const [unauthorized,status] of [[operator,403],[shared,409],[readFileSync(join(TMP,'review_token'),'utf8').trim(),403]])
  assert.equal((await api(unauthorized,'POST',path,body)).status,status,'共享凭据借用受管名称仍按既有身份保护返回409');
 assert.equal((await api(seats.get('beta'),'POST',path,body)).status,409);
 for(const change of [{run_id:randomUUID()},{agent_instance_id:randomUUID()},{attempt:task.attempts+1},{runtime:'codex'}])
  assert.equal((await api(token,'POST',path,{...body,...change})).status,409,JSON.stringify(change));
 for(const change of [{pid:0},{pid:'12345'},{model:'未声明模型'},{effort:'未声明强度'}])
  assert.equal((await api(token,'POST',path,{...body,...change})).status,400,JSON.stringify(change));
 const before=(await api(operator,'GET',`/api/tasks/${t.id}`)).body.task;
 const saved=await api(token,'POST',path,body);assert.equal(saved.status,200,JSON.stringify(saved.body));
 assert.equal((await api(token,'POST',path,body)).status,200,'同一宿主观察重送不新增记录');
 const after=(await api(operator,'GET',`/api/tasks/${t.id}`)).body.task;
 assert.equal(after.status,before.status);assert.equal(after.attempts,before.attempts);assert.equal(after.lease_until,before.lease_until);assert.equal(after.aggregate_version,before.aggregate_version);
 assert.equal(after.execution_trace.process_state,'observed');assert.equal(after.execution_trace.process_started_at,saved.body.recorded_at);
 assert.equal(after.execution_trace.work_state,'unverified');assert.equal(after.execution_trace.last_activity_at,null);
 const history=(await api(operator,'GET',`/api/task-events?task_id=${t.id}`)).body.events;
 assert.equal(history.filter(e=>e.kind==='process_started').length,1);
 assert.equal((await api(operator,'GET','/api/workers?readiness=1')).body.workers.find(w=>w.line==='alpha').runtime_verifications.length,0,'仅启动仍不能算结果回传');
 assert.equal((await api(token,'POST',`/api/tasks/${t.id}/report`,{worker:'alpha',run_id:task.run_id,outcome:'done',evidence:'合成回传，不调用模型'})).status,200);
 const verification=(await api(operator,'GET','/api/workers?readiness=1')).body.workers.find(w=>w.line==='alpha').runtime_verifications;
 assert.deepEqual(verification,[{runtime:'claude',model:body.model,effort:body.effort,state:'result_returned',task_id:t.id,observed_at:saved.body.recorded_at,source:'worker_loop'}]);
 assert.equal((await api(token,'POST',path,{...body,pid:12346})).status,409,'交付后的旧进程记录拒绝落盘');
});
test('最终尝试没有启动记录时，失败的早期档位不成为成功回传记录',async()=>{
 const t=await card('beta'),token=seats.get('beta'),claimed=await claim(token,'beta','codex'),task=claimed.body.task;
 const runs=(await api(operator,'GET',`/api/tasks/${t.id}/runs`)).body.runs,run=runs.find(r=>r.run_id===task.run_id);
 const body={worker:'beta',run_id:task.run_id,agent_instance_id:run.agent_instance_id,runtime:'codex',attempt:task.attempts,pid:23456,model:'gpt-5.3-codex-spark',effort:'xhigh'};
 assert.equal((await api(token,'POST',`/api/tasks/${t.id}/process-started`,body)).status,200);
 assert.equal((await api(token,'POST',`/api/tasks/${t.id}/attempt`,{worker:'beta',run_id:task.run_id})).status,200);
 assert.equal((await api(token,'POST',`/api/tasks/${t.id}/report`,{worker:'beta',run_id:task.run_id,outcome:'done',evidence:'最终尝试的合成结果'})).status,200);
 assert.equal((await api(operator,'GET','/api/workers?readiness=1')).body.workers.find(w=>w.line==='beta').runtime_verifications.length,0);
});
test('P4 stopping a seat revokes its credential',async()=>{
 const token=seats.get('alpha');assert.ok(token);const r=await api(operator,'POST','/api/workers/alpha/stop',{});assert.equal(r.status,200);
 assert.equal((await claim(token,'alpha','codex')).status,401);
});
test('P4 loop uses a supervised credential without passing it to provider subprocesses',()=>{
 const r=spawnSync(PY,['-c',"import os,sys;sys.path.insert(0,sys.argv[1]);import worker_loop as w;assert w._board_token()=='synthetic-supervised-token';assert 'WORKER_BOARD_TOKEN' not in os.environ",join(ROOT,'loops')],{windowsHide:true,encoding:'utf8',timeout:15000,env:{...HOST_ENV,BOARD_DATA_DIR:TMP,BOARD_CONFIG:join(TMP,'fleet.json'),WORKER_BOARD_TOKEN:'synthetic-supervised-token',PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(r.status,0,r.stderr);
});
