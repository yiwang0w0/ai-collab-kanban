import { expect, test } from "../../fixtures/test-base";
import { seedPoolTask } from "../../helpers/task-pool-api";

test.beforeAll(async ({ backend }) => {
  await backend.restart({
    KANDEV_FEATURES_OFFICE: "false",
    KANDEV_MOCK_AGENT: "only",
    KANDEV_MOCK_PROVIDERS: "claude-acp",
  });
});
test.afterAll(async ({ backend }) => {
  await backend.restart();
});

// @covers AC-TASKS-AGENT-POOL-003.1 AC-TASKS-AGENT-POOL-003.2 AC-TASKS-AGENT-POOL-003.3 AC-TASKS-AGENT-POOL-003.4
test("匿名页面不能伪造真人批准或池领取", async ({ testPage: page, apiClient: api, seedData }) => {
  await expect(seedPoolTask(api, seedData)).rejects.toThrow(
    "pool_release_human_confirmation_required",
  );
  await page.goto("/task-pool");
  await expect(page.getByTestId("pool-card-list")).toContainText("关联主任务");
  await expect(page.getByTestId("pool-time-claimed")).toHaveCount(0);
  await expect(page.getByTestId("pool-new-task")).toHaveCSS("height", "28px");
});

test("读取故障显示待核实而不是空池，页面不写入执行动作", async ({
  testPage: page,
  apiClient: api,
  seedData,
}) => {
  await api.createTask(seedData.workspaceId, "尚未批准的任务", {
    workflow_id: seedData.workflowId,
    workflow_step_id: seedData.startStepId,
  });
  await page.goto("/task-pool");
  await expect(page.getByTestId("pool-card-list")).toContainText("尚未批准的任务");
  await page.route("**/api/v1/workspaces/*/task-pool?*", (route) => route.abort("failed"));
  const failed = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("/task-pool?limit="),
  );
  await page.getByTestId("pool-refresh").click();
  await failed;
  await expect(page.getByTestId("pool-freshness")).toContainText("Refresh needed");
  await expect(page.getByTestId("pool-card-list")).toContainText("尚未批准的任务");
  await expect(page.getByTestId("pool-empty")).toHaveCount(0);
});
