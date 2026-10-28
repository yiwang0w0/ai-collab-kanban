#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""协调线的一轮 Codex CLI 参数模板；只构造请求，不调度或调用模型。"""
import io
import json
import os
import uuid

import codex_runtime


def argv(cli, model, effort, last_path, workdir, schema, *, thread_id=None):
    """首次与续接使用同一组顶层只读配置；消息由调用方通过 UTF-8 stdin 传入。

    Codex CLI 0.149.1 的 exec resume 没有 --sandbox 或 -C，故把只读、审批和工作目录
    放在 exec 前的顶层配置中。不加 --ephemeral，续接只接明确 thread_id，不使用 --last。
    """
    if not schema:
        raise ValueError("协调线需要明确的结构化输出 schema 文件")
    if thread_id is not None:
        try:
            thread_id = str(uuid.UUID(str(thread_id)))
        except (ValueError, AttributeError) as error:
            raise ValueError("协调线续接需要明确的 thread_id UUID") from error
    out = [
        cli,
        "-c", 'sandbox_mode="read-only"',
        "-c", 'approval_policy="never"',
        "-c", 'forced_login_method="chatgpt"',
        "-c", "model_reasoning_effort=" + json.dumps(str(effort)),
        "-c", "shell_environment_policy.inherit=core",
        "-c", "shell_environment_policy.ignore_default_excludes=false",
        "-c", "tools.web_search=false",
        "-C", workdir,
        "exec",
    ]
    if thread_id:
        out += ["resume", thread_id]
    out += [
        "-m", str(model),
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--json", "--output-schema", schema,
        "-o", last_path, "-",
    ]
    codex_runtime.assert_no_bypass(out)
    return out


def environment(env=None):
    """复用 CLI 订阅环境隔离；调用前仍由宿主剔除所有已登记的配置凭据。"""
    return codex_runtime.subscription_environment(os.environ if env is None else env)


def read_prompt(path):
    """正文从 UTF-8 文件读入，避免 Windows argv 的中文、引号和长度问题。"""
    with io.open(path, encoding="utf-8") as source:
        return source.read()
