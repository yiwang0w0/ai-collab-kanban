---
id: "02-pool-projection"
title: "有界任务池读投影与历史"
status: done
wave: 2
depends_on:
  - "01-native-dispatch-receipts"
plan: "plan.md"
requirements:
  - REQ-TASKS-AGENT-POOL-001
  - REQ-TASKS-AGENT-POOL-002
  - REQ-TASKS-AGENT-POOL-003
  - REQ-TASKS-AGENT-POOL-004
  - REQ-TASKS-AGENT-POOL-005
acceptance_criteria:
  - AC-TASKS-AGENT-POOL-001.3
  - AC-TASKS-AGENT-POOL-002.1
  - AC-TASKS-AGENT-POOL-002.3
  - AC-TASKS-AGENT-POOL-003.2
  - AC-TASKS-AGENT-POOL-003.4
  - AC-TASKS-AGENT-POOL-004.1
  - AC-TASKS-AGENT-POOL-004.2
  - AC-TASKS-AGENT-POOL-004.3
  - AC-TASKS-AGENT-POOL-005.2
system_design:
  - ../../specs/tasks/system-design/agent-pool-workbench.md
  - ../../specs/tasks/system-design/agent-pool-history-projection.md
  - ../../specs/tasks/system-design/agent-pool-workspace-projection.md
  - ../../specs/tasks/system-design/agent-pool-summary-refresh.md
  - ../../specs/tasks/system-design/agent-pool-history-clearance.md
---

# 工单 02：有界任务池读投影与历史

## 2026-10-20 提交后清理刷新

先补永久回归并见有效 RED：真实清理单连接重读、回滚不通知，以及同 run 的入队零序号不能吞掉清理通知。实现构造期 observer 接线，仅在原生删除事务提交后发出有界失效提示；复用协调器原生异步所有者，清理提示独立去重域，不新建调度或伪造事件序号。`go test -trimpath -race -p=1 ./internal/orchestrator ./internal/task/handlers ./internal/office/retention -run '^TestPool(Projection|History)' -count=1 -timeout=4m` exit 0（协调器 1.309s、任务处理 132.144s）；另跑原生 retention 全包 exit 0，1.961s。后端宿主构造已接线，最新完整二进制与浏览器验收仍在工单 03 进行，不沿用旧二进制的宿主结论。

## 结果

2026-10-20 隔离范围已完成。最终投影／历史 HTTP -race 分组 181.635s 通过，摘要／纯投影和原生写侧组合通过；新增同 run 三个领取的 21 条事件读源容量测试通过，不误用按运行计的 16 条总预算。原生清理、7／9／7 有界查询、权限、分页、故障与 CAS 证据保留；重启／恢复通过新宿主桌面及模拟手机 8/8 接缝。详细来源、基线失败与范围见[最终核对](acceptance-audit.md)。本节是当前结果，后面的检查点记录历史过程，不代表生产 SLA 或真实模型验收。

给卡片、时间线和移动端提供同一份可恢复、带权限的读模型。没有本次绑定的旧任务显示无记录，不以相似时间或同一 Agent 拼接历史。

## 包含

- 任务池列表、单卡历史两个只读端点和 `TaskStatusSummary` 可选摘要；配置版本提示、清理标记、防重派、受控查询预算与异常分项的最终证据见本工单当前结果及验收核对。
- 批量 50 卡限制、游标、三秒读超时、逐行未知状态、刷新版本与历史清理标记。
- 复用原生关系投影及权限；将计划执行者与实际领取者分开。

## 不包含

- 新的关系写接口、完整转录／日志接口、前端布局、任何查询触发派发或修复。

## 验收

1. 同一快照能区分未入池、队列、领取、开工、结束与待核实，完整保留历史 attempt；任务结束不能从 run 结束推导。
2. 越权任务／关系不可见；超过限制、数据源失败、陈旧记录和证据被清理均有明确结果；不会全量扫日志或按卡 N+1 读取会话。
3. 重启和迟到事件后摘要与原生账本一致，读请求不新增任务、运行或回执；原生客户端未采用新字段时不回归。

## 验证

```powershell
Push-Location apps/backend
try {
  go test -race ./internal/task/service ./internal/task/handlers ./internal/task/statussummary -run '^(TestPoolProjection|TestPoolHistory|TestTaskStatusSummary|TestProjector)' -count=1
  if ($LASTEXITCODE -ne 0) { throw '投影、权限或重建检查失败' }
} finally { Pop-Location }
git diff --check -- apps/backend/internal/task
if ($LASTEXITCODE -ne 0) { throw '差异检查失败' }
```

创建 `pool_projection_test.go`、`pool_history_test.go`，检查前后运行／账本行数不因读取变化。测试超时和容量时使用可控时钟及假数据，不发真实模型任务。

