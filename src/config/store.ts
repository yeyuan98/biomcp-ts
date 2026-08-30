import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Persistence for the `.biomcp.json` project config file. File I/O only —
 * all config semantics live in handler.ts. Hardened by contract:
 * symlink-refusing reads, 64 KiB size cap, same-dir random-suffix O_EXCL
 * temp + fsync + rename atomic writes, mode 0o600.
 *
 * Accepted race windows (same-trust-domain): the lstat→read/write guards
 * are not atomic against a concurrent swap of the path to a symlink or a
 * growing file; an attacker with write access to the directory could race
 * them. The config file itself lives in that directory, so this is within
 * the existing trust boundary.
 */

export const CONFIG_FILE_NAME = '.biomcp.json';
export const CONFIG_FILE_MAX_BYTES = 64 * 1024;

export class ConfigStoreError extends Error {
  readonly code: 'symlink' | 'too-large' | 'unreadable' | 'not-a-directory';
  constructor(code: ConfigStoreError['code'], message: string) {
    super(message);
    this.name = 'ConfigStoreError';
    this.code = code;
  }
}

export type ReadConfigResult =
  | { status: 'missing' }
  | { status: 'error'; error: ConfigStoreError }
  | { status: 'ok'; doc: Record<string, unknown>; raw: string };

export function configFilePath(dir: string): string {
  return join(dir, CONFIG_FILE_NAME);
}

export function readConfigFile(dir: string): ReadConfigResult {
  const path = configFilePath(dir);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { status: 'missing' };
  }
  if (st.isSymbolicLink()) {
    return { status: 'error', error: new ConfigStoreError('symlink', `${path} is a symbolic link — refusing to read (unexpected provenance for a config file).`) };
  }
  if (st.size > CONFIG_FILE_MAX_BYTES) {
    return { status: 'error', error: new ConfigStoreError('too-large', `${path} is ${st.size} bytes — refusing to read (limit ${CONFIG_FILE_MAX_BYTES}).`) };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { status: 'error', error: new ConfigStoreError('unreadable', `${path}: read failed (${String(err instanceof Error ? err.message : err)}).`) };
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // tolerate a leading BOM
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { status: 'error', error: new ConfigStoreError('unreadable', `${path}: invalid JSON (${String(err instanceof Error ? err.message : err)}).`) };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { status: 'error', error: new ConfigStoreError('unreadable', `${path}: top-level value must be a JSON object.`) };
  }
  return { status: 'ok', doc: doc as Record<string, unknown>, raw };
}

export function configFileSyncGuard(dir: string): ConfigStoreError | null {
  const path = configFilePath(dir);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return new ConfigStoreError('symlink', `${path} is a symbolic link — refusing to write through it.`);
  } catch {
    // absent → fine
  }
  try {
    const dirSt = statSync(dir);
    if (!dirSt.isDirectory()) return new ConfigStoreError('not-a-directory', `${dir} is not a directory.`);
  } catch {
    return new ConfigStoreError('not-a-directory', `${dir} does not exist.`);
  }
  return null;
}

/** Atomic write: same-dir random temp, O_EXCL, 0o600, fsync, rename. */
export function writeConfigFile(dir: string, doc: Record<string, unknown>): void {
  const guard = configFileSyncGuard(dir);
  if (guard) throw guard;
  const existed = existsSync(configFilePath(dir));
  const serialized = JSON.stringify(doc, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > CONFIG_FILE_MAX_BYTES) {
    throw new ConfigStoreError('too-large', `Serialized config exceeds ${CONFIG_FILE_MAX_BYTES} bytes.`);
  }
  const tmp = join(dir, `${CONFIG_FILE_NAME}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    const buf = Buffer.from(serialized, 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }
    fsyncSync(fd);
    closeSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup of the failed temp file
    }
    throw err;
  }
  renameSync(tmp, configFilePath(dir));
  if (!existed) gitInfoExcludeAdvisory(dir);
}

/**
 * Local-only ignore advisory: append the config file to .git/info/exclude
 * (never .gitignore — that file is attacker-controllable in a cloned repo).
 * Best-effort; failures are ignored.
 */
function gitInfoExcludeAdvisory(dir: string): void {
  try {
    const gitDir = join(dir, '.git');
    if (!existsSync(gitDir)) return;
    const infoDir = join(gitDir, 'info');
    if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
    const exclude = join(infoDir, 'exclude');
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (current.includes(CONFIG_FILE_NAME)) return;
    appendFileSync(exclude, `\n# biomcp project config (may contain credentials)\n${CONFIG_FILE_NAME}\n`);
  } catch {
    // advisory only
  }
}

/** Serialize mutations: last-writer-wins without lost updates. */
let mutexTail: Promise<unknown> = Promise.resolve();
export function withStoreMutex<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = mutexTail.then(fn, fn);
  mutexTail = run.catch(() => undefined);
  return run;
}
