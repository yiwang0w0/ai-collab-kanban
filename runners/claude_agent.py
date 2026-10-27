#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Claude Agent SDK 单任务入口：UTF-8 文件输入、受限工具、绑定身份的 NDJSON 输出。"""
import argparse
import asyncio
import json
import os
import sys

from agent_contract import event, is_number, provider_environment, read_job, tool_allowed, validate_job


def usage_of(value):
    if not isinstance(value, dict):
        return None
    keys = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
    return {key: value[key] if isinstance(value.get(key), int) and not isinstance(value[key], bool)
            and value[key] >= 0 else None for key in keys}


async def run_job(job, emit, *, sdk=None, environment=None):
    validate_job(job)
    if job["channel"] != "claude_agent_sdk":
        raise ValueError("SDK_CHANNEL_INVALID")
    environment = provider_environment(os.environ if environment is None else environment, job["channel"])
    if not environment.get("ANTHROPIC_API_KEY") or not environment.get("CLAUDE_CONFIG_DIR"):
        raise ValueError("SDK_CREDENTIAL_REQUIRED")
    if sdk is None:
        import claude_agent_sdk as sdk
    denied = []

    async def permission(name, inputs, context):
        if tool_allowed(job, name, inputs):
            return sdk.PermissionResultAllow(updated_input=inputs)
        denied.append(name)
        return sdk.PermissionResultDeny(message="仅允许选定工作仓中的文件操作；新增权限需操作者确认。", interrupt=True)

    async def pre_tool_use(inputs, tool_use_id, context):
        if tool_allowed(job, inputs.get("tool_name"), inputs.get("tool_input", {})):
            return {}
        denied.append(str(inputs.get("tool_name", "unknown")))
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                "permissionDecisionReason": "文件越界、凭据文件或未获准工具；需操作者确认。"}}

    tools = ["Read", "Glob", "Grep"] + ([] if job["read_only"] else ["Write", "Edit"])
    options = sdk.ClaudeAgentOptions(cwd=job["cwd"], model=job["model"], effort=job["effort"],
        permission_mode="dontAsk", tools=tools, allowed_tools=tools, can_use_tool=permission,
        hooks={"PreToolUse": [sdk.HookMatcher(hooks=[pre_tool_use])]}, setting_sources=[], plugins=[],
        strict_mcp_config=True, mcp_servers={}, skills=[], max_turns=int(job["budget"]["max_turns"]),
        max_budget_usd=float(job["budget"]["max_cost_usd"]), env=environment,
        stderr=lambda _line: None,
        system_prompt="你是 Kanban 单任务开发执行器。只处理当前卡；先读取工作仓内的 AGENTS.md/CLAUDE.md（如有）。"
                      "不得读取凭据、请求新增权限、执行 shell、派生智能体或自行验收。正式验证由宿主在你退出后执行。"
                      "最后用中文回报实际修改、产物位置与尚未执行的检查，不能冒充测试已经通过。")
    emit(event(job, "started", budget_enforcement="sdk_budget_and_turns"))
    terminal = None
    try:
        async for message in sdk.query(prompt=job["prompt"], options=options):
            if isinstance(message, sdk.AssistantMessage):
                emit(event(job, "activity", session_id=getattr(message, "session_id", None),
                           request_id=getattr(message, "uuid", None)))
            if isinstance(message, sdk.ResultMessage):
                if terminal is not None:
                    raise ValueError("SDK_DUPLICATE_TERMINAL")
                report = getattr(message, "result", None)
                success = message.subtype == "success" and message.is_error is False and isinstance(report, str) and bool(report.strip())
                if denied or getattr(message, "permission_denials", None):
                    success = False
                raw_cost = getattr(message, "total_cost_usd", None)
                cost = raw_cost if is_number(raw_cost) and raw_cost >= 0 else None
                terminal = {"status": "success" if success else "failed", "report": report if success else None,
                            "diagnostic": "SUCCESS" if success else "PERMISSION_REQUIRED" if denied else "SDK_RESULT_FAILED",
                            "session_id": getattr(message, "session_id", None), "request_id": getattr(message, "uuid", None),
                            "usage": usage_of(getattr(message, "usage", None)), "cost_usd": cost,
                            "budget_enforcement": "sdk_budget_and_turns"}
        if terminal is None:
            raise ValueError("SDK_TERMINAL_MISSING")
    except asyncio.CancelledError:
        raise
    except Exception:
        terminal = {"status": "failed", "diagnostic": "SDK_PROTOCOL_OR_PROVIDER_ERROR", "report": None, "usage": None, "cost_usd": None}
    emit(event(job, "terminal", **terminal))
    return terminal["status"] == "success"


async def main(path):
    job = read_job(path)
    # SDK 会合并父进程环境；入口本身也须清除其他供应商及看板凭据。
    environment = provider_environment(os.environ, job["channel"])
    os.environ.clear()
    os.environ.update(environment)
    emit = lambda item: print(json.dumps(item, ensure_ascii=False, allow_nan=False), flush=True)
    try:
        async with asyncio.timeout(float(job["budget"]["timeout_sec"])):
            return 0 if await run_job(job, emit) else 1
    except TimeoutError:
        emit(event(job, "terminal", status="timeout", diagnostic="SDK_TIMEOUT", report=None, usage=None, cost_usd=None))
        return 1
    except asyncio.CancelledError:
        emit(event(job, "terminal", status="cancelled", diagnostic="SDK_CANCELLED", report=None, usage=None, cost_usd=None))
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", required=True)
    args = parser.parse_args()
    try:
        sys.exit(asyncio.run(main(args.job)))
    except Exception:
        print("SDK 入口拒绝：输入、凭据或运行时尚未就绪。", file=sys.stderr)
        sys.exit(2)
