import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_IDENTITY_SOURCE
from src.backend.chat_kits import ChatKitTools, TOOL_NAME
from src.backend.openai_compat import OpenAICompatibleBackend
from src.backend.claude_code import ClaudeCodeOfficialBackend
from src.backend.workspace_kit_store import WorkspaceKit, KitRun, KitStepRun
from src.types import Session, ChatMessage


class ChatKitTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(self.root / "data")})
        self.env.start()
        self.bridge = BridgeWS()
        self.session = Session(id="chat-kits", title="chat", created_at=1, updated_at=1,
                               messages=[], working_dir=str(self.root), backend_id="fake")
        self.bridge._active_sessions[self.session.id] = self.session
        self.service = self.bridge._chat_kit_tools = ChatKitTools(self.bridge)
        self.token = self.service.issue(self.session.id)
        self.state = self.bridge._kit_get(self.session.id)

    async def asyncTearDown(self):
        tasks = list(self.bridge._kit_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.env.stop()
        self.temp.cleanup()

    def kit(self, ident, command="print('ok')", **kwargs):
        kit = WorkspaceKit.from_dict({"id": ident, "title": ident, "command": command, **kwargs})
        self.state.kits.append(kit)
        return kit

    async def call(self, action, **kwargs):
        return await self.service.call(self.token, {"action": action, **kwargs})

    async def test_list_is_session_scoped_and_omits_commands_and_defaults(self):
        self.kit("a", inputs=[{"key": "key", "type": "secret", "default": "do-not-show"}])
        self.bridge._kit_get("other").kits.append(WorkspaceKit.from_dict({"id": "other"}))
        result = await self.call("list")
        self.assertEqual([kit["id"] for kit in result["kits"]], ["a"])
        self.assertNotIn("do-not-show", json.dumps(result))
        self.assertNotIn("command", result["kits"][0])
        self.assertEqual((await self.call("list", sessionId="other"))["status"], "error")

    async def test_real_chain_is_sequential_and_retry_does_not_duplicate(self):
        self.kit("a", "from pathlib import Path; Path('order.txt').write_text('A')")
        self.kit("b", "from pathlib import Path; p=Path('order.txt'); assert p.read_text() == 'A'; p.write_text('AB')")
        args = {"calls": [{"kitId": "a"}, {"kitId": "b"}], "requestId": "order-1"}
        with patch.object(self.bridge, "_kit_shell_command", side_effect=lambda shell, cmd: [sys.executable, "-c", cmd]):
            started = await self.call("run", **args)
            self.assertEqual(started["status"], "ok", started)
            repeated = await self.call("run", **args)
            self.assertTrue(repeated["reused"])
            self.assertEqual(len(self.state.runs), 1)
            run_id = started["run"]["id"]
            await asyncio.wait_for(self.bridge._kit_tasks[run_id], 10)
        result = await self.call("status", runId=run_id)
        self.assertEqual(result["run"]["status"], "succeeded", result)
        self.assertEqual((self.root / "order.txt").read_text(), "AB")
        self.assertEqual(self.state.runs[0].owner, "ai")

    async def test_failure_stops_later_kit(self):
        self.kit("a", "raise SystemExit(3)")
        self.kit("b", "from pathlib import Path; Path('must-not-exist').touch()")
        with patch.object(self.bridge, "_kit_shell_command", side_effect=lambda shell, cmd: [sys.executable, "-c", cmd]):
            started = await self.call("run", calls=[{"kitId": "a"}, {"kitId": "b"}], requestId="fail")
            await asyncio.wait_for(self.bridge._kit_tasks[started["run"]["id"]], 10)
        self.assertFalse((self.root / "must-not-exist").exists())
        self.assertNotEqual(self.state.runs[0].status, "succeeded")

    async def test_reject_missing_disabled_and_undeclared_inputs_without_saving(self):
        self.kit("off", enabled=False)
        self.kit("a")
        for calls in ([{"kitId": "missing"}], [{"kitId": "off"}],
                      [{"kitId": "a", "inputs": {"unknown": "x"}}]):
            result = await self.call("run", calls=calls, requestId="invalid")
            self.assertEqual(result["status"], "error")
        self.assertEqual(len(self.state.kits), 2)
        self.assertEqual(self.state.runs, [])

    async def test_nested_secret_and_cycle_rejected(self):
        self.kit("secret", inputs=[{"key": "password", "type": "secret"}])
        self.kit("outer", steps=[{"type": "kit_call", "kitId": "secret"}])
        result = await self.call("run", calls=[{"kitId": "outer"}], requestId="secret")
        self.assertIn("密码", result["message"])
        self.kit("cycle", steps=[{"type": "kit_call", "kitId": "cycle"}])
        result = await self.call("run", calls=[{"kitId": "cycle"}], requestId="cycle")
        self.assertEqual(result["status"], "error")
        self.assertEqual(self.state.runs, [])

    async def test_active_child_prevents_parallel_duplicate(self):
        self.kit("a")
        self.state.runs.append(KitRun(id="existing", kit_id="other-chain", session_id=self.session.id,
                                     status="running", steps=[KitStepRun(id="s", source_kit_id="a")]))
        result = await self.call("run", calls=[{"kitId": "a"}], requestId="duplicate")
        self.assertIn("已在运行", result["message"])

    async def test_http_requires_loopback_valid_live_token_and_post(self):
        body = json.dumps({"token": self.token, "arguments": {"action": "list"}}).encode()
        route = self.bridge._route_http_api
        self.assertEqual((await route("POST", "/api/chat-kits", body, "192.168.1.2"))[0], 403)
        self.assertEqual((await route("GET", "/api/chat-kits", body, "127.0.0.1"))[0], 405)
        self.assertEqual((await route("POST", "/api/chat-kits", body, "127.0.0.1"))[0], 200)
        self.service.revoke(self.token)
        self.assertEqual((await route("POST", "/api/chat-kits", body, "127.0.0.1"))[0], 403)

    async def test_http_restores_chat_identity_not_loopback_privilege(self):
        identity = _REQUEST_IDENTITY_SOURCE.set("relay")
        try:
            restricted = self.service.issue(self.session.id)
        finally:
            _REQUEST_IDENTITY_SOURCE.reset(identity)
        self.kit("a")
        privileged = [KitStepRun(id="node", source_kit_id="a", type="awu_capability",
                                config={"metadata": {"permission": "node.update"}})]
        with patch.object(self.bridge, "_kit_build_plan", return_value=(privileged, [])):
            code, body = await self.bridge._route_http_api("POST", "/api/chat-kits", json.dumps({
                "token": restricted, "arguments": {
                    "action": "run", "calls": [{"kitId": "a"}], "requestId": "denied",
                },
            }).encode(), "127.0.0.1")
            self.assertEqual(code, 200)
            result = json.loads(body)
        self.assertEqual(result["status"], "error")
        self.assertIn("primary user", result["message"])
        self.assertEqual(len(self.state.kits), 1)

    async def test_status_cancel_and_waiting_confirmation(self):
        self.state.runs.append(KitRun(id="wait", kit_id="a", session_id=self.session.id,
                                     status="waiting_approval"))
        result = await self.call("status", runId="wait", waitSeconds=10)
        self.assertEqual(result["run"]["status"], "waiting_approval")
        self.assertEqual((await self.call("status", runId="foreign"))["status"], "error")
        await self.call("cancel", runId="wait")
        self.assertEqual(self.state.runs[0].status, "cancelled")

    async def test_wrapper_revokes_cli_token_even_on_exception(self):
        async def fail(*args, **kwargs):
            self.assertIn(kwargs["kit_token"], self.service.leases)
            raise RuntimeError("backend failed")
        with patch.object(self.bridge, "_get_backend", return_value=ClaudeCodeOfficialBackend.__new__(ClaudeCodeOfficialBackend)), patch.object(
            self.bridge, "_async_send_with_kit_tools", side_effect=fail,
        ):
            with self.assertRaises(RuntimeError):
                await self.bridge._async_send(self.session, "list kits", None, "fake", "m")
        self.assertEqual(list(self.service.leases), [self.token])

    async def test_single_kit_keeps_identity_and_conflicting_retry_is_rejected(self):
        self.kit("a")
        self.kit("b")
        with patch.object(self.bridge, "_kit_shell_command", side_effect=lambda shell, cmd: [sys.executable, "-c", cmd]):
            result = await self.call("run", calls=[{"kitId": "a"}], requestId="single")
            self.assertEqual(result["run"]["kitId"], "a")
            conflict = await self.call("run", calls=[{"kitId": "b"}], requestId="single")
            self.assertEqual(conflict["status"], "error")
            await asyncio.wait_for(self.bridge._kit_tasks[result["run"]["id"]], 10)
        self.assertEqual(len(self.state.kits), 2)
        self.assertEqual(len(self.state.runs), 1)

    async def test_ssh_has_no_wrong_local_entry(self):
        self.session.codex_connection_mode = "ssh"
        async def ssh(*args, **kwargs):
            self.assertEqual(kwargs["kit_token"], "")
            self.assertIsNone(args[7])
        with patch.object(self.bridge, "_async_send_with_kit_tools", side_effect=ssh):
            await self.bridge._async_send(self.session, "list kits", None, "fake", "m")

    async def test_api_backend_receives_callable_tool_without_bound_skills(self):
        results = []
        class Probe(OpenAICompatibleBackend):
            def __init__(self):
                pass
            async def send_message(self, **kwargs):
                results.append(kwargs)
                self_result = json.loads(await kwargs["on_tool_call"](TOOL_NAME, {"action": "list"}))
                results.append(self_result)
                return {"stopReason": "end_turn"}
        self.kit("visible")
        self.session.messages = [ChatMessage(id="a", role="assistant", content="", streaming=True)]
        with patch.object(self.bridge, "_get_backend", return_value=Probe()), patch.object(
            self.bridge, "_collect_backend_skills", return_value=([], None),
        ), patch.object(self.bridge._session_store, "save"):
            await self.bridge._async_send(self.session, "list kits", None, "fake", "a")
        self.assertEqual(results[0]["extra_tools"][0]["name"], TOOL_NAME)
        self.assertNotIn("/api/chat-kits", results[0]["constraints"])
        self.assertEqual(results[1]["kits"][0]["id"], "visible")
        self.assertEqual(list(self.service.leases), [self.token])

    async def test_resumed_cli_gets_fresh_token_in_content_not_saved_transcript(self):
        captured = []
        class Probe(ClaudeCodeOfficialBackend):
            def __init__(self):
                pass
            async def send_message(inner, **kwargs):
                captured.append(kwargs)
                return {"stopReason": "end_turn", "agentSessionId": "native-thread"}
        self.session.agent_session_id = "native-thread"
        self.session.messages = [ChatMessage(id="a", role="assistant", content="", streaming=True)]
        with patch.object(self.bridge, "_get_backend", return_value=Probe()), patch.object(
            self.bridge, "_collect_backend_skills", return_value=([], None),
        ), patch.object(self.bridge._session_store, "save"):
            await self.bridge._async_send(self.session, "show kits", None, "fake", "a")
        self.assertIn("/api/chat-kits", captured[0]["content"])
        self.assertNotIn("/api/chat-kits", str(self.session.constraints))
        self.assertEqual(list(self.service.leases), [self.token])

    async def test_non_tool_backend_gets_no_control_instructions(self):
        async def capture(*args, **kwargs):
            self.assertIsNone(args[7])
            self.assertEqual(kwargs["kit_token"], "")
        with patch.object(self.bridge, "_get_backend", return_value=object()), patch.object(
            self.bridge, "_async_send_with_kit_tools", side_effect=capture,
        ):
            await self.bridge._async_send(self.session, "draw a picture", None, "fake", "m")
