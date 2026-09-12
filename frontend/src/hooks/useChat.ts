import { useState, useCallback, useEffect, useRef, startTransition } from 'react';
import { api } from '../api';
import { uuid } from '../utils/uuid';
import type { ImageAttachment } from './useClipboardImage';
import type { TextAttachment } from '../types/attachments';
import {
  hasVisibleMessagePayload,
  shouldKeepChatMessage,
} from '../utils/chatMessageVisibility';
import {
  mergeAuthoritativeChatMessages,
  mergeCachedHistoryWithStreamTail,
} from '../utils/chatMessageOrder';
import {
  getStreamState,
  resetStreamAccumulators,
  clearStreamState,
  initStreamMessage,
  buildStreamingMessage,
  type StreamState,
} from './useStreamState';

export interface SubagentInfo {
  taskId?: string;
  description?: string;
  taskType?: string | null;
  status?: 'running' | 'completed' | 'failed' | 'stopped' | string;
  lastToolName?: string | null;
  summary?: string | null;
  outputFile?: string | null;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
}

export interface ToolCall {
  id?: string;
  name: string;
  input?: string;
  output?: string;
  status: string;
  startTime?: number;  // ★ Track start time for duration calculation
  duration?: number;   // ★ Duration in milliseconds
  diff?: { path: string; old: string; new: string };  // ★ Diff data for Edit tools
  parentToolUseId?: string;  // ★ 父 Task tool_use.id（当此工具由子 agent 触发时）
  subagent?: SubagentInfo;   // ★ 仅父级 Task tool 才携带：子 agent 的生命周期元数据
}

// ★ 有序内容块：按到达顺序记录 thinking / tool / text 的出现
export interface ContentBlock {
  type: 'thinking' | 'tool' | 'text';
  toolIndex?: number;  // type === 'tool' 时指向 toolCalls 数组的索引
  /**
   * 文本块自己的内容。流式消息可能是“文本 → 工具 → 文本”，不能让每个
   * text 块都回退去渲染整条 message.content，否则会重复并打乱到达顺序。
   * 旧消息没有该字段，MessageBubble 会兼容地只渲染一次完整正文。
   */
  text?: string;
}

export interface PermissionRequest {
  sessionId: string;
  messageId: string;
  tools: ToolCall[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  images?: ImageAttachment[];
  textAttachments?: TextAttachment[];
  backendId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
    contextTokens?: number;
    contextWindow?: number;
  };
  toolCalls?: ToolCall[];
  thinking?: string;
  streaming?: boolean;
  /** 已发送到后端、但尚未收到首个可展示流事件。仅用于瞬时 UI，不持久化。 */
  waitingForFirstDelta?: boolean;
  contentBlocks?: ContentBlock[];  // ★ 有序内容块，按到达顺序排列
  elapsed?: number;  // ★ 本次回复总耗时（毫秒）
  deliveryMode?: 'steer' | 'redirect';
}

// ═══════════════════════════════════════
//  ★ 斜杠命令定义
// ═══════════════════════════════════════
export interface SlashCommand {
  name: string;
  description: string;
  shortDesc: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help',          description: '显示可用命令列表',                     shortDesc: '帮助' },
  { name: '/new',           description: '清空对话上下文（session不变，重置下游agent session）', shortDesc: '清空上下文' },
  { name: '/clear',         description: '清空当前对话历史',                     shortDesc: '清空' },
  { name: '/compact',       description: '压缩早期消息以节省上下文窗口',         shortDesc: '压缩' },
  { name: '/cost',          description: '显示本次会话的 Token 用量与估算费用',  shortDesc: '费用' },
  { name: '/status',        description: '显示当前会话状态信息',                 shortDesc: '状态' },
  { name: '/continue',      description: '让 Claude 从上次停止处继续',           shortDesc: '继续' },
  { name: '/autocontinue',  description: '切换 max_tokens 时自动续跑',           shortDesc: '自动续跑' },
  { name: '/model',         description: '显示当前模型信息',                     shortDesc: '模型' },
  { name: '/init',          description: '让 Claude 分析项目并创建 CLAUDE.md',   shortDesc: '初始化' },
  { name: '/config',        description: '显示当前后端配置',                     shortDesc: '配置' },
  { name: '/migrate',       description: '切换到其他模型（保留对话历史）',        shortDesc: '迁移' },
  { name: '/commit',        description: 'AI 生成 commit message 并提交所有改动', shortDesc: '提交' },
  { name: '/git',           description: 'Git 操作：/git status | log | push | pull', shortDesc: 'Git' },
];

const HELP_TEXT = `📋 **可用命令：**

| 命令 | 说明 |
|------|------|
| \`/help\` | 显示此帮助信息 |
| \`/clear\` | 清空对话历史 |
| \`/compact\` | 压缩早期消息节省上下文 |
| \`/cost\` | 显示 Token 用量 |
| \`/status\` | 显示会话状态 |
| \`/continue\` | 让 Claude 继续上次回复 |
| \`/autocontinue\` | 开关自动续跑模式 |
| \`/model\` | 显示当前模型 |
| \`/init\` | 创建 CLAUDE.md 项目文件 |
| \`/config\` | 显示后端配置 |
| \`/migrate\` | 切换到其他模型（保留历史） |
| \`/commit\` | AI 生成 commit message 并提交 |
| \`/git\` | Git: status / log / push / pull |

**快捷键：** Enter 发送 · Shift+Enter 换行 · Ctrl+V 粘贴图片`;

function normalizeMessage(msg: any): ChatMessage {
  const thinking =
    msg.thinking ||
    msg.thinkingBlocks?.map((b: any) => b.content).join('\n\n') ||
    undefined;

  // ★ 修复存储中残留的 running 工具状态：非流式消息的工具调用不可能还在运行
  const toolCalls = msg.streaming
    ? msg.toolCalls
    : msg.toolCalls?.map((tc: any) =>
        tc.status === 'running' ? { ...tc, status: 'done' } : tc
      );

  // ★ 为历史消息重建 contentBlocks（加载时没有此字段）
  let contentBlocks = msg.contentBlocks as ContentBlock[] | undefined;
  if (!contentBlocks && msg.role === 'assistant') {
    const blocks: ContentBlock[] = [];
    if (thinking) blocks.push({ type: 'thinking' });
    if (toolCalls?.length) {
      toolCalls.forEach((_: any, i: number) => blocks.push({ type: 'tool', toolIndex: i }));
    }
    if (msg.content) blocks.push({ type: 'text' });
    if (blocks.length > 0) contentBlocks = blocks;
  }

  return {
    ...msg,
    thinking,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(contentBlocks ? { contentBlocks } : {}),
  };
}

