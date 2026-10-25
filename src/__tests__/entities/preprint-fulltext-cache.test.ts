import {
  preprintCacheKey,
  preprintFulltextDir,
  writePreprintFullText,
  readPreprintFullText,
  latestCachedVersion,
  purgePreprintFullTextFiles,
} from '../../entities/article/detail/preprint-fulltext-cache.js';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';

describe('preprint-fulltext-cache', () => {
  let savedCacheDir: string | undefined;
  let cacheRoot: string;

  beforeEach(() => {
    savedCacheDir = process.env.BIOMCP_CACHE_DIR;
    cacheRoot = mkdtempSync(join(tmpdir(), 'biomcp-ppftc-'));
    process.env.BIOMCP_CACHE_DIR = cacheRoot;
  });

  afterEach(() => {
    if (savedCacheDir === undefined) delete process.env.BIOMCP_CACHE_DIR;
    else process.env.BIOMCP_CACHE_DIR = savedCacheDir;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  const section = (heading: string, text: string) => ({ heading, text, truncated: false });

  const writeInput = (doi: string, version: number, overrides: Record<string, unknown> = {}) => ({
    doi,
    version,
    server: 'bioRxiv',
    title: 'A preprint title',
    authors: ['Yonekura, S.', 'Kanazawa, H.'],
    license: 'cc by-nc-nd',
    license_url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    jatsxml_url: `https://www.biorxiv.org/content/early/2025/03/10/${doi}.source.xml`,
    hasReferences: true,
    sections: [section('Introduction', 'We study cells.'), section('Methods', 'First we did things.\n\n- step one\n- step two')],
    ...overrides,
  });

  describe('key sanitization', () => {
    test('percent-encodes the DOI slash and appends a validated version suffix', () => {
      expect(preprintCacheKey('10.1101/2025.03.05.641768', 2)).toBe('10.1101%2F2025.03.05.641768.v2.md');
      expect(preprintCacheKey('10.64898/2026.08.11.744243', 1)).toBe('10.64898%2F2026.08.11.744243.v1.md');
    });

    test('rejects non-DOI and malformed keys without touching the filesystem', () => {
      for (const badDoi of ['../../etc/passwd', '', 'not a doi']) {
        expect(preprintCacheKey(badDoi, 1)).toBeNull();
      }
      for (const badVersion of [0, -1, 1.5, NaN, Infinity]) {
        expect(preprintCacheKey('10.1101/2025.03.05.641768', badVersion as number)).toBeNull();
      }
      expect(existsSync(preprintFulltextDir())).toBe(false);
    });

    test('path-traversal payloads cannot escape the cache directory', () => {
      // Even a DOI crafted from dots produces an encoded, separator-free
      // file name inside the cache dir.
      const result = writePreprintFullText(writeInput('10.1101/../../etc/passwd', 1));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.file_path.startsWith(preprintFulltextDir() + '/')).toBe(true);
      expect(dirname(result.file_path)).toBe(preprintFulltextDir());
      const written = readdirSync(preprintFulltextDir());
      expect(written.every(name => !name.includes('/') && !name.includes('\\'))).toBe(true);
      // the legit traversal DOI (no '10.' prefix) never reaches disk at all
      expect(writePreprintFullText(writeInput('../escape', 1)).ok).toBe(false);
    });
  });

  describe('write/read round-trip', () => {
    test('round-trips front matter, headings, wrapped paragraphs, and list blocks', () => {
      const longPara = 'word '.repeat(60).trim(); // > 110 cols: forces a hard wrap
      const input = writeInput('10.1101/2025.03.05.641768', 2, {
        sections: [
          section('Introduction', longPara),
          section('Methods', 'First we did things.\n\n- step one\n- step two'),
        ],
      });
      const write = writePreprintFullText(input);
      expect(write.ok).toBe(true);
      if (!write.ok) return;

      const read = readPreprintFullText('10.1101/2025.03.05.641768', 2);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.file_path).toBe(write.file_path);
      expect(read.meta).toMatchObject({
        doi: '10.1101/2025.03.05.641768',
        version: 2,
        server: 'bioRxiv',
        title: 'A preprint title',
        authors: ['Yonekura, S.', 'Kanazawa, H.'],
        license: 'cc by-nc-nd',
        license_url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
        truncated: false,
        has_references: true,
      });
      // unwrap(wrap(text)) === text for paragraphs and short list items
      expect(read.sections.map(s => s.heading)).toEqual(['Introduction', 'Methods']);
      expect(read.sections[0].text).toBe(longPara);
      expect(read.sections[1].text).toBe('First we did things.\n\n- step one\n- step two');
      // outline line numbers point at the real "## heading" lines
      for (const entry of read.outline) {
        expect(readFileSync(read.file_path, 'utf8').split('\n')[entry.line - 1]).toBe(`## ${entry.heading}`);
      }
    });

    test('front matter carries doi/version/license verbatim in the file', () => {
      const write = writePreprintFullText(writeInput('10.1101/2025.03.05.641768', 3));
      expect(write.ok).toBe(true);
      if (!write.ok) return;
      const content = readFileSync(write.file_path, 'utf8');
      expect(content).toContain('doi: "10.1101/2025.03.05.641768"');
      expect(content).toContain('version: 3');
      expect(content).toContain('license: "cc by-nc-nd"');
      expect(content).toContain('## Introduction');
    });

    test('writes are atomic: no dot-tmp leftovers', () => {
      const write = writePreprintFullText(writeInput('10.1101/2025.03.05.641768', 1));
      expect(write.ok).toBe(true);
      if (!write.ok) return;
      const leftovers = readdirSync(preprintFulltextDir()).filter(n => n.includes('.tmp'));
      expect(leftovers).toEqual([]);
      expect(existsSync(write.file_path)).toBe(true);
    });

    test('versions are keyed separately', () => {
      expect(writePreprintFullText(writeInput('10.1101/2025.03.05.641768', 1)).ok).toBe(true);
      expect(writePreprintFullText(writeInput('10.1101/2025.03.05.641768', 2, { sections: [section('Only v2', 'text')] })).ok).toBe(true);
      const v1 = readPreprintFullText('10.1101/2025.03.05.641768', 1);
      const v2 = readPreprintFullText('10.1101/2025.03.05.641768', 2);
      expect(v1.ok && v1.meta.version).toBe(1);
      expect(v2.ok && v2.meta.version).toBe(2);
      expect(v1.ok && v1.sections.map(s => s.heading)).toContain('Introduction');
      expect(v2.ok && v2.sections.map(s => s.heading)).toEqual(['Only v2']);
      expect(v1.ok && v2.ok && v1.file_path !== v2.file_path).toBe(true);
    });

    test('misses report not_found; latestCachedVersion tracks the newest entry', () => {
      expect(readPreprintFullText('10.1101/2099.01.01.000001', 1)).toMatchObject({ ok: false, reason: 'not_found' });
      expect(latestCachedVersion('10.1101/2099.01.01.000001')).toBeUndefined();
      writePreprintFullText(writeInput('10.1101/2025.03.05.641768', 1));
      writePreprintFullText(writeInput('10.1101/2025.03.05.641768', 4));
      expect(latestCachedVersion('10.1101/2025.03.05.641768')).toBe(4);
    });
  });

  describe('retention', () => {
    test('count cap evicts oldest, never young files; stale tmp swept (1h grace)', () => {
      const dir = preprintFulltextDir();
      mkdirSync(dir, { recursive: true });
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const young = new Date();

      for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
        writeFileSync(join(dir, name), 'x');
        utimesSync(join(dir, name), old, old);
      }
      writeFileSync(join(dir, 'young.md'), 'y');
      utimesSync(join(dir, 'young.md'), young, young);
      writeFileSync(join(dir, '.stale.tmp'), 's');
      utimesSync(join(dir, '.stale.tmp'), old, old);
      writeFileSync(join(dir, '.fresh.tmp'), 'f');
      utimesSync(join(dir, '.fresh.tmp'), young, young);

      purgePreprintFullTextFiles(3);

      // 5 .md files, cap 3 → excess 2 evicted oldest-first (a, b);
      // the young file is exempt even though it is the newest by count.
      expect(existsSync(join(dir, 'a.md'))).toBe(false);
      expect(existsSync(join(dir, 'b.md'))).toBe(false);
      expect(existsSync(join(dir, 'c.md'))).toBe(true);
      expect(existsSync(join(dir, 'd.md'))).toBe(true);
      expect(existsSync(join(dir, 'young.md'))).toBe(true); // young files exempt
      expect(existsSync(join(dir, '.stale.tmp'))).toBe(false);
      expect(existsSync(join(dir, '.fresh.tmp'))).toBe(true);
    });
  });

  test('symlinked cache dir is refused (writes must not escape the cache root)', () => {
    const realTarget = mkdtempSync(join(tmpdir(), 'biomcp-ppftc-target-'));
    mkdirSync(cacheRoot, { recursive: true });
    symlinkSync(realTarget, join(cacheRoot, 'preprint-fulltext'));
    try {
      const result = writePreprintFullText(writeInput('10.1101/2025.03.05.641768', 1));
      expect(result.ok).toBe(false);
    } finally {
      rmSync(join(cacheRoot, 'preprint-fulltext'), { force: true });
      rmSync(realTarget, { recursive: true, force: true });
    }
  });
});
