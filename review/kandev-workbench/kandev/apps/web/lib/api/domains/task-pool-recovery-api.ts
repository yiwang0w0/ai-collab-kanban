import { fetchJson, type ApiRequestOptions } from "@/lib/api/client";
import type {
  PoolRecoveryCommand,
  PoolRecoveryContext,
  PoolRecoveryResult,
} from "@/lib/types/task-pool-recovery";

function recoveryPath(taskId: string) {
  return `/api/v1/tasks/${encodeURIComponent(taskId)}/pool-recovery`;
}

export function fetchPoolRecoveryContext(
  taskId: string,
  runId: string,
  options?: ApiRequestOptions,
): Promise<PoolRecoveryContext> {
  return fetchJson(`${recoveryPath(taskId)}?run_id=${encodeURIComponent(runId)}`, {
    ...options,
    cache: "no-store",
  });
}
export function recoverPoolRun(
  taskId: string,
  command: PoolRecoveryCommand,
  options?: ApiRequestOptions,
): Promise<PoolRecoveryResult> {
  return fetchJson(recoveryPath(taskId), {
    ...options,
    cache: "no-store",
    init: { ...options?.init, method: "POST", body: JSON.stringify(command) },
  });
}
export function fetchPoolRecoveryOperation(
  taskId: string,
  runId: string,
  operationId: string,
  options?: ApiRequestOptions,
): Promise<PoolRecoveryResult> {
  return fetchJson(
    `${recoveryPath(taskId)}/${encodeURIComponent(operationId)}?run_id=${encodeURIComponent(runId)}`,
    {
      ...options,
      cache: "no-store",
    },
  );
}
