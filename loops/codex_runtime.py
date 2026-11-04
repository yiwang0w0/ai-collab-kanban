#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Codex CLI 共用契约(第二个运行时座席的参考实现)。

worker(以及将来的 reviewer/reorg)都从这里组装 argv、判断 JSONL 终态并记 usage。
提示词始终走 stdin;本模块绝不接收或读取仓库里的凭据文件。
"""
import datetime
import io
import json
import os
import re
import subprocess
import threading
import uuid


CODEX_BYPASS = (
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "danger-full-access",
    "--ignore-rules",
    "--yolo",
)
_USAGE_LOCK = threading.Lock()


def gate(path):
    """要求宿主提供真实存在的原生绝对 .exe;返回 None 表示通过。"""
    path = str(path or "")
    if not path:
        return ("[codex] ⛔ BOARD_CODEX_CMD 未设置 —— codex 槽不启动。\n"
                "  运行时宿主必须提供固定版本的原生 codex 可执行文件绝对路径。")
    if not os.path.isabs(path):
        return f"[codex] ⛔ BOARD_CODEX_CMD 不是绝对路径: {path}"
    if not os.path.isfile(path):
        return f"[codex] ⛔ BOARD_CODEX_CMD 指向的文件不存在: {path}"
    ext = os.path.splitext(path)[1].lower()
    if ext in (".cmd", ".bat"):
        return (f"[codex] ⛔ BOARD_CODEX_CMD 指向 .cmd/.bat: {path}\n"
                "  为避免 BatBadBut(CVE-2024-24576),必须直接指定原生可执行文件。")
    if os.name == "nt" and ext != ".exe":
        return (f"[codex] ⛔ BOARD_CODEX_CMD 不是原生 .exe: {path}\n"
                "  .cmd/.bat/.ps1 包装器一律拒绝。请直接指定 npm 包内的原生 codex.exe。")
    return None


def assert_no_bypass(argv):
    """危险旗的结构守卫;提示词不在 argv 中,所以不会误伤卡面正文。"""
    hit = [a for a in argv if any(b in str(a) for b in CODEX_BYPASS)]
    if hit:
        raise RuntimeError(f"bypass 旗被组装进 argv(实现 bug): {hit}")


def subscription_environment(env):
    """复用验证环境过滤；仅恢复所选 Codex 认证目录，不把循环令牌交给 CLI。

    调用方先用 profileEnvironment 剔除全部配置登记的凭据。本函数再沿用
    verify_environment 的供应商过滤，保留 CODEX_HOME 供 CLI 自己认证；这不构成路径隔离。
    """
    from verify_lib import verify_environment
    clean = verify_environment(env)
    for key in list(clean):
        if re.match(r"^(?:BOARD_|WORKER_|REVIEWER_)", key, re.I) and re.search(
                r"(?:TOKEN|API_KEY|SECRET_KEY|PASSWORD)$", key, re.I):
            clean.pop(key)
    home = next((value for key, value in env.items() if key.upper() == "CODEX_HOME"), None)
    if home:
        clean["CODEX_HOME"] = home
    return clean


def subscription_login_gate(cli, env, *, workdir=None, _run=None):
    """先只读查询登录方式；不能用 forced_login_method 查询，以免 CLI 注销 API 登录。

    原始状态输出可能含密钥提示，不向日志或返回值转述。只接受已确认的 ChatGPT 登录；
    不登录、不退出、不重试，也不读取认证文件。实际生成命令仍保留强制 ChatGPT 的约束。
    """
    invalid = gate(cli)
    if invalid:
        return invalid
    try:
        result = (_run or subprocess.run)(
            [cli, "login", "status"], capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=15, env=subscription_environment(env), cwd=workdir,
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
    except (OSError, subprocess.SubprocessError):
        return "Codex 登录状态无法只读核实，未启动生成进程；未执行登录或退出操作。"
    status = (result.stdout or "") + "\n" + (result.stderr or "")
    if result.returncode == 0 and re.search(r"logged in using chatgpt", status, re.I):
        return None
    return "Codex CLI 需要已有的 ChatGPT 订阅登录；当前认证方式不符或未知，未启动生成进程，也未注销原登录。请由操作者核对所选 CODEX_HOME。"


def argv(cli, model, effort, last_path, workdir, *, mode="write", schema=None):
    """组装 codex exec argv。

    mode=write: --approve-for-me 自带 workspace-write,不能再写 --sandbox。
    mode=read-only: 显式 read-only,不带 --approve-for-me。
    两种模式都不继承任意环境;仅保留 core,并启用默认密钥名排除。
    """
    if mode not in ("write", "read-only"):
        raise ValueError(f"未知 Codex mode: {mode}")
    out = [
        cli, "exec",
        "-m", str(model),
        "-c", f"model_reasoning_effort={effort}",
        "-c", "shell_environment_policy.inherit=core",
        "-c", "shell_environment_policy.ignore_default_excludes=false",
        "-c", 'forced_login_method="chatgpt"',
        "-c", 'windows.sandbox="unelevated"',
        "-c", "tools.web_search=false",
        "--ignore-user-config",
        "--ephemeral",
        "--json",
        "-o", last_path,
    ]
    if schema:
        out += ["--output-schema", schema]
    out += (["--approve-for-me"] if mode == "write" else ["--sandbox", "read-only"])
    out += ["-C", workdir, "--skip-git-repo-check", "-"]
    assert_no_bypass(out)
    return out


def session_argv(cli, model, effort, last_path, workdir, *, mode="write", schema=None, thread_id=None):
    """可续接的明确会话形；首轮与续轮的权限、认证、配置层级完全相同。"""
    if mode not in ("write", "read-only"):
        raise ValueError("未知 Codex mode")
    if thread_id is not None:
        thread_id = str(uuid.UUID(str(thread_id)))
    out = [cli, "-c", 'sandbox_mode="workspace-write"' if mode == "write" else 'sandbox_mode="read-only"',
           "-c", 'approval_policy="on-request"' if mode == "write" else 'approval_policy="never"']
    if mode == "write":
        # 对应既有 --approve-for-me 的自动审查；续接不改为 never，也不绕过沙箱。
        out += ["-c", 'approvals_reviewer="auto_review"']
    out += ["-c", 'windows.sandbox="unelevated"', "-c", 'forced_login_method="chatgpt"',
            "-c", "model_reasoning_effort=" + json.dumps(str(effort)),
            "-c", "shell_environment_policy.inherit=core",
            "-c", "shell_environment_policy.ignore_default_excludes=false",
            "-c", "tools.web_search=false", "-C", workdir, "exec"]
    if thread_id:
        out += ["resume", thread_id]
    out += ["-m", str(model), "--ignore-user-config", "--skip-git-repo-check", "--json"]
    if schema:
        out += ["--output-schema", schema]
    out += ["-o", last_path, "-"]
    assert_no_bypass(out)
    return out


def judge(rc, stdout, last_path):
    """成功需同时满足 rc=0、turn.completed、-o 最终消息非空。"""
    done, failed_msg, thread, usage = False, None, None, None
    errs = []
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        ty = d.get("type")
        if ty == "thread.started":
            thread = d.get("thread_id")
        elif ty == "turn.completed":
            done, usage = True, d.get("usage") or {}
        elif ty == "turn.failed":
            failed_msg = ((d.get("error") or {}).get("message") or "")[:600]
        elif ty == "error":
            errs.append(str(d.get("message") or "")[:600])
    last = ""
    try:
        if os.path.isfile(last_path):
            last = io.open(last_path, encoding="utf-8", errors="replace").read().strip()
    except Exception as e:
        errs.append(f"最终消息读取失败: {e}")
    ok = rc == 0 and done and bool(last)
    why = []
    if rc != 0:
        why.append(f"退出码 {rc}")
    if not done:
        why.append("没有 turn.completed 事件")
    if not last:
        why.append("最终消息为空")
    tail = ("codex 判定: " + ("OK" if ok else "NG(" + " / ".join(why) + ")")
            + ("\nturn.failed: " + failed_msg if failed_msg else "")
            + ("\nerror: " + " | ".join(errs[-3:]) if errs else "")
            + ("\n最终消息尾: " + last[-400:] if last else ""))
    u = usage or {}
    mapped = ({"calls": 1, "in": u.get("input_tokens"),
               "cc": u.get("cache_write_input_tokens"),
               "cr": u.get("cached_input_tokens"),
               "out": u.get("output_tokens"), "note": None}
              if usage is not None else None)
    return {"ok": ok, "tail": tail, "thread": thread, "usage": mapped, "last": last}


def append_usage(data_dir, who, model, effort, verdict, *, card=None, attempt=None, note=None, log=print):
    """把 Codex JSONL usage 写入共享 usage_ledger;拿不到用量也显式写一行说明。"""
    usage = dict(verdict.get("usage") or
                 {"calls": None, "in": None, "cc": None, "cr": None, "out": None,
                  "note": note or "未见 turn.completed usage"})
    if note:
        usage["note"] = note
    row = {
        "ts": datetime.datetime.now().isoformat(timespec="seconds"),
        "card": card,
        "attempt": attempt,
        "worker": who,
        "model": model,
        "effort": effort,
        "sid": str(verdict.get("thread") or "")[:8],
        **usage,
    }
    try:
        os.makedirs(data_dir, exist_ok=True)
        with _USAGE_LOCK:
            io.open(os.path.join(data_dir, "usage_ledger.jsonl"), "a", encoding="utf-8").write(
                json.dumps(row, ensure_ascii=False) + "\n")
    except Exception as e:
        log(f"  Codex 用量记账失败({e})—— 不阻塞本轮")
    return row
