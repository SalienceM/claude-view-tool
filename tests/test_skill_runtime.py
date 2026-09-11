import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src.backend.skill_runtime import SkillRuntime
from src.backend.skill_store import SkillStore


class FakeStore:
    _validate_library_name = staticmethod(SkillStore._validate_library_name)

    def get_secrets(self, name):
        return {"TEST_SKILL_SECRET": "never-show-this"}

    def get_secrets_schema(self, name):
        return None


class SkillRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.library = self.root / "library"
        self.source = self.library / "demo"
        self.source.mkdir(parents=True)
        self.write("SKILL.md", "---\nname: demo\ndescription: example\n---\nInstructions")
        self.library_patch = patch("src.backend.skill_store.LIBRARY_DIR", self.library)
        self.library_patch.start()
        self.runtime = SkillRuntime(FakeStore(), self.root / "runtime")

    def tearDown(self):
        self.library_patch.stop()
        self.temp.cleanup()

    def write(self, name, content):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    async def complete(self, runtime=None):
        runtime = runtime or self.runtime
        task = runtime.tasks.get("demo")
        if task:
            await asyncio.wait_for(asyncio.shield(task), 45)

    def test_inspection_never_executes_code(self):
        self.write("scripts/run.py", "raise RuntimeError('must not execute')")
        self.write("requirements.txt", "Pillow>=9\n-r requirements/extra.txt")
        self.write("requirements/extra.txt", "PyYAML>=6")
        with patch.object(self.runtime, "_run", side_effect=AssertionError("must not run")):
            plan = self.runtime.review("demo")
        self.assertEqual(plan["status"], "needs_preparation")
        self.assertEqual(plan["requirements"], ["Pillow>=9", "PyYAML>=6"])
        self.assertEqual(plan["fileCount"], 4)
        self.assertTrue(plan["approvalToken"])
        self.assertFalse((self.root / "runtime/demo/state.json").exists())

    async def test_explicit_approval_and_node_local_state(self):
        with self.assertRaises(ValueError):
            await self.runtime.start("demo", "made-up")
        plan = self.runtime.review("demo")
        await self.runtime.start("demo", plan["approvalToken"])
        await self.complete()
        self.assertEqual(self.runtime.inspect("demo")["status"], "ready")
        other_node = SkillRuntime(FakeStore(), self.root / "other-node")
        self.assertEqual(other_node.inspect("demo")["status"], "needs_preparation")
        with self.assertRaises(ValueError):
            await other_node.start("demo", plan["approvalToken"])
        with self.assertRaises(ValueError):
            await self.runtime.start("demo", plan["approvalToken"])

    async def test_changed_resource_invalidates_approval(self):
        self.write("assets/template.txt", "old")
        plan = self.runtime.review("demo")
        self.write("assets/template.txt", "changed")
        with self.assertRaisesRegex(ValueError, "变化"):
            await self.runtime.start("demo", plan["approvalToken"])

    async def test_expired_approval_is_rejected(self):
        plan = self.runtime.review("demo")
        self.runtime.approvals[plan["approvalToken"]] = ("demo", plan["planHash"], 0)
        with self.assertRaises(ValueError):
            await self.runtime.start("demo", plan["approvalToken"])

    def test_missing_files_and_recursive_requirements(self):
        self.write("awu-runtime.json", json.dumps({"version": 1, "requiredFiles": ["assets/template.svg"]}))
        plan = self.runtime.inspect("demo")
        self.assertEqual(plan["status"], "blocked")
        self.assertIn("assets/template.svg", plan["blockers"][0])
        self.write("requirements.txt", "-r missing.txt")
        with self.assertRaisesRegex(ValueError, "缺少文件"):
            self.runtime.inspect("demo")
        self.write("requirements.txt", "-r requirements.txt")
        with self.assertRaisesRegex(ValueError, "循环"):
            self.runtime.inspect("demo")

    def test_traversal_and_untrusted_install_options(self):
        for name in ("../other", "/tmp", ".."):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.runtime.inspect(name)
        self.write("requirements.txt", "-r ../outside.txt")
        with self.assertRaisesRegex(ValueError, "越界"):
            self.runtime.inspect("demo")
        for line in ("--extra-index-url https://evil.example", "thing @ https://evil.example/pkg.whl", "-e ."):
            self.write("requirements.txt", line)
            plan = self.runtime.inspect("demo")
            self.assertTrue(plan["blockers"])
            self.assertEqual(plan["requirements"], [])

    def test_secrets_presence_does_not_leak_or_pretend_native_env_ready(self):
        self.write("awu-runtime.json", json.dumps({"version": 1, "requiredEnv": ["TEST_SKILL_SECRET"]}))
        with patch.dict(os.environ, {}, clear=True):
            plan = self.runtime.inspect("demo")
        self.assertEqual(plan["missingEnv"], ["TEST_SKILL_SECRET"])
        self.assertNotIn("never-show-this", json.dumps(plan))
        with patch.dict(os.environ, {"TEST_SKILL_SECRET": "private-env"}):
            plan = self.runtime.inspect("demo")
        self.assertEqual(plan["missingEnv"], [])
        self.assertNotIn("private-env", json.dumps(plan))

    def test_npm_lifecycle_and_lock_are_not_silently_run(self):
        self.write("package.json", json.dumps({"name": "demo", "scripts": {"postinstall": "dangerous"}}))
        with patch("shutil.which", return_value="/usr/bin/tool"):
            plan = self.runtime.inspect("demo")
        self.assertTrue(any("脚本" in item for item in plan["manualSteps"]))
        self.assertTrue(any("package-lock" in item for item in plan["blockers"]))
        self.write("package.json", '{"name":"demo"}')
        self.write("package-lock.json", json.dumps({"lockfileVersion": 3, "packages": {"node_modules/bad": {"link": True, "resolved": "../bad"}}}))
        with patch("shutil.which", return_value="/usr/bin/tool"):
            self.assertTrue(self.runtime.inspect("demo")["blockers"])

    async def test_failed_prepare_can_retry_and_keeps_logs(self):
        self.write("requirements.txt", "some-package==1")
        plan = self.runtime.review("demo")
        with patch.object(self.runtime, "_run", side_effect=RuntimeError("fake network failure")):
            await self.runtime.start("demo", plan["approvalToken"])
            await self.complete()
        failed = self.runtime.inspect("demo")
        self.assertEqual(failed["status"], "failed")
        self.assertIn("fake network failure", "\n".join(failed["lastRun"]["log"]))
        self.assertTrue(self.runtime.review("demo")["approvalToken"])

    async def test_pip_only_runs_in_private_venv(self):
        self.write("requirements.txt", "example==1")
        plan = self.runtime.review("demo")
        commands = []
        def run(argv, cwd, log):
            commands.append(argv)
            if "venv" in argv:
                python = Path(plan["pythonExecutable"])
                python.parent.mkdir(parents=True)
                python.touch()
        with patch.object(self.runtime, "_run", side_effect=run):
            await self.runtime.start("demo", plan["approvalToken"])
            await self.complete()
        pip = [a for a in commands if "pip" in a]
        self.assertEqual(len(pip), 2)
        self.assertTrue(all(a[0] == plan["pythonExecutable"] for a in pip))
        self.assertIn("--only-binary=:all:", pip[0])
        self.assertIn(plan["pythonExecutable"].replace("\\", "\\\\"), self.runtime.hint("demo"))

    async def test_real_offline_venv_and_declared_import_check(self):
        self.write("requirements.txt", "# standard-library only")
        self.write("awu-runtime.json", json.dumps({"version": 1, "pythonImports": ["json"]}))
        plan = self.runtime.review("demo")
        await self.runtime.start("demo", plan["approvalToken"])
        await self.complete()
        result = self.runtime.inspect("demo")
        self.assertEqual(result["status"], "ready", result["lastRun"])
        self.assertTrue(Path(plan["pythonExecutable"]).is_file())
        self.assertFalse((self.source / "venv").exists())
        self.write("SKILL.md", "changed")
        self.assertEqual(self.runtime.inspect("demo")["status"], "needs_preparation")
        self.assertEqual(self.runtime.hint("demo"), "")

    def test_restart_marks_unfinished_prepare_interrupted(self):
        plan = self.runtime.inspect("demo")
        self.runtime._save("demo", {"status": "preparing", "digest": plan["digest"]})
        result = self.runtime.inspect("demo")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["lastRun"]["status"], "interrupted")

    async def test_real_offline_node_directory(self):
        import shutil
        if not shutil.which("node") or not shutil.which("npm"):
            self.skipTest("Node/npm unavailable")
        self.write("package.json", json.dumps({"name": "qa-runtime", "version": "1.0.0"}))
        self.write("package-lock.json", json.dumps({"name": "qa-runtime", "version": "1.0.0", "lockfileVersion": 3,
            "packages": {"": {"name": "qa-runtime", "version": "1.0.0"}}}))
        self.write("scripts/main.mjs", "import fs from 'node:fs'; console.log(typeof fs.readFile)")
        plan = self.runtime.review("demo")
        await self.runtime.start("demo", plan["approvalToken"])
        await self.complete()
        state = self.runtime.inspect("demo")
        self.assertEqual(state["status"], "ready", state["lastRun"])
        self.assertTrue((Path(plan["environment"]) / "node/scripts/main.mjs").is_file())
        self.assertFalse((self.source / "node_modules").exists())

    async def test_duplicate_prepare_does_not_launch_second_job(self):
        import threading
        release = threading.Event()
        self.write("requirements.txt", "example==1")
        one = self.runtime.review("demo")
        two = self.runtime.review("demo")
        def run(*args):
            release.wait(5)
            raise RuntimeError("fixture finished")
        with patch.object(self.runtime, "_run", side_effect=run):
            await self.runtime.start("demo", one["approvalToken"])
            try:
                with self.assertRaisesRegex(ValueError, "正在准备"):
                    await self.runtime.start("demo", two["approvalToken"])
            finally:
                release.set()
                await self.complete()


if __name__ == "__main__":
    unittest.main()
