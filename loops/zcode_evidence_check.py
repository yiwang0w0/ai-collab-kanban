#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Zcode 执行循环用的证据合同小工具：判据只复用 evidence_contract，自身不含判据。

以 -I -S -B -X utf8 运行。隔离模式下脚本目录不在 sys.path 里，所以自己放进去。
输入走 UTF-8 字节，输出一律是 ensure_ascii 的 JSON，不受控制台码页影响。
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evidence_contract  # noqa: E402  先放路径再导入


def zcode_prompt(contract):
    """Zcode 线自己的提示文本。四节标题取自 evidence_contract.HEADINGS，格式示例与其校验规则一致。

    不照搬 evidence_contract.prompt()：那一份写着「超限拒收并同会话要求精简」和「登记验证日志由宿主附加」，
    这两件事在 Zcode 线上都不会发生（没有重写回合，也没有宿主验证），写给模型就是与实际不符的流程。
    """
    first, changes, checks, pending = evidence_contract.HEADINGS
    return ["【证据正文合同】仅以下四节，不能添加背景、过程或自解释。",
            f"正文最多 {contract['max_chars']} Unicode 字符（emoji 按一个码点计）。本次运行只交付一次，不会退回重写：超限或不合四节会如实标在卡上，由验收人判断。",
            "# " + first, "结论、改动和需要人做的事，共 1 至 3 行。",
            "# " + changes, "path:12-18 一句话。无改动写无。",
            "# " + checks, "cmd -> pass 2 / fail 0",
            "未执行写 cmd -> pass 0 / fail 0（未执行），cmd 替换为实际检查命令；保留命令名和 ->，不要虚构检查。",
            "# " + pending, "每条一行；没有写无。",
            # 合同校验另有两条模型不说就不知道的规则：改动与检查的单行上限、正文不写以「——」开头的行。
            f"不内联长输出或代码块；改动与检查每行不超过 {evidence_contract.LINE_MAX} 字符，正文不写以「——」开头的行。"
            "本次运行没有命令工具，也没有宿主代为验证：没有实际执行过的检查一律按未执行写。"]


def main(argv):
    if (len(argv) != 3 or argv[0] not in ("prompt", "validate") or argv[1] != "--max-chars"
            or not re.fullmatch(r"[1-9][0-9]{0,6}", argv[2], re.ASCII)):
        sys.stderr.write("usage: zcode_evidence_check.py prompt|validate --max-chars N\n")
        return 2
    contract = {"version": 1, "max_chars": int(argv[2])}
    if argv[0] == "prompt":
        value = zcode_prompt(contract)
    else:
        value = evidence_contract.validate(sys.stdin.buffer.read().decode("utf-8"), contract)
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=True).encode("ascii") + b"\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
