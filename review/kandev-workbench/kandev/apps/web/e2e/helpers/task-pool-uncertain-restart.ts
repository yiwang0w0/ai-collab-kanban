import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { PoolRecoveryContext } from "../../lib/types/task-pool-recovery";
import type { RecoveryUIInput } from "./task-pool-recovery";
import { seedAuthenticatedPool } from "./task-pool-auth";
import { poolRequest, readPoolHistory } from "./task-pool-api";
import { waitForHttp } from "./causal-waits";
import { observePoolRestart, poolTaskInvocations } from "./task-pool-restart";

export async function exercisePoolUncertainRestart(input: RecoveryUIInput) {
  const { page, context, backend, mobile } = input;
  const { api, scenario } = await seedAuthenticatedPool(
    context,
    backend,
    `pool-uncertain-${randomUUID()}`,
    'e2e:delay(60000)\ne2e:message("不应重复执行的模拟工作")',
  );
  await page.goto(`${backend.frontendUrl}/task-pool?task=${scenario.taskId}`);
  const approve = page.getByTestId("pool-release-prepare");
  await expect(approve).toBeEnabled();
  if (mobile) await approve.tap();
  else await approve.click();
  const moved = waitForHttp(page, "POST", new RegExp(`/tasks/${scenario.taskId}/move$`));
  if (mobile) await page.getByTestId("pool-release-confirm").tap();
  else await page.getByTestId("pool-release-confirm").click();
  expect((await moved).status()).toBe(200);
  await expect
    .poll(async () => (await readPoolHistory(api, scenario.taskId)).items[0]?.execution_id, {
      timeout: 30_000,
    })
    .toBeTruthy();
  await expect.poll(() => poolTaskInvocations(input, scenario.taskId).length).toBe(1);
  const before = await readPoolHistory(api, scenario.taskId);
  expect(before.items).toHaveLength(1);
  const first = before.items[0];
  expect(first.claim_id).not.toBe("");
  expect(first.started_at).toBeNull();
  expect(first.stopped_at).toBeNull();
  await observePoolRestart(input, api, scenario.taskId);
  const recovery = await poolRequest<PoolRecoveryContext>(
    api,
    "GET",
    `/api/v1/tasks/${scenario.taskId}/pool-recovery?run_id=${first.run_id}`,
  );
  expect(recovery.actions.retry).toBe(false);
  expect(recovery.actions.withdraw).toBe(false);
  await expect(
    page.getByTestId("pool-current-timeline").getByTestId("pool-time-claimed"),
  ).toHaveCount(1);
  await expect(
    page.getByTestId("pool-current-timeline").getByTestId("pool-time-started"),
  ).toHaveCount(0);
  await expect(page.getByTestId("pool-recovery-retry")).toBeDisabled();
  await page.screenshot({
    path: input.outputPath(`pool-uncertain-restart-${mobile ? "mobile" : "desktop"}.png`),
  });
}
