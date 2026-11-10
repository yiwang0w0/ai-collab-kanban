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


# 「改动」「检查」两节按行解析；一行超过这个长度直接拒收，不送进正则，逐行解析的耗时因此有界。
# 另两节是给人读的文字，只受正文总上限约束。
LINE_MAX = 1000

# 以下模式都在「空白已压成单个空格」的行上匹配；相邻位置没有两个都能吃空白的量词，匹配失败时不回溯放大。
_RESULT = re.compile(r"pass ?[:=]? ?(\d+)(?: |(?: ?[/,，;；·])+ ?)fail ?[:=]? ?(\d+)", re.I)
_UNRUN = re.compile(r" ?[（(]未执行[）)]")
_LOG_HEAD = re.compile(r" ?[;；,，] ?(?:日志|文件)[:：] ?")
_LOG_SIZE = re.compile(r"(?<!\d)\d+ ?(?:UTF-8 ?)?bytes[）)]?$", re.I)


def heading_title(line):
    """行首 1 至 6 个 # 后跟空白的标题名；不是标题返回 None。纯字符串切分。"""
    title = line.lstrip("#")
    hashes = len(line) - len(title)
    if not 1 <= hashes <= 6 or not title[:1].isspace():
        return None
    return title.strip()


def _split(text):
    """按标题切节：返回 (各节的非空行, 标题出现顺序, 首个标题前是否有正文)。"""
    sections, current, seen, stray = {}, None, [], False
    for line in text.splitlines():
        heading = heading_title(line)
        if heading is not None:
            current = heading
            seen.append(current); sections.setdefault(current, [])
        elif line.strip():
            if current is None:
                stray = True
            else:
                sections[current].append(re.sub(r"^\s*[-*]\s+", "", line).strip())
    return sections, seen, stray


def sections(text):
    """正文是四节形状（最前面依次是那四个标题）时返回各节的非空行，否则 None。
    第四节之后再出现的标题不属于正文（宿主附录、日志摘录），到那里为止。"""
    found, current = {}, None
    for line in str(text or "").splitlines():
        heading = heading_title(line)
        if heading is not None:
            if len(found) == len(HEADINGS):
                break
            if heading != HEADINGS[len(found)]:
                return None
            current = found.setdefault(heading, [])
        elif line.strip():
            if current is None:
                return None
            current.append(re.sub(r"^\s*[-*]\s+", "", line).strip())
    return found if len(found) == len(HEADINGS) else None


def check_line(line):
    """解析一条检查行 `cmd -> pass N / fail N[（未执行）][；日志: 路径（N bytes）]`。
    合法返回 {"passed", "failed", "unrun"}（计数保持原数字串），否则返回 None。"""
    text = " ".join(line.split())
    arrow = text.find("->", 1)          # 箭头前至少有一个字符的命令名
    while arrow != -1:
        result = _RESULT.match(text, arrow + 3 if text.startswith(" ", arrow + 2) else arrow + 2)
        if result:
            end = result.end()
            unrun = _UNRUN.match(text, end)
            if unrun:
                end = unrun.end()
            found = {"passed": result.group(1), "failed": result.group(2), "unrun": bool(unrun)}
            if end == len(text):
                return found
            head = _LOG_HEAD.match(text, end)
            # 日志引用：路径非空，行尾是字节数。
            size = _LOG_SIZE.search(text, head.end()) if head else None
            if size and size.start() > head.end():
                return found
        arrow = text.find("->", arrow + 1)
    return None


# 宿主附加在正文之后的标记。正文里不许出现：审阅线按这些标记识别循环验证，模型写一行就等于自己盖章。
_HOST_MARKS = ("宿主验证附录", "验证(由循环执行", "验证（由循环执行")


def declares_unrun(text):
    """证据里有没有「这条检查没执行」的声明：四节形状的「检查」节里出现「未执行」，
    或任何位置出现一条合同形状的检查行带（未执行）。只做识别，不校验格式。"""
    text = str(text or "")
    parts = sections(text)
    if parts and any("未执行" in line for line in parts["检查"]):
        return True
    for line in text.splitlines():
        if "未执行" in line and "->" in line and len(line) <= LINE_MAX:
            found = check_line(line)
            if found and found["unrun"]:
                return True
    return False


