---
id: "01-native-dispatch-receipts"
title: "原生入池、排他领取与开工证据"
status: done
wave: 1
depends_on: []
plan: "plan.md"
requirements:
  - REQ-TASKS-AGENT-POOL-001
  - REQ-TASKS-AGENT-POOL-002
acceptance_criteria:
  - AC-TASKS-AGENT-POOL-001.1
  - AC-TASKS-AGENT-POOL-001.2
  - AC-TASKS-AGENT-POOL-001.3
  - AC-TASKS-AGENT-POOL-001.4
  - AC-TASKS-AGENT-POOL-002.1
  - AC-TASKS-AGENT-POOL-002.2
  - AC-TASKS-AGENT-POOL-002.3
  - AC-TASKS-AGENT-POOL-002.4
system_design:
  - ../../specs/tasks/system-design/agent-pool-workbench.md
---

# 工单 01：原生入池、排他领取与开工证据

## 结果

让一张获准的普通任务沿既有共享队列被指定 CLI Agent 领取，持久化可核验的开工证据。先用隔离模拟运行证明该接缝，不以 Office 符号存在代替兼容性。

## 包含

- 原生流程配置样例与可信池封装；阶段进入幂等、禁合并、容量／依赖／权限和手动 Start 竞争准入。
- 从原子领取返回已有 ledger ID，并传入原生启动上下文；事务内、按 attempt 去重的执行绑定／工作活动事件。
- Claude／Codex 模拟传输、旧回调、重复回执、持久化失败及严格 Done 负例的 TDD。

## 不包含

- 工作台布局、API 模型调用、Office 自主团队、改全局路由、新队列或新任务表。

## 验收

1. 同次阶段进入的重复发布和多个竞争启动只产生一份逻辑运行；已有池执行阻止另一路手工启动，普通任务不受影响。
2. 排队、领取、开工各有真实来源；原子领取账本 ID 随执行传递，旧轮次和欢迎消息不能证明新轮次开工；证据失败不再次调用执行器。
3. 普通 CLI Profile 能经真实宿主与模拟代理闭环，并证明回合结束不越过原有完成门禁。全部受影响测试通过后才能开放池生产者；恢复路径在工单 04 完成前保持试点不可开放。

## 验证

从仓库根目录、PowerShell 7 执行；Go／C 编译器使用已有隔离工具链，PATH 不齐先定位，不重装或改全局设置。新测试由本工单创建。

```powershell
Push-Location apps/backend
try {
  go test -race ./internal/task/service -run '^(TestPoolDispatch|TestPoolReceipt|TestStrictCompletion)' -count=1
  if ($LASTEXITCODE -ne 0) { throw '派发或回执回归失败' }
  go test -trimpath -race -p=1 ./internal/task/repository/sqlite ./internal/runs/service ./internal/runs/repository/sqlite ./internal/runs/scheduler -run '^(TestClaim|TestPool|TestScheduler_|TestQueueRun)' -count=1
  if ($LASTEXITCODE -ne 0) { throw '原生队列回归失败' }
  go run ./cmd/sqlguard ./internal
  if ($LASTEXITCODE -ne 0) { throw 'SQL 检查失败' }
  go test -race -p=1 ./internal/persistence/storeconformance -count=1
  if ($LASTEXITCODE -ne 0) { throw '存储一致性未通过；需对照既有 Windows 基线，不计为全绿' }
} finally { Pop-Location }
```

存储行为变更还按后端章程运行 storeconformance 并分别记录已知 Windows 基线失败；不能改夹具伪造全绿。闭环模拟覆盖整合到工单 03 的浏览器入口与工单 04 的恢复用例；本工单需要服务级真实宿主／模拟适配器集成测试。

## 可能修改的文件

- 已有：`apps/backend/internal/workflow/engine/phase2_callbacks.go`、`internal/runs/service/service.go`、`internal/runs/repository/sqlite/claim.go` 和 `run_events.go`（后两组路径相对 apps/backend）。
- 已有：`apps/backend/internal/office/scheduler/dispatch_routing.go`、`apps/backend/internal/agentctl/types/streams/agent.go`、原生任务启动准入接缝。
- 拟新增：`apps/backend/internal/task/service/pool_dispatch.go`、`pool_dispatch_test.go`、`pool_receipts.go`、`pool_receipts_test.go`。

## 依赖与风险

无前置工单。读取[技术设计](../../specs/tasks/system-design/agent-pool-workbench.md)的身份／开工章节及原生 run 调度契约。若需要新调度器或强制采用 Office 才能启动，应停止并更新设计。不得拿任务创建时刻冒充执行时刻。

## 并行

sequential

## 结果记录

2026-10-20 最终隔离范围完成：真实宿主＋模拟 CLI 的普通固定 Profile 接缝、不可变领取／开工证据、共同准入与严格 Done 已核对。固定时钟的旧批准重放先 RED，再以事务内已处目标阶段检查拒绝，仓储池组及相关服务／HTTP 通过；不再将此前十次未复现当作风险消除。精确基线复现了存储及旧调度器失败，未修改夹具或阈值；具体结果和保留限制见[最终核对](acceptance-audit.md)。done 仅指本工单隔离交付，不开放真实提供商或生产，不代表全库全绿。

2026-10-18：已启用目标模式，开始原生接缝复核及测试驱动实施。未授权实际模型调用。其余工单保持 pending，恢复门禁完成前不开放池生产者。

### 2026-10-18 检查点：领取／回执基础，不是工单完成

已实现：

- `internal/runs/models/claim.go` 与 `repository/sqlite/claim.go`：新增 `ClaimNextEligibleRunWithClaim`，在同一领取事务提交后返回真实 ledger ID；旧入口兼容，不新增表。重入队的新领取不依赖 `retry_count`。
- `repository/sqlite/pool_claim.go`、`pool_receipts.go`：仅按唯一的当前 run／claimed_at／账本重建；持写锁后验证当前 claim、任务与固定配置，事务追加执行绑定和首次工作回执。同一身份重放保持原时间，歧义、旧轮次、缺绑定、无效来源和终结后活动拒绝；写入失败回滚会话绑定，不重入队。
- `internal/runs/service/pool_namespace.go`：通用入队拒绝保留的池键。可信真人发布封装尚未完成，因此当前不存在可用的生产池发布入口。合并查询不接受池运行作为目标；无 claim 身份的普通 `SetRunSessionID` 不能覆写池会话。
- `internal/office/service/pool_run.go`：同一共享消费者在 Office 策略前分流池运行，传递 `ClaimedRun`；未注入处理器或处理结果未知时保留领取，不进入通用失败回退。生产构造器尚未注入处理器。
- Codex app-server 适配器为提供商原生主线程 `turn/started` 填写 `turn_start_source`，流经 lifecycle 时保留；本地提示派发没有该来源，子线程不生成主线程开工证据。尚未把此事件接入任务池回执观察器。

真实服务／SQLite 边界对照证明：普通全局 CLI Profile 可以经 `QueueRunAndReturn` 入队，但原 Office 处理策略看不到它，会取消且不调用 starter；工作区 Office Profile 的正对照能调用 starter。新分流测试验证普通 Profile 的原子领取可进入池适配接缝。starter 是边界假实现，不是实际 CLI，也不是本工单要求的真实宿主＋模拟代理完整启动验收。

新增测试先证明缺少领取身份、回执入口、分流和提供商来源时失败，再实施；保留键伪造、合并覆盖及无身份会话覆写也先重现失败。补充故障覆盖包含并发回执、重复活动、旧 claim／session／turn／generation、账本缺失／多解、落盘失败回滚及普通运行正对照。

最后一次生产修改后的通过命令（均在 `apps/backend`，使用隔离 Go 1.26.9／GCC 工具链；为复用缓存加 `-trimpath`）：

```powershell
go test -trimpath -race -p=1 ./internal/runs/service ./internal/runs/repository/sqlite ./internal/office/service ./internal/agentctl/server/adapter/transport/codexappserver ./internal/agent/runtime/lifecycle -run '^(TestPool|TestClaim|TestQueueRun|TestSetRunSessionID|TestCoalesceRun|TestPostgresCoalesceRun|TestSchedulerIntegration|TestSchedulerTick_|TestBuildAgentStreamEventData|TestConversationLifecycleAndMCPOverlay|TestUnboundChildTurn)' -count=1
go test -trimpath -race ./internal/task/service -run '^(TestPoolDispatch|TestPoolReceipt|TestStrictCompletion)' -count=1
go test -trimpath -race ./internal/backendapp -run '^TestRunsServiceEngineAdapter_' -count=1
go run -trimpath ./cmd/sqlguard ./internal
```

第一条五个包通过；第二条目前只匹配既有严格完成测试，不能冒称尚未新增的任务服务池测试已通过；第三条宿主引擎既有适配回归通过；第四条退出 0。PostgreSQL DSN 未配置，相应守卫测试跳过，池回执入口明确只支持 SQLite。

未通过的规定验证：

- `go test -trimpath -race ./internal/runs/service ./internal/runs/repository/sqlite ./internal/runs/scheduler -run '^(TestClaim|TestPool|TestScheduler_|TestQueueRun)' -count=1`：前两包通过，调度器 `TestScheduler_ConcurrentStopUsesOneLifecycleTransition` 在等待处理器进入的 100ms 门槛失败。一次单包 `-run '^(TestScheduler_)'` 复核同样失败；调度器源码和测试均与 HEAD 相同，不在本批更改阈值或修复。
- `go test -trimpath -race -p=1 ./internal/persistence/storeconformance -count=1`：storage CRUD／timestamp／conflict／transaction 的 Windows 绝对路径失败，升级场景同类失败，升级 SQL 夹具 checksum 失败。整个 conformance 目录与 HEAD 无差异；两份 SQL 只在读内存中归一化 LF 后的 SHA256 与 manifest 预期完全相同，未重写夹具。整组不能报告全绿。

### 2026-10-18 第二检查点：原生提交准入与可信来源

本段没有开放发布／启动入口，继续 in_progress。

- `internal/workflow/models/pool_step.go`：使用原生 `queue_run.config.pool_version: 1`，只允许本任务固定主 Profile、一份启动动作；拒绝未知版本、动作 payload、自选其他任务／执行者、自动启动／代码审查／扇出冲突及其他触发器启动。普通未标记配置保持原行为。
- `internal/task/models/pool_release.go`：宿主确认意图绑定 task／workspace／workflow／step、预期任务版本、预期阶段版本及 Profile，包含明确 CLI 额度确认，不承载自报 Agent／时刻。
- `internal/task/repository/sqlite/pool_admission.go` 和原生 `step_transitions.go`：任务行在写事务内读到的版本必须匹配；原生阶段账本提交前核对真实浏览器身份、human 归因、目标、配置版本和 WIP／非临时／未归档资格。无确认、合成身份、Agent 代持身份、PAT、系统、错误目标、旧版本和配置冲突均回滚。配置校验与 WIP 使用原生资料，没有另建任务表。
- `internal/steptelemetry/steptelemetry.go`：原生事务在上述检查通过后派生 `pool_release_v1` trigger，保存真实 actor。只看旧 human/manual_move 账本不够证明额度已批准。
- `internal/task/repository/sqlite/pool_release_source.go`：`LoadPoolRelease(ctx, taskID, entryID)` 返回 `runs/models.PoolReleaseSnapshot`。同一只读快照核对最新批准、当前阶段、准入和未变化配置；拒绝跨任务、旧阶段、普通移动及批准后变更。此方法尚未被生产发布器调用。
- `internal/workflow/engine/types.go`／`phase2_callbacks.go`：保留 `PoolMarked`，专用发布器未连接时返回未就绪错误；不能落到普通队列。此拒绝分支将在可信发布器就绪时接为专用能力，不是功能完成的替代方案。

所有新增行为均先以失败测试证明缺口再实施。新测试覆盖 8 条创建／更新／工作流附加／容量／提升路径的池拒绝和普通正对照，确认与归因、配置冲突、可信源、容量及并发确认；不代表服务层、HTTP／WS 或真实 CLI 启动已经通过。并发确认实测只提交一条阶段批准记录，另一份请求返回版本冲突。

本段最后一次生产改动后验证：

