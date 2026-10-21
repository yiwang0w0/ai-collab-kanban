import { describe, expect, it } from "vitest";
import { parseStartupPage, mapUserSettingsData } from "./ssr/user-settings";
import { resolveStartupListingRedirect } from "./startup-page";
import { resolveHomeHref } from "./navigation/workspace-home";
import type { StartupPage } from "./types/http-user-settings";

describe("可选原生任务指挥入口", () => {
  it("原生设置读取保留任务指挥入口和原看板偏好", () => {
    expect(parseStartupPage("task_pool")).toBe("task_pool");
    const settings = mapUserSettingsData({ startup_page: "task_pool", kanban_view_mode: "kanban" });
    expect(settings.startupPage).toBe("task_pool");
    expect(settings.kanbanViewMode).toBe("kanban");
  });
  it("已有工作区可直达任务指挥，但保留显式任务及概览意图", () => {
    const input = {
      startupPage: "task_pool" as StartupPage,
      preferredView: "kanban" as const,
      workspaceId: "workspace",
      searchParams: new URLSearchParams(),
    };
    expect(resolveStartupListingRedirect(input)).toBe("/task-pool");
    expect(
      resolveHomeHref({
        workspaceId: "workspace",
        inOffice: false,
        startupPage: "task_pool" as StartupPage,
      }),
    ).toBe("/task-pool");
    for (const query of ["taskId=task", "sessionId=session", "workflowId=flow", "home=overview"])
      expect(
        resolveStartupListingRedirect({ ...input, searchParams: new URLSearchParams(query) }),
      ).toBeNull();
    expect(resolveStartupListingRedirect({ ...input, workspaceId: undefined })).toBeNull();
    expect(
      resolveHomeHref({
        workspaceId: "office",
        inOffice: true,
        startupPage: "task_pool" as StartupPage,
      }),
    ).not.toBe("/task-pool");
  });
});
