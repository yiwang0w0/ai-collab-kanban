# Zcode 接入:独立执行循环

把看板上的卡交给 Zcode(GLM)执行的入口是一个独立进程 `node cli/zcode-worker.mjs`。它不改看板服务,也不进 `fleet.config.json` 的 `runtimes[]`:Zcode 不是订阅池,看板不会替它起进程。

本批只做到**合成供应商回归**:整条链用一个假的 Zcode 程序跑通。真实模型一次都没有调用过,也没有登录、没有读过任何真实认证目录。真实调用是另一批,见「怎么开真实调用」。

## 能做什么、不能做什么

- 只接**文字交付卡**。执行角色只有 5 个看板工具(`get_task`、`list_roles`、`report_result`、`heartbeat`、`split_task`),没有文件、命令、网络工具,改不了仓库。
- 带登记验证(`verify_cmd`)的卡**拒收**。它跑不了验证,不会静默跳过。别人替这种卡建的分派请求同样会被撤回,见「接卡规则」。
- 宿主验证和宿主按卡提交都不适用,账本里记为 `not_applicable`。
- 每张卡结构上**最多派发一次**。失败、超时、取消都占用额度,不退、不重试。
- 用量一律记 `null`:供应商没有给可核对的用量,面板显示「待核实」,不显示 0。

## 一轮做什么

1. 复核开关、角色、预算、协调凭据、授权。
2. 看有没有没结清的分派。有就停在这一步,报 `needs_attention`,这一轮不接卡也不启动。
3. 清扫:本项目、本角色下所有等待执行器的分派请求(不管是谁建的)都按接卡规则过一遍,不合格的撤回并写上拒收码。
4. 接卡:挑出合格的卡,以协调身份建一个分派请求(每轮最多一个)。
5. 调一轮既有调度器:领取 → 准备 → 一次性许可 → 在 Windows Job 里执行 → 结算回写卡片。领取前调度器会就每个请求再问一次同一套接卡规则。
6. 记账:核对四节证据合同,往账本追加一行;不合格时在卡上留一条说明。

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

它登记协调角色 `zcode-intake` 和执行角色 `zcode`(GLM-5.3、low、单次尝试),发一份协调凭据,登记一份 `limit_total=1` 且**未启用**的预算,并在输出目录写出 `zcode-worker.config.json`。写出的骨架里 `launch.enabled=false`、`authorization.kind=synthetic`,`ledger_file` 已填为看板 DB 所在目录下的 `usage_ledger.jsonl`。它不启动任何东西;同名角色或文件已存在时拒绝,不覆盖。

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
| `ledger_file` | setup 已按看板 DB 所在目录填好 `usage_ledger.jsonl`(缺省布局下那就是看板数据目录,面板从这里读用量)。看板若用 `BOARD_DATA_DIR` 另指了数据目录,改成那个目录。不能放在调度根或认证目录里。写成 `null` 表示暂时不记:欠的账本行不会丢,见「账本」 |

摘要要小写:

```powershell
(Get-FileHash -Algorithm SHA256 '<文件绝对路径>').Hash.ToLower()
```

`installation.version` 固定为 `0.16.9`。版本字符串不能证明程序身份,靠的是你核验过的摘要。

**3. 让看板认识这条线**

在 `fleet.config.json` 里给 `lines` 加一项 `{"id":"zcode","label":"Zcode","external":true}`,给 `routes` 加 `"mcp"`,然后重启看板。

要在面板上看这条线的状态,再加一项 `"zcode_worker_config": "<配置文件的绝对路径>"`,见「面板上看状态」。

**4. 验收治理检出**

```powershell
git -C <治理检出> rev-parse "HEAD:" | Out-File -Encoding ascii <仓库外>\accepted-rev
```

**5. 先看计划,再交卡**

```powershell
node cli/zcode-worker.mjs plan --db <看板DB> --config-file <配置>
node cli/zcode-worker.mjs enqueue --db <看板DB> --task <卡ID> --version <所见任务版本> --config-file <配置>
```

