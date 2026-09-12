import React, { useRef, useCallback, useEffect, useState } from 'react';
import type { AppConfig, ThemeType } from '../hooks/useConfig';
import { themes } from '../hooks/useConfig';
import {
  api, isTauri, getConnectionTarget, getRelayUserProfile,
  updateRelayUserProfile, rememberRelayUserProfile,
  type RelayUserProfile,
} from '../api';
import {
  SCREENSHOT_HOTKEY_RECOMMENDED,
  buildAccelerator,
  displayAccelerator,
  isModifierOnly,
  readScreenshotHotkey,
  writeScreenshotHotkey,
} from '../utils/hotkey';
import { readHackerMode, writeHackerMode, type HackerModeConfig } from '../utils/hackerMode';
import { base64ToArrayBuffer, systemSpeechRate } from '../utils/realtimeVoice';
import { UpdateCenter } from './UpdateCenter';

// 发布工作台只有维护者明确打开时才下载对应前端 chunk；普通用户的启动、聊天和
// Settings 渲染都不会加载候选列表/manifest 预览代码。
const LazyReleaseCenter = React.lazy(() => import('./ReleaseCenter'));

const DASHSCOPE_REALTIME_DEFAULT = 'fun-asr-realtime-2026-02-28';
const DASHSCOPE_FLASH_DEFAULT = 'fun-asr-flash-2026-06-15';
const DASHSCOPE_REALTIME_MODELS = new Set([
  DASHSCOPE_REALTIME_DEFAULT,
]);

async function resizeAvatar(file: File): Promise<string> {
  if (!/^image\/(?:png|jpeg|webp)$/i.test(file.type)) {
    throw new Error('头像仅支持 PNG、JPEG 或 WebP');
  }
  if (file.size > 8 * 1024 * 1024) throw new Error('原图不能超过 8 MB');
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('无法读取这张图片'));
      element.src = objectUrl;
    });
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器不支持头像处理');
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
    const result = canvas.toDataURL('image/webp', 0.82);
    if (result.length > 520_000) throw new Error('压缩后的头像仍然过大，请换一张图片');
    return result;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

const AVATAR_ZOOM_MIN = 0.1;
const AVATAR_ZOOM_MAX = 16;

function clampAvatarZoom(value: number): number {
  return Math.min(AVATAR_ZOOM_MAX, Math.max(AVATAR_ZOOM_MIN, value));
}

const AvatarPreviewDialog: React.FC<{
  src: string;
  displayName: string;
  onClose: () => void;
}> = ({ src, displayName, onClose }) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const resetView = useCallback(() => {
    zoomRef.current = 1;
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const applyZoom = useCallback((rawZoom: number, anchor?: { x: number; y: number }) => {
    const previousZoom = zoomRef.current;
    const nextZoom = clampAvatarZoom(rawZoom);
    if (Math.abs(nextZoom - previousZoom) < 0.0001) return;

    const viewport = viewportRef.current;
    if (viewport && anchor) {
      const rect = viewport.getBoundingClientRect();
      const anchorX = anchor.x - rect.left - rect.width / 2;
      const anchorY = anchor.y - rect.top - rect.height / 2;
      const ratio = nextZoom / previousZoom;
      setOffset((current) => ({
        x: anchorX - (anchorX - current.x) * ratio,
        y: anchorY - (anchorY - current.y) * ratio,
      }));
    }

    zoomRef.current = nextZoom;
    setZoom(nextZoom);
  }, []);

  useEffect(() => resetView(), [resetView, src]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if ((event.key === '0' || event.key === 'Home') && !event.ctrlKey && !event.metaKey) {
        resetView();
      }
      if (event.key === '+' || event.key === '=') applyZoom(zoomRef.current * 1.2);
      if (event.key === '-') applyZoom(zoomRef.current / 1.2);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [applyZoom, onClose, resetView]);

  const finishDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${displayName} 的头像预览`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        display: 'grid', placeItems: 'center', padding: 12, boxSizing: 'border-box',
        background: 'rgba(7, 12, 20, 0.88)', backdropFilter: 'blur(6px)',
      }}
    >
      <div style={{
        width: 'min(1080px, calc(100vw - 24px))',
        height: 'min(760px, calc(100dvh - 24px))',
        minHeight: 300,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        background: 'var(--theme-bg-tertiary, #111827)',
        border: '1px solid var(--theme-border, rgba(255,255,255,.16))',
        borderRadius: 5,
        boxShadow: '0 24px 70px rgba(0,0,0,.52)',
      }}>
        <div style={{
          minHeight: 52, padding: '0 12px 0 16px', display: 'flex', alignItems: 'center', gap: 12,
          borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)',
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: 'var(--theme-text)', fontSize: 13, fontWeight: 650 }}>头像预览</div>
            <div style={{ color: 'var(--theme-text-muted)', fontSize: 10, marginTop: 2 }}>
              滚轮或滑杆缩放 · 拖动查看 · 双击复位
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭头像预览" style={closeBtnStyle}>✕</button>
        </div>

        <div
          ref={viewportRef}
          onWheel={(event) => {
            event.preventDefault();
            applyZoom(
              zoomRef.current * Math.exp(-event.deltaY * 0.0015),
              { x: event.clientX, y: event.clientY },
            );
          }}
          onDoubleClick={resetView}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              offsetX: offset.x,
              offsetY: offset.y,
            };
            setDragging(true);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            setOffset({
              x: drag.offsetX + event.clientX - drag.startX,
              y: drag.offsetY + event.clientY - drag.startY,
            });
          }}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          style={{
            flex: 1, minHeight: 0, margin: 12, overflow: 'hidden', position: 'relative',
            display: 'grid', placeItems: 'center', touchAction: 'none', userSelect: 'none',
            cursor: dragging ? 'grabbing' : 'grab',
            border: '1px solid color-mix(in srgb, var(--theme-border) 82%, transparent)',
            borderRadius: 3,
            background: 'radial-gradient(circle at center, rgba(95,115,140,.12), rgba(4,8,14,.34))',
          }}
        >
          <img
            src={src}
            alt={`${displayName} 的头像`}
            draggable={false}
            style={{
              maxWidth: 'calc(100% - 32px)', maxHeight: 'calc(100% - 32px)',
              objectFit: 'contain', pointerEvents: 'none',
              transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`,
              transformOrigin: 'center center',
              boxShadow: '0 12px 34px rgba(0,0,0,.34)',
              willChange: 'transform',
            }}
          />
        </div>

        <div style={{
          minHeight: 54, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 9,
          flexWrap: 'wrap',
          borderTop: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)',
          boxSizing: 'border-box',
        }}>
          <button
            type="button"
            aria-label="缩小头像"
            onClick={() => applyZoom(zoomRef.current / 1.2)}
            style={avatarPreviewControlStyle}
          >−</button>
          <input
            type="range"
            aria-label="头像缩放比例"
            min={AVATAR_ZOOM_MIN * 100}
            max={AVATAR_ZOOM_MAX * 100}
            step={1}
            value={Math.round(zoom * 100)}
            onChange={(event) => applyZoom(Number(event.target.value) / 100)}
            style={{ flex: '1 1 100px', minWidth: 60, accentColor: 'var(--theme-accent)' }}
          />
          <button
            type="button"
            aria-label="放大头像"
            onClick={() => applyZoom(zoomRef.current * 1.2)}
            style={avatarPreviewControlStyle}
          >＋</button>
          <span style={{
            width: 54, textAlign: 'right', color: 'var(--theme-text)',
            fontSize: 11, fontVariantNumeric: 'tabular-nums',
          }}>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={resetView} style={{ ...avatarPreviewControlStyle, width: 'auto', padding: '0 10px' }}>
            复位
          </button>
        </div>
      </div>
    </div>
  );
};

type SettingsPage = 'user' | 'general' | 'voice' | 'appearance' | 'desktop' | 'system';

const SETTINGS_PAGES: Array<{
  id: SettingsPage;
  icon: string;
  label: string;
  description: string;
  desktopOnly?: boolean;
}> = [
  { id: 'user', icon: '●', label: '用户', description: '当前身份、用户名与头像' },
  { id: 'general', icon: '⌘', label: '常规', description: '对话、Session 与实验功能' },
  { id: 'voice', icon: '◉', label: '语音', description: '识别、朗读与实时对话' },
  { id: 'appearance', icon: '◐', label: '外观', description: '主题、透明度与背景' },
  { id: 'desktop', icon: '⌁', label: '桌面交互', description: 'Smooth 与系统快捷键', desktopOnly: true },
  { id: 'system', icon: '⇅', label: '数据与系统', description: '备份、Backend 与应用信息' },
];

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  config: AppConfig;
  onConfigChange: (patch: Partial<AppConfig>) => void;
  onExportChat: () => void;
  onResetConfig: () => void;
  onOpenBackendManager: () => void;
  onExportData: () => void;
  onImportData: () => void;
  onOpenConnectionPanel: () => void;
}

interface LegacyClaimItem {
  id: string;
  title: string;
  updatedAt: number;
  workingDir: string;
  sessionType: string;
  messageCount: number;
  busyReason: string;
}

interface LegacyClaimPreview {
  status: string;
  targetOwnerId?: string;
  eligibleCount?: number;
  busyCount?: number;
  items?: LegacyClaimItem[];
}

