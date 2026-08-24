export const MODELS_PINNED_COLUMNS: string[] = [
  'ModelID', 'PatientID', 'CellLineName', 'StrippedCellLineName', 'DepmapModelType',
  'OncotreeLineage', 'OncotreePrimaryDisease', 'OncotreeSubtype', 'OncotreeCode',
  'PatientSubtypeFeatures', 'RRID', 'Age', 'AgeCategory', 'Sex', 'PatientRace',
  'PrimaryOrMetastasis', 'SampleCollectionSite', 'SourceType', 'SourceDetail', 'CatalogNumber',
  'ModelType', 'TissueOrigin', 'ModelDerivationMaterial', 'ModelTreatment',
  'PatientTreatmentStatus', 'PatientTreatmentType', 'PatientTreatmentDetails', 'Stage',
  'StagingSystem', 'PatientTumorGrade', 'PatientTreatmentResponse', 'GrowthPattern',
  'OnboardedMedia', 'FormulationID', 'SerumFreeMedia', 'PlateCoating', 'EngineeredModel',
  'EngineeredModelDetails', 'CulturedResistanceDrug', 'PublicComments', 'CCLEName', 'HCMIID',
  'PediatricModelType', 'ModelAvailableInDbgap', 'ModelSubtypeFeatures', 'WTSIMasterCellID',
  'SangerModelID', 'COSMICID', 'ModelIDAlias',
];

export const MUTATION_COLUMNS: Record<string, string> = {
  model_id: 'ModelID',
  hugo_symbol: 'HugoSymbol',
  entrez_gene_id: 'EntrezGeneID',
  chromosome: 'Chrom',
  position: 'Pos',
  ref: 'Ref',
  alt: 'Alt',
  variant_type: 'VariantType',
  variant_info: 'VariantInfo',
  dna_change: 'DNAChange',
  protein_change: 'ProteinChange',
  gt: 'GT',
  ref_count: 'RefCount',
  alt_count: 'AltCount',
  af: 'AF',
  dp: 'DP',
  molecular_consequence: 'MolecularConsequence',
  vep_impact: 'VepImpact',
  is_hotspot: 'Hotspot',
  hess_driver: 'HessDriver',
  hess_signature: 'HessSignature',
  likely_lof: 'LikelyLoF',
  gnomad_e_af: 'GnomadeAF',
  gnomad_g_af: 'GnomadgAF',
};

export const GENE_REQUIRED_COLUMNS = ['hgnc_id', 'symbol', 'name', 'entrez_id'];

export function sanitizeIdentifier(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return cleaned === '' ? 'col' : cleaned;
}

export interface ModelsTableSchema {
  ddl: string;
  columns: { original: string; sql: string }[];
  addedColumns: string[];
}

export function buildModelsTable(header: string[]): ModelsTableSchema {
  const headerSet = new Set(header);
  const missing = MODELS_PINNED_COLUMNS.filter(c => !headerSet.has(c));
  if (missing.length > 0) {
    throw new Error(
      `Model.csv header is missing pinned column(s): ${missing.join(', ')}.\n` +
      `Actual header: ${header.join(', ')}\n` +
      `The pinned baseline in schema.ts must be updated for this release.`
    );
  }
  const addedColumns = header.filter(c => !MODELS_PINNED_COLUMNS.includes(c));
  const seen = new Set<string>();
  const columns = header.map(original => {
    if (original === 'ModelID') return { original, sql: 'model_id' };
    let sql = sanitizeIdentifier(original);
    const base = sql;
    let k = 2;
    while (seen.has(sql)) sql = `${base}_${k++}`;
    seen.add(sql);
    return { original, sql };
  });
  const defs = columns.map(c => (c.original === 'ModelID' ? 'model_id TEXT PRIMARY KEY' : `"${c.sql}" TEXT`));
  return { ddl: `CREATE TABLE models(${defs.join(', ')})`, columns, addedColumns };
}

export function matrixTableDdl(table: string): string {
  return (
    `CREATE TABLE ${table}(model_id TEXT NOT NULL, gene_symbol TEXT NOT NULL, value REAL NOT NULL,` +
    ` PRIMARY KEY(model_id, gene_symbol)) WITHOUT ROWID`
  );
}

export const BASE_TABLE_DDLS = [
  'CREATE TABLE depmap_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE dataset(dataset_id TEXT NOT NULL, filename TEXT NOT NULL, row_count INTEGER NOT NULL,' +
    ' imported_at TEXT NOT NULL, PRIMARY KEY(dataset_id, filename))',
  'CREATE TABLE genes(gene_symbol TEXT PRIMARY KEY, entrez_id INTEGER, gene_name TEXT)',
  'CREATE INDEX idx_genes_entrez ON genes(entrez_id)',
  'CREATE TABLE essentiality_controls(gene_symbol TEXT NOT NULL, category TEXT NOT NULL,' +
    ' PRIMARY KEY(gene_symbol, category)) WITHOUT ROWID',
  'CREATE TABLE mutations(' +
    'model_id TEXT NOT NULL, hugo_symbol TEXT, entrez_gene_id INTEGER, chromosome TEXT,' +
    ' position INTEGER, ref TEXT, alt TEXT, variant_type TEXT, variant_info TEXT,' +
    ' dna_change TEXT, protein_change TEXT, gt TEXT, ref_count INTEGER, alt_count INTEGER,' +
    ' af REAL, dp INTEGER, molecular_consequence TEXT, vep_impact TEXT, is_hotspot INTEGER,' +
    ' hess_driver TEXT, hess_signature TEXT, likely_lof TEXT, gnomad_e_af REAL, gnomad_g_af REAL)',
  'CREATE INDEX idx_mut_gene ON mutations(hugo_symbol)',
  'CREATE INDEX idx_mut_model ON mutations(model_id)',
];
