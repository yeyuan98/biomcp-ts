import { writeFullTextFile, purgeFullTextFiles, fulltextDir, FULLTEXT_MAX_FILE_CHARS } from '../../entities/article/detail/fulltext-store.js';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('fulltext-store', () => {
  let savedCacheDir: string | undefined;
  let cacheRoot: string;

  beforeEach(() => {
    savedCacheDir = process.env.BIOMCP_CACHE_DIR;
    cacheRoot = mkdtempSync(join(tmpdir(), 'biomcp-fts-'));
    process.env.BIOMCP_CACHE_DIR = cacheRoot;
  });

  afterEach(() => {
    if (savedCacheDir === undefined) delete process.env.BIOMCP_CACHE_DIR;
    else process.env.BIOMCP_CACHE_DIR = savedCacheDir;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  const section = (heading: string, text: string) => ({ heading, text, truncated: false });

  test('writes markdown with escaped front matter and wrapped body', () => {
    const longPara = 'word '.repeat(80).trim();
    const result = writeFullTextFile({
      pmcid: 'PMC1234567',
      pmid: '12345',
      doi: '10.1/x',
      title: 'Title: with "quotes" and: colons',
      license: 'cc by',
      is_open_access: true,
      oa_status: 'open_access',
      source: 'europepmc',
      sections: [section('Methods', longPara)],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = readFileSync(result.file_path, 'utf8');
    expect(content).toContain('title: "Title: with \\"quotes\\" and: colons"');
    expect(content).toContain('## Methods');
    // hard wrap: no line beyond the wrap budget (plus slack for long words)
    const maxLine = Math.max(...content.split('\n').filter(l => l).map(l => l.length));
    expect(maxLine).toBeLessThanOrEqual(130);
    expect(result.char_count).toBe(longPara.length);
    expect(result.total_char_count).toBe(longPara.length);
    expect(result.truncated).toBe(false);
    expect(result.outline).toEqual([{ heading: 'Methods', chars: longPara.length, line: expect.any(Number) }]);
    const lines = content.split('\n');
    expect(lines[result.outline[0].line - 1]).toBe('## Methods');
  });

  test('sanitizes multi-line headings to a single line', () => {
    const result = writeFullTextFile({
      pmcid: 'PMC1',
      source: 'eutils',
      sections: [section('Head\nwith\r\nnewlines', 'text')],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = readFileSync(result.file_path, 'utf8').split('\n');
    expect(lines[result.outline[0].line - 1]).toBe('## Head with newlines');
  });

  test('rejects non-PMCID identifiers without touching the filesystem', () => {
    for (const bad of ['../escape', 'PMC_1', 'pmc', 'PMC1/../PMC2']) {
      const result = writeFullTextFile({ pmcid: bad, source: 'eutils', sections: [section('S', 'x')] });
      expect(result.ok).toBe(false);
    }
  });

  test('symlinked fulltext dir is refused (writes must not escape the cache root)', () => {
    const realTarget = mkdtempSync(join(tmpdir(), 'biomcp-fts-target-'));
    mkdirSync(cacheRoot, { recursive: true });
    symlinkSync(realTarget, join(cacheRoot, 'fulltext'));
    try {
      const result = writeFullTextFile({ pmcid: 'PMC1', source: 'eutils', sections: [section('S', 'x')] });
      expect(result.ok).toBe(false);
    } finally {
      rmSync(join(cacheRoot, 'fulltext'), { force: true });
      rmSync(realTarget, { recursive: true, force: true });
    }
  });

  test('2MB safety cap truncates at section boundaries and flags honestly', () => {
    const big = 'x'.repeat(1_100_000);
    const result = writeFullTextFile({
      pmcid: 'PMC2',
      source: 'eutils',
      sections: [section('First', big), section('Second', big), section('Third', 'tail')],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.char_count).toBeLessThanOrEqual(FULLTEXT_MAX_FILE_CHARS);
    expect(result.char_count).toBe(result.outline.reduce((sum, o) => sum + o.chars, 0));
    expect(result.total_char_count).toBe(2 * 1_100_000 + 'tail'.length);
    expect(result.omitted_sections).toEqual(['Second', 'Third']);
    expect(result.truncated).toBe(result.total_char_count > result.char_count);
  });

  test('purge removes aged files, sweeps stale tmp, enforces the count cap with a young-file grace', () => {
    const dir = fulltextDir();
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const young = new Date();

    // aged file -> removed by time rule
    writeFileSync(join(dir, 'PMCOLD.md'), 'old');
    utimesSync(join(dir, 'PMCOLD.md'), old, old);
    // stale tmp -> swept after the 1h grace
    writeFileSync(join(dir, '.PMC1.123-0-abc.tmp'), 'stale');
    utimesSync(join(dir, '.PMC1.123-0-abc.tmp'), old, old);
    // fresh tmp -> kept (in-flight writer)
    writeFileSync(join(dir, '.PMC2.123-1-def.tmp'), 'fresh');
    utimesSync(join(dir, '.PMC2.123-1-def.tmp'), young, young);
    // young file -> exempt from both rules
    writeFileSync(join(dir, 'PMCYOUNG.md'), 'young');
    utimesSync(join(dir, 'PMCYOUNG.md'), young, young);

    purgeFullTextFiles();

    expect(existsSync(join(dir, 'PMCOLD.md'))).toBe(false);
    expect(existsSync(join(dir, '.PMC1.123-0-abc.tmp'))).toBe(false);
    expect(existsSync(join(dir, '.PMC2.123-1-def.tmp'))).toBe(true);
    expect(existsSync(join(dir, 'PMCYOUNG.md'))).toBe(true);

    // count cap: 210 aged files + the young one -> evict down to 200,
    // but the young file must survive even though it is the 211th
    for (let i = 0; i < 210; i++) {
      const p = join(dir, `PMCCAP${i}.md`);
      writeFileSync(p, 'x');
      utimesSync(p, old, old);
    }
    purgeFullTextFiles(24 * 60 * 60 * 1000 * 365); // 1y: time rule spares them
    const remaining = readdirSync(dir).filter(f => f.endsWith('.md'));
    expect(remaining.length).toBeLessThanOrEqual(201);
    expect(remaining).toContain('PMCYOUNG.md');
  });

  test('unwritable cache root reports ok:false instead of throwing', () => {
    const notADir = join(tmpdir(), `biomcp-fts-notadir-${process.pid}`);
    writeFileSync(notADir, 'x');
    process.env.BIOMCP_CACHE_DIR = notADir;
    try {
      const result = writeFullTextFile({ pmcid: 'PMC3', source: 'eutils', sections: [section('S', 'x')] });
      expect(result.ok).toBe(false);
    } finally {
      process.env.BIOMCP_CACHE_DIR = cacheRoot;
      rmSync(notADir, { force: true });
    }
  });

  test('outline is capped at 50 entries with a "+N more" marker', () => {
    const sections = Array.from({ length: 60 }, (_, i) => section(`S${i}`, `text ${i}`));
    const result = writeFullTextFile({ pmcid: 'PMC5', source: 'eutils', sections });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline).toHaveLength(51);
    expect(result.outline[49].heading).toBe('S49');
    expect(result.outline[50].heading).toBe('+10 more sections — grep "^## " the file for all headings');
    expect(result.outline[50].chars).toBe(0);
    // all 60 headings are still in the FILE even though the outline is capped
    const content = readFileSync(result.file_path, 'utf8');
    expect((content.match(/^## /gm) ?? []).length).toBe(60);
  });

  test('concurrent same-PMCID writes leave one complete file (atomic rename)', () => {
    const results = Array.from({ length: 8 }, (_, i) => writeFullTextFile({
      pmcid: 'PMC4',
      source: 'eutils',
      sections: [section('S', `writer ${i} `.repeat(50))],
    }));
    for (const r of results) expect(r.ok).toBe(true);
    const files = readdirSync(fulltextDir()).filter(f => f.endsWith('.md'));
    expect(files).toEqual(['PMC4.md']);
    // the surviving file is exactly one writer's content, never interleaved
    const content = readFileSync(join(fulltextDir(), 'PMC4.md'), 'utf8');
    const writers = new Set(content.match(/writer \d/g)?.map(m => m.trim()) ?? []);
    expect(writers.size).toBe(1);
    // no tmp leftovers
    expect(readdirSync(fulltextDir()).filter(f => f.startsWith('.'))).toHaveLength(0);
    expect(statSync(join(fulltextDir(), 'PMC4.md')).size).toBeGreaterThan(0);
  });
});
