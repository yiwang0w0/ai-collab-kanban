"""可信宿主的逐卡普通 Git 提交；完整性门不是文件系统权限隔离。"""
import datetime
import hashlib
import json
import os
import re
import stat
import subprocess
import unicodedata
import uuid


class HostCommitError(RuntimeError):
    pass


OPERATION_FILES = ("MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "CHERRY_PICK_HEAD", "REVERT_HEAD",
                   "REBASE_HEAD", "SQUASH_MSG", "AUTO_MERGE", "BISECT_LOG", "BISECT_START")
OPERATION_DIRS = ("rebase-merge", "rebase-apply", "sequencer")
# 一个仓可以有多个检出(主检出 + linked worktree)。各检出自己的状态在自己的 gitdir 里，
# 配置、钩子、对象库和引用则全仓共用。只绑定「本检出的」与「共用且会影响本次提交的」：
# 别的检出里提交、fetch、合并到一半，都不是本卡的控制面。
WORKTREE_FILES = OPERATION_FILES + ("HEAD", "index", "ORIG_HEAD", "FETCH_HEAD", "index.lock", "HEAD.lock",
                                    "config.worktree", "commondir", "gitdir", "info/sparse-checkout")
COMMON_FILES = ("config", "config.lock", "shallow", "shallow.lock", "info/grafts", "info/exclude",
                "objects/info/alternates", "objects/info/http-alternates")
WORKTREE_REFS = ("refs/bisect", "refs/worktree", "refs/rewritten")   # 引用里只有这几棵是各检出私有的
OBJECT_ID = r"[0-9a-f]{40}(?:[0-9a-f]{24})?"


def _fail(message):
    raise HostCommitError("宿主提交拒绝：" + message)


def _identity(path):
    try:
        s = os.lstat(path)
        if (stat.S_ISLNK(s.st_mode) or not stat.S_ISDIR(s.st_mode) or not s.st_ino
                or getattr(s, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)):
            _fail("目录不是可绑定的普通目录：" + path)
        return (os.path.realpath(path), s.st_dev, s.st_ino)
    except OSError as e:
        _fail("目录不可用：" + path + "；" + str(e))


def _read(path):
    """普通文件的 (stat, 内容)；缺文件返回 None。链接、重解析点、超大文件一律拒绝。"""
    try:
        s = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as e:
        _fail("无法检查控制文件：" + path + "；" + str(e))
    if (stat.S_ISLNK(s.st_mode) or not stat.S_ISREG(s.st_mode) or not s.st_ino
            or getattr(s, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)):
        _fail("控制文件不是普通文件：" + path)
    if s.st_size > 64 * 1024 * 1024:
        _fail("控制文件超过 64 MiB：" + path)
    try:
        with open(path, "rb") as f:
            return s, f.read()
    except FileNotFoundError:
        return None
    except OSError as e:
        _fail("无法读取控制文件：" + path + "；" + str(e))


def _file(path):
    """缺文件也绑定，随后新增控制文件同样算篡改。"""
    found = _read(path)
    if found is None:
        return None
    s, content = found
    return (s.st_dev, s.st_ino, s.st_mode, len(content), hashlib.sha256(content).hexdigest())


def _tree(path):
    """钩子、引用的增删和替换均在新 Git 启动前直接检查。"""
    if not os.path.lexists(path):
        return None
    result = {"": _identity(path)}
    for parent, dirs, files in os.walk(path, followlinks=False, onerror=lambda e: _fail(str(e))):
        for name in dirs:
            target = os.path.join(parent, name)
            result[os.path.relpath(target, path) + "/"] = _identity(target)
        for name in files:
            target = os.path.join(parent, name)
            result[os.path.relpath(target, path)] = _file(target)
        if len(result) > 50000:
            _fail("控制目录条目超过上限：" + path)
    return result


if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    _KERNEL = ctypes.WinDLL("kernel32", use_last_error=True)
    _KERNEL.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    _KERNEL.CreateJobObjectW.restype = wintypes.HANDLE
    _KERNEL.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    _KERNEL.AssignProcessToJobObject.restype = wintypes.BOOL
    _KERNEL.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
    _KERNEL.TerminateJobObject.restype = wintypes.BOOL
    _KERNEL.CloseHandle.argtypes = (wintypes.HANDLE,)
    _KERNEL.CloseHandle.restype = wintypes.BOOL
    _NTDLL = ctypes.WinDLL("ntdll")
    _NTDLL.NtResumeProcess.argtypes = (wintypes.HANDLE,)
    _NTDLL.NtResumeProcess.restype = ctypes.c_long
    CREATE_SUSPENDED = 0x00000004


