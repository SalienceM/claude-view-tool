import React, { useState, useCallback, useEffect, useRef, memo, useMemo } from 'react';
import { markdownToHtml } from '../utils/markdown';
import { api, loadSkillImageDataUrl } from '../api';
import type { CurrentUserProfile } from '../api';
import type { ChatMessage, ToolCall, ContentBlock, SubagentInfo } from '../hooks/useChat';
import { shouldKeepChatMessage } from '../utils/chatMessageVisibility';
import { DiffView, type DiffData } from './DiffView';
import { TextAttachmentPreview } from './TextAttachmentPreview';
import { AppModalPortal } from './AppModalPortal';
import { resolveFileLink, type ResolvedFileLink } from '../utils/fileFocus';
import {
  TTS_STATE_EVENT,
  toggleSpeech,
  type SpeechState,
  type SpeechStatus,
} from '../utils/tts';

function formatMessageTime(timestamp: number): string {
  const epoch = timestamp > 100_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(epoch).toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatMessageDateTime(timestamp: number): string {
  const epoch = timestamp > 100_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(epoch).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

// ── 注入全局动画样式 ──
if (typeof document !== 'undefined' && !document.getElementById('msg-bubble-css')) {
  const style = document.createElement('style');
  style.id = 'msg-bubble-css';
  style.textContent = `
    @keyframes cursor-blink { 0%,100%{opacity:1} 50%{opacity:0} }
    @keyframes spin { to{transform:rotate(360deg)} }
    @keyframes pulse { 0%,100%{opacity:0.6} 50%{opacity:0.3} }
    @keyframes dots {
      0%, 20% { content: '.'; }
      40% { content: '..'; }
      60%, 100% { content: '...'; }
    }
    @keyframes msgSlideIn {
      from { opacity: 0; transform: translateY(10px) scale(0.98); }
      to   { opacity: 1; transform: translateY(0)    scale(1); }
    }
    @keyframes cursorGlow {
      0%,100% { opacity: 1; }
      50%     { opacity: 0.15; }
    }
    /* ── 气泡内图片约束 ── */
    .msg-content img {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
      display: block;
      cursor: zoom-in;
      margin: 4px 0;
    }
    /* ── 懒加载图片样式 ── */
    .msg-content img.lazy,
    .msg-content img[loading="lazy"] {
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    .msg-content img.lazy.loaded,
    .msg-content img[loading="lazy"].loaded {
      opacity: 1;
    }
    .md-image-loading,
    .md-image-error {
      min-width: 160px;
      min-height: 54px;
      width: fit-content;
      max-width: 100%;
      margin: 6px 0;
      padding: 10px 12px;
      border: 1px solid var(--theme-border, rgba(128,128,128,0.25));
      border-radius: 6px;
      background: var(--theme-bg-tertiary, rgba(128,128,128,0.08));
      color: var(--theme-text-muted, #656d76);
      font-size: 12px;
      line-height: 1.45;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
    }
    .md-image-loading {
      display: inline-flex;
      animation: pulse 1.4s ease-in-out infinite;
    }
    .md-image-error {
      display: inline-flex;
    }
    .md-image-error a {
      color: var(--theme-accent, #0969da);
      text-decoration: none;
    }
    .md-image-error a:hover {
      text-decoration: underline;
    }
    /* 文件定位提示由 Portal 浮层渲染，不参与行内排版，避免换行时 hover 抖动。 */
    .msg-content a.md-file-link {
      cursor: pointer;
      text-decoration-style: dotted;
      text-underline-offset: 2px;
      border-radius: 3px;
      transition: color .12s ease, background .12s ease, text-decoration-color .12s ease;
    }
    .msg-content a.md-file-link:hover,
    .msg-content a.md-file-link:focus-visible {
      background: var(--theme-accent-bg, rgba(9,105,218,.12));
      text-decoration-style: solid;
    }
    .file-link-menu-item:hover {
      background: var(--theme-hover-bg, rgba(128,128,128,.12)) !important;
    }
    .file-link-menu-item:focus-visible {
      outline: 2px solid var(--theme-accent, #0969da);
      outline-offset: -2px;
      background: var(--theme-accent-bg, rgba(9,105,218,.12)) !important;
    }
    .file-link-menu-icon {
      width: 34px;
      height: 34px;
      flex: 0 0 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--theme-border, rgba(128,128,128,.24));
      border-radius: 8px;
      color: var(--theme-accent, #0969da);
      background: var(--theme-accent-bg, rgba(9,105,218,.10));
      transition: transform .14s ease, border-color .14s ease, background .14s ease;
    }
    .file-link-menu-item:hover .file-link-menu-icon,
    .file-link-menu-item:focus-visible .file-link-menu-icon {
      transform: scale(1.06);
      border-color: var(--theme-accent, #0969da);
      background: color-mix(in srgb, var(--theme-accent, #0969da) 16%, transparent);
    }
    /* ── 气泡操作按钮 ── */
    .bubble-action-btn {
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .message-bubble-wrapper:hover .bubble-action-btn {
      opacity: 1;
    }
    /* ── 代码块复制按钮 ── */
    pre.md-pre {
      position: relative;
    }
    .code-copy-btn {
      position: absolute;
      bottom: 6px;
      right: 6px;
      padding: 2px 8px;
      font-size: 11px;
      line-height: 1.6;
      border-radius: 4px;
      border: 1px solid rgba(128,128,128,0.35);
      background: rgba(255,255,255,0.12);
      color: rgba(200,200,200,0.85);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
      font-family: inherit;
      user-select: none;
    }
    pre.md-pre:hover .code-copy-btn {
      opacity: 1;
    }
    .code-copy-btn.copied {
      color: #3fb950;
      border-color: #3fb95066;
      background: rgba(63,185,80,0.12);
      opacity: 1;
    }
    /* ── 图片懒加载占位符 ── */
    .img-lazy-placeholder {
      background: linear-gradient(135deg, rgba(128,128,128,0.1) 25%, transparent 25%, transparent 50%, rgba(128,128,128,0.1) 50%, rgba(128,128,128,0.1) 75%, transparent 75%, transparent);
      background-size: 20px 20px;
      min-height: 80px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(128,128,128,0.5);
      font-size: 12px;
    }
    .img-lazy-placeholder img {
      max-height: 200px;
      border-radius: 8px;
      display: none; /* 隐藏真实图片，等加载后再显示 */
    }
    .img-lazy-placeholder.loaded img {
      display: block;
      animation: msgSlideIn 0.2s ease-out;
    }
    .img-lazy-placeholder img.lazy {
      display: block;
    }
  `;
  document.head.appendChild(style);
}

// ═══════════════════════════════════════
//  ImageLightbox — 点击放大预览
// ═══════════════════════════════════════
const ImageLightbox: React.FC<{ src: string; onClose: () => void }> = ({ src, onClose }) => {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'zoom-out',
      }}
    >
      <div style={{
        position: 'relative',
        maxWidth: '92vw', maxHeight: '92vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {!loaded && (
          <div className="img-lazy-placeholder" style={{
            width: '200px', height: '200px',
            background: 'linear-gradient(135deg, rgba(128,128,128,0.1) 25%, transparent 25%, transparent 50%, rgba(128,128,128,0.1) 50%, rgba(128,128,128,0.1) 75%, transparent 75%, transparent)',
            backgroundSize: '20px 20px',
          }}>
            <span>Loading...</span>
          </div>
        )}
        <img
          src={src}
          alt="preview"
          onClick={(e) => e.stopPropagation()}
          onLoad={() => setLoaded(true)}
          style={{
            maxWidth: '92vw', maxHeight: '92vh',
            borderRadius: 8,
            boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
            cursor: 'default',
            display: loaded ? 'block' : 'none',
          }}
        />
      </div>
      <button
        onClick={onClose}
        style={{
          position: 'fixed', top: 16, right: 20,
          background: 'rgba(255,255,255,0.15)', border: 'none',
          color: '#fff', fontSize: 22, lineHeight: 1,
          width: 36, height: 36, borderRadius: '50%',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >×</button>
    </div>
  );
};

// ═══════════════════════════════════════
//  ThinkingBlock
// ═══════════════════════════════════════
const ThinkingBlock: React.FC<{ content: string; isThinking?: boolean }> = memo(function ThinkingBlock({
  content,
  isThinking,
}) {
  const [expanded, setExpanded] = useState(false);
  if (!content && !isThinking) return null;
  return (
    <div style={sectionBox}>
      <div onClick={() => setExpanded(!expanded)} style={sectionHeader}>
        <span style={{ ...chevron, transform: expanded ? 'rotate(90deg)' : 'none' }}>▶</span>
        <span style={{ opacity: 0.7 }}>💭</span>
        <span>{isThinking ? 'Thinking…' : 'Thinking'}</span>
        {!expanded && content && (
          <span style={previewText}>
            {content.slice(0, 100)}
            {content.length > 100 ? '…' : ''}
          </span>
        )}
        {isThinking && <span style={spinnerStyle} />}
      </div>
      {expanded && (
        <div style={sectionBody}>
          <div style={{ whiteSpace: 'pre-wrap', color: 'var(--theme-text, #1f2328)' }}>
            {content || '(thinking...)'}
          </div>
        </div>
      )}
    </div>
  );
});

// ═══════════════════════════════════════
//  ToolCallBlock
// ═══════════════════════════════════════
const STATUS_COLOR: Record<string, string> = {
  running: '#58a6ff',     // GitHub blue, matches midnight accent
  done: '#3fb950',        // GitHub green, softer on eyes
  error: '#f85149',       // GitHub red, consistent saturation
};
const STATUS_ICON: Record<string, string> = {
  running: '⏳',
  done: '✅',
  error: '❌',
};

/** 尝试从 Edit/MultiEdit/Write 工具的 input JSON 中解析出 diff 数据 */
function tryParseDiffFromInput(tc: ToolCall): DiffData | null {
  if (!tc.input) return null;
  const isEditTool = /^(Edit|MultiEdit|Write)$/i.test(tc.name || '');
  if (!isEditTool) return null;
  try {
    const inp = JSON.parse(tc.input);
    const oldStr = inp.old_string ?? inp.oldString ?? '';
    const newStr = inp.new_string ?? inp.newString ?? '';
    const filePath = inp.file_path ?? inp.filePath ?? inp.path ?? '';
    if (oldStr || newStr) {
      return { path: filePath, old: oldStr, new: newStr };
    }
  } catch {
    // input 不是合法 JSON，跳过
  }
  return null;
}

// ── Subagent 卡片 ─────────────────────────────────────────────────
//   把零散的 description / 状态 / usage / lastToolName / summary 等字段
//   组织成两行 + 时间线的卡片,让用户一眼看清楚子 agent 在干什么、跑得怎么样。

const chipPillStyle = (accent: string): React.CSSProperties => ({
  fontSize: 10,
  padding: '1px 7px',
  borderRadius: 10,
  background: `${accent}1c`,
  color: accent,
  fontWeight: 600,
  letterSpacing: 0.2,
});

/** 工具名 → 短图标。匹配不到就回退到通用扳手。 */
function toolIcon(name: string): string {
  const n = (name || '').toLowerCase();
  if (n === 'read' || n === 'glob' || n === 'grep') return '🔍';
  if (n === 'edit' || n === 'multiedit' || n === 'write') return '✏️';
  if (n === 'bash') return '💻';
  if (n.startsWith('web')) return '🌐';
  if (n === 'task') return '🤖';
  if (n.startsWith('notebook')) return '📓';
  if (n.startsWith('mcp__')) return '🔌';
  return '🔧';
}

const SubagentCard: React.FC<{
  subagent: SubagentInfo;
  childTools: ToolCall[];
  accent: string;
  formatDuration: (ms?: number) => string | null;
}> = memo(function SubagentCard({ subagent, childTools, accent, formatDuration }) {
  const isRunning = subagent.status === 'running' || !subagent.status;
  const isFailed = subagent.status === 'failed' || subagent.status === 'stopped';
  const doneCount = childTools.filter((t) => t.status === 'done').length;
  const totalCount = childTools.length;
  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const usage = subagent.usage;
  const usageItems: string[] = [];
  if (usage?.toolUses !== undefined) usageItems.push(`🔧 ${usage.toolUses}`);
  else if (totalCount > 0) usageItems.push(`🔧 ${totalCount}`);
  if (usage?.totalTokens !== undefined) usageItems.push(`${usage.totalTokens.toLocaleString()} tok`);
  if (usage?.durationMs !== undefined) usageItems.push(`⏱ ${formatDuration(usage.durationMs)}`);

  return (
    <div
      style={{
        marginBottom: 10,
        padding: '10px 12px',
        borderRadius: 8,
        // 透明内部,只靠左侧 accent 竖条做视觉锚点,不挡背景图
        background: 'transparent',
        borderLeft: `3px solid ${accent}`,
        fontSize: 12,
        color: 'var(--theme-text, #1f2328)',
      }}
    >
      {/* 标题行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: accent, fontSize: 11, letterSpacing: 0.4 }}>
          {isFailed ? 'SUBAGENT · 失败' : isRunning ? 'SUBAGENT · 运行中' : 'SUBAGENT · 完成'}
        </span>
        {subagent.taskType && (
          <span style={chipPillStyle(accent)}>{subagent.taskType}</span>
        )}
        {usageItems.length > 0 && (
          <span style={{
            marginLeft: 'auto',
            display: 'flex', gap: 8,
            color: 'var(--theme-text-muted, #656d76)',
            fontSize: 11,
            fontFamily: 'monospace',
          }}>
            {usageItems.map((it, i) => <span key={i}>{it}</span>)}
          </span>
        )}
      </div>
      {/* 描述行 */}
      {subagent.description && (
        <div style={{ marginTop: 6, fontWeight: 500, lineHeight: 1.5 }}>
          {subagent.description}
        </div>
      )}
      {/* 进度条:有 child tools 才显示 */}
      {totalCount > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: 10, color: 'var(--theme-text-muted, #656d76)',
            marginBottom: 3,
          }}>
            <span>进度</span>
            <span>{doneCount}/{totalCount}</span>
          </div>
          <div style={{
            height: 4,
            background: 'var(--theme-bg, rgba(0,0,0,0.05))',
            borderRadius: 2,
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${progressPct}%`,
              height: '100%',
              background: accent,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}
      {/* 工具时间线(chip 行) */}
      {totalCount > 0 && (
        <div style={{
          marginTop: 8,
          display: 'flex', flexWrap: 'wrap', gap: 4,
        }}>
          {childTools.map((t, i) => {
            const c = STATUS_COLOR[t.status] || '#888';
            return (
              <span
                key={`chip-${t.id || t.name}-${i}`}
                title={`${t.name}${t.status ? ' · ' + t.status : ''}${t.duration !== undefined ? ' · ' + formatDuration(t.duration) : ''}`}
                style={{
                  fontSize: 10,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: `${c}15`,
                  border: `1px solid ${c}40`,
                  color: 'var(--theme-text, #1f2328)',
                  fontFamily: 'monospace',
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  maxWidth: 160,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                <span>{toolIcon(t.name)}</span>
                <span>{t.name}</span>
              </span>
            );
          })}
        </div>
      )}
      {/* 「正在:xxx」运行中的活动指示 */}
      {isRunning && subagent.lastToolName && (
        <div style={{
          marginTop: 6, fontSize: 11,
          color: 'var(--theme-text-muted, #656d76)',
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <span style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            background: accent, animation: 'cursorGlow 1s ease-in-out infinite',
          }} />
          正在执行: <code style={{ fontSize: 11 }}>{subagent.lastToolName}</code>
        </div>
      )}
      {/* 小结(done) */}
      {subagent.summary && (
        <div style={{
          marginTop: 8,
          padding: '8px 10px',
          borderRadius: 6,
          background: 'transparent',
          border: `1px solid ${accent}55`,
          lineHeight: 1.5,
        }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: accent,
            letterSpacing: 0.3, marginBottom: 4,
          }}>📝 小结</div>
          {subagent.summary}
        </div>
      )}
      {/* 输出文件 */}
      {subagent.outputFile && (
        <div style={{
          marginTop: 6, fontSize: 11,
          color: 'var(--theme-text-muted, #656d76)',
        }}>
          📂 output: <code style={{ fontSize: 11 }}>{subagent.outputFile}</code>
        </div>
      )}
    </div>
  );
});

/**
 * 仅把“输出整体就是图片 Markdown”的工具结果识别成图片。
 *
 * Shell/搜索工具经常会打印源码、日志或 Session JSON，其中可能只是文本性地
 * 出现 `![alt](url)`。旧逻辑会把这些历史链接二次渲染到消息末尾，造成凭空
 * 出现的破损图片。Backend 图片 Skill 的正式结果本来就是一行或多行纯图片
 * Markdown，因此采用 fail-closed 判定不会影响正常图片直出。
 */
function extractImagesFromOutput(output: string): { images: Array<{src: string; alt: string}>; text: string } {
  const images: Array<{src: string; alt: string}> = [];
  // Match markdown image: ![alt](url)
  const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  let lastEnd = 0;
  const textParts: string[] = [];
  while ((match = regex.exec(output)) !== null) {
    if (match.index > lastEnd) {
      textParts.push(output.slice(lastEnd, match.index));
    }
    images.push({ alt: match[1], src: match[2] });
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < output.length) {
    textParts.push(output.slice(lastEnd));
  }
  const remainingText = textParts.join('').trim();
  const allSourcesRenderable = images.every(({ src }) => (
    /^(?:https?:\/\/|data:image\/|blob:|\/api\/skill-images\/)/i.test(src.trim())
  ));
  if (images.length === 0 || remainingText || !allSourcesRenderable) {
    return { images: [], text: output };
  }
  return { images, text: '' };
}

const ToolOutputImage: React.FC<{
  src: string;
  alt: string;
  onOpen: (src: string) => void;
}> = ({ src, alt, onOpen }) => {
  const isSkillImage = /\/api\/skill-images\//.test(src);
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>(
    isSkillImage ? 'loading' : 'ready',
  );
  const [resolvedSrc, setResolvedSrc] = useState<string>(isSkillImage ? '' : src);

  useEffect(() => {
    const match = src.match(/\/api\/skill-images\/([^/?#"'\s]+)/);
    if (!match) {
      setResolvedSrc(src);
      setImageState('ready');
      return;
    }
    let cancelled = false;
    setResolvedSrc('');
    setImageState('loading');
    loadSkillImageDataUrl(decodeURIComponent(match[1]))
      .then((dataUrl) => {
        if (!cancelled) {
          setResolvedSrc(dataUrl);
          setImageState('ready');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedSrc('');
          setImageState('error');
        }
      });
    return () => { cancelled = true; };
  }, [src]);

  if (imageState === 'loading') {
    return <div className="img-lazy-placeholder" style={{ width: 160, height: 90 }}>图片加载中…</div>;
  }
  if (imageState === 'error' || !resolvedSrc) {
    return (
      <div className="md-image-error" role="status">
        🖼️ {alt || '图片'}暂不可用
      </div>
    );
  }
  return (
    <img
      src={resolvedSrc}
      alt={alt || 'generated image'}
      style={{
        maxWidth: '100%', maxHeight: 480, borderRadius: 8,
        cursor: 'zoom-in', border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
        display: 'block',
      }}
      onError={() => setImageState('error')}
      onClick={() => onOpen(resolvedSrc)}
    />
  );
};

const ToolCallBlock: React.FC<{ tc: ToolCall; allTools?: ToolCall[] }> = memo(function ToolCallBlock({ tc, allTools }) {
  // ★ 从 tool output 中提取 markdown 图片，支持 generate-image 等 skill 结果
  const { text: outputText } = tc.output ? extractImagesFromOutput(tc.output) : { text: '' };

  // ★ Task（子 agent 派发器）默认展开，让用户看到子 agent 正在干什么
  const isTask = tc.name === 'Task';
  const subagent = tc.subagent;
  const childTools = (isTask && tc.id && allTools)
    ? allTools.filter((t) => t.parentToolUseId === tc.id)
    : [];

  // 有图片、是 Task、或有子工具时默认展开
  const [expanded, setExpanded] = useState(isTask || childTools.length > 0);

  // ★ 流式阶段：tc.output 到达时（从空变为含图片）自动展开
  const color = STATUS_COLOR[tc.status] || '#888';
  const isRunning = tc.status === 'running';

  // ★ 优先用后端注入的 diff，否则从 input JSON 中解析
  const diffData: DiffData | null = tc.diff || tryParseDiffFromInput(tc);

  // Format duration for display
  const formatDuration = (ms?: number) => {
    if (ms === undefined) return null;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  // Task 工具:子 agent 派发器。这种情况下整个卡片要做得更醒目,head/body 都
  // 走专门的路径,让用户一眼看出「这是一个子 agent 工作流,不是一次普通工具调用」。
  // 普通工具仍走原渲染。
  const taskAccent = tc.status === 'error' ? STATUS_COLOR.error
    : tc.status === 'done' ? STATUS_COLOR.done
    : STATUS_COLOR.running;
  // Task 卡片只换边框颜色 + 加粗,不加任何底色/渐变,避免把背景图盖掉。
  const taskBoxStyle: React.CSSProperties = isTask ? {
    ...sectionBox,
    border: `1.5px solid ${taskAccent}88`,
  } : sectionBox;

  return (
    <div style={taskBoxStyle}>
      <div onClick={() => setExpanded(!expanded)} style={sectionHeader}>
        <span style={{ ...chevron, transform: expanded ? 'rotate(90deg)' : 'none' }}>▶</span>
        {isTask ? (
          <>
            <span style={{ fontSize: 14 }}>🤖</span>
            <span style={{ fontWeight: 700, color: taskAccent, letterSpacing: 0.3 }}>SUBAGENT</span>
            {subagent?.description && (
              <span
                style={{
                  color: 'var(--theme-text, #1f2328)',
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 360,
                }}
                title={subagent.description}
              >
                {subagent.description}
              </span>
            )}
            {childTools.length > 0 && (
              <span style={chipPillStyle(taskAccent)}>
                {childTools.length} tools
              </span>
            )}
          </>
        ) : (
          <>
            <span>{STATUS_ICON[tc.status] || '🔧'}</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{tc.name}</span>
          </>
        )}
        {isRunning && <span style={spinnerStyle} />}
        <span
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            whiteSpace: 'nowrap',
            fontSize: 10,
            padding: '1px 6px',
            borderRadius: 4,
            background: `${color}22`,
            color,
          }}
        >
          {tc.status}
          {tc.duration !== undefined && ` · ${formatDuration(tc.duration)}`}
        </span>
      </div>
      {expanded && (
        <div style={sectionBody}>
          {/* ★ Task 子 agent:富信息卡片(描述 / 状态 / 工具时间线 / 小结) */}
          {isTask && subagent && (
            <SubagentCard
              subagent={subagent}
              childTools={childTools}
              accent={taskAccent}
              formatDuration={formatDuration}
            />
          )}
          {/* ★ Edit/Write 工具优先展示 Diff 视图，支持后端注入和前端解析两种来源 */}
          {diffData ? (
            <DiffView diff={diffData} />
          ) : (
            tc.input && !isTask && (
              <div style={{ marginBottom: 6 }}>
                <div style={labelStyle}>INPUT</div>
                <pre style={codeBlock}>{tc.input}</pre>
              </div>
            )
          )}
          {/* ★ 子 agent 内部工具:缩进嵌套卡片;时间线 chip 行由 SubagentCard 渲染 */}
          {childTools.length > 0 && (
            <div
              style={{
                marginTop: 6,
                paddingLeft: 12,
                borderLeft: `2px solid ${taskAccent}66`,
              }}
            >
              <div style={{ ...labelStyle, marginBottom: 4 }}>展开 ({childTools.length})</div>
              {childTools.map((child, i) => (
                <ToolCallBlock key={`child-${child.id || child.name}-${i}`} tc={child} allTools={allTools} />
              ))}
            </div>
          )}
          {outputText && (
            <div style={{ marginTop: diffData ? 6 : 0 }}>
              <div style={labelStyle}>OUTPUT</div>
              {/* ★ 如果 output 中包含 markdown 图片（如 generate-image skill 结果），优先渲染图片 */}
              {/* 剩余文本（进度提示等非图片内容） */}
              {outputText && (
                <pre
                  style={{
                    ...codeBlock,
                    color: tc.status === 'error' ? 'var(--theme-error, #cf222e)' : 'var(--theme-text, #1f2328)',
                    maxHeight: 300,
                  }}
                >
                  {outputText}
                </pre>
              )}
            </div>
          )}
          {isRunning && !tc.output && (
            <div style={{ fontSize: 11, color: 'var(--theme-text, #1f2328)', padding: '4px 0' }}>
              Waiting for result...
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ═══════════════════════════════════════
//  ★ SystemMessage — 系统/命令消息
// ═══════════════════════════════════════
const SystemMessage: React.FC<{ message: ChatMessage; renderMarkdown?: boolean }> = ({
  message,
  renderMarkdown = true,
}) => {
  const contentHtml =
    renderMarkdown && message.content ? markdownToHtml(message.content) : null;

  return (
    <div style={{ padding: '6px 16px', display: 'flex', justifyContent: 'center' }}>
      <div style={systemBubbleStyle}>
        {contentHtml ? (
          <div dangerouslySetInnerHTML={{ __html: contentHtml }} />
        ) : (
          <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
        )}
        {message.timestamp && (
          <div title={formatMessageDateTime(message.timestamp)} style={{ fontSize: 10, color: 'var(--theme-text-muted, #656d76)', marginTop: 4, textAlign: 'right' }}>
            {formatMessageTime(message.timestamp)}
          </div>
        )}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════
//  MessageBubble — 主组件
// ═══════════════════════════════════════
interface Props {
  message: ChatMessage;
  currentUser?: CurrentUserProfile;
  fontSize?: number;
  renderMarkdown?: boolean;
  animateIn?: boolean;
  sessionId?: string;
  canBranch?: boolean;
  ttsVoice?: string;
  ttsRate?: number;
  workingDir?: string;
  onFocusFile?: (relativePath: string) => void;
  onRedoMessage?: (message: ChatMessage) => void | Promise<void>;
}

// 复制气泡内容到剪贴板
const copyToClipboard = async (content: string) => {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    // Fallback: 使用传统的 execCommand 方式
    const textarea = document.createElement('textarea');
    textarea.value = content;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
};

// 气泡操作菜单组件
const BubbleActionMenu: React.FC<{
  message: ChatMessage;
  sessionId?: string;
  canBranch?: boolean;
  ttsVoice?: string;
  ttsRate?: number;
  onRedoMessage?: (message: ChatMessage) => void | Promise<void>;
}> = ({ message, sessionId, canBranch, ttsVoice, ttsRate, onRedoMessage }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedFull, setCopiedFull] = useState(false);
  const [branching, setBranching] = useState(false);
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>('idle');
  const [speechError, setSpeechError] = useState('');

  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const copyFullTimerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { clearTimeout(copyTimerRef.current); clearTimeout(copyFullTimerRef.current); }, []);

  useEffect(() => {
    const handleState = (event: Event) => {
      const state = (event as CustomEvent<SpeechState>).detail;
      if (state.messageId !== message.id) {
        if (state.status === 'playing' || state.status === 'loading') {
          setSpeechStatus('idle');
          setSpeechError('');
        }
        return;
      }
      setSpeechStatus(state.status);
      setSpeechError(state.error || '');
    };
    window.addEventListener(TTS_STATE_EVENT, handleState);
    return () => window.removeEventListener(TTS_STATE_EVENT, handleState);
  }, [message.id]);

  const handleSpeech = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    setSpeechError('');
    await toggleSpeech(
      message.id,
      message.content || '',
      ttsVoice || 'zh-CN-XiaoxiaoNeural',
      ttsRate ?? 0,
    );
  }, [message.id, message.content, ttsVoice, ttsRate]);

  const handleCopy = useCallback(async () => {
    const success = await copyToClipboard(message.content || '');
    if (success) {
      setCopied(true);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }
    setMenuOpen(false);
  }, [message.content]);

  const handleCopyFull = useCallback(async () => {
    // 构建完整内容：thinking + tool calls + text
    const parts: string[] = [];
    // Thinking
    const thinking = message.thinking ||
      (message as any).thinkingBlocks?.map((b: any) => b.content).join('\n\n') || '';
    if (thinking) {
      parts.push(`[Thinking]\n${thinking}`);
    }
    // Tool calls
    if ((message as any).toolCalls) {
      for (const tc of (message as any).toolCalls) {
        let toolSection = `[Tool: ${tc.name || 'unknown'}]`;
        if (tc.input) toolSection += `\nINPUT: ${tc.input}`;
        if (tc.output) toolSection += `\nOUTPUT: ${tc.output}`;
        if (tc.status) toolSection += `\nSTATUS: ${tc.status}`;
        parts.push(toolSection);
      }
    }
    if (message.textAttachments?.length) {
      for (const attachment of message.textAttachments) {
        parts.push(
          `[文本附件: ${attachment.name}]\n${attachment.content}`,
        );
      }
    }
    // Text content
    if (message.content) {
      parts.push(message.content);
    }
    const fullText = parts.join('\n\n');
    const success = await copyToClipboard(fullText);
    if (success) {
      setCopiedFull(true);
      clearTimeout(copyFullTimerRef.current);
      copyFullTimerRef.current = setTimeout(() => setCopiedFull(false), 2000);
    }
    setMenuOpen(false);
  }, [message]);

  const handleRedo = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setMenuOpen(false);
    if (message.role !== 'user' || !onRedoMessage) return;
    void onRedoMessage(message);
  }, [message, onRedoMessage]);


  const handleBranch = useCallback(async () => {
    if (!sessionId || message.role !== 'assistant') return;
    setBranching(true);
    try {
      const res = await api.branchSession(sessionId, message.id);
      if (res?.status === 'ok') {
        window.dispatchEvent(new CustomEvent('awu-session-branched', { detail: res.session }));
        alert(`已创建分支会话：${res.session?.title || res.session?.id || ''}`);
      } else {
        alert(res?.message || '创建分支失败');
      }
    } catch (e: any) {
      alert(e?.message || String(e));
    } finally {
      setBranching(false);
      setMenuOpen(false);
    }
  }, [message.id, message.role, sessionId]);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.bubble-action-menu')) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  return (
    <div className="bubble-action-menu" style={{
      position: 'absolute',
      bottom: 6,
      right: 6,
      zIndex: 100,
      display: 'flex',
      gap: 4,
    }}>
      {message.role === 'assistant' && !message.streaming && !!message.content?.trim() && (
        <button
          onClick={handleSpeech}
          title={
            speechStatus === 'playing' ? '停止朗读'
              : speechStatus === 'loading' ? '正在生成语音…'
                : speechError || '朗读回答'
          }
          className="bubble-action-btn"
          style={{
            width: 28,
            height: 20,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--theme-bg-tertiary, #fff)',
            border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
            borderRadius: 4,
            cursor: speechStatus === 'loading' ? 'wait' : 'pointer',
            color: speechError
              ? 'var(--theme-error, #f85149)'
              : 'var(--theme-text-muted, #656d76)',
            fontSize: 12,
            lineHeight: 1,
            opacity: speechStatus === 'idle' && !speechError ? undefined : 1,
          }}
        >
          {speechStatus === 'loading' ? '…' : speechStatus === 'playing' ? '■' : speechError ? '⚠' : '🔊'}
        </button>
      )}
      {/* 三点菜单按钮（横向） */}
      <button
        onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
        title="操作菜单"
        className="bubble-action-btn"
        style={{
          width: 28,
          height: 20,
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--theme-bg-tertiary, #fff)',
          border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
          borderRadius: 4,
          cursor: 'pointer',
          color: 'var(--theme-text-muted, #656d76)',
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        ⋯
      </button>

      {/* 上弹菜单 */}
      {menuOpen && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          right: 0,
          marginBottom: 4,
          minWidth: 120,
          background: 'var(--theme-bg-tertiary, #fff)',
          border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
          borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          overflow: 'hidden',
        }}>
          {message.role === 'user' && onRedoMessage && (
            <button
              onClick={handleRedo}
              title="将这条用户消息作为新消息再发送一次"
              style={{
                width: '100%',
                padding: '8px 12px',
                background: 'none',
                border: 'none',
                borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--theme-text, #1f2328)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>↻</span>
              <span>Redo · 再发一次</span>
            </button>
          )}
          <button
            onClick={handleCopy}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: 'none',
              border: 'none',
              borderBottom: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
              textAlign: 'left',
              cursor: 'pointer',
              fontSize: 12,
              color: copied ? 'var(--theme-success, #3fb950)' : 'var(--theme-text, #1f2328)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>{copied ? '✓' : '📋'}</span>
            <span>{copied ? '已复制' : '复制内容'}</span>
          </button>
          <button
            onClick={handleCopyFull}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: 'none',
              border: 'none',
              textAlign: 'left',
              cursor: 'pointer',
              fontSize: 12,
              color: copiedFull ? 'var(--theme-success, #3fb950)' : 'var(--theme-text, #1f2328)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>{copiedFull ? '✓' : '📑'}</span>
            <span>{copiedFull ? '已复制' : '复制完整信息'}</span>
          </button>
          {canBranch && message.role === 'assistant' && (
            <button
              onClick={handleBranch}
              disabled={branching}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: 'none',
                border: 'none',
                borderTop: '1px solid var(--theme-border, rgba(0,0,0,0.08))',
                textAlign: 'left',
                cursor: branching ? 'wait' : 'pointer',
                fontSize: 12,
                color: 'var(--theme-text, #1f2328)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>🌿</span>
              <span>{branching ? '创建中…' : '从此创建分支'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

function MessageBubbleInner({
  message,
  currentUser,
  fontSize = 14,
  renderMarkdown = true,
  animateIn = false,
  sessionId,
  canBranch = false,
  ttsVoice,
  ttsRate,
  workingDir,
  onFocusFile,
  onRedoMessage,
}: Props) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [fileLinkMenu, setFileLinkMenu] = useState<{
    x: number;
    y: number;
    relativePath: string;
    filePath: string;
  } | null>(null);
  const [fileLinkHover, setFileLinkHover] = useState<{
    x: number;
    y: number;
    relativePath: string;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // React 流式更新可能在 MutationObserver 两次回调之间替换链接节点。
  // 这里既供批量 hydrate 使用，也在真实 pointer/focus 事件发生时即时兜底，
  // 从而不会因为增强时序而偶发漏掉文件链接。
  const enhanceFileLink = useCallback((anchor: HTMLAnchorElement): ResolvedFileLink | null => {
    anchor.classList.remove('md-file-link');
    delete anchor.dataset.fileRel;
    delete anchor.dataset.filePath;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    anchor.removeAttribute('title');
    anchor.removeAttribute('aria-description');

    const resolved = resolveFileLink(anchor.getAttribute('href') || '', workingDir || '');
    if (!resolved || !onFocusFile) return null;

    anchor.classList.add('md-file-link');
    anchor.dataset.fileRel = resolved.relativePath;
    anchor.dataset.filePath = resolved.filePath;
    anchor.removeAttribute('target');
    anchor.removeAttribute('rel');
    const position = resolved.line
      ? `（第 ${resolved.line}${resolved.column ? `:${resolved.column}` : ''} 行）`
      : '';
    anchor.setAttribute('aria-description', `点击在文件面板中定位${position}；右键查看更多操作`);
    return resolved;
  }, [onFocusFile, workingDir]);

  const resolveFileLinkHit = useCallback((target: EventTarget | null) => {
    const node = target instanceof Node ? target : null;
    const element = node instanceof Element ? node : node?.parentElement;
    const anchor = element?.closest<HTMLAnchorElement>('a.md-link');
    if (!anchor || !contentRef.current?.contains(anchor)) return null;
    const resolved = enhanceFileLink(anchor);
    return resolved ? { anchor, resolved } : null;
  }, [enhanceFileLink]);

  const showFileLinkHover = useCallback((anchor: HTMLAnchorElement, resolved: ResolvedFileLink) => {
    const rect = anchor.getBoundingClientRect();
    const tooltipWidth = 196;
    const tooltipHeight = 49;
    const gap = 7;
    const x = Math.max(
      8,
      Math.min(rect.left + rect.width / 2 - tooltipWidth / 2, window.innerWidth - tooltipWidth - 8),
    );
    const below = rect.bottom + gap;
    const y = below + tooltipHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, rect.top - tooltipHeight - gap);
    setFileLinkHover({ x, y, relativePath: resolved.relativePath });
  }, []);

  // 委托捕获气泡内 Markdown 文件链接和图片点击。
  const handleContentClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const hit = resolveFileLinkHit(e.target);
    if (hit && onFocusFile) {
      e.preventDefault();
      e.stopPropagation();
      setFileLinkHover(null);
      setFileLinkMenu(null);
      onFocusFile(hit.resolved.relativePath);
      return;
    }
    if (target.tagName === 'IMG') {
      setLightboxSrc((target as HTMLImageElement).src);
    }
  }, [onFocusFile, resolveFileLinkHit]);

  const handleFileLinkPointerOver = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const hit = resolveFileLinkHit(e.target);
    if (!hit) return;
    if (e.relatedTarget instanceof Node && hit.anchor.contains(e.relatedTarget)) return;
    showFileLinkHover(hit.anchor, hit.resolved);
  }, [resolveFileLinkHit, showFileLinkHover]);

  const handleFileLinkPointerOut = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const hit = resolveFileLinkHit(e.target);
    if (!hit) return;
    if (e.relatedTarget instanceof Node && hit.anchor.contains(e.relatedTarget)) return;
    setFileLinkHover(null);
  }, [resolveFileLinkHit]);

  const handleFileLinkFocus = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const hit = resolveFileLinkHit(e.target);
    if (hit) showFileLinkHover(hit.anchor, hit.resolved);
  }, [resolveFileLinkHit, showFileLinkHover]);

  const handleFileLinkBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const hit = resolveFileLinkHit(e.target);
    if (!hit) return;
    if (e.relatedTarget instanceof Node && hit.anchor.contains(e.relatedTarget)) return;
    setFileLinkHover(null);
  }, [resolveFileLinkHit]);

  const handleFileLinkContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const hit = resolveFileLinkHit(e.target);
    if (!hit || !onFocusFile) return;
    e.preventDefault();
    e.stopPropagation();
    setFileLinkHover(null);
    setFileLinkMenu({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 316)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 174)),
      relativePath: hit.resolved.relativePath,
      filePath: hit.resolved.filePath,
    });
  }, [onFocusFile, resolveFileLinkHit]);

  useEffect(() => {
    if (!fileLinkMenu) return;
    const close = () => setFileLinkMenu(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [fileLinkMenu]);

  useEffect(() => {
    if (!fileLinkHover) return;
    const close = () => setFileLinkHover(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [fileLinkHover]);

  // ★ 为该消息内所有 markdown 块统一注入复制按钮并处理图片。
  // contentRef 指向整个气泡而不是某个 text block，避免多块消息只命中最后一块。
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const selectAll = <T extends Element,>(root: ParentNode, selector: string): T[] => {
      const self = root instanceof Element && root.matches(selector) ? [root as T] : [];
      return [...self, ...Array.from(root.querySelectorAll<T>(selector))];
    };
    const hydrate = (root: ParentNode) => {
    const pres = selectAll<HTMLElement>(root, '.msg-content pre.md-pre');
    pres.forEach(pre => {
      if (pre.querySelector('.code-copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.textContent = '复制';
      btn.title = '复制代码';
      btn.onclick = async (e) => {
        e.stopPropagation();
        const code = pre.querySelector('code');
        if (!code) return;
        // 克隆后移除语言标签，避免语言名混入复制内容
        const clone = code.cloneNode(true) as HTMLElement;
        clone.querySelector('.md-code-lang')?.remove();
        await copyToClipboard(clone.textContent?.trimEnd() ?? '');
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '复制';
          btn.classList.remove('copied');
        }, 2000);
      };
      pre.appendChild(btn);
    });

    // 只增强当前 Session 工作目录内的文件链接；网页链接仍按原逻辑新窗口打开。
    selectAll<HTMLAnchorElement>(root, '.msg-content a.md-link').forEach((anchor) => {
      enhanceFileLink(anchor);
    });

    const renderImageError = (img: HTMLImageElement, label: string, href = '') => {
      if (!img.isConnected || img.dataset.imageFailed === '1') return;
      img.dataset.imageFailed = '1';
      img.hidden = true;
      const fallback = document.createElement('span');
      fallback.className = 'md-image-error';
      const safeHref = /^https?:\/\//i.test(href) ? href : '';
      if (safeHref) {
        const link = document.createElement('a');
        link.href = safeHref;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = `🖼️ ${label || '图片'}加载失败，打开原链接`;
        fallback.appendChild(link);
      } else {
        fallback.textContent = `🖼️ ${label || '图片'}暂不可用`;
      }
      img.insertAdjacentElement('afterend', fallback);
    };

    // 普通外链图片：失败后给出稳定文本状态，不暴露浏览器破损图标。
    selectAll<HTMLImageElement>(root, '.msg-content img:not(.skill-img)').forEach((img) => {
      if (img.dataset.imageBound === '1') return;
      img.dataset.imageBound = '1';
      if (!img.hasAttribute('loading')) img.loading = 'lazy';
      const markLoaded = () => img.classList.add('loaded');
      const markFailed = () => renderImageError(img, img.alt, img.currentSrc || img.src);
      if (img.complete) {
        if (img.naturalWidth > 0) markLoaded();
        else markFailed();
      } else {
        img.addEventListener('load', markLoaded, { once: true });
        img.addEventListener('error', markFailed, { once: true });
      }
    });

    // Skill 图片走数据通道，兼容本地直连 / 中继 / QWebChannel。加载期间先隐藏
    // 无 src 的 img，RPC 失败时保留可读占位，避免出现破损图标。
    selectAll<HTMLImageElement>(root, '.msg-content img.skill-img[data-skill-file]').forEach((img) => {
      if (img.dataset.skillState) return;
      const file = img.dataset.skillFile;
      if (!file) return;
      img.dataset.skillState = 'loading';
      img.hidden = true;
      const placeholder = document.createElement('span');
      placeholder.className = 'md-image-loading';
      placeholder.textContent = `🖼️ ${img.alt ? `${img.alt} · ` : ''}图片加载中…`;
      img.insertAdjacentElement('afterend', placeholder);

      const fail = () => {
        if (!img.isConnected) return;
        img.dataset.skillState = 'error';
        placeholder.className = 'md-image-error';
        placeholder.textContent = `🖼️ ${img.alt || '图片'}暂不可用`;
      };
      const reveal = () => {
        if (!img.isConnected) return;
        img.dataset.skillState = 'loaded';
        img.hidden = false;
        img.classList.add('loaded');
        placeholder.remove();
      };

      loadSkillImageDataUrl(file)
        .then((url) => {
          if (!img.isConnected) return;
          img.addEventListener('load', reveal, { once: true });
          img.addEventListener('error', fail, { once: true });
          img.src = url;
          if (img.complete) {
            if (img.naturalWidth > 0) reveal();
            else fail();
          }
        })
        .catch(fail);
    });
    };

    hydrate(el);
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === 'attributes' && record.target instanceof Element) {
          hydrate(record.target);
          return;
        }
        record.addedNodes.forEach((node) => {
          if (
            node.nodeType === Node.ELEMENT_NODE
            || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
          ) {
            hydrate(node as ParentNode);
          }
        });
      });
    });
    observer.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });
    return () => observer.disconnect();
  }, [enhanceFileLink, message.id, renderMarkdown]);

  // ★ system 消息独立渲染
  if (message.role === 'system') {
    return <SystemMessage message={message} renderMarkdown={renderMarkdown} />;
  }

  const isUser = message.role === 'user';
  const userInitial = (
    currentUser?.displayName || currentUser?.username || 'U'
  ).trim().slice(0, 1).toUpperCase() || 'U';

  const thinkingContent =
    message.thinking ||
    (message as any).thinkingBlocks?.map((b: any) => b.content).join('\n\n') ||
    '';

  const isThinkingPhase = !!message.streaming
    && !message.content
    && (!!thinkingContent || !!message.waitingForFirstDelta);

  // ★ useMemo 避免每次渲染重新解析 Markdown（message.content 不变则复用缓存）
  const contentHtml = useMemo(
    () => !isUser && renderMarkdown && message.content ? markdownToHtml(message.content) : null,
    [isUser, renderMarkdown, message.content],
  );

  // 新版流式块携带各自 text；旧版块没有 text 时，仅在最后一个 text 块
  // 渲染完整正文一次，避免一条回复被复制成多份。
  const orderedTextBlockText = useMemo(() => {
    const blocks = message.contentBlocks || [];
    const hasExplicitText = blocks.some(
      (block) => block.type === 'text' && typeof block.text === 'string',
    );
    let legacyFallbackIndex = -1;
    if (!hasExplicitText) {
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        if (blocks[i].type === 'text') {
          legacyFallbackIndex = i;
          break;
        }
      }
    }
    return blocks.map((block, index) => {
      if (block.type !== 'text') return '';
      if (typeof block.text === 'string') return block.text;
      return index === legacyFallbackIndex ? message.content : '';
    });
  }, [message.content, message.contentBlocks]);

  const orderedTextBlockHtml = useMemo(
    () => orderedTextBlockText.map((text) => (
      !isUser && renderMarkdown && text ? markdownToHtml(text) : null
    )),
    [isUser, orderedTextBlockText, renderMarkdown],
  );

  // 最后一道显示防线：兼容旧版本已经写入的空 Assistant 记录。运行中的
  // Thinking 占位仍然保留，只有 finalized 且完全无载荷的消息会被隐藏。
  if (!shouldKeepChatMessage(message)) return null;

  return (
    <>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      {fileLinkHover && !fileLinkMenu && (
        <AppModalPortal>
          <div
            role="tooltip"
            aria-label={`文件树定位：${fileLinkHover.relativePath}`}
            style={{
              position: 'fixed', left: fileLinkHover.x, top: fileLinkHover.y, zIndex: 10029,
              width: 196, minHeight: 44, padding: '7px 9px', boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none',
              border: '1px solid var(--theme-border, rgba(0,0,0,.18))', borderRadius: 8,
              background: 'var(--theme-bg-secondary, #fff)', color: 'var(--theme-text, #1f2328)',
              boxShadow: '0 7px 22px rgba(0,0,0,.24)',
            }}
          >
            <span style={{
              width: 28, height: 28, flex: '0 0 28px', display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center', borderRadius: 7,
              color: 'var(--theme-accent, #0969da)',
              background: 'var(--theme-accent-bg, rgba(9,105,218,.12))',
            }} aria-hidden="true">
              <FileTreeLocateIcon />
            </span>
            <span style={{ display: 'flex', minWidth: 0, flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 12.5, lineHeight: 1.25, fontWeight: 700 }}>文件树定位</span>
              <span style={{ fontSize: 10.5, lineHeight: 1.3, color: 'var(--theme-text-muted)' }}>
                点击展开目录并选中文件
              </span>
            </span>
          </div>
        </AppModalPortal>
      )}
      {fileLinkMenu && (
        <AppModalPortal>
          <div
            role="menu"
            aria-label="文件链接操作"
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
            style={{
              position: 'fixed', left: fileLinkMenu.x, top: fileLinkMenu.y, zIndex: 10030,
              width: 300, padding: 7, borderRadius: 10,
              border: '1px solid var(--theme-border, rgba(0,0,0,.16))',
              background: 'var(--theme-bg-secondary, #fff)',
              color: 'var(--theme-text, #1f2328)',
              boxShadow: '0 10px 32px rgba(0,0,0,.28)',
            }}
          >
            <div title={fileLinkMenu.filePath} style={{
              padding: '4px 9px 7px', fontSize: 11, color: 'var(--theme-text-muted)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {fileLinkMenu.relativePath}
            </div>
            <button
              role="menuitem"
              style={fileLinkMenuItemStyle}
              onClick={() => {
                const relativePath = fileLinkMenu.relativePath;
                setFileLinkMenu(null);
                onFocusFile?.(relativePath);
              }}
              className="file-link-menu-item"
            >
              <span className="file-link-menu-icon" aria-hidden="true">
                <FileTreeLocateIcon />
              </span>
              <span style={fileLinkMenuTextStyle}>
                <span style={fileLinkMenuLabelStyle}>在文件面板中定位</span>
                <span style={fileLinkMenuHintStyle}>展开深层目录并选中这个文件</span>
              </span>
            </button>
            <button
              role="menuitem"
              style={fileLinkMenuItemStyle}
              onClick={() => {
                const relativePath = fileLinkMenu.relativePath;
                setFileLinkMenu(null);
                void copyToClipboard(relativePath);
              }}
              className="file-link-menu-item"
            >
              <span className="file-link-menu-icon" aria-hidden="true">
                <CopyPathIcon />
              </span>
              <span style={fileLinkMenuTextStyle}>
                <span style={fileLinkMenuLabelStyle}>复制相对路径</span>
                <span style={fileLinkMenuHintStyle}>复制项目内的文件路径</span>
              </span>
            </button>
          </div>
        </AppModalPortal>
      )}
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        padding: '5px var(--ui-message-gutter, 20px)',
        animation: animateIn ? 'msgSlideIn 0.22s ease-out' : undefined,
      }}
    >
      {/* ★ 角色标签 */}
      {!isUser && (
        <div style={{
          width: 26, height: 26, borderRadius: 5, flexShrink: 0,
          background: 'var(--theme-accent)',
          border: '1px solid rgba(255,255,255,.32)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, color: '#fff', fontWeight: 800, marginRight: 9, marginTop: 3,
          boxShadow: '0 1px 4px rgba(0,0,0,.24)',
        }}>A</div>
      )}
      <div
        ref={contentRef}
        className="message-bubble-wrapper"
        onContextMenu={handleFileLinkContextMenu}
        onPointerOver={handleFileLinkPointerOver}
        onPointerOut={handleFileLinkPointerOut}
        onFocus={handleFileLinkFocus}
        onBlur={handleFileLinkBlur}
        style={{
          position: 'relative',
          maxWidth: '82%',
          minWidth: 60,
          padding: 'var(--ui-message-padding, 11px 14px)',
          borderRadius: isUser ? '8px 8px 3px 8px' : '8px 8px 8px 3px',
          background: isUser ? 'var(--theme-user-bubble-bg, #ddf4ff)' : 'var(--theme-message-bg, #f6f8fa)',
          border: `1px solid ${isUser ? 'var(--theme-user-bubble-border, #0969da44)' : 'var(--theme-border, rgba(0,0,0,0.12))'}`,
          fontSize,
          lineHeight: 1.6,
          wordBreak: 'break-word',
          overflow: 'visible',
        }}
      >
        {/* 操作菜单（悬停显示） */}
        <BubbleActionMenu
          message={message}
          sessionId={sessionId}
          canBranch={canBranch}
          ttsVoice={ttsVoice}
          ttsRate={ttsRate}
          onRedoMessage={onRedoMessage}
        />
        {isUser && message.deliveryMode && (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            marginBottom: 6,
            padding: '2px 7px',
            borderRadius: 4,
            fontSize: 10,
            lineHeight: 1.4,
            color: message.deliveryMode === 'steer' ? '#8250df' : '#bc4c00',
            background: message.deliveryMode === 'steer'
              ? 'rgba(130,80,223,0.10)'
              : 'rgba(188,76,0,0.10)',
            border: `1px solid ${message.deliveryMode === 'steer'
              ? 'rgba(130,80,223,0.28)'
              : 'rgba(188,76,0,0.28)'}`,
          }}>
            {message.deliveryMode === 'steer' ? '↪ 当前轮引导' : '↻ 中断后重新引导'}
          </div>
        )}
        {message.textAttachments && message.textAttachments.length > 0 && (
          <TextAttachmentPreview
            attachments={message.textAttachments}
            compact
          />
        )}
        {/* 附件图片 */}
        {message.images && message.images.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {message.images.map((img: any, i: number) => {
              const src =
                typeof img === 'string'
                  ? img
                  : `data:${img.mimeType || img.mime_type || 'image/png'};base64,${img.base64}`;
              return (
                <div key={i} className="img-lazy-placeholder" style={{
                  width: 120, height: 120,
                  borderRadius: 8,
                  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
                  overflow: 'hidden',
                  position: 'relative',
                  cursor: 'zoom-in',
                }} onClick={() => setLightboxSrc(src)}>
                  {/* 小尺寸图片直接显示，大图片懒加载 */}
                  <img
                    className="lazy"
                    src={src}
                    alt="attachment"
                    loading="lazy"
                    style={{
                      width: '100%', height: '100%',
                      objectFit: 'contain',
                      display: 'block',
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* ★ 按 contentBlocks 顺序交替渲染 thinking / tool / text */}
        {!isUser && message.contentBlocks && message.contentBlocks.length > 0 ? (
          message.contentBlocks.map((block, i) => {
            if (block.type === 'thinking' && (thinkingContent || isThinkingPhase)) {
              return <ThinkingBlock key={`blk-${i}`} content={thinkingContent} isThinking={isThinkingPhase} />;
            }
            if (block.type === 'tool' && message.toolCalls && block.toolIndex !== undefined) {
              const tc = message.toolCalls[block.toolIndex];
              return tc ? <ToolCallBlock key={`blk-${i}`} tc={tc} allTools={message.toolCalls} /> : null;
            }
            if (block.type === 'text') {
              const blockText = orderedTextBlockText[i] || '';
              const blockHtml = orderedTextBlockHtml[i];
              return blockHtml ? (
                <div
                  key={`blk-${i}`}
                  className="msg-content"
                  onClick={handleContentClick}
                  dangerouslySetInnerHTML={{ __html: blockHtml }}
                />
              ) : blockText ? (
                <div key={`blk-${i}`} style={{ whiteSpace: 'pre-wrap' }}>{blockText}</div>
              ) : null;
            }
            return null;
          })
        ) : (
          /* Fallback：历史消息没有 contentBlocks 时保持原有顺序 */
          <>
            {!isUser && (thinkingContent || isThinkingPhase) && (
              <ThinkingBlock content={thinkingContent} isThinking={isThinkingPhase} />
            )}
            {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
              <div style={{ marginBottom: message.content ? 8 : 0 }}>
                {message.toolCalls
                  .filter((tc) => !tc.parentToolUseId)
                  .map((tc, i) => (
                    <ToolCallBlock key={`${tc.id || tc.name}-${i}`} tc={tc} allTools={message.toolCalls} />
                  ))}
              </div>
            )}
            {contentHtml ? (
              <div
                className="msg-content"
                onClick={handleContentClick}
                dangerouslySetInnerHTML={{ __html: contentHtml }}
              />
            ) : message.content ? (
              <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
            ) : null}
          </>
        )}

        {/* ★ 工具输出图片直出：不依赖模型转述，直接在消息体内渲染 */}
        {!isUser && !message.streaming && message.toolCalls && (() => {
          const allToolImages: Array<{ src: string; alt: string }> = [];
          const seen = new Set<string>();
          for (const tc of message.toolCalls) {
            if (tc.output && tc.status !== 'error') {
              const { images } = extractImagesFromOutput(tc.output);
              for (const img of images) {
                if (message.content?.includes(img.src) || seen.has(img.src)) continue;
                seen.add(img.src);
                allToolImages.push(img);
              }
            }
          }
          if (allToolImages.length === 0) return null;
          return (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {allToolImages.map((img, idx) => (
                <ToolOutputImage
                  key={idx}
                  src={img.src}
                  alt={img.alt}
                  onOpen={setLightboxSrc}
                />
              ))}
            </div>
          );
        })()}

        {/* 流式光标 */}
        {message.streaming && (
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: 15,
              background: 'var(--theme-accent, rgba(122,162,247,0.9))',
              marginLeft: 3,
              borderRadius: 2,
              verticalAlign: 'text-bottom',
              willChange: 'opacity',
              animation: 'cursorGlow 0.9s ease-in-out infinite',
            }}
          />
        )}

        {/* Token 用量 + 耗时 */}
        {!isUser && (message.usage || message.elapsed) && !message.streaming && (
          <div style={{ fontSize: 11, color: 'var(--theme-text-muted, #656d76)', marginTop: 4 }}>
            {message.usage?.inputTokens != null && `↑${message.usage.inputTokens.toLocaleString()}`}
            {message.usage?.outputTokens != null && ` ↓${message.usage.outputTokens.toLocaleString()}`}
            {message.elapsed != null && ` · ${message.elapsed < 1000 ? `${message.elapsed}ms` : `${(message.elapsed / 1000).toFixed(1)}s`}`}
          </div>
        )}

        {/* 时间戳 */}
        {message.timestamp && (
          <div title={formatMessageDateTime(message.timestamp)} style={{ fontSize: 10.5, color: 'var(--theme-text-muted, #656d76)', marginTop: 7, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {formatMessageTime(message.timestamp)}
          </div>
        )}
      </div>
      {/* ★ 用户头像 */}
      {isUser && (
        <div title={currentUser?.displayName || '你'} style={{
          width: 26, height: 26, borderRadius: 5, flexShrink: 0,
          overflow: 'hidden',
          background: currentUser?.avatarData
            ? 'var(--theme-bg-tertiary)'
            : (currentUser?.avatarColor || 'var(--theme-bg-tertiary)'),
          border: '1px solid var(--theme-border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, color: currentUser ? '#fff' : 'var(--theme-text-muted)',
          fontWeight: 750, marginLeft: 9, marginTop: 3,
        }}>
          {currentUser?.avatarData ? (
            <img
              src={currentUser.avatarData}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : userInitial}
        </div>
      )}
    </div>
    </>
  );
}

// ★ memo + 自定义比较：streaming 消息不跳过（内容持续变化），已完成消息只在内容实际变化时才重渲染
function bubblePropsEqual(prev: Props, next: Props): boolean {
  // 任一处于流式中 → 允许更新
  if (prev.message.streaming || next.message.streaming) return false;
  return (
    prev.message.id        === next.message.id        &&
    prev.message.content   === next.message.content   &&
    prev.message.images    === next.message.images    &&
    prev.message.textAttachments === next.message.textAttachments &&
    prev.message.deliveryMode === next.message.deliveryMode &&
    prev.message.timestamp  === next.message.timestamp  &&
    prev.message.elapsed   === next.message.elapsed   &&
    prev.message.usage     === next.message.usage     &&
    prev.currentUser?.avatarData === next.currentUser?.avatarData &&
    prev.currentUser?.avatarColor === next.currentUser?.avatarColor &&
    prev.currentUser?.displayName === next.currentUser?.displayName &&
    prev.currentUser?.username === next.currentUser?.username &&
    prev.fontSize          === next.fontSize          &&
    prev.renderMarkdown    === next.renderMarkdown    &&
    prev.animateIn         === next.animateIn         &&
    prev.ttsVoice          === next.ttsVoice          &&
    prev.ttsRate           === next.ttsRate           &&
    prev.sessionId         === next.sessionId         &&
    prev.canBranch         === next.canBranch         &&
    prev.workingDir        === next.workingDir        &&
    prev.onFocusFile       === next.onFocusFile       &&
    prev.onRedoMessage     === next.onRedoMessage
  );
}

function FileTreeLocateIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.75" y="3.25" width="18.5" height="17.5" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.5 3.75v16.5M12 8h5M12 11.5h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16.5" cy="16" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16.5 12.8v1.1m0 4.2v1.1M13.3 16h1.1m4.2 0h1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CopyPathIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="8" y="7.5" width="11.5" height="12.5" rx="2.25" stroke="currentColor" strokeWidth="1.7" />
      <path d="M16 7.5V6.25A2.25 2.25 0 0 0 13.75 4h-7.5A2.25 2.25 0 0 0 4 6.25v8.5A2.25 2.25 0 0 0 6.25 17H8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M11.5 12h4.5m-4.5 3.5H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const fileLinkMenuItemStyle: React.CSSProperties = {
  display: 'flex', width: '100%', alignItems: 'center', gap: 10,
  minHeight: 52, padding: '7px 9px', border: 'none', borderRadius: 7,
  background: 'transparent', color: 'inherit', cursor: 'pointer',
  font: 'inherit', textAlign: 'left', transition: 'background .14s ease',
};

const fileLinkMenuTextStyle: React.CSSProperties = {
  display: 'flex', minWidth: 0, flexDirection: 'column', gap: 2,
};

const fileLinkMenuLabelStyle: React.CSSProperties = {
  fontSize: 13, lineHeight: 1.3, fontWeight: 650,
};

const fileLinkMenuHintStyle: React.CSSProperties = {
  fontSize: 10.5, lineHeight: 1.35, color: 'var(--theme-text-muted)',
};

export const MessageBubble = memo(MessageBubbleInner, bubblePropsEqual);

// ═══════════════════════════════════════
//  共享样式
// ═══════════════════════════════════════
const sectionBox: React.CSSProperties = {
  marginBottom: 6,
  borderRadius: 8,
  // ★ 不再用实色 bg。用户开了背景图时,sectionBox 是个内嵌容器,实色会把
  //    背景图盖掉变成灰蒙蒙。只靠 border 做区分,内部 code/diff 块如果需要
  //    底色,它们自己有 var(--theme-code-bg)。
  background: 'transparent',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  overflow: 'hidden',
};

const sectionHeader: React.CSSProperties = {
  padding: '6px 10px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: 'var(--theme-text, #1f2328)',
  userSelect: 'none',
  minWidth: 0,
};

const sectionBody: React.CSSProperties = {
  padding: '8px 10px',
  borderTop: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  fontSize: 12,
  lineHeight: 1.5,
};

const chevron: React.CSSProperties = {
  fontSize: 10,
  transition: 'transform 0.15s',
  flexShrink: 0,
};

const previewText: React.CSSProperties = {
  color: 'var(--theme-text, #1f2328)',
  marginLeft: 4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
};

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 12,
  height: 12,
  border: '2px solid rgba(255,255,255,0.15)',
  borderTopColor: 'rgba(255,255,255,0.75)',
  borderRadius: '50%',
  animation: 'spin 0.7s linear infinite',
  marginLeft: 6,
  verticalAlign: 'middle',
  flexShrink: 0,
};

const labelStyle: React.CSSProperties = {
  color: 'var(--theme-text-muted, #656d76)',
  marginBottom: 2,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const codeBlock: React.CSSProperties = {
  margin: 0,
  padding: '6px 8px',
  background: 'var(--theme-code-bg, #eaeef2)',
  borderRadius: 4,
  color: 'var(--theme-text, #1f2328)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  maxHeight: 200,
  overflow: 'auto',
  fontSize: 11,
  fontFamily: 'monospace',
};

// ★ 系统消息样式
const systemBubbleStyle: React.CSSProperties = {
  maxWidth: '85%',
  padding: '10px 16px',
  borderRadius: 7,
  background: 'var(--theme-bg-secondary, #f6f8fa)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--theme-text, #1f2328)',
  wordBreak: 'break-word',
  boxShadow: 'var(--ui-shadow-soft)',
};
