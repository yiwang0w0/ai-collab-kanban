#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Zcode 执行循环用的证据合同小工具：只复用 evidence_contract，自身不含判据。

以 -I -S -B -X utf8 运行。隔离模式下脚本目录不在 sys.path 里，所以自己放进去。
输入走 UTF-8 字节，输出一律是 ensure_ascii 的 JSON，不受控制台码页影响。
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evidence_contract  # noqa: E402  先放路径再导入


def main(argv):
    if (len(argv) != 3 or argv[0] not in ("prompt", "validate") or argv[1] != "--max-chars"
            or not re.fullmatch(r"[1-9][0-9]{0,6}", argv[2], re.ASCII)):
        sys.stderr.write("usage: zcode_evidence_check.py prompt|validate --max-chars N\n")
        return 2
    contract = {"version": 1, "max_chars": int(argv[2])}
    if argv[0] == "prompt":
        value = evidence_contract.prompt(contract)
    else:
        value = evidence_contract.validate(sys.stdin.buffer.read().decode("utf-8"), contract)
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=True).encode("ascii") + b"\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
