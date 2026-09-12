import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, SkillInfo } from '../api';
import { SkillMarketDialog } from './SkillMarketDialog';
import { SkillRuntimeDialog } from './SkillRuntimeDialog';

// 注入卡片悬停样式
if (typeof document !== 'undefined' && !document.getElementById('repo-panel-css')) {
  const s = document.createElement('style');
  s.id = 'repo-panel-css';
  s.textContent = `
    .repo-card:hover { border-color: var(--theme-accent, #7aa2f7) !important; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .repo-card:hover .repo-card-actions { opacity: 1 !important; }
    .repo-card:hover .repo-card-star { opacity: 1 !important; }
    .repo-card.repo-card-default { border-color: rgba(234,197,95,0.55) !important; box-shadow: 0 0 0 1px rgba(234,197,95,0.18) inset; }
    .repo-card.repo-card-default .repo-card-star { opacity: 1 !important; }
    .repo-column-separator { border-right: 1px solid var(--theme-border); }
  `;
  document.head.appendChild(s);
}

// ═══════════════════════════════════════
//  Types
// ═══════════════════════════════════════
type SkillItem = SkillInfo;
interface PromptItem {
  id?: string;
  name: string;
  content: string;
  icon: string;
  createdAt?: number;
  updatedAt?: number;
  isDefault?: boolean;
}
interface Props {
  embedded?: boolean;
  onOpenMarket?: () => void;
  revision?: number;
  open: boolean;
  workingDir: string;
  onClose: () => void;
  onEditingChange?: (editing: boolean) => void;
}

// 常用 emoji 列表
const ICONS = ['📝', '🚀', '🎯', '🔧', '💡', '🛡️', '📊', '🎨', '🔬', '📦', '⚡', '🌐', '🤖', '🧩', '📋', '🔑'];

