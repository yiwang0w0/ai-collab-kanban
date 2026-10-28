// 临时 HTTP 看板与受管 Python 替身；不启动 SDK、供应商 CLI 或真实模型。
import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer as httpServer} from "node:http";
import {createServer as netServer} from "node:net";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {join,dirname,resolve,relative,isAbsolute} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath,pathToFileURL} from "node:url";
import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {createRequire} from "node:module";
import {DatabaseSync} from "node:sqlite";
import {loadExecutionProfiles,getExecutionProfile,executionProfileSnapshot} from "../core/execution-profiles.mjs";
import {directoryIdentity} from "../core/artifacts/git-workspace.mjs";
import {fixtureVersion} from "./http-version-fixture.mjs";

const ROOT=fileURLToPath(new URL("../",import.meta.url)),TMP=mkdtempSync(join(tmpdir(),"kanban-four-http-")),CONTROL=join(TMP,"宿主控制.json");
let REPO=join(TMP,"工作仓");
const PY=process.env.BOARD_PYTHON||process.env.PYTHON||"python",require=createRequire(import.meta.url),store=require("../core/store.js");
const budget={timeout_sec:120,max_turns:4,max_cost_usd:0.5};
const cases=[
 {line:"claudecli",runtime:"claude",model:"claude-haiku-4-5",effort:"high",profile:"claude-cli"},
 {line:"codexcli",runtime:"codex",model:"gpt-5.3-codex-spark",effort:"xhigh",profile:"codex-cli"},
 {line:"claudeapi",runtime:"claude",model:"claude-haiku-4-5",effort:"high",profile:"claude-api"},
 {line:"gptapi",runtime:"codex",model:"gpt-5.3-codex-spark",effort:"xhigh",profile:"gpt-api"},
];
const seats=new Map(),spawnCounts=new Map(),customCredential=new Map();let child,callback,base,operator,shared,output="";
async function api(token,method,path,body){
 body=await fixtureVersion(base,token,method,path,body);
 const response=await fetch(base+path,{method,headers:{"Content-Type":"application/json",...(token?{"X-Board-Token":token}:{})},...(method==="GET"?{}:{body:JSON.stringify(body??{})}),signal:AbortSignal.timeout(5000)});
 return {status:response.status,body:await response.json().catch(()=>({}))};
}
const state=()=>api(operator,"GET","/api/workers");
const task=id=>api(operator,"GET",`/api/tasks/${id}`);
const claim=(row,token=seats.get(row.line),agentInstanceId=randomUUID())=>api(token,"POST","/api/claim",{worker:row.line,line:row.line,runtime:row.runtime,worker_protocol_version:2,agent_instance_id:agentInstanceId});
const create=async row=>{
 const result=await api(operator,"POST","/api/tasks",{subject:"四通道 HTTP 合成任务",line:row.line,execution_profile_id:row.profile,model:row.model,effort:row.effort,released:1,maxAttempts:99});
 assert.equal(result.status,201,JSON.stringify(result.body));return result.body.task;
};

