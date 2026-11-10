#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""经验库命令行。各家模型、命令行和人共用这一个入口;不调用模型、不访问看板、不联网。

  P="python cli/lessons.py"
  $P query "报错原文、卡面文字或路径" [--path tests/a.mjs]... [--top 5] [--json] [--no-candidates]
  $P query --file failure.log                 # 中日文与长输出走文件;也可以走标准输入:$P query -
  $P add --file entry.md [--scope private|public]
  $P add --id <id> --title <标题> --trigger kw:<词> [--trigger text:<片段>]... \\
         --root-cause <根因> --fix <修法> --verify <怎么确认> [--source <卡号或提交号>] [--scope private|public]
  $P ls [--scope private|public] [--candidates] [--json]
  $P verify <id> [<id>...] [--card <卡号>] [--confirm]   # 记一次命中;--confirm 另把候选转成已确认
  $P confirm <id> [<id>...]                  # 只把候选转成已确认,不记命中
  $P discard <id|待整理文件名> [...]          # 候选或 _pending/ 的文件移进 _discarded/,不删
  $P import --from <目录> [--dry-run]         # 带 name / description 的笔记 → 私有库候选;转不了的列出来

写入默认进私有库(<数据目录>/lessons/);公共库是仓库里的 lessons/。超过字数上限的条目被拒绝并说明
哪一项超了多少,不截断。条目格式与打分规则见 docs/经验库.md。

Environment:
  BOARD_DATA_DIR  数据目录,私有库在它下面的 lessons/   (default <repo>/core/.data;--data 可覆盖)

