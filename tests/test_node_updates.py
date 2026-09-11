import asyncio
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from scripts import publish_updates, stamp_version as version_stamper
from src.backend import update_manager as update_module
from src.backend.bridge_ws import (
    BridgeWS,
    _REQUEST_CAN_CLAIM_LEGACY,
    _REQUEST_IDENTITY_SOURCE,
)
from src.backend.update_helper import run_update_helper
from src.backend.update_manager import UpdateManager, _canonical_manifest_payload


class NodeUpdateManagerTests(unittest.TestCase):
    def setUp(self):
        # CI itself may run inside Docker; individual tests opt into Docker
        # routing explicitly instead of inheriting the test runner boundary.
        self._runtime_patch = mock.patch.dict(
            os.environ, {"AGENT_WITH_U_RUNTIME": "headless"}, clear=False,
        )
        self._runtime_patch.start()

    def tearDown(self):
        self._runtime_patch.stop()

    def _fixture(self, root: Path, *, signed: bool = False):
        artifact = root / "arbitrary payload.bin"
        artifact.write_bytes(b"agentwithu-update-payload\n")
        release = {
            "version": "99.1.1.120000",
            "buildId": "20990101120000-test",
            "sequence": 20990101120000,
            "notes": "fixture",
        }
        manifest = {
            "schemaVersion": 1,
            "channel": "stable",
            "release": release,
            "artifacts": [{
                "id": "fixture",
                "platform": update_module._platform(),
                "arch": update_module._arch(),
                "target": "executor",
                "kind": "custom",
                "fileName": artifact.name,
                "url": str(artifact),
                "size": artifact.stat().st_size,
                "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                "install": {
                    "program": sys.executable,
                    "args": ["-c", "raise SystemExit(0)", "{artifact}"],
                },
            }],
        }
        if signed:
            manifest["signature"] = {
                "algorithm": "hmac-sha256",
                "value": hmac.new(
                    b"fixture-secret",
                    _canonical_manifest_payload(manifest),
                    hashlib.sha256,
                ).hexdigest(),
            }
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return artifact, manifest_path

    def test_stage_accepts_any_format_with_explicit_argv_installer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, manifest_path = self._fixture(root)
            manager = UpdateManager(root / "updates")
            manager.configure({"manifestUrl": str(manifest_path)})

            async def scenario():
                started = await manager.start_stage()
                self.assertEqual("downloading", started["phase"])
                await manager._task

            asyncio.run(scenario())
            status = manager.status()
            self.assertEqual("staged", status["phase"])
            self.assertEqual(status["downloadedBytes"], status["totalBytes"])
            plan = json.loads(Path(status["planPath"]).read_text(encoding="utf-8"))
            self.assertEqual("agentwithu-update-plan-v1", plan["marker"])
            self.assertEqual(sys.executable, plan["install"]["program"])
            self.assertIn(str(Path(status["stagedPath"])), plan["install"]["args"])

    def test_signed_manifest_is_verified_before_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, manifest_path = self._fixture(root, signed=True)
            manager = UpdateManager(root / "updates")
            manager.configure({
                "manifestUrl": str(manifest_path),
                "requireSignature": True,
                "signatureKey": "fixture-secret",
            })
            status = asyncio.run(manager.check())
            self.assertEqual("available", status["phase"])
            self.assertTrue(status["manifestSigned"])

            manager.configure({"signatureKey": "wrong-secret"})
            with self.assertRaisesRegex(Exception, "signature verification failed"):
                asyncio.run(manager.check())
            self.assertEqual("error", manager.status()["phase"])

    def test_checksum_failure_never_produces_install_plan(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact, manifest_path = self._fixture(root)
            manager = UpdateManager(root / "updates")
            manager.configure({"manifestUrl": str(manifest_path)})
            artifact.write_bytes(b"tampered-after-manifest")

            async def scenario():
                await manager.start_stage()
                await manager._task

            asyncio.run(scenario())
            status = manager.status()
            self.assertEqual("error", status["phase"])
            self.assertIn("size mismatch", status["error"])
            self.assertFalse(list((root / "updates").rglob("install-plan.json")))

    def test_build_id_fallback_never_uses_digits_from_git_hash(self):
        self.assertEqual(
            20260828093115,
            update_module._release_sequence({"buildId": "20260828093115-0d2a4dceb95d"}),
        )

    def test_older_remote_manifest_is_reported_as_stale_not_current(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, manifest_path = self._fixture(root)
            manager = UpdateManager(root / "updates")
            manager.configure({"manifestUrl": str(manifest_path)})
            with mock.patch.object(update_module, "_current_release", return_value={
                "version": "100.1.1.120000",
                "buildId": "21990101120000-newer-local",
                "sequence": 21990101120000,
            }):
                status = asyncio.run(manager.check())

            self.assertEqual("stale", status["phase"])
            self.assertFalse(status["available"])
            self.assertEqual("older", status["manifestRelation"])
            self.assertIn("远端更新清单早于当前节点", status["message"])
            self.assertNotIn("已是最新", status["message"])

    def test_http_manifest_request_bypasses_cdn_cache(self):
        payload = b'{"schemaVersion":1}'
        observed = {}

        class FakeResponse:
            content = payload

            @staticmethod
            def raise_for_status():
                return None

        class FakeClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, traceback):
                return False

            async def get(self, url, headers):
                observed["url"] = str(url)
                observed["headers"] = dict(headers)
                return FakeResponse()

        with tempfile.TemporaryDirectory() as temporary:
            manager = UpdateManager(Path(temporary) / "updates")
            manager.configure({"requestHeaders": {
                "Authorization": "Bearer fixture",
                "Cache-Control": "max-age=3600",
            }})
            with mock.patch("src.backend.update_manager.httpx.AsyncClient", FakeClient):
                raw = asyncio.run(manager._read_source("https://updates.example.com/stable/manifest.json?channel=stable"))

        self.assertEqual(payload, raw)
        self.assertIn("channel=stable", observed["url"])
        self.assertIn("_awu_cache_bust=", observed["url"])
        self.assertEqual("no-cache, no-store, max-age=0", observed["headers"]["Cache-Control"])
        self.assertEqual("no-cache", observed["headers"]["Pragma"])
        self.assertEqual("Bearer fixture", observed["headers"]["Authorization"])

    def test_cancel_recovers_interrupted_persisted_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            manager = UpdateManager(Path(temporary) / "updates")
            manager._save_state({"phase": "downloading", "message": "old process"})
            status = asyncio.run(manager.cancel())
            self.assertEqual("cancelled", status["phase"])
            self.assertFalse(status["busy"])

    def test_headless_helper_launch_failure_is_not_left_installing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = UpdateManager(root / "updates")
            plan_path = manager.root / "release" / "install-plan.json"
            plan_path.parent.mkdir(parents=True)
            plan_path.write_text("{}", encoding="utf-8")
            manager._save_state({"phase": "staged", "planPath": str(plan_path)})
            with mock.patch.dict(os.environ, {"AGENT_WITH_U_DESKTOP_EXE": ""}), mock.patch.object(
                manager, "_launch_headless_helper", side_effect=OSError("spawn failed"),
            ):
                with self.assertRaisesRegex(OSError, "spawn failed"):
                    manager.prepare_apply()
            status = manager.status()
            self.assertEqual("error", status["phase"])
            self.assertIn("spawn failed", status["error"])

    def test_docker_bundle_is_routed_to_live_sidecar_without_argv_installer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact = root / "agent-with-u-docker-linux-x86_64.tar"
            artifact.write_bytes(b"docker image archive fixture")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({
                "schemaVersion": 1,
                "channel": "stable",
                "release": {
                    "version": "99.2.1.120000",
                    "buildId": "20990102120000-docker",
                    "sequence": 20990102120000,
                },
                "artifacts": [{
                    "id": "linux-docker",
                    "platform": update_module._platform(),
                    "arch": update_module._arch(),
                    "target": "docker",
                    "kind": "docker-bundle",
                    "fileName": artifact.name,
                    "url": str(artifact),
                    "size": artifact.stat().st_size,
                    "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                }],
            }), encoding="utf-8")
            updater = root / "docker-updater"
            updater.mkdir()
            (updater / "heartbeat").write_text(str(time.time()), encoding="utf-8")

            with mock.patch.dict(os.environ, {
                "AGENT_WITH_U_RUNTIME": "docker",
                "AGENT_WITH_U_DOCKER_UPDATER_DIR": str(updater),
            }, clear=False):
                manager = UpdateManager(root / "updates")
                manager.configure({"manifestUrl": str(manifest)})

                async def scenario():
                    await manager.start_stage()
                    await manager._task

                asyncio.run(scenario())
                self.assertEqual("staged", manager.status()["phase"])
                self.assertEqual("docker", manager.status()["runtime"])
                self.assertTrue(manager.status()["dockerUpdaterAvailable"])
                plan = json.loads(Path(manager.status()["planPath"]).read_text(encoding="utf-8"))
                self.assertEqual("docker-updater", plan["installerType"])
                self.assertEqual("", plan["install"]["program"])
                with mock.patch.object(manager, "_launch_headless_helper") as helper:
                    result = manager.prepare_apply()
                helper.assert_not_called()

            self.assertTrue(result["docker"])
            request = json.loads((updater / "request.json").read_text(encoding="utf-8"))
            self.assertEqual("agentwithu-docker-update-request-v1", request["marker"])
            self.assertEqual(str(Path(manager.status()["planPath"]).resolve()), request["planPath"])


class UpdateHelperTests(unittest.TestCase):
    def test_helper_verifies_and_executes_argv_without_shell(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact = root / "installer script.py"
            marker = root / "installed marker.txt"
            artifact.write_text(
                "from pathlib import Path\nimport sys\nPath(sys.argv[1]).write_text('ok', encoding='utf-8')\n",
                encoding="utf-8",
            )
            result_path = root / "result.json"
            plan = {
                "marker": "agentwithu-update-plan-v1",
                "schemaVersion": 1,
                "version": "99.1.1",
                "buildId": "fixture",
                "artifactPath": str(artifact),
                "artifactSha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                "waitPids": [],
                "install": {
                    "program": sys.executable,
                    "args": [str(artifact), str(marker)],
                    "successExitCodes": [0],
                    "timeoutSeconds": 30,
                },
                "restart": {"program": "", "args": []},
                "resultPath": str(result_path),
            }
            plan_path = root / "install-plan.json"
            plan_path.write_text(json.dumps(plan), encoding="utf-8")

            self.assertEqual(0, run_update_helper(str(plan_path)))
            self.assertEqual("ok", marker.read_text(encoding="utf-8"))
            self.assertTrue(json.loads(result_path.read_text(encoding="utf-8"))["ok"])


class BuildVersionTests(unittest.TestCase):
    def test_same_day_and_same_minute_builds_remain_distinguishable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tauri_config = root / "tauri.conf.json"
            version_file = root / "_version.py"
            tauri_config.write_text('{"version":"26.8.23"}\n', encoding="utf-8")
            version_file.write_text('__version__ = "26.8.23"\n', encoding="utf-8")
            with (
                mock.patch.object(version_stamper, "TAURI_CONFIG", tauri_config),
                mock.patch.object(version_stamper, "VERSION_FILE", version_file),
                mock.patch.object(version_stamper, "_git_commit", return_value="abc123"),
            ):
                first = version_stamper.stamp("20260828093115")
                second = version_stamper.stamp("20260828093145")
                repeated = version_stamper.stamp("20260828093145")

            self.assertEqual("26.8.28.093115", first["displayVersion"])
            self.assertEqual("26.8.28.093145", second["displayVersion"])
            self.assertNotEqual(first["packageVersion"], second["packageVersion"])
            self.assertEqual(second["packageVersion"], repeated["packageVersion"])
            self.assertEqual(20260828093145, second["sequence"])


class ReleasePublisherTests(unittest.TestCase):
    def test_manifest_preserves_custom_installer_and_hashes_artifact(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "src").mkdir()
            (root / "src" / "_version.py").write_text(
                "__display_version__='26.8.28.120000'\n"
                "__package_version__='26.8.56720'\n"
                "__build_id__='20260828120000-abc123'\n"
                "__build_sequence__=20260828120000\n",
                encoding="utf-8",
            )
            artifact = root / "payload.weird"
            artifact.write_bytes(b"arbitrary release payload")
            plan_dir = root / "deploy"
            plan_dir.mkdir()
            plan_path = plan_dir / "release.json"
            plan_path.write_text(json.dumps({
                "channel": "stable",
                "baseUrl": "https://cdn.example.com/releases",
                "artifacts": [{
                    "id": "custom-linux",
                    "path": "../payload.weird",
                    "platform": "linux",
                    "arch": "x86_64",
                    "target": "executor",
                    "kind": "custom",
                    "install": {
                        "program": "/opt/agentwithu/install-release",
                        "args": ["{artifact}"],
                    },
                }],
            }), encoding="utf-8")
            output = root / "manifest.json"
            with (
                mock.patch.object(publish_updates, "ROOT", root),
                mock.patch.object(sys, "argv", [
                    "publish_updates.py", str(plan_path), "--output", str(output),
                ]),
                mock.patch.dict(os.environ, {"AGENT_WITH_U_UPDATE_SIGNING_KEY": "fixture-key"}),
            ):
                self.assertEqual(0, publish_updates.main())

            manifest = json.loads(output.read_text(encoding="utf-8"))
            item = manifest["artifacts"][0]
            self.assertEqual(hashlib.sha256(artifact.read_bytes()).hexdigest(), item["sha256"])
            self.assertEqual("/opt/agentwithu/install-release", item["install"]["program"])
            self.assertTrue(item["url"].startswith("https://cdn.example.com/releases/"))
            expected_signature = hmac.new(
                b"fixture-key", _canonical_manifest_payload(manifest), hashlib.sha256,
            ).hexdigest()
            self.assertEqual(expected_signature, manifest["signature"]["value"])


class NodeUpdateAuthorizationTests(unittest.TestCase):
    def test_local_and_relay_primary_user_can_update(self):
        source = _REQUEST_IDENTITY_SOURCE.set("loopback")
        try:
            BridgeWS._require_node_update_capability()
        finally:
            _REQUEST_IDENTITY_SOURCE.reset(source)

        source = _REQUEST_IDENTITY_SOURCE.set("relay")
        capability = _REQUEST_CAN_CLAIM_LEGACY.set(True)
        try:
            BridgeWS._require_node_update_capability()
        finally:
            _REQUEST_CAN_CLAIM_LEGACY.reset(capability)
            _REQUEST_IDENTITY_SOURCE.reset(source)

    def test_shared_relay_non_primary_user_cannot_update(self):
        source = _REQUEST_IDENTITY_SOURCE.set("relay")
        capability = _REQUEST_CAN_CLAIM_LEGACY.set(False)
        try:
            with self.assertRaises(PermissionError):
                BridgeWS._require_node_update_capability()
        finally:
            _REQUEST_CAN_CLAIM_LEGACY.reset(capability)
            _REQUEST_IDENTITY_SOURCE.reset(source)

    def test_backend_management_is_also_node_owner_only(self):
        bridge = object.__new__(BridgeWS)
        source = _REQUEST_IDENTITY_SOURCE.set("relay")
        capability = _REQUEST_CAN_CLAIM_LEGACY.set(False)
        try:
            for method in (
                "saveBackend", "deleteBackend", "exportBackends",
                "previewBackendImport", "importBackends", "exportData", "importData",
                "saveMcpServers",
                "openLoginTerminal", "openModelTerminal",
                "skillRuntimeInspect", "skillRuntimePrepare",
            ):
                with self.subTest(method=method), self.assertRaises(PermissionError):
                    bridge._authorize_rpc(method, lambda: None, [])
        finally:
            _REQUEST_CAN_CLAIM_LEGACY.reset(capability)
            _REQUEST_IDENTITY_SOURCE.reset(source)


if __name__ == "__main__":
    unittest.main()