```powershell
# 从这三个已有文件读出全部 Test 函数，加本段池事务测试。
$taskTestFiles = @(
  'internal/task/repository/sqlite/step_transitions_test.go',
  'internal/task/repository/sqlite/step_transitions_lifecycle_test.go',
  'internal/task/repository/sqlite/change_workflow_test.go'
)
$taskTestNames = foreach ($taskTestFile in $taskTestFiles) {
  foreach ($taskLine in (Get-Content $taskTestFile)) {
    if ($taskLine -match '^func (Test\w+)\(') { $Matches[1] }
  }
}
$taskPattern = '^(' + (($taskTestNames + @('TestPoolDispatch.*')) -join '|') + ')$'
go test -trimpath -race ./internal/task/repository/sqlite -run $taskPattern -count=1
go test -trimpath -race ./internal/task/repository/sqlite -run '^TestPoolDispatch(Concurrent|Postgres)' -v -count=1
go test -trimpath -race -p=1 ./internal/task/service ./internal/steptelemetry ./internal/workflow/engine ./internal/workflow/models -run '^(TestPool|TestStrictCompletion|TestMoveTask|TestWorkflowChange|TestQueueRun|TestCompileStep|TestDefaultQueueReason|TestFromContext|TestWithAttribution|TestHasTrigger|TestHumanOrSystem)' -count=1
go test -trimpath -race -p=1 ./internal/runs/service ./internal/runs/repository/sqlite ./internal/office/service ./internal/backendapp -run '^(TestPool|TestClaim|TestQueueRun|TestSchedulerIntegration|TestSchedulerTick_|TestRunsServiceEngineAdapter_)' -count=1
go run -trimpath ./cmd/sqlguard ./internal
```

以上针对性检查均退出 0；并发确认通过，PostgreSQL 能力拒绝测试因 `KANDEV_TEST_POSTGRES_DSN` 未配置跳过。原规定 storeconformance 再跑，仍是 storage 的 CRUD／timestamp／conflict／transaction、上一稳定版升级的 Windows 绝对路径失败，以及两份 CRLF SQL 夹具 checksum 失败；该目录与 HEAD 无差异，没有改夹具或扩大阈值。本段未重跑已记录失败、且未修改的原生 runs/scheduler 单包；整组不宣称全绿。

后续接线注意：

- 目前尚无 `MoveTaskOptions.PoolRelease`、HTTP／WS 确认字段或服务发布方法；不要因为底层存在 `WithPoolReleaseIntent` 就直接从浏览器透传意图。宿主须读取真实步骤并生成绑定，只给最终原生写入的 moveCtx／createCtx 附加该意图，不能把它传播给提交后的其他卡片拉取。
- `agentProfiles` 和 `agentProfileExecutorValidator` 是任务服务已有依赖；优先复用。实际 `AgentID` 是原生记录身份，不要用显示名或 `claude-acp` 之类字符串冒充数据库 ID。能力缺失／动态路由／API／非 Worktree 应拒绝，不改全局设置。
- 本段白盒仓储夹具只初始化 task 表族。新增活动 run／dependency 事务测试需使用完整宿主表族；Office 仓储本身导入 task/sqlite，不能在 task/sqlite 内部测试直接反向导入它形成循环。可用外部测试包和真实构造器，不复制 DDL 或加测试专用生产接口。
- 原生 `DependencyGate` 可能清理缺失前置边并再次取得 `common/taskdependencies` 锁；不能在持有同一非重入锁时调用它。池依赖校验必须保持失败关闭，不能以未配置仓储解释为清空前置。

### 下一段必须完成

1. 将真人／版本底层门禁接到 Move／Create 选项与 HTTP／WS 确认入口；补完整 CLI／Worktree 能力、提交前依赖和活动执行准入。可信发布器与任务服务发布方法已在第三检查点完成；不能直接放行通用保留键校验，恢复保护完成前不注入生产发布能力。
2. 实现 tasks 所有的池处理器，在构造期接入同一消费者；复用原生 orchestrator／Worktree 启动与手动 Start 共同准入。把 run／claim 身份随原生 session／execution／turn／operation／generation 传递；不能只靠 env 文本或回调结束后读取可变快照。
3. 在可信活动路径接上事务回执。现有流可能将 `message_chunk` 合并为 `message`，部分活动不自带 turn／operation；需在实际来源边界保留身份，不能把读取当前轮次补成旧事件的身份。
4. 完成任务服务级真实宿主＋模拟传输接缝、Done 负例、持久化失败及启动竞态，再复核本工单 AC。`RecoverStale` 等恢复入口的池隔离仍待工单 04，完成前不开放试点。

未改原实例、Qlik 资源、全局设置；未调用模型、未提交／推送、未发布。兼容补丁与插件包仍是旧验收试点产物，尚未包含本批源代码，不得用旧二进制或包声称池实现已运行。

### 2026-10-18 第三检查点：可信原生发布链，工单未完成

本段已有实际实现进展；工单仍在进行，不能计为完成或因尚未接齐而计为无进展。

- `runs/service.QueuePoolRunAndReturn(ctx, taskID, entryID)` 只接原生身份，不接客户端快照。构造期注入的任务来源在同一队列写事务里重读批准；`LoadPoolReleaseTx` 与只读来源共用校验。先预留 SQLite 写权，再核对当前批准、查询持久唯一键、检查同任务占用与原生依赖，复用原生因果准入／插入／提交／信号。
- 保留键摘要输入是有边界的工作区、任务和阶段账本 ID。禁止通知合并，不使用 WakeWaveKey；同次批准重放返回真实已有行及原时间，不受通用通知的 24 小时快查限制。不同执行者／工作区／payload／actor／reason、合并行、wave 或未知状态不能冒充成功去重；原生 Profile 解析到别的工作区时整体回滚。`PoolReleaseSnapshot.DispatchKey`／`MatchesRun` 共用身份契约，任务服务不能把可选队列接口返回的错绑定当成成功。
- 同主卡另一份 queued／claimed 池运行会返回带原生 run ID 的占用错误，跨 Profile 也不能绕过。缺失、未完成、失败、取消或已归档的前置均阻塞；读取不删除缺失边。此处是队列发布准入，尚不能声称原生移动与手动 Start 的共同准入已完成。
- `workflow/engine.PoolRunQueueAdapter` 只传 task／step／entry，原生 on_enter 才能派发；失败不降级普通唤醒，空／合并／限流结果不算派发成功。`task/service.PublishPoolRelease` 校验权限、规范账本身份及当前真实来源后调用共享队列；已有任务服务级真实仓储／队列正对照。宿主构造器连接适配器委托方法，但没有注入发布来源／队列，也没有注入池消费者；用户请求确认入口尚未连接，仍未开放工作台／模型执行。
- 宿主适配测试使用真实任务／流程／设置／Office／runs 仓储、真实任务服务与队列，直接执行原生 `QueueRunCallback` 两次，只产生一份真实批准运行。动作 payload 中伪造的 actor／Agent／开工时间和当前机器状态身份都不参与绑定。这不是新二进制宿主启动、完整阶段事件处理或模拟 CLI 执行闭环。
- 12 个并发发布请求实测一条运行、一次信号和一次真实 claim；空队列沿用原生 `sql.ErrNoRows` 契约。追加已有持久键超过通知快查窗、事务插入故障回滚及歧义故障测试。歧义通过隔离夹具移除唯一索引并造两行重现；读取最多两行后拒绝，不选第一行、不清理或补造记录。

本段新增行为先观察失败再实现；补充合同回归覆盖并发、旧时间窗、错误绑定、权限／缺少身份、SQL 故障和歧义。SQLguard 首次发现三处占位符未重新绑定，修正后复测通过。最后一次生产代码修改后执行：

```powershell
go test -trimpath -race -p=1 ./internal/task/service ./internal/runs/service ./internal/runs/repository/sqlite ./internal/office/service ./internal/workflow/engine ./internal/workflow/models ./internal/backendapp ./internal/agentctl/server/adapter/transport/codexappserver ./internal/agent/runtime/lifecycle -run '^(TestPool|TestClaim|TestQueueRun|TestSetRunSessionID|TestCoalesceRun|TestPostgresCoalesceRun|TestStrictCompletion|TestMoveTask|TestWorkflowChange|TestSchedulerIntegration|TestSchedulerTick_|TestBuildAgentStreamEventData|TestConversationLifecycleAndMCPOverlay|TestUnboundChildTurn|TestRunsServiceEngineAdapter_)' -count=1

# $taskPattern 按第二检查点的三份原生账本文件计算。
go test -trimpath -race ./internal/task/repository/sqlite -run $taskPattern -count=1
go test -trimpath -race ./internal/runs/service -run '^TestPoolDispatchPublicationPostgresUnavailablePreservesOrdinaryQueue$' -v -count=1
go run -trimpath ./cmd/sqlguard ./internal
go test -trimpath -race -p=1 ./internal/persistence/storeconformance -count=1
```

前两项九个相关包及原生任务仓储通过；PostgreSQL 项因未配置 `KANDEV_TEST_POSTGRES_DSN` 明确 SKIP，不计为 PG 能力验证。SQLguard 退出 0。storeconformance 仍失败于 storage CRUD／timestamp／conflict／transaction、v0.93.0 升级的 Windows 绝对路径，以及两份 CRLF SQL 夹具 checksum；conformance 与 runs/scheduler 目录相对 HEAD 均无差异。本段未重跑未修改且已记录失败的原生 runs/scheduler 整包，不报告整组全绿。文档清单验证 349 decisions／1343 specifications 通过；全局规范 lint 仍有既有超体积报告，本功能规范未命中；diff 空白检查通过。

下一段按工单原验收继续，不重新做计划、不缩减目标：

1. Move／Create 请求确认、真实 CLI／Worktree 能力与原生提交前依赖／活动执行准入。现在只有发布事务的依赖与池占用检查，不能将其当成原生移动提交前或交互 Start 的互斥。
2. 复用原生任务启动准入、orchestrator／Worktree 和真实 claim 身份，接 tasks 所有的消费者及执行绑定；检查既有 `orchestrator/ceiling_entry_lock.go` 的任务准入锁／dispatch commit 与原生启动过程，不在提供商 I/O 期间持有会被回调再取的锁。
3. 在可信传输活动边界传递不可变 session／execution／turn／operation／generation 并接事务回执。真实宿主＋模拟代理、旧回调／重启／失败恢复与严格 Done 负例仍待实现。

01 继续 in_progress；02–04 仍 pending。未消费模型、未改变原实例／Qlik／全局设置、未提交推送或发布；原插件包与兼容补丁仍未包含本轮池代码。

### 2026-10-18 第四检查点：移动确认与原生提交资格，工单未完成

上一段是实际进展，本段继续实现原工单，没有收窄目标或计为无进展。

- 新增 `MoveTaskOptions.PoolRelease`，只承载额度确认和任务／阶段版本。服务从真实资料构造意图，只有最终 `moveCtx` 接收它；提交后其他卡片拉取不继承该意图。真实移动正对照会产生 `pool_release_v1`，再经已验证发布链入队。
- `task/models.PoolExecutionCandidate` 共用临时资格规则：真实注册 Agent ID、固定 Claude／Codex 原生族、作用域、启用／未删除、无 API／回退／passthrough／间接 Profile，且为有效 Worktree。服务复用原生 Profile／Agent 读取和执行器解析／兼容校验；它不是 CLI 模型任务成功的证据。
- `task/repository/sqlite/pool_execution_candidate.go` 和 `pool_dispatch_ready.go` 在最终原生事务重查资格、元数据、任务状态、依赖、活动池运行、会话及未结束回合。缺失／损坏／未知资料失败关闭。已等待输入且无未完回合的会话是正对照；不声称这些查询证明实际 executor／checkout 已停止。
- 检查后变更的测试在服务兼容检查边界改变 Profile 或插入原生 STARTING 会话，最终提交仍拒绝且保留原卡／版本。原生仓储层的直接确认写入也受同一门禁约束，不仅依赖服务预检。
- 原先 task-only 的池仓储测试已迁到 `sqlite_test` 外部包，夹具由真实任务／设置／Worktree／Office／流程构造器建表，避免导入循环；未复制 DDL 或添加生产测试专用方法。合法夹具明确使用原生 TODO 状态、真实注册族与 Worktree 选择，未知／空状态继续拒绝。
- 发布层原有同卡占用测试改为明确模拟旧版存量状态，继续独立验证发布器，不能让新提交门禁掩盖旧队列检查。

已核对但尚未实施的创建边界：

- `internal/task/repository/sqlite/step_entry_dispatch.go`：提交后同步派发；`workflow/stepentry/stepentry.go` 将 `queue_run` 归为 ledger-owned。
- `internal/task/service/service_tasks.go`：`createTaskWithCapacity` 之后才进入 `finalizeCreatedTask`，后者添加 blockers／仓库／策略并可回滚部分创建。
- 因此尚未增加 `CreateTaskRequest.PoolRelease` 或 HTTP／WS 确认字段。下一段先接共同启动准入及原生创建收尾，不能在资料未补齐时开放初次领取；也不能以禁止所有创建／忽略依赖替代原验收。

最后一次生产代码修改后的验证：

