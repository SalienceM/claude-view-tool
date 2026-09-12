import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, getCurrentUserProfile, onExecStatus } from '../api';
import type {
  WorkspaceKitState,
  WorkspaceKit,
  KitRun,
  KitStepRun,
  KitCapabilityRuntime,
  KitInputSpec,
  KitAssertionSpec,
  KitOutputSpec,
  KitGenerationResult,
  KitGenerationJob,
  KitVersion,
  KitOptimizationMessage,
} from '../types/workspaceKits';

interface Props {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

type Draft = Omit<WorkspaceKit, 'id' | 'lastRunId' | 'createdAt' | 'updatedAt'> & { id?: string };
type View = 'kits' | 'data';

const EMPTY_STATE: WorkspaceKitState = {
  sessionId: '',
  kits: [],
  runs: [],
  artifacts: [],
  dataMarket: [],
  terminalConnectedKitIds: [],
};

const newDraft = (): Draft => ({
  title: '',
  description: '',
  objective: '',
  successCriteria: '',
  safetyConstraints: '',
  references: [],
  implementationSummary: '',
  generationWarnings: [],
  generatedByAi: false,
  executionTarget: 'executor',
  steps: [],
  command: '',
  shell: 'powershell',
  cwd: '.',
  timeoutSeconds: 300,
  inputs: [],
  assertions: [{ type: 'exit_code', expected: 0, label: '任务已完成并通过验证' }],
  outputs: [{ key: 'result', label: '运行结果', type: 'text', source: 'stdout' }],
  dependencies: [],
  schedule: { mode: 'manual', intervalSeconds: 300, nextRunAt: null },
  view: { default: 'summary', showLogs: true, showData: true, showTerminal: true },
  enabled: true,
  controlMode: 'shared',
});

const statusMeta: Record<string, { label: string; color: string }> = {
  queued: { label: '排队', color: '#8b949e' },
  running: { label: '执行中', color: '#d29922' },
  waiting_client: { label: '等待客户端', color: '#d2a8ff' },
  waiting_approval: { label: '等待确认', color: '#f0b429' },
  evaluating: { label: '验收中', color: '#58a6ff' },
  succeeded: { label: '成功', color: '#3fb950' },
  failed: { label: '失败', color: '#f85149' },
  error: { label: '异常', color: '#f85149' },
  cancelled: { label: '已停止', color: '#8b949e' },
};

function lastRunOf(state: WorkspaceKitState, kit: WorkspaceKit): KitRun | undefined {
  if (kit.lastRunId) {
    const exact = state.runs.find((run) => run.id === kit.lastRunId);
    if (exact) return exact;
  }
  return [...state.runs].reverse().find((run) => (run.canonicalKitId || run.kitId) === kit.id);
}

function asDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ''); }
}

function formatDuration(start?: number | null, end?: number | null, now = Date.now() / 1000): string {
  if (!start) return '—';
  const seconds = Math.max(0, (end || now) - start);
  if (seconds < 0.001) return '<1 ms';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const remain = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(remain).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function formatRunTime(at?: number | null): string {
  if (!at) return '尚未执行';
  return new Date(at * 1000).toLocaleString();
}

const generationStages = ['准备上下文', '模型生成', '解析定义', '安全校验', '完成'];

function generationPhaseIndex(phase?: string): number {
  if (['queued', 'preparing', 'context'].includes(phase || '')) return 0;
  if (['reasoning', 'generating', 'tool'].includes(phase || '')) return 1;
  if (phase === 'parsing') return 2;
  if (phase === 'validating') return 3;
  if (['succeeded', 'needs_input', 'error', 'cancelled'].includes(phase || '')) return 4;
  return 0;
}

function generationPhaseLabel(phase?: string): string {
  const labels: Record<string, string> = {
    queued: '等待执行端接收任务',
    preparing: '正在准备编译任务',
    context: '正在读取 Session 上下文与相关文件',
    reasoning: '模型正在分析实现路径',
    generating: '模型正在生成 Kit 定义',
    tool: '模型正在调用工具检查工作区',
    parsing: '正在解析模型返回的 Kit 定义',
    validating: '正在执行安全与验收校验',
    succeeded: '编译完成',
    needs_input: '需要补充信息',
    error: '编译失败',
    cancelled: '编译已停止',
  };
  return labels[phase || ''] || '正在处理';
}

function generationActivityIcon(type?: string): string {
  if (type === 'tool_start') return '↗';
  if (type === 'tool_result') return '↙';
  if (type?.startsWith('subagent')) return '◇';
  if (type === 'error') return '!';
  if (type === 'result') return '✓';
  if (type === 'cancelled') return '■';
  return '●';
}

function formatActivityAge(at?: number | null, now = Date.now() / 1000): string {
  if (!at) return '尚未收到事件';
  const seconds = Math.max(0, Math.floor(now - at));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return new Date(at * 1000).toLocaleTimeString();
}

function defaultInputsOf(kit: WorkspaceKit): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  kit.inputs.forEach((spec) => {
    if (spec.type !== 'secret' && spec.default !== undefined) defaults[spec.key] = spec.default;
  });
  return defaults;
}

function isActiveRun(run?: KitRun): boolean {
  return !!run && ['queued', 'running', 'waiting_client', 'waiting_approval', 'evaluating'].includes(run.status);
}

function isActiveGeneration(job?: KitGenerationJob | null): boolean {
  return !!job && (job.status === 'queued' || job.status === 'running');
}

function generationDismissKey(sessionId: string): string {
  return `agent-with-u:kits:dismissed-generation:${sessionId}`;
}

function readDismissedGeneration(sessionId: string): string {
  try { return window.localStorage.getItem(generationDismissKey(sessionId)) || ''; }
  catch { return ''; }
}

function persistDismissedGeneration(sessionId: string, jobId: string): void {
  try {
    if (jobId) window.localStorage.setItem(generationDismissKey(sessionId), jobId);
    else window.localStorage.removeItem(generationDismissKey(sessionId));
  } catch { /* 隐私模式或受限 WebView 下仍允许本次关闭 */ }
}

type OptimizerDraft = { prompt: string; backendId?: string };
const optimizerDraftFallback = new Map<string, OptimizerDraft>();
function readOptimizerDraft(key: string): OptimizerDraft {
  try {
    const draft = JSON.parse(window.sessionStorage.getItem(key) || 'null');
    if (draft && typeof draft.prompt === 'string') return draft;
  } catch { /* 限制存储时退回本窗口内存，不阻塞编辑。 */ }
  return optimizerDraftFallback.get(key) || { prompt: '' };
}
function writeOptimizerDraft(key: string, draft: OptimizerDraft): void {
  optimizerDraftFallback.set(key, draft);
  if (optimizerDraftFallback.size > 100) optimizerDraftFallback.delete(optimizerDraftFallback.keys().next().value!);
  try { window.sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* 仍保留内存草稿。 */ }
}

function draftFromGenerationJob(job: KitGenerationJob): Draft {
  const existing = job.request.existingKit || {};
  const base: Draft = {
    ...newDraft(),
    ...existing,
    objective: job.request.objective || existing.objective || '',
    successCriteria: job.request.successCriteria || existing.successCriteria || '',
    safetyConstraints: job.request.safetyConstraints || existing.safetyConstraints || '',
    references: job.request.references || existing.references || [],
    id: existing.id,
  };
  if (!job.result?.kit) return base;
  const {
    lastRunId: _lastRunId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...compiled
  } = job.result.kit;
  // 新建预览里的临时 id 不能被当作已有 Kit；重编译则保留原 Kit id。
  return { ...newDraft(), ...compiled, id: existing.id };
}

function normalizeKitState(sessionId: string, next: Partial<WorkspaceKitState>): WorkspaceKitState {
  return {
    sessionId,
    kits: (next.kits || []).map((kit) => ({
      ...kit,
      executionTarget: kit.executionTarget || 'executor',
      steps: kit.steps || [],
      versions: kit.versions || [],
      optimizationMessages: kit.optimizationMessages || [],
    })),
    runs: (next.runs || []).map((run) => ({
      ...run,
      steps: run.steps || [],
      currentStep: run.currentStep || 0,
    })),
    artifacts: next.artifacts || [],
    dataMarket: next.dataMarket || [],
    terminalConnectedKitIds: next.terminalConnectedKitIds || [],
    createdAt: next.createdAt,
    updatedAt: next.updatedAt,
  };
}

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 5 }}>{children}</div>
);

