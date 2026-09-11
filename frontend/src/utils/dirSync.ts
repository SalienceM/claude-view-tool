/**
 * dirSync.ts — 远程工作目录 ↔ 本机副本目录的增量同步引擎。
 *
 * 远程执行模式下会话工作目录在执行节点磁盘上，本地端够不着。本模块在
 * 「本机副本目录」与「远端工作目录」之间做三向增量比对：
 *
 *   B 基线（上次同步快照） / L 本地清单 / R 远端清单
 *
 * 只有相对基线发生变化的文件才传输；两端都相对基线改过同一文件 → 冲突，
 * 不自动覆盖，交由用户决定。服务器侧完全无状态，基线存在客户端。
 *
 * 本地副本目录的文件系统访问有两套实现：
 *   - Tauri 桌面端：Rust 命令 dir_sync_*（真实文件系统）
 *   - 浏览器：File System Access API（仅 Chromium 内核）
 */
import { api, isTauri } from '../api';
import { sha256BlobHex } from './sha256';
import { yieldToUi } from './cooperativeWork';
import { isIgnored } from './dirSyncPolicy';
export { isGitMetadataPath, isIgnored } from './dirSyncPolicy';

export interface FileMeta {
  hash: string;
  size: number;
  /** Unix 毫秒。仅用于解释哪端更新；内容一致性仍以 hash 为准。 */
  mtime?: number;
}
/** relpath → 文件元信息 */
export type Manifest = Record<string, FileMeta>;

export type SyncDirection = 'pull' | 'push';

/** 单文件传输上限：须与后端 _SYNC_MAX_FILE 一致，避免 base64 后撑爆 WS 帧。 */
export const SYNC_MAX_FILE = 32 * 1024 * 1024;

export interface DiffEntry {
  rel: string;
  /** 对「目标端」执行的动作 */
  action: 'add' | 'update' | 'delete';
  /** 两端都相对基线改动过 —— 应用前需用户确认 */
  conflict: boolean;
  /** 传输字节数（delete 为 0） */
  size: number;
}

export interface DiffResult {
  direction: SyncDirection;
  entries: DiffEntry[];
  /** entries 中 conflict 为 true 的子集（同一对象引用） */
  conflicts: DiffEntry[];
}

export interface PreparedSync {
  direction: SyncDirection;
  diff: DiffResult;
  local: Manifest;
  remote: Manifest;
}

export interface ApplyProgress {
  done: number;
  total: number;
  rel: string;
}

export interface ApplyResult {
  applied: number;
  failed: { rel: string; error: string }[];
}

// ── base64 / 哈希 工具 ────────────────────────────────────────

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64ToBlob(b64: string): Blob {
  // Uint8Array<ArrayBufferLike> 在新版 TS DOM 类型里不能直接作为 BlobPart；
  // slice 出独立 ArrayBuffer 同时避免引用额外底层容量。
  const bytes = base64ToUint8Array(b64);
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]);
}

// ── 本地副本目录的文件系统抽象 ─────────────────────────────────

export interface LocalFs {
  readonly kind: 'tauri' | 'browser' | 'managed';
  /** 人类可读的副本目录标识（用于界面展示） */
  label(): string;
  /** 跨会话稳定的标识，用于给基线做 key */
  id(): string;
  scan(ignore: string[], includeGit?: boolean, options?: { hash?: boolean; signal?: AbortSignal }): Promise<Manifest>;
  /** 列出某相对目录的直接子项(懒加载逐层浏览用,不递归、不算哈希)。 */
  listDir(rel: string): Promise<LocalEntry[]>;
  readFile(rel: string): Promise<string>; // base64
  /** 浏览器实现可直接交换 Blob，避免平板导入/导出时做整文件 base64 膨胀。 */
  readBlob?(rel: string): Promise<Blob>;
  writeFile(rel: string, base64: string): Promise<void>;
  writeBlob?(rel: string, data: Blob): Promise<void>;
  fileSize(rel: string): Promise<number>;
  readChunk(rel: string, offset: number, size: number): Promise<string>;
  writeStart(rel: string, transferId: string): Promise<void>;
  writeChunk(rel: string, transferId: string, offset: number, base64: string): Promise<void>;
  writeFinish(rel: string, transferId: string, expectedSize: number): Promise<void>;
  writeAbort(rel: string, transferId: string): Promise<void>;
  /** 桌面端在资源管理器中定位；浏览器安全模型不允许时抛出明确错误。 */
  reveal(rel: string): Promise<void>;
  deleteFile(rel: string): Promise<void>;
}

