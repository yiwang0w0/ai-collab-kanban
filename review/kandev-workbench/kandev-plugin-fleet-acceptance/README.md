# Kandev 交付验收插件

Windows 单机复用试点。Kandev 负责看板、CLI 会话、工作区和原生审计；本插件只复用 ai-fleet-kanban 的交付检查并记录人工验收，不启动旧看板或第二个验收服务。

这是本地开发版，尚未公开发布。固定宿主基线为 **v0.97.0 / e43881c7555372897b57ec51c705f1e05da43c40**，必须应用 `compat/kandev-v0.97.0-fleet.patch`。共享校验固定于 ai-fleet-kanban **v0.24.0 / 0cf92696e9cb236fb061b54bb781a85f01bde146** 加 `compat/ai-fleet-kanban-v0.24.0-shared-gate.patch`。两个基线分别记录在 `.kandev-sdk-ref` 与 `.fleet-checker-ref`。插件不能在未打补丁的同版本宿主上完成验收；最低版本号本身不代表严格策略已经启用。

## 安全边界

- 本批只支持 Windows amd64、SQLite、原生 Worktree 执行器、单任务单仓库；不支持 Local 执行器、远端目录和多仓库验收。
- 必需条件为 `fleet.acceptance`，只允许宿主启动配置指定的插件安装身份写入有效证据。直接完成、原生人工覆盖、删除必需条件、原生证据写入均不能绕过。
- 人工通过／驳回使用宿主认证的管理员动作；严格策略还拒绝匿名模式的合成管理员。浏览器传来的操作者和磁盘路径不作为权限依据。
- 实现和审查必须属于同一任务、来自两个不同且由操作员指定的运行时记录。宿主最终检查已完成轮次的先后顺序、会话版本与任务版本；这不证明审查内容的语义正确性，仍须人工阅读。
- 当前 HEAD、工作区清洁状态、实际产物哈希和校验代码版本在 Done 时重新检查。任务／会话／交付变化、无法运行校验程序均拒绝完成。
- 完成记录保存在原生条件和不可变审计历史；Host state 只缓存候选与重试意图。管理权冲突不会被插件接管，须由操作员处理。
- 此策略保护正常应用入口，不是操作系统沙箱，不能阻止本机管理员直接修改程序、数据库或文件。已完成任务不会被后台持续重验。

## 准备与构建

使用 PowerShell 7、Go 1.26、Node 24、Git；三个仓库为同级目录：

```text
kanban-reuse/
  board/                            # 共享 gates/delivery_check.js 与 cli/check-delivery.mjs
  kandev/                           # 固定基线加严格策略补丁
  kandev-plugin-fleet-acceptance/     # 本仓库
```

在干净的固定基线宿主目录应用补丁，不要重复应用：

```powershell
git -C ../kandev apply --check ../kandev-plugin-fleet-acceptance/compat/kandev-v0.97.0-fleet.patch
git -C ../kandev apply ../kandev-plugin-fleet-acceptance/compat/kandev-v0.97.0-fleet.patch
git -C ../board apply --check ../kandev-plugin-fleet-acceptance/compat/ai-fleet-kanban-v0.24.0-shared-gate.patch
git -C ../board apply ../kandev-plugin-fleet-acceptance/compat/ai-fleet-kanban-v0.24.0-shared-gate.patch
./scripts/verify.ps1 -Package
```

若 Go 不在 PATH，可传 `-GoExe <go.exe 绝对路径>`。包名为 `kandev-plugin-fleet-acceptance-0.1.0.tar.gz`，只包含清单、Windows 可执行文件、原生 UI 与官方打包器生成的校验和。保留了模板的可选 `recipes/`，它们不属于产品功能，也不打包。

