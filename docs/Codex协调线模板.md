# Codex CLI 协调线一轮模板

`loops/codex_coordinator.py` 只提供参数、环境和 UTF-8 首句读取函数，不启动执行线、不建卡。首次调用与指定 `thread_id` 续接均要求只读，最终回复按 `examples/codex-coordinator-schema.json` 输出 `{reply, plan|null}`。模型只能提出计划，服务端核对执行线、通道、订阅预算为 `null`、依赖序号与验收字段后，仍需本人点按钮才可建卡。本轮不实现对话首页。

首次不传 `thread_id`，从 JSONL 的 `thread.started.thread_id` 保存引用；后续明确传回同一引用，不能用 `--last`。两轮使用同一个 `CODEX_HOME`、工作目录、模型、参数和 schema；不使用 `--ephemeral`，不允许同一会话并发，也不在续接失败后另开会话或重试。

```python
import subprocess
import codex_coordinator
import codex_runtime

# 均为宿主已经核对的配置与绝对路径；首轮 thread_id=None，续接传已保存的 UUID。
args = codex_coordinator.argv(cli, model, effort, last_path, workdir, schema,
                              thread_id=thread_id)
result = subprocess.run(args, input=codex_coordinator.read_prompt(prompt_file),
                        capture_output=True, text=True, encoding="utf-8",
                        env=codex_coordinator.environment(profile_env),
                        cwd=workdir, timeout=600,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
verdict = codex_runtime.judge(result.returncode, result.stdout, last_path)
```

上例展示单轮参数连接；接入宿主时须沿用进程收尾器，超时结束整个进程树。调用前由宿主校验原生 CLI、所选认证方式与本轮调用预算，删除本轮专用的旧 `last_path`，每次进程启动计入授权总数；失败不重试。`profile_env` 必须已由 `profileEnvironment` 剔除全部配置登记的凭据，再由共用 `subscription_environment` 剔除供应商与看板令牌变量。`forced_login_method="chatgpt"` 固定订阅认证，不能自动改走 API。获准检查仍走既有验证登记簿。

Codex CLI 0.149.1 的 `exec resume --help` 没有 `--sandbox`、`-C`，因此两轮统一把 `sandbox_mode="read-only"`、`approval_policy="never"` 和 `-C` 放在 `exec` 前。`--output-schema`、`--json`、`-o` 和 stdin `-` 在首次与续接均明确传入；保留用户及项目的执行规则，禁止绕过旗。JSONL 终态、最终文件和 schema 语义校验均应成功，模型自行声称已提交计划不算交付。

只读不等于敏感路径不可读；认证目录、令牌与登记簿的路径隔离留给开发板 #8，本模板不宣称达成。CLI 缺少底层模型请求数或美元金额的本地硬帽；未知用量或费用必须记为未知。以上参数与 schema 可离线检查，实际续接、只读约束和结构化输出是否生效须以本机真实验证为准。
