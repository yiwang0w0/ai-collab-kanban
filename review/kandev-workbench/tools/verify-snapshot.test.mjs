import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function check(directory) {
  return spawnSync(process.execPath, [join(directory, 'tools/verify-snapshot.mjs')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
}
function fixture(t) {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'kandev-review-test-'));
  t.after(() => {
    // 只移除本测试创建、且仍处于预期临时父目录下的独立副本。
    assert.equal(dirname(directory), temporaryRoot);
    assert.ok(basename(directory).startsWith('kandev-review-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  cpSync(root, directory, { recursive: true });
  return directory;
}

test('完整的公开审查包可离线核对', () => {
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).poolFiles, 481);
});
test('源码复制后被改动时拒绝通过', t => {
  const directory = fixture(t);
  appendFileSync(join(directory, 'board/cli/check-delivery.mjs'), '\n// 测试篡改\n');
  const result = check(directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /文件大小不符|文件摘要不符/);
});
test('额外混入未列出的运行数据时拒绝通过', t => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'private.db'), '测试占位内容，不是真实数据库');
  const result = check(directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /清单必须精确覆盖全部文件/);
});
