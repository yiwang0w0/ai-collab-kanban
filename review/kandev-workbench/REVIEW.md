# 独立审查任务

请审查当前分支的固定提交。只读检查，不调用真实模型，不自动派发任务，不调整完成门禁，也不将模拟结论表述为生产可用。

## 主要入口

- 派发／领取：`kandev/apps/backend/internal/runs/`、`internal/task/service/`、`internal/task/repository/sqlite/` 与 `internal/orchestrator/`。
- 证据关联与有界投影：`internal/task/poolhistory/`、`internal/task/poolview/`、`internal/task/statussummary/`。
- 协议来源与执行身份：`internal/agent/runtime/lifecycle/`、`internal/agentctl/server/adapter/`。
- 桌面／手机：`kandev/apps/web/components/task-pool/`、`lib/api/domains/`、`hooks/domains/task/` 与 `e2e/tests/auth/`。实际路径以源码清单为准。
- 严格完成：宿主 `internal/task/`、插件 `server/` 与 `board/gates/delivery_check.js`。

## 优先核查

1. 派发、实际入队、领取、分配、明确开工、停止、结束与主卡 Done 是否独立记录；是否存在用赋值、进程存在或旧时间戳猜测开工的路径。
2. 领取账本、run／task／session／execution／turn 是否完整绑定；旧回执、重启、并发、重复请求、响应丢失或配置变化能否导致重复派发。
3. 真人确认、工作区权限、当前阶段／版本、任务占用和依赖检查是否同时覆盖 HTTP、WS、创建与原生移动入口。
4. 有界投影是否保持 50 卡／50 次尝试上限，跨页及清理后的缺证据是否明确待核实，读取是否可能偷偷创建或重放任务。
5. 普通调度／旧 Office 恢复是否会误接管保留键任务；人工恢复是否真正核验当前领取、执行停止、checkout 及资源释放。
6. Done 是否始终核对当前 HEAD、产物摘要、代码版本、不同运行时、会话先后及真人验收；缺证据、无法测量、删除条件或绕行 API 能否放行。
7. 模拟代理开关是否限制在既有隔离组合，真实提供商与生产构造是否仍关闭；是否出现凭据继承、意外网络暴露或隐藏的真实额度调用。
8. 手机确认、取消、停止／重试、父子与依赖跳转、44px 触摸目标及待核实提示是否有真实宿主断言，而不是只靠静态截图。

## 输出约定

先列可复现缺陷，按严重程度排序。每项给出文件、行号、触发条件、实际与预期行为、影响及最小复现／建议测试。把确定缺陷、需要补充证据的问题和风格建议分开。没有复现的推测不能写成已证实漏洞。

历史测试结果见验收记录；本次重新运行了哪些检查，以 `VALIDATION.md` 为准。请不要将上游已复现的 Windows／CRLF 基线失败自动归因本功能，也不要因此忽略新失败。
