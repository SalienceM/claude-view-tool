import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  api, getExecutors, getHomeExecKey, onExecStatus,
  type BackendImportPreviewItem, type ExecutorInfo, type PoeAccountOverview,
} from '../api';
import { sessionsForBackendExecutor } from '../utils/backendManagement';

// 注入删除按钮 hover 样式（只执行一次）
if (typeof document !== 'undefined' && !document.getElementById('bm-delete-btn-style')) {
  const s = document.createElement('style');
  s.id = 'bm-delete-btn-style';
  s.textContent = '.bm-delete-btn:hover { color: #f85149 !important; }';
  document.head.appendChild(s);
}

// Global variable to store selected target backend for migration
declare global {
  interface Window {
    __targetBackendForMigration?: string;
  }
}

interface BackendConfig {
  id: string;
  type: string;
  label: string;
  enabled?: boolean;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  workingDir?: string;
  allowedTools?: string[];
  skipPermissions?: boolean;
  env?: Record<string, string>;
  extraHeaders?: Record<string, string>;
  mcpServers?: Record<string, any>;
  pinned?: boolean;  // 固定后端，不可删除
  cliPath?: string;  // qwen-code-cli: 自定义 CLI 路径
  qwenContextWindowSize?: number;
  qwenMaxOutputTokens?: number;
}

const POE_API_BASE_URL = 'https://api.poe.com/v1';

function isPoeBackendConfig(config: Pick<BackendConfig, 'type' | 'baseUrl'>): boolean {
  if (config.type !== 'openai-compatible') return false;
  try {
    const url = new URL(String(config.baseUrl || '').trim());
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'api.poe.com'
      && url.pathname.replace(/\/+$/, '') === '/v1';
  } catch {
    return false;
  }
}

function formatPoeTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '时间未知';
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

const OFFICIAL_BACKEND_ID = 'official-claude';
const OFFICIAL_CODEX_BACKEND_ID = 'official-codex';
const CODEX_DEFAULT_MODEL = 'gpt-5.6-sol';
const CODEX_RECOMMENDED_MODELS = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra（最强端到端复杂任务）' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol（推荐，复杂编码/推理）' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra（日常工作均衡）' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna（更快/更省）' },
  { id: 'gpt-5.5', label: 'GPT-5.5（上一代旗舰）' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
];
const DASHSCOPE_IMAGE_MODELS = [
  { id: 'qwen-image-3.0-pro', label: 'Qwen Image 3.0 Pro（质量优先）' },
  { id: 'qwen-image-3.0', label: 'Qwen Image 3.0（质量/速度均衡）' },
  { id: 'wanx2.1-t2i-turbo', label: 'Wanx 2.1 Turbo' },
  { id: 'wanx2.1-t2i-plus', label: 'Wanx 2.1 Plus' },
];

function isQwenImage3Model(model: string | undefined): boolean {
  return String(model || '').trim().toLowerCase().startsWith('qwen-image-3.0');
}

const DEFAULT_TOOLS = ['Read', 'Edit', 'Bash', 'Glob', 'Grep', 'Write'];
const ALL_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

interface BackendManagerProps {
  isOpen: boolean;
  onClose: () => void;
  backends: BackendConfig[];
  targetExecKey: string;
  loading?: boolean;
  loadError?: string;
  onTargetExecChange: (execKey: string) => void;
  onRefresh: () => void | Promise<void>;
  onSaveBackend: (config: BackendConfig, execKey: string) => Promise<void>;
  onDeleteBackend: (
    id: string,
    execKey: string,
    dependentSessions?: any[],
    targetBackendId?: string,
  ) => Promise<void>;
  sessions?: any[];
}

type BackendTransferState =
  | {
      mode: 'export';
      selectedIds: Set<string>;
    }
  | {
      mode: 'import';
      fileName: string;
      content: string;
      items: BackendImportPreviewItem[];
      selectedIds: Set<string>;
      conflictPolicy: 'overwrite' | 'skip';
    };

function _cleanHeaders(h: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  Object.entries(h).forEach(([k, v]) => { if (k.trim() && v.trim()) out[k.trim()] = v.trim(); });
  return Object.keys(out).length > 0 ? out : undefined;
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: 'var(--ui-field-padding, 10px 12px)',
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)', borderRadius: 6,
  color: 'var(--theme-text)', fontSize: 13, outline: 'none',
  boxSizing: 'border-box',
};

// MCP Servers editor component
const MCP_PLACEHOLDER = `{
  "puppeteer": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-puppeteer"]
  },
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  }
}`;

const McpServersEditor: React.FC<{
  mcpServers: Record<string, any> | undefined;
  onChange: (v: Record<string, any> | undefined) => void;
}> = ({ mcpServers, onChange }) => {
  const [text, setText] = React.useState(() =>
    mcpServers && Object.keys(mcpServers).length > 0
      ? JSON.stringify(mcpServers, null, 2)
      : ''
  );
  const [jsonError, setJsonError] = React.useState<string | null>(null);

  const handleChange = (val: string) => {
    setText(val);
    if (!val.trim()) {
      setJsonError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(val);
      setJsonError(null);
      onChange(parsed);
    } catch (e: any) {
      setJsonError(e.message);
    }
  };

  return (
    <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text)', display: 'block', marginBottom: 6 }}>
        MCP Servers（可选）
      </label>
      <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 10px 0', lineHeight: 1.6 }}>
        配置 MCP (Model Context Protocol) 工具服务器。
        Claude 会自动使用这些服务器提供的工具（如 Puppeteer 截图、文件系统访问等）。
        留空则不启用 MCP。
      </p>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 4 }}>
          格式：JSON 对象，key 为服务器名称，value 为配置
        </div>
        <textarea
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          style={{
            ...inputStyle,
            height: 140,
            resize: 'vertical',
            fontFamily: 'monospace',
            fontSize: 12,
            ...(jsonError ? { borderColor: 'rgba(239,68,68,0.6)' } : {}),
          }}
          placeholder={MCP_PLACEHOLDER}
          spellCheck={false}
        />
        {jsonError && (
          <p style={{ fontSize: 11, color: 'rgba(239,68,68,0.9)', margin: '4px 0 0 0' }}>
            JSON 格式错误：{jsonError}
          </p>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', lineHeight: 1.6 }}>
        示例：Puppeteer 截图 → <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>npx -y @modelcontextprotocol/server-puppeteer</code>
      </div>
    </div>
  );
};

