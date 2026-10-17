import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cacheDir } from '../../../wasmcore/assets.js';
import type { FullTextSection } from './fulltext.js';
import type { OutlineEntry } from './fulltext-store.js';
import { FULLTEXT_MAX_FILE_CHARS, fmValue, sanitizeLine, wrapText } from './fulltext-store.js';

/**
 * Disk cache for bioRxiv/medRxiv preprint full text (JATS-derived markdown),
 * keyed on (doi, version). JATS per version is IMMUTABLE upstream, so a
 * cached copy never goes stale — this store is READ BACK before any download
 * (unlike fulltext-store, the PMC output sink that always re-fetches).
 *
 * Conventions mirror fulltext-store where sensible: atomic dot-tmp + rename
 * writes, symlinked-directory refusal, a count-capped retention sweep.
 * Retention is COUNT-ONLY (no age purge — entries never expire), evicting
 * oldest-mtime beyond the cap with a 1 h young-file grace. Reads bump mtime
 * so the cap evicts least-recently-used entries.
 */

export interface PreprintFullTextCacheMeta {
  doi: string;
  version: number;
  server: string;
  title?: string;
  authors?: string[];
  license?: string;
  license_url?: string;
  jatsxml_url?: string;
  fetched_at: string;
  char_count: number;
  total_char_count: number;
  truncated: boolean;
  omitted_sections?: string[];
  has_references?: boolean;
}

export interface PreprintFullTextWriteInput {
  doi: string;
  version: number;
  server: string;
  title?: string;
  authors?: string[];
  license?: string;
  license_url?: string;
  jatsxml_url?: string;
  hasReferences?: boolean;
  sections: FullTextSection[];
}

export type PreprintFullTextWriteResult =
  | {
      ok: true;
      file_path: string;
      outline: OutlineEntry[];
      char_count: number;
      total_char_count: number;
      truncated: boolean;
      omitted_sections?: string[];
    }
  | { ok: false; reason: string };

export type PreprintFullTextReadResult =
  | {
      ok: true;
      file_path: string;
      meta: PreprintFullTextCacheMeta;
      sections: FullTextSection[];
      outline: OutlineEntry[];
    }
  | { ok: false; reason: 'not_found' | 'invalid_key' | string };

export const PREPRINT_CACHE_MAX_FILES = 200;
const MAX_DOI_KEY_CHARS = 200;
const TMP_GRACE_MS = 60 * 60 * 1000;
const WRAP_COLS = 110;
const MAX_HEADING_CHARS = 200;
const MAX_OUTLINE_ENTRIES = 50;

let tmpSeq = 0;

export function preprintFulltextDir(): string {
  return join(cacheDir(), 'preprint-fulltext');
}

/**
 * Cache key for one (doi, version): the percent-encoded DOI (every path
 * metacharacter — '/', '..', reserved chars — is escaped, so the encoded
 * form can never contain a path separator) plus a validated numeric version
 * suffix. Returns null for keys that cannot be made safe.
 */
export function preprintCacheKey(doi: string, version: number): string | null {
  const enc = encodeURIComponent(doi.trim());
  const v = String(version);
  if (!enc || !/^10\./.test(enc) || enc.length > MAX_DOI_KEY_CHARS) return null;
  if (!/^\d+$/.test(v) || Number(v) < 1) return null;
  // Defense in depth: encodeURIComponent cannot emit these, but a future
  // refactor must not quietly reintroduce traversal.
  if (/[/\\]|\0/.test(enc)) return null;
  return `${enc}.v${v}.md`;
}

/** Full path of the cache file, or null when the key is not representable. */
export function preprintCacheFile(doi: string, version: number): string | null {
  const key = preprintCacheKey(doi, version);
  return key ? join(preprintFulltextDir(), key) : null;
}

/**
 * Write one (doi, version) entry atomically. Never throws: any failure
 * returns {ok:false} and the caller degrades (inline output). Overwrites
 * are safe — content per key is immutable, so an overwrite only repairs a
 * corrupt entry.
 */
