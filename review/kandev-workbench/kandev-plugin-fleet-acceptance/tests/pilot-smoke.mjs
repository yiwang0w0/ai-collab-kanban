import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = resolve(pluginRoot, '..');
const hostRoot = join(base, 'kandev');
const requireHost = createRequire(join(hostRoot, 'apps/web/package.json'));
const { chromium, expect } = requireHost('@playwright/test');
mkdirSync(join(pluginRoot, '.build'), { recursive: true });
const runtime = mkdtempSync(join(pluginRoot, '.build/pilot-'));
const homeDir = join(runtime, 'home');
const repoRoot = join(runtime, 'fixture-repo');
const configPath = join(runtime, 'config.yaml');
mkdirSync(join(repoRoot, 'src'), { recursive: true });
writeFileSync(join(repoRoot, 'src/app.js'), 'export const value = 1;\n');
const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'pipe', windowsHide: true });
git('init', '-qb', 'main'); git('config', 'core.longpaths', 'true'); git('add', '.'); git('-c', 'user.name=验收测试', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', '验收夹具');
const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const config = {
  server: { host: '127.0.0.1', port, webTitlePrefix: '复用试点（模拟）' },
  auth: { jwtSecret: randomBytes(32).toString('hex') },
  features: { auth: true },
  tasks: { completionVerifierId: 'plugin:pending-installation', completionNodePath: process.execPath,
    completionCheckerPath: join(base, 'board/cli/check-delivery.mjs'), completionRepositoryId: 'pending-repository', completionRepositoryRoot: repoRoot },
  docker: { enabled: false },
};
let processHost;
const log = createWriteStream(join(runtime, 'backend.log'), { flags: 'a' });
const childEnv = { ...process.env, KANDEV_HOME_DIR: homeDir, KANDEV_INTERNAL_CONFIG_FILE: configPath,
  KANDEV_DATABASE_PATH: join(homeDir, 'data/kandev.db'), KANDEV_WEB_DIST_DIR: join(hostRoot, 'apps/web/dist'),
  KANDEV_E2E_MOCK: 'true', KANDEV_MOCK_PROVIDERS: 'claude-acp,codex-acp', KANDEV_FEATURES_AUTH: 'true',
  KANDEV_DOCKER_ENABLED: 'false', PATH: join(hostRoot, 'apps/backend/bin') + ';' + process.env.PATH };

async function poll(check, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { if(error.code==='FIXTURE_FATAL')throw error; last = error; }
    await delay(200);
  }
  throw new Error(`${label}超时${last ? ': ' + last.message : ''}`);
}
async function start() {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  processHost = spawn(join(hostRoot, 'apps/backend/bin/kandev-fleet.exe'), ['__backend'], { env: childEnv, cwd: hostRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processHost.stdout.pipe(log, { end: false }); processHost.stderr.pipe(log, { end: false });
  await poll(async () => {
    if (processHost.exitCode !== null) throw Object.assign(new Error(`隔离宿主退出：${processHost.exitCode}`),{code:'FIXTURE_FATAL'});
    const response = await fetch(baseUrl + '/health');
    return response.ok && (await response.json()).status !== 'starting';
  }, '隔离宿主启动');
  await poll(async () => (await fetch(baseUrl + '/api/v1/auth/me')).status === 200, '认证接口就绪');
}
async function stop() {
  if (!processHost || processHost.exitCode !== null) return;
  const exited = once(processHost, 'exit');
  try { execFileSync('taskkill', ['/PID', String(processHost.pid), '/T', '/F'], { stdio: 'pipe', windowsHide: true }); } catch {}
  await exited;
}

let browser, context, page;
try {
  console.log('开始隔离模拟验收；不会调用真实 Claude/Codex。');
  await start();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const request = async (method, path, data, status = 200) => {
    let headers;
    if (method !== 'GET' && path !== '/api/v1/auth/setup') {
      const bootstrap = await context.request.get(baseUrl + '/api/v1/app-state?path=%2Fsettings%2Fagents');
      assert.equal(bootstrap.status(), 200, '无法取得当前启动代的原生设置中继令牌');
      const token = (await bootstrap.json()).interimSettingsInterlockToken;
      assert.ok(token, '原生设置中继令牌缺失');
      headers = { 'X-Kandev-Interim-Settings-Interlock': token };
    }
    const response = await context.request.fetch(baseUrl + path, { method, headers, ...(data ? { data } : {}) });
    const text = await response.text();
    assert.ok(status === 201 ? [200, 201].includes(response.status()) : response.status() === status, `${method} ${path}: ${response.status()} ${text.slice(0, 700)}`);
    return text ? JSON.parse(text) : null;
  };
  await request('POST', '/api/v1/auth/setup', { email: 'pilot@example.invalid', password: randomBytes(24).toString('base64url'), display_name: '验收夹具' });
  assert.equal((await request('GET', '/api/v1/auth/me')).mode, 'enabled', '模拟验收必须使用真实登录身份，不接受匿名合成管理员');
  const workspace = await request('POST', '/api/v1/workspaces', { name: '单机复用模拟验收' }, 201);
  const repo = await request('POST', `/api/v1/workspaces/${workspace.id}/repositories`, { name: 'fleet-acceptance-fixture', source_type: 'local', local_path: repoRoot, default_branch: 'main', pull_before_worktree: false }, 201);
  const workflow = await request('POST', '/api/v1/workflows', { workspace_id: workspace.id, name: '方案—实施—独立审查—人工验收' }, 201);
  const agents = (await request('GET', '/api/v1/agents')).agents;
  const agentId = name => { const match = agents.filter(agent => agent.name === name); assert.equal(match.length,1,'模拟运行时记录未唯一解析'); return match[0].id; };
  const implementationAgentId = agentId('claude-acp'), reviewAgentId = agentId('codex-acp');
  const makeProfile = async (agent, name) => {
    const result = await request('POST', `/api/v1/agents/${agent}/profiles`, { name, model: 'mock-fast', auto_approve: true, cli_passthrough: false }, 201);
    return result.profile || result;
  };
  const implementationProfile = await makeProfile(implementationAgentId, 'Claude 实现（模拟）');
  const reviewProfile = await makeProfile(reviewAgentId, 'Codex 独立审查（模拟）');
  const makeStep = (name, position, opts = {}) => request('POST', '/api/v1/workflow/steps', { workflow_id: workflow.id, name, position, ...opts }, 201);
  const implementationStep = await makeStep('实施', 0, { is_start_step: true, agent_profile_id: implementationProfile.id, profile_session_end_policy: 'park' });
  const reviewStep = await makeStep('独立审查', 1, { agent_profile_id: reviewProfile.id, profile_session_end_policy: 'park', events: { on_enter: [{ type: 'auto_start_agent' }] } });
  const acceptanceStep = await makeStep('人工验收', 2, { profile_session_end_policy: 'park' });
  const doneStep = await makeStep('完成', 3, { complete_task_on_enter: true });
  const executors = (await request('GET','/api/v1/executors')).executors;
  const worktreeProfile = executors.find(executor => executor.type === 'worktree')?.profiles?.[0];
  assert.ok(worktreeProfile?.id,'缺少原生 Worktree 执行配置');
  const packagePath = join(pluginRoot, 'kandev-plugin-fleet-acceptance-0.1.0.tar.gz');
  const installed = await context.request.post(baseUrl + '/api/plugins/install', { multipart: { package: { name: basename(packagePath), mimeType: 'application/gzip', buffer: readFileSync(packagePath) } } });
  assert.equal(installed.status(), 201, await installed.text());
  const pluginId = 'kandev-plugin-fleet-acceptance';
  const plugin = (await installed.json()).plugin;
  const capability = await request('GET', `/api/plugins/${pluginId}/capability-approvals?workspace_id=${workspace.id}`);
  assert.ok(capability.installation_id, '安装未产生宿主身份');
  await request('PUT', `/api/plugins/${pluginId}/capability-approvals`, { workspace_id: workspace.id, expected_revision: 0, manifest_digest: capability.manifest_digest, capability_ids: ['host.v2.read:tasks', 'host.v2.read:sessions', 'host.v2.write:tasks'], reason: '隔离模拟验收', audit_id: randomUUID() });
  await request('PATCH', `/api/plugins/${pluginId}`, { config: { node_path: process.execPath, checker_path: config.tasks.completionCheckerPath, repository_id: repo.id, repository_root: repoRoot, acceptance_step_id: acceptanceStep.id, implementation_agent_id: implementationAgentId, review_agent_id: reviewAgentId } });
  config.tasks.completionVerifierId = `plugin:${capability.installation_id}`;
  config.tasks.completionRepositoryId = repo.id;
  await stop(); await start();
  await poll(async () => (await request('GET', `/api/plugins/${pluginId}`)).status === 'active', '插件激活');
  console.log('已安装插件并完成工作区授权。');
  const task = await request('POST', '/api/v1/tasks', { workspace_id: workspace.id, workflow_id: workflow.id, workflow_step_id: implementationStep.id, title: '复用门禁隔离任务', description: 'e2e:message("实现已完成，交付 src/app.js")', start_agent: true, agent_profile_id: implementationProfile.id, executor_profile_id:worktreeProfile.id, repositories: [{repository_id:repo.id,base_branch:'main'}] }, 201);
  const sessions = () => request('GET', `/api/v1/tasks/${task.id}/sessions`);
  const waitSession = profile => poll(async () => {
    const all = (await sessions()).sessions;
    const session = all.find(s => s.agent_profile_id === profile);
    if (session?.state === 'FAILED') throw Object.assign(new Error(session.error_message || '模拟会话失败'),{code:'FIXTURE_FATAL'});
    return session && ['WAITING_FOR_INPUT', 'COMPLETED', 'IDLE'].includes(session.state) ? session : null;
  }, '模拟执行结束', 60000);
  const implementation = await waitSession(implementationProfile.id);
  await request('POST', `/api/v1/tasks/${task.id}/move`, { workflow_id: workflow.id, workflow_step_id: reviewStep.id });
  const review = await waitSession(reviewProfile.id);
  await request('POST', `/api/v1/tasks/${task.id}/move`, { workflow_id: workflow.id, workflow_step_id: acceptanceStep.id });
  await poll(async () => (await sessions()).sessions.every(s => ['WAITING_FOR_INPUT', 'COMPLETED', 'IDLE'].includes(s.state)), '会话停稳');
  await request('PATCH', `/api/v1/tasks/${task.id}`, { state: 'COMPLETED' }, 409);
  console.log('模拟实现与审查已结束，无回执 Done 已拒绝；开始界面验证。');
  page = await context.newPage();
  page.on('pageerror', error => console.error('页面错误：' + error.message));
  await page.goto(`${baseUrl}/t/${task.id}`);
  const filesHeader = page.locator('.dv-tabs-and-actions-container').filter({has:page.locator('.dv-default-tab').filter({hasText:'Files'})});
  await expect(filesHeader).toHaveCount(1);
  await filesHeader.getByTestId('dockview-add-panel-btn').click();
  await page.getByTestId(`add-panel-plugin-item-${pluginId}-fleet-acceptance`).click();
  const panel = page.getByTestId('fleet-acceptance-panel');
  await expect(panel).toHaveCount(1); await expect(panel).toBeVisible();
  for (const button of await panel.getByRole('button').all()) {
    assert.equal(Math.round((await button.boundingBox()).height), 28, '桌面动作未使用原生 28px 尺寸');
  }
  await expect(panel.getByTestId('fleet-error')).toHaveCount(0);
  await panel.getByTestId('fleet-result').fill('交付 src/app.js；Codex 模拟独立审查已完成。');
  await panel.getByTestId('fleet-implementation').selectOption(implementation.id);
  await panel.getByTestId('fleet-review').selectOption(review.id);
  await panel.getByTestId('fleet-submit').click();
  await expect(panel.getByTestId('fleet-state')).toHaveText('等待人工验收', { timeout: 20000 });
  const gate = await request('GET', `/api/v1/tasks/${task.id}/completion-gate`);
  await request('PUT', `/api/v1/tasks/${task.id}/completion-gate/criteria`, { expected_revision: gate.revision, criteria: [], human_confirmation: { expected_revision: gate.revision, reason: '尝试删除条件' } }, 409);
  await panel.getByTestId('fleet-confirm').check();
  await panel.getByTestId('fleet-approve').click();
  await expect(panel.getByTestId('fleet-state')).toHaveText('已记录人工通过', { timeout: 20000 });
  await page.screenshot({ path: join(runtime, 'desktop.png'), fullPage: false });
  await page.reload();
  await expect(page.getByTestId('fleet-state')).toHaveText('已记录人工通过', { timeout: 20000 });
  const worktrees = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', windowsHide: true });
  const blocks = worktrees.split('\0\0');
  const implementationBranch = (await sessions()).sessions.find(session => session.id === implementation.id)?.worktree_branch;
  assert.ok(implementationBranch, '实现会话缺少原生 worktree 分支');
  const implementationTree = blocks.find(block => block.split('\0').includes(`branch refs/heads/${implementationBranch}`));
  assert.ok(implementationTree, '无法解析原生实现 worktree');
  const implementationRoot = implementationTree.split('\0').find(field => field.startsWith('worktree ')).slice(9);
  const artifactPath = join(implementationRoot, 'src/app.js');
  const originalArtifact = readFileSync(artifactPath);
  try {
    writeFileSync(artifactPath, 'export const value = 2;\n');
    await request('PATCH', `/api/v1/tasks/${task.id}`, { state: 'COMPLETED' }, 409);
  } finally { writeFileSync(artifactPath, originalArtifact); }
  const desktopContext = context;
  context = await browser.newContext({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true, storageState: await desktopContext.storageState() });
  page = await context.newPage();
  await desktopContext.close();
  await page.goto(`${baseUrl}/t/${task.id}`);
  const mobilePanels = page.getByTestId('session-mobile-bottom-nav').getByRole('button', { name: /Panels|面板/ });
  await mobilePanels.click();
  await page.getByTestId(`mobile-plugin-panel-option-${pluginId}-fleet-acceptance`).click();
  await expect(page.getByTestId('fleet-acceptance-panel')).toBeVisible();
  const mobilePanel = page.getByTestId('fleet-acceptance-panel');
  for (const button of await mobilePanel.getByRole('button').all()) {
    assert.ok((await button.boundingBox()).height >= 44, '手机动作触摸目标不足 44px');
  }
  await mobilePanel.getByTestId('fleet-submit').tap();
  await expect(mobilePanel.getByTestId('fleet-state')).toHaveText('等待人工验收', { timeout: 20000 });
  await mobilePanel.getByTestId('fleet-confirm-label').tap();
  await expect(mobilePanel.getByTestId('fleet-confirm')).toBeChecked();
  await mobilePanel.getByTestId('fleet-approve').tap();
  await expect(mobilePanel.getByTestId('fleet-state')).toHaveText('已记录人工通过', { timeout: 20000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, '手机页面出现横向溢出');
  await page.screenshot({ path: join(runtime, 'mobile.png'), fullPage: false });
  await request('POST', `/api/v1/tasks/${task.id}/move`, { workflow_id: workflow.id, workflow_step_id: doneStep.id });
  assert.equal((await request('GET', `/api/v1/tasks/${task.id}`)).state, 'COMPLETED');
  const history = await request('GET', `/api/v1/tasks/${task.id}/completion-gate/history`);
  assert.ok(history.items.some(item => item.action === 'criterion_verified' && item.actor_kind === 'plugin'), '原生历史缺少验收证据');
  await stop(); await start();
  await poll(async () => (await request('GET', `/api/plugins/${pluginId}`)).status === 'active', '重启后插件恢复');
  assert.equal((await request('GET', `/api/v1/tasks/${task.id}`)).state, 'COMPLETED');
  assert.equal((await request('GET', `/api/v1/tasks/${task.id}/completion-gate/history`)).items.length, history.items.length, '重启后原生审计历史变化');
  await page.reload();
  await page.getByTestId('session-mobile-bottom-nav').getByRole('button', { name: /Panels|面板/ }).click();
  await page.getByTestId(`mobile-plugin-panel-option-${pluginId}-fleet-acceptance`).click();
  await expect(page.getByTestId('fleet-state')).toHaveText('已记录人工通过', { timeout: 20000 });
  console.log('通过：真实安装／宿主动作中继／模拟实现与审查／无回执与变更产物拒绝 Done／删除条件拒绝／人工批准／桌面 28px／手机触摸提交与验收／原生 Done／宿主重启恢复。');
  console.log('隔离产物目录：' + runtime);
} catch (error) {
  await page?.screenshot({path:join(runtime,'failure.png')}).catch(()=>{});
  console.error('模拟验收失败：' + error.stack);
  console.error('隔离日志目录：' + runtime);
  process.exitCode = 1;
} finally {
  await context?.close(); await browser?.close(); await stop(); log.end();
}
