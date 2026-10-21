---
status: current
system: tasks
created: 2026-10-16
owners:
  - ai-fleet-kanban
requirements:
  - REQ-TASKS-AGENT-POOL-001
  - REQ-TASKS-AGENT-POOL-002
  - REQ-TASKS-AGENT-POOL-003
  - REQ-TASKS-AGENT-POOL-004
  - REQ-TASKS-AGENT-POOL-005
---

# Agent 任务池工作台技术设计

## 边界与依据

以固定 Kandev v0.97.0 / `e43881c7555372897b57ec51c705f1e05da43c40` 加严格验收补丁为基线。当前隔离副本可作 mock-only 试用；准确验收范围见工单结果，不能将模拟可操作等同真实模型或生产可用。

当前实现已覆盖原生派发／领取／开工、A 清理凭证、有界投影、桌面／手机及版本化人工恢复；结果统一见[隔离交付核对](../../../plans/agent-pool-workbench/acceptance-audit.md)。下文带日期的接缝检查点保留实现过程，其中“尚未”描述当时状态；正式生产组合和真实提供商仍未开放。

任务系统拥有任务级发布、执行关联与可见状态。共享队列归 `internal/runs`；Office 仍拥有其自主策略，插件仍只通过公开边界访问。沿用 [共享运行设计](run-scheduling.md) 和 [本次决策](../../../decisions/2026-10-16-agent-pool-native-run-authority.md)，不建第二任务库、调度器或任务编号体系。

### 当前来源及缺口

| 当前已核对的来源 | 复用方式 | 不能推断的事情 |
| --- | --- | --- |
| `internal/runs/service.Service.QueueRunAndReturn` | 原生入队、幂等和唤醒；区分 queued / deduped / coalesced / rate_limited | 去重或合并返回的空行不是新运行成功回执 |
| `internal/runs/repository/sqlite.ClaimNextEligibleRun`、`commitClaim` | 保留并发限额与 CAS，领取时同事务写 `office_launch_ledger` | 领取不等于提示已被执行 |
| `internal/runs/models.Run` | 请求时间、真实 Agent、会话、状态、重试资料 | `claimed_at` 在恢复时会清空，不是不可变历史 |
| `internal/runs/scheduler.Scheduler` | 使用唯一消费者；不增加每工作区计时器 | 所有 Profile 都已跑过 CLI 端到端验收 |
| `internal/office/scheduler.persistLaunchedSession` | 复用成功启动后的会话绑定 | 当前为尽力写入，失败时不能自动补造开工 |
| `internal/task/statussummary` | 复用有界投影、最近活动、待处理、完成门禁 | 任务级最近活动不是本次领取的心跳 |
| `TaskCardTags`、`TaskCardIndicators`、原生依赖与父子关系 | 保留卡片及导航，增加低噪声摘要 | 不新增独立的关系图数据库 |

现有 `RecoverStale` 会把过期 claimed 重置为 queued；不能把“界面不重试”误写成“后端不重试”。本设计在该入口明确排除本池模糊执行。`AppendRunEvent` 当前是独立查序号再插入，也不能仅凭注释视为原子去重；本池回执需要事务内追加辅助方法。

## 需求映射

| 需求 | 对应设计 |
| --- | --- |
| REQ-TASKS-AGENT-POOL-001 | 受控发布、单一执行权 |
| REQ-TASKS-AGENT-POOL-002 | 身份与时间、开工证据、历史与读取 |
| REQ-TASKS-AGENT-POOL-003 | 桌面与手机、读视图及权限 |
| REQ-TASKS-AGENT-POOL-004 | 单卡与关系 |
| REQ-TASKS-AGENT-POOL-005 | 恢复、身份与验收边界 |

## 受控发布与单一执行权

