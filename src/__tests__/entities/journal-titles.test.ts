import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  normalizeJournalPhrase,
  rewriteJournalPhrase,
  getJournalTitleMap,
  resetJournalTitleMap,
} from '../../entities/article/search/journal-titles.js';
import {
  parseJournalEntrezRecords,
  buildJournalTitleMap,
  journalTitleMapToTsv,
} from '../../../scripts/build/fetch-journal-list.js';

// Small injected map — the pure functions never need the bundled asset.
const MAP = new Map<string, string>([
  ['new england journal of medicine', 'N Engl J Med'],
  ['journal of medicine', 'J Med Fiction'], // shorter suffix journal: proves longest-window precedence
  ['nature genetics', 'Nat Genet'],
  ['nature', 'Nature'], // single-word title: proves size-1 windows never match
  ['lancet', 'Lancet'],
]);

describe('normalizeJournalPhrase', () => {
  test('casefolds and collapses whitespace', () => {
    expect(normalizeJournalPhrase('The   NEW England  Journal of Medicine')).toBe('new england journal of medicine');
  });

  test('strips a leading article (the|a|an)', () => {
    expect(normalizeJournalPhrase('The Lancet')).toBe('lancet');
    expect(normalizeJournalPhrase('A journal of things')).toBe('journal of things');
    expect(normalizeJournalPhrase('An journal')).toBe('journal');
  });

  test('strips exactly ONE trailing parenthetical', () => {
    expect(normalizeJournalPhrase('Acta medica (Hradec Kralove)')).toBe('acta medica');
    // two parentheticals: only the last is stripped
    expect(normalizeJournalPhrase('Journal (one) (two)')).toBe('journal (one)');
  });

  test('leaves phrases without article/parenthetical untouched (modulo case)', () => {
    expect(normalizeJournalPhrase('Nature Genetics')).toBe('nature genetics');
  });
});

describe('rewriteJournalPhrase', () => {
  test('rewrites a trailing full journal title, preserving the rest verbatim', () => {
    const r = rewriteJournalPhrase('Huntington disease New England Journal of Medicine', MAP);
    expect(r).toBeDefined();
    expect(r!.rewrittenQuery).toBe('Huntington disease');
    expect(r!.originalPhrase).toBe('New England Journal of Medicine');
    expect(r!.medAbbr).toBe('N Engl J Med');
  });

  test('matches a two-word journal (Nature Genetics)', () => {
    const r = rewriteJournalPhrase('BRCA1 nature genetics', MAP);
    expect(r).toEqual({ rewrittenQuery: 'BRCA1', originalPhrase: 'nature genetics', medAbbr: 'Nat Genet' });
  });

  test('whole-query journal name leaves an empty rest', () => {
    const r = rewriteJournalPhrase('The Lancet', MAP);
    expect(r).toEqual({ rewrittenQuery: '', originalPhrase: 'The Lancet', medAbbr: 'Lancet' });
  });

  test('longest window wins over a matching shorter suffix journal', () => {
    // "Journal of Medicine" (4 words, in map) is a suffix of "New England
    // Journal of Medicine" (5 words, in map): the 5-word window must match.
    const r = rewriteJournalPhrase('Huntington disease New England Journal of Medicine', MAP);
    expect(r!.originalPhrase).toBe('New England Journal of Medicine');
    expect(r!.medAbbr).toBe('N Engl J Med');
  });

  test('single word never rewrites, even when the word is a journal', () => {
    expect(rewriteJournalPhrase('Nature', MAP)).toBeUndefined();
    expect(rewriteJournalPhrase('papers in Nature', MAP)).toBeUndefined();
  });

  test('mid-query journal occurrence never rewrites', () => {
    expect(rewriteJournalPhrase('New England Journal of Medicine Huntington disease', MAP)).toBeUndefined();
  });

  test('unknown trailing phrase never rewrites', () => {
    expect(rewriteJournalPhrase('Huntington disease Journal of Made Up Things', MAP)).toBeUndefined();
  });

  test('empty and whitespace-only queries never rewrite', () => {
    expect(rewriteJournalPhrase('', MAP)).toBeUndefined();
    expect(rewriteJournalPhrase('   ', MAP)).toBeUndefined();
  });

  test('empty map (feature disabled) never rewrites', () => {
    expect(rewriteJournalPhrase('Huntington disease New England Journal of Medicine', new Map())).toBeUndefined();
  });
});