`docs/repository-baseline.md` 及 `scripts/stable-host-smoke.mjs` 保留为上游模板历史资料，不是本产品的当前操作说明或验收依据；本产品使用此 README、`scripts/verify.ps1` 和 `tests/pilot-smoke.mjs`。本地模板远端已命名为 `upstream-template`，不应向模板仓库推送产品代码。

宿主沿用其现有构建和启动流程，另建 `KANDEV_HOME_DIR`，不要复用原实例或旧看板目录。开发构建可设置 `KANDEV_WEB_DIST_DIR` 指向新构建的 `apps/web/dist`，并通过 `kandev-fleet.exe __backend` 启动；不要把开发模式误作已发布安装包。

## 可选：任务池工作台增量

`compat/kandev-v0.97.0-agent-pool.patch` 是宿主任务池增量，不是插件包，也不替代严格验收补丁。顺序固定为干净的 `e43881c7555372897b57ec51c705f1e05da43c40` → `kandev-v0.97.0-fleet.patch` → `kandev-v0.97.0-agent-pool.patch`。不要在已有未提交改动的开发副本、其他版本或原实例上执行；本地现有开发副本已经包含这些改动，不能再应用一次。

在另一份干净的固定基线副本中，先核对 HEAD 与干净状态，再执行：

```powershell
# 此处 ../kandev 必须是另一份干净副本，不是正在开发或运行的目录。
git -C ../kandev rev-parse HEAD
git -C ../kandev status --porcelain
git -C ../kandev apply --check ../kandev-plugin-fleet-acceptance/compat/kandev-v0.97.0-fleet.patch
git -C ../kandev apply ../kandev-plugin-fleet-acceptance/compat/kandev-v0.97.0-fleet.patch
git -C ../kandev apply --check ../kandev-plugin-fleet-acceptance/compat/kandev-v0.97.0-agent-pool.patch
git -C ../kandev apply ../kandev-plugin-fleet-acceptance/compat/kandev-v0.97.0-agent-pool.patch
```

每条命令须检查退出码，检查失败立即停止；不要强制应用或重置工作区。补丁源清单及摘要见 `compat/kandev-v0.97.0-agent-pool.manifest.json`，摘要的源码比较仅归一化 CRLF/LF，不忽略其他空白或内容。该增量只收录本功能源码、测试、文档和 taskPool 语言文件，不含数据库、二进制、日志、账户或设备标识。

应用后按宿主原生构建流程构建 Web、后端和助手，另建私有数据目录、只监听回环并启用认证；本增量仅在同时显式设置 `KANDEV_E2E_MOCK=true`、`KANDEV_MOCK_AGENT=only` 的模拟宿主中接通。它不接通真实 CLI／API、不自动安装或配置本验收插件，也不授权生产迁移。任务池操作及逐项验收说明位于宿主 `docs/public/tasks-and-workflows.md` 与 `docs/plans/agent-pool-workbench/acceptance-audit.md`。插件继续沿用以下原生安装、工作区授权和严格完成配置。

## 配置单机试点

1. 创建独立的数据目录，只监听 `127.0.0.1`，开启 `features.auth`。第一次使用通过原生向导设置管理员。
2. 在宿主启动配置中填入下面五项。安装身份和仓库尚未创建时可使用 `plugin:pending-installation` 与 `pending-repository`，这样任务仍被阻止完成；创建普通任务前必须换成实际值。
3. 在原生界面安装本插件，为目标工作区批准 `host.v2.read:tasks`、`host.v2.read:sessions`、`host.v2.write:tasks`。
4. 从插件授权页取得真实安装 ID，从仓库页取得仓库 ID；更新宿主配置并重启。重新安装会改变安装身份，不能静默接管旧身份。
5. 在插件设置中填写程序路径、仓库与人工验收步骤 ID，以及两个运行时的**宿主设置记录 ID**。它们不是 `claude-acp`／`codex-acp` 字符串；由原生 `/api/v1/agents` 中相应记录的 `id` 确认。

