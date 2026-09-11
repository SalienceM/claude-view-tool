/**
 * api.ts: Bridge between React and the Python backend over WebSocket.
 *
 * Protocol:
 *   Client → Server: {"id": "r1", "method": "listSessions", "params": [...]}
 *   Server → Client: {"id": "r1", "result": "..."}           // response
 *   Server → Client: {"event": "streamDelta",    "data": "..."} // push
 *   Server → Client: {"event": "sessionUpdated", "data": "..."} // push
 */

import type { GitDetectResult, GitStatusResult, GitDiffResult, GitCommitResult, GitLogResult, GitBranchesResult, GitPushPullResult, GitStashListResult } from './types/git';
import type {
  WorkspaceKitState, WorkspaceKit, KitRun, KitGenerationRequest, KitGenerationResult,
  KitGenerationJob, KitVersion, KitOptimizationMessage, KitCapabilityMetadata,
} from './types/workspaceKits';
import type {
  ProvDocument, ProvOpenResult, ProvResolveResult, ProvSaveResult,
} from './types/prov';
import { filterGitMetadata } from './utils/dirSyncPolicy';
import { SessionRoutingCache } from './utils/sessionRouting';
import { rankFileSearchPaths } from './utils/fileSearch';
import { mergeExecutorSessionBatches, selectExactExecutor } from './utils/executorSessions';

type StreamDeltaCallback = (delta: any) => void;
type SessionUpdateCallback = (data: any) => void;
type PermissionRequestCallback = (data: any) => void;
type AssetChangedCallback = (stats: any) => void;

export interface FollowUpCapabilities {
  status: string;
  queue: boolean;
  nativeSteer: boolean;
  interruptResume: boolean;
  steerAttachments: boolean;
  message?: string;
}

export interface FollowUpResult {
  status: string;
  message?: string | Record<string, any>;
  beforeMessageId?: string;
  redirecting?: boolean;
  task?: any;
}

/** 已连接到本执行节点的一个 UI 客户端的展示信息。 */
export interface ConnectedClient {
  identity: string;       // Remote-User / token:xxx / "local" / "relay"
  username?: string;
  display_name?: string;
  identity_src: string;   // "loopback" | "forward-auth" | "token" | "relay" | "none"
  peer: string;           // "ip:port"，可能为空字符串
  via: 'local' | 'relay'; // 直连本机 sidecar，还是经中继来
  since: string;          // ISO timestamp（UTC）
}

export interface BackendImportPreviewItem {
  id: string;
  label: string;
  type: string;
  enabled: boolean;
  conflict: boolean;
  protected: boolean;
  existingLabel?: string;
}

export interface BackendImportResult {
  status: string;
  message?: string;
  selected?: number;
  imported?: number;
  added?: number;
  overwritten?: number;
  skipped?: number;
  protected?: number;
  changedIds?: string[];
}

export interface PoeModelInfo {
  id: string;
  createdAt: number;
  description: string;
  ownedBy?: string;
}

export interface PoeAccountOverview {
  status: 'ok' | 'error' | string;
  models: PoeModelInfo[];
  modelCount: number;
  catalogError?: string;
  currentPointBalance: number | null;
  balanceError?: string;
  fetchedAt: number;
  message?: string;
}

/** 当前 Web/桌面 Backend 作为 Relay 执行节点的注册状态。 */
export interface RelayNodeStatus {
  supported: boolean;
  enabled: boolean;
  agentExecutionEnabled: boolean;
  connected: boolean;
  url: string;
  hasToken: boolean;
  deviceId: string;
  deviceName: string;
  source: 'default' | 'saved' | 'environment' | 'unavailable' | string;
  lastError: string;
}
type ClientsChangedCallback = (clients: ConnectedClient[], execKey: string) => void;

export interface NodeUpdateRelease {
  version: string;
  packageVersion?: string;
  buildId?: string;
  sequence?: number;
  publishedAt?: string;
  notes?: string;
}

export interface NodeUpdateArtifact {
  id: string;
  platform: string;
  arch: string;
  target: string;
  kind: string;
  fileName: string;
  url: string;
  size: number;
  hasInstaller: boolean;
}

export interface NodeUpdateStatus {
  phase: 'idle' | 'checking' | 'current' | 'stale' | 'available' | 'downloading' | 'staged'
    | 'installing' | 'installed' | 'cancelled' | 'error';
  busy: boolean;
  available?: boolean;
  message?: string;
  error?: string;
  platform: string;
  arch: string;
  desktop: boolean;
  runtime?: 'desktop' | 'headless' | 'native' | 'docker' | string;
  dockerUpdaterAvailable?: boolean;
  current: NodeUpdateRelease;
  release?: NodeUpdateRelease;
  artifact?: NodeUpdateArtifact;
  downloadedBytes?: number;
  totalBytes?: number;
  manifestSigned?: boolean;
  manifestRelation?: 'newer' | 'same' | 'older';
  config: {
    manifestUrl: string;
    channel: string;
    requireSignature: boolean;
    hasSignatureKey: boolean;
    hasRequestHeaders: boolean;
  };
}

export interface ReleaseArtifact {
  id: string;
  path: string;
  relativePath: string;
  fileName: string;
  platform: string;
  arch: string;
  target: string;
  kind: string;
  size: number;
  sha256: string;
  modifiedAt: number;
  fresh: boolean;
  key?: string;
  install?: Record<string, any>;
}

export interface ReleaseCandidate {
  id: string;
  status: 'candidate' | 'published' | 'discarded';
  version: string;
  packageVersion: string;
  buildId: string;
  sequence: number;
  commit: string;
  branch: string;
  dirty: boolean;
  dirtyFiles: number;
  projectRoot: string;
  source: string;
  artifacts: ReleaseArtifact[];
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
  publishedChannel?: string;
}

export interface ReleaseCenterConfig {
  projectRoot: string;
  scanRoots: string[];
  channel: string;
  baseUrl: string;
  qiniuBucket: string;
  prefix: string;
  manifestKey: string;
  stableManifestUrl: string;
  qshell: string;
  requireSignature: boolean;
  /** 0 = 不自动清理；大于 0 时按存储范围保留最近 N 个已发布版本。 */
  retentionCount: number;
  qshellAvailable: boolean;
  qiniuAccountConfigured: boolean;
  qiniuAccountMessage: string;
  signingKeyConfigured: boolean;
  dataRoot: string;
}

export interface ReleaseJob {
  id: string;
  planId: string;
  candidateId: string;
  buildId: string;
  channel: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  progress: number;
  uploadedBytes?: number;
  totalBytes?: number;
  currentFileBytes?: number;
  currentFileSize?: number;
  currentFileName?: string;
  step: number;
  totalSteps: number;
  message: string;
  error?: string;
  log: string[];
  manifestUrl?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  cleanup?: { removedReleases: number; deletedObjects: number; failedObjects: number };
}

export interface ReleaseHistoryItem {
  id: string;
  jobId: string;
  planId: string;
  candidateId: string;
  buildId: string;
  version: string;
  channel: string;
  manifestUrl: string;
  artifactCount: number;
  publishedAt: number;
  qiniuBucket?: string;
  manifestKey?: string;
  objectKeys?: string[];
  cleanupError?: string;
  cleanupAttemptedAt?: number;
}

export interface ReleaseCenterState {
  status: string;
  config: ReleaseCenterConfig;
  candidates: ReleaseCandidate[];
  history: ReleaseHistoryItem[];
  jobs: ReleaseJob[];
  activeJob?: ReleaseJob | null;
  message?: string;
}

export interface ReleasePlan {
  id: string;
  status: 'ready' | 'blocked';
  candidateId: string;
  candidate: Partial<ReleaseCandidate>;
  channel: string;
  baseUrl: string;
  qiniuBucket: string;
  manifestKey: string;
  versionedManifestKey: string;
  manifestUrl: string;
  uploadJobs: Array<{ key: string; path: string; sha256: string; size: number }>;
  manifest: Record<string, any>;
  blockers: string[];
  warnings: string[];
  comparison: {
    available: boolean;
    release: NodeUpdateRelease & { commit?: string; sequence?: number };
    versionChanged: boolean;
    commitChanged: boolean;
    artifacts: Array<{
      artifactId: string; previousId: string; previousSize: number;
      sizeDelta: number | null; hashChanged: boolean; isNew: boolean;
    }>;
  };
  signatureConfigured: boolean;
  retentionCount: number;
  requireSignature: boolean;
  fingerprint: string;
  createdAt: number;
}

export interface SkillInfo {
  name: string;
  content: string;               // SKILL.md 完整内容
  isGlobal: boolean;             // 是否已激活到各 Agent 的全局 Skill 目录
  isProject: boolean;            // 是否已在当前工作目录激活
  projectActivations: string[];  // 所有已激活的工作目录列表
  description?: string;          // frontmatter description 字段
  isDefault?: boolean;           // ★ 默认档：新建 session 时自动绑定
  hasCallPy?: boolean;           // 是否有 call.py（python-script 类型）
  hasSecrets?: boolean;          // 是否已保存凭据
  hasSecretsSchema?: boolean;    // 是否有 secrets.schema.json
  manifest?: Record<string, any> | null;  // manifest.json 内容（插件包）
  format?: 'legacy' | 'awu' | 'agent-skills' | string;
  source?: Record<string, any> | null;
  backend?: string;
  type?: string;
  inputSchema?: Record<string, any>;
}

const configuredWsPort = Number(import.meta.env.VITE_AGENT_WITH_U_WS_PORT);
const WS_PORT_DEFAULT = Number.isInteger(configuredWsPort) && configuredWsPort > 0
  ? configuredWsPort
  : 44321;
const WS_CONNECT_TIMEOUT_MS = 3000;
const LIST_SESSIONS_TIMEOUT_MS = 3000;
const SYNC_MANIFEST_TIMEOUT_MS = 180_000;
const FILE_SEARCH_TIMEOUT_MS = 60_000;

let useMock = false;

type ConnectionStatusCallback = (connected: boolean) => void;
let connectionStatusCallbacks: ConnectionStatusCallback[] = [];

let reqCounter = 0;
const pending = new Map<string, { resolve: (result: any) => void; reject: (err: Error) => void }>();
let streamCallbacks: StreamDeltaCallback[] = [];
let sessionUpdateCallbacks: SessionUpdateCallback[] = [];
let permissionRequestCallbacks: PermissionRequestCallback[] = [];
let assetChangedCallbacks: AssetChangedCallback[] = [];
let clientsChangedCallbacks: ClientsChangedCallback[] = [];
let pendingDesktopUpdatePlan = '';

type SttStreamTextCallback = (data: { text: string; isFinal: boolean }) => void;
let sttStreamCallbacks: SttStreamTextCallback[] = [];

export interface TtsStreamAudioEvent {
  streamId: string;
  seq: number;
  audioSeq?: number;
  kind?: 'audio' | 'finished' | 'error';
  engine?: 'edge' | 'dashscope';
  ok: boolean;
  mime?: string;
  encoding?: 'pcm_s16le';
  sampleRate?: number;
  channels?: number;
  base64?: string;
  voice?: string;
  model?: string;
  rate?: number;
  elapsedMs?: number;
  error?: string;
}
type TtsStreamAudioCallback = (data: TtsStreamAudioEvent) => void;
let ttsStreamAudioCallbacks: TtsStreamAudioCallback[] = [];

// ── 可视化 Loop 集成 ──────────────────────────────────────────
type LoopUpdatedCallback = (state: any) => void;
let loopUpdatedCallbacks: LoopUpdatedCallback[] = [];
type LoopProgressCallback = (data: { sessionId: string; seq: number; subStage: string; text: string }) => void;
let loopProgressCallbacks: LoopProgressCallback[] = [];
type LoopAsideDeltaCallback = (data: { sessionId: string; turnId: string; text: string }) => void;
let loopAsideDeltaCallbacks: LoopAsideDeltaCallback[] = [];

// ── 普通 session 侧挂：序列任务 + by-the-way ──────────────────
type SeqtaskUpdatedCallback = (data: { sessionId: string; seqTasks: any[]; seqAuto: boolean }) => void;
let seqtaskUpdatedCallbacks: SeqtaskUpdatedCallback[] = [];
type ChatAsideDeltaCallback = (data: { sessionId: string; turnId: string; text: string }) => void;
let chatAsideDeltaCallbacks: ChatAsideDeltaCallback[] = [];
type ChatAsideUpdatedCallback = (data: { sessionId: string; asides: any[]; asideBackendId?: string }) => void;
let chatAsideUpdatedCallbacks: ChatAsideUpdatedCallback[] = [];
type KitUpdatedCallback = (data: WorkspaceKitState) => void;
let kitUpdatedCallbacks: KitUpdatedCallback[] = [];
type KitGenerationUpdatedCallback = (data: KitGenerationJob) => void;
let kitGenerationUpdatedCallbacks: KitGenerationUpdatedCallback[] = [];

type SttStreamEndCallback = (data: { reason: string }) => void;
let sttStreamEndCallbacks: SttStreamEndCallback[] = [];
// 当前浏览器麦克风绑定的执行节点。普通语音输入默认走 home；传入 Session
// 后则跟随 Session，避免远程 Session 的音频误送到另一个 backend 进程。
let sttStreamExecKey: string | undefined;

// ── Git commit message 流式事件 ───────────────────────────────────
type GitCommitMsgDeltaCallback = (data: { workingDir: string; text: string }) => void;
type GitCommitMsgReadyCallback = (data: { workingDir: string; message: string; error?: string }) => void;
let gitCommitMsgDeltaCallbacks: GitCommitMsgDeltaCallback[] = [];
let gitCommitMsgReadyCallbacks: GitCommitMsgReadyCallback[] = [];

// ── 自动 AI commit 结果事件 ─────────────────────────────────────
type AutoCommitResultCallback = (data: {
  sessionId: string; trigger: string; status: string;
  message?: string; committed?: boolean; pushed?: boolean;
  files?: number; error?: string;
}) => void;
let autoCommitResultCallbacks: AutoCommitResultCallback[] = [];

function nextId() {
  return `r${++reqCounter}`;
}

export function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';
}

// ── 动态导入 Tauri API（浏览器环境下 graceful fallback）──────

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

async function tauriOpenDialog(opts: {
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open(opts as any);
  return typeof result === 'string' ? result : null;
}

async function tauriSaveDialog(opts: {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const result = await save(opts as any);
  return result ?? null;
}

// ── WebSocket 初始化 + 自动重连 ───────────────────────────────

async function getWsPort(): Promise<number> {
  if (isTauri()) {
    const port = await tauriInvoke<number>('get_ws_port');
    if (port) return port;
  }
  return WS_PORT_DEFAULT;
}

// ── 连接目标（C–C/S）：本地直连，或经中继 S 访问远程执行节点 ──────────
export interface RelayUserProfile {
  userId: string;
  username: string;
  displayName: string;
  avatarData: string;
  avatarColor: string;
  /** false = 兼容旧版单 token Relay，档案不可编辑。 */
  managed: boolean;
}

export interface SkillMarketSource {
  id: string;
  name: string;
  repository: string;
  ref: string;
  root: string;
  homepage: string;
  description?: string;
  official?: boolean;
  removable?: boolean;
  skillCount?: number;
  skippedCount?: number;
  issues?: Array<{ path: string; message: string }>;
  effectiveRef?: string;
  error?: string;
}

export interface SkillMarketItem {
  id: string;
  name: string;
  description: string;
  path: string;
  digest: string;
  sourceId: string;
  sourceName: string;
  repository: string;
  ref: string;
  homepage: string;
  official: boolean;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, any>;
  fileNames: string[];
  fileCount: number;
  size: number;
  risk: { level: 'low' | 'medium' | 'high'; flags: string[] };
  warnings: string[];
  preview: string;
  previewTruncated?: boolean;
  installed: boolean;
  sameSource: boolean;
  localModified: boolean;
  updateAvailable: boolean;
  conflict: boolean;
}

export interface SkillMarketCatalog {
  status: 'ok' | 'error';
  message?: string;
  sources: SkillMarketSource[];
  directories: Array<{ name: string; url: string; description: string }>;
  items: SkillMarketItem[];
  refreshedAt?: number;
}

let localIdentityTokenPromise: Promise<string> | null = null;
let localDeviceIdPromise: Promise<string> | null = null;
let localPhysicalDeviceId = '';

async function getLocalDeviceId(): Promise<string> {
  if (!isTauri()) return '';
  if (!localDeviceIdPromise) {
    localDeviceIdPromise = tauriInvoke<string>('get_local_device_id')
      .then((deviceId) => String(deviceId || '').trim())
      .catch(() => '');
  }
  return localDeviceIdPromise;
}

async function getLocalIdentityToken(): Promise<string> {
  if (!isTauri()) return '';
  if (!localIdentityTokenPromise) {
    localIdentityTokenPromise = tauriInvoke<string>('get_local_identity_token')
      .then((token) => String(token || '').trim())
      .catch(() => '');
  }
  return localIdentityTokenPromise;
}

export type ConnectionTarget =
  | { mode: 'local'; user?: RelayUserProfile }
  | {
      mode: 'relay';
      url: string;
      token: string;
      deviceId: string;
      deviceName?: string;
      user?: RelayUserProfile;
    };

const CONN_TARGET_KEY = 'awu.connectionTarget';

function loadConnectionTarget(): ConnectionTarget {
  try {
    const raw = localStorage.getItem(CONN_TARGET_KEY);
    if (raw) {
      const t = JSON.parse(raw);
      if (t && t.mode === 'relay' && t.url && t.deviceId) return t as ConnectionTarget;
    }
  } catch { /* ignore */ }
  return { mode: 'local' };
}

let connectionTarget: ConnectionTarget = loadConnectionTarget();

export function getConnectionTarget(): ConnectionTarget {
  return connectionTarget;
}

export type CurrentUserProfile = RelayUserProfile & { mode: 'local' | 'relay' };
type CurrentUserCallback = (profile: CurrentUserProfile, identityChanged: boolean) => void;
let currentUserCallbacks: CurrentUserCallback[] = [];

export function getCurrentUserProfile(): CurrentUserProfile {
  if (connectionTarget.mode === 'relay') {
    return {
      ...normalizeRelayProfile(connectionTarget.user),
      mode: 'relay',
    };
  }
  return {
    mode: 'local',
    userId: 'local',
    username: 'local',
    displayName: '本机用户',
    avatarData: '',
    avatarColor: '#64748b',
    managed: false,
  };
}

export function onCurrentUserChanged(callback: CurrentUserCallback): () => void {
  currentUserCallbacks.push(callback);
  return () => {
    currentUserCallbacks = currentUserCallbacks.filter((item) => item !== callback);
  };
}

function notifyCurrentUserChanged(identityChanged: boolean): void {
  const profile = getCurrentUserProfile();
  currentUserCallbacks.forEach((callback) => callback(profile, identityChanged));
}

// ── 执行节点（session 级模式管理）─────────────────────────────────────
// 一个执行节点就是一个连接目标(ExecTarget == ConnectionTarget)。home 节点由
// connectionTarget 决定(本机 / 某中继);额外节点存在 execRoster 里。每个 session
// 归属一个节点,新建时选定、之后固定。
export type ExecTarget = ConnectionTarget;

/** 供 UI 展示的执行节点摘要。 */
export interface ExecutorInfo {
  key: string;          // 稳定键:'local' | `relay:<userId>:<deviceId>`
  label: string;        // 人类可读名
  mode: 'local' | 'relay';
  isHome: boolean;      // 是否为当前 home(新建会话的默认落点)
  connected: boolean;   // 连接是否在线
  /** Relay 主用户可管理节点级状态（发布、更新、Backend 配置）；undefined=旧节点未知。 */
  canManageNode?: boolean;
}

interface RelayInspection {
  devices: { id: string; name: string; isDefaultOwner?: boolean }[];
  profile: RelayUserProfile;
}

function normalizeRelayProfile(value: any): RelayUserProfile {
  return {
    userId: String(value?.userId || 'legacy'),
    username: String(value?.username || 'relay'),
    displayName: String(value?.displayName || value?.username || 'Relay user'),
    avatarData: String(value?.avatarData || ''),
    avatarColor: /^#[0-9a-f]{6}$/i.test(String(value?.avatarColor || ''))
      ? String(value.avatarColor).toLowerCase()
      : '#64748b',
    managed: !!value && value.managed !== false,
  };
}

function relayControlRequest<T>(
  url: string,
  request: Record<string, unknown>,
  accept: (message: any) => T | undefined,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    let sock: WebSocket;
    const finish = (fn: () => void) => { if (!done) { done = true; fn(); } };
    try {
      sock = new WebSocket(url);
    } catch (e) {
      reject(e instanceof Error ? e : new Error('bad relay url'));
      return;
    }
    const timer = setTimeout(
      () => finish(() => { try { sock.close(); } catch { /* */ } reject(new Error('连接中继超时')); }),
      8000,
    );
    sock.onopen = () => { try { sock.send(JSON.stringify(request)); } catch { /* */ } };
    sock.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string);
        if (message.t === 'error') {
          finish(() => {
            clearTimeout(timer);
            try { sock.close(); } catch { /* */ }
            reject(new Error(message.message || '中继拒绝'));
          });
          return;
        }
        const result = accept(message);
        if (result !== undefined) {
          finish(() => {
            clearTimeout(timer);
            try { sock.close(); } catch { /* */ }
            resolve(result);
          });
        }
      } catch { /* ignore */ }
    };
    sock.onerror = () => finish(() => { clearTimeout(timer); reject(new Error('无法连接中继')); });
    sock.onclose = () => finish(() => { clearTimeout(timer); reject(new Error('中继连接已关闭')); });
  });
}

/** 验证用户 token，并只拉取该用户获授权的在线执行节点。 */
export function inspectRelay(
  url: string, token: string,
): Promise<RelayInspection> {
  return relayControlRequest(url, { t: 'list', token }, (message) => {
    if (message.t !== 'devices') return undefined;
    return {
      devices: Array.isArray(message.devices) ? message.devices : [],
      profile: normalizeRelayProfile(message.profile),
    };
  });
}

/** 向后兼容的设备列表帮助函数。 */
export async function listRelayDevices(
  url: string, token: string,
): Promise<{ id: string; name: string; isDefaultOwner?: boolean }[]> {
  return (await inspectRelay(url, token)).devices;
}

