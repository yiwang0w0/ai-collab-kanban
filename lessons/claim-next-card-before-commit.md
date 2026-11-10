---
id: claim-next-card-before-commit
title: 交付后立刻在同一工作仓领下一张卡,两张卡的改动混在一起
trigger:
  - kw:host_auto_commit
  - kw:逐卡提交
  - kw:工作区已经有未提交的改动
  - kw:改动混在一起
source: docs/宿主逐卡提交.md
last_verified: 2026-11-10
hits: 0
scope: public
---
## 原因
卡交付之后,改动还留在工作区没有提交。同一条线马上领下一张卡,新卡就在旧改动之上开工;之后无论提交还是打回,都分不清哪一行属于哪张卡。

## 修法
一张卡的改动提交(或明确搁置)之后再领下一张。写入线可以在 fleet.config.json 打开 host_auto_commit:宿主在领卡前检查工作仓是否干净,验证通过后逐卡提交。不打开时,领卡前先看 git status。

## 验证
领卡前 git status --porcelain 输出为空;交付后 git log -1 --stat 只含本卡的文件。