describe('journal-titles asset loader', () => {
  const ENV_VAR = 'BIOMCP_JOURNAL_TITLES_PATH';
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biomcp-journal-titles-'));
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
    resetJournalTitleMap();
    rmSync(dir, { recursive: true, force: true });
  });

  test('loads and parses a gzipped TSV asset via the env override', () => {
    const tsv = 'new england journal of medicine\tN Engl J Med\nnature genetics\tNat Genet\n';
    const asset = join(dir, 'journal-titles.tsv.gz');
    writeFileSync(asset, gzipSync(Buffer.from(tsv, 'utf8')));
    process.env[ENV_VAR] = asset;
    resetJournalTitleMap();

    const map = getJournalTitleMap();
    expect(map.size).toBe(2);
    expect(map.get('new england journal of medicine')).toBe('N Engl J Med');

    // cached: a second call returns the same instance without re-reading disk
    expect(getJournalTitleMap()).toBe(map);

    // and the live rewrite path picks it up end-to-end
    const r = rewriteJournalPhrase('Huntington disease New England Journal of Medicine');
    expect(r).toEqual({ rewrittenQuery: 'Huntington disease', originalPhrase: 'New England Journal of Medicine', medAbbr: 'N Engl J Med' });
  });

  test('missing asset (env set but absent) silently disables the feature', () => {
    process.env[ENV_VAR] = join(dir, 'does-not-exist.tsv.gz');
    resetJournalTitleMap();
    expect(getJournalTitleMap().size).toBe(0);
    expect(rewriteJournalPhrase('Huntington disease New England Journal of Medicine')).toBeUndefined();
  });
});

describe('J_Entrez parser (scripts/build/fetch-journal-list.ts)', () => {
  const FIXTURE = [
    'JrId: 1',
    'JournalTitle: The New England journal of medicine',
    'MedAbbr: N Engl J Med',
    '--------------------------------------------------------',
    'JrId: 2',
    'JournalTitle: Nature genetics',
    'MedAbbr: Nat Genet',
    '--------------------------------------------------------',
    // parenthetical MedAbbr → quarantined
    'JrId: 3',
    'JournalTitle: Journal of cell science. Supplement',
    'MedAbbr: J Cell Sci (Suppl)',
    '--------------------------------------------------------',
    // same normalized title, DIFFERENT abbr → ambiguous → quarantined
    'JrId: 4',
    'JournalTitle: Acta medica',
    'MedAbbr: Acta Med',
    '--------------------------------------------------------',
    'JrId: 5',
    'JournalTitle: Acta medica (Hradec Kralove)',
    'MedAbbr: Acta Med Hradec Kralove',
    '--------------------------------------------------------',
    // exact duplicate pair (two JrIds, same title+abbr) → kept once
    'JrId: 6',
    'JournalTitle: Biochimica et biophysica acta',
    'MedAbbr: Biochim Biophys Acta',
    '--------------------------------------------------------',
    'JrId: 7',
    'JournalTitle: biochimica et biophysica acta',
    'MedAbbr: Biochim Biophys Acta',
    '--------------------------------------------------------',
  ].join('\n');

  test('parses JournalTitle/MedAbbr pairs from the dash-separated format', () => {
    const records = parseJournalEntrezRecords(FIXTURE);
    expect(records).toHaveLength(7);
    expect(records[0]).toEqual({ journalTitle: 'The New England journal of medicine', medAbbr: 'N Engl J Med' });
  });

  test('builds the map with both quarantine rules and identical-duplicate collapse', () => {
    const { map, droppedParentheticalAbbr, droppedAmbiguousTitle } = buildJournalTitleMap(parseJournalEntrezRecords(FIXTURE));
    expect(droppedParentheticalAbbr).toBe(1);
    expect(droppedAmbiguousTitle).toBe(1); // 'acta medica'
    expect(map.size).toBe(3); // nejm, nature genetics, bba (collapsed to one)
    expect(map.get('new england journal of medicine')).toBe('N Engl J Med');
    expect(map.get('acta medica')).toBeUndefined();
    expect(map.get('journal of cell science. supplement')).toBeUndefined();
  });

  test('TSV round-trips through the runtime normalization', () => {
    const { map } = buildJournalTitleMap(parseJournalEntrezRecords(FIXTURE));
    const tsv = journalTitleMapToTsv(map);
    for (const line of tsv.trim().split('\n')) {
      const [key, abbr] = line.split('\t');
      expect(map.get(key)).toBe(abbr);
      // keys must already be in normalized form for runtime lookups
      expect(key).toBe(normalizeJournalPhrase(key));
    }
  });
});