## 可能修改的文件

- 已有：`apps/backend/internal/task/statussummary/model.go`、`projector.go`、`rebuild.go`；任务处理器注册及 DTO。
- 拟新增：`apps/backend/internal/task/service/pool_projection.go`、`pool_projection_test.go`、`apps/backend/internal/task/handlers/pool_history.go`、`pool_history_test.go`。
- 原生 runs／任务仓储增加有界读取；用户选择 A 的最小清理凭证属于防重派身份，不是第二快照数据库。

## 依赖与风险

依赖 01 的真实 attempt 绑定。输入是[技术设计](../../specs/tasks/system-design/agent-pool-workbench.md)的身份／读视图章节。既有 `runToListItem` 是尽力解析 payload，不能原样当作安全的池历史边界。

## 并行

sequential

## 结果记录

2026-10-19 用户直接选择 A，解除第二十检查点的保留策略选择门，恢复本工单 in_progress。采用[清理凭证 ADR](../../decisions/2026-10-19-pool-history-clearance.md)和[细化设计](../../specs/tasks/system-design/agent-pool-history-clearance.md)，保留其他三份工单与本工单全部验收。历史检查点的 blocked 是当时状态，不再是待用户选择。

### A 选择后的实现检查点：原生清理凭证已接，整目标未完成

隔离副本 HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40，加此前与本次未提交改动。没有触碰原实例、真实模型、API、提交推送或发布。

- 既有 Office schema 所有者原子安装 run_pool_history_clearances 和单行启用边界，重放不推进边界；runs 模型拥有凭证身份，未新增任务库／队列／调度器。现有 requiredstores 的 Office 所有者与构造器继续承担 schema 安装。
- 原生 DeleteRunBatch 在删除同一事务内核验并保存规范派发身份；凭证写失败／绑定不明回滚。普通终态维护政策不变；没有生产调用的 CleanExpired 排除池记录，不能绕开凭证事务。
- 同批准清理前实际 deduped，清理后返回 pool_history_cleaned／QueueOutcomeNone，运行保持 0；升级前没有证据的旧批准返回 pool_legacy_dispatch_unverified，不追认历史。
- 单卡／工作区／摘要使用一次有界批量凭证读取，关联仍保留的原生 claim；unknown / history_cleaned，current=false。原入队／领取事实可保留，已删除开工／停止等回执字段为空；不从摘要或当前时钟补造。

有效 RED 包括：原生清理后重放实际 queued、运行 0→1；旧批准缺证据仍成功入队；旧批准读取 released；CleanExpired 同时删除池与普通运行（预期仅普通）；结构不完整但内部自洽的生产封装被接受。编译期间一次旧 DTO 缺 Reason 的错误不算 RED。

最新已终结定向组：handlers，退出 0，34.154s，覆盖原生清理／防重派、真实写失败回滚、旧版无凭证形状升级、schema 重放、损坏绑定回滚、原生多 claim 跨页、旧批准待核实、替代删除入口、原生摘要只读及 CAS 重建替换。
测量：1／50 项历史均 7 次；1／50 卡列表均 9 次；1／50 卡摘要均 7 次；加入一万条非池日志后列表仍 9 次。仍为源 Query／Exec 计数，各项独立三秒预算，未包含认证／授权／CAS 写及夹具；不能宣称生产 SLA。

当前验证边界：

- SQLguard 最终退出 0。先前日期 SQL、最终边界未 Rebind 两项已分别修正，不放宽守卫。
- 原生 retention 最终整包退出 0，2.152s。
- storeconformance 最新退出 1，39.346s：storage 四类 Windows 绝对路径、历史 sqlite.sql／postgres.sql 校验和及 PreviousStableUpgrade 的路径失败。没有修改冻结历史夹具掩盖失败，没有实际 PG DSN。
- 一次范围过宽的 TestPool 前缀扩展组退出 1：handlers 超过 6 分钟、任务批准并发回归观察到 2 次提交、模型修改期间发生 import 读取失败。不能报成回归全绿；在源码稳定后分开核对工单 02 范围与并发准入问题，不以该次导入故障判断产品行为或推断确定原因。
- 文档目录检查通过：350 决策／1349 规格；完整 spec lint 仍有 107 项既有 file-size 告警，不是完整 lint 通过。

新编译私有宿主＋模拟 CLI 已终结：退出 0，19.776s，实际登录、CLI／Git Worktree、派发／领取／开工／停止、严格 Done 缺回执拒绝及二进制重启。它未触发真实提供商，也不代表清理后的真实宿主通知已验收。结束后使用可读的提权只读进程查询，核对该私有目录三个确切二进制路径，无匹配残留。

