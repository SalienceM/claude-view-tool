export interface TransferProgress {
  direction: 'pull' | 'push' | 'delete';
  rel: string;
  fileIndex: number;
  fileCount: number;
  fileBytes: number;
  fileSize: number;
  doneBytes: number;
  totalBytes: number;
  activeCount: number;
  startedAt: number;
}

export interface FileTransfer {
  id: number;
  workspace: string;
  label: string;
  progress: TransferProgress;
  status: 'running' | 'done' | 'error' | 'cancelled';
  message: string;
  abort: { current: boolean };
}

export class FileTransferManager {
  private jobs: FileTransfer[] = [];
  private listeners = new Set<() => void>();
  private nextId = 0;
  getSnapshot = (): FileTransfer[] => this.jobs;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(): void {
    this.jobs = [...this.jobs];
    this.listeners.forEach(listener => listener());
  }
  active(workspace: string): FileTransfer | undefined {
    return this.jobs.find(job => job.workspace === workspace && job.status === 'running');
  }
  start(workspace: string, label: string, direction: 'pull' | 'push' | 'delete', rel: string): FileTransfer | undefined {
    if (this.active(workspace)) return undefined;
    const job: FileTransfer = {
      id: ++this.nextId, workspace, label, status: 'running', message: '', abort: { current: false },
      progress: { direction, rel, fileIndex: 0, fileCount: 0, fileBytes: 0,
        fileSize: 0, doneBytes: 0, totalBytes: 0, activeCount: 0, startedAt: Date.now() },
    };
    this.jobs.push(job);
    this.publish();
    return job;
  }
  progress(job: FileTransfer, progress: TransferProgress): void {
    job.progress = progress;
    this.publish();
  }
  finish(job: FileTransfer, message: string, failed = false): void {
    job.status = job.abort.current || !message ? 'cancelled' : failed ? 'error' : 'done';
    job.message = message || '已取消';
    this.publish();
  }
  cancel(job: FileTransfer): void {
    if (job.status !== 'running' || job.progress.direction === 'delete') return;
    job.abort.current = true;
    this.publish();
  }
  dismiss(job: FileTransfer): void {
    if (job.status === 'running') return;
    this.jobs = this.jobs.filter(item => item !== job);
    this.publish();
  }
}

export const fileTransfers = new FileTransferManager();
