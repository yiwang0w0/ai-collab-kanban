---
id: "03-workbench-ui"
title: "桌面与手机任务指挥界面"
status: done
wave: 3
depends_on:
  - "02-pool-projection"
plan: "plan.md"
requirements:
  - REQ-TASKS-AGENT-POOL-003
  - REQ-TASKS-AGENT-POOL-004
acceptance_criteria:
  - AC-TASKS-AGENT-POOL-003.1
  - AC-TASKS-AGENT-POOL-003.2
  - AC-TASKS-AGENT-POOL-003.3
  - AC-TASKS-AGENT-POOL-003.4
  - AC-TASKS-AGENT-POOL-004.1
  - AC-TASKS-AGENT-POOL-004.2
  - AC-TASKS-AGENT-POOL-004.3
system_design:
  - ../../specs/tasks/system-design/agent-pool-workbench.md
---

# 工单 03：桌面与手机任务指挥界面

## 结果

当前隔离结果包含原生批准、默认入口偏好、父子及依赖／阻塞双向导航。命名清理后的组合与补充关联断言已通过真实宿主桌面／模拟手机验收，28px／44px 及两端截图已核对；最新构建身份与范围见[隔离交付核对](acceptance-audit.md)。后面的检查点按当时状态保留，不表示当前恢复动作仍为只读。

交付一个可选择为默认入口的“任务指挥”视图，使用同一读模型展示池、执行状态和关联。原生所有工作区、看板、会话、Changes、终端与验收入口保留。

## 包含

- 原生导航／SPA 路由和页面偏好；桌面列表＋预览、手机单列＋直达完整详情。
- 共享卡片摘要、阶段与执行状态分离、时间线、父子／依赖双向跳转。
- 原生新建／阶段移动／打开工作台动作，不自行模拟动作成功；i18n、加载／空／错误／未知状态。

## 不包含

- 自写终端、对话、Git 管理、关系图库、跨机器看板或新的 Agent 设置中心。
- 恢复写动作和真实模型调用；恢复入口先显示状态／原因，工单 04 再接可执行动作。

## 验收

1. UI-01／03 的信息顺序成立，卡片能直接回答谁领取、何时开工、卡在哪，技术 ID 收纳到详情；全部原生功能保留入口。
2. UI-02 的手机入口、筛选抽屉、直达详情、返回位置和安全区可实际触摸操作；无页面横向溢出、目标实测至少 44px、桌面普通动作 28px±1px，手机不覆盖桌面偏好。
3. 同一 mock 任务完成入池、领取、活动确认和关系导航；UI-04 区分读失败与空池。打开／刷新页面不增加运行数，缺验收证据时原生 Done 仍被拒绝。

## ASCII UI preview

