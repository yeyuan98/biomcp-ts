import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cacheDir } from '../../../wasmcore/assets.js';
import type { FullTextSection } from './fulltext.js';

/**
 * File store for article full text: writes complete parsed text as
 * markdown under <BIOMCP_CACHE_DIR>/fulltext/<PMCID>.md so the tool reply
 * can carry a handle (path + outline) instead of the body. Conventions
 * mirror the biowasm artifact store (src/biwasm/artifacts.ts): atomic
 * dot-tmp + rename writes, a 200-file/24h retention with a 1h in-flight
 * grace, and never failing the caller — write() reports {ok:false} and
 * the fulltext section falls back to inline output.
 */

export interface FullTextWriteInput {
  pmcid: string;
  pmid?: string;
  doi?: string;
  title?: string;
  license?: string;
  is_open_access?: boolean;
  oa_status?: string;
  source: 'europepmc' | 'eutils';
  sections: FullTextSection[];
}

export interface OutlineEntry {
  heading: string;
  /** Body-text chars of the section (pre-wrap) */
  chars: number;
  /** 1-based line number of the section's "## heading" in the written file */
  line: number;
}

export type FullTextWriteResult =
  | {
      ok: true;
      file_path: string;
      outline: OutlineEntry[];
      /** Body-text chars actually written (pre-wrap) */
      char_count: number;
      /** Full body-text length before the 2MB safety cap */
      total_char_count: number;
      truncated: boolean;
      omitted_sections?: string[];
    }
  | { ok: false; reason: string };

/** Safety valve for unbounded external input written to disk. */
export const FULLTEXT_MAX_FILE_CHARS = 2_000_000;
const MAX_FILES = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Grace for in-flight writers: young files are exempt from eviction and
 * young dot-tmp files are never swept (mirrors biowasm artifacts). */
const TMP_GRACE_MS = 60 * 60 * 1000;
/** Agent Read tools truncate very long lines — hard-wrap the body. */
const WRAP_COLS = 110;
const MAX_HEADING_CHARS = 200;
/** Handle outline bound: a 300-section systematic review must not turn
 * the reply into a table of contents itself. */
const MAX_OUTLINE_ENTRIES = 50;

let tmpSeq = 0;

export function fulltextDir(): string {
  return join(cacheDir(), 'fulltext');
}

/** Coerce one line of agent-facing text to a single sanitized line (shared
 * with the preprint fulltext cache). */
export function sanitizeLine(text: string, maxChars: number): string {
  const single = text.replace(/[\r\n\t]+/g, ' ').replace(/[^\S ]+/g, '');
  return single.length > maxChars ? `${single.slice(0, maxChars - 1)}…` : single;
}

/** Hard-wrap one logical line at word boundaries; over-long words
 * (URLs, chemical names) stay on their own line rather than being split. */
function wrapLine(line: string, cols: number): string[] {
  if (line.length <= cols) return [line];
  const out: string[] = [];
  let cur = '';
  for (const word of line.split(' ')) {
    if (cur && cur.length + 1 + word.length > cols) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Hard-wrap text at word boundaries (shared with the preprint fulltext
 * cache; over-long words stay on their own line rather than being split). */
export function wrapText(text: string, cols: number): string {
  return text
    .split('\n')
    .flatMap(line => wrapLine(line, cols))
    .join('\n');
}

/** JSON strings are valid YAML 1.2 double-quoted scalars — reuse them
 * instead of adding a yaml dependency for a write-only artifact (shared
 * with the preprint fulltext cache). */
export function fmValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value ?? '').replace(/\r/g, ''));
}

/**
 * Write the article's complete text as markdown. Never throws: any
 * failure (invalid id, unwritable/full cache dir, symlinked directory,
 * rename trouble) returns {ok:false} and the caller falls back to inline
 * output. Always re-fetches and overwrites — this is an output sink,
 * never a cache that is served from.
 */
