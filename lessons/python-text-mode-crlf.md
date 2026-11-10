---
id: python-text-mode-crlf
title: Python 文本模式在 Windows 写文件,换行被写成 CRLF
trigger:
  - kw:newline=
  - kw:write_text
  - kw:CRLF
  - text:\r\n
source: 本仓开发记录
last_verified: 2026-11-10
hits: 0
scope: public
---
## 原因
open(path, "w") 不带 newline 参数时,Windows 上每个换行被写成回车加换行。「与原文件同字节」的副本、哈希比对、按换行切分的解析都会因此对不上。

## 修法
要保持换行就写 open(path, "w", newline=""),或者直接用二进制写;读回来比对时同样带 newline=""。

## 验证
以二进制读回文件,回车加换行的字节序列不应出现;或 git ls-files --eol <文件> 显示 w/lf。
