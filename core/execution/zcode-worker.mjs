// Zcode 独立执行循环(第一阶段:只接文字交付卡)。
// 本模块只做三件事:把合格的卡送到「等待执行器」、调一轮既有调度器、事后记账。
// 领取、一次性许可、预算扣减、Job 托管与失败不重启都在 dispatch 链里,这里不复制。
// 哪道门在哪一层:
//   dispatch 链(任何入口都要过):环境钥匙 BOARD_ZCODE_RELEASED、库内预算的启用与余量、一次性许可。
//   本模块(只有经 cli/zcode-worker.mjs 才过):launch.enabled、authorization 时间窗、max_launches 与库内上限的
//   交叉校验、拒收规则、四节提示附录。把 scheduler 配置块直接交给 cli/scheduler.mjs 时不经过这一层。
import {existsSync,readdirSync,realpathSync,statSync,openSync,writeFileSync,fsyncSync,closeSync,appendFileSync,unlinkSync,readFileSync} from 'node:fs';
import {join,dirname,basename,resolve,relative,isAbsolute,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {keys,names} from '../federation/protocol.mjs';
import {localIdentity,migratePeers} from '../federation/peers.mjs';
import {atomic,canonical} from '../federation/sync-store.mjs';
import {exact,fail,getRole,putRole,issuePrincipal,authenticateCredential,loadPrincipalCredential} from '../mcp/policy.mjs';
import {callTool,chooseRole,enrollTask} from '../mcp/tools.mjs';
import {listenBroker} from '../mcp/gateway.mjs';
import {boardURL} from '../mcp/context.mjs';
import {migrateDispatch,putQuota,quotaStatus,dispatchStatus,withdrawAssignment} from './dispatch.mjs';
import {schedulerStatus} from './lifecycle.mjs';
import {openScheduler,inflightBlockers} from './scheduler.mjs';
import {ZCODE_RELEASE_VARIABLE,zcodeReleased} from './adapters.mjs';
import {pinFile} from './supervisor.mjs';
const store=createRequire(import.meta.url)('../store.js');

export const ZCODE_WORKER_FORMAT='ai-fleet-zcode-worker/v1';
/** 调用预算:缺省 1 次;代码内硬顶 20 次,配置写得再大也过不了校验。 */
export const DEFAULT_MAX_LAUNCHES=1,HARD_MAX_LAUNCHES=20;
const APPENDIX_LIMIT=2000;
const PREAMBLE='【本次运行】没有文件、命令或网络工具，只能使用 fleet MCP 的看板工具。先调用 get_task 读取任务；把下面四节正文作为 report_result 的 evidence 交付：做完用 done，做不了或需要人决定用 wait。最终回复输出同一份正文。不得输出凭据、令牌或个人隐私。';
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const within=(parent,child)=>{const r=relative(parent,child);return !r||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
const code=e=>typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'ZCODE_WORKER_ERROR';
const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const profileOf=c=>c.scheduler.profiles[0];
const stamp=()=>{const d=new Date(),pad=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());};

// authorization 只有两态。real 的形状在这里核对;时间窗和目录条目数在 authorizationGate 里复核。
function authorizationShape(a,{maxLaunches,bundle}){
 const bad=message=>fail('AUTHORIZATION_INVALID',message,400);
 if(!record(a)||!['synthetic','real'].includes(a.kind))bad('authorization.kind 只接受 synthetic 或 real');
 const fields=a.kind==='synthetic'?['kind']:['kind','authorized_by','authorized_at','expires_at','max_calls','bundle_sha256'];
 if(Object.keys(a).length!==fields.length||fields.some(k=>!Object.hasOwn(a,k)))bad('authorization 字段缺失或多余');
 if(a.kind==='real'){
  const time=x=>typeof x==='string'&&x.length<=40&&Number.isFinite(Date.parse(x));
  if(typeof a.authorized_by!=='string'||!a.authorized_by.trim()||a.authorized_by.length>200||!time(a.authorized_at)||!time(a.expires_at)||Date.parse(a.expires_at)<=Date.parse(a.authorized_at)
   ||!Number.isSafeInteger(a.max_calls)||a.max_calls<1||a.max_calls>HARD_MAX_LAUNCHES||typeof a.bundle_sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.bundle_sha256))bad('real 授权需要授权人、起止时间、调用次数与 bundle 摘要');
  if(a.bundle_sha256!==bundle?.sha256)bad('授权绑定的 bundle 摘要与安装记录不符');
  if(maxLaunches>a.max_calls)bad('max_launches 超过授权的调用次数');
 }
 return {...a};
}
/** 纯函数:只看配置本身,不碰数据库、文件与时钟。返回补齐缺省值的副本。 */
export function validateZcodeWorkerConfig(input){
 exact(input,['format','launch','line','intake','mcp','evidence','ledger_file','scheduler'],'zcode_worker');
 if(input.format!==ZCODE_WORKER_FORMAT)fail('BAD_INPUT','Zcode 执行循环配置格式无效',400);
 keys(input.launch,['enabled','max_launches','authorization'],'launch');
 const enabled=input.launch.enabled??false,maxLaunches=input.launch.max_launches??DEFAULT_MAX_LAUNCHES;
 if(typeof enabled!=='boolean'||!Number.isSafeInteger(maxLaunches)||maxLaunches<1||maxLaunches>HARD_MAX_LAUNCHES)fail('BAD_INPUT','launch.enabled 须为布尔值,max_launches 须为 1–'+HARD_MAX_LAUNCHES,400);
 const s=input.scheduler,p=record(s)&&Array.isArray(s.profiles)&&s.profiles.length===1?s.profiles[0]:null;
 if(!record(p)||s.format!=='ai-fleet-scheduler/v1'||s.max_active!==1||p.workspace!==null||!record(p.installation)||p.installation.runtime!=='zcode')fail('BAD_INPUT','需要恰好一个 Zcode 执行配置:并发为 1、不带文件工作区',400);
 names([input.line],'line',null,1);
 if(p.role_id!==input.line)fail('BAD_INPUT','线名必须等于执行配置的 role_id',400);
 keys(input.intake,['coordinator_credential_file','auto_enroll'],'intake');
 const credentialFile=input.intake.coordinator_credential_file,autoEnroll=input.intake.auto_enroll??false;
 if(typeof credentialFile!=='string'||!isAbsolute(credentialFile)||typeof autoEnroll!=='boolean')fail('BAD_INPUT','协调凭据须为绝对路径,auto_enroll 须为布尔值',400);
 if(input.mcp!==null){
  exact(input.mcp,['port','board_url'],'mcp');
  if(!Number.isInteger(input.mcp.port)||input.mcp.port<1||input.mcp.port>65535)fail('BAD_INPUT','MCP 须显式指定回环端口',400);
  boardURL(input.mcp.board_url);
  if(p.mcp_url!=='http://127.0.0.1:'+input.mcp.port)fail('BAD_INPUT','执行配置的 mcp_url 必须指向本进程管理的端口',400);
 }
 keys(input.evidence,['max_chars'],'evidence');
 const maxChars=input.evidence.max_chars??4000;
 if(!Number.isSafeInteger(maxChars)||maxChars<200||maxChars>60000)fail('BAD_INPUT','evidence.max_chars 须为 200–60000',400);
 if(input.ledger_file!==null){
  if(typeof input.ledger_file!=='string'||!isAbsolute(input.ledger_file)||input.ledger_file.includes('\0'))fail('BAD_INPUT','ledger_file 须为绝对路径或 null',400);
  // 账本可以在数据目录里(看板读的就是那里),只排除调度根与认证目录。
  for(const forbidden of [s.root,p.installation.auth_home])if(typeof forbidden==='string'&&isAbsolute(forbidden)&&within(resolve(forbidden),resolve(input.ledger_file)))fail('UNSAFE_RUNTIME_PATH','账本不能放在调度根或认证目录内');
 }
 const authorization=authorizationShape(input.launch.authorization,{maxLaunches,bundle:p.installation.bundle});
 return {...structuredClone(input),launch:{enabled,max_launches:maxLaunches,authorization},intake:{coordinator_credential_file:credentialFile,auto_enroll:autoEnroll},evidence:{max_chars:maxChars}};
}
/**
 * 本层的启动开关:配置里 launch.enabled=true,加上环境钥匙。缺一把就抛。
 * 环境钥匙与 dispatch 链里那道门是同一个判定(adapters.mjs),这里只是提前到任何副作用之前再核一次。
 */
