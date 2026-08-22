import type { PatentSearchResult, PatentSource } from '../types.js';

/**
 * Normalize a publication number: uppercase, strip spaces.
 * Accepts forms like `US 11027025 B2`, `us11027025b2`, `US11027025`.
 */
export function normalizePublicationNumber(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

const PUBLICATION_NUMBER_RE = /^[A-Z]{2}(RE|PP|H)?\d{5,}[A-Z]?\d{0,2}$/;

export function isValidPublicationNumber(input: string): boolean {
  return PUBLICATION_NUMBER_RE.test(normalizePublicationNumber(input));
}

const SOURCE_RANK: Record<PatentSource, number> = {
  uspto_odp: 3,
  ppubs: 2,
  ops: 2,
  google_patents: 1,
};

function mergeRecords(primary: PatentSearchResult, secondary: PatentSearchResult): PatentSearchResult {
  const merged: PatentSearchResult = { ...primary };
  const also = new Set<PatentSource>(primary.also_found_in || []);
  also.add(secondary.source);
  merged.also_found_in = Array.from(also);

  for (const [key, value] of Object.entries(secondary)) {
    if (key === 'source' || key === 'also_found_in') continue;
    const mergedRecord = merged as unknown as Record<string, unknown>;
    const current = mergedRecord[key];
    if (current === undefined || current === null || current === '' ||
        (Array.isArray(current) && current.length === 0)) {
      if (value !== undefined && value !== null && value !== '' &&
          !(Array.isArray(value) && value.length === 0)) {
        mergedRecord[key] = value;
      }
    }
  }
  return merged;
}

/**
 * Canonical dedup key: country + number core, kind code stripped, so the same
 * publication reported as `US11027025` (ODP) and `US11027025B2` (PPUBS/GP)
 * merges into one record.
 */
function dedupKey(publicationNumber: string): string {
  const normalized = normalizePublicationNumber(publicationNumber);
  const match = normalized.match(/^([A-Z]{2}(?:RE|PP|H)?\d+)/);
  return match ? match[1] : normalized;
}

/**
 * Deduplicate federated results by normalized publication number. For US
 * numbers the fresher official records (ODP/PPUBS) win; unique fields from
 * the other source are merged in.
 */
export function dedupPatents(patents: PatentSearchResult[]): PatentSearchResult[] {
  const byNumber = new Map<string, PatentSearchResult>();
  const order: string[] = [];

  for (const p of patents) {
    const key = dedupKey(p.publication_number);
    if (!key) continue;
    const existing = byNumber.get(key);
    if (!existing) {
      byNumber.set(key, p);
      order.push(key);
    } else {
      const existingRank = SOURCE_RANK[existing.source] ?? 0;
      const incomingRank = SOURCE_RANK[p.source] ?? 0;
      byNumber.set(key, incomingRank > existingRank ? mergeRecords(p, existing) : mergeRecords(existing, p));
    }
  }

  return order.map(k => byNumber.get(k)!);
}
