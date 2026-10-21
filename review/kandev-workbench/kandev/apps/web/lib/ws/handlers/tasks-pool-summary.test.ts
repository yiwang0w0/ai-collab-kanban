import { describe, expect, it } from "vitest";
import { registerTasksHandlers } from "./tasks";
import { makeStore } from "./tasks.test-helpers";
import {
  mergeTaskOverview,
  reconcileTaskOverviewRead,
} from "@/lib/state/slices/task-overview-merge";
import { emptyTaskOverviewState, type TaskOverview } from "@/lib/state/slices/task-overview-types";

const TASK = "pool-summary-task";
const WORKSPACE = "pool-summary-workspace";
const WORKFLOW = "pool-summary-workflow";
const UPDATED = "2026-10-19T01:00:00Z";
const CURRENT_CLAIM = "current-claim";

function poolSummary(revision: number, claim: string) {
  return {
    revision,
    updated_at: UPDATED,
    pool_execution: {
      entry_id: 42,
      run_id: "pool-summary-run",
      claim_id: claim,
      state: "claimed" as const,
      planned_agent_profile_id: "pool-summary-profile",
      claimed_agent_profile_id: "pool-summary-profile",
      current: true,
      released_at: UPDATED,
      queued_at: UPDATED,
      claimed_at: UPDATED,
      started_at: null,
      session_id: "",
      execution_id: "",
      execution_profile_id: "",
      turn_id: "",
      operation_id: "",
      operation_source: "",
      turn_ended_at: null,
      stopped_at: null,
      ended_at: null,
    },
  };
}

function summaryMessage(summary: Record<string, unknown>) {
  return {
    id: "pool-summary-message",
    type: "notification" as const,
    action: "task.status_summary.updated" as const,
    payload: { task_id: TASK, workspace_id: WORKSPACE, status_summary: summary },
  } as Parameters<
    NonNullable<ReturnType<typeof registerTasksHandlers>["task.status_summary.updated"]>
  >[0];
}

describe("池执行摘要复用原生单调替换", () => {
  it("新领取进入两种看板和归档缓存，旧事件不能退回旧领取", () => {
    const task = {
      id: TASK,
      workflowStepId: "step",
      title: "主卡",
      statusSummary: poolSummary(4, "old-claim"),
    };
    const store = makeStore({
      kanban: { workflowId: WORKFLOW, steps: [], tasks: [task] },
      kanbanMulti: {
        isLoading: false,
        snapshots: {
          [WORKFLOW]: { workflowId: WORKFLOW, workflowName: "流程", steps: [], tasks: [task] },
        },
      },
      sidebarArchivedTasks: {
        itemsByWorkspaceId: { [WORKSPACE]: [task] },
        loadedByWorkspaceId: { [WORKSPACE]: true },
        loadingByWorkspaceId: {},
        errorByWorkspaceId: {},
        revisionByWorkspaceId: {},
      },
    } as never);
    const handler = registerTasksHandlers(store)["task.status_summary.updated"]!;
    handler(summaryMessage(poolSummary(5, CURRENT_CLAIM)));
    handler(summaryMessage(poolSummary(4, "old-claim")));
    const state = store.getState();
    for (const row of [
      state.kanban.tasks[0],
      state.kanbanMulti.snapshots[WORKFLOW]?.tasks[0],
      state.sidebarArchivedTasks.itemsByWorkspaceId[WORKSPACE][0],
    ]) {
      expect(row?.statusSummary).toMatchObject({
        revision: 5,
        pool_execution: { claim_id: CURRENT_CLAIM },
      });
    }
    handler(summaryMessage({ revision: 6, updated_at: UPDATED }));
    expect(store.getState().kanban.tasks[0].statusSummary).toEqual({
      revision: 6,
      updated_at: UPDATED,
    });
  });

  it("部分任务补丁省略摘要不会抹掉领取，完整较新摘要省略池则清除", () => {
    const current = {
      id: TASK,
      workflowStepId: "step",
      title: "主卡",
      statusSummary: poolSummary(5, CURRENT_CLAIM),
    } as TaskOverview;
    const partial = mergeTaskOverview(current, { id: TASK, title: "更新标题" });
    expect(partial.statusSummary).toBe(current.statusSummary);
    const complete = mergeTaskOverview(partial, {
      id: TASK,
      statusSummary: { revision: 6, updated_at: UPDATED },
    });
    expect(complete.statusSummary).toEqual({ revision: 6, updated_at: UPDATED });
  });

  it("重连读取期间的新领取保留，迟到 HTTP 不能覆盖它", () => {
    const old = {
      id: TASK,
      workflowStepId: "step",
      title: "主卡",
      statusSummary: poolSummary(4, "old-claim"),
    } as TaskOverview;
    const current = { ...old, statusSummary: poolSummary(5, CURRENT_CLAIM) } as TaskOverview;
    const state = emptyTaskOverviewState(WORKSPACE);
    state.byId[TASK] = current;
    state.reads.reconnect = {
      scope: WORKSPACE,
      changes: { [TASK]: { id: TASK, statusSummary: current.statusSummary } },
      bytes: 0,
    };
    const result = reconcileTaskOverviewRead(state, [old], "reconnect");
    expect(result?.[0].statusSummary).toMatchObject({
      revision: 5,
      pool_execution: { claim_id: CURRENT_CLAIM },
    });
  });
});
