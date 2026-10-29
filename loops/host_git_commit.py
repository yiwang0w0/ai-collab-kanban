"""可信宿主的逐卡普通 Git 提交；完整性门不是文件系统权限隔离。"""
import datetime
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import unicodedata
import uuid


class HostCommitError(RuntimeError):
    pass


OPERATION_FILES = ("MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "CHERRY_PICK_HEAD", "REVERT_HEAD",
                   "REBASE_HEAD", "SQUASH_MSG", "AUTO_MERGE", "BISECT_LOG", "BISECT_START")
OPERATION_DIRS = ("rebase-merge", "rebase-apply", "sequencer")


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


def _file(path):
    """缺文件也绑定，随后新增控制文件同样算篡改。"""
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
            content = f.read()
    except OSError as e:
        _fail("无法读取控制文件：" + path + "；" + str(e))
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
    def __init__(self, repo, owner):
        if not os.path.isabs(repo):
            _fail("工作仓必须是绝对路径")
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
        executable = shutil.which("git")
        if not executable:
            _fail("找不到 Git 程序")
        executable = os.path.realpath(executable)
        if os.name == "nt" and os.path.basename(os.path.dirname(executable)).lower() == "cmd":
            executable = os.path.join(os.path.dirname(os.path.dirname(executable)), "bin", "git.exe")
        self.git = os.path.realpath(executable)
        self.git_pin = _file(self.git)
        if self.git_pin is None:
            _fail("Git 实际程序不可用")
        self.lock = None
        self.bound = None

    def _run(self, args, data=None, optional=False):
        if _file(self.git) != self.git_pin:
            _fail("固定 Git 程序已改变")
        try:
            p = subprocess.run([self.git, "--no-pager", "--no-optional-locks", "--no-replace-objects"] + args,
                               cwd=self.root, env=self.env, input=data, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, timeout=60,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except (OSError, subprocess.TimeoutExpired) as e:
            _fail("Git 操作失败，保留现场；" + str(e))
        if p.returncode and not (optional and p.returncode == 1):
            _fail("Git 操作失败，保留现场；" + p.stderr.decode("utf-8", "replace").strip())
        return p.stdout

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
        result["shared_indexes"] = self._shared_indexes()
        result["attributes"] = self._attribute_snapshot()
        return result

    def _shared_indexes(self):
        return {os.path.join(base, name): _file(os.path.join(base, name))
                for base in {self.git_dir, self.common_dir} for name in os.listdir(base)
                if name.startswith("sharedindex.")}

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
        self.lock = os.path.join(self.common_dir, "kanban-host-commit.lock")
        self.lock_path = self.lock
        token = {"owner": self.owner, "pid": os.getpid(), "root": self.root,
                 "token": str(uuid.uuid4()), "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        try:
            with open(self.lock, "x", encoding="utf-8") as f:
                json.dump(token, f, ensure_ascii=False)
        except FileExistsError:
            _fail("工作仓已有宿主占用；不领卡，请人工核实残留锁：" + self.lock)
        except OSError as e:
            _fail("无法独占工作仓：" + str(e))
        self.lock_pin = _file(self.lock)
        try:
            for base in {self.git_dir, self.common_dir}:
                if any(os.path.lexists(os.path.join(base, p)) for p in OPERATION_FILES + OPERATION_DIRS + ("index.lock", "HEAD.lock")):
                    _fail("工作仓有进行中 Git 操作或锁，不领卡；请人工处理")
            # NUL 格式防止换行、引号与路径转义把脏仓当空仓。
            dirty = self._run(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
            if dirty:
                self.release()
                _fail("工作仓不干净，不领卡；请人工处理现有改动和暂存区")
            hidden = self._run(["ls-files", "-v", "-z"]).split(b"\0")
            if any(row and (row[:1].islower() or row[:1] == b"S") for row in hidden):
                _fail("索引含忽略工作区变化的标记，无法证明干净；需人工处理")
            if any(row.startswith(b"160000 ") for row in self._run(["ls-files", "--stage", "-z"]).split(b"\0")):
                _fail("工作仓含子模块，本开关不自动提交子模块")
            self.head = self._text(["rev-parse", "--verify", "HEAD"])
            if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", self.head):
                _fail("无法绑定工作仓 HEAD")
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
            for base in {self.git_dir, self.common_dir}:
                self.control_files.update(os.path.join(base, p) for p in
                                          ("HEAD", "index", "config", "config.worktree", "commondir", "gitdir",
                                           "packed-refs", "shallow", "info/grafts", "info/exclude", "info/sparse-checkout",
                                           "objects/info/alternates", "objects/info/http-alternates"))
                self.control_files.update(os.path.join(base, p) for p in OPERATION_FILES +
                                          ("ORIG_HEAD", "FETCH_HEAD", "index.lock", "HEAD.lock", "config.lock", "packed-refs.lock", "shallow.lock"))
            dotgit = os.path.join(self.root, ".git")
            if not os.path.isdir(dotgit):
                self.control_files.add(dotgit)
            self.control_trees = {os.path.join(self.common_dir, "refs"), os.path.join(self.git_dir, "refs")}
            self.control_trees.update(os.path.join(base, p) for base in {self.git_dir, self.common_dir} for p in OPERATION_DIRS)
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
            return self
        except Exception:
            # 已确认的脏仓在上面释放；其余异常保留锁供人工检查。
            raise

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
        try:
            inside = os.path.commonpath([self.root, evidence]) == self.root
        except ValueError:
            inside = False
        if inside:
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
        for target in (os.path.join(self.git_dir, "index"), os.path.join(self.common_dir, "index")):
            if "file:" + target in self.initial:
                self.initial["file:" + target] = _file(target)
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
        self._run(["commit", "--cleanup=verbatim", "-m", message])
        # 这是普通提交：保留当前配置与钩子，任何失败均不 reset 或重试。
        # commit 正常改变 HEAD/index/ref。其他控制字节仍须先直接检查，不能先跑新 Git。
        self._assert_after_commit()
        if _file(evidence) != proof:
            _fail("模型证据在普通提交期间改变，保留现场")
        if self._working_snapshot(paths) != self.bound:
            _fail("普通钩子改写了已验证文件，保留已生成提交及占用，需重新核实验证")
        sha = self._text(["rev-parse", "--verify", "HEAD"])
        self._assert_after_commit()
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
        return {"sha": sha, "paths": paths}

    def _assert_after_commit(self):
        if self.dotgit_identity is not None and _identity(os.path.join(self.root, ".git")) != self.dotgit_identity:
            _fail("普通提交后 .git 目录身份改变，保留现场")
        expected = set()
        for base in {self.git_dir, self.common_dir}:
            expected.update(("file:" + os.path.join(base, "HEAD"),
                             "file:" + os.path.join(base, "index"),
                             "tree:" + os.path.join(base, "refs")))
        expected.add("shared_indexes")
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