def _spawn(argv, cwd, env, data, timeout):
    """运行一条 Git 命令，返回 (退出码, stdout, stderr, 是否超时)。超时终止的是整棵进程树。
    PATH 上的 git.exe 常是转发器，真正的 git、钩子、钩子里的子进程都是它的后代；只终止直接子进程，
    后代会带着输出管道继续跑完(提交照样生成)，调用方却要等它们结束才拿得到超时。
    Windows：进程在挂起状态下创建，放进作业对象之后才放行，此后它的所有后代都在作业里，
    不依赖父子进程号链(MSYS 的 exec 会断链)。POSIX：独立会话的进程组。"""
    pipes = {"stdin": subprocess.PIPE if data is not None else subprocess.DEVNULL,
             "stdout": subprocess.PIPE, "stderr": subprocess.PIPE}
    if os.name != "nt":
        import signal
        process = subprocess.Popen(argv, cwd=cwd, env=env, start_new_session=True, **pipes)

        def stop():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return _collect(process, data, timeout, stop)
    job = _KERNEL.CreateJobObjectW(None, None)
    if not job:
        raise OSError("无法创建作业对象，错误码 " + str(ctypes.get_last_error()))
    try:
        process = subprocess.Popen(argv, cwd=cwd, env=env, creationflags=subprocess.CREATE_NO_WINDOW | CREATE_SUSPENDED, **pipes)
        try:
            handle = int(process._handle)
            if not _KERNEL.AssignProcessToJobObject(job, handle):
                raise OSError("无法把 Git 进程放进作业对象，错误码 " + str(ctypes.get_last_error()))
            status = _NTDLL.NtResumeProcess(handle)
            if status:
                raise OSError("无法放行挂起的 Git 进程，状态码 " + hex(status & 0xFFFFFFFF))
        except BaseException:
            _kill(process)          # 还挂着，一条指令都没执行
            process.communicate()
            raise
        return _collect(process, data, timeout, lambda: _KERNEL.TerminateJobObject(job, 1))
    finally:
        _KERNEL.CloseHandle(job)


def _collect(process, data, timeout, stop):
    try:
        out, err = process.communicate(data, timeout=timeout)
        return process.returncode, out, err, False
    except subprocess.TimeoutExpired:
        stop()
        try:
            out, err = process.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            _kill(process)
            out, err = b"", b""
        return process.returncode, out or b"", err or b"", True
    except BaseException:
        stop()
        _kill(process)
        raise


def _kill(process):
    """整树终止之后的兜底；进程正在退出时再终止一次会被系统拒绝，不算错。"""
    try:
        process.kill()
    except OSError:
        pass


def is_batch(path):
    """.bat/.cmd 经 cmd.exe 启动，参数会被当作命令行解释；判据与 worker 的 cli_is_batch 相同。"""
    return os.path.splitext(str(path or ""))[1].lower() in (".bat", ".cmd")


def within(path, root):
    """path 是否落在 root 之内；字面路径与解析后的实际路径各比一次。"""
    for inner in {os.path.abspath(path), os.path.realpath(path)}:
        for outer in {os.path.abspath(root), os.path.realpath(root)}:
            try:
                if os.path.commonpath([os.path.normcase(outer), os.path.normcase(inner)]) == os.path.normcase(outer):
                    return True
            except ValueError:
                pass
    return False


def _search_path(name, environ):
    """只在 PATH 的绝对目录里找。空条目与相对条目都指当前目录，一律不搜。
    不用 shutil.which：Windows 上它把进程当前目录排在 PATH 之前，
    循环的当前目录可能在模型的写放行范围内。"""
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


def _check_program(program, roots, batch):
    """批处理包装器、落在工作仓或数据目录内的程序都不执行。"""
    if batch(program):
        _fail("Git 程序是 .bat/.cmd 包装器，参数会经 cmd.exe 解释；请把 WORKER_HOST_GIT 设为 git 可执行文件的绝对路径：" + program)
    for root in roots:
        if root and within(program, root):
            _fail("Git 程序位于工作仓或数据目录内，模型可以改写它；请改用其外的 Git：" + program)