```powershell
go test -trimpath -race -p=1 ./internal/task/models ./internal/task/service ./internal/runs/service ./internal/runs/repository/sqlite ./internal/office/service ./internal/workflow/engine ./internal/workflow/models ./internal/backendapp ./internal/agentctl/server/adapter/transport/codexappserver ./internal/agent/runtime/lifecycle -run '^(TestPool|TestClaim|TestQueueRun|TestSetRunSessionID|TestCoalesceRun|TestPostgresCoalesceRun|TestStrictCompletion|TestMoveTask|TestWorkflowChange|TestNormalizeWorkflowAgentOverrides|TestCreateTaskRejectsIncompatibleWorkflowOverride|TestSchedulerIntegration|TestSchedulerTick_|TestBuildAgentStreamEventData|TestConversationLifecycleAndMCPOverlay|TestUnboundChildTurn|TestRunsServiceEngineAdapter_)' -count=1

# 沿用第二检查点的 $taskTestNames 生成方式，文件列表增加第四份：
$taskTestFiles = @(
  'internal/task/repository/sqlite/step_transitions_test.go',
  'internal/task/repository/sqlite/step_transitions_lifecycle_test.go',
  'internal/task/repository/sqlite/change_workflow_test.go',
  'internal/task/repository/sqlite/step_entry_dispatch_test.go'
)
# 从以上文件重新读取全部 Test 函数，再加入 TestPoolDispatch.*。
go test -trimpath -race ./internal/task/repository/sqlite -run $taskPattern -count=1
go run -trimpath ./cmd/sqlguard ./internal
go test -trimpath -race -p=1 ./internal/persistence/storeconformance -count=1
go test -trimpath -race ./internal/persistence/storeconformance -run '^TestPreviousStableUpgrade/sqlite3/v0.93.0$' -count=1
```

前两项十个受影响包及原生任务仓储通过，含移动确认、能力拒绝、检查后变化、旧派发／回执、原生派发账本及严格完成负例；SQLguard 退出 0。Go 格式检查无输出。PG DSN 未配置，PG 能力守卫仍跳过，不能宣称 PG 已验证。

storeconformance 整组仍失败：storage 的 CRUD／timestamp／conflict／transaction、两份 CRLF 升级夹具 checksum；本轮首次升级场景另出现 telemetry activation 更新前后时间戳相等。单独重跑升级场景后回到已记录的 Windows 临时制品绝对路径失败，并未复现时间戳相等，不能把整组记为通过。conformance 与 runs/scheduler 目录均相对 HEAD 无差异；没有修改夹具、扩大时间阈值或修改原生调度器。文档清单验证 349 decisions／1343 specifications 通过；规范全局 lint 仍有既有超体积报告，本功能规范无命中；diff 空白检查通过。

下一段的真实剩余项：

1. 复用原生任务启动准入，覆盖手工启动准备期尚未写会话行的窗口，并给合法池 claim 提供窄的启动许可；不能只靠已有会话／回合行查询声称手动 Start 互斥完成。
2. 在这条准入上接直接创建确认及原生同步创建收尾，再接 HTTP／WS 的确认／版本 DTO。创建的依赖／仓库／策略必须补齐后才允许实际执行；保留原创建幂等和失败回滚合同。
3. 注入 tasks 所有的池消费者，复用原生 orchestrator／Worktree 启动，携带不可变 run／claim／session／execution／turn／operation／generation，并接可信活动回执与真实宿主＋模拟代理测试。
4. 继续工单 02–04 的有界投影、桌面／手机和人工恢复；完成恢复保护前不开放生产者。

工单仍为 in_progress，其他工单 pending。生产发布来源、队列和消费者仍未注入，未运行新宿主／模拟 CLI 闭环；未调用真实模型、未动原实例／Qlik／全局设置，未提交推送或发布。

### 2026-10-18 第五检查点：共享准入与首次读取前的启动窗口，工单未完成

这是原目标的连续实施进展，不是阻塞回合或缩减后的交付。

- `orchestrator/pool_admission.go` 复用原生 `ceilingEntryAdmissionLocks`；池批准和入队通过构造接口借用同一任务锁。没有新增持久状态、独立锁表或调度器。
- 配置 `PoolTaskStartGuard` 后，私有 `startTask` 在首次读取前核验守卫、登记准备计数。计数保留既有锁条目的引用，提供商／预检 I/O 不持任务锁；两个普通启动可以同时进入预检，退出一个仍保持占用，全部退出后释放计数及锁条目。守卫拒绝早于任务读取和执行器调用。
- 原生锁上下文由静态任务字符串改为可失效生命周期。同步嵌套继续重入，退出后保留的上下文不再声称持锁，晚到回调重新取得所有权；不传播一份已释放的持锁身份到 I/O。
- `task/service.SetPoolReleaseAdmission` 保护显式确认移动的最终原生写入及同步提交派发；缺少接线或准入拒绝时，卡片、版本和批准账本保持不变。普通无确认移动不依赖该接口。
- `runs/service.SetPoolEnqueueAdmission` 为可信池发布的必需接线。启动准备中，新发布返回 `pool_task_start_preparing`，不写运行、不发信号；已经持久化的同绑定身份先去重，仍返回原行及原始入队时间。缺少准入返回 `pool_admission_unavailable`；普通原生队列不受影响。
- 新行为已先复现失败再修补：无会话的两个启动仍允许批准、守卫未在读取前执行、发布／移动缺少准入接口，以及提交后旧上下文仍冒充持锁者。任务服务包不能反向导入 orchestrator，使用具备所需能力的明确测试替身；真实锁行为另由原生协调器及跨层测试覆盖。
- `runs/service/pool_publish_start_race_test.go` 将真实 `StartTask` 停在阶段预检读取，随后调用真实原生入队事务，验证无会话窗口拒绝和退出后可发布。该用例只在读取边界故意退出，没有运行宿主二进制、CLI 或模型，不能称为真实宿主＋模拟代理闭环。

最后一次生产代码修改后，第四检查点的十包 `go test -trimpath -race -p=1 ...` 命令再次执行并通过，覆盖全部新的池回归、原生队列／移动／工作流与严格完成负例。另执行：

```powershell
$taskAdmissionFiles = @(rg --files internal/orchestrator -g '*ceiling*test.go' -g '*workflow_session_target*test.go' -g '*pool*test.go' | Where-Object { $_ -notmatch '[\\/]executor[\\/]' })
$taskAdmissionNames = @(foreach ($taskFile in $taskAdmissionFiles) { foreach ($taskMatch in (Select-String -LiteralPath $taskFile -Pattern '^func (Test\w+)\(')) { $taskMatch.Matches[0].Groups[1].Value } })
$taskAdmissionPattern = '^(' + (($taskAdmissionNames | Sort-Object -Unique) -join '|') + '|TestStartTask.*)$'
go test -trimpath -race ./internal/orchestrator -run $taskAdmissionPattern -count=1 -timeout=5m
go test -trimpath -race ./internal/runs/service -run '^TestPoolDispatchPublicationAndNativeStartShareActualAdmission$' -count=1 -timeout=3m
go run -trimpath ./cmd/sqlguard ./internal
```

原生准入清单为 200 个固定用例，另加匹配的 StartTask 用例，退出 0；跨层用例退出 0；SQLguard 退出 0。这些与十包命令合计覆盖 11 个相关包，不是全仓测试结论。本段没有修改仓储 SQL、schema、升级夹具、storeconformance 或 runs/scheduler；未重复运行第四检查点已有记录的存储整组及未改的调度器整包，保留其失败／跳过边界。PG DSN 仍未配置，不能计作 PG 已验证。

文档清单校验为 349 decisions／1343 specifications，通过；全局规范 lint 退出 1，仍为既有文件体积报告，agent-pool-workbench 命中数 0。受影响 Go 文件的 gofmt 检查无输出，diff 空白检查通过。依文档维护规则，仅更新内部设计、计划／工单及后端指引；公开文档没有本池接口合同，生产入口未开放，不添加已发布功能说明。

下一段必须继续以下原验收范围：

1. 实现真实共享队列的启动守卫与当前不可变 claim 的窄启动许可。现在 `PoolTaskStartGuard` 只有接口，测试中的放行／拒绝替身不是活动池占用或领取授权证明，生产实例也没有注入。
2. 审查并覆盖 `StartCreatedSession`、恢复／提示复用和其他执行入口；不能把本段 StartTask 准备计数当成全部手动启动互斥。保持正常非池并行能力。
3. 在共同准入上接直接创建确认、依赖／仓库／策略收尾及失败回滚，再接 HTTP／WS 确认 DTO。原生创建的同步提交派发早于 service 收尾这一事实仍未解决，不能先开放生产者。
4. 接 tasks 所有的池消费者、原生 Worktree／运行时、可信活动回执，完成真实宿主＋模拟代理及恢复保护；之后按原计划继续 02–04，不跳过桌面／手机和人工恢复。

工单 01 仍 in_progress，02–04 pending；共同准入只在测试中显式接线，生产发布／消费者保持未注入。严格 Done 规则保留；未调用真实模型、未变更原实例／Qlik／全局设置、未提交推送或公开发布，旧插件包／兼容补丁仍不包含这些池修改。

### 2026-10-19 第六检查点：不可变领取许可与原生模拟启动，工单未完成

自 2026-10-18 跨日继续，上一段和本段均有代码与验证进展；目标未缩减，没有阻塞或暂停。

- `runs/service.CheckPoolTaskStart` 已接真实队列占用，复用共同任务准入和 SQLite 写事务；同卡 queued／claimed 池运行拒绝普通启动并返回原 run ID。核验不改任务版本、不补造账本／会话。真实 StartTask／队列双向竞争同时验证两个普通启动可并行预检。
- `ClaimedRun.PoolStartRequest` 从真实领取快照提取 `PoolClaimStart` 值，核对领取状态、完整批准、保留键、原生列与 payload；不使用通用上下文授予许可。`StartPoolTask` 是仅供宿主消费者使用的入口，携带私有 `startTaskOptions.poolClaim`，固定批准 Profile／Worktree／entry，并按自动容量路径执行。只有普通守卫而无领取签发能力时，读取任务和调用提供商之前失败关闭。
- `AdmitPoolClaimStart` 在原生事务内重读当前批准和 run、唯一 claim 账本及资格。`CheckPoolClaimReadyTx` 仅排除当前运行本身，仍拒绝其他活动池运行、活动／未知会话、未完回合、依赖和失效执行配置。缺失或歧义领取、错绑定、旧会话、领取后变化等十类拒绝用例均不留下意图。
- `AppendPoolLaunchAdmissionTx` 复用现有 run_events 和原生写权，提交 `pool.launch-admitted.v1` 后才允许进入准备。相同 claim 不再签发；已有意图未知或多解也不猜测。它只是一次性启动意图，不是执行绑定、开工或完成回执。没有新表、第二队列或协调模型。
- 十二并发请求只提交一个意图；覆盖重建队列服务对象，以及真实磁盘 SQLite 的两个独立连接池／两个协调器。后者验证事务边界，不表示支持两个生产后端或跨机器。重建对象不是宿主二进制重启验收。
- 注入意图写入失败后事务回滚，真实协调器不创建会话、不改变主卡状态／版本、不调用模拟提供商；纯数据库故障解除后首次许可仍可提交。能力未接齐也不签发。
- 原生 `admitStartCapacity` 被池路径复用。已获准尝试在容量拒绝时返回 `pool_task_capacity_unavailable`，不创建普通 ceiling 自动重播、不改调度状态或创建会话。已登记意图和 claim 保留供后续核实，不自动重入队或回退模型；普通原生任务的既有自动延迟行为保留。
- `backendapp/pool_runtime_fixture_test.go` 复用真实任务／流程／队列／协调器及同一事件总线，在启动前注入守卫。合法 claim 创建同卡一份真实会话，并抵达模拟提供商；重复调用不创建第二会话、不把主卡完成、不补造 execution-bound／work-observed。旧模拟后端最初因缺 workspace_path 被原生 Worktree 环境校验拒绝；只补齐测试返回的实际临时目录合同，没有放宽生产校验或伪造 Worktree ID。目前私有 claim 尚未下传到原生 session／turn／execution 的关联边界，也未设置 runs.session_id 或接活动观察器；下一段不能误以为这些已完成。

边界必须保留：本段没有运行新宿主二进制或模拟 CLI 子进程。模拟提供商目录不是实际 Git checkout／Worktree／停止证明，可信活动回执还未连接，真实开工仍不可报告；直接仓储批准夹具也不证明浏览器／CreateTask 收尾已完成。

最后一次生产代码修改后的验证：

