import React, { useEffect, useState, useCallback, memo, useRef, useMemo, useLayoutEffect } from 'react';
import { api, isTauri, onExecStatus } from '../api';
import { FileTreePanel } from './FileTreePanel';
import type { AttentionContext } from '../utils/attentionContext';
import type { FileFocusRequest } from '../utils/fileFocus';
import { AppModalPortal } from './AppModalPortal';

interface Session {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: number;
  workingDir: string;
  backendId: string;
  abilities?: { skills: string[]; prompts: string[] };
  // ★ session 级执行节点归属（由 api.listSessions 合并时注入）
  execKey?: string;
  execLabel?: string;
  execMode?: 'local' | 'relay';
  execIsHome?: boolean;
  codexConnectionMode?: 'node' | 'ssh';
  codexRemoteHost?: string;
  codexThreadAttached?: boolean;
  sessionType?: 'normal' | 'loop';
  pinned?: boolean;
  sidebarColor?: string;
}

interface Backend {
  id: string;
  label: string;
  type: string;
}

interface Props {
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession?: (id: string) => void;
  onAcknowledgeSession?: (id: string) => void; // ★ 用户明确确认后才消除通知
  streamingSessions: Set<string>;
  completedSessions?: Set<string>;  // ★ 后台完成待查看的 session
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isMobile?: boolean;
  width?: number;   // ★ 可拖拽的侧栏宽度(展开、非移动端时生效)
  // ★ 当前会话的工作目录 / 执行节点 —— 供「文件」视图（本地⇄远端目录树）使用
  activeWorkingDir?: string;
  activeSessionMetaId?: string;
  activeExecKey?: string;
  activeExecLabel?: string;
  activeExecMode?: 'local' | 'relay';
  activeBackendId?: string;
  activeCodexRemoteHost?: string;
  sessionLimit?: number;
  fileFocusRequest?: FileFocusRequest | null;
  onAttentionChange?: (context: AttentionContext | null) => void;
}

