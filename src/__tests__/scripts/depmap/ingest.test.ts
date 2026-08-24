import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MODELS_PINNED_COLUMNS } from '../../../../scripts/external-databases/depmap/schema.js';
import {
  createDatabase,
  ingestControls,
  ingestGenes,
  ingestMatrix,
  ingestModels,
  ingestMutations,
  loadSqlite,
  writeMetadata,
} from '../../../../scripts/external-databases/depmap/ingest.js';

let dir: string;
let dbCounter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'depmap-ingest-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newDb(): ReturnType<typeof createDatabase> {
  return createDatabase(join(dir, `test-${++dbCounter}.db`));
}

function csvLine(fields: (string | undefined)[]): string {
  return fields
    .map(f => (f !== undefined && /[",\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f ?? ''))
    .join(',');
}

function modelsFixture(extraHeader?: string, extraValue?: string): string {
  const header = [...MODELS_PINNED_COLUMNS, ...(extraHeader ? [extraHeader] : [])];
  const row = MODELS_PINNED_COLUMNS.map(() => '');
  row[MODELS_PINNED_COLUMNS.indexOf('ModelID')] = 'ACH-000001';
  row[MODELS_PINNED_COLUMNS.indexOf('CellLineName')] = 'NIH:OVCAR-3';
  row[MODELS_PINNED_COLUMNS.indexOf('OncotreeSubtype')] = 'a,b';
  row[MODELS_PINNED_COLUMNS.indexOf('PatientSubtypeFeatures')] = 'TP53(del), NRAS';
  if (extraValue !== undefined) row.push(extraValue);
  return `${csvLine(header)}\n${csvLine(row)}`;
}

function writeFixture(name: string, lines: string[]): string {
  const file = join(dir, name);
  writeFileSync(file, lines.join('\n'));
  return file;
}

describe('depmap ingest', () => {
  it('ingests models with quoted commas, stores the column map, and tolerates appended columns', async () => {
    const db = newDb();
    await ingestModels(db, writeFixture('Model.csv', [modelsFixture('ExtraCol', 'x')]));
    const row = db.prepare('SELECT model_id, celllinename, oncotreesubtype, patientsubtypefeatures, extracol FROM models').get() as Record<string, unknown>;
    expect(row.model_id).toBe('ACH-000001');
    expect(row.celllinename).toBe('NIH:OVCAR-3');
    expect(row.oncotreesubtype).toBe('a,b');
    expect(row.patientsubtypefeatures).toBe('TP53(del), NRAS');
    expect(row.extracol).toBe('x');
    const map = JSON.parse((db.prepare("SELECT value FROM depmap_meta WHERE key='models_column_map'").get() as { value: string }).value);
    expect(map).toContainEqual(['OncotreeSubtype', 'oncotreesubtype']);
    db.close();
  });

  it('hard-errors when a pinned model column is missing', async () => {
    const db = newDb();
    const broken = [MODELS_PINNED_COLUMNS.filter(c => c !== 'RRID').join(','), 'ACH-000001'].join('\n');
    await expect(ingestModels(db, writeFixture('ModelBroken.csv', [broken]))).rejects.toThrow(/RRID/);
    db.close();
  });

  it('ingests genes with float-string entrez ids and NULL empties', async () => {
    const db = newDb();
    const file = writeFixture('Gene.csv', [
      'hgnc_id,symbol,name,entrez_id,extra',
      'HGNC:1,A1BG,alpha-1-B glycoprotein,1.0,x',
      'HGNC:2,KRAS,KRAS proto-oncogene,3845.0,y',
      'HGNC:3,ORPHAN,no entrez,,z',
    ]);
    const result = await ingestGenes(db, file);
    expect(result.rowCount).toBe(3);
    const kras = db.prepare("SELECT entrez_id FROM genes WHERE gene_symbol='KRAS'").get() as { entrez_id: number };
    expect(kras.entrez_id).toBe(3845);
    const orphan = db.prepare("SELECT entrez_id FROM genes WHERE gene_symbol='ORPHAN'").get() as { entrez_id: number | null };
    expect(orphan.entrez_id).toBeNull();
    db.close();
  });

  it('ingests essentiality controls with suffix stripping', async () => {
    const db = newDb();
    await ingestControls(db, [
      { file: writeFixture('AchillesCommonEssentialControls.csv', ['Gene', 'ACTL7A (10881)', 'AANF (12345)']), category: 'common_essential' },
      { file: writeFixture('AchillesNonessentialControls.csv', ['Gene', 'ACTL7A (10881)']), category: 'nonessential' },
    ]);
    const rows = db.prepare('SELECT gene_symbol, category FROM essentiality_controls ORDER BY gene_symbol, category').all() as unknown[];
    expect(rows).toEqual([
      { gene_symbol: 'AANF', category: 'common_essential' },
      { gene_symbol: 'ACTL7A', category: 'common_essential' },
      { gene_symbol: 'ACTL7A', category: 'nonessential' },
    ]);
    db.close();
  });

  it('ingests a positional matrix, skipping empty cells', async () => {
    const db = newDb();
    const file = writeFixture('CRISPRGeneEffect.csv', [
      ',A1BG (1),KRAS (3845),TP53 (7157)',
      'ACH-000001,-0.2,,-1.5',
      'ACH-000002,0.1,-3.0,NaN',
    ]);
    const result = await ingestMatrix(db, file, 'gene_effect', 'positional');
    expect(result.rowCount).toBe(4);
    expect(result.details).toContain('2 empty cells skipped');
    const kras = db.prepare("SELECT model_id, value FROM gene_effect WHERE gene_symbol='KRAS'").get() as { model_id: string; value: number };
    expect(kras.model_id).toBe('ACH-000002');
    expect(kras.value).toBeCloseTo(-3.0);
    const count = db.prepare('SELECT COUNT(*) n FROM gene_effect').get() as { n: number };
    expect(count.n).toBe(4);
    db.close();
  });

  it('ingests a named matrix keeping only IsDefaultEntryForModel=Yes profiles', async () => {
    const db = newDb();
    const file = writeFixture('OmicsExpression.csv', [
      ',SequencingID,ModelConditionID,ModelID,IsDefaultEntryForMC,IsDefaultEntryForModel,KRAS (3845),TP53 (7157)',
      '0,SEQ-1,MC-1,ACH-000001,False,No,1.0,2.0',
      '1,SEQ-2,MC-2,ACH-000001,True,Yes,3.0,4.0',
      '2,SEQ-3,MC-3,ACH-000002,True,Yes,,5.5',
    ]);
    const result = await ingestMatrix(db, file, 'expression_tpm', 'named');
    expect(result.rowCount).toBe(3);
    expect(result.details).toContain('1 non-default profiles skipped');
    const kras = db.prepare("SELECT value FROM expression_tpm WHERE model_id='ACH-000001' AND gene_symbol='KRAS'").get() as { value: number };
    expect(kras.value).toBe(3.0);
    const missing = db.prepare("SELECT COUNT(*) n FROM expression_tpm WHERE model_id='ACH-000001' AND gene_symbol='TP53' AND value=2.0").get() as { n: number };
    expect(missing.n).toBe(0);
    db.close();
  });

  it('hard-errors on duplicate gene columns after suffix stripping', async () => {
    const db = newDb();
    const file = writeFixture('Dup.csv', [',A (1),A (2)', 'ACH-000001,1,2']);
    await expect(ingestMatrix(db, file, 'dup_table', 'positional')).rejects.toThrow(/duplicate gene column "A"/);
    db.close();
  });

  it('ingests mutations with curated mapping and boolean/number coercion', async () => {
    const db = newDb();
    const header = [
      '', 'SequencingID', 'ModelID', 'ModelConditionID', 'IsDefaultEntryForModel', 'IsDefaultEntryForMC',
      'Chrom', 'Pos', 'Ref', 'Alt', 'AF', 'DP', 'RefCount', 'AltCount', 'GT', 'PS', 'VariantType',
      'VariantInfo', 'DNAChange', 'ProteinChange', 'HugoSymbol', 'Exon', 'Intron', 'EnsemblGeneID',
      'EnsemblFeatureID', 'HgncName', 'HgncFamily', 'UniprotID', 'DbsnpRsID', 'GcContent', 'NMD',
      'MolecularConsequence', 'VepImpact', 'VepBiotype', 'VepHgncID', 'VepExistingVariation',
      'VepManeSelect', 'VepENSP', 'VepSwissprot', 'Sift', 'Polyphen', 'GnomadeAF', 'GnomadgAF',
      'VepClinSig', 'VepSomatic', 'VepPliGeneValue', 'VepLofTool', 'OncogeneHighImpact',
      'TumorSuppressorHighImpact', 'TranscriptLikelyLof', 'Brca1FuncScore', 'CivicID',
      'CivicDescription', 'CivicScore', 'LikelyLoF', 'HessDriver', 'HessSignature', 'RevelScore',
      'PharmgkbId', 'GwasDisease', 'GwasPmID', 'GtexGene', 'ProveanPrediction', 'AMClass',
      'AMPathogenicity', 'Rescue', 'RescueReason', 'Hotspot', 'EntrezGeneID',
    ];
    expect(header).toHaveLength(69);
    const makeRow = (values: Record<string, string>): string => {
      const row = new Array<string>(header.length).fill('');
      for (const [column, value] of Object.entries(values)) row[header.indexOf(column)] = value;
      return row.join(',');
    };
    const row1 = makeRow({
      SequencingID: 'SQ-1', ModelID: 'ACH-000001', Chrom: 'chr1', Pos: '818203', Ref: 'G', Alt: 'A',
      AF: '0.24', DP: '27', RefCount: '21', AltCount: '6', GT: '0/1', VariantType: 'SNV',
      VariantInfo: 'splice_donor', DNAChange: 'ENST:n.832+1G>A', ProteinChange: 'p.X1Y',
      HugoSymbol: 'KRAS', MolecularConsequence: 'missense_variant', VepImpact: 'MODERATE',
      GnomadeAF: '0.01', GnomadgAF: '0.02', LikelyLoF: 'True', HessDriver: 'True',
      HessSignature: 'Sig5', Hotspot: 'True', EntrezGeneID: '3845',
    });
    const row2 = makeRow({
      SequencingID: 'SQ-2', ModelID: 'ACH-000002', Chrom: 'chr2', Pos: '100', Ref: 'A', Alt: 'T',
      DP: '10', RefCount: '5', AltCount: '1', GT: '1/1', VariantType: 'SNV',
      VariantInfo: 'stop_gained', DNAChange: 'c.2t>a', ProteinChange: 'p.R342Ter',
      HugoSymbol: 'TP53', MolecularConsequence: 'stop_gained', VepImpact: 'HIGH',
      Hotspot: 'False', EntrezGeneID: '7157',
    });
    const file = writeFixture('OmicsSomaticMutations.csv', [header.join(','), row1, row2]);
    const result = await ingestMutations(db, file);
    expect(result.rowCount).toBe(2);
    const mut = db.prepare("SELECT model_id, hugo_symbol, entrez_gene_id, position, is_hotspot, af, dp, gnomad_e_af FROM mutations WHERE hugo_symbol='KRAS'").get() as Record<string, unknown>;
    expect(mut.model_id).toBe('ACH-000001');
    expect(mut.entrez_gene_id).toBe(3845);
    expect(mut.position).toBe(818203);
    expect(mut.is_hotspot).toBe(1);
    expect(mut.af).toBeCloseTo(0.24);
    expect(mut.dp).toBe(27);
    expect(mut.gnomad_e_af).toBeCloseTo(0.01);
    const tp53 = db.prepare("SELECT is_hotspot, af FROM mutations WHERE hugo_symbol='TP53'").get() as Record<string, unknown>;
    expect(tp53.is_hotspot).toBe(0);
    expect(tp53.af).toBeNull();
    db.close();
  });

  it('hard-errors when a pinned mutation source column is missing', async () => {
    const db = newDb();
    const file = writeFixture('MutBroken.csv', ['ModelID,Chrom,Pos,Ref,Alt', 'ACH-000001,chr1,1,A,T']);
    await expect(ingestMutations(db, file)).rejects.toThrow(/missing pinned column/);
    db.close();
  });

  it('writes metadata and dataset provenance, readable via a read-only connection', async () => {
    const path = join(dir, `test-${++dbCounter}.db`);
    const db = createDatabase(path);
    await ingestGenes(db, writeFixture('Gene2.csv', ['hgnc_id,symbol,name,entrez_id', 'HGNC:9,KRAS,K,3845.0']));
    writeMetadata(
      db,
      { release: 'DepMap Public 26Q1', releaseDate: '2026-04-01', manifestEndpoint: 'https://example', scriptVersion: 'test' },
      [{ datasetId: 'genes', filename: 'Gene2.csv', rowCount: 1 }]
    );
    db.close();

    const reader = new (loadSqlite().DatabaseSync)(path);
    reader.exec('PRAGMA query_only = ON');
    const meta = reader.prepare("SELECT value FROM depmap_meta WHERE key='release'").get() as { value: string };
    expect(meta.value).toBe('DepMap Public 26Q1');
    const dataset = reader.prepare('SELECT dataset_id, filename, row_count FROM dataset').get() as Record<string, unknown>;
    expect(dataset.row_count).toBe(1);
    reader.close();
  });
});
