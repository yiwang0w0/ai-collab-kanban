#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unified board CLI. Every line uses this; do not talk to the API with raw curl.

  P="python cli/board.py"
  $P ls [--status not_started|in_progress|waiting|done] [--line alpha] [--archived false|true|all]
  $P show <id>
  $P create --template                       # 离线打印现有字段的执行者模板 JSON，不访问看板
  $P create --file payload.json          # payload 的键与 POST /api/tasks 相同:subject(必填)、summary
                                             #   (给人看的「要做什么」,两行以内)、description、acceptance、
                                             #   line、route、verifyCmd、parentId、blockedBy、needsBash、kind、
                                             #   execution_profile_id、model、effort。其它键由服务端丢弃。
                                             #   放行、尝试次数、人工闸等控制须走原有 release/hold/edit 命令。
  $P claim --as alpha                        # pick-a-card claim (routing/locks/deps decided server-side)
  $P take  <id> --as coord --version <aggregate_version>                   # claim a SPECIFIC id (coordinator finishing one card)
  $P edit  <id> --file payload.json --version <aggregate_version>          # rewrite the card face. An in-progress card accepts ONLY a
                                             #   tail-append to description, invisible to this round's worker
  $P done  <id> --as alpha --run <run_id> --file evidence.md   # -> waiting/review
  $P wait  <id> --as alpha --run <run_id> --file reason.md     # -> waiting/decision (own attempts exhausted)
  $P approve|reject <id> [--file note.md] [--verify-ok] --version <aggregate_version>
  $P reopen <id> [--line alpha] --version <aggregate_version>              # done/waiting -> not_started (attempts + ruling history kept)
  $P release|hold <id> --version <aggregate_version>                       # release to workers / pull back into coordinator staging
  $P archive <id> [--restore|--force] --version <aggregate_version>
  $P lines status|start <line|all>|stop <line|all>   # worker-loop supervisor
  $P bless                                   # accept THIS tree: write the gated subtree's hash to
                                             #   <data>/accepted_rev (the revision gate compares against it)

多执行者协作(docs/多执行者协作.md)。--token-file <文件> 改用执行者令牌,其余命令照旧;不给则用 board_token:
  $P exec register <id> [--kind line|external|other] [--name 名] [--file payload.json] [--save 令牌文件]   # 操作员
  $P exec status [--file status.json]        # 有 --file = 写自己的 {current,done,next};没有 = 列出各执行者
  $P exec heartbeat [--task <id>] [--lease <分钟>]
  $P exec stop                               # 停下并生成交接包
  $P lock acquire <资源> --minutes <分钟> (--purpose <用途> | --file purpose.txt)
  $P lock release <资源> [--force --file reason.txt]   # --force 只属于操作员,必须写理由
  $P lock ls [--all]
  $P journal add --kind <种类> --file body.txt [--artifact sha256:<hex>|commit:<sha>|path:<路径>|url:<地址>]...
  $P journal ls [--since <编号或时刻>] [--executor <id>] [--limit <n>]
  $P handoff ls [--all] | handoff show <id> | handoff ack <id>
  take / claim 可带 --lease <分钟>(执行者令牌上限 240);持执行者令牌时 --as 可省略

批准接口(docs/批准接口.md):
  $P approvals ls                            # 待批准事项:id、摘要、可选动作
  $P approvals approve|reject <事项id> [--file note.txt] [--client cli] [--device 名] [--version <expected_version>]
                                             # 不给 --version 时用事项 id 的版本段;版本变了返回 409
  $P approval-token create (--label <名称> | --file label.txt) [--save 令牌文件]   # 操作员;明文只显示一次
  $P approval-token revoke <id> | approval-token ls

Task control writes (take/edit/approve/reject/reopen/release/hold/archive) require
--version <aggregate_version from show>; a JSON edit payload may carry expected_version.