export function requireZcodeLaunchSwitch(config,environment=process.env){
 if(config?.launch?.enabled!==true||!zcodeReleased(environment))fail('ZCODE_LAUNCH_DISABLED','Zcode 启动开关未打开:需要 launch.enabled=true 且环境变量 '+ZCODE_RELEASE_VARIABLE+'=1');
}

// ── 门:打开时判一次,此后每轮复核 ──────────────────────────────────────────
function authorizationGate(c,now=Date.now()){
 const a=c.launch.authorization;
 if(a.kind==='real'){
  // 真实授权不列目录、不读认证目录,只看时间窗。
  if(now<Date.parse(a.authorized_at)||now>=Date.parse(a.expires_at))fail('AUTHORIZATION_EXPIRED','真实调用授权尚未生效或已过期');
  return;
 }
 // synthetic 只用于回归:认证目录必须是空目录(只数条目,不读内容)。
 let entries;try{entries=readdirSync(profileOf(c).installation.auth_home).length;}catch{fail('AUTHORIZATION_INVALID','synthetic 授权需要可达的空认证目录',400);}
 if(entries)fail('AUTHORIZATION_INVALID','synthetic 授权只能用于空认证目录',400);
}
function roleGate(db,c){
 const p=profileOf(c),role=getRole(db,p.role_id)?.policy;
 if(!role?.enabled||role.runtime!=='zcode'||role.kind!=='implement'||role.capabilities.length!==1||role.capabilities[0]!=='board-tools'||!role.projects.includes(p.project_id))fail('ROLE_UNSUPPORTED','执行角色须为已启用、授权该项目的 zcode / implement / board-tools 角色');
 // attempts 是累计值、从不清零:角色上限为 1 才能保证每张卡结构上最多派发一次。
 if(role.limits.max_task_attempts!==1)fail('ROLE_NOT_SINGLE_ATTEMPT','执行角色的 max_task_attempts 必须为 1');
 return role;
}
function budgetGate(db,c){
 const q=quotaStatus(db,profileOf(c).quota_id);
 if(!q)fail('BUDGET_UNAVAILABLE','调用预算未登记');
 // 两把钥匙:调大预算要同时改库和配置,只改一边不生效。
 if(q.limit_total>c.launch.max_launches)fail('BUDGET_EXCEEDS_DECLARED','库内预算上限大于配置声明的 max_launches');
 return q;
}
function coordinatorGate(db,c){
 const refuse=()=>fail('COORDINATOR_UNAVAILABLE','协调凭据不可读、已失效或未授权该项目',403);
 let token,principal;
 try{token=loadPrincipalCredential(c.intake.coordinator_credential_file).token;principal=authenticateCredential(db,'Bearer '+token);}catch{refuse();}
 if(principal.role.policy.kind!=='coordinate'||principal.run_id||!principal.projects.includes(profileOf(c).project_id))refuse();
 return {authorization:'Bearer '+token,principal_id:principal.principal_id};
}
function ledgerGate(c){
 if(c.ledger_file===null)return;
 let ledger;try{ledger=join(realpathSync(dirname(c.ledger_file)),basename(c.ledger_file));}catch{fail('BAD_INPUT','账本所在目录不可达',400);}
 const real=path=>{try{return join(realpathSync(dirname(path)),basename(path));}catch{return null;}};
 for(const forbidden of [real(c.scheduler.root),real(profileOf(c).installation.auth_home)])if(forbidden&&within(forbidden,ledger))fail('UNSAFE_RUNTIME_PATH','账本不能放在调度根或认证目录内');
}

