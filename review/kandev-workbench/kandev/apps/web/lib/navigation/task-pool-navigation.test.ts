import { describe, expect, it } from "vitest";
import { APP_DESTINATIONS } from "./core-destinations";
import { resolveSpaRoute } from "@/src/spa-routes";
import en from "@/src/locales/en/taskPool.json";
import ja from "@/src/locales/ja/taskPool.json";
import ko from "@/src/locales/ko/taskPool.json";
import pt from "@/src/locales/pt-pt/taskPool.json";
import zhCN from "@/src/locales/zh-cn/taskPool.json";
import zhHK from "@/src/locales/zh-hk/taskPool.json";
import zhTW from "@/src/locales/zh-tw/taskPool.json";

describe("任务指挥原生入口", () => {
  it.each([
    ["en", en.title, "Kandev · Task command"],
    ["ja", ja.title, "Kandev · タスク指揮"],
    ["ko", ko.title, "Kandev · 작업 지휘"],
    ["pt-pt", pt.title, "Kandev · Comando de tarefas"],
    ["zh-cn", zhCN.title, "Kandev · 任务指挥"],
    ["zh-hk", zhHK.title, "Kandev · 任務指揮"],
    ["zh-tw", zhTW.title, "Kandev · 任務指揮"],
  ])("%s 标题仅使用本项目品牌", (_locale, title, expected) => {
    expect(title).toBe(expected);
  });
  it("直接路由任务指挥，不落入普通看板", () => {
    expect(resolveSpaRoute("/task-pool", new URLSearchParams())).toEqual({ kind: "taskPool" });
  });
  it("手机菜单和命令导航都有同一入口", () => {
    const destination = APP_DESTINATIONS.find((item) => item.id === "task-pool");
    expect(destination?.surfaces).toEqual(expect.arrayContaining(["mobileMenu", "palette"]));
    expect(destination?.href).toBe("/task-pool");
  });
});
