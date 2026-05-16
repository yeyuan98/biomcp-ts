import { deduplicateAndRank } from '../../entities/article/search/dedup.js';

describe('deduplicateAndRank', () => {
  test('returns empty array for empty input', () => {
    const result = deduplicateAndRank([], 10);
    expect(result).toEqual([]);
  });

  test('returns single article unchanged', () => {
    const article = {
      pmid: '12345',
      title: 'Test Article',
      cited_by: 10,
    };
    const result = deduplicateAndRank([article as any], 10);
    expect(result).toEqual([article]);
  });

  test('deduplicates by PMID', () => {
    const articles = [
      { pmid: '12345', title: 'First', cited_by: 5 },
      { pmid: '12345', title: 'Second', cited_by: 10 },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(1);
    expect(result[0].pmid).toBe('12345');
    // First occurrence is kept (not the one with higher citations)
    expect(result[0].title).toBe('First');
  });

  test('deduplicates by PMCID', () => {
    const articles = [
      { pmcid: 'PMC12345', title: 'First', cited_by: 5 },
      { pmcid: 'PMC12345', title: 'Second', cited_by: 10 },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(1);
    expect(result[0].pmcid).toBe('PMC12345');
    expect(result[0].title).toBe('First');
  });

  test('deduplicates by DOI', () => {
    const articles = [
      { doi: '10.1234/test', title: 'First', cited_by: 5 },
      { doi: '10.1234/test', title: 'Second', cited_by: 10 },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(1);
    expect(result[0].doi).toBe('10.1234/test');
    expect(result[0].title).toBe('First');
  });

  test('prioritizes PMID over PMCID over DOI for dedup key', () => {
    const articles = [
      { pmid: '12345', pmcid: 'PMC001', doi: '10.1/a' },
      { pmid: '12345', pmcid: 'PMC002', doi: '10.1/b' },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(1);
    expect(result[0].pmid).toBe('12345');
    // First occurrence kept
    expect(result[0].pmcid).toBe('PMC001');
  });

  test('sorts by citation count descending', () => {
    const articles = [
      { pmid: '00001', title: 'Low', cited_by: 5 },
      { pmid: '00002', title: 'High', cited_by: 100 },
      { pmid: '00003', title: 'Medium', cited_by: 50 },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(3);
    expect(result[0].title).toBe('High');
    expect(result[1].title).toBe('Medium');
    expect(result[2].title).toBe('Low');
  });

  test('handles missing cited_by as zero', () => {
    const articles = [
      { pmid: '00001', title: 'With citations', cited_by: 10 },
      { pmid: '00002', title: 'Without citations' },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('With citations');
    expect(result[1].title).toBe('Without citations');
  });

  test('respects limit parameter', () => {
    const articles = Array.from({ length: 20 }, (_, i) => ({
      pmid: String(i),
      title: `Article ${i}`,
      cited_by: i,
    })) as any[];
    const result = deduplicateAndRank(articles, 5);
    expect(result).toHaveLength(5);
    // Should be top 5 by citation count (descending)
    expect(result[0].pmid).toBe('19');
    expect(result[1].pmid).toBe('18');
    expect(result[2].pmid).toBe('17');
    expect(result[3].pmid).toBe('16');
    expect(result[4].pmid).toBe('15');
  });

  test('limit larger than array returns all articles', () => {
    const articles = [
      { pmid: '00001', cited_by: 10 },
      { pmid: '00002', cited_by: 5 },
    ] as any[];
    const result = deduplicateAndRank(articles, 100);
    expect(result).toHaveLength(2);
  });

  test('handles articles with no ID (skipped in dedup)', () => {
    const articles = [
      { title: 'No ID', cited_by: 100 },
      { pmid: '12345', title: 'With ID', cited_by: 10 },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    // Article with empty key is skipped in dedup
    expect(result).toHaveLength(1);
    expect(result[0].pmid).toBe('12345');
  });

  test('complex dedup scenario with mixed IDs', () => {
    const articles = [
      { pmid: '00001', cited_by: 10 },  // Kept by PMID
      { pmid: '00001', cited_by: 20 },  // Duplicate PMID, skipped
      { pmcid: 'PMC001', cited_by: 15 }, // Kept by PMCID
      { pmcid: 'PMC001', cited_by: 25 },  // Duplicate PMCID, skipped
      { doi: '10.1/a', cited_by: 5 },   // Kept by DOI
      { doi: '10.1/a', cited_by: 30 },   // Duplicate DOI, skipped
      { pmid: '00002', cited_by: 50 },  // Kept by PMID, highest citation
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(4); // 4 unique articles
    // Sorted by citations: 00002(50) > 00001(10) > PMC001(15) > 10.1/a(5)
    // But wait, we need to check the actual sorting
    const pmids = result.map(r => r.pmid || r.pmcid || r.doi);
    expect(pmids).toContain('00002');
    expect(pmids).toContain('00001');
  });

  test('maintains article integrity after sorting', () => {
    const articles = [
      {
        pmid: '00001',
        title: 'Article 1',
        abstract: 'Abstract 1',
        authors: ['Author 1'],
        cited_by: 10,
      },
      {
        pmid: '00002',
        title: 'Article 2',
        abstract: 'Abstract 2',
        authors: ['Author 2'],
        cited_by: 20,
      },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(articles[1]);
    expect(result[1]).toEqual(articles[0]);
  });
});
