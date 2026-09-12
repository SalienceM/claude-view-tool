"""Portable Agent Skills discovery and installation.

The market deliberately consumes the open ``SKILL.md`` directory format.  It
does not depend on AgentWithU's legacy ``.awu`` manifest and it never executes
downloaded content during discovery or installation.

Remote sources are restricted to public GitHub repositories.  This keeps the
network boundary understandable, prevents arbitrary-URL SSRF from the Web UI,
and gives every catalog entry a human-auditable source URL.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx

from . import paths
from .skill_store import (
    MAX_STANDARD_ARCHIVE_BYTES,
    SkillStore,
    standard_skills_from_zip_bytes,
)


DEFAULT_SOURCES: list[dict] = [
    {
        "id": "anthropic-official",
        "name": "Anthropic 官方 Skills",
        "owner": "anthropics",
        "repo": "skills",
        "repository": "anthropics/skills",
        "ref": "main",
        "root": "skills",
        "official": True,
        "removable": False,
        "homepage": "https://github.com/anthropics/skills",
        "description": "Agent Skills 发起方公开的标准 Skill 示例与成品库",
    },
]

PUBLIC_DIRECTORIES: list[dict] = [
    {
        "name": "Agent Skills 开放规范",
        "url": "https://agentskills.io/specification",
        "description": "通用 SKILL.md 格式、元数据与目录结构规范",
    },
    {
        "name": "Anthropic Skills",
        "url": "https://github.com/anthropics/skills",
        "description": "已接入本市场的官方公开仓库",
    },
    {
        "name": "skills.sh",
        "url": "https://skills.sh",
        "description": "第三方 Agent Skills 发现目录；复制 GitHub 仓库地址即可接入 AWU",
    },
]

_OWNER_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_REPO_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
CACHE_TTL_SECONDS = 15 * 60


def _json_safe(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)


def _display_value(value) -> str:
    safe = _json_safe(value)
    if safe is None:
        return ""
    if isinstance(safe, str):
        return safe
    if isinstance(safe, list):
        return ", ".join(str(item) for item in safe)
    return json.dumps(safe, ensure_ascii=False)


def parse_github_source(value: str, *, name: str = "") -> dict:
    """Parse ``owner/repo`` or a public GitHub repository/tree URL."""
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("请输入 GitHub 仓库地址或 owner/repo")

    ref = "main"
    root = ""
    if raw.startswith(("https://", "http://")):
        parsed = urlparse(raw)
        if parsed.scheme != "https" or parsed.hostname not in {"github.com", "www.github.com"}:
            raise ValueError("为避免 SSRF，市场来源仅支持 https://github.com 公共仓库")
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) < 2:
            raise ValueError("GitHub 地址缺少 owner/repo")
        owner, repo = parts[0], parts[1]
        if repo.endswith(".git"):
            repo = repo[:-4]
        if len(parts) >= 4 and parts[2] == "tree":
            ref = parts[3]
            root = "/".join(parts[4:])
        elif len(parts) > 2:
            raise ValueError("请使用仓库首页或 /tree/<branch>/<path> 地址")
    else:
        shorthand, separator, fragment = raw.partition("#")
        if separator:
            root = fragment.strip("/")
        pieces = [part for part in shorthand.strip("/").split("/") if part]
        if len(pieces) != 2:
            raise ValueError("简写格式应为 owner/repo，可用 #path 限定子目录")
        owner, repo_ref = pieces
        if "@" in repo_ref:
            repo, ref = repo_ref.rsplit("@", 1)
        else:
            repo = repo_ref
        if repo.endswith(".git"):
            repo = repo[:-4]

    if not _OWNER_RE.fullmatch(owner) or not _REPO_RE.fullmatch(repo):
        raise ValueError("GitHub owner 或 repo 格式不合法")
    if not ref or any(part in {"", ".", ".."} for part in ref.split("/")):
        raise ValueError("GitHub ref 格式不合法")
    root_parts = [part for part in root.replace("\\", "/").split("/") if part]
    if any(part in {".", ".."} for part in root_parts):
        raise ValueError("Skill 来源子目录不合法")
    root = "/".join(root_parts)

    repository = f"{owner}/{repo}"
    identity = f"{repository}@{ref}#{root}"
    source_id = "github-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
    homepage = f"https://github.com/{repository}"
    if root:
        homepage += f"/tree/{ref}/{root}"
    return {
        "id": source_id,
        "name": str(name or "").strip() or repository,
        "owner": owner,
        "repo": repo,
        "repository": repository,
        "ref": ref,
        "root": root,
        "official": False,
        "removable": True,
        "homepage": homepage,
        "description": "用户添加的 GitHub Agent Skills 来源",
    }


class SkillMarket:
    def __init__(
        self,
        skill_store: SkillStore,
        *,
        data_dir: Optional[Path] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        self._skill_store = skill_store
        self._data_dir = Path(data_dir) if data_dir else paths.sub("skill-market")
        self._sources_file = self._data_dir / "sources.json"
        self._transport = transport
        self._archive_cache: dict[str, tuple[float, bytes, str]] = {}
        self._catalog_cache: dict[
            str, tuple[float, list[dict], str, list[dict]]
        ] = {}
        self._custom_sources = self._load_custom_sources()
        self._repository_cache: dict[str, tuple[float, dict]] = {}

    async def _repository_info(self, source: dict, *, force: bool = False) -> dict:
        """可选的仓库级参考信息；限流/失败不影响 Skill 目录或安装。"""
        repository = source["repository"]
        cached = self._repository_cache.get(repository)
        if cached and not force and time.time() - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]
        kwargs = self._client_kwargs()
        kwargs.update(timeout=httpx.Timeout(4.0), follow_redirects=False)
        kwargs["headers"] = {"User-Agent": "AgentWithU-SkillMarket/1.0", "Accept": "application/vnd.github+json"}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        info: dict = {"checkedAt": int(time.time())}
        async with httpx.AsyncClient(**kwargs) as client:
            async def read(suffix: str) -> dict:
                response = await client.get(f"https://api.github.com/repos/{repository}{suffix}")
                response.raise_for_status()
                data = response.json()
                if not isinstance(data, dict):
                    raise ValueError("Invalid GitHub metadata")
                return data
            repo, release = await asyncio.gather(read(""), read("/releases/latest"), return_exceptions=True)
        if isinstance(repo, dict):
            stars = repo.get("stargazers_count")
            if isinstance(stars, int) and stars >= 0:
                info["stars"] = stars
            info["pushedAt"] = str(repo.get("pushed_at") or "")[:40]
            info["archived"] = bool(repo.get("archived"))
        else:
            info["error"] = "仓库热度/更新时间暂不可用（网络或 GitHub 限流）；不影响安装"
        if isinstance(release, dict):
            info["latestRelease"] = str(release.get("tag_name") or "")[:200]
            info["releasePublishedAt"] = str(release.get("published_at") or "")[:40]
        self._repository_cache[repository] = (time.time(), info)
        return info

    def _load_custom_sources(self) -> list[dict]:
        if not self._sources_file.exists():
            return []
        try:
            payload = json.loads(self._sources_file.read_text(encoding="utf-8"))
        except Exception:
            return []
        if not isinstance(payload, list):
            return []
        result: list[dict] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            try:
                parsed = parse_github_source(
                    item.get("homepage") or item.get("repository") or "",
                    name=str(item.get("name") or ""),
                )
            except ValueError:
                continue
            # A persisted shorthand cannot express a non-main ref/root unless
            # we restore those explicit validated fields.
            parsed["ref"] = str(item.get("ref") or parsed["ref"])
            parsed["root"] = str(item.get("root") or parsed["root"]).strip("/")
            identity = f"{parsed['repository']}@{parsed['ref']}#{parsed['root']}"
            parsed["id"] = "github-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
            result.append(parsed)
        return result

    def _save_custom_sources(self) -> None:
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._sources_file.write_text(
            json.dumps(self._custom_sources, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def list_sources(self) -> list[dict]:
        seen: set[str] = set()
        result: list[dict] = []
        for source in [*DEFAULT_SOURCES, *self._custom_sources]:
            if source["id"] in seen:
                continue
            seen.add(source["id"])
            result.append(dict(source))
        return result

    def add_source(self, value: str, name: str = "") -> dict:
        source = parse_github_source(value, name=name)
        existing = next((
            item for item in self.list_sources()
            if (
                item.get("repository"), item.get("ref"), item.get("root", "")
            ) == (
                source.get("repository"), source.get("ref"), source.get("root", "")
            )
        ), None)
        if existing:
            return existing
        self._custom_sources.append(source)
        self._save_custom_sources()
        return source

    def remove_source(self, source_id: str) -> bool:
        before = len(self._custom_sources)
        self._custom_sources = [
            source for source in self._custom_sources if source.get("id") != source_id
        ]
        changed = len(self._custom_sources) != before
        if changed:
            self._save_custom_sources()
            self._archive_cache.pop(source_id, None)
            self._catalog_cache.pop(source_id, None)
        return changed

    @staticmethod
    def _source_by_id(sources: list[dict], source_id: str) -> dict:
        source = next((item for item in sources if item.get("id") == source_id), None)
        if not source:
            raise ValueError("Skill 市场来源不存在或已被移除")
        return source

    @staticmethod
    def _client_kwargs() -> dict:
        kwargs: dict = {
            "follow_redirects": True,
            "timeout": httpx.Timeout(20.0, read=90.0),
            "headers": {
                "User-Agent": "AgentWithU-SkillMarket/1.0",
                "Accept": "application/zip, application/octet-stream",
            },
        }
        if getattr(sys, "frozen", False):
            try:
                import certifi
                kwargs["verify"] = certifi.where()
            except Exception:
                pass
        return kwargs

    async def _download_archive(self, source: dict, *, force: bool = False) -> tuple[bytes, str]:
        source_id = source["id"]
        cached = self._archive_cache.get(source_id)
        if cached and not force and time.time() - cached[0] < CACHE_TTL_SECONDS:
            return cached[1], cached[2]

        refs = [str(source.get("ref") or "main")]
        if refs[0] == "main":
            refs.append("master")
        last_error = ""
        kwargs = self._client_kwargs()
        if self._transport is not None:
            kwargs["transport"] = self._transport
        async with httpx.AsyncClient(**kwargs) as client:
            for ref in refs:
                url = (
                    f"https://codeload.github.com/{source['owner']}/{source['repo']}"
                    f"/zip/refs/heads/{ref}"
                )
                try:
                    async with client.stream("GET", url) as response:
                        if response.status_code == 404:
                            last_error = f"分支 {ref} 不存在"
                            continue
                        response.raise_for_status()
                        content_length = int(response.headers.get("content-length") or 0)
                        if content_length > MAX_STANDARD_ARCHIVE_BYTES:
                            raise ValueError("远程 Skill 仓库压缩包超过 64 MiB")
                        chunks: list[bytes] = []
                        size = 0
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            if size > MAX_STANDARD_ARCHIVE_BYTES:
                                raise ValueError("远程 Skill 仓库压缩包超过 64 MiB")
                            chunks.append(chunk)
                        data = b"".join(chunks)
                        self._archive_cache[source_id] = (time.time(), data, ref)
                        return data, ref
                except (httpx.HTTPError, ValueError) as exc:
                    last_error = str(exc)
                    if ref != refs[-1]:
                        continue
                    raise
        raise ValueError(last_error or "无法下载 GitHub Skill 仓库")

    async def _catalog_for_source(
        self,
        source: dict,
        *,
        force: bool = False,
    ) -> tuple[list[dict], str, list[dict]]:
        source_id = source["id"]
        cached = self._catalog_cache.get(source_id)
        if cached and not force and time.time() - cached[0] < CACHE_TTL_SECONDS:
            return cached[1], cached[2], cached[3]
        archive, effective_ref = await self._download_archive(source, force=force)
        issues: list[dict] = []
        inspected = await asyncio.to_thread(
            standard_skills_from_zip_bytes,
            archive,
            str(source.get("root") or ""),
            skip_invalid=True,
            issues=issues,
            repository_mode=True,
        )
        self._catalog_cache[source_id] = (
            time.time(), inspected, effective_ref, issues,
        )
        return inspected, effective_ref, issues

    def _public_item(self, source: dict, candidate: dict, effective_ref: str, repository_info: Optional[dict] = None) -> dict:
        name = candidate["name"]
        installed = self._skill_store.get_skill(name)
        installed_source = installed.get("source") if installed else None
        same_source = bool(
            isinstance(installed_source, dict)
            and installed_source.get("kind") == "github"
            and installed_source.get("repository") == source.get("repository")
            and installed_source.get("ref") == effective_ref
            and installed_source.get("path", "") == candidate.get("path", "")
        )
        installed_digest = (
            str(installed_source.get("digest") or "")
            if isinstance(installed_source, dict) else ""
        )
        dirty = bool(installed_source.get("dirty")) if isinstance(installed_source, dict) else False
        digest = candidate["digest"]
        item_identity = f"{source['id']}:{candidate.get('path', '')}:{name}"
        item_id = hashlib.sha256(item_identity.encode("utf-8")).hexdigest()[:20]
        frontmatter = candidate.get("frontmatter") or {}
        markdown = candidate.get("content", "")
        return {
            "id": item_id,
            "name": name,
            "description": candidate.get("description", ""),
            "path": candidate.get("path", ""),
            "digest": digest,
            "sourceId": source["id"],
            "sourceName": source["name"],
            "repository": source["repository"],
            "ref": effective_ref,
            "homepage": source["homepage"],
            "official": bool(source.get("official")),
            "license": _display_value(frontmatter.get("license", "")),
            "compatibility": _display_value(frontmatter.get("compatibility", "")),
            "metadata": _json_safe(frontmatter.get("metadata")) if isinstance(frontmatter.get("metadata"), dict) else {},
            "version": _display_value((frontmatter.get("metadata") or {}).get("version", ""))
            if isinstance(frontmatter.get("metadata"), dict) else "",
            "repositoryInfo": repository_info or {},
            "fileNames": candidate.get("fileNames", []),
            "fileCount": candidate.get("fileCount", 0),
            "size": candidate.get("size", 0),
            "risk": candidate.get("risk", {"level": "low", "flags": []}),
            "warnings": candidate.get("warnings", []),
            "preview": markdown[:32000],
            "previewTruncated": len(markdown) > 32000,
            "installed": bool(installed),
            "sameSource": same_source,
            "localModified": dirty,
            "updateAvailable": bool(same_source and (dirty or installed_digest != digest)),
            "conflict": bool(installed and not same_source),
        }

    async def list_catalog(self, query: str = "", *, force: bool = False) -> dict:
        sources = self.list_sources()

        async def load(
            source: dict,
        ) -> tuple[dict, list[dict], str, str, list[dict]]:
            try:
                candidates, effective_ref, issues = await self._catalog_for_source(
                    source, force=force,
                )
                return source, candidates, effective_ref, "", issues
            except Exception as exc:
                print(
                    f"[SkillMarket] source {source.get('repository') or source.get('id')} failed: {exc}",
                    file=sys.stderr,
                )
                return source, [], str(source.get("ref") or "main"), str(exc), []

        catalogs, repository_infos = await asyncio.gather(
            asyncio.gather(*(load(source) for source in sources)),
            asyncio.gather(*(self._repository_info(source, force=force) for source in sources), return_exceptions=True),
        )
        loaded = catalogs
        items: list[dict] = []
        public_sources: list[dict] = []
        for index, (source, candidates, effective_ref, error, issues) in enumerate(loaded):
            repository_info = repository_infos[index] if isinstance(repository_infos[index], dict) else {
                "error": "仓库参考信息暂不可用；不影响安装",
            }
            source_payload = dict(source)
            source_payload["error"] = error
            source_payload["skillCount"] = len(candidates)
            source_payload["skippedCount"] = len(issues)
            source_payload["issues"] = issues
            source_payload["effectiveRef"] = effective_ref
            source_payload["repositoryInfo"] = repository_info
            public_sources.append(source_payload)
            for candidate in candidates:
                items.append(self._public_item(source, candidate, effective_ref, repository_info))

        needle = str(query or "").strip().casefold()
        if needle:
            items = [
                item for item in items
                if needle in " ".join((
                    str(item.get("name") or ""),
                    str(item.get("description") or ""),
                    str(item.get("sourceName") or ""),
                    str(item.get("repository") or ""),
                    str(item.get("path") or ""),
                )).casefold()
            ]
        items.sort(key=lambda item: (
            not bool(item.get("updateAvailable")),
            not bool(item.get("official")),
            str(item.get("name") or ""),
        ))
        return {
            "status": "ok",
            "sources": public_sources,
            "directories": PUBLIC_DIRECTORIES,
            "items": items,
            "query": query,
            "refreshedAt": int(time.time()),
        }

    async def install(
        self,
        source_id: str,
        path: str,
        digest: str,
        *,
        allow_replace: bool = False,
    ) -> dict:
        source = self._source_by_id(self.list_sources(), source_id)
        candidates, effective_ref, _issues = await self._catalog_for_source(
            source, force=False,
        )
        candidate = next((
            item for item in candidates
            if str(item.get("path") or "") == str(path or "")
            and str(item.get("digest") or "") == str(digest or "")
        ), None)
        if not candidate:
            raise ValueError("市场条目已变化，请刷新后重新检查再安装")

        existing = self._skill_store.get_skill(candidate["name"])
        existing_source = existing.get("source") if existing else None
        same_source = bool(
            isinstance(existing_source, dict)
            and existing_source.get("kind") == "github"
            and existing_source.get("repository") == source.get("repository")
            and existing_source.get("ref") == effective_ref
            and existing_source.get("path", "") == candidate.get("path", "")
        )
        if existing and not same_source and not allow_replace:
            raise FileExistsError(
                f"本地已存在同名 Skill '{candidate['name']}'；预览确认后才可覆盖"
            )

        source_meta = {
            "kind": "github",
            "sourceId": source["id"],
            "label": source["name"],
            "repository": source["repository"],
            "ref": effective_ref,
            "path": candidate.get("path", ""),
            "url": source["homepage"],
        }
        return self._skill_store.install_standard_files(
            candidate["files"],
            source=source_meta,
            allow_replace=bool(existing is None or same_source or allow_replace),
        )