// ── 接卡判定(只读) ────────────────────────────────────────────────────────
const admission=(db,id)=>db.prepare('SELECT project_id,work_kind,capabilities_json FROM broker_task_projects WHERE task_id=?').get(id);
function lineage(db,taskId){
 const chain=[],seen=new Set();let id=taskId;
 while(id!==null){
  if(seen.has(id)||seen.size>=32)fail('BAD_CHAIN','父任务链无效');seen.add(id);
  const t=db.prepare('SELECT id,parent_id,aggregate_version FROM tasks WHERE id=?').get(id);
  if(!t)fail('NOT_FOUND','任务不存在',404);chain.unshift(t);id=t.parent_id;
 }
 return chain; // 自根向下,末项是本卡
}
/**
 * 未结清 = 调度器眼里仍占着并发位的运行。用的是调度器自己的判定(inflightBlockers),不另写一份口径:
 * 并发为 1,任何一条都让调度器不再启动。人工恢复回执(record-uncertain)不清并发位,调度器只采信机器停止证明。
 */
function occupied(db){
 const attested=table(db,'broker_execution_resolutions');
 return inflightBlockers(db).map(b=>{
  const d=db.prepare('SELECT dispatch_id,task_id,phase FROM broker_dispatches WHERE run_id=?').get(b.run_id);
  return {dispatch_id:d?.dispatch_id??null,task_id:d?.task_id??null,phase:d?.phase??null,reason:b.kind,
   operator_attested:!!(d&&attested&&db.prepare('SELECT 1 FROM broker_execution_resolutions WHERE dispatch_id=?').get(d.dispatch_id))};
 }).sort((a,b)=>String(a.dispatch_id)<String(b.dispatch_id)?-1:1);
}
/** 这张卡名下还有已保留或已消费许可、结果没落定的分派。 */
const pendingDispatch=(db,taskId)=>!!db.prepare("SELECT 1 FROM broker_dispatches WHERE task_id=? AND phase IN('prepared','launch_committed','interrupted') LIMIT 1").get(taskId);
/** 候选条件只写在这一处:接卡查询与「别人建的请求」都按它判。 */
function eligible(c,t){
 if(t.kind!=='task'||t.archived_at)return 'NOT_A_TASK';
 if(t.status!=='not_started')return 'NOT_QUEUED';
 if(!t.released)return 'NOT_RELEASED';
 if(t.route!=='mcp')return 'ROUTE_MISMATCH';
 if(t.line!==c.line)return 'LINE_MISMATCH';                 // 线为空也不接
 if(t.human_gate)return 'HUMAN_GATE';
 return null;
}
function candidates(db,c){
 return db.prepare("SELECT * FROM tasks WHERE status='not_started' AND line=? AND archived_at IS NULL ORDER BY id").all(c.line).filter(t=>eligible(c,t)===null).slice(0,200);
}
/** 返回拒收码;null 表示可以接。拒收都发生在领取之前,不消耗预算。候选卡与已有请求用的是这同一个函数。 */
function refusal(db,c,t){
 const out=eligible(c,t);if(out)return out;
 const p=profileOf(c),mine=x=>chooseRole(db,x)?.role_id===p.role_id?null:'ROLE_MISMATCH';
 if(t.verify_cmd)return 'VERIFY_UNSUPPORTED';              // 无工具执行跑不了登记验证,不静默跳过
 let fixed;try{fixed=store.taskExecutionProfile(db,t.id);}catch{fixed=true;}
 if(fixed)return 'PROFILE_BOUND';                          // 已绑定别的执行通道
 if(t.attempts>=Math.min(t.max_attempts,1))return 'ATTEMPTS_EXHAUSTED';
 if(pendingDispatch(db,t.id))return 'UNSETTLED_DISPATCH';
 const a=admission(db,t.id);let role;
 if(a)role=a.project_id!==p.project_id?'PROJECT_MISMATCH':mine({...a});
 else if(!c.intake.auto_enroll)role='NOT_ENROLLED';
 else role=lineage(db,t.id).slice(0,-1).some(up=>{const row=admission(db,up.id);return row&&row.project_id!==p.project_id;})?'PROJECT_MISMATCH':mine({project_id:p.project_id,work_kind:'implement',capabilities_json:'["board-tools"]'});
 if(role)return role;
 // 领取时才查的条件(依赖、未完成子任务、祖先放行、执行锁、同根在途上限、任务树 / 拓扑 / 委派持有):
 // 用 store 回答「这张卡为什么领不走」的那一份判定,它与 claimById 共用同一批闸,这里不抄。
 // 无进展闸不在其中:dispatch_fp 与 attempts+1 是领取时同一条 UPDATE 写入的,有它的卡上面已按 ATTEMPTS_EXHAUSTED 拒。
 // 其余没料到的领取期拒绝由循环兜住:领不到的请求下一轮不再挡住后面的卡(见 tick)。
 return store.stuckWhy(db,t.id)[0]?.code??null;
}
// 判定本身出错(例如父链损坏)也落在拒收一侧,并带出错误码。
const verdict=(db,c,t)=>{try{return refusal(db,c,t);}catch(e){return code(e);}};
/**
 * 本项目/角色下所有等待执行器的请求,各带一个拒收码(null = 调度器可以领)。
 * TASK_CHANGED:卡在请求之后被改过,调度器的版本核对永远不会放它过。
 */