Environment:
  BOARD_URL           board base URL                       (default http://127.0.0.1:47824)
  BOARD_DATA_DIR      data dir holding board_token         (default <repo>/core/.data)
  BOARD_CLI_RUNTIME   runtime badge stamped by claim/take  (default "cli")
  BOARD_DEFAULT_ROUTE default --route for pick-a-card claim (default "default")

Exactly four states: not_started / in_progress / waiting / done.
There is deliberately no "stuck" state — a worker that cannot produce keeps trying
on its own, and lands in waiting/decision only when its own attempts are exhausted.

A ruling can go three ways:
   empty note + approve -> done
   empty note + reject  -> not_started (back to its original line)
   NON-EMPTY note (approve OR reject) -> not_started, SAME line (the original
      worker holds the context; rerouting forced a full context rebuild = double
      burn, measured — so the card goes back to whoever was working it)
   -- text written by a human is an instruction, not a comment; if the card were
      closed anyway, nobody would be left to execute it.

CJK / non-ASCII text must travel via --file (write a file, pass its path), never
as a command-line argument: on Windows, argv passes through ANSI conversion and
UTF-8 arrives as U+FFFD (measured). The same rule covers Windows paths in card
text: a bare backslash inside inline JSON is an escape error (measured — a card
creation died on a C:\\ path), while a file passed via --file needs no escaping
gymnastics; inside JSON strings write / or a doubled backslash.
"""
import json, sys, io, os, re, urllib.request, urllib.error, urllib.parse

# Python on Windows writes to PIPES in the locale code page (GBK, CP932, ...).
# Card subjects legitimately contain non-ASCII — a single CJK wave dash was enough
# to kill `ls` with UnicodeEncodeError (measured). Don't bet on every caller
# remembering PYTHONUTF8; pin it here.
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

# fleet.config.json 的部署键(port/repo/gated_subtree)回填 env 缺省 —— 部署真相
# 写一次,server 与全部客户端同读(v0.3;env 已设者永远优先)。
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))
import board_env
board_env.apply()

# BOARD_PORT is honoured as a fallback — the preflight recommends it on a port
# clash, and ignoring it here would aim this client at the DEFAULT port's board.
BASE = os.environ.get("BOARD_URL") or (
    "http://127.0.0.1:" + os.environ["BOARD_PORT"] if os.environ.get("BOARD_PORT")
    else "http://127.0.0.1:47824")
HERE = os.path.dirname(os.path.abspath(__file__))
# Data-dir convention: the STORE owns it — core/.data by default (core/store.js is
# the writer of board_token). Reading a different default here once returned an
# empty token and every write 401'd while reads worked: a half-broken CLI that
# looks alive. Same env override as everything else.
DATA = os.environ.get("BOARD_DATA_DIR") or os.path.join(os.path.dirname(HERE), "core", ".data")

def _board_token():
    """Unreadable -> empty string: the request then fails 401 loudly rather than
    pretending auth was optional."""
    tf = arg("--token-file")
    if tf:
        try:
            return io.open(tf, encoding="utf-8").read().strip()
        except Exception as e:
            sys.exit(f"读不到 --token-file {tf}:{e}")
    try:
        return io.open(os.path.join(DATA, "board_token"), encoding="utf-8").read().strip()
    except Exception:
        return ""

def call(method, path, body=None):
    if method == "POST" and re.fullmatch(r"/api/tasks/\d+/(claim|resolve|autoreview|update|pin|release|reopen|archive)", path):
        body = dict(body or {})
        if "expected_version" not in body:
            version = arg("--version")
            if not version or not version.isascii() or not version.isdigit():
                sys.exit("此操作需要 --version <所见 aggregate_version>；先用 show 核对任务，不会自动读取新版本覆盖旧内容")
            body["expected_version"] = int(version)
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json; charset=utf-8",
                                          "X-Board-Token": _board_token()})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode("utf-8")
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        return e.code, (json.loads(raw) if raw.strip() else {})
    except urllib.error.URLError as e:
        sys.exit(f"看板不可达({BASE}):{e.reason}\n"
                 f" → 先启动:node core/server.mjs(或设 BOARD_URL)")

def die(s, d):
    sys.exit(f"{s} {json.dumps(d, ensure_ascii=False)}")

def arg(flag, default=None):
    if flag not in sys.argv: return default
    i = sys.argv.index(flag)
    if i + 1 >= len(sys.argv): sys.exit(f"{flag} 后面要跟一个值")
    return sys.argv[i + 1]

def readfile(p):
    return io.open(p, encoding="utf-8").read() if p else ""

def vis(v):
    """打印前把控制字符(含换行)、行分隔符与双向控制符换成可见的转义。执行者写进库里的文字
    原样打印的话,换行能伪造出别的行,ESC 能改写终端上已经打印的行。"""
    out, bs = [], chr(92)
    for ch in str(v):
        c = ord(ch)
        if c <= 0x1f or 0x7f <= c <= 0x9f or c in (0x2028, 0x2029) or 0x202a <= c <= 0x202e or 0x2066 <= c <= 0x2069:
            out.append(f"{bs}x{c:02x}" if c <= 0xff else f"{bs}u{c:04x}")
        else:
            out.append(ch)
    return "".join(out)

def args_of(flag):
    """同一个 flag 可给多次(--artifact)。"""
    out, i = [], 0
    while i < len(sys.argv):
        if sys.argv[i] == flag:
            if i + 1 >= len(sys.argv): sys.exit(f"{flag} 后面要跟一个值")
            out.append(sys.argv[i + 1]); i += 2
        else:
            i += 1
    return out

def lease_arg(body):
    v = arg("--lease")
    if v is None: return body
    if not v.isascii() or not v.isdigit() or not (1 <= int(v) <= 1440):
        sys.exit("--lease 必须是 1..1440 的整数分钟")
    body["lease_minutes"] = int(v)
    return body

def as_worker(body, who):
    """持执行者令牌时 --as 可省略,由服务端按令牌认定身份。"""
    if who: body["worker"] = who
    return {k: v for k, v in body.items() if v is not None}

def pos(i):
    return sys.argv[i] if len(sys.argv) > i and not sys.argv[i].startswith("--") else None

def coord_cmd(cmd):
    sub = pos(2) or ""
    if cmd == "exec":
        if sub == "register":
            eid = pos(3)
            if not eid: sys.exit("exec register <id> [--kind line|external|other] [--name 名] [--file payload.json] [--save 令牌文件]")
            body = json.loads(readfile(arg("--file"))) if arg("--file") else {}
            body["id"] = eid
            if arg("--kind"): body["kind"] = arg("--kind")
            if arg("--name"): body["name"] = arg("--name")
            if "--rotate" in sys.argv: body["rotate"] = True
            save = arg("--save")
            if save and os.path.exists(save): sys.exit(f"{save} 已存在,不覆盖")
            s, d = call("POST", "/api/coord/executors", body)
            if s >= 400: die(s, d)
            ex = d["executor"]
            if save:
                with io.open(save, "x", encoding="utf-8") as f: f.write(d["token"] + chr(10))
                print(f"已登记执行者 {ex['id']}({vis(ex['name'])},{ex['kind']});令牌已写入 {save}")
            else:
                print(f"已登记执行者 {ex['id']}({vis(ex['name'])},{ex['kind']})")
                print(f"令牌(只显示这一次):{d['token']}")
        elif sub == "status":
            if arg("--file"):
                s, d = call("POST", "/api/coord/status", json.loads(readfile(arg("--file"))))
                if s >= 400: die(s, d)
                st = d["status"]
                print(f"状态已写入 {st['updated_at']}:当前 {vis(st['current'] or '-')} · 已完成 {len(st['done'])} 项 · 下一步 {len(st['next'])} 项")
            else:
                s, d = call("GET", "/api/coord/executors")
                if s >= 400: die(s, d)
                for ex in d["executors"]:
                    st = ex["status"]
                    print(f"  {ex['id']:<16} {'活动' if ex['active'] else '已停止'} 心跳 {ex['last_seen'] or '-'}  当前 {vis(st['current'] or '-')}"
                          + (f"  下一步 {vis(st['next'][0])}" if st["next"] else ""))
        elif sub == "heartbeat":
            body = lease_arg({})
            if arg("--task"): body["task_id"] = int(arg("--task"))
            s, d = call("POST", "/api/coord/heartbeat", body)
            if s >= 400: die(s, d)
            print(f"心跳 {d['executor']['last_seen']};续租 {len(d['renewed'])} 张" +
                  "".join(f" #{r['id']}" for r in d["renewed"]))
        elif sub == "stop":
            s, d = call("POST", "/api/coord/stop", {})
            if s >= 400: die(s, d)
            h = d["handoff"]
            print(f"已停止;交接记录 #{h['id']}" + ("" if d.get("created") else "(此前已生成,未重复生成)"))
        else:
            sys.exit("exec register|status|heartbeat|stop")
    elif cmd == "lock":
        if sub == "acquire":
            res, mins = pos(3), arg("--minutes")
            purpose = arg("--purpose") or readfile(arg("--file")).strip()
            if not res or not mins or not purpose: sys.exit("lock acquire <资源> --minutes <分钟> (--purpose <用途> | --file purpose.txt)")
            try: mins = float(mins)
            except ValueError: sys.exit("--minutes 必须是数字")
            s, d = call("POST", "/api/coord/locks", {"resource": res, "minutes": mins, "purpose": purpose})
            if s == 409:
                h = d["holder"]
                sys.exit(f"409 {res} 已被 {vis(h['holder_name'])}({h['holder']})占用:{vis(h['purpose'])},开始 {h['started_at']},预计结束 {h['expected_end']}")
            if s >= 400: die(s, d)
            print(f"已加锁 {res},预计结束 {d['lock']['expected_end']}")
        elif sub == "release":
            res = pos(3)
            if not res: sys.exit("lock release <资源> [--force --file reason.txt]")
            body = {"resource": res}
            if "--force" in sys.argv: body.update({"force": True, "reason": readfile(arg("--file")).strip()})
            s, d = call("POST", "/api/coord/locks/release", body)
            if s >= 400: die(s, d)
            print(f"已释放 {res}" + (f"(强制:{vis(d['lock']['release_reason'])})" if d["lock"]["released_by"] == "operator" else ""))
        elif sub == "ls":
            s, d = call("GET", "/api/coord/locks" + ("?all=1" if "--all" in sys.argv else ""))
            if s >= 400: die(s, d)
            if not d["locks"]: print("没有被锁的资源")
            for l in d["locks"]:
                state = "已释放" if l["released_at"] else ("逾期" if l["overdue"] else "持有中")
                print(f"  {l['resource']:<28} {state:<4} {l['holder']:<16} 预计结束 {l['expected_end']}  {vis(l['purpose'])}")
        else:
            sys.exit("lock acquire|release|ls")
    elif cmd == "journal":
        if sub == "add":
            kind, body = arg("--kind"), readfile(arg("--file")).strip()
            if not kind or not body: sys.exit("journal add --kind <种类> --file body.txt [--artifact 类型:值]...")
            arts = []
            for a in args_of("--artifact"):
                t, sep, v = a.partition(":")
                if not sep: sys.exit(f"--artifact 要写成 类型:值,收到 {a}")
                arts.append({"type": t, "value": v})
            s, d = call("POST", "/api/coord/journal", {"kind": kind, "body": body, "artifacts": arts})
            if s >= 400: die(s, d)
            print(f"已记流水 #{d['entry']['id']} {d['entry']['at']}")
        elif sub == "ls":
            # 值要做 URL 编码:带正时区的 ISO 时刻里的 + 不编码会被服务端解成空格。
            qs = urllib.parse.urlencode({k: arg("--" + k) for k in ("since", "executor", "limit") if arg("--" + k)})
            s, d = call("GET", "/api/coord/journal" + ("?" + qs if qs else ""))
            if s >= 400: die(s, d)
            for e in d["entries"]:
                arts = " ".join(vis(f"{a['type']}:{a['value']}") for a in e["artifacts"])
                print(f"  #{e['id']:<5} {e['at']} {vis(e['executor']):<16} {vis(e['kind']):<16} {vis(e['body'])}" + (f"  [{arts}]" if arts else ""))
        else:
            sys.exit("journal add|ls")
    elif cmd == "handoff":
        hid = pos(3)
        if sub == "ls":
            s, d = call("GET", "/api/coord/handoffs" + ("" if "--all" in sys.argv else "?pending=1"))
            if s >= 400: die(s, d)
            if not d["handoffs"]: print("没有待接手的交接")
            for h in d["handoffs"]:
                p = h["package"]
                print(f"  #{h['id']:<4} {h['executor']:<16} {h['reason']:<16} {h['created_at']}  目标 {vis(p.get('goal') or '-')}"
                      + (f"  已由 {h['ack']['by']} 接手" if h["ack"] else ""))
        elif sub == "show" and hid:
            s, d = call("GET", f"/api/coord/handoffs/{hid}")
            if s >= 400: die(s, d)
            print(chr(10).join(vis(line) for line in json.dumps(d["handoff"], ensure_ascii=False, indent=1).split(chr(10))))
        elif sub == "ack" and hid:
            s, d = call("POST", f"/api/coord/handoffs/{hid}/ack", {})
            if s >= 400: die(s, d)
            print(f"已确认接手交接 #{hid}")
        else:
            sys.exit("handoff ls [--all] | handoff show <id> | handoff ack <id>")

def approvals_cmd(cmd):
    sub = pos(2) or ""
    if cmd == "approvals":
        if sub == "ls":
            s, d = call("GET", "/api/approvals")
            if s >= 400: die(s, d)
            if not d["approvals"]: print("没有待批准的事项")
            for a in d["approvals"]:
                risk = f" [{a['risk']}]" if a.get("risk") else ""
                print(f"  {vis(a['id'])}{vis(risk)}  {vis(a['summary'])}  可选 {'/'.join(a.get('actions') or [])}")
        elif sub in ("approve", "reject"):
            aid = pos(3)
            if not aid or aid.count(":") < 2:
                sys.exit(f"approvals {sub} <事项id> [--file note.txt] [--client cli] [--device 名] [--version <expected_version>]")
            ver = arg("--version") or aid.split(":", 2)[2]
            src = {"client": arg("--client") or "cli"}
            if arg("--device"): src["device"] = arg("--device")
            body = {"decision": sub, "note": readfile(arg("--file")).strip(), "source": src,
                    "expected_version": int(ver) if ver.isascii() and ver.isdigit() else ver}
            s, d = call("POST", f"/api/approvals/{urllib.parse.quote(aid, safe='')}/decide", body)
            if s == 409 and d.get("current"):
                sys.exit(f"409 {vis(d.get('error'))}\n  当前这一项:{vis(d['current']['id'])}  {vis(d['current']['summary'])}")
            if s >= 400: die(s, d)
            res = d.get("result") or {}
            print(f"{'已批准' if sub == 'approve' else '已拒绝'} {aid}" +
                  (f" → 卡 #{res['task_id']} {LABEL_of(res['status'])}" if res.get("status") else "") +
                  (" → 看板将重启" if res.get("restarting") else ""))
        else:
            sys.exit("approvals ls | approvals approve|reject <事项id>")
    elif cmd == "approval-token":
        if sub == "create":
            label = arg("--label") or readfile(arg("--file")).strip()
            if not label: sys.exit("approval-token create (--label <名称> | --file label.txt) [--save 令牌文件]")
            save = arg("--save")
            if save and os.path.exists(save): sys.exit(f"{save} 已存在,不覆盖")
            s, d = call("POST", "/api/approval-tokens", {"label": label})
            if s >= 400: die(s, d)
            rec = d["record"]
            if save:
                with io.open(save, "x", encoding="utf-8") as f: f.write(d["token"] + chr(10))
                print(f"已生成批准令牌 #{rec['id']}({rec['label']});令牌已写入 {save}")
            else:
                print(f"已生成批准令牌 #{rec['id']}({rec['label']})")
                print(f"令牌(只显示这一次):{d['token']}")
        elif sub == "revoke":
            tid = pos(3)
            if not tid or not tid.isascii() or not tid.isdigit(): sys.exit("approval-token revoke <id>")
            s, d = call("POST", f"/api/approval-tokens/{tid}/revoke", {})
            if s >= 400: die(s, d)
            print(f"已吊销批准令牌 #{tid}")
        elif sub == "ls":
            s, d = call("GET", "/api/approval-tokens")
            if s >= 400: die(s, d)
            r = d.get("remote") or {}
            print("远程入口:" + (f"监听 {', '.join(r.get('listening') or []) or '-'} · 允许 {', '.join(r.get('allow_ips') or [])}"
                                 + (f" · 监听失败 {', '.join(r['errors'])}" if r.get("errors") else "") if r.get("enabled") else "已关闭"))
            if not d["tokens"]: print("没有批准令牌")
            for t in d["tokens"]:
                print(f"  #{t['id']:<4} {t['label']:<16} {'有效' if t['active'] else '已吊销'}  生成 {t['created_at']}  最近使用 {t['last_used_at'] or '-'}")
        else:
            sys.exit("approval-token create|revoke|ls")

_META = None
def meta():
    """GET /api/meta, once per process. The display labels for status / waiting_for have
    ONE copy — core/store.js — and the panel reads the same endpoint. This file used to
    carry its own table (and so did the panel); "grow one side and the other shows the
    raw code" was measured. A board that cannot answer /api/meta cannot answer anything
    else this CLI does either, so there is no offline fallback table to rot."""
    global _META
    if _META is None:
        s, d = call("GET", "/api/meta")
        _META = d if s == 200 and isinstance(d, dict) else {}
    return _META
def LABEL_of(status): return meta().get("status_labels", {}).get(status, status)
def WF_of(wf): return meta().get("wf_labels", {}).get(wf, wf)

def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    cmd = sys.argv[1]
    who = arg("--as")
    fp = arg("--file")
    tid = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].isdigit() else None

    if cmd in ("exec", "lock", "journal", "handoff"):
        coord_cmd(cmd)

    elif cmd in ("approvals", "approval-token"):
        approvals_cmd(cmd)

    elif cmd == "ls":
        qs = []
        for k, f in (("status", "--status"), ("line", "--line"), ("route", "--route")):
            if arg(f): qs.append(f"{k}={arg(f)}")
        qs.append("archived=" + (arg("--archived") or "false"))
        s, d = call("GET", "/api/tasks?" + "&".join(qs))
        if s >= 400: die(s, d)
        print(f"{'ID':<5} {'状态':<10} {'线':<8} {'尝试':<6} 标题")
        for t in d["tasks"]:
            st = LABEL_of(t["status"])
            if t["status"] == "waiting" and t.get("waiting_for"):
                st += "/" + WF_of(t["waiting_for"])
            hold = "" if t.get("released") else " [未放行]"
            att = f"{t['attempts']}/{t['max_attempts']}" if t["attempts"] else "-"
            ln = (t.get('line') or '-') + (f"(<-{t['prev_line']})" if t.get('prev_line') else "")
            print(f"{t['id']:<5} {st:<10} {ln:<8} {att:<6} {t['subject']}{hold}")
        # The default view hides archived cards — the count goes on the face of
        # every listing, so a window can never impersonate the full set.
        print(f"— 共 {len(d['tasks'])} 件 @ {BASE}" +
              (f"(另有已归档 {d['archived_count']} 件,`--archived all` 可见)"
               if d.get("archived_count") and (arg("--archived") or "false") == "false" else ""))

    elif cmd == "show":
        if not tid: sys.exit("show <id>")
        s, d = call("GET", f"/api/tasks/{tid}")
        if s >= 400: die(s, d)
        print(json.dumps(d["task"], ensure_ascii=False, indent=1))

    elif cmd == "create":
        if "--template" in sys.argv:
            if fp: sys.exit("create 的 --template 与 --file 不能同时使用；先编辑模板，再用 --file 建卡")
            # 模板只是现有 API payload 的示例，不新增字段转换或任何执行授权。
            template = os.path.join(os.path.dirname(HERE), "examples", "任务模板.json")
            print(json.dumps(json.loads(readfile(template)), ensure_ascii=False, indent=2))
            return
        if not fp: sys.exit("create 需要 --file payload.json；可用 create --template 查看执行者模板")
        s, d = call("POST", "/api/tasks", json.loads(readfile(fp)))
        if s >= 400: die(s, d)
        print(f"已建 #{d['task']['id']}: {d['task']['subject']}")

    elif cmd == "claim":
        if not who and not arg("--token-file"): sys.exit("claim 需要 --as <线名>")
        s, d = call("POST", "/api/claim", lease_arg(as_worker(
                    {"line": arg("--line", who),
                     "route": arg("--route", os.environ.get("BOARD_DEFAULT_ROUTE", "default")),
                     # Badge self-report: whoever runs this CLI by hand IS the
                     # runtime doing the work. Without stamping it, a card taken
                     # over by the coordinator keeps the previous automated
                     # worker's runtime badge (measured).
                     "runtime": os.environ.get("BOARD_CLI_RUNTIME", "cli")}, who)))
        if s == 204 or not d.get("task"):
            print("没有可认领的卡(路由/放行/依赖/锁 都会挡住,不是错误)"); return
        if s >= 400: die(s, d)
        t = d["task"]
        print(f"已认领 #{t['id']}(第 {t['attempts']}/{t['max_attempts']} 次): {t['subject']}")
        print(f"  证据请写到 loop 指定的 evidence_path;手动交付用"
              f" board.py done {t['id']} --as {who} --run {t['run_id']} --file <证据>")

    elif cmd == "take":
        # Claim a SPECIFIC id. `claim` is pick-a-card, so a coordinator that must
        # run one particular card to completion had no path through this CLI at
        # all (hit twice in practice: could not attach findings to a card, could
        # not close out a series). The server already had /api/tasks/:id/claim;
        # only the CLI mouth was missing. This exists so nobody reaches for raw
        # curl — it does NOT loosen any gate: released/deps/lock/human_gate are
        # all enforced server-side in claimById; this is a pass-through.
        if not tid or not (who or arg("--token-file")): sys.exit("take <id> --as <线名>")
        s, d = call("POST", f"/api/tasks/{tid}/claim", lease_arg(as_worker(
                    {"line": who,
                     "runtime": os.environ.get("BOARD_CLI_RUNTIME", "cli")}, who)))  # badge: same rule as claim
        if s >= 400: die(s, d)
        t = d["task"]
        print(f"已领 #{t['id']}(第 {t['attempts']}/{t['max_attempts']} 次): {t['subject']}")
        print(f"  租约到 {t.get('lease_until')};→ 交付: board.py done {t['id']} --as {t['worker']} --run {t['run_id']} --file <证据>")

    elif cmd in ("done", "wait"):
        run_id = arg("--run")
        if not run_id: sys.exit("交付必须带领取回执的 --run <run_id>，不能自动查找当前执行 ID")
        if not tid or not (who or arg("--token-file")): sys.exit(f"{cmd} <id> --as <线名> --file <证据/原因>")
        ev = readfile(fp)
        if not ev.strip(): sys.exit("必须用 --file 附证据(改了什么/跑了什么/输出是什么)")
        s, d = call("POST", f"/api/tasks/{tid}/report",
                    as_worker({"run_id": run_id, "outcome": cmd, "evidence": ev}, who))
        if s >= 400: die(s, d)
        t = d["task"]
        print(f"#{tid} → {LABEL_of(t['status'])}/{WF_of(t['waiting_for'])}")

    elif cmd in ("approve", "reject"):
        if not tid: sys.exit(f"{cmd} <id> [--file note.md]")
        # `--verify-ok` is the adjudicator's declaration "I ran the registered
        # verify JUST NOW and it came back green". Linked closure (parent /
        # alternates) triggers on this alone — never on a bare approve, because
        # approve by itself only means "nobody objected", the weakest possible
        # evidence (measured). Do not pass it without having run the verify: the
        # moment you do, someone else's card closes on hollow green.
        body = {"verdict": cmd, "note": readfile(fp), "resolved_by": "human"}
        if "--verify-ok" in sys.argv: body["verify_ok"] = True
        s, d = call("POST", f"/api/tasks/{tid}/resolve", body)
        if s >= 400: die(s, d)
        print(f"#{tid} → {LABEL_of(d['task']['status'])}")

    elif cmd == "lines":
        # Worker-loop supervisor (POST /api/workers/<line>/<start|stop>).
        # `start all` / `stop all` walk every supervised line and keep going on
        # failure — an "already running" CONFLICT is a state, not an error.
        sub = sys.argv[2] if len(sys.argv) > 2 else ""
        tgt = sys.argv[3] if len(sys.argv) > 3 else "all"
        if sub == "status":
            s2, d2 = call("GET", "/api/workers", None)
            for w in (d2 if isinstance(d2, list) else d2.get("workers") or []):
                print(f"  {w.get('line'):8s} running={w.get('running')} desired={w.get('desired_running')}")
        elif sub in ("start", "stop"):
            s2, d2 = call("GET", "/api/workers", None)
            rows = d2 if isinstance(d2, list) else d2.get("workers") or []
            names = [w.get("line") for w in rows] if tgt == "all" else [tgt]
            for ln in names:
                st, dd = call("POST", f"/api/workers/{ln}/{sub}", {})
                print(f"  {ln:8s} {sub} -> {st} {json.dumps(dd, ensure_ascii=False)[:90]}")
        elif sub == "add":
            # v0.4: add a line WITHOUT a restart — the server persists it to the
            # config file and rebuilds its registry. The hint travels via --file
            # (CJK on argv is U+FFFD on Windows — the same rule as every other
            # text field here); a missing --file = no hint.
            if tgt == "all": sys.exit("lines add <线名> [--file hint.txt] [--kind implement|review] [--read-only] [--charter docs/roles/x.md]")
            hint = readfile(fp).strip() if fp else ""
            # v0.22: the identity. ASCII-only values, so they may travel on argv; the
            # server validates the domains and the charter file (400 on refusal).
            role = {}
            if arg("--kind"): role["kind"] = arg("--kind")
            if "--read-only" in sys.argv: role["tools"] = "read-only"
            if arg("--charter"): role["charter"] = arg("--charter")
            body = {"id": tgt, "hint": hint}
            if role: body["role"] = role
            st, dd = call("POST", "/api/config/lines", body)
            if st >= 400: die(st, dd)
            rl = dd["line"].get("role") or {}
            print(f"已加线 {dd['line']['id']}" + (f"({dd['line']['hint']})" if dd['line'].get('hint') else "")
                  + (f" 身份={rl.get('kind')}{'·只读' if rl.get('tools') == 'read-only' else ''}"
                     + (f" 章程={rl['charter']}" if rl.get('charter') else "") if rl else "")
                  + f" —— 现有线: {'/'.join(dd['lines'])}(已写入配置,无需重启)")
        else:
            sys.exit("lines status | lines start <线|all> | lines stop <线|all> | "
                     "lines add <线名> [--file hint.txt] [--kind implement|review] [--read-only] [--charter docs/roles/x.md]")

    elif cmd == "requests":
        # v0.5: the coordinator seat's side of the panel's shortcut buttons.
        # `requests` lists the open ones; ack = "I have it"; done = the loop closes
        # (note via --file, CJK rule as everywhere). The panel shows pending-too-long
        # as an alarm — ack promptly, do the work, then done.
        sub = sys.argv[2] if len(sys.argv) > 2 else "list"
        rid = sys.argv[3] if len(sys.argv) > 3 else ""
        if sub == "list":
            s2, d2 = call("GET", "/api/requests?open=1", None)
            rows = d2.get("requests") or []
            if not rows: print("没有待处理的快捷指令")
            for r in rows:
                print(f"  #{r['id']:<4} {r['kind']:<28} {r['status']:<8} {r['created_at']}  params={json.dumps(r.get('params') or {}, ensure_ascii=False)}")
        elif sub in ("ack", "done") and rid:
            body = {"note": readfile(fp)} if (sub == "done" and fp) else {}
            s2, d2 = call("POST", f"/api/requests/{rid}/{sub}", body)
            if s2 >= 400: die(s2, d2)
            print(f"#{rid} → {d2['request']['status']}")
        else:
            sys.exit("requests [list] | requests ack <id> | requests done <id> [--file note.md]")

    elif cmd == "edit":
        # The write-path for card faces. Every time a ruling needed to be carried
        # onto an implementation card, the CLI had no mouth for it (`wait`
        # requires in_progress / `reject` requires a decision-waiting product /
        # the update endpoint existed but was unexposed). Payload = the accepted
        # shape of /api/tasks/:id/update (store.update camelCase keys: subject /
        # description / acceptance / line / route / humanGate / blockedBy ...).
        # CJK must come via --file (argv ANSI-mangles to U+FFFD on Windows).
        if not tid or not fp: sys.exit("edit <id> --file payload.json")
        s, d = call("POST", f"/api/tasks/{tid}/update", json.loads(readfile(fp)))
        if s >= 400: die(s, d)
        print(f"#{tid} 已改(subject: {d['task']['subject'][:40]}…)")
        # The one place a human actually SEES the notice: the panel's edit dialog has no
        # description box, so an in-progress append can only be made from here. A notice
        # with no consumer is a notice nobody reads.
        if d.get("notice"):
            print("注意:" + d["notice"])

    elif cmd == "bless":
        # The acceptance ritual the revision gate's refusal texts point at. One line
        # of git, but a NAMED command: the refusal can now say "run bless" and be
        # telling the truth (a blind install test hit the hash-mismatch refusal and
        # found the command it recommended did not exist — a dead end by our own map).
        import subprocess
        sub = os.environ.get("BOARD_GATED_SUBTREE", "")
        if not sub:
            sys.exit("BOARD_GATED_SUBTREE 未设 —— 先决定闸住哪棵子树(独立部署常用 \".\"=整树),再 bless")
        spec = "" if sub == "." else sub
        repo = os.path.dirname(HERE)
        def git(*a):
            return subprocess.run(["git", "--no-lazy-fetch", *a], capture_output=True, text=True,
                                  encoding="utf-8", errors="replace", cwd=repo)
        r = git("rev-parse", f"HEAD:{spec}")
        if r.returncode != 0:
            sys.exit("git rev-parse 失败:" + (r.stderr or r.stdout).strip())
        tree = r.stdout.strip()
        # ⭐ Say what is being accepted BEFORE writing it (v0.15.1). The act is a human
        #   confirmation either way — this command, or the panel's 「接受当前代码」 button (v0.18),
        #   which shows the same preview and carries the tree the human SAW (confirm_tree), so
        #   the server refuses if the disk moved in between. "What am I accepting" used to be
        #   a bare hash. accepted_rev is a TREE object, so the previous one and
        #   this one can be diffed directly (`git diff --stat <tree> <tree>`), and a dirty
        #   working tree is worth a warning: bless anchors HEAD, and the gate refuses to
        #   start a line from a dirty tree, so the next thing the person sees would be a
        #   refusal they did not expect.
        rev_file = os.path.join(DATA, "accepted_rev")
        prev = None
        try: prev = io.open(rev_file, encoding="utf-8").read().strip() or None
        except Exception: prev = None
        print(f"子树 {sub}:HEAD 的树 = {tree}")
        if prev and prev == tree:
            print(f"  与上次接受的一致({prev[:12]}…)—— 重新 bless 不改变任何东西")
        elif prev:
            d = git("diff", "--stat", prev, tree)
            stat = [ln for ln in (d.stdout or "").rstrip().splitlines() if ln.strip()]
            print(f"  上次接受的树 = {prev}")
            print("  你正在接受的变化(上次接受的树 → 这次):")
            for ln in (stat or [f"(git diff --stat 无输出:{(d.stderr or '').strip()})"]):
                print("    " + ln)
        else:
            print("  首次接受(之前没有 accepted_rev)")
        dirty = git("status", "--short", "--", "." if sub == "." else sub)
        n_dirty = len([ln for ln in (dirty.stdout or "").splitlines() if ln.strip()])
        if n_dirty:
            print(f"  ⚠ 工作树里有 {n_dirty} 处未提交改动 —— bless 锚的是 HEAD 的树,不是工作树;"
                  f"线启动时闸会因脏树拒绝。先 commit,再起线")
        os.makedirs(DATA, exist_ok=True)
        io.open(rev_file, "w", encoding="utf-8").write(tree + chr(10))
        print(f"已 bless:{sub} = {tree}")
        print(f"  写入 {os.path.join(DATA, 'accepted_rev')} —— 在跑的旧进程不会热换代码,重启后生效")

    elif cmd in ("release", "hold"):
        if not tid: sys.exit(f"{cmd} <id>")
        s, d = call("POST", f"/api/tasks/{tid}/release", {"released": cmd == "release"})
        if s >= 400: die(s, d)
        print(f"#{tid} {'已放行(worker 可见)' if cmd == 'release' else '已收进协调待机区'}")

    elif cmd == "reopen":
        if not tid: sys.exit("reopen <id> [--line 线名]")
        s, d = call("POST", f"/api/tasks/{tid}/reopen", {"line": arg("--line")})
        if s >= 400: die(s, d)
        t = d["task"]
        print(f"#{tid} → {LABEL_of(t['status'])}(线={t.get('line') or '-'})"
              + ("" if d.get("changed") else " ※本来就在未开始,没动"))

    elif cmd == "archive":
        if not tid: sys.exit("archive <id>")
        s, d = call("POST", f"/api/tasks/{tid}/archive", {
            "restore": "--restore" in sys.argv,
            "force": "--force" in sys.argv,
        })
        if s >= 400: die(s, d)
        print(f"#{tid} {'已恢复' if '--restore' in sys.argv else '已归档'}")

    else:
        sys.exit(__doc__)

main()
