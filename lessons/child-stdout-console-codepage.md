---
id: child-stdout-console-codepage
title: Windows 上子进程的标准输出按控制台码页编码,不是 UTF-8
trigger:
  - kw:PYTHONIOENCODING
  - kw:UnicodeEncodeError
  - kw:UnicodeDecodeError
  - kw:乱码
  - kw:reconfigure
source: cli/board.py 的输出编码处理
last_verified: 2026-11-10
hits: 0
scope: public
---
## 原因
Python 等程序的输出接到管道时,默认按系统码页编码。父进程按 UTF-8 读就是乱码,遇到码页里没有的字符还会抛 UnicodeEncodeError;在终端里直接运行却是正常的。

## 修法
起子进程时设 PYTHONIOENCODING=utf-8(或 PYTHONUTF8=1);脚本开头对 stdout 与 stderr 调 reconfigure(encoding="utf-8");父进程读管道时显式写 encoding="utf-8"。

## 验证
让子进程输出一段中文和一个 emoji,父进程读到的内容与原文相同。