function pendingRequests(db,c){
 const p=profileOf(c);
 return db.prepare("SELECT a.assignment_id,a.task_uid,a.task_version requested,t.id task_id,t.aggregate_version present FROM broker_assignments a LEFT JOIN tasks t ON t.task_uid=a.task_uid WHERE a.state='waiting_executor' AND a.project_id=? AND a.role_id=? ORDER BY a.created_at,a.assignment_id").all(p.project_id,p.role_id)
  .map(a=>({assignment_id:a.assignment_id,task_uid:a.task_uid,task_id:a.task_id??null,
   refused:a.present!==a.requested?'TASK_CHANGED':verdict(db,c,db.prepare('SELECT * FROM tasks WHERE id=?').get(a.task_id))}));
}
/** 本机操作者动作:自根向下把祖先链(能力 [])和本卡(board-tools)登记到项目。已登记的不改。 */
export function enrollZcodeTask(db,{taskId,projectId}){
 return atomic(db,()=>{
  const enrolled=[];
  for(const t of lineage(db,taskId)){
   const row=admission(db,t.id);
   if(row){if(row.project_id!==projectId)fail('PROJECT_MISMATCH','任务或其祖先已登记在其他项目');continue;}
   enrollTask(db,{id:t.id,projectId,workKind:'implement',capabilities:t.id===taskId?['board-tools']:[],expectedVersion:t.aggregate_version});enrolled.push(t.id);
  }
  return {task_id:taskId,project_id:projectId,enrolled};
 });
}
/** 本机操作者动作:把一张卡交给 Zcode 线(route=mcp、line=线名)并登记祖先链。不启动任何东西。 */
export function enqueueZcodeTask(db,{taskId,expectedVersion,config}){
 const c=validateZcodeWorkerConfig(config);
 if(!table(db,'broker_task_projects'))fail('NOT_CONFIGURED','本库尚未登记 Zcode 线,请先运行 setup');
 return atomic(db,()=>{
  const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if(!t||t.kind!=='task'||t.archived_at)fail('BAD_INPUT','只能把未归档的执行任务交给 Zcode',400);
  if(t.verify_cmd)fail('VERIFY_UNSUPPORTED','带登记验证的卡不能交给 Zcode:它没有命令工具,跑不了验证');
  if(store.taskExecutionProfile(db,taskId))fail('PROFILE_BOUND','已绑定执行配置的卡不能交给 Zcode');
  store.update(db,{id:taskId,expectedVersion,route:'mcp',line:c.line,actor:'human'});
  const enrolled=enrollZcodeTask(db,{taskId,projectId:profileOf(c).project_id});
  return {...enrolled,route:'mcp',line:c.line,aggregate_version:db.prepare('SELECT aggregate_version FROM tasks WHERE id=?').get(taskId).aggregate_version,dispatch_started:false};
 });
}

/** 只读:开关、各道门、预算、未结清的分派、已有请求与候选卡的拒收码。不写库、不启动、不调用 Python。 */
export function zcodeWorkerPlan(db,config,environment=process.env){
 const c=validateZcodeWorkerConfig(config),p=profileOf(c),sw={config_enabled:c.launch.enabled===true,environment_released:zcodeReleased(environment)};
 const out={format:'ai-fleet-zcode-worker-plan/v1',configured:false,line:c.line,project_id:p.project_id,switch:{...sw,open:sw.config_enabled&&sw.environment_released},max_launches:c.launch.max_launches,hard_max_launches:HARD_MAX_LAUNCHES,launched:false};
 if(!['broker_roles','broker_task_projects','broker_assignments','broker_call_quotas','broker_dispatches','broker_execution_records'].every(name=>table(db,name)))return out;
 const gate=check=>{try{check();return null;}catch(e){return code(e);}};
 const q=quotaStatus(db,p.quota_id),open=occupied(db),requests=pendingRequests(db,c);
 const gates={authorization:gate(()=>authorizationGate(c)),role:gate(()=>roleGate(db,c)),budget:gate(()=>budgetGate(db,c)),coordinator:gate(()=>coordinatorGate(db,c))};
 // 未结清排在最前:它不因开关关着或预算用尽而消失,不能被这些状态遮住。
 const state=open.length?'needs_attention':!out.switch.open?'disabled':Object.values(gates).some(Boolean)?'blocked':!q.enabled?'budget_disabled':q.used+q.reserved>=q.limit_total?'budget_exhausted':'ready';
 return {...out,configured:true,state,authorization:c.launch.authorization.kind,gates,
  budget:q?{quota_id:q.quota_id,enabled:!!q.enabled,limit_total:q.limit_total,used:q.used,reserved:q.reserved}:null,
  // reason 是调度器给的占位原因;operator_attested=true 表示已做过 record-uncertain,但并发位仍被占着。
  unsettled:open.map(d=>({dispatch_id:d.dispatch_id,phase:d.phase,reason:d.reason,operator_attested:d.operator_attested})),
  request_pending:requests.length>0,requests:requests.map(a=>({assignment_id:a.assignment_id,task_id:a.task_id,refused:a.refused})),
  candidates:candidates(db,c).map(t=>({task_id:t.id,task_uid:t.task_uid,refused:verdict(db,c,t)}))};
}
/** 只读:plan 之外再给最近的分派与调度实例,供人判断「跑没跑、卡在哪」。 */
export function zcodeWorkerStatus(db,config,environment=process.env){
 const plan=zcodeWorkerPlan(db,config,environment);if(!plan.configured)return plan;
 const dispatches=db.prepare('SELECT dispatch_id,task_id,phase,reason,launch_at,finished_at FROM broker_dispatches WHERE quota_id=? ORDER BY created_at DESC,dispatch_id LIMIT 5').all(plan.budget?.quota_id??'');
 return {...plan,dispatches,scheduler:schedulerStatus(db,{limit:3}).instances.map(i=>({instance_id:i.instance_id,state:i.state,heartbeat_state:i.heartbeat_state,started_at:i.started_at,ended_at:i.ended_at}))};
}

