import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  SkillMarketCatalog,
  SkillMarketItem,
} from '../api';

if (typeof document !== 'undefined' && !document.getElementById('skill-market-css')) {
  const style = document.createElement('style');
  style.id = 'skill-market-css';
  style.textContent = `
    .skill-market-layout { display:grid; grid-template-columns:minmax(290px,.9fr) minmax(380px,1.25fr); gap:12px; min-height:0; flex:1; }
    .skill-market-item:hover { border-color:var(--theme-accent,#7aa2f7)!important; }
    .skill-market-source:hover .skill-market-source-remove { opacity:1!important; }
    @media (max-width: 760px) {
      .skill-market-dialog { inset:8px!important; width:auto!important; max-height:none!important; }
      .skill-market-layout { grid-template-columns:1fr; overflow:auto; }
      .skill-market-list { max-height:280px!important; }
      .skill-market-detail { min-height:360px; }
    }
  `;
  document.head.appendChild(style);
}

interface Props {
  open: boolean;
  onClose: () => void;
  onInstalled: (name?: string) => Promise<void> | void;
}

const EMPTY_CATALOG: SkillMarketCatalog = {
  status: 'ok',
  sources: [],
  directories: [],
  items: [],
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function riskLabel(item: SkillMarketItem): { text: string; color: string; background: string } {
  if (item.risk?.level === 'high') {
    return { text: '高风险提示', color: '#ef6b73', background: 'rgba(239,107,115,.12)' };
  }
  if (item.risk?.level === 'medium') {
    return { text: '需检查', color: '#d6a84b', background: 'rgba(214,168,75,.12)' };
  }
  return { text: '基础检查通过', color: '#4fb477', background: 'rgba(79,180,119,.12)' };
}

export const SkillMarketDialog: React.FC<Props> = ({ open, onClose, onInstalled }) => {
  const [catalog, setCatalog] = useState<SkillMarketCatalog>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [sourceInput, setSourceInput] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [addingSource, setAddingSource] = useState(false);
  const [installingId, setInstallingId] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setMessage(null);
    try {
      const result = await api.skillMarketList('', force);
      setCatalog(result);
      if (result.status !== 'ok') {
        setMessage({ kind: 'error', text: result.message || '技能市场加载失败' });
      }
      setSelectedId(current => {
        if (current && result.items.some(item => item.id === current)) return current;
        return result.items[0]?.id || '';
      });
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : '技能市场加载失败',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load(false);
  }, [open, load]);

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return catalog.items;
    return catalog.items.filter(item => [
      item.name, item.description, item.sourceName, item.repository, item.path,
    ].join(' ').toLocaleLowerCase().includes(needle));
  }, [catalog.items, query]);

  const selected = useMemo(
    () => catalog.items.find(item => item.id === selectedId) || filteredItems[0] || null,
    [catalog.items, filteredItems, selectedId],
  );

  useEffect(() => {
    setReviewed(false);
    setMessage(null);
  }, [selected?.id]);

  const addSource = useCallback(async () => {
    if (!sourceInput.trim()) return;
    setAddingSource(true);
    setMessage(null);
    try {
      const result = await api.skillMarketAddSource(sourceInput.trim(), sourceName.trim());
      if (result.status !== 'ok') {
        setMessage({ kind: 'error', text: result.message || '来源添加失败' });
        return;
      }
      setSourceInput('');
      setSourceName('');
      await load(true);
    } finally {
      setAddingSource(false);
    }
  }, [sourceInput, sourceName, load]);

  const removeSource = useCallback(async (sourceId: string) => {
    const result = await api.skillMarketRemoveSource(sourceId);
    if (result.status !== 'ok') {
      setMessage({ kind: 'error', text: result.message || '来源删除失败' });
      return;
    }
    await load(false);
  }, [load]);

  const installSelected = useCallback(async () => {
    if (!selected || !reviewed) return;
    setInstallingId(selected.id);
    setMessage(null);
    try {
      const result = await api.skillMarketInstall(selected, selected.conflict);
      if (result.status !== 'ok') {
        setMessage({ kind: 'error', text: result.message || '安装失败' });
        return;
      }
      setMessage({
        kind: 'ok',
        text: selected.name + " 文件已导入，接下来检查目标节点的运行环境。",
      });
      await onInstalled(result.skill?.name || result.skill?.id || selected.name);
      await load(false);
    } finally {
      setInstallingId('');
    }
  }, [selected, reviewed, onInstalled, load]);

  if (!open) return null;

  const installDisabled = !selected || !reviewed || installingId === selected?.id
    || Boolean(selected?.installed && selected?.sameSource && !selected?.updateAvailable);
  const installText = !selected ? '选择一个 Skill'
    : installingId === selected.id ? '安装中…'
      : selected.conflict ? '覆盖同名 Skill'
        : selected.updateAvailable ? (selected.localModified ? '覆盖本地修改并更新' : '更新 Skill')
          : selected.installed && selected.sameSource ? '已是当前版本'
            : '安装到 Skill 库';
  const failedSources = catalog.sources.filter(source => Boolean(source.error));
  const warningSources = catalog.sources.filter(source => (source.skippedCount || 0) > 0);
  const allSourcesFailed = catalog.sources.length > 0
    && failedSources.length === catalog.sources.length;
  const skippedTotal = catalog.sources.reduce(
    (total, source) => total + (source.skippedCount || 0), 0,
  );
  const emptyMessage = query.trim()
    ? '没有匹配的标准 Skill'
    : allSourcesFailed
      ? '所有来源都加载失败了，请查看上方错误详情并重试'
      : skippedTotal > 0 && catalog.items.length === 0
        ? `来源已读取，但没有可安装的兼容 Skill（已跳过 ${skippedTotal} 个不合规条目）`
        : '当前来源中没有可安装的标准 Skill';

  return (
    <div style={overlayStyle} onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="skill-market-dialog" style={dialogStyle} aria-label="Agent Skills 市场">
        <header style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 19 }}>🛍️</span>
              <h2 style={{ margin: 0, fontSize: 16, color: 'var(--theme-text)' }}>Agent Skills 市场</h2>
              <span style={standardBadgeStyle}>开放格式兼容</span>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--theme-text-muted)' }}>
              识别标准目录中的 SKILL.md、scripts、references 和 assets；安装时不执行代码、不自动安装依赖。
            </p>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={secondaryButtonStyle} onClick={() => void load(true)} disabled={loading}>
              {loading ? '刷新中…' : '↻ 刷新源'}
            </button>
            <button style={closeButtonStyle} onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        <div style={sourceAreaStyle}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {catalog.sources.map(source => (
              <span key={source.id} className="skill-market-source" style={{
                ...sourceChipStyle,
                borderColor: source.error
                  ? 'rgba(239,107,115,.45)'
                  : (source.skippedCount || 0) > 0
                    ? 'rgba(214,168,75,.45)'
                    : 'var(--theme-border)',
              }} title={source.error || source.homepage}>
                {source.official ? '✓ ' : ''}{source.name}
                <small style={{ opacity: .65 }}>
                  {source.error
                    ? ' · 加载失败'
                    : ` · ${source.skillCount || 0}${(source.skippedCount || 0) > 0 ? `（跳过 ${source.skippedCount}）` : ''}`}
                </small>
                {source.removable && (
                  <button
                    className="skill-market-source-remove"
                    onClick={() => void removeSource(source.id)}
                    title="移除来源"
                    style={sourceRemoveStyle}
                  >×</button>
                )}
              </span>
            ))}
          </div>
          {(failedSources.length > 0 || warningSources.length > 0) && (
            <div style={sourceProblemStyle} role="alert">
              <div style={{ minWidth: 0, flex: 1 }}>
                {failedSources.map(source => (
                  <div key={`${source.id}:error`} style={{ color: '#ef6b73' }}>
                    <strong>{source.name}：</strong>{source.error}
                  </div>
                ))}
                {warningSources.map(source => (
                  <div key={`${source.id}:warning`} style={{ color: '#d6a84b' }}>
                    <strong>{source.name}：</strong>
                    已跳过 {source.skippedCount} 个不符合规范的条目，有效 Skill 仍可正常安装。
                    {(source.issues || []).slice(0, 3).map((issue, index) => (
                      <div key={`${issue.path}:${index}`} style={{ paddingLeft: 10, opacity: .9 }}>
                        • {issue.path || '仓库根目录'}：{issue.message}
                      </div>
                    ))}
                    {(source.issues || []).length > 3 && (
                      <div style={{ paddingLeft: 10, opacity: .75 }}>
                        另有 {(source.issues || []).length - 3} 个条目未展开
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <button style={secondaryButtonStyle} onClick={() => void load(true)} disabled={loading}>
                {loading ? '重试中…' : '重试'}
              </button>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px,1fr) minmax(110px,.45fr) auto', gap: 6 }}>
            <input
              value={sourceInput}
              onChange={event => setSourceInput(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void addSource(); }}
              placeholder="添加 GitHub 仓库：owner/repo 或 https://github.com/…"
              style={inputStyle}
            />
            <input
              value={sourceName}
              onChange={event => setSourceName(event.target.value)}
              placeholder="显示名（可选）"
              style={inputStyle}
            />
            <button style={secondaryButtonStyle} onClick={() => void addSource()} disabled={addingSource || !sourceInput.trim()}>
              {addingSource ? '添加中…' : '＋ 添加源'}
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 10, color: 'var(--theme-text-muted)' }}>
            <span>公开目录：</span>
            {catalog.directories.map(directory => (
              <a key={directory.url} href={directory.url} target="_blank" rel="noreferrer"
                title={directory.description} style={{ color: 'var(--theme-accent)', textDecoration: 'none' }}>
                {directory.name} ↗
              </a>
            ))}
          </div>
        </div>

        {message && (
          <div style={{
            padding: '7px 10px', borderRadius: 7, fontSize: 12,
            color: message.kind === 'ok' ? '#4fb477' : '#ef6b73',
            background: message.kind === 'ok' ? 'rgba(79,180,119,.1)' : 'rgba(239,107,115,.1)',
          }}>{message.text}</div>
        )}

        <div className="skill-market-layout">
          <div style={listPaneStyle}>
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索名称、用途或仓库…"
              style={{ ...inputStyle, width: '100%' }}
              autoFocus
            />
            <div className="skill-market-list" style={listStyle}>
              {loading && catalog.items.length === 0 && <div style={emptyStyle}>正在读取公开 Skill 仓库…</div>}
              {!loading && filteredItems.length === 0 && <div style={emptyStyle}>{emptyMessage}</div>}
              {filteredItems.map(item => {
                const risk = riskLabel(item);
                return (
                  <button key={item.id} className="skill-market-item" onClick={() => setSelectedId(item.id)}
                    style={{ ...itemStyle, ...(selected?.id === item.id ? selectedItemStyle : {}) }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <strong style={{ fontSize: 13, color: 'var(--theme-text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.name}
                      </strong>
                      {item.official && <span title="官方来源" style={officialBadgeStyle}>官方</span>}
                      {item.updateAvailable && <span style={updateBadgeStyle}>可更新</span>}
                      {item.installed && !item.updateAvailable && <span style={installedBadgeStyle}>已安装</span>}
                    </div>
                    <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--theme-text-muted)', textAlign: 'left',
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {item.description || '未提供说明'}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 10 }}>
                      <span style={{ color: 'var(--theme-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.repository}
                      </span>
                      <span style={{ color: risk.color, whiteSpace: 'nowrap' }}>{risk.text}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="skill-market-detail" style={detailPaneStyle}>
            {!selected ? <div style={emptyStyle}>从左侧选择一个 Skill 查看完整内容</div> : (() => {
              const risk = riskLabel(selected);
              return (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <h3 style={{ margin: 0, fontSize: 16, color: 'var(--theme-text)' }}>{selected.name}</h3>
                      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--theme-text-muted)' }}>
                        {selected.sourceName} · {selected.repository}@{selected.ref}
                        {selected.path ? ` · ${selected.path}` : ''}
                      </div>
                    </div>
                    <span style={{ ...riskBadgeStyle, color: risk.color, background: risk.background }}>{risk.text}</span>
                  </div>
                  <p style={{ margin: '9px 0', fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text)' }}>
                    {selected.description}
                  </p>
                  <div style={metaGridStyle}>
                    <span>许可证：<b>{selected.license || '未声明'}</b></span>
                    <span>兼容说明：<b>{selected.compatibility || '标准 SKILL.md'}</b></span>
                    <span>文件：<b>{selected.fileCount}</b></span>
                    <span>大小：<b>{formatBytes(selected.size)}</b></span>
                  </div>
                  {(selected.conflict || selected.localModified || selected.warnings.length > 0) && (
                    <div style={warningBoxStyle}>
                      {selected.conflict && <div>本地已有同名 Skill，安装会先明确覆盖它。</div>}
                      {selected.localModified && <div>已安装版本被手动修改；更新会覆盖这些修改。</div>}
                      {selected.warnings.map((warning, index) => <div key={index}>{warning}</div>)}
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,.8fr) minmax(0,1.2fr)', gap: 8, minHeight: 0, flex: 1 }}>
                    <div style={auditBoxStyle}>
                      <strong style={auditTitleStyle}>安装文件</strong>
                      <div style={scrollTextStyle}>
                        {selected.fileNames.map(name => <div key={name}>{name}</div>)}
                      </div>
                    </div>
                    <div style={auditBoxStyle}>
                      <strong style={auditTitleStyle}>自动风险提示</strong>
                      <div style={{ fontSize: 11, lineHeight: 1.55, color: 'var(--theme-text-muted)', marginBottom: 7 }}>
                        {(selected.risk?.flags || []).map((flag, index) => <div key={index}>• {flag}</div>)}
                      </div>
                      <strong style={auditTitleStyle}>
                        SKILL.md 预览{selected.previewTruncated ? '（内容较长，仅显示前 32K）' : ''}
                      </strong>
                      <pre style={previewStyle}>{selected.preview}</pre>
                    </div>
                  </div>
                  <footer style={detailFooterStyle}>
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11,
                      color: 'var(--theme-text-muted)', lineHeight: 1.4, flex: 1 }}>
                      <input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
                      <span>我已检查来源、文件和 SKILL.md。Skill 可指导 Agent 运行命令，安装不代表内容绝对安全。</span>
                    </label>
                    <button style={{ ...primaryButtonStyle, opacity: installDisabled ? .55 : 1 }}
                      disabled={installDisabled} onClick={() => void installSelected()}>
                      {installText}
                    </button>
                  </footer>
                </>
              );
            })()}
          </div>
        </div>
      </section>
    </div>
  );
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 2600, padding: 18,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,.62)', backdropFilter: 'blur(2px)',
};
const dialogStyle: React.CSSProperties = {
  width: 'min(1040px, calc(100vw - 36px))', height: 'min(790px, calc(100vh - 36px))',
  maxHeight: 'calc(100vh - 36px)', display: 'flex', flexDirection: 'column', gap: 10,
  padding: 14, borderRadius: 12, border: '1px solid var(--theme-border)',
  background: 'var(--theme-bg-secondary)', boxShadow: '0 20px 70px rgba(0,0,0,.42)',
};
const headerStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
};
const sourceAreaStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 7, padding: 9,
  border: '1px solid var(--theme-border)', borderRadius: 9, background: 'var(--theme-bg)',
};
const sourceProblemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 8px',
  borderRadius: 7, border: '1px solid rgba(214,168,75,.28)',
  background: 'rgba(214,168,75,.07)', fontSize: 10, lineHeight: 1.5,
  overflowWrap: 'anywhere',
};
const standardBadgeStyle: React.CSSProperties = {
  fontSize: 10, padding: '2px 6px', borderRadius: 5,
  color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)',
};
const sourceChipStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 3, position: 'relative',
  padding: '3px 7px', borderRadius: 999, border: '1px solid var(--theme-border)',
  fontSize: 10, color: 'var(--theme-text-muted)', background: 'var(--theme-bg-secondary)',
};
const sourceRemoveStyle: React.CSSProperties = {
  border: 0, background: 'transparent', color: '#ef6b73', cursor: 'pointer',
  padding: 0, marginLeft: 2, opacity: .55, lineHeight: 1,
};
const inputStyle: React.CSSProperties = {
  minWidth: 0, boxSizing: 'border-box', border: '1px solid var(--theme-border)',
  borderRadius: 7, background: 'var(--theme-input-bg, var(--theme-bg))',
  color: 'var(--theme-text)', padding: '7px 9px', fontSize: 12, outline: 'none',
};
const secondaryButtonStyle: React.CSSProperties = {
  border: '1px solid var(--theme-border)', borderRadius: 7,
  background: 'var(--theme-bg)', color: 'var(--theme-text)', padding: '6px 9px',
  fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
};
const primaryButtonStyle: React.CSSProperties = {
  border: 0, borderRadius: 7, background: 'var(--theme-accent)', color: '#fff',
  padding: '8px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
};
const closeButtonStyle: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 7, border: '1px solid var(--theme-border)',
  background: 'transparent', color: 'var(--theme-text-muted)', fontSize: 20, cursor: 'pointer',
};
const listPaneStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, minHeight: 0,
};
const listStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, overflowY: 'auto', paddingRight: 3,
};
const itemStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 5, width: '100%', padding: '9px 10px',
  borderRadius: 8, border: '1px solid var(--theme-border)', background: 'var(--theme-bg)',
  cursor: 'pointer', color: 'inherit', textAlign: 'left', transition: 'border-color .12s',
};
const selectedItemStyle: React.CSSProperties = {
  borderColor: 'var(--theme-accent)', background: 'var(--theme-accent-bg)',
};
const officialBadgeStyle: React.CSSProperties = {
  padding: '1px 5px', borderRadius: 4, fontSize: 9, color: '#4fb477', background: 'rgba(79,180,119,.12)',
};
const updateBadgeStyle: React.CSSProperties = {
  padding: '1px 5px', borderRadius: 4, fontSize: 9, color: '#d6a84b', background: 'rgba(214,168,75,.12)',
};
const installedBadgeStyle: React.CSSProperties = {
  padding: '1px 5px', borderRadius: 4, fontSize: 9, color: 'var(--theme-text-muted)', background: 'rgba(127,127,127,.12)',
};
const detailPaneStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, minHeight: 0,
  padding: 11, borderRadius: 9, border: '1px solid var(--theme-border)', background: 'var(--theme-bg)', overflow: 'hidden',
};
const riskBadgeStyle: React.CSSProperties = {
  padding: '3px 7px', borderRadius: 6, fontSize: 10, whiteSpace: 'nowrap',
};
const metaGridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '4px 12px',
  fontSize: 10, color: 'var(--theme-text-muted)', marginBottom: 7,
};
const warningBoxStyle: React.CSSProperties = {
  padding: '6px 8px', borderRadius: 6, fontSize: 10, lineHeight: 1.45,
  color: '#d6a84b', background: 'rgba(214,168,75,.1)', marginBottom: 5,
};
const auditBoxStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
  padding: 8, borderRadius: 7, border: '1px solid var(--theme-border)', overflow: 'hidden',
};
const auditTitleStyle: React.CSSProperties = {
  display: 'block', fontSize: 10, color: 'var(--theme-text)', marginBottom: 5,
};
const scrollTextStyle: React.CSSProperties = {
  minHeight: 0, overflow: 'auto', font: '10px/1.55 monospace', color: 'var(--theme-text-muted)', overflowWrap: 'anywhere',
};
const previewStyle: React.CSSProperties = {
  flex: 1, minHeight: 100, margin: 0, padding: 7, borderRadius: 6,
  background: 'var(--theme-bg-secondary)', color: 'var(--theme-text-muted)',
  font: '10px/1.5 monospace', whiteSpace: 'pre-wrap', overflow: 'auto', overflowWrap: 'anywhere',
};
const detailFooterStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, marginTop: 4,
  borderTop: '1px solid var(--theme-border)',
};
const emptyStyle: React.CSSProperties = {
  margin: 'auto', padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--theme-text-muted)',
};
