// Zcode 独立执行循环的本机命令。没有任何绕过开关启动模型的命令。
import {fileURLToPath} from 'node:url';
import {openPeerDatabase} from '../core/federation/peers.mjs';
import {migrateSync} from '../core/federation/sync-store.mjs';
import {createSourceGate} from '../core/execution/source-gate.mjs';
import {openSchedulerControlDatabase} from '../core/execution/lifecycle.mjs';
import {readRecoveryJSON} from '../core/recovery.mjs';
import {openZcodeWorker,requireZcodeLaunchSwitch,validateZcodeWorkerConfig,zcodeWorkerPlan,zcodeWorkerStatus,setupZcodeLine,enqueueZcodeTask} from '../core/execution/zcode-worker.mjs';
const usage=['node cli/zcode-worker.mjs plan|status --db <本机DB绝对路径> --config-file <配置JSON>      只读:开关、预算、候选卡与拒收码',
 'node cli/zcode-worker.mjs setup --db <本机DB绝对路径> --line <线名> --project <项目> --out-dir <仓库外的已有目录>      登记角色、凭据与未启用的预算,写出开关全关的配置骨架',
 'node cli/zcode-worker.mjs enqueue --db <本机DB绝对路径> --task <卡ID> --version <所见任务版本> --config-file <配置JSON>      把一张卡交给 Zcode 线并登记祖先链',
 'node cli/zcode-worker.mjs once|watch --db <本机DB绝对路径> --config-file <配置JSON> --accepted-rev <治理验收文件>',
 'node cli/zcode-worker.mjs reconcile --db <本机DB绝对路径> --config-file <配置JSON> --accepted-rev <治理验收文件> --assignment <请求ID>      只补交回执并补记账,不启动',
 'once / watch 需要三把钥匙:预算已启用;配置 launch.enabled=true 且 authorization 有效;环境变量 BOARD_ZCODE_RELEASED=1。',
 'watch 首次 Ctrl+C 等待在途结束;再次 Ctrl+C 或 SIGTERM 取消在途。已消费许可的任务不会自动重启,额度不退。',
 '异常退出残留锁:使用 cli/runtime-lock.mjs prepare/apply;结果不明的运行:cli/dispatch.mjs prepare-uncertain / record-uncertain。'].join('\n');
const FIELDS={plan:['db','config-file'],status:['db','config-file'],setup:['db','line','project','out-dir'],enqueue:['db','task','version','config-file'],
 once:['db','config-file','accepted-rev'],watch:['db','config-file','accepted-rev'],reconcile:['db','config-file','accepted-rev','assignment']};
const errorCode=e=>typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'ZCODE_WORKER_ERROR';
let db,worker,failure=null;
try{
 const [command,...args]=process.argv.slice(2);
 if(!command||command==='--help')console.log(usage);
 else{
  const fields=FIELDS[command];if(!fields)throw Error(usage);
  const o={};for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!fields.includes(k)||Object.hasOwn(o,k)||!args[i+1]||args[i+1].startsWith('--'))throw Error(usage);o[k]=args[i+1];}
  if(fields.some(k=>!o[k]))throw Error(usage);
  const codeRoot=fileURLToPath(new URL('../',import.meta.url));
  if(command==='plan'||command==='status'){
   db=openSchedulerControlDatabase(o.db,{readOnly:true});
   console.log(JSON.stringify((command==='plan'?zcodeWorkerPlan:zcodeWorkerStatus)(db,readRecoveryJSON(o['config-file']),process.env)));
  }else if(command==='setup'){
   db=openPeerDatabase(o.db);migrateSync(db);
   console.log(JSON.stringify(setupZcodeLine(db,{line:o.line,projectId:o.project,outDir:o['out-dir'],codeRoot})));
  }else if(command==='enqueue'){
   if(!/^[1-9][0-9]{0,14}$/.test(o.task)||!/^[1-9][0-9]{0,14}$/.test(o.version))throw Error(usage);
   db=openPeerDatabase(o.db);
   console.log(JSON.stringify(enqueueZcodeTask(db,{taskId:Number(o.task),expectedVersion:Number(o.version),config:readRecoveryJSON(o['config-file'])})));
  }else{
   // 开关先于一切:关着时不开写连接、不迁移、不取锁、不监听。
   const config=validateZcodeWorkerConfig(readRecoveryJSON(o['config-file']));requireZcodeLaunchSwitch(config,process.env);
   const sourceGate=createSourceGate({codeRoot,approvalFile:o['accepted-rev']});sourceGate.check();
   db=openSchedulerControlDatabase(o.db);
   worker=await openZcodeWorker(db,{dbPath:o.db,sourceGate,config,onEvent:e=>console.log(JSON.stringify(e))});
   const stop=new AbortController(),cancel=new AbortController();
   const interrupt=()=>{if(stop.signal.aborted)cancel.abort();stop.abort();},terminate=()=>{cancel.abort();stop.abort();};
   process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
   try{
    if(command==='watch')console.log(JSON.stringify(await worker.watch({stopSignal:stop.signal,cancelSignal:cancel.signal})));
    else if(command==='once')console.log(JSON.stringify(await worker.tick({stopSignal:stop.signal,cancelSignal:cancel.signal})));
    else console.log(JSON.stringify(worker.reconcile(o.assignment)));
   }finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
  }
 }
}catch(e){failure=errorCode(e);if(e?.message===usage)console.error(usage);console.error(JSON.stringify({status:'failed',code:failure,message:'Zcode 执行循环命令失败;请核对开关、配置、预算、治理验收和运行回执。未授权自动重试。'}));process.exitCode=1;}
finally{try{await worker?.close({errorCode:failure});}catch(e){console.error(JSON.stringify({status:'failed',code:errorCode(e),message:'执行循环关闭未完整记录;请保留锁和证据核对。'}));process.exitCode=1;}finally{db?.close();}}