before(async()=>{
 mkdirSync(REPO);
 REPO=directoryIdentity(REPO).root;
 writeFileSync(CONTROL,"{}");
 callback=httpServer((request,response)=>{let raw="";request.on("data",chunk=>raw+=chunk);request.on("end",()=>{const value=JSON.parse(raw);seats.set(value.worker,value.token);customCredential.set(value.worker,value.custom_credential);spawnCounts.set(value.worker,(spawnCounts.get(value.worker)||0)+1);response.end("ok");});});
 await new Promise(r=>callback.listen(0,"127.0.0.1",r));
 const stub=join(TMP,"受管替身.py");
 writeFileSync(stub,["import os,sys,json,urllib.request,time,pathlib","args=sys.argv","name=args[args.index('--worker')+1] if '--worker' in args else args[args.index('--as')+1]","data=json.dumps({'worker':name,'token':os.environ.get('WORKER_BOARD_TOKEN',''),'custom_credential':'GPT_PROJECT_KEY' in os.environ}).encode()","urllib.request.urlopen(urllib.request.Request(os.environ['BOARD_FOUR_HTTP_CALLBACK'],data=data),timeout=10).read()","until=time.monotonic()+90","while time.monotonic()<until:","    try:","        control=json.loads(pathlib.Path(os.environ['BOARD_FOUR_HTTP_CONTROL']).read_text(encoding='utf-8'))","    except (OSError,ValueError):","        control={}","    if name in control:","        sys.exit(control[name])","    time.sleep(0.05)",""].join("\n"));
 const original=join(ROOT,"core/server.mjs"),source=readFileSync(original,"utf8"),anchor='[loopScriptOf(line), "--as", line,';
 assert.equal(source.split(anchor).length,2,"精确替换唯一宿主入口后才允许运行夹具");
 const fixture=join(TMP,"server.mjs");
 writeFileSync(fixture,source.replace(anchor,`[${JSON.stringify(stub)}, "--as", line,`).replaceAll("import.meta.url",JSON.stringify(pathToFileURL(original).href)).replace(/from\s+(['"])\.\/([^'"]+)\1/g,(_,q,path)=>"from "+JSON.stringify(pathToFileURL(join(dirname(original),path)).href)));
 const listener=netServer();await new Promise(r=>listener.listen(0,"127.0.0.1",r));const port=listener.address().port;await new Promise(r=>listener.close(r));base=`http://127.0.0.1:${port}`;
 const config=join(TMP,"fleet.json");
 writeFileSync(config,JSON.stringify({lines:cases.map(row=>({id:row.line})),roles:[],routes:["default"],repo:REPO,max_parallel:1,
  execution_profiles:[{id:"claude-cli",budget},{id:"codex-cli",budget},{id:"claude-api",enabled:true,budget},{id:"gpt-api",enabled:true,budget,provider_spend_limit_confirmed:true,credential_env:"GPT_PROJECT_KEY"}]}));
 // 保留锁定时已有的 CLI 选择；设置接口仍须拒绝未经许可的新订阅配置。
 writeFileSync(join(TMP,"worker_settings.json"),JSON.stringify(Object.fromEntries(cases.map(row=>[row.line,{rev:0,desired_running:false,agents:[{runtime:row.runtime,model:row.model,effort:row.effort,window:false,execution_profile_id:row.profile}]}]))));
 const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(BOARD_|WORKER_|REVIEWER_|REORG_)/.test(key)));
 child=spawn(process.execPath,[fixture],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...environment,
  BOARD_CONFIG:config,BOARD_DATA_DIR:TMP,BOARD_DB:join(TMP,"board.db"),BOARD_REPO:REPO,BOARD_PORT:String(port),BOARD_PYTHON:PY,
  BOARD_ALLOW_UNPINNED:"1",BOARD_NO_RESTORE:"1",BOARD_POOL_TEST_MODE:"1",BOARD_POOL_TEST_PROBE:"ok",BOARD_CODEX_RELEASED:"0",BOARD_CODEX_CMD:process.execPath,
  WORKER_CLAUDE_CLI:process.execPath,KANBAN_ANTHROPIC_API_KEY:"fixture-anthropic-only",KANBAN_OPENAI_API_KEY:"fixture-openai-only",GPT_PROJECT_KEY:"fixture-openai-custom",
  BOARD_FOUR_HTTP_CALLBACK:`http://127.0.0.1:${callback.address().port}/`,BOARD_FOUR_HTTP_CONTROL:CONTROL,BOARD_CRASH_BACKOFF_MS:"100",PYTHONUTF8:"1",PYTHONDONTWRITEBYTECODE:"1"}});
 child.stdout.on("data",chunk=>output=(output+chunk).slice(-50000));child.stderr.on("data",chunk=>output=(output+chunk).slice(-50000));
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+"/health",{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}if(child.exitCode!==null)break;await delay(100);}assert.ok(ready,output);
 operator=readFileSync(join(TMP,"board_token"),"utf8").trim();shared=readFileSync(join(TMP,"worker_token"),"utf8").trim();
 for(const row of cases.filter(row=>row.line!=="codexcli")){
  const result=await api(operator,"POST",`/api/workers/${row.line}/start`,{});assert.equal(result.status,200,JSON.stringify(result.body));
 }
 for(let i=0;i<100&&seats.size<3;i++)await delay(50);assert.equal(seats.size,3,"只有三条获准线启动了无模型替身");
});
after(async()=>{
 if(child?.exitCode===null){for(const row of cases)await api(operator,"POST",`/api/workers/${row.line}/stop`,{}).catch(()=>{});const done=new Promise(r=>child.once("exit",r));child.kill();await done;}
 if(callback)await new Promise(r=>callback.close(r));
 for(const secret of [...seats.values(),"fixture-anthropic-only","fixture-openai-only","fixture-openai-custom"])assert.equal(output.includes(secret),false,"凭据不得出现在宿主日志");
 const inside=relative(resolve(tmpdir()),resolve(TMP));assert.ok(inside&&!inside.startsWith("..")&&!isAbsolute(inside));rmSync(TMP,{recursive:true,force:true});
});

