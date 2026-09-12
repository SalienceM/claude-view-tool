"""Session 级 Workspace Kit 状态、执行记录与数据市场。

Kit 是附着在 Session 上的标准化微任务：它有明确输入、执行过程、判言、结果视图
和可被其他 Kit 消费的输出。状态单独保存在 ``workspace-kits`` sidecar 中，避免与
持续写入的聊天 transcript 竞争。
"""
from __future__ import annotations

import json
import hashlib
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from . import paths


RUN_STATUSES = {
    "queued", "running", "waiting_client", "waiting_approval", "evaluating",
    "succeeded", "failed", "error", "cancelled",
}
FINAL_RUN_STATUSES = {"succeeded", "failed", "error", "cancelled"}
CONTROL_MODES = {"ai", "human", "shared"}
SHELLS = {"powershell", "cmd", "bash"}
EXECUTION_TARGETS = {"executor", "client"}
KIT_STEP_TYPES = {"command", "file_push", "kit_call", "awu_capability"}
KIT_STEP_STATUSES = {
    "pending", "running", "waiting_client", "waiting_approval", "succeeded", "failed",
    "error", "cancelled", "skipped",
}
KIT_GENERATION_STATUSES = {
    "queued", "running", "succeeded", "needs_input", "error", "cancelled",
}
FINAL_KIT_GENERATION_STATUSES = {
    "succeeded", "needs_input", "error", "cancelled",
}
CHAT_CHAIN_DESCRIPTION = "由当前聊天提交的组合 Kit，按顺序执行，首个失败停止。"


def _now() -> float:
    return time.time()


def _id() -> str:
    return str(uuid.uuid4())


def _dict_list(value: Any) -> list[dict]:
    return [dict(item) for item in (value or []) if isinstance(item, dict)]


def _safe_text(value: Any, limit: int = 200_000) -> str:
    return str(value or "")[:limit]


def _normalized_env_key(value: str) -> str:
    key = re.sub(r"[^A-Za-z0-9_]", "_", value or "").strip("_").upper()
    return key or "VALUE"


def kit_input_env_key(value: str) -> str:
    """Return the environment variable used by a rendered Kit input.

    Kept public so the runner can remove secret values from the persisted plan
    while still injecting them into the child process at execution time.
    """
    return f"KIT_INPUT_{_normalized_env_key(value)}"


KIT_IMPLEMENTATION_FIELDS = (
    "implementationSummary", "generationWarnings", "generatedByAi",
    "executionTarget", "steps", "command", "shell", "cwd", "timeoutSeconds",
    "inputs", "assertions", "outputs", "dependencies", "schedule", "view",
)


def _json_copy(value: Any) -> Any:
    """Kit DSL 只含 JSON 数据；序列化复制可同时切断可变对象引用。"""
    return json.loads(json.dumps(value, ensure_ascii=False))


@dataclass
class KitVersion:
    id: str
    version: str = "1.0"
    snapshot: dict = field(default_factory=dict)
    source: str = "create"
    note: str = ""
    created_at: float = field(default_factory=_now)

    def to_dict(self, *, include_snapshot: bool = True) -> dict:
        payload = {
            "id": self.id,
            "version": self.version,
            "source": self.source,
            "note": self.note,
            "createdAt": self.created_at,
        }
        if include_snapshot:
            payload["snapshot"] = self.snapshot
        return payload

    @classmethod
    def from_dict(cls, data: dict) -> "KitVersion":
        return cls(
            id=str(data.get("id") or _id()),
            version=_safe_text(data.get("version") or "1.0", 40),
            snapshot=dict(data.get("snapshot") or {}),
            source=_safe_text(data.get("source") or "create", 40),
            note=_safe_text(data.get("note"), 4_000),
            created_at=float(data.get("createdAt") or _now()),
        )


