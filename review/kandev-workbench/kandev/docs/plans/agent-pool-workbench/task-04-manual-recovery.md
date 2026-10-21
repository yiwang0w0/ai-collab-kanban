---
id: "04-manual-recovery"
title: "人工恢复及完整模拟接缝"
status: done
wave: 4
depends_on:
  - "03-workbench-ui"
plan: "plan.md"
requirements:
  - REQ-TASKS-AGENT-POOL-001
  - REQ-TASKS-AGENT-POOL-002
  - REQ-TASKS-AGENT-POOL-003
  - REQ-TASKS-AGENT-POOL-005
acceptance_criteria:
  - AC-TASKS-AGENT-POOL-001.3
  - AC-TASKS-AGENT-POOL-001.4
  - AC-TASKS-AGENT-POOL-002.3
  - AC-TASKS-AGENT-POOL-002.4
  - AC-TASKS-AGENT-POOL-003.2
  - AC-TASKS-AGENT-POOL-003.3
  - AC-TASKS-AGENT-POOL-005.1
  - AC-TASKS-AGENT-POOL-005.2
  - AC-TASKS-AGENT-POOL-005.3
  - AC-TASKS-AGENT-POOL-005.4
system_design:
  - ../../specs/tasks/system-design/agent-pool-workbench.md
  - ../../specs/tasks/system-design/agent-pool-recovery.md
---

# 工单 04：人工恢复及完整模拟接缝

## 结果

2026-10-20 隔离范围完成：原生撤回／停止／同 run 人工重试、真实宿主重启及不确定启动隔离已有桌面／模拟手机证据。命名清理后的组合 13/13 场景通过，新增依赖／阻塞双向跳转的两端扩充场景亦通过；严格插件再次完成真实安装、拒绝和人工通过闭环。候选增量在固定基线加严格补丁后重放，481 个源文件核对、三个关键 -race 回归及原生宿主编译通过。最新清单与逐项结果见[隔离交付核对](acceptance-audit.md)。done 仅指原工单的隔离模拟交付，不是全库全绿、真实 CLI、实体手机或生产验收；后面的检查点是历史过程。

让操作者能安全地区分撤回、停止和核实后重试，领取后不确定的执行不会因重启或静默被再派一次。此工单完成前不得把试点池开放给真实任务自动领取。

## 包含

- 在原生过期恢复、容量重排和路由重试入口按可信本池身份窄范围约束，普通任务政策不改。
- 版本化人工恢复协调动作、同一操作结果查询、停止／checkout 释放确认及新 attempt 的历史关联。
- UI-04 桌面／手机的操作条件、确认与冲突结果；模拟断开、重启、旧回调、并发取消／领取负例。

## 不包含

- 自动接管、自动重派、强制解锁、清理或重置工作树、实际模型调用及任何部署。

## 验收

1. 对本池启动结果不确定的 claimed，重启、超时及数据恢复不会再调用执行器；原生非池任务的恢复测试仍通过。仅有明确“未启动且资源释放”的原生容量分支可以安全重排同一 run。
2. 恢复动作需当前 run／claim／task 版本、权限及停止／checkout 证据；取消与领取竞争只允许一个成立，旧操作、重复操作和响应丢失不创建新任务／run，晚到回调不能接管新 attempt。
3. 桌面／手机模拟完成“查看待核实 → 停止已确认 → 明确核实并重试 → 新 attempt”，同时证明未获验收回执时原生 Done 被拒绝。更新运行说明和兼容补丁，但不使用旧基线补丁覆盖新功能。

## ASCII UI preview

