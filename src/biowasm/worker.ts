// biowasm worker — runs INSIDE a node worker_thread only (spawned from
// dist/biowasm-worker.js by the BiowasmEngine). Never import this module from
// the server process: it installs worker-scoped browser shims on globalThis.
//
// Ported from the validated prototype (docs/development/biowasm-prototype/
// harness.mjs + test11-worker.mjs):
//   - XMLHttpRequest / self / self.location shims (package URLs map onto
//     ABSOLUTE cache-dir paths, never CWD-relative)
//   - MODULARIZE factory loading with wasmBinary injection
//   - LazyNodeFS: MEMFS nodes with custom stream_ops backed by cached host fds
//     + positional fs.readSync (mode 0100777 — PROXYFS rejects getMode results)
//   - PROXYFS: first tool's FS owns /shared; others mount it
//   - HostOutFS: /shared/out streams tool writes to the host in bounded
//     chunks under a strict per-run byte budget
//   - exec via callMain + /dev/stdout + /dev/stderr reopen after every run
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

// ---------------------------------------------------------------------------
// Protocol types (imported type-only by the engine).
// ---------------------------------------------------------------------------

export interface BiowasmWorkerInitData {
  assetsDir: string;
  tools: string[];
}

export interface BiowasmWorkerInput {
  name: string;
  content: string;
}

export interface BiowasmWorkerMount {
  hostPath: string;
  vfsPath: string;
}

export interface BiowasmWorkerOutputRequest {
  vfsPath: string;
  maxBytes?: number;
}

export interface BiowasmWorkerOutput {
  vfsPath: string;
  size: number;
  missing?: boolean;
}

export interface BiowasmIoStat {
  bytes: number;
  reads: number;
}

export interface BiowasmCountSummary {
  mode: 'count';
  chars: number;
  lines: number;
  head: string;
  tail: string;
  truncated: boolean;
}

export interface BiowasmCaptureSummary {
  mode: 'capture';
  text: string;
  truncated: boolean;
}

export type BiowasmStdoutSummary = BiowasmCountSummary | BiowasmCaptureSummary;

export interface BiowasmWorkerRunResponse {
  exitCode: number | null;
  stdout: BiowasmStdoutSummary;
  stderr: string;
  outputs: BiowasmWorkerOutput[];
  ioStats: Record<string, BiowasmIoStat>;
  heapBytes: number;
}

// ---------------------------------------------------------------------------
// Emscripten FS typings (minimal surface actually used).
// ---------------------------------------------------------------------------

type ErrnoError = Error & { errno: number };

interface EmscriptenNode {
  id: number;
  name: string;
  mode: number;
  parent: EmscriptenNode;
  timestamp: number;
  node_ops: Record<string, (...args: never[]) => unknown>;
  stream_ops: Record<string, (...args: never[]) => unknown>;
  contents: Record<string, EmscriptenNode>;
  size: number;
  hostPath?: string;
  fdEntry?: FdCacheEntry;
  outState?: OutFileState;
}

interface EmscriptenStream {
  node: EmscriptenNode;
  flags: number;
  position: number;
}

interface EmscriptenFS {
  createNode(parent: EmscriptenNode | null, name: string, mode: number, dev: number): EmscriptenNode;
  ErrnoError: new (errno: number) => ErrnoError;
  mkdirTree(path: string): void;
  lookupPath(path: string, opts?: Record<string, unknown>): { path: string; node: EmscriptenNode };
  mount(type: unknown, opts: Record<string, unknown>, mountpoint: string): void;
  writeFile(path: string, data: Uint8Array): void;
  stat(path: string): { size: number };
  analyzePath(path: string): { exists: boolean; object?: EmscriptenNode };
  open(path: string, flags: string): EmscriptenStream;
  close(stream: EmscriptenStream): void;
  unlink(path: string): void;
  streams: EmscriptenStream[];
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
}

interface BiowasmModule {
  FS: EmscriptenFS;
  PROXYFS: unknown;
  callMain(args: string[]): number | undefined;
  ExitStatus?: new (status: number) => Error;
  HEAPU8: Uint8Array;
}

type ModuleFactory = (overrides: Record<string, unknown>) => Promise<BiowasmModule>;

