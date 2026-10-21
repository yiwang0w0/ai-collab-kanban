import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTask, moveTask } from "./kanban-api";

const fetchSpy = vi.fn<typeof fetch>();
const API_BASE_URL = "http://pool-api.test";

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify({ task: { id: "pool-task" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("任务池批准请求契约", () => {
  it("直接创建保留原始阶段版本和空的初始任务版本，不虚构已有卡片版本", async () => {
    const payload: Parameters<typeof createTask>[0] = {
      workspace_id: "pool-workspace",
      workflow_id: "pool-workflow",
      workflow_step_id: "pool-step",
      title: "直接创建入池",
      pool_release: {
        confirm_cli_quota: true,
        expected_resource_version: "",
        expected_step_version: "2026-10-17T08:07:06.987654321Z",
      },
    };
    await createTask(payload, { baseUrl: API_BASE_URL });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/api/v1/tasks`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(payload);
  });

  it("普通创建不会生成池批准", async () => {
    const payload = { workspace_id: "ordinary-ws", workflow_id: "ordinary-wf", title: "普通卡片" };
    await createTask(payload, { baseUrl: API_BASE_URL });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual(payload);
  });

  it("保留明确确认和两个原始版本，不生成执行者或派发时间", async () => {
    const confirmation = {
      confirm_cli_quota: true,
      expected_resource_version: "2026-10-18T12:34:56.123456789Z",
      expected_step_version: "2026-10-17T08:07:06.987654321Z",
    };
    const payload = {
      workflow_id: "pool-workflow",
      workflow_step_id: "pool-step",
      pool_release: confirmation,
    };

    await moveTask("pool-task", payload, { baseUrl: API_BASE_URL });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/api/v1/tasks/pool-task/move`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(payload);
    expect(payload.pool_release).toEqual(confirmation);
  });

  it("普通移动不补造批准，空的阶段选项也不使批准字段出现", async () => {
    await moveTask(
      "pool-task",
      { workflow_id: "ordinary-workflow", workflow_step_id: "ordinary-step", entry_options: {} },
      { baseUrl: API_BASE_URL },
    );

    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      workflow_id: "ordinary-workflow",
      workflow_step_id: "ordinary-step",
    });
  });
});
