# 执行实例与旧请求隔离

每次领取生成新的 `run_id`。同名 worker 再次领取同一张卡，必须使用新的领取回执；旧回执的结果、心跳、重试和派生任务请求都会被拒绝。四个任务状态及本地数字编号不变。

## 身份与历史

| 字段 | 含义 |
|---|---|
| task_uid / owner_node_id | 任务的全局标识与所有者，创建后不变 |
| executor_node_id | 本次执行所在节点；本批只有本机执行，跨节点派发尚未启用 |
| worker / role_id | 槽位名与角色标识，彼此独立 |
| runtime | 本次领取申报的运行时；不能证明实际调用了该运行时 |
| agent_instance_id | worker 进程启动时生成的小写 UUID v4；人工 CLI 可以没有 |
| run_id | 一次领取派发的 UUID；同一次派发中的重试不换 ID |
| first_attempt / last_attempt | 该次派发所覆盖的原有累计尝试编号 |
| policy_json / policy_sha256 | 领取时的角色、工具配置、章程哈希和任务限制快照 |

`task_runs` 保存历史，元数据和策略快照不可更新、不可删除；一个任务最多有一条 running 记录。任务离开执行状态、换 worker、归档或被回收时结束当前记录。新领取重新生成快照。任务中的 `run_id` 保留最近一次执行指针。

服务端根据自己的线路配置生成快照，不接受请求体指定策略。章程摘要在配置加载时计算；磁盘文件变化要重新加载配置后才进入新领取的快照，已有 run 保留原快照。配置读取失败不会替换已经加载的角色及摘要，领取事务不读取章程文件。快照明确记录 `enforcement: "unattested"`，不能据此宣称 OS、MCP 或模型工具权限已经验证。运行时与进程 UUID 目前也是声明；后续的节点认证、执行器探测和权限隔离需要另行验收。

## 协议版本 2

`GET /api/meta` 返回 `worker_protocol_version: 2`。持 worker 令牌调用 `POST /api/claim` 必须发送：

~~~json
{
  "worker": "alpha-1",
  "line": "alpha",
  "worker_protocol_version": 2,
  "agent_instance_id": "11111111-1111-4111-8111-111111111111"
}
~~~

进程 UUID 应由客户端在启动时随机生成，示例值不能用于真实进程。旧版 worker 请求在领取前返回 400，避免先消耗一次模型调用才发现无法回传。

领取响应的 `task.run_id` 必须由该次任务处理一直保留。以下接口都必须携带它，operator 令牌也不例外：

- `POST /api/tasks/:id/heartbeat`：worker、run_id、可选 lease_minutes。
- `POST /api/tasks/:id/attempt`：worker、run_id。
- `POST /api/tasks/:id/report`：worker、run_id、outcome、evidence。
- worker 创建子任务：`POST /api/tasks`，带 parentId（或 parent_id）、parent_run_id、worker。两个父编号同时传入且不同会返回 400。

建卡请求只提取角色白名单，其余键统一丢弃，不传给 `store.add`。operator 可传 `subject`、`summary`、`description`、`acceptance`、`line`、`route`、`parentId`/`parent_id`、`blockedBy`、`verifyCmd`、`needsBash`、`kind`、`execution_profile_id`、`model`、`effort`；worker 只可传 `subject`、`summary`、`description`、`acceptance`、`line`、`parentId`/`parent_id`、`parent_run_id`、`worker`。`actor` 由服务器按令牌角色写入；尝试次数、人工闸、放行、锁、产物路径、起点档位和联动声明均不从请求体取值。worker 选择执行配置仍返回 403。

普通 operator 卡保留服务端既有放行默认；显式执行配置仍由服务端固定未放行、一次尝试。worker 派生卡首案是否放行，由服务器在父运行校验与插入的同一事务中按已有 `add` 事件来源判断：同一父 run 的首案放行，后案进候选池；首案归档也不会重新取得名额。链深上浮仍会收回放行。旧子卡没有可归属的运行来源时保守保持未放行；不迁移或修改旧任务、事件。内部直接调用 `store.add` 的既有策略不变。

缺失或格式错误返回 400；执行已结束、已换人或 ID 不是当前 run 返回 409；任务不存在返回 404。结果提交被拒绝时不写结果、状态和事件。心跳和重试的 SQL UPDATE 自身也带 run 条件，防止检查之后被另一进程重新领取。派生任务的父执行校验与插入放在同一个写事务内。

## 裁定与交付历史

每次成功 `report` 在同一任务事务中追加 `evidence.recorded`；`resolve`、`markAutoReviewed` 及实际联动结案分别追加 `decision.recorded`。两类记录复用 `task_events`，各自在同一张卡内从 `seq=1` 严格递增。数据库约束拒绝跳号、重复序号、旧条修改或删除，也拒绝通过改换事件类型绕过保护；记录写入失败会连同最新投影及任务版本一起回滚。陈旧运行、陈旧 CAS 和既有幂等回报不增加历史条数。

