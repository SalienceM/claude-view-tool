import React, { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { api } from '../api';
import { markdownToHtml } from '../utils/markdown';
import { ImagePreview } from './ImagePreview';
import { useClipboardImage } from './../hooks/useClipboardImage';
import type { ImageAttachment } from './../hooks/useClipboardImage';
import { LoopPolicyEditor, normalizePolicy } from './LoopPolicyEditor';
import type { LoopPolicy } from './LoopPolicyEditor';
import type { ModelRuntime } from './CodexRuntimeFields';
import { TokenUsageMonitor } from './TokenUsageMonitor';
import {
  AdvancedPromptTextarea,
  type AdvancedPromptTextareaProps,
} from './AdvancedPromptTextarea';

/**
 * LoopPanel — 可视化 Loop 集成的全屏面板。
 *
 * 阶段（单向）：loopidea → loopexecute → loopout
 *  - loopidea ：非阻塞投递多条想法（后端并发池跑），封口后形成全局目标
 *  - loopexecute：每次 loop 走 prepare → execute → analysis，时间轴可视化 +
 *    点击查看任意 loop 的详情；带分数环、风险系数、可交付/可输出徽标
 *  - loopout ：全局产出
 *
 * 右上角可切换「Hack 模式」——整份状态以 terminal 风格的等宽文本呈现。
 */

interface LoopStep {
  index: number; mode: string; access?: 'read' | 'write'; desc: string; status: string; output: string;
  startedAt?: number; endedAt?: number; attempts?: number; recoveryNotes?: string[];
}
interface LoopAnalysis {
  score: number; notes: string; trend: string;
  optimizationPotential: number; challenges: string;
  verified: string; gaps: string; nextFocus: string;
  deliverable: boolean; outputtable: boolean;
}
interface LoopRecord {
  seq: number; subStage: string; round: number; goal: string; orchestration: LoopStep[];
  kind?: 'agent' | 'manual';
  iterationMode?: 'baseline' | 'evolution';
  evolutionBasis?: string;
  hasEvolutionBasis?: boolean;
  completed: boolean; result: string; analysis: LoopAnalysis | null; error: string;
  subStarted?: Record<string, number>; createdAt?: number; updatedAt?: number;
  hasGitCheckpoint?: boolean;
  backends?: Record<string, string>;          // {prepare, execute, analysis} → backend id
  runtimes?: Record<string, ModelRuntime>;    // {prepare, execute, analysis} → 实际模型/档位
  backendLabels?: Record<string, string>;     // {prepare, execute, analysis} → 可读 label
  manualMessages?: Array<{
    id: string; role: string; content: string; timestamp?: number; streaming?: boolean;
    toolCalls?: Array<{ name: string; status?: string; input?: string; output?: string; error?: string }>;
    thinkingBlocks?: Array<{ content: string }>;
  }>;
  manualContext?: string;
  detailLoaded?: boolean;
  manualMessageCount?: number;
}
interface IdeaEntry { id: string; prompt: string; status: string; result: string; error: string; images?: AddonImage[]; }
interface GoalRevision { goal: string; hint: string; source: string; createdAt: number; }
interface AsideTurn { id: string; question: string; answer: string; status: string; stage: string; seq: number; imageCount?: number; }
interface AddonImage { id?: string; base64: string; mime_type?: string; }
interface Addon { id: string; text: string; status: string; appliedSeq: number; images?: AddonImage[]; }
interface LoopStateT {
  sessionId: string; stage: string; goal: string;
  goalHistory: GoalRevision[];
  policy?: LoopPolicy;
  ideas: IdeaEntry[]; loops: LoopRecord[];
  riskCoefficient: number; maxLoops: number; effectiveMaxLoops: number;
  round: number; roundLoopCount: number;
  status: string; stopReason: string; bestScore: number; latestScore: number;
  bestSeq?: number;
  riskFactors?: Record<string, number>;
  asides: AsideTurn[];
  addons: Addon[];
  intentAlert?: { round?: number; seq?: number; aligned?: boolean; severity?: string; divergence?: string; suggestion?: string; dismissed?: boolean };
  auto: boolean; running: boolean; resumable: boolean;
  controlMode?: 'loop' | 'manual';
  canTakeover?: boolean;
}

/**
 * 完整详情只提供大字段，compact 摘要持续提供权威实时状态。合并时不能让
 * 旧详情快照覆盖新的 subStage / step.status，否则运行节点会停止动画。
 */
function mergeLoopRecordDetail(summary: LoopRecord, detail?: LoopRecord): LoopRecord {
  if (!detail) return summary;
  const detailSteps = new Map((detail.orchestration || []).map((step) => [step.index, step]));
  const orchestration = (summary.orchestration || []).map((step) => {
    const full = detailSteps.get(step.index);
    return full ? {
      ...full,
      ...step,
      output: full.output || step.output,
    } : step;
  });
  const analysis = summary.analysis && detail.analysis ? {
    ...detail.analysis,
    ...summary.analysis,
    notes: detail.analysis.notes || summary.analysis.notes,
    trend: detail.analysis.trend || summary.analysis.trend,
    challenges: detail.analysis.challenges || summary.analysis.challenges,
    verified: detail.analysis.verified || summary.analysis.verified,
    gaps: detail.analysis.gaps || summary.analysis.gaps,
    nextFocus: detail.analysis.nextFocus || summary.analysis.nextFocus,
  } : (summary.analysis || detail.analysis);
  return {
    ...detail,
    ...summary,
    result: detail.result || summary.result,
    manualMessages: detail.manualMessages || summary.manualMessages,
    manualContext: detail.manualContext || summary.manualContext,
    evolutionBasis: detail.evolutionBasis || summary.evolutionBasis,
    analysis,
    orchestration,
    detailLoaded: true,
  };
}

const SUB_LABEL: Record<string, string> = {
  prepare: 'Prepare', execute: 'Execute', analysis: 'Analysis', done: 'Done',
};
const SUB_ORDER = ['prepare', 'execute', 'analysis', 'done'];

export interface LoopPanelProps {
  sessionId: string;
  headerActions?: React.ReactNode;
  onClose?: () => void;
  embedded?: boolean;   // true = 作为会话内容内嵌渲染（无浮层、无关闭按钮）
  inspectOnly?: boolean; // true = 人工接管期间的只读总览（保留面板/流程，不暴露状态变更操作）
  sessionBackendId?: string;
  sessionRuntime?: ModelRuntime;
  backends?: any[];
  workingDir?: string;
  execKey?: string;
}

interface LoopPromptContextValue {
  sessionId: string;
  workingDir?: string;
  execKey?: string;
}

const LoopPromptContext = React.createContext<LoopPromptContextValue>({ sessionId: '' });
type LoopPromptTextareaProps = Omit<
  AdvancedPromptTextareaProps,
  'sessionId' | 'workingDir' | 'execKey'
>;

const LoopPromptTextarea: React.FC<LoopPromptTextareaProps> = (props) => {
  const context = useContext(LoopPromptContext);
  return <AdvancedPromptTextarea {...context} {...props} />;
};

export const LoopPanel: React.FC<LoopPanelProps> = ({
  sessionId, onClose, embedded, inspectOnly = false, sessionBackendId, sessionRuntime, backends,
  workingDir, execKey, headerActions,
}) => {
  const [state, setState] = useState<LoopStateT | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [recordDetails, setRecordDetails] = useState<Record<number, LoopRecord>>({});
  const [viewMode, setViewMode] = useState<'panel' | 'flow'>('panel');  // 可切换的执行流程视图
  const [ideaInput, setIdeaInput] = useState('');
  const [goalDraft, setGoalDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // 子阶段实时流式文本：key = `${seq}:${subStage}`
  const [progress, setProgress] = useState<Record<string, string>>({});
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const pendingProgressRef = useRef<Record<string, string>>({});
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionRef = useRef(sessionId);
  activeSessionRef.current = sessionId;

  const refresh = useCallback(async () => {
    const requestedSessionId = sessionId;
    const s = await api.loopGetState(sessionId);
    if (s && activeSessionRef.current === requestedSessionId) setState(s);
  }, [sessionId]);

  const selectLoop = useCallback((seq: number | null) => {
    setSelectedSeq(seq);
    if (seq == null || recordDetails[seq]?.detailLoaded) return;
    const requestedSessionId = sessionId;
    void api.loopGetRecord(sessionId, seq).then((result) => {
      if (activeSessionRef.current !== requestedSessionId) return;
      if (result.status === 'ok' && result.record) {
        setRecordDetails((previous) => ({ ...previous, [seq]: result.record as LoopRecord }));
        if (result.progress) {
          setProgress((previous) => {
            const next = { ...previous };
            for (const [key, replay] of Object.entries(result.progress || {})) {
              const current = next[key] || '';
              if (!current || replay.includes(current)) next[key] = replay;
              else if (!current.includes(replay)) next[key] = (replay + current).slice(-50_000);
            }
            return next;
          });
        }
      }
    });
  }, [sessionId, recordDetails]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    setState(null);
    setSelectedSeq(null);
    setRecordDetails({});
    setProgress({});
    progressRef.current = {};
    pendingProgressRef.current = {};
    if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    progressTimerRef.current = null;
  }, [sessionId]);

  // 订阅整份状态更新 + 子阶段流式文本（仅本 session）
  useEffect(() => {
    const un1 = api.onLoopUpdated((s: LoopStateT) => {
      if (s.sessionId !== sessionId) return;
      setState(s);
    });
    const un2 = api.onLoopProgress((d) => {
      if (d.sessionId !== sessionId) return;
      const key = `${d.seq}:${d.subStage}`;
      pendingProgressRef.current[key] = (pendingProgressRef.current[key] || '') + d.text;
      if (!progressTimerRef.current) {
        progressTimerRef.current = setTimeout(() => {
          const batch = pendingProgressRef.current;
          pendingProgressRef.current = {};
          progressTimerRef.current = null;
          setProgress((prev) => {
            const next = { ...prev };
            for (const [batchKey, text] of Object.entries(batch)) {
              // 实时窗口只保留尾部 50KB；完整结果以后端持久化状态为准。
              next[batchKey] = ((next[batchKey] || '') + text).slice(-50_000);
            }
            return next;
          });
        }, 50);
      }
    });
    return () => {
      un1(); un2();
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
      pendingProgressRef.current = {};
    };
  }, [sessionId]);

  const running = state?.running ?? false;
  const setAuto = useCallback((on: boolean) => api.loopSetAuto(sessionId, on), [sessionId]);
  const addAddon = useCallback((text: string, images?: ImageAttachment[]) => api.loopAddAddon(sessionId, text, images), [sessionId]);
  const editAddon = useCallback((id: string, text: string, images?: any[]) => api.loopEditAddon(sessionId, id, text, images), [sessionId]);
  const removeAddon = useCallback((id: string) => api.loopRemoveAddon(sessionId, id), [sessionId]);
  const continueRound = useCallback(async (goal: string) => {
    setBusy(true);
    try {
      const r = await api.loopContinue(sessionId, goal);
      if (r.status !== 'ok' && r.message) alert(r.message);
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  const submitIdea = useCallback(async (images?: ImageAttachment[]) => {
    const text = ideaInput.trim();
    if (!text && !(images && images.length)) return;
    setIdeaInput('');
    await api.loopSubmitIdea(sessionId, text, images);
  }, [ideaInput, sessionId]);

  const sealIdea = useCallback(async () => {
    if (!window.confirm('封口 loopidea 后将单向进入 loopexecute，无法回退。继续？')) return;
    setBusy(true);
    await api.loopSealIdea(sessionId, goalDraft.trim());
    setGoalDraft('');
    setBusy(false);
  }, [sessionId, goalDraft]);

  const runIteration = useCallback(async () => {
    setBusy(true);
    const r = await api.loopRunIteration(sessionId);
    if (r.status !== 'ok' && r.message) alert(r.message);
    setBusy(false);
  }, [sessionId]);

  const takeover = useCallback(async (nextRoundGoal: string = '') => {
    const fromLoopout = state?.stage === 'loopout';
    if (!window.confirm(
      fromLoopout
        ? '开启新一轮并切换到普通会话进行人工处理？\n\n本轮会记录为 Manual LOOP；完成后可交还给自动 LOOP。'
        : '切换到普通会话进行人工接管？\n\n人工对话和工具操作会作为一轮 Manual LOOP 留在时间线中，完成后可交还 LOOP。'
    )) return;
    setBusy(true);
    const r = await api.loopTakeover(sessionId, fromLoopout ? nextRoundGoal.trim() : '');
    setBusy(false);
    if (r.status !== 'ok' && r.message) alert(r.message);
  }, [sessionId, state?.stage]);

  const discardLoop = useCallback(async () => {
    // 丢弃目标：正在跑的那次（或最后一次）
    const target = state?.loops.find((l) => !l.completed && !l.error) || state?.loops[state.loops.length - 1];
    const hasGit = !!target?.hasGitCheckpoint;
    if (!window.confirm(
      '停止并删除本次 loop？当作没发生过：\n' +
      '· 这次 loop 记录与结果不保存\n' +
      '· 它消费的补充（addon）退回「待纳入」\n' +
      '· agent 上下文回滚到本次开跑前（不污染后续 loop）'
    )) return;
    let restoreFiles = false;
    if (hasGit) {
      restoreFiles = window.confirm(
        '同时把工作目录文件回滚到本次 loop 开跑前？\n\n' +
        '确定 = 用开跑前的 git 快照恢复工作树：丢弃本次 loop 的文件改动、删除它新建的文件\n' +
        '（开跑前你已有的改动/未跟踪文件会保留，.gitignore 忽略的文件不动）。\n\n' +
        '取消 = 仅丢弃记录/addon/上下文，保留磁盘上的文件改动。'
      );
    }
    const r = await api.loopDiscard(sessionId, 0, restoreFiles);
    if (r.status !== 'ok' && r.message) alert(r.message);
  }, [sessionId, state]);

  const advanceOut = useCallback(async () => {
    const prompt = running
      ? '当前 Loop 仍在执行。停止它、保留已完成步骤的结果并进入 loopout？'
      : '进入 loopout 全局产出阶段（单向）。继续？';
    if (!window.confirm(prompt)) return;
    setBusy(true);
    try {
      const r = await api.loopAdvanceToOut(sessionId);
      if (r.status !== 'ok' && r.message) alert(r.message);
    } finally {
      setBusy(false);
    }
  }, [sessionId, running]);

  const saveGoal = useCallback(async () => {
    await api.loopSetGoal(sessionId, goalDraft.trim());
  }, [sessionId, goalDraft]);

  const refineGoal = useCallback(async (hint: string, images?: ImageAttachment[]) => {
    return api.loopRefineGoal(sessionId, hint, images);
  }, [sessionId]);

  // embedded = 作为会话内容内嵌（填满 pane，无浮层 backdrop）；否则浮层模式
  const wrap = (children: React.ReactNode) => embedded
    ? <div className="awu-loop" style={embeddedShell}>{children}</div>
    : <div style={overlay}><div className="awu-loop" style={shell}>{children}</div></div>;

  const stateForView = state ? {
    ...state,
    loops: state.loops.map((record) => mergeLoopRecordDetail(record, recordDetails[record.seq])),
  } : null;

  if (!stateForView) {
    return wrap(
      <>
        <Header stage="…" sessionId={sessionId}
          actions={headerActions}
          onClose={onClose}
          embedded={embedded} inspectOnly={inspectOnly} />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text-muted)' }}>
          正在加载 Loop 状态…
        </div>
      </>
    );
  }

  return wrap(
    <LoopPromptContext.Provider value={{ sessionId, workingDir, execKey }}>
      <>
        <Header stage={stateForView.stage} sessionId={sessionId}
          actions={headerActions}
          onClose={onClose} embedded={embedded} inspectOnly={inspectOnly}
          viewMode={viewMode} setViewMode={setViewMode} canFlow={stateForView.stage !== 'loopidea'} />
        <StageRail stage={stateForView.stage} />
        {inspectOnly && (
          <div style={{
            flexShrink: 0, padding: '7px 18px', fontSize: 12,
            color: '#d29922', background: '#d2992214', borderBottom: '1px solid #d2992244',
          }}>
            ✋ 人工接管中 · 当前为只读 LOOP 总览，可切换面板 / 流程；返回聊天后继续人工操作。
          </div>
        )}

        <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflow: 'auto', padding: 'var(--ui-loop-body-padding, 12px 18px 24px)' }}>
              {!inspectOnly && <IntentBanner state={stateForView} sessionId={sessionId} />}
              {stateForView.stage === 'loopidea' ? (
                <>
                  <PolicyCard sessionId={sessionId} policy={stateForView.policy} readOnly={inspectOnly}
                    sessionBackendId={sessionBackendId} sessionRuntime={sessionRuntime} backends={backends} />
                  <IdeaStage
                    state={stateForView} ideaInput={ideaInput} setIdeaInput={setIdeaInput}
                    goalDraft={goalDraft} setGoalDraft={setGoalDraft}
                    onSubmit={submitIdea} onSeal={sealIdea} busy={busy}
                    onRemove={(id) => api.loopRemoveIdea(sessionId, id)}
                  />
                </>
              ) : viewMode === 'flow' ? (
                /* ★ 流程视图：把执行过程画成可追踪的流程图（当前位置 / 每步耗时 / doing 动线） */
                <>
                  <MetricBar state={stateForView} />
                  {stateForView.stage === 'loopexecute' && !inspectOnly && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
                      <button onClick={() => void takeover()} disabled={busy || !stateForView.canTakeover}
                        style={{ ...btn, borderColor: '#d2992255', color: '#d29922', opacity: stateForView.canTakeover ? 1 : 0.5 }}>
                        ✋ 人工接管
                      </button>
                    </div>
                  )}
                  <LoopFlowView state={stateForView} selectedSeq={selectedSeq} setSelectedSeq={selectLoop} />
                  {selectedSeq != null && stateForView.loops.find((l) => l.seq === selectedSeq) && (
                    <LoopDetail loop={stateForView.loops.find((l) => l.seq === selectedSeq)!} progress={progress} onClose={() => selectLoop(null)} />
                  )}
                </>
              ) : (
                <>
                  <MetricBar state={stateForView} />
                  <PolicyCard sessionId={sessionId} policy={stateForView.policy} readOnly={inspectOnly}
                    sessionBackendId={sessionBackendId} sessionRuntime={sessionRuntime} backends={backends} />
                  <ExecuteStage
                    state={stateForView} progress={progress}
                    selectedSeq={selectedSeq} setSelectedSeq={selectLoop}
                    onRun={runIteration} onAdvanceOut={advanceOut} onSetAuto={setAuto}
                    onAddAddon={addAddon} onRemoveAddon={removeAddon} onEditAddon={editAddon} onContinue={continueRound}
                    onDiscard={discardLoop} onTakeover={(goal = '') => void takeover(goal)}
                    running={running} busy={busy}
                    goalDraft={goalDraft} setGoalDraft={setGoalDraft} onSaveGoal={saveGoal}
                    onRefineGoal={refineGoal} inspectOnly={inspectOnly}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </>
    </LoopPromptContext.Provider>
  );
};

// ══ 意图守卫提示横幅（非阻塞）═══════════════════════════════════
const IntentBanner: React.FC<{ state: LoopStateT; sessionId: string }> = ({ state, sessionId }) => {
  const a = state.intentAlert;
  const [busy, setBusy] = useState(false);
  if (!a || a.dismissed || a.aligned || !(a.severity === 'medium' || a.severity === 'high')) return null;
  const high = a.severity === 'high';
  const col = high ? '#f87171' : '#bf8700';
  const adopt = async () => {
    const hint = [a.suggestion, a.divergence ? `（针对偏差：${a.divergence}）` : ''].filter(Boolean).join(' ').trim();
    if (!hint) return;
    setBusy(true);
    const r = await api.loopRefineGoal(sessionId, hint);
    setBusy(false);
    if (r.status === 'ok') api.loopDismissIntent(sessionId);
    else if (r.message) alert(r.message);
  };
  return (
    <div className="awu-reveal" style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 10, background: `${col}1a`, border: `1px solid ${col}55` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: col }}>⚠️ 意图可能跑偏（{high ? '高' : '中'}）</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => api.loopDismissIntent(sessionId)} style={miniX} title="知道了，关闭">✕</button>
      </div>
      {a.divergence && <div style={{ fontSize: 12.5, color: 'var(--theme-text)', lineHeight: 1.55 }}>{a.divergence}</div>}
      {a.suggestion && <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', marginTop: 4, lineHeight: 1.55 }}>建议：{a.suggestion}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        {a.suggestion && (
          <button onClick={adopt} disabled={busy}
            style={{ ...primaryBtn, padding: '6px 12px', background: col, opacity: busy ? 0.6 : 1 }}>
            {busy ? '⏳ 微调中…' : '✨ 采纳建议（微调目标）'}
          </button>
        )}
        <span style={{ fontSize: 10.5, color: 'var(--theme-text-muted)' }}>
          不打断执行。采纳=让模型按建议微调全局目标；也可手动改目标或「🗑 停止并删除本次」止损。
        </span>
      </div>
    </div>
  );
};

