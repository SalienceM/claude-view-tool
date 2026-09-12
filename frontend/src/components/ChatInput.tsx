import React, { useRef, useCallback, useEffect, useLayoutEffect, memo, useState, useMemo } from 'react';
import { ImagePreview } from './ImagePreview';
import { TextAttachmentPreview } from './TextAttachmentPreview';
import { useClipboardImage } from '../hooks/useClipboardImage';
import type { ImageAttachment } from '../hooks/useClipboardImage';
import type { TextAttachment, TextAttachmentSource } from '../types/attachments';
import { SLASH_COMMANDS } from '../hooks/useChat';
import type { SlashCommand } from '../hooks/useChat';
import { api, isTauri } from '../api';
import { RealtimeVoiceBar } from './RealtimeVoiceBar';
import type { RealtimeVoiceInteractionMode } from '../utils/realtimeVoice';
import { uuid } from '../utils/uuid';
import {
  BackendRuntimeFields,
  formatRuntimeLabel,
  isRuntimeConfigurableBackend,
  normalizeModelRuntime,
  type ModelRuntime,
} from './CodexRuntimeFields';

// Pane 会在不同 session 间复用，且普通对话/Loop 面板切换时输入组件会卸载。
// 草稿必须以 session 为键独立保存，不能只放在 textarea DOM 或组件 state 中。
interface InputDraft {
  text: string;
  textAttachments: TextAttachment[];
}

const sessionInputDrafts = new Map<string, InputDraft>();
const LARGE_PASTE_ATTACHMENT_CHARS = 4_000;
const LONG_INPUT_ATTACHMENT_CHARS = 6_000;
const MAX_PICKED_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_ACCEPT = [
  'image/*', 'text/*',
  '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml',
  '.csv', '.tsv', '.log', '.ini', '.cfg', '.conf', '.env',
  '.py', '.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.go', '.rs', '.sh', '.ps1', '.bat', '.sql', '.graphql', '.gql', '.proto',
].join(',');
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml',
  'csv', 'tsv', 'log', 'ini', 'cfg', 'conf', 'env',
  'py', 'js', 'jsx', 'ts', 'tsx', 'java', 'c', 'cc', 'cpp', 'h', 'hpp',
  'go', 'rs', 'sh', 'ps1', 'bat', 'sql', 'graphql', 'gql', 'proto',
]);
const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  'application/json', 'application/ld+json', 'application/xml',
  'application/yaml', 'application/x-yaml', 'application/toml',
  'application/javascript', 'application/sql', 'application/graphql',
]);
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', bmp: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp', gif: 'image/gif',
};

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isImageAttachmentFile(file: File): boolean {
  return file.type.toLowerCase().startsWith('image/')
    || Boolean(IMAGE_MIME_BY_EXTENSION[fileExtension(file.name)]);
}

function isTextAttachmentFile(file: File): boolean {
  const mime = file.type.toLowerCase().split(';', 1)[0];
  const name = file.name.toLowerCase();
  return mime.startsWith('text/')
    || TEXT_ATTACHMENT_MIME_TYPES.has(mime)
    || TEXT_ATTACHMENT_EXTENSIONS.has(fileExtension(name))
    || /^(readme|license|dockerfile|makefile|gemfile|rakefile)(\..*)?$/.test(name);
}

function readImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma < 0) {
        reject(new Error(`无法读取 ${file.name}`));
        return;
      }
      const extension = fileExtension(file.name);
      resolve({
        id: uuid(),
        base64: dataUrl.slice(comma + 1),
        mime_type: file.type || IMAGE_MIME_BY_EXTENSION[extension] || 'image/png',
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

// ── 注入全局样式（focus glow）────────────────────────────────────────────────
if (typeof document !== 'undefined' && !document.getElementById('chat-input-css')) {
  const s = document.createElement('style');
  s.id = 'chat-input-css';
  s.textContent = `
    .chat-textarea {
      transition: border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .chat-textarea:focus {
      border-color: var(--theme-accent, #0969da) !important;
      box-shadow: 0 0 0 3px var(--theme-accent-bg, rgba(9,105,218,0.15)) !important;
    }
    @keyframes chat-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.4; }
    }
    @keyframes dialogSlideIn {
      from { opacity: 0; transform: perspective(900px) rotateX(-14deg) scale(0.96) translateY(-8px); }
      to   { opacity: 1; transform: perspective(900px) rotateX(0deg)   scale(1)    translateY(0); }
    }
    @keyframes mic-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(248,81,73,0.5); }
      50% { box-shadow: 0 0 0 10px rgba(248,81,73,0); }
    }
  `;
  document.head.appendChild(s);
}

type FileEntry = { name: string; path: string; isDir: boolean };

interface Props {
  onSend: (
    content: string,
    images?: ImageAttachment[],
    textAttachments?: TextAttachment[],
    kitApprovalDelegation?: boolean,
  ) => void;
  onAbort: () => void;
  isStreaming: boolean;
  backends: any[];
  activeBackendId: string;
  sessionId?: string;
  workingDir?: string;
  skipPermissions?: boolean;
  onSkipPermissionsChange?: (enabled: boolean) => void;
  isMobile?: boolean;
  // ── 序列任务：回答进行中或已有排队时，新输入自动进入队列 ──
  onQueueTask?: (
    content: string,
    images?: ImageAttachment[],
    textAttachments?: TextAttachment[],
  ) => void;
  seqCount?: number;
  onCompact?: () => void;
  fontSize?: number;                         // 当前对话字号(用于 A−/A+ 显示)
  onAdjustFontSize?: (delta: number) => void; // 步进对话字号
  // 多 pane 场景:用来决定全局快捷键(截图等)归哪个输入框处理。
  // 单 pane / 浏览器单实例下不传也行,默认 true。
  isFocused?: boolean;
  // ── Git 集成（execKey/execMode 用于 FileTreePanel 侧 Git 操作）──
  execKey?: string;
  execMode?: 'local' | 'relay';
  sessionRuntime?: ModelRuntime;
  onSessionRuntimeChange?: (runtime: ModelRuntime) => Promise<{ status: string; message?: string }>;
  // 自动实时语音对话占用麦克风/STT 时，关闭这里的单次听写入口。
  voiceConversationActive?: boolean;
  realtimeVoice?: {
    sessionId: string;
    backendLabel: string;
    voice: string;
    rate: number;
    turnEndSilenceMs?: number;
    continuousWindowMs?: number;
    wakeWord?: string;
    ttsEngine?: 'system' | 'edge' | 'dashscope';
    systemVoice?: string;
    dashscopeModel?: string;
    dashscopeVoice?: string;
    vadThreshold?: number;
    bargeIn?: boolean;
    onSend: (text: string, interactionMode: RealtimeVoiceInteractionMode) => void;
    onActiveChange?: (active: boolean) => void;
  };
}

// ═══════════════════════════════════════
//  ★ 工具栏按钮组件
// ═══════════════════════════════════════
interface ToolbarBtnProps {
  icon: string;
  title: string;
  active?: boolean;
  onClick?: () => void;
  loading?: boolean;
  compact?: boolean;   // 移动端:只显示图标,隐藏文字标签(整排不再撑成好几行)
}

const ToolbarBtn: React.FC<ToolbarBtnProps> = ({ icon, title, active, onClick, loading, compact }) => {
  const [isHover, setIsHover] = React.useState(false);
  return (
    <button
      onClick={onClick}
      disabled={loading}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseEnter={() => setIsHover(true)}
      onMouseLeave={() => setIsHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 0 : 4,
        padding: compact ? '5px 9px' : '4px 8px',
        fontSize: 11,
        borderRadius: 5,
        border: active ? '1px solid var(--theme-accent, #0969da)' : '1px solid var(--theme-border, rgba(0,0,0,0.12))',
        background: active ? 'var(--theme-accent-bg, rgba(9,105,218,0.1))' : isHover ? 'var(--theme-bg-tertiary, #eaeef2)' : 'var(--theme-bg-secondary, #f6f8fa)',
        color: active ? 'var(--theme-accent, #0969da)' : isHover ? 'var(--theme-text, #1f2328)' : 'var(--theme-text-muted, #656d76)',
        cursor: loading ? 'wait' : 'pointer',
        transition: 'all 0.15s',
        whiteSpace: 'nowrap',
        opacity: loading ? 0.6 : 1,
      }}
    >
      <span style={{ fontSize: compact ? 14 : 12 }}>{icon}</span>
    </button>
  );
};

const ChatInputInner: React.FC<Props> = ({
  onSend, onAbort, isStreaming, backends, activeBackendId, sessionId, workingDir,
  skipPermissions = true, onSkipPermissionsChange,
  isMobile = false,
  onQueueTask, seqCount = 0,
  onCompact,
  fontSize, onAdjustFontSize,
  isFocused = true,
  execKey,
  sessionRuntime,
  onSessionRuntimeChange,
  voiceConversationActive = false,
  realtimeVoice,
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentNoticeTimerRef = useRef<number | null>(null);
  // 把 textarea ref 传给 useClipboardImage,这样多 pane 场景下只有聚焦
  // 的输入框对应的 hook 会处理粘贴,避免一张图被所有 pane 同时吃下。
  const { images, removeImage, clearImages, addImage } = useClipboardImage(ref);
  const [textAttachments, setTextAttachments] = useState<TextAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState('');
  const [kitApprovalDelegation, setKitApprovalDelegation] = useState(false);
  const kitApprovalDelegationRef = useRef(false);
  kitApprovalDelegationRef.current = kitApprovalDelegation;
  useEffect(() => {
    setKitApprovalDelegation(false);
    kitApprovalDelegationRef.current = false;
  }, [sessionId, activeBackendId, isStreaming, seqCount]);
  const textAttachmentsRef = useRef<TextAttachment[]>([]);
  textAttachmentsRef.current = textAttachments;

  // 截图按钮状态:正在等待用户选区域 / 已超时
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const screenshotBusyRef = useRef(false);

  // 调起系统截图工具 → 等图片落进剪贴板 → 走既有粘贴流程加入附件。
  // 桌面端独占——浏览器无法触发系统截图工具。
  const handleScreenshot = useCallback(async () => {
    if (!isTauri()) return;
    // ref 在首个 await 之前同步上锁，避免全局热键连按时 React 状态尚未刷新，
    // 同时拉起多个系统截图浮层。
    if (screenshotBusyRef.current) return;
    screenshotBusyRef.current = true;
    setScreenshotBusy(true);
    try {
      const mod = await import('@tauri-apps/api/core');
      // 记一下点击前剪贴板里现成的那张图(如果有),用 base64 前缀做去重
      // key,避免后面把「旧图」误认成新截图加入附件。
      let beforeKey = '';
      try {
        const before = await api.readClipboardImage();
        if (before?.base64) beforeKey = before.base64.slice(0, 200);
      } catch { /* 读取失败不阻止截图 */ }

      await mod.invoke('open_screenshot_tool');

      // 只在用户主动发起截图后短期轮询剪贴板。误触被上层全屏保护拦截，
      // 这里也不会因为连按而叠加多个轮询循环。
      const start = Date.now();
      const POLL_INTERVAL = 500;
      const TIMEOUT = 60_000;
      while (Date.now() - start < TIMEOUT) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        try {
          const img = await api.readClipboardImage();
          if (img && img.base64 && img.base64.slice(0, 200) !== beforeKey) {
            addImage(img);
            break;
          }
        } catch { /* 单次失败继续轮询 */ }
      }
    } catch (e) {
      console.error('[screenshot] capture flow failed:', e);
    } finally {
      screenshotBusyRef.current = false;
      setScreenshotBusy(false);
    }
  }, [addImage]);

  // 全局快捷键(App.tsx 注册 Ctrl+Shift+A)触发时,每个 pane 的 ChatInput
  // 都会收到事件,只有焦点 pane 那一个真正去截图——其它静默。用 ref 拿最新
  // 的 isFocused / handleScreenshot,避免闭包问题。
  const focusedRef = useRef(isFocused);
  focusedRef.current = isFocused;
  const screenshotFnRef = useRef(handleScreenshot);
  screenshotFnRef.current = handleScreenshot;
  useEffect(() => {
    if (!isTauri()) return;
    const onHotkey = () => {
      if (focusedRef.current) screenshotFnRef.current();
    };
    window.addEventListener('awu:screenshot-hotkey', onHotkey);
    return () => window.removeEventListener('awu:screenshot-hotkey', onHotkey);
  }, []);

  // ── 稳定 refs ──
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onQueueTaskRef = useRef(onQueueTask);
  onQueueTaskRef.current = onQueueTask;
  const seqCountRef = useRef(seqCount);
  seqCountRef.current = seqCount;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const clearImagesRef = useRef(clearImages);
  clearImagesRef.current = clearImages;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const composingRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const textareaHeightCappedRef = useRef(false);

  const scheduleTextareaResize = useCallback((force = false) => {
    if (!force && textareaHeightCappedRef.current) return;
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      const el = ref.current;
      if (!el) return;
      el.style.height = 'auto';
      const scrollHeight = el.scrollHeight;
      const nextHeight = Math.min(scrollHeight, 200);
      el.style.height = `${nextHeight}px`;
      textareaHeightCappedRef.current = scrollHeight >= 200;
    });
  }, []);

  useEffect(() => () => {
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
    }
  }, []);

  // ═══════════════════════════════════════
  //  ★ 输入历史（Linux 风格 ↑↓ 浏览，最多 10 条）
  // ══════════════════════════════════════
  // 历史条目 & 当前浏览位置（-1 = 未进入浏览模式）
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  // 进入浏览模式时，暂存用户当时正在输入的草稿，退出时恢复
  const draftRef = useRef('');

  // 每会话独立：sessionId 变化时自动重置
  useEffect(() => {
    setHistory([]);
    setHistIdx(-1);
    draftRef.current = '';
  }, [sessionId]);

  // 稳定 refs，供 keydown 里同步读取
  const historyRef = useRef<string[]>([]);
  historyRef.current = history;
  const histIdxRef = useRef(-1);
  histIdxRef.current = histIdx;

  // 追加一条到历史（去重 + 最多 10 条，最新的在末尾）
  const pushHistory = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setHistory(prev => {
      // 与最近一条重复则不追加（避免连续发送相同内容撑爆历史）
      if (prev.length > 0 && prev[prev.length - 1] === t) return prev;
      const next = [...prev, t];
      return next.length > 10 ? next.slice(next.length - 10) : next;
    });
    setHistIdx(-1); // 发送后退出浏览模式
  }, []);

  // ═══════════════════════════════════════
  //  ★ 斜杠命令自动补全状态
  // ═══════════════════════════════════════
  const [showCommands, setShowCommands] = useState(false);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const popupRef = useRef<HTMLDivElement>(null);

  // 稳定 refs for keyboard handler
  const showCommandsRef = useRef(false);
  showCommandsRef.current = showCommands;
  const filteredCommandsRef = useRef<SlashCommand[]>([]);
  filteredCommandsRef.current = filteredCommands;
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = selectedIndex;

  // ═══════════════════════════════════════
  //  ★ @ 文件选择器状态
  // ═══════════════════════════════════════
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [fileSelectedIndex, setFileSelectedIndex] = useState(0);
  const [currentDir, setCurrentDir] = useState('');
  const [fileQuery, setFileQuery] = useState('');
  const filePopupRef = useRef<HTMLDivElement>(null);

  const showFilePickerRef = useRef(false);
  showFilePickerRef.current = showFilePicker;
  const fileEntriesRef = useRef<FileEntry[]>([]);
  fileEntriesRef.current = fileEntries;
  const fileSelectedIndexRef = useRef(0);
  fileSelectedIndexRef.current = fileSelectedIndex;
  const fileQueryRef = useRef('');
  fileQueryRef.current = fileQuery;
  const currentDirRef = useRef('');
  currentDirRef.current = currentDir;

  // ★ @SESSION: 会话引用选择器状态
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [sessionRefs, setSessionRefs] = useState<any[]>([]);
  const [sessionQuery, setSessionQuery] = useState('');
  const [sessionSelectedIndex, setSessionSelectedIndex] = useState(0);
  const showSessionPickerRef = useRef(false);
  showSessionPickerRef.current = showSessionPicker;
  const sessionRefsRef = useRef<any[]>([]);
  sessionRefsRef.current = sessionRefs;
  const sessionSelectedIndexRef = useRef(0);
  sessionSelectedIndexRef.current = sessionSelectedIndex;
  const sessionLookupVersionRef = useRef(0);
  const filePickerLoadVersionRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const saveSessionDraft = useCallback((
    text: string,
    attachments: TextAttachment[] = textAttachmentsRef.current,
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (text || attachments.length) {
      sessionInputDrafts.set(sid, {
        text,
        textAttachments: attachments.map((item) => ({ ...item })),
      });
    } else {
      sessionInputDrafts.delete(sid);
    }
  }, []);

  const setTextAttachmentList = useCallback((next: TextAttachment[]) => {
    textAttachmentsRef.current = next;
    setTextAttachments(next);
    saveSessionDraft(ref.current?.value ?? '', next);
  }, [saveSessionDraft]);

  const addTextAttachment = useCallback((
    content: string,
    source: TextAttachmentSource,
    name?: string,
  ): TextAttachment | null => {
    if (!content) return null;
    const sourceLabel = source === 'voice'
      ? 'voice-transcript'
      : source === 'paste'
        ? 'pasted-text'
        : source === 'file'
          ? 'uploaded-file'
          : 'long-input';
    const sameSourceCount = textAttachmentsRef.current.filter(
      (item) => item.source === source,
    ).length;
    const attachment: TextAttachment = {
      id: uuid(),
      name: name || `${sourceLabel}-${sameSourceCount + 1}.txt`,
      content,
      size: content.length,
      source,
    };
    setTextAttachmentList([...textAttachmentsRef.current, attachment]);
    return attachment;
  }, [setTextAttachmentList]);

  const showAttachmentNotice = useCallback((message: string) => {
    if (attachmentNoticeTimerRef.current !== null) {
      window.clearTimeout(attachmentNoticeTimerRef.current);
      attachmentNoticeTimerRef.current = null;
    }
    setAttachmentNotice(message);
    if (message) {
      attachmentNoticeTimerRef.current = window.setTimeout(() => {
        attachmentNoticeTimerRef.current = null;
        setAttachmentNotice('');
      }, 6_000);
    }
  }, []);

  useEffect(() => () => {
    if (attachmentNoticeTimerRef.current !== null) {
      window.clearTimeout(attachmentNoticeTimerRef.current);
    }
  }, []);

  const handleAttachmentFiles = useCallback(async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const input = event.currentTarget;
    const files = Array.from(input.files || []);
    // 允许用户连续两次选择同一个文件。
    input.value = '';
    if (!files.length) return;

    showAttachmentNotice('');
    const errors: string[] = [];
    for (const file of files) {
      if (file.size > MAX_PICKED_ATTACHMENT_BYTES) {
        errors.push(`${file.name} 超过 10 MB`);
        continue;
      }
      if (file.size === 0) {
        errors.push(`${file.name} 是空文件`);
        continue;
      }
      try {
        if (isImageAttachmentFile(file)) {
          addImage(await readImageAttachment(file), 'file');
        } else if (isTextAttachmentFile(file)) {
          const content = await file.text();
          if (!addTextAttachment(content, 'file', file.name)) {
            errors.push(`${file.name} 没有可读取的文本`);
          }
        } else {
          errors.push(`${file.name} 不是受支持的图片或文本文件`);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `无法读取 ${file.name}`);
      }
    }
    if (errors.length) showAttachmentNotice(errors.join('；'));
  }, [addImage, addTextAttachment, showAttachmentNotice]);

  const updateTextAttachment = useCallback((attachment: TextAttachment) => {
    const next = textAttachmentsRef.current.map(
      (item) => item.id === attachment.id
        ? { ...attachment, size: attachment.content.length }
        : item,
    );
    setTextAttachmentList(next);
  }, [setTextAttachmentList]);

  const removeTextAttachment = useCallback((id: string) => {
    setTextAttachmentList(
      textAttachmentsRef.current.filter((item) => item.id !== id),
    );
  }, [setTextAttachmentList]);

  const restoreTextAttachment = useCallback((id: string) => {
    const attachment = textAttachmentsRef.current.find((item) => item.id === id);
    const el = ref.current;
    if (!attachment || !el) return;
    const prefix = el.value;
    el.value = prefix
      ? `${prefix}${prefix.endsWith('\n') ? '' : '\n'}${attachment.content}`
      : attachment.content;
    el.selectionStart = el.selectionEnd = el.value.length;
    const next = textAttachmentsRef.current.filter((item) => item.id !== id);
    textAttachmentsRef.current = next;
    setTextAttachments(next);
    saveSessionDraft(el.value, next);
    textareaHeightCappedRef.current = false;
    scheduleTextareaResize(true);
    el.focus();
  }, [saveSessionDraft, scheduleTextareaResize]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) {
      const saved = sessionId ? sessionInputDrafts.get(sessionId) : undefined;
      const restored = saved?.text || '';
      const restoredAttachments = saved?.textAttachments?.map((item) => ({ ...item })) || [];
      el.value = restored;
      textAttachmentsRef.current = restoredAttachments;
      setTextAttachments(restoredAttachments);
      textareaHeightCappedRef.current = false;
      scheduleTextareaResize(true);
      el.selectionStart = el.selectionEnd = restored.length;
    }
    setShowCommands(false);
    setShowFilePicker(false);
    setShowSessionPicker(false);

    return () => {
      if (!sessionId || !ref.current) return;
      const value = ref.current.value;
      const attachments = textAttachmentsRef.current;
      if (value || attachments.length) {
        sessionInputDrafts.set(sessionId, {
          text: value,
          textAttachments: attachments.map((item) => ({ ...item })),
        });
      } else {
        sessionInputDrafts.delete(sessionId);
      }
    };
  }, [sessionId, scheduleTextareaResize]);

  const workingDirRef = useRef(workingDir);
  workingDirRef.current = workingDir;
  const execKeyRef = useRef(execKey);
  execKeyRef.current = execKey;

  // ── 清理上下文 ──
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  // ── 语音流式转写 ──
  const [micActive, setMicActive] = useState(false);
  const [micStatus, setMicStatus] = useState<'idle' | 'connecting' | 'listening' | 'reconnecting' | 'finalizing' | 'error'>('idle');
  const [micError, setMicError] = useState('');
  const [micNotice, setMicNotice] = useState('');
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAudioCtxRef = useRef<AudioContext | null>(null);
  const micUnsubRef = useRef<(() => void) | null>(null);
  const micPrefixRef = useRef<string | null>(null);
  const micAttachmentIdRef = useRef<string | null>(null);
  const micStoppedRef = useRef(false);
  const micFlushResolveRef = useRef<(() => void) | null>(null);

  const micWorkletRef = useRef<AudioWorkletNode | null>(null);

  const applyMicTranscript = useCallback((transcript: string) => {
    const el = ref.current;
    if (!el) return;
    const prefix = micPrefixRef.current ?? '';
    const combined = prefix ? `${prefix}\n${transcript}` : transcript;
    const activeAttachmentId = micAttachmentIdRef.current;

    if (activeAttachmentId || combined.length >= LONG_INPUT_ATTACHMENT_CHARS) {
      if (activeAttachmentId) {
        const next = textAttachmentsRef.current.map((item) => (
          item.id === activeAttachmentId
            ? { ...item, content: transcript, size: transcript.length }
            : item
        ));
        setTextAttachmentList(next);
      } else if (transcript) {
        const attachment = addTextAttachment(
          transcript,
          'voice',
          `voice-transcript-${textAttachmentsRef.current.filter((item) => item.source === 'voice').length + 1}.txt`,
        );
        micAttachmentIdRef.current = attachment?.id || null;
      }
      el.value = prefix;
    } else {
      el.value = combined;
    }

    saveSessionDraft(el.value, textAttachmentsRef.current);
    textareaHeightCappedRef.current = false;
    scheduleTextareaResize(true);
  }, [
    addTextAttachment,
    saveSessionDraft,
    scheduleTextareaResize,
    setTextAttachmentList,
  ]);

  const flushMicWorklet = useCallback(async () => {
    const worklet = micWorkletRef.current;
    if (!worklet) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        micFlushResolveRef.current = null;
        resolve();
      };
      micFlushResolveRef.current = finish;
      worklet.port.postMessage({ type: 'flush' });
      window.setTimeout(finish, 150);
    });
  }, []);

  const micStop = useCallback(async () => {
    if (micStoppedRef.current) return;
    micStoppedRef.current = true;
    setMicStatus('finalizing');
    await flushMicWorklet();
    if (micWorkletRef.current) {
      micWorkletRef.current.port.close();
      micWorkletRef.current.disconnect();
      micWorkletRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;
    micAudioCtxRef.current?.close().catch(() => {});
    micAudioCtxRef.current = null;
    try {
      const res = await api.sttStreamStop(sessionId);
      if (res.ok && res.text && ref.current) {
        applyMicTranscript(res.text);
        if (res.refinedByFlash) {
          setMicNotice('已使用 Fun-ASR-Flash 完成短音频精校');
        } else if (res.refineSkipped) {
          setMicNotice(res.refineSkipped);
        } else if (res.refineError) {
          setMicNotice(`Flash 精校失败，已保留实时识别结果：${res.refineError}`);
        }
      } else if (!res.ok && res.error !== 'No active STT stream') {
        setMicError(res.error || '实时语音识别停止失败');
      }
    } catch (e: any) {
      setMicError(e?.message || '实时语音识别停止失败');
    }
    micUnsubRef.current?.();
    micUnsubRef.current = null;
    micPrefixRef.current = null;
    micAttachmentIdRef.current = null;
    setMicActive(false);
    setMicStatus('idle');
    ref.current?.focus();
  }, [applyMicTranscript, flushMicWorklet, sessionId]);

  const micStart = useCallback(async () => {
    micStoppedRef.current = false;
    setMicActive(true);
    setMicStatus('connecting');
    setMicError('');
    setMicNotice('');
    let serverStarted = false;
    try {
      const cfg = await api.getSttConfig(sessionId);
      const deviceId = cfg?.deviceId || '';

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (devErr) {
        if (deviceId) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw devErr;
        }
      }
      if (micStoppedRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      micStreamRef.current = stream;

      const res = await api.sttStreamStart(undefined, sessionId);
      if (!res.ok) {
        stream.getTracks().forEach(t => t.stop());
        throw new Error(res.error || 'STT stream start failed');
      }
      serverStarted = true;
      if (micStoppedRef.current) {
        await api.sttStreamStop(sessionId).catch(() => {});
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      micPrefixRef.current = ref.current?.value ?? '';
      micAttachmentIdRef.current = null;

      const unsub = api.onSttStreamText((data) => {
        applyMicTranscript(data.text);
      });
      micUnsubRef.current = unsub;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      micAudioCtxRef.current = audioCtx;
      await audioCtx.resume();
      await audioCtx.audioWorklet.addModule('./pcm-worklet.js');
      const source = audioCtx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioCtx, 'pcm-processor');
      micWorkletRef.current = worklet;
      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer | { type?: string }>) => {
        if (!(e.data instanceof ArrayBuffer)) {
          if (e.data?.type === 'flushed') micFlushResolveRef.current?.();
          return;
        }
        // 停止时 Worklet 会先 flush 最后一段不足 100ms 的 PCM；该帧仍需发送。
        if (micStoppedRef.current && !micFlushResolveRef.current) return;
        api.sttStreamAudioBinary(e.data);
      };
      source.connect(worklet);
      // AudioWorklet 必须连入活动输出图；0 增益确保不会回放麦克风。
      const silentSink = audioCtx.createGain();
      silentSink.gain.value = 0;
      worklet.connect(silentSink);
      silentSink.connect(audioCtx.destination);

      setMicStatus('listening');
    } catch (e: any) {
      console.error('[mic]', e);
      micStoppedRef.current = true;
      micUnsubRef.current?.();
      micUnsubRef.current = null;
      if (serverStarted) await api.sttStreamStop(sessionId).catch(() => {});
      if (micWorkletRef.current) {
        micWorkletRef.current.port.close();
        micWorkletRef.current.disconnect();
        micWorkletRef.current = null;
      }
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
      micAudioCtxRef.current?.close().catch(() => {});
      micAudioCtxRef.current = null;
      setMicActive(false);
      setMicStatus('error');
      setMicError(e?.message || '无法启动实时语音识别');
    }
  }, [applyMicTranscript, sessionId]);

  const toggleMic = useCallback(() => {
    if (micActive) {
      micStop();
    } else {
      micStart();
    }
  }, [micActive, micStart, micStop]);

  const micReconnect = useCallback(async () => {
    if (micStoppedRef.current) return;
    setMicStatus('reconnecting');
    micUnsubRef.current?.();
    micUnsubRef.current = null;
    // 保存当前文本作为新前缀，避免重连后丢失已转写内容
    if (ref.current) micPrefixRef.current = ref.current.value;
    micAttachmentIdRef.current = null;
    try {
      const res = await api.sttStreamStart(undefined, sessionId);
      if (!res.ok) throw new Error(res.error);
      const unsub = api.onSttStreamText((data) => {
        applyMicTranscript(data.text);
      });
      micUnsubRef.current = unsub;
      setMicStatus('listening');
    } catch (e: any) {
      micStoppedRef.current = true;
      if (micWorkletRef.current) {
        micWorkletRef.current.port.close();
        micWorkletRef.current.disconnect();
        micWorkletRef.current = null;
      }
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
      micAudioCtxRef.current?.close().catch(() => {});
      micAudioCtxRef.current = null;
      micPrefixRef.current = null;
      micAttachmentIdRef.current = null;
      setMicActive(false);
      setMicStatus('error');
      setMicError(e?.message || '实时语音连接已断开');
    }
  }, [applyMicTranscript, sessionId]);

  useEffect(() => {
    if (voiceConversationActive && !micStoppedRef.current) {
      void micStop();
    }
  }, [voiceConversationActive, micStop]);

  useEffect(() => {
    const unsub = api.onSttStreamEnd(() => {
      if (!micStoppedRef.current) {
        micReconnect();
      }
    });
    return () => {
      unsub();
      if (micStreamRef.current) {
        micStoppedRef.current = true;
        micUnsubRef.current?.();
        if (micWorkletRef.current) {
          micWorkletRef.current.port.close();
          micWorkletRef.current.disconnect();
          micWorkletRef.current = null;
        }
        micStreamRef.current.getTracks().forEach(t => t.stop());
        micAudioCtxRef.current?.close().catch(() => {});
        void api.sttStreamStop(sessionId).catch(() => {});
      }
    };
  }, [micReconnect, sessionId]);

  const handleCompact = useCallback(() => {
    // ★ 二次确认：新会话会清空上下文，误触代价很大
    setShowNewSessionConfirm(true);
  }, []);
  const confirmNewSession = useCallback(() => {
    setShowNewSessionConfirm(false);
    onCompact?.();
  }, [onCompact]);

  // ═══════════════════════════════════════
  //  ★ 图像尺寸选择器（DashScope 图像 backend）
  // ═══════════════════════════════════════
  const activeBackend = useMemo(() => backends.find(b => b.id === activeBackendId), [backends, activeBackendId]);
  const isImageBackend = activeBackend?.type === 'dashscope-image';
  const runtimeConfigurable = isRuntimeConfigurableBackend(activeBackend);
  const [showRuntimePicker, setShowRuntimePicker] = useState(false);
  const [runtimeDraft, setRuntimeDraft] = useState<ModelRuntime>(() => normalizeModelRuntime(sessionRuntime));
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const runtimePickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRuntimeDraft(normalizeModelRuntime(sessionRuntime));
    setRuntimeError('');
  }, [sessionRuntime?.model, sessionRuntime?.reasoningEffort, activeBackendId]);

  useEffect(() => {
    if (!showRuntimePicker) return;
    const close = (event: MouseEvent) => {
      if (runtimePickerRef.current && !runtimePickerRef.current.contains(event.target as Node)) {
        setShowRuntimePicker(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showRuntimePicker]);

  const saveRuntime = useCallback(async () => {
    if (!onSessionRuntimeChange || runtimeSaving) return;
    setRuntimeSaving(true);
    setRuntimeError('');
    const result = await onSessionRuntimeChange(normalizeModelRuntime(runtimeDraft));
    setRuntimeSaving(false);
    if (result.status === 'ok') {
      setShowRuntimePicker(false);
    } else {
      setRuntimeError(result.message || '保存失败');
    }
  }, [onSessionRuntimeChange, runtimeDraft, runtimeSaving]);

  const isImageBackendRef = useRef(false);
  isImageBackendRef.current = isImageBackend;
  const [imageSize, setImageSize] = useState('auto');
  const [showSizePicker, setShowSizePicker] = useState(false);
  const imageSizeRef = useRef('auto');
  imageSizeRef.current = imageSize;
  const sizePickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showSizePicker) return;
    const handler = (e: MouseEvent) => {
      if (sizePickerRef.current && !sizePickerRef.current.contains(e.target as Node)) {
        setShowSizePicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSizePicker]);

  // 分辨率档位 → 比例 → 具体尺寸的映射
  const SIZE_PRESETS: Record<string, { label: string; icon: string }> = {
    'auto': { label: '自动', icon: '◇' },
    '1:1': { label: '1:1', icon: '□' },
    '16:9': { label: '16:9', icon: '▭' },
    '9:16': { label: '9:16', icon: '▯' },
    '4:3': { label: '4:3', icon: '▭' },
    '3:4': { label: '3:4', icon: '▯' },
    '3:2': { label: '3:2', icon: '▭' },
    '2:3': { label: '2:3', icon: '▯' },
  };

  // ═══════════════════════════════════════
  //  ★ @ 文件选择器 helpers
  // ═══════════════════════════════════════

  // 计算父目录（不允许超过 workingDir，全部使用相对路径）
  const getParentDir = (dirPath: string): string | null => {
    const normalized = dirPath.replace(/\\/g, '/').replace(/\/$/, '');
    if (!normalized || normalized === '.') return null; // 已在根目录
    const lastSep = normalized.lastIndexOf('/');
    if (lastSep < 0) return '.'; // 单层子目录 → 回到根
    return normalized.substring(0, lastSep) || '.';
  };

  // 进入子目录
  const navigateToDir = useCallback((dirPath: string) => {
    setCurrentDir(dirPath);
    setFileQuery('');
    setFileSelectedIndex(0);
    // 清除光标前 @ 后面的查询词
    const el = ref.current;
    if (el) {
      const cursor = el.selectionStart ?? el.value.length;
      const before = el.value.substring(0, cursor);
      const lastAt = before.lastIndexOf('@');
      if (lastAt >= 0) {
        const newVal = el.value.substring(0, lastAt + 1) + el.value.substring(cursor);
        el.value = newVal;
        el.selectionStart = lastAt + 1;
        el.selectionEnd = lastAt + 1;
      }
    }
    api.listDirectory(dirPath, workingDirRef.current, execKeyRef.current).then((entries) => {
      if (Array.isArray(entries)) setFileEntries(entries);
    });
  }, []);

  const navigateToDirRef = useRef(navigateToDir);
  navigateToDirRef.current = navigateToDir;

  // 选中文件：在光标处替换 @query → @path
  const insertFileRef = useCallback((filePath: string) => {
    const el = ref.current;
    if (!el) return;
    const cursor = el.selectionStart ?? el.value.length;
    const before = el.value.substring(0, cursor);
    const lastAt = before.lastIndexOf('@');
    if (lastAt < 0) { setShowFilePicker(false); return; }
    const normalized = filePath.replace(/\\/g, '/');
    const newVal = el.value.substring(0, lastAt) + '@' + normalized + ' ' + el.value.substring(cursor);
    el.value = newVal;
    const newCursor = lastAt + 1 + normalized.length + 1;
    el.selectionStart = newCursor;
    el.selectionEnd = newCursor;
    el.focus();
    saveSessionDraft(el.value);
    textareaHeightCappedRef.current = false;
    scheduleTextareaResize(true);
    setShowFilePicker(false);
    setFileQuery('');
  }, [saveSessionDraft, scheduleTextareaResize]);

  const insertFileRefRef = useRef(insertFileRef);
  insertFileRefRef.current = insertFileRef;

  const insertSessionRef = useCallback((session: any) => {
    const el = ref.current;
    if (!el || !session?.id) return;
    const cursor = el.selectionStart ?? el.value.length;
    const before = el.value.substring(0, cursor);
    const marker = '@SESSION:';
    const last = before.lastIndexOf(marker);
    if (last < 0) { setShowSessionPicker(false); return; }
    const label = String(session.id);
    const newVal = el.value.substring(0, last) + `${marker}${label} ` + el.value.substring(cursor);
    el.value = newVal;
    const newCursor = last + marker.length + label.length + 1;
    el.selectionStart = newCursor;
    el.selectionEnd = newCursor;
    el.focus();
    saveSessionDraft(el.value);
    textareaHeightCappedRef.current = false;
    scheduleTextareaResize(true);
    setShowSessionPicker(false);
    setSessionQuery('');
  }, [saveSessionDraft, scheduleTextareaResize]);
  const insertSessionRefRef = useRef(insertSessionRef);
  insertSessionRefRef.current = insertSessionRef;

  // ── 发送 ──
  const handleSend = useCallback(() => {
    let text = ref.current?.value.trim() || '';
    const imgs = imagesRef.current;
    const textFiles = textAttachmentsRef.current;
    if (!text && imgs.length === 0 && textFiles.length === 0) return;
    // 不把本次委托悄悄带入自动队列、斜杠命令或未来轮次。
    if (kitApprovalDelegationRef.current && (isStreamingRef.current || seqCountRef.current > 0 || text.startsWith('/'))) {
      setAttachmentNotice('Kit 委托只支持空闲时直接发送普通消息，请取消勾选或等待当前轮结束。');
      return;
    }
    // ★ 图像 backend：自动注入 --size 参数
    if (isImageBackendRef.current && imageSizeRef.current && imageSizeRef.current !== 'auto' && text) {
      text = `${text} --size ${imageSizeRef.current}`;
    }
    // ★ 保存到输入历史（Linux 风格 ↑ 追溯）
    if (text) pushHistory(text);
    // 默认序列行为：空闲且没有队列时直接发送；模型忙碌或已有待发项时，
    // 新输入自动排到队尾，不打断当前回答。
    if ((isStreamingRef.current || seqCountRef.current > 0) && onQueueTaskRef.current) {
      onQueueTaskRef.current(
        text,
        imgs.length > 0 ? imgs : undefined,
        textFiles.length > 0 ? textFiles : undefined,
      );
    } else {
      onSendRef.current(
        text,
        imgs.length > 0 ? imgs : undefined,
        textFiles.length > 0 ? textFiles : undefined,
        kitApprovalDelegationRef.current,
      );
    }
    kitApprovalDelegationRef.current = false;
    setKitApprovalDelegation(false);
    if (ref.current) {
      ref.current.value = '';
      textareaHeightCappedRef.current = false;
      scheduleTextareaResize(true);
      ref.current.focus();   // 点击发送按钮后也继续输入，连续任务自然排队
    }
    if (sessionIdRef.current) sessionInputDrafts.delete(sessionIdRef.current);
    textAttachmentsRef.current = [];
    setTextAttachments([]);
    clearImagesRef.current();
    setShowCommands(false);
  }, [scheduleTextareaResize]);

  // ── 键盘事件 ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229)
        return;

      // ★ @SESSION: 会话引用选择器键盘导航（优先于文件选择器）
      if (showSessionPickerRef.current) {
        const filtered = sessionRefsRef.current;
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSessionSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSessionSelectedIndex((prev) => Math.min(filtered.length - 1, prev + 1));
          return;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault();
          const entry = filtered[sessionSelectedIndexRef.current];
          if (entry) insertSessionRefRef.current(entry);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowSessionPicker(false);
          return;
        }
      }

      // ★ @ 文件选择器键盘导航（优先于斜杠命令）
      if (showFilePickerRef.current) {
        const q = fileQueryRef.current.toLowerCase();
        const filtered = fileEntriesRef.current.filter(
          (en) => !q || en.name.toLowerCase().includes(q)
        );
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setFileSelectedIndex((prev) => {
            const next = Math.max(0, prev - 1);
            fileSelectedIndexRef.current = next;
            return next;
          });
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setFileSelectedIndex((prev) => {
            const next = Math.min(filtered.length - 1, prev + 1);
            fileSelectedIndexRef.current = next;
            return next;
          });
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const entry = filtered[fileSelectedIndexRef.current];
          if (entry) {
            if (entry.isDir) navigateToDirRef.current(entry.path);
            else insertFileRefRef.current(entry.path);
          }
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const entry = filtered[fileSelectedIndexRef.current];
          if (entry) {
            if (entry.isDir) navigateToDirRef.current(entry.path);
            else insertFileRefRef.current(entry.path);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowFilePicker(false);
          return;
        }
      }

      // ★ 命令弹窗打开时的键盘导航
      if (showCommandsRef.current && filteredCommandsRef.current.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => {
            const next = Math.max(0, prev - 1);
            selectedIndexRef.current = next;  // ★ 立即同步 ref，避免后续 Tab/Enter 读到旧值
            return next;
          });
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => {
            const next = Math.min(filteredCommandsRef.current.length - 1, prev + 1);
            selectedIndexRef.current = next;  // ★ 立即同步 ref
            return next;
          });
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          // Tab: 只自动补全，不执行
          const cmd = filteredCommandsRef.current[selectedIndexRef.current];
          if (cmd && ref.current) {
            ref.current.value = cmd.name + ' ';
            setShowCommands(false);
            saveSessionDraft(ref.current.value);
            textareaHeightCappedRef.current = false;
            scheduleTextareaResize(true);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowCommands(false);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          // Enter: 补全并执行
          const cmd = filteredCommandsRef.current[selectedIndexRef.current];
          if (cmd && ref.current) {
            ref.current.value = cmd.name;
          }
          setShowCommands(false);
          handleSend();
          return;
        }
      }

      // ★ 输入历史浏览（Linux 风格 ↑↓）
      // 仅在输入框非空且光标在首行（或无多行）时触发，避免干扰多行文本编辑。
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const el = ref.current;
        const cursorPos = el ? (el.selectionStart ?? el.value.length) : 0;
        const text = el?.value ?? '';
        // 只有光标在第一行（之前没有换行符）时才触发历史浏览
        const firstLineEnd = text.indexOf('\n');
        const onFirstLine = firstLineEnd < 0 || cursorPos <= firstLineEnd;

        if (!onFirstLine) {
          // 光标不在第一行，让浏览器默认行为处理光标移动
          return;
        }

        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const hist = historyRef.current;
          if (hist.length === 0) return;
          const curIdx = histIdxRef.current;
          // 第一次按 ↑：保存当前草稿，跳到最新一条
          if (curIdx === -1) {
            draftRef.current = text;
            const newIdx = hist.length - 1;
            setHistIdx(newIdx);
            if (el) { el.value = hist[newIdx]; el.selectionStart = el.selectionEnd = hist[newIdx].length; }
          } else if (curIdx > 0) {
            // 继续往上翻
            const newIdx = curIdx - 1;
            setHistIdx(newIdx);
            if (el) { el.value = hist[newIdx]; el.selectionStart = el.selectionEnd = hist[newIdx].length; }
          }
          // 已在最旧的一条，不再上翻
          return;
        }

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const curIdx = histIdxRef.current;
          if (curIdx === -1) return; // 未在浏览历史，不处理
          const hist = historyRef.current;
          if (curIdx < hist.length - 1) {
            // 往下翻
            const newIdx = curIdx + 1;
            setHistIdx(newIdx);
            if (el) { el.value = hist[newIdx]; el.selectionStart = el.selectionEnd = hist[newIdx].length; }
          } else {
            // 回到草稿 / 清空
            setHistIdx(-1);
            if (el) { el.value = draftRef.current; el.selectionStart = el.selectionEnd = draftRef.current.length; }
          }
          return;
        }
      }

      // ★ Escape 退出历史浏览模式
      if (e.key === 'Escape' && histIdxRef.current !== -1) {
        e.preventDefault();
        setHistIdx(-1);
        const el = ref.current;
        if (el) { el.value = draftRef.current; el.selectionStart = el.selectionEnd = draftRef.current.length; }
        return;
      }

      // 普通 Enter 发送（流式进行中也允许，sendMessage 内部处理中断续发）
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend, saveSessionDraft, scheduleTextareaResize]
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);
  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
  }, []);

  const handleTextPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const hasImage = Array.from(clipboard.items || []).some(
      (item) => item.type.startsWith('image/'),
    );
    if (hasImage) return;
    const text = clipboard.getData('text/plain');
    if (text.length < LARGE_PASTE_ATTACHMENT_CHARS) return;
    event.preventDefault();
    addTextAttachment(text, 'paste');
    saveSessionDraft(ref.current?.value ?? '', textAttachmentsRef.current);
  }, [addTextAttachment, saveSessionDraft]);

  // ── 输入变化：自动附件化 + 合帧 auto-resize + 斜杠/@ 检测 ──
  const handleInput = useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
    const el = ref.current;
    if (!el) return;

    // ★ 用户手动输入时退出历史浏览模式（草稿自动成为新的"当前文本"）
    if (histIdxRef.current !== -1) {
      setHistIdx(-1);
    }

    let text = el.value;
    if (!composingRef.current && text.length >= LONG_INPUT_ATTACHMENT_CHARS) {
      addTextAttachment(text, 'input');
      el.value = '';
      text = '';
      saveSessionDraft('', textAttachmentsRef.current);
      textareaHeightCappedRef.current = false;
      scheduleTextareaResize(true);
      sessionLookupVersionRef.current += 1;
      filePickerLoadVersionRef.current += 1;
      setShowSessionPicker(false);
      setShowFilePicker(false);
      setShowCommands(false);
      return;
    }
    saveSessionDraft(text);

    const inputType = (event.nativeEvent as InputEvent).inputType || '';
    scheduleTextareaResize(inputType.startsWith('delete'));

    let cursor = el.selectionStart ?? text.length;
    let beforeCursor = text.substring(0, cursor);
    const lastAt = beforeCursor.lastIndexOf('@');

    // ★ @ 文件选择器检测（优先于斜杠命令）
    if (lastAt >= 0) {
      let afterAt = beforeCursor.substring(lastAt + 1);

      // 输入到 @SE 即明确视为会话引用，立即补全固定前缀并展示会话。
      // 同时避免输入 @S 时已经发出的文件目录请求稍后反抢弹窗。
      if (/^SE$/i.test(afterAt)) {
        const marker = 'SESSION:';
        text = text.substring(0, lastAt + 1) + marker + text.substring(cursor);
        cursor = lastAt + 1 + marker.length;
        el.value = text;
        el.selectionStart = cursor;
        el.selectionEnd = cursor;
        saveSessionDraft(text);
        beforeCursor = text.substring(0, cursor);
        afterAt = marker;
      }

      if (afterAt.toUpperCase().startsWith('SESSION:') && !afterAt.includes('\n')) {
        const query = afterAt.slice('SESSION:'.length);
        if (!query.includes(' ')) {
          filePickerLoadVersionRef.current += 1;
          const lookupVersion = ++sessionLookupVersionRef.current;
          setSessionQuery(query);
          setSessionSelectedIndex(0);
          api.listSessionRefs(query, execKeyRef.current).then((items) => {
            if (lookupVersion !== sessionLookupVersionRef.current) return;
            setSessionRefs((items || []).filter((s: any) => s.id !== sessionIdRef.current));
            setShowSessionPicker(true);
          }).catch(() => {
            if (lookupVersion !== sessionLookupVersionRef.current) return;
            setSessionRefs([]);
            setShowSessionPicker(true);
          });
          setShowFilePicker(false);
          setShowCommands(false);
          return;
        }
      }
      if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
        sessionLookupVersionRef.current += 1;
        const query = afterAt;
        setFileQuery(query);
        setFileSelectedIndex(0);
        if (!showFilePickerRef.current) {
          // 首次打开：加载工作目录
          setCurrentDir('.');
          const wd = workingDirRef.current || '.';
          const loadVersion = ++filePickerLoadVersionRef.current;
          api.listDirectory(wd, wd, execKeyRef.current).then((entries) => {
            if (loadVersion !== filePickerLoadVersionRef.current) return;
            if (Array.isArray(entries)) {
              setFileEntries(entries);
              setShowFilePicker(true);
            }
          });
        }
        setShowCommands(false);
        return;
      }
    }

    // 没有 @ 触发时，关闭选择器
    sessionLookupVersionRef.current += 1;
    filePickerLoadVersionRef.current += 1;
    if (showSessionPickerRef.current) {
      setShowSessionPicker(false);
      setSessionQuery('');
    }
    if (showFilePickerRef.current) {
      setShowFilePicker(false);
      setFileQuery('');
    }

    // ★ 斜杠命令检测（仅在行首 / 时触发）
    if (text.startsWith('/') && !text.includes(' ') && text.length > 0) {
      const query = text.toLowerCase();
      const matched = SLASH_COMMANDS.filter((cmd) =>
        cmd.name.startsWith(query)
      );
      setFilteredCommands(matched);
      setShowCommands(matched.length > 0);
      setSelectedIndex(0);
    } else {
      setShowCommands(false);
    }
  }, [addTextAttachment, saveSessionDraft, scheduleTextareaResize]);

  // ── 点击选择命令 ──
  const handleSelectCommand = useCallback((cmd: SlashCommand) => {
    if (ref.current) {
      ref.current.value = cmd.name;
      ref.current.focus();
    }
    setShowCommands(false);
    handleSend();
  }, [handleSend]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // 滚动选中项到可见区域（斜杠命令）
  useEffect(() => {
    if (showCommands && popupRef.current) {
      const items = popupRef.current.children;
      if (items[selectedIndex]) {
        (items[selectedIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, showCommands]);

  // 滚动选中项到可见区域（文件选择器）
  useEffect(() => {
    if (showFilePicker && filePopupRef.current) {
      const items = filePopupRef.current.querySelectorAll<HTMLElement>('[data-file-item]');
      if (items[fileSelectedIndex]) {
        items[fileSelectedIndex].scrollIntoView({ block: 'nearest' });
      }
    }
  }, [fileSelectedIndex, showFilePicker]);

  // ── 文件选择器：过滤当前目录条目 ──
  const filteredEntries = useMemo(() => {
    const q = fileQuery.toLowerCase();
    return fileEntries.filter((e) => !q || e.name.toLowerCase().includes(q));
  }, [fileEntries, fileQuery]);

  // 是否可以返回上级目录
  const parentDir = showFilePicker ? getParentDir(currentDir) : null;

  return (
    <div className="awu-composer" style={{ padding: 'var(--ui-composer-padding, 9px 18px 14px)', borderTop: isStreaming ? '1px solid var(--theme-success-border, rgba(50,182,122,.35))' : '1px solid transparent', background: 'var(--theme-bg, #ffffff)', position: 'relative', transition: 'border-top-color 0.2s ease' }}>
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => { void handleAttachmentFiles(event); }}
        style={{ display: 'none' }}
      />
      {runtimeConfigurable && showRuntimePicker && (
        <div
          ref={runtimePickerRef}
          style={{
            position: 'absolute', left: 16, bottom: 'calc(100% - 2px)', zIndex: 180,
            width: 'min(460px, calc(100% - 32px))', maxHeight: 'min(320px, 60dvh)',
            overflowY: 'auto', boxSizing: 'border-box', padding: 14,
            border: '1px solid var(--theme-border)', borderRadius: 6,
            background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)',
            boxShadow: '0 12px 32px rgba(0,0,0,.28)',
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 650 }}>本 Session 的模型运行参数</div>
              <div style={{ marginTop: 3, fontSize: 10.5, color: 'var(--theme-text-muted)', lineHeight: 1.45 }}>
                保存后从下一个 turn 生效；原生 thread、接管关系和已有上下文保持不变。
              </div>
            </div>
            <button
              onClick={() => setShowRuntimePicker(false)}
              style={{ marginLeft: 'auto', border: 0, background: 'none', color: 'var(--theme-text-muted)', cursor: 'pointer', fontSize: 16 }}
              aria-label="关闭模型设置"
            >×</button>
          </div>
          <BackendRuntimeFields
            backend={activeBackend}
            value={runtimeDraft}
            onChange={setRuntimeDraft}
          />
          {runtimeError && <div style={{ marginTop: 8, fontSize: 11, color: '#f87171' }}>{runtimeError}</div>}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10.5, color: 'var(--theme-text-muted)' }}>
              当前：{formatRuntimeLabel(activeBackend, sessionRuntime)}
            </span>
            <div style={{ display: 'flex', gap: 7 }}>
              <button onClick={() => setRuntimeDraft({})} disabled={runtimeSaving} style={runtimeSecondaryBtnStyle}>
                跟随后端默认
              </button>
              <button
                onClick={saveRuntime}
                disabled={runtimeSaving}
                style={{ ...runtimePrimaryBtnStyle, opacity: runtimeSaving ? 0.6 : 1 }}
              >{runtimeSaving ? '保存中…' : '应用到后续 turn'}</button>
            </div>
          </div>
        </div>
      )}
      {/* ★ 工具栏：统一的图标按钮 */}
      {!isImageBackend && <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
        fontSize: 11, color: kitApprovalDelegation ? 'var(--theme-text)' : 'var(--theme-text-muted)' }}
        title="只授权本次发送所选的一个 Kit 运行/链；6 小时有效。Agent 核对冻结计划后可正式发布。不会由普通文字自动授权，不继承到队列、语音或下次发送。">
        <input type="checkbox" aria-label="本次允许 Kit 代确认" checked={kitApprovalDelegation}
          disabled={isStreaming || seqCount > 0} onChange={event => setKitApprovalDelegation(event.target.checked)} />
        本次允许 Kit 代确认{kitApprovalDelegation ? ' · 一个运行，6 小时内有效' : ''}
      </label>}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <ToolbarBtn
          icon="⚡"
          title="跳过确认"
          active={skipPermissions}
          compact={isMobile}
          onClick={() => onSkipPermissionsChange?.(!skipPermissions)}
        />
        <ToolbarBtn
          icon="🧹"
          title="新会话（清空上下文，同目录）"
          compact={isMobile}
          onClick={handleCompact}
        />
        {runtimeConfigurable && (
          <ToolbarBtn
            icon="⚙"
            title={`切换本 Session 模型${activeBackend?.type === 'codex-office' ? ' / 推理档位' : ''}（当前：${formatRuntimeLabel(activeBackend, sessionRuntime)}）`}
            active={showRuntimePicker}
            compact={isMobile}
            onClick={() => setShowRuntimePicker((value) => !value)}
          />
        )}
        {onAdjustFontSize && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 2 }}
            title={`对话字号${fontSize ? ` ${fontSize}px` : ''}（A− / A+ 调整，全局生效）`}>
            <ToolbarBtn icon="A−" title="缩小对话字号" compact={isMobile} onClick={() => onAdjustFontSize(-1)} />
            <ToolbarBtn icon="A+" title="放大对话字号" compact={isMobile} onClick={() => onAdjustFontSize(1)} />
          </div>
        )}
        <ToolbarBtn
          icon="＋"
          title="添加附件（图片或文本文件）"
          compact={isMobile}
          onClick={() => attachmentInputRef.current?.click()}
        />
        {/* 截图按钮:桌面端独有,浏览器无法调起系统截图工具 */}
        {isTauri() && (
          <ToolbarBtn
            icon="📷"
            title={screenshotBusy ? "等待截图…(选完区域自动加入附件)" : "截图(系统截图工具)"}
            active={screenshotBusy}
            compact={isMobile}
            onClick={handleScreenshot}
            loading={screenshotBusy}
          />
        )}
        {realtimeVoice && (
          <RealtimeVoiceBar
            {...realtimeVoice}
            isStreaming={isStreaming}
            isFocused={isFocused}
            onAbort={onAbort}
            compact
          />
        )}
        {/* ★ 流式进度指示器 */}
        {isStreaming && (
          <div title="模型正在生成；可选择排队、当前轮引导或中断后重引导" style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '7px',
            fontSize: 11,
            borderRadius: 6,
            background: 'rgba(34,197,94,0.1)',
            border: '1px solid rgba(34,197,94,0.2)',
          }}>
            <div style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#22c55e',
              animation: 'chat-pulse 1.5s ease-in-out infinite',
            }} />
          </div>
        )}
        {/* ★ 图像尺寸选择器（仅 DashScope 图像 backend 显示） */}
        {isImageBackend && (
          <div ref={sizePickerRef} style={{ position: 'relative', display: 'inline-flex' }}>
            <button
              onClick={() => setShowSizePicker(v => !v)}
              title="图片尺寸；自动模式由模型根据提示词推荐"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '4px 10px', fontSize: 11, borderRadius: 6,
                border: '1px solid var(--theme-border)', cursor: 'pointer',
                background: 'var(--theme-bg-secondary)', color: 'var(--theme-text-muted)',
                transition: 'all 0.15s', whiteSpace: 'nowrap',
              }}
            >
              <span style={{ fontSize: 12 }}>{SIZE_PRESETS[imageSize]?.icon || '□'}</span>
              <span>{SIZE_PRESETS[imageSize]?.label || imageSize}</span>
            </button>
            {showSizePicker && (
              <div style={{
                position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
                padding: 8, borderRadius: 6,
                background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.2)', zIndex: 200,
                display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200,
              }}>
                <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', fontWeight: 600, padding: '0 4px' }}>
                  输出尺寸 / 比例
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {Object.entries(SIZE_PRESETS).map(([key, { label, icon }]) => (
                    <button
                      key={key}
                      onClick={() => { setImageSize(key); setShowSizePicker(false); }}
                      style={{
                        padding: '5px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                        border: key === imageSize
                          ? '1px solid var(--theme-accent)'
                          : '1px solid var(--theme-border)',
                        background: key === imageSize
                          ? 'var(--theme-accent-bg)'
                          : 'var(--theme-bg)',
                        color: key === imageSize
                          ? 'var(--theme-accent)'
                          : 'var(--theme-text)',
                        display: 'flex', alignItems: 'center', gap: 4,
                        transition: 'all 0.12s',
                      }}
                    >
                      <span style={{ fontSize: 10, opacity: 0.7 }}>{icon}</span>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {attachmentNotice && (
        <div
          role="alert"
          style={{
            margin: '-1px 0 6px',
            padding: '5px 8px',
            borderRadius: 5,
            border: '1px solid rgba(248,81,73,.25)',
            background: 'rgba(248,81,73,.08)',
            color: 'var(--theme-error, #cf222e)',
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {attachmentNotice}
        </div>
      )}

      <ImagePreview images={images} onRemove={removeImage} />
      <TextAttachmentPreview
        attachments={textAttachments}
        onRemove={removeTextAttachment}
        onRestore={restoreTextAttachment}
        onUpdate={updateTextAttachment}
      />

      {/* ★ @SESSION: 会话引用选择器弹窗 */}
      {showSessionPicker && (
        <div style={filePickerPopupStyle}>
          <div style={filePickerHeaderStyle}>
            <span style={{ opacity: 0.6, fontSize: 10 }}>💬</span>
            <span style={{ flex: 1 }}>引用会话 {sessionQuery ? `· ${sessionQuery}` : ''}</span>
          </div>
          {sessionRefs.length === 0 && (
            <div style={{ padding: '8px 12px', color: 'var(--theme-text-muted)', fontSize: 12 }}>无匹配会话</div>
          )}
          {sessionRefs.map((s: any, i: number) => (
            <div
              key={s.id}
              style={{
                ...fileItemStyle,
                background: i === sessionSelectedIndex ? 'var(--theme-bg-tertiary, #eaeef2)' : 'transparent',
              }}
              onClick={() => insertSessionRefRef.current(s)}
              onMouseEnter={() => setSessionSelectedIndex(i)}
            >
              <span>{s.sessionType === 'loop' ? '🔁' : '💬'}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title || s.id}</span>
              <span style={{ fontSize: 10, opacity: 0.55 }}>{String(s.id || '').slice(0, 8)}</span>
            </div>
          ))}
          <div style={filePickerFooterStyle}>
            ↑↓ 导航 · Enter/Tab 引用 · Esc 关闭
          </div>
        </div>
      )}

      {/* ★ @ 文件选择器弹窗 */}
      {showFilePicker && (
        <div ref={filePopupRef} style={filePickerPopupStyle}>
          {/* 当前目录路径 */}
          <div style={filePickerHeaderStyle}>
            <span style={{ opacity: 0.6, fontSize: 10 }}>📁</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
              {currentDir === '.' ? (workingDir || '.').replace(/\\/g, '/').split('/').pop() || '.' : currentDir}
            </span>
          </div>
          {/* 上级目录 */}
          {parentDir && (
            <div
              data-file-item
              style={{ ...fileItemStyle, color: 'var(--theme-text-muted, #656d76)' }}
              onClick={() => navigateToDirRef.current(parentDir)}
              onMouseEnter={() => setFileSelectedIndex(-1)}
            >
              <span>↩</span>
              <span>..</span>
            </div>
          )}
          {filteredEntries.length === 0 && (
            <div style={{ padding: '8px 12px', color: 'var(--theme-text-muted)', fontSize: 12 }}>无匹配文件</div>
          )}
          {filteredEntries.map((entry, i) => (
            <div
              key={entry.path}
              data-file-item
              style={{
                ...fileItemStyle,
                background: i === fileSelectedIndex ? 'var(--theme-bg-tertiary, #eaeef2)' : 'transparent',
              }}
              onClick={() => entry.isDir ? navigateToDirRef.current(entry.path) : insertFileRefRef.current(entry.path)}
              onMouseEnter={() => setFileSelectedIndex(i)}
            >
              <span>{entry.isDir ? '📁' : '📄'}</span>
              <span style={{ flex: 1 }}>{entry.name}</span>
              {entry.isDir && <span style={{ fontSize: 10, opacity: 0.5 }}>▶</span>}
            </div>
          ))}
          <div style={filePickerFooterStyle}>
            ↑↓ 导航 · Enter/Tab 进入/选择 · Esc 关闭
          </div>
        </div>
      )}

      {/* ★ 斜杠命令弹窗 */}
      {showCommands && filteredCommands.length > 0 && (
        <div ref={popupRef} style={commandPopupStyle}>
          {filteredCommands.map((cmd, i) => (
            <div
              key={cmd.name}
              style={{
                ...commandItemStyle,
                background: i === selectedIndex ? 'var(--theme-bg-tertiary, #eaeef2)' : 'transparent',
              }}
              onClick={() => handleSelectCommand(cmd)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--theme-accent, #0969da)', minWidth: 120, display: 'inline-block' }}>
                {cmd.name}
              </span>
              <span style={{ color: 'var(--theme-text-muted, #656d76)', fontSize: 12 }}>
                {cmd.description}
              </span>
            </div>
          ))}
          <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--theme-text-muted, #656d76)', borderTop: '1px solid var(--theme-border, rgba(0,0,0,0.08))' }}>
            ↑↓ 导航 · Tab 补全 · Enter 执行 · Esc 关闭
          </div>
        </div>
      )}

      <div
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}
      >
        <textarea
          ref={ref}
          className="chat-textarea"
          placeholder={isStreaming || seqCount > 0
            ? `继续输入，Enter 自动排队${seqCount ? ` · 待发 ${seqCount}` : ''}`
            : '输入消息… 长文本会自动收纳为附件 · @ 引用文件 · Ctrl+V 粘贴'}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onInput={handleInput}
          onPaste={handleTextPaste}
          style={{ ...textareaStyle, ...(isStreaming ? { opacity: 0.9 } : {}) }}
          rows={1}
        />
        <button onClick={handleSend} style={sendBtnStyle}
          title={isStreaming
            ? '加入序列队列'
            : seqCount > 0 ? '加入序列队列' : '发送（Enter）'}>
          {isStreaming || seqCount > 0 ? '＋' : '🚀'}
        </button>
        {isStreaming && <button onClick={onAbort} style={abortBtnStyle} title="停止当前回答">■</button>}
        <button
          onClick={toggleMic}
          disabled={voiceConversationActive}
          style={{
            ...(micActive ? micRecordingStyle : micBtnStyle),
            ...(voiceConversationActive ? { opacity: 0.38, cursor: 'not-allowed' } : {}),
          }}
          title={voiceConversationActive
            ? '实时语音对话正在使用麦克风'
            : micStatus === 'connecting'
            ? '正在连接实时语音识别…'
            : micStatus === 'reconnecting'
              ? '实时语音正在重连…'
              : micStatus === 'finalizing'
                ? '正在确认最终转写…'
                : micActive
                  ? '停止实时语音输入'
                  : '实时语音输入'}
          aria-label={voiceConversationActive
            ? '实时语音对话正在使用麦克风'
            : micActive ? '停止实时语音输入' : '开始实时语音输入'}
        >
          🎙️
        </button>
      </div>
      {(micActive || micError || micNotice) && (
        <div style={{
          marginTop: 4,
          paddingLeft: 4,
          minHeight: 16,
          fontSize: 11,
          color: micError
            ? '#f85149'
            : micNotice
              ? '#d29922'
              : 'var(--theme-text-muted)',
        }}>
          {micError || micNotice || (micStatus === 'connecting'
            ? '正在连接百炼实时语音…'
            : micStatus === 'reconnecting'
              ? '连接中断，正在恢复…'
              : micStatus === 'finalizing'
                ? '正在确认最后一句…'
                : '实时识别中，说话内容会立即写入输入框')}
        </div>
      )}

      {/* 新会话确认对话框（风格与 Sidebar 删除会话保持一致） */}
      {showNewSessionConfirm && (
        <div style={confirmOverlayStyle} onClick={() => setShowNewSessionConfirm(false)}>
          <div
            style={{ ...confirmPanelStyle, animation: 'dialogSlideIn 0.28s cubic-bezier(0.22,0.61,0.36,1)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600, color: 'var(--theme-text, #1f2328)' }}>
              开启新会话
            </h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
              当前会话的上下文将被清空，模型不再保留之前的对话内容。
            </p>
            <p style={{ fontSize: 12, color: 'var(--theme-text-muted, #656d76)', margin: '0 0 16px 0' }}>
              历史消息仍保留在侧边栏，可随时回看。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={confirmNewSession} style={confirmBtnStyle}>
                开始
              </button>
              <button onClick={() => setShowNewSessionConfirm(false)} style={cancelBtnStyle}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export const ChatInput = memo(ChatInputInner);

// ═══════════════════════════════════════
//  样式
// ═══════════════════════════════════════

const textareaStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--theme-input-bg, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  borderRadius: 7,
  color: 'var(--theme-text, #1f2328)',
  padding: 'var(--ui-message-padding, 11px 14px)',
  fontSize: 14,
  lineHeight: 1.5,
  resize: 'none',
  outline: 'none',
  fontFamily: 'inherit',
  maxHeight: 200,
  overflow: 'auto',
  boxShadow: 'inset 0 1px 1px rgba(0,0,0,.025)',
};

const btnBase: React.CSSProperties = {
  width: 'var(--ui-send-size, 38px)',
  height: 'var(--ui-send-size, 38px)',
  borderRadius: 6,
  border: '1px solid transparent',
  color: '#fff',
  fontSize: 18,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const sendBtnStyle: React.CSSProperties = { ...btnBase, background: 'var(--theme-accent, #0969da)', boxShadow: '0 5px 16px var(--theme-accent-bg)' };
const abortBtnStyle: React.CSSProperties = { ...btnBase, background: 'var(--theme-error, #cf222e)', fontSize: 14 };
const micBtnStyle: React.CSSProperties = {
  ...btnBase,
  background: 'var(--theme-bg-tertiary, #eaeef2)',
  borderColor: 'var(--theme-border)',
  color: 'var(--theme-text-muted)',
  fontSize: 16,
  padding: '0 8px',
};

const micRecordingStyle: React.CSSProperties = {
  ...btnBase,
  background: '#f85149',
  color: '#fff',
  fontSize: 16,
  padding: '0 8px',
  animation: 'mic-pulse 1.5s ease-in-out infinite',
};

const commandPopupStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: 16,
  right: 16,
  marginBottom: 4,
  background: 'var(--theme-bg-secondary, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 7,
  maxHeight: 280,
  overflowY: 'auto',
  zIndex: 100,
  boxShadow: 'var(--ui-shadow-float, 0 -4px 20px rgba(0,0,0,0.18))',
  backdropFilter: 'blur(12px)',
};

const commandItemStyle: React.CSSProperties = {
  padding: '8px 12px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  transition: 'background 0.1s',
  borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
};

const filePickerPopupStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: 16,
  right: 16,
  marginBottom: 4,
  background: 'var(--theme-bg-secondary, #f6f8fa)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  borderRadius: 7,
  overflow: 'hidden',
  maxHeight: 300,
  overflowY: 'auto',
  zIndex: 100,
  boxShadow: 'var(--ui-shadow-float, 0 -4px 20px rgba(0,0,0,0.18))',
  backdropFilter: 'blur(12px)',
};

const filePickerHeaderStyle: React.CSSProperties = {
  padding: '6px 12px',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  color: 'var(--theme-text-muted, #656d76)',
  background: 'var(--theme-bg-tertiary, #eaeef2)',
  borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
  userSelect: 'none' as const,
};

const fileItemStyle: React.CSSProperties = {
  padding: '7px 12px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  transition: 'background 0.1s',
  borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.05))',
  color: 'var(--theme-text, #1f2328)',
};

const filePickerFooterStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 10,
  color: 'var(--theme-text-muted, #656d76)',
  borderTop: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
  userSelect: 'none' as const,
};

// ── 确认对话框样式（与 Sidebar 删除会话保持一致）────────────────────────────
const confirmOverlayStyle: React.CSSProperties = {
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
  background: 'var(--theme-accent, #0969da)', border: 'none',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 5,
  background: 'var(--theme-bg-secondary, #f6f8fa)', border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  color: 'var(--theme-text, #1f2328)', fontSize: 14, cursor: 'pointer',
};

const runtimeSecondaryBtnStyle: React.CSSProperties = {
  padding: '6px 9px', borderRadius: 5, cursor: 'pointer', fontSize: 11,
  border: '1px solid var(--theme-border)', background: 'var(--theme-bg-tertiary)',
  color: 'var(--theme-text-muted)',
};

const runtimePrimaryBtnStyle: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 11,
  border: '1px solid var(--theme-accent)', background: 'var(--theme-accent)',
  color: '#fff', fontWeight: 600,
};