// 解析 SKILL.md frontmatter 中的 backend 字段
function parseSkillBackend(content: string): string {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return '';
  const line = m[1].match(/backend:\s*(.+)/);
  return line ? line[1].trim().replace(/^["']|["']$/g, '') : '';
}

// 更新 SKILL.md frontmatter 中的 backend 字段
function setSkillBackend(content: string, backendId: string): string {
  const fmMatch = content.match(/^(---\s*\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    // 没有 frontmatter，不处理
    return content;
  }
  const fmBody = fmMatch[2];
  const rest = content.slice(fmMatch[0].length);
  const hasBackend = /^backend:\s*.*/m.test(fmBody);

  if (backendId) {
    if (hasBackend) {
      // 替换已有的 backend 行
      const newFmBody = fmBody.split('\n').map(l =>
        /^backend:\s*/.test(l) ? `backend: ${backendId}` : l
      ).join('\n');
      return `${fmMatch[1]}${newFmBody}${fmMatch[3]}${rest}`;
    } else {
      // 在 frontmatter 末尾添加
      return `${fmMatch[1]}${fmBody}\nbackend: ${backendId}${fmMatch[3]}${rest}`;
    }
  } else {
    // 移除 backend 行
    if (hasBackend) {
      const newFmBody = fmBody.split('\n').filter(l => !/^backend:\s*/.test(l)).join('\n');
      return `${fmMatch[1]}${newFmBody}${fmMatch[3]}${rest}`;
    }
    return content;
  }
}

// ═══════════════════════════════════════
//  内置 Skill 类型注册表
// ═══════════════════════════════════════
interface SkillTypePreset {
  id: string;
  icon: string;
  label: string;
  description: string;
  backendType?: string;  // 匹配 backend.type（需要选 backend 的类型）
  builtin?: boolean;     // 内置类型，不需要选 backend
  template: (backendId?: string) => { name: string; content: string };
}

const SKILL_TYPE_PRESETS: SkillTypePreset[] = [
  {
    id: 'python-script',
    icon: '🐍',
    label: 'Python 脚本',
    description: '本地执行 Python 脚本，支持凭据注入，适合爬虫/API 调用等',
    builtin: true,
    template: () => ({
      name: 'my-script',
      content: [
        '---',
        'name: my-script',
        'description: 描述此脚本的用途和触发时机（最多 250 字符）',
        'type: python-script',
        'input_schema:',
        '  type: object',
        '  properties:',
        '    query:',
        '      type: string',
        '      description: 输入参数',
        '  required:',
        '    - query',
        '---',
        '',
        '## Instructions',
        '',
        '描述当前 Agent 应该在什么情况下调用此 Skill，',
        '以及调用时需要传入什么参数。',
        '',
        '脚本文件路径：`call.py`（与 SKILL.md 同目录）',
        '在命令中使用 `{{SKILL_DIR}}/call.py`，部署时会自动解析为当前 Agent 的原生目录。',
        '凭据通过 `SKILL_SECRETS` 环境变量注入（JSON 格式）。',
      ].join('\n'),
    }),
  },
  {
    id: 'image-generation',
    icon: '🎨',
    label: '图像生成',
    description: '文生图 / 图生图，支持尺寸和参考图',
    backendType: 'dashscope-image',
    template: (backendId) => ({
      name: 'generate-image',
      content: [
        '---',
        'name: generate-image',
        'description: 仅当用户明确要求画图、生成图像、创建插画时才调用。普通对话、问答、对比分析、写代码等文字类请求绝对不要调用此 Skill。',
        `backend: ${backendId}`,
        'input_schema:',
        '  type: object',
        '  properties:',
        '    prompt:',
        '      type: string',
        '      description: 图片内容的详细描述',
        '    ref_images:',
        '      type: array',
        '      items:',
        '        type: string',
        '      maxItems: 3',
        '      description: 可选参考图 URL 数组，图生图时按顺序传入 1-3 张',
        '    size:',
        '      type: string',
        '      description: 可选输出尺寸或比例，例如 1024*1024、16:9；留空自动推荐',
        '  required:',
        '    - prompt',
        '---',
      ].join('\n'),
    }),
  },
  {
    id: 'web-search',
    icon: '🔍',
    label: '网页搜索',
    description: '支持 Tavily（推荐，配 Key）或 DuckDuckGo（免费 fallback）',
    builtin: true,
    template: () => ({
      name: 'web-search',
      content: [
        '---',
        'name: web-search',
        'description: 仅当用户明确需要搜索网页、查找最新资料时调用。普通对话和已知知识的问答不要调用。',
        'type: web-search',
        'input_schema:',
        '  type: object',
        '  properties:',
        '    prompt:',
        '      type: string',
        '      description: 搜索关键词',
        '  required:',
        '    - prompt',
        '---',
      ].join('\n'),
    }),
  },
  {
    id: 'web-fetch',
    icon: '📄',
    label: '网页抓取',
    description: '抓取 URL 页面内容并提取正文，免费，无需配置',
    builtin: true,
    template: () => ({
      name: 'web-fetch',
      content: [
        '---',
        'name: web-fetch',
        'description: 当需要获取某个网页URL的具体内容时调用。传入URL，返回页面正文文本。',
        'type: web-fetch',
        'input_schema:',
        '  type: object',
        '  properties:',
        '    url:',
        '      type: string',
        '      description: 要抓取的网页URL',
        '  required:',
        '    - url',
        '---',
      ].join('\n'),
    }),
  },
];

// ═══════════════════════════════════════
//  RepoPanel — Skill + Prompt 仓库面板
// ═══════════════════════════════════════
export const RepoPanel: React.FC<Props> = ({ open, workingDir, onClose, onEditingChange, embedded, onOpenMarket, revision }) => {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  // 编辑状态
  const [editingType, setEditingType] = useState<'skill' | 'prompt' | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingContent, setEditingContent] = useState('');
  const [editingIcon, setEditingIcon] = useState('📝');
  const [editingOrigName, setEditingOrigName] = useState<string | null>(null); // null = 新建
  const [editingSkillItem, setEditingSkillItem] = useState<SkillItem | null>(null); // 原始 skill 对象
  const [editingLocked, setEditingLocked] = useState(false); // 包安装 skill 的编辑锁
  const [editingOrigContent, setEditingOrigContent] = useState(''); // 原始内容（用于重置）
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  // Backend Skill：后端列表（用于下拉选择）
  const [backends, setBackends] = useState<{ id: string; label: string; type?: string }[]>([]);
  // 新建 Skill 时的类型选择
  const [showSkillTypeSelector, setShowSkillTypeSelector] = useState(false);
  // 删除二次确认
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'skill' | 'prompt'; name: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // 安装插件包
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<{ name: string; version: string; count?: number; format?: string } | null>(null);
  const [installError, setInstallError] = useState('');
  const [showSkillMarket, setShowSkillMarket] = useState(false);
  const [runtimeNames, setRuntimeNames] = useState<string[]>([]);
  // Secrets 配置
  type SecretsField = { key: string; label: string; type: string; required?: boolean; placeholder?: string };
  const [secretsSkill, setSecretsSkill] = useState<string | null>(null);
  const [secretsSchema, setSecretsSchema] = useState<{ fields: SecretsField[] } | null>(null);
  const [secretsValues, setSecretsValues] = useState<Record<string, string>>({});
  const [secretsPresence, setSecretsPresence] = useState<string[]>([]);
  const [savingSecrets, setSavingSecrets] = useState(false);

  const refresh = useCallback(async () => {
    const [sk, pr, bks] = await Promise.all([
      api.listSkills(workingDir),
      api.listPrompts(),
      api.getBackends().catch(() => []),
    ]);
    setSkills(sk || []);
    setPrompts(pr || []);
    setBackends((bks || []).map((b: any) => ({ id: b.id, label: b.label || b.id, type: b.type })));
  }, [workingDir]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh, revision]);

  useEffect(() => {
    onEditingChange?.(editingType !== null);
  }, [editingType, onEditingChange]);

  // ── 打开编辑器 ──
  const openEditor = useCallback((type: 'skill' | 'prompt', item?: SkillItem | PromptItem) => {
    setEditingType(type);
    if (item) {
      setEditingName(item.name);
      setEditingContent(item.content || '');
      setEditingIcon((item as PromptItem).icon || '📝');
      setEditingOrigName(item.name);
      setEditingSkillItem(type === 'skill' ? item as SkillItem : null);
      const isPackage = type === 'skill' && !!(
        (item as SkillItem).manifest || (item as SkillItem).source
      );
      setEditingLocked(isPackage);
      setEditingOrigContent(item.content || '');
    } else {
      setEditingName('');
      // 新建 Skill 时提供默认 frontmatter 模板（确保有 frontmatter 可以选择 backend）
      setEditingContent(type === 'skill' ? '---\nname: \ndescription: \n---\n\n## Instructions\n\n' : '');
      setEditingIcon('📝');
      setEditingOrigName(null);
      setEditingSkillItem(null);
      setEditingLocked(false);
      setEditingOrigContent('');
    }
    setShowIconPicker(false);
    setTimeout(() => nameRef.current?.focus(), 50);
  }, []);

  const closeEditor = useCallback(() => {
    setEditingType(null);
    setEditingOrigName(null);
  }, []);

  // ── 保存 ──
  const handleSave = useCallback(async () => {
    const name = editingName.trim();
    if (!name) return;
    setSaving(true);
    try {
      if (editingType === 'skill') {
        if (editingOrigName && editingOrigName !== name) {
          await api.renameSkill(editingOrigName, name, editingContent);
        } else {
          await api.saveSkill(name, editingContent);
        }
      } else if (editingType === 'prompt') {
        if (editingOrigName && editingOrigName !== name) {
          await api.renamePrompt(editingOrigName, name, editingContent);
        } else {
          await api.savePrompt(name, editingContent, editingIcon);
        }
        // 保存 icon（改名后也需要更新）
        if (editingOrigName !== name || editingIcon) {
          await api.updatePromptIcon(name, editingIcon);
        }
      }
      await refresh();
      closeEditor();
    } finally {
      setSaving(false);
    }
  }, [editingType, editingName, editingContent, editingIcon, editingOrigName, refresh, closeEditor]);

  // ── 切换默认档 ──
  // 默认档在新建 session 时会被自动绑定；这里做乐观更新 + 后台持久化
  const toggleDefault = useCallback(async (type: 'skill' | 'prompt', name: string, next: boolean) => {
    if (type === 'skill') {
      setSkills(prev => prev.map(s => s.name === name ? { ...s, isDefault: next } : s));
      const res = await api.setSkillDefault(name, next);
      if (res.status !== 'ok') {
        // 回滚 + 刷新
        setSkills(prev => prev.map(s => s.name === name ? { ...s, isDefault: !next } : s));
        await refresh();
      }
    } else {
      setPrompts(prev => prev.map(p => p.name === name ? { ...p, isDefault: next } : p));
      const res = await api.setPromptDefault(name, next);
      if (res.status !== 'ok') {
        setPrompts(prev => prev.map(p => p.name === name ? { ...p, isDefault: !next } : p));
        await refresh();
      }
    }
  }, [refresh]);

  // ── 删除：先弹确认框 ──
  const handleDelete = useCallback((type: 'skill' | 'prompt', name: string) => {
    setDeleteConfirm({ type, name });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    const { type, name } = deleteConfirm;
    if (type === 'skill') await api.deleteSkill(name);
    else await api.deletePrompt(name);
    setDeleteConfirm(null);
    await refresh();
  }, [deleteConfirm, refresh]);

  // ── 安装插件包 ──
  const handleInstallFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setInstalling(true);
    setInstallError('');
    try {
      // Qt 原生环境有 file.path；浏览器没有，改用 FileReader 读取 base64
      const nativePath: string = (file as any).path || '';
      let res: any;
      if (nativePath) {
        res = await api.installSkillPackage(nativePath);
      } else {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            // data:application/zip;base64,XXXX → 取 XXXX 部分
            resolve(result.split(',')[1] || '');
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        res = await api.installSkillPackage('', base64);
      }
      if (res.status === 'ok') {
        await refresh();
        const m = res.manifest;
        const installedSkills = Array.isArray((res as any).skills) ? (res as any).skills : [];
        setRuntimeNames(installedSkills.length ? installedSkills.map((s: any) => s.name || s.id).filter(Boolean) : [m?.name || m?.id].filter(Boolean));
        setInstallResult({
          name: installedSkills.length > 1
            ? `${installedSkills[0]?.name || installedSkills[0]?.id || 'Skill'} 等`
            : m?.name || m?.id || '未知',
          version: m?.version || '',
          count: installedSkills.length || 1,
          format: (res as any).format || '',
        });
        if (m?.id) {
          const schema = await api.getSkillSecretsSchema(m.id);
          if (schema?.fields?.length) {
            setSecretsSkill(m.id);
            setSecretsSchema(schema);
            setSecretsValues({});
            setSecretsPresence([]);
          }
        }
      } else {
        setInstallError(res.message || 'Skill 包安装失败');
      }
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [refresh]);

  // ── 打开 Secrets 对话框 ──
  const openSecretsDialog = useCallback(async (skillName: string) => {
    const [schema, presence] = await Promise.all([
      api.getSkillSecretsSchema(skillName),
      api.getSkillSecretsPresence(skillName),
    ]);
    if (!schema?.fields?.length) return;
    setSecretsSkill(skillName);
    setSecretsSchema(schema);
    setSecretsValues({});
    setSecretsPresence(presence);
  }, []);

  const handleSaveSecrets = useCallback(async () => {
    if (!secretsSkill) return;
    setSavingSecrets(true);
    try {
      const res = await api.setSkillSecrets(secretsSkill, secretsValues);
      if (res.status === 'ok') {
        setSecretsSkill(null);
        await refresh();
      }
    } finally {
      setSavingSecrets(false);
    }
  }, [secretsSkill, secretsValues, refresh]);

  if (!open) return null;

  // 编辑器模式
  if (editingType) {
    return (
      <div style={{ ...panelEditorStyle, ...(embedded ? { flex: 1, minHeight: 0, maxHeight: 'none' } : {}) }}>
        <div style={editorWrapStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            {editingType === 'prompt' && (
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowIconPicker(!showIconPicker)}
                  style={iconBtnStyle}
                  title="选择图标"
                >{editingIcon}</button>
                {showIconPicker && (
                  <div style={iconPickerStyle}>
                    {ICONS.map(ic => (
                      <button
                        key={ic}
                        onClick={() => { setEditingIcon(ic); setShowIconPicker(false); }}
                        style={{ ...iconOptionStyle, background: ic === editingIcon ? 'var(--theme-accent-bg)' : 'transparent' }}
                      >{ic}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <input
              ref={nameRef}
              value={editingName}
              onChange={e => setEditingName(e.target.value)}
              placeholder={editingType === 'skill' ? 'Skill 名称' : 'Prompt 名称'}
              disabled={!!(editingSkillItem?.manifest || editingSkillItem?.source)}
              style={{ ...nameInputStyle, ...((editingSkillItem?.manifest || editingSkillItem?.source) ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
            />
            <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', textTransform: 'uppercase' }}>
              {editingType === 'skill' ? 'Skill' : 'Prompt'}
            </span>
          </div>
          {/* Backend Skill：后端选择下拉框（仅 Skill 类型显示） */}
          {editingType === 'skill' && backends.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap' }}>路由后端</span>
              <select
                value={parseSkillBackend(editingContent)}
                onChange={e => {
                  if (!editingSkillItem?.manifest && !editingSkillItem?.source) setEditingContent(prev => setSkillBackend(prev, e.target.value));
                }}
                disabled={!!(editingSkillItem?.manifest || editingSkillItem?.source)}
                style={{ ...backendSelectStyle, ...((editingSkillItem?.manifest || editingSkillItem?.source) ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
              >
                <option value="">无 (传统 Skill)</option>
                {backends.map(b => (
                  <option key={b.id} value={b.id}>{b.label}</option>
                ))}
              </select>
              <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
                {parseSkillBackend(editingContent) ? '🔗 Backend Skill' : '📋 指令型 Skill'}
              </span>
            </div>
          )}
          {/* 包安装 skill 的锁状态栏 */}
          {(editingSkillItem?.manifest || editingSkillItem?.source) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
              padding: '5px 10px', borderRadius: 6,
              background: editingLocked ? 'rgba(99,102,241,0.08)' : 'rgba(234,197,95,0.08)',
              border: `1px solid ${editingLocked ? 'rgba(99,102,241,0.2)' : 'rgba(234,197,95,0.25)'}` }}>
              <span style={{ fontSize: 13 }}>{editingLocked ? '🔒' : '🔓'}</span>
              <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', flex: 1 }}>
                {editingLocked
                  ? editingSkillItem.manifest
                    ? `📦 AgentWithU 包 v${editingSkillItem.manifest.version || '?'} · 点击解锁后可编辑`
                    : `🌐 标准 Agent Skill · ${editingSkillItem.source?.label || editingSkillItem.source?.repository || '外部来源'} · 点击解锁后可编辑`
                  : '已解锁编辑，修改将覆盖原始内容'}
              </span>
              {editingSkillItem?.hasSecretsSchema && (
                <button
                  onClick={() => { closeEditor(); openSecretsDialog(editingName); }}
                  style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer', borderRadius: 4,
                    background: 'rgba(234,197,95,0.12)', border: '1px solid rgba(234,197,95,0.3)',
                    color: 'rgba(234,197,95,0.9)' }}
                >🔑 凭据</button>
              )}
              {!editingLocked && editingContent !== editingOrigContent && (
                <button
                  onClick={() => setEditingContent(editingOrigContent)}
                  style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer', borderRadius: 4,
                    background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)',
                    color: 'rgba(239,68,68,0.8)' }}
                  title="恢复原始内容"
                >↺ 重置</button>
              )}
              <button
                onClick={() => setEditingLocked(l => !l)}
                style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer', borderRadius: 4,
                  background: editingLocked ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${editingLocked ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.12)'}`,
                  color: editingLocked ? 'rgba(99,102,241,0.9)' : 'var(--theme-text-muted)' }}
              >{editingLocked ? '解锁' : '锁定'}</button>
            </div>
          )}
          <textarea
            value={editingContent}
            onChange={e => !editingLocked && setEditingContent(e.target.value)}
            readOnly={editingLocked}
            placeholder={editingType === 'skill' ? '# Skill 内容 (SKILL.md 格式)\n---\ntrigger: ...\n---\n\n指令内容...' : '输入 Prompt 模板内容…'}
            style={{ ...contentTextareaStyle,
              ...(editingLocked ? { opacity: 0.6, cursor: 'default',
                background: 'var(--theme-bg)', color: 'var(--theme-text-muted)' } : {}) }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={closeEditor} style={cancelBtnStyle}>取消</button>
            {!editingLocked && (
              <button onClick={handleSave} disabled={saving || !editingName.trim()} style={saveBtnStyle}>
                {saving ? '保存中…' : '保存'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 卡片列表模式
  return (
    <div className={embedded ? 'repo-workbench' : undefined} style={{ ...panelStyle, ...(embedded ? { flex: 1, minHeight: 0 } : {}) }}>
      <style>{`.repo-workbench .repo-cards { max-height:none!important; align-content:flex-start; }
        @media(max-width:760px) { .repo-workbench .repo-columns { flex-direction:column; gap:16px!important; overflow:auto!important; }
          .repo-workbench .repo-column { border:0!important; padding:0!important; flex:none!important; }
          .repo-workbench .repo-cards { overflow:visible!important; } }`}</style>
      <div className="repo-columns" style={{ display: 'flex', gap: 24, flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* ── 左：Skills ── */}
        <div className="repo-column" style={{ ...columnStyle, borderRight: '1px solid var(--theme-border)', paddingRight: 24 }}>
          <div style={{ ...columnHeaderStyle, border: 'none', padding: 0 }}>
            <span>⚡ Skills</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                onClick={() => onOpenMarket ? onOpenMarket() : setShowSkillMarket(true)}
                title="浏览并安装标准 Agent Skills"
                style={{ ...addBtnStyle, fontSize: 11, padding: '2px 8px', width: 'auto' }}
              >🛍 市场</button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={installing}
                title="从 .awu 或标准 Agent Skill ZIP 安装"
                aria-label="从文件安装 Skill"
                style={{ ...addBtnStyle, fontSize: 11, padding: '2px 7px' }}
              >{installing ? '…' : '📦'}</button>
              <button onClick={() => setShowSkillTypeSelector(true)} style={addBtnStyle} title="新建 Skill（开发者）" aria-label="新建 Skill（开发者）">＋</button>
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept=".awu,.zip" style={{ display: 'none' }} onChange={handleInstallFile} />
          <div className="repo-cards" style={cardGridStyle}>
            {skills.map(s => (
              <div
                key={s.name}
                className={`repo-card${s.isDefault ? ' repo-card-default' : ''}`}
                style={cardStyle}
                onClick={() => openEditor('skill', s)}
              >
                <div style={cardIconStyle}>
                  {parseSkillBackend(s.content || '') ? '🔗' : s.type === 'python-script' || s.hasCallPy ? '🐍' : '⚡'}
                </div>
                <div style={cardNameStyle}>{s.name}</div>
                <button style={{ ...addBtnStyle, width: 'auto', height: 'auto', minHeight: 28, padding: '4px 6px', whiteSpace: 'nowrap', fontSize: 11, marginTop: 5 }} title="检查此技能在执行节点的资源、依赖与配置"
                  onClick={e => { e.stopPropagation(); setRuntimeNames([s.name]); }}>运行准备 / 状态</button>
                <div style={{ position: 'absolute', top: 4, left: 4, display: 'flex', gap: 2 }}>
                  {s.manifest && (
                    <span title={`插件包安装 v${s.manifest.version || '?'}`}
                      style={{ fontSize: 11, lineHeight: 1 }}>📦</span>
                  )}
                  {s.format === 'agent-skills' && (
                    <span title={`标准 Agent Skills 格式${s.source?.label ? ` · ${s.source.label}` : ''}`}
                      style={{ fontSize: 10, lineHeight: 1, color: 'var(--theme-accent)' }}>STD</span>
                  )}
                  {s.hasSecretsSchema && (
                    <span
                      onClick={e => { e.stopPropagation(); openSecretsDialog(s.name); }}
                      title={s.hasSecrets ? '已配置凭据，点击修改' : '需要配置凭据'}
                      style={{ fontSize: 11, cursor: 'pointer', lineHeight: 1,
                        color: s.hasSecrets ? 'rgba(234,197,95,0.9)' : 'rgba(255,255,255,0.3)' }}
                    >🔑</span>
                  )}
                </div>
                <span
                  className="repo-card-star"
                  onClick={e => { e.stopPropagation(); toggleDefault('skill', s.name, !s.isDefault); }}
                  title={s.isDefault ? '取消默认档（新 session 不再自动绑定）' : '设为默认档（每个新 session 自动绑定）'}
                  style={{
                    ...cardStarStyle,
                    opacity: s.isDefault ? 1 : 0,
                    color: s.isDefault ? 'rgba(234,197,95,0.95)' : 'rgba(255,255,255,0.4)',
                  }}
                >{s.isDefault ? '★' : '☆'}</span>
                <div className="repo-card-actions" style={cardActionsStyle}>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete('skill', s.name); }}
                    style={cardDelBtnStyle}
                    title="删除"
                  >×</button>
                </div>
              </div>
            ))}
            {skills.length === 0 && <div style={emptyStyle}>暂无 Skill</div>}
          </div>
        </div>

        {/* ── 右：Prompts ── */}
        <div className="repo-column" style={{ ...columnStyle, paddingLeft: 24 }}>
          <div style={{ ...columnHeaderStyle, border: 'none', padding: 0 }}>
            <span>📝 Prompts</span>
            <button onClick={() => openEditor('prompt')} style={addBtnStyle} title="新建 Prompt" aria-label="新建 Prompt">＋</button>
          </div>
          <div className="repo-cards" style={cardGridStyle}>
            {prompts.map(p => (
              <div
                key={p.id}
                className={`repo-card${p.isDefault ? ' repo-card-default' : ''}`}
                style={cardStyle}
                onClick={() => openEditor('prompt', p)}
              >
                <div style={cardIconStyle}>{p.icon || '📝'}</div>
                <div style={cardNameStyle}>{p.name}</div>
                <span
                  className="repo-card-star"
                  onClick={e => { e.stopPropagation(); toggleDefault('prompt', p.name, !p.isDefault); }}
                  title={p.isDefault ? '取消默认档（新 session 不再自动绑定）' : '设为默认档（每个新 session 自动绑定）'}
                  style={{
                    ...cardStarStyle,
                    opacity: p.isDefault ? 1 : 0,
                    color: p.isDefault ? 'rgba(234,197,95,0.95)' : 'rgba(255,255,255,0.4)',
                  }}
                >{p.isDefault ? '★' : '☆'}</span>
                <div className="repo-card-actions" style={cardActionsStyle}>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete('prompt', p.name); }}
                    style={cardDelBtnStyle}
                    title="删除"
                  >×</button>
                </div>
              </div>
            ))}
            {prompts.length === 0 && <div style={emptyStyle}>暂无 Prompt</div>}
          </div>
        </div>
      </div>

      {/* ── 新建 Skill 类型选择器 ── */}
      {showSkillTypeSelector && (
        <div style={deleteOverlayStyle} onClick={() => setShowSkillTypeSelector(false)}>
          <div style={{ ...deleteDialogStyle, width: 380 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600, color: 'var(--theme-text)' }}>
              新建 Skill <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--theme-text-muted)', marginLeft: 6 }}>开发者</span>
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* 系统增强型 */}
              {SKILL_TYPE_PRESETS.map(preset => {
                const matchingBackends = preset.backendType
                  ? backends.filter(b => b.type === preset.backendType) : [];
                // 需要 backend 的类型：没有匹配 backend 就不显示
                if (preset.backendType && matchingBackends.length === 0) return null;
                return (
                  <div key={preset.id} style={{
                    padding: '10px 12px', borderRadius: 8,
                    border: '1px solid var(--theme-border)', background: 'var(--theme-bg)',
                    transition: 'all 0.12s',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--theme-accent)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--theme-border)'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 18 }}>{preset.icon}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text)' }}>{preset.label}</span>
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' }}>
                        {preset.builtin ? '内置' : '系统增强'}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginBottom: 8 }}>{preset.description}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {preset.builtin ? (
                        /* 内置类型：直接创建，不需要选 backend */
                        <button
                          onClick={() => {
                            const { name, content } = preset.template();
                            setShowSkillTypeSelector(false);
                            openEditor('skill');
                            setTimeout(() => { setEditingName(name); setEditingContent(content); }, 0);
                          }}
                          style={{
                            padding: '4px 10px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
                            border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)',
                            color: 'var(--theme-accent)', transition: 'all 0.12s',
                          }}
                        >
                          创建
                        </button>
                      ) : matchingBackends.map(b => (
                        <button
                          key={b.id}
                          onClick={() => {
                            const { name, content } = preset.template(b.id);
                            setShowSkillTypeSelector(false);
                            openEditor('skill');
                            setTimeout(() => { setEditingName(name); setEditingContent(content); }, 0);
                          }}
                          style={{
                            padding: '4px 10px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
                            border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)',
                            color: 'var(--theme-text)', transition: 'all 0.12s',
                          }}
                        >
                          {b.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
              {/* 自定义 Skill */}
              <div
                style={{
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                  border: '1px dashed var(--theme-border)', background: 'var(--theme-bg)',
                  transition: 'all 0.12s',
                }}
                onClick={() => { setShowSkillTypeSelector(false); openEditor('skill'); }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--theme-accent)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--theme-border)'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>📋</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text)' }}>自定义 Skill</div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>自行编写 SKILL.md 指令内容</div>
                  </div>
                </div>
              </div>
            </div>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowSkillTypeSelector(false)} style={cancelBtnStyle}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 安装成功弹窗 ── */}
      {installResult && (
        <div style={deleteOverlayStyle} onClick={() => setInstallResult(null)}>
          <div style={{ ...deleteDialogStyle, width: 320, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>📦</div>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text)' }}>资源已导入</h3>
            <p style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>运行环境是否就绪，请查看“运行准备 / 状态”。</p>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--theme-text-muted)' }}>
              <strong style={{ color: 'var(--theme-text)' }}>{installResult.name}</strong>
              {installResult.version && (
                <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--theme-text-muted)' }}>v{installResult.version}</span>
              )}
              {installResult.count && installResult.count > 1 && (
                <span style={{ display: 'block', marginTop: 5, fontSize: 11, color: 'var(--theme-text-muted)' }}>
                  共安装 {installResult.count} 个标准 Skill
                </span>
              )}
            </p>
            <button onClick={() => setInstallResult(null)} style={deleteConfirmBtnStyle}>确定</button>
          </div>
        </div>
      )}

      {installError && (
        <div style={deleteOverlayStyle} onClick={() => setInstallError('')}>
          <div style={{ ...deleteDialogStyle, width: 380 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-error, #cf222e)' }}>
              Skill 安装失败
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 12, lineHeight: 1.55,
              color: 'var(--theme-text-muted)', overflowWrap: 'anywhere' }}>{installError}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setInstallError('')} style={deleteConfirmBtnStyle}>确定</button>
            </div>
          </div>
        </div>
      )}

      <SkillMarketDialog
        open={showSkillMarket}
        onClose={() => setShowSkillMarket(false)}
        onInstalled={async (name) => { await refresh(); if (name) { setShowSkillMarket(false); setRuntimeNames([name]); } }}
      />
      {runtimeNames.length > 0 && <SkillRuntimeDialog key={runtimeNames.join('|')} names={runtimeNames} onClose={() => setRuntimeNames([])} />}

      {/* ── Secrets 配置对话框 ── */}
      {secretsSkill && secretsSchema && (
        <div style={deleteOverlayStyle} onClick={() => setSecretsSkill(null)}>
          <div style={{ ...deleteDialogStyle, width: 400 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600, color: 'var(--theme-text)' }}>
              🔑 凭据配置：{secretsSkill}
            </h3>
            <p style={{ fontSize: 11, color: 'var(--theme-text-muted)', margin: '0 0 14px', lineHeight: 1.6 }}>
              保存在本地 <code>~/.agent-with-u/skill-secrets/</code>（chmod 600），<strong>永不传给大模型</strong>。
            </p>
            {secretsPresence.length > 0 && (
              <div style={{ fontSize: 11, color: 'rgba(34,197,94,0.8)', marginBottom: 12,
                background: 'rgba(34,197,94,0.08)', padding: '5px 10px', borderRadius: 6 }}>
                已配置：{secretsPresence.join(', ')}（留空则保留原值）
              </div>
            )}
            {secretsSchema.fields.map(field => (
              <div key={field.key} style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--theme-text-muted)', marginBottom: 4 }}>
                  {field.label}{field.required && <span style={{ color: 'rgba(239,68,68,0.8)', marginLeft: 3 }}>*</span>}
                </label>
                {field.type === 'textarea' ? (
                  <textarea
                    value={secretsValues[field.key] ?? ''}
                    onChange={e => setSecretsValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder || (secretsPresence.includes(field.key) ? '（留空保留原值）' : '')}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', height: 72,
                      background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                      borderRadius: 6, color: 'var(--theme-text)', fontSize: 13,
                      fontFamily: 'monospace', resize: 'vertical' }}
                  />
                ) : (
                  <input
                    type={field.type === 'password' ? 'password' : 'text'}
                    value={secretsValues[field.key] ?? ''}
                    onChange={e => setSecretsValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder || (secretsPresence.includes(field.key) ? '（留空保留原值）' : '')}
                    autoComplete="off"
                    style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px',
                      background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                      borderRadius: 6, color: 'var(--theme-text)', fontSize: 13 }}
                  />
                )}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={() => setSecretsSkill(null)} style={deleteCancelBtnStyle}>取消</button>
              <button onClick={handleSaveSecrets} disabled={savingSecrets} style={deleteConfirmBtnStyle}>
                {savingSecrets ? '保存中…' : '保存凭据'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认对话框 */}
      {deleteConfirm && (
        <div style={deleteOverlayStyle} onClick={() => setDeleteConfirm(null)}>
          <div style={deleteDialogStyle} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600, color: 'var(--theme-text)' }}>
              确认删除
            </h3>
            <p style={{ margin: '0 0 16px 0', fontSize: 13, color: 'var(--theme-text-muted)', lineHeight: 1.5 }}>
              确定要删除 {deleteConfirm.type === 'skill' ? 'Skill' : 'Prompt'}{' '}
              <strong style={{ color: 'var(--theme-error, #cf222e)' }}>"{deleteConfirm.name}"</strong> 吗？
              <br />此操作不可撤销。
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteConfirm(null)} style={deleteCancelBtnStyle}>取消</button>
              <button onClick={confirmDelete} style={deleteConfirmBtnStyle}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════
//  样式
// ═══════════════════════════════════════
const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  padding: 'var(--ui-space-md, 12px) var(--ui-space-lg, 16px)',
  background: 'var(--theme-bg-secondary)',
  borderBottom: '1px solid var(--theme-border)',
  position: 'relative',
  overflow: 'hidden',
};

const panelEditorStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  padding: 'var(--ui-space-md, 12px) var(--ui-space-lg, 16px)',
  background: 'var(--theme-bg-secondary)',
  borderBottom: '1px solid var(--theme-border)',
  position: 'relative',
  overflowY: 'auto',
  maxHeight: 'calc(100vh - 120px)',
};

const columnStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};

const columnHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--theme-text)',
  marginBottom: 8,
  padding: '0 4px',
};

const cardGridStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--ui-space-sm, 8px)',
  overflow: 'auto',
  maxHeight: 200,
  padding: '2px',
};

const cardStyle: React.CSSProperties = {
  width: 110,
  padding: 'var(--ui-space-sm, 10px) 8px var(--ui-space-sm, 8px)',
  borderRadius: 10,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-bg)',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  position: 'relative',
  transition: 'border-color 0.15s, transform 0.15s, box-shadow 0.15s',
};

const cardIconStyle: React.CSSProperties = {
  fontSize: 22,
  lineHeight: 1,
};

const cardNameStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--theme-text)',
  textAlign: 'center',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  width: '100%',
  fontWeight: 500,
};

const cardActionsStyle: React.CSSProperties = {
  position: 'absolute',
  top: 2,
  right: 2,
  opacity: 0,
  transition: 'opacity 0.12s',
};

const cardStarStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 3,
  right: 5,
  fontSize: 13,
  lineHeight: 1,
  cursor: 'pointer',
  transition: 'opacity 0.12s, transform 0.12s',
  userSelect: 'none',
};

const cardDelBtnStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 4,
  border: 'none',
  background: 'rgba(239,68,68,0.15)',
  color: '#ef4444',
  fontSize: 12,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1,
};

const addBtnStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  border: '1px dashed var(--theme-border)',
  background: 'transparent',
  color: 'var(--theme-text-muted)',
  fontSize: 16,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 0.15s',
};

const closeBtnStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 4,
  left: '50%',
  transform: 'translateX(-50%)',
  width: 32,
  height: 18,
  borderRadius: '0 0 8px 8px',
  border: '1px solid var(--theme-border)',
  borderTop: 'none',
  background: 'var(--theme-bg-secondary)',
  color: 'var(--theme-text-muted)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
};

const emptyStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--theme-text-muted)',
  padding: '16px 0',
  textAlign: 'center',
  width: '100%',
};

// 编辑器样式
const editorWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const nameInputStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 14,
  fontWeight: 600,
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)',
  borderRadius: 6,
  color: 'var(--theme-text)',
  padding: '6px 10px',
  outline: 'none',
  fontFamily: 'inherit',
};

const backendSelectStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)',
  borderRadius: 6,
  color: 'var(--theme-text)',
  padding: '4px 8px',
  outline: 'none',
  fontFamily: 'inherit',
};

const contentTextareaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 320,
  fontSize: 13,
  lineHeight: 1.6,
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)',
  borderRadius: 8,
  color: 'var(--theme-text)',
  padding: '10px 12px',
  outline: 'none',
  resize: 'none',
  fontFamily: 'monospace',
};