export interface LocalEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** 从扁平清单推导某目录的直接子项(给没有原生逐层列目录能力的实现兜底)。 */
function levelFromManifest(m: Manifest, rel: string): LocalEntry[] {
  const prefix = rel ? `${rel}/` : '';
  const dirs = new Set<string>();
  const files: LocalEntry[] = [];
  for (const path of Object.keys(m)) {
    if (rel && !path.startsWith(prefix)) continue;
    const rest = rel ? path.slice(prefix.length) : path;
    const slash = rest.indexOf('/');
    if (slash === -1) files.push({ name: rest, isDir: false, size: m[path].size });
    else dirs.add(rest.slice(0, slash));
  }
  return [
    ...[...dirs].sort().map((d) => ({ name: d, isDir: true, size: 0 })),
    ...files.sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** Tauri 桌面端：副本目录是本机一个真实路径。 */
export class TauriLocalFs implements LocalFs {
  readonly kind = 'tauri' as const;
  constructor(private dir: string) {}
  private _scanCache: Manifest | null = null;
  label(): string {
    return this.dir;
  }
  id(): string {
    return `tauri:${this.dir}`;
  }
  async scan(ignore: string[], includeGit = false, options: { hash?: boolean; signal?: AbortSignal } = {}): Promise<Manifest> {
    const r = await tauriInvoke<{ files: Manifest }>('dir_sync_scan', {
      dir: this.dir,
      ignore,
      includeGit,
      hashFiles: options.hash !== false,
    });
    this._scanCache = r.files || {};
    return this._scanCache;
  }
  // Tauri 无逐层列目录命令,用一次性扫描结果推导层级(本地磁盘,代价可接受)。
  async listDir(rel: string): Promise<LocalEntry[]> {
    if (!this._scanCache) await this.scan([], false, { hash: false });
    return levelFromManifest(this._scanCache || {}, rel);
  }
  readFile(rel: string): Promise<string> {
    return tauriInvoke<string>('dir_sync_read_file', { dir: this.dir, rel });
  }
  writeFile(rel: string, base64: string): Promise<void> {
    return tauriInvoke<void>('dir_sync_write_file', { dir: this.dir, rel, data: base64 });
  }
  fileSize(rel: string): Promise<number> {
    return tauriInvoke<number>('dir_sync_file_size', { dir: this.dir, rel });
  }
  readChunk(rel: string, offset: number, size: number): Promise<string> {
    return tauriInvoke<string>('dir_sync_read_chunk', { dir: this.dir, rel, offset, size });
  }
  writeStart(rel: string, transferId: string): Promise<void> {
    return tauriInvoke<void>('dir_sync_write_start', { dir: this.dir, rel, transferId });
  }
  writeChunk(rel: string, transferId: string, offset: number, base64: string): Promise<void> {
    return tauriInvoke<void>('dir_sync_write_chunk', { dir: this.dir, rel, transferId, offset, data: base64 });
  }
  writeFinish(rel: string, transferId: string, expectedSize: number): Promise<void> {
    return tauriInvoke<void>('dir_sync_write_finish', { dir: this.dir, rel, transferId, expectedSize });
  }
  writeAbort(rel: string, transferId: string): Promise<void> {
    return tauriInvoke<void>('dir_sync_write_abort', { dir: this.dir, rel, transferId });
  }
  reveal(rel: string): Promise<void> {
    return tauriInvoke<void>('dir_sync_reveal', { dir: this.dir, rel });
  }
  deleteFile(rel: string): Promise<void> {
    return tauriInvoke<void>('dir_sync_delete_file', { dir: this.dir, rel });
  }
}

/** 浏览器：副本目录是 File System Access API 的目录句柄。 */
export class BrowserLocalFs implements LocalFs {
  readonly kind = 'browser' as const;
  private writers = new Map<string, any>();
  private scanCache = new Map<string, { size: number; modified: number; hash: string }>();
  // handle 类型依赖 lib.dom 版本，统一用 any 规避版本差异
  constructor(private handle: any) {}
  label(): string {
    return this.handle?.name || '(已选目录)';
  }
  id(): string {
    return `browser:${this.handle?.name || ''}`;
  }
  async scan(ignore: string[], includeGit = false, options: { hash?: boolean; signal?: AbortSignal } = {}): Promise<Manifest> {
    const out: Manifest = {};
    await this._walk(this.handle, '', ignore, includeGit, out, options);
    return out;
  }
  // 浏览器：原生逐层列目录（含空目录），不算哈希,快。
  async listDir(rel: string): Promise<LocalEntry[]> {
    let dir = this.handle;
    for (const p of rel.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(p);
    const out: LocalEntry[] = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') out.push({ name, isDir: true, size: 0 });
      else { const f = await h.getFile(); out.push({ name, isDir: false, size: f.size }); }
    }
    out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    return out;
  }
  private async _walk(
    dir: any,
    base: string,
    ignore: string[],
    includeGit: boolean,
    out: Manifest,
    options: { hash?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    let count = 0;
    for await (const [name, h] of dir.entries()) {
      options.signal?.throwIfAborted();
      if (++count % 64 === 0) await yieldToUi(options.signal);
      const rel = base ? `${base}/${name}` : name;
      if (isIgnored(rel, ignore, includeGit)) continue;
      if (h.kind === 'directory') {
        await this._walk(h, rel, ignore, includeGit, out, options);
      } else {
        const file = await h.getFile();
        if (options.hash === false) {
          out[rel] = { hash: '', size: file.size, mtime: file.lastModified };
          continue;
        }
        const cached = this.scanCache.get(rel);
        const hash = cached && cached.size === file.size && cached.modified === file.lastModified
          ? cached.hash
          : await sha256BlobHex(file);
        this.scanCache.set(rel, { size: file.size, modified: file.lastModified, hash });
        out[rel] = { hash, size: file.size, mtime: file.lastModified };
      }
    }
  }
  private async _fileHandle(rel: string, create: boolean): Promise<any> {
    const parts = rel.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error(`非法路径: ${rel}`);
    let dir = this.handle;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return dir.getFileHandle(name, { create });
  }
  async readFile(rel: string): Promise<string> {
    const fh = await this._fileHandle(rel, false);
    const file = await fh.getFile();
    return arrayBufferToBase64(await file.arrayBuffer());
  }
  async readBlob(rel: string): Promise<Blob> {
    const fh = await this._fileHandle(rel, false);
    return fh.getFile();
  }
  async writeFile(rel: string, base64: string): Promise<void> {
    const fh = await this._fileHandle(rel, true);
    const w = await fh.createWritable();
    await w.write(base64ToUint8Array(base64));
    await w.close();
  }
  async writeBlob(rel: string, data: Blob): Promise<void> {
    const fh = await this._fileHandle(rel, true);
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }
  async fileSize(rel: string): Promise<number> {
    const fh = await this._fileHandle(rel, false);
    return (await fh.getFile()).size;
  }
  async readChunk(rel: string, offset: number, size: number): Promise<string> {
    const fh = await this._fileHandle(rel, false);
    const file = await fh.getFile();
    return arrayBufferToBase64(await file.slice(offset, offset + size).arrayBuffer());
  }
  async writeStart(rel: string, transferId: string): Promise<void> {
    if (this.writers.has(transferId)) throw new Error('传输标识重复');
    const fh = await this._fileHandle(rel, true);
    this.writers.set(transferId, await fh.createWritable());
  }
  async writeChunk(_rel: string, transferId: string, offset: number, base64: string): Promise<void> {
    const writer = this.writers.get(transferId);
    if (!writer) throw new Error('写入会话不存在');
    await writer.write({ type: 'write', position: offset, data: base64ToUint8Array(base64) });
  }
  async writeFinish(_rel: string, transferId: string, _expectedSize: number): Promise<void> {
    const writer = this.writers.get(transferId);
    if (!writer) throw new Error('写入会话不存在');
    this.writers.delete(transferId);
    await writer.close();
  }
  async writeAbort(_rel: string, transferId: string): Promise<void> {
    const writer = this.writers.get(transferId);
    this.writers.delete(transferId);
    if (writer?.abort) await writer.abort();
  }
  async reveal(_rel: string): Promise<void> {
    throw new Error('浏览器安全限制不允许直接打开系统文件管理器，请使用桌面客户端');
  }
  async deleteFile(rel: string): Promise<void> {
    const parts = rel.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) return;
    let dir = this.handle;
    for (const p of parts) dir = await dir.getDirectoryHandle(p);
    await dir.removeEntry(name);
  }
}

// ── 副本目录的选择与持久化 ─────────────────────────────────────

const COPYDIR_TAURI_KEY = 'awu-dirsync-copydir-tauri';
const COPYDIR_BROWSER_MODE_KEY = 'awu-dirsync-copydir-browser-mode';
const IDB_DB = 'awu-dirsync';
const IDB_STORE = 'handles';
const IDB_HANDLE_KEY = 'copydir';
const IDB_FILE_STORE = 'offline-files';
const IDB_CHUNK_STORE = 'offline-chunks';

function scopedCopyDirKey(base: string, bindingKey?: string): string {
  return bindingKey ? `${base}:${bindingKey}` : base;
}

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 3);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      const fileStore = req.result.objectStoreNames.contains(IDB_FILE_STORE)
        ? req.transaction!.objectStore(IDB_FILE_STORE)
        : req.result.createObjectStore(IDB_FILE_STORE, { keyPath: 'key' });
      if (!fileStore.indexNames.contains('workspace')) {
        fileStore.createIndex('workspace', 'workspace', { unique: false });
      }
      const chunkStore = req.result.objectStoreNames.contains(IDB_CHUNK_STORE)
        ? req.transaction!.objectStore(IDB_CHUNK_STORE)
        : req.result.createObjectStore(IDB_CHUNK_STORE, { keyPath: 'key' });
      if (!chunkStore.indexNames.contains('workspace')) {
        chunkStore.createIndex('workspace', 'workspace', { unique: false });
      }
      if (!chunkStore.indexNames.contains('transferKey')) {
        chunkStore.createIndex('transferKey', 'transferKey', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(key: string, val: unknown): Promise<void> {
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function idbGet(key: string): Promise<any> {
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const r = tx.objectStore(IDB_STORE).get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }),
  );
}

function idbStorePut(store: string, val: any): Promise<void> {
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(val);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('浏览器离线空间写入已中止'));
      }),
  );
}

