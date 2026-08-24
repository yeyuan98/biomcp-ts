import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureRawDir, md5File, stagingPlan, statusTable, verifyStaged } from '../../../../scripts/external-databases/depmap/staging.js';
import type { ReleaseFiles } from '../../../../scripts/external-databases/depmap/manifest.js';

describe('depmap staging verification', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'depmap-staging-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies staged files as ok / mismatch / missing', async () => {
    const good = 'model rows here';
    writeFileSync(join(dir, 'Model.csv'), good);
    writeFileSync(join(dir, 'Gene.csv'), 'corrupted');
    const goodMd5 = createHash('md5').update(good).digest('hex');
    const staged = await verifyStaged(dir, [
      { filename: 'Model.csv', md5: goodMd5 },
      { filename: 'Gene.csv', md5: '0'.repeat(32) },
      { filename: 'Missing.csv', md5: '1'.repeat(32) },
    ]);
    expect(staged.map(s => s.status)).toEqual(['ok', 'mismatch', 'missing']);
    expect(staged[0].sizeBytes).toBe(good.length);
    expect(staged[2].sizeBytes).toBeNull();
  });

  it('hashes files in streaming mode', async () => {
    const big = 'x'.repeat(10_000_000);
    const file = join(dir, 'big.csv');
    writeFileSync(file, big);
    const expected = createHash('md5').update(big).digest('hex');
    expect(await md5File(file)).toBe(expected);
  });

  it('creates nested raw dirs and renders an actionable plan', async () => {
    const rawDir = join(dir, 'nested', 'raw', '26Q1');
    ensureRawDir(rawDir);
    const release: ReleaseFiles = {
      name: 'DepMap Public 26Q1',
      shortName: '26Q1',
      date: '2026-04-01',
      files: new Map([['Model.csv', 'a'.repeat(32)]]),
    };
    const staged = await verifyStaged(rawDir, [{ filename: 'Model.csv', md5: 'a'.repeat(32) }]);
    const plan = stagingPlan(release, staged, rawDir);
    expect(plan).toContain('https://depmap.org/portal/data_page/');
    expect(plan).toContain('Current Release');
    expect(plan).toContain(rawDir);
    expect(plan).toContain('MISSING');
    expect(plan).toContain('Model.csv');
    expect(statusTable(staged)).toContain('missing');
  });
});
