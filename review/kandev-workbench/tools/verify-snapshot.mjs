import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative, sep, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只读核对公开包；不启动宿主、安装插件或调用任何执行器。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawHash = bytes => createHash('sha256').update(bytes).digest('hex');
const textHash = bytes => rawHash(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')));
const source = JSON.parse(readFileSync(resolve(root, 'SOURCES.json'), 'utf8'));
const snapshot = JSON.parse(readFileSync(resolve(root, 'SNAPSHOT.json'), 'utf8'));
const blocked = new Set(['.exe', '.dll', '.db', '.sqlite', '.sqlite3', '.zip', '.tar', '.gz', '.log', '.png', '.jpg', '.jpeg', '.mp4']);

function safePath(path) {
  assert.equal(typeof path, 'string');
  assert.ok(!isAbsolute(path) && !path.split(/[\\/]/).includes('..'), '清单路径必须位于包内');
  const full = resolve(root, path);
  assert.ok(full.startsWith(root + sep), '拒绝越界路径');
  assert.ok(lstatSync(full).isFile() && !lstatSync(full).isSymbolicLink(), '只接受普通文件');
  return full;
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = resolve(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), '包内不得有符号链接');
    assert.ok(!['.git', '.build', 'node_modules', 'dist', 'logs', 'worktrees', 'managed-repos'].includes(entry.name), '包内不得含缓存或运行目录');
    return entry.isDirectory() ? walk(full) : [relative(root, full).split(sep).join('/')];
  });
}

const paths = walk(root).filter(path => path !== 'SNAPSHOT.json').sort();
assert.equal(new Set(snapshot.files.map(file => file.path)).size, snapshot.files.length, '文件清单不能重复');
assert.deepEqual(paths, snapshot.files.map(file => file.path).sort(), '清单必须精确覆盖全部文件');
for (const file of snapshot.files) {
  assert.ok(!blocked.has(extname(file.path).toLowerCase()), '禁止发布运行数据或构建产物');
  const bytes = readFileSync(safePath(file.path));
  assert.equal(bytes.length, file.bytes, `文件大小不符：${file.path}`);
  assert.equal(rawHash(bytes), file.sha256, `文件摘要不符：${file.path}`);
  assert.ok(!bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes), `文件必须是 UTF-8 文本：${file.path}`);
}
for (const file of source.files) {
  assert.equal(textHash(readFileSync(safePath(file.path))), file.sha256_lf_utf8, `来源摘要不符：${file.path}`);
}
const replayArgument = process.argv.indexOf('--replayed-root');
if (replayArgument >= 0) {
  assert.ok(process.argv[replayArgument + 1], '缺少重放目录');
  const replayRoot = resolve(process.argv[replayArgument + 1]);
  for (const file of source.files.filter(file => file.component !== 'board-baseline-delta')) {
    const replayPath = resolve(replayRoot, file.path);
    assert.ok(replayPath.startsWith(replayRoot + sep), '重放路径不得越界');
    assert.equal(textHash(readFileSync(replayPath)), file.sha256_lf_utf8, `重放源码不符：${file.path}`);
  }
}

const prefix = 'kandev-plugin-fleet-acceptance/';
const pool = JSON.parse(readFileSync(safePath(prefix + 'compat/kandev-v0.97.0-agent-pool.manifest.json'), 'utf8'));
assert.equal(pool.baseline_commit, source.host_baseline);
assert.equal(pool.files.length, 481);
assert.equal(pool.replayed_file_count, pool.files.length);
for (const file of pool.files) {
  assert.equal(textHash(readFileSync(safePath('kandev/' + file.path))), file.sha256_lf_utf8, `宿主覆盖层不符：${file.path}`);
}
for (const patch of [pool.patch, pool.prerequisite_patch]) {
  assert.equal(rawHash(readFileSync(safePath(prefix + patch.path))), patch.sha256, `兼容补丁摘要不符：${patch.path}`);
}
for (const license of ['kandev/LICENSE', prefix + 'LICENSE', 'board/LICENSE', 'board/NOTICE']) safePath(license);
console.log(JSON.stringify({ status: '通过', files: paths.length, sourceFiles: source.files.length, poolFiles: pool.files.length, replayVerified: replayArgument >= 0, network: false, modelCalls: false }));