// ── 证据合同:复用 loops/evidence_contract.py,经固定摘要的 Python 调用 ─────
function evidenceTool(c,sourceGate,args,input=''){
 const pin=profileOf(c).python;exact(pin,['path','sha256'],'python_pin');
 const actual=pinFile(pin.path);if(actual.sha256!==pin.sha256)fail('RUNTIME_CHANGED','固定 Python 已变化');
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['systemroot','windir','temp','tmp'].includes(k.toLowerCase())));
 // 隔离模式 + UTF-8 字节进 + ASCII JSON 出:结果不受控制台码页影响。
 const r=spawnSync(actual.path,['-I','-S','-B','-X','utf8',join(sourceGate.codeRoot,'loops','zcode_evidence_check.py'),...args],{input:Buffer.from(input,'utf8'),env,windowsHide:true,timeout:30000,maxBuffer:1024*1024,stdio:['pipe','pipe','pipe']});
 if(r.status!==0||!r.stdout||!r.stdout.every(byte=>byte<128))fail('EVIDENCE_CHECK_FAILED','证据合同脚本未正常结束');
 try{return JSON.parse(r.stdout.toString('ascii'));}catch{fail('EVIDENCE_CHECK_FAILED','证据合同脚本输出无效');}
}
function buildAppendix(c,sourceGate){
 const lines=evidenceTool(c,sourceGate,['prompt','--max-chars',String(c.evidence.max_chars)]);
 if(!Array.isArray(lines)||!lines.length||lines.some(line=>typeof line!=='string'))fail('EVIDENCE_CHECK_FAILED','证据合同提示无效');
 const appendix=PREAMBLE+'\n'+lines.join('\n');
 // 在打开调度器之前就拒:超长的提示不会走到消费许可那一步。
 if(appendix.length>APPENDIX_LIMIT||appendix.includes('\0'))fail('BAD_INPUT','提示附录超过 '+APPENDIX_LIMIT+' 个 UTF-16 单元',400);
 return appendix;
}

// ── 记账 ──────────────────────────────────────────────────────────────────
const ACCOUNTING='ACCOUNTING.json',ACCOUNTED='ACCOUNTED.json';
/** 排他创建一个标记文件;已存在返回 false。 */
function mark(file,value){
 let fd;try{fd=openSync(file,'wx',0o600);}catch(e){if(e.code==='EEXIST')return false;throw e;}
 try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 return true;
}
function ledgerHas(file,dispatchId){
 let text;try{text=readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return false;throw e;}
 return text.split('\n').some(line=>{if(!line.includes(dispatchId))return false;try{const row=JSON.parse(line);return row.dispatch_id===dispatchId&&row.runtime==='zcode';}catch{return false;}});
}
/**
 * 四节合同不合格时在卡上留痕,每个分派只留一次,不新增字段、不动状态、不改证据:
 * task_events 里一条记录(dispatch 链既有的写法),再在裁定记录栏末尾盖一条说明(与 store 的「—— 联动提示 ——」同形,面板显示这一栏)。
 * errors 是合同脚本自己的固定措辞,不含模型正文。
 */
