import { afterEach, expect, it, vi } from "vitest";
import {
  fetchPoolRecoveryContext,
  fetchPoolRecoveryOperation,
  recoverPoolRun,
} from "./task-pool-recovery-api";
import type { PoolRecoveryCommand } from "@/lib/types/task-pool-recovery";

afterEach(() => vi.unstubAllGlobals());

it("只读确认上下文和同一操作查询不提交写入，使用正确编码及 no-store", async () => {
  const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}")));
  vi.stubGlobal("fetch", fetchSpy);
  const options = { baseUrl: "http://pool.test" };
  await fetchPoolRecoveryContext("task/a", "run/a", options);
  await fetchPoolRecoveryOperation("task/a", "run/a", "operation/a", options);
  expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
    "http://pool.test/api/v1/tasks/task%2Fa/pool-recovery?run_id=run%2Fa",
    "http://pool.test/api/v1/tasks/task%2Fa/pool-recovery/operation%2Fa?run_id=run%2Fa",
  ]);
  for (const [, init] of fetchSpy.mock.calls) {
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe("no-store");
  }
});

it("只发送原始版本与明确操作，不自报执行者或停止时间", async () => {
  const fetchSpy = vi.fn().mockResolvedValue(new Response('{"result":"withdrawn"}'));
  vi.stubGlobal("fetch", fetchSpy);
  const command: PoolRecoveryCommand = {
    action: "withdraw",
    operation_id: "operation",
    run_id: "run",
    expected_claim_id: "",
    expected_task_version: "2026-10-20T00:00:00.123456789Z",
    expected_run_version: "native-hash",
    expected_management_version: "native-version",
    confirm: true,
    confirm_cli_quota: false,
  };
  await recoverPoolRun("task", command, { baseUrl: "http://pool.test" });
  expect(fetchSpy).toHaveBeenCalledOnce();
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe("http://pool.test/api/v1/tasks/task/pool-recovery");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual(command);
});
