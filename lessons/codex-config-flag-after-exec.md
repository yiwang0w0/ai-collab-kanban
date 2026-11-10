---
id: codex-config-flag-after-exec
title: codex 命令里 exec 之后再写 -c,顶层的 -c 就不生效
trigger:
  - kw:codex exec
  - kw:sandbox_mode
  - kw:approval_policy
  - kw:model_reasoning_effort
source: loops/codex_runtime.py
last_verified: 2026-11-10
hits: 0
scope: public
---
## 原因
-c 配置覆盖既能写在顶层(exec 之前),也能写在 exec 之后。两处都写时顶层那一组不生效,写在顶层的沙箱、审批设置会不声不响地回到默认值。

## 修法
同一条命令里 -c 只写在一处:要么全部在 exec 之前,要么全部在 exec 之后,不混用。参数由一个函数统一组装,并用测试断言 -c 相对 exec 的位置。

## 验证
打印实际 argv,数 exec 前后的 -c:只有一侧有;python loops/worker_loop.py --codex-selftest 通过。
