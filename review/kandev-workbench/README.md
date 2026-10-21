# Kandev 任务池工作台审查入口

这是供独立 AI／人工审查的 **2026-10-21 源码快照**，不是生产发布，也不将本仓库根目录的旧看板替换成 Kandev。请固定审查分支的提交 SHA，不按不断变化的主分支或截图判断实现状态。

## 先看什么

1. [任务池需求](kandev/docs/specs/tasks/requirements/agent-pool-workbench.md)、[开发计划与四份工单](kandev/docs/plans/agent-pool-workbench/plan.md)。
2. [隔离验收记录](kandev/docs/plans/agent-pool-workbench/acceptance-audit.md)与[本次发布核验](VALIDATION.md)。原始日志、截图、数据库与试用账号不随包公开。
3. [审查清单](REVIEW.md)：优先检查派发、领取、开工的可信来源，以及严格 Done 与人工恢复边界。
4. [验收插件说明](kandev-plugin-fleet-acceptance/README.md)及[共享校验实施记录](board/docs/plans/kandev-reuse-implementation.md)。
5. [下一阶段：全站信达雅中文化](NEXT-STEPS.md)，包含权限警告的拟用中文及验收边界；本快照未宣称已完成该改造。

## 目录与权威

| 目录／文件 | 内容 | 不代表什么 |
| --- | --- | --- |
| `kandev/` | 481 个已核对的宿主功能文件，以及上游许可证和工程指南；便于直接浏览的源码覆盖层 | 不是完整、可直接启动的 Kandev 克隆 |
| `kandev-plugin-fleet-acceptance/` | 插件源码、测试、依赖锁和兼容补丁；保留模板资料并在原 README 中注明其性质 | 不是发布好的插件安装包或市场条目 |
| `board/` | 共享交付校验的六个变更文件，以及许可证、NOTICE 与原工程规则 | 不是另一份正在运行的旧看板实例 |
| `SOURCES.json` | 源码来源、固定基线与逐文件 LF/UTF-8 摘要 | 不包含原开发机路径、凭据或运行数据 |
| `SNAPSHOT.json` | 本审查包逐文件原始字节 SHA-256 | 不替代独立测试或安全审计 |
| `tools/verify-snapshot.mjs` | 只读检查包完整性、来源摘要、宿主清单及禁止发布的文件类型 | 不启动服务、调用模型、安装插件或批准任务 |

本目录的旧实施报告保留其写作时点和结果，包括“未提交／推送”等当时边界。此次新增的是公开审查快照，不能把旧报告中的本地测试自动提升为本次 CI、真实模型或生产验收。

公开源码镜像只统一 CRLF/LF 为 LF，未改变程序内容；兼容补丁保留原始字节和原有 SHA-256。目录内 `.gitattributes` 固定该规则，避免其他机器检出时导致本包字节摘要漂移。

## 固定基线与重建

工具：Git、Node 24、PowerShell 7；进一步构建插件需要 Go 1.26。只在新建的审查／验证目录执行，不能对现有试用、原数据目录或脏工作区重复应用补丁。

先核对本包（无网络、无模型调用）：

```powershell
node review/kandev-workbench/tools/verify-snapshot.mjs
```

在另一空目录建立三个同级目录：`board`、`kandev`、`kandev-plugin-fleet-acceptance`。每条命令都检查退出码，失败即停止，不强制应用、不重置工作区。

### 宿主

克隆 [kdlbs/kandev](https://github.com/kdlbs/kandev)，检出 `e43881c7555372897b57ec51c705f1e05da43c40`，确认工作区干净。依次对该克隆应用本包插件 `compat/` 下两份补丁：

1. `kandev-v0.97.0-fleet.patch`：严格完成门禁。
2. `kandev-v0.97.0-agent-pool.patch`：任务池工作台增量。

每次先执行 `git apply --check <补丁绝对路径>`，成功后才 `git apply <补丁绝对路径>`。增量清单 `kandev-v0.97.0-agent-pool.manifest.json` 定义 481 个文件的 LF/UTF-8 摘要；`kandev/` 提供相同结果的可浏览覆盖层。不要直接把覆盖层当作完整仓库覆盖运行实例。

### 共享校验

克隆本仓库并检出公开分支上的固定提交 `0afe0b9f39af286c8c97c391e7da0d28c18f9b70`；必要时显式 `git fetch origin <该完整 SHA>`。确认工作区干净，依次应用：

1. `compat/ai-fleet-kanban-public-base-to-v0.24.0.patch`：公开基线到本地既有 `0cf92696e9cb236fb061b54bb781a85f01bde146` 源码树的依赖差异。其 17 个文件的变化是此前旧看板开发基线，不是本次任务池功能；保留它是为避免依赖一个尚未公开的提交对象。
2. `compat/ai-fleet-kanban-v0.24.0-shared-gate.patch`：本次复用共享交付校验的六个文件。

两份补丁都先 `git apply --check`，再应用。`board/` 提供第二份补丁之后的六个完整文件供审查。只应用第一份补丁不会创建原提交对象或其提交签名，所得源码树应与该固定本地基线等价。

### 插件

把本包 `kandev-plugin-fleet-acceptance/` 复制为上述同级插件目录，按照其中 README 构建。Go 的本地 replace 和前端 SDK 指向同级完整宿主，不能指向本包的不完整宿主覆盖层。模板原有的 `tests/ui-action.test.js` 已在开发版移除，以当前产品 `tests/ui-panel.test.js` 为准；该删除记录在 `SOURCES.json` 中。

重建不等于授权运行。任务池目前仅在同时显式启用 `KANDEV_E2E_MOCK=true` 和 `KANDEV_MOCK_AGENT=only` 的隔离模拟宿主中接通；真实 CLI／API、实际额度、跨机器和生产迁移仍需单独授权与验收。

## 许可与公开范围

- `kandev/` 及对应宿主补丁保留上游 [GNU AGPL v3 许可证](kandev/LICENSE)，不是本仓库根目录 Apache-2.0 声明的重新授权。
- 插件保留其 [MIT 许可证及模板版权声明](kandev-plugin-fleet-acceptance/LICENSE)。
- 共享校验保留 [Apache-2.0 许可证](board/LICENSE)和 [NOTICE](board/NOTICE)。其他上游依赖继续使用各自许可。

不公开数据库、账号、口令、令牌、模型密钥、个人目录、运行日志、截图、二进制、插件归档、缓存或工作树数据。审查包不会改变正在运行的本机试用，也不提供外网访问入口。
