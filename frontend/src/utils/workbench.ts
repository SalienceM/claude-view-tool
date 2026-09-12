export type SidebarView = 'sessions' | 'files' | 'extensions';
export type WorkbenchTab = 'chat' | 'library' | 'market' | `session:${string}`;
export interface WorkbenchState { tabs: WorkbenchTab[]; active: WorkbenchTab }
export type WorkbenchAction = { type: 'open' | 'close'; tab: WorkbenchTab } | { type: 'reset' }
  | { type: 'syncSessions'; sessionIds: (string | null)[]; focusedSessionId: string | null }
  | { type: 'migrateSessions'; ids: Record<string, string> };
export const initialWorkbench: WorkbenchState = { tabs: ['chat'], active: 'chat' };
export const sessionWorkbenchTab = (id: string): WorkbenchTab => `session:${id}`;
export const workbenchSessionId = (tab: WorkbenchTab): string | null => tab.startsWith('session:') ? tab.slice(8) : null;
export const isConversationTab = (tab: WorkbenchTab): boolean => tab === 'chat' || !!workbenchSessionId(tab);

/** 一个 Session 只拥有一个渲染实例；已在分屏中可见时聚焦它，不复制到另一个格子。 */
export function selectSessionPane(panes: (string | null)[], id: string | null, focused: number, slots: number) {
  const visibleIndex = id ? panes.slice(0, slots).indexOf(id) : -1;
  const index = visibleIndex >= 0 ? visibleIndex : Math.max(0, Math.min(focused, slots - 1));
  const next = panes.map((value, i) => i === index ? id : id && value === id ? null : value);
  return { panes: next.every((value, i) => value === panes[i]) ? panes : next, focused: index };
}

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  if (action.type === 'reset') return initialWorkbench;
  if (action.type === 'syncSessions') {
    const tabs = [...state.tabs];
    for (const id of action.sessionIds) {
      if (id && !tabs.includes(sessionWorkbenchTab(id))) tabs.push(sessionWorkbenchTab(id));
    }
    const active = isConversationTab(state.active)
      ? (action.focusedSessionId ? sessionWorkbenchTab(action.focusedSessionId) : 'chat') : state.active;
    return tabs.length === state.tabs.length && active === state.active ? state : { tabs, active };
  }
  if (action.type === 'migrateSessions') {
    const remap = (tab: WorkbenchTab): WorkbenchTab => {
      const id = workbenchSessionId(tab);
      return id && action.ids[id] ? sessionWorkbenchTab(action.ids[id]) : tab;
    };
    return { tabs: [...new Set(state.tabs.map(remap))], active: remap(state.active) };
  }
  if (action.type === 'open' && state.active === action.tab && state.tabs.includes(action.tab)) return state;
  if (action.type === 'open') return {
    tabs: state.tabs.includes(action.tab) ? state.tabs : [...state.tabs, action.tab], active: action.tab,
  };
  if (action.tab === 'chat' || !state.tabs.includes(action.tab)) return state;
  const index = state.tabs.indexOf(action.tab);
  const tabs = state.tabs.filter(tab => tab !== action.tab);
  return { tabs, active: state.active === action.tab ? tabs[Math.max(0, index - 1)] : state.active };
}
