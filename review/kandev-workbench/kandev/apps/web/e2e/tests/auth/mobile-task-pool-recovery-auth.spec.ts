import { backendFixture as test } from "../../fixtures/backend";
import { randomUUID } from "node:crypto";
import { restartPoolAuthBackend } from "../../helpers/task-pool-auth";
import { exercisePoolRecovery } from "../../helpers/task-pool-recovery";
import { exercisePoolStopRetry } from "../../helpers/task-pool-execution-recovery";
import { exercisePoolUncertainRestart } from "../../helpers/task-pool-uncertain-restart";

let databaseName = "";
test.beforeEach(async ({ backend }) => {
  databaseName = `pool-recovery-mobile-auth-${randomUUID()}.db`;
  await restartPoolAuthBackend(backend, databaseName);
});

// @covers AC-TASKS-AGENT-POOL-003.2 AC-TASKS-AGENT-POOL-005.2 AC-TASKS-AGENT-POOL-005.3
test("手机停止模拟执行并在核实后人工重试，不混用旧领取", async ({ page, context, backend }) => {
  await exercisePoolStopRetry({
    page,
    context,
    backend,
    mobile: true,
    databaseName,
    outputPath: (name) => test.info().outputPath(name),
  });
});
test.afterAll(async ({ backend }) => {
  await backend.restart();
});

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-005.1 AC-TASKS-AGENT-POOL-005.2
test("手机已领取未开工时重启，保留原轮次且不可直接重试", async ({ page, context, backend }) => {
  await exercisePoolUncertainRestart({
    page,
    context,
    backend,
    mobile: true,
    databaseName,
    outputPath: (name) => test.info().outputPath(name),
  });
});

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2 AC-TASKS-AGENT-POOL-005.3
test("手机真实宿主重启后恢复停止记录，再明确人工重试", async ({ page, context, backend }) => {
  await exercisePoolStopRetry({
    page,
    context,
    backend,
    mobile: true,
    databaseName,
    restartAfterStop: true,
    outputPath: (name) => test.info().outputPath(name),
  });
});

// @covers AC-TASKS-AGENT-POOL-003.2 AC-TASKS-AGENT-POOL-005.3 AC-TASKS-AGENT-POOL-005.4
test("手机底部确认撤回，取消不写入，丢失响应后查询原回执", async ({ page, context, backend }) => {
  await exercisePoolRecovery({
    page,
    context,
    backend,
    mobile: true,
    databaseName,
    outputPath: (name) => test.info().outputPath(name),
  });
});