function idbStoreGet(store: string, key: string): Promise<any> {
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

function idbIndexAll(store: string, index: string, value: IDBValidKey): Promise<any[]> {
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).index(index).getAll(IDBKeyRange.only(value));
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => reject(req.error);
      }),
  );
}

function idbStoreDeleteMany(store: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const target = tx.objectStore(store);
        for (const key of keys) target.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('浏览器离线空间清理已中止'));
      }),
  );
}

interface ManagedFileRecord {
  key: string;
  workspace: string;
  rel: string;
  data: Blob;
  size: number;
  hash?: string;
  updatedAt: number;
}

interface ManagedChunkRecord {
  key: string;
  workspace: string;
  transferId: string;
  transferKey: string;
  rel: string;
  offset: number;
  data: Blob;
  size: number;
  createdAt: number;
}

function managedKey(workspace: string, rel: string): string {
  return `${encodeURIComponent(workspace)}::${rel}`;
}

/**
 * 平板/移动浏览器的应用托管离线空间。
 *
 * Safari、移动 Chrome 等通常不提供 showDirectoryPicker，但 IndexedDB 可用。
 * 文件仅属于当前站点，不依赖桌面客户端；分块先落临时记录，全部验收后才替换
 * 正式文件，因此中断下载不会破坏已经存在的离线副本。
 */
