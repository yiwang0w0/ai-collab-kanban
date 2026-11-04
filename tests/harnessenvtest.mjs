import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {harnessEnvironment} from './harness-env.mjs';

const dir=mkdtempSync(join(tmpdir(),'kanban-harness-env-'));
after(()=>{const rel=relative(resolve(tmpdir()),resolve(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true});});

test('继承部署配置不能抢占测试子进程的配置入口，五族扩展变量也不泄入',()=>{
  const config=join(dir,'deployment.json');
  writeFileSync(config,JSON.stringify({port:43199,repo:join(dir,'deployment-work'),codex_released:true}));
  const source={...process.env,BOARD_CONFIG:config,BOARD_REPO:join(dir,'inherited-work'),WORKER_ROLE_KIND:'review',
    REVIEWER_MODEL:'deployment-model',REVIEW_TOKEN:'deployment-token',KANBAN_API_KEY:'deployment-key',board_future_knob:'future'};
  const localConfig=join(dir,'missing-config.json');
  const child={...harnessEnvironment(source),BOARD_CONFIG:localConfig};
  const module=new URL('../core/env.mjs',import.meta.url).href;
  const program=`import {applyConfigDefaults,CONFIG_FILE} from ${JSON.stringify(module)};const config=applyConfigDefaults();console.log(JSON.stringify({path:CONFIG_FILE,config,keys:Object.keys(process.env).filter(k=>/^(BOARD_|WORKER_|REVIEWER_|REVIEW_|KANBAN_)/i.test(k))}));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',program],{cwd:dir,env:child,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const observed=JSON.parse(result.stdout);
  assert.equal(observed.path,localConfig,'真实配置加载器只读本测试入口');
  for(const key of ['BOARD_REPO','WORKER_ROLE_KIND','REVIEWER_MODEL','REVIEW_TOKEN','KANBAN_API_KEY','board_future_knob'])
    assert.ok(!observed.keys.includes(key),key+' 不得来自宿主');
  assert.equal(source.BOARD_CONFIG,config,'过滤不得修改调用方环境');
  assert.equal(child.PATH??child.Path,source.PATH??source.Path,'保留普通运行环境');
});

test('测试自己的显式配置仍可传入，过滤发生在覆盖之前',()=>{
  const config=join(dir,'fixture.json');writeFileSync(config,JSON.stringify({port:43200}));
  const env={...harnessEnvironment({...process.env,BOARD_PORT:'43199',WORKER_ROLE_KIND:'review'}),BOARD_CONFIG:config,WORKER_ROLE_KIND:'fixture'};
  const module=new URL('../core/env.mjs',import.meta.url).href;
  const r=spawnSync(process.execPath,['--input-type=module','-e',`import {applyConfigDefaults} from ${JSON.stringify(module)};applyConfigDefaults();console.log(JSON.stringify([process.env.BOARD_PORT,process.env.WORKER_ROLE_KIND]));`],{env,encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),['43200','fixture']);
});

test('服务类测试清单没有遗留的整份部署环境继承',()=>{
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('./harness-env-audit.mjs',import.meta.url))],
    {env:harnessEnvironment(),encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/服务类候选未隔离数\t0/);
});

test('测试进程在导入产品模块前已清除部署默认路由和人工闸',()=>{
  const helper=new URL('./harness-env.mjs',import.meta.url).href;
  const store=fileURLToPath(new URL('../core/store.js',import.meta.url));
  const script=`import ${JSON.stringify(helper)};import {createRequire} from 'node:module';import {DatabaseSync} from 'node:sqlite';const store=createRequire(import.meta.url)(${JSON.stringify(store)});const db=new DatabaseSync(':memory:');store.migrate(db);const id=store.add(db,{subject:'fixture'});const t=store.get(db,id);console.log(JSON.stringify([t.route,t.human_gate]));db.close();`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',windowsHide:true,
    env:{...process.env,BOARD_DEFAULT_ROUTE:'deployment-only',BOARD_HUMAN_GATE_PATTERN:'.*'}});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),['default',false]);
});