原生并发批准窄复核单次退出 0（1.676s），随后 count=10 退出 0（2.285s）。此前双提交观察未复现但仍保留为 01 的稳定性风险，不称已消除。凭证结构模型窄测试在修正前有效 RED，修正后退出 0（1.800s）。

源码稳定后的工单 02 受影响组已终结，退出 0：

```powershell
# apps/backend，使用既有私有 Go / GCC 环境，GIN_MODE=release。
go test -trimpath -race -p=1 ./internal/task/handlers ./internal/task/service ./internal/task/poolhistory ./internal/task/repository/sqlite ./internal/task/statussummary -run '^(TestPool(Projection|History|Summary)|TestTaskStatusSummary|TestProjector)' -count=1 -timeout=6m
# handlers 188.802s；service 1.143s（无匹配独立测试，HTTP 已覆盖服务）；
# poolhistory 2.096s；sqlite 1.959s；statussummary 1.395s。
go run ./cmd/sqlguard ./internal
# 退出 0。
go test -trimpath -race -p=1 ./internal/backendapp -run '^TestPoolHostNativeMock$' -count=1 -timeout=4m
# 已先重建隔离 kandev.exe 并显式设置 KANDEV_POOL_HOST_*；退出 0，19.776s。
```

补充的真实事务故障契约亦退出 0，4.623s：事件删除在凭证写入后报错，以及运行删除数量两次不符，均不留下凭证、删除计数为零且源事实不变；去掉同一临时数据库中的故障触发器后，实际原生清理成功并仅留一份凭证。没有为测试增加生产注入接口。

最终稳定源码的共享 runs 回归亦已完成：go test -trimpath -race -p=1 ./internal/runs/service ./internal/runs/models ./internal/runs/repository/sqlite -run '^(TestPool|TestCleanExpired)' -count=1 -timeout=3m，退出 0；service 31.581s、models 1.067s、sqlite 2.560s。包含发布、领取保护、模型结构核验及普通清理控制；不是全仓全部 Go 测试通过。

下一步：清理提交后的失效接线、并发清理／发布与更多故障边界仍需补齐。03 的桌面／手机／关系导航及 04 的人工恢复仍 pending，不据本段宣布 02 或全目标完成。

2026-10-19：01 提供的原生 attempt 身份、持久回执及真实模拟宿主接缝已验证，按此输入进入只读实现；01 的整组验证欠项仍保留，未宣称其正式验收完成或开放生产。本工单仍按原范围完成列表、历史、摘要及已提交刷新，不把单卡端点缩成最终交付。

新增 pool_history_test.go，经真实 TaskHandlers.registerHTTP 注册路由和实际任务／工作流／runs schema 夹具验证。初组涵盖无绑定任务、已批准与已入队的分离、不得补造领取／开工或返回提示、相同事实的稳定快照、最大 50 项和错误游标，以及越权与缺失的一致结果。读取前后核对 runs、run_events、office_launch_ledger、task_step_transitions 行数。认证身份由测试上下文注入，这不是完整 HTTP 登录或宿主二进制验收。

第十五检查点的有效 RED：有效空历史和已批准历史预期 200，实际 404；无效分页预期 400，实际 404。go test -trimpath -race -p=1 ./internal/task/handlers -run '^TestPoolHistoryHTTP' -count=1 -timeout=2m，退出 1（7.162s）。当时越权／缺失都 404 在路由未实现时不证明授权正确，须在合法正例通过后复核。初次误用 PublishPoolRelease 的双返回签名导致编译失败，不算产品 RED；定位真实签名后才得到上述有效断言结果。

已落实的响应最小契约：task_id、snapshot_version、items、next_cursor；条目区分 planned_agent_profile_id 与 claimed_agent_profile_id。released_at 来自原生批准，queued_at 来自 runs.requested_at；未领取／未开工时相应时间及领取者为空，不从当前时间或负责人推导。状态 released 不等于 queued，也都不等于主卡完成。

### 第十六检查点：单卡历史已实现，工单未完成

2026-10-19：GET /api/v1/tasks/:id/pool-history 已注册。新增 tasks 所有的纯事实投影，以及同一只读事务中的原生阶段／运行／领取账本／池回执查询；不新增表、索引、后台写修复或调度器。先定位并授权工作区，再在快照重查作用域；空权限定位返回 404，来源失败或返回异域／空快照均拒绝，不把故障伪装成无记录。错误响应不输出内部诊断。

真实 ClaimNextEligibleRunWithClaim 返回的不可变 ledger ID 作为领取身份，同一 run 的历史领取分开分页；claimed_at 不充当 ID。原生释放、分配、回合、工作、停止与终结身份工厂共同核对证据。明确区分计划执行者与实际领取者、回合结束与本轮执行终结；后续终结错误不抹去已确认开工时间。无关、缺失或多解证据显示 unknown，不自动重派。