1. 由操作员通过原生工作流导入／配置选定试点流程：待办 → 方案确认 → 实施 → 独立审查 → 人工验收 → 完成。方案及最终验收由人处理。
2. “批准并入池”沿用原生阶段移动与权限／依赖／WIP 检查。可执行阶段仅配置一个带版本化池标记的 `queue_run`；同阶段不能再有 `auto_start_agent` 或其他并行启动动作。配置歧义拒绝，不猜优先级。
   首版在原生创建／移动准入中要求真实登录操作者的显式池发布确认，并校验预期任务版本；Agent、系统事件或匿名合成身份不能借移动／直接创建可执行阶段冒充人批准。确认通过后由现有阶段转换账本记录真实 actor。没有确认的动作在提交前拒绝，不先移动后留下无法启动的卡。普通非池流程保持原行为。
3. 扩展既有 `QueueRunCallback` 到共享队列的接缝，宿主从已提交的阶段进入记录解析工作区、任务、阶段进入身份和固定执行配置，不接受浏览器自报这些绑定。代码目录仍沿用原生队列，拟新增的 `pool_dispatch.go` 仅负责本池的准入／身份封装。
4. 拟议键前缀为 `pool-dispatch:v1:`，摘要输入是工作区、任务和本次阶段进入身份。它是只由宿主生成的保留命名空间，不从客户端接收键。首次选定的 Profile 写入快照；同键但绑定不同返回冲突，不能静默换执行者。
5. 本池生产者在既有队列上禁用此次通知合并，复用原有幂等唯一约束；不得误用父任务完成的 WakeWaveKey。重放同次进入不造第二行；退出再进入是新阶段身份，但必须先确认上一轮已终结。
6. 原生交互启动与本池领取共享任务启动准入：池内有 queued / claimed 或未确认终结的执行时，手动 Start 返回冲突并提供当前运行链接。启动准入与池发布按既有任务锁顺序串行，不能仅在前端禁用按钮。

首版按阶段固定 Claude 实施、Codex 审查，不新增“智能挑 Agent”模型。符合资格的工作由原生调度器自动领取；这实现受控任务池，而不是外部 CLI 自行轮询。普通手工任务不自动变为池任务，不要求启用 Office 自主功能。

2026-10-18 接缝复核：普通 CLI Profile 的 `workspace_id` 为空，现有 Office 消费策略会将其判为不可解析并取消。按同一队列／消费者边界，新增 `SetPoolRunProcessor` 构造期注入接缝，在 Office 策略之前仅分流宿主标记的池运行，将 `ClaimedRun` 交给 tasks 所有的适配器；不放宽 Office 查询或把普通 Profile 改成 Office 身份。当前同消费者接缝、可信发布器及任务服务／引擎适配已有测试。生产构造器尚未注入发布来源／队列或消费者处理器，通用入队继续拒绝保留池键。真人请求确认、CLI／Worktree 能力、共同启动准入、运行时及恢复保护接齐前不可开放。

### 原生提交准入的具体契约

池标记采用原生 `queue_run` 的 `config.pool_version: 1`，目标只允许本任务的固定主 Profile（省略值或 `target: primary`、`task_id: this`）；本池不接受动作 payload 覆盖。一个阶段只能有这一份启动动作，不能同时自动开始、发起代码审查、参与者扇出或由其他触发器再次入队。未知版本／歧义不降级为普通任务。`WorkflowStep.PoolExecutionProfile` 统一校验这一配置；引擎保留 `PoolMarked`，专用发布器未就绪时明确拒绝，不走普通 queue_run 回退。

宿主构造 `PoolReleaseIntent`，绑定 task／workspace／workflow／step、额度确认、预期任务版本及阶段版本／Profile。浏览器不授予 actor、Agent 或时刻权威；仅真实浏览器登录会话可以批准，synthetic、Agent、PAT 和系统归因不可以。事务读取旧任务时核对版本；已处目标阶段即拒绝旧确认，不依赖时钟一定前进。提交账本前再核对身份、配置、工作区、WIP 及任务资格；失败全部回滚。已持久化派发的幂等发布仍读取原运行。

只有该检查通过的阶段转换，才由宿主将原生账本 trigger 派生为 `pool_release_v1`；保留实际 human actor，不接受调用者直接声明此证明。普通 `manual_move` 或 `task_created` 的历史事实不构成入池批准。没有新增表或改变既有 collection contract 版本；这是原生 trigger 的新增值。

