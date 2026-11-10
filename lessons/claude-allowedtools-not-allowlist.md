---
id: claude-allowedtools-not-allowlist
title: Claude CLI 的 --allowedTools 不是白名单,不带路径的工具名等于放行任意路径
trigger:
  - kw:--allowedTools
  - kw:--disallowedTools
  - kw:--tools
  - kw:越界读
source: loops/worker_loop.py 的工具集合说明
last_verified: 2026-11-10
hits: 0
scope: public
---
## 原因
--allowedTools 是「免确认」的放行规则,不决定有哪些工具可用。写成不带路径的 Read,就是任何路径的读取都放行;CLI 新版本增加的工具也不会被它挡住。

## 修法
可用工具用 --tools 列白名单;--allowedTools 只写带路径的规则(例如只放行证据目录的写入);令牌文件、认证目录用 --disallowedTools 的路径规则拒绝。MCP 不归 --tools 管,另用 --strict-mcp-config 且不给配置。

## 验证
python loops/worker_loop.py --prompt-selftest:--tools 等于白名单、--allowedTools 里没有不带路径的工具名这两条断言通过。