每页最多 50，游标绑定任务／阶段及领取，读取运行及回执均有行数和 16 KiB 字节上限，服务预算三秒。51 项跨页无重复、跨任务游标拒绝及 SQLite query_only 连接通过。读取前后同时核对任务、运行、事件、领取与阶段账本数量及主卡状态／版本，不允许读请求派发或更新卡片。专用查询在 PGX 驱动上提前拒绝；这不是实际 PostgreSQL 服务验收。边界测试中的旧领取是账本夹具，不声称 51 次真实执行。

本段遵循有效 RED 后修复：领取被误投影为 unknown、同 run 多领取漏页、真实宿主缺少会话绑定、后续异常擦除已知开工、空工作区及异域快照错误接受均已由断言复现并修复。真实私有宿主通过实际 mock-agent CLI、Git Worktree 和 HTTP 登录读取，开工／回合结束／停止／终结时间逐项与原生事件相等；真实二进制重启和 external_id 重放后响应正文及 snapshot_version 不变。缺交付回执的严格 Done 仍拒绝；未安装验收插件正例，也未调用真实模型或 API。

最终命令与终态（均在隔离副本）：

```powershell
# 运行前使用本目标已有的私有 Go / GCC 环境；不更改全局配置。
go test -trimpath -race -p=1 ./internal/task/service ./internal/task/handlers ./internal/task/statussummary ./internal/task/poolhistory ./internal/task/repository/sqlite -run '^(TestPoolProjection|TestPoolHistory|TestTaskStatusSummary|TestProjector)' -count=1 -timeout=5m
# 退出 0：handlers 30.553s、statussummary 2.027s、poolhistory 2.203s、sqlite 1.960s。
# service 没有匹配的独立测试，实际授权服务由 HTTP 测试覆盖。
go test -trimpath -race -p=1 ./internal/backendapp -run '^TestPoolHostNativeMock$' -count=1 -timeout=4m
# 先按工单 01 的私有宿主环境重新构建 kandev.exe；退出 0，19.906s。
go test -trimpath -race -p=1 ./internal/persistence/storeconformance -count=1 -timeout=4m
# 退出 1，45.552s；storage 四类 Windows 绝对路径、SQL 夹具校验和及 PreviousStableUpgrade 失败。
```

收尾检查：SQLguard 全 internal 扫描通过；本段 Go 文件 gofmt -l 无输出，git diff --check 退出 0；文档清单校验通过（349 decisions／1346 specifications）。规格检查完整结果仍有 107 个 file-size 报告，本功能路径无命中，不宣称规格全绿；没有运行 golangci-lint。整组存储未全绿，未修改其夹具、阈值或无关调度器以消除报告。实际私有宿主二进制路径下的 kandev／agentctl／mock-agent 已无存活进程。低磁盘时仅对已核定的隔离 tools/gocache 执行 go clean -cache，释放约 44 GiB；可重新编译，不删除源码、模块下载、fuzz、宿主二进制或原实例文件。

下一步仍按原范围交付工作区批量列表、TaskStatusSummary 可选字段、已提交刷新、历史清理标记及更完整的异常／查询预算验证；之后为桌面／手机、卡片关系与人工恢复。单卡端点不是完整工单或工作台验收，01／02 继续 in_progress，03–04 pending。生产构造器仍不接真实池执行；原实例、严格 Done 门禁和真实模型授权边界不变。

### 第十七检查点：工作区基础列表已验证，摘要及刷新仍待完成

2026-10-19：上一目标回合是实际实现及实证推进，本回合继续实现 GET /api/v1/workspaces/:id/task-pool。新增 tasks 所有的 poolview，复用 poolhistory、原生阶段配置识别及 PoolExecutionCandidate 的静态 Profile 校验；不新建表、调度器或写修复。固定 HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40 加本目标未提交改动，不是新的提交或发布候选。

列表批量返回最多 50 张未归档非临时卡的阶段、池执行、资格提示、关系计数和稳定版本；普通无绑定卡保持 pool_execution 为 null，不读取正文／完整日志。它包含原生主卡和子卡，不是只返回已获批准的卡。类别筛选、原生摘要和界面仍待接线。游标按不可变主卡 ID 前进并绑定工作区；51 卡跨页无重复，异域与不存在一致，读取前后原生任务／运行／事件／账本及主卡状态不变。

实际原生移动证实：已领取但尚无活跃会话的主卡可以移回待办，run 不随之终结。初版列表因此漏掉领取，已通过有效 RED 修复：保留最近池批准、真实 run／claim／事实时间，最新阶段不匹配时显示 unknown／current_stage_unverified，不冒充新阶段正在执行，也不重派。原生当前领取不取最大账本时间；较新的历史时刻夹具不能抢走当前 ledger 身份。