test("四配置公开事实与建卡预览保持私密边界，API 不借用订阅解禁",async()=>{
 const current=(await state()).body;assert.equal(current.execution_profiles.length,4);assert.equal(current.workspace.path,REPO);
 assert.equal(current.runtimes.find(row=>row.id==="codex").disabled,true);
 const gpt=current.execution_profiles.find(row=>row.id==="gpt-api");assert.equal(gpt.ready,true);assert.equal(gpt.provider_spend_limit_confirmed,true);
 const apiRow=cases.find(row=>row.line==="gptapi"),worker=current.workers.find(row=>row.line===apiRow.line);
 const saved=await api(operator,"POST",`/api/workers/${apiRow.line}/settings`,{agents:worker.settings.agents,rev:worker.settings.rev});assert.equal(saved.status,200,JSON.stringify(saved.body));
 const locked=current.workers.find(row=>row.line==="codexcli"),legacy={runtime:"codex",model:locked.settings.agents[0].model,effort:"xhigh",window:false};
 assert.equal((await api(operator,"POST","/api/workers/codexcli/settings",{agents:[legacy],rev:locked.settings.rev})).status,400,"未解禁的旧订阅保存仍拒绝");
 const created=await create(cases.find(row=>row.line==="claudeapi"));assert.equal(created.released,false);assert.equal(created.max_attempts,1);assert.equal(created.execution_profile.workspace.path,REPO);assert.equal(created.execution_profile.channel,"claude_agent_sdk");
 const wire=JSON.stringify([current.execution_profiles,created.execution_profile]);
 for(const hidden of ["auth_home","credential_env","KANBAN_ANTHROPIC_API_KEY","KANBAN_OPENAI_API_KEY","fixture-anthropic-only","fixture-openai-only","GPT_PROJECT_KEY","fixture-openai-custom",join(TMP,"auth")])assert.equal(wire.includes(hidden),false,hidden);
});

test("自定义名称的 API 凭据不进入 CLI 或另一 API 执行线的宿主环境",()=>{
 for(const line of ["claudecli","claudeapi","gptapi"])assert.equal(customCredential.get(line),false,line+" 宿主不应看到自定义凭据变量");
});

