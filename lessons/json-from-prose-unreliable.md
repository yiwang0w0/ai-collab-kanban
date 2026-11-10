---
id: json-from-prose-unreliable
title: 从模型回答正文里抠 JSON 不稳,要用结构化输出
trigger:
  - kw:JSONDecodeError
  - kw:JSON.parse
  - kw:--output-schema
  - kw:结构化输出
  - text:Unexpected token
  - text:Expecting value
source: loops/codex_runtime.py 的 --output-schema 用法
last_verified: 2026-11-10
hits: 0
scope: public
---
## 原因
让模型在正文里写 JSON,再用正则或括号配对取出来,会遇到代码围栏、前后的说明文字、半截输出、多段 JSON。同一份提示词有时能解析,有时不能。

## 修法
要给机器读的结果走 CLI 或 SDK 的结构化输出(给 schema 文件,例如 codex 的 --output-schema)。解析失败按失败处理并保留原文,不去猜。只能靠文件交接时,约定唯一的落盘文件,而不是在回答里找。

## 验证
同一输入重复运行,解析结果的结构一致;把输出改成带围栏或多一段话时,宿主报错,而不是取到半个对象。
