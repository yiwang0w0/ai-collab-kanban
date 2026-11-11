// 桌面客户端以外部执行者身份接看板的 MCP stdio 入口(docs/多执行者协作.md「桌面客户端经 MCP 领卡」「凭码接入」)。
// --code:令牌文件不存在时先用一次性码兑换令牌并写入;令牌文件已存在就忽略 --code。只给 --token-file 的旧用法不变。
import {serveExecStdio,redeemToFile} from "../core/mcp/exec-bridge.mjs";
const usage="node cli/exec-mcp.mjs --url <本机看板根地址> --token-file <执行者令牌文件> [--line <只看这条线>] [--code <操作员发的一次性码>]";
const args=process.argv.slice(2),opts={};
try{
 for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!args[i].startsWith("--")||!["url","token-file","line","code"].includes(key)||Object.hasOwn(opts,key)||!args[i+1])throw Error(usage);opts[key]=args[i+1];}
 if(!opts.url||!opts["token-file"])throw Error(usage);
 let line=opts.line??null;
 if(opts.code){const r=await redeemToFile({url:opts.url,code:opts.code,tokenFile:opts["token-file"],line});
  if(r.redeemed){line=line??r.line;console.error(`EXEC_MCP_REDEEMED 已凭码接入线 ${r.line},令牌已保存`);}}
 await serveExecStdio({url:opts.url,tokenFile:opts["token-file"],line});
}catch(e){console.error(e.code??"EXEC_MCP_START_FAILED",e.message);process.exitCode=1;}
