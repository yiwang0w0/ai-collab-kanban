import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 模型、登记验证与提交均用函数桩；HTTP 用例只连接本测试新建的临时看板。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TMP = realpathSync.native(mkdtempSync(join(tmpdir(), "kanban-evidence-")));
const PY = HOST_ENV.PYTHON || "python";
const store = createRequire(import.meta.url)("../core/store.js");
let serial = 0;
after(() => {
  const inside = relative(realpathSync.native(tmpdir()), realpathSync.native(TMP));
  assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
  rmSync(TMP, { recursive: true, force: true });
});

function python(source, overrides = {}) {
  const directory = join(TMP, String(++serial)); mkdirSync(directory);
  const clean = Object.fromEntries(Object.entries(HOST_ENV).filter(([key]) =>
    !/^(?:BOARD_|WORKER_|REVIEWER_|REVIEW_|KANBAN_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_CONFIG_DIR$)/i.test(key)));
  const result = spawnSync(PY, ["-I", "-B", "-X", "utf8", "-", ROOT, directory], {
    cwd: ROOT, windowsHide: true, encoding: "utf8", timeout: 15000,
    env: { ...clean, BOARD_CONFIG: join(directory, "missing-config.json"), BOARD_REPO: directory,
      BOARD_DATA_DIR: directory, BOARD_VERIFY_REGISTRY: join(directory, "missing-registry.json"),
      WORKER_RUNTIME: "codex", WORKER_MODEL: "fixture-model", WORKER_EFFORT: "high",
      PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", ...overrides },
    input: "import sys,pathlib,json,uuid,types,threading\n" +
      "sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))\nfolder=pathlib.Path(sys.argv[2])\n" + source,
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  return result.stdout;
}

const BODY = "# 给人看的结果\n完成本地桩修改。\n无需人工操作。\n# 改动\ncore/demo.py:12-14 修复夹具。\n# 检查\nfixture-check -> pass 2 / fail 0\n# 未决\n无\n";
const FIXTURE = `import worker_loop as w
import evidence_contract as e
body=${JSON.stringify(BODY)}
w.API_MODE=False; w.PROFILE_MODE=False; w.RUNTIME='codex'; w.MODEL='fixture-model'; w.EFFORT='high'
w.TOOL_PROFILE='read-only'; w.TIMEOUT=60; w.log=lambda *args,**kwargs:None
w.gates_lib.append_spend=lambda *args,**kwargs:None
w.harvest_spawned=lambda *args,**kwargs:([], '')
w.usage_of=lambda *args,**kwargs:{'calls':None,'in':None,'cc':None,'cr':None,'out':None,'note':'未知供应商用量'}
class Heartbeat:
 def __init__(self,*args): self.stop=threading.Event(); self.beats=0
 def start(self): pass
w.Heartbeat=Heartbeat

def exercise(bodies, *, rounds=3, limit=4000, contract=True, api=False, elapsed=3, checks=None, appendix=''):
 case=folder/str(uuid.uuid4()); case.mkdir()
 w.DATA=str(case); w.EVID=str(case/'evidence'); w.LEDGER=str(case/'ledger.jsonl')
 w.API_MODE=api; w.PROFILE_MODE=False
 w.os.environ['CODEX_HOME']=str(case/'原认证目录')
 clock=[1000.0]; w.time.monotonic=lambda:clock[0]
 repair={'max_rounds':rounds,'legacy_retry':False}
 if contract: repair['evidence_contract']={'version':1,'max_chars':limit}
 task={'id':7,'run_id':str(uuid.uuid4()),'attempts':9,'verify_cmd':'fixture-check','subject':'不得重堆的卡背景',
       'verification_repair':repair,'status':'in_progress','worker':'fixture','lease_until':9999999999999}
 calls=[]; verifies=[]; commits=[]; deliveries=[]; requests=[]; sid=str(uuid.uuid4())
 def call(method,path,payload=None,**kwargs):
  requests.append((method,path))
  if method=='GET' and path.endswith('/runs'):
   return 200,{'runs':[{'run_id':task['run_id'],'state':'running','worker':'fixture','runtime':'codex',
     'last_attempt':9,'agent_instance_id':w.AGENT_INSTANCE_ID}]}
  if method=='GET': return 200,{'task':task}
  raise AssertionError('不应新增attempt或其他写请求:'+path)
 w.call=call
 def model(t,worker,path,previous,attempt,model,effort):
  context=t['_repair_context']
  if calls: assert context.get('session_id')==sid,context
  context['session_id']=sid
  text=bodies[min(len(calls),len(bodies)-1)]
  calls.append({'run':t['run_id'],'attempt':attempt,'sid':sid,'model':model,'effort':effort,
    'auth':w.os.environ.get('CODEX_HOME'),'deadline':t['_attempt_deadline'],
    'remaining':t['_attempt_deadline']-clock[0],'prompt':context.get('prompt'),'path':path,'body':text})
  pathlib.Path(path).write_text(text,encoding='utf-8',newline='')
  clock[0]+=elapsed
  return 0,'本轮完成'
 w.run_worker=model
 def verify(t):
  assert len(calls)>0
  verifies.append(len(calls))
  value=(checks or [{'ok':True,'rc':0,'out':'PASS 本地验证'}])[min(len(verifies)-1,len(checks or [1])-1)]
  return {'key':'fixture-check','cmd':'本地验证桩','registry_sha256':'a'*64,**value}
 w.run_verify=verify
 def commit(t,text,path,vr,rc):
  assert vr and vr['ok'] and rc==0
  assert e.validate(pathlib.Path(path).read_text(encoding='utf-8'),e.for_task(t))['ok']
  commits.append((len(calls),len(verifies))); return text+appendix
 w.host_delivery=commit
 def deliver(*args,**kwargs): deliveries.append((args,kwargs)); return True
 w.deliver=deliver
 result=w.handle(task,'fixture')
 rows=[json.loads(line) for line in pathlib.Path(w.LEDGER).read_text(encoding='utf-8').splitlines()]
 return types.SimpleNamespace(result=result,task=task,calls=calls,verifies=verifies,commits=commits,deliveries=deliveries,requests=requests,rows=rows)
`;

test("正文固定四节、人看最多三行，格式错误与内联长输出明确拒收", () => {
  python(`import evidence_contract as e
body=${JSON.stringify(BODY)}
contract={'version':1,'max_chars':4000}
assert e.validate(body,contract)['ok']
for invalid in [body.replace('无需人工操作。','第二行\\n第三行\\n第四行'),body.replace('# 检查','# 背景'),
 '先说明过程\\n'+body,body.replace('core/demo.py:12-14 修复夹具。','改了一个文件'),
 body.replace('fixture-check -> pass 2 / fail 0','检查通过'),body.replace('# 未决\\n无','# 未决\\n')]:
 assert not e.validate(invalid,contract)['ok'],invalid
assert not e.validate(body.replace('无\\n','\\x60\\x60\\x60长输出\\n'),contract)['ok']
assert e.for_task({'verification_repair':{'max_rounds':3}}) is None
assert not e.validate(body.replace('pass 2 / fail 0','pass 2 / fail 0 '+('内联输出'*200)),contract)['ok']
assert e.validate(body.replace('pass 2 / fail 0','pass 2 / fail 0；日志: 本run.log（2048 UTF-8 bytes）'),contract)['ok']
assert e.validate('历史散文证据',None)['ok']
import worker_loop as w
w.API_MODE=False; w.TOOL_PROFILE='write'; w.RUNTIME='claude'
claude=chr(10).join(w.delivery_block('C:/fixture/证据.md',contract))
assert '用 Write' in claude and '最终回复' not in claude,claude
w.RUNTIME='codex'
codex=chr(10).join(w.delivery_block('C:/fixture/证据.md',contract))
assert '若沙箱拒写则作为最终回复' in codex,codex
w.TOOL_PROFILE='read-only'
assert '作为最终中文回复' in chr(10).join(w.delivery_block('C:/fixture/证据.md',contract))
`);
  assert.equal(store.resultSummaryOf(BODY), "完成本地桩修改。\n无需人工操作。");
});

test("中文与emoji按Unicode码点计数，4000边界与UTF-8字节在JS/Python一致", () => {
  const chars = Array.from(BODY).length;
  const exact = BODY + "🙂".repeat(4000 - chars);
  const measured = JSON.parse(python(`import evidence_contract as e
text=${JSON.stringify(exact)}
contract={'version':1,'max_chars':4000}
assert e.validate(text,contract)['ok']
assert not e.validate(text+'🙂',contract)['ok']
print(json.dumps(e.measure(text)))
`).trim());
  assert.deepEqual(measured, { chars: Array.from(exact).length, bytes: Buffer.byteLength(exact, "utf8") });
  assert.equal(measured.chars, 4000);
  assert.ok(measured.bytes > measured.chars);
});

test("超限原文保留，同UUID同attempt精简后才验证与提交，共享原轮数和时限", () => {
  const output = python(FIXTURE + `large=body+'🙂'*4000
f=exercise([large,body])
assert f.result=='done' and len(f.calls)==2 and f.verifies==[2] and f.commits==[(2,1)],(f.result,f.verifies,f.commits)
for key in ('run','attempt','sid','model','effort','auth','deadline'):
 assert f.calls[0][key]==f.calls[1][key],(key,f.calls)
assert f.calls[1]['remaining']==f.calls[0]['remaining']-3,f.calls
assert pathlib.Path(f.calls[0]['path']).read_text(encoding='utf-8')==large
assert pathlib.Path(f.calls[1]['path']).read_text(encoding='utf-8')==body
assert len(f.rows)==2 and f.rows[0]['reason']=='evidence_contract' and f.rows[1]['reason']=='passed',f.rows
assert f.rows[0]['evidence_chars']==len(large) and f.rows[0]['evidence_bytes']==len(large.encode('utf-8')),f.rows
assert f.rows[1]['evidence_chars']==len(body) and f.rows[1]['evidence_bytes']==len(body.encode('utf-8')),f.rows
assert f.rows[0]['in'] is None and f.rows[0]['out'] is None,f.rows
assert '拒收' in f.calls[1]['prompt'] and f.calls[0]['path'] in f.calls[1]['prompt'],f.calls
assert '不得重堆的卡背景' not in f.calls[1]['prompt'],f.calls
assert all('/attempt' not in path for _,path in f.requests),f.requests
print('首轮拒收：'+str(len(large))+' Unicode 字符；原文逐字保留。')
print('同 UUID 精简绿：2 轮模型函数桩 / 1 次验证 / 1 次提交函数桩 / 0 次新增 attempt。')
`);
  console.log(output.trim());
});

test("证据精简与验证续修共享总轮数；API、截止耗尽和次数尽均不另开会话", () => {
  python(FIXTURE + `red={'ok':False,'rc':1,'out':'AssertionError: 本地红'}
green={'ok':True,'rc':0,'out':'PASS 本地绿'}
f=exercise([body+'x'*4000,body,body],checks=[red,green])
assert f.result=='done' and len(f.calls)==3 and f.verifies==[2,3] and f.commits==[(3,2)],(f.result,f.verifies,f.commits)
limited=exercise([body+'x'*4000,body],rounds=2,checks=[red,green])
assert limited.result=='wait' and len(limited.calls)==2 and limited.verifies==[2] and limited.commits==[],limited
api=exercise([body+'x'*4000,body],api=True)
assert api.result=='wait' and len(api.calls)==1 and api.verifies==[] and api.commits==[],api
expired=exercise([body+'x'*4000,body],elapsed=61)
assert expired.result=='wait' and len(expired.calls)==1 and expired.verifies==[],expired
`);
});

test("旧证据保持可读，宿主长日志与提交附录不计入正文上限且不重复验证", () => {
  python(FIXTURE + `legacy=exercise(['旧散文证据，不改历史。'],contract=False)
assert legacy.result=='done' and legacy.verifies==[1] and legacy.commits==[(1,1)],legacy
full='本地长日志🙂'*2000
f=exercise([body],limit=len(body),checks=[{'ok':True,'rc':0,'out':full[-4000:],'full_out':full}],appendix='\\n宿主提交SHA附录\\n'+'a'*9000)
assert f.result=='done' and len(f.calls)==len(f.verifies)==len(f.commits)==1,f
assert f.rows[0]['evidence_chars']==len(body) and f.rows[0]['evidence_bytes']==len(body.encode('utf-8')),f.rows
logs=list(pathlib.Path(w.EVID).rglob('*.log')); assert len(logs)==1,logs
log=logs[0]; assert log.read_text(encoding='utf-8')==full
report=f.deliveries[0][0][3]
assert str(log) in report and str(log.stat().st_size) in report,report
assert full[:3000] not in report and '宿主提交SHA附录' in report,report
assert pathlib.Path(f.calls[0]['path']).read_text(encoding='utf-8')==body
`);
});

test("实际提示词按原Unicode字符与UTF-8字节记账，供应商tokens缺失保持未知", () => {
  python(`import worker_loop as w
import evidence_contract as e
prompt='中文🙂提示词\\r\\n第二行。'; body=${JSON.stringify(BODY)}
w.PROFILE_MODE=False; w.API_MODE=False; w.TOOL_PROFILE='read-only'
w.MODEL='fixture-model'; w.EFFORT='high'; w.CLAUDE=['fixture-claude.exe']
w.SESSION=None; w.FORKED_SID=None; w.session_args=lambda:[]
w.build_prompt=lambda *args:prompt
w.codex_gate=lambda:None; w.codex_runtime.subscription_login_gate=lambda *args,**kwargs:None
w.os.environ['CODEX_HOME']=str(folder/'原Codex认证')
w.os.environ['CLAUDE_CONFIG_DIR']=str(folder/'原Claude认证')
w.usage_of=lambda *args,**kwargs:{'calls':None,'in':None,'cc':None,'cr':None,'out':None}
sid=str(uuid.uuid4()); seen=[]
def process(task,worker,attempt,runtime,model,effort,argv,env,**kwargs):
 sent=kwargs.get('input') if runtime=='codex' else argv[argv.index('-p')+1]
 assert sent==prompt,sent; seen.append(runtime)
 if runtime=='codex':
  pathlib.Path(argv[argv.index('-o')+1]).write_text(body,encoding='utf-8')
  output=chr(10).join([json.dumps({'type':'thread.started','thread_id':sid}),json.dumps({'type':'turn.completed','usage':{'input_tokens':123,'output_tokens':2}})])
 else: output='本轮完成'
 return w.subprocess.CompletedProcess(argv,0,output,'')
w.run_task_process=process
for runtime in ('codex','claude'):
 w.RUNTIME=runtime; w.LEDGER=str(folder/(runtime+'-ledger.jsonl'))
 task={'id':7,'run_id':str(uuid.uuid4()),'_repair_context':{},'_evidence_measurement':e.measure(body)}
 assert w.run_worker(task,'fixture',str(folder/(runtime+'-evidence.md')),None,1,w.MODEL,w.EFFORT)[0]==0
 row=w.acct_attempt(task,'fixture',1,w.MODEL,w.EFFORT)
 assert row['prompt_chars']==len(prompt) and row['prompt_bytes']==len(prompt.encode('utf-8')),row
 assert row['evidence_chars']==len(body) and row['evidence_bytes']==len(body.encode('utf-8')),row
 if runtime=='codex': assert row['in']==123 and row['out']==2 and row['cr'] is None and row['cc'] is None,row
 else: assert row['in'] is None and row['out'] is None,row
assert seen==['codex','claude'],seen
`);
});

test("临时假板一张桩卡完整领取和回报，模型正文在冻结上限内", async () => {
  const directory = join(TMP, "http"); mkdirSync(directory);
  const listener = createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [join(ROOT, "core/server.mjs")], {
    cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...HOST_ENV, BOARD_CONFIG: join(directory, "missing-config.json"), BOARD_REPO: directory,
      BOARD_DATA_DIR: directory, BOARD_DB: join(directory, "board.db"), BOARD_PORT: String(port),
      BOARD_ALLOW_UNPINNED: "1", BOARD_NO_RESTORE: "1", BOARD_EVIDENCE_MAX_CHARS: "4000" },
  });
  let out = ""; proc.stdout.on("data", data => out += data); proc.stderr.on("data", data => out += data);
  try {
    let ready = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && proc.exitCode === null) {
      try { if ((await fetch(base + "/health", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, out);
    const token = readFileSync(join(directory, "board_token"), "utf8").trim();
    async function api(method, path, body) {
      const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Board-Token": token },
        ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) });
      return { status: response.status, body: await response.json() };
    }
    const created = await api("POST", "/api/tasks", { subject: "四节短证据本地桩", line: "alpha", released: 0 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const task = created.body.task;
    assert.deepEqual(task.verification_repair.evidence_contract, { version: 1, max_chars: 4000 });
    const released = await api("POST", `/api/tasks/${task.id}/release`, { released: true, expected_version: task.aggregate_version,
      confirm_verification_repair_digest: task.verification_repair_digest });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    const output = python(`import worker_loop as w
w.log=lambda *args,**kwargs:None; w.gates_lib.append_spend=lambda *args,**kwargs:None
w.harvest_spawned=lambda *args,**kwargs:([], '')
status,picked=w.call('POST','/api/claim',{'worker':'fixture','line':'alpha','worker_protocol_version':2,'agent_instance_id':w.AGENT_INSTANCE_ID})
assert status==200,(status,picked)
t=picked['task']; assert t['id']==${task.id}
assert t['verification_repair']['evidence_contract']=={'version':1,'max_chars':4000}
def model(task,worker,path,*args):
 task['_repair_context']['session_id']=str(uuid.uuid4())
 pathlib.Path(path).write_text(${JSON.stringify(BODY)},encoding='utf-8',newline='')
 return 0,'完成'
w.run_worker=model
w.run_verify=lambda task:{'ok':True,'key':'fixture-check','cmd':'函数桩','rc':0,'out':'PASS 本地函数桩'}
assert w.handle(t,'fixture')=='done'
print('原卡完整回报：1 次模型函数桩，正文 '+str(len(${JSON.stringify(BODY)}))+' Unicode 字符。')
`, { BOARD_URL: base, BOARD_DATA_DIR: directory, BOARD_REPO: directory });
    const reported = await api("GET", `/api/tasks/${task.id}`);
    assert.equal(reported.body.task.status, "waiting");
    assert.equal(reported.body.task.waiting_for, "review");
    assert.equal(reported.body.task.attempts, 1);
    assert.equal(reported.body.task.result_summary, "完成本地桩修改。\n无需人工操作。");
    assert.ok(reported.body.task.result.startsWith(BODY));
    assert.ok(Array.from(BODY).length <= task.verification_repair.evidence_contract.max_chars);
    assert.ok(Array.from(reported.body.task.result).length <= task.verification_repair.evidence_contract.max_chars,
      "这张完整桩卡回报（含简短宿主附录）也在4000字符内");
    console.log(output.trim());
  } finally {
    if (proc.exitCode === null) {
      const ended = new Promise(resolve => proc.once("exit", resolve)); proc.kill(); await ended;
    }
  }
});