```powershell
# 第四检查点的十包命令保留全部原前缀；追加使用共享模拟夹具的既有用例。
$taskBackendFixtureFiles = @(rg -l 'newRoutineCronHarness\(|newStubAgentManager\(' internal/backendapp -g '*_test.go')
$taskBackendFixtureNames = @(foreach ($taskFile in $taskBackendFixtureFiles) { foreach ($taskMatch in (Select-String -LiteralPath $taskFile -Pattern '^func (Test\w+)\(')) { $taskMatch.Matches[0].Groups[1].Value } })
$taskBackendExtra = ($taskBackendFixtureNames | Sort-Object -Unique) -join '|'
$taskPackagePattern = '^(TestPool|TestClaim|TestQueueRun|TestSetRunSessionID|TestCoalesceRun|TestPostgresCoalesceRun|TestStrictCompletion|TestMoveTask|TestWorkflowChange|TestNormalizeWorkflowAgentOverrides|TestCreateTaskRejectsIncompatibleWorkflowOverride|TestSchedulerIntegration|TestSchedulerTick_|TestBuildAgentStreamEventData|TestConversationLifecycleAndMCPOverlay|TestUnboundChildTurn|TestRunsServiceEngineAdapter_|' + $taskBackendExtra + ')'
go test -trimpath -race -p=1 ./internal/task/models ./internal/task/service ./internal/runs/service ./internal/runs/repository/sqlite ./internal/office/service ./internal/workflow/engine ./internal/workflow/models ./internal/backendapp ./internal/agentctl/server/adapter/transport/codexappserver ./internal/agent/runtime/lifecycle -run $taskPackagePattern -count=1 -timeout=5m

# 沿用第五检查点的原生准入清单生成方式；本段为 202 个固定 Test，另加 StartTask.*。
go test -trimpath -race ./internal/orchestrator -run $taskAdmissionPattern -count=1 -timeout=5m
# 从第四检查点四份原生账本文件生成全部 Test，再并入 TestPool.*；本段固定 Test 为 37 个。
go test -trimpath -race ./internal/task/repository/sqlite -run $taskNativePattern -count=1 -timeout=5m
go run -trimpath ./cmd/sqlguard ./internal
go test -trimpath -race ./internal/runs/service -run '^TestPoolDispatchPublicationPostgresUnavailablePreservesOrdinaryQueue$' -count=1 -v
go test -trimpath -race -p=1 ./internal/persistence/storeconformance -count=1
go test -trimpath -race ./internal/persistence/storeconformance -run '^TestStoreConformance/sqlite3/storage$' -count=1
```

十包、原生准入包及原生任务仓储包退出 0，共 12 个相关包的针对性测试通过；后端共享夹具追加了 8 个既有固定 Test。SQLguard 退出 0，受影响 Go 文件 gofmt 检查无输出，diff 空白检查通过。PG 守卫因无 DSN 明确 SKIP，不计 PG 已验证。内部文档清单校验为 349 decisions／1343 specifications，通过；全局规格 lint 仍退出 1，保留既有体积报告，本功能命中数 0。仅更新内部设计、计划／工单及后端指引，未把尚未开放的接缝写成已发布功能。

存储整组退出 1：storage 仍失败、sqlite.sql／postgres.sql 两份升级夹具 checksum 不符，PreviousStableUpgrade 本段再次出现 telemetry_activations 更新前后时间戳相等。单独 storage 复核退出 1，确认 CRUD／timestamp／conflict／transaction 四场景失败；不从过滤摘要补推本次根因。conformance 与 runs/scheduler 目录相对 HEAD 无差异；没有修改既有夹具、扩大时间阈值或修补无关调度器，也未重复运行未改且已记录失败的 runs/scheduler 整包。不能报告全仓全绿或正式验收。

下一段按原目标继续，不能因为本段启动成功就先开放生产者：

1. 在会话／turn／execution／operation／generation 的原生分配边界携带并绑定私有 claim，连接可信开工与终结观察。首个提供商事件可能早于 StartPoolTask 返回，不能在返回后猜最近会话／回合；核对通用事件写入口不能签发池保留证据。
2. 审查 StartCreatedSession、Resume、Prompt 与自动复用入口；保留普通非池能力，补齐当前池运行的执行互斥及可信身份。仅 StartTask 受保护不代表所有执行入口已封闭。
3. 继续直接创建确认、依赖／仓库／策略收尾和回滚，再接 HTTP／WS DTO；原生创建提交派发早于 service 收尾的问题仍须解决。
4. 连接同一个原生消费者的 tasks 适配器，先补池的 stale／requeue 窄保护，再做真实宿主＋模拟 CLI／checkout／失败恢复与严格 Done 负例。原 RecoverStale／RequeueClaimedRun 尚未受池保护，生产消费者／发布能力仍不能注入。
5. 按原顺序继续 02–04：有界投影、桌面／手机、关系导航及人工恢复。不得把目录或对象重建测试代替这些验收。

01 仍 in_progress，02–04 pending；严格 Done 与原实例保持不变。未消费真实模型／API 额度，未动 Qlik／全局设置，未提交推送、切换生产或公开发布；旧插件包／兼容补丁仍不含本轮池代码。

### 2026-10-19 第七检查点：保留证据、自动恢复隔离与会话入口准入，工单未完成

本段为原目标连续实施，目标仍 active；没有暂停、阻塞或缩减验收。

- 普通 `AppendRunEvent` 现在拒绝整个 `pool.*` 保留事件命名空间，返回 `pool_event_type_reserved`，不留下事件或占用序号。普通事件正文提及池类型不受影响，专用事务回执方法仍可追加。两个原生运行类型及未来保留类型均有回归；这是内部签发边界，不表示曾存在已开放的公网接口漏洞。
- `RecoverStale`、`RequeueClaimedRun`、`ScheduleRetry`、`ScheduleRetryIfClaimed` 在原生 SQL 写条件中排除池保留键，不从 payload 完整性或活动静默推导“可再派”。只有前缀的残缺记录也保护，普通其他键仍恢复；没有新表、调度器或 schema。四个入口均先复现了错误重置，再修补。
- 自动恢复隔离保留原 status、claimed_at、session、重试及优先级；真实 claim、绑定及工作回执经过四入口后不变，重建仓储对象仍只读还原同一个 claim／账本／历史。仅返回 error 的 ScheduleRetry 对未更新行保留 nil 合同，调用方不能据 nil 宣称重入队。旧回调隔离测试现通过明确的测试 SQL 构造旧版本／人工恢复后的替换行，不再借被禁止的通用重排制造新 claim。
- `startCreatedSession`、`resumeTaskSessionWithContinuation`、`promptTask` 在首次原生读取前复用共同任务准入；组合恢复并提示进入相同恢复路径。四个入口同时停在首次会话读取时，仍允许普通并行预检，但最后一个调用退出前新批准始终被拒绝；任务锁不跨 I/O，退出后准备计数及原锁引用全部释放。测试只在读取边界退出，不冒称这些正对照已实际启动模型。
- 真实共享队列／协调器夹具另复现 `PrepareTaskSession` 在已有 claim 时仍创建并行会话的问题，补上首次任务读取前的同一准入。拒绝不创建会话或改变主卡版本；仅撤销夹具里尚未签发启动意图、尚未执行的占用后，同配置确实能创建一份原生 CREATED 会话。未调用模拟提供商，更没有实际 CLI／模型调用。此测试撤销不是人工恢复接口实现。

执行关联的接点已再次核对，但本段没有实现观察器：`LaunchOptions.OnExecutionAdmitted` 是进程启动前已有的同步回调，参数为已分配 execution ID，但返回值不含 error，不能假设回调内持久化失败会自动阻止启动。ACP `GetOperationID()` 实际返回空串，不能据此声称具有提供商 operation 证据。下一段需沿真实分配／提示／传输边界捕获本次 claim、session、turn、execution 与必要 operation／generation；不得在启动返回后查询可变当前值补猜首帧，也不新增通用运行时框架兜底。

最后一次生产代码修改后的验证：

```powershell
# 沿用第六检查点十包命令，所有新 TestPool* 与共享夹具的 8 个既有用例都在清单内。
go test -trimpath -race -p=1 ./internal/task/models ./internal/task/service ./internal/runs/service ./internal/runs/repository/sqlite ./internal/office/service ./internal/workflow/engine ./internal/workflow/models ./internal/backendapp ./internal/agentctl/server/adapter/transport/codexappserver ./internal/agent/runtime/lifecycle -run $taskPackagePattern -count=1 -timeout=5m

# 从第五／六检查点的文件清单重新生成固定 Test 名称，本段 204 个；扩大原生入口回归前缀。
$taskAdmissionPattern = '^(' + (($taskAdmissionNames | Sort-Object -Unique) -join '|') + '|TestStartTask.*|TestStartCreated.*|TestResumeTaskSession.*|TestPromptTask.*|TestPrepareTaskSession.*)$'
go test -trimpath -race ./internal/orchestrator -run $taskAdmissionPattern -count=1 -timeout=5m
# 沿用四份原生账本文件的 37 个固定 Test，并入 TestPool.*。
go test -trimpath -race ./internal/task/repository/sqlite -run $taskNativePattern -count=1 -timeout=5m
```

以上十包、原生协调器包及任务仓储包退出 0，共 12 个相关包的针对性回归；协调器最终运行 40.407s。SQL 写逻辑最后修改后，运行仓储整包 `go test -trimpath -race ./internal/runs/repository/sqlite -count=1 -timeout=5m` 退出 0（8.181s），覆盖普通重排／重试／过期扫描的原有测试；之后该包仅调整 AC 注释，所有新的测试仍由最终十包命令覆盖。初次扩大协调器测试清单时，JavaScript 字符串替换把 `$'` 解释为替换占位符，生成的 PowerShell 无法解析，未执行测试；改用字面回调替换后已完成上述最终通过运行，不把解析失败算行为 RED 或测试通过。

另执行 `go run -trimpath ./cmd/sqlguard ./internal`，退出 0；PG 行为测试 `TestPoolAutomaticRecoveryIsolationPostgres` 的八个子场景因没有 DSN 全部明确 SKIP，不能计为 PG 已验证。Go 格式检查无输出，内部文档清单校验 349 decisions／1343 specifications 通过；规格全局 lint 仍退出 1，为 107 项 file-size，其他规则 0、本功能命中 0。diff 空白检查通过。仅更新内部文档及后端指引，公开文档中无这些未开放接口合同，未发布功能说明。

本次 storeconformance 整组退出 1，原始输出核实为：sqlite3/storage 的 CRUD／timestamp／conflict／transaction 使用非 Windows 绝对临时路径；sqlite.sql／postgres.sql 两份升级夹具 checksum 不符；PreviousStableUpgrade/sqlite3/v0.93.0 为同一 storage 路径失败；TestStoreConformance/sqlite3/telemetry-contract/crud 另复现 activation 更新前后时间戳相等。没有修改 conformance、夹具或 runs/scheduler，conformance 与 runs/scheduler 目录相对 HEAD 无差异；未扩大时间阈值或重复执行未改的原生调度器整包。不能宣称全仓、CI 或完整验收通过。

仍须按原目标继续：

1. 接原生进程启动前的可信执行关联、首个匹配活动和终结观察；解决 ACP 没有 provider operation 的真实能力边界。失败保留待核实，不调用模型补证据。
2. 审计其余直接执行器／运行时、路由和自动恢复入口；本段覆盖主路径，不是所有入口已封闭。
3. 接直接创建确认及依赖／仓库／策略收尾和回滚，再接 HTTP／WS 额度确认与版本 DTO；不在 service 收尾前执行同步提交派发。
4. 注入同一原生消费者的 tasks 适配器，完成真实宿主＋模拟 CLI／Git checkout／失败恢复与严格 Done 负例。四个自动恢复保护不等于核实后人工恢复完成，不能开放生产者。
5. 继续工单 02–04：有界投影、桌面／手机界面、卡片关联导航及人工恢复。当前 HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40，所有实施仅在隔离工作区，未提交。

01 继续 in_progress，02–04 pending；目标保持 active。严格 Done 门禁与原实例未改，真实模型／API、Qlik／全局设置、提交推送、生产切换与公开发布均未执行；旧插件包／兼容补丁仍未包含池扩展。

### 2026-10-19 第八检查点：进程前分配与可信开工已接通，工单未完成

本段有代码、原生输入和模拟服务验证进展，非等待／阻塞回合；目标未缩减。所有源码仍在隔离副本，HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40。

