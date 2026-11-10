// Test-only host configuration: choose the listening origin before issuing credentials.
// Product credential checks are never disabled or patched; no credential file is rewritten.
import {execFileSync} from 'node:child_process';
import {issueCredential as issueBoundCredential,localIdentity} from '../../core/federation/peers.mjs';
import {listenPeerServer as listenBoundPeerServer} from '../../core/federation/gateway.mjs';
const origins=new Map();
// fetch 拒绝连接的端口(WHATWG Fetch「bad port」列表)。本机的动态端口段可能从 1024 起(netsh int ipv4 show dynamicport tcp),
// 系统分到其中一个时,测试里的 fetch 直接报 bad port —— 抽到就重抽。
const FETCH_BAD_PORTS=new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);
export function fixtureEndpoint(db){
 const key=localIdentity(db).node_id;if(!origins.has(key)){
  const code="import net from 'node:net';const s=net.createServer();s.on('error',()=>process.exit(1));s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});";
  let port;
  for(let i=0;i<20&&(port===undefined||FETCH_BAD_PORTS.has(port));i++)
   port=Number(execFileSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true,timeout:5000,stdio:['ignore','pipe','pipe']}));
  if(!Number.isInteger(port)||port<1||port>65535||FETCH_BAD_PORTS.has(port))throw Error('fixture port allocation failed');origins.set(key,'http://127.0.0.1:'+port);
 }
 return origins.get(key);
}
export function issueCredential(db,args){return issueBoundCredential(db,{serverEndpoint:fixtureEndpoint(db),...args});}
export function listenPeerServer(db,options={}){const port=Number(new URL(fixtureEndpoint(db)).port);return listenBoundPeerServer(db,{...options,port:options.port||port});}
