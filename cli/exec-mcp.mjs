// 桌面客户端以外部执行者身份接看板的 MCP stdio 入口(docs/多执行者协作.md「桌面客户端经 MCP 领卡」)。
import {serveExecStdio} from "../core/mcp/exec-bridge.mjs";
const usage="node cli/exec-mcp.mjs --url <本机看板根地址> --token-file <执行者令牌文件> [--line <只看这条线>]";
const args=process.argv.slice(2),opts={};
try{
 for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!args[i].startsWith("--")||!["url","token-file","line"].includes(key)||Object.hasOwn(opts,key)||!args[i+1])throw Error(usage);opts[key]=args[i+1];}
 if(!opts.url||!opts["token-file"])throw Error(usage);
 await serveExecStdio({url:opts.url,tokenFile:opts["token-file"],line:opts.line??null});
}catch(e){console.error(e.code??"EXEC_MCP_START_FAILED",e.message);process.exitCode=1;}
