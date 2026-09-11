import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { FileTransferCenter } from './components/FileTransferCenter';
import {
  api, isTauri, getExecutors, getAssignableExecutors, onExecStatus, getHomeExecKey,
  getCurrentUserProfile, onCurrentUserChanged,
  type ExecutorInfo, type CurrentUserProfile,
} from './api';
import {
  HOTKEY_CHANGED_EVENT,
  readScreenshotHotkey,
} from './utils/hotkey';
import {
  HACKER_CAPTURE_EVENT,
  HACKER_MODE_CHANGED_EVENT,
  readHackerMode,
  type HackerModeConfig,
} from './utils/hackerMode';
import { uuid } from './utils/uuid';
import { Sidebar } from './components/Sidebar';
import { Settings } from './components/Settings';
import { BackendManager } from './components/BackendManager';
import { RepoPanel } from './components/RepoPanel';
import { ScratchPad } from './components/ScratchPad';
import { AssetPanel } from './components/AssetPanel';
import { ServerDirPicker } from './components/ServerDirPicker';
import { LogViewer } from './components/LogViewer';
import { ConnectionPanel } from './components/ConnectionPanel';
import { ManualPanel } from './components/ManualPanel';
import { ChatPane } from './components/ChatPane';
import { LoopPanel } from './components/LoopPanel';
import { ThoughtsAssistant } from './components/ThoughtsAssistant';
import { HomeDashboard } from './home/HomeDashboard';
import type { DashboardDestination } from './home/dashboardModel';
import { LoopPolicyEditor, DEFAULT_POLICY, normalizePolicy } from './components/LoopPolicyEditor';
import type { LoopPolicy } from './components/LoopPolicyEditor';
import {
  BackendRuntimeFields,
  formatRuntimeLabel,
  isCodexBackend,
  isRuntimeConfigurableBackend,
  normalizeModelRuntime,
  type ModelRuntime,
} from './components/CodexRuntimeFields';
import { clearSessionHistoryCache } from './hooks/useChat';
import { clearStreamStateForSession } from './hooks/useStreamState';
import { useConfig } from './hooks/useConfig';
import { themes } from './hooks/useConfig';
import { useIsMobile } from './hooks/useIsMobile';
import { hljsLightCss, hljsDarkCss } from './utils/hljsThemes';
import { messagesToMarkdown, messagesToJson } from './utils/markdown';
import type { SmoothGhostState } from './utils/smoothGhost';
import { notifyTaskCompletion } from './utils/desktopNotifications';
import type { FileFocusRequest } from './utils/fileFocus';
import {
  type AttentionContext,
  type AttentionKind,
} from './utils/attentionContext';
import {
  createThoughtsChannel,
  focusThoughtsWindow,
  openThoughtsWindow,
  type ThoughtsWindowMessage,
} from './utils/thoughtsWindow';

// 发布工作台保持按需加载；手机/控制端点击入口时才下载对应 chunk。
const LazyReleaseCenter = React.lazy(() => import('./components/ReleaseCenter'));

