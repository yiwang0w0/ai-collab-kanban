import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import type { PoolRecoveryCommand, PoolRecoveryContext } from "@/lib/types/task-pool-recovery";
import { useTaskPoolRecovery, type PoolRecoveryInput } from "./use-task-pool-recovery";

const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/api/domains/task-pool-recovery-api", () => ({
  fetchPoolRecoveryContext: api.read,
  recoverPoolRun: api.write,
  fetchPoolRecoveryOperation: api.query,
}));
const state: PoolRecoveryContext = {
  task_id: "task",
  run_id: "run",
  entry_id: 1,
  claim_id: "",
  task_version: "2026-10-20T00:00:00.123456789Z",
  run_version: "a".repeat(64),
  management_version: "",
  actions: { withdraw: true, stop: false, retry: false },
};
const committed = vi.fn();
function input(): PoolRecoveryInput {
  return {
    taskId: "task",
    runId: "run",
    scope: "user:workspace:task:run",
    authenticated: true,
    fresh: true,
    onCommitted: committed,
  };
}
function result(command: PoolRecoveryCommand) {
  return {
    operation_id: command.operation_id,
    action: command.action,
    task_id: "task",
    run_id: "run",
    claim_id: "",
    result: "withdrawn",
    recorded_at: "2026-10-20T00:01:00Z",
    event_seq: 0,
  };
}
async function ready() {
  const hook = renderHook((props) => useTaskPoolRecovery(props), { initialProps: input() });
  await waitFor(() => expect(hook.result.current.read.data).toEqual(state));
  return hook;
}
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  api.read.mockResolvedValue(state);
  api.write.mockImplementation((_id, command) => Promise.resolve(result(command)));
});
afterEach(cleanup);

it("开详情与取消不写入；明确确认双击也只发送一次", async () => {
  const { result: hook } = await ready();
  expect(api.write).not.toHaveBeenCalled();
  act(() => expect(hook.current.prepare("withdraw")).toBe(true));
  act(() => hook.current.cancel());
  await act(async () => hook.current.confirm());
  expect(api.write).not.toHaveBeenCalled();
  act(() => hook.current.prepare("withdraw"));
  await act(async () => {
    await Promise.all([hook.current.confirm(), hook.current.confirm()]);
  });
  expect(api.write).toHaveBeenCalledOnce();
  expect(hook.current.status).toBe("submitted");
  expect(committed).toHaveBeenCalledOnce();
});

it("响应未知仅查询同一个操作；卸载及重新载入仍不重新发送", async () => {
  api.write.mockRejectedValue(new TypeError("连接中断"));
  const first = await ready();
  act(() => expect(first.result.current.prepare("withdraw")).toBe(true));
  await act(async () => first.result.current.confirm());
  expect(first.result.current.status).toBe("unknown");
  const command = api.write.mock.calls[0][1];
  act(() => expect(first.result.current.prepare("withdraw")).toBe(false));
  first.unmount();
  api.query.mockResolvedValue(result(command));
  const second = await ready();
  expect(second.result.current.status).toBe("unknown");
  await act(async () => second.result.current.query());
  expect(api.query).toHaveBeenCalledExactlyOnceWith("task", "run", command.operation_id);
  expect(api.write).toHaveBeenCalledOnce();
  expect(second.result.current.status).toBe("submitted");
});

it("失去登录、数据陈旧或服务端禁止动作时不能确认", async () => {
  const hook = await ready();
  act(() => hook.result.current.prepare("withdraw"));
  hook.rerender({ ...input(), fresh: false });
  await act(async () => hook.result.current.confirm());
  expect(api.write).not.toHaveBeenCalled();
  hook.rerender({ ...input(), authenticated: false });
  act(() => expect(hook.result.current.prepare("withdraw")).toBe(false));
});

it("明确冲突和伪造的成功响应都不产生成功通知", async () => {
  api.write.mockRejectedValueOnce(new ApiError("版本冲突", 409, {}));
  const hook = await ready();
  act(() => expect(hook.result.current.prepare("withdraw")).toBe(true));
  await act(async () => hook.result.current.confirm());
  expect(hook.result.current.status).toBe("rejected");
  api.write.mockResolvedValueOnce({ result: "withdrawn", run_id: "other" });
  act(() => expect(hook.result.current.prepare("withdraw")).toBe(true));
  await act(async () => hook.result.current.confirm());
  expect(hook.result.current.status).toBe("unknown");
  expect(committed).not.toHaveBeenCalled();
});

it("切换作用域后，迟到响应不污染当前卡片", async () => {
  let finish!: (value: unknown) => void;
  api.write.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const hook = await ready();
  act(() => expect(hook.result.current.prepare("withdraw")).toBe(true));
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.confirm();
  });
  const command = api.write.mock.calls[0][1];
  hook.rerender({ ...input(), scope: "other-scope" });
  await act(async () => {
    finish(result(command));
    await pending;
  });
  expect(committed).not.toHaveBeenCalled();
  expect(hook.result.current.status).toBe("idle");
});

it("旧作用域的确认回调不能执行新作用域的提议", async () => {
  const hook = await ready();
  const oldConfirm = hook.result.current.confirm;
  hook.rerender({ ...input(), scope: "other-scope" });
  await waitFor(() => expect(hook.result.current.read.loading).toBe(false));
  act(() => expect(hook.result.current.prepare("withdraw")).toBe(true));
  await act(async () => oldConfirm());
  expect(api.write).not.toHaveBeenCalled();
});

it("停止回执只确认请求；拿到更新原生版本后仍能由人确认重试", async () => {
  const stopping = {
    ...state,
    claim_id: "claim",
    actions: { withdraw: false, stop: true, retry: false },
  };
  api.read.mockResolvedValue(stopping);
  api.write.mockImplementation((_id, command) =>
    Promise.resolve({
      ...result(command),
      claim_id: "claim",
      result: "stop_requested",
    }),
  );
  const hook = renderHook(() => useTaskPoolRecovery(input()));
  await waitFor(() => expect(hook.result.current.canPrepare("stop")).toBe(true));
  act(() => expect(hook.result.current.prepare("stop")).toBe(true));
  await act(async () => hook.result.current.confirm());
  expect(hook.result.current.completedAction).toBe("stop");
  expect(hook.result.current.canPrepare("stop")).toBe(false);
  api.read.mockResolvedValue({
    ...stopping,
    run_version: "b".repeat(64),
    actions: { withdraw: false, stop: false, retry: true },
  });
  await act(async () => hook.result.current.read.refresh());
  await waitFor(() => expect(hook.result.current.canPrepare("retry")).toBe(true));
  act(() => expect(hook.result.current.prepare("retry")).toBe(true));
  expect(api.write).toHaveBeenCalledOnce();
  expect(hook.result.current.proposal?.operation_id).not.toBe(
    api.write.mock.calls[0][1].operation_id,
  );
});

it("同一运行从排队进入执行后立即重读恢复资格，不等待轮询", async () => {
  const hook = renderHook((props) => useTaskPoolRecovery(props), {
    initialProps: { ...input(), executionVersion: "queued" },
  });
  await waitFor(() => expect(hook.result.current.read.data).toEqual(state));
  api.read.mockResolvedValue({
    ...state,
    claim_id: "claim",
    actions: { withdraw: false, stop: true, retry: false },
  });
  hook.rerender({ ...input(), executionVersion: "started:claim" });
  await waitFor(() => expect(hook.result.current.canPrepare("stop")).toBe(true));
  expect(api.read).toHaveBeenCalledTimes(2);
  expect(api.write).not.toHaveBeenCalled();
});
