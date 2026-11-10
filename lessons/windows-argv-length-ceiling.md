---
id: windows-argv-length-ceiling
title: 长提示词经命令行参数传递,撞上 Windows 的 32767 字符上限,进程起不来
trigger:
  - text:WinError 206
  - kw:32767
  - text:The filename or extension is too long
  - text:文件名或扩展名太长
source: loops/worker_loop.py 的提示词预算说明
last_verified: 2026-11-10
hits: 0
scope: public
---
## 原因
Windows 的命令行总长上限是 32767 个字符。提示词或规则列表经 argv 传递而超长时,不是「少了一段」,而是整个进程启动失败,报文件名或扩展名太长。

## 修法
各段内容设字数预算,按完整项取舍;启动前先量 argv 总长,超预算就拒发并说明是哪一段。能走标准输入或文件的内容不走 argv。

## 验证
python loops/worker_loop.py --prompt-selftest 的预算断言通过;--prompt-preview 可看各段尺寸。
