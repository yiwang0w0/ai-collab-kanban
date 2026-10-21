import { expect, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackendContext } from "../fixtures/backend";
import { setupAdmin } from "./auth";
import { GitHelper, makeGitEnv } from "./git-helper";
import { poolRequest, seedPoolTask, type PoolTransport } from "./task-pool-api";

export function restartPoolAuthBackend(backend: BackendContext, database: string) {
  return backend.restart({
    KANDEV_FEATURES_AUTH: "true",
    KANDEV_FEATURES_OFFICE: "false",
    KANDEV_MOCK_AGENT: "only",
    KANDEV_MOCK_PROVIDERS: "claude-acp",
    E2E_MOCK_AGENT_ACP_TRACE_FILE: path.join(backend.tmpDir, `${database}.acp.jsonl`),
    // 本池用例只运行原生 Git；不改变共享故障注入夹具。
    PATH: [
      path.resolve(__dirname, "../../../backend/bin"),
      path.dirname(process.execPath),
      process.env.PATH ?? "",
    ].join(path.delimiter),
    KANDEV_DATABASE_PATH: path.join(backend.tmpDir, database),
  });
}

async function authenticatedTransport(
  context: BrowserContext,
  backend: BackendContext,
): Promise<PoolTransport> {
  await setupAdmin(context, backend.baseUrl, {
    email: "pool-operator@example.invalid",
    password: randomUUID(),
    displayName: "池验收操作者",
  });
  await context.addCookies([{ name: "kandev_locale", value: "zh-cn", url: backend.frontendUrl }]);
  const response = await context.request.get(
    `${backend.baseUrl}/api/v1/app-state?path=%2Fsettings%2Fagents`,
  );
  expect(response.ok()).toBe(true);
  const boot = (await response.json()) as { interimSettingsInterlockToken: string };
  expect(typeof boot.interimSettingsInterlockToken).toBe("string");
  return {
    rawRequest: async (method, route, body) => {
      const result = await context.request.fetch(backend.baseUrl + route, {
        method,
        data: body,
        headers: { "X-Kandev-Interim-Settings-Interlock": boot.interimSettingsInterlockToken },
      });
      return new Response(await result.text(), {
        status: result.status(),
        headers: result.headers(),
      });
    },
  };
}

export async function seedAuthenticatedPool(
  context: BrowserContext,
  backend: BackendContext,
  repositoryDirectory = "pool-auth-repo",
  description?: string,
) {
  const api = await authenticatedTransport(context, backend);
  const repositoryPath = path.join(backend.tmpDir, repositoryDirectory);
  fs.mkdirSync(repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "app.js"), "export const fixture = true;\n");
  const git = new GitHelper(repositoryPath, makeGitEnv(backend.tmpDir));
  git.exec("git init -b main");
  git.exec("git add .");
  git.exec("git commit -m fixture");
  const { executors } = await poolRequest<{
    executors: Array<{ id: string; type: string; profiles?: Array<{ id: string }> }>;
  }>(api, "GET", "/api/v1/executors");
  const worktree = executors.find((executor) => executor.type === "worktree");
  expect(worktree?.profiles?.[0]?.id).toBeTruthy();
  const workspace = await poolRequest<{ id: string }>(api, "POST", "/api/v1/workspaces", {
    name: "任务指挥验收",
    default_executor_id: worktree!.id,
  });
  const workflow = await poolRequest<{ id: string }>(api, "POST", "/api/v1/workflows", {
    workspace_id: workspace.id,
    name: "关联流程",
  });
  const startStep = await poolRequest<{ id: string }>(api, "POST", "/api/v1/workflow/steps", {
    workflow_id: workflow.id,
    name: "待处理",
    position: 0,
    is_start_step: true,
  });
  const repository = await poolRequest<{ id: string }>(
    api,
    "POST",
    `/api/v1/workspaces/${workspace.id}/repositories`,
    {
      name: "pool-repo",
      source_type: "local",
      local_path: repositoryPath,
      default_branch: "main",
      pull_before_worktree: false,
    },
  );
  const scenario = await seedPoolTask(
    api,
    {
      workspaceId: workspace.id,
      workflowId: workflow.id,
      startStepId: startStep.id,
      repositoryId: repository.id,
      worktreeExecutorProfileId: worktree!.profiles![0].id,
    },
    { release: false, description },
  );
  return { api, scenario };
}
