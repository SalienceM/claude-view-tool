"""AgentWithU 的全局候选构建与可视化发布内核。

发布中心与 Session 无关。构建脚本或 Workspace Kit 只把制品登记成候选；
正式发布必须先冻结计划，再由有权限的控制端显式触发。七牛上传继续使用
已经登录过的 qshell，避免把云账号密钥保存进 AgentWithU。
"""

from __future__ import annotations

import ast
import asyncio
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlparse, urlsplit, urlunsplit

import httpx

from . import paths


SCHEMA_VERSION = 1
MAX_CANDIDATES = 100
MAX_HISTORY = 200
MAX_JOBS = 50
DEFAULT_SCAN_ROOTS = ["src-tauri/target/release/bundle", "dist"]
CANDIDATE_STATUSES = {"candidate", "published", "discarded"}
UPLOAD_PROGRESS_INTERVAL = 0.5
PUBLISHED_MANIFEST_ATTEMPTS = 8


def _now() -> float:
    return time.time()


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    os.replace(temporary, path)


def _read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else dict(fallback)
    except Exception:
        return dict(fallback)


@contextmanager
def _process_file_lock(path: Path) -> Iterator[None]:
    """构建脚本与已运行 backend 可能同时登记候选，使用一个跨进程锁串行化。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = path.open("a+b")
    try:
        if os.name == "nt":
            import msvcrt

            stream.seek(0, os.SEEK_END)
            if stream.tell() == 0:
                stream.write(b"\0")
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            if os.name == "nt":
                import msvcrt

                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        finally:
            stream.close()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def canonical_payload(document: dict[str, Any]) -> bytes:
    unsigned = dict(document)
    unsigned.pop("signature", None)
    return json.dumps(
        unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")


def public_url(base_url: str, key: str) -> str:
    return f"{base_url.rstrip('/')}/{quote(key.strip('/'), safe='/._+-')}"


def _cache_busted_url(source: str) -> str:
    """Return a one-shot HTTP URL that cannot reuse an earlier manifest response."""
    parts = urlsplit(source)
    if parts.scheme not in {"http", "https"}:
        return source
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
             if key != "_awu_cache_bust"]
    query.append(("_awu_cache_bust", f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _qshell_progress_fraction(text: str) -> Optional[float]:
    """Extract the most recent percentage from qshell output when one is available."""
    matches = re.findall(r"(?<![\d.])(\d{1,3}(?:\.\d+)?)\s*%", text or "")
    if not matches:
        return None
    try:
        return max(0.0, min(1.0, float(matches[-1]) / 100.0))
    except ValueError:
        return None


def _process_read_bytes(pid: int) -> Optional[int]:
    """Best-effort byte counter for a qshell subprocess without adding a psutil dependency."""
    if pid <= 0:
        return None
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class _IoCounters(ctypes.Structure):
                _fields_ = [
                    ("ReadOperationCount", ctypes.c_ulonglong),
                    ("WriteOperationCount", ctypes.c_ulonglong),
                    ("OtherOperationCount", ctypes.c_ulonglong),
                    ("ReadTransferCount", ctypes.c_ulonglong),
                    ("WriteTransferCount", ctypes.c_ulonglong),
                    ("OtherTransferCount", ctypes.c_ulonglong),
                ]

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.GetProcessIoCounters.argtypes = [wintypes.HANDLE, ctypes.POINTER(_IoCounters)]
            kernel32.GetProcessIoCounters.restype = wintypes.BOOL
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return None
            try:
                counters = _IoCounters()
                if not kernel32.GetProcessIoCounters(handle, ctypes.byref(counters)):
                    return None
                return int(counters.ReadTransferCount)
            finally:
                kernel32.CloseHandle(handle)
        except (AttributeError, OSError, TypeError, ValueError):
            return None
    try:
        for line in Path(f"/proc/{int(pid)}/io").read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("rchar:"):
                return int(line.split(":", 1)[1].strip())
    except (OSError, TypeError, ValueError):
        pass
    return None


def _safe_id(value: object, fallback: str = "item") -> str:
    text = re.sub(r"[^A-Za-z0-9._-]", "-", str(value or "")).strip(".-")
    return text[:180] or fallback


def _safe_key(value: object, fallback: str = "") -> str:
    text = str(value or fallback).replace("\\", "/").strip("/ ")
    if not text or any(part in {"", ".", ".."} for part in text.split("/")):
        return ""
    return re.sub(r"[^A-Za-z0-9._+()/\-]", "_", text)[:800]


def _safe_file_name(value: object, fallback: str = "artifact.bin") -> str:
    name = Path(str(value or fallback).replace("\\", "/")).name
    name = re.sub(r"[^A-Za-z0-9._+()-]", "_", name).strip(". ")
    return name[:180] or fallback


def _default_project_root() -> Path:
    configured = str(os.environ.get("AGENT_WITH_U_RELEASE_PROJECT_ROOT") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    source_root = Path(__file__).resolve().parents[2]
    if (source_root / "src" / "_version.py").is_file():
        return source_root
    cwd = Path.cwd().resolve()
    return cwd


def _default_state() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "candidates": [],
        "history": [],
        "jobs": [],
        "updatedAt": _now(),
    }


def _default_config() -> dict[str, Any]:
    return {
        "projectRoot": str(_default_project_root()),
        "scanRoots": list(DEFAULT_SCAN_ROOTS),
        "channel": "stable",
        "baseUrl": "",
        "qiniuBucket": "",
        "prefix": "agentwithu/releases",
        "manifestKey": "agentwithu/releases/stable/manifest.json",
        "stableManifestUrl": "",
        "qshell": "qshell",
        "requireSignature": False,
        # 0 = 不自动清理。启用后只清理由本发布中心记录过 objectKeys 的旧版本。
        "retentionCount": 0,
    }


def _read_version_file(project_root: Path) -> tuple[dict[str, Any], Optional[Path]]:
    version_path = project_root / "src" / "_version.py"
    values: dict[str, Any] = {}
    if version_path.is_file():
        try:
            tree = ast.parse(version_path.read_text(encoding="utf-8-sig"))
            for node in tree.body:
                if not isinstance(node, ast.Assign) or len(node.targets) != 1:
                    continue
                target = node.targets[0]
                if isinstance(target, ast.Name) and target.id.startswith("__"):
                    try:
                        values[target.id] = ast.literal_eval(node.value)
                    except Exception:
                        continue
        except Exception:
            values = {}
    display = str(values.get("__display_version__") or values.get("__version__") or "").strip()
    package = str(values.get("__package_version__") or display or "0.0.0-dev").strip()
    build_id = str(values.get("__build_id__") or "").strip()
    try:
        sequence = int(values.get("__build_sequence__") or 0)
    except (TypeError, ValueError):
        sequence = 0
    return {
        "version": display or package,
        "packageVersion": package,
        "buildId": build_id,
        "sequence": sequence,
        "commit": str(values.get("__commit__") or "").strip(),
    }, version_path if version_path.is_file() else None


def _git_info(project_root: Path) -> dict[str, Any]:
    result = {"commit": "", "branch": "", "dirty": False, "dirtyFiles": 0}
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"], cwd=project_root,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=8, check=True,
        ).stdout.strip()
        branch = subprocess.run(
            ["git", "branch", "--show-current"], cwd=project_root,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=8, check=False,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain"], cwd=project_root,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=12, check=False,
        ).stdout.splitlines()
        result.update({
            "commit": commit,
            "branch": branch,
            "dirty": bool(status),
            "dirtyFiles": len(status),
        })
    except Exception:
        pass
    return result


def _infer_arch(name: str) -> str:
    lowered = name.lower().replace("-", "_")
    if any(token in lowered for token in ("aarch64", "arm64")):
        return "aarch64"
    if any(token in lowered for token in ("x86_64", "x64", "amd64")):
        return "x86_64"
    return "any"


def _classify_artifact(path: Path) -> Optional[dict[str, str]]:
    name = path.name
    lowered = name.lower()
    suffix = path.suffix.lower()
    if (
        (lowered.endswith(".tar") or lowered.endswith(".tar.gz"))
        and ("agent-with-u-docker" in lowered or "agentwithu-docker" in lowered)
    ):
        return {
            "platform": "linux", "arch": _infer_arch(name),
            "target": "docker", "kind": "docker-bundle",
        }
    if lowered.endswith(".tar.gz") and ("agent-with-u" in lowered or "agentwithu" in lowered):
        return {"platform": "linux", "arch": _infer_arch(name), "target": "executor", "kind": "custom"}
    if suffix in {".appimage", ".deb", ".rpm"}:
        kind = suffix[1:]
        return {"platform": "linux", "arch": _infer_arch(name), "target": "desktop", "kind": kind}
    if suffix in {".dmg", ".pkg"}:
        return {"platform": "macos", "arch": _infer_arch(name), "target": "desktop", "kind": suffix[1:]}
    if suffix == ".msi" and "agentwithu" in lowered.replace("-", "").replace("_", ""):
        return {"platform": "windows", "arch": _infer_arch(name), "target": "desktop", "kind": "msi"}
    if suffix == ".exe":
        compact = lowered.replace("-", "").replace("_", "")
        if "agentwithubackend" in compact:
            return None
        if "agentwithu" in compact and any(token in lowered for token in ("setup", "installer")):
            return {"platform": "windows", "arch": _infer_arch(name), "target": "desktop", "kind": "nsis"}
    if suffix == ".zip" and ("agent-with-u" in lowered or "agentwithu" in lowered):
        return {"platform": "any", "arch": _infer_arch(name), "target": "executor", "kind": "custom"}
    return None


def _artifact_from_path(
    path: Path,
    project_root: Path,
    *,
    stamped_at: float = 0,
    metadata: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    inferred = _classify_artifact(path)
    if inferred is None and not metadata:
        return None
    if not path.is_file():
        return None
    info = dict(inferred or {
        "platform": "any", "arch": "any", "target": "executor", "kind": "custom",
    })
    allowed = {"platform", "arch", "target", "kind", "install", "key"}
    for key, value in (metadata or {}).items():
        if key in allowed:
            info[key] = value
    resolved = path.resolve()
    try:
        relative = resolved.relative_to(project_root).as_posix()
    except ValueError:
        relative = resolved.name
    stat = resolved.stat()
    semantic_id = "-".join(str(info.get(key) or "any") for key in (
        "platform", "arch", "target", "kind",
    ))
    artifact_id = _safe_id(
        f"{semantic_id}-{hashlib.sha1(relative.encode('utf-8')).hexdigest()[:10]}",
        "artifact",
    )
    payload: dict[str, Any] = {
        "id": artifact_id,
        "path": str(resolved),
        "relativePath": relative,
        "fileName": resolved.name,
        "platform": str(info.get("platform") or "any"),
        "arch": str(info.get("arch") or "any"),
        "target": str(info.get("target") or "executor"),
        "kind": str(info.get("kind") or "custom"),
        "size": stat.st_size,
        "sha256": sha256_file(resolved),
        "modifiedAt": stat.st_mtime,
        "fresh": not stamped_at or stat.st_mtime + 120 >= stamped_at,
    }
    if isinstance(info.get("install"), dict):
        payload["install"] = dict(info["install"])
    if info.get("key"):
        payload["key"] = _safe_key(info["key"])
    return payload


class ReleaseCenterError(RuntimeError):
    pass


class ReleaseCenterManager:
    """Global, node-local release inventory and asynchronous publisher."""

    def __init__(self, root: Optional[Path] = None):
        self.root = (root or paths.sub("release-center")).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_path = self.root / "state.json"
        self.config_path = self.root / "config.json"
        self.lock_path = self.root / ".state.lock"
        self.plans_dir = self.root / "plans"
        self.generated_dir = self.root / "generated"
        # 使用 qshell 官方的 local workspace 模式，避免 Windows 服务、sidecar 或
        # Relay executor 无法通过 os/user 解析桌面登录用户（can't get current user）。
        self.qshell_workspace = self.root / "qshell-workspace"
        self.qshell_workspace.mkdir(parents=True, exist_ok=True)
        self._thread_lock = threading.RLock()
        self._tasks: dict[str, asyncio.Task] = {}
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._job_account_modes: dict[str, str] = {}
        self._upload_progress_marks: dict[str, tuple[float, int, int]] = {}
        self._cancel_requested: set[str] = set()
        # qshell `account` 会把 AccessKey/SecretKey 打到 stdout，状态探测必须只保留
        # 布尔结果，绝不能把命令输出带进 RPC、发布日志或持久化文件。
        self._account_status_cache: dict[str, Any] = {}
        self._reconcile_jobs()

    @contextmanager
    def _guard(self) -> Iterator[None]:
        with self._thread_lock:
            with _process_file_lock(self.lock_path):
                yield

    def _load_state(self) -> dict[str, Any]:
        state = _read_json(self.state_path, _default_state())
        state.setdefault("schemaVersion", SCHEMA_VERSION)
        state.setdefault("candidates", [])
        state.setdefault("history", [])
        state.setdefault("jobs", [])
        return state

    def _save_state(self, state: dict[str, Any]) -> None:
        state["schemaVersion"] = SCHEMA_VERSION
        state["candidates"] = list(state.get("candidates") or [])[:MAX_CANDIDATES]
        state["history"] = list(state.get("history") or [])[:MAX_HISTORY]
        state["jobs"] = list(state.get("jobs") or [])[:MAX_JOBS]
        state["updatedAt"] = _now()
        _atomic_json(self.state_path, state)

    def _config(self) -> dict[str, Any]:
        return {**_default_config(), **_read_json(self.config_path, {})}

    def _reconcile_jobs(self) -> None:
        with self._guard():
            state = self._load_state()
            changed = False
            for job in state["jobs"]:
                if job.get("status") in {"queued", "running"}:
                    job.update({
                        "status": "interrupted",
                        "message": "发布进程重启，任务已中断；stable 指针未确认切换",
                        "endedAt": _now(),
                    })
                    changed = True
            if changed:
                self._save_state(state)

    @staticmethod
    def _resolve_qshell(config: dict[str, Any]) -> str:
        configured = str(config.get("qshell") or "qshell").strip()
        if Path(configured).expanduser().is_file():
            return str(Path(configured).expanduser().resolve())
        return str(shutil.which(configured) or "")

    def _run_qshell_account(
        self, qshell: str, args: list[str], timeout: float = 15, *, local: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        kwargs: dict[str, Any] = {
            "capture_output": True,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "timeout": timeout,
            "check": False,
            "env": os.environ.copy(),
        }
        command = [qshell]
        if local:
            command.append("-L")
            kwargs["cwd"] = str(self.qshell_workspace)
        command.extend(["account", *args])
        if os.name == "nt":
            kwargs["creationflags"] = 0x08000000
        return subprocess.run(command, **kwargs)

    @staticmethod
    def _safe_qshell_error(
        stdout: str, stderr: str, secrets: Iterable[str] = (),
    ) -> str:
        text = str(stderr or stdout or "")
        for value in secrets:
            token = str(value or "")
            if token:
                text = text.replace(token, "***")
        text = re.sub(
            r"(?i)\b(AccessKey|SecretKey)\s*[:=]\s*[^\s\r\n]+",
            r"\1: ***",
            text,
        )
        text = "".join(char for char in text if char in "\r\n\t" or ord(char) >= 32).strip()
        return text[-1_000:]

    def qiniu_account_status(
        self, config: Optional[dict[str, Any]] = None, *, force: bool = False,
    ) -> dict[str, Any]:
        """验证当前 backend 系统用户的 qshell 账号，但不回显 qshell 输出。"""
        resolved_config = config or self._config()
        qshell = self._resolve_qshell(resolved_config)
        if not qshell:
            return {
                "configured": False,
                "message": "尚未找到 qshell",
                "checkedAt": _now(),
            }
        now = _now()
        with self._thread_lock:
            cached = dict(self._account_status_cache)
        if (
            not force
            and cached.get("qshell") == qshell
            and now - float(cached.get("checkedAt") or 0) < 15
        ):
            return dict(cached.get("value") or {})
        try:
            # 新配置始终使用发布工作台专用目录；再检查旧的系统用户账号以兼容
            # 已经在终端执行过 `qshell account` 的发布节点。
            local_result = self._run_qshell_account(qshell, [], local=True)
            if local_result.returncode == 0:
                value = {
                    "configured": True,
                    "mode": "workspace",
                    "message": "发布工作台专用七牛账号已配置",
                    "checkedAt": now,
                }
            else:
                user_result = self._run_qshell_account(qshell, [], local=False)
                configured = user_result.returncode == 0
                value = {
                    "configured": configured,
                    "mode": "user" if configured else "",
                    "message": (
                        "系统用户的 qshell 七牛账号已配置"
                        if configured
                        else "当前发布节点尚未配置七牛账号"
                    ),
                    "checkedAt": now,
                }
        except (OSError, subprocess.SubprocessError):
            value = {
                "configured": False,
                "mode": "",
                "message": "无法检查当前执行用户的七牛账号",
                "checkedAt": now,
            }
        with self._thread_lock:
            self._account_status_cache = {"qshell": qshell, "checkedAt": now, "value": value}
        return dict(value)

    def configure_qiniu_account(
        self, access_key: str, secret_key: str, account_name: str = "agentwithu-release",
    ) -> dict[str, Any]:
        """把凭据一次性交给 qshell；AgentWithU 自身不保存或回显密钥。"""
        access = str(access_key or "").strip()
        secret = str(secret_key or "").strip()
        name = str(account_name or "agentwithu-release").strip() or "agentwithu-release"
        if not access or not secret:
            raise ReleaseCenterError("AccessKey 和 SecretKey 都必须填写")
        if len(access) > 512 or len(secret) > 512 or any(char.isspace() for char in access + secret):
            raise ReleaseCenterError("AccessKey 或 SecretKey 格式无效")
        if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,80}", name):
            raise ReleaseCenterError("账号别名只能包含字母、数字、点、下划线、@ 和连字符")
        config = self._config()
        qshell = self._resolve_qshell(config)
        if not qshell:
            raise ReleaseCenterError("尚未找到 qshell；请先保存正确的命令或绝对路径")
        try:
            result = self._run_qshell_account(
                # 七牛密钥可能以 '-' 开头；`--` 必须放在凭据之前，避免 Cobra
                # 把例如 -W... 的 SecretKey 当成 qshell 短参数。
                qshell, ["--overwrite", "--", access, secret, name], timeout=30, local=True,
            )
        except subprocess.TimeoutExpired as error:
            raise ReleaseCenterError("qshell 配置七牛账号超时") from error
        except OSError as error:
            raise ReleaseCenterError("无法启动 qshell 配置七牛账号") from error
        if result.returncode != 0:
            detail = self._safe_qshell_error(
                result.stdout, result.stderr, (access, secret),
            )
            raise ReleaseCenterError(
                "qshell 未能保存七牛账号"
                + (f"：{detail}" if detail else "，请核对当前节点目录权限")
            )
        with self._thread_lock:
            self._account_status_cache = {}
        status = self.qiniu_account_status(config, force=True)
        if not status.get("configured") or status.get("mode") != "workspace":
            raise ReleaseCenterError("qshell 已执行账号配置，但当前执行用户仍无法读取该账号")
        return {
            "status": "ok",
            "configured": True,
            "accountName": name,
            "message": "七牛账号已保存到当前节点的发布工作台专用 qshell 空间；密钥未写入普通配置",
        }

    def approval_config_fingerprint(self) -> str:
        """委托确认绑定发布配置，配置变化必须重新授权；不探测网络/账号。"""
        return hashlib.sha256(canonical_payload(self._config())).hexdigest()

    def public_config(self) -> dict[str, Any]:
        config = self._config()
        qshell = self._resolve_qshell(config)
        account = self.qiniu_account_status(config) if qshell else {
            "configured": False, "message": "尚未找到 qshell",
        }
        return {
            **config,
            "qshellAvailable": bool(qshell),
            "qiniuAccountConfigured": bool(account.get("configured")),
            "qiniuAccountMessage": str(account.get("message") or ""),
            "signingKeyConfigured": bool(os.environ.get("AGENT_WITH_U_UPDATE_SIGNING_KEY")),
            "dataRoot": str(self.root),
        }

    def configure(self, patch: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise ReleaseCenterError("发布配置必须是对象")
        with self._guard():
            current = self._config()
            if "projectRoot" in patch:
                value = Path(str(patch.get("projectRoot") or "")).expanduser()
                if not value.is_absolute():
                    value = (Path.cwd() / value).resolve()
                if not value.is_dir():
                    raise ReleaseCenterError(f"项目目录不存在：{value}")
                current["projectRoot"] = str(value.resolve())
            if "scanRoots" in patch:
                roots = patch.get("scanRoots")
                if not isinstance(roots, list):
                    raise ReleaseCenterError("scanRoots 必须是数组")
                cleaned = [str(item).strip() for item in roots if str(item).strip()][:30]
                current["scanRoots"] = cleaned or list(DEFAULT_SCAN_ROOTS)
            for field in ("channel", "qiniuBucket", "prefix", "manifestKey", "qshell"):
                if field in patch:
                    current[field] = str(patch.get(field) or "").strip()
                    if field == "qshell":
                        self._account_status_cache = {}
            for field in ("baseUrl", "stableManifestUrl"):
                if field not in patch:
                    continue
                value = str(patch.get(field) or "").strip()
                if value and field == "baseUrl" and not value.startswith(("https://", "http://")):
                    raise ReleaseCenterError("baseUrl 必须是 HTTP(S) CDN 地址")
                if value and field == "stableManifestUrl":
                    parsed = urlparse(value)
                    if not (value.startswith(("https://", "http://")) or Path(value).expanduser().is_absolute() or parsed.scheme == "file"):
                        raise ReleaseCenterError("stableManifestUrl 必须是 HTTP(S)、file URL 或绝对路径")
                current[field] = value
            if "requireSignature" in patch:
                current["requireSignature"] = bool(patch.get("requireSignature"))
            if "retentionCount" in patch:
                try:
                    retention_count = int(patch.get("retentionCount") or 0)
                except (TypeError, ValueError) as error:
                    raise ReleaseCenterError("版本保留数量必须是 0 到 100 的整数") from error
                if retention_count < 0 or retention_count > 100:
                    raise ReleaseCenterError("版本保留数量必须在 0 到 100 之间；0 表示不自动清理")
                current["retentionCount"] = retention_count
            current["channel"] = _safe_id(current.get("channel"), "stable")[:40]
            current["prefix"] = _safe_key(current.get("prefix"), "agentwithu/releases") or "agentwithu/releases"
            current["manifestKey"] = _safe_key(
                current.get("manifestKey"), f"{current['prefix']}/{current['channel']}/manifest.json",
            ) or f"{current['prefix']}/{current['channel']}/manifest.json"
            _atomic_json(self.config_path, current)
        return self.public_config()

    def status(self) -> dict[str, Any]:
        with self._guard():
            state = self._load_state()
        active = next(
            (job for job in state["jobs"] if job.get("status") in {"queued", "running"}), None,
        )
        return {
            "status": "ok",
            "config": self.public_config(),
            "candidates": state["candidates"],
            "history": state["history"],
            "jobs": state["jobs"],
            "activeJob": active,
        }

    def _discover_artifacts(
        self, project_root: Path, scan_roots: Iterable[str], stamped_at: float,
    ) -> list[dict[str, Any]]:
        paths_seen: set[str] = set()
        result: list[dict[str, Any]] = []
        for raw_root in scan_roots:
            scan_root = Path(str(raw_root)).expanduser()
            if not scan_root.is_absolute():
                scan_root = project_root / scan_root
            if not scan_root.is_dir():
                continue
            for candidate in scan_root.rglob("*"):
                if len(result) >= 300:
                    break
                if not candidate.is_file() or _classify_artifact(candidate) is None:
                    continue
                resolved = str(candidate.resolve()).lower() if os.name == "nt" else str(candidate.resolve())
                if resolved in paths_seen:
                    continue
                paths_seen.add(resolved)
                artifact = _artifact_from_path(
                    candidate, project_root, stamped_at=stamped_at,
                )
                if artifact:
                    result.append(artifact)
        result.sort(key=lambda item: (-float(item.get("modifiedAt") or 0), item["fileName"]))
        return result

    @staticmethod
    def _candidate_from_artifacts(
        project_root: Path,
        artifacts: list[dict[str, Any]],
        version: dict[str, Any],
        git: dict[str, Any],
        source: str,
    ) -> dict[str, Any]:
        newest = max((float(item.get("modifiedAt") or 0) for item in artifacts), default=_now())
        commit = str(version.get("commit") or git.get("commit") or "")
        build_id = str(version.get("buildId") or "").strip()
        if not build_id:
            build_id = datetime.fromtimestamp(newest).strftime("%Y%m%d%H%M%S")
            if commit:
                build_id += f"-{commit[:12]}"
        try:
            sequence = int(version.get("sequence") or 0)
        except (TypeError, ValueError):
            sequence = 0
        if not sequence:
            match = re.search(r"(?<!\d)(\d{14})(?!\d)", build_id)
            sequence = int(match.group(1)) if match else int(newest)
        return {
            "id": _safe_id(build_id, str(uuid.uuid4())),
            "status": "candidate",
            "version": str(version.get("version") or version.get("packageVersion") or "0.0.0-dev"),
            "packageVersion": str(version.get("packageVersion") or version.get("version") or "0.0.0-dev"),
            "buildId": build_id,
            "sequence": sequence,
            "commit": commit,
            "branch": str(git.get("branch") or ""),
            "dirty": bool(git.get("dirty")),
            "dirtyFiles": int(git.get("dirtyFiles") or 0),
            "projectRoot": str(project_root),
            "source": str(source or "manual")[:200],
            "artifacts": artifacts,
            "createdAt": newest,
            "updatedAt": _now(),
        }

    def _upsert_candidate(self, candidate: dict[str, Any]) -> dict[str, Any]:
        with self._guard():
            state = self._load_state()
            existing = next(
                (item for item in state["candidates"] if item.get("id") == candidate["id"]), None,
            )
            if existing and existing.get("status") == "published":
                return existing
            if existing:
                by_path = {
                    str(item.get("path") or ""): item
                    for item in existing.get("artifacts") or []
                    if Path(str(item.get("path") or "")).is_file()
                }
                by_path.update({str(item.get("path") or ""): item for item in candidate["artifacts"]})
                candidate["artifacts"] = sorted(
                    by_path.values(), key=lambda item: (-float(item.get("modifiedAt") or 0), str(item.get("fileName") or "")),
                )
                candidate["createdAt"] = float(existing.get("createdAt") or candidate["createdAt"])
            state["candidates"] = [
                candidate, *[item for item in state["candidates"] if item.get("id") != candidate["id"]],
            ]
            self._save_state(state)
        return candidate

    def scan_project(self, project_root: str = "", source: str = "manual") -> dict[str, Any]:
        config = self._config()
        root = Path(project_root or config.get("projectRoot") or _default_project_root()).expanduser().resolve()
        if not root.is_dir():
            raise ReleaseCenterError(f"项目目录不存在：{root}")
        version, version_path = _read_version_file(root)
        stamped_at = version_path.stat().st_mtime if version_path else 0
        artifacts = self._discover_artifacts(root, config.get("scanRoots") or DEFAULT_SCAN_ROOTS, stamped_at)
        if not artifacts:
            raise ReleaseCenterError("没有发现可发布制品；请先完成打包，或调整扫描目录")
        candidate = self._candidate_from_artifacts(root, artifacts, version, _git_info(root), source)
        return {"status": "ok", "candidate": self._upsert_candidate(candidate)}

    def register_paths(
        self,
        project_root: str | Path,
        artifact_paths: Iterable[str | Path],
        *,
        metadata_by_path: Optional[dict[str, dict[str, Any]]] = None,
        source: str = "workspace-kit",
    ) -> dict[str, Any]:
        root = Path(project_root).expanduser().resolve()
        version, version_path = _read_version_file(root)
        stamped_at = version_path.stat().st_mtime if version_path else 0
        artifacts: list[dict[str, Any]] = []
        for value in artifact_paths:
            path = Path(value).expanduser().resolve()
            metadata = (metadata_by_path or {}).get(str(path))
            artifact = _artifact_from_path(
                path, root, stamped_at=stamped_at, metadata=metadata,
            )
            if artifact:
                artifacts.append(artifact)
        if not artifacts:
            raise ReleaseCenterError("登记请求中没有有效文件")
        candidate = self._candidate_from_artifacts(root, artifacts, version, _git_info(root), source)
        return {"status": "ok", "candidate": self._upsert_candidate(candidate)}

    def update_artifact(self, candidate_id: str, artifact_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        allowed = {"platform", "arch", "target", "kind", "install", "key"}
        with self._guard():
            state = self._load_state()
            candidate = next((item for item in state["candidates"] if item.get("id") == candidate_id), None)
            if not candidate:
                raise ReleaseCenterError("候选构建不存在")
            if candidate.get("status") == "published":
                raise ReleaseCenterError("已发布候选不可修改")
            artifact = next((item for item in candidate.get("artifacts") or [] if item.get("id") == artifact_id), None)
            if not artifact:
                raise ReleaseCenterError("候选制品不存在")
            for key, value in patch.items():
                if key not in allowed:
                    continue
                if key == "install":
                    if value in (None, ""):
                        artifact.pop("install", None)
                    elif isinstance(value, dict):
                        artifact["install"] = value
                    else:
                        raise ReleaseCenterError("install 必须是 JSON 对象")
                elif key == "key":
                    if value:
                        cleaned = _safe_key(value)
                        if not cleaned:
                            raise ReleaseCenterError("对象存储 key 无效")
                        artifact["key"] = cleaned
                    else:
                        artifact.pop("key", None)
                else:
                    artifact[key] = str(value or "")[:200]
            candidate["updatedAt"] = _now()
            self._save_state(state)
            return {"status": "ok", "candidate": candidate}

    def discard_candidate(self, candidate_id: str) -> dict[str, Any]:
        with self._guard():
            state = self._load_state()
            candidate = next((item for item in state["candidates"] if item.get("id") == candidate_id), None)
            if not candidate:
                raise ReleaseCenterError("候选构建不存在")
            if candidate.get("status") == "published":
                raise ReleaseCenterError("已发布记录不能废弃")
            candidate["status"] = "discarded"
            candidate["updatedAt"] = _now()
            self._save_state(state)
            return {"status": "ok", "candidate": candidate}

    def _candidate(self, candidate_id: str) -> dict[str, Any]:
        with self._guard():
            state = self._load_state()
        candidate = next((item for item in state["candidates"] if item.get("id") == candidate_id), None)
        if not candidate:
            raise ReleaseCenterError("候选构建不存在")
        return json.loads(json.dumps(candidate, ensure_ascii=False))

    async def _fetch_manifest(self, source: str) -> Optional[dict[str, Any]]:
        if not source:
            return None
        parsed = urlparse(source)
        try:
            if parsed.scheme in {"https", "http"}:
                async with httpx.AsyncClient(
                    follow_redirects=True, timeout=httpx.Timeout(20, read=30),
                ) as client:
                    response = await client.get(
                        _cache_busted_url(source),
                        headers={
                            "Cache-Control": "no-cache, no-store, max-age=0",
                            "Pragma": "no-cache",
                        },
                    )
                    response.raise_for_status()
                    if len(response.content) > 4 * 1024 * 1024:
                        raise ReleaseCenterError("稳定版 manifest 过大")
                    value = response.json()
            else:
                path = Path(unquote(parsed.path)) if parsed.scheme == "file" else Path(source).expanduser()
                if os.name == "nt" and parsed.scheme == "file" and parsed.netloc:
                    path = Path(f"//{parsed.netloc}{unquote(parsed.path)}")
                value = json.loads(path.read_text(encoding="utf-8-sig"))
            return value if isinstance(value, dict) else None
        except Exception as error:
            raise ReleaseCenterError(f"无法读取当前稳定版：{error}") from error

    @staticmethod
    def _stable_comparison(
        manifest: Optional[dict[str, Any]], candidate: dict[str, Any], artifacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        release = dict((manifest or {}).get("release") or {})
        previous_artifacts = [item for item in (manifest or {}).get("artifacts") or [] if isinstance(item, dict)]
        comparisons: list[dict[str, Any]] = []
        for item in artifacts:
            exact = next((old for old in previous_artifacts if str(old.get("id")) == str(item.get("id"))), None)
            previous = exact or next((old for old in previous_artifacts if all(
                str(old.get(field) or "") == str(item.get(field) or "")
                for field in ("platform", "arch", "target", "kind")
            )), None)
            old_size = int((previous or {}).get("size") or 0)
            comparisons.append({
                "artifactId": item.get("id"),
                "previousId": (previous or {}).get("id", ""),
                "previousSize": old_size,
                "sizeDelta": int(item.get("size") or 0) - old_size if previous else None,
                "hashChanged": bool(previous) and str(previous.get("sha256") or "") != str(item.get("sha256") or ""),
                "isNew": previous is None,
            })
        return {
            "available": bool(manifest),
            "release": release,
            "versionChanged": bool(release) and str(release.get("version") or "") != str(candidate.get("version") or ""),
            "commitChanged": bool(release) and str(release.get("commit") or "") != str(candidate.get("commit") or ""),
            "artifacts": comparisons,
        }

    async def preview(
        self, candidate_id: str, artifact_ids: list[str], options: dict[str, Any],
    ) -> dict[str, Any]:
        candidate = self._candidate(candidate_id)
        config = {**self._config(), **{key: value for key, value in (options or {}).items() if key in {
            "channel", "baseUrl", "qiniuBucket", "prefix", "manifestKey",
            "stableManifestUrl", "requireSignature", "retentionCount",
        }}}
        channel = _safe_id(config.get("channel"), "stable")[:40]
        prefix = _safe_key(config.get("prefix"), "agentwithu/releases") or "agentwithu/releases"
        manifest_key = _safe_key(
            config.get("manifestKey"), f"{prefix}/{channel}/manifest.json",
        ) or f"{prefix}/{channel}/manifest.json"
        base_url = str(config.get("baseUrl") or "").strip()
        bucket = str(config.get("qiniuBucket") or "").strip()
        selected = [
            item for item in candidate.get("artifacts") or [] if str(item.get("id")) in set(artifact_ids)
        ]
        blockers: list[str] = []
        warnings: list[str] = []
        if candidate.get("status") != "candidate":
            blockers.append("只有待发布候选可以生成正式发布计划")
        if not selected:
            blockers.append("至少选择一个制品")
        if not base_url.startswith(("https://", "http://")):
            blockers.append("请配置七牛/CDN 的 HTTP(S) baseUrl")
        if not bucket:
            blockers.append("请配置七牛 Bucket")
        qshell = self._resolve_qshell(config)
        if not qshell:
            blockers.append("没有找到 qshell；请先安装并登录，或填写其绝对路径")
        else:
            account = await asyncio.to_thread(
                self.qiniu_account_status, config, force=True,
            )
            if not account.get("configured"):
                blockers.append("qshell 尚未配置七牛账号；请在发布配置中填写 AccessKey 和 SecretKey")
        signing_key = os.environ.get("AGENT_WITH_U_UPDATE_SIGNING_KEY", "")
        if bool(config.get("requireSignature")) and not signing_key:
            blockers.append("已要求签名，但发布端没有 AGENT_WITH_U_UPDATE_SIGNING_KEY")
        elif not signing_key:
            warnings.append("发布清单将不带 HMAC 签名")
        if candidate.get("dirty"):
            warnings.append(f"构建时工作区存在 {candidate.get('dirtyFiles') or 0} 个未提交改动")
        retention_count = max(0, min(100, int(config.get("retentionCount") or 0)))
        if retention_count > 0:
            warnings.append(
                f"发布成功并从公网确认新清单后，将自动保留此存储范围最近 {retention_count} 个版本；"
                "只删除发布中心已登记的七牛对象，不删除本地安装包"
            )

        immutable_prefix = f"{prefix}/{_safe_id(candidate.get('buildId'), candidate_id)}"
        manifest_artifacts: list[dict[str, Any]] = []
        upload_jobs: list[dict[str, Any]] = []
        upload_keys: set[str] = set()
        for item in selected:
            path = Path(str(item.get("path") or "")).expanduser()
            if not path.is_file():
                blockers.append(f"制品已不存在：{path}")
                continue
            stat = path.stat()
            digest = await asyncio.to_thread(sha256_file, path)
            if stat.st_size != int(item.get("size") or 0) or digest != str(item.get("sha256") or ""):
                blockers.append(f"制品在登记后发生变化，请重新扫描：{path.name}")
                continue
            if item.get("fresh") is False:
                warnings.append(f"{path.name} 的修改时间早于本次版本戳，请确认不是旧包")
            kind = str(item.get("kind") or "custom").lower()
            platform = str(item.get("platform") or "any").lower()
            if (
                platform != "windows"
                and kind not in {"shell", "sh", "docker-bundle"}
                and not isinstance(item.get("install"), dict)
            ):
                blockers.append(f"{path.name} 是 {platform}/{kind}，必须先配置明确的 install JSON")
            key = _safe_key(item.get("key")) or f"{immutable_prefix}/{_safe_file_name(path.name)}"
            if key in upload_keys:
                blockers.append(f"多个制品会上传到同一对象 key：{key}")
            upload_keys.add(key)
            output_item: dict[str, Any] = {
                "id": str(item.get("id") or ""),
                "platform": str(item.get("platform") or "any"),
                "arch": str(item.get("arch") or "any"),
                "target": str(item.get("target") or "executor"),
                "kind": kind,
                "fileName": _safe_file_name(item.get("fileName") or path.name),
                "url": public_url(base_url, key) if base_url else "",
                "size": stat.st_size,
                "sha256": digest,
            }
            if isinstance(item.get("install"), dict):
                output_item["install"] = item["install"]
            manifest_artifacts.append(output_item)
            upload_jobs.append({"key": key, "path": str(path), "sha256": digest, "size": stat.st_size})

        target_groups: dict[tuple[str, str, str], list[str]] = {}
        for item in manifest_artifacts:
            group = (
                str(item.get("platform") or "any"), str(item.get("arch") or "any"),
                str(item.get("target") or "executor"),
            )
            target_groups.setdefault(group, []).append(str(item.get("fileName") or item.get("id") or ""))
        for group, names in target_groups.items():
            if len(names) > 1:
                warnings.append(
                    f"{group[0]}/{group[1]}/{group[2]} 同时选择了 {len(names)} 个制品；自动更新会按 artifact id 只选择其中一个，建议只保留期望的安装格式",
                )

        stable_url = str(config.get("stableManifestUrl") or "").strip()
        if not stable_url and base_url:
            stable_url = public_url(base_url, manifest_key)
        stable_manifest: Optional[dict[str, Any]] = None
        if stable_url:
            try:
                stable_manifest = await self._fetch_manifest(stable_url)
            except ReleaseCenterError as error:
                warnings.append(str(error))
        comparison = self._stable_comparison(stable_manifest, candidate, manifest_artifacts)
        stable_release = comparison.get("release") or {}
        try:
            stable_sequence = int(stable_release.get("sequence") or 0)
            candidate_sequence = int(candidate.get("sequence") or 0)
            if stable_sequence and candidate_sequence <= stable_sequence:
                blockers.append(
                    f"候选序号 {candidate_sequence} 不高于当前 {channel} 的 {stable_sequence}；客户端不会把它识别为更新",
                )
        except (TypeError, ValueError):
            pass

        manifest: dict[str, Any] = {
            "schemaVersion": 1,
            "channel": channel,
            "release": {
                "version": str(candidate.get("version") or "0.0.0-dev"),
                "packageVersion": str(candidate.get("packageVersion") or candidate.get("version") or "0.0.0-dev"),
                "buildId": str(candidate.get("buildId") or candidate_id),
                "sequence": int(candidate.get("sequence") or 0),
                "commit": str(candidate.get("commit") or ""),
                "publishedAt": datetime.now(timezone.utc).isoformat(),
                "notes": str((options or {}).get("notes") or "")[:40_000],
            },
            "artifacts": manifest_artifacts,
        }
        plan_id = str(uuid.uuid4())
        versioned_manifest_key = f"{immutable_prefix}/manifest.json"
        plan = {
            "id": plan_id,
            "status": "ready" if not blockers else "blocked",
            "candidateId": candidate_id,
            "candidate": {
                key: candidate.get(key) for key in (
                    "version", "packageVersion", "buildId", "sequence", "commit", "branch", "dirty",
                )
            },
            "channel": channel,
            "baseUrl": base_url,
            "qiniuBucket": bucket,
            "manifestKey": manifest_key,
            "versionedManifestKey": versioned_manifest_key,
            "manifestUrl": public_url(base_url, manifest_key) if base_url else "",
            "uploadJobs": upload_jobs,
            "manifest": manifest,
            "blockers": blockers,
            "warnings": warnings,
            "comparison": comparison,
            "signatureConfigured": bool(signing_key),
            "requireSignature": bool(config.get("requireSignature")),
            "retentionCount": retention_count,
            "createdAt": _now(),
        }
        fingerprint_source = dict(plan)
        fingerprint_source.pop("id", None)
        plan["fingerprint"] = hashlib.sha256(canonical_payload(fingerprint_source)).hexdigest()
        self.plans_dir.mkdir(parents=True, exist_ok=True)
        _atomic_json(self.plans_dir / f"{plan_id}.json", plan)
        return {"status": "ok" if not blockers else "blocked", "plan": plan}

    def _plan(self, plan_id: str) -> dict[str, Any]:
        safe = _safe_id(plan_id)
        path = self.plans_dir / f"{safe}.json"
        value = _read_json(path, {})
        if not value or value.get("id") != plan_id:
            raise ReleaseCenterError("冻结发布计划不存在或已失效")
        return value

    def _update_job(self, job_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._guard():
            state = self._load_state()
            job = next((item for item in state["jobs"] if item.get("id") == job_id), None)
            if not job:
                raise ReleaseCenterError("发布任务不存在")
            job.update(patch)
            job["updatedAt"] = _now()
            self._save_state(state)
            return dict(job)

    async def start_publish(self, plan_id: str) -> dict[str, Any]:
        plan = self._plan(plan_id)
        if plan.get("status") != "ready" or plan.get("blockers"):
            raise ReleaseCenterError("发布计划仍有阻断项，请重新预检")
        candidate = self._candidate(str(plan.get("candidateId") or ""))
        if candidate.get("status") != "candidate":
            raise ReleaseCenterError("候选状态已经变化，请重新选择并预检；旧计划不能重复发布")
        account = await asyncio.to_thread(
            self.qiniu_account_status, self._config(), force=True,
        )
        if not account.get("configured"):
            raise ReleaseCenterError("当前执行节点的 qshell 七牛账号不可用，请重新配置并预检")
        with self._guard():
            state = self._load_state()
            if any(job.get("status") in {"queued", "running"} for job in state["jobs"]):
                raise ReleaseCenterError("已有正式发布任务正在执行")
            job_id = str(uuid.uuid4())
            job = {
                "id": job_id,
                "planId": plan_id,
                "candidateId": plan.get("candidateId"),
                "buildId": (plan.get("candidate") or {}).get("buildId"),
                "channel": plan.get("channel"),
                "status": "queued",
                "progress": 0,
                "step": 0,
                "totalSteps": len(plan.get("uploadJobs") or []) + 2
                + (1 if int(plan.get("retentionCount") or 0) > 0 else 0),
                "message": "等待发布任务启动",
                "log": [],
                "createdAt": _now(),
                "updatedAt": _now(),
            }
            state["jobs"] = [job, *state["jobs"]]
            self._save_state(state)
        self._job_account_modes[job_id] = str(account.get("mode") or "user")
        task = asyncio.create_task(self._run_publish(job_id, plan))
        self._tasks[job_id] = task
        task.add_done_callback(lambda finished, jid=job_id: self._consume_task(jid, finished))
        return {"status": "queued", "job": job}

    def _consume_task(self, job_id: str, task: asyncio.Task) -> None:
        self._tasks.pop(job_id, None)
        self._processes.pop(job_id, None)
        self._job_account_modes.pop(job_id, None)
        self._upload_progress_marks.pop(job_id, None)
        self._cancel_requested.discard(job_id)
        try:
            task.exception()
        except (asyncio.CancelledError, Exception):
            pass

    def _append_log(self, job_id: str, message: str) -> None:
        with self._guard():
            state = self._load_state()
            job = next((item for item in state["jobs"] if item.get("id") == job_id), None)
            if not job:
                return
            log = list(job.get("log") or [])
            log.append(str(message)[:4_000])
            job["log"] = log[-120:]
            job["updatedAt"] = _now()
            self._save_state(state)

    def _report_upload_progress(
        self, job_id: str, current_bytes: int, file_size: int,
        completed_bytes: int, total_bytes: int, *, force: bool = False,
    ) -> None:
        file_size = max(0, int(file_size))
        current_bytes = max(0, min(file_size, int(current_bytes)))
        total_bytes = max(0, int(total_bytes))
        uploaded_bytes = max(0, min(total_bytes, int(completed_bytes) + current_bytes))
        progress = min(99, int(uploaded_bytes / total_bytes * 100)) if total_bytes else 0
        now = time.monotonic()
        previous = self._upload_progress_marks.get(job_id)
        if not force and previous:
            previous_at, previous_bytes, previous_progress = previous
            if (
                now - previous_at < UPLOAD_PROGRESS_INTERVAL
                and progress == previous_progress
                and uploaded_bytes - previous_bytes < 256 * 1024
            ):
                return
        self._upload_progress_marks[job_id] = (now, uploaded_bytes, progress)
        self._update_job(job_id, {
            "progress": progress,
            "uploadedBytes": uploaded_bytes,
            "totalBytes": total_bytes,
            "currentFileBytes": current_bytes,
            "currentFileSize": file_size,
        })

    async def _upload(
        self, job_id: str, qshell: str, bucket: str, key: str, path: Path, *,
        completed_bytes: int = 0, total_bytes: int = 0,
    ) -> None:
        if job_id in self._cancel_requested:
            raise asyncio.CancelledError
        file_size = path.stat().st_size
        self._append_log(job_id, f"上传 {path.name} → {key}")
        self._update_job(job_id, {
            "currentFileName": path.name,
            "currentFileBytes": 0,
            "currentFileSize": file_size,
            "uploadedBytes": max(0, completed_bytes),
            "totalBytes": max(0, total_bytes),
        })
        kwargs: dict[str, Any] = {
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
        }
        if os.name == "nt":
            kwargs["creationflags"] = 0x08000000 | 0x00000200
        else:
            kwargs["start_new_session"] = True
        command = [qshell]
        if self._job_account_modes.get(job_id) == "workspace":
            command.append("-L")
            kwargs["cwd"] = str(self.qshell_workspace)
        command.extend(["fput", bucket, key, str(path), "--overwrite"])
        process = await asyncio.create_subprocess_exec(
            *command, **kwargs,
        )
        self._processes[job_id] = process
        output_tail = bytearray()
        error_tail = bytearray()

        async def read_stream(stream: Optional[asyncio.StreamReader], tail: bytearray) -> None:
            parse_tail = ""
            if stream is None:
                return
            while True:
                chunk = await stream.read(4096)
                if not chunk:
                    return
                tail.extend(chunk)
                if len(tail) > 6_000:
                    del tail[:-6_000]
                parse_tail = (parse_tail + chunk.decode("utf-8", errors="replace"))[-1_000:]
                fraction = _qshell_progress_fraction(parse_tail)
                if fraction is not None:
                    self._report_upload_progress(
                        job_id, int(file_size * fraction), file_size,
                        completed_bytes, total_bytes,
                    )

        async def monitor_file_reads() -> None:
            baseline = _process_read_bytes(int(process.pid or 0))
            while process.returncode is None:
                await asyncio.sleep(UPLOAD_PROGRESS_INTERVAL)
                observed = _process_read_bytes(int(process.pid or 0))
                if observed is None:
                    continue
                if baseline is None:
                    baseline = observed
                    continue
                # qshell may read a small amount of config around the upload. Capping at
                # 98% prevents those reads from claiming completion before qshell exits.
                current = min(int(file_size * 0.98), max(0, observed - baseline))
                self._report_upload_progress(
                    job_id, current, file_size, completed_bytes, total_bytes,
                )

        stdout_task = asyncio.create_task(read_stream(process.stdout, output_tail))
        stderr_task = asyncio.create_task(read_stream(process.stderr, error_tail))
        monitor_task = asyncio.create_task(monitor_file_reads())
        try:
            await process.wait()
            await asyncio.gather(stdout_task, stderr_task)
            await monitor_task
        finally:
            self._processes.pop(job_id, None)
        if job_id in self._cancel_requested:
            raise asyncio.CancelledError
        output = bytes(output_tail).decode("utf-8", errors="replace").strip()
        error = bytes(error_tail).decode("utf-8", errors="replace").strip()
        if output:
            self._append_log(job_id, output)
        if process.returncode != 0:
            raise ReleaseCenterError(error or output or f"qshell 退出码 {process.returncode}")
        self._report_upload_progress(
            job_id, file_size, file_size, completed_bytes, total_bytes, force=True,
        )

    async def _delete_object(
        self, job_id: str, qshell: str, bucket: str, key: str,
    ) -> None:
        """Delete one explicitly recorded Qiniu object without ever listing the bucket."""
        kwargs: dict[str, Any] = {
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
        }
        if os.name == "nt":
            kwargs["creationflags"] = 0x08000000 | 0x00000200
        else:
            kwargs["start_new_session"] = True
        command = [qshell]
        if self._job_account_modes.get(job_id) == "workspace":
            command.append("-L")
            kwargs["cwd"] = str(self.qshell_workspace)
        command.extend(["delete", bucket, key])
        process = await asyncio.create_subprocess_exec(*command, **kwargs)
        self._processes[job_id] = process
        try:
            stdout, stderr = await process.communicate()
        finally:
            self._processes.pop(job_id, None)
        output = stdout.decode("utf-8", errors="replace")[-6_000:].strip()
        error = stderr.decode("utf-8", errors="replace")[-6_000:].strip()
        if process.returncode != 0:
            raise ReleaseCenterError(error or output or f"qshell delete 退出码 {process.returncode}")
        self._append_log(job_id, f"已删除旧版本对象：{key}")

    async def _apply_retention(
        self, job_id: str, qshell: str, current_history_id: str, retention_count: int,
    ) -> dict[str, int]:
        """Prune only tracked immutable objects in the current release storage scope."""
        retention_count = max(0, min(100, int(retention_count or 0)))
        if retention_count <= 0:
            return {"removedReleases": 0, "deletedObjects": 0, "failedObjects": 0}

        with self._guard():
            state = self._load_state()
            current = next(
                (item for item in state["history"] if item.get("id") == current_history_id), None,
            )
            if not current:
                raise ReleaseCenterError("无法读取本次发布记录，已跳过历史版本清理")
            scope = (
                str(current.get("qiniuBucket") or ""),
                str(current.get("channel") or ""),
                str(current.get("manifestKey") or ""),
            )
            scoped = sorted(
                (
                    dict(item) for item in state["history"]
                    if (
                        str(item.get("qiniuBucket") or ""),
                        str(item.get("channel") or ""),
                        str(item.get("manifestKey") or ""),
                    ) == scope
                ),
                key=lambda item: float(item.get("publishedAt") or 0),
                reverse=True,
            )

        retained = scoped[:retention_count]
        stale = scoped[retention_count:]
        protected_keys = {
            str(key)
            for item in retained
            for key in (item.get("objectKeys") or [])
            if str(key)
        }
        mutable_manifest_key = scope[2]
        deleted_objects = 0
        failed_objects = 0
        removed_release_ids: set[str] = set()
        remaining_by_release: dict[str, list[str]] = {}
        errors_by_release: dict[str, list[str]] = {}

        for release in stale:
            release_id = str(release.get("id") or "")
            recorded_keys = list(dict.fromkeys(
                str(key).strip() for key in (release.get("objectKeys") or []) if str(key).strip()
            ))
            # 老版本没有 objectKeys 时无法证明哪些云对象属于它；宁可保留记录也不猜路径。
            if not release_id or not recorded_keys:
                continue
            remaining: list[str] = []
            errors: list[str] = []
            for raw_key in recorded_keys:
                safe_key = _safe_key(raw_key)
                if not safe_key or safe_key != raw_key.strip("/ "):
                    remaining.append(raw_key)
                    errors.append(f"对象 key 不安全，已跳过：{raw_key}")
                    failed_objects += 1
                    continue
                if safe_key == mutable_manifest_key or safe_key in protected_keys:
                    # mutable manifest 永不删除；被保留版本共享的对象继续由保留版本持有。
                    continue
                try:
                    await self._delete_object(job_id, qshell, scope[0], safe_key)
                    deleted_objects += 1
                except Exception as error:
                    remaining.append(safe_key)
                    detail = f"{safe_key}：{error}"
                    errors.append(detail)
                    self._append_log(job_id, f"旧版本对象清理失败：{detail}")
                    failed_objects += 1
            if remaining:
                remaining_by_release[release_id] = remaining
                errors_by_release[release_id] = errors
            else:
                removed_release_ids.add(release_id)

        if removed_release_ids or remaining_by_release:
            with self._guard():
                state = self._load_state()
                state["history"] = [
                    item for item in state["history"]
                    if str(item.get("id") or "") not in removed_release_ids
                ]
                for item in state["history"]:
                    release_id = str(item.get("id") or "")
                    if release_id in remaining_by_release:
                        item["objectKeys"] = remaining_by_release[release_id]
                        item["cleanupError"] = "；".join(errors_by_release[release_id])[:4_000]
                        item["cleanupAttemptedAt"] = _now()
                self._save_state(state)

        return {
            "removedReleases": len(removed_release_ids),
            "deletedObjects": deleted_objects,
            "failedObjects": failed_objects,
        }

    async def _refresh_cdn(self, job_id: str, qshell: str, manifest_url: str) -> bool:
        """Ask Qiniu to invalidate the mutable channel manifest before public verification."""
        if not manifest_url.startswith(("https://", "http://")):
            return False
        kwargs: dict[str, Any] = {
            "stdin": asyncio.subprocess.PIPE,
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
        }
        if os.name == "nt":
            kwargs["creationflags"] = 0x08000000 | 0x00000200
        else:
            kwargs["start_new_session"] = True
        command = [qshell]
        if self._job_account_modes.get(job_id) == "workspace":
            command.append("-L")
            kwargs["cwd"] = str(self.qshell_workspace)
        command.append("cdnrefresh")
        process = await asyncio.create_subprocess_exec(*command, **kwargs)
        self._processes[job_id] = process
        try:
            stdout, stderr = await process.communicate((manifest_url + "\n").encode("utf-8"))
        finally:
            self._processes.pop(job_id, None)
        if job_id in self._cancel_requested:
            raise asyncio.CancelledError
        output = stdout.decode("utf-8", errors="replace")[-6_000:].strip()
        error = stderr.decode("utf-8", errors="replace")[-6_000:].strip()
        if process.returncode == 0:
            self._append_log(job_id, f"已提交 CDN 刷新：{manifest_url}")
            if output:
                self._append_log(job_id, output)
            return True
        self._append_log(
            job_id,
            "CDN 主动刷新未成功，将继续使用防缓存 URL 回读校验："
            + (error or output or f"qshell 退出码 {process.returncode}"),
        )
        return False

    async def _verify_published_manifest(
        self, source: str, expected: dict[str, Any], *,
        attempts: int = PUBLISHED_MANIFEST_ATTEMPTS,
    ) -> dict[str, Any]:
        if not source.startswith(("https://", "http://")):
            raise ReleaseCenterError("正式发布缺少可公开回读的 channel manifest URL")
        expected_release = dict(expected.get("release") or {})
        expected_build = str(expected_release.get("buildId") or "")
        expected_sequence = int(expected_release.get("sequence") or 0)
        expected_channel = str(expected.get("channel") or "")
        last_seen = "未取得清单"
        last_error = ""
        for attempt in range(max(1, attempts)):
            try:
                observed = await self._fetch_manifest(source)
                observed_release = dict((observed or {}).get("release") or {})
                observed_build = str(observed_release.get("buildId") or "")
                observed_sequence = int(observed_release.get("sequence") or 0)
                observed_channel = str((observed or {}).get("channel") or "")
                last_seen = (
                    f"{observed_release.get('version') or '?'} / "
                    f"{observed_build or observed_sequence or '?'}"
                )
                build_matches = not expected_build or observed_build == expected_build
                sequence_matches = not expected_sequence or observed_sequence == expected_sequence
                channel_matches = not expected_channel or observed_channel == expected_channel
                if observed and build_matches and sequence_matches and channel_matches:
                    return observed
            except Exception as error:
                last_error = str(error)
            if attempt + 1 < max(1, attempts):
                await asyncio.sleep(min(3.0, 0.5 * (attempt + 1)))
        expected_label = f"{expected_release.get('version') or '?'} / {expected_build or expected_sequence or '?'}"
        detail = f"；最后错误：{last_error}" if last_error else ""
        raise ReleaseCenterError(
            "公开 channel manifest 回读不一致，发布不能标记成功："
            f"期望 {expected_label}，实际 {last_seen}{detail}。"
            "请检查 CDN 缓存刷新及 manifest key 是否指向同一个桶。"
        )

    async def _run_publish(self, job_id: str, plan: dict[str, Any]) -> None:
        try:
            self._update_job(job_id, {"status": "running", "message": "重新校验冻结制品", "startedAt": _now()})
            for upload in plan.get("uploadJobs") or []:
                path = Path(str(upload.get("path") or "")).expanduser()
                if not path.is_file():
                    raise ReleaseCenterError(f"制品已不存在：{path}")
                if path.stat().st_size != int(upload.get("size") or 0):
                    raise ReleaseCenterError(f"制品大小在预检后发生变化：{path.name}")
                digest = await asyncio.to_thread(sha256_file, path)
                if digest != str(upload.get("sha256") or ""):
                    raise ReleaseCenterError(f"制品哈希在预检后发生变化：{path.name}")

            config = self._config()
            qshell = self._resolve_qshell(config)
            if not qshell:
                raise ReleaseCenterError("正式发布时找不到 qshell")
            bucket = str(plan.get("qiniuBucket") or "").strip()
            if not bucket:
                raise ReleaseCenterError("冻结计划没有七牛 Bucket")

            manifest = json.loads(json.dumps(plan.get("manifest") or {}, ensure_ascii=False))
            signing_key = os.environ.get("AGENT_WITH_U_UPDATE_SIGNING_KEY", "")
            if plan.get("requireSignature") and not signing_key:
                raise ReleaseCenterError("冻结计划要求签名，但正式发布时签名密钥不可用")
            if signing_key:
                manifest["signature"] = {
                    "algorithm": "hmac-sha256",
                    "value": hmac.new(
                        signing_key.encode("utf-8"), canonical_payload(manifest), hashlib.sha256,
                    ).hexdigest(),
                }
            generated = self.generated_dir / _safe_id(job_id)
            generated.mkdir(parents=True, exist_ok=True)
            manifest_path = generated / "manifest.json"
            _atomic_json(manifest_path, manifest)

            upload_jobs = list(plan.get("uploadJobs") or [])
            manifest_size = manifest_path.stat().st_size
            total_bytes = sum(int(item.get("size") or 0) for item in upload_jobs) + manifest_size * 2
            completed_bytes = 0
            retention_count = max(0, min(100, int(plan.get("retentionCount") or 0)))
            total = len(upload_jobs) + 2 + (1 if retention_count > 0 else 0)
            step = 0
            self._update_job(job_id, {
                "uploadedBytes": 0,
                "totalBytes": total_bytes,
                "currentFileBytes": 0,
                "currentFileSize": 0,
                "currentFileName": "",
            })
            for upload in upload_jobs:
                step += 1
                self._update_job(job_id, {
                    "step": step,
                    "message": f"上传制品 {step}/{len(upload_jobs)}",
                })
                upload_path = Path(str(upload["path"]))
                await self._upload(
                    job_id, qshell, bucket, str(upload["key"]), upload_path,
                    completed_bytes=completed_bytes, total_bytes=total_bytes,
                )
                completed_bytes += upload_path.stat().st_size

            step += 1
            self._update_job(job_id, {
                "step": step,
                "message": "上传版本快照 manifest",
            })
            await self._upload(
                job_id, qshell, bucket, str(plan["versionedManifestKey"]), manifest_path,
                completed_bytes=completed_bytes, total_bytes=total_bytes,
            )
            completed_bytes += manifest_size

            # stable/channel 指针必须是最后一个写入对象。此前任何失败都不会让客户端看到半套发布。
            step += 1
            self._update_job(job_id, {
                "step": step,
                "message": f"最后切换 {plan.get('channel') or 'stable'} manifest",
            })
            await self._upload(
                job_id, qshell, bucket, str(plan["manifestKey"]), manifest_path,
                completed_bytes=completed_bytes, total_bytes=total_bytes,
            )
            completed_bytes += manifest_size

            manifest_url = str(plan.get("manifestUrl") or "").strip()
            self._update_job(job_id, {
                "progress": 99,
                "uploadedBytes": completed_bytes,
                "currentFileBytes": manifest_size,
                "currentFileSize": manifest_size,
                "message": "刷新 CDN 并核验公开 channel manifest",
            })
            await self._refresh_cdn(job_id, qshell, manifest_url)
            self._update_job(job_id, {"message": "从公开 URL 回读并确认新版本"})
            observed = await self._verify_published_manifest(manifest_url, manifest)
            observed_release = dict(observed.get("release") or {})
            self._append_log(
                job_id,
                "公开清单已确认："
                f"{observed_release.get('version') or '?'} / {observed_release.get('buildId') or '?'}",
            )

            finished = _now()
            with self._guard():
                state = self._load_state()
                candidate = next(
                    (item for item in state["candidates"] if item.get("id") == plan.get("candidateId")), None,
                )
                if candidate:
                    candidate.update({
                        "status": "published", "publishedAt": finished,
                        "publishedChannel": plan.get("channel"), "updatedAt": finished,
                    })
                history = {
                    "id": str(uuid.uuid4()),
                    "jobId": job_id,
                    "planId": plan.get("id"),
                    "candidateId": plan.get("candidateId"),
                    "buildId": (plan.get("candidate") or {}).get("buildId"),
                    "version": (plan.get("candidate") or {}).get("version"),
                    "channel": plan.get("channel"),
                    "qiniuBucket": bucket,
                    "manifestKey": plan.get("manifestKey"),
                    "manifestUrl": plan.get("manifestUrl"),
                    "artifactCount": len(plan.get("uploadJobs") or []),
                    # 仅这些经过本次冻结计划明确记录的不可变对象允许自动清理。
                    # channel manifest 是可变指针，故意不进入此列表。
                    "objectKeys": [
                        *[str(item.get("key") or "") for item in upload_jobs if item.get("key")],
                        str(plan.get("versionedManifestKey") or ""),
                    ],
                    "publishedAt": finished,
                }
                state["history"] = [history, *state["history"]]
                job = next((item for item in state["jobs"] if item.get("id") == job_id), None)
                if job:
                    job.update({
                        "message": (
                            f"新版本已发布，正在清理旧版本（保留最近 {retention_count} 个）"
                            if retention_count > 0 else "正式发布完成，channel manifest 已切换"
                        ),
                        "manifestUrl": plan.get("manifestUrl"),
                        "updatedAt": finished,
                    })
                self._save_state(state)

            cleanup = {"removedReleases": 0, "deletedObjects": 0, "failedObjects": 0}
            if retention_count > 0:
                step += 1
                self._update_job(job_id, {
                    "step": step,
                    "message": f"清理旧版本（保留最近 {retention_count} 个）",
                    "currentFileName": "",
                    "currentFileBytes": 0,
                    "currentFileSize": 0,
                })
                try:
                    cleanup = await self._apply_retention(
                        job_id, qshell, str(history["id"]), retention_count,
                    )
                except Exception as error:
                    # stable manifest 已从公网回读确认，此时清理失败不能把成功发布
                    # 伪报成失败；保留旧记录，下一次发布会再次尝试。
                    cleanup = {"removedReleases": 0, "deletedObjects": 0, "failedObjects": 1}
                    self._append_log(job_id, f"旧版本自动清理失败，已保留旧版本记录：{error}")

            cleanup_failed = int(cleanup.get("failedObjects") or 0)
            removed_releases = int(cleanup.get("removedReleases") or 0)
            deleted_objects = int(cleanup.get("deletedObjects") or 0)
            if retention_count <= 0:
                final_message = "正式发布完成，channel manifest 已切换"
            elif cleanup_failed:
                final_message = (
                    f"正式发布完成；已清理 {removed_releases} 个旧版本，"
                    f"但有 {cleanup_failed} 个对象清理失败，可查看任务日志"
                )
            else:
                final_message = (
                    f"正式发布完成；保留最近 {retention_count} 个版本，"
                    f"已清理 {removed_releases} 个旧版本 / {deleted_objects} 个对象"
                )
            self._update_job(job_id, {
                "status": "succeeded", "progress": 100, "step": total,
                "message": final_message,
                "cleanup": cleanup,
                "manifestUrl": plan.get("manifestUrl"), "endedAt": _now(),
                "currentFileName": "", "currentFileBytes": 0, "currentFileSize": 0,
            })
        except asyncio.CancelledError:
            self._update_job(job_id, {
                "status": "cancelled", "message": "发布已取消；未确认切换 channel manifest",
                "endedAt": _now(),
            })
        except Exception as error:
            self._append_log(job_id, f"错误：{error}")
            self._update_job(job_id, {
                "status": "failed", "message": "发布失败；channel manifest 未确认切换",
                "error": str(error)[:4_000], "endedAt": _now(),
            })

    async def cancel_publish(self, job_id: str) -> dict[str, Any]:
        with self._guard():
            state = self._load_state()
            job = next((item for item in state["jobs"] if item.get("id") == job_id), None)
            if not job:
                raise ReleaseCenterError("发布任务不存在")
            if job.get("status") not in {"queued", "running"}:
                return {"status": "ok", "job": job}
        self._cancel_requested.add(job_id)
        process = self._processes.get(job_id)
        if process and process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        return {"status": "cancelling", "job": self._update_job(job_id, {"message": "正在取消发布"})}
