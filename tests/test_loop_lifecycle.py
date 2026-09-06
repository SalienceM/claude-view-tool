import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS, _LoopAgentStalledError
from src.backend.loop_store import (
    LoopPolicy,
    LoopRecord,
    LoopState,
    LoopStep,
    STAGE_EXECUTE,
    STAGE_OUT,
    SUB_PREPARE,
)
from src.types import ChatMessage


class LoopLifecycleTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _bridge(state: LoopState) -> tuple[BridgeWS, SimpleNamespace]:
        bridge = BridgeWS.__new__(BridgeWS)
        session = SimpleNamespace(
            id=state.session_id,
            agent_session_id=None,
            auto_commit=False,
        )
        bridge._active_sessions = {state.session_id: session}
        bridge._session_store = SimpleNamespace(
            load=lambda _sid: session,
            save=lambda *_args, **_kwargs: None,
        )
        bridge._loop_states = {state.session_id: state}
        bridge._loop_state = lambda sid: bridge._loop_states.get(sid)
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()
        bridge._loop_history_brief = lambda *_args, **_kwargs: ""
        bridge._loop_running = set()
        bridge._loop_tasks = {}
        bridge._loop_cancel = {}
        bridge._loop_pending_out = set()
        bridge._loop_pending_continues = {}
        bridge._loop_active_backends = {}
        bridge._abort_loop_backend_calls = Mock()
        return bridge, session

    async def _start_blocked_iteration(
        self,
        bridge: BridgeWS,
        session_id: str,
    ) -> asyncio.Task:
        started = asyncio.Event()
        blocker = asyncio.Event()

        async def blocked_prepare(*_args, **_kwargs) -> None:
            started.set()
            await blocker.wait()

        bridge._loop_do_prepare = blocked_prepare
        bridge._loop_do_execute = Mock()
        bridge._loop_do_analysis = Mock()
        self.assertTrue(bridge._schedule_loop_iteration(session_id))
        await asyncio.wait_for(started.wait(), timeout=1)
        task = bridge._active_loop_task(session_id)
        self.assertIsNotNone(task)
        return task

    async def test_continue_cancels_stuck_previous_loop_and_opens_new_round(self) -> None:
        sid = "loop-stuck-continue"
        record = LoopRecord(
            seq=1,
            round=1,
            sub_stage=SUB_PREPARE,
            orchestration=[LoopStep(index=1, status="running", desc="blocked")],
        )
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            round=1,
            loops=[record],
        )
        bridge, _session = self._bridge(state)
        task = await self._start_blocked_iteration(bridge, sid)

        # 模拟旧实现已经把 UI 推到 loopout，但旧顶层任务仍未退出。
        state.stage = STAGE_OUT
        result = json.loads(bridge._rpc_loopContinue(sid, "second round"))

        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["stopping"])
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)

        self.assertEqual(state.stage, STAGE_EXECUTE)
        self.assertEqual(state.round, 2)
        self.assertEqual(state.goal, "second round")
        self.assertIn("中止上一轮", record.error)
        self.assertEqual(record.orchestration[0].status, "error")
        self.assertFalse(bridge._loop_is_running(sid))

    async def test_advance_out_cancels_active_iteration_instead_of_orphaning_it(self) -> None:
        sid = "loop-stuck-out"
        record = LoopRecord(
            seq=1,
            round=1,
            sub_stage=SUB_PREPARE,
            orchestration=[LoopStep(index=1, status="running", desc="blocked")],
        )
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            round=1,
            loops=[record],
        )
        bridge, _session = self._bridge(state)
        task = await self._start_blocked_iteration(bridge, sid)

        result = json.loads(bridge._rpc_loopAdvanceToOut(sid))

        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["stopping"])
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)

        self.assertEqual(state.stage, STAGE_OUT)
        self.assertEqual(state.status, "aborted")
        self.assertIn("进入 loopout", record.error)
        self.assertFalse(bridge._loop_is_running(sid))

    async def test_restart_residue_is_sealed_before_new_round(self) -> None:
        sid = "loop-restart-residue"
        record = LoopRecord(
            seq=3,
            round=1,
            sub_stage=SUB_PREPARE,
            orchestration=[LoopStep(index=8, status="running", desc="stale")],
        )
        state = LoopState(
            session_id=sid,
            stage=STAGE_OUT,
            round=1,
            loops=[record],
        )
        bridge, _session = self._bridge(state)

        result = json.loads(bridge._rpc_loopContinue(sid, "recover"))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(state.round, 2)
        self.assertEqual(state.stage, STAGE_EXECUTE)
        self.assertTrue(record.error)
        self.assertEqual(record.orchestration[0].status, "error")

    async def test_empty_manual_takeover_releases_despite_stale_flags_and_queue(self) -> None:
        sid = "manual-empty-release"
        record = LoopRecord(
            seq=2,
            kind="manual",
            round=1,
            manual_start_index=1,
        )
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            control_mode="manual",
            loops=[record],
        )
        # 旧消息的 streaming=True 是一次中断留下的磁盘残渣，不代表真实任务。
        session = SimpleNamespace(
            id=sid,
            messages=[SimpleNamespace(streaming=True)],
        )
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_states = {sid: state}
        bridge._loop_state = lambda key: bridge._loop_states.get(key)
        bridge._active_sessions = {sid: session}
        bridge._session_store = SimpleNamespace(load=lambda _sid: session)
        bridge._chat_turn_tasks = {}
        bridge._chat_extras_get = lambda _sid: SimpleNamespace(pending=lambda: [object()])
        bridge._sync_manual_loop_record = Mock()
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()

        result = json.loads(bridge._rpc_loopRelease(sid))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(state.control_mode, "loop")
        self.assertEqual(state.loops, [])

    async def test_loopout_can_open_a_new_manual_round_atomically(self) -> None:
        sid = "loopout-manual-round"
        state = LoopState(
            session_id=sid,
            stage=STAGE_OUT,
            round=3,
            goal="original goal",
            auto=True,
            loops=[LoopRecord(seq=7, kind="auto", round=3, completed=True)],
        )
        bridge, session = self._bridge(state)
        session.session_type = "loop"
        session.messages = []
        session.backend_id = "qwen-enterprise"
        session.working_dir = "C:/workspace"
        bridge._session_is_streaming = Mock(return_value=False)
        bridge._loop_context_digest = Mock(return_value="round 3 output digest")
        bridge._resolved_runtime = Mock(return_value={"model": "qwen-enterprise-model"})
        bridge._session_runtime = Mock(return_value={})
        bridge._mirror_loop_control_mode = Mock()

        with patch("src.backend.bridge_ws.git_snapshot", return_value="checkpoint"):
            result = json.loads(bridge._rpc_loopTakeover(sid, "human follow-up goal"))

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["controlMode"], "manual")
        self.assertEqual(result["stage"], STAGE_EXECUTE)
        self.assertEqual(result["round"], 4)
        self.assertEqual(state.stage, STAGE_EXECUTE)
        self.assertEqual(state.round, 4)
        self.assertEqual(state.goal, "human follow-up goal")
        self.assertFalse(state.auto)
        self.assertEqual(state.control_mode, "manual")
        manual = state.loops[-1]
        self.assertEqual(manual.kind, "manual")
        self.assertEqual(manual.round, 4)
        self.assertEqual(manual.seq, 8)
        self.assertEqual(manual.manual_context, "round 3 output digest")
        self.assertEqual(manual.backends["execute"], "qwen-enterprise")
        bridge._loop_save.assert_called_once_with(state)
        bridge._mirror_loop_control_mode.assert_called_once_with(session, "manual")
        bridge._emit_loop_updated.assert_called_once_with(state)

    async def test_manual_release_obeys_authoritative_running_task(self) -> None:
        sid = "manual-real-running"
        record = LoopRecord(seq=1, kind="manual", round=1)
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            control_mode="manual",
            loops=[record],
        )
        session = SimpleNamespace(id=sid, messages=[])
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_state = lambda _sid: state
        bridge._active_sessions = {sid: session}
        bridge._session_store = SimpleNamespace(load=lambda _sid: session)
        release = asyncio.Event()
        task = asyncio.create_task(release.wait())
        bridge._chat_turn_tasks = {sid: {task}}

        result = json.loads(bridge._rpc_loopRelease(sid))

        self.assertEqual(result["status"], "error")
        self.assertIn("仍在生成", result["message"])
        self.assertEqual(state.control_mode, "manual")
        release.set()
        await task

    async def test_finalize_manual_record_repairs_stale_streaming_step(self) -> None:
        sid = "manual-finalize-stale"
        record = LoopRecord(
            seq=4,
            kind="manual",
            round=1,
            manual_start_index=0,
        )
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            control_mode="manual",
            loops=[record],
        )
        session = SimpleNamespace(
            id=sid,
            backend_id="backend-1",
            working_dir=".",
            messages=[
                ChatMessage(id="u", role="user", content="do it", timestamp=1),
                ChatMessage(
                    id="a",
                    role="assistant",
                    content="partial but finished",
                    timestamp=2,
                    streaming=True,
                ),
            ],
        )
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_state = lambda _sid: state
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()
        bridge._resolved_runtime = lambda *_args: {}
        bridge._session_runtime = lambda *_args: {}

        with patch("src.backend.bridge_ws.git_snapshot", return_value=None):
            bridge._sync_manual_loop_record(session, finalize=True)

        self.assertTrue(record.completed)
        self.assertEqual(record.orchestration[0].status, "done")
        self.assertGreater(record.orchestration[0].ended_at, 0)

    async def test_iteration_broadcasts_running_start_and_idle_finish(self) -> None:
        sid = "loop-running-events"
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            loops=[LoopRecord(seq=1, round=1, sub_stage=SUB_PREPARE)],
        )
        bridge, _session = self._bridge(state)
        observed: list[bool] = []
        bridge._emit_loop_updated = lambda current: observed.append(
            bridge._loop_is_running(current.session_id)
        )

        async def finish_stage(*_args, **_kwargs) -> None:
            return None

        bridge._loop_do_prepare = finish_stage
        bridge._loop_do_execute = finish_stage
        bridge._loop_do_analysis = finish_stage

        self.assertTrue(bridge._schedule_loop_iteration(sid))
        task = bridge._active_loop_task(sid)
        self.assertIsNotNone(task)
        await task
        # done callback 负责从 registry 移除任务并补发 running=false。
        await asyncio.sleep(0)

        self.assertTrue(observed[0])
        self.assertFalse(observed[-1])
        self.assertFalse(bridge._loop_is_running(sid))

    async def test_auto_continues_after_a_terminal_iteration_failure(self) -> None:
        sid = "loop-auto-after-error"
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            auto=True,
            loops=[LoopRecord(seq=1, round=1, error="analysis backend timed out")],
            policy=LoopPolicy(max_loops=8),
        )
        bridge, _session = self._bridge(state)
        bridge._schedule_loop_iteration = Mock(return_value=True)

        bridge._maybe_autocontinue(sid)

        bridge._schedule_loop_iteration.assert_called_once_with(sid)
        self.assertEqual(state.stage, STAGE_EXECUTE)

    async def test_auto_stops_after_three_consecutive_iteration_failures(self) -> None:
        sid = "loop-auto-failure-circuit-breaker"
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            auto=True,
            loops=[
                LoopRecord(seq=1, round=1, error="prepare failed"),
                LoopRecord(seq=2, round=1, error="execute failed"),
                LoopRecord(seq=3, round=1, error="analysis failed"),
            ],
            policy=LoopPolicy(max_loops=20),
        )
        bridge, _session = self._bridge(state)
        bridge._schedule_loop_iteration = Mock(return_value=True)

        bridge._maybe_autocontinue(sid)

        bridge._schedule_loop_iteration.assert_not_called()
        self.assertEqual(state.stage, STAGE_OUT)
        self.assertEqual(state.status, "aborted")
        self.assertIn("连续 3 次", state.stop_reason)
        bridge._loop_save.assert_called_with(state)
        bridge._emit_loop_updated.assert_called_with(state)

    async def test_auto_completed_iteration_with_step_error_still_continues(self) -> None:
        sid = "loop-auto-step-error"
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            auto=True,
            loops=[LoopRecord(
                seq=1,
                round=1,
                completed=True,
                orchestration=[LoopStep(index=1, status="error", desc="weak model failed")],
            )],
            policy=LoopPolicy(max_loops=8),
        )
        bridge, _session = self._bridge(state)
        bridge._schedule_loop_iteration = Mock(return_value=True)

        bridge._maybe_autocontinue(sid)

        bridge._schedule_loop_iteration.assert_called_once_with(sid)

    async def test_failed_iteration_does_not_continue_when_auto_is_off(self) -> None:
        sid = "loop-manual-after-error"
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            auto=False,
            loops=[LoopRecord(seq=1, round=1, error="prepare failed")],
        )
        bridge, _session = self._bridge(state)
        bridge._schedule_loop_iteration = Mock(return_value=True)

        bridge._maybe_autocontinue(sid)

        bridge._schedule_loop_iteration.assert_not_called()

    async def test_failed_iterations_respect_max_loop_limit_without_analysis(self) -> None:
        sid = "loop-auto-error-max"
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            auto=True,
            risk_coefficient=0.0,
            loops=[
                LoopRecord(seq=1, round=1, error="prepare failed"),
                LoopRecord(seq=2, round=1, error="prepare failed again"),
            ],
            policy=LoopPolicy(max_loops=2),
        )
        bridge, _session = self._bridge(state)
        bridge._schedule_loop_iteration = Mock(return_value=True)

        bridge._maybe_autocontinue(sid)

        bridge._schedule_loop_iteration.assert_not_called()
        self.assertEqual(state.stage, STAGE_OUT)
        self.assertEqual(state.stop_reason, "达到最大 loop 约束")

    def test_large_loop_budget_is_not_clamped_or_reduced_by_risk(self) -> None:
        policy = LoopPolicy.from_dict({"maxLoops": 500})
        state = LoopState(
            session_id="loop-large-budget",
            stage=STAGE_EXECUTE,
            risk_coefficient=0.4,
            policy=policy,
        )

        self.assertEqual(policy.max_loops, 500)
        self.assertEqual(state.effective_max_loops(), 500)
        self.assertEqual(state.to_dict()["effectiveMaxLoops"], 500)
        restored = LoopState.from_dict(state.to_dict())
        self.assertEqual(restored.policy.max_loops, 500)
        self.assertEqual(restored.effective_max_loops(), 500)

    def test_large_loop_budget_stops_at_configured_value_not_legacy_cap(self) -> None:
        state = LoopState(
            session_id="loop-large-budget-stop",
            stage=STAGE_EXECUTE,
            risk_coefficient=0.0,
            loops=[LoopRecord(seq=index, round=1, error="failed") for index in range(1, 500)],
            policy=LoopPolicy(max_loops=500),
        )
        bridge = BridgeWS.__new__(BridgeWS)

        self.assertEqual(bridge._loop_should_stop(state), (False, ""))
        state.loops.append(LoopRecord(seq=500, round=1, error="failed"))
        self.assertEqual(bridge._loop_should_stop(state), (True, "达到最大 loop 约束"))

    async def test_stalled_step_retries_with_fresh_context_and_keeps_artifacts(self) -> None:
        sid = "loop-step-auto-recovery"
        step = LoopStep(index=4, desc="run focused tests")
        record = LoopRecord(
            seq=2,
            round=1,
            goal="verify feature",
            orchestration=[step],
            backends={"execute": "weak-qwen"},
            runtimes={"execute": {"model": "enterprise-model"}},
        )
        state = LoopState(
            session_id=sid,
            stage=STAGE_EXECUTE,
            goal="ship feature",
            loops=[record],
            policy=LoopPolicy(step_stall_seconds=30, step_max_attempts=2),
        )
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_cancel = {}
        bridge._loop_save = Mock()
        bridge._emit_loop_updated = Mock()
        bridge._emit_loop_progress = Mock()
        calls = []

        async def run_agent(*args, **kwargs):
            calls.append((args, kwargs))
            if len(calls) == 1:
                raise _LoopAgentStalledError(30, partial_text="files already changed")
            return "focused tests passed", "fresh-agent-thread"

        bridge._loop_run_agent = run_agent
        session = SimpleNamespace(id=sid, backend_id="weak-qwen")

        result_sid = await bridge._loop_run_step(
            session, state, record, step,
            resume=True,
            indep_session_id=f"{sid}:loop2:steps",
            agent_session_id="old-agent-thread",
        )

        self.assertEqual(result_sid, "fresh-agent-thread")
        self.assertEqual(step.status, "done")
        self.assertEqual(step.output, "focused tests passed")
        self.assertEqual(step.attempts, 2)
        self.assertEqual(len(step.recovery_notes), 1)
        self.assertIn("无活动", step.recovery_notes[0])
        self.assertEqual(calls[0][1]["agent_session_id"], "old-agent-thread")
        self.assertIsNone(calls[1][1]["agent_session_id"])
        self.assertIn(":retry2", calls[1][1]["indep_session_id"])
        self.assertIn("自动恢复重试", calls[1][0][1])

    async def test_loop_agent_watchdog_aborts_a_silent_backend(self) -> None:
        class SilentBackend:
            def __init__(self):
                self.aborted = []
                self.cleared = []

            async def send_message(self, **_kwargs):
                await asyncio.Event().wait()

            def abort(self, call_sid):
                self.aborted.append(call_sid)

            def clear_cancelled(self, call_sid):
                self.cleared.append(call_sid)

        backend = SilentBackend()
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._loop_active_backends = {}
        bridge._new_backend_instance = lambda _backend_id: backend
        bridge._build_session_reference_context = lambda prompt, _sid: prompt
        bridge._emit_loop_progress = Mock()
        bridge._add_runtime_kwargs = lambda *_args, **_kwargs: None
        bridge._record_session_usage = Mock()
        bridge._session_store = SimpleNamespace(save=lambda *_args, **_kwargs: None)
        session = SimpleNamespace(
            id="silent-loop",
            backend_id="silent-backend",
            agent_session_id=None,
            working_dir=".",
            sandbox_enabled=False,
        )

        with self.assertRaises(_LoopAgentStalledError) as caught:
            await bridge._loop_run_agent(
                session, "do work", "step1", 1,
                resume=False,
                indep_session_id="silent-loop:loop1:step1",
                inactivity_timeout=0.05,
            )

        self.assertTrue(caught.exception.retryable)
        self.assertEqual(backend.aborted, ["silent-loop:loop1:step1"])
        self.assertEqual(backend.cleared, ["silent-loop:loop1:step1"])


if __name__ == "__main__":
    unittest.main()
