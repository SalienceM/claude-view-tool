"""
SkillStore: 管理 Skill 孵化库与激活状态。

设计原则：
  - 孵化库：~/.agent-with-u/skill-library/<name>/SKILL.md  （全局积累）
  - 激活 = 按 Agent 框架渲染并复制 SKILL.md 到各自原生目录
  - 项目级 → .claude/skills、.qwen/skills、.agents/skills
  - 全局级 → ~/.claude/skills、~/.qwen/skills、~/.codex/skills
  - 停用 = 删除目标位置的文件
  - 激活记录存在 index.json 中，key 为 "global" 或工作目录绝对路径

插件包格式（.awu）：
  - 本质是 zip 文件，内含 manifest.json + SKILL.md + 可选文件
  - 敏感配置通过 secrets.schema.json 声明，由客户端 UI 引导填写
  - 运行时凭据存于 ~/.agent-with-u/skill-secrets/<name>.json（仅 owner 可读）
  - 凭据永不传入大模型 context
"""

import hashlib
import io
import json
import re
import shutil
import stat
import tempfile
import threading
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Optional

import yaml  # PyYAML — declared in requirements.txt

from . import paths
from .skill_paths import deployment_targets, render_skill_markdown

LIBRARY_DIR  = paths.sub("skill-library")
INDEX_FILE   = LIBRARY_DIR / "index.json"
SECRETS_DIR  = paths.sub("skill-secrets")

MANAGED_MARKER = ".awu-managed.json"
STANDARD_SKILL_FORMAT = "agent-skills"
MAX_STANDARD_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_STANDARD_FILE_BYTES = 16 * 1024 * 1024
MAX_STANDARD_FILES = 512
_STANDARD_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SAFE_LIBRARY_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

DEFAULT_SKILL_TEMPLATE = """\
---
name: {name}
description: Describe what this skill does and when an agent should use it (max 250 chars)
# backend: backend-id          # 可选：指定路由到哪个 Backend（Backend Skill 模式）
# input_schema:                # 可选：Backend Skill 的输入参数定义（JSON Schema）
#   type: object
#   properties:
#     prompt:
#       type: string
#       description: 输入描述
---

## Instructions

Write step-by-step instructions for the active agent here.

If a command needs a file bundled beside SKILL.md, use `{{SKILL_DIR}}/file-name`.
AgentWithU resolves this placeholder to the active framework's native directory.

## Example Usage

Describe example prompts that would trigger this skill.
"""


def parse_skill_frontmatter(content: str) -> dict:
    """解析 SKILL.md 的 YAML frontmatter，返回字段字典。"""
    m = re.match(r'^---\s*\r?\n(.*?)\r?\n---(?:\r?\n|$)', content, re.DOTALL)
    if not m:
        return {}
    try:
        data = yaml.safe_load(m.group(1))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def validate_standard_skill(content: str, directory_name: str = "") -> dict:
    """Validate the portable Agent Skills ``SKILL.md`` contract.

    AgentWithU extensions (``backend``/``type``/``input_schema``) remain valid,
    but are not required.  The portable baseline only requires the open
    ``name`` and ``description`` frontmatter fields.
    """
    frontmatter = parse_skill_frontmatter(content)
    errors: list[str] = []
    warnings: list[str] = []
    name = str(frontmatter.get("name") or "").strip()
    description = str(frontmatter.get("description") or "").strip()

    if not name:
        errors.append("SKILL.md frontmatter 缺少 name")
    elif len(name) > 64 or not _STANDARD_NAME_RE.fullmatch(name):
        errors.append("name 必须为 1-64 位小写字母、数字和连字符，且不能以连字符开头或结尾")
    if not description:
        errors.append("SKILL.md frontmatter 缺少 description")
    elif len(description) > 1024:
        errors.append("description 不能超过 1024 个字符")
    if directory_name and name and directory_name != name:
        warnings.append(
            f"目录名 {directory_name!r} 与 frontmatter name {name!r} 不一致；安装时使用 name"
        )

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "frontmatter": frontmatter,
        "name": name,
        "description": description,
    }