export class ManagedBrowserLocalFs implements LocalFs {
  readonly kind = 'managed' as const;
  private activeWrites = new Map<string, string>();

  constructor(private workspace: string) {
    // 清掉异常退出遗留的一天前临时分块，避免长期占用平板存储。
    void this.cleanupStaleChunks().catch(() => {});
  }

  label(): string {
    return '平板离线空间';
  }

  id(): string {
    return `managed:${this.workspace}`;
  }

  private async files(): Promise<ManagedFileRecord[]> {
    return idbIndexAll(IDB_FILE_STORE, 'workspace', this.workspace);
  }

  private async file(rel: string): Promise<ManagedFileRecord> {
    const record = await idbStoreGet(IDB_FILE_STORE, managedKey(this.workspace, rel));
    if (!record || record.workspace !== this.workspace) throw new Error(`离线文件不存在：${rel}`);
    return record as ManagedFileRecord;
  }

  private async cleanupTransfer(transferId: string): Promise<void> {
    const chunks = await idbIndexAll(
      IDB_CHUNK_STORE, 'transferKey', `${this.workspace}::${transferId}`,
    );
    await idbStoreDeleteMany(IDB_CHUNK_STORE, chunks.map((item) => item.key));
  }

  private async cleanupStaleChunks(): Promise<void> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const chunks = (await idbIndexAll(IDB_CHUNK_STORE, 'workspace', this.workspace))
      .filter((item) => Number(item?.createdAt || 0) < cutoff);
    await idbStoreDeleteMany(IDB_CHUNK_STORE, chunks.map((item) => item.key));
  }

  async scan(ignore: string[], includeGit = false, options: { hash?: boolean; signal?: AbortSignal } = {}): Promise<Manifest> {
    const out: Manifest = {};
    const records = await this.files();
    // 分批计算哈希，避免大量小文件同时把平板主线程和内存打满。
    for (let start = 0; start < records.length; start += 8) {
      await yieldToUi(options.signal);
      await Promise.all(records.slice(start, start + 8).map(async (record) => {
        if (isIgnored(record.rel, ignore, includeGit)) return;
        const hash = options.hash === false ? '' : record.hash || await sha256BlobHex(record.data);
        out[record.rel] = {
          hash,
          size: record.size,
          mtime: record.updatedAt,
        };
        if (hash && !record.hash) await idbStorePut(IDB_FILE_STORE, { ...record, hash });
      }));
    }
    return out;
  }

  async listDir(rel: string): Promise<LocalEntry[]> {
    const manifest: Manifest = {};
    for (const record of await this.files()) manifest[record.rel] = { hash: '', size: record.size };
    return levelFromManifest(manifest, rel);
  }

  async readFile(rel: string): Promise<string> {
    return arrayBufferToBase64(await (await this.file(rel)).data.arrayBuffer());
  }

  async readBlob(rel: string): Promise<Blob> {
    return (await this.file(rel)).data;
  }

  async writeFile(rel: string, base64: string): Promise<void> {
    const data = base64ToBlob(base64);
    await this.writeBlob(rel, data);
  }

  async writeBlob(rel: string, data: Blob): Promise<void> {
    await idbStorePut(IDB_FILE_STORE, {
      key: managedKey(this.workspace, rel), workspace: this.workspace, rel,
      data, size: data.size, hash: undefined, updatedAt: Date.now(),
    } satisfies ManagedFileRecord);
  }

  async fileSize(rel: string): Promise<number> {
    return (await this.file(rel)).size;
  }

  async readChunk(rel: string, offset: number, size: number): Promise<string> {
    const record = await this.file(rel);
    return arrayBufferToBase64(await record.data.slice(offset, offset + size).arrayBuffer());
  }

  async writeStart(rel: string, transferId: string): Promise<void> {
    if (this.activeWrites.has(transferId)) throw new Error('传输标识重复');
    await this.cleanupTransfer(transferId);
    this.activeWrites.set(transferId, rel);
  }

  async writeChunk(rel: string, transferId: string, offset: number, base64: string): Promise<void> {
    if (this.activeWrites.get(transferId) !== rel) throw new Error('写入会话不存在');
    const data = base64ToBlob(base64);
    const key = `${managedKey(this.workspace, rel)}::${transferId}::${String(offset).padStart(16, '0')}`;
    await idbStorePut(IDB_CHUNK_STORE, {
      key, workspace: this.workspace, transferId,
      transferKey: `${this.workspace}::${transferId}`, rel, offset,
      data, size: data.size, createdAt: Date.now(),
    } satisfies ManagedChunkRecord);
  }

  async writeFinish(rel: string, transferId: string, expectedSize: number): Promise<void> {
    if (this.activeWrites.get(transferId) !== rel) throw new Error('写入会话不存在');
    const chunks = (await idbIndexAll(
      IDB_CHUNK_STORE, 'transferKey', `${this.workspace}::${transferId}`,
    ))
      .sort((a, b) => Number(a.offset) - Number(b.offset)) as ManagedChunkRecord[];
    let nextOffset = 0;
    for (const chunk of chunks) {
      if (chunk.rel !== rel || chunk.offset !== nextOffset) throw new Error(`离线文件分块不连续：${rel}`);
      nextOffset += chunk.size;
    }
    if (nextOffset !== expectedSize) {
      throw new Error(`离线文件大小校验失败：期望 ${expectedSize}，实际 ${nextOffset}`);
    }
    const data = new Blob(chunks.map((chunk) => chunk.data));
    // 正式记录最后写入：此前任何失败都不会覆盖旧副本。
    await idbStorePut(IDB_FILE_STORE, {
      key: managedKey(this.workspace, rel), workspace: this.workspace, rel,
      data, size: data.size, hash: undefined, updatedAt: Date.now(),
    } satisfies ManagedFileRecord);
    this.activeWrites.delete(transferId);
    await idbStoreDeleteMany(IDB_CHUNK_STORE, chunks.map((chunk) => chunk.key));
  }

  async writeAbort(_rel: string, transferId: string): Promise<void> {
    this.activeWrites.delete(transferId);
    await this.cleanupTransfer(transferId);
  }

  async reveal(_rel: string): Promise<void> {
    throw new Error('平板离线空间由浏览器管理，请使用“导出到设备”保存到系统文件夹');
  }

  async deleteFile(rel: string): Promise<void> {
    await idbStoreDeleteMany(IDB_FILE_STORE, [managedKey(this.workspace, rel)]);
  }
}

