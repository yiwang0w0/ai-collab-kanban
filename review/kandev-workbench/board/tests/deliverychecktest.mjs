import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const { checkDelivery, resolveWorktree } = createRequire(import.meta.url)('../gates/delivery_check.js');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.js'), 'export const value = 1;\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const task = { result: '交付 src/app.js', work_spans: JSON.stringify([{ s: new Date(Date.now() - 60000).toISOString() }]) };
  return { root, git, task };
}

test('已入库的真实交付生成可复核的提交和产物摘要', t => {
  const f = fixture(t), result = checkDelivery(f.task, { repoRoot: f.root });
  assert.equal(result.status, 'pass');
  assert.equal(result.head, f.git('rev-parse', 'HEAD').trim());
  assert.match(result.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.artifacts[0].path, 'src/app.js');
});

test('未入库、虚构和遗漏的交付均不能通过', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'src', 'new.js'), 'new\n');
  assert.equal(checkDelivery({ ...f.task, result: 'src/new.js' }, { repoRoot: f.root }).status, 'fail');
  assert.equal(checkDelivery({ ...f.task, result: 'src/missing.js' }, { repoRoot: f.root }).status, 'fail');
  const result = checkDelivery({ ...f.task, result: '完成实现' }, { repoRoot: f.root });
  assert.equal(result.status, 'fail');
  assert.ok(result.violations.some(v => v.code === 'unnamed'));
});

test('检查每次读取当前 HEAD，产物变化使原指纹失效', t => {
  const f = fixture(t), first = checkDelivery(f.task, { repoRoot: f.root });
  writeFileSync(join(f.root, 'src', 'app.js'), 'export const value = 2;\n');
  const dirty = checkDelivery(f.task, { repoRoot: f.root });
  assert.equal(dirty.status, 'fail');
  assert.notEqual(dirty.fingerprint, first.fingerprint);
  f.git('add', '.');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'changed');
  const committed = checkDelivery(f.task, { repoRoot: f.root });
  assert.equal(committed.status, 'pass');
  assert.notEqual(committed.head, first.head);
  assert.notEqual(committed.fingerprint, first.fingerprint);
});

test('无法读取 Git 或无有效仓库时明确不可测', t => {
  const f = fixture(t);
  const result = checkDelivery(f.task, { repoRoot: join(f.root, 'missing') });
  assert.equal(result.status, 'unmeasurable');
  assert.notEqual(result.status, 'pass');
});

test('严格检查不接受纯文字交付', t => {
  const f = fixture(t);
  assert.equal(checkDelivery({ ...f.task, result: '已经全部做好' }, { repoRoot: f.root }).status, 'fail');
});

test('使用宿主验证的分支查找 Git worktree，不接收浏览器传来的路径', t => {
  const f = fixture(t), worktree = join(f.root, '..', f.root.split(/[\\/]/).at(-1) + '-task');
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  f.git('worktree', 'add', '-qb', 'task/fixture', worktree);
  assert.equal(resolveWorktree(f.root, 'task/fixture'), worktree);
  assert.throws(() => resolveWorktree(f.root, 'missing'));
  assert.throws(() => resolveWorktree(f.root, '--help'));
});

test('CLI 对旧回执和无效输入返回非零状态，标准输出只有结构化结果', t => {
  const f = fixture(t), cli = resolve('cli/check-delivery.mjs');
  const invoke = value => spawnSync(process.execPath, [cli], { input: JSON.stringify(value), encoding: 'utf8', windowsHide: true });
  const input = { format: 'ai-fleet-delivery-input/v1', repo_root: f.root, task: f.task };
  const first = invoke(input), proof = JSON.parse(first.stdout);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(invoke({ ...input, expected: proof }).status, 0);
  assert.equal(invoke({ ...input, expected: { ...proof, fingerprint: 'stale' } }).status, 2);
  assert.equal(invoke({}).status, 3);
});
