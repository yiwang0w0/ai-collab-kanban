import { describe, expect, it } from "vitest";
import { poolRecoveryCommand, matchesPoolRecoveryResult } from "./task-pool-recovery";
import type { PoolRecoveryContext, PoolRecoveryResult } from "./types/task-pool-recovery";

export const recoveryContext: PoolRecoveryContext = {
  task_id: "task",
  run_id: "run",
  entry_id: 1,
  claim_id: "",
  task_version: "2026-10-20T01:02:03.123456789Z",
  run_version: "a".repeat(64),
  management_version: "native-version",
  actions: { withdraw: true, stop: false, retry: false },
};
const operationId = "bfa6649f-bbd2-4f84-924b-b0790dfe0afd";

describe("恢复确认凭据", () => {
  it("保留全部原生比较版本，不舍入纳秒或构造停止事实", () => {
    expect(poolRecoveryCommand(recoveryContext, "withdraw", operationId)).toEqual({
      action: "withdraw",
      operation_id: operationId,
      run_id: "run",
      expected_claim_id: "",
      expected_task_version: recoveryContext.task_version,
      expected_run_version: recoveryContext.run_version,
      expected_management_version: "native-version",
      confirm: true,
      confirm_cli_quota: false,
    });
  });
  it.each([
    { ...recoveryContext, task_version: "0" },
    { ...recoveryContext, task_version: "2026-02-30T00:00:00Z" },
    { ...recoveryContext, run_version: "unknown" },
    { ...recoveryContext, claim_id: "already-claimed" },
    { ...recoveryContext, actions: { withdraw: false, stop: false, retry: false } },
  ])("不确定或不适用的上下文不能生成动作", (state) => {
    expect(poolRecoveryCommand(state, "withdraw", operationId)).toBeNull();
  });
  it("停止及重试都须原生 claim，只有重试确认额度", () => {
    const state = {
      ...recoveryContext,
      claim_id: "native-claim",
      actions: { withdraw: false, stop: true, retry: true },
    };
    expect(poolRecoveryCommand(state, "stop", operationId)?.confirm_cli_quota).toBe(false);
    expect(poolRecoveryCommand(state, "retry", operationId)?.confirm_cli_quota).toBe(true);
    expect(poolRecoveryCommand({ ...state, claim_id: "" }, "retry", operationId)).toBeNull();
  });
  it("成功结果须绑定同任务、run、claim 和操作，时间来自合法原生回执", () => {
    const command = poolRecoveryCommand(recoveryContext, "withdraw", operationId)!;
    const result: PoolRecoveryResult = {
      task_id: "task",
      run_id: "run",
      claim_id: "",
      operation_id: operationId,
      action: "withdraw",
      result: "withdrawn",
      event_seq: 0,
      recorded_at: "2026-10-20T01:03:00.123456789Z",
    };
    expect(matchesPoolRecoveryResult(result, "task", command)).toBe(true);
    for (const patch of [
      { task_id: "other" },
      { run_id: "other" },
      { claim_id: "other" },
      { operation_id: "other" },
      { event_seq: -1 },
      { recorded_at: "0" },
      { result: "stop_requested" },
    ]) {
      expect(
        matchesPoolRecoveryResult({ ...result, ...patch } as PoolRecoveryResult, "task", command),
      ).toBe(false);
    }
  });
});