// ★ Wrap with React.memo to prevent unnecessary re-renders when parent updates
export const Sidebar: React.FC<Props> = memo(({ activeSessionId, onSelectSession, onNewSession, onDeleteSession, onAcknowledgeSession, streamingSessions, completedSessions = new Set(), collapsed, onToggleCollapse, isMobile, width, activeWorkingDir, activeSessionMetaId, activeExecKey, activeExecLabel, activeExecMode, activeBackendId, activeCodexRemoteHost, sessionLimit = 25, fileFocusRequest, onAttentionChange }) => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const refreshGenerationRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ★ 侧栏视图：会话列表 / 文件目录树（本地 ⇄ 远端），左侧小按钮切换
  const [view, setView] = useState<'sessions' | 'files'>('sessions');
  const [backends, setBackends] = useState<Backend[]>([]);
  const [sessionContextMenu, setSessionContextMenu] = useState<{
    session: Session;
    x: number;
    y: number;
  } | null>(null);
  const [sessionToDelete, setSessionToDelete] = useState<Session | null>(null);
  const [sessionToDestroy, setSessionToDestroy] = useState<Session | null>(null);
  const [sessionToConvert, setSessionToConvert] = useState<Session | null>(null);
  const [conversionGoal, setConversionGoal] = useState('');
  const [conversionError, setConversionError] = useState('');
  const [converting, setConverting] = useState(false);
  const [destroyConfirmValue, setDestroyConfirmValue] = useState('');
  const [destroyError, setDestroyError] = useState('');
  const [destroying, setDestroying] = useState(false);
  const [abilityPickerSession, setAbilityPickerSession] = useState<Session | null>(null);
  const [availablePrompts, setAvailablePrompts] = useState<any[]>([]);
  const [availableSkills, setAvailableSkills] = useState<any[]>([]);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [appearancePickerSession, setAppearancePickerSession] = useState<Session | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // ★ 执行节点分组折叠；每组显示数量由应用配置控制。
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // 聊天气泡请求定位文件时，侧栏自动切到文件视图。Session 尚未切换完成
  // 时先保留请求；activeSessionId 更新后该 effect 会再次命中。
  useEffect(() => {
    if (!fileFocusRequest || fileFocusRequest.sessionId !== activeSessionId) return;
    setView('files');
  }, [fileFocusRequest, activeSessionId]);

  // ★ Memoize refresh function to avoid re-creating it on every render
  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    try {
      const sessionList = await api.listSessions();
      if (generation !== refreshGenerationRef.current) return;
      sessionList.sort(sortSessionsByPriority);
      setSessions(sessionList);
    } catch (error) {
      console.warn('[Sidebar] failed to refresh sessions', error);
    }
  }, []);

  const scheduleRefresh = useCallback((delay = 80) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refresh();
    }, delay);
  }, [refresh]);

  // ★ 能力绑定
  const openAbilityPicker = useCallback(async (session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    // 先从服务器获取会话的最新数据，确保 abilities 是最新的
    const latestSession = await api.loadSession(session.id);
    setAbilityPickerSession(latestSession);
    const [sk, pr] = await Promise.all([api.listSkills(latestSession.workingDir || ''), api.listPrompts()]);
    setAvailableSkills(sk || []);
    setAvailablePrompts(pr || []);
  }, [api]);

  // ★ 删除技能/提示确认
  const [itemToDelete, setItemToDelete] = useState<{ type: 'skills' | 'prompts', name: string } | null>(null);

  const confirmDeleteItem = useCallback(async () => {
    if (!itemToDelete || !abilityPickerSession) return;
    const { type, name } = itemToDelete;
    const current = abilityPickerSession.abilities || { skills: [], prompts: [] };
    const list = [...(current[type] || [])];
    const idx = list.indexOf(name);
    if (idx >= 0) {
      list.splice(idx, 1);
      const newAbilities = { ...current, [type]: list };
      await api.updateSessionAbilities(abilityPickerSession.id, newAbilities);
      setAbilityPickerSession({ ...abilityPickerSession, abilities: newAbilities });
    }
    setItemToDelete(null);
  }, [itemToDelete, abilityPickerSession]);

  // ★ 预览内容状态
  const [previewContent, setPreviewContent] = useState<string | null>(null);

  // ★ 临时约束本地 state，避免每次 onChange 触发异步 API 导致 IME 组合被打断
  const [constraintsValue, setConstraintsValue] = useState('');

  // 打开 picker 时同步 constraints 到本地 state
  useEffect(() => {
    if (abilityPickerSession) {
      setConstraintsValue((abilityPickerSession.abilities as any)?.constraints || '');
    }
  }, [abilityPickerSession?.id]);

  // ★ 显示 Skill 预览
  const show_preview_skill = useCallback(async (skill: any) => {
    setPreviewContent(skill.content || '');
  }, []);

  // ★ 显示 Prompt 预览
  const show_preview_prompt = useCallback(async (prompt: any) => {
    setPreviewContent(prompt.content || '');
  }, []);

  const toggleAbility = useCallback(async (type: 'skills' | 'prompts', name: string) => {
    if (!abilityPickerSession) return;
    const current = abilityPickerSession.abilities || { skills: [], prompts: [] };
    const list = [...(current[type] || [])];
    const idx = list.indexOf(name);
    if (idx >= 0) list.splice(idx, 1); else list.push(name);
    const newAbilities = { ...current, [type]: list };
    await api.updateSessionAbilities(abilityPickerSession.id, newAbilities);
    setAbilityPickerSession({ ...abilityPickerSession, abilities: newAbilities });
    refresh();
  }, [abilityPickerSession, refresh]);

  useEffect(() => {
    api.getBackends().then(setBackends);
    refresh();
  }, [refresh]);

  const renamingRef = useRef(false);  // 防止 Enter+blur 双触发
  const pickerRef = useRef<HTMLDivElement>(null);
  const sessionContextMenuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!sessionContextMenu || !sessionContextMenuRef.current) return;
    const margin = 8;
    const bounds = sessionContextMenuRef.current.getBoundingClientRect();
    const nextX = Math.max(margin, Math.min(sessionContextMenu.x, window.innerWidth - bounds.width - margin));
    const nextY = Math.max(margin, Math.min(sessionContextMenu.y, window.innerHeight - bounds.height - margin));
    if (nextX !== sessionContextMenu.x || nextY !== sessionContextMenu.y) {
      setSessionContextMenu((current) => current ? { ...current, x: nextX, y: nextY } : null);
    }
  }, [sessionContextMenu]);

  useEffect(() => {
    if (!sessionContextMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (sessionContextMenuRef.current?.contains(event.target as Node)) return;
      setSessionContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSessionContextMenu(null);
    };
    const handleViewportChange = () => setSessionContextMenu(null);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [sessionContextMenu]);

  const handleRenameStart = useCallback((s: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    renamingRef.current = false;
    setRenamingSessionId(s.id);
    setRenameValue(s.title);
    setTimeout(() => { renameInputRef.current?.select(); }, 0);
  }, []);

  const handleRenameConfirm = useCallback(async () => {
    if (!renamingSessionId || renamingRef.current) return;
    renamingRef.current = true;
    const title = renameValue.trim();
    setRenamingSessionId(null);
    if (!title) return;
    await api.renameSession(renamingSessionId, title);
    refresh();
    renamingRef.current = false;
  }, [renamingSessionId, renameValue, refresh]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleRenameConfirm(); }
    if (e.key === 'Escape') setRenamingSessionId(null);
    e.stopPropagation();
  }, [handleRenameConfirm]);

  const handleDeleteClick = useCallback((session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    // ★ Check if session is streaming
    if (streamingSessions.has(session.id)) {
      alert(`会话 "${session.title}" 正在进行中，无法删除。请等待完成或停止后再试。`);
      return;
    }
    setSessionToDelete(session);
  }, [streamingSessions]);

  const handleDestroyClick = useCallback((session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    if (streamingSessions.has(session.id)) {
      alert(`会话 "${session.title}" 正在运行，请先停止后再销毁。`);
      return;
    }
    setDestroyConfirmValue('');
    setDestroyError('');
    setSessionToDestroy(session);
  }, [streamingSessions]);

  const confirmDelete = useCallback(() => {
    if (sessionToDelete) {
      const deletedId = sessionToDelete.id;
      api.deleteSession(deletedId).then(() => {
        refresh();
        onDeleteSession?.(deletedId);
      });
      setSessionToDelete(null);
    }
  }, [sessionToDelete, refresh, onDeleteSession]);

  const confirmDestroy = useCallback(async () => {
    if (!sessionToDestroy || destroyConfirmValue !== '销毁' || destroying) return;
    setDestroying(true);
    setDestroyError('');
    const targetId = sessionToDestroy.id;
    try {
      const result = await api.destroySession(targetId, 'DESTROY');
      if (result.status !== 'ok') {
        setDestroyError(result.message || '销毁失败');
        return;
      }
      setSessionToDestroy(null);
      setDestroyConfirmValue('');
      await refresh();
      onDeleteSession?.(targetId);
    } finally {
      setDestroying(false);
    }
  }, [sessionToDestroy, destroyConfirmValue, destroying, refresh, onDeleteSession]);

  // ★ 本窗口新建会话时直接插入。createSession 返回的是完整且带节点归属的
  // 最新对象，不再立即整表重拉，避免旧索引把它短暂刷掉。
  useEffect(() => {
    const handleSessionCreated = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id) {
        // 使已经在途的旧列表结果失效。
        refreshGenerationRef.current += 1;
        // 立即插入新 session 到列表顶部，避免等待 API 往返
        setSessions(prev => {
          const index = prev.findIndex(s => s.id === detail.id);
          const next = [...prev];
          if (index >= 0) next[index] = { ...next[index], ...detail };
          else next.push(detail);
          next.sort(sortSessionsByPriority);
          return next;
        });
      }
    };
    window.addEventListener('session-created', handleSessionCreated);
    return () => window.removeEventListener('session-created', handleSessionCreated);
  }, []);

  // ★ 约束输入框聚焦 ref
  const constraintsRef = useRef<HTMLTextAreaElement>(null);
  const [showConstraintsInput, setShowConstraintsInput] = useState(false);

  // ★ Expose refresh to parent via custom event or ref if needed
  // For now, refresh when window gains focus (user might have created session elsewhere)
  useEffect(() => {
    const handleFocus = () => refresh();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refresh]);

  // 会话摘要是服务端的权威增量，直接 upsert，不再用随后的旧列表覆盖它。
  // 只有旧版/异常事件没有 summary 时才补一次列表刷新。
  useEffect(() => {
    const unsubscribeSession = api.onSessionUpdated((data: any) => {
      const sessionId = data?.sessionId;
      // 增量事件比任何更早发起的列表请求都新，旧请求完成后不得覆盖它。
      refreshGenerationRef.current += 1;
      let needsRefresh = false;
      if (data?.type === 'session_deleted' && sessionId) {
        setSessions((prev) => prev.filter((session) => session.id !== sessionId));
      } else if (data?.summary?.id) {
        setSessions((prev) => {
          const index = prev.findIndex((session) => session.id === data.summary.id);
          const next = [...prev];
          if (index >= 0) next[index] = { ...next[index], ...data.summary };
          else next.push(data.summary);
          next.sort(sortSessionsByPriority);
          return next;
        });
      } else if (data?.type === 'session_renamed' && sessionId) {
        setSessions((prev) => prev.map((session) => (
          session.id === sessionId ? { ...session, title: data.title || session.title } : session
        )));
      } else {
        needsRefresh = true;
      }
      if (needsRefresh) scheduleRefresh(120);
    });
    const unsubscribeExec = onExecStatus(() => scheduleRefresh(0));
    return () => {
      unsubscribeSession();
      unsubscribeExec();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
  }, [scheduleRefresh]);

  const getBackendShortLabel = useCallback((backendId: string) => {
    const backend = backends.find((b) => b.id === backendId);
    if (!backend) return backendId;
    const label = backend.label;
    if (label.includes('Sonnet')) return 'Sonnet';
    if (label.includes('Opus')) return 'Opus';
    if (label.includes('Haiku')) return 'Haiku';
    if (label.includes('GPT')) return 'GPT';
    return label.split(' ')[0];
  }, [backends]);

  const updateAppearance = useCallback(async (
    session: Session,
    patch: { pinned?: boolean; sidebarColor?: string },
  ) => {
    const previous = { pinned: !!session.pinned, sidebarColor: session.sidebarColor || '' };
    const applyLocal = (value: { pinned?: boolean; sidebarColor?: string }) => {
      setSessions((current) => current.map((item) => (
        item.id === session.id ? { ...item, ...value } : item
      )).sort(sortSessionsByPriority));
    };
    applyLocal(patch);
    const result = await api.updateSessionAppearance(session.id, patch);
    if (result.status !== 'ok') {
      applyLocal(previous);
      alert(result.message || '会话外观保存失败');
    }
  }, []);

  const openLoopConversion = useCallback((session: Session) => {
    setSessionToConvert(session);
    setConversionGoal('');
    setConversionError('');
    setConverting(false);
  }, []);

  const confirmLoopConversion = useCallback(async () => {
    if (!sessionToConvert || converting) return;
    const goal = conversionGoal.trim();
    if (!goal) {
      setConversionError('请先填写 LOOP 的全局目标');
      return;
    }
    setConverting(true);
    setConversionError('');
    try {
      const result = await api.convertSessionToLoop(sessionToConvert.id, goal);
      if (result.status !== 'ok') {
        setConversionError(result.message || '转换失败');
        return;
      }
      const convertedId = sessionToConvert.id;
      setSessionToConvert(null);
      setConversionGoal('');
      await refresh();
      onSelectSession(convertedId);
    } catch (error: any) {
      setConversionError(error?.message || '转换失败');
    } finally {
      setConverting(false);
    }
  }, [conversionGoal, converting, onSelectSession, refresh, sessionToConvert]);

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const visibleSessions = useMemo(() => {
    const filtered = normalizedSearch
      ? sessions.filter((session) => [
          session.title,
          session.workingDir,
          session.backendId,
          session.execLabel,
          session.sessionType,
        ].some((value) => String(value || '').toLocaleLowerCase().includes(normalizedSearch)))
      : sessions;
    return [...filtered].sort(sortSessionsByPriority);
  }, [sessions, normalizedSearch]);

  const pendingCount = completedSessions.size;

  // ★ 按执行节点分组：每个节点按配置展示最近 N 条；收藏和搜索不受此限制。
  const maxPerNode = Math.max(5, Math.min(500, Math.trunc(Number(sessionLimit) || 25)));
  const groups = useMemo(() => {
    const map = new Map<string, {
      key: string;
      label: string;
      isLocal: boolean;
      isDefault: boolean;
      sessions: Session[];
    }>();
    const pinnedSessions = visibleSessions.filter((session) => session.pinned);
    if (pinnedSessions.length) {
      map.set('__pinned__', {
        key: '__pinned__', label: '收藏', isLocal: false, isDefault: false, sessions: pinnedSessions,
      });
    }
    for (const s of visibleSessions) {
      if (s.pinned) continue;
      const key = s.execKey || 'local';
      const isLocal = s.execMode === 'local' || key === 'local';
      const label = isLocal ? '本机' : (s.execLabel || key);
      // “默认节点”只是新建 Session 的默认落点，绝不等于物理本机。
      const isDefault = s.execIsHome !== false;
      if (!map.has(key)) {
        map.set(key, { key, label, isLocal, isDefault, sessions: [] });
      }
      const grp = map.get(key)!;
      grp.isDefault = grp.isDefault || isDefault;
      if (normalizedSearch || grp.sessions.length < maxPerNode) {
        grp.sessions.push(s);
      }
    }
    // 物理本机在前，其次是默认远端节点，再按节点名排序。
    const arr = Array.from(map.values());
    arr.sort((a, b) => {
      if (a.key === '__pinned__') return -1;
      if (b.key === '__pinned__') return 1;
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return arr;
  }, [visibleSessions, normalizedSearch, maxPerNode]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // ★ 移动端折叠：完全隐藏，由顶栏的 ☰ 按钮负责唤出抽屉
  if (collapsed && isMobile) {
    return null;
  }

  // ★ 折叠状态：只显示窄条 + 展开按钮，有未确认通知时显示角标
  if (collapsed) {
    return (
      <div className="awu-sidebar" style={collapsedSidebarStyle}>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <button
            onClick={onToggleCollapse}
            style={toggleBtnStyle}
            title="展开侧栏"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          {pendingCount > 0 && (
            <span style={{
              position: 'absolute', top: -4, right: -4,
              minWidth: 14, height: 14, borderRadius: 7,
              background: '#ef4444', color: '#fff',
              fontSize: 9, fontWeight: 700, lineHeight: '14px',
              textAlign: 'center', padding: '0 3px',
              pointerEvents: 'none',
            }}>
              {pendingCount > 9 ? '9+' : pendingCount}
            </span>
          )}
        </div>
        <button onClick={onNewSession} style={{ ...toggleBtnStyle, marginTop: 4 }} title="New session">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="awu-sidebar" style={isMobile ? mobileSidebarStyle : { ...sidebarStyle, width: width ?? 260 }}>
      <style>{`
        @keyframes awuSidebarRunningPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.25); }
        }
        @keyframes badgePulse {
          0%, 100% { transform: scale(1);    opacity: 1; }
          50%       { transform: scale(1.15); opacity: 0.82; }
        }
        @keyframes dialogSlideIn {
          from { opacity: 0; transform: translateY(8px) scale(.985); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes awuSidebarStreamBorderFlow {
          from { transform: translateY(-66%); }
          to   { transform: translateY(66%); }
        }
        .session-streaming-item {
          border-left: 3px solid transparent !important;
          background-clip: padding-box;
          position: relative;
          overflow: hidden;
        }
        .session-streaming-item::before {
          content: '';
          position: absolute;
          left: 0; top: -100%; bottom: -100%;
          width: 3px;
          border-radius: 3px 0 0 3px;
          background: linear-gradient(180deg, transparent, #22c55e 30%, #7aa2f7 70%, transparent);
          will-change: transform;
          animation: awuSidebarStreamBorderFlow 1.6s linear infinite;
        }
        .session-notify-badge {
          position: absolute;
          top: -5px;
          right: -5px;
          min-width: 16px;
          height: 16px;
          border-radius: 8px;
          background: #ef4444;
          color: #fff;
          font-size: 9px;
          font-weight: 700;
          line-height: 16px;
          text-align: center;
          padding: 0 4px;
          cursor: pointer;
          animation: badgePulse 1.8s ease-in-out infinite;
          border: 1.5px solid var(--theme-bg, #1a1a2e);
          z-index: 10;
          transition: background 0.15s, transform 0.1s;
          user-select: none;
        }
        .awu-session-context-menu {
          position: fixed;
          width: 224px;
          max-height: calc(100vh - 16px);
          padding: 6px;
          overflow-y: auto;
          border: 1px solid var(--theme-border, rgba(127,127,127,.24));
          border-radius: 9px;
          background: var(--theme-popover-bg, var(--theme-bg-secondary, #fff));
          opacity: 1;
          backdrop-filter: none;
          box-shadow: 0 18px 48px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.035);
          z-index: 10060;
          isolation: isolate;
          user-select: none;
          animation: awuSessionContextIn .12s ease-out;
        }
        @keyframes awuSessionContextIn {
          from { opacity: 0; transform: translateY(-3px) scale(.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .awu-session-context-title {
          padding: 6px 9px 7px;
          overflow: hidden;
          color: var(--theme-text-muted, #656d76);
          font-size: 10px;
          line-height: 1.35;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .awu-session-context-item {
          width: 100%;
          min-height: 32px;
          padding: 6px 9px;
          display: flex;
          align-items: center;
          gap: 9px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--theme-text, #1f2328);
          cursor: pointer;
          font: 12px/1.35 inherit;
          text-align: left;
        }
        .awu-session-context-item:hover:not(:disabled),
        .awu-session-context-item:focus-visible:not(:disabled) {
          outline: none;
          background: var(--theme-accent-bg, rgba(122,162,247,.14));
          color: var(--theme-accent, #7aa2f7);
        }
        .awu-session-context-item:disabled {
          opacity: .42;
          cursor: not-allowed;
        }
        .awu-session-context-icon {
          width: 17px;
          flex: 0 0 17px;
          color: var(--theme-text-muted, #656d76);
          font-size: 14px;
          text-align: center;
        }
        .awu-session-context-item-danger {
          color: var(--theme-error, #ef4444);
        }
        .awu-session-context-separator {
          height: 1px;
          margin: 5px 4px;
          background: var(--theme-border, rgba(127,127,127,.2));
        }
        .session-notify-badge:hover {
          background: #dc2626;
          transform: scale(1.2) !important;
          animation: none;
        }
        .session-notify-badge-wrap {
          position: absolute;
          top: 0; right: 0; bottom: 0; left: 0;
          pointer-events: none;
        }
        .awu-session-group-toggle {
          position: relative;
          background: transparent !important;
          border-color: transparent !important;
        }
        .awu-session-group-toggle[data-collapsed="true"] {
          background: var(--theme-bg-secondary, rgba(255,255,255,.035)) !important;
          border-color: var(--theme-border, rgba(127,127,127,.14)) !important;
          box-shadow: 0 1px 0 rgba(0,0,0,.05);
        }
        .awu-session-group-toggle:hover {
          filter: none !important;
          background: var(--theme-bg-secondary, rgba(255,255,255,.045)) !important;
          border-color: var(--theme-border, rgba(127,127,127,.2)) !important;
        }
        .awu-session-group-toggle:focus-visible {
          outline: 2px solid var(--theme-accent, #7aa2f7);
          outline-offset: 1px;
        }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '10px 10px 7px' }}>
        <button
          onClick={onToggleCollapse}
          style={toggleBtnStyle}
          title="收起侧栏"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        {/* 视图切换：💬 会话 / 🗂 文件 */}
        <div style={{ display: 'flex', gap: 0, border: '1px solid var(--theme-border)', borderRadius: 5, overflow: 'hidden', background: 'var(--theme-bg-secondary)' }}>
          <button onClick={() => setView('sessions')} title="会话列表"
            style={{ ...viewTabStyle, ...(view === 'sessions' ? viewTabActive : {}) }}>💬</button>
          <button onClick={() => setView('files')} title="文件目录（本地 ⇄ 远端）"
            style={{ ...viewTabStyle, ...(view === 'files' ? viewTabActive : {}) }}>🗂</button>
        </div>
        <div style={{ flex: 1 }} />
        {view === 'sessions' && (
          <button onClick={onNewSession} style={newBtnStyle} title="New session">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        )}
      </div>
      {view === 'sessions' && (
        <div style={searchWrapStyle}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
            style={searchInputStyle}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              title="清空搜索"
              aria-label="清空搜索"
              style={searchClearStyle}
            >
              ×
            </button>
          )}
        </div>
      )}
      {view === 'files' ? (
        activeCodexRemoteHost ? (
          <div style={{ margin: 12, padding: 14, border: '1px solid var(--theme-border)', borderRadius: 8, color: 'var(--theme-text-muted)', fontSize: 12, lineHeight: 1.65 }}>
            <div style={{ color: 'var(--theme-text)', fontWeight: 600, marginBottom: 5 }}>🌐 Codex SSH Remote · {activeCodexRemoteHost}</div>
            当前会话的文件与命令位于 SSH 主机上，由远端 Codex 工具操作。为避免误操作本机同名目录，这里不展示本机文件树。
          </div>
        ) : <FileTreePanel sessionId={activeSessionId || undefined} workingDir={activeWorkingDir || ''} execKey={activeExecKey} execLabel={activeExecLabel} execMode={activeExecMode} backendId={activeBackendId}
          focusRequest={activeSessionMetaId === activeSessionId && fileFocusRequest?.sessionId === activeSessionId ? fileFocusRequest : null}
          onAttentionChange={onAttentionChange} />
      ) : (
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 7px 10px' }}>
        {groups.map(group => {
          // 多组时显示组头；单组（仅本机）不显示
          const isPinnedGroup = group.key === '__pinned__';
          const showGroupHeader = groups.length > 1 || isPinnedGroup;
          // 只有标题可见时才允许折叠，避免分组数量变化后留下一个无法展开的隐藏组。
          const isCollapsed = showGroupHeader && collapsedGroups.has(group.key);
          const groupTone = isPinnedGroup
            ? { accent: '#d9ad45', iconBackground: 'rgba(217,173,69,.13)' }
            : { accent: 'var(--theme-accent, #7aa2f7)', iconBackground: 'var(--theme-accent-bg, rgba(122,162,247,.13))' };
          const groupLabel = isPinnedGroup
            ? '收藏'
            : group.isLocal
              ? (isTauri() ? '本机' : '当前 Web 节点')
              : group.label;
          const groupDescription = isPinnedGroup
            ? '置顶会话'
            : group.isLocal
              ? '此设备执行'
              : '远程执行节点';
          return (
            <section key={group.key} style={groupSectionStyle}>
              {showGroupHeader && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  className="awu-session-group-toggle"
                  data-collapsed={isCollapsed ? 'true' : 'false'}
                  style={{
                    ...groupHeaderStyle,
                  }}
                  title={`${isCollapsed ? '展开' : '收起'}${isPinnedGroup ? '收藏会话' : groupDescription}`}
                  aria-expanded={!isCollapsed}
                >
                  <span style={{
                    ...groupIconStyle,
                    color: groupTone.accent,
                    background: groupTone.iconBackground,
                  }} aria-hidden="true">
                    {isPinnedGroup ? (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                        <path d="m12 2.8 2.72 5.52 6.09.88-4.4 4.29 1.04 6.06L12 16.68l-5.45 2.87 1.04-6.06-4.4-4.29 6.09-.88L12 2.8Z" />
                      </svg>
                    ) : group.isLocal ? (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        {isTauri()
                          ? <><path d="m4.5 11 7.5-6.5 7.5 6.5" /><path d="M6.5 10v9h11v-9" /><path d="M10 19v-5h4v5" /></>
                          : <><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M9 20h6M12 16v4" /></>}
                      </svg>
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="6" r="2.5" /><circle cx="6" cy="17" r="2.5" /><circle cx="18" cy="17" r="2.5" /><path d="M12 8.5v3M6 14.5v-3h12v3" />
                      </svg>
                    )}
                  </span>
                  <span style={groupTitleWrapStyle}>
                    <span style={groupTitleStyle}>{groupLabel}</span>
                    <span style={groupDescriptionStyle}>{groupDescription}</span>
                  </span>
                  <span style={groupCountStyle}>{group.sessions.length}</span>
                  <span style={groupChevronStyle} aria-hidden="true">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform .18s ease' }}
                    >
                      <path d="m7 9 5 5 5-5" />
                    </svg>
                  </span>
                </button>
              )}
              {!isCollapsed && (
                <div style={showGroupHeader ? groupSessionsStyle : undefined}>
                {group.sessions.map((s: Session) => {
                const isRunning = streamingSessions.has(s.id);
                const isCompleted = !isRunning && completedSessions.has(s.id);
                const isActive = s.id === activeSessionId;
                const isContextTarget = sessionContextMenu?.session.id === s.id;
                // “接管既有 thread”是来源，“SSH Codex”是执行位置；两者可同时成立。
                const isCodexAttached = s.codexThreadAttached === true
                  || (s.codexThreadAttached === undefined && s.codexConnectionMode === 'node');
                const isCodexSsh = s.codexConnectionMode === 'ssh';
                const rowBackground = getSessionRowBackground(s.sidebarColor || '', isActive);

                return (
                <div
                  key={s.id}
                  onClick={() => {
                    setSessionContextMenu(null);
                    onSelectSession(s.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSessionContextMenu({ session: s, x: event.clientX, y: event.clientY });
                  }}
                  aria-haspopup="menu"
                  className={isRunning ? 'session-streaming-item' : undefined}
                  style={{
                    ...itemStyle,
                    background: rowBackground,
                    ...(isContextTarget && !isActive ? { boxShadow: 'inset 0 0 0 1px var(--theme-accent, #7aa2f7)' } : {}),
                    ...(isActive ? { boxShadow: 'inset 2px 0 0 var(--theme-accent, #7aa2f7)' } : {}),
                    ...(isRunning ? { borderColor: '#22c55e55' } : {}),
                    ...(isCompleted ? { borderColor: '#ef444455' } : {}),
                  }}
                  title={[s.title, s.workingDir, getBackendShortLabel(s.backendId)].filter(Boolean).join('\n')}
                >
                  {isRunning && (
                    <span style={{
                      ...runningDotStyle,
                      animation: 'awuSidebarRunningPulse 1.5s ease-in-out infinite',
                      willChange: 'transform, opacity',
                    }} />
                  )}
                  {isCompleted && (
                    <button
                      title="点击确认已查看"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAcknowledgeSession?.(s.id);
                      }}
                      style={completedDotStyle}
                    >
                      !
                    </button>
                  )}
                  {renamingSessionId === s.id ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={handleRenameConfirm}
                      onKeyDown={handleRenameKeyDown}
                      onClick={(e) => e.stopPropagation()}
                      onContextMenu={(e) => e.stopPropagation()}
                      autoFocus
                      style={renameInputStyle}
                    />
                  ) : (
                    <div style={sessionTitleStyle}>
                      {s.sessionType === 'loop' && <span title="LOOP 会话">🔁</span>}
                      {(s.execMode === 'relay' || String(s.execKey || '').startsWith('relay:'))
                        && <span title={`远程执行：${s.execLabel || '执行端'}`}>🌐</span>}
                      {isCodexAttached && <span title="接管已有 Codex thread">🧲</span>}
                      {isCodexSsh && <span title={`SSH Codex：${s.codexRemoteHost || '远端主机'}`}>⌁</span>}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isActive ? 'var(--theme-accent, #7aa2f7)' : 'var(--theme-text, #e2e3ea)' }}>
                        {s.title}
                      </span>
                    </div>
                  )}
                  <div style={compactActionsStyle}>
                    <span
                      style={{
                        ...compactBackendStyle,
                        background: getBackendBadgeColor(s.backendId),
                      }}
                      title={getBackendShortLabel(s.backendId)}
                    >
                      {getBackendShortLabel(s.backendId)}
                    </span>
                    {s.pinned && <span style={{ color: '#f5c451', fontSize: 13 }} title="已置顶">★</span>}
                  </div>
                </div>
              );
              })}
                </div>
              )}
            </section>
          );
        })}
        {sessions.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--theme-text-muted, #656d76)', fontSize: 13, padding: 20 }}>
            还没有会话
          </div>
        )}
        {sessions.length > 0 && visibleSessions.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--theme-text-muted, #656d76)', fontSize: 12, padding: 20 }}>
            没有匹配的会话
          </div>
        )}
      </div>
      )}

      {sessionContextMenu && (
        <AppModalPortal>
        <div
          ref={sessionContextMenuRef}
          className="awu-session-context-menu"
          role="menu"
          aria-label={`${sessionContextMenu.session.title} 的会话操作`}
          style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="awu-session-context-title" title={sessionContextMenu.session.title}>
            {sessionContextMenu.session.title}
          </div>
          <button
            type="button"
            className="awu-session-context-item"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              const target = sessionContextMenu.session;
              setSessionContextMenu(null);
              void updateAppearance(target, { pinned: !target.pinned });
            }}
          >
            <span className="awu-session-context-icon">{sessionContextMenu.session.pinned ? '★' : '☆'}</span>
            <span>{sessionContextMenu.session.pinned ? '取消置顶' : '收藏并置顶'}</span>
          </button>
          <button
            type="button"
            className="awu-session-context-item"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              const target = sessionContextMenu.session;
              setSessionContextMenu(null);
              setAppearancePickerSession(target);
            }}
          >
            <span className="awu-session-context-icon">◐</span>
            <span>配置底色</span>
          </button>
          <button
            type="button"
            className="awu-session-context-item"
            role="menuitem"
            onClick={(event) => {
              const target = sessionContextMenu.session;
              setSessionContextMenu(null);
              handleRenameStart(target, event);
            }}
          >
            <span className="awu-session-context-icon">✎</span>
            <span>重命名</span>
          </button>
          <button
            type="button"
            className="awu-session-context-item"
            role="menuitem"
            onClick={(event) => {
              const target = sessionContextMenu.session;
              setSessionContextMenu(null);
              void openAbilityPicker(target, event);
            }}
          >
            <span className="awu-session-context-icon">🧩</span>
            <span>绑定能力</span>
          </button>
          {sessionContextMenu.session.sessionType !== 'loop' && (
            <button
              type="button"
              className="awu-session-context-item"
              role="menuitem"
              disabled={streamingSessions.has(sessionContextMenu.session.id)}
              title={streamingSessions.has(sessionContextMenu.session.id)
                ? '会话运行中，结束后才能转换为 LOOP'
                : '保留当前会话、聊天记录和工作目录，制定目标后转为 LOOP'}
              onClick={(event) => {
                event.stopPropagation();
                const target = sessionContextMenu.session;
                setSessionContextMenu(null);
                openLoopConversion(target);
              }}
            >
              <span className="awu-session-context-icon">🔁</span>
              <span>转为 LOOP…</span>
            </button>
          )}
          <div className="awu-session-context-separator" role="separator" />
          <button
            type="button"
            className="awu-session-context-item"
            role="menuitem"
            disabled={streamingSessions.has(sessionContextMenu.session.id)}
            title={streamingSessions.has(sessionContextMenu.session.id) ? '会话运行中，暂时无法删除' : '仅删除会话记录，保留工作目录'}
            onClick={(event) => {
              const target = sessionContextMenu.session;
              setSessionContextMenu(null);
              handleDeleteClick(target, event);
            }}
          >
            <span className="awu-session-context-icon">×</span>
            <span>删除会话（保留目录）</span>
          </button>
          <button
            type="button"
            className="awu-session-context-item awu-session-context-item-danger"
            role="menuitem"
            disabled={streamingSessions.has(sessionContextMenu.session.id)}
            title={streamingSessions.has(sessionContextMenu.session.id) ? '会话运行中，暂时无法销毁' : '永久删除会话与整个工作目录'}
            onClick={(event) => {
              const target = sessionContextMenu.session;
              setSessionContextMenu(null);
              handleDestroyClick(target, event);
            }}
          >
            <span className="awu-session-context-icon">♨</span>
            <span>销毁会话与工作目录</span>
          </button>
        </div>
        </AppModalPortal>
      )}

      {/* 能力绑定面板 */}
      {abilityPickerSession && (
        <div ref={pickerRef} style={overlayStyle} onClick={() => setAbilityPickerSession(null)}>
          <div style={{
            ...confirmPanelStyle,
            maxWidth: 720,
            width: '90%',
            height: '80vh',
            display: 'flex',
            flexDirection: 'column',
            animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)'
          }} onClick={(e) => e.stopPropagation()}>
            {/* 头部：显示会话名称和关闭按钮 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text)' }}>
                编辑会话
                <span style={{ marginLeft: 6, color: 'var(--theme-accent)', fontSize: 13, fontWeight: 500 }}>"{abilityPickerSession.title}"</span>
              </span>
              <button onClick={() => setAbilityPickerSession(null)} style={{
                fontSize: 14, padding: '2px 6px', borderRadius: 4,
                border: '1px solid var(--theme-border)', background: 'transparent',
                color: 'var(--theme-text-muted)', cursor: 'pointer', width: 24, height: 24,
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                ✕
              </button>
            </div>

            {/* 主体内容：上下布局 */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
              {/* 上方：Skills 和 Prompts 左右分栏 - 占 45% */}
              <div style={{ flex: '0 0 45%', display: 'flex', gap: 16, minHeight: 0 }}>
                {/* Skills 列 */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 6, textTransform: 'uppercase' }}>⚡ Skills</div>
                  <div style={{
                    flex: 1, overflowY: 'auto', border: '1px solid var(--theme-border)',
                    borderRadius: 8, overflow: 'hidden', padding: '4px'
                  }}>
                    {availableSkills.length > 0 ? (
                      availableSkills.map((sk: any) => {
                        const bound = (abilityPickerSession.abilities?.skills || []).includes(sk.name);
                        return (
                          <div
                            key={sk.id}
                            onClick={(e) => { e.stopPropagation(); toggleAbility('skills', sk.name); }}
                            style={{
                              padding: '6px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                              background: bound ? 'var(--theme-accent-bg, rgba(122,162,247,0.08))' : 'transparent',
                              borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.04))',
                            }}
                          >
                            <div style={{
                              width: 14, height: 14, borderRadius: 3, borderWidth: 2, borderStyle: 'solid',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: bound ? 'var(--theme-accent)' : 'transparent',
                              borderColor: bound ? 'var(--theme-accent)' : 'var(--theme-border)',
                            }}>
                              {bound && <div style={{ width: 6, height: 6, background: '#fff', borderRadius: 1 }} />}
                            </div>
                            <span style={{ flex: 1, fontSize: 12, color: 'var(--theme-text)' }}>{sk.name}</span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                onClick={(e) => { e.stopPropagation(); show_preview_skill(sk); }}
                                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--theme-border)', background: 'transparent', color: 'var(--theme-text-muted)', cursor: 'pointer' }}
                              >
                                预览
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); setItemToDelete({ type: 'skills', name: sk.name }); }}
                                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #ef4444', background: 'rgba(239,68,68,0.1)', color: '#ef4444', cursor: 'pointer' }}
                                title="取消绑定"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ padding: 12, textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 12 }}>
                        暂无 Skills，请先在 Repo 中创建
                      </div>
                    )}
                  </div>
                </div>

                {/* Prompts 列 */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 6, textTransform: 'uppercase' }}>📝 Prompts</div>
                  <div style={{
                    flex: 1, overflowY: 'auto', border: '1px solid var(--theme-border)',
                    borderRadius: 8, overflow: 'hidden', padding: '4px'
                  }}>
                    {availablePrompts.length > 0 ? (
                      availablePrompts.map((p: any) => {
                        const bound = (abilityPickerSession.abilities?.prompts || []).includes(p.name);
                        return (
                          <div
                            key={p.id}
                            onClick={(e) => { e.stopPropagation(); toggleAbility('prompts', p.name); }}
                            style={{
                              padding: '6px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                              background: bound ? 'var(--theme-accent-bg, rgba(122,162,247,0.08))' : 'transparent',
                              borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.04))',
                            }}
                          >
                            <div style={{
                              width: 14, height: 14, borderRadius: 3, borderWidth: 2, borderStyle: 'solid',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: bound ? 'var(--theme-accent)' : 'transparent',
                              borderColor: bound ? 'var(--theme-accent)' : 'var(--theme-border)',
                            }}>
                              {bound && <div style={{ width: 6, height: 6, background: '#fff', borderRadius: 1 }} />}
                            </div>
                            <span style={{ flex: 1, fontSize: 12, color: 'var(--theme-text)' }}>{p.icon || '📝'} {p.name}</span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                onClick={(e) => { e.stopPropagation(); show_preview_prompt(p); }}
                                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--theme-border)', background: 'transparent', color: 'var(--theme-text-muted)', cursor: 'pointer' }}
                              >
                                预览
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); setItemToDelete({ type: 'prompts', name: p.name }); }}
                                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #ef4444', background: 'rgba(239,68,68,0.1)', color: '#ef4444', cursor: 'pointer' }}
                                title="取消绑定"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ padding: 12, textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 12 }}>
                        暂无 Prompts，请先在 Repo 中创建
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 下方：临时 Session 级约束 - 占 45% */}
              <div style={{ flex: '0 0 45%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 6 }}>
                  临时约束/rule
                  <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 400, color: 'var(--theme-text-muted)', background: 'var(--theme-accent-bg)', padding: '2px 8px', borderRadius: 4 }}>
                    Session 级临时生效
                  </span>
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <textarea
                    value={constraintsValue}
                    onChange={(e) => setConstraintsValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="输入临时约束规则（仅本次会话有效）..."
                    style={{
                      flex: 1, fontSize: 12, resize: 'none',
                      background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                      borderRadius: 8, padding: '10px 12px', color: 'var(--theme-text)',
                      fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', minHeight: 160,
                    }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8, gap: 8 }}>
                    <button
                      onClick={() => setConstraintsValue('')}
                      style={{ fontSize: 11, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--theme-border)', background: 'transparent', color: 'var(--theme-text-muted)', cursor: 'pointer' }}
                    >
                      清空约束
                    </button>
                    <button
                      onClick={() => {
                        const current = abilityPickerSession.abilities || { skills: [], prompts: [] };
                        const newAbilities = { ...current, constraints: constraintsValue };
                        api.updateSessionAbilities(abilityPickerSession.id, newAbilities);
                        setAbilityPickerSession(null);
                      }}
                      style={{ ...confirmBtnStyle, fontSize: 12, padding: '6px 16px' }}
                    >
                      保存并关闭
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* 预览对话框 */}
            {previewContent && (
              <div style={overlayStyle} onClick={() => setPreviewContent(null)}>
                <div style={{ ...confirmPanelStyle, maxWidth: 520, animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)' }} onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--theme-border)' }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--theme-text)' }}>预览内容</h3>
                    <button onClick={() => setPreviewContent(null)} style={{
                      fontSize: 14, padding: '2px 6px', borderRadius: 4,
                      border: '1px solid var(--theme-border)', background: 'transparent',
                      color: 'var(--theme-text-muted)', cursor: 'pointer', width: 24, height: 24
                    }}>
                      ✕
                    </button>
                  </div>
                  <div style={{ background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)', borderRadius: 8, padding: 12, maxHeight: 400, overflowY: 'auto' }}>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6, color: 'var(--theme-text)' }}>
                      {previewContent}
                    </pre>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                    <button onClick={() => setPreviewContent(null)} style={confirmBtnStyle}>关闭</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 受控渐变色板：只保存 preset id，不把任意 CSS 写入 Session。 */}
      {appearancePickerSession && (
        <div style={overlayStyle} onClick={() => setAppearancePickerSession(null)}>
          <div style={{ ...confirmPanelStyle, maxWidth: 360, padding: 18 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--theme-text)' }}>会话底色</div>
                <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {appearancePickerSession.title}
                </div>
              </div>
              <button onClick={() => setAppearancePickerSession(null)} style={actionBtnStyle} aria-label="关闭">×</button>
            </div>
            <div style={colorGridStyle}>
              {SESSION_COLOR_PRESETS.map((preset) => {
                const selected = (appearancePickerSession.sidebarColor || '') === preset.id;
                return (
                  <button
                    key={preset.id || 'none'}
                    onClick={async () => {
                      await updateAppearance(appearancePickerSession, { sidebarColor: preset.id });
                      setAppearancePickerSession(null);
                    }}
                    style={{
                      ...colorPresetStyle,
                      background: preset.background,
                      boxShadow: selected ? '0 0 0 2px var(--theme-accent, #7aa2f7)' : 'none',
                    }}
                    title={preset.label}
                  >
                    <span style={{
                      fontSize: 10,
                      color: preset.id ? '#fff' : 'var(--theme-text-muted)',
                      textShadow: preset.id ? '0 1px 3px rgba(0,0,0,.7)' : 'none',
                    }}>
                      {preset.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 删除确认对话框 */}
      {sessionToDelete && (
        <div style={overlayStyle}>
          <div style={{ ...confirmPanelStyle, animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600, color: 'var(--theme-text, #1f2328)' }}>
              确认删除会话
            </h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
              确定要删除会话 <strong style={{ color: 'var(--theme-error, #cf222e)' }}>{sessionToDelete.title}</strong> 吗？
            </p>
            <p style={{ fontSize: 12, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0' }}>
              仅删除会话记录及其 {sessionToDelete.messageCount} 条消息，工作目录和文件会保留。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={confirmDelete} style={confirmBtnStyle}>
                删除
              </button>
              <button onClick={() => setSessionToDelete(null)} style={cancelBtnStyle}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 普通 Session 转 LOOP：转换时必须明确制定目标。 */}
      {sessionToConvert && (
        <AppModalPortal>
          <div style={overlayStyle} onClick={() => { if (!converting) setSessionToConvert(null); }}>
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="awu-convert-loop-title"
              style={{ ...confirmPanelStyle, width: 'min(520px, calc(100vw - 32px))', maxWidth: 520 }}
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="awu-convert-loop-title" style={{ margin: '0 0 8px', fontSize: 17, color: 'var(--theme-text)' }}>
                🔁 转为 LOOP
              </h3>
              <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.6, color: 'var(--theme-text-muted)' }}>
                将 <strong style={{ color: 'var(--theme-text)' }}>{sessionToConvert.title}</strong> 转为 LOOP。
                当前聊天记录、Backend 和工作目录都会保留。
              </p>
              <div style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text-muted)' }}>
                转换后直接进入 Execute，由你手动开始第一轮；不会自动运行。
              </div>
              <label htmlFor="awu-convert-loop-goal" style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 700, color: 'var(--theme-text)' }}>
                全局目标 <span style={{ color: 'var(--theme-error, #cf222e)' }}>*</span>
              </label>
              <textarea
                id="awu-convert-loop-goal"
                autoFocus
                value={conversionGoal}
                disabled={converting}
                onChange={(event) => {
                  setConversionGoal(event.target.value);
                  if (conversionError) setConversionError('');
                }}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void confirmLoopConversion();
                  }
                }}
                placeholder="写清最终要交付什么，以及怎样判断完成…"
                style={{
                  width: '100%', minHeight: 118, resize: 'vertical', boxSizing: 'border-box',
                  padding: '10px 12px', borderRadius: 8, border: '1px solid var(--theme-border)',
                  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)',
                  font: 'inherit', fontSize: 13, lineHeight: 1.55, outline: 'none',
                }}
              />
              {conversionError && (
                <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--theme-error, #cf222e)' }}>
                  {conversionError}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <button
                  type="button"
                  onClick={() => setSessionToConvert(null)}
                  disabled={converting}
                  style={cancelBtnStyle}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void confirmLoopConversion()}
                  disabled={converting || !conversionGoal.trim()}
                  style={{ ...confirmBtnStyle, opacity: converting || !conversionGoal.trim() ? 0.55 : 1 }}
                >
                  {converting ? '转换中…' : '确认转为 LOOP'}
                </button>
              </div>
              <div style={{ marginTop: 9, textAlign: 'right', fontSize: 10.5, color: 'var(--theme-text-muted)' }}>
                Ctrl/⌘ + Enter 确认
              </div>
            </div>
          </div>
        </AppModalPortal>
      )}

      {/* 销毁与普通删除严格分离：必须输入中文“销毁”后才能触发执行端目录删除。 */}
      {sessionToDestroy && (
        <div style={overlayStyle}>
          <div style={{ ...confirmPanelStyle, maxWidth: 460, border: '1px solid rgba(239,68,68,.48)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 10px', fontSize: 16, color: 'var(--theme-error, #ef4444)' }}>
              ♨ 销毁 Session 与工作目录
            </h3>
            <p style={{ margin: '0 0 10px', fontSize: 12, lineHeight: 1.6, color: 'var(--theme-text-muted)' }}>
              这不同于普通删除：执行端会永久删除 <strong>{sessionToDestroy.title}</strong> 的工作目录及其中全部文件，然后删除 Session。此操作不可恢复。
            </p>
            <div style={destroyPathStyle}>{sessionToDestroy.workingDir || '未设置目录'}</div>
            <label style={{ display: 'block', margin: '13px 0 6px', fontSize: 11, color: 'var(--theme-text-muted)' }}>
              输入“销毁”确认
            </label>
            <input
              autoFocus
              value={destroyConfirmValue}
              onChange={(e) => { setDestroyConfirmValue(e.target.value); setDestroyError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void confirmDestroy(); }}
              disabled={destroying}
              style={{ ...renameInputStyle, width: '100%', boxSizing: 'border-box' }}
              placeholder="销毁"
            />
            {destroyError && (
              <div style={{ marginTop: 9, padding: '7px 9px', borderRadius: 6, background: 'rgba(239,68,68,.10)', color: 'var(--theme-error, #ef4444)', fontSize: 11, lineHeight: 1.5 }}>
                {destroyError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 15 }}>
              <button
                onClick={() => void confirmDestroy()}
                disabled={destroyConfirmValue !== '销毁' || destroying}
                style={{
                  ...confirmBtnStyle,
                  opacity: destroyConfirmValue === '销毁' && !destroying ? 1 : 0.45,
                  cursor: destroyConfirmValue === '销毁' && !destroying ? 'pointer' : 'not-allowed',
                }}
              >
                {destroying ? '正在销毁…' : '永久销毁'}
              </button>
              <button
                onClick={() => { setSessionToDestroy(null); setDestroyError(''); }}
                disabled={destroying}
                style={cancelBtnStyle}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除技能/提示确认对话框 */}
      {itemToDelete && (
        <div style={overlayStyle}>
          <div style={{ ...confirmPanelStyle, animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600, color: 'var(--theme-text, #1f2328)' }}>
              确认取消绑定
            </h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
              确定要取消绑定 <strong style={{ color: 'var(--theme-error, #cf222e)' }}>{itemToDelete.name}</strong> 吗？
            </p>
            <p style={{ fontSize: 12, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0' }}>
              此操作将在保存后生效。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={confirmDeleteItem} style={confirmBtnStyle}>
                确认
              </button>
              <button onClick={() => setItemToDelete(null)} style={cancelBtnStyle}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  return prevProps.activeSessionId === nextProps.activeSessionId
    && prevProps.streamingSessions === nextProps.streamingSessions
    && prevProps.completedSessions === nextProps.completedSessions
    && prevProps.collapsed === nextProps.collapsed
    && prevProps.isMobile === nextProps.isMobile
    && prevProps.width === nextProps.width
    && prevProps.activeWorkingDir === nextProps.activeWorkingDir
    && prevProps.activeSessionMetaId === nextProps.activeSessionMetaId
    && prevProps.activeExecKey === nextProps.activeExecKey
    && prevProps.activeExecLabel === nextProps.activeExecLabel
    && prevProps.activeExecMode === nextProps.activeExecMode
    && prevProps.activeBackendId === nextProps.activeBackendId
    && prevProps.activeCodexRemoteHost === nextProps.activeCodexRemoteHost
    && prevProps.fileFocusRequest?.requestId === nextProps.fileFocusRequest?.requestId
    && prevProps.sessionLimit === nextProps.sessionLimit;
});

const SESSION_COLOR_PRESETS = [
  { id: '', label: '无', background: 'var(--theme-bg-secondary, #f6f8fa)' },
  { id: 'ocean', label: '海蓝', background: 'linear-gradient(110deg, #0284c7, #2563eb)' },
  { id: 'violet', label: '星紫', background: 'linear-gradient(110deg, #7c3aed, #c026d3)' },
  { id: 'sunset', label: '晚霞', background: 'linear-gradient(110deg, #ea580c, #e11d48)' },
  { id: 'forest', label: '森林', background: 'linear-gradient(110deg, #15803d, #0f766e)' },
  { id: 'amber', label: '琥珀', background: 'linear-gradient(110deg, #b45309, #ca8a04)' },
  { id: 'rose', label: '玫瑰', background: 'linear-gradient(110deg, #be123c, #9333ea)' },
] as const;

const SESSION_ROW_GRADIENTS: Record<string, string> = {
  ocean: 'linear-gradient(105deg, rgba(2,132,199,.24), rgba(37,99,235,.10))',
  violet: 'linear-gradient(105deg, rgba(124,58,237,.25), rgba(192,38,211,.10))',
  sunset: 'linear-gradient(105deg, rgba(234,88,12,.24), rgba(225,29,72,.10))',
  forest: 'linear-gradient(105deg, rgba(21,128,61,.24), rgba(15,118,110,.10))',
  amber: 'linear-gradient(105deg, rgba(180,83,9,.25), rgba(202,138,4,.10))',
  rose: 'linear-gradient(105deg, rgba(190,18,60,.24), rgba(147,51,234,.10))',
};

function sortSessionsByPriority(a: Session, b: Session): number {
  const pinnedOrder = Number(!!b.pinned) - Number(!!a.pinned);
  return pinnedOrder || (Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

function getSessionRowBackground(presetId: string, isActive: boolean): string {
  const gradient = SESSION_ROW_GRADIENTS[presetId];
  if (gradient && isActive) {
    return `linear-gradient(rgba(122,162,247,.13), rgba(122,162,247,.13)), ${gradient}`;
  }
  if (gradient) return gradient;
  return isActive ? 'var(--theme-accent-bg, #7aa2f726)' : 'transparent';
}

// Simple color mapping for backend badges
// Using solid colors that work on both light and dark backgrounds
function getBackendBadgeColor(backendId: string): string {
  if (backendId.includes('opus')) return '#a855f733';  // Purple with alpha
  if (backendId.includes('sonnet')) return '#6366f133'; // Indigo with alpha
  if (backendId.includes('haiku')) return '#22c55e33';  // Green with alpha
  if (backendId.includes('gpt')) return '#ef444433';    // Red with alpha
  return '#94a3b833';                                    // Slate with alpha
}

const sidebarStyle: React.CSSProperties = {
  width: 260,
  borderRight: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--theme-sidebar-bg, #f6f8fa)',
  flexShrink: 0,
  transition: 'width 0.2s ease',
};

// ★ 移动端：侧栏改为覆盖式抽屉，不挤占聊天区
const mobileSidebarStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  bottom: 0,
  left: 0,
  width: 'min(280px, 85vw)',
  zIndex: 1100,
  borderRight: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--theme-sidebar-bg, #f6f8fa)',
  boxShadow: '2px 0 16px rgba(0,0,0,0.35)',
};

const collapsedSidebarStyle: React.CSSProperties = {
  width: 40,
  borderRight: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  background: 'var(--theme-sidebar-bg, #f6f8fa)',
  flexShrink: 0,
  paddingTop: 12,
};

const toggleBtnStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 5,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'transparent',
  color: 'var(--theme-text-muted, #656d76)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 0.15s ease',
};

const runningDotStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--theme-success, #2da44e)',
};

const viewTabStyle: React.CSSProperties = {
  minWidth: 32, height: 28, padding: '3px 9px', fontSize: 13, cursor: 'pointer', border: 'none',
  background: 'transparent', color: 'var(--theme-text-muted, #656d76)',
};
const viewTabActive: React.CSSProperties = {
  background: 'var(--theme-accent-bg, #0969da1a)', color: 'var(--theme-accent, #0969da)',
};

const newBtnStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 5,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'transparent',
  color: 'var(--theme-text-muted, #656d76)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 0.15s ease',
};

const searchWrapStyle: React.CSSProperties = {
  height: 32,
  margin: '0 9px 7px',
  padding: '0 9px',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid var(--theme-border, rgba(0,0,0,.12))',
  borderRadius: 6,
  background: 'var(--theme-input-bg, rgba(255,255,255,.04))',
  color: 'var(--theme-text-muted, #656d76)',
};

const searchInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'var(--theme-text, #e2e3ea)',
  fontSize: 12,
  fontFamily: 'inherit',
};

const searchClearStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  padding: 0,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--theme-text-muted, #656d76)',
  cursor: 'pointer',
  lineHeight: '16px',
};

const itemStyle: React.CSSProperties = {
  minHeight: 36,
  padding: '5px 8px',
  border: '1px solid transparent',
  borderRadius: 5,
  cursor: 'pointer',
  marginBottom: 1,
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  transition: 'background 0.14s, box-shadow 0.14s, border-color 0.14s',
};

const sessionTitleStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12.5,
  lineHeight: 1,
};

const compactActionsStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 1,
};

const compactBackendStyle: React.CSSProperties = {
  maxWidth: 58,
  padding: '2px 5px',
  borderRadius: 4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--theme-text-muted, #656d76)',
  fontSize: 9,
  lineHeight: '14px',
};

const completedDotStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  padding: 0,
  border: 'none',
  borderRadius: '50%',
  background: '#ef4444',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 9,
  fontWeight: 700,
  flexShrink: 0,
};

const groupSectionStyle: React.CSSProperties = {
  margin: '2px 0 5px',
};

const groupHeaderStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 44,
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '5px 7px 5px 6px',
  borderRadius: 8,
  border: '1px solid transparent',
  cursor: 'pointer',
  color: 'var(--theme-text, #e2e3ea)',
  background: 'transparent',
  fontFamily: 'inherit',
  textAlign: 'left',
  userSelect: 'none',
  transition: 'background .15s ease, border-color .15s ease, box-shadow .15s ease',
};

const groupChevronStyle: React.CSSProperties = {
  width: 20,
  height: 24,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--theme-text-muted, #656d76)',
};

const groupIconStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 8,
};

const groupTitleWrapStyle: React.CSSProperties = {
  minWidth: 0,
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const groupTitleStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--theme-text, #e2e3ea)',
  fontSize: 12.5,
  fontWeight: 650,
  lineHeight: 1.2,
};

const groupDescriptionStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--theme-text-muted, #656d76)',
  fontSize: 9.5,
  lineHeight: 1.15,
};

const groupCountStyle: React.CSSProperties = {
  minWidth: 18,
  padding: '0 2px',
  flexShrink: 0,
  textAlign: 'right',
  color: 'var(--theme-text-muted, #656d76)',
  fontSize: 10,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

const groupSessionsStyle: React.CSSProperties = {
  margin: '2px 0 7px 20px',
  paddingLeft: 8,
  borderLeft: '1px solid var(--theme-border, rgba(127,127,127,.16))',
};

const showMoreBtnStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '4px 0',
  fontSize: 10.5,
  color: 'var(--theme-accent, #7aa2f7)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'center',
  marginBottom: 6,
};

const actionBtnStyle: React.CSSProperties = {
  width: 21,
  height: 21,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'var(--theme-text-muted, #656d76)',
  fontSize: 13,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const renameInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontFamily: 'inherit',
  background: 'var(--theme-input-bg, #ffffff)',
  border: '1px solid var(--theme-accent, #7aa2f7)',
  borderRadius: 6,
  color: 'var(--theme-text, #e2e3ea)',
  padding: '2px 6px',
  outline: 'none',
  boxShadow: '0 0 0 2px var(--theme-accent-bg, rgba(122,162,247,0.15))',
};

const execBadgeStyle: React.CSSProperties = {
  fontSize: 9,
  padding: '2px 6px',
  borderRadius: 4,
  fontWeight: 600,
  color: 'var(--theme-accent, #0969da)',
  background: 'var(--theme-accent-bg, #0969da1a)',
  border: '1px solid var(--theme-accent, #0969da)',
  maxWidth: 96,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const backendBadgeStyle: React.CSSProperties = {
  fontSize: 9,
  padding: '2px 6px',
  borderRadius: 4,
  fontWeight: 500,
  color: 'var(--theme-text, #1f2328)',
  background: 'var(--theme-bg-tertiary, #eaeef2)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
};

const codexAttachedBadgeStyle: React.CSSProperties = {
  ...backendBadgeStyle,
  color: '#d8b4fe',
  background: 'rgba(168, 85, 247, 0.14)',
  border: '1px solid rgba(168, 85, 247, 0.48)',
};

const codexSshBadgeStyle: React.CSSProperties = {
  ...backendBadgeStyle,
  color: '#67e8f9',
  background: 'rgba(6, 182, 212, 0.14)',
  border: '1px solid rgba(6, 182, 212, 0.48)',
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};

const confirmPanelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 8,
  padding: 24, width: '90%', maxWidth: 400,
  boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
};

const confirmBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 5,
  background: 'var(--theme-error, #cf222e)', border: 'none',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 5,
  background: 'var(--theme-bg-secondary, #f6f8fa)', border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  color: 'var(--theme-text, #1f2328)', fontSize: 14, cursor: 'pointer',
};

const colorGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 9,
};

const colorPresetStyle: React.CSSProperties = {
  height: 44,
  border: '1px solid var(--theme-border, rgba(0,0,0,.15))',
  borderRadius: 5,
  cursor: 'pointer',
};

const destroyPathStyle: React.CSSProperties = {
  padding: '9px 10px',
  borderRadius: 5,
  border: '1px solid rgba(239,68,68,.28)',
  background: 'rgba(239,68,68,.07)',
  color: 'var(--theme-text, #e2e3ea)',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: 11,
  lineHeight: 1.45,
  overflowWrap: 'anywhere',
};
