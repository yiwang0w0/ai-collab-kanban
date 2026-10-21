import type { TaskStatusSummaryPoolExecution } from "./task-status-summary";

export type PoolExecution = TaskStatusSummaryPoolExecution;
export type PoolCard = {
  task_id: string;
  title: string;
  workflow_id: string;
  workflow_step_id: string;
  stage: string;
  task_state: string;
  pool_execution: PoolExecution | null;
  eligibility: { state: string; reason: string };
  relations: {
    parent_id: string;
    child_count: number;
    depends_on_count: number;
    blocks_count: number;
  };
};
export type PoolPage = {
  workspace_id: string;
  snapshot_version: string;
  items: PoolCard[];
  next_cursor: string;
};
export type PoolHistoryPage = {
  task_id: string;
  snapshot_version: string;
  items: PoolExecution[];
  next_cursor: string;
};
