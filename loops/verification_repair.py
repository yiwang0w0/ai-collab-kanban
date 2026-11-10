#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证续修的纯判定；不启动进程，不读取环境或看板。"""
import re
import evidence_contract
from prompt_items import whole_text


_ENVIRONMENT = re.compile(
    r"(?:超时|timeout|timed out|无法启动|spawn.{0,30}(?:失败|error)|"
    r"ENOENT|EACCES|EADDRINUSE|ECONNREFUSED|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|"
    r"\b(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|EPERM|EBUSY|ENOSPC)\b|"
    r"No space left on device|out of memory|Access is denied|拒绝访问|"
    r"ModuleNotFoundError|ImportError|FileNotFoundError|Cannot find (?:module|package)|"
    r"No such file|not recognized as|不是内部或外部命令|command not found|"
    r"端口.{0,20}(?:占用|不可用)|登记簿|harness itself|0\s*PASS.{0,100}TypeError)", re.I | re.S)
# 「模型声明卡住」只认明确的直陈：第一人称的卡住、句末的「无法继续」、点名要人工或操作者出手。
# 裸词不算：「修复了无法继续续租的问题」「Not stuck」是在说别的事。
_BLOCKED = re.compile(
    r"我(?:已经|已|现在|目前)?(?:被)?卡住|"
    r"无法继续(?:执行|推进|进行|修复|完成|处理|开发|工作|下去)?(?=[，。；！、,.;!\s]|$)|"
    r"需要人工(?:介入|处理|协助)|需要操作者(?:提供|处理|介入)|"
    r"\bI(?:'m| am)(?: still| now)? (?:blocked|stuck)\b|\b(?:cannot|can't|can not|unable to) proceed\b", re.I)
# 紧贴在声明前面的否定：「不需要…」「没有任何需要…」「并非无法继续」；英文在同一分句内的 not / no / never。
_NEGATED_ZH = re.compile(r"(?:不|没有?|無|无|未|非|别|勿|毋)(?:再|太|用|必|是|曾|会|能|见)?(?:任何|什么|其他|其它)?$")
_NEGATED_EN = re.compile(r"(?:\b(?:not|no|never|without|neither|nor)\b|n't\b)[^.,;!?\n]{0,40}$", re.I)
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


def _prose_lines(text):
    """散文里代码围栏以外的行；围栏里多半是引用的日志或示例。"""
    fence = None
    for line in text.splitlines():
        mark = re.match(r"\s*(`{3,}|~{3,})", line)
        if mark:
            fence = mark.group(1)[0] if fence is None else None if mark.group(1)[0] == fence else fence
        elif fence is None:
            yield line


def declares_blocked(tail, evidence=None):
    """模型有没有明确声明自己卡住。只看该看的地方：模型最后的回话；四节证据的「给人看的结果」与「未决」两节
    （「改动」「检查」是文件与命令清单）；散文证据里代码围栏以外的行。紧贴否定词的说法不算。"""
    lines = _bounded(str(tail or "")).splitlines()
    body = _bounded(str(evidence or ""))
    parts = evidence_contract.sections(body)
    lines += (parts[evidence_contract.HEADINGS[0]] + parts[evidence_contract.HEADINGS[3]] if parts
              else list(_prose_lines(body)))
    for line in lines:
        for found in _BLOCKED.finditer(line):
            start = found.start()
            if not _NEGATED_ZH.search(line[max(0, start - 12):start]) and not _NEGATED_EN.search(line[max(0, start - 60):start]):
                return True
    return False


def classify(rc, tail, verification, evidence=None):
    """只明确的测试红可续修；未知故障保守归环境异常。"""
    if rc == 0 and evidence and verification and verification.get("ok"):
        return "passed"        # 登记验证通过的交付照常交付；正文里的字样留给审阅看，不在这里判卡住
    if declares_blocked(tail, evidence):
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
