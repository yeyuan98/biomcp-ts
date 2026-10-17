import {
  writeGenbankFile,
  purgeGenbankFiles,
  genbankFileDir,
  genbankFileName,
  GENBANK_MAX_FILE_CHARS,
} from '../../server/tools/genbank-store.js';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('genbank-store', () => {
  let savedCacheDir: string | undefined;
  let cacheRoot: string;

  beforeEach(() => {
    savedCacheDir = process.env.BIOMCP_CACHE_DIR;
    cacheRoot = mkdtempSync(join(tmpdir(), 'biomcp-gbstore-'));
    process.env.BIOMCP_CACHE_DIR = cacheRoot;
  });

  afterEach(() => {
    if (savedCacheDir === undefined) delete process.env.BIOMCP_CACHE_DIR;
    else process.env.BIOMCP_CACHE_DIR = savedCacheDir;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  const input = (overrides: Record<string, unknown> = {}) => ({
    accession: 'NC_000023.11',
    format: 'genbank' as const,
    text: 'LOCUS       NC_000023\nORIGIN\n//',
    ...overrides,
  });

  test('writes the full text atomically under <cacheDir>/genbank', () => {
    const text = 'LOCUS       NC_000023\nORIGIN\n//';
    const result = writeGenbankFile(input({ text }));
    expect(result).toEqual({
      ok: true,
      file_path: join(genbankFileDir(), 'NC_000023.11.genbank'),
      char_count: text.length,
      total_char_count: text.length,
      truncated: false,
    });
    if (!result.ok) return;
    expect(readFileSync(result.file_path, 'utf8')).toBe(text);
    // no dot-tmp leftovers
    expect(readdirSync(genbankFileDir()).filter(n => n.includes('.tmp'))).toEqual([]);
  });

  test('file names distinguish format, whole-record vs region, and strand', () => {
    expect(genbankFileName(input({ format: 'fasta' }))).toBe('NC_000023.11.fasta');
    expect(genbankFileName(input({ region: { start: 1, stop: 100, strand: 1 } }))).toBe('NC_000023.11.genbank_r1-100_s1');
    expect(genbankFileName(input({ region: { start: 100, stop: 1, strand: 2 } }))).toBe('NC_000023.11.genbank_r100-1_s2');
    // lowercase accessions are canonicalized to one file name
    expect(genbankFileName(input({ accession: 'nc_000023.11' }))).toBe('NC_000023.11.genbank');
  });

  test('rejects non-accession or malformed-region components without touching the filesystem', () => {
    for (const bad of ['../escape', 'not an accession!!', '', 'NC_000023.11/../../etc']) {
      expect(writeGenbankFile(input({ accession: bad })).ok).toBe(false);
    }
    for (const badRegion of [
      { start: 0, stop: 100, strand: 1 },
      { start: 1, stop: 1.5, strand: 1 },
      { start: 1, stop: 100, strand: 3 as unknown as 1 },
    ]) {
      expect(writeGenbankFile(input({ region: badRegion })).ok).toBe(false);
    }
    expect(existsSync(genbankFileDir())).toBe(false);
  });

  test('symlinked genbank dir is refused (writes must not escape the cache root)', () => {
    const realTarget = mkdtempSync(join(tmpdir(), 'biomcp-gbstore-target-'));
    mkdirSync(cacheRoot, { recursive: true });
    symlinkSync(realTarget, join(cacheRoot, 'genbank'));
    try {
      const result = writeGenbankFile(input());
      expect(result.ok).toBe(false);
      expect(readdirSync(realTarget)).toEqual([]);
    } finally {
      rmSync(realTarget, { recursive: true, force: true });
    }
  });

  test('safety cap truncates the written file and flags it honestly', () => {
    const text = 'A'.repeat(GENBANK_MAX_FILE_CHARS + 10);
    const result = writeGenbankFile(input({ text }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.char_count).toBe(GENBANK_MAX_FILE_CHARS);
    expect(result.total_char_count).toBe(GENBANK_MAX_FILE_CHARS + 10);
    expect(readFileSync(result.file_path, 'utf8')).toBe('A'.repeat(GENBANK_MAX_FILE_CHARS));
  });

  test('an unwritable cache dir returns {ok:false} instead of throwing', () => {
    const blocker = join(cacheRoot, 'blocker');
    writeFileSync(blocker, 'x');
    process.env.BIOMCP_CACHE_DIR = join(blocker, 'nested');
    expect(writeGenbankFile(input()).ok).toBe(false);
  });

  describe('retention sweep', () => {
    const OLD = new Date('2020-01-01T00:00:00Z');
    // Long enough that the OLD-seeded files survive the age sweep — the
    // count/bytes tests exercise the caps, not age deletion.
    const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

    const seed = (name: string, bytes = 8, age = OLD): string => {
      const dir = genbankFileDir();
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      writeFileSync(path, 'x'.repeat(bytes));
      utimesSync(path, age, age);
      return path;
    };

    test('deletes managed files older than maxAgeMs and stale dot-tmp files', () => {
      const aged = seed('NC_000023.11.genbank');
      const fresh = seed('NC_000024.2.fasta', 8, new Date());
      const staleTmp = seed('.NC_000023.11.123-0-abc.tmp', 8, OLD);
      seed('foreign.txt', 8, OLD); // never touched

      purgeGenbankFiles(7 * 24 * 60 * 60 * 1000);

      expect(existsSync(aged)).toBe(false);
      expect(existsSync(staleTmp)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(join(genbankFileDir(), 'foreign.txt'))).toBe(true);
    });

    test('count cap evicts oldest first; young files are exempt', () => {
      const oldest = seed('NC_000001.11.genbank');
      const middle = seed('NC_000002.12.genbank');
      const young = seed('NC_000003.13.genbank', 8, new Date());

      purgeGenbankFiles(TEN_YEARS_MS, 2, Number.MAX_SAFE_INTEGER);

      expect(existsSync(oldest)).toBe(false);
      expect(existsSync(middle)).toBe(true);
      expect(existsSync(young)).toBe(true);
    });

    test('bytes cap evicts oldest first until under budget', () => {
      const oldest = seed('NC_000001.11.genbank', 1_000);
      const middle = seed('NC_000002.12.genbank', 1_000);
      const newest = seed('NC_000003.13.genbank', 1_000);

      purgeGenbankFiles(TEN_YEARS_MS, 500, 1_500);

      expect(existsSync(oldest)).toBe(false);
      expect(existsSync(middle)).toBe(false);
      expect(existsSync(newest)).toBe(true);
    });

    test('never throws when the dir does not exist', () => {
      expect(() => purgeGenbankFiles()).not.toThrow();
    });
  });
});