test("本人确认摘要后才放行，受管绑定领取并把 SDK 观察和报告回到原卡",async()=>{
 const row=cases.find(row=>row.line==="gptapi"),created=await create(row),path=`/api/tasks/${created.id}`,token=seats.get(row.line);
 const wrong=await api(operator,"POST",path+"/release",{released:true,expected_version:created.aggregate_version,confirm_execution_profile_digest:"f".repeat(64)});assert.equal(wrong.status,409);
 assert.equal((await task(created.id)).body.task.released,false);
 const released=await api(operator,"POST",path+"/release",{released:true,expected_version:created.aggregate_version,confirm_execution_profile_digest:created.execution_profile.profile_digest});assert.equal(released.status,200,JSON.stringify(released.body));
 const fixed=(await task(created.id)).body.task.execution_profile;assert.deepEqual(fixed.workspace,created.execution_profile.workspace);assert.equal(fixed.tools,"write");assert.equal(fixed.profile_digest,created.execution_profile.profile_digest);
 assert.equal(fixed.workspace.path,REPO);assert.match(fixed.workspace.device,/^\d+$/);assert.match(fixed.workspace.inode,/^[1-9]\d*$/);
 const other=cases.find(row=>row.line==="claudeapi");assert.equal((await api(seats.get(other.line),"POST","/api/claim",{worker:other.line,line:row.line,runtime:other.runtime,worker_protocol_version:2,agent_instance_id:randomUUID()})).status,409);
 const unbound=await api(shared,"POST","/api/claim",{worker:"manual",line:row.line,runtime:row.runtime,worker_protocol_version:2,agent_instance_id:randomUUID()});assert.equal(unbound.status,204,"共享旧凭据不能领取绑定 API 卡");
 const instance=randomUUID(),picked=await claim(row,token,instance);assert.equal(picked.status,200,JSON.stringify(picked.body));assert.equal(picked.body.task.id,created.id);
 assert.deepEqual(picked.body.task.execution_profile.workspace,fixed.workspace);assert.equal(picked.body.task.execution_profile.tools,fixed.tools);
 const runProfile=(await api(operator,"GET",path+"/runs")).body.runs.find(run=>run.run_id===picked.body.task.run_id).policy.context.execution_profile;
 assert.deepEqual(runProfile.workspace,fixed.workspace);assert.equal(runProfile.tools,fixed.tools);assert.equal(runProfile.profile_digest,fixed.profile_digest);
 const running=picked.body.task,profile=created.execution_profile;
 const started=await api(token,"POST",path+"/process-started",{worker:row.line,run_id:running.run_id,agent_instance_id:instance,runtime:row.runtime,attempt:running.attempts,pid:12345,model:row.model,effort:row.effort});assert.equal(started.status,200,JSON.stringify(started.body));
 const activity={worker:row.line,run_id:running.run_id,agent_instance_id:instance,execution_profile_id:row.profile,profile_digest:profile.profile_digest,event_id:randomUUID(),kind:"activity",model:row.model,effort:row.effort,request_id:"fixture-request",session_id:"fixture-session"};
 assert.equal((await api(operator,"POST",path+"/execution-event",activity)).status,403);
 assert.equal((await api(token,"POST",path+"/execution-event",activity)).status,200);assert.equal((await api(token,"POST",path+"/execution-event",activity)).status,200);
 const terminal={...activity,event_id:randomUUID(),kind:"terminal",status:"success",usage:null,cost_usd:null};
 assert.equal((await api(token,"POST",path+"/execution-event",terminal)).status,200);assert.equal((await api(token,"POST",path+"/execution-event",{...terminal,status:"failed"})).status,409);
 const report={worker:row.line,run_id:running.run_id,outcome:"done",evidence:"仅合成结果，没有调用模型"};
 const returned=await api(token,"POST",path+"/report",report);assert.equal(returned.status,200,JSON.stringify(returned.body));assert.equal((await api(token,"POST",path+"/report",report)).status,200);
 assert.equal((await api(token,"POST",path+"/report",{...report,run_id:randomUUID()})).status,409);
 assert.equal((await api(token,"POST",path+"/execution-event",{...terminal,event_id:randomUUID(),run_id:randomUUID()})).status,409);
 const after=(await task(created.id)).body.task;assert.equal(after.status,"waiting");assert.equal(after.waiting_for,"review");assert.equal(after.execution_profile.channel,"codex_sdk_api");
 assert.deepEqual(after.execution_profile.workspace,fixed.workspace);assert.equal(after.execution_profile.tools,fixed.tools);assert.equal(after.execution_profile.profile_digest,fixed.profile_digest);
 const history=(await api(operator,"GET",`/api/task-events?task_id=${created.id}`)).body.events;
 assert.equal(history.filter(event=>event.kind==="execution.activity").length,1);assert.equal(history.filter(event=>event.kind==="execution.terminal").length,1);assert.equal(history.filter(event=>event.kind==="report").length,1);
 assert.equal(history.find(event=>event.kind==="execution.terminal").detail.cost_usd,null);
 const configured=history.find(event=>event.kind==="execution.configured").detail.execution_profile;assert.deepEqual(configured.workspace,fixed.workspace);assert.equal(configured.tools,fixed.tools);
});