def resolve_git(roots=(), configured=None, environ=None, batch=is_batch):
    """解析并固定宿主用的 Git 程序，返回 (绝对路径, 字节钉)。循环启动时调用一次，之后不再搜索。
    configured 是宿主配置的绝对路径；未配置时只搜 PATH 的绝对目录。"""
    environ = os.environ if environ is None else environ
    if configured:
        if not os.path.isabs(configured):
            _fail("配置的 Git 程序必须是绝对路径：" + str(configured))
        found = configured
    else:
        found = _search_path("git", environ)
        if not found:
            _fail("PATH 的绝对目录里找不到 Git 程序；请安装 Git 或把 WORKER_HOST_GIT 设为 git 可执行文件的绝对路径")
    _check_program(found, roots, batch)
    program = os.path.realpath(found)
    if os.name == "nt" and os.path.basename(os.path.dirname(program)).lower() == "cmd":
        program = os.path.realpath(os.path.join(os.path.dirname(os.path.dirname(program)), "bin", "git.exe"))
    _check_program(program, roots, batch)
    pin = _file(program)
    if pin is None:
        _fail("Git 实际程序不可用：" + program)
    return program, pin


def _path(value):
    """与产物路径规则同样使用可移植、无 .git 的规范相对路径。"""
    if (not isinstance(value, str) or not value or len(value.encode("utf-8")) > 1024
            or value != unicodedata.normalize("NFC", value)
            or re.search(r'[\\:*?"<>|\x00-\x1f\x7f]', value) or value.startswith("/")):
        _fail("工作文件路径不安全")
    parts = value.split("/")
    if len(parts) > 32 or any(
            not p or p.startswith(" ") or p in (".", "..") or p.endswith((".", " "))
            or len(p.encode("utf-8")) > 240
            or re.match(r"^(?:\.git|git~[0-9]+)$", p, re.I)
            or re.match(r"^(?:con|conin\$|conout\$|clock\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)", p, re.I)
            for p in parts):
        _fail("工作文件路径不安全")
    return value


