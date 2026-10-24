/* Trailing-journal-name → NLM-abbreviation rewriting (issue #121).
 *
 * PubMed only matches journal scoping against NLM abbreviations (or
 * `Abbr[Journal]` field syntax); a full journal name inside a query is
 * silently dropped or reinterpreted by PubMed's term translation, returning
 * off-topic results with no warning. Europe PMC's JOURNAL:"..." is the same.
 * Fix: when a query ENDS with a full journal name recognized from the
 * bundled NLM list, rewrite it to the NLM abbreviation automatically and
 * disclose the rewrite via the per-leg `warnings` channel — never silently.
 *
 * The bundled list (dist/assets/journal-titles.tsv.gz, normalized title →
 * MedAbbr, one pair per line) is generated at BUILD time by
 * scripts/build/fetch-journal-list.ts from NLM's live J_Entrez.gz and ships
 * in the npm package. If the asset is missing (e.g. dev without a build),
 * the feature is silently disabled — empty map, no crash, no warning spam —
 * so searches degrade to today's behavior instead of failing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** Asset filename under dist/assets/ (also listed in package.json `files`). */
export const JOURNAL_TITLES_ASSET = 'journal-titles.tsv.gz';

/**
 * Optional absolute override for the asset location (mirrors the
 * ANALYSIS_BIOWASM_WORKER_PATH convention): when set, ONLY that path is
 * consulted — a set-but-missing path disables the feature. Primarily a
 * test seam (unit tests point it at a small fixture or a nonexistent
 * sentinel so the real dist asset can never leak into assertions).
 */
const ASSET_PATH_ENV_VAR = 'BIOMCP_JOURNAL_TITLES_PATH';

/** Longest trailing word-window ever considered for a journal-title match.
 * NLM titles run long, but 8 words bounds the scan; the longest real
 * titles in the list are pathological and rare. */
const MAX_WINDOW_WORDS = 8;

let cachedMap: ReadonlyMap<string, string> | undefined;
let cachedAbbreviationMap: ReadonlyMap<string, string> | undefined;

/**
 * Normalize a journal phrase for matching — MUST stay in lockstep with the
 * build-time normalization (scripts/build/fetch-journal-list.ts): casefold;
 * strip a leading article (the|a|an); strip ONE trailing parenthetical
 * `\s*\(...\)$`; collapse whitespace.
 */
export function normalizeJournalPhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/\s*\([^)]*\)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Candidate asset paths, most-specific first: explicit env override (ONLY
 * that path when set), next to this module's bundle (dist/bundle.js →
 * dist/assets/), the repo-root dist when running dev/tsx from src/, then
 * cwd-relative. Mirrors biowasm's resolveWorkerPath discovery order. */
function resolveAssetPath(): string | undefined {
  const envPath = process.env[ASSET_PATH_ENV_VAR];
  if (envPath) return existsSync(envPath) ? envPath : undefined;
  const candidates: string[] = [];
  try {
    const here = fileURLToPath(import.meta.url);
    candidates.push(resolve(here, '..', 'assets', JOURNAL_TITLES_ASSET));
    // dev (tsx from src/): src/entities/article/search → <root>/dist/assets
    candidates.push(resolve(here, '..', '..', '..', '..', 'dist', 'assets', JOURNAL_TITLES_ASSET));
  } catch {
    // no import.meta anchor — fall through to cwd
  }
  candidates.push(resolve(process.cwd(), 'dist', 'assets', JOURNAL_TITLES_ASSET));
  return candidates.find(p => existsSync(p));
}

/**
 * Lazy singleton accessor for the bundled normalized-title → MedAbbr map
 * (read-only). Loads and gunzips the asset once per process; a missing or
 * corrupt asset yields an EMPTY map (feature disabled), never a crash.
 * Nothing is logged per query.
 */
export function getJournalTitleMap(): ReadonlyMap<string, string> {
  if (cachedMap !== undefined) return cachedMap;
  const map = new Map<string, string>();
  try {
    const assetPath = resolveAssetPath();
    if (assetPath) {
      const tsv = gunzipSync(readFileSync(assetPath)).toString('utf8');
      for (const line of tsv.split('\n')) {
        if (!line) continue;
        const tab = line.indexOf('\t');
        if (tab <= 0) continue;
        map.set(line.slice(0, tab), line.slice(tab + 1));
      }
    }
  } catch {
    // Corrupt asset — disable rather than break search. The build script's
    // fail-loud contract makes this a shouldn't-happen path.
    map.clear();
  }
  cachedMap = map;
  return map;
}

/**
 * Lazy singleton for the INVERSE map (normalized MedAbbr → normalized full
 * title) used by journal_metrics abbreviation expansion: a query like
 * "N Engl J Med" resolves back to "new england journal of medicine" so the
 * OpenAlex name search can run against the full title (far more precise than
 * searching the abbreviation). Entries with an EMPTY abbreviation are
 * skipped (an empty key would expand every empty-ish lookup); keys are
 * normalized with the same normalizeJournalPhrase so lookups stay symmetric
 * with the build-time normalization.
 */
export function getJournalAbbreviationMap(): ReadonlyMap<string, string> {
  if (cachedAbbreviationMap !== undefined) return cachedAbbreviationMap;
  const inverted = new Map<string, string>();
  for (const [title, abbr] of getJournalTitleMap()) {
    if (!abbr) continue; // skip empty-string abbreviations
    const key = normalizeJournalPhrase(abbr);
    if (!key) continue;
    inverted.set(key, title);
  }
  cachedAbbreviationMap = inverted;
  return inverted;
}

/** Drop the cached map so the next `getJournalTitleMap()` re-resolves the
 * asset path (env override changes in tests, or a fresh build). Clears BOTH
 * singletons — the title map and the abbreviation (inverse) map derived
 * from it. */
export function resetJournalTitleMap(): void {
  cachedMap = undefined;
  cachedAbbreviationMap = undefined;
}

export interface JournalPhraseRewrite {
  /** The query with the matched journal phrase REMOVED (trimmed; may be
   * empty when the whole query was the journal name). The caller appends
   * the backend-specific abbreviation term. */
  rewrittenQuery: string;
  /** The matched span, verbatim as it appeared in the query. */
  originalPhrase: string;
  /** The NLM abbreviation (MedAbbr) for the matched journal title. */
  medAbbr: string;
}

/**
 * Scan TRAILING word-windows of the query, longest first (from
 * min(8, wordCount) down to 2 words; single-word windows never match), and
 * on the first window whose normalized form hits the map, return the
 * rewrite — the matched span removed from the query, the rest preserved
 * verbatim. A journal name occurring mid-query (not at the end) never
 * rewrites; an unknown phrase never rewrites. Pure: the map is injectable
 * so unit tests never need the bundled asset.
 */
export function rewriteJournalPhrase(
  query: string,
  map: ReadonlyMap<string, string> = getJournalTitleMap(),
): JournalPhraseRewrite | undefined {
  const words = query.trim().split(/\s+/);
  if (words.length < 2 || words[0] === '') return undefined;
  for (let size = Math.min(MAX_WINDOW_WORDS, words.length); size >= 2; size--) {
    const phrase = words.slice(words.length - size).join(' ');
    const medAbbr = map.get(normalizeJournalPhrase(phrase));
    if (medAbbr !== undefined) {
      const rest = words.slice(0, words.length - size).join(' ').trim();
      return { rewrittenQuery: rest, originalPhrase: phrase, medAbbr };
    }
  }
  return undefined;
}
