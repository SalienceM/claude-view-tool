import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from src.backend.bridge_ws import BridgeWS


class WorkspaceDeleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.bridge = BridgeWS.__new__(BridgeWS)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def delete(self, relative: str, directory: bool = False) -> dict:
        return json.loads(asyncio.run(self.bridge._rpc_syncDeleteEntry(str(self.workspace), relative, directory)))

    def test_file_delete_preserves_parent_and_other_copy(self) -> None:
        parent = self.workspace / "folder"
        parent.mkdir()
        (parent / "file.txt").write_text("remote")
        (self.root / "file.txt").write_text("local")
        self.assertEqual(self.delete("folder/file.txt")["status"], "ok")
        self.assertTrue(parent.is_dir())
        self.assertEqual((self.root / "file.txt").read_text(), "local")

    def test_nonempty_directory_including_hidden_files(self) -> None:
        directory = self.workspace / "folder"
        (directory / "nested").mkdir(parents=True)
        (directory / "nested" / ".hidden").write_text("data")
        self.assertEqual(self.delete("folder", True)["status"], "ok")
        self.assertFalse(directory.exists())
        self.assertTrue(self.workspace.is_dir())

    def test_rejects_root_escape_absolute_and_git_paths(self) -> None:
        (self.workspace / ".git").mkdir()
        (self.workspace / "keep").write_text("safe")
        for relative in ["", ".", "..", "../outside", "/keep", "C:/keep", "folder/../../keep", ".git", ".git/config", "keep:stream"]:
            with self.subTest(relative=relative):
                self.assertEqual(self.delete(relative, True)["status"], "error")
        self.assertEqual((self.workspace / "keep").read_text(), "safe")

    def test_type_change_and_missing_entry_are_not_reported_as_success(self) -> None:
        (self.workspace / "folder").mkdir()
        (self.workspace / "file").write_text("safe")
        self.assertEqual(self.delete("folder")["status"], "error")
        self.assertEqual(self.delete("file", True)["status"], "error")
        self.assertEqual(self.delete("missing")["status"], "error")

    def test_link_does_not_delete_destination(self) -> None:
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep").write_text("safe")
        try:
            (self.workspace / "link").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("symlink creation is not permitted")
        self.assertEqual(self.delete("link", True)["status"], "error")
        self.assertEqual(self.delete("link/keep")["status"], "error")
        self.assertEqual((outside / "keep").read_text(), "safe")

    def test_delete_rpc_uses_workspace_authorization(self) -> None:
        self.bridge._require_working_dir_access = Mock(side_effect=PermissionError("denied"))
        with self.assertRaises(PermissionError):
            self.bridge._authorize_rpc("syncDeleteEntry", self.bridge._rpc_syncDeleteEntry, [str(self.workspace), "folder", True])
        self.bridge._require_working_dir_access.assert_called_once_with(str(self.workspace))