关系复用 parent_id 和 task_blockers，同工作区未归档非临时目标参与计数；缺失、异域或未完成前置仍阻塞，但不输出不可见目标的名称或 ID，也不清理脏边。静态资格可区分未配置、待额度确认、批准未入队、占用、配置／Profile／WIP／依赖错误及未知；ValidateProfile 只核对静态 CLI 资料，原生 Validate 仍额外核对实际执行器。资格标签不是启动授权，不宣称凭据、工作树、运行时和最终写门禁都已通过。

来源故障、空／异域快照、异域单行、超量或重复 ID 均返回固定 503，不回显诊断。实际来源收到三秒预算，来源返回后若调用已取消也不能确认 200。超量／重复来源和取消后错误接受均先复现为 200 的有效 RED 再修复；原生空事件配置曾误报 blocked，也已按原生 reader 的空配置语义修复。两张真实原生领取的夹具证明，坏卡 17 条残缺池事件只令该卡未知，不改变邻卡已领取事实；这些元数据夹具不是模型执行证据。

最终命令与终态：

```powershell
# 工单既有的隔离 Go / GCC 环境；下面命令从 apps/backend 执行。
go test -trimpath -race -p=1 ./internal/task/service ./internal/task/handlers ./internal/task/statussummary ./internal/task/poolhistory ./internal/task/poolview ./internal/task/models ./internal/task/repository/sqlite -run '^(TestPoolProjection|TestPoolHistory|TestPoolExecutionCandidate|TestTaskStatusSummary|TestProjector)' -count=1 -timeout=5m
# 退出 0：handlers 90.580s、statussummary 1.382s、poolhistory 1.120s、models 1.076s、sqlite 2.108s。
# service 没有匹配的独立测试、poolview 没有独立 test 文件；二者由真实 HTTP 边界及宿主测试覆盖，不伪称直接单元覆盖。
go run -trimpath ./cmd/sqlguard ./internal
# 退出 0。
go test -trimpath -race -p=1 ./internal/backendapp -run '^TestPoolHostNativeMock$' -count=1 -timeout=4m
# 先按既有私有宿主环境重新构建 kandev.exe；退出 0，20.670s。
go test -trimpath -race -p=1 ./internal/persistence/storeconformance -count=1 -timeout=4m
# 首次退出 1，39.570s，原始迁移日志过量而丢失中段诊断；不是仍在运行的进程。
# 对终态失败重新采集并过滤摘要后仍退出 1，41.002s：storage 四类 Windows 绝对路径、两份 SQL 夹具校验和及 PreviousStableUpgrade 失败。
```

私有宿主通过真实 mock-agent CLI、Git Worktree 与原生登录读取两种 API；列表中的开工、回合结束、停止和终结时间逐项等于原生回执，真实二进制重启及 external_id 重放后列表正文和版本不变。缺交付回执的严格 Done 仍返回 409；未安装验收插件正例，也没有真实提供商或 API 调用。原实例、全局配置、公开文档和提交推送未改动。没有新增缓存删除。

执行陷阱：所有源码读取使用已发现的绝对路径，不猜文件名或混用 repo／backend 工作目录；Windows 原生 gofmt 不展开星号，须传明确文件数组或目录。首次格式命令的通配符错误不是产品 RED，已用明确数组格式化。conformance 必须先在脚本内捕获并过滤输出，不能把大量迁移日志直接交给限长观察；失败进程已终结后才能因诊断丢失复核，观察超时不能启动重复进程。

收尾检查：本段 Go 文件 gofmt -l 无输出，git diff --check 退出 0；文档清单校验通过（349 decisions／1347 specifications）。完整规格检查仍有 107 个 file-size 报告，本功能路径无命中；不宣称规格全绿，也未运行 golangci-lint。真实宿主测试终结后按本目标三份私有二进制的完整路径复查，存活进程为零。

下一段接原生 TaskStatusSummary 可选 pool_execution、真实提交后刷新和重启／重连省略语义；继续保留历史清理标记、规模／查询预算、资格提示与当前配置／原生实际准入的一致性及更完整异常覆盖。刷新必须在提交后，不能把异步 bus 发送当作本地持久确认。之后交付桌面／手机、关系详情／双向导航和人工恢复。列表基础接口不是完整工单；01／02 继续 in_progress，03–04 pending，生产注入仍关闭。

### 第十八检查点：原生摘要、提交后刷新与既有共享缓存

2026-10-19：已接可选 TaskStatusSummary.pool_execution，沿用原生语义 revision、CAS 仓储、投影器及 task.status_summary.updated。批量来源在同一 SQLite 只读事务按工作区／最多 50 个明确 ID 读取既有池事实；不加载正文／转录，也不建第二库。读修复只写现有可重建摘要，不改变任务、运行、领取、批准或回执。规范见[摘要刷新契约](../../specs/tasks/system-design/agent-pool-summary-refresh.md)。

