import { harnessEnvironment } from "./harness-env.mjs";
const HOST_ENV = harnessEnvironment();
// 真实 Git 只操作本测试的临时仓；模型、看板领取与验证都使用本地函数桩。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TMP = realpathSync.native(mkdtempSync(join(tmpdir(), "kanban-host-commit-")));
const PY = HOST_ENV.PYTHON || "python";
let serial = 0;
after(() => {
  const inside = relative(realpathSync.native(tmpdir()), realpathSync.native(TMP));
  assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside));
  rmSync(TMP, { recursive: true, force: true });
});
function python(source) {
  const directory = join(TMP, String(++serial)); mkdirSync(directory);
  const clean = Object.fromEntries(Object.entries(HOST_ENV).filter(([key]) =>
    !/^(?:BOARD_|WORKER_|REVIEWER_|REVIEW_|KANBAN_|GIT_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_CONFIG_DIR$)/i.test(key)));
  const result = spawnSync(PY, ["-I", "-B", "-X", "utf8", "-", ROOT, directory], {
    cwd: ROOT, windowsHide: true, encoding: "utf8", timeout: 30000,
    env: { ...clean, BOARD_CONFIG: join(directory, "missing-config.json"), BOARD_REPO: directory,
      BOARD_DATA_DIR: join(directory, "data"), BOARD_VERIFY_REGISTRY: join(directory, "missing-registry.json"),
      WORKER_RUNTIME: "claude", WORKER_MODEL: "fixture-model", WORKER_EFFORT: "high",
      PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
    input: `import sys,pathlib,json,uuid,types,threading,subprocess,os,shutil
sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'loops'))
folder=pathlib.Path(sys.argv[2]); home=folder/'home'; home.mkdir()
os.environ['HOME']=str(home); os.environ['USERPROFILE']=str(home); os.environ['XDG_CONFIG_HOME']=str(home/'xdg')
import host_git_commit as h
git=shutil.which('git'); assert git
def g(repo,*args):
 result=subprocess.run([git,*args],cwd=repo,capture_output=True,check=True)
 return result.stdout.decode('utf-8').strip()
def setup():
 repo=folder/str(uuid.uuid4()); repo.mkdir()
 g(repo,'-c','init.defaultBranch=main','init')
 g(repo,'config','user.name','本地夹具'); g(repo,'config','user.email','fixture@example.invalid')
 (repo/'one.txt').write_text('初始\\n',encoding='utf-8'); (repo/'two.txt').write_text('保留\\n',encoding='utf-8')
 g(repo,'add','--','one.txt','two.txt'); g(repo,'commit','-m','本地夹具基线')
 return repo
def evidence():
 path=folder/(str(uuid.uuid4())+'.md'); path.write_text('模型已写证据',encoding='utf-8'); return str(path)
def refused(action):
 try: action()
 except h.HostCommitError: pass
 else: raise AssertionError('本应拒绝却继续')
` + source,
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  return result.stdout;
}

const WORKER = `import worker_loop as w
w.API_MODE=False; w.PROFILE_MODE=False; w.RUNTIME='claude'; w.MODEL='fixture-model'; w.EFFORT='high'
w.ROLE_KIND='implement'; w.TOOL_PROFILE='write'; w.TIMEOUT=60; w.REPO=str(repo)
w.DATA=str(folder/'data'); w.EVID=str(folder/'data'/'evidence'); w.LEDGER=str(folder/'ledger.jsonl')
w.log=lambda *args,**kwargs:None; w.gates_lib.append_spend=lambda *args,**kwargs:None
w.harvest_spawned=lambda *args,**kwargs:([], ''); w.stash_spawn=lambda *args,**kwargs:''
w.acct_attempt=lambda *args,**kwargs:{'calls':None,'in':None,'cc':None,'cr':None,'out':None}
w.fmt_acct=lambda rows:'本地桩未知用量'
class Heartbeat:
 def __init__(self,*args): self.stop=threading.Event(); self.beats=0
 def start(self): pass
w.Heartbeat=Heartbeat
claims=[]; deliveries=[]; models=[]; verifies=[]
def call(method,path,body=None,**kwargs):
 assert method=='POST' and path=='/api/claim',(method,path)
 claims.append(body)
 return 200,{'task':{'id':len(claims),'subject':'同文件逐卡提交','run_id':str(uuid.uuid4()),'attempts':1,'verify_cmd':'fixture-check'}}
w.call=call
def deliver(*args,**kwargs): deliveries.append((args,kwargs)); return True
w.deliver=deliver
def model(task,worker,path,prev,attempt,model,effort):
 models.append(task['id']); (repo/'one.txt').write_text('第'+str(task['id'])+'卡\\n',encoding='utf-8')
 pathlib.Path(path).write_text('模型交付证据',encoding='utf-8')
 return 0,'完成'
w.run_worker=model
def verify(task):
 verifies.append(task['id']); return {'key':'fixture-check','ok':True,'rc':0,'out':'PASS 本地验证'}
w.run_verify=verify
os.environ['WORKER_HOST_COMMIT']='1'
`;

test("脏工作仓和已有暂存均零领取，失败不清理现场", () => {
  python(`repo=setup()
` + WORKER + `
(repo/'one.txt').write_text('人工未提交',encoding='utf-8')
refused(lambda:w.claim_task('第一线','alpha','default'))
assert claims==[] and (repo/'one.txt').read_text(encoding='utf-8')=='人工未提交'
g(repo,'add','--','one.txt')
before=(repo/'.git'/'index').read_bytes()
refused(lambda:w.claim_task('第一线','alpha','default'))
assert claims==[] and (repo/'.git'/'index').read_bytes()==before
`);
});

test("两张假卡修改同文件，两个普通提交且原卡证据携带各自 SHA", () => {
  const output = python(`repo=setup()
` + WORKER + `
baseline=g(repo,'rev-parse','HEAD')
for number in (1,2):
 status,body=w.claim_task('第一线','alpha','default'); task=body['task']
 assert status==200 and w.handle(task,'第一线')=='done'
 sha=g(repo,'rev-parse','HEAD'); assert sha in deliveries[-1][0][3],deliveries
 assert g(repo,'log','-1','--format=%s')=='#'+str(number)+' 同文件逐卡提交'
 assert g(repo,'show','--format=','--name-only','HEAD')=='one.txt'
 task['_host_commit_guard'].release()
assert g(repo,'rev-list','--count',baseline+'..HEAD')=='2'
assert len(models)==len(verifies)==len(deliveries)==2
print('两卡同文件：2 次模型桩、2 次验证、2 个普通提交、2 份原卡 SHA')
`);
  console.log(output.trim());
});

test("验证失败与只读交付均零提交，失败保留文件和占用", () => {
  python(`repo=setup()
` + WORKER + `
baseline=g(repo,'rev-parse','HEAD')
w.run_verify=lambda task:{'key':'fixture-check','ok':False,'rc':1,'out':'AssertionError: 夹具红'}
_,body=w.claim_task('第一线','alpha','default'); task=body['task']
assert w.handle(task,'第一线')=='wait' and g(repo,'rev-parse','HEAD')==baseline
assert (repo/'one.txt').read_text(encoding='utf-8')=='第1卡\\n'
refused(lambda:h.HostCommitGuard(str(repo),'第二线').acquire())
repo=setup(); w.REPO=str(repo); w.TOOL_PROFILE='read-only'
def readonly(*args): pathlib.Path(args[2]).write_text('只读审阅',encoding='utf-8'); return 0,'完成'
w.run_worker=readonly; w.run_verify=verify
baseline=g(repo,'rev-parse','HEAD'); _,body=w.claim_task('只读线','alpha','default')
assert '_host_commit_guard' not in body['task'] and w.handle(body['task'],'只读线')=='done'
assert g(repo,'rev-parse','HEAD')==baseline
`);
});

test("原会话先红后绿只在最后成功验证后创建一次提交", () => {
  const output = python(`repo=setup()
` + WORKER + `
baseline=g(repo,'rev-parse','HEAD'); original_model=w.run_worker
def repair(task,*args):
 assert g(repo,'rev-parse','HEAD')==baseline,'验证红后提前提交'
 task['_repair_context']['session_id']='fixture-session'
 return original_model(task,*args)
w.run_worker=repair; w.current_repair_run=lambda *args:True
def red_green(task):
 verifies.append(task['id']); passed=len(verifies)==2
 return {'key':'fixture-check','ok':passed,'rc':0 if passed else 1,'out':'PASS 本地验证' if passed else 'AssertionError: 第一轮红'}
w.run_verify=red_green
_,body=w.claim_task('第一线','alpha','default'); task=body['task']; task['verification_repair']={'max_rounds':3}
assert w.handle(task,'第一线')=='done'
assert len(models)==len(verifies)==2 and len(claims)==len(deliveries)==1
assert g(repo,'rev-list','--count',baseline+'..HEAD')=='1'
task['_host_commit_guard'].release()
print('红到绿：同一 attempt 两轮验证，红后 0 提交，绿后 1 个提交')
`);
  console.log(output.trim());
});

test("未登记验证和模型中断均零提交，现场与占用保留", () => {
  python(`repo=setup()
` + WORKER + `
baseline=g(repo,'rev-parse','HEAD'); w.run_verify=lambda task:None
_,body=w.claim_task('第一线','alpha','default'); task=body['task']
assert w.handle(task,'第一线')=='wait' and g(repo,'rev-parse','HEAD')==baseline
assert '登记验证' in deliveries[-1][0][3]
repo=setup(); w.REPO=str(repo); w.run_verify=verify
def interrupted(task,worker,path,*args):
 (repo/'one.txt').write_text('中断现场',encoding='utf-8'); raise KeyboardInterrupt()
w.run_worker=interrupted; baseline=g(repo,'rev-parse','HEAD')
_,body=w.claim_task('第一线','alpha','default')
try: w.handle(body['task'],'第一线')
except KeyboardInterrupt: pass
else: raise AssertionError('吞掉了中断')
assert g(repo,'rev-parse','HEAD')==baseline and (repo/'one.txt').read_text(encoding='utf-8')=='中断现场'
refused(lambda:h.HostCommitGuard(str(repo),'第二线').acquire())
`);
});

test("并发第二执行者在领取前被拒，队列空正常释放占用", () => {
  python(`repo=setup()
` + WORKER + `
_,body=w.claim_task('第一线','alpha','default')
refused(lambda:w.claim_task('第二线','beta','default'))
assert len(claims)==1
body['task']['_host_commit_guard'].release()
w.call=lambda *args,**kwargs:(204,{})
assert w.claim_task('第一线','alpha','default')==(204,{})
guard=h.HostCommitGuard(str(repo),'第二线').acquire(); guard.release()
`);
});

test("Git 控制面或 attributes 篡改，直接文件检查后零新 Git 调用", () => {
  python(`
for name in ('config','HEAD','index','MERGE_HEAD','index.lock','attributes','nested-attributes','hook'):
 repo=setup(); guard=h.HostCommitGuard(str(repo),'第一线').acquire()
 if name=='attributes': path=repo/'.gitattributes'
 elif name=='nested-attributes': path=repo/'nested'/'.gitattributes'; path.parent.mkdir()
 elif name=='hook': path=repo/'.git'/'hooks'/'pre-commit'
 else: path=repo/'.git'/name
 path.write_bytes(path.read_bytes()+b'\\n# mutated' if path.exists() else b'*.txt filter=unexpected\\n')
 original=subprocess.run; calls=[]
 def forbidden(*args,**kwargs): calls.append(args); raise AssertionError('篡改后运行了 Git')
 subprocess.run=forbidden
 try: refused(guard.bind_changes)
 finally: subprocess.run=original
 assert calls==[],(name,calls)
`);
});

test("进行中的 Git 操作状态在领取前拒绝，原状态不清理", () => {
  python(`repo=setup()
` + WORKER + `
state=repo/'.git'/'MERGE_HEAD'; state.write_text(g(repo,'rev-parse','HEAD')+'\\n',encoding='utf-8')
refused(lambda:w.claim_task('第一线','alpha','default'))
assert claims==[] and state.exists()
`);
});

test("Git 干净检查故障不能当作空仓，领取数为零", () => {
  python(`repo=setup()
` + WORKER + `
original=h.HostCommitGuard._run
def broken(self,args,*values,**kwargs):
 if args[0]=='status': raise h.HostCommitError('本地 Git 故障桩')
 return original(self,args,*values,**kwargs)
h.HostCommitGuard._run=broken
refused(lambda:w.claim_task('第一线','alpha','default'))
assert claims==[]
`);
});

test("有效 include、全局属性与外部 hooks 的新增或改写同样在 Git 前拒绝", () => {
  python(`
for name in ('include','global-attributes','external-hooks','git-pointer'):
 repo=setup()
 if name=='include':
  path=repo/'.git'/'missing-include'; g(repo,'config','include.path','missing-include')
 elif name=='global-attributes':
  path=home/'xdg'/'git'/'attributes'; path.parent.mkdir(parents=True,exist_ok=True)
 elif name=='external-hooks':
  hooks=folder/str(uuid.uuid4()); hooks.mkdir(); path=hooks/'pre-commit'; g(repo,'config','core.hooksPath',str(hooks))
 elif name=='git-pointer':
  original=repo; target=folder/str(uuid.uuid4()); g(original,'worktree','add','-b','fixture-'+str(uuid.uuid4()),str(target)); repo=target; path=repo/'.git'
 guard=h.HostCommitGuard(str(repo),'第一线').acquire()
 if path.exists():
  with path.open('r+b') as changed: changed.seek(0,2); changed.write(b'\\n# changed')
 else: path.write_bytes(b'*.txt filter=unexpected\\n')
 original_run=subprocess.run; calls=[]
 def forbidden(*args,**kwargs): calls.append(args); raise AssertionError('有效控制面变动后调用了 Git')
 subprocess.run=forbidden
 try: refused(guard.bind_changes)
 finally: subprocess.run=original_run
 assert calls==[],name
 if name=='global-attributes': path.unlink()
`);
});

test("正常提交实际执行钩子，钩子失败不绕过并保留暂存", () => {
  python(`
for succeeds in (True,False):
 repo=setup(); marker=repo/'.git'/'hook-ran'
 hook=repo/'.git'/'hooks'/'pre-commit'
 hook.write_text('#!/bin/sh\\necho ran >> "'+marker.as_posix()+'"\\nexit '+('0' if succeeds else '1')+'\\n',encoding='utf-8')
 hook.chmod(0o755)
 guard=h.HostCommitGuard(str(repo),'第一线').acquire(); before=g(repo,'rev-parse','HEAD')
 (repo/'one.txt').write_text('本轮',encoding='utf-8'); guard.bind_changes()
 if succeeds:
  result=guard.finish(17,'可信宿主提交',evidence()); assert result['sha']!=before
  assert 'Co-Authored-By' not in g(repo,'log','-1','--format=%B'); guard.release()
 else:
  refused(lambda:guard.finish(17,'可信宿主提交',evidence()))
  assert g(repo,'rev-parse','HEAD')==before and g(repo,'diff','--cached','--name-only')=='one.txt'
 assert marker.read_text().strip()=='ran'
`);
});

test("无法绑定的有效过滤器在领取前拒绝，保留原全局配置", () => {
  python(`repo=setup()
global_config=home/'.gitconfig'; global_config.write_text('[filter "fixture"]\\n clean = echo controlled\\n',encoding='utf-8')
original=global_config.read_bytes()
(repo/'.gitattributes').write_text('*.txt filter=fixture\\n',encoding='utf-8')
g(repo,'add','--','.gitattributes'); g(repo,'commit','-m','属性夹具')
refused(lambda:h.HostCommitGuard(str(repo),'第一线').acquire())
assert global_config.read_bytes()==original
`);
});

test("正常钩子改写已验证内容或提交信息时不报告成功，保留提交与占用", () => {
  python(`
for kind in ('content','message'):
 repo=setup(); hook=repo/'.git'/'hooks'/('pre-commit' if kind=='content' else 'commit-msg')
 body='echo hook > one.txt\\ngit add -- one.txt\\n' if kind=='content' else 'echo "额外署名" >> "$1"\\n'
 hook.write_text('#!/bin/sh\\n'+body,encoding='utf-8'); hook.chmod(0o755)
 guard=h.HostCommitGuard(str(repo),'第一线').acquire(); before=g(repo,'rev-parse','HEAD')
 (repo/'one.txt').write_text('已验证',encoding='utf-8'); guard.bind_changes()
 refused(lambda:guard.finish(17,'可信宿主提交',evidence()))
 assert g(repo,'rev-parse','HEAD')!=before
 refused(lambda:h.HostCommitGuard(str(repo),'第二线').acquire())
`);
});

test("只提交冻结的本卡字面路径，验证后外部变动不入库", () => {
  python(`repo=setup(); guard=h.HostCommitGuard(str(repo),'第一线').acquire()
name='-字面[1].txt'; (repo/name).write_text('字面路径',encoding='utf-8'); guard.bind_changes()
result=guard.finish(17,'字面路径',evidence()); assert result['paths']==[name],result
assert g(repo,'show','--format=','--name-only','-z','HEAD').rstrip('\\0')==name; guard.release()
guard=h.HostCommitGuard(str(repo),'第一线').acquire()
(repo/'one.txt').write_text('本轮',encoding='utf-8'); guard.bind_changes()
(repo/'two.txt').write_text('验证后意外外部改动',encoding='utf-8')
before=g(repo,'rev-parse','HEAD'); refused(lambda:guard.finish(17,'拒绝混入',evidence()))
assert g(repo,'rev-parse','HEAD')==before and g(repo,'diff','--cached','--name-only')==''
assert (repo/'two.txt').read_text(encoding='utf-8')=='验证后意外外部改动'
`);
});

test("无修改无空提交；领取结果未知保留占用而非自动重领", () => {
  python(`repo=setup(); guard=h.HostCommitGuard(str(repo),'第一线').acquire()
before=g(repo,'rev-parse','HEAD'); guard.bind_changes()
assert guard.finish(17,'没有修改',evidence())=={'sha':None,'paths':[]}
assert g(repo,'rev-parse','HEAD')==before; guard.release()
` + WORKER + `
def lost(*args,**kwargs): claims.append('未知'); raise RuntimeError('本地领取响应丢失桩')
w.call=lost; refused(lambda:w.claim_task('第一线','alpha','default'))
assert claims==['未知']; refused(lambda:h.HostCommitGuard(str(repo),'第二线').acquire())
`);
});

test("删除整目录与移动文件按本卡精确路径正常提交", () => {
  python(`repo=setup(); (repo/'old').mkdir(); (repo/'old'/'file.txt').write_text('移动',encoding='utf-8')
g(repo,'add','--','old/file.txt'); g(repo,'commit','-m','目录夹具')
guard=h.HostCommitGuard(str(repo),'第一线').acquire()
(repo/'old'/'file.txt').rename(repo/'moved.txt'); (repo/'old').rmdir()
guard.bind_changes(); result=guard.finish(17,'移动文件',evidence())
assert result['paths']==['moved.txt','old/file.txt'],result
guard.release()
`);
});

test("工作仓里的 git.cmd 不被执行；PATH 上的 .cmd 垫片、落在工作仓或数据目录内的 Git 程序一律拒绝", { skip: process.platform !== "win32" }, () => {
  python(`repo=setup()
(repo/'.gitignore').write_text('git.cmd\\nplanted-ran.txt\\n',encoding='utf-8')
g(repo,'add','--','.gitignore'); g(repo,'commit','-m','忽略夹具')
(repo/'git.cmd').write_text('@echo off\\r\\necho ran> "%~dp0planted-ran.txt"\\r\\nexit /b 1\\r\\n',encoding='ascii',newline='')
os.environ.pop('NoDefaultCurrentDirectoryInExePath',None); os.chdir(repo)
` + WORKER + `
try: _,body=w.claim_task('第一线','alpha','default')
finally: assert not (repo/'planted-ran.txt').exists(),'工作仓里的 git.cmd 被宿主执行'
guard=body['task']['_host_commit_guard']; program=pathlib.Path(guard.git)
assert len(claims)==1 and program.suffix.lower()=='.exe' and repo.resolve() not in program.resolve().parents,program
assert guard.env.get('NODEFAULTCURRENTDIRECTORYINEXEPATH')=='1'
guard.release()
shim=folder/'shim'; shim.mkdir()
(shim/'git.cmd').write_text('@echo off\\r\\necho ran> "%~dp0shim-ran.txt"\\r\\nexit /b 1\\r\\n',encoding='ascii',newline='')
saved=os.environ['PATH']; os.environ['PATH']=str(shim)+os.pathsep+saved
try:
 refused(lambda:h.HostCommitGuard(str(repo),'第二线').acquire())
 assert not (shim/'shim-ran.txt').exists(),'PATH 上的 .cmd 垫片被宿主执行'
 w.HOST_GIT=None; assert w.host_commit_gate()
 refused(lambda:w.claim_task('第二线','beta','default'))
finally: os.environ['PATH']=saved
inside=[repo/'tools'/'git.exe',folder/'data'/'bin'/'git.exe']
for target in inside: target.parent.mkdir(parents=True); target.write_bytes(b'MZ')
for bad in [str(shim/'git.cmd'),'git']+[str(target) for target in inside]:
 os.environ['WORKER_HOST_GIT']=bad; w.HOST_GIT=None
 assert w.host_commit_gate(),bad
 refused(lambda:w.claim_task('第二线','beta','default'))
 refused(lambda:h.HostCommitGuard(str(repo),'第二线',protected=[w.DATA]))
assert len(claims)==1 and not (shim/'shim-ran.txt').exists() and not (repo/'planted-ran.txt').exists()
os.environ['WORKER_HOST_GIT']=git; w.HOST_GIT=None
assert w.host_commit_gate() is None and os.path.samefile(w.host_git()[0],git)
`);
});

test("卡标题里的引号与 & | 不进入任何命令行，提交信息经标准输入逐字保留", () => {
  python(`repo=setup(); guard=h.HostCommitGuard(str(repo),'第一线').acquire()
title='注入" & echo INJECTED>injected.txt & rem "|x'
seen=[]; real=subprocess.Popen
class Spy(real):
 def __init__(self,args,*rest,**options): seen.append([str(part) for part in args]); super().__init__(args,*rest,**options)
subprocess.Popen=Spy
try:
 (repo/'one.txt').write_text('本轮',encoding='utf-8'); guard.bind_changes()
 result=guard.finish(17,title,evidence())
finally: subprocess.Popen=real
assert any('commit' in argv for argv in seen),'前提：本轮确实执行了 commit'
assert not any('INJECTED' in part or '注入' in part for argv in seen for part in argv),seen
assert g(repo,'log','-1','--format=%B')=='#17 '+title and result['sha']==g(repo,'rev-parse','HEAD')
assert not (repo/'injected.txt').exists(); guard.release()
`);
});

test("证据目录在工作仓内的默认布局在领卡前拒绝；没有登记验证的卡不调用模型，转等待并释放占用", () => {
  python(`repo=setup()
(repo/'.gitignore').write_text('core/.data/\\n',encoding='utf-8')
g(repo,'add','--','.gitignore'); g(repo,'commit','-m','默认布局夹具')
` + WORKER + `
outside=(w.DATA,w.EVID); assert w.host_commit_gate() is None
w.DATA=str(repo/'core'/'.data'); w.EVID=str(repo/'core'/'.data'/'evidence'); os.makedirs(w.EVID)
assert g(repo,'status','--porcelain')=='','前提：数据目录被忽略，干净检查看不见它'
reason=w.host_commit_gate(); assert reason and 'BOARD_DATA_DIR' in reason,reason
refused(lambda:w.claim_task('第一线','alpha','default'))
assert claims==[] and models==[] and deliveries==[]
h.HostCommitGuard(str(repo),'核对无残留锁').acquire().release()
started=subprocess.run([sys.executable,'-X','utf8',str(pathlib.Path(sys.argv[1])/'loops'/'worker_loop.py'),'--as','alpha','--once'],
 env=dict(os.environ,BOARD_REPO=str(repo),BOARD_DATA_DIR=w.DATA,BOARD_URL='http://127.0.0.1:9',
  WORKER_CLI_ARGV=json.dumps([sys.executable,'-c','pass'])),capture_output=True,timeout=25)
printed=started.stdout.decode('utf-8','replace')
assert started.returncode==3 and '宿主逐卡提交' in printed and 'BOARD_DATA_DIR' in printed and '拒绝启动' in printed,(started.returncode,printed)
w.DATA,w.EVID=outside
def bare(method,path,body=None,**kwargs):
 claims.append(body); return 200,{'task':{'id':7,'subject':'没有登记验证','run_id':str(uuid.uuid4()),'attempts':1}}
w.call=bare
status,body=w.claim_task('第一线','alpha','default')
assert len(claims)==1 and not body.get('task') and body.get('host_commit_parked')==7,body
assert models==[] and len(deliveries)==1 and deliveries[0][0][:3]==(7,'第一线','wait') and '登记验证' in deliveries[0][0][3]
assert g(repo,'status','--porcelain')==''
h.HostCommitGuard(str(repo),'核对占用已释放').acquire().release()
`);
});

test("reset 之后的第一张卡照常提交：循环读工作区状态不重写索引，领卡时先让索引落定", () => {
  python(`import time
repo=setup()
` + WORKER + `
def index_identity(): path=repo/'.git'/'index'; return (path.stat().st_ino,path.read_bytes())
(repo/'one.txt').write_text('上一张失败卡的残留',encoding='utf-8'); g(repo,'reset','--hard')
original_model=w.run_worker
def prompted(task,*args):
 w.worktree_state(); return original_model(task,*args)
w.run_worker=prompted
_,body=w.claim_task('第一线','alpha','default'); task=body['task']
assert w.handle(task,'第一线')=='done',deliveries[-1]
assert g(repo,'log','-1','--format=%s')=='#1 同文件逐卡提交'; task['_host_commit_guard'].release()
past=time.time()-300
guard=h.HostCommitGuard(str(repo),'第一线').acquire()
(repo/'one.txt').write_text('本轮改动',encoding='utf-8'); os.utime(repo/'two.txt',(past,past)); before=index_identity()
state=w.worktree_state()
assert state and 'one.txt' in state[0] and 'one.txt' in state[1],state
assert index_identity()==before,'循环自己的 git status 重写了索引'
assert guard.bind_changes()==['one.txt']; guard.release()
repo=setup(); w.REPO=str(repo)
for name in ('one.txt','two.txt'): os.utime(repo/name,(past,past))
guard=h.HostCommitGuard(str(repo),'第一线').acquire(); before=index_identity()
assert g(repo,'status','--porcelain')=='' and index_identity()==before,'领卡时索引没有落定，别的程序一跑普通 status 就会重写它'
assert guard.bind_changes()==[]; guard.release()
`);
});

test("宿主的 commit 不顺带做自动维护：松散引用与松散对象够多时也不打包引用，提交照常成功", () => {
  python(`import hashlib
repo=setup(); head=g(repo,'rev-parse','HEAD'); packed=repo/'.git'/'packed-refs'
def fill():
 # 两种触发条件都布置：较新的 Git 按松散引用数打包引用，较早的按 gc.auto 与 objects/17 里的松散对象数。
 lines=''.join('create refs/heads/loose-'+uuid.uuid4().hex+' '+head+chr(10) for number in range(40))
 subprocess.run([git,'update-ref','--stdin'],cwd=repo,input=lines.encode(),check=True)
 found=0; number=0
 while found<3:
  number+=1; content=(uuid.uuid4().hex+str(number)).encode()
  if hashlib.sha1(b'blob '+str(len(content)).encode()+bytes(1)+content).hexdigest().startswith('17'):
   subprocess.run([git,'hash-object','-w','--stdin'],cwd=repo,input=content,check=True,capture_output=True); found+=1
for key,value in (('gc.auto','1'),('gc.autoDetach','false'),('maintenance.autoDetach','false')): g(repo,'config',key,value)
fill(); assert not packed.exists(),'前提：领卡前引用是松散的'
guard=h.HostCommitGuard(str(repo),'第一线').acquire()
(repo/'one.txt').write_text('本轮',encoding='utf-8'); guard.bind_changes()
result=guard.finish(17,'松散引用很多',evidence())
assert result['sha']==g(repo,'rev-parse','HEAD') and result['sha']!=head
assert not packed.exists(),'宿主的 commit 顺带打包了引用'
guard.release()
g(repo,'commit','--allow-empty','-m','对照：同一个仓里的普通提交')
assert packed.exists(),'对照失效：本机 Git 在这个夹具上不触发自动维护，夹具需要更新'
`);
});

test("fleet 开关默认关闭且只接受显式布尔配置", () => {
  const output = python(`sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'core'))
import board_env
assert 'WORKER_HOST_COMMIT' not in os.environ
board_env.apply(); assert 'WORKER_HOST_COMMIT' not in os.environ
path=folder/'fleet.json'; path.write_text(json.dumps({'host_auto_commit':True}),encoding='utf-8')
board_env.CONFIG_FILE=str(path); board_env.apply(); assert os.environ['WORKER_HOST_COMMIT']=='1'
for invalid in (1,'1','true'):
 os.environ.pop('WORKER_HOST_COMMIT',None)
 path.write_text(json.dumps({'host_auto_commit':invalid}),encoding='utf-8'); board_env.apply()
 assert 'WORKER_HOST_COMMIT' not in os.environ
`);
  assert.equal(output, "");
});