@dataclass
class KitOptimizationMessage:
    id: str
    role: str
    content: str = ""
    backend_id: str = ""
    status: str = "done"
    proposal: Optional[dict] = None
    warnings: list[str] = field(default_factory=list)
    # 普通 warnings 只提示风险；只有 blocking_issues 才阻止写入版本库。
    blocking_issues: list[str] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)
    ready: bool = False
    # 2 表示已按“提示 / 硬阻断”分级校验；旧记录在读取优化历史时重验。
    readiness_version: int = 0
    base_version_id: str = ""
    finalized_version_id: str = ""
    created_at: float = field(default_factory=_now)

    def to_dict(self, *, include_proposal: bool = True) -> dict:
        payload = {
            "id": self.id,
            "role": self.role,
            "content": self.content,
            "backendId": self.backend_id,
            "status": self.status,
            "warnings": self.warnings,
            "blockingIssues": self.blocking_issues,
            "questions": self.questions,
            "ready": self.ready,
            "readinessVersion": self.readiness_version,
            "baseVersionId": self.base_version_id,
            "finalizedVersionId": self.finalized_version_id,
            "createdAt": self.created_at,
        }
        if include_proposal:
            payload["proposal"] = self.proposal
        return payload

    @classmethod
    def from_dict(cls, data: dict) -> "KitOptimizationMessage":
        role = str(data.get("role") or "assistant")
        if role not in {"user", "assistant"}:
            role = "assistant"
        status = str(data.get("status") or "done")
        if status not in {"answering", "done", "error"}:
            status = "done"
        proposal = data.get("proposal")
        return cls(
            id=str(data.get("id") or _id()),
            role=role,
            content=_safe_text(data.get("content"), 100_000),
            backend_id=_safe_text(data.get("backendId"), 200),
            status=status,
            proposal=dict(proposal) if isinstance(proposal, dict) else None,
            warnings=[_safe_text(x, 2_000) for x in (data.get("warnings") or [])][:50],
            blocking_issues=[
                _safe_text(x, 2_000) for x in (data.get("blockingIssues") or [])
            ][:50],
            questions=[_safe_text(x, 2_000) for x in (data.get("questions") or [])][:20],
            ready=bool(data.get("ready", False)),
            readiness_version=2 if str(data.get("readinessVersion") or "0") == "2" else 0,
            base_version_id=_safe_text(data.get("baseVersionId"), 200),
            finalized_version_id=_safe_text(data.get("finalizedVersionId"), 200),
            created_at=float(data.get("createdAt") or _now()),
        )


