import { backendFixture as test } from "../../fixtures/backend";
import { randomUUID } from "node:crypto";
import { restartPoolAuthBackend } from "../../helpers/task-pool-auth";
import { exercisePoolRecovery } from "../../helpers/task-pool-recovery";
import { exercisePoolStopRetry } from "../../helpers/task-pool-execution-recovery";
import { exercisePoolUncertainRestart } from "../../helpers/task-pool-uncertain-restart";

let databaseName = "";
test.beforeEach(async ({ backend }) => {
  databaseName = `pool-recovery-auth-${randomUUID()}.db`;
  await restartPoolAuthBackend(backend, databaseName);
});

// @covers AC-TASKS-AGENT-POOL-005.2 AC-TASKS-AGENT-POOL-005.3 AC-TASKS-AGENT-POOL-005.4
test("桌面停止真实模拟执行，核实资源后人工重试，旧操作不停止新领取", async ({
  page,
  context,
  backend,
}) => {
  await exercisePoolStopRetry({
    page,
    context,
    backend,
    mobile: false,
    databaseName,
    outputPath: (name) => test.info().outputPath(name),
  });
});
test.afterAll(async ({ backend }) => {
  await backend.restart();
});

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-005.1 AC-TASKS-AGENT-POOL-005.2
test("桌面已领取但未开工回执时重启，不自动再启动代理", async ({ page, context, backend }) => {
  await exercisePoolUncertainRestart({
    page,
    context,
    backend,
    mobile: false,
    databaseName,
    outputPath: (name) => test.info().outputPath(name),
  });
});

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2 AC-TASKS-AGENT-POOL-005.3
test("桌面真实重启保留停止回执，不自动再派发，随后人工重试", async ({ page, context, backend }) => {
  await exercisePoolStopRetry({
    page,
    context,
    backend,
    mobile: false,
    databaseName,
    restartAfterStop: true,
    outputPath: (name) => test.info().outputPath(name),
  });
});

// @covers AC-TASKS-AGENT-POOL-005.3 AC-TASKS-AGENT-POOL-005.4
test("桌面撤回未领取派发，丢失响应后刷新并查询同一操作，不增加尝试", async ({
  page,
  context,
  backend,
}) => {
  await exercisePoolRecovery({
    page,
    context,
    backend,
    mobile: false,
    databaseName,
    outputPath: (name) => test.info().outputPath(name),
  });
});
