// 机器清单只列静态候选与接线状态；每个宿主的显式参数仍须结合测试核对。
import {readFileSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=process.argv[2]?resolve(process.argv[2]):dirname(fileURLToPath(import.meta.url));
console.log('harness\t范围\t共享五族过滤\t整份继承行号');
let unsafe=0,candidates=0;
for(const file of readdirSync(root).filter(name=>/\.(mjs|js|py)$/.test(name)).sort()){
  if(file==='harness-env-audit.mjs')continue;
  const src=readFileSync(join(root,file),'utf8');
  if(!/\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/.test(src))continue;
  const service=file==='selftest.mjs'||/server\.mjs|worker_loop|reviewer_loop|sse_watch|board_health_watch/.test(src);
  const manual=file==='cli-boundary-probe.mjs'||file==='seven-module-baseline-probes.mjs';
  const shared=/import\s*\{[^}]*harnessEnvironment[^}]*\}\s*from\s*["']\.\/harness-env\.mjs["']/.test(src);
  const raw=src.split(/\r?\n/).flatMap((line,index)=>line.includes('...process.env')?[index+1]:[]);
  const firstImport=src.search(/^\s*import\b/m),entry=src.search(/import\s*\{[^}]*harnessEnvironment[^}]*\}\s*from\s*["']\.\/harness-env\.mjs["']/);
  const early=shared&&firstImport===entry;
  const kind=file==='cli-boundary-probe.mjs'?'人工真实探针，不自动运行':file==='seven-module-baseline-probes.mjs'?'历史漏洞复现，不作当前回归':file==='selftest.mjs'?'已登记库自检':service?'服务、循环或看守':'其他工具、数据库或夹具';
  console.log([file,kind,early?'首个导入':shared?'导入过晚':'未接入',raw.join(',')||'无'].join('\t'));
  if(service&&!manual){candidates++;if(!early||raw.length)unsafe++;}
}
console.log('服务类候选未隔离数\t'+unsafe);
if(!candidates)console.error('没有找到服务类候选，不能记为已检查。');
process.exitCode=unsafe||!candidates?1:0;