export function getRelayUserProfile(url: string, token: string): Promise<RelayUserProfile> {
  return relayControlRequest(url, { t: 'profile', token }, (message) => (
    message.t === 'profile' ? normalizeRelayProfile(message.profile) : undefined
  ));
}

export function updateRelayUserProfile(
  url: string,
  token: string,
  patch: Pick<RelayUserProfile, 'username' | 'displayName' | 'avatarData' | 'avatarColor'>,
): Promise<RelayUserProfile> {
  return relayControlRequest(url, { t: 'profile.update', token, profile: patch }, (message) => (
    message.t === 'profile.updated' ? normalizeRelayProfile(message.profile) : undefined
  ));
}

/**
 * 解析 WebSocket 连接地址，区分三种部署形态：
 *   - Tauri 桌面：连本机 sidecar，ws://127.0.0.1:<port>
 *   - Vite dev：前端 dev server 与后端分离，连 ws://127.0.0.1:44321
 *   - 生产 Web（反代后）：连 wss?://<当前host>/ws，由反代转发到后端
 */
async function getLocalWsUrl(user?: RelayUserProfile): Promise<string> {
  let value: string;
  if (isTauri()) {
    const port = await getWsPort();
    value = `ws://127.0.0.1:${port}`;
  } else if (import.meta.env.DEV) {
    value = `ws://127.0.0.1:${WS_PORT_DEFAULT}`;
  } else {
    const portableUrl = (window as typeof window & {
      __AGENT_WITH_U_WS_URL__?: string;
    }).__AGENT_WITH_U_WS_URL__;
    if (portableUrl) value = portableUrl;
    else {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      value = `${proto}://${location.host}/ws`;
    }
  }

  // 完整桌面端即使当前登录了 Relay 用户，也保留一条本机执行连接。
  // 这里只把 Relay 已验证过的稳定 userId 映射成本机 Session 命名空间；
  // 不携带用户 Token，也不赋予“认领旧 Session”等 Relay 管理权限。
  if (isTauri() && user?.managed && user.userId && user.userId !== 'legacy') {
    const identityToken = await getLocalIdentityToken();
    // 老桌面壳或本机密钥读取失败时，宁可回落到 legacy local 命名空间，
    // 也不能发送一个未经 sidecar 认证的用户声明。
    if (!identityToken) return value;
    const url = new URL(value);
    url.searchParams.set('localUserId', user.userId);
    url.searchParams.set('localIdentityToken', identityToken);
    if (user.username) url.searchParams.set('localUsername', user.username);
    if (user.displayName) url.searchParams.set('localDisplayName', user.displayName);
    return url.toString();
  }
  return value;
}

/**
 * 解析 HTTP API（素材服务 / Skill 回调）的基地址。
 * Tauri / dev 直连本机端口；生产 Web 用相对路径，由反代转发。
 */
export function httpApiBase(httpPort: number): string {
  if (isTauri() || import.meta.env.DEV) {
    return `http://127.0.0.1:${httpPort}`;
  }
  return ''; // 相对当前 origin，反代把 /api/ 转发到后端
}

const INITIAL_RECONNECT_DELAY = 300; // 启动/断线后首次重试更快，后端一就绪就尽快连上（少白屏）
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_INTERVAL_MS = 25000; // 每 25 秒发送一次心跳 ping

// id → 该请求挂在哪条连接上(连接断开时只 reject 属于它的挂起请求,不误伤别的节点)
const pendingConn = new Map<string, string>();
// 每个执行节点最后一次成功取得的列表。节点短暂断线/假在线时继续展示，
// 避免整个 session 分组忽隐忽现。
const sessionListCache = new Map<string, any[]>();
const sessionRoutingCache = new SessionRoutingCache();
let listSessionsInFlight: Promise<any[]> | null = null;
let relayIdentityEpoch = 0;
const SESSION_LIST_CACHE_KEY = 'awu.sessionListCache.v1';

function loadSessionListCache(): void {
  try {
    const raw = localStorage.getItem(SESSION_LIST_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return;
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) sessionListCache.set(key, value);
    }
  } catch { /* 离线缓存损坏时忽略，在线后会自动重建。 */ }
}

function persistSessionListCache(): void {
  try {
    localStorage.setItem(SESSION_LIST_CACHE_KEY, JSON.stringify(Object.fromEntries(sessionListCache)));
  } catch { /* 配额不足不影响在线功能。 */ }
}

function handleMessage(e: MessageEvent, source?: Conn) {
  if (typeof e.data !== 'string') return;
  try {
    const msg = JSON.parse(e.data);
    // 同一 sidecar 同时经 local 与 Relay 接入时，RPC 响应仍由各自连接处理，
    // 但 Relay 别名上的广播事件必须丢弃，否则 stream/session 更新会触发两遍。
    if (msg.event && source && isLocalRelayDuplicate(source)
        && pool.get('local')?.isOpen) {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      pendingConn.delete(msg.id);
      if (msg.error !== undefined) {
        reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
      } else {
        resolve(msg.result ?? null);
      }
    } else if (msg.event === 'streamDelta') {
      const delta = JSON.parse(msg.data);
      streamCallbacks.forEach((cb) => cb(delta));
    } else if (msg.event === 'sessionUpdated') {
      const parsed = JSON.parse(msg.data);
      const execMeta = source ? {
        execKey: source.key,
        execLabel: source.label,
        execMode: source.target.mode,
        execIsHome: isEffectiveHome(source),
      } : {};
      const data = {
        ...parsed,
        ...execMeta,
        summary: parsed?.summary ? { ...parsed.summary, ...execMeta } : parsed?.summary,
      };
      const sessionId = data?.sessionId || data?.summary?.id;
      if (sessionId && data.type === 'session_deleted') sessionRoutingCache.delete(sessionId);
      else if (sessionId && data.summary) sessionRoutingCache.update(sessionId, data.summary);
      if (source && sessionId) {
        if (data.type === 'session_deleted') {
          sessionExec.delete(sessionId);
          persistSessionExec();
        } else if (sessionExec.get(sessionId) !== source.key) {
          sessionExec.set(sessionId, source.key);
          persistSessionExec();
        }
        const cached = sessionListCache.get(source.key) || [];
        if (data.type === 'session_deleted') {
          sessionListCache.set(source.key, cached.filter((item) => item?.id !== sessionId));
        } else if (data.summary?.id) {
          const index = cached.findIndex((item) => item?.id === data.summary.id);
          const next = [...cached];
          if (index >= 0) next[index] = { ...next[index], ...data.summary };
          else next.push(data.summary);
          sessionListCache.set(source.key, next);
        } else if (data.type === 'session_renamed') {
          sessionListCache.set(source.key, cached.map((item) => (
            item?.id === sessionId ? { ...item, title: data.title || item.title } : item
          )));
        }
        persistSessionListCache();
      }
      sessionUpdateCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'permissionRequest') {
      const data = JSON.parse(msg.data);
      permissionRequestCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'assetChanged') {
      const data = msg.data ? JSON.parse(msg.data) : {};
      assetChangedCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'clientsChanged') {
      const data: ConnectedClient[] = msg.data ? JSON.parse(msg.data) : [];
      clientsChangedCallbacks.forEach((cb) => cb(data, source?.key || 'local'));
    } else if (msg.event === 'nodeUpdateInstallRequested') {
      const data = msg.data ? JSON.parse(msg.data) : {};
      const planPath = String(data?.planPath || '');
      // 只有目标节点自己的 canonical local 连接能退出本机 Tauri。远端控制
      // 连接即便发来同名事件也绝不能让操作者的客户端退出。
      if (isTauri() && source?.key === 'local' && planPath && pendingDesktopUpdatePlan !== planPath) {
        pendingDesktopUpdatePlan = planPath;
        const delay = Math.max(300, Math.min(Number(data?.delayMs || 1500), 10_000));
        window.setTimeout(() => {
          void import('@tauri-apps/api/core').then(({ invoke }) => (
            invoke('install_staged_update', { planPath })
          )).catch((error) => {
            pendingDesktopUpdatePlan = '';
            const message = error instanceof Error ? error.message : String(error || 'desktop updater failed');
            void callOn('local', 'nodeUpdateInstallFailed', message);
          });
        }, delay);
      }
    } else if (msg.event === 'loopUpdated') {
      const data = JSON.parse(msg.data);
      if (data.sessionId && (data.controlMode === 'manual' || data.controlMode === 'loop')) {
        sessionRoutingCache.update(data.sessionId, {
          sessionType: 'loop', loopControlMode: data.controlMode, loopRunning: data.running === true,
        });
      }
      loopUpdatedCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'loopProgress') {
      const data = JSON.parse(msg.data);
      loopProgressCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'loopAsideDelta') {
      const data = JSON.parse(msg.data);
      loopAsideDeltaCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'seqtaskUpdated') {
      const data = JSON.parse(msg.data);
      seqtaskUpdatedCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'chatAsideDelta') {
      const data = JSON.parse(msg.data);
      chatAsideDeltaCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'chatAsideUpdated') {
      const data = JSON.parse(msg.data);
      chatAsideUpdatedCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'kitUpdated') {
      const data = JSON.parse(msg.data);
      kitUpdatedCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'kitGenerationUpdated') {
      const data = JSON.parse(msg.data) as KitGenerationJob;
      kitGenerationUpdatedCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'sttStreamText') {
      const data = JSON.parse(msg.data);
      sttStreamCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'sttStreamEnd') {
      const data = JSON.parse(msg.data);
      sttStreamExecKey = undefined;
      sttStreamEndCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'ttsStreamAudio') {
      const data: TtsStreamAudioEvent = JSON.parse(msg.data);
      ttsStreamAudioCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'gitCommitMsgDelta') {
      const data = JSON.parse(msg.data);
      gitCommitMsgDeltaCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'gitCommitMsgReady') {
      const data = JSON.parse(msg.data);
      gitCommitMsgReadyCallbacks.forEach((cb) => cb(data));
    } else if (msg.event === 'autoCommitResult') {
      const data = JSON.parse(msg.data);
      autoCommitResultCallbacks.forEach((cb) => cb(data));
    }
  } catch (err) {
    console.error('[api] message parse error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  连接池（session 级执行节点）
//
//  原本「本 UI 连接到哪台执行节点」是系统级的单一连接——整窗口所有 session 都
//  跑在同一台节点上。现在改成 session 级：
//    · home 节点 = connectionTarget（本机 / 某中继节点）：新建会话的默认落点,
//      也是 App 启动时判定「后端是否就绪」的那条连接(行为保持不变)。
//    · 额外节点 = execRoster（用户额外加入的中继节点）,与 home 同时在线。
//  每条连接 = 一个 Conn;session→节点的执行位置记在 sessionExec 里,按 sessionId
//  路由。执行位置与可视用户是两层边界：Backend 仍会按 Session.ownerId 鉴权。
//  桌面窗口可同时连接“映射到当前用户的 local”和该 Relay 用户获授权的若干节点；
//  标准生产 Web 则把同源 /ws Backend 作为“当前 Web 节点”。不同 Relay 用户的
//  连接绝不进入同一个池。
// ═══════════════════════════════════════════════════════════════════

// 桌面/dev 的本地执行能力由部署形态保证；生产 Web 要等同源 /ws 至少成功握手
// 一次才确认。这样 Docker Web 会自动出现当前节点，同时仍兼容纯 Relay 静态页，
// 不会给后者长期展示一个并不存在的“本地节点”。
let localExecutorConfirmed = isTauri() || import.meta.env.DEV;

// 同源 WebSocket 同时承担控制面 RPC，不能为了“不在本机跑 Agent”而断开。
// 因此把物理连接与新 Session 的可分配资格分开：关闭后仍可管理当前 Backend，
// 但新建会话的执行节点选择器不会再列出 local。localStorage 只是首屏缓存，
// Web Backend 的 relay-node.json 才是多用户共享的权威策略。
const LOCAL_AGENT_EXECUTION_KEY = 'awu.localAgentExecutionEnabled.v1';
let localAgentExecutionEnabled = (() => {
  // 服务端状态尚未返回时先使用上次缓存，随后由同源握手结果校正。
  if (connectionTarget.mode === 'local') return true;
  try { return localStorage.getItem(LOCAL_AGENT_EXECUTION_KEY) !== '0'; }
  catch { return true; }
})();

function execTargetKey(t: ExecTarget): string {
  if (t.mode === 'local') return 'local';
  return `relay:${t.user?.userId || 'legacy'}:${t.deviceId}`;
}

function execLabelOf(t: ExecTarget): string {
  if (t.mode === 'local') return isTauri() ? '🏠 本机' : '🖥️ 当前 Web 节点';
  return (t.deviceName && t.deviceName.trim()) || t.deviceId || '远端节点';
}

/** 单条到某执行节点的连接：自管握手 / 心跳 / 指数退避重连。 */
class Conn {
  readonly key: string;
  target: ExecTarget;
  isHome: boolean;
  ws: WebSocket | null = null;
  canManageNode: boolean | undefined;
  ready: Promise<void>;
  private settleReady: () => void = () => {};
  private settled = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(key: string, target: ExecTarget, isHome: boolean) {
    this.key = key;
    this.target = target;
    this.isHome = isHome;
    this.ready = new Promise<void>((resolve) => {
      this.settleReady = () => { if (!this.settled) { this.settled = true; resolve(); } };
    });
  }

  get label(): string { return execLabelOf(this.target); }
  get isOpen(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  private async resolveUrl(): Promise<string> {
    // Resolve from this connection's own target.  Reading the global home
    // target here made an additional local connection accidentally reuse the
    // relay URL whenever home was remote, so a healthy desktop sidecar was
    // never contacted.
    return this.target.mode === 'relay' ? this.target.url : getLocalWsUrl(this.target.user);
  }

  connect(): void {
    if (this.disposed) return;
    this.resolveUrl()
      .then((url) => this.doConnect(url))
      .catch((error) => {
        console.warn(`[api] resolve connection URL failed (${this.key}):`, error);
        this.settleReady();
        if (this.isHome) connectionStatusCallbacks.forEach((cb) => cb(false));
        this.scheduleReconnect();
      });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    const old = this.ws;
    this.ws = null;
    if (old) { try { old.close(); } catch { /* */ } }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  private doConnect(url: string): void {
    if (this.disposed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      console.warn(`[api] WebSocket creation failed (${this.key}):`, error);
      this.settleReady();
      if (this.isHome) connectionStatusCallbacks.forEach((cb) => cb(false));
      this.scheduleReconnect();
      return;
    }
    let wasCurrent = false;
    const target = this.target;
    let relayHandshake = target.mode === 'relay';
    const connectTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) {
        console.warn(`[api] WebSocket connect timed out (${this.key}); retrying`);
        try { socket.close(); } catch { /* */ }
      }
    }, WS_CONNECT_TIMEOUT_MS);

    const finishConnect = () => {
      this.ws = socket;
      wasCurrent = true;
      clearTimeout(connectTimer);
      this.reconnectDelay = INITIAL_RECONNECT_DELAY;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      // 本机连接 URL 含一次性身份映射密钥，不能写进 DevTools / QA 日志。
      console.log(`[api] Connected (${this.key})`);
      if (this.isHome) {
        useMock = false;
        connectionStatusCallbacks.forEach((cb) => cb(true));
      }
      if (this.key === 'local') localExecutorConfirmed = true;
      if (target.mode === 'local' && this.canManageNode === undefined) this.canManageNode = true;
      notifyExecStatus();
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.isOpen) {
          const id = nextId();
          try { this.ws!.send(JSON.stringify({ id, method: 'ping', params: [] })); } catch { /* */ }
        }
      }, HEARTBEAT_INTERVAL_MS);
      this.settleReady();
      if (this.key === 'local') {
        // 同源节点的执行资格是服务端全局策略。连接建立后立即同步，确保换浏览器、
        // 换用户也不会把已设为“控制端专用”的弱 Web 节点重新列为候选。
        void this.request('relayNodeStatus', [], 5_000).then((raw) => {
          const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (typeof status?.agentExecutionEnabled === 'boolean') {
            setLocalAgentExecutionEnabled(status.agentExecutionEnabled);
          }
        }).catch(() => { /* 兼容尚未提供该字段的旧 Backend。 */ });
      }
    };

    socket.onopen = () => {
      if (relayHandshake && target.mode === 'relay') {
        try {
          socket.send(JSON.stringify({ t: 'hello', token: target.token, deviceId: target.deviceId }));
        } catch { /* */ }
      } else {
        finishConnect();
      }
    };

    socket.onerror = () => {
      this.settleReady();
      // Browsers normally follow `error` with `close`, but WebView2 has edge
      // cases where a refused localhost connection remains stuck and no
      // reconnect is scheduled. Force the close edge that owns retry logic.
      if (socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) {
        try { socket.close(); } catch { /* */ }
      }
    };

    socket.onmessage = (e) => {
      if (this.disposed || (wasCurrent && this.ws !== socket)) return;
      if (relayHandshake) {
        if (typeof e.data !== 'string') return;
        try {
          const m = JSON.parse(e.data);
          if (m.t === 'ready') {
            if (typeof m.canClaimLegacy === 'boolean') this.canManageNode = m.canClaimLegacy;
            relayHandshake = false;
            finishConnect();
            // 兼容旧版只保存 URL/token/deviceId 的配置：Relay 握手返回的
            // 已验证档案会补齐稳定 userId，并据此重建本机用户映射。
            if (this.isHome && m.profile) {
              rememberRelayUserProfile(normalizeRelayProfile(m.profile));
            }
          }
          else if (m.t === 'error') {
            console.error('[api] relay rejected:', m.message);
            try { socket.close(); } catch { /* */ }
          }
        } catch { /* ignore non-handshake frames */ }
        return;
      }
      handleMessage(e, this);
    };

    socket.onclose = () => {
      clearTimeout(connectTimer);
      if (wasCurrent && this.ws === socket) {
        this.ws = null;
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        // 只 reject 挂在本连接上的请求,别的节点的请求不受影响。
        pending.forEach((p, id) => {
          if (pendingConn.get(id) === this.key) {
            p.reject(new Error('WebSocket connection lost'));
            pending.delete(id);
            pendingConn.delete(id);
          }
        });
        if (this.isHome) connectionStatusCallbacks.forEach((cb) => cb(false));
      } else if (!wasCurrent && this.isHome) {
        // home 从未握手成功(例如首次就 502)：通知 UI 进入未连接,避免启动页卡死。
        connectionStatusCallbacks.forEach((cb) => cb(false));
      }
      notifyExecStatus();
      this.settleReady();
      this.scheduleReconnect();
    };
  }

  /** 发起一次 RPC。home 离线时回落 mock(保持旧行为);其它节点离线则丢弃返回 null。 */
  async request(method: string, params: any[], timeoutMs?: number): Promise<any> {
    await this.ready;
    if (!this.isOpen) {
      if (this.isHome) return mockDispatch(method, params);
      console.warn(`[api] exec node ${this.key} offline, "${method}" dropped`);
      return null;
    }
    return await new Promise((resolve, reject) => {
      const id = nextId();
      const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          pendingConn.delete(id);
          request.reject(new Error(`RPC timeout after ${timeoutMs}ms: ${method}`));
        }, timeoutMs) : null;
      pending.set(id, {
        resolve: (result) => { if (timer) clearTimeout(timer); resolve(result); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
      });
      pendingConn.set(id, this.key);
      try {
        this.ws!.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        if (timer) clearTimeout(timer);
        pending.delete(id);
        pendingConn.delete(id);
        reject(e as Error);
      }
    });
  }

  /** fire-and-forget。 */
  async sendRaw(method: string, params: any[]): Promise<void> {
    await this.ready;
    if (!this.isOpen) {
      if (this.isHome) mockDispatch(method, params);
      return;
    }
    const id = nextId();
    try { this.ws!.send(JSON.stringify({ id, method, params })); } catch { /* */ }
  }
}

// ── 池 + 路由 ────────────────────────────────────────────────────────
const pool = new Map<string, Conn>();
let homeConn!: Conn;  // initPool() 在模块加载时立即赋值
const sessionExec = new Map<string, string>();   // sessionId → conn.key
let execStatusCallbacks: (() => void)[] = [];

function notifyExecStatus(): void { execStatusCallbacks.forEach((cb) => cb()); }

const SESSION_EXEC_KEY = 'awu.sessionExec';
function loadSessionExec(): void {
  try {
    const raw = localStorage.getItem(SESSION_EXEC_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && typeof o === 'object') for (const k of Object.keys(o)) sessionExec.set(k, o[k]); }
  } catch { /* */ }
}
function persistSessionExec(): void {
  try { localStorage.setItem(SESSION_EXEC_KEY, JSON.stringify(Object.fromEntries(sessionExec))); } catch { /* */ }
}

const EXEC_ROSTER_KEY = 'awu.execRoster';
function loadExecRoster(): ExecTarget[] {
  try {
    const raw = localStorage.getItem(EXEC_ROSTER_KEY);
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return a.filter((t: any) => t && t.mode === 'relay' && t.url && t.deviceId);
    }
  } catch { /* */ }
  return [];
}
function saveExecRoster(list: ExecTarget[]): void {
  try { localStorage.setItem(EXEC_ROSTER_KEY, JSON.stringify(list)); } catch { /* */ }
}

function isLocalRelayDuplicate(connection: Conn | undefined | null): boolean {
  return !!localPhysicalDeviceId
    && connection?.target.mode === 'relay'
    && connection.target.deviceId === localPhysicalDeviceId;
}

function isEffectiveHome(connection: Conn | undefined | null): boolean {
  return !!connection && (
    connection.isHome
    || (connection.key === 'local' && isLocalRelayDuplicate(homeConn))
  );
}