function normalizeMessages(messages: any[]): ChatMessage[] {
  return messages.map(normalizeMessage).filter(shouldKeepChatMessage);
}

// 模块级历史缓存:loadSession RPC 比较慢(尤其经中继),切换 session 时如果
// 同步可以从缓存里立刻拿出历史 + 当前流式 tail,就不会出现「先一条流再几条
// 历史」的跳变。loadSession 回来后用最新结果覆盖缓存。
const sessionHistoryCache = new Map<string, ChatMessage[]>();
// sendMessage 是 fire-and-forget；loadSession 可能在后端接收新消息前先返回。
// 明确登记这段竞态窗口中的本地 ID，避免为了防丢而保留所有未知旧气泡。
const pendingLocalMessageIds = new Map<string, Set<string>>();

function pendingIdsFor(sessionId: string): Set<string> {
  let ids = pendingLocalMessageIds.get(sessionId);
  if (!ids) {
    ids = new Set<string>();
    pendingLocalMessageIds.set(sessionId, ids);
  }
  return ids;
}

function mergeLoadedWithLocal(
  sessionId: string,
  loaded: ChatMessage[],
  current: ChatMessage[],
): ChatMessage[] {
  const pendingIds = pendingIdsFor(sessionId);
  for (const message of loaded) pendingIds.delete(message.id);
  if (pendingIds.size === 0) pendingLocalMessageIds.delete(sessionId);
  return mergeAuthoritativeChatMessages(loaded, current, pendingIds);
}

// 首次加载只取最近 N 条,远程过中继时几十兆 base64 一次性砸过来会卡几秒到
// 十几秒。后续按需 loadEarlier(),每次再拉 EARLIER_CHUNK 条往前 prepend。
const INITIAL_LOAD_LIMIT = 20;
const EARLIER_CHUNK = 30;

export function clearSessionHistoryCache(sessionId: string): void {
  sessionHistoryCache.delete(sessionId);
  pendingLocalMessageIds.delete(sessionId);
}

