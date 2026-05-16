import type { Article } from '../types.js';

export function deduplicateAndRank(articles: Article[], limit: number): Article[] {
  const seen = new Map<string, Article>();

  for (const article of articles) {
    const key = article.pmid || article.pmcid || article.doi || '';
    if (key && !seen.has(key)) {
      seen.set(key, article);
    }
  }

  const unique = Array.from(seen.values());

  return unique
    .sort((a, b) => (b.cited_by || 0) - (a.cited_by || 0))
    .slice(0, limit);
}
