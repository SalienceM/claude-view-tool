import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { api } from '../api';
import { mergeSessionRouting } from '../utils/sessionRouting';
import type { CurrentUserProfile, FollowUpCapabilities } from '../api';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { PermissionGate } from './PermissionGate';
import { LoopPanel } from './LoopPanel';
import { SeqTaskPanel } from './SeqTaskPanel';
import type { SeqTaskT } from './SeqTaskPanel';
import { WorkspaceKitsPanel } from './WorkspaceKitsPanel';
import { useChat } from '../hooks/useChat';
import type { ChatMessage } from '../hooks/useChat';
import type { AppConfig } from '../hooks/useConfig';
import { HACKER_CAPTURE_EVENT } from '../utils/hackerMode';
import type { SmoothGhostState } from '../utils/smoothGhost';
import { normalizeModelRuntime, type ModelRuntime } from './CodexRuntimeFields';
import type { TextAttachment } from '../types/attachments';
import { buildMessageRedoPayload } from '../utils/messageRedo';
import { TokenUsageMonitor } from './TokenUsageMonitor';
import { uuid } from '../utils/uuid';

function mergeAuthoritativeSeqTasks(authoritative: SeqTaskT[], current: SeqTaskT[]): SeqTaskT[] {
  const canonical = (authoritative || []).map((task) => ({ ...task, syncing: false }));
  const matched = new Set<number>();
  const optimistic = current.filter((task) => task.syncing).filter((pending) => {
    const pendingImages = pending.imageCount ?? pending.images?.length ?? 0;
    const pendingAttachments = pending.textAttachmentCount ?? pending.textAttachments?.length ?? 0;
    const match = canonical.findIndex((task, index) => {
      if (matched.has(index) || task.status !== 'pending' || task.text !== pending.text) return false;
      const images = task.imageCount ?? task.images?.length ?? 0;
      const attachments = task.textAttachmentCount ?? task.textAttachments?.length ?? 0;
      const closeInTime = !task.createdAt || !pending.createdAt
        || Math.abs(task.createdAt - pending.createdAt) < 15;
      return images === pendingImages && attachments === pendingAttachments && closeInTime;
    });
    if (match < 0) return true;
    matched.add(match);
    return false;
  });
  return [...canonical, ...optimistic];
}

function messageEpochMs(timestamp?: number): number {
  if (!timestamp || !Number.isFinite(timestamp)) return 0;
  return timestamp > 100_000_000_000 ? timestamp : timestamp * 1000;
}

function localDateKey(timestamp?: number): string {
  const epoch = messageEpochMs(timestamp);
  if (!epoch) return '';
  const date = new Date(epoch);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

const MessageDateDivider: React.FC<{ timestamp: number }> = ({ timestamp }) => {
  const date = new Date(messageEpochMs(timestamp));
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const relative = sameLocalDay(date, today)
    ? '今天'
    : sameLocalDay(date, yesterday) ? '昨天' : '';
  const full = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  }).format(date);
  return (
    <div className="awu-date-divider" role="separator" aria-label={full}>
      <span>{relative ? `${relative} · ${full}` : full}</span>
    </div>
  );
};

// 注入「等待气泡」用的脉冲点动画(一次性)。请求发出后到首个 delta 之间,
// 旧版只靠底部「生成中」chip,聊天区空白让人怀疑后端是不是没收到;这里
// 在消息列表里挂一个占位气泡兜底反馈。
if (typeof document !== 'undefined' && !document.getElementById('awu-pending-bubble-css')) {
  const s = document.createElement('style');
  s.id = 'awu-pending-bubble-css';
  s.textContent = `
    @keyframes awu-pending-dot { 0%,80%,100% { opacity: 0.25; } 40% { opacity: 1; } }
    .awu-pending-dot { display: inline-block; width: 6px; height: 6px; margin: 0 2px;
                       border-radius: 50%; background: currentColor;
                       animation: awu-pending-dot 1.4s infinite ease-in-out both; }
    .awu-pending-dot:nth-child(2) { animation-delay: 0.18s; }
    .awu-pending-dot:nth-child(3) { animation-delay: 0.36s; }
  `;
  document.head.appendChild(s);
}

const PendingAssistantBubble: React.FC = () => (
  <div style={{ display: 'flex', justifyContent: 'flex-start', padding: '4px 16px' }}>
    <div style={{
      maxWidth: '70%', padding: '10px 14px', borderRadius: 7,
      background: 'var(--theme-bg-secondary, rgba(255,255,255,0.04))',
      color: 'var(--theme-text-muted, #8b8b9b)',
      fontSize: 13, display: 'flex', alignItems: 'center', gap: 4,
    }}>
      <span style={{ marginRight: 4 }}>已收到，等待响应</span>
      <span className="awu-pending-dot"></span>
      <span className="awu-pending-dot"></span>
      <span className="awu-pending-dot"></span>
    </div>
  </div>
);

// ChatPane: 自给自足的单 session 工作区。
// 每个 pane 内部:
//   1. 调用 useChat —— 独立的流式状态、消息列表、权限气泡
//   2. 维护自己的滚动状态(autoScroll / 跟踪最新按钮)
//   3. 历史分页:首次只加载最近若干条,顶部「↑ load earlier」按需翻页
//   4. 维护自己的 activeSession 详情 (workingDir / backendId / skipPermissions / sandboxEnabled)
//   5. 渲染消息列表 + 权限气泡 + ChatInput
//
// 多 pane 之间不直接通信;App 通过 onStreamingChange 回调聚合
// "哪些 session 在流式" 状态,用于侧边栏指示灯。

