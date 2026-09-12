"""Kit 优化窗口关闭/重开不改变执行端任务；全部使用受控模型，不执行 Kit。"""
import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import websockets
from websockets.legacy.client import connect

from src.backend.backends import StreamDelta
from src.backend.bridge_ws import BridgeWS
from src.backend.workspace_kit_store import KitOptimizationMessage
from src.types import Session


class GatedOptimizer:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0
        self.error = False

    async def send_message(self, **kwargs) -> dict:
        self.calls += 1
        self.started.set()
        await self.release.wait()
        if self.error:
            raise RuntimeError("controlled optimizer failure")
        kwargs["on_delta"](StreamDelta(
            kwargs["session_id"], kwargs["message_id"], "text_delta",
            text=json.dumps({
                "reply": "原优化已完成，历史仍在。", "ready": True,
                "proposal": {
                    "executionTarget": "executor", "shell": "powershell", "cwd": ".",
                    "command": "Write-Output optimized",
                    "assertions": [{"type": "exit_code", "expected": 0}],
                    "schedule": {"mode": "manual", "intervalSeconds": 300},
                },
            }),
        ))
        return {}

    def clear_cancelled(self, _session_id: str) -> None:
        pass


class KitOptimizerLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = patch.dict(os.environ, {"AGENT_WITH_U_DATA_ROOT": str(Path(tmp.name) / "data")})
        env.start()
        self.addCleanup(env.stop)
        self.bridge = BridgeWS()
        self.workspace = Path(tmp.name) / "workspace"
        self.workspace.mkdir()
        self.sid = "optimizer-lifecycle"
        self.bridge._active_sessions[self.sid] = Session(
            id=self.sid, title="Optimizer QA", created_at=time.time(), updated_at=time.time(),
            messages=[], working_dir=str(self.workspace), backend_id="fake",
        )
        self.kit_id = json.loads(self.bridge._rpc_kitCreate(self.sid, json.dumps({
            "title": "Original Kit", "command": "Write-Output original", "enabled": False,
        })))["kit"]["id"]
        self.key = f"{self.sid}:{self.kit_id}"
        self.fake = GatedOptimizer()
        factory = patch.object(self.bridge, "_new_backend_instance", return_value=self.fake)
        self.factory = factory.start()
        self.addCleanup(factory.stop)
        # 避免 WebSocket 分发启动与本用例无关的自动运行/广播任务。
        for name in ("_ensure_kit_scheduler", "_emit_event", "_emit_clients_changed"):
            guard = patch.object(self.bridge, name)
            guard.start()
            self.addCleanup(guard.stop)

    async def asyncTearDown(self) -> None:
        tasks = list(self.bridge._kit_optimization_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.sleep(0)

    def history(self) -> dict:
        return json.loads(self.bridge._rpc_kitOptimizeGet(self.sid, self.kit_id))

    async def start(self) -> dict:
        result = json.loads(await asyncio.wait_for(
            self.bridge._rpc_kitOptimizeStart(self.sid, self.kit_id, "保留本次要求并增加复核"), 2,
        ))
        await asyncio.wait_for(self.fake.started.wait(), 2)
        return result

    async def complete(self) -> None:
        task = self.bridge._kit_optimization_tasks[self.key]
        self.fake.release.set()
        await asyncio.wait_for(task, 2)
        await asyncio.sleep(0)

    async def test_start_is_short_deduplicated_and_completion_is_persisted(self) -> None:
        result = await self.start()
        self.assertEqual(result["status"], "queued")
        self.assertTrue(result["running"])
        self.assertEqual(len(result["messages"]), 2)
        self.assertEqual(self.history()["messages"][-1]["status"], "answering")
        duplicate = json.loads(await self.bridge._rpc_kitOptimizeStart(self.sid, self.kit_id, "重复发送"))
        self.assertEqual(duplicate["status"], "busy")
        self.assertEqual(self.fake.calls, 1)
        self.assertEqual(json.loads(self.bridge._rpc_kitDelete(self.sid, self.kit_id))["status"], "error")
        compact = self.bridge._kit_payload(self.bridge._kit_get(self.sid))["kits"][0]
        self.assertTrue(compact["optimizationRunning"])
        self.assertEqual(compact["optimizationMessages"], [])
        await self.complete()
        history = self.history()
        self.assertFalse(history["running"])
        self.assertEqual(history["messages"][-1]["status"], "done")
        self.assertTrue(history["messages"][-1]["ready"])
        self.assertFalse(self.bridge._kit_optimization_tasks)
        self.bridge._kit_states.clear()  # 从持久化状态重开，并非 React 本地副本。
        self.assertEqual(self.history()["messages"], history["messages"])
        kit = self.bridge._kit_get(self.sid).kits[0]
        self.assertEqual(kit.command, "Write-Output original")
        self.assertEqual(len(kit.versions), 1)
        self.assertEqual(self.bridge._kit_get(self.sid).runs, [])

    async def test_same_websocket_can_query_and_disconnect_without_cancelling(self) -> None:
        async with websockets.serve(self.bridge.handle_client, "127.0.0.1", 0) as server:
            url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            async with connect(url) as socket:
                await socket.send(json.dumps({
                    "id": "start", "method": "kitOptimizeStart", "params": [self.sid, self.kit_id, "继续优化"],
                }))
                response = json.loads(await asyncio.wait_for(socket.recv(), 2))
                self.assertEqual(json.loads(response["result"])["status"], "queued")
                await socket.send(json.dumps({
                    "id": "get", "method": "kitOptimizeGet", "params": [self.sid, self.kit_id],
                }))
                response = json.loads(await asyncio.wait_for(socket.recv(), 2))
                self.assertEqual(response["id"], "get")
                self.assertTrue(json.loads(response["result"])["running"])
                self.assertFalse(self.fake.release.is_set())
            self.assertTrue(self.history()["running"])
            await self.complete()
            async with connect(url) as socket:
                await socket.send(json.dumps({
                    "id": "reopen", "method": "kitOptimizeGet", "params": [self.sid, self.kit_id],
                }))
                history = json.loads(json.loads(await asyncio.wait_for(socket.recv(), 2))["result"])
                self.assertFalse(history["running"])
                self.assertEqual(history["messages"][-1]["content"], "原优化已完成，历史仍在。")

    async def test_completion_merges_into_concurrently_edited_kit(self) -> None:
        await self.start()
        original = self.bridge._kit_get(self.sid).kits[0]
        updated = json.loads(self.bridge._rpc_kitUpdate(self.sid, self.kit_id, json.dumps({
            "title": "用户在生成期间改名", "command": "Write-Output manually-edited",
        })))
        self.assertEqual(updated["status"], "ok")
        self.assertIsNot(original, self.bridge._kit_get(self.sid).kits[0])
        await self.complete()
        current = self.bridge._kit_get(self.sid).kits[0]
        self.assertEqual(current.title, "用户在生成期间改名")
        self.assertEqual(current.command, "Write-Output manually-edited")
        self.assertEqual(len(current.versions), 2)
        self.assertEqual(current.optimization_messages[-1].status, "done")
        # 基础执行版本已变化，旧候选仍保留，但不能误存为新版本。
        rejected = json.loads(self.bridge._rpc_kitOptimizeFinalize(
            self.sid, self.kit_id, current.optimization_messages[-1].id, "", False,
        ))
        self.assertEqual(rejected["status"], "error")

    async def test_restart_repairs_orphaned_answering_and_allows_retry(self) -> None:
        state = self.bridge._kit_get(self.sid)
        state.kits[0].optimization_messages.append(KitOptimizationMessage(
            id="orphan", role="assistant", content="", status="answering", readiness_version=2,
        ))
        self.bridge._kit_save(state)
        self.bridge._kit_states.clear()
        history = self.history()
        self.assertFalse(history["running"])
        self.assertEqual(history["messages"][0]["status"], "error")
        self.assertIn("已中断", history["messages"][0]["content"])
        await self.start()
        await self.complete()
        self.assertEqual(len(self.history()["messages"]), 3)

    async def test_cancelled_worker_is_terminal_and_preserves_prompt(self) -> None:
        await self.start()
        task = self.bridge._kit_optimization_tasks[self.key]
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        history = self.history()
        self.assertFalse(history["running"])
        self.assertEqual(history["messages"][0]["content"], "保留本次要求并增加复核")
        self.assertEqual(history["messages"][-1]["status"], "error")

    async def test_model_error_is_terminal_and_retry_does_not_lose_history(self) -> None:
        self.fake.error = True
        await self.start()
        await self.complete()
        self.assertFalse(self.history()["running"])
        self.assertIn("controlled optimizer failure", self.history()["messages"][-1]["content"])
        self.fake.error = False
        self.fake.release.clear()
        await self.start()
        await self.complete()
        self.assertEqual(len(self.history()["messages"]), 4)
        self.assertEqual(self.history()["messages"][-1]["status"], "done")

    async def test_invalid_request_never_starts_model(self) -> None:
        for kit_id, prompt in ((self.kit_id, " "), ("missing", "optimize")):
            result = json.loads(await self.bridge._rpc_kitOptimizeStart(self.sid, kit_id, prompt))
            self.assertEqual(result["status"], "error")
        self.factory.assert_not_called()
        self.assertEqual(self.history()["messages"], [])
