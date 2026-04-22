import { jest } from '@jest/globals';
import { articleSearch, articleGet, transformArticleResponse } from '../../entities/article.js';

describe('article', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    process.env.NCBI_API_KEY = '';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.NCBI_API_KEY;
  });

  test('articleSearch() calls connection with correct pubmed endpoint', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ esearchresult: { idlist: ['12345'] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ result: [{ uid: '12345', title: 'Test', source: 'Nature' }] }),
      }) as any;

    await articleSearch('brca1', { source: 'pubmed' });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const searchCallUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(searchCallUrl).toContain('eutils.ncbi.nlm.nih.gov');
    expect(searchCallUrl).toContain('/esearch.fcgi?');
    expect(searchCallUrl).toContain('db=pubmed');
    expect(searchCallUrl).toContain('term=brca1');
  });

  test('articleSearch() returns transformed results', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ esearchresult: { idlist: ['12345'] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          result: [{ uid: '12345', title: 'Test Article', source: 'Nature', sortpubdate: '2024/01/15' }],
        }),
      }) as any;

    const results = await articleSearch('brca1', { source: 'pubmed' });

    expect(results).toHaveLength(1);
    expect(results[0].pmid).toBe('12345');
    expect(results[0].title).toBe('Test Article');
    expect(results[0].journal).toBe('Nature');
  });

  test('articleGet() calls connection with correct endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: [{
          uid: '12345',
          title: 'Test Article',
          abstract: 'This is an abstract.',
          authors: [{ name: 'Smith J' }],
          source: 'Nature',
          pubdate: '2024 Jan 15',
        }],
      }),
    }) as any;

    await articleGet('12345');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('eutils.ncbi.nlm.nih.gov');
    expect(callUrl).toContain('/efetch.fcgi?');
    expect(callUrl).toContain('id=12345');
  });

  test('transformArticleResponse() maps fields correctly', () => {
    const input = {
      uid: '12345',
      title: 'Test Article',
      abstract: 'This is an abstract.',
      authors: [{ name: 'Smith J' }, { name: 'Doe A' }],
      source: 'Nature',
      pubdate: '2024 Jan 15',
    };

    const result = transformArticleResponse(input);

    expect(result).toEqual({
      pmid: '12345',
      title: 'Test Article',
      abstract: 'This is an abstract.',
      authors: ['Smith J', 'Doe A'],
      journal: 'Nature',
      publication_date: '2024 Jan 15',
    });
  });
});