- `GET /api/tasks/:id/decisions/:seq` 返回 `{decision: {...}}`，保留本次裁定的 `note`、`verdict`、来源、实际去向和当时的方案、选择、文件归档、执行回执；`decision_json`、`decision_sql_archive`、`decision_receipt` 按存储原文保留为 JSON 字符串或 `null`。
- `GET /api/tasks/:id/evidence/:seq` 返回 `{evidence: {...}}`，含完整证据正文 `evidence`、运行、执行者和交付结果。

两种读取都复用原 GET 任务的令牌与来源保护；任务或序号不存在返回 404。共同字段含 `seq`、`event_id`、`task_id`、`at`、`actor`、`source` 和原事件的任务位置快照。任务详情中的 `result`、`verdict_note`、决策包及回执仍是原来的最新投影，指纹、提示词和交付物检查不改为拼接全部历史。

原 `/api/task-events` 保持状态与位置元数据事件集合，不携带这两类正文记录；在 SQL 分页前排除，原游标和时间轴判定不变。内部 `store.events()` 默认仍可读取全部事件，历史正文只从上述按序号接口按需读取。

升级只把旧卡当前仍保存的证据和裁定各导入一条 `seq=1`，重复迁移不再导入，也不改旧卡版本或既有事件。旧拼接裁定原文不拆成猜测的多次裁定；空证据或有真实裁定元数据的空备注照样保存。导入记录标记 `source=legacy`，`at` 是导入时间，`original_updated_at` 仅是旧行快照时间；不推断旧证据的运行身份，不绕过退役或恢复写入闸。

人工 CLI：

~~~text
python cli/board.py take 12 --as alpha --version <aggregate_version>
python cli/board.py done 12 --as alpha --run <领取输出中的 run_id> --file evidence.md
python cli/board.py wait 12 --as alpha --run <领取输出中的 run_id> --file reason.md
~~~

`GET /api/tasks/:id/runs` 可读取执行历史。不能为了让旧请求成功而重新 GET 卡片，再把最新 ID 填进旧结果。

## 模型输入的整项取舍

执行、审阅和拆解提示词的正文预算按完整裁定、证据段落、验收条目或输出行取舍；优先最新的完整项，保留项仍按原文顺序排列。代码围栏作为完整段处理，单项超限时整体省略，不切半条指令。执行端原有 4000 字裁定预算保留，但不再留下前 4000 字作为完整裁定。

省略说明列出数量、原文项号或范围及来源。服务端只附带最新历史记录的少量引用元数据，不预取全部历史正文；能够对应真实记录时引用卡号和 `decisions` / `evidence` 的 `seq`。旧数据或无法确认归属的正文明确写历史编号未知，指向原卡字段，不猜测编号。取回由已有权限的协调者处理；执行必需的全文尚未取得时交回原卡等待，不因此新增模型工具或命令、网络权限。

验证命令仍保留完整 `full_out`，供分类和原运行日志保存；交给模型的有界输出按完整行选择。stdout/stderr 失败诊断尾、卡号旁的标题标识和会话/hash 摘要属于技术摘要，不作为完整裁定或证据。上下文安全基线继续全文读取并在超限时拒绝；Windows argv 的 30000 字符启动前拒绝闸不变，省略说明也计入最终启动长度检查。

## 升级与恢复

这是 worker 写入协议的有意破坏性变更。部署时先停止旧 worker 与其他数据库写入者、确认正在执行任务的处置并备份，然后同步升级服务端、worker 和人工 CLI。混合版本写同一数据库不受支持。本分支标识为未发布的 0.24.0-dev.1；入口说明和逐步确认见 [Windows 迁移指南](migration-0.24.md)，尚未部署。

迁移为没有 run_id 的历史在途任务创建 imported 记录，agent_instance_id 留空，不伪造已观测进程。重新迁移不重复创建。旧进程不知道 imported ID，不能继续交付；确认旧进程停止后由 operator 按线路停止/回收或租约回收流程核对旧 run 已结束，再重新领取；恢复激活会结束旧 run 并保持未放行。CLI release 只改变放行标志，不能用它代替在途回收。已有执行指针损坏或不匹配时拒绝启动，不自动认领为本机的新执行。

回滚需停新版进程、保存升级后的数据库，再按备份说明恢复迁移前数据库和匹配代码；不要把旧服务直接指向升级后的库。升级后产生的新记录必须先处理保留，不能用回滚静默丢弃。

## 验证范围与限制

`npm run test:runs` 使用隔离数据库和临时 HTTP 服务，包含同名重新领取、跨任务 ID、三种写入在读取后发生竞争、子任务入口、重试记账、策略不变、迁移与旧协议拒绝。完整主套件还运行模拟 worker，模型调用数为零。

run_id 是并发隔离标识，不是秘密凭据，不能防止有权读取当前 ID 的恶意客户端。现有 worker 令牌仍是共享执行权限；按 agent 绑定权限属于 S03/S04。旧请求被拒绝不代表旧模型进程已被终止，也不阻止它在共享目录写文件；进程回收、工作区隔离、证据绑定和迟到成果留存属于后续批次。尚未启用联邦同步、跨机租约或离线继续工作协议。
