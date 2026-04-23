import { transformMyGeneHit, transformMyGeneResponse, normalizeSummary, normalizeAliases } from '../../transform/gene.js';

describe('transformMyGeneHit', () => {
  it('maps full fields correctly', () => {
    const hit = {
      symbol: 'BRAF',
      name: 'B-Raf proto-oncogene',
      entrezgene: 673,
      genomic_pos: [{ chr: '7', start: 140753336, end: 140924929 }],
      uniprot: ['P15056'],
      omim: [164757],
    };
    const result = transformMyGeneHit(hit);
    expect(result).toEqual({
      symbol: 'BRAF',
      name: 'B-Raf proto-oncogene',
      entrez_id: 673,
      genomic_coordinates: {
        chromosome: '7',
        start: 140753336,
        end: 140924929,
      },
      uniprot_id: 'P15056',
      omim_id: '164757',
    });
  });

  it('handles missing optional fields gracefully', () => {
    const hit = {
      symbol: 'FAKE',
      name: 'Fake Gene',
    };
    const result = transformMyGeneHit(hit);
    expect(result).toEqual({
      symbol: 'FAKE',
      name: 'Fake Gene',
      entrez_id: undefined,
      genomic_coordinates: undefined,
      uniprot_id: undefined,
      omim_id: undefined,
    });
  });
});

describe('transformMyGeneResponse', () => {
  it('maps single MyGeneRecord to GeneResult', () => {
    const data = {
      symbol: 'BRAF',
      name: 'B-Raf proto-oncogene',
      summary: 'This gene encodes a protein.',
      genomic_pos: [{ chr: '7', start: 140753336, end: 140924929 }],
      uniprot: [{ SwissProt: 'P15056' }],
      omim: [164757],
    };
    const result = transformMyGeneResponse(data);
    expect(result).toEqual({
      symbol: 'BRAF',
      name: 'B-Raf proto-oncogene',
      summary: 'This gene encodes a protein.',
    });
  });
});

describe('normalizeSummary', () => {
  it('removes bracket and parenthetical content', () => {
    const result = normalizeSummary('BRCA1 [gene] (human)');
    expect(result).toBe('BRCA1');
  });
});

describe('normalizeAliases', () => {
  it('filters falsy values', () => {
    const result = normalizeAliases(['BRAF', '', 'TP53']);
    expect(result).toEqual(['BRAF', 'TP53']);
  });
});
