#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""协调线的一轮 Codex CLI 参数模板；只构造请求，不调度或调用模型。"""
import io
import json
import uuid

import codex_runtime


def argv(cli, model, effort, last_path, workdir, schema, *, thread_id=None):
    """首次与续接使用同一组顶层只读配置；消息由调用方通过 UTF-8 stdin 传入。

    此函数只供离线构造，实际起进程须用 prepare() 先只读核对登录方式。
    Codex CLI 0.149.1 的 exec resume 没有 --sandbox 或 -C，故把只读、审批和工作目录
    放在 exec 前的顶层配置中。不加 --ephemeral，续接只接明确 thread_id，不使用 --last。
    0.149 系列实测：exec／exec resume 后出现任何子命令级 -c，会使前面的顶层 -c
    全部失效，包括只读与认证约束。因此此模板禁止在 exec 之后添加 -c。
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
        "-c", 'windows.sandbox="unelevated"',
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


def environment(env):
    """显式接收经 profileEnvironment 处理的环境，再复用 CLI 订阅环境过滤。"""
    return codex_runtime.subscription_environment(env)


def prepare(cli, model, effort, last_path, workdir, schema, *, env, thread_id=None):
    """实际调用的准备入口：不符 ChatGPT 登录时拒绝，不执行会删除 API 登录的生成命令。"""
    child = environment(env)
    error = codex_runtime.subscription_login_gate(cli, child, workdir=workdir)
    if error:
        raise RuntimeError(error)
    return argv(cli, model, effort, last_path, workdir, schema, thread_id=thread_id), child


def read_prompt(path):
    """正文从 UTF-8 文件读入，避免 Windows argv 的中文、引号和长度问题。"""
    with io.open(path, encoding="utf-8") as source:
        return source.read()
