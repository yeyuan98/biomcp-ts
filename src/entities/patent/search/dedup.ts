import type { PatentSearchResult, PatentSource, PatentStatus } from '../types.js';

const GRANTED_KIND_CHARS = new Set(['B', 'C', 'E', 'P', 'H', 'S', 'T']);

/**
 * Kind-code → status heuristic shared by all backends (B/C grants, E/P/H/S/T
 * US special series; A and everything else = application).
 */
export function kindToStatus(kind: string | undefined): PatentStatus {
  if (!kind) return 'application';
  return GRANTED_KIND_CHARS.has(kind[0].toUpperCase()) ? 'granted' : 'application';
}

/**
 * Normalize a publication number: uppercase, strip spaces and slashes.
 * Accepts forms like `US 11027025 B2`, `us11027025b2`, `WO 2015/006747 A2`.
 */
export function normalizePublicationNumber(input: string): string {
  return input.replace(/[\s/]+/g, '').toUpperCase();
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
 * Canonical dedup key: country + optional series letters + digit core, kind
 * code and leading zeros stripped, so `US11027025` (ODP), `US01234567`
 * (ODP-padded), and `US11027025B2` (PPUBS/GP) merge into one record.
 */
function dedupKey(publicationNumber: string): string {
  const normalized = normalizePublicationNumber(publicationNumber);
  const match = normalized.match(/^([A-Z]{2}(?:RE|PP|[A-Z])?)0*(\d+)/);
  if (!match) return normalized;
  return `${match[1]}${match[2]}`;
}

/**
 * Deduplicate federated results by normalized publication number, capped at
 * `limit` records. For US numbers the fresher official records (ODP/PPUBS)
 * win; unique fields from the other source are merged in.
 */
export function dedupPatents(patents: PatentSearchResult[], limit?: number): PatentSearchResult[] {
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

  const deduped = order.map(k => byNumber.get(k)!);
  return limit !== undefined ? deduped.slice(0, limit) : deduped;
}