`LoadPoolRelease` 从同一只读快照读取当前任务、最新的这份明确确认账本及固定阶段配置，返回 `PoolReleaseSnapshot`。旧阶段、跨任务记录、未获 WIP 准入或确认后变化的配置不能被猜测成可派发；配置的 `updated_at` 晚于批准记录时需重新核实，不能偷偷使用新的执行者。提交门禁／来源读取、可信发布器及移动请求确认已测；直接创建接线见下文，完整宿主验收及人工恢复尚未接齐，不代表可开放试点。

### 可信派发的具体契约

`task/service.PublishPoolRelease(ctx, taskID, stepID, entryIdentity)` 只由宿主原生阶段回调使用。先复用任务写权限，将规范原生十进制 entry 或兼容的旧 `entry:%020d` 拼写解析到同一整数，再核对当前批准来源并调用共享队列；结果必须是 queued／deduped 及同一真实绑定行，空／合并／限流或错误绑定均不能报告成功。引擎的 `PoolQueueRequest` 只传 task／step／entry，不转发动作 payload 中的 actor、Agent、领取者或时刻。

`runs/service.QueuePoolRunAndReturn(ctx, taskID, entryID)` 在原生队列写事务中预留 SQLite 写权，调用任务来源的 `LoadPoolReleaseTx`。稳定键是 `pool-dispatch:v1:` 加 SHA256，摘要输入为 JSON 数组 `[workspace_id, task_id, entry_id]`，数组保留字符串边界。固定 Profile、真人 actor 和批准时间进入原生 run payload；入队时间仍来自原生 `runs.requested_at`，不从批准时间推算。

同键查询不使用通知的 24 小时快查窗，最多读取两行；多解拒绝，不挑第一行。已有行须与当前批准及原生列绑定一致，保留原运行和时间、不再发信号。首次发布才检查同卡 queued／claimed 池运行及原生前置任务，再复用原生因果准入和插入；只有事务提交后发布原生事件并发信号。跨 Profile 占用同样阻塞，缺失前置保留为未知／阻塞而非自动删边。本文的同卡队列检查不代替尚待完成的交互 Start 共同准入。

`PoolReleaseSnapshot.DispatchKey` 与 `MatchesRun` 由队列和任务服务共用。生产构造仍不注入发布来源／队列；仅既有 mock-only E2E 组合接通共享消费者，见[宿主验收边界](agent-pool-execution-retirement.md)。实际开放还须满足[工单 01](../../../plans/agent-pool-workbench/task-01-native-dispatch-receipts.md)与恢复工单的全部边界。

### 移动确认及事务资格的落地细节

移动服务接受 `MoveTaskOptions.PoolRelease`，字段仅为 `confirm_cli_quota`、`expected_resource_version`、`expected_step_version`。HTTP／WS 已将 `pool_release` 传给此选项；统一严格解析嵌套字段，不接受 actor／Agent／claim／时刻自报。宿主读取实际任务／阶段／Profile 后构造既有 `PoolReleaseIntent`，只附加到最终写入的 `moveCtx`，不传播到后续事件。确认／版本冲突返回 409 与固定领域代码，未启用能力返回 503。浏览器沿用原发送器，保留版本精度，不补造批准。普通无确认移动不能进入池阶段，非池移动保持原行为；直接创建收尾见[创建批准契约](agent-pool-creation-release.md)，生产接线仍关闭。

`PoolExecutionCandidate` 是任务系统的临时资料投影，不存另一份配置。仅支持原生注册族 `claude-acp`、`codex-acp`、`codex-app-server`，使用真实 Agent 记录 ID 与 Profile 关联，不用显示名当身份。资料必须启用、未删除、作用域匹配；不允许 API provider、自动回退、备用模型、TUI passthrough、自定义 TUI 或间接执行 Profile。执行器必须是当前有效的 Worktree；从原生任务选择或工作区默认值读取，不替用户更改设置。服务复用既有执行器解析和能力校验接缝，最终事务再次读取资料并使用同一资格规则，防止检查后变化。

