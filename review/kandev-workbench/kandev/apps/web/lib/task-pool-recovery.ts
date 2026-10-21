import type {
  PoolRecoveryAction,
  PoolRecoveryCommand,
  PoolRecoveryContext,
  PoolRecoveryResult,
} from "./types/task-pool-recovery";
import { parseTurnTimestamp } from "./state/slices/session/turn-actions";

function identifier(value: unknown, empty = false): value is string {
  return (
    typeof value === "string" &&
    (empty || value.length > 0) &&
    value.length <= 256 &&
    value.trim() === value
  );
}

export function validPoolRecoveryOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000"
  );
}

export function poolRecoveryCommand(
  context: PoolRecoveryContext,
  action: PoolRecoveryAction,
  operationId: string,
): PoolRecoveryCommand | null {
  if (
    !context?.actions?.[action] ||
    !validPoolRecoveryOperationId(operationId) ||
    !identifier(context.task_id) ||
    !identifier(context.run_id) ||
    !identifier(context.claim_id, action === "withdraw") ||
    !identifier(context.management_version, true) ||
    !Number.isSafeInteger(context.entry_id) ||
    context.entry_id <= 0 ||
    parseTurnTimestamp(context.task_version) === null ||
    !/^[0-9a-f]{64}$/.test(context.run_version) ||
    (action === "withdraw" && context.claim_id !== "")
  )
    return null;
  return {
    action,
    operation_id: operationId,
    run_id: context.run_id,
    expected_claim_id: context.claim_id,
    expected_task_version: context.task_version,
    expected_run_version: context.run_version,
    expected_management_version: context.management_version,
    confirm: true,
    confirm_cli_quota: action === "retry",
  };
}

export function matchesPoolRecoveryResult(
  result: PoolRecoveryResult,
  taskId: string,
  command: PoolRecoveryCommand,
): boolean {
  const outcomes = { withdraw: "withdrawn", stop: "stop_requested", retry: "requeued" };
  return (
    !!result &&
    result.task_id === taskId &&
    result.run_id === command.run_id &&
    result.claim_id === command.expected_claim_id &&
    result.operation_id === command.operation_id &&
    result.action === command.action &&
    result.result === outcomes[command.action] &&
    Number.isSafeInteger(result.event_seq) &&
    result.event_seq >= 0 &&
    parseTurnTimestamp(result.recorded_at) !== null
  );
}