export function writePreprintFullText(input: PreprintFullTextWriteInput): PreprintFullTextWriteResult {
  try {
    const key = preprintCacheKey(input.doi, input.version);
    if (!key) return { ok: false, reason: `invalid (doi, version) for a cache key: ${input.doi} v${input.version}` };
    const dir = preprintFulltextDir();
    mkdirSync(dir, { recursive: true });
    // A planted symlinked directory would let writes escape the cache root.
    if (lstatSync(dir).isSymbolicLink()) {
      return { ok: false, reason: 'preprint-fulltext cache dir is a symlink' };
    }

    // Whole sections under the shared 2MB safety cap (document-prefix
    // truncation, flagged honestly — mirrors fulltext-store).
    const total = input.sections.reduce((sum, s) => sum + s.text.length, 0);
    const written: FullTextSection[] = [];
    const omitted: string[] = [];
    let budget = FULLTEXT_MAX_FILE_CHARS;
    let truncated = false;
    for (const s of input.sections) {
      if (!s.text) continue;
      if (truncated) {
        omitted.push(s.heading);
        continue;
      }
      if (s.text.length <= budget) {
        written.push(s);
        budget -= s.text.length;
      } else {
        omitted.push(s.heading);
        truncated = true;
      }
    }

    const charCount = written.reduce((sum, s) => sum + s.text.length, 0);
    const lines: string[] = ['---'];
    lines.push(`doi: ${fmValue(input.doi)}`);
    lines.push(`version: ${input.version}`);
    lines.push(`server: ${fmValue(input.server)}`);
    if (input.title) lines.push(`title: ${fmValue(input.title)}`);
    if (input.authors) lines.push(`authors: ${JSON.stringify(input.authors)}`);
    if (input.license) lines.push(`license: ${fmValue(input.license)}`);
    if (input.license_url) lines.push(`license_url: ${fmValue(input.license_url)}`);
    if (input.jatsxml_url) lines.push(`jatsxml_url: ${fmValue(input.jatsxml_url)}`);
    lines.push(`fetched_at: ${fmValue(new Date().toISOString())}`);
    lines.push(`char_count: ${charCount}`);
    lines.push(`total_char_count: ${total}`);
    lines.push(`truncated: ${truncated}`);
    if (input.hasReferences !== undefined) lines.push(`has_references: ${input.hasReferences}`);
    if (omitted.length) lines.push(`omitted_sections: ${JSON.stringify(omitted)}`);
    lines.push('---', '');

    lines.push(`# ${sanitizeLine(input.title ?? input.doi, MAX_HEADING_CHARS * 2)}`, '');

    const outline: OutlineEntry[] = [];
    for (const s of written) {
      const heading = sanitizeLine(s.heading, MAX_HEADING_CHARS);
      const line = lines.length + 1; // 1-based line number of the heading
      lines.push(`## ${heading}`);
      lines.push('');
      for (const wrapped of wrapText(s.text, WRAP_COLS).split('\n')) {
        lines.push(wrapped);
      }
      lines.push('');
      if (outline.length < MAX_OUTLINE_ENTRIES) {
        outline.push({ heading, chars: s.text.length, line });
      }
    }
    if (written.length > MAX_OUTLINE_ENTRIES) {
      outline.push({
        heading: `+${written.length - MAX_OUTLINE_ENTRIES} more sections — grep "^## " the file for all headings`,
        chars: 0,
        line: 0,
      });
    }

    const dest = join(dir, key);
    const tmp = join(dir, `.${key}.${process.pid}-${tmpSeq++}-${randomBytes(6).toString('hex')}.tmp`);
    try {
      // Write + rename in one synchronous block: readers see old-or-new,
      // never a partial file.
      writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8');
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

    purgePreprintFullTextFiles();

    return {
      ok: true,
      file_path: dest,
      outline,
      char_count: charCount,
      total_char_count: total,
      truncated,
      omitted_sections: omitted.length ? omitted : undefined,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Parse one front-matter scalar the way fmValue writes it (JSON string,
 * JSON array, or bare number/boolean). */
function parseFmScalar(raw: string): string | number | boolean | string[] {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return value; }
  }
  if (value.startsWith('[')) {
    try { return JSON.parse(value) as string[]; } catch { return value; }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Inverse of wrapText within one blank-line-separated block: wrapped lines
 * rejoin with ' '; lines that start a new logical line ("- " list items)
 * break instead. This restores paragraphs exactly and list blocks up to
 * >110-char items, whose continuations merge (cosmetic only).
 */
function unwrapBlock(lines: string[]): string {
  const logical: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (line.startsWith('- ') && cur !== '') {
      logical.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur} ${line}` : line;
    }
  }
  if (cur) logical.push(cur);
  return logical.join('\n');
}

function unwrapSectionBody(body: string): string {
  const blocks = body.split(/\n{2,}/).map(b => b.replace(/\s+$/, '')).filter(b => b.length > 0);
  return blocks.map(b => unwrapBlock(b.split('\n'))).join('\n\n');
}

/**
 * Read one (doi, version) entry back. Returns not_found when absent and a
 * reason string on any parse trouble (the caller treats an unreadable entry
 * as a miss and re-downloads). A successful read bumps the file mtime so
 * the count cap evicts least-recently-used entries.
 */
export function readPreprintFullText(doi: string, version: number): PreprintFullTextReadResult {
  try {
    const path = preprintCacheFile(doi, version);
    if (!path) return { ok: false, reason: 'invalid_key' };
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      return { ok: false, reason: 'not_found' };
    }

    const lines = content.split('\n');
    if (lines[0] !== '---') return { ok: false, reason: 'missing front matter' };
    const fmEnd = lines.indexOf('---', 1);
    if (fmEnd === -1) return { ok: false, reason: 'unterminated front matter' };

    const raw: Record<string, string> = {};
    for (const line of lines.slice(1, fmEnd)) {
      const idx = line.indexOf(': ');
      if (idx > 0) raw[line.slice(0, idx)] = line.slice(idx + 2);
      else if (line.endsWith(':')) raw[line.slice(0, -1)] = '';
    }
    const str = (k: string): string | undefined => {
      const v = raw[k];
      if (v === undefined) return undefined;
      const parsed = parseFmScalar(v);
      return typeof parsed === 'string' ? parsed : String(parsed);
    };
    const num = (k: string): number | undefined => {
      const parsed = parseFmScalar(raw[k] ?? '');
      return typeof parsed === 'number' ? parsed : undefined;
    };
    const list = (k: string): string[] | undefined => {
      const v = raw[k];
      if (v === undefined) return undefined;
      const parsed = parseFmScalar(v);
      return Array.isArray(parsed) ? parsed : undefined;
    };

    const meta: PreprintFullTextCacheMeta = {
      doi: str('doi') ?? doi,
      version: num('version') ?? version,
      server: str('server') ?? '',
      title: str('title'),
      authors: list('authors'),
      license: str('license'),
      license_url: str('license_url'),
      jatsxml_url: str('jatsxml_url'),
      fetched_at: str('fetched_at') ?? '',
      char_count: num('char_count') ?? 0,
      total_char_count: num('total_char_count') ?? 0,
      truncated: parseFmScalar(raw['truncated'] ?? 'false') === true,
      omitted_sections: list('omitted_sections'),
      has_references: raw['has_references'] !== undefined ? parseFmScalar(raw['has_references']) === true : undefined,
    };

    // Body: skip the "# title" H1, split on "## " headings.
    const rawSections: Array<{ heading: string; body: string[]; line: number }> = [];
    const outline: OutlineEntry[] = [];
    let current: { heading: string; body: string[]; line: number } | null = null;
    for (let i = fmEnd + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('## ')) {
        if (current) rawSections.push(current);
        const heading = line.slice(3);
        current = { heading, body: [], line: i + 1 };
        if (outline.length < MAX_OUTLINE_ENTRIES) outline.push({ heading, chars: 0, line: i + 1 });
        continue;
      }
      if (current) current.body.push(line);
    }
    if (current) rawSections.push(current);

    const restored: FullTextSection[] = rawSections.map(s => ({
      heading: s.heading,
      text: unwrapSectionBody(s.body.join('\n')).trim(),
      truncated: false,
    }));
    // Outline chars from the restored text (post-unwrap ≈ pre-wrap length).
    restored.forEach((s, i) => {
      if (i < outline.length) outline[i].chars = s.text.length;
    });
    if (!meta.char_count) meta.char_count = restored.reduce((sum, s) => sum + s.text.length, 0);

    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      void 0; // LRU bump is best-effort
    }

    return { ok: true, file_path: path, meta, sections: restored, outline };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Highest cached version for a DOI (undefined when none). Lets callers
 * serve a cached copy when the live latest cannot be checked (download
 * cooldown) without touching the network.
 */
export function latestCachedVersion(doi: string): number | undefined {
  try {
    const prefix = `${encodeURIComponent(doi.trim())}.v`;
    let best: number | undefined;
    for (const entry of readdirSync(preprintFulltextDir(), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.md')) continue;
      const v = Number(entry.name.slice(prefix.length, -3));
      if (Number.isInteger(v) && v >= 1 && (best === undefined || v > best)) best = v;
    }
    return best;
  } catch {
    return undefined;
  }
}

/**
 * Retention sweep: stale dot-tmp leftovers (1 h grace) and the count cap
 * (evict oldest mtime, never files younger than 1 h). Count-only by design
 * — cached entries are immutable and never age out. Fire-and-forget;
 * exported for tests. `maxFiles` defaults to the production cap.
 */
export function purgePreprintFullTextFiles(maxFiles: number = PREPRINT_CACHE_MAX_FILES): void {
  try {
    const dir = preprintFulltextDir();
    const now = Date.now();
    const entries = readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile());

    for (const entry of entries) {
      const path = join(dir, entry.name);
      const age = now - statSync(path).mtimeMs;
      if (entry.name.startsWith('.') && entry.name.endsWith('.tmp') && age > TMP_GRACE_MS) {
        rmSync(path, { force: true });
      }
    }

    const remaining = entries
      .filter(e => e.name.endsWith('.md'))
      .map(e => ({ path: join(dir, e.name), mtimeMs: statSync(join(dir, e.name)).mtimeMs }));
    if (remaining.length <= maxFiles) return;
    const excess = remaining.length - maxFiles;
    const evictable = remaining
      .filter(f => now - f.mtimeMs > TMP_GRACE_MS)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(0, excess);
    for (const victim of evictable) {
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