// ══ Header ════════════════════════════════════════════════════
const Header: React.FC<{
  stage: string;
  sessionId: string;
  actions?: React.ReactNode;
  onClose?: () => void; embedded?: boolean; inspectOnly?: boolean;
  viewMode?: 'panel' | 'flow'; setViewMode?: (v: 'panel' | 'flow') => void; canFlow?: boolean;
}> = ({ stage, sessionId, actions, onClose, embedded, inspectOnly, viewMode, setViewMode, canFlow }) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--ui-space-sm, 10px)', padding: 'var(--ui-loop-header-padding, 12px 18px)', flexWrap: 'wrap',
      borderBottom: '1px solid var(--theme-border)',
    }}>
      <span style={{ fontSize: 18 }}>🔁</span>
      <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text)' }}>可视化 Loop</span>
      <span style={{ fontSize: 12, color: 'var(--theme-accent)', fontFamily: 'monospace' }}>{stage}</span>
      {inspectOnly && (
        <span style={{ fontSize: 10.5, color: '#d29922', border: '1px solid #d2992255', borderRadius: 5, padding: '2px 6px' }}>
          只读
        </span>
      )}
      {/* ★ 视图切换：面板（原功能）⇄ 流程（执行追踪），随时切 */}
      {canFlow && setViewMode && (
        <div style={{ display: 'flex', gap: 0, border: '1px solid var(--theme-border)', borderRadius: 7, overflow: 'hidden', marginLeft: 4 }}>
          <button onClick={() => setViewMode('panel')} title="面板视图（原功能）"
            style={{ ...segBtn, ...(viewMode === 'panel' ? segActive : {}) }}>🗂 面板</button>
          <button onClick={() => setViewMode('flow')} title="流程视图：执行追踪 / 每步耗时"
            style={{ ...segBtn, ...(viewMode === 'flow' ? segActive : {}) }}>🔀 流程</button>
        </div>
      )}
      <div style={{ flex: 1 }} />
      <TokenUsageMonitor sessionId={sessionId} placement="header" />
      {actions}
      {!embedded && onClose && <button onClick={onClose} style={btn}>✕ 关闭</button>}
    </div>
  );

