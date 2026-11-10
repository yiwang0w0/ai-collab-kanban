# Zcode 接入:独立执行循环

把看板上的卡交给 Zcode(GLM)执行的入口是一个独立进程 `node cli/zcode-worker.mjs`。它不改看板服务,也不进 `fleet.config.json` 的 `runtimes[]`:Zcode 不是订阅池,看板不会替它起进程。

本批只做到**合成供应商回归**:整条链用一个假的 Zcode 程序跑通。真实模型一次都没有调用过,也没有登录、没有读过任何真实认证目录。真实调用是另一批,见「怎么开真实调用」。

## 能做什么、不能做什么

- 只接**文字交付卡**。执行角色只有 5 个看板工具(`get_task`、`list_roles`、`report_result`、`heartbeat`、`split_task`),没有文件、命令、网络工具,改不了仓库。
- 带登记验证(`verify_cmd`)的卡**拒收**。它跑不了验证,不会静默跳过。
- 宿主验证和宿主按卡提交都不适用,账本里记为 `not_applicable`。
- 每张卡结构上**最多派发一次**。失败、超时、取消都占用额度,不退、不重试。
- 用量一律记 `null`:供应商没有给可核对的用量,面板显示「待核实」,不显示 0。

## 一轮做什么

1. 复核开关、角色、预算、协调凭据、授权。
2. 接卡:挑出合格的卡,以协调身份建一个分派请求(每轮最多一个)。
3. 调一轮既有调度器:领取 → 准备 → 一次性许可 → 在 Windows Job 里执行 → 结算回写卡片。
4. 记账:核对四节证据合同,往账本追加一行。

领取、许可、预算扣减、进程托管都是既有 dispatch 链做的,循环本身不复制这些逻辑。

## 操作者要提供什么

| 需要什么 | 说明 |
|---|---|
| Zcode 账号与登录目录 | BigModel 中国版 Coding Plan;已登录的 `.zcode\v2` 目录的绝对路径。登录由你亲手完成,程序不读这个目录的内容。 |
| 安装文件的路径与摘要 | Zcode 是否仍为 0.16.9;它自带的 `node.exe`、bundle、公开供应商配置三个文件各自的绝对路径和 SHA256。 |
| Python 与 Node | `python.exe`、运行看板的 `node.exe` 的绝对路径和 SHA256。 |
| 调用预算 | 次数(默认 1)、授权人、起止时间。口径是**按启动次数计**:一次启动里模型可以发多次推理请求,只受 `timeout_ms` 和无输出时限约束。 |
| 一份干净且已验收的治理检出 | 专用工作树加验收文件。本批新增了文件,树哈希变了,要重新验收;带未提交改动的工作树会被拒(`SOURCE_DIRTY`)。 |
| 三个仓库外的位置 | 调度根目录、配置文件、协调凭据文件。调度根的各级上级目录里不能有 `.env`、`.mcp.json`、`zcode.json`、`.zcode\config.json`,也不能在认证目录里。 |
| 一个专用项目名和一个空闲端口 | 项目名例如 `zcode-local`,不授权给联邦对端;端口是本机回环 MCP 端口。 |
| 哪些卡可以发给供应商 | `get_task` 会把卡的标题、说明、验收条件发给 BigModel。提示还会出现在本机进程参数里(既有性质)。 |
| 真实调用之后的用量记录 | 回执里 `real_model_call_confirmed` 恒为 `false`,真实性只能靠供应商侧的用量记录确认。 |

## 配置步骤

以下命令在治理检出的根目录执行,路径一律用绝对路径。

**1. 登记这条线**

```powershell
node cli/zcode-worker.mjs setup --db <看板DB> --line zcode --project zcode-local --out-dir <仓库外的已有目录>
```

它登记协调角色 `zcode-intake` 和执行角色 `zcode`(GLM-5.3、low、单次尝试),发一份协调凭据,登记一份 `limit_total=1` 且**未启用**的预算,并在输出目录写出 `zcode-worker.config.json`。写出的骨架里 `launch.enabled=false`、`authorization.kind=synthetic`。它不启动任何东西;同名角色或文件已存在时拒绝,不覆盖。

配置样例见 `examples/zcode-worker.config.example.json`。配置的键集是严格的,多一个键就拒绝。

**2. 填 installation**

骨架里尖括号的位置由你核验后填写:

