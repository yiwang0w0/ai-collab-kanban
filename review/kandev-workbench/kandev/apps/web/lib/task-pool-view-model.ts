import type { PoolCard, PoolExecution } from "./types/task-pool";

export function poolPageChildren(cards: PoolCard[], parentId: string): PoolCard[] {
  return cards.filter((card) => card.task_id !== parentId && card.relations.parent_id === parentId);
}
import { parseTurnTimestamp } from "@/lib/state/slices/session/turn-actions";

export type PoolCategory = "attention" | "pool" | "running" | "review";
export type PoolFilters = { query: string; workflow: string; agent: string };
export type PoolTimelinePoint = { kind: string; at: string };

export const POOL_CATEGORIES: PoolCategory[] = ["attention", "pool", "running", "review"];

export function poolCategory(card: PoolCard): PoolCategory {
  const execution = card.pool_execution;
  if (!execution || execution.state === "unknown") return "attention";
  if (["turn_ended", "ended"].includes(execution.state)) return "review";
  if (!execution.current) return "attention";
  if (["released", "queued"].includes(execution.state)) return "pool";
  if (["claimed", "started"].includes(execution.state)) return "running";
  return "attention";
}

const TIMELINE_FIELDS = [
  ["released", "released_at"],
  ["queued", "queued_at"],
  ["claimed", "claimed_at"],
  ["started", "started_at"],
  ["turn_ended", "turn_ended_at"],
  ["stopped", "stopped_at"],
  ["ended", "ended_at"],
] as const;

export function poolTimeline(execution: PoolExecution | null): PoolTimelinePoint[] {
  if (!execution) return [];
  return TIMELINE_FIELDS.flatMap(([kind, field]) => {
    const at = execution[field];
    const label = kind === "ended" && execution.state === "withdrawn" ? "withdrawn" : kind;
    return at && parseTurnTimestamp(at) !== null ? [{ kind: label, at }] : [];
  });
}

export function poolCardTimes(execution: PoolExecution | null): PoolTimelinePoint[] {
  return poolTimeline(execution).slice(-2);
}

export function poolFreshness(
  confirmed: number | null,
  now: number,
  connected: boolean,
  error: boolean,
) {
  if (confirmed === null) return error ? "unavailable" : "loading";
  if (error || !connected || now - confirmed >= 30_000) return "stale";
  return "fresh";
}

const REASON_GROUPS: Record<string, string> = {
  pool_withdrawn: "withdrawn",
  dependencies_unresolved: "dependencies",
  cli_quota_confirmation_required: "approval",
  pool_execution_capability_unavailable: "capability",
  pool_stage_not_configured: "configuration",
  pool_step_configuration_invalid: "configuration",
  pool_stage_configuration_changed: "configuration",
  task_not_admitted: "admission",
  release_not_queued: "dispatch",
  pool_execution_pending: "occupied",
  native_admission_required: "revalidation",
  history_cleaned: "history",
};

export function poolReasonGroup(reason: string) {
  return REASON_GROUPS[reason] ?? "evidence";
}

export function matchesPoolFilters(card: PoolCard, filters: PoolFilters) {
  return (
    card.title.toLocaleLowerCase().includes(filters.query.trim().toLocaleLowerCase()) &&
    (filters.workflow === "all" || card.workflow_id === filters.workflow) &&
    (filters.agent === "all" ||
      card.pool_execution?.claimed_agent_profile_id === filters.agent ||
      card.pool_execution?.planned_agent_profile_id === filters.agent)
  );
}