原生阶段账本提交前及首次队列发布时，均在原生事务内核对依赖和当前占用：缺失／未完成的前置、queued／claimed 池运行、工作中或未知状态的会话、未结束回合都拒绝。已经等待输入且没有未完回合的会话不冒充工作中。空／未知／正在执行或终结的任务状态、损坏的元数据、不支持的执行选择、其他阶段 Profile 替换及未清除的延迟启动意图也不默认为可派发。这些数据库资料检查不等于实际运行时／checkout 停止证据，也未替代启动准备期尚无会话行时所需的共同启动准入。

直接创建采用[原生分段创建批准](agent-pool-creation-release.md)：初次提交卡片不写批准账本；依赖、仓库、策略及入口必要收尾成功后，在共同准入中复核原版本并原子提交批准与外部身份结算。中断后没有批准记录，读取或普通账本回填不能补造。已覆盖真实仓储和处理器，实际 Git／宿主中断验收仍待完成。

### 共同启动准入的落地边界

宿主协调器新增 `WithPoolReleaseAdmission`／`WithPoolEnqueueAdmission`，复用现有 `ceilingEntryAdmissionLocks`，不增加锁表、持久状态或第二调度器。显式确认移动的最终写入必须在该准入中执行；池队列也要求构造期注入同一协调器，缺接线返回 `pool_admission_unavailable`。普通无池确认的移动及通用队列不依赖新接口。

配置 `PoolTaskStartGuard` 后，原生 `startTask` 在首次任务／阶段读取前核验启动守卫并登记准备计数；同任务普通并行启动仍分别登记。准备计数持有既有锁条目的引用，不持任务锁执行读取／提供商 I/O；每次退出释放自身引用，全部退出后才解除占用。批准遇占用返回 `pool_task_start_preparing`，发布器则先核对持久身份，已有同绑定行仍可去重返回，只有新插入受准备占用阻塞。原生锁上下文已改为可失效生命周期，提交后保留的上下文不能继续冒充持锁者。

`runs.Service.CheckPoolTaskStart` 已实现真实 queued／claimed 池占用检查，返回同一卡当前运行链接，不因更换 Profile 绕过。合法池领取只能从 `StartPoolTask` 提取 `PoolClaimStart` 值，交给私有 `startTaskOptions.poolClaim`；通用上下文和普通启动参数不能签发该许可。固定 Profile、Worktree 和原生阶段 entry 沿既有启动路径保留。缺少 `PoolClaimStartGuard` 能力时在读取任务／调用提供商前失败关闭。

`AdmitPoolClaimStart` 复用同一任务准入及原生写事务，核对当前批准与 run 绑定、唯一领取账本、依赖、固定 CLI／Worktree 和原生活动。`CheckPoolClaimReadyTx` 仅排除当前运行自身，不排除其他池运行、会话或未结束回合。通过后先提交一次性的启动意图，再进入原生准备；同 claim 重放拒绝，不因服务对象重建丢失。池启动使用原生自动容量预留，但容量拒绝返回 `pool_task_capacity_unavailable`，不写普通自动重播记录、不自动回退或重入队；已登记意图保留供核实。

2026-10-19 第七检查点：`PrepareTaskSession`、私有 `startCreatedSession`、`resumeTaskSessionWithContinuation` 与 `promptTask` 已在首次原生读取前复用同一 `beginPoolTaskStart`。组合恢复并提示通过该恢复入口；各包装方法及自动复用调用不能仅因不是 StartTask 而跳过检查。四个会话入口的准备计数在各自调用退出时释放，不持任务锁等待会话／提供商 I/O；并行预检仍可进行，全部退出前不允许新批准。真实共享队列夹具验证准备被拒绝时不创建会话、不改主卡版本，无池占用时原生准备可用。这不代替对其他直接执行器／运行时入口的审计。

上述服务测试不代替宿主／Git 证明。第十四检查点已通过私有新宿主、实际模拟 CLI、Git Worktree、停止与二进制重启；第十五检查点核对任务启动调用链，独立准备也复用共同准入。证据范围见[宿主验收边界](agent-pool-execution-retirement.md)。生产实例未注入这些接缝，真实提供商、中断及人工恢复尚未验收。

