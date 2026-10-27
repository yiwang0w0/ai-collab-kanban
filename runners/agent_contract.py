"""单任务 SDK 输入与事件合同；不读取看板凭据，也不启动模型。"""
import json
import math
import os
import pathlib
import re
import subprocess
import uuid

FORMAT = "kanban-agent-job/v1"
EVENT_FORMAT = "kanban-agent-event/v1"
CHANNELS = {"claude_agent_sdk": "claude", "codex_sdk_api": "codex"}
PRIVATE_NAMES = {"board_token", "worker_token", "review_token", "panel_sessions.json", "auth.json",
                 "fleet.config.json", "verify_registry.json", "credentials.json", "auth", "agent_jobs"}


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def workspace_identity(path, node_path=None):
    """与宿主共用 Node directoryIdentity，避免 Windows 的跨运行时 inode 差异。"""
    node = node_path or os.environ.get("WORKER_NODE")
    if not isinstance(node, str) or not pathlib.Path(node).is_absolute():
        raise ValueError("SDK_IDENTITY_RUNTIME_REQUIRED")
    environment = {key: value for key, value in os.environ.items() if key.lower() in ("systemroot", "windir", "temp", "tmp")}
    result = subprocess.run([node, str(pathlib.Path(__file__).with_name("workspace_tools.mjs")), "--identity", str(path)],
                            capture_output=True, text=True, encoding="utf-8", errors="strict", timeout=5, check=True, env=environment)
    if len(result.stdout) > 32768:
        raise ValueError("SDK_WORKSPACE_IDENTITY_INVALID")
    identity = json.loads(result.stdout)
    if not isinstance(identity, dict) or not pathlib.Path(identity.get("root", "")).is_absolute() or any(not isinstance(identity.get(key), str) or not identity[key].isdigit() for key in ("device", "inode")):
        raise ValueError("SDK_WORKSPACE_IDENTITY_INVALID")
    return identity


def validate_job(job):
    if not isinstance(job, dict) or job.get("format") != FORMAT:
        raise ValueError("SDK_JOB_INVALID")
    if not isinstance(job.get("task_id"), int) or isinstance(job["task_id"], bool) or job["task_id"] <= 0:
        raise ValueError("SDK_TASK_INVALID")
    for name in ("run_id", "agent_instance_id"):
        if str(uuid.UUID(str(job.get(name)))) != job[name]:
            raise ValueError("SDK_IDENTITY_INVALID")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", str(job.get("execution_profile_id", ""))):
        raise ValueError("SDK_PROFILE_INVALID")
    if not re.fullmatch(r"[a-f0-9]{64}", str(job.get("profile_digest", ""))):
        raise ValueError("SDK_PROFILE_INVALID")
    if CHANNELS.get(job.get("channel")) != job.get("runtime"):
        raise ValueError("SDK_CHANNEL_INVALID")
    if not isinstance(job.get("model"), str) or not job["model"].strip() or len(job["model"]) > 160:
        raise ValueError("SDK_MODEL_INVALID")
    if job.get("effort") not in ("minimal", "low", "medium", "high", "xhigh", "max"):
        raise ValueError("SDK_EFFORT_INVALID")
    budget = job.get("budget")
    if not isinstance(budget, dict) or any(not is_number(budget.get(key)) or budget[key] <= 0
                                           for key in ("timeout_sec", "max_turns", "max_cost_usd")):
        raise ValueError("SDK_BUDGET_REQUIRED")
    if int(budget["max_turns"]) != budget["max_turns"]:
        raise ValueError("SDK_BUDGET_INVALID")
    cwd = pathlib.Path(job.get("cwd", "")).resolve(strict=True)
    if not cwd.is_dir() or not pathlib.Path(job["cwd"]).is_absolute():
        raise ValueError("SDK_WORKSPACE_INVALID")
    if not isinstance(job.get("read_only"), bool):
        raise ValueError("SDK_PERMISSION_INVALID")
    workspace = job.get("workspace")
    identity = workspace_identity(cwd, job.get("node_path"))
    if not isinstance(workspace, dict) or os.path.normcase(os.path.realpath(workspace.get("path", ""))) != os.path.normcase(identity["root"]) or any(workspace.get(key) != identity[key] for key in ("device", "inode")):
        raise ValueError("SDK_WORKSPACE_IDENTITY_CHANGED")
    if job.get("tools") != ("read-only" if job["read_only"] else "write"):
        raise ValueError("SDK_PERMISSION_INVALID")
    protected_paths(job)
    return job


def protected_paths(job):
    paths = job.get("protected_paths")
    if not isinstance(paths, list) or not 0 < len(paths) <= 512 or any(not isinstance(path, str) or "\0" in path or not pathlib.Path(path).is_absolute() for path in paths):
        raise ValueError("SDK_PROTECTION_REQUIRED")
    return [os.path.normcase(os.path.realpath(path)) for path in paths]