// Errno numbers are the Emscripten runtime's own table (NOT Linux values):
// EINVAL=28, EIO=29, ENOSPC=51, EROFS=69, ENOENT=44, EXDEV=75, ENOTEMPTY=55.
const EMU_EINVAL = 28;
const EMU_EIO = 29;
const EMU_ENOSPC = 51;
const EMU_EROFS = 69;
const EMU_ENOENT = 44;
const EMU_EXDEV = 75;
const EMU_ENOTEMPTY = 55;

const S_IFREG = 32768;
const S_IFDIR = 16384;
// 0100777 (S_IFREG|0777): PROXYFS rejects nodes whose mode lacks file-type
// bits (FS.getMode returns bare permission bits) — validated in the prototype.
const LAZY_FILE_MODE = S_IFREG | 0o777;
const HOST_OUT_DIR_MODE = S_IFDIR | 0o777;

const HOST_OUT_FLUSH_BYTES = 4 * 1024 * 1024;
const DEFAULT_RUN_OUTPUT_BUDGET = 2 * 1024 * 1024 * 1024;
const HEAD_SAMPLE_BUDGET = 128 * 1024;
const TAIL_SAMPLE_BUDGET = 128 * 1024;
const CAPTURE_CAP = 2 * 1024 * 1024;
const STDERR_CAP = 2 * 1024 * 1024;
const MAX_INPUT_CHARS = 20 * 1024 * 1024;

const port = parentPort;
if (!port) {
  throw new Error('biowasm worker must be started as a worker_thread (no parentPort).');
}
const init = workerData as BiowasmWorkerInitData;
const assetsDir = init.assetsDir;
const toolOrder = init.tools;

// ---------------------------------------------------------------------------
// Browser-compat shims — worker-scoped only; the glue detects a browser-like
// environment through these. XHR package URLs are mapped onto ABSOLUTE
// cache-dir paths (never CWD-relative).
// ---------------------------------------------------------------------------

const locationShim = {
  href: '',
  pathname: '',
  toString(): string {
    return this.href;
  },
};

