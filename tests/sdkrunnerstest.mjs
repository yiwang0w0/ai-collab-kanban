import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createWorkspaceTools,createWorkspaceMcp,canonicalWorkspacePath} from '../runners/workspace_tools.mjs';
import {runJob,sdkOptions,loadJob,validateJob} from '../runners/codex_agent.mjs';
import {directoryIdentity} from '../core/artifacts/git-workspace.mjs';
import {loadExecutionProfiles,getExecutionProfile,profileEnvironment} from '../core/execution-profiles.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),directories=[];
const py=HOST_ENV.PYTHON||'python';
after(()=>{for(const dir of directories){const rel=relative(realpathSync.native(tmpdir()),realpathSync.native(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true});}});
function fixture(){
 const directory=realpathSync.native(mkdtempSync(join(tmpdir(),'kanban-sdk-')));directories.push(directory);
 const cwd=join(directory,'工作 项目'),privateDir=join(directory,'本次 运行');mkdirSync(cwd);mkdirSync(privateDir);
 const prompt=join(privateDir,'首句.txt'),jobPath=join(privateDir,'job.json');writeFileSync(prompt,'只处理本次样本，回报实际修改。');
 const job={format:'kanban-agent-job/v1',task_id:7,run_id:randomUUID(),agent_instance_id:randomUUID(),execution_profile_id:'gpt-api',profile_digest:'1'.repeat(64),
  channel:'codex_sdk_api',runtime:'codex',cwd,node_path:process.execPath,prompt_file:prompt,model:'gpt-fixture',effort:'high',read_only:false,tools:'write',
  workspace:{path:directoryIdentity(cwd).root,device:directoryIdentity(cwd).device,inode:directoryIdentity(cwd).inode},protected_paths:[privateDir],budget:{timeout_sec:5,max_turns:4,max_cost_usd:0.5}};
 writeFileSync(jobPath,JSON.stringify(job));return {directory,cwd,privateDir,jobPath,job:{...job,prompt:'夹具任务',jobPath}};
}
function python(script,args,f){
 const environment=Object.fromEntries(Object.entries(HOST_ENV).filter(([key])=>!/^(?:BOARD_|WORKER_|REVIEWER_|REORG_|ANTHROPIC_|OPENAI_|CODEX_)/.test(key)));
 const result=spawnSync(py,['-I','-B','-X','utf8','-c',script,root,...args],{cwd:root,windowsHide:true,encoding:'utf8',timeout:20000,env:{...environment,BOARD_CONFIG:join(f.privateDir,'missing-config.json'),BOARD_VERIFY_REGISTRY:join(f.privateDir,'verify_registry.json'),BOARD_DATA_DIR:f.privateDir,BOARD_REPO:f.cwd,WORKER_NODE:process.execPath,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);return result.stdout;
}

test('物理文件桥沿用相对路径合同，中文文件可读写编辑，CAS拒绝覆盖旧版本',()=>{
 const f=fixture(),tools=createWorkspaceTools(f.job);
 const made=tools.call('write_file',{path:'源码/中文.txt',content:'第一版\n',expected_sha256:null});
 assert.equal(readFileSync(join(f.cwd,'源码','中文.txt'),'utf8'),'第一版\n');
 const read=tools.call('read_file',{path:'源码/中文.txt'});assert.equal(read.sha256,made.sha256);assert.equal(read.text,'第一版\n');
 const changed=tools.call('edit_file',{path:'源码/中文.txt',old_text:'第一版',new_text:'第二版',expected_sha256:read.sha256});
 assert.notEqual(changed.sha256,read.sha256);
 assert.throws(()=>tools.call('write_file',{path:'源码/中文.txt',content:'不得覆盖',expected_sha256:read.sha256}),/VERSION_CHANGED/);
 assert.equal(readFileSync(join(f.cwd,'源码','中文.txt'),'utf8'),'第二版\n');
 assert.deepEqual(tools.call('list_files').items,[{path:'源码',directory:true}]);
});
test('文件桥编辑按字面写入新文本，不把 $ 序列当作替换模式',()=>{
 const f=fixture(),tools=createWorkspaceTools(f.job);
 const made=tools.call('write_file',{path:'脚本.ps1',content:'Write-Host OLD\n',expected_sha256:null});
 const wanted='Write-Host "pid=$$ match=$& pre=$` post=$\' group=$1"\n';
 const changed=tools.call('edit_file',{path:'脚本.ps1',old_text:'Write-Host OLD\n',new_text:wanted,expected_sha256:made.sha256});
 assert.equal(readFileSync(join(f.cwd,'脚本.ps1'),'utf8'),wanted);
 assert.equal(tools.call('read_file',{path:'脚本.ps1'}).sha256,changed.sha256);
});
test('文件桥拒绝越界、凭据、Git目录、链接及未声明工具；只读身份不允许写',()=>{
 const f=fixture(),tools=createWorkspaceTools(f.job);writeFileSync(join(f.cwd,'.env'),'仅夹具');mkdirSync(join(f.cwd,'.git'));
 for(const path of ['../外部.txt','.env','.git/config','子目录/../../外部.txt','auth.json','auth/login.txt','agent_jobs/run/job.json','foo\\bar'])
  assert.throws(()=>tools.call('write_file',{path,content:'禁止',expected_sha256:null}));
 assert.throws(()=>tools.call('shell',{command:'echo not-allowed'}),/TOOL_INVALID/);
 assert.throws(()=>tools.call('read_file',{path:'.env'}));assert.deepEqual(tools.call('list_files').items,[]);
 const other=join(f.directory,'其他');mkdirSync(other);writeFileSync(join(other,'文件.txt'),'不读取');
 symlinkSync(other,join(f.cwd,'链接'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>tools.call('read_file',{path:'链接/文件.txt'}));
 const readonly=createWorkspaceTools({...f.job,read_only:true,tools:'read-only'});assert.ok(readonly.list().every(t=>!['write_file','edit_file'].includes(t.name)));
 assert.throws(()=>readonly.call('write_file',{path:'不能写.txt',content:'x',expected_sha256:null}),/READ_ONLY/);
 assert.equal(existsSync(join(f.cwd,'不能写.txt')),false);
});
test('宿主SDK流及时记录活动，拒绝陈旧身份与重复终态，超时和取消不洗成成功',()=>{
 const f=fixture();
 const result=python(`import sys,pathlib,json,uuid,os,time\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nimport worker_loop as w\nw.PROFILE_MODE=True; w.API_MODE=True; w.RUNTIME='claude'; w.log=lambda *a:None; w.record_process_started=lambda *a:True\nw.EXECUTION_PROFILE={'execution_profile_id':'claude-api','profile_digest':'1'*64,'budget':{'timeout_sec':2}}\nt={'id':9,'run_id':str(uuid.uuid4())}; sent=[]\nw.call=lambda method,path,body,**kw:(sent.append((time.monotonic(),body)) or (200,{}))\nbase={'format':'kanban-agent-event/v1','task_id':9,'run_id':t['run_id'],'agent_instance_id':w.AGENT_INSTANCE_ID,'execution_profile_id':'claude-api','profile_digest':'1'*64,'model':'fixture','effort':'high'}\ndef event(kind,**fields): return {**base,'kind':kind,'event_id':str(uuid.uuid4()),**fields}\nfolder=pathlib.Path(sys.argv[2]); script=folder/'fake.py'; payload=folder/'events.json'\nscript.write_text('import sys,json,time\\nspec=json.load(open(sys.argv[1],encoding="utf-8"))\\nfor item in spec["events"]:\\n print(json.dumps(item),flush=True)\\n time.sleep(spec.get("delay",0))\\ntime.sleep(spec.get("sleep",0))\\nsys.exit(spec.get("exit",0))\\n',encoding='utf-8')\ndef run(events,**extra):\n sent.clear(); payload.write_text(json.dumps({'events':events,**extra}),encoding='utf-8')\n return w.run_api_process(t,'fixture',1,'fixture','high',[sys.executable,'-I','-B',str(script),str(payload)],dict(os.environ))\nterminal=event('terminal',status='success',report='实际回报',usage=None,cost_usd=None)\nstarted=time.monotonic(); answer=run([event('activity'),terminal],delay=0.1)\nassert answer['status']=='success' and len(sent)==2 and sent[0][1]['kind']=='activity' and sent[1][1]['kind']=='terminal'\nassert sent[1][0]-sent[0][0]>=0.08 and sent[1][1]['usage'] is None and sent[1][1]['cost_usd'] is None\nassert run([event('activity',run_id=str(uuid.uuid4()))])['status']=='failed' and len(sent)==1\nassert run([terminal,terminal])['status']=='failed'\nassert run([event('terminal',status='cancelled',report=None,usage=None,cost_usd=None)],exit=1)['status']=='cancelled'\nw.EXECUTION_PROFILE['budget']['timeout_sec']=0.1\nanswer=run([terminal],sleep=1); assert answer['status']=='timeout' and answer['report'] is None and sent[-1][1]['status']=='timeout'\nprint('host stream passed')`,[f.privateDir],f);
 assert.match(result,/host stream passed/);
});
test('Codex 本轮使用无需管理员初始化的后端且不混用配置层级',()=>{
 const f=fixture();
 python(`import sys,pathlib
sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))
import codex_runtime as c
for mode in ['write','read-only']:
 args=c.argv('fixture.exe','fixture-model','high','last.txt','fixture-work',mode=mode)
 assert 'windows.sandbox="unelevated"' in args,args
 assert all(i>args.index('exec') for i,v in enumerate(args) if v=='-c'),args
`,[],f);
});

test('Codex 订阅子进程强制 ChatGPT 登录并复用凭据过滤，保留选定认证目录',()=>{
 const f=fixture();
 const result=python(`import sys,pathlib,os,json\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nimport codex_runtime as c\nsource={'PATH':'fixture-path','CODEX_HOME':str(pathlib.Path(sys.argv[2])/'订阅认证'),'OPENAI_API_KEY':'FAKE-API','openai_base_url':'https://fixture.invalid','CODEX_API_KEY':'FAKE-CODEX','ANTHROPIC_API_KEY':'FAKE-OTHER','WORKER_BOARD_TOKEN':'FAKE-WORKER','BOARD_TOKEN':'FAKE-OPERATOR','REVIEWER_TOKEN':'FAKE-REVIEWER','WORKER_TIMEOUT_SEC':'600','WORKER_AUTH_HOMES':'[]'}\nbefore=dict(source); child=c.subscription_environment(source)\nassert source==before\nassert child['CODEX_HOME']==source['CODEX_HOME'] and child['PATH']=='fixture-path'\nassert child['WORKER_TIMEOUT_SEC']=='600'\nfor key in ['OPENAI_API_KEY','openai_base_url','CODEX_API_KEY','ANTHROPIC_API_KEY','WORKER_BOARD_TOKEN','BOARD_TOKEN','REVIEWER_TOKEN','WORKER_AUTH_HOMES']:\n assert key not in child,(key,child.keys())\nfor mode in ['write','read-only']:\n args=c.argv('fixture.exe','fixture-model','high','last.txt',str(pathlib.Path(sys.argv[2])),mode=mode)\n assert 'forced_login_method="chatgpt"' in args,args\n assert '--dangerously-bypass-approvals-and-sandbox' not in args\nprint('subscription contract passed')`,[f.privateDir],f);
 assert.match(result,/subscription contract passed/);
});

test('Codex 只读登录预检拒绝 API 认证且不注销，未知或超时同样拒发',()=>{
 const f=fixture();
 const result=python(`import sys,pathlib,json,subprocess,types\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nimport codex_runtime as c\nfolder=pathlib.Path(sys.argv[2]); auth=folder/'auth.json'; auth.write_text('{"OPENAI_API_KEY":"fixture-only"}',encoding='utf-8'); original=auth.read_bytes(); seen=[]\nenv={'PATH':'fixture-path','CODEX_HOME':str(folder),'OPENAI_API_KEY':'fixture-only','WORKER_BOARD_TOKEN':'fixture-only'}\ndef response(text,rc=0):\n def run(argv,**kwargs):\n  seen.append(argv); assert argv==[sys.executable,'login','status'],argv\n  assert kwargs['env']['CODEX_HOME']==str(folder) and 'OPENAI_API_KEY' not in kwargs['env']\n  assert all('forced_login_method' not in item for item in argv)\n  return types.SimpleNamespace(returncode=rc,stdout=text,stderr='')\n return run\nassert c.subscription_login_gate(sys.executable,env,_run=response('Logged in using ChatGPT')) is None\nerror=c.subscription_login_gate(sys.executable,env,_run=response('Logged in using an API key: fixture-only'))\nassert error and 'fixture-only' not in error and auth.read_bytes()==original,error\nassert c.subscription_login_gate(sys.executable,env,_run=response('unknown'))\ndef timeout(*a,**kw): raise subprocess.TimeoutExpired(a[0],15)\nassert c.subscription_login_gate(sys.executable,env,_run=timeout)\nprint('read-only login gate passed')`,[f.privateDir],f);
 assert.match(result,/read-only login gate passed/);
});

test('Codex worker 实际交接使用订阅环境，原卡最终回复仍由宿主落成证据',()=>{
 const f=fixture();
 const result=python(`import sys,pathlib,os,json,subprocess\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nimport worker_loop as w\nfolder=pathlib.Path(sys.argv[2]); evidence=folder/'worker-evidence.md'\nw.CODEX_CLI=sys.executable; w.DATA=str(folder); w.RUNTIME='codex'; w.TOOL_PROFILE='write'; w.codex_gate=lambda:None; w.codex_runtime.subscription_login_gate=lambda *a,**kw:None; w.build_prompt=lambda *a:'仅夹具任务'; calls=[]\nos.environ['OPENAI_API_KEY']='FAKE-API'; os.environ['WORKER_BOARD_TOKEN']='FAKE-WORKER'; os.environ['CODEX_HOME']=str(folder/'订阅认证')\ndef run(t,worker,attempt,runtime,model,effort,argv,env,**kw):\n calls.append((argv,env,kw))\n assert 'OPENAI_API_KEY' not in env and 'WORKER_BOARD_TOKEN' not in env\n assert env['CODEX_HOME']==os.environ['CODEX_HOME']\n assert 'forced_login_method="chatgpt"' in argv\n pathlib.Path(argv[argv.index('-o')+1]).write_text('本地夹具最终报告',encoding='utf-8')\n return subprocess.CompletedProcess(argv,0,'{"type":"thread.started","thread_id":"fixture-thread"}\\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}','')\nw.run_task_process=run\nrc,tail=w.run_codex({'id':19,'run_id':'fixture-run'},'fixture',str(evidence),None,1,'fixture-model','high')\nassert rc==0 and len(calls)==1,(rc,tail)\nassert calls[0][2]['input']=='仅夹具任务'\nassert evidence.read_text(encoding='utf-8')=='本地夹具最终报告'\nprint('worker subscription handoff passed')`,[f.privateDir],f);
 assert.match(result,/worker subscription handoff passed/);
});

test('API 形登录在 worker 生成进程之前被拒绝，原认证文件保留',()=>{
 const f=fixture();
 const result=python(`import sys,pathlib,os,types
sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))
import worker_loop as w
folder=pathlib.Path(sys.argv[2]); auth=folder/'auth.json'
auth.write_text('{"OPENAI_API_KEY":"fixture-only"}',encoding='utf-8'); before=auth.read_bytes()
os.environ['CODEX_HOME']=str(folder); w.CODEX_CLI=sys.executable; w.REPO=str(folder)
w.codex_gate=lambda:None
def status(argv,**kw):
 assert argv==[sys.executable,'login','status'],argv
 return types.SimpleNamespace(returncode=0,stdout='Logged in using an API key',stderr='')
w.codex_runtime.subprocess.run=status
def forbidden(*a,**kw): raise AssertionError('不应启动生成进程')
w.run_task_process=forbidden
rc,error=w.run_codex({'id':1,'run_id':'fixture-run'},'fixture',str(folder/'evidence.md'),None,1,'fixture','high')
assert rc==-3 and 'ChatGPT' in error and auth.read_bytes()==before,(rc,error)
print('worker rejected API login before generation')`,[f.privateDir],f);
 assert.match(result,/worker rejected API login before generation/);
});

test('显式CLI超时终止工具子树并及时收回输出，Windows后台启动，旧配置超时行为兼容',()=>{
 const f=fixture();
 const result=python(`import sys,pathlib,os,time,json,subprocess\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nimport worker_loop as w\nfolder=pathlib.Path(sys.argv[2]); child=folder/'child.py'; parent=folder/'parent.py'\nchild.write_text('import time,sys,os\\nprint("child-ready:"+str(os.getpid()),flush=True)\\nprint("child-stderr",file=sys.stderr,flush=True)\\ntime.sleep(10)\\n',encoding='utf-8')\nparent.write_text('import subprocess,sys,os\\np=subprocess.Popen([sys.executable,"-I","-B",sys.argv[1]],stdout=sys.stdout,stderr=sys.stderr)\\nprint("parent-ready",flush=True)\\np.wait()\\n',encoding='utf-8')\nw.PROFILE_MODE=True; w.EXECUTION_PROFILE={'execution_profile_id':'codex-cli'}; w.TIMEOUT=1.2\noptions={}; helper=[]; real_popen=subprocess.Popen; real_run=subprocess.run\ndef popen(*args,**kwargs): options.update(kwargs); return real_popen(*args,**kwargs)\ndef helper_run(*args,**kwargs):\n result=real_run(*args,**kwargs); helper.append({**kwargs,'returncode':result.returncode,'stderr':result.stderr.decode(errors='replace') if isinstance(result.stderr,bytes) else result.stderr});\n if result.returncode: print('taskkill local result',result.returncode,helper[-1]['stderr'],file=sys.stderr,flush=True)\n return result\nw.subprocess.run=helper_run\ntask={'id':7,'run_id':'fixture-run'}; started=time.monotonic()\ntry:\n w.run_task_process(task,'fixture',1,'codex','fixture','high',[sys.executable,'-I','-B',str(parent),str(child)],dict(os.environ),_popen=popen,_call=lambda *a,**k:(200,{}),_log=lambda *a:None)\n raise AssertionError('timeout not raised')\nexcept subprocess.TimeoutExpired as error:\n assert 'parent-ready' in error.stdout and 'child-ready:' in error.stdout and 'child-stderr' in error.stderr, (error.stdout,error.stderr)\n assert time.monotonic()-started<8\n if os.name=='nt':\n  assert options['creationflags']&subprocess.CREATE_NO_WINDOW and helper and helper[0]['creationflags']&subprocess.CREATE_NO_WINDOW\n else: assert options['start_new_session'] is True\nw.subprocess.run=real_run\nw.PROFILE_MODE=False; calls=[]; legacy_options={}\nclass Legacy:\n pid=123; returncode=-1\n def __enter__(self): return self\n def __exit__(self,*a): pass\n def communicate(self,input=None,timeout=None):\n  calls.append(('communicate',timeout))\n  if timeout is not None: raise subprocess.TimeoutExpired('fixture',timeout)\n  return ('旧配置输出','旧配置错误')\n def kill(self): calls.append(('kill',None))\ndef legacy_popen(*a,**kw): legacy_options.update(kw); return Legacy()\ntry:\n w.run_task_process(task,'fixture',1,'codex','fixture','high',[],{},_popen=legacy_popen,_call=lambda *a,**k:(200,{}),_log=lambda *a:None)\n raise AssertionError('legacy timeout not raised')\nexcept subprocess.TimeoutExpired as error: assert error.stdout=='旧配置输出' and error.stderr=='旧配置错误'\nassert len(calls)==3 and calls[1][0]=='kill' and calls[2]==('communicate',None)\nassert 'creationflags' not in legacy_options and 'start_new_session' not in legacy_options\nprint('CLI timeout tree passed')`,[f.privateDir],f);
 assert.match(result,/CLI timeout tree passed/);
});
test('文件桥 MCP 保留初始化与重复请求边界，没有shell或删除入口',()=>{
 const f=fixture(),handle=createWorkspaceMcp(f.job);
 assert.equal(handle({jsonrpc:'2.0',id:1,method:'tools/list'}).error.code,-32002);
 assert.ok(handle({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-06-18'}}).result);
 handle({jsonrpc:'2.0',method:'notifications/initialized'});
 const tools=handle({jsonrpc:'2.0',id:3,method:'tools/list'}).result.tools;
 assert.deepEqual(tools.map(t=>t.name),['list_files','read_file','write_file','edit_file']);
 assert.equal(handle({jsonrpc:'2.0',id:3,method:'tools/list'}).error.code,-32600);
 const refused=handle({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'write_file',arguments:{path:'../不能写',content:'x',expected_sha256:null}}});assert.equal(refused.result.isError,true);
});
test('两个SDK继承宿主控制路径快照，默认同仓的数据、任意登记配置与认证目录均不可访问',()=>{
 const f=fixture(),data=join(f.cwd,'core','.data'),config=join(f.cwd,'运营','自定义配置.json'),registry=join(f.cwd,'运营','自定义登记.json'),auth=join(f.cwd,'私人登录');
 mkdirSync(data,{recursive:true});mkdirSync(join(f.cwd,'运营'));mkdirSync(auth);
 for(const name of ['accepted_rev','worker_settings.json','board.db','board.db-wal','spend_ledger.jsonl','usage_ledger.jsonl'])writeFileSync(join(data,name),'固定控制数据');
 writeFileSync(config,'固定配置');writeFileSync(registry,'固定登记簿');writeFileSync(join(auth,'登录信息.json'),'固定认证');writeFileSync(join(f.cwd,'普通源码.txt'),'可读源码');
 const job={...f.job,protected_paths:[data,config,registry,auth]},tools=createWorkspaceTools(job);writeFileSync(f.jobPath,JSON.stringify(job));
 for(const path of ['core/.data/accepted_rev','core/.data/worker_settings.json','core/.data/board.db','core/.data/board.db-wal','core/.data/spend_ledger.jsonl','core/.data/usage_ledger.jsonl','运营/自定义配置.json','运营/自定义登记.json','私人登录/登录信息.json']){
  assert.throws(()=>tools.call('read_file',{path}),/CONTROL_PATH_DENIED/);
  assert.throws(()=>tools.call('write_file',{path,content:'不得修改',expected_sha256:null}),/CONTROL_PATH_DENIED/);
  assert.throws(()=>tools.call('edit_file',{path,old_text:'固定',new_text:'不得修改',expected_sha256:'0'.repeat(64)}),/CONTROL_PATH_DENIED/);
 }
 assert.deepEqual(tools.call('list_files',{path:'core'}).items,[]);assert.deepEqual(tools.call('list_files',{path:'运营'}).items,[]);
 assert.throws(()=>tools.call('list_files',{path:'core/.data'}),/CONTROL_PATH_DENIED/);
 assert.equal(tools.call('read_file',{path:'普通源码.txt'}).text,'可读源码');
 assert.throws(()=>createWorkspaceTools({...job,protected_paths:undefined}),/PROTECTION_REQUIRED/);
 assert.throws(()=>createWorkspaceTools({...job,workspace:{...job.workspace,inode:'0'}}),/IDENTITY_CHANGED/);
 const result=python(`import sys,pathlib,json,os\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'runners')); sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nfrom agent_contract import read_job,tool_allowed,validate_job\nj=read_job(sys.argv[2])\nfor path in ['core/.data/accepted_rev','core/.data/worker_settings.json','core/.data/board.db','core/.data/board.db-wal','core/.data/spend_ledger.jsonl','core/.data/usage_ledger.jsonl','运营/自定义配置.json','运营/自定义登记.json','私人登录/登录信息.json']:\n for tool in ['Read','Write','Edit']:\n  assert not tool_allowed(j,tool,{'file_path':path}), (tool,path)\n assert not tool_allowed(j,'Grep',{'path':path,'pattern':'.'})\nassert not tool_allowed(j,'Glob',{'path':j['cwd'],'pattern':'**/*'})\nassert tool_allowed(j,'Read',{'file_path':'普通源码.txt'})\ntry: validate_job({**j,'protected_paths':[]}); raise AssertionError('missing protection accepted')\nexcept ValueError: pass\ntry: validate_job({**j,'workspace':{**j['workspace'],'inode':'0'}}); raise AssertionError('changed identity accepted')\nexcept ValueError: pass\nimport worker_loop as w\nextra=pathlib.Path(j['cwd'])/'另一个宿主配置.json'; os.environ['WORKER_PROTECTED_PATHS']=json.dumps([str(extra)]); paths=w.sdk_protected_paths()\nassert os.path.normcase(os.path.realpath(w.DATA)) in paths and os.path.normcase(os.path.realpath(w.REGISTRY)) in paths and os.path.normcase(str(extra)) in paths\nfrom verify_lib import PROTECTED\nfor name in PROTECTED:\n relative=name.replace('**','nested').replace('*','fixture'); assert not tool_allowed({**j,'protected_paths':paths},'Read',{'file_path':str(pathlib.Path(w.DATA)/relative)})\nprint('protected paths passed')`,[f.jobPath],f);
 assert.match(result,/protected paths passed/);
 assert.equal(readFileSync(join(data,'accepted_rev'),'utf8'),'固定控制数据');
});
test('目录别名与真实路径共用工作仓身份，保护未来文件时也规范已有父目录',()=>{
 const f=fixture(),alias=join(f.directory,'工作仓别名');symlinkSync(f.cwd,alias,process.platform==='win32'?'junction':'dir');
 mkdirSync(join(f.cwd,'运营'));writeFileSync(join(f.cwd,'运营','控制.json'),'固定控制数据');
 const job={...f.job,cwd:alias,protected_paths:[join(alias,'运营','控制.json'),join(alias,'尚未创建','控制.json')]};
 assert.equal(validateJob(job),job);assert.equal(canonicalWorkspacePath(join(alias,'尚未创建','控制.json')),join(f.cwd,'尚未创建','控制.json'));
 const tools=createWorkspaceTools(job);
 assert.throws(()=>tools.call('read_file',{path:'运营/控制.json'}),/CONTROL_PATH_DENIED/);
 assert.throws(()=>tools.call('write_file',{path:'尚未创建/控制.json',content:'不得写入',expected_sha256:null}),/CONTROL_PATH_DENIED/);
 assert.equal(existsSync(join(f.cwd,'尚未创建')),false);
 assert.deepEqual(tools.call('list_files',{path:'运营'}).items,[]);
 tools.call('write_file',{path:'普通源码.txt',content:'正常开发',expected_sha256:null});assert.equal(readFileSync(join(f.cwd,'普通源码.txt'),'utf8'),'正常开发');
});
test('Codex SDK使用独立API环境、隔离内层目录和唯一工作仓MCP，未知费用保持null',async()=>{
 const f=fixture(),events=[];let options,threadOptions;
 const env={OPENAI_API_KEY:'synthetic-api-value',CODEX_HOME:f.privateDir,BOARD_TOKEN:'synthetic-board-value',ANTHROPIC_API_KEY:'another-provider',PATH:process.env.PATH};
 const fake=opts=>{options=opts;return {startThread:settings=>{threadOptions=settings;return {runStreamed:async()=>({events:(async function*(){
  yield {type:'thread.started',thread_id:'fixture-thread'};
  yield {type:'item.started',item:{type:'mcp_tool_call',id:'1'}};
  createWorkspaceTools(f.job).call('write_file',{path:'GPT产物.txt',content:'实际夹具产物',expected_sha256:null});
  yield {type:'item.completed',item:{type:'mcp_tool_call',server:'kanban_workspace',tool:'write_file',status:'completed'}};
  yield {type:'item.completed',item:{type:'agent_message',text:'已修改 GPT产物.txt；验证由宿主执行。'}};
  yield {type:'turn.completed',usage:{input_tokens:20,output_tokens:5,cached_input_tokens:0}};
 })()})};}}};
 assert.equal(await runJob(f.job,{createCodex:fake,emit:e=>events.push(e),environment:env}),true);
 assert.equal(options.apiKey,env.OPENAI_API_KEY);assert.equal(options.env.BOARD_TOKEN,undefined);assert.equal(options.env.ANTHROPIC_API_KEY,undefined);assert.equal(options.env.OPENAI_API_KEY,undefined);
 assert.equal(options.config.forced_login_method,'api');assert.equal(options.config.features.shell_tool,false);assert.equal(options.config.features.unified_exec,false);
 assert.deepEqual(Object.keys(options.config.mcp_servers),['kanban_workspace']);
 assert.equal(threadOptions.workingDirectory,f.privateDir);assert.equal(threadOptions.sandboxMode,'read-only');assert.equal(threadOptions.approvalPolicy,'never');
 assert.equal(readFileSync(join(f.cwd,'GPT产物.txt'),'utf8'),'实际夹具产物');
 assert.equal(events.at(-1).cost_usd,null);assert.equal(events.at(-1).usage.cache_write_input_tokens,null);assert.equal(events.at(-1).status,'success');
 for(const e of events){assert.equal(e.run_id,f.job.run_id);assert.equal(e.execution_profile_id,'gpt-api');assert.match(e.event_id,/^[a-f0-9-]{36}$/);assert.ok(!JSON.stringify(e).includes(env.OPENAI_API_KEY));}
});
test('GPT SDK缺终态、失败、重复终态或超出步数均不变成功、不自动重跑',async()=>{
 for(const stream of [[],[{type:'turn.failed'}],[{type:'item.completed',item:{type:'agent_message',text:'不能洗绿'}},{type:'turn.completed',usage:{}},{type:'turn.completed',usage:{}}],
  [{type:'item.started',item:{type:'mcp_tool_call'}},{type:'item.started',item:{type:'mcp_tool_call'}}]]){
  const f=fixture(),events=[];let starts=0;
  const ok=await runJob({...f.job,budget:{...f.job.budget,max_turns:1}},{environment:{OPENAI_API_KEY:'synthetic-value',CODEX_HOME:f.privateDir},emit:e=>events.push(e),
   createCodex:()=>({startThread:()=>{starts++;return {runStreamed:async()=>({events:(async function*(){yield*stream;})()})};}})});
  assert.equal(ok,false);assert.equal(starts,1);assert.equal(events.at(-1).status,'failed');assert.equal(events.at(-1).report,null);
 }
});
test('已取消或未配置凭据的GPT任务不会创建SDK客户端，UTF8提示从同目录文件读取',async()=>{
 const f=fixture();assert.equal(loadJob(f.jobPath).prompt,'只处理本次样本，回报实际修改。');
 assert.throws(()=>sdkOptions(f.job,{}),/CREDENTIAL_REQUIRED/);
 let calls=0;const events=[],controller=new AbortController();controller.abort();
 assert.equal(await runJob(f.job,{createCodex:()=>{calls++;},environment:{OPENAI_API_KEY:'synthetic',CODEX_HOME:f.privateDir},emit:e=>events.push(e),signal:controller.signal}),false);
 assert.equal(calls,0);assert.equal(events.at(-1).status,'cancelled');
});
test('Claude SDK薄入口传递原生预算与权限钩子，凭据不外溢，未知用量不记零',()=>{
 const f=fixture(),job={...f.job,channel:'claude_agent_sdk',runtime:'claude',execution_profile_id:'claude-api'};writeFileSync(f.jobPath,JSON.stringify(job));
 const result=python(`import sys,json,asyncio,types,pathlib\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'runners'))\nimport claude_agent as r\nj=r.read_job(sys.argv[2]); events=[]; saved={}\nclass A: pass\nclass R:\n subtype='success'; is_error=False; result='已生成样本'; session_id='fixture-session'; uuid='fixture-request'; total_cost_usd=None; usage=None; permission_denials=[]\nasync def query(**kw):\n saved.update(kw); yield A(); yield R()\ndef options(**kw): saved['options']=kw; return kw\nsdk=types.SimpleNamespace(query=query,AssistantMessage=A,ResultMessage=R,ClaudeAgentOptions=options,HookMatcher=lambda **kw:kw,PermissionResultAllow=lambda **kw:kw,PermissionResultDeny=lambda **kw:kw)\nassert asyncio.run(r.run_job(j,events.append,sdk=sdk,environment={'ANTHROPIC_API_KEY':'synthetic','CLAUDE_CONFIG_DIR':'fixture-home','WORKER_BOARD_TOKEN':'not-forwarded','OPENAI_API_KEY':'other'}))\no=saved['options']; assert o['max_turns']==4 and o['max_budget_usd']==0.5 and o['permission_mode']=='dontAsk'; assert 'WORKER_BOARD_TOKEN' not in o['env'] and 'OPENAI_API_KEY' not in o['env']; assert 'Bash' not in o['tools']\nh=o['hooks']['PreToolUse'][0]['hooks'][0]\nassert asyncio.run(h({'tool_name':'Write','tool_input':{'file_path':'../outside'}},None,None))['hookSpecificOutput']['permissionDecision']=='deny'\nassert asyncio.run(h({'tool_name':'Write','tool_input':{'file_path':'样本.txt'}},None,None))=={}\nassert events[-1]['usage'] is None and events[-1]['cost_usd'] is None\nassert all(e['run_id']==j['run_id'] for e in events)\nprint('claude fake passed')`,[f.jobPath],f);
 assert.match(result,/claude fake passed/);
});
test('原循环显式通道固定模型，不重试、不自动派生；API配置和任务身份不匹配先拒绝',()=>{
 const f=fixture();
 const result=python(`import sys,pathlib,types,uuid,os\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nimport worker_loop as w\nw.log=lambda *a:None; w.PROFILE_MODE=True; w.API_MODE=True; w.RUNTIME='claude'; w.MODEL='claude-fixture'; w.EFFORT='high'\nidentity=w.workspace_identity(w.REPO); workspace={'path':identity['root'],'device':identity['device'],'inode':identity['inode']}\np={'execution_profile_id':'claude-api','profile_digest':'1'*64,'channel':'claude_agent_sdk','runtime':'claude','enabled':True,'model':w.MODEL,'effort':w.EFFORT,'workspace':workspace,'tools':w.TOOL_PROFILE,'budget':{'timeout_sec':5,'max_turns':4,'max_cost_usd':0.5}}; w.EXECUTION_PROFILE=p\nw._API_CREDENTIALS['ANTHROPIC_API_KEY']='synthetic'; os.environ['CLAUDE_CONFIG_DIR']='fixture'; assert w.profile_gate() is None\nt={'id':9,'run_id':str(uuid.uuid4()),'subject':'样本','attempts':1,'max_attempts':3,'execution_profile':{**p}}\nw.assert_task_profile(t,w.MODEL,w.EFFORT)\ntry: w.assert_task_profile({**t,'execution_profile':{**t['execution_profile'],'profile_digest':'2'*64}},w.MODEL,w.EFFORT); raise AssertionError('not refused')\nexcept RuntimeError: pass\ncalls=[]; sent=[]\nw.Heartbeat=lambda *a:types.SimpleNamespace(start=lambda:None,stop=types.SimpleNamespace(set=lambda:None),beats=0)\nw.tier_of=lambda *a:(_ for _ in ()).throw(AssertionError('不得爬梯'))\nw.run_worker=lambda *a:(calls.append(a) or (-1,'SDK_AUTH_FAILED'))\nw.acct_attempt=lambda *a:{'calls':None,'in':None,'out':None,'cc':None,'cr':None,'cost_usd':None}\nw.deliver=lambda *a,**kw:sent.append((a,kw)) or True\nw.harvest_spawned=lambda *a:(_ for _ in ()).throw(AssertionError('不得派生'))\nassert w.handle(t,'fixture')=='wait'; assert len(calls)==1 and len(sent)==1 and calls[0][-2:]==(w.MODEL,w.EFFORT)\np['budget']=None; assert '预算' in w.profile_gate()\nprint('worker explicit passed')`,[],f);
 assert.match(result,/worker explicit passed/);
});
test('API 循环取走供应商密钥：登记验证命令看不到，只有 SDK 运行器拿到本家密钥',()=>{
 const f=fixture();
 const result=python(`import sys,pathlib,json,os,uuid\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nfolder=pathlib.Path(sys.argv[2]); registry=folder/'登记簿.json'; names=('ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY')\nprobe="import os;print('|'.join(k for k in ('ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY') if os.environ.get(k)) or 'none')"\nregistry.write_text(json.dumps({'envprobe':['python','-c',probe]}),encoding='utf-8')\nprofile={'execution_profile_id':'claude-api','profile_digest':'1'*64,'channel':'claude_agent_sdk','runtime':'claude','enabled':True,'workspace':{},'budget':{'timeout_sec':5,'max_turns':4,'max_cost_usd':0.5}}\nos.environ.update({'BOARD_VERIFY_REGISTRY':str(registry),'WORKER_RUNTIME':'claude','WORKER_EXECUTION_PROFILE':json.dumps(profile),'CLAUDE_CONFIG_DIR':str(folder),'ANTHROPIC_API_KEY':'sk-ant-FAKE-D1','OPENAI_API_KEY':'sk-proj-FAKE-D1','CODEX_API_KEY':'sk-FAKE-D1'})\nimport worker_loop as w\nassert w.API_MODE\nassert not [k for k in names if k in os.environ], [k for k in names if k in os.environ]\nr=w.run_verify({'verify_cmd':'envprobe'})\nassert r['rc']==0 and r['out'].strip()=='none' and 'FAKE' not in r['out'], r\ncaptured={}\nw.assert_task_profile=lambda *a:None; w.profile_gate=lambda **k:None; w.build_prompt=lambda *a:'样本'\nw.run_api_process=lambda t,worker,attempt,model,effort,argv,environment:(captured.update(environment) or {'status':'failed','diagnostic':'FIXTURE'})\nassert w.run_api_worker({'id':9,'run_id':str(uuid.uuid4())},'fixture',str(folder/'evidence.txt'),'',1,'m','high')==(-1,'FIXTURE')\nassert captured.get('ANTHROPIC_API_KEY')=='sk-ant-FAKE-D1' and 'OPENAI_API_KEY' not in captured and 'CODEX_API_KEY' not in captured, sorted(captured)\nprint('verify env passed')`,[f.privateDir],f);
 assert.match(result,/verify env passed/);
});
test('显式 Claude CLI 的金额上限不被抬到 1 美元，旧配置保留原下限',()=>{
 const f=fixture();
 const result=python(`import sys,pathlib,os\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nimport worker_loop as w\nos.environ['WORKER_MAX_BUDGET_USD']='0.5'\ndef cap(argv): i=argv.index('--max-budget-usd'); return argv[i+1]\nw.PROFILE_MODE=True; w.EXECUTION_PROFILE={'execution_profile_id':'claude-cli','budget':{'timeout_sec':60,'max_turns':2,'max_cost_usd':0.5}}\nassert cap(w.cli_argv('样本',[],'claude-fixture','high'))=='0.50', cap(w.cli_argv('样本',[],'claude-fixture','high'))\nw.gates_lib.remaining_today=lambda data:(0.3,0.0,0,1.0)\nassert cap(w.cli_argv('样本',[],'claude-fixture','high'))=='0.30'\nw.PROFILE_MODE=False; w.EXECUTION_PROFILE=None\nassert cap(w.cli_argv('样本',[],'claude-fixture','high'))=='1.00'\nprint('cli budget passed')`,[],f);
 assert.match(result,/cli budget passed/);
});
test('登记验证命令看不到认证目录与供应商凭据：显式 Claude CLI、Codex CLI 与旧配置相同',()=>{
 const f=fixture(),marker='auth-home-fixture-7c1e',auth=join(f.directory,marker),dataDir=f.privateDir,registry=join(f.privateDir,'登记簿.json');
 const budget={timeout_sec:60,max_turns:2,max_cost_usd:0.5};
 const profiles=loadExecutionProfiles([{id:'claude-cli',enabled:true,budget,auth_home:join(auth,'claude')},{id:'codex-cli',enabled:true,budget,auth_home:join(auth,'codex')}],{dataDir});
 const secrets={ANTHROPIC_API_KEY:'sk-ant-FAKE-V',OPENAI_API_KEY:'sk-proj-FAKE-V',AZURE_OPENAI_API_KEY:'FAKE-V',CLAUDE_CODE_OAUTH_TOKEN:'FAKE-V',
  CLAUDE_CODE_USE_BEDROCK:'1',CODEX_API_KEY:'FAKE-V',KANBAN_ANTHROPIC_API_KEY:'FAKE-V',VENDOR_API_KEY:'FAKE-V'};
 const watched=[...Object.keys(secrets),'CLAUDE_CONFIG_DIR','CODEX_HOME'].map(name=>`'${name}'`).join(',');
 // 探针只打印变量名与是否含认证目录标记，不打印值。
 const probe=`import os,json;w=[${watched}];print(json.dumps({'names':sorted(k for k in os.environ if k.upper() in w),'auth':sorted(k for k,v in os.environ.items() if '${marker}' in v),'keep':os.environ.get('KEEP_ORDINARY'),'python':bool(os.environ.get('PYTHON')),'repo':os.environ.get('BOARD_REPO')}))`;
 writeFileSync(registry,JSON.stringify({envprobe:['python','-c',probe]}));
 // 宿主环境按 server.slotEnv 的形状：WORKER_PROTECTED_PATHS、WORKER_AUTH_HOMES 列出全部认证目录；旧配置经 profileEnvironment(null) 只剔登记的凭据名。
 const host={PATH:process.env.PATH||process.env.Path||'',SystemRoot:process.env.SystemRoot||'',TEMP:process.env.TEMP||tmpdir(),TMP:process.env.TMP||tmpdir(),
  BOARD_DATA_DIR:dataDir,BOARD_REPO:f.cwd,BOARD_CONFIG:join(f.privateDir,'无配置.json'),BOARD_VERIFY_REGISTRY:registry,BOARD_CODEX_RELEASED:'1',BOARD_CODEX_CMD:process.execPath,
  WORKER_PROTECTED_PATHS:JSON.stringify([dataDir,registry,...profiles.map(p=>p.auth_home)]),WORKER_AUTH_HOMES:JSON.stringify(profiles.map(p=>p.auth_home)),KEEP_ORDINARY:'保留',...secrets,
  CLAUDE_CONFIG_DIR:join(auth,'日常 claude'),CODEX_HOME:join(auth,'日常 codex')};
 for(const [id,runtime] of [['claude-cli','claude'],['codex-cli','codex'],[null,'claude']]){
  const label=id||'旧配置';
  const loopEnv={...profileEnvironment(id&&getExecutionProfile(profiles,id),{env:host,repoRoot:f.cwd,dataDir,profiles}),WORKER_RUNTIME:runtime};
  assert.ok(Object.values(loopEnv).some(value=>value.includes(marker)),label+'：夹具前提，循环自身持有认证目录');
  const file=join(f.privateDir,`loop-env-${id||'legacy'}.json`);writeFileSync(file,JSON.stringify(loopEnv));
  const out=python(`import sys,os,json,pathlib\nloop=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'))\nos.environ.clear(); os.environ.update(loop)\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nimport worker_loop as w\nassert w.PROFILE_MODE is ${id?'True':'False'} and not w.API_MODE\nr=w.run_verify({'verify_cmd':'envprobe'})\nassert r['rc']==0, r\nprint(r['out'].strip().splitlines()[-1])`,[file],f);
  const seen=JSON.parse(out.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(seen.names,[],label+'：验证命令不应看到登录目录指针或凭据变量');
  assert.deepEqual(seen.auth,[],label+'：验证命令环境里不应有任何值含认证目录路径');
  assert.equal(seen.keep,'保留',label+'：普通变量照常继承');assert.equal(seen.python,true,label+'：解释器映射照常传递');assert.equal(seen.repo,f.cwd,label+'：BOARD_ 变量照常继承');
 }
});
test('Claude CLI 的文件工具拒绝读写全部配置的认证目录：旧线与显式配置相同，本配置目录不重复',()=>{
 // 兼容约定变更：旧线（无执行配置）也按 server 下传的 WORKER_AUTH_HOMES 拒绝其他配置的认证目录。
 const f=fixture(),own=join(f.directory,'订阅 登录'),other=join(f.directory,'其他配置 认证');
 const result=python(`import sys,pathlib,os,json\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nimport worker_loop as w\nown,other=sys.argv[2],sys.argv[3]\ndef denied(argv): return argv[argv.index('--disallowedTools')+1:]\ndef want(*homes): return [r for h in homes for r in ('Read(%s/**)'%w.deny_path(h),'Edit(%s/**)'%w.deny_path(h))]\nbase=w.cli_deny_rules(w.DATA)\nassert denied(w.cli_argv('样本',[],'m','high'))==base, '无清单时只有数据目录规则'\nos.environ['WORKER_AUTH_HOMES']=json.dumps([own,other])\nlegacy=denied(w.cli_argv('样本',[],'m','high'))\nassert legacy==base+want(own,other), ('旧线', legacy[len(base):])\nos.environ['WORKER_PROFILE_AUTH_HOME']=own; w.PROFILE_MODE=True; w.EXECUTION_PROFILE={'execution_profile_id':'claude-cli','budget':{'timeout_sec':60,'max_turns':2,'max_cost_usd':0.5}}\nexplicit=denied(w.cli_argv('样本',[],'m','high'))\nassert explicit==base+want(own,other), ('显式配置', explicit[len(base):])\ndel os.environ['WORKER_AUTH_HOMES']\nassert denied(w.cli_argv('样本',[],'m','high'))==base+want(own), '手动起线没有清单也覆盖本配置'\nfor bad in ('{"x":1}','["相对"]','[" "]','不是 JSON'):\n    os.environ['WORKER_AUTH_HOMES']=bad\n    try:\n        w.auth_home_deny_rules(); raise SystemExit('坏清单应拒绝: '+bad)\n    except ValueError:\n        pass\nprint('auth deny passed')`,[own,other],f);
 assert.match(result,/auth deny passed/);
});