`plan` 和 `status` 只读:列出开关、各道门、预算已用与上限、没结清的分派及原因、已有请求与候选卡各自的拒收码。`enqueue` 把卡的路由改为 `mcp`、线改为线名,并自根向下把祖先链登记到项目;它不启动任何东西。

**6. 运行**

```powershell
node cli/zcode-worker.mjs once  --db <看板DB> --config-file <配置> --accepted-rev <验收文件>
node cli/zcode-worker.mjs watch --db <看板DB> --config-file <配置> --accepted-rev <验收文件>
```

`watch` 在两种情况下自己停:

- 预算用尽:正常结束,退出码 0。
- 有分派没结清(`needs_attention`):退出码 2。它停下是为了把调度锁让给 `reconcile`,不是正常结束,见「出问题时」。`once` 遇到同样情况也以 2 退出。

首次 Ctrl+C 等在途调用结束,再次 Ctrl+C 或 SIGTERM 取消在途调用。

每一轮的 `status`:`ran` 是真的领取并执行过;`blocked` 是有请求但这一轮一个也没领到;`idle` 是没有可做的事。

同一个库不要同时运行 `cli/scheduler.mjs` 或带调度器的 `cli/node-runtime.mjs`:调度锁按数据库唯一,会互斥(`SCHEDULER_BUSY`)。

## 怎么开真实调用

默认全关。经 `cli/zcode-worker.mjs` 启动要三把钥匙,都由你亲手打开,缺一把就不启动:

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

`launch.enabled` 或环境变量缺任何一个,`once` / `watch` 在迁移、取锁、建目录、监听端口之前就以 `ZCODE_LAUNCH_DISABLED` 退出,不留任何痕迹。

### 哪道门在哪一层

配置里的 `scheduler` 块本身是一份合法的调度配置,`cli/scheduler.mjs` 和 `cli/dispatch.mjs` 也认它。所以要分清每道门守的是哪个入口:

| 门 | 在哪一层 | 换入口还过不过 |
|---|---|---|
| 环境变量 `BOARD_ZCODE_RELEASED=1` | dispatch 链:准备 Zcode 启动配置的那一步,以及调度器领取之前 | 过。`cli/scheduler.mjs once / watch`、`cli/dispatch.mjs execute` 没有它同样启动不了;调度器这一侧是不领取、不占预算、不消耗卡的尝试次数 |
| 预算已启用且有余量、一次性许可 | dispatch 链(库内) | 过 |
| `launch.enabled` | 只在 `cli/zcode-worker.mjs` | 不过 |
| `authorization`(时间窗、调用次数、bundle 摘要) | 只在 `cli/zcode-worker.mjs` | 不过 |
| 库内预算上限不得大于 `max_launches` | 只在 `cli/zcode-worker.mjs` | 不过 |
| 接卡规则(拒收)与四节提示附录 | 只在 `cli/zcode-worker.mjs` | 不过 |

也就是说:设着环境变量、预算又启用着的时候,直接跑 `cli/scheduler.mjs once / watch` 会绕过授权时间窗、次数交叉校验和拒收规则。真实调用只走 `cli/zcode-worker.mjs`;环境变量只在跑它的那个终端里设,用完关掉。

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
| `DEPENDENCIES_UNFINISHED`、`BROKEN_DEPENDENCIES` | 依赖的卡还没完成,或依赖字段损坏 |
| `CHILDREN_UNFINISHED` | 还有没完成的子任务 |
| `ANCESTOR_NOT_RELEASED` | 祖先任务没有放行 |
| `LOCK_HELD` | 执行锁被另一张进行中的卡占着 |
| `ROOT_WIP_LIMIT` | 同一根任务树里进行中的卡已到上限 |
| `TASK_TREE_HELD`、`TOPOLOGY_NOT_READY`、`DELEGATION_NOT_READY` | 任务树、拓扑登记或委派正持有这张卡 |

后面几行是「领取时才查」的条件。它们不是另写的一份判据,用的是看板回答「这张卡为什么领不走」的那一份,所以条件解除后下一轮自然会接。

### 别人建的请求

