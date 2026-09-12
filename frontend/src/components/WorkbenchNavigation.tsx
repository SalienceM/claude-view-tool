import React, { useEffect, useRef } from 'react';
import { isConversationTab, workbenchSessionId, type SidebarView, type WorkbenchTab, type WorkbenchState } from '../utils/workbench';

const destinations: { id: SidebarView; label: string; path: React.ReactNode }[] = [
  { id: 'sessions', label: 'Session 会话', path: <path d="M4 4h16v12H9l-5 4V4Z" /> },
  { id: 'files', label: '文件目录（本地 ⇄ 远端）', path: <><path d="M8 3h9l4 4v14H8Z" /><path d="M8 7H3v14M16 3v5h5" /></> },
  { id: 'extensions', label: '扩展', path: <><path d="M3 3h7v7H3zM3 14h7v7H3zM14 14h7v7h-7z" /><path d="m17 2 5 5-5 5-5-5Z" /></> },
];
export const ActivityBar: React.FC<{
  view: SidebarView; collapsed?: boolean; pendingCount: number; onSelect: (view: SidebarView) => void;
}> = ({ view, collapsed, pendingCount, onSelect }) => (
  <nav aria-label="功能栏" style={{ position: 'absolute', inset: '0 auto 0 0', width: 'var(--ui-activity-width, 46px)',
    display: 'flex', flexDirection: 'column', alignItems: 'stretch', paddingTop: 6,
    background: 'var(--theme-sidebar-solid, var(--theme-bg-secondary))', borderRight: '1px solid var(--theme-border)' }}>
    {destinations.map(item => <button key={item.id} type="button" title={item.label} aria-label={item.label}
      aria-pressed={!collapsed && view === item.id} onClick={() => onSelect(item.id)} style={{
        position: 'relative', display: 'grid', placeItems: 'center', height: 'var(--ui-activity-height, 48px)', flexShrink: 0, cursor: 'pointer',
        border: 0, borderLeft: `2px solid ${!collapsed && view === item.id ? 'var(--theme-accent)' : 'transparent'}`,
        background: !collapsed && view === item.id ? 'var(--theme-accent-bg)' : 'transparent',
        color: !collapsed && view === item.id ? 'var(--theme-accent)' : 'var(--theme-text-muted)',
      }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">{item.path}</svg>
      {item.id === 'sessions' && pendingCount > 0 && <span style={{ position: 'absolute', right: 2, bottom: 4,
        padding: '0 4px', borderRadius: 8, background: 'var(--theme-accent)', color: '#fff', fontSize: 10 }}>
        {pendingCount > 9 ? '9+' : pendingCount}</span>}
    </button>)}
  </nav>
);

const labels = { chat: '工作总览', library: 'Skills 与 Prompts', market: '扩展市场' };
export const WorkbenchTabs: React.FC<{
  state: WorkbenchState; editing: boolean; onSelect: (tab: WorkbenchTab) => void; onClose: (tab: WorkbenchTab) => void;
  sessions: { id: string; title?: string; sessionType?: string; execLabel?: string }[];
  streamingSessions: Set<string>; completedSessions: Set<string>;
}> = ({ state, editing, onSelect, onClose, sessions, streamingSessions, completedSessions }) => {
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    const button = document.getElementById(`workbench-tab-${state.active}`);
    const tab = button?.parentElement;
    if (!bar || !tab) return;
    // 只滚动标签条，不能 scrollIntoView 把聊天区/页面一起拉走。
    const bounds = tab.getBoundingClientRect();
    const viewport = bar.getBoundingClientRect();
    if (bounds.left < viewport.left) bar.scrollLeft -= viewport.left - bounds.left;
    else if (bounds.right > viewport.right) bar.scrollLeft += bounds.right - viewport.right;
  }, [state.active, state.tabs.length]);
  const byId = new Map(sessions.map(session => [session.id, session]));
  return <div ref={barRef} role="tablist" aria-label="工作区标签页" style={{ display: 'flex', overflowX: 'auto', minWidth: 0, flexShrink: 0,
    background: 'var(--theme-sidebar-bg)', borderBottom: '1px solid var(--theme-border)' }}>
    {state.tabs.map(tab => {
      const sid = workbenchSessionId(tab);
      const session = sid ? byId.get(sid) : undefined;
      const label = sid ? session?.title || `Session ${sid.slice(0, 8)}` : labels[tab as keyof typeof labels];
      const streaming = !!sid && streamingSessions.has(sid);
      const completed = !!sid && completedSessions.has(sid);
      const tooltip = [label, session?.execLabel, streaming ? '正在运行' : completed ? '已完成，待查看' : '', sid ? '关闭标签不会删除会话或停止当前任务' : ''].filter(Boolean).join(' · ');
      return <div key={tab} style={{ display: 'flex', flexShrink: 0, maxWidth: sid ? 260 : undefined,
      borderRight: '1px solid var(--theme-border)', borderTop: `2px solid ${state.active === tab ? 'var(--theme-accent)' : 'transparent'}`,
      background: state.active === tab ? 'var(--theme-bg)' : 'transparent' }}>
      <button id={`workbench-tab-${tab}`} role="tab" title={tooltip} aria-label={label}
        aria-selected={state.active === tab} aria-controls={isConversationTab(tab) ? 'workbench-panel-chat' : `workbench-panel-${tab}`}
        tabIndex={state.active === tab ? 0 : -1} onClick={() => onSelect(tab)} onKeyDown={event => {
          const index = state.tabs.indexOf(tab);
          const next = event.key === 'ArrowRight' ? (index + 1) % state.tabs.length
            : event.key === 'ArrowLeft' ? (index - 1 + state.tabs.length) % state.tabs.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1 : -1;
          if (next >= 0) { event.preventDefault(); onSelect(state.tabs[next]); document.getElementById(`workbench-tab-${state.tabs[next]}`)?.focus(); }
        }} style={{ border: 0, background: 'transparent', color: 'var(--theme-text)', padding: 'var(--ui-tab-padding, 9px 12px)', minHeight: 'var(--ui-tab-height, 40px)',
          cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 12, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        {sid && <span aria-hidden="true" style={{ color: streaming ? 'var(--theme-accent)' : completed ? '#56d364' : 'var(--theme-text-muted)' }}>
          {streaming ? '◌' : completed ? '●' : session?.sessionType === 'loop' ? '↻' : '▤'}
        </span>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}{tab === 'library' && editing ? ' · 编辑中' : ''}</span>
      </button>
      {tab !== 'chat' && <button type="button" title={`关闭${label}`} aria-label={`关闭${label}`} onClick={() => onClose(tab)}
        style={{ border: 0, background: 'transparent', color: 'var(--theme-text-muted)', minWidth: 'var(--ui-tab-close-width, 34px)', flexShrink: 0, cursor: 'pointer', fontSize: 17 }}>×</button>}
    </div>; })}
  </div>;
};
