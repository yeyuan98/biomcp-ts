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

// Identity keys: EVERY id a row carries participates in matching (issue
// #134) — the old single-key chain (pmid ‖ pmcid ‖ doi ‖ arxiv_id) never
// compared two rows that each had a PMID, so same-DOI twins under distinct
// PMIDs both survived (live: 10.1056/NEJMc2400161 under PMIDs 38478005 and
// 38478006). Rows now merge when ANY key collides, and collisions chain
// transitively (A≡B by DOI, B≡C by PMID ⇒ one group) via the key→base map.
// DOIs are case-insensitive per the DOI handbook, and arXiv submitter-cased
// DOIs (e.g. 10.1109/ICASSP...) must merge with registry-cased twins — so
// only the DOI is normalized here. The stored `doi` field itself is never
// normalized: first-seen display casing survives, matching fill-merge.
// Key prefixes keep id types from colliding across namespaces.
export function dedupKeys(article: Article): string[] {
  const keys: string[] = [];
  if (article.pmid) keys.push(`pmid:${article.pmid}`);
  if (article.pmcid) keys.push(`pmcid:${article.pmcid}`);
  // Whitespace-only DOIs contribute no key (mirrors the old chain's
  // fallthrough) — a bare `doi:` would falsely merge unrelated rows.
  const doi = article.doi?.trim();
  if (doi) keys.push(`doi:${doi.toLowerCase()}`);
  if (article.arxiv_id) keys.push(`arxiv:${article.arxiv_id}`);
  return keys;
}

function fillMergeInto(base: Article, donor: Article): void {
  for (const [field, value] of Object.entries(donor)) {
    if (NO_FILL_KEYS.has(field)) continue;
    if (isMissing(base[field as keyof Article]) && !isMissing(value)) {
      (base as Record<string, unknown>)[field] = value;
    }
  }
}

export function deduplicateAndRank(articles: Article[], limit: number): Article[] {
  // key → surviving base row of its group; bases keeps first-seen order.
  const keyToBase = new Map<string, Article>();
  const bases: Article[] = [];

  for (const article of articles) {
    if (article._error) continue;
    if (!isAboveLitsenseFloor(article)) continue;
    const keys = dedupKeys(article);
    if (keys.length === 0) continue;

    // Distinct surviving bases this row collides with (any-key match).
    // Usually one; more than one means this row BRIDGES previously
    // separate groups (A keyed on DOI, B on PMID, this row carries both),
    // so the later-seen bases merge into the earliest-seen one.
    const collided: Article[] = [];
    for (const key of keys) {
      const base = keyToBase.get(key);
      if (base !== undefined && !collided.includes(base)) collided.push(base);
    }

    let base: Article;
    if (collided.length === 0) {
      base = article;
      bases.push(article);
    } else {
      base = collided.reduce((earliest, candidate) =>
        bases.indexOf(candidate) < bases.indexOf(earliest) ? candidate : earliest
      );
      for (const other of collided) {
        if (other === base) continue;
        fillMergeInto(base, other);
        for (const [key, owner] of keyToBase) {
          if (owner === other) keyToBase.set(key, base);
        }
        bases.splice(bases.indexOf(other), 1);
      }
      fillMergeInto(base, article);
    }
    for (const key of keys) keyToBase.set(key, base);
  }

  return bases
    .sort((a, b) => (b.cited_by || 0) - (a.cited_by || 0))
    .slice(0, limit);
}