@dataclass
class WorkspaceKit:
    id: str
    title: str = "未命名 Kit"
    description: str = ""
    # 人定义“做什么 / 怎样算成功 / 不能碰什么”，AI 再把它编译为下面的
    # command + assertions。保留原始自然语言，避免实现细节反客为主。
    objective: str = ""
    success_criteria: str = ""
    safety_constraints: str = ""
    references: list[str] = field(default_factory=list)
    implementation_summary: str = ""
    generation_warnings: list[str] = field(default_factory=list)
    generated_by_ai: bool = False
    chat_chain: bool = False
    # executor 是 Session 所属执行节点；client 是当前 AgentWithU 桌面客户端。
    execution_target: str = "executor"
    # 新 Kit 使用结构化步骤。空列表表示兼容旧版 command 单步骤 Kit。
    steps: list[dict] = field(default_factory=list)
    command: str = ""
    shell: str = "powershell"
    cwd: str = "."
    timeout_seconds: int = 300
    inputs: list[dict] = field(default_factory=list)
    assertions: list[dict] = field(default_factory=lambda: [
        {"type": "exit_code", "expected": 0, "label": "进程正常退出"},
    ])
    outputs: list[dict] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    schedule: dict = field(default_factory=lambda: {
        "mode": "manual", "intervalSeconds": 300, "nextRunAt": None,
    })
    view: dict = field(default_factory=lambda: {
        "default": "summary", "showLogs": True, "showData": True, "showTerminal": True,
    })
    enabled: bool = True
    control_mode: str = "shared"
    last_run_id: str = ""
    # 版本属于 Kit 本身。AI 只是其中一种产生版本的来源。
    versions: list[KitVersion] = field(default_factory=list)
    active_version_id: str = ""
    optimization_messages: list[KitOptimizationMessage] = field(default_factory=list)
    optimization_backend_id: str = ""
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "objective": self.objective,
            "successCriteria": self.success_criteria,
            "safetyConstraints": self.safety_constraints,
            "references": self.references,
            "implementationSummary": self.implementation_summary,
            "generationWarnings": self.generation_warnings,
            "generatedByAi": self.generated_by_ai,
            "chatChain": self.chat_chain,
            "executionTarget": self.execution_target,
            "steps": self.steps,
            "command": self.command,
            "shell": self.shell,
            "cwd": self.cwd,
            "timeoutSeconds": self.timeout_seconds,
            "inputs": self.inputs,
            "assertions": self.assertions,
            "outputs": self.outputs,
            "dependencies": self.dependencies,
            "schedule": self.schedule,
            "view": self.view,
            "enabled": self.enabled,
            "controlMode": self.control_mode,
            "lastRunId": self.last_run_id,
            "versions": [item.to_dict() for item in self.versions],
            "activeVersionId": self.active_version_id,
            "optimizationMessages": [item.to_dict() for item in self.optimization_messages],
            "optimizationBackendId": self.optimization_backend_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "WorkspaceKit":
        shell = str(data.get("shell") or "powershell").lower()
        if shell not in SHELLS:
            shell = "powershell"
        control_mode = str(data.get("controlMode") or "shared").lower()
        if control_mode not in CONTROL_MODES:
            control_mode = "shared"
        assertions = _dict_list(data.get("assertions"))
        if not assertions:
            assertions = [{"type": "exit_code", "expected": 0, "label": "进程正常退出"}]
        schedule = dict(data.get("schedule") or {})
        mode = "interval" if schedule.get("mode") == "interval" else "manual"
        try:
            interval = max(10, int(schedule.get("intervalSeconds") or 300))
        except (TypeError, ValueError):
            interval = 300
        schedule = {
            "mode": mode,
            "intervalSeconds": interval,
            "nextRunAt": schedule.get("nextRunAt"),
        }
        view = {
            "default": str((data.get("view") or {}).get("default") or "summary"),
            "showLogs": bool((data.get("view") or {}).get("showLogs", True)),
            "showData": bool((data.get("view") or {}).get("showData", True)),
            "showTerminal": bool((data.get("view") or {}).get("showTerminal", True)),
        }
        try:
            timeout = min(86_400, max(1, int(data.get("timeoutSeconds") or 300)))
        except (TypeError, ValueError):
            timeout = 300
        execution_target = str(data.get("executionTarget") or "executor").lower()
        if execution_target not in EXECUTION_TARGETS:
            execution_target = "executor"
        kit = cls(
            id=str(data.get("id") or _id()),
            title=_safe_text(data.get("title") or "未命名 Kit", 160),
            description=_safe_text(data.get("description"), 4_000),
            objective=_safe_text(data.get("objective") or data.get("description"), 12_000),
            success_criteria=_safe_text(data.get("successCriteria"), 12_000),
            safety_constraints=_safe_text(data.get("safetyConstraints"), 12_000),
            references=[
                _safe_text(item, 2_000) for item in (data.get("references") or [])
                if str(item).strip()
            ][:100],
            implementation_summary=_safe_text(data.get("implementationSummary"), 12_000),
            generation_warnings=[
                _safe_text(item, 2_000) for item in (data.get("generationWarnings") or [])
                if str(item).strip()
            ][:50],
            generated_by_ai=bool(data.get("generatedByAi", False)),
            chat_chain=data.get("chatChain") is True,
            execution_target=execution_target,
            steps=_dict_list(data.get("steps")),
            command=_safe_text(data.get("command"), 100_000),
            shell=shell,
            cwd=_safe_text(data.get("cwd") or ".", 2_000),
            timeout_seconds=timeout,
            inputs=_dict_list(data.get("inputs")),
            assertions=assertions,
            outputs=_dict_list(data.get("outputs")),
            dependencies=[str(x) for x in (data.get("dependencies") or []) if str(x).strip()],
            schedule=schedule,
            view=view,
            enabled=bool(data.get("enabled", True)),
            control_mode=control_mode,
            last_run_id=str(data.get("lastRunId") or ""),
            versions=[KitVersion.from_dict(x) for x in _dict_list(data.get("versions"))],
            active_version_id=str(data.get("activeVersionId") or ""),
            optimization_messages=[
                KitOptimizationMessage.from_dict(x)
                for x in _dict_list(data.get("optimizationMessages"))
            ][-200:],
            optimization_backend_id=_safe_text(data.get("optimizationBackendId"), 200),
            created_at=float(data.get("createdAt") or _now()),
            updated_at=float(data.get("updatedAt") or _now()),
        )
        # 旧 sidecar 懒迁移为 1.0。迁移只写入内存，下次正常保存时原子落盘。
        kit.ensure_initial_version("legacy")
        if not any(item.id == kit.active_version_id for item in kit.versions):
            kit.active_version_id = kit.versions[-1].id
        return kit

    def apply_patch(self, patch: dict) -> None:
        merged = self.to_dict()
        merged.update(patch or {})
        merged["id"] = self.id
        merged["createdAt"] = self.created_at
        updated = WorkspaceKit.from_dict(merged)
        self.__dict__.update(updated.__dict__)
        self.updated_at = _now()

    def implementation_snapshot(self) -> dict:
        current = self.to_dict()
        snapshot = {key: current.get(key) for key in KIT_IMPLEMENTATION_FIELDS}
        schedule = dict(snapshot.get("schedule") or {})
        # nextRunAt 是运行时游标，不属于可移植的编排版本。
        schedule["nextRunAt"] = None
        snapshot["schedule"] = schedule
        return _json_copy(snapshot)

    def chat_chain_key(self) -> str:
        """仅匹配聊天组合，按实际 DSL 判等，不用标题/自然语言相似度猜测功能。"""
        legacy = self.title.startswith("Chat 顺序执行 · ") and self.description == CHAT_CHAIN_DESCRIPTION
        if not (self.chat_chain or legacy) or len(self.steps) < 2:
            return ""
        if any(step.get("type") != "kit_call" or not step.get("kitId") for step in self.steps):
            return ""
        payload = self.implementation_snapshot()
        for key in ("implementationSummary", "generationWarnings", "generatedByAi"):
            payload.pop(key, None)
        payload["steps"] = [
            {**{key: value for key, value in step.items() if key not in {"id", "title", "inputs"}},
             "inputs": step.get("inputs") or {}}
            for step in self.steps
        ]
        payload.update(objective=self.objective, successCriteria=self.success_criteria,
                       safetyConstraints=self.safety_constraints, references=self.references,
                       controlMode=self.control_mode)
        return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def ensure_initial_version(self, source: str = "create") -> KitVersion:
        if self.versions:
            return self.versions[0]
        version = KitVersion(
            id=_id(), version="1.0", snapshot=self.implementation_snapshot(), source=source,
            note="初始版本" if source != "legacy" else "从旧版 Kit 自动迁移",
        )
        self.versions.append(version)
        self.active_version_id = version.id
        return version

    def append_version(
        self, source: str, note: str = "", snapshot: Optional[dict] = None,
        *, activate: bool = True,
    ) -> KitVersion:
        self.ensure_initial_version("legacy")
        highest_minor = 0
        for item in self.versions:
            match = re.fullmatch(r"1\.(\d+)", item.version)
            if match:
                highest_minor = max(highest_minor, int(match.group(1)))
        version = KitVersion(
            id=_id(), version=f"1.{highest_minor + 1}",
            snapshot=_json_copy(snapshot if snapshot is not None else self.implementation_snapshot()),
            source=source, note=_safe_text(note, 4_000),
        )
        self.versions.append(version)
        # “写入版本库”和“切换当前执行版本”是两个不同动作。优化对话可以
        # 先保存一份候选，而不打断已启用 Kit / Schedule 正在使用的版本。
        if activate:
            self.active_version_id = version.id
        self.updated_at = _now()
        return version

    def apply_version(self, version: KitVersion) -> None:
        current = self.to_dict()
        current.update(_json_copy(version.snapshot))
        current["id"] = self.id
        current["createdAt"] = self.created_at
        # 账本和优化对话永远不由快照反向覆盖。
        current["versions"] = [item.to_dict() for item in self.versions]
        current["activeVersionId"] = version.id
        current["optimizationMessages"] = [item.to_dict() for item in self.optimization_messages]
        current["optimizationBackendId"] = self.optimization_backend_id
        current["enabled"] = False
        updated = WorkspaceKit.from_dict(current)
        self.__dict__.update(updated.__dict__)
        self.active_version_id = version.id
        self.enabled = False
        self.schedule["nextRunAt"] = None
        self.updated_at = _now()


