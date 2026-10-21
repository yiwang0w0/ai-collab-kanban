import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  PoolRecoveryCommand,
  PoolRecoveryContext,
  PoolRecoveryResult,
} from "../../lib/types/task-pool-recovery";
import type { RecoveryUIInput } from "./task-pool-recovery";
import { seedAuthenticatedPool } from "./task-pool-auth";
import { poolRequest, readPoolHistory } from "./task-pool-api";
import { waitForHttp } from "./causal-waits";
import { waitForFiniteAnimations } from "./animations";
import { DatabaseSync } from "./node-sqlite";
import { restartVerifiedStop } from "./task-pool-restart";

function captureRecoveryEvidence(input: RecoveryUIInput, taskId: string, runId: string) {
  const databasePath = path.resolve(input.backend.tmpDir, input.databaseName);
  if (path.dirname(databasePath) !== path.resolve(input.backend.tmpDir))
    throw new Error("恢复证据目录越界");
  const database = new DatabaseSync(databasePath);
  try {
    const evidence = {
      task: database
        .prepare(
          "SELECT id,state,workflow_id,workflow_step_id,checkout_agent_id,checkout_run_id,checkout_at FROM tasks WHERE id=?",
        )
        .all(taskId),
      run: database
        .prepare("SELECT id,status,session_id,claimed_at,finished_at,outcome FROM runs WHERE id=?")
        .all(runId),
      sessions: database
        .prepare(
          "SELECT id,state,agent_profile_id,execution_profile_id,executor_id FROM task_sessions WHERE task_id=?",
        )
        .all(taskId),
      turns: database
        .prepare(
          "SELECT id,task_session_id,completed_at,execution_profile_id FROM task_session_turns WHERE task_id=?",
        )
        .all(taskId),
      executors: database
        .prepare(
          "SELECT id,session_id,agent_execution_id,execution_profile_id,executor_id,runtime,status FROM executors_running WHERE task_id=?",
        )
        .all(taskId),
      events: database
        .prepare(
          "SELECT seq,event_type,payload FROM run_events WHERE run_id=? AND event_type LIKE 'pool.%' ORDER BY seq",
        )
        .all(runId),
    };
    fs.writeFileSync(
      input.outputPath("pool-recovery-native-evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    if (fs.existsSync(input.backend.logPath))
      fs.copyFileSync(input.backend.logPath, input.outputPath("pool-recovery-backend.log"));
  } finally {
    database.close();
  }
}

async function confirmRecovery(
  page: Page,
  taskId: string,
  action: "stop" | "retry",
  mobile: boolean,
) {
  const trigger = page.getByTestId(`pool-recovery-${action}`);
  await expect(trigger).toHaveCount(1);
  await expect(trigger).toBeEnabled();
  if (mobile) await trigger.tap();
  else await trigger.click();
  const confirmation = page.getByTestId("pool-recovery-confirmation");
  await expect(confirmation).toHaveCount(1);
  await expect(confirmation).toContainText(action === "stop" ? "请求回执不代表" : "CLI");
  await waitForFiniteAnimations(confirmation);
  const confirm = page.getByTestId("pool-recovery-confirm");
  if (mobile) {
    expect((await confirm.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(confirm).toBeInViewport({ ratio: 1 });
  }
  const committed = waitForHttp(page, "POST", new RegExp(`/tasks/${taskId}/pool-recovery$`));
  if (mobile) await confirm.tap();
  else await confirm.click();
  const response = await committed;
  expect(response.status(), await response.text()).toBe(200);
  return {
    command: response.request().postDataJSON() as PoolRecoveryCommand,
    receipt: (await response.json()) as PoolRecoveryResult,
  };
}

export async function exercisePoolStopRetry(
  input: RecoveryUIInput & { restartAfterStop?: boolean },
) {
  const { page, context, backend, mobile } = input;
  const { api, scenario } = await seedAuthenticatedPool(
    context,
    backend,
    `pool-stop-${randomUUID()}`,
    'e2e:message("正在执行的模拟工作")\ne2e:delay(60000)\ne2e:message("模拟工作结束")',
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
    .poll(async () => (await readPoolHistory(api, scenario.taskId)).items[0]?.started_at, {
      timeout: 30_000,
    })
    .toBeTruthy();
  const first = (await readPoolHistory(api, scenario.taskId)).items[0];
  const eligibility = await poolRequest<PoolRecoveryContext>(
    api,
    "GET",
    `/api/v1/tasks/${scenario.taskId}/pool-recovery?run_id=${first.run_id}`,
  );
  expect(eligibility.actions.stop, JSON.stringify(eligibility)).toBe(true);
  const stopped = await confirmRecovery(page, scenario.taskId, "stop", mobile);
  expect(stopped.receipt.result).toBe("stop_requested");
  await expect(page.getByTestId("pool-recovery-result")).toContainText("不代表执行已停止");
  await expect
    .poll(async () => (await readPoolHistory(api, scenario.taskId)).items[0]?.stopped_at, {
      timeout: 30_000,
    })
    .toBeTruthy();
  const recoveryPath = `/api/v1/tasks/${scenario.taskId}/pool-recovery?run_id=${first.run_id}`;
  try {
    await expect
      .poll(
        async () => {
          const state = await poolRequest<PoolRecoveryContext>(api, "GET", recoveryPath);
          return { retry: state.actions.retry, reason: state.reason ?? "" };
        },
        { timeout: 30_000 },
      )
      .toEqual({ retry: true, reason: "" });
  } finally {
    captureRecoveryEvidence(input, scenario.taskId, first.run_id);
  }
  if (input.restartAfterStop) await restartVerifiedStop(input, api, scenario, stopped.receipt);
  const refresh = page
    .getByTestId("pool-recovery")
    .getByRole("button", { name: "刷新状态", exact: true });
  if (mobile) await refresh.tap();
  else await refresh.click();
  const retried = await confirmRecovery(page, scenario.taskId, "retry", mobile);
  expect(retried.receipt.result).toBe("requeued");
  expect(retried.receipt.run_id).toBe(first.run_id);
  await expect
    .poll(
      async () => {
        const history = await readPoolHistory(api, scenario.taskId);
        return history.items.some(
          (item) => item.claim_id !== first.claim_id && item.claim_id !== "" && item.started_at,
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const history = await readPoolHistory(api, scenario.taskId);
  expect(history.items).toHaveLength(2);
  const replacement = history.items.find((item) => item.claim_id !== first.claim_id)!;
  expect(replacement.run_id).toBe(first.run_id);
  expect(replacement.claim_id).not.toBe(first.claim_id);
  expect(history.items.find((item) => item.claim_id === first.claim_id)?.stopped_at).toBeTruthy();
  const replay = await poolRequest<PoolRecoveryResult>(
    api,
    "POST",
    `/api/v1/tasks/${scenario.taskId}/pool-recovery`,
    stopped.command,
  );
  expect(replay).toEqual(stopped.receipt);
  await page.reload();
  await expect(
    page.getByTestId("pool-current-timeline").getByTestId("pool-time-started"),
  ).toHaveCount(1);
  await expect(
    page.getByTestId("pool-current-timeline").getByTestId("pool-time-started"),
  ).toBeVisible();
  const after = await readPoolHistory(api, scenario.taskId);
  expect(after.items.map((item) => item.claim_id)).toEqual(
    history.items.map((item) => item.claim_id),
  );
  expect(after.items.find((item) => item.claim_id === replacement.claim_id)?.stopped_at).toBeNull();
  expect(
    await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: input.outputPath(`pool-stop-retry-${mobile ? "mobile" : "desktop"}.png`),
  });
}
