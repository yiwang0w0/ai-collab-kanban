import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTaskPool, fetchTaskPoolHistory } from "./task-pool-api";

afterEach(() => vi.unstubAllGlobals());

describe("任务池读取边界", () => {
  it("只用有界原生 GET，转义工作区和分页游标，不产生派发写入", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ items: [], next_cursor: "" })));
    vi.stubGlobal("fetch", fetchSpy);
    await fetchTaskPool("space/a", "cursor+=", { baseUrl: "http://pool.test" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "http://pool.test/api/v1/workspaces/space%2Fa/task-pool?limit=50&cursor=cursor%2B%3D",
    );
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
  });
  it("历史仅对选中任务读取，每页最多五十条", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ items: [], next_cursor: "" })));
    vi.stubGlobal("fetch", fetchSpy);
    await fetchTaskPoolHistory("task/a", "", { baseUrl: "http://pool.test" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "http://pool.test/api/v1/tasks/task%2Fa/pool-history?limit=50",
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
  it("服务拒绝不能被转换为空任务池", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response('{"code":"pool_projection_unavailable"}', { status: 503 })),
    );
    await expect(fetchTaskPool("space", "", { baseUrl: "http://pool.test" })).rejects.toThrow();
  });
});
