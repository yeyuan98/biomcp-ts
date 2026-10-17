import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cacheDir } from '../../wasmcore/assets.js';
import type { GenbankRegion } from '../../entities/genbank.js';

/**
 * Lean output sink for genbank_get: records whose flat-file text exceeds the
 * inline budget are written whole under <BIOMCP_CACHE_DIR>/genbank/ so the
 * tool reply can carry a handle (path + char counts) instead of a truncated
 * body. Write-only by design — always re-fetched upstream, never served from.
 * Conventions mirror the article fulltext store: atomic dot-tmp + rename,
 * retention sweep (age + count + bytes, oldest first), and never failing the
 * caller — write() reports {ok:false} and the tool falls back to inline
 * output.
 */

/** Per-file safety valve; upstream responses are already capped at 30M chars,
 *  so this should never fire — but the sink must stay bounded. */
export const GENBANK_MAX_FILE_CHARS = 30_000_000;
export const GENBANK_MAX_FILES = 500;
export const GENBANK_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Grace for in-flight writers: young files are exempt from eviction and
 *  young dot-tmp files are never swept (mirrors the fulltext store). */
const TMP_GRACE_MS = 60 * 60 * 1000;

const ACCESSION_RE = /^[A-Z]{1,6}_?\d+(\.\d+)?$/i;
/** Managed file names we sweep/evict — foreign files in the dir are ignored. */
const FILE_NAME_RE = /^[A-Z]{1,6}_?\d+(?:\.\d+)?\.(?:genbank|fasta)(?:_r\d+-\d+_s[12])?$/i;

let tmpSeq = 0;

export interface GenbankFileWriteInput {
  accession: string;
  format: 'genbank' | 'fasta';
  region?: GenbankRegion;
  text: string;
}

export type GenbankFileWriteResult =
  | {
      ok: true;
      file_path: string;
      /** Chars actually written (post safety cap). */
      char_count: number;
      /** Full text length before the safety cap. */
      total_char_count: number;
      truncated: boolean;
    }
  | { ok: false; reason: string };

export function genbankFileDir(): string {
  return join(cacheDir(), 'genbank');
}

/** Validated file name for one (accession, format, region) triple, or null
 *  when any component is not filename-safe (no path can leave the dir). */
export function genbankFileName(input: GenbankFileWriteInput): string | null {
  const accession = input.accession.trim();
  if (!ACCESSION_RE.test(accession)) return null;
  const region = input.region;
  if (region && (!Number.isInteger(region.start) || !Number.isInteger(region.stop) ||
      region.start < 1 || region.stop < 1 || (region.strand !== 1 && region.strand !== 2))) {
    return null;
  }
  const base = `${accession.toUpperCase()}.${input.format}`;
  return region ? `${base}_r${region.start}-${region.stop}_s${region.strand}` : base;
}

/** Write the full record text to the store. Never throws: any failure
 *  (invalid name component, unwritable dir, symlinked directory, rename
 *  trouble) returns {ok:false} and the caller falls back to inline output. */
export function writeGenbankFile(input: GenbankFileWriteInput): GenbankFileWriteResult {
  try {
    const name = genbankFileName(input);
    if (!name) return { ok: false, reason: `invalid file-name components for: ${input.accession}` };
    const dir = genbankFileDir();
    mkdirSync(dir, { recursive: true });
    // A planted symlinked directory would let writes escape the cache root
    if (lstatSync(dir).isSymbolicLink()) {
      return { ok: false, reason: 'genbank dir is a symlink' };
    }

    const total = input.text.length;
    const truncated = total > GENBANK_MAX_FILE_CHARS;
    const content = truncated ? input.text.slice(0, GENBANK_MAX_FILE_CHARS) : input.text;

    const dest = join(dir, name);
    const tmp = join(dir, `.${name}.${process.pid}-${tmpSeq++}-${randomBytes(6).toString('hex')}.tmp`);
    try {
      // Write + rename in one synchronous block: readers see old-or-new,
      // never a partial file.
      writeFileSync(tmp, content, 'utf8');
      try {
        renameSync(tmp, dest);
      } catch {
        renameSync(tmp, dest); // one retry for transient AV/EPERM locks
      }
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        void 0;
      }
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    purgeGenbankFiles();

    return { ok: true, file_path: dest, char_count: content.length, total_char_count: total, truncated };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Retention sweep: delete managed files older than maxAgeMs, sweep stale
 * dot-tmp leftovers (1h grace), then enforce the count and total-bytes caps
 * by evicting oldest — never files younger than 1h. Fire-and-forget:
 * failures are swallowed (cache trouble must never fail a tool call).
 */
export function purgeGenbankFiles(
  maxAgeMs: number = MAX_AGE_MS,
  maxFiles: number = GENBANK_MAX_FILES,
  maxTotalBytes: number = GENBANK_MAX_TOTAL_BYTES
): void {
  try {
    const dir = genbankFileDir();
    const now = Date.now();
    const entries = readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile());

    const managed: Array<{ path: string; mtimeMs: number; bytes: number }> = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const mtimeMs = statSync(path).mtimeMs;
      if (entry.name.startsWith('.') && entry.name.endsWith('.tmp')) {
        if (now - mtimeMs > TMP_GRACE_MS) rmSync(path, { force: true });
      } else if (FILE_NAME_RE.test(entry.name) && now - mtimeMs > maxAgeMs) {
        rmSync(path, { force: true });
      } else if (FILE_NAME_RE.test(entry.name)) {
        managed.push({ path, mtimeMs, bytes: statSync(path).size });
      }
    }

    const evictable = managed
      .filter(f => now - f.mtimeMs > TMP_GRACE_MS)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = Math.max(0, managed.length - maxFiles);
    const totalBytes = managed.reduce((sum, f) => sum + f.bytes, 0);
    const overBytes = totalBytes > maxTotalBytes;
    let victims = excess;
    if (overBytes) {
      // Walk oldest-first until under both caps (or nothing evictable left).
      let running = totalBytes;
      let i = 0;
      while (i < evictable.length && (victims > i || running > maxTotalBytes)) {
        running -= evictable[i].bytes;
        i++;
      }
      victims = Math.max(victims, i);
    }
    for (const victim of evictable.slice(0, victims)) {
      try {
        rmSync(victim.path, { force: true });
      } catch {
        void 0;
      }
    }
  } catch {
    void 0;
  }
}