| 字段 | 填什么 |
|---|---|
| `installation.program` | Zcode 自带 `node.exe` 的 `{path, sha256}` |
| `installation.bundle` | Zcode bundle 的 `{path, sha256}` |
| `installation.builtin_config` | Zcode 公开供应商配置的 `{path, sha256}` |
| `installation.auth_home` | 已登录的 `.zcode\v2` 目录 |
| `python`、`node` | 监管用的 `python.exe`、运行桥接的 `node.exe` 的 `{path, sha256}` |
| `mcp.port` 与 `mcp_url` | 同一个空闲回环端口,两处必须一致 |
| `ledger_file` | 推荐 `<看板数据目录>\usage_ledger.jsonl`,面板从这里读用量(数据目录默认是看板仓里的 `core\.data`);暂时不记就留 `null`。不能放在调度根或认证目录里 |

摘要要小写:

```powershell
(Get-FileHash -Algorithm SHA256 '<文件绝对路径>').Hash.ToLower()
```

`installation.version` 固定为 `0.16.9`。版本字符串不能证明程序身份,靠的是你核验过的摘要。

**3. 让看板认识这条线**

在 `fleet.config.json` 里给 `lines` 加一项 `{"id":"zcode","label":"Zcode","external":true}`,给 `routes` 加 `"mcp"`,然后重启看板。

**4. 验收治理检出**

```powershell
git -C <治理检出> rev-parse "HEAD:" | Out-File -Encoding ascii <仓库外>\accepted-rev
```

**5. 先看计划,再交卡**

```powershell
node cli/zcode-worker.mjs plan --db <看板DB> --config-file <配置>
node cli/zcode-worker.mjs enqueue --db <看板DB> --task <卡ID> --version <所见任务版本> --config-file <配置>
```

`plan` 和 `status` 只读:列出开关、各道门、预算已用与上限、候选卡和拒收码。`enqueue` 把卡的路由改为 `mcp`、线改为线名,并自根向下把祖先链登记到项目;它不启动任何东西。

**6. 运行**

```powershell
node cli/zcode-worker.mjs once  --db <看板DB> --config-file <配置> --accepted-rev <验收文件>
node cli/zcode-worker.mjs watch --db <看板DB> --config-file <配置> --accepted-rev <验收文件>
```

`watch` 在预算用尽后正常退出。首次 Ctrl+C 等在途调用结束,再次 Ctrl+C 或 SIGTERM 取消在途调用。

同一个库不要同时运行 `cli/scheduler.mjs` 或带调度器的 `cli/node-runtime.mjs`:调度锁按数据库唯一,会互斥(`SCHEDULER_BUSY`)。

## 怎么开真实调用

默认全关。三把钥匙都由你亲手打开,缺一把就不启动:

1. **预算启用。** 把 setup 登记的预算改为 `enabled: true`(`node cli/dispatch.mjs quota`,先用 `quota-status` 看当前版本)。
2. **配置。** `launch.enabled` 改为 `true`,`authorization` 换成 `real` 块:

   ```json
   "authorization": {
     "kind": "real",
     "authorized_by": "<授权人>",
     "authorized_at": "<起始时间,ISO 8601>",
     "expires_at": "<截止时间,ISO 8601>",
     "max_calls": 1,
     "bundle_sha256": "<与 installation.bundle.sha256 相同>"
   }
   ```

3. **环境变量。** 只在启动循环的那个终端里设 `BOARD_ZCODE_RELEASED=1`。

配置侧的两把钥匙缺任何一把,程序在迁移、取锁、建目录、监听端口之前就以 `ZCODE_LAUNCH_DISABLED` 退出,不留任何痕迹。

额外的硬约束:

- `launch.max_launches` 缺省 1,代码内硬顶 20。
- 库里预算的 `limit_total` 大于 `max_launches` 时拒绝(`BUDGET_EXCEEDS_DECLARED`)。调大预算要同时改库和配置。
- `real` 授权过期、尚未生效、摘要与安装记录不符、`max_launches` 超过 `max_calls` 都拒绝。此模式不列目录、不读认证目录。
- `synthetic` 只用于回归,要求认证目录是空目录。

### 首次真实调用之前