class HostCommitGuard:
    """一仓一占用；失败不清理索引、不撤销文件、不自动抢残留锁。"""
    QUERY_TIMEOUT = 60          # 只读查询与 add：秒

    def __init__(self, repo, owner, program=None, protected=(), batch=is_batch, commit_timeout=600):
        """program 是循环启动时 resolve_git 固定下来的 (路径, 字节钉)；protected 是数据目录等
        模型可写、因而不得存放 Git 程序的目录；commit_timeout 是 git commit(含它跑的钩子)的秒数上限，
        与只读查询的 60 秒分开。"""
        if not os.path.isabs(repo):
            _fail("工作仓必须是绝对路径")
        if isinstance(commit_timeout, bool) or not isinstance(commit_timeout, (int, float)) or not commit_timeout > 0:
            _fail("commit 超时必须是正数秒")
        self.commit_timeout = commit_timeout
        self.requested_root = os.path.abspath(repo)
        self.root = os.path.realpath(repo)
        self.owner = str(owner)
        self.env = dict(os.environ)
        # 继承正常 system/global/local 配置，不覆盖身份、hooks、签名或过滤器。
        # 环境复制后不会接收模型进程的修改；正常内联配置也一并保留。
        # 只拒绝改变 Git 仓/索引/对象路由的环境入口。
        unsafe = {"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
                  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                  "GIT_CONFIG",
                  "GIT_NAMESPACE", "GIT_REPLACE_REF_BASE"}
        if any(k.upper() in unsafe for k in self.env):
            _fail("宿主环境含 Git 仓库路由覆盖")
        self.env["GIT_TERMINAL_PROMPT"] = "0"
        self.env["GCM_INTERACTIVE"] = "Never"
        # Git 自己再起子进程(钩子、别名、凭据助手)时，Windows 也不先搜当前目录。
        for key in [k for k in self.env if k.upper() == "NODEFAULTCURRENTDIRECTORYINEXEPATH"]:
            del self.env[key]
        self.env["NODEFAULTCURRENTDIRECTORYINEXEPATH" if os.name == "nt" else "NoDefaultCurrentDirectoryInExePath"] = "1"
        roots = [self.root, self.requested_root] + [p for p in protected if p]
        if program is None:
            program = resolve_git(roots, os.environ.get("WORKER_HOST_GIT"), self.env, batch)
        self.git, self.git_pin = program
        # 固定值可以来自更早的启动时刻；位置与扩展名按本卡的工作仓再核一次。
        _check_program(self.git, roots, batch)
        if not os.path.isabs(self.git) or _file(self.git) != self.git_pin:
            _fail("固定 Git 程序已改变")
        self.lock = None
        self.bound = None

    def _exec(self, args, data, timeout, refresh=False):
        """(退出码, stdout, stderr, 是否超时)。refresh 只给领卡时那一次索引落定用；
        其余调用一律不让 Git 顺手重写索引。"""
        if _file(self.git) != self.git_pin:
            _fail("固定 Git 程序已改变")
        argv = [self.git, "--no-pager"] + ([] if refresh else ["--no-optional-locks"]) + ["--no-replace-objects"] + args
        try:
            return _spawn(argv, self.root, self.env, data, timeout)
        except OSError as e:
            _fail("Git 操作失败，保留现场；" + str(e))

    def _run(self, args, data=None, optional=False, refresh=False):
        code, out, err, timed_out = self._exec(args, data, self.QUERY_TIMEOUT, refresh)
        if timed_out:
            _fail("Git 操作失败，保留现场；超过 %d 秒，已终止它的整棵进程树" % self.QUERY_TIMEOUT)
        if code and not (optional and code == 1):
            _fail("Git 操作失败，保留现场；" + err.decode("utf-8", "replace").strip())
        return out

    def _commit(self, message):
        """普通提交。正常结束返回 None；超时返回一句说明——超时不等于没提交(钩子可以在提交写入
        之后才变慢)，是否已生成由调用方随后核对 HEAD。"""
        # 提交信息从标准输入给：卡标题是任何能写卡的人的自由文本，不进任何命令行。
        # 自动维护(gc / maintenance --auto)会在提交收尾时打包引用、重打包对象，改写的是与本卡无关的
        # 控制文件；宿主这一次提交不顺带做它。钩子、身份、签名等其余配置照旧。
        code, _, err, timed_out = self._exec(
            ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "commit", "--cleanup=verbatim", "-F", "-"],
            (message + "\n").encode("utf-8"), self.commit_timeout)
        if timed_out:
            return "git commit 超过 %g 秒，宿主已终止它的整棵进程树(含钩子)" % self.commit_timeout
        if code:
            _fail("Git 操作失败，保留现场；" + err.decode("utf-8", "replace").strip())
        return None

    def _text(self, args, optional=False):
        try:
            return self._run(args, optional=optional).decode("utf-8", "strict").strip()
        except UnicodeDecodeError:
            _fail("Git 输出不是 UTF-8")

    def _absolute(self, path):
        return os.path.abspath(path if os.path.isabs(path) else os.path.join(self.root, path))

    def _config_path(self, key):
        return self._text(["config", "--path", "--get", key], optional=True)

    def _attribute_snapshot(self):
        result = {}
        count = 0
        for parent, dirs, files in os.walk(self.root, followlinks=False, onerror=lambda e: _fail(str(e))):
            dirs[:] = [d for d in dirs if d.lower() != ".git"]
            for name in dirs:
                target = os.path.join(parent, name)
                # 也拒绝 Windows junction/reparse，不能借目录链接漏掉有效属性文件。
                _identity(target)
            for name in files:
                count += 1
                if count > 100000:
                    _fail("工作仓条目超过完整性检查上限")
                if name.lower() == ".gitattributes":
                    target = os.path.join(parent, name)
                    result[target] = _file(target)
        for target in self.attribute_files:
            result[target] = _file(target)
        for target, pin in result.items():
            if pin is None:
                continue
            with open(target, "rb") as f:
                for line in f.read().splitlines():
                    if line.lstrip().startswith(b"#"):
                        continue
                    # 任意 filter 命令的依赖无法在这项小门内证明固定。
                    # 未启用的全局 LFS 配置不受影响；存在属性规则则显式拒绝。
                    if re.search(rb"(?:^|[ \t])[-!]?filter(?:=|[ \t]|$)", line):
                        _fail("属性文件含自定义 filter 控制，本开关无法安全绑定其依赖：" + target)
        return result

    def _controls(self):
        result = {"root": _identity(self.root), "requested_root": os.path.realpath(self.requested_root),
                  "git_dir": _identity(self.git_dir), "common_dir": _identity(self.common_dir),
                  "git_program": _file(self.git), "lock": _file(self.lock)}
        for target in self.control_files:
            result["file:" + target] = _file(target)
        for target in self.control_trees:
            result["tree:" + target] = _tree(target)
        result["branch"] = self._branch_value()
        result["shared_indexes"] = self._shared_indexes()
        result["attributes"] = self._attribute_snapshot()
        return result

    def _shared_indexes(self):
        return {os.path.join(self.git_dir, name): _file(os.path.join(self.git_dir, name))
                for name in os.listdir(self.git_dir) if name.startswith("sharedindex.")}

    def _branch_value(self):
        """本分支引用现在指向哪个提交：先看松散文件，没有再查 packed-refs。只读磁盘，不启动 Git。
        引用存储全仓共用，别的检出提交、fetch、打包引用都会改写它，所以不按字节钉整棵 refs
        和 packed-refs，只要求本分支解析出来的值不变(提交之后变成新提交)。"""
        if self.branch is None:
            return None
        target = self.common_dir
        for part in self.branch.split("/"):
            if os.path.lexists(target):
                _identity(target)
            target = os.path.join(target, part)
        loose = _read(target)
        if loose is not None:
            if not re.fullmatch(OBJECT_ID.encode() + rb"\n?", loose[1]):
                _fail("本分支引用不是普通的提交引用：" + self.branch)
            return loose[1].strip().decode("ascii")
        packed = _read(os.path.join(self.common_dir, "packed-refs"))
        suffix = b" " + self.branch.encode("utf-8")
        for line in (packed[1].split(b"\n") if packed else ()):
            if line.endswith(suffix) and re.fullmatch(OBJECT_ID.encode(), line[:-len(suffix)]):
                return line[:-len(suffix)].decode("ascii")
        _fail("找不到本分支引用：" + self.branch)

    def acquire(self):
        _identity(self.requested_root)
        _identity(self.root)
        if self._text(["rev-parse", "--is-bare-repository"]) != "false":
            _fail("自动提交要求非裸工作仓")
        if os.path.normcase(os.path.realpath(self._text(["rev-parse", "--show-toplevel"]))) != os.path.normcase(self.root):
            _fail("BOARD_REPO 必须指向工作仓根目录")
        self.git_dir = self._absolute(self._text(["rev-parse", "--path-format=absolute", "--git-dir"]))
        self.common_dir = self._absolute(self._text(["rev-parse", "--path-format=absolute", "--git-common-dir"]))
        _identity(self.git_dir)
        _identity(self.common_dir)
        # 占用锁放在公共目录：同一个仓的所有检出共用一把，不能换一个 worktree 绕过。
        self.lock_path = os.path.join(self.common_dir, "kanban-host-commit.lock")
        token = {"owner": self.owner, "pid": os.getpid(), "root": self.root,
                 "token": str(uuid.uuid4()), "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        try:
            with open(self.lock_path, "x", encoding="utf-8") as f:
                json.dump(token, f, ensure_ascii=False)
        except FileExistsError:
            _fail("工作仓已有宿主占用；不领卡，请人工核实残留锁：" + self.lock_path)
        except OSError as e:
            _fail("无法独占工作仓：" + str(e))
        self.lock = self.lock_path
        self.lock_pin = _file(self.lock)
        try:
            self._bind()
        except BaseException:
            # 走到这里还没有领任何卡，工作仓也没有被本线动过：不管因为什么被拒，都先收回自己
            # 刚建的锁，免得原因消除之后本线还被自己的残留挡住。锁若已被别人改动就不碰它。
            try:
                self.release()
            except Exception:
                pass
            raise
        return self

    def _bind(self):
        """占用之后、领卡之前：核实干净，再把本检出与共用的控制面绑定下来。"""
        if any(os.path.lexists(os.path.join(self.git_dir, p)) for p in OPERATION_FILES + OPERATION_DIRS + ("index.lock", "HEAD.lock")):
            _fail("工作仓有进行中 Git 操作或锁，不领卡；请人工处理")
        # NUL 格式防止换行、引号与路径转义把脏仓当空仓。
        dirty = self._run(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        if dirty:
            _fail("工作仓不干净，不领卡；请人工处理现有改动和暂存区")
        # 仓已核实干净、控制面尚未绑定：让索引的 stat 缓存在这里落定一次(唯一允许 Git 顺手写索引的地方)。
        # checkout / reset 之后索引里是过期的 stat；不先落定，卡在途时 IDE、提示符插件跑一次普通
        # git status 就会重写索引，被判成控制面篡改。同一秒内的改动落不定，所以只是尽力而为。
        self._run(["status", "--porcelain=v1", "-z", "--untracked-files=no"], refresh=True)
        hidden = self._run(["ls-files", "-v", "-z"]).split(b"\0")
        if any(row and (row[:1].islower() or row[:1] == b"S") for row in hidden):
            _fail("索引含忽略工作区变化的标记，无法证明干净；需人工处理")
        if any(row.startswith(b"160000 ") for row in self._run(["ls-files", "--stage", "-z"]).split(b"\0")):
            _fail("工作仓含子模块，本开关不自动提交子模块")
        self.head = self._text(["rev-parse", "--verify", "HEAD"])
        if not re.fullmatch(OBJECT_ID, self.head):
            _fail("无法绑定工作仓 HEAD")
        # 本检出所在的分支(游离 HEAD 时为空)。引用以文件存储时由 _branch_value 直接读盘核对；
        # reftable 读不了单条引用，退回按字节绑定整个引用库。
        self.branch = self._text(["symbolic-ref", "-q", "HEAD"], optional=True) or None
        self.reftable = self._text(["config", "--get", "extensions.refStorage"], optional=True).lower() == "reftable"
        if self.branch is not None and not self.branch.startswith("refs/heads/"):
            _fail("HEAD 指向的不是本地分支，无法绑定：" + self.branch)
        if self.reftable:
            self.branch = None
        elif self._branch_value() not in (None, self.head):
            _fail("本分支引用与 HEAD 不一致，无法绑定")
        origins = self._run(["config", "--null", "--show-origin", "--list"]).split(b"\0")
        self.control_files = set()
        includes = []
        for i in range(0, len(origins) - 1, 2):
            origin = origins[i].decode("utf-8", "strict")
            if origin.startswith("file:"):
                source = self._absolute(origin[5:])
                self.control_files.add(source)
            elif origin != "command line:":
                _fail("无法绑定 Git 配置来源")
            else:
                source = None
            entry = origins[i + 1].decode("utf-8", "strict")
            key, _, value = entry.partition("\n")
            if key.lower() == "include.path" or (key.lower().startswith("includeif.") and key.lower().endswith(".path")):
                includes.append((source, value))
        home = self.env.get("HOME") or self.env.get("USERPROFILE") or os.path.expanduser("~")
        xdg = self.env.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
        self.control_files.update([os.path.join(home, ".gitconfig"), os.path.join(xdg, "git", "config"),
                                   os.path.join(xdg, "git", "ignore")])
        for source, value in includes:
            # Git 会忽略尚不存在的 include；仍需绑定其缺失状态，防止模型新增后加载。
            if value.startswith("~/") or value.startswith("~\\"):
                target = os.path.join(home, value[2:])
            elif value.startswith("~") or value.startswith("%("):
                _fail("无法确定配置 include 路径的本机展开")
            elif os.path.isabs(value):
                target = value
            elif source:
                target = os.path.join(os.path.dirname(source), value)
            else:
                _fail("命令行 include 必须是可确定的绝对路径")
            self.control_files.add(os.path.abspath(target))
        excludes = self._config_path("core.excludesFile")
        if excludes:
            self.control_files.add(self._absolute(excludes))
        for key in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"):
            if self.env.get(key):
                self.control_files.add(self._absolute(self.env[key]))
        if os.name == "nt":
            self.control_files.add(os.path.join(os.path.dirname(os.path.dirname(self.git)), "etc", "gitconfig"))
            if self.env.get("PROGRAMDATA"):
                self.control_files.add(os.path.join(self.env["PROGRAMDATA"], "Git", "config"))
        else:
            self.control_files.add("/etc/gitconfig")
        self.control_files.update(os.path.join(self.git_dir, p) for p in WORKTREE_FILES)
        self.control_files.update(os.path.join(self.common_dir, p) for p in COMMON_FILES)
        dotgit = os.path.join(self.root, ".git")
        if not os.path.isdir(dotgit):
            self.control_files.add(dotgit)
        self.control_trees = {os.path.join(self.git_dir, p) for p in OPERATION_DIRS + WORKTREE_REFS}
        # 提交会正常改写的引用库目录；文件存储时为空(本分支由 _branch_value 按值核对)。
        self.ref_stores = {os.path.join(base, "reftable") for base in (self.git_dir, self.common_dir)} if self.reftable else set()
        self.control_trees.update(self.ref_stores)
        if os.path.isdir(dotgit):
            # 根 .git 目录本身也绑定，不能切换为另一个 gitfile。
            self.dotgit_identity = _identity(dotgit)
        else:
            self.dotgit_identity = None
        hookpath = self._config_path("core.hooksPath")
        self.control_trees.add(self._absolute(hookpath) if hookpath else os.path.join(self.common_dir, "hooks"))
        self.attribute_files = {os.path.join(self.common_dir, "info", "attributes"),
                                os.path.join(self.git_dir, "info", "attributes"),
                                os.path.join(xdg, "git", "attributes")}
        attrpath = self._config_path("core.attributesFile")
        if attrpath:
            self.attribute_files.add(self._absolute(attrpath))
        if os.name == "nt":
            self.attribute_files.add(os.path.join(os.path.dirname(os.path.dirname(self.git)), "etc", "gitattributes"))
        else:
            self.attribute_files.add("/etc/gitattributes")
        monitor = self._config_path("core.fsmonitor")
        if monitor and monitor.lower() not in ("true", "false"):
            # 自定义 fsmonitor 的命令字符串无法由这项小门完整绑定其依赖。
            _fail("自定义 core.fsmonitor 无法绑定，需管理者先提供可确定的控制面")
        if self._config_path("diff.external") or self.env.get("GIT_EXTERNAL_DIFF"):
            _fail("自定义外部 diff 无法绑定，需管理者先提供可确定的控制面")
        self.initial = self._controls()
        self.assert_intact()

    def assert_intact(self):
        if not hasattr(self, "initial"):
            _fail("工作仓尚未完成绑定")
        # 必须先只读磁盘。此处之前绝不运行 Git，以免读入新增 hook/filter/config。
        if self.dotgit_identity is not None and _identity(os.path.join(self.root, ".git")) != self.dotgit_identity:
            _fail(".git 目录身份改变，保留现场")
        if self._controls() != self.initial:
            _fail("Git 控制面或属性文件改变，保留现场且不再调用 Git")
        return True

    def _changes(self):
        raw = self._run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])
        paths = []
        for row in raw.split(b"\0"):
            if not row:
                continue
            if len(row) < 4 or row[2:3] != b" ":
                _fail("Git 工作区状态格式异常")
            code = row[:2]
            if code[:1] not in (b" ", b"?") or b"U" in code or b"!" in code:
                _fail("发现非本轮暂存或冲突，保留现场")
            try:
                path = _path(row[3:].decode("utf-8", "strict"))
            except UnicodeDecodeError:
                _fail("工作文件名不是 UTF-8")
            if os.path.basename(path).lower() == ".gitattributes":
                _fail("本轮改动属性控制文件，拒绝自动暂存")
            paths.append(path)
        if len(paths) > 256 or len(set(p.upper() for p in paths)) != len(paths):
            _fail("工作文件过多或存在大小写冲突")
        return sorted(paths)

    def _working_snapshot(self, paths):
        result = {}
        total = 0
        for path in paths:
            target = self.root
            missing_parent = False
            for part in path.split("/")[:-1]:
                target = os.path.join(target, part)
                if not os.path.lexists(target):
                    # 删除整目录时父目录可以已消失，路径本身仍保持规范、不可穿越。
                    missing_parent = True
                    break
                _identity(target)
            target = os.path.join(self.root, *path.split("/"))
            result[path] = None if missing_parent else _file(target)
            if result[path] is not None:
                total += result[path][3]
            if total > 32 * 1024 * 1024:
                _fail("本轮改动内容超过 32 MiB")
        return result

    def bind_changes(self):
        self.assert_intact()
        paths = self._changes()
        self.bound = self._working_snapshot(paths)
        self.assert_intact()
        return paths

    def finish(self, task_id, title, evidence_file):
        self.assert_intact()
        if self.bound is None:
            _fail("验证前尚未绑定本轮文件")
        if not re.fullmatch(r"[0-9]+", str(task_id)) or not isinstance(title, str) or not title.strip() or re.search(r"[\x00-\x1f\x7f]", title):
            _fail("卡号或提交标题无效")
        evidence = os.path.realpath(evidence_file)
        # 目录一级在循环启动门就拒了(worker_loop.host_commit_gate)；这里按文件再核一次。
        if within(evidence_file, self.root):
            _fail("自动提交要求模型证据位于工作仓外")
        proof = _file(evidence)
        if proof is None or proof[3] == 0:
            _fail("模型证据尚未写好")
        paths = self._changes()
        if self._working_snapshot(paths) != self.bound:
            _fail("验证期间工作文件变化，保留现场")
        self.assert_intact()
        if not paths:
            return {"sha": None, "paths": []}
        pathspec = b"".join(p.encode("utf-8") + b"\0" for p in paths)
        # NUL 输入 + 字面 pathspec；卡片内容、文件名均不经过 shell。
        self._run(["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], pathspec)
        # 索引现在由宿主正常 add 改变；其余控制面仍按原绑定逐项检查。
        index = os.path.join(self.git_dir, "index")
        self.initial["file:" + index] = _file(index)
        self.initial["shared_indexes"] = self._shared_indexes()
        self.assert_intact()
        staged = self._run(["diff", "--no-ext-diff", "--no-textconv", "--cached", "--name-only", "-z", "--no-renames"]).split(b"\0")
        if sorted(p.decode("utf-8", "strict") for p in staged if p) != paths:
            _fail("暂存路径超出本卡绑定，保留现场")
        if self._working_snapshot(paths) != self.bound:
            _fail("暂存期间工作文件变化，保留现场")
        if _file(evidence) != proof:
            _fail("模型证据在提交前改变，保留现场")
        self.assert_intact()
        message = "#" + str(task_id) + " " + title.strip()
        timed_out = self._commit(message)
        # 这是普通提交：保留当前配置与钩子，任何失败均不 reset 或重试。
        # commit 正常改变 HEAD/index/ref。其他控制字节仍须先直接检查，不能先跑新 Git。
        try:
            self._assert_after_commit()
        except HostCommitError as error:
            if timed_out:
                # 进程树是被中途终止的，可能留下锁文件；此时不再启动 Git，也就判断不了提交是否已生成。
                _fail(timed_out + "；随后的磁盘检查：" + str(error).replace("宿主提交拒绝：", "", 1))
            raise
        if _file(evidence) != proof:
            _fail("模型证据在普通提交期间改变，保留现场")
        if self._working_snapshot(paths) != self.bound:
            _fail("普通钩子改写了已验证文件，保留已生成提交及占用，需重新核实验证")
        sha = self._text(["rev-parse", "--verify", "HEAD"])
        self._assert_after_commit()
        if timed_out and sha == self.head:
            _fail(timed_out + "；核对 HEAD 没有前移，提交没有生成。本卡改动仍在暂存区，占用保留，需人工处理；"
                  "钩子本来就要跑这么久时，调大 WORKER_HOST_COMMIT_TIMEOUT_SEC")
        if self._branch_value() not in (None, sha):
            _fail("提交后本分支引用与 HEAD 不一致，请人工核实并保留现场")
        parent = self._text(["rev-parse", "--verify", "HEAD^"])
        self._assert_after_commit()
        actual = self._run(["diff-tree", "--no-ext-diff", "--no-textconv", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", sha]).split(b"\0")
        if parent != self.head or sorted(p.decode("utf-8", "strict") for p in actual if p) != paths:
            _fail("普通提交结果超出本卡绑定，请人工核实并保留现场")
        self._assert_after_commit()
        if self._text(["log", "-1", "--format=%B"]) != message:
            _fail("普通钩子改变了提交信息，保留已生成提交及占用，需人工核实")
        self._assert_after_commit()
        if self._run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]):
            _fail("提交后仍有改动，请人工核实并保留现场")
        result = {"sha": sha, "paths": paths}
        if timed_out:
            # 走到这里，父提交、路径、提交信息、工作区都已按本卡核对过：提交是真的，只是收尾没跑完。
            result["note"] = timed_out + "；核对确认提交已生成，父提交、路径与提交信息均与本卡一致。被终止的钩子可能没有跑完"
        return result

    def _assert_after_commit(self):
        if self.dotgit_identity is not None and _identity(os.path.join(self.root, ".git")) != self.dotgit_identity:
            _fail("普通提交后 .git 目录身份改变，保留现场")
        # 提交正常改写的只有：本检出的 HEAD(游离时)与索引、本分支引用(或整个 reftable 引用库)。
        expected = {"file:" + os.path.join(self.git_dir, "HEAD"), "file:" + os.path.join(self.git_dir, "index"),
                    "branch", "shared_indexes"} | {"tree:" + target for target in self.ref_stores}
        now = self._controls()
        if any(now.get(key) != value for key, value in self.initial.items() if key not in expected):
            _fail("普通提交期间控制面改变；不再调用 Git，需人工核实已生成提交")

    def release(self):
        if self.lock is None:
            return
        if _file(self.lock) != self.lock_pin:
            _fail("占用锁改变，保留现场")
        os.unlink(self.lock)
        self.lock = None