## 身份、时间与开工证据

拟议逻辑派发身份 `dispatch_id` 是上述稳定键对应的运行；只有查到持久化运行及相同绑定才确认入队。对 deduped / coalesced 的返回必须按键解析已有行；无法唯一解析则标待核实，不发新请求。

| 字段 | 权威来源与含义 |
| --- | --- |
| `released_at` | 已提交的原生阶段转换账本 `occurred_at`；是批准发布动作时间，不是精确提交结束时刻或入队时间 |
| `enqueued_at` | `runs.requested_at` |
| `claim_id`、`claimed_at` | 原子领取生成的 `office_launch_ledger.id` 与时间 |
| `agent_id` | 原生已解析的 Agent 身份，不是仅凭 Claude／Codex 文本 |
| `execution_profile_id` | 实际执行配置快照，保留计划与实际差异 |
| `session_id`、`execution_id`、`turn_id` | 原生执行绑定；缺任一必要关联时不拼接其他会话 |
| `started_at` | 已绑定本次 claim 的执行端事件被宿主观察到的时间 |
| `task_last_activity_at` | 原生任务级最近活动，明确标“任务最近活动”，不冒充心跳 |
| `observed_at` | 本次服务器读快照时间；不是业务节点时间 |

每次领取的 attempt 身份直接使用已有领取账本 ID；不可用 `retry_count` 单独区分，因原生部分重入队不递增该值。领取事务通过新增的结果封装返回该 ID，再沿原生启动上下文传到执行适配器；不是另写一次领取。拿不到 ID 不启动本池模型。重启后仅允许从原生当前 claimed_at 与账本的唯一匹配恢复；缺失或多解标待核实，不能选最大 UUID 猜测。旧回调只可作为旧尝试诊断，不写当前开工回执、不覆盖当前 attempt；既有历史保留。

开工可使用 Codex 适配器处理提供商原生 `turn/started` 后产生且带可信来源标记的匹配事件，或 Claude／其他受支持传输的匹配 `message_chunk` / `tool_call`；必须排除启动欢迎信息、用户回显、旧提示和子 Agent 事件。公共 `EventTypeTurnStarted` 也可在 agentctl 发出提示或自唤醒时产生，事件名称相同不代表来源相同，不能通通当开工。`Turn.StartedAt` 也不能单独证明。没有传输来源区分时先使用匹配的首个工作活动，不改猜测规则。

回执的 `started_source` 只允许宿主派生的 `codex_provider_turn_started`、`assistant_activity` 或 `tool_activity`。Codex app-server 的 operation 来自真实提供商事件，记录 `operation_source=provider`；ACP 没有该 ID，记录 `operation_source=host_turn`，operation_id 明确等于进程前已绑定的原生 turn_id，并匹配捕获的首轮 generation。不能把宿主回合冒充提供商 ID，也不能接受 Agent 文本自报“已开始”。

新增记录只写原生 `run_events`：`pool.launch-admitted.v1` 保存宿主核验的 run／claim／批准快照，仅表示一次性启动尝试已获准。它在提供商 I/O 之前提交，不能作为执行绑定、开工或完成证据。已有意图拒绝再次签发，缺失／歧义领取或不明既有会话不新启。意图写入失败整体回滚，协调器不得创建会话或调用提供商。

2026-10-19 第八检查点：`BindPoolExecution` 在进程前新增 `pool.execution-allocated.v1`，与 runs.session_id 在同一事务内提交。任务仓储核对当前批准、CLI／Worktree、原生 session／turn／executors_running 的真实执行绑定、未结束回合、依赖和其他占用；队列核对唯一当前 claim 与启动意图。分配记录不含尚未产生的 operation，也不是开工。

原生 `LaunchOptions.BeforeExecutionStart` 补充可返回错误的进程前门禁，保留既有只通知的 OnExecutionAdmitted。新执行与已准备工作区两条原生路径均在启动模型进程前调用；分配失败不启动模型，但工作区／agentctl 准备可能已经发生。私有 claim 捕获实际 session／turn／execution／固定 Profile，核对持久返回值后，宿主显式启用该执行的 `EnableWorkActivity`；能力缺失、错误回执、原生回合不匹配或已进入提示时拒绝。普通执行默认不开启，不因本池改变原有事件合同。

