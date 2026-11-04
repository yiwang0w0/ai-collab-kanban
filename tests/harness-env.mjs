const deploymentKey = /^(?:BOARD_|WORKER_|REVIEWER_|REVIEW_|KANBAN_)/i;

// 保留现有测试专属的目标选择器，但不把它传入被测服务。
export const harnessAuthTestRoot = process.env.BOARD_AUTH_TEST_ROOT;

/** 过滤函数不修改传入字典；各 harness 之后只显式写回自己的夹具配置。 */
export function harnessEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => !deploymentKey.test(key)));
}

// 导入排在产品模块之前，避免测试进程自身先缓存部署面的默认路由、人工闸等。
// 只影响当前测试进程，不修改启动它的执行循环或供应商配置。
for (const key of Object.keys(process.env)) if (deploymentKey.test(key)) delete process.env[key];