const saveBtnStyle: React.CSSProperties = {
  padding: '6px 16px',
  borderRadius: 6,
  border: 'none',
  background: 'var(--theme-accent)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '6px 16px',
  borderRadius: 6,
  border: '1px solid var(--theme-border)',
  background: 'transparent',
  color: 'var(--theme-text-muted)',
  fontSize: 13,
  cursor: 'pointer',
};

const iconBtnStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 8,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-bg)',
  fontSize: 20,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const iconPickerStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: 4,
  display: 'grid',
  gridTemplateColumns: 'repeat(8, 1fr)',
  gap: 2,
  padding: 6,
  background: 'var(--theme-bg-secondary)',
  border: '1px solid var(--theme-border)',
  borderRadius: 8,
  boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
  zIndex: 100,
};

const iconOptionStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 4,
  border: 'none',
  fontSize: 16,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const deleteOverlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 2000,
};

const deleteDialogStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #ffffff)',
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 10,
  padding: '20px 24px',
  width: 320,
  boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
};

const deleteCancelBtnStyle: React.CSSProperties = {
  padding: '7px 16px', borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  background: 'transparent',
  color: 'var(--theme-text)', fontSize: 13, cursor: 'pointer',
};

const deleteConfirmBtnStyle: React.CSSProperties = {
  padding: '7px 16px', borderRadius: 6,
  border: 'none',
  background: 'var(--theme-error, #cf222e)',
  color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer',
};
