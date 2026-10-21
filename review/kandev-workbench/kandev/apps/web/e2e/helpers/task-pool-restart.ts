import { expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { PoolRecoveryContext, PoolRecoveryResult } from "../../lib/types/task-pool-recovery";
import type { RecoveryUIInput } from "./task-pool-recovery";
import { restartPoolAuthBackend } from "./task-pool-auth";
import { poolRequest, readPoolHistory, type PoolTransport } from "./task-pool-api";
import { dwell } from "./causal-waits";

export function poolTaskInvocations(input: RecoveryUIInput, taskId: string) {
  const trace = path.join(input.backend.tmpDir, `${input.databaseName}.acp.jsonl`);
  expect(fs.existsSync(trace), "真实模拟代理必须已经留下协议调用证据").toBe(true);
  const records = fs
    .readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, string>);
  const prompts = records.filter(
    (record) => record.event === "prompt" && record.prompt.includes(taskId),
  );
  return prompts.map((record) => ({
    process_id: record.process_id,
    session_id: record.session_id,
    connection_id: record.connection_id,
  }));
}

export async function observePoolRestart(
  input: RecoveryUIInput,
  api: PoolTransport,
  taskId: string,
) {
  const before = await readPoolHistory(api, taskId);
  const processes = poolTaskInvocations(input, taskId);
  expect(processes.length, "先证明目标任务确实收到原生提示，才能断言重启不重复执行").toBeGreaterThan(0);
  const oldPid = input.backend.pid();
  await restartPoolAuthBackend(input.backend, input.databaseName);
  expect(input.backend.pid()).not.toBe(oldPid);
  await input.page.reload();
  await expect(input.page.getByTestId("pool-detail")).toContainText("核验派发领取与开工");
  await dwell(
    input.page,
    6000,
    "negative-assertion",
    "跨过原生五秒领取 tick，观察重启是否再次调用模拟代理",
  );
  fs.copyFileSync(
    path.join(input.backend.tmpDir, `${input.databaseName}.acp.jsonl`),
    input.outputPath("pool-restart-acp.jsonl"),
  );
  fs.copyFileSync(input.backend.logPath, input.outputPath("pool-restart-backend.log"));
  // initialize/session_new 是能力探测；只按实际提示中的宿主任务 ID 关联执行调用。
  expect(poolTaskInvocations(input, taskId)).toEqual(processes);
  const after = await readPoolHistory(api, taskId);
  expect(after.items).toEqual(before.items);
  expect(after.snapshot_version).toBe(before.snapshot_version);
  return after;
}

export async function restartVerifiedStop(
  input: RecoveryUIInput,
  api: PoolTransport,
  scenario: { taskId: string; profileId: string },
  stopped: PoolRecoveryResult,
) {
  await expect
    .poll(async () => (await readPoolHistory(api, scenario.taskId)).items[0]?.ended_at)
    .toBeTruthy();
  await observePoolRestart(input, api, scenario.taskId);
  const { agents } = await poolRequest<{
    agents: Array<{ profiles: Array<{ id: string; model: string; auto_fallback: boolean }> }>;
  }>(api, "GET", "/api/v1/agents");
  const profiles = agents
    .flatMap((agent) => agent.profiles ?? [])
    .filter((profile) => profile.id === scenario.profileId);
  expect(profiles).toHaveLength(1);
  expect(profiles[0]).toMatchObject({ model: "mock-fast", auto_fallback: false });
  const receipt = await poolRequest<PoolRecoveryResult>(
    api,
    "GET",
    `/api/v1/tasks/${scenario.taskId}/pool-recovery/${stopped.operation_id}?run_id=${stopped.run_id}`,
  );
  expect(receipt).toEqual(stopped);
  const state = await poolRequest<PoolRecoveryContext>(
    api,
    "GET",
    `/api/v1/tasks/${scenario.taskId}/pool-recovery?run_id=${stopped.run_id}`,
  );
  expect(state.actions.retry, JSON.stringify(state)).toBe(true);
}
