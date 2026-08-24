import {
  assertEutilsText,
  chunkUids,
  joinUidParam,
  parseEutilsJson,
} from '../../entities/eutils-utils.js';

describe('parseEutilsJson', () => {
  it('passes through valid esearch payloads', () => {
    const raw = JSON.stringify({
      header: { type: 'esearch' },
      esearchresult: { count: '1', idlist: ['200183947'] },
    });
    const parsed = parseEutilsJson<{ esearchresult: { idlist: string[] } }>(raw, 'GEO search');
    expect(parsed.esearchresult.idlist).toEqual(['200183947']);
  });

  it('throws on top-level error with HTTP 200 semantics', () => {
    const raw = JSON.stringify({ header: { type: 'esummary' }, error: 'Invalid uid XX at position= 0' });
    expect(() => parseEutilsJson(raw, 'GenBank summary')).toThrow(
      'GenBank summary: E-utilities error: Invalid uid XX at position= 0'
    );
  });

  it('throws on esearchresult.error', () => {
    const raw = JSON.stringify({ esearchresult: { error: 'Query disabled' } });
    expect(() => parseEutilsJson(raw, 'SRA search')).toThrow('SRA search: E-utilities error: Query disabled');
  });

  it('throws on result.error (esummary envelope)', () => {
    const raw = JSON.stringify({ result: { uids: [], error: 'Invalid uid SAMN1 at position= 0' } });
    expect(() => parseEutilsJson(raw, 'BioSample')).toThrow(/Invalid uid SAMN1/);
  });

  it('throws a descriptive error for non-JSON bodies', () => {
    expect(() => parseEutilsJson('<HTML>blocked</HTML>', 'GEO')).toThrow(/non-JSON response/);
  });

  it('includes body prefix when text starts with Error:', () => {
    expect(() => parseEutilsJson('Error: Failed to understand Id', 'efetch')).toThrow(/Failed to understand Id/);
  });
});

describe('assertEutilsText', () => {
  it('returns the original body for valid text', () => {
    const body = 'LOCUS       NG_017013';
    expect(assertEutilsText(body, 'GenBank')).toBe(body);
  });

  it('throws when body starts with Error:', () => {
    const body = 'Error: Failed to understand Id\n';
    expect(() => assertEutilsText(body, 'GenBank fetch')).toThrow(
      'GenBank fetch: E-utilities error: Error: Failed to understand Id'
    );
  });

  it('tolerates leading whitespace before error marker', () => {
    expect(() => assertEutilsText('  \n Error: bad', 'x')).toThrow(/bad/);
  });
});

describe('chunkUids / joinUidParam', () => {
  it('chunks ids to at most 200 per batch', () => {
    const ids = Array.from({ length: 450 }, (_, i) => String(i));
    const chunks = chunkUids(ids);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(200);
    expect(chunks[2]).toHaveLength(50);
  });

  it('joins at most 200 ids', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id${i}`);
    const param = joinUidParam(ids);
    expect(param.split(',')).toHaveLength(200);
  });

  it('handles empty input', () => {
    expect(chunkUids([])).toEqual([]);
    expect(joinUidParam([])).toBe('');
  });
});
