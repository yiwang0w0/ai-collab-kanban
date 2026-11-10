---
id: verify-inherits-board-env
title: 验证命令继承了部署的 BOARD_* 环境,隔离板读到部署配置
trigger:
  - kw:BOARD_DATA_DIR
  - kw:BOARD_CONFIG
  - kw:harnessEnvironment
  - kw:harness-env
  - kw:测试隔离
  - kw:临时板
source: docs/测试隔离.md
last_verified: 2026-11-10
hits: 0
scope: public
---
## 原因
执行循环在部署环境里运行,它代跑的验证命令继承了 BOARD_、WORKER_、REVIEWER_、REVIEW_、KANBAN_ 这几族变量。测试自己起的临时板没有显式设置的项,就落到部署的配置、数据目录或令牌上:单独跑是绿的,由循环代跑才红,或者反过来。

## 修法
测试文件第一行先导入 tests/harness-env.mjs(在产品模块加载之前清掉当前进程的这几族变量),子进程环境用 harnessEnvironment() 取,再显式写回本测试自己的配置、数据目录、工作仓与登记簿。要测「配置缺省」时指向本测试的空配置文件,不依赖工作树里恰好没有 fleet.config.json。

## 验证
外层先设一组假的部署变量再跑该测试,结果应与干净环境一致;node tests/harness-env-audit.mjs 列出逐文件的接线情况。