任何持有本项目协调凭据的调用方都能替一张卡建分派请求。循环对这些请求一视同仁:每轮开头把本项目、本角色下所有等待执行器的请求按上面同一套规则过一遍,不合格的**撤回**(请求状态变为 `cancelled`,原因写 `ZCODE_REFUSED:<拒收码>`),调度器领不走。除上表外,请求还可能得到这些码:

| 拒收码 | 意思 |
|---|---|
| `LINE_MISMATCH` | 卡的线不是这条线(包括线为空) |
| `ROUTE_MISMATCH`、`NOT_RELEASED`、`HUMAN_GATE`、`NOT_QUEUED`、`NOT_A_TASK` | 卡不满足候选条件 |
| `TASK_CHANGED` | 卡在请求之后被改过,这个请求永远领不到 |

撤回只结束请求,不动卡、不占预算。卡以后合格了,循环会自己重新建请求。

### 请求领不到时

请求合格、但调度器这一轮没能领取(领取期出现了接卡规则没有料到的拒绝):这一轮报 `blocked`,发一条 `REQUEST_UNCLAIMABLE` 提示(每个请求每个码一次)。请求原样留着,调度器每轮照旧重试;循环从下一轮起不再等它,接它后面的卡。

路由为 `mcp` 的卡不动时,先看「面板上看状态」的两个接口;命令行用 `plan` 看:`candidates` 是候选卡,`requests` 是已有请求,各带拒收码。

## 面板上看状态

循环是独立进程,看板服务不启动它,也不替它做任何决定。看板只提供两处只读信息,判定用的是 `plan` / `status` 同一份(`core/execution/zcode-worker.mjs`),不另写一套。

**开启。** 在 `fleet.config.json` 加 `"zcode_worker_config": "<zcode-worker.config.json 的绝对路径>"`,重启看板。看板只读库和这个文件:不监听 MCP 端口、不取调度锁、不跑证据脚本、不迁移库,读的那段时间本连接处于只读模式。`synthetic` 授权会和 `plan` 一样数一下认证目录里的条目(不读内容),协调凭据会按库核对一次。

**面板上看到的。** 设置页有只读的「Zcode」块:进入设置页时读一次 `GET /api/zcode/status`,停留期间每 30 秒一次,显示循环状态与白话原因、开关、预算、最近一次分派和心跳;没配置只写一句「没有配置 Zcode」。Zcode 卡的侧栏显示卡上 `zcode` 字段里的分派请求状态、拒收原因和分派次数。面板对循环不做任何写操作。

**`GET /api/zcode/status`**:面板会话或操作员令牌可读;执行线、审阅线、执行者令牌 403,批准令牌在本机不认(401),远程入口不开放。

```json
{ "configured": true,
  "line": "zcode",
  "switches": { "budget_enabled": true, "launch_enabled": true, "released_env": null },
  "budget": { "used": 1, "limit": 1, "reserved": 0 },
  "loop": { "state": "budget_exhausted", "reason": "…", "last_heartbeat_at": "…" },
  "last_dispatch": { "task_id": 12, "phase": "settled", "outcome": "success", "at": "…" },
  "model": "GLM-5.3" }
```

- 没配 `zcode_worker_config`,或库里还没 `setup`:只有 `{configured:false, line, loop:{state:"not_configured", reason}}`。
- 配了但文件读不到、格式不对:`configured:true`、`loop.state:"blocked"`,`switches` 三项与 `budget` 是 `null`。
- `line` 是 Zcode 角色线的线名,每种情况都有:配置读得到取配置里的 `line`(还没 `setup` 也一样);
  读不到或没配时取库里运行时为 `zcode` 的那个角色,没有或不止一个是 `null`。
- `released_env` 恒为 `null`。环境钥匙只在循环自己的终端里,看板看不到;状态不因它判成「关着」。
- `last_dispatch` 是这份预算下最近的一次分派,`outcome` 取结算结果(`success` / `failed` / `timeout` 等),没结算是 `null`。
- `last_heartbeat_at` 取本库最近的调度实例。调度锁按库唯一,同库另跑 `cli/scheduler.mjs` 时它也会算进来。
- `reason` 是给人看的白话,只写状态和下一步。

