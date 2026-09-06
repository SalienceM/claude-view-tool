"""
LoopStore: 可视化 Loop 集成的状态持久化（"stage 文件"）。

每个 loop session 在 ~/.agent-with-u/loops/<session_id>.json 留存一个 stage 文件。
全局阶段（stage）单向推进：

    loopidea  →  loopexecute  →  loopout

- loopidea：前台非阻塞地投递多条想法（idea），后端用并发池（默认 3）逐条让
  模型展开。封口（seal）后形成全局目标 goal，单向切到 loopexecute。
- loopexecute：按次（seq）执行 loop，每次 loop 分三个子阶段：
    prepare  —— 编排本次 loop 的分步（顺次 / 并发）、本次目标
    execute  —— 按编排执行，落地执行结果（未必成功）
    analysis —— 评估执行结果与全局目标的差距，给出分数与趋势分析
- loopout：全局产出阶段（可交付 / 可输出）。

评分心智模型（0–100）：
  >= 70 → 可交付（deliverable），进入优化阶段
  >= 85 → 可输出（outputtable），分析后续 loop 的优化空间与趋势
风险系数（risk_coefficient，0–1）：综合"最大 loop 约束"与"完不成的风险因子"，
用于避免为无法完成的任务做无谓 loop。
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from . import paths


# ── 阶段常量 ──────────────────────────────────────────────────────
STAGE_IDEA = "loopidea"
STAGE_EXECUTE = "loopexecute"
STAGE_OUT = "loopout"

SUB_PREPARE = "prepare"
SUB_EXECUTE = "execute"
SUB_ANALYSIS = "analysis"
SUB_DONE = "done"

DELIVERABLE_SCORE = 70.0   # 可交付门槛
OUTPUTTABLE_SCORE = 85.0   # 可输出门槛


def _now() -> float:
    return time.time()


@dataclass
class LoopStep:
    """本次 loop 编排中的一个分步。"""
    index: int
    mode: str = "sequential"   # "sequential" | "concurrent"
    desc: str = ""
    access: str = "write"       # read | write；只有明确只读的步骤允许共享目录并发
    status: str = "pending"    # pending | running | done | error
    output: str = ""           # 该步执行产出（持久化，用于复盘）
    started_at: float = 0.0    # 开始执行时间戳（0 = 未开始），用于流程视图耗时
    ended_at: float = 0.0      # 结束时间戳（0 = 未结束）
    attempts: int = 0          # 实际尝试次数；无活动超时后可自动重试当前步
    recovery_notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"index": self.index, "mode": self.mode, "desc": self.desc, "access": self.access,
                "status": self.status, "output": self.output,
                "startedAt": self.started_at, "endedAt": self.ended_at,
                "attempts": self.attempts, "recoveryNotes": list(self.recovery_notes)}

    @classmethod
    def from_dict(cls, d: dict) -> "LoopStep":
        return cls(
            index=int(d.get("index", 0)),
            mode=d.get("mode", "sequential"),
            desc=d.get("desc", ""),
            access=("read" if d.get("access") == "read" else "write"),
            status=d.get("status", "pending"),
            output=d.get("output", ""),
            started_at=float(d.get("startedAt", 0) or 0),
            ended_at=float(d.get("endedAt", 0) or 0),
            attempts=max(0, int(d.get("attempts", 0) or 0)),
            recovery_notes=[str(v) for v in (d.get("recoveryNotes") or []) if str(v).strip()],
        )


@dataclass
class LoopAnalysis:
    """execute analysis 结果。"""
    score: float = 0.0                  # 0..100
    notes: str = ""                     # 分析正文
    trend: str = ""                     # 历史趋势评估
    optimization_potential: float = 0.0  # 0..1，下一次 loop 估计还能提升多少
    challenges: str = ""                # 环境/系统/网络等可触达性挑战
    verified: str = ""                  # 已经用实际产物/检查核实成立的能力与证据
    gaps: str = ""                      # 对照全局目标仍未满足或发生回归的缺口
    next_focus: str = ""                # 下一次只应优先处理的最小高价值焦点
    deliverable: bool = False           # score >= 70
    outputtable: bool = False           # score >= 85

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "notes": self.notes,
            "trend": self.trend,
            "optimizationPotential": self.optimization_potential,
            "challenges": self.challenges,
            "verified": self.verified,
            "gaps": self.gaps,
            "nextFocus": self.next_focus,
            "deliverable": self.deliverable,
            "outputtable": self.outputtable,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "LoopAnalysis":
        return cls(
            score=float(d.get("score", 0.0)),
            notes=d.get("notes", ""),
            trend=d.get("trend", ""),
            optimization_potential=float(d.get("optimizationPotential", 0.0)),
            challenges=d.get("challenges", ""),
            verified=d.get("verified", ""),
            gaps=d.get("gaps", ""),
            next_focus=d.get("nextFocus", d.get("next_focus", "")),
            deliverable=bool(d.get("deliverable", False)),
            outputtable=bool(d.get("outputtable", False)),
        )


@dataclass
class LoopRecord:
    """一次 loopexecute 增量演进的完整记录。"""
    seq: int
    # agent = automated prepare/execute/analysis pass; manual = a temporary
    # human-controlled normal-chat pass over the same loop session.
    kind: str = "agent"
    sub_stage: str = SUB_PREPARE        # prepare | execute | analysis | done
    round: int = 1                      # 属于第几轮（loopout 后可开启新一轮）
    goal: str = ""                      # 本次 loop 的增量焦点（不是替代全局目标）
    iteration_mode: str = "baseline"    # baseline | evolution
    evolution_basis: str = ""           # 本次冻结的上轮诊断 + 起跑时 addon 范围
    orchestration: list[LoopStep] = field(default_factory=list)
    completed: bool = False             # 是否按步骤执行完成（含 analysis 完成）
    result: str = ""                    # 本次 loop 执行完成的结果信息
    analysis: Optional[LoopAnalysis] = None
    error: str = ""
    # 各子阶段的开始时间戳（{prepare/execute/analysis/done: ts}），用于流程视图耗时
    sub_started: dict = field(default_factory=dict)
    # ★ 本次 loop 各阶段实际使用的 backend id（{prepare, execute, analysis}）。
    #   prepare / execute / analysis 均可独立选 backend；缺省时跟随会话 backend。
    #   用于在结果展示中追溯"谁规划、谁执行、谁评审"。
    backends: dict = field(default_factory=dict)
    # ★ 各阶段实际使用的运行参数（{prepare/execute/analysis: {model, reasoningEffort}}）。
    #   与 backend id 分开记录，避免同一个 Codex backend 下的 Sol/Terra/档位混在一起。
    runtimes: dict = field(default_factory=dict)
    # ★ 版本隔离：本次 loop 开跑前的 agent 上下文快照（agent_session_id）。
    #   None=未快照（老记录）；""=当时无上下文；"X"=具体 id。丢弃本次 loop 时据此回滚，
    #   避免被丢弃 loop 的对话污染后续 loop 的上下文。
    agent_checkpoint: Optional[str] = None
    # ★ 文件级版本隔离：本次 loop 开跑前对 git 工作目录的非破坏性快照 commit sha。
    #   None=非 git 仓库/未快照。丢弃时经用户确认可据此把工作树恢复到开跑前。
    git_checkpoint: Optional[str] = None
    # ★ 非 git 目录的文件级备份路径（dir_snapshot 创建的临时目录）。
    #   None=未备份。丢弃时据此恢复文件。
    dir_checkpoint: Optional[str] = None
    # 本轮分析完成后的 Git 产物快照，用于 loopout 恢复真正的最佳版本。
    artifact_checkpoint: Optional[str] = None
    # Manual takeover keeps a self-contained transcript snapshot so the pass is
    # inspectable from LoopPanel even though the same messages also live in the
    # normal session transcript. Tool calls/thinking blocks are retained here.
    manual_messages: list[dict] = field(default_factory=list)
    manual_start_index: int = 0
    manual_context: str = ""
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def mark_sub(self, sub: str) -> None:
        """记录某子阶段的开始时间（已记则不覆盖）。"""
        if sub and sub not in self.sub_started:
            self.sub_started[sub] = _now()

    def to_dict(self) -> dict:
        return {
            "seq": self.seq,
            "kind": self.kind,
            "subStage": self.sub_stage,
            "round": self.round,
            "goal": self.goal,
            "iterationMode": self.iteration_mode,
            "evolutionBasis": self.evolution_basis,
            "orchestration": [s.to_dict() for s in self.orchestration],
            "completed": self.completed,
            "result": self.result,
            "analysis": self.analysis.to_dict() if self.analysis else None,
            "error": self.error,
            "subStarted": self.sub_started,
            "backends": dict(self.backends or {}),
            "runtimes": {k: dict(v) for k, v in (self.runtimes or {}).items()
                         if isinstance(v, dict)},
            "agentCheckpoint": self.agent_checkpoint,
            "gitCheckpoint": self.git_checkpoint,
            "dirCheckpoint": self.dir_checkpoint,
            "artifactCheckpoint": self.artifact_checkpoint,
            "manualMessages": list(self.manual_messages or []),
            "manualStartIndex": self.manual_start_index,
            "manualContext": self.manual_context,
            "hasGitCheckpoint": bool(self.git_checkpoint),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "LoopRecord":
        return cls(
            seq=int(d.get("seq", 0)),
            kind=("manual" if d.get("kind") == "manual" else "agent"),
            sub_stage=d.get("subStage", SUB_PREPARE),
            round=int(d.get("round", 1)),
            goal=d.get("goal", ""),
            iteration_mode=("evolution" if d.get("iterationMode") == "evolution" else "baseline"),
            evolution_basis=d.get("evolutionBasis", ""),
            orchestration=[LoopStep.from_dict(s) for s in d.get("orchestration", [])],
            completed=bool(d.get("completed", False)),
            result=d.get("result", ""),
            analysis=LoopAnalysis.from_dict(d["analysis"]) if d.get("analysis") else None,
            error=d.get("error", ""),
            sub_started=dict(d.get("subStarted") or {}),
            backends=dict(d.get("backends") or {}),
            runtimes={k: dict(v) for k, v in (d.get("runtimes") or {}).items()
                      if isinstance(v, dict)},
            agent_checkpoint=d.get("agentCheckpoint", None),
            git_checkpoint=d.get("gitCheckpoint", None),
            dir_checkpoint=d.get("dirCheckpoint", None),
            artifact_checkpoint=d.get("artifactCheckpoint", None),
            manual_messages=list(d.get("manualMessages") or []),
            manual_start_index=int(d.get("manualStartIndex", 0) or 0),
            manual_context=d.get("manualContext", ""),
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


@dataclass
class IdeaEntry:
    """loopidea 阶段的一条想法（并发池中的一个任务）。"""
    id: str
    prompt: str
    status: str = "pending"   # pending | running | done | error
    result: str = ""
    error: str = ""
    images: list = field(default_factory=list)  # 附带图片附件（base64 dict），喂给该想法的展开
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "prompt": self.prompt,
            "status": self.status,
            "result": self.result,
            "error": self.error,
            "images": self.images,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "IdeaEntry":
        return cls(
            id=d.get("id", ""),
            prompt=d.get("prompt", ""),
            status=d.get("status", "pending"),
            result=d.get("result", ""),
            error=d.get("error", ""),
            images=list(d.get("images") or []),
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


@dataclass
class AsideTurn:
    """一条 "by the way" 旁路问答（独立 agent session，不污染 loop 主线）。"""
    id: str
    question: str
    answer: str = ""
    status: str = "answering"   # answering | done | error
    stage: str = ""             # 提问时的 loop 阶段快照
    seq: int = 0                # 提问时正在跑的 loop（0 表示无）
    image_count: int = 0        # 提问时附带的图片数（base64 不落盘，仅记数量）
    context_key: str = "session"
    context_kind: str = "session"
    context_label: str = ""
    context_detail: str = ""
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "question": self.question,
            "answer": self.answer,
            "status": self.status,
            "stage": self.stage,
            "seq": self.seq,
            "imageCount": self.image_count,
            "contextKey": self.context_key,
            "contextKind": self.context_kind,
            "contextLabel": self.context_label,
            "contextDetail": self.context_detail,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "AsideTurn":
        return cls(
            id=d.get("id", ""),
            question=d.get("question", ""),
            answer=d.get("answer", ""),
            status=d.get("status", "done"),
            stage=d.get("stage", ""),
            seq=int(d.get("seq", 0)),
            image_count=int(d.get("imageCount", 0)),
            context_key=str(d.get("contextKey") or "session"),
            context_kind=str(d.get("contextKind") or "session"),
            context_label=str(d.get("contextLabel") or ""),
            context_detail=str(d.get("contextDetail") or ""),
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


@dataclass
class Addon:
    """随手补充的要求（addon）。Prepare 起跑时冻结并消费当时 pending 的项；
    起跑后新增的项不扩大正在执行的范围，由 analysis 登记并留给下一次增量演进。"""
    id: str
    text: str
    status: str = "pending"     # pending（待纳入）| applied（已纳入某次 loop）
    applied_seq: int = 0        # 被哪一次 loop 的 prepare 纳入
    images: list = field(default_factory=list)  # 附带的图片附件（base64 dict），随补充一起带给下一次 prepare
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id, "text": self.text, "status": self.status,
            "appliedSeq": self.applied_seq, "images": self.images,
            "createdAt": self.created_at, "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Addon":
        return cls(
            id=d.get("id", ""),
            text=d.get("text", ""),
            status=d.get("status", "pending"),
            applied_seq=int(d.get("appliedSeq", 0)),
            images=list(d.get("images") or []),
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


LEGACY_DEFAULT_STRATEGY = (
    "每一次 loop 都是对【全局目标】的一次完整、尽力的尝试（不是把任务拆到多个 loop 分步完成）。\n"
    "- prepare：规划这一遍的策略与分步编排（可并发 concurrent / 顺次 sequential）。\n"
    "- execute：实际执行编排（读写文件、运行命令），如实记录产出与成败。\n"
    "- analysis：对照全局目标打分（0–100），评估趋势、优化空间与硬约束。\n"
    "\n"
    "评分心智（防自欺，必须遵守）：\n"
    "1. 以**可验证的实际产物**为准——文件是否真存在、代码是否真能跑、命令/测试输出是否真通过；"
    "**不要轻信**执行阶段的自述总结，能验证就动手验证。\n"
    "2. **默认未完成**：除非有明确证据满足验收标准，否则不给高分；模糊、未验证、想当然一律压低。\n"
    "3. 警惕「美好陷阱」：流程跑顺 ≠ 目标达成；高分（≥可输出门槛）必须对应验收标准**逐条**被证据支撑。\n"
    "4. 趋势判断要看**实质改进**（新增能力/缺陷修复/通过的检查），而非措辞更乐观或换了说法。\n"
    "5. 宁可保守扣分、点明差距与下一步，也不要为了收口而粉饰；真完不成就如实在 challenges 标注。"
)


# 旧前端创建 Session 时会把这个无 Markdown 版本回写到 stage 文件；它与后端旧默认
# 语义相同但文本不完全一致，因此也必须显式迁移。
LEGACY_FRONTEND_DEFAULT_STRATEGY = (
    "每一次 loop 都是对【全局目标】的一次完整、尽力的尝试（不是把任务拆到多个 loop 分步完成）。\n"
    "- prepare：规划这一遍的策略与分步编排（可并发 concurrent / 顺次 sequential）。\n"
    "- execute：实际执行编排（读写文件、运行命令），如实记录产出与成败。\n"
    "- analysis：对照全局目标打分（0–100），评估趋势、优化空间与硬约束。\n"
    "\n"
    "评分心智（防自欺，必须遵守）：\n"
    "1. 以可验证的实际产物为准——文件是否真存在、代码是否真能跑、命令/测试输出是否真通过；"
    "不要轻信执行阶段的自述总结，能验证就动手验证。\n"
    "2. 默认未完成：除非有明确证据满足验收标准，否则不给高分；模糊、未验证、想当然一律压低。\n"
    "3. 警惕「美好陷阱」：流程跑顺 ≠ 目标达成；高分（≥可输出门槛）必须对应验收标准逐条被证据支撑。\n"
    "4. 趋势判断要看实质改进（新增能力/缺陷修复/通过的检查），而非措辞更乐观。\n"
    "5. 宁可保守扣分、点明差距与下一步，也不要为了收口而粉饰；真完不成就如实在 challenges 标注。"
)


DEFAULT_STRATEGY = (
    "LOOP 是围绕【全局目标】和当前真实产物的连续增量演进：既不在每次 loop 重做完整目标，"
    "也不预先把任务机械切成固定阶段。\n"
    "- prepare：回顾全局目标、原始诉求、上轮诊断和本次 addon；先核实现状，保留已验证成果，"
    "只选择当前最高价值的剩余缺口或回归，编排 1–4 个必要步骤。\n"
    "- execute：针对本次增量焦点实际执行；动手前确认现状，已经满足的工作直接跳过，"
    "不要重复生成、重写或做无收益的全量检查。\n"
    "- analysis：独立核实当前工作区的累计状态，并始终对照全局目标评分；明确记录已核实证据、"
    "剩余缺口和下一次唯一优先焦点。\n"
    "\n"
    "评分心智（防自欺，必须遵守）：\n"
    "1. 以**可验证的实际产物**为准——文件是否真存在、代码是否真能跑、命令/测试输出是否真通过；"
    "**不要轻信**执行阶段的自述总结，能验证就动手验证。\n"
    "2. score 衡量的是**当前累计产物对全局目标的完成度**，不是本次做了多少；本次贡献与整体完成度要分开。\n"
    "3. **默认未完成**：除非有明确证据满足验收标准，否则不给高分；模糊、未验证、想当然一律压低。\n"
    "4. 警惕「美好陷阱」：流程跑顺 ≠ 目标达成；高分（≥可输出门槛）必须对应验收标准**逐条**被证据支撑。\n"
    "5. 趋势判断看已核实的净新增价值；禁止把重复执行、重复测试或更乐观的措辞算作进展。\n"
    "6. 宁可保守扣分、点明差距与下一步，也不要为了收口而粉饰；真完不成就如实在 challenges 标注。"
)


@dataclass
class LoopPolicy:
    """Loop 的策略与心智（可在建会话时编辑、运行时实时查看/调整）。"""
    deliverable_score: float = DELIVERABLE_SCORE   # 可交付门槛
    outputtable_score: float = OUTPUTTABLE_SCORE   # 可输出门槛
    max_loops: int = 8                             # 用户指定的最大 loop 数（不设产品硬上限）
    risk_threshold: float = 0.85                   # 风险止损阈值（≥ 即收口）
    step_stall_seconds: int = 300                  # execute 单步多久无任何模型/工具事件即判定疑似卡住
    step_max_attempts: int = 2                     # 卡住或空响应时，当前步最多自动尝试次数
    independent_eval: bool = True                  # analysis 用独立上下文 + 对抗式评审（防自欺）
    intent_guard: bool = True                       # 早期检查人意图 vs 模型计划方向的偏差（非阻塞提示）
    # 各角色的专用 backend：{prepare/execute/idea/goal/analysis/aside: backend_id}，
    # 缺省=跟随会话。自动 LOOP 的 prepare / execute / analysis 都在独立上下文中运行，
    # 因而可安全切换异构 backend；人工接管仍使用 Session 自身 backend。
    backends: dict = field(default_factory=dict)
    # 各角色的运行参数覆盖：{prepare/execute/idea/goal/analysis/aside: {model, reasoningEffort}}。
    # execute 缺省跟随 Session；与 execute 使用同一 backend 的其他角色会先继承 execute
    # 模型配置，否则跟随各自 backend 默认。因此旧策略保持原来的同 backend / 同模型行为。
    # 参数仅在目标 backend 支持时生效（Codex 支持模型+档位，Qwen CLI 支持模型）。
    runtimes: dict = field(default_factory=dict)
    strategy: str = DEFAULT_STRATEGY               # 注入到 prepare/analysis 的策略心智文本

    # 可路由的分析/转换位置
    BACKEND_POSITIONS = ("prepare", "execute", "idea", "goal", "analysis", "aside")
    RUNTIME_POSITIONS = ("prepare", "execute", "idea", "goal", "analysis", "aside")
    REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh", "max"}

    def backend_for(self, pos: str) -> str:
        b = (self.backends or {}).get(pos)
        return b if isinstance(b, str) and b.strip() else ""

    @classmethod
    def _clean_runtime(cls, raw: object) -> dict:
        if not isinstance(raw, dict):
            return {}
        out: dict = {}
        model = raw.get("model")
        if isinstance(model, str) and model.strip():
            out["model"] = model.strip()
        effort = raw.get("reasoningEffort", raw.get("reasoning_effort"))
        if isinstance(effort, str) and effort.strip().lower() in cls.REASONING_EFFORTS:
            out["reasoningEffort"] = effort.strip().lower()
        return out

    def runtime_for(self, pos: str, inherit_execute: bool = True) -> dict:
        """Return the role runtime, optionally inheriting the execute profile."""
        out: dict = {}
        if inherit_execute and pos != "execute":
            out.update(self._clean_runtime((self.runtimes or {}).get("execute")))
        out.update(self._clean_runtime((self.runtimes or {}).get(pos)))
        return out

    def to_dict(self) -> dict:
        return {
            "deliverableScore": self.deliverable_score,
            "outputtableScore": self.outputtable_score,
            "maxLoops": self.max_loops,
            "riskThreshold": self.risk_threshold,
            "stepStallSeconds": self.step_stall_seconds,
            "stepMaxAttempts": self.step_max_attempts,
            "independentEval": self.independent_eval,
            "intentGuard": self.intent_guard,
            "backends": dict(self.backends or {}),
            "runtimes": {k: self._clean_runtime(v) for k, v in (self.runtimes or {}).items()
                         if k in self.RUNTIME_POSITIONS and self._clean_runtime(v)},
            "strategy": self.strategy,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "LoopPolicy":
        d = d or {}
        def _f(key, default):
            try:
                return float(d.get(key, default))
            except (TypeError, ValueError):
                return default
        dv = max(0.0, min(100.0, _f("deliverableScore", DELIVERABLE_SCORE)))
        ov = max(dv, min(100.0, _f("outputtableScore", OUTPUTTABLE_SCORE)))  # 不低于可交付
        try:
            ml = int(d.get("maxLoops", 8))
        except (TypeError, ValueError):
            ml = 8
        # 最大 Loop 数由用户自己决定。这里只保证它是正整数，不再施加
        # 产品级硬上限；否则前端填写 500 会在持久化时静默变成 50。
        ml = max(1, ml)
        rt = max(0.1, min(1.0, _f("riskThreshold", 0.85)))
        try:
            stall = int(d.get("stepStallSeconds", 300))
        except (TypeError, ValueError):
            stall = 300
        stall = max(30, min(3600, stall))
        try:
            attempts = int(d.get("stepMaxAttempts", 2))
        except (TypeError, ValueError):
            attempts = 2
        attempts = max(1, min(3, attempts))
        strat = d.get("strategy")
        # 旧版本把“每次完整重做”固化进了持久化策略。只替换这段已知系统默认前缀，
        # 后面由用户或内置预设追加的个性化要求原样保留。
        if isinstance(strat, str):
            normalized = strat.strip()
            for legacy_default in (LEGACY_DEFAULT_STRATEGY, LEGACY_FRONTEND_DEFAULT_STRATEGY):
                if normalized.startswith(legacy_default):
                    strat = DEFAULT_STRATEGY + normalized[len(legacy_default):]
                    break
        ie = d.get("independentEval", True)
        ig = d.get("intentGuard", True)
        # 各位置 backend 映射 + 迁移旧的单一 evalBackendId（曾用于 analysis/goal）
        raw_b = d.get("backends")
        backends: dict = {}
        if isinstance(raw_b, dict):
            for k in cls.BACKEND_POSITIONS:
                v = raw_b.get(k)
                if isinstance(v, str) and v.strip():
                    backends[k] = v
        old_eb = d.get("evalBackendId")
        if isinstance(old_eb, str) and old_eb.strip():
            backends.setdefault("analysis", old_eb)
            backends.setdefault("goal", old_eb)
        raw_r = d.get("runtimes")
        runtimes: dict = {}
        if isinstance(raw_r, dict):
            for k in cls.RUNTIME_POSITIONS:
                cleaned = cls._clean_runtime(raw_r.get(k))
                if cleaned:
                    runtimes[k] = cleaned
        return cls(
            deliverable_score=dv, outputtable_score=ov, max_loops=ml, risk_threshold=rt,
            step_stall_seconds=stall, step_max_attempts=attempts,
            independent_eval=bool(ie) if ie is not None else True,
            intent_guard=bool(ig) if ig is not None else True,
            backends=backends,
            runtimes=runtimes,
            strategy=strat if isinstance(strat, str) and strat.strip() else DEFAULT_STRATEGY,
        )


@dataclass
class GoalRevision:
    """全局目标的一个版本。封口初版 / 按提示微调 / 手动改 都各留一版,体现演变。"""
    goal: str
    hint: str = ""              # 本次微调的额外提示(初版/手动为空)
    source: str = "seal"        # seal(封口汇总) | refine(按提示微调) | manual(手动)
    created_at: float = field(default_factory=_now)

    def to_dict(self) -> dict:
        return {"goal": self.goal, "hint": self.hint,
                "source": self.source, "createdAt": self.created_at}

    @classmethod
    def from_dict(cls, d: dict) -> "GoalRevision":
        return cls(
            goal=d.get("goal", ""),
            hint=d.get("hint", ""),
            source=d.get("source", "seal"),
            created_at=d.get("createdAt", _now()),
        )


@dataclass
class LoopState:
    """单个 loop session 的完整 stage 文件。"""
    session_id: str
    stage: str = STAGE_IDEA             # loopidea | loopexecute | loopout
    goal: str = ""                      # 全局目标（idea 封口后形成）
    goal_history: list[GoalRevision] = field(default_factory=list)  # 目标版本演变
    ideas: list[IdeaEntry] = field(default_factory=list)
    loops: list[LoopRecord] = field(default_factory=list)
    risk_coefficient: float = 0.3       # 0..1 综合风险系数
    policy: LoopPolicy = field(default_factory=LoopPolicy)  # 策略与心智（可编辑）
    round: int = 1                      # 当前轮次（loopout 后可开启新一轮）
    auto: bool = False                  # 自动连跑：一次 loop 完成后自动开始下一次
    status: str = "active"              # active | delivered | output | aborted
    # loop | manual. Session type stays "loop"; this only selects which surface
    # currently owns the stopped session.
    control_mode: str = "loop"
    stop_reason: str = ""               # 触发 loopout / 终止的原因
    asides: list[AsideTurn] = field(default_factory=list)  # by the way 旁路问答
    addons: list[Addon] = field(default_factory=list)      # 执行中补充的要求
    intent_alert: dict = field(default_factory=dict)       # 意图守卫：人意图 vs 模型计划偏差提示
    best_seq: int = 0                                      # 当前轮最佳产物对应的 loop seq
    risk_factors: dict = field(default_factory=dict)       # 可解释风险分量
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)

    # ── 派生指标 ────────────────────────────────────────────────
    def record_goal(self, goal: str, hint: str = "", source: str = "seal") -> None:
        """登记一版全局目标(去重:与当前最新版相同则不追加)。"""
        g = (goal or "").strip()
        if not g:
            return
        if self.goal_history and self.goal_history[-1].goal == g:
            return
        self.goal_history.append(GoalRevision(goal=g, hint=hint, source=source))

    def round_loops(self) -> list["LoopRecord"]:
        """当前轮次的 loop（分数/风险/收口都按当前轮计算）。"""
        return [l for l in self.loops if l.round == self.round]

    def best_score(self) -> float:
        scores = [l.analysis.score for l in self.round_loops() if l.analysis]
        return max(scores) if scores else 0.0

    def latest_score(self) -> float:
        done = [l for l in self.round_loops() if l.analysis]
        return done[-1].analysis.score if done else 0.0

    def effective_max_loops(self) -> int:
        """返回用户指定的本轮次数预算，不再根据风险系数暗中折减。"""
        return max(1, self.policy.max_loops)

    def to_dict(self) -> dict:
        return {
            "sessionId": self.session_id,
            "stage": self.stage,
            "goal": self.goal,
            "goalHistory": [g.to_dict() for g in self.goal_history],
            "ideas": [i.to_dict() for i in self.ideas],
            "loops": [l.to_dict() for l in self.loops],
            "riskCoefficient": self.risk_coefficient,
            "policy": self.policy.to_dict(),
            "maxLoops": self.policy.max_loops,
            "effectiveMaxLoops": self.effective_max_loops(),
            "round": self.round,
            "roundLoopCount": len(self.round_loops()),
            "auto": self.auto,
            "status": self.status,
            "controlMode": self.control_mode,
            "stopReason": self.stop_reason,
            "asides": [a.to_dict() for a in self.asides],
            "addons": [a.to_dict() for a in self.addons],
            "intentAlert": self.intent_alert or {},
            "bestSeq": self.best_seq,
            "riskFactors": dict(self.risk_factors or {}),
            "bestScore": self.best_score(),
            "latestScore": self.latest_score(),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "LoopState":
        # 策略：新字段 policy；老存档没有则用旧的 maxLoops 迁移，其余取默认
        if d.get("policy") is not None:
            policy = LoopPolicy.from_dict(d["policy"])
        else:
            policy = LoopPolicy.from_dict({"maxLoops": d.get("maxLoops", 8)})
        return cls(
            session_id=d.get("sessionId", ""),
            stage=d.get("stage", STAGE_IDEA),
            goal=d.get("goal", ""),
            goal_history=[GoalRevision.from_dict(g) for g in d.get("goalHistory", [])],
            ideas=[IdeaEntry.from_dict(i) for i in d.get("ideas", [])],
            loops=[LoopRecord.from_dict(l) for l in d.get("loops", [])],
            risk_coefficient=float(d.get("riskCoefficient", 0.3)),
            policy=policy,
            round=int(d.get("round", 1)),
            auto=bool(d.get("auto", False)),
            status=d.get("status", "active"),
            control_mode=("manual" if d.get("controlMode") == "manual" else "loop"),
            stop_reason=d.get("stopReason", ""),
            asides=[AsideTurn.from_dict(a) for a in d.get("asides", [])],
            addons=[Addon.from_dict(a) for a in d.get("addons", [])],
            intent_alert=dict(d.get("intentAlert") or {}),
            best_seq=int(d.get("bestSeq", 0) or 0),
            risk_factors=dict(d.get("riskFactors") or {}),
            created_at=d.get("createdAt", _now()),
            updated_at=d.get("updatedAt", _now()),
        )


class LoopStore:
    """Loop stage 文件的读写。线程安全（与 SessionStore 同进程）。"""

    def __init__(self):
        self._dir = paths.sub("loops")
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, sid: str) -> Path:
        return self._dir / f"{sid}.json"

    def _meta_path(self, sid: str) -> Path:
        return self._dir / f"{sid}.meta.json"

    @staticmethod
    def _meta_dict(state: LoopState) -> dict:
        return {
            "sessionId": state.session_id,
            "stage": state.stage,
            "controlMode": state.control_mode,
            "auto": state.auto,
            "status": state.status,
            "round": state.round,
            "updatedAt": state.updated_at,
        }

    def _write_meta_unlocked(self, state: LoopState) -> None:
        path = self._meta_path(state.session_id)
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_text(
                json.dumps(self._meta_dict(state), ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(tmp, path)
        finally:
            try:
                if tmp.exists():
                    tmp.unlink()
            except OSError:
                pass

    def load_meta(self, sid: str) -> Optional[dict]:
        """读取小型路由元数据；旧 stage 仅做一次逐行扫描并自动生成 sidecar。"""
        meta_path = self._meta_path(sid)
        if meta_path.exists():
            try:
                data = json.loads(meta_path.read_text(encoding="utf-8"))
                return data if isinstance(data, dict) else None
            except Exception:
                pass
        stage_path = self._path(sid)
        if not stage_path.exists():
            return None
        stage = STAGE_IDEA
        control_mode = "loop"
        auto = False
        status = "active"
        round_no = 1
        try:
            # controlMode 位于庞大的 loops 之后；逐行扫描避免构建整个 JSON 对象。
            with stage_path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    # LoopStore 固定 indent=2；只读取顶层键，不能把 step/aside 的
                    # status 等同名字段误当作 stage 元数据。
                    if not line.startswith('  "') or line.startswith('    "'):
                        continue
                    stripped = line.strip().rstrip(",")
                    if stripped.startswith('"stage"'):
                        stage = str(json.loads("{" + stripped + "}").get("stage") or stage)
                    elif stripped.startswith('"controlMode"'):
                        value = json.loads("{" + stripped + "}").get("controlMode")
                        control_mode = "manual" if value == "manual" else "loop"
                    elif stripped.startswith('"auto"'):
                        auto = bool(json.loads("{" + stripped + "}").get("auto", False))
                    elif stripped.startswith('"status"'):
                        status = str(json.loads("{" + stripped + "}").get("status") or status)
                    elif stripped.startswith('"round"'):
                        round_no = int(json.loads("{" + stripped + "}").get("round") or 1)
            meta = {
                "sessionId": sid, "stage": stage, "controlMode": control_mode,
                "auto": auto, "status": status, "round": round_no,
                "updatedAt": stage_path.stat().st_mtime,
            }
            # 迁移写入失败不影响本次读取。
            try:
                meta_path.write_text(
                    json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8",
                )
            except Exception:
                pass
            return meta
        except Exception as exc:
            print(f"[LoopStore] failed to load meta {sid}: {exc}")
            return None

    def exists(self, sid: str) -> bool:
        return self._path(sid).exists()

    def load(self, sid: str) -> Optional[LoopState]:
        path = self._path(sid)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return LoopState.from_dict(data)
        except Exception as e:
            print(f"[LoopStore] failed to load {sid}: {e}")
            return None

    def save(self, state: LoopState) -> None:
        state.updated_at = _now()
        with self._lock:
            path = self._path(state.session_id)
            tmp = path.with_suffix(path.suffix + ".tmp")
            payload = json.dumps(state.to_dict(), ensure_ascii=False, indent=2)
            try:
                with tmp.open("w", encoding="utf-8", newline="\n") as f:
                    f.write(payload)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, path)
                self._write_meta_unlocked(state)
            finally:
                try:
                    if tmp.exists():
                        tmp.unlink()
                except OSError:
                    pass

    def create(self, sid: str) -> LoopState:
        state = LoopState(session_id=sid)
        self.save(state)
        return state

    def get_or_create(self, sid: str) -> LoopState:
        return self.load(sid) or self.create(sid)

    def delete(self, sid: str) -> bool:
        try:
            p = self._path(sid)
            if p.exists():
                p.unlink()
            meta = self._meta_path(sid)
            if meta.exists():
                meta.unlink()
            return True
        except Exception:
            return False


# ── 策略预设库（像 Prompts/Skills 一样可直接选用）──────────────────

def _preset(pid: str, name: str, desc: str, **policy_kw) -> dict:
    pol = LoopPolicy(**policy_kw)
    return {"id": f"builtin:{pid}", "name": name, "desc": desc,
            "builtin": True, "policy": pol.to_dict()}


BUILTIN_POLICY_PRESETS: list[dict] = [
    _preset("balanced", "稳健交付（默认）",
            "均衡门槛，独立对抗式评审防自欺。"),
    _preset("mvp", "快速探索 / MVP",
            "更低门槛、更少轮次，先把可用版本拿出来。",
            deliverable_score=60, outputtable_score=78, max_loops=5, risk_threshold=0.8,
            strategy=DEFAULT_STRATEGY + "\n\n额外：优先广度与可用性，先跑通主路径再谈打磨；"
            "但「可用」仍需实际验证，别把跑顺当跑通。"),
    _preset("research", "高标准研究",
            "高门槛、多轮次，强调严谨与证据。",
            deliverable_score=80, outputtable_score=92, max_loops=12, risk_threshold=0.9,
            strategy=DEFAULT_STRATEGY + "\n\n额外：每个结论都要有可复现的证据/实验支撑，"
            "记录方法与反例；高分必须经得起复核。"),
    _preset("adversarial", "对抗式自检（防自欺）",
            "强红队心智，默认未完成，逐条找漏洞。",
            deliverable_score=75, outputtable_score=90, max_loops=10, risk_threshold=0.85,
            independent_eval=True,
            strategy=DEFAULT_STRATEGY + "\n\n额外（红队）：每遍 analysis 先扮演挑刺的评审，"
            "主动构造失败用例与边界、尝试推翻「已完成」的判断；只有在你认真尝试推翻却推翻不了时，"
            "才给高分。把发现的漏洞写进 challenges 与下一步。"),
]


class LoopPolicyStore:
    """策略与心智的预设库：内置预设（只读）+ 用户自存预设。单文件 JSON。"""

    def __init__(self):
        self._dir = paths.sub("loop-policies")
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path = self._dir / "presets.json"
        self._lock = threading.Lock()

    def _load_user(self) -> list[dict]:
        if not self._path.exists():
            return []
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def _save_user(self, items: list[dict]) -> None:
        with self._lock:
            self._path.write_text(json.dumps(items, ensure_ascii=False, indent=2),
                                  encoding="utf-8")

    def list(self) -> list[dict]:
        return [dict(p) for p in BUILTIN_POLICY_PRESETS] + self._load_user()

    def save(self, name: str, policy: dict, pid: str = "") -> dict:
        items = self._load_user()
        name = (name or "").strip() or "未命名预设"
        norm = LoopPolicy.from_dict(policy or {}).to_dict()
        if pid and not str(pid).startswith("builtin:"):
            for it in items:
                if it.get("id") == pid:
                    it["name"] = name
                    it["policy"] = norm
                    it["updatedAt"] = _now()
                    self._save_user(items)
                    return it
        entry = {"id": f"user:{int(_now() * 1000)}", "name": name, "builtin": False,
                 "policy": norm, "updatedAt": _now()}
        items.append(entry)
        self._save_user(items)
        return entry

    def delete(self, pid: str) -> bool:
        if not pid or str(pid).startswith("builtin:"):
            return False
        items = self._load_user()
        new = [it for it in items if it.get("id") != pid]
        if len(new) != len(items):
            self._save_user(new)
            return True
        return False
