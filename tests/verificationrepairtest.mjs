import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 全部执行与验证都使用本地函数桩；不启动供应商 CLI、SDK 或真实模型。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TMP = realpathSync.native(mkdtempSync(join(tmpdir(), "kanban-repair-")));
const PY = HOST_ENV.PYTHON || "python";
const store = createRequire(import.meta.url)("../core/store.js");
let serial = 0;
after(() => {
  const inside = relative(realpathSync.native(tmpdir()), realpathSync.native(TMP));
  assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
  rmSync(TMP, { recursive: true, force: true });
});
function python(source) {
  const directory = join(TMP, String(++serial)); mkdirSync(directory);
  const clean = Object.fromEntries(Object.entries(HOST_ENV).filter(([key]) =>
    !/^(?:BOARD_|WORKER_|REVIEWER_|REVIEW_|KANBAN_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_CONFIG_DIR$)/i.test(key)));
  const result = spawnSync(PY, ["-I", "-B", "-X", "utf8", "-", ROOT, directory], {
    cwd: ROOT, windowsHide: true, encoding: "utf8", timeout: 15000,
    env: { ...clean, BOARD_CONFIG: join(directory, "missing-config.json"), BOARD_REPO: directory,
      BOARD_DATA_DIR: directory, BOARD_VERIFY_REGISTRY: join(directory, "missing-registry.json"),
      WORKER_RUNTIME: "codex", WORKER_MODEL: "fixture-model", WORKER_EFFORT: "high",
      PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
    input: "import sys,pathlib,json,uuid,types,threading\n" +
      "sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nfolder=pathlib.Path(sys.argv[2])\n" + source,
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  return result.stdout;
}

const WORKER_FIXTURE = `import worker_loop as w
w.API_MODE=False; w.PROFILE_MODE=False; w.RUNTIME='codex'; w.MODEL='fixture-model'; w.EFFORT='high'
w.TOOL_PROFILE='read-only'; w.TIMEOUT=60; w.log=lambda *args,**kwargs:None
w.gates_lib.append_spend=lambda *args,**kwargs:None
w.harvest_spawned=lambda *args,**kwargs:([], '')
w.stash_spawn=lambda *args,**kwargs:''
w.usage_of=lambda *args,**kwargs:{'calls':None,'in':None,'cc':None,'cr':None,'out':None,'note':'夹具未知用量'}
class Heartbeat:
 def __init__(self,*args): self.stop=threading.Event(); self.beats=0
 def start(self): pass
w.Heartbeat=Heartbeat

def exercise(outputs, *, rounds=3, policy=True, lost=False, elapsed=0, rc=0, tail='完成本轮修改', evidence='本轮交付', api=False, identity_changed=False):
 case=folder/str(uuid.uuid4()); case.mkdir()
 w.DATA=str(case); w.EVID=str(case/'evidence'); w.LEDGER=str(case/'usage_ledger.jsonl')
 w.os.environ['CODEX_HOME']=str(case/'认证目录')
 w.API_MODE=api; w.PROFILE_MODE=False; w.LAST_ACCT={'sid':'旧账','t0':None,'usage':{'calls':999,'in':999,'cc':999,'cr':999,'out':999}}
 clock=[1000.0]; w.time.monotonic=lambda:clock[0]
 t={'id':7,'run_id':str(uuid.uuid4()),'attempts':9,'attempts_this_claim':1,'max_attempts':99,
    'status':'in_progress','worker':'fixture','claimed_by':'fixture','lease_until':9999999999999,
    'agent_instance_id':w.AGENT_INSTANCE_ID,'verify_cmd':'fixture-check','subject':'不得重堆的任务背景'}
 repair={'max_rounds':rounds,'legacy_retry':False}
 if policy: t['verification_repair']=repair
 calls=[]; requests=[]; deliveries=[]; verifies=[]; sid=str(uuid.uuid4())
 def call(method,path,body=None,**kwargs):
  requests.append((method,path,body))
  if method=='GET' and path.endswith('/runs'):
   return 200,{'runs':[{'run_id':t['run_id'],'worker':'fixture','agent_instance_id':w.AGENT_INSTANCE_ID,
    'state':'running','runtime':'codex','first_attempt':9,'last_attempt':9,
    'policy':{'context':({'verification_repair':repair} if policy else {})}}]}
  if method=='GET':
   current=dict(t)
   if lost=='lease': current['lease_until']=0
   elif lost: current['run_id']=str(uuid.uuid4())
   return 200,{'task':current}
  raise AssertionError('续修不应调用新的attempt或其他写接口:'+path)
 w.call=call
 def run_worker(task,worker,path,prev,attempt,model,effort):
  ctx=task['_repair_context']
  if calls: assert ctx['session_id']==sid,ctx
  ctx['session_id']=sid
  calls.append({'run':task['run_id'],'attempt':attempt,'session':ctx['session_id'],'model':model,'effort':effort,
                'tools':w.TOOL_PROFILE,'auth':w.os.environ.get('CODEX_HOME'),'deadline':task['_attempt_deadline'],
                'remaining':task['_attempt_deadline']-clock[0],'prompt':ctx.get('prompt')})
  # 第二轮刻意不提供用量，旧轮数据必须被清空，不许沿用第一轮的已知值。
  if len(calls)==1: w.LAST_ACCT={'sid':sid,'t0':None,'usage':{'calls':1,'in':12,'cc':0,'cr':0,'out':3,'note':None}}
  if evidence: pathlib.Path(path).write_text(evidence,encoding='utf-8')
  return rc,tail
 w.run_worker=run_worker
 def verify(task):
  idx=len(verifies); value=outputs[min(idx,len(outputs)-1)]; verifies.append(value)
  clock[0]+=elapsed
  if identity_changed: w.os.environ['CODEX_HOME']=str(case/'另一认证目录')
  return {'key':'fixture-check','cmd':'本地函数桩','registry_sha256':'a'*64,'rc':0 if value.get('ok') else 1,**value}
 w.run_verify=verify
 def deliver(*args,**kwargs): deliveries.append((args,kwargs)); return True
 w.deliver=deliver
 result=w.handle(t,'fixture')
 rows=[json.loads(line) for line in pathlib.Path(w.LEDGER).read_text(encoding='utf-8').splitlines()] if pathlib.Path(w.LEDGER).exists() else []
 return types.SimpleNamespace(result=result,t=t,calls=calls,requests=requests,deliveries=deliveries,rows=rows,verifies=verifies)
red={'ok':False,'out':'AssertionError: 预期 2，实际 1'}
green={'ok':True,'out':'PASS 本地桩验证'}
`;

test("纯分类只允许明确测试红，环境故障、未知和模型卡住均停止", () => {
  python(`import verification_repair as v
assert v.classify(0,'完成',{'ok':False,'rc':1,'out':'AssertionError: expected 2'},'交付')=='test_failure'
assert v.classify(0,'完成',{'ok':True,'rc':0,'out':'PASS'},'交付')=='passed'
assert v.classify(0,'完成，需要人工验收',{'ok':True,'rc':0,'out':'PASS'},'交付')=='passed'
assert v.classify(0,'我已卡住，需要人工',{'ok':False,'rc':1,'out':'FAIL'},'交付')=='blocked'
for output in ['ModuleNotFoundError: missing_fixture','Cannot find module fixture','FileNotFoundError: fixture',
 'EADDRINUSE port 123','ECONNREFUSED','command not found','timeout','timed out','0 PASS / 1 FAIL: TypeError: fixture',
 'TypeError: fixture','未知退出原因']:
 assert v.classify(0,'完成',{'ok':False,'rc':1,'out':output},'交付')=='environment',output
for code in [None,-1,-2,-3]:
 assert v.classify(0,'完成',{'ok':False,'rc':code,'out':'FAIL'},'交付')=='environment',code
assert v.classify(-2,'spawn失败',{'ok':False,'rc':1,'out':'FAIL'},'交付')=='environment'
assert v.classify(0,'完成',None,None)=='environment'
# 环境特征在完整输出首部，尾部恰为测试红，不能先截尾再误分成可续修。
full='ERR_MODULE_NOT_FOUND: fixture'+chr(10)+'x'*6000+chr(10)+'FAIL assertion'
assert v.classify(0,'完成',{'ok':False,'rc':1,'full_out':full,'out':full[-4000:]},'交付')=='environment'
`);
});

test("一尝试两轮红转绿保持同会话、模型、强度、权限与共享时限，逐轮记账", () => {
  const output = python(WORKER_FIXTURE + `f=exercise([red,green],elapsed=7)
assert f.result=='done' and len(f.calls)==2,(f.result,f.calls,f.deliveries)
for key in ('run','attempt','session','model','effort','tools','auth','deadline'):
 assert f.calls[0][key]==f.calls[1][key],(key,f.calls)
assert f.calls[1]['remaining']==f.calls[0]['remaining']-7,f.calls
assert all('/attempt' not in path for _,path,_ in f.requests),f.requests
assert len(f.rows)==2 and [row['phase'] for row in f.rows]==['initial','repair'],f.rows
assert [row['round'] for row in f.rows]==[1,2] and all(row['attempt']==9 for row in f.rows),f.rows
assert [row['reason'] for row in f.rows]==['test_failure','passed'],f.rows
assert f.rows[1]['in'] is None and f.rows[1]['out'] is None,f.rows
summary=w.fmt_acct(f.rows)
assert '尝试 1 次' in summary and '执行 2 轮' in summary and '待核实' in summary,summary
prompt=f.calls[1]['prompt'] or ''
assert 'AssertionError' in prompt and '不得重堆的任务背景' not in prompt,prompt
logs=sorted(pathlib.Path(w.DATA).rglob('*.log'))
assert len(logs)==2 and logs[0].read_text(encoding='utf-8')==red['out'] and logs[1].read_text(encoding='utf-8')==green['out'],logs
assert logs[0].parent.name==f.t['run_id'],logs
print('本地桩首轮红：'+logs[0].read_text(encoding='utf-8'))
print('本地桩原会话续修绿：'+logs[1].read_text(encoding='utf-8'))
print('实际计数：1 attempt / 2 rounds / 2 ledger rows / 0 new attempts')
`);
  console.log(output.trim());
});

test("旧授权只有首轮，环境异常和模型卡住不追加，次数耗尽转等待", () => {
  python(WORKER_FIXTURE + `old=exercise([red],policy=False)
assert old.result=='wait' and len(old.calls)==1,(old.result,old.calls)
for output in ('ModuleNotFoundError: fixture','0 PASS / 1 FAIL TypeError: fixture','timeout', 'EADDRINUSE'):
 env=exercise([{'ok':False,'out':output}])
 assert env.result=='wait' and len(env.calls)==1,(output,env.calls)
blocked=exercise([red],tail='我已卡住，需要人工处理')
assert blocked.result=='wait' and len(blocked.calls)==1,(blocked.result,blocked.calls)
maximum=exercise([red],rounds=3)
assert maximum.result=='wait' and len(maximum.calls)==3,(maximum.result,maximum.calls)
assert len(maximum.rows)==3 and {row['attempt'] for row in maximum.rows}=={9},maximum.rows
`);
});

test("续修前失租或共享截止耗尽立即停，API通道保留单轮", () => {
  python(WORKER_FIXTURE + `lost=exercise([red,green],lost='lease')
assert lost.result=='wait' and len(lost.calls)==1,(lost.result,lost.calls)
changed=exercise([red,green],identity_changed=True)
assert changed.result=='wait' and len(changed.calls)==1,(changed.result,changed.calls)
expired=exercise([red,green],elapsed=61)
assert expired.result=='wait' and len(expired.calls)==1,(expired.result,expired.calls)
api=exercise([red,green],api=True)
assert api.result=='wait' and len(api.calls)==1,(api.result,api.calls)
`);
});

test("进程启动记录被拒即终止，续接通信只获得原deadline的剩余秒数", () => {
  python(`import worker_loop as w
w.PROFILE_MODE=False; w.TIMEOUT=60
clock=iter([100.0,100.0,102.0]); w.time.monotonic=lambda:next(clock)
seen=[]
class Process:
 pid=123; returncode=0
 def __enter__(self): return self
 def __exit__(self,*args): return False
 def communicate(self,input=None,timeout=None): seen.append(('communicate',timeout)); return '桩输出',''
 def kill(self): seen.append(('kill',None))
w.record_process_started=lambda *args,**kwargs:True
w.run_task_process({'_attempt_deadline':110.0},'fixture',1,'codex','fixture-model','high',['本地桩'],{},_popen=lambda *args,**kwargs:Process())
assert seen==[('communicate',8.0)],seen
seen.clear(); w.time.monotonic=lambda:100.0
w.record_process_started=lambda *args,**kwargs:False
try: w.run_task_process({},'fixture',1,'codex','fixture-model','high',['本地桩'],{},_popen=lambda *args,**kwargs:Process())
except RuntimeError as error: assert 'PROCESS_START_RECORD_REJECTED' in str(error),error
else: raise AssertionError('启动记录被拒后仍继续运行')
assert seen==[('kill',None),('communicate',None)],seen
seen.clear(); w.time.monotonic=lambda:111.0
try: w.run_task_process({'_attempt_deadline':110.0},'fixture',1,'codex','fixture-model','high',['本地桩'],{},_popen=lambda *args,**kwargs:seen.append('不得创建进程'))
except w.subprocess.TimeoutExpired: pass
else: raise AssertionError('准备阶段耗尽时限后仍追加调用')
assert seen==[],seen
`);
});

test("Codex首轮与明确UUID续接保留原沙箱、审批、认证和参数层级", () => {
  python(`import codex_runtime as c
sid='01a00000-0000-7000-8000-000000000000'
for mode in ('write','read-only'):
 first=c.session_argv('fixture-codex.exe','fixture-model','high','last.txt','工作仓',mode=mode)
 resumed=c.session_argv('fixture-codex.exe','fixture-model','high','last.txt','工作仓',mode=mode,thread_id=sid)
 for args in (first,resumed):
  command=args.index('exec')
  assert '-c' not in args[command+1:] and '-C' not in args[command+1:],args
  assert args[args.index('-C')+1]=='工作仓' and args.index('-C')<command,args
  assert '--ephemeral' not in args and '--last' not in args and '--approve-for-me' not in args,args
  for setting in ('windows.sandbox="unelevated"','forced_login_method="chatgpt"','model_reasoning_effort="high"'):
   assert setting in args[:command],args
  if mode=='write':
   assert 'sandbox_mode="workspace-write"' in args and 'approval_policy="on-request"' in args,args
   assert 'approvals_reviewer="auto_review"' in args and 'approval_policy="never"' not in args,args
  else:
   assert 'sandbox_mode="read-only"' in args and 'approval_policy="never"' in args,args
  assert args[args.index('-m')+1]=='fixture-model' and args[-1]=='-',args
 assert 'resume' not in first and resumed[resumed.index('resume')+1]==sid,resumed
 assert first[:first.index('exec')]==resumed[:resumed.index('exec')],(first,resumed)
try: c.session_argv('fixture','fixture','high','last','work',thread_id='--last')
except ValueError: pass
else: raise AssertionError('续接接受了含糊会话标识')
source={'CODEX_HOME':str(folder/'原认证目录'),'OPENAI_API_KEY':'fixture-hidden','WORKER_BOARD_TOKEN':'fixture-hidden'}
for _ in range(2):
 child=c.subscription_environment(source)
 assert child.get('CODEX_HOME')==source['CODEX_HOME'] and 'OPENAI_API_KEY' not in child and 'WORKER_BOARD_TOKEN' not in child,child
last=folder/'结果.txt'; last.write_text('完成',encoding='utf-8')
partial=c.judge(0,json.dumps({'type':'turn.completed','usage':{'input_tokens':7,'cached_input_tokens':0}}),str(last))
assert partial['usage']['in']==7 and partial['usage']['cr']==0,partial
assert partial['usage']['out'] is None and partial['usage']['cc'] is None,partial
`);
});

test("实际CLI组装入口的两轮只续接原UUID，保留模型、权限与认证目录", () => {
  python(`import worker_loop as w
w.PROFILE_MODE=False; w.API_MODE=False; w.TOOL_PROFILE='read-only'
w.MODEL='fixture-model'; w.EFFORT='high'; w.CLAUDE=['fixture-claude.exe']
w.build_prompt=lambda *args:'首轮任务'; w.session_args=lambda:[]; w.SESSION=None; w.FORKED_SID=None
w.codex_gate=lambda:None; w.codex_runtime.subscription_login_gate=lambda *args,**kwargs:None
w.os.environ['CODEX_HOME']=str(folder/'原Codex认证'); w.os.environ['CLAUDE_CONFIG_DIR']=str(folder/'原Claude认证')
sid=str(uuid.uuid4()); seen=[]
def process(task,worker,attempt,runtime,model,effort,argv,env,**kwargs):
 seen.append((runtime,attempt,model,effort,list(argv),env.get('CODEX_HOME'),env.get('CLAUDE_CONFIG_DIR')))
 if runtime=='codex':
  pathlib.Path(argv[argv.index('-o')+1]).write_text('本轮交付',encoding='utf-8')
  stdout=chr(10).join([json.dumps({'type':'thread.started','thread_id':sid}),json.dumps({'type':'turn.completed','usage':{'input_tokens':3,'output_tokens':1,'cached_input_tokens':0,'cache_write_input_tokens':0}})])
 else: stdout='本轮完成'
 return w.subprocess.CompletedProcess(argv,0,stdout,'')
w.run_task_process=process
for runtime in ('codex','claude'):
 w.RUNTIME=runtime; seen.clear()
 task={'id':7,'run_id':str(uuid.uuid4()),'_repair_context':{}}
 first=folder/(runtime+'首轮.md'); second=folder/(runtime+'续轮.md')
 assert w.run_worker(task,'fixture',str(first),None,1,w.MODEL,w.EFFORT)[0]==0
 fixed=task['_repair_context']['session_id']; task['_repair_context']['prompt']='本轮失败结果'
 assert w.run_worker(task,'fixture',str(second),None,1,w.MODEL,w.EFFORT)[0]==0
 assert len(seen)==2 and seen[0][:4]==seen[1][:4] and seen[0][5:]==seen[1][5:],seen
 first_args,second_args=seen[0][4],seen[1][4]
 if runtime=='codex':
  assert fixed==sid and 'resume' not in first_args and second_args[second_args.index('resume')+1]==sid,seen
 else:
  assert first_args[first_args.index('--session-id')+1]==fixed and second_args[second_args.index('--resume')+1]==fixed,seen
  for flag in ('--permission-mode','--tools','--allowedTools','--disallowedTools'):
   assert flag in first_args and flag in second_args,seen
 assert '--last' not in second_args and task['_repair_context']['session_id']==fixed,seen
`);
});

test("放行事件与运行策略冻结轮数，历史和旧客户端缺确认保持单轮", () => {
  const db = new DatabaseSync(":memory:");
  try {
    store.migrate(db);
    const old = store.add(db, { subject: "旧授权夹具" });
    assert.deepEqual(store.taskVerificationRepair(db, store.get(db, old)), { max_rounds: 1, legacy_retry: false });
    const id = store.add(db, { subject: "新授权夹具", released: 0 });
    store.setReleased(db, { id, released: true, expectedVersion: store.get(db, id).aggregate_version,
      verificationRepair: { max_rounds: 3, legacy_retry: false } });
    const fixed = store.taskVerificationRepair(db, store.get(db, id));
    assert.deepEqual(fixed, { max_rounds: 3, legacy_retry: false });
    const release = store.events(db, { taskId: id }).find(event => event.kind === "release");
    assert.deepEqual(release.detail.verification_repair, fixed);
    const claimed = store.claimById(db, { id, worker: "fixture", runContextForTask: task =>
      ({ verification_repair: store.taskVerificationRepair(db, task, { fromRun: false }) }) });
    assert.equal(claimed.ok, true);
    assert.deepEqual(store.runs(db, id)[0].policy.context.verification_repair, fixed);
    assert.deepEqual(store.taskVerificationRepair(db, store.get(db, id)), fixed);
    assert.throws(() => db.exec("UPDATE task_runs SET policy_json='{}'"), /immutable/);
    const single = store.add(db, { subject: "旧客户端夹具", released: 0 });
    store.setReleased(db, { id: single, released: true, expectedVersion: store.get(db, single).aggregate_version });
    assert.deepEqual(store.taskVerificationRepair(db, store.get(db, single)), { max_rounds: 1, legacy_retry: false });
  } finally { db.close(); }
});
