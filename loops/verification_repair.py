#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证续修的纯判定；不启动进程，不读取环境或看板。"""
import re


_ENVIRONMENT = re.compile(
    r"(?:超时|timeout|timed out|无法启动|spawn.{0,30}(?:失败|error)|"
    r"ENOENT|EACCES|EADDRINUSE|ECONNREFUSED|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|"
    r"ModuleNotFoundError|ImportError|FileNotFoundError|Cannot find (?:module|package)|"
    r"No such file|not recognized as|不是内部或外部命令|command not found|"
    r"端口.{0,20}(?:占用|不可用)|登记簿|harness itself|0\s*PASS.{0,100}TypeError)", re.I | re.S)
_BLOCKED = re.compile(r"(?:我(?:已经|已)?卡住|无法继续|需要人工(?:介入|处理|协助)|需要操作者(?:提供|处理|介入)|"
                      r"I(?:'m| am) blocked|cannot proceed|\bstuck\b)", re.I)
_TEST_RED = re.compile(r"(?:AssertionError|ERR_ASSERTION|assert(?:ion)?\s+failed|"
                       r"\bFAIL(?:ED)?\b|\bnot ok\b|[1-9]\d*\s+(?:fail|failed)|断言.{0,20}失败)", re.I)


def classify(rc, tail, verification, evidence=None):
    """只明确的测试红可续修；未知故障保守归环境异常。"""
    model = str(tail or "") + "\n" + str(evidence or "")
    if _BLOCKED.search(model):
        return "blocked"
    if rc != 0:
        return "environment"
    if not verification or verification.get("ok"):
        return "passed" if evidence else "environment"
    output = str(verification.get("full_out", verification.get("out")) or "")
    if verification.get("rc") in (None, -1, -2, -3) or verification.get("code") or _ENVIRONMENT.search(output):
        return "environment"
    if re.search(r"\bTypeError\b", output) and not re.search(r"[1-9]\d*\s+PASS|#\s*pass\s+[1-9]", output, re.I):
        return "environment"
    return "test_failure" if _TEST_RED.search(output) else "environment"


def repair_prompt(verification, log_path, evidence_path, round_number):
    """只携带本轮失败；长输出按完整段落取舍，全文在原 run 日志。"""
    output = str(verification.get("full_out", verification.get("out")) or "").strip()
    parts, size = [], 0
    for part in re.split(r"\n\s*\n", output):
        if size + len(part) + 2 <= 4500:
            parts.append(part); size += len(part) + 2
    return (f"本次尝试第 {round_number} 轮，就地修复刚才的验证失败。保持原任务、会话、模型、强度与权限。\n"
            f"验证键：{verification.get('key')}，退出码：{verification.get('rc')}。\n"
            + "\n\n".join(parts) + ("\n（其余完整项见日志。）" if size < len(output) else "")
            + f"\n完整验证日志：{log_path}\n更新交付证据：{evidence_path}\n"
              "只处理这次失败；如确实卡住请明确说明，不另开任务或提高档位。")