- 新增原生 `LaunchOptions.BeforeExecutionStart` 可拒绝回调，覆盖完整 LaunchAgent 分配路径与已准备工作区快路径。回调失败不启动模型、也不调用旧 OnExecutionAdmitted 通知；普通无回调路径保留。工作区／agentctl 的准备可能已发生，不把拒绝等同于 checkout 已停止释放。
- `BindPoolExecution` 在共同任务准入及 SQLite 事务中核对当前批准、唯一 claim、已提交启动意图和实际原生分配。任务仓储验证 session／turn／executors_running、固定 CLI／Worktree、开放回合、依赖与其他占用；与 runs.session_id 一起写 `pool.execution-allocated.v1`，重复返回原事件，事务失败不留下半次绑定。首次实现误用了已迁走的 task_sessions.agent_execution_id，真实正对照失败后改为单一权威 executors_running，并用原生 Upsert 补齐模拟提供商合同，没有放宽生产校验。
- `StartPoolTask` 把私有 claim 与此次已分配 session／turn／execution 传到进程前门禁，不在返回后猜最近对象。空、错误类型、跨 run、错 execution、坏 JSON 的返回值，以及缺少绑定／活动捕获能力均拒绝。只有同一分配的持久确认才启用原生 `EnableWorkActivity`。
- 生产代码复核发现合并文本流不携带全部回合／operation 字段；因此在原生协议输入处捕获并发布精简 `work_activity`，不修改文本合并算法。generation 映射在原生锁内读取，锁释放后发布；旧 generation 不被新回合覆盖。普通执行默认关闭，仅在已绑定初始回合且尚未进入提示时由宿主显式启用。回显、诊断、子代理、合成启动与未知映射不签发，不保存正文或工具参数。
- 池观察器核对当前唯一 claim、启动意图、分配及精确执行身份。对同一次可信活动，在一个事务里追加 `pool.execution-bound.v1` 与 `pool.work-observed.v1`；12 并发帧和重复活动只保留第一次来源／时刻。ACP 明确记录 operation_source=host_turn 且 operation_id=已绑定原生 turn_id；Codex app-server 为 provider，使用真实提供商 operation。不能把这两种来源混写。
- 写入／提交失败、缺失／歧义分配和陈旧身份不返回有效工作证据；绑定与工作一同回滚，已提交意图和分配仍保留，不重派或调用模型补证据。提交错误曾返回未提交事件对象，延迟外键故障回归复现后修正为 nil＋error。普通非池流先走原生索引读取，不取得任务写锁；没有新增业务表、队列、调度器或运行时框架。
- 真实协调器／队列／任务服务／运行清单与模拟进程测试证明：分配提交先于模拟进程，分配本身不开工；真实原生用户消息的提交后发布边界可暂停 StartPoolTask 返回，早到的协议活动仍能先持久化开工。并行测试协程有清理／退出边界。它是服务和协议输入证明，不是新宿主二进制、模拟 CLI 子进程、实际 Git checkout 或真实模型验收。

最后一次生产代码修改后，沿用第七检查点三组固定命令：十包（含全部新 TestPool* 和共享后端夹具的 8 个既有用例）、协调器 206 个固定 Test 加原生 Start／Prepare／Resume／Prompt 前缀、任务仓储 37 个固定 Test 加 Pool，均退出 0。协调器 46.469s、任务仓储 13.949s；十包中的原生后端 7.668s。额外执行器正对照使用下列带 `.*` 的真实前缀，退出 0（1.268s）；不能将初次仅匹配前缀全名的选择器当作这些长名称用例已运行。

```powershell
go test -trimpath -race ./internal/orchestrator/executor -run '^(TestPoolExecutionStartAdmission.*|TestExistingWorkspaceStart.*|TestSessionStartingRace.*|TestLaunchPreparedSession_Success|TestLaunchPreparedSessionFailsClosedWhenRuntimeInventoryReadFails|TestLaunchPreparedSession_PropagatesTaskEnvironmentPersistenceFailure|TestLaunchPreparedSession_RejectsNilLaunchResponse)$' -count=1 -timeout=3m
go run -trimpath ./cmd/sqlguard ./internal
go test -trimpath -race -p=1 ./internal/agent/runtime/lifecycle ./internal/orchestrator/executor -count=1 -timeout=6m
go test -trimpath -race -p=1 ./internal/persistence/storeconformance -count=1 -timeout=5m
```

SQLguard 退出 0；运行仓储整包 `go test -trimpath -race ./internal/runs/repository/sqlite -count=1 -timeout=5m` 退出 0（7.342s）。执行器／生命周期整包退出 1，输出很大且截断；已核实的例子包括模式 0666／0600 差异、helper 可执行模式、反斜线断言、Cursor MCP／安全路径 Access is denied，以及工作区清单修复／证明失败。不能据截断输出完成所有失败归因，也未在本段修补无关平台逻辑。另从 `*stream*test.go`、`*events*test.go`、`work_activity*test.go` 重新生成 164 个固定生命周期 Test，仍退出 1，明确失败为 `TestLaunch_PromotionPublishesPrepareCompletedAfterCursorMCPPreparation` 的 Cursor MCP discovery 等待；不是全绿。全部新的池协议／捕获用例由最终十包命令的 TestPool* 覆盖并通过，但不能替代该扩展组。

本段 storeconformance 退出 1（44.372s）：sqlite3/storage 的 CRUD／timestamp／conflict／transaction 及 PreviousStableUpgrade 为 Windows 绝对路径问题，两份 SQL 夹具 checksum 不符；本次未观察到上一检查点的 telemetry 时间戳相等失败。conformance 与 runs/scheduler 目录相对 HEAD 无差异，未改夹具、调度器或全局设置。PG DSN 未配置，不计 PG 已验证。

受影响文件的 gofmt 检查无输出，diff 空白检查通过；初次按 `*pool*.go` 搜索还包含三个未修改的 internal/db 池文件，其既有格式报告不归本池，也未格式化它们。内部目录校验 349 decisions／1343 specifications 通过；规格全局 lint 仍退出 1，为 107 项 file-size，本功能 0、其他规则 0。按文档维护规则只更新内部设计、计划及后端指引；生产构造器尚未注入本池发布／消费者，未将内部事件写成已发布接口。

下一段的原范围仍完整保留：

1. 接终结观察和同一原生消费者的 tasks 处理器；回合结束、进程停止、checkout 释放与原生 Done 继续分开。不要把当前已开工、仍 claimed 的行直接完成或自动重排。
2. 审计剩余直接执行器／运行时入口；接直接创建确认及依赖／仓库／策略收尾与回滚，再接 HTTP／WS 额度确认和版本 DTO。
3. 完成真实宿主二进制＋模拟 CLI／实际 checkout、停止与重启、旧回调、并发恢复及严格 Done 负例。当前的模拟运行清单／目录、协议输入测试和服务对象重建均不能替代它们。
4. 继续 02–04 的有界投影、桌面／手机工作台、卡片关联及人工恢复；增量通知需来自已提交记录，不把总线发布当作本地处理确认。完整恢复保护完成前仍不开放生产者。

01 继续 in_progress，02–04 pending，目标 active；严格 Done 和原实例保持不变。未调用真实模型／API，未新增子代理、跨机器工作、生产切换、提交推送或公开发布；旧插件包／兼容补丁未重打包。

### 2026-10-19 第九检查点：共享消费者与回合结束证据，未释放运行

本段有实际实现及针对性验证，不是等待／阻塞回合。HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40，所有更改保留在隔离副本；目标及验收范围未缩减。

- 既有 `officeOrchestratorTaskStarter` 新增 `ProcessPoolRun`，直接把同一共享消费者的 `ClaimedRun` 交给 `StartPoolTask`，不经过普通 Office Profile 启动或第二次领取。真实队列／任务服务／协调器的集成夹具已从 `SchedulerIntegration.Tick` 开始，抵达模拟进程及开工记录；第二次 tick 仍只有一份 run、领取账本和原生会话。生产构造器仍未注入该处理器。
- 新增 `ObservePoolTurnEnd` 与 `pool.turn-ended.v1`。只接受原生生命周期已核验的主回合 complete，固定 generation／turn／execution／Profile 和实际 operation 必须匹配当前唯一 claim 及分配。typed 布尔结果归一化为 completed／failed，不保存正文或工具参数；同一事务确认 operation 绑定并写结束记录，绝不补造开工、改主卡或填 runs.finished_at。
- 结束记录不代表模型进程／运行时已停止，更不代表 checkout 已释放。成功、失败、保留运行时的失败和没有工作帧的结束均保持领取；同轮工作帧更晚处理仍可保存开工。12 并发重复结束保留一个事件／原时刻，矛盾结果、旧身份及不同 operation 拒绝，延迟外键提交失败不返回未提交事件。结束先于工作测试的 run 仍为 claimed，不是运行已终结后的迟到帧验收。
- 原生生命周期的生产合同测试明确在 AgentReady 发布时开始后继回合，然后验证晚发布的 complete 帧仍带原 generation、原 turn 和原提供商 operation，而不是最新值。此处不新增另一套结束事件或生命周期锁。
- 发现通用终结仍可绕过池身份后，先复现 FinishRun、MarkRunFailed、单行／批量／选择器取消对池行的错误写入，再在原生最终 SQL 按保留键排除本池。普通运行正对照仍可完成／失败／取消；混合取消批次仅更改普通 queued／claimed 行。空返回和 false 不表示成功停止，不允许据此释放或重新派发。
- 集成消费者夹具已启用真实严格完成策略，结束之后显式调用原生完成动作仍因缺少交付回执被拒绝；并保留正常 TaskStarter 依赖，不因缺省普通启动器让分流测试虚假通过。没有修改严格 Done 的实现或标准。

TDD 的行为 RED 已分别观察到：缺少消费者方法、缺少回合观察方法、集成结束帧没有第五条证据，以及通用终结改写池行。中间两次测试编译问题（状态常量名、RunStatus 转 string）不计为行为 RED。终结保护同时暴露旧测试用通用 FinishRun／CancelRun 制造存量状态的准备错误；已改为显式、限定 ID 的持久夹具构造，保留迟到活动拒绝、同卡占用和无占用可准备的原业务断言，不把这种 SQL 准备算作人工恢复或停止证明。

最后一次生产代码修改后的验证：

- 沿用第七检查点三组固定命令：十包针对性回归最终退出 0，含全部 TestPool*、严格完成、队列／工作流及共享后端夹具的 8 个既有测试；协调器 207 个固定 Test 加原生 Start／Prepare／Resume／Prompt 前缀退出 0（41.309s）；任务仓储 37 个固定 Test 加 Pool 退出 0（11.163s）。首次十包因上述取消夹具失败，修复后重新运行成功，没有过滤失败用例。
- `go test -trimpath -race -p=1 ./internal/runs/repository/sqlite ./internal/office/repository/sqlite -count=1 -timeout=5m`：运行仓储整包退出 0（8.524s）；Office 仓储退出 1（6.986s）。后续新增混合取消用例与夹具修正均由最终十包覆盖。Office 的两个失败为 `TestTouchRoutineLastRun_TouchesOnlyLastRunAtAndUpdatedAt`（相同 updated_at）及 `TestReleaseWorkspacePauseWithActivity_ReleasesAndLogsResumed`（created_at 排序得到 pause 在前）。同一包仅选这两个名称的 `-run '^(TestTouchRoutineLastRun_TouchesOnlyLastRunAtAndUpdatedAt|TestReleaseWorkspacePauseWithActivity_ReleasesAndLogsResumed)$'` 单次复核仍失败；其源码及测试相对 HEAD 无差异，没有修改时间阈值或排序实现，整包不得报全绿。
- `go test -trimpath -race ./internal/agent/runtime/lifecycle -run '^(TestPoolTurnEndIngress|TestHandleAgentEvent_CompleteCarriesPromptTurnID|TestHandleAgentEvent_DelayedCompleteCannotFinishReplacementPrompt|TestHandleAgentEvent_UnnumberedCompleteCannotReleasePendingPrompt)' -count=1 -timeout=3m` 退出 0（1.963s）；其新增 Pool 测试也由最终十包运行。此前第八检查点的生命周期／执行器整包失败仍保留，未重跑或宣称本段解决。
- 最后消费者夹具与 AC 注释调整后，`go test -trimpath -race ./internal/backendapp -run '^TestPoolConsumer' -count=1 -timeout=3m` 再次退出 0（2.403s）。
- `go run -trimpath ./cmd/sqlguard ./internal` 退出 0；`go test -trimpath -race -p=1 ./internal/persistence/storeconformance -count=1 -timeout=5m` 退出 1（43.550s），仍为 storage 的 Windows 绝对路径场景、两份升级 SQL checksum 及 PreviousStableUpgrade 同类路径问题。conformance 与共享 runs/scheduler 目录相对 HEAD 无差异，未改夹具；本段未重跑之前的调度器 100ms 门槛失败。PG DSN 未配置，不计 PostgreSQL 已验证。
- gofmt 与 diff 空白检查通过；内部目录验证 349 decisions／1343 specifications 通过。规格全局 lint 仍有 107 个 file-size，本功能 0、其他规则 0。按文档维护规则仅同步内部设计、此工单及后端指引；没有公开新的接口、开关或用户文档。

下一段仍须完成：

1. 从原生运行时／停止边界获得本次执行与 checkout 的可靠证据，接专用、当前 claim 约束的运行终结；不能把 complete／ready、空查询或通用取消返回当成停止。不因本段已有 ended 记录而直接 FinishRun 或自动重排。
2. 审计其余直接执行器／运行时／重试入口；完成直接创建的确认、依赖／仓库／策略收尾和回滚，再接 HTTP／WS 额度确认与版本 DTO。
3. 保持生产构造器关闭，完成真实宿主二进制＋模拟 CLI 子进程／实际 Git checkout、停止与重启、旧回调、并发恢复及严格 Done 负例。当前服务、协议输入、模拟目录和持久夹具不能替代这些验收。
4. 继续 02–04 的有界读投影、已提交通知、桌面／手机工作台、卡片关联及人工恢复；全部保护接齐前不开放生产者。

01 仍 in_progress，02–04 pending，目标 active。未消费真实模型／API／CLI 额度，未变更原实例／Qlik、跨机器、子代理、全局设置、生产切换、提交推送或公开发布；旧插件包未重打包。