export function writeFullTextFile(input: FullTextWriteInput): FullTextWriteResult {
  let dir: string;
  try {
    if (!/^PMC\d+$/i.test(input.pmcid)) {
      return { ok: false, reason: `invalid pmcid for a file name: ${input.pmcid}` };
    }
    const pmcid = input.pmcid.toUpperCase();
    dir = fulltextDir();
    mkdirSync(dir, { recursive: true });
    // A planted symlinked directory would let writes escape the cache root
    if (lstatSync(dir).isSymbolicLink()) {
      return { ok: false, reason: 'fulltext dir is a symlink' };
    }

    // Select whole sections under the safety cap: the first section that
    // does not fit stops the write (a document prefix, never Swiss-cheese
    // omission); truncation is flagged, never silent.
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

    const lines: string[] = ['---'];
    lines.push(`pmcid: ${pmcid}`);
    if (input.pmid) lines.push(`pmid: ${fmValue(input.pmid)}`);
    if (input.doi) lines.push(`doi: ${fmValue(input.doi)}`);
    if (input.title) lines.push(`title: ${fmValue(input.title)}`);
    if (input.license) lines.push(`license: ${fmValue(input.license)}`);
    if (input.is_open_access !== undefined) lines.push(`is_open_access: ${input.is_open_access}`);
    if (input.oa_status) lines.push(`oa_status: ${fmValue(input.oa_status)}`);
    lines.push(`source: ${input.source}`);
    lines.push(`fetched_at: ${new Date().toISOString()}`);
    lines.push(`char_count: ${written.reduce((sum, s) => sum + s.text.length, 0)}`);
    lines.push(`total_char_count: ${total}`);
    lines.push(`truncated: ${truncated}`);
    if (omitted.length) lines.push(`omitted_sections: ${JSON.stringify(omitted)}`);
    lines.push('---', '');

    lines.push(`# ${sanitizeLine(input.title ?? pmcid, MAX_HEADING_CHARS * 2)}`, '');

    const outline: OutlineEntry[] = [];
    for (const s of written) {
      const heading = sanitizeLine(s.heading, MAX_HEADING_CHARS);
      const line = lines.length + 1; // 1-based line number of the heading
      lines.push(`## ${heading}`);
      lines.push('');
      // Loop-append (not spread): a pathological section can wrap into
      // more lines than the engine's spread-argument limit.
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

    const dest = join(dir, `${pmcid}.md`);
    const tmp = join(dir, `.${pmcid}.${process.pid}-${tmpSeq++}-${randomBytes(6).toString('hex')}.tmp`);
    const content = `${lines.join('\n')}\n`;
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
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason };
    }

    purgeFullTextFiles();

    return {
      ok: true,
      file_path: dest,
      outline,
      char_count: written.reduce((sum, s) => sum + s.text.length, 0),
      total_char_count: total,
      truncated,
      omitted_sections: omitted.length ? omitted : undefined,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

/**
 * Retention sweep: delete fulltext markdown older than maxAgeMs, sweep
 * stale dot-tmp leftovers (with a 1h in-flight grace), and enforce the
 * 200-file count cap by evicting oldest — never files younger than 1h.
 * Fire-and-forget: failures are swallowed (cache trouble must never fail
 * a tool call). Exported for the remote server's hourly maintenance.
 */
export function purgeFullTextFiles(maxAgeMs: number = MAX_AGE_MS): void {
  try {
    const dir = fulltextDir();
    const now = Date.now();
    const entries = readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile());

    for (const entry of entries) {
      const path = join(dir, entry.name);
      const mtimeMs = statSync(path).mtimeMs;
      const age = now - mtimeMs;
      if (entry.name.startsWith('.') && entry.name.endsWith('.tmp')) {
        if (age > TMP_GRACE_MS) rmSync(path, { force: true });
      } else if (entry.name.endsWith('.md') && age > maxAgeMs) {
        rmSync(path, { force: true });
      }
    }

    const remaining = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => ({ path: join(dir, e.name), mtimeMs: statSync(join(dir, e.name)).mtimeMs }));
    if (remaining.length <= MAX_FILES) return;
    const excess = remaining.length - MAX_FILES;
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
