import { expect } from "@playwright/test";
import { backendFixture as test } from "../../fixtures/backend";
import { restartPoolAuthBackend, seedAuthenticatedPool } from "../../helpers/task-pool-auth";
import { readPoolHistory } from "../../helpers/task-pool-api";
import { exercisePoolStartupPreference } from "../../helpers/task-pool-preference";
import { exercisePoolDependencyNavigation } from "../../helpers/task-pool-relations";
import { waitForFiniteAnimations } from "../../helpers/animations";

test.beforeAll(async ({ backend }) => {
  await restartPoolAuthBackend(backend, "pool-mobile-auth.db");
});
test.afterAll(async ({ backend }) => {
  await backend.restart();
});

// @covers AC-TASKS-AGENT-POOL-003.2 AC-TASKS-AGENT-POOL-003.3 AC-TASKS-AGENT-POOL-003.4 AC-TASKS-AGENT-POOL-004.2 AC-TASKS-AGENT-POOL-004.3
test("手机从原生底部确认批准任务，取消无派发，确认后显示真实开工", async ({
  context,
  page,
  backend,
}) => {
  const { api, scenario } = await seedAuthenticatedPool(context, backend);
  await page.goto(`${backend.frontendUrl}/task-pool?task=${scenario.taskId}`);
  await expect(page.getByTestId("pool-card-list")).toHaveCount(0);
  const approve = page.getByTestId("pool-release-prepare");
  await expect(approve).toBeEnabled();
  expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await approve.tap();
  const confirmation = page.getByTestId("pool-release-confirmation");
  await expect(confirmation).toBeVisible();
  expect(
    (await page.getByTestId("pool-release-confirm").boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  await expect(confirmation).toContainText("核验派发领取与开工");
  await expect(page.getByTestId("pool-release-confirm")).toBeInViewport({ ratio: 1 });
  await waitForFiniteAnimations(page.getByRole("dialog"));
  await expect(page.getByText("Kandev update available", { exact: true })).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("task-pool-mobile-approve.png") });
  await confirmation.getByRole("button", { name: "取消", exact: true }).tap();
  await expect(confirmation).toHaveCount(0);
  expect((await readPoolHistory(api, scenario.taskId)).items).toHaveLength(0);
  await approve.tap();
  await page.getByTestId("pool-release-confirm").tap();
  await expect
    .poll(async () => (await readPoolHistory(api, scenario.taskId)).items[0]?.started_at, {
      timeout: 30_000,
    })
    .toBeTruthy();
  await expect(page.getByTestId("pool-time-started").first()).toBeVisible();
  expect(
    await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("task-pool-mobile-dispatched.png") });
  await exercisePoolStartupPreference(page, backend.frontendUrl, api, true);
  await exercisePoolDependencyNavigation(
    page,
    backend.frontendUrl,
    api,
    scenario.parentId,
    { screenshotPath: test.info().outputPath("task-pool-dependencies-mobile.png"), touch: true },
  );
});
