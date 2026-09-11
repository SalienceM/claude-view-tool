import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getCurrentUserProfile } from '../api';
import { useClipboardImage } from '../hooks/useClipboardImage';
import { themes, useConfig } from '../hooks/useConfig';
import { markdownToHtml } from '../utils/markdown';
import {
  attentionIcon,
  bindAttention,
  type AttentionContext,
  type AttentionKind,
} from '../utils/attentionContext';
import {
  closeCurrentThoughtsWindow,
  createThoughtsChannel,
  isThoughtsWindow,
  loadThoughtsWindowPinned,
  persistThoughtsWindowPinned,
  type ThoughtsWindowMessage,
} from '../utils/thoughtsWindow';
import { AdvancedPromptTextarea } from './AdvancedPromptTextarea';
import { SpeechToTextControl } from './SpeechToTextControl';

interface AsideTurn {
  id: string;
  question: string;
  answer: string;
  status: string;
  imageCount?: number;
  contextKey?: string;
  contextKind?: AttentionKind;
  contextLabel?: string;
  contextDetail?: string;
  createdAt?: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  session: any | null;
  attention: AttentionContext;
  backends: any[];
  isMobile?: boolean;
  standalone?: boolean;
  onDetach?: () => void;
}

type PanelMode = 'float' | 'dock';

function storedMode(): PanelMode {
  try { return localStorage.getItem('awu.thoughts.mode') === 'dock' ? 'dock' : 'float'; }
  catch { return 'float'; }
}

function storedWidth(): number {
  try {
    const value = Number(localStorage.getItem('awu.thoughts.width'));
    if (Number.isFinite(value)) return Math.max(460, Math.min(900, value));
  } catch { /* ignore */ }
  return 660;
}

function turnContext(turn: AsideTurn): AttentionContext {
  return {
    key: turn.contextKey || 'session',
    kind: turn.contextKind || 'session',
    label: turn.contextLabel || '当前 Session',
    detail: turn.contextDetail || '',
  };
}

