import asyncio
import sys
import types
import unittest
from unittest.mock import patch

sys.modules.setdefault("httpx", types.ModuleType("httpx"))

from src.backend.qwen_code_cli import QwenCodeSdkBackend, _materialize_qwen_images
from src.types import BackendType, ImageAttachment, ModelBackendConfig


class _FakeQuery:
    def __init__(self, messages=None):
        self.closed = False
        self.finished = asyncio.Event()
        self._messages = iter(messages or [])

    async def close(self):
        if self.closed:
            return
        self.closed = True
        await asyncio.sleep(0.05)
        self.finished.set()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        await self.close()

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._messages)
        except StopIteration as exc:
            raise StopAsyncIteration from exc

    def get_session_id(self):
        return "qwen-session"


class QwenCodeCliTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.backend = QwenCodeSdkBackend(ModelBackendConfig(
            id="qwen-test",
            label="Qwen test",
            type=BackendType.QWEN_CODE_CLI,
        ))

    async def test_terminal_cleanup_is_detached_and_tracked(self):
        query = _FakeQuery()
        self.backend._detach_query_cleanup(query)
        await asyncio.sleep(0)
        self.assertTrue(query.closed)
        self.assertEqual(len(self.backend._cleanup_tasks), 1)
        await query.finished.wait()
        await asyncio.sleep(0)
        self.assertEqual(len(self.backend._cleanup_tasks), 0)

    async def test_context_exit_does_not_repeat_detached_cleanup_wait(self):
        query = _FakeQuery()
        loop = asyncio.get_running_loop()
        started = loop.time()
        async with query as result:
            self.backend._detach_query_cleanup(result)
            await asyncio.sleep(0)
        elapsed = loop.time() - started
        self.assertLess(elapsed, 0.025)
        await query.finished.wait()

    async def test_abort_actively_closes_a_silent_sdk_query(self):
        query = _FakeQuery()
        self.backend._active_queries = {"loop-call": query}

        self.backend.abort("loop-call")
        await asyncio.wait_for(query.finished.wait(), timeout=1)

        self.assertTrue(query.closed)
        self.assertTrue(self.backend.is_cancelled("loop-call"))

    async def test_image_is_materialized_inside_working_dir_for_at_reference(self):
        import base64
        import os
        import shutil
        import tempfile

        cwd = tempfile.mkdtemp()
        temp_dir = None
        try:
            image = ImageAttachment(
                id="image-1",
                base64=base64.b64encode(b"fake-png").decode("ascii"),
                mime_type="image/png",
            )
            refs, temp_dir = _materialize_qwen_images([image], cwd, "message/1")
            self.assertEqual(len(refs), 1)
            self.assertTrue(refs[0].startswith("awu-qwen-attachments/awu-message-1-"))
            self.assertNotIn("/.qwen/", f"/{refs[0]}")
            target = os.path.abspath(os.path.join(cwd, refs[0]))
            self.assertEqual(os.path.commonpath((os.path.abspath(cwd), target)), os.path.abspath(cwd))
            with open(target, "rb") as saved:
                self.assertEqual(saved.read(), b"fake-png")
        finally:
            if temp_dir:
                shutil.rmtree(temp_dir, ignore_errors=True)
            shutil.rmtree(cwd, ignore_errors=True)

    async def test_image_turn_enables_qwen_image_modality(self):
        import json
        import os
        import shutil
        import tempfile

        cwd = tempfile.mkdtemp()
        try:
            settings_dir = os.path.join(cwd, ".qwen")
            os.makedirs(settings_dir, exist_ok=True)
            with open(os.path.join(settings_dir, "settings.json"), "w", encoding="utf-8") as target:
                json.dump({
                    "model": {
                        "generationConfig": {"timeout": 90000},
                    },
                }, target)
            self.backend._ensure_project_auth_settings(
                cwd, "openai", "qwen3.7-plus", enable_image_input=True,
            )
            settings_path = os.path.join(cwd, ".qwen", "settings.json")
            with open(settings_path, "r", encoding="utf-8") as source:
                settings = json.load(source)
            self.assertEqual(settings["model"]["name"], "qwen3.7-plus")
            self.assertTrue(
                settings["model"]["generationConfig"]["modalities"]["image"],
            )
            self.assertEqual(settings["model"]["generationConfig"]["timeout"], 90000)
            self.assertEqual(
                settings["model"]["generationConfig"]["samplingParams"]["max_tokens"],
                32000,
            )
        finally:
            shutil.rmtree(cwd, ignore_errors=True)

    async def test_backend_token_limits_override_oversized_qwen_request(self):
        import json
        import os
        import shutil
        import tempfile

        backend = QwenCodeSdkBackend(ModelBackendConfig(
            id="enterprise-qwen",
            label="Enterprise Qwen",
            type=BackendType.QWEN_CODE_CLI,
            qwen_context_window_size=135168,
            qwen_max_output_tokens=32768,
        ))
        cwd = tempfile.mkdtemp()
        try:
            settings_dir = os.path.join(cwd, ".qwen")
            os.makedirs(settings_dir, exist_ok=True)
            with open(os.path.join(settings_dir, "settings.json"), "w", encoding="utf-8") as target:
                json.dump({
                    "model": {
                        "generationConfig": {
                            "timeout": 90000,
                            "samplingParams": {
                                "temperature": 0.2,
                                "max_tokens": 384000,
                            },
                        },
                    },
                }, target)

            backend._ensure_project_auth_settings(
                cwd, "openai", "deepseek-v4-flash",
            )

            with open(os.path.join(settings_dir, "settings.json"), "r", encoding="utf-8") as source:
                settings = json.load(source)
            generation = settings["model"]["generationConfig"]
            self.assertEqual(generation["contextWindowSize"], 135168)
            self.assertEqual(generation["samplingParams"]["max_tokens"], 32768)
            self.assertEqual(generation["samplingParams"]["temperature"], 0.2)
            self.assertEqual(generation["timeout"], 90000)
        finally:
            shutil.rmtree(cwd, ignore_errors=True)

    async def test_invalid_imported_limit_falls_back_below_context_window(self):
        import json
        import os
        import shutil
        import tempfile

        backend = QwenCodeSdkBackend(ModelBackendConfig(
            id="invalid-qwen",
            label="Invalid Qwen",
            type=BackendType.QWEN_CODE_CLI,
            qwen_context_window_size=16000,
            qwen_max_output_tokens=384000,
        ))
        cwd = tempfile.mkdtemp()
        try:
            backend._ensure_project_auth_settings(
                cwd, "openai", "deepseek-v4-flash",
            )
            with open(os.path.join(cwd, ".qwen", "settings.json"), "r", encoding="utf-8") as source:
                settings = json.load(source)
            self.assertEqual(
                settings["model"]["generationConfig"]["samplingParams"]["max_tokens"],
                4000,
            )
        finally:
            shutil.rmtree(cwd, ignore_errors=True)

    async def test_metadata_partial_event_does_not_hide_completed_answer(self):
        import tempfile

        query = _FakeQuery([
            {
                "type": "stream_event",
                "session_id": "qwen-session",
                "event": {"type": "message_start", "message": {}},
            },
            {
                "type": "assistant",
                "session_id": "qwen-session",
                "message": {"content": [{"type": "text", "text": "fallback answer"}]},
            },
            {
                "type": "result",
                "subtype": "success",
                "session_id": "qwen-session",
                "is_error": False,
                "usage": {},
            },
        ])
        deltas = []
        with tempfile.TemporaryDirectory() as cwd, \
             patch("qwen_code_sdk.query", return_value=query), \
             patch("src.backend.qwen_code_cli.cli_available", return_value=True), \
             patch.object(self.backend, "_resolve_cli", return_value="qwen"):
            await self.backend.send_message(
                messages=[],
                content="hello",
                images=None,
                session_id="session-1",
                message_id="message-1",
                on_delta=deltas.append,
                working_dir=cwd,
            )

        await query.finished.wait()
        text = "".join(delta.text or "" for delta in deltas if delta.type == "text_delta")
        self.assertEqual(text, "fallback answer")

    async def test_real_partial_content_is_not_duplicated_by_completed_answer(self):
        import tempfile

        query = _FakeQuery([
            {
                "type": "stream_event",
                "session_id": "qwen-session",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "thinking_delta", "thinking": "checking"},
                },
            },
            {
                "type": "assistant",
                "session_id": "qwen-session",
                "message": {"content": [{"type": "thinking", "thinking": "checking"}]},
            },
            {
                "type": "result",
                "subtype": "success",
                "session_id": "qwen-session",
                "is_error": False,
                "usage": {},
            },
        ])
        deltas = []
        with tempfile.TemporaryDirectory() as cwd, \
             patch("qwen_code_sdk.query", return_value=query), \
             patch("src.backend.qwen_code_cli.cli_available", return_value=True), \
             patch.object(self.backend, "_resolve_cli", return_value="qwen"):
            await self.backend.send_message(
                messages=[],
                content="hello",
                images=None,
                session_id="session-1",
                message_id="message-1",
                on_delta=deltas.append,
                working_dir=cwd,
            )

        await query.finished.wait()
        thinking = "".join(delta.text or "" for delta in deltas if delta.type == "thinking")
        self.assertEqual(thinking, "checking")

    async def test_tool_result_is_forwarded_for_loop_activity_and_visibility(self):
        import tempfile

        query = _FakeQuery([
            {
                "type": "assistant",
                "session_id": "qwen-session",
                "message": {"content": [{
                    "type": "tool_use",
                    "id": "tool-1",
                    "name": "run_shell_command",
                    "input": {"command": "pytest"},
                }]},
            },
            {
                "type": "user",
                "session_id": "qwen-session",
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "tool-1",
                        "content": "12 tests passed",
                    }],
                },
                "parent_tool_use_id": None,
            },
            {
                "type": "result",
                "subtype": "success",
                "session_id": "qwen-session",
                "is_error": False,
                "usage": {},
            },
        ])
        deltas = []
        with tempfile.TemporaryDirectory() as cwd, \
             patch("qwen_code_sdk.query", return_value=query), \
             patch("src.backend.qwen_code_cli.cli_available", return_value=True), \
             patch.object(self.backend, "_resolve_cli", return_value="qwen"):
            await self.backend.send_message(
                messages=[],
                content="run tests",
                images=None,
                session_id="session-tool-result",
                message_id="message-tool-result",
                on_delta=deltas.append,
                working_dir=cwd,
            )

        await query.finished.wait()
        result_delta = next(delta for delta in deltas if delta.type == "tool_result")
        self.assertEqual(result_delta.tool_call["id"], "tool-1")
        self.assertEqual(result_delta.tool_call["name"], "Bash")
        self.assertEqual(result_delta.tool_call["status"], "done")
        self.assertIn("12 tests passed", result_delta.tool_call["output"])


    async def _run_stream(self, messages, **kwargs):
        import tempfile

        for message in messages:
            message.setdefault("session_id", "qwen-session")
        query = _FakeQuery(messages)
        deltas = []
        with tempfile.TemporaryDirectory() as cwd, \
             patch("qwen_code_sdk.query", return_value=query) as sdk_query, \
             patch("src.backend.qwen_code_cli.cli_available", return_value=True), \
             patch.object(self.backend, "_resolve_cli", return_value="qwen"):
            result = await asyncio.wait_for(self.backend.send_message(
                messages=[], content="hello", images=None,
                session_id="session-1", message_id="message-1",
                on_delta=deltas.append, working_dir=cwd, **kwargs,
            ), timeout=2)
        await asyncio.wait_for(query.finished.wait(), timeout=1)
        self.assertNotIn("session-1", self.backend._active_queries)
        self.assertEqual(sum(d.type == "done" for d in deltas), 1)
        return deltas, sdk_query.call_args.args[1], result

    async def test_questions_use_normal_chat_even_on_resume_and_yolo(self):
        deltas, options, result = await self._run_stream([
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": "要继续执行吗？"},
            ]}},
            {"type": "result", "subtype": "success", "session_id": "native-thread"},
        ], agent_session_id="native-thread", skip_permissions=True)
        self.assertIn("ask_user_question", options["exclude_tools"])
        self.assertIn("end the turn", options["append_system_prompt"])
        self.assertEqual(options["resume"], "native-thread")
        for name in ("ask_user_question", "AskUserQuestion"):
            decision = await options["can_use_tool"](name, {"questions": []}, {})
            self.assertEqual(decision["behavior"], "deny")
            self.assertIn("next chat turn", decision["message"])
        self.assertEqual(result["agentSessionId"], "native-thread")
        self.assertEqual("".join(d.text or "" for d in deltas if d.type == "text_delta"), "要继续执行吗？")

    async def test_streamed_thinking_does_not_hide_completed_text_or_tool(self):
        deltas, _, _ = await self._run_stream([
            {"type": "stream_event", "event": {"type": "content_block_delta",
                "delta": {"type": "thinking_delta", "thinking": "checking"}}},
            {"type": "assistant", "message": {"content": [
                {"type": "thinking", "thinking": "checking"},
                {"type": "text", "text": "Testing now"},
                {"type": "tool_use", "id": "t1", "name": "run_shell_command", "input": {"command": "pytest"}},
            ]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "passed"},
            ]}},
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": "Finished. Anything else?"},
            ]}},
            {"type": "result", "subtype": "success"},
        ])
        self.assertEqual("".join(d.text or "" for d in deltas if d.type == "thinking"), "checking")
        self.assertEqual("".join(d.text or "" for d in deltas if d.type == "text_delta"), "Testing nowFinished. Anything else?")
        self.assertEqual([d.type for d in deltas if d.type in ("tool_start", "tool_result", "done")],
                         ["tool_start", "tool_result", "done"])

    async def test_completed_text_emits_only_missing_stream_suffix(self):
        deltas, _, _ = await self._run_stream([
            {"type": "stream_event", "event": {"type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "Hello"}}},
            {"type": "stream_event", "event": {"type": "message_stop"}},
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": "Hello, continue?"},
            ]}},
            {"type": "result", "subtype": "success"},
        ])
        self.assertEqual("".join(d.text or "" for d in deltas if d.type == "text_delta"), "Hello, continue?")
        self.assertEqual(deltas[-1].type, "done")

    async def test_message_stop_and_question_do_not_finish_a_running_tool(self):
        deltas, _, _ = await self._run_stream([
            {"type": "stream_event", "event": {"type": "message_start"}},
            {"type": "stream_event", "event": {"type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "What failed?"}}},
            {"type": "stream_event", "event": {"type": "content_block_start",
                "content_block": {"type": "tool_use", "id": "t1", "name": "run_shell_command"}}},
            {"type": "stream_event", "event": {"type": "message_stop"}},
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": "What failed?"},
                {"type": "tool_use", "id": "t1", "name": "run_shell_command", "input": {}},
            ]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "output"},
            ]}},
            {"type": "stream_event", "event": {"type": "message_start"}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "All OK"}]}},
            {"type": "result", "subtype": "success"},
        ])
        self.assertEqual([d.type for d in deltas if d.type in ("tool_start", "tool_result", "done")],
                         ["tool_start", "tool_result", "done"])
        self.assertEqual("".join(d.text or "" for d in deltas if d.type == "text_delta"), "What failed?All OK")


if __name__ == "__main__":
    unittest.main()
