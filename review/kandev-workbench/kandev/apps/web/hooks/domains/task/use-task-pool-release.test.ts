import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import type { PoolCard } from "@/lib/types/task-pool";
import { useTaskPoolRelease } from "./use-task-pool-release";

const api = vi.hoisted(() => ({ task: vi.fn(), steps: vi.fn(), move: vi.fn() }));
vi.mock("@/lib/api/domains/kanban-api", () => ({ fetchTask: api.task, moveTask: api.move }));
vi.mock("@/lib/api/domains/workflow-api", () => ({ listWorkflowSteps: api.steps }));
const card = {
  task_id: "task",
  workflow_id: "flow",
  workflow_step_id: "backlog",
  pool_execution: null,
  eligibility: { state: "not_applicable", reason: "pool_stage_not_configured" },
} as PoolCard;
const task = {
  id: "task",
  workspace_id: "workspace",
  workflow_id: "flow",
  workflow_step_id: "backlog",
  updated_at: "2026-10-20T01:02:03.123456789Z",
  state: "TODO",
  depends_on: [],
};
const step = {
  id: "pool",
  workflow_id: "flow",
  name: "实施",
  updated_at: "2026-10-20T01:00:00.987654321Z",
  agent_profile_id: "profile",
  events: { on_enter: [{ type: "queue_run", config: { pool_version: 1 } }] },
};
const committed = vi.fn();
function input() {
  return {
    card,
    workspaceId: "workspace",
    authenticated: true,
    fresh: true,
    onCommitted: committed,
  };
}
async function ready() {
  const hook = renderHook(() => useTaskPoolRelease(input()));
  await waitFor(() => expect(hook.result.current.targets).toHaveLength(1));
  act(() => expect(hook.result.current.prepare("pool")).toBe(true));
  return hook;
}
beforeEach(() => {
  vi.resetAllMocks();
  api.task.mockResolvedValue(task);
  api.steps.mockResolvedValue({ steps: [step] });
  api.move.mockResolvedValue({ id: "task" });
});
afterEach(cleanup);

describe("真人批准动作的原生传输边界", () => {
  it("取消和未准备的确认均不移动", async () => {
    const { result } = await ready();
    act(() => result.current.cancel());
    await act(async () => result.current.confirm());
    expect(api.move).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  });
  it("成功只发送一次原生 move，并刷新而不伪造领取", async () => {
    const { result } = await ready();
    await act(async () => result.current.confirm());
    expect(api.move).toHaveBeenCalledExactlyOnceWith("task", {
      workflow_id: "flow",
      workflow_step_id: "pool",
      pool_release: {
        confirm_cli_quota: true,
        expected_resource_version: task.updated_at,
        expected_step_version: step.updated_at,
      },
    });
    expect(committed).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("submitted");
    expect(result.current.proposal).toBeNull();
  });
  it("同一个同步事件中的双击也只有一个在途写入", async () => {
    let finish!: () => void;
    api.move.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = await ready();
    let first!: Promise<void>;
    act(() => {
      first = result.current.confirm();
      void result.current.confirm();
    });
    expect(api.move).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("sending");
    await act(async () => {
      finish();
      await first;
    });
  });
  it("明确拒绝不回报成功；网络响应未知不自动重发或重新批准", async () => {
    api.move.mockRejectedValueOnce(new ApiError("版本冲突", 409, {}));
    const { result } = await ready();
    await act(async () => result.current.confirm());
    expect(result.current.status).toBe("rejected");
    expect(committed).not.toHaveBeenCalled();
    api.move.mockRejectedValueOnce(new TypeError("连接中断"));
    act(() => expect(result.current.prepare("pool")).toBe(true));
    await act(async () => result.current.confirm());
    expect(result.current.status).toBe("unknown");
    act(() => expect(result.current.prepare("pool")).toBe(false));
    await act(async () => result.current.confirm());
    expect(api.move).toHaveBeenCalledTimes(2);
  });
});

describe("确认作用域和迟到响应", () => {
  it("过期或失去权限后不发送已有确认", async () => {
    const { result, rerender } = renderHook((props) => useTaskPoolRelease(props), {
      initialProps: input(),
    });
    await waitFor(() => expect(result.current.targets).toHaveLength(1));
    act(() => result.current.prepare("pool"));
    rerender({ ...input(), fresh: false });
    await act(async () => result.current.confirm());
    expect(api.move).not.toHaveBeenCalled();
    rerender({ ...input(), authenticated: false });
    act(() => expect(result.current.prepare("pool")).toBe(false));
  });
  it("工作区改变和迟到写响应不能污染新上下文", async () => {
    let finish!: () => void;
    api.move.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook((props) => useTaskPoolRelease(props), {
      initialProps: input(),
    });
    await waitFor(() => expect(result.current.targets).toHaveLength(1));
    act(() => result.current.prepare("pool"));
    let first!: Promise<void>;
    act(() => {
      first = result.current.confirm();
    });
    rerender({ ...input(), workspaceId: "other" });
    expect(result.current.proposal).toBeNull();
    await act(async () => {
      finish();
      await first;
    });
    expect(committed).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });
  it("读取失败没有可批准目标", async () => {
    api.task.mockRejectedValue(new Error("无权限"));
    const { result } = renderHook(() => useTaskPoolRelease(input()));
    await waitFor(() => expect(result.current.read.error).toBeTruthy());
    expect(result.current.targets).toEqual([]);
    act(() => expect(result.current.prepare("pool")).toBe(false));
  });
  it("离开再回到相同任务，旧写入仍不能回报为当前操作", async () => {
    let finish!: () => void;
    api.move.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook((props) => useTaskPoolRelease(props), {
      initialProps: input(),
    });
    await waitFor(() => expect(result.current.targets).toHaveLength(1));
    act(() => result.current.prepare("pool"));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.confirm();
    });
    rerender({ ...input(), workspaceId: "other" });
    rerender(input());
    await act(async () => {
      finish();
      await pending;
    });
    expect(committed).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });
  it("详情已卸载时迟到成功不能通知原页面", async () => {
    let finish!: () => void;
    api.move.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result, unmount } = await ready();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.confirm();
    });
    unmount();
    await act(async () => {
      finish();
      await pending;
    });
    expect(committed).not.toHaveBeenCalled();
  });
});
