// 合成供应商:替身 Zcode bundle,只在测试里用。不联网、不调用任何模型。
// 它按 headless-stream 解码器合同输出事件,并经真实的 cli/mcp.mjs stdio 桥
// 调 get_task 与 report_result,从而证明「提示 → MCP → 回传 → 结算」这条链是通的。
// 行为由同目录的 <本文件名>.mode.json 决定:{mode,wait_ms,marker}。
//   success         读卡 → 按四节合同回传 → 最终回复同一份正文
//   no-report       读卡,不回传;最终回复按四节写(宿主代报)
//   bad-contract    读卡 → 回传一段不合四节的散文
//   fail            开始后以退出码 7 结束
//   idle            开始后不再输出(用于无输出时限)
//   bad-tool        声称调用一个未授权的原生工具
//   wrong-toolcount 上报的工具数与实际不符
"use strict";
const fs=require("node:fs"),path=require("node:path"),{spawn}=require("node:child_process"),{randomUUID}=require("node:crypto");
const EVIDENCE="# 给人看的结果\n合成供应商完成一次文字交付。\n无需人工操作。\n# 改动\n无\n# 检查\nsynthetic-check -> pass 1 / fail 0\n# 未决\n无\n";
const PROSE="合成供应商没有按四节书写,这是一段散文证据。";
const PROVIDER="account:bigmodel-individual-coding-plan";
module.exports={EVIDENCE,PROSE};

function settings(){
 try{return JSON.parse(fs.readFileSync(__filename+".mode.json","utf8"));}catch{return {};}
}
function model(){
 try{return JSON.parse(fs.readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,"utf8")).config.defaultModelSelection.modelId;}catch{return "GLM-5.3";}
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** 最小 MCP 客户端:逐行 JSON-RPC,一问一答。 */
function bridge(){
 const home=process.env.HOME||process.env.USERPROFILE;
 const server=JSON.parse(fs.readFileSync(path.join(home,".zcode","cli","config.json"),"utf8")).mcp.servers.fleet;
 const child=spawn(server.command,server.args,{windowsHide:true,stdio:["pipe","pipe","inherit"]});
 let buffer="",next=1;const waiting=new Map();
 const closed=new Promise(resolve=>child.once("close",resolve));
 child.stdout.on("data",chunk=>{
  buffer+=chunk.toString("utf8");
  for(;;){
   const end=buffer.indexOf("\n");if(end<0)break;
   const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
   const message=JSON.parse(line),slot=waiting.get(message.id);
   if(slot){waiting.delete(message.id);slot(message);}
  }
 });
 const request=(method,params)=>new Promise((resolve,reject)=>{
  const id=next++,timer=setTimeout(()=>reject(Error("bridge timeout: "+method)),20000);
  waiting.set(id,message=>{clearTimeout(timer);if(message.error)reject(Error("bridge error: "+method));else resolve(message.result);});
  child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,...(params===undefined?{}:{params})})+"\n");
 });
 const notify=method=>child.stdin.write(JSON.stringify({jsonrpc:"2.0",method})+"\n");
 // 先关桥的 stdin 并等它退出,再让本进程退出:不给 Job 留后代。
 const close=async()=>{child.stdin.end();await closed;};
 return {request,notify,close};
}

async function main(){
 const {mode="success",wait_ms=0,marker=null}=settings();
 if(marker)fs.appendFileSync(marker,String(process.pid)+"\n");
 const input=process.argv[process.argv.indexOf("--prompt")+1];
 const bound=JSON.parse(input.slice(input.lastIndexOf("\n")+1));
 let seq=0;
 const out=value=>process.stdout.write(JSON.stringify(value)+"\n");
 const event=(type,payload)=>{seq++;out({type,seq,eventId:"event"+seq,sessionId:"fixture",turnId:"turn",traceId:"trace",timestamp:seq,payload});};
 event("turn.started",{input});
 if(mode==="fail"){process.exitCode=7;return;}
 if(wait_ms)await sleep(wait_ms);
 const request=tools=>event("session.updated",{providerId:PROVIDER,modelId:model(),messageCount:1,toolCount:tools,iteration:0});
 if(mode==="idle"){request(5);await sleep(600000);return;}
 const mcp=bridge();
 try{
  await mcp.request("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"synthetic-zcode-vendor",version:"0"}});
  mcp.notify("notifications/initialized");
  const tools=(await mcp.request("tools/list")).tools;
  request(tools.length+(mode==="wrong-toolcount"?1:0));
  let calls=0;
  const call=async(name,args)=>{
   const toolCallId="call"+(++calls);
   event("tool.updated",{kind:"scheduled",toolCallId,toolName:mode==="bad-tool"?"Bash":"mcp__fleet__"+name});
   const result=await mcp.request("tools/call",{name,arguments:args});
   event("tool.updated",{kind:"result",toolCallId});
   if(result.isError)throw Error("tool refused: "+name);
   return result.structuredContent;
  };
  await call("get_task",{task_uid:bound.task_uid});
  const body=mode==="bad-contract"?PROSE:EVIDENCE;
  if(mode!=="no-report")await call("report_result",{request_id:randomUUID(),task_uid:bound.task_uid,run_id:bound.run_id,outcome:"done",evidence:body});
  event("turn.completed",{resultType:"success",response:body});
  out({type:"result",sessionId:"fixture",turnId:"turn",traceId:"trace",response:body,eventCount:seq,projection:{status:"completed",turnCount:1,totalTokenCount:0}});
 }finally{await mcp.close();}
}
if(require.main===module)main().catch(()=>{process.exitCode=process.exitCode||9;});