原生合并文本流没有携带全部关联字段，不能依赖其最新状态补猜。启用后的生命周期管理器在协议输入处发布精简 `work_activity`：捕获 generation 对应的原生回合、实际 operation 和活动类型，不保存文本或工具参数；用户回显、提供商诊断、子代理、合成 turn_started 及未知 generation 不签发。先捕获身份并释放原生锁，再发布；总线发布不被当作订阅者已处理的确认。

池观察器从原生 Profile／claimed／session 索引条件最多查两份候选，核对唯一 claim、启动意图、已提交分配及本轮身份。`pool.execution-bound.v1` 与 `pool.work-observed.v1` 在同一事务内追加，不保存提示、代码、密钥或终端正文。重复和并发首帧保留原来源／时刻；歧义、陈旧身份和提交失败均不返回有效工作证据。普通非池事件只走索引读取，不取得任务写锁。普通 `AppendRunEvent` 拒绝整个保留 `pool.*` 命名空间；其他事件及序号合同保留。启动返回和分配本身均不能填充 started_at。

回执写入失败而执行可能已发生时，保留领取，显示待核实；不得再次调用模型弥补证据。相同方法重复回调幂等，其他写者造成序号冲突仅允许有界重新读取，不新建运行。

上述第八检查点已有真实协调器／队列／原生运行清单到模拟进程边界、协议输入及早于 StartPoolTask 返回的首帧测试，不是宿主二进制／模拟 CLI 验收。后续停止／终结接线见下文；创建收尾宿主验证、消费者生产接线及人工恢复仍未完成，不能先开放池生产者。

2026-10-19 第九检查点：既有 `officeOrchestratorTaskStarter.ProcessPoolRun` 把共享消费者返回的原始 `ClaimedRun` 直接交给 `StartPoolTask`，不再次领取、入队或使用普通 Office 启动。集成测试已走实际 `SchedulerIntegration.Tick`，重复 tick 仅有一份领取账本、运行与会话；生产构造器仍未启用该处理器。

`ObservePoolTurnEnd` 只接收原生生命周期核验后发布的主回合 `complete` 帧；固定首轮 generation、turn、execution、Profile 和 operation 必须匹配持久分配。它在同一事务内确认 operation 绑定并追加 `pool.turn-ended.v1`，保存宿主身份及 `completed`／`failed`，不保存正文，不补写开工，不改 runs.status、finished_at 或主卡。缺少可靠完成帧不推断结束；保留运行时的失败帧也仅是回合结果。重复／并发通知保留原事件，矛盾结果或 operation 拒绝；提交失败不返回有效事件。先处理结束再处理同轮次工作仍可保存历史开工，不凭订阅顺序改猜身份。

通用 `FinishRun`、Office `MarkRunFailed` 和所有复用 `CancelRunsWhere` 的取消入口现按保留键排除本池，避免无 claim／停止身份的旧写者释放当前占用；普通运行保持既有行为。它们返回空／false 不证明执行已停止。专用终结见第十一检查点，不能去掉通用保护以使运行变绿；原生严格 Done 门禁继续独立生效。

2026-10-19 第十检查点：原生 `StopInstanceConfirmed` 复用 standalone 控制客户端，先核对真实 instance／task／session，再删除并确认后置缺席；缺实例、读失败、范围不符、删除失败或实例仍存在均不签发确认。池捕获启用后，停止直接走该核验路径，不先调用未核对范围的单进程 Stop；普通执行仍走原路径。存活 detach 与关闭期间的逻辑 stopped 不带确认。

实际停止后，原生事件可带 `RuntimeStopConfirmation`；`execution_activity_released` 只表示该执行的原生活动租约／准备所有权已释放，不表示整个 checkout 空闲。旧准备已失效但仍持有租约，或活动协调器不可用时必须为 false；不能把未测得当作空闲。既有 Watcher 保留该字段，`ObservePoolExecutionStopped` 按当前唯一 claim、已提交分配、首轮 generation／turn／execution／Profile 匹配，追加 `pool.execution-stopped.v1`。重复保留原事实，矛盾／陈旧身份与提交失败不返回有效证据；整次执行停止不补造提供商 operation、开工或回合结果。该记录本身不改运行终态或主卡；专用终结见下文，人工核实与宿主验收仍未完成。

