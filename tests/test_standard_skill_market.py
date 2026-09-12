import asyncio
import io
import json
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import httpx

from src.backend.bridge_ws import BridgeWS
from src.backend.skill_market import SkillMarket, parse_github_source
from src.backend.skill_paths import project_skill_reference
from src.backend.skill_store import SkillStore, standard_skills_from_zip_bytes
from src.types import BackendType, ModelBackendConfig


def make_zip(files: dict[str, bytes | str]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            data = content.encode("utf-8") if isinstance(content, str) else content
            archive.writestr(name, data)
    return output.getvalue()


def make_zip_with_symlink(
    files: dict[str, bytes | str],
    link_name: str,
    link_target: str,
) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            data = content.encode("utf-8") if isinstance(content, str) else content
            archive.writestr(name, data)
        link = zipfile.ZipInfo(link_name)
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, link_target)
    return output.getvalue()


STANDARD_MD = """---
name: portable-demo
description: Demonstrate a portable multi-file Agent Skill.
license: MIT
compatibility: Python 3.10+
---

## Instructions

Read `references/guide.md`, then run `scripts/check.py` when requested.
"""


class StandardArchiveInspectionTests(unittest.TestCase):
    def test_github_archive_discovers_complete_skill_directory(self):
        archive = make_zip({
            "repo-main/README.md": "repo",
            "repo-main/skills/portable-demo/SKILL.md": STANDARD_MD,
            "repo-main/skills/portable-demo/scripts/check.py": "print('ok')\n",
            "repo-main/skills/portable-demo/references/guide.md": "guide\n",
        })

        skills = standard_skills_from_zip_bytes(archive, "skills")

        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0]["name"], "portable-demo")
        self.assertEqual(skills[0]["path"], "skills/portable-demo")
        self.assertEqual(
            skills[0]["fileNames"],
            ["SKILL.md", "references/guide.md", "scripts/check.py"],
        )
        self.assertEqual(skills[0]["risk"]["level"], "medium")

    def test_archive_rejects_path_traversal(self):
        archive = make_zip({
            "portable-demo/SKILL.md": STANDARD_MD,
            "../outside.txt": "bad",
        })
        with self.assertRaisesRegex(ValueError, "不安全路径"):
            standard_skills_from_zip_bytes(archive)

    def test_archive_requires_open_standard_frontmatter(self):
        archive = make_zip({
            "bad/SKILL.md": "---\nname: bad\n---\nNo description\n",
        })
        with self.assertRaisesRegex(ValueError, "description"):
            standard_skills_from_zip_bytes(archive)

    def test_local_skill_archive_still_rejects_symbolic_links(self):
        archive = make_zip_with_symlink(
            {"portable-demo/SKILL.md": STANDARD_MD},
            "portable-demo/references/current.md",
            "guide.md",
        )

        with self.assertRaisesRegex(ValueError, "符号链接"):
            standard_skills_from_zip_bytes(archive)

    def test_repository_catalog_ignores_unrelated_root_symbolic_link(self):
        archive = make_zip_with_symlink(
            {"repo-main/skills/portable-demo/SKILL.md": STANDARD_MD},
            "repo-main/AGENTS.md",
            "CLAUDE.md",
        )
        issues: list[dict] = []

        skills = standard_skills_from_zip_bytes(
            archive,
            skip_invalid=True,
            issues=issues,
            repository_mode=True,
        )

        self.assertEqual([skill["name"] for skill in skills], ["portable-demo"])
        self.assertEqual(issues, [])

    def test_repository_catalog_skips_only_skill_that_contains_symbolic_link(self):
        unsafe_md = STANDARD_MD.replace("portable-demo", "unsafe-demo")
        archive = make_zip_with_symlink(
            {
                "repo-main/skills/portable-demo/SKILL.md": STANDARD_MD,
                "repo-main/skills/unsafe-demo/SKILL.md": unsafe_md,
            },
            "repo-main/skills/unsafe-demo/references/current.md",
            "guide.md",
        )
        issues: list[dict] = []

        skills = standard_skills_from_zip_bytes(
            archive,
            skip_invalid=True,
            issues=issues,
            repository_mode=True,
        )

        self.assertEqual([skill["name"] for skill in skills], ["portable-demo"])
        self.assertEqual(issues[0]["path"], "skills/unsafe-demo")
        self.assertIn("符号链接", issues[0]["message"])

    def test_repository_catalog_ignores_unrelated_files_and_skips_bad_skill(self):
        files: dict[str, bytes | str] = {
            f"repo-main/docs/unrelated-{index}.txt": "not part of the Skill source"
            for index in range(520)
        }
        files.update({
            "repo-main/skills/portable-demo/SKILL.md": STANDARD_MD,
            "repo-main/skills/invalid-demo/SKILL.md": (
                "---\nname: invalid-demo\ndescription: " + ("x" * 1025) + "\n---\n"
            ),
        })
        issues: list[dict] = []

        skills = standard_skills_from_zip_bytes(
            make_zip(files),
            "skills",
            skip_invalid=True,
            issues=issues,
            repository_mode=True,
        )

        self.assertEqual([skill["name"] for skill in skills], ["portable-demo"])
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["path"], "skills/invalid-demo")
        self.assertIn("description", issues[0]["message"])


class StandardSkillStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.library = base / "library"
        self.secrets = base / "secrets"
        self.index = self.library / "index.json"
        self.patchers = [
            patch("src.backend.skill_store.LIBRARY_DIR", self.library),
            patch("src.backend.skill_store.INDEX_FILE", self.index),
            patch("src.backend.skill_store.SECRETS_DIR", self.secrets),
        ]
        for patcher in self.patchers:
            patcher.start()
        self.store = SkillStore()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def test_standard_zip_installs_and_session_binding_deploys_all_files(self):
        package = Path(self.temp.name) / "portable.zip"
        package.write_bytes(make_zip({
            "portable-demo/SKILL.md": STANDARD_MD.replace(
                "scripts/check.py", "{{SKILL_DIR}}/scripts/check.py"
            ),
            "portable-demo/scripts/check.py": "print('ok')\n",
            "portable-demo/references/guide.md": "guide\n",
        }))

        result = self.store.install_archive(str(package))
        self.assertEqual(result["format"], "agent-skills")
        self.assertTrue((self.library / "portable-demo" / "scripts" / "check.py").exists())

        bridge = BridgeWS.__new__(BridgeWS)
        bridge._skill_store = self.store
        bridge._backend_configs = []
        deploy_root = Path(self.temp.name) / "workspace" / ".agents" / "skills"
        bridge._skill_deploy_roots_for_session = lambda _session: [("codex", deploy_root)]
        session = type("SessionStub", (), {
            "abilities": {"skills": ["portable-demo"]},
        })()

        bridge._sync_backend_skills_to_directory(session)

        deployed = deploy_root / "portable-demo"
        rendered = (deployed / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn(
            f"{project_skill_reference('codex', 'portable-demo')}/scripts/check.py",
            rendered,
        )
        self.assertTrue((deployed / "scripts" / "check.py").exists())
        self.assertTrue((deployed / "references" / "guide.md").exists())

        # Unbinding removes only AgentWithU-managed files and preserves a user
        # note that was created beside the deployed Skill.
        (deployed / "my-note.txt").write_text("keep", encoding="utf-8")
        session.abilities = {"skills": []}
        bridge._sync_backend_skills_to_directory(session)
        self.assertFalse((deployed / "SKILL.md").exists())
        self.assertTrue((deployed / "my-note.txt").exists())

    def test_legacy_awu_package_remains_supported(self):
        package = Path(self.temp.name) / "legacy.awu"
        manifest = {
            "id": "legacy-demo",
            "name": "Legacy Demo",
            "version": "1.2.3",
            "description": "legacy",
        }
        package.write_bytes(make_zip({
            "manifest.json": json.dumps(manifest),
            "SKILL.md": "---\nname: legacy-demo\ndescription: legacy\n---\n",
            "call.py": "print('ok')\n",
        }))

        result = self.store.install_archive(str(package))

        self.assertEqual(result["format"], "awu")
        self.assertEqual(result["manifest"]["version"], "1.2.3")
        self.assertEqual(self.store.get_skill("legacy-demo")["format"], "awu")

    def test_direct_api_backend_receives_standard_skill_instruction_fallback(self):
        self.store.install_standard_files({
            "SKILL.md": STANDARD_MD.replace(
                "scripts/check.py", "{{SKILL_DIR}}/scripts/check.py"
            ).encode("utf-8"),
            "scripts/check.py": b"print('ok')\n",
        })
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._skill_store = self.store
        bridge._prompt_store = type("PromptStoreStub", (), {
            "get_prompt": lambda _self, _name: None,
        })()
        bridge._backend_configs = [ModelBackendConfig(
            id="api",
            type=BackendType.OPENAI_COMPATIBLE,
            label="API",
        )]
        bridge._skill_deploy_roots_for_session = lambda _session: [
            ("codex", Path(self.temp.name) / "workspace" / ".agents" / "skills"),
        ]
        bridge._sync_backend_skills_to_directory = lambda _session: None
        session = type("SessionStub", (), {
            "backend_id": "api",
            "sandbox_enabled": False,
        })()

        bridge._apply_session_abilities(session, {
            "skills": ["portable-demo"], "prompts": [],
        })

        self.assertIn("已绑定标准 Agent Skill：portable-demo", session.constraints)
        self.assertIn(".agents/skills/portable-demo/scripts/check.py", session.constraints)


class SkillMarketTests(unittest.TestCase):
    def test_github_source_parser_accepts_repo_and_tree_urls(self):
        shorthand = parse_github_source("example/skills")
        tree = parse_github_source("https://github.com/example/skills/tree/dev/catalog")
        self.assertEqual(shorthand["repository"], "example/skills")
        self.assertEqual(shorthand["ref"], "main")
        self.assertEqual(tree["ref"], "dev")
        self.assertEqual(tree["root"], "catalog")

    def test_github_source_parser_rejects_arbitrary_hosts(self):
        with self.assertRaisesRegex(ValueError, "SSRF"):
            parse_github_source("https://example.com/owner/repo")

    def test_market_lists_previews_and_installs_without_executing(self):
        archive = make_zip({
            "skills-main/catalog/portable-demo/SKILL.md": STANDARD_MD,
            "skills-main/catalog/portable-demo/scripts/check.py": "raise SystemExit('must not execute')\n",
        })

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "api.github.com":
                return httpx.Response(403, json={"message": "rate limited"}, request=request)
            self.assertEqual(request.url.host, "codeload.github.com")
            return httpx.Response(200, content=archive, request=request)

        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch("src.backend.skill_store.LIBRARY_DIR", Path(tmp) / "library"),
                patch("src.backend.skill_store.INDEX_FILE", Path(tmp) / "library" / "index.json"),
                patch("src.backend.skill_store.SECRETS_DIR", Path(tmp) / "secrets"),
                patch("src.backend.skill_market.DEFAULT_SOURCES", []),
            ):
                store = SkillStore()
                market = SkillMarket(
                    store,
                    data_dir=Path(tmp) / "market",
                    transport=httpx.MockTransport(handler),
                )
                source = market.add_source("https://github.com/example/skills/tree/main/catalog")

                catalog = asyncio.run(market.list_catalog())
                self.assertEqual(catalog["status"], "ok")
                self.assertEqual(len(catalog["items"]), 1)
                item = catalog["items"][0]
                self.assertIn("## Instructions", item["preview"])
                # The script itself appears in the file/risk audit; it is never
                # imported or executed during listing/installation.
                self.assertIn("scripts/check.py", item["fileNames"])

                installed = asyncio.run(market.install(
                    source["id"], item["path"], item["digest"], allow_replace=False,
                ))
                self.assertEqual(installed["name"], "portable-demo")
                info = store.get_skill("portable-demo")
                self.assertEqual(info["format"], "agent-skills")
                self.assertEqual(info["source"]["kind"], "github")

    def test_market_keeps_valid_items_when_one_repository_skill_is_invalid(self):
        archive = make_zip({
            "skills-main/catalog/portable-demo/SKILL.md": STANDARD_MD,
            "skills-main/catalog/invalid-demo/SKILL.md": (
                "---\nname: invalid-demo\ndescription: " + ("x" * 1025) + "\n---\n"
            ),
        })

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=archive, request=request)

        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch("src.backend.skill_store.LIBRARY_DIR", Path(tmp) / "library"),
                patch("src.backend.skill_store.INDEX_FILE", Path(tmp) / "library" / "index.json"),
                patch("src.backend.skill_store.SECRETS_DIR", Path(tmp) / "secrets"),
                patch("src.backend.skill_market.DEFAULT_SOURCES", []),
            ):
                market = SkillMarket(
                    SkillStore(),
                    data_dir=Path(tmp) / "market",
                    transport=httpx.MockTransport(handler),
                )
                market.add_source("https://github.com/example/skills/tree/main/catalog")

                catalog = asyncio.run(market.list_catalog())

        self.assertEqual([item["name"] for item in catalog["items"]], ["portable-demo"])
        self.assertEqual(catalog["sources"][0]["error"], "")
        self.assertEqual(catalog["sources"][0]["skillCount"], 1)
        self.assertEqual(catalog["sources"][0]["skippedCount"], 1)
        self.assertIn("description", catalog["sources"][0]["issues"][0]["message"])

    def test_repository_metadata_is_cached_separate_from_skill_version(self):
        archive = make_zip({"skills-main/portable-demo/SKILL.md": STANDARD_MD.replace(
            "license: MIT", "license: MIT\nmetadata:\n  version: 1.2.3",
        )})
        requests = []
        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(str(request.url))
            if request.url.host == "codeload.github.com":
                return httpx.Response(200, content=archive)
            if request.url.path.endswith("/releases/latest"):
                return httpx.Response(200, json={"tag_name": "repo-v9", "published_at": "2026-09-01T00:00:00Z"})
            return httpx.Response(200, json={"stargazers_count": 1234, "pushed_at": "2026-09-10T00:00:00Z", "archived": False})
        with tempfile.TemporaryDirectory() as tmp, patch("src.backend.skill_market.DEFAULT_SOURCES", []):
            market = SkillMarket(SkillStore(), data_dir=Path(tmp), transport=httpx.MockTransport(handler))
            market.add_source("example/skills")
            first = asyncio.run(market.list_catalog())
            second = asyncio.run(market.list_catalog())
            self.assertEqual(len(requests), 3)
            item = first["items"][0]
            self.assertEqual(item["version"], "1.2.3")
            self.assertEqual(item["repositoryInfo"]["latestRelease"], "repo-v9")
            self.assertEqual(item["repositoryInfo"]["stars"], 1234)
            self.assertEqual(item["digest"], second["items"][0]["digest"])
            asyncio.run(market.list_catalog(force=True))
            self.assertEqual(len(requests), 6)

    def test_metadata_failure_does_not_hide_catalog_or_invent_zero_stars(self):
        archive = make_zip({"skills-main/portable-demo/SKILL.md": STANDARD_MD})
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "codeload.github.com":
                return httpx.Response(200, content=archive)
            return httpx.Response(403, json={"message": "rate limited"})
        with tempfile.TemporaryDirectory() as tmp, patch("src.backend.skill_market.DEFAULT_SOURCES", []):
            market = SkillMarket(SkillStore(), data_dir=Path(tmp), transport=httpx.MockTransport(handler))
            market.add_source("example/skills")
            result = asyncio.run(market.list_catalog())
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["items"][0]["version"], "")
        self.assertNotIn("stars", result["items"][0]["repositoryInfo"])
        self.assertIn("不影响安装", result["items"][0]["repositoryInfo"]["error"])


if __name__ == "__main__":
    unittest.main()