export function browserDirectoryPickerSupported(): boolean {
  return !isTauri() && typeof (window as any).showDirectoryPicker === 'function';
}

/** 打开不依赖系统目录权限的浏览器持久化空间。 */
export async function useManagedLocalDir(bindingKey?: string): Promise<LocalFs> {
  try {
    await (navigator as any).storage?.persist?.();
  } catch {
    /* 浏览器拒绝持久化授权时仍可使用普通 IndexedDB 配额。 */
  }
  try {
    localStorage.setItem(scopedCopyDirKey(COPYDIR_BROWSER_MODE_KEY, bindingKey), 'managed');
  } catch {
    /* ignore */
  }
  return new ManagedBrowserLocalFs(bindingKey || 'default');
}

/** 当前 Web 页是否具备缓存应用外壳、重启后离线打开的浏览器条件。 */
export function offlineAppShellSupported(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && 'serviceWorker' in navigator;
}

/** 将一个设备文件保存进当前浏览器离线副本。 */
export async function importLocalFile(fs: LocalFs, file: File, rel = file.name): Promise<void> {
  if (fs.writeBlob) {
    await fs.writeBlob(rel, file);
    return;
  }
  await fs.writeFile(rel, arrayBufferToBase64(await file.arrayBuffer()));
}

/** 将离线副本中的文件交给浏览器/系统分享或下载。 */
export async function exportLocalFile(fs: LocalFs, rel: string, filename?: string): Promise<void> {
  const blob = fs.readBlob
    ? await fs.readBlob(rel)
    : base64ToBlob(await fs.readFile(rel));
  const safeName = filename || rel.split('/').filter(Boolean).pop() || 'download';
  const file = new File([blob], safeName, { type: blob.type || 'application/octet-stream' });
  const nav = navigator as any;
  if (typeof nav.share === 'function' && (!nav.canShare || nav.canShare({ files: [file] }))) {
    try {
      await nav.share({ files: [file], title: safeName });
      return;
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      // 分享面板失败时继续回落到浏览器下载。
    }
  }
  const href = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = safeName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  }
}

