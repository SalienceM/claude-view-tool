import React from 'react';
import {
  DASHBOARD_MODULES,
  type DashboardBackendSource,
  type DashboardDestination,
  type DashboardModuleId,
  type DashboardSessionSource,
  type DashboardTone,
  type DashboardViewModel,
} from './dashboardModel';
import { useDashboardData } from './useDashboardData';
import { useDashboardPreferences } from './dashboardPreferences';

interface HomeDashboardProps {
  sessions: DashboardSessionSource[];
  backends: DashboardBackendSource[];
  activeBackendId?: string;
  connected: boolean | null;
  streamingSessionIds: ReadonlySet<string>;
  completedSessionIds: ReadonlySet<string>;
  onNavigate: (destination: DashboardDestination) => void;
  contentId?: string;
  showSkipLink?: boolean;
}

const TONE: Record<DashboardTone, { color: string; background: string }> = {
  neutral: { color: 'var(--home-muted, var(--theme-text-muted))', background: 'var(--theme-bg-tertiary)' },
  info: { color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)' },
  success: { color: 'var(--theme-success, #3fb950)', background: 'var(--theme-success-bg, rgba(63,185,80,.1))' },
  warning: { color: '#d29922', background: 'rgba(210,153,34,.12)' },
  danger: { color: 'var(--theme-error, #f85149)', background: 'rgba(248,81,73,.12)' },
};

const Card: React.FC<React.PropsWithChildren<{ title: string; action?: React.ReactNode; className?: string }>> = ({
  title, action, className = '',
  children,
}) => (
  <section className={`home-card ${className}`}>
    <div className="home-card-header">
      <h2>{title}</h2>
      {action}
    </div>
    {children}
  </section>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="home-empty">{children}</div>
);

const relativeTime = (value: number): string => {
  if (!value) return '暂无更新时间';
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
};

interface DashboardModuleContentProps {
  id: DashboardModuleId;
  viewModel: DashboardViewModel;
  onNavigate: (destination: DashboardDestination) => void;
}

function moduleRevision(id: DashboardModuleId, viewModel: DashboardViewModel): string {
  switch (id) {
    case 'global-status': return JSON.stringify(viewModel.globalStatus);
    case 'quick-actions': return JSON.stringify(viewModel.quickActions);
    case 'sessions': return JSON.stringify(viewModel.sessions);
    case 'loops': return JSON.stringify(viewModel.loops);
    case 'tasks': return JSON.stringify(viewModel.tasks);
    case 'model-status': return JSON.stringify(viewModel.modelStatus);
    case 'metrics': return JSON.stringify(viewModel.metrics);
    case 'activity': return JSON.stringify(viewModel.activity.slice(0, 12));
  }
}