@dataclass
class KitAssertionResult:
    type: str
    label: str
    passed: bool
    expected: Any = None
    actual: Any = None
    message: str = ""

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "label": self.label,
            "passed": self.passed,
            "expected": self.expected,
            "actual": self.actual,
            "message": self.message,
        }


@dataclass
class KitStepRun:
    id: str
    type: str = "command"
    target: str = "executor"
    title: str = "执行步骤"
    source_kit_id: str = ""
    status: str = "pending"
    shell: str = "powershell"
    command: str = ""
    cwd: str = "."
    timeout_seconds: int = 300
    config: dict = field(default_factory=dict)
    inputs: dict = field(default_factory=dict)
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    assertions: list[KitAssertionResult] = field(default_factory=list)
    error: str = ""
    started_at: Optional[float] = None
    ended_at: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "target": self.target,
            "title": self.title,
            "sourceKitId": self.source_kit_id,
            "status": self.status,
            "shell": self.shell,
            "command": self.command,
            "cwd": self.cwd,
            "timeoutSeconds": self.timeout_seconds,
            "config": self.config,
            "inputs": self.inputs,
            "exitCode": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "assertions": [item.to_dict() for item in self.assertions],
            "error": self.error,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "KitStepRun":
        step_type = str(data.get("type") or "command").lower()
        if step_type not in KIT_STEP_TYPES:
            step_type = "command"
        target = str(data.get("target") or "executor").lower()
        if target not in EXECUTION_TARGETS:
            target = "executor"
        shell = str(data.get("shell") or "powershell").lower()
        if shell not in SHELLS:
            shell = "powershell"
        status = str(data.get("status") or "pending")
        if status not in KIT_STEP_STATUSES:
            status = "error"
        try:
            timeout = min(86_400, max(1, int(data.get("timeoutSeconds") or 300)))
        except (TypeError, ValueError):
            timeout = 300
        return cls(
            id=str(data.get("id") or _id()),
            type=step_type,
            target=target,
            title=_safe_text(data.get("title") or "执行步骤", 300),
            source_kit_id=str(data.get("sourceKitId") or ""),
            status=status,
            shell=shell,
            command=_safe_text(data.get("command"), 100_000),
            cwd=_safe_text(data.get("cwd") or ".", 2_000),
            timeout_seconds=timeout,
            config=dict(data.get("config") or {}),
            inputs=dict(data.get("inputs") or {}),
            exit_code=data.get("exitCode"),
            stdout=_safe_text(data.get("stdout")),
            stderr=_safe_text(data.get("stderr")),
            assertions=[
                KitAssertionResult(
                    type=str(x.get("type") or ""),
                    label=str(x.get("label") or x.get("type") or "判言"),
                    passed=bool(x.get("passed")),
                    expected=x.get("expected"),
                    actual=x.get("actual"),
                    message=str(x.get("message") or ""),
                )
                for x in _dict_list(data.get("assertions"))
            ],
            error=_safe_text(data.get("error"), 20_000),
            started_at=data.get("startedAt"),
            ended_at=data.get("endedAt"),
        )


