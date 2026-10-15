/**
 * Shared MyVariant.info hit fixtures (BRAF V600E family) used by the entity
 * tests (variant, cross-entity).
 *
 * Byte-frozen: each named export preserves the exact value the tests used
 * before extraction. The two rs113488022 variants differ ONLY in
 * `snpeff.ann[0].hgvs_p` spelling (already-shorthand vs three-letter) —
 * that difference is the point of the tests that use them; keep both.
 */

/** Raw myvariant /query hit shape as consumed by `transformMyVariantHit`. */
export interface MyVariantHitFixture {
  _id: string;
  dbsnp?: { rsid?: string; gene?: { symbol?: string } };
  snpeff?: { ann: Array<{ genename?: string; hgvs_p?: string; hgvs_c?: string }> };
  clinvar?: { rcv?: Array<{ clinical_significance?: string; review_status?: string }> };
  gnomad_exome?: { af?: { af?: number } };
}

/**
 * The "vcf123" full hit exercising every transform input: dbsnp gene symbol,
 * snpeff three-letter protein change, clinvar significance + review status,
 * and gnomad exome AF.
 */
export const vcf123BrafV600eHit: MyVariantHitFixture = {
  _id: 'vcf123',
  dbsnp: { rsid: 'rs123', gene: { symbol: 'BRCA1' } },
  snpeff: { ann: [{ hgvs_p: 'p.Val600Glu', hgvs_c: 'c.1799T>A', genename: 'BRCA1' }] },
  clinvar: { rcv: [{ clinical_significance: 'Pathogenic', review_status: 'reviewed by expert panel' }] },
  gnomad_exome: { af: { af: 0.001 } },
};

/** rs113488022 hit whose snpeff protein change is ALREADY shorthand (`p.V600E`). */
export const rs113488022ShorthandHit: MyVariantHitFixture = {
  _id: 'rs113488022',
  dbsnp: { rsid: 'rs113488022' },
  snpeff: { ann: [{ genename: 'BRAF', hgvs_p: 'p.V600E' }] },
  clinvar: { rcv: [{ clinical_significance: 'Pathogenic' }] },
};

/** rs113488022 hit with the three-letter protein change (`p.Val600Glu`) — must be normalized. */
export const rs113488022ThreeLetterHit: MyVariantHitFixture = {
  _id: 'rs113488022',
  dbsnp: { rsid: 'rs113488022' },
  snpeff: { ann: [{ genename: 'BRAF', hgvs_p: 'p.Val600Glu' }] },
  clinvar: { rcv: [{ clinical_significance: 'Pathogenic' }] },
};
