---
status: current
system: tasks
created: 2026-10-19
owners:
  - ai-fleet-kanban
requirements:
  - REQ-TASKS-AGENT-POOL-001
  - REQ-TASKS-AGENT-POOL-002
  - REQ-TASKS-AGENT-POOL-005
---

# 任务池执行停止、原生恢复载体和宿主验收

## 范围与原生权威

本文细化[工作台设计](agent-pool-workbench.md)的执行终结边界，沿用[原生运行权决策](../../../decisions/2026-10-16-agent-pool-native-run-authority.md)。本次运行结束不代表主卡验收；不新增表、队列或恢复调度器。正式生产池入口仍关闭，只有既有 mock-only E2E 宿主接通本池。

原生 standalone 停止须经 StopInstanceConfirmed 核对真实实例、task／session 范围、删除成功与后置缺席。活动租约／准备所有权释放才可标记 execution_activity_released。逻辑 stopped、存活 detach、进程启动成功、回合结束、HTTP 停止响应或历史布尔值均不是整个任务资源已空闲的证明。

## 停止与终结

ObservePoolExecutionStopped 仅以当前唯一 claim、已提交分配及精确 execution／session／turn／generation 追加 pool.execution-stopped.v1。FinalizeStoppedPoolRun 在 lifecycle→task 屏障内，重查宿主内存、实际活动／LSP、数据库、空 checkout 和当前原生身份；同事务写 finished、pool_execution_stopped 与引用 stopped_seq 的 pool.execution-finished.v1。

终结不清除 checkout、不删除原生恢复资料、不修改主卡状态或严格 Done。证据缺失、并发替换、活动占用、查询失败或歧义都拒绝；不能降级通用 FinishRun、MarkRunFailed、CancelRunsWhere 或自动恢复的保留键保护。

## stopped 恢复载体不等于活动执行

原生 lifecycle 为保留 CLI 会话恢复能力，可以保留 executors_running 的 stopped 记录。先前将“有记录”等同“有活动执行”会阻止真实宿主的合法收尾；修正应保留原生语义，不能删除该记录来获得空闲。

SQLite 终结核验最多读取本 task 或 session 的两行清单；零行可继续其他核验。恰好一行只在以下条件全部满足时视作已释放的原生载体：

- id 与 session_id 都精确等于当前分配 session，task 和 agent_execution_id 精确匹配。
- execution_profile_id 为空的原生兼容值，或精确匹配本次分配；执行器为 Worktree。
- status 为 stopped；local_pid 和 pid 均已清空。
- runtime 为原生兼容空值或 standalone，不接受其他／未知运行时。

第二行、替换 execution、错误 Profile／executor、prepared／running／未知状态或非零 PID 均拒绝。此例外只解释数据库清单，不签发停止事实，也不跳过实际宿主空闲、精确停止回执、当前 claim、session／turn、依赖和 checkout 核验。恢复令牌、工作树及原生行保持不变。

## 独立运行时准备

独立 agent.launch 只准备运行时，不调用 StartAgentProcess。当前宿主的原生持久化还要求 session_id，而该旧 DTO 不含此字段，因此它会拒绝并回滚，不能据此宣称存在重复模型启动或将其扩成另一种执行方式。

宿主构造时将 agent.Controller 的 TaskPreparationAdmission 连接到同一协调器。WithTaskPreparation 先复用任务权限，再通过 beginPoolTaskStart 读取真实池占用并保留原生准备引用；回调结束、失败或取消均释放引用，不能持任务写锁等待运行时。已有 queued／claimed 池运行时，独立准备在资源 I/O 前返回 pool_task_busy；无池占用时保留旧入口的原生会话约束。未连接本池的普通原生准备不受新池守卫影响。

真实模拟宿主验证上述拒绝及旧错误对照，没有增加模型进程。协调器测试独立验证授权先于池读取、回调原错误保留、准备期间拒绝新批准、取消后释放及默认路径。模型切换的生产调用来自已受守卫保护的 promptTask；agent.stdin 要求原生 PTY passthrough，而本池明确不接纳此类 Profile。通用 Office 运行执行使用独立 run owner，不能冒称本池的 task／claim 身份。

## 隔离模拟宿主组合

backendapp 的 wireMockPoolRuntime 仅在 KANDEV_E2E_MOCK 精确为 true 且 KANDEV_MOCK_AGENT 精确为 only 时，连接现有任务来源、任务锁准入、共享队列、启动守卫和同一原生消费者。默认、缺任一条件、混合真实提供商和其他拼写都在触碰服务前返回。没有新增生产开关、备用调度器或真实提供商通道。

实际宿主验收 TestPoolHostNativeMock 使用私有新编译二进制及同目录 agentctl／mock-agent，独立临时 HOME／数据库／Git 仓库／Worktree，并清除继承的提供商凭据及配置。先以每实例健康 nonce 证明端口归属，再经原生 readiness、真实浏览器登录和设置写入。健康探测不能代替就绪，停止 ACK 不能代替终结证据。

测试通过真实 HTTP 创建确认、原生阶段回调、共享 claim、模拟 CLI 子进程和 Git Worktree，观察七类池事件。真实停止后核验 finished、当前 stopped_seq 关联、清空的 PID 与保留的 stopped 恢复载体。随后终止本测试拥有的宿主，启动同一私有数据的新进程；原生登录仍有效，相同 external_id 创建重放返回原卡，领取／事件／时间不变，模拟代理进程 ID 集合不增加，恢复载体及令牌摘要不变。

严格 Done 负例沿现有 Node／真实 check-delivery.mjs 入口，缺交付回执返回 409。夹具使用未安装的 pool-host-pending 验证器身份，故此结论仅为拒绝证明，不是插件正例验收、部署或可用交付。

## 未完成边界与需求映射

当前正例仅证明模拟提供商的真实宿主与进程闭环，不证明 Claude／Codex 真实额度、API 或生产配置可用。后续中断／响应丢失、资源拒绝、版本化人工恢复及桌面／手机工作台已按四份工单补齐隔离验证；严格验收插件另有真实安装、拒绝与人工通过证据，不能冒充本文宿主夹具自身的正例。当前逐项结果见[隔离交付核对](../../../plans/agent-pool-workbench/acceptance-audit.md)。

| 需求 | 对应边界 |
| --- | --- |
| REQ-TASKS-AGENT-POOL-001 | 单一领取、真实模拟执行及停止／终结关联 |
| REQ-TASKS-AGENT-POOL-002 | 有来源的轨迹和历史保持，不将停止等同 Done |
| REQ-TASKS-AGENT-POOL-005 | 默认关闭、实际资源核验、重启幂等及人工恢复边界 |