### 2026-10-19 第十检查点：可核验的原生停止事实，资源终结仍未完成

上一回合为实际进展；本回合继续有实现及验证进展，不是阻塞或仅等待。实际 HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40，目标完整保留，所有写入仍在隔离副本。

- 源码复核确认：agent.stopped 还会由关闭期间的逻辑取消发布；旧 stopAgentViaBackend 在没有 registry／runtime 时也可能返回 nil，Standalone.StopInstance 缺少实例 ID 同样无操作成功。这些返回不能证明池执行已停止。没有直接把 stopped、完整 StopAgent 返回或空查询当作终结。
- 在既有 StandaloneExecutor 新增窄能力 `StopInstanceConfirmed`，复用原 ControlClient 和 StopInstance：GET 核对实际 instance／task／session，执行原 DELETE，再 GET 确认后置缺席。缺宿主身份、缺实例、错范围、读取失败、删除失败、实例仍在及无法核实后置状态均返回未确认；没有新运行时、控制服务器或队列。
- 捕获启用的池执行仅通过此能力停止，不先调用尚未核对实例范围的旧单进程 Stop；实际停止后才关闭连接并移除原生执行。普通执行保留原停止顺序及政策，存活 detach 不发停止证明；逻辑关闭事件也不带证明。
- 实际原生停止路径签发可选 `RuntimeStopConfirmation`，包含限定的控制服务来源、原生实例 ID 与执行级活动释放状态，不保存工作区路径、提示或终端正文。活动租约在原生协调器下真实存在的正对照已验证释放；旧准备所有权失效但仍持租约时明确 false，活动协调器不可用时同样 false。该字段绝不等于 checkout 或全部宿主资源已空闲。
- 既有 Watcher 现在保留此可选字段，包括 false 值；既有 handleAgentStopped 在会话终态／旋转过滤前把匹配事实交给同一 runs 服务。`ObservePoolExecutionStopped` 在原生共同任务准入和写事务中核对当前唯一 claim、启动意图与分配，追加 `pool.execution-stopped.v1`。整体执行停止不补造 provider operation、开工或回合结果，也不改任务或运行终态。
- 三类 CLI 的记录／重放、8 并发通知、矛盾资源状态或实例、旧执行／回合／generation／Profile、未知来源、无效实例 ID、提交失败均有覆盖。记录失败不返回有效证据，历史不能被后来的“资源已释放”值覆盖；后续资源核验必须有独立证据。
- 原生生命周期生产者到模拟 HTTP 控制服务，以及真实总线／Watcher／队列事务均有测试；后端集成的停止输入是生产形状的模拟事件，不是同一个真实 CLI 子进程停止闭环。已有关联流程现有六类独立记录：启动意图、进程前分配、工作绑定、开工、回合结束、执行停止；仍保持原领取，不冒称原生二进制／实际 Git checkout／重启验收。

行为 RED 分别观察到：缺少停止确认能力、确认前仍调用旧 Stop、无真实 runtime 仍报告成功、Watcher 丢失证明、缺少停止记录入口、总线停止没有第六条记录、缺 Agent 身份被判可信，以及活动跟踪不可用却误报释放。最后一项已修为必须有协调器才能证明执行活动释放。一次返回 RunEvent 值而非指针的编译问题在继续测试前修正，不计为行为 RED。

验证结果：

- 最后一次生产修改后，沿用第七检查点首条命令并加 `./internal/orchestrator/watcher` 的十一包回归退出 0，覆盖全部 TestPool*、严格 Done、共享队列／工作流及后端共享夹具的 8 个既有测试；本次 backendapp 7.049s、runs/service 30.357s、lifecycle 1.379s、watcher 1.141s。
- 原生停止／活动固定组 55 个测试退出 0（3.318s），包括普通停止、存活分支、失败保留、工作区文件不被更改、逻辑关闭、真实原生活动租约、pending 所有权、缺协调器及全部新停止证明测试。测试文件和实际选择器如下，使用既有隔离 `$taskGo`／Go 环境，从 apps/backend 执行：

```powershell
$taskStopFiles=@('internal/agent/runtime/lifecycle/manager_stop_detach_test.go','internal/agent/runtime/lifecycle/manager_stop_persistence_test.go','internal/agent/runtime/lifecycle/manager_stop_retry_agentctl_test.go','internal/agent/runtime/lifecycle/manager_stop_worktree_test.go','internal/agent/runtime/lifecycle/manager_recovery_stop_test.go','internal/agent/runtime/lifecycle/manager_events_shutdown_test.go','internal/agent/runtime/lifecycle/activity_test.go','internal/agent/runtime/lifecycle/pool_stop_publication_test.go','internal/agent/runtime/lifecycle/pool_stop_confirmation_test.go','internal/agent/runtime/lifecycle/work_activity_test.go','internal/agent/runtime/lifecycle/work_activity_reject_test.go','internal/agent/runtime/lifecycle/pool_turn_end_test.go')
$taskStopNames=@(foreach($taskFile in $taskStopFiles){foreach($taskMatch in (Select-String -LiteralPath $taskFile -Pattern '^func (Test\w+)\(')){$taskMatch.Matches[0].Groups[1].Value}})
$taskStopPattern='^('+ (($taskStopNames|Sort-Object -Unique)-join '|')+')$'
& $taskGo test -trimpath -race ./internal/agent/runtime/lifecycle -run $taskStopPattern -count=1 -timeout=5m
```

- 最后生产修改后，`go test -trimpath -race ./internal/runs/repository/sqlite -count=1 -timeout=5m` 退出 0（9.871s）；`go test -trimpath -race ./internal/orchestrator -run '^TestPoolExecutionStopClassifier' -count=1 -timeout=3m` 退出 0（1.195s）。
- 最后活动协调器判定修正之前，协调器 208 个本包固定名称加原生 Start／Prepare／Resume／Prompt 前缀退出 0（42.492s）。固定文件筛选现限定根包 `((Split-Path -Parent $_) -replace '\\','/') -eq 'internal/orchestrator'`；此前递归清单计 209，额外包含一条归 Watcher 包所有的名称，不能称本包跑了 209 个固定测试。Watcher 已由最终十一包验证；最终原生变更由 55 组及十一包覆盖，协调器本段新增分类回归也在最后修改后重跑。
- 同在最后活动判定修正之前，生命周期整包 `go test -trimpath -race ./internal/agent/runtime/lifecycle -count=1 -timeout=6m` 退出 1（177.219s），146 个失败测试名称；本次包装仅打印前 55 个名称，不能完成全部失败归因。可见项含 portable config、helper 下载／Linux helper、Cursor MCP 准备及 Worktree／本地 Git 准备等。没有修改这些平台功能，也不把全部失败宣称为已证实基线或把整包报绿。
- `go run -trimpath ./cmd/sqlguard ./internal` 退出 0。`go test -trimpath -race -p=1 ./internal/persistence/storeconformance -count=1 -timeout=5m` 退出 1（45.879s），仍见 Windows 绝对路径校验、两份升级 SQL checksum 及 PreviousStableUpgrade 的同类路径失败；conformance 与 runs/scheduler 目录相对 HEAD 无差异，未改夹具。PG DSN 未配置，不计 PG 验证。上一检查点的 Office 时间／排序失败与调度器 100ms 门槛未在本段重跑或宣称修复。
- gofmt／diff 空白检查通过；内部目录验证 349 decisions／1343 specifications 通过；全局规格 lint 仍为 107 个 file-size，本功能 0、其他规则 0。按文档维护规则同步内部设计、此工单和后端指引，不发布入口、开关或部署说明。

下一段必须保留的工作：

1. 用已提交的当前 claim／分配／停止事实，加上原生工作区／数据库占用及必要活动所有权核验，接专用运行终结；原生停止回调可能早于原会话／回合收尾，不能只按空查询、旧布尔值或事件顺序释放。完整资源／终结 CAS 尚未实现，通用终结保护不得删除。
2. 处理停止响应丢失、实例已移除后的核实及人工动作幂等；当前严格 pre-GET 的缺席只表示未知，不把第二次空查询变成首次停止证明。审计剩余直接运行时／重试入口，完成直接创建的确认、依赖／仓库／策略收尾、回滚及 HTTP／WS 版本 DTO。
3. 完成真实宿主二进制＋模拟 CLI 子进程／实际 Git checkout、停止／重启、并发恢复和严格 Done 负例；服务对象、模拟目录、HTTP 控制服务替身和生产形状事件均不能替代完整验收。
4. 按原范围继续 02–04：有界投影与已提交刷新、桌面／手机工作台、卡片关系及人工恢复。生产构造器继续关闭。

01 继续 in_progress，02–04 pending，目标 active。未调用真实模型／API／CLI 额度，未动原实例／Qlik、全局设置、跨机器、子代理、生产切换、提交推送或公开发布；旧插件包没有重打包。

### 2026-10-19 第十一检查点：资源核验与当前领取的专用原子终结

本回合有实际实现和验证进展，不是阻塞或仅等待。HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40；目标范围、严格 Done 和生产关闭边界不变。

- 原生任务仓储新增 `CheckPoolExecutionQuiescentTx`：同一写事务核对确切 task／session／turn／Profile／Worktree、已结束回合、可识别的非活动会话状态、任意残留 executors_running、其他活动池运行／会话／回合，以及 Office 所有的 checkout_agent_id／checkout_run_id／checkout_at 全部空闲。缺列或未知不能当作已释放；方法不补列、不删除清单、不清 checkout、不修改主卡。
- 测试发现旧共享运行夹具按 Office→Task 初始化时，原生 Task 表重建会丢失 Office 所有的 checkout 列。本段新增资源夹具按真实顺序再调用实际 Office schema 所有者，不用测试私有 ALTER 或放宽生产查询模拟缺列成功；缺列在生产路径仍失败关闭。本段没有修改既有 schema 历史或升级夹具。
- `lifecycle.Manager.CheckExecutionQuiescent` 只读核对真实内存执行、session 索引、同任务执行及原生活动所有权，缺协调器拒绝。实测原生 Add 允许无 session 的任务执行，既有 ListExecutionsForTask 会过滤它；新增负例先复现误放行，再改为同一个 store 读锁下核对完整占用，避免遗漏未索引执行。它必须与持久停止事实配合，不把缺记录当停止证明。
- `WithPoolExecutionQuiescence` 复用 lifecycle→task 锁顺序、启动准备计数及 LSP 租约检查，真实运行时能力由 lifecycleAdapter 转发。普通调用不能等待停止调用者持有的生命周期锁；只有受原生关闭所有者管理的后续工作能作可取消的锁等待。资源、证据或准备状态拒绝后不重试提供商动作、清理资源或重新派发。
- `FinalizeStoppedPoolRun` 在同一原生写事务核对当前唯一 ledger claim、运行／批准绑定、唯一意图／分配及匹配的 `pool.execution-stopped.v1`（活动释放必须 true），并复核数据库占用。原子提交 runs.status=finished、outcome=pool_execution_stopped、finished_at 和新的 `pool.execution-finished.v1`；回执引用停止序号，不补造开工、提供商 operation 或回合结果。该终态只结束本次领取，不表示任务验收成功。
- 当前无矛盾且仍空闲时，相同身份的重复／8 并发终结返回同一序号和时间。旧 claim、缺失／歧义账本、缺证明、残留资源、矛盾运行终态或历史回执均拒绝。事务提交故障返回 nil／error，运行和回执整体回滚。通用 FinishRun 等池隔离保护保留；旧停止记录 false 不被覆盖成 true，另行人工核实仍待工单 04。
- 确认停止后，先同步保存停止事实，再由已有后台工作所有者执行原生 stopped 收尾和一次终结核验。收尾复用 cancel guard 的 LockContext；释放该 guard 后才等待 lifecycle，不反转锁顺序，不在事件发布者持锁时同步等待。两种等待在宿主关闭时取消并排空，没有新队列、后台调度器或常驻模型；普通非池 stopped 行为保持原状。
- 服务级集成使用同一真实队列／任务／协调器／总线，加模拟提供商和真实 lifecycle 内存占用检查，已产生七类记录并结束同一个 run。模拟提供商显式卸载自己的执行，原生数据库清单用 DeleteExecutorRunningIfCurrent 条件移除；停止输入仍是生产形状模拟事件，不能冒称同一真实 CLI 子进程／Git checkout／宿主二进制闭环。终结前后主卡相同，原生严格 Done 仍拒绝直接完成。

行为 RED 已观察到：缺少原生数据库／内存核验能力、专用终结入口及真实适配器转发，未索引任务执行被误判空闲，以及停止事件没有交给受控后续收尾。编译时的仓储接口／互斥锁类型错误、测试账本列名错误均在继续前纠正，不计为行为 RED。此前准入 RED 的输出未保留，不将其单独计为已观察结果。

验证结果（Go 均使用隔离工具链、-trimpath 和 -race）：