/** 让用户选择本机副本目录。bindingKey 用于按 session 独立持久化。 */
export async function pickLocalDir(initialPath?: string, bindingKey?: string): Promise<LocalFs | null> {
  if (isTauri()) {
    const path = await api.selectDirectory(initialPath);
    if (!path) return null;
    try {
      localStorage.setItem(scopedCopyDirKey(COPYDIR_TAURI_KEY, bindingKey), path);
    } catch {
      /* 忽略持久化失败 */
    }
    return new TauriLocalFs(path);
  }
  const w = window as any;
  if (typeof w.showDirectoryPicker !== 'function') {
    return useManagedLocalDir(bindingKey);
  }
  const handle = await w.showDirectoryPicker({ mode: 'readwrite' });
  try {
    await idbPut(scopedCopyDirKey(IDB_HANDLE_KEY, bindingKey), handle);
    localStorage.setItem(scopedCopyDirKey(COPYDIR_BROWSER_MODE_KEY, bindingKey), 'directory');
  } catch {
    /* 忽略持久化失败 */
  }
  return new BrowserLocalFs(handle);
}

/** 恢复指定 session 上次选择的副本目录（浏览器侧可能需要用户重新授权）。 */
export async function restoreLocalDir(bindingKey?: string): Promise<LocalFs | null> {
  if (isTauri()) {
    try {
      const path = localStorage.getItem(scopedCopyDirKey(COPYDIR_TAURI_KEY, bindingKey));
      return path ? new TauriLocalFs(path) : null;
    } catch {
      return null;
    }
  }
  try {
    const mode = localStorage.getItem(scopedCopyDirKey(COPYDIR_BROWSER_MODE_KEY, bindingKey));
    if (mode === 'managed') return useManagedLocalDir(bindingKey);
    const handle = await idbGet(scopedCopyDirKey(IDB_HANDLE_KEY, bindingKey));
    if (!handle) return useManagedLocalDir(bindingKey);
    // 浏览器重启后权限通常回落到 prompt，须经用户手势重新授权；
    // 此处只在仍为 granted 时复用，否则让用户重新选择目录（即重新授权）。
    const perm = await handle.queryPermission?.({ mode: 'readwrite' });
    if (perm !== 'granted') return null;
    return new BrowserLocalFs(handle);
  } catch {
    return useManagedLocalDir(bindingKey);
  }
}

