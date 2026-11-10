// 看板服务给面板的 Zcode 执行循环状态(只读)。循环是独立进程(cli/zcode-worker.mjs),看板不启动它。
// 这里只读看板库和 fleet.config.json 里 zcode_worker_config 指向的循环配置:不监听端口、不取调度锁、不跑证据脚本、不迁移库。
// 判定只用 zcode-worker.mjs 的 status()(与命令行 plan / status 是同一份),本模块只把它换成面板的形状并配上白话。
// 环境钥匙 BOARD_ZCODE_RELEASED 只在循环自己的终端里,看板服务看不到:released_env 恒为 null,也不读本进程的环境去猜。
// 白话只写状态和下一步(docs/style-guide.md「不写注释性语句」);拒收码的白话与 docs/Zcode接入.md「接卡规则」两张表同义。
import {isAbsolute} from 'node:path';
import {statSync} from 'node:fs';
import {readRecoveryJSON} from './recovery.mjs';
import {getRole} from './mcp/policy.mjs';
import {validateZcodeWorkerConfig,zcodeWorkerStatus,zcodeTaskVerdict} from './execution/zcode-worker.mjs';

const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const code=e=>typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:null;
/** 读的这段时间本连接切到 query_only:哪一步要是想写,报错而不是落库。读完恢复原样。 */
function readOnly(db,read){
 const was=db.prepare('PRAGMA query_only').get().query_only;
 if(!was)db.exec('PRAGMA query_only=ON');
 try{return read();}finally{if(!was)db.exec('PRAGMA query_only=OFF');}
}

const TEXT={
 no_pointer:'看板没有指向 Zcode 执行循环的配置。在 fleet.config.json 里把 zcode_worker_config 设为配置文件的绝对路径，重启看板。',
 not_setup:'看板库里还没有登记这条 Zcode 线。先运行 node cli/zcode-worker.mjs setup。',
 config_bad:'读不到 zcode_worker_config 指向的配置文件，或格式不对。按 docs/Zcode接入.md 核对这个文件。',
 unreadable:'Zcode 执行循环的状态暂时读不到。用 node cli/zcode-worker.mjs status 查看。',
 launch_off:'配置里的 launch.enabled 是 false，循环不会启动。要开启，按 docs/Zcode接入.md「怎么开真实调用」操作。',
 budget_off:'调用预算没有启用，循环不会启动。用 node cli/dispatch.mjs quota 启用。',
 attention:'占着并发位的运行已被记为结果不明，循环不会再启动。按 docs/Zcode接入.md「出问题时」处理。',
 gate:'有一道启动门没有通过。用 node cli/zcode-worker.mjs plan 查看是哪一道。',
};
const GATE_TEXT={
 AUTHORIZATION_EXPIRED:'调用授权还没生效或已经过期。更新配置里的 authorization 后再启动。',
 AUTHORIZATION_INVALID:'配置里的 authorization 无效。synthetic 只能配空的认证目录，真实调用改用 real 授权。',
 ROLE_UNSUPPORTED:'执行角色不符合 Zcode 线的要求。按 docs/Zcode接入.md 重新登记这条线。',
 ROLE_NOT_SINGLE_ATTEMPT:'执行角色的 max_task_attempts 不是 1。改回 1 后再启动。',
 POLICY_INVALID:'执行角色的已存策略读不出来。由本机管理员核对后更新。',
 BUDGET_UNAVAILABLE:'配置里的调用预算在库里没有登记。核对配置里的 quota_id。',
 BUDGET_EXCEEDS_DECLARED:'库内预算上限大于配置里的 max_launches。两边改成一致后再启动。',
 COORDINATOR_UNAVAILABLE:'协调凭据读不到、已失效或没有授权这个项目。重新发协调凭据后再启动。',
};
export const REFUSAL_TEXT=Object.freeze({
 VERIFY_UNSUPPORTED:'带登记验证的卡不能交给 Zcode',
 PROFILE_BOUND:'这张卡已经绑定了别的执行配置',
 ATTEMPTS_EXHAUSTED:'这张卡已经派发过一次',
 UNSETTLED_DISPATCH:'这张卡名下还有没结清的分派',
 NOT_ENROLLED:'这张卡没有登记到项目',
 PROJECT_MISMATCH:'这张卡或它的祖先登记在别的项目',
 ROLE_MISMATCH:'按项目、类别与能力选出的不是 Zcode 执行角色',
 DEPENDENCIES_UNFINISHED:'依赖的卡还没完成',
 BROKEN_DEPENDENCIES:'依赖字段损坏',
 CHILDREN_UNFINISHED:'还有没完成的子任务',
 ANCESTOR_NOT_RELEASED:'祖先任务没有放行',
 LOCK_HELD:'执行锁被另一张进行中的卡占着',
 ROOT_WIP_LIMIT:'同一根任务树里进行中的卡已到上限',
 TASK_TREE_HELD:'任务树正持有这张卡',
 TOPOLOGY_NOT_READY:'拓扑登记正持有这张卡',
 DELEGATION_NOT_READY:'委派正持有这张卡',
 LINE_MISMATCH:'这张卡的线不是 Zcode 线',
 ROUTE_MISMATCH:'这张卡的路由不是 mcp',
 NOT_RELEASED:'这张卡还没放行',
 HUMAN_GATE:'这张卡带人工闸',
 NOT_QUEUED:'这张卡不在未开始状态',
 NOT_A_TASK:'这张卡不是执行任务或已归档',
 TASK_CHANGED:'这张卡在请求之后被改过，原请求作废',
});
const REFUSAL_FALLBACK='Zcode 线拒收了这张卡';
let cached=null;
/** 读并校验循环配置,读不到或格式不对就抛。任务列表每行都要用:按路径、修改时刻与大小缓存,文件一改就重读。 */
function loadConfig(file){
 if(typeof file!=='string'||!isAbsolute(file))throw Error('zcode_worker_config 须为绝对路径');
 const st=statSync(file);
 if(cached?.file===file&&cached.mtimeMs===st.mtimeMs&&cached.size===st.size)return cached.config;
 const config=validateZcodeWorkerConfig(readRecoveryJSON(file));cached={file,mtimeMs:st.mtimeMs,size:st.size,config};
 return config;
}
const IN_FLIGHT=new Set(['run_active','unsettled_preparation']);