`FinalizeStoppedPoolRun` 在原生 lifecycle→task 屏障内重查当前账本、意图／分配／停止、实际宿主与数据库及空 checkout，同事务提交 finished 与引用 stopped_seq 的 `pool.execution-finished.v1`。不清占用、不改主卡或 Done，未知不重试。第十四检查点确认原生 stopped 恢复载体不等于活动执行；精确匹配且 PID 清空的单行载体保持不变，其他占用仍拒绝。完整契约、真实模拟宿主与重启证据见[执行终结设计](agent-pool-execution-retirement.md)；生产仍关闭。

## 读视图与状态

tasks 拥有有界查询与宿主认证入口；列表、历史、原生摘要／提交后刷新和任务指挥界面已接：

- `GET /api/v1/workspaces/:id/task-pool?cursor=...&limit=50`：最大 50 卡，批量返回阶段、执行摘要、资格提示、关系计数及版本；不逐卡扫描会话。作用域、阶段变化与非授权提示边界见[工作区读契约](agent-pool-workspace-projection.md)。
- `GET /api/v1/tasks/:id/pool-history?cursor=...&limit=50`：已接入原生有界历史，具体身份、时间、权限和游标见[单卡读契约](agent-pool-history-projection.md)；不返回原始 payload 或日志。

两者是只读投影，不是运行状态机。可选 `TaskStatusSummary.pool_execution` 已接原生摘要和提交后失效；读取、CAS 与重连契约见[摘要刷新设计](agent-pool-summary-refresh.md)。无绑定旧任务省略字段，不补造历史。

业务阶段与执行状态正交：阶段不能由 `RunStatusFinished` 推导。显示优先级是权限／读失败 → 待核实 → 有证据的当前运行状态；历史已开工不等于当前仍在运行。静默时使用“暂无新活动”，不能仅按输出时间宣称失联。

列表前台可复用原生事件刷新；断线后只重取快照，不执行写命令。若需要查询兜底，前台间隔不小于 10 秒，错误退避至 30 秒、隐藏页面停查。30 秒未确认快照标待刷新；这只影响显示，不改变后端执行。慢查询 3 秒超时，错误行显示未知，不能消失成空池。

## 桌面与手机设计

样式沿用现有设计 token、字体与明暗主题，中文优先。主色只强调当前动作；状态同时有文字和图标，不只靠颜色。不给品牌名、头像或 UUID 新建一套管理系统。

- 桌面：左侧保留原生导航并加“任务指挥”；顶部是工作区、搜索和筛选。主区先显示待我处理，池与执行中可切换；点卡片右侧预览，提供“打开原生工作台”。CPU、摘要哈希和长运行 ID 进入技术详情。
- 卡片：标题；业务阶段＋执行状态；实际 Agent；入队／领取／开工中最相关的两个时间；父任务／依赖和阻塞原因摘要。历史节点只在详情全展开，不塞满卡面。
- 手机入口使用原生手机导航；先展示一个选中的分类和单列列表。筛选用底部 Drawer；卡片直接进入全高详情，不堆叠桌面预览。返回保留筛选和滚动位置。
- 最近的原生参照是 `kanban/mobile-menu-sheet.tsx`（筛选抽屉）、`kanban-with-preview.tsx`（手机直达详情）、`task/task-layout.tsx`（原生工作台）。复用 `useResponsiveBreakpoint` 与共享 primitives，不改全局 CSS。
- 唯一纵向滚动所有者是列表或详情内容体；固定头／主动作考虑 `100dvh` 和底部安全区。普通桌面控件 28px；手机或粗指针动作目标至少 44px，主要动作名义 48px；输入沿用防缩放规则。
- 加载／空池／权限失败／状态未知均有独立文本；关系只显示可见目标。手机所有动作有可见入口，不能靠 hover、右键或拖拽。切到手机不持久化覆盖桌面选择。

