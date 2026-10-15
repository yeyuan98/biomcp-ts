import type { Article } from '../types.js';

/**
 * LitSense relevance floor. LitSense is a sentence-similarity API that
 * ALWAYS answers — for nonsense/off-topic queries it still returns its
 * nearest sentences, at live-measured similarity scores of ~0.39-0.55
 * (noise floor), while meaningful matches score > 0.6 (live-verified:
 * topical BRCA1 queries return 1.0, a pure-gibberish query returned
 * 0.516). Rows below this floor are dropped so federated ranking never
 * seats gibberish-adjacent sentences (issue #78).
 */
export const LITSENSE_RELEVANCE_FLOOR = 0.6;

/** True when a LitSense row clears the relevance floor (scoreless rows pass). */
export function isAboveLitsenseFloor(article: Article): boolean {
  return article.source !== 'litsense' || typeof article.score !== 'number' || article.score >= LITSENSE_RELEVANCE_FLOOR;
}

const NO_FILL_KEYS = new Set(['source', 'score', 'sentence', 'section', '_error']);

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

// Key chain: pmid ‖ pmcid ‖ doi ‖ arxiv_id — most arXiv preprints carry
// none of the first three, so arxiv_id keeps them deduplicable.
// DOIs are case-insensitive per the DOI handbook, and arXiv submitter-cased
// DOIs (e.g. 10.1109/ICASSP...) must merge with registry-cased twins — so
// only the DOI is lowercased here. The stored `doi` field itself is never
// normalized: first-seen display casing survives, matching fill-merge.
function dedupKey(article: Article): string {
  return (
    article.pmid ||
    article.pmcid ||
    (article.doi ? article.doi.trim().toLowerCase() : '') ||
    article.arxiv_id ||
    ''
  );
}

export function deduplicateAndRank(articles: Article[], limit: number): Article[] {
  const seen = new Map<string, Article>();

  for (const article of articles) {
    if (article._error) continue;
    if (!isAboveLitsenseFloor(article)) continue;
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