def skill_files_digest(files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for relative, data in sorted(files.items()):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
        digest.update(b"\0")
    return digest.hexdigest()


def assess_skill_risk(files: dict[str, bytes], markdown: str) -> dict:
    """Return a small, explainable pre-install risk summary.

    This is intentionally a warning system, not a claim that arbitrary code is
    safe.  A Skill can instruct an agent to execute commands even when it ships
    no executable file, so the UI always keeps the source preview visible.
    """
    flags: list[str] = []
    level = "low"
    names = {name.lower() for name in files}
    executable_suffixes = {
        ".exe", ".dll", ".msi", ".bat", ".cmd", ".ps1", ".sh", ".py",
        ".js", ".mjs", ".cjs", ".jar", ".so", ".dylib",
    }
    binary_suffixes = {".exe", ".dll", ".msi", ".jar", ".so", ".dylib"}

    shipped_exec = sorted(
        name for name in files
        if PurePosixPath(name).suffix.lower() in executable_suffixes
    )
    shipped_binary = sorted(
        name for name in files
        if PurePosixPath(name).suffix.lower() in binary_suffixes
    )
    if shipped_exec:
        level = "medium"
        flags.append(f"包含可执行脚本或程序：{', '.join(shipped_exec[:6])}")
    if shipped_binary:
        level = "high"
        flags.append(f"包含二进制文件：{', '.join(shipped_binary[:6])}")
    if any(
        name.endswith(("requirements.txt", "package.json", "pyproject.toml", "environment.yml"))
        for name in names
    ):
        if level == "low":
            level = "medium"
        flags.append("包含依赖安装清单")

    lowered = markdown.lower()
    destructive_patterns = (
        "rm -rf", "remove-item -recurse", "format ", "mkfs.",
        "diskpart", "shutdown /", "reg delete",
    )
    network_patterns = (
        "curl ", "curl.exe", "wget ", "invoke-webrequest", "http://", "https://",
    )
    if any(pattern in lowered for pattern in destructive_patterns):
        level = "high"
        flags.append("说明中包含潜在破坏性命令，请逐行检查")
    if any(pattern in lowered for pattern in network_patterns):
        if level == "low":
            level = "medium"
        flags.append("说明中包含网络访问或下载命令")
    if not flags:
        flags.append("未发现脚本、二进制或明显高风险命令；仍需阅读完整说明")
    return {"level": level, "flags": flags}


def _normalise_zip_members(
    zf: zipfile.ZipFile,
    *,
    source_root: str = "",
    repository_mode: bool = False,
) -> tuple[dict[str, zipfile.ZipInfo], str]:
    """Validate ZIP paths and return members inside the requested source root.

    A GitHub archive can contain documentation, examples and many independent
    Skills outside ``source_root``.  Catalog discovery must not apply the
    single-Skill file-count/expanded-size limits to those unrelated files.  In
    repository mode the same limits are applied later to each discovered Skill
    directory instead.  Repository-level symlinks are likewise evaluated only
    when they belong to a discovered Skill; a root helper link must not hide an
    otherwise valid catalog.
    """
    all_members: dict[str, zipfile.ZipInfo] = {}
    for info in zf.infolist():
        raw = info.filename.replace("\\", "/")
        path = PurePosixPath(raw)
        if info.is_dir() or raw.startswith("__MACOSX/"):
            continue
        if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
            raise ValueError(f"压缩包包含不安全路径：{raw}")
        mode = (info.external_attr >> 16) & 0xFFFF
        if mode and stat.S_ISLNK(mode) and not repository_mode:
            raise ValueError(f"压缩包不允许符号链接：{raw}")
        all_members[path.as_posix()] = info

    if not all_members:
        return {}, ""

    first_parts = {PurePosixPath(name).parts[0] for name in all_members}
    wrapper = next(iter(first_parts)) if len(first_parts) == 1 else ""
    # Root-level SKILL.md means the common first component is the Skill
    # itself, not a GitHub archive wrapper.
    if "SKILL.md" in all_members:
        wrapper = ""

    root_parts = tuple(
        part for part in PurePosixPath(source_root.strip("/")).parts
        if part not in {"", "."}
    )
    if any(part == ".." for part in root_parts):
        raise ValueError("Skill 来源子目录不安全")

    members: dict[str, zipfile.ZipInfo] = {}
    total_size = 0
    for member_name, info in all_members.items():
        parts = PurePosixPath(member_name).parts
        logical_parts = parts[1:] if wrapper and parts[0] == wrapper else parts
        if root_parts and logical_parts[:len(root_parts)] != root_parts:
            continue
        if not repository_mode:
            if info.file_size > MAX_STANDARD_FILE_BYTES:
                raise ValueError(f"Skill 文件过大：{member_name}")
            total_size += info.file_size
            if total_size > MAX_STANDARD_ARCHIVE_BYTES:
                raise ValueError("Skill 压缩包解压后超过 64 MiB")
        members[member_name] = info

    if not repository_mode and len(members) > MAX_STANDARD_FILES:
        raise ValueError(f"Skill 压缩包文件数超过 {MAX_STANDARD_FILES}")
    return members, wrapper


def _read_zip_member(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    chunks: list[bytes] = []
    size = 0
    with zf.open(info, "r") as stream:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_STANDARD_FILE_BYTES:
                raise ValueError(f"Skill 文件解压后过大：{info.filename}")
            chunks.append(chunk)
    return b"".join(chunks)


def standard_skills_from_zip_bytes(
    data: bytes,
    source_root: str = "",
    *,
    skip_invalid: bool = False,
    issues: Optional[list[dict]] = None,
    repository_mode: bool = False,
) -> list[dict]:
    """Inspect a standard Agent Skills ZIP without writing or executing it.

    Supports a single Skill ZIP, a GitHub source archive, or a repository that
    contains several independent ``SKILL.md`` directories.
    """
    if len(data) > MAX_STANDARD_ARCHIVE_BYTES:
        raise ValueError("Skill 压缩包超过 64 MiB")
    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        members, wrapper = _normalise_zip_members(
            zf,
            source_root=source_root,
            repository_mode=repository_mode,
        )
        if not members:
            raise ValueError("指定目录中没有可读取的文件")

        root_parts = tuple(
            part for part in PurePosixPath(source_root.strip("/")).parts
            if part not in {"", "."}
        )
        candidates: list[tuple[str, tuple[str, ...]]] = []
        for member_name in members:
            parts = PurePosixPath(member_name).parts
            logical_parts = parts[1:] if wrapper and parts[0] == wrapper else parts
            if not logical_parts or logical_parts[-1] != "SKILL.md":
                continue
            parent = logical_parts[:-1]
            if root_parts and parent[:len(root_parts)] != root_parts:
                continue
            candidates.append((member_name, logical_parts))
        if not candidates:
            raise ValueError("未找到兼容的 SKILL.md")

        original_roots = {
            PurePosixPath(member_name).parent.as_posix()
            for member_name, _logical in candidates
        }
        results: list[dict] = []
        seen_names: set[str] = set()
        for skill_member, logical_parts in sorted(candidates):
            original_root = PurePosixPath(skill_member).parent.as_posix()
            logical_parent = PurePosixPath(*logical_parts[:-1]).as_posix()
            if logical_parent == ".":
                logical_parent = ""
            try:
                files: dict[str, bytes] = {}
                prefix = "" if original_root == "." else original_root + "/"
                total_size = 0
                for member_name, info in members.items():
                    if prefix and not member_name.startswith(prefix):
                        continue
                    if not prefix and "/" in member_name:
                        # A root Skill owns its support folders, except nested
                        # independent Skills handled below.
                        pass
                    relative = member_name[len(prefix):] if prefix else member_name
                    if not relative:
                        continue
                    # Do not absorb another nested Skill into this package.
                    nested = False
                    for other_root in original_roots:
                        if other_root == original_root or other_root == ".":
                            continue
                        other_prefix = other_root + "/"
                        if member_name.startswith(other_prefix):
                            nested = True
                            break
                    if nested:
                        continue
                    mode = (info.external_attr >> 16) & 0xFFFF
                    if mode and stat.S_ISLNK(mode):
                        raise ValueError(f"Skill 目录包含符号链接：{member_name}")
                    if info.file_size > MAX_STANDARD_FILE_BYTES:
                        raise ValueError(f"Skill 文件过大：{member_name}")
                    total_size += info.file_size
                    if total_size > MAX_STANDARD_ARCHIVE_BYTES:
                        raise ValueError("Skill 文件总大小超过 64 MiB")
                    files[PurePosixPath(relative).as_posix()] = _read_zip_member(zf, info)
                    if len(files) > MAX_STANDARD_FILES:
                        raise ValueError(f"Skill 文件数超过 {MAX_STANDARD_FILES}")

                try:
                    markdown = files["SKILL.md"].decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise ValueError(f"{skill_member} 不是 UTF-8 文本") from exc
                directory_name = logical_parts[-2] if len(logical_parts) >= 2 else ""
                validation = validate_standard_skill(markdown, directory_name)
                if not validation["valid"]:
                    joined = "；".join(validation["errors"])
                    raise ValueError(f"{skill_member} 不符合 Agent Skills 规范：{joined}")
                name = validation["name"]
                if name in seen_names:
                    raise ValueError(f"压缩包内存在重复 Skill name：{name}")
                seen_names.add(name)
                frontmatter = validation["frontmatter"]
                results.append({
                    "name": name,
                    "description": validation["description"],
                    "path": logical_parent,
                    "content": markdown,
                    "frontmatter": frontmatter,
                    "warnings": validation["warnings"],
                    "files": files,
                    "fileNames": sorted(files),
                    "fileCount": len(files),
                    "size": sum(len(value) for value in files.values()),
                    "digest": skill_files_digest(files),
                    "risk": assess_skill_risk(files, markdown),
                })
            except (KeyError, ValueError) as exc:
                if not skip_invalid:
                    raise
                if issues is not None:
                    issues.append({
                        "path": logical_parent,
                        "message": str(exc),
                    })
        return results


class SkillStore:
    def __init__(self):
        LIBRARY_DIR.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._index: dict = self._load_index()

    # ── 内部持久化 ────────────────────────────────────────────────

    def _load_index(self) -> dict:
        if INDEX_FILE.exists():
            try:
                return json.loads(INDEX_FILE.read_text(encoding="utf-8"))
            except Exception:
                return {}
        return {}

    def _save_index(self):
        INDEX_FILE.write_text(
            json.dumps(self._index, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # ── 目标路径计算 ────────────────────────────────────────────────

    @staticmethod
    def _target_dirs(name: str, target_key: str) -> list[tuple[str, Path, str]]:
        return deployment_targets(name, target_key)

    @staticmethod
    def _validate_library_name(name: str) -> str:
        value = str(name or "").strip()
        if not _SAFE_LIBRARY_NAME_RE.fullmatch(value):
            raise ValueError(
                "Skill 名称只能包含字母、数字、点、下划线和连字符，且不能包含路径"
            )
        return value

    @classmethod
    def _target_dir(cls, name: str, target_key: str) -> Path:
        """Return the Claude target for compatibility with older callers."""
        targets = cls._target_dirs(name, target_key)
        return next(
            target for agent_name, target, _reference in targets
            if agent_name == "claude"
        )

    # ── 部署/撤销 ────────────────────────────────────────────────────

    @staticmethod
    def _read_managed_files(target: Path) -> list[str]:
        marker = target / MANAGED_MARKER
        if not marker.exists():
            return []
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
            files = payload.get("files", []) if isinstance(payload, dict) else []
            return [str(item) for item in files if isinstance(item, str)]
        except Exception:
            return []

    @classmethod
    def _remove_managed_target(cls, target: Path) -> None:
        files = cls._read_managed_files(target)
        if files:
            for relative in files:
                path = PurePosixPath(relative)
                if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
                    continue
                candidate = target.joinpath(*path.parts)
                try:
                    if candidate.is_file() or candidate.is_symlink():
                        candidate.unlink()
                except Exception:
                    pass
            marker = target / MANAGED_MARKER
            try:
                if marker.exists():
                    marker.unlink()
            except Exception:
                pass
            try:
                directories = sorted(
                    (item for item in target.rglob("*") if item.is_dir()),
                    key=lambda item: len(item.parts),
                    reverse=True,
                )
                for directory in directories:
                    try:
                        directory.rmdir()
                    except OSError:
                        pass
                target.rmdir()
            except OSError:
                pass
            return

        # Legacy AgentWithU deployments predate the marker and only owned
        # SKILL.md.  Leave all unrelated support files untouched.
        skill_file = target / "SKILL.md"
        try:
            if skill_file.exists():
                skill_file.unlink()
            if target.exists() and not any(target.iterdir()):
                target.rmdir()
        except Exception:
            pass

    def _deploy_to_target(
        self,
        name: str,
        target: Path,
        reference: str,
        fallback_content: str = "",
    ) -> None:
        source = LIBRARY_DIR / name
        skill_file = source / "SKILL.md"
        if not skill_file.exists():
            if not fallback_content:
                raise ValueError(f"Skill '{name}' not found in library")
            self._remove_managed_target(target)
            target.mkdir(parents=True, exist_ok=True)
            rendered = render_skill_markdown(
                fallback_content,
                skill_name=name,
                skill_dir_reference=reference,
            )
            (target / "SKILL.md").write_text(rendered, encoding="utf-8")
            (target / MANAGED_MARKER).write_text(
                json.dumps({"managedBy": "AgentWithU", "files": ["SKILL.md"]}),
                encoding="utf-8",
            )
            return

        # Remove only files from the previous AgentWithU deployment.  A user
        # may keep unrelated notes in the same folder; those are not ours.
        self._remove_managed_target(target)
        target.mkdir(parents=True, exist_ok=True)
        copied: list[str] = []
        for item in sorted(source.rglob("*")):
            if not item.is_file() or item.is_symlink():
                continue
            relative = item.relative_to(source)
            if any(part in {"__pycache__", ".git"} for part in relative.parts):
                continue
            if item.suffix.lower() in {".pyc", ".pyo"}:
                continue
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if relative.as_posix() == "SKILL.md":
                content = item.read_text(encoding="utf-8")
                rendered = render_skill_markdown(
                    content,
                    skill_name=name,
                    skill_dir_reference=reference,
                )
                destination.write_text(rendered, encoding="utf-8")
            else:
                shutil.copy2(item, destination)
            copied.append(relative.as_posix())
        (target / MANAGED_MARKER).write_text(
            json.dumps({"managedBy": "AgentWithU", "files": copied}, ensure_ascii=False),
            encoding="utf-8",
        )

    def _deploy(self, name: str, content: str, target_key: str):
        for _agent_name, target, reference in self._target_dirs(name, target_key):
            self._deploy_to_target(name, target, reference, content)

    def _undeploy(self, name: str, target_key: str):
        for _agent_name, target, _reference in self._target_dirs(name, target_key):
            self._remove_managed_target(target)

    def deploy_to_directory(self, name: str, target: Path, reference: str) -> None:
        """Deploy one full portable Skill directory to a native agent root."""
        with self._lock:
            safe_name = self._validate_library_name(name)
            self._deploy_to_target(safe_name, Path(target), reference)

    @classmethod
    def undeploy_from_directory(cls, target: Path) -> None:
        cls._remove_managed_target(Path(target))

    @staticmethod
    def is_managed_directory(target: Path) -> bool:
        return (Path(target) / MANAGED_MARKER).exists()

    # ── 辅助 ─────────────────────────────────────────────────────────

    def _read_manifest(self, skill_dir: Path) -> Optional[dict]:
        mf = skill_dir / "manifest.json"
        if mf.exists():
            try:
                return json.loads(mf.read_text(encoding="utf-8"))
            except Exception:
                pass
        return None

    # ── 公开 API：Skill CRUD ──────────────────────────────────────────

    def list_skills(self, working_dir: str = "") -> list[dict]:
        with self._lock:
            result = []
            if not LIBRARY_DIR.exists():
                return result
            for skill_dir in sorted(LIBRARY_DIR.iterdir()):
                if not skill_dir.is_dir():
                    continue
                name = skill_dir.name
                skill_file = skill_dir / "SKILL.md"
                if not skill_file.exists():
                    continue
                content = skill_file.read_text(encoding="utf-8")
                activations: list[str] = self._index.get(name, {}).get("activations", [])
                valid_activations = [
                    ak for ak in activations
                    if any(
                        (target / "SKILL.md").exists()
                        for _agent_name, target, _reference
                        in self._target_dirs(name, ak)
                    )
                ]
                if set(valid_activations) != set(activations):
                    self._index.setdefault(name, {})["activations"] = valid_activations
                    self._save_index()
                    activations = valid_activations

                fm = parse_skill_frontmatter(content)
                index_entry = self._index.get(name, {})
                item: dict = {
                    "id": name,
                    "name": name,
                    "content": content,
                    "isGlobal": "global" in activations,
                    "isProject": bool(working_dir) and working_dir in activations,
                    "projectActivations": [a for a in activations if a != "global"],
                    "description": fm.get("description", ""),
                    "isDefault": bool(index_entry.get("isDefault", False)),
                    # 插件包扩展字段
                    "hasCallPy": (skill_dir / "call.py").exists(),
                    "hasSecrets": (SECRETS_DIR / f"{name}.json").exists(),
                    "hasSecretsSchema": (skill_dir / "secrets.schema.json").exists(),
                    "manifest": self._read_manifest(skill_dir),
                    "format": index_entry.get(
                        "format",
                        "awu" if (skill_dir / "manifest.json").exists() else "legacy",
                    ),
                    "source": index_entry.get("source"),
                }
                if fm.get("backend"):
                    item["backend"] = fm["backend"]
                if fm.get("type"):
                    item["type"] = fm["type"]
                if fm.get("input_schema"):
                    item["inputSchema"] = fm["input_schema"]
                result.append(item)
            return result

    def get_skill(self, name: str) -> Optional[dict]:
        with self._lock:
            name = self._validate_library_name(name)
            skill_file = LIBRARY_DIR / name / "SKILL.md"
            if not skill_file.exists():
                return None
            content = skill_file.read_text(encoding="utf-8")
            activations = self._index.get(name, {}).get("activations", [])
            fm = parse_skill_frontmatter(content)
            skill_dir = LIBRARY_DIR / name
            index_entry = self._index.get(name, {})
            result: dict = {
                "id": name,
                "name": name,
                "content": content,
                "activations": activations,
                "description": fm.get("description", ""),
                "isDefault": bool(index_entry.get("isDefault", False)),
                "hasCallPy": (skill_dir / "call.py").exists(),
                "hasSecrets": (SECRETS_DIR / f"{name}.json").exists(),
                "hasSecretsSchema": (skill_dir / "secrets.schema.json").exists(),
                "manifest": self._read_manifest(skill_dir),
                "format": index_entry.get(
                    "format",
                    "awu" if (skill_dir / "manifest.json").exists() else "legacy",
                ),
                "source": index_entry.get("source"),
            }
            if fm.get("backend"):
                result["backend"] = fm["backend"]
            if fm.get("type"):
                result["type"] = fm["type"]
            if fm.get("input_schema"):
                result["inputSchema"] = fm["input_schema"]
            return result

    def save_skill(self, name: str, content: str) -> None:
        with self._lock:
            name = self._validate_library_name(name)
            skill_dir = LIBRARY_DIR / name
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
            if name not in self._index:
                self._index[name] = {"activations": []}
            else:
                source = self._index[name].get("source")
                if isinstance(source, dict):
                    source["dirty"] = True
            self._index[name].setdefault("format", "legacy")
            self._save_index()
            for target_key in self._index.get(name, {}).get("activations", []):
                try:
                    self._deploy(name, content, target_key)
                except Exception as e:
                    print(f"[SkillStore] sync failed ({target_key}): {e}", flush=True)

    def delete_skill(self, name: str) -> None:
        with self._lock:
            name = self._validate_library_name(name)
            for target_key in self._index.get(name, {}).get("activations", []):
                try:
                    self._undeploy(name, target_key)
                except Exception:
                    pass
            skill_dir = LIBRARY_DIR / name
            if skill_dir.exists():
                shutil.rmtree(skill_dir)
            self._index.pop(name, None)
            self._save_index()
            # 删除 skill 时一并清理凭据
            secrets_file = SECRETS_DIR / f"{name}.json"
            if secrets_file.exists():
                try:
                    secrets_file.unlink()
                except Exception:
                    pass

    def activate(self, name: str, scope: str, working_dir: str = "") -> None:
        with self._lock:
            name = self._validate_library_name(name)
            skill_file = LIBRARY_DIR / name / "SKILL.md"
            if not skill_file.exists():
                raise ValueError(f"Skill '{name}' not found in library")
            target_key = "global" if scope == "global" else working_dir
            if not target_key:
                raise ValueError("working_dir is required for project-scope activation")
            content = skill_file.read_text(encoding="utf-8")
            self._deploy(name, content, target_key)
            entry = self._index.setdefault(name, {"activations": []})
            if target_key not in entry["activations"]:
                entry["activations"].append(target_key)
            self._save_index()

    def deactivate(self, name: str, scope: str, working_dir: str = "") -> None:
        with self._lock:
            name = self._validate_library_name(name)
            target_key = "global" if scope == "global" else working_dir
            if not target_key:
                raise ValueError("working_dir is required for project-scope deactivation")
            self._undeploy(name, target_key)
            entry = self._index.get(name, {})
            acts = entry.get("activations", [])
            if target_key in acts:
                acts.remove(target_key)
            self._save_index()

    def rename_skill(self, old_name: str, new_name: str, new_content: str) -> None:
        with self._lock:
            old_name = self._validate_library_name(old_name)
            new_name = self._validate_library_name(new_name)
            old_file = LIBRARY_DIR / old_name / "SKILL.md"
            if not old_file.exists():
                raise ValueError(f"Skill '{old_name}' not found")
            if old_name == new_name:
                old_file.write_text(new_content, encoding="utf-8")
                for target_key in self._index.get(old_name, {}).get("activations", []):
                    try:
                        self._deploy(old_name, new_content, target_key)
                    except Exception:
                        pass
                return
            old_entry = self._index.get(old_name, {}) or {}
            old_activations = old_entry.get("activations", [])
            old_is_default = bool(old_entry.get("isDefault", False))
            for target_key in old_activations:
                try:
                    self._undeploy(old_name, target_key)
                except Exception:
                    pass
            shutil.rmtree(LIBRARY_DIR / old_name, ignore_errors=True)
            self._index.pop(old_name, None)
            new_dir = LIBRARY_DIR / new_name
            new_dir.mkdir(parents=True, exist_ok=True)
            (new_dir / "SKILL.md").write_text(new_content, encoding="utf-8")
            entry = self._index.setdefault(new_name, {"activations": []})
            entry["format"] = "legacy"
            if old_is_default:
                entry["isDefault"] = True
            for target_key in old_activations:
                try:
                    self._deploy(new_name, new_content, target_key)
                    if target_key not in entry["activations"]:
                        entry["activations"].append(target_key)
                except Exception:
                    pass
            self._save_index()

    def set_default(self, name: str, is_default: bool) -> bool:
        """标记/取消某个 Skill 为默认档。默认档会在新建 session 时自动绑定。"""
        with self._lock:
            name = self._validate_library_name(name)
            skill_file = LIBRARY_DIR / name / "SKILL.md"
            if not skill_file.exists():
                return False
            entry = self._index.setdefault(name, {"activations": []})
            entry["isDefault"] = bool(is_default)
            self._save_index()
            return True

    def list_default_names(self) -> list[str]:
        """返回所有被标记为默认档的 Skill 名称列表。"""
        with self._lock:
            return [
                name for name, entry in self._index.items()
                if entry.get("isDefault") and (LIBRARY_DIR / name / "SKILL.md").exists()
            ]

    # ── 插件包安装 ────────────────────────────────────────────────────

    # 包内白名单文件（防止路径穿越攻击）
    _PKG_ALLOWED = {
        "manifest.json", "SKILL.md", "call.py",
        "secrets.schema.json", "requirements.txt", "README.md", "icon.png",
    }

    def install_package(self, pkg_path: str) -> dict:
        """
        安装 .awu 插件包（zip 格式）到孵化库。

        必须文件：manifest.json、SKILL.md
        可选文件：call.py、secrets.schema.json、requirements.txt、README.md、icon.png

        manifest.json 必须字段：
          id          小写字母+数字+连字符，全局唯一
          name        显示名称
          version     语义版本号
          description 简介

        返回解析后的 manifest dict。
        """
        with self._lock:
            with zipfile.ZipFile(pkg_path, "r") as zf:
                names = set(zf.namelist())

                if "manifest.json" not in names:
                    raise ValueError("包缺少 manifest.json")
                if "SKILL.md" not in names:
                    raise ValueError("包缺少 SKILL.md")

                manifest: dict = json.loads(zf.read("manifest.json").decode("utf-8"))
                skill_id: str = manifest.get("id", "")

                if not re.match(r'^[a-z][a-z0-9-]{0,63}$', skill_id):
                    raise ValueError(
                        f"manifest.id 格式非法：{skill_id!r}（要求小写字母开头，仅含小写字母/数字/连字符）"
                    )

                skill_dir = LIBRARY_DIR / skill_id
                skill_dir.mkdir(parents=True, exist_ok=True)

                # 只提取白名单文件
                for item in names:
                    if item.endswith("/"):
                        continue
                    filename = Path(item).name
                    if filename not in self._PKG_ALLOWED:
                        print(f"[SkillStore] install_package: skip {item!r} (not whitelisted)",
                              flush=True)
                        continue
                    (skill_dir / filename).write_bytes(zf.read(item))

                entry = self._index.setdefault(skill_id, {"activations": []})
                entry["format"] = "awu"
                entry["source"] = {
                    "kind": "awu",
                    "label": "AgentWithU .awu 包",
                    "version": str(manifest.get("version") or ""),
                }
                self._save_index()

                content = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
                for target_key in entry.get("activations", []):
                    try:
                        self._deploy(skill_id, content, target_key)
                    except Exception as exc:
                        print(f"[SkillStore] package redeploy failed ({target_key}): {exc}", flush=True)

                print(f"[SkillStore] installed '{skill_id}' v{manifest.get('version', '?')}",
                      flush=True)
                return manifest

    def install_standard_files(
        self,
        files: dict[str, bytes],
        *,
        source: Optional[dict] = None,
        allow_replace: bool = True,
    ) -> dict:
        """Install one portable Agent Skills directory into the library.

        Files are data at installation time: nothing is executed and dependency
        manifests are never installed automatically.  Activation later mirrors
        the complete directory into each agent's native Skill root.
        """
        normalized: dict[str, bytes] = {}
        total_size = 0
        if len(files) > MAX_STANDARD_FILES:
            raise ValueError(f"Skill 文件数超过 {MAX_STANDARD_FILES}")
        for raw_name, raw_data in files.items():
            path = PurePosixPath(str(raw_name).replace("\\", "/"))
            if path.is_absolute() or not path.parts or any(
                part in {"", ".", ".."} for part in path.parts
            ):
                raise ValueError(f"Skill 包含不安全路径：{raw_name}")
            data = bytes(raw_data)
            if len(data) > MAX_STANDARD_FILE_BYTES:
                raise ValueError(f"Skill 文件过大：{raw_name}")
            total_size += len(data)
            if total_size > MAX_STANDARD_ARCHIVE_BYTES:
                raise ValueError("Skill 文件总大小超过 64 MiB")
            normalized[path.as_posix()] = data
        if "SKILL.md" not in normalized:
            raise ValueError("标准 Skill 缺少根目录 SKILL.md")
        try:
            markdown = normalized["SKILL.md"].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("SKILL.md 必须使用 UTF-8 编码") from exc
        validation = validate_standard_skill(markdown)
        if not validation["valid"]:
            raise ValueError("；".join(validation["errors"]))
        name = validation["name"]
        digest = skill_files_digest(normalized)

        with self._lock:
            destination = LIBRARY_DIR / name
            LIBRARY_DIR.mkdir(parents=True, exist_ok=True)
            if destination.exists() and not allow_replace:
                raise FileExistsError(f"Skill '{name}' 已存在")

            old_entry = dict(self._index.get(name, {}))
            activations = list(old_entry.get("activations", []))
            is_default = bool(old_entry.get("isDefault", False))
            staging = Path(tempfile.mkdtemp(prefix=f".{name}-install-", dir=LIBRARY_DIR))
            backup = LIBRARY_DIR / f".{name}-backup-{uuid.uuid4().hex}"
            try:
                for relative, data in normalized.items():
                    target = staging.joinpath(*PurePosixPath(relative).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                if destination.exists():
                    destination.rename(backup)
                staging.rename(destination)
            except Exception:
                shutil.rmtree(staging, ignore_errors=True)
                if backup.exists() and not destination.exists():
                    backup.rename(destination)
                raise
            else:
                shutil.rmtree(backup, ignore_errors=True)

            source_meta = dict(source or {})
            source_meta.setdefault("kind", "local")
            source_meta.setdefault("label", "本地标准 Skill")
            source_meta["digest"] = digest
            source_meta["dirty"] = False
            entry: dict = {
                "activations": activations,
                "format": STANDARD_SKILL_FORMAT,
                "source": source_meta,
            }
            if is_default:
                entry["isDefault"] = True
            self._index[name] = entry
            self._save_index()

            for target_key in activations:
                try:
                    self._deploy(name, markdown, target_key)
                except Exception as exc:
                    print(f"[SkillStore] standard redeploy failed ({target_key}): {exc}", flush=True)

            frontmatter = validation["frontmatter"]
            metadata = frontmatter.get("metadata")
            version = ""
            if isinstance(metadata, dict):
                version = str(metadata.get("version") or "")
            version = str(frontmatter.get("version") or version)
            return {
                "id": name,
                "name": name,
                "description": validation["description"],
                "version": version,
                "format": STANDARD_SKILL_FORMAT,
                "digest": digest,
                "fileCount": len(normalized),
                "size": total_size,
                "warnings": validation["warnings"],
            }

    def install_standard_archive(
        self,
        pkg_path: str,
        *,
        source: Optional[dict] = None,
        allow_replace: bool = True,
    ) -> list[dict]:
        data = Path(pkg_path).read_bytes()
        inspected = standard_skills_from_zip_bytes(data)
        installed: list[dict] = []
        for candidate in inspected:
            candidate_source = dict(source or {})
            candidate_source.setdefault("kind", "local-zip")
            candidate_source.setdefault("label", Path(pkg_path).name or "本地标准 Skill ZIP")
            candidate_source["path"] = candidate.get("path", "")
            installed.append(self.install_standard_files(
                candidate["files"],
                source=candidate_source,
                allow_replace=allow_replace,
            ))
        return installed

    def install_archive(self, pkg_path: str) -> dict:
        """Auto-detect legacy ``.awu`` or portable Agent Skills ZIP files."""
        with zipfile.ZipFile(pkg_path, "r") as zf:
            names = {PurePosixPath(name).as_posix() for name in zf.namelist()}
        if "manifest.json" in names and "SKILL.md" in names:
            manifest = self.install_package(pkg_path)
            return {"format": "awu", "manifest": manifest, "skills": [manifest]}
        skills = self.install_standard_archive(pkg_path)
        return {
            "format": STANDARD_SKILL_FORMAT,
            "manifest": skills[0] if skills else None,
            "skills": skills,
        }

    # ── Secrets 管理 ─────────────────────────────────────────────────

    def get_secrets_schema(self, name: str) -> Optional[dict]:
        """读取 secrets.schema.json，返回字段定义（若不存在则返回 None）。"""
        name = self._validate_library_name(name)
        schema_file = LIBRARY_DIR / name / "secrets.schema.json"
        if schema_file.exists():
            try:
                return json.loads(schema_file.read_text(encoding="utf-8"))
            except Exception:
                return None
        return None

    def get_secrets(self, name: str) -> dict:
        """从本地安全存储读取 skill 凭据（永不传给大模型）。"""
        name = self._validate_library_name(name)
        path = SECRETS_DIR / f"{name}.json"
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                return {}
        return {}

    def set_secrets(self, name: str, secrets: dict) -> None:
        """持久化 skill 凭据到本地（chmod 600，仅 owner 可读）。"""
        name = self._validate_library_name(name)
        SECRETS_DIR.mkdir(parents=True, exist_ok=True)
        path = SECRETS_DIR / f"{name}.json"
        path.write_text(json.dumps(secrets, ensure_ascii=False), encoding="utf-8")
        try:
            path.chmod(0o600)
        except Exception:
            pass

    # ── 导出 / 导入 ─────────────────────────────────────────────────
    def export_library(self, target_path: str) -> bool:
        """把整个 skill-library 目录打包成 tar.gz。
        ⚠️ 凭据（skill-secrets/）永远不打包，跟随机器保留。
        """
        import tarfile
        try:
            if not LIBRARY_DIR.exists():
                return True
            with tarfile.open(target_path, "w:gz") as tar:
                for item in sorted(LIBRARY_DIR.iterdir()):
                    tar.add(item, arcname=item.name)
            return True
        except Exception as e:
            print(f"[SkillStore] export failed: {e}")
            return False

    def import_library(self, source_path: str) -> int:
        """从 tar.gz 恢复 skill-library。返回新增 skill 数量。
        策略：同名 skill 目录直接覆盖；index.json 做合并
        （activations 并集，isDefault 取或）。
        """
        import tarfile
        import tempfile
        try:
            with self._lock:
                with tempfile.TemporaryDirectory() as tmpdir:
                    with tarfile.open(source_path, "r:gz") as tar:
                        tar.extractall(tmpdir)
                    src = Path(tmpdir)
                    # 合并 index.json
                    imported_index: dict = {}
                    src_index = src / "index.json"
                    if src_index.exists():
                        try:
                            imported_index = json.loads(src_index.read_text(encoding="utf-8"))
                            if not isinstance(imported_index, dict):
                                imported_index = {}
                        except Exception:
                            imported_index = {}
                    # 复制 skill 目录
                    count = 0
                    for entry in src.iterdir():
                        if not entry.is_dir():
                            continue
                        dest = LIBRARY_DIR / entry.name
                        existed = dest.exists()
                        if existed:
                            shutil.rmtree(dest, ignore_errors=True)
                        dest.mkdir(parents=True, exist_ok=True)
                        # 白名单拷贝，防止非法文件
                        for f in entry.iterdir():
                            if f.is_file() and f.name in self._PKG_ALLOWED:
                                (dest / f.name).write_bytes(f.read_bytes())
                        if not existed:
                            count += 1
                    # 合并 index（activations 取并集，isDefault 取或）
                    for name, meta in imported_index.items():
                        if not isinstance(meta, dict):
                            continue
                        existing = self._index.get(name, {"activations": []})
                        merged_acts = list({
                            *existing.get("activations", []),
                            *meta.get("activations", []),
                        })
                        merged: dict = {"activations": merged_acts}
                        if existing.get("isDefault") or meta.get("isDefault"):
                            merged["isDefault"] = True
                        # Preserve package provenance so restored standard
                        # Skills can still be matched against market updates.
                        for key in ("format", "source"):
                            if key in meta:
                                merged[key] = meta[key]
                            elif key in existing:
                                merged[key] = existing[key]
                        self._index[name] = merged
                    self._save_index()
                return count
        except Exception as e:
            print(f"[SkillStore] import failed: {e}")
            return 0