- 沿用第十检查点十一包受影响组，退出 0；包含全部 TestPool*、严格 Done、共享队列／流程、Watcher、协议与后端共享夹具。原生任务仓储 37 个固定账本／流程用例加 TestPool* 退出 0（15.436s）。
- 根协调器准入固定名称现为 213，加 Start／Prepare／Resume／Prompt 及 HandleAgentStopped 前缀，退出 0（49.964s）。只统计本包文件，不把 Watcher 用例混入根包。
- 原生停止／活动 55 个固定用例退出 0（3.167s）；整包 runs/repository/sqlite 退出 0（12.957s）。改动了共享后台工作包装后，额外运行 event_handlers_agent_error_test.go、execution_teardown_ownership_test.go、background_work_accounting_test.go 的 57 个固定测试，退出 0（3.071s）。
- 最后测试夹具修改后，单独重跑 backendapp 的全部池／共享夹具组，退出 0（7.241s）；终结服务组含新增重放及存储能力负例退出 0（7.384s）。新增原生停止→终结＋严格 Done 集成正例及原消费者负对照退出 0（3.307s）。PG 拒绝测试已添加；KANDEV_TEST_POSTGRES_DSN 未配置，实际报告 SKIP，不计为 PG 行为验证。
- SQLguard 退出 0。storeconformance 首次退出 1（46.505s），输出被截断，不从该截断输出归因；随后有界输出复跑退出 1（38.040s）：9 个失败节点（包含父层），实际可见为 storage 四类场景的 temporary artifact absolute path 校验、sqlite.sql／postgres.sql 两份升级 checksum，以及 PreviousStableUpgrade 的同类路径失败。相关 conformance／runs/scheduler 路径相对 HEAD 无差异；未修改夹具，也未声称已在干净基线上重跑证实全部归因。
- 内部目录验证通过：349 decisions／1343 specifications。全局规格 lint 仍退出 1，完整捕获后统计为 107 条 file-size、本功能 0、其他规则 0；主设计现 32025 bytes，未超过 32768 上限。按文档维护规则仅更新内部设计、此工单与后端指引，不开放或宣传生产入口。gofmt／diff 空白最终核对另见本检查点收尾记录。

本段未重跑生命周期整包、Office 整包或旧调度器 100ms 门槛；第十检查点及更早的这些失败不能被上述定向通过覆盖，也不能报告全仓全绿。golangci-lint 尚未安装，本段没有声称执行过它。

下一段：

1. 审计剩余直接运行时／重试入口，完成直接创建的确认与提交前依赖／仓库／策略收尾及 HTTP／WS 版本 DTO，不绕过原生启动守卫。
2. 补真实宿主二进制＋模拟 CLI 子进程／实际 Git checkout、停止／重启及严格 Done 负例；特别核对停止响应丢失、旧停止释放字段为 false、当前资源重新占用时的未知与恢复。普通服务对象和模拟事件不能代替这些验收。
3. 按原范围继续 02–04：有界投影／已提交刷新、桌面和手机、卡片关系及版本化幂等人工恢复。专用终结的当前空闲重放不是全部人工恢复操作幂等完成。

01 仍 in_progress，02–04 pending，目标 active。没有调用真实模型／API／CLI 额度，未改原实例／Qlik、生产构造开关、全局设置、跨机器或子代理，未提交、推送、发布或重打包旧插件。

第十一检查点收尾：24 份本回合 Go 文件的 gofmt -l 无输出，git diff --check 退出 0。内部设计／工单与后端指引已同步；这些校验不代替 golangci-lint、全仓测试或完整宿主验收。

### 2026-10-19 第十二检查点：移动确认的 HTTP／WebSocket 接线与浏览器契约

上一回合及本回合都有实现／验证进展，不是阻塞或仅等待。HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40；01 in_progress，02–04 pending，目标 active，完整范围保留。

- 两个原生移动请求增加可选 pool_release，原样交给已有 MoveTaskOptions.PoolRelease：只接收明确额度确认及预期任务／阶段版本，不接受 actor、Agent、run、claim 或时间权威。PoolReleaseConfirmation 的统一严格 JSON 解码拒绝未知／错误类型字段，返回固定错误，不回显请求内容。
- 复用现有原生事务及真人上下文，不另写批准或派发表。HTTP／WS 的确认／版本冲突返回 409 和固定领域代码；发布能力或共同准入未注入返回 503。Token、合成身份和外部用户不能借请求字段替代真人批准。省略字段的普通流程移动保持原行为。
- 新入口夹具使用真实 settings／task／workflow／Office／runs schema 所有者、任务服务及原生准入协调器。合法 HTTP／WS 请求提交实际 pool_release_v1 账本及真实 actor；随后显式调用原生 PublishPoolRelease，以同一真实 entry 身份产生共享队列一行。这里没有启动自动生产者、消费者或模型；直接调用处理器并注入已认证上下文，也不等于完整 HTTP 登录／网关／宿主二进制闭环。
- 浏览器 moveTask 原发送逻辑已能透传可选字段，因此没有重写发送器。只补可选类型和契约测试：保留原始纳秒版本字符串，不补造 Agent／派发时间，普通请求仍不带批准。没有界面、状态缓存或恢复行为变更。
- 真正的直接创建仍未接。源码再次确认 Repository.createTask 在自身提交后同步 dispatchStepEntry，且会保留上下文；Service.finalizeCreatedTask 随后才添加依赖、仓库关系及工作区策略。不能只给 Create DTO 加字段或只持任务锁就开放池生产者。下段必须连同 HTTP／WS 的必要创建收尾及错误回滚验证，先证明不会在资料补齐前入队；原生 external_id_settled_at 等既有创建完成契约可作为待核对的复用候选，尚未作为设计决定或完成项。

行为 RED 已观察：合法 HTTP／WS 确认字段被丢弃，未产生批准；额外自报身份被默默接受；版本／能力错误变成通用错误或错误状态。最初预条件组有一项因 SQLite 报 database or disk is full 而未到断言，不计为行为 RED。随后空间快查约 4.1 GiB 可用，完整新组通过；未清理缓存、模块或用户数据，保留该次环境故障记录。

验证（Go 使用既有隔离环境，均带 -trimpath／-race；串行构建使用 -p=1）：

- 全部新状态入口用例：go test -trimpath -race -p=1 ./internal/task/handlers -run '^TestPoolMoveWire' -count=1 -timeout=4m，退出 0（39.877s）。覆盖合法批准／入队、未知字段、版本、未启用、身份拒绝和普通移动；之后补的逐字段严格解析契约用 -run '^TestPoolMoveWireConfirmationSchema' 单独验证，退出 0（1.163s）。两次均在最后生产逻辑修改后。
- task/service 的 TestPool／MoveTask／StrictCompletion／WorkflowChange／CreateTaskRejectsIncompatibleWorkflowOverride 组退出 0（6.193s）。
- 处理器整包 go test -trimpath -race -p=1 ./internal/task/handlers -count=1 -timeout=5m 退出 1（95.350s），16 个失败节点（含父层），并非全绿。可见失败涉及 Cursor 模拟登录终端、Gitflow、仓库路径／发现／初始化、fresh-branch 和仓库替换，部分明确为 EvalSymlinks／路径 Access is denied；没有在干净 HEAD 重跑，不能一概宣称旧基线。
- 针对 TestHTTPInitializeLocalRepositoryCreatesRepository 做最小权限对照：改用隔离副本内独立 TMP 仍在 EvalSymlinks 失败；经批准的宿主执行已越过该检查，但深目录导致 Git Filename too long。改回系统自身的隔离临时目录、同一宿主用例退出 0（1.660s）。这只确认该单例的原访问拒绝来自沙箱，不能推及其他整包失败；未修改产品路径校验、全局 Git 或系统设置，也不是完整 Worktree／模拟 CLI 验收。
- 浏览器两份 API 测试共 19 项通过；最后格式化后再次通过，tsc --noEmit 退出 0。目标 ESLint、Prettier --check 均退出 0。实际使用已有 Node 24 和本地 Vitest／TypeScript／ESLint／Prettier CLI；默认 pnpm 包装器误走依赖检查并失败后没有继续安装／清理模块，package.json 和 pnpm-lock.yaml 没有变化。
- 10 份 Go 文件 gofmt -l 无输出，git diff --check 退出 0；内部目录验证 349 decisions／1343 specifications 通过。内部设计和后端指引同步移动接线边界，不宣传或开放生产使用。没有生产 SQL／schema 改动，本段不重复跑未变的 SQLguard／storeconformance，不把第十一检查点的存储失败覆盖为通过。

本回合检索曾混用 web／backend 相对路径，已改为分目录核对；一次工具缓存目录扫描未保留句柄，后续进程检查确认已无 rg 进程，不凭此重启扫描或声称任何测试完成。后续只定位必要的本地工具，不扫描整个 Go 缓存。

下一段按完整原范围推进：先实现并证明直接创建的安全收尾／回滚，审计剩余直接运行时与重试入口，再做真实宿主二进制＋模拟 CLI／Git／停止重启及严格 Done 负例；随后继续 02–04 的有界投影、已提交刷新、桌面／手机、卡片关系和版本化人工恢复。新界面仍未实现，生产队列接线保持关闭。未启动被接入的真实模型／CLI／API 任务，未改原实例／Qlik、全局设置、跨机器或子代理，未提交、推送或公开发布。

第十二检查点收尾：主设计 32186 bytes；规格 lint 完整捕获统计仍为 107 条 file-size，本功能 0、其他规则 0。目录验证与空白检查通过；不将整包失败、旧存储失败或尚未执行的宿主闭环改称通过。

### 2026-10-19 第十三检查点：直接创建的原生分段批准与真实进入身份

本回合有实际实现和验证进展，不是阻塞或仅等待。HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40；01 in_progress，02–04 pending，目标 active，完整范围保留。

- HTTP／WS 创建接收同一严格 pool_release 确认。直接创建的 expected_resource_version 必须为空，阶段版本保持原始精度；普通非池创建沿原行为，池创建与普通立即／延迟启动意图不能混用。显式执行选择仍由真实 CLI／Worktree 能力及原生事务检查，不把请求值当能力证明。
- 复用原生任务创建和阶段账本，不新增表或调度器。初次池插入以内部 DeferCreation 意图暂不写批准／触发阶段回调；依赖、仓库和策略仍走原服务收尾。HTTP 在附件、fresh-branch 等必要工作后，WS 在池文件附件绑定后，调用 CompleteTaskCreation。
- 收尾许可仅在真实创建结果内部，绑定原卡片版本、阶段版本／Profile 身份和创建者浏览器。提交复用共同准入及 SQLite 写权，重查当前版本、尚无进入账本、依赖和占用，再原子写 pool_release_v1 与外部身份结算。结算必须确实影响一行，零行写入也回滚批准。并行编辑、身份释放、中断或结果不明不重建许可；既有外部身份 Found 仍最早短路，不重跑收尾／派发。
- 真实仓储阶段回调暴露此前的身份契约缺口：原生 formatEntryID 返回十进制字符串，发布器先前只接受测试中的 entry: 固定宽度格式。现在接受规范原生格式并兼容旧拼写，二者使用同一整数来源与稳定派发键；非规范拼写／旧账本／跨任务身份仍拒绝。新增正例通过真实仓储回调、池发布器和共享队列产生一行，不再手动转换 entry 后冒称原生回调已通。
- 内部设计拆出[创建批准契约](../../specs/tasks/system-design/agent-pool-creation-release.md)，主设计和后端指引同步；浏览器只补可选创建类型及契约测试，原发送器无须重写。没有工作台 UI 或生产接线变更。

已观察到的行为 RED：确认被丢弃；原生十进制进入身份被拒绝；WS 在附件未绑定时派发；私有收尾许可可换浏览器使用；结算零行写入仍返回成功并批准。首次附件负例返回 500，原因是夹具未配置真实附件服务；补齐原生构造后才验证预期的 404，不把夹具失配算作产品缺陷。没有放宽产品路径或严格 Done 门禁来获得通过。

验证（Go 使用隔离工具链、-trimpath／-race／-p=1）：