建议先单独授权一次**探测**:真实 Zcode 程序 + 本机假接口 + 5 个角色工具 + 本循环的提示。它不调用真实模型,但会运行真实的 Zcode 程序。不做的话,唯一一次预算可能烧在 `TOOL_SCOPE_MISMATCH` 或 `UNSUPPORTED_SESSION_EVENT` 上,而且不退。

然后放行一张材料全在卡面内的卡。

### 怎样才算成功

下面几条全部满足才算数:

- 分派已结算,进程观察为成功,Job 已清空(`job_empty`)。
- 审计里有这次运行读卡成功的记录。
- 卡在待验收,结果非空。
- 另有你这边的供应商用量记录。

登录成功或 MCP 启动都不单独算数。

## 接卡规则

候选卡:未开始、已放行、类型为任务、路由为 `mcp`、线等于线名、没有人工闸、未归档。线为空的卡不接。

卡要先登记到项目才会被接。默认由你用 `enqueue` 登记;把 `intake.auto_enroll` 设为 `true` 后,循环会自己把祖先链和这张卡登记进来。登记一旦写入不能改项目。

候选卡被拒收时,每张卡每个码只通知一次,都发生在领取之前,不消耗预算:

| 拒收码 | 意思 |
|---|---|
| `VERIFY_UNSUPPORTED` | 带登记验证的卡不能交给 Zcode |
| `PROFILE_BOUND` | 这张卡已经绑定了别的执行配置 |
| `ATTEMPTS_EXHAUSTED` | 这张卡已经派发过一次 |
| `UNSETTLED_DISPATCH` | 这张卡名下还有没结清的分派 |
| `NOT_ENROLLED` | 没有登记到项目,且 `auto_enroll` 关着 |
| `PROJECT_MISMATCH` | 卡或它的祖先登记在别的项目 |
| `ROLE_MISMATCH` | 按项目、类别与能力选出的不是这个执行角色 |

路由为 `mcp` 的卡不动时,面板目前不会说原因,用 `plan` 看。

## 账本

每次结算往 `ledger_file` 追加一行,同一分派最多记一次(调度根里对应目录下的 `ACCOUNTED.json` 是标记)。

- `calls`、`in`、`cc`、`cr`、`out` 五个用量键恒为 `null`。
- 四个结论各记各的,不合并成一个「成功」:
  - `settled_success`:进程观察是否成功;
  - `task_read_observed`:这次运行是否真的读过卡;
  - `delivered_via`:`existing_mcp_report_preserved` 是模型自己回传,`reported` 是宿主代报;
  - `contract_ok`:交付的正文是否符合四节合同。没有成功交付、或卡已不在这次运行手里时记 `null`。
- `host_verify`、`host_commit` 恒为 `not_applicable`。

证据不合格时卡照样进待验收,账本记 `contract_ok=false` 并带错误列表,由验收的人决定。

## 出问题时

| 现象 | 做什么 |
|---|---|
| `status` 显示 `needs_attention` | 有分派没结清,整条线被扣住。先 `node cli/zcode-worker.mjs reconcile --assignment <请求ID>`:只补交回执并补记账,不启动。 |
| 开关已经关掉,但要补回执 | `node cli/scheduler.mjs reconcile` 只补回执,它的配置文件就是本配置里 `scheduler` 那一块原样另存。账本行等开关再打开后用上一条命令补,不会重复。 |
| 领取后还没启动就中断 | `node cli/dispatch.mjs abandon`。许可没有消费,保留的那一次额度随之释放。 |
| 结果不明的运行 | `node cli/dispatch.mjs prepare-uncertain`,核对后 `record-uncertain`。 |
| 异常退出留下调度锁 | `node cli/runtime-lock.mjs prepare`,核对后 `apply`。不按心跳超时自动接管。 |

这些都是人工步骤,没有自动恢复,也没有自动重试。

## 已知短处

- 真实登录兼容性和真实模型任务都还没有验证过。
- 面板没有 Zcode 的入口和状态:交卡靠 `enqueue`,看原因靠 `plan` / `status`。
- 用量拿不到,只能事后对供应商账单。
- 被操作者声明为「结果不明」的运行不产生账本行。
- 已经在别的线上尝试过的卡,转到 Zcode 线后会以 `ATTEMPTS_EXHAUSTED` 被拒:尝试次数是累计的,从不清零。

更底层的启动合同、输出合同与进程监管见 [federation/zcode.md](federation/zcode.md)。
