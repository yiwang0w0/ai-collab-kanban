import { beforeEach, expect, it } from "vitest";
import {
  forgetPendingPoolRecovery,
  readPendingPoolRecovery,
  savePendingPoolRecovery,
} from "./task-pool-recovery-pending";
import type { PoolRecoveryCommand } from "./types/task-pool-recovery";

function command(index = 1): PoolRecoveryCommand {
  return {
    action: "withdraw",
    operation_id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    run_id: "run",
    expected_claim_id: "",
    expected_task_version: "2026-10-20T00:00:00.123456789Z",
    expected_run_version: "a".repeat(64),
    expected_management_version: "",
    confirm: true,
    confirm_cli_quota: false,
  };
}
beforeEach(() => sessionStorage.clear());

it("待查询凭据按宿主、用户和任务作用域隔离，不跨运行借用", () => {
  savePendingPoolRecovery("host:user:task", command());
  expect(readPendingPoolRecovery("host:other-user:task", "run")).toBeNull();
  expect(readPendingPoolRecovery("other-host:user:task", "run")).toBeNull();
  expect(readPendingPoolRecovery("host:user:task", "run")).toEqual(command());
  expect(() => readPendingPoolRecovery("host:user:task", "other-run")).toThrow();
});

it("未解决的同作用域凭据不能被新操作覆盖，旧响应不能删除新凭据", () => {
  savePendingPoolRecovery("scope", command());
  expect(() => savePendingPoolRecovery("scope", command(2))).toThrow();
  forgetPendingPoolRecovery("scope", command(2).operation_id);
  expect(readPendingPoolRecovery("scope", "run")).toEqual(command());
  forgetPendingPoolRecovery("scope", command().operation_id);
  expect(readPendingPoolRecovery("scope", "run")).toBeNull();
});

it("最多保存三十二项，满额不丢弃未知凭据来允许新写入", () => {
  for (let index = 1; index <= 32; index++)
    savePendingPoolRecovery(`scope:${index}`, command(index));
  expect(() => savePendingPoolRecovery("scope:33", command(33))).toThrow();
  expect(readPendingPoolRecovery("scope:1", "run")).toEqual(command(1));
});

it("损坏或过量会话存储失败关闭，不能被解释成没有待确认操作", () => {
  for (const raw of ["{", "{}", "x".repeat(65537)]) {
    sessionStorage.setItem("kandev.pool-recovery-pending.v1", raw);
    expect(() => readPendingPoolRecovery("scope", "run")).toThrow();
  }
});
