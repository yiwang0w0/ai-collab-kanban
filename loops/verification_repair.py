#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证续修的纯判定；不启动进程，不读取环境或看板。"""
import re
from prompt_items import whole_text


_ENVIRONMENT = re.compile(
    r"(?:超时|timeout|timed out|无法启动|spawn.{0,30}(?:失败|error)|"
    r"ENOENT|EACCES|EADDRINUSE|ECONNREFUSED|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|"
    r"\b(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|EPERM|EBUSY|ENOSPC)\b|"
    r"No space left on device|out of memory|Access is denied|拒绝访问|"
    r"ModuleNotFoundError|ImportError|FileNotFoundError|Cannot find (?:module|package)|"
    r"No such file|not recognized as|不是内部或外部命令|command not found|"
    r"端口.{0,20}(?:占用|不可用)|登记簿|harness itself|0\s*PASS.{0,100}TypeError)", re.I | re.S)
_BLOCKED = re.compile(r"(?:我(?:已经|已)?卡住|无法继续|需要人工(?:介入|处理|协助)|需要操作者(?:提供|处理|介入)|"
                      r"I(?:'m| am) blocked|cannot proceed|\bstuck\b)", re.I)
# 测试红只认带非零计数或断言特征的形；光有 fail / failed 字样不算（环境故障的报错里到处是这个词）。
#   「3 failed」「1 FAIL」「2 failing」/「failures=2」「fail: 2」/ 整行只有「# fail 2」/「not ok 3」/ 断言报错。
# 计数与 fail 必须在同一行；计数前加「前面不是数字」，一长串数字只从串首试一次(否则是平方级)。
_TEST_RED = re.compile(
    r"AssertionError|ERR_ASSERTION|assert(?:ion)?\s+failed|断言.{0,20}失败|\bnot ok[ \t]+\d|"
    r"(?<![\d.])[1-9]\d*[ \t]+fail(?:ed|ures?|ing)?\b|"
    r"\bfail(?:ed|ures?)?[ \t]*[:=][ \t]*[1-9]\d*\b|"
    r"^[^\w\n]*fail(?:ed|ures?)?[ \t]+[1-9]\d*[ \t]*$", re.I | re.M)
# 行首「FAIL <用例名>」（区分大小写，后面紧跟名字或路径）：jest / pytest / unittest / go test 的逐条失败行。
_TEST_RED_NAMED = re.compile(r"^[ \t]*(?:---[ \t]*)?FAIL(?:ED)?:?[ \t]+[\w./\\\[<]", re.M)
_SOME_PASS = re.compile(r"(?<!\d)[1-9]\d*\s+PASS|#\s*pass\s+[1-9]", re.I)
SCAN_MAX = 200000      # 分类最多扫这么多字符；更长的输出只看首尾各一半，全文仍在验证日志里


def _bounded(output):
    if len(output) <= SCAN_MAX:
        return output
    half = SCAN_MAX // 2
    return output[:half] + "\n" + output[-half:]


def _crashed(code):
    """验证命令没有正常给出退出码：没跑起来(None)、宿主中止(负数)、被信号或 Windows 异常终止(≥128，含 NTSTATUS)。"""
    return not isinstance(code, int) or isinstance(code, bool) or code < 0 or code >= 128


def classify(rc, tail, verification, evidence=None):
    """只明确的测试红可续修；未知故障保守归环境异常。"""
    model = str(tail or "") + "\n" + str(evidence or "")
    if _BLOCKED.search(model):
        return "blocked"
    if rc != 0:
        return "environment"
    if not verification or verification.get("ok"):
        return "passed" if evidence else "environment"
    output = _bounded(str(verification.get("full_out", verification.get("out")) or ""))
    if _crashed(verification.get("rc")) or verification.get("code") or _ENVIRONMENT.search(output):
        return "environment"
    if re.search(r"\bTypeError\b", output) and not _SOME_PASS.search(output):
        return "environment"
    return "test_failure" if _TEST_RED.search(output) or _TEST_RED_NAMED.search(output) else "environment"


def repair_prompt(verification, log_path, evidence_path, round_number):
    """只携带本轮失败；长输出按完整段落取舍，全文在原 run 日志。"""
    output = str(verification.get("full_out", verification.get("out")) or "").strip()
    excerpt = whole_text(output, 4500, f"请协调者从完整日志 {log_path} 取回所需原文；未取得必要项时按原规则交回原卡等待。")
    return (f"本次尝试第 {round_number} 轮，就地修复刚才的验证失败。保持原任务、会话、模型、强度与权限。\n"
            f"验证键：{verification.get('key')}，退出码：{verification.get('rc')}。\n"
            + excerpt
            + f"\n完整验证日志：{log_path}" + (f"（{verification['log_bytes']} UTF-8 bytes）" if verification.get("log_bytes") is not None else "")
            + f"\n更新交付证据：{evidence_path}\n"
              "只处理这次失败；如确实卡住请明确说明，不另开任务或提高档位。")