- 创建／移动入口组退出 0（156.340s）；该次在最后的浏览器绑定及结算检查前。之后两条新 RED 分别修复并通过；最终把结算检查机械提取为同事务私有 helper 后，全部 TestPoolCreateWire 再次退出 0（69.775s），覆盖 13 个顶层测试及其子场景。
- task/service 的 TestPool／CreateTask／MoveTask／StrictCompletion／WorkflowChange 扩大组在沙箱退出 1（14.388s），唯一可见失败为默认分支探测中的仓库路径 Access is denied。同单例沙箱复核退出 1（1.041s），经批准的宿主权限单例退出 0（1.945s）；宿主同一扩大组退出 0（11.392s）。服务组包含新增两种进入身份去重的回归。
- task/repository/sqlite 的 TestPool／StepEntry／StepTransition／CreateTask／StrictCompletion 组退出 0（26.791s）。SQLguard 对 internal 的完整扫描退出 0，包括最后 helper 提取之后；sqlguard 分析器整包测试退出 0（1.065s）。
- 经批准的宿主权限处理器整包退出 1（254.022s），仅报告 CursorMCPAuthenticateAfterCompletedTerminalReconnectStartsFreshLogin 的模拟标记未写入，以及 ConfirmHomeDiscoveryHTTPUsesBackendHomeAndIsIdempotent 的 HOME JSON 路径断言两项失败。没有修改这两份测试或相应策略；它们及 storeconformance 路径相对 HEAD 无差异，但没有干净 HEAD 全包复现，不宣称全部属于旧基线。该整包在机械提取 helper 前启动，提取后的创建入口组另有上述最终通过，不能把它写成最终整包全绿。
- storeconformance 退出 1（36.100s）：storage 临时产物绝对路径校验的四类场景、升级夹具 sqlite.sql／postgres.sql 的 checksum，以及 PreviousStableUpgrade 仍失败；未修改这些夹具或校验规则。KANDEV_TEST_POSTGRES_DSN 未配置，没有实际 PostgreSQL 行为验证。
- 浏览器两份 API 测试共 21 项通过；tsc --noEmit、目标 ESLint、Prettier --check 均退出 0。18 份本回合 Go 文件 gofmt -l 无输出，git diff --check 退出 0；未安装或声称运行 golangci-lint。目录验证为 349 decisions／1344 specifications；规格 lint 仍为 107 条 file-size，本功能 0、其他规则 0。主设计 32238 bytes，新创建契约 5844 bytes，均未越过规格大小上限。

下一段保留完整目标：继续审计剩余直接执行／运行时入口及组合配置；直接创建的接口／仓储收尾已接，不等于真实 Git／宿主中断验收完成。随后做真实宿主二进制＋模拟 CLI／Git checkout、停止／重启及严格 Done 负例，再按计划继续 02–04 的有界投影、已提交刷新、桌面／手机、关联和版本化人工恢复。服务对象或处理器重建、模拟事件不能替代二进制／CLI 闭环。

本轮未触发被接入的真实模型／CLI／API 任务，未修改原实例／Qlik、全局设置、跨机器或子代理，未提交、推送、公开发布或重打包插件。生产池发布／消费构造仍关闭；失败检查、原始范围和未完成项继续保留。

### 2026-10-19 第十四检查点：真实模拟宿主、停止恢复载体和二进制重启

本回合有实际实现与验证进展，不是阻塞或仅等待。HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40；01 in_progress，02–04 pending，目标 active，完整范围保留。

- 新增显式二进制验收夹具：新编译私有 kandev／agentctl／mock-agent，使用独立临时 HOME、数据库、真实 Git 仓库和 Worktree；清除继承的模型凭据及配置。先检查每实例 nonce 的健康归属及 readiness，再通过真实登录、设置 interlock 和 HTTP 创建。未触碰原实例、真实提供商或全局 Git。停止用真实原生 WebSocket 消息，不由夹具写运行终态。
- 最初真实宿主的池创建返回 503，确认原生来源／队列尚未构造注入。现仅在既有 KANDEV_E2E_MOCK=true 且 KANDEV_MOCK_AGENT=only 的组合中连接原生发布、准入、守卫和同一共享消费者；默认及混合真实提供商仍关闭。没有新增生产开关、队列或调度器。七个关闭分支验证在触碰服务前返回。
- 正例使用 claude-acp 的实际 mock-agent CLI 子进程；真实 trace PID、Git worktree list、唯一 office_launch_ledger、原生 run 与事件证明实际执行，非模拟目录或人工补写回执。七类池事件包含启动意图、执行分配、绑定、工作活动、回合结束、实际停止与专用终结；finished 的 stopped_seq 精确引用停止记录。Codex 传输已有前段测试，本轮未执行其宿主二进制正例，也没有真实 Claude／Codex 调用。
- 实际停止曾保留六类记录但不能终结。定位到原生 lifecycle 故意保留 stopped 的 executors_running 作为恢复载体；原“存在任何行即占用”的池检查与此冲突。修复仅允许精确 task／session／execution、合法 Profile／Worktree／runtime、PID 清空的唯一 stopped 行；不删除或改写恢复行。缺停止回执、释放字段 false、当前物理资源忙、替换执行、非停止状态、未知 runtime、错误身份和多行仍拒绝。
- 真实停止后，私有宿主运行终结；随后关闭本测试拥有的宿主并启动同数据的新 PID。原生登录仍有效，external_id 创建重放返回原卡，领取／事件／时间保持不变，没有增加 mock-agent PID，恢复载体及令牌摘要也保持不变。缺交付回执的 Done 请求仍返回 409。严格检查沿实际 Node／check-delivery.mjs，但 pool-host-pending 是未安装身份，因此只算拒绝证明，不是插件正例验收。
- 内部契约拆出[执行终结设计](../../specs/tasks/system-design/agent-pool-execution-retirement.md)，并更新主设计、计划和后端指引。检索公开文档、README 及截图目录无本池能力说明，本段不发布或宣传尚未开放的功能。主设计同步修正原生十进制 entry 与旧固定宽度格式的兼容描述。

行为 RED：真实池创建 503；真实停止后因合法恢复载体无法终结；新增服务正例也在该边界拒绝。初次 profile 响应形状、启动意图嵌套身份、trace 字符串 PID 的夹具失配不算产品 RED；均在断言真实来源后修正，没有削弱产品门禁。

最后生产修改后的验证：

- 私有宿主编译成功。TestPoolHostNativeMock 初步闭环退出 0（15.820s）；加入真实重启、幂等重放、七类证据和恢复载体保持后，与关闭组合组一起退出 0（16.333s）。最后将历史快照改为无歧义 JSON 后，扩大组再次通过。
- Go 使用隔离工具链、-trimpath／-race／-p=1，扩大组为 internal/backendapp、internal/runs/service、internal/task/repository/sqlite、internal/task/service，匹配 TestPool／TestRepairExecutorRunningDead／TestStrictCompletion／TestRunsServiceEngineAdapter；四包均退出 0（21.135s、33.693s、5.672s、5.949s）。宿主组经批准使用宿主临时路径权限，仍只有私有模拟进程。终结专项组另退出 0（11.401s）。
- SQLguard 对 internal 完整扫描退出 0，internal/db/sqlguard 分析器整包退出 0（1.055s）。一次分析器命令误用了不存在的 internal/sqlguard 路径，属于启动失配，不是产品 RED；定位真实导入路径后执行上述有效验证。
- storeconformance 整组退出 1（37.772s）：storage 四类绝对路径校验、升级两份 SQL checksum 及 PreviousStableUpgrade 仍失败；本轮另出现 telemetry-contract 的时间戳必须严格变晚断言。仅复核该场景仍退出 1（0.191s），实际两个时间戳完全相同。conformance 目录相对 HEAD 无差异，但未做干净 HEAD 重跑，不能宣称全是旧基线，也未调整阈值或夹具。没有 PostgreSQL 行为验收。
- 文档目录验证 349 decisions／1345 specifications 通过。规格 CLI 仍退出 1；对同一完整 lint 函数的结构化汇总为 107 条且全是 file-size，本功能 0、其他规则 0。14 份 Go 文件 gofmt -l 无输出，git diff --check 退出 0；主设计 32082 bytes，终结设计 5311 bytes。没有安装或声称运行 golangci-lint。
- 两个先前会话的终端结果在上下文交接中未保留，未据此计通过；确认句柄已结束后才做上述针对性重跑。所有新验证会话已结束；精确私有路径进程盘点没有残留宿主／agentctl／mock-agent。

剩余工作：agent.launch 已登记并调用原生 Launch，但它只准备运行时，源码明确须另调用 StartAgentProcess 才启动模型；不能冒称已证明模型绕过，仍需核对资源准备与共同准入。未发现 legacy EnqueueTask 的外部生产调用。继续完成这些剩余入口及中断／响应丢失边界，再按原计划做 02 的有界投影和已提交刷新、03 的桌面／手机及卡片关系、04 的版本化幂等人工恢复。当前正常模拟终结和重启不等于恢复工单完成。

本轮未调用真实模型／API／计费 CLI，未修改原实例／Qlik、全局设置、跨机器或子代理，未提交、推送、公开发布或重打包插件。生产池能力仍关闭，已有整包失败和全目标剩余范围继续保留。

### 2026-10-19 第十五检查点：独立准备准入与投影 TDD 起点

本回合有实际代码及验证进展。HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40，目标 active；01 的验证收尾继续保留，02 已按本工单提供的真实 attempt 输入进入只读实现，03–04 pending。没有将模拟闭环缩成全目标完成，也没有提前开放生产。

- 真实宿主的 agent.launch 调用确实到达原生准备，但旧 DTO 没有 session_id，随后在持久化层拒绝并回滚。最初断言期望池占用早拒绝，实际却收到 persist execution registration: session_id is required，因此缺少资源准备前的池准入已被定位；这不是重复模型启动证明。没有为旧入口补 session 或实现另一套执行通路。
- 新增原生 WithTaskPreparation：先授权、再调用已有 beginPoolTaskStart，回调期间持有既有准备引用而不持任务写锁，成功／错误／取消均释放。Agent Controller 的窄 TaskPreparationAdmission 由真实 gateway 构造连接同一协调器。未配置本池时仍走普通原生准备；已 queued／claimed 的本池任务在实际资源 I/O 前拒绝。
- 真实二进制测试继续覆盖七类回执、严格 Done 409、停止、恢复载体、重启和幂等重放；新增原生 WS agent.launch 的池占用拒绝以及终结后保留旧会话约束错误的对照，均没有增加模型进程。测试 helper 共用实际 cookie／Origin 的 WS 发送器；停止 ACK 仍不是停止事实。
- 协调器新增三类回归：拒绝先于回调／保留原错误和默认路径；准备未退出时新批准拒绝、取消后释放；授权先于池读取。并发使用 channel，同步退出测试拥有的 goroutine，没有睡眠竞态。接口缺失组先出现真实断言 RED（非编译失败），随后实现并通过。
- 当前实际模型进程启动调用链已核对：任务执行／恢复走既有协调器接缝，模型切换从 promptTask 的守卫路径进入。agent.stdin 只写原生 passthrough PTY，本池不接纳此类 Profile。通用 Office 运行使用独立 run owner；公开 orchestrator.queue 是 wsGetQueue 只读，不是 legacy EnqueueTask 的调用。未发现后者的外部生产调用，不据此删除或开放它。

验证（隔离工具链，-trimpath／-race／-p=1）：

- TestPoolDirectPreparation 退出 0（1.224s）。重建私有宿主后，TestPoolHostNativeMock 退出 0（18.391s）。
- 最后生产修改后，backendapp 与 orchestrator 的 TestPool／TestSessionKeyedEntryPointsGuardBeforeDependencies／Test.*TaskAccess／Test.*SessionAccess 扩大组均退出 0（20.203s、2.842s），包含上述新回归及原池接缝。agent/controller 没有测试文件；同命令 agent/handlers 的筛选没有匹配测试，不将其退出 0 当作直接单测覆盖。新入口的实际处理器行为由上述真实 WS 宿主验证。
- 本轮没有持久化产品 SQL、schema 或存储契约改动，不重跑第十四检查点未变的存储整组；其路径／checksum／时间戳失败继续存在，不能改称全绿。没有 PostgreSQL 或 golangci-lint 验收。
- 9 份 Go 文件 gofmt -l 无输出，git diff --check 退出 0。目录验证 349 decisions／1345 specifications 通过；同一完整规格 lint 的汇总仍为 107 个 file-size，本功能 0、其他规则 0。主设计 32139 bytes，终结设计 6613 bytes。
- 相关验证句柄均已终结；精确私有路径检查没有残留 kandev／agentctl／mock-agent。未按观察超时或旧输出重启任何仍运行的句柄。

工单 02 起点：新增 pool_history_test.go，使用原生 TaskHandlers.registerHTTP 和真实 schema／发布器夹具定义无记录、已批准与已入队区分、50 项界限、错误游标、权限及读取不写源事实的 HTTP 契约。有效请求目前 404（预期 200），错误分页目前 404（预期 400）；有效 RED 退出 1（7.162s），端点尚未实现。初次发布器双返回签名误用只造成编译失败，不算 RED；修正后才得到上述断言。越权／缺失都 404 不能在缺路由时充当权限验收，后续必须随合法正例再次验证。

下一段直接实现 02 的有界原生历史快照、权限与 HTTP 接线，不再停留于 01 的状态复述；列表、摘要／刷新、桌面／手机、卡片关系及版本化人工恢复完整保留。01 的中断／响应丢失与异常资源验证继续作为验收欠项，和 04 的恢复场景联动，不因此开放生产者。

按文档维护规范更新了内部设计、计划和后端指引。公开 WebSocket 参考仅列既有低层控制；本池仍只接模拟组合，未新增公开配置或宣传未开放的生产能力。没有调用真实模型／计费 CLI／API，未改原实例／Qlik或全局设置，未创建子代理、跨机器任务、提交／推送／发布或插件包。
