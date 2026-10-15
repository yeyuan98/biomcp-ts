import { transformMyGeneHit, transformMyGeneResponse, normalizeAliases } from '../../transform/gene.js';

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

  it('maps object-shaped genomic_pos/uniprot (mygene single-mapping shapes)', () => {
    // Live mygene /query returns genomic_pos and uniprot as PLAIN OBJECTS for
    // single mappings (TP53 → genomic_pos:{"chr":"17",...},
    // uniprot:{"SwissProt":"P04637"}); arrays appear only for multi-mappings.
    const hit = {
      symbol: 'TP53',
      name: 'Tumor protein p53',
      entrezgene: 7157,
      genomic_pos: { chr: '17', start: 7661779, end: 7687538 },
      uniprot: { SwissProt: 'P04637' },
      omim: [191170],
    };
    const result = transformMyGeneHit(hit);
    expect(result).toEqual({
      symbol: 'TP53',
      name: 'Tumor protein p53',
      entrez_id: 7157,
      genomic_coordinates: {
        chromosome: '17',
        start: 7661779,
        end: 7687538,
      },
      uniprot_id: 'P04637',
      omim_id: '191170',
    });
  });

  it('prefers the filtered chromosome when genomic_pos is a multi-mapping array', () => {
    // PAR-region genes map to both X and Y; mygene's array order is not
    // guaranteed, so a chrY-filtered search must display the Y coordinates.
    const hit = {
      symbol: 'WASIR1',
      name: 'WAS/WASL interacting protein family member 1',
      entrezgene: 100128260,
      genomic_pos: [
        { chr: 'X', start: 48514391, end: 48599443 },
        { chr: 'Y', start: 126485, end: 211537 },
      ],
    };
    const result = transformMyGeneHit(hit, 'Y');
    expect(result.genomic_coordinates).toEqual({
      chromosome: 'Y',
      start: 126485,
      end: 211537,
    });
    // Without a preference the previous first-element behavior is kept.
    expect(transformMyGeneHit(hit).genomic_coordinates?.chromosome).toBe('X');
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

describe('normalizeAliases', () => {
  it('filters falsy values', () => {
    const result = normalizeAliases(['BRAF', '', 'TP53']);
    expect(result).toEqual(['BRAF', 'TP53']);
  });
});