export const BackendManager: React.FC<BackendManagerProps> = ({
  isOpen,
  onClose,
  backends,
  targetExecKey,
  loading = false,
  loadError = '',
  onTargetExecChange,
  onRefresh,
  onSaveBackend,
  onDeleteBackend,
  sessions = [],
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editingBackend, setEditingBackend] = useState<BackendConfig | null>(null);
  const [copySourceLabel, setCopySourceLabel] = useState<string | null>(null);
  const [formData, setFormData] = useState<BackendConfig>({
    id: '',
    type: 'claude-agent-sdk',
    label: '',
    enabled: true,
    model: '',
    baseUrl: '',
    apiKey: '',
    env: {},
  });
  const [loginLaunching, setLoginLaunching] = useState(false);
  const [loginMsg, setLoginMsg] = useState<string | null>(null);
  const [modelLaunching, setModelLaunching] = useState(false);
  const [modelMsg, setModelMsg] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string>('');
  const [backendToDelete, setBackendToDelete] = useState<BackendConfig | null>(null);
  const [dependentSessions, setDependentSessions] = useState<any[]>([]);
  const [executors, setExecutors] = useState<ExecutorInfo[]>(() => getExecutors());
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationMessage, setOperationMessage] = useState<{
    kind: 'ok' | 'error'; text: string;
  } | null>(null);
  const [transferState, setTransferState] = useState<BackendTransferState | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [poeOverview, setPoeOverview] = useState<PoeAccountOverview | null>(null);
  const [poeLoading, setPoeLoading] = useState(false);
  const [poeError, setPoeError] = useState('');
  const [poeQuery, setPoeQuery] = useState('');
  const poeRequestRef = useRef(0);

  // MCP tab state
  const [activeTab, setActiveTab] = useState<'backends' | 'mcp'>('backends');
  const [mcpServers, setMcpServers] = useState<Record<string, any>>({});
  const [mcpLoading, setMcpLoading] = useState(false);
  const [isEditingMcp, setIsEditingMcp] = useState(false);
  const [editingMcpName, setEditingMcpName] = useState<string | null>(null);
  const [mcpForm, setMcpForm] = useState({ name: '', command: 'npx', args: '', env: '' });
  const [mcpSaveMsg, setMcpSaveMsg] = useState<string | null>(null);

  const selectedExecutor = executors.find((item) => item.key === targetExecKey);
  const isPoeBackend = isPoeBackendConfig(formData);
  const nodeSessions = sessionsForBackendExecutor(
    sessions,
    targetExecKey,
    getHomeExecKey(),
  );
  const normalizedPoeQuery = poeQuery.trim().toLowerCase();
  const poeVisibleModels = (poeOverview?.models || [])
    .filter((item) => !normalizedPoeQuery
      || item.id.toLowerCase().includes(normalizedPoeQuery)
      || item.description.toLowerCase().includes(normalizedPoeQuery))
    .slice(0, 12);
  const poeRecentCount = (poeOverview?.models || []).filter(
    (item) => item.createdAt >= Date.now() - 30 * 86_400_000,
  ).length;

  useEffect(() => {
    if (!isOpen) return;
    const refresh = () => setExecutors(getExecutors());
    refresh();
    return onExecStatus(refresh);
  }, [isOpen]);

  // 切换物理节点时，任何尚未提交的编辑/删除上下文都必须清掉，防止把 A 节点
  // 表单保存到 B 节点。MCP 列表也由下面的 effect 按节点重新加载。
  useEffect(() => {
    setIsEditing(false);
    setEditingBackend(null);
    setCopySourceLabel(null);
    setBackendToDelete(null);
    setDependentSessions([]);
    setIsEditingMcp(false);
    setEditingMcpName(null);
    setOperationMessage(null);
    setTransferState(null);
    if (importFileInputRef.current) importFileInputRef.current.value = '';
    window.__targetBackendForMigration = undefined;
    setPoeOverview(null);
    setPoeLoading(false);
    setPoeError('');
    setPoeQuery('');
    poeRequestRef.current += 1;
  }, [targetExecKey]);

  const refreshPoeOverview = useCallback(async () => {
    const requestId = ++poeRequestRef.current;
    setPoeLoading(true);
    setPoeError('');
    try {
      const result = await api.poeAccountOverview(formData.apiKey || '', targetExecKey);
      if (requestId !== poeRequestRef.current) return;
      setPoeOverview(result);
      if (result.status === 'error' && result.models.length === 0 && result.currentPointBalance == null) {
        setPoeError(result.message || result.catalogError || result.balanceError || '无法读取 Poe 状态');
      }
    } catch (error: any) {
      if (requestId !== poeRequestRef.current) return;
      setPoeError(error?.message || '无法读取 Poe 状态');
    } finally {
      if (requestId === poeRequestRef.current) setPoeLoading(false);
    }
  }, [formData.apiKey, targetExecKey]);

  // 进入一个 Poe 配置时实时拉取一次。编辑 Key 不会逐字触发；填写完成后可手动刷新余额。
  const poeFormIdentity = `${targetExecKey}:${formData.id}:${isPoeBackend ? 'poe' : 'other'}`;
  useEffect(() => {
    if (!isEditing || !isPoeBackend) {
      poeRequestRef.current += 1;
      setPoeOverview(null);
      setPoeLoading(false);
      setPoeError('');
      setPoeQuery('');
      return;
    }
    setPoeOverview(null);
    setPoeError('');
    setPoeQuery('');
    void refreshPoeOverview();
    // API Key 刻意不属于自动刷新身份，避免输入时连续请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, isPoeBackend, poeFormIdentity]);

  const toggleTransferSelection = useCallback((id: string, checked: boolean) => {
    setTransferState((current) => {
      if (!current) return current;
      const selectedIds = new Set(current.selectedIds);
      if (checked) selectedIds.add(id);
      else selectedIds.delete(id);
      return { ...current, selectedIds };
    });
  }, []);

  const handleStartExport = useCallback(() => {
    setOperationMessage(null);
    setTransferState({
      mode: 'export',
      selectedIds: new Set(backends.map((backend) => backend.id)),
    });
  }, [backends]);

  const handleExportSelected = useCallback(async () => {
    if (transferState?.mode !== 'export' || transferState.selectedIds.size === 0) return;
    setOperationBusy(true);
    setOperationMessage(null);
    try {
      const result = await api.exportBackends([...transferState.selectedIds], targetExecKey);
      if (result.status !== 'ok' || !result.content) {
        throw new Error(result.message || '导出执行端没有返回配置文件');
      }
      const fileName = result.fileName || 'agent-with-u-backends.json';
      const saved = await api.saveBackendExportFile(fileName, result.content);
      if (saved.status === 'cancelled') return;
      if (saved.status === 'unsupported') {
        const blob = new Blob([result.content], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setTransferState(null);
      setOperationMessage({
        kind: 'ok',
        text: saved.status === 'saved'
          ? `已从 ${selectedExecutor?.label || targetExecKey} 导出 ${result.count || transferState.selectedIds.size} 个 Backend → ${saved.path}`
          : `已从 ${selectedExecutor?.label || targetExecKey} 导出 ${result.count || transferState.selectedIds.size} 个 Backend；浏览器下载文件：${fileName}`,
      });
    } catch (error: any) {
      setOperationMessage({ kind: 'error', text: error?.message || 'Backend 导出失败' });
    } finally {
      setOperationBusy(false);
    }
  }, [selectedExecutor?.label, targetExecKey, transferState]);

  const handleImportFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setOperationBusy(true);
    setOperationMessage(null);
    try {
      if (file.size > 4 * 1024 * 1024) {
        throw new Error('Backend 配置文件不能超过 4 MiB');
      }
      const content = await file.text();
      const preview = await api.previewBackendImport(content, targetExecKey);
      if (preview.status !== 'ok') {
        throw new Error(preview.message || '无法解析 Backend 配置文件');
      }
      setTransferState({
        mode: 'import',
        fileName: file.name,
        content,
        items: preview.items || [],
        selectedIds: new Set((preview.items || []).filter((item) => !item.protected).map((item) => item.id)),
        conflictPolicy: 'skip',
      });
    } catch (error: any) {
      setTransferState(null);
      setOperationMessage({ kind: 'error', text: error?.message || 'Backend 导入预览失败' });
    } finally {
      setOperationBusy(false);
    }
  }, [targetExecKey]);

  const handleImportSelected = useCallback(async () => {
    if (transferState?.mode !== 'import' || transferState.selectedIds.size === 0) return;
    setOperationBusy(true);
    setOperationMessage(null);
    try {
      const result = await api.importBackends(
        transferState.content,
        [...transferState.selectedIds],
        transferState.conflictPolicy,
        targetExecKey,
      );
      if (result.status !== 'ok') throw new Error(result.message || 'Backend 导入失败');
      await onRefresh();
      setTransferState(null);
      const details = [
        result.added ? `新增 ${result.added}` : '',
        result.overwritten ? `覆盖 ${result.overwritten}` : '',
        result.skipped ? `跳过 ${result.skipped}` : '',
        result.protected ? `受保护 ${result.protected}` : '',
      ].filter(Boolean).join('，');
      setOperationMessage({
        kind: 'ok',
        text: `已导入 ${result.imported || 0} 个 Backend${details ? `（${details}）` : ''}；其他现有配置保持不变`,
      });
    } catch (error: any) {
      setOperationMessage({ kind: 'error', text: error?.message || 'Backend 导入失败' });
    } finally {
      setOperationBusy(false);
    }
  }, [onRefresh, targetExecKey, transferState]);

  const handleNewBackend = useCallback(() => {
    setFormData({
      id: `backend-${Date.now()}`,
      type: 'claude-agent-sdk',
      label: '',
      enabled: true,
      model: '',
      baseUrl: '',
      apiKey: '',
      env: {},
      allowedTools: [...DEFAULT_TOOLS],
    });
    setEditingBackend(null);
    setCopySourceLabel(null);
    setIsEditing(true);
  }, []);

  const handleEditBackend = useCallback((backend: BackendConfig) => {
    setFormData({
      ...backend,
      env: { ...(backend.env || {}) },
      extraHeaders: backend.extraHeaders ? { ...backend.extraHeaders } : undefined,
      allowedTools: backend.allowedTools ? [...backend.allowedTools] : undefined,
      mcpServers: backend.mcpServers
        ? JSON.parse(JSON.stringify(backend.mcpServers))
        : undefined,
    });
    setEditingBackend(backend);
    setCopySourceLabel(null);
    setLoginMsg(null);
    setModelMsg(null);
    setIsEditing(true);
    // 打开官方后端编辑时，读取当前模型
    if (backend.id === OFFICIAL_BACKEND_ID) {
      api.getClaudeSettings(targetExecKey).then(s => setCurrentModel(s.model || ''));
    }
  }, [targetExecKey]);

  const handleCopyBackend = useCallback((backend: BackendConfig) => {
    const usedIds = new Set(backends.map((item) => item.id));
    const idRoot = (backend.id || 'backend').replace(/-copy(?:-\d+)?$/i, '');
    let nextId = `${idRoot}-copy`;
    let suffix = 2;
    while (usedIds.has(nextId)) {
      nextId = `${idRoot}-copy-${suffix}`;
      suffix += 1;
    }

    const usedLabels = new Set(backends.map((item) => item.label));
    const labelRoot = (backend.label || backend.id || 'Backend')
      .replace(/ 副本(?: \(\d+\))?$/, '');
    let nextLabel = `${labelRoot} 副本`;
    let labelSuffix = 2;
    while (usedLabels.has(nextLabel)) {
      nextLabel = `${labelRoot} 副本 (${labelSuffix})`;
      labelSuffix += 1;
    }

    setFormData({
      ...backend,
      id: nextId,
      label: nextLabel,
      pinned: false,
      env: { ...(backend.env || {}) },
      extraHeaders: backend.extraHeaders ? { ...backend.extraHeaders } : undefined,
      allowedTools: backend.allowedTools ? [...backend.allowedTools] : undefined,
      mcpServers: backend.mcpServers
        ? JSON.parse(JSON.stringify(backend.mcpServers))
        : undefined,
    });
    setEditingBackend(null);
    setCopySourceLabel(backend.label || backend.id);
    setLoginMsg(null);
    setModelMsg(null);
    setOperationMessage(null);
    setIsEditing(true);
    window.requestAnimationFrame(() => panelRef.current?.scrollTo({ top: 0, behavior: 'smooth' }));
  }, [backends]);

  const handleSave = useCallback(async () => {
    const normalizedId = formData.id.trim();
    const normalizedLabel = formData.label.trim();
    if (!normalizedId || !normalizedLabel) {
      setOperationMessage({ kind: 'error', text: 'Backend ID 和显示名称不能为空' });
      return;
    }
    const idConflict = backends.some((backend) => (
      backend.id === normalizedId && backend.id !== editingBackend?.id
    ));
    if (idConflict) {
      setOperationMessage({ kind: 'error', text: `Backend ID「${normalizedId}」已存在，请换一个 ID` });
      return;
    }
    const saved: BackendConfig = {
      id: normalizedId,
      type: formData.type,
      label: normalizedLabel,
      enabled: formData.enabled !== false,
    };

    if (formData.pinned) {
      // 固定后端：只保存 env、skipPermissions、allowedTools、mcpServers
      const cleanedEnv: Record<string, string> = {};
      Object.entries(formData.env || {}).forEach(([k, v]) => {
        if (v && v.trim()) cleanedEnv[k] = v.trim();
      });
      if (Object.keys(cleanedEnv).length > 0) saved.env = cleanedEnv;
      saved.skipPermissions = formData.skipPermissions !== false;
      if (formData.type === 'codex-office') {
        if (formData.model?.trim()) saved.model = formData.model.trim();
        if (formData.baseUrl?.trim()) saved.baseUrl = formData.baseUrl.trim();
        if (formData.apiKey?.trim()) saved.apiKey = formData.apiKey.trim();
        if (formData.cliPath?.trim()) saved.cliPath = formData.cliPath.trim();
      }
      if (formData.allowedTools?.length) saved.allowedTools = formData.allowedTools;
      if (formData.mcpServers && Object.keys(formData.mcpServers).length > 0) saved.mcpServers = formData.mcpServers;
    } else if (formData.type === 'claude-agent-sdk') {
      // Only env vars + skipPermissions + allowedTools + mcpServers matter
      const cleanedEnv: Record<string, string> = {};
      Object.entries(formData.env || {}).forEach(([k, v]) => {
        if (v && v.trim()) cleanedEnv[k] = v.trim();
      });
      if (Object.keys(cleanedEnv).length > 0) saved.env = cleanedEnv;
      saved.skipPermissions = formData.skipPermissions !== false;
      if (formData.allowedTools?.length) saved.allowedTools = formData.allowedTools;
      if (formData.mcpServers && Object.keys(formData.mcpServers).length > 0) saved.mcpServers = formData.mcpServers;
    } else if (formData.type === 'claude-code-official') {
      const cleanedEnv: Record<string, string> = {};
      Object.entries(formData.env || {}).forEach(([k, v]) => {
        if (v && v.trim()) cleanedEnv[k] = v.trim();
      });
      if (Object.keys(cleanedEnv).length > 0) saved.env = cleanedEnv;
      if (formData.model?.trim()) saved.model = formData.model.trim();
      saved.skipPermissions = formData.skipPermissions !== false;
      if (formData.allowedTools?.length) saved.allowedTools = formData.allowedTools;
      if (formData.mcpServers && Object.keys(formData.mcpServers).length > 0) saved.mcpServers = formData.mcpServers;
    } else if (formData.type === 'qwen-code-cli') {
      // CLI path, model, env (DASHSCOPE_API_KEY, provider, etc.), allowedTools, skipPermissions
      const cleanedEnv: Record<string, string> = {};
      Object.entries(formData.env || {}).forEach(([k, v]) => {
        if (v && v.trim()) cleanedEnv[k] = v.trim();
      });
      if (Object.keys(cleanedEnv).length > 0) saved.env = cleanedEnv;
      if (formData.model?.trim()) saved.model = formData.model.trim();
      saved.skipPermissions = formData.skipPermissions !== false;
      if (formData.allowedTools?.length) saved.allowedTools = formData.allowedTools;
      if (formData.mcpServers && Object.keys(formData.mcpServers).length > 0) saved.mcpServers = formData.mcpServers;
      // cliPath stored as a top-level field
      if (formData.cliPath?.trim()) (saved as any).cliPath = formData.cliPath.trim();
      const contextWindow = formData.qwenContextWindowSize;
      const maxOutput = formData.qwenMaxOutputTokens;
      if (contextWindow != null && (!Number.isInteger(contextWindow) || contextWindow <= 0)) {
        setOperationMessage({ kind: 'error', text: 'Qwen 上下文窗口必须是大于 0 的整数' });
        return;
      }
      if (maxOutput != null && (!Number.isInteger(maxOutput) || maxOutput <= 0)) {
        setOperationMessage({ kind: 'error', text: 'Qwen 最大输出 Tokens 必须是大于 0 的整数' });
        return;
      }
      const effectiveMaxOutput = maxOutput ?? 32000;
      if (contextWindow != null && effectiveMaxOutput >= contextWindow) {
        setOperationMessage({
          kind: 'error',
          text: `最大输出 Tokens（${effectiveMaxOutput.toLocaleString()}）必须小于上下文窗口（${contextWindow.toLocaleString()}）`,
        });
        return;
      }
      if (contextWindow != null) saved.qwenContextWindowSize = contextWindow;
      if (maxOutput != null) saved.qwenMaxOutputTokens = maxOutput;
    } else if (formData.type === 'codex-office') {
      const cleanedEnv: Record<string, string> = {};
      Object.entries(formData.env || {}).forEach(([k, v]) => {
        if (v && v.trim()) cleanedEnv[k] = v.trim();
      });
      if (Object.keys(cleanedEnv).length > 0) saved.env = cleanedEnv;
      if (formData.model?.trim()) saved.model = formData.model.trim();
      if (formData.baseUrl?.trim()) saved.baseUrl = formData.baseUrl.trim();
      if (formData.apiKey?.trim()) saved.apiKey = formData.apiKey.trim();
      saved.skipPermissions = formData.skipPermissions !== false;
      if (formData.allowedTools?.length) saved.allowedTools = formData.allowedTools;
      if (formData.cliPath?.trim()) saved.cliPath = formData.cliPath.trim();
      if (formData.mcpServers && Object.keys(formData.mcpServers).length > 0) saved.mcpServers = formData.mcpServers;
    } else if (formData.type === 'openai-compatible') {
      // base_url, api_key, model, extra_headers
      if (formData.baseUrl?.trim()) saved.baseUrl = formData.baseUrl.trim();
      if (formData.apiKey?.trim()) saved.apiKey = formData.apiKey.trim();
      if (formData.model?.trim()) saved.model = formData.model.trim();
      const headers = _cleanHeaders(formData.extraHeaders);
      if (headers) saved.extraHeaders = headers;
    } else if (formData.type === 'anthropic-api') {
      // api_key, base_url, model, extra_headers
      if (formData.apiKey?.trim()) saved.apiKey = formData.apiKey.trim();
      if (formData.model?.trim()) saved.model = formData.model.trim();
      if (formData.baseUrl?.trim()) saved.baseUrl = formData.baseUrl.trim();
      const headers = _cleanHeaders(formData.extraHeaders);
      if (headers) saved.extraHeaders = headers;
    } else if (formData.type === 'dashscope-image') {
      // api_key, model, base_url, env (SIZE, NEGATIVE_PROMPT, etc.)
      if (formData.apiKey?.trim()) saved.apiKey = formData.apiKey.trim();
      if (formData.model?.trim()) saved.model = formData.model.trim();
      if (formData.baseUrl?.trim()) saved.baseUrl = formData.baseUrl.trim();
      const cleanedEnv: Record<string, string> = {};
      Object.entries(formData.env || {}).forEach(([k, v]) => {
        if (v && v.trim()) cleanedEnv[k] = v.trim();
      });
      if (Object.keys(cleanedEnv).length > 0) saved.env = cleanedEnv;
    }

    setOperationBusy(true);
    setOperationMessage(null);
    try {
      await onSaveBackend(saved, targetExecKey);
      setIsEditing(false);
      setEditingBackend(null);
      const copiedFrom = copySourceLabel;
      setCopySourceLabel(null);
      setOperationMessage({
        kind: 'ok',
        text: copiedFrom
          ? `已基于「${copiedFrom}」创建「${saved.label}」，并保存到「${selectedExecutor?.label || targetExecKey}」`
          : `已保存到「${selectedExecutor?.label || targetExecKey}」`,
      });
    } catch (error: any) {
      setOperationMessage({
        kind: 'error',
        text: error?.message || '保存 Backend 失败',
      });
    } finally {
      setOperationBusy(false);
    }
  }, [backends, copySourceLabel, editingBackend?.id, formData, onSaveBackend, selectedExecutor?.label, targetExecKey]);

  const handleEnvChange = useCallback((key: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      env: {
        ...prev.env,
        [key]: value,
      },
    }));
  }, []);

  const handleOpenLoginTerminal = useCallback(async () => {
    setLoginLaunching(true);
    setLoginMsg(null);
    try {
      const res = await api.openLoginTerminal(formData.id, targetExecKey);
      if (res.status === 'error') {
        setLoginMsg(res.message || '打开失败');
      } else {
        setLoginMsg(`已在「${selectedExecutor?.label || targetExecKey}」打开终端，请在该机器完成登录。`);
      }
    } catch (e: any) {
      setLoginMsg(e?.message || '打开失败');
    } finally {
      setLoginLaunching(false);
    }
  }, [formData.id, selectedExecutor?.label, targetExecKey]);

  const handleOpenModelTerminal = useCallback(async () => {
    setModelLaunching(true);
    setModelMsg(null);
    try {
      const res = await api.openModelTerminal(formData.id, targetExecKey);
      if (res.status === 'error') {
        setModelMsg(res.message || '打开失败');
      } else {
        setModelMsg(`已在「${selectedExecutor?.label || targetExecKey}」打开终端；切换模型后重启该执行节点生效。`);
      }
    } catch (e: any) {
      setModelMsg(e?.message || '打开失败');
    } finally {
      setModelLaunching(false);
    }
  }, [formData.id, selectedExecutor?.label, targetExecKey]);

  const handleDeleteClick = useCallback((backend: BackendConfig) => {
    // Backend ID 只在当前物理节点内有意义；不能把其它节点上同名 Backend 的
    // Session 误判为依赖，更不能跨节点迁移。
    const dependents = nodeSessions.filter(s => s.backendId === backend.id);

    // Always show confirmation dialog (two-step confirmation)
    setDependentSessions(dependents);
    setBackendToDelete(backend);
  }, [nodeSessions]);

  const confirmDeleteBackend = useCallback(async () => {
    if (!backendToDelete) return;
    let targetBackendId: string | undefined;
    if (dependentSessions.length > 0) {
      targetBackendId = window.__targetBackendForMigration;
      if (!targetBackendId || targetBackendId === backendToDelete.id) {
        alert('请选择一个有效的目标后端');
        return;
      }
    }
    setOperationBusy(true);
    setOperationMessage(null);
    try {
      await onDeleteBackend(
        backendToDelete.id,
        targetExecKey,
        dependentSessions,
        targetBackendId,
      );
      setOperationMessage({
        kind: 'ok',
        text: `已从「${selectedExecutor?.label || targetExecKey}」删除 Backend`,
      });
      setBackendToDelete(null);
      setDependentSessions([]);
      window.__targetBackendForMigration = undefined;
    } catch (error: any) {
      setOperationMessage({
        kind: 'error',
        text: error?.message || '删除 Backend 失败',
      });
    } finally {
      setOperationBusy(false);
    }
  }, [backendToDelete, dependentSessions, onDeleteBackend, selectedExecutor?.label, targetExecKey]);

  // Load MCP servers when dialog opens
  useEffect(() => {
    let cancelled = false;
    if (isOpen) {
      setMcpLoading(true);
      setMcpServers({});
      api.getMcpServers(targetExecKey).then(servers => {
        if (cancelled) return;
        setMcpServers(servers);
        setMcpLoading(false);
      }).catch((error: any) => {
        if (cancelled) return;
        setMcpLoading(false);
        setOperationMessage({
          kind: 'error',
          text: error?.message || '无法读取该执行节点的 MCP 配置',
        });
      });
    }
    return () => { cancelled = true; };
  }, [isOpen, targetExecKey]);

  const handleNewMcp = useCallback(() => {
    setMcpForm({ name: '', command: 'npx', args: '', env: '' });
    setEditingMcpName(null);
    setIsEditingMcp(true);
  }, []);

  const handleEditMcp = useCallback((name: string, srv: any) => {
    const argsStr = (srv.args || []).join('\n');
    const envStr = Object.entries(srv.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    setMcpForm({ name, command: srv.command || '', args: argsStr, env: envStr });
    setEditingMcpName(name);
    setIsEditingMcp(true);
  }, []);

  const handleSaveMcp = useCallback(async () => {
    if (!mcpForm.name.trim() || !mcpForm.command.trim()) return;
    const args = mcpForm.args.split('\n').map(s => s.trim()).filter(Boolean);
    const env: Record<string, string> = {};
    mcpForm.env.split('\n').forEach(line => {
      const idx = line.indexOf('=');
      if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    const srv: any = { command: mcpForm.command.trim() };
    if (args.length > 0) srv.args = args;
    if (Object.keys(env).length > 0) srv.env = env;
    const updated = { ...mcpServers, [mcpForm.name.trim()]: srv };
    setOperationBusy(true);
    setOperationMessage(null);
    try {
      const result = await api.saveMcpServers(updated, targetExecKey);
      if (result.status !== 'ok') throw new Error(result.message || '保存 MCP 配置失败');
      setMcpServers(updated);
      setIsEditingMcp(false);
      setMcpSaveMsg('已保存');
      setTimeout(() => setMcpSaveMsg(null), 2000);
    } catch (error: any) {
      setOperationMessage({ kind: 'error', text: error?.message || '保存 MCP 配置失败' });
    } finally {
      setOperationBusy(false);
    }
  }, [mcpForm, mcpServers, targetExecKey]);

  const handleDeleteMcp = useCallback(async (name: string) => {
    const updated = { ...mcpServers };
    delete updated[name];
    setOperationBusy(true);
    setOperationMessage(null);
    try {
      const result = await api.saveMcpServers(updated, targetExecKey);
      if (result.status !== 'ok') throw new Error(result.message || '删除 MCP 配置失败');
      setMcpServers(updated);
      setMcpSaveMsg('已删除');
      setTimeout(() => setMcpSaveMsg(null), 2000);
    } catch (error: any) {
      setOperationMessage({ kind: 'error', text: error?.message || '删除 MCP 配置失败' });
    } finally {
      setOperationBusy(false);
    }
  }, [mcpServers, targetExecKey]);

  if (!isOpen) return null;

  return (
    <div style={overlayStyle}>
      <div ref={panelRef} style={panelStyle} onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--theme-text)' }}>
            {activeTab === 'mcp'
              ? (isEditingMcp ? (editingMcpName ? `编辑 ${editingMcpName}` : '添加 MCP 服务器') : 'MCP 服务器')
              : (copySourceLabel ? `复制 Backend · ${copySourceLabel}` : editingBackend ? 'Edit Backend' : 'Backend Manager')
            }
          </h2>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        {/* Backend/MCP 均属于物理执行节点，不跟随当前聊天会话隐式切换。 */}
        <div style={{
          marginBottom: 14,
          padding: '10px 12px',
          border: '1px solid var(--theme-border)',
          borderRadius: 8,
          background: 'var(--theme-input-bg)',
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text)', flexShrink: 0 }}>
              管理执行节点
            </label>
            <select
              aria-label="管理执行节点"
              value={targetExecKey}
              disabled={operationBusy || isEditing || isEditingMcp || !!backendToDelete || !!transferState}
              onChange={(event) => onTargetExecChange(event.target.value)}
              style={{ ...selectStyle, flex: 1, minWidth: 0 }}
            >
              {!executors.some((item) => item.key === targetExecKey) && (
                <option value={targetExecKey}>{targetExecKey}（未连接）</option>
              )}
              {executors.map((executor) => (
                <option key={executor.key} value={executor.key} disabled={!executor.connected}>
                  {executor.label}{executor.isHome ? ' · 默认' : ''}{executor.connected ? '' : ' · 离线'}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => { setOperationMessage(null); void onRefresh(); }}
              disabled={loading || operationBusy}
              style={{ ...cancelBtnStyle, padding: '7px 10px', flexShrink: 0 }}
              title="重新读取所选节点的 Backend 配置"
            >
              {loading ? '读取中…' : '刷新'}
            </button>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5, color: 'var(--theme-text-muted)' }}>
            配置只写入所选节点。远端节点需先在“连接 → 可分配执行节点”中加入并保持在线。
          </div>
        </div>

        {(loadError || operationMessage) && (
          <div style={{
            marginBottom: 12,
            padding: '8px 10px',
            borderRadius: 7,
            fontSize: 12,
            lineHeight: 1.5,
            color: loadError || operationMessage?.kind === 'error'
              ? 'rgba(248,113,113,0.98)'
              : 'rgba(74,222,128,0.98)',
            background: loadError || operationMessage?.kind === 'error'
              ? 'rgba(239,68,68,0.1)'
              : 'rgba(34,197,94,0.1)',
            border: `1px solid ${loadError || operationMessage?.kind === 'error'
              ? 'rgba(239,68,68,0.25)'
              : 'rgba(34,197,94,0.25)'}`,
          }}>
            {loadError || operationMessage?.text}
          </div>
        )}

        {/* Tab 导航 */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--theme-border)', paddingBottom: 10 }}>
          {(['backends', 'mcp'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab);
                setIsEditing(false);
                setEditingBackend(null);
                setCopySourceLabel(null);
                setIsEditingMcp(false);
              }}
              style={{
                padding: '5px 14px', borderRadius: '6px 6px 0 0', fontSize: 13, cursor: 'pointer',
                border: 'none', background: activeTab === tab ? 'rgba(99,102,241,0.2)' : 'transparent',
                color: activeTab === tab ? 'rgba(165,168,255,0.95)' : 'var(--theme-text-muted)',
                fontWeight: activeTab === tab ? 600 : 400, transition: 'all 0.15s',
              }}
            >
              {tab === 'backends' ? '后端' : `MCP 服务器${Object.keys(mcpServers).length > 0 ? ` (${Object.keys(mcpServers).length})` : ''}`}
            </button>
          ))}
        </div>

        {activeTab === 'backends' && (!isEditing ? (
          // Backend 列表视图
          <>
            <div style={{ marginBottom: 16 }}>
              {loading ? (
                <div style={{ color: 'var(--theme-text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>
                  正在读取所选执行节点…
                </div>
              ) : loadError ? (
                <div style={{ color: 'var(--theme-text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>
                  无法显示该节点的 Backend，请恢复连接后刷新
                </div>
              ) : backends.length === 0 ? (
                <div style={{ color: 'var(--theme-text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>
                  No backends configured
                </div>
              ) : (
                backends.map((backend) => (
                  <div
                    key={backend.id}
                    style={{
                      ...backendItemStyle,
                      ...(backend.pinned ? { borderLeft: '2px solid rgba(99,102,241,0.6)' } : {}),
                    }}
                    onClick={() => handleEditBackend(backend)}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500, color: 'var(--theme-text)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {backend.pinned && <span style={{ fontSize: 10, color: 'rgba(165,168,255,0.8)' }}>📌</span>}
                        {backend.label}
                        <span style={{
                          fontSize: 10,
                          padding: '1px 6px',
                          borderRadius: 999,
                          color: backend.enabled === false ? 'var(--theme-text-muted)' : 'rgba(74,222,128,0.95)',
                          background: backend.enabled === false ? 'rgba(148,163,184,0.12)' : 'rgba(34,197,94,0.12)',
                        }}>
                          {backend.enabled === false ? '已停用' : '已启用'}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
                        {backend.type}
                        {backend.type === 'claude-agent-sdk' && backend.env?.ANTHROPIC_MODEL && (
                          <span> · {backend.env.ANTHROPIC_MODEL}</span>
                        )}
                        {backend.type === 'claude-agent-sdk' && backend.env?.ANTHROPIC_AUTH_TOKEN && (
                          <span> · Auth</span>
                        )}
                        {backend.type === 'claude-code-official' && (
                          <span> · 官方账户{backend.env?.HTTPS_PROXY ? ' · 代理✓' : ' · ⚠️无代理'}</span>
                        )}
                        {backend.type === 'qwen-code-cli' && (
                          <span>
                            {' · Qwen CLI'}
                            {backend.model ? ` · 🤖${backend.model}` : ''}
                            {backend.qwenContextWindowSize ? ` · 窗口 ${backend.qwenContextWindowSize.toLocaleString()}` : ''}
                            {` · 输出 ≤${(backend.qwenMaxOutputTokens ?? 32000).toLocaleString()}`}
                            {backend.env?.DASHSCOPE_API_KEY ? ' · 🔑' : ' · ⚠️无Key'}
                          </span>
                        )}
                        {backend.type === 'codex-office' && (
                          <span> · Codex CLI{backend.model ? ` · 🤖${backend.model}` : ''}{backend.apiKey || backend.env?.OPENAI_API_KEY ? ' · 🔑' : ' · login'}</span>
                        )}
                        {(backend.type === 'openai-compatible' || backend.type === 'anthropic-api' || backend.type === 'claude-code-official' || backend.type === 'dashscope-image') && backend.model && (
                          <span> · 🤖{backend.model}</span>
                        )}
                        {backend.baseUrl && (
                          <span> · {backend.baseUrl.replace(/^https?:\/\//, '').split('/')[0]}</span>
                        )}
                        {backend.type === 'claude-agent-sdk' && backend.env?.ANTHROPIC_BASE_URL && (
                          <span> · {backend.env.ANTHROPIC_BASE_URL.replace(/^https?:\/\//, '').split('/')[0]}</span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleCopyBackend(backend); }}
                        disabled={operationBusy || !selectedExecutor?.connected}
                        style={{
                          ...copyBtnStyle,
                          opacity: operationBusy || !selectedExecutor?.connected ? 0.5 : 1,
                        }}
                        title="复制为一份新的 Backend 配置"
                      >⧉ 复制</button>
                    {!backend.pinned && (
                      <button
                        className="bm-delete-btn"
                        onClick={(e) => { e.stopPropagation(); handleDeleteClick(backend); }}
                        style={deleteBtnStyle}
                        title="Delete backend"
                      >
                        🗑
                      </button>
                    )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <input
              ref={importFileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleImportFile}
              style={{ display: 'none' }}
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 8 }}>
              <button
                onClick={handleNewBackend}
                disabled={loading || !!loadError || !selectedExecutor?.connected || operationBusy}
                style={{
                  ...addBtnStyle,
                  opacity: loading || loadError || !selectedExecutor?.connected || operationBusy ? 0.5 : 1,
                }}
              >
                + New Backend
              </button>
              <button
                type="button"
                onClick={() => importFileInputRef.current?.click()}
                disabled={loading || !!loadError || !selectedExecutor?.connected || operationBusy}
                style={{
                  ...transferBtnStyle,
                  opacity: loading || loadError || !selectedExecutor?.connected || operationBusy ? 0.5 : 1,
                }}
                title="先预览配置文件，再选择要合并到该执行节点的 Backend"
              >
                📥 导入
              </button>
              <button
                type="button"
                onClick={handleStartExport}
                disabled={loading || !!loadError || !selectedExecutor?.connected || operationBusy || backends.length === 0}
                style={{
                  ...transferBtnStyle,
                  opacity: loading || loadError || !selectedExecutor?.connected || operationBusy || backends.length === 0 ? 0.5 : 1,
                }}
                title="勾选并导出该执行节点的 Backend 配置"
              >
                📤 导出
              </button>
            </div>
            <div style={{ marginTop: 8, color: 'var(--theme-text-muted)', fontSize: 10.5, lineHeight: 1.5 }}>
              导入采用合并模式：只处理你勾选的 Backend，未选择项和该节点的其他配置都不会被删除。
            </div>
          </>
        ) : (
          // 编辑表单
          <>
            {copySourceLabel && (
              <div style={{
                marginBottom: 14, padding: '9px 11px', borderRadius: 8,
                color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)',
                border: '1px solid var(--theme-accent)', fontSize: 11.5, lineHeight: 1.55,
              }}>
                已复制「{copySourceLabel}」的完整配置，并生成新的 ID 与名称。
                修改需要差异化的字段后再保存，原配置不会被覆盖。
              </div>
            )}
            <div style={{
              marginBottom: 16,
              padding: '12px 14px',
              borderRadius: 8,
              background: formData.enabled === false ? 'rgba(148,163,184,0.08)' : 'rgba(34,197,94,0.08)',
              border: `1px solid ${formData.enabled === false ? 'rgba(148,163,184,0.2)' : 'rgba(34,197,94,0.22)'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 3 }}>
                  日常使用
                </div>
                <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', lineHeight: 1.5 }}>
                  停用后保留配置和历史会话，但不再出现在新建会话及日常 Backend 选择中。
                </div>
              </div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', flexShrink: 0 }}>
                <input
                  type="checkbox"
                  checked={formData.enabled !== false}
                  onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
                  style={{ width: 16, height: 16, accentColor: '#22c55e' }}
                />
                <span style={{ fontSize: 12, color: 'var(--theme-text)' }}>
                  {formData.enabled === false ? '停用' : '启用'}
                </span>
              </label>
            </div>

            {/* 固定后端（官方账户）不显示 ID/Label/Type 字段 */}
            {!formData.pinned && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Backend ID</label>
                  <input
                    type="text"
                    value={formData.id}
                    onChange={(e) => setFormData({ ...formData, id: e.target.value })}
                    style={inputStyle}
                    placeholder="backend-id"
                  />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Label (Display Name)</label>
                  <input
                    type="text"
                    value={formData.label}
                    onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                    style={inputStyle}
                    placeholder="My Custom Backend"
                  />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Type</label>
                  <div style={selectWrapperStyle}>
                    <select
                      value={formData.type}
                      onChange={(e) => {
                        const newType = e.target.value;
                        setFormData({
                          ...formData,
                          type: newType,
                          model: '',
                          baseUrl: '',
                          apiKey: '',
                          env: {},
                          extraHeaders: undefined,
                          skipPermissions: (newType === 'claude-agent-sdk' || newType === 'qwen-code-cli' || newType === 'codex-office') ? true : undefined,
                        });
                      }}
                      style={selectStyle}
                    >
                      <option value="claude-agent-sdk">Claude Agent SDK</option>
                      <option value="qwen-code-cli">Qwen Code CLI</option>
                      <option value="codex-office">Codex Office</option>
                      <option value="openai-compatible">OpenAI Compatible / Poe</option>
                      <option value="anthropic-api">Anthropic API</option>
                      <option value="dashscope-image">DashScope 图像（Wan / Qwen Image 3.0）</option>
                    </select>
                  </div>
                </div>
              </>
            )}

            {/* ── Claude Agent SDK 专属配置 ── */}
            {formData.type === 'claude-agent-sdk' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>Claude Agent SDK 配置</label>

                {/* ANTHROPIC_AUTH_TOKEN：手动填入 */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    ANTHROPIC_AUTH_TOKEN（可选，用于 claude.ai OAuth token）
                  </label>
                  <input
                    type="password"
                    value={formData.env?.ANTHROPIC_AUTH_TOKEN || ''}
                    onChange={(e) => handleEnvChange('ANTHROPIC_AUTH_TOKEN', e.target.value)}
                    style={inputStyle}
                    placeholder="sk-ant-oat01-...（官方账户 OAuth token）"
                  />
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '4px 0 0 0' }}>
                    如需使用官方账户，请运行<code style={{ fontSize: 9 }}>claude login</code>或在终端中输入<code style={{ fontSize: 9 }}>/login</code>。
                  </p>
                </div>

                {/* ANTHROPIC_BASE_URL：代理地址（可选） */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    ANTHROPIC_BASE_URL（代理地址，可选）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.ANTHROPIC_BASE_URL || ''}
                    onChange={(e) => handleEnvChange('ANTHROPIC_BASE_URL', e.target.value)}
                    style={inputStyle}
                    placeholder="e.g., https://coding.dashscope.aliyuncs.com/apps/anthropic"
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    ANTHROPIC_MODEL（来自上下文/知识配置）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.ANTHROPIC_MODEL || ''}
                    onChange={(e) => handleEnvChange('ANTHROPIC_MODEL', e.target.value)}
                    style={inputStyle}
                    placeholder="e.g., claude-sonnet-4-6（留空由 CLI 自动决定）"
                  />
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '4px 0 0 0' }}>
                    模型配置将传递给 Claude Agent SDK，留空时使用默认模型。
                  </p>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    HTTPS_PROXY（代理，可选）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.HTTPS_PROXY || ''}
                    onChange={(e) => handleEnvChange('HTTPS_PROXY', e.target.value)}
                    style={inputStyle}
                    placeholder="留空不走代理，e.g., http://127.0.0.1:7890"
                  />
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '3px 0 0 0' }}>
                    填写后 CLI 子进程的所有请求均走此代理（Clash 默认端口 7890）
                  </p>
                </div>

                {/* ── 允许的工具 ── */}
                <div style={{ marginTop: 12 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 6 }}>
                    允许使用的工具
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ALL_TOOLS.map(tool => {
                      const checked = (formData.allowedTools ?? DEFAULT_TOOLS).includes(tool);
                      const isNetwork = tool === 'WebSearch' || tool === 'WebFetch';
                      return (
                        <label key={tool} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                          padding: '3px 8px', borderRadius: 4, fontSize: 11,
                          background: checked ? (isNetwork ? 'rgba(34,197,94,0.15)' : 'rgba(99,102,241,0.15)') : 'rgba(255,255,255,0.05)',
                          border: `1px solid ${checked ? (isNetwork ? 'rgba(34,197,94,0.4)' : 'rgba(99,102,241,0.4)') : 'rgba(255,255,255,0.12)'}`,
                          color: checked ? 'var(--theme-text)' : 'var(--theme-text-muted)',
                        }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const cur = formData.allowedTools ?? [...DEFAULT_TOOLS];
                              setFormData({ ...formData, allowedTools: e.target.checked
                                ? [...cur, tool]
                                : cur.filter(t => t !== tool)
                              });
                            }}
                            style={{ accentColor: 'var(--theme-accent)', width: 11, height: 11 }}
                          />
                          {tool}
                          {isNetwork && <span style={{ fontSize: 9, opacity: 0.7 }}>🌐</span>}
                        </label>
                      );
                    })}
                  </div>
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '5px 0 0 0' }}>
                    WebSearch / WebFetch 为网络工具，默认不启用。两个后端均使用 bypassPermissions 模式，无需修改 settings.json。
                  </p>
                </div>

                <div style={{ marginTop: 12 }}>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={formData.skipPermissions !== false}
                      onChange={(e) => setFormData({ ...formData, skipPermissions: e.target.checked })}
                      style={{ accentColor: 'var(--theme-accent)', width: 14, height: 14, flexShrink: 0 }}
                    />
                    Skip Permissions (bypassPermissions 模式)
                  </label>
                  <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '4px 0 0 22px' }}>
                    启用后 Claude 可直接调用工具，无需逐条确认。
                  </p>
                </div>
              </div>
            )}

            {/* ── Claude Code 官方账户 专属配置 ── */}
            {formData.type === 'claude-code-official' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>Claude Code 官方账户配置</label>
                <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 12px 0', lineHeight: 1.6 }}>
                  凭证自动从 <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>~/.claude/.credentials.json</code> 读取（需先运行 <code style={{ fontSize: 10 }}>claude login</code>）。
                  <br />如本机缺少 CLI，请先执行 <code style={{ fontSize: 10 }}>npm install -g @anthropic-ai/claude-code</code>。
                  <br />通常只需配置代理即可使用。
                </p>

                {/* 一键登录卡片 */}
                <div style={{
                  marginBottom: 14, padding: 12, borderRadius: 8,
                  background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(165,168,255,0.95)', marginBottom: 6 }}>
                    🔑 第一步：登录 Claude 账户
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
                    点击下方按钮，将自动打开终端窗口并启动 <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>claude</code>
                    {formData.env?.HTTPS_PROXY
                      ? <span>（代理 <code style={{ fontSize: 10 }}>{formData.env.HTTPS_PROXY}</code> 已自动设置）</span>
                      : <span>（若需要代理请先在下方填写 HTTPS_PROXY）</span>
                    }。<br />
                    终端打开后，在提示下方<strong style={{ color: 'rgba(165,168,255,0.95)' }}>输入 <code style={{ fontSize: 10 }}>/login</code> 并按回车</strong>，按指引完成登录即可。
                  </div>
                  <button
                    onClick={handleOpenLoginTerminal}
                    disabled={loginLaunching}
                    style={{
                      fontSize: 12, padding: '7px 16px', borderRadius: 6,
                      border: '1px solid rgba(99,102,241,0.5)',
                      background: loginLaunching ? 'rgba(99,102,241,0.2)' : 'rgba(99,102,241,0.35)',
                      color: 'rgba(200,201,255,0.95)', fontWeight: 500,
                      cursor: loginLaunching ? 'wait' : 'pointer',
                    }}
                  >
                    {loginLaunching ? '正在打开终端...' : '📂 一键打开登录终端'}
                  </button>
                  {loginMsg && (
                    <p style={{ fontSize: 11, margin: '8px 0 0 0', lineHeight: 1.5,
                      color: loginMsg.includes('失败') ? 'rgba(239,68,68,0.9)' : 'rgba(34,197,94,0.9)' }}>
                      {loginMsg}
                    </p>
                  )}
                </div>

                {/* 模型状态 + 换模型卡片 */}
                <div style={{
                  marginBottom: 14, padding: 12, borderRadius: 8,
                  background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(110,231,183,0.9)', marginBottom: 6 }}>
                    🤖 当前模型（来自上下文/知识配置）
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--theme-text)', marginBottom: 10, fontFamily: 'monospace' }}>
                    {currentModel ? (
                      <span>{currentModel} <span style={{ color: 'rgba(110,231,183,0.6)', fontSize: 11 }}>(来自 ~/.claude/settings.json)</span></span>
                    ) : (
                      <span style={{ color: 'var(--theme-text-muted)', fontFamily: 'inherit', fontSize: 12 }}>默认（由 CLI 自动决定）</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
                    点击下方按钮打开终端，在 claude 中输入{' '}
                    <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>/model &lt;模型名&gt;</code>{' '}
                    切换，常用：<code style={{ fontSize: 10 }}>claude-opus-4-6</code> / <code style={{ fontSize: 10 }}>claude-sonnet-4-6</code>
                  </div>
                  <button
                    onClick={handleOpenModelTerminal}
                    disabled={modelLaunching}
                    style={{
                      fontSize: 12, padding: '7px 16px', borderRadius: 6,
                      border: '1px solid rgba(16,185,129,0.4)',
                      background: modelLaunching ? 'rgba(16,185,129,0.1)' : 'rgba(16,185,129,0.2)',
                      color: 'rgba(110,231,183,0.9)', fontWeight: 500,
                      cursor: modelLaunching ? 'wait' : 'pointer',
                    }}
                  >
                    {modelLaunching ? '正在打开终端...' : '🔀 打开终端换模型'}
                  </button>
                  {modelMsg && (
                    <p style={{ fontSize: 11, margin: '8px 0 0 0', lineHeight: 1.5,
                      color: modelMsg.includes('失败') ? 'rgba(239,68,68,0.9)' : 'rgba(34,197,94,0.9)' }}>
                      {modelMsg}
                    </p>
                  )}
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    HTTPS_PROXY <span style={{ color: 'rgba(239,68,68,0.8)' }}>* 必填（Windows 系统代理自动检测不可靠）</span>
                  </label>
                  <input
                    type="text"
                    value={formData.env?.HTTPS_PROXY || ''}
                    onChange={(e) => handleEnvChange('HTTPS_PROXY', e.target.value)}
                    style={inputStyle}
                    placeholder="http://127.0.0.1:7890（Clash 默认端口）"
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    HTTP_PROXY（与 HTTPS_PROXY 保持一致即可）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.HTTP_PROXY || ''}
                    onChange={(e) => handleEnvChange('HTTP_PROXY', e.target.value)}
                    style={inputStyle}
                    placeholder="http://127.0.0.1:7890"
                  />
                </div>

                {/* ── 允许的工具（官方账户） ── */}
                <div style={{ marginTop: 12 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 6 }}>
                    允许使用的工具
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ALL_TOOLS.map(tool => {
                      const checked = (formData.allowedTools ?? DEFAULT_TOOLS).includes(tool);
                      const isNetwork = tool === 'WebSearch' || tool === 'WebFetch';
                      return (
                        <label key={tool} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                          padding: '3px 8px', borderRadius: 4, fontSize: 11,
                          background: checked ? (isNetwork ? 'rgba(34,197,94,0.15)' : 'rgba(99,102,241,0.15)') : 'rgba(255,255,255,0.05)',
                          border: `1px solid ${checked ? (isNetwork ? 'rgba(34,197,94,0.4)' : 'rgba(99,102,241,0.4)') : 'rgba(255,255,255,0.12)'}`,
                          color: checked ? 'var(--theme-text)' : 'var(--theme-text-muted)',
                        }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const cur = formData.allowedTools ?? [...DEFAULT_TOOLS];
                              setFormData({ ...formData, allowedTools: e.target.checked
                                ? [...cur, tool]
                                : cur.filter(t => t !== tool)
                              });
                            }}
                            style={{ accentColor: 'var(--theme-accent)', width: 11, height: 11 }}
                          />
                          {tool}
                          {isNetwork && <span style={{ fontSize: 9, opacity: 0.7 }}>🌐</span>}
                        </label>
                      );
                    })}
                  </div>
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '5px 0 0 0' }}>
                    官方账户使用 --dangerously-skip-permissions，勾选即生效，无需改 settings.json。
                  </p>
                </div>

                <div style={{ marginTop: 12 }}>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={formData.skipPermissions !== false}
                      onChange={(e) => setFormData({ ...formData, skipPermissions: e.target.checked })}
                      style={{ accentColor: 'var(--theme-accent)', width: 14, height: 14, flexShrink: 0 }}
                    />
                    Skip Permissions (--dangerously-skip-permissions)
                  </label>
                </div>
              </div>
            )}

            {/* ── Qwen Code CLI 专属配置 ── */}
            {formData.type === 'qwen-code-cli' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>Qwen Code CLI 配置</label>
                <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 12px 0', lineHeight: 1.6 }}>
                  基于 <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>qwen</code> CLI 子进程 + stream-json 解析。
                  需先安装：<code style={{ fontSize: 10 }}>npm install -g @qwen-code/qwen-code@latest</code>（要求 Node.js ≥ 22）。
                </p>

                {/* CLI 路径覆盖 */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    CLI 路径（可选，留空自动从 PATH / npm global 解析）
                  </label>
                  <input
                    type="text"
                    value={formData.cliPath || ''}
                    onChange={(e) => setFormData({ ...formData, cliPath: e.target.value })}
                    style={inputStyle}
                    placeholder="e.g., C:\Users\xxx\AppData\Roaming\npm\qwen.cmd（留空自动解析）"
                  />
                </div>

                {/* 模型选择 */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    模型（-m 参数）
                  </label>
                  <input
                    type="text"
                    value={formData.model || ''}
                    onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                    style={inputStyle}
                    placeholder="qwen-plus / qwen3-coder / qwen-max（留空使用 CLI 默认）"
                  />
                </div>

                {/* Backend 级 Token 边界 */}
                <div style={{
                  marginBottom: 12,
                  padding: 10,
                  border: '1px solid var(--theme-border)',
                  borderRadius: 7,
                  background: 'var(--theme-bg-tertiary, rgba(127,127,127,.055))',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 650, color: 'var(--theme-text)', marginBottom: 8 }}>
                    模型 Token 边界
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                    <div>
                      <label style={{ fontSize: 10.5, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                        总上下文窗口（可选）
                      </label>
                      <input
                        type="number"
                        min={1024}
                        step={1024}
                        value={formData.qwenContextWindowSize ?? ''}
                        onChange={(e) => setFormData({
                          ...formData,
                          qwenContextWindowSize: e.target.value ? Number(e.target.value) : undefined,
                        })}
                        style={inputStyle}
                        placeholder="例如 135168"
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 10.5, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                        单次最大输出 Tokens
                      </label>
                      <input
                        type="number"
                        min={1}
                        step={1024}
                        max={formData.qwenContextWindowSize ? formData.qwenContextWindowSize - 1 : undefined}
                        value={formData.qwenMaxOutputTokens ?? ''}
                        onChange={(e) => setFormData({
                          ...formData,
                          qwenMaxOutputTokens: e.target.value ? Number(e.target.value) : undefined,
                        })}
                        style={inputStyle}
                        placeholder="32000（安全默认）"
                      />
                    </div>
                  </div>
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '7px 0 0', lineHeight: 1.55 }}>
                    限制跟随此 Backend 保存在执行节点。最大输出留空时固定使用 32,000，避免兼容端点把未知模型推导成超大的
                    <code style={{ marginLeft: 3 }}>max_tokens</code>；输入与输出之和仍不能超过总上下文窗口。
                  </p>
                </div>

                {/* Provider / auth-type 选择 */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Provider / Auth Type（--auth-type）
                  </label>
                  <div style={selectWrapperStyle}>
                    <select
                      value={formData.env?.QWEN_PROVIDER || 'qwen-oauth'}
                      onChange={(e) => handleEnvChange('QWEN_PROVIDER', e.target.value)}
                      style={selectStyle}
                    >
                      <option value="qwen-oauth">Qwen OAuth（免费额度已停用，需 Coding Plan）</option>
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="gemini">Gemini</option>
                      <option value="vertex-ai">Vertex AI</option>
                    </select>
                  </div>
                  <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '4px 0 0 0' }}>
                    对应 Qwen CLI 的 --auth-type 参数。合法值：qwen-oauth / openai / anthropic / gemini / vertex-ai。
                    选择对应 provider 后，CLI 会自动读取相应的认证环境变量。
                  </p>
                </div>

                {/* ── 根据 QWEN_PROVIDER 动态展示所需的 Key 字段 ── */}
                {(() => {
                  const provider = formData.env?.QWEN_PROVIDER || 'qwen-oauth';
                  return (
                    <>
                      {/* qwen-oauth: DASHSCOPE_API_KEY + OPENAI_API_KEY (fallback) + OPENAI_BASE_URL */}
                      {provider === 'qwen-oauth' && (
                        <>
                          <div style={{ marginBottom: 10 }}>
                            <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                              DASHSCOPE_API_KEY（DashScope 主 Key）
                            </label>
                            <input
                              type="password"
                              value={formData.env?.DASHSCOPE_API_KEY || ''}
                              onChange={(e) => handleEnvChange('DASHSCOPE_API_KEY', e.target.value)}
                              style={inputStyle}
                              placeholder="sk-...（阿里云 DashScope API Key）"
                            />
                            <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '4px 0 0 0' }}>
                              必填。从阿里云 DashScope 控制台获取。后端会自动将其作为 OPENAI_API_KEY 的 fallback。
                            </p>
                          </div>
                          <div style={{ marginBottom: 10 }}>
                            <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                              OPENAI_API_KEY（可选，覆盖 fallback）
                            </label>
                            <input
                              type="password"
                              value={formData.env?.OPENAI_API_KEY || ''}
                              onChange={(e) => handleEnvChange('OPENAI_API_KEY', e.target.value)}
                              style={inputStyle}
                              placeholder="留空则自动使用 DASHSCOPE_API_KEY"
                            />
                            <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '4px 0 0 0' }}>
                              Qwen CLI 的 qwen-oauth 实际走 OpenAI 兼容协议。
                              通常留空即可（后端会把 DASHSCOPE_API_KEY 映射过去）；
                              如需独立 Key 可在此覆盖。
                            </p>
                          </div>
                          <div style={{ marginBottom: 10 }}>
                            <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                              OPENAI_BASE_URL（可选，覆盖默认端点）
                            </label>
                            <input
                              type="text"
                              value={formData.env?.OPENAI_BASE_URL || ''}
                              onChange={(e) => handleEnvChange('OPENAI_BASE_URL', e.target.value)}
                              style={inputStyle}
                              placeholder="留空默认 https://dashscope.aliyuncs.com/compatible-mode/v1"
                            />
                            <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '4px 0 0 0' }}>
                              留空即使用 DashScope 的 OpenAI 兼容端点。
                              若走代理/中转服务，可在此自定义。
                            </p>
                          </div>
                        </>
                      )}

                      {/* openai: OPENAI_API_KEY + OPENAI_BASE_URL */}
                      {provider === 'openai' && (
                        <>
                          <div style={{ marginBottom: 10 }}>
                            <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                              OPENAI_API_KEY
                            </label>
                            <input
                              type="password"
                              value={formData.env?.OPENAI_API_KEY || ''}
                              onChange={(e) => handleEnvChange('OPENAI_API_KEY', e.target.value)}
                              style={inputStyle}
                              placeholder="sk-..."
                            />
                          </div>
                          <div style={{ marginBottom: 10 }}>
                            <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                              OPENAI_BASE_URL（可选，用于兼容端点 / 中转）
                            </label>
                            <input
                              type="text"
                              value={formData.env?.OPENAI_BASE_URL || ''}
                              onChange={(e) => handleEnvChange('OPENAI_BASE_URL', e.target.value)}
                              style={inputStyle}
                              placeholder="留空使用 OpenAI 官方端点"
                            />
                          </div>
                        </>
                      )}

                      {/* anthropic: ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL */}
                      {provider === 'anthropic' && (
                        <>
                          <div style={{ marginBottom: 10 }}>
                            <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                              ANTHROPIC_API_KEY
                            </label>
                            <input
                              type="password"
                              value={formData.env?.ANTHROPIC_API_KEY || ''}
                              onChange={(e) => handleEnvChange('ANTHROPIC_API_KEY', e.target.value)}
                              style={inputStyle}
                              placeholder="sk-ant-..."
                            />
                          </div>
                          <div style={{ marginBottom: 10 }}>
                            <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                              ANTHROPIC_BASE_URL（可选，用于代理）
                            </label>
                            <input
                              type="text"
                              value={formData.env?.ANTHROPIC_BASE_URL || ''}
                              onChange={(e) => handleEnvChange('ANTHROPIC_BASE_URL', e.target.value)}
                              style={inputStyle}
                              placeholder="留空使用 Anthropic 官方端点"
                            />
                          </div>
                        </>
                      )}

                      {/* gemini: GEMINI_API_KEY */}
                      {provider === 'gemini' && (
                        <div style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                            GEMINI_API_KEY
                          </label>
                          <input
                            type="password"
                            value={formData.env?.GEMINI_API_KEY || ''}
                            onChange={(e) => handleEnvChange('GEMINI_API_KEY', e.target.value)}
                            style={inputStyle}
                            placeholder="AIza..."
                          />
                        </div>
                      )}

                      {/* vertex-ai: 使用 GOOGLE_APPLICATION_CREDENTIALS 或项目配置 */}
                      {provider === 'vertex-ai' && (
                        <>
                          <div style={{ marginBottom: 10 }}>
                            <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                              GOOGLE_APPLICATION_CREDENTIALS（服务账号 JSON 路径）
                            </label>
                            <input
                              type="text"
                              value={formData.env?.GOOGLE_APPLICATION_CREDENTIALS || ''}
                              onChange={(e) => handleEnvChange('GOOGLE_APPLICATION_CREDENTIALS', e.target.value)}
                              style={inputStyle}
                              placeholder="C:\path\to\service-account.json"
                            />
                            <p style={{ fontSize: 10, color: 'var(--theme-text-muted)', margin: '4px 0 0 0' }}>
                              Vertex AI 使用 GCP 服务账号认证。填写 JSON Key 文件的绝对路径，
                              或设置 <code style={{ fontSize: 9 }}>GOOGLE_API_KEY</code> 作为简易替代。
                            </p>
                          </div>
                          <div style={{ marginBottom: 10 }}>
                            <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                              GOOGLE_API_KEY（可选，简易 API Key）
                            </label>
                            <input
                              type="password"
                              value={formData.env?.GOOGLE_API_KEY || ''}
                              onChange={(e) => handleEnvChange('GOOGLE_API_KEY', e.target.value)}
                              style={inputStyle}
                              placeholder="AIza..."
                            />
                          </div>
                        </>
                      )}
                    </>
                  );
                })()}

                {/* HTTPS_PROXY */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Codex 网络方式
                  </label>
                  <select
                    value={formData.env?.AGENTWITHU_CODEX_PROXY_MODE || (formData.env?.HTTPS_PROXY ? 'custom' : 'inherit')}
                    onChange={(e) => handleEnvChange('AGENTWITHU_CODEX_PROXY_MODE', e.target.value)}
                    style={inputStyle}
                  >
                    <option value="system">跟随 Windows 系统代理（Clash 规则模式推荐）</option>
                    <option value="inherit">继承 AgentWithU 的代理环境变量</option>
                    <option value="custom">仅 Codex 使用独立代理</option>
                    <option value="direct">Codex 强制直连（清除继承代理）</option>
                  </select>
                  <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 5, lineHeight: 1.5 }}>
                    系统代理模式会读取执行节点的 Windows 代理设置；Clash 仍按“规则”分流，不会切换成全局代理，也不需要开启 TUN。
                  </div>
                </div>

                {(formData.env?.AGENTWITHU_CODEX_PROXY_MODE === 'system' ||
                  formData.env?.AGENTWITHU_CODEX_PROXY_MODE === 'custom' ||
                  (!formData.env?.AGENTWITHU_CODEX_PROXY_MODE && !!formData.env?.HTTPS_PROXY)) && (
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={formData.env?.AGENTWITHU_CODEX_FORCE_HTTP !== 'false'}
                        onChange={(e) => handleEnvChange('AGENTWITHU_CODEX_FORCE_HTTP', e.target.checked ? 'true' : 'false')}
                        style={{ accentColor: 'var(--theme-accent)' }}
                      />
                      HTTP 兼容传输（代理环境推荐）
                    </label>
                    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '4px 0 0 22px', lineHeight: 1.5 }}>
                      跳过容易断开的 Codex WebSocket 上游，直接使用 HTTP/SSE；不影响 AgentWithU 自身的实时输出。
                    </div>
                  </div>
                )}

                {(formData.env?.AGENTWITHU_CODEX_PROXY_MODE === 'custom' ||
                  (!formData.env?.AGENTWITHU_CODEX_PROXY_MODE && !!formData.env?.HTTPS_PROXY)) && (
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Codex 独立代理地址
                  </label>
                  <input
                    type="text"
                    value={formData.env?.AGENTWITHU_CODEX_PROXY || formData.env?.HTTPS_PROXY || ''}
                    onChange={(e) => handleEnvChange('AGENTWITHU_CODEX_PROXY', e.target.value)}
                    onBlur={(e) => {
                      const value = e.target.value.trim();
                      if (value && !value.includes('://')) {
                        handleEnvChange('AGENTWITHU_CODEX_PROXY', `http://${value}`);
                      }
                    }}
                    style={inputStyle}
                    placeholder="例如 http://127.0.0.1:7890（代理软件的 HTTP / mixed 端口）"
                  />
                  <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 5, lineHeight: 1.5 }}>
                    仅传给 Codex 及其子进程，并同时设置 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY。请使用 HTTP / mixed 代理端口；裸 IP:端口会自动补全 http://。
                  </div>
                </div>
                )}

                {/* ── 允许的工具 ── */}
                <div style={{ marginTop: 12 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 6 }}>
                    允许使用的工具（--core-tools）
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ALL_TOOLS.map(tool => {
                      const checked = (formData.allowedTools ?? DEFAULT_TOOLS).includes(tool);
                      const isNetwork = tool === 'WebSearch' || tool === 'WebFetch';
                      return (
                        <label key={tool} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                          padding: '3px 8px', borderRadius: 4, fontSize: 11,
                          background: checked ? (isNetwork ? 'rgba(34,197,94,0.15)' : 'rgba(99,102,241,0.15)') : 'rgba(255,255,255,0.05)',
                          border: `1px solid ${checked ? (isNetwork ? 'rgba(34,197,94,0.4)' : 'rgba(99,102,241,0.4)') : 'rgba(255,255,255,0.12)'}`,
                          color: checked ? 'var(--theme-text)' : 'var(--theme-text-muted)',
                        }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const cur = formData.allowedTools ?? [...DEFAULT_TOOLS];
                              setFormData({ ...formData, allowedTools: e.target.checked
                                ? [...cur, tool]
                                : cur.filter(t => t !== tool)
                              });
                            }}
                            style={{ accentColor: 'var(--theme-accent)', width: 11, height: 11 }}
                          />
                          {tool}
                          {isNetwork && <span style={{ fontSize: 9, opacity: 0.7 }}>🌐</span>}
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div style={{ marginTop: 12 }}>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={formData.skipPermissions !== false}
                      onChange={(e) => setFormData({ ...formData, skipPermissions: e.target.checked })}
                      style={{ accentColor: 'var(--theme-accent)', width: 14, height: 14, flexShrink: 0 }}
                    />
                    Skip Permissions (--yolo 模式)
                  </label>
                  <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '4px 0 0 22px' }}>
                    启用后 Qwen CLI 自动批准工具调用，无需逐条确认。
                  </p>
                </div>
              </div>
            )}

            {/* ── Codex Office 专属配置 ── */}
            {formData.type === 'codex-office' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>Codex Office 配置</label>
                <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 12px 0', lineHeight: 1.6 }}>
                  基于 <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>codex exec --json</code> 非交互模式。
                  需先安装：<code style={{ fontSize: 10 }}>npm install -g @openai/codex</code>，然后完成 <code style={{ fontSize: 10 }}>codex login</code>，或填写 OpenAI API Key。
                </p>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    CLI 路径（可选，留空自动从 PATH / npm global 解析）
                  </label>
                  <input
                    type="text"
                    value={formData.cliPath || ''}
                    onChange={(e) => setFormData({ ...formData, cliPath: e.target.value })}
                    style={inputStyle}
                    placeholder="e.g., codex 或 C:\\Users\\xxx\\AppData\\Roaming\\npm\\codex.cmd"
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    默认模型（可选；会话 / Loop 角色可覆盖）
                  </label>
                  <input
                    type="text"
                    value={formData.model || ''}
                    onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                    style={inputStyle}
                    list="codex-recommended-models"
                    placeholder={CODEX_DEFAULT_MODEL}
                  />
                  <datalist id="codex-recommended-models">
                    {CODEX_RECOMMENDED_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </datalist>
                  <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 5, lineHeight: 1.5 }}>
                    这里只设置该 Backend 的兜底模型，不需要为 Sol / Terra 重复建 Backend。推荐默认：<code style={{ fontSize: 10 }}>{CODEX_DEFAULT_MODEL}</code>。可手填新模型；官方列表见{' '}
                    <a href="https://developers.openai.com/codex/models" target="_blank" rel="noreferrer" style={{ color: 'var(--theme-accent)' }}>Codex Models</a>
                    {' '}；用量/5h 窗口见{' '}
                    <a href="https://developers.openai.com/codex/pricing" target="_blank" rel="noreferrer" style={{ color: 'var(--theme-accent)' }}>Codex Pricing</a>。
                  </div>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    OpenAI API Key（可选；也可使用 codex login）
                  </label>
                  <input
                    type="password"
                    value={formData.apiKey || ''}
                    onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                    style={inputStyle}
                    placeholder="sk-..."
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Base URL（可选，对应 OPENAI_BASE_URL）
                  </label>
                  <input
                    type="text"
                    value={formData.baseUrl || ''}
                    onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                    style={inputStyle}
                    placeholder="https://api.openai.com/v1"
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    HTTPS_PROXY（代理，可选）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.HTTPS_PROXY || ''}
                    onChange={(e) => handleEnvChange('HTTPS_PROXY', e.target.value)}
                    style={inputStyle}
                    placeholder="留空不走代理，e.g., http://127.0.0.1:7890"
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    CODEX_HOME（可选，隔离 Codex 配置/登录缓存）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.CODEX_HOME || ''}
                    onChange={(e) => handleEnvChange('CODEX_HOME', e.target.value)}
                    style={inputStyle}
                    placeholder="留空使用默认 ~/.codex"
                  />
                </div>

                <div style={{ marginTop: 12 }}>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={formData.skipPermissions !== false}
                      onChange={(e) => setFormData({ ...formData, skipPermissions: e.target.checked })}
                      style={{ accentColor: 'var(--theme-accent)', width: 14, height: 14, flexShrink: 0 }}
                    />
                    Skip Permissions (--ask-for-approval never)
                  </label>
                  <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '4px 0 0 22px' }}>
                    启用后 Codex exec 使用非交互自动批准策略，并在 workspace-write sandbox 中运行。
                  </p>
                </div>
              </div>
            )}

            {/* ── MCP Servers 配置（claude-agent-sdk / claude-code-official / qwen-code-cli）── */}
            {(formData.type === 'claude-agent-sdk' || formData.type === 'claude-code-official' || formData.type === 'qwen-code-cli' || formData.type === 'codex-office' || formData.pinned) && (
              <McpServersEditor
                mcpServers={formData.mcpServers}
                onChange={(v) => setFormData((prev) => ({ ...prev, mcpServers: v }))}
              />
            )}

            {/* ── OpenAI Compatible 专属配置 ── */}
            {formData.type === 'openai-compatible' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                  <div>
                    <label style={{ ...labelStyle, marginBottom: 4 }}>OpenAI Compatible 配置</label>
                    <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: 0, lineHeight: 1.5 }}>
                      兼容 OpenAI Chat Completions API 的服务；Poe 可额外读取实时模型目录与账号积分。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFormData((current) => ({
                      ...current,
                      label: current.label.trim() ? current.label : 'Poe API',
                      baseUrl: POE_API_BASE_URL,
                    }))}
                    style={{ ...cancelBtnStyle, flex: 'none', padding: '6px 9px', fontSize: 11, whiteSpace: 'nowrap' }}
                  >{isPoeBackend ? '✓ Poe 已识别' : '套用 Poe'}</button>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Base URL <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.baseUrl || ''}
                    onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                    style={inputStyle}
                    placeholder="https://api.openai.com/v1"
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    API Key
                  </label>
                  <input
                    type="password"
                    value={formData.apiKey || ''}
                    onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                    style={inputStyle}
                    placeholder="sk-..."
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Model <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.model || ''}
                    onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                    style={inputStyle}
                    list={isPoeBackend && poeOverview?.models.length ? 'poe-live-model-options' : undefined}
                    placeholder="e.g., gpt-4o / deepseek-chat / qwen-plus"
                  />
                  {isPoeBackend && poeOverview?.models.length ? (
                    <datalist id="poe-live-model-options">
                      {poeOverview.models.map((item) => (
                        <option key={item.id} value={item.id}>{item.description.slice(0, 100)}</option>
                      ))}
                    </datalist>
                  ) : null}
                </div>

                {isPoeBackend && (
                  <div style={{
                    marginBottom: 12, padding: 11, borderRadius: 8,
                    border: '1px solid rgba(99,102,241,.28)',
                    background: 'rgba(99,102,241,.07)',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 9 }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--theme-text)' }}>
                          ◈ Poe 实时入口
                        </div>
                        <div style={{ marginTop: 3, fontSize: 10.5, color: 'var(--theme-text-muted)' }}>
                          API 可用目录与当前账号积分；每次刷新都直接查询 Poe。
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void refreshPoeOverview()}
                        disabled={poeLoading || !selectedExecutor?.connected}
                        style={{ ...cancelBtnStyle, flex: 'none', padding: '6px 9px', fontSize: 11, opacity: poeLoading ? .55 : 1 }}
                      >{poeLoading ? '查询中…' : '↻ 实时刷新'}</button>
                    </div>

                    {poeError && (
                      <div style={{ marginBottom: 8, color: 'rgba(248,113,113,.98)', fontSize: 10.5, lineHeight: 1.5 }}>
                        {poeError}
                      </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 9 }}>
                      <div style={{ padding: '8px 9px', borderRadius: 7, background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)' }}>
                        <div style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>当前可用积分</div>
                        <div style={{ marginTop: 2, fontSize: 18, fontWeight: 700, color: 'var(--theme-text)' }}>
                          {poeOverview?.currentPointBalance != null
                            ? poeOverview.currentPointBalance.toLocaleString()
                            : '—'}
                        </div>
                        {poeOverview?.balanceError && (
                          <div style={{ marginTop: 3, fontSize: 9.5, lineHeight: 1.4, color: 'var(--theme-text-muted)' }}>
                            {poeOverview.balanceError}
                          </div>
                        )}
                      </div>
                      <div style={{ padding: '8px 9px', borderRadius: 7, background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)' }}>
                        <div style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>API 可用模型 / Bot</div>
                        <div style={{ marginTop: 2, fontSize: 18, fontWeight: 700, color: 'var(--theme-text)' }}>
                          {poeOverview ? poeOverview.modelCount.toLocaleString() : '—'}
                        </div>
                        <div style={{ marginTop: 3, fontSize: 9.5, color: 'var(--theme-text-muted)' }}>
                          近 30 天上架 {poeRecentCount} 项
                        </div>
                      </div>
                    </div>

                    {poeOverview?.catalogError && (
                      <div style={{ marginBottom: 8, color: 'rgba(248,113,113,.98)', fontSize: 10.5, lineHeight: 1.5 }}>
                        {poeOverview.catalogError}
                      </div>
                    )}

                    {(poeOverview?.models.length || 0) > 0 && (
                      <>
                        <input
                          type="search"
                          value={poeQuery}
                          onChange={(event) => setPoeQuery(event.target.value)}
                          style={{ ...inputStyle, padding: '7px 9px', fontSize: 11, marginBottom: 7 }}
                          placeholder="搜索实时目录中的模型或公开 Bot…"
                        />
                        <div style={{ marginBottom: 5, fontSize: 10, fontWeight: 600, color: 'var(--theme-text-muted)' }}>
                          {normalizedPoeQuery ? `搜索结果（显示前 ${poeVisibleModels.length} 项）` : '最新上架（按 Poe created 时间）'}
                        </div>
                        <div style={{ maxHeight: 250, overflowY: 'auto', border: '1px solid var(--theme-border)', borderRadius: 7 }}>
                          {poeVisibleModels.length === 0 ? (
                            <div style={{ padding: 12, textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 11 }}>没有匹配项</div>
                          ) : poeVisibleModels.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setFormData((current) => ({ ...current, model: item.id }))}
                              style={{
                                width: '100%', padding: '7px 8px', display: 'flex', alignItems: 'center', gap: 8,
                                border: 0, borderBottom: '1px solid var(--theme-border)', textAlign: 'left', cursor: 'pointer',
                                color: 'var(--theme-text)', background: formData.model === item.id ? 'var(--theme-accent-bg)' : 'transparent',
                              }}
                              title={item.description || item.id}
                            >
                              <span style={{ minWidth: 0, flex: 1 }}>
                                <span style={{ display: 'block', fontSize: 11, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {item.id}
                                </span>
                                <span style={{ display: 'block', marginTop: 2, fontSize: 9.5, color: 'var(--theme-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {item.description || '暂无说明'}
                                </span>
                              </span>
                              <span style={{ flexShrink: 0, fontSize: 9.5, color: 'var(--theme-text-muted)' }}>
                                {formatPoeTime(item.createdAt)}
                              </span>
                              <span style={{ flexShrink: 0, fontSize: 10, color: formData.model === item.id ? 'var(--theme-accent)' : 'var(--theme-text-muted)' }}>
                                {formData.model === item.id ? '已选' : '选用'}
                              </span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}

                    <div style={{ marginTop: 7, fontSize: 9.5, lineHeight: 1.45, color: 'var(--theme-text-muted)' }}>
                      {poeOverview?.fetchedAt ? `最后查询：${formatPoeTime(poeOverview.fetchedAt)}。` : ''}
                      余额是 API 返回的当前可用积分总数；Poe 暂不返回套餐总额、已用量或到期拆分。
                      目录仅代表 API 可调用项，不等同于 Poe Explore 全站榜单，私有 Bot 目前不可通过 API 调用。
                    </div>
                  </div>
                )}

                <div style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Extra HTTP Headers（可选，每行 Key: Value）
                  </label>
                  <textarea
                    value={Object.entries(formData.extraHeaders || {}).map(([k, v]) => `${k}: ${v}`).join('\n')}
                    onChange={(e) => {
                      const headers: Record<string, string> = {};
                      e.target.value.split('\n').forEach(line => {
                        const idx = line.indexOf(':');
                        if (idx > 0) {
                          const key = line.slice(0, idx).trim();
                          const val = line.slice(idx + 1).trim();
                          if (key) headers[key] = val;
                        }
                      });
                      setFormData({ ...formData, extraHeaders: headers });
                    }}
                    style={{ ...inputStyle, height: 70, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                    placeholder={'Authorization: Bearer token\nX-Custom-Header: value'}
                  />
                </div>
              </div>
            )}

            {/* ── Anthropic API 专属配置 ── */}
            {formData.type === 'anthropic-api' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>Anthropic API 配置</label>
                <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 12px 0' }}>
                  直接调用 Anthropic Messages API，不依赖 CLI。
                </p>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    API Key <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                  </label>
                  <input
                    type="password"
                    value={formData.apiKey || ''}
                    onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                    style={inputStyle}
                    placeholder="sk-ant-..."
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Model <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.model || ''}
                    onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                    style={inputStyle}
                    placeholder="e.g., claude-sonnet-4-6"
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Base URL（代理地址，可选）
                  </label>
                  <input
                    type="text"
                    value={formData.baseUrl || ''}
                    onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                    style={inputStyle}
                    placeholder="留空使用官方 https://api.anthropic.com"
                  />
                </div>

                <div style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Extra HTTP Headers（可选，每行 Key: Value）
                  </label>
                  <textarea
                    value={Object.entries(formData.extraHeaders || {}).map(([k, v]) => `${k}: ${v}`).join('\n')}
                    onChange={(e) => {
                      const headers: Record<string, string> = {};
                      e.target.value.split('\n').forEach(line => {
                        const idx = line.indexOf(':');
                        if (idx > 0) {
                          const key = line.slice(0, idx).trim();
                          const val = line.slice(idx + 1).trim();
                          if (key) headers[key] = val;
                        }
                      });
                      setFormData({ ...formData, extraHeaders: headers });
                    }}
                    style={{ ...inputStyle, height: 70, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                    placeholder={'MM-Group-Id: 123456789\nX-Custom-Header: value'}
                  />
                </div>
              </div>
            )}

            {/* ── DashScope 图像生成与编辑专属配置 ── */}
            {formData.type === 'dashscope-image' && (
              <div style={{ marginBottom: 16, padding: 12, background: 'var(--theme-bg-secondary)', borderRadius: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 8 }}>DashScope 图像生成与编辑配置</label>
                <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 12px 0', lineHeight: 1.6 }}>
                  同一类型可创建多个独立 Backend：保留现有 Wan 2.7，再新增一个选择
                  <code style={{ margin: '0 3px' }}>qwen-image-3.0</code> 或
                  <code style={{ marginLeft: 3 }}>qwen-image-3.0-pro</code>。Qwen 3.0 同时支持文生图与 1–3 张参考图编辑。
                </p>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    API Key <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                  </label>
                  <input
                    type="password"
                    value={formData.apiKey || ''}
                    onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                    style={inputStyle}
                    placeholder="sk-..."
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    模型
                  </label>
                  <input
                    type="text"
                    list="dashscope-image-model-options"
                    value={formData.model || ''}
                    onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                    style={inputStyle}
                    placeholder="qwen-image-3.0-pro"
                  />
                  <datalist id="dashscope-image-model-options">
                    {DASHSCOPE_IMAGE_MODELS.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </datalist>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
                    {DASHSCOPE_IMAGE_MODELS.slice(0, 2).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setFormData({ ...formData, model: item.id })}
                        style={{
                          padding: '4px 8px', borderRadius: 5, fontSize: 10, cursor: 'pointer',
                          border: `1px solid ${formData.model === item.id ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                          color: formData.model === item.id ? 'var(--theme-accent)' : 'var(--theme-text-muted)',
                          background: formData.model === item.id ? 'var(--theme-accent-bg)' : 'transparent',
                        }}
                      >{item.label}</button>
                    ))}
                  </div>
                  <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: 'var(--theme-text-muted)' }}>
                    Qwen 3.0 Pro 质量优先；标准版兼顾质量与速度。Wan 模型仍可直接填写原模型名。
                  </span>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    图片尺寸（SIZE）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.SIZE || ''}
                    onChange={(e) => handleEnvChange('SIZE', e.target.value)}
                    style={inputStyle}
                    placeholder={isQwenImage3Model(formData.model) ? '留空＝由 Qwen 自动推荐' : '1024*1024（默认）'}
                  />
                  <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: 'var(--theme-text-muted)' }}>
                    可在聊天输入区按轮选择自动、1:1、16:9 等；这里设置的是 Backend 默认值。
                  </span>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    反向提示词（NEGATIVE_PROMPT，可选）
                  </label>
                  <input
                    type="text"
                    value={formData.env?.NEGATIVE_PROMPT || ''}
                    onChange={(e) => handleEnvChange('NEGATIVE_PROMPT', e.target.value)}
                    style={inputStyle}
                    placeholder="blurry, low quality, watermark..."
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                      提示词智能改写
                    </label>
                    <select
                      value={formData.env?.PROMPT_EXTEND || 'true'}
                      onChange={(e) => handleEnvChange('PROMPT_EXTEND', e.target.value)}
                      style={selectStyle}
                    >
                      <option value="true">开启（推荐）</option>
                      <option value="false">关闭</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                      输出水印
                    </label>
                    <select
                      value={formData.env?.WATERMARK || 'false'}
                      onChange={(e) => handleEnvChange('WATERMARK', e.target.value)}
                      style={selectStyle}
                    >
                      <option value="false">关闭</option>
                      <option value="true">开启</option>
                    </select>
                  </div>
                </div>

                {isQwenImage3Model(formData.model) && (
                  <div style={{ margin: '12px 0', padding: 10, border: '1px solid var(--theme-border)', borderRadius: 7 }}>
                    <div style={{ fontSize: 11, fontWeight: 650, color: 'var(--theme-text)', marginBottom: 9 }}>
                      Qwen Image 3.0 参数
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 10 }}>
                      <div>
                        <label style={{ fontSize: 10, color: 'var(--theme-text-muted)', display: 'block', marginBottom: 4 }}>
                          改写模式
                        </label>
                        <select
                          value={formData.env?.PROMPT_EXTEND_MODE || 'direct'}
                          onChange={(e) => handleEnvChange('PROMPT_EXTEND_MODE', e.target.value)}
                          style={selectStyle}
                        >
                          <option value="direct">Direct（文生图/图生图）</option>
                          <option value="agent">Agent（仅文生图）</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 10, color: 'var(--theme-text-muted)', display: 'block', marginBottom: 4 }}>
                          思考增强
                        </label>
                        <select
                          value={formData.env?.ENABLE_THINKING || 'true'}
                          onChange={(e) => handleEnvChange('ENABLE_THINKING', e.target.value)}
                          style={selectStyle}
                        >
                          <option value="true">开启（质量优先）</option>
                          <option value="false">关闭（速度优先）</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 10, color: 'var(--theme-text-muted)', display: 'block', marginBottom: 4 }}>
                          调用方式
                        </label>
                        <select
                          value={formData.env?.DASHSCOPE_CALL_MODE || 'auto'}
                          onChange={(e) => handleEnvChange('DASHSCOPE_CALL_MODE', e.target.value)}
                          style={selectStyle}
                        >
                          <option value="auto">自动（推荐）</option>
                          <option value="async">始终异步</option>
                          <option value="sync">始终同步</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 10, color: 'var(--theme-text-muted)', display: 'block', marginBottom: 4 }}>
                          异步最长等待（秒）
                        </label>
                        <input
                          type="number"
                          min={60}
                          max={7200}
                          step={60}
                          value={formData.env?.DASHSCOPE_MAX_WAIT_SECONDS || '3600'}
                          onChange={(e) => handleEnvChange('DASHSCOPE_MAX_WAIT_SECONDS', e.target.value)}
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: 10, color: 'var(--theme-text-muted)', display: 'block', marginBottom: 4 }}>
                          输出数量（1–6）
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={6}
                          value={formData.env?.N || '1'}
                          onChange={(e) => handleEnvChange('N', e.target.value)}
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: 10, color: 'var(--theme-text-muted)', display: 'block', marginBottom: 4 }}>
                          Seed（可选）
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={2147483647}
                          value={formData.env?.SEED || ''}
                          onChange={(e) => handleEnvChange('SEED', e.target.value)}
                          style={inputStyle}
                          placeholder="随机"
                        />
                      </div>
                    </div>
                    <div style={{ marginTop: 7, fontSize: 10, color: 'var(--theme-text-muted)', lineHeight: 1.55 }}>
                      自动模式会在提交前把 Pro、图生图、多输出、高分辨率、Thinking、Agent 改写和长提示词切到异步，避免长连接读超时。
                      同步请求若仅发生读取超时不会自动重发，以免重复生成和计费。图生图选择 Agent 时会自动改为 Direct；参考图最多 3 张、每张不超过 10MB。
                    </div>
                  </div>
                )}

                <div style={{ marginBottom: 10, padding: 10, border: '1px solid var(--theme-border)', borderRadius: 7 }}>
                  <div style={{ fontSize: 11, fontWeight: 650, color: 'var(--theme-text)', marginBottom: 8 }}>
                    业务空间专属域名（推荐）
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--theme-text-muted)', display: 'block', marginBottom: 4 }}>
                        Workspace ID
                      </label>
                      <input
                        type="text"
                        value={formData.env?.DASHSCOPE_WORKSPACE_ID || ''}
                        onChange={(e) => handleEnvChange('DASHSCOPE_WORKSPACE_ID', e.target.value)}
                        style={inputStyle}
                        placeholder="业务空间 ID"
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--theme-text-muted)', display: 'block', marginBottom: 4 }}>
                        地域
                      </label>
                      <select
                        value={formData.env?.DASHSCOPE_REGION || 'cn-beijing'}
                        onChange={(e) => handleEnvChange('DASHSCOPE_REGION', e.target.value)}
                        style={selectStyle}
                      >
                        <option value="cn-beijing">北京</option>
                        <option value="ap-southeast-1">新加坡</option>
                        <option value="eu-central-1">法兰克福</option>
                        <option value="ap-northeast-1">东京</option>
                      </select>
                    </div>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 10, color: 'var(--theme-text-muted)' }}>
                    模型、API Key、Workspace 与地域必须一致；填写后自动组成对应的 <code>...maas.aliyuncs.com/api/v1</code> 地址。
                  </div>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--theme-text)', display: 'block', marginBottom: 4 }}>
                    Base API URL（高级，可选；优先于 Workspace 配置）
                  </label>
                  <input
                    type="text"
                    value={formData.baseUrl || ''}
                    onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                    style={inputStyle}
                    placeholder="https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1"
                  />
                  <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: 'var(--theme-text-muted)' }}>
                    应填写到 <code>/api/v1</code> 为止；即使误粘贴完整 generation Endpoint，后端也会自动归一化。
                  </span>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button
                onClick={handleSave}
                disabled={operationBusy || !selectedExecutor?.connected}
                style={{
                  ...saveBtnStyle,
                  opacity: operationBusy || !selectedExecutor?.connected ? 0.5 : 1,
                }}
              >
                {operationBusy ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => {
                setIsEditing(false);
                setEditingBackend(null);
                setCopySourceLabel(null);
              }} style={cancelBtnStyle}>
                Back
              </button>
            </div>
          </>
        ))}

        {/* MCP 服务器 Tab */}
        {activeTab === 'mcp' && !isEditingMcp && (
          <>
            {mcpLoading ? (
              <div style={{ textAlign: 'center', color: 'var(--theme-text-muted)', padding: 20, fontSize: 13 }}>加载中...</div>
            ) : Object.keys(mcpServers).length === 0 ? (
              <div style={{ color: 'var(--theme-text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
                尚未配置 MCP 服务器
                <br />
                <span style={{ fontSize: 11, display: 'block', marginTop: 6 }}>MCP 服务器可为 Claude 提供额外工具，如 GitHub、数据库、浏览器自动化等</span>
              </div>
            ) : (
              Object.entries(mcpServers).map(([name, srv]: [string, any]) => (
                <div
                  key={name}
                  style={{ ...backendItemStyle }}
                  onClick={() => handleEditMcp(name, srv)}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, color: 'var(--theme-text)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11 }}>🔧</span>{name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', fontFamily: 'monospace' }}>
                      {srv.command} {(srv.args || []).slice(0, 3).join(' ')}{(srv.args?.length ?? 0) > 3 ? ' …' : ''}
                    </div>
                  </div>
                  <button
                    className="bm-delete-btn"
                    onClick={(e) => { e.stopPropagation(); handleDeleteMcp(name); }}
                    disabled={operationBusy}
                    style={{ ...deleteBtnStyle, opacity: operationBusy ? 0.5 : 1 }}
                    title="删除"
                  >🗑</button>
                </div>
              ))
            )}
            <button
              onClick={handleNewMcp}
              disabled={mcpLoading || operationBusy || !selectedExecutor?.connected}
              style={{
                ...addBtnStyle,
                background: 'rgba(99,102,241,0.12)',
                border: '1px solid rgba(99,102,241,0.3)',
                color: 'rgba(165,168,255,0.9)',
                marginTop: 8,
                opacity: mcpLoading || operationBusy || !selectedExecutor?.connected ? 0.5 : 1,
              }}
            >
              + 添加 MCP 服务器
            </button>
            {mcpSaveMsg && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(34,197,94,0.85)', textAlign: 'center' }}>{mcpSaveMsg}</div>
            )}
            <div style={{ marginTop: 14, padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', fontSize: 11, color: 'var(--theme-text-muted)', lineHeight: 1.7 }}>
              💡 推荐：<code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>@modelcontextprotocol/server-github</code>（GitHub 操作）、
              <code style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>@modelcontextprotocol/server-puppeteer</code>（浏览器自动化）。
              配置后重启应用生效。
            </div>
          </>
        )}

        {activeTab === 'mcp' && isEditingMcp && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>服务器名称（唯一标识符）</label>
              <input
                type="text"
                value={mcpForm.name}
                onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })}
                style={{ ...inputStyle, ...(editingMcpName !== null ? { opacity: 0.6 } : {}) }}
                placeholder="e.g., github, puppeteer, sqlite"
                readOnly={editingMcpName !== null}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>命令</label>
              <input
                type="text"
                value={mcpForm.command}
                onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })}
                style={inputStyle}
                placeholder="e.g., npx, node, python"
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>参数（每行一个）</label>
              <textarea
                value={mcpForm.args}
                onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })}
                style={{ ...inputStyle, height: 90, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                placeholder={'-y\n@modelcontextprotocol/server-github'}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>环境变量（每行 KEY=VALUE，可选）</label>
              <textarea
                value={mcpForm.env}
                onChange={(e) => setMcpForm({ ...mcpForm, env: e.target.value })}
                style={{ ...inputStyle, height: 70, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                placeholder={'GITHUB_TOKEN=ghp_xxx\nANOTHER_KEY=value'}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                onClick={handleSaveMcp}
                disabled={operationBusy || !selectedExecutor?.connected || !mcpForm.name.trim() || !mcpForm.command.trim()}
                style={{
                  ...saveBtnStyle,
                  opacity: operationBusy || !selectedExecutor?.connected || !mcpForm.name.trim() || !mcpForm.command.trim() ? 0.5 : 1,
                }}
              >
                {operationBusy ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setIsEditingMcp(false)} style={cancelBtnStyle}>Back</button>
            </div>
          </>
        )}

        {/* Backend 选择性导入 / 导出 */}
        {transferState && (
          <div style={{ ...overlayStyle, zIndex: 1120 }}>
            <div
              role="dialog"
              aria-modal="true"
              aria-label={transferState.mode === 'export' ? '选择导出的 Backend' : '选择导入的 Backend'}
              style={{ ...panelStyle, width: 'min(92vw, 560px)', maxWidth: 560 }}
              onClick={(event) => event.stopPropagation()}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, color: 'var(--theme-text)' }}>
                    {transferState.mode === 'export' ? '选择要导出的 Backend' : '预览并选择要导入的 Backend'}
                  </h3>
                  <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.5, color: 'var(--theme-text-muted)' }}>
                    目标节点：{selectedExecutor?.label || targetExecKey}
                    {transferState.mode === 'import' ? ` · 文件：${transferState.fileName}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setTransferState(null)}
                  disabled={operationBusy}
                  style={closeBtnStyle}
                  aria-label="关闭"
                >✕</button>
              </div>

              <div style={{
                marginBottom: 10, padding: '8px 10px', borderRadius: 7,
                border: '1px solid rgba(245,158,11,0.25)', background: 'rgba(245,158,11,0.08)',
                color: 'var(--theme-text-muted)', fontSize: 10.5, lineHeight: 1.55,
              }}>
                配置文件可能包含 API Key、Token 和代理信息，请只保存到可信位置。
                {transferState.mode === 'import' && ' 导入采用原子合并，未勾选及本节点其他 Backend 均保持不变。'}
              </div>

              {operationMessage?.kind === 'error' && (
                <div style={{
                  marginBottom: 10, padding: '8px 10px', borderRadius: 7,
                  border: '1px solid rgba(239,68,68,.28)', background: 'rgba(239,68,68,.1)',
                  color: 'rgba(248,113,113,.98)', fontSize: 11, lineHeight: 1.5,
                }}>
                  {operationMessage.text}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <div style={{ color: 'var(--theme-text)', fontSize: 12 }}>
                  已选择 <strong>{transferState.selectedIds.size}</strong> 项
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    style={{ ...cancelBtnStyle, flex: 'none', padding: '5px 9px', fontSize: 11 }}
                    onClick={() => setTransferState((current) => {
                      if (!current) return current;
                      const ids = current.mode === 'export'
                        ? backends.map((item) => item.id)
                        : current.items.filter((item) => !item.protected).map((item) => item.id);
                      return { ...current, selectedIds: new Set(ids) };
                    })}
                  >全选</button>
                  <button
                    type="button"
                    style={{ ...cancelBtnStyle, flex: 'none', padding: '5px 9px', fontSize: 11 }}
                    onClick={() => setTransferState((current) => (
                      current ? { ...current, selectedIds: new Set<string>() } : current
                    ))}
                  >清空</button>
                </div>
              </div>

              <div style={{
                maxHeight: 'min(42vh, 360px)', overflowY: 'auto', marginBottom: 12,
                border: '1px solid var(--theme-border)', borderRadius: 8,
              }}>
                {transferState.mode === 'export' ? backends.map((backend) => (
                  <label key={backend.id} style={transferRowStyle}>
                    <input
                      type="checkbox"
                      checked={transferState.selectedIds.has(backend.id)}
                      onChange={(event) => toggleTransferSelection(backend.id, event.target.checked)}
                      style={{ width: 15, height: 15, accentColor: 'var(--theme-accent)', flexShrink: 0 }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', color: 'var(--theme-text)', fontSize: 12, fontWeight: 600 }}>
                        {backend.label}{backend.pinned ? ' · 固定' : ''}
                      </span>
                      <span style={{ display: 'block', marginTop: 2, color: 'var(--theme-text-muted)', fontSize: 10.5, overflowWrap: 'anywhere' }}>
                        {backend.id} · {backend.type} · {backend.enabled === false ? '已停用' : '已启用'}
                      </span>
                    </span>
                  </label>
                )) : transferState.items.length === 0 ? (
                  <div style={{ padding: 18, textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 12 }}>
                    文件中没有 Backend 配置
                  </div>
                ) : transferState.items.map((item) => (
                  <label
                    key={item.id}
                    style={{ ...transferRowStyle, opacity: item.protected ? 0.62 : 1, cursor: item.protected ? 'not-allowed' : 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      disabled={item.protected}
                      checked={!item.protected && transferState.selectedIds.has(item.id)}
                      onChange={(event) => toggleTransferSelection(item.id, event.target.checked)}
                      style={{ width: 15, height: 15, accentColor: 'var(--theme-accent)', flexShrink: 0 }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, color: 'var(--theme-text)', fontSize: 12, fontWeight: 600 }}>
                        {item.label}
                        <span style={{
                          padding: '1px 6px', borderRadius: 999, fontSize: 9.5, fontWeight: 500,
                          color: item.protected ? 'rgba(251,191,36,.95)' : item.conflict ? 'rgba(248,113,113,.95)' : 'rgba(74,222,128,.95)',
                          background: item.protected ? 'rgba(245,158,11,.12)' : item.conflict ? 'rgba(239,68,68,.12)' : 'rgba(34,197,94,.12)',
                        }}>
                          {item.protected ? '受保护，不导入' : item.conflict ? '同 ID 冲突' : '新增'}
                        </span>
                      </span>
                      <span style={{ display: 'block', marginTop: 2, color: 'var(--theme-text-muted)', fontSize: 10.5, overflowWrap: 'anywhere' }}>
                        {item.id} · {item.type} · {item.enabled === false ? '已停用' : '已启用'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              {transferState.mode === 'import' && transferState.items.some((item) => (
                item.conflict && !item.protected && transferState.selectedIds.has(item.id)
              )) && (
                <fieldset style={{
                  margin: '0 0 12px', padding: '9px 10px 10px', border: '1px solid var(--theme-border)',
                  borderRadius: 8, color: 'var(--theme-text)',
                }}>
                  <legend style={{ padding: '0 5px', fontSize: 11, color: 'var(--theme-text-muted)' }}>同 ID 项如何处理</legend>
                  <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 11.5, cursor: 'pointer', marginBottom: 7 }}>
                    <input
                      type="radio"
                      name="backend-import-conflict"
                      checked={transferState.conflictPolicy === 'skip'}
                      onChange={() => setTransferState((current) => (
                        current?.mode === 'import' ? { ...current, conflictPolicy: 'skip' } : current
                      ))}
                    />
                    跳过已有（更安全）
                  </label>
                  <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 11.5, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="backend-import-conflict"
                      checked={transferState.conflictPolicy === 'overwrite'}
                      onChange={() => setTransferState((current) => (
                        current?.mode === 'import' ? { ...current, conflictPolicy: 'overwrite' } : current
                      ))}
                    />
                    用导入文件覆盖已有配置
                  </label>
                </fieldset>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={transferState.mode === 'export' ? handleExportSelected : handleImportSelected}
                  disabled={operationBusy || transferState.selectedIds.size === 0}
                  style={{
                    ...saveBtnStyle,
                    opacity: operationBusy || transferState.selectedIds.size === 0 ? 0.5 : 1,
                  }}
                >
                  {operationBusy
                    ? '处理中…'
                    : transferState.mode === 'export'
                      ? `导出 ${transferState.selectedIds.size} 项`
                      : `合并导入 ${transferState.selectedIds.size} 项`}
                </button>
                <button
                  type="button"
                  onClick={() => setTransferState(null)}
                  disabled={operationBusy}
                  style={cancelBtnStyle}
                >取消</button>
              </div>
            </div>
          </div>
        )}

        {/* 删除确认对话框 - 有依赖的 session 时 */}
        {backendToDelete && dependentSessions.length > 0 && (
          <div style={overlayStyle}>
            <div style={{ ...panelStyle, width: 'auto', maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600, color: 'var(--theme-text)' }}>
                删除后端将影响 {dependentSessions.length} 个会话
              </h3>
              <p style={{ fontSize: 13, color: 'var(--theme-text)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
                后端 <strong style={{ color: 'rgba(255,100,100,0.9)' }}>{backendToDelete.label}</strong> 当前被以下会话引用：
              </p>
              <div style={{ maxHeight: 150, overflowY: 'auto', marginBottom: 16, background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: 12 }}>
                {dependentSessions.slice(0, 8).map((s) => (
                  <div key={s.id} style={{ fontSize: 12, color: 'var(--theme-text)', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ flex: 1 }}>{s.title || s.workingDir}</span>
                    <span style={{ fontSize: 10, color: 'var(--theme-text-muted)' }}>{s.messageCount} 条消息</span>
                  </div>
                ))}
                {dependentSessions.length > 8 && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', textAlign: 'center', marginTop: 8 }}>
                    还有 {dependentSessions.length - 8} 个会话...
                  </div>
                )}
              </div>

              {/* 选择目标后端 */}
              <div style={{ marginBottom: 16 }}>
                <p style={{ fontSize: 13, color: 'var(--theme-text)', margin: '0 0 8px 0' }}>
                  请选择目标后端，将这些会话迁移到：
                </p>
                <TargetBackendSelector
                  backends={backends}
                  currentBackendId={backendToDelete.id}
                  onSelected={(id) => {
                    // Store selected target backend for migration
                    window.__targetBackendForMigration = id;
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={confirmDeleteBackend}
                  disabled={operationBusy}
                  style={{ ...confirmBtnStyle, flex: 1, opacity: operationBusy ? 0.5 : 1 }}
                >
                  {operationBusy ? '处理中…' : '迁移并删除'}
                </button>
                <button onClick={() => { setBackendToDelete(null); setDependentSessions([]); }} style={cancelBtnStyle}>
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 删除确认对话框 - 没有依赖的 session 时 */}
        {backendToDelete && dependentSessions.length === 0 && (
          <div style={overlayStyle}>
            <div style={{ ...panelStyle, width: 'auto', maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600, color: 'var(--theme-text)' }}>
                确认删除后端
              </h3>
              <p style={{ fontSize: 13, color: 'var(--theme-text)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
                确定要删除后端 <strong style={{ color: 'rgba(255,100,100,0.9)' }}>{backendToDelete.label}</strong> 吗？
              </p>
              <p style={{ fontSize: 12, color: 'var(--theme-text-muted)', margin: '0 0 16px 0' }}>
                此操作不可撤销。
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={confirmDeleteBackend}
                  disabled={operationBusy}
                  style={{ ...confirmBtnStyle, flex: 1, opacity: operationBusy ? 0.5 : 1 }}
                >
                  {operationBusy ? '处理中…' : '删除'}
                </button>
                <button onClick={() => { setBackendToDelete(null); setDependentSessions([]); }} style={cancelBtnStyle}>
                  取消
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ---- styles ---- */
const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  padding: 16, boxSizing: 'border-box', overflowY: 'auto',
};

const panelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary)', border: '1px solid var(--theme-border)', borderRadius: 12,
  padding: 'var(--ui-space-xl, 24px)', width: '90%', maxWidth: 520,
  maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto',
  overscrollBehavior: 'contain', boxSizing: 'border-box',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--theme-text-muted)',
  fontSize: 18, cursor: 'pointer', padding: '4px 8px',
};

const backendItemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 'var(--ui-space-md, 12px)',
  padding: 'var(--ui-space-md, 12px)', marginBottom: 'var(--ui-space-sm, 8px)',
  background: 'rgba(255,255,255,0.05)', borderRadius: 8,
  cursor: 'pointer', transition: 'all 0.15s',
};

const deleteBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', fontSize: 15,
  cursor: 'pointer', padding: '4px 8px',
  color: 'var(--theme-text-muted, #656d76)',
  transition: 'color 0.15s',
};

const copyBtnStyle: React.CSSProperties = {
  padding: '4px 7px', borderRadius: 6,
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  color: 'var(--theme-text-muted)', fontSize: 11, cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const addBtnStyle: React.CSSProperties = {
  width: '100%', padding: 12, borderRadius: 8,
  background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)',
  color: 'rgba(34,197,94,0.9)', fontSize: 14, fontWeight: 500,
  cursor: 'pointer',
};

const transferBtnStyle: React.CSSProperties = {
  padding: '10px 11px', borderRadius: 8,
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  color: 'var(--theme-text)', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', whiteSpace: 'nowrap',
};

const transferRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '10px 11px', borderBottom: '1px solid var(--theme-border)',
  background: 'var(--theme-input-bg)', cursor: 'pointer',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 500, color: 'var(--theme-text)',
  display: 'block', marginBottom: 6,
};

const selectStyle: React.CSSProperties = {
  width: '100%', padding: 'var(--ui-field-padding, 10px 12px)',
  background: 'var(--theme-bg-tertiary)',
  border: '1px solid var(--theme-border)', borderRadius: 6,
  color: 'var(--theme-text)', fontSize: 13, outline: 'none', cursor: 'pointer',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
  WebkitAppearance: 'none',
  MozAppearance: 'none',
  appearance: 'none',
};

const selectWrapperStyle: React.CSSProperties = {
  position: 'relative',
};

const saveBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 8,
  background: 'rgba(99,102,241,0.8)', border: 'none',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 8,
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  color: 'var(--theme-text)', fontSize: 14, cursor: 'pointer',
};

const confirmBtnStyle: React.CSSProperties = {
  flex: 1, padding: 10, borderRadius: 8,
  background: 'rgba(239,68,68,0.8)', border: 'none',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
};

/* ---- Target Backend Selector ---- */
interface TargetBackendSelectorProps {
  backends: BackendConfig[];
  currentBackendId: string;
  onSelected: (id: string) => void;
}

const TargetBackendSelector: React.FC<TargetBackendSelectorProps> = ({
  backends,
  currentBackendId,
  onSelected,
}) => {
  const remainingBackends = backends.filter(
    b => b.id !== currentBackendId && b.enabled !== false,
  );
  const [selectedId, setSelectedId] = useState(remainingBackends[0]?.id || '');

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedId(e.target.value);
    onSelected(e.target.value);
  }, [onSelected]);

  if (remainingBackends.length === 0) {
    return (
      <div style={{ padding: 12, background: 'rgba(239,68,68,0.2)', borderRadius: 6, color: 'rgba(255,100,100,0.9)', fontSize: 13 }}>
        没有其他可用的后端。删除此后端前，请先创建新的后端配置。
      </div>
    );
  }

  return (
    <div style={selectWrapperStyle}>
      <select
        value={selectedId}
        onChange={handleChange}
        style={selectStyle}
      >
        {remainingBackends.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label} ({b.type})
          </option>
        ))}
      </select>
    </div>
  );
};
