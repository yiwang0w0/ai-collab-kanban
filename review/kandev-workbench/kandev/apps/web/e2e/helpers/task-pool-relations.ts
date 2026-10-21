import { expect, type Page } from "@playwright/test";
import { linkToTask } from "../../lib/links";
import { poolRequest, readPoolHistory, type PoolTransport } from "./task-pool-api";

type RelationTask = { id: string; title: string };
type SourceTask = { workspace_id: string; workflow_id: string; workflow_step_id: string };

// @covers AC-TASKS-AGENT-POOL-004.2 AC-TASKS-AGENT-POOL-004.3
export async function exercisePoolDependencyNavigation(
  page: Page,
  frontendUrl: string,
  api: PoolTransport,
  ordinaryTaskId: string,
  options: { screenshotPath: string; touch?: boolean },
) {
  const { screenshotPath, touch = false } = options;
  const source = await poolRequest<SourceTask>(api, "GET", `/api/v1/tasks/${ordinaryTaskId}`);
  const create = (title: string) =>
    poolRequest<RelationTask>(api, "POST", "/api/v1/tasks", {
      workspace_id: source.workspace_id,
      workflow_id: source.workflow_id,
      workflow_step_id: source.workflow_step_id,
      title,
      start_agent: false,
      prepare_session: false,
    });
  const predecessor = await create("关系前置卡");
  const current = await create("关系当前卡");
  const successor = await create("关系后续卡");
  const add = (task: RelationTask, dependency: RelationTask) =>
    poolRequest(api, "POST", `/api/v1/tasks/${task.id}/dependencies`, {
      depends_on_task_id: dependency.id,
    });
  await add(current, predecessor);
  await add(successor, current);
  const cycle = await api.rawRequest("POST", `/api/v1/tasks/${predecessor.id}/dependencies`, {
    depends_on_task_id: successor.id,
  });
  expect(cycle.status).toBe(409);
  expect((await cycle.json()).cycle).toEqual([
    predecessor.id,
    successor.id,
    current.id,
    predecessor.id,
  ]);

  const open = async (task: RelationTask) => {
    await page.goto(`${frontendUrl}/task-pool?task=${task.id}`);
    await expect(page.getByTestId("pool-detail").getByRole("heading", { name: task.title })).toBeVisible();
  };
  const follow = async (from: RelationTask, to: RelationTask, label: string) => {
    await open(from);
    const link = page.getByTestId("pool-relations").getByRole("link", {
      name: `${label}: ${to.title}`,
      exact: true,
    });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("href", linkToTask(to.id));
    const height = (await link.boundingBox())!.height;
    if (touch) expect(height).toBeGreaterThanOrEqual(44);
    else expect(height).toBeCloseTo(28, 0);
    if (touch) await link.tap();
    else await link.click();
    await expect(page).toHaveURL((url) => url.pathname === linkToTask(to.id));
    await expect(
      page.getByTestId(touch ? "mobile-task-picker-trigger" : "task-topbar-title"),
    ).toContainText(to.title);
  };
  await follow(current, predecessor, "依赖任务");
  await follow(predecessor, current, "阻塞的任务");
  await follow(current, successor, "阻塞的任务");
  await follow(successor, current, "依赖任务");
  await open(current);
  await page.getByTestId("pool-relations").scrollIntoViewIfNeeded();
  expect(await page.locator("html").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: screenshotPath });
  for (const task of [predecessor, current, successor]) {
    expect((await readPoolHistory(api, task.id)).items).toHaveLength(0);
  }
}
