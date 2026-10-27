// SDK 专用本机文件桥：只操作已绑定的物理工作仓，没有看板权限、删除或 shell 工具。
import {readFileSync,lstatSync,readdirSync,openSync,fstatSync,closeSync,writeSync,ftruncateSync,mkdirSync,realpathSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname,basename,relative,isAbsolute,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {artifactPath,MAX_FILE_BYTES} from '../core/artifacts/git-reader.mjs';
import {directoryIdentity,verifyDirectory} from '../core/artifacts/git-workspace.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const denied=name=>/^(?:\.env(?:\.|$)|\.claude$|\.codex$|auth$|agent_jobs$|board_token$|worker_token$|review_token$|panel_sessions\.json$|auth\.json$|credentials\.json$|fleet\.config\.json$|verify_registry\.json$)/i.test(name)||/\.(?:key|pem)$/i.test(name);
const schemas={
 list_files:{description:'列出工作仓中一个目录的普通文件和子目录；不列凭据或链接。',properties:{path:{type:'string'},after:{type:'string'}},required:[]},
 read_file:{description:'读取工作仓内 UTF-8 文件，返回摘要及字符分页。',properties:{path:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},required:['path']},
 write_file:{description:'新建或按当前 SHA-256 更新工作仓内 UTF-8 文件；新文件 expected_sha256=null。',properties:{path:{type:'string'},content:{type:'string'},expected_sha256:{type:['string','null']}},required:['path','content','expected_sha256']},
 edit_file:{description:'按摘要替换文件中的唯一一段文本，不允许删除文件。',properties:{path:{type:'string'},old_text:{type:'string'},new_text:{type:'string'},expected_sha256:{type:'string'}},required:['path','old_text','new_text','expected_sha256']},
};

export function canonicalWorkspacePath(path){
 if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw Error('WORKSPACE_PATH_UNSAFE');
 let existing=resolve(path);const missing=[];
 for(;;){
  try{return join(realpathSync.native(existing),...missing);}
  catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(existing);if(parent===existing)throw error;missing.unshift(basename(existing));existing=parent;}
 }
}

export function createWorkspaceTools(job){
 const identity=directoryIdentity(job.cwd),root=identity.root;
 if(typeof job.read_only!=='boolean')throw Error('WORKSPACE_PERMISSION_INVALID');
 if(!job.workspace||canonicalWorkspacePath(job.workspace.path)!==root||job.workspace.device!==identity.device||job.workspace.inode!==identity.inode)throw Error('WORKSPACE_IDENTITY_CHANGED');
 if(job.tools!==(job.read_only?'read-only':'write'))throw Error('WORKSPACE_PERMISSION_INVALID');
 if(!Array.isArray(job.protected_paths)||!job.protected_paths.length||job.protected_paths.length>512||job.protected_paths.some(path=>typeof path!=='string'||path.includes('\0')||!isAbsolute(path)))throw Error('WORKSPACE_PROTECTION_REQUIRED');
 const controls=job.protected_paths.map(canonicalWorkspacePath);
 const protectedPath=path=>{const canonical=canonicalWorkspacePath(path);return controls.some(control=>{const rel=relative(control,canonical);return !rel||rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);});};
 function target(path,{directory=false,create=false}={}){
  verifyDirectory(identity);
  if(directory&&(path===undefined||path==='')){if(protectedPath(root))throw Error('WORKSPACE_CONTROL_PATH_DENIED');return root;}
  artifactPath(path);
  const parts=path.split('/');if(parts.some(denied))throw Error('WORKSPACE_PRIVATE_PATH_DENIED');
  if(protectedPath(join(root,...parts)))throw Error('WORKSPACE_CONTROL_PATH_DENIED');
  let current=root;
  for(let i=0;i<parts.length;i++){
   current=join(current,parts[i]);let stat;
   try{stat=lstatSync(current);}catch(error){if(error.code!=='ENOENT'||!create)throw Error('WORKSPACE_PATH_MISSING');
    if(i<parts.length-1)mkdirSync(current);continue;}
   if(stat.isSymbolicLink()||i<parts.length-1&&!stat.isDirectory()||i===parts.length-1&&(directory?!stat.isDirectory():!stat.isFile()))throw Error('WORKSPACE_PATH_UNSAFE');
  }
  const rel=relative(root,current);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('WORKSPACE_PATH_UNSAFE');
  return current;
 }
 function read(path){
  const file=target(path),before=lstatSync(file),fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
   const opened=fstatSync(fd);if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>MAX_FILE_BYTES)throw Error('WORKSPACE_FILE_CHANGED');
   const bytes=readFileSync(fd);if(bytes.length>MAX_FILE_BYTES)throw Error('WORKSPACE_FILE_TOO_LARGE');
   return {file,stat:opened,bytes,text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
  }finally{closeSync(fd);}
 }
 function write(path,content,expected){
  if(job.read_only)throw Error('WORKSPACE_READ_ONLY');
  if(typeof content!=='string'||Buffer.byteLength(content)>MAX_FILE_BYTES)throw Error('WORKSPACE_CONTENT_INVALID');
  let previous=null;
  try{previous=read(path);}catch(error){if(error.message!=='WORKSPACE_PATH_MISSING')throw error;}
  if(previous?expected!==hash(previous.bytes):expected!==null)throw Error('WORKSPACE_VERSION_CHANGED');
  const file=target(path,{create:true}),fd=openSync(file,previous?'r+':'wx',0o600);
  try{
   const stat=fstatSync(fd);
   if(previous&&(stat.dev!==previous.stat.dev||stat.ino!==previous.stat.ino||hash(readFileSync(fd))!==expected))throw Error('WORKSPACE_VERSION_CHANGED');
   verifyDirectory(identity);const bytes=Buffer.from(content,'utf8');ftruncateSync(fd,0);
   let written=0;while(written<bytes.length)written+=writeSync(fd,bytes,written,bytes.length-written,written);
   return {path,sha256:hash(bytes),bytes:bytes.length};
  }finally{closeSync(fd);}
 }
 return {
  list:()=>Object.entries(schemas).filter(([name])=>!job.read_only||!['write_file','edit_file'].includes(name)).map(([name,s])=>({name,description:s.description,inputSchema:{type:'object',properties:s.properties,required:s.required,additionalProperties:false}})),
  call(name,args={}){
   if(!Object.hasOwn(schemas,name)||!args||typeof args!=='object'||Array.isArray(args))throw Error('WORKSPACE_TOOL_INVALID');
   const schema=schemas[name];if(Object.keys(args).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>!Object.hasOwn(args,k)))throw Error('WORKSPACE_INPUT_INVALID');
   if(name==='list_files'){
    const dir=target(args.path,{directory:true}),entries=readdirSync(dir,{withFileTypes:true}).filter(e=>!e.isSymbolicLink()&&!denied(e.name)&&e.name.toLowerCase()!=='.git'&&!protectedPath(join(dir,e.name))&&(e.isDirectory()||e.isFile())).map(e=>({path:(args.path?args.path+'/':'')+e.name,directory:e.isDirectory()})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const selected=entries.filter(e=>!args.after||e.path>args.after).slice(0,200);return {items:selected,next_after:selected.length===200?selected.at(-1).path:null};
   }
   if(name==='read_file'){
    const current=read(args.path),offset=args.offset??0,limit=args.limit??16384;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>16384)throw Error('WORKSPACE_RANGE_INVALID');
    const chars=Array.from(current.text),text=chars.slice(offset,offset+limit).join('');
    return {path:args.path,sha256:hash(current.bytes),text,next_offset:offset+Array.from(text).length,eof:offset+limit>=chars.length};
   }
   if(name==='write_file')return write(args.path,args.content,args.expected_sha256);
   const current=read(args.path);
   if(typeof args.old_text!=='string'||!args.old_text||typeof args.new_text!=='string'||current.text.split(args.old_text).length!==2)throw Error('WORKSPACE_EDIT_NOT_UNIQUE');
   return write(args.path,current.text.replace(args.old_text,args.new_text),args.expected_sha256);
  },
 };
}

