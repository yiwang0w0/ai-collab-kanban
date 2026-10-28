# Codex CLI 协调线一轮模板

`loops/codex_coordinator.py` 只提供参数、环境和 UTF-8 首句读取函数，不启动执行线、不建卡。首次调用与指定 `thread_id` 续接均要求只读，最终回复按 `examples/codex-coordinator-schema.json` 输出 `{reply, plan|null}`。模型只能提出计划，服务端核对执行线、通道、订阅预算为 `null`、依赖序号与验收字段后，仍需本人点按钮才可建卡。本轮不实现对话首页。

首次不传 `thread_id`，从 JSONL 的 `thread.started.thread_id` 保存引用；后续明确传回同一引用，不能用 `--last`。两轮使用同一个 `CODEX_HOME`、工作目录、模型、参数和 schema；不使用 `--ephemeral`，不允许同一会话并发，也不在续接失败后另开会话或重试。

```python
import subprocess
import codex_coordinator
import codex_runtime

# 均为宿主已经核对的配置与绝对路径；首轮 thread_id=None，续接传已保存的 UUID。
args, child_env = codex_coordinator.prepare(cli, model, effort, last_path, workdir, schema,
                                          env=profile_env, thread_id=thread_id)
result = subprocess.run(args, input=codex_coordinator.read_prompt(prompt_file),
                        capture_output=True, text=True, encoding="utf-8",
                        env=child_env,
                        cwd=workdir, timeout=600,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
verdict = codex_runtime.judge(result.returncode, result.stdout, last_path)
```

上例展示单轮参数连接；接入宿主时须沿用进程收尾器，超时结束整个进程树。`prepare` 先执行只读的 `codex login status`，确认已有 ChatGPT 登录后才返回生成命令；状态查询不带 `forced_login_method`，也不转述可能含密钥提示的原始输出。API key 形登录或未知状态会被拒绝，不调用强制认证的生成命令，避免 CLI 清除操作者原有登录。`argv` 仅用于离线构造检查，不能直接拿去起进程跳过此预检。

调用前由宿主核对本轮预算，删除本轮专用的旧 `last_path`，每次真实 `exec`／`resume` 启动计入授权总数；失败不重试。`environment(env)` 必须显式传入已经由 `profileEnvironment` 剔除全部配置登记凭据的环境，再由共用 `subscription_environment` 剔除供应商与看板令牌变量。实际生成保留 `forced_login_method="chatgpt"`，不自动改走 API；获准检查仍走既有验证登记簿。

Codex CLI 0.149.1 的 `exec resume --help` 没有 `--sandbox`、`-C`，因此两轮统一把 `sandbox_mode="read-only"`、`approval_policy="never"` 和 `-C` 放在 `exec` 前。0.149 系列实测：只要 `exec`／`exec resume` 后出现一个子命令级 `-c`，前面的顶层 `-c` 就会全部失效，包括只读与认证约束；模板禁止这种参数组合，回归断言同时覆盖首次和续接。`--output-schema`、`--json`、`-o` 和 stdin `-` 在首次与续接均明确传入；保留用户及项目的执行规则，禁止绕过旗。JSONL 终态、最终文件和 schema 语义校验均应成功，模型自行声称已提交计划不算交付。

`environment(profile_env)` 必须显式传入已经由 `profileEnvironment` 处理的环境，省略参数会直接报错；模板不再默认取宿主的 `os.environ`。所传环境继续交给共用订阅过滤函数处理，不复制另一套过滤规则。

只读不等于敏感路径不可读；认证目录、令牌与登记簿的路径隔离留给开发板 #8，本模板不宣称达成。CLI 缺少底层模型请求数或美元金额的本地硬帽；未知用量或费用必须记为未知。以上参数与 schema 可离线检查，实际续接、只读约束和结构化输出是否生效须以本机真实验证为准。
