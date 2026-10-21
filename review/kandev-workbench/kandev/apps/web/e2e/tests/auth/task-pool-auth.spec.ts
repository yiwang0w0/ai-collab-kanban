import { expect } from "@playwright/test";
import { backendFixture as test } from "../../fixtures/backend";
import { restartPoolAuthBackend, seedAuthenticatedPool } from "../../helpers/task-pool-auth";
import { readPoolHistory } from "../../helpers/task-pool-api";
import { exercisePoolStartupPreference } from "../../helpers/task-pool-preference";
import { exercisePoolDependencyNavigation } from "../../helpers/task-pool-relations";

test.beforeAll(async ({ backend }) => {
  await restartPoolAuthBackend(backend, "pool-auth.db");
});
test.afterAll(async ({ backend }) => {
  await backend.restart();
});

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-003.1 AC-TASKS-AGENT-POOL-003.2 AC-TASKS-AGENT-POOL-003.4 AC-TASKS-AGENT-POOL-004.2 AC-TASKS-AGENT-POOL-004.3
test("已登录操作者从界面批准派发，显示真实领取开工与关联，读取不增加尝试", async ({
  context,
  page,
  backend,
}) => {
  const { api, scenario } = await seedAuthenticatedPool(context, backend);
  expect((await readPoolHistory(api, scenario.taskId)).items).toHaveLength(0);
  await page.goto(`${backend.frontendUrl}/task-pool?task=${scenario.taskId}`);
  await expect(page.getByTestId("pool-detail")).toContainText("核验派发领取与开工");
  const approve = page.getByTestId("pool-release-prepare");
  await expect(approve).toBeEnabled();
  await expect(approve).toHaveCSS("height", "28px");
  await approve.click();
  const confirmation = page.getByTestId("pool-release-confirmation");
  await expect(confirmation).toContainText("CLI");
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  expect((await readPoolHistory(api, scenario.taskId)).items).toHaveLength(0);
  await approve.click();
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith(`/tasks/${scenario.taskId}/move`),
  );
  await page.getByTestId("pool-release-confirm").click();
  expect((await sent).postDataJSON()).toMatchObject({
    workflow_step_id: scenario.poolStepId,
    pool_release: { confirm_cli_quota: true },
  });
  await expect
    .poll(async () => (await readPoolHistory(api, scenario.taskId)).items[0]?.started_at, {
      timeout: 30_000,
    })
    .toBeTruthy();
  const before = (await readPoolHistory(api, scenario.taskId)).items.map(
    (item) => `${item.run_id}:${item.claim_id}`,
  );
  for (const kind of ["queued", "claimed", "started"])
    await expect(page.getByTestId(`pool-time-${kind}`).first()).toBeVisible();
  await expect(page.getByTestId("pool-relations").getByRole("link")).toHaveAttribute(
    "href",
    new RegExp(`/t/${scenario.parentId}`),
  );
  await page.getByTestId("pool-refresh").click();
  await page.reload();
  await expect(page.getByTestId("pool-time-started").first()).toBeVisible();
  expect(
    (await readPoolHistory(api, scenario.taskId)).items.map(
      (item) => `${item.run_id}:${item.claim_id}`,
    ),
  ).toEqual(before);
  await expect(page.getByTestId("pool-new-task")).toHaveCSS("height", "28px");
  expect(
    await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("task-pool-desktop.png") });
  await page.goto(`${backend.frontendUrl}/task-pool?task=${scenario.parentId}`);
  await expect(
    page.getByTestId("pool-relations").getByRole("link").filter({ hasText: "子任务" }),
  ).toHaveAttribute("href", new RegExp(`/t/${scenario.taskId}`));
  await exercisePoolDependencyNavigation(
    page,
    backend.frontendUrl,
    api,
    scenario.parentId,
    { screenshotPath: test.info().outputPath("task-pool-dependencies-desktop.png") },
  );
  await page.goto(`${backend.frontendUrl}/task-pool?task=${scenario.taskId}`);
  for (const width of [767, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("pool-detail")).toBeVisible();
    expect(
      await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`task-pool-fine-${width}.png`) });
  }
  await exercisePoolStartupPreference(page, backend.frontendUrl, api);
});