| `loop.state` | 意思 |
|---|---|
| `not_configured` | 看板没指配置,或库里还没登记这条线 |
| `disabled` | 配置里 `launch.enabled` 是 `false`,或预算没启用 |
| `blocked` | 授权、角色、预算登记、协调凭据有一道没过,或配置读不到 |
| `budget_exhausted` | 预算用完 |
| `unsettled` | 有分派没结清:循环活着且正在执行时是正常的;循环已停时先 `reconcile` |
| `needs_attention` | 占着并发位的运行已被 `record-uncertain` 记为结果不明,`reconcile` 补不了,按「出问题时」处理 |
| `ready` | 有合格的卡等 Zcode 接手;最近没有心跳时 `reason` 会写明循环没在运行 |
| `idle` | 没有可接的卡 |

**卡上的 `zcode` 字段**(`GET /api/tasks/:id` 与任务列表):路由为 `mcp`、线是 Zcode 角色线(库里该角色的运行时是 `zcode`)的卡才有,别的卡没有这个键。

```json
"zcode": { "request_state": "cancelled", "refusal_code": "VERIFY_UNSUPPORTED", "refusal_text": "带登记验证的卡不能交给 Zcode", "refusal_source": "request", "dispatches": 0 }
```

- `request_state`:这张卡最近一个分派请求的状态(`waiting_policy`、`waiting_release`、`waiting_executor`、`claimed`、`ended`、`cancelled`),没有请求是 `null`。
- `refusal_code` / `refusal_text` / `refusal_source`:白话与「接卡规则」两张表同义。来源两种:
  - `request`:最近的请求被循环撤回,原因写着 `ZCODE_REFUSED:<拒收码>`;
  - `plan`:没有这条记录时,按 `zcode_worker_config` 用 `plan` 候选卡的同一判定现算(只读),例如手工把卡改成 `mcp` 却没 `enqueue` 登记的 `NOT_ENROLLED`、没人替它建请求的带登记验证的卡。只对满足候选条件的卡算;配置读不到就不给。
- `dispatches`:这张卡名下的分派次数。

## 账本

每次结算往 `ledger_file` 追加一行,同一分派至多一行。调度根里对应目录下有两个标记:

- `ACCOUNTING.json`:记账已经开始。
- `ACCOUNTED.json`:账本行已经落地。

顺序是先落第一个标记、写账本行、再落第二个。只有第一个而没有第二个,说明这次运行还欠一行账:账本写不进去(`LEDGER_WRITE_FAILED`)、`ledger_file` 是 `null`(`LEDGER_NOT_CONFIGURED`),或者中途退出。欠的那一行用 `reconcile --assignment <请求ID>` 补;补之前会先在账本里按分派查一遍,已经有就只补标记,不会写出第二行。

- `calls`、`in`、`cc`、`cr`、`out` 五个用量键恒为 `null`。
- 这一行同时是看板用量结算(`docs/用量结算.md`)的用量行:`line` 是线名,`phase` 是 `initial`(汇总时读成 `implement`),`ok` 与 `settled_success` 同值,`duration_ms` 是监管进程量到的墙钟(进程没起来或没有进程观察时是 `null`),`cost_usd` 是 `null`、`cost_source` 是 `unknown`。`/api/usage` 与 `board.py usage` 把它归到这条线,词元与费用显示为未知,不是 0。
- 四个结论各记各的,不合并成一个「成功」:
  - `settled_success`:进程观察是否成功;
  - `task_read_observed`:这次运行是否真的读过卡;
  - `delivered_via`:`existing_mcp_report_preserved` 是模型自己回传,`reported` 是宿主代报;
    `mcp_report_overridden` 是进程因工具越权(`UNAUTHORIZED_TOOL` / `TOOL_SCOPE_MISMATCH`)被终止、而模型的回传在被杀之前已经到达:
    结算以越权为准,卡从待验收改回待裁定、结果换成宿主的结论(与回传没赶上时相同),模型回传的正文留在卡的证据历史里;
  - `contract_ok`:交付的正文是否符合四节合同。没有成功交付、或卡已不在这次运行手里时记 `null`。