// ── 基线快照（localStorage）────────────────────────────────────

function baselineKey(localId: string, workingDir: string): string {
  return `awu-dirsync-baseline:${localId}::${workingDir}`;
}

export function loadBaseline(localId: string, workingDir: string): Manifest {
  try {
    const raw = localStorage.getItem(baselineKey(localId, workingDir));
    return raw ? (JSON.parse(raw) as Manifest) : {};
  } catch {
    return {};
  }
}

export function saveBaseline(localId: string, workingDir: string, manifest: Manifest): void {
  try {
    localStorage.setItem(baselineKey(localId, workingDir), JSON.stringify(manifest));
  } catch (e) {
    console.warn('[dirSync] 基线保存失败', e);
  }
}

// ── 三向比对 ──────────────────────────────────────────────────

/**
 * 计算从 source 端同步到 dest 端需要的变更。
 * pull：source=远端, dest=本地；push：source=本地, dest=远端。
 */
export function computeDiff(
  direction: SyncDirection,
  baseline: Manifest,
  local: Manifest,
  remote: Manifest,
): DiffResult {
  const [src, dst] = direction === 'pull' ? [remote, local] : [local, remote];
  const entries: DiffEntry[] = [];
  const all = new Set([...Object.keys(local), ...Object.keys(remote)]);

  for (const rel of all) {
    const s = src[rel];
    const d = dst[rel];
    const b = baseline[rel];

    if (s && d) {
      if (s.hash === d.hash) continue; // 两端一致
      // 更新 dest；dest 与 source 都相对基线改过 → 冲突
      const dstChanged = !b || d.hash !== b.hash;
      const srcChanged = !b || s.hash !== b.hash;
      entries.push({ rel, action: 'update', size: s.size, conflict: dstChanged && srcChanged });
    } else if (s && !d) {
      if (b) {
        // dest 删除过它；source 若也改过 → 冲突，否则补回
        entries.push({ rel, action: 'add', size: s.size, conflict: s.hash !== b.hash });
      } else {
        // 基线没有 → source 端新增 → 直接补
        entries.push({ rel, action: 'add', size: s.size, conflict: false });
      }
    } else if (!s && d) {
      if (b) {
        // source 删除过它；dest 若改过 → 冲突，否则删除
        entries.push({ rel, action: 'delete', size: 0, conflict: d.hash !== b.hash });
      }
      // 基线没有 → dest 端独有的新文件，尚未同步过去 → 保留，不产生条目
    }
  }

  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  return { direction, entries, conflicts: entries.filter((e) => e.conflict) };
}

// ── 同步会话 ──────────────────────────────────────────────────