/** 把旧版本留下的本机 Relay 别名缓存/路由归并到 canonical local。 */
function reconcileLocalRelayDuplicates(): void {
  if (!localPhysicalDeviceId || !pool.has('local')) return;
  const duplicateKeys = new Set(
    Array.from(pool.values())
      .filter((connection) => isLocalRelayDuplicate(connection))
      .map((connection) => connection.key),
  );
  if (!duplicateKeys.size) return;

  const rows = new Map<string, any>();
  for (const key of duplicateKeys) {
    for (const session of sessionListCache.get(key) || []) {
      if (session?.id) rows.set(session.id, session);
    }
    sessionListCache.delete(key);
  }
  // 本机缓存优先覆盖同一个 Session 的 Relay 副本。
  for (const session of sessionListCache.get('local') || []) {
    if (session?.id) rows.set(session.id, session);
  }
  if (rows.size) sessionListCache.set('local', Array.from(rows.values()));

  for (const [sessionId, key] of [...sessionExec.entries()]) {
    if (duplicateKeys.has(key)) sessionExec.set(sessionId, 'local');
  }
  const roster = loadExecRoster();
  const filteredRoster = roster.filter((target) => (
    target.mode !== 'relay' || target.deviceId !== localPhysicalDeviceId
  ));
  if (filteredRoster.length !== roster.length) saveExecRoster(filteredRoster);
  // 当前登录/默认连接可能正是这个 Relay 别名，需保留作账户通道；额外的
  // 同机别名连接则可直接关闭，避免无意义心跳和重复广播。
  for (const key of duplicateKeys) {
    const duplicate = pool.get(key);
    if (duplicate && duplicate !== homeConn) {
      pool.delete(key);
      duplicate.dispose();
    }
  }
  persistSessionListCache();
  persistSessionExec();
}

function sessionListConnections(): Conn[] {
  const connections = Array.from(pool.values()).filter(
    (connection) => connection.key !== 'local' || hasLocalExecutor(),
  );
  if (!localPhysicalDeviceId || !pool.has('local')) return connections;
  return connections.filter((connection) => !isLocalRelayDuplicate(connection));
}

function relayIdentity(target: ExecTarget | null | undefined): string {
  if (!target || target.mode !== 'relay') return '';
  const userId = target.user?.userId;
  return userId && userId !== 'legacy'
    ? `user:${userId}`
    : `legacy:${target.url}\u0000${target.token}`;
}

function currentRelayIdentity(): string {
  if (connectionTarget.mode === 'relay') return relayIdentity(connectionTarget);
  return '';
}

function targetUserIdentity(target: ConnectionTarget): string {
  return target.mode === 'local' ? 'local' : relayIdentity(target);
}

function clearRelaySessionCaches(): void {
  for (const key of [...sessionListCache.keys()]) {
    if (key.startsWith('relay:')) sessionListCache.delete(key);
  }
  for (const [sessionId, key] of [...sessionExec.entries()]) {
    if (String(key).startsWith('relay:')) sessionExec.delete(sessionId);
  }
  persistSessionListCache();
  persistSessionExec();
}

/** 身份切换是安全边界：旧用户的全部连接、路由与离线 Session 缓存都丢弃。 */
function clearRelayIdentityState(): void {
  sessionRoutingCache.clear();
  relayIdentityEpoch += 1;
  listSessionsInFlight = null;
  for (const [key, connection] of [...pool.entries()]) {
    pool.delete(key);
    connection.dispose();
  }
  saveExecRoster([]);
  sessionListCache.clear();
  sessionExec.clear();
  persistSessionListCache();
  persistSessionExec();
}

function connectionTransportChanged(left: ExecTarget, right: ExecTarget): boolean {
  if (left.mode === 'relay' && right.mode === 'relay') {
    return left.url !== right.url || left.token !== right.token || left.deviceId !== right.deviceId;
  }
  if (left.mode === 'local' && right.mode === 'local') {
    return (left.user?.userId || 'local') !== (right.user?.userId || 'local');
  }
  return left.mode !== right.mode;
}

function ensureConn(target: ExecTarget, isHome: boolean): Conn {
  const key = execTargetKey(target);
  let c = pool.get(key);
  if (!c) {
    c = new Conn(key, target, isHome);
    pool.set(key, c);
    c.connect();
  } else if (connectionTransportChanged(c.target, target)) {
    const wasHome = c.isHome || isHome;
    c.dispose();
    c = new Conn(key, target, wasHome);
    pool.set(key, c);
    c.connect();
  } else {
    if (isHome) c.isHome = true;
    c.target = target;
  }
  return c;
}

function localTargetForCurrentUser(): ExecTarget {
  // 只有 Tauri 能用桌面壳持有的本机密钥把 Relay userId 安全映射到 sidecar。
  // Web 的同源 Backend 身份由它自己的 loopback/forward-auth 边界决定，不能把
  // 浏览器里另一个 Relay 的 userId 伪装成同源 Web 用户。
  if (isTauri() && connectionTarget.mode === 'relay') {
    const user = normalizeRelayProfile(connectionTarget.user);
    if (user.managed && user.userId && user.userId !== 'legacy') {
      return { mode: 'local', user };
    }
  }
  return { mode: 'local' };
}

function hasLocalExecutor(): boolean {
  return localExecutorConfirmed;
}

function ensureLocalExecutorConnection(): void {
  // 生产 Web 在尚未确认能力时也要主动探测同源 /ws；成功握手后
  // finishConnect 会把它发布到执行节点列表。失败时连接继续后台退避探测。
  const target = localTargetForCurrentUser();
  const existing = pool.get('local');
  if (existing && connectionTransportChanged(existing.target, target)) {
    // local 的 owner 命名空间发生了变化，旧用户的离线列表与 session 路由
    // 必须先清空，不能在新用户完成首轮刷新前短暂泄露到侧栏。
    sessionListCache.delete('local');
    for (const [sessionId, key] of [...sessionExec.entries()]) {
      if (key === 'local') sessionExec.delete(sessionId);
    }
    persistSessionListCache();
    persistSessionExec();
  }
  ensureConn(target, connectionTarget.mode === 'local');
  if (localPhysicalDeviceId) reconcileLocalRelayDuplicates();
}

function initPool(): void {
  loadSessionListCache();
  loadSessionExec();
  homeConn = ensureConn(connectionTarget, true);
  ensureLocalExecutorConnection();
  const homeIdentity = relayIdentity(connectionTarget);
  const storedRoster = loadExecRoster();
  // 一个窗口只承载一个当前用户。Tauri 的 local 会映射到这个用户；不同
  // Relay 用户不能同时进入连接池，同一用户仍可连接多台获授权执行端。
  const safeRoster = homeIdentity
    ? storedRoster.filter((target) => relayIdentity(target) === homeIdentity)
    : [];
  if (safeRoster.length !== storedRoster.length) {
    saveExecRoster(safeRoster);
    clearRelaySessionCaches();
  }
  for (const t of safeRoster) {
    if (execTargetKey(t) !== homeConn.key) ensureConn(t, false);
  }
  for (const key of [...sessionListCache.keys()]) {
    if (!pool.has(key)) sessionListCache.delete(key);
  }
  for (const [sessionId, key] of [...sessionExec.entries()]) {
    if (!pool.has(key)) sessionExec.delete(sessionId);
  }
  persistSessionListCache();
  persistSessionExec();
  if (isTauri()) {
    void getLocalDeviceId().then((deviceId) => {
      if (!deviceId || deviceId === localPhysicalDeviceId) return;
      localPhysicalDeviceId = deviceId;
      reconcileLocalRelayDuplicates();
      notifyExecStatus();
    });
  }
}

// 大多数会话级 RPC 第一个参数就是 sessionId;少数把 sessionId 藏在 JSON 载荷里。
const JSON_SESSION_METHODS: Record<string, string> = {
  sendMessage: 'sessionId',
  executeCommand: 'sessionId',
  branchSession: 'sourceSessionId',
  migrateSession: 'sourceSessionId',
};
function extractSessionId(method: string, params: any[]): string | null {
  const field = JSON_SESSION_METHODS[method];
  if (field) {
    try { const o = JSON.parse(params[0]); if (o && typeof o[field] === 'string') return o[field]; } catch { /* */ }
    return null;
  }
  if (method === 'sttRefine') return typeof params[1] === 'string' && params[1] ? params[1] : null;
  // 约定:第一个参数若是已知会话 id,就路由到它的归属节点。session id 是 UUID,
  // 不会和别的字符串参数撞,因此无需逐一枚举几十个会话级方法。
  const p0 = params[0];
  if (typeof p0 === 'string' && sessionExec.has(p0)) return p0;
  return null;
}

function routeConn(method: string, params: any[]): Conn {
  const sid = extractSessionId(method, params);
  if (sid) {
    const key = sessionExec.get(sid);
    if (key) { const c = pool.get(key); if (c) return c; }
  }
  return homeConn;
}

/** 切换 home 执行节点（本地直连 / 中继远程），持久化并立即重连。 */
export async function setConnectionTarget(t: ConnectionTarget): Promise<void> {
  const oldHome = homeConn;
  const previousIdentity = targetUserIdentity(connectionTarget);
  const nextIdentity = targetUserIdentity(t);
  const identityChanged = previousIdentity !== nextIdentity;
  if (identityChanged) clearRelayIdentityState();
  connectionTarget = t;
  try { localStorage.setItem(CONN_TARGET_KEY, JSON.stringify(t)); } catch { /* */ }
  const newKey = execTargetKey(t);
  if (homeConn && homeConn.key === newKey) {
    if (connectionTransportChanged(homeConn.target, t)) {
      homeConn.dispose();
      homeConn = new Conn(newKey, t, true);
      pool.set(newKey, homeConn);
      homeConn.connect();
    } else {
      homeConn.isHome = true;
      homeConn.target = t;
    }
    ensureLocalExecutorConnection();
    connectionStatusCallbacks.forEach((cb) => cb(homeConn.isOpen));
    notifyCurrentUserChanged(identityChanged);
    return;
  }
  let next = pool.get(newKey);
  if (!next) {
    next = new Conn(newKey, t, true);
    pool.set(newKey, next);
    next.connect();
  } else {
    next.isHome = true;
    next.target = t;
  }
  homeConn = next;
  if (oldHome && oldHome.key !== newKey && pool.get(oldHome.key) === oldHome) {
    oldHome.isHome = false;
    // 同一 Relay 用户切换默认设备时，旧设备保留为可分配节点；跨用户切换
    // 已在上方清空连接池，因此不会把旧身份带进新窗口。
    if (oldHome.target.mode === 'relay' && (!nextIdentity || relayIdentity(oldHome.target) === nextIdentity)) {
      const list = loadExecRoster();
      if (!list.some((rt) => execTargetKey(rt) === oldHome.key)) { list.push(oldHome.target); saveExecRoster(list); }
    }
  }
  ensureLocalExecutorConnection();
  connectionStatusCallbacks.forEach((cb) => cb(homeConn.isOpen));
  notifyExecStatus();
  notifyCurrentUserChanged(identityChanged || (
    (oldHome?.target.mode || 'local') !== t.mode
  ));
}

/** 档案更新不改变 userId；同步更新本地展示缓存，不重建 WebSocket。 */
export function rememberRelayUserProfile(profile: RelayUserProfile): void {
  if (connectionTarget.mode !== 'relay') return;
  const currentId = connectionTarget.user?.userId;
  if (currentId && currentId !== profile.userId) return;
  const updatedTarget: ConnectionTarget = { ...connectionTarget, user: profile };
  if (execTargetKey(updatedTarget) !== execTargetKey(connectionTarget)) {
    void setConnectionTarget(updatedTarget);
    return;
  }
  const url = connectionTarget.url;
  const token = connectionTarget.token;
  connectionTarget = updatedTarget;
  try { localStorage.setItem(CONN_TARGET_KEY, JSON.stringify(connectionTarget)); } catch { /* */ }
  if (homeConn?.target.mode === 'relay'
      && homeConn.target.url === url && homeConn.target.token === token) {
    homeConn.target = { ...homeConn.target, user: profile };
  }
  const roster = loadExecRoster().map((target) => (
    target.mode === 'relay' && target.url === url && target.token === token
      ? { ...target, user: profile }
      : target
  ));
  saveExecRoster(roster);
  for (const connection of pool.values()) {
    if (connection.target.mode === 'relay'
        && connection.target.url === url && connection.target.token === token) {
      connection.target = { ...connection.target, user: profile };
    }
  }
  ensureLocalExecutorConnection();
  notifyCurrentUserChanged(false);
  notifyExecStatus();
}

// ── 执行节点列表（统一模型：本机 + 远端节点，某个为默认）──────────────────
/** 所有执行节点的展示摘要。本机(local)永远在列；按 本机→默认→其余 排序。 */
export function getExecutors(): ExecutorInfo[] {
  const out: ExecutorInfo[] = [];
  const seen = new Set<string>();
  const push = (c: Conn) => {
    if (seen.has(c.key)) return;
    seen.add(c.key);
    out.push({
      key: c.key,
      label: c.label,
      mode: c.target.mode,
      isHome: isEffectiveHome(c),
      connected: c.isOpen,
      canManageNode: c.canManageNode,
    });
  };
  for (const c of pool.values()) {
    if (c.key === 'local' && !hasLocalExecutor()) continue;
    if (!isLocalRelayDuplicate(c)) push(c);
  }
  out.sort((a, b) => {
    if (a.key === 'local') return -1;
    if (b.key === 'local') return 1;
    if (a.isHome !== b.isHome) return a.isHome ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

/** 当前控制端是否允许把同源 Backend 分配给新建 Agent 会话。 */
export function isLocalAgentExecutionEnabled(): boolean {
  return localAgentExecutionEnabled;
}

/**
 * 设置同源 Backend 的 Agent 执行资格。控制连接始终保留。
 * 持久化到服务端由 relayNodeConfigure 负责；这里同步当前窗口及首屏缓存。
 */
export function setLocalAgentExecutionEnabled(enabled: boolean): boolean {
  if (localAgentExecutionEnabled === enabled) return true;
  localAgentExecutionEnabled = enabled;
  try {
    localStorage.setItem(LOCAL_AGENT_EXECUTION_KEY, enabled ? '1' : '0');
  } catch { /* 浏览器禁用持久化时仍让本次窗口立即生效。 */ }
  notifyExecStatus();
  return true;
}

/** 仅返回可承接新建 Session 的节点；管理界面仍应使用 getExecutors()。 */
export function getAssignableExecutors(): ExecutorInfo[] {
  return getExecutors().filter(
    (executor) => executor.key !== 'local' || isLocalAgentExecutionEnabled(),
  );
}

/** 取某节点的完整连接目标(供「设为默认」用)。 */
export function getExecTarget(key: string): ExecTarget | null {
  if (key === 'local' && !hasLocalExecutor()) return null;
  const c = pool.get(key);
  if (c) return c.target;
  if (key === 'local') return localTargetForCurrentUser();
  return loadExecRoster().find((t) => execTargetKey(t) === key) || null;
}

/** 添加一个远端中继执行节点（与本机/默认同时在线，可在新建会话时选）。 */
export function addExecRoster(t: ExecTarget): boolean {
  if (t.mode !== 'relay') return false;
  if (connectionTarget.mode !== 'relay') return false;
  const activeIdentity = currentRelayIdentity();
  const incomingIdentity = relayIdentity(t);
  // roster 不能混入另一名用户；身份切换必须走 setConnectionTarget，确保旧状态
  // 清理和新的 home 连接是同一原子流程。
  if (activeIdentity && activeIdentity !== incomingIdentity) {
    const sameCredentialLegacy = activeIdentity === `legacy:${t.url}\u0000${t.token}`;
    if (!sameCredentialLegacy) return false;
    clearRelayIdentityState();
  }
  const key = execTargetKey(t);
  const list = loadExecRoster();
  const index = list.findIndex((x) => execTargetKey(x) === key);
  if (index < 0) list.push(t);
  else list[index] = t;
  saveExecRoster(list);
  ensureConn(t, false);
  reconcileLocalRelayDuplicates();
  notifyExecStatus();
  return true;
}

/** 移除一个远端节点。本机与当前默认节点不可移除。 */
export function removeExecRoster(key: string): void {
  if (key === 'local') return;                       // 本机不可移除
  if (homeConn && key === homeConn.key) return;      // 当前默认节点不可移除
  saveExecRoster(loadExecRoster().filter((x) => execTargetKey(x) !== key));
  const c = pool.get(key);
  if (c) { pool.delete(key); c.dispose(); }
  notifyExecStatus();
}

/** 当前默认节点(新建会话的默认落点)的 key。 */
export function getHomeExecKey(): string {
  return isLocalRelayDuplicate(homeConn) && pool.has('local')
    ? 'local'
    : (homeConn ? homeConn.key : 'local');
}

/** 订阅执行节点在线状态变化（增删 / 上下线）。 */
export function onExecStatus(cb: () => void): () => void {
  execStatusCallbacks.push(cb);
  return () => { execStatusCallbacks = execStatusCallbacks.filter((x) => x !== cb); };
}

// ── 桌面端本机发布模式（仅 Tauri）──────────────────────────────────────
// 两种模式都运行本机 sidecar；executor 会额外发布到 Relay，client 仅本机可见。
// 由 Rust 在启动时读取（决定是否透传 Relay 发布凭据），改动需重启应用生效。
export interface DesktopConfig {
  mode: 'executor' | 'client';
  relayUrl: string;
  relayToken: string;
  deviceName: string;
}

export async function getDesktopConfig(): Promise<DesktopConfig | null> {
  if (!isTauri()) return null;
  return tauriInvoke<DesktopConfig>('get_desktop_config');
}

export async function setDesktopConfig(config: DesktopConfig): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke('set_desktop_config', { config });
}

// 模块加载即建立连接池（home + roster）。首次连接超时仍回调一次未连接状态,
// 让启动页不会无限卡在「正在连接后端...」。
initPool();
(() => {
  const timer = setTimeout(() => {
    if (!homeConn.isOpen) {
      console.warn(`[api] Initial connect timeout, will keep retrying…`);
      connectionStatusCallbacks.forEach((cb) => cb(false));
    }
  }, WS_CONNECT_TIMEOUT_MS);
  homeConn.ready.then(() => clearTimeout(timer));
})();

// ── RPC 调用（按 session 归属路由到对应执行节点）──────────────────────

async function call(method: string, ...params: any[]): Promise<any> {
  await homeConn.ready;
  try {
    return await routeConn(method, params).request(method, params);
  } catch (err) {
    console.warn(`[api] call "${method}" failed:`, err);
    return null;
  }
}

async function send(method: string, ...params: any[]): Promise<void> {
  await homeConn.ready;
  await routeConn(method, params).sendRaw(method, params);
}

/** 指定执行节点发起 RPC（用于按 workingDir 操作、无 sessionId 可路由的场景，如目录同步）。 */
function connByKey(execKey?: string): Conn {
  const connection = selectExactExecutor(pool, homeConn, execKey);
  if (!connection) throw new Error(`找不到指定的执行节点：${execKey}`);
  return connection;
}
async function callOn(execKey: string | undefined, method: string, ...params: any[]): Promise<any> {
  try {
    const connection = connByKey(execKey);
    await connection.ready;
    return await connection.request(method, params);
  } catch (err) {
    console.warn(`[api] callOn "${method}" failed:`, err);
    return null;
  }
}

/** 和 callOn 相同，但保留异常给长任务调用者做“离线 / 断线 / 超时”分类。 */
async function callOnStrict(
  execKey: string | undefined,
  method: string,
  params: any[],
  timeoutMs?: number,
): Promise<any> {
  const connection = connByKey(execKey);
  await connection.ready;
  if (!connection.isOpen) {
    throw new Error('执行端离线，请恢复连接后重试');
  }
  return connection.request(method, params, timeoutMs);
}

function syncManifestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/timeout/i.test(message)) return '扫描超时（3 分钟），目录可能过大；可缩小范围或检查执行端磁盘状态';
  if (/connection lost|closed|websocket/i.test(message)) return '比对过程中连接中断，请恢复连接后重试';
  if (/offline|离线/i.test(message)) return '执行端离线，请恢复连接后重试';
  return message || '执行端未返回文件清单';
}

function fileSearchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/timeout/i.test(message)) return '远端文件搜索超时，目录可能过大；请稍后重试或检查执行端磁盘状态';
  if (/connection lost|closed|websocket/i.test(message)) return '远端搜索过程中连接中断，请恢复连接后重试';
  if (/offline|离线/i.test(message)) return '执行端离线；已下载到本机的文件仍可搜索';
  return message || '执行端未返回文件搜索结果';
}

