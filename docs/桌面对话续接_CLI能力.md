# 桌面对话续接:两家 CLI 能做到哪一步

背景:看板是公告板——任务挂上去,AI 来领、回报;看板不替 AI 跑工具。面板里勾选的桌面对话
(接口见 [多执行者协作.md](多执行者协作.md)「本机桌面对话清单与勾选」)后续可登记成一条来领任务的线,
领卡时以该会话的副本为起点。本页只记两家 CLI 的事实与限制,登记成线本身不在这一批。

依据:2026-11-11 在本机只看了 `--help` / `--version`(claude 2.1.322、codex-cli 0.165.0),没有发任何模型调用。
下表「未实测」的格子是从帮助文字读出来的,没跑过。

| 能力 | claude | codex |
|---|---|---|
| 无头续接已有对话 | `claude -p --resume <id> "<提示>"`;`--bg` 可在后台续接(`claude agents` 列出,`attach` / `logs` / `stop`) | `codex exec resume <id> [提示]`(id 也可以是线程名;`--last` 取最近一个) |
| 以副本续接、原对话不动 | `--resume <id> --fork-session`(新会话 id,原文件不写) | `codex exec fork <id> <提示>`(fork 必须带提示);交互版另有 `codex fork` |
| 限定工具 | `--tools "Read,Grep"`(`""` 全关)、`--allowed-tools`、`--disallowed-tools`、`--permission-mode plan` | `codex exec` 有 `-s read-only`;`exec resume` / `exec fork` 的帮助里**没有** `-s`,只能试 `-c sandbox_mode="read-only"` 或把 `-s` 放在 `exec` 层(未实测) |
| 结构化输出 | `--output-format json` / `stream-json`,`--json-schema <schema>`(只配 `-p`) | `--json`(事件逐行 JSONL)、`--output-schema <文件>`、`-o <文件>` 写最后一条消息;resume / fork 都有 |
| 不留会话记录 | `--no-session-persistence`(只配 `-p`) | `--ephemeral` |
| 费用上限 | `--max-budget-usd <金额>`(只配 `-p`) | 帮助里没有 |
| 往现有对话追加一条消息 | 帮助里没有 | `codex queue --thread <id> --message <文本>` |

## 做不到的 / 没确认的

- Codex 在 resume / fork 子命令上能不能锁成只读沙箱:帮助文字判断不了,要实测。
- Codex 没有按金额封顶的参数;只能靠外层超时与看板的用量结算事后看。
- 两家都没有「只读打开、不写会话文件」的续接:不 fork 的续接一定往原对话追加。

## 对话正在桌面端打开时续接的风险

- 不 fork 直接 `--resume` / `exec resume`:桌面端与 CLI 两个写入方同时往同一个会话文件追加,
  桌面端看到的历史会和它内存里的不一致,两边交替写还可能分叉。**一律用副本(Claude `--fork-session`,Codex `exec fork`)**。
- fork 之后原对话不动,但副本从 fork 那一刻的历史出发,桌面端之后的新消息副本看不到;每次领卡要重新 fork 才能拿到最新上下文。
- Codex 的 `queue` 是往现有线程里塞消息,等于第二个写入方,不适合「以副本为起点」的用法。

## 长对话的费用含义

- 续接(含 fork)的第一轮要把整段历史送进模型。清单里的 `approx_tokens` 就是这一轮的大致输入量;
  桌面对话常见几十万 token,冷缓存时这一轮按全价输入计。
- 同一副本连续几轮能吃到缓存;隔久了缓存过期,下一轮又是全价。
- 历史超过模型上下文窗口时 CLI 会先压缩(本身也是一次模型调用),压缩后的副本与原对话内容不再一致。
- 所以「以副本为起点」适合上下文已经有价值、但不太长的对话;太长的先在桌面端压缩或另开对话再勾选。