```yaml
features:
  auth: true
server:
  host: "127.0.0.1"
tasks:
  completionVerifierId: "plugin:<安装 ID>"
  completionNodePath: "C:/完整路径/node.exe"
  completionCheckerPath: "C:/完整路径/board/cli/check-delivery.mjs"
  completionRepositoryId: "<Kandev 仓库 ID>"
  completionRepositoryRoot: "C:/仓库根目录"
```

`completionRepositoryRoot` 和插件的 `repository_root` 必须指向同一 Git 仓库，且它的 `git worktree list --porcelain` 应能列出宿主给实现会话分配的分支。若 Kandev 使用独立托管克隆，应填该托管 Git 根目录，不要填另一个同名克隆。仓库显示名需包含上游可用的 ASCII 字符，例如 `ai-fleet-kanban`。

配置的 Node、脚本、仓库必须为绝对路径；任何一项缺失不会降级放行。关闭策略仅适用于整体退出隔离试点，不应被当作完成某张卡的操作。

## 工作流

沿用 Kandev 原生工作流建立“待办 → 方案 → 实施 → 独立审查 → 人工验收 → 完成”。方案和最终验收由人确认；实施选择 Claude 配置，审查选择 Codex 配置，完成步骤开启原生 `complete_task_on_enter`。本插件不替代原生计划功能，也不自动启动、重派或移动任务。

任务使用 Worktree 配置，完成实现并提交文件，再运行独立审查。进入人工验收后，从原生面板菜单打开“交付验收”，填写产物路径并选择两个会话，点击“检查并提交”。管理员阅读审查与候选内容，勾选确认后通过，或填写原因驳回。最后通过原生工作流进入完成；放行时仍会实时复核。

检查不调用模型，不消耗 Claude/Codex 额度。真正的 CLI 实现与审查仍会消耗原有订阅额度；API 执行与预算路由不在本批范围内。

## 验证

```powershell
./scripts/verify.ps1 -Package
node tests/pilot-smoke.mjs
```

后一个命令需要固定补丁版 `bin/kandev-fleet.exe`、`bin/agentctl.exe`、`bin/mock-agent.exe`、已构建的原生 Web 与该宿主的 Playwright 依赖。它只启动回环端口下的独立数据库和模拟代理，结束后停止本次进程树，保留 `.build/pilot-*` 日志和截图。模拟测试不能替代真实 CLI 登录、额度和模型任务验收。

本次隔离模拟已验证真实插件安装／动作中继、不同模拟运行时的完整轮次、人工通过、无回执及批准后改文件拒绝完成、原生条件防删除、手机触摸操作、宿主重启后的任务／历史／候选恢复。插件及宿主受影响测试通过竞态检测，公共文档校验通过。上游通用一致性套件在本机的 CRLF 夹具摘要与 `/tmp` 路径测试未通过；配置包也有已在固定基线复现的 Windows 路径断言失败，未将这些算作通过。详细边界见实施记录。

## 故障与回退

- `session repository checkout not found`：确认使用 Worktree，不是 Local；仓库绑定应使用原生 `repositories` 契约。
- 授权／安装身份不匹配：检查当前工作区批准、清单代数和宿主配置；不得用匿名模式或修改 actor 字段替代。
- 候选陈旧：重新检查，重新人工批准。不要移除必需条件；失败和不可测不是“没有问题”。
- 插件候选缓存损坏：保留原生审计，按宿主备份流程恢复或在操作员确认后重新配置；不要把损坏记录当作已通过。
- 回退：停止隔离实例，使用原宿主和其原始数据目录。不要让未打补丁的宿主打开试点数据库并继续办理受保护任务。原看板、原工作树和原数据未被迁移或覆盖。

本地验证范围与剩余验收见同级 `board/docs/plans/kandev-reuse-implementation.md`。没有创建 GitHub 仓库、标签、PR 或市场条目；发布前须设置真实独立仓库地址并重新执行发布检查。
