import type { Article } from '../types.js';

const NO_FILL_KEYS = new Set(['source', 'score', '_error']);

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Derive canonical deduplication key for an article.
 *
 * Key chain: pmid ‖ pmcid ‖ doi (case-insensitive) ‖ arxiv_id.
 * DOIs are case-insensitive per the DOI handbook, but submitter-entered
 * metadata (e.g. arXiv) frequently uses mixed casing while registries return
 * lowercase, so DOIs are normalized to lowercase. PMID, PMCID, and arxiv_id
 * are unaffected.
 */
export function dedupKey(article: Article): string {
  return article.pmid || article.pmcid || article.doi?.toLowerCase() || article.arxiv_id || '';
}

export function deduplicateAndRank(articles: Article[], limit: number): Article[] {
  const seen = new Map<string, Article>();

  for (const article of articles) {
    if (article._error) continue;
    const key = dedupKey(article);
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