重建保留其他摘要域，CAS 输给并发写后重载完整摘要及最新原生池资料，不能给旧 claim 提升 revision。投影器在来源错误时保留已知身份／时间并标 unknown／pool_read_unavailable；明确无绑定才清空。无关队列事件不再抹掉已知池字段，较新完整摘要省略字段与任务部分补丁省略摘要分开处理。

原生事务成功返回后才提示摘要失效，实际领取使用已验证 ClaimedRun。协调器复用已有原生生命周期后续工作的所有者、超时和关闭规则，不在执行回调锁内重查资源；至多 128 个身份键的临时序号缓存只抑制重复通知。内部 task.pool_execution.committed 仅携带 task ID，由原生来源重读，不接受通知自报 state、claim、workspace 或时间；不增加公开 WS 主题。异步 bus 发送不是事务或摘要持久确认，漏通知仍由原生读重建收敛。

前端只扩展原生摘要类型并增加契约测试；既有 revision 比较、完整替换、部分任务合并和读取日志已能阻止旧快照回滚新领取，未另写池专用合并逻辑。覆盖单／多看板、归档、完整省略清空、部分省略保留，以及重连／迟到 HTTP。该共享状态验证不冒充桌面／手机页面或真实断网交互验收。

有效 RED 包括：新字段未进入序列化／语义版本、队列更新抹掉字段、原生重建缺当前领取，以及新编译真实模拟宿主已有五类原生事件但首次 GET 之前持久池摘要仍为空。修复后各契约通过；真实宿主在历史／列表 GET 之前直接读取摘要表，开工／回合结束／停止／终结时间逐项等于原生回执。实际 mock-agent CLI、Git Worktree、原生登录、停止及二进制重启／external_id 重放后池摘要正文一致通过，缺交付回执的 Done 仍 409。没有真实模型、API 或验收插件正例。

最终命令与终态（固定 HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40 加本目标未提交改动）：

```powershell
# 既有私有 Go / GCC 环境；从 apps/backend 执行。
go test -trimpath -race -p=1 ./internal/task/service ./internal/task/handlers ./internal/task/repository/sqlite ./internal/task/dto ./internal/task/statussummary ./internal/task/poolview ./internal/task/poolhistory ./internal/runs/service ./internal/orchestrator -run '^(TestPool|TestTaskStatusSummary|TestProjector|TestReconcile|TestStatusSummary|TestOverlayLaunchQueue|TestEnrichTaskStatus|TestBuildFromAuthoritative)' -count=1 -timeout=5m
# 退出 0：service 6.366s、handlers 279.855s、sqlite 6.867s、dto 1.787s、statussummary 1.319s、poolhistory 2.097s、runs/service 33.191s、orchestrator 4.224s。
# poolview 无独立 test 文件，仍由真实仓储／HTTP／宿主覆盖，不伪称直接单元覆盖。

go test -trimpath -race -p=1 ./internal/backendapp -run '^TestPoolHostNativeMock$' -count=1 -timeout=4m
# 当前生产源码重新构建私有二进制后退出 0，22.422s。

go run -trimpath ./cmd/sqlguard ./internal
# 退出 0。

go test -trimpath -race -p=1 ./internal/persistence/storeconformance -count=1 -timeout=4m
# 先在脚本内捕获并过滤结果；退出 1，44.816s。
# storage 四类 Windows 绝对路径、sqlite.sql / postgres.sql 校验和及 PreviousStableUpgrade 失败。
```

前端从 apps/web 使用既有 Node 直接调用现存本地二进制，未重新安装依赖：

```powershell
& 'C:/Program Files/nodejs/node.exe' node_modules/vitest/vitest.mjs run lib/task-status-summary.test.ts lib/ws/handlers/tasks-status-summary.test.ts lib/ws/handlers/tasks-pool-summary.test.ts
# 三文件／22 项通过。
& 'C:/Program Files/nodejs/node.exe' node_modules/typescript/bin/tsc --noEmit
& 'C:/Program Files/nodejs/node.exe' node_modules/eslint/bin/eslint.js lib/types/task-status-summary.ts lib/ws/handlers/tasks-pool-summary.test.ts
# 类型检查及两文件 lint 均退出 0。
```

执行陷阱：捆绑 pnpm 回退版本与仓库声明的 9.15.9 不符，尝试启动自动安装后因无 TTY 拒绝清理 node_modules；不设 CI 或关闭确认强制清理，改用已存在的 Node／二进制。依赖声明／锁文件无新差异。RunEvent.Seq 原生类型是 int，误用 int64 和测试 Close() 返回签名错误都是编译／测试搭建失败，不算产品 RED。私有进程检查第一次受沙箱拒绝，不能把空结果当零进程；只读获准后按三份私有二进制完整路径确认存活为零。