// ══ Stage rail ════════════════════════════════════════════════
const StageRail: React.FC<{ stage: string }> = ({ stage }) => {
  const stages = ['loopidea', 'loopexecute', 'loopout'];
  const cur = stages.indexOf(stage);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: 'var(--ui-loop-rail-padding, 10px 18px)', borderBottom: '1px solid var(--theme-border)' }}>
      {stages.map((s, i) => (
        <React.Fragment key={s}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            opacity: i <= cur ? 1 : 0.4,
          }}>
            <span style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
              background: i < cur ? 'var(--theme-accent)' : i === cur ? 'var(--theme-accent-bg)' : 'var(--theme-bg-tertiary)',
              color: i < cur ? '#fff' : 'var(--theme-accent)',
              border: `1px solid ${i <= cur ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
            }}>{i < cur ? '✓' : i + 1}</span>
            <span style={{ fontSize: 13, fontWeight: i === cur ? 700 : 500, color: i === cur ? 'var(--theme-text)' : 'var(--theme-text-muted)' }}>{s}</span>
          </div>
          {i < stages.length - 1 && (
            <div style={{ flex: 1, height: 2, margin: '0 10px', background: i < cur ? 'var(--theme-accent)' : 'var(--theme-border)' }} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

// ══ Metric bar ════════════════════════════════════════════════
const MetricBar: React.FC<{ state: LoopStateT }> = ({ state }) => (
  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
    <Metric label="最佳分数" value={state.bestScore.toFixed(0)} accent={scoreColor(state.bestScore)} />
    <Metric label="最近分数" value={state.latestScore.toFixed(0)} accent={scoreColor(state.latestScore)} />
    <Metric label={state.round > 1 ? `本轮 Loop（第${state.round}轮）` : '已跑 Loop'} value={`${state.roundLoopCount} / ${state.effectiveMaxLoops}`} />
    <RiskMetric risk={state.riskCoefficient} factors={state.riskFactors} />
    {state.bestScore >= 70 && <Badge text="可交付" color="#2da44e" />}
    {state.bestScore >= 85 && <Badge text="可输出" color="#8957e5" />}
    {state.status !== 'active' && <Badge text={state.status} color="#bf8700" />}
  </div>
);

const Metric: React.FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => (
  <div style={metricBox}>
    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{label}</div>
    <div style={{ fontSize: 20, fontWeight: 700, color: accent || 'var(--theme-text)', fontFamily: 'monospace' }}>{value}</div>
  </div>
);

const RiskMetric: React.FC<{ risk: number; factors?: Record<string, number> }> = ({ risk, factors }) => (
  <div style={metricBox} title={factors ? Object.entries(factors).map(([k, v]) => `${k}: ${v}`).join('\n') : undefined}>
    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>风险系数</div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'monospace', color: riskColor(risk) }}>{risk.toFixed(2)}</div>
      <div style={{ width: 50, height: 6, borderRadius: 3, background: 'var(--theme-bg-tertiary)', overflow: 'hidden' }}>
        <div style={{ width: `${risk * 100}%`, height: '100%', background: riskColor(risk) }} />
      </div>
    </div>
  </div>
);

const Badge: React.FC<{ text: string; color: string }> = ({ text, color }) => (
  <div style={{
    alignSelf: 'center', padding: '4px 12px', borderRadius: 14, fontSize: 12, fontWeight: 600,
    color, background: `${color}1f`, border: `1px solid ${color}55`,
  }}>{text}</div>
);

// ══ Idea stage ════════════════════════════════════════════════
const IdeaStage: React.FC<{
  state: LoopStateT; ideaInput: string; setIdeaInput: (v: string) => void;
  goalDraft: string; setGoalDraft: (v: string) => void;
  onSubmit: (images?: ImageAttachment[]) => void; onSeal: () => void; busy: boolean;
  onRemove: (id: string) => void;
}> = ({ state, ideaInput, setIdeaInput, goalDraft, setGoalDraft, onSubmit, onSeal, busy, onRemove }) => {
  const runningCount = state.ideas.filter((i) => i.status === 'running').length;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { images, removeImage, clearImages } = useClipboardImage(inputRef);
  const submit = () => {
    if (!ideaInput.trim() && images.length === 0) return;
    onSubmit(images); clearImages();
  };
  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--theme-text-muted)', margin: '0 0 12px' }}>
        头脑风暴阶段 · 非阻塞投递想法（可粘贴图片），后端最多 3 个并发展开。封口后形成全局目标并单向进入 loopexecute。
        {runningCount > 0 && <span style={{ color: 'var(--theme-accent)' }}> · {runningCount} 个进行中</span>}
      </p>

      {images.length > 0 && <ImagePreview images={images} onRemove={removeImage} />}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'flex-end' }}>
        <LoopPromptTextarea
          textareaRef={inputRef}
          value={ideaInput}
          onValueChange={setIdeaInput}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
          placeholder="一条想法/方向…（@ 引用文件/SESSION，可贴图，Ctrl/Cmd+Enter）"
          containerStyle={{ flex: 1 }}
          style={{ ...inputBase, width: '100%', minHeight: 56, resize: 'vertical' }}
        />
        <button onClick={submit} disabled={!ideaInput.trim() && images.length === 0}
          style={{ ...primaryBtn, opacity: (ideaInput.trim() || images.length) ? 1 : 0.5 }}>投递</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 24 }}>
        {state.ideas.length === 0 && (
          <div style={{ color: 'var(--theme-text-muted)', fontSize: 13 }}>还没有想法，先投递几条吧。</div>
        )}
        {state.ideas.map((idea) => (
          <div key={idea.id} style={ideaCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <StatusDot status={idea.status} />
              <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{idea.status}</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => onRemove(idea.id)} style={miniX} title="删除">✕</button>
            </div>
            {(idea.images || []).length > 0 && (
              <div style={{ display: 'flex', gap: 4, marginBottom: 5, flexWrap: 'wrap' }}>
                {(idea.images || []).map((im, i) => (
                  <img key={im.id || i} src={`data:${im.mime_type || 'image/png'};base64,${im.base64}`}
                    style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--theme-border)' }} />
                ))}
              </div>
            )}
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 4 }}>{idea.prompt}</div>
            {idea.result && <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{idea.result}</div>}
            {idea.error && <div style={{ fontSize: 12, color: '#f87171' }}>{idea.error}</div>}
          </div>
        ))}
      </div>

      <div style={sealBox}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 8 }}>封口 → 形成全局目标</div>
        <LoopPromptTextarea
          value={goalDraft}
          onValueChange={setGoalDraft}
          placeholder="可选：直接写全局目标；支持 @ 文件/SESSION。留空则由模型收敛。"
          containerStyle={{ width: '100%', marginBottom: 10 }}
          style={{ ...inputBase, minHeight: 60, resize: 'vertical', width: '100%' }}
        />
        <button onClick={onSeal} disabled={busy} style={{ ...primaryBtn, background: '#bf8700' }}>
          🔒 封口并进入 loopexecute
        </button>
      </div>
    </div>
  );
};

// ══ Addon 面板（执行中补充要求）═══════════════════════════════
const AddonPanel: React.FC<{
  addons: Addon[]; onAdd: (text: string, images?: ImageAttachment[]) => void; onRemove: (id: string) => void;
  onEdit: (id: string, text: string, images?: any[]) => Promise<{ status: string; message?: string }>;
}> = ({ addons, onAdd, onRemove, onEdit }) => {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { images, removeImage, clearImages } = useClipboardImage(inputRef);
  const pending = addons.filter((a) => a.status === 'pending');
  const submit = () => {
    const t = text.trim();
    if (!t && images.length === 0) return;
    setText(''); onAdd(t, images); clearImages();
  };
  return (
    <div style={{ ...sealBox, marginBottom: 16, borderColor: pending.length ? '#bf870055' : 'var(--theme-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text)' }}>📌 执行中补充 (addon)</span>
        {pending.length > 0 && (
          <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: '#bf87001f', color: '#bf8700', border: '1px solid #bf870055' }}>
            {pending.length} 条待纳入
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
        随手补充要求（可粘贴图片）—— <b>不影响当前正在跑的 loop</b>；下一次 loop 的分析与规划会带上并设法完成。纳入前可随时增删。已纳入的见下方「Addon 历史」。
      </div>
      {images.length > 0 && <ImagePreview images={images} onRemove={removeImage} />}
      <div style={{ display: 'flex', gap: 8, marginBottom: pending.length ? 12 : 0, alignItems: 'flex-end' }}>
        <LoopPromptTextarea
          textareaRef={inputRef}
          value={text}
          onValueChange={setText}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
          placeholder="补充要求 / 修正…（@ 引用文件/SESSION，可贴图，Ctrl/Cmd+Enter）"
          containerStyle={{ flex: 1 }}
          style={{ ...inputBase, width: '100%', minHeight: 56, maxHeight: 160, resize: 'vertical', lineHeight: 1.5 }}
        />
        <button onClick={submit} disabled={!text.trim() && images.length === 0}
          style={{ ...primaryBtn, padding: '8px 14px', opacity: (text.trim() || images.length) ? 1 : 0.5 }}>＋ 添加</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {pending.map((a) => (
          <AddonItem key={a.id} addon={a} onRemove={() => onRemove(a.id)} onEdit={onEdit} />
        ))}
      </div>
    </div>
  );
};

// 单条待纳入 addon：默认收成 2 行（上行缩略素材 + 下行截断文字），可点开展开 / 编辑
const AddonItem: React.FC<{
  addon: Addon; onRemove: () => void;
  onEdit: (id: string, text: string, images?: any[]) => Promise<{ status: string; message?: string }>;
}> = ({ addon, onRemove, onEdit }) => {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(addon.text);
  const [keptImgs, setKeptImgs] = useState<AddonImage[]>(addon.images || []);
  const [saving, setSaving] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const { images: newImgs, removeImage, clearImages } = useClipboardImage(editRef);
  const imgs = addon.images || [];

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setText(addon.text === '（图片）' ? '' : addon.text);
    setKeptImgs(addon.images || []);
    clearImages();
    setEditing(true);
  };
  const save = async () => {
    const combined = [
      ...keptImgs.map((i) => ({ id: i.id, base64: i.base64, mime_type: i.mime_type })),
      ...newImgs.map((i) => ({ id: i.id, base64: i.base64, mime_type: i.mime_type })),
    ];
    if (!text.trim() && combined.length === 0) return;
    setSaving(true);
    const r = await onEdit(addon.id, text.trim(), combined);
    setSaving(false);
    if (r.status === 'ok') { clearImages(); setEditing(false); }
    else if (r.message) alert(r.message);
  };

  if (editing) {
    return (
      <div className="awu-reveal" style={{ padding: '8px 10px', borderRadius: 8, background: '#bf87000d', border: '1px solid #bf870055' }}>
        {(keptImgs.length > 0 || newImgs.length > 0) && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
            {keptImgs.map((im, i) => (
              <div key={im.id || i} style={{ position: 'relative' }}>
                <img src={`data:${im.mime_type || 'image/png'};base64,${im.base64}`}
                  style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--theme-border)' }} />
                <button onClick={() => setKeptImgs((p) => p.filter((x) => x !== im))}
                  style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', border: 'none', background: '#f87171', color: '#fff', fontSize: 10, cursor: 'pointer', lineHeight: '16px', padding: 0 }}>✕</button>
              </div>
            ))}
          </div>
        )}
        {newImgs.length > 0 && <ImagePreview images={newImgs} onRemove={removeImage} />}
        <LoopPromptTextarea
          textareaRef={editRef}
          value={text}
          onValueChange={setText}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); }}
          placeholder="编辑补充…（@ 引用文件/SESSION，可贴图，Ctrl/Cmd+Enter）"
          autoFocus
          containerStyle={{ width: '100%' }}
          style={{ ...inputBase, width: '100%', minHeight: 54, maxHeight: 160, resize: 'vertical', lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={save} disabled={saving || (!text.trim() && keptImgs.length === 0 && newImgs.length === 0)}
            style={{ ...primaryBtn, padding: '6px 14px', opacity: saving ? 0.5 : 1 }}>{saving ? '保存中…' : '保存'}</button>
          <button onClick={() => { setEditing(false); clearImages(); }} style={btn}>取消</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px', borderRadius: 8, background: '#bf87000d', border: '1px solid #bf870033' }}>
      <span style={{ fontSize: 12, color: '#bf8700', marginTop: 2 }}>●</span>
      <div style={{ flex: 1, minWidth: 0, cursor: imgs.length || addon.text.length > 60 ? 'pointer' : 'default' }}
        onClick={() => setOpen((v) => !v)}>
        {imgs.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: open ? 'wrap' : 'nowrap', overflow: 'hidden' }}>
            {imgs.map((im, i) => (
              <img key={im.id || i} src={`data:${im.mime_type || 'image/png'};base64,${im.base64}`}
                style={{ width: open ? 56 : 30, height: open ? 56 : 30, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--theme-border)', flexShrink: 0 }} />
            ))}
          </div>
        )}
        <div style={{
          fontSize: 13, color: 'var(--theme-text)', lineHeight: 1.5,
          whiteSpace: open ? 'pre-wrap' : 'nowrap',
          overflow: open ? 'visible' : 'hidden', textOverflow: open ? 'clip' : 'ellipsis',
        }}>{addon.text}</div>
        {!open && (imgs.length > 0 || addon.text.length > 40) && (
          <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>点开看全部{imgs.length ? ` · 🖼️${imgs.length}` : ''}</span>
        )}
      </div>
      <button onClick={startEdit} style={miniX} title="编辑">✎</button>
      <button onClick={onRemove} style={miniX} title="删除">✕</button>
    </div>
  );
};

// ══ Addon 历史：哪一轮(第几轮 / 哪次 loop)纳入了哪些补充，随时可展开 ═══
const AddonHistoryCard: React.FC<{ addons: Addon[]; loops: LoopRecord[] }> = ({ addons, loops }) => {
  const [open, setOpen] = useState(false);
  const applied = addons.filter((a) => a.status === 'applied');
  if (applied.length === 0) return null;
  const roundOf = (seq: number) => loops.find((l) => l.seq === seq)?.round ?? 1;
  const groups = new Map<number, Addon[]>();
  applied.forEach((a) => {
    const arr = groups.get(a.appliedSeq) || [];
    arr.push(a); groups.set(a.appliedSeq, arr);
  });
  const seqs = Array.from(groups.keys()).sort((x, y) => y - x);  // 最近纳入的在上
  return (
    <div style={{ ...sealBox, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setOpen(!open)}
          style={{ ...linkBtn, fontWeight: 700, fontSize: 13, color: 'var(--theme-text)' }}>
          {open ? '▾' : '▸'} 📌 Addon 历史
        </button>
        <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{applied.length} 条已纳入 · 跨 {seqs.length} 次 loop</span>
      </div>
      {open && (
        <div className="awu-reveal" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {seqs.map((seq) => (
            <div key={seq}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--theme-accent)', marginBottom: 4 }}>
                第 {roundOf(seq)} 轮 · 由 Loop #{seq} 纳入（{groups.get(seq)!.length} 条）
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {groups.get(seq)!.map((a) => (
                  <div key={a.id} style={{ display: 'flex', gap: 8, padding: '6px 10px', borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)' }}>
                    <span style={{ fontSize: 11, color: '#2da44e', marginTop: 1 }}>✓</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {(a.images || []).length > 0 && (
                        <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
                          {(a.images || []).map((im, i) => (
                            <img key={im.id || i} src={`data:${im.mime_type || 'image/png'};base64,${im.base64}`}
                              style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--theme-border)' }} />
                          ))}
                        </div>
                      )}
                      <span style={{ fontSize: 12.5, color: 'var(--theme-text)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{a.text}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ══ loopout 引导：本轮产出 + 开启新一轮 ════════════════════════
const LoopOutBanner: React.FC<{
  state: LoopStateT; onContinue: (goal: string) => void;
  onTakeover: (goal: string) => void; busy: boolean;
  onSetAuto: (on: boolean) => void;
  onRefineGoal: (hint: string, images?: ImageAttachment[]) => Promise<{ status: string; goal?: string; message?: string }>;
}> =
  ({ state, onContinue, onTakeover, busy, onSetAuto, onRefineGoal }) => {
    const [goal, setGoal] = useState(state.goal || '');
    const [editing, setEditing] = useState(false);
    const [refineOpen, setRefineOpen] = useState(false);
    return (
      <div style={{ ...sealBox, marginBottom: 16, borderColor: '#8957e555', background: '#8957e50d' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text)' }}>
            ✅ loopout · 第 {state.round} 轮已产出
          </span>
          <span style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>最佳分数 {state.bestScore.toFixed(0)}</span>
        </div>
        {state.stopReason && (
          <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', marginBottom: 8 }}>收口原因：{state.stopReason}</div>
        )}
        <div style={{ fontSize: 12.5, color: 'var(--theme-text)', lineHeight: 1.6, marginBottom: 10 }}>
          loopout 是本轮的产出阶段，<b>不是会话终点</b>。你可以在现有成果（同一工作目录与上下文）的
          基础上 <b>设定 / 修改任务，开启新一轮迭代</b>——相当于一段新的 auto-loop，轮次 +1、趋势与
          风险从头计。{state.auto && <span style={{ color: '#2da44e' }}> Auto 已开启：开启后将自动连跑。</span>}
        </div>
        {refineOpen ? (
          <RefineBox onRefineGoal={onRefineGoal} onResult={(g) => setGoal(g)} onCancel={() => setRefineOpen(false)} />
        ) : (
          <>
            {editing ? (
              <LoopPromptTextarea
                value={goal} onValueChange={setGoal}
                placeholder="新一轮目标（支持 @ 文件/SESSION；默认沿用上一轮，可修改或追加）"
                containerStyle={{ width: '100%', marginBottom: 10 }}
                style={{ ...inputBase, width: '100%', minHeight: 64, resize: 'vertical' }}
              />
            ) : (
              <div
                onClick={() => setEditing(true)}
                title="点击修改新一轮目标"
                style={{ fontSize: 13, color: 'var(--theme-text)', lineHeight: 1.6, marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px dashed var(--theme-border)', cursor: 'text', whiteSpace: 'pre-wrap' }}
              >
                🎯 {goal || '（点击设定新一轮目标）'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button onClick={() => setRefineOpen(true)} style={{ ...btn, ...btnActive }}
                title="给一句提示，让模型基于当前目标+原始诉求自动改写新一轮目标">✨ 微调目标</button>
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* 在离开 loopout 前显式展示持久化的 Auto 状态，避免用户在不知情时直接触发连跑。 */}
          <button
            onClick={() => onSetAuto(!state.auto)}
            disabled={busy}
            style={{
              ...btn,
              ...(state.auto ? { background: '#2da44e1f', color: '#2da44e', borderColor: '#2da44e55' } : {}),
              opacity: busy ? 0.6 : 1,
            }}
            title="先设定新一轮是否自动连跑；在 loopout 中切换此项不会启动任务"
          >
            {state.auto ? '🔄 Auto 开（新一轮将自动连跑）' : '⏸ Auto 关（新一轮手动逐次运行）'}
          </button>
          <button
            onClick={() => onContinue(goal.trim())}
            disabled={busy}
            style={{ ...primaryBtn, background: '#8957e5', opacity: busy ? 0.6 : 1 }}
            title={state.running ? '先强制结束仍未退出的上一轮，再自动切换到新一轮' : undefined}
          >
            {state.running ? '⏹ 停止上一轮并开启新一轮' : `▶ 开启新一轮（第 ${state.round + 1} 轮 loopexecute）`}
          </button>
          <button
            onClick={() => onTakeover(goal.trim())}
            disabled={busy || state.running}
            style={{
              ...btn,
              borderColor: '#d2992266', color: '#d29922',
              background: '#d2992212', opacity: (busy || state.running) ? 0.5 : 1,
            }}
            title={state.running
              ? '上一轮仍在收尾，完成后才可开启人工轮'
              : `开启第 ${state.round + 1} 轮并直接切到普通对话；本轮记为 Manual LOOP`}
          >
            ✋ 开启人工轮（第 {state.round + 1} 轮）
          </button>
          <span style={{ fontSize: 11.5, color: 'var(--theme-text-muted)' }}>
            自动轮沿用 Auto 设置；人工轮会自动关闭 Auto
          </span>
        </div>
      </div>
    );
  };

// ══ Goal card：全局目标 + 演变历史 + 按提示微调 + 原始诉求回看 ═══
const SRC_LABEL: Record<string, { t: string; c: string }> = {
  seal: { t: '封口汇总', c: '#0969da' },
  refine: { t: '提示微调', c: '#8957e5' },
  manual: { t: '手动', c: '#bf8700' },
};

function relTime(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// ══ 策略与心智卡片：实时查看 / 调整 ═══════════════════════════
const PolicyCard: React.FC<{
  sessionId: string;
  policy?: LoopPolicy;
  readOnly?: boolean;
  sessionBackendId?: string;
  sessionRuntime?: ModelRuntime;
  backends?: any[];
}> = ({ sessionId, policy, readOnly = false, sessionBackendId, sessionRuntime, backends }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LoopPolicy>(() => normalizePolicy(policy));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // 外部（loopUpdated）更新 policy 时，未在编辑则同步进草稿
  useEffect(() => { if (!dirty) setDraft(normalizePolicy(policy)); }, [policy, dirty]);
  const p = normalizePolicy(policy);
  const save = async () => {
    setSaving(true);
    const r = await api.loopSetPolicy(sessionId, normalizePolicy(draft));
    setSaving(false);
    if (r.status === 'ok') setDirty(false);
    else if (r.message) alert(r.message);
  };
  return (
    <div style={{ ...sealBox, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {readOnly ? (
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--theme-text)' }}>⚙️ 策略与心智</span>
        ) : (
          <button onClick={() => setOpen(!open)}
            style={{ ...linkBtn, fontWeight: 700, fontSize: 13, color: 'var(--theme-text)' }}>
            {open ? '▾' : '▸'} ⚙️ 策略与心智
          </button>
        )}
        <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
          可交付≥{p.deliverableScore} · 可输出≥{p.outputtableScore} · 最多 {p.maxLoops} loop · 风险≥{p.riskThreshold.toFixed(2)} 收口 · 评审{p.independentEval ? '独立防自欺' : '常规'}{Object.values(p.backends || {}).some(Boolean) ? ' · 异构 Backend' : ''}{Object.values(p.runtimes || {}).some((r) => r?.model || r?.reasoningEffort) ? ' · 模型分档' : ''}
        </span>
      </div>
      {open && !readOnly && (
        <div className="awu-reveal" style={{ marginTop: 10 }}>
          <LoopPolicyEditor value={draft} onChange={(v) => { setDraft(v); setDirty(true); }}
            availableBackends={backends} sessionBackendId={sessionBackendId} sessionRuntime={sessionRuntime} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={save} disabled={saving || !dirty}
              style={{ ...primaryBtn, opacity: (saving || !dirty) ? 0.5 : 1 }}>
              {saving ? '保存中…' : '保存策略'}
            </button>
            {dirty && <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>改动未保存 · 不影响进行中的 loop，从下一次起生效</span>}
          </div>
        </div>
      )}
    </div>
  );
};

// 按提示让模型微调目标的输入框（GoalCard 与 loopout 新一轮共用）
const RefineBox: React.FC<{
  onRefineGoal: (hint: string, images?: ImageAttachment[]) => Promise<{ status: string; goal?: string; message?: string }>;
  onResult?: (goal: string) => void;   // 拿到微调结果（loopout 用来同步本地草稿）
  onCancel: () => void;
}> = ({ onRefineGoal, onResult, onCancel }) => {
  const [hint, setHint] = useState('');
  const [refining, setRefining] = useState(false);
  const refineRef = useRef<HTMLTextAreaElement>(null);
  const { images, removeImage, clearImages } = useClipboardImage(refineRef);
  const doRefine = async () => {
    const h = hint.trim();
    if (!h && images.length === 0) return;
    setRefining(true);
    const r = await onRefineGoal(h, images.length ? images : undefined);
    setRefining(false);
    if (r.status === 'ok') { if (r.goal) onResult?.(r.goal); setHint(''); clearImages(); onCancel(); }
    else if (r.message) alert(r.message);
  };
  return (
    <div className="awu-reveal" style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-accent)' }}>
      <div style={{ fontSize: 11.5, color: 'var(--theme-text-muted)', marginBottom: 6, lineHeight: 1.5 }}>
        给一句提示，由模型在「当前目标 + 原始诉求」基础上自动改写。支持贴图（Snipaste/粘贴）作为参考。每次微调都会留一版历史。
      </div>
      <LoopPromptTextarea textareaRef={refineRef} autoFocus value={hint} onValueChange={setHint} disabled={refining}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doRefine(); }}
        placeholder="微调提示…（@ 引用文件/SESSION，可贴图，Ctrl/Cmd+Enter）"
        containerStyle={{ width: '100%' }}
        style={{ ...inputBase, width: '100%', minHeight: 50, resize: 'vertical', opacity: refining ? 0.6 : 1 }} />
      <ImagePreview images={images} onRemove={removeImage} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={doRefine} disabled={refining || (!hint.trim() && images.length === 0)} style={{ ...primaryBtn, opacity: (refining || (!hint.trim() && images.length === 0)) ? 0.5 : 1 }}>
          {refining ? '⏳ 微调中…' : '✨ 让模型微调'}
        </button>
        <button onClick={onCancel} disabled={refining} style={btn}>取消</button>
      </div>
    </div>
  );
};

const GoalCard: React.FC<{
  state: LoopStateT; isOut: boolean;
  readOnly?: boolean;
  onRefineGoal: (hint: string, images?: ImageAttachment[]) => Promise<{ status: string; goal?: string; message?: string }>;
  goalDraft: string; setGoalDraft: (v: string) => void; onSaveGoal: () => void;
}> = ({ state, isOut, readOnly = false, onRefineGoal, goalDraft, setGoalDraft, onSaveGoal }) => {
  const [mode, setMode] = useState<'view' | 'refine' | 'edit'>('view');
  const [showHist, setShowHist] = useState(false);
  const [showIdeas, setShowIdeas] = useState(false);
  const history = state.goalHistory || [];
  const ideas = state.ideas || [];

  return (
    <div style={{ ...sealBox, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text)' }}>🎯 全局目标</span>
        {history.length > 0 && <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>v{history.length}</span>}
        <div style={{ flex: 1 }} />
        {mode === 'view' && !readOnly && (
          <>
            <button onClick={() => setMode('refine')} style={{ ...btn, ...btnActive }} title="给一句提示，让模型在当前目标+原始诉求基础上自动微调">✨ 微调目标</button>
            <button onClick={() => { setMode('edit'); setGoalDraft(state.goal); }} style={btn} title="手动改写">编辑</button>
          </>
        )}
      </div>

      {/* 当前目标 */}
      <div style={{ fontSize: 13, color: state.goal ? 'var(--theme-text)' : 'var(--theme-text-muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
        {state.goal || '（封口后由模型收敛中…稍候自动出现）'}
      </div>

      {/* 按提示微调（引导模型，无需人手编辑） */}
      {mode === 'refine' && !readOnly && (
        <RefineBox onRefineGoal={onRefineGoal} onCancel={() => setMode('view')} />
      )}

      {/* 手动编辑（兜底） */}
      {mode === 'edit' && !readOnly && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <LoopPromptTextarea value={goalDraft} onValueChange={setGoalDraft}
            containerStyle={{ flex: 1 }} style={{ ...inputBase, width: '100%', minHeight: 54 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button onClick={() => { onSaveGoal(); setMode('view'); }} style={primaryBtn}>保存</button>
            <button onClick={() => setMode('view')} style={btn}>取消</button>
          </div>
        </div>
      )}

      {/* 折叠入口：目标演变 + 原始诉求 */}
      <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
        {history.length > 1 && (
          <button onClick={() => setShowHist(!showHist)} style={linkBtn}>
            {showHist ? '▾' : '▸'} 目标演变（{history.length} 版）
          </button>
        )}
        {ideas.length > 0 && (
          <button onClick={() => setShowIdeas(!showIdeas)} style={linkBtn}>
            {showIdeas ? '▾' : '▸'} 原始诉求（{ideas.length} 条）
          </button>
        )}
      </div>

      {showHist && history.length > 0 && (
        <div className="awu-reveal" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {history.map((g, i) => {
            const sl = SRC_LABEL[g.source] || SRC_LABEL.manual;
            const cur = i === history.length - 1;
            return (
              <div key={i} style={{ padding: '8px 10px', borderRadius: 8, background: cur ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)', border: `1px solid ${cur ? 'var(--theme-accent)' : 'var(--theme-border)'}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: sl.c, borderRadius: 4, padding: '1px 6px' }}>v{i + 1} · {sl.t}</span>
                  {cur && <span style={{ fontSize: 10, color: 'var(--theme-accent)', fontWeight: 600 }}>当前</span>}
                  <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>{relTime(g.createdAt)}</span>
                </div>
                {g.hint && <div style={{ fontSize: 11.5, color: 'var(--theme-text-muted)', marginBottom: 4 }}>提示：{g.hint}</div>}
                <div style={{ fontSize: 12.5, color: 'var(--theme-text)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{g.goal}</div>
              </div>
            );
          })}
        </div>
      )}

      {showIdeas && ideas.length > 0 && (
        <div className="awu-reveal" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>封口前投递的想法 / 原始诉求（全局目标由此收敛而来）：</div>
          {ideas.map((it) => (
            <div key={it.id} style={{ padding: '7px 10px', borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)' }}>
              {(it.images || []).length > 0 && (
                <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
                  {(it.images || []).map((im, i) => (
                    <img key={im.id || i} src={`data:${im.mime_type || 'image/png'};base64,${im.base64}`}
                      style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--theme-border)' }} />
                  ))}
                </div>
              )}
              <div style={{ fontSize: 12.5, color: 'var(--theme-text)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{it.prompt}</div>
              {it.result && <div style={{ fontSize: 11.5, color: 'var(--theme-text-muted)', marginTop: 4, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>↳ {it.result}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ══ Execute stage ═════════════════════════════════════════════
const ExecuteStage: React.FC<{
  state: LoopStateT; progress: Record<string, string>;
  selectedSeq: number | null; setSelectedSeq: (v: number | null) => void;
  onRun: () => void; onAdvanceOut: () => void; onSetAuto: (on: boolean) => void;
  onAddAddon: (text: string, images?: ImageAttachment[]) => void; onRemoveAddon: (id: string) => void;
  onEditAddon: (id: string, text: string, images?: any[]) => Promise<{ status: string; message?: string }>;
  onContinue: (goal: string) => void; onDiscard: () => void; onTakeover: (goal?: string) => void;
  running: boolean; busy: boolean;
  goalDraft: string; setGoalDraft: (v: string) => void; onSaveGoal: () => void;
  onRefineGoal: (hint: string, images?: ImageAttachment[]) => Promise<{ status: string; goal?: string; message?: string }>;
  inspectOnly?: boolean;
}> = ({ state, progress, selectedSeq, setSelectedSeq, onRun, onAdvanceOut, onSetAuto, onAddAddon, onRemoveAddon, onEditAddon, onContinue, onDiscard, onTakeover, running, busy, goalDraft, setGoalDraft, onSaveGoal, onRefineGoal, inspectOnly = false }) => {
  const isOut = state.stage === 'loopout';
  const selected = state.loops.find((l) => l.seq === selectedSeq) || null;
  const runLabel = state.resumable
    ? `▶ 继续未完成的 Loop #${state.loops.length}`
    : `▶ 运行下一次 Loop${state.round > 1 ? `（第 ${state.round} 轮）` : ''}`;

  return (
    <div>
      {/* 全局目标（含演变历史 + 按提示微调 + 原始诉求回看） */}
      <GoalCard state={state} isOut={isOut} readOnly={inspectOnly} onRefineGoal={onRefineGoal}
        goalDraft={goalDraft} setGoalDraft={setGoalDraft} onSaveGoal={onSaveGoal} />

      {/* 操作 */}
      {!isOut && !inspectOnly && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={onRun} disabled={busy || running} style={{ ...primaryBtn, opacity: (busy || running) ? 0.5 : 1 }}>
            {running ? '⏳ Loop 进行中…' : runLabel}
          </button>
          {/* ★ 自动连跑开关：开则一次 loop 完成自动续下一次，可随时取消 */}
          <button
            onClick={() => onSetAuto(!state.auto)}
            style={{ ...btn, ...(state.auto ? { background: '#2da44e1f', color: '#2da44e', borderColor: '#2da44e55' } : {}) }}
            title="自动连跑：开启后一次 loop 完成即自动开始下一次，直到收口或你取消"
          >
            {state.auto ? '🔄 Auto 连跑中（点此暂停）' : '⏸ Auto 关（点此自动连跑）'}
          </button>
          <button onClick={onAdvanceOut} disabled={busy} style={btn}>
            {running ? '⏹ 停止并进入 loopout' : '⏹ 进入 loopout'}
          </button>
          <button
            onClick={() => onTakeover()}
            disabled={busy || !state.canTakeover}
            style={{ ...btn, borderColor: '#d2992255', color: '#d29922', opacity: state.canTakeover ? 1 : 0.5 }}
            title={state.resumable ? '存在未完成的 LOOP，请先继续或丢弃' : running ? 'LOOP 运行中不能接管' : '切换到普通会话；人工操作记为一轮 Manual LOOP'}
          >
            ✋ 人工接管
          </button>
          {/* ★ 误触兜底：停止并删除本次 loop（当作没发生过，addon 退回待纳入） */}
          {(running || state.resumable) && (
            <button onClick={onDiscard}
              style={{ ...btn, background: '#f871711f', color: '#f87171', borderColor: '#f8717155', marginLeft: 'auto' }}
              title="停止并删除本次 loop：不保存结果，已消费的补充(addon)退回待纳入">
              🗑 停止并删除本次
            </button>
          )}
          {state.auto && running && (
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted)' }}>完成本次后将自动继续…</span>
          )}
        </div>
      )}
      {/* loopout：不是终点 —— 展示本轮产出小结 + 开启新一轮的引导 */}
      {isOut && !inspectOnly && <LoopOutBanner state={state} onContinue={onContinue}
        onTakeover={(goal) => onTakeover(goal)} busy={busy}
        onSetAuto={onSetAuto} onRefineGoal={onRefineGoal} />}

      {/* ★ 执行中补充（addon）：不影响当前 loop，下一次 loop 纳入并完成 */}
      {!isOut && !inspectOnly && <AddonPanel addons={state.addons || []} onAdd={onAddAddon} onRemove={onRemoveAddon} onEdit={onEditAddon} />}

      {/* ★ Addon 历史：哪一轮/哪次 loop 纳入了哪些补充（执行中 & loopout 都可看） */}
      <AddonHistoryCard addons={state.addons || []} loops={state.loops} />

      {/* Loop 时间轴（多轮时按轮分隔） */}
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 12, marginBottom: 8, alignItems: 'stretch' }}>
        {state.loops.length === 0 && <div style={{ color: 'var(--theme-text-muted)', fontSize: 13 }}>还没有 loop，点击上方按钮开始第 1 次。</div>}
        {state.loops.slice().reverse().map((l, i, arr) => {
          const newRound = state.round > 1 && (i === 0 || arr[i - 1].round !== l.round);
          return (
            <React.Fragment key={l.seq}>
              {newRound && (
                <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  <span style={{ writingMode: 'vertical-rl', fontSize: 10, fontWeight: 700, color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)', borderRadius: 6, padding: '6px 3px', letterSpacing: 1 }}>
                    第 {l.round} 轮
                  </span>
                </div>
              )}
              <LoopNode loop={l} selected={l.seq === selectedSeq} onClick={() => setSelectedSeq(l.seq === selectedSeq ? null : l.seq)} />
            </React.Fragment>
          );
        })}
      </div>

      {/* 详情面板 */}
      {selected && <LoopDetail loop={selected} progress={progress} onClose={() => setSelectedSeq(null)} />}
    </div>
  );
};

// ══ 流程视图：把执行过程画成可追踪的流程图 ════════════════════
//   每个 loop 一条横向泳道：[#seq] → Prepare → Execute(分步) → Analysis
//   节点按状态着色，当前在跑的节点脉冲 + 入边走「marching ants」动线，
//   每个节点/分步标注耗时（进行中实时累计）。
function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

// 进行中需要实时刷新耗时：active 时每秒 tick
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const FLOW_STATUS_COLOR: Record<string, string> = {
  done: '#2da44e', running: '#0969da', error: '#f87171', current: '#bf8700', pending: 'var(--theme-text-muted)',
};

const LoopFlowView: React.FC<{
  state: LoopStateT; selectedSeq: number | null; setSelectedSeq: (v: number | null) => void;
}> = ({ state, selectedSeq, setSelectedSeq }) => {
  const now = useNow(state.running);
  const loops = state.loops;
  // 当前真正在跑的 loop（用于脉冲 / 动线）
  const activeSeq = state.running
    ? (loops.find((l) => !l.completed && !l.error)?.seq ?? null)
    : null;

  if (loops.length === 0) {
    return <div style={{ color: 'var(--theme-text-muted)', fontSize: 13, padding: '20px 0' }}>还没有 loop —— 切回「面板」点运行开始第 1 次。</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div style={{ fontSize: 12, color: 'var(--theme-text-muted)', marginBottom: 10 }}>
        每条泳道是一次 loop 的执行流程；颜色表状态，<span style={{ color: '#0969da' }}>蓝色脉冲 = 正在执行</span>，节点下标注耗时。点节点看详情。
      </div>
      {loops.slice().reverse().map((loop, i, arr) => {
        const newRound = state.round > 1 && (i === 0 || arr[i - 1].round !== loop.round);
        return (
          <React.Fragment key={loop.seq}>
            {newRound && (
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)', borderRadius: 6, padding: '3px 10px', alignSelf: 'flex-start', margin: '6px 0' }}>
                第 {loop.round} 轮
              </div>
            )}
            {i > 0 && !newRound && (
              <div style={{ width: 2, height: 14, background: 'var(--theme-border)', marginLeft: 28 }} />
            )}
            <FlowLane loop={loop} live={loop.seq === activeSeq} now={now}
              selected={loop.seq === selectedSeq}
              onSelect={() => setSelectedSeq(loop.seq === selectedSeq ? null : loop.seq)} />
          </React.Fragment>
        );
      })}
    </div>
  );
};

const FlowLane: React.FC<{
  loop: LoopRecord; live: boolean; now: number; selected: boolean; onSelect: () => void;
}> = ({ loop, live, now, selected, onSelect }) => {
  const order = ['prepare', 'execute', 'analysis'];
  const sub = loop.subStarted || {};
  const curName = loop.subStage === 'done' ? 'analysis' : loop.subStage;
  const curIdx = order.indexOf(curName);
  const done = loop.completed;

  const nstatus = (i: number): string => {
    if (loop.error && i === curIdx && !done) return 'error';
    if (done || i < curIdx) return 'done';
    if (i === curIdx) return live ? 'running' : 'current';
    return 'pending';
  };
  // 子阶段耗时：start 到下一阶段 start（或进行中到 now / 完成到 done）
  const subDur = (i: number): number => {
    const starts = [sub.prepare ?? loop.createdAt, sub.execute, sub.analysis];
    const st = starts[i];
    if (!st) return 0;
    const nextStart = i < 2 ? starts[i + 1] : (sub.done ?? (done ? loop.updatedAt : undefined));
    const end = nextStart ?? (nstatus(i) === 'running' ? now : undefined);
    return end ? end - st : 0;
  };

  const score = loop.analysis?.score ?? null;
  if (loop.kind === 'manual') {
    const duration = (loop.subStarted?.execute && loop.updatedAt)
      ? fmtDur(loop.updatedAt - loop.subStarted.execute) : '';
    return (
      <div onClick={onSelect} className="awu-card" style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
        background: selected ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)',
        border: `1px solid ${selected ? 'var(--theme-accent)' : '#d2992255'}`,
      }}>
        <FlowChip title={`Manual #${loop.seq}`} status={loop.completed ? 'done' : 'current'}
          sub={`${loop.orchestration.length} 次人工交互`} big />
        <FlowEdge active={false} done={loop.completed} />
        <FlowChip title="人工接管" status={loop.completed ? 'done' : 'current'} dur={duration}
          sub={loop.completed ? '已交还 LOOP' : '接管中'} steps={loop.orchestration} now={now}
          tag={<BackendTag role="execute" label={loop.backendLabels?.execute} />} />
      </div>
    );
  }
  return (
    <div onClick={onSelect} className="awu-card"
      style={{
        display: 'flex', alignItems: 'stretch', gap: 0, padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
        background: selected ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)',
        border: `1px solid ${selected ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
        overflowX: 'auto',
      }}>
      {/* loop 头节点 */}
      <FlowChip title={`Loop #${loop.seq}`} status={done ? 'done' : (loop.error ? 'error' : (live ? 'running' : 'current'))}
        sub={score != null ? `score ${score.toFixed(0)}` : (loop.round > 1 ? `第${loop.round}轮` : '进行中')} big />
      <FlowEdge active={nstatus(0) === 'running'} done={nstatus(0) !== 'pending'} />
      <FlowChip title="Prepare" status={nstatus(0)} dur={fmtDur(subDur(0))}
        tag={<BackendTag role="prepare" label={loop.backendLabels?.prepare} />} />
      <FlowEdge active={nstatus(1) === 'running'} done={nstatus(1) !== 'pending'} />
      {/* Execute：含分步 */}
      <FlowChip title="Execute" status={nstatus(1)} dur={fmtDur(subDur(1))}
        sub={loop.orchestration.length ? `${loop.orchestration.filter((s) => s.status === 'done').length}/${loop.orchestration.length} 步` : undefined}
        steps={loop.orchestration} now={now}
        tag={<BackendTag role="execute" label={loop.backendLabels?.execute} />} />
      <FlowEdge active={nstatus(2) === 'running'} done={nstatus(2) !== 'pending'} />
      <FlowChip title="Analysis" status={nstatus(2)} dur={fmtDur(subDur(2))}
        sub={score != null ? `score ${score.toFixed(0)}` : undefined}
        tag={<BackendTag role="analysis" label={loop.backendLabels?.analysis} />} />
    </div>
  );
};

const FlowEdge: React.FC<{ active: boolean; done: boolean }> = ({ active, done }) => (
  <div style={{ alignSelf: 'center', flexShrink: 0, width: 34, height: 2, margin: '0 2px', position: 'relative' }}>
    <div className={active ? 'awu-flow-dash' : undefined}
      style={{
        position: 'absolute', inset: 0,
        background: active ? undefined : (done ? 'var(--theme-accent)' : 'var(--theme-border)'),
      }} />
  </div>
);

const FlowChip: React.FC<{
  title: string; status: string; dur?: string; sub?: string; big?: boolean;
  steps?: LoopStep[]; now?: number; tag?: React.ReactNode;
}> = ({ title, status, dur, sub, big, steps, now, tag }) => {
  const col = FLOW_STATUS_COLOR[status] || FLOW_STATUS_COLOR.pending;
  const pulse = status === 'running';
  return (
    <div style={{
      flexShrink: 0, minWidth: big ? 96 : 110, display: 'flex', flexDirection: 'column', gap: 4,
      padding: '8px 10px', borderRadius: 10,
      background: 'var(--theme-bg-tertiary)',
      border: `1.5px solid ${col === 'var(--theme-text-muted)' ? 'var(--theme-border)' : col}`,
      boxShadow: pulse ? `0 0 0 0 ${col}` : 'none',
      animation: pulse ? 'awu-flow-pulse 1.3s infinite' : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: col, flexShrink: 0,
          animation: pulse ? 'awu-loop-pulse 1.2s infinite' : 'none' }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text)' }}>{title}</span>
      </div>
      {sub && <span style={{ fontSize: 10.5, color: 'var(--theme-text-muted)' }}>{sub}</span>}
      {dur && <span style={{ fontSize: 10.5, color: col, fontFamily: 'monospace', fontWeight: 600 }}>⏱ {dur}</span>}
      {tag && <div style={{ marginTop: 1 }}>{tag}</div>}
      {steps && steps.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
          {steps.map((s) => {
            const sc = FLOW_STATUS_COLOR[s.status === 'pending' ? 'pending' : s.status] || FLOW_STATUS_COLOR.pending;
            const d = s.startedAt ? ((s.endedAt || (s.status === 'running' ? (now || Date.now() / 1000) : 0)) - s.startedAt) : 0;
            return (
              <div key={s.index} title={s.desc} style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: 200 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: sc, flexShrink: 0,
                  animation: s.status === 'running' ? 'awu-loop-pulse 1.2s infinite' : 'none' }} />
                <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>
                  {s.mode === 'concurrent' && s.access === 'read' ? '∥' : '→'}{s.index}
                  {s.access === 'write' ? ' ✎' : ''}
                </span>
                <span style={{ fontSize: 10, color: 'var(--theme-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{s.desc}</span>
                {d > 0 && <span style={{ fontSize: 9.5, color: sc, fontFamily: 'monospace', flexShrink: 0 }}>{fmtDur(d)}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const LoopNode: React.FC<{ loop: LoopRecord; selected: boolean; onClick: () => void }> = ({ loop, selected, onClick }) => {
  const score = loop.analysis?.score ?? null;
  const subIdx = SUB_ORDER.indexOf(loop.subStage);
  const manual = loop.kind === 'manual';
  return (
    <div
      onClick={onClick}
      className="awu-card"
      style={{
        flexShrink: 0, width: 150, cursor: 'pointer', padding: 12, borderRadius: 12,
        background: selected ? 'var(--theme-accent-bg)' : 'var(--theme-bg-secondary)',
        border: `1px solid ${selected ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: manual ? '#d29922' : 'var(--theme-text)' }}>
          {manual ? 'Manual' : 'Loop'} #{loop.seq}
        </span>
        {manual ? <span style={{ fontSize: 16 }}>✋</span> : <ScoreRing score={score} pending={!loop.completed} />}
      </div>
      {/* 子阶段进度 */}
      {!manual && <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {SUB_ORDER.slice(0, 3).map((s, i) => (
          <div key={s} style={{
            flex: 1, height: 4, borderRadius: 2,
            background: loop.error ? '#f87171' : i < subIdx ? 'var(--theme-accent)' : i === subIdx && !loop.completed ? 'var(--theme-accent)' : i < subIdx || loop.completed ? 'var(--theme-accent)' : 'var(--theme-bg-tertiary)',
            opacity: i === subIdx && !loop.completed ? 0.6 : 1,
            animation: i === subIdx && !loop.completed ? 'awu-loop-pulse 1.2s infinite' : 'none',
          }} />
        ))}
      </div>}
      <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
        {loop.error ? '❌ 失败' : manual ? (loop.completed ? '✓ 已交还 LOOP' : '✋ 人工接管中') : loop.completed ? '✓ 完成' : `${SUB_LABEL[loop.subStage] || loop.subStage}…`}
      </div>
      {loop.orchestration.length > 0 && !loop.completed && (
        <div style={{ fontSize: 10, color: 'var(--theme-text-muted)', marginTop: 3 }}>
          步骤 {loop.orchestration.filter((s) => s.status === 'done').length}/{loop.orchestration.length}
          {loop.orchestration.some((s) => s.status === 'running') && ' · 执行中'}
        </div>
      )}
      {loop.goal && <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loop.goal}</div>}
    </div>
  );
};

// 把编排步按「连续 concurrent 归并为一个并行组、sequential 各自成组」分组
function groupSteps(steps: LoopStep[]): LoopStep[][] {
  const groups: LoopStep[][] = [];
  let i = 0;
  while (i < steps.length) {
    if (steps[i].mode === 'concurrent' && steps[i].access === 'read') {
      const g: LoopStep[] = [];
      while (i < steps.length && steps[i].mode === 'concurrent' && steps[i].access === 'read') { g.push(steps[i]); i++; }
      groups.push(g);
    } else {
      groups.push([steps[i]]); i++;
    }
  }
  return groups;
}

const STEP_ICON: Record<string, string> = { pending: '○', running: '⏳', done: '✓', error: '✗' };
const STEP_COLOR: Record<string, string> = { pending: 'var(--theme-text-muted)', running: '#0969da', done: '#2da44e', error: '#f87171' };

const StepRow: React.FC<{ step: LoopStep; live?: string }> = ({ step, live }) => {
  const [open, setOpen] = useState(false);
  const body = step.status === 'running' && live ? live : step.output;
  const canExpand = !!body || step.status === 'running';
  const description = step.desc?.trim();
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        onClick={() => (canExpand ? setOpen(!open) : undefined)}
        style={{ display: 'flex', alignItems: 'baseline', gap: 6, cursor: canExpand ? 'pointer' : 'default' }}
      >
        <span style={{ color: STEP_COLOR[step.status] || 'var(--theme-text-muted)', fontSize: 13,
          animation: step.status === 'running' ? 'awu-loop-pulse 1.2s infinite' : 'none' }}>
          {STEP_ICON[step.status] || '○'}
        </span>
        <span style={{ fontSize: 11, color: STEP_COLOR[step.status], minWidth: 42 }}>{step.status}</span>
        <span style={{ fontSize: 13, color: description ? 'var(--theme-text)' : '#f59e0b', flex: 1 }}>
          {step.index}. {description || '步骤说明缺失（旧版本规划解析异常）'}
        </span>
        {!!step.attempts && step.attempts > 1 && (
          <span style={{ fontSize: 10.5, color: '#d29922', background: '#d2992218', border: '1px solid #d2992240', borderRadius: 999, padding: '1px 7px' }}>
            自动恢复 {step.attempts - 1} 次
          </span>
        )}
        {canExpand && <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{open ? '收起' : '展开'}</span>}
      </div>
      {!!step.recoveryNotes?.length && (
        <div style={{ marginLeft: 22, marginTop: 4, color: '#d29922', fontSize: 11, lineHeight: 1.45 }}>
          {step.recoveryNotes[step.recoveryNotes.length - 1]}
        </div>
      )}
      {open && (
        body && step.status === 'running'
          ? <div style={{ marginLeft: 22, marginTop: 4 }}><Live text={body} /></div>
          : body
            ? <div style={{ marginLeft: 22, marginTop: 4, background: 'var(--theme-code-bg)', borderRadius: 6, padding: '6px 10px' }}><Md text={body} /></div>
            : <div style={{ marginLeft: 22, marginTop: 4, color: 'var(--theme-text-muted)', fontSize: 11 }}>
                正在等待该步骤的新实时输出…
              </div>
      )}
    </div>
  );
};

const LoopDetail: React.FC<{ loop: LoopRecord; progress: Record<string, string>; onClose: () => void }> = ({ loop, progress, onClose }) => {
  const liveExec = progress[`${loop.seq}:execute`];
  const livePrep = progress[`${loop.seq}:prepare`];
  const liveAna = progress[`${loop.seq}:analysis`];
  const groups = groupSteps(loop.orchestration);
  if (loop.detailLoaded === false) {
    return (
      <div style={{ ...sealBox, marginTop: 4, color: 'var(--theme-text-muted)', fontSize: 12 }}>
        正在按需加载 Loop #{loop.seq} 详情…
      </div>
    );
  }
  if (loop.kind === 'manual') {
    return (
      <div style={{ ...sealBox, marginTop: 4, borderColor: '#d2992255' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#d29922' }}>✋ Manual LOOP #{loop.seq}</span>
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--theme-text-muted)' }}>
            {loop.completed ? '已交还 LOOP' : '人工接管中'}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={miniX}>✕</button>
        </div>
        <Section title="人工上下文与处理步骤">
          {loop.manualContext && (
            <details style={{ marginBottom: 10 }}>
              <summary style={{ cursor: 'pointer', color: '#d29922', fontSize: 12 }}>查看接管时的 LOOP 上下文快照</summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, color: 'var(--theme-text-muted)', maxHeight: 220, overflow: 'auto' }}>
                {loop.manualContext}
              </pre>
            </details>
          )}
          {(loop.manualMessages || []).length === 0 ? (
            <span style={{ color: 'var(--theme-text-muted)' }}>尚未发送人工指令。</span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {(loop.manualMessages || []).map((message) => (
                <div key={message.id} style={{
                  borderLeft: `3px solid ${message.role === 'user' ? '#d29922' : '#2da44e'}`,
                  padding: '7px 10px', borderRadius: 6, background: 'var(--theme-code-bg)',
                }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--theme-text-muted)', marginBottom: 4 }}>
                    {message.role === 'user' ? '人工指令' : '模型处理'}
                  </div>
                  {message.content ? <Md text={message.content} /> : <span style={{ color: 'var(--theme-text-muted)' }}>（无文本）</span>}
                  {!!message.toolCalls?.length && (
                    <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {message.toolCalls.map((tool, index) => (
                        <details key={`${tool.name}-${index}`}>
                          <summary style={{ cursor: 'pointer', fontSize: 11.5, color: '#58a6ff' }}>
                            ⚙ {tool.name} · {tool.status || 'done'}
                          </summary>
                          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10.5, color: 'var(--theme-text-muted)', margin: '5px 0 0' }}>
                            {[tool.input, tool.output, tool.error].filter(Boolean).join('\n\n')}
                          </pre>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    );
  }
  return (
    <div style={{ ...sealBox, marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text)' }}>Loop #{loop.seq} 详情</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={miniX}>✕</button>
      </div>

      <Section title="本次增量焦点">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: loop.evolutionBasis ? 6 : 0 }}>
          <Badge text={loop.iterationMode === 'evolution' ? '增量演进' : '基线核实'} color="#2563eb" />
          <div style={{ flex: 1 }}>{loop.goal ? <Md text={loop.goal} /> : '—'}</div>
        </div>
        {loop.evolutionBasis && (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--theme-text-muted)' }}>查看本次冻结的诊断与 Addon</summary>
            <div style={{ marginTop: 6, padding: '7px 9px', background: 'var(--theme-code-bg)', fontSize: 11 }}>
              <Md text={loop.evolutionBasis} />
            </div>
          </details>
        )}
      </Section>

      <Section title="编排与分步执行（点步可展开产出）" extra={(
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <BackendTag role="prepare" label={loop.backendLabels?.prepare} />
          <BackendTag role="execute" label={loop.backendLabels?.execute} />
        </span>
      )}>
        {loop.orchestration.length === 0 ? (livePrep ? <Live text={livePrep} /> : '—') : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {groups.map((g, gi) => g.length > 1 ? (
              // 并行组：左侧竖条 + 「并行」标识
              <div key={gi} style={{ borderLeft: '3px solid #8957e5', paddingLeft: 10, background: '#8957e50d', borderRadius: 6, padding: '6px 10px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#8957e5', marginBottom: 4 }}>⚡ 并行执行（{g.length} 步同时）</div>
                {g.map((s) => <StepRow key={s.index} step={s} live={progress[`${loop.seq}:step${s.index}`]} />)}
              </div>
            ) : (
              <div key={gi}><StepRow step={g[0]} live={progress[`${loop.seq}:step${g[0].index}`]} /></div>
            ))}
          </div>
        )}
      </Section>

      <Section title="本次执行结果" extra={<BackendTag role="execute" label={loop.backendLabels?.execute} />}>
        {loop.result ? <Md text={loop.result} />
          : liveExec ? <Live text={liveExec} /> : '—'}
      </Section>

      {loop.analysis ? (
        <Section title={`累计目标诊断 · 整体分数 ${loop.analysis.score.toFixed(0)}`}
          extra={<BackendTag role="analysis" label={loop.backendLabels?.analysis} />}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {loop.analysis.deliverable && <Badge text="可交付" color="#2da44e" />}
            {loop.analysis.outputtable && <Badge text="可输出" color="#8957e5" />}
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', alignSelf: 'center' }}>
              优化空间 {(loop.analysis.optimizationPotential * 100).toFixed(0)}% · 趋势 {loop.analysis.trend || '—'}
            </span>
          </div>
          {loop.analysis.verified && (
            <div style={{ marginBottom: 7, padding: '7px 9px', borderLeft: '3px solid #2da44e', background: '#2da44e0d' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#2da44e', marginBottom: 3 }}>已核实</div>
              <Md text={loop.analysis.verified} />
            </div>
          )}
          {loop.analysis.gaps && (
            <div style={{ marginBottom: 7, padding: '7px 9px', borderLeft: '3px solid #d29922', background: '#d299220d' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#bf8700', marginBottom: 3 }}>剩余缺口</div>
              <Md text={loop.analysis.gaps} />
            </div>
          )}
          {loop.analysis.nextFocus && (
            <div style={{ marginBottom: 7, padding: '7px 9px', borderLeft: '3px solid #2563eb', background: '#2563eb0d' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#2563eb', marginBottom: 3 }}>下一次优先焦点</div>
              <Md text={loop.analysis.nextFocus} />
            </div>
          )}
          {loop.analysis.notes && <Md text={loop.analysis.notes} />}
          {loop.analysis.challenges && <div style={{ fontSize: 12, color: '#bf8700', marginTop: 6 }}>⚠ 约束：{loop.analysis.challenges}</div>}
        </Section>
      ) : liveAna ? <Section title="累计目标诊断（进行中）"
          extra={<BackendTag role="analysis" label={loop.backendLabels?.analysis} />}><Live text={liveAna} /></Section> : null}

      {loop.error && <Section title="错误"><span style={{ color: '#f87171' }}>{loop.error}</span></Section>}
    </div>
  );
};

const Section: React.FC<{ title: string; extra?: React.ReactNode; children: React.ReactNode }> = ({ title, extra, children }) => (
  <div style={{ marginBottom: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{title}</div>
      {extra}
    </div>
    <div style={{ fontSize: 13, color: 'var(--theme-text)' }}>{children}</div>
  </div>
);

// 一个紧凑的 backend 选型标签：标出某阶段实际跑在哪个 backend（规划 / 执行 / 评审）
const BackendTag: React.FC<{ role: 'prepare' | 'execute' | 'analysis'; label?: string }> = ({ role, label }) => {
  if (!label) return null;
  const meta = role === 'analysis'
    ? { icon: '🔍', tip: '评审 backend / 模型', col: '#8957e5' }
    : role === 'prepare'
      ? { icon: '🧭', tip: '规划 backend / 模型', col: '#d29922' }
      : { icon: '⚙️', tip: '执行 backend / 模型', col: '#0969da' };
  return (
    <span title={`${meta.tip}：${label}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5,
      padding: '1px 7px', borderRadius: 999, lineHeight: 1.7, whiteSpace: 'nowrap',
      background: `${meta.col}14`, border: `1px solid ${meta.col}44`, color: meta.col,
    }}>{meta.icon}{label}</span>
  );
};

const Live: React.FC<{ text: string }> = ({ text }) => (
  <div style={{
    whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.5, fontFamily: 'monospace',
    color: 'var(--theme-text-muted)', maxHeight: 200, overflow: 'auto',
    background: 'var(--theme-code-bg)', borderRadius: 6, padding: 8,
  }}>{text}<span style={{ animation: 'awu-loop-pulse 1s infinite' }}>▋</span></div>
);

// markdown 渲染（复用全站 .md-content 样式 + markdownToHtml）
const Md: React.FC<{ text: string }> = ({ text }) => (
  <div className="md-content" style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--theme-text)' }}
    dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }} />
);

// ══ small bits ════════════════════════════════════════════════
const StatusDot: React.FC<{ status: string }> = ({ status }) => {
  const c = status === 'done' ? '#2da44e' : status === 'running' ? '#0969da' : status === 'error' ? '#f87171' : '#bf8700';
  return <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, animation: status === 'running' ? 'awu-loop-pulse 1.2s infinite' : 'none' }} />;
};

const ScoreRing: React.FC<{ score: number | null; pending: boolean }> = ({ score, pending }) => {
  if (score === null) {
    return <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{pending ? '…' : '—'}</span>;
  }
  const col = scoreColor(score);
  return (
    <div style={{
      width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 11, fontWeight: 700, color: col,
      background: `conic-gradient(${col} ${score * 3.6}deg, var(--theme-bg-tertiary) 0deg)`,
    }}>
      <div style={{ width: 23, height: 23, borderRadius: '50%', background: 'var(--theme-bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {score.toFixed(0)}
      </div>
    </div>
  );
};

function scoreColor(s: number): string {
  if (s >= 85) return '#8957e5';
  if (s >= 70) return '#2da44e';
  if (s >= 40) return '#bf8700';
  return '#f87171';
}
function riskColor(r: number): string {
  if (r >= 0.7) return '#f87171';
  if (r >= 0.4) return '#bf8700';
  return '#2da44e';
}

// ══ styles ════════════════════════════════════════════════════
const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1200,
  background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const shell: React.CSSProperties = {
  width: '92%', maxWidth: 1000, height: '88vh', display: 'flex', flexDirection: 'column',
  background: 'var(--theme-bg-secondary, #fff)', border: '1px solid var(--theme-border)',
  borderRadius: 14, overflow: 'hidden', boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
};
// 内嵌模式：填满所在 pane，无浮层 backdrop / 圆角 / 阴影
const embeddedShell: React.CSSProperties = {
  width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
  overflow: 'hidden', minHeight: 0,
  // ★ 不再全透明：给一层近实色磨砂底,保证密集内容在壁纸上可读
  background: 'var(--theme-panel-bg, var(--theme-bg))',
  backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
};
const btn: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)',
  color: 'var(--theme-text)', fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
};
const btnActive: React.CSSProperties = { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)', borderColor: 'var(--theme-accent)' };
const primaryBtn: React.CSSProperties = {
  background: 'var(--theme-accent)', border: 'none', color: '#fff',
  fontSize: 13, fontWeight: 600, padding: '8px 16px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
};
const inputBase: React.CSSProperties = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  color: 'var(--theme-text)', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit',
};
const metricBox: React.CSSProperties = {
  padding: 'var(--ui-space-sm, 8px) var(--ui-space-md, 14px)', borderRadius: 10, background: 'var(--theme-bg-secondary)',
  border: '1px solid var(--theme-border)', minWidth: 90,
};
const ideaCard: React.CSSProperties = {
  padding: 'var(--ui-section-padding, 12px)', borderRadius: 10, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)',
};
const sealBox: React.CSSProperties = {
  padding: 'var(--ui-section-padding, 14px)', borderRadius: 12, background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)',
};
const miniX: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer', fontSize: 12, padding: 2,
};
const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--theme-accent)', cursor: 'pointer', fontSize: 12, padding: 0,
};
// 视图切换分段按钮
const segBtn: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary)', border: 'none', color: 'var(--theme-text-muted)',
  fontSize: 12, padding: '4px 10px', cursor: 'pointer',
};
const segActive: React.CSSProperties = {
  background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)', fontWeight: 600,
};

