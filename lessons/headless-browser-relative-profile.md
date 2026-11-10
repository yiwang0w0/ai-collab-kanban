---
id: headless-browser-relative-profile
title: 无头 Edge 的数据目录给相对路径会弹错误框,进程不退出
trigger:
  - kw:--user-data-dir
  - kw:msedge
  - kw:--headless
  - kw:无头 Edge
  - kw:无头浏览器
source: examples/verify_page.mjs
last_verified: 2026-11-10
hits: 0
scope: public
---
## 原因
给 --user-data-dir 传相对路径时,浏览器弹出数据目录错误的对话框。无头运行时没有人去点它,进程一直不退出,测试表现为超时而不是报错。

## 修法
数据目录一律给绝对路径,并且每次运行用新建的临时目录,结束后删除;不与日常使用的浏览器配置共用。

## 验证
启动命令行里 --user-data-dir= 后面是绝对路径;同一条命令连跑两次都能在时限内退出。
