---
status: current
system: tasks
created: 2026-10-19
owners:
  - ai-fleet-kanban
requirements:
  - REQ-TASKS-AGENT-POOL-002
  - REQ-TASKS-AGENT-POOL-003
---

# 任务池单卡历史的有界只读契约

## 范围与权威

本文细化[工作台设计](agent-pool-workbench.md)的单卡历史。实现位于 tasks 所有的 poolhistory 投影、原生任务仓储、任务服务和 HTTP 处理器；查询不写入或调度。用户已选 A 的[原生清理凭证](agent-pool-history-clearance.md)为迁移窄例外。沿用[原生运行权决策](../../../decisions/2026-10-16-agent-pool-native-run-authority.md)、[创建批准](agent-pool-creation-release.md)及[执行终结](agent-pool-execution-retirement.md)。

只读接口不批准任务、不入池、不领取、不启动／停止或恢复执行，也不回填账本。原生主卡的业务状态、完成动作与严格 Done 门禁均独立存在；历史中的 ended 只是本轮队列执行终结。[工作区基础列表](agent-pool-workspace-projection.md)与 [TaskStatusSummary 的摘要／提交后刷新](agent-pool-summary-refresh.md)已复用本投影；剩余读投影和界面以[工单 02](../../../plans/agent-pool-workbench/task-02-pool-projection.md)及后续工单为准。

## HTTP 与权限

GET /api/v1/tasks/:id/pool-history 接受 limit 和 cursor。省略或零 limit 使用 50，负数、非整数及大于 50 拒绝。合法无记录返回 items: []，不是数据源失败。

任务服务为整个读取创建不超过 3 秒的上下文，并保留更早的调用者期限。先读取任务的工作区定位，拒绝空定位，再复用原生工作区读权限；未授权任务与不存在任务返回相同 404。只读事务再次验证任务仍属于已授权的工作区，来源快照的 task／workspace 标识也须匹配。这里传递的是查询预算，不将它声称为已实测的端到端 SLA。

缺少只读能力、数据库读取失败、nil／错作用域快照或不支持的存储返回固定 503；内部错误不返回给浏览器。已知但不足的权限保留原生 403 语义。参数错误返回固定 400，不回显游标或内部诊断。全局 HTTP 认证沿用宿主现有 middleware，没有新增公开匿名例外。

## 来源与返回字段

只返回 task_id、snapshot_version、items 和 next_cursor。条目把计划配置 planned_agent_profile_id 与实际领取配置 claimed_agent_profile_id 分开；后者须有真实不可变领取账本。技术 ID 只描述已有来源，不允许浏览器签发。

| 字段／事实 | 原生来源 | 缺失时 |
| --- | --- | --- |
| entry_id、released_at | task_step_transitions 的 pool_release_v1、真人、契约与 occurred_at | 不补造批准 |
| run_id、queued_at | 稳定派发键对应的原生 runs 与 requested_at | 仅保留已知批准 |
| claim_id、claimed_at | office_launch_ledger 的不可变 ID 和 claimed_at | 无领取者／时间 |
| session／execution／turn／执行配置 | 已验证的 pool.execution-allocated.v1 | 不借其他会话猜测 |
| started_at | 同次绑定及 pool.work-observed.v1 的 created_at | 不从启动、欢迎消息或负责人推导 |
| turn_ended_at、结果 | 同分配的 pool.turn-ended.v1 | 不等同进程停止 |
| stopped_at | 原生控制确认的 pool.execution-stopped.v1 | 不把逻辑 stopped 当停止证明 |
| ended_at | 引用精确 stopped_seq 的 pool.execution-finished.v1 与对应运行终态 | 不从 TaskState 或普通 finished 推导 |

未确认时间显式为空；不使用查询时钟、任务更新时间或相似时间填补。snapshot_version 是当前页事实及游标的稳定摘要，不含查询当前时间；同一组事实重复读取或重启重建后保持相同。它不是新的业务版本，也不能当作恢复操作的授权版本。

历史不输出原始 run payload、提示、转录或完整日志。任务权限定位不水合任务正文／关系；运行读取仅选择身份列及有字节上限的池封装，事件只选择 pool.* 的有界元数据。

