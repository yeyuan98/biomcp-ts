import { describe, it, expect } from '@jest/globals';
import { DATASETS, parseDatasetSelection, resolveDatasetFiles } from '../../../../scripts/external-databases/depmap/datasets.js';
import type { ReleaseFiles } from '../../../../scripts/external-databases/depmap/manifest.js';

function releaseWith(files: string[]): ReleaseFiles {
  return {
    name: 'DepMap Public 26Q1',
    shortName: '26Q1',
    date: '2026-04-01',
    files: new Map(files.map(f => [f, '0'.repeat(32)])),
  };
}

const PINNED = [
  'Model.csv', 'Gene.csv', 'CRISPRGeneEffect.csv', 'CRISPRGeneDependency.csv',
  'AchillesCommonEssentialControls.csv', 'AchillesNonessentialControls.csv',
  'OmicsExpressionTPMLogp1HumanProteinCodingGenes.csv', 'OmicsCNGeneWGS.csv',
  'OmicsSomaticMutations.csv',
];

describe('depmap dataset map', () => {
  it('resolves every pinned file for a full release', () => {
    const resolved = resolveDatasetFiles(DATASETS, releaseWith(PINNED));
    expect(resolved).toHaveLength(PINNED.length);
    expect(resolved.every(r => r.md5 === '0'.repeat(32))).toBe(true);
  });

  it('hard-errors listing actual release files when a pinned file is absent', () => {
    const partial = releaseWith(PINNED.filter(f => f !== 'Model.csv'));
    expect(() => resolveDatasetFiles(DATASETS, partial)).toThrow(/Model\.csv[\s\S]*OmicsSomaticMutations\.csv/);
  });

  it('parses dataset selections and rejects unknown ids', () => {
    expect(parseDatasetSelection(undefined)).toHaveLength(8);
    expect(parseDatasetSelection('models,genes')).toHaveLength(2);
    expect(() => parseDatasetSelection('models,nope')).toThrow(/nope/);
  });
});