// 注入脉冲 / 流程动画（一次性）
if (typeof document !== 'undefined' && !document.getElementById('awu-loop-css')) {
  const s = document.createElement('style');
  s.id = 'awu-loop-css';
  s.textContent = `
@keyframes awu-loop-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
@keyframes awu-flow-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(9,105,218,0.45); } 50% { box-shadow: 0 0 0 5px rgba(9,105,218,0); } }
@keyframes awu-flow-dash { to { background-position: 16px 0; } }
@keyframes awu-loop-fade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.awu-flow-dash { background-image: repeating-linear-gradient(90deg, var(--theme-accent) 0 8px, transparent 8px 16px); background-size: 16px 100%; animation: awu-flow-dash 0.55s linear infinite; }

/* ── 优雅交互层：统一过渡 / hover / 聚焦反馈（inline 样式不含 :hover，故此处生效）── */
.awu-loop button { transition: background-color .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease, transform .1s ease, opacity .16s ease; }
.awu-loop button:not(:disabled) { cursor: pointer; }
.awu-loop button:not(:disabled):hover { filter: brightness(1.07); }
.awu-loop button:not(:disabled):active { transform: translateY(1px) scale(0.985); }
.awu-loop button:disabled { cursor: default; }
.awu-loop textarea, .awu-loop input { transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease; }
.awu-loop textarea:focus, .awu-loop input:focus { border-color: var(--theme-accent) !important; box-shadow: 0 0 0 3px var(--theme-accent-bg); }
.awu-loop ::placeholder { color: var(--theme-text-muted); opacity: 0.7; }
/* 细滚动条，统一观感 */
.awu-loop *::-webkit-scrollbar { width: 9px; height: 9px; }
.awu-loop *::-webkit-scrollbar-thumb { background: var(--theme-border); border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
.awu-loop *::-webkit-scrollbar-thumb:hover { background: var(--theme-text-muted); background-clip: padding-box; }
.awu-loop *::-webkit-scrollbar-track { background: transparent; }
/* 卡片悬停轻微抬升（仅标了 awu-card 的） */
.awu-loop .awu-card { transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease; }
.awu-loop .awu-card:hover { border-color: var(--theme-accent); box-shadow: 0 4px 18px rgba(0,0,0,0.10); }
/* 折叠区域展开的淡入 */
.awu-loop .awu-reveal { animation: awu-loop-fade .2s ease both; }
`;
  document.head.appendChild(s);
}
