import { expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { BackendContext } from "../fixtures/backend";
import type { PoolRecoveryResult } from "../../lib/types/task-pool-recovery";
import { DatabaseSync } from "./node-sqlite";
import { seedAuthenticatedPool } from "./task-pool-auth";
import { poolRequest, readPoolHistory, type PoolTransport } from "./task-pool-api";
import { dwell, waitForHttp } from "./causal-waits";
import { waitForFiniteAnimations } from "./animations";

// 只占用隔离数据库的原生并发计数，不伪造目标任务的领取、开工或停止证据。
function holdCapacity(
  backend: BackendContext,
  databaseName: string,
  profileId: string,
  workspaceId: string,
) {
  const databasePath = path.resolve(backend.tmpDir, databaseName);
  if (path.dirname(databasePath) !== path.resolve(backend.tmpDir) || !fs.existsSync(databasePath))
    throw new Error("恢复夹具数据库不在私有宿主目录");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `INSERT INTO runs (id,agent_profile_id,workspace_id,reason,status,requested_at,claimed_at)
      VALUES (?,?,?,'e2e_pool_capacity_only','claimed',?,?)`,
      )
      .run(id, profileId, workspaceId, now, now);
  } finally {
    database.close();
  }
  return () => {
    const cleanup = new DatabaseSync(databasePath);
    try {
      cleanup.prepare("DELETE FROM runs WHERE id=? AND reason='e2e_pool_capacity_only'").run(id);
    } finally {
      cleanup.close();
    }
  };
}

async function approveQueued(page: Page, api: PoolTransport, taskId: string, mobile: boolean) {
  const prepare = page.getByTestId("pool-release-prepare");
  await expect(prepare).toHaveCount(1);
  await expect(prepare).toBeEnabled();
  if (mobile) await prepare.tap();
  else await prepare.click();
  const committed = waitForHttp(page, "POST", new RegExp(`/tasks/${taskId}/move$`));
  if (mobile) await page.getByTestId("pool-release-confirm").tap();
  else await page.getByTestId("pool-release-confirm").click();
  expect((await committed).status()).toBe(200);
  await expect
    .poll(async () => (await readPoolHistory(api, taskId)).items[0]?.state)
    .toBe("queued");
  const history = await readPoolHistory(api, taskId);
  expect(history.items).toHaveLength(1);
  expect(history.items[0].claim_id).toBe("");
  expect(history.items[0].started_at).toBeNull();
  return history.items[0].run_id;
}

export type RecoveryUIInput = {
  page: Page;
  backend: BackendContext;
  context: BrowserContext;
  mobile: boolean;
  databaseName: string;
  outputPath: (name: string) => string;
};

async function confirmWithdrawal(input: RecoveryUIInput, taskId: string) {
  const { page, mobile } = input;
  const withdraw = page.getByTestId("pool-recovery-withdraw");
  await expect(withdraw).toHaveCount(1);
  await expect(withdraw).toBeEnabled();
  if (mobile) expect((await withdraw.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  else await expect(withdraw).toHaveCSS("height", "28px");
  if (mobile) await withdraw.tap();
  else await withdraw.click();
  const confirmation = page.getByTestId("pool-recovery-confirmation");
  await expect(confirmation).toHaveCount(1);
  await expect(confirmation).toContainText("不会停止进程");
  await waitForFiniteAnimations(confirmation);
  await expect(page.getByText("Kandev update available", { exact: true })).toBeHidden();
  if (mobile) {
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await waitForFiniteAnimations(page.getByRole("dialog"));
    expect(
      (await page.getByTestId("pool-recovery-confirm").boundingBox())!.height,
    ).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId("pool-recovery-confirm")).toBeInViewport({ ratio: 1 });
  }
  await page.screenshot({
    path: input.outputPath(`pool-recovery-${mobile ? "mobile" : "desktop"}-confirm.png`),
  });
  if (mobile) await confirmation.getByRole("button", { name: "取消", exact: true }).tap();
  else await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await dwell(page, 200, "negative-assertion", "取消确认没有服务器事件，观察恢复写入计数");
  await expect(page.getByTestId("pool-recovery-stop")).toBeDisabled();
  await expect(page.getByTestId("pool-recovery-retry")).toBeDisabled();
  const pathSuffix = `/tasks/${taskId}/pool-recovery`;
  let original: PoolRecoveryResult | undefined;
  await page.route(`**${pathSuffix}`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    original = await response.json();
    await route.abort("connectionreset");
  });
  if (mobile) await withdraw.tap();
  else await withdraw.click();
  if (mobile) await page.getByTestId("pool-recovery-confirm").tap();
  else await page.getByTestId("pool-recovery-confirm").click();
  await expect(page.getByTestId("pool-recovery-result")).toContainText("操作结果未知");
  expect(original?.result).toBe("withdrawn");
  return original!;
}

export async function exercisePoolRecovery(input: RecoveryUIInput) {
  const { page, backend, context, mobile, databaseName } = input;
  const { api, scenario } = await seedAuthenticatedPool(
    context,
    backend,
    `pool-recovery-repo-${randomUUID()}`,
  );
  const task = await poolRequest<{ workspace_id: string }>(
    api,
    "GET",
    `/api/v1/tasks/${scenario.taskId}`,
  );
  const releaseCapacity = holdCapacity(
    backend,
    databaseName,
    scenario.profileId,
    task.workspace_id,
  );
  let writes = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith(`/tasks/${scenario.taskId}/pool-recovery`)
    )
      writes++;
  });
  try {
    await page.goto(`${backend.frontendUrl}/task-pool?task=${scenario.taskId}`);
    const runId = await approveQueued(page, api, scenario.taskId, mobile);
    const original = await confirmWithdrawal(input, scenario.taskId);
    expect(writes).toBe(1);
    const read = waitForHttp(page, "GET", new RegExp(`/tasks/${scenario.taskId}/pool-recovery$`));
    await page.reload();
    expect((await read).status()).toBe(200);
    await expect(page.getByTestId("pool-recovery-result")).toContainText("操作结果未知");
    const receipt = waitForHttp(
      page,
      "GET",
      new RegExp(`/pool-recovery/${original.operation_id}$`),
    );
    if (mobile) await page.getByTestId("pool-recovery-query").tap();
    else await page.getByTestId("pool-recovery-query").click();
    expect(await (await receipt).json()).toEqual(original);
    await expect(page.getByTestId("pool-recovery-result")).toContainText("原生操作回执已确认");
    const history = await readPoolHistory(api, scenario.taskId);
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      run_id: runId,
      claim_id: "",
      state: "withdrawn",
      started_at: null,
      stopped_at: null,
      ended_at: original.recorded_at,
    });
    const timeline = page.getByTestId("pool-current-timeline").getByTestId("pool-timeline");
    await expect(timeline).toHaveCount(1);
    await expect(timeline.getByTestId("pool-time-withdrawn")).toBeVisible();
    await expect(timeline.getByTestId("pool-time-started")).toHaveCount(0);
    await expect(page.getByTestId("pool-recovery-withdraw")).toBeDisabled();
    await dwell(page, 200, "negative-assertion", "刷新及查询只读，确认未再次提交恢复操作");
    expect(writes).toBe(1);
    expect(
      await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: input.outputPath(`pool-recovery-${mobile ? "mobile" : "desktop"}-withdrawn.png`),
    });
  } finally {
    releaseCapacity();
  }
}
