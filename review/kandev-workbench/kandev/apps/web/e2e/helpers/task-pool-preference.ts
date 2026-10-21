import { expect, type Page } from "@playwright/test";
import { poolRequest, type PoolTransport } from "./task-pool-api";

// @covers AC-TASKS-AGENT-POOL-003.1 AC-TASKS-AGENT-POOL-003.3
export async function exercisePoolStartupPreference(
  page: Page,
  frontendUrl: string,
  api: PoolTransport,
  touch = false,
) {
  type Settings = { settings: { startup_page: string; kanban_view_mode: string } };
  const before = (await poolRequest<Settings>(api, "GET", "/api/v1/user/settings")).settings;
  const storageKey = "kandev.taskListing.view.v1";
  const listingBefore = await page.evaluate((key) => localStorage.getItem(key), storageKey);
  await page.goto(frontendUrl + "/settings/preferences/appearance");
  const choice = page.getByRole("radio", { name: "Kandev · 任务指挥", exact: true });
  await expect(choice).toBeVisible();
  if (touch) await choice.tap();
  else await choice.click();
  expect(
    (await poolRequest<Settings>(api, "GET", "/api/v1/user/settings")).settings.startup_page,
  ).toBe(before.startup_page);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith("/api/v1/user/settings") &&
      response.request().postDataJSON()?.startup_page === "task_pool",
  );
  const save = page
    .getByTestId("settings-floating-save")
    .getByRole("button", { name: "保存更改", exact: true });
  if (touch) await save.tap();
  else await save.click();
  expect((await saved).status()).toBe(200);
  const after = (await poolRequest<Settings>(api, "GET", "/api/v1/user/settings")).settings;
  expect(after.startup_page).toBe("task_pool");
  expect(after.kanban_view_mode).toBe(before.kanban_view_mode);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(listingBefore);
  await page.reload();
  await expect(choice).toBeChecked();
  await page.goto(frontendUrl + "/");
  await expect(page).toHaveURL((url) => url.pathname === "/task-pool");
  await expect(page.getByTestId("pool-card-list")).toBeVisible();
}