export interface ChatPaneProps {
  paneId: number;                           // 0/1/2/3, 用于 React key
  sessionId: string | null;                 // null = 空 pane
  isFocused: boolean;                       // 是否当前焦点 pane
  isVisible?: boolean;                      // Tab 隐藏时保留实例，但不能改写不可见容器的滚动位置
  onFocus: () => void;                      // 点击 pane 时调用
  backends: any[];                          // 共享 backends 列表
  config: AppConfig;                        // 共享配置(fontSize, renderMarkdown)
  currentUser: CurrentUserProfile;          // 当前已验证用户，用于消息头像
  themeBorderFocused: string;               // 焦点边框色
  isMobile: boolean;
  onRequestNewSession: () => void;          // 用户在这个 pane 想新建 session 时
  onSessionDeleted?: (id: string) => void;  // 删除 session 后回调,清掉这个 pane
  // 系统级 toast / 错误提示(预留, 当前未使用)
  onToast?: (type: 'success' | 'error' | 'info', message: string) => void;
  // 流式状态变化回调,App 用来聚合所有 pane 的 streaming 状态
  onStreamingChange?: (sessionId: string, streaming: boolean) => void;
  onGhostStateChange?: (state: SmoothGhostState) => void;
  // 对话字号步进(全局 config.fontSize),由 App 注入
  onAdjustFontSize?: (delta: number) => void;
  onRequestFileFocus?: (request: {
    sessionId: string;
    workingDir: string;
    relativePath: string;
  }) => void;
}