@dataclass
class KitRun:
    id: str
    kit_id: str
    session_id: str
    trigger: str = "manual"
    owner: str = "human"
    status: str = "queued"
    verdict: str = "pending"
    inputs: dict = field(default_factory=dict)
    command: str = ""
    cwd: str = ""
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    assertions: list[KitAssertionResult] = field(default_factory=list)
    steps: list[KitStepRun] = field(default_factory=list)
    current_step: int = 0
    artifact_ids: list[str] = field(default_factory=list)
    approval_delegation: dict = field(default_factory=dict)
    error: str = ""
    started_at: Optional[float] = None
    ended_at: Optional[float] = None
    created_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kitId": self.kit_id,
            "sessionId": self.session_id,
            "trigger": self.trigger,
            "owner": self.owner,
            "status": self.status,
            "verdict": self.verdict,
            "inputs": self.inputs,
            "command": self.command,
            "cwd": self.cwd,
            "exitCode": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "assertions": [item.to_dict() for item in self.assertions],
            "steps": [item.to_dict() for item in self.steps],
            "currentStep": self.current_step,
            "artifactIds": self.artifact_ids,
            **({"approvalDelegation": self.approval_delegation} if self.approval_delegation else {}),
            "error": self.error,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "createdAt": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "KitRun":
        status = str(data.get("status") or "queued")
        if status not in RUN_STATUSES:
            status = "error"
        try:
            current_step = max(0, int(data.get("currentStep") or 0))
        except (TypeError, ValueError):
            current_step = 0
        return cls(
            id=str(data.get("id") or _id()),
            kit_id=str(data.get("kitId") or ""),
            session_id=str(data.get("sessionId") or ""),
            trigger=str(data.get("trigger") or "manual"),
            owner=str(data.get("owner") or "human"),
            status=status,
            verdict=str(data.get("verdict") or "pending"),
            inputs=dict(data.get("inputs") or {}),
            command=_safe_text(data.get("command"), 100_000),
            cwd=_safe_text(data.get("cwd"), 2_000),
            exit_code=data.get("exitCode"),
            stdout=_safe_text(data.get("stdout")),
            stderr=_safe_text(data.get("stderr")),
            assertions=[
                KitAssertionResult(
                    type=str(x.get("type") or ""),
                    label=str(x.get("label") or x.get("type") or "判言"),
                    passed=bool(x.get("passed")),
                    expected=x.get("expected"),
                    actual=x.get("actual"),
                    message=str(x.get("message") or ""),
                )
                for x in _dict_list(data.get("assertions"))
            ],
            steps=[KitStepRun.from_dict(x) for x in _dict_list(data.get("steps"))],
            current_step=current_step,
            artifact_ids=[str(x) for x in (data.get("artifactIds") or [])],
            approval_delegation=dict(data.get("approvalDelegation") or {}),
            error=_safe_text(data.get("error"), 20_000),
            started_at=data.get("startedAt"),
            ended_at=data.get("endedAt"),
            created_at=float(data.get("createdAt") or _now()),
        )


@dataclass
class KitArtifact:
    id: str
    session_id: str
    kit_id: str
    run_id: str
    key: str
    label: str
    type: str = "text"
    value: Any = None
    path: str = ""
    media_type: str = "text/plain"
    created_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sessionId": self.session_id,
            "kitId": self.kit_id,
            "runId": self.run_id,
            "key": self.key,
            "label": self.label,
            "type": self.type,
            "value": self.value,
            "path": self.path,
            "mediaType": self.media_type,
            "createdAt": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "KitArtifact":
        return cls(
            id=str(data.get("id") or _id()),
            session_id=str(data.get("sessionId") or ""),
            kit_id=str(data.get("kitId") or ""),
            run_id=str(data.get("runId") or ""),
            key=str(data.get("key") or "result"),
            label=str(data.get("label") or data.get("key") or "结果"),
            type=str(data.get("type") or "text"),
            value=data.get("value"),
            path=str(data.get("path") or ""),
            media_type=str(data.get("mediaType") or "text/plain"),
            created_at=float(data.get("createdAt") or _now()),
        )


