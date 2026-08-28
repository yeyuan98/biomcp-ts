// harness.mjs — prototype Node loader for biowasm modules (in-process)
// Emulates Aioli's PROXYFS sharing + WORKERFS lazy mounts, but backed by Node fs.
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ASSETS = (typeof __dirname !== 'undefined'
  ? __dirname + '/'
  : new URL('.', import.meta.url).pathname);

// --- browser-compat shims (needed once per process) ---
let shimmed = false;
export function shimBrowser() {
  if (shimmed) return;
  shimmed = true;
  globalThis.self = globalThis;
  globalThis.XMLHttpRequest = class {
    open(_m, url) { this.url = String(url).replace(/^file:\/\//, ''); }
    send() {
      queueMicrotask(() => {
        try {
          const buf = readFileSync(this.url);
          this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          this.status = 200; this.onload?.();
        } catch (e) { this.status = 404; this.onerror?.(e); }
      });
    }
  };
}

// --- read instrumentation ---
export const ioStats = { perFile: new Map(), reset() { this.perFile.clear(); } };
function bump(path, n) {
  const cur = ioStats.perFile.get(path) ?? { bytes: 0, reads: 0 };
  cur.bytes += n; cur.reads += 1;
  ioStats.perFile.set(path, cur);
}

// --- lazy file nodes backed by host fds (WORKERFS replacement) ---
const fdCache = new Map();
function fdFor(hostPath) {
  let e = fdCache.get(hostPath);
  if (!e) { e = { fd: openSync(hostPath, 'r'), refs: 0 }; fdCache.set(hostPath, e); }
  e.refs++;
  return e;
}
export function closeAllFds() { for (const [, e] of fdCache) closeSync(e.fd); fdCache.clear(); }

export function mountHostFile(Module, hostPath, vfsPath) {
  const FS = Module.FS;
  const parts = vfsPath.split('/');
  const name = parts.pop();
  const dir = parts.join('/') || '/';
  FS.mkdirTree(dir);
  const st = statSync(hostPath);
  const node = FS.createNode(FS.lookupPath(dir, { follow: true }).node, name, 33279, 0); // 0100777 S_IFREG|0777 like WORKERFS
  node.size = st.size;
  node.hostPath = hostPath;
  node.node_ops = {
    getattr(n) {
      return {
        dev: 1, ino: n.id, mode: n.mode, nlink: 1, uid: 0, gid: 0, rdev: 0,
        size: n.size, atime: st.atime, mtime: st.mtime, ctime: st.ctime,
        blksize: 4096, blocks: Math.ceil(n.size / 4096),
      };
    },
    setattr(n, a) { if (a.size !== undefined) n.size = a.size; },
  };
  node.stream_ops = {
    open(stream) { stream.node.fdEntry = fdFor(hostPath); },
    close(stream) {
      const e = stream.node.fdEntry;
      if (e && --e.refs <= 0) { closeSync(e.fd); fdCache.delete(hostPath); }
    },
    read(stream, buffer, offset, length, position) {
      const n = readSync(stream.node.fdEntry.fd, Buffer.from(buffer.buffer, buffer.byteOffset + offset, length), 0, length, position);
      if (n > 0) bump(hostPath, n);
      return n;
    },
    write() { throw new FS.ErrnoError(30); }, // EROFS
    llseek(stream, offset, whence) {
      const size = stream.node.size;
      if (whence === 1) offset += stream.position;
      else if (whence === 2) offset += size;
      if (offset < 0) throw new FS.ErrnoError(28);
      return offset;
    },
  };
  return node;
}

// --- module loader ---
const loaded = new Map();
export async function loadTool(name, { shareFrom = null, quiet = false } = {}) {
  shimBrowser();
  const key = name + (quiet ? ':q' : '');
  if (loaded.has(key)) return loaded.get(key);
  globalThis.location = { href: pathToFileURL(ASSETS + name + '.js').href };

  const stdout = [], stderr = [];
  const stats = { outChars: 0, errChars: 0 };
  const p = quiet
    ? (t) => { stats.outChars += (t?.length ?? 0) + 1; }
    : (t) => { stdout.push(t); };
  const pe = quiet
    ? (t) => { stats.errChars += (t?.length ?? 0) + 1; }
    : (t) => { stderr.push(t); };
  const factory = (await import(pathToFileURL(ASSETS + name + '.js').href)).default;
  const Module = await factory({
    print: p,
    printErr: pe,
    wasmBinary: readFileSync(ASSETS + name + '.wasm'),
    noExitRuntime: true,
  });

  const m = { name, Module, stdout, stderr, quiet, stats };
  loaded.set(key, m);

  if (shareFrom) {
    // Mount the owner's /shared into this module so all tools see one FS
    const FS = Module.FS;
    FS.mkdirTree('/shared');
    if (!FS.analyzePath('/shared/x_probe_mount').exists) {
      try {
        FS.mount(Module.PROXYFS, { root: '/shared', fs: shareFrom.Module.FS }, '/shared');
        // probe: create a marker through the mount to verify liveness
        try { FS.stat('/shared/data'); } catch { FS.mkdirTree('/shared/data'); }
      } catch (e) {
        console.error(`[harness] PROXYFS mount failed for ${name}: errno=${e?.errno} ${String(e?.message ?? e).slice(0, 80)}`);
      }
    }
  }
  return m;
}

// Ensure shared dir exists in owner
export function initShared(owner) {
  owner.Module.FS.mkdirTree('/shared');
  owner.Module.FS.mkdirTree('/shared/data');
  owner.Module.FS.mkdirTree('/shared/out');
}

// --- exec helper: capture stdout/stderr, reset streams like Aioli ---
export function run(m, args) {
  const { Module } = m;
  const wasQuiet = m.quiet;
  m.stdout.length = 0; m.stderr.length = 0;
  m.stats.outChars = 0; m.stats.errChars = 0;
  const t0 = performance.now();
  let rc = 0;
  try {
    rc = Module.callMain(args);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/EXITSTATUS|^exit/.test(msg) && !(e instanceof Module.ExitStatus)) throw e;
    rc = e.status ?? 0;
  }
  // Tools that call exit() close stdio streams; reopen like Aioli does
  const FS = Module.FS;
  try { FS.close(FS.streams[1]); FS.close(FS.streams[2]); } catch {}
  try {
    FS.streams[1] = FS.open('/dev/stdout', 'w');
    FS.streams[2] = FS.open('/dev/stderr', 'w');
  } catch {}
  const ms = performance.now() - t0;
  return {
    rc,
    out: wasQuiet ? '' : m.stdout.join('\n'),
    outStats: wasQuiet ? { chars: m.stats.outChars, lines: -1 } : { chars: m.stdout.join('').length, lines: m.stdout.length },
    err: wasQuiet ? '' : m.stderr.join('\n'),
    ms: Math.round(ms),
    heapMB: +(Module.HEAPU8.length / 1048576).toFixed(1),
  };
}

// --- memory watcher ---
export function memWatch() {
  const state = { peakRssMB: 0, stop: false };
  const tick = () => {
    if (state.stop) return;
    const rss = process.memoryUsage().rss / 1048576;
    if (rss > state.peakRssMB) state.peakRssMB = rss;
    setTimeout(tick, 50);
  };
  tick();
  return state;
}

export function report(label, r, state, note = '') {
  const io = [...ioStats.perFile.entries()]
    .map(([f, s]) => `${f.split('/').pop()}: ${(s.bytes / 1048576).toFixed(1)}MB in ${s.reads} reads`)
    .join('; ') || 'no host IO';
  console.log(`[${label}] rc=${r.rc} ${r.ms}ms heap=${r.heapMB}MB peakRSS=${state.peakRssMB.toFixed(0)}MB | IO ${io} ${note}`);
}