/** status() 的 state 换成面板的八态。unsettled = 有分派没结清;needs_attention = reconcile 也补不了、要人按手册处理。 */
function loopOf(s,alive){
 switch(s.state){
  case 'needs_attention':{
   if(s.unsettled.some(u=>u.operator_attested))return {state:'needs_attention',reason:TEXT.attention};
   const running=s.unsettled.every(u=>IN_FLIGHT.has(u.reason)),task=s.dispatches.find(d=>d.dispatch_id===s.unsettled[0]?.dispatch_id)?.task_id;
   if(alive&&running)return {state:'unsettled',reason:'Zcode 正在执行'+(task?' #'+task:'一张卡')+'。结算后这条线继续接卡。'};
   return {state:'unsettled',reason:'有 '+s.unsettled.length+' 个分派没结清，这条线停着。运行 node cli/zcode-worker.mjs reconcile 补回执。'};
  }
  case 'disabled':return {state:'disabled',reason:TEXT.launch_off};
  case 'budget_disabled':return {state:'disabled',reason:TEXT.budget_off};
  case 'blocked':return {state:'blocked',reason:GATE_TEXT[Object.values(s.gates).find(Boolean)]??TEXT.gate};
  case 'budget_exhausted':return {state:'budget_exhausted',reason:'调用预算已用完，'+s.budget.used+' / '+s.budget.limit_total+' 次。要再跑，同时调大库内预算和配置里的 max_launches。'};
  case 'ready':{
   const rows=[...s.candidates,...s.requests].filter(x=>x.task_id!==null),open=new Set(rows.filter(x=>x.refused===null).map(x=>x.task_id));
   if(open.size)return {state:'ready',reason:'有 '+open.size+' 张卡等 Zcode 接手'+(alive?'。':'，执行循环没有在运行。在循环自己的终端设 BOARD_ZCODE_RELEASED=1，再运行 node cli/zcode-worker.mjs watch。')};
   const refused=new Set(rows.filter(x=>x.refused).map(x=>x.task_id)).size;
   return {state:'idle',reason:refused?'没有可接的卡，'+refused+' 张被拒收。用 node cli/zcode-worker.mjs plan 查看拒收码。':'没有可接的卡。'};
  }
  default:return {state:'blocked',reason:TEXT.unreadable};
 }
}

