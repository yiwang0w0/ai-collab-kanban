import { describe, expect, it } from "vitest";
import type { PoolCard, PoolExecution } from "./types/task-pool";
import {
  poolCategory,
  poolTimeline,
  poolCardTimes,
  poolFreshness,
  poolReasonGroup,
  poolPageChildren,
} from "./task-pool-view-model";

function card(state?: PoolExecution["state"], reason = "") {
  return {
    task_id: "task",
    title: "修复回调",
    workflow_id: "flow",
    workflow_step_id: "step",
    stage: "实施",
    task_state: "IN_PROGRESS",
    eligibility: { state: "occupied", reason },
    relations: { parent_id: "", child_count: 0, depends_on_count: 0, blocks_count: 0 },
    pool_execution: state ? { state, current: true } : null,
  } as PoolCard;
}

describe("任务池只呈现已核实的原生事实", () => {
  it("撤回归待处理，回执时刻不显示成停止或验收完成", () => {
    const value = card("withdrawn");
    value.pool_execution!.ended_at = "2026-10-20T00:00:03Z";
    expect(poolCategory(value)).toBe("attention");
    expect(poolTimeline(value.pool_execution).map((point) => point.kind)).toEqual(["withdrawn"]);
    expect(poolReasonGroup("pool_withdrawn")).toBe("withdrawn");
  });
  it("复用当前有界页面的直接子卡，不把其他父卡或自身当作子卡", () => {
    const child = {
      ...card(),
      task_id: "child",
      relations: { ...card().relations, parent_id: "parent" },
    };
    expect(poolPageChildren([child, { ...child, task_id: "parent" }, card()], "parent")).toEqual([
      child,
    ]);
  });
  it("未批准和未知证据归待处理，不把阶段当执行状态", () => {
    expect(poolCategory(card())).toBe("attention");
    expect(poolCategory(card("unknown"))).toBe("attention");
    expect(poolCategory(card("queued"))).toBe("pool");
    expect(poolCategory(card("claimed"))).toBe("running");
    expect(poolCategory(card("started"))).toBe("running");
  });
  it("回合结束与运行结束不等于主卡完成", () => {
    expect(poolCategory(card("turn_ended"))).toBe("review");
    expect(poolCategory(card("ended"))).toBe("review");
    expect(poolCategory(card("turn_failed"))).toBe("attention");
    expect(poolCategory(card("stopped"))).toBe("attention");
  });
  it("只使用本次尝试已存在的有效时间，不以领取或任务活动补造开工", () => {
    const execution = {
      ...card("claimed").pool_execution!,
      released_at: "2026-10-20T01:00:00Z",
      queued_at: "2026-10-20T01:00:01Z",
      claimed_at: "2026-10-20T01:00:02.123456789Z",
      started_at: null,
      ended_at: "bad",
    };
    expect(poolTimeline(execution).map((point) => point.kind)).toEqual([
      "released",
      "queued",
      "claimed",
    ]);
    expect(poolCardTimes(execution).map((point) => point.kind)).toEqual(["queued", "claimed"]);
    expect(poolTimeline(null)).toEqual([]);
  });
  it("请求错误、断线和超过三十秒的旧快照均不等于空池", () => {
    expect(poolFreshness(null, 50_000, false, false)).toBe("loading");
    expect(poolFreshness(null, 50_000, false, true)).toBe("unavailable");
    expect(poolFreshness(10_000, 39_999, true, false)).toBe("fresh");
    expect(poolFreshness(10_000, 40_000, true, false)).toBe("stale");
    expect(poolFreshness(39_000, 40_000, false, false)).toBe("stale");
    expect(poolFreshness(39_000, 40_000, true, true)).toBe("stale");
  });
  it("未知原因失败关闭，依赖与消耗确认给出不同说明", () => {
    expect(poolReasonGroup("dependencies_unresolved")).toBe("dependencies");
    expect(poolReasonGroup("cli_quota_confirmation_required")).toBe("approval");
    expect(poolReasonGroup("new_reason_from_server")).toBe("evidence");
    expect(poolReasonGroup("history_cleaned")).toBe("history");
  });
});