@dataclass
class KitGenerationJob:
    """一次 AI Kit 编译任务。

    编译结果先作为预览持久化，不会自动保存成 Kit，也不会执行。任务与前端组件
    生命周期解耦，因此切换 Session、收起面板或 WebSocket 短暂重连都不会丢失。
    """

    id: str
    session_id: str
    status: str = "queued"
    request: dict = field(default_factory=dict)
    result: Optional[dict] = None
    message: str = "已提交，等待后台编译"
    error: str = ""
    phase: str = "queued"
    backend_id: str = ""
    backend_label: str = ""
    model: str = ""
    output_preview: str = ""
    thinking_preview: str = ""
    output_chars: int = 0
    thinking_chars: int = 0
    activities: list[dict] = field(default_factory=list)
    last_activity_at: Optional[float] = None
    created_at: float = field(default_factory=_now)
    started_at: Optional[float] = None
    ended_at: Optional[float] = None
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sessionId": self.session_id,
            "status": self.status,
            "request": self.request,
            "result": self.result,
            "message": self.message,
            "error": self.error,
            "phase": self.phase,
            "backendId": self.backend_id,
            "backendLabel": self.backend_label,
            "model": self.model,
            "outputPreview": self.output_preview,
            "thinkingPreview": self.thinking_preview,
            "outputChars": self.output_chars,
            "thinkingChars": self.thinking_chars,
            "activities": self.activities[-100:],
            "lastActivityAt": self.last_activity_at,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "KitGenerationJob":
        status = str(data.get("status") or "error")
        if status not in KIT_GENERATION_STATUSES:
            status = "error"
        request = data.get("request") if isinstance(data.get("request"), dict) else {}
        result = data.get("result") if isinstance(data.get("result"), dict) else None
        return cls(
            id=str(data.get("id") or _id()),
            session_id=str(data.get("sessionId") or ""),
            status=status,
            request=_json_copy(request),
            result=_json_copy(result) if result is not None else None,
            message=_safe_text(data.get("message"), 4_000),
            error=_safe_text(data.get("error"), 20_000),
            phase=_safe_text(data.get("phase") or status, 80),
            backend_id=_safe_text(data.get("backendId"), 500),
            backend_label=_safe_text(data.get("backendLabel"), 500),
            model=_safe_text(data.get("model"), 500),
            output_preview=_safe_text(data.get("outputPreview"), 100_000),
            thinking_preview=_safe_text(data.get("thinkingPreview"), 20_000),
            output_chars=max(0, int(data.get("outputChars") or 0)),
            thinking_chars=max(0, int(data.get("thinkingChars") or 0)),
            activities=[
                _json_copy(item) for item in (data.get("activities") or [])[-100:]
                if isinstance(item, dict)
            ],
            last_activity_at=data.get("lastActivityAt"),
            created_at=float(data.get("createdAt") or _now()),
            started_at=data.get("startedAt"),
            ended_at=data.get("endedAt"),
            updated_at=float(data.get("updatedAt") or data.get("createdAt") or _now()),
        )