export function createWorkspaceMcp(job){
 const tools=createWorkspaceTools(job);let state='new';const ids=new Set();
 return message=>{
  const id=message?.id,error=(code,message)=>({jsonrpc:'2.0',id:id??null,error:{code,message}});
  if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string')return error(-32600,'Invalid request');
  if(!Object.hasOwn(message,'id')){if(message.method==='notifications/initialized'&&state==='initializing')state='ready';return null;}
  if(!(typeof id==='string'||Number.isSafeInteger(id))||ids.has(typeof id+':'+id)||ids.size>=10000)return error(-32600,'Invalid request id');
  ids.add(typeof id+':'+id);
  if(message.method==='ping')return {jsonrpc:'2.0',id,result:{}};
  if(message.method==='initialize'){
   if(state!=='new')return error(-32600,'Already initialized');state='initializing';
   return {jsonrpc:'2.0',id,result:{protocolVersion:['2025-11-25','2025-06-18','2024-11-05'].includes(message.params?.protocolVersion)?message.params.protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:false}},serverInfo:{name:'kanban-workspace',version:'1.0.0'}}};
  }
  if(state!=='ready')return error(-32002,'Initialize first');
  if(message.method==='tools/list')return {jsonrpc:'2.0',id,result:{tools:tools.list()}};
  if(message.method!=='tools/call')return error(-32601,'Method not found');
  try{const result=tools.call(message.params?.name,message.params?.arguments);return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],isError:false}};}
  catch(e){return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:/^[A-Z_]+$/.test(e.message)?e.message:'WORKSPACE_TOOL_REFUSED'}],isError:true}};}
 };
}

async function main(jobPath){
 const job=JSON.parse(readFileSync(jobPath,'utf8'));const handle=createWorkspaceMcp(job);
 // 不将父 SDK 的模型或看板密钥留在文件桥环境中。
 for(const key of Object.keys(process.env))if(/(?:KEY|TOKEN|SECRET|PASSWORD)|^(?:BOARD_|WORKER_|ANTHROPIC_|OPENAI_)/i.test(key))delete process.env[key];
 const decoder=new TextDecoder('utf8',{fatal:true});let pending='';for await(const chunk of process.stdin){pending+=decoder.decode(chunk,{stream:true});if(Buffer.byteLength(pending)>256*1024)throw Error('MCP_INPUT_TOO_LARGE');
  for(;;){const end=pending.indexOf('\n');if(end<0)break;const line=pending.slice(0,end);pending=pending.slice(end+1);let response;
   try{response=handle(JSON.parse(line));}catch{response={jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}};}
   if(response)process.stdout.write(JSON.stringify(response)+'\n');
  }
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==2||!['--job','--identity'].includes(args[0]))throw Error('需要 --job 或 --identity');
 if(args[0]==='--identity')process.stdout.write(JSON.stringify(directoryIdentity(args[1]))+'\n');
 else main(args[1]).catch(()=>{console.error('文件桥已停止：输入或工作仓无效。');process.exitCode=1;});
}