收尾检查：本段 Go 文件 gofmt -l 无输出，两个 Web 文件 Prettier 通过，git diff --check 退出 0。文档清单校验通过（349 decisions／1348 specifications）；完整规格检查仍有 107 个 file-size 报告，本功能路径问题为零，不宣称规格全绿。公开功能尚未交付，仅更新内部契约、计划及协作说明；未运行 golangci-lint。

剩余仍为历史清理标记、规模／查询预算、资格提示与当前配置／实际准入一致性、更多异常与迟到覆盖；之后为桌面／手机、关系导航及人工恢复。01／02 继续 in_progress，03–04 pending，生产池执行仍关闭。未修改原实例、全局配置或公开文档，无提交推送及缓存删除。

### 第十九检查点：配置版本提示与真实查询预算

2026-10-19：上一目标回合为实质推进，本回合继续保持同一目标与隔离副本。核对原生 LoadPoolRelease 后，新增真实 HTTP／SQLite 回归：阶段配置版本晚于批准时，写侧拒绝旧批准，旧列表却仍显示 occupied。已入队和已领取两种场景均先得到预期断言 RED，再修复显示，不改原生发布、领取或启动政策。

读上下文从同一批量来源读取当前阶段 updated_at，晚于已确认 released_at 时显示 requires_revalidation／pool_stage_configuration_changed。原生任务、run、claim、Profile 与事实时间保持不变。补充移除池配置、切换阶段执行者的同链路检查；写侧仍拒绝旧批准，列表不把历史实际 Agent 换成新配置。未增加表、索引、持久字段或第二套配置。

查询预算使用测试内的实际 SQLite 驱动连接计数，兼顾直接查询与预编译语句；不导出生产测试方法。连接确实为 mode=ro／query_only，非空计数作为正对照。50 张卡均经原生创建、浏览器确认入口及原生发布，只有一张被真实原生事务领取，其余仅排队，没有五十份模型并发。单卡 50 条领取则由同一从未调用执行器的测试 run 重置后反复经过原生领取事务构造，不代表五十次物理执行，也不是人工恢复实现。

已确认的受控结果：工作区 1 卡／50 卡均 8 次源查询；原生摘要 1 卡／50 卡均 6 次；单卡 1 项／50 项领取历史均 6 次。计数仅覆盖仓储源 Query／Exec，不包括 HTTP 认证／授权、原生摘要 CAS 写入、事务开始／结束或夹具准备。一万条非池日志加入后列表仍 8 次，日志不进入池资料，投影正文和 snapshot_version 均不变。每项独立传入三秒期限，读取前后任务／运行／事件／领取／阶段账本和主卡状态／版本保持不变；压力日志本身的新增行另行核对。毫秒计时只是本机夹具观测，出现 0s 是宿主计时粒度，不代表零次查询；不宣称生产 SLA 或所有工作区规模均已验收。

有效 RED 命令：

```powershell
# 既有私有 Go / GCC 环境；从 apps/backend 执行。
go test -trimpath -race -p=1 ./internal/task/handlers -run '^TestPoolProjectionHTTPRequiresRevalidationWhenApprovedStepVersionChanges$' -count=1 -timeout=2m
# 退出 1，3.613s：两场景预期 requires_revalidation，实际 occupied。
# 修复后同命令退出 0，4.773s。

go test -trimpath -race -p=1 ./internal/task/handlers -run '^TestPool(ProjectionNativeQueryBudgetStaysFlatFromOneToFiftyCards|HistoryNativeQueryBudgetStaysFlatAcrossFiftyClaims)$' -count=1 -timeout=3m -v
# 退出 0，6.226s；这是补充测试契约，不把首次即绿称作产品 RED。
```

历史清理仍未完成。已核对原生 office/retention.Store.DeleteRunBatch 在同一事务删除终态 run 与 run_events；保留的 office_launch_ledger 只有 run／workspace 等关联，不含任务／阶段派发键。没有已关联的清理凭证时，既不能由缺行证明从未入队，也不能把它直接命名为已清理。后续先固定实际维护后的读行为并核对最小原生清理凭证设计，不改变既有维护政策，不使用缓存补造真实时间；该缺口仍归本工单，不以本批查询预算代替。

本批最终命令与终态（全部取自原始会话句柄，不因观察超时重复启动）：

