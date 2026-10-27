// 官方 Codex SDK 的 API 单任务入口；模型循环由 SDK 提供，文件工具限定到本次工作仓。
import {readFileSync,statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspaceTools,canonicalWorkspacePath} from './workspace_tools.mjs';

const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function validateJob(job){
 if(!job||job.format!=='kanban-agent-job/v1'||job.channel!=='codex_sdk_api'||job.runtime!=='codex'||!Number.isSafeInteger(job.task_id)||job.task_id<=0||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(job.execution_profile_id)||!/^[a-f0-9]{64}$/.test(job.profile_digest))throw Error('SDK_JOB_INVALID');
 for(const key of ['run_id','agent_instance_id'])if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(job[key]))throw Error('SDK_IDENTITY_INVALID');
 if(typeof job.model!=='string'||!job.model.trim()||!['minimal','low','medium','high','xhigh','max'].includes(job.effort)||typeof job.read_only!=='boolean'||!isAbsolute(job.cwd)||!statSync(job.cwd).isDirectory())throw Error('SDK_OPTIONS_INVALID');
 if(!job.budget||!['timeout_sec','max_turns','max_cost_usd'].every(k=>nonnegative(job.budget[k])&&job.budget[k]>0)||!Number.isSafeInteger(job.budget.max_turns))throw Error('SDK_BUDGET_REQUIRED');
 const stat=statSync(job.cwd,{bigint:true});
 if(!job.workspace||canonicalWorkspacePath(job.workspace.path)!==canonicalWorkspacePath(job.cwd)||job.workspace.device!==stat.dev.toString()||job.workspace.inode!==stat.ino.toString())throw Error('SDK_WORKSPACE_IDENTITY_CHANGED');
 if(job.tools!==(job.read_only?'read-only':'write'))throw Error('SDK_PERMISSION_INVALID');
 if(!Array.isArray(job.protected_paths)||!job.protected_paths.length||job.protected_paths.length>512||job.protected_paths.some(path=>typeof path!=='string'||path.includes('\0')||!isAbsolute(path)))throw Error('SDK_PROTECTION_REQUIRED');
 return job;
}
export function loadJob(path){
 const source=canonicalWorkspacePath(path);if(statSync(source).size>1024*1024)throw Error('SDK_JOB_TOO_LARGE');
 const job=validateJob(JSON.parse(readFileSync(source,'utf8'))),prompt=canonicalWorkspacePath(job.prompt_file);
 if(dirname(prompt)!==dirname(source)||statSync(prompt).size>256*1024)throw Error('SDK_PROMPT_PATH_INVALID');
 return {...job,prompt:readFileSync(prompt,'utf8'),jobPath:source};
}
const event=(job,kind,fields={})=>({format:'kanban-agent-event/v1',task_id:job.task_id,run_id:job.run_id,agent_instance_id:job.agent_instance_id,
 execution_profile_id:job.execution_profile_id,profile_digest:job.profile_digest,model:job.model,effort:job.effort,event_id:randomUUID(),kind,...fields});
export function sdkOptions(job,environment){
 const key=environment.OPENAI_API_KEY||environment.CODEX_API_KEY;
 if(!key||!environment.CODEX_HOME)throw Error('SDK_CREDENTIAL_REQUIRED');
 const env=Object.fromEntries(Object.entries(environment).filter(([k])=>/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|HTTPS_PROXY|HTTP_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i.test(k)));
 env.CODEX_HOME=environment.CODEX_HOME;
 const tools=createWorkspaceTools(job).list().map(t=>t.name),bridge=fileURLToPath(new URL('./workspace_tools.mjs',import.meta.url));
 return {apiKey:key,baseUrl:'https://api.openai.com/v1',env,
  config:{forced_login_method:'api',cli_auth_credentials_store:'ephemeral',model_provider:'openai',
   project_doc_max_bytes:0,
   features:{shell_tool:false,unified_exec:false,web_search:false,apps:false,plugins:false,hooks:false,memories:false,multi_agent:false},
   mcp_servers:{kanban_workspace:{command:process.execPath,args:[bridge,'--job',job.jobPath],env_vars:[],enabled:true,required:true,enabled_tools:tools}},
   shell_environment_policy:{inherit:'core',ignore_default_excludes:false}},
  configOverrides:[],
 };
}