export const ChatPane: React.FC<ChatPaneProps> = ({
  paneId,
  sessionId,
  isFocused,
  isVisible = true,
  onFocus,
  backends,
  config,
  currentUser,
  themeBorderFocused,
  isMobile,
  onRequestNewSession,
  onToast,
  onStreamingChange,
  onGhostStateChange,
  onAdjustFontSize,
  onRequestFileFocus,
}) => {
  // ── pane 自己的 session 详情(workingDir / backendId / skip / sandbox) ──
  const [activeSession, setActiveSession] = useState<any | null>(() => sessionId ? api.peekSessionMeta(sessionId) : null);
  const [nodeBackends, setNodeBackends] = useState<any[]>(backends);
  const [loopRunning, setLoopRunning] = useState(false);
  const [realtimeVoiceActive, setRealtimeVoiceActive] = useState(false);
  // 权限 state: 初值从 session 读,变化时持久化
  const [skipPermissions, setSkipPermissions] = useState(true);
  // 可见消息条数(切换 session / 切回历史时只显示最近几条)
  // visibleCount 已废:历史分页由后端 + chat.loadEarlier() 控制,前端不再折叠

  // 滚动相关 refs (与 App 原有一致)
  const endRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const prevStreamingRef = useRef(false);
  const animSessionRef = useRef<string | null>(null);
  const animMsgCountRef = useRef(0);
  const prevSessionRef = useRef<string | null>(sessionId);
  const onFocusRef = useRef(onFocus);
  const onRequestFileFocusRef = useRef(onRequestFileFocus);
  onFocusRef.current = onFocus;
  onRequestFileFocusRef.current = onRequestFileFocus;

  useLayoutEffect(() => {
    setActiveSession(sessionId ? api.peekSessionMeta(sessionId) : null);
    setLoopRunning(false);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let eventRevision = 0;
    const unsubscribeLoop = api.onLoopUpdated((state: any) => {
      if (state?.sessionId !== sessionId) return;
      eventRevision++;
      setActiveSession((current: any) => mergeSessionRouting(
        current?.id === sessionId ? current : api.peekSessionMeta(sessionId),
        {
          id: sessionId, sessionType: 'loop',
          loopControlMode: state.controlMode,
        },
      ));
      if (typeof state.running === 'boolean') setLoopRunning(state.running);
    });
    const unsubscribeSession = api.onSessionUpdated((data: any) => {
      if (data?.sessionId !== sessionId || !data.summary) return;
      eventRevision++;
      setActiveSession((current: any) => mergeSessionRouting(
        current?.id === sessionId ? current : api.peekSessionMeta(sessionId), data.summary,
      ));
    });
    const requestRevision = eventRevision;
    api.loadSessionMeta(sessionId).then((session) => {
      if (cancelled || !session) return;
      setActiveSession((current: any) => eventRevision === requestRevision
        ? mergeSessionRouting(current?.id === sessionId ? current : null, session)
        : mergeSessionRouting(session, current?.id === sessionId ? current : api.peekSessionMeta(sessionId)));
      if (eventRevision === requestRevision) setLoopRunning(session.loopRunning === true);
      if (session.skipPermissions !== undefined) setSkipPermissions(session.skipPermissions);
    });
    return () => { cancelled = true; unsubscribeLoop(); unsubscribeSession(); };
  }, [sessionId]);

  // Backend configuration belongs to the executor that owns the session.
  useEffect(() => {
    const execKey = activeSession?.execKey;
    if (!execKey) {
      setNodeBackends(backends);
      return;
    }
    let cancelled = false;
    setNodeBackends([]);
    api.getBackends(execKey)
      .then((list) => { if (!cancelled) setNodeBackends(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setNodeBackends([]); });
    return () => { cancelled = true; };
  }, [activeSession?.execKey, backends]);

  const effectiveBackends = activeSession?.execKey ? nodeBackends : backends;
  const activeBackendId = activeSession?.backendId || effectiveBackends[0]?.id || '';
  const activeBackendLabel = effectiveBackends.find((item) => item.id === activeBackendId)?.label
    || activeBackendId
    || '当前 Backend';
  const sessionMetaReady = !!sessionId && activeSession?.id === sessionId
    && (activeSession.sessionType !== 'loop'
      || activeSession.loopControlMode === 'manual' || activeSession.loopControlMode === 'loop');
  const automatedLoop = sessionMetaReady
    && activeSession?.sessionType === 'loop'
    && activeSession.loopControlMode === 'loop';
  const chatHydrationEnabled = sessionMetaReady && !automatedLoop;

  const handleFocusLinkedFile = useCallback((relativePath: string) => {
    const workingDir = activeSession?.workingDir;
    if (!sessionId || activeSession?.id !== sessionId || !workingDir) return;
    onFocusRef.current();
    onRequestFileFocusRef.current?.({ sessionId, workingDir, relativePath });
  }, [sessionId, activeSession?.id, activeSession?.workingDir]);

  const handleSessionRuntimeChange = useCallback(async (runtime: ModelRuntime) => {
    if (!sessionId) return { status: 'error', message: 'Session 不存在' };
    const normalized = normalizeModelRuntime(runtime);
    const result = await api.updateSessionRuntime(sessionId, normalized);
    if (result.status === 'ok') {
      const applied = result.runtime || normalized;
      setActiveSession((current: any) => current ? {
        ...current,
        modelOverride: applied.model,
        reasoningEffort: applied.reasoningEffort,
      } : current);
    }
    return result;
  }, [sessionId]);

  // ── /new 命令处理:复用 workingDir + backendId,免弹窗静默新建 ──
  // 注意:静默新建会切换当前 pane 的 session,需要走 onRequestNewSession 上抛
  // 让 App 决定如何处理。这里简化处理:直接打开新建对话框。
  const handleQuickNewSession = useCallback(async () => {
    onRequestNewSession();
  }, [onRequestNewSession]);

  const handleClearContext = useCallback(async () => {
    if (!sessionId) return;
    await api.clearSessionContext(sessionId);
  }, [sessionId]);

  // ── 核心 useChat 调用 ──
  const chat = useChat(
    sessionId || '',
    activeBackendId,
    effectiveBackends,
    skipPermissions,
    handleQuickNewSession,
    handleClearContext,
    {
      modelOverride: activeSession?.modelOverride,
      reasoningEffort: activeSession?.reasoningEffort,
    },
    chatHydrationEnabled,
  );

  // ── 向 App 上报权威运行态,用于侧边栏指示灯 ──
  // 自动 LOOP 为了秒开不会水合 chat，因此不能再只看 chat.isStreaming。
  useEffect(() => {
    if (!sessionId) return;
    if (!automatedLoop && chat.resolvedSessionId !== sessionId) return;
    onStreamingChange?.(sessionId, automatedLoop ? loopRunning : chat.isStreaming);
  }, [sessionId, automatedLoop, loopRunning, chat.isStreaming, chat.resolvedSessionId, onStreamingChange]);

  // Attached Codex sessions are shared native threads, not static imports.
  // Only the focused, idle pane checks them.  The backend turns the frequent
  // local case into one cheap mtime/size stat and starts app-server only after
  // the rollout changed; SSH checks are throttled much more aggressively.
  useEffect(() => {
    if (
      !sessionId
      || !isFocused
      || activeSession?.codexThreadAttached !== true
      || chat.isStreaming
    ) return;

    let cancelled = false;
    let checking = false;
    let retryTimer: number | null = null;
    const check = async () => {
      if (cancelled || checking || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        const result = await api.syncAttachedCodexSession(sessionId);
        if (
          !cancelled
          && result.status !== 'error'
          && result.retryAfterMs
          && retryTimer === null
        ) {
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            void check();
          }, Math.max(500, Math.min(result.retryAfterMs || 0, 30_000)));
        }
      } finally {
        checking = false;
      }
    };
    const onFocus = () => { void check(); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void check();
    };
    void check();
    const interval = window.setInterval(() => { void check(); }, 10_000);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [
    sessionId,
    isFocused,
    activeSession?.codexThreadAttached,
    chat.isStreaming,
  ]);

  // ── 序列任务队列 + by-the-way（普通 session 侧挂状态）──
  const [seqTasks, setSeqTasks] = useState<SeqTaskT[]>([]);
  const [seqQueueError, setSeqQueueError] = useState('');
  const [followUpCapabilities, setFollowUpCapabilities] = useState<FollowUpCapabilities>({
    status: 'ok', queue: true, nativeSteer: false,
    interruptResume: false, steerAttachments: false,
  });
  const [workspaceKitsOpen, setWorkspaceKitsOpen] = useState(false);
  useEffect(() => {
    if (!config.workspaceKitsEnabled) setWorkspaceKitsOpen(false);
  }, [config.workspaceKitsEnabled]);
  const dispatchingRef = useRef(false);
  const seqRetryTimerRef = useRef<number | null>(null);
  const dispatchNextRef = useRef<() => void>(() => {});
  const seqPendingRef = useRef(false);
  const seqViewSessionRef = useRef(sessionId);
  seqViewSessionRef.current = sessionId;
  // 新输入在模型忙碌时会自动排队并激活本轮连续派发。应用重启后保留的
  // 历史队列不会擅自恢复，需要用户在队列条上点一次继续。
  const [seqChainActive, setSeqChainActive] = useState(false);
  const seqChainSessionRef = useRef<string | null>(null);
  const setChain = useCallback((v: boolean) => { setSeqChainActive(v); }, []);

  useEffect(() => {
    let cancelled = false;
    setFollowUpCapabilities({
      status: 'ok', queue: true, nativeSteer: false,
      interruptResume: false, steerAttachments: false,
    });
    if (!sessionId || !activeBackendId) return () => { cancelled = true; };
    void api.getFollowUpCapabilities(sessionId).then((result) => {
      if (!cancelled && result.status === 'ok') setFollowUpCapabilities(result);
    });
    return () => { cancelled = true; };
  }, [sessionId, activeBackendId]);

  useEffect(() => {
    let cancelled = false;
    if (seqRetryTimerRef.current !== null) {
      window.clearTimeout(seqRetryTimerRef.current);
      seqRetryTimerRef.current = null;
    }
    seqChainSessionRef.current = null;
    setChain(false);
    setSeqTasks([]);
    setSeqQueueError('');
    if (!sessionId) { setSeqTasks([]); return; }
    api.seqtaskGet(sessionId).then((r) => {
      if (!cancelled && r.status === 'ok') {
        setSeqTasks((current) => mergeAuthoritativeSeqTasks(r.seqTasks || [], current));
      }
    });
    const unsubscribe = api.onSeqtaskUpdated((data) => {
      if (data.sessionId !== sessionId) return;
      setSeqTasks((current) => mergeAuthoritativeSeqTasks(data.seqTasks || [], current));
    });
    return () => {
      cancelled = true;
      if (seqRetryTimerRef.current !== null) {
        window.clearTimeout(seqRetryTimerRef.current);
        seqRetryTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [sessionId, setChain]);

  // 取队首待发任务，派发进主对话（doSend 跳过斜杠命令拦截 + 自带 isStreaming 守卫）
  // ★ 用 ref 持有 chat 方法，避免 chat 对象每 render 换新导致 dispatchNext 被频繁重建、
  //   auto-dispatch effect 不断清除/重建 timeout 引发的竞态：seqtaskUpdated 事件触发
  //   re-render 时 dispatchNext 正在 await 中，旧的 chat 闭包可能持有过期的 isStreaming
  //   或 doSend 引用，造成 setMessages(userMsg) 被跳过或被后续 loadSession 覆盖。
  const isStreamingRef = useRef(chat.isStreaming);
  isStreamingRef.current = chat.isStreaming;
  const doSendRef = useRef(chat.doSend);
  doSendRef.current = chat.doSend;
  const sendMessageRef = useRef(chat.sendMessage);
  sendMessageRef.current = chat.sendMessage;
  seqPendingRef.current = seqTasks.some((task) => task.status === 'pending' && !task.syncing);

  // Smooth 顺滑问答只投递到最后聚焦的 pane。若当前回答尚未结束，先在
  // 内存中排队，等 done 边缘再发送，避免打断培训录屏中的现有回答。
  const hackerPendingRef = useRef<Array<{ prompt: string; image: any }>>([]);
  useEffect(() => {
    const onCapture = (event: Event) => {
      if (!isFocused || !sessionId) return;
      const detail = (event as CustomEvent<{ prompt?: string; image?: any }>).detail;
      if (!detail?.image) return;
      const task = { prompt: detail.prompt?.trim() || '请分析这张截图。', image: detail.image };
      if (isStreamingRef.current) hackerPendingRef.current.push(task);
      else doSendRef.current(task.prompt, [task.image]);
    };
    window.addEventListener(HACKER_CAPTURE_EVENT, onCapture);
    return () => window.removeEventListener(HACKER_CAPTURE_EVENT, onCapture);
  }, [isFocused, sessionId]);

  useEffect(() => {
    if (chat.isStreaming || !sessionId || !isFocused) return;
    const next = hackerPendingRef.current.shift();
    if (next) doSendRef.current(next.prompt, [next.image]);
  }, [chat.isStreaming, isFocused, sessionId]);

  const dispatchNext = useCallback(async () => {
    if (!sessionId || dispatchingRef.current || isStreamingRef.current) return;
    seqChainSessionRef.current = sessionId;
    setChain(true);   // 主动派发即激活连发链（▶按钮也走这里，可续上被打断的链）
    dispatchingRef.current = true;
    try {
      const r = await api.seqtaskTakeNext(sessionId);
      if (r.status === 'ok' && r.task) {
        const imgs = r.task.images && r.task.images.length ? r.task.images : undefined;
        const textAttachments = r.task.textAttachments && r.task.textAttachments.length
          ? r.task.textAttachments
          : undefined;
        const text = r.task.text || '';
        // 以 / 开头的条目当作斜杠命令处理（/compact、/clear 等可排进队列）；
        // 其余走原始发送，绕过命令拦截。
        // ★ 通过 ref 调用，始终拿到最新的函数引用，不受闭包陈旧影响
        if (text.trim().startsWith('/') && !textAttachments?.length) {
          await sendMessageRef.current(text, imgs, textAttachments);
        } else {
          // React state 要到下一次 render 才会回写这个 ref；先同步占位，封住
          // seqtaskUpdated 与 setIsStreaming(true) 之间的同帧二次派发窗口。
          isStreamingRef.current = true;
          doSendRef.current(text, imgs, textAttachments, r.task.deliveryMode || undefined);
        }
      } else if (seqPendingRef.current) {
        // done 帧会略早于后端任务清理/落盘；Relay 断线时 RPC 也可能暂不可用。
        // 队首保持 pending，短暂轮询权威 busy 状态，不把“取不到”当成已完成。
        const delay = Math.max(250, Math.min(Number(r.retryAfterMs) || 1000, 3000));
        if (seqRetryTimerRef.current === null) {
          seqRetryTimerRef.current = window.setTimeout(() => {
            seqRetryTimerRef.current = null;
            if (seqChainSessionRef.current === sessionId && seqPendingRef.current) {
              dispatchNextRef.current();
            }
          }, delay);
        }
      }
    } finally {
      dispatchingRef.current = false;
    }
  }, [sessionId]); // ★ 不再依赖 chat 对象，dispatchNext 稳定不变
  dispatchNextRef.current = dispatchNext;

  // 空闲时的第一条输入直接发送。
  const handleUserSend = useCallback((
    content: string,
    images?: any[],
    textAttachments?: TextAttachment[],
    kitApprovalDelegation?: boolean,
  ) => {
    return sendMessageRef.current(content, images, textAttachments, kitApprovalDelegation);
  }, []); // ★ 通过 ref 调用，无需依赖 chat

  // 模型忙碌时 ChatInput 会把后续输入送到这里；无需显式开启模式。
  const handleQueueTask = useCallback((
    content: string,
    images?: any[],
    textAttachments?: TextAttachment[],
    activateChain = true,
  ) => {
    if (!sessionId) return;
    const text = (content || '').trim();
    if (!text && !(images && images.length) && !textAttachments?.length) return;
    const queuedSessionId = sessionId;
    const optimisticId = `sync-${uuid()}`;
    const optimisticTask: SeqTaskT = {
      id: optimisticId,
      text,
      images: images || [],
      imageCount: images?.length || 0,
      textAttachments: textAttachments || [],
      textAttachmentCount: textAttachments?.length || 0,
      status: 'pending',
      createdAt: Date.now() / 1000,
      syncing: true,
    };
    if (activateChain) {
      seqChainSessionRef.current = sessionId;
      setChain(true);
    }
    setSeqQueueError('');
    setSeqTasks((current) => [...current, optimisticTask]);
    void api.seqtaskAdd(
      sessionId,
      text,
      images && images.length ? images : undefined,
      textAttachments?.length ? textAttachments : undefined,
    ).then(async (result) => {
      if (seqViewSessionRef.current !== queuedSessionId) return;
      if (result.status === 'ok') {
        const authoritative = Array.isArray(result.seqTasks)
          ? result.seqTasks
          : (await api.seqtaskGet(queuedSessionId)).seqTasks || [];
        setSeqTasks((current) => mergeAuthoritativeSeqTasks(
          authoritative,
          current.filter((task) => task.id !== optimisticId),
        ));
        return;
      }
      setSeqTasks((current) => current.filter((task) => task.id !== optimisticId));
      setSeqQueueError(result.message || '序列任务未能同步到执行端，请重新发送');
    }).catch((error) => {
      if (seqViewSessionRef.current !== queuedSessionId) return;
      setSeqTasks((current) => current.filter((task) => task.id !== optimisticId));
      setSeqQueueError(`序列任务同步失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, [sessionId, setChain]);

  // Redo 与输入框的默认投递规则保持一致：空闲时立即发送；当前正在回答或已有
  // 队列时排到下一轮，不能因为点历史消息而意外中断正在生成的内容。
  const handleRedoMessage = useCallback((message: ChatMessage) => {
    const payload = buildMessageRedoPayload(message);
    if (!payload) return;
    if ((isStreamingRef.current || seqPendingRef.current) && sessionId) {
      handleQueueTask(payload.content, payload.images, payload.textAttachments);
      return;
    }
    void handleUserSend(payload.content, payload.images, payload.textAttachments);
  }, [handleQueueTask, handleUserSend, sessionId]);

  const handleSteerSeqTask = useCallback(async (
    taskId: string,
  ): Promise<{ status: string; message?: string }> => {
    if (!sessionId) return { status: 'error', message: 'Session 不存在' };
    return api.steerSeqTask(sessionId, taskId);
  }, [sessionId]);

  // 当前回答结束后自动取队首；dispatchNext 使用稳定 ref，并由 dispatchingRef
  // 防止流状态与队列事件同时到达造成重复派发。
  useEffect(() => {
    if (!seqChainActive || seqChainSessionRef.current !== sessionId || chat.isStreaming || isStreamingRef.current) return;
    if (!seqTasks.some((t) => t.status === 'pending' && !t.syncing)) return;
    dispatchNext();
  }, [chat.isStreaming, seqChainActive, seqTasks, dispatchNext, sessionId]);

  // ── 持久化 skipPermissions ──
  const handleSkipPermissionsChange = useCallback(
    (enabled: boolean) => {
      setSkipPermissions(enabled);
      if (sessionId) {
        api.executeCommand({
          command: 'set_skip_permissions',
          sessionId,
          backendId: activeBackendId,
          args: { enabled },
        });
      }
    },
    [sessionId, activeBackendId],
  );

  const handleCompact = useCallback(() => {
    handleClearContext();
  }, [handleClearContext]);

  // ── 全部消息直接渲染。
  //   早先版本用 visibleCount 在前端折叠成最近 N 条,但那只是「不渲染」,
  //   loadSession 仍然把全部消息塞过来——session 大 + 远程经中继时,首屏延迟
  //   完全没解。现在改成后端分页:首次只拉 INITIAL_LOAD_LIMIT 条,UI 上靠
  //   chat.hasMore + chat.loadEarlier() 按需翻页加载更老的内容。
  const visibleMessages = useMemo(() => {
    return {
      list: chat.messages,
      hiddenCount: 0,
      total: chat.messages.length,
    };
  }, [chat.messages]);

  // Native ghost receives a bounded tail of the loaded conversation. Building
  // from the end keeps the newest turns complete while avoiding oversized IPC
  // payloads during token streaming.
  const ghostHistoryText = useMemo(() => {
    const maxChars = 48_000;
    const chunks: string[] = [];
    let used = 0;
    for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
      const message = chat.messages[index];
      if ((message.role !== 'user' && message.role !== 'assistant') || !message.content?.trim()) continue;
      const label = message.role === 'user' ? '你' : 'AgentWithU';
      let chunk = `${label}：\n${message.content.trim()}`;
      const remaining = maxChars - used;
      if (remaining <= 0) break;
      if (chunk.length > remaining) chunk = `…${chunk.slice(chunk.length - remaining + 1)}`;
      chunks.unshift(chunk);
      used += chunk.length + 2;
      if (used >= maxChars) break;
    }
    return chunks.join('\n\n');
  }, [chat.messages]);

  // The ghost window receives only the focused pane's concise latest state.
  // This callback is throttled by App before crossing the Tauri window boundary.
  useEffect(() => {
    if (!isFocused || !sessionId || !onGhostStateChange) return;
    let lastUserIndex = -1;
    for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
      if (chat.messages[index].role === 'user') { lastUserIndex = index; break; }
    }
    const lastUser = lastUserIndex >= 0 ? chat.messages[lastUserIndex] : undefined;
    let lastAssistant;
    for (let index = chat.messages.length - 1; index > lastUserIndex; index -= 1) {
      if (chat.messages[index].role === 'assistant') { lastAssistant = chat.messages[index]; break; }
    }
    const backend = effectiveBackends.find((item) => item.id === activeBackendId);
    onGhostStateChange({
      sessionId,
      sessionTitle: activeSession?.title || activeSession?.name || 'AgentWithU',
      backendLabel: backend?.label || backend?.name || activeBackendId || '',
      question: lastUser?.content || '',
      answer: lastAssistant?.content || '',
      historyText: ghostHistoryText,
      isStreaming: chat.isStreaming,
      updatedAt: Date.now(),
    });
  }, [isFocused, sessionId, chat.messages, chat.isStreaming, activeSession, activeBackendId, effectiveBackends, ghostHistoryText, onGhostStateChange]);

  // ── 自动滚到底部 ──
  useLayoutEffect(() => {
    if (!isVisible) return;
    const switched = prevSessionRef.current !== sessionId;
    prevSessionRef.current = sessionId;
    if (switched) {
      autoScrollRef.current = true;
      setShowScrollBtn(false);
    }
    const awaitingHydration = chat.hydratedSessionId !== sessionId;
    if (!autoScrollRef.current && !awaitingHydration) return;
    const container = scrollContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    else endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [chat.messages, chat.hydratedSessionId, sessionId, isVisible]);

  // ── 新交互开始时重置跟踪 ──
  useEffect(() => {
    if (chat.isStreaming && !prevStreamingRef.current) {
      autoScrollRef.current = true;
      setShowScrollBtn(false);
    }
    prevStreamingRef.current = chat.isStreaming;
  }, [chat.isStreaming]);

  // ── 滚动事件:用户向上滚则暂停跟踪 ──
  const handleScroll = useCallback(() => {
    if (!isVisible) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
    if (atBottom) {
      if (!autoScrollRef.current) {
        autoScrollRef.current = true;
        setShowScrollBtn(false);
      }
    } else {
      if (autoScrollRef.current) {
        autoScrollRef.current = false;
        setShowScrollBtn(true);
      }
    }
  }, [isVisible]);

  const scrollToBottom = useCallback(() => {
    autoScrollRef.current = true;
    setShowScrollBtn(false);
    const container = scrollContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    else endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, []);

  // 空 pane 占位
  if (!sessionId) {
    return (
      <div
        className="awu-chat-pane"
        onClick={onFocus}
        style={{
          ...paneRootStyle,
          border: '1px solid var(--theme-border)',
          boxShadow: isFocused ? `inset 0 0 0 1px ${themeBorderFocused}` : 'none',
          // 不设 bg:分屏前 chat 区域没这层 wrapper,背景图能直接透到消息气泡那层。
          // 加个实色就等于盖一层遮罩,把用户的壁纸糊死。focus 边框已经够明显了。
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 8,
            color: 'var(--theme-text-muted)',
            fontSize: 13,
            userSelect: 'none',
          }}
        >
          <div style={{ fontSize: 28, opacity: 0.5 }}>＋</div>
          <div>点击侧边栏选择会话</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Pane #{paneId + 1}</div>
        </div>
      </div>
    );
  }

  // ★ Loop 会话：直接把 LoopPanel 作为这个 pane 的内容内嵌渲染（不是浮层，
  //   也没有自由聊天框）—— loop 的主线交互都在面板内；俺寻思由 App 顶层独立承载，
  //   避免「聊天框 vs 面板」双入口、以及聊天与 loop 主线共用 agent 上下文的污染。
  if (!sessionMetaReady) {
    return <div className="awu-chat-pane" style={paneRootStyle} onClick={onFocus}>
      <div role="status" style={{ padding: 20, color: 'var(--theme-text-muted)' }}>正在恢复会话…</div>
    </div>;
  }
  if (automatedLoop) {
    return (
      <div
        className="awu-chat-pane"
        onClick={onFocus}
        style={{
          ...paneRootStyle,
          border: '1px solid var(--theme-border)',
          boxShadow: isFocused ? `inset 0 0 0 1px ${themeBorderFocused}` : 'none',
          background: 'transparent',
        }}
      >
        <LoopPanel
          sessionId={sessionId}
          embedded
          headerActions={config.workspaceKitsEnabled ? (
            <button
              onClick={() => setWorkspaceKitsOpen(true)}
              title="Workspace Kits · Session 标准配件（实验）"
              style={{ ...kitFab, position: 'static', flexShrink: 0 }}
            >🧰</button>
          ) : undefined}
          sessionBackendId={activeBackendId}
          sessionRuntime={{
            model: activeSession?.modelOverride,
            reasoningEffort: activeSession?.reasoningEffort,
          }}
          backends={effectiveBackends}
          workingDir={activeSession?.workingDir}
          execKey={activeSession?.execKey}
        />
        {config.workspaceKitsEnabled && (
          <>
            <WorkspaceKitsPanel
              sessionId={sessionId}
              open={workspaceKitsOpen}
              onClose={() => setWorkspaceKitsOpen(false)}
            />
          </>
        )}
      </div>
    );
  }

  // 入场动画:只给真正新增的最后一条消息播,切换 session 时全部不播
  const { list: msgList, hiddenCount, total } = visibleMessages;
  const isSameSession = animSessionRef.current === sessionId;
  const prevCount = isSameSession ? animMsgCountRef.current : total;
  animSessionRef.current = sessionId;
  animMsgCountRef.current = total;

  return (
    <div
      className="awu-chat-pane"
      onClick={onFocus}
      style={{
        ...paneRootStyle,
        border: '1px solid var(--theme-border)',
        boxShadow: isFocused ? `inset 0 0 0 1px ${themeBorderFocused}` : 'none',
        // 同上,透明,不挡背景图
        background: 'transparent',
      }}
    >
      <TokenUsageMonitor sessionId={sessionId} placement="floating" />
      {/* ---- 消息列表 ---- */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div
          className="awu-message-scroll"
          ref={scrollContainerRef}
          onScroll={handleScroll}
          style={{ height: '100%', overflow: 'auto', padding: '14px 0 18px' }}
        >
          {chat.messages.length === 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 10,
              }}
            >
              {chat.isLoadingSession ? (
                <>
                  <div style={{
                    width: 24, height: 24,
                    border: '2px solid var(--theme-border, rgba(255,255,255,0.15))',
                    borderTopColor: 'var(--theme-accent, #58a6ff)',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }} />
                  <div style={{ fontSize: 12, color: 'var(--theme-text-muted, #8c959f)' }}>
                    加载会话中…
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--theme-text-muted, #8c959f)' }}>
                    {activeSession?.title || `Pane #${paneId + 1}`}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text-muted, #8c959f)' }}>
                    Ctrl+V 粘贴图片 · 输入消息开始
                  </div>
                </>
              )}
            </div>
          )}

          {/* 顶部「正在刷新」细条:加载完成前/有缓存先铺底的场景,给用户一个
              「不是卡死,后台在拉」的视觉反馈 */}
          {chat.isLoadingSession && chat.messages.length > 0 && (
            <div
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 8, padding: '6px 12px', fontSize: 11,
                color: 'var(--theme-text-muted, #8c959f)',
              }}
            >
              <span style={{
                width: 12, height: 12,
                border: '2px solid var(--theme-border, rgba(255,255,255,0.15))',
                borderTopColor: 'var(--theme-accent, #58a6ff)',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
                display: 'inline-block',
              }} />
              <span>加载历史中…</span>
            </div>
          )}

          {chat.hasMore && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 16px' }}>
              <button
                onClick={() => chat.loadEarlier()}
                disabled={chat.loadingEarlier}
                style={{
                  padding: '6px 16px',
                  borderRadius: 6,
                  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
                  background: 'var(--theme-bg-secondary, #f6f8fa)',
                  color: 'var(--theme-text-muted, #656d76)',
                  fontSize: 12,
                  cursor: chat.loadingEarlier ? 'wait' : 'pointer',
                  opacity: chat.loadingEarlier ? 0.6 : 1,
                }}
              >
                {chat.loadingEarlier
                  ? '加载中…'
                  : `↑ 加载更早的消息 (剩余 ${Math.max(0, chat.messagesTotal - chat.messages.filter((m) => !m.streaming).length)} 条)`}
              </button>
            </div>
          )}

          {msgList.map((msg, idx) => {
            const previous = idx > 0 ? msgList[idx - 1] : undefined;
            const showDate = !!msg.timestamp && (
              !previous?.timestamp || localDateKey(previous.timestamp) !== localDateKey(msg.timestamp)
            );
            return (
              <React.Fragment key={msg.id}>
                {showDate && <MessageDateDivider timestamp={msg.timestamp} />}
                <MessageBubble
                  message={msg}
                  currentUser={currentUser}
                  fontSize={config.fontSize}
                  renderMarkdown={config.renderMarkdown}
                  animateIn={isSameSession && hiddenCount + idx >= prevCount}
                  sessionId={sessionId}
                  canBranch={activeSession?.sessionType !== 'loop'}
                  ttsVoice={config.ttsVoice}
                  ttsRate={config.ttsRate}
                  workingDir={activeSession?.workingDir}
                  onFocusFile={handleFocusLinkedFile}
                  onRedoMessage={handleRedoMessage}
                />
              </React.Fragment>
            );
          })}

          {/* 已发出但首个 delta 还没到 —— 在消息流里给个占位气泡,
              否则只看底部「生成中」chip,容易以为后端没收到。 */}
          {chat.isStreaming && !chat.messages.some((m: any) => m.role === 'assistant' && m.streaming) && (
            <PendingAssistantBubble />
          )}

          {/* ★ 行内权限确认组件 */}
          {chat.pendingPermission && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-start',
                padding: '4px 16px',
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: 'var(--theme-accent, #7aa2f7)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  color: '#fff',
                  fontWeight: 700,
                  marginRight: 8,
                  marginTop: 2,
                }}
              >
                A
              </div>
              <div
                style={{
                  maxWidth: '80%',
                  minWidth: 280,
                  borderRadius: '8px 8px 8px 3px',
                  background: 'var(--theme-message-bg, #f6f8fa)',
                  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
                  overflow: 'hidden',
                }}
              >
                <PermissionGate
                  request={chat.pendingPermission}
                  onDismiss={chat.clearPermission}
                  onSkipRest={() => setSkipPermissions(true)}
                />
              </div>
            </div>
          )}

          {/* 底部占位符 */}
          <div ref={endRef} />
        </div>

        {/* ★ 跟踪暂停时的浮动提示按钮 */}
        {showScrollBtn && (
          <div
            style={{
              position: 'absolute',
              bottom: 12,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 50,
            }}
          >
            <button
              onClick={scrollToBottom}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                borderRadius: 6,
                border: '1px solid var(--theme-border, rgba(0,0,0,0.18))',
                background: 'var(--theme-bg-tertiary, #242536)',
                color: 'var(--theme-text, #e2e3ea)',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
                whiteSpace: 'nowrap',
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
              跟踪最新
            </button>
          </div>
        )}
      </div>

      {/* ---- 有待发任务时显示 slim 队列条；输入框无需显式切换模式 ---- */}
      {seqQueueError && (
        <div style={seqQueueErrorStyle}>
          <span style={{ flex: 1 }}>⚠ {seqQueueError}</span>
          <button onClick={() => setSeqQueueError('')} style={seqQueueErrorCloseStyle}>✕</button>
        </div>
      )}
      {sessionId && seqTasks.some((t) => t.status === 'pending' || t.status === 'steering') && (
        <SeqTaskPanel
          sessionId={sessionId}
          tasks={seqTasks}
          chainActive={seqChainActive}
          isStreaming={chat.isStreaming}
          onSendNext={dispatchNext}
          canSteer={chat.isStreaming && followUpCapabilities.nativeSteer}
          onSteerTask={handleSteerSeqTask}
          onTasksChange={(tasks) => setSeqTasks((current) => mergeAuthoritativeSeqTasks(tasks, current))}
        />
      )}

      {/* ---- 输入栏 ---- */}
      <ChatInput
        onSend={handleUserSend}
        onAbort={chat.abort}
        isStreaming={chat.isStreaming}
        backends={effectiveBackends}
        activeBackendId={activeBackendId}
        sessionId={sessionId || undefined}
        workingDir={activeSession?.workingDir || undefined}
        skipPermissions={skipPermissions}
        onSkipPermissionsChange={handleSkipPermissionsChange}
        isMobile={isMobile}
        onQueueTask={handleQueueTask}
        seqCount={seqTasks.filter((t) => t.status === 'pending').length}
        onCompact={handleCompact}
        fontSize={config.fontSize}
        onAdjustFontSize={onAdjustFontSize}
        isFocused={isFocused}
        execKey={activeSession?.execKey}
        execMode={activeSession?.execMode}
        sessionRuntime={{
          model: activeSession?.modelOverride,
          reasoningEffort: activeSession?.reasoningEffort,
        }}
        onSessionRuntimeChange={handleSessionRuntimeChange}
        voiceConversationActive={realtimeVoiceActive}
        realtimeVoice={{
          sessionId,
          backendLabel: activeBackendLabel,
          voice: config.ttsVoice,
          rate: config.ttsRate,
          turnEndSilenceMs: config.realtimeVoiceTurnEndSilenceMs,
          continuousWindowMs: config.realtimeVoiceContinuousWindowMs,
          wakeWord: config.realtimeVoiceWakeWord,
          ttsEngine: config.realtimeVoiceTtsEngine,
          systemVoice: config.realtimeVoiceSystemVoice,
          dashscopeModel: config.realtimeVoiceDashScopeModel,
          dashscopeVoice: config.realtimeVoiceDashScopeVoice,
          vadThreshold: config.realtimeVoiceVadThreshold,
          bargeIn: config.realtimeVoiceBargeIn,
          onSend: (text, interactionMode) => {
            if (!isStreamingRef.current) {
              doSendRef.current(text, undefined, undefined, undefined, interactionMode);
            }
          },
          onActiveChange: setRealtimeVoiceActive,
        }}
      />

      {/* Session 内只保留 Session 专属工具；“俺寻思”统一从 App 顶栏进入。 */}
      {sessionId && (
        <>
          {config.workspaceKitsEnabled && (
            <button
              onClick={() => setWorkspaceKitsOpen(true)}
              title="Workspace Kits · Session 标准配件（实验）"
              style={kitFab}
            >🧰</button>
          )}
          {config.workspaceKitsEnabled && (
            <WorkspaceKitsPanel
              sessionId={sessionId}
              open={workspaceKitsOpen}
              onClose={() => setWorkspaceKitsOpen(false)}
            />
          )}
        </>
      )}

    </div>
  );
};
// isMobile 当前未在 pane 内特殊处理(响应式由内部子组件自己处理),保留 prop 备用

const paneRootStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  width: '100%',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  boxSizing: 'border-box',
  position: 'relative',   // 供 Session 专属浮动工具定位
};

const seqQueueErrorStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
  borderTop: '1px solid rgba(248,81,73,.35)', background: 'rgba(248,81,73,.09)',
  color: 'var(--theme-error, #ff7b72)', fontSize: 11.5,
};
const seqQueueErrorCloseStyle: React.CSSProperties = {
  border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '0 3px',
};

const paneFabStyle: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 12,
  zIndex: 20,
  width: 34,
  height: 34,
  borderRadius: 6,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-bg-secondary)',
  color: 'var(--theme-text)',
  fontSize: 15,
  cursor: 'pointer',
  boxShadow: 'var(--ui-shadow-soft, 0 2px 8px rgba(0,0,0,0.18))',
};

const kitFab: React.CSSProperties = {
  ...paneFabStyle,
  right: 12,
};