export function useChat(
  sessionId: string,
  backendId: string,
  backends?: any[],
  skipPermissions: boolean = true,
  onNewSession?: () => void,
  onClearContext?: () => void,
  sessionRuntime?: { modelOverride?: string; reasoningEffort?: string },
  hydrationEnabled: boolean = true,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [autoContinue, setAutoContinue] = useState(true);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  // ★ 历史分页:首次 loadSession 时只取最近 INITIAL_LOAD_LIMIT 条,加快远程
  //   首屏。messagesTotal 是 session 在磁盘上的总数,hasMore 表示还有更老的
  //   可拉。loadEarlier() 拉下一批往前面 prepend。
  const [messagesTotal, setMessagesTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // ★ 首次加载 session 是否还在飞:UI 据此显示加载提示,避免「点了 session
  //   但页面没动」的卡顿感。区别于 loadingEarlier(那个是翻页加载更老消息)。
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  // React 会复用同一个 ChatPane Hook 实例。切换 session 的首个 render 仍
  // 带着上一个 session 的 state；这两个 ID 用于阻止状态串报，并告诉滚动
  // 层什么时候已经完成目标 session 的权威历史水合。
  const [resolvedSessionId, setResolvedSessionId] = useState(sessionId);
  const [hydratedSessionId, setHydratedSessionId] = useState('');

  // 累积器 refs - 用于本地快速访问，实际状态存储在全局 StreamState
  const textRef = useRef('');
  const thinkingRef = useRef('');
  const toolCallsRef = useRef<ToolCall[]>([]);
  const contentBlocksRef = useRef<ContentBlock[]>([]);  // ★ 有序内容块
  const streamStartRef = useRef<number>(0);  // ★ 流式开始时间戳
  const msgIdRef = useRef<string | null>(null);
  // ★ 流式进行时用户发送的新消息（中断续发队列，最多保留最后一条）
  const pendingMessageRef = useRef<{
    content: string;
    images?: ImageAttachment[];
    textAttachments?: TextAttachment[];
  } | null>(null);

  // 稳定引用 refs
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;
  const autoContinueRef = useRef(true);
  autoContinueRef.current = autoContinue;
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const skipPermissionsRef = useRef(skipPermissions);
  skipPermissionsRef.current = skipPermissions;

  // ── RAF 节流 refs（流式渲染限速，不阻塞用户输入）──
  const rafIdRef = useRef<number | null>(null);
  const pendingMsgUpdateRef = useRef<(() => void) | null>(null);

  // ★ 同步本地 refs 与全局状态
  const syncFromGlobalState = useCallback((state: StreamState) => {
    textRef.current = state.text;
    thinkingRef.current = state.thinking;
    toolCallsRef.current = state.toolCalls;
    contentBlocksRef.current = state.contentBlocks;
    streamStartRef.current = state.streamStart;
    msgIdRef.current = state.messageId;
  }, []);

  // ── 加载 session ──
  useEffect(() => {
    if (!sessionId || !hydrationEnabled) {
      // session 被删除或未选中 → 清空聊天区
      setMessages([]);
      isStreamingRef.current = false;
      setIsStreaming(false);
      setMessagesTotal(0);
      setHasMore(false);
      setLoadingEarlier(false);
      setIsLoadingSession(false);
      setResolvedSessionId('');
      setHydratedSessionId('');
      return;
    }

    // 每次切到新 session 都先把分页状态置空,等 loadSession 回来再更新
    setHasMore(false);
    setLoadingEarlier(false);
    setIsLoadingSession(true);
    setHydratedSessionId('');

    // ★ 先检查全局流式状态
    const globalState = getStreamState(sessionId);
    const hasActiveStream = !!(globalState.isStreaming && globalState.messageId);

    // ★ 同步水合策略:目标是切到 B 的瞬间就给一个「合理画面」,而不是先空
    //    一刀再分两次刷出来。但绝不能渲染「content='' + streaming=true」的
    //    幽灵 tail——那会变成空插入符闪。
    //
    //    所以 tail 只在「state 真的有内容可展示」时才构造;两条 setMessages
    //    分支都只决定「底下铺什么历史」。
    const cachedHistory = sessionHistoryCache.get(sessionId);
    const hasStreamContent = hasVisibleMessagePayload({
      content: globalState.text,
      thinking: globalState.thinking,
      toolCalls: globalState.toolCalls,
      contentBlocks: globalState.contentBlocks,
    });

    // 全局状态也可能保存一条刚在后台完成的消息。即使已经 done，也先用它
    // 补齐缓存，避免切回来后必须等 loadSession 才能看到刚完成的回答。
    const tail: ChatMessage | null =
      globalState.messageId && (hasActiveStream || hasStreamContent)
        ? hasStreamContent
          ? buildStreamingMessage(globalState, {
              id: globalState.messageId,
              role: 'assistant',
              content: '',
              timestamp: Date.now() / 1000,
              streaming: hasActiveStream,
            })
          : {
              id: globalState.messageId,
              role: 'assistant',
              content: '',
              timestamp: Date.now() / 1000,
              streaming: true,
              waitingForFirstDelta: true,
            }
        : null;

    // 活跃 tail 可以补到缓存末尾；已完成 tail 只能覆盖缓存中的同 ID 原位置。
    // 后者若不在缓存，必须等待 loadSession 返回权威顺序，不能猜成最后一条。
    setMessages(mergeCachedHistoryWithStreamTail(cachedHistory, tail, hasActiveStream));
    isStreamingRef.current = hasActiveStream;
    setIsStreaming(hasActiveStream);
    setResolvedSessionId(sessionId);
    if (hasActiveStream) syncFromGlobalState(globalState);

    // ★ 防 race:快速切换时旧 session 的 loadSession Promise 可能比新 session
    //   先 resolve,如果不拦,旧的 setMessages 会把当前 session 的 UI 改成
    //   旧的内容(可能还是个 content='' 的幽灵)。Effect cleanup 把 cancelled
    //   翻成 true,异步回调就直接吐回去。
    let cancelled = false;

    // 每次切入 session 都向它所属执行节点核对权威运行态。接管 Codex 的
    // turn/start / 模型握手阶段可能很久没有 delta，不能据此误判为空闲。
    void api.getSessionRunState(sessionId).then((runState) => {
      if (cancelled || runState.status !== 'ok' || !runState.busy) return;
      const authoritative = getStreamState(sessionId);
      authoritative.isStreaming = true;
      isStreamingRef.current = true;
      setIsStreaming(true);
      setResolvedSessionId(sessionId);
    });

    // 有缓存时按缓存大小拉,避免切走→切回把已经翻页加载过的历史又缩回 20 条
    const initialLimit = Math.max(INITIAL_LOAD_LIMIT, cachedHistory?.length ?? 0);
    api.loadSession(sessionId, initialLimit).then((session) => {
      if (cancelled) return;
      if (session?.messages) {
        let loadedMessages = normalizeMessages(session.messages);
        const loadedStreaming = [...loadedMessages].reverse().find(
          (message: ChatMessage) => message.streaming,
        );
        if (loadedStreaming) {
          const restored = getStreamState(sessionId);
          // 只有前端没有更完整的活跃累积器时才用后端内存快照恢复。
          if (!restored.isStreaming || restored.messageId !== loadedStreaming.id) {
            restored.messageId = loadedStreaming.id;
            restored.text = loadedStreaming.content || '';
            restored.thinking = loadedStreaming.thinking || '';
            restored.toolCalls = loadedStreaming.toolCalls ? [...loadedStreaming.toolCalls] : [];
            restored.contentBlocks = loadedStreaming.contentBlocks ? [...loadedStreaming.contentBlocks] : [];
            restored.streamStart = loadedStreaming.timestamp
              ? loadedStreaming.timestamp * 1000
              : Date.now();
          }
          restored.isStreaming = true;
          isStreamingRef.current = true;
          setIsStreaming(true);
          setResolvedSessionId(sessionId);
        }
        const total = typeof session.messagesTotal === 'number'
          ? session.messagesTotal
          : loadedMessages.length;
        setMessagesTotal(total);
        setHasMore(!!session.hasMore || loadedMessages.length < total);

        // ★ 重新读一次 state——RPC 往返期间流可能又推进了好几个 delta。
        const latest = getStreamState(sessionId);
        const stillStreaming = !!(latest.isStreaming && latest.messageId);
        const latestHasContent = hasVisibleMessagePayload({
          content: latest.text,
          thinking: latest.thinking,
          toolCalls: latest.toolCalls,
          contentBlocks: latest.contentBlocks,
        });
        if (latest.messageId && latestHasContent) {
          const existingIndex = loadedMessages.findIndex(
            (m: ChatMessage) => m.id === latest.messageId,
          );
          // 后端在 turn 进行中持有的是同 ID 的空 assistant 占位，实时正文只在
          // StreamState 中。不能因为“ID 已存在”就保留空占位，否则切回 session
          // 会把刚恢复出的正文再次覆盖成一个只有光标的小气泡。
          const liveMessage = buildStreamingMessage(latest, {
            ...(existingIndex >= 0 ? loadedMessages[existingIndex] : {}),
            id: latest.messageId,
            role: 'assistant',
            content: '',
            timestamp: existingIndex >= 0
              ? loadedMessages[existingIndex].timestamp
              : Date.now() / 1000,
            streaming: stillStreaming,
          });
          loadedMessages = mergeCachedHistoryWithStreamTail(
            loadedMessages,
            liveMessage,
            stillStreaming,
          );
        }
        // ★ 更新历史缓存(只缓存非 streaming 的「定稿」消息,避免下次切回来
        //    看到一个错位的 stale 流式版本)。注意:这里缓存的是「已加载的最近
        //    N 条」,不是全部历史。下次切回来仍然以 N 条起步。
        sessionHistoryCache.set(
          sessionId,
          loadedMessages.filter((m: ChatMessage) => !m.streaming),
        );
        // ★ 防丢消息：loadSession RPC 往返期间，doSend 可能已经追加了尚未被
        //    后端确认的本地气泡。只保留显式登记的 pending/streaming/system，
        //    不能再把任意未知的已完成 assistant 当成本地消息塞到末尾。
        setMessages((prev) => {
          return mergeLoadedWithLocal(sessionId, loadedMessages, prev);
        });
      }
      if (session?.autoContinue !== undefined) {
        setAutoContinue(session.autoContinue);
      }
    }).finally(() => {
      if (!cancelled) {
        setHydratedSessionId(sessionId);
        setIsLoadingSession(false);
      }
    });

    // ⚠ 不要在 cleanup 里清流式状态。
    //   切换 session 时旧 session 可能还在后台流,清掉会丢中间内容。
    //   全局 streamStates Map 由 installGlobalStreamRouter 持续维护,
    //   切回来时由上面的「水合」逻辑读出来。
    //   仅在 session 删除(useStreamState.clearStreamStateForSession)
    //   和 WS 重连时(下面 isStreamingRef 卡死分支)主动清理。
    return () => {
      cancelled = true;
      // 切走前立即保留当前已经定稿的 UI 历史。此前缓存只在 loadSession
      // 返回时更新，新完成的轮次会在切回时短暂消失，直到慢 RPC 再次返回。
      const finalized = messagesRef.current.filter(
        (m) => !m.streaming && shouldKeepChatMessage(m),
      );
      if (finalized.length > 0) {
        sessionHistoryCache.set(sessionId, finalized);
      }
    };
  }, [sessionId, hydrationEnabled, syncFromGlobalState]);

  // ── sessionUpdated 监听（compact 等后端操作完成后重载）──
  useEffect(() => {
    return api.onSessionUpdated(async (data: any) => {
      if (data.sessionId !== sessionId) return;
      if (data.type === 'session_compacted') {
        const session = await api.loadSession(sessionId);
        if (session?.messages) {
          const loaded = normalizeMessages(session.messages);
          // ★ 同样防丢：compact 期间 doSend 可能已追加了本地用户消息
          setMessages((prev) => {
            return mergeLoadedWithLocal(sessionId, loaded, prev);
          });
        }
      } else if (data.type === 'context_cleared') {
        // ★ clearSessionContext：清空对话窗口，session 本身不变
        setMessages([]);
        clearSessionHistoryCache(sessionId);
        isStreamingRef.current = false;
        setIsStreaming(false);
      } else if (data.type === 'follow_up_added' && data.message) {
        const followUp = normalizeMessage(data.message);
        // 其他控制端推来的 follow-up 也可能与本端正在返回的 loadSession 交错。
        // 在下一次权威历史确认其 ID 前，保留它相对目标 assistant 的插入位置。
        pendingIdsFor(sessionId).add(followUp.id);
        setMessages((prev) => {
          if (prev.some((message) => message.id === followUp.id)) return prev;
          const beforeIndex = data.beforeMessageId
            ? prev.findIndex((message) => message.id === data.beforeMessageId)
            : -1;
          if (beforeIndex < 0) return [...prev, followUp];
          return [
            ...prev.slice(0, beforeIndex),
            followUp,
            ...prev.slice(beforeIndex),
          ];
        });
      } else if (data.type === 'codex_thread_synced' && !isStreamingRef.current) {
        // Native Codex may have continued this attached thread in another
        // client.  Reload only the already-visible window (at least the normal
        // first page), not the entire potentially multi-megabyte transcript.
        const visibleFinalized = messagesRef.current.filter((message) => !message.streaming);
        const session = await api.loadSession(
          sessionId,
          Math.max(INITIAL_LOAD_LIMIT, visibleFinalized.length),
        );
        if (session?.messages) {
          const loaded = normalizeMessages(session.messages);
          const total = typeof session.messagesTotal === 'number'
            ? session.messagesTotal
            : loaded.length;
          setMessagesTotal(total);
          setHasMore(!!session.hasMore || loaded.length < total);
          sessionHistoryCache.set(sessionId, loaded);
          setMessages((prev) => mergeLoadedWithLocal(sessionId, loaded, prev));
        }
      }
    });
  }, [sessionId]);

  // ── 权限请求监听 ──
  useEffect(() => {
    return api.onPermissionRequest((data: PermissionRequest) => {
      if (data.sessionId !== sessionId) return;
      setPendingPermission(data);
    });
  }, [sessionId]);

  // ── ★ WebSocket 重连后向执行节点核对权威运行态 ──
  useEffect(() => {
    let wasDisconnected = false;
    let cancelled = false;
    const unsubscribe = api.onSessionConnectionStatus(sessionId, (connected) => {
      if (!connected) {
        wasDisconnected = true;
        return;
      }
      // Relay 断开只代表 UI 暂时收不到帧，执行节点上的 CLI 可能仍在继续。
      // 过去这里无条件清成 idle，会直接触发序列队列的下一题，形成双回答。
      if (wasDisconnected && isStreamingRef.current) {
        void (async () => {
          const runState = await api.getSessionRunState(sessionId);
          if (cancelled) return;
          if (runState.status !== 'ok' || runState.busy) {
            console.info('[useChat] reconnected; remote turn is still running');
            return;
          }

          console.info('[useChat] reconnected; remote turn already finished, reloading session');
          const session = await api.loadSession(sessionId);
          if (cancelled) return;
          if (session?.messages) {
            const loaded = normalizeMessages(session.messages);
            setMessages((prev) => {
              return mergeLoadedWithLocal(sessionId, loaded, prev);
            });
          }
          clearStreamState(sessionId);
          isStreamingRef.current = false;
          setIsStreaming(false);
        })();
      }
      wasDisconnected = false;
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

  // ── 流式 delta 监听 ──
  useEffect(() => {
    // 取消挂起的 RAF，立即执行 pendingMsgUpdate（用于终态 done/error）
    const flushNow = () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      const fn = pendingMsgUpdateRef.current;
      pendingMsgUpdateRef.current = null;
      if (fn) fn();
    };

    // 调度一次 RAF 节流渲染：同一帧内多次调用只保留最新的 fn
    const scheduleUpdate = (fn: () => void) => {
      pendingMsgUpdateRef.current = fn;
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          const flush = pendingMsgUpdateRef.current;
          pendingMsgUpdateRef.current = null;
          if (flush) startTransition(flush);
        });
      }
    };

    const unsub = api.onStreamDelta((delta) => {
      // 注意:全局累积已经在 main.tsx 安装的 installGlobalStreamRouter 里完成,
      //      这里只负责把「属于当前活动 session 的」delta 渲染出来。
      if (delta.sessionId !== sessionId) return;

      // ★ 从全局 Map 读最新状态(此刻已被全局路由更新好)
      const state = getStreamState(sessionId);

      // ★ 同步本地 refs（不触发渲染）
      syncFromGlobalState(state);

      const mid = delta.messageId;

      // ★ 流式中间帧：快照当前状态，交给 RAF 节流渲染（≤60fps，不阻塞输入）
      const scheduleStreamingUpdate = (extra: Partial<ChatMessage> = {}) => {
        // 立即快照，避免异步执行时 state 已被下一个 delta 修改
        const snap = {
          text: state.text,
          thinking: state.thinking,
          isStreaming: state.isStreaming,
          toolCalls: [...state.toolCalls],
          contentBlocks: [...state.contentBlocks],
        };
        scheduleUpdate(() => {
          setMessages((prev) => {
            const existing = prev.find(m => m.id === mid);
            if (existing) {
              return prev.map(m =>
                m.id === mid
                  ? buildStreamingMessage(snap as any, { ...m, ...extra })
                  : m
              );
            }
            // ★ 新气泡:snap 里啥可展示的东西都没有(text/thinking/tools/blocks
            //    全空)就别 push,会被渲染成「content='' + streaming=true」的
            //    空插入符幽灵。下一个 delta 进来会再调一次本函数,届时通常
            //    snap 已经有内容,再 push 就不闪了。
            //    这关闭的是「消息切换/瞬切刚好碰上模型起新一条」的那个空窗。
            const hasContent = hasVisibleMessagePayload({
              content: snap.text,
              thinking: snap.thinking,
              toolCalls: snap.toolCalls,
              contentBlocks: snap.contentBlocks,
            });
            if (!hasContent) return prev;
            const newMsg: ChatMessage = {
              id: mid,
              role: 'assistant',
              content: snap.text,
              timestamp: Date.now() / 1000,
              streaming: snap.isStreaming,
              thinking: snap.thinking || undefined,
              toolCalls: snap.toolCalls.length > 0 ? snap.toolCalls : undefined,
              contentBlocks: snap.contentBlocks.length > 0 ? snap.contentBlocks : undefined,
              ...extra,
            };
            return [...prev, newMsg];
          });
        });
      };

      switch (delta.type) {
        case 'text_delta':
        case 'thinking':
        case 'tool_start':
        case 'tool_input':
        case 'tool_result':
        case 'tool_end':
          scheduleStreamingUpdate({ waitingForFirstDelta: false });
          break;

        case 'done': {
          // 终态：先把挂起的中间帧冲掉，再立即渲染最终结果
          flushNow();

          const finalText = state.text;
          const finalThinking = state.thinking || undefined;
          const finalToolCalls = state.toolCalls.length > 0 ? [...state.toolCalls] : undefined;
          const finalBlocks = state.contentBlocks.length > 0 ? [...state.contentBlocks] : undefined;
          const finalElapsed = state.streamStart ? Date.now() - state.streamStart : undefined;
          const hasFinalPayload = hasVisibleMessagePayload({
            content: finalText,
            thinking: finalThinking,
            toolCalls: finalToolCalls,
            contentBlocks: finalBlocks,
          });

          const sessionState = getStreamState(sessionId);
          sessionState.text = finalText;
          sessionState.thinking = finalThinking || '';
          sessionState.toolCalls = finalToolCalls || [];
          sessionState.contentBlocks = finalBlocks || [];
          sessionState.isStreaming = false;

          setMessages((prev) => {
            // 中断、异常或空响应可能只留下等待占位。耗时/时间戳不是回复内容，
            // 终态没有任何正文、思考或工具时直接移除，不能定稿为空气泡。
            if (!hasFinalPayload) {
              return prev.filter((m) => m.id !== mid);
            }
            // 兜底:assistant 气泡不再有占位 push,如果整个流程没产生任何
            // 有内容的 delta 就到 done,prev 里找不到这条消息,需要在这里
            // 把它补上,否则 final 内容会丢。
            if (!prev.some((m) => m.id === mid)) {
              return [
                ...prev,
                {
                  id: mid,
                  role: 'assistant',
                  content: finalText,
                  thinking: finalThinking,
                  toolCalls: finalToolCalls,
                  contentBlocks: finalBlocks,
                  streaming: false,
                  waitingForFirstDelta: false,
                  elapsed: finalElapsed,
                  timestamp: Date.now() / 1000,
                  backendId,
                  ...(delta.usage ? { usage: delta.usage } : {}),
                },
              ];
            }
            return prev.map((m) => {
              if (m.id !== mid) return m;
              return {
                ...m,
                content: finalText,
                thinking: finalThinking,
                toolCalls: finalToolCalls,
                contentBlocks: finalBlocks,
                streaming: false,
                waitingForFirstDelta: false,
                elapsed: finalElapsed,
                ...(delta.usage ? { usage: delta.usage } : {}),
              };
            });
          });
          isStreamingRef.current = false;
          setIsStreaming(false);
          break;
        }

        case 'error': {
          flushNow();

          // error 只是本轮中的诊断帧。远端 Codex / Relay 可能报告一次可恢复
          // 的传输错误后继续同一个 turn；只有随后明确到达的 done 才是终态。
          const errText = state.text;
          const errThinking = state.thinking || undefined;
          const errToolCalls = state.toolCalls.length > 0 ? [...state.toolCalls] : undefined;
          const errBlocks = state.contentBlocks.length > 0 ? [...state.contentBlocks] : undefined;
          const errElapsed = state.streamStart ? Date.now() - state.streamStart : undefined;
          const hasErrorPayload = hasVisibleMessagePayload({
            content: errText,
            thinking: errThinking,
            toolCalls: errToolCalls,
            contentBlocks: errBlocks,
          });

          setMessages((prev) => {
            // 可恢复 error 不等于终态。如果还没有任何可见内容，保留原来的
            // “等待首帧”状态即可；不要把它降级成只有光标/耗时的空气泡。
            if (!hasErrorPayload) return prev;
            if (!prev.some((m) => m.id === mid)) {
              return [
                ...prev,
                {
                  id: mid,
                  role: 'assistant',
                  content: errText,
                  thinking: errThinking,
                  toolCalls: errToolCalls,
                  contentBlocks: errBlocks,
                  streaming: true,
                  waitingForFirstDelta: false,
                  elapsed: errElapsed,
                  timestamp: Date.now() / 1000,
                  backendId,
                },
              ];
            }
            return prev.map((m) =>
              m.id === mid
                ? {
                    ...m,
                    content: errText,
                    thinking: errThinking,
                    toolCalls: errToolCalls,
                    contentBlocks: errBlocks,
                    streaming: true,
                    waitingForFirstDelta: false,
                    elapsed: errElapsed,
                  }
                : m
            );
          });
          isStreamingRef.current = true;
          setIsStreaming(true);
          break;
        }
      }
    });

    return () => {
      unsub();
      // 组件卸载时取消挂起的 RAF，防止内存泄漏
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      pendingMsgUpdateRef.current = null;
    };
  }, [sessionId, syncFromGlobalState]);

  // ── 添加系统消息（纯前端） ──
  const addSystemMessage = useCallback((content: string) => {
    const msg: ChatMessage = {
      id: uuid(),
      role: 'system',
      content,
      timestamp: Date.now() / 1000,
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  // ★ streaming 结束后自动发送 pending 消息（用户在流式进行中提交的中断续发）
  useEffect(() => {
    if (isStreaming) return;
    if (!pendingMessageRef.current) return;
    const pending = pendingMessageRef.current;
    pendingMessageRef.current = null;
    // 用 setTimeout(0) 确保在当前 React 批次渲染完成后再发，避免和 done 处理竞争
    setTimeout(() => {
      if (!isStreamingRef.current) {
        doSendRef.current(pending.content, pending.images, pending.textAttachments);
      }
    }, 0);
  }, [isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 核心发送逻辑（不含斜杠命令判断） ──
  const doSend = useCallback(
    (
      content: string,
      images?: ImageAttachment[],
      textAttachments?: TextAttachment[],
      deliveryMode?: 'steer' | 'redirect',
      interactionMode?:
        | 'realtime-voice'
        | 'realtime-voice-foreground'
        | 'realtime-voice-background',
      kitApprovalDelegation: boolean = false,
    ) => {
      if (isStreamingRef.current) return;

      const userMsg: ChatMessage = {
        id: uuid(),
        role: 'user',
        content,
        images,
        textAttachments,
        deliveryMode,
        timestamp: Date.now() / 1000,
      };
      const assistantId = uuid();
      const pendingIds = pendingIdsFor(sessionId);
      pendingIds.add(userMsg.id);
      pendingIds.add(assistantId);

      // 发送瞬间就展示明确的 Thinking 状态。它不是伪造的思考文本，也不会
      // 写入历史；首个 thinking / text / tool delta 到达后会原位替换。
      const waitingMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: Date.now() / 1000,
        streaming: true,
        waitingForFirstDelta: true,
      };
      setMessages((prev) => [...prev, userMsg, waitingMsg]);
      isStreamingRef.current = true;
      setIsStreaming(true);

      // ★ 初始化全局流式状态（会自动清理之前的错误状态）
      initStreamMessage(sessionId, assistantId);

      // ★ 同步本地 refs
      textRef.current = '';
      thinkingRef.current = '';
      toolCallsRef.current = [];
      contentBlocksRef.current = [];
      streamStartRef.current = Date.now();
      msgIdRef.current = assistantId;

      api.sendMessage({
        sessionId,
        content,
        images,
        textAttachments,
        backendId,
        userMessageId: userMsg.id,
        messageId: assistantId,
        autoContinue: autoContinueRef.current,
        skipPermissions: skipPermissionsRef.current,
        deliveryMode,
        interactionMode,
        kitApprovalDelegation,
      });
    },
    [sessionId, backendId]
  );

  // 稳定 ref 给命令处理器调用
  const doSendRef = useRef(doSend);
  doSendRef.current = doSend;
  const addSystemMessageRef = useRef(addSystemMessage);
  addSystemMessageRef.current = addSystemMessage;

  // ═══════════════════════════════════════
  //  ★ 斜杠命令处理器
  // ═══════════════════════════════════════
  const handleCommand = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      const spaceIdx = trimmed.indexOf(' ');
      const command = (spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
      const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

      const sys = (msg: string) => addSystemMessageRef.current(msg);

      switch (command) {
        // ── 帮助 ──
        case '/help':
          sys(HELP_TEXT);
          break;

        // ── 清空上下文（同 session，重置 agent 下游 session）──
        case '/new':
          if (onClearContext) {
            onClearContext();
          } else if (onNewSession) {
            onNewSession();  // 降级兼容
          } else {
            sys('⚠️ 无法清空上下文：未注册 onClearContext 回调。');
          }
          break;

        // ── 清空 ──
        case '/clear':
          setMessages([]);
          clearStreamState(sessionId);
          clearSessionHistoryCache(sessionId);
          await api.executeCommand({ command: 'clear', sessionId, backendId });
          sys('🗑️ 对话已清空。');
          break;

        // ── 压缩 ──
        case '/compact': {
          const msgs = messagesRef.current;
          if (msgs.length <= 6) {
            sys('ℹ️ 消息数量较少，无需压缩。');
            break;
          }
          sys('⏳ 正在压缩对话...');
          const result = await api.executeCommand({
            command: 'compact',
            sessionId,
            backendId,
          });
          if (result?.status === 'ok') {
            // ★ 直接从后端重载消息，不依赖 sessionUpdated 事件
            const session = await api.loadSession(sessionId);
            if (session?.messages) {
              const reloaded = normalizeMessages(session.messages);
              // 追加一条系统消息告知用户
              const sysMsg: ChatMessage = {
                id: uuid(),
                role: 'system' as const,
                content: `✅ 已压缩 ${result.removed} 条早期消息，保留最近 ${result.remaining} 条。`,
                timestamp: Date.now() / 1000,
              };
              setMessages([...reloaded, sysMsg]);
            }
          } else {
            sys(`ℹ️ ${result?.message || '压缩未执行'}`);
          }
          break;
        }

        // ── 费用统计 ──
        case '/cost': {
          const usage = await api.getSessionTokenUsage(sessionId);
          const totalInput = Number(usage?.inputTokens || 0);
          const totalOutput = Number(usage?.outputTokens || 0);
          const total = totalInput + totalOutput;
          const actualTurns = Number(usage?.actualTurns || 0);
          const estimatedTurns = Number(usage?.estimatedTurns || 0);
          const contextTokens = Number(usage?.latestContext?.contextTokens || 0);
          const contextWindow = Number(usage?.latestContext?.contextWindow || 0);
          const contextLine = contextTokens && contextWindow
            ? `\n\n当前上下文：**${Math.round(contextTokens / contextWindow * 100)}%**（${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()}）`
            : '';
          sys(
            `📊 **当前 Session Token 总览**\n\n` +
            `| 方向 | Tokens |\n` +
            `|------|--------|\n` +
            `| ↑ 输入 | ${totalInput.toLocaleString()} |\n` +
            `| ↓ 输出 | ${totalOutput.toLocaleString()} |\n` +
            `| **累计** | **${total.toLocaleString()}** |` +
            contextLine + `\n\n` +
            `_精确 usage ${actualTurns} 轮，文本估算 ${estimatedTurns} 轮。会话可能跨 Backend / 模型，未用单一模型价格制造误导性费用。_`
          );
          break;
        }

        // ── 状态 ──
        case '/status': {
          const msgs = messagesRef.current;
          const userCount = msgs.filter((m) => m.role === 'user').length;
          const assistantCount = msgs.filter((m) => m.role === 'assistant').length;
          sys(
            `📋 **会话状态**\n\n` +
            `- 会话 ID: \`${sessionId}\`\n` +
            `- 后端: \`${backendId}\`\n` +
            `- 消息数: ${msgs.length}（用户 ${userCount} / 助手 ${assistantCount}）\n` +
            `- 自动续跑: ${autoContinueRef.current ? '✅ 开启' : '❌ 关闭'}\n` +
            `- 流式状态: ${isStreamingRef.current ? '🔄 进行中' : '⏸️ 空闲'}`
          );
          break;
        }

        // ── 继续 ──
        case '/continue':
          if (isStreamingRef.current) {
            sys('⚠️ 当前正在响应中，请等待完成。');
            break;
          }
          doSendRef.current(
            'Continue exactly from where you left off. Do not repeat any content you already generated.'
          );
          break;

        // ── 自动续跑开关 ──
        case '/autocontinue': {
          const newVal = !autoContinueRef.current;
          setAutoContinue(newVal);
          sys(`⟳ 自动续跑已${newVal ? '**开启**' : '**关闭**'}。\n\n_开启后，当模型因 token 上限中断时会自动继续生成。_`);
          break;
        }

        // ── 模型信息 ──
        case '/model': {
          const available = backends || await api.getBackends();
          const current = available.find((b: any) => b.id === backendId);
          if (current) {
            const model = sessionRuntime?.modelOverride || current.model || current.env?.OPENAI_MODEL || '默认';
            const effort = sessionRuntime?.reasoningEffort || '默认';
            sys(
              `🤖 **当前模型**\n\n` +
              `- 后端: ${current.label}\n` +
              `- 模型: ${model}\n` +
              (current.type === 'codex-office' ? `- 推理档位: ${effort}\n` : '') +
              `- 类型: ${current.type}`
            );
          } else {
            sys(`⚠️ 未找到后端配置: ${backendId}`);
          }
          break;
        }

        // ── 初始化项目 ──
        case '/init':
          if (isStreamingRef.current) {
            sys('⚠️ 当前正在响应中，请等待完成。');
            break;
          }
          sys('⏳ 正在让 Claude 分析项目并创建 CLAUDE.md...');
          doSendRef.current(
            'Please analyze this project directory thoroughly and create a CLAUDE.md file at the project root. ' +
            'The file should include: project overview, tech stack, directory structure, ' +
            'build/test/run commands, coding conventions, and any important notes for AI assistants working on this codebase. ' +
            'Use the available file tools to explore the project first, then write the file.'
          );
          break;

        // ── 显示配置 ──
        case '/config': {
          const backends = await api.getBackends();
          const current = backends.find((b: any) => b.id === backendId);
          sys(
            `⚙️ **当前配置**\n\n\`\`\`json\n${JSON.stringify(current || {}, null, 2)}\n\`\`\``
          );
          break;
        }

        // ── /commit — AI 生成 commit message 并提交 ──
        case '/commit': {
          const session = await api.loadSession(sessionId);
          const wd = session?.workingDir;
          const ek = session?.execKey;
          if (!wd) { sys('⚠️ 当前会话没有工作目录。'); break; }
          // 检测 Git 仓库
          const detect = await api.gitDetect(wd, ek).catch(() => null);
          if (!detect?.isRepo) { sys('⚠️ 工作目录不是 Git 仓库。'); break; }
          // 检查有无改动
          const status = await api.gitStatus(wd, ek).catch(() => null);
          if (!status || status.totalChanges === 0) { sys('✅ 工作区干净，无需提交。'); break; }
          // 先暂存所有改动
          const unstaged = status.files.filter((f: any) => !f.staged).map((f: any) => f.path);
          if (unstaged.length > 0) {
            await api.gitStage(wd, unstaged, ek);
          }
          sys('🔄 正在让 AI 生成 commit message...');
          // 监听 AI 生成结果
          let resolved = false;
          const unsub = api.onGitCommitMsgReady(async (data: any) => {
            if (resolved || data.workingDir !== wd) return;
            resolved = true;
            const msg = data.message || data.error;
            if (data.error) {
              sys(`❌ AI 生成失败：${data.error}`);
              return;
            }
            // 自动提交
            try {
              const res = await api.gitCommit(wd, msg, false, ek);
              if (res.status === 'ok') {
                sys(`✅ **已提交** \`${res.commitHash}\`\n\n${msg}\n\n_${res.filesChanged} files, +${res.insertions} −${res.deletions}_`);
              } else {
                sys(`❌ 提交失败：${res.message || 'unknown'}`);
              }
            } catch (e: any) {
              sys(`❌ 提交异常：${e?.message || e}`);
            }
          });
          // 触发 AI 生成
          await api.gitGenerateCommitMessage(wd, true, ek, backendId).catch((e: any) => {
            if (!resolved) { resolved = true; sys(`❌ AI 生成失败：${e?.message || e}`); }
          });
          // 30s 超时
          setTimeout(() => { unsub(); }, 35000);
          break;
        }

        // ── /git — Git 操作 ──
        case '/git': {
          const session = await api.loadSession(sessionId);
          const wd = session?.workingDir;
          const ek = session?.execKey;
          if (!wd) { sys('⚠️ 当前会话没有工作目录。'); break; }
          const detect = await api.gitDetect(wd, ek).catch(() => null);
          if (!detect?.isRepo) { sys('⚠️ 工作目录不是 Git 仓库。'); break; }
          const sub = args.toLowerCase();

          if (sub === 'status' || sub === '') {
            const status = await api.gitStatus(wd, ek).catch(() => null);
            if (!status) { sys('⚠️ 获取 Git 状态失败。'); break; }
            const STATUS_ICON: Record<string, string> = {
              modified: '🟡', added: '🟢', deleted: '🔴', renamed: '🟣', untracked: '⚪', conflicted: '⚠️', copied: '🟣',
            };
            let text = `🔀 **Git Status** — \`${status.branch}\``;
            if (status.ahead > 0) text += ` ⬆${status.ahead}`;
            if (status.behind > 0) text += ` ⬇${status.behind}`;
            text += `\n\n共 ${status.totalChanges} 个改动（${status.stagedCount} 已暂存）\n\n`;
            if (status.files.length === 0) {
              text += '✅ 工作区干净';
            } else {
              text += status.files.map((f: any) => `${f.staged ? '✅' : '⬜'} ${STATUS_ICON[f.status] || '•'} ${f.path}`).join('\n');
            }
            sys(text);
            break;
          }

          if (sub === 'log') {
            const res = await api.gitLog(wd, 10, 0, ek).catch(() => null);
            if (!res || res.commits.length === 0) { sys('📜 无提交记录。'); break; }
            const lines = res.commits.map((c: any) =>
              `\`${c.shortHash}\` ${c.message} — *${c.author}*, ${new Date(c.date).toLocaleDateString()}`
            );
            sys(`📜 **最近提交**\n\n${lines.join('\n')}`);
            break;
          }

          if (sub === 'push') {
            sys('⏳ 正在 push...');
            const res = await api.gitPush(wd, 'origin', '', false, ek).catch((e: any) => ({ status: 'error', output: '', message: e?.message || String(e) }));
            sys(res.status === 'ok' ? '✅ **Push 成功**' : `❌ Push 失败：${res.message || res.output}`);
            break;
          }

          if (sub === 'pull') {
            sys('⏳ 正在 pull...');
            const res = await api.gitPull(wd, 'origin', '', false, ek).catch((e: any) => ({ status: 'error', output: '', message: e?.message || String(e) }));
            sys(res.status === 'ok' ? '✅ **Pull 成功**' : `❌ Pull 失败：${res.message || res.output}`);
            break;
          }

          // 无参数或未知子命令：显示帮助
          sys('🔧 **Git 命令**\n\n| 命令 | 说明 |\n|------|------|\n| `/git status` | 查看文件状态 |\n| `/git log` | 查看最近 10 条提交 |\n| `/git push` | 推送到远端 |\n| `/git pull` | 从远端拉取 |\n| `/commit` | AI 生成 commit message 并提交 |');
          break;
        }

        // ── 未知命令 ──
        default:
          sys(`❓ 未知命令: \`${command}\`\n\n输入 \`/help\` 查看可用命令。`);
          break;
      }
    },
    [sessionId, backendId, backends, sessionRuntime?.modelOverride, sessionRuntime?.reasoningEffort]
  );

  // ── 公开的 sendMessage（含斜杠命令拦截）──
  const sendMessage = useCallback(
    async (
      content: string,
      images?: ImageAttachment[],
      textAttachments?: TextAttachment[],
      kitApprovalDelegation: boolean = false,
    ) => {
      if (
        !content.trim()
        && (!images || images.length === 0)
        && (!textAttachments || textAttachments.length === 0)
      ) return;

      if (isStreamingRef.current) {
        if (kitApprovalDelegation) {
          addSystemMessage('本次 Kit 委托未发送：当前轮仍在执行，请结束后重新勾选并发送。');
          return;
        }
        // ★ 流式进行中：斜杠命令不中断，普通消息入队并中止当前响应
        if (content.trim().startsWith('/') && !textAttachments?.length) return;
        pendingMessageRef.current = { content, images, textAttachments };
        api.abortMessage(sessionId);
        return;
      }

      // ★ 斜杠命令拦截
      if (content.trim().startsWith('/') && !textAttachments?.length) {
        await handleCommand(content);
        return;
      }

      doSend(content, images, textAttachments, undefined, undefined, kitApprovalDelegation);
    },
    [doSend, handleCommand, sessionId, addSystemMessage]
  );

  const abort = useCallback(() => {
    // ★ 按 sessionId 停止，精确定位到当前 session，不影响其他并发 session
    pendingMessageRef.current = null; // 手动停止时清除 pending，不续发
    api.abortMessage(sessionId);
    isStreamingRef.current = false;
    setIsStreaming(false);
  }, [sessionId]);

  // ── 翻页:拉一批更老的消息往 messages 前面 prepend ──
  //   chunk: 这次想拉多少条;默认 EARLIER_CHUNK。
  //   offset 自动算: total - 当前已加载条数 - chunk(向 0 截断)。
  //   注意只算「定稿」消息——流式 tail 不计入已加载数,否则刚好 send 一条新
  //   消息后 loadEarlier 会少算 1,造成重复。
  const loadEarlier = useCallback(
    async (chunk: number = EARLIER_CHUNK): Promise<void> => {
      if (!sessionId || !hasMore || loadingEarlier) return;
      // 当前 messages 里非 streaming 的数量 = 已经从磁盘加载的「定稿」数
      const loadedCount = messages.filter((m) => !m.streaming).length;
      const total = messagesTotal;
      const remaining = total - loadedCount;
      if (remaining <= 0) {
        setHasMore(false);
        return;
      }
      const take = Math.min(chunk, remaining);
      const offset = Math.max(0, total - loadedCount - take);
      setLoadingEarlier(true);
      try {
        const resp = await api.loadSessionMessages(sessionId, offset, take);
        if (!resp || !Array.isArray(resp.messages)) return;
        const olderNormalized = normalizeMessages(resp.messages);
        setMessages((prev) => {
          // 去重:已加载的消息 id 集合
          const have = new Set(prev.map((m) => m.id));
          const fresh = olderNormalized.filter((m: ChatMessage) => !have.has(m.id));
          const next = [...fresh, ...prev];
          // 同步更新缓存,下次切回来就能秒出
          sessionHistoryCache.set(
            sessionId,
            next.filter((m: ChatMessage) => !m.streaming),
          );
          return next;
        });
        const newLoadedCount = loadedCount + olderNormalized.length;
        const newRemaining = total - newLoadedCount;
        setHasMore(newRemaining > 0);
      } finally {
        setLoadingEarlier(false);
      }
    },
    [sessionId, hasMore, loadingEarlier, messages, messagesTotal],
  );

  return {
    messages, isStreaming, sendMessage, abort, autoContinue, setAutoContinue,
    pendingPermission, clearPermission: () => setPendingPermission(null),
    // 历史分页
    messagesTotal, hasMore, loadingEarlier, loadEarlier,
    isLoadingSession,
    resolvedSessionId,
    hydratedSessionId,
    // ★ 序列任务直接派发用：跳过斜杠命令拦截，仅在非流式时发送（doSend 自带 isStreaming 守卫）
    doSend,
  };
}
