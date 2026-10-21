import type { PoolHistoryPage, PoolPage } from "../../lib/types/task-pool";
import type { SeedData } from "../fixtures/test-base";
import type { Agent } from "../../lib/types/http-agents";

export type PoolTransport = {
  rawRequest(method: string, path: string, body?: unknown): Promise<Response>;
};

export async function poolRequest<T>(
  api: PoolTransport,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await api.rawRequest(method, path, body);
  if (!response.ok)
    throw new Error(
      `任务池夹具请求失败 ${method} ${path}: ${response.status} ${await response.text()}`,
    );
  return response.json() as Promise<T>;
}

export function readPool(api: PoolTransport, workspaceId: string) {
  return poolRequest<PoolPage>(api, "GET", `/api/v1/workspaces/${workspaceId}/task-pool?limit=50`);
}

export function readPoolHistory(api: PoolTransport, taskId: string) {
  return poolRequest<PoolHistoryPage>(api, "GET", `/api/v1/tasks/${taskId}/pool-history?limit=50`);
}

export type PoolSeedContext = Pick<
  SeedData,
  "workspaceId" | "workflowId" | "startStepId" | "repositoryId" | "worktreeExecutorProfileId"
>;

export async function seedPoolTask(
  api: PoolTransport,
  seed: PoolSeedContext,
  options: { release?: boolean; description?: string } = {},
) {
  const release = options.release !== false;
  const { agents } = await poolRequest<{ agents: Agent[] }>(api, "GET", "/api/v1/agents");
  const agent = agents.find((candidate) => candidate.name === "claude-acp");
  if (!agent) throw new Error("任务池夹具未启用 claude-acp 模拟适配器");
  const profile = await poolRequest<{ id: string }>(
    api,
    "POST",
    `/api/v1/agents/${agent.id}/profiles`,
    {
      name: "任务池模拟代理",
      model: "mock-fast",
      auto_fallback: false,
      fallback_model: "",
      auto_approve: true,
      cli_passthrough: false,
    },
  );
  const workflow = await poolRequest<{ id: string }>(api, "POST", "/api/v1/workflows", {
    workspace_id: seed.workspaceId,
    name: "任务指挥夹具",
  });
  const source = release
    ? null
    : await poolRequest<{ id: string }>(api, "POST", "/api/v1/workflow/steps", {
        workflow_id: workflow.id,
        name: "待批准",
        position: 0,
        is_start_step: true,
      });
  const step = await poolRequest<{ id: string; updated_at: string }>(
    api,
    "POST",
    "/api/v1/workflow/steps",
    {
      workflow_id: workflow.id,
      name: "实施",
      position: source ? 1 : 0,
      agent_profile_id: profile.id,
      allow_manual_move: true,
      events: { on_enter: [{ type: "queue_run", config: { pool_version: 1 } }] },
    },
  );
  const parent = await poolRequest<{ id: string }>(api, "POST", "/api/v1/tasks", {
    workspace_id: seed.workspaceId,
    title: "关联主任务",
    workflow_id: seed.workflowId,
    workflow_step_id: seed.startStepId,
  });
  const task = await poolRequest<{ id: string }>(api, "POST", "/api/v1/tasks", {
    workspace_id: seed.workspaceId,
    workflow_id: workflow.id,
    workflow_step_id: source?.id ?? step.id,
    title: "核验派发领取与开工",
    description: options.description ?? 'e2e:message("已核实的模拟工作")',
    executor_profile_id: seed.worktreeExecutorProfileId,
    repositories: [{ repository_id: seed.repositoryId, base_branch: "main" }],
    parent_id: parent.id,
    workspace_mode: "new_workspace",
    ...(release
      ? {
          pool_release: {
            confirm_cli_quota: true,
            expected_resource_version: "",
            expected_step_version: step.updated_at,
          },
        }
      : {}),
  });
  return { taskId: task.id, parentId: parent.id, profileId: profile.id, poolStepId: step.id };
}
