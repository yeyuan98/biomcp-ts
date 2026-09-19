import type { Article } from '../types.js';

const NO_FILL_KEYS = new Set(['source', 'score', '_error']);

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export function deduplicateAndRank(articles: Article[], limit: number): Article[] {
  const seen = new Map<string, Article>();

  for (const article of articles) {
    if (article._error) continue;
    // Key chain: pmid ‖ pmcid ‖ doi ‖ arxiv_id — most arXiv preprints carry
    // none of the first three, so arxiv_id keeps them deduplicable.
    const key = article.pmid || article.pmcid || article.doi || article.arxiv_id || '';
    if (!key) continue;
    const base = seen.get(key);
    if (!base) {
      seen.set(key, article);
      continue;
    }
    for (const [field, value] of Object.entries(article)) {
      if (NO_FILL_KEYS.has(field)) continue;
      if (isMissing(base[field as keyof Article]) && !isMissing(value)) {
        (base as Record<string, unknown>)[field] = value;
      }
    }
  }

  const unique = Array.from(seen.values());

  return unique
    .sort((a, b) => (b.cited_by || 0) - (a.cited_by || 0))
    .slice(0, limit);
}
