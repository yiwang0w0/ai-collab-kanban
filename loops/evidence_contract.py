#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模型证据正文合同；宿主验证、用量和提交附录不属于正文。"""
import re

HEADINGS = ("给人看的结果", "改动", "检查", "未决")


def for_task(task):
    value = (task.get("verification_repair") or {}).get("evidence_contract")
    if not isinstance(value, dict) or value.get("version") != 1:
        return None
    limit = value.get("max_chars")
    return value if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0 else None


def measure(text):
    """Unicode 码点计数，与 JS Array.from(text).length 一致；字节独立按 UTF-8。"""
    return {"chars": len(text), "bytes": len(text.encode("utf-8"))}


def validate(text, contract):
    measured = measure(text)
    if not contract:
        return {"ok": True, **measured, "errors": []}
    errors = []
    if measured["chars"] > contract["max_chars"]:
        errors.append(f"正文 {measured['chars']} Unicode 字符超过 {contract['max_chars']} 上限")
    sections, current, seen = {}, None, []
    for line in text.splitlines():
        heading = re.fullmatch(r"#{1,6}\s+(.+?)\s*", line)
        if heading:
            current = heading.group(1)
            seen.append(current); sections.setdefault(current, [])
        elif line.strip():
            if current is None:
                errors.append("正文不能在四节前添加背景或过程")
            else:
                sections[current].append(re.sub(r"^\s*[-*]\s+", "", line).strip())
    if tuple(seen) != HEADINGS:
        errors.append("按顺序只写四节：给人看的结果、改动、检查、未决")
    else:
        if not 1 <= len(sections[HEADINGS[0]]) <= 3:
            errors.append("给人看的结果须为 1 至 3 个非空行")
        for name in HEADINGS[1:]:
            if not sections[name]:
                errors.append(f"{name}不能为空，无事项请写无")
        for line in sections["改动"]:
            if line != "无" and not re.fullmatch(r".+:\d+(?:-\d+)?\s+\S.*", line):
                errors.append("改动每行写 path:行段 一句话")
                break
        for line in sections["检查"]:
            check = (r".+\s*->\s*pass\s*[:=]?\s*\d+\s*[/,，;；· ]+\s*fail\s*[:=]?\s*\d+"
                     r"(?:\s*[（(]未执行[）)])?(?:\s*[;；,，]\s*(?:日志|文件)[:：]\s*.+?\s*[（(]?\d+\s*(?:UTF-8\s*)?bytes[）)]?)?")
            if not re.fullmatch(check, line, re.I):
                errors.append("检查每行写 cmd -> pass N / fail N；未执行写 pass 0 / fail 0 并标明未执行")
                break
        if any("```" in line for lines in sections.values() for line in lines):
            errors.append("不内联长输出或代码块；只引用日志文件与实际 UTF-8 字节数")
    return {"ok": not errors, **measured, "errors": errors}


def prompt(contract):
    return ["【证据正文合同】仅以下四节，不能添加背景、过程或自解释。",
            f"正文最多 {contract['max_chars']} Unicode 字符（emoji 按一个码点计）；不含宿主附录或落盘日志。超限原文保留并拒收，同会话要求精简，不截断。",
            "# 给人看的结果", "结论、改动和需要人做的事，共 1 至 3 行。",
            "# 改动", "path:12-18 一句话。无改动写无。",
            "# 检查", "cmd -> pass 2 / fail 0。未执行写 pass 0 / fail 0（未执行）。不要虚构检查。",
            "# 未决", "每条一行；没有写无。",
            "长输出只引用日志文件及实际字节数；登记验证日志由宿主附加，无须重复执行验证。"]


def correction(result, contract, original_path, next_path):
    return ("本轮证据正文拒收：" + "；".join(result["errors"]) + "。\n"
            f"原文保留在 {original_path}（{result['chars']} 字符，{result['bytes']} UTF-8 bytes）。\n"
            f"沿同一会话、attempt、档位与剩余时限，只把正文精简或修成四节，写入 {next_path}；不要修改源码、重复检查、另开会话或提档。\n"
            + "\n".join(prompt(contract)))