@dataclass
class WorkspaceKitState:
    session_id: str
    kits: list[WorkspaceKit] = field(default_factory=list)
    runs: list[KitRun] = field(default_factory=list)
    artifacts: list[KitArtifact] = field(default_factory=list)
    generation_jobs: list[KitGenerationJob] = field(default_factory=list)
    # 旧重复定义作为归档保留：只合并展示归属，绝不重写运行/版本/审批的历史标识。
    chain_aliases: dict[str, str] = field(default_factory=dict)
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        latest: dict[str, dict] = {}
        for artifact in self.artifacts:
            current = latest.get(artifact.key)
            if current is None or float(current.get("createdAt") or 0) < artifact.created_at:
                latest[artifact.key] = artifact.to_dict()
        return {
            "sessionId": self.session_id,
            "kits": [item.to_dict() for item in self.kits],
            "runs": [item.to_dict() for item in self.runs],
            "artifacts": [item.to_dict() for item in self.artifacts],
            "generationJobs": [item.to_dict() for item in self.generation_jobs],
            "chainAliases": dict(self.chain_aliases),
            "dataMarket": list(latest.values()),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "WorkspaceKitState":
        return cls(
            session_id=str(data.get("sessionId") or ""),
            kits=[WorkspaceKit.from_dict(x) for x in _dict_list(data.get("kits"))],
            runs=[KitRun.from_dict(x) for x in _dict_list(data.get("runs"))],
            artifacts=[KitArtifact.from_dict(x) for x in _dict_list(data.get("artifacts"))],
            generation_jobs=[
                KitGenerationJob.from_dict(x)
                for x in _dict_list(data.get("generationJobs"))
            ],
            chain_aliases={str(key): str(value) for key, value in (data.get("chainAliases") or {}).items()},
            created_at=float(data.get("createdAt") or _now()),
            updated_at=float(data.get("updatedAt") or _now()),
        )

    def latest_artifact(self, key: str) -> Optional[KitArtifact]:
        matches = [item for item in self.artifacts if item.key == key]
        return max(matches, key=lambda item: item.created_at) if matches else None

    def canonical_chain_id(self, kit_id: str) -> str:
        seen: set[str] = set()
        while kit_id in self.chain_aliases and kit_id not in seen:
            seen.add(kit_id)
            kit_id = self.chain_aliases[kit_id]
        return kit_id

    def visible_kits(self) -> list[WorkspaceKit]:
        return [kit for kit in self.kits if kit.id not in self.chain_aliases]

    def last_chain_run_id(self, kit: WorkspaceKit) -> str:
        runs = [run for run in self.runs if self.canonical_chain_id(run.kit_id) == kit.id]
        active = [run for run in runs if run.status not in FINAL_RUN_STATUSES]
        return (active or runs)[-1].id if runs else kit.last_run_id

    def reconcile_chat_chains(self, protected_ids: set[str] | None = None) -> bool:
        """把未改造、已空闲的旧聊天重复链归档到最早定义，保留全部原始对象。"""
        protected = set(protected_ids or ())
        for run in self.runs:
            if run.status not in FINAL_RUN_STATUSES:
                protected.add(run.kit_id)
                protected.update(step.source_kit_id for step in run.steps)
        groups: dict[str, list[WorkspaceKit]] = {}
        for kit in self.visible_kits():
            key = kit.chat_chain_key()
            if key:
                groups.setdefault(key, []).append(kit)
        changed = False
        for group in groups.values():
            if len(group) < 2 or any(
                kit.id in protected or len(kit.versions) > 1 or kit.optimization_messages
                for kit in group
            ) or len({kit.enabled for kit in group}) != 1:
                continue
            canonical = min(group, key=lambda kit: (kit.created_at, kit.id))
            for kit in group:
                if kit.id != canonical.id:
                    self.chain_aliases[kit.id] = canonical.id
                    changed = True
        return changed

    def compact(self) -> None:
        """限制 sidecar 增长；保留最近运行及每个数据键的近期版本。"""
        self.runs = self.runs[-100:]
        self.generation_jobs = self.generation_jobs[-10:]
        for kit in self.kits:
            kit.optimization_messages = kit.optimization_messages[-200:]
        kept: list[KitArtifact] = []
        counts: dict[str, int] = {}
        for item in reversed(self.artifacts):
            count = counts.get(item.key, 0)
            if count < 20:
                kept.append(item)
                counts[item.key] = count + 1
        self.artifacts = list(reversed(kept))[-300:]


class WorkspaceKitStore:
    def __init__(self) -> None:
        self._dir = paths.sub("workspace-kits")
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, session_id: str) -> Path:
        safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id)
        return self._dir / f"{safe_id}.json"

    def load(self, session_id: str) -> Optional[WorkspaceKitState]:
        path = self._path(session_id)
        if not path.exists():
            return None
        try:
            state = WorkspaceKitState.from_dict(json.loads(path.read_text(encoding="utf-8")))
            state.session_id = session_id
            return state
        except Exception as exc:
            print(f"[WorkspaceKitStore] failed to load {session_id}: {exc}")
            return None

    def create(self, session_id: str) -> WorkspaceKitState:
        state = WorkspaceKitState(session_id=session_id)
        self.save(state)
        return state

    def list_session_ids(self) -> list[str]:
        result: list[str] = []
        for path in self._dir.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                session_id = str(data.get("sessionId") or "").strip()
                if session_id:
                    result.append(session_id)
            except Exception:
                continue
        return result

    def save(self, state: WorkspaceKitState) -> None:
        state.updated_at = _now()
        state.compact()
        payload = json.dumps(state.to_dict(), ensure_ascii=False, indent=2)
        target = self._path(state.session_id)
        tmp = target.with_suffix(".json.tmp")
        with self._lock:
            tmp.write_text(payload, encoding="utf-8")
            tmp.replace(target)

    def delete(self, session_id: str) -> None:
        try:
            self._path(session_id).unlink(missing_ok=True)
        except Exception:
            pass


