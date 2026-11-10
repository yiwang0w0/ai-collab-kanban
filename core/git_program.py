# -*- coding: utf-8 -*-
"""git_program —— 宿主一侧所有 Python 进程启动 Git 时共用的程序解析(Node 一侧是 core/git-program.mjs,同一套规则)。

为什么不按名字启动:`subprocess.run(["git", ...])` 交给 CreateProcess 去找,Windows 会先看
**进程的当前目录**。循环的当前目录是 <看板仓>/core;看板仓就是工作仓、或落在工作仓之内时,
那个目录在模型的写放行范围里 —— 放一个 git.exe 进去就会被宿主执行。shutil.which 同样先搜
当前目录,而且认 .cmd/.bat。

规则(每个进程解析一次,之后用同一个绝对路径):
  1. 宿主配置优先:环境变量 WORKER_HOST_GIT,或 fleet.config.json 的 host_git,必须是绝对路径。
  2. 否则只在 PATH 的**绝对目录**里找;空条目与相对条目都指当前目录,一律不搜。
  3. 结果是 .bat/.cmd(参数会经 cmd.exe 再解释一遍),或落在工作仓、数据目录之内,拒绝。
  4. 子进程带 NoDefaultCurrentDirectoryInExePath=1:Git 自己再起子进程时也不先搜当前目录。
解析不出来就抛 GitProgramError;各调用方按「测不了」落到拒绝一侧,不退回按名字启动。"""
import os

import board_env

CODE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class GitProgramError(RuntimeError):
    pass


def is_batch(path):
    """.bat/.cmd 经 cmd.exe 启动,参数会被当作命令行解释;判据与 worker 的 cli_is_batch 相同。"""
    return os.path.splitext(str(path or ""))[1].lower() in (".bat", ".cmd")


def within(path, root):
    """path 是否落在 root 之内;字面路径与解析后的实际路径各比一次。"""
    for inner in {os.path.abspath(path), os.path.realpath(path)}:
        for outer in {os.path.abspath(root), os.path.realpath(root)}:
            try:
                if os.path.commonpath([os.path.normcase(outer), os.path.normcase(inner)]) == os.path.normcase(outer):
                    return True
            except ValueError:
                pass
    return False


def search_path(name, environ):
    """只在 PATH 的绝对目录里找;不用 shutil.which(它在 Windows 上把当前目录排在 PATH 之前)。"""
    names = [name]
    if os.name == "nt":
        names = [name + ext for ext in (environ.get("PATHEXT") or ".COM;.EXE;.BAT;.CMD").split(os.pathsep) if ext]
    for folder in (environ.get("PATH") or "").split(os.pathsep):
        folder = folder.strip().strip('"')
        if not os.path.isabs(folder) or (os.name == "nt" and not os.path.splitdrive(folder)[0]):
            continue
        for candidate in names:
            target = os.path.join(folder, candidate)
            if os.path.isfile(target) and (os.name == "nt" or os.access(target, os.X_OK)):
                return target
    return None


def check(program, roots, batch=is_batch):
    """批处理包装器、落在工作仓或数据目录内的程序都不执行。"""
    if batch(program):
        raise GitProgramError("Git 程序是 .bat/.cmd 包装器，参数会经 cmd.exe 解释；请把 WORKER_HOST_GIT(或 fleet.config 的 host_git)"
                              "设为 git 可执行文件的绝对路径：" + str(program))
    for root in roots:
        if root and within(program, root):
            raise GitProgramError("Git 程序位于工作仓或数据目录内，模型可以改写它；请改用其外的 Git：" + str(program))


def resolve(roots=(), configured=None, environ=None, batch=is_batch):
    """解析出 Git 程序的绝对路径。configured 是宿主配置的绝对路径;未配置时只搜 PATH 的绝对目录。"""
    environ = os.environ if environ is None else environ
    if configured:
        if not os.path.isabs(configured):
            raise GitProgramError("配置的 Git 程序必须是绝对路径：" + str(configured))
        found = configured
    else:
        found = search_path("git", environ)
        if not found:
            raise GitProgramError("PATH 的绝对目录里找不到 Git 程序；请安装 Git，或把 WORKER_HOST_GIT(或 fleet.config 的 host_git)"
                                  "设为 git 可执行文件的绝对路径")
    check(found, roots, batch)
    program = os.path.realpath(found)
    if os.name == "nt" and os.path.basename(os.path.dirname(program)).lower() == "cmd":
        # Git for Windows:PATH 上通常是 cmd\git.exe,固定同一安装里的 bin\git.exe。
        sibling = os.path.join(os.path.dirname(os.path.dirname(program)), "bin", "git.exe")
        if os.path.isfile(sibling):
            program = os.path.realpath(sibling)
    check(program, roots, batch)
    if not os.path.isfile(program):
        raise GitProgramError("Git 实际程序不可用：" + program)
    return program


def environment(environ=None):
    """给 Git 子进程用的环境副本:带 NoDefaultCurrentDirectoryInExePath=1。"""
    result = dict(os.environ if environ is None else environ)
    for key in [k for k in result if k.upper() == "NODEFAULTCURRENTDIRECTORYINEXEPATH"]:
        del result[key]
    result["NODEFAULTCURRENTDIRECTORYINEXEPATH" if os.name == "nt" else "NoDefaultCurrentDirectoryInExePath"] = "1"
    return result


_RESOLVED = None     # ("ok", 路径) 或 ("error", 说明);每个进程只解析一次


def program():
    """本进程的 Git 程序。工作仓 = BOARD_REPO(或配置的 repo,缺省看板仓),数据目录 = BOARD_DATA_DIR
    (缺省 <看板仓>/core/.data)—— 与 worker_loop 的 REPO / DATA 同一口径。"""
    global _RESOLVED
    if _RESOLVED is None:
        config = board_env.load()
        repo = os.environ.get("BOARD_REPO") or (str(config["repo"]) if config.get("repo") else CODE_ROOT)
        data = os.environ.get("BOARD_DATA_DIR") or os.path.join(CODE_ROOT, "core", ".data")
        configured = os.environ.get("WORKER_HOST_GIT") or (str(config["host_git"]) if config.get("host_git") else None)
        try:
            _RESOLVED = ("ok", resolve([repo, data], configured))
        except GitProgramError as error:
            _RESOLVED = ("error", str(error))
    if _RESOLVED[0] != "ok":
        raise GitProgramError(_RESOLVED[1])
    return _RESOLVED[1]