export const ThoughtsAssistant: React.FC<Props> = ({
  open,
  onClose,
  session: currentSession,
  attention: currentAttention,
  backends: currentBackends,
  isMobile = false,
  standalone = false,
  onDetach,
}) => {
  // 固定的是请求目标和瞬时快照，不只是下拉框；切换 Session 不能改写绑定。
  const [binding, setBinding] = useState<{ session: any; attention: AttentionContext; backends: any[] } | null>(null);
  const session = binding ? binding.session : currentSession;
  const attention = binding ? binding.attention : currentAttention;
  const backends = binding ? binding.backends : currentBackends;
  const sessionId = session?.id || '';
  const isLoop = session?.sessionType === 'loop';
  const [mode, setMode] = useState<PanelMode>(storedMode);
  const [width, setWidth] = useState(storedWidth);
  const widthRef = useRef(width);
  widthRef.current = width;
  const [asides, setAsides] = useState<AsideTurn[]>([]);
  const [live, setLive] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [asideBackendId, setAsideBackendId] = useState('');
  const [followFocus, setFollowFocus] = useState(true);
  const [selectedContextKey, setSelectedContextKey] = useState(attention.key);
  const [windowPinned, setWindowPinned] = useState(loadThoughtsWindowPinned);
  const [windowPinBusy, setWindowPinBusy] = useState(false);
  const [windowPinSupported, setWindowPinSupported] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { images, removeImage, clearImages, readFromClipboard } = useClipboardImage(boxRef);

  useEffect(() => {
    try { localStorage.setItem('awu.thoughts.mode', mode); } catch { /* ignore */ }
  }, [mode]);
  useEffect(() => {
    try { localStorage.setItem('awu.thoughts.width', String(width)); } catch { /* ignore */ }
  }, [width]);

  useEffect(() => {
    if (!standalone || typeof (window as any).__TAURI_INTERNALS__ === 'undefined') return;
    let cancelled = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const current = getCurrentWindow();
      const preferred = loadThoughtsWindowPinned();
      await current.setAlwaysOnTop(preferred);
      const actual = await current.isAlwaysOnTop().catch(() => preferred);
      if (!cancelled) {
        setWindowPinned(actual);
        setWindowPinSupported(true);
      }
    }).catch(() => { if (!cancelled) setWindowPinSupported(false); });
    return () => { cancelled = true; };
  }, [standalone]);

  useEffect(() => {
    setFollowFocus(true);
    setSelectedContextKey(attention.key);
    setAsides([]);
    setLive({});
    setError('');
  }, [sessionId]);

  useEffect(() => {
    if (followFocus) setSelectedContextKey(attention.key);
  }, [attention.key, followFocus]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    const request = isLoop ? api.loopAsideList(sessionId) : api.chatAsideList(sessionId);
    request.then((result) => {
      if (cancelled) return;
      if (result.status === 'ok') {
        setAsides(result.asides || []);
        setAsideBackendId(result.asideBackendId || '');
      } else setError(result.message || '无法读取俺寻思历史');
    }).catch((reason) => {
      if (!cancelled) setError(reason?.message || '无法读取俺寻思历史');
    }).finally(() => { if (!cancelled) setLoading(false); });

    const applyUpdate = (data: any) => {
      if (data?.sessionId !== sessionId) return;
      setAsides(data.asides || []);
      if (data.asideBackendId !== undefined) setAsideBackendId(data.asideBackendId || '');
      setLive((previous) => {
        const next = { ...previous };
        const answering = new Set((data.asides || [])
          .filter((item: AsideTurn) => item.status === 'answering')
          .map((item: AsideTurn) => item.id));
        Object.keys(next).forEach((id) => { if (!answering.has(id)) delete next[id]; });
        return next;
      });
    };
    const applyDelta = (data: any) => {
      if (data?.sessionId !== sessionId || !data.turnId || !data.text) return;
      setLive((previous) => ({
        ...previous,
        [data.turnId]: `${previous[data.turnId] || ''}${data.text}`,
      }));
    };
    const offUpdated = isLoop ? api.onLoopUpdated(applyUpdate) : api.onChatAsideUpdated(applyUpdate);
    const offDelta = isLoop ? api.onLoopAsideDelta(applyDelta) : api.onChatAsideDelta(applyDelta);
    return () => {
      cancelled = true;
      offUpdated();
      offDelta();
    };
  }, [sessionId, isLoop]);

  const contexts = useMemo(() => {
    const map = new Map<string, AttentionContext>();
    map.set(attention.key, attention);
    [...asides].reverse().forEach((turn) => {
      const context = turnContext(turn);
      if (!map.has(context.key)) map.set(context.key, context);
    });
    return [...map.values()];
  }, [attention, asides]);

  const displayedAttention = useMemo(() => {
    if (followFocus || selectedContextKey === attention.key) return attention;
    return contexts.find((item) => item.key === selectedContextKey) || attention;
  }, [followFocus, selectedContextKey, attention, contexts]);
  const visibleAsides = useMemo(
    () => asides.filter((turn) => (turn.contextKey || 'session') === displayedAttention.key),
    [asides, displayedAttention.key],
  );
  const answeringBusy = asides.some((turn) => turn.status === 'answering');
  const busy = submitting || answeringBusy;
  const otherBusy = answeringBusy && !visibleAsides.some((turn) => turn.status === 'answering');

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    }, 20);
    return () => window.clearTimeout(timer);
  }, [open, visibleAsides.length, live]);

  const attentionForRequest = useCallback((): AttentionContext => {
    if (followFocus || displayedAttention.key === attention.key) return attention;
    return {
      ...displayedAttention,
      content: '当前正在查看这一注意力对象的历史线程；没有重新注入旧界面正文。',
      sessionId,
      workingDir: session?.workingDir,
      execKey: session?.execKey,
    };
  }, [followFocus, displayedAttention, attention, sessionId, session]);

  const submit = useCallback(async (forcedText?: string) => {
    const question = (forcedText ?? draft).trim();
    const context = attentionForRequest();
    const focusImages = context.imageAttachments || [];
    const outgoingImages = [...focusImages, ...images].filter((item, index, all) => (
      all.findIndex((candidate) => candidate.id === item.id) === index
    ));
    if (!sessionId || busy || (!question && outgoingImages.length === 0)) return;
    setError('');
    // 图片框选是瞬时注意力附件；从 attention JSON 中剥离，避免复制两份 Base64。
    const { imageAttachments: _focusImages, ...attentionPayload } = context;
    setSubmitting(true);
    try {
      const result = await (isLoop
        ? api.loopAsk(sessionId, question, outgoingImages.length ? outgoingImages : undefined, attentionPayload as unknown as Record<string, unknown>)
        : api.chatAsk(sessionId, question, outgoingImages.length ? outgoingImages : undefined, attentionPayload as unknown as Record<string, unknown>));
      if (result.status !== 'ok') {
        setError(result.message || '提问失败');
        return;
      }
      if (forcedText === undefined) setDraft('');
      clearImages();
    } catch (reason: any) {
      setError(reason?.message || '提问失败');
    } finally {
      setSubmitting(false);
    }
  }, [draft, sessionId, busy, images, attentionForRequest, isLoop, clearImages]);

  const clearCurrent = useCallback(async () => {
    if (!sessionId || busy || visibleAsides.length === 0) return;
    if (!window.confirm(`只清空“${displayedAttention.label}”下的 ${visibleAsides.length} 条俺寻思记录？`)) return;
    const result = isLoop
      ? await api.loopAsideClear(sessionId, displayedAttention.key)
      : await api.chatAsideClear(sessionId, displayedAttention.key);
    if (result.status !== 'ok') setError(result.message || '清空失败');
  }, [sessionId, busy, visibleAsides.length, displayedAttention, isLoop]);

  const abort = useCallback(() => {
    if (!sessionId) return;
    void (isLoop ? api.loopAsideAbort(sessionId) : api.chatAsideAbort(sessionId));
  }, [sessionId, isLoop]);

  const startResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const move = (next: MouseEvent) => setWidth(Math.max(460, Math.min(900, startWidth + startX - next.clientX)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, []);

  const toggleWindowPin = useCallback(async () => {
    if (!standalone || !windowPinSupported || windowPinBusy) return;
    const next = !windowPinned;
    setWindowPinBusy(true);
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setAlwaysOnTop(next);
      persistThoughtsWindowPinned(next);
      setWindowPinned(next);
    } catch (reason: any) {
      setError(reason?.message || '窗口置顶设置失败');
    } finally {
      setWindowPinBusy(false);
    }
  }, [standalone, windowPinBusy, windowPinSupported, windowPinned]);

  if (!open) return null;

  const actualMode: PanelMode | 'window' = standalone ? 'window' : isMobile ? 'float' : mode;
  const shellStyle: React.CSSProperties = actualMode === 'window'
    ? detachedShell
    : actualMode === 'dock'
    ? { ...dockShell, width }
    : isMobile
      ? { ...floatShell, width: '100%', maxWidth: '100vw', inset: 0, borderRadius: 0 }
      : { ...floatShell, width };
  const backendLabel = backends.find((item) => item.id === (asideBackendId || session?.backendId))?.label
    || (asideBackendId ? '旁路模型' : '跟随 Session');

  return (
    <aside aria-label="俺寻思注意力助手" style={shellStyle}>
      {actualMode === 'dock' && <div onMouseDown={startResize} style={resizeHandle} title="拖动调整俺寻思宽度" />}
      <div style={headerStyle}>
        <div style={brandMark}>🤔</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 760, fontSize: 14, color: 'var(--theme-text)' }}>俺寻思</div>
          <div style={{ fontSize: 10.5, color: 'var(--theme-text-muted)' }}>独立思路 · 跟着你的注意力走</div>
        </div>
        <div style={{ flex: 1 }} />
        {!standalone && !isMobile && (
          <button type="button" style={iconButton} onClick={() => setMode(actualMode === 'dock' ? 'float' : 'dock')}
            title={actualMode === 'dock' ? '改为最上层浮窗' : '停靠到右侧分屏'}>
            {actualMode === 'dock' ? '↗' : '◫'}
          </button>
        )}
        {!standalone && !isMobile && onDetach && (
          <button type="button" disabled={!!binding} style={{ ...iconButton, width: 'auto', padding: '0 9px', opacity: binding ? 0.5 : 1 }} onClick={onDetach} title={binding ? '请先解除注意力固定，再分离窗口' : '分离为独立宽窗口，方便系统分屏'}>⧉ 分离</button>
        )}
        {standalone && (
          <button
            type="button"
            style={{ ...iconButton, width: 'auto', padding: '0 9px', ...(windowPinned ? activeIconButton : {}), opacity: windowPinSupported ? 1 : 0.48 }}
            disabled={!windowPinSupported || windowPinBusy}
            onClick={() => void toggleWindowPin()}
            title={windowPinSupported
              ? windowPinned ? '取消独立窗口置顶' : '让独立窗口始终置顶'
              : '浏览器弹窗无法强制跨应用置顶；可使用系统分屏'}
          >{windowPinBusy ? '设置中…' : windowPinned ? '📌 已置顶' : '📍 置顶'}</button>
        )}
        <button type="button" style={iconButton} onClick={onClose} title="收起俺寻思">✕</button>
      </div>

      <div style={attentionCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>{attentionIcon(displayedAttention.kind)}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <strong style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayedAttention.label}
              </strong>
              <span style={followingBadge}>{binding ? '📌 已固定' : followFocus ? '跟随中' : '历史线程'}</span>
            </div>
            <div title={displayedAttention.detail} style={attentionDetail}>{displayedAttention.detail || '当前 Session'}</div>
          </div>
        </div>
        <div style={contextControls}>
          <select
            value={displayedAttention.key}
            style={contextSelect}
            aria-label="切换俺寻思的注意力线程"
            disabled={!!binding}
            onChange={(event) => {
              setSelectedContextKey(event.target.value);
              setFollowFocus(event.target.value === attention.key);
            }}
          >
            {contexts.map((item) => <option key={item.key} value={item.key}>{attentionIcon(item.kind)} {item.label}</option>)}
          </select>
          <button type="button" style={followButton} disabled={!sessionId} aria-pressed={!!binding}
            title={binding ? '解除固定，重新跟随当前界面' : '绑定当前注意力、Session 和执行节点；切换界面不会漂移'}
            onClick={() => {
              if (binding) {
                setBinding(null);
                setSelectedContextKey(currentAttention.key);
              } else {
                setBinding(bindAttention(session, attentionForRequest(), backends));
                setSelectedContextKey(displayedAttention.key);
              }
              setFollowFocus(true);
            }}>{binding ? '◎ 解除固定' : '📌 固定注意力'}</button>
          {!binding && !followFocus && <button style={followButton} onClick={() => { setFollowFocus(true); setSelectedContextKey(attention.key); }}>◎ 回到当前</button>}
        </div>
        <div style={snapshotLine}>
          <span>{session ? `Session · ${session.title || session.name || session.id.slice(0, 8)}` : '尚未选择 Session'}</span>
          <span>{displayedAttention.imageAttachments?.length
            ? `已关联 ${displayedAttention.imageAttachments.length} 张框选图 · 发送时自动附带`
            : displayedAttention.content ? `已带入 ${displayedAttention.content.length.toLocaleString()} 字界面快照` : '仅带入对象身份'}</span>
        </div>
      </div>

      <div style={modelBar}>
        <span>思考模型</span>
        {isLoop ? (
          <span style={{ color: 'var(--theme-text)' }}>{backendLabel} · LOOP aside 策略</span>
        ) : (
          <select value={asideBackendId} style={modelSelect} disabled={!sessionId || busy}
            onChange={(event) => {
              const value = event.target.value;
              setAsideBackendId(value);
              void api.chatAsideSetBackend(sessionId, value);
            }}>
            <option value="">跟随 Session</option>
            {backends.map((backend) => <option key={backend.id} value={backend.id}>{backend.label || backend.id}</option>)}
          </select>
        )}
        <div style={{ flex: 1 }} />
        {visibleAsides.length > 0 && <button style={quietButton} disabled={busy} onClick={() => void clearCurrent()}>清空当前</button>}
      </div>

      <div ref={listRef} style={listStyle}>
        {loading && <div style={emptyStyle}>正在恢复这条注意力线程…</div>}
        {!loading && !sessionId && <div style={emptyStyle}>先选择一个 Session，俺寻思会跟随它以及你在界面里打开的文件和面板。</div>}
        {!loading && sessionId && visibleAsides.length === 0 && (
          <div style={emptyStyle}>
            现在关注的是“{displayedAttention.label}”。你可以直接问“这个是什么意思”“这里该怎么改”，无需再复述对象。
          </div>
        )}
        {visibleAsides.map((turn) => {
          const answering = turn.status === 'answering';
          const answer = answering ? (live[turn.id] || turn.answer || '') : (turn.answer || '');
          return (
            <article key={turn.id} style={turnStyle}>
              <div style={questionStyle}>
                <span style={questionTag}>你</span>
                <span style={{ whiteSpace: 'pre-wrap' }}>{turn.question}</span>
                {!!turn.imageCount && <span style={{ color: 'var(--theme-text-muted)' }}>🖼️ {turn.imageCount}</span>}
              </div>
              <div style={answerStyle}>
                <span style={answerTag}>想</span>
                {answer ? (
                  <div className="md-content" style={{ flex: 1, minWidth: 0 }}
                    dangerouslySetInnerHTML={{ __html: markdownToHtml(answer) + (answering ? ' <span class="streaming-cursor">▍</span>' : '') }} />
                ) : <span style={{ color: 'var(--theme-text-muted)' }}>正在顺着这里想…</span>}
              </div>
              {turn.status === 'done' && turn.answer && (
                <div style={actionRow}>
                  <button style={quietButton} onClick={() => void api.seqtaskAdd(sessionId, turn.answer)}>→ 加入主流程队列</button>
                  <button style={quietButton} onClick={() => void navigator.clipboard?.writeText(turn.answer)}>复制</button>
                </div>
              )}
            </article>
          );
        })}
        {otherBusy && <div style={backgroundBusy}>另一条注意力线程正在回答，可切回查看进度。</div>}
      </div>

      {error && <div role="alert" style={errorStyle}>{error}</div>}

      <div ref={boxRef} style={composerStyle}>
        {images.length > 0 && (
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 8 }}>
            {images.map((image) => (
              <div key={image.id} style={{ position: 'relative' }}>
                <img alt="" src={`data:${image.mime_type};base64,${image.base64}`} style={thumbnailStyle} />
                <button style={thumbnailClose} onClick={() => removeImage(image.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <AdvancedPromptTextarea
            value={draft}
            onValueChange={setDraft}
            sessionId={sessionId || undefined}
            workingDir={session?.workingDir}
            execKey={session?.execKey}
            placeholder={sessionId ? `直接问“这个…” · 当前指向 ${displayedAttention.label}` : '请先选择 Session'}
            onPaste={readFromClipboard}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            disabled={!sessionId || busy}
            containerStyle={{ flex: 1 }}
            style={textareaStyle}
          />
          {busy ? (
            <button style={stopButton} onClick={abort} title="停止当前俺寻思回答">■</button>
          ) : (
            <button style={sendButton} disabled={!sessionId || (!draft.trim() && images.length === 0 && !displayedAttention.imageAttachments?.length)} onClick={() => void submit()}>发送</button>
          )}
          {sessionId && (
            <SpeechToTextControl
              sessionId={sessionId}
              value={draft}
              onValueChange={setDraft}
              disabled={busy}
            />
          )}
        </div>
      </div>
    </aside>
  );
};

export { isThoughtsWindow };

/** 独立 Web/Tauri 窗口：通过 BroadcastChannel 接收主窗口的瞬时注意力，不落盘正文。 */
export const ThoughtsAssistantWindow: React.FC = () => {
  const initialSessionId = new URLSearchParams(location.search).get('sessionId') || '';
  const [attention, setAttention] = useState<AttentionContext>({
    key: initialSessionId ? 'session' : 'home',
    kind: initialSessionId ? 'session' : 'home',
    label: initialSessionId ? `Session ${initialSessionId.slice(0, 8)}` : 'AgentWithU 工作总览',
    detail: '等待主窗口同步当前关注点…',
    sessionId: initialSessionId || undefined,
  });
  const [session, setSession] = useState<any | null>(null);
  const [backends, setBackends] = useState<any[]>([]);
  const currentUser = useMemo(() => getCurrentUserProfile(), []);
  const { config } = useConfig(currentUser);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    document.title = '俺寻思 — AgentWithU';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    const channel = createThoughtsChannel();
    channelRef.current = channel;
    if (channel) {
      channel.onmessage = (event: MessageEvent<ThoughtsWindowMessage>) => {
        if (event.data?.type === 'snapshot') setAttention(event.data.attention);
      };
      channel.postMessage({ type: 'detached-open' } satisfies ThoughtsWindowMessage);
      channel.postMessage({ type: 'request-snapshot' } satisfies ThoughtsWindowMessage);
    }
    const closed = () => channel?.postMessage({ type: 'detached-closed' } satisfies ThoughtsWindowMessage);
    window.addEventListener('beforeunload', closed);
    return () => {
      closed();
      window.removeEventListener('beforeunload', closed);
      channel?.close();
      channelRef.current = null;
    };
  }, []);

  const sessionId = attention.sessionId || initialSessionId;
  useEffect(() => {
    if (!sessionId) { setSession(null); setBackends([]); return; }
    let cancelled = false;
    setSession((current: any) => current?.id === sessionId ? current : null);
    void api.loadSessionMeta(sessionId).then((metadata) => {
      if (!cancelled) setSession(metadata);
    }).catch(() => {
      if (!cancelled) setSession({ id: sessionId, title: attention.label, workingDir: attention.workingDir, execKey: attention.execKey });
    });
    return () => { cancelled = true; };
  }, [attention.execKey, attention.label, attention.workingDir, sessionId]);

  useEffect(() => {
    if (!sessionId || !session) return;
    let cancelled = false;
    void api.getBackends(session.execKey).then((items) => { if (!cancelled) setBackends(items || []); });
    return () => { cancelled = true; };
  }, [session, sessionId]);

  const palette = themes[config.theme] || themes.dark;
  const rootStyle = {
    width: '100vw', height: '100vh', overflow: 'hidden', background: palette.bg,
    '--theme-bg': palette.bg,
    '--theme-bg-secondary': palette.bgSecondary,
    '--theme-bg-tertiary': palette.bgTertiary,
    '--theme-panel-bg': palette.bg,
    '--theme-input-bg': palette.inputBg,
    '--theme-border': palette.border,
    '--theme-text': palette.text,
    '--theme-text-muted': palette.textMuted,
    '--theme-accent': palette.accent,
    '--theme-accent-bg': palette.accentBg,
    '--theme-error': palette.error,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
  } as React.CSSProperties;

  const close = () => {
    channelRef.current?.postMessage({ type: 'detached-closed' } satisfies ThoughtsWindowMessage);
    void closeCurrentThoughtsWindow();
  };

  return (
    <div className="awu-thoughts-window" style={rootStyle}>
      <style>{`
        .awu-thoughts-window .md-content { line-height: 1.7; overflow-wrap: anywhere; }
        .awu-thoughts-window .md-content p { margin: .55em 0; }
        .awu-thoughts-window .md-content ul,
        .awu-thoughts-window .md-content ol { margin: .55em 0; padding-left: 1.7em; }
        .awu-thoughts-window .md-content pre { overflow: auto; margin: .65em 0; padding: 10px 12px; border-radius: 8px; background: ${palette.codeBg}; }
        .awu-thoughts-window .md-content code { font-family: Consolas, "SFMono-Regular", monospace; }
        .awu-thoughts-window .md-content blockquote { margin: .65em 0; padding-left: 10px; border-left: 3px solid ${palette.accent}; color: ${palette.textMuted}; }
        .awu-thoughts-window .md-content table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
        .awu-thoughts-window .md-content th,
        .awu-thoughts-window .md-content td { padding: 6px 8px; border: 1px solid ${palette.border}; }
        .awu-thoughts-window .streaming-cursor { color: ${palette.accent}; animation: awu-thoughts-blink .85s steps(1) infinite; }
        @keyframes awu-thoughts-blink { 50% { opacity: 0; } }
      `}</style>
      <ThoughtsAssistant
        open
        standalone
        onClose={close}
        session={session}
        attention={attention}
        backends={backends}
      />
    </div>
  );
};

const dockShell: React.CSSProperties = {
  position: 'relative', zIndex: 32000, flexShrink: 0, height: '100%', minWidth: 460, maxWidth: '70vw',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  background: 'var(--theme-panel-bg, var(--theme-bg))',
  borderLeft: '1px solid var(--theme-border)', boxShadow: '-10px 0 30px rgba(0,0,0,.16)',
};
const detachedShell: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1, width: '100%', height: '100%',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  background: 'var(--theme-panel-bg, var(--theme-bg))', color: 'var(--theme-text)',
};
const floatShell: React.CSSProperties = {
  position: 'fixed', zIndex: 32000, top: 62, right: 18, bottom: 18, maxWidth: 'calc(100vw - 24px)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  background: 'var(--theme-panel-bg, var(--theme-bg))', border: '1px solid var(--theme-border)',
  borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,.38)', backdropFilter: 'blur(20px)',
};
const resizeHandle: React.CSSProperties = { position: 'absolute', left: -3, top: 0, bottom: 0, width: 6, cursor: 'col-resize', zIndex: 2 };
const headerStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px 10px', borderBottom: '1px solid var(--theme-border)' };
const brandMark: React.CSSProperties = { width: 34, height: 34, borderRadius: 11, display: 'grid', placeItems: 'center', fontSize: 18, background: 'linear-gradient(135deg, var(--theme-accent-bg), var(--theme-bg-tertiary))', border: '1px solid var(--theme-border)' };
const iconButton: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', cursor: 'pointer' };
const activeIconButton: React.CSSProperties = { color: 'var(--theme-accent)', borderColor: 'var(--theme-accent)', background: 'var(--theme-accent-bg)' };
const attentionCard: React.CSSProperties = { margin: '11px 12px 8px', padding: '11px 12px', borderRadius: 12, border: '1px solid color-mix(in srgb, var(--theme-accent) 35%, var(--theme-border))', background: 'linear-gradient(135deg, var(--theme-accent-bg), transparent 72%)', color: 'var(--theme-text)' };
const followingBadge: React.CSSProperties = { fontSize: 9.5, padding: '1px 5px', borderRadius: 999, color: 'var(--theme-accent)', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', flexShrink: 0 };
const attentionDetail: React.CSSProperties = { marginTop: 2, fontSize: 10.5, color: 'var(--theme-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const contextControls: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginTop: 9 };
const contextSelect: React.CSSProperties = { flex: 1, minWidth: 0, padding: '5px 7px', fontSize: 11, borderRadius: 7, border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)' };
const followButton: React.CSSProperties = { padding: '5px 8px', borderRadius: 7, border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)', fontSize: 10.5, cursor: 'pointer' };
const snapshotLine: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8, color: 'var(--theme-text-muted)', fontSize: 9.5 };
const modelBar: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, padding: '3px 13px 8px', color: 'var(--theme-text-muted)', fontSize: 10.5, borderBottom: '1px solid var(--theme-border)' };
const modelSelect: React.CSSProperties = { maxWidth: 210, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', fontSize: 10.5 };
const quietButton: React.CSSProperties = { padding: '3px 7px', borderRadius: 6, border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', color: 'var(--theme-text-muted)', fontSize: 10.5, cursor: 'pointer' };
const listStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 13px 16px' };
const emptyStyle: React.CSSProperties = { margin: '18px 4px', padding: 16, borderRadius: 12, border: '1px dashed var(--theme-border)', color: 'var(--theme-text-muted)', fontSize: 12, lineHeight: 1.7 };
const turnStyle: React.CSSProperties = { padding: '11px 2px 13px', borderBottom: '1px solid var(--theme-border)' };
const questionStyle: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, color: 'var(--theme-text)' };
const answerStyle: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 7, marginTop: 9, fontSize: 12.5, lineHeight: 1.65, color: 'var(--theme-text)' };
const questionTag: React.CSSProperties = { flexShrink: 0, padding: '1px 5px', borderRadius: 4, fontSize: 9.5, fontWeight: 700, background: 'var(--theme-accent)', color: '#fff' };
const answerTag: React.CSSProperties = { flexShrink: 0, padding: '1px 5px', borderRadius: 4, fontSize: 9.5, fontWeight: 700, background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text-muted)', border: '1px solid var(--theme-border)' };
const actionRow: React.CSSProperties = { display: 'flex', gap: 6, marginTop: 7, marginLeft: 27 };
const backgroundBusy: React.CSSProperties = { marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--theme-accent-bg)', color: 'var(--theme-text-muted)', fontSize: 11 };
const errorStyle: React.CSSProperties = { margin: '0 13px 7px', padding: '7px 9px', borderRadius: 7, background: 'rgba(239,68,68,.1)', color: 'var(--theme-error, #ef4444)', fontSize: 11 };
const composerStyle: React.CSSProperties = { flexShrink: 0, padding: '8px 12px 12px', borderTop: '1px solid var(--theme-border)', background: 'var(--theme-bg)' };
const textareaStyle: React.CSSProperties = { width: '100%', minHeight: 48, maxHeight: 150, resize: 'vertical', padding: 9, borderRadius: 10, border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)', color: 'var(--theme-text)', fontSize: 12.5, lineHeight: 1.5, fontFamily: 'inherit', boxSizing: 'border-box' };
const sendButton: React.CSSProperties = { minWidth: 58, height: 40, padding: '0 12px', borderRadius: 10, border: 'none', background: 'var(--theme-accent)', color: '#fff', fontWeight: 650, cursor: 'pointer' };
const stopButton: React.CSSProperties = { width: 42, height: 40, borderRadius: 10, border: '1px solid rgba(239,68,68,.4)', background: 'rgba(239,68,68,.1)', color: '#ef4444', cursor: 'pointer' };
const thumbnailStyle: React.CSSProperties = { width: 46, height: 46, objectFit: 'cover', borderRadius: 7, border: '1px solid var(--theme-border)' };
const thumbnailClose: React.CSSProperties = { position: 'absolute', right: -5, top: -5, width: 17, height: 17, borderRadius: '50%', border: 0, padding: 0, background: '#1f2937', color: '#fff', fontSize: 9, cursor: 'pointer' };
