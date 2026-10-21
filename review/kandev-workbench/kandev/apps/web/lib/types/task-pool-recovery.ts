export type PoolRecoveryAction = "withdraw" | "stop" | "retry";
export type PoolRecoveryContext = {
  task_id: string;
  run_id: string;
  entry_id: number;
  claim_id: string;
  task_version: string;
  run_version: string;
  management_version: string;
  actions: Record<PoolRecoveryAction, boolean>;
  reason?: string;
};
export type PoolRecoveryCommand = {
  action: PoolRecoveryAction;
  operation_id: string;
  run_id: string;
  expected_claim_id: string;
  expected_task_version: string;
  expected_run_version: string;
  expected_management_version: string;
  confirm: true;
  confirm_cli_quota: boolean;
};
export type PoolRecoveryResult = {
  operation_id: string;
  action: PoolRecoveryAction;
  task_id: string;
  run_id: string;
  claim_id: string;
  result: "withdrawn" | "stop_requested" | "requeued";
  recorded_at: string;
  event_seq: number;
};
