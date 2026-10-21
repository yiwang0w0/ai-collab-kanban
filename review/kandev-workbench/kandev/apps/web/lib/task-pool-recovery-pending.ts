import { validPoolRecoveryOperationId } from "./task-pool-recovery";
import type { PoolRecoveryCommand } from "./types/task-pool-recovery";

const storageKey = "kandev.pool-recovery-pending.v1";
type Entry = { scope: string; command: PoolRecoveryCommand };

function validEntry(item: Entry) {
  return (
    !!item &&
    typeof item.scope === "string" &&
    item.scope.length <= 2048 &&
    !!item.command &&
    validPoolRecoveryOperationId(item.command.operation_id) &&
    ["withdraw", "stop", "retry"].includes(item.command.action) &&
    typeof item.command.run_id === "string" &&
    item.command.run_id.length <= 256 &&
    typeof item.command.expected_claim_id === "string" &&
    item.command.expected_claim_id.length <= 256
  );
}

// 只保留当前标签页待查询的操作凭据；不是任务、执行或成功事实的来源。
function entries(): Entry[] {
  const raw = sessionStorage.getItem(storageKey);
  if (!raw) return [];
  if (raw.length > 65536) throw new Error("pool_recovery_pending_unavailable");
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 32)
    throw new Error("pool_recovery_pending_unavailable");
  if (!value.every(validEntry)) throw new Error("pool_recovery_pending_unavailable");
  return value;
}

export function readPendingPoolRecovery(scope: string, runId: string) {
  const command = entries().find((item) => item.scope === scope)?.command ?? null;
  if (command && command.run_id !== runId) throw new Error("pool_recovery_pending_unavailable");
  return command;
}

export function savePendingPoolRecovery(scope: string, command: PoolRecoveryCommand) {
  const previous = entries();
  if (previous.some((item) => item.scope === scope))
    throw new Error("pool_recovery_pending_unresolved");
  if (previous.length >= 32 || scope.length > 2048)
    throw new Error("pool_recovery_pending_unavailable");
  const encoded = JSON.stringify([...previous, { scope, command }]);
  if (encoded.length > 65536) throw new Error("pool_recovery_pending_unavailable");
  sessionStorage.setItem(storageKey, encoded);
}

export function forgetPendingPoolRecovery(scope: string, operationId: string) {
  const remaining = entries().filter(
    (item) => item.scope !== scope || item.command.operation_id !== operationId,
  );
  sessionStorage.setItem(storageKey, JSON.stringify(remaining));
}
