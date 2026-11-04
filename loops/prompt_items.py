# -*- coding: utf-8 -*-
"""提示词按完整项取舍；只处理文本，不读取看板或扩大执行权限。"""
import re


def _paragraphs(text):
    items, current, fence = [], [], None
    for line in text.splitlines(keepends=True):
        mark = re.match(r"^\s*(`{3,}|~{3,})", line)
        if mark:
            token = mark.group(1)
            if fence is None:
                fence = (token[0], len(token))
            elif token[0] == fence[0] and len(token) >= fence[1] and not line[mark.end():].strip():
                fence = None
        if not line.strip() and fence is None:
            if current:
                items.append("".join(current).strip()); current = []
        else:
            current.append(line)
    if current:
        items.append("".join(current).strip())
    return items


def _numbers(values):
    groups = []
    for value in values:
        if groups and groups[-1][1] + 1 == value:
            groups[-1][1] = value
        else:
            groups.append([value, value])
    return "、".join(str(a) if a == b else f"{a}—{b}" for a, b in groups)


def whole_text(text, budget, reference="", unit="段落", mode="paragraphs"):
    """正文预算只收完整项，优先最新项；编号为原文位置，取回说明另计。"""
    value = str(text or "")
    if len(value) <= budget:
        return value
    items = ([value] if mode == "item" else value.splitlines() if mode == "lines" else _paragraphs(value))
    separator = "\n" if mode == "lines" else "\n\n"
    kept, used = [], 0
    for index in range(len(items) - 1, -1, -1):
        size = len(items[index]) + (len(separator) if kept else 0)
        if used + size <= max(0, budget):
            kept.append(index); used += size
    kept.reverse()
    chosen = set(kept)
    omitted = [i + 1 for i in range(len(items)) if i not in chosen]
    body = separator.join(items[i] for i in kept)
    note = f"[省略 {len(omitted)} 个完整{unit}，原文项号：{_numbers(omitted)}；未截取任何半项。"
    if reference:
        note += reference
    return body + ("\n\n" if body else "") + note + "]"


def retrieval_hint(task, kind=None, field="description"):
    """只引用宿主声明的真实历史序号；旧文本和未归属字段不推测编号。"""
    task = task or {}
    ident = task.get("id")
    number = str(ident) if isinstance(ident, int) and not isinstance(ident, bool) and ident > 0 else None
    ref = (task.get("history_refs") or {}).get(kind) if kind else None
    seq = ref.get("seq") if isinstance(ref, dict) else None
    if number and isinstance(seq, int) and not isinstance(seq, bool) and seq > 0 and kind in ("decisions", "evidence"):
        target = f"任务 #{number} 的 {kind} seq={seq}；请协调者按编号取回 GET /api/tasks/{number}/{kind}/{seq}。"
    else:
        target = (f"任务 #{number}" if number else "原卡") + f" 的 {field} 字段；历史编号未知，请协调者读取该原字段。"
    return target + "执行必需的全文未取得时，按原规则交回原卡等待；此指引不授予命令或网络权限。"
