---
id: ps51-script-without-bom
title: Windows PowerShell 5.1 把无 BOM 的 .ps1 当 ANSI 读,中日文变乱码或解析报错
trigger:
  - path:*.ps1
  - kw:ParserError
  - kw:PowerShell 5.1
  - kw:BOM
  - text:字符串缺少终止符
  - text:The string is missing the terminator
source: 本仓开发记录
last_verified: 2026-11-10
hits: 0
scope: public
---
## 原因
Windows PowerShell 5.1 读脚本时,没有 BOM 的文件按系统 ANSI 码页解码。用 UTF-8 写的中日文被拆成别的字符,引号配不上就报 ParserError;有时不报错,但字符串内容已经变了。

## 修法
给 5.1 运行的 .ps1 只用 ASCII;必须有非 ASCII 字符时存成带 BOM 的 UTF-8。由程序生成脚本时显式指定编码。

## 验证
文件前三个字节是 EF BB BF,或者全部字节都小于 0x80;再用 powershell.exe -NoProfile -File <脚本> 实跑一遍。
