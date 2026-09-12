import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch

from src.backend.bridge_ws import BridgeWS, _REQUEST_IDENTITY_SOURCE
from src.backend.chat_kits import ChatKitTools, TOOL_NAME
from src.backend.openai_compat import OpenAICompatibleBackend
from src.backend.claude_code import ClaudeCodeOfficialBackend
from src.backend.workspace_kit_store import WorkspaceKit, KitRun, KitStepRun, CHAT_CHAIN_DESCRIPTION
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

    async def publishing_run(self, delegated=True, ident="publish"):
        self.manager = Mock()
        self.manager.approval_config_fingerprint.return_value = "config-1"
        self.manager.start_publish = AsyncMock(return_value={"job": {"id": "job"}})
        self.manager.status.return_value = {"jobs": [{"id": "job", "status": "succeeded"}]}
        self.bridge._release_center_manager = self.manager
        self.bridge._kit_capabilities.prepare = AsyncMock(return_value={
            "phase": "waiting_approval", "planId": "plan", "planFingerprint": "f" * 64,
            "plan": {"id": "plan", "fingerprint": "f" * 64, "status": "ready",
                     "channel": "stable", "manifestUrl": "https://example.com/stable/manifest.json",
                     "candidate": {"version": "1.2.3"}, "blockers": [], "warnings": [],
                     "artifacts": [{"id": "windows", "platform": "windows", "sha256": "a" * 64}]},
        })
        self.token = self.service.issue(self.session.id, allow_approval=delegated, message_id="human-message")
        self.kit(ident, objective="发布最新包", steps=[{
            "id": "publish", "type": "awu_capability", "target": "executor",
            "config": {"capability": "release.publish_latest", "arguments": {"channel": "stable"}},
        }])
        result = await self.call("run", calls=[{"kitId": ident}], requestId=ident)
        self.assertEqual(result["status"], "ok", result)
        run = self.state.runs[-1]
        for _ in range(200):
            if run.status == "waiting_approval":
                return run
            await asyncio.sleep(.01)
        self.fail(f"did not reach approval: {run.status}, {run.error}")

    async def approve_args(self, run):
        result = await self.call("status", runId=run.id)
        pending = result["run"]["pendingApproval"]
        return {"runId": run.id, "stepId": pending["stepId"],
                "planFingerprint": pending["planFingerprint"], "requestId": "confirm-1"}

    async def test_delegation_requires_real_user_opt_in_not_model_arguments(self):
        run = await self.publishing_run(False)
        args = await self.approve_args(run)
        result = await self.call("approve", **args)
        self.assertIn("未获得委托", result["message"])
        self.assertEqual((await self.call("approve", **args, allowApproval=True))["status"], "error")
        self.assertFalse(run.approval_delegation)
        self.assertNotIn("approvalDelegation", run.to_dict())
        self.manager.start_publish.assert_not_awaited()

    async def test_delegated_approval_requires_status_and_is_audited_idempotent(self):
        run = await self.publishing_run()
        self.assertEqual(run.approval_delegation["plans"]["publish"], "f" * 64)
        self.assertEqual(KitRun.from_dict(run.to_dict()).approval_delegation, run.approval_delegation)
        blind = await self.call("approve", runId=run.id, stepId="publish", planFingerprint="f" * 64, requestId="confirm-1")
        self.assertIn("必须先", blind["message"])
        args = await self.approve_args(run)
        result = await self.call("approve", **args)
        self.assertEqual(result["status"], "ok", result)
        await asyncio.wait_for(self.bridge._kit_tasks[run.id], 3)
        self.assertEqual(run.status, "succeeded")
        approval = run.steps[0].config["capabilityRuntime"]["approval"]
        self.assertEqual(approval["source"], "chat-delegated")
        self.assertEqual(approval["userMessageId"], "human-message")
        self.assertEqual(approval["delegationId"], run.approval_delegation["id"])
        # 换轮次后的同一确认重试也只返回收据，绝不再次发布。
        self.token = self.service.issue(self.session.id)
        self.assertTrue((await self.call("approve", **args))["reused"])
        self.manager.start_publish.assert_awaited_once()
        self.assertEqual((await self.call("approve", **{**args, "planFingerprint": "changed"}))["status"], "error")

    async def test_delegation_survives_chat_end_but_not_scope_or_config_changes(self):
        run = await self.publishing_run()
        self.service.revoke(self.token)
        self.token = self.service.issue(self.session.id)
        args = await self.approve_args(run)
        self.manager.approval_config_fingerprint.return_value = "config-2"
        self.assertIn("配置已经变化", (await self.call("approve", **args))["message"])
        self.manager.approval_config_fingerprint.return_value = "config-1"
        run.steps[0].config["arguments"]["channel"] = "beta"
        self.assertIn("运行范围", (await self.call("approve", **args))["message"])
        run.steps[0].config["arguments"]["channel"] = "stable"
        self.assertEqual((await self.call("approve", **args))["status"], "ok")
        await asyncio.wait_for(self.bridge._kit_tasks[run.id], 3)

    async def test_expired_delegation_and_changed_plan_require_new_authorization(self):
        run = await self.publishing_run()
        args = await self.approve_args(run)
        expires = run.approval_delegation["expiresAt"]
        run.approval_delegation["expiresAt"] = time.time() - 1
        self.assertIn("过期", (await self.call("approve", **args))["message"])
        run.approval_delegation["expiresAt"] = expires
        runtime = run.steps[0].config["capabilityRuntime"]
        runtime["planFingerprint"] = runtime["plan"]["fingerprint"] = "b" * 64
        self.assertIn("计划已变化", (await self.call("approve", **args))["message"])
        pending = (await self.call("status", runId=run.id))["run"]["pendingApproval"]
        self.assertFalse(pending["canApprove"])
        self.assertIn("委托不一致", pending["reason"])
        args = await self.approve_args(run)
        self.assertIn("委托不一致", (await self.call("approve", **args))["message"])
        self.manager.start_publish.assert_not_awaited()

    async def test_approval_request_id_cannot_be_reused_for_another_run(self):
        first = await self.publishing_run(ident="first")
        self.assertEqual((await self.call("approve", **await self.approve_args(first)))["status"], "ok")
        await asyncio.wait_for(self.bridge._kit_tasks[first.id], 3)
        second = await self.publishing_run(ident="second")
        result = await self.call("approve", **await self.approve_args(second))
        self.assertIn("其他运行或步骤", result["message"])
        self.assertEqual(second.status, "waiting_approval")
        self.manager.start_publish.assert_not_awaited()

    async def test_pending_eligibility_matches_manual_scope_and_plan_fingerprint(self):
        run = await self.publishing_run(False)
        self.token = self.service.issue(self.session.id, allow_approval=True, message_id="new-message")
        pending = (await self.call("status", runId=run.id))["run"]["pendingApproval"]
        self.assertTrue(pending["canApprove"])
        run.trigger = "schedule"
        self.assertFalse((await self.call("status", runId=run.id))["run"]["pendingApproval"]["canApprove"])
        run.trigger = "manual"
        runtime = run.steps[0].config["capabilityRuntime"]
        runtime["planFingerprint"] = "different"
        pending = (await self.call("status", runId=run.id))["run"]["pendingApproval"]
        self.assertFalse(pending["canApprove"])
        self.assertIn("计划已变化", pending["reason"])
        self.manager.start_publish.assert_not_awaited()

    async def test_blocked_or_changed_review_never_approves(self):
        run = await self.publishing_run()
        args = await self.approve_args(run)
        plan = run.steps[0].config["capabilityRuntime"]["plan"]
        plan["warnings"] = ["new warning"]
        self.assertIn("旧预览", (await self.call("approve", **args))["message"])
        plan["blockers"] = ["bad hash"]
        self.assertIn("预检未通过", (await self.call("approve", **args))["message"])
        plan["blockers"] = []
        plan["artifacts"] = plan["artifacts"] * 101
        self.assertIn("制品过多", (await self.call("approve", **args))["message"])
        self.manager.start_publish.assert_not_awaited()

    async def test_approval_rechecks_permissions_owner_and_cancelled_state(self):
        run = await self.publishing_run()
        args = await self.approve_args(run)
        with patch.object(self.bridge, "_require_node_update_capability", side_effect=PermissionError("permission revoked")):
            self.assertIn("permission revoked", (await self.call("approve", **args))["message"])
        with patch.object(self.bridge, "_current_owner_id", return_value="other-user"):
            self.assertIn("授权用户", (await self.call("approve", **args))["message"])
        await self.call("cancel", runId=run.id)
        self.assertEqual((await self.call("approve", **args))["status"], "error")
        self.manager.start_publish.assert_not_awaited()

    async def test_one_send_cannot_delegate_multiple_runs(self):
        run = await self.publishing_run()
        await self.call("cancel", runId=run.id)
        result = await self.call("run", calls=[{"kitId": "publish"}], requestId="second-run")
        self.assertEqual(result["status"], "ok", result)
        self.assertNotEqual(result["run"]["id"], run.id)
        self.assertNotIn("approvalDelegation", result["run"])
        self.assertFalse(self.state.runs[-1].approval_delegation)

    async def test_existing_waiting_run_can_be_delegated_by_a_new_user_send(self):
        run = await self.publishing_run(False)
        self.token = self.service.issue(self.session.id, allow_approval=True, message_id="new-human-message")
        args = await self.approve_args(run)
        self.assertEqual((await self.call("approve", **args))["status"], "ok")
        await asyncio.wait_for(self.bridge._kit_tasks[run.id], 3)
        self.assertEqual(run.approval_delegation["messageId"], "new-human-message")

    async def test_send_wrapper_only_uses_separate_user_delegation_flag(self):
        leases = []
        async def capture(*args, **kwargs):
            leases.append(self.service.leases[kwargs["kit_token"]].copy())
        with patch.object(self.bridge, "_get_backend", return_value=ClaudeCodeOfficialBackend.__new__(ClaudeCodeOfficialBackend)), patch.object(
            self.bridge, "_async_send_with_kit_tools", side_effect=capture,
        ):
            await self.bridge._async_send(self.session, "我许可代确认", None, "fake", "m")
            await self.bridge._async_send(self.session, "发布", None, "fake", "m",
                                          kit_approval_delegation=True, user_message_id="explicit")
        self.assertFalse(leases[0]["allowApproval"])
        self.assertTrue(leases[1]["allowApproval"])
        self.assertEqual(leases[1]["messageId"], "explicit")

    async def test_send_payload_delegation_is_strict_boolean_and_not_inherited(self):
        for value in (True, False, "true", None):
            with self.subTest(value=value), patch.object(self.bridge, "_async_send", new_callable=AsyncMock) as send, patch.object(
                self.bridge, "_sync_backend_skills_to_directory",
            ):
                await self.bridge._handle_send_message(json.dumps({
                    "sessionId": self.session.id, "backendId": "fake", "content": "我许可代确认",
                    "messageId": f"assistant-{value}", "userMessageId": f"user-{value}",
                    "kitApprovalDelegation": value,
                }))
                send.assert_awaited_once()
                self.assertIs(send.call_args.kwargs["kit_approval_delegation"], value is True)
                self.assertEqual(send.call_args.kwargs["user_message_id"], f"user-{value}")

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

    async def test_new_chat_request_reuses_chain_but_creates_a_new_run(self):
        self.kit("a")
        self.kit("b")
        with patch.object(self.bridge, "_kit_shell_command", side_effect=lambda shell, cmd: [sys.executable, "-c", cmd]):
            first = await self.call("run", calls=[{"kitId": "a"}, {"kitId": "b"}], requestId="first")
            await asyncio.wait_for(self.bridge._kit_tasks[first["run"]["id"]], 10)
            self.token = self.service.issue(self.session.id)
            self.state.kits[0].title = "renamed child"
            self.state.kits[0].command = "print('updated child')"
            second = await self.call("run", calls=[{"kitId": "a", "inputs": {}}, {"kitId": "b"}], requestId="second")
            self.assertTrue(second["chainReused"], second)
            self.assertEqual(second["run"]["kitId"], first["run"]["kitId"])
            self.assertNotEqual(second["run"]["id"], first["run"]["id"])
            await asyncio.wait_for(self.bridge._kit_tasks[second["run"]["id"]], 10)
            self.assertEqual(self.state.runs[1].steps[1].command, "print('updated child')")
            self.assertEqual(self.state.runs[0].steps[1].command, "print('ok')")
        self.assertEqual(len(self.state.kits), 3)
        self.assertEqual(len(self.state.runs), 2)
        self.assertEqual(len(self.state.kits[-1].versions), 1)
        self.assertEqual(self.state.kits[-1].last_run_id, second["run"]["id"])

    def legacy_chain(self, ident, **kwargs):
        return self.kit(ident, command="", title="Chat 顺序执行 · A → B", description=CHAT_CHAIN_DESCRIPTION,
                        steps=[{"id": "1", "type": "kit_call", "kitId": "a", "title": "A", "inputs": {}},
                               {"id": "2", "type": "kit_call", "kitId": "b", "title": "B", "inputs": {}}],
                        **kwargs)

    async def test_legacy_duplicate_cards_share_history_without_rewriting_audits(self):
        self.kit("a")
        self.kit("b")
        first = self.legacy_chain("chain-one", createdAt=1)
        second = self.legacy_chain("chain-two", createdAt=2)
        first.last_run_id, second.last_run_id = "run-one", "run-two"
        self.state.runs.extend([
            KitRun(id="run-one", kit_id=first.id, session_id=self.session.id, status="succeeded"),
            KitRun(id="run-two", kit_id=second.id, session_id=self.session.id, status="succeeded",
                   approval_delegation={"id": "old-audit"},
                   steps=[KitStepRun(id="p", source_kit_id=second.id,
                                     config={"capabilityRuntime": {"approval": {"requestId": "old-request"}}})]),
        ])
        frozen = [run.to_dict() for run in self.state.runs]
        versions = second.to_dict()["versions"]
        result = await self.call("list")
        self.assertEqual([kit["id"] for kit in result["kits"]], ["a", "b", first.id])
        self.assertEqual(result["kits"][-1]["lastRunId"], "run-two")
        self.assertEqual(len(self.state.kits), 4)  # 旧定义仍归档保存，不丢失历史引用。
        payload = self.bridge._kit_payload(self.state)
        self.assertEqual(len(payload["kits"]), 3)
        self.assertEqual([run["canonicalKitId"] for run in payload["runs"]], [first.id, first.id])
        self.assertEqual(payload["runs"][-1]["kitId"], second.id)
        self.assertEqual([run.to_dict() for run in self.state.runs], frozen)
        self.assertEqual(second.to_dict()["versions"], versions)
        loaded = self.bridge._kit_store.load(self.session.id)
        self.assertEqual(loaded.chain_aliases, {second.id: first.id})
        self.assertEqual(len(loaded.visible_kits()), 3)
        with patch.object(self.bridge, "_kit_shell_command", side_effect=lambda shell, cmd: [sys.executable, "-c", cmd]):
            result = await self.call("run", calls=[{"kitId": "a"}, {"kitId": "b"}], requestId="next")
            self.assertTrue(result["chainReused"])
            self.assertEqual(result["run"]["kitId"], first.id)
            await asyncio.wait_for(self.bridge._kit_tasks[result["run"]["id"]], 10)

    async def test_chain_signature_preserves_order_parameters_and_contract(self):
        first = self.legacy_chain("one")
        second = WorkspaceKit.from_dict(first.to_dict())
        second.title = "same intent, another title"
        second.chat_chain = True
        second.steps[0]["title"] = "new label"
        second.steps[0]["id"] = "new-step-id"
        del second.steps[0]["inputs"]
        self.assertEqual(first.chat_chain_key(), second.chat_chain_key())
        for change in (
            {"steps": list(reversed(first.steps))},
            {"steps": [{**first.steps[0], "inputs": {"channel": "beta"}}, first.steps[1]]},
            {"cwd": "nested"}, {"executionTarget": "client"},
            {"successCriteria": "different acceptance"}, {"safetyConstraints": "additional restriction"},
        ):
            with self.subTest(change=change):
                candidate = WorkspaceKit.from_dict({**first.to_dict(), **change})
                self.assertNotEqual(first.chat_chain_key(), candidate.chat_chain_key())
        manual = WorkspaceKit.from_dict({**first.to_dict(), "title": "Manually created chain"})
        self.assertEqual(manual.chat_chain_key(), "")

    async def test_legacy_migration_skips_active_or_customized_chains(self):
        first = self.legacy_chain("one")
        second = self.legacy_chain("two")
        run = KitRun(id="active", kit_id=second.id, session_id=self.session.id, status="waiting_approval")
        self.state.runs.append(run)
        self.assertFalse(self.state.reconcile_chat_chains())
        run.status = "succeeded"
        self.assertFalse(self.state.reconcile_chat_chains({first.id}))
        second.append_version("manual")
        self.assertFalse(self.state.reconcile_chat_chains())
        second.versions.pop()
        second.enabled = False
        self.assertFalse(self.state.reconcile_chat_chains())
        second.enabled = True
        self.assertTrue(self.state.reconcile_chat_chains())
        self.assertFalse(self.state.reconcile_chat_chains())

    async def test_reused_disabled_chain_is_not_recreated_or_removed_on_failure(self):
        self.kit("a")
        self.kit("b")
        chain = self.legacy_chain("existing", enabled=False)
        result = await self.call("run", calls=[{"kitId": "a"}, {"kitId": "b"}], requestId="disabled")
        self.assertIn("已停用", result["message"])
        self.assertEqual(len(self.state.kits), 3)
        self.assertIs(self.state.kits[-1], chain)
        self.assertEqual(self.state.runs, [])
        chain.enabled = True
        with patch.object(self.bridge, "_queue_workspace_kit_run", side_effect=ValueError("queue failed")):
            result = await self.call("run", calls=[{"kitId": "a"}, {"kitId": "b"}], requestId="fail")
        self.assertEqual(result["status"], "error")
        self.assertIs(self.state.kits[-1], chain)

    async def test_deleting_group_removes_archived_cards_but_keeps_runs(self):
        first = self.legacy_chain("one", createdAt=1)
        second = self.legacy_chain("two", createdAt=2)
        self.state.runs.append(KitRun(id="old", kit_id=second.id, session_id=self.session.id, status="succeeded"))
        self.state.reconcile_chat_chains()
        self.state.runs[0].status = "running"
        self.assertEqual(json.loads(self.bridge._rpc_kitDelete(self.session.id, first.id))["status"], "error")
        self.state.runs[0].status = "succeeded"
        self.assertEqual(json.loads(self.bridge._rpc_kitDelete(self.session.id, first.id))["status"], "ok")
        self.assertEqual(self.state.kits, [])
        self.assertEqual(self.state.chain_aliases, {})
        self.assertEqual(len(self.state.runs), 1)

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