const DashboardModuleContentBase: React.FC<DashboardModuleContentProps> = ({ id, viewModel, onNavigate }) => {
  switch (id) {
    case 'global-status':
      return (
        <section className="home-status" aria-label="全局关键状态">
          {viewModel.globalStatus.map((item) => (
            <button
              type="button"
              key={item.id}
              className="home-status-item"
              onClick={() => item.destination && onNavigate(item.destination)}
              disabled={!item.destination}
            >
              <span className="home-status-dot" style={{ background: TONE[item.tone].color }} aria-hidden="true" />
              <span className="home-status-copy">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.detail}</small>
              </span>
            </button>
          ))}
        </section>
      );
    case 'quick-actions':
      return (
        <section className="home-actions" aria-label="快捷操作">
          <div className="home-section-label">
            <h2>快捷操作</h2>
            <span>一次点击直达</span>
          </div>
          <div className="home-action-grid">
            {viewModel.quickActions.map((action) => (
              <button type="button" key={action.id} onClick={() => onNavigate(action.destination)} disabled={action.disabled}>
                <strong>{action.label}</strong>
                <span>{action.description}</span>
              </button>
            ))}
          </div>
        </section>
      );
    case 'loops':
      return (
        <Card title="Loop 进度" className="home-loops">
          {viewModel.loops.length === 0 ? <Empty>暂无 Loop，会话创建后会在这里显示实时阶段。</Empty> : (
            <div className="home-list">
              {viewModel.loops.map((loop) => (
                <button type="button" className="home-list-row" key={loop.sessionId} onClick={() => onNavigate(loop.destination)}>
                  <span className="home-loop-stage">{loop.stageLabel}</span>
                  <span className="home-row-main"><strong>{loop.title}</strong><small>{loop.progressLabel}</small></span>
                  <span className={`home-state ${loop.state}`}>{loop.state === 'running' ? '运行中' : loop.state === 'resumable' ? '可恢复' : loop.state === 'output' ? '可输出' : '就绪'}</span>
                  <span className="home-score">{loop.score === null ? '—' : loop.score}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      );
    case 'tasks':
      return (
        <Card title="待办队列" className="home-tasks">
          {viewModel.tasks.length === 0 ? <Empty>所有序列任务均已处理。</Empty> : (
            <div className="home-list">
              {viewModel.tasks.map((task, index) => (
                <button type="button" className="home-list-row" key={`${task.sessionId}:${task.id}`} onClick={() => onNavigate(task.destination)}>
                  <span className="home-task-index">{index + 1}</span>
                  <span className="home-row-main"><strong>{task.text}</strong><small>{task.status === 'sent' ? '等待当前响应完成' : '待发送'}</small></span>
                </button>
              ))}
            </div>
          )}
        </Card>
      );
    case 'sessions':
      return (
        <Card title="最近会话">
          {viewModel.sessions.length === 0 ? <Empty>还没有会话，可从快捷操作开始。</Empty> : (
            <div className="home-list">
              {viewModel.sessions.map((session) => (
                <button type="button" className="home-list-row" key={session.id} onClick={() => onNavigate(session.destination)}>
                  <span className={`home-session-mark ${session.state}`} aria-hidden="true" />
                  <span className="home-sr-only">状态：{session.state === 'running' ? '运行中' : session.state === 'unread' ? '已完成待查看' : '空闲'}</span>
                  <span className="home-row-main"><strong>{session.title}</strong><small>{session.subtitle}</small></span>
                  <span className="home-row-time">{relativeTime(session.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      );
    case 'model-status':
      return (
        <Card title="模型与连接">
          <button type="button" className="home-model" onClick={() => onNavigate(viewModel.modelStatus.destination)}>
            <span className="home-model-icon">AI</span>
            <span><strong>{viewModel.modelStatus.label}</strong><small>{viewModel.modelStatus.detail}</small></span>
            <span style={{ color: TONE[viewModel.modelStatus.tone].color }} aria-hidden="true">●</span>
          </button>
        </Card>
      );
    case 'metrics':
      return (
        <Card title="关键指标">
          <div className="home-metrics">
            {viewModel.metrics.map((metric) => (
              <div key={metric.id}><strong style={{ color: TONE[metric.tone].color }}>{metric.value}</strong><span>{metric.label}</span></div>
            ))}
          </div>
        </Card>
      );
    case 'activity':
      return (
        <Card title="实时状态流">
          {viewModel.activity.length === 0 ? <Empty>等待新的会话、Loop、待办或连接事件。</Empty> : (
            <ol className="home-activity">
              {viewModel.activity.slice(0, 12).map((event) => (
                <li key={event.id}>
                  <span className="home-status-dot" style={{ background: TONE[event.tone || 'neutral'].color }} aria-hidden="true" />
                  <button type="button" onClick={() => event.destination && onNavigate(event.destination)} disabled={!event.destination}>
                    <strong>{event.title}</strong>{event.detail && <span>{event.detail}</span>}
                  </button>
                  <time>{relativeTime(event.at)}</time>
                </li>
              ))}
            </ol>
          )}
        </Card>
      );
  }
};

const DashboardModuleContent = React.memo(
  DashboardModuleContentBase,
  (previous, next) => (
    previous.id === next.id
    && previous.onNavigate === next.onNavigate
    && moduleRevision(previous.id, previous.viewModel) === moduleRevision(next.id, next.viewModel)
  ),
);

export const HomeDashboard: React.FC<HomeDashboardProps> = ({
  sessions,
  backends,
  activeBackendId,
  connected,
  streamingSessionIds,
  completedSessionIds,
  onNavigate,
  contentId: providedContentId,
  showSkipLink = true,
}) => {
  const { viewModel, refresh } = useDashboardData({
    sessions,
    backends,
    activeBackendId,
    connected,
    streamingSessionIds,
    completedSessionIds,
  });
  const { preferences, setDensity, toggleModule, moveModule, canMoveModule, reset, protectedIds } = useDashboardPreferences();
  const [customizing, setCustomizing] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState('');
  const customizeButtonRef = React.useRef<HTMLButtonElement>(null);
  const dashboardRef = React.useRef<HTMLElement>(null);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const dashboardId = React.useId();
  const titleId = `${dashboardId}-title`;
  const contentId = providedContentId || `${dashboardId}-content`;
  const customizerId = `${dashboardId}-customizer`;
  const busy = viewModel.loadState === 'loading' || viewModel.loadState === 'idle';
  const latestActivity = viewModel.activity[0];

  React.useEffect(() => {
    const dashboard = dashboardRef.current;
    const shell = shellRef.current;
    if (!dashboard || !shell) return;
    // 标签栏改变可用高度后，浏览器选中的原生滚动锚点并不稳定。
    // 仅在用户已经滚到底部时跟住新增事件；正在阅读中间内容时不抢滚动。
    let atBottom = false;
    const rememberPosition = () => {
      if (!dashboard.clientHeight) return; // 扩展 Tab 隐藏首页时不能重置位置。
      atBottom = dashboard.scrollHeight > dashboard.clientHeight
        && dashboard.scrollHeight - dashboard.clientHeight - dashboard.scrollTop <= 4;
    };
    dashboard.addEventListener('scroll', rememberPosition, { passive: true });
    const observer = new ResizeObserver(() => {
      if (atBottom && dashboard.clientHeight) dashboard.scrollTop = dashboard.scrollHeight;
    });
    observer.observe(shell);
    return () => {
      dashboard.removeEventListener('scroll', rememberPosition);
      observer.disconnect();
    };
  }, []);

  React.useEffect(() => {
    if (!customizing) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCustomizing(false);
        window.requestAnimationFrame(() => customizeButtonRef.current?.focus());
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [customizing]);

  React.useEffect(() => {
    if (!latestActivity) return;
    const timer = window.setTimeout(() => {
      setAnnouncement(`${latestActivity.title}${latestActivity.detail ? `：${latestActivity.detail}` : ''}`);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [latestActivity?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main ref={dashboardRef} className={`home-dashboard density-${preferences.density}`} aria-busy={busy} aria-labelledby={titleId}>
      {showSkipLink && <a className="home-skip-link" href={`#${contentId}`}>跳到首页主要内容</a>}
      <div className="home-sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      <div ref={shellRef} className="home-shell">
        <header className="home-heading">
          <div>
            <p className="home-eyebrow">AGENTWITHU · CONTROL CENTER</p>
            <h1 id={titleId}>工作总览</h1>
            <p>先看全局状态，再用一次点击回到最重要的工作。</p>
          </div>
          <div className="home-sync">
            <span>{relativeTime(viewModel.generatedAt)}同步</span>
            <button type="button" onClick={refresh} disabled={busy}>刷新</button>
            <button
              ref={customizeButtonRef}
              type="button"
              onClick={() => setCustomizing((open) => !open)}
              aria-expanded={customizing}
              aria-controls={customizerId}
            >
              自定义
            </button>
          </div>
        </header>

        {customizing && (
          <section className="home-customizer" id={customizerId} aria-label="首页布局设置">
            <div className="home-customizer-top">
              <div>
                <strong>首页布局</strong>
                <span>关键状态、快捷操作、Loop 与待办始终保持可见。</span>
              </div>
              <div className="home-density" role="group" aria-label="信息密度">
                <button type="button" aria-pressed={preferences.density === 'comfortable'} className={preferences.density === 'comfortable' ? 'active' : ''} onClick={() => setDensity('comfortable')}>舒适</button>
                <button type="button" aria-pressed={preferences.density === 'compact'} className={preferences.density === 'compact' ? 'active' : ''} onClick={() => setDensity('compact')}>紧凑</button>
              </div>
              <button type="button" className="home-reset" onClick={reset}>恢复默认</button>
            </div>
            <div className="home-customizer-list">
              {preferences.order.map((id) => {
                const definition = DASHBOARD_MODULES.find((module) => module.id === id)!;
                const isProtected = protectedIds.has(id);
                return (
                  <div key={id} className="home-customizer-row">
                    <label title={isProtected ? '关键模块不可隐藏' : undefined}>
                      <input
                        type="checkbox"
                        checked={preferences.visible[id]}
                        disabled={isProtected}
                        onChange={() => toggleModule(id)}
                      />
                      <span>{definition.label}</span>
                      {isProtected && <small>始终显示</small>}
                    </label>
                    <div>
                      <button type="button" onClick={() => moveModule(id, -1)} disabled={!canMoveModule(id, -1)} aria-label={`上移${definition.label}`}>↑</button>
                      <button type="button" onClick={() => moveModule(id, 1)} disabled={!canMoveModule(id, 1)} aria-label={`下移${definition.label}`}>↓</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {(viewModel.loadState === 'error' || viewModel.loadState === 'stale') && (
          <div className={`home-banner ${viewModel.loadState}`} role="status">
            <strong>{viewModel.loadState === 'stale' ? '数据可能不是最新' : '首页数据暂不可用'}</strong>
            <span>{viewModel.errorMessage || '请检查服务连接后重试。'}</span>
            <button type="button" onClick={refresh}>重试</button>
          </div>
        )}

        {busy && sessions.length === 0 ? (
          <div className="home-loading" role="status">正在汇总会话、Loop 与待办状态…</div>
        ) : (
          <>
            <div className="home-module-grid" id={contentId} tabIndex={-1}>
              {preferences.order
                .filter((id) => preferences.visible[id])
                .map((id) => (
                  <div
                    className={`home-module home-module-${id} ${
                      id === 'global-status' || id === 'quick-actions' || id === 'activity' ? 'home-module-full' : ''
                    }`}
                    key={id}
                  >
                    <DashboardModuleContent id={id} viewModel={viewModel} onNavigate={onNavigate} />
                  </div>
                ))}
            </div>

          </>
        )}
      </div>
      <style>{`
        .home-dashboard { --home-muted:color-mix(in srgb, var(--theme-text) 74%, var(--theme-bg)); container-type:inline-size; height:100%; min-width:0; overflow-x:hidden; overflow-y:auto; color:var(--theme-text); background:var(--theme-bg); }
        .home-dashboard * { box-sizing:border-box; }
        .home-sr-only { position:absolute !important; width:1px !important; height:1px !important; padding:0 !important; margin:-1px !important; overflow:hidden !important; clip:rect(0,0,0,0) !important; white-space:nowrap !important; border:0 !important; }
        .home-skip-link { position:fixed; z-index:10000; top:8px; left:8px; padding:10px 14px; border:2px solid var(--theme-accent); border-radius:8px; color:var(--theme-text); background:var(--theme-bg); transform:translateY(-160%); }
        .home-skip-link:focus { transform:translateY(0); }
        .home-dashboard button:focus-visible, .home-dashboard a:focus-visible, .home-dashboard input:focus-visible, .home-module-grid:focus-visible {
          outline:3px solid var(--theme-accent); outline-offset:2px;
        }
        .home-dashboard button:disabled { cursor:not-allowed; }
        .home-shell { width:min(1560px, 100%); min-width:0; margin:0 auto; padding:30px clamp(18px, 3vw, 42px) 56px; }
        .home-heading { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; margin-bottom:22px; }
        .home-heading h1 { margin:3px 0 5px; font-size:clamp(25px, 3vw, 36px); line-height:1.1; letter-spacing:-.02em; }
        .home-heading p { margin:0; color:var(--home-muted); font-size:13px; }
        .home-heading .home-eyebrow { color:var(--theme-accent); font-size:10px; font-weight:800; letter-spacing:.18em; }
        .home-sync { display:flex; min-width:0; align-items:center; gap:10px; color:var(--home-muted); font-size:11px; white-space:nowrap; }
        .home-sync button, .home-banner button { border:1px solid var(--theme-border); background:var(--theme-bg-tertiary); color:var(--theme-text); border-radius:7px; padding:7px 10px; cursor:pointer; }
        .home-customizer { margin:-8px 0 18px; padding:13px; border:1px solid var(--theme-accent); border-radius:12px; background:var(--theme-bg-secondary); }
        .home-customizer-top { display:flex; align-items:center; gap:14px; margin-bottom:11px; }
        .home-customizer-top > div:first-child { display:flex; flex:1; min-width:0; flex-direction:column; gap:3px; }
        .home-customizer-top strong { font-size:12px; }
        .home-customizer-top span { color:var(--home-muted); font-size:10px; }
        .home-density { display:flex; padding:2px; border-radius:8px; background:var(--theme-bg-tertiary); }
        .home-density button, .home-reset, .home-customizer-row button { border:0; border-radius:6px; padding:6px 9px; color:var(--home-muted); background:transparent; cursor:pointer; font-size:10px; }
        .home-density button.active { color:var(--theme-text); background:var(--theme-accent-bg); box-shadow:inset 0 0 0 1px var(--theme-accent); }
        .home-reset { border:1px solid var(--theme-border); color:var(--theme-text); }
        .home-customizer-list { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:6px; }
        .home-customizer-row { display:flex; align-items:center; justify-content:space-between; gap:6px; min-width:0; padding:7px 8px; border:1px solid var(--theme-border); border-radius:8px; background:var(--theme-bg-tertiary); }
        .home-customizer-row label { display:flex; align-items:center; min-width:0; gap:6px; font-size:10px; cursor:pointer; }
        .home-customizer-row label span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--theme-text); }
        .home-customizer-row label small { color:var(--theme-accent); font-size:8px; white-space:nowrap; }
        .home-customizer-row label:has(input:disabled) { cursor:not-allowed; }
        .home-customizer-row > div { display:flex; flex:0 0 auto; }
        .home-customizer-row button { padding:4px 6px; font-size:12px; }
        .home-customizer-row button:disabled { opacity:.25; cursor:not-allowed; }
        .home-banner { display:flex; align-items:center; gap:12px; margin-bottom:14px; padding:10px 14px; border:1px solid rgba(210,153,34,.35); background:rgba(210,153,34,.1); border-radius:10px; font-size:12px; }
        .home-banner.error { border-color:rgba(248,81,73,.4); background:rgba(248,81,73,.1); }
        .home-banner span { flex:1; color:var(--home-muted); }
        .home-loading { min-height:260px; display:grid; place-items:center; color:var(--home-muted); }
        .home-module-grid { display:grid; grid-template-columns:repeat(12, minmax(0, 1fr)); gap:12px; align-items:start; }
        .home-module { grid-column:span 6; min-width:0; }
        .home-module-full { grid-column:1 / -1; }
        .home-status { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; }
        .home-status-item { min-width:0; display:flex; align-items:center; gap:12px; padding:14px 16px; text-align:left; border:1px solid var(--theme-border); border-radius:12px; color:var(--theme-text); background:var(--theme-bg-secondary); cursor:pointer; }
        .home-status-item:hover, .home-list-row:hover, .home-model:hover { border-color:var(--theme-accent); background:var(--theme-bg-tertiary); }
        .home-status-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
        .home-status-copy { min-width:0; display:grid; grid-template-columns:1fr auto; column-gap:10px; align-items:baseline; width:100%; }
        .home-status-copy > span { color:var(--home-muted); font-size:11px; }
        .home-status-copy strong { font-size:22px; line-height:1; }
        .home-status-copy small { grid-column:1 / -1; margin-top:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--home-muted); font-size:10px; }
        .home-actions { margin:0; }
        .home-section-label, .home-card-header { display:flex; align-items:center; justify-content:space-between; }
        .home-section-label { margin-bottom:9px; }
        .home-section-label h2, .home-card-header h2 { margin:0; font-size:12px; letter-spacing:.02em; }
        .home-section-label span { color:var(--home-muted); font-size:10px; }
        .home-action-grid { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:8px; }
        .home-action-grid button { display:flex; flex-direction:column; gap:4px; min-height:62px; padding:11px 13px; text-align:left; border:1px solid var(--theme-border); border-radius:10px; color:var(--theme-text); background:var(--theme-bg-secondary); cursor:pointer; }
        .home-action-grid button:hover { transform:translateY(-1px); border-color:var(--theme-accent); }
        .home-action-grid button:disabled { opacity:.45; cursor:not-allowed; transform:none; }
        .home-action-grid strong { font-size:12px; }
        .home-action-grid span { color:var(--home-muted); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .home-card { min-width:0; overflow:hidden; border:1px solid var(--theme-border); border-radius:13px; background:var(--theme-bg-secondary); }
        .home-card-header { min-height:43px; padding:0 15px; border-bottom:1px solid var(--theme-border); }
        .home-list { display:flex; flex-direction:column; }
        .home-list-row { display:flex; align-items:center; gap:10px; width:100%; min-width:0; min-height:50px; padding:9px 13px; border:0; border-bottom:1px solid var(--theme-border); color:var(--theme-text); background:transparent; text-align:left; cursor:pointer; }
        .home-list-row:last-child { border-bottom:0; }
        .home-row-main { display:flex; flex:1; min-width:0; flex-direction:column; gap:3px; }
        .home-row-main strong, .home-row-main small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .home-row-main strong { font-size:12px; font-weight:650; }
        .home-row-main small, .home-row-time { color:var(--home-muted); font-size:10px; }
        .home-loop-stage { width:42px; padding:4px 5px; border-radius:5px; background:var(--theme-accent-bg); color:var(--theme-accent); text-align:center; font-size:10px; font-weight:700; }
        .home-state { font-size:9px; border-radius:999px; padding:3px 6px; color:var(--home-muted); background:var(--theme-bg-tertiary); }
        .home-state.running { color:var(--theme-accent); background:var(--theme-accent-bg); }
        .home-state.resumable { color:#d29922; background:rgba(210,153,34,.12); }
        .home-state.output { color:var(--theme-success, #3fb950); background:var(--theme-success-bg, rgba(63,185,80,.1)); }
        .home-score { width:24px; text-align:right; color:var(--home-muted); font-size:11px; font-variant-numeric:tabular-nums; }
        .home-task-index { width:23px; height:23px; display:grid; place-items:center; border-radius:7px; background:var(--theme-bg-tertiary); color:var(--home-muted); font-size:10px; }
        .home-row-arrow { color:var(--theme-accent); }
        .home-session-mark { width:6px; height:28px; border-radius:4px; background:var(--theme-border); }
        .home-session-mark.running { background:var(--theme-accent); }
        .home-session-mark.unread { background:#d29922; }
        .home-side-stack { display:grid; gap:12px; }
        .home-model { display:flex; align-items:center; gap:10px; width:100%; padding:14px; border:0; color:var(--theme-text); background:transparent; text-align:left; cursor:pointer; }
        .home-model-icon { width:34px; height:34px; display:grid; place-items:center; border-radius:9px; color:var(--theme-accent); background:var(--theme-accent-bg); font-size:10px; font-weight:900; }
        .home-model > span:nth-child(2) { display:flex; flex:1; min-width:0; flex-direction:column; gap:3px; }
        .home-model strong, .home-model small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .home-model strong { font-size:12px; } .home-model small { color:var(--home-muted); font-size:10px; }
        .home-metrics { display:grid; grid-template-columns:repeat(4, 1fr); }
        .home-metrics div { display:flex; flex-direction:column; align-items:center; gap:3px; padding:14px 5px; border-right:1px solid var(--theme-border); }
        .home-metrics div:last-child { border:0; }
        .home-metrics strong { font-size:20px; font-variant-numeric:tabular-nums; }
        .home-metrics span { color:var(--home-muted); font-size:9px; }
        .home-empty { min-height:94px; display:grid; place-items:center; padding:20px; color:var(--home-muted); font-size:11px; text-align:center; }
        .home-activity { list-style:none; margin:0; padding:4px 14px; }
        .home-activity li { display:flex; align-items:center; gap:10px; min-height:38px; border-bottom:1px solid var(--theme-border); }
        .home-activity li:last-child { border:0; }
        .home-activity button { display:flex; flex:1; min-width:0; gap:8px; border:0; padding:0; color:var(--theme-text); background:transparent; text-align:left; cursor:pointer; }
        .home-activity button:disabled { cursor:default; }
        .home-activity strong, .home-activity span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; }
        .home-activity span, .home-activity time { color:var(--home-muted); }
        .home-activity time { font-size:9px; white-space:nowrap; }
        .density-compact .home-shell { padding-top:20px; }
        .density-compact .home-heading { margin-bottom:14px; }
        .density-compact .home-module-grid { gap:8px; }
        .density-compact .home-status-item { padding:9px 12px; }
        .density-compact .home-action-grid button { min-height:48px; padding:8px 10px; }
        .density-compact .home-card-header { min-height:34px; padding:0 11px; }
        .density-compact .home-list-row { min-height:40px; padding:6px 10px; }
        .density-compact .home-model { padding:9px 11px; }
        .density-compact .home-metrics div { padding:9px 4px; }
        .density-compact .home-empty { min-height:70px; padding:14px; }
        .density-compact .home-activity li { min-height:31px; }
        @container (min-width: 1500px) {
          .home-shell { padding-left:52px; padding-right:52px; }
          .home-module-grid { gap:16px; }
          .home-status-item { padding:16px 18px; }
        }
        @container (max-width: 1040px) {
          .home-action-grid { grid-template-columns:repeat(3, 1fr); }
          .home-customizer-list { grid-template-columns:repeat(2, minmax(0, 1fr)); }
          .home-module { grid-column:1 / -1; }
        }
        @container (max-width: 700px) {
          .home-shell { padding:20px 12px 40px; }
          .home-heading { align-items:flex-start; flex-direction:column; gap:10px; }
          .home-sync { width:100%; }
          .home-sync > span { margin-right:auto; }
          .home-status { grid-template-columns:1fr; }
          .home-action-grid { grid-template-columns:repeat(2, 1fr); }
          .home-state, .home-score { display:none; }
          .home-banner { align-items:flex-start; flex-wrap:wrap; }
          .home-banner span { flex-basis:70%; }
          .home-customizer-top { align-items:flex-start; flex-wrap:wrap; }
          .home-customizer-top > div:first-child { flex-basis:100%; }
          .home-customizer-list { grid-template-columns:1fr; }
          .home-card, .home-status-item, .home-action-grid button { border-radius:10px; }
          .home-list-row, .home-model, .home-status-item, .home-action-grid button { min-height:48px; }
          .home-sync button, .home-banner button, .home-density button, .home-reset, .home-customizer-row button { min-height:44px; }
          .home-customizer-row label { min-height:44px; flex:1; }
          .home-customizer-row input { width:20px; height:20px; flex:0 0 auto; }
          .home-activity { padding:3px 10px; }
          .home-activity li { min-height:48px; }
        }
        @container (max-width: 430px) {
          .home-shell { padding-left:9px; padding-right:9px; }
          .home-heading h1 { font-size:24px; }
          .home-heading > div:first-child > p:last-child { font-size:12px; }
          .home-sync { gap:6px; }
          .home-sync button { padding-left:9px; padding-right:9px; }
          .home-action-grid { gap:7px; }
          .home-action-grid button { padding:9px 10px; }
          .home-status-item { padding:11px 12px; }
          .home-status-copy strong { font-size:20px; }
          .home-list-row { gap:8px; padding-left:10px; padding-right:10px; }
          .home-loop-stage { width:38px; }
          .home-row-time { max-width:64px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .home-metrics { grid-template-columns:repeat(2, minmax(0, 1fr)); }
          .home-metrics div:nth-child(2) { border-right:0; }
          .home-metrics div:nth-child(-n+2) { border-bottom:1px solid var(--theme-border); }
          .home-activity li { align-items:flex-start; flex-wrap:wrap; gap:5px 8px; padding:7px 0; }
          .home-activity li > .home-status-dot { margin-top:5px; }
          .home-activity button { width:calc(100% - 18px); flex:1 1 calc(100% - 18px); flex-direction:column; gap:2px; }
          .home-activity button strong, .home-activity button span { width:100%; }
          .home-activity time { margin-left:16px; }
          .home-activity li:nth-child(n+7) { display:none; }
        }
        @media (max-width: 920px) {
          .home-action-grid { grid-template-columns:repeat(3, minmax(0, 1fr)); }
          .home-customizer-list { grid-template-columns:repeat(2, minmax(0, 1fr)); }
          .home-module { grid-column:1 / -1; }
        }
        @media (max-width: 620px) {
          .home-status { grid-template-columns:1fr; }
          .home-action-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }
        }
        @media (min-width:769px) and (pointer:fine) {
          /* 只改工作台卡片，不影响 Markdown / 文件预览；首页自身的“紧凑”选项仍可再收一档。 */
          .home-dashboard .home-shell { padding:var(--ui-home-padding, 16px 20px 24px); }
          .home-dashboard .home-heading { gap:16px; margin-bottom:14px; }
          .home-dashboard .home-module-grid { gap:8px; }
          .home-dashboard .home-status-item { padding:10px 12px; gap:8px; }
          .home-dashboard .home-action-grid button { min-height:50px; padding:8px 10px; }
          .home-dashboard .home-card-header { min-height:34px; padding:0 10px; }
          .home-dashboard .home-list-row { min-height:40px; padding:6px 10px; gap:8px; }
          .home-dashboard .home-model { padding:9px 11px; }
          .home-dashboard .home-metrics div { padding:9px 4px; }
          .home-dashboard .home-activity { padding:3px 10px; }
          .home-dashboard .home-activity li { min-height:32px; }
          .home-dashboard.density-compact .home-list-row { min-height:36px; padding:4px 10px; }
          .home-dashboard.density-compact .home-action-grid button { min-height:44px; padding:6px 10px; }
        }
        @media (pointer:coarse) {
          .home-list-row, .home-model, .home-status-item, .home-action-grid button,
          .home-sync button, .home-banner button, .home-density button, .home-reset,
          .home-customizer-row button { min-height:44px; }
          .home-action-grid button:hover { transform:none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .home-dashboard *, .home-dashboard *::before, .home-dashboard *::after {
            scroll-behavior:auto !important; animation:none !important; transition:none !important;
          }
          .home-action-grid button:hover { transform:none; }
        }
        @media (forced-colors: active) {
          .home-card, .home-status-item, .home-action-grid button, .home-customizer { border:1px solid CanvasText; }
          .home-status-dot, .home-session-mark { border:1px solid CanvasText; }
        }
      `}</style>
    </main>
  );
};
