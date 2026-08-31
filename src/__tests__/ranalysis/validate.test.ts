import { describe, it, expect } from '@jest/globals';
import {
  canonicalizeAnalysisInput,
  toCountsCsv,
  toColdataCsv,
  ValidationError,
} from '../../ranalysis/validate.js';

const VALID_COUNTS = {
  genes: ['g1', 'g2', 'g3'],
  samples: ['s1', 's2', 's3', 's4'],
  matrix: [
    [10, 12, 20, 22],
    [5, 6, 6, 5],
    [100, 90, 300, 320],
  ],
};

const VALID_COLDATA = {
  samples: ['s3', 's1', 's4', 's2'],
  columns: { condition: ['b', 'a', 'b', 'a'] },
};

function makeInput(overrides: Record<string, unknown> = {}) {
  return { counts: VALID_COUNTS, coldata: VALID_COLDATA, design: 'condition', ...overrides };
}

describe('analysis input canonicalization', () => {
  it('accepts valid input and reorders coldata to counts sample order', () => {
    const req = canonicalizeAnalysisInput(makeInput() as never);
    expect(req.coldata.samples).toEqual(['s1', 's2', 's3', 's4']);
    expect(req.coldata.columns.condition).toEqual(['a', 'a', 'b', 'b']);
    expect(req.topN).toBe(50);
    expect(req.format).toBe('table');
    expect(req.includeFull).toBe(false);
  });

  it('rejects duplicate gene ids', () => {
    expect(() =>
      canonicalizeAnalysisInput(makeInput({ counts: { ...VALID_COUNTS, genes: ['g1', 'g1', 'g3'] } }) as never)
    ).toThrow(/Duplicate gene IDs/);
  });

  it('rejects duplicate sample names', () => {
    expect(() =>
      canonicalizeAnalysisInput(
        makeInput({
          counts: { genes: ['g1'], samples: ['s1', 's1'], matrix: [[1, 2]] },
          coldata: { samples: ['s1', 's1'], columns: { condition: ['a', 'b'] } },
        }) as never
      )
    ).toThrow(/Duplicate sample/);
  });

  it('rejects negative and non-integer counts with cell references', () => {
    const bad = { ...VALID_COUNTS, matrix: [[10, 12, 20, -1], [5, 6, 6, 5], [100, 90, 300, 320]] };
    expect(() => canonicalizeAnalysisInput(makeInput({ counts: bad }) as never)).toThrow(/negative/);
    const frac = { ...VALID_COUNTS, matrix: [[10.5, 12, 20, 1], [5, 6, 6, 5], [100, 90, 300, 320]] };
    expect(() => canonicalizeAnalysisInput(makeInput({ counts: frac }) as never)).toThrow(/not an integer/);
  });

  it('rejects mismatched sample sets with actionable messages', () => {
    expect(() =>
      canonicalizeAnalysisInput(makeInput({ coldata: { samples: ['s1', 's2', 's3', 'x'], columns: { condition: ['a', 'a', 'b', 'b'] } } }) as never)
    ).toThrow(/missing from coldata/);
  });

  it('rejects single-valued coldata columns', () => {
    expect(() =>
      canonicalizeAnalysisInput(makeInput({ coldata: { samples: ['s1', 's2', 's3', 's4'], columns: { condition: ['a', 'a', 'a', 'a'] } } }) as never)
    ).toThrow(/single unique value/);
  });

  it('rejects disallowed characters and denylisted tokens in the design formula', () => {
    expect(() => canonicalizeAnalysisInput(makeInput({ design: 'condition; system("rm")' }) as never)).toThrow(/disallowed characters/);
    expect(() => canonicalizeAnalysisInput(makeInput({ design: 'q' }) as never)).toThrow(/disallowed token/);
    expect(() => canonicalizeAnalysisInput(makeInput({ design: 'library' }) as never)).toThrow(/disallowed token/);
  });

  it('rejects design variables that are not coldata columns', () => {
    expect(() => canonicalizeAnalysisInput(makeInput({ design: 'batch + condition' }) as never)).toThrow(
      /unknown coldata column.*batch.*Available columns: condition/
    );
  });

  it('accepts multi-variable designs and validates them', () => {
    const coldata = { samples: ['s1', 's2', 's3', 's4'], columns: { condition: ['a', 'a', 'b', 'b'], batch: [1, 2, 1, 2] } };
    const req = canonicalizeAnalysisInput(makeInput({ coldata, design: 'batch + condition' }) as never);
    expect(req.design).toBe('batch + condition');
  });

  it('accepts and strips a leading tilde from the design formula (R full-form habit)', () => {
    expect(canonicalizeAnalysisInput(makeInput({ design: '~condition' }) as never).design).toBe('condition');
    expect(canonicalizeAnalysisInput(makeInput({ design: '~ condition' }) as never).design).toBe('condition');
    expect(canonicalizeAnalysisInput(makeInput({ design: '~ batch + condition', coldata: { samples: ['s1', 's2', 's3', 's4'], columns: { condition: ['a', 'a', 'b', 'b'], batch: [1, 2, 1, 2] } } }) as never).design).toBe('batch + condition');
  });

  it('still rejects double tildes and a bare tilde', () => {
    expect(() => canonicalizeAnalysisInput(makeInput({ design: '~~condition' }) as never)).toThrow(/disallowed characters/);
    expect(() => canonicalizeAnalysisInput(makeInput({ design: '~' }) as never)).toThrow();
  });

  it('validates contrast variable and levels', () => {
    expect(() =>
      canonicalizeAnalysisInput(
        makeInput({ contrast: { variable: 'condition', numerator: 'a', denominator: 'zzz' } }) as never
      )
    ).toThrow(/Contrast level "zzz" not found/);
    expect(() =>
      canonicalizeAnalysisInput(makeInput({ contrast: { variable: 'nope', numerator: 'a', denominator: 'b' } }) as never
      )
    ).toThrow(/not a coldata column/);
  });

  it('rejects contrast and coef together', () => {
    expect(() =>
      canonicalizeAnalysisInput(
        makeInput({ contrast: { variable: 'condition', numerator: 'b', denominator: 'a' }, coef: 'conditionb' }) as never
      )
    ).toThrow(/not both/);
  });

  it('rejects more than 64 samples', () => {
    const samples = Array.from({ length: 65 }, (_, i) => `s${i}`);
    const genes = ['g1', 'g2'];
    const matrix = genes.map(() => samples.map(() => 1));
    expect(() =>
      canonicalizeAnalysisInput(
        makeInput({ counts: { genes, samples, matrix }, coldata: { samples, columns: { condition: samples.map((s) => s.replace('s', 'c')) } } }) as never
      )
    ).toThrow(/maximum is 64/);
  });

  it('parses counts and coldata from CSV strings including quoted fields', () => {
    const countsCsv = 'gene,s1,s2\n"g,1",5,10\ng2,7,8';
    const coldataCsv = 'sample,condition\ns1,"a,x"\ns2,b';
    const req = canonicalizeAnalysisInput(makeInput({ counts: countsCsv, coldata: coldataCsv }) as never);
    expect(req.counts.genes).toEqual(['g,1', 'g2']);
    expect(req.counts.matrix).toEqual([[5, 10], [7, 8]]);
    expect(req.coldata.columns.condition).toEqual(['a,x', 'b']);
  });

  it('rejects non-numeric CSV cells with location', () => {
    const countsCsv = 'gene,s1,s2\ng1,5,10\ng2,abc,8';
    expect(() => canonicalizeAnalysisInput(makeInput({ counts: countsCsv }) as never)).toThrow(
      /\(row 3, column 2\).*abc/
    );
  });

  it('emits CSV serializations round-trippable by the parser', () => {
    const req = canonicalizeAnalysisInput(makeInput() as never);
    const countsCsv = toCountsCsv(req);
    const coldataCsv = toColdataCsv(req);
    const round = canonicalizeAnalysisInput(makeInput({ counts: countsCsv, coldata: coldataCsv }) as never);
    expect(round.counts.matrix).toEqual(req.counts.matrix);
    expect(round.coldata.columns).toEqual(req.coldata.columns);
  });

  it('throws ValidationError instances', () => {
    try {
      canonicalizeAnalysisInput(makeInput({ design: '' }) as never);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
    }
  });
});