对应[计划 UI-04](plan.md#ascii-ui-preview)，与 UI-02 手机详情共享语义，不把时间警报做成自动重派开关。

```text
UI-04 桌面详情 / 手机全高详情
+-------------------------------------------+
| 实施 / 待核实   Claude                     |
| 领取: 10:02   开工证据: 未确认             |
| [查看原生运行] [刷新状态]                 |
| [核实并重试: 禁用] 未确认执行已停止        |
+-------------------------------------------+
停止和资源释放确认后：
+-------------------------------------------+
| 核实后重试                                |
| 当前旧尝试、已停止证据、重试额度提示       |
| [取消]                   [确认重试]       |
+-------------------------------------------+
```

手机确认沿用原生底部 Drawer；主体内部滚动、固定动作有安全区，按钮至少 44px；桌面使用原生确认组件与 28px 控件。已发停止请求但未确认时按钮仍不可用。

## 验证

仓库根目录，沿用工单 01／03 的工具链前置条件。新测试由本工单创建；不因模拟启动次数增加而执行真实模型。

```powershell
Push-Location apps/backend
try {
  go test -trimpath -race -p=1 ./internal/task/handlers ./internal/task/service ./internal/runs/service ./internal/runs/repository/sqlite ./internal/orchestrator ./internal/office/service -run '^(TestPoolRecovery|TestPoolCancellation|TestScheduler.*Recover|TestStrictCompletion)' -count=1
  if ($LASTEXITCODE -ne 0) { throw '恢复或门禁回归失败' }
  go run ./cmd/sqlguard ./internal
  if ($LASTEXITCODE -ne 0) { throw 'SQL 检查失败' }
} finally { Pop-Location }
pnpm --dir apps/web exec vitest run hooks/domains/task/use-task-pool-recovery.test.ts lib/task-pool-recovery.test.ts lib/task-pool-recovery-pending.test.ts lib/api/domains/task-pool-recovery-api.test.ts
if ($LASTEXITCODE -ne 0) { throw '恢复界面单测失败' }
pnpm --dir apps/web e2e:run --host --shards 1 --project auth tests/auth/task-pool-recovery-auth.spec.ts --retries=0
if ($LASTEXITCODE -ne 0) { throw '断开与重启模拟失败' }
pnpm --dir apps/web e2e:run --host --shards 1 --project mobile-chrome tests/auth/mobile-task-pool-recovery-auth.spec.ts --retries=0
if ($LASTEXITCODE -ne 0) { throw '手机恢复模拟失败' }
node --test scripts/validate-public-docs.test.mjs
if ($LASTEXITCODE -ne 0) { throw '文档校验测试失败' }
node scripts/validate-public-docs.mjs
if ($LASTEXITCODE -ne 0) { throw '公开运行说明校验失败' }
```

最终记录原宿主和新改动的实际 SHA、受影响命令结果、模拟启动计数及剩余真实验收条件。若实际调用缺登录或额度授权，只保留一页需求清单，不标真实验收通过。

## 可能修改的文件

- 已有：`apps/backend/internal/runs/repository/sqlite/runs.go`、`requeue.go`；`apps/backend/internal/office/service/scheduler_integration.go`；本池派发与原生停止接缝。
- 拟新增：`apps/backend/internal/task/service/pool_recovery.go`、`pool_recovery_test.go`、`apps/web/components/task-pool/task-pool-recovery.tsx` 及测试、E2E 恢复文件。
- 本地独立插件 `README.md`／`compat/` 与部署运行说明只在代码已变且测试通过后同步；不改原实例数据。

## 依赖与风险

依赖 03，前置证据来自 01／02；读取[技术设计](../../specs/tasks/system-design/agent-pool-workbench.md)的恢复与权限章节。现有 `RecoverStale` 不是安全的本池启动证明，必须有负例。操作员也无法观察的外部副作用不能保证 exactly-once，不以另建运行掩盖。

## 并行

sequential

## 结果记录

2026-10-20：03 已完成前台原生批准、默认入口及桌面／手机模拟链路，本工单进入 in_progress。先实现同一原生 run 的版本化撤回及操作回执，再接身份绑定的停止与停止／checkout 已核实后的重入队。复用 run_events、当前领取账本、原生任务准入和 CAS，不新增任务表、队列、恢复库或无条件 reset。同一操作 ID 先查既有回执；返回未知不是允许再派一次。当前尚未实现这些写动作，不作为恢复验收通过。真实 CLI／实体手机／生产切换仍需各自必要条件。

### 2026-10-20 内部撤回协调器第一检查点

已实现 runs 服务内部的版本化撤回：真实浏览器会话确认，原始任务纳秒版本、原始 run 行＋末事件序号的不透明版本，复用宿主任务准入和 SQLite 写权。当前批准、完整原生派发绑定、queued、没有领取账本／会话／启动证据才可由 CAS 取消；回执保存在原生 run_events 的 pool.recovery-withdrawn.v1，与取消同事务提交。相同任务／run／actor／nonce 的原正文重放返回原事件，不更改原始批准、派发键、任务版本或 Done；同 nonce 不同正文拒绝。现在只有 withdraw 内部方法，stop／retry 均失败关闭。

先有有效 RED：撤回及真人／版本／原正文回放均返回不可用；实现后转绿。新增八轮真实领取与撤回竞争，只能一方成功；数据库拒绝取消时事件回滚且无刷新，恢复提交后通知可读到已提交 cancelled，重放不重复通知。进一步发现首次撤回的真实事件序号 0 会被原入队提示吞掉，专用 RED 失败后，恢复通知复用有界原生失效通路并分离去重域，不伪造序号。

最终 -race -p=1 定向组：runs/service 通过 5.649s，orchestrator 通过 1.327s；包含新撤回／身份／版本／重放／八轮竞争／回滚和受影响的池刷新回归。SQLguard 对 internal 通过；精确目标路径 whitespace 检查通过。没有调用执行器、模拟或真实模型；这是存储／服务测试，不是新的宿主二进制或恢复界面验收。当前磁盘上的宿主仍为 03 的全构建产物，新 Go 源尚未做 managed 宿主构建，后续不能用 --no-build 绕过新鲜度。

尚未连接 HTTP、任务服务动作授权或界面写入口；搜索正式源码仅有内部 RecoverPoolRun 声明，没有生产调用。下一步必须先补原生 task.write／session.control／session.exec 权限、工作区隔离与管理权冲突／变更前提，再接只读恢复上下文、同操作查询和公开协调入口；不能把内部真人上下文检查当作完整授权。继续实现严格绑定 execution 的原生停止与停止／资源均核实后的同 run 重入队、旧回调隔离及桌面／手机真实模拟宿主验收。当前不能宣布 04 或整个目标完成，生产与真实提供商仍关闭。

已定位的原生复用点：task 管理权读取 readTaskManagementClaimInTx 与已有 resource_version；不要重新发明管理权表。公开 StopSession 仅按 session 选择执行，不能直接用于带旧 run／claim 前提的停止；应在原生执行所有者边界验证捕获的 execution。原生停止入口在 orchestrator/task_operations.go，生命周期／任务屏障在 pool_quiescent_admission.go；这些位置是后续实施线索，不代表已接线或验收。

### 2026-10-20 恢复授权、窄接口及撤回界面检查点

原生 task 服务已先核对工作区可见性和 task.write，再调用恢复协调器；管理员不能越过他人私有工作区，只读成员不能写入。停止和重试预留的权限分别另需 session.control 和 session.exec，但两项操作仍失败关闭。新增原生管理权版本前提：插件持有、其他人接管，以及确认后取得再释放管理权均不能用旧确认撤回；当前人工持有者的最新版本有正例。上述负例先 RED，再修复转绿。

已连接只读恢复上下文、同操作查询及严格解码的 POST，使用现有路由和原生 runs 服务。缺确认 409、未知字段 400、私有工作区／不属于任务的 run 与不存在的 run 一样 404，内部错误不回传 SQL 详情。相同正文重复提交和 GET 查询返回相同原回执，仍只有一条运行。新增阶段移动窗口负例先复现“批准变化被误报成 404”，修复为可读但不可操作、旧确认 409。最后 runs/service 恢复／竞争组 -race 通过 6.287s。

前端已接桌面原生确认弹层与手机原生底部确认，只有服务端动作资格及当前登录、刷新状态均允许才可准备。保存原始纳秒版本，明确确认才 POST；双击单飞、旧作用域回调和迟到响应隔离。未知响应凭据保存在有界会话存储，重新挂载仍查询同一个操作，不自动重发；不得把此记录当执行证据。操作客户端、确认与结果绑定、钩子先有行为 RED；新增断言又复现旧回调可以执行新作用域提议，修复后通过。四个受影响前端文件共 23 项通过，当前类型检查及 scoped lint 通过；七种实际语言完整，繁体与伪语言由原生脚本生成。

为避免界面把已撤回显示成未知或已停止，单卡历史和有界工作区／摘要读源在原有事件查询内纳入未领取运行的池回执；运行取消和唯一合法撤回事件、无领取、时间一致才投影 withdrawn／原生回执时间。删除回执仍显示 unknown、无结束时间，取消行本身不是停止证据。真实原生 HTTP／SQLite 投影正例先 RED；修复后 handlers 232.130s、poolhistory 2.098s、sqlite 1.140s 的恢复／历史／投影／摘要 -race 定向组通过，SQLguard 通过。没有新增表、迁移、队列或清理旧领取历史。

新的桌面／手机宿主用例使用真实登录、隔离数据库及原生容量计数占位夹具，使目标保持 queued；它不伪造目标领取、开工或停止。主操作通过实际界面，覆盖取消、实际撤回、服务端提交后浏览器响应丢失、刷新及同操作查询。E2E 属于上述行为 RED 后的真实接缝验收，不冒称它曾作为实现前的 RED 门。当前仍不得宣布 04、停止／重试或整个目标完成；真实模型、原实例及生产入口均未改动。

### 2026-10-20 撤回闭环宿主终态

- 本轮 HEAD 实核仍为 e43881c7555372897b57ec51c705f1e05da43c40，新增实现保持未提交。完整 managed 构建后的宿主 SHA-256 为 AC0F2AD6E744ABFF7AB927DF535E6B24A2673173FF577CC4C632A2359CE9DE49；与 03 旧产物不同，没有用旧二进制证明新接缝。
- 桌面 auth 项目同一 worker 连跑原 task-pool-auth 和新 task-pool-recovery-auth，2/2 通过，30.9s；模拟手机同跑原批准和新撤回，2/2 通过，33.9s。随后只改截图等待有限动画和原生更新提示消失，未改应用源码；复用同一新鲜产物分别复核桌面 1/1，14.6s，手机 1/1，16.8s，均 retries=0。
- 两端均从真实界面批准，使目标在原生容量条件下保持 queued；取消不提交，撤回提交后故意中断浏览器响应，状态保持未知。刷新后点击同操作查询取得完全相同原生回执，目标仍同一 run、没有 claim／开工／停止时间，只有原生撤回时间；整段恢复 POST 总数为 1。手机单一原生底部确认、44px 目标、确认按钮在视口、无横向溢出；桌面普通按钮 28px。目标撤回场景没有启动代理；相邻原派发用例仍实际启动模拟 CLI。
- 最终受影响前端组合为 21 文件、233/233；另有最大 32 项凭据、跨宿主／用户作用域、未解决凭据不覆盖和损坏存储失败关闭测试。类型检查、精确路径 ESLint、六项国际化检查通过。公开文档是任务型 how-to 更新，不把隔离试点写成生产功能；公共文档校验器 62/62、47 页通过。规格清单 350 决策／1350 规格通过；规格体积检查仍有既有 CRLF 体积债，本池没有新命中，不改限制来掩盖。
- 最终四张截图保存在隔离工具目录 pool-workbench-evidence-20261020-recovery04：desktop/mobile 的 confirm 和 withdrawn。已查看手机完整底部确认、桌面原生确认和两端撤回结果；首次桌面动画中截图已通过等待有限动画后重新采集替换，不计为最终视觉证据。

下一段直接推进版本化停止与停止／资源核实后的同 run 重入队，不再把撤回这一小段当终点。复用原生 StopExecution 的不可变 execution ID 和 startOwnedLifecycleFollowup 生命周期；先用当前 run／claim／allocation 与 task/session 权限、管理权版本建立提交前提，停止请求回执与实际停止分开，不能持可能被停止事件重入的锁等待外部 I/O。重试必须维持已存在的生命周期和任务屏障、真实 stopped／finished／checkout 空闲证据，保留旧账本及旧回调隔离，再补新排队时间和新 claim 的历史。01／02 正式验收欠项、停止／重试 UI、断开重启和严格 Done 负例仍全部保留，工单 04 与总目标继续 active。

### 2026-10-20 停止与人工重试闭环

本段已实现版本化停止和同 run 人工重试。先捕获真实当前 execution，在原生屏障内提交请求回执，释放锁后由受关闭管理的原生后续工作停止捕获的 execution；旧请求重放不再调用停止。重试在生命周期／任务屏障及写事务内重查管理权、版本、唯一 claim、真实停止、回合、原生清单、checkout、依赖和候选配置，原生终结与重新排队原子提交。旧账本和事件保留，下一领取是新 claim，不建任务表、恢复库或调度器。

有效 RED 后修复：控制事件误抹已知开工；重新排队丢掉当前无 claim 轮次；缺重试因果仍能再次准入；GET 不提供已核实重试；同 run 状态变化后按钮沿用旧资格；实际停止后主卡仍 IN_PROGRESS 被首次派发候选检查误拒绝。最后一项只为已证明的人工重试及已核对回执的后续领取放行，首次 IN_PROGRESS 准入仍拒绝，不回写主卡状态。失败回滚、活动未释放、缺停止凭证、活回合、他人 checkout、宿主忙、非真人与无额度确认均保持拒绝。

当前新鲜宿主 SHA-256：478D7E051607E4C5BDE22B0214DA649BAF0900BF7B4285B8CD7C0F0193320E76。桌面真实宿主＋模拟 CLI 从界面停止持续执行、核实资源、人工重试并再次开工通过；旧停止回执在新 claim 后重放不停止新执行。与撤回同 worker 连跑最终 2/2，33.9s，retries=0；手机相同停止／重试场景已通过，完整相邻组终态另记。账号夹具改为每场景独立私有数据库，避免第二次 setup 误报应用失败；不是放宽认证。

手机完整相邻组最终 2/2，33.5s，retries=0，使用同一新鲜应用构建。桌面／手机停止并重试后的界面截图与停止后原生证据已复制到隔离工具目录 pool-workbench-evidence-20261020-stop-retry，并实际查看两端截图。实际模拟执行具有独立新 claim、新排队／领取／开工时间，原停止凭证 execution_activity_released=true，旧尝试 stopped／finished 保留；不把模拟手机等同实体设备验收。公开 how-to 已更新停止／重试用法及 mock-only 边界，文档检查 62/62、47 页通过；最终 SQLguard 与精确路径 ESLint 通过。

受影响 Go 恢复／领取／终结服务最终组 25.099s，协调器 1.495s；此前 HTTP／历史／投影组 227.262s、poolhistory 1.092s、runs/sqlite 1.646s 通过。前端本段实际运行 task-pool 匹配组 11 文件、54/54，含新增两条 hook RED 回归；类型与精确路径 ESLint 通过。当前不是全库或生产验收；01／02 的正式欠项、04 的重启／断线完整接缝与严格 Done 验收仍保留。下一步直接补恢复后的真实重启、重复领取和完整规模证据，不重新设计或实现第三方已有工作台功能。真实模型、API、原实例、提交推送及生产入口未改。

### 2026-10-20 重启接缝与本机试用入口

本段是原合同的补充验收，没有修改 Go 或页面生产源码，仍使用上述 478D7E05 开头的新鲜构建。停止后真实宿主重启保留完整历史、原操作回执、mock-fast／禁 fallback 配置；随后从界面人工重试产生新领取。另一个场景在实际 ACP 已收到目标任务提示、尚无助手或工具活动时重启；新宿主跨过原生五秒领取周期后，原 run／claim／execution 和空开工时间保持，未再调用目标任务，撤回／直接重试仍禁用。

实际协议证明按 prompt 中的原生 task ID、peer process/session/connection 关联，先有目标调用的正对照，再比较重启前后完整调用序列。初始直接比较所有模拟进程 PID 的断言误计能力探测；已取回原始 ACP 证据确认额外进程只有 initialize/session_new、没有目标 prompt 后修正测试作用域，不把探测算成重复执行，也不拿账本数量代替真实调用。未开工场景另修正“提示尚未到达”的等待边界，未放松最终恰好一次的前提。

最终同 worker 四场景全跑：桌面 auth 4/4，约 1.2 分钟；模拟手机 mobile-chrome 4/4，约 1.3 分钟，均 retries=0。原停止／重试和撤回／响应丢失场景保留，没有用新场景替换它们。截图及原始 ACP 证据保存在隔离工具目录 pool-workbench-evidence-20261020-restart。测试／配置层变更无需重新构建；应用二进制哈希已实核未变。

已通过现有 isolated-instance.psm1 的子环境隔离复用原生宿主，提供本机临时试用，不是生产部署。入口 http://127.0.0.1:48429/task-pool，仅回环可达、认证开启、mock-only；数据根沿用隔离启动脚本的 `$taskPreviewRoot`，与原实例不同。已创建独立空示例仓库、主子卡与待批准任务，未批准或自动启动模型；初始化提交仅在临时示例仓库，项目源码未提交。示例账号仅用于该临时宿主，不保存真实模型密钥。

本地 tools/Start-KandevPreview.ps1 是这份隔离副本的启动配置，不是新公共 CLI；端口占用时拒绝第二实例，不构建、复制旧库或关闭原宿主。此前已实际用该配置重启同一试用数据，并在浏览器核对仍已登录、示例卡及“批准并入池”可用；当时工具运行句柄为 84569。本次仅修正命名，没有再次重启或迁移数据。Ctrl+C 时原生 Windows 临时工具清理有警告，未删除或强制清理未知临时目录，启动端口检查通过；不能据此宣称全机进程／临时文件无残留。

下一段应按原四份工单逐项汇总当前验收，补齐严格 Done 与兼容交付的实际命令，并对存储一致性既有 Windows 基线逐条区分；不得仅因试用可操作就将 01／02／04 或整个目标标完成。公开 how-to 的操作合同未变，本段仅更新内部检查点、测试路径与本机试用说明。