function contractNote(db,d,errors){
 return atomic(db,()=>{
  if(db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='zcode.evidence_contract' AND json_extract(detail,'$.dispatch_id')=?").get(d.task_id,d.dispatch_id))return false;
  const at=new Date().toISOString();
  db.prepare("INSERT INTO task_events(at,task_id,kind,actor,detail) VALUES(?,?,'zcode.evidence_contract','zcode-worker',?)").run(at,d.task_id,canonical({dispatch_id:d.dispatch_id,run_id:d.run_id,contract_ok:false,errors:errors.length}));
  const note=['—— Zcode 证据合同('+at+')——','交付正文不符合四节合同('+errors.length+' 处)。本线没有要求重写,按原样进入待验收,请验收时自行判断。',...errors.slice(0,3).map(e=>'· '+e.slice(0,160))].join('\n');
  // 只在这张卡仍停在这次运行的交付上时写。
  db.prepare("UPDATE tasks SET verdict_note=CASE WHEN trim(coalesce(verdict_note,''))='' THEN ? ELSE verdict_note||char(10)||char(10)||? END,updated_at=? WHERE id=? AND run_id=? AND status='waiting' AND archived_at IS NULL").run(note,note,at,d.task_id,d.run_id);
  return true;
 });
}
/**
 * 结算后记账:四个布尔各自独立,不合并成一个「成功」。
 * 顺序是 记账中标记 → 账本行 → 已记账标记。账本行按 dispatch_id 至多一行:写之前先查账本里有没有。
 * 写不进去、没配账本或中途退出都停在「记账中」,之后任何一次调用(reconcile 会调)接着补,不会丢也不会重。
 * 返回账本行;账本里还没有这一行时返回 null。
 */
function account({db,c,sourceGate,root,emit},dispatchId){
 const d=dispatchStatus(db,dispatchId);if(d.phase!=='settled')return null;
 const directory=join(root,d.assignment_id);if(!existsSync(directory))return null;
 if(existsSync(join(directory,ACCOUNTED)))return null;
 mark(join(directory,ACCOUNTING),{format:'ai-fleet-zcode-accounting/v1',dispatch_id:d.dispatch_id,at:new Date().toISOString()});
 const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(d.task_id),run=db.prepare('SELECT * FROM task_runs WHERE run_id=?').get(d.run_id),context=run?JSON.parse(run.policy_json).context:{};
 const settled_success=d.result?.status==='success',delivered_via=d.result?.delivery??null;
 const task_read_observed=!!db.prepare("SELECT 1 FROM broker_audit WHERE principal_id=? AND tool_name='get_task' AND outcome='succeeded' LIMIT 1").get(d.principal_id);
 // 只核对这次运行自己交付的正文;卡已属于别的 run 或没有成功交付时记 null,不拿别人的结果充数。
 let contract_ok=null,contract_errors=null;
 if(settled_success&&t?.run_id===d.run_id&&['reported','existing_mcp_report_preserved'].includes(delivered_via)){
  try{const v=evidenceTool(c,sourceGate,['validate','--max-chars',String(c.evidence.max_chars)],String(t.result??''));contract_ok=v.ok===true;contract_errors=contract_ok?null:(Array.isArray(v.errors)?v.errors.map(String):[]);}
  catch(e){emit({kind:'attention',code:code(e),dispatch_id:d.dispatch_id});}
 }
 // 不合格不拦截,但验收的人要在卡上看得见;提示事件与卡上的说明同一次发出,补记时不重复。
 if(contract_ok===false){
  try{if(contractNote(db,d,contract_errors))emit({kind:'attention',code:'EVIDENCE_CONTRACT',task_id:d.task_id,task_uid:d.task_uid,dispatch_id:d.dispatch_id,errors:contract_errors.length});}
  catch(e){emit({kind:'attention',code:code(e),dispatch_id:d.dispatch_id});}
 }
 // 供应商没有给用量:五个键一律 null。看板归并遇 null 显示「待核实」,不会记成 0。
 // 与用量结算(core/usage.mjs)同一套键:line 写线名(worker 是「mcp:角色:分派」,从它推不出线);phase 沿用执行线的 initial(汇总读成 implement);
 // ok 显式写(reason 是诊断码,不写 ok 会被读成「没通过」);耗时取监管进程量到的墙钟,进程没起来或没有观察时是 null;费用未知。
 const activity=d.execution?.observation?.process?.activity;
 const duration_ms=activity&&activity.started_at!==null&&Number.isSafeInteger(activity.elapsed_ms)&&activity.elapsed_ms>=0?activity.elapsed_ms:null;
 const row={ts:stamp(),card:d.task_id,attempt:run?.last_attempt??null,worker:d.worker,line:c.line,run_id:d.run_id,agent_instance_id:d.agent_instance_id,model:context.model??null,effort:context.effort??null,runtime:'zcode',
  calls:null,in:null,cc:null,cr:null,out:null,note:'供应商未提供用量',round:1,phase:'initial',reason:d.execution?.observation?.diagnostic??d.result?.status??null,
  ok:settled_success,duration_ms,cost_usd:null,cost_source:'unknown',
  dispatch_id:d.dispatch_id,delivered_via,contract_ok,...(contract_errors?{contract_errors}:{}),task_read_observed,settled_success,host_verify:'not_applicable',host_commit:'not_applicable'};
 // 一次写入一整行。写不进去只报告,不阻塞结算。
 let written=false;
 if(c.ledger_file===null)emit({kind:'attention',code:'LEDGER_NOT_CONFIGURED',dispatch_id:d.dispatch_id});
 else try{if(!ledgerHas(c.ledger_file,d.dispatch_id))appendFileSync(c.ledger_file,JSON.stringify(row)+'\n');written=true;}catch{emit({kind:'attention',code:'LEDGER_WRITE_FAILED',dispatch_id:d.dispatch_id});}
 if(written)mark(join(directory,ACCOUNTED),{format:'ai-fleet-zcode-accounted/v1',dispatch_id:d.dispatch_id,at:new Date().toISOString()});
 emit({kind:'accounted',task_id:d.task_id,task_uid:d.task_uid,dispatch_id:d.dispatch_id,settled_success,delivered_via,task_read_observed,contract_ok,ledger_written:written});
 return written?row:null;
}

async function closeServer(server){if(!server?.listening)return;await new Promise((done,failed)=>{server.close(e=>e?failed(e):done());server.closeAllConnections();});}
const emitter=onEvent=>event=>{try{onEvent({format:'ai-fleet-zcode-worker-event/v1',at:new Date().toISOString(),...event});}catch{/* 日志不决定是否启动。 */}};
function prerequisites(sourceGate){
 if(process.platform!=='win32')fail('WINDOWS_REQUIRED','Zcode 执行循环仅支持 Windows');
 if(typeof sourceGate?.check!=='function')fail('BAD_INPUT','需要治理代码闸',400);
 sourceGate.check();
}

/**
 * 每个进程构造一次。关着开关时在任何副作用之前抛 ZCODE_LAUNCH_DISABLED。
 * 打开顺序:迁移 → 调度器(取锁、建根)→ 本机 MCP 监听;任一步失败逆序收尾,不留锁。
 */
export async function openZcodeWorker(db,{dbPath,sourceGate,config,environment=process.env,onEvent=()=>{}}){
 const c=validateZcodeWorkerConfig(config),p=profileOf(c);
 requireZcodeLaunchSwitch(c,environment);
 prerequisites(sourceGate);authorizationGate(c);ledgerGate(c);
 migratePeers(db);migrateDispatch(db);
 const gates=()=>{authorizationGate(c);return {role:roleGate(db,c),quota:budgetGate(db,c),coordinator:coordinatorGate(db,c)};};
 gates();
 const appendix=buildAppendix(c,sourceGate),emit=emitter(onEvent);
 // admit:调度器在领取每个请求之前再问一次同一个 refusal()。接卡前的清扫与领取之间即使插进别人的请求,也领不走不合格的卡。
 const admit=a=>{const t=db.prepare('SELECT * FROM tasks WHERE task_uid=?').get(a.task_uid);return t?verdict(db,c,t):'TASK_MISSING';};
 const scheduler=openScheduler(db,{dbPath,sourceGate,config:c.scheduler,environment,promptAppendix:appendix,admit,onEvent:e=>{try{onEvent(e);}catch{}}});
 let server=null;
 try{if(c.mcp!==null)server=await listenBroker(db,{port:c.mcp.port,boardUrl:c.mcp.board_url});}
 catch(e){try{scheduler.close({errorCode:code(e)});}catch{/* 保留现场供人工核对。 */}throw e;}
 const root=realpathSync(c.scheduler.root),books={db,c,sourceGate,root,emit},notices=new Set(),parked=new Map();let closed=false,busy=false,held='',fault=null;
 server?.on('error',e=>{fault??=code(e);});
 // 每卡每码只通知一次;事件只带代码与 ID,不带卡面正文和路径。
 const noted=(t,reason)=>{const key=t.task_uid+'\0'+reason;if(notices.has(key))return true;if(notices.size>=1024)notices.clear();notices.add(key);return false;};
 const reject=(t,reason)=>{if(!noted(t,reason))emit({kind:'rejected',task_id:t.id,task_uid:t.task_uid,code:reason});};

 /**
  * tick 之前的清扫:本项目/角色下每个等待执行器的请求都过同一个 refusal(),不管是谁建的。
  * 不合格的当场撤回并把拒收码写进请求。返回还在等调度器领取的请求数,以及上一轮没领到、请求仍留着的那些卡。
  */
 function sweep(){
  let live=0;const waiting=new Set();
  for(const a of pendingRequests(db,c)){
   if(a.refused){
    try{withdrawAssignment(db,{assignmentId:a.assignment_id,reason:'ZCODE_REFUSED:'+a.refused});}catch{continue;}
    if(a.task_id!==null)noted({task_uid:a.task_uid},a.refused);
    emit({kind:'rejected',task_id:a.task_id,task_uid:a.task_uid,code:a.refused,assignment_id:a.assignment_id,request:'withdrawn'});
   }else if(parked.has(a.assignment_id))waiting.add(a.task_uid);   // 上一轮没领到:不再占队首,调度器照旧每轮重试它
   else live++;
  }
  return {live,waiting};
 }
 /** 每轮最多新建一个分派请求;以协调身份在进程内调 request_assignment。 */
 function intake(coordinator){
  // 还有一个等调度器领取的有效请求时不接新卡。被改过的、不合格的、上一轮领不到的请求都不算,不能让它们把整条线卡住。
  const {live,waiting}=sweep();if(live)return null;
  for(const t of candidates(db,c)){
   if(waiting.has(t.task_uid))continue;   // 这张卡的请求还在、上一轮没领到:不重建请求,接它后面的卡
   const refused=verdict(db,c,t);if(refused){reject(t,refused);continue;}
   try{
    if(!admission(db,t.id))enrollZcodeTask(db,{taskId:t.id,projectId:p.project_id});
    const version=db.prepare('SELECT aggregate_version FROM tasks WHERE id=?').get(t.id).aggregate_version;
    const a=callTool(db,coordinator.authorization,'request_assignment',{request_id:randomUUID(),task_uid:t.task_uid,expected_version:version});
    if(a.state!=='waiting_executor'||a.role_id!==p.role_id){reject(t,'REQUEST_NOT_RUNNABLE');continue;}
    emit({kind:'requested',task_id:t.id,task_uid:t.task_uid,assignment_id:a.assignment_id});return a.assignment_id;
   }catch(e){reject(t,code(e));}
  }
  return null;
 }
 const worker={
  instance_id:scheduler.instance_id,
  async tick({stopSignal=null,cancelSignal=null}={}){
   if(closed)fail('ZCODE_WORKER_CLOSED','执行循环已经关闭');if(busy)fail('ZCODE_WORKER_BUSY','上一轮仍在执行');busy=true;
   try{
    if(fault)fail(fault,'本机 MCP 监听异常,请核对后重启执行循环');
    requireZcodeLaunchSwitch(c,environment);const g=gates(),q=g.quota;
    // 未结清排在预算之前:唯一一次预算恰好用在没结清的启动上时,要报的是「没结清」,不是「预算用尽、正常结束」。
    // 未结清的分派扣住整条线:本轮不接卡,也不调调度器。
    const open=occupied(db);
    if(open.length){
     const dispatches=open.map(d=>d.dispatch_id),key=canonical(open.map(d=>[d.dispatch_id,d.reason]));
     if(held!==key){held=key;emit({kind:'attention',code:'UNSETTLED_DISPATCH',dispatches,reasons:open.map(d=>d.reason)});}
     return {status:'needs_attention',requested:null,results:[],accounted:0,dispatches,holds:open.map(d=>({dispatch_id:d.dispatch_id,phase:d.phase,reason:d.reason,operator_attested:d.operator_attested}))};
    }
    held='';
    // 预算未启用或已用尽:不接卡、不调调度器。失败与超时同样占用额度,不退。
    if(!q.enabled)return {status:'budget_disabled',requested:null,results:[],accounted:0};
    if(q.used+q.reserved>=q.limit_total)return {status:'budget_exhausted',requested:null,results:[],accounted:0};
    const requested=stopSignal?.aborted?null:intake(g.coordinator);
    const round=await scheduler.tick({stopSignal,cancelSignal});
    let accounted=0,ran=0;const blocked=[];
    for(const r of round.results){
     if(r.dispatch_id){ran++;if(account(books,r.dispatch_id))accounted++;continue;}
     // 没领到(不占预算):记下来,下一轮不让它挡住后面的卡;每个请求每个码只提示一次。
     blocked.push({assignment_id:r.assignment_id,code:r.code});
     if(parked.get(r.assignment_id)!==r.code){if(parked.size>=1024)parked.clear();parked.set(r.assignment_id,r.code);emit({kind:'attention',code:'REQUEST_UNCLAIMABLE',assignment_id:r.assignment_id,reason:r.code});}
    }
    // 只有真的领取过才算 ran;有请求却一个也没领到是 blocked,不是 ran 也不是 idle。
    return {status:ran?'ran':blocked.length?'blocked':'idle',requested,results:round.results,accounted,...(blocked.length?{blocked}:{}),stopping:round.stopping};
   }finally{busy=false;}
  },
  /** 预算用尽是正常结束;有分派没结清也停下(调度锁要让给 reconcile),但那不是正常结束,调用方据 status 区分。 */
  async watch({stopSignal,cancelSignal=null}={}){
   if(!(stopSignal instanceof AbortSignal))fail('BAD_INPUT','持续运行需要停止信号',400);
   emit({kind:'started',line:c.line,poll_ms:c.scheduler.poll_ms,max_launches:c.launch.max_launches});
   let last=null;
   while(!stopSignal.aborted){
    const before=last?.status;last=await worker.tick({stopSignal,cancelSignal});
    if(last.status!==before)emit({kind:'status',status:last.status});
    if(last.status==='budget_exhausted'||last.status==='needs_attention'||last.stopping)break;
    if(!stopSignal.aborted)try{await delay(c.scheduler.poll_ms,undefined,{signal:stopSignal});}catch(e){if(e.name!=='AbortError')throw e;}
   }
   emit({kind:'stopped',status:last?.status??null});return last;
  },
  /** 只补交回执并补记账,从不启动。可重复执行。 */
  reconcile(assignmentId){
   if(closed)fail('ZCODE_WORKER_CLOSED','执行循环已经关闭');if(busy)fail('ZCODE_WORKER_BUSY','轮次执行时不能恢复');
   const r=scheduler.reconcile(assignmentId);return {...r,accounted:!!account(books,r.dispatch_id)};
  },
  status(){return {...zcodeWorkerStatus(db,c,environment),instance_id:scheduler.instance_id,appendix_units:appendix.length};},
  async close({errorCode=null}={}){
   if(closed)return;if(busy)fail('ZCODE_WORKER_BUSY','须等待在途轮次结束后关闭');closed=true;
   // 逆序收尾:先停本进程的 MCP 监听,再关调度器并删锁。
   try{await closeServer(server);}catch(e){errorCode??=code(e);}
   scheduler.close({errorCode});
  }
 };
 return worker;
}

/**
 * 只补交回执并补记账,从不启动,所以不要求启动开关、有效授权、协调凭据,也不监听端口。
 * 仍要过治理闸与调度器自己的开门检查(固定摘要、调度根身份、调度锁)。可重复执行。
 */
export function reconcileZcodeAssignment(db,{dbPath,sourceGate,config,assignmentId,environment=process.env,onEvent=()=>{}}){
 const c=validateZcodeWorkerConfig(config);
 prerequisites(sourceGate);ledgerGate(c);
 migratePeers(db);migrateDispatch(db);
 const scheduler=openScheduler(db,{dbPath,sourceGate,config:c.scheduler,environment,onEvent:e=>{try{onEvent(e);}catch{}}});
 let errorCode=null;
 try{
  const r=scheduler.reconcile(assignmentId);
  return {...r,accounted:!!account({db,c,sourceGate,root:realpathSync(c.scheduler.root),emit:emitter(onEvent)},r.dispatch_id)};
 }catch(e){errorCode=code(e);throw e;}
 finally{scheduler.close({errorCode});}
}

/**
 * 首次登记一条 Zcode 线:协调角色、执行角色、协调凭据、limit_total=1 且未启用的预算,
 * 并写出开关全关的配置骨架。不启动任何东西;已有同名角色或文件时拒绝,不覆盖。
 */
export function setupZcodeLine(db,{line,projectId,outDir,codeRoot}){
 names([line],'line',null,1);names([projectId],'project',null,1);
 const intakeRole=line+'-intake';names([intakeRole],'line',null,1);
 let directory;try{if(typeof outDir!=='string'||!isAbsolute(outDir))throw Error();directory=realpathSync(outDir);if(!statSync(directory).isDirectory())throw Error();}catch{fail('BAD_INPUT','--out-dir 须为已存在目录的绝对路径',400);}
 if(within(realpathSync(codeRoot),directory))fail('UNSAFE_RUNTIME_PATH','配置与凭据必须放在治理仓之外');
 const credentialFile=join(directory,line+'-coordinator.json'),configFile=join(directory,line+'-worker.config.json');
 if(existsSync(credentialFile)||existsSync(configFile))fail('CONFLICT','输出目录里已有同名配置或凭据,未覆盖');
 // 账本缺省放在看板 DB 所在目录:缺省布局下那就是看板数据目录,面板从那里读用量。
 const database=db.prepare('PRAGMA database_list').all().find(x=>x.name==='main')?.file;
 let ledgerFile=null;try{if(database)ledgerFile=join(dirname(realpathSync(database)),'usage_ledger.jsonl');}catch{/* 取不到就留 null,由操作者填。 */}
 migrateDispatch(db);
 const limits={max_task_attempts:1,max_open_tasks:100,requests_per_minute:60},node=localIdentity(db),pin=what=>({path:'<填:'+what+' 的绝对路径>',sha256:'<填:该文件的 SHA256>'});
 let issued=false,wrote=false;
 try{return atomic(db,()=>{
  for(const id of [line,intakeRole])if(getRole(db,id))fail('CONFLICT','角色 '+id+' 已登记;setup 只做首次登记');
  putRole(db,{role_id:intakeRole,kind:'coordinate',projects:[projectId],capabilities:[],runtime:null,model:null,effort:null,tools:'write',priority:10,enabled:true,limits});
  putRole(db,{role_id:line,kind:'implement',projects:[projectId],capabilities:['board-tools'],runtime:'zcode',model:'GLM-5.3',effort:'low',tools:'write',priority:10,enabled:true,limits});
  const quota=putQuota(db,{quota_id:randomUUID(),runtime:'zcode',execution_mode:'provider',projects:[projectId],limit_total:DEFAULT_MAX_LAUNCHES,enabled:false});
  issuePrincipal(db,{roleId:intakeRole,projects:[projectId],credentialFile});issued=true;
  const config={format:ZCODE_WORKER_FORMAT,launch:{enabled:false,max_launches:DEFAULT_MAX_LAUNCHES,authorization:{kind:'synthetic'}},line,
   intake:{coordinator_credential_file:credentialFile,auto_enroll:false},mcp:{port:43117,board_url:null},evidence:{max_chars:4000},ledger_file:ledgerFile,
   scheduler:{format:'ai-fleet-scheduler/v1',node_id:node.node_id,node_epoch:node.sync_epoch,root:join(directory,line+'-scheduler-root'),max_active:1,poll_ms:5000,
    profiles:[{project_id:projectId,role_id:line,quota_id:quota.quota_id,installation:{runtime:'zcode',version:'0.16.9',program:pin('Zcode 自带 node.exe'),bundle:pin('Zcode bundle'),builtin_config:pin('Zcode 公开供应商配置'),auth_home:'<填:已登录的 .zcode\\v2 目录的绝对路径>'},
     python:pin('python.exe'),node:pin('运行看板的 node.exe'),mcp_url:'http://127.0.0.1:43117',timeout_ms:600000,idle_timeout_ms:300000,workspace:null}]}};
  const fd=openSync(configFile,'wx',0o600);wrote=true;try{writeFileSync(fd,JSON.stringify(config,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  return {format:'ai-fleet-zcode-setup/v1',line,project_id:projectId,intake_role:intakeRole,quota_id:quota.quota_id,quota_enabled:false,limit_total:DEFAULT_MAX_LAUNCHES,launch_enabled:false,config_file:configFile,coordinator_credential_file:credentialFile,ledger_file:ledgerFile,started:false};
 });}catch(e){
  // 事务回滚后,只删本次新建的文件:凭据在库里已不存在,骨架也没有对应的预算。
  for(const file of [...(issued?[credentialFile]:[]),...(wrote?[configFile]:[])])try{unlinkSync(file);}catch{}
  throw e;
 }
}
