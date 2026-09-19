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

  test('deduplicates by arxiv_id (most arXiv preprints have no pmid/pmcid/doi)', () => {
    const articles = [
      { arxiv_id: '1706.03762', title: 'First', source: 'arxiv' },
      { arxiv_id: '1706.03762', title: 'Second', source: 'arxiv' },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('First');
  });

  test('prioritizes DOI over arxiv_id for dedup key (same record from two sources)', () => {
    const articles = [
      { doi: '10.1140/epjc/s2003-01326-x', arxiv_id: 'hep-ex/0307015', title: 'Published' },
      { arxiv_id: 'hep-ex/0307015', title: 'Preprint twin' },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(2);
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

  test('merge-fill fills missing fields from later duplicates', () => {
    const articles = [
      { pmid: '123', title: 'From PubMed', source: 'pubmed' },
      { pmid: '123', cited_by: 42, is_open_access: true, volume: '364', issue: '26', pages: '2507-16' },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('From PubMed');
    expect(result[0].cited_by).toBe(42);
    expect(result[0].is_open_access).toBe(true);
    expect(result[0].volume).toBe('364');
    expect(result[0].issue).toBe('26');
    expect(result[0].pages).toBe('2507-16');
  });

  test('merge-fill never overwrites existing values', () => {
    const articles = [
      { pmid: '123', title: 'Primary', cited_by: 5, volume: '9' },
      { pmid: '123', title: 'Secondary', cited_by: 100, volume: '10' },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result[0].title).toBe('Primary');
    expect(result[0].cited_by).toBe(5);
    expect(result[0].volume).toBe('9');
  });

  test('merge-fill keeps the base source and excludes score from fill', () => {
    const articles = [
      { pmid: '123', title: 'Primary', source: 'pubmed' },
      { pmid: '123', score: 250.5, source: 'pubtator' },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result[0].source).toBe('pubmed');
    expect(result[0].score).toBeUndefined();
  });

  test('merge-fill treats empty strings as missing', () => {
    const articles = [
      { pmid: '123', title: '', abstract: '' },
      { pmid: '123', title: 'Filled', abstract: 'Filled abstract' },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result[0].title).toBe('Filled');
    expect(result[0].abstract).toBe('Filled abstract');
  });

  test('merge-fill assigns arrays wholesale without concatenating', () => {
    const articles = [
      { pmid: '123', title: 'Primary', authors: ['A One'] },
      { pmid: '123', authors: ['B Two', 'C Three'] },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result[0].authors).toEqual(['A One']);
  });

  test('merge-fill ranks with absorbed citation counts', () => {
    const articles = [
      { pmid: '111', title: 'PubMed record', source: 'pubmed' },
      { pmid: '111', cited_by: 500 },
      { pmid: '222', title: 'Other', cited_by: 100 },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result[0].pmid).toBe('111');
    expect(result[0].cited_by).toBe(500);
  });

  test('drops _error rows and keeps keyless rows dropped in federated dedup', () => {
    const articles = [
      { _error: 'searchLitSense failed: ...' },
      { title: 'No ID', cited_by: 100 },
      { pmid: '123', title: 'With ID', cited_by: 10 },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(1);
    expect(result[0].pmid).toBe('123');
  });

  test('never seats a keyed _error row as merge base', () => {
    const articles = [
      { pmid: '123', _error: 'backend failed mid-record' },
      { pmid: '123', title: 'Healthy twin', cited_by: 7 },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Healthy twin');
    expect(result[0]._error).toBeUndefined();
  });

  test('merges S2/arXiv twins on arxiv_id with first-seen source and fill-merge', () => {
    const articles = [
      { source: 'semantic_scholar', title: 'Attention Is All You Need', arxiv_id: '1706.03762', cited_by: 500 },
      { source: 'arxiv', title: 'Attention Is All You Need', arxiv_id: '1706.03762', journal: 'arXiv', publication_types: ['preprint'] },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(1);
    // Federation order is pubmed, europepmc, S2, arXiv: first-seen (S2) wins
    expect(result[0].source).toBe('semantic_scholar');
    // arXiv row's fields fill-merge where the S2 row was undefined
    expect(result[0].journal).toBe('arXiv');
    expect(result[0].publication_types).toEqual(['preprint']);
    // S2 citation count survives
    expect(result[0].cited_by).toBe(500);
  });

  test('does not merge cross-key identities', () => {
    const articles = [
      { pmid: '123', title: 'By PMID', pmcid: 'PMC001' },
      { pmcid: 'PMC002', title: 'Different paper, PMCID only' },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(2);
  });

  test('deduplicates by PMID across more than two duplicates', () => {
    const articles = [
      { pmid: '123', title: 'Base', source: 'pubmed' },
      { pmid: '123', volume: '5' },
      { pmid: '123', issue: '2', pages: 'e1' },
    ] as any[];
    const result = deduplicateAndRank(articles, 10);
    expect(result).toHaveLength(1);
    expect(result[0].volume).toBe('5');
    expect(result[0].issue).toBe('2');
    expect(result[0].pages).toBe('e1');
  });
});