def validate(text, contract):
    measured = measure(text)
    if not contract:
        return {"ok": True, **measured, "errors": []}
    if measured["chars"] > contract["max_chars"]:
        # 超限即拒收并返回，不再解析正文：校验耗时不随超限内容增长。
        return {"ok": False, **measured,
                "errors": [f"正文 {measured['chars']} Unicode 字符超过 {contract['max_chars']} 上限"]}
    errors = []
    sections, seen, stray = _split(text)
    if stray:
        errors.append("正文不能在四节前添加背景或过程")
    if tuple(seen) != HEADINGS:
        errors.append("按顺序只写四节：给人看的结果、改动、检查、未决")
    else:
        if not 1 <= len(sections[HEADINGS[0]]) <= 3:
            errors.append("给人看的结果须为 1 至 3 个非空行")
        for name in HEADINGS[1:]:
            if not sections[name]:
                errors.append(f"{name}不能为空，无事项请写无")
        parsed = sections["改动"] + sections["检查"]
        if any(len(line) > LINE_MAX for line in parsed):
            errors.append(f"改动与检查单行最多 {LINE_MAX} 字符；长输出只引用日志文件与实际 UTF-8 字节数")
            return {"ok": False, **measured, "errors": errors}
        for line in sections["改动"]:
            if line != "无" and not re.fullmatch(r".+:\d+(?:-\d+)?\s+\S.*", line):
                errors.append("改动每行写 path:行段 一句话")
                break
        for line in sections["检查"]:
            found = check_line(line)
            if not found:
                errors.append("检查每行写 cmd -> pass N / fail N；未执行写 cmd -> pass 0 / fail 0（未执行）")
                break
            if found["unrun"] and (int(found["passed"]) or int(found["failed"])):
                errors.append("声明未执行的检查只能写 pass 0 / fail 0：没执行就没有计数")
                break
        if any(line.startswith("——") or any(mark in line for mark in _HOST_MARKS)
               for lines in sections.values() for line in lines):
            errors.append("正文不写宿主附录，也不写以「——」开头的行：登记验证由宿主执行并另行附加")
        if any("```" in line for lines in sections.values() for line in lines):
            errors.append("不内联长输出或代码块；只引用日志文件与实际 UTF-8 字节数")
    return {"ok": not errors, **measured, "errors": errors}


def prompt(contract):
    return ["【证据正文合同】仅以下四节，不能添加背景、过程或自解释。",
            f"正文最多 {contract['max_chars']} Unicode 字符（emoji 按一个码点计）；不含宿主附录或落盘日志。超限原文保留并拒收，同会话要求精简，不截断。",
            "# 给人看的结果", "结论、改动和需要人做的事，共 1 至 3 行。",
            "# 改动", "path:12-18 一句话。无改动写无。",
            "# 检查", "cmd -> pass 2 / fail 0",
            "未执行写 cmd -> pass 0 / fail 0（未执行），cmd 替换为实际检查命令；保留命令名和 ->，不要虚构检查。",
            "# 未决", "每条一行；没有写无。",
            "长输出只引用日志文件及实际字节数；登记验证日志由宿主附加，无须重复执行验证，正文不写宿主附录或以「——」开头的行。"]


def size_text(result):
    """给人看的尺寸；文件超过读入上限时没有字符数，只有字节数。"""
    return ((f"{result['chars']} 字符，" if result.get("chars") is not None else "")
            + f"{result['bytes']} UTF-8 bytes")


def correction(result, contract, original_path, next_path):
    return ("本轮证据正文拒收：" + "；".join(result["errors"]) + "。\n"
            f"原文保留在 {original_path}（{size_text(result)}）。\n"
            f"沿同一会话、attempt、档位与剩余时限，只把正文精简或修成四节，写入 {next_path}；不要修改源码、重复检查、另开会话或提档。\n"
            + "\n".join(prompt(contract)))
