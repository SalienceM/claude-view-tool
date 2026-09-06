import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from src.backend.bridge_ws import BridgeWS
from src.backend.loop_store import STAGE_EXECUTE
from src.types import ChatMessage, Session


def _session() -> Session:
    return Session(
        id="normal-1",
        title="Existing work",
        created_at=1.0,
        updated_at=2.0,
        messages=[ChatMessage(id="m1", role="user", content="keep me")],
        working_dir="C:/workspace",
        backend_id="official-codex",
        agent_session_id="native-thread-1",
        session_type="normal",
    )


def _bridge(session: Session) -> BridgeWS:
    bridge = BridgeWS.__new__(BridgeWS)
    bridge._active_sessions = {session.id: session}
    bridge._session_store = Mock()
    bridge._session_store.load.return_value = session
    bridge._loop_store = Mock()
    bridge._loop_states = {}
    bridge._loop_store.load.return_value = None
    bridge._session_destroy_busy_reason = Mock(return_value="")
    bridge._emit_session_updated = Mock()
    bridge._emit_loop_updated = Mock()
    return bridge


class SessionToLoopTests(unittest.TestCase):
    def test_conversion_requires_an_explicit_goal(self) -> None:
        session = _session()
        bridge = _bridge(session)

        result = json.loads(bridge._rpc_convertSessionToLoop(session.id, "   "))

        self.assertEqual("error", result["status"])
        self.assertIn("必须制定", result["message"])
        self.assertEqual("normal", session.session_type)
        bridge._session_store.save.assert_not_called()

    def test_idle_normal_session_converts_without_losing_context(self) -> None:
        session = _session()
        original_messages = session.messages
        bridge = _bridge(session)

        result = json.loads(bridge._rpc_convertSessionToLoop(
            session.id, "  完成现有项目并通过真实测试  ",
        ))

        self.assertEqual("ok", result["status"])
        self.assertEqual("loop", session.session_type)
        self.assertEqual("loop", session.loop_control_mode)
        self.assertIs(original_messages, session.messages)
        self.assertEqual("native-thread-1", session.agent_session_id)
        self.assertEqual("C:/workspace", session.working_dir)
        self.assertEqual("official-codex", session.backend_id)

        state = bridge._loop_states[session.id]
        self.assertEqual(STAGE_EXECUTE, state.stage)
        self.assertEqual("完成现有项目并通过真实测试", state.goal)
        self.assertEqual(1, len(state.goal_history))
        self.assertEqual("manual", state.goal_history[0].source)
        self.assertFalse(state.auto)

        bridge._session_store.save.assert_called_once_with(session, async_=False)
        event = bridge._emit_session_updated.call_args.args[0]
        self.assertEqual("session_changed", event["type"])
        self.assertEqual("loop", event["summary"]["sessionType"])
        bridge._emit_loop_updated.assert_called_once_with(state)

    def test_running_session_is_rejected(self) -> None:
        session = _session()
        bridge = _bridge(session)
        bridge._session_destroy_busy_reason.return_value = "Session 仍有对话任务正在运行"

        result = json.loads(bridge._rpc_convertSessionToLoop(session.id, "目标"))

        self.assertEqual("error", result["status"])
        self.assertIn("结束后才能转换", result["message"])
        self.assertEqual("normal", session.session_type)
        bridge._session_store.save.assert_not_called()
        bridge._emit_session_updated.assert_not_called()

    def test_failed_session_persistence_rolls_back_loop_state(self) -> None:
        session = _session()
        bridge = _bridge(session)
        bridge._session_store.save.side_effect = OSError("disk full")

        result = json.loads(bridge._rpc_convertSessionToLoop(session.id, "目标"))

        self.assertEqual("error", result["status"])
        self.assertIn("disk full", result["message"])
        self.assertEqual("normal", session.session_type)
        self.assertIsNone(session.loop_control_mode)
        self.assertNotIn(session.id, bridge._loop_states)
        bridge._loop_store.delete.assert_called_once_with(session.id)
        bridge._emit_session_updated.assert_not_called()
        bridge._emit_loop_updated.assert_not_called()

    def test_retry_after_committed_conversion_is_idempotent(self) -> None:
        session = _session()
        bridge = _bridge(session)
        first = json.loads(bridge._rpc_convertSessionToLoop(session.id, "原始目标"))
        self.assertEqual("ok", first["status"])
        bridge._session_store.save.reset_mock()

        retry = json.loads(bridge._rpc_convertSessionToLoop(session.id, "不会覆盖的新目标"))

        self.assertEqual("ok", retry["status"])
        self.assertTrue(retry["alreadyConverted"])
        self.assertEqual("原始目标", retry["goal"])
        bridge._session_store.save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