完整结构见计划 UI-01 至 UI-04。03 已完成原生批准、入口偏好及桌面／模拟手机验收；04 已实现撤回、停止、人工重试和两端真实宿主重启接缝，收尾验证见工单。真实模型、实体手机及生产未开放。

## 单卡与关系

复用 `tasks.parent_id`、原生依赖读写和阶段／会话关联。实施、审查、验收是同一任务中的阶段与执行尝试；只有独立交付拆子卡。没有既有可读编号时显示标题，UUID 放技术详情，不新建编号服务。首版只做关系摘要、列表与双向跳转，不新增关系图编辑器。

## 恢复与安全

2026-10-19 已在原生 `RecoverStale`、`RequeueClaimedRun`、`ScheduleRetry`、`ScheduleRetryIfClaimed` 的写入条件中排除保留键 `pool-dispatch:v1:`。不依赖完整 payload 或已有工作回执来决定保护，只有前缀的残缺记录也保留。通用扫描不改池的 status／claimed_at／session／retry／优先级，也不补造账本或回执；普通无键或其他键运行仍沿原政策恢复。布尔方法对池返回未写入；原有仅返回 error 的 ScheduleRetry 保留未更新行时的 nil 合同，nil 不是重新入队证明。真实领取和两种回执经这些入口后仍可只读重建为原 claim。

旧 Office 路由的容量停放、下一候选和工作区解除停放写入口也按保留键排除池行。直接启动沿共同任务准入拒绝池占用；人工恢复另核对不可变 execution。当前池容量拒绝不自动重排；未知启动不能用重试兜底，不能撤去通用方法的保护。

“撤回”只取消排队项；领取已发生则返回冲突。“停止”复用原生停止流程，发出停止请求不等于停止已确认。“核实并重试”仅在操作者有权限、当前 run / claim / task 版本匹配、原生执行及 checkout 均确认已停止释放后可用，沿用同一任务与运行，生成新的 claim 账本身份。核实失败保留阻塞，不强制解锁、不重置工作树、不另派 Agent。

`POST /api/v1/tasks/:id/pool-recovery` 为窄宿主动作协调：输入仅为操作种类、操作 ID、预期任务／run／claim 版本与确认，不接受自报已停止时间。复用原生取消／停止／重入队，回执写入原生事件；重复提交读取同一结果，超时先查询。写入沿共同锁序及 CAS 验证，不能无条件 reset；没有停止证据不得重入队。

### 版本化恢复的实施契约

具体版本、真人确认、原生回执、撤回 CAS、停止身份及重试条件见[人工恢复合同](agent-pool-recovery.md)。沿用同一任务与 run，不增建恢复表或第二队列；该合同不代表 04 已验收。

刷新、重连、历史重建和插件 status 都只读。执行标识、时刻、保留派发键和回执仅由宿主生成。工作区 ACL 与任务动作授权是边界；启动命令不能相信浏览器的 claimant 或 timestamp。插件的 `TaskManagementClaim` 仍表示管理者身份，不可当作 CLI 领取。

现有 `fleet.acceptance` 严格门禁不变：完成必须由原生事务实时复核，池内轮次结束、关系变化和 Agent 自报成功都不能放行。新执行会使旧候选陈旧，需重新验收。

## 验证与落地限制

四个顺序工单覆盖原生队列接缝、读投影、桌面／手机以及人工恢复。测试必须含同次入池并发、手动启动竞态、旧轮次回调、重启、重复回执、不同 Provider 证据、权限、原生 Done 负例；具体命令与 AC 对照由[计划](../../../plans/agent-pool-workbench/plan.md)维护。

普通固定 CLI Profile 已通过真实宿主＋模拟代理的池路径，不要求 Office 自主团队。真实提供商构造仍关闭；模拟闭环不代替真实模型、额度或生产验收。

用户已选 A：[最小原生清理凭证](agent-pool-history-clearance.md)是零迁移的窄例外；同事务保留防重派身份，其余维护政策不变。清理事实标待核实，不从缓存补造时间。