```powershell
# 与上面相同的私有 Go / GCC 环境，apps/backend 工作目录。
go test -trimpath -race -p=1 ./internal/task/service ./internal/task/handlers ./internal/task/repository/sqlite ./internal/task/statussummary ./internal/task/poolview ./internal/task/poolhistory -run '^(TestPoolProjection|TestPoolHistory|TestPoolSummary|TestTaskStatusSummary|TestProjector|TestReconcile|TestStatusSummary|TestOverlayLaunchQueue|TestEnrichTaskStatus|TestBuildFromAuthoritative)' -count=1 -timeout=5m -v
# 退出 0：service 1.972s、handlers 138.185s、sqlite 3.567s、statussummary 1.344s、poolhistory 1.102s。
# poolview 没有独立 test 文件；本批通过真实 HTTP／仓储／模拟宿主覆盖，不称直接单元测试。

go test -trimpath -race -p=1 ./internal/task/handlers -run '^TestPoolProjectionHTTPConfigurationChangesDoNotTurnOldApprovalIntoNewWork$' -count=1 -timeout=2m
# 最后仅增强该测试为领取后切换 Profile／移除配置，生产源码未再修改；退出 0，4.936s。
# 旧 claim ID、实际 Agent、运行及事实时间保留，写侧仍拒绝旧批准，读侧提示需重新核验。

go run -trimpath ./cmd/sqlguard ./internal
# 退出 0。

go test -trimpath -race -p=1 ./internal/backendapp -run '^TestPoolHostNativeMock$' -count=1 -timeout=4m
# 先重建当前源码的私有 kandev.exe；退出 0，20.498s。

go test -trimpath -race -p=1 ./internal/persistence/storeconformance -count=1 -timeout=4m
# 脚本先捕获并过滤迁移日志，退出 1，45.693s。
# storage 四类 Windows 绝对路径、两份 SQL 夹具校验和及 PreviousStableUpgrade 仍失败，不宣称全绿。
```

最终受影响回归中，1／50 卡列表仍为 8 次源查询，摘要与领取历史仍各 6 次；一万条非池日志未改变池正文／版本。新编译私有宿主继续通过实际 mock-agent CLI、Git Worktree、原生 HTTP 登录、事实时间、停止及二进制重启／external_id 重放一致性，缺交付回执的严格 Done 仍 409；没有验收插件正例或真实模型／API 调用。本批未改 Web 源码，不沿用上一批前端结果冒称本批新执行。

收尾：gofmt -l 无输出，git diff --check 退出 0；文档清单校验通过（349 decisions／1348 specifications），完整规格检查仍有 107 个 file-size 报告，本功能路径问题为零，不称规格全绿，未运行 golangci-lint。按规范化的三份私有二进制完整路径，以可读的进程清单确认存活为零；权限失败或不可读路径不能当作零进程。固定 HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40 加本目标未提交改动，没有提交、推送、公开文档或原实例变更，也未删除缓存。

后续先按原范围固定真实维护后的读行为并核对清理凭证设计，保留其余准入／异常验收，再交付桌面／手机、关系导航和人工恢复。原生摘要与版本测试不等于工作台界面，01／02 继续 in_progress，03–04 pending；原实例、严格 Done、真实模型及公开发布边界均不变。

### 第二十检查点：实际维护后的防重派缺口，待选设计边界

2026-10-19：上一回合为实质推进，本回合新增 pool_history_retention_test.go，通过真实原生维护复现清理后的读视图和旧批准重放。临时数据库中，CountEligibleRuns 确认可清理的一条终态运行，DeleteRunBatch 实际删除 run 及测试事件，领取账本仍有一行；任务及阶段事实不变。终态是从未启动执行器的测试元数据，不把它冒充物理停止或人工恢复实证。

清理前同一批准实际去重；清理后单卡退回 released，工作区变为 dispatch_pending／release_not_queued；同一批准再次进入原生发布时返回 queued 且无错误，实际运行行数从 0 变为 1。三个当前回归分别在预期 unknown 与实际 released、不得新增运行却新增一行、预期 unknown 与实际 dispatch_pending 处失败。该证据说明不只是显示差异，还丢失了持久去重依据；没有启动消费者、CLI 或真实模型。

命令与终态见[待选保留方案](decision-history-retention.md)。初组两条有效 RED 退出 1（3.493s）；追加工作区边界并格式化后的最终三条 RED 退出 1（5.248s）。全部原始测试句柄均已终结，不因观察超时重复启动。没有修改生产源码、schema、维护政策、原实例或全局配置；没有新宿主／Web／模型验收，不沿用上一批结果冒称本批验证。

按原设计的“新增持久化边界先回设计”及 spec-driven-development 停止条件，本工单暂记 blocked，等待用户选择：A 为最小原生派发／清理凭证（推荐，继续现有清理，需要持久化增量）；B 为不新增表但完整保留池运行及回执（改变清理政策、数据持续增长）。当前没有 accepted ADR，也未擅自选 A 或 B。需求和全目标范围不缩减，01 仍 in_progress，03–04 pending；总目标仍 active，此处不是完成验收或用户请求的暂停。