function parseRpcObject<T extends Record<string, any>>(result: any, fallback: T): T {
  if (result === null || result === undefined || result === '') return fallback;
  try {
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

function attachSessionExecutor<T extends Record<string, any> | null>(session: T): T {
  if (!session?.id) return session;
  const storedKey = sessionExec.get(session.id);
  let key = getHomeExecKey();
  if (storedKey && pool.has(storedKey)) {
    key = storedKey;
  } else if (storedKey) {
    sessionExec.delete(session.id);
    persistSessionExec();
  }
  const connection = pool.get(key);
  if (connection) {
    session.execKey = connection.key;
    session.execLabel = connection.label;
    session.execMode = connection.target.mode;
    session.execIsHome = isEffectiveHome(connection);
  }
  return session;
}

function cachedSessionMeta(id: string): any | null {
  for (const [key, list] of sessionListCache) {
    const summary = list.find((item) => item?.id === id);
    if (!summary) continue;
    const connection = pool.get(key);
    return {
      ...summary,
      execKey: connection?.key || key,
      execLabel: connection?.label || summary.execLabel,
      execMode: connection?.target.mode || summary.execMode,
      execIsHome: connection ? isEffectiveHome(connection) : summary.execIsHome,
      offlineCached: true,
    };
  }
  return null;
}

// ── 对话框（Tauri plugin-dialog）────────────────────────────

async function nativeOpenDirectory(initialPath?: string): Promise<string | null> {
  if (isTauri()) {
    return tauriOpenDialog({ directory: true, multiple: false, defaultPath: initialPath });
  }
  return null;
}

// Tauri v2 + GTK/XDG 在 defaultPath 是纯文件名时有时不弹出对话框。
// 这里把文件名 join 到下载目录再传入，避免调用失败。
async function resolveDefaultSavePath(filename?: string): Promise<string | undefined> {
  if (!filename) return undefined;
  try {
    const { downloadDir, join } = await import('@tauri-apps/api/path');
    const dir = await downloadDir();
    return await join(dir, filename);
  } catch (e) {
    console.warn('[api] resolveDefaultSavePath fallback:', e);
    return filename;
  }
}

async function nativeSaveFile(defaultFilename?: string): Promise<string | null> {
  if (!isTauri()) {
    throw new Error('文件对话框仅在桌面应用中可用');
  }
  const defaultPath = await resolveDefaultSavePath(defaultFilename);
  return tauriSaveDialog({
    defaultPath,
    // 注意：Tauri 的 filters.extensions 只支持单段扩展，写 'tar.gz' 会被拆错。
    // 保留一个通配 filter 以防平台校验严格。
    filters: [
      { name: 'Tar Archive', extensions: ['gz', 'tgz'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
}

async function nativeSaveJsonFile(defaultFilename: string): Promise<string | null> {
  if (!isTauri()) return null;
  const defaultPath = await resolveDefaultSavePath(defaultFilename);
  return tauriSaveDialog({
    defaultPath,
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
}

async function nativeOpenFile(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error('文件对话框仅在桌面应用中可用');
  }
  return tauriOpenDialog({
    filters: [
      { name: 'Tar Archive', extensions: ['gz', 'tgz'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
}

async function nativeOpenAnyFile(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error('选择客户端本地文件需要 AgentWithU 桌面端');
  }
  return tauriOpenDialog({ directory: false, multiple: false });
}

// ═══════════════════════════════════════
//  Exported API（接口与旧版完全相同）
// ═══════════════════════════════════════
export const api = {
  async readClipboardImage(): Promise<any | null> {
    // Tauri 桌面端:先读**本机**剪贴板。
    // 关键在客户端模式 —— 此时 WS bridge 指向远端执行节点,走 bridge 会
    // 读远端剪贴板,本地截图取不回来。本机读优先,失败再回落到 bridge
    // (覆盖 Wayland / 无 X server / arboard 取不到的边角情况)。
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const r = await invoke<null | {
          base64: string;
          mime_type: string;
          width: number;
          height: number;
          size: number;
        }>('read_local_clipboard_image');
        if (r && r.base64) {
          const { uuid } = await import('./utils/uuid');
          return { id: uuid(), ...r };
        }
        // 本机剪贴板里就是没图,直接返回 null —— 不要再去远端找,
        // 否则会拿到远端机器的剪贴板误判成新截图。
        return null;
      } catch (e) {
        console.warn('[clipboard] local read failed, falling back to bridge:', e);
        // 落到下面的 bridge 调用
      }
    }
    const result = await call('readClipboardImage');
    try { return JSON.parse(result); } catch { return null; }
  },

  async sendMessage(payload: any): Promise<void> {
    await send('sendMessage', JSON.stringify(payload));
  },

  async abortMessage(sessionId: string): Promise<void> {
    await send('abortMessage', sessionId);
  },

  async getFollowUpCapabilities(sessionId: string): Promise<FollowUpCapabilities> {
    const result = await call('getFollowUpCapabilities', sessionId);
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === 'object') return parsed;
      throw new Error('empty capability response');
    } catch {
      return {
        status: 'error', queue: true, nativeSteer: false,
        interruptResume: false, steerAttachments: false,
      };
    }
  },

  async steerMessage(
    sessionId: string,
    text: string,
    images?: any[],
    textAttachments?: any[],
    clientMessageId = '',
  ): Promise<FollowUpResult> {
    const result = await call(
      'steerMessage', sessionId, text,
      images?.length ? JSON.stringify(images) : '',
      textAttachments?.length ? JSON.stringify(textAttachments) : '',
      clientMessageId,
    );
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async redirectMessage(
    sessionId: string,
    text: string,
    images?: any[],
    textAttachments?: any[],
  ): Promise<FollowUpResult> {
    const result = await call(
      'redirectMessage', sessionId, text,
      images?.length ? JSON.stringify(images) : '',
      textAttachments?.length ? JSON.stringify(textAttachments) : '',
    );
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async getSessionRunState(sessionId: string): Promise<{
    status: string; busy: boolean; activeCount?: number; dispatchReserved?: boolean;
  }> {
    const conn = routeConn('getSessionRunState', [sessionId]);
    await conn.ready;
    // 断线不能等价为空闲。尤其经 Relay 时，执行节点上的 CLI 很可能仍在运行。
    if (!conn.isOpen) return { status: 'offline', busy: true };
    try {
      const result = await conn.request('getSessionRunState', [sessionId], 5000);
      const parsed = JSON.parse(result);
      return {
        status: parsed?.status || 'error',
        busy: parsed?.status === 'ok' ? !!parsed.busy : true,
        activeCount: parsed?.activeCount,
        dispatchReserved: parsed?.dispatchReserved,
      };
    } catch {
      return { status: 'offline', busy: true };
    }
  },

  onStreamDelta(callback: StreamDeltaCallback): () => void {
    streamCallbacks.push(callback);
    return () => { streamCallbacks = streamCallbacks.filter((cb) => cb !== callback); };
  },

  onSessionUpdated(callback: SessionUpdateCallback): () => void {
    sessionUpdateCallbacks.push(callback);
    return () => { sessionUpdateCallbacks = sessionUpdateCallbacks.filter((cb) => cb !== callback); };
  },

  async executeCommand(payload: {
    command: string; sessionId: string; backendId: string; args?: any;
  }): Promise<any> {
    const result = await call('executeCommand', JSON.stringify(payload));
    try { return JSON.parse(result); } catch { return null; }
  },

  /**
   * 列出所有执行节点上的 session 并合并:每条 session 带上它的归属节点
   * (execKey / execLabel / execMode / execIsHome),并刷新 sessionId→节点 路由表。
   * roster 为空时即等价于「只列 home 的 session」(向后兼容)。
   */
  async listSessions(): Promise<any[]> {
    // App 与 Sidebar 在启动时可能同时请求；共享同一轮多节点 RPC，避免双发。
    if (listSessionsInFlight) return listSessionsInFlight;
    const request = (async (): Promise<any[]> => {
    const requestEpoch = relayIdentityEpoch;
    // 所有已配置节点都参与合并；离线节点直接使用最后一次成功结果。
    // 在线但连接假死的节点最多等待 3 秒，不能无限拖住整条侧栏。
    const conns = sessionListConnections();
    const results = await Promise.all(conns.map(async (c) => {
      if (!c.isOpen) return {
        c, list: sessionListCache.get(c.key) || [], stale: requestEpoch !== relayIdentityEpoch,
      };
      try {
        const r = await c.request('listSessions', [], LIST_SESSIONS_TIMEOUT_MS);
        if (requestEpoch !== relayIdentityEpoch || pool.get(c.key) !== c) {
          return { c, list: [], stale: true };
        }
        if (typeof r !== 'string') throw new Error('invalid listSessions response');
        const list = JSON.parse(r) || [];
        const normalized = Array.isArray(list) ? list : [];
        sessionListCache.set(c.key, normalized);
        persistSessionListCache();
        return { c, list: normalized, stale: false };
      } catch (error) {
        console.warn(`[api] listSessions failed (${c.key}), using cache`, error);
        return { c, list: sessionListCache.get(c.key) || [], stale: requestEpoch !== relayIdentityEpoch };
      }
    }));
    const batches: Parameters<typeof mergeExecutorSessionBatches>[0] = [];
    for (const { c, list, stale } of results) {
      if (stale || requestEpoch !== relayIdentityEpoch || pool.get(c.key) !== c) continue;
      // 等待其它节点期间可能收到更新事件；事件已把 cache 推到更新版本，
      // 因此合并时再次取 cache，不能使用本轮早先捕获的旧数组。
      const latestList = sessionListCache.get(c.key) || list;
      batches.push({
        execKey: c.key,
        execLabel: c.label,
        execMode: c.target.mode,
        execIsHome: isEffectiveHome(c),
        sessions: latestList,
      });
    }
    const merged = mergeExecutorSessionBatches(batches);
    for (const session of merged) {
      sessionExec.set(session.id, session.execKey);
    }
    persistSessionExec();
    return merged;
    })();
    listSessionsInFlight = request;
    try {
      return await request;
    } finally {
      if (listSessionsInFlight === request) listSessionsInFlight = null;
    }
  },

  async legacySessionOwnershipPreview(): Promise<{
    status: string;
    targetOwnerId?: string;
    eligibleCount?: number;
    busyCount?: number;
    items?: Array<{
      id: string;
      title: string;
      updatedAt: number;
      workingDir: string;
      sessionType: string;
      messageCount: number;
      busyReason: string;
    }>;
    message?: string;
  }> {
    const result = await call('legacySessionOwnershipPreview');
    if (result === null || result === undefined) {
      throw new Error('无法连接到 Session 执行端');
    }
    return JSON.parse(result);
  },

  async claimLegacySessions(sessionIds: string[]): Promise<{
    status: string;
    targetOwnerId?: string;
    count?: number;
    sessionIds?: string[];
    backupPath?: string;
    message?: string;
  }> {
    const result = await call(
      'claimLegacySessions', JSON.stringify(sessionIds), 'CLAIM_LOCAL_SESSIONS',
    );
    if (result === null || result === undefined) {
      throw new Error('无法连接到 Session 执行端');
    }
    return JSON.parse(result);
  },

  /**
   * 加载 session。limit 可选:
   *   - undefined / 0: 返回全部消息(向后兼容,小 session OK,大 session 经中继会卡)
   *   - >0          : 只返回最末 limit 条,响应里附 `messagesTotal` + `hasMore`,
   *                   前端可以先渲染最近的,然后按需 loadSessionMessages 拉更老的
   */
  async loadSession(id: string, limit?: number): Promise<any | null> {
    const result = limit !== undefined && limit > 0
      ? await call('loadSession', id, limit)
      : await call('loadSession', id);
    try {
      const s = JSON.parse(result);
      return attachSessionExecutor(s);
    } catch { return null; }
  },

  /** 只拉 index 元数据，不读取消息正文或 LOOP stage；用于 pane 首屏路由。 */
  async loadSessionMeta(id: string): Promise<any | null> {
    const cached = api.peekSessionMeta(id);
    const revision = sessionRoutingCache.revision(id);
    // 冷启动离线时不能等待 WebSocket 超时后才让平板进入文件副本。
    if (!routeConn('loadSessionMeta', [id]).isOpen && cached) return cached;
    const result = await call('loadSessionMeta', id);
    try {
      const parsed = attachSessionExecutor(JSON.parse(result));
      return parsed ? sessionRoutingCache.loaded(id, parsed, revision) : cached;
    } catch { return cached; }
  },

  peekSessionMeta(id: string): any | null {
    const cached = cachedSessionMeta(id);
    const fresh = sessionRoutingCache.get(id);
    return fresh || cached ? { ...cached, ...fresh } : null;
  },

  /** 翻页加载 session 的更老消息。等价于 messages[offset : offset+limit]。 */
  async loadSessionMessages(id: string, offset: number, limit: number): Promise<{
    messages: any[]; offset: number; limit: number; total: number;
  } | null> {
    const result = await call('loadSessionMessages', id, offset, limit);
    try { return JSON.parse(result); } catch { return null; }
  },

  /** Pull newly completed turns from the native Codex thread of an attached session. */
  async syncAttachedCodexSession(id: string, force = false): Promise<{
    status: string;
    changed?: boolean;
    addedCount?: number;
    messagesTotal?: number;
    retryAfterMs?: number;
    message?: string;
  }> {
    const result = await call('syncAttachedCodexSession', id, force);
    if (result === null || result === undefined) {
      return { status: 'error', message: '无法连接到后端' };
    }
    try { return JSON.parse(result); } catch {
      return { status: 'error', message: '响应格式错误' };
    }
  },

  async deleteSession(id: string): Promise<boolean> {
    return await call('deleteSession', id);
  },

  async destroySession(id: string, confirmation: 'DESTROY'): Promise<{
    status: string; directory?: string; directoryDeleted?: boolean; message?: string;
  }> {
    const result = await call('destroySession', id, confirmation);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到执行端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '销毁响应格式错误' }; }
  },

  async renameSession(sessionId: string, newTitle: string): Promise<{ status: string; message?: string }> {
    const result = await call('renameSession', sessionId, newTitle);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async convertSessionToLoop(sessionId: string, goal: string): Promise<{
    status: string;
    sessionType?: 'loop';
    stage?: string;
    goal?: string;
    summary?: any;
    alreadyConverted?: boolean;
    message?: string;
  }> {
    const result = await call('convertSessionToLoop', sessionId, goal);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到执行节点' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '转换响应格式错误' }; }
  },

  async updateSessionAppearance(
    sessionId: string,
    patch: { pinned?: boolean; sidebarColor?: string },
  ): Promise<{ status: string; pinned?: boolean; sidebarColor?: string; message?: string }> {
    const result = await call('updateSessionAppearance', sessionId, JSON.stringify(patch || {}));
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到执行端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async updateSessionConstraints(sessionId: string, constraints: string | { constraints: string }): Promise<{ status: string; message?: string }> {
    const payload = JSON.stringify(constraints);
    const result = await call('updateSessionConstraints', sessionId, payload);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  /**
   * 列出后端配置。显式传入 execKey 时必须精确命中该执行节点：管理远端
   * Backend 不能在节点离线/被移除时静默回退到 home，否则会读到甚至改错机器。
   */
  async getBackends(execKey?: string, includeDisabled = false): Promise<any[]> {
    // 默认保持无参数调用，兼容尚未升级的远端执行节点。
    const params = includeDisabled ? [true] : [];
    const result = execKey
      ? await callOnStrict(execKey, 'getBackends', params, 10_000)
      : await homeConn.request('getBackends', params);
    try { return JSON.parse(result); } catch { return []; }
  },

  async poeAccountOverview(apiKey = '', execKey?: string): Promise<PoeAccountOverview> {
    const result = execKey
      ? await callOnStrict(execKey, 'poeAccountOverview', [apiKey], 30_000)
      : await homeConn.request('poeAccountOverview', [apiKey]);
    try {
      const parsed = JSON.parse(result);
      return {
        status: parsed?.status || 'error',
        models: Array.isArray(parsed?.models) ? parsed.models : [],
        modelCount: Number(parsed?.modelCount || 0),
        catalogError: parsed?.catalogError || '',
        currentPointBalance: typeof parsed?.currentPointBalance === 'number'
          ? parsed.currentPointBalance
          : null,
        balanceError: parsed?.balanceError || '',
        fetchedAt: Number(parsed?.fetchedAt || 0),
        message: parsed?.message,
      };
    } catch {
      return {
        status: 'error', models: [], modelCount: 0,
        currentPointBalance: null, fetchedAt: 0, message: 'Poe 状态响应格式错误',
      };
    }
  },

  async getSessionTokenUsage(id: string): Promise<any | null> {
    const result = await call('getSessionTokenUsage', id);
    if (result === null || result === undefined) return null;
    try { return JSON.parse(result); } catch { return null; }
  },

  /** 获取 Session 所属执行端的 Backend，而不是客户端当前 home 节点的 Backend。 */
  async getSessionBackends(sessionId: string, includeDisabled = false): Promise<any[]> {
    await homeConn.ready;
    const conn = routeConn('kitGetState', [sessionId]);
    try {
      const result = await conn.request('getBackends', includeDisabled ? [true] : []);
      const parsed = JSON.parse(result);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },

  async saveBackend(config: any, execKey?: string): Promise<void> {
    if (execKey) {
      await callOnStrict(execKey, 'saveBackend', [JSON.stringify(config)], 15_000);
      return;
    }
    await send('saveBackend', JSON.stringify(config));
  },

  async deleteBackend(id: string, execKey?: string): Promise<void> {
    if (execKey) {
      await callOnStrict(execKey, 'deleteBackend', [id], 15_000);
      return;
    }
    await send('deleteBackend', id);
  },

  async exportBackends(
    selectedIds: string[], execKey: string,
  ): Promise<{ status: string; count?: number; fileName?: string; content?: string; message?: string }> {
    const result = await callOnStrict(
      execKey, 'exportBackends', [JSON.stringify(selectedIds)], 20_000,
    );
    try { return JSON.parse(result); }
    catch { return { status: 'error', message: '导出响应格式错误' }; }
  },

  /** Desktop saves controller-side content to a user-confirmed path; Web uses browser download. */
  async saveBackendExportFile(
    fileName: string, content: string,
  ): Promise<{ status: 'saved' | 'cancelled' | 'unsupported'; path?: string }> {
    if (!isTauri()) return { status: 'unsupported' };
    const path = await nativeSaveJsonFile(fileName || 'agent-with-u-backends.json');
    if (!path) return { status: 'cancelled' };
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_export_text_file', { path, data: content });
    return { status: 'saved', path };
  },

  async previewBackendImport(
    content: string, execKey: string,
  ): Promise<{ status: string; count?: number; items: BackendImportPreviewItem[]; message?: string }> {
    const result = await callOnStrict(
      execKey, 'previewBackendImport', [content], 20_000,
    );
    try { return JSON.parse(result); }
    catch { return { status: 'error', items: [], message: '导入预览响应格式错误' }; }
  },

  async importBackends(
    content: string,
    selectedIds: string[],
    conflictPolicy: 'overwrite' | 'skip',
    execKey: string,
  ): Promise<BackendImportResult> {
    const result = await callOnStrict(
      execKey,
      'importBackends',
      [content, JSON.stringify(selectedIds), conflictPolicy],
      30_000,
    );
    try { return JSON.parse(result); }
    catch { return { status: 'error', message: '导入响应格式错误' }; }
  },

  async selectDirectory(initialPath?: string): Promise<string | null> {
    return nativeOpenDirectory(initialPath);
  },

  /** 选择一个由当前桌面客户端读取、随后通过 file_push 发往 Session 执行端的文件。 */
  async selectKitLocalFile(): Promise<string | null> {
    return nativeOpenAnyFile();
  },

  async migrateSession(sourceSessionId: string, targetBackendId: string, execKey?: string): Promise<any> {
    const payload = JSON.stringify({ sourceSessionId, targetBackendId });
    const result = execKey
      ? await callOnStrict(execKey, 'migrateSession', [payload], 120_000)
      : await call('migrateSession', payload);
    try { return JSON.parse(result); } catch { return null; }
  },

  async listSessionRefs(query = '', execKey?: string): Promise<any[]> {
    // 引用上下文必须与当前 Session 位于同一执行节点；远端会话不能查询 home 清单。
    const result = execKey
      ? await callOn(execKey, 'listSessionRefs', query)
      : await call('listSessionRefs', query);
    try { return JSON.parse(result) || []; } catch { return []; }
  },

  async branchSession(sourceSessionId: string, afterMessageId?: string, titleSuffix = '分支'): Promise<any> {
    const result = await call('branchSession', JSON.stringify({ sourceSessionId, afterMessageId, titleSuffix }));
    try { return JSON.parse(result); } catch { return null; }
  },

  /** 新建会话。execKey 指定它落在哪个执行节点(默认 home);建后归属即固定。 */
  async createSession(
    workingDir: string,
    backendId: string,
    sessionType: 'normal' | 'loop' = 'normal',
    runtime: { model?: string; reasoningEffort?: string } = {},
    execKey?: string,
    codexRemote: { mode?: 'node'; threadId?: string; title?: string } = {},
  ): Promise<any> {
    const conn = (execKey && pool.get(execKey))
      || pool.get(getHomeExecKey())
      || homeConn;
    const result = await conn.request('createSession', [
      workingDir, backendId, sessionType, JSON.stringify(runtime || {}), JSON.stringify(codexRemote || {}),
    ]);
    try {
      const s = JSON.parse(result);
      if (s && s.id) {
        sessionExec.set(s.id, conn.key);
        persistSessionExec();
        s.execKey = conn.key;
        s.execLabel = conn.label;
        s.execMode = conn.target.mode;
        s.execIsHome = isEffectiveHome(conn);
      }
      return s;
    } catch { return null; }
  },

  // ── 可视化 Loop 集成 ────────────────────────────────────────
  async loopGetState(sessionId: string): Promise<any | null> {
    const result = await call('loopGetState', sessionId, true);
    try { return JSON.parse(result); } catch { return null; }
  },

  async loopGetRecord(sessionId: string, seq: number): Promise<{
    status: string;
    record?: any;
    progress?: Record<string, string>;
    message?: string;
  }> {
    const result = await call('loopGetRecord', sessionId, seq);
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'Loop 详情解析失败' }; }
  },

  async loopSubmitIdea(sessionId: string, prompt: string, images?: any[]): Promise<{ status: string; ideaId?: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('loopSubmitIdea', sessionId, prompt, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async loopRemoveIdea(sessionId: string, ideaId: string): Promise<{ status: string }> {
    const result = await call('loopRemoveIdea', sessionId, ideaId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async loopSealIdea(sessionId: string, goal: string = ''): Promise<{ status: string; stage?: string; message?: string }> {
    const result = await call('loopSealIdea', sessionId, goal);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async loopSetGoal(sessionId: string, goal: string): Promise<{ status: string }> {
    const result = await call('loopSetGoal', sessionId, goal);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async loopRefineGoal(sessionId: string, hint: string, images?: any[]): Promise<{ status: string; goal?: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('loopRefineGoal', sessionId, hint, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** 设置/更新 loop 策略与心智（建会话时 / 运行时均可）。 */
  async loopSetPolicy(sessionId: string, policy: any): Promise<{ status: string; policy?: any; message?: string }> {
    const result = await call('loopSetPolicy', sessionId, JSON.stringify(policy || {}));
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** 策略预设库：内置 + 用户自存，可直接选用。 */
  async loopPolicyPresetList(): Promise<{ status: string; presets?: any[] }> {
    const result = await call('loopPolicyPresetList');
    try { return JSON.parse(result); } catch { return { status: 'error', presets: [] }; }
  },
  async loopPolicyPresetSave(name: string, policy: any, presetId: string = ''): Promise<{ status: string; preset?: any; message?: string }> {
    const result = await call('loopPolicyPresetSave', name, JSON.stringify(policy || {}), presetId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },
  async loopPolicyPresetDelete(presetId: string): Promise<{ status: string; message?: string }> {
    const result = await call('loopPolicyPresetDelete', presetId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  /** 跨 session 模型能力台账：各 backend 历史表现，供分配参考。 */
  async modelLedgerList(): Promise<{ status: string; models?: any[] }> {
    const result = await call('modelLedgerList');
    try { return JSON.parse(result); } catch { return { status: 'error', models: [] }; }
  },

  /** 关闭意图守卫提示。 */
  async loopDismissIntent(sessionId: string): Promise<{ status: string }> {
    const result = await call('loopDismissIntent', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async loopRunIteration(sessionId: string): Promise<{ status: string; message?: string }> {
    const result = await call('loopRunIteration', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** 停止并删除一次 loop（误触兜底，当作没发生过；消费过的 addon 退回 pending；
   *  restoreFiles=true 且有 git 快照时同时回滚工作目录文件到开跑前）。 */
  async loopDiscard(sessionId: string, seq: number = 0, restoreFiles: boolean = false): Promise<{ status: string; stopping?: boolean; seq?: number; revertedAddons?: number; message?: string }> {
    const result = await call('loopDiscard', sessionId, seq, restoreFiles);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async loopSetAuto(sessionId: string, on: boolean): Promise<{ status: string; auto?: boolean }> {
    const result = await call('loopSetAuto', sessionId, on);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async loopAdvanceToOut(sessionId: string): Promise<{ status: string; stage?: string; stopping?: boolean; message?: string }> {
    const result = await call('loopAdvanceToOut', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** loopout 之后开启新一轮（同一工作目录/上下文，轮次 +1）。 */
  async loopContinue(sessionId: string, goal: string = ''): Promise<{ status: string; stage?: string; round?: number; stopping?: boolean; message?: string }> {
    const result = await call('loopContinue', sessionId, goal);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** “俺寻思”旁路提问：基于 LOOP 状态和当前 UI 注意力，不污染主线上下文。 */
  async loopAsk(sessionId: string, question: string, images?: any[], attention?: Record<string, unknown>): Promise<{ status: string; turnId?: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('loopAsk', sessionId, question, imagesJson, attention ? JSON.stringify(attention) : '');
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async loopAsideList(sessionId: string): Promise<{ status: string; asides: any[]; asideBackendId?: string; message?: string }> {
    const result = await call('loopAsideList', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', asides: [], message: '历史响应解析失败' }; }
  },

  async loopAsideClear(sessionId: string, contextKey: string = ''): Promise<{ status: string; cleared?: number; message?: string }> {
    const result = await call('loopAsideClear', sessionId, contextKey);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '清空响应解析失败' }; }
  },

  async loopAsideAbort(sessionId: string): Promise<{ status: string; aborting?: boolean }> {
    const result = await call('loopAsideAbort', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  /** 执行中补充要求（addon，可带图片）：不影响当前 loop，下一次 loop 的 analysis/prepare 纳入。 */
  async loopAddAddon(sessionId: string, text: string, images?: any[]): Promise<{ status: string; addonId?: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('loopAddAddon', sessionId, text, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async loopRemoveAddon(sessionId: string, addonId: string): Promise<{ status: string }> {
    const result = await call('loopRemoveAddon', sessionId, addonId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  /** 编辑一条待纳入的补充（文字 + 图片）。 */
  async loopEditAddon(sessionId: string, addonId: string, text: string, images?: any[]): Promise<{ status: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('loopEditAddon', sessionId, addonId, text, imagesJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  onLoopAsideDelta(cb: LoopAsideDeltaCallback): () => void {
    loopAsideDeltaCallbacks.push(cb);
    return () => { loopAsideDeltaCallbacks = loopAsideDeltaCallbacks.filter((c) => c !== cb); };
  },

  onLoopUpdated(cb: LoopUpdatedCallback): () => void {
    loopUpdatedCallbacks.push(cb);
    return () => { loopUpdatedCallbacks = loopUpdatedCallbacks.filter((c) => c !== cb); };
  },

  onLoopProgress(cb: LoopProgressCallback): () => void {
    loopProgressCallbacks.push(cb);
    return () => { loopProgressCallbacks = loopProgressCallbacks.filter((c) => c !== cb); };
  },

  // ── 序列任务（普通 session）────────────────────────────────
  async seqtaskGet(sessionId: string): Promise<{ status: string; seqTasks: any[]; seqAuto: boolean }> {
    const result = await call('seqtaskGet', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', seqTasks: [], seqAuto: false }; }
  },
  async seqtaskAdd(
    sessionId: string,
    text: string,
    images?: any[],
    textAttachments?: any[],
  ): Promise<{ status: string; seqTasks?: any[]; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const textAttachmentsJson = textAttachments && textAttachments.length
      ? JSON.stringify(textAttachments)
      : '';
    const result = await call('seqtaskAdd', sessionId, text, imagesJson, textAttachmentsJson);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },
  async seqtaskEdit(
    sessionId: string,
    taskId: string,
    text: string,
    images?: any[],
    textAttachments?: any[],
  ): Promise<{ status: string; seqTasks?: any[]; seqAuto?: boolean; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const textAttachmentsJson = textAttachments && textAttachments.length
      ? JSON.stringify(textAttachments)
      : '';
    const result = await call(
      'seqtaskEdit',
      sessionId,
      taskId,
      text,
      imagesJson,
      textAttachmentsJson,
    );
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },
  async seqtaskRemove(sessionId: string, taskId: string): Promise<{ status: string; seqTasks?: any[]; seqAuto?: boolean; message?: string }> {
    const result = await call('seqtaskRemove', sessionId, taskId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },
  async steerSeqTask(
    sessionId: string,
    taskId: string,
  ): Promise<{ status: string; message?: string }> {
    const result = await call('steerSeqTask', sessionId, taskId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },
  async seqtaskReorder(sessionId: string, ids: string[]): Promise<{ status: string; seqTasks?: any[]; seqAuto?: boolean; message?: string }> {
    const result = await call('seqtaskReorder', sessionId, JSON.stringify(ids));
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },
  async seqtaskSetAuto(sessionId: string, on: boolean): Promise<{ status: string; seqTasks?: any[]; seqAuto?: boolean; message?: string }> {
    const result = await call('seqtaskSetAuto', sessionId, on);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },
  async seqtaskTakeNext(sessionId: string): Promise<{
    status: string; task: any | null; retryAfterMs?: number;
  }> {
    const conn = routeConn('seqtaskTakeNext', [sessionId]);
    await conn.ready;
    // 不走 home 的 mock fallback：离线时返回空任务会让自动链误以为队列结束。
    if (!conn.isOpen) return { status: 'offline', task: null, retryAfterMs: 1000 };
    try {
      const result = await conn.request('seqtaskTakeNext', [sessionId], 5000);
      return JSON.parse(result);
    } catch {
      return { status: 'offline', task: null, retryAfterMs: 1000 };
    }
  },
  async seqtaskClear(sessionId: string): Promise<{ status: string; seqTasks?: any[]; seqAuto?: boolean; message?: string }> {
    const result = await call('seqtaskClear', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },
  onSeqtaskUpdated(cb: SeqtaskUpdatedCallback): () => void {
    seqtaskUpdatedCallbacks.push(cb);
    return () => { seqtaskUpdatedCallbacks = seqtaskUpdatedCallbacks.filter((c) => c !== cb); };
  },

  // ── Workspace Kits（实验）───────────────────────────────────
  async kitCapabilityList(): Promise<{
    status: string; protocolVersion?: number; capabilities?: KitCapabilityMetadata[]; message?: string;
  }> {
    const result = await call('kitCapabilityList');
    return parseRpcObject(result, {
      status: 'error', message: '执行端未响应 Kit 能力目录请求',
    });
  },
  async kitGetState(sessionId: string): Promise<({ status: string; message?: string } & Partial<WorkspaceKitState>)> {
    const result = await call('kitGetState', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'Kit 状态解析失败' }; }
  },
  async kitCreate(sessionId: string, spec: Partial<WorkspaceKit>): Promise<{ status: string; kit?: WorkspaceKit; message?: string }> {
    const result = await call('kitCreate', sessionId, JSON.stringify(spec || {}));
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'Kit 创建响应解析失败' }; }
  },
  async kitGenerate(sessionId: string, request: KitGenerationRequest): Promise<KitGenerationResult> {
    const result = await call('kitGenerate', sessionId, JSON.stringify(request || {}));
    try {
      const parsed = JSON.parse(result);
      if (!parsed || typeof parsed !== 'object') {
        return { status: 'error', ready: false, message: '执行端版本过旧或连接失败：未返回 Kit 编译结果' };
      }
      return parsed;
    } catch { return { status: 'error', ready: false, message: 'AI Kit 编译响应解析失败' }; }
  },
  async kitGenerateStart(sessionId: string, request: KitGenerationRequest): Promise<{
    status: string; reused?: boolean; job?: KitGenerationJob; message?: string;
  }> {
    const result = await call('kitGenerateStart', sessionId, JSON.stringify(request || {}));
    return parseRpcObject(result, {
      status: 'error',
      message: '执行端未响应后台 Kit 生成接口，请更新并重启该 Session 所属执行端',
    });
  },
  async kitGenerationGet(sessionId: string, jobId = ''): Promise<{
    status: string; job?: KitGenerationJob | null; message?: string;
  }> {
    const result = await call('kitGenerationGet', sessionId, jobId);
    return parseRpcObject(result, {
      status: 'error', job: null,
      message: '执行端未响应 Kit 生成状态接口，请更新并重启该 Session 所属执行端',
    });
  },
  async kitGenerateCancel(sessionId: string, jobId: string): Promise<{
    status: string; job?: KitGenerationJob; message?: string;
  }> {
    const result = await call('kitGenerateCancel', sessionId, jobId);
    return parseRpcObject(result, { status: 'error', message: '停止 Kit 生成失败' });
  },
  async kitUpdate(sessionId: string, kitId: string, patch: Partial<WorkspaceKit>): Promise<{ status: string; kit?: WorkspaceKit; message?: string }> {
    const result = await call('kitUpdate', sessionId, kitId, JSON.stringify(patch || {}));
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'Kit 更新响应解析失败' }; }
  },
  async kitVersionList(sessionId: string, kitId: string): Promise<{
    status: string; activeVersionId?: string; versions?: KitVersion[]; message?: string;
  }> {
    const result = await call('kitVersionList', sessionId, kitId);
    return parseRpcObject(result, {
      status: 'error', message: '执行端未响应 Kit 版本接口，请更新并重启该 Session 所属执行端',
    });
  },
  async kitVersionGet(sessionId: string, kitId: string, versionId: string): Promise<{
    status: string; version?: KitVersion; message?: string;
  }> {
    const result = await call('kitVersionGet', sessionId, kitId, versionId);
    return parseRpcObject(result, {
      status: 'error', message: '执行端未响应 Kit 版本接口，请更新并重启该 Session 所属执行端',
    });
  },
  async kitVersionActivate(sessionId: string, kitId: string, versionId: string): Promise<{
    status: string; kit?: WorkspaceKit; activeVersionId?: string; message?: string;
  }> {
    const result = await call('kitVersionActivate', sessionId, kitId, versionId);
    return parseRpcObject(result, {
      status: 'error', message: '执行端未响应 Kit 版本接口，请更新并重启该 Session 所属执行端',
    });
  },
  async kitOptimizeGet(sessionId: string, kitId: string): Promise<{
    status: string; backendId?: string; activeVersionId?: string; versions?: KitVersion[];
    messages?: KitOptimizationMessage[]; message?: string;
  }> {
    const result = await call('kitOptimizeGet', sessionId, kitId);
    return parseRpcObject(result, {
      status: 'error', message: '执行端未响应 Kit 优化接口，请更新并重启该 Session 所属执行端',
    });
  },
  async kitOptimizeAsk(sessionId: string, kitId: string, prompt: string, backendId = ''): Promise<{
    status: string; message?: KitOptimizationMessage | string; messages?: KitOptimizationMessage[];
  }> {
    const result = await call('kitOptimizeAsk', sessionId, kitId, prompt, backendId);
    return parseRpcObject(result, {
      status: 'error', message: '执行端未响应 Kit 优化接口，请更新并重启该 Session 所属执行端',
    });
  },
  async kitOptimizeFinalize(
    sessionId: string, kitId: string, messageId: string, note = '', activate = true,
  ): Promise<{
    status: string; version?: KitVersion; kit?: WorkspaceKit; message?: string;
  }> {
    const result = await call('kitOptimizeFinalize', sessionId, kitId, messageId, note, activate);
    return parseRpcObject(result, {
      status: 'error', message: '执行端未响应 Kit 优化接口，请更新并重启该 Session 所属执行端',
    });
  },
  async kitDelete(sessionId: string, kitId: string): Promise<{ status: string; message?: string }> {
    const result = await call('kitDelete', sessionId, kitId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'Kit 删除响应解析失败' }; }
  },
  async kitRun(sessionId: string, kitId: string, inputs: Record<string, unknown>): Promise<{ status: string; run?: KitRun; message?: string }> {
    const result = await call('kitRun', sessionId, kitId, JSON.stringify(inputs || {}), 'human');
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'Kit 运行响应解析失败' }; }
  },
  async kitCancel(sessionId: string, runId: string): Promise<{ status: string; statusNow?: string; run?: KitRun; message?: string }> {
    const result = await call('kitCancel', sessionId, runId);
    return parseRpcObject(result, {
      status: 'error', message: '执行端未响应 Kit 停止请求，请检查连接后重试',
    });
  },
  async kitResume(sessionId: string, runId: string): Promise<{ status: string; run?: KitRun; message?: string }> {
    const result = await call('kitResume', sessionId, runId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'Kit 恢复响应解析失败' }; }
  },
  async kitClientStepComplete(
    sessionId: string, runId: string, stepId: string,
    resultData: { exitCode?: number; stdout?: string; stderr?: string; error?: string },
  ): Promise<{ status: string; message?: string }> {
    const result = await call('kitClientStepComplete', sessionId, runId, stepId, JSON.stringify(resultData || {}));
    try { return JSON.parse(result); } catch { return { status: 'error', message: '客户端步骤回执解析失败' }; }
  },
  async kitClientStepStart(
    sessionId: string, runId: string, stepId: string,
  ): Promise<{ status: string; step?: any; message?: string }> {
    const result = await call('kitClientStepStart', sessionId, runId, stepId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '客户端步骤领取响应解析失败' }; }
  },
  async kitClientFileStart(
    sessionId: string, runId: string, stepId: string, transferId: string,
    expectedSize: number, expectedSha256: string,
  ): Promise<{ status: string; message?: string }> {
    const result = await call(
      'kitClientFileStart', sessionId, runId, stepId, transferId, expectedSize, expectedSha256,
    );
    try { return JSON.parse(result); } catch { return { status: 'error', message: '文件推送启动响应解析失败' }; }
  },
  async kitClientFileChunk(
    sessionId: string, runId: string, stepId: string, transferId: string,
    offset: number, dataBase64: string,
  ): Promise<{ status: string; written?: number; message?: string }> {
    const result = await call(
      'kitClientFileChunk', sessionId, runId, stepId, transferId, offset, dataBase64,
    );
    try { return JSON.parse(result); } catch { return { status: 'error', message: '文件推送分块响应解析失败' }; }
  },
  async kitClientFileFinish(
    sessionId: string, runId: string, stepId: string, transferId: string,
  ): Promise<{ status: string; message?: string }> {
    const result = await call('kitClientFileFinish', sessionId, runId, stepId, transferId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '文件推送完成响应解析失败' }; }
  },
  async kitClientLocalFileInfo(path: string): Promise<{ size: number; sha256: string }> {
    if (!isTauri()) throw new Error('浏览器客户端不能直接读取本地路径；请使用 AgentWithU 桌面端');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<{ size: number; sha256: string }>('kit_client_file_info', { path });
  },
  async kitClientLocalFileChunk(path: string, offset: number, size: number): Promise<string> {
    if (!isTauri()) throw new Error('浏览器客户端不能直接读取本地路径；请使用 AgentWithU 桌面端');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('kit_client_read_chunk', { path, offset, size });
  },
  async kitClientLocalCommand(spec: {
    runId: string;
    shell: 'powershell' | 'cmd' | 'bash'; command: string; cwd: string;
    timeoutSeconds: number; env?: Record<string, string>;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (!isTauri()) throw new Error('浏览器客户端不支持本地 Shell 步骤；请使用 AgentWithU 桌面端');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('kit_client_command', { spec });
  },
  async kitClientLocalCommandCancel(runId: string): Promise<boolean> {
    if (!isTauri()) return false;
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('kit_client_command_cancel', { runId });
  },
  async kitSetControlMode(sessionId: string, kitId: string, mode: 'ai' | 'human' | 'shared'): Promise<{ status: string; controlMode?: string; message?: string }> {
    const result = await call('kitSetControlMode', sessionId, kitId, mode);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '控制模式响应解析失败' }; }
  },
  async kitTerminalCommand(sessionId: string, kitId: string, command: string): Promise<{ status: string; run?: KitRun; message?: string }> {
    const result = await call('kitTerminalCommand', sessionId, kitId, command);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '终端响应解析失败' }; }
  },
  async kitTerminalClose(sessionId: string, kitId: string): Promise<{ status: string; message?: string }> {
    const result = await call('kitTerminalClose', sessionId, kitId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '终端断开响应解析失败' }; }
  },
  onKitUpdated(cb: KitUpdatedCallback): () => void {
    kitUpdatedCallbacks.push(cb);
    return () => { kitUpdatedCallbacks = kitUpdatedCallbacks.filter((item) => item !== cb); };
  },
  async kitCapabilityRespond(
    sessionId: string, runId: string, stepId: string, approved: boolean,
  ): Promise<{ status: string; decision?: string; run?: KitRun; message?: string }> {
    const result = await call('kitCapabilityRespond', sessionId, runId, stepId, approved);
    return parseRpcObject(result, {
      status: 'error', message: '执行端未响应能力确认请求，请检查连接后重试',
    });
  },
  onKitGenerationUpdated(cb: KitGenerationUpdatedCallback): () => void {
    kitGenerationUpdatedCallbacks.push(cb);
    return () => {
      kitGenerationUpdatedCallbacks = kitGenerationUpdatedCallbacks.filter((item) => item !== cb);
    };
  },

  // ── “俺寻思”注意力伴随问答（普通 session）─────────────────
  async chatAsk(sessionId: string, question: string, images?: any[], attention?: Record<string, unknown>): Promise<{ status: string; turnId?: string; message?: string }> {
    const imagesJson = images && images.length ? JSON.stringify(images) : '';
    const result = await call('chatAsk', sessionId, question, imagesJson, attention ? JSON.stringify(attention) : '');
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },
  async chatAsideList(sessionId: string): Promise<{ status: string; asides: any[]; asideBackendId?: string; message?: string }> {
    const result = await call('chatAsideList', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', asides: [] }; }
  },
  async chatAsideClear(sessionId: string, contextKey: string = ''): Promise<{ status: string; cleared?: number; message?: string }> {
    const result = await call('chatAsideClear', sessionId, contextKey);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '清空响应解析失败' }; }
  },
  async chatAsideSetBackend(sessionId: string, backendId: string): Promise<{ status: string; asideBackendId?: string }> {
    const result = await call('chatAsideSetBackend', sessionId, backendId || '');
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },
  onChatAsideDelta(cb: ChatAsideDeltaCallback): () => void {
    chatAsideDeltaCallbacks.push(cb);
    return () => { chatAsideDeltaCallbacks = chatAsideDeltaCallbacks.filter((c) => c !== cb); };
  },
  onChatAsideUpdated(cb: ChatAsideUpdatedCallback): () => void {
    chatAsideUpdatedCallbacks.push(cb);
    return () => { chatAsideUpdatedCallbacks = chatAsideUpdatedCallbacks.filter((c) => c !== cb); };
  },

  /** 清空 session 消息历史和 agent session ID，但保留 session 本身（目录/能力不变）。 */
  async clearSessionContext(sessionId: string): Promise<void> {
    await call('clearSessionContext', sessionId);
  },

  async selectExportPath(): Promise<string | null> {
    return nativeSaveFile('export.tar.gz');
  },

  async selectImportPath(): Promise<string | null> {
    return nativeOpenFile();
  },

  async exportData(targetPath: string): Promise<any> {
    const result = await call('exportData', targetPath);
    if (result == null) {
      return { status: 'error', message: 'backend 无响应（exportData 返回为空）' };
    }
    try { return JSON.parse(result); }
    catch { return { status: 'error', message: `返回值解析失败: ${String(result).slice(0, 120)}` }; }
  },

  async importData(sourcePath: string): Promise<any> {
    const result = await call('importData', sourcePath);
    if (result == null) {
      return { status: 'error', message: 'backend 无响应（importData 返回为空）' };
    }
    try { return JSON.parse(result); }
    catch { return { status: 'error', message: `返回值解析失败: ${String(result).slice(0, 120)}` }; }
  },

  /** Returns true if connected to the real backend, false if in mock mode. */
  isConnected(): boolean {
    return !useMock && !!homeConn && homeConn.isOpen;
  },

  onConnectionStatus(callback: ConnectionStatusCallback): () => void {
    connectionStatusCallbacks.push(callback);
    // The socket may have connected before React mounted and subscribed.
    // Only replay a completed connection here; while CONNECTING the existing
    // timeout/close path owns the first `false` notification.
    if (homeConn.isOpen) callback(true);
    return () => { connectionStatusCallbacks = connectionStatusCallbacks.filter((cb) => cb !== callback); };
  },

  async updateSessionRuntime(
    sessionId: string,
    runtime: { model?: string; reasoningEffort?: string },
  ): Promise<{ status: string; runtime?: { model?: string; reasoningEffort?: string }; agentSessionId?: string; message?: string }> {
    const result = await call('updateSessionRuntime', sessionId, JSON.stringify(runtime || {}));
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  onSessionConnectionStatus(sessionId: string, callback: ConnectionStatusCallback): () => void {
    let previous = routeConn('getSessionRunState', [sessionId]).isOpen;
    callback(previous);
    const unsubscribe = onExecStatus(() => {
      const connected = routeConn('getSessionRunState', [sessionId]).isOpen;
      if (connected === previous) return;
      previous = connected;
      callback(connected);
    });
    return unsubscribe;
  },

  async codexLocalThreads(backendId: string, execKey?: string): Promise<{ status: string; threads: any[]; message?: string }> {
    const conn = (execKey && pool.get(execKey)) || homeConn;
    const result = await conn.request('codexLocalThreads', [backendId], 45000);
    try { return JSON.parse(result); } catch { return { status: 'error', threads: [], message: '响应格式错误' }; }
  },

  /** Idle loopexecute/loopout -> ordinary chat. Starts one persisted manual pass; loopout opens a new round. */
  async loopTakeover(sessionId: string, goal: string = ''): Promise<{ status: string; controlMode?: string; seq?: number; stage?: string; round?: number; message?: string }> {
    const result = await call('loopTakeover', sessionId, goal);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  /** Finish the current manual pass and return the session to LOOP control. */
  async loopRelease(sessionId: string): Promise<{ status: string; controlMode?: string; message?: string }> {
    const result = await call('loopRelease', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  async listDirectory(
    path: string,
    workingDir?: string,
    execKey?: string,
    includeHidden = false,
  ): Promise<{ name: string; path: string; isDir: boolean; mtime?: number }[]> {
    // execKey 指定时发到该会话的执行节点(远端目录懒加载逐层浏览);缺省回落 home。
    const result = execKey
      ? await callOn(execKey, 'listDirectory', path, workingDir || '', includeHidden)
      : await call('listDirectory', path, workingDir || '', includeHidden);
    try {
      const data = JSON.parse(result);
      if (Array.isArray(data)) return data;
      if (data?.error) throw new Error(data.error);
      return [];
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error('目录列表返回格式无效');
    }
  },

  /** 在指定执行节点的 parentPath 下创建目录。 */
  async createDirectory(parentPath: string, name: string, execKey?: string): Promise<{ status: string; path?: string; name?: string; message?: string }> {
    const result = execKey
      ? await callOn(execKey, 'createDirectory', parentPath, name)
      : await call('createDirectory', parentPath, name);
    try { return JSON.parse(result); }
    catch { return { status: 'error', message: '创建目录返回格式无效' }; }
  },

  /** 重命名指定执行节点上的目录（仅改名，不移动）。 */
  async renameDirectory(path: string, newName: string, execKey?: string): Promise<{ status: string; path?: string; name?: string; message?: string }> {
    const result = execKey
      ? await callOn(execKey, 'renameDirectory', path, newName)
      : await call('renameDirectory', path, newName);
    try { return JSON.parse(result); }
    catch { return { status: 'error', message: '重命名目录返回格式无效' }; }
  },

  /** 服务器侧文件系统浏览起点（home / cwd / 盘符或根）。供 C/S 模式目录选择器使用。
   *  execKey 指定时查询该执行节点；缺省回落 home。
   */
  async getDirRoots(execKey?: string): Promise<{ home: string; cwd: string; roots: string[]; sep: string }> {
    const result = execKey
      ? await callOn(execKey, 'getDirRoots')
      : await call('getDirRoots');
    try {
      return JSON.parse(result);
    } catch {
      return { home: '', cwd: '', roots: ['/'], sep: '/' };
    }
  },

  async getAppConfig(): Promise<any> {
    const result = await call('getAppConfig');
    try { return JSON.parse(result); } catch { return {}; }
  },

  async setAppConfig(config: any): Promise<any> {
    const result = await call('setAppConfig', JSON.stringify(config));
    try { return JSON.parse(result); } catch { return { status: 'error', message: '保存配置失败' }; }
  },

  // ── Git 集成：所有操作通过 execKey 路由到执行节点 ─────────────

  async gitDetect(workingDir: string, execKey?: string): Promise<GitDetectResult> {
    const result = await callOn(execKey, 'gitDetect', workingDir);
    try { return JSON.parse(result); } catch { return { isRepo: false, branch: '', ahead: 0, behind: 0, remote: '', hasUncommitted: false }; }
  },

  async gitStatus(workingDir: string, execKey?: string): Promise<GitStatusResult> {
    const result = await callOn(execKey, 'gitStatus', workingDir);
    try { return JSON.parse(result); } catch { return { files: [], branch: '', upstream: '', ahead: 0, behind: 0, totalChanges: 0, stagedCount: 0 }; }
  },

  async gitDiff(workingDir: string, path: string = '', staged: boolean = false, execKey?: string): Promise<GitDiffResult> {
    const result = await callOn(execKey, 'gitDiff', workingDir, path, staged);
    try { return JSON.parse(result); } catch { return { diff: '', stat: '', binary: false }; }
  },

  async gitStage(workingDir: string, paths: string[], execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitStage', workingDir, JSON.stringify(paths));
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitUnstage(workingDir: string, paths: string[], execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitUnstage', workingDir, JSON.stringify(paths));
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitDiscard(workingDir: string, paths: string[], execKey?: string): Promise<{ status: string; discarded?: string[]; failed?: string[] }> {
    const result = await callOn(execKey, 'gitDiscard', workingDir, JSON.stringify(paths));
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitIgnore(workingDir: string, paths: string[], execKey?: string): Promise<{ status: string; ignored?: string[]; failed?: string[] }> {
    const result = await callOn(execKey, 'gitIgnore', workingDir, JSON.stringify(paths));
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitCommit(workingDir: string, message: string, all: boolean = false, execKey?: string, onlyPaths?: string[]): Promise<GitCommitResult> {
    const result = await callOn(execKey, 'gitCommit', workingDir, message, all, onlyPaths ? JSON.stringify(onlyPaths) : '');
    try { return JSON.parse(result); } catch { return { status: 'error', commitHash: '', filesChanged: 0, insertions: 0, deletions: 0 }; }
  },

  async gitLog(workingDir: string, maxCount: number = 50, offset: number = 0, execKey?: string, since?: string, until?: string): Promise<GitLogResult> {
    const result = await callOn(execKey, 'gitLog', workingDir, maxCount, offset, since || '', until || '');
    try { return JSON.parse(result); } catch { return { commits: [], hasMore: false }; }
  },

  async gitShow(workingDir: string, commitHash: string, execKey?: string): Promise<{ message: string; stat: string; files: { path: string; status: string; added: number; deleted: number }[] }> {
    const result = await callOn(execKey, 'gitShow', workingDir, commitHash);
    try { return JSON.parse(result); } catch { return { message: '', stat: '', files: [] }; }
  },

  async gitCommitFileDiff(workingDir: string, commitHash: string, filePath: string, execKey?: string): Promise<{ diff: string; binary: boolean; error?: string }> {
    const result = await callOn(execKey, 'gitCommitFileDiff', workingDir, commitHash, filePath);
    try { return JSON.parse(result); } catch { return { diff: '', binary: false, error: '解析失败' }; }
  },

  async gitBranches(workingDir: string, execKey?: string): Promise<GitBranchesResult> {
    const result = await callOn(execKey, 'gitBranches', workingDir);
    try { return JSON.parse(result); } catch { return { current: '', local: [], remote: [] }; }
  },

  async gitBranchCreate(workingDir: string, name: string, checkout: boolean = true, execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitBranchCreate', workingDir, name, checkout);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitBranchSwitch(workingDir: string, name: string, execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitBranchSwitch', workingDir, name);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitBranchDelete(workingDir: string, name: string, force: boolean = false, execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitBranchDelete', workingDir, name, force);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitPush(workingDir: string, remote: string = 'origin', branch: string = '', force: boolean = false, execKey?: string): Promise<GitPushPullResult> {
    const result = await callOn(execKey, 'gitPush', workingDir, remote, branch, force);
    try { return JSON.parse(result); } catch { return { status: 'error', output: '' }; }
  },

  async gitPull(workingDir: string, remote: string = 'origin', branch: string = '', rebase: boolean = false, execKey?: string): Promise<GitPushPullResult> {
    const result = await callOn(execKey, 'gitPull', workingDir, remote, branch, rebase);
    try { return JSON.parse(result); } catch { return { status: 'error', output: '' }; }
  },

  async gitStashList(workingDir: string, execKey?: string): Promise<GitStashListResult> {
    const result = await callOn(execKey, 'gitStashList', workingDir);
    try { return JSON.parse(result); } catch { return { stashes: [] }; }
  },

  async gitStashPush(workingDir: string, message: string = '', execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitStashPush', workingDir, message);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitStashPop(workingDir: string, index: number = 0, execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitStashPop', workingDir, index);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitStashDrop(workingDir: string, index: number = 0, execKey?: string): Promise<{ status: string }> {
    const result = await callOn(execKey, 'gitStashDrop', workingDir, index);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async gitGenerateCommitMessage(workingDir: string, stagedOnly: boolean = true, execKey?: string, backendId?: string, onlyPaths?: string[]): Promise<{ status: string; message?: string }> {
    const result = await callOn(execKey, 'gitGenerateCommitMessage', workingDir, stagedOnly, backendId || '', onlyPaths ? JSON.stringify(onlyPaths) : '');
    if (!result) return { status: 'error', message: '与后端连接断开，请确认后端正在运行' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应解析失败' }; }
  },

  // ── 自动 AI commit ────────────────────────────────────────────
  async setAutoCommit(sessionId: string, enabled: boolean, push: boolean = false, backendId: string = ''): Promise<{
    status: string; autoCommit?: boolean; autoCommitPush?: boolean; autoCommitBackendId?: string | null;
  }> {
    const result = await call('setAutoCommit', sessionId, enabled, push, backendId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  async getAutoCommit(sessionId: string): Promise<{
    autoCommit: boolean; autoCommitPush: boolean; autoCommitBackendId: string | null;
  }> {
    const result = await call('getAutoCommit', sessionId);
    try { return JSON.parse(result); } catch { return { autoCommit: false, autoCommitPush: false, autoCommitBackendId: null }; }
  },

  onAutoCommitResult(cb: AutoCommitResultCallback): () => void {
    autoCommitResultCallbacks.push(cb);
    return () => { autoCommitResultCallbacks = autoCommitResultCallbacks.filter((c) => c !== cb); };
  },

  // ─ Git 事件订阅 ─────────────────────────────────────────────
  onGitCommitMsgDelta(cb: (data: { workingDir: string; text: string }) => void): () => void {
    gitCommitMsgDeltaCallbacks.push(cb);
    return () => { gitCommitMsgDeltaCallbacks = gitCommitMsgDeltaCallbacks.filter((c) => c !== cb); };
  },

  onGitCommitMsgReady(cb: (data: { workingDir: string; message: string; error?: string }) => void): () => void {
    gitCommitMsgReadyCallbacks.push(cb);
    return () => { gitCommitMsgReadyCallbacks = gitCommitMsgReadyCallbacks.filter((c) => c !== cb); };
  },

  // ── 目录同步：远端工作目录 ↔ 本机副本目录 ──────────────────
  // 这些操作的是某个执行节点上的工作目录,而参数是路径(不是 sessionId,无法被
  // 自动路由)。所以显式带上该会话的 execKey,把请求发到它归属的节点;缺省回落
  // home(向后兼容)。
  /** 服务器工作目录清单：relpath → {hash, size, mtime}，供客户端做三向增量比对。 */
  async syncManifest(workingDir: string, execKey?: string, includeGit = false): Promise<{
    status: string; message?: string; root?: string;
    files?: Record<string, { hash: string; size: number; mtime?: number }>;
  }> {
    try {
      const result = await callOnStrict(
        execKey, 'syncManifest', [workingDir, includeGit], SYNC_MANIFEST_TIMEOUT_MS,
      );
      const parsed = parseRpcObject<{
        status: string; message?: string; root?: string;
        files?: Record<string, { hash: string; size: number; mtime?: number }>;
      }>(result, { status: 'error', message: '执行端返回了空的文件清单响应' });
      return { ...parsed, files: filterGitMetadata(parsed.files, includeGit) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '');
      // 仅在明确是旧执行端参数数量不兼容时回退一次；超时/断线绝不重扫，避免
      // 在执行端叠加两份大目录哈希任务。
      if (!includeGit && /positional argument|takes .* argument|unexpected argument/i.test(message)) {
        try {
          const legacy = await callOnStrict(
            execKey, 'syncManifest', [workingDir], SYNC_MANIFEST_TIMEOUT_MS,
          );
          const parsed = parseRpcObject<{
            status: string; message?: string; root?: string;
            files?: Record<string, { hash: string; size: number; mtime?: number }>;
          }>(legacy, { status: 'error', message: '旧执行端返回了空的文件清单响应' });
          return { ...parsed, files: filterGitMetadata(parsed.files) };
        } catch (legacyError) {
          return { status: 'error', message: syncManifestError(legacyError) };
        }
      }
      return { status: 'error', message: syncManifestError(error) };
    }
  },

  /** 快速列出某个远端子树内的文件大小；不算哈希，用于传输规划。 */
  async syncFileList(workingDir: string, rel = '', execKey?: string, includeGit = false): Promise<{
    status: string; message?: string; files?: Record<string, number>;
  }> {
    try {
      const result = await callOn(execKey, 'syncFileList', workingDir, rel, includeGit);
      const parsed = parseRpcObject<{
        status: string; message?: string; files?: Record<string, number>;
      }>(result, { status: 'error', message: 'syncFileList 无响应' });
      return { ...parsed, files: filterGitMetadata(parsed.files, includeGit) };
    } catch (error) {
      if (includeGit) throw error;
      const result = await callOn(execKey, 'syncFileList', workingDir, rel);
      const parsed = parseRpcObject<{
        status: string; message?: string; files?: Record<string, number>;
      }>(result, { status: 'error', message: 'syncFileList 无响应' });
      return { ...parsed, files: filterGitMetadata(parsed.files) };
    }
  },
  async chatAsideAbort(sessionId: string): Promise<{ status: string; aborting?: boolean }> {
    const result = await call('chatAsideAbort', sessionId);
    try { return JSON.parse(result); } catch { return { status: 'error' }; }
  },

  /**
   * 递归模糊查询工作区文件名/路径。
   *
   * 显式 execKey 会精确路由到 Session 执行节点，绝不回落到控制端。新版节点在
   * 远端建短时索引；尚未升级、没有 syncFileSearch 的节点则用 syncFileList
   * 获取一次远端清单并在客户端排序，保证滚动升级期间仍能搜索。
   */
  async searchFiles(workingDir: string, query: string, execKey?: string, limit = 200, includeGit = false): Promise<{
    status: string; message?: string; matched?: number; indexed?: number; truncated?: boolean;
    compatibilityFallback?: boolean;
    results?: Array<{ path: string; name: string; size: number; mtime?: number }>;
  }> {
    const resultLimit = Math.max(1, Math.min(Number(limit || 200), 500));
    try {
      const result = await callOnStrict(
        execKey,
        'syncFileSearch',
        [workingDir, query, resultLimit, includeGit],
        FILE_SEARCH_TIMEOUT_MS,
      );
      // 旧执行节点对未知 RPC 返回 null。只有这种明确的“方法不存在”才降级；
      // 超时/断线时不能再启动一次全目录扫描，否则会在远端叠加重任务。
      if (result !== null && result !== undefined && result !== '') {
        return parseRpcObject(result, {
          status: 'error', message: '执行端返回了无效的文件搜索响应', results: [],
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '');
      if (!/positional argument|takes .* argument|unexpected argument/i.test(message)) {
        return { status: 'error', message: fileSearchError(error), results: [] };
      }
    }

    try {
      let result: any;
      try {
        result = await callOnStrict(
          execKey,
          'syncFileList',
          [workingDir, '', includeGit],
          SYNC_MANIFEST_TIMEOUT_MS,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || '');
        if (includeGit || !/positional argument|takes .* argument|unexpected argument/i.test(message)) {
          throw error;
        }
        result = await callOnStrict(
          execKey,
          'syncFileList',
          [workingDir, ''],
          SYNC_MANIFEST_TIMEOUT_MS,
        );
      }
      const parsed = parseRpcObject<{
        status: string; message?: string; files?: Record<string, number>;
      }>(result, { status: 'error', message: '旧执行端未返回远端文件清单' });
      const files = filterGitMetadata(parsed.files, includeGit);
      if (parsed.status !== 'ok' || !files) {
        return { status: 'error', message: parsed.message || '无法读取远端文件清单', results: [] };
      }
      const ranked = rankFileSearchPaths(Object.keys(files), query, resultLimit);
      return {
        status: 'ok',
        results: ranked.results.map(({ path }) => ({
          path,
          name: path.slice(path.lastIndexOf('/') + 1),
          size: Number(files[path] || 0),
        })),
        matched: ranked.matched,
        indexed: Object.keys(files).length,
        truncated: ranked.truncated,
        compatibilityFallback: true,
      };
    } catch (error) {
      return { status: 'error', message: fileSearchError(error), results: [] };
    }
  },

  async syncReadFile(workingDir: string, rel: string, execKey?: string): Promise<{
    status: string; message?: string; hash?: string; data?: string; tooLarge?: boolean;
  }> {
    const result = await callOn(execKey, 'syncReadFile', workingDir, rel);
    return parseRpcObject(result, { status: 'error', message: 'syncReadFile 无响应' });
  },

  async syncFileStat(workingDir: string, rel: string, execKey?: string): Promise<{
    status: string; message?: string; size?: number;
  }> {
    const result = await callOn(execKey, 'syncFileStat', workingDir, rel);
    return parseRpcObject(result, { status: 'error', message: 'syncFileStat 无响应' });
  },

  async syncReadChunk(workingDir: string, rel: string, offset: number, size: number, execKey?: string): Promise<{
    status: string; message?: string; offset?: number; size?: number; total?: number; eof?: boolean; data?: string;
  }> {
    const result = await callOn(execKey, 'syncReadChunk', workingDir, rel, offset, size);
    return parseRpcObject(result, { status: 'error', message: 'syncReadChunk 无响应' });
  },

  async syncWriteStart(workingDir: string, rel: string, transferId: string, execKey?: string): Promise<{ status: string; message?: string }> {
    const result = await callOn(execKey, 'syncWriteStart', workingDir, rel, transferId);
    return parseRpcObject(result, { status: 'error', message: 'syncWriteStart 无响应' });
  },

  async syncWriteChunk(workingDir: string, rel: string, transferId: string, offset: number, dataBase64: string, execKey?: string): Promise<{ status: string; message?: string; written?: number }> {
    const result = await callOn(execKey, 'syncWriteChunk', workingDir, rel, transferId, offset, dataBase64);
    return parseRpcObject(result, { status: 'error', message: 'syncWriteChunk 无响应' });
  },

  async syncWriteFinish(workingDir: string, rel: string, transferId: string, expectedSize: number, execKey?: string): Promise<{ status: string; message?: string; size?: number }> {
    const result = await callOn(execKey, 'syncWriteFinish', workingDir, rel, transferId, expectedSize);
    return parseRpcObject(result, { status: 'error', message: 'syncWriteFinish 无响应' });
  },

  async syncWriteAbort(workingDir: string, rel: string, transferId: string, execKey?: string): Promise<{ status: string; message?: string }> {
    const result = await callOn(execKey, 'syncWriteAbort', workingDir, rel, transferId);
    return parseRpcObject(result, { status: 'error', message: 'syncWriteAbort 无响应' });
  },

  async syncWriteFile(workingDir: string, rel: string, dataBase64: string, execKey?: string): Promise<{ status: string; message?: string }> {
    const result = await callOn(execKey, 'syncWriteFile', workingDir, rel, dataBase64);
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'syncWriteFile 无响应' }; }
  },

  async syncDeleteFile(workingDir: string, rel: string, execKey?: string): Promise<{ status: string; message?: string }> {
    const result = await callOn(execKey, 'syncDeleteFile', workingDir, rel);
    try { return JSON.parse(result); } catch { return { status: 'error', message: 'syncDeleteFile 无响应' }; }
  },

  async syncDeleteEntry(workingDir: string, rel: string, isDirectory: boolean, execKey?: string): Promise<{ status: string; message?: string }> {
    const result = await callOnStrict(execKey, 'syncDeleteEntry', [workingDir, rel, isDirectory]);
    return parseRpcObject(result, { status: 'error', message: '删除未返回明确结果，请刷新确认' });
  },

  async filePreview(workingDir: string, rel: string, execKey?: string): Promise<any> {
    const result = await callOn(execKey, 'filePreview', workingDir, rel);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '预览服务无响应' }; }
  },

  async filePreviewData(name: string, dataBase64: string, execKey?: string): Promise<any> {
    const result = await callOn(execKey, 'filePreviewData', name, dataBase64);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '预览服务无响应' }; }
  },

  async provOpen(workingDir: string, rel: string, execKey?: string): Promise<ProvOpenResult> {
    const result = await callOn(execKey, 'provOpen', workingDir, rel);
    return parseRpcObject(result, {
      status: 'error', message: '审阅服务无响应', document: null,
      provPath: '', existing: false, sourceStatus: 'missing',
      currentSource: null, sourcePreview: null,
    } as unknown as ProvOpenResult);
  },

  async provSave(
    workingDir: string,
    provPath: string,
    document: ProvDocument,
    expectedRevision: number,
    rebindSource = false,
    execKey?: string,
  ): Promise<ProvSaveResult> {
    const result = await callOn(
      execKey,
      'provSave',
      workingDir,
      provPath,
      JSON.stringify(document),
      expectedRevision,
      rebindSource,
    );
    return parseRpcObject(result, { status: 'error', message: '保存 Prov 失败' });
  },

  async provResolve(workingDir: string, provPath: string, execKey?: string): Promise<ProvResolveResult> {
    const result = await callOn(execKey, 'provResolve', workingDir, provPath);
    return parseRpcObject(result, { status: 'error', message: '无法生成 Agent 工作单' });
  },

  async revealFile(workingDir: string, rel: string, execKey?: string): Promise<{ status: string; message?: string }> {
    const result = await callOn(execKey, 'revealFile', workingDir, rel);
    try { return JSON.parse(result); } catch { return { status: 'error', message: '无法打开文件管理器' }; }
  },

  /** 读取同步忽略清单（来自 app-config.syncIgnore）。 */
  async getSyncConfig(): Promise<{ ignore: string[]; defaultIgnore: string[] }> {
    const result = await call('getSyncConfig');
    try { return JSON.parse(result); } catch { return { ignore: [], defaultIgnore: [] }; }
  },

  async setSyncConfig(ignore: string[]): Promise<{ status: string; message?: string }> {
    const result = await call('setSyncConfig', JSON.stringify({ ignore }));
    try { return JSON.parse(result); } catch { return { status: 'error', message: '保存忽略清单失败' }; }
  },

  /** 响应后端发出的 permissionRequest，granted=true 继续，false 取消。 */
  async openLoginTerminal(backendId: string, execKey?: string): Promise<{ status: string; message?: string }> {
    const result = execKey
      ? await callOnStrict(execKey, 'openLoginTerminal', [backendId], 15_000)
      : await call('openLoginTerminal', backendId);
    try { return JSON.parse(result); } catch { return { status: 'ok' }; }
  },

  async openModelTerminal(backendId: string, execKey?: string): Promise<{ status: string; message?: string }> {
    const result = execKey
      ? await callOnStrict(execKey, 'openModelTerminal', [backendId], 15_000)
      : await call('openModelTerminal', backendId);
    try { return JSON.parse(result); } catch { return { status: 'ok' }; }
  },

  async getClaudeSettings(execKey?: string): Promise<{ model: string }> {
    const result = execKey
      ? await callOnStrict(execKey, 'getClaudeSettings', [], 10_000)
      : await call('getClaudeSettings');
    try { return JSON.parse(result); } catch { return { model: '' }; }
  },

  async getMcpServers(execKey?: string): Promise<Record<string, any>> {
    const result = execKey
      ? await callOnStrict(execKey, 'getMcpServers', [], 10_000)
      : await call('getMcpServers');
    try { return JSON.parse(result) || {}; } catch { return {}; }
  },

  async saveMcpServers(servers: Record<string, any>, execKey?: string): Promise<{ status: string; message?: string }> {
    const params = [JSON.stringify(servers)];
    const result = execKey
      ? await callOnStrict(execKey, 'saveMcpServers', params, 15_000)
      : await call('saveMcpServers', ...params);
    try { return JSON.parse(result); } catch { return { status: 'ok' }; }
  },

  // ── Prompt 模板库 ─────────────────────────────────────────────────────
  async listPrompts(): Promise<any[]> {
    const result = await call('listPrompts');
    try { return JSON.parse(result) || []; } catch { return []; }
  },

  async savePrompt(name: string, content: string, icon: string = '📝'): Promise<{ status: string; message?: string }> {
    const result = await call('savePrompt', name, content, icon);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async deletePrompt(name: string): Promise<{ status: string; message?: string }> {
    const result = await call('deletePrompt', name);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async renamePrompt(oldName: string, newName: string, content: string): Promise<{ status: string; message?: string }> {
    const result = await call('renamePrompt', oldName, newName, content);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async updatePromptIcon(name: string, icon: string): Promise<{ status: string; message?: string }> {
    const result = await call('updatePromptIcon', name, icon);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async updateSessionAbilities(sessionId: string, abilities: { skills: string[]; prompts: string[] }): Promise<{ status: string; message?: string }> {
    const result = await call('updateSessionAbilities', sessionId, JSON.stringify(abilities));
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async setPromptDefault(name: string, isDefault: boolean): Promise<{ status: string; message?: string }> {
    const result = await call('setPromptDefault', name, isDefault);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async setSkillDefault(name: string, isDefault: boolean): Promise<{ status: string; message?: string }> {
    const result = await call('setSkillDefault', name, isDefault);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async getDefaultAbilities(): Promise<{ skills: string[]; prompts: string[] }> {
    const result = await call('getDefaultAbilities');
    try { return JSON.parse(result) || { skills: [], prompts: [] }; }
    catch { return { skills: [], prompts: [] }; }
  },

  // ── Skill 孵化库 ──────────────────────────────────────────────────────
  async listSkills(workingDir: string = ''): Promise<SkillInfo[]> {
    const result = await call('listSkills', workingDir);
    try { return JSON.parse(result) || []; } catch { return []; }
  },

  async saveSkill(name: string, content: string): Promise<{ status: string; message?: string }> {
    const result = await call('saveSkill', name, content);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async deleteSkill(name: string): Promise<{ status: string; message?: string }> {
    const result = await call('deleteSkill', name);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async activateSkill(name: string, scope: 'global' | 'project', workingDir: string = ''): Promise<{ status: string; message?: string }> {
    const result = await call('activateSkill', name, scope, workingDir);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async deactivateSkill(name: string, scope: 'global' | 'project', workingDir: string = ''): Promise<{ status: string; message?: string }> {
    const result = await call('deactivateSkill', name, scope, workingDir);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async renameSkill(oldName: string, newName: string, newContent: string): Promise<{ status: string; message?: string }> {
    const result = await call('renameSkill', oldName, newName, newContent);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  // ── 插件包安装 ────────────────────────────────────────────────────────
  async installSkillPackage(pkgPath: string, pkgBase64: string = ''): Promise<{
    status: string; manifest?: any; skills?: any[]; format?: string; message?: string;
  }> {
    const result = await call('installSkillPackage', pkgPath, pkgBase64);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async skillMarketList(query: string = '', refresh: boolean = false): Promise<SkillMarketCatalog> {
    const result = await call('skillMarketList', query, refresh);
    if (result === null || result === undefined) {
      return { status: 'error', message: '无法连接到后端', sources: [], directories: [], items: [] };
    }
    try {
      const parsed = JSON.parse(result);
      return {
        status: parsed?.status === 'ok' ? 'ok' : 'error',
        message: parsed?.message,
        sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
        directories: Array.isArray(parsed?.directories) ? parsed.directories : [],
        items: Array.isArray(parsed?.items) ? parsed.items : [],
        refreshedAt: parsed?.refreshedAt,
      };
    } catch {
      return { status: 'error', message: '响应格式错误', sources: [], directories: [], items: [] };
    }
  },

  async skillMarketAddSource(repository: string, name: string = ''): Promise<{ status: string; source?: SkillMarketSource; message?: string }> {
    const result = await call('skillMarketAddSource', repository, name);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async skillMarketRemoveSource(sourceId: string): Promise<{ status: string; message?: string }> {
    const result = await call('skillMarketRemoveSource', sourceId);
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async skillMarketInstall(
    item: Pick<SkillMarketItem, 'sourceId' | 'path' | 'digest'>,
    allowReplace: boolean = false,
  ): Promise<{ status: string; skill?: any; message?: string }> {
    const result = await call(
      'skillMarketInstall', item.sourceId, item.path, item.digest, allowReplace,
    );
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  // ── Secrets 管理（凭据不传 LLM）────────────────────────────────────────
  async skillRuntimeInspect(name: string, execKey: string, review = false): Promise<any> {
    const result = await callOnStrict(execKey, 'skillRuntimeInspect', [name, review], 60_000);
    return typeof result === 'string' ? JSON.parse(result) : result;
  },

  async skillRuntimePrepare(name: string, execKey: string, approvalToken: string): Promise<any> {
    const result = await callOnStrict(execKey, 'skillRuntimePrepare', [name, approvalToken], 60_000);
    return typeof result === 'string' ? JSON.parse(result) : result;
  },

  async getSkillSecretsSchema(name: string): Promise<{ fields: Array<{ key: string; label: string; type: 'text' | 'password' | 'textarea'; required?: boolean; placeholder?: string }> } | null> {
    const result = await call('getSkillSecretsSchema', name);
    try { return result ? JSON.parse(result) : null; } catch { return null; }
  },

  async setSkillSecrets(name: string, secrets: Record<string, string>): Promise<{ status: string; message?: string }> {
    const result = await call('setSkillSecrets', name, JSON.stringify(secrets));
    if (result === null || result === undefined) return { status: 'error', message: '无法连接到后端' };
    try { return JSON.parse(result); } catch { return { status: 'error', message: '响应格式错误' }; }
  },

  async getSkillSecretsPresence(name: string): Promise<string[]> {
    const result = await call('getSkillSecretsPresence', name);
    try { return result ? JSON.parse(result) : []; } catch { return []; }
  },

  async grantPermission(sessionId: string, granted: boolean, skipRest: boolean = false): Promise<void> {
    await send('grantPermission', sessionId, granted, skipRest);
  },

  onPermissionRequest(callback: PermissionRequestCallback): () => void {
    permissionRequestCallbacks.push(callback);
    return () => { permissionRequestCallbacks = permissionRequestCallbacks.filter((cb) => cb !== callback); };
  },

  /** 获取应用展示版本号（同一天多次构建也不同）。 */
  async getAppVersion(): Promise<string> {
    const result = await call('getAppVersion');
    return typeof result === 'string' && result ? result : '0.0.0-dev';
  },

  /** 读取某个物理执行节点的更新状态。 */
  async nodeUpdateStatus(execKey: string): Promise<NodeUpdateStatus> {
    const result = await callOnStrict(execKey, 'nodeUpdateStatus', [], 15_000);
    return parseRpcObject<NodeUpdateStatus>(result, {
      phase: 'error', busy: false, error: '执行节点未返回更新状态',
      platform: 'unknown', arch: 'unknown', desktop: false,
      current: { version: 'unknown' },
      config: { manifestUrl: '', channel: 'stable', requireSignature: false, hasSignatureKey: false, hasRequestHeaders: false },
    });
  },

  async nodeUpdateConfigure(
    execKey: string,
    config: { manifestUrl?: string; channel?: string; requireSignature?: boolean; signatureKey?: string; clearSignatureKey?: boolean },
  ): Promise<{ status: string; config?: NodeUpdateStatus['config']; message?: string }> {
    const result = await callOnStrict(execKey, 'nodeUpdateConfigure', [JSON.stringify(config || {})], 20_000);
    return parseRpcObject(result, { status: 'error', message: '更新源配置失败' });
  },

  async nodeUpdateCheck(execKey: string, manifestUrl = '', artifactId = ''): Promise<NodeUpdateStatus> {
    const result = await callOnStrict(execKey, 'nodeUpdateCheck', [manifestUrl, artifactId], 90_000);
    return parseRpcObject<NodeUpdateStatus>(result, {
      phase: 'error', busy: false, error: '检查更新失败', platform: 'unknown', arch: 'unknown', desktop: false,
      current: { version: 'unknown' },
      config: { manifestUrl: '', channel: 'stable', requireSignature: false, hasSignatureKey: false, hasRequestHeaders: false },
    });
  },

  /** 开始后台下载；进度通过 nodeUpdateStatus 轮询，不占住同一条 WebSocket。 */
  async nodeUpdateStage(execKey: string, manifestUrl = '', artifactId = '', force = false): Promise<NodeUpdateStatus> {
    const result = await callOnStrict(execKey, 'nodeUpdateStage', [manifestUrl, artifactId, force], 90_000);
    return parseRpcObject<NodeUpdateStatus>(result, {
      phase: 'error', busy: false, error: '无法开始下载更新', platform: 'unknown', arch: 'unknown', desktop: false,
      current: { version: 'unknown' },
      config: { manifestUrl: '', channel: 'stable', requireSignature: false, hasSignatureKey: false, hasRequestHeaders: false },
    });
  },

  async nodeUpdateCancel(execKey: string): Promise<NodeUpdateStatus> {
    const result = await callOnStrict(execKey, 'nodeUpdateCancel', [], 30_000);
    return parseRpcObject<NodeUpdateStatus>(result, {
      phase: 'cancelled', busy: false, platform: 'unknown', arch: 'unknown', desktop: false,
      current: { version: 'unknown' },
      config: { manifestUrl: '', channel: 'stable', requireSignature: false, hasSignatureKey: false, hasRequestHeaders: false },
    });
  },

  async nodeUpdateApply(execKey: string): Promise<{ status: string; requiresDesktop?: boolean; message?: string }> {
    const result = await callOnStrict(execKey, 'nodeUpdateApply', [], 30_000);
    return parseRpcObject(result, { status: 'error', message: '无法启动更新安装' });
  },

  // ── 发布工作台：全局候选构建、冻结计划与后台正式发布 ──────────

  async releaseStatus(execKey: string): Promise<ReleaseCenterState> {
    const result = await callOnStrict(execKey, 'releaseStatus', [], 20_000);
    return parseRpcObject<ReleaseCenterState>(result, {
      status: 'error', message: '执行节点未返回发布中心状态',
      config: {
        projectRoot: '', scanRoots: [], channel: 'stable', baseUrl: '', qiniuBucket: '',
        prefix: 'agentwithu/releases', manifestKey: 'agentwithu/releases/stable/manifest.json',
        stableManifestUrl: '', qshell: 'qshell', requireSignature: false, retentionCount: 0,
        qshellAvailable: false, qiniuAccountConfigured: false, qiniuAccountMessage: '',
        signingKeyConfigured: false, dataRoot: '',
      },
      candidates: [], history: [], jobs: [], activeJob: null,
    });
  },

  async releaseConfigure(
    execKey: string, config: Partial<ReleaseCenterConfig>,
  ): Promise<ReleaseCenterConfig & { status?: string; message?: string }> {
    const result = await callOnStrict(
      execKey, 'releaseConfigure', [JSON.stringify(config || {})], 30_000,
    );
    return parseRpcObject(result, {
      status: 'error', message: '发布配置保存失败', projectRoot: '', scanRoots: [],
      channel: 'stable', baseUrl: '', qiniuBucket: '', prefix: '', manifestKey: '',
      stableManifestUrl: '', qshell: 'qshell', requireSignature: false, retentionCount: 0,
      qshellAvailable: false, qiniuAccountConfigured: false, qiniuAccountMessage: '',
      signingKeyConfigured: false, dataRoot: '',
    });
  },

  async releaseConfigureQiniuAccount(
    execKey: string, accessKey: string, secretKey: string, accountName = 'agentwithu-release',
  ): Promise<{ status: string; configured?: boolean; accountName?: string; message?: string }> {
    const result = await callOnStrict(
      execKey, 'releaseConfigureQiniuAccount', [accessKey, secretKey, accountName], 45_000,
    );
    return parseRpcObject(result, { status: 'error', message: '七牛账号配置失败' });
  },

  async releaseScan(execKey: string, projectRoot = ''): Promise<{ status: string; candidate?: ReleaseCandidate; message?: string }> {
    const result = await callOnStrict(execKey, 'releaseScan', [projectRoot, 'release-center-ui'], 10 * 60_000);
    return parseRpcObject(result, { status: 'error', message: '扫描没有返回结果' });
  },

  async releaseUpdateArtifact(
    execKey: string, candidateId: string, artifactId: string, patch: Partial<ReleaseArtifact>,
  ): Promise<{ status: string; candidate?: ReleaseCandidate; message?: string }> {
    const result = await callOnStrict(
      execKey, 'releaseUpdateArtifact', [candidateId, artifactId, JSON.stringify(patch || {})], 30_000,
    );
    return parseRpcObject(result, { status: 'error', message: '制品设置保存失败' });
  },

  async releaseDiscard(
    execKey: string, candidateId: string,
  ): Promise<{ status: string; candidate?: ReleaseCandidate; message?: string }> {
    const result = await callOnStrict(execKey, 'releaseDiscard', [candidateId], 30_000);
    return parseRpcObject(result, { status: 'error', message: '无法废弃候选构建' });
  },

  async releasePreview(
    execKey: string,
    candidateId: string,
    artifactIds: string[],
    options: { notes?: string; channel?: string; requireSignature?: boolean },
  ): Promise<{ status: string; plan?: ReleasePlan; message?: string }> {
    const result = await callOnStrict(
      execKey, 'releasePreview', [candidateId, JSON.stringify(artifactIds), JSON.stringify(options || {})],
      10 * 60_000,
    );
    return parseRpcObject(result, { status: 'error', message: '发布预检没有返回结果' });
  },

  async releasePublish(
    execKey: string, planId: string,
  ): Promise<{ status: string; job?: ReleaseJob; message?: string }> {
    const result = await callOnStrict(execKey, 'releasePublish', [planId], 30_000);
    return parseRpcObject(result, { status: 'error', message: '无法启动后台发布任务' });
  },

  async releaseCancel(
    execKey: string, jobId: string,
  ): Promise<{ status: string; job?: ReleaseJob; message?: string }> {
    const result = await callOnStrict(execKey, 'releaseCancel', [jobId], 30_000);
    return parseRpcObject(result, { status: 'error', message: '无法取消发布任务' });
  },

  // ── STT 语音转文字 ──────────────────────────────────────────

  async sttCheckLocal(): Promise<{ installed: boolean }> {
    const r = await call('sttCheckLocal');
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { installed: false }; }
  },

  async sttInstallLocal(): Promise<{ ok: boolean; output?: string }> {
    const r = await call('sttInstallLocal');
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, output: 'parse error' }; }
  },

  async getSttConfig(sessionId?: string): Promise<any> {
    const execKey = sessionId ? sessionExec.get(sessionId) : undefined;
    const r = await callOn(execKey, 'getSttConfig');
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return {}; }
  },

  async saveSttConfig(config: any): Promise<boolean> {
    const r = await call('saveSttConfig', JSON.stringify(config));
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return !!d?.ok;
    } catch { return false; }
  },

  async sttTranscribe(audioBase64: string, configOverride?: any): Promise<{ ok: boolean; text?: string; error?: string }> {
    const r = await call('sttTranscribe', audioBase64, JSON.stringify(configOverride || {}));
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  async ttsSynthesize(
    text: string,
    voice: string,
    rate: number,
    engine: 'edge' | 'dashscope' = 'edge',
    model = '',
    sessionId = '',
  ): Promise<{
    ok: boolean;
    engine?: 'edge' | 'dashscope';
    mime?: string;
    base64?: string;
    voice?: string;
    rate?: number;
    sampleRate?: number;
    model?: string;
    truncated?: boolean;
    error?: string;
  }> {
    const result = await callOn(
      sessionId ? sessionExec.get(sessionId) : undefined,
      'ttsSynthesize', text, voice, rate, engine, model,
    );
    try {
      return typeof result === 'string' ? JSON.parse(result) : result;
    } catch {
      return { ok: false, error: '语音响应格式错误' };
    }
  },

  async ttsStreamSynthesize(
    sessionId: string,
    streamId: string,
    seq: number,
    text: string,
    voice: string,
    rate: number,
    engine: 'edge' | 'dashscope' = 'edge',
    model = '',
  ): Promise<{
    ok: boolean;
    accepted?: boolean;
    duplicate?: boolean;
    engine?: 'edge' | 'dashscope';
    streamId?: string;
    seq?: number;
    model?: string;
    voice?: string;
    sampleRate?: number;
    error?: string;
  }> {
    const execKey = sessionExec.get(sessionId);
    const result = await callOn(
      execKey,
      'ttsStreamSynthesize', sessionId, streamId, seq, text, voice, rate, engine, model,
    );
    try {
      return typeof result === 'string' ? JSON.parse(result) : result;
    } catch {
      return { ok: false, error: '实时语音响应格式错误' };
    }
  },

  async ttsStreamFinish(
    sessionId: string,
    streamId: string,
    engine: 'edge' | 'dashscope',
  ): Promise<{
    ok: boolean;
    accepted?: boolean;
    duplicate?: boolean;
    empty?: boolean;
    streamId?: string;
    error?: string;
  }> {
    const execKey = sessionExec.get(sessionId);
    const result = await callOn(execKey, 'ttsStreamFinish', sessionId, streamId, engine);
    try {
      return typeof result === 'string' ? JSON.parse(result) : result;
    } catch {
      return { ok: false, error: '实时语音结束响应格式错误' };
    }
  },

  async ttsStreamCancel(
    sessionId: string,
    streamId: string,
  ): Promise<{ ok: boolean; cancelled?: number; error?: string }> {
    const execKey = sessionExec.get(sessionId);
    const result = await callOn(execKey, 'ttsStreamCancel', sessionId, streamId);
    try {
      return typeof result === 'string' ? JSON.parse(result) : result;
    } catch {
      return { ok: false, error: '实时语音取消响应格式错误' };
    }
  },

  onTtsStreamAudio(cb: TtsStreamAudioCallback): () => void {
    ttsStreamAudioCallbacks.push(cb);
    return () => {
      ttsStreamAudioCallbacks = ttsStreamAudioCallbacks.filter((item) => item !== cb);
    };
  },

  async sttRefine(text: string, sessionId?: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    const r = await call('sttRefine', text, sessionId || '');
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  async sttStreamStart(configOverride?: any, sessionId?: string): Promise<{
    ok: boolean;
    model?: string;
    realtime?: boolean;
    flashRefineEnabled?: boolean;
    flashModel?: string;
    error?: string;
  }> {
    const execKey = sessionId ? sessionExec.get(sessionId) : undefined;
    const r = await callOn(execKey, 'sttStreamStart', JSON.stringify(configOverride || {}));
    try {
      const parsed = typeof r === 'string' ? JSON.parse(r) : r;
      sttStreamExecKey = parsed?.ok ? (execKey || homeConn.key) : undefined;
      return parsed;
    } catch {
      sttStreamExecKey = undefined;
      return { ok: false, error: 'parse error' };
    }
  },

  sttStreamAudioBinary(pcmBuffer: ArrayBuffer): void {
    const conn = connByKey(sttStreamExecKey);
    if (conn?.isOpen) {
      conn.ws!.send(pcmBuffer);
    }
  },

  async sttStreamStop(sessionId?: string): Promise<{
    ok: boolean;
    text?: string;
    refinedByFlash?: boolean;
    refineSkipped?: string;
    refineError?: string;
    realtimeError?: string;
    error?: string;
  }> {
    const execKey = sttStreamExecKey || (sessionId ? sessionExec.get(sessionId) : undefined);
    const r = await callOn(execKey, 'sttStreamStop');
    // 只清当前捕获的绑定；并发 stop/start 时不能把新一轮的节点指针抹掉。
    if (!sttStreamExecKey || sttStreamExecKey === execKey) sttStreamExecKey = undefined;
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  onSttStreamText(cb: SttStreamTextCallback): () => void {
    sttStreamCallbacks.push(cb);
    return () => { sttStreamCallbacks = sttStreamCallbacks.filter((c) => c !== cb); };
  },

  onSttStreamEnd(cb: SttStreamEndCallback): () => void {
    sttStreamEndCallbacks.push(cb);
    return () => { sttStreamEndCallbacks = sttStreamEndCallbacks.filter((c) => c !== cb); };
  },

  // ── 素材中转池（Asset Pool）──────────────────────────────────

  async assetList(limit = 50, offset = 0, tag = ''): Promise<{ items: any[]; stats: any; httpPort: number }> {
    const r = await call('assetList', limit, offset, tag);
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return { items: d?.items || [], stats: d?.stats || {}, httpPort: d?.httpPort || 0 };
    } catch { return { items: [], stats: {}, httpPort: 0 }; }
  },

  async assetPush(payload: { base64: string; mime: string; source?: string; tags?: string[]; desc?: string; ttl?: number }): Promise<{ ok: boolean; asset?: any; error?: string }> {
    const r = await call('assetPush', JSON.stringify(payload));
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  async assetPin(id: string, pinned: boolean): Promise<{ ok: boolean; asset?: any; error?: string }> {
    const r = await call('assetPin', id, pinned);
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  async assetUpdateMeta(payload: { id: string; desc?: string; tags?: string[] }): Promise<{ ok: boolean; asset?: any; error?: string }> {
    const r = await call('assetUpdateMeta', JSON.stringify(payload));
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false, error: 'parse error' }; }
  },

  async assetDelete(id: string): Promise<{ ok: boolean }> {
    const r = await call('assetDelete', id);
    try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return { ok: false }; }
  },

  onAssetChanged(cb: AssetChangedCallback): () => void {
    assetChangedCallbacks.push(cb);
    return () => { assetChangedCallbacks = assetChangedCallbacks.filter((c) => c !== cb); };
  },

  /** 列出当前连接到本执行节点的所有 UI 客户端（本地直连 + 经中继）。 */
  async listConnectedClients(execKey?: string): Promise<ConnectedClient[]> {
    const r = execKey ? await callOn(execKey, 'listConnectedClients') : await call('listConnectedClients');
    try {
      const parsed = typeof r === 'string' ? JSON.parse(r) : r;
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  },

  /** 查询当前物理 Backend 的 Relay 纳管状态；默认精确查询同源 Web/本机节点。 */
  async relayNodeStatus(execKey = 'local'): Promise<RelayNodeStatus> {
    const r = await callOnStrict(execKey, 'relayNodeStatus', [], 10_000);
    const parsed = typeof r === 'string' ? JSON.parse(r) : r;
    return {
      supported: !!parsed?.supported,
      enabled: !!parsed?.enabled,
      agentExecutionEnabled: parsed?.agentExecutionEnabled !== false,
      connected: !!parsed?.connected,
      url: String(parsed?.url || ''),
      hasToken: !!parsed?.hasToken,
      deviceId: String(parsed?.deviceId || ''),
      deviceName: String(parsed?.deviceName || ''),
      source: String(parsed?.source || 'unavailable'),
      lastError: String(parsed?.lastError || ''),
    };
  },

  /** Web/Docker 节点在线启用、修改或停用 Relay 注册；主 Token 不回传浏览器。 */
  async relayNodeConfigure(config: {
    enabled: boolean;
    url: string;
    token?: string;
    deviceName: string;
    agentExecutionEnabled?: boolean;
  }, execKey = 'local'): Promise<RelayNodeStatus> {
    const r = await callOnStrict(
      execKey, 'relayNodeConfigure', [JSON.stringify(config)], 15_000,
    );
    const parsed = typeof r === 'string' ? JSON.parse(r) : r;
    return {
      supported: !!parsed?.supported,
      enabled: !!parsed?.enabled,
      agentExecutionEnabled: parsed?.agentExecutionEnabled !== false,
      connected: !!parsed?.connected,
      url: String(parsed?.url || ''),
      hasToken: !!parsed?.hasToken,
      deviceId: String(parsed?.deviceId || ''),
      deviceName: String(parsed?.deviceName || ''),
      source: String(parsed?.source || 'saved'),
      lastError: String(parsed?.lastError || ''),
    };
  },

  /** 立即切换当前 Web Backend 的全局 Agent 执行资格，不改变 Relay 发布配置。 */
  async relayNodeExecutionConfigure(
    enabled: boolean,
    execKey = 'local',
  ): Promise<RelayNodeStatus> {
    const r = await callOnStrict(
      execKey,
      'relayNodeConfigure',
      [JSON.stringify({ agentExecutionEnabled: enabled })],
      15_000,
    );
    const parsed = typeof r === 'string' ? JSON.parse(r) : r;
    return {
      supported: !!parsed?.supported,
      enabled: !!parsed?.enabled,
      agentExecutionEnabled: parsed?.agentExecutionEnabled !== false,
      connected: !!parsed?.connected,
      url: String(parsed?.url || ''),
      hasToken: !!parsed?.hasToken,
      deviceId: String(parsed?.deviceId || ''),
      deviceName: String(parsed?.deviceName || ''),
      source: String(parsed?.source || 'unavailable'),
      lastError: String(parsed?.lastError || ''),
    };
  },

  /** 订阅「在线 UI 列表」变化事件,接入/断开都会触发。 */
  onClientsChanged(cb: ClientsChangedCallback): () => void {
    clientsChangedCallbacks.push(cb);
    return () => { clientsChangedCallbacks = clientsChangedCallbacks.filter((c) => c !== cb); };
  },

  /** 打开外部 cmd 窗口实时刷日志（仅 Tauri 桌面端可用） */
  async openLogViewer(): Promise<void> {
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_log_viewer');
      } catch (e) {
        console.error('Failed to open log viewer:', e);
      }
    }
  },

  /** 查询 Claude CLI 登录状态（OAuth 凭证 / API key） */
  async getAuthStatus(): Promise<{
    loggedIn: boolean;
    method: 'oauth' | 'apiKey' | 'none';
    expiresAt: number | null;
    expired: boolean;
    credentialsPath: string;
  }> {
    const r = await call('getAuthStatus');
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return {
        loggedIn: !!d?.loggedIn,
        method: d?.method || 'none',
        expiresAt: d?.expiresAt ?? null,
        expired: !!d?.expired,
        credentialsPath: d?.credentialsPath || '',
      };
    } catch {
      return { loggedIn: false, method: 'none', expiresAt: null, expired: false, credentialsPath: '' };
    }
  },

  /** 按文件名取 skill 生成图片（走数据通道，本地/中继通用） */
  async getSkillImage(filename: string): Promise<{ ok: boolean; mime?: string; base64?: string; error?: string }> {
    const r = await call('getSkillImage', filename);
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return d && typeof d === 'object' ? d : { ok: false, error: 'bad response' };
    } catch {
      return { ok: false, error: 'parse error' };
    }
  },

  /** 按 id 取素材池条目（默认缩略图），走数据通道 */
  async getAsset(id: string, thumb = true): Promise<{ ok: boolean; mime?: string; base64?: string; error?: string }> {
    const r = await call('getAsset', id, thumb);
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return d && typeof d === 'object' ? d : { ok: false, error: 'bad response' };
    } catch {
      return { ok: false, error: 'parse error' };
    }
  },

  /** 读取后端日志末尾若干行（适用于 CS / WebSocket 架构的应用内日志查看器） */
  async getBackendLogs(maxLines = 500): Promise<{ ok: boolean; lines: string[]; path?: string; error?: string }> {
    const r = await call('getBackendLogs', maxLines);
    try {
      const d = typeof r === 'string' ? JSON.parse(r) : r;
      return { ok: !!d?.ok, lines: d?.lines || [], path: d?.path, error: d?.error };
    } catch {
      return { ok: false, lines: [], error: 'parse error' };
    }
  },

  /** 读取本机 Tauri/Rust 桌面日志；不依赖 Python 后端或远端连接。 */
  async getDesktopLogs(maxLines = 500): Promise<{ ok: boolean; lines: string[]; path?: string; error?: string }> {
    if (!isTauri()) return { ok: false, lines: [], error: '仅桌面客户端提供本机日志' };
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const r = await invoke<any>('get_desktop_logs', { maxLines });
      return { ok: !!r?.ok, lines: r?.lines || [], path: r?.path, error: r?.error };
    } catch (error) {
      return { ok: false, lines: [], error: String(error) };
    }
  },
};

// ── Skill 图片：按文件名取一次、缓存为 data URL，供 markdown 渲染按需加载 ──
const skillImageCache = new Map<string, string>();
const skillImageInflight = new Map<string, Promise<string>>();

export function loadSkillImageDataUrl(filename: string): Promise<string> {
  const cached = skillImageCache.get(filename);
  if (cached) return Promise.resolve(cached);
  let p = skillImageInflight.get(filename);
  if (!p) {
    p = (async () => {
      const r = await api.getSkillImage(filename);
      if (!r.ok || !r.base64) throw new Error(r.error || 'load failed');
      const url = `data:${r.mime || 'image/png'};base64,${r.base64}`;
      skillImageCache.set(filename, url);
      return url;
    })();
    skillImageInflight.set(filename, p);
    p.catch(() => { /* keep errors from rejecting unhandled */ })
      .finally(() => skillImageInflight.delete(filename));
  }
  return p;
}

// ── 素材池图片：同样按需取、缓存为 data URL（id+thumb 为键，内容不可变）──
const assetImageCache = new Map<string, string>();
const assetImageInflight = new Map<string, Promise<string>>();

export function loadAssetDataUrl(id: string, thumb = true): Promise<string> {
  const key = (thumb ? 't:' : 'f:') + id;
  const cached = assetImageCache.get(key);
  if (cached) return Promise.resolve(cached);
  let p = assetImageInflight.get(key);
  if (!p) {
    p = (async () => {
      const r = await api.getAsset(id, thumb);
      if (!r.ok || !r.base64) throw new Error(r.error || 'load failed');
      const url = `data:${r.mime || 'image/jpeg'};base64,${r.base64}`;
      assetImageCache.set(key, url);
      return url;
    })();
    assetImageInflight.set(key, p);
    p.catch(() => { /* keep errors from rejecting unhandled */ })
      .finally(() => assetImageInflight.delete(key));
  }
  return p;
}

// ═══════════════════════════════════════
//  Mock bridge（WebSocket 不可用时的 fallback）
// ═══════════════════════════════════════

const mockBackends: any[] = [
  { id: 'claude-agent-sdk-default', type: 'claude-agent-sdk', label: 'Claude Code (Agent SDK)', model: 'sonnet', env: {} },
];
let mockAppConfig: any = { fontSize: 14, renderMarkdown: true, exportFormat: 'markdown', theme: 'dark', sidebarSessionLimit: 25 };

function mockDispatch(method: string, params: any[]): any {
  switch (method) {
    case 'readClipboardImage': return 'null';
    case 'getSkillImage': return JSON.stringify({ ok: false, error: 'backend not connected' });
    case 'getAsset': return JSON.stringify({ ok: false, error: 'backend not connected' });
    case 'getAuthStatus':
      return JSON.stringify({ loggedIn: false, method: 'none', expiresAt: null, expired: false, credentialsPath: '' });
    case 'getBackendLogs':
      return JSON.stringify({ ok: true, lines: ['[mock] backend not connected — run: python -m src.ws_main'] });
    case 'getAppConfig': return JSON.stringify(mockAppConfig);
    case 'setAppConfig':
      mockAppConfig = JSON.parse(params[0]);
      return JSON.stringify({ status: 'ok' });
    case 'sendMessage': {
      const payload = JSON.parse(params[0]);
      const msgId = payload.messageId || 'mock-' + Date.now();
      setTimeout(() => {
        streamCallbacks.forEach((cb) => cb({
          sessionId: payload.sessionId, messageId: msgId, type: 'text_delta',
          text: 'Mock response — WebSocket not connected.\n\nRun: `python -m src.ws_main`\n\nSlash commands work! Try `/help`.',
        }));
        setTimeout(() => {
          streamCallbacks.forEach((cb) => cb({
            sessionId: payload.sessionId, messageId: msgId, type: 'done',
            usage: { inputTokens: 100, outputTokens: 50 },
          }));
        }, 100);
      }, 300);
      return null;
    }
    case 'abortMessage': return null;
    case 'getSessionRunState': return JSON.stringify({ status: 'ok', busy: false, activeCount: 0 });
    case 'getFollowUpCapabilities': return JSON.stringify({
      status: 'ok', queue: true, nativeSteer: false,
      interruptResume: false, steerAttachments: false,
    });
    case 'steerMessage': case 'redirectMessage':
      return JSON.stringify({ status: 'unsupported', message: 'mock mode' });
    case 'executeCommand': {
      const p = JSON.parse(params[0]);
      if (p.command === 'compact') return JSON.stringify({ status: 'ok', removed: 5, remaining: 6 });
      return JSON.stringify({ status: 'ok' });
    }
    case 'clearSessionContext': return JSON.stringify({ success: true });
    case 'createSession': {
      let runtime: any = {};
      try { runtime = JSON.parse(params[3] || '{}'); } catch { runtime = {}; }
      return JSON.stringify({
        id: 'mock-' + Date.now(), title: 'Mock session',
        createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000,
        messages: [], backendId: params[1], autoContinue: true,
        modelOverride: runtime.model,
        reasoningEffort: runtime.reasoningEffort,
        sessionType: params[2] || 'normal',
      });
    }
    case 'loopGetState': return 'null';
    case 'loopGetRecord': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopSubmitIdea': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopRemoveIdea': return JSON.stringify({ status: 'ok' });
    case 'loopSealIdea': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopSetGoal': return JSON.stringify({ status: 'ok' });
    case 'convertSessionToLoop': return JSON.stringify({
      status: 'ok', sessionType: 'loop', stage: 'loopexecute', goal: params[1] || '',
    });
    case 'loopRefineGoal': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopSetPolicy': return JSON.stringify({ status: 'ok' });
    case 'loopPolicyPresetList': return JSON.stringify({ status: 'ok', presets: [] });
    case 'loopPolicyPresetSave': return JSON.stringify({ status: 'ok' });
    case 'loopPolicyPresetDelete': return JSON.stringify({ status: 'ok' });
    case 'modelLedgerList': return JSON.stringify({ status: 'ok', models: [] });
    case 'loopDismissIntent': return JSON.stringify({ status: 'ok' });
    case 'loopRunIteration': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopTakeover': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopRelease': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopDiscard': return JSON.stringify({ status: 'ok' });
    case 'loopSetAuto': return JSON.stringify({ status: 'ok', auto: !!params[1] });
    case 'loopAdvanceToOut': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopContinue': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopAsk': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopAsideList': return JSON.stringify({ status: 'ok', asides: [], asideBackendId: '' });
    case 'loopAsideAbort': return JSON.stringify({ status: 'ok', aborting: false });
    case 'loopAsideClear': return JSON.stringify({ status: 'ok', cleared: 0 });
    case 'loopAddAddon': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'loopRemoveAddon': return JSON.stringify({ status: 'ok' });
    case 'loopEditAddon': return JSON.stringify({ status: 'ok' });
    case 'seqtaskGet': return JSON.stringify({ status: 'ok', seqTasks: [], seqAuto: false });
    case 'seqtaskAdd': case 'seqtaskEdit': case 'seqtaskReorder':
    case 'seqtaskClear': return JSON.stringify({ status: 'ok', seqTasks: [], seqAuto: false });
    case 'seqtaskRemove': case 'seqtaskSetAuto': return JSON.stringify({ status: 'ok' });
    case 'steerSeqTask': return JSON.stringify({ status: 'error', message: 'mock mode 不支持当前轮引导' });
    case 'seqtaskTakeNext': return JSON.stringify({ status: 'ok', task: null });
    case 'kitCapabilityList': return JSON.stringify({
      status: 'ok', protocolVersion: 1, capabilities: [],
    });
    case 'kitGetState': return JSON.stringify({
      status: 'ok', sessionId: params[0], kits: [], runs: [], artifacts: [], dataMarket: [],
    });
    case 'kitGenerate':
      return JSON.stringify({ status: 'error', message: 'mock mode 不支持 AI Kit 编译' });
    case 'kitGenerateStart': case 'kitGenerateCancel':
      return JSON.stringify({ status: 'error', message: 'mock mode 不支持后台 AI Kit 编译' });
    case 'kitGenerationGet':
      return JSON.stringify({ status: 'ok', job: null });
    case 'kitCreate': case 'kitUpdate': case 'kitDelete':
    case 'kitVersionList': case 'kitVersionGet': case 'kitVersionActivate':
    case 'kitOptimizeGet': case 'kitOptimizeAsk': case 'kitOptimizeFinalize':
    case 'kitRun': case 'kitCancel': case 'kitResume': case 'kitCapabilityRespond': case 'kitClientStepStart': case 'kitClientStepComplete':
    case 'kitClientFileStart': case 'kitClientFileChunk': case 'kitClientFileFinish':
    case 'kitSetControlMode': case 'kitTerminalCommand':
    case 'kitTerminalClose':
      return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'chatAsk': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'chatAsideList': return JSON.stringify({ status: 'ok', asides: [], asideBackendId: '' });
    case 'chatAsideClear': return JSON.stringify({ status: 'ok', cleared: 0 });
    case 'chatAsideSetBackend': return JSON.stringify({ status: 'ok', asideBackendId: params[1] || '' });
    case 'chatAsideAbort': return JSON.stringify({ status: 'ok', aborting: false });
    case 'listSessions': return '[]';
    case 'listConnectedClients': return '[]';
    case 'loadSession': return 'null';
    case 'loadSessionMeta': return 'null';
    case 'getSessionTokenUsage': return JSON.stringify({
      inputTokens: 1200, outputTokens: 360, totalTokens: 1560,
      actualTurns: 3, estimatedTurns: 0, turnCount: 3, coverage: 1,
      events: [], contextEvents: [], latestContext: null,
    });
    case 'loadSessionMessages': return 'null';
    case 'syncAttachedCodexSession': return JSON.stringify({ status: 'ok', changed: false });
    case 'deleteSession': return true;
    case 'destroySession': return JSON.stringify({ status: 'error', message: 'mock mode 不执行目录销毁' });
    case 'getBackends': return JSON.stringify(mockBackends);
    case 'poeAccountOverview': return JSON.stringify({
      status: 'ok',
      models: [
        { id: 'assistant', createdAt: Date.now() - 86_400_000, description: 'Poe 自动路由助手' },
        { id: 'GPT-5.4', createdAt: Date.now() - 172_800_000, description: 'OpenAI model on Poe' },
      ],
      modelCount: 2,
      currentPointBalance: params[0] ? 1500 : null,
      balanceError: params[0] ? '' : '请填写 Poe API Key 后刷新余额',
      fetchedAt: Date.now(),
    });
    case 'saveBackend': {
      const cfg = JSON.parse(params[0]);
      const idx = mockBackends.findIndex((b) => b.id === cfg.id);
      if (idx >= 0) mockBackends[idx] = cfg; else mockBackends.push(cfg);
      return null;
    }
    case 'deleteBackend': {
      const idx = mockBackends.findIndex((b) => b.id === params[0]);
      if (idx >= 0) mockBackends.splice(idx, 1);
      return null;
    }
    case 'renameSession': return JSON.stringify({ status: 'ok' });
    case 'updateSessionAppearance': return JSON.stringify({ status: 'ok', ...JSON.parse(params[1] || '{}') });
    case 'listPrompts': return JSON.stringify([]);
    case 'savePrompt': return JSON.stringify({ status: 'ok' });
    case 'deletePrompt': return JSON.stringify({ status: 'ok' });
    case 'renamePrompt': return JSON.stringify({ status: 'ok' });
    case 'updatePromptIcon': return JSON.stringify({ status: 'ok' });
    case 'updateSessionAbilities': return JSON.stringify({ status: 'ok' });
    case 'updateSessionConstraints': return JSON.stringify({ status: 'ok' });
    case 'updateSessionRuntime': {
      const runtime = JSON.parse(params[1] || '{}');
      return JSON.stringify({ status: 'ok', runtime });
    }
    case 'setPromptDefault': return JSON.stringify({ status: 'ok' });
    case 'setSkillDefault': return JSON.stringify({ status: 'ok' });
    case 'getDefaultAbilities': return JSON.stringify({ skills: [], prompts: [] });
    case 'skillMarketList': return JSON.stringify({
      status: 'ok', sources: [], directories: [], items: [], refreshedAt: Date.now() / 1000,
    });
    case 'skillMarketAddSource': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'skillMarketRemoveSource': return JSON.stringify({ status: 'ok' });
    case 'skillMarketInstall': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'getAppVersion': return '0.0.0-dev';
    case 'nodeUpdateStatus': return JSON.stringify({
      phase: 'idle', busy: false, platform: 'mock', arch: 'mock', desktop: false,
      current: { version: '0.0.0-dev' },
      config: { manifestUrl: '', channel: 'stable', requireSignature: false, hasSignatureKey: false, hasRequestHeaders: false },
    });
    case 'nodeUpdateConfigure': return JSON.stringify({ status: 'ok' });
    case 'nodeUpdateCheck': case 'nodeUpdateStage': case 'nodeUpdateCancel':
      return JSON.stringify({
        phase: 'current', busy: false, platform: 'mock', arch: 'mock', desktop: false,
        current: { version: '0.0.0-dev' }, available: false,
        config: { manifestUrl: '', channel: 'stable', requireSignature: false, hasSignatureKey: false, hasRequestHeaders: false },
      });
    case 'nodeUpdateApply': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'releaseStatus': return JSON.stringify({
      status: 'ok',
      config: {
        projectRoot: '', scanRoots: ['src-tauri/target/release/bundle', 'dist'],
        channel: 'stable', baseUrl: '', qiniuBucket: '', prefix: 'agentwithu/releases',
        manifestKey: 'agentwithu/releases/stable/manifest.json', stableManifestUrl: '',
        qshell: 'qshell', requireSignature: false, retentionCount: 0, qshellAvailable: false,
        qiniuAccountConfigured: false, qiniuAccountMessage: '尚未配置七牛账号',
        signingKeyConfigured: false, dataRoot: '',
      },
      candidates: [], history: [], jobs: [], activeJob: null,
    });
    case 'releaseConfigure': return JSON.stringify({ status: 'ok' });
    case 'releaseConfigureQiniuAccount': return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'releaseScan': case 'releaseUpdateArtifact': case 'releaseDiscard':
    case 'releasePreview': case 'releasePublish': case 'releaseCancel':
      return JSON.stringify({ status: 'error', message: 'mock mode' });
    case 'getDirRoots': return JSON.stringify({ home: '', cwd: '', roots: ['/'], sep: '/' });
    case 'assetList': return JSON.stringify({ items: [], stats: { count: 0, pinned: 0, bytes: 0 }, httpPort: 0 });
    case 'assetPush': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'assetPin': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'assetUpdateMeta': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'assetDelete': return JSON.stringify({ ok: false });
    case 'sttCheckLocal': return JSON.stringify({ installed: false });
    case 'sttInstallLocal': return JSON.stringify({ ok: false, output: 'mock mode' });
    case 'getSttConfig': return JSON.stringify({ mode: 'api', language: 'zh', localModel: 'base', apiBaseUrl: '', apiKey: '', apiModel: 'whisper-1' });
    case 'saveSttConfig': return JSON.stringify({ ok: true });
    case 'sttTranscribe': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'ttsSynthesize': return JSON.stringify({ ok: false, error: 'backend not connected' });
    case 'ttsStreamSynthesize': return JSON.stringify({ ok: false, error: 'backend not connected' });
    case 'ttsStreamFinish': return JSON.stringify({ ok: true, accepted: false, empty: true });
    case 'ttsStreamCancel': return JSON.stringify({ ok: true, cancelled: 0 });
    case 'sttRefine': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'sttStreamStart': return JSON.stringify({ ok: false, error: 'mock mode' });
    case 'sttStreamStop': return JSON.stringify({ ok: false, error: 'mock mode' });
    default: return null;
  }
}