退出码:0 = 完成(查询无命中也是 0);2 = 条目不合格或参数不对。
"""
import argparse
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "loops"))
import lessons_lib as lib  # noqa: E402

for _stream in (sys.stdout, sys.stderr, sys.stdin):
    # 管道里的默认编码是控制台码页,不是 UTF-8;不改的话中文输出到别的进程就是乱码。
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _fail(errors):
    for line in errors:
        print("✗ " + line, file=sys.stderr)
    return 2


def _read(path):
    with io.open(path, encoding="utf-8") as source:
        return source.read()


def _public(entry):
    return {k: v for k, v in entry.items() if k not in ("overrides_public",)}


def cmd_query(args):
    if args.file:
        text = _read(args.file)
    elif args.text == ["-"]:
        text = sys.stdin.read()
    else:
        text = " ".join(args.text)
    if not text.strip() and not args.path:
        return _fail(["没有查询内容:给文字、--file <文件>、- (标准输入)或 --path <路径>"])
    entries, problems = lib.load_all(args.data)
    results = lib.query(entries, text, paths=args.path, include_candidates=not args.no_candidates)
    shown, omitted = lib.select(results, max_items=args.top, max_chars=10 ** 9)
    if args.json:
        print(json.dumps({"results": [_public(e) for e in shown], "omitted": [e["id"] for e in omitted],
                          "problems": problems}, ensure_ascii=False, indent=2))
        return 0
    for problem in problems:
        print(f"⚠ 读不进来:{problem['path']} — " + "；".join(problem["errors"]), file=sys.stderr)
    if not results:
        print("无命中。")
        return 0
    print(f"命中 {len(results)} 条,显示 {len(shown)} 条(整条,不截断):")
    for entry in shown:
        print()
        print(lib.attach_text(entry, entry["why"]))
        print(f"  得分:{entry['score']}  来源:{entry['source']}  文件:{entry['path']}")
    if omitted:
        print()
        print(lib.more_note(omitted).replace("用 python cli/lessons.py query 查", "加大 --top 查看"))
    return 0


def cmd_add(args):
    if args.file:
        try:
            entry = lib.parse_entry(_read(args.file))
        except lib.LessonError as error:
            return _fail(error.errors)
    else:
        missing = [flag for flag, value in (("--id", args.id), ("--title", args.title), ("--trigger", args.trigger),
                                           ("--root-cause", args.root_cause), ("--fix", args.fix),
                                           ("--verify", args.verify)) if not value]
        if missing:
            return _fail(["缺参数:" + " ".join(missing) + "(或改用 --file entry.md)"])
        entry = {"id": args.id, "title": args.title, "trigger": list(args.trigger), "root_cause": args.root_cause,
                 "fix": args.fix, "verify": args.verify}
    if args.source:
        entry["source"] = args.source
    entry.setdefault("source", "手工录入")
    if args.scope:
        entry["scope"] = args.scope
    try:
        path = lib.add(entry, args.data)
    except lib.LessonError as error:
        return _fail(error.errors + ["没有写入任何文件。"])
    print(f"已写入 {path}")
    return 0


def cmd_ls(args):
    entries, problems = lib.load_all(args.data)
    if args.scope:
        entries = [e for e in entries if e["scope"] == args.scope]
    if args.candidates:
        entries = [e for e in entries if e.get("status") == "candidate"]
    pending = os.path.join(lib.private_dir(args.data), "_pending")
    waiting = sorted(os.listdir(pending)) if os.path.isdir(pending) else []
    if args.json:
        print(json.dumps({"entries": [_public(e) for e in entries], "problems": problems, "pending": waiting},
                         ensure_ascii=False, indent=2))
        return 0
    for entry in entries:
        kind = ("私有" if entry["scope"] == "private" else "公共") + ("·候选" if entry.get("status") == "candidate" else "")
        print(f"{entry['id']}\t{kind}\t命中 {entry['hits']}\t{entry['last_verified']}\t{entry['title']}")
    print(f"共 {len(entries)} 条" + (f";待整理 {len(waiting)} 份({pending})" if waiting else ""))
    for problem in problems:
        print(f"⚠ 读不进来:{problem['path']} — " + "；".join(problem["errors"]), file=sys.stderr)
    return 0


def cmd_verify(args):
    code = 0
    for ident in args.ids:
        try:
            if args.confirm:
                lib.confirm(args.data, ident)
            hits = lib.record_hit(args.data, ident, args.card)
            print(f"{ident}:命中 {hits} 次,最近验证 {lib.today()}" + (";已转为已确认" if args.confirm else ""))
        except lib.LessonError as error:
            code = _fail(error.errors)
    return code


def cmd_confirm(args):
    code = 0
    for ident in args.ids:
        try:
            lib.confirm(args.data, ident)
            print(f"{ident}:已转为已确认(不记命中)")
        except lib.LessonError as error:
            code = _fail(error.errors)
    return code


def cmd_discard(args):
    code = 0
    for ident in args.ids:
        try:
            print(f"{ident}:已丢弃 → {lib.discard(args.data, ident)}")
        except lib.LessonError as error:
            code = _fail(error.errors)
    return code


def cmd_import(args):
    if not os.path.isdir(args.source):
        return _fail([f"目录不存在:{args.source}"])
    result = lib.import_notes(args.source, args.data, dry_run=args.dry_run)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    verb = "可转(未写入)" if args.dry_run else "已转成候选"
    print(f"{verb} {len(result['written'])} 份;转不了 {len(result['skipped'])} 份。")
    for row in result["written"]:
        print(f"  ✓ {row['file']} → {row['id']}")
    for row in result["skipped"]:
        print(f"  ✗ {row['file']}:" + "；".join(row["reasons"]))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="lessons.py", description="经验库:查询 / 添加 / 列出 / 记命中 / 导入")
    parser.add_argument("--data", default=lib.default_data_dir(), help="数据目录(默认 BOARD_DATA_DIR)")
    sub = parser.add_subparsers(dest="command", required=True)

    q = sub.add_parser("query", help="按触发特征查,返回整条与命中原因")
    q.add_argument("text", nargs="*", help="报错输出、卡面文字或路径;- = 从标准输入读")
    q.add_argument("--file", help="从文件读查询内容")
    q.add_argument("--path", action="append", default=[], help="涉及的路径,可重复")
    q.add_argument("--top", type=int, default=5, help="最多显示几条(默认 5)")
    q.add_argument("--json", action="store_true")
    q.add_argument("--no-candidates", action="store_true", help="不看未经确认的候选")
    q.set_defaults(run=cmd_query)

    a = sub.add_parser("add", help="校验后写入(默认私有库)")
    a.add_argument("--file", help="条目 Markdown 文件")
    a.add_argument("--id")
    a.add_argument("--title")
    a.add_argument("--trigger", action="append", default=[], help="kw:<词> / text:<片段> / path:<glob>,可重复")
    a.add_argument("--root-cause")
    a.add_argument("--fix")
    a.add_argument("--verify")
    a.add_argument("--source")
    a.add_argument("--scope", choices=("private", "public"))
    a.set_defaults(run=cmd_add)

    l = sub.add_parser("ls", help="列出两库合并后的条目")
    l.add_argument("--scope", choices=("private", "public"))
    l.add_argument("--candidates", action="store_true", help="只看候选")
    l.add_argument("--json", action="store_true")
    l.set_defaults(run=cmd_ls)

    v = sub.add_parser("verify", help="给条目记一次命中并更新最近验证日期")
    v.add_argument("ids", nargs="+")
    v.add_argument("--card", type=int, help="是哪张卡验证的(可选)")
    v.add_argument("--confirm", action="store_true", help="同时把候选转成已确认")
    v.set_defaults(run=cmd_verify)

    c = sub.add_parser("confirm", help="把候选转成已确认(不记命中)")
    c.add_argument("ids", nargs="+")
    c.set_defaults(run=cmd_confirm)

    d = sub.add_parser("discard", help="丢弃候选或待整理文件:移进 _discarded/,不删")
    d.add_argument("ids", nargs="+", help="候选 id,或 ls 列出的待整理文件名")
    d.set_defaults(run=cmd_discard)

    i = sub.add_parser("import", help="把一批带 name / description 的笔记转成私有库候选")
    i.add_argument("--from", dest="source", required=True, help="笔记所在目录")
    i.add_argument("--dry-run", action="store_true", help="只列出能转与不能转的,不写入")
    i.add_argument("--json", action="store_true")
    i.set_defaults(run=cmd_import)

    args = parser.parse_args(argv)
    if getattr(args, "top", 1) < 1:
        return _fail(["--top 至少为 1"])
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
