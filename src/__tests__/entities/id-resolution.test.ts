import { jest } from '@jest/globals';
import { parseArticleId, resolveToPmid, resolveDoiToPmid } from '../../entities/article/detail/id-resolution.js';
import { connectionManager } from '../../connections/manager.js';

describe('parseArticleId', () => {
  test('parses numeric PMID', () => {
    const result = parseArticleId('12345678');
    expect(result).toEqual({ type: 'pmid', value: '12345678' });
  });

  test('parses PMCID with PMC prefix', () => {
    const result = parseArticleId('PMC1234567');
    expect(result).toEqual({ type: 'pmcid', value: 'PMC1234567' });
  });

  test('parses lowercase pmcid', () => {
    const result = parseArticleId('pmc1234567');
    expect(result).toEqual({ type: 'pmcid', value: 'pmc1234567' });
  });

  test('parses DOI without prefix', () => {
    const result = parseArticleId('10.1234/test.doi.5678');
    expect(result).toEqual({ type: 'doi', value: '10.1234/test.doi.5678' });
  });

  test('parses DOI with doi: prefix', () => {
    const result = parseArticleId('doi:10.1234/test.doi.5678');
    expect(result).toEqual({ type: 'doi', value: '10.1234/test.doi.5678' });
  });

  test('parses DOI with uppercase DOI: prefix', () => {
    const result = parseArticleId('DOI:10.1234/test.doi.5678');
    expect(result).toEqual({ type: 'doi', value: '10.1234/test.doi.5678' });
  });

  test('parses complex DOI with special characters', () => {
    const result = parseArticleId('10.1016/j.cub.2020.01.067');
    expect(result).toEqual({ type: 'doi', value: '10.1016/j.cub.2020.01.067' });
  });

  test('trims whitespace from input', () => {
    expect(parseArticleId('  12345678  ')).toEqual({ type: 'pmid', value: '12345678' });
    expect(parseArticleId('\tPMC1234567\n')).toEqual({ type: 'pmcid', value: 'PMC1234567' });
  });

  test('throws error for unrecognized format', () => {
    expect(() => parseArticleId('invalid')).toThrow('Unrecognized identifier format');
    expect(() => parseArticleId('ABC123')).toThrow('Unrecognized identifier format');
    expect(() => parseArticleId('10.x')).toThrow('Unrecognized identifier format'); // Incomplete DOI
    expect(() => parseArticleId('')).toThrow('Unrecognized identifier format');
  });

  test('error message includes helpful information', () => {
    try {
      parseArticleId('xyz123');
      fail('Expected error to be thrown');
    } catch (error) {
      expect((error as Error).message).toContain('PMID');
      expect((error as Error).message).toContain('PMCID');
      expect((error as Error).message).toContain('DOI');
    }
  });
});

describe('resolveToPmid', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('resolves DOI to PMID via NCBI IDConv', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        records: [{ pmid: 12345678, doi: '10.1234/test' }],
      }),
    }) as any;

    const result = await resolveToPmid('10.1234/test', 'doi');
    expect(result).toEqual({ pmid: '12345678', doi: '10.1234/test' });
  });

  test('resolves PMCID to PMID via NCBI IDConv', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        records: [{ pmid: 12345678, pmcid: 'PMC1234567' }],
      }),
    }) as any;

    const result = await resolveToPmid('PMC1234567', 'pmcid');
    expect(result).toEqual({ pmid: '12345678', pmcid: 'PMC1234567' });
  });

  test('returns all available IDs', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        records: [{
          pmid: 12345678,
          doi: '10.1234/test',
          pmcid: 'PMC1234567'
        }],
      }),
    }) as any;

    const result = await resolveToPmid('10.1234/test', 'doi');
    expect(result).toEqual({
      pmid: '12345678',
      doi: '10.1234/test',
      pmcid: 'PMC1234567'
    });
  });

  test('throws error when no record returned', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ records: [] }),
    }) as any;

    await expect(resolveToPmid('10.9999/nonexistent', 'doi')).rejects.toThrow('No record returned');
  });

  test('throws error when record has error status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        records: [{ status: 'error', errmsg: 'ID not found' }],
      }),
    }) as any;

    await expect(resolveToPmid('invalid-id', 'doi')).rejects.toThrow('Could not resolve doi');
  });

  test('throws error when PMID is missing from response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        records: [{ doi: '10.1234/test' }],
      }),
    }) as any;

    await expect(resolveToPmid('10.1234/test', 'doi')).rejects.toThrow('Could not resolve doi');
  });

  test('handles network errors gracefully', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as any;

    await expect(resolveToPmid('10.1234/test', 'doi')).rejects.toThrow('ID resolution failed');
  });
});

describe('resolveDoiToPmid', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('resolves DOI to PMID via PubMed ESearch', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        esearchresult: { idlist: ['12345678'] }
      }),
    }) as any;

    const result = await resolveDoiToPmid('10.1234/test');
    expect(result).toEqual({ pmid: '12345678', doi: '10.1234/test' });
  });

  test('throws error when DOI not found in PubMed', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        esearchresult: { idlist: [] }
      }),
    }) as any;

    await expect(resolveDoiToPmid('10.9999/nonexistent')).rejects.toThrow('Could not resolve doi');
  });

  test('throws error when esearchresult is missing', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any;

    await expect(resolveDoiToPmid('10.1234/test')).rejects.toThrow('Could not resolve doi');
  });

  test('handles network errors gracefully', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as any;

    await expect(resolveDoiToPmid('10.1234/test')).rejects.toThrow('DOI resolution failed');
  });

  test('uses correct URL format for DOI search', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        esearchresult: { idlist: ['12345678'] }
      }),
    }) as any;

    await resolveDoiToPmid('10.1234/test.doi');

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('/esearch.fcgi');
    expect(callUrl).toContain('db=pubmed');
    // URL encodes / as %2F
    expect(callUrl).toContain('10.1234%2Ftest.doi[doi]');
  });
});
