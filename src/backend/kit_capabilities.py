"""Workspace Kit 到 AgentWithU 内建服务的受控能力协议。

Kit 只能按这里注册的稳定 capability id 调用产品能力，不能把任意 Bridge RPC
名称当作步骤执行。高风险能力先生成不可变计划，再等待人类或有效的单次委托确认。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .release_center import ReleaseCenterManager


class KitCapabilityError(RuntimeError):
    """能力不存在、参数无效或能力执行失败。"""


@dataclass(frozen=True)
class KitCapabilityContext:
    release_center: ReleaseCenterManager
    working_dir: Path
    source: str


class KitCapabilityHandler(Protocol):
    id: str
    title: str
    description: str
    risk_level: str
    permission: str
    approval: str
    requires_explicit_intent: bool
    intent_hints: tuple[str, ...]
    argument_schema: dict[str, Any]
    example: dict[str, Any]

    async def prepare(
        self, arguments: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]: ...

    async def start(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]: ...

    async def poll(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]: ...

    async def cancel(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> None: ...


def _filter_values(arguments: dict[str, Any], singular: str) -> set[str]:
    raw = arguments.get(f"{singular}s", arguments.get(singular))
    if raw in (None, ""):
        return set()
    values = raw if isinstance(raw, list) else [raw]
    return {str(item).strip().lower() for item in values if str(item).strip()}


def _public_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """保存和展示足以审计的冻结快照，不把上传器的内部字段耦合给 KIT。"""
    manifest = dict(plan.get("manifest") or {})
    return {
        "id": str(plan.get("id") or ""),
        "status": str(plan.get("status") or ""),
        "candidateId": str(plan.get("candidateId") or ""),
        "candidate": dict(plan.get("candidate") or {}),
        "channel": str(plan.get("channel") or ""),
        "manifestUrl": str(plan.get("manifestUrl") or ""),
        "manifestKey": str(plan.get("manifestKey") or ""),
        "qiniuBucket": str(plan.get("qiniuBucket") or ""),
        "retentionCount": int(plan.get("retentionCount") or 0),
        "artifacts": [
            dict(item) for item in (manifest.get("artifacts") or [])
            if isinstance(item, dict)
        ],
        "release": dict(manifest.get("release") or {}),
        "blockers": [str(item) for item in (plan.get("blockers") or [])],
        "warnings": [str(item) for item in (plan.get("warnings") or [])],
        "comparison": dict(plan.get("comparison") or {}),
        "fingerprint": str(plan.get("fingerprint") or ""),
        "signatureConfigured": bool(plan.get("signatureConfigured")),
        "createdAt": plan.get("createdAt"),
    }


class ReleasePublishLatestCapability:
    id = "release.publish_latest"
    title = "发布最新包"
    description = "扫描当前工作区的最新制品，冻结发布计划，并在人工或有效的本次委托确认后正式发布。"
    risk_level = "high"
    permission = "node.release.manage"
    approval = "required"
    requires_explicit_intent = True
    intent_hints = ("发布", "publish", "release", "上线最新包", "更新发布清单")
    argument_schema = {
        "projectRoot": {
            "type": "string", "default": ".",
            "description": "Session 工作空间内的项目目录",
        },
        "channel": {
            "type": "string", "default": "stable",
            "description": "发布通道",
        },
        "notes": {"type": "string", "description": "本次更新说明"},
        "platforms": {
            "type": "string[]", "optional": True,
            "description": "只选择指定平台，如 windows/linux/macos",
        },
        "archs": {
            "type": "string[]", "optional": True,
            "description": "只选择指定架构",
        },
        "targets": {
            "type": "string[]", "optional": True,
            "description": "只选择指定安装目标，如 desktop/docker/executor",
        },
        "kinds": {
            "type": "string[]", "optional": True,
            "description": "只选择指定制品类型，如 msi/nsis/docker-bundle",
        },
        "artifactIds": {
            "type": "string[]", "optional": True,
            "description": "精确选择发布中心制品 ID",
        },
    }
    example = {
        "type": "awu_capability",
        "target": "executor",
        "title": "发布最新包",
        "config": {
            "capability": "release.publish_latest",
            "arguments": {
                "projectRoot": ".", "channel": "stable", "notes": "本次更新说明",
            },
        },
    }

    @staticmethod
    def _project_root(arguments: dict[str, Any], working_dir: Path) -> Path:
        raw = str(arguments.get("projectRoot") or ".").strip() or "."
        requested = Path(raw).expanduser()
        root = requested.resolve() if requested.is_absolute() else (working_dir / requested).resolve()
        if root != working_dir and working_dir not in root.parents:
            raise KitCapabilityError("发布项目目录不能超出当前 Session 工作空间")
        if not root.is_dir():
            raise KitCapabilityError(f"发布项目目录不存在：{root}")
        return root

    @staticmethod
    def _select_artifacts(
        candidate: dict[str, Any], arguments: dict[str, Any],
    ) -> list[dict[str, Any]]:
        artifacts = [
            dict(item) for item in (candidate.get("artifacts") or [])
            if isinstance(item, dict)
        ]
        raw_ids = arguments.get("artifactIds") or []
        explicit = {
            str(item) for item in (raw_ids if isinstance(raw_ids, list) else [raw_ids])
            if str(item).strip()
        }
        if explicit:
            artifacts = [item for item in artifacts if str(item.get("id") or "") in explicit]
        else:
            for field in ("platform", "arch", "target", "kind"):
                wanted = _filter_values(arguments, field)
                if wanted:
                    artifacts = [
                        item for item in artifacts
                        if str(item.get(field) or "").lower() in wanted
                    ]
            if not bool(arguments.get("includeStale", False)):
                artifacts = [item for item in artifacts if item.get("fresh") is not False]
        return artifacts

    async def prepare(
        self, arguments: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        root = self._project_root(arguments, context.working_dir)
        scanned = await asyncio.to_thread(
            context.release_center.scan_project,
            str(root),
            context.source,
        )
        candidate = dict(scanned.get("candidate") or {})
        selected = self._select_artifacts(candidate, arguments)
        if not selected:
            raise KitCapabilityError(
                "没有找到符合条件的本次新制品；请先完成打包，或调整平台/类型筛选"
            )
        options = {
            key: arguments[key] for key in (
                "channel", "notes", "baseUrl", "qiniuBucket", "prefix",
                "manifestKey", "stableManifestUrl", "requireSignature",
            ) if key in arguments
        }
        preview = await context.release_center.preview(
            str(candidate.get("id") or ""),
            [str(item.get("id") or "") for item in selected],
            options,
        )
        plan = dict(preview.get("plan") or {})
        public_plan = _public_plan(plan)
        blockers = list(public_plan.get("blockers") or [])
        return {
            "phase": "blocked" if blockers else "waiting_approval",
            "planId": str(plan.get("id") or ""),
            "planFingerprint": str(plan.get("fingerprint") or ""),
            "plan": public_plan,
            "message": (
                "发布预检存在阻断项" if blockers
                else "发布计划已冻结，等待人工确认或已获本次委托的 Agent 核对后确认"
            ),
        }

    async def start(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        plan_id = str(runtime.get("planId") or "")
        if not plan_id:
            raise KitCapabilityError("冻结发布计划不存在，请重新运行 KIT")
        result = await context.release_center.start_publish(plan_id)
        job = dict(result.get("job") or {})
        if not job.get("id"):
            raise KitCapabilityError("发布中心没有返回任务 ID")
        return job

    async def poll(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        job_id = str(runtime.get("jobId") or "")
        if not job_id:
            raise KitCapabilityError("发布任务 ID 不存在")
        status = await asyncio.to_thread(context.release_center.status)
        job = next(
            (dict(item) for item in (status.get("jobs") or []) if item.get("id") == job_id),
            None,
        )
        if job is None:
            raise KitCapabilityError("发布任务已不在发布中心账本中")
        return job

    async def cancel(
        self, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> None:
        job_id = str(runtime.get("jobId") or "")
        if job_id:
            await context.release_center.cancel_publish(job_id)


class KitCapabilityRegistry:
    """稳定 capability id 白名单及其统一生命周期入口。"""

    def __init__(self) -> None:
        handlers: list[KitCapabilityHandler] = [ReleasePublishLatestCapability()]
        self._handlers = {handler.id: handler for handler in handlers}

    def metadata(self, capability_id: str) -> dict[str, Any]:
        handler = self._handlers.get(str(capability_id or ""))
        if handler is None:
            raise KitCapabilityError(f"未注册的 AgentWithU 能力：{capability_id}")
        return {
            "id": handler.id,
            "title": handler.title,
            "description": handler.description,
            "riskLevel": handler.risk_level,
            "permission": handler.permission,
            "approval": handler.approval,
            "requiresExplicitIntent": handler.requires_explicit_intent,
            "intentHints": list(handler.intent_hints),
            "argumentSchema": handler.argument_schema,
            "example": handler.example,
        }

    def list(self) -> list[dict[str, Any]]:
        return [self.metadata(capability_id) for capability_id in self._handlers]

    def intent_matches(self, capability_id: str, human_intent: str) -> bool:
        """判断人类契约是否明确授权使用该能力。

        这里不让模型自行解释“差不多算授权”：需要显式意图的能力必须命中能力
        自己登记的提示词。低风险、无需显式授权的能力则可由编译器按目标自动选择。
        """
        metadata = self.metadata(capability_id)
        if not metadata.get("requiresExplicitIntent"):
            return True
        normalized = str(human_intent or "").casefold()
        return any(
            str(hint).strip().casefold() in normalized
            for hint in (metadata.get("intentHints") or [])
            if str(hint).strip()
        )

    def validate(self, capability_id: str, arguments: Any) -> dict[str, Any]:
        self.metadata(capability_id)
        if arguments is None:
            return {}
        if not isinstance(arguments, dict):
            raise KitCapabilityError("AgentWithU 能力参数必须是 JSON 对象")
        return dict(arguments)

    async def prepare(
        self, capability_id: str, arguments: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        handler = self._handlers[capability_id]
        return await handler.prepare(arguments, context)

    async def start(
        self, capability_id: str, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        return await self._handlers[capability_id].start(runtime, context)

    async def poll(
        self, capability_id: str, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> dict[str, Any]:
        return await self._handlers[capability_id].poll(runtime, context)

    async def cancel(
        self, capability_id: str, runtime: dict[str, Any], context: KitCapabilityContext,
    ) -> None:
        await self._handlers[capability_id].cancel(runtime, context)