function hexToRgba(color: string, alpha: number): string {
  const m = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return color;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha.toFixed(2)})`;
}

type Layout = '1x1' | '1x2' | '2x2';

const LAYOUT_SLOTS: Record<Layout, number> = { '1x1': 1, '1x2': 2, '2x2': 4 };
const LAYOUT_CYCLE: Layout[] = ['1x1', '1x2', '2x2'];
const LAYOUT_LABEL: Record<Layout, string> = { '1x1': '1×1', '1x2': '1×2', '2x2': '2×2' };

export const App: React.FC = () => {
  const [backends, setBackends] = useState<any[]>([]);
  const [backendConfigs, setBackendConfigs] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const sessionsRef = useRef<any[]>(sessions);
  sessionsRef.current = sessions;
  const sessionRefreshGenerationRef = useRef(0);
  const refreshSessionList = useCallback(async (): Promise<any[]> => {
    const generation = ++sessionRefreshGenerationRef.current;
    try {
      const list = await api.listSessions();
      if (generation === sessionRefreshGenerationRef.current) setSessions(list);
      return list;
    } catch (error) {
      console.warn('[App] failed to refresh sessions', error);
      return [];
    }
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [releaseCenterOpen, setReleaseCenterOpen] = useState(false);
  const [backendManagerOpen, setBackendManagerOpen] = useState(false);
  const [backendManagerExecKey, setBackendManagerExecKey] = useState(() => getHomeExecKey());
  const [backendManagerLoading, setBackendManagerLoading] = useState(false);
  const [backendManagerError, setBackendManagerError] = useState('');
  const backendManagerLoadGenerationRef = useRef(0);
  const [repoPanelOpen, setRepoPanelOpen] = useState(false);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [connPanelOpen, setConnPanelOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUserProfile>(() => getCurrentUserProfile());
  const [manualPanelOpen, setManualPanelOpen] = useState(false);
  const [manualLoopMenuOpen, setManualLoopMenuOpen] = useState(false);
  const [manualLoopInspectorOpen, setManualLoopInspectorOpen] = useState(false);
  const [manualLoopReleaseBusy, setManualLoopReleaseBusy] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [thoughtsOpen, setThoughtsOpen] = useState(false);
  const [thoughtsDetached, setThoughtsDetached] = useState(false);
  const [fileAttention, setFileAttention] = useState<AttentionContext | null>(null);
  const [surfaceFocus, setSurfaceFocus] = useState<AttentionKind>('session');
  const [repoPanelEditing, setRepoPanelEditing] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [newSessionInitialType, setNewSessionInitialType] = useState<'normal' | 'loop'>('normal');
  const [streamingSessions, setStreamingSessions] = useState<Set<string>>(new Set());  // ★ Per-session streaming state
  const [completedSessions, setCompletedSessions] = useState<Set<string>>(() => {
    // ★ 持久化：从 localStorage 恢复未确认的完成通知
    try {
      const saved = localStorage.getItem('agent-with-u:completed-sessions');
      return saved ? new Set<string>(JSON.parse(saved)) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null);  // ★ null = connecting
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [dataPicker, setDataPicker] = useState<'export' | 'import' | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= 768,
  );
  // 侧栏宽度可拖拽(localStorage 持久化),规避窄侧栏下文件目录树太挤。
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try { const v = parseInt(localStorage.getItem('awu.sidebarWidth') || '', 10); if (v >= 200 && v <= 640) return v; } catch { /* */ }
    return 260;
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const [fileFocusRequest, setFileFocusRequest] = useState<FileFocusRequest | null>(null);
  const fileFocusRequestIdRef = useRef(0);
  const handleSidebarDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidthRef.current;
    const onMove = (ev: MouseEvent) => setSidebarWidth(Math.max(200, Math.min(640, startW + (ev.clientX - startX))));
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);
  useEffect(() => { try { localStorage.setItem('awu.sidebarWidth', String(sidebarWidth)); } catch { /* */ } }, [sidebarWidth]);
  const [scratchPadOpen, setScratchPadOpen] = useState(false);
  const [scratchPadWidth, setScratchPadWidth] = useState(360);
  const [assetPanelOpen, setAssetPanelOpen] = useState(false);
  const scratchDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const manualLoopMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialCheckDoneRef = useRef(false);          // ★ 防止 NewSessionDialog 重复弹出

  // ── 分屏布局状态(localStorage 持久化) ────────────────────────────────
  // layout: 当前几宫格;paneSessions: 每个 pane 对应的 sessionId;
  // focusedPaneIdx: 当前焦点 pane,新建 / 侧边栏选中 / 顶栏元数据都跟随它走。
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const saved = localStorage.getItem('agent-with-u:layout');
      if (saved === '1x1' || saved === '1x2' || saved === '2x2') return saved;
    } catch {}
    return '1x1';
  });
  const [paneSessions, setPaneSessions] = useState<(string | null)[]>(() => {
    try {
      const saved = localStorage.getItem('agent-with-u:pane-sessions');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 4) return parsed;
      }
    } catch {}
    return [null, null, null, null];
  });
  const [focusedPaneIdx, setFocusedPaneIdx] = useState(0);

  // 当前焦点 pane 对应的 sessionId(派生,不再是独立 state)
  const activeSessionId = paneSessions[focusedPaneIdx] ?? null;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // 焦点 pane 的 session 详情(顶栏展示 workingDir / backendId 用)
  const [activeSession, setActiveSession] = useState<any | null>(null);

  useEffect(() => onCurrentUserChanged((profile, identityChanged) => {
    setCurrentUser(profile);
    if (!identityChanged) return;
    for (const session of sessionsRef.current) {
      if (session?.id) clearSessionHistoryCache(session.id);
    }
    setSessions([]);
    setPaneSessions((current) => current.map(() => null));
    setActiveSession(null);
    setStreamingSessions(new Set());
    setCompletedSessions(new Set());
    void refreshSessionList();
  }), [refreshSessionList]);

  // 把 sessionId 写入指定 pane(默认焦点 pane)的小工具
  const setSessionInPane = useCallback((id: string | null, paneIdx?: number) => {
    setPaneSessions((prev) => {
      const idx = paneIdx ?? focusedPaneIdx;
      if (prev[idx] === id) return prev;
      const next = [...prev];
      next[idx] = id;
      return next;
    });
  }, [focusedPaneIdx]);

  const { config, updateConfig, resetConfig } = useConfig(currentUser);
  const configRef = useRef(config);
  configRef.current = config;
  const notifiedCompletionKeysRef = useRef<Set<string>>(new Set());
  const isMobile = useIsMobile();
  const activeManualLoop = activeSession?.id === activeSessionId
    && activeSession?.sessionType === 'loop'
    && activeSession?.loopControlMode === 'manual';

  // 顶栏弹层遵循标准菜单交互：切换焦点会话、点击外部或按 Esc 都立即收起。
  useEffect(() => {
    setManualLoopMenuOpen(false);
    setManualLoopInspectorOpen(false);
    setMoreMenuOpen(false);
  }, [activeSessionId, activeManualLoop]);

  useEffect(() => {
    if (!manualLoopMenuOpen && !moreMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (manualLoopMenuOpen && !manualLoopMenuRef.current?.contains(target)) {
        setManualLoopMenuOpen(false);
      }
      if (moreMenuOpen && !moreMenuRef.current?.contains(target)) {
        setMoreMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setManualLoopMenuOpen(false);
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [manualLoopMenuOpen, moreMenuOpen]);

  const showToast = useCallback((type: 'success' | 'error' | 'info', message: string, durationMs = 4000) => {
    setToast({ type, message });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs);
  }, []);

  // ★ completedSessions 持久化到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem('agent-with-u:completed-sessions', JSON.stringify([...completedSessions]));
    } catch {}
  }, [completedSessions]);

  // ★ layout / paneSessions 持久化到 localStorage
  useEffect(() => {
    try { localStorage.setItem('agent-with-u:layout', layout); } catch {}
  }, [layout]);
  useEffect(() => {
    try { localStorage.setItem('agent-with-u:pane-sessions', JSON.stringify(paneSessions)); } catch {}
  }, [paneSessions]);

  // 焦点 pane 索引超出当前布局时,回落到 0,防止顶栏读到隐藏 pane 的 session
  useEffect(() => {
    const slots = LAYOUT_SLOTS[layout];
    if (focusedPaneIdx >= slots) setFocusedPaneIdx(0);
  }, [layout, focusedPaneIdx]);

  /* ---- 后端连接状态 ---- */
  useEffect(() => {
    // Set initial state after wsReady resolves
    const unsub = api.onConnectionStatus((connected) => setBackendConnected(connected));
    return unsub;
  }, []);

  // 执行节点状态只负责连接状态；实际列表由 Sidebar 自己维护，App 仅在
  // 初始化/打开 BackendManager/明确变更后按需同步，避免同一事件双重拉取。
  useEffect(() => {
    const unsub = onExecStatus(() => {
      const anyOnline = getExecutors().some((item) => item.connected);
      // A stale/offline relay selected as home must not hide a healthy local
      // desktop sidecar behind the full-screen "backend offline" state.
      setBackendConnected(anyOnline);
    });
    return unsub;
  }, []);

  // ★ Ctrl+Shift+N → 便签本
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        setScratchPadOpen(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ★ 全局截图快捷键(仅 Tauri):App 不在前台也能响应。默认关闭，用户可在
  //   Settings 显式配置；全屏应用/游戏在前台时自动暂停。触发时往 window 派发
  //   'awu:screenshot-hotkey' 自定义事件,焦点 pane 的 ChatInput 接收事件
  //   后走它本地的 handleScreenshot 流程(用 isFocused 做选举,避免多 pane
  //   同时反应)。
  const [screenshotHotkey, setScreenshotHotkey] = useState<string>(() => readScreenshotHotkey());
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key?: string; value?: string } | undefined;
      if (detail?.key === 'screenshot') setScreenshotHotkey(detail.value ?? '');
    };
    window.addEventListener(HOTKEY_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(HOTKEY_CHANGED_EVENT, onChange);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    const accelerator = screenshotHotkey.trim();
    if (!accelerator) return; // 空 = 用户主动禁用
    let unregister: null | (() => Promise<void>) = null;
    let cancelled = false;
    let checkingForeground = false;
    (async () => {
      try {
        const [mod, { invoke }] = await Promise.all([
          import('@tauri-apps/plugin-global-shortcut'),
          import('@tauri-apps/api/core'),
        ]);
        await mod.register(accelerator, (event) => {
          // event 有 pressed/released 两次触发,只取 pressed 那一下
          if (event.state !== 'Pressed' || checkingForeground) return;
          checkingForeground = true;
          void invoke<boolean>('is_foreground_fullscreen_app')
            .then((fullscreen) => {
              if (!cancelled && !fullscreen) {
                window.dispatchEvent(new CustomEvent('awu:screenshot-hotkey'));
              }
            })
            .catch((error) => {
              // 安全检查异常时不在后台贸然拉起系统截图浮层。
              console.warn('[hotkey] foreground guard failed:', error);
            })
            .finally(() => { checkingForeground = false; });
        });
        if (!cancelled) {
          unregister = async () => { try { await mod.unregister(accelerator); } catch { /* */ } };
        } else {
          try { await mod.unregister(accelerator); } catch { /* */ }
        }
      } catch (e) {
        console.warn('[hotkey] register screenshot shortcut failed:', accelerator, e);
        window.dispatchEvent(new CustomEvent('awu:hotkey-error', {
          detail: { key: 'screenshot', value: accelerator, message: String(e) },
        }));
      }
    })();
    return () => {
      cancelled = true;
      if (unregister) unregister();
    };
  }, [screenshotHotkey]);

  // Smooth 模式：Rust 在系统级监听 Ctrl + 双击鼠标，不激活本窗口。
  // 收到触发后后台截屏，再把一次性图片任务派给最后聚焦的 pane。
  const [hackerMode, setHackerMode] = useState<HackerModeConfig>(() => readHackerMode());
  const hackerModeEnabledRef = useRef(hackerMode.enabled);
  hackerModeEnabledRef.current = hackerMode.enabled;
  const ghostSnapshotRef = useRef<SmoothGhostState | null>(null);
  const ghostEmitRef = useRef<null | ((state: SmoothGhostState) => void)>(null);
  const ghostFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bridge the focused ChatPane into the native click-through ghost overlay.
  // Native state is retained before the overlay is first shown, so there is no
  // second WebView startup/ready race on managed Windows machines.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      if (cancelled) return;
      const emitSnapshot = (state: SmoothGhostState) => {
        void invoke('update_smooth_ghost_state', { state }).catch(() => {});
      };
      ghostEmitRef.current = emitSnapshot;
      if (hackerModeEnabledRef.current && ghostSnapshotRef.current) {
        emitSnapshot(ghostSnapshotRef.current);
      }
    })().catch((error) => console.error('[smooth-ghost] main bridge failed:', error));
    return () => {
      cancelled = true;
      ghostEmitRef.current = null;
      if (ghostFlushTimerRef.current) clearTimeout(ghostFlushTimerRef.current);
    };
  }, []);

  const handleGhostStateChange = useCallback((state: SmoothGhostState) => {
    ghostSnapshotRef.current = state;
    if (!hackerModeEnabledRef.current) return;
    if (ghostFlushTimerRef.current) return;
    ghostFlushTimerRef.current = setTimeout(() => {
      ghostFlushTimerRef.current = null;
      if (hackerModeEnabledRef.current && ghostSnapshotRef.current) {
        ghostEmitRef.current?.(ghostSnapshotRef.current);
      }
    }, 120);
  }, []);
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<HackerModeConfig>).detail;
      if (detail) setHackerMode(detail);
    };
    window.addEventListener(HACKER_MODE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(HACKER_MODE_CHANGED_EVENT, onChange);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let unlistenTrigger: undefined | (() => void);
    let unlistenError: undefined | (() => void);
    let cancelled = false;
    (async () => {
      try {
        const [{ invoke }, { listen }] = await Promise.all([
          import('@tauri-apps/api/core'),
          import('@tauri-apps/api/event'),
        ]);
        // Listen before enabling the native hook so even an immediate gesture
        // cannot fall into the setup gap.
        unlistenError = await listen<string>('smooth-error', (event) => {
          if (!cancelled) showToast('error', event.payload || 'Smooth 幽灵窗口启动失败', 9000);
        });
        unlistenTrigger = await listen('hacker-trigger', async () => {
          try {
            const image = await invoke<any>('capture_hacker_screenshot', {
              config: {
                mode: hackerMode.captureMode,
                x: hackerMode.x,
                y: hackerMode.y,
                width: hackerMode.width,
                height: hackerMode.height,
              },
            });
            if (cancelled || !image?.base64) return;
            window.dispatchEvent(new CustomEvent(HACKER_CAPTURE_EVENT, {
              detail: { prompt: hackerMode.prompt, image: { id: uuid(), ...image } },
            }));
          } catch (error) {
            console.error('[smooth] capture failed:', error);
            if (!cancelled) showToast('error', `Smooth 截图失败：${String(error)}`, 7000);
          }
        });
        await invoke('configure_hacker_monitor', {
          config: {
            enabled: hackerMode.enabled,
            mouseButton: hackerMode.mouseButton,
            doubleClickMs: hackerMode.doubleClickMs,
            x: hackerMode.x,
            y: hackerMode.y,
            width: hackerMode.width,
            height: hackerMode.height,
          },
        });
        if (hackerMode.enabled && ghostSnapshotRef.current) {
          ghostEmitRef.current?.(ghostSnapshotRef.current);
        }
      } catch (error) {
        console.error('[smooth] monitor setup failed:', error);
        if (!cancelled && hackerMode.enabled) {
          showToast('error', `Smooth 全局鼠标监听启动失败：${String(error)}`, 9000);
        }
      }
    })();
    return () => {
      cancelled = true;
      unlistenTrigger?.();
      unlistenError?.();
    };
  }, [hackerMode, showToast]);

  /* ---- 连接后加载初始数据（处理 WS 未就绪导致首次加载为空的问题） ---- */
  useEffect(() => {
    if (backendConnected !== true) return;

    api.getBackends().then(setBackends);
    // 首页是明确的应用入口：连接完成后刷新真实数据，但不自动跳入最近会话，
    // 也不在空数据时强制弹出新建窗口。
    refreshSessionList();
  }, [backendConnected, refreshSessionList]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadBackendManagerConfigs = useCallback(async (execKey: string) => {
    const generation = ++backendManagerLoadGenerationRef.current;
    setBackendManagerLoading(true);
    setBackendManagerError('');
    try {
      const list = await api.getBackends(execKey, true);
      if (generation === backendManagerLoadGenerationRef.current) {
        setBackendConfigs(list);
      }
    } catch (error: any) {
      if (generation === backendManagerLoadGenerationRef.current) {
        setBackendConfigs([]);
        setBackendManagerError(error?.message || '无法读取该执行节点的 Backend 配置');
      }
    } finally {
      if (generation === backendManagerLoadGenerationRef.current) {
        setBackendManagerLoading(false);
      }
    }
  }, []);

  // Backend 配置属于物理执行节点。管理器打开或切换节点时，只读取明确选中的
  // 节点；离线时保留错误，不允许 API 静默回退到默认节点。
  useEffect(() => {
    if (!backendManagerOpen) return;
    void loadBackendManagerConfigs(backendManagerExecKey);
  }, [backendManagerExecKey, backendManagerOpen, loadBackendManagerConfigs]);

  /* ---- 多端同步：其它客户端增删改 session 时刷新侧边栏 ---- */
  useEffect(() => {
    if (backendConnected !== true) return;
    return api.onSessionUpdated((data: any) => {
      const t = data?.type;
      if (t !== 'session_created' && t !== 'session_deleted' && t !== 'session_renamed' && t !== 'session_changed') {
        return;
      }
      // 增量事件发生在任何既有列表请求之后；阻止旧请求晚到后覆盖它。
      sessionRefreshGenerationRef.current += 1;
      if (data?.summary?.id) {
        setSessions((prev) => {
          const index = prev.findIndex((session) => session.id === data.summary.id);
          const next = [...prev];
          if (index >= 0) next[index] = { ...next[index], ...data.summary };
          else next.push(data.summary);
          return next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        });
        setActiveSession((prev: any) => (
          prev?.id === data.summary.id ? { ...prev, ...data.summary } : prev
        ));
      } else if (t === 'session_renamed' && data?.sessionId) {
        setSessions((prev) => prev.map((session) => (
          session.id === data.sessionId ? { ...session, title: data.title || session.title } : session
        )));
      } else if (t === 'session_created') {
        // 兼容没有 summary 的旧后端事件。
        refreshSessionList();
      }
      if (t === 'session_deleted') {
        setSessions((prev) => prev.filter((session) => session.id !== data.sessionId));
        // 当前正在查看的 session 被其它客户端删除:把任何 pane 里指向它的位置清掉
        setPaneSessions((prev) => prev.map((s) => (s === data.sessionId ? null : s)));
      }
    });
  }, [backendConnected, refreshSessionList]);

  /* ---- 加载焦点 pane 的 session 详情(用于顶栏 workingDir / backend 展示) ---- */
  useEffect(() => {
    if (!activeSessionId) {
      setActiveSession(null);
      return;
    }
    // 切换窗格后先撤掉旧元数据，避免顶层“俺寻思”在新 Session 加载的极短窗口里
    // 把问题误发给上一个 Session。
    setActiveSession((current: any) => current?.id === activeSessionId ? current : null);
    let cancelled = false;
    // 顶栏只读 SessionStore index；不再为了元数据解析任意消息正文。
    api.loadSessionMeta(activeSessionId).then((session) => {
      if (cancelled) return;
      setActiveSession(session);
    });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  // Phase 2: 每 Session 独立的模型配置(顶栏标签用)
  const activeBackendId = activeSession?.backendId || backends[0]?.id || '';

  // ★ 修复：根据 session 的 execKey 获取对应节点的 backend 列表
  // 多节点环境下，每个节点有独立的 backend 配置，需要按 execKey 区分
  const [activeExecBackends, setActiveExecBackends] = useState<any[]>(backends);
  useEffect(() => {
    let cancelled = false;
    const execKey = activeSession?.execKey;
    const isHomeExec = !execKey || execKey === getHomeExecKey();
    if (isHomeExec) {
      setActiveExecBackends(backends);
      return;
    }
    // 远端节点：按需拉取该节点的 backend 列表
    api.getBackends(execKey).then((list) => {
      if (!cancelled) setActiveExecBackends(list || []);
    });
    return () => { cancelled = true; };
  }, [activeSession?.execKey, backends]);

  useEffect(() => {
    setFileAttention(null);
    setSurfaceFocus(activeSessionId ? 'session' : 'home');
  }, [activeSessionId]);

  const handleAttentionChange = useCallback((context: AttentionContext | null) => {
    setFileAttention(context);
    setSurfaceFocus(context ? 'file' : (activeSessionIdRef.current ? 'session' : 'home'));
  }, []);

  const currentAttention = useMemo<AttentionContext>(() => {
    const sessionLabel = activeSession?.title || activeSession?.name
      || sessions.find((item) => item.id === activeSessionId)?.title
      || (activeSessionId ? `Session ${activeSessionId.slice(0, 8)}` : '工作总览');
    const base: AttentionContext = activeSessionId ? {
      key: 'session', kind: 'session', label: sessionLabel,
      detail: `${activeSession?.sessionType === 'loop' ? 'LOOP' : '普通会话'} · ${activeSession?.workingDir || '未设置工作目录'}`,
      content: '当前注意力位于 Session 主工作区；后端会另外注入最近对话与 Workspace Kit 摘要。',
      sessionId: activeSessionId,
      workingDir: activeSession?.workingDir,
      execKey: activeSession?.execKey,
    } : {
      key: 'home', kind: 'home', label: 'AgentWithU 工作总览',
      detail: '尚未选中 Session', content: '当前位于工作总览。选择一个 Session 后可以开始提问。',
    };
    const panel = (kind: AttentionKind, key: string, label: string, detail: string, content: string): AttentionContext => ({
      key, kind, label, detail, content, sessionId: activeSessionId || undefined,
      workingDir: activeSession?.workingDir, execKey: activeSession?.execKey,
    });

    // 模态面板天然占据当前视觉焦点；右侧停靠面板则结合最近一次指针焦点判断。
    if (backendManagerOpen) return panel('backend', 'panel:backend-manager', 'Backend 配置', `执行节点 ${backendManagerExecKey || '本机'}`,
      `当前正在管理模型 Backend。可见配置：\n${activeExecBackends.map((item) => `- ${item.label || item.id}（${item.type || 'backend'}）`).join('\n') || '暂无可见 Backend'}\n敏感凭据不会进入注意力快照。`);
    if (releaseCenterOpen) return panel('release', 'panel:release-center', '发布工作台', `执行节点 ${activeSession?.execLabel || activeSession?.execKey || '本机'}`,
      '当前正在发布工作台中查看候选包、版本清单、保留规则或发布进度。具体未在界面安全暴露的数据不会被猜测。');
    if (settingsOpen) return panel('settings', 'panel:settings', '用户与设置', `当前用户 ${currentUser.displayName}`,
      `当前可安全感知的偏好：主题 ${config.theme}，字号 ${config.fontSize}，实时语音 ${config.realtimeVoiceTtsEngine}，Workspace Kits ${config.workspaceKitsEnabled ? '开启' : '关闭'}。密钥与 Token 不会进入注意力快照。`);
    if (connPanelOpen) return panel('connection', 'panel:connection', '连接与 Relay', '当前正在配置控制端和执行节点连接',
      '当前焦点是连接与 Relay 面板。连接 Token、凭据等敏感字段不会进入注意力快照。');
    if (logViewerOpen) return panel('logs', 'panel:logs', 'Backend 日志', '当前正在查看执行节点日志',
      '当前焦点是 Backend 日志查看器；日志正文尚未作为快照注入，可在提问时粘贴关键片段。');
    if (manualPanelOpen) return panel('manual', 'panel:manual', '使用手册', 'AgentWithU 内置说明',
      '当前焦点是内置使用手册。');
    if (newSessionDialogOpen) return panel('settings', 'panel:new-session', '新建 Session', '正在选择工作目录、执行节点与模型',
      '当前焦点是新建 Session 流程。');
    if (dataPicker) return panel('settings', `panel:data-${dataPicker}`, dataPicker === 'export' ? '数据导出' : '数据导入', '正在选择服务器路径',
      `当前焦点是${dataPicker === 'export' ? '导出' : '导入'}路径选择。`);
    if (fileAttention?.sessionId === activeSessionId) return fileAttention;
    if (surfaceFocus === 'skills' && repoPanelOpen) return panel('skills', 'panel:skills', 'Skills 与 Prompts', activeSession?.workingDir || '全局资源库',
      '当前正在浏览或编辑 Skills 与 Prompts。具体编辑内容可通过当前编辑器或提问附件补充。');
    if (surfaceFocus === 'assets' && assetPanelOpen) return panel('assets', 'panel:asset-pool', '素材池', '当前 Session 可用素材',
      '当前正在浏览素材池。素材正文与二进制不会被自动批量注入。');
    if (surfaceFocus === 'notes' && scratchPadOpen) return panel('notes', 'panel:scratch-pad', '便签本', '待办与随手记录',
      '当前正在便签本中工作。便签正文不会在未确认的情况下批量发送给模型。');
    return base;
  }, [
    activeSession, activeSessionId, sessions, backendManagerOpen, backendManagerExecKey,
    activeExecBackends, releaseCenterOpen, settingsOpen, currentUser.displayName, config,
    connPanelOpen, logViewerOpen, manualPanelOpen, newSessionDialogOpen, dataPicker,
    fileAttention, surfaceFocus, repoPanelOpen, assetPanelOpen, scratchPadOpen,
  ]);

  const thoughtsSnapshotRef = useRef({ attention: currentAttention, sessionId: activeSessionId || '' });
  thoughtsSnapshotRef.current = { attention: currentAttention, sessionId: activeSessionId || '' };
  const thoughtsChannelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    const channel = createThoughtsChannel();
    thoughtsChannelRef.current = channel;
    if (!channel) return;
    channel.onmessage = (event: MessageEvent<ThoughtsWindowMessage>) => {
      if (event.data?.type === 'request-snapshot') {
        channel.postMessage({ type: 'snapshot', ...thoughtsSnapshotRef.current } satisfies ThoughtsWindowMessage);
      } else if (event.data?.type === 'detached-open') {
        setThoughtsDetached(true);
        setThoughtsOpen(false);
      } else if (event.data?.type === 'detached-closed') {
        setThoughtsDetached(false);
      }
    };
    return () => {
      channel.close();
      thoughtsChannelRef.current = null;
    };
  }, []);

  useEffect(() => {
    thoughtsChannelRef.current?.postMessage({
      type: 'snapshot', attention: currentAttention, sessionId: activeSessionId || '',
    } satisfies ThoughtsWindowMessage);
  }, [activeSessionId, currentAttention]);

  const toggleThoughts = useCallback(() => {
    if (!thoughtsDetached) {
      setThoughtsOpen((value) => !value);
      return;
    }
    void focusThoughtsWindow().then((focused) => {
      if (!focused) {
        setThoughtsDetached(false);
        setThoughtsOpen(true);
      }
    });
  }, [thoughtsDetached]);

  const detachThoughts = useCallback(() => {
    void openThoughtsWindow(activeSessionId || '').then((opened) => {
      if (!opened) {
        setToast({ type: 'error', message: '弹出窗口被阻止，请允许本站打开弹窗后重试。' });
        return;
      }
      setThoughtsDetached(true);
      setThoughtsOpen(false);
      thoughtsChannelRef.current?.postMessage({
        type: 'snapshot', attention: currentAttention, sessionId: activeSessionId || '',
      } satisfies ThoughtsWindowMessage);
    });
  }, [activeSessionId, currentAttention]);

  // ── 性能：便签本拖拽 handler，onMouseDown 每次渲染都会重新生成，改为 ref 方案 ──
  const scratchPadWidthRef = useRef(scratchPadWidth);
  scratchPadWidthRef.current = scratchPadWidth; // 每次渲染同步，保证拖拽读到最新值
  const handleScratchDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    scratchDragRef.current = { startX: e.clientX, startW: scratchPadWidthRef.current };
    const onMove = (ev: MouseEvent) => {
      if (!scratchDragRef.current) return;
      const delta = scratchDragRef.current.startX - ev.clientX;
      const next = Math.max(260, Math.min(700, scratchDragRef.current.startW + delta));
      setScratchPadWidth(next);
    };
    const onUp = () => {
      scratchDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // ★ ChatPane 把自己的 isStreaming 状态上报到这里聚合,用于侧边栏指示灯。
  //   多个 pane 同时跑各自的 session 时,App 用这个 Set 决定哪些 session 在跑。
  const handleStreamingChange = useCallback((sid: string, streaming: boolean) => {
    setStreamingSessions((prev) => {
      const has = prev.has(sid);
      if (streaming === has) return prev;
      const next = new Set(prev);
      if (streaming) next.add(sid); else next.delete(sid);
      return next;
    });
  }, []);

  // LOOP 不走普通 chat stream。直接聚合后端 loopUpdated 的权威 running，
  // 这样即使 LOOP 在后台 pane 中运行，左侧栏也持续显示脉冲/流动边框。
  useEffect(() => {
    return api.onLoopUpdated((state: any) => {
      const sid: string | undefined = state?.sessionId;
      if (!sid) return;
      if (typeof state.running === 'boolean') handleStreamingChange(sid, state.running);
      if (state.controlMode === 'manual' || state.controlMode === 'loop') {
        const loopControlMode = state.controlMode === 'manual' ? 'manual' : 'loop';
        setSessions((previous) => previous.map((session) => (
          session.id === sid ? { ...session, loopControlMode } : session
        )));
        setActiveSession((previous: any) => (
          previous?.id === sid ? { ...previous, loopControlMode } : previous
        ));
      }
    });
  }, [handleStreamingChange]);

  const handleReleaseManualLoop = useCallback(async () => {
    if (!activeSessionId || !activeManualLoop || manualLoopReleaseBusy) return;
    const releasingSessionId = activeSessionId;
    setManualLoopReleaseBusy(true);
    try {
      // 本地渲染状态可能在异常中断或 Relay 重连后滞后，交还前始终询问执行节点。
      const runState = await api.getSessionRunState(releasingSessionId);
      if (runState.busy) {
        showToast('error', runState.status === 'offline'
          ? '执行节点当前离线，暂时无法确认是否可交还 LOOP'
          : '回答仍在生成，结束或停止后才能交还 LOOP');
        return;
      }
      const result = await api.loopRelease(releasingSessionId);
      if (result.status !== 'ok') {
        showToast('error', result.message || '交还 LOOP 失败');
        return;
      }
      setActiveSession((previous: any) => (
        previous?.id === releasingSessionId ? { ...previous, loopControlMode: 'loop' } : previous
      ));
      setSessions((previous) => previous.map((session) => (
        session.id === releasingSessionId ? { ...session, loopControlMode: 'loop' } : session
      )));
      if (activeSessionIdRef.current === releasingSessionId) {
        setManualLoopMenuOpen(false);
        setManualLoopInspectorOpen(false);
      }
      showToast('success', '已交还 LOOP');
    } finally {
      setManualLoopReleaseBusy(false);
    }
  }, [activeManualLoop, activeSessionId, manualLoopReleaseBusy, showToast]);

  // ★ 全局监听所有 session 的显式 done
  // 修正两个 bug：
  //   1. 后台 session 绿点不消失：从 streamingSessions 移除
  //   2. 僵尸 streamingSessions 状态：清理用于 UI 显示的状态
  // 注意：不再清理全局流式状态（useStreamState），因为 useChat hook 需要它来恢复消息
  useEffect(() => {
    const unsub = api.onStreamDelta((delta: any) => {
      const sid: string | undefined = delta.sessionId;
      if (!sid) return;
      if (delta.type === 'done') {
        // error 可能只是 CLI 的可恢复诊断；只有 done 才能释放运行指示。
        setStreamingSessions((prev) => {
          if (!prev.has(sid)) return prev;
          const next = new Set(prev);
          next.delete(sid);
          return next;
        });
        // 如果完成的是后台 session（非当前活跃），标记为"已完成待查看"
        if (sid !== activeSessionIdRef.current) {
          setCompletedSessions((prev) => {
            const next = new Set(prev);
            next.add(sid);
            return next;
          });
        }

        if (configRef.current.desktopTaskNotifications) {
          const messageId = typeof delta.messageId === 'string' && delta.messageId
            ? delta.messageId
            : 'unknown-message';
          const completionKey = `${sid}:${messageId}`;
          const notified = notifiedCompletionKeysRef.current;
          if (!notified.has(completionKey)) {
            notified.add(completionKey);
            // Bound the de-duplication cache for very long-running app instances.
            if (notified.size > 256) {
              const oldest = notified.values().next().value as string | undefined;
              if (oldest) notified.delete(oldest);
            }
            const sessionTitle = sessionsRef.current.find((session) => session.id === sid)?.title;
            void notifyTaskCompletion(sessionTitle || '未命名 Session');
          }
        }
      } else {
        // 任意非终态流事件都证明该 session 正在运行。这样即使 ChatPane
        // 切换时经历短暂的 Hook 水合窗口，Sidebar 也不会丢掉 running。
        setStreamingSessions((prev) => {
          if (prev.has(sid)) return prev;
          const next = new Set(prev);
          next.add(sid);
          return next;
        });
      }
    });
    return unsub;
  }, [activeSessionIdRef]);

  // 自动滚动 / 跟踪最新 / 滚动事件全部下沉到 ChatPane 内部 ——
  // 每个 pane 维护自己的 endRef / scrollContainerRef / autoScrollRef。

  /* ---- 新建会话 ---- */
  const handleNewSession = useCallback(() => {
    // Open dialog to select working directory first
    setNewSessionInitialType('normal');
    setNewSessionDialogOpen(true);
  }, []);

  const handleDashboardNavigate = useCallback((destination: DashboardDestination) => {
    if (destination.kind === 'session' || destination.kind === 'loop' || destination.kind === 'tasks') {
      setSessionInPane(destination.sessionId);
      setCompletedSessions((previous) => {
        if (!previous.has(destination.sessionId)) return previous;
        const next = new Set(previous);
        next.delete(destination.sessionId);
        return next;
      });
      if (isMobile) setSidebarCollapsed(true);
      if (destination.kind === 'tasks') {
        try { sessionStorage.setItem('awu:open-seq-task-session', destination.sessionId); } catch { /* */ }
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('awu:open-seq-tasks', {
            detail: { sessionId: destination.sessionId },
          }));
        }, 0);
      }
      return;
    }
    if (destination.kind === 'new-session') {
      setSurfaceFocus('settings');
      setNewSessionInitialType(destination.sessionType || 'normal');
      setNewSessionDialogOpen(true);
      return;
    }
    if (destination.section === 'models') {
      setSurfaceFocus('backend');
      refreshSessionList();
      setBackendManagerExecKey(activeSession?.execKey || getHomeExecKey());
      setBackendManagerOpen(true);
    } else if (destination.section === 'connections') {
      setSurfaceFocus('connection');
      setConnPanelOpen(true);
    } else {
      setSurfaceFocus('settings');
      setSettingsOpen(true);
    }
  }, [activeSession?.execKey, isMobile, refreshSessionList, setSessionInPane]);

  const handleCreateSession = useCallback(async (
    workingDir: string,
    backendId: string,
    sessionType: 'normal' | 'loop' = 'normal',
    loopPolicy?: any,
    runtime: ModelRuntime = {},
    execKey?: string,
    codexRemote: { mode?: 'node'; threadId?: string; title?: string } = {},
  ) => {
    let session;
    try {
      session = await api.createSession(workingDir, backendId, sessionType, runtime, execKey, codexRemote);
    } catch (e: any) {
      // ★ 后端抛出错误（如节点 session 数量已达上限）
      showToast('error', e?.message || '创建会话失败');
      return;
    }
    if (!session) {
      showToast('error', '创建会话失败：无法连接到执行节点');
      return;
    }
    // ★ Loop 会话：把建会话时编辑的策略与心智落到 stage 文件
    if (sessionType === 'loop' && loopPolicy) {
      api.loopSetPolicy(session.id, loopPolicy).catch(() => {});
    }
    // ★ Set session first, then close dialog in next render cycle to avoid visual tearing
    // 分屏架构下:把新 session 放进焦点 pane,activeSessionId 自动派生过去。
    setSessionInPane(session.id);
    // ★ Dispatch with session data → Sidebar optimistically inserts it immediately
    window.dispatchEvent(new CustomEvent('session-created', { detail: session }));
    // App 自己只为 BackendManager 保留一份摘要，直接 upsert 即可。
    setSessions((prev) => {
      const index = prev.findIndex((item) => item.id === session.id);
      const next = [...prev];
      if (index >= 0) next[index] = { ...next[index], ...session };
      else next.push(session);
      return next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    });
    requestAnimationFrame(() => {
      setNewSessionDialogOpen(false);
    });
  }, [setSessionInPane]);


  /* ---- 导出聊天记录(导出焦点 pane 的会话) ----
   * 分屏后 App 不再持有 chat.messages,按需从后端拉焦点 session 再导出。
   * 流式中的中间内容没持久化会被忽略——导出本就是「定稿」用途。
   */
  const handleExportChat = useCallback(async () => {
    if (!activeSessionId) {
      showToast('info', '请先选中一个会话');
      return;
    }
    try {
      const session = await api.loadSession(activeSessionId);
      const msgs = session?.messages ?? [];
      if (msgs.length === 0) {
        showToast('info', '当前会话还没有消息可导出');
        return;
      }
      const text =
        config.exportFormat === 'markdown'
          ? messagesToMarkdown(msgs)
          : messagesToJson(msgs);
      const ext = config.exportFormat === 'markdown' ? 'md' : 'json';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chat-export-${new Date().toISOString().slice(0, 10)}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      showToast('error', `导出失败:${e?.message ?? e}`);
    }
  }, [activeSessionId, config.exportFormat, showToast]);

  /* ---- 数据导出 ---- */
  const runExport = useCallback(async (targetPath: string) => {
    showToast('info', '导出中，请稍候…', 60000);
    try {
      const result = await api.exportData(targetPath);
      if (result.status === 'ok') {
        showToast('success', `导出成功 → ${targetPath}`);
      } else {
        showToast('error', `导出失败：${result.message}`);
      }
    } catch (e: any) {
      console.error('[export] exportData failed:', e);
      showToast('error', `导出异常：${e?.message ?? e}`);
    }
  }, [showToast]);

  const handleExportData = useCallback(async () => {
    // 浏览器 / 远程 C/S：导出文件落在「服务器」上，用 ServerDirPicker。
    if (!isTauri()) {
      setDataPicker('export');
      return;
    }
    let targetPath: string | null = null;
    try {
      targetPath = await api.selectExportPath();
    } catch (e: any) {
      console.error('[export] selectExportPath failed:', e);
      showToast('error', `打开保存对话框失败：${e?.message ?? e}`);
      return;
    }
    if (!targetPath) return;  // 用户取消
    await runExport(targetPath);
  }, [showToast, runExport]);

  /* ---- 数据导入 ---- */
  const runImport = useCallback(async (sourcePath: string) => {
    setIsImporting(true);
    showToast('info', '导入中，请稍候…', 60000);
    try {
      const result = await api.importData(sourcePath);
      if (result.status === 'ok') {
        const parts = [
          `${result.backends || 0} 个后端`,
          `${result.prompts || 0} 个 Prompt`,
          `${result.skills || 0} 个 Skill`,
        ];
        showToast('success', `导入成功：${parts.join('，')}`);
        const [backendList, allBackendConfigs] = await Promise.all([
          api.getBackends(),
          api.getBackends(undefined, true),
        ]);
        setBackends(backendList);
        setBackendConfigs(allBackendConfigs);
      } else {
        showToast('error', `导入失败：${result.message}`);
      }
    } catch (e: any) {
      console.error('[import] importData failed:', e);
      showToast('error', `导入异常：${e?.message ?? e}`);
    } finally {
      setIsImporting(false);
    }
  }, [showToast]);

  const handleImportData = useCallback(async () => {
    const confirmed = window.confirm(
      '整包导入会合并 Backends 与 Repo（Prompts + Skills），并覆盖包内同 ID／同名的匹配项。\n\n' +
      '包外已有条目不会被删除，会话也不会被导入或覆盖。若只想迁移部分 Backend，请在 Backend Manager 中使用逐项导入。\n\n确定要继续吗？'
    );
    if (!confirmed) return;

    // 浏览器 / 远程 C/S：导入文件来自「服务器」，用 ServerDirPicker。
    if (!isTauri()) {
      setDataPicker('import');
      return;
    }
    let sourcePath: string | null = null;
    try {
      sourcePath = await api.selectImportPath();
    } catch (e: any) {
      console.error('[import] selectImportPath failed:', e);
      showToast('error', `打开文件对话框失败：${e?.message ?? e}`);
      return;
    }
    if (!sourcePath) return;
    await runImport(sourcePath);
  }, [showToast, runImport]);

  /* ---- Backend Manager ---- */
  const handleSaveBackend = useCallback(async (config: any, execKey: string) => {
    await api.saveBackend(config, execKey);
    const allBackendConfigs = await api.getBackends(execKey, true);
    setBackendConfigs(allBackendConfigs);
    // App 顶层 backends 表示当前默认执行节点；管理其它节点时不能拿远端列表
    // 覆盖它，否则顶栏和新建会话会短暂显示错节点的 Backend。
    if (execKey === getHomeExecKey()) {
      setBackends(await api.getBackends(execKey));
    }
    // Also refresh sessions to update backend references
    await refreshSessionList();
  }, [refreshSessionList]);

  const handleDeleteBackend = useCallback(async (
    id: string,
    execKey: string,
    dependentSessions: any[] = [],
    targetBackendId?: string,
  ) => {
    // If there are dependent sessions and a target backend is specified, migrate them
    if (dependentSessions.length > 0 && targetBackendId) {
      // 记录每个旧 session 迁移后对应的新 session id,后面统一替换 paneSessions
      const idMap = new Map<string, string>();
      for (const session of dependentSessions) {
        const result = await api.migrateSession(session.id, targetBackendId, execKey);
        if (result?.status !== 'ok' || !result?.newSessionId) {
          throw new Error(result?.message || `迁移会话失败：${session.title || session.id}`);
        }
        idMap.set(session.id, result.newSessionId);
      }
      // Refresh sessions after migration
      await refreshSessionList();
      // 把所有 pane 上指向已迁移 session 的位置一并替换为新 session id
      if (idMap.size > 0) {
        setPaneSessions((prev) => prev.map((s) => (s && idMap.has(s) ? idMap.get(s)! : s)));
      }
    }

    await api.deleteBackend(id, execKey);
    const allBackendConfigs = await api.getBackends(execKey, true);
    setBackendConfigs(allBackendConfigs);
    if (execKey === getHomeExecKey()) {
      setBackends(await api.getBackends(execKey));
    }
  }, [refreshSessionList]);

  const theme = themes[config.theme] || themes.dark;
  const isLightTheme = config.theme === 'light' || config.theme === 'classic';
  const hljsCss = isLightTheme ? hljsLightCss : hljsDarkCss;

  const hasBg = !!config.bgImage;
  const ua = config.uiOpacity ?? 1;  // panel alpha

  // 首次连接中（null = 尚未收到任何连接状态回调）。Web/平板允许直接进入
  // 缓存工作区；否则断网时连文件离线副本都无法打开。
  // 超过 10 秒仍连接不上，展示诊断提示
  const [connectHint, setConnectHint] = useState(false);
  useEffect(() => {
    if (backendConnected !== null) return;
    const timer = setTimeout(() => setConnectHint(true), 10000);
    return () => clearTimeout(timer);
  }, [backendConnected]);

  if (backendConnected === null && isTauri()) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: theme.bg, color: theme.textMuted, gap: 16,
        fontFamily: 'system-ui, sans-serif',
      }}>
        <div style={{
          width: 32, height: 32, border: `3px solid ${theme.border}`,
          borderTopColor: theme.accent, borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <span style={{ fontSize: 14 }}>正在连接后端...</span>
        {connectHint && (
          <div style={{
            fontSize: 12, color: '#888', textAlign: 'center', maxWidth: 420,
            lineHeight: 1.6, marginTop: 8,
            background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '12px 16px',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>连接超时？请检查：</div>
            <div>1. 后端进程是否已启动（<code>python -m src.ws_main</code>）</div>
            <div>2. 端口 44321 是否可达</div>
            <div>3. 浏览器控制台是否有 WebSocket 错误</div>
          </div>
        )}
      </div>
    );
  }

  const firstHomePaneIdx = paneSessions
    .slice(0, LAYOUT_SLOTS[layout])
    .findIndex((sessionId) => !sessionId);

  return (
    <div className="app-root" style={{
      ...rootStyle,
      background: hasBg ? 'transparent' : theme.bg,
      color: theme.text,
      // ★ CSS Variables for theme colors - child components can use these
      '--theme-bg': ua < 1 ? hexToRgba(theme.bg, ua) : theme.bg,
      '--theme-bg-secondary': ua < 1 ? hexToRgba(theme.bgSecondary, ua) : theme.bgSecondary,
      '--theme-bg-tertiary': ua < 1 ? hexToRgba(theme.bgTertiary, ua) : theme.bgTertiary,
      // 密集数据面板(如 Loop 内嵌面板)需要的"实色底"：即便用户把气泡调得很透,
      // 也保留 ≥0.86 的不透明度,叠在壁纸上仍能看清。配合 backdrop-filter 用。
      '--theme-panel-bg': hexToRgba(theme.bg, Math.max(ua, 0.86)),
      // 菜单/弹层不能跟随面板透明度，否则会与消息、悬浮按钮叠字。
      '--theme-popover-bg': theme.bgSecondary,
      '--theme-border': theme.border,
      '--theme-text': theme.text,
      '--theme-text-muted': theme.textMuted,
      '--theme-accent': theme.accent,
      '--theme-accent-hover': theme.accentHover,
      '--theme-accent-bg': theme.accentBg,
      '--theme-message-bg': ua < 1 ? hexToRgba(theme.messageBg, ua) : theme.messageBg,
      '--theme-user-message-bg': ua < 1 ? hexToRgba(theme.userMessageBg, ua) : theme.userMessageBg,
      '--theme-user-bubble-bg': theme.userBubbleBg,
      '--theme-user-bubble-border': theme.userBubbleBorder,
      '--theme-code-bg': ua < 1 ? hexToRgba(theme.codeBg, ua) : theme.codeBg,
      '--theme-input-bg': ua < 1 ? hexToRgba(theme.inputBg, ua) : theme.inputBg,
      '--theme-sidebar-bg': ua < 1 ? hexToRgba(theme.sidebarBg, ua) : theme.sidebarBg,
      '--theme-panel-solid': theme.bg,
      '--theme-sidebar-solid': theme.sidebarBg,
      '--theme-success': theme.success,
      '--theme-success-bg': theme.successBg,
      '--theme-success-border': theme.successBorder,
      '--theme-error': theme.error,
      '--ui-font': '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", "Alibaba PuHuiTi 3.0", sans-serif',
      '--ui-radius-sm': '4px',
      '--ui-radius-md': '6px',
      '--ui-radius-lg': '8px',
      '--ui-radius-xl': '10px',
      '--ui-shadow-soft': isLightTheme
        ? '0 1px 2px rgba(23,43,77,.06), 0 8px 24px rgba(23,43,77,.05)'
        : '0 1px 2px rgba(0,0,0,.24), 0 10px 28px rgba(0,0,0,.14)',
      '--ui-shadow-float': isLightTheme
        ? '0 14px 44px rgba(23,43,77,.14)'
        : '0 18px 48px rgba(0,0,0,.38)',
      '--ui-surface-hover': isLightTheme ? 'rgba(22,119,255,.055)' : 'rgba(148,163,184,.055)',
    } as React.CSSProperties}>
      {firstHomePaneIdx >= 0 && (
        <a className="app-skip-link" href={`#home-dashboard-content-${firstHomePaneIdx}`}>
          跳到首页主要内容
        </a>
      )}
      {/* ★ 背景图层：图片本身控制透明度，面板背景保持实色 */}
      {hasBg && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: -1, pointerEvents: 'none',
          backgroundImage: `url(${config.bgImage})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
          opacity: config.bgOpacity,
        }} />
      )}
      {/* ★ highlight.js theme - 随主题切换 */}
      <style>{hljsCss}</style>
      {/* ★ Markdown 内容样式 + 全局动画 */}
      <style>{`
        /* 移动端用 dvh，规避浏览器地址栏让 100vh 把底部输入框顶出可视区；
           不支持 dvh 的旧 webview 回退到 100vh。inline style 已不设 height。 */
        .app-root {
          height: 100vh; height: 100dvh;
          font-family: var(--ui-font);
          font-feature-settings: "kern" 1, "liga" 1, "tnum" 1;
          -webkit-font-smoothing: antialiased;
          text-rendering: optimizeLegibility;
        }
        .app-root button, .app-root input, .app-root textarea, .app-root select { font-family: inherit; }
        .app-root button {
          transition: color .14s ease, background-color .14s ease,
            border-color .14s ease, opacity .14s ease, transform .1s ease;
        }
        .app-root button:not(:disabled):active { transform: scale(.975); }
        .app-root ::selection { background: var(--theme-accent-bg); color: var(--theme-text); }
        .chat-textarea:focus {
          border-color: var(--theme-accent) !important;
          box-shadow: 0 0 0 3px var(--theme-accent-bg), inset 0 1px 1px rgba(0,0,0,.025) !important;
        }
        .awu-topbar button:hover, .awu-sidebar button:hover { filter: brightness(1.08); }
        .awu-topbar [role="menuitem"]:hover,
        .awu-topbar [role="dialog"] > div > button:hover {
          background: var(--ui-surface-hover) !important;
          border-color: var(--theme-border) !important;
        }
        .awu-topbar small { display: block; color: var(--theme-text-muted); font-size: 10px; font-weight: 400; }
        .awu-topbar {
          backdrop-filter: saturate(125%) blur(18px);
          -webkit-backdrop-filter: saturate(125%) blur(18px);
          box-shadow: 0 1px 0 var(--theme-border);
        }
        .awu-sidebar {
          box-shadow: inset -1px 0 0 rgba(255,255,255,.015);
          backdrop-filter: saturate(115%) blur(16px);
          -webkit-backdrop-filter: saturate(115%) blur(16px);
        }
        .awu-chat-pane { transition: box-shadow .16s ease, border-color .16s ease; }
        .awu-message-scroll {
          scrollbar-gutter: stable;
          background:
            radial-gradient(circle at 50% -15%, var(--theme-accent-bg), transparent 34%),
            linear-gradient(180deg, transparent 0%, rgba(0,0,0,.008) 100%);
        }
        .awu-composer {
          background: var(--theme-panel-bg) !important;
          backdrop-filter: saturate(125%) blur(20px);
          -webkit-backdrop-filter: saturate(125%) blur(20px);
          box-shadow: 0 -1px 0 var(--theme-border), 0 -10px 32px rgba(0,0,0,.035);
        }
        .message-bubble-wrapper {
          box-shadow: var(--ui-shadow-soft);
          transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
        }
        .message-bubble-wrapper:hover { box-shadow: var(--ui-shadow-float); }
        .awu-date-divider {
          display: flex; align-items: center; gap: 12px;
          margin: 16px 20px 12px;
          color: var(--theme-text-muted); font-size: 10.5px; font-weight: 600;
          letter-spacing: .035em; white-space: nowrap;
        }
        .awu-date-divider::before, .awu-date-divider::after {
          content: ""; height: 1px; flex: 1;
          background: linear-gradient(90deg, transparent, var(--theme-border));
        }
        .awu-date-divider::after { background: linear-gradient(90deg, var(--theme-border), transparent); }
        .app-skip-link {
          position: fixed; z-index: 10000; top: 8px; left: 8px; padding: 10px 14px;
          border: 2px solid var(--theme-accent); border-radius: 8px;
          color: var(--theme-text); background: var(--theme-bg);
          transform: translateY(-160%);
        }
        .app-skip-link:focus { transform: translateY(0); }
        .app-root button:focus-visible, .app-root a:focus-visible, .app-root input:focus-visible,
        .app-root textarea:focus-visible, .app-root select:focus-visible {
          outline: 2px solid var(--theme-accent);
          outline-offset: 2px;
        }
        @media (prefers-reduced-motion: reduce) {
          .app-root *, .app-root *::before, .app-root *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
            scroll-behavior: auto !important;
          }
        }
        @keyframes dialogSlideIn {
          from { opacity: 0; transform: translateY(8px) scale(.985); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        /* ── Markdown 内容 ── */
        .md-content { line-height: 1.6; }
        .md-content p { margin: 6px 0; }
        .md-content h1,.md-content h2,.md-content h3,
        .md-content h4,.md-content h5,.md-content h6 {
          color: var(--theme-text); font-weight: 600; margin: 14px 0 4px;
        }
        .md-content h1 { font-size: 1.2em; font-weight: 700; }
        .md-content h2 { font-size: 1.12em; }
        .md-content h3 { font-size: 1.05em; }
        .md-content h4 { font-size: 1em; }
        .md-content ul, .md-content ol { padding-left: 22px; margin: 4px 0; }
        .md-content li { margin-bottom: 3px; }
        .md-content a.md-link { color: var(--theme-accent); text-decoration: underline; }
        .md-content hr.md-hr { border: none; border-top: 1px solid var(--theme-border); margin: 12px 0; }
        /* 行内代码 */
        .md-content code.md-code-inline {
          background: var(--theme-code-bg); color: var(--theme-text);
          padding: 1px 5px; border-radius: 4px; font-size: 0.88em; font-family: monospace;
        }
        /* 代码块 */
        .md-content pre.md-pre {
          background: var(--theme-code-bg); border: 1px solid var(--theme-border);
          border-radius: 8px; padding: 12px 16px; overflow-x: auto;
          font-size: 13px; line-height: 1.6; margin: 8px 0;
        }
        .md-content pre.md-pre code.hljs {
          background: transparent; padding: 0; font-family: monospace;
          font-size: inherit; display: block;
        }
        .md-content .md-code-lang {
          font-size: 11px; color: var(--theme-text-muted);
          margin-bottom: 4px; font-family: sans-serif;
        }
        /* 引用块 */
        .md-content blockquote.md-blockquote {
          border-left: 3px solid var(--theme-accent); margin: 8px 0;
          padding: 4px 12px; color: var(--theme-text-muted);
        }
        .md-content blockquote.md-blockquote p { margin: 0; }
        /* 表格 */
        .md-table-wrap { overflow-x: auto; margin: 8px 0; }
        .md-table { border-collapse: collapse; width: 100%; font-size: 0.95em; }
        .md-table th, .md-table td {
          border: 1px solid var(--theme-border); padding: 6px 12px; text-align: left;
        }
        .md-table th { background: var(--theme-bg-secondary); font-weight: 600; }
        .md-table tr:nth-child(even) td { background: var(--theme-bg-secondary); }
        /* 任务列表 */
        .md-content li input[type="checkbox"] { margin-right: 6px; vertical-align: middle; }
        /* ── 移动端适配 ── */
        @media (max-width: 768px) {
          .message-bubble-wrapper { max-width: 94% !important; }
          .md-content pre.md-pre { padding: 10px 12px; font-size: 12px; }
          .md-table th, .md-table td { padding: 4px 8px; }
        }
      `}</style>

      {/* ★ 移动端侧栏抽屉的半透明遮罩 */}
      {isMobile && !sidebarCollapsed && (
        <div
          onClick={() => setSidebarCollapsed(true)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1050,
            background: 'rgba(0,0,0,0.45)',
          }}
        />
      )}

      <Sidebar
        isMobile={isMobile}
        activeSessionId={activeSessionId}
        onSelectSession={(id) => {
          // 分屏架构:把选中的 session 放到当前焦点 pane,activeSessionId 自动派生过去
          setSessionInPane(id);
          // ★ 移动端：选中会话后自动收起抽屉
          if (isMobile) setSidebarCollapsed(true);
          // ★ 切换到该 session 即视为已查看，自动清除完成通知气泡
          setCompletedSessions((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }}
        onAcknowledgeSession={(id) => {
          setCompletedSessions((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }}
        onNewSession={handleNewSession}
        onDeleteSession={(id) => {
          // session 被删后顺手把它在 streamStates Map 和历史缓存里的数据也
          // 清掉,防止「删而不洗」的内存泄漏。
          clearStreamStateForSession(id);
          clearSessionHistoryCache(id);
          // 任何 pane 里指向已删除 session 的位置都置空
          setPaneSessions((prev) => prev.map((s) => (s === id ? null : s)));
        }}
        streamingSessions={streamingSessions}
        completedSessions={completedSessions}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        width={sidebarWidth}
        activeWorkingDir={activeSession?.workingDir}
        activeSessionMetaId={activeSession?.id}
        activeExecKey={activeSession?.execKey}
        activeExecLabel={activeSession?.execLabel}
        activeExecMode={activeSession?.execMode}
        activeBackendId={activeBackendId}
        activeCodexRemoteHost={activeSession?.codexRemoteHost}
        sessionLimit={config.sidebarSessionLimit}
        fileFocusRequest={fileFocusRequest}
        onAttentionChange={handleAttentionChange}
      />

      {/* 侧栏宽度拖拽手柄(桌面端展开时) */}
      {!sidebarCollapsed && !isMobile && (
        <div
          onMouseDown={handleSidebarDragStart}
          title="拖拽调整侧栏宽度"
          style={{
            width: 3, flexShrink: 0, cursor: 'col-resize',
            background: 'transparent', transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--theme-accent, #7aa2f7)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        />
      )}

      <div onPointerDown={() => setSurfaceFocus(activeSessionId ? 'session' : 'home')}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* ---- 顶部栏 ---- */}
        <div className="awu-topbar" style={isMobile ? { ...headerStyle, padding: '4px 8px', gap: 2, flexWrap: 'nowrap', alignItems: 'center' } : headerStyle}>
          {/* ★ 移动端：唤出侧栏抽屉的汉堡按钮 */}
          {isMobile && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              aria-label="打开会话列表"
              style={{ ...settingsBtnStyle, fontSize: 20, minWidth: 44, minHeight: 44 }}
              title="会话列表"
            >
              ☰
            </button>
          )}
          <button
            type="button"
            onClick={() => setSessionInPane(null)}
            aria-label="返回工作总览"
            title="返回工作总览"
            style={{
              border: 0, padding: '4px 2px', minHeight: isMobile ? 44 : undefined,
              background: 'transparent', cursor: 'pointer',
              fontSize: 15, fontWeight: 600, color: 'var(--theme-text, #1f2328)',
            }}
          >
            {isMobile ? 'AWU' : 'AgentWithU'}
          </button>
          {/* ★ Backend connection indicator */}
          {backendConnected === false && (
            <span
              style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 4, fontWeight: 500,
                maxWidth: isMobile ? 72 : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
                color: '#ef4444',
              }}
              title="Python backend not running. Sessions and data import/export will not work. Run: python -m src.ws_main"
            >
              ⚠ backend offline
            </span>
          )}
          {/* ★ 工作目录与后端标签在移动端隐藏，给按钮腾空间 */}
          {!isMobile && <CopyablePath path={activeSession?.workingDir} />}
          {!isMobile && (
            <span
              title={`当前模型：${formatModelLabel(activeExecBackends.find((b: any) => b.id === activeBackendId), activeSession)}`}
              style={{
                fontSize: 12, color: 'var(--theme-text-muted, #656d76)',
                maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              🤖 {formatModelLabel(activeExecBackends.find((b: any) => b.id === activeBackendId), activeSession)}
            </span>
          )}
          {activeManualLoop && (
            <div ref={manualLoopMenuRef} style={topbarPopoverAnchorStyle}>
              <button
                type="button"
                onClick={() => {
                  setMoreMenuOpen(false);
                  setManualLoopMenuOpen((open) => !open);
                }}
                aria-haspopup="dialog"
                aria-expanded={manualLoopMenuOpen}
                aria-label="Manual LOOP 人工接管中"
                title="人工接管中 · 点击查看 LOOP 总览或交还控制权"
                style={{
                  ...manualLoopTriggerStyle,
                  ...(manualLoopMenuOpen ? manualLoopTriggerActiveStyle : {}),
                  ...(isMobile ? { width: 34, padding: 0, justifyContent: 'center' } : {}),
                }}
              >
                <span style={manualLoopDotStyle} />
                {isMobile && <span aria-hidden="true" style={{ fontSize: 13 }}>✋</span>}
                {!isMobile && <span>人工接管</span>}
                {!isMobile && <span style={{ fontSize: 9, opacity: 0.72 }}>⌄</span>}
              </button>
              {manualLoopMenuOpen && (
                <div
                  role="dialog"
                  aria-label="Manual LOOP 控制"
                  style={{
                    ...manualLoopPopoverStyle,
                    ...(isMobile ? { position: 'fixed', top: 52, left: 12, right: 12, width: 'auto' } : {}),
                  }}
                >
                  <div style={manualLoopPopoverHeaderStyle}>
                    <span style={manualLoopLargeDotStyle} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: 'var(--theme-text)', fontWeight: 650 }}>Manual LOOP</div>
                      <div style={manualLoopPopoverHintStyle}>当前对话与工具操作正在记录为人工轮次</div>
                    </div>
                  </div>
                  <div style={manualLoopActionGridStyle}>
                    <button
                      type="button"
                      onClick={() => {
                        setManualLoopMenuOpen(false);
                        setManualLoopInspectorOpen(true);
                      }}
                      style={topbarMenuActionStyle}
                      title="只读查看完整 LOOP 面板，可切换面板 / 流程视图"
                    >
                      <span style={topbarMenuActionIconStyle}>▦</span>
                      <span style={topbarMenuActionCopyStyle}><strong>LOOP 总览</strong><small>目标、阶段与流程状态</small></span>
                    </button>
                    <button
                      type="button"
                      disabled={manualLoopReleaseBusy}
                      onClick={() => void handleReleaseManualLoop()}
                      style={{
                        ...topbarMenuActionStyle,
                        color: '#d9a62e',
                        cursor: manualLoopReleaseBusy ? 'wait' : 'pointer',
                        opacity: manualLoopReleaseBusy ? 0.58 : 1,
                      }}
                      title="检查真实运行状态后，封存人工操作并返回 LOOP"
                    >
                      <span style={topbarMenuActionIconStyle}>↩</span>
                      <span style={topbarMenuActionCopyStyle}><strong>{manualLoopReleaseBusy ? '交还中…' : '交还 LOOP'}</strong><small>结束人工接管并恢复自动流程</small></span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => {
              setMoreMenuOpen(false);
              toggleThoughts();
            }}
            style={{
              ...settingsBtnStyle,
              width: isMobile ? 44 : 'auto',
              minWidth: isMobile ? 44 : 30,
              padding: isMobile ? 0 : '0 8px',
              ...(thoughtsOpen || thoughtsDetached ? { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' } : {}),
              ...(isMobile ? { minWidth: 44, minHeight: 44 } : {}),
            }}
            title={thoughtsDetached ? '俺寻思已在独立窗口中，点击聚焦' : '俺寻思 · 跟随当前 Session、文件、框选或面板'}
            aria-label="打开俺寻思注意力助手"
          >
            🤔{!isMobile && <span style={{ marginLeft: 4, fontSize: 11 }}>俺寻思</span>}
          </button>
          <button
            onClick={() => {
              setMoreMenuOpen(false);
              setSurfaceFocus('notes');
              setScratchPadOpen((open) => !open);
            }}
            style={{ ...settingsBtnStyle, ...(scratchPadOpen ? { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' } : {}), ...(isMobile ? { minWidth: 44, minHeight: 44 } : {}) }}
            title="便签本 (Ctrl+Shift+N)"
            aria-label="打开便签本"
          >
            📌
          </button>
          <button
            onClick={() => {
              setMoreMenuOpen(false);
              setSurfaceFocus('settings');
              setSettingsOpen(true);
            }}
            aria-label={`用户与设置：${currentUser.displayName}`}
            style={{
              ...settingsBtnStyle, padding: 0, width: isMobile ? 40 : 32,
              minWidth: isMobile ? 40 : 32, minHeight: isMobile ? 44 : 32,
            }}
            title={`用户与设置 · ${currentUser.displayName} · @${currentUser.username}`}
          >
            {currentUser.avatarData ? (
              <img
                src={currentUser.avatarData}
                alt=""
                style={{ width: 25, height: 25, borderRadius: '50%', objectFit: 'cover' }}
              />
            ) : (
              <span style={{
                width: 25, height: 25, borderRadius: '50%', display: 'grid', placeItems: 'center',
                background: currentUser.avatarColor, color: '#fff', fontSize: 11, fontWeight: 700,
              }}>
                {(currentUser.displayName || currentUser.username).slice(0, 1).toUpperCase()}
              </span>
            )}
          </button>
          <div ref={moreMenuRef} style={topbarPopoverAnchorStyle}>
            <button
              type="button"
              onClick={() => {
                setManualLoopMenuOpen(false);
                setMoreMenuOpen((open) => !open);
              }}
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen}
              aria-label="更多功能"
              style={{ ...settingsBtnStyle, ...(moreMenuOpen ? { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' } : {}), ...(isMobile ? { minWidth: 44, minHeight: 44 } : {}) }}
              title="更多功能"
            >
              ⋯
            </button>
            {moreMenuOpen && (
              <div role="menu" aria-label="更多功能" style={moreMenuStyle}>
                <TopbarMenuItem icon="▦" label={`分屏布局 · ${LAYOUT_LABEL[layout]}`} onClick={() => {
                  setLayout((current) => LAYOUT_CYCLE[(LAYOUT_CYCLE.indexOf(current) + 1) % LAYOUT_CYCLE.length]);
                  setMoreMenuOpen(false);
                }} />
                <TopbarMenuItem icon="📦" label="Skills 与 Prompts" active={repoPanelOpen} onClick={() => {
                  setSurfaceFocus('skills');
                  setRepoPanelOpen((open) => !open);
                  setMoreMenuOpen(false);
                }} />
                <TopbarMenuItem icon="🗂" label="素材池" active={assetPanelOpen} onClick={() => {
                  setSurfaceFocus('assets');
                  setAssetPanelOpen((open) => !open);
                  setMoreMenuOpen(false);
                }} />
                <TopbarMenuItem icon="◉" label={`Smooth 模式 · ${hackerMode.enabled ? '已开启' : '未开启'}`} active={hackerMode.enabled} onClick={() => {
                  setSurfaceFocus('settings');
                  setSettingsOpen(true);
                  setMoreMenuOpen(false);
                }} />
                <div style={moreMenuDividerStyle} />
                <TopbarMenuItem icon="📡" label="连接与 Relay" onClick={() => {
                  setSurfaceFocus('connection');
                  setConnPanelOpen(true);
                  setMoreMenuOpen(false);
                }} />
                <TopbarMenuItem icon="🚀" label="发布工作台" onClick={() => {
                  setSurfaceFocus('release');
                  setReleaseCenterOpen(true);
                  setMoreMenuOpen(false);
                }} />
                <TopbarMenuItem icon="📋" label="后端日志" onClick={() => {
                  setSurfaceFocus('logs');
                  setLogViewerOpen(true);
                  setMoreMenuOpen(false);
                }} />
                <TopbarMenuItem icon="📖" label="使用手册" onClick={() => {
                  setSurfaceFocus('manual');
                  setManualPanelOpen(true);
                  setMoreMenuOpen(false);
                }} />
              </div>
            )}
          </div>
        </div>

        {/* ---- Claude 登录状态提示 ---- */}

        {/* ---- Repo 面板（展开区域）---- */}
        <div onPointerDown={() => setSurfaceFocus('skills')} style={{
          maxHeight: repoPanelOpen ? (repoPanelEditing ? 'calc(100vh - 160px)' : 400) : 0,
          overflow: repoPanelEditing ? 'auto' : 'hidden',
          transition: repoPanelEditing ? 'none' : 'max-height 0.3s cubic-bezier(0.22,0.61,0.36,1)',
        }}>
          <RepoPanel
            open={repoPanelOpen}
            workingDir={activeSession?.workingDir || ''}
            onClose={() => setRepoPanelOpen(false)}
            onEditingChange={setRepoPanelEditing}
          />
        </div>

        {/* ---- 分屏布局:1×1 / 1×2 / 2×2 ---- *
         * 每个 ChatPane 内部独立 useChat,有自己的消息流、滚动、权限气泡和 ChatInput。
         * App 仅负责派发焦点和聚合 streamingSessions(用于侧边栏指示灯)。
         */}
        {(() => {
          const slotCount = LAYOUT_SLOTS[layout];
          const gridCols = layout === '2x2' ? '1fr 1fr' : layout === '1x2' ? '1fr 1fr' : '1fr';
          const gridRows = layout === '2x2' ? '1fr 1fr' : '1fr';
          return (
            <div style={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: gridCols,
              gridTemplateRows: gridRows,
              gap: 1,
              overflow: 'hidden',
              minHeight: 0,
              background: 'var(--theme-border)',
            }}>
              {Array.from({ length: slotCount }).map((_, idx) => (
                paneSessions[idx] ? (
                  <ChatPane
                    key={idx}
                    paneId={idx}
                    sessionId={paneSessions[idx]}
                    isFocused={focusedPaneIdx === idx}
                    onFocus={() => setFocusedPaneIdx(idx)}
                    backends={backends}
                    config={config}
                    currentUser={currentUser}
                    themeBorderFocused="var(--theme-accent)"
                    isMobile={isMobile}
                    onRequestNewSession={handleNewSession}
                    onSessionDeleted={(sid) => {
                      setPaneSessions((prev) => prev.map((s) => (s === sid ? null : s)));
                    }}
                    onStreamingChange={handleStreamingChange}
                    onGhostStateChange={handleGhostStateChange}
                    onAdjustFontSize={(delta) => updateConfig({ fontSize: Math.max(11, Math.min(28, config.fontSize + delta)) })}
                    onRequestFileFocus={(request) => {
                      setFocusedPaneIdx(idx);
                      setSidebarCollapsed(false);
                      setFileFocusRequest({
                        ...request,
                        requestId: ++fileFocusRequestIdRef.current,
                      });
                    }}
                  />
                ) : idx === firstHomePaneIdx ? (
                  <HomeDashboard
                    key={`home-${idx}`}
                    contentId={`home-dashboard-content-${idx}`}
                    showSkipLink={false}
                    sessions={sessions}
                    backends={backends}
                    activeBackendId={backends[0]?.id}
                    connected={backendConnected}
                    streamingSessionIds={streamingSessions}
                    completedSessionIds={completedSessions}
                    onNavigate={handleDashboardNavigate}
                  />
                ) : (
                  <section
                    key={`empty-${idx}`}
                    className="home-empty-pane"
                    aria-label={`空白工作区 ${idx + 1}`}
                    style={{
                      display: 'grid', placeItems: 'center', minWidth: 0,
                      color: 'var(--theme-text-muted)', background: 'var(--theme-bg)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setFocusedPaneIdx(idx);
                        handleNewSession();
                      }}
                      style={{ ...settingsBtnStyle, minWidth: 44, minHeight: 44 }}
                    >
                      ＋ 在此窗格新建会话
                    </button>
                  </section>
                )
              ))}
            </div>
          );
        })()}
      </div>

      {activeManualLoop && activeSessionId && manualLoopInspectorOpen && (
        <LoopPanel
          sessionId={activeSessionId}
          onClose={() => setManualLoopInspectorOpen(false)}
          inspectOnly
          sessionBackendId={activeBackendId}
          sessionRuntime={{
            model: activeSession?.modelOverride,
            reasoningEffort: activeSession?.reasoningEffort,
          }}
          backends={activeExecBackends}
          workingDir={activeSession?.workingDir}
          execKey={activeSession?.execKey}
        />
      )}

      {/* ---- 便签本：桌面端右侧列 / 移动端全屏覆盖 ---- */}
      {scratchPadOpen && (
        isMobile ? (
          <div onPointerDown={() => setSurfaceFocus('notes')} style={mobilePanelOverlayStyle}>
            <ScratchPad visible={true} onClose={() => setScratchPadOpen(false)} />
          </div>
        ) : (
          <>
            {/* 拖动分割线 */}
            <div
              onMouseDown={handleScratchDragStart}
              style={{
                width: 4, flexShrink: 0, cursor: 'col-resize',
                background: 'var(--theme-border, rgba(255,255,255,0.1))',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--theme-accent, #7aa2f7)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--theme-border, rgba(255,255,255,0.1))')}
            />
            {/* 便签本面板 */}
            <div onPointerDown={() => setSurfaceFocus('notes')} style={{ width: scratchPadWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <ScratchPad visible={true} onClose={() => setScratchPadOpen(false)} />
            </div>
          </>
        )
      )}

      {/* ---- 素材池：桌面端右侧列 / 移动端全屏覆盖 ---- */}
      {assetPanelOpen && (
        isMobile ? (
          <div onPointerDown={() => setSurfaceFocus('assets')} style={mobilePanelOverlayStyle}>
            <AssetPanel visible={true} onClose={() => setAssetPanelOpen(false)} />
          </div>
        ) : (
          <>
            <div style={{
              width: 4, flexShrink: 0,
              background: 'var(--theme-border, rgba(255,255,255,0.1))',
            }} />
            <div onPointerDown={() => setSurfaceFocus('assets')} style={{ width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <AssetPanel visible={true} onClose={() => setAssetPanelOpen(false)} />
            </div>
          </>
        )
      )}

      {/* ---- Settings 弹窗 ---- */}
      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={config}
        onConfigChange={updateConfig}
        onExportChat={handleExportChat}
        onResetConfig={resetConfig}
        onOpenBackendManager={() => {
          setSurfaceFocus('backend');
          setSettingsOpen(false);
          refreshSessionList();
          setBackendManagerExecKey(activeSession?.execKey || getHomeExecKey());
          setBackendManagerOpen(true);
        }}
        onExportData={handleExportData}
        onImportData={handleImportData}
        onOpenConnectionPanel={() => {
          setSurfaceFocus('connection');
          setSettingsOpen(false);
          setConnPanelOpen(true);
        }}
      />

      {/* 控制端统一发布入口：UI 只发指令，扫描和上传发生在工作台选中的执行节点。 */}
      {releaseCenterOpen && (
        <React.Suspense fallback={<div style={releaseCenterLoadingStyle}>正在连接发布执行端…</div>}>
          <LazyReleaseCenter
            onClose={() => setReleaseCenterOpen(false)}
            initialExecKey={activeSession?.execKey || getHomeExecKey()}
          />
        </React.Suspense>
      )}

      {/* ---- 后端日志查看器 ---- */}
      <LogViewer isOpen={logViewerOpen} onClose={() => setLogViewerOpen(false)} />

      {/* ---- 连接目标设置 ---- */}
      {connPanelOpen && <ConnectionPanel onClose={() => setConnPanelOpen(false)} />}

      {/* ---- 内置使用手册 ---- */}
      {manualPanelOpen && <ManualPanel onClose={() => setManualPanelOpen(false)} />}

      {/* 目录同步已重做为侧栏「🗂 文件」视图（本地 ⇄ 远端目录树），不再用弹窗。 */}

      {/* ---- Backend Manager ---- */}
      <BackendManager
        isOpen={backendManagerOpen}
        onClose={() => setBackendManagerOpen(false)}
        backends={backendConfigs}
        sessions={sessions}
        targetExecKey={backendManagerExecKey}
        loading={backendManagerLoading}
        loadError={backendManagerError}
        onTargetExecChange={setBackendManagerExecKey}
        onRefresh={() => loadBackendManagerConfigs(backendManagerExecKey)}
        onSaveBackend={handleSaveBackend}
        onDeleteBackend={handleDeleteBackend}
      />

      {/* 便签本已移到主布局右侧列 */}

      {/* ---- New Session Dialog: Select working directory first ---- */}
      {newSessionDialogOpen && (
        <NewSessionDialog
          backends={backends}
          initialSessionType={newSessionInitialType}
          onClose={() => {
            // ★ User manually closed - mark as done to prevent re-opening
            setNewSessionDialogOpen(false);
            initialCheckDoneRef.current = true;
          }}
          onCreate={handleCreateSession}
        />
      )}

      {/* ---- 数据导入/导出：服务器文件选择器（非桌面端） ---- */}
      {dataPicker === 'export' && (
        <ServerDirPicker
          mode="save"
          saveFilename={`agent-with-u-export-${new Date().toISOString().slice(0, 10)}.tar.gz`}
          onSelect={(p) => { setDataPicker(null); runExport(p); }}
          onCancel={() => setDataPicker(null)}
        />
      )}
      {dataPicker === 'import' && (
        <ServerDirPicker
          mode="open"
          onSelect={(p) => { setDataPicker(null); runImport(p); }}
          onCancel={() => setDataPicker(null)}
        />
      )}

      {/* ---- 导入 loading 遮罩 ---- */}
      {isImporting && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9998,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--theme-bg-secondary, #21262d)',
            border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
            borderRadius: 10, padding: '24px 36px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
          }}>
            <div style={{ fontSize: 26 }}>⏳</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--theme-text, #e6edf3)' }}>导入中，请稍候…</div>
          </div>
        </div>
      )}

      {/* 全局最上层注意力助手：浮窗不遮断左侧浏览，停靠时成为根布局右侧分屏。 */}
      <FileTransferCenter />
      <ThoughtsAssistant
        open={thoughtsOpen}
        onClose={() => setThoughtsOpen(false)}
        session={activeSession}
        attention={currentAttention}
        backends={activeExecBackends}
        isMobile={isMobile}
        onDetach={detachThoughts}
      />

      {/* ---- Toast 通知 ---- */}
      {toast && (
        <div
          onClick={() => setToast(null)}
          style={{
            position: 'fixed', bottom: 28, right: 28, zIndex: 9999,
            maxWidth: 380, padding: '12px 18px',
            borderRadius: 8, cursor: 'pointer',
            fontSize: 14, fontWeight: 500,
            boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'flex-start', gap: 10,
            animation: 'toastIn 0.2s ease',
            background: toast.type === 'success'
              ? 'rgba(34,197,94,0.18)'
              : toast.type === 'error'
                ? 'rgba(239,68,68,0.18)'
                : 'rgba(99,102,241,0.18)',
            border: `1px solid ${
              toast.type === 'success' ? 'rgba(34,197,94,0.4)'
              : toast.type === 'error' ? 'rgba(239,68,68,0.4)'
              : 'rgba(99,102,241,0.4)'
            }`,
            color: toast.type === 'success' ? '#4ade80'
              : toast.type === 'error' ? '#f87171'
              : '#a5b4fc',
          }}
        >
          <span style={{ flexShrink: 0, fontSize: 16 }}>
            {toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : 'ℹ'}
          </span>
          <span style={{ lineHeight: 1.5 }}>{toast.message}</span>
        </div>
      )}
      <style>{`@keyframes toastIn { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }`}</style>
    </div>
  );
};

/* ---- 根样式 ---- */
const rootStyle: React.CSSProperties = {
  display: 'flex',
  background: 'var(--theme-bg, #ffffff)',
  color: 'var(--theme-text, #1f2328)',
  fontFamily: 'var(--ui-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
};

// ★ 移动端：便签本/素材池改为全屏覆盖，不挤占聊天区
const mobilePanelOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 900,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--theme-bg, #ffffff)',
};

const headerStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 500,
  isolation: 'isolate',
  minHeight: 48,
  padding: '8px 14px',
  borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  background: 'var(--theme-panel-bg, var(--theme-bg, #ffffff))',
  overflow: 'visible',
};

const settingsBtnStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  background: 'transparent',
  border: '1px solid transparent',
  color: 'var(--theme-text-muted, #656d76)',
  fontSize: 18,
  cursor: 'pointer',
  padding: 0,
  borderRadius: 5,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'color 0.15s',
};

const topbarPopoverAnchorStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  flexShrink: 0,
};

const manualLoopTriggerStyle: React.CSSProperties = {
  height: 28,
  padding: '0 9px',
  borderRadius: 5,
  border: '1px solid rgba(210,153,34,0.32)',
  background: 'rgba(210,153,34,0.08)',
  color: '#c99826',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 11,
  fontWeight: 650,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

const manualLoopTriggerActiveStyle: React.CSSProperties = {
  borderColor: 'rgba(210,153,34,0.55)',
  background: 'rgba(210,153,34,0.14)',
};

const manualLoopDotStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  flexShrink: 0,
  borderRadius: '50%',
  background: '#d29922',
  boxShadow: '0 0 0 3px rgba(210,153,34,0.12)',
};

const manualLoopLargeDotStyle: React.CSSProperties = {
  ...manualLoopDotStyle,
  width: 8,
  height: 8,
  boxShadow: '0 0 0 4px rgba(210,153,34,0.12)',
};

const manualLoopPopoverStyle: React.CSSProperties = {
  position: 'absolute',
  zIndex: 2000,
  top: 'calc(100% + 8px)',
  right: 0,
  width: 310,
  maxWidth: 'calc(100vw - 24px)',
  padding: 10,
  borderRadius: 7,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-popover-bg, var(--theme-bg-secondary))',
  color: 'var(--theme-text)',
  opacity: 1,
  backdropFilter: 'none',
  boxShadow: 'var(--ui-shadow-float, 0 16px 40px rgba(0,0,0,.25))',
  boxSizing: 'border-box',
};

const manualLoopPopoverHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '5px 6px 10px',
  fontSize: 12,
};

const manualLoopPopoverHintStyle: React.CSSProperties = {
  marginTop: 3,
  color: 'var(--theme-text-muted)',
  fontSize: 11,
  lineHeight: 1.45,
};

const manualLoopActionGridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
};

const topbarMenuActionStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 48,
  padding: '7px 8px',
  border: '1px solid transparent',
  borderRadius: 5,
  background: 'transparent',
  color: 'var(--theme-text)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  textAlign: 'left',
};

const topbarMenuActionIconStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 4,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-bg-tertiary)',
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
  fontSize: 13,
};

const topbarMenuActionCopyStyle: React.CSSProperties = {
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  lineHeight: 1.25,
};

const moreMenuStyle: React.CSSProperties = {
  position: 'absolute',
  zIndex: 2000,
  top: 'calc(100% + 8px)',
  right: 0,
  width: 220,
  maxWidth: 'calc(100vw - 24px)',
  padding: 5,
  borderRadius: 7,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-popover-bg, var(--theme-bg-secondary))',
  color: 'var(--theme-text)',
  opacity: 1,
  backdropFilter: 'none',
  boxShadow: 'var(--ui-shadow-float, 0 16px 40px rgba(0,0,0,.25))',
  boxSizing: 'border-box',
};

const moreMenuItemStyle: React.CSSProperties = {
  width: '100%',
  height: 34,
  padding: '0 9px',
  border: '1px solid transparent',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--theme-text)',
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  textAlign: 'left',
  fontSize: 12,
  cursor: 'pointer',
};

const moreMenuDividerStyle: React.CSSProperties = {
  height: 1,
  margin: '4px 5px',
  background: 'var(--theme-border)',
};

const releaseCenterLoadingStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1400,
  display: 'grid', placeItems: 'center',
  background: 'rgba(2,6,12,.76)',
  color: 'var(--theme-text-muted)', fontSize: 12,
};

const TopbarMenuItem: React.FC<{
  icon: string;
  label: string;
  active?: boolean;
  onClick: () => void;
}> = ({ icon, label, active, onClick }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    style={{
      ...moreMenuItemStyle,
      ...(active ? { background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' } : {}),
    }}
  >
    <span aria-hidden="true" style={{ width: 18, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    {active && <span aria-label="已打开">•</span>}
  </button>
);

const logBtnStyle: React.CSSProperties = {
  background: 'var(--theme-success-bg, #2da44e1a)',
  border: '1px solid var(--theme-success-border, #2da44e33)',
  color: 'var(--theme-success, #2da44e)',
  fontSize: 12,
  cursor: 'pointer',
  padding: '4px 10px',
  borderRadius: 6,
  transition: 'all 0.15s',
  marginRight: 8,
  fontWeight: 500,
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 16,
  boxSizing: 'border-box',
  overflowY: 'auto',
  zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 8,
  padding: 24,
  width: '90%',
  maxWidth: 480,
  maxHeight: 'calc(100dvh - 32px)',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  boxSizing: 'border-box',
  boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
};

const dialogTitleStyle: React.CSSProperties = {
  margin: '0 0 8px 0',
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--theme-text, #1f2328)',
};

const dialogDescStyle: React.CSSProperties = {
  margin: '0 0 20px 0',
  fontSize: 13,
  color: 'var(--theme-text-muted, #656d76)',
  lineHeight: 1.5,
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--theme-text, #1f2328)',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--theme-input-bg, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  borderRadius: 6,
  color: 'var(--theme-text, #1f2328)',
  fontSize: 13,
  outline: 'none',
};

const dialogActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
  marginTop: 20,
};

/* ---- New Session Dialog: Select working directory first ---- */
const selectWrapperStyle: React.CSSProperties = {
  position: 'relative',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'var(--theme-bg-tertiary, #f6f8fa)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  color: 'var(--theme-text, #1f2328)',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
};

const confirmBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'var(--theme-accent, #0969da)',
  border: 'none',
  color: '#fff',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
};

/* ★ 可点击复制的路径组件 */
const CopyablePath: React.FC<{ path?: string }> = ({ path }) => {
  const [copied, setCopied] = useState(false);
  const fullPath = path || '';

  const handleClick = useCallback(async () => {
    if (!fullPath) return;
    try {
      await navigator.clipboard.writeText(fullPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 兼容没有 Clipboard API 权限的旧 WebView。
      const input = document.createElement('textarea');
      input.value = fullPath;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand('copy');
      input.remove();
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    }
  }, [fullPath]);

  return (
    <span
      style={{
        ...workingDirStyle,
        cursor: fullPath ? 'pointer' : 'default',
        position: 'relative',
        userSelect: 'none',
      }}
      title={fullPath ? `${fullPath}\n点击复制完整路径` : '未设置工作目录'}
      onClick={handleClick}
    >
      {copied ? '✓' : <>📁 <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{pathBasename(path)}</span> ⧉</>}
    </span>
  );
};

/* ★ Working Directory Display Style */
const workingDirStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--theme-success, #2da44e)',
  background: 'var(--theme-success-bg, #2da44e1a)',
  padding: '2px 8px',
  borderRadius: 4,
  fontFamily: 'monospace',
  border: '1px solid var(--theme-success-border, #2da44e33)',
  transition: 'background 0.15s',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  maxWidth: 180,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
};

function pathBasename(dir: string | undefined): string {
  if (!dir) return '未设置';
  if (dir === '.') return '当前目录';
  const normalized = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized;
}

/* 顶栏只展示实际模型参数；backend 名称已在左侧 session 列表展示。 */
function formatModelLabel(backend: any, session?: any): string {
  if (!backend) return 'auto';
  const env = backend.env || {};
  if (backend.type === 'qwen-code-cli') return formatRuntimeLabel(backend, {
    model: session?.modelOverride,
  });
  if (backend.type === 'claude-agent-sdk' || backend.type === 'claude-code-official') {
    return env.ANTHROPIC_MODEL || backend.model || 'auto';
  }
  if (backend.type === 'codex-office') return formatRuntimeLabel(backend, {
    model: session?.modelOverride,
    reasoningEffort: session?.reasoningEffort,
  });
  return backend.model || env.OPENAI_MODEL || env.ANTHROPIC_MODEL || env.QWEN_MODEL || 'auto';
}

/* ---- New Session Dialog: Select working directory first ---- */
interface NewSessionDialogProps {
  backends: any[];
  initialSessionType?: 'normal' | 'loop';
  onClose: () => void;
  onCreate: (
    workingDir: string,
    backendId: string,
    sessionType: 'normal' | 'loop',
    loopPolicy?: LoopPolicy,
    runtime?: ModelRuntime,
    execKey?: string,
    codexRemote?: { mode?: 'node'; threadId?: string; title?: string },
  ) => void;
}

const NewSessionDialog: React.FC<NewSessionDialogProps> = ({
  backends,
  initialSessionType = 'normal',
  onClose,
  onCreate,
}) => {
  // 留空 = 后端自动生成按时间命名的默认目录（放在日志目录同级）
  const [workingDir, setWorkingDir] = useState('');
  const [sessionType, setSessionType] = useState<'normal' | 'loop'>(initialSessionType);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [loopPolicy, setLoopPolicy] = useState<LoopPolicy>(DEFAULT_POLICY);
  const [sessionRuntime, setSessionRuntime] = useState<ModelRuntime>({});
  const [policyOpen, setPolicyOpen] = useState(false);
  const isAutoDir = !workingDir.trim() || workingDir.trim() === '.';

  // ── 执行节点（session 级模式管理）：默认节点与物理本机是两个独立概念 ──
  const [executors, setExecutors] = useState<ExecutorInfo[]>(() => getAssignableExecutors());
  const [executorRevision, setExecutorRevision] = useState(0);
  const [execKey, setExecKey] = useState<string>(() => {
    const available = getAssignableExecutors();
    const homeKey = getHomeExecKey();
    return available.some((executor) => executor.key === homeKey)
      ? homeKey
      : (available[0]?.key || '');
  });
  useEffect(() => onExecStatus(() => {
    const next = getAssignableExecutors();
    setExecutors(next);
    // 节点 key 不变的断线重连同样需要重读 Backend；仅依赖 execKey 会永久保留旧缓存。
    setExecutorRevision((current) => current + 1);
    setExecKey((current) => {
      if (next.some((executor) => executor.key === current)) return current;
      const homeKey = getHomeExecKey();
      return next.some((executor) => executor.key === homeKey)
        ? homeKey
        : (next[0]?.key || '');
    });
  }), []);
  const isHomeExec = execKey === getHomeExecKey();

  // 上层列表只用于弹窗首帧占位。弹窗打开、切换节点或节点重连后，都向所选
  // 执行节点读取权威清单，避免首屏不完整缓存一直保留到整页刷新。
  const [execBackends, setExecBackends] = useState<any[]>(backends);
  const [execBackendsLoading, setExecBackendsLoading] = useState(false);
  const [execBackendsError, setExecBackendsError] = useState('');
  const execBackendsKeyRef = useRef(execKey);
  useEffect(() => {
    let cancelled = false;
    if (!execKey) {
      execBackendsKeyRef.current = '';
      setExecBackends([]);
      setExecBackendsLoading(false);
      setExecBackendsError('');
      return;
    }

    const keyChanged = execBackendsKeyRef.current !== execKey;
    execBackendsKeyRef.current = execKey;
    setExecBackends((current) => {
      if (keyChanged) return isHomeExec ? backends : [];
      return current.length ? current : (isHomeExec ? backends : current);
    });
    setExecBackendsLoading(true);
    setExecBackendsError('');
    api.getBackends(execKey).then((list) => {
      if (!cancelled) setExecBackends(Array.isArray(list) ? list : []);
    }).catch((error: any) => {
      if (!cancelled) {
        setExecBackendsError(error?.message || '无法读取所选执行节点的 Backend');
      }
    }).finally(() => {
      if (!cancelled) setExecBackendsLoading(false);
    });
    return () => { cancelled = true; };
  }, [execKey, isHomeExec, backends, executorRevision]);

  const [selectedBackendId, setSelectedBackendId] = useState(
    backends[0]?.id || 'claude-agent-sdk-default'
  );
  const runtimeBackendRef = useRef(selectedBackendId);
  useEffect(() => {
    if (runtimeBackendRef.current !== selectedBackendId) {
      runtimeBackendRef.current = selectedBackendId;
      // 模型名属于具体 Backend；切换账号/CLI 时不要把旧模型误带到新 Backend。
      setSessionRuntime({});
    }
  }, [selectedBackendId]);
  const selectedBackend = execBackends.find((item) => item.id === selectedBackendId);
  const isCodex = isCodexBackend(selectedBackend);
  const runtimeConfigurable = isRuntimeConfigurableBackend(selectedBackend);
  const [codexLocation, setCodexLocation] = useState<'local' | 'node'>('local');
  const [remoteThreads, setRemoteThreads] = useState<any[]>([]);
  const [remoteThreadId, setRemoteThreadId] = useState('');
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  // 切换执行节点后,若原先选的后端在新节点不存在,回退到新节点的第一个。
  useEffect(() => {
    if (execBackends.length && !execBackends.some((b) => b.id === selectedBackendId)) {
      setSelectedBackendId(execBackends[0].id);
    }
  }, [execBackends]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isCodex) {
      setCodexLocation('local');
      setRemoteThreads([]);
      setRemoteThreadId('');
    }
  }, [isCodex]);

  useEffect(() => {
    setRemoteThreads([]);
    setRemoteThreadId('');
    setRemoteError('');
    setRemoteLoading(false);
  }, [codexLocation, selectedBackendId, execKey]);

  useEffect(() => {
    let cancelled = false;
    if (!isCodex || codexLocation === 'local') {
      setRemoteThreads([]);
      setRemoteThreadId('');
      setRemoteError('');
      return;
    }
    // 节点本机枚举稍作合并，避免切换 backend/执行节点时启动重复 app-server 进程。
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setRemoteLoading(true);
      setRemoteError('');
      api.codexLocalThreads(selectedBackendId, execKey).then((result) => {
        if (cancelled) return;
        setRemoteThreads(result.threads || []);
        if (result.status !== 'ok') setRemoteError(result.message || '无法读取 Codex threads');
      }).catch((error: any) => {
        if (!cancelled) setRemoteError(error?.message || '无法连接 Codex app-server');
      }).finally(() => { if (!cancelled) setRemoteLoading(false); });
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [isCodex, codexLocation, selectedBackendId, execKey]);

  useEffect(() => {
    if (!remoteThreadId) return;
    const thread = remoteThreads.find((item) => item.id === remoteThreadId);
    if (thread?.cwd) setWorkingDir(String(thread.cwd));
  }, [remoteThreadId, remoteThreads]);

  const handleCreate = useCallback(async () => {
    if (!execKey) return;
    // 空值交给后端补一个时间戳目录
    const backend = execBackends.find((item) => item.id === selectedBackendId);
    if (!backend || execBackendsLoading) return;
    const runtime = isRuntimeConfigurableBackend(backend) ? normalizeModelRuntime(sessionRuntime) : {};
    const selectedThread = remoteThreads.find((item) => item.id === remoteThreadId);
    const codexRemote = isCodexBackend(backend) && codexLocation !== 'local'
      ? {
          mode: codexLocation,
          threadId: remoteThreadId || undefined,
          title: selectedThread?.title || undefined,
        }
      : {};
    await onCreate(workingDir.trim() || '', selectedBackendId, sessionType,
      sessionType === 'loop' ? normalizePolicy(loopPolicy) : undefined, runtime, execKey, codexRemote);
  }, [workingDir, selectedBackendId, sessionType, loopPolicy, sessionRuntime, execKey, execBackends, execBackendsLoading, onCreate, codexLocation, remoteThreadId, remoteThreads]);

  const handleBrowse = useCallback(() => {
    // 本机与远端统一浏览“执行节点”的文件系统，保证两边都支持新建与重命名目录。
    setDirPickerOpen(true);
  }, []);

  const createBlocked = !execKey || execBackendsLoading || !selectedBackend || (
    isCodex && codexLocation === 'node'
      ? (remoteLoading || !remoteThreadId)
      : false
  );

  return (
    <div
      style={overlayStyle}
    >
      <div
        style={{
          ...dialogStyle,
          willChange: 'transform',
          animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={dialogTitleStyle}>New Session</h3>
        <p style={dialogDescStyle}>
          Each session is tied to a working directory. Claude will operate within this directory,
          with full access to read, edit, and run commands here.
        </p>

        {/* ★ 会话类型：普通 / Loop（可视化迭代任务） */}
        <div style={formGroupStyle}>
          <label style={labelStyle}>会话类型 / Type:</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {([
              { v: 'normal', icon: '💬', title: '普通会话', desc: '常规对话工作区' },
              { v: 'loop', icon: '🔁', title: 'Loop 会话', desc: '想法→迭代执行→产出，可视化' },
            ] as const).map((opt) => (
              <button
                key={opt.v}
                onClick={() => setSessionType(opt.v)}
                style={{
                  flex: 1, textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                  background: sessionType === opt.v ? 'var(--theme-accent-bg, #0969da1a)' : 'var(--theme-bg-tertiary, #f6f8fa)',
                  border: `1px solid ${sessionType === opt.v ? 'var(--theme-accent, #0969da)' : 'var(--theme-border, rgba(0,0,0,0.12))'}`,
                  color: 'var(--theme-text, #1f2328)',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{opt.icon} {opt.title}</div>
                <div style={{ fontSize: 11, color: 'var(--theme-text-muted, #656d76)', marginTop: 2 }}>{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* ★ Loop 策略与心智：建会话时可编辑（默认即可，按需展开调整） */}
        {sessionType === 'loop' && (
          <div style={formGroupStyle}>
            <button
              onClick={() => setPolicyOpen((v) => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                color: 'var(--theme-text, #1f2328)', fontSize: 13, fontWeight: 600,
              }}
            >
              <span>{policyOpen ? '▾' : '▸'}</span>
              <span>⚙️ Loop 策略与心智</span>
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text-muted, #656d76)' }}>
                （门槛 / 最大 loop / 风险 / 策略文本，可不改用默认；建后也能随时调）
              </span>
            </button>
            {policyOpen && (
              <div style={{ marginTop: 10 }}>
                <LoopPolicyEditor
                  value={loopPolicy}
                  onChange={setLoopPolicy}
                  availableBackends={execBackends}
                  sessionBackendId={selectedBackendId}
                  sessionRuntime={sessionRuntime}
                />
              </div>
            )}
          </div>
        )}

        {/* ★ 执行节点：本会话在哪台机器上执行(本机自执行 / 远端节点)。
            只有配置了额外执行节点时才出现,单机用户无感(不臃肿)。 */}
        {executors.length === 0 && (
          <div style={{
            ...formGroupStyle, padding: '10px 12px', borderRadius: 8,
            border: '1px solid rgba(234,179,8,0.45)',
            background: 'rgba(234,179,8,0.10)', color: '#b45309', fontSize: 12,
          }}>
            当前没有可分配执行节点。请先在“📡 连接”中连接远端节点，
            或恢复当前 Web 节点的 Agent 执行资格。
          </div>
        )}
        {executors.length > 1 && (
          <div style={formGroupStyle}>
            <label style={labelStyle}>执行节点 / Runs on:</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {executors.map((ex) => {
                const active = ex.key === execKey;
                return (
                  <button
                    key={ex.key}
                    onClick={() => setExecKey(ex.key)}
                    title={ex.connected ? '在线' : '离线 — 该节点暂不可达'}
                    style={{
                      flex: '1 1 auto', minWidth: 120, textAlign: 'left',
                      padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                      background: active ? 'var(--theme-accent-bg, #0969da1a)' : 'var(--theme-bg-tertiary, #f6f8fa)',
                      border: `1px solid ${active ? 'var(--theme-accent, #0969da)' : 'var(--theme-border, rgba(0,0,0,0.12))'}`,
                      color: 'var(--theme-text, #1f2328)',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                        background: ex.connected ? '#22c55e' : '#9ca3af',
                      }} />
                      {ex.mode === 'local' ? ex.label : `🌐 ${ex.label}`}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text-muted, #656d76)', marginTop: 2 }}>
                      {`${ex.isHome ? '默认 · ' : ''}${ex.mode === 'local'
                        ? (isTauri() ? '本机执行' : '当前 Web 节点执行')
                        : '远端执行节点'}`}
                    </div>
                  </button>
                );
              })}
            </div>
            <span style={helpTextStyle}>
              会话建好后归属固定。工作目录与模型均取自所选节点。
            </span>
          </div>
        )}

        <div style={formGroupStyle}>
          <label style={labelStyle}>Working Directory:</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              style={inputStyle}
              placeholder="留空 = 自动按时间命名（放在日志目录旁）"
            />
            <button onClick={handleBrowse} style={browseBtnStyle} title="Select directory with file picker">
              📁 Browse
            </button>
          </div>
          <span style={helpTextStyle}>
            {isCodex && codexLocation === 'node'
              ? '接管已有 Codex thread 后会自动带出它在所选执行节点上的工作目录。'
              : isAutoDir
              ? '留空将自动在 ~/.agent-with-u/workspaces/session-时间戳/ 下新建目录（与日志目录同级）'
              : 'The directory where Claude will read/write files and run commands'}
          </span>
        </div>

        <div style={formGroupStyle}>
          <label style={labelStyle}>Backend:</label>
          <div style={selectWrapperStyle}>
            <select
              value={selectedBackend ? selectedBackendId : ''}
              onChange={(e) => setSelectedBackendId(e.target.value)}
              style={selectStyle}
              disabled={execBackendsLoading && execBackends.length === 0}
            >
              {!selectedBackend && (
                <option value="" disabled>
                  {execBackendsLoading ? '正在读取 Backend…' : '当前节点没有可用 Backend'}
                </option>
              )}
              {execBackends.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <span style={{ ...helpTextStyle, color: execBackendsError ? '#f87171' : undefined }}>
            {execBackendsError
              ? `${execBackendsError}；当前显示的是最近缓存，重新打开弹窗或节点恢复后会重试。`
              : execBackendsLoading
                ? '正在与所选执行节点同步 Backend 清单…'
                : 'Backend 负责账号、连接和 CLI；支持的模型与推理档位在下方按 Session 单独选择。'}
          </span>
        </div>

        {runtimeConfigurable && (
          <div style={formGroupStyle}>
            <BackendRuntimeFields
              backend={execBackends.find((b) => b.id === selectedBackendId)}
              value={sessionRuntime}
              onChange={setSessionRuntime}
            />
          </div>
        )}

        {isCodex && (
          <div style={{ ...formGroupStyle, padding: 12, border: '1px solid var(--theme-border)', borderRadius: 8 }}>
            <label style={labelStyle}>Codex 会话来源:</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: codexLocation === 'local' ? 0 : 10 }}>
              <button onClick={() => setCodexLocation('local')} style={{ ...browseBtnStyle, flex: 1, justifyContent: 'center', opacity: codexLocation === 'local' ? 1 : 0.55 }}>＋ 新建会话</button>
              <button onClick={() => setCodexLocation('node')} style={{ ...browseBtnStyle, flex: 1, justifyContent: 'center', opacity: codexLocation === 'node' ? 1 : 0.55 }}>🧲 接管已有</button>
            </div>
            {codexLocation === 'node' && (
              <>
                <label style={{ ...labelStyle, fontSize: 11 }}>所选执行节点上的 Codex thread</label>
                <select
                  value={remoteThreadId}
                  onChange={(e) => setRemoteThreadId(e.target.value)}
                  style={{ ...selectStyle, width: '100%' }}
                  disabled={remoteLoading}
                >
                  <option value="">请选择已有 thread…</option>
                  {remoteThreads.map((thread) => (
                    <option key={thread.id} value={thread.id}>
                      {(thread.title || thread.preview || thread.id).slice(0, 72)} · {thread.cwd || '未知目录'}
                    </option>
                  ))}
                </select>
                <span style={{ ...helpTextStyle, color: remoteError ? '#f87171' : undefined }}>
                  {remoteLoading
                    ? '正在读取所选执行节点的 Codex threads…'
                    : remoteError || (remoteThreads.length
                      ? '接管后继续原生上下文；如果执行节点是家里电脑，通信仍走 AgentWithU Relay。'
                      : '该执行节点暂未发现可接管的 Codex thread。')}
                </span>
              </>
            )}
          </div>
        )}

        <div style={dialogActionsStyle}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button
            onClick={handleCreate}
            disabled={createBlocked}
            style={{ ...confirmBtnStyle, opacity: createBlocked ? 0.5 : 1 }}
          >
            Create Session
          </button>
        </div>
      </div>

      {dirPickerOpen && (
        <ServerDirPicker
          execKey={execKey}
          initialPath={isAutoDir ? undefined : workingDir}
          onSelect={(p) => { setWorkingDir(p); setDirPickerOpen(false); }}
          onCancel={() => setDirPickerOpen(false)}
        />
      )}
    </div>
  );
};

const formGroupStyle: React.CSSProperties = {
  marginBottom: 16,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '10px 12px',
  background: 'var(--theme-input-bg, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  borderRadius: 8,
  color: 'var(--theme-text, #1f2328)',
  fontSize: 13,
  fontFamily: 'monospace',
  outline: 'none',
};

const browseBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--theme-success-bg, #2da44e1a)',
  border: '1px solid var(--theme-success-border, #2da44e33)',
  color: 'var(--theme-success, #2da44e)',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
  whiteSpace: 'nowrap',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const helpTextStyle: React.CSSProperties = {
  display: 'block',
  marginTop: 6,
  fontSize: 11,
  color: 'var(--theme-text-muted, #8c959f)',
};