export async function runJob(job,{createCodex,emit,environment=process.env,signal=null}={}){
 validateJob(job);const options=sdkOptions(job,environment),controller=new AbortController();
 const timer=setTimeout(()=>controller.abort('timeout'),job.budget.timeout_sec*1000);
 const cancelled=()=>controller.abort('cancelled');if(signal?.aborted)cancelled();else signal?.addEventListener('abort',cancelled,{once:true});
 let terminal=null,session=null,report=null,steps=0,completed=0,usage=null;
 emit(event(job,'started',{budget_enforcement:'timeout_and_steps',cost_usd:null}));
 try{
  if(controller.signal.aborted)throw Error('SDK_CANCELLED');
  const codex=await createCodex(options),thread=codex.startThread({model:job.model,workingDirectory:dirname(job.jobPath),modelReasoningEffort:job.effort,
   sandboxMode:'read-only',approvalPolicy:'never',additionalDirectories:[],skipGitRepoCheck:true,networkAccessEnabled:false,webSearchMode:'disabled'});
  const {events}=await thread.runStreamed(job.prompt,{signal:controller.signal});
  for await(const item of events){
   if(controller.signal.aborted)throw Error('SDK_ABORTED');
   if(item.type==='thread.started')session=item.thread_id;
   if(item.type==='item.started'&&item.item?.type==='mcp_tool_call'&&++steps>job.budget.max_turns){controller.abort('steps');throw Error('SDK_STEP_BUDGET');}
   if(item.type==='item.completed'){
    if(item.item?.type==='agent_message')report=item.item.text;
    if(item.item?.type==='command_execution'||item.item?.type==='web_search'||item.item?.type==='error'||item.item?.type==='mcp_tool_call'&&(item.item.server!=='kanban_workspace'||item.item.status==='failed'))throw Error('SDK_UNAPPROVED_TOOL');
    emit(event(job,'activity',{session_id:session}));
   }
   if(item.type==='error'||item.type==='turn.failed')throw Error('SDK_PROVIDER_FAILED');
   if(item.type==='turn.completed'){
    if(++completed!==1)throw Error('SDK_DUPLICATE_TERMINAL');
    const raw=item.usage;usage=raw&&typeof raw==='object'?Object.fromEntries(['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens'].map(k=>[k,nonnegative(raw[k])?raw[k]:null])):null;
   }
  }
  if(completed!==1||typeof report!=='string'||!report.trim())throw Error('SDK_TERMINAL_MISSING');
  terminal={status:'success',diagnostic:'SUCCESS',report,usage,cost_usd:null,session_id:session,budget_enforcement:'timeout_and_steps'};
 }catch{
  const reason=controller.signal.reason;
  terminal={status:reason==='timeout'?'timeout':reason==='cancelled'?'cancelled':'failed',diagnostic:reason==='timeout'?'SDK_TIMEOUT':reason==='steps'?'SDK_STEP_BUDGET':'SDK_PROTOCOL_OR_PROVIDER_ERROR',report:null,usage,cost_usd:null,session_id:session,budget_enforcement:'timeout_and_steps'};
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancelled);}
 emit(event(job,'terminal',terminal));return terminal.status==='success';
}

async function main(path){
 const job=loadJob(path),emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
 const {Codex}=await import('@openai/codex-sdk');
 return await runJob(job,{createCodex:options=>new Codex(options),emit})?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--job')throw Error('需要 --job');
 main(args[1]).then(code=>{process.exitCode=code;}).catch(()=>{console.error('SDK 入口拒绝：输入、凭据或运行时尚未就绪。');process.exitCode=2;});
}
