import type { MoveTaskPayload } from "./api/domains/kanban-api";
import type { TaskDependencyProjectionResponse } from "./api/domains/task-dependencies-api";
import type { Task, WorkflowStep } from "./types/http";
import type { PoolCard } from "./types/task-pool";

export type PoolReleaseTask = Pick<
  Task,
  | "id"
  | "workspace_id"
  | "workflow_id"
  | "workflow_step_id"
  | "updated_at"
  | "state"
  | "archived_at"
  | "primary_session_state"
  | "status_summary"
> &
  Pick<TaskDependencyProjectionResponse, "blocked" | "depends_on">;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function launchAction(action: unknown) {
  return (
    record(action) &&
    ["queue_run", "auto_start_agent", "queue_run_for_each_participant", "run_code_review"].includes(
      String(action.type),
    )
  );
}

function poolMarker(action: unknown) {
  return record(action) && record(action.config) && "pool_version" in action.config;
}

function validStepHeader(step: WorkflowStep) {
  return !(
    !step.agent_profile_id?.trim() ||
    step.session_target ||
    step.complete_task_on_enter ||
    step.allow_manual_move === false ||
    !step.updated_at ||
    !Number.isFinite(Date.parse(step.updated_at))
  );
}

function validQueueConfig(config: Record<string, unknown>) {
  return (
    config.pool_version === 1 &&
    !("payload" in config) &&
    !Object.entries({ target: "primary", task_id: "this", reason: "pool_dispatch" }).some(
      ([key, expected]) => key in config && config[key] !== "" && config[key] !== expected,
    )
  );
}

function explicitPoolStep(step: WorkflowStep) {
  if (!validStepHeader(step)) return false;
  const events = step.events ?? {};
  const entries: unknown[] = events.on_enter ?? [];
  const queues = entries.filter((action) => record(action) && action.type === "queue_run");
  if (queues.length !== 1 || !record(queues[0]) || !record(queues[0].config)) return false;
  if (!validQueueConfig(queues[0].config)) return false;
  if (
    entries.some((action) => action !== queues[0] && (launchAction(action) || poolMarker(action)))
  )
    return false;
  return !Object.entries(events).some(
    ([key, actions]) =>
      key !== "on_enter" &&
      Array.isArray(actions) &&
      actions.some((action) => launchAction(action) || poolMarker(action)),
  );
}

export function poolReleaseTargets(task: PoolReleaseTask, steps: WorkflowStep[]): WorkflowStep[] {
  return steps.filter(
    (step) =>
      step.workflow_id === task.workflow_id &&
      step.id !== task.workflow_step_id &&
      explicitPoolStep(step),
  );
}

function releaseContextMatches(card: PoolCard, task: PoolReleaseTask) {
  return !(
    card.task_id !== task.id ||
    card.workflow_id !== task.workflow_id ||
    card.workflow_step_id !== task.workflow_step_id ||
    !task.updated_at ||
    !Number.isFinite(Date.parse(task.updated_at)) ||
    task.archived_at ||
    ["COMPLETED", "CANCELLED", "FAILED"].includes(task.state)
  );
}

function releaseContextFree(card: PoolCard, task: PoolReleaseTask) {
  return !(
    card.pool_execution ||
    task.status_summary?.pool_execution ||
    !["not_applicable", "approval_required"].includes(card.eligibility.state) ||
    task.blocked ||
    task.depends_on?.some((dependency) => dependency.status !== "resolved") ||
    ["RUNNING", "STARTING", "WAITING_FOR_INPUT"].includes(task.primary_session_state ?? "")
  );
}

export function poolReleaseMove(
  card: PoolCard,
  task: PoolReleaseTask,
  step: WorkflowStep,
  authenticated: boolean,
): MoveTaskPayload | null {
  if (!authenticated || !releaseContextMatches(card, task) || !releaseContextFree(card, task))
    return null;
  if (!poolReleaseTargets(task, [step]).length) return null;
  return {
    workflow_id: task.workflow_id,
    workflow_step_id: step.id,
    pool_release: {
      confirm_cli_quota: true,
      expected_resource_version: task.updated_at,
      expected_step_version: step.updated_at,
    },
  };
}