- `host_verify`、`host_commit` 恒为 `not_applicable`。

### 证据不合格时

这条线没有「拒收后让模型重写」的回合,也没有宿主验证,给模型的提示里也不这么说。证据不合四节合同时卡照样进待验收,由验收的人决定。为了让验收的人看得见:

- 卡的「裁定记录」栏末尾多一条 `—— Zcode 证据合同(时间)——` 说明,写明不合格的条数和合同脚本给出的原因(固定措辞,不含模型正文);
- 卡的历史里多一条 `zcode.evidence_contract` 事件;
- 账本行记 `contract_ok=false` 并带错误列表。

每个分派只留一次。说明写在裁定记录栏里,之后自动审阅或人工裁定写入各自的记录时可能把这一栏换掉;历史事件和账本行不受影响。

## 出问题时

| 现象 | 做什么 |
|---|---|
| `status` / `plan` 显示 `needs_attention`,或 `once` / `watch` 以退出码 2 结束 | 有分派没结清,整条线被扣住。这个状态排在「开关没开」「预算用尽」之前,不会被它们遮住。`unsettled` 里每条带一个 `reason`,见下表。先 `node cli/zcode-worker.mjs reconcile --assignment <请求ID>`。 |
| 要补回执或补账本行 | 同一条 `reconcile`。它只补交回执并补记账,从不启动,所以**不需要**启动开关、有效授权、协调凭据,也不监听端口;授权过期之后照样能补。可重复执行。 |
| 领取后还没启动就中断 | `node cli/dispatch.mjs abandon`。许可没有消费,保留的那一次额度随之释放。 |
| 结果不明的运行 | `node cli/dispatch.mjs prepare-uncertain`,核对后 `record-uncertain`。注意下面的说明。 |
| 异常退出留下调度锁 | `node cli/runtime-lock.mjs prepare`,核对后 `apply`。不按心跳超时自动接管。 |
| 一轮的 `status` 是 `blocked` | 有请求但没领到。看同一轮的 `blocked` 列表和 `REQUEST_UNCLAIMABLE` 提示里的原因码。 |

`unsettled` 的 `reason` 是调度器判定「这次运行还占着并发位」的原因,循环用的就是调度器那一份判定。并发位按本节点当前代次的全部受管运行计,不只这条线:别的入口留下的未结清运行同样会列在这里,那一条要用它自己的入口处理。

| reason | 意思 |
|---|---|
| `unsettled_preparation` | 已领取、还没消费许可,也没有放弃 |
| `run_active` | 运行还没结束 |
| `outcome_missing` | 许可已消费,结果没有落定 |
| `observation_missing`、`process_stop_unconfirmed` | 已结算,但没有机器给出的进程停止证明 |

**`record-uncertain` 之后线不会自己恢复。** 调度器只采信机器给出的停止证明,人工声明不清并发位;这条线并发为 1,所以它仍被占着。此时 `unsettled` 里那一条会带 `operator_attested: true`,状态仍是 `needs_attention`。这是既有调度器的规则,不是本循环加的;本批没有提供清掉这个并发位的办法,循环只负责把原因说出来。

这些都是人工步骤,没有自动恢复,也没有自动重试。

## 已知短处

- 真实登录兼容性和真实模型任务都还没有验证过。
- 面板上只能看、不能操作:交卡靠 `enqueue`,启动开关改配置文件,预算用 `node cli/dispatch.mjs quota`。设置页的「Zcode」块与 Zcode 卡侧栏只读(见「面板上看状态」)。
- 用量拿不到,只能事后对供应商账单。
- 被操作者声明为「结果不明」的运行不产生账本行,并且在本节点当前代次内一直占着并发位(见上)。
- 已经在别的线上尝试过的卡,转到 Zcode 线后会以 `ATTEMPTS_EXHAUSTED` 被拒:尝试次数是累计的,从不清零。
- 授权时间窗、次数交叉校验和拒收规则只守 `cli/zcode-worker.mjs` 这一个入口(见「哪道门在哪一层」)。

更底层的启动合同、输出合同与进程监管见 [federation/zcode.md](federation/zcode.md)。
