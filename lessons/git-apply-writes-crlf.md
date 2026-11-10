---
id: git-apply-writes-crlf
title: git apply 或切换分支把工作树写成 CRLF,按换行截源码的测试假红
trigger:
  - kw:git apply
  - kw:CRLF
  - kw:autocrlf
  - text:\r\n
source: 本仓开发记录
last_verified: 2026-11-10
hits: 0
scope: public
---
## 原因
Windows 上 core.autocrlf=true 时,git apply、switch、checkout 会把工作树文件写成 CRLF。按换行加固定缩进去截取源码片段的测试找不到锚点,报出来的是断言失败,看起来像代码被改坏了。

## 修法
会写工作树的 git 命令加 -c core.autocrlf=false(例:git -c core.autocrlf=false apply x.patch;新建工作树同理),不改共用的 git 配置。已经变成 CRLF 的,只把「索引是 LF、工作树是 CRLF」的文件转回去;索引里本来就是 CRLF 的不要动。

## 验证
git ls-files --eol <文件>:i/lf 的文件应显示 w/lf;然后重跑原测试。
