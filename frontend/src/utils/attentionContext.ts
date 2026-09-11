import type { ProvAnnotation, ProvDocument, ProvSelector, ProvSourcePreview } from '../types/prov';

export type AttentionKind =
  | 'session'
  | 'file'
  | 'settings'
  | 'backend'
  | 'release'
  | 'skills'
  | 'assets'
  | 'notes'
  | 'connection'
  | 'logs'
  | 'manual'
  | 'home';

export interface AttentionContext {
  key: string;
  kind: AttentionKind;
  label: string;
  detail?: string;
  content?: string;
  sessionId?: string;
  workingDir?: string;
  execKey?: string;
  /** 只存在于当前浏览器内存；提问时作为图片附件发送，绝不写入旁路历史。 */
  imageAttachments?: AttentionImageAttachment[];
}

export interface AttentionImageAttachment {
  id: string;
  base64: string;
  mime_type: string;
  size: number;
  width?: number;
  height?: number;
}

/** 用户显式固定时才创建；只保存在内存，不把界面正文/图片写入 localStorage。 */
export function bindAttention<TSession, TBackend>(
  session: TSession, attention: AttentionContext, backends: TBackend[],
): { session: TSession; attention: AttentionContext; backends: TBackend[] } {
  return { session: { ...session }, attention: structuredClone(attention), backends: [...backends] };
}

export const ATTENTION_CONTENT_LIMIT = 50_000;

const BINARY_KEYS = new Set([
  'base64', 'dataUrl', 'bytes', 'image', 'images', 'thumbnail', 'blob', 'arrayBuffer',
]);

