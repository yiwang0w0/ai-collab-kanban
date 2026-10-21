import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePoolRead } from "./use-task-pool";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("工作台作用域和失效读取", () => {
  it("自动读取失败后退避三十秒，期间不反复请求", async () => {
    vi.useFakeTimers();
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("临时不可用"))
      .mockResolvedValue("恢复后的快照");
    const { result } = renderHook(() => usePoolRead("A", loader));
    await act(async () => {});
    expect(result.current.error).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(loader).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("恢复后的快照");
  });
  it("隐藏页面不发起新读取，重新可见后才核实状态", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const loader = vi.fn().mockResolvedValue("恢复可见后的快照");
    const { result } = renderHook(() => usePoolRead("A", loader));
    await act(async () => {});
    expect(loader).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(result.current.data).toBe("恢复可见后的快照"));
  });
  it("切换工作区后拒绝迟到数据和旧错误，不显示上一个工作区", async () => {
    let resolveFirst!: (value: string) => void;
    const loader = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce("B 的记录");
    const { result, rerender } = renderHook(({ scope }) => usePoolRead(scope, loader), {
      initialProps: { scope: "A" },
    });
    await waitFor(() => expect(loader).toHaveBeenCalledOnce());
    rerender({ scope: "B" });
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data).toBe("B 的记录"));
    await act(async () => resolveFirst("A 的旧记录"));
    expect(result.current.data).toBe("B 的记录");
  });
  it("刷新失败保留最后确认数据和时刻，但明确记录错误", async () => {
    const loader = vi.fn().mockResolvedValueOnce("已领取").mockRejectedValueOnce(new Error("断线"));
    const { result } = renderHook(() => usePoolRead("A", loader));
    await waitFor(() => expect(result.current.data).toBe("已领取"));
    const confirmed = result.current.confirmedAt;
    await act(async () => result.current.refresh());
    expect(result.current.data).toBe("已领取");
    expect(result.current.confirmedAt).toBe(confirmed);
    expect(result.current.error).toBeTruthy();
  });
  it("同作用域的旧读取不能覆盖手动刷新后的结果", async () => {
    let resolveFirst!: (value: string) => void;
    const loader = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce("新快照");
    const { result } = renderHook(() => usePoolRead("A", loader));
    await waitFor(() => expect(loader).toHaveBeenCalledOnce());
    await act(async () => result.current.refresh());
    await act(async () => resolveFirst("旧快照"));
    expect(result.current.data).toBe("新快照");
  });
});
