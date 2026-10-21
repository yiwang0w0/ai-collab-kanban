---
status: current
system: tasks
requirements:
  - REQ-TASKS-AGENT-POOL-001
  - REQ-TASKS-AGENT-POOL-002
  - REQ-TASKS-AGENT-POOL-003
  - REQ-TASKS-AGENT-POOL-005
---

# 池历史清理凭证

## 目的与归属

清理后仍能核验一次批准已经派发，不能重新制造运行。
tasks 拥有可观察轨迹；runs 拥有身份模型及发布去重；
Office 仅继续拥有现有 schema 安装和历史维护政策。
本设计是工作台零迁移约束经用户选择 A 后的窄例外。

## 需求映射

| 需求 | 契约 |
| --- | --- |
| REQ-TASKS-AGENT-POOL-001 | 事务内检查清理凭证，旧批准不能再次入队 |
| REQ-TASKS-AGENT-POOL-002 | 原 run 与不可变 claim 关联保留，开工证据不补造 |
| REQ-TASKS-AGENT-POOL-003 | 同一 ACL／最大 50 项的有界投影 |
| REQ-TASKS-AGENT-POOL-005 | 清理及升级不触发隐式重派 |

## 数据与持久化

- run_pool_history_clearances：规范 dispatch_key 主键、唯一 run_id、
  format_version=1、workspace_id、task_id、entry_id、release_json、
  requested_at、cleared_at。release_json 只含原生 PoolReleaseSnapshot，
  不保留任务正文、提示、转录或已删除的执行回执。
- run_pool_history_policy：单行 version=1 和 activated_at，
  在首次原子安装时记录；重启和迁移重放不改写。
  这是升级安全边界，不是历史事件时间。
- 清理凭证与原始运行没有级联外键，不因删 run 丢失。
  本批不设置凭证 TTL，也不提供客户端删除或修改入口。
  工作区／任务不可见后仍按既有 ACL 拒绝读取；不借删除重建身份。
- schema 由现有 Office 初始化安装，SQLite 池路径可用；
  PostgreSQL 池路径在 SQL 前继续拒绝，不据此宣称实际 PG 验收。

## 清理与发布顺序

既有 DeleteRunBatch 的选择、终态／年龄／每 Profile 底数不变。
每事务按既有 500 host 参数上限分块读取被选运行；
对池键或池 reason 的记录核验原生生产形状、完整绑定和规范键。
每个凭证最多 16 KiB，异常／冲突／不支持版本使整个事务回滚。
凭证插入、卫星删除、run 删除重验和提交是一个原子结果；
重验数量不足时现有重试会连同凭证一起回滚。
普通非池运行不写凭证，也不豁免清理。

发布器沿原任务写权预留后，在同一事务先查现存 run，再查清理凭证。
现存 run 仍需完整绑定才可 deduped；清理凭证命中返回
pool_history_cleaned，QueueOutcomeNone，不返回虚构 Run。
新批准没有凭证且晚于 activated_at 时可走原准入；
更早且无 run 的批准返回 pool_legacy_dispatch_unverified，要求新批准。
迁移不从相近时间、领取或摘要回填已丢失的关联。
SQLite 单写者保证清理提交与发布读取的串行边界；
锁失败／忙／取消是失败，不承诺自动安全重试。
无生产调用的 CleanExpired 不得绕过此规则清理池运行；
该入口只清理非池运行，池运行继续由 DeleteRunBatch 所有。

## 只读显示与刷新

历史、工作区和摘要批量读取同一凭证，并核对原批准、作用域、
规范键、版本、字段／字节界限和不存在冲突 live run。
清理后的条目为 unknown / history_cleaned，current=false；
只显示凭证保留的派发／排队事实与原生领取账本的 claim／领取时间。
开工、会话、回合、停止和结束字段为空，不从缓存恢复。
多次领取仍沿单卡既有游标逐项分页，列表仅显示确定的最近领取，
不是当前执行权。无法核验的凭证为待核实，不泄露关联标识。

新增凭证读取为常数批量成本；更新实际查询预算而不允许 N+1。
已有 summary CAS、重建、连接失效和完整替换语义不变；
清理后由原生重建读取新事实，不把事件入总线当持久化 ACK。
查询不写回凭证、run、claim 或任务状态。

## 失败与验证

主回归是实际 DeleteRunBatch 后单卡／工作区不退回未派发，
且相同批准无法创建 run；清理前 deduped 为同夹具正对照。
补充凭证写失败／损坏回滚、普通清理、迁移重放、
原生领取分页、未知旧批准、新批准、并发／重启和只读预算检查。
全部使用隔离 SQLite／真实宿主＋模拟 CLI，不调用真实模型。
未完成的验证留在工单 02，不将局部通过当全目标完成。

## 决策

- [原生清理凭证 ADR](../../../decisions/2026-10-19-pool-history-clearance.md)
- [工作台主设计](agent-pool-workbench.md)
- [工单 02](../../../plans/agent-pool-workbench/task-02-pool-projection.md)
