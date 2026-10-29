import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const python=process.env.BOARD_PYTHON||process.env.PYTHON||'python';
function run(script){
 const r=spawnSync(python,['-I','-B','-X','utf8','-',root],{
  cwd:root,encoding:'utf8',windowsHide:true,timeout:10000,
  input:'import sys, pathlib, tempfile\nsys.path.insert(0,str(pathlib.Path(sys.argv[1])/"loops"))\n'+script,
  env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'},
 });
 assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
}

test('协调线首次与指定会话续接保持只读和相同结构化输出合同',()=>{
 run(`import codex_coordinator as c
thread='01a00000-0000-7000-8000-000000000000'
base=pathlib.Path(tempfile.gettempdir())/'协调 工作仓'
for session in (None,thread):
 args=c.argv('codex.exe','fixture-model','high',str(base/'回复.json'),str(base),str(base/'结构.json'),thread_id=session)
 command=args.index('exec')
 assert '-c' not in args[command+1:],args
 for setting in ('sandbox_mode="read-only"','approval_policy="never"','forced_login_method="chatgpt"','windows.sandbox="unelevated"'):
  assert setting in args[:command],args
 assert args[args.index('-C')+1]==str(base) and args.index('-C')<command,args
 assert '--json' in args and '--ignore-user-config' in args and args[-1]=='-',args
 assert args[args.index('--output-schema')+1]==str(base/'结构.json'),args
 assert '--ephemeral' not in args and '--last' not in args and '--approve-for-me' not in args,args
 assert '--sandbox' not in args and '--permission-profile' not in args,args
 assert ('resume' in args)==bool(session),args
 if session: assert args[args.index('resume')+1]==thread,args
try: c.argv('codex.exe','fixture','high','last','work','schema',thread_id='--last')
except ValueError: pass
else: raise AssertionError('非法会话引用被接受')
`);
});

test('协调线从 UTF-8 文件读首句，中文路径和正文不进入 argv',()=>{
 run(`import codex_coordinator as c
with tempfile.TemporaryDirectory(prefix='协调中文-') as folder:
 prompt=pathlib.Path(folder)/'首句.txt'; prompt.write_text('读取任务，保持只读。'+chr(10)+'第二行',encoding='utf-8')
 assert c.read_prompt(str(prompt))=='读取任务，保持只读。'+chr(10)+'第二行'
 args=c.argv('codex.exe','fixture','high',str(pathlib.Path(folder)/'结果.json'),folder,'schema.json')
 assert not any('读取任务' in item for item in args)
`);
});

test('协调线要求调用方显式传入已过滤环境，不默认继承宿主环境',()=>{
 run(`import codex_coordinator as c
try: c.environment()
except TypeError: pass
else: raise AssertionError('缺少显式环境时仍被接受')
prepared={'CODEX_HOME':'fixture-auth','PATH':'fixture-path'}
seen=[]
c.codex_runtime.subscription_environment=lambda value:(seen.append(value) or {'filtered':'fixture'})
assert c.environment(prepared)=={'filtered':'fixture'}
assert seen==[prepared]
`);
});

test('协调线实际准备入口先核实登录，不符时不返回生成命令',()=>{
 run(`import codex_coordinator as c
seen=[]
source={'CODEX_HOME':'fixture-auth','PATH':'fixture-path'}
c.codex_runtime.subscription_environment=lambda value:dict(value)
def login(cli,env,**kwargs):
 seen.append((cli,env,kwargs)); return '需要 ChatGPT 订阅登录'
c.codex_runtime.subscription_login_gate=login
try: c.prepare('codex.exe','fixture','high','last','work','schema',env=source)
except RuntimeError as error: assert 'ChatGPT' in str(error)
else: raise AssertionError('认证不符时仍返回生成命令')
assert len(seen)==1 and seen[0][1]==source and seen[0][2]['workdir']=='work'
c.codex_runtime.subscription_login_gate=lambda *a,**kw:None
args,child=c.prepare('codex.exe','fixture','high','last','work','schema',env=source)
assert child==source and child is not source and 'exec' in args
`);
});

test('协调线计划 schema 对每个对象声明完整 required，订阅预算可为 null',()=>{
 const schema=JSON.parse(readFileSync(join(root,'examples/codex-coordinator-schema.json'),'utf8'));
 const visit=node=>{
  if(Array.isArray(node)){for(const value of node)visit(value);return;}
  if(!node||typeof node!=='object')return;
  if(node.properties){assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort());assert.equal(node.additionalProperties,false);}
  for(const value of Object.values(node))visit(value);
 };
 visit(schema);
 assert.ok(schema.properties.plan.type.includes('null'));
 const task=schema.properties.plan.properties.tasks.items;
 assert.deepEqual(task.properties.budget_usd.type,['number','null']);
 assert.deepEqual(task.required,['title','line','channel','budget_usd','after','acceptance','needs_confirm']);
});
