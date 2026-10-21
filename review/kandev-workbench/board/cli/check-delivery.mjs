import { createRequire } from 'node:module';

const { checkDelivery, resolveWorktree } = createRequire(import.meta.url)('../gates/delivery_check.js');
let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 512 * 1024) throw new Error('input_limit');
  }
  const value = JSON.parse(input);
  if (value.format !== 'ai-fleet-delivery-input/v1' || !value.task || typeof value.repo_root !== 'string') throw new Error('invalid_input');
  const root = value.head_branch ? resolveWorktree(value.repo_root, value.head_branch) : value.repo_root;
  const result = checkDelivery(value.task, { repoRoot: root });
  if (value.head_branch) {
    if (resolveWorktree(value.repo_root, value.head_branch) !== root) throw new Error('worktree_changed');
    result.head_branch = value.head_branch;
  }
  if (value.expected && result.status === 'pass' && ['head', 'fingerprint', 'rules_version'].some(key => value.expected[key] !== result[key])) {
    result.status = 'fail';
    result.violations = [{ code: 'stale', message: '交付内容或校验规则已改变，请重新提交验收。' }];
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 2 : 3;
} catch {
  process.stdout.write(JSON.stringify({ format: 'ai-fleet-delivery-check/v1', status: 'unmeasurable', violations: [{ code: 'invalid_input', message: '检查输入无效或超过限制。' }] }) + '\n');
  process.exitCode = 3;
}