{
  const g = globalThis as Record<string, unknown>;
  g.self = globalThis;
  g.location = locationShim;
  class WorkerXMLHttpRequest {
    response: ArrayBuffer | null = null;
    responseText = '';
    responseType = '';
    status = 0;
    onload: (() => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    private url = '';

    open(_method: string, url: string): void {
      let p = String(url).split('?')[0];
      if (p.startsWith('file://')) {
        p = decodeURIComponent(p.slice('file://'.length));
      }
      if (!isAbsolute(p)) {
        p = pathResolve(assetsDir, p);
      }
      this.url = p;
    }

    send(): void {
      queueMicrotask(() => {
        try {
          const buf = readFileSync(this.url);
          this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
          this.statusText = 'OK';
          this.status = 200;
          this.onload?.();
        } catch (err) {
          this.status = 404;
          this.onerror?.(err);
        }
      });
    }

    statusText = '';
  }
  g.XMLHttpRequest = WorkerXMLHttpRequest;
}

// ---------------------------------------------------------------------------
// Per-run IO accounting for lazily-mounted host files.
// ---------------------------------------------------------------------------

const ioStats = new Map<string, BiowasmIoStat>();

function ioBump(hostPath: string, bytes: number): void {
  const cur = ioStats.get(hostPath) ?? { bytes: 0, reads: 0 };
  cur.bytes += bytes;
  cur.reads += 1;
  ioStats.set(hostPath, cur);
}

// ---------------------------------------------------------------------------
// LazyNodeFS — MEMFS nodes with fd-backed positional reads (WORKERFS
// replacement). Read-only; writes throw EROFS.
// ---------------------------------------------------------------------------

interface FdCacheEntry {
  fd: number;
  refs: number;
}

const fdCache = new Map<string, FdCacheEntry>();

function fdFor(hostPath: string): FdCacheEntry {
  let entry = fdCache.get(hostPath);
  if (!entry) {
    entry = { fd: openSync(hostPath, 'r'), refs: 0 };
    fdCache.set(hostPath, entry);
  }
  entry.refs++;
  return entry;
}

function closeAllFds(): void {
  for (const [, entry] of fdCache) {
    try {
      closeSync(entry.fd);
    } catch {
      void 0;
    }
  }
  fdCache.clear();
}

function makeLazyNodeFS(FS: EmscriptenFS) {
  const nodeOps = {
    getattr(node: EmscriptenNode) {
      const st = statSync(node.hostPath!);
      return {
        dev: 1,
        ino: node.id,
        mode: node.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size: node.size,
        atime: st.atime,
        mtime: st.mtime,
        ctime: st.ctime,
        blksize: 4096,
        blocks: Math.ceil(node.size / 4096),
      };
    },
    setattr(node: EmscriptenNode, attr: { size?: number }) {
      if (attr.size !== undefined) node.size = attr.size;
    },
  };
  const streamOps = {
    open(stream: EmscriptenStream) {
      stream.node.fdEntry = fdFor(stream.node.hostPath!);
    },
    close(stream: EmscriptenStream) {
      const entry = stream.node.fdEntry;
      if (entry && --entry.refs <= 0) {
        try {
          closeSync(entry.fd);
        } catch {
          void 0;
        }
        fdCache.delete(stream.node.hostPath!);
      }
    },
    read(stream: EmscriptenStream, buffer: Uint8Array, offset: number, length: number, position: number) {
      const n = readSync(
        stream.node.fdEntry!.fd,
        Buffer.from(buffer.buffer, buffer.byteOffset + offset, length),
        0,
        length,
        position,
      );
      if (n > 0) ioBump(stream.node.hostPath!, n);
      return n;
    },
    write() {
      throw new FS.ErrnoError(EMU_EROFS);
    },
    llseek(stream: EmscriptenStream, offset: number, whence: number) {
      const size = stream.node.size;
      if (whence === 1) offset += stream.position;
      else if (whence === 2) offset += size;
      if (offset < 0) throw new FS.ErrnoError(EMU_EINVAL);
      return offset;
    },
  };
  return {
    mountHostFile(hostPath: string, vfsPath: string): void {
      const parts = vfsPath.split('/');
      const name = parts.pop();
      const dir = parts.join('/') || '/';
      if (!name) throw new Error(`invalid vfsPath: ${vfsPath}`);
      FS.mkdirTree(dir);
      const st = statSync(hostPath);
      const node = FS.createNode(FS.lookupPath(dir, { follow: true }).node, name, LAZY_FILE_MODE, 0);
      node.size = st.size;
      node.hostPath = hostPath;
      node.node_ops = nodeOps as unknown as EmscriptenNode['node_ops'];
      node.stream_ops = streamOps as unknown as EmscriptenNode['stream_ops'];
    },
  };
}

// ---------------------------------------------------------------------------
// HostOutFS — /shared/out with host-streamed writes, bounded buffering, and a
// strict synchronous per-run byte budget. Over-budget writes throw ENOSPC so
// the tool fails cleanly instead of OOM-aborting the wasm heap.
// ---------------------------------------------------------------------------

interface OutFileState {
  kind: 'file' | 'dir';
  vfsPath: string;
  size: number;
  flushed: number;
  acked: number;
  hostPath: string | null;
  buffered: Buffer[];
  bufferedBytes: number;
  mtime: Date;
}

interface RunBudget {
  perFile: Map<string, number>;
  totalUsed: number;
  maxTotal: number;
}

let currentRunBudget: RunBudget | null = null;
let lastBudgetError: string | null = null;

const outFiles = new Set<OutFileState>();
const hostReadFds = new Map<string, number>();

function post(message: Record<string, unknown>): void {
  port!.postMessage(message);
}

function outFd(FS: EmscriptenFS, st: OutFileState): number {
  if (!st.hostPath) {
    throw new FS.ErrnoError(EMU_EIO);
  }
  let fd = hostReadFds.get(st.hostPath) ?? null;
  if (fd === null) {
    fd = openSync(st.hostPath, 'r');
    hostReadFds.set(st.hostPath, fd);
  }
  return fd;
}

function dropOutFile(st: OutFileState): void {
  outFiles.delete(st);
  if (st.kind === 'file') {
    // The host-side artifact is removed via the unlink notification.
    post({ cmd: 'unlink', vfsPath: st.vfsPath });
  }
}

function flushOutFile(st: OutFileState): void {
  if (st.bufferedBytes === 0) return;
  const merged = st.buffered.length === 1 ? st.buffered[0] : Buffer.concat(st.buffered);
  post({ cmd: 'flush', vfsPath: st.vfsPath, chunk: merged });
  st.flushed = st.size;
  st.buffered = [];
  st.bufferedBytes = 0;
}

function flushAllOutFiles(): void {
  for (const st of outFiles) {
    if (st.bufferedBytes > 0) flushOutFile(st);
  }
}

function truncateOutFile(st: OutFileState, size: number): void {
  if (size > st.size) {
    // Sparse extension: the gap reads back as zeros.
    st.size = size;
    return;
  }
  if (size === 0) {
    st.buffered = [];
    st.bufferedBytes = 0;
    st.size = 0;
    st.flushed = 0;
    st.acked = 0;
  } else {
    let excess = st.size - size;
    st.size = size;
    while (excess > 0 && st.buffered.length > 0) {
      const last = st.buffered[st.buffered.length - 1];
      if (last.length <= excess) {
        st.buffered.pop();
        st.bufferedBytes -= last.length;
        excess -= last.length;
      } else {
        st.buffered[st.buffered.length - 1] = last.subarray(0, last.length - excess);
        st.bufferedBytes -= excess;
        excess = 0;
      }
    }
    if (st.flushed > size) {
      st.flushed = size;
      st.acked = Math.min(st.acked, size);
    }
  }
  post({ cmd: 'truncate', vfsPath: st.vfsPath, size });
  st.mtime = new Date();
}

function createHostOutFS(FS: EmscriptenFS): { mount(mount: unknown): EmscriptenNode } {
  const vfsPathOf = (node: EmscriptenNode): string => node.outState!.vfsPath;

  const fileNodeOps = {
    getattr(node: EmscriptenNode) {
      const st = node.outState!;
      return {
        dev: 1,
        ino: node.id,
        mode: node.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size: st.size,
        atime: st.mtime,
        mtime: st.mtime,
        ctime: st.mtime,
        blksize: 4096,
        blocks: Math.ceil(st.size / 4096),
      };
    },
    setattr(node: EmscriptenNode, attr: { size?: number; timestamp?: number }) {
      const st = node.outState!;
      if (attr.size !== undefined && attr.size !== st.size) truncateOutFile(st, attr.size);
      if (attr.timestamp !== undefined) st.mtime = new Date(attr.timestamp);
    },
  };

  const fileStreamOps = {
    open(_stream: EmscriptenStream) {
      void 0;
    },
    close(_stream: EmscriptenStream) {
      void 0;
    },
    read(stream: EmscriptenStream, buffer: Uint8Array, offset: number, length: number, position: number | null) {
      const st = stream.node.outState!;
      const base = position === null || position === undefined ? stream.position : position;
      let done = 0;
      while (done < length) {
        const p = base + done;
        if (p >= st.size) break;
        if (p < st.acked) {
          const want = Math.min(length - done, st.acked - p);
          const n = readSync(outFd(FS, st), Buffer.from(buffer.buffer, buffer.byteOffset + offset + done, want), 0, want, p);
          if (n <= 0) break;
          done += n;
        } else if (p >= st.flushed) {
          // Served from the in-worker buffer [flushed, size).
          const rel = p - st.flushed;
          let remaining = Math.min(length - done, st.size - p);
          let chunkIdx = 0;
          let chunkSkip = rel;
          while (chunkIdx < st.buffered.length && chunkSkip >= st.buffered[chunkIdx].length) {
            chunkSkip -= st.buffered[chunkIdx].length;
            chunkIdx++;
          }
          while (remaining > 0 && chunkIdx < st.buffered.length) {
            const chunk = st.buffered[chunkIdx];
            const take = Math.min(remaining, chunk.length - chunkSkip);
            Buffer.from(buffer.buffer, buffer.byteOffset + offset + done, take).set(chunk.subarray(chunkSkip, chunkSkip + take));
            done += take;
            remaining -= take;
            chunkIdx++;
            chunkSkip = 0;
          }
          if (remaining > 0) break;
        } else {
          // [acked, flushed): a flush is in flight; cannot serve synchronously.
          throw new FS.ErrnoError(EMU_EIO);
        }
      }
      return done;
    },
    write(stream: EmscriptenStream, buffer: Uint8Array, offset: number, length: number, position: number | null) {
      const st = stream.node.outState!;
      const pos = position === null || position === undefined ? stream.position : position;
      if (pos > st.size || pos < st.flushed) {
        throw new FS.ErrnoError(EMU_EINVAL);
      }
      const budget = currentRunBudget;
      if (budget) {
        const maxFile = budget.perFile.get(st.vfsPath);
        if (maxFile !== undefined && st.size + length > maxFile) {
          lastBudgetError =
            `output ${st.vfsPath} exceeded its maxBytes budget (${maxFile} bytes); ` +
            'raise outputs[].maxBytes or write a smaller file';
          throw new FS.ErrnoError(EMU_ENOSPC);
        }
        if (budget.totalUsed + length > budget.maxTotal) {
          lastBudgetError =
            `per-run output byte budget exceeded (${budget.maxTotal} bytes across /shared/out); ` +
            'split the work into smaller runs';
          throw new FS.ErrnoError(EMU_ENOSPC);
        }
        budget.totalUsed += length;
      }
      if (pos < st.size) {
        // Rewrite of the unflushed tail: drop bytes beyond pos first.
        let excess = st.size - pos;
        st.size = pos;
        while (excess > 0 && st.buffered.length > 0) {
          const last = st.buffered[st.buffered.length - 1];
          if (last.length <= excess) {
            st.buffered.pop();
            st.bufferedBytes -= last.length;
            excess -= last.length;
          } else {
            st.buffered[st.buffered.length - 1] = last.subarray(0, last.length - excess);
            st.bufferedBytes -= excess;
            excess = 0;
          }
        }
      }
      // Copy: `buffer` is a view into the wasm heap and mutates afterwards.
      const chunk = Buffer.from(buffer.subarray(offset, offset + length));
      st.buffered.push(chunk);
      st.bufferedBytes += chunk.length;
      st.size += length;
      st.mtime = new Date();
      if (st.bufferedBytes >= HOST_OUT_FLUSH_BYTES) flushOutFile(st);
      return length;
    },
    llseek(stream: EmscriptenStream, offset: number, whence: number) {
      const st = stream.node.outState!;
      let pos = offset;
      if (whence === 1) pos += stream.position;
      else if (whence === 2) pos += st.size;
      if (pos < 0) throw new FS.ErrnoError(EMU_EINVAL);
      return pos;
    },
  };

  const dirNodeOps = {
    getattr(node: EmscriptenNode) {
      const now = new Date();
      return {
        dev: 1,
        ino: node.id,
        mode: node.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size: 4096,
        atime: now,
        mtime: now,
        ctime: now,
        blksize: 4096,
        blocks: 8,
      };
    },
    setattr(_node: EmscriptenNode, _attr: unknown) {
      void 0;
    },
    lookup(parent: EmscriptenNode, name: string) {
      const hit = parent.contents[name];
      if (!hit) throw new FS.ErrnoError(EMU_ENOENT);
      return hit;
    },
    mknod(parent: EmscriptenNode, name: string, mode: number, dev: number) {
      const parentPath = vfsPathOf(parent);
      const vfsPath = `${parentPath}/${name}`;
      const node = FS.createNode(parent, name, FS.isDir(mode) ? mode : LAZY_FILE_MODE, dev);
      if (FS.isDir(mode)) {
        node.contents = {};
        node.node_ops = dirNodeOps as unknown as EmscriptenNode['node_ops'];
        node.outState = newOutState('dir', vfsPath);
      } else {
        node.outState = newOutState('file', vfsPath);
        outFiles.add(node.outState);
        node.node_ops = fileNodeOps as unknown as EmscriptenNode['node_ops'];
        node.stream_ops = fileStreamOps as unknown as EmscriptenNode['stream_ops'];
      }
      parent.contents[name] = node;
      return node;
    },
    readdir(node: EmscriptenNode) {
      return Object.keys(node.contents).concat('.', '..');
    },
    unlink(parent: EmscriptenNode, name: string) {
      const node = parent.contents[name];
      if (!node) throw new FS.ErrnoError(EMU_ENOENT);
      if (node.outState) dropOutFile(node.outState);
      delete parent.contents[name];
      parent.timestamp = Date.now();
    },
    rmdir(parent: EmscriptenNode, name: string) {
      const node = parent.contents[name];
      if (!node) throw new FS.ErrnoError(EMU_ENOENT);
      if (Object.keys(node.contents).length > 0) throw new FS.ErrnoError(EMU_ENOTEMPTY);
      delete parent.contents[name];
      parent.timestamp = Date.now();
    },
    rename(oldNode: EmscriptenNode, newDir: EmscriptenNode, newName: string) {
      if (oldNode.parent.node_ops !== newDir.node_ops) {
        throw new FS.ErrnoError(EMU_EXDEV);
      }
      delete oldNode.parent.contents[oldNode.name];
      oldNode.parent.timestamp = Date.now();
      oldNode.parent = newDir;
      oldNode.name = newName;
      newDir.contents[newName] = oldNode;
      newDir.timestamp = Date.now();
      if (oldNode.outState) {
        const from = oldNode.outState.vfsPath;
        const parentPath = vfsPathOf(newDir);
        oldNode.outState.vfsPath = `${parentPath}/${newName}`;
        post({ cmd: 'rename', from, to: oldNode.outState.vfsPath });
      }
    },
  };

  return {
    mount() {
      const root = FS.createNode(null, '/', HOST_OUT_DIR_MODE, 0);
      root.contents = {};
      root.node_ops = dirNodeOps as unknown as EmscriptenNode['node_ops'];
      root.outState = newOutState('dir', '/shared/out');
      return root;
    },
  };
}

function newOutState(kind: 'file' | 'dir', vfsPath: string): OutFileState {
  return {
    kind,
    vfsPath,
    size: kind === 'dir' ? 4096 : 0,
    flushed: 0,
    acked: 0,
    hostPath: null,
    buffered: [],
    bufferedBytes: 0,
    mtime: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Module loader — cached MODULARIZE factories, PROXYFS sharing, stdout sinks.
// ---------------------------------------------------------------------------

interface LoadedModule {
  name: string;
  Module: BiowasmModule;
}

const modules = new Map<string, LoadedModule>();
let sharedOwner: LoadedModule | null = null;
let ownerLazyFS: ReturnType<typeof makeLazyNodeFS> | null = null;
let hostOutFS: ReturnType<typeof createHostOutFS> | null = null;

let currentOutSink: Sink | null = null;
let currentErrSink: Sink | null = null;

interface Sink {
  line(text: string): void;
}

class CountingSink implements Sink {
  readonly mode = 'count' as const;
  chars = 0;
  lines = 0;
  truncated = false;
  private headParts: string[] = [];
  private headBytes = 0;
  private tailParts: string[] = [];
  private tailBytes = 0;

  line(text: string): void {
    const bytes = Buffer.byteLength(text) + 1;
    this.chars += text.length + 1;
    this.lines += 1;
    if (this.headBytes + bytes <= HEAD_SAMPLE_BUDGET) {
      this.headParts.push(text);
      this.headBytes += bytes;
    } else {
      this.truncated = true;
    }
    this.tailParts.push(text);
    this.tailBytes += bytes;
    while (this.tailBytes > TAIL_SAMPLE_BUDGET && this.tailParts.length > 1) {
      const drop = this.tailParts.shift()!;
      this.tailBytes -= Buffer.byteLength(drop) + 1;
      this.truncated = true;
    }
  }

  summary(): BiowasmCountSummary {
    return {
      mode: 'count',
      chars: this.chars,
      lines: this.lines,
      head: this.headParts.join('\n'),
      tail: this.tailParts.join('\n'),
      truncated: this.truncated,
    };
  }
}

class CaptureSink implements Sink {
  readonly mode = 'capture' as const;
  private parts: string[] = [];
  private chars = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  line(text: string): void {
    if (this.chars >= this.cap) {
      this.truncated = true;
      return;
    }
    if (this.chars + text.length > this.cap) {
      this.truncated = true;
      return;
    }
    this.parts.push(text);
    this.chars += text.length;
  }

  text(): string {
    return this.parts.join('\n');
  }
}

async function loadTool(name: string): Promise<void> {
  if (modules.has(name)) return;
  const jsPath = join(assetsDir, `${name}.js`);
  const jsUrl = pathToFileURL(jsPath);
  locationShim.href = jsUrl.href;
  locationShim.pathname = decodeURIComponent(jsUrl.pathname);
  const imported = (await import(jsUrl.href)) as { default?: ModuleFactory } & ModuleFactory;
  const factory = imported.default ?? imported;
  const Module = await factory({
    print: (text: unknown) => currentOutSink?.line(String(text ?? '')),
    printErr: (text: unknown) => currentErrSink?.line(String(text ?? '')),
    wasmBinary: readFileSync(join(assetsDir, `${name}.wasm`)),
    noExitRuntime: true,
  });
  const loaded: LoadedModule = { name, Module };
  modules.set(name, loaded);
  const FS = Module.FS;
  if (!sharedOwner) {
    sharedOwner = loaded;
    ownerLazyFS = makeLazyNodeFS(FS);
    hostOutFS = createHostOutFS(FS);
    FS.mkdirTree('/shared');
    FS.mkdirTree('/shared/data');
    FS.mkdirTree('/shared/out');
    FS.mount(hostOutFS, {}, '/shared/out');
  } else {
    FS.mkdirTree('/shared');
    FS.mount(Module.PROXYFS, { root: '/shared', fs: sharedOwner.Module.FS }, '/shared');
  }
}

/** Tools that call exit() (e.g. bcftools) close stdio; reopen like Aioli. */
function reopenStreams(Module: BiowasmModule): void {
  const FS = Module.FS;
  try {
    FS.close(FS.streams[1]);
    FS.close(FS.streams[2]);
  } catch {
    void 0;
  }
  try {
    FS.streams[1] = FS.open('/dev/stdout', 'w');
    FS.streams[2] = FS.open('/dev/stderr', 'w');
  } catch {
    void 0;
  }
}

function isExitStatus(err: unknown, Module: BiowasmModule): boolean {
  if (Module.ExitStatus && err instanceof Module.ExitStatus) return true;
  const msg = String((err as Error)?.message ?? err);
  return /^EXITSTATUS|^exit\b/.test(msg);
}

// ---------------------------------------------------------------------------
// Run execution.
// ---------------------------------------------------------------------------

const mountedFiles = new Map<string, string>();

function sanitizeInputName(name: string): string {
  const base = name.split('/').pop() ?? '';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe === '' || safe === '.' || safe === '..' ? `input-${Date.now()}` : safe;
}

async function handleRun(msg: {
  tool: string;
  args: string[];
  inputs?: BiowasmWorkerInput[];
  mounts?: BiowasmWorkerMount[];
  outputs?: BiowasmWorkerOutputRequest[];
  stdoutSink?: 'count' | 'capture';
}): Promise<BiowasmWorkerRunResponse> {
  const loaded = modules.get(msg.tool);
  if (!loaded) {
    throw new Error(`tool not loaded in worker: ${msg.tool}`);
  }
  const ownerFS = sharedOwner!.Module.FS;

  ioStats.clear();
  lastBudgetError = null;
  const outSink: Sink = msg.stdoutSink === 'capture' ? new CaptureSink(CAPTURE_CAP) : new CountingSink();
  const errSink = new CaptureSink(STDERR_CAP);
  const budget: RunBudget = {
    perFile: new Map((msg.outputs ?? []).map((o) => [o.vfsPath, o.maxBytes ?? Number.POSITIVE_INFINITY])),
    totalUsed: 0,
    maxTotal: DEFAULT_RUN_OUTPUT_BUDGET,
  };
  currentRunBudget = budget;

  try {
    for (const input of msg.inputs ?? []) {
      if (input.content.length > MAX_INPUT_CHARS) {
        throw new Error(`input ${input.name} exceeds the in-band content cap (${MAX_INPUT_CHARS} chars); mount a host file instead`);
      }
      const bytes = new TextEncoder().encode(input.content);
      ownerFS.writeFile(`/shared/data/${sanitizeInputName(input.name)}`, bytes);
    }
    for (const mount of msg.mounts ?? []) {
      const existing = mountedFiles.get(mount.vfsPath);
      if (existing === mount.hostPath) continue;
      if (existing !== undefined) {
        throw new Error(`vfs path ${mount.vfsPath} is already mounted from ${existing}`);
      }
      ownerLazyFS!.mountHostFile(mount.hostPath, mount.vfsPath);
      mountedFiles.set(mount.vfsPath, mount.hostPath);
    }

    currentOutSink = outSink;
    currentErrSink = errSink;
    let exitCode: number | null;
    try {
      // biowasm builds take bare subcommand args (no leading tool name).
      exitCode = loaded.Module.callMain(msg.args) ?? 0;
    } catch (err) {
      if (isExitStatus(err, loaded.Module)) {
        exitCode = (err as { status?: number }).status ?? 0;
      } else {
        throw err;
      }
    } finally {
      currentOutSink = null;
      currentErrSink = null;
      reopenStreams(loaded.Module);
    }
    // A budget breach surfaces as an errno-driven write failure inside wasm
    // (syscall shims swallow the ErrnoError), so detect it via the flag.
    if (lastBudgetError) {
      throw new Error(`${lastBudgetError} (tool exit code ${exitCode})`);
    }
    flushAllOutFiles();

    const outputs: BiowasmWorkerOutput[] = (msg.outputs ?? []).map((o) => {
      const existing = ownerFS.analyzePath(o.vfsPath);
      if (!existing.exists || !existing.object?.outState) {
        return { vfsPath: o.vfsPath, size: 0, missing: true };
      }
      return { vfsPath: o.vfsPath, size: existing.object.outState.size };
    });
    const perFile: Record<string, BiowasmIoStat> = {};
    for (const [hostPath, stat] of ioStats) perFile[hostPath] = stat;
    return {
      exitCode,
      stdout:
        outSink instanceof CountingSink
          ? outSink.summary()
          : { mode: 'capture', text: (outSink as CaptureSink).text(), truncated: (outSink as CaptureSink).truncated },
      stderr: errSink.text(),
      outputs,
      ioStats: perFile,
      heapBytes: loaded.Module.HEAPU8.length,
    };
  } finally {
    currentRunBudget = null;
  }
}

// ---------------------------------------------------------------------------
// RPC dispatch.
// ---------------------------------------------------------------------------

port!.on('message', (raw: unknown) => {
  const msg = raw as { id?: number; cmd?: string; vfsPath?: string; hostPath?: string | null; ackedBytes?: number };
  if (msg && msg.cmd === 'flush-ack' && typeof msg.vfsPath === 'string') {
    for (const st of outFiles) {
      if (st.vfsPath === msg.vfsPath) {
        if (typeof msg.hostPath === 'string') st.hostPath = msg.hostPath;
        // Clamp to flushed: the host file size after append is authoritative.
        st.acked = Math.min(typeof msg.ackedBytes === 'number' ? msg.ackedBytes : 0, st.flushed);
        break;
      }
    }
    return;
  }
  if (!msg || typeof msg.id !== 'number') return;
  if (msg.cmd === 'shutdown') {
    closeAllFds();
    process.exit(0);
  }
  if (msg.cmd === 'init') {
    (async () => {
      try {
        for (const tool of toolOrder) await loadTool(tool);
        post({ id: msg.id, ok: true });
      } catch (err) {
        post({ id: msg.id, ok: false, error: `failed to load biowasm modules from ${assetsDir}: ${String((err as Error)?.message ?? err)}` });
      }
    })();
    return;
  }
  if (msg.cmd === 'run') {
    (async () => {
      try {
        const response = await handleRun(msg as unknown as Parameters<typeof handleRun>[0]);
        post({ id: msg.id, ok: true, ...response });
      } catch (err) {
        post({ id: msg.id, ok: false, error: String((err as Error)?.message ?? err) });
      }
    })();
    return;
  }
});