function compactStructured(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/i.test(value)) return '[已省略二进制内容]';
    return value.length > 8_000 ? `${value.slice(0, 8_000)}…` : value;
  }
  if (depth >= 7) return '[层级已省略]';
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[已省略二进制内容]';
  if (Array.isArray(value)) return value.slice(0, 120).map((item) => compactStructured(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 160)) {
      if (BINARY_KEYS.has(key) || /(?:base64|dataurl|bytes)$/i.test(key)) continue;
      output[key] = compactStructured(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function limitAttentionContent(value: string, limit = ATTENTION_CONTENT_LIMIT): string {
  const clean = String(value || '').replace(/\0/g, '').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}\n\n[界面快照已截断]` : clean;
}

export function serializeAttentionContent(value: unknown): string {
  try {
    return limitAttentionContent(JSON.stringify(compactStructured(value), null, 2));
  } catch {
    return '';
  }
}

export interface PreviewAttentionSource {
  rel: string;
  name: string;
  source: 'remote' | 'local';
  loading?: boolean;
  error?: string;
  text?: string;
  isImage?: boolean;
  isMarkdown?: boolean;
  renderer?: 'pdf' | 'docx' | 'drawio';
  structured?: unknown;
  drawioXml?: string;
  truncated?: boolean;
}

export function buildFileAttentionContext(
  preview: PreviewAttentionSource,
  options: { sessionId?: string; workingDir?: string; execKey?: string; editedText?: string } = {},
): AttentionContext {
  let content = '';
  if (typeof options.editedText === 'string') content = options.editedText;
  else if (typeof preview.text === 'string') content = preview.text;
  else if (preview.structured) content = serializeAttentionContent(preview.structured);
  else if (preview.renderer === 'drawio' && preview.drawioXml) {
    const labels: string[] = [];
    for (const match of preview.drawioXml.matchAll(/value="([^"]+)"/g)) {
      labels.push(match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
      if (labels.length >= 400) break;
    }
    content = labels.join('\n');
  }
  if (!content) {
    if (preview.loading) content = '文件正在加载，正文尚未可用。';
    else if (preview.error) content = `预览错误：${preview.error}`;
    else if (preview.isImage) content = '当前关注的是图片；图片像素不会作为文本快照重复上传，可通过提问时附图补充。';
    else if (preview.renderer === 'pdf' || preview.renderer === 'docx') content = '当前预览器未提供可安全提取的正文，仅带入文件身份。';
  }
  return {
    key: `file:${preview.source}:${preview.rel.replace(/\\/g, '/')}`,
    kind: 'file',
    label: preview.name,
    detail: `${preview.source === 'local' ? '本机' : '执行端'} · ${preview.rel}${preview.truncated ? ' · 预览已截断' : ''}`,
    content: limitAttentionContent(content),
    sessionId: options.sessionId,
    workingDir: options.workingDir,
    execKey: options.execKey,
  };
}

function reviewSelectorLabel(selector: ProvSelector): string {
  if (selector.type === 'document') return '整个文件';
  if (selector.type === 'image-region') {
    return ({
      rectangle: '矩形框选', ellipse: '椭圆框选', arrow: '箭头指向',
      polygon: '多边形框选', point: '点选位置',
    } as Record<typeof selector.shape, string>)[selector.shape];
  }
  const heading = selector.headingPath.filter(Boolean).join(' › ');
  return `${selector.type === 'text-range' ? '文字框选' : '段落'}${heading ? ` · ${heading}` : ''}`;
}

function reviewTextContent(document: ProvDocument, annotation: ProvAnnotation): string {
  const selector = annotation.target.selector;
  const lines = [
    `当前审阅焦点：${annotation.ref}${annotation.title ? ` · ${annotation.title}` : ''}`,
    `源文件：${document.source.path}`,
    `选择类型：${reviewSelectorLabel(selector)}`,
  ];
  if (selector.type === 'text-block' || selector.type === 'text-range') {
    lines.push(`选中内容：\n${selector.exactQuote}`);
  } else if (selector.type === 'image-region') {
    lines.push(`框选坐标（相对图片，0–1）：${JSON.stringify(selector.geometry)}`);
    lines.push('已把框选区域自动裁剪为图片附件；回答时应优先关注附件中央的选区。');
  }
  if (annotation.body.comment) lines.push(`当前意见：${annotation.body.comment}`);
  if (annotation.body.expected) lines.push(`期望结果：${annotation.body.expected}`);
  lines.push(`意见状态：${annotation.status} · 严重度：${annotation.body.severity}${annotation.body.blocking ? ' · 阻断' : ''}`);
  return limitAttentionContent(lines.join('\n'));
}

function reviewImageBounds(selector: Extract<ProvSelector, { type: 'image-region' }>) {
  const geometry = selector.geometry;
  let left = 0, top = 0, right = 1, bottom = 1;
  if (selector.shape === 'rectangle' || selector.shape === 'ellipse') {
    left = Number(geometry.x || 0); top = Number(geometry.y || 0);
    right = left + Number(geometry.width || 0); bottom = top + Number(geometry.height || 0);
  } else if (selector.shape === 'arrow') {
    left = Math.min(Number(geometry.x1 || 0), Number(geometry.x2 || 0));
    top = Math.min(Number(geometry.y1 || 0), Number(geometry.y2 || 0));
    right = Math.max(Number(geometry.x1 || 0), Number(geometry.x2 || 0));
    bottom = Math.max(Number(geometry.y1 || 0), Number(geometry.y2 || 0));
  } else if (selector.shape === 'polygon' && geometry.points?.length) {
    left = Math.min(...geometry.points.map((point) => point.x));
    top = Math.min(...geometry.points.map((point) => point.y));
    right = Math.max(...geometry.points.map((point) => point.x));
    bottom = Math.max(...geometry.points.map((point) => point.y));
  } else {
    const x = Number(geometry.x ?? 0.5), y = Number(geometry.y ?? 0.5);
    left = x - 0.12; top = y - 0.12; right = x + 0.12; bottom = y + 0.12;
  }
  const minSpan = 0.10;
  if (right - left < minSpan) { const mid = (left + right) / 2; left = mid - minSpan / 2; right = mid + minSpan / 2; }
  if (bottom - top < minSpan) { const mid = (top + bottom) / 2; top = mid - minSpan / 2; bottom = mid + minSpan / 2; }
  const padX = Math.max(0.025, (right - left) * 0.12);
  const padY = Math.max(0.025, (bottom - top) * 0.12);
  return {
    left: Math.max(0, left - padX), top: Math.max(0, top - padY),
    right: Math.min(1, right + padX), bottom: Math.min(1, bottom + padY),
  };
}

async function cropReviewImage(
  preview: Extract<ProvSourcePreview, { kind: 'image' }>,
  annotation: ProvAnnotation,
): Promise<AttentionImageAttachment | null> {
  const selector = annotation.target.selector;
  if (selector.type !== 'image-region' || typeof document === 'undefined' || typeof Image === 'undefined') return null;
  try {
    const image = new Image();
    image.src = `data:${preview.mimeType};base64,${preview.dataBase64}`;
    if (typeof image.decode === 'function') await image.decode();
    else await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('image decode failed')); });
    const bounds = reviewImageBounds(selector);
    const sourceX = Math.round(bounds.left * image.naturalWidth);
    const sourceY = Math.round(bounds.top * image.naturalHeight);
    const sourceWidth = Math.max(1, Math.round((bounds.right - bounds.left) * image.naturalWidth));
    const sourceHeight = Math.max(1, Math.round((bounds.bottom - bounds.top) * image.naturalHeight));
    const scale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return {
      id: `attention-${annotation.id}`,
      base64,
      mime_type: 'image/png',
      size: Math.floor(base64.length * 0.75),
      width,
      height,
    };
  } catch {
    return null;
  }
}

/** 把审批工作台当前选中的文字/图片区域提升为“俺寻思”的即时注意力。 */
export async function buildReviewAttentionContext(
  document: ProvDocument,
  preview: ProvSourcePreview | null,
  annotation: ProvAnnotation,
  options: { sessionId?: string; workingDir?: string; execKey?: string; source?: 'remote' | 'local' } = {},
): Promise<AttentionContext> {
  const selector = annotation.target.selector;
  const image = preview?.kind === 'image' ? await cropReviewImage(preview, annotation) : null;
  const path = document.source.path.replace(/\\/g, '/');
  return {
    // 一份文件维持一条注意力线程；框选变化只更新当前焦点，不把历史切得过碎。
    key: `file:${options.source || 'remote'}:${path}`,
    kind: 'file',
    label: path.split('/').pop() || path,
    detail: `审阅焦点 · ${annotation.ref} · ${reviewSelectorLabel(selector)}`,
    content: reviewTextContent(document, annotation),
    sessionId: options.sessionId,
    workingDir: options.workingDir,
    execKey: options.execKey,
    imageAttachments: image ? [image] : undefined,
  };
}

export function attentionIcon(kind: AttentionKind): string {
  return ({
    session: '💬', file: '📄', settings: '⚙️', backend: '🧠', release: '🚀',
    skills: '📦', assets: '🗂️', notes: '📝', connection: '🔗', logs: '📋',
    manual: '📖', home: '⌂',
  } as Record<AttentionKind, string>)[kind];
}
