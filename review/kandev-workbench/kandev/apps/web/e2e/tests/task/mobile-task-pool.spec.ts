import { expect, test } from "../../fixtures/test-base";

test.beforeAll(async ({ backend }) => {
  await backend.restart({ KANDEV_FEATURES_OFFICE: "false" });
});
test.afterAll(async ({ backend }) => {
  await backend.restart();
});

// @covers AC-TASKS-AGENT-POOL-004.1 AC-TASKS-AGENT-POOL-004.2 AC-TASKS-AGENT-POOL-004.3
test("手机筛选抽屉、直达详情和返回保留位置，触摸目标不小于44像素", async ({
  testPage: page,
  apiClient: api,
  seedData,
}) => {
  for (let index = 0; index < 12; index++)
    await api.createTask(seedData.workspaceId, `手机任务 ${index}`, {
      workflow_id: seedData.workflowId,
      workflow_step_id: seedData.startStepId,
    });
  await page.goto("/stats");
  await page.getByTestId("app-nav-trigger").tap();
  await page.getByRole("link", { name: "Kandev · Task command", exact: true }).tap();
  await expect(page).toHaveURL(/\/task-pool$/);
  await expect(page.getByTestId("pool-card-list")).toBeVisible();
  const filter = page.getByTestId("pool-filter-open");
  expect((await filter.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const id of [
    "pool-new-task",
    "pool-category-attention",
    "pool-category-pool",
    "pool-category-running",
    "pool-category-review",
  ]) {
    expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await filter.tap();
  const drawer = page.getByTestId("pool-filter-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("pool-search").fill("手机任务");
  expect((await drawer.boundingBox())!.width).toBeLessThan(page.viewportSize()!.width);
  await drawer.getByRole("button", { name: "Back to list", exact: true }).tap();
  await expect(drawer).toBeHidden();
  const card = page.getByTestId("pool-card-list").getByRole("button").last();
  await card.scrollIntoViewIfNeeded();
  const before = await page.getByTestId("pool-card-list").evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);
  await card.tap();
  await expect(page.getByTestId("pool-detail")).toBeVisible();
  await expect(page.getByTestId("pool-card-list")).toHaveCount(0);
  await page.getByTestId("pool-back").tap();
  await expect(page.getByTestId("pool-card-list")).toBeVisible();
  await expect
    .poll(() => page.getByTestId("pool-card-list").evaluate((element) => element.scrollTop))
    .toBe(before);
  await filter.tap();
  await expect(drawer.getByTestId("pool-search")).toHaveValue("手机任务");
  await drawer.getByRole("button", { name: "Back to list", exact: true }).tap();
  await expect(drawer).toHaveCount(0);
  expect(
    await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.evaluate(() => {
    document.cookie = "kandev_locale=zh-cn; path=/; SameSite=Lax";
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-cn");
  await expect(page.getByTestId("pool-category-attention")).toContainText("待我处理");
  await expect(page.getByTestId("pool-card-list").getByRole("button")).toHaveCount(12);
  await page.screenshot({ path: test.info().outputPath("task-pool-mobile.png") });
  for (const width of [767, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(filter).toBeVisible();
    expect((await filter.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`task-pool-touch-${width}.png`) });
  }
});