interface Endpoint {
  scan(): Promise<Manifest>;
  readFile(rel: string): Promise<string>;
  writeFile(rel: string, base64: string): Promise<void>;
  deleteFile(rel: string): Promise<void>;
}

function remoteEndpoint(workingDir: string, execKey?: string, includeGit = false): Endpoint {
  return {
    async scan() {
      const r = await api.syncManifest(workingDir, execKey, includeGit);
      if (r.status !== 'ok' || !r.files) throw new Error(r.message || '远端清单获取失败');
      return r.files;
    },
    async readFile(rel) {
      const r = await api.syncReadFile(workingDir, rel, execKey);
      if (r.status !== 'ok' || r.data == null) {
        throw new Error(r.message || `读取远端文件失败: ${rel}`);
      }
      return r.data;
    },
    async writeFile(rel, base64) {
      const r = await api.syncWriteFile(workingDir, rel, base64, execKey);
      if (r.status !== 'ok') throw new Error(r.message || `写入远端文件失败: ${rel}`);
    },
    async deleteFile(rel) {
      const r = await api.syncDeleteFile(workingDir, rel, execKey);
      if (r.status !== 'ok') throw new Error(r.message || `删除远端文件失败: ${rel}`);
    },
  };
}

function localEndpoint(fs: LocalFs, ignore: string[], includeGit = false): Endpoint {
  return {
    scan: () => fs.scan(ignore, includeGit),
    readFile: (rel) => fs.readFile(rel),
    writeFile: (rel, b64) => fs.writeFile(rel, b64),
    deleteFile: (rel) => fs.deleteFile(rel),
  };
}

export class DirSyncSession {
  constructor(
    private fs: LocalFs,
    private workingDir: string,
    private ignore: string[],
    private execKey?: string,   // 会话归属的执行节点;远端工作目录在它上面
    private includeGit = false,
  ) {}

  /** 扫描两端 + 三向比对，得到待应用的变更（不落盘）。 */
  async prepare(direction: SyncDirection): Promise<PreparedSync> {
    const localEp = localEndpoint(this.fs, this.ignore, this.includeGit);
    const remoteEp = remoteEndpoint(this.workingDir, this.execKey, this.includeGit);
    const [local, remote] = await Promise.all([localEp.scan(), remoteEp.scan()]);
    const baseline = loadBaseline(this.fs.id(), this.workingDir);
    const diff = computeDiff(direction, baseline, local, remote);
    return { direction, diff, local, remote };
  }

  /** 应用选中的变更条目，逐文件传输，结束后刷新基线。 */
  async apply(
    prepared: PreparedSync,
    selected: DiffEntry[],
    onProgress?: (p: ApplyProgress) => void,
  ): Promise<ApplyResult> {
    const localEp = localEndpoint(this.fs, this.ignore, this.includeGit);
    const remoteEp = remoteEndpoint(this.workingDir, this.execKey, this.includeGit);
    const [src, dst] = prepared.direction === 'pull' ? [remoteEp, localEp] : [localEp, remoteEp];

    const failed: ApplyResult['failed'] = [];
    let applied = 0;
    let done = 0;
    for (const e of selected) {
      done++;
      onProgress?.({ done, total: selected.length, rel: e.rel });
      try {
        if (e.action === 'delete') {
          await dst.deleteFile(e.rel);
        } else {
          if (e.size > SYNC_MAX_FILE) {
            throw new Error(`文件过大，已跳过（>${Math.floor(SYNC_MAX_FILE / 1024 / 1024)}MB）`);
          }
          await dst.writeFile(e.rel, await src.readFile(e.rel));
        }
        applied++;
      } catch (err) {
        failed.push({ rel: e.rel, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 刷新基线：重扫两端，取哈希一致的部分作为新的共同祖先
    try {
      const [local2, remote2] = await Promise.all([localEp.scan(), remoteEp.scan()]);
      const baseline: Manifest = {};
      for (const rel of Object.keys(local2)) {
        if (remote2[rel] && remote2[rel].hash === local2[rel].hash) {
          baseline[rel] = local2[rel];
        }
      }
      saveBaseline(this.fs.id(), this.workingDir, baseline);
    } catch (e) {
      console.warn('[dirSync] 基线刷新失败', e);
    }

    return { applied, failed };
  }
}