export const WorkspaceKitsPanel: React.FC<Props> = ({ sessionId, open, onClose }) => {
  const [state, setState] = useState<WorkspaceKitState>({ ...EMPTY_STATE, sessionId });
  const [selectedId, setSelectedId] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [optimizerKitId, setOptimizerKitId] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [view, setView] = useState<View>('kits');
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [terminalCommand, setTerminalCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancellingRunIds, setCancellingRunIds] = useState<Set<string>>(() => new Set());
  const [capabilityResponding, setCapabilityResponding] = useState('');
  const [notice, setNotice] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [generationJob, setGenerationJob] = useState<KitGenerationJob | null>(null);
  const [dismissedGenerationJobId, setDismissedGenerationJobId] = useState(
    () => readDismissedGeneration(sessionId),
  );
  const [generationEditorJobId, setGenerationEditorJobId] = useState('');
  const [clock, setClock] = useState(() => Date.now() / 1000);
  const clientClaims = useRef(new Set<string>());
  const clientCommandRuns = useRef(new Set<string>());

  const acceptGenerationJob = (incoming: KitGenerationJob) => {
    const dismissed = readDismissedGeneration(incoming.sessionId);
    // 只压住用户明确关闭的那一条最终结果。新任务（包括同 id 重新进入活动态）
    // 必须重新出现，以免把真实后台执行悄悄隐藏。
    if (dismissed && (dismissed !== incoming.id || isActiveGeneration(incoming))) {
      persistDismissedGeneration(incoming.sessionId, '');
      setDismissedGenerationJobId('');
    } else if (dismissed === incoming.id) {
      setDismissedGenerationJobId(dismissed);
    }
    setGenerationJob((current) => {
      if (!current || current.sessionId !== incoming.sessionId) return incoming;
      if (current.id === incoming.id) {
        return current.updatedAt > incoming.updatedAt ? current : incoming;
      }
      return current.createdAt > incoming.createdAt ? current : incoming;
    });
  };

  useEffect(() => {
    let cancelled = false;
    if (open) {
      api.kitGetState(sessionId).then((result) => {
        if (cancelled || result.status !== 'ok') {
          if (!cancelled && result.message) setNotice({ kind: 'error', text: result.message });
          return;
        }
        const next = result as WorkspaceKitState & { status: string };
        setState(normalizeKitState(sessionId, next));
        setSelectedId((current) => current || next.kits?.[0]?.id || '');
      });
    }
    // 即便面板被收起也保留轻量状态订阅：客户端命令可能仍在执行，另一个
    // 窗口发出的停止必须能抵达真正持有本地进程的桌面端。
    const off = api.onKitUpdated((next) => {
      for (const runId of clientCommandRuns.current) {
        const live = next.runs.find((run) => run.id === runId);
        if (live && !isActiveRun(live)) {
          void api.kitClientLocalCommandCancel(runId).catch(() => {});
        }
      }
      if (next.sessionId !== sessionId) return;
      setState(normalizeKitState(sessionId, next));
      setSelectedId((current) => current || next.kits[0]?.id || '');
    });
    return () => { cancelled = true; off(); };
  }, [open, sessionId]);

  useEffect(() => {
    let cancelled = false;
    if (open) {
      void api.kitGenerationGet(sessionId).then((result) => {
        if (cancelled) return;
        if (result.status === 'ok') {
          if (result.job) acceptGenerationJob(result.job);
          else setGenerationJob((current) => current?.sessionId === sessionId ? current : null);
        } else if (result.message) {
          setNotice({ kind: 'error', text: result.message });
        }
      });
    }
    const off = api.onKitGenerationUpdated((job) => {
      if (job.sessionId === sessionId) acceptGenerationJob(job);
    });
    return () => { cancelled = true; off(); };
  }, [open, sessionId]);

  useEffect(() => {
    setState({ ...EMPTY_STATE, sessionId });
    setSelectedId('');
    setDetailOpen(false);
    setOptimizerKitId('');
    setDraft(null);
    setInputs({});
    setCancellingRunIds(new Set());
    setCapabilityResponding('');
    setGenerationJob(null);
    setDismissedGenerationJobId(readDismissedGeneration(sessionId));
    setGenerationEditorJobId('');
    setNotice(null);
  }, [sessionId]);

  useEffect(() => {
    if (!open || (!state.runs.some(isActiveRun) && !isActiveGeneration(generationJob))) return;
    setClock(Date.now() / 1000);
    const timer = window.setInterval(() => setClock(Date.now() / 1000), 250);
    return () => window.clearInterval(timer);
  }, [open, state.runs, generationJob?.status]);

  useEffect(() => {
    if (!open) return;
    const waitingKeys = new Set<string>();
    for (const run of state.runs) {
      if (run.status !== 'waiting_client') continue;
      const step = run.steps?.[run.currentStep];
      if (!step || !['waiting_client', 'running'].includes(step.status)) continue;
      const key = `${run.id}:${step.id}`;
      waitingKeys.add(key);
      if (clientClaims.current.has(key)) continue;
      clientClaims.current.add(key);
      void (async () => {
        try {
          const resumed = await api.kitResume(sessionId, run.id);
          if (resumed.status !== 'ok') throw new Error(resumed.message || '无法恢复 Kit 编排');
          const resumedStep = resumed.run?.steps?.[resumed.run.currentStep] || step;
          // 后端任务仍存活且步骤正被别的窗口执行：只观察，不抢占。若租约
          // 过期，后端会重新发 waiting_client 状态并触发下一次领取。
          if (resumedStep.status !== 'waiting_client') {
            clientClaims.current.delete(key);
            return;
          }
          if (resumedStep.type === 'command') {
            const claimed = await api.kitClientStepStart(sessionId, run.id, resumedStep.id);
            if (claimed.status !== 'ok') {
              if (claimed.status !== 'busy') throw new Error(claimed.message || '无法领取客户端步骤');
              clientClaims.current.delete(key);
              return;
            }
            const active = claimed.step || resumedStep;
            clientCommandRuns.current.add(run.id);
            try {
              const result = await api.kitClientLocalCommand({
                runId: run.id,
                shell: active.shell,
                command: active.command,
                cwd: active.cwd,
                timeoutSeconds: active.timeoutSeconds,
                env: active.config?.env || {},
              });
              const completed = await api.kitClientStepComplete(sessionId, run.id, resumedStep.id, result);
              if (completed.status !== 'ok') throw new Error(completed.message || '客户端命令回执失败');
            } catch (error) {
              await api.kitClientStepComplete(sessionId, run.id, resumedStep.id, {
                error: error instanceof Error ? error.message : String(error),
              });
            } finally {
              clientCommandRuns.current.delete(run.id);
            }
            return;
          }
          if (resumedStep.type === 'file_push') {
            const source = String(resumedStep.config?.source || '');
            if (!source) throw new Error('文件推送缺少客户端源路径');
            const info = await api.kitClientLocalFileInfo(source);
            const transferId = `kit_${crypto.randomUUID().replace(/-/g, '_')}`;
            const started = await api.kitClientFileStart(
              sessionId, run.id, resumedStep.id, transferId, info.size, info.sha256,
            );
            if (started.status !== 'ok') {
              if ((started.message || '').includes('已被其他')) return;
              throw new Error(started.message || '无法开始文件推送');
            }
            const chunkSize = 512 * 1024;
            for (let offset = 0; offset < info.size; offset += chunkSize) {
              const data = await api.kitClientLocalFileChunk(
                source, offset, Math.min(chunkSize, info.size - offset),
              );
              const pushed = await api.kitClientFileChunk(
                sessionId, run.id, resumedStep.id, transferId, offset, data,
              );
              if (pushed.status !== 'ok') throw new Error(pushed.message || '文件分块推送失败');
            }
            const finished = await api.kitClientFileFinish(sessionId, run.id, resumedStep.id, transferId);
            if (finished.status !== 'ok') throw new Error(finished.message || '文件推送验收失败');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await api.kitClientStepComplete(sessionId, run.id, step.id, { error: message });
          setNotice({ kind: 'error', text: `客户端步骤失败：${message}` });
        }
      })();
    }
    for (const key of clientClaims.current) {
      if (!waitingKeys.has(key)) clientClaims.current.delete(key);
    }
  }, [open, sessionId, state.runs]);

  useEffect(() => {
    // 停止可能由另一个窗口发起。权威状态一旦结束，真正执行客户端命令的
    // 桌面端也必须关闭其本地进程树，不能只让后端记录变灰。
    for (const runId of clientCommandRuns.current) {
      const live = state.runs.find((run) => run.id === runId);
      if (!live || !isActiveRun(live)) {
        void api.kitClientLocalCommandCancel(runId).catch(() => {});
      }
    }
  }, [sessionId, state.runs]);

  const selected = state.kits.find((kit) => kit.id === selectedId);
  const optimizerKit = state.kits.find((kit) => kit.id === optimizerKitId);
  const lastRun = selected ? lastRunOf(state, selected) : undefined;
  const selectedRuns = useMemo(
    () => state.runs.filter((run) => (run.canonicalKitId || run.kitId) === selectedId).slice(-12).reverse(),
    [state.runs, selectedId],
  );

  useEffect(() => {
    if (!selected) { setInputs({}); return; }
    setInputs(defaultInputsOf(selected));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const showGeneration = () => {
    if (!generationJob) return;
    setDraft(draftFromGenerationJob(generationJob));
    setGenerationEditorJobId(generationJob.id);
    setSelectedId(generationJob.request.existingKit?.id || '');
    setDetailOpen(true);
    setView('kits');
  };

  const cancelGeneration = async () => {
    if (!generationJob || !isActiveGeneration(generationJob)) return;
    const result = await api.kitGenerateCancel(sessionId, generationJob.id);
    if (result.job) acceptGenerationJob(result.job);
    if (result.status !== 'ok') {
      setNotice({ kind: 'error', text: result.message || '停止 Kit 生成失败' });
    }
  };

  const dismissGeneration = () => {
    if (!generationJob || isActiveGeneration(generationJob)) return;
    persistDismissedGeneration(sessionId, generationJob.id);
    setDismissedGenerationJobId(generationJob.id);
  };

  if (!open) return null;

  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    setNotice(null);
    const result = draft.id
      ? await api.kitUpdate(sessionId, draft.id, draft)
      : await api.kitCreate(sessionId, draft);
    setBusy(false);
    if (result.status !== 'ok') {
      setNotice({ kind: 'error', text: result.message || '保存失败' });
      return;
    }
    if (result.kit) setSelectedId(result.kit.id);
    setDraft(null);
    setGenerationEditorJobId('');
    setDetailOpen(true);
    setNotice({ kind: 'ok', text: 'Kit 已保存' });
  };

  const runKit = async (kit: WorkspaceKit, runInputs: Record<string, unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.kitRun(sessionId, kit.id, runInputs);
      if (result.status !== 'ok') {
        setNotice({ kind: 'error', text: result.message || '启动失败' });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: `启动失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      // Secret 只为这一轮 RPC 短暂驻留在页面内存；无论启动是否成功都立即清空。
      const secretKeys = new Set(kit.inputs.filter((spec) => spec.type === 'secret').map((spec) => spec.key));
      if (secretKeys.size > 0) {
        setInputs((current) => Object.fromEntries(
          Object.entries(current).filter(([key]) => !secretKeys.has(key)),
        ));
      }
      setBusy(false);
    }
  };

  const cancelRun = async (runId: string) => {
    if (cancellingRunIds.has(runId)) return;
    setCancellingRunIds((current) => new Set(current).add(runId));
    setNotice(null);
    // 两端并行清理：当前窗口若正代执行 client command，立即终止本地进程；
    // 执行端同时落盘 cancelled 并停止 executor 进程/编排 Task。
    const localCancel = api.kitClientLocalCommandCancel(runId).catch(() => false);
    try {
      const result = await api.kitCancel(sessionId, runId);
      await localCancel;
      if (result.status !== 'ok') {
        setNotice({ kind: 'error', text: result.message || '停止失败，请重试' });
        return;
      }
      if (result.run) {
        setState((current) => ({
          ...current,
          runs: current.runs.map((run) => run.id === runId ? result.run! : run),
        }));
      }
      setNotice({ kind: 'ok', text: 'Kit 已停止' });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: `停止失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setCancellingRunIds((current) => {
        const next = new Set(current);
        next.delete(runId);
        return next;
      });
    }
  };

  const respondCapability = async (runId: string, stepId: string, approved: boolean) => {
    const key = `${runId}:${stepId}`;
    if (capabilityResponding) return;
    if (approved && !window.confirm(
      '确认按当前冻结计划正式发布？确认后会上传制品并切换 channel manifest。',
    )) return;
    setCapabilityResponding(key);
    setNotice(null);
    try {
      const result = await api.kitCapabilityRespond(sessionId, runId, stepId, approved);
      if (result.status !== 'ok') {
        setNotice({ kind: 'error', text: result.message || '能力确认失败' });
        return;
      }
      if (result.run) {
        setState((current) => ({
          ...current,
          runs: current.runs.map((item) => item.id === runId ? result.run! : item),
        }));
      }
      setNotice({
        kind: 'ok',
        text: approved ? '已确认，发布中心正在执行冻结计划' : '已拒绝，没有开始正式发布',
      });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: `能力确认失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setCapabilityResponding('');
    }
  };

  const quickRunKit = async (kit: WorkspaceKit) => {
    const defaults = defaultInputsOf(kit);
    const missingRequired = kit.inputs.some((spec) => (
      !!spec.required && defaults[spec.key] === undefined && !spec.sourceKey
    ));
    if (missingRequired) {
      setSelectedId(kit.id);
      setInputs(defaults);
      setDraft(null);
      setDetailOpen(true);
      setNotice({ kind: 'error', text: '这个 Kit 需要输入；已为你展开运行面板。' });
      return;
    }
    await runKit(kit, defaults);
  };

  const terminalRun = async () => {
    if (!selected || !terminalCommand.trim()) return;
    setBusy(true);
    const result = await api.kitTerminalCommand(sessionId, selected.id, terminalCommand);
    setBusy(false);
    if (result.status === 'ok') {
      setTerminalCommand('');
    } else {
      setNotice({ kind: 'error', text: result.message || '终端命令启动失败' });
    }
  };

  const deleteKit = async () => {
    if (!selected || !window.confirm(`删除 Kit「${selected.title}」？运行历史和已发布数据会保留。`)) return;
    const result = await api.kitDelete(sessionId, selected.id);
    if (result.status !== 'ok') {
      setNotice({ kind: 'error', text: result.message || '删除失败' });
      return;
    }
    setSelectedId(state.kits.find((item) => item.id !== selected.id)?.id || '');
  };

  return (
    <div className="awu-kits-overlay" style={overlayStyle}>
      <style>{`
        @media (max-width: 680px) {
          .awu-kits-overlay { position: fixed !important; z-index: 1400 !important; }
          .awu-kits-panel { width: 100% !important; max-width: 100vw; background: var(--theme-panel-solid, #161b22) !important; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); box-sizing: border-box; }
          .awu-kits-header { flex-direction: column; align-items: stretch !important; gap: 8px !important; padding: 10px 12px !important; flex-shrink: 0; }
          .awu-kits-header-actions { flex-wrap: wrap; align-items: center; }
          .awu-kits-header-actions button { white-space: nowrap; min-height: 40px; flex-shrink: 0; }
          .awu-kits-header-actions button:last-child { margin-left: auto; min-width: 40px; }
          .awu-kits-detail-sidebar { display: none; }
          .awu-kits-panel button { min-height: 36px; }
          .awu-kits-panel input, .awu-kits-panel textarea, .awu-kits-panel select { max-width: 100%; box-sizing: border-box; font-size: 16px !important; }
          .awu-kits-panel { overflow-wrap: anywhere; --awu-kit-columns: minmax(0, 1fr); }
          .awu-kit-detail-heading { flex-direction: column; }
          .awu-kit-detail-badges, .awu-kits-list-toolbar { flex-wrap: wrap; }
          .awu-kit-detail-actions { justify-content: flex-start !important; }
          .awu-kit-optimizer-header { flex-direction: column; align-items: stretch !important; gap: 8px !important; padding: 10px 12px !important; flex-shrink: 0; }
          .awu-kit-optimizer-heading { flex-wrap: wrap; }
          .awu-kit-optimizer-heading > span { white-space: nowrap; }
          .awu-kit-optimizer-actions select { flex: 1; width: 0 !important; min-width: 0; }
          .awu-kit-optimizer-actions button { flex-shrink: 0; min-width: 40px; }
          .awu-kit-optimizer-version-bar { flex-wrap: wrap; flex-shrink: 0; gap: 6px !important; }
          .awu-kit-optimizer-composer { flex-direction: column; align-items: stretch !important; flex-shrink: 0; }
          .awu-kit-optimizer-composer button { white-space: nowrap; }
        }
      `}</style>
      <div className="awu-kits-panel" style={panelStyle} onMouseDown={(event) => event.stopPropagation()}>
        <header className="awu-kits-header" style={headerStyle}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>🧰 Workspace Kits</strong>
              <span style={experimentBadge}>实验</span>
            </div>
            <div style={subtleStyle}>这个 Session 的标准配件、判言、视图窗与数据依赖</div>
          </div>
          <div className="awu-kits-header-actions" style={{ display: 'flex', gap: 6 }}>
            {view === 'kits' && (detailOpen || draft) && (
              <button style={secondaryButton} onClick={() => { setDraft(null); setDetailOpen(false); }}>
                ← 返回列表
              </button>
            )}
            <button style={tabButton(view === 'kits')} onClick={() => setView('kits')}>配件</button>
            <button style={tabButton(view === 'data')} onClick={() => setView('data')}>
              数据市场 {state.dataMarket.length ? `· ${state.dataMarket.length}` : ''}
            </button>
            <button style={iconButton} onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        {notice && (
          <div style={{
            padding: '7px 12px', fontSize: 12,
            color: notice.kind === 'error' ? '#ff7b72' : '#56d364',
            background: notice.kind === 'error' ? 'rgba(248,81,73,.08)' : 'rgba(63,185,80,.08)',
          }}>{notice.text}</div>
        )}

        {generationJob && generationJob.id !== dismissedGenerationJobId && (
          <div style={{
            padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 10,
            flexWrap: 'wrap', fontSize: 12,
            color: generationJob.status === 'error' ? '#ff7b72'
              : generationJob.status === 'succeeded' ? '#56d364' : '#e3b341',
            background: generationJob.status === 'error' ? 'rgba(248,81,73,.08)'
              : generationJob.status === 'succeeded' ? 'rgba(63,185,80,.08)' : 'rgba(210,153,34,.09)',
            borderBottom: '1px solid var(--theme-border)',
          }}>
            <span aria-hidden="true">{isActiveGeneration(generationJob) ? '⏳' : generationJob.status === 'succeeded' ? '✓' : '⚠'}</span>
            <span style={{ flex: 1, minWidth: 180 }}>
              <strong>{isActiveGeneration(generationJob) ? '标准 Kit 正在后台生成' : '标准 Kit 生成任务已有结果'}</strong>
              {' · '}{generationPhaseLabel(generationJob.phase || generationJob.status)}
              {generationJob.outputChars ? ` · 已输出 ${generationJob.outputChars.toLocaleString()} 字符` : ''}
              {generationJob.startedAt && <> · {formatDuration(generationJob.startedAt, generationJob.endedAt, clock)}</>}
              {isActiveGeneration(generationJob) && generationJob.lastActivityAt && (
                <> · 最近活动 {formatActivityAge(generationJob.lastActivityAt, clock)}</>
              )}
              {isActiveGeneration(generationJob) && <span style={{ color: 'var(--theme-text-muted)' }}> · 可切换 Session，不会中断</span>}
            </span>
            <button style={secondaryButton} onClick={showGeneration}>
              {isActiveGeneration(generationJob) ? '查看实时输出' : '查看结果'}
            </button>
            {isActiveGeneration(generationJob) && (
              <button style={dangerButton} onClick={() => void cancelGeneration()}>■ 停止</button>
            )}
            {!isActiveGeneration(generationJob) && (
              <button
                style={{ ...iconButton, width: 28, height: 28, flex: '0 0 auto' }}
                onClick={dismissGeneration}
                aria-label="关闭 Kit 生成结果提示"
                title="关闭提示；不会删除生成结果或已保存的 Kit"
              >×</button>
            )}
          </div>
        )}

        {view === 'data' ? (
          <DataMarket state={state} />
        ) : !detailOpen && !draft ? (
          <div style={compactListStyle}>
            <div className="awu-kits-list-toolbar" style={compactListToolbar}>
              <div>
                <div style={sectionTitle}>Kits</div>
                <div style={subtleStyle}>直接运行；需要输入或审计实现时再展开详情。</div>
              </div>
              <button style={primaryButton} onClick={() => {
                setGenerationEditorJobId(''); setDraft(newDraft()); setDetailOpen(true);
              }}>
                ＋ 新建 Kit
              </button>
            </div>
            {state.kits.length === 0 ? (
              <div style={emptyMainStyle}>暂无配件。创建一个，把重复工作变成可验收的一键组件。</div>
            ) : (
              <div style={compactKitGrid}>
                {state.kits.map((kit) => {
                  const run = lastRunOf(state, kit);
                  const meta = run ? statusMeta[run.status] : null;
                  const running = isActiveRun(run);
                  const stepCount = run?.steps?.length || kit.steps.length || 1;
                  const lastRunAt = run?.endedAt || run?.startedAt || run?.createdAt;
                  return (
                    <article key={kit.id} style={compactKitCard}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <span style={{
                          width: 9, height: 9, marginTop: 5, flex: '0 0 auto', borderRadius: '50%',
                          background: meta?.color || '#6e7681',
                          boxShadow: running ? `0 0 9px ${meta?.color}` : 'none',
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                            <strong title={kit.title} style={{
                              flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden',
                              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>{kit.title}</strong>
                            {meta && <span style={{ ...statusPill, color: meta.color, borderColor: `${meta.color}66` }}>● {meta.label}</span>}
                            {!kit.enabled && <span style={mutedPill}>停用</span>}
                          </div>
                          <div title={kit.description || kit.objective || '标准化 Session 配件'} style={{
                            ...subtleStyle, marginTop: 6, lineHeight: 1.5, minHeight: 33,
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}>
                            {kit.description || kit.objective || '标准化 Session 配件'}
                          </div>
                          <div style={{ ...subtleStyle, display: 'flex', gap: 12, marginTop: 9, flexWrap: 'wrap' }}>
                            <span>{stepCount} 个原子步</span>
                            <span>{kit.executionTarget === 'client' ? '客户端' : '执行端默认'}</span>
                            <span>{kit.schedule.mode === 'interval' ? `每 ${kit.schedule.intervalSeconds}s` : '手动'}</span>
                            {run && <span>耗时 {formatDuration(run.startedAt, run.endedAt, clock)}</span>}
                          </div>
                          <div style={{ ...subtleStyle, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
                            最后执行：{formatRunTime(lastRunAt)}
                          </div>
                        </div>
                      </div>
                      <div style={compactKitFooter}>
                        <KitVersionPicker
                          sessionId={sessionId}
                          kit={kit}
                          running={running}
                          compact
                          onFeedback={(text, kind) => setNotice({ kind, text })}
                        />
                        <div style={compactKitActions}>
                          <button style={secondaryButton} onClick={() => setOptimizerKitId(kit.id)}>✨ 优化</button>
                          <button style={secondaryButton} onClick={() => {
                            setSelectedId(kit.id); setInputs(defaultInputsOf(kit)); setDraft(null); setDetailOpen(true);
                          }}>详情</button>
                          {running && run ? (
                            <button style={dangerButton} disabled={cancellingRunIds.has(run.id)}
                              onClick={() => void cancelRun(run.id)}>
                              {cancellingRunIds.has(run.id) ? '停止中…' : '■ 停止'}
                            </button>
                          ) : (
                            <button style={primaryButton} disabled={busy || !kit.enabled}
                              onClick={() => quickRunKit(kit)}>▶ 运行</button>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div style={bodyStyle}>
            <aside className="awu-kits-detail-sidebar" style={sidebarStyle}>
              <button
                style={{ ...primaryButton, width: '100%', marginBottom: 10 }}
                onClick={() => { setGenerationEditorJobId(''); setDraft(newDraft()); setDetailOpen(true); }}
              >＋ 新建 Kit</button>
              {state.kits.length === 0 && (
                <div style={{ ...subtleStyle, padding: '18px 8px', textAlign: 'center' }}>
                  暂无配件。创建一个，把重复工作变成可验收的标准组件。
                </div>
              )}
              {state.kits.map((kit) => {
                const run = lastRunOf(state, kit);
                const meta = run ? statusMeta[run.status] : null;
                return (
                  <button
                    key={kit.id}
                    onClick={() => { setSelectedId(kit.id); setDraft(null); setDetailOpen(true); }}
                    style={{
                      ...kitListButton,
                      borderColor: selectedId === kit.id ? 'var(--theme-accent, #58a6ff)' : 'transparent',
                      background: selectedId === kit.id ? 'rgba(88,166,255,.10)' : 'transparent',
                    }}
                  >
                    <span style={{
                      width: 8, height: 8, flex: '0 0 auto', borderRadius: '50%',
                      background: meta?.color || '#6e7681',
                      boxShadow: ['running', 'waiting_client', 'waiting_approval', 'evaluating'].includes(run?.status || '') ? `0 0 8px ${meta?.color}` : 'none',
                    }} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{kit.title}</span>
                      <span style={{ ...subtleStyle, display: 'block', marginTop: 2 }}>
                        {kit.schedule.mode === 'interval' ? `每 ${kit.schedule.intervalSeconds}s` : '手动'}
                        {meta ? ` · ${meta.label}` : ''}
                      </span>
                    </span>
                  </button>
                );
              })}
            </aside>

            <main style={mainStyle}>
              {draft ? (
                <KitEditor sessionId={sessionId} draft={draft} onChange={setDraft} onSave={saveDraft}
                  onCancel={() => { setDraft(null); setGenerationEditorJobId(''); }} busy={busy}
                  generationJob={generationJob?.id === generationEditorJobId ? generationJob : null}
                  onGenerationJob={(job) => { acceptGenerationJob(job); setGenerationEditorJobId(job.id); }}
                  onCancelGeneration={cancelGeneration} now={clock} />
              ) : selected ? (
                <KitDetail
                  sessionId={sessionId}
                  kit={selected}
                  run={lastRun}
                  runs={selectedRuns}
                  inputs={inputs}
                  onInputsChange={setInputs}
                  onRun={() => runKit(selected, inputs)}
                  onCancel={(runId) => void cancelRun(runId)}
                  onEdit={() => { setGenerationEditorJobId(''); setDraft({ ...selected }); }}
                  onDelete={deleteKit}
                  onToggleEnabled={() => api.kitUpdate(sessionId, selected.id, { enabled: !selected.enabled })}
                  onControlMode={(mode) => api.kitSetControlMode(sessionId, selected.id, mode)}
                  terminalCommand={terminalCommand}
                  onTerminalCommand={setTerminalCommand}
                  onTerminalRun={terminalRun}
                  terminalConnected={state.terminalConnectedKitIds?.includes(selected.id) || false}
                  onTerminalClose={() => api.kitTerminalClose(sessionId, selected.id)}
                  busy={busy}
                  cancelling={!!lastRun && cancellingRunIds.has(lastRun.id)}
                  dataMarket={state.dataMarket}
                  now={clock}
                  onOptimize={() => setOptimizerKitId(selected.id)}
                  capabilityResponding={capabilityResponding}
                  onCapabilityRespond={(runId, stepId, approved) => void respondCapability(runId, stepId, approved)}
                />
              ) : (
                <div style={emptyMainStyle}>选择或创建一个 Kit</div>
              )}
            </main>
          </div>
        )}
      </div>
      {optimizerKit && (
        <KitOptimizerPanel
          key={`${getCurrentUserProfile().userId}:${sessionId}:${optimizerKit.id}`}
          sessionId={sessionId}
          kit={optimizerKit}
          running={isActiveRun(lastRunOf(state, optimizerKit))}
          onClose={() => setOptimizerKitId('')}
        />
      )}
    </div>
  );
};

const KitGenerationProgress: React.FC<{
  job: KitGenerationJob;
  now: number;
  onCancel: () => void;
}> = ({ job, now, onCancel }) => {
  const outputRef = useRef<HTMLPreElement | null>(null);
  const [followOutput, setFollowOutput] = useState(true);
  const phaseIndex = generationPhaseIndex(job.phase || job.status);
  const activities = [...(job.activities || [])].reverse().slice(0, 16);
  const lastEventAt = job.lastActivityAt || job.updatedAt || job.startedAt || job.createdAt;
  const inactiveSeconds = Math.max(0, now - lastEventAt);
  const stalled = isActiveGeneration(job) && inactiveSeconds >= 45;

  useEffect(() => {
    if (!followOutput || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [job.outputChars, job.outputPreview, followOutput]);

  return (
    <section style={{
      ...cardStyle, padding: 16, borderColor: stalled ? 'rgba(248,81,73,.5)' : 'rgba(88,166,255,.5)',
      background: 'linear-gradient(145deg, rgba(88,166,255,.09), rgba(210,168,255,.035))',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#79c0ff', fontSize: 11, fontWeight: 700, letterSpacing: '.08em' }}>
            AI KIT COMPILER · {isActiveGeneration(job) ? 'LIVE' : 'TRACE'}
          </div>
          <div style={{ marginTop: 5, fontSize: 18, fontWeight: 720 }}>
            {generationPhaseLabel(job.phase || job.status)}
          </div>
          <div style={{ marginTop: 5, color: 'var(--theme-text-muted)', fontSize: 12.5, lineHeight: 1.55 }}>
            {job.message || '执行端正在准备任务'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ ...statusPill, color: '#79c0ff', borderColor: 'rgba(88,166,255,.55)', fontSize: 11 }}>
            ⏱ {formatDuration(job.startedAt || job.createdAt, job.endedAt, now)}
          </span>
          {isActiveGeneration(job) && <button style={dangerButton} onClick={onCancel}>■ 停止生成</button>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(80px, 1fr))', gap: 7, marginTop: 16, overflowX: 'auto', paddingBottom: 2 }}>
        {generationStages.map((stage, index) => {
          const complete = index < phaseIndex || (index === 4 && job.status === 'succeeded');
          const active = index === phaseIndex && isActiveGeneration(job);
          const failed = index === 4 && ['error', 'cancelled'].includes(job.status);
          const color = failed ? '#ff7b72' : complete ? '#56d364' : active ? '#79c0ff' : '#6e7681';
          return (
            <div key={stage} style={{ minWidth: 80 }}>
              <div style={{ height: 5, borderRadius: 99, background: color, opacity: complete || active || failed ? 1 : .35 }} />
              <div style={{ marginTop: 6, color, fontSize: 10.5, fontWeight: active ? 700 : 500 }}>
                {complete ? '✓ ' : active ? '● ' : ''}{stage}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 8, marginTop: 14 }}>
        <div style={generationMetricStyle}>
          <span style={generationMetricLabelStyle}>执行 Backend</span>
          <strong style={generationMetricValueStyle}>{job.backendLabel || job.backendId || '正在解析'}</strong>
        </div>
        <div style={generationMetricStyle}>
          <span style={generationMetricLabelStyle}>模型</span>
          <strong style={generationMetricValueStyle}>{job.model || 'Backend 默认模型'}</strong>
        </div>
        <div style={generationMetricStyle}>
          <span style={generationMetricLabelStyle}>模型正文</span>
          <strong style={generationMetricValueStyle}>{(job.outputChars || 0).toLocaleString()} 字符</strong>
        </div>
        <div style={generationMetricStyle}>
          <span style={generationMetricLabelStyle}>推理流</span>
          <strong style={generationMetricValueStyle}>{(job.thinkingChars || 0).toLocaleString()} 字符</strong>
        </div>
        <div style={generationMetricStyle}>
          <span style={generationMetricLabelStyle}>最近活动</span>
          <strong style={{ ...generationMetricValueStyle, color: stalled ? '#ff7b72' : '#56d364' }}>
            {formatActivityAge(lastEventAt, now)}
          </strong>
        </div>
      </div>

      {stalled && (
        <div style={{
          marginTop: 12, padding: '9px 11px', borderRadius: 7, fontSize: 12, lineHeight: 1.55,
          color: '#ffb3ad', border: '1px solid rgba(248,81,73,.4)', background: 'rgba(248,81,73,.09)',
        }}>
          已有 {Math.floor(inactiveSeconds)} 秒没有收到新事件。任务尚未被判定失败，可能正在长推理、等待工具返回或等待模型连接；你可以继续观察或手动停止。
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 12, marginTop: 13 }}>
        <div style={generationPaneStyle}>
          <div style={generationPaneHeaderStyle}>
            <div>
              <strong>实时模型输出</strong>
              <span style={{ ...subtleStyle, marginLeft: 7 }}>正在拼装标准 Kit JSON</span>
            </div>
            <button style={{ ...linkButton, opacity: followOutput ? .7 : 1 }} onClick={() => setFollowOutput((value) => !value)}>
              {followOutput ? '● 跟随最新' : '○ 恢复跟随'}
            </button>
          </div>
          <pre
            ref={outputRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              setFollowOutput(element.scrollHeight - element.scrollTop - element.clientHeight < 28);
            }}
            style={generationOutputStyle}
          >{job.outputPreview || '等待模型开始输出…\n\n如果模型先进行推理或检查文件，右侧活动会先更新。'}</pre>
        </div>

        <div style={generationPaneStyle}>
          <div style={generationPaneHeaderStyle}>
            <strong>最近活动</strong>
            <span style={subtleStyle}>{activities.length} 条</span>
          </div>
          <div style={{ maxHeight: 330, overflow: 'auto', padding: '5px 10px 10px' }}>
            {activities.length ? activities.map((activity, index) => (
              <div key={`${activity.at}-${index}`} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: 7, padding: '8px 0', borderBottom: '1px solid var(--theme-border)' }}>
                <span style={{ color: activity.type === 'error' ? '#ff7b72' : '#79c0ff', fontWeight: 800 }}>
                  {generationActivityIcon(activity.type)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{activity.label}</div>
                  <div style={{ ...subtleStyle, marginTop: 2 }}>{new Date(activity.at * 1000).toLocaleTimeString()}</div>
                  {activity.detail && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--theme-text-muted)', fontSize: 10.5 }}>查看输入 / 返回</summary>
                      <pre style={{ ...generationActivityDetailStyle }}>{activity.detail}</pre>
                    </details>
                  )}
                </div>
              </div>
            )) : <div style={{ ...subtleStyle, padding: '12px 2px' }}>等待第一个活动事件…</div>}
          </div>
        </div>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: '#d2a8ff', fontWeight: 650 }}>
          模型推理流 · {(job.thinkingChars || 0).toLocaleString()} 字符
        </summary>
        <pre style={{ ...generationOutputStyle, maxHeight: 220, marginTop: 8, color: '#d2a8ff' }}>
          {job.thinkingPreview || '当前 Backend 没有提供可展示的推理流。'}
        </pre>
      </details>

      <div style={{ ...subtleStyle, marginTop: 10 }}>
        任务运行在 Session 所属执行端；关闭面板或切换 Session 不会中断，回来后会恢复到最新状态。
      </div>
    </section>
  );
};

const KitEditor: React.FC<{
  sessionId: string;
  draft: Draft;
  onChange: (draft: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  generationJob: KitGenerationJob | null;
  onGenerationJob: (job: KitGenerationJob) => void;
  onCancelGeneration: () => Promise<void>;
  now: number;
}> = ({
  sessionId, draft, onChange, onSave, onCancel, busy,
  generationJob, onGenerationJob, onCancelGeneration, now,
}) => {
  const [submittingGeneration, setSubmittingGeneration] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [generation, setGeneration] = useState<KitGenerationResult | null>(generationJob?.result || null);
  const appliedGenerationRef = useRef('');
  const [clientSources, setClientSources] = useState<string[]>(() => (
    generationJob?.request.clientSources?.length
      ? generationJob.request.clientSources
      : draft.steps
      .filter((step) => step.type === 'file_push')
      .map((step) => String(step.config?.source || ''))
      .filter((source) => source && !source.includes('{{'))
  ));
  const generating = submittingGeneration || isActiveGeneration(generationJob);
  const hasApprovalCapability = draft.steps.some((step) => step.type === 'awu_capability');
  const patch = (value: Partial<Draft>) => onChange({ ...draft, ...value });
  const setInputs = (inputs: KitInputSpec[]) => patch({ inputs });
  const setAssertions = (assertions: KitAssertionSpec[]) => patch({ assertions });
  const setOutputs = (outputs: KitOutputSpec[]) => patch({ outputs });
  const updateStep = (index: number, value: Partial<Draft['steps'][number]>) => patch({
    steps: draft.steps.map((step, itemIndex) => itemIndex === index
      ? { ...step, ...value } : step),
    generatedByAi: false,
  });

  useEffect(() => {
    setClientSources(
      draft.steps
        .filter((step) => step.type === 'file_push')
        .map((step) => String(step.config?.source || ''))
        .filter((source) => source && !source.includes('{{')),
    );
  }, [draft.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!generationJob) return;
    if (generationJob.request.clientSources?.length) {
      setClientSources(generationJob.request.clientSources);
    }
    if (isActiveGeneration(generationJob)) {
      setGeneration(null);
      return;
    }
    if (!generationJob.result || appliedGenerationRef.current === generationJob.id) return;
    appliedGenerationRef.current = generationJob.id;
    const result = generationJob.result;
    setGeneration(result);
    if (result.kit) {
      const {
        lastRunId: _lastRunId,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...compiled
      } = result.kit;
      onChange({ ...compiled, id: generationJob.request.existingKit?.id });
    }
    if (result.status !== 'ok') setAdvancedOpen(!!result.kit);
  }, [generationJob?.id, generationJob?.status, generationJob?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const addClientSource = async () => {
    try {
      const selected = await api.selectKitLocalFile();
      if (selected) setClientSources((current) => Array.from(new Set([...current, selected])));
    } catch (error) {
      setGeneration({
        status: 'error', ready: false,
        message: error instanceof Error ? error.message : '无法选择客户端本地文件',
      });
    }
  };

  const compileWithAi = async () => {
    if (!draft.objective.trim() || !draft.successCriteria.trim()) return;
    setSubmittingGeneration(true);
    setGeneration(null);
    try {
      const result = await api.kitGenerateStart(sessionId, {
        objective: draft.objective,
        successCriteria: draft.successCriteria,
        safetyConstraints: draft.safetyConstraints,
        references: draft.references,
        clientSources,
        existingKit: draft.id ? draft : undefined,
      });
      if (result.status !== 'ok' || !result.job) {
        setGeneration({
          status: 'error', ready: false,
          message: result.message || '无法启动后台 AI Kit 编译',
        });
        return;
      }
      onGenerationJob(result.job);
    } catch (error) {
      setGeneration({ status: 'error', ready: false, message: error instanceof Error ? error.message : 'AI Kit 编译失败' });
    } finally {
      setSubmittingGeneration(false);
    }
  };

  return (
    <div style={{ padding: 18, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ ...sectionTitle, marginBottom: 5 }}>{draft.id ? '重新定义 Kit' : '用自然语言创建 Kit'}</div>
      <div style={{ ...subtleStyle, fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>
        你定义任务、成功标准和安全边界；AI 检查当前 Session 工作区并编译实现。保存后每次点击都运行同一套确定性过程，最终状态由机器判言决定。
      </div>

      <label style={blockLabel}><FieldLabel>任务 · 要完成什么 *</FieldLabel>
        <textarea autoFocus style={{ ...inputStyle, minHeight: 78, resize: 'vertical', fontSize: 13 }}
          placeholder="例如：关闭 start-amp.bat 启动的 CMD 窗口及其附属 Java 进程"
          value={draft.objective}
          onChange={(e) => patch({ objective: e.target.value })} />
      </label>
      <div style={twoColumns}>
        <label style={blockLabel}><FieldLabel>成功 / 失败标准 *</FieldLabel>
          <textarea style={{ ...inputStyle, minHeight: 92, resize: 'vertical' }}
            placeholder="例如：目标窗口和所属 Java 全部消失为成功；找不到唯一目标或仍有残留为失败"
            value={draft.successCriteria}
            onChange={(e) => patch({ successCriteria: e.target.value })} />
        </label>
        <label style={blockLabel}><FieldLabel>安全边界 / 禁止事项</FieldLabel>
          <textarea style={{ ...inputStyle, minHeight: 92, resize: 'vertical' }}
            placeholder="例如：不得关闭其他 CMD 或 Java；目标不明确时必须拒绝执行"
            value={draft.safetyConstraints}
            onChange={(e) => patch({ safetyConstraints: e.target.value })} />
        </label>
      </div>
      <label style={blockLabel}><FieldLabel>Session 执行端已有的文件或对象（可选，每行一个）</FieldLabel>
        <textarea style={{ ...inputStyle, minHeight: 54, resize: 'vertical' }}
          placeholder={'start-amp.bat\nlogs/amp.log\n窗口标题 AMP'}
          value={draft.references.join('\n')}
          onChange={(e) => patch({
            references: e.target.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
          })} />
      </label>

      <section style={{ ...cardStyle, marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={cardTitle}>客户端本地文件 → 当前 Session 执行端</div>
            <div style={subtleStyle}>使用内建 file_push，不需要填写远程主机、端口、SSH 或密码。</div>
          </div>
          <button style={secondaryButton} onClick={addClientSource}>选择本地文件</button>
        </div>
        {clientSources.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 9 }}>
            {clientSources.map((source) => (
              <div key={source} style={{ ...versionRowStyle, padding: '5px 0' }}>
                <code style={{ ...subtleStyle, flex: 1, overflowWrap: 'anywhere' }}>{source}</code>
                <button style={dangerMini} onClick={() => setClientSources((items) => items.filter((item) => item !== source))}>×</button>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ ...subtleStyle, marginTop: 8 }}>
            也可以不预选：AI 会生成“本地文件”运行输入，执行 Kit 时再选择文件。
          </div>
        )}
      </section>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <button style={{ ...primaryButton, fontSize: 13, padding: '9px 15px' }}
          disabled={generating || busy || !draft.objective.trim() || !draft.successCriteria.trim()}
          onClick={compileWithAi}>
          {generating ? '✨ AI 正在检查并编译…' : (draft.command || draft.steps.length) ? '✨ AI 重新编译实现' : '✨ AI 生成标准 Kit'}
        </button>
        <span style={subtleStyle}>生成阶段不保存、不执行任务；先给你审核。</span>
      </div>

      {generationJob && (
        isActiveGeneration(generationJob)
        || (!generationJob.result && ['error', 'cancelled'].includes(generationJob.status))
      ) && (
        <KitGenerationProgress job={generationJob} now={now} onCancel={() => void onCancelGeneration()} />
      )}

      {generation && (
        <section style={{ ...cardStyle, borderColor: generation.ready ? 'rgba(63,185,80,.45)' : 'rgba(210,153,34,.55)' }}>
          <div style={{ ...cardTitle, color: generation.ready ? '#56d364' : '#e3b341' }}>
            {generation.ready ? '✓ AI 编译完成，可以保存' : '⚠ 尚未通过安全编译'}
          </div>
          {generation.message && <div style={{ fontSize: 12, lineHeight: 1.55 }}>{generation.message}</div>}
          {!!generation.questions?.length && (
            <div style={{ marginTop: 8, color: '#e3b341', fontSize: 12 }}>
              {generation.questions.map((item, index) => <div key={index}>· 需要补充：{item}</div>)}
            </div>
          )}
          {!!generation.warnings?.length && (
            <div style={{ marginTop: 8, color: '#ff9b93', fontSize: 12 }}>
              {generation.warnings.map((item, index) => <div key={index}>· 安全检查：{item}</div>)}
            </div>
          )}
          {(generation.safetySummary || generation.verificationSummary) && (
            <div style={{ ...subtleStyle, marginTop: 8, lineHeight: 1.55 }}>
              {generation.safetySummary && <div>范围控制：{generation.safetySummary}</div>}
              {generation.verificationSummary && <div>机器验收：{generation.verificationSummary}</div>}
            </div>
          )}
        </section>
      )}

      {draft.implementationSummary && (
        <section style={cardStyle}>
          <div style={{ ...cardTitle, display: 'flex', alignItems: 'center', gap: 7 }}>
            AI 实现摘要 {draft.generatedByAi && <span style={experimentBadge}>已编译</span>}
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{draft.implementationSummary}</div>
        </section>
      )}

      <EditorGroup title="预定义输入" action="＋ 输入" onAction={() => setInputs([
        ...draft.inputs, { key: `input_${draft.inputs.length + 1}`, label: '输入', type: 'text' },
      ])}>
        {draft.inputs.map((item, index) => (
          <div key={index} style={editorRow}>
            <input style={miniInput} placeholder="key" value={item.key}
              onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? { ...x, key: e.target.value } : x))} />
            <input style={miniInput} placeholder="显示名" value={item.label || ''}
              onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? { ...x, label: e.target.value } : x))} />
            <select style={miniInput} value={item.type || 'text'}
              onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? { ...x, type: e.target.value as KitInputSpec['type'] } : x))}>
              <option value="text">文本</option><option value="number">数字</option>
              <option value="boolean">开关</option><option value="select">选项</option>
              <option value="file">客户端本地文件</option><option value="secret">一次性密码 / 密钥</option>
            </select>
            {item.type === 'select' && (
              <input style={miniInput} placeholder="选项，以逗号分隔" value={(item.options || []).join(',')}
                onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? {
                  ...x,
                  options: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                } : x))} />
            )}
            {item.type === 'secret' ? (
              <span style={{ ...subtleStyle, alignSelf: 'center' }}>不保存默认值或数据来源</span>
            ) : (
              <input style={miniInput} placeholder="来源数据 key（可选）" value={item.sourceKey || ''}
                onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? { ...x, sourceKey: e.target.value } : x))} />
            )}
            <label style={tinyCheck}><input type="checkbox" checked={!!item.required}
              onChange={(e) => setInputs(draft.inputs.map((x, i) => i === index ? { ...x, required: e.target.checked } : x))} />必填</label>
            <button style={dangerMini} onClick={() => setInputs(draft.inputs.filter((_, i) => i !== index))}>×</button>
          </div>
        ))}
      </EditorGroup>

      <div style={twoColumns}>
        <label><FieldLabel>默认执行位置</FieldLabel>
          <select style={inputStyle} value={draft.executionTarget}
            onChange={(e) => {
              const target = e.target.value as Draft['executionTarget'];
              patch({
                executionTarget: target,
                steps: draft.steps.map((step) => step.type === 'command'
                  ? { ...step, target } : step),
                generatedByAi: false,
              });
            }}>
            <option value="executor">Session 执行端（默认）</option>
            <option value="client">当前客户端（桌面端）</option>
          </select>
        </label>
        <label><FieldLabel>触发方式</FieldLabel>
          <select style={inputStyle} value={draft.schedule.mode}
            title={hasApprovalCapability ? '需要人工确认的 AgentWithU 能力只能手动运行' : undefined}
            onChange={(e) => patch({ schedule: { ...draft.schedule, mode: e.target.value as 'manual' | 'interval' } })}>
            <option value="manual">单次手动执行</option>
            <option value="interval" disabled={hasApprovalCapability}>Schedule 周期执行</option>
          </select>
        </label>
        {draft.schedule.mode === 'interval' && (
          <label><FieldLabel>间隔秒数（最低 10）</FieldLabel>
            <input style={inputStyle} type="number" min={10} value={draft.schedule.intervalSeconds}
              onChange={(e) => patch({ schedule: { ...draft.schedule, intervalSeconds: Math.max(10, Number(e.target.value) || 300) } })} />
          </label>
        )}
      </div>

      <details open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)} style={{ ...cardStyle, marginTop: 14 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 650 }}>
          高级实现 · Shell、命令与机器判言
        </summary>
        <div style={{ ...subtleStyle, marginTop: 7, lineHeight: 1.5 }}>
          通常由 AI 维护。需要审计或手工兜底时再展开修改；这里的代码不会在创建阶段执行。
        </div>
        <div style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" style={secondaryButton} onClick={() => patch({
            steps: [
              ...(draft.steps.length ? draft.steps : draft.command.trim() ? [{
                id: 'legacy-command',
                type: 'command' as const,
                target: draft.executionTarget,
                title: draft.title || '执行原有任务',
                shell: draft.shell,
                cwd: draft.cwd,
                timeoutSeconds: draft.timeoutSeconds,
                command: draft.command,
                assertions: draft.assertions,
              }] : []),
              {
              id: `awu-release-${Date.now()}`,
              type: 'awu_capability',
              target: 'executor',
              title: '发布最新包',
              config: {
                capability: 'release.publish_latest',
                arguments: { projectRoot: '.', channel: 'stable', notes: '' },
              },
              },
            ],
            generatedByAi: false,
            schedule: { ...draft.schedule, mode: 'manual' },
          })}>＋ AgentWithU · 发布最新包</button>
          <span style={{ ...subtleStyle, alignSelf: 'center' }}>
            自动扫描和预检；正式发布前仍须人工确认。
          </span>
        </div>
        {draft.steps.length > 0 && (
          <section style={{ ...editorGroup, marginTop: 10 }}>
            <strong style={{ fontSize: 12 }}>有序编排 · 任一步失败即停止</strong>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>
              {draft.steps.map((step, index) => (
                <div key={step.id || index} style={{ ...editorRow, alignItems: 'flex-start' }}>
                  <span style={{ ...statusPill, color: '#79c0ff', borderColor: '#58a6ff66' }}>{index + 1}</span>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 12 }}>{step.title || `步骤 ${index + 1}`}</div>
                    <div style={{ ...subtleStyle, marginTop: 3 }}>
                      {step.type === 'file_push' ? `文件推送：${step.config?.source || '未指定'} → ${step.config?.destination || '未指定'}`
                        : step.type === 'kit_call' ? `调用 Kit：${step.kitId || '未指定'}`
                          : step.type === 'awu_capability' ? `AgentWithU 能力：${step.config?.capability || '未指定'}`
                          : `${step.shell || draft.shell} · ${(step.command || '').slice(0, 180)}`}
                    </div>
                    {step.type === 'awu_capability' && (
                      <div style={{ ...twoColumns, marginTop: 9 }}>
                        <label><FieldLabel>项目目录</FieldLabel>
                          <input style={miniInput} value={String(step.config?.arguments?.projectRoot || '.')}
                            onChange={(e) => updateStep(index, { config: {
                              ...step.config,
                              arguments: { ...step.config?.arguments, projectRoot: e.target.value },
                            } })} />
                        </label>
                        <label><FieldLabel>发布通道</FieldLabel>
                          <input style={miniInput} value={String(step.config?.arguments?.channel || 'stable')}
                            onChange={(e) => updateStep(index, { config: {
                              ...step.config,
                              arguments: { ...step.config?.arguments, channel: e.target.value },
                            } })} />
                        </label>
                        <label><FieldLabel>平台筛选（可选，逗号分隔）</FieldLabel>
                          <input style={miniInput}
                            placeholder="windows,linux,macos"
                            value={Array.isArray(step.config?.arguments?.platforms)
                              ? step.config?.arguments?.platforms.join(',') : ''}
                            onChange={(e) => updateStep(index, { config: {
                              ...step.config,
                              arguments: {
                                ...step.config?.arguments,
                                platforms: e.target.value.split(',').map((item) => item.trim()).filter(Boolean),
                              },
                            } })} />
                        </label>
                        <label><FieldLabel>制品类型（可选，逗号分隔）</FieldLabel>
                          <input style={miniInput}
                            placeholder="msi,nsis,docker-bundle"
                            value={Array.isArray(step.config?.arguments?.kinds)
                              ? step.config?.arguments?.kinds.join(',') : ''}
                            onChange={(e) => updateStep(index, { config: {
                              ...step.config,
                              arguments: {
                                ...step.config?.arguments,
                                kinds: e.target.value.split(',').map((item) => item.trim()).filter(Boolean),
                              },
                            } })} />
                        </label>
                        <label style={{ gridColumn: '1 / -1' }}><FieldLabel>发布说明</FieldLabel>
                          <textarea style={{ ...miniInput, width: '100%', minHeight: 54, resize: 'vertical' }}
                            value={String(step.config?.arguments?.notes || '')}
                            onChange={(e) => updateStep(index, { config: {
                              ...step.config,
                              arguments: { ...step.config?.arguments, notes: e.target.value },
                            } })} />
                        </label>
                      </div>
                    )}
                  </div>
                  <span style={mutedPill}>{step.target === 'client' ? '客户端' : '执行端'}</span>
                  <button type="button" style={dangerMini} onClick={() => patch({
                    steps: draft.steps.filter((_, itemIndex) => itemIndex !== index),
                    generatedByAi: false,
                  })}>×</button>
                </div>
              ))}
            </div>
          </section>
        )}
        <div style={{ ...twoColumns, marginTop: 12 }}>
          <label><FieldLabel>名称</FieldLabel>
            <input style={inputStyle} value={draft.title}
              onChange={(e) => patch({ title: e.target.value })} />
          </label>
          <label><FieldLabel>Shell</FieldLabel>
            <select style={inputStyle} value={draft.shell}
              onChange={(e) => patch({ shell: e.target.value as Draft['shell'], generatedByAi: false })}>
              <option value="powershell">PowerShell</option>
              <option value="cmd">CMD</option>
              <option value="bash">Bash</option>
            </select>
          </label>
        </div>
        <label style={blockLabel}><FieldLabel>说明</FieldLabel>
          <input style={inputStyle} value={draft.description}
            onChange={(e) => patch({ description: e.target.value })} />
        </label>
        <div style={twoColumns}>
          <label><FieldLabel>Session 内工作目录</FieldLabel>
            <input style={inputStyle} value={draft.cwd}
              onChange={(e) => patch({ cwd: e.target.value, generatedByAi: false })} />
          </label>
          <label><FieldLabel>超时（秒）</FieldLabel>
            <input style={inputStyle} type="number" min={1} value={draft.timeoutSeconds}
              onChange={(e) => patch({ timeoutSeconds: Math.max(1, Number(e.target.value) || 300), generatedByAi: false })} />
          </label>
        </div>
        <label style={blockLabel}><FieldLabel>执行过程 · 用 {'{{input_key}}'} 引用标准输入</FieldLabel>
          <textarea style={{ ...inputStyle, minHeight: 120, fontFamily: 'Consolas, monospace' }}
            value={draft.command} onChange={(e) => patch({ command: e.target.value, generatedByAi: false })} />
        </label>

        <EditorGroup title="机器判言（至少一条）" action="＋ 判言" onAction={() => setAssertions([
          ...draft.assertions, { type: 'stdout_contains', expected: '', label: '输出包含' },
        ])}>
          {draft.assertions.map((item, index) => (
            <div key={index} style={editorRow}>
              <select style={miniInput} value={item.type}
                onChange={(e) => setAssertions(draft.assertions.map((x, i) => i === index ? { ...x, type: e.target.value as KitAssertionSpec['type'] } : x))}>
                <option value="exit_code">退出码</option>
                <option value="stdout_contains">标准输出包含</option>
                <option value="stdout_regex">标准输出正则</option>
                <option value="stderr_contains">错误输出包含</option>
                <option value="stderr_regex">错误输出正则</option>
                <option value="json_valid">标准输出是 JSON</option>
                <option value="file_exists">文件存在</option>
              </select>
              <input style={{ ...miniInput, flex: 1 }} placeholder="名称" value={item.label || ''}
                onChange={(e) => setAssertions(draft.assertions.map((x, i) => i === index ? { ...x, label: e.target.value } : x))} />
              <input style={{ ...miniInput, flex: 1 }} placeholder="期望值 / 相对路径" value={String(item.expected ?? item.path ?? '')}
                onChange={(e) => setAssertions(draft.assertions.map((x, i) => i === index ? { ...x, expected: e.target.value } : x))} />
              <button style={dangerMini} disabled={draft.assertions.length <= 1}
                onClick={() => setAssertions(draft.assertions.filter((_, i) => i !== index))}>×</button>
            </div>
          ))}
        </EditorGroup>

        <EditorGroup title="发布到数据市场" action="＋ 输出" onAction={() => setOutputs([
          ...draft.outputs, { key: `output_${draft.outputs.length + 1}`, label: '结果', source: 'stdout', type: 'text' },
        ])}>
          {draft.outputs.map((item, index) => (
            <div key={index} style={editorRow}>
              <input style={miniInput} placeholder="数据 key" value={item.key}
                onChange={(e) => setOutputs(draft.outputs.map((x, i) => i === index ? { ...x, key: e.target.value } : x))} />
              <input style={miniInput} placeholder="显示名" value={item.label || ''}
                onChange={(e) => setOutputs(draft.outputs.map((x, i) => i === index ? { ...x, label: e.target.value } : x))} />
              <select style={miniInput} value={item.source || 'stdout'}
                onChange={(e) => setOutputs(draft.outputs.map((x, i) => i === index ? { ...x, source: e.target.value as KitOutputSpec['source'] } : x))}>
                <option value="stdout">标准输出</option><option value="stderr">错误输出</option>
                <option value="json">JSON</option><option value="file">文件</option>
              </select>
              {item.source === 'file' && <input style={miniInput} placeholder="相对路径" value={item.path || ''}
                onChange={(e) => setOutputs(draft.outputs.map((x, i) => i === index ? { ...x, path: e.target.value } : x))} />}
              {item.source === 'file' && <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
                fontSize: 10, color: 'var(--theme-text-muted)',
              }} title="Kit 成功后只登记为候选构建；仍需在发布工作台预检并明确确认">
                <input type="checkbox" checked={!!item.releaseCandidate}
                  onChange={(e) => setOutputs(draft.outputs.map((x, i) => i === index ? {
                    ...x, releaseCandidate: e.target.checked,
                  } : x))} />
                登记发布候选
              </label>}
              <button style={dangerMini} onClick={() => setOutputs(draft.outputs.filter((_, i) => i !== index))}>×</button>
            </div>
          ))}
        </EditorGroup>

        <label style={blockLabel}><FieldLabel>硬数据依赖（数据 key，以逗号分隔；缺失时不执行）</FieldLabel>
          <input style={inputStyle} value={draft.dependencies.join(',')}
            onChange={(e) => patch({
              dependencies: e.target.value.split(',').map((value) => value.trim()).filter(Boolean),
            })} />
        </label>
      </details>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <button style={secondaryButton} onClick={onCancel}>取消</button>
        <button style={primaryButton}
          disabled={busy || generating || !draft.objective.trim() || !draft.successCriteria.trim() || (!draft.command.trim() && !draft.steps.length) || generation?.ready === false}
          title={generation?.ready === false ? '请先补充信息并重新编译，或修正高级实现后重新编译' : undefined}
          onClick={onSave}>
          {busy ? '保存中…' : '保存 Kit'}
        </button>
      </div>
    </div>
  );
};

const EditorGroup: React.FC<{
  title: string; action: string; onAction: () => void; children: React.ReactNode;
}> = ({ title, action, onAction, children }) => (
  <section style={editorGroup}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <strong style={{ fontSize: 12 }}>{title}</strong>
      <button style={linkButton} onClick={onAction}>{action}</button>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>{children}</div>
  </section>
);

const CapabilityRunCard: React.FC<{
  run: KitRun;
  step: KitStepRun;
  responding: boolean;
  onRespond: (approved: boolean) => void;
}> = ({ run, step, responding, onRespond }) => {
  const runtime = (step.config?.capabilityRuntime || {}) as KitCapabilityRuntime;
  const plan = runtime.plan || {};
  const candidate = plan.candidate || {};
  const artifacts: Array<Record<string, unknown>> = Array.isArray(plan.artifacts) ? plan.artifacts : [];
  const job = runtime.job || {};
  const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
  const waiting = run.status === 'waiting_approval' && step.status === 'waiting_approval';
  const bytes = (value: unknown) => {
    const amount = Number(value || 0);
    if (!amount) return '0 B';
    if (amount < 1024 * 1024) return `${(amount / 1024).toFixed(1)} KB`;
    return `${(amount / 1024 / 1024).toFixed(1)} MB`;
  };
  return (
    <div style={{
      marginTop: 10, padding: 13, borderRadius: 10,
      border: `1px solid ${waiting ? 'rgba(240,180,41,.55)' : 'var(--theme-border)'}`,
      background: waiting ? 'rgba(240,180,41,.075)' : 'rgba(88,166,255,.045)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <strong style={{ fontSize: 13 }}>AgentWithU · 发布最新包</strong>
          <div style={{ ...subtleStyle, marginTop: 4 }}>
            冻结计划 {String(plan.id || runtime.planId || '准备中').slice(0, 12)}
            {plan.fingerprint ? ` · 指纹 ${String(plan.fingerprint).slice(0, 12)}` : ''}
          </div>
        </div>
        <span style={{ ...statusPill, color: waiting ? '#f0b429' : '#79c0ff', borderColor: waiting ? '#f0b42966' : '#58a6ff66' }}>
          {waiting ? '需要人工确认' : String(runtime.phase || step.status)}
        </span>
      </div>

      {plan.id && (
        <div style={{ ...runMetaGrid, marginTop: 11 }}>
          <span>版本：{String(candidate.version || plan.release?.version || '—')}</span>
          <span>Build：{String(candidate.buildId || plan.release?.buildId || '—')}</span>
          <span>序号：{String(candidate.sequence || plan.release?.sequence || '—')}</span>
          <span>Channel：{String(plan.channel || 'stable')}</span>
          <span>制品：{artifacts.length}</span>
          <span>Manifest：{String(plan.manifestUrl || '—')}</span>
        </div>
      )}

      {run.approvalDelegation?.id && <div style={{ ...subtleStyle, marginTop: 8 }}>
        本次运行已获用户委托 · 到期 {new Date(run.approvalDelegation.expiresAt * 1000).toLocaleString()}
        {runtime.approval?.source === 'chat-delegated' ? ' · 已由 Agent 核对并代确认' : ' · 尚需 Agent 核对计划或手动确认'}
      </div>}

      {artifacts.length > 0 && (
        <div style={{ display: 'grid', gap: 5, marginTop: 10 }}>
          {artifacts.map((artifact, index) => (
            <div key={String(artifact.id || index)} style={{ ...assertionRow, fontSize: 11.5 }}>
              <span style={{ color: '#79c0ff' }}>◆</span>
              <span style={{ flex: 1 }}>{String(artifact.fileName || artifact.id || `制品 ${index + 1}`)}</span>
              <span style={subtleStyle}>{String(artifact.platform || 'any')} / {String(artifact.arch || 'any')}</span>
              <span style={subtleStyle}>{bytes(artifact.size)}</span>
              <span style={{ ...subtleStyle, fontFamily: 'Consolas, monospace' }}>{String(artifact.sha256 || '').slice(0, 12)}</span>
            </div>
          ))}
        </div>
      )}

      {!!plan.blockers?.length && (
        <div style={{ marginTop: 10, color: '#ff7b72', fontSize: 12 }}>
          {plan.blockers.map((item, index) => <div key={index}>阻断：{item}</div>)}
        </div>
      )}
      {!!plan.warnings?.length && (
        <details style={{ marginTop: 9 }}>
          <summary style={{ cursor: 'pointer', color: '#e3b341', fontSize: 11.5 }}>
            {plan.warnings.length} 条发布提示
          </summary>
          <div style={{ marginTop: 5, color: '#e3b341', fontSize: 11.5 }}>
            {plan.warnings.map((item, index) => <div key={index}>• {item}</div>)}
          </div>
        </details>
      )}

      {job.id && (
        <div style={{ marginTop: 11 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5 }}>
            <span>{String(job.message || job.status || '发布中')}</span>
            <span>{progress}%{job.currentFileName ? ` · ${String(job.currentFileName)}` : ''}</span>
          </div>
          <div style={{ height: 6, marginTop: 6, borderRadius: 999, overflow: 'hidden', background: 'rgba(110,118,129,.25)' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: job.status === 'failed' ? '#f85149' : '#58a6ff', transition: 'width .25s ease' }} />
          </div>
          {job.totalBytes ? (
            <div style={{ ...subtleStyle, marginTop: 4 }}>{bytes(job.uploadedBytes)} / {bytes(job.totalBytes)}</div>
          ) : null}
        </div>
      )}

      {waiting && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 13, flexWrap: 'wrap' }}>
          <div style={{ color: '#f0b429', fontSize: 11.5 }}>
            确认后会上传以上制品并切换 channel manifest；Agent 仅可使用本次有效委托代确认，Schedule 不会自动批准。
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            <button style={dangerButton} disabled={responding} onClick={() => onRespond(false)}>
              拒绝并停止
            </button>
            <button style={primaryButton} disabled={responding} onClick={() => onRespond(true)}>
              {responding ? '提交中…' : '确认正式发布'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const KitDetail: React.FC<{
  sessionId: string;
  kit: WorkspaceKit;
  run?: KitRun;
  runs: KitRun[];
  inputs: Record<string, unknown>;
  onInputsChange: (inputs: Record<string, unknown>) => void;
  onRun: () => void;
  onCancel: (runId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onControlMode: (mode: 'ai' | 'human' | 'shared') => void;
  terminalCommand: string;
  onTerminalCommand: (value: string) => void;
  onTerminalRun: () => void;
  terminalConnected: boolean;
  onTerminalClose: () => void;
  busy: boolean;
  cancelling: boolean;
  dataMarket: WorkspaceKitState['dataMarket'];
  now: number;
  onOptimize: () => void;
  capabilityResponding: string;
  onCapabilityRespond: (runId: string, stepId: string, approved: boolean) => void;
}> = ({
  sessionId, kit, run, runs, inputs, onInputsChange, onRun, onCancel, onEdit, onDelete,
  onToggleEnabled, onControlMode, terminalCommand, onTerminalCommand, onTerminalRun,
  terminalConnected, onTerminalClose, busy, dataMarket, now, onOptimize,
  cancelling, capabilityResponding, onCapabilityRespond,
}) => {
  const running = isActiveRun(run);
  const meta = run ? statusMeta[run.status] : null;
  const selectRuntimeFile = async (spec: KitInputSpec) => {
    try {
      const selected = await api.selectKitLocalFile();
      if (selected) onInputsChange({ ...inputs, [spec.key]: selected });
    } catch {
      // 浏览器端没有可交给 Tauri file_push 的绝对路径；按钮提示已说明桌面端要求。
    }
  };
  return (
    <div style={{ padding: 18, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div className="awu-kit-detail-heading" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div className="awu-kit-detail-badges" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 17 }}>{kit.title}</h3>
            {kit.generatedByAi && <span style={experimentBadge}>AI 编译</span>}
            <span style={mutedPill}>{kit.executionTarget === 'client' ? '客户端' : '执行端默认'}</span>
            {meta && <span style={{ ...statusPill, color: meta.color, borderColor: `${meta.color}66` }}>● {meta.label}</span>}
            {run?.startedAt && <span style={mutedPill}>⏱ {formatDuration(run.startedAt, run.endedAt, now)}</span>}
            {!kit.enabled && <span style={mutedPill}>停用</span>}
          </div>
          {kit.description && <div style={{ ...subtleStyle, marginTop: 6 }}>{kit.description}</div>}
        </div>
        <div className="awu-kit-detail-actions" style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-end', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <KitVersionPicker sessionId={sessionId} kit={kit} running={running} compact />
          <button style={secondaryButton} onClick={onOptimize}>✨ 优化</button>
          <button style={secondaryButton} onClick={onToggleEnabled}>{kit.enabled ? '停用' : '启用'}</button>
          <button style={secondaryButton} onClick={onEdit}>编辑</button>
          <button style={{ ...secondaryButton, color: '#ff7b72' }} onClick={onDelete}>删除</button>
        </div>
      </div>

      <KitVersionsCard sessionId={sessionId} kit={kit} running={running} />

      {(kit.objective || kit.successCriteria || kit.safetyConstraints) && (
        <section style={cardStyle}>
          <div style={cardTitle}>人类定义的任务契约</div>
          {kit.objective && <ContractLine label="任务" text={kit.objective} />}
          {kit.successCriteria && <ContractLine label="成功标准" text={kit.successCriteria} tone="success" />}
          {kit.safetyConstraints && <ContractLine label="安全边界" text={kit.safetyConstraints} tone="warning" />}
          {!!kit.references?.length && <ContractLine label="相关对象" text={kit.references.join('、')} />}
          {kit.implementationSummary && (
            <details style={{ marginTop: 9 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--theme-text-muted)' }}>AI 实现摘要</summary>
              <div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 7, whiteSpace: 'pre-wrap' }}>{kit.implementationSummary}</div>
            </details>
          )}
          {!!kit.generationWarnings?.length && (
            <div style={{ marginTop: 8, color: '#ff9b93', fontSize: 11.5 }}>
              {kit.generationWarnings.map((item, index) => <div key={index}>⚠ {item}</div>)}
            </div>
          )}
        </section>
      )}

      {(kit.steps.length > 0 || !!run?.steps?.length) && (
        <section style={cardStyle}>
          <div style={cardTitle}>一键编排 · 严格顺序执行</div>
          {(run?.steps?.length ? run.steps : kit.steps).map((step, index) => {
            const stepStatus = 'status' in step ? step.status : 'pending';
            const duration = 'startedAt' in step
              ? formatDuration(step.startedAt, step.endedAt, now)
              : '—';
            const stepColor = stepStatus === 'succeeded' ? '#56d364'
              : ['failed', 'error', 'cancelled'].includes(stepStatus) ? '#ff7b72'
                : stepStatus === 'waiting_approval' ? '#f0b429'
                  : ['running', 'waiting_client'].includes(stepStatus) ? '#d2a8ff' : '#8b949e';
            return (
              <div key={step.id || index} style={{ ...assertionRow, color: stepColor }}>
                <span>{index + 1}</span>
                <span style={{ flex: 1, color: 'var(--theme-text)' }}>{step.title || `步骤 ${index + 1}`}</span>
                <span style={subtleStyle}>{step.type === 'file_push' ? '文件推送'
                  : step.type === 'kit_call' ? 'Kit 调用'
                    : step.type === 'awu_capability' ? 'AgentWithU 能力' : '命令'}</span>
                <span style={mutedPill}>{step.target === 'client' ? '客户端' : '执行端'}</span>
                <span style={{ minWidth: 74 }}>{stepStatus === 'waiting_client' ? '等待客户端'
                  : stepStatus === 'waiting_approval' ? '等待确认' : stepStatus}</span>
                <span style={{ ...durationPill, color: ['running', 'waiting_client', 'waiting_approval'].includes(stepStatus) ? stepColor : '#8b949e' }}>
                  ⏱ {duration}
                </span>
              </div>
            );
          })}
          {run?.steps.filter((step) => step.type === 'awu_capability').map((step) => (
            <CapabilityRunCard
              key={`capability-${step.id}`}
              run={run}
              step={step}
              responding={capabilityResponding === `${run.id}:${step.id}`}
              onRespond={(approved) => onCapabilityRespond(run.id, step.id, approved)}
            />
          ))}
          {run?.status === 'waiting_client' && (
            <div style={{ ...subtleStyle, marginTop: 8, color: '#d2a8ff' }}>
              当前客户端正在接管这一步；文件会分块传输并在执行端完成大小与 SHA-256 验收。
            </div>
          )}
        </section>
      )}

      <section style={cardStyle}>
        <div style={cardTitle}>标准输入</div>
        {kit.inputs.length === 0 ? (
          <div style={subtleStyle}>这个 Kit 没有运行时输入。</div>
        ) : (
          <div style={twoColumns}>
            {kit.inputs.map((spec) => (
              <label key={spec.key}>
                <FieldLabel>{spec.label || spec.key}{spec.required ? ' *' : ''}
                  {spec.sourceKey ? ` · 自动来源 ${spec.sourceKey}` : ''}</FieldLabel>
                {spec.type === 'file' ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input style={inputStyle} type="text" placeholder="选择当前客户端上的文件"
                      value={String(inputs[spec.key] ?? '')}
                      onChange={(e) => onInputsChange({ ...inputs, [spec.key]: e.target.value })} />
                    <button type="button" style={secondaryButton} onClick={() => selectRuntimeFile(spec)}>选择…</button>
                  </div>
                ) : spec.type === 'boolean' ? (
                  <input type="checkbox" checked={!!inputs[spec.key]}
                    onChange={(e) => onInputsChange({ ...inputs, [spec.key]: e.target.checked })} />
                ) : spec.type === 'select' ? (
                  <select style={inputStyle} value={String(inputs[spec.key] ?? '')}
                    onChange={(e) => onInputsChange({ ...inputs, [spec.key]: e.target.value })}>
                    <option value="">请选择</option>
                    {(spec.options || []).map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                ) : spec.type === 'secret' ? (
                  <input style={inputStyle} type="password" autoComplete="new-password"
                    placeholder={spec.placeholder || '仅本次运行使用，不保存到记录'}
                    value={String(inputs[spec.key] ?? '')}
                    onChange={(e) => onInputsChange({ ...inputs, [spec.key]: e.target.value })} />
                ) : (
                  <input style={inputStyle} type={spec.type === 'number' ? 'number' : 'text'}
                    placeholder={spec.placeholder || (spec.sourceKey ? '留空则取数据市场' : '')}
                    value={String(inputs[spec.key] ?? '')}
                    onChange={(e) => onInputsChange({
                      ...inputs,
                      [spec.key]: spec.type === 'number' ? Number(e.target.value) : e.target.value,
                    })} />
                )}
              </label>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
          <div style={subtleStyle}>
            {kit.schedule.mode === 'interval'
              ? `Schedule：每 ${kit.schedule.intervalSeconds} 秒 · 下次 ${kit.schedule.nextRunAt ? new Date(kit.schedule.nextRunAt * 1000).toLocaleString() : '待计算'}`
              : '单次执行'}
          </div>
          {running ? (
            <button style={dangerButton} disabled={cancelling} onClick={() => onCancel(run!.id)}>
              {cancelling ? '停止中…' : '■ 停止'}
            </button>
          ) : (
            <button style={primaryButton} disabled={busy || !kit.enabled} onClick={onRun}>▶ 执行并验收</button>
          )}
        </div>
      </section>

      {run && (
        <section style={cardStyle}>
          <div style={cardTitle}>判言 · 用户看到的标准化结论</div>
          {run.assertions.length === 0 && running && <div style={subtleStyle}>执行完成后自动判定…</div>}
          {run.assertions.map((item, index) => (
            <div key={index} style={{ ...assertionRow, color: item.passed ? '#56d364' : '#ff7b72' }}>
              <span>{item.passed ? '●' : '●'}</span>
              <span style={{ flex: 1 }}>{item.label}</span>
              <span style={subtleStyle}>
                {item.message || `${asDisplay(item.actual)}${item.expected !== undefined ? ` / 期望 ${asDisplay(item.expected)}` : ''}`}
              </span>
            </div>
          ))}
          {run.error && <div style={{ color: '#ff7b72', fontSize: 12, marginTop: 8 }}>{run.error}</div>}
        </section>
      )}

      <section style={cardStyle}>
        <div style={cardTitle}>结果视图</div>
        {!run ? <div style={subtleStyle}>尚未运行。</div> : (
          <>
            <div style={runMetaGrid}>
              <span>退出码：{run.exitCode ?? '—'}</span>
              <span>触发：{run.trigger}</span>
              <span>操作者：{run.owner === 'ai' ? 'AI' : '人工'}</span>
              <span>目录：{run.cwd || kit.cwd}</span>
              <span>总耗时：{formatDuration(run.startedAt, run.endedAt, now)}</span>
              <span>原子步：{run.steps?.length || 1}</span>
            </div>
            <LogBlock title="stdout" text={run.stdout} />
            <LogBlock title="stderr" text={run.stderr} tone="error" />
          </>
        )}
      </section>

      <section style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ ...cardTitle, display: 'flex', alignItems: 'center', gap: 7 }}>
              终端接管 · 持久命令通道
              <span style={{ color: terminalConnected ? '#56d364' : '#8b949e', fontWeight: 400 }}>
                ● {terminalConnected ? '已连接' : '未连接'}
              </span>
            </div>
            <div style={subtleStyle}>AI 与人工操作同一个持久 Shell；目录、变量和进程上下文会保留，所有命令进入运行账本。</div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['ai', 'shared', 'human'] as const).map((mode) => (
              <button key={mode} style={tabButton(kit.controlMode === mode)} onClick={() => onControlMode(mode)}>
                {mode === 'ai' ? 'AI' : mode === 'human' ? '人工' : '共享'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
          <input style={{ ...inputStyle, fontFamily: 'Consolas, monospace' }}
            disabled={kit.controlMode === 'ai' || running}
            placeholder={kit.controlMode === 'ai' ? 'AI 已接管终端' : '输入一条命令…'}
            value={terminalCommand}
            onChange={(e) => onTerminalCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onTerminalRun(); }} />
          <button style={secondaryButton} disabled={kit.controlMode === 'ai' || running || !terminalCommand.trim()}
            onClick={onTerminalRun}>运行</button>
          {terminalConnected && (
            <button style={dangerButton} disabled={running} onClick={onTerminalClose}>断开</button>
          )}
        </div>
      </section>

      <section style={cardStyle}>
        <div style={cardTitle}>数据连接</div>
        <div style={subtleStyle}>
          依赖：{kit.dependencies.length ? kit.dependencies.join('、') : '无硬依赖'} ·
          可用数据：{dataMarket.length ? dataMarket.map((item) => item.key).join('、') : '暂无'}
        </div>
      </section>

      {runs.length > 1 && (
        <section style={cardStyle}>
          <div style={cardTitle}>最近运行</div>
          {runs.map((item) => {
            const itemMeta = statusMeta[item.status] || statusMeta.error;
            return <div key={item.id} style={historyRow}>
              <span style={{ color: itemMeta.color }}>● {itemMeta.label}</span>
              <span>{new Date(item.createdAt * 1000).toLocaleString()}</span>
              <span>{item.trigger} · {formatDuration(item.startedAt, item.endedAt, now)}</span>
            </div>;
          })}
        </section>
      )}
    </div>
  );
};

const versionSourceLabel: Record<string, string> = {
  create: '初始创建', legacy: '旧版迁移', manual: '人工编辑',
  ai_compile: 'AI 编译', ai_optimize: 'AI 优化',
};

const KitVersionPicker: React.FC<{
  sessionId: string;
  kit: WorkspaceKit;
  running?: boolean;
  compact?: boolean;
  onFeedback?: (text: string, kind: 'ok' | 'error') => void;
}> = ({ sessionId, kit, running = false, compact = false, onFeedback }) => {
  const versions = kit.versions || [];
  const activeId = kit.activeVersionId
    || versions.find((version) => version.isActive)?.id
    || versions[versions.length - 1]?.id
    || '';
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);

  useEffect(() => { setBusy(false); setFeedback(null); }, [kit.id]);

  const report = (text: string, kind: 'ok' | 'error') => {
    if (onFeedback) onFeedback(text, kind);
    else setFeedback({ text, kind });
  };

  const switchVersion = async (versionId: string) => {
    if (!versionId || versionId === activeId || busy) return;
    const target = versions.find((version) => version.id === versionId);
    if (!target) return;
    if (running) {
      report('Kit 正在运行，请先停止后再切换执行版本。', 'error');
      return;
    }
    if (kit.enabled) {
      const confirmed = window.confirm(
        `切换到 ${target.version} 需要先停用 Kit，避免 Schedule 在执行中途换编排。是否停用并继续？`,
      );
      if (!confirmed) return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      if (kit.enabled) {
        const disabled = await api.kitUpdate(sessionId, kit.id, { enabled: false });
        if (disabled.status !== 'ok') {
          report(disabled.message || '停用 Kit 失败，未切换版本。', 'error');
          return;
        }
      }
      const result = await api.kitVersionActivate(sessionId, kit.id, versionId);
      if (result.status !== 'ok') {
        report(result.message || '切换版本失败。', 'error');
        return;
      }
      report(`已切换到 ${target.version}；Kit 保持停用，确认后可重新开启。`, 'ok');
    } catch (error) {
      report(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: compact ? 142 : 180 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...subtleStyle, whiteSpace: 'nowrap' }}>{compact ? '版本' : '执行版本'}</span>
        <select
          aria-label={`${kit.title} 执行版本`}
          style={{ ...inputStyle, width: compact ? 112 : 150, padding: '5px 7px', cursor: versions.length > 1 ? 'pointer' : 'default' }}
          value={activeId}
          disabled={busy || versions.length < 2}
          onChange={(event) => { void switchVersion(event.target.value); }}
        >
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.version}{version.id === activeId ? ' · 当前' : ' · 可选'}
            </option>
          ))}
        </select>
        {busy && <span style={{ ...subtleStyle, color: '#d2a8ff', whiteSpace: 'nowrap' }}>切换中…</span>}
      </label>
      {feedback && (
        <span style={{ ...subtleStyle, color: feedback.kind === 'ok' ? '#56d364' : '#e3b341', maxWidth: 300 }}>
          {feedback.text}
        </span>
      )}
    </div>
  );
};

const KitVersionsCard: React.FC<{
  sessionId: string; kit: WorkspaceKit; running: boolean;
}> = ({ sessionId, kit, running }) => {
  const versions = kit.versions || [];
  const [viewed, setViewed] = useState<KitVersion | null>(null);
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => { setViewed(null); setMessage(''); }, [kit.id]);

  const viewVersion = async (versionId: string) => {
    setBusyId(versionId);
    const result = await api.kitVersionGet(sessionId, kit.id, versionId);
    setBusyId('');
    if (result.status === 'ok' && result.version) {
      setViewed(result.version);
      setMessage('');
    } else {
      setMessage(result.message || '读取版本失败');
    }
  };

  const activate = async (version: KitVersion) => {
    if (kit.enabled) {
      setMessage('先停用 Kit，再切换版本；这样 Schedule 不会在执行中途换编排。');
      return;
    }
    setBusyId(version.id);
    const result = await api.kitVersionActivate(sessionId, kit.id, version.id);
    setBusyId('');
    setMessage(result.status === 'ok' ? `已启用 ${version.version}，Kit 保持停用，确认后可重新开启。` : (result.message || '切换失败'));
  };

  return (
    <section style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div>
          <div style={cardTitle}>版本库</div>
          <div style={subtleStyle}>AI 候选先保存为版本；当前执行版本可在 Kit 标题旁或下方历史中随时选择。</div>
        </div>
        <span style={mutedPill}>{versions.length} 个版本</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {versions.map((version) => {
          const active = version.isActive || version.id === kit.activeVersionId;
          return (
            <div key={version.id} style={versionRowStyle}>
              <strong style={{ color: active ? '#56d364' : 'var(--theme-text)' }}>{version.version}</strong>
              <span style={subtleStyle}>{versionSourceLabel[version.source] || version.source}</span>
              <span style={{ ...subtleStyle, flex: 1 }}>{version.note || '—'}</span>
              <span style={subtleStyle}>{new Date(version.createdAt * 1000).toLocaleString()}</span>
              {active && <span style={{ ...statusPill, color: '#56d364', borderColor: '#3fb95066' }}>当前生效</span>}
              {!active && <span style={{ ...statusPill, color: '#79c0ff', borderColor: '#58a6ff66' }}>可选版本</span>}
              <button style={linkButton} disabled={busyId === version.id} onClick={() => viewVersion(version.id)}>查看 DSL</button>
              {!active && (
                <button style={secondaryButton} disabled={busyId === version.id || running || kit.enabled}
                  title={kit.enabled ? '先停用 Kit，避免 Schedule 冲突' : running ? 'Kit 正在运行' : '切换为这个执行版本'}
                  onClick={() => activate(version)}>启用此版</button>
              )}
            </div>
          );
        })}
      </div>
      {message && <div style={{ ...subtleStyle, marginTop: 8, color: message.startsWith('已启用') ? '#56d364' : '#e3b341' }}>{message}</div>}
      {viewed && (
        <details open style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11 }}>{viewed.version} · Kit DSL</summary>
          <pre style={dslPreviewStyle}>{JSON.stringify(viewed.snapshot || {}, null, 2)}</pre>
        </details>
      )}
    </section>
  );
};

const KitOptimizerPanel: React.FC<{
  sessionId: string; kit: WorkspaceKit; running: boolean; onClose: () => void;
}> = ({ sessionId, kit, running, onClose }) => {
  const draftKey = `agent-with-u:kit-optimizer:${JSON.stringify([getCurrentUserProfile().userId, sessionId, kit.id])}`;
  const [initialDraft] = useState(() => readOptimizerDraft(draftKey));
  const [messages, setMessages] = useState<KitOptimizationMessage[]>([]);
  const [backends, setBackends] = useState<any[]>([]);
  const [backendId, setBackendId] = useState(initialDraft.backendId || '');
  const [prompt, setPrompt] = useState(initialDraft.prompt);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [viewedProposal, setViewedProposal] = useState<KitOptimizationMessage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followMessagesRef = useRef(true);
  const refreshRef = useRef<() => void>(() => {});
  const revisionRef = useRef(0);
  const generatingRef = useRef(false);
  const mountedRef = useRef(true);
  const backendChosenRef = useRef(initialDraft.backendId !== undefined);
  const busy = loading || !historyLoaded || submitting || saving || generating;
  const activeVersion = (kit.versions || []).find((version) => (
    version.isActive || version.id === kit.activeVersionId
  ));

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let refreshAgain = false;
    let observedRevision = '';
    mountedRef.current = true;
    const refresh = async () => {
      if (cancelled) return;
      if (inFlight) { refreshAgain = true; return; }
      inFlight = true;
      const revision = revisionRef.current;
      try {
        const history = await api.kitOptimizeGet(sessionId, kit.id);
        if (cancelled || revision !== revisionRef.current) return;
        if (history.status !== 'ok') throw new Error(history.message || '执行端没有返回 Kit 优化状态');
        setMessages(history.messages || []);
        generatingRef.current = !!history.running || !!history.messages?.some(item => item.status === 'answering');
        setGenerating(generatingRef.current);
        if (!backendChosenRef.current) setBackendId(history.backendId || '');
        setHistoryLoaded(true);
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        inFlight = false;
        if (!cancelled) {
          setLoading(false);
          if (refreshAgain) { refreshAgain = false; void refresh(); }
        }
      }
    };
    refreshRef.current = () => { void refresh(); };
    void refresh();
    // 历史加载不依赖 Backend 列表成功，避免后者延迟把已有对话显示成空白。
    void api.getSessionBackends(sessionId).then(available => {
      if (cancelled) return;
      setBackends(Array.isArray(available) ? available : []);
    }).catch((error) => {
      if (!cancelled) setNotice(error instanceof Error ? error.message : String(error));
    });
    const off = api.onKitUpdated(next => {
      if (next.sessionId !== sessionId) return;
      const updated = next.kits.find(item => item.id === kit.id);
      if (!updated) return;
      const revision = `${updated.optimizationRevision}:${updated.optimizationRunning}:${updated.optimizationMessageCount}:${updated.versions?.length}`;
      if (revision !== observedRevision) { observedRevision = revision; void refresh(); }
    });
    const offConnection = onExecStatus(() => { void refresh(); });
    const timer = window.setInterval(() => {
      if (generatingRef.current && !document.hidden) void refresh();
    }, 3000);
    return () => {
      cancelled = true; mountedRef.current = false; off(); offConnection(); window.clearInterval(timer);
    };
  }, [sessionId, kit.id]);

  const messageRevision = messages.map(item => `${item.id}:${item.status}:${item.finalizedVersionId}`).join('|');
  useEffect(() => {
    const node = scrollRef.current;
    if (node && followMessagesRef.current) node.scrollTop = node.scrollHeight;
  }, [messageRevision, busy]);

  const ask = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    followMessagesRef.current = true;
    setSubmitting(true); setNotice(''); revisionRef.current += 1;
    try {
      const result = await api.kitOptimizeStart(sessionId, kit.id, text, backendId);
      if (!['ok', 'queued'].includes(result.status)) throw new Error(result.message || '提交优化失败');
      if (mountedRef.current) {
        if (result.messages) setMessages(result.messages);
        generatingRef.current = result.running !== false;
        setGenerating(generatingRef.current);
      }
      // 只在服务端接受后清理已发送草稿；不覆盖提交期间新输入的补充。
      if (readOptimizerDraft(draftKey).prompt.trim() === text) {
        writeOptimizerDraft(draftKey, { prompt: '', backendId });
        if (mountedRef.current) setPrompt(current => current.trim() === text ? '' : current);
      }
    } catch (error) {
      if (mountedRef.current) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) { setSubmitting(false); refreshRef.current(); }
    }
  };

  const finalize = async (message: KitOptimizationMessage) => {
    setSaving(true); setNotice('');
    let result;
    try {
      result = await api.kitOptimizeFinalize(sessionId, kit.id, message.id, message.content.slice(0, 500), false);
    } catch (error) {
      if (mountedRef.current) setNotice(error instanceof Error ? error.message : String(error));
      return;
    } finally { if (mountedRef.current) setSaving(false); }
    if (!mountedRef.current) return;
    if (result.status !== 'ok' || !result.version) {
      setNotice(result.message || '保存候选版本失败');
      return;
    }
    setMessages((current) => current.map((item) => (
      item.id === message.id ? { ...item, finalizedVersionId: result.version!.id } : item
    )));
    setViewedProposal((current) => current?.id === message.id
      ? { ...current, finalizedVersionId: result.version!.id }
      : current);
    setNotice(`${result.version.version} 已保存到版本库；当前执行版本未变化，可从上方版本选择器切换。`);
  };

  return (
    <div className="awu-kit-optimizer-overlay" style={optimizerOverlayStyle} onMouseDown={event => event.stopPropagation()}>
      <section role="dialog" aria-label={`优化 Kit：${kit.title}`} style={optimizerPanelStyle}>
        <header className="awu-kit-optimizer-header" style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div className="awu-kit-optimizer-heading" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>✨ 优化 · {kit.title}</strong>
              <span style={experimentBadge}>独立 AI 对话</span>
            </div>
            <div style={{ ...subtleStyle, marginTop: 4 }}>
              当前执行 {activeVersion?.version || '—'} · AI 生成的 DSL 需要由你保存为候选版本
            </div>
          </div>
          <div className="awu-kit-optimizer-actions" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <select style={{ ...inputStyle, width: 220 }} aria-label="优化 Backend" value={backendId} onChange={(event) => {
              backendChosenRef.current = true; setBackendId(event.target.value);
              writeOptimizerDraft(draftKey, { prompt, backendId: event.target.value });
            }}>
              <option value="">跟随 Session Backend</option>
              {backends.map((backend) => <option key={backend.id} value={backend.id}>{backend.label || backend.id}</option>)}
            </select>
            <button style={iconButton} aria-label="关闭优化窗口" title="关闭窗口，不会取消后台优化；再次打开可继续查看" onClick={onClose}>×</button>
          </div>
        </header>

        <div className="awu-kit-optimizer-version-bar" style={optimizerVersionBarStyle}>
          <div style={{ minWidth: 0 }}>
            <strong style={{ fontSize: 11.5 }}>Kit 版本库</strong>
            <div style={{ ...subtleStyle, marginTop: 3 }}>
              候选保存后不会自动影响运行；需要时从这里选择执行版本。
            </div>
          </div>
          <KitVersionPicker sessionId={sessionId} kit={kit} running={running} />
        </div>

        <div ref={scrollRef} style={optimizerMessagesStyle} onScroll={event => {
          const node = event.currentTarget;
          followMessagesRef.current = node.scrollHeight - node.clientHeight - node.scrollTop < 60;
        }}>
          {loading && <div role="status" style={optimizerEmptyStyle}>正在恢复优化对话…</div>}
          {historyLoaded && !loading && !generating && messages.length === 0 && (
            <div style={optimizerEmptyStyle}>
              <strong>从当前生效 DSL 继续优化</strong>
              <span>例如：“把停止服务拆成定位 PID、关闭进程树、复核残留三个步骤，并强化不能误杀其他 Java 的判言。”</span>
            </div>
          )}
          {messages.map((message) => (
            <div key={message.id} style={{
              ...optimizerBubbleStyle,
              alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
              background: message.role === 'user' ? 'rgba(88,166,255,.14)' : 'var(--theme-bg-secondary, rgba(255,255,255,.04))',
            }}>
              <div style={{ ...subtleStyle, marginBottom: 5 }}>
                {message.role === 'user' ? '你' : `AI · ${backends.find((item) => item.id === message.backendId)?.label || message.backendId || 'Session Backend'}`}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 12.5 }}>{message.content}</div>
              {!!message.blockingIssues?.length && (
                <div style={{ color: '#ff9b93', marginTop: 8, fontSize: 11 }}>
                  {message.blockingIssues.map((item) => <div key={item}>⛔ 阻断：{item}</div>)}
                </div>
              )}
              {!!message.questions?.length && <div style={{ color: '#ff9b93', marginTop: 8, fontSize: 11 }}>{message.questions.map((item) => <div key={item}>？ 待确认：{item}</div>)}</div>}
              {!!message.warnings?.length && <div style={{ color: '#e3b341', marginTop: 8, fontSize: 11 }}>{message.warnings.map((item) => <div key={item}>△ 提示：{item}</div>)}</div>}
              {message.role === 'assistant' && message.proposal && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
                  <button style={secondaryButton} onClick={() => setViewedProposal(message)}>查看候选 DSL</button>
                  {message.ready && !message.finalizedVersionId && (
                    <button style={primaryButton} disabled={busy}
                      title="保存到 Kit 版本库；不会自动切换当前执行版本"
                      onClick={() => finalize(message)}>＋ 保存为候选版本</button>
                  )}
                  {message.finalizedVersionId && <span style={{ ...statusPill, color: '#56d364', borderColor: '#3fb95066' }}>✓ 已存为版本</span>}
                  {!message.ready && (
                    <span style={{ ...statusPill, color: '#ff9b93', borderColor: '#f8514966' }}>
                      {message.blockingIssues?.length
                        ? `需处理 ${message.blockingIssues.length} 个阻断项`
                        : message.questions?.length
                          ? `需确认 ${message.questions.length} 个问题`
                          : '尚不可保存'}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
          {(generating || submitting) && <div role="status" style={{ ...optimizerBubbleStyle, alignSelf: 'flex-start', color: '#d2a8ff' }}>
            {submitting ? '正在提交优化任务…' : 'AI 正在后台生成候选，关闭窗口不会中断；再次打开可查看进度和结果。'}
          </div>}
        </div>

        {notice && <div style={{ padding: '7px 14px', color: notice.includes('已保存') ? '#56d364' : '#e3b341', fontSize: 11.5 }}>
          {notice} <button style={linkButton} onClick={() => refreshRef.current()}>刷新状态</button>
        </div>}
        <footer className="awu-kit-optimizer-composer" style={optimizerComposerStyle}>
          <textarea style={{ ...inputStyle, minHeight: 66, resize: 'vertical' }} value={prompt}
            placeholder="继续描述你不满意的地方、希望增加的步骤或更严格的成功标准…"
            onChange={(event) => {
              setPrompt(event.target.value); writeOptimizerDraft(draftKey, { prompt: event.target.value, backendId });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void ask(); }
            }} />
          <button style={primaryButton} disabled={busy || !prompt.trim()} onClick={ask}>发送并生成候选</button>
        </footer>

        {viewedProposal && (
          <div style={dslOverlayStyle}>
            <div style={dslDialogStyle} onMouseDown={(event) => event.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 13 }}>候选 Kit DSL</strong>
                <button style={iconButton} onClick={() => setViewedProposal(null)}>×</button>
              </div>
              <div style={{ ...subtleStyle, marginTop: 7 }}>
                这是对话生成的候选，还不会参与运行。确认后先保存进版本库，再选择是否切换执行版本。
              </div>
              {!!viewedProposal.blockingIssues?.length && (
                <div style={{ marginTop: 8, color: '#ff9b93', fontSize: 11.5 }}>
                  {viewedProposal.blockingIssues.map((item) => <div key={item}>⛔ {item}</div>)}
                </div>
              )}
              {!!viewedProposal.warnings?.length && (
                <div style={{ marginTop: 8, color: '#e3b341', fontSize: 11.5 }}>
                  {viewedProposal.warnings.map((item) => <div key={item}>△ {item}</div>)}
                </div>
              )}
              <pre style={{ ...dslPreviewStyle, maxHeight: '62vh' }}>{JSON.stringify(viewedProposal.proposal || {}, null, 2)}</pre>
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 10 }}>
                {viewedProposal.finalizedVersionId ? (
                  <span style={{ ...statusPill, color: '#56d364', borderColor: '#3fb95066' }}>✓ 已保存到版本库</span>
                ) : viewedProposal.ready ? (
                  <button style={primaryButton} disabled={busy}
                    onClick={() => finalize(viewedProposal)}>＋ 保存为候选版本</button>
                ) : (
                  <span style={{ ...statusPill, color: '#ff9b93', borderColor: '#f8514966' }}>
                    {viewedProposal.blockingIssues?.length
                      ? `存在 ${viewedProposal.blockingIssues.length} 个阻断项`
                      : viewedProposal.questions?.length
                        ? `仍有 ${viewedProposal.questions.length} 个问题待确认`
                        : '候选不完整，暂不可保存'}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};

const ContractLine: React.FC<{
  label: string; text: string; tone?: 'success' | 'warning';
}> = ({ label, text, tone }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: 8, marginTop: 7, fontSize: 12 }}>
    <span style={{ color: tone === 'success' ? '#56d364' : tone === 'warning' ? '#e3b341' : 'var(--theme-text-muted)' }}>{label}</span>
    <span style={{ lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{text}</span>
  </div>
);

const LogBlock: React.FC<{ title: string; text: string; tone?: 'error' }> = ({ title, text, tone }) => (
  <details style={{ marginTop: 10 }} open={!!text}>
    <summary style={{ fontSize: 11, cursor: 'pointer', color: tone === 'error' ? '#ff7b72' : 'var(--theme-text-muted)' }}>
      {title} · {text ? `${text.length} 字符` : '空'}
    </summary>
    <pre style={{
      margin: '7px 0 0', padding: 10, maxHeight: 260, overflow: 'auto',
      borderRadius: 7, background: '#0d1117', color: tone === 'error' ? '#ff9b93' : '#c9d1d9',
      fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    }}>{text || '（无输出）'}</pre>
  </details>
);

const DataMarket: React.FC<{ state: WorkspaceKitState }> = ({ state }) => (
  <div style={{ padding: 18, overflow: 'auto', flex: 1 }}>
    <div style={sectionTitle}>Session 数据市场</div>
    <div style={{ ...subtleStyle, marginBottom: 14 }}>
      每个成功运行可以发布带来源的类型化数据；其他 Kit 用输入的 sourceKey 声明依赖并自动消费最新版本。
    </div>
    {state.dataMarket.length === 0 ? (
      <div style={emptyMainStyle}>还没有数据。给 Kit 配置输出并成功运行一次。</div>
    ) : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
        {state.dataMarket.map((item) => (
          <article key={item.id} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{item.label}</strong>
              <code style={dataKeyStyle}>{item.key}</code>
            </div>
            <div style={{ ...subtleStyle, marginTop: 6 }}>
              {item.type} · {new Date(item.createdAt * 1000).toLocaleString()}
            </div>
            <pre style={dataPreviewStyle}>{asDisplay(item.value).slice(0, 1600)}</pre>
            <div style={{ ...subtleStyle, marginTop: 7 }}>Kit {item.kitId.slice(0, 8)} · Run {item.runId.slice(0, 8)}</div>
          </article>
        ))}
      </div>
    )}
  </div>
);

const overlayStyle: React.CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 80,
  background: 'rgba(0,0,0,.38)', display: 'flex', justifyContent: 'flex-end',
};
const panelStyle: React.CSSProperties = {
  width: 'min(920px, 96%)', height: '100%', display: 'flex', flexDirection: 'column',
  background: 'var(--theme-bg, #161b22)', color: 'var(--theme-text, #e6edf3)',
  borderLeft: '1px solid var(--theme-border)', boxShadow: '-10px 0 35px rgba(0,0,0,.28)',
};
const headerStyle: React.CSSProperties = {
  minHeight: 'var(--ui-panel-header-height, 60px)', padding: 'var(--ui-space-md, 10px) var(--ui-space-lg, 14px)', boxSizing: 'border-box',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
  borderBottom: '1px solid var(--theme-border)',
};
const bodyStyle: React.CSSProperties = { display: 'flex', flex: 1, minHeight: 0 };
const sidebarStyle: React.CSSProperties = {
  width: 220, flex: '0 0 220px', padding: 10, overflow: 'auto',
  borderRight: '1px solid var(--theme-border)', boxSizing: 'border-box',
};
const mainStyle: React.CSSProperties = { flex: 1, minWidth: 0, minHeight: 0 };
const compactListStyle: React.CSSProperties = {
  flex: 1, minHeight: 0, overflow: 'auto', padding: 'var(--ui-space-lg, 18px)', boxSizing: 'border-box',
};
const compactListToolbar: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
  marginBottom: 'var(--ui-space-md, 14px)',
};
const compactKitGrid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
  gap: 10, alignContent: 'start',
};
const compactKitCard: React.CSSProperties = {
  border: '1px solid var(--theme-border, rgba(255,255,255,.12))',
  background: 'var(--theme-bg-secondary, rgba(255,255,255,.025))',
  borderRadius: 10, padding: 'var(--ui-section-padding, 13px)', minWidth: 0, minHeight: 'var(--ui-kit-card-height, 248px)',
  display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
};
const compactKitFooter: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--ui-space-sm, 10px)',
  marginTop: 'auto', paddingTop: 'var(--ui-space-md, 13px)',
};
const compactKitActions: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap',
};
const sectionTitle: React.CSSProperties = { fontSize: 16, fontWeight: 650, marginBottom: 14 };
const cardTitle: React.CSSProperties = { fontSize: 12, fontWeight: 650, marginBottom: 9 };
const subtleStyle: React.CSSProperties = { fontSize: 11, color: 'var(--theme-text-muted, #8b949e)' };
const cardStyle: React.CSSProperties = {
  border: '1px solid var(--theme-border, rgba(255,255,255,.12))',
  background: 'var(--theme-bg-secondary, rgba(255,255,255,.025))',
  borderRadius: 9, padding: 'var(--ui-section-padding, 12px)', marginTop: 'var(--ui-space-md, 12px)',
};
const experimentBadge: React.CSSProperties = {
  fontSize: 10, padding: '2px 6px', borderRadius: 9,
  color: '#d2a8ff', border: '1px solid rgba(210,168,255,.35)', background: 'rgba(210,168,255,.08)',
};
const statusPill: React.CSSProperties = {
  flex: '0 0 auto', whiteSpace: 'nowrap', fontSize: 10,
  border: '1px solid', padding: '2px 7px', borderRadius: 10,
};
const mutedPill: React.CSSProperties = { ...statusPill, color: '#8b949e', borderColor: '#6e768166' };
const durationPill: React.CSSProperties = {
  minWidth: 68, textAlign: 'right', fontSize: 10, fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', borderRadius: 6, padding: '7px 9px',
  color: 'var(--theme-text)', background: 'var(--theme-bg-tertiary, #0d1117)',
  border: '1px solid var(--theme-border)', fontSize: 12, outline: 'none',
};
const miniInput: React.CSSProperties = { ...inputStyle, width: 'auto', minWidth: 80, flex: '0 1 150px', padding: '5px 7px' };
const twoColumns: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'var(--awu-kit-columns, repeat(2, minmax(0, 1fr)))', gap: 10 };
const blockLabel: React.CSSProperties = { display: 'block', marginTop: 10 };
const editorGroup: React.CSSProperties = { ...cardStyle, marginTop: 14 };
const editorRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
const tinyCheck: React.CSSProperties = { fontSize: 11, display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' };
const primaryButton: React.CSSProperties = {
  border: '1px solid rgba(88,166,255,.65)', background: 'rgba(88,166,255,.16)',
  color: 'var(--theme-text)', borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontSize: 12,
};
const secondaryButton: React.CSSProperties = {
  border: '1px solid var(--theme-border)', background: 'var(--theme-bg-tertiary, rgba(255,255,255,.04))',
  color: 'var(--theme-text)', borderRadius: 7, padding: '6px 10px', cursor: 'pointer', fontSize: 11,
};
const dangerButton: React.CSSProperties = { ...secondaryButton, borderColor: 'rgba(248,81,73,.5)', color: '#ff7b72' };
const dangerMini: React.CSSProperties = { ...secondaryButton, color: '#ff7b72', padding: '4px 7px' };
const linkButton: React.CSSProperties = { border: 0, background: 'transparent', color: 'var(--theme-accent, #58a6ff)', cursor: 'pointer', fontSize: 11 };
const iconButton: React.CSSProperties = { ...secondaryButton, fontSize: 18, padding: '1px 9px' };
const tabButton = (active: boolean): React.CSSProperties => ({
  ...secondaryButton,
  color: active ? 'var(--theme-accent, #58a6ff)' : 'var(--theme-text-muted)',
  borderColor: active ? 'rgba(88,166,255,.45)' : 'var(--theme-border)',
  background: active ? 'rgba(88,166,255,.10)' : 'transparent',
});
const kitListButton: React.CSSProperties = {
  width: '100%', display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left',
  color: 'var(--theme-text)', border: '1px solid transparent', borderRadius: 7,
  padding: '9px 7px', cursor: 'pointer', marginBottom: 4,
};
const emptyMainStyle: React.CSSProperties = {
  height: '100%', minHeight: 160, display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: 'var(--theme-text-muted)', fontSize: 12,
};
const assertionRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
  borderBottom: '1px solid var(--theme-border)', fontSize: 12,
};
const runMetaGrid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6,
  fontSize: 11, color: 'var(--theme-text-muted)',
};
const historyRow: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '80px 1fr 110px', gap: 8,
  padding: '6px 0', fontSize: 11, borderBottom: '1px solid var(--theme-border)',
};
const versionRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
  padding: '7px 0', borderBottom: '1px solid var(--theme-border)', fontSize: 11,
};
const dslPreviewStyle: React.CSSProperties = {
  margin: '8px 0 0', padding: 10, maxHeight: 360, overflow: 'auto',
  borderRadius: 7, background: '#0d1117', color: '#c9d1d9', fontSize: 10.5,
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'Consolas, monospace',
};
const generationMetricStyle: React.CSSProperties = {
  minWidth: 0, padding: '9px 10px', borderRadius: 7,
  border: '1px solid var(--theme-border)', background: 'rgba(13,17,23,.34)',
};
const generationMetricLabelStyle: React.CSSProperties = {
  display: 'block', color: 'var(--theme-text-muted)', fontSize: 10, marginBottom: 4,
};
const generationMetricValueStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 650, overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
};
const generationPaneStyle: React.CSSProperties = {
  minWidth: 0, overflow: 'hidden', borderRadius: 8,
  border: '1px solid var(--theme-border)', background: 'rgba(13,17,23,.58)',
};
const generationPaneHeaderStyle: React.CSSProperties = {
  minHeight: 38, boxSizing: 'border-box', padding: '8px 10px', display: 'flex',
  alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11.5,
  borderBottom: '1px solid var(--theme-border)',
};
const generationOutputStyle: React.CSSProperties = {
  height: 330, maxHeight: 330, margin: 0, padding: 12, boxSizing: 'border-box', overflow: 'auto',
  whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: '#c9d1d9', background: '#0d1117',
  font: '11.5px/1.6 Consolas, "SFMono-Regular", monospace', tabSize: 2,
};
const generationActivityDetailStyle: React.CSSProperties = {
  maxHeight: 150, margin: '5px 0 0', padding: 7, overflow: 'auto', whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere', borderRadius: 5, color: '#b1bac4', background: '#0d1117',
  font: '10px/1.5 Consolas, monospace',
};
const optimizerOverlayStyle: React.CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 4, display: 'flex', justifyContent: 'flex-end',
  background: 'rgba(0,0,0,.52)',
};
const optimizerPanelStyle: React.CSSProperties = {
  width: 'min(760px, 96%)', height: '100%', display: 'flex', flexDirection: 'column',
  background: 'var(--theme-bg, #161b22)', color: 'var(--theme-text, #e6edf3)',
  borderLeft: '1px solid var(--theme-border)', boxShadow: '-12px 0 40px rgba(0,0,0,.35)',
};
const optimizerVersionBarStyle: React.CSSProperties = {
  minHeight: 52, padding: '8px 14px', boxSizing: 'border-box',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
  borderBottom: '1px solid var(--theme-border)', background: 'rgba(88,166,255,.045)',
};
const optimizerMessagesStyle: React.CSSProperties = {
  flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column',
  gap: 10, padding: 16, boxSizing: 'border-box',
};
const optimizerBubbleStyle: React.CSSProperties = {
  maxWidth: '88%', minWidth: 180, padding: '10px 12px', borderRadius: 10,
  border: '1px solid var(--theme-border)', boxSizing: 'border-box',
};
const optimizerEmptyStyle: React.CSSProperties = {
  margin: 'auto', maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 8,
  textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 12, lineHeight: 1.6,
};
const optimizerComposerStyle: React.CSSProperties = {
  padding: 12, borderTop: '1px solid var(--theme-border)', display: 'flex',
  alignItems: 'flex-end', gap: 8,
};
const dslOverlayStyle: React.CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 6, display: 'flex', alignItems: 'center',
  justifyContent: 'center', padding: 20, background: 'rgba(0,0,0,.58)', boxSizing: 'border-box',
};
const dslDialogStyle: React.CSSProperties = {
  width: 'min(720px, 96%)', maxHeight: '86%', overflow: 'hidden', padding: 14,
  borderRadius: 10, border: '1px solid var(--theme-border)',
  background: 'var(--theme-bg, #161b22)', boxShadow: '0 18px 55px rgba(0,0,0,.45)',
};
const dataKeyStyle: React.CSSProperties = {
  fontSize: 10, color: '#79c0ff', background: 'rgba(88,166,255,.1)', padding: '2px 5px', borderRadius: 4,
};
const dataPreviewStyle: React.CSSProperties = {
  margin: '9px 0 0', padding: 8, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap',
  wordBreak: 'break-word', borderRadius: 6, background: '#0d1117', color: '#c9d1d9', fontSize: 10,
};
