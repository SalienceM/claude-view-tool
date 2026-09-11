import React, { useEffect, useState } from 'react';
import { api, getExecutors, getHomeExecKey } from '../api';
import { AppModalPortal } from './AppModalPortal';

const labels: Record<string, string> = {
  preparing: '正在准备', blocked: '环境/资源缺失', needs_configuration: '待配置',
  needs_review: '需人工处理', ready: '运行检查通过', failed: '准备失败', needs_preparation: '文件已安装 · 待准备',
};

export const SkillRuntimeDialog: React.FC<{ names: string[]; onClose: () => void }> = ({ names, onClose }) => {
  const [name, setName] = useState(names[0] || '');
  // 固定目标节点，不随默认节点/当前 Session 漂移。
  const [execKey, setExecKey] = useState(getHomeExecKey);
  const [plan, setPlan] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [revision, setRevision] = useState(0);
  const executors = getExecutors();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPlan(null); setError(''); setApproved(false);
    const load = async (review: boolean) => {
      try {
        const result = await api.skillRuntimeInspect(name, execKey, review);
        if (cancelled) return;
        if (result?.status !== 'ok') throw new Error(result?.message || '无法检查该节点');
        setPlan(result.plan);
        if (result.plan.status === 'preparing') timer = setTimeout(() => void load(false), 2000);
      } catch (reason: any) {
        if (!cancelled) setError(reason?.message || '检查失败');
      }
    };
    void load(true);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [name, execKey, revision]);

  const start = async () => {
    if (!approved || !plan?.approvalToken || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.skillRuntimePrepare(name, execKey, plan.approvalToken);
      if (result?.status !== 'ok') throw new Error(result?.message || '准备失败');
      setRevision(value => value + 1);
    } catch (reason: any) { setError(reason?.message || '准备失败'); }
    finally { setBusy(false); setApproved(false); }
  };

  return <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 18000, background: '#0008', display: 'grid', placeItems: 'center', padding: 12 }}>
    <section role="dialog" aria-modal="true" aria-label="Skill 运行准备" style={{ width: 'min(760px, 100%)', maxHeight: '92dvh', overflow: 'auto', padding: 18, boxSizing: 'border-box', borderRadius: 12, background: 'var(--theme-panel-solid, var(--theme-bg, #161b22))', color: 'var(--theme-text)', border: '1px solid var(--theme-border)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}><strong style={{ flex: 1 }}>🧰 Skill 运行准备</strong><button style={button} onClick={onClose} aria-label="关闭运行准备">✕</button></header>
      <p style={muted}>完整资源导入与运行就绪是两步。依赖安装发生在所选执行节点，关闭窗口不会停止已启动的任务。</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label>技能 <select disabled={busy} style={button} value={name} onChange={e => setName(e.target.value)}>{names.map(n => <option key={n}>{n}</option>)}</select></label>
        <label>执行节点 <select disabled={busy} style={button} value={execKey} onChange={e => setExecKey(e.target.value)}>
          {executors.map(e => <option key={e.key} value={e.key}>{e.label}{!e.connected ? ' · 离线' : ''}</option>)}
        </select></label>
        <button disabled={busy} style={button} onClick={() => setRevision(v => v + 1)}>重新检查 / 重试</button>
      </div>
      {error && <p role="alert" style={{ color: '#f87171', overflowWrap: 'anywhere' }}>{error}</p>}
      {!plan && !error && <p>正在检查资源与节点环境…</p>}
      {plan && <>
        <h3>{labels[plan.status] || plan.status}</h3>
        <p style={muted}>{plan.node?.host} · {plan.node?.os} · {plan.node?.architecture} · {plan.fileCount} 个文件</p>
        <p style={{ ...muted, overflowWrap: 'anywhere' }}>隔离目录：{plan.environment}</p>
        {!!plan.blockers?.length && <div style={{ color: '#f87171' }}><strong>必须处理</strong><ul>{plan.blockers.map((s: string) => <li key={s}>{s}</li>)}</ul></div>}
        {!!plan.missingEnv?.length && <p style={{ color: '#e3b341' }}>待配置：{plan.missingEnv.join('、')}。请在目标执行环境配置这些变量，或使用技能凭据配置（适用于 Backend Skill），然后重新检查。不会显示或发送密钥给模型。</p>}
        {!!plan.manualSteps?.length && <div style={{ color: '#e3b341' }}><strong>人工处理项（不会偷偷执行）</strong><ul>{plan.manualSteps.map((s: string) => <li key={s}>{s}</li>)}</ul><p style={muted}>修改/补全运行声明后重新检查；本入口不执行 sudo、apt、任意安装脚本或未声明的命令。</p></div>}
        {!!plan.warnings?.length && <details><summary>资源引用提示 · {plan.warnings.length}</summary><ul>{plan.warnings.map((s: string) => <li key={s} style={{ overflowWrap: 'anywhere' }}>{s}</li>)}</ul></details>}
        <h4>安装与验证计划</h4><ol>{plan.steps?.map((s: string) => <li key={s}>{s}</li>)}</ol>
        {!!plan.requirements?.length && <details><summary>Python 依赖 · {plan.requirements.length}</summary><pre style={logStyle}>{plan.requirements.join('\n')}</pre></details>}
        {!!plan.pythonImports?.length && <p style={muted}>将验证模块导入：{plan.pythonImports.join('、')}</p>}
        {plan.needsNode && <details><summary>Node 依赖声明</summary><pre style={logStyle}>{JSON.stringify(plan.nodeDependencies, null, 2)}</pre></details>}
        {plan.status === 'preparing' ? <p role="status">正在后台执行，请稍候。日志自动刷新；切换页面不会中断。</p> : <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.6 }}>
            <input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />
            我已核对上述节点、依赖和计划，同意下载第三方依赖到专属环境并执行列出的验证。不会运行实际生成任务，也不自动提权。
          </label>
          <button style={{ ...button, marginTop: 12 }} disabled={busy || !approved || !plan.approvalToken || !!plan.blockers?.length}
            onClick={() => void start()}>{busy ? '提交中…' : '确认并准备运行环境'}</button>
        </>}
        {plan.lastRun?.startedAt && <p style={muted}>上次准备：{new Date(plan.lastRun.startedAt * 1000).toLocaleString()} · {plan.lastRun.message}</p>}
        {!!plan.lastRun?.log?.length && <details open><summary>安装日志（尾部）</summary><pre style={logStyle}>{plan.lastRun.log.join('\n')}</pre></details>}
        <p style={muted}>“运行检查通过”只表示已声明的资源、依赖和轻量检查通过，不保证 PPT 等业务成果质量，也不能推断未声明的系统依赖。</p>
      </>}
    </section>
  </div></AppModalPortal>;
};
const button: React.CSSProperties = { padding: '7px 10px', minHeight: 36, border: '1px solid var(--theme-border)', borderRadius: 6, color: 'var(--theme-text)', background: 'var(--theme-bg-secondary)', cursor: 'pointer', maxWidth: '100%' };
const muted: React.CSSProperties = { color: 'var(--theme-text-muted)', fontSize: 12, lineHeight: 1.6 };
const logStyle: React.CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto', fontSize: 11, padding: 10, background: 'var(--theme-code-bg)' };