/**
 * GET /api/zcode/status 的正文。configFile 是 fleet.config.json 的 zcode_worker_config(缺省 null)。
 * 没指配置或库里没登记:只给 configured:false 与 loop;指了但读不到:configured:true、loop.state=blocked、开关与预算记 null。
 */
export function zcodeStatus(db,{configFile=null}={}){
 const absent=reason=>({configured:false,loop:{state:'not_configured',reason}});
 const broken=reason=>({configured:true,switches:{budget_enabled:null,launch_enabled:null,released_env:null},budget:null,loop:{state:'blocked',reason}});
 if(configFile===null||configFile===undefined||configFile==='')return absent(TEXT.no_pointer);
 let config;
 try{config=loadConfig(configFile);}catch{return broken(TEXT.config_bad);}
 let s,model=null;
 try{s=readOnly(db,()=>zcodeWorkerStatus(db,config,null));}catch(e){return broken(GATE_TEXT[code(e)]??TEXT.unreadable);}
 if(!s.configured)return absent(TEXT.not_setup);
 try{model=getRole(db,s.line)?.policy.model??null;}catch{/* 读不出来就不给 model。 */}
 const beats=s.scheduler.map(i=>i.heartbeat_at).filter(x=>typeof x==='string').sort(),last=beats.at(-1);
 const alive=s.scheduler.some(i=>!i.ended_at&&i.heartbeat_state==='recent'),d=s.dispatches[0];
 return {configured:true,
  switches:{budget_enabled:s.budget?s.budget.enabled:null,launch_enabled:s.switch.config_enabled,released_env:null},
  budget:s.budget?{used:s.budget.used,limit:s.budget.limit_total,reserved:s.budget.reserved}:null,
  loop:{...loopOf(s,alive),...(last?{last_heartbeat_at:last}:{})},
  ...(d?{last_dispatch:{task_id:d.task_id,phase:d.phase,outcome:d.outcome??null,at:d.finished_at??d.launch_at??d.created_at}}:{}),
  ...(model?{model}:{})};
}

const REFUSED=/^ZCODE_REFUSED:([A-Z][A-Z0-9_]{0,79})$/;
/**
 * 卡级:route=mcp 且线是 Zcode 角色线(broker_roles 里 runtime=zcode)的卡才有;其余返回 null。只读。
 * request_state = 这张卡最近一个分派请求的状态,没有请求是 null。
 * 拒收码先取循环撤回请求时写的 ZCODE_REFUSED:<码>(refusal_source:"request");没有这条记录时,
 * 按 configFile 用 plan() 候选卡的同一判定(zcodeTaskVerdict)给码(refusal_source:"plan");配置读不到就不给。
 */
export function zcodeCard(db,t,{configFile=null}={}){
 if(!t||t.route!=='mcp'||typeof t.line!=='string'||!t.line)return null;
 try{
  if(!table(db,'broker_roles')||getRole(db,t.line)?.policy.runtime!=='zcode')return null;
  const a=table(db,'broker_assignments')?db.prepare('SELECT state,reason FROM broker_assignments WHERE task_uid=? ORDER BY created_at DESC,assignment_id DESC LIMIT 1').get(t.task_uid):null;
  let refusal=REFUSED.exec(a?.reason??'')?.[1]??null,source=refusal?'request':null;
  if(!refusal&&configFile)try{
   const verdict=readOnly(db,()=>zcodeTaskVerdict(db,loadConfig(configFile),t.id));
   if(verdict){refusal=verdict;source='plan';}
  }catch{/* 配置读不到就不给。 */}
  const dispatches=table(db,'broker_dispatches')?db.prepare('SELECT count(*) n FROM broker_dispatches WHERE task_id=?').get(t.id).n:0;
  return {request_state:a?.state??null,...(refusal?{refusal_code:refusal,refusal_text:REFUSAL_TEXT[refusal]??REFUSAL_FALLBACK,refusal_source:source}:{}),dispatches};
 }catch{return null;}   // 展示用的附加字段:读不出来就不给,不拖垮任务接口
}
/** taskOut 用:是 Zcode 卡给 {zcode},否则给 {}。configFile 同 zcodeStatus。 */
export const zcodeTaskField=(db,t,configFile=null)=>{const z=zcodeCard(db,t,{configFile});return z?{zcode:z}:{};};