以下是[完整预览](plan.md#ascii-ui-preview) UI-01／02／03／04 的实施摘录，数字与标题仅作示例。

```text
UI-01 桌面
+------------+----------------------+--------------------------+
| 任务指挥   | 待我处理 | 任务池     | 当前卡片轨迹             |
| 原生看板   | 实施 / 运行中 Claude | 入池 > 领取 > 开工       |
| 会话/设置  | 依赖 登录接口 >      | [打开原生工作台]         |
+------------+----------------------+--------------------------+

UI-02 手机
+---------------------------+
| 任务指挥   [任务池 v] [...]|
| 修复登录回调              |
| Claude 已领取 / 开工10:03 |
| 依赖 登录接口 >           |
| 点卡片 -> 全高详情 -> 返回|
+---------------------------+

UI-03 未派发: 前置未完成 -> [批准并入池: 禁用并显示原因]
UI-04 连接断开: 最后确认10:05 -> [刷新状态]，不是“暂无任务”
```

桌面保留两块有界内容区；手机不挂载隐藏的桌面工作台，列表／详情主体各自是当前唯一纵向滚动区。筛选采用原生 Drawer，固定动作留底部安全区。结构与状态文案属于要求，间距不是像素承诺。

## 验证

仓库根目录，使用根 `packageManager` 指定的 pnpm 9.15.9、Node 24，以及可用的 Go／本机 C 工具链；不使用全局错误版本。脚本如需 Bash，只使用 Windows Git Bash，不混用 WSL 二进制。命令采用 managed runner，自动构建当前后端／Web 并清理隔离实例；Windows runner 前置条件不齐时记录阻塞，不用旧二进制绕过构建。

```powershell
pnpm --dir apps install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw '工作区依赖安装失败' }
pnpm --dir apps/web exec vitest run lib/task-pool-view-model.test.ts lib/navigation/task-pool-navigation.test.ts lib/task-pool-startup.test.ts
if ($LASTEXITCODE -ne 0) { throw '卡片和关系单测失败' }
pnpm --dir apps/web e2e:run --host --shards 1 --project auth tests/auth/task-pool-auth.spec.ts --retries=0
if ($LASTEXITCODE -ne 0) { throw '桌面模拟流程失败' }
pnpm --dir apps/web e2e:run --host --shards 1 --project mobile-chrome tests/task/mobile-task-pool.spec.ts tests/auth/mobile-task-pool-auth.spec.ts --retries=0
if ($LASTEXITCODE -ne 0) { throw '手机模拟流程失败' }
git diff --check -- apps/web
if ($LASTEXITCODE -ne 0) { throw '前端差异检查失败' }
```

E2E 使用原生 fixture 的真实宿主与 mock providers，不能换成前端假 API。截图检查桌面、393px 手机及 767／768px 断点，覆盖精细／粗指针；证明在当前界面有用，不把草图当视觉验收。

## 可能修改的文件

- 已有：`apps/web/src/spa-routes.tsx`、`apps/web/components/navigation/app-nav-sections.tsx`、`apps/web/components/kanban-card-content.tsx`、`apps/web/lib/task-status-summary.ts` 和本地化目录。
- 拟新增：`apps/web/app/task-pool/`、`apps/web/components/task-pool/`、`apps/web/lib/task-pool-view-model.ts`、`apps/web/lib/api/domains/task-pool-api.ts`、`apps/web/hooks/domains/task/use-task-pool.ts` 及对应单测。
- 拟新增：本工单命令中的两个 E2E 文件；复用 `apps/web/e2e/fixtures/test-base.ts`。
- 实施后同步 `docs/public/tasks-and-workflows.md`、相关导航说明，不把本次设计发布成已支持功能。

## 依赖与风险

依赖 02 的有界读模型与 01 的入池操作。输入是[需求](../../specs/tasks/requirements/agent-pool-workbench.md)及[技术设计](../../specs/tasks/system-design/agent-pool-workbench.md)。不能直接从插件 store／转录猜测状态；不得在手机挤压桌面双栏或覆盖原生导航偏好。

## 并行

sequential

## 结果记录

2026-10-20：已接 `/task-pool` 原生路由、桌面导航／手机菜单、原生新建入口、桌面列表与预览、手机筛选抽屉与直达详情、事实时间线、历史分页及关联任务跳转。页面每页最多 50 张卡，筛选与计数明确限于当前页；复用原生摘要失效，不增加池状态库。人工恢复仍仅显示说明，04 未开始；默认入口偏好和剩余动作尚未交付。

前台 TDD 已见有效 RED：分类／时间线／未知与过期状态 5 条、GET 边界 3 条、迟到读取／作用域 3 条、隐藏停查及三十秒错误退避 2 条、路由与导航 2 条；转绿后连同原生导航、新鲜度和跨平台宿主路径回归共 58/58 通过。TypeScript `--noEmit`、新增代码 ESLint 零警告、i18n 键与七种真实语言完整性通过；繁体与 pseudo 由既有脚本生成。纯标记组件不另造 mock DOM 测试，以真实宿主浏览器脚本验证交互。

已新增 `tests/task/task-pool.spec.ts`、`mobile-task-pool.spec.ts` 和 `tests/auth/task-pool-auth.spec.ts`。Windows managed runner 使用 pnpm 9.15.9、Git Bash 和私有 Go／C 工具链，夹具按宿主平台选择 `.exe`。系统临时目录在普通沙箱下被宿主拒绝后，改用工作区内专用临时根及获准的隔离验收进程，不修改原实例或系统权限。

浏览器正例必须使用原生登录与设置确认头，不能在匿名夹具里放宽真人确认。认证项目于 08:58 通过 1/1（19.1s）：真实宿主、原生 Git Worktree 与 mock-agent CLI，页面逐项展示 queued／claimed／started、父任务跳转和原生工作台入口，刷新重载前后 run／claim 集合不变，桌面按钮 28px、无横向溢出。共享 Git 故障注入 launcher 在本机中文路径下失败；未扩大修改该共享功能，正例仅在本文件局部 PATH 中使用原生 Git，不注入延迟、不假造启动凭证。

当前后端／Web／插件已通过 managed 全构建；随后仅调整 E2E 夹具时使用 `--no-build` 复用这批新产物，原生新鲜度及插件身份校验一直启用。当前宿主二进制 SHA256 为 `F01049C935E0B818C40734CBC3A5F4DD85ABA56114B90A5683EBE2A3F6B635BF`；这是未提交工作区的构建身份，不是新提交 SHA。

09:00 默认 Chromium 两个负例通过 2/2，17.3s：匿名无法伪造真人批准／领取；读取故障保留原卡片并显示待刷新，不冒充空池。09:03 手机项目最终通过 1/1，22.1s：原生菜单进入、新建与分类／筛选控件实测至少 44px、底部抽屉、详情取代列表、非零滚动位置返回保持、筛选保持，以及中文冷启动、767／768 粗指针边界和无横向溢出。截图已保存至隔离副本上级 `tools/pool-workbench-evidence-20261020-ui03/`，已检查中文手机与粗指针平板截图；这是 Pixel 5 模拟，不是实体手机。

本工单仍 in_progress：缺少界面内真人批准并入池／阶段移动的完整操作、可选默认入口偏好、窄精细指针及最终桌面截图复核；04 的安全撤回／停止／核实后重试仍未开始。下一批优先复用原生 move API、两个原始版本前提与现有桌面／手机确认组件接“批准并入池”，而不是以后台 API 种子代替用户界面可操作性。不要把上述可查看／可跟踪的初版报告成完整可接真实任务。

09:07 最终前台定向复跑 7 个文件、58/58 通过；TypeScript 检查通过，公开文档校验 47 页通过，目标路径 diff whitespace 检查通过。全规格 lint 仍有此前 107 项长度等债务，本池修改未命中，未扩大修复。HEAD 仍为 `e43881c7555372897b57ec51c705f1e05da43c40`，本轮没有提交、推送、发布或真实模型调用。隔离二进制路径未观测到残留进程，但路径不可读的进程不能算不存在；上文挂起探测链的清理限制仍保留。

下一批已读 `components/confirmation/AGENTS.md`：手机确认复用 `MobileActionConfirmation`，所有者留在稳定详情中；本页不是表单弹窗，无需叠第二层表单。若进入原生新建表单，必须使用已有 host 的原位确认而非嵌套模态。首次实现优先给普通阶段卡片选择同流程的原生池阶段，显式确认额度后调用原生 move；排除同阶段伪批准，不改执行器，不绕过认证、WIP、依赖、版本和 Done。UI 成功只能由重新读取原生事实确认。当前共享原生新建表单尚无 `pool_release` 确认 UI，不能误报已经解决。

一次临时 pnpm 探测挂起，session `39559`；已查明其父子链为 `148664 → 153568 → 151972 → 156076 → 31696`，创建时间均为 08:37:09。只针对根 PID 148664 的树结束请求被 Windows 拒绝；未扩大到其他进程，未当作已清理。后续需确认这些本次探测进程已退出；不得误杀其他 Node／Bash 或真实看板。

### 2026-10-20 前台闭环验收

已补齐本工单剩余操作：普通阶段卡片选择同流程的显式池阶段，使用原生桌面确认／手机底部确认，明确同意 CLI 额度后调用原生 move。发送未经改写的任务及阶段纳秒版本；无认证、无有效目标、依赖／占用／陈旧或未知资料均不能批准。同阶段不伪批准、不更换执行器、不乐观补造入队或领取。同步双击只有一份在途写入；响应未知先查事实，不自动重发；切换工作区、往返同任务和卸载后的迟到结果均不污染当前页。

复用原生 startup_page 设置，新增可选 task_pool 入口，保存／水合／WS／启动及 Home 使用同一偏好，不增加本地偏好库或改写 kanban_view_mode。父卡可直接打开当前有界页面中的子卡，其他子任务明确跳转原生工作台；依赖及阻塞链接继续使用原生数据与权限。本工单不承诺全量关系图。

TDD 记录：批准目标／原始版本正例先 RED 后 GREEN；确认成功、取消、同步双击、拒绝／断线、过期／权限、作用域往返及卸载共 9 条；入口解析、原生持久偏好事件和子卡选择均先见有效 RED。最终前台定向回归 17 文件、212/212 通过；用户设置 service／DTO／controller 的启动入口回归在 -race 下全部通过。TypeScript 无输出退出 0，目标 ESLint 零警告；i18n 六项守卫与七真实语言完整性通过。公开文档校验器 62/62，通过 47 页校验；精确修改路径 whitespace 检查通过。全规格历史 107 项 CRLF 大小债务未被冒称修复。

这次认证 E2E 不再以 API 提前派发代替主动作：只在普通阶段准备前提，实际点击取消／批准，再经真实宿主、原生 Worktree、实际 mock-agent CLI 取得 queued／claimed／started。原生读取及重载前后 run／claim 集合不变，父子双向链接可用。桌面最终 1/1，23.5s；手机最终 1/1，27.0s，两者还实际保存启动入口并重载验证，原看板偏好及本地 listing 记忆不变。桌面 28px，手机动作至少 44px，窄精细指针 767／768 及先前粗指针边界无横向溢出。已查看桌面、手机完整确认及开工、精细指针 767／768 截图；证据位于上级 tools/pool-workbench-evidence-20261020-release03/。手机使用 Pixel 5 模拟，不是实体手机。

前端／后端改变后已重新 managed 全构建，最终宿主 SHA256 为 FEF48B301CE385E9634B67D61367A0B8FE6259A0BF950C860CC8D27B0A57061A。之后仅迭代验收脚本时使用 --no-build；未跳过 freshness、插件身份或真人确认。Git HEAD 仍为 e43881c7555372897b57ec51c705f1e05da43c40，没有提交／推送／发布。03 前台范围完成，不代表 01／02 的全部欠项、04、真实模型或生产验收完成；生产队列接线保持关闭，恢复仍只读。下一步顺序进入 04。
