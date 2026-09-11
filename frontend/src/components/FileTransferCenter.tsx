import React, { useEffect, useSyncExternalStore } from 'react';
import { fileTransfers } from '../utils/fileTransfers';

export const FileTransferCenter: React.FC = () => {
  const jobs = useSyncExternalStore(fileTransfers.subscribe, fileTransfers.getSnapshot);
  const running = jobs.some(job => job.status === 'running');
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);
  if (!jobs.length) return null;
  return <section aria-label="文件传输" style={{ position: 'fixed', bottom: 12, right: 12,
    zIndex: 1500, width: 'min(340px, calc(100vw - 24px))', maxHeight: '35vh', overflow: 'auto',
    padding: 10, borderRadius: 10, background: 'var(--theme-bg-secondary)',
    color: 'var(--theme-text)', border: '1px solid var(--theme-border)', boxShadow: '0 4px 20px #0003' }}>
    <strong>文件传输</strong>
    <div style={{ fontSize: 11, margin: '4px 0' }}>切换会话可继续；刷新或关闭页面会中断。</div>
    {jobs.map(job => <div key={job.id} style={{ padding: '8px 0', borderTop: '1px solid var(--theme-border)', fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
        <span>{job.progress.direction === 'delete' ? '删除执行端' : job.progress.direction === 'push' ? '上传' : '下载'} · {job.label}</span>
        <button disabled={job.status === 'running' && (job.abort.current || job.progress.direction === 'delete')}
          onClick={() => job.status === 'running' ? fileTransfers.cancel(job) : fileTransfers.dismiss(job)}>
          {job.status === 'running' ? (job.progress.direction === 'delete' ? '删除中…' : job.abort.current ? '取消中…' : '取消') : '关闭'}
        </button>
      </div>
      <div title={job.workspace} style={{ overflowWrap: 'anywhere' }}>{job.progress.rel}</div>
      {job.status === 'running' ? <>
        <progress style={{ width: '100%' }} max={job.progress.totalBytes || 1} value={job.progress.doneBytes} />
        <div>{job.progress.direction === 'delete' ? '正在删除，请等待执行端确认…' : job.progress.totalBytes ? Math.round(job.progress.doneBytes / job.progress.totalBytes * 100) + '%' : '准备中…'}</div>
      </> : <div role="status">{job.message}</div>}
    </div>)}
  </section>;
};
