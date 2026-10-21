import { describe, expect, it } from "vitest";
import { taskId, workspaceId, workflowId, type WorkflowStep } from "./types/http";
import type { PoolCard } from "./types/task-pool";
import { poolReleaseMove, poolReleaseTargets, type PoolReleaseTask } from "./task-pool-release";

const task = {
  id: taskId("task"),
  workspace_id: workspaceId("workspace"),
  workflow_id: workflowId("flow"),
  workflow_step_id: "backlog",
  state: "TODO",
  updated_at: "2026-10-20T01:02:03.123456789Z",
  depends_on: [],
} as PoolReleaseTask;
const card = {
  task_id: task.id,
  workflow_id: task.workflow_id,
  workflow_step_id: task.workflow_step_id,
  eligibility: { state: "not_applicable", reason: "pool_stage_not_configured" },
  pool_execution: null,
  title: "待派发卡片",
  stage: "待处理",
  task_state: "TODO",
  relations: { parent_id: "", child_count: 0, depends_on_count: 0, blocks_count: 0 },
} as PoolCard;
function step(overrides: Record<string, unknown> = {}): WorkflowStep {
  return {
    id: "pool",
    workflow_id: workflowId("flow"),
    name: "实施",
    position: 1,
    color: "",
    updated_at: "2026-10-20T01:00:00.987654321Z",
    created_at: "2026-10-20T01:00:00Z",
    agent_profile_id: "profile",
    allow_manual_move: true,
    events: { on_enter: [{ type: "queue_run", config: { pool_version: 1 } }] },
    ...overrides,
  } as WorkflowStep;
}

describe("明确批准绑定原生阶段和版本", () => {
  it("仅列出同流程且非当前阶段的显式有效池入口", () => {
    expect(
      poolReleaseTargets(task, [
        step(),
        step({ workflow_id: "other" }),
        step({ id: "backlog" }),
        step({ agent_profile_id: "" }),
        step({ events: { on_enter: [{ type: "queue_run", config: {} }] } }),
      ]).map((item) => item.id),
    ).toEqual(["pool"]);
  });
  it("不接受额外启动器、跨卡配置、会话目标和完成阶段", () => {
    for (const overrides of [
      {
        events: {
          on_enter: [{ type: "queue_run", config: { pool_version: 1, task_id: "other" } }],
        },
      },
      { events: { on_enter: [{ type: "queue_run", config: { pool_version: 1, payload: {} } }] } },
      {
        events: {
          on_enter: [
            { type: "queue_run", config: { pool_version: 1 } },
            { type: "auto_start_agent" },
          ],
        },
      },
      { session_target: { kind: "initial" } },
      { complete_task_on_enter: true },
      { allow_manual_move: false },
      { updated_at: "" },
    ])
      expect(poolReleaseTargets(task, [step(overrides)])).toEqual([]);
  });
  it("只传两个原始版本和明确额度确认，不编造身份或时间", () => {
    expect(poolReleaseMove(card, task, step(), true)).toEqual({
      workflow_id: "flow",
      workflow_step_id: "pool",
      pool_release: {
        confirm_cli_quota: true,
        expected_resource_version: task.updated_at,
        expected_step_version: step().updated_at,
      },
    });
  });
  it("未登录、卡片已变动、占用、未知资格、前置未完成和终态均失败关闭", () => {
    expect(poolReleaseMove(card, task, step(), false)).toBeNull();
    expect(
      poolReleaseMove({ ...card, workflow_step_id: "changed" }, task, step(), true),
    ).toBeNull();
    expect(
      poolReleaseMove(
        { ...card, pool_execution: { state: "unknown" } } as PoolCard,
        task,
        step(),
        true,
      ),
    ).toBeNull();
    expect(
      poolReleaseMove(
        { ...card, eligibility: { state: "unknown", reason: "unknown" } },
        task,
        step(),
        true,
      ),
    ).toBeNull();
    for (const change of [
      { updated_at: "" },
      { archived_at: task.updated_at },
      { blocked: true },
      { depends_on: [{ id: "before", status: "pending" as const }] },
      { state: "COMPLETED" as const },
      { primary_session_state: "RUNNING" as const },
    ])
      expect(poolReleaseMove(card, { ...task, ...change }, step(), true)).toBeNull();
  });
});