test("未放行卡可保留待定预算，放行前固定更新后的配置摘要而不改建卡历史",()=>{
 const db=new DatabaseSync(":memory:");
 try{
  store.migrate(db);const oldProfiles=loadExecutionProfiles([{id:"claude-api",enabled:true}],{dataDir:join(TMP,"source-data")}),newProfiles=loadExecutionProfiles([{id:"claude-api",enabled:true,budget}],{dataDir:join(TMP,"source-data")});
  const workspace={label:"当前项目",path:REPO,device:"7",inode:"11"},tools="write";
  const old={...executionProfileSnapshot(getExecutionProfile(oldProfiles,"claude-api")),model:"claude-haiku-4-5",effort:"high",workspace,tools},next={...executionProfileSnapshot(getExecutionProfile(newProfiles,"claude-api")),model:old.model,effort:old.effort,workspace,tools};
  const id=store.add(db,{subject:"待定预算快照夹具",line:"claudeapi",released:0,executionProfile:old}),before=store.get(db,id);
  assert.equal(store.taskExecutionProfile(db,id).budget,null);assert.notEqual(old.profile_digest,next.profile_digest);
  store.setReleased(db,{id,released:true,expectedVersion:before.aggregate_version,executionProfile:next});
  assert.deepEqual(store.taskExecutionProfile(db,id),next);assert.equal(store.matchesExecutionProfile(db,store.get(db,id),old),false);
  assert.equal(store.matchesExecutionProfile(db,store.get(db,id),{...next,tools:"read-only"}),false);
  assert.equal(store.matchesExecutionProfile(db,store.get(db,id),{...next,workspace:{...workspace,inode:"12"}}),false);
  assert.equal(store.events(db,{taskId:id}).find(event=>event.kind==="add").detail.execution_profile.budget,null);
  assert.equal(store.events(db,{taskId:id}).filter(event=>event.kind==="execution.configured").length,1);
  const configured=store.events(db,{taskId:id}).find(event=>event.kind==="execution.configured").detail.execution_profile;assert.deepEqual(configured.workspace,workspace);assert.equal(configured.tools,tools);
 }finally{db.close();}
});

test("独立执行配置宿主异常退出后停线且不自动重启，在途结果保持未知并撤回放行",async()=>{
 const row=cases.find(row=>row.line==="claudecli"),created=await create(row),path=`/api/tasks/${created.id}`,token=seats.get(row.line),instance=randomUUID();
 const released=await api(operator,"POST",path+"/release",{released:true,expected_version:created.aggregate_version,confirm_execution_profile_digest:created.execution_profile.profile_digest});assert.equal(released.status,200,JSON.stringify(released.body));
 const picked=await claim(row,token,instance);assert.equal(picked.status,200,JSON.stringify(picked.body));assert.equal(picked.body.task.id,created.id);
 const running=picked.body.task,started=await api(token,"POST",path+"/process-started",{worker:row.line,run_id:running.run_id,agent_instance_id:instance,runtime:row.runtime,attempt:running.attempts,pid:23456,model:row.model,effort:row.effort});assert.equal(started.status,200,JSON.stringify(started.body));
 const count=spawnCounts.get(row.line);assert.equal(count,1);writeFileSync(CONTROL,JSON.stringify({[row.line]:17}));
 let stopped;for(let i=0;i<100;i++){stopped=(await state()).body.workers.find(worker=>worker.line===row.line);if(!stopped.running&&!stopped.desired_running)break;await delay(50);}
 assert.equal(stopped.running,false);assert.equal(stopped.desired_running,false);assert.equal(stopped.exit_code,17);
 // 等待超过短退避多轮，防止仅在第一次状态读取时尚未重启而误判。
 await delay(600);assert.equal(spawnCounts.get(row.line),count,"显式配置失败后不能产生第二个收费宿主");
 const persisted=JSON.parse(readFileSync(join(TMP,"worker_settings.json"),"utf8"));assert.equal(persisted[row.line].desired_running,false);
 const returned=(await task(created.id)).body.task;assert.equal(returned.status,"not_started");assert.equal(returned.released,false);assert.equal(returned.execution_trace.work_state,"unverified");assert.equal(returned.execution_trace.model_activity_at??null,null);
 const events=(await api(operator,"GET",`/api/task-events?task_id=${created.id}`)).body.events,recovered=events.find(event=>event.kind==="release"&&event.detail.action==="release_held");
 assert.equal(recovered.detail.run_id,running.run_id);assert.equal(recovered.detail.recovery_required,true);assert.equal(recovered.detail.result_state,"unknown");assert.equal(events.some(event=>event.kind==="report"),false);
 const run=(await api(operator,"GET",path+"/runs")).body.runs.find(value=>value.run_id===running.run_id);assert.equal(run.state,"ended");assert.deepEqual(run.policy.context.execution_profile.workspace,created.execution_profile.workspace);assert.equal(run.policy.context.execution_profile.tools,"write");
});
