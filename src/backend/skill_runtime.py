"""节点本地的 Skill 运行准备：整包指纹审批、隔离环境、非交互安装。

导入不执行代码；自动安装只接受标准依赖声明，不提权、不执行第三方安装脚本。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from . import paths


class SkillRuntime:
    def __init__(self, store: Any, root: Path | None = None) -> None:
        self.store = store
        self.root = root or paths.sub("skill-runtime")
        self.root.mkdir(parents=True, exist_ok=True)
        self.tasks: dict[str, asyncio.Task] = {}
        self.lock = threading.RLock()
        self.approvals: dict[str, tuple[str, str, float]] = {}

    def _source(self, name: str) -> Path:
        from .skill_store import LIBRARY_DIR
        self.store._validate_library_name(name)
        source = LIBRARY_DIR / name
        if not (source / "SKILL.md").is_file() or source.is_symlink():
            raise ValueError("此节点尚未安装该 Skill，请先导入完整资源包")
        return source

    @staticmethod
    def _files(source: Path) -> dict[str, bytes]:
        result: dict[str, bytes] = {}
        total = 0
        for item in sorted(source.rglob("*")):
            if item.is_symlink():
                raise ValueError("Skill 资源包含符号链接，不能用于依赖准备")
            if not item.is_file() or any(p in {".git", "__pycache__"} for p in item.relative_to(source).parts):
                continue
            if item.stat().st_size > 16 * 1024 * 1024:
                raise ValueError("Skill 单文件超过检查上限")
            data = item.read_bytes()
            total += len(data)
            if total > 64 * 1024 * 1024 or len(result) >= 512:
                raise ValueError("Skill 资源超过检查上限")
            result[item.relative_to(source).as_posix()] = data
        return result

    @staticmethod
    def _digest(files: dict[str, bytes]) -> str:
        h = hashlib.sha256()
        for name, data in sorted(files.items()):
            h.update(name.encode() + b"\0" + hashlib.sha256(data).digest())
        return h.hexdigest()

    @staticmethod
    def _python() -> str:
        if not getattr(sys, "frozen", False):
            return sys.executable
        return shutil.which("python3") or shutil.which("python") or ""

    @staticmethod
    def _relative(value: str, parent: str = "") -> str:
        from posixpath import normpath, join
        value = str(value).replace("\\", "/")
        path = normpath(join(parent, value))
        if path in {"", ".", ".."} or path.startswith(("../", "/")) or ":" in path:
            raise ValueError(f"资源路径越界：{value}")
        return path

    def _state_path(self, name: str) -> Path:
        self.store._validate_library_name(name)
        folder = self.root / name
        folder.mkdir(parents=True, exist_ok=True)
        return folder / "state.json"

    def _read(self, name: str) -> dict:
        try:
            return json.loads(self._state_path(name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save(self, name: str, state: dict) -> None:
        with self.lock:
            target = self._state_path(name)
            temp = target.with_suffix(f".{uuid.uuid4().hex}.tmp")
            temp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
            temp.replace(target)

    def inspect(self, name: str) -> dict:
        source = self._source(name)
        files = self._files(source)
        digest = self._digest(files)
        blockers: list[str] = []
        manual: list[str] = []
        warnings: list[str] = []
        manifest: dict = {}
        if "awu-runtime.json" in files:
            manifest = json.loads(files["awu-runtime.json"])
            if not isinstance(manifest, dict) or manifest.get("version") != 1:
                raise ValueError("awu-runtime.json 必须是 version=1 的对象")
            unknown = set(manifest) - {"version", "requiredFiles", "requiredCommands", "requiredEnv", "pythonImports", "manualSteps"}
            if unknown:
                manual.append("不支持的运行声明字段：" + ", ".join(sorted(unknown)))
        def strings(key: str) -> list[str]:
            value = manifest.get(key, [])
            if not isinstance(value, list) or any(not isinstance(v, str) or len(v) > 500 for v in value):
                raise ValueError(f"{key} 必须是字符串数组")
            return value
        for rel in strings("requiredFiles"):
            if self._relative(rel) not in files:
                blockers.append(f"缺少必需文件：{rel}")
        for file, data in files.items():
            if not file.endswith(".md"):
                continue
            for match in re.finditer(r"\]\(([^\s)]+)(?:\s+[^)]*)?\)", data.decode("utf-8", errors="replace")):
                rel = match.group(1).strip("<>").split("#")[0]
                if not rel or re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:", rel) or rel.startswith("//") or any(c in rel for c in "$<>{}"):
                    continue
                try:
                    path = self._relative(rel, str(Path(file).parent).replace("\\", "/"))
                    if path not in files and not any(k.startswith(path.rstrip("/") + "/") for k in files):
                        warnings.append(f"{file} 引用未包含的资源：{rel}")
                        if file == "SKILL.md" and path.startswith(("scripts/", "workflows/", "references/", "assets/", "templates/")):
                            blockers.append(f"技能入口引用的配套资源缺失：{path}")
                except ValueError:
                    warnings.append(f"{file} 引用了技能目录外的资源：{rel}")
        requirements: list[str] = []
        visiting: set[str] = set()
        def read_requirements(file: str) -> None:
            if file in visiting:
                raise ValueError("requirements 存在循环引用")
            if file not in files:
                raise ValueError(f"依赖声明缺少文件：{file}")
            visiting.add(file)
            for raw in files[file].decode("utf-8-sig").splitlines():
                line = raw.split(" #", 1)[0].strip()
                if not line or line.startswith("#"):
                    continue
                include = re.fullmatch(r"(?:-r\s*|--requirement[=\s]+)([^\s]+)", line)
                if include:
                    read_requirements(self._relative(include[1], str(Path(file).parent)))
                elif line.startswith("-") or any(x in line for x in ("://", "@", "\\", "/")):
                    blockers.append(f"需人工审核的 pip 声明：{file}（URL、本地路径或 pip 选项不自动执行）")
                elif not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.\-\[\],<>=!~*; '\"()+]*", line):
                    blockers.append(f"无法安全解析 pip 声明：{file}")
                else:
                    requirements.append(line)
            visiting.remove(file)
        if "requirements.txt" in files:
            read_requirements("requirements.txt")
        python = self._python()
        imports = strings("pythonImports")
        if any(not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", v) for v in imports):
            raise ValueError("pythonImports 包含非法模块名")
        needs_python = bool(requirements or imports or any(f.endswith(".py") for f in files))
        if needs_python and not python:
            blockers.append("此节点没有可用的系统 Python 3.10+，请先安装 Python")
        if needs_python and "requirements.txt" not in files and "awu-runtime.json" not in files:
            manual.append("包含 Python 脚本但没有依赖声明，请补充 requirements.txt 或 awu-runtime.json")
        package: dict = {}
        npm = shutil.which("npm") or ""
        node = shutil.which("node") or ""
        if "package.json" in files:
            if ".npmrc" in files:
                blockers.append("包内 .npmrc 会改变安装行为，需人工审核；不自动加载该配置")
            package = json.loads(files["package.json"])
            if not isinstance(package, dict):
                raise ValueError("package.json 必须是对象")
            if not npm or not node:
                blockers.append("此节点缺少 Node.js 或 npm")
            if "package-lock.json" not in files:
                blockers.append("缺少 package-lock.json；不自动生成或修改依赖锁")
            if package.get("scripts"):
                manual.append("package.json 含脚本；自动准备不会执行生命周期/构建脚本，请人工核实")
            for section in ("dependencies", "devDependencies", "optionalDependencies"):
                for value in (package.get(section) or {}).values():
                    if not isinstance(value, str) or any(x in value for x in (":", "/", "\\")):
                        blockers.append("npm 依赖包含 Git/URL/本地路径，需人工审核")
            if "package-lock.json" in files:
                lock = json.loads(files["package-lock.json"])
                if lock.get("lockfileVersion") not in {2, 3}:
                    blockers.append("仅支持可检查 packages 的 npm lockfileVersion 2/3")
                for item in (lock.get("packages") or {}).values():
                    resolved = str(item.get("resolved") or "")
                    if item.get("link") or (resolved and not resolved.startswith("https://")):
                        blockers.append("npm lock 包含本地链接或非 HTTPS 来源，需人工审核")
                    if item.get("hasInstallScript"):
                        manual.append("npm 依赖要求安装脚本；自动准备禁用脚本，需人工核实")
        for file in ("pyproject.toml", "setup.py", "environment.yml", "install.sh", "install.ps1"):
            if file in files:
                manual.append(f"发现 {file}，不自动执行；请人工核对额外安装步骤")
        commands = []
        for command in strings("requiredCommands"):
            if not re.fullmatch(r"[A-Za-z0-9_.+-]+", command):
                raise ValueError("requiredCommands 只能包含程序名，不能含路径或参数")
            found = shutil.which(command)
            commands.append({"name": command, "available": bool(found)})
            if not found:
                blockers.append(f"缺少系统工具：{command}（不自动提权安装）")
        # 只有 Backend Skill 的调用器会实际注入 skill-secrets；原生 CLI 不会。
        configured = (self.store.get_secrets(name) or {}) if "call.py" in files else {}
        missing_env = []
        schema = self.store.get_secrets_schema(name) or {}
        required_env = strings("requiredEnv") + [f["key"] for f in schema.get("fields", []) if f.get("required") and f.get("key")]
        for key in sorted(set(required_env)):
            if not re.fullmatch(r"[A-Za-z_]\w*", key):
                raise ValueError("requiredEnv 包含非法环境变量名")
            if not configured.get(key) and not os.environ.get(key):
                missing_env.append(key)
        manual.extend(strings("manualSteps"))
        manual = sorted(set(manual))
        old = self._read(name)
        active = name in self.tasks and not self.tasks[name].done()
        if old.get("status") == "preparing" and not active:
            old.update(status="interrupted", message="上次准备因执行节点重启而中断，可重新确认计划后重试")
            self._save(name, old)
        verified = old.get("digest") == digest and old.get("status") == "verified"
        environment = self.root / name / digest[:24]
        vpython = environment / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if needs_python and not vpython.is_file():
            verified = False
        if package.get("dependencies") and not (environment / "node" / "node_modules").is_dir():
            verified = False
        status = ("preparing" if active else "blocked" if blockers else "needs_configuration" if missing_env
                  else "needs_review" if manual else "ready" if verified else "failed" if old.get("status") in {"failed", "interrupted"} and old.get("digest") == digest
                  else "needs_preparation")
        plan = {
            "name": name, "digest": digest, "node": {"host": platform.node(), "os": platform.system(), "architecture": platform.machine()},
            "status": status, "fileCount": len(files), "warnings": sorted(set(warnings))[:50],
            "blockers": blockers, "manualSteps": manual, "missingEnv": missing_env,
            "commands": commands, "python": python, "needsPython": needs_python,
            "requirements": requirements, "pythonImports": imports,
            "needsNode": bool(package), "npm": npm, "nodeExecutable": node,
            "nodeDependencies": {k: package.get(k, {}) for k in ("dependencies", "devDependencies", "optionalDependencies")},
            "environment": str(environment), "pythonExecutable": str(vpython) if needs_python else "",
            "lastRun": old,
            "steps": (["创建专属 Python venv（要求 Python 3.10+）", "从 PyPI 安装声明依赖，仅允许预构建 wheel", "运行 pip check 和声明的模块导入验证"] if needs_python else [])
                     + (["在独立目录 npm ci --ignore-scripts --no-audit --no-fund", "检查 npm 依赖树（不执行安装/构建脚本）"] if package else [])
                     + ["复核文件指纹，记录此节点的运行就绪结果"],
        }
        stable = {k: v for k, v in plan.items() if k not in {"lastRun", "status"}}
        plan["planHash"] = hashlib.sha256(json.dumps(stable, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        return plan

    def review(self, name: str) -> dict:
        plan = self.inspect(name)
        token = uuid.uuid4().hex
        with self.lock:
            now = time.time()
            self.approvals = {k: v for k, v in self.approvals.items() if v[2] > now}
            self.approvals[token] = (name, plan["planHash"], now + 900)
        plan["approvalToken"] = token
        return plan

    async def start(self, name: str, token: str) -> dict:
        if name in self.tasks and not self.tasks[name].done():
            raise ValueError("该技能正在准备，请查看已有任务")
        plan = await asyncio.to_thread(self.inspect, name)
        # inspect 期间可能有另一个请求开始，必须在最后一个 await 之后再检查。
        if name in self.tasks and not self.tasks[name].done():
            raise ValueError("该技能正在准备，请查看已有任务")
        with self.lock:
            approved = self.approvals.pop(token, None)
        if not approved or approved[0] != name or approved[1] != plan["planHash"] or approved[2] < time.time():
            raise ValueError("安装计划已过期或内容/环境已变化，请重新检查并确认")
        if plan["blockers"]:
            raise ValueError("请先处理缺失文件、系统工具和无法安全解析的声明，再准备依赖")
        state = {"status": "preparing", "digest": plan["digest"], "startedAt": time.time(), "log": [], "message": "正在准备"}
        self._save(name, state)
        task = asyncio.create_task(asyncio.to_thread(self._prepare, name, plan, state))
        self.tasks[name] = task
        task.add_done_callback(lambda done: self.tasks.pop(name, None) if self.tasks.get(name) is done else None)
        return {"status": "ok"}

    def _prepare(self, name: str, plan: dict, state: dict) -> None:
        def log(message: str) -> None:
            message = re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1[redacted]@", message)
            message = re.sub(r"(?i)(token|password|api[_-]?key|secret)([=:]\s*)[^\s&]+", r"\1\2[redacted]", message)
            state["log"] = (state.get("log", []) + [message[-4000:]])[-60:]
            self._save(name, state)
        try:
            files = self._files(self._source(name))
            if self._digest(files) != plan["digest"]:
                raise ValueError("Skill 在确认后发生变化，请重新检查")
            env_dir = Path(plan["environment"])
            env_dir.mkdir(parents=True, exist_ok=True)
            if plan["needsPython"]:
                self._run([plan["python"], "-I", "-c", "import sys; assert sys.version_info >= (3,10), 'Python 3.10+ required'"], env_dir, log)
                self._run([plan["python"], "-I", "-m", "venv", str(env_dir / "venv")], env_dir, log)
                python = plan["pythonExecutable"]
                requirements = env_dir / "requirements.resolved.txt"
                requirements.write_text("\n".join(plan["requirements"]) + "\n", encoding="utf-8")
                if plan["requirements"]:
                    self._run([python, "-I", "-m", "pip", "--isolated", "install", "--index-url", "https://pypi.org/simple", "--disable-pip-version-check", "--no-input", "--only-binary=:all:", "-r", str(requirements)], env_dir, log)
                self._run([python, "-I", "-m", "pip", "--isolated", "check"], env_dir, log)
                if plan["pythonImports"]:
                    self._run([python, "-I", "-c", "import importlib,sys; [importlib.import_module(n) for n in sys.argv[1:]]", *plan["pythonImports"]], env_dir, log)
            if plan["needsNode"]:
                node_dir = env_dir / "node"
                node_dir.mkdir(exist_ok=True)
                # Node 模块按脚本所在目录解析；完整运行副本和 node_modules 共置，
                # 而不是只安装后告诉 Agent 用一个 ESM 不识别的 NODE_PATH。
                for file, data in files.items():
                    if Path(file).name == ".npmrc":
                        continue
                    target = node_dir / file
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                # 不通过 cmd 拼接 npm.cmd，防止 Windows 参数被二次解释。
                npm = Path(plan["npm"])
                if os.name == "nt":
                    cli = npm.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
                    if not cli.is_file():
                        raise ValueError("未找到 npm-cli.js，请修复 Node/npm 安装")
                    argv = [plan["nodeExecutable"], str(cli)]
                else:
                    argv = [str(npm)]
                self._run([*argv, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], node_dir, log)
                self._run([*argv, "ls", "--all", "--ignore-scripts"], node_dir, log)
            if self._digest(self._files(self._source(name))) != plan["digest"]:
                raise ValueError("准备期间 Skill 已更新，旧环境不能标为就绪，请重试")
            state.update(status="verified", message="自动依赖检查通过，仍有人工项待处理" if plan["manualSteps"] else "声明的运行检查通过；未执行实际生成任务", endedAt=time.time())
            log("就绪验证通过（不等于业务输出质量验收）")
        except Exception as exc:
            state.update(status="failed", message=str(exc)[:1500], endedAt=time.time())
            log("准备失败：" + str(exc))
        self._save(name, state)

    @staticmethod
    def _run(argv: list[str], cwd: Path, log: Any) -> None:
        log("执行：" + json.dumps(argv, ensure_ascii=False))
        env = {k: v for k, v in os.environ.items() if not re.search(r"(?i)(token|secret|password|api_?key)", k)
               and k not in {"PYTHONHOME", "PYTHONPATH", "_MEIPASS2", "_PYI_SPLASH_IPC", "NODE_OPTIONS"}
               and not k.upper().startswith(("PIP_", "NPM_CONFIG_"))}
        # 文件承接输出，不把冗长日志全部载入内存；最多保留 12KB 尾部。
        import tempfile
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                    stdout=output, stderr=subprocess.STDOUT, timeout=600,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            output.seek(0, 2)
            size = output.tell()
            output.seek(max(0, size - 12000))
            log(output.read().decode("utf-8", errors="replace"))
        if result.returncode:
            raise RuntimeError(f"命令执行失败，退出码 {result.returncode}；请查看安装日志")

    def interpreter(self, name: str) -> str:
        state = self._read(name)
        if state.get("status") != "verified" or state.get("digest") != self._digest(self._files(self._source(name))):
            return ""
        python = self.root / name / state["digest"][:24] / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        return str(python) if python.is_file() else ""

    def hint(self, name: str) -> str:
        """单独注入宿主环境提示，不修改第三方原始 Skill 文件。"""
        state = self._read(name)
        if state.get("status") != "verified":
            return ""
        try:
            if state.get("digest") != self._digest(self._files(self._source(name))):
                return ""
        except (ValueError, OSError):
            return ""
        folder = self.root / name / state["digest"][:24]
        python = folder / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        node = folder / "node"
        hints = [f"Skill {name} 在当前节点已准备独立依赖环境；这不代表未声明的系统依赖或人工安装步骤已完成。"]
        if python.exists():
            hints.append(f"执行此技能 Python 脚本时使用解释器绝对路径 {json.dumps(str(python))}，不要使用系统 Python。")
        if node.exists():
            hints.append(f"Node 技能使用完整运行副本 {json.dumps(str(node))} 中的脚本/资源；该目录已安装 node_modules，支持就近模块解析。不要改动运行副本，输出写到 Session 工作目录。")
        return "\n".join(hints)