## 单次快照与游标

SQLite 来源通过 reader 的只读事务读取任务归属、阶段账本、运行、领取统计和目标回执。分页顺序为 entry ID、原生 claimed_at、run ID、claim ID 依次降序，不把同一个 run 的多次领取合并。

游标是带版本及目标 task 的规范编码，只是查询位置。它可继续遍历同一次阶段进入中的旧领取，不能跳到下一阶段后丢掉剩余 attempt；错任务、错误格式或版本拒绝。所有 SQL 数据值均参数绑定，不将游标内容拼进 SQL。

每页最多 50 项。内部最多读取 52 条阶段元数据，用于容纳当前游标所在进入及下一页判断；运行候选最多为每个键两条再加溢出探测。当前领取统计按已验证的唯一运行批量读，选择行最多为 limit+1。选中领取的池事件每次最多 16×选中项数再加溢出探测，单份封装／事件正文最多 16 KiB。超限保留未知，不截掉问题后冒称正常；不按卡逐一加载全量会话。

SQL 查询路径当前限定 SQLite；PostgreSQL 在执行专用 SQL 前拒绝。单卡读取本身不新增 schema 或索引；A 清理凭证的原生持久化与历史／列表／摘要的实际查询预算另见清理设计和工单 02。

## 关联校验与状态

运行绑定复用 PoolReleaseSnapshot.DispatchKey／MatchesRun，核对 task／entry／阶段、真人与批准时间、固定 Profile、原生运行列。无效候选先过滤，唯一有效候选才可用，多解返回未知。批准尚无运行时只显示 released，不能冒充 queued。

实际领取来自 ledger，不以 claimed_at 充当身份。当前领取还须与原生 run 时间标记唯一对应；同时间多行或作用域矛盾不能猜选。旧领取仍各自保留，current 只说明它匹配当前任务阶段及该运行的领取，不是进程心跳或主卡完成证明。

回执解析复用原生 PoolClaimStart.Valid、ValidAllocationFor、ReceiptIdentity、TurnEndIdentity 和 StoppedReceipt。会话、执行、首轮 generation、turn、Profile 与 operation 来源精确匹配。错误来源、旧轮次、模糊／多份有效记录、未知版本／类型及无法归属的坏回执均为 unknown；有效与无效混合时先排除无效候选，不让无关行覆盖合法事实。

已知状态包括 released、queued、claimed、started、turn_ended／turn_failed、stopped、ended 与 unknown。迟到的同轮工作可补上已结束回合的开工事实，但不使旧 attempt 变成当前活跃。后续终结证据异常时保留已经确认的开工时间，同时把总体状态标未知。资源释放为 false、错误停止引用或原生终态矛盾不能显示正常 ended。

## 验证与未完成项

HTTP／SQLite 夹具验证真实发布与领取、同 run 多 claim 分页、51 条记录的 50+1 边界、错任务游标、权限、数据源错误／期限／缺能力、读取前后源计数及任务版本不变；SQLite query_only=ON 的正例独立约束无写行为。序列化契约夹具使用原生类型和身份工厂，但不冒充物理执行。

私有真实宿主＋mock-agent 还验证登录权限、实际队列／Git Worktree、七类回执及逐项时间来源、严格 Done 409、停止与二进制重启。真实提供商、API 模型执行、生产切换及公开发布未授权。存储整组的既有失败和缺少实际 PostgreSQL 验收仍须如实保留。

基础列表、关系计数、原生摘要、清理标记、前台刷新及关系导航均已按四份工单实现并有隔离证据；具体范围见[隔离交付核对](../../../plans/agent-pool-workbench/acceptance-audit.md)。单卡接口本身不证明整工作台、真实模型或生产验收。

## 需求映射

| 需求 | 本文承担的边界 |
| --- | --- |
| REQ-TASKS-AGENT-POOL-002 | 原生时间与 attempt 关联、迟到和终结语义 |
| REQ-TASKS-AGENT-POOL-003 | 有权限、有上限、有明确错误的历史 API；界面不在本段完成 |