def render_kit_command(kit: WorkspaceKit, inputs: dict) -> tuple[str, dict[str, str]]:
    """把 ``{{input}}`` 替换为对应 shell 的环境变量引用，并返回安全环境变量。"""
    command = kit.command
    env: dict[str, str] = {}
    for item in kit.inputs:
        key = str(item.get("key") or "").strip()
        if not key:
            continue
        env_key = kit_input_env_key(key)
        value = inputs.get(key, item.get("default", ""))
        if isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False)
        env[env_key] = str(value if value is not None else "")
        if kit.shell == "cmd":
            reference = f"%{env_key}%"
        elif kit.shell == "bash":
            reference = f'"${env_key}"'
        else:
            reference = f"$env:{env_key}"
        command = command.replace("{{" + key + "}}", reference)
    return command, env


def resolve_kit_inputs(
    kit: WorkspaceKit, supplied: dict, state: WorkspaceKitState,
) -> tuple[dict, list[str]]:
    resolved = dict(supplied or {})
    errors: list[str] = []
    for item in kit.inputs:
        key = str(item.get("key") or "").strip()
        if not key:
            continue
        if key not in resolved or resolved[key] in (None, ""):
            source_key = str(item.get("sourceKey") or "").strip()
            artifact = state.latest_artifact(source_key) if source_key else None
            if artifact is not None:
                resolved[key] = artifact.value if artifact.value is not None else artifact.path
            elif "default" in item:
                resolved[key] = item.get("default")
        if bool(item.get("required")) and resolved.get(key) in (None, ""):
            errors.append(f"缺少必填输入：{item.get('label') or key}")
    for dependency in kit.dependencies:
        if state.latest_artifact(dependency) is None:
            errors.append(f"缺少数据依赖：{dependency}")
    return resolved, errors


def evaluate_assertions(
    assertions: list[dict],
    *,
    exit_code: Optional[int],
    stdout: str,
    stderr: str,
    working_dir: Path,
) -> list[KitAssertionResult]:
    specs = assertions or [{"type": "exit_code", "expected": 0, "label": "进程正常退出"}]
    results: list[KitAssertionResult] = []
    for spec in specs:
        kind = str(spec.get("type") or "exit_code")
        label = str(spec.get("label") or kind)
        expected = spec.get("expected")
        actual: Any = None
        passed = False
        message = ""
        try:
            if kind == "exit_code":
                expected = int(0 if expected is None else expected)
                actual = exit_code
                passed = exit_code == expected
            elif kind == "stdout_contains":
                expected = str(expected or "")
                actual = expected in stdout
                passed = bool(actual)
            elif kind == "stderr_contains":
                expected = str(expected or "")
                actual = expected in stderr
                passed = bool(actual)
            elif kind in {"stdout_regex", "stderr_regex"}:
                expected = str(expected or "")
                source = stdout if kind == "stdout_regex" else stderr
                passed = re.search(expected, source, flags=re.MULTILINE) is not None
                actual = "matched" if passed else "not matched"
            elif kind == "json_valid":
                json.loads(stdout)
                passed = True
                actual = "valid JSON"
            elif kind == "file_exists":
                expected = str(expected or spec.get("path") or "")
                root = working_dir.resolve()
                candidate = (root / expected).resolve()
                if candidate != root and root not in candidate.parents:
                    message = "文件判言路径超出 Kit 工作目录"
                else:
                    actual = candidate.exists()
                    passed = bool(actual)
            else:
                message = f"不支持的判言类型：{kind}"
        except Exception as exc:
            message = str(exc)
        results.append(KitAssertionResult(
            type=kind,
            label=label,
            passed=passed,
            expected=expected,
            actual=actual,
            message=message,
        ))
    return results


def build_artifacts(
    kit: WorkspaceKit,
    run: KitRun,
    *,
    working_dir: Path,
) -> list[KitArtifact]:
    artifacts: list[KitArtifact] = []
    for spec in kit.outputs:
        key = str(spec.get("key") or "").strip()
        if not key:
            continue
        source = str(spec.get("source") or "stdout")
        kind = str(spec.get("type") or ("file" if source == "file" else "text"))
        value: Any = None
        path = ""
        media_type = str(spec.get("mediaType") or "text/plain")
        if source == "stderr":
            value = run.stderr
        elif source == "json":
            try:
                value = json.loads(run.stdout)
                kind = "json"
                media_type = "application/json"
            except Exception:
                continue
        elif source == "file":
            relative = str(spec.get("path") or "")
            root = working_dir.resolve()
            candidate = (root / relative).resolve()
            if candidate != root and root not in candidate.parents:
                continue
            if not candidate.exists():
                continue
            path = str(candidate)
            value = path
            kind = "file"
        else:
            value = run.stdout
        artifacts.append(KitArtifact(
            id=_id(),
            session_id=run.session_id,
            kit_id=kit.id,
            run_id=run.id,
            key=key,
            label=str(spec.get("label") or key),
            type=kind,
            value=value,
            path=path,
            media_type=media_type,
        ))
    return artifacts