def protected_path(job, path, *, parents=False):
    candidate = os.path.normcase(os.path.realpath(path))
    for root in protected_paths(job):
        try:
            common = os.path.commonpath((candidate, root))
            if common == root or parents and common == candidate:
                return True
        except ValueError:
            continue
    return False


def read_job(path):
    source = pathlib.Path(path).resolve(strict=True)
    if source.stat().st_size > 1024 * 1024:
        raise ValueError("SDK_JOB_TOO_LARGE")
    job = validate_job(json.loads(source.read_text(encoding="utf-8")))
    prompt_file = pathlib.Path(job["prompt_file"])
    if prompt_file.is_symlink() or prompt_file.resolve(strict=True).parent != source.parent:
        raise ValueError("SDK_PROMPT_PATH_INVALID")
    if prompt_file.stat().st_size > 256 * 1024:
        raise ValueError("SDK_PROMPT_TOO_LARGE")
    job["prompt"] = prompt_file.read_text(encoding="utf-8")
    if not job["prompt"].strip():
        raise ValueError("SDK_PROMPT_EMPTY")
    return job


def event(job, kind, **fields):
    return {"format": EVENT_FORMAT, "task_id": job["task_id"], "run_id": job["run_id"],
            "agent_instance_id": job["agent_instance_id"], "execution_profile_id": job["execution_profile_id"],
            "profile_digest": job["profile_digest"], "model": job["model"], "effort": job["effort"],
            "event_id": str(uuid.uuid4()), "kind": kind, **fields}


def private_name(name):
    lower = name.lower()
    return lower in PRIVATE_NAMES or lower.startswith(".env") or lower.endswith((".key", ".pem", "_token"))


def workspace_path(cwd, raw):
    root = pathlib.Path(cwd).resolve(strict=True)
    value = pathlib.Path(raw) if raw else root
    candidate = value if value.is_absolute() else root / value
    relative = candidate.relative_to(root)
    current = root
    for part in relative.parts:
        if part in (".", "..") or re.search(r'[:*?"<>|\x00-\x1f]', part) or part.endswith((".", " ")):
            raise ValueError("SDK_UNSAFE_PATH_DENIED")
        if part.lower() in (".git", ".claude", ".codex") or private_name(part):
            raise ValueError("SDK_PRIVATE_PATH_DENIED")
        current = current / part
        if current.is_symlink() or getattr(current, "is_junction", lambda: False)():
            raise ValueError("SDK_LINK_PATH_DENIED")
    candidate.resolve().relative_to(root)
    return candidate


def tool_allowed(job, name, inputs):
    if name not in ("Read", "Glob", "Grep", "Write", "Edit") or not isinstance(inputs, dict):
        return False
    if job["read_only"] and name in ("Write", "Edit"):
        return False
    try:
        raw = inputs.get("file_path") if name in ("Read", "Write", "Edit") else inputs.get("path")
        if name in ("Read", "Write", "Edit") and (not isinstance(raw, str) or not raw):
            return False
        path = workspace_path(job["cwd"], raw)
        if protected_path(job, path):
            return False
        # 内容检索必须指向具体文件，避免一次目录搜索读取隐藏凭据。
        if name == "Grep" and not path.is_file():
            return False
        if name == "Glob":
            pattern = str(inputs.get("pattern", ""))
            parts = re.split(r"[\\/]", pattern)
            if pathlib.Path(pattern).is_absolute() or re.match(r"^[A-Za-z]:", pattern) or ".." in parts:
                return False
            if any(private_name(part) or part.lower() in (".git", ".claude", ".codex") for part in parts):
                return False
            # 原生 Glob 不能过滤回传项；若搜索范围可能进入控制路径，保守拒绝。
            literal = []
            for part in parts:
                if re.search(r"[*?\[{}]", part):
                    break
                literal.append(part)
            scope = path.joinpath(*literal)
            if protected_path(job, scope, parents=True):
                return False
        return True
    except (ValueError, OSError, TypeError):
        return False


def provider_environment(environment, channel):
    # 仅透传宿主运行所需环境；工作循环与其他供应商的凭据不进入 SDK。
    allowed = {"path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "userprofile",
               "appdata", "localappdata", "home", "lang", "lc_all", "pythonioencoding", "pythonutf8",
               "https_proxy", "http_proxy", "no_proxy", "ssl_cert_file", "node_extra_ca_certs"}
    result = {key: value for key, value in environment.items() if key.lower() in allowed}
    if channel == "claude_agent_sdk":
        result["ANTHROPIC_API_KEY"] = environment.get("ANTHROPIC_API_KEY", "")
        result["CLAUDE_CONFIG_DIR"] = environment.get("CLAUDE_CONFIG_DIR", "")
        result["CLAUDE_AGENT_SDK_CLIENT_APP"] = "kanban-workbench"
    else:
        result["CODEX_API_KEY"] = environment.get("OPENAI_API_KEY") or environment.get("CODEX_API_KEY", "")
        result["CODEX_HOME"] = environment.get("CODEX_HOME", "")
    return result
