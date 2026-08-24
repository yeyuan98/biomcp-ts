import type { ReleaseFiles } from './manifest.js';

export type DatasetId =
  | 'models'
  | 'genes'
  | 'crispr_gene_effect'
  | 'crispr_gene_dependency'
  | 'common_essentials'
  | 'expression_tpm'
  | 'cn_gene'
  | 'mutations';

export interface DatasetSpec {
  id: DatasetId;
  filenames: string[];
  table: string;
  matrix?: 'positional' | 'named';
}

export const DATASETS: DatasetSpec[] = [
  { id: 'models', filenames: ['Model.csv'], table: 'models' },
  { id: 'genes', filenames: ['Gene.csv'], table: 'genes' },
  {
    id: 'crispr_gene_effect',
    filenames: ['CRISPRGeneEffect.csv'],
    table: 'gene_effect',
    matrix: 'positional',
  },
  {
    id: 'crispr_gene_dependency',
    filenames: ['CRISPRGeneDependency.csv'],
    table: 'gene_dependency',
    matrix: 'positional',
  },
  {
    id: 'common_essentials',
    filenames: ['AchillesCommonEssentialControls.csv', 'AchillesNonessentialControls.csv'],
    table: 'essentiality_controls',
  },
  {
    id: 'expression_tpm',
    filenames: ['OmicsExpressionTPMLogp1HumanProteinCodingGenes.csv'],
    table: 'expression_tpm',
    matrix: 'named',
  },
  { id: 'cn_gene', filenames: ['OmicsCNGeneWGS.csv'], table: 'cn_gene', matrix: 'named' },
  { id: 'mutations', filenames: ['OmicsSomaticMutations.csv'], table: 'mutations' },
];

export const DATASET_IDS: DatasetId[] = DATASETS.map(d => d.id);

export interface ResolvedFile {
  dataset: DatasetSpec;
  filename: string;
  md5: string;
}

export function resolveDatasetFiles(datasets: DatasetSpec[], release: ReleaseFiles): ResolvedFile[] {
  const resolved: ResolvedFile[] = [];
  const missing: string[] = [];
  for (const dataset of datasets) {
    for (const filename of dataset.filenames) {
      const md5 = release.files.get(filename);
      if (md5 === undefined) {
        missing.push(`${release.name}/${filename} (dataset "${dataset.id}")`);
        continue;
      }
      resolved.push({ dataset, filename, md5 });
    }
  }
  if (missing.length > 0) {
    const available = [...release.files.keys()].sort().join('\n  ');
    throw new Error(
      `Pinned file(s) not found in ${release.name}:\n  ${missing.join('\n  ')}\n` +
      `Files actually present in this release:\n  ${available}\n` +
      `Update the pinned map in scripts/external-databases/depmap/datasets.ts for this release.`
    );
  }
  return resolved;
}

export function parseDatasetSelection(value: string | undefined): DatasetSpec[] {
  if (!value) return DATASETS;
  const ids = value.split(',').map(s => s.trim()).filter(Boolean);
  const unknown = ids.filter(id => !DATASET_IDS.includes(id as DatasetId));
  if (unknown.length > 0) {
    throw new Error(`Unknown dataset id(s): ${unknown.join(', ')}. Valid ids: ${DATASET_IDS.join(', ')}`);
  }
  const wanted = new Set(ids);
  return DATASETS.filter(d => wanted.has(d.id));
}
