import { describe, it, expect } from '@jest/globals';
import { parseManifest, selectLatestRelease } from '../../../../scripts/external-databases/depmap/manifest.js';

function manifestText(rows: string[][]): string {
  return rows.map(r => r.map(field => (field.includes(',') ? `"${field}"` : field)).join(',')).join('\n');
}

describe('depmap manifest parsing', () => {
  it('parses rows including quoted releases with commas', () => {
    const text = manifestText([
      ['release', 'release_date', 'filename', 'url', 'md5_hash'],
      ['DepMap Public 26Q1', '2026-04-01', 'Model.csv', '', 'a'.repeat(32)],
      ['Sanger CRISPR (Project Score, CERES)', '2025-01-01', 'score.csv', '', 'b'.repeat(32)],
    ]);
    const rows = parseManifest(text);
    expect(rows).toHaveLength(2);
    expect(rows[1].release).toBe('Sanger CRISPR (Project Score, CERES)');
    expect(rows[0].md5).toBe('a'.repeat(32));
  });

  it('rejects an unexpected header', () => {
    expect(() => parseManifest('a,b,c,d,e\n1,2,3,4,5')).toThrow(/header/);
  });
});

describe('depmap latest-release selection', () => {
  it('picks the newest DepMap Public release by name-parsed year/quarter', () => {
    const rows = parseManifest(manifestText([
      ['release', 'release_date', 'filename', 'url', 'md5_hash'],
      ['DepMap Public 24Q4', '2024-12-16', 'Model.csv', '', '1'.repeat(32)],
      ['DepMap Public 26Q1', '2026-04-01', 'Model.csv', '', '2'.repeat(32)],
      ['DepMap Public 25Q3', '2025-09-25', 'Model.csv', '', '3'.repeat(32)],
    ]));
    const release = selectLatestRelease(rows);
    expect(release.name).toBe('DepMap Public 26Q1');
    expect(release.shortName).toBe('26Q1');
    expect(release.files.get('Model.csv')).toBe('2'.repeat(32));
  });

  it('ignores date drift: a re-dated old release cannot win over the name-newest', () => {
    const rows = parseManifest(manifestText([
      ['release', 'release_date', 'filename', 'url', 'md5_hash'],
      ['DepMap Public 20Q1', '2026-12-31', 'Model.csv', '', '1'.repeat(32)],
      ['DepMap Public 26Q1', '2026-04-01', 'Model.csv', '', '2'.repeat(32)],
    ]));
    expect(selectLatestRelease(rows).shortName).toBe('26Q1');
  });

  it('excludes suffixed and non-Public releases', () => {
    const rows = parseManifest(manifestText([
      ['release', 'release_date', 'filename', 'url', 'md5_hash'],
      ['DepMap Public 20Q4 v2', '2020-12-18', 'Model.csv', '', '1'.repeat(32)],
      ['Harmonized Public Proteomics 26Q1', '2026-04-01', 'x.csv', '', '2'.repeat(32)],
      ['NextGen Model Manuscript 2026', '2026-07-16', 'y.csv', '', '3'.repeat(32)],
    ]));
    expect(() => selectLatestRelease(rows)).toThrow(/No .*DepMap Public.* releases/);
  });

  it('throws on duplicate filenames within the selected release', () => {
    const rows = parseManifest(manifestText([
      ['release', 'release_date', 'filename', 'url', 'md5_hash'],
      ['DepMap Public 26Q1', '2026-04-01', 'Model.csv', '', '1'.repeat(32)],
      ['DepMap Public 26Q1', '2026-04-01', 'Model.csv', '', '2'.repeat(32)],
    ]));
    expect(() => selectLatestRelease(rows)).toThrow(/Duplicate/);
  });
});