export const Settings: React.FC<SettingsProps> = ({
  isOpen,
  onClose,
  config,
  onConfigChange,
  onExportChat,
  onResetConfig,
  onOpenBackendManager,
  onExportData,
  onImportData,
  onOpenConnectionPanel,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userAvatarInputRef = useRef<HTMLInputElement>(null);
  const settingsContentRef = useRef<HTMLElement>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [sttCfg, setSttCfg] = useState<any>(null);
  const [sttSaving, setSttSaving] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [localInstalled, setLocalInstalled] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [activePage, setActivePage] = useState<SettingsPage>('user');
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voicePreviewing, setVoicePreviewing] = useState(false);
  const [voicePreviewError, setVoicePreviewError] = useState('');
  const [relayUser, setRelayUser] = useState<RelayUserProfile | null>(null);
  const [userDraft, setUserDraft] = useState<RelayUserProfile | null>(null);
  const [userLoading, setUserLoading] = useState(false);
  const [userSaving, setUserSaving] = useState(false);
  const [userError, setUserError] = useState('');
  const [userSaved, setUserSaved] = useState(false);
  const [avatarPreviewOpen, setAvatarPreviewOpen] = useState(false);
  const [legacyClaimPreview, setLegacyClaimPreview] = useState<LegacyClaimPreview | null>(null);
  const [legacyClaimSelected, setLegacyClaimSelected] = useState<string[]>([]);
  const [legacyClaimLoading, setLegacyClaimLoading] = useState(false);
  const [legacyClaimRunning, setLegacyClaimRunning] = useState(false);
  const [legacyClaimError, setLegacyClaimError] = useState('');
  const [legacyClaimResult, setLegacyClaimResult] = useState<{ count: number; backupPath: string } | null>(null);
  const [releaseCenterOpen, setReleaseCenterOpen] = useState(false);
  const voicePreviewVersionRef = useRef(0);
  const voicePreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const voicePreviewUrlRef = useRef('');
  const voicePreviewUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const desktopRuntime = isTauri();
  const visiblePages = SETTINGS_PAGES.filter((page) => !page.desktopOnly || desktopRuntime);
  const activePageMeta = SETTINGS_PAGES.find((page) => page.id === activePage)
    || SETTINGS_PAGES[0];

  const stopVoicePreview = useCallback(() => {
    voicePreviewVersionRef.current += 1;
    if (voicePreviewUtteranceRef.current && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    voicePreviewUtteranceRef.current = null;
    if (voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current.pause();
      voicePreviewAudioRef.current.src = '';
      voicePreviewAudioRef.current = null;
    }
    if (voicePreviewUrlRef.current) {
      URL.revokeObjectURL(voicePreviewUrlRef.current);
      voicePreviewUrlRef.current = '';
    }
    setVoicePreviewing(false);
  }, []);

  useEffect(() => {
    if (isOpen && settingsContentRef.current) settingsContentRef.current.scrollTop = 0;
  }, [activePage, isOpen]);

  useEffect(() => {
    if (!isOpen || activePage !== 'voice' || !('speechSynthesis' in window)) return;
    const refreshVoices = () => {
      const voices = window.speechSynthesis.getVoices().slice().sort((left, right) => {
        const rank = (lang: string) => /^zh(?:-|_)/i.test(lang) ? 0 : /^en(?:-|_)/i.test(lang) ? 1 : 2;
        return rank(left.lang) - rank(right.lang)
          || left.lang.localeCompare(right.lang)
          || left.name.localeCompare(right.name);
      });
      setSystemVoices(voices);
    };
    refreshVoices();
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices);
  }, [activePage, isOpen]);

  useEffect(() => {
    if (!isOpen || activePage !== 'voice') stopVoicePreview();
  }, [activePage, isOpen, stopVoicePreview]);

  useEffect(() => () => stopVoicePreview(), [stopVoicePreview]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    api.getAppVersion().then((v) => { if (!cancelled) setAppVersion(v); }).catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || activePage !== 'user') return;
    const target = getConnectionTarget();
    setUserError('');
    setUserSaved(false);
    setRelayUser(null);
    setUserDraft(null);
    if (target.mode === 'local') {
      const local: RelayUserProfile = {
        userId: 'local', username: 'local', displayName: '本机用户',
        avatarData: '', avatarColor: '#64748b', managed: false,
      };
      setRelayUser(local);
      setUserDraft(local);
      setUserLoading(false);
      return;
    }
    let cancelled = false;
    if (target.user) {
      setRelayUser(target.user);
      setUserDraft(target.user);
    }
    setUserLoading(true);
    getRelayUserProfile(target.url, target.token).then((profile) => {
      if (cancelled) return;
      setRelayUser(profile);
      setUserDraft(profile);
      rememberRelayUserProfile(profile);
    }).catch((error: any) => {
      if (!cancelled) setUserError(
        target.user
          ? `当前显示本地缓存身份；在线验证失败：${error?.message || 'Relay 未响应'}`
          : (error?.message || '当前用户验证失败'),
      );
    }).finally(() => {
      if (!cancelled) setUserLoading(false);
    });
    return () => { cancelled = true; };
  }, [activePage, isOpen]);

  const refreshLegacyClaimPreview = useCallback(async () => {
    const target = getConnectionTarget();
    setLegacyClaimPreview(null);
    setLegacyClaimSelected([]);
    setLegacyClaimError('');
    if (target.mode !== 'relay') return;
    setLegacyClaimLoading(true);
    try {
      const preview = await api.legacySessionOwnershipPreview();
      setLegacyClaimPreview(preview);
      setLegacyClaimSelected(
        (preview.items || []).filter((item) => !item.busyReason).map((item) => item.id),
      );
    } catch (error: any) {
      setLegacyClaimError(error?.message || '无法检查历史 Session');
    } finally {
      setLegacyClaimLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen || activePage !== 'user') return;
    setLegacyClaimResult(null);
    void refreshLegacyClaimPreview();
  }, [activePage, isOpen, refreshLegacyClaimPreview]);

  const handleUserSave = useCallback(async () => {
    const target = getConnectionTarget();
    if (target.mode !== 'relay' || !userDraft?.managed) return;
    setUserSaving(true);
    setUserError('');
    setUserSaved(false);
    try {
      const profile = await updateRelayUserProfile(target.url, target.token, {
        username: userDraft.username,
        displayName: userDraft.displayName,
        avatarData: userDraft.avatarData,
        avatarColor: userDraft.avatarColor,
      });
      setRelayUser(profile);
      setUserDraft(profile);
      rememberRelayUserProfile(profile);
      setUserSaved(true);
    } catch (error: any) {
      setUserError(error?.message || '保存用户档案失败');
    } finally {
      setUserSaving(false);
    }
  }, [userDraft]);

  const handleUserAvatar = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setUserError('');
    try {
      const avatarData = await resizeAvatar(file);
      setUserDraft((current) => current ? { ...current, avatarData } : current);
    } catch (error: any) {
      setUserError(error?.message || '头像读取失败');
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !userDraft?.avatarData) setAvatarPreviewOpen(false);
  }, [isOpen, userDraft?.avatarData]);

  const handleClaimLegacySessions = useCallback(async () => {
    if (!legacyClaimSelected.length || legacyClaimRunning) return;
    const confirmed = window.confirm(
      `将 ${legacyClaimSelected.length} 个历史 Session 归属到当前用户。\n\n`
      + '执行端会先自动创建完整备份；迁移后，本地直连将不再显示这些 Session。是否继续？',
    );
    if (!confirmed) return;
    setLegacyClaimRunning(true);
    setLegacyClaimError('');
    setLegacyClaimResult(null);
    try {
      const result = await api.claimLegacySessions(legacyClaimSelected);
      if (result.status !== 'ok') throw new Error(result.message || '历史 Session 认领失败');
      setLegacyClaimResult({
        count: Number(result.count || 0),
        backupPath: String(result.backupPath || ''),
      });
      await refreshLegacyClaimPreview();
    } catch (error: any) {
      setLegacyClaimError(error?.message || '历史 Session 认领失败');
    } finally {
      setLegacyClaimRunning(false);
    }
  }, [legacyClaimRunning, legacyClaimSelected, refreshLegacyClaimPreview]);

  // 语音配置及麦克风权限只在进入“语音”页时加载。分页后不应仅仅打开
  // 设置就初始化音频设备，也避免其它页面为不可见内容支付启动开销。
  useEffect(() => {
    if (!isOpen || activePage !== 'voice') return;
    let cancelled = false;
    api.getSttConfig().then((c) => {
      if (cancelled) return;
      setSttCfg(c);
      if (c?.mode === 'local') {
        api.sttCheckLocal().then((r) => { if (!cancelled) setLocalInstalled(r.installed); }).catch(() => {});
      }
    }).catch(() => {});
    // navigator.mediaDevices 仅在安全上下文（https / localhost）下存在；
    // 通过明文 http + 局域网 IP 访问时为 undefined，直接取用会抛 TypeError。
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
          stream.getTracks().forEach(t => t.stop());
          return navigator.mediaDevices.enumerateDevices();
        })
        .then((devices) => {
          if (!cancelled) setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [activePage, isOpen]);

  const handleSttChange = useCallback((field: string, value: string | boolean) => {
    setSttCfg((prev: any) => {
      if (!prev) return prev;
      const next = { ...prev, [field]: value };
      if (field === 'mode' && value === 'dashscope' && !DASHSCOPE_REALTIME_MODELS.has(next.apiModel)) {
        next.apiModel = DASHSCOPE_REALTIME_DEFAULT;
        next.flashModel = DASHSCOPE_FLASH_DEFAULT;
      }
      return next;
    });
    if (field === 'mode' && value === 'local') {
      api.sttCheckLocal().then((r) => setLocalInstalled(r.installed)).catch(() => {});
    }
  }, []);

  const handleSttSave = useCallback(async () => {
    if (!sttCfg) return;
    setSttSaving(true);
    await api.saveSttConfig(sttCfg);
    setSttSaving(false);
  }, [sttCfg]);

  const handleSttInstall = useCallback(async () => {
    setInstalling(true);
    setInstallLog('正在安装 faster-whisper...\n');
    try {
      const res = await api.sttInstallLocal();
      setInstallLog(prev => prev + (res.output || '') + '\n');
      if (res.ok) {
        setLocalInstalled(true);
        setInstallLog(prev => prev + '✅ 安装成功！');
      } else {
        setInstallLog(prev => prev + '❌ 安装失败');
      }
    } catch (e: any) {
      setInstallLog(prev => prev + '❌ ' + (e.message || '安装异常'));
    } finally {
      setInstalling(false);
    }
  }, []);

  const handleVoicePreview = useCallback(async () => {
    if (voicePreviewing) {
      stopVoicePreview();
      return;
    }
    stopVoicePreview();
    const version = ++voicePreviewVersionRef.current;
    setVoicePreviewError('');
    setVoicePreviewing(true);
    const sample = '在呢，请说。';
    try {
      if (config.realtimeVoiceTtsEngine === 'system') {
        if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
          throw new Error('当前客户端没有可用的系统语音');
        }
        const utterance = new SpeechSynthesisUtterance(sample);
        const selected = systemVoices.find((item) => (
          item.voiceURI === config.realtimeVoiceSystemVoice
          || item.name === config.realtimeVoiceSystemVoice
        ));
        if (selected) {
          utterance.voice = selected;
          utterance.lang = selected.lang;
        } else {
          utterance.lang = 'zh-CN';
        }
        utterance.rate = systemSpeechRate(config.ttsRate);
        voicePreviewUtteranceRef.current = utterance;
        utterance.onend = () => {
          if (voicePreviewVersionRef.current === version) stopVoicePreview();
        };
        utterance.onerror = () => {
          if (voicePreviewVersionRef.current !== version) return;
          setVoicePreviewError('本机语音试听失败');
          stopVoicePreview();
        };
        window.speechSynthesis.speak(utterance);
        return;
      }

      const backendEngine = config.realtimeVoiceTtsEngine === 'dashscope'
        ? 'dashscope'
        : 'edge';
      const selectedVoice = backendEngine === 'dashscope'
        ? config.realtimeVoiceDashScopeVoice
        : config.ttsVoice;
      const selectedModel = backendEngine === 'dashscope'
        ? config.realtimeVoiceDashScopeModel
        : '';
      const result = await api.ttsSynthesize(
        sample,
        selectedVoice,
        config.ttsRate,
        backendEngine,
        selectedModel,
      );
      if (voicePreviewVersionRef.current !== version) return;
      if (!result.ok || !result.base64) throw new Error(result.error || 'TTS 未返回音频');
      const blob = new Blob([base64ToArrayBuffer(result.base64)], {
        type: result.mime || 'audio/mpeg',
      });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      voicePreviewUrlRef.current = url;
      voicePreviewAudioRef.current = audio;
      audio.onended = () => {
        if (voicePreviewVersionRef.current === version) stopVoicePreview();
      };
      audio.onerror = () => {
        if (voicePreviewVersionRef.current !== version) return;
          setVoicePreviewError('TTS 音频播放失败');
        stopVoicePreview();
      };
      await audio.play();
    } catch (cause: any) {
      if (voicePreviewVersionRef.current !== version) return;
      setVoicePreviewError(cause?.message || '语音试听失败');
      stopVoicePreview();
    }
  }, [config, stopVoicePreview, systemVoices, voicePreviewing]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onConfigChange({ bgImage: reader.result as string });
    };
    reader.readAsDataURL(file);
    // Reset so selecting the same file again triggers onChange
    e.target.value = '';
  }, [onConfigChange]);

  const userDirty = !!relayUser && !!userDraft && (
    relayUser.username !== userDraft.username
    || relayUser.displayName !== userDraft.displayName
    || relayUser.avatarData !== userDraft.avatarData
    || relayUser.avatarColor !== userDraft.avatarColor
  );

  if (!isOpen) return null;

  return (
    <div style={overlayStyle}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div style={settingsHeaderStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650, color: 'var(--theme-text)' }}>设置</h2>
            <div style={{ marginTop: 3, fontSize: 10, color: 'var(--theme-text-muted)' }}>
              AgentWithU preferences
            </div>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        <div style={settingsBodyStyle}>
          <nav style={settingsNavStyle} aria-label="设置分类">
            {visiblePages.map((page) => {
              const selected = activePage === page.id;
              return (
                <button
                  key={page.id}
                  type="button"
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => setActivePage(page.id)}
                  style={{
                    ...settingsNavButtonStyle,
                    color: selected ? 'var(--theme-text)' : 'var(--theme-text-muted)',
                    background: selected ? 'var(--theme-accent-bg)' : 'transparent',
                    borderLeftColor: selected ? 'var(--theme-accent)' : 'transparent',
                  }}
                >
                  <span style={{ width: 18, textAlign: 'center', fontSize: 13 }}>{page.icon}</span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12, fontWeight: selected ? 650 : 520 }}>
                      {page.label}
                    </span>
                    <span style={settingsNavDescriptionStyle}>{page.description}</span>
                  </span>
                </button>
              );
            })}
          </nav>

          <main ref={settingsContentRef} style={settingsContentStyle}>
            <div style={settingsPageHeaderStyle}>
              <div style={{ fontSize: 16, fontWeight: 650, color: 'var(--theme-text)' }}>
                {activePageMeta.label}
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--theme-text-muted)' }}>
                {activePageMeta.description}
              </div>
            </div>

        {activePage === 'user' && (
          <div style={sectionStyle}>
            {userLoading && (
              <div style={{ color: 'var(--theme-text-muted)', fontSize: 12 }}>正在向 Relay 验证当前用户…</div>
            )}
            {!userLoading && userDraft && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
                  <button
                    type="button"
                    disabled={!userDraft.avatarData}
                    onClick={() => setAvatarPreviewOpen(true)}
                    aria-label={userDraft.avatarData ? '放大查看当前头像' : '尚未设置头像'}
                    title={userDraft.avatarData ? '点击放大查看' : '尚未设置头像'}
                    style={{
                      width: 64, height: 64, padding: 0, flexShrink: 0, overflow: 'hidden', position: 'relative',
                      borderRadius: '50%', border: '1px solid var(--theme-border)', cursor: userDraft.avatarData ? 'zoom-in' : 'default',
                      color: '#fff', background: userDraft.avatarColor, fontSize: 23, fontWeight: 700,
                    }}
                  >
                    {userDraft.avatarData ? (
                      <>
                        <img src={userDraft.avatarData} alt="当前头像" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        <span aria-hidden="true" style={{
                          position: 'absolute', right: 2, bottom: 2, width: 17, height: 17,
                          display: 'grid', placeItems: 'center', borderRadius: '50%',
                          background: 'rgba(7,12,20,.74)', border: '1px solid rgba(255,255,255,.5)',
                          color: '#fff', fontSize: 9, lineHeight: 1,
                        }}>↗</span>
                      </>
                    ) : (userDraft.displayName || userDraft.username).slice(0, 1).toUpperCase()}
                  </button>
                  <input
                    ref={userAvatarInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      void handleUserAvatar(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: 'var(--theme-text)', fontSize: 16, fontWeight: 650 }}>
                      {userDraft.displayName}
                    </div>
                    <div style={{
                      marginTop: 4, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap',
                      color: 'var(--theme-text-muted)', fontSize: 11,
                    }}>
                      <span>@{userDraft.username} · {getConnectionTarget().mode === 'local' ? '本机直连' : 'Relay 已验证'}</span>
                      {userDraft.managed && (
                        <button
                          type="button"
                          onClick={() => userAvatarInputRef.current?.click()}
                          style={profileInlineButtonStyle}
                        >{userDraft.avatarData ? '更换头像' : '上传头像'}</button>
                      )}
                      {userDraft.managed && userDraft.avatarData && (
                        <button
                          type="button"
                          onClick={() => {
                            setAvatarPreviewOpen(false);
                            setUserDraft((current) => current ? { ...current, avatarData: '' } : current);
                          }}
                          style={{ ...profileInlineButtonStyle, color: 'var(--theme-error, #f85149)' }}
                        >移除</button>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 1fr) minmax(110px, 1fr)', gap: 10 }}>
                  <label style={labelStyle}>
                    用户名
                    <input
                      value={userDraft.username}
                      disabled={!userDraft.managed}
                      maxLength={40}
                      onChange={(event) => setUserDraft({ ...userDraft, username: event.target.value })}
                      style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginTop: 5 }}
                    />
                  </label>
                  <label style={labelStyle}>
                    展示名
                    <input
                      value={userDraft.displayName}
                      disabled={!userDraft.managed}
                      maxLength={60}
                      onChange={(event) => setUserDraft({ ...userDraft, displayName: event.target.value })}
                      style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginTop: 5 }}
                    />
                  </label>
                </div>
                <label style={labelStyle}>
                  用户 ID（永久不变）
                  <input
                    value={userDraft.userId}
                    readOnly
                    style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginTop: 5, fontFamily: 'monospace', opacity: 0.72 }}
                  />
                </label>
                {userDraft.managed && (
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                    头像底色
                    <input
                      type="color"
                      value={userDraft.avatarColor}
                      onChange={(event) => setUserDraft({ ...userDraft, avatarColor: event.target.value })}
                      style={{ width: 42, height: 28, border: '1px solid var(--theme-border)', background: 'transparent' }}
                    />
                  </label>
                )}

                {!userDraft.managed && (
                  <div style={hintStyle}>
                    {getConnectionTarget().mode === 'local'
                      ? '本机直连只显示 local Session。家里的执行端若要查看某位 Relay 用户的 RemoteSession，也需要点击下方按钮验证并切换到该用户。'
                      : '当前 Relay 仍在旧版单 token 兼容模式；创建 Relay 用户后即可改名和配置头像。'}
                  </div>
                )}
                {userError && <div style={{ marginTop: 10, color: 'var(--theme-error, #f85149)', fontSize: 12 }}>{userError}</div>}
                {userSaved && <div style={{ marginTop: 10, color: 'var(--theme-success, #2da44e)', fontSize: 12 }}>用户档案已保存，userId 未改变。</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  {userDraft.managed && (
                    <button
                      type="button"
                      disabled={!userDirty || userSaving}
                      onClick={() => void handleUserSave()}
                      style={{ ...actionBtnStyle, opacity: !userDirty || userSaving ? 0.5 : 1 }}
                    >{userSaving ? '保存中…' : '保存用户档案'}</button>
                  )}
                  <button type="button" onClick={onOpenConnectionPanel} style={actionBtnStyle}>
                    验证 / 切换用户
                  </button>
                </div>

                {getConnectionTarget().mode === 'relay' && userDraft.managed && (
                  <div style={{
                    marginTop: 18, paddingTop: 16,
                    borderTop: '1px solid var(--theme-border)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={{ color: 'var(--theme-text)', fontSize: 13, fontWeight: 650 }}>
                          历史 Session 归属
                        </div>
                        <div style={{ marginTop: 4, color: 'var(--theme-text-muted)', fontSize: 11, lineHeight: 1.55 }}>
                          设备主用户可将升级前的 local Session 一次性认领到当前 userId；执行前自动完整备份。
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void refreshLegacyClaimPreview()}
                        disabled={legacyClaimLoading || legacyClaimRunning}
                        style={{ ...actionBtnStyle, flexShrink: 0, opacity: legacyClaimLoading ? 0.55 : 1 }}
                      >刷新</button>
                    </div>

                    {legacyClaimLoading && (
                      <div style={{ marginTop: 12, color: 'var(--theme-text-muted)', fontSize: 12 }}>
                        正在检查执行端的历史 Session…
                      </div>
                    )}

                    {!legacyClaimLoading && legacyClaimPreview && (
                      <>
                        <div style={{
                          marginTop: 12, padding: '9px 10px', display: 'flex', gap: 12, flexWrap: 'wrap',
                          background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
                        }}>
                          <span style={{ color: 'var(--theme-text)', fontSize: 11 }}>
                            可认领 {legacyClaimPreview.eligibleCount || 0}
                          </span>
                          {!!legacyClaimPreview.busyCount && (
                            <span style={{ color: 'var(--theme-warning, #d29922)', fontSize: 11 }}>
                              运行中 {legacyClaimPreview.busyCount}
                            </span>
                          )}
                          <span style={{ color: 'var(--theme-text-muted)', fontSize: 11, fontFamily: 'monospace' }}>
                            → {legacyClaimPreview.targetOwnerId}
                          </span>
                        </div>

                        {(legacyClaimPreview.items || []).length > 0 ? (
                          <div style={{
                            marginTop: 10, maxHeight: 260, overflowY: 'auto',
                            border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)',
                          }}>
                            {(legacyClaimPreview.items || []).map((item) => {
                              const checked = legacyClaimSelected.includes(item.id);
                              const disabled = !!item.busyReason || legacyClaimRunning;
                              return (
                                <label key={item.id} style={{
                                  display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: 9,
                                  padding: '9px 10px', borderBottom: '1px solid var(--theme-border)',
                                  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
                                }}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={disabled}
                                    onChange={(event) => setLegacyClaimSelected((current) => (
                                      event.target.checked
                                        ? Array.from(new Set([...current, item.id]))
                                        : current.filter((id) => id !== item.id)
                                    ))}
                                    style={{ marginTop: 2, accentColor: 'var(--theme-accent)' }}
                                  />
                                  <span style={{ minWidth: 0 }}>
                                    <span style={{ display: 'block', color: 'var(--theme-text)', fontSize: 12, fontWeight: 600 }}>
                                      {item.title}
                                    </span>
                                    <span style={{
                                      display: 'block', marginTop: 3, color: 'var(--theme-text-muted)', fontSize: 10,
                                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                    }} title={item.workingDir}>
                                      {new Date(Number(item.updatedAt || 0) * 1000).toLocaleString()} · {item.messageCount} 条
                                      {item.workingDir ? ` · ${item.workingDir}` : ''}
                                    </span>
                                    {item.busyReason && (
                                      <span style={{ display: 'block', marginTop: 3, color: 'var(--theme-warning, #d29922)', fontSize: 10 }}>
                                        暂不可迁移：{item.busyReason}
                                      </span>
                                    )}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        ) : (
                          <div style={{ marginTop: 12, color: 'var(--theme-success, #2da44e)', fontSize: 12 }}>
                            没有待认领的历史 Session。
                          </div>
                        )}

                        {!!(legacyClaimPreview.eligibleCount || 0) && (
                          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              onClick={() => setLegacyClaimSelected(
                                (legacyClaimPreview.items || []).filter((item) => !item.busyReason).map((item) => item.id),
                              )}
                              disabled={legacyClaimRunning}
                              style={actionBtnStyle}
                            >全选可迁移项</button>
                            <button
                              type="button"
                              onClick={() => void handleClaimLegacySessions()}
                              disabled={!legacyClaimSelected.length || legacyClaimRunning}
                              style={{
                                ...actionBtnStyle,
                                color: '#fff', background: 'var(--theme-accent)',
                                opacity: !legacyClaimSelected.length || legacyClaimRunning ? 0.5 : 1,
                              }}
                            >{legacyClaimRunning ? '备份并迁移中…' : `认领所选 ${legacyClaimSelected.length} 项`}</button>
                          </div>
                        )}
                      </>
                    )}

                    {!legacyClaimLoading && !legacyClaimPreview && legacyClaimError && (
                      <div style={{ marginTop: 12, color: 'var(--theme-text-muted)', fontSize: 11, lineHeight: 1.55 }}>
                        当前用户不是该执行端的设备主用户，或 Relay / 执行端尚未升级，因此不能认领历史 Session。
                        <br/><span style={{ opacity: 0.72 }}>{legacyClaimError}</span>
                      </div>
                    )}
                    {legacyClaimPreview && legacyClaimError && (
                      <div style={{ marginTop: 10, color: 'var(--theme-error, #f85149)', fontSize: 11 }}>
                        {legacyClaimError}
                      </div>
                    )}
                    {legacyClaimResult && (
                      <div style={{ marginTop: 10, color: 'var(--theme-success, #2da44e)', fontSize: 11, lineHeight: 1.55 }}>
                        已认领 {legacyClaimResult.count} 个 Session。
                        {legacyClaimResult.backupPath && <><br/>备份：{legacyClaimResult.backupPath}</>}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {!userLoading && !userDraft && userError && (
              <div style={{ color: 'var(--theme-error, #f85149)', fontSize: 12 }}>{userError}</div>
            )}
          </div>
        )}

        {/* 字号 */}
        {activePage === 'general' && <div style={sectionStyle}>
          <label style={labelStyle}>Font Size</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="range"
              min={11}
              max={28}
              value={config.fontSize}
              onChange={(e) => onConfigChange({ fontSize: Number(e.target.value) })}
              style={{ flex: 1, accentColor: 'var(--theme-accent)' }}
            />
            <span style={{ fontSize: 13, color: 'var(--theme-text-muted)', minWidth: 36, textAlign: 'right' }}>
              {config.fontSize}px
            </span>
          </div>
        </div>}

        {/* 主题切换 */}
        {activePage === 'appearance' && <div style={sectionStyle}>
          <label style={labelStyle}>Theme</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(Object.keys(themes) as ThemeType[]).map((themeKey) => {
              const theme = themes[themeKey];
              return (
                <button
                  key={themeKey}
                  onClick={() => onConfigChange({ theme: themeKey })}
                  style={{
                    ...themeBtnStyle,
                    background: theme.bg,
                    borderColor: config.theme === themeKey ? theme.accent : theme.border,
                    color: theme.text,
                  }}
                  title={theme.name}
                >
                  {theme.name}
                </button>
              );
            })}
          </div>
        </div>}

        {/* Markdown 渲染开关 */}
        {activePage === 'general' && <div style={sectionStyle}>
          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={config.renderMarkdown}
              onChange={(e) => onConfigChange({ renderMarkdown: e.target.checked })}
              style={{ accentColor: 'var(--theme-accent)' }}
            />
            Render Markdown in assistant messages
          </label>
        </div>}

        {/* Workspace Kits 实验特性 */}
        {activePage === 'general' && <div style={sectionStyle}>
          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={config.workspaceKitsEnabled}
              onChange={(e) => onConfigChange({ workspaceKitsEnabled: e.target.checked })}
              style={{ accentColor: 'var(--theme-accent)' }}
            />
            🧰 Workspace Kits（实验）
          </label>
          <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
            为每个 Session 启用标准配件、判言、Schedule、结果视图、终端控制与数据市场。
          </p>
        </div>}

        {/* Session 列表密度 */}
        {activePage === 'general' && <div style={sectionStyle}>
          <label style={labelStyle}>左侧 Session 展示数量</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="number"
              min={5}
              max={500}
              step={5}
              value={config.sidebarSessionLimit}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isFinite(value) && value > 0) {
                  onConfigChange({ sidebarSessionLimit: Math.min(500, Math.trunc(value)) });
                }
              }}
              onBlur={() => {
                if (!Number.isFinite(config.sidebarSessionLimit) || config.sidebarSessionLimit < 5) {
                  onConfigChange({ sidebarSessionLimit: 25 });
                }
              }}
              style={{ ...inputStyle, width: 100, flex: '0 0 auto' }}
            />
            <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', lineHeight: 1.5 }}>
              每个执行节点最近展示的普通 Session 数；收藏项始终显示。默认 25，搜索不受限制。
            </span>
          </div>
        </div>}

        {/* 导出格式 */}
        {activePage === 'general' && <div style={sectionStyle}>
          <label style={labelStyle}>Export Format</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['markdown', 'json'] as const).map((fmt) => (
              <button
                key={fmt}
                onClick={() => onConfigChange({ exportFormat: fmt })}
                style={{
                  ...formatBtnStyle,
                  background: config.exportFormat === fmt ? 'var(--theme-accent-bg)' : 'rgba(255,255,255,0.05)',
                  borderColor: config.exportFormat === fmt ? 'var(--theme-accent)' : 'var(--theme-border)',
                }}
              >
                {fmt.toUpperCase()}
              </button>
            ))}
          </div>
        </div>}

        {/* 语音转文字 (STT) 设置 */}
        {activePage === 'voice' && sttCfg && (
          <div style={sectionStyle}>
            <label style={labelStyle}>🎙️ Voice-to-Text (STT)</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select
                value={sttCfg.mode || 'api'}
                onChange={(e) => handleSttChange('mode', e.target.value)}
                style={{ ...inputStyle, flex: '0 0 auto', width: 120 }}
              >
                <option value="api">API (OpenAI)</option>
                <option value="dashscope">DashScope</option>
                <option value="local">Local</option>
              </select>
              <select
                value={sttCfg.language || 'zh'}
                onChange={(e) => handleSttChange('language', e.target.value)}
                style={{ ...inputStyle, flex: '0 0 auto', width: 80 }}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
                <option value="">Auto</option>
              </select>
            </div>
            {audioDevices.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap' }}>Mic:</span>
                <select
                  value={sttCfg.deviceId || ''}
                  onChange={(e) => handleSttChange('deviceId', e.target.value)}
                  style={{ ...inputStyle, flex: 1 }}
                >
                  <option value="">默认麦克风</option>
                  {audioDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Mic (${d.deviceId.slice(0, 8)})`}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {sttCfg.mode === 'local' && localInstalled === false && (
              <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)' }}>
                <div style={{ fontSize: 12, color: 'var(--theme-text)', marginBottom: 6 }}>⚠️ faster-whisper 未安装</div>
                <button
                  onClick={handleSttInstall}
                  disabled={installing}
                  style={{ ...actionBtnStyle, flex: 'none', opacity: installing ? 0.6 : 1 }}
                >
                  {installing ? '⏳ 安装中...' : '📦 一键安装'}
                </button>
                {installLog && (
                  <pre style={{ margin: '6px 0 0', padding: 6, borderRadius: 4, background: 'rgba(0,0,0,0.05)', color: 'var(--theme-text)', fontSize: 10, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const }}>{installLog}</pre>
                )}
              </div>
            )}
            {sttCfg.mode === 'local' && (
              <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap' }}>Model:</span>
                <select
                  value={sttCfg.localModel || 'base'}
                  onChange={(e) => handleSttChange('localModel', e.target.value)}
                  style={{ ...inputStyle, flex: '0 0 auto', width: 110 }}
                >
                  <option value="tiny">tiny (最快)</option>
                  <option value="base">base (推荐)</option>
                  <option value="small">small</option>
                  <option value="medium">medium</option>
                  <option value="large-v3">large-v3 (最佳)</option>
                </select>
              </div>
            )}
            {sttCfg.mode === 'api' && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  placeholder="API Base URL (e.g. https://api.openai.com/v1)"
                  value={sttCfg.apiBaseUrl || ''}
                  onChange={(e) => handleSttChange('apiBaseUrl', e.target.value)}
                  style={inputStyle}
                />
                <input
                  placeholder="API Key"
                  type="password"
                  value={sttCfg.apiKey || ''}
                  onChange={(e) => handleSttChange('apiKey', e.target.value)}
                  style={inputStyle}
                />
                <input
                  placeholder="Model (default: whisper-1)"
                  value={sttCfg.apiModel || ''}
                  onChange={(e) => handleSttChange('apiModel', e.target.value)}
                  style={inputStyle}
                />
              </div>
            )}
            {sttCfg.mode === 'dashscope' && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  placeholder="DashScope API Key (DASHSCOPE_API_KEY)"
                  type="password"
                  value={sttCfg.apiKey || ''}
                  onChange={(e) => handleSttChange('apiKey', e.target.value)}
                  style={inputStyle}
                />
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '88px minmax(0, 1fr)',
                  gap: '6px 8px',
                  alignItems: 'center',
                }}>
                  <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>实时识别</span>
                  <input
                    readOnly
                    value={DASHSCOPE_REALTIME_DEFAULT}
                    style={{ ...inputStyle, opacity: 0.85 }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>短音频精转</span>
                  <input
                    readOnly
                    value={DASHSCOPE_FLASH_DEFAULT}
                    style={{ ...inputStyle, opacity: 0.85 }}
                  />
                </div>
                <input
                  placeholder="DashScope 端点（可选，支持控制台 Workspace 地址）"
                  value={sttCfg.apiBaseUrl || ''}
                  onChange={(e) => handleSttChange('apiBaseUrl', e.target.value)}
                  style={inputStyle}
                />
                <input
                  placeholder="Workspace ID（可选）"
                  value={sttCfg.workspaceId || ''}
                  onChange={(e) => handleSttChange('workspaceId', e.target.value)}
                  style={inputStyle}
                />
                <label style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '7px 8px',
                  borderRadius: 6,
                  background: 'var(--theme-bg-hover)',
                  fontSize: 11,
                  color: 'var(--theme-text-muted)',
                  cursor: 'pointer',
                }}>
                  <input
                    type="checkbox"
                    checked={sttCfg.flashRefineEnabled !== false}
                    onChange={(e) => handleSttChange('flashRefineEnabled', e.target.checked)}
                    style={{ marginTop: 1 }}
                  />
                  <span>
                    停止录音后使用 Fun-ASR-Flash 精校（仅限 5 分钟以内）。
                    精校失败或录音超时会自动保留实时识别结果。
                  </span>
                </label>
                <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
                  麦克风音频以 16kHz PCM 发送到 Fun-ASR Realtime，识别结果会边说边写入输入框。
                </span>
              </div>
            )}
            <button
              onClick={handleSttSave}
              disabled={sttSaving}
              style={{
                ...actionBtnStyle,
                marginTop: 8,
                alignSelf: 'flex-start',
                background: 'rgba(9,105,218,0.15)',
                borderColor: 'rgba(9,105,218,0.3)',
              }}
            >
              {sttSaving ? '保存中...' : '💾 Save STT Config'}
            </button>
          </div>
        )}

        {/* 文字转语音 (TTS) 设置 */}
        {activePage === 'voice' && <div style={sectionStyle}>
          <label style={labelStyle}>🔊 语音与实时播音</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ width: 78, fontSize: 11, color: 'var(--theme-text-muted)' }}>实时引擎</span>
            <select
              value={config.realtimeVoiceTtsEngine ?? 'system'}
              onChange={(e) => onConfigChange({
                realtimeVoiceTtsEngine: e.target.value as 'system' | 'edge' | 'dashscope',
              })}
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            >
              <option value="system">客户端 · Windows 系统语音（最低延迟）</option>
              <option value="dashscope">执行端 · DashScope 流式 TTS（低首包延迟）</option>
              <option value="edge">执行端 Backend · Edge Neural TTS（音质优先）</option>
            </select>
            <button
              type="button"
              onClick={() => void handleVoicePreview()}
              style={{ ...actionBtnStyle, flex: '0 0 auto', padding: '6px 12px', fontSize: 11 }}
            >
              {voicePreviewing ? '停止' : '试听'}
            </button>
          </div>
          {config.realtimeVoiceTtsEngine === 'system' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <span style={{ width: 78, fontSize: 11, color: 'var(--theme-text-muted)' }}>本机音色</span>
              <select
                value={config.realtimeVoiceSystemVoice ?? ''}
                onChange={(e) => onConfigChange({ realtimeVoiceSystemVoice: e.target.value })}
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              >
                <option value="">自动选择中文系统音色</option>
                {systemVoices.map((item) => (
                  <option key={`${item.voiceURI}:${item.lang}`} value={item.voiceURI}>
                    {item.name} · {item.lang}{item.localService ? ' · 本机' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {config.realtimeVoiceTtsEngine === 'dashscope' && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <span style={{ width: 78, fontSize: 11, color: 'var(--theme-text-muted)' }}>云端模型</span>
                <input
                  value={config.realtimeVoiceDashScopeModel || 'cosyvoice-v1'}
                  maxLength={128}
                  onChange={(e) => onConfigChange({ realtimeVoiceDashScopeModel: e.target.value })}
                  placeholder="cosyvoice-v1"
                  style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <span style={{ width: 78, fontSize: 11, color: 'var(--theme-text-muted)' }}>云端音色</span>
                <input
                  value={config.realtimeVoiceDashScopeVoice || 'longxiaochun'}
                  maxLength={128}
                  onChange={(e) => onConfigChange({ realtimeVoiceDashScopeVoice: e.target.value })}
                  placeholder="longxiaochun"
                  style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                />
              </div>
              <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '6px 0 0 86px', lineHeight: 1.45 }}>
                复用执行端“语音识别”页的 DashScope API Key、Workspace ID 与地域地址；
                默认 cosyvoice-v1 + longxiaochun 已在当前接口验证。v2/v3 请配套使用账号支持的音色。
              </p>
            </>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <span style={{ width: 78, fontSize: 11, color: 'var(--theme-text-muted)' }}>Edge 音色</span>
            <select
              value={config.ttsVoice || 'zh-CN-XiaoxiaoNeural'}
              onChange={(e) => onConfigChange({ ttsVoice: e.target.value })}
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            >
              <option value="zh-CN-XiaoxiaoNeural">晓晓 · 女声，温柔自然</option>
              <option value="zh-CN-YunxiNeural">云希 · 男声，年轻活力</option>
              <option value="zh-CN-YunjianNeural">云健 · 男声，沉稳播报</option>
              <option value="zh-CN-XiaoyiNeural">晓伊 · 女声，明快活泼</option>
            </select>
          </div>
          {voicePreviewError && (
            <div style={{ marginTop: 7, fontSize: 11, color: 'var(--theme-error, #ef4444)' }}>
              {voicePreviewError}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap' }}>语速</span>
            <input
              type="range"
              min={-50}
              max={50}
              step={5}
              value={config.ttsRate ?? 0}
              onChange={(e) => onConfigChange({ ttsRate: Number(e.target.value) })}
              style={{ flex: 1, accentColor: 'var(--theme-accent)' }}
            />
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', minWidth: 42, textAlign: 'right' }}>
              {(config.ttsRate ?? 0) > 0 ? '+' : ''}{config.ttsRate ?? 0}%
            </span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '7px 0 0', lineHeight: 1.5 }}>
            实时对话按所选引擎播音；普通助手消息的 🔊 朗读继续使用 Edge 音色。
            DashScope 流式 TTS 在 Session 执行端运行，音频以 24kHz PCM 持续回传客户端。
          </p>
          <div style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: '1px solid var(--theme-border)',
            display: 'grid',
            gap: 8,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-text)' }}>
              实时语音对话 · 实验参数
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 78, fontSize: 11, color: 'var(--theme-text-muted)' }}>唤醒词</span>
              <input
                value={config.realtimeVoiceWakeWord ?? 'Yuki'}
                maxLength={24}
                placeholder="留空则直接开始"
                onChange={(e) => onConfigChange({ realtimeVoiceWakeWord: e.target.value })}
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              />
              <span style={{ width: 54, textAlign: 'right', fontSize: 10, color: 'var(--theme-text-muted)' }}>
                超时重唤醒
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 78, fontSize: 11, color: 'var(--theme-text-muted)' }}>连续会话</span>
              <input
                type="range"
                min={10_000}
                max={120_000}
                step={5_000}
                value={config.realtimeVoiceContinuousWindowMs ?? 30_000}
                onChange={(e) => onConfigChange({ realtimeVoiceContinuousWindowMs: Number(e.target.value) })}
                style={{ flex: 1, accentColor: 'var(--theme-accent)' }}
              />
              <span style={{ width: 54, textAlign: 'right', fontSize: 10, color: 'var(--theme-text-muted)' }}>
                {Math.round((config.realtimeVoiceContinuousWindowMs ?? 30_000) / 1000)} s
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 78, fontSize: 11, color: 'var(--theme-text-muted)' }}>基础停顿</span>
              <input
                type="range"
                min={900}
                max={3000}
                step={100}
                value={config.realtimeVoiceTurnEndSilenceMs ?? 1500}
                onChange={(e) => onConfigChange({ realtimeVoiceTurnEndSilenceMs: Number(e.target.value) })}
                style={{ flex: 1, accentColor: 'var(--theme-accent)' }}
              />
              <span style={{ width: 54, textAlign: 'right', fontSize: 10, color: 'var(--theme-text-muted)' }}>
                {((config.realtimeVoiceTurnEndSilenceMs ?? 1500) / 1000).toFixed(1)} s
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 78, fontSize: 11, color: 'var(--theme-text-muted)' }}>收音阈值</span>
              <input
                type="range"
                min={0.006}
                max={0.06}
                step={0.002}
                value={config.realtimeVoiceVadThreshold ?? 0.018}
                onChange={(e) => onConfigChange({ realtimeVoiceVadThreshold: Number(e.target.value) })}
                style={{ flex: 1, accentColor: 'var(--theme-accent)' }}
              />
              <span style={{ width: 54, textAlign: 'right', fontSize: 10, color: 'var(--theme-text-muted)' }}>
                {(config.realtimeVoiceVadThreshold ?? 0.018).toFixed(3)}
              </span>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--theme-text-muted)' }}>
              <input
                type="checkbox"
                checked={config.realtimeVoiceBargeIn !== false}
                onChange={(e) => onConfigChange({ realtimeVoiceBargeIn: e.target.checked })}
              />
              允许唤醒词定向打断当前 LLM 与播音（普通人声不会中止回复）
            </label>
            <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: 0, lineHeight: 1.5 }}>
              静默超过连续会话时间后会重新等待唤醒；Agent 回复期间只有“唤醒词 + 指令”才能打断。
              Yuki 建议读作“You-key”；已兼容常见英文拼写和单独出现的中文近音。听到后会先随机回应“我在 / 在呢 / I'm here”等短句，再继续收音；唤醒词留空会关闭唤醒门控，同时禁用语音打断。
            </p>
          </div>
        </div>}

        {/* 发布工作台仍按需加载，但不再依赖每台手机/浏览器各自开启一个隐藏开关。 */}
        {activePage === 'system' && <details style={sectionStyle}>
          <summary style={{
            color: 'var(--theme-text)', fontSize: 12, fontWeight: 600, cursor: 'pointer', userSelect: 'none',
          }}>维护者工具</summary>
          <div style={{ marginTop: 11, paddingTop: 10, borderTop: '1px solid var(--theme-border)' }}>
            <div style={{ color: 'var(--theme-text-muted)', fontSize: 10, lineHeight: 1.55 }}>
              选择一台执行节点，由该节点扫描打包目录、比较 stable、冻结清单并正式上传；
              手机或控制端只负责确认和查看进度。打包与 Workspace Kit 仍然只登记候选。
            </div>
            <button type="button" onClick={() => setReleaseCenterOpen(true)} style={{
              ...actionBtnStyle, marginTop: 10, background: 'var(--theme-accent-bg)', borderColor: 'var(--theme-accent)',
            }}>
              🚀 打开发布工作台
            </button>
          </div>
        </details>}

        {/* 节点更新：单机一键更新 + Relay 跨节点批量更新 */}
        {activePage === 'system' && <UpdateCenter />}

        {/* 数据导入导出 */}
        {activePage === 'system' && <div style={sectionStyle}>
          <label style={labelStyle}>Data Management</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onExportData}
              style={{
                ...actionBtnStyle,
                background: 'rgba(34,197,94,0.15)',
                borderColor: 'rgba(34,197,94,0.3)',
              }}
              title="Export backends + Repo (Prompts + Skills). Sessions are NOT included."
            >
              📤 Export Data
            </button>
            <button
              onClick={onImportData}
              style={{
                ...actionBtnStyle,
                background: 'rgba(239,68,68,0.15)',
                borderColor: 'rgba(239,68,68,0.3)',
              }}
              title="Import backends + Repo (overwrites existing). Sessions are untouched."
            >
              📥 Import Data
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 6, margin: '6px 0 0 0' }}>
            Includes: Backends config + Repo (Prompts + Skills). Sessions are NOT included.
            <br />
            整包导入按名称合并并覆盖匹配项；不会删除包外条目。若只迁移部分 Backend，
            请使用上方 Manage Backends 内的“导入 / 导出”，可逐项勾选并选择冲突策略。Skill credentials stay local.
          </p>
        </div>}

        {activePage === 'desktop' && desktopRuntime && (
          <div style={sectionStyle}>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={config.desktopTaskNotifications}
                onChange={(e) => onConfigChange({ desktopTaskNotifications: e.target.checked })}
                style={{ accentColor: 'var(--theme-accent)' }}
              />
              任务完成时显示 Windows 通知
            </label>
            <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
              仅在 AgentWithU 最小化、隐藏或未聚焦时提醒；全屏游戏、视频或演示期间自动免打扰。
            </p>
          </div>
        )}

        {activePage === 'desktop' && desktopRuntime && (
          <div style={sectionStyle}>
            <label style={labelStyle}>〰️ Smooth 顺滑问答</label>
            <HackerModeSetting />
          </div>
        )}

        {/* 截图全局快捷键(Tauri only) */}
        {activePage === 'desktop' && desktopRuntime && (
          <div style={sectionStyle}>
            <label style={labelStyle}>全局截图快捷键（默认关闭）</label>
            <ScreenshotHotkeySetting />
            <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 6, margin: '6px 0 0 0' }}>
              显式设置后可在 AgentWithU 后台时调起系统截图；全屏游戏、视频或演示期间会自动暂停。
              截图会加入当前焦点输入框的附件。
            </p>
          </div>
        )}

        {/* 界面透明度 */}
        {activePage === 'appearance' && <div style={sectionStyle}>
          <label style={labelStyle}>Panel Transparency</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={config.uiOpacity ?? 1}
              onChange={(e) => onConfigChange({ uiOpacity: Number(e.target.value) })}
              style={{ flex: 1, accentColor: 'var(--theme-accent)' }}
            />
            <span style={{ fontSize: 13, color: 'var(--theme-text-muted)', minWidth: 36, textAlign: 'right' }}>
              {Math.round((config.uiOpacity ?? 1) * 100)}%
            </span>
          </div>
          <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--theme-text-muted)' }}>
            Controls bubble / sidebar / header background opacity
          </span>
        </div>}

        {/* 背景图 */}
        {activePage === 'appearance' && <div style={sectionStyle}>
          <label style={labelStyle}>Background Image</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: config.bgImage ? 10 : 0 }}>
            {config.bgImage && (
              <img
                src={config.bgImage}
                style={{ width: 52, height: 34, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--theme-border)', flexShrink: 0 }}
              />
            )}
            <button onClick={() => fileInputRef.current?.click()} style={actionBtnStyle}>
              {config.bgImage ? '🖼 Change' : '🖼 Select Image'}
            </button>
            {config.bgImage && (
              <button
                onClick={() => onConfigChange({ bgImage: '' })}
                style={{ ...actionBtnStyle, flex: 'none', padding: '8px 10px', background: 'rgba(255,80,80,0.12)', borderColor: 'rgba(255,80,80,0.3)' }}
                title="Remove background image"
              >
                ✕
              </button>
            )}
          </div>
          {config.bgImage && (
            <div>
              <label style={{ ...labelStyle, marginBottom: 4 }}>Opacity</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={config.bgOpacity}
                  onChange={(e) => onConfigChange({ bgOpacity: Number(e.target.value) })}
                  style={{ flex: 1, accentColor: 'var(--theme-accent)' }}
                />
                <span style={{ fontSize: 13, color: 'var(--theme-text-muted)', minWidth: 36, textAlign: 'right' }}>
                  {Math.round(config.bgOpacity * 100)}%
                </span>
              </div>
            </div>
          )}
        </div>}

        {/* 操作按钮 */}
        {activePage === 'system' && <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={onExportChat} style={actionBtnStyle}>
            📥 Export Chat
          </button>
          <button
            onClick={onResetConfig}
            style={{ ...actionBtnStyle, background: 'rgba(255,80,80,0.12)', borderColor: 'rgba(255,80,80,0.3)' }}
          >
            ↩ Reset Defaults
          </button>
        </div>}

        {/* ---- 分隔线 ---- */}
        {activePage === 'system' && <div style={{ borderTop: '1px solid var(--theme-border)', margin: '20px 0' }} />}

        {/* 后端管理 */}
        {activePage === 'system' && <div style={sectionStyle}>
          <label style={labelStyle}>Model Backends</label>
          <button
            onClick={onOpenBackendManager}
            style={{ ...actionBtnStyle, flex: 'none', width: '100%', background: 'rgba(99,102,241,0.15)', borderColor: 'rgba(99,102,241,0.3)' }}
          >
            🔌 Manage Backends
          </button>
        </div>}

        {/* ---- 分隔线 ---- */}
        {activePage === 'system' && <div style={{ borderTop: '1px solid var(--theme-border)', margin: '20px 0' }} />}

        {/* 关于 */}
        {activePage === 'system' && <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text)' }}>AgentWithU</span>
            <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', marginLeft: 8 }}>
              v{appVersion || '…'}
            </span>
          </div>
          <a
            href="https://github.com/SalienceM/agent-with-u"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, color: 'var(--theme-accent)', textDecoration: 'none' }}
          >
            Source ↗
          </a>
        </div>}
          </main>
        </div>
      </div>
      {avatarPreviewOpen && userDraft?.avatarData && (
        <AvatarPreviewDialog
          src={userDraft.avatarData}
          displayName={userDraft.displayName || userDraft.username}
          onClose={() => setAvatarPreviewOpen(false)}
        />
      )}
      {releaseCenterOpen && (
        <React.Suspense fallback={<div style={{
          position: 'fixed', inset: 0, zIndex: 1400, display: 'grid', placeItems: 'center',
          background: 'rgba(2,6,12,.76)', color: 'var(--theme-text-muted)', fontSize: 12,
        }}>正在加载发布工作台…</div>}>
          <LazyReleaseCenter onClose={() => setReleaseCenterOpen(false)} />
        </React.Suspense>
      )}
    </div>
  );
};

/* ---- styles ---- */
const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  padding: 16, boxSizing: 'border-box', overflow: 'hidden',
};
const panelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary, #1e1e36)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  borderRadius: 6,
  padding: 0,
  width: 'min(920px, calc(100vw - 32px))',
  height: 'min(720px, calc(100dvh - 32px))',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
};
const settingsHeaderStyle: React.CSSProperties = {
  height: 'var(--ui-panel-header-height, 62px)',
  flex: '0 0 var(--ui-panel-header-height, 62px)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0 var(--ui-space-lg, 18px) 0 var(--ui-space-lg, 20px)',
  borderBottom: '1px solid var(--theme-border)',
  background: 'var(--theme-bg-secondary)',
  boxSizing: 'border-box',
};
const settingsBodyStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  overflow: 'hidden',
};
const settingsNavStyle: React.CSSProperties = {
  flex: '0 0 clamp(118px, 21vw, 178px)',
  minWidth: 0,
  padding: 'var(--ui-space-md, 12px) var(--ui-space-sm, 8px)',
  borderRight: '1px solid var(--theme-border)',
  background: 'var(--theme-bg-secondary)',
  overflowY: 'auto',
  boxSizing: 'border-box',
};
const settingsNavButtonStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 'var(--ui-group-height, 48px)',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 7,
  padding: 'var(--ui-space-sm, 8px) 8px var(--ui-space-sm, 8px) 7px',
  marginBottom: 3,
  border: 'none',
  borderLeft: '2px solid transparent',
  borderRadius: 2,
  textAlign: 'left',
  fontFamily: 'inherit',
  cursor: 'pointer',
};
const settingsNavDescriptionStyle: React.CSSProperties = {
  display: 'block',
  marginTop: 3,
  overflow: 'hidden',
  color: 'var(--theme-text-muted)',
  fontSize: 9,
  lineHeight: 1.3,
};
const settingsContentStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  padding: 'var(--ui-settings-content-padding, 20px clamp(14px, 3vw, 26px) 28px)',
  boxSizing: 'border-box',
};
const settingsPageHeaderStyle: React.CSSProperties = {
  marginBottom: 'var(--ui-space-lg, 16px)',
  paddingBottom: 'var(--ui-space-md, 13px)',
  borderBottom: '1px solid var(--theme-border)',
};
const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none',
  color: 'var(--theme-text-muted, rgba(255,255,255,0.4))',
  fontSize: 18, cursor: 'pointer', padding: '4px 8px',
};
const sectionStyle: React.CSSProperties = {
  marginBottom: 'var(--ui-space-md, 12px)',
  padding: 'var(--ui-section-padding, 14px)',
  border: '1px solid var(--theme-border)',
  borderRadius: 5,
  background: 'color-mix(in srgb, var(--theme-bg-secondary) 74%, transparent)',
};
const labelStyle: React.CSSProperties = {
  fontSize: 13, fontWeight: 500,
  color: 'var(--theme-text, rgba(255,255,255,0.7))',
  marginBottom: 6, display: 'block',
};
const avatarPreviewControlStyle: React.CSSProperties = {
  width: 30, height: 30, padding: 0, display: 'grid', placeItems: 'center',
  border: '1px solid var(--theme-border)', borderRadius: 3,
  background: 'var(--theme-input-bg)', color: 'var(--theme-text)',
  fontSize: 14, cursor: 'pointer', fontFamily: 'inherit',
};
const profileInlineButtonStyle: React.CSSProperties = {
  padding: '3px 7px', border: '1px solid var(--theme-border)', borderRadius: 3,
  background: 'var(--theme-input-bg)', color: 'var(--theme-text)',
  fontSize: 10, lineHeight: 1.25, cursor: 'pointer', fontFamily: 'inherit',
};
const hintStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '9px 10px',
  borderLeft: '2px solid var(--theme-accent)',
  background: 'var(--theme-accent-bg)',
  color: 'var(--theme-text-muted)',
  fontSize: 11,
  lineHeight: 1.55,
};
const formatBtnStyle: React.CSSProperties = {
  padding: '6px 16px', borderRadius: 4, border: '1px solid', fontSize: 12,
  fontWeight: 600, cursor: 'pointer',
  color: 'var(--theme-text, #e0e0e0)',
  transition: 'all 0.15s',
};
const inputStyle: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'var(--theme-input-bg, #fff)',
  color: 'var(--theme-text, #1f2328)',
  fontSize: 12, outline: 'none', fontFamily: 'inherit',
};
const actionBtnStyle: React.CSSProperties = {
  flex: 1, padding: '8px 12px', borderRadius: 5,
  border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  background: 'rgba(255,255,255,0.05)',
  color: 'var(--theme-text, #e0e0e0)',
  fontSize: 13, cursor: 'pointer', transition: 'all 0.15s',
};
const themeBtnStyle: React.CSSProperties = {
  flex: '1 1 86px', padding: '10px 12px', borderRadius: 5, border: '2px solid', fontSize: 12,
  fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
  boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
};

const HackerModeSetting: React.FC = () => {
  const [value, setValue] = useState<HackerModeConfig>(() => readHackerMode());
  const [selectorOpening, setSelectorOpening] = useState(false);
  const [selectorError, setSelectorError] = useState('');
  const update = (patch: Partial<HackerModeConfig>) => setValue(writeHackerMode(patch));
  const updateNumber = (key: 'doubleClickMs' | 'x' | 'y' | 'width' | 'height', raw: string) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) update({ [key]: Math.round(parsed) });
  };

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: undefined | (() => void);
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ x: number; y: number; width: number; height: number }>(
        'smooth-region-selected',
        (event) => setValue(writeHackerMode({ captureMode: 'region', ...event.payload })),
      );
    })().catch((error) => console.error('[smooth] region listener failed:', error));
    return () => unlisten?.();
  }, []);

  const openRegionSelector = async () => {
    update({ captureMode: 'region' });
    if (!isTauri()) return;
    if (selectorOpening) return;
    setSelectorOpening(true);
    setSelectorError('');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_smooth_region_selector', {
        selection: {
          x: value.x,
          y: value.y,
          width: value.width,
          height: value.height,
        },
      });
    } catch (error) {
      console.error('[smooth] open region selector failed:', error);
      setSelectorError(`选区窗口打开失败：${String(error)}`);
    } finally {
      setSelectorOpening(false);
    }
  };
  return (
    <div style={{
      padding: 12, borderRadius: 10,
      border: `1px solid ${value.enabled ? 'rgba(34,211,238,.55)' : 'var(--theme-border)'}`,
      background: value.enabled ? 'rgba(6,182,212,.08)' : 'rgba(255,255,255,.025)',
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
        <input type="checkbox" checked={value.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
          style={{ accentColor: '#22d3ee' }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text)' }}>
          {value.enabled ? 'SMOOTH · 后台待命' : '开启 Smooth 模式'}
        </span>
      </label>
      <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
          触发鼠标键
          <select value={value.mouseButton}
            onChange={(e) => update({ mouseButton: e.target.value as HackerModeConfig['mouseButton'] })}
            style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
            <option value="left">Ctrl + 双击左键（推荐）</option>
            <option value="right">Ctrl + 双击右键</option>
          </select>
        </label>
        <label style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
          双击间隔（ms）
          <input type="number" min={180} max={1000} value={value.doubleClickMs}
            onChange={(e) => updateNumber('doubleClickMs', e.target.value)}
            style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginTop: 4 }} />
        </label>
      </div>
      <div style={{ marginTop: 9, display: 'flex', gap: 8 }}>
        {(['full', 'region'] as const).map((mode) => (
          <button key={mode} disabled={mode === 'region' && selectorOpening}
            onClick={() => mode === 'region' ? void openRegionSelector() : update({ captureMode: mode })} style={{
            ...actionBtnStyle,
            borderColor: value.captureMode === mode ? '#22d3ee' : 'var(--theme-border)',
            background: value.captureMode === mode ? 'rgba(34,211,238,.12)' : 'rgba(255,255,255,.05)',
            opacity: mode === 'region' && selectorOpening ? .65 : 1,
          }}>{mode === 'full' ? '全屏' : selectorOpening ? '正在打开选区…' : value.captureMode === 'region' ? '▣ 调整预设区域' : '预设区域'}</button>
        ))}
      </div>
      {selectorError && (
        <div style={{ marginTop: 7, color: '#fca5a5', fontSize: 11, lineHeight: 1.45 }}>
          {selectorError}
        </div>
      )}
      {value.captureMode === 'region' && (
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {(['x', 'y', 'width', 'height'] as const).map((key) => (
            <label key={key} style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>
              {key.toUpperCase()}
              <input type="number" value={value[key]} onChange={(e) => updateNumber(key, e.target.value)}
                style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginTop: 3 }} />
            </label>
          ))}
        </div>
      )}
      <label style={{ display: 'block', marginTop: 9, fontSize: 11, color: 'var(--theme-text-muted)' }}>
        自动发送的提问词
        <textarea value={value.prompt} onChange={(e) => update({ prompt: e.target.value })}
          rows={2} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', marginTop: 4 }} />
      </label>
      <div style={{ marginTop: 7, fontSize: 11, lineHeight: 1.5, color: 'var(--theme-text-muted)' }}>
        截图：Ctrl + 双击左/右键。幽灵窗口：Smooth 开启后按左 Shift + 双击左键，在预设区域中央显示/隐藏当前问答；面板不会铺满选区，且置顶、鼠标穿透、不抢焦点。全屏游戏、视频或演示期间，两种手势都会自动暂停且不会吞掉鼠标点击。点击“预设区域”可用浮框拖动、缩放；模型忙碌时截图任务会静默排队。
      </div>
    </div>
  );
};

// 截图全局快捷键的配置 UI:
//   - 显示当前 accelerator(人类友好形态);
//   - 点「Change」进入捕获模式,任意键盘组合 → 立即写入;Esc 取消;
//   - 「Disable」清空 → 禁用快捷键;
//   - 「使用 Ctrl+Shift+A」显式启用推荐组合；新安装默认不注册全局热键。
const ScreenshotHotkeySetting: React.FC = () => {
  const [hotkey, setHotkey] = useState(() => readScreenshotHotkey());
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 监听 App 端注册失败 → 把错误信息回显到这里。
  useEffect(() => {
    const onErr = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key?: string; message?: string } | undefined;
      if (detail?.key === 'screenshot') setError(detail.message || 'failed');
    };
    window.addEventListener('awu:hotkey-error', onErr);
    return () => window.removeEventListener('awu:hotkey-error', onErr);
  }, []);

  // 捕获键盘组合。useCapture 拿到 keydown,阻止冒泡到 textarea / 全局
  // 处理器,免得 Esc 触发 close / 字母进输入框之类。
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(false); return; }
      if (isModifierOnly(e)) return; // 等用户继续按
      const accel = buildAccelerator(e);
      if (!accel) return; // 不是合法组合(单键无修饰),继续等
      writeScreenshotHotkey(accel);
      setHotkey(accel);
      setError(null);
      setCapturing(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [capturing]);

  const onDisable = () => {
    writeScreenshotHotkey('');
    setHotkey('');
    setError(null);
  };
  const onRecommended = () => {
    writeScreenshotHotkey(SCREENSHOT_HOTKEY_RECOMMENDED);
    setHotkey(SCREENSHOT_HOTKEY_RECOMMENDED);
    setError(null);
  };

  const keyCapStyle: React.CSSProperties = {
    minWidth: 140, padding: '6px 12px', borderRadius: 6,
    border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
    background: capturing ? 'rgba(99,102,241,0.25)' : 'var(--theme-input-bg, #fff)',
    color: 'var(--theme-text, #1f2328)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13, fontWeight: 600,
    cursor: 'pointer', textAlign: 'center',
    transition: 'all 0.15s',
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          style={keyCapStyle}
          onClick={() => setCapturing((v) => !v)}
          title={capturing ? 'Press the key combination to set, or Esc to cancel' : 'Click then press your key combination'}
        >
          {capturing ? 'Press keys…' : displayAccelerator(hotkey)}
        </button>
        <button onClick={onDisable} style={actionBtnStyle} disabled={!hotkey}>Disable</button>
        <button onClick={onRecommended} style={actionBtnStyle}>使用 Ctrl+Shift+A</button>
      </div>
      {error && (
        <div style={{
          marginTop: 6, fontSize: 11,
          color: 'rgba(239,68,68,0.95)',
        }}>
          Could not register this combo (likely taken by another app or the OS). Pick another.
        </div>
      )}
    </div>
  );
};
