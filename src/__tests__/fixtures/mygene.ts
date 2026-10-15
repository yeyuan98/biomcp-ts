/**
 * Shared MyGene.info hit fixtures (BRCA1/TP53) used by the entity tests
 * (gene, variant, cross-entity).
 *
 * Byte-frozen: each named export preserves the exact value the tests used
 * before extraction. Where two tests used slightly different variants of
 * "the same" hit, both live here as separate named exports — do NOT unify
 * them (values are load-bearing for the assertions around them).
 */

/** Raw mygene /query hit shape as consumed by `transformMyGeneResponse`. */
export interface MyGeneHitFixture {
  symbol: string;
  name: string;
  summary?: string;
}

/** Minimal BRCA1 hit — no summary, short name (`{ symbol: 'BRCA1', name: 'BRCA1' }`). */
export const brca1MinimalHit: MyGeneHitFixture = {
  symbol: 'BRCA1',
  name: 'BRCA1',
};

/** BRCA1 hit with the "DNA repair." summary (gene.test.ts workhorse). */
export const brca1DnaRepairHit: MyGeneHitFixture = {
  symbol: 'BRCA1',
  name: 'BRCA1 DNA repair',
  summary: 'DNA repair.',
};

/** BRCA1 hit with the longer "DNA repair gene." summary variant. */
export const brca1DnaRepairGeneHit: MyGeneHitFixture = {
  symbol: 'BRCA1',
  name: 'BRCA1 DNA repair',
  summary: 'DNA repair gene.',
};

/** TP53 hit with the "Tumor suppressor." summary (gene.test.ts workhorse). */
export const tp53TumorSuppressorHit: MyGeneHitFixture = {
  symbol: 'TP53',
  name: 'Tumor protein p53',
  summary: 'Tumor suppressor.',
};
