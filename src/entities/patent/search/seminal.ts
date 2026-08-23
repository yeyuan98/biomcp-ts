import { ppubsClient } from '../ppubs-client.js';
import { hasOpsCredentials, opsClient } from '../ops-client.js';
import { kindToStatus } from './dedup.js';
import type { PatentSearchResult, PatentSeminalEntry } from '../types.js';

const MINING_POOL_PAGECOUNT = 100;
const MINING_DOC_COUNT = 8;
const MIN_GRANTS = 3;
const MAX_ENTRIES = 5;
const RESOLVE_TOP_N = 3;
const RESOLUTION_MIN_REMAINING_MS = 3_000;

/**
 * Overall budget for the whole seminal phase, independent of (and well
 * under) the tool-level timeout — a mining blowup must degrade to a note,
 * never destroy the main search results.
 */
export const SEMINAL_DEADLINE_MS = 12_000;

const KEYLESS_RESOLUTION_NOTE =
  'PCT publication; national-phase equivalents (e.g. US grants) exist — resolve via patent_get "family" ' +
  'when EPO OPS credentials are configured, or search this number externally.';

// ---------- reference canonicalization ----------

export interface RefCanonical {
  country: string;
  year?: number;
  serial: string;
}

/** WO PCT publications began 1978 — 2-digit years >= 78 are 19xx, else 20xx. */
function expandYear(yy: number): number {
  return yy >= 78 ? 1900 + yy : 2000 + yy;
}

export function refKey(c: RefCanonical): string {
  return c.year !== undefined ? `${c.country}:${c.year}:${c.serial}` : `${c.country}:${c.serial}`;
}

function splitDigits(country: string, digits: string): RefCanonical | null {
  if (!/^\d+$/.test(digits) || digits.length === 0) return null;
  if (country === 'WO') {
    if (digits.length >= 9) {
      const year = Number(digits.slice(0, 4));
      const serial = digits.slice(4).replace(/^0+/, '');
      if (year >= 1978 && serial) return { country, year, serial };
    }
    if (digits.length === 7 || digits.length === 8) {
      const yy = Number(digits.slice(0, 2));
      const serial = digits.slice(2).replace(/^0+/, '');
      if (serial) return { country, year: expandYear(yy), serial };
    }
    const serial = digits.replace(/^0+/, '');
    return serial ? { country, serial } : null;
  }
  const serial = digits.replace(/^0+/, '');
  return serial ? { country, serial } : null;
}

/**
 * Canonicalize a cited reference (or publication number) to
 * {country, year?, serial}. Verified against real PPUBS reference strings:
 * 'WO98/56915', '9856915' (bare, foreign list), 'WO-2014180569',
 * '2015/103037', '2019/060835', '90/02809', '2001/64942', 'WO2008/031098',
 * 'WO02/32925', 'US5034506', '5,034,506'. Bare/slash numbers are PCT (WO)
 * forms on the foreign list and US numbers on the US list — the lists are
 * disjoint, so a bare number never merges across countries.
 */
export function parsePatentRef(raw: string, origin: 'us' | 'foreign' = 'foreign'): RefCanonical | null {
  const s = raw.toUpperCase().replace(/[\s,.\-]/g, '');
  if (!s || !/^([A-Z]{2})?[\d/]/.test(s)) return null;
  const tagged = s.match(/^([A-Z]{2})\/?(\d{2,4})?\/?(\d{1,8})(?:[A-Z]\d?)?$/);
  if (tagged) {
    const rest = [tagged[2], tagged[3]].filter(Boolean).join('');
    return splitDigits(tagged[1], rest);
  }
  if (/^\d/.test(s)) {
    return splitDigits(origin === 'us' ? 'US' : 'WO', s.replace(/\//g, ''));
  }
  return null;
}

function displayNumber(c: RefCanonical): string {
  if (c.country === 'WO' && c.year !== undefined) return `WO${c.year}/${c.serial.padStart(6, '0')}`;
  return `${c.country}${c.serial}`;
}

// ---------- EPO OPS family resolution (US equivalents of WO refs) ----------

interface BadgerFish {
  [key: string]: unknown;
}

function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function textOf(x: unknown): string | undefined {
  if (x && typeof x === 'object' && '$' in (x as Record<string, unknown>)) {
    return String((x as Record<string, unknown>)['$']);
  }
  return typeof x === 'string' ? x : undefined;
}

interface FamilyMember {
  pub: string;
  date?: string;
  granted: boolean;
}

/**
 * Fetch the INPADOC family of a publication, keeping member dates (the
 * shared fetchOpsFamily discards them). Returns [] on any failure so the
 * caller can fall back to the unresolved WO display form.
 */
async function fetchFamilyMembers(pn: string): Promise<FamilyMember[]> {
  const resp = await opsClient.get(`/family/publication/epodoc/${pn}`);
  if (resp.status !== 200) return [];
  let parsed: BadgerFish;
  try {
    parsed = JSON.parse(resp.body);
  } catch {
    return [];
  }
  const world = (parsed['ops:world-patent-data'] || {}) as BadgerFish;
  const family = (world['ops:patent-family'] || {}) as BadgerFish;
  const members: FamilyMember[] = [];
  for (const member of asArray(family['ops:family-member'] as BadgerFish[])) {
    for (const ref of asArray((member['publication-reference'] as BadgerFish)?.['document-id'] as BadgerFish[])) {
      if (ref['@document-id-type'] !== 'docdb') continue;
      const country = textOf(ref['country']) || '';
      const docNumber = textOf(ref['doc-number']) || '';
      const kind = textOf(ref['kind']) || '';
      const date = textOf(ref['date']);
      if (country && docNumber) {
        members.push({ pub: `${country}${docNumber}${kind}`, date, granted: kindToStatus(kind) === 'granted' });
      }
    }
  }
  return members;
}

async function fetchTitle(pub: string): Promise<string | undefined> {
  try {
    const { fetchOpsBiblio } = await import('../detail/ops.js');
    const biblio = await fetchOpsBiblio(pub);
    return biblio.title || undefined;
  } catch {
    return undefined;
  }
}

async function resolveEntryUsEquivalent(
  entry: PatentSeminalEntry,
  canonical: RefCanonical,
  visibleKeys: Set<string>,
): Promise<void> {
  if (canonical.country !== 'WO' || canonical.year === undefined) return;
  // epodoc forms: classic 2-digit-year first, padded 4-digit-year fallback.
  const attempts = [
    `WO${String(canonical.year).slice(2)}${canonical.serial}`,
    `WO${canonical.year}${canonical.serial.padStart(6, '0')}`,
  ];
  for (const pn of attempts) {
    const members = await fetchFamilyMembers(pn);
    const usMembers = members.filter(m => m.pub.startsWith('US'));
    if (usMembers.length === 0) continue;
    const byDate = (a: FamilyMember, b: FamilyMember) => (a.date || '9999').localeCompare(b.date || '9999');
    const chosen = usMembers.filter(m => m.granted).sort(byDate)[0]
      || usMembers.slice().sort(byDate)[0];
    const chosenKey = parsePatentRef(chosen.pub);
    if (chosenKey && visibleKeys.has(refKey(chosenKey))) return; // already on the visible page
    entry.publication_number = chosen.pub;
    entry.note = `US family member of ${displayNumber(canonical)} (the co-cited PCT form).`;
    entry.title = await fetchTitle(chosen.pub);
    return;
  }
}

// ---------- co-citation mining ----------

interface PpubsPoolRecord {
  guid?: string;
  type?: string;
}

interface PpubsDocRecord {
  usRefPatentNumber?: string[] | null;
  foreignRefPatentNumber?: string[] | null;
}

interface Candidate {
  canonical: RefCanonical;
  citedBy: Set<string>;
}

function timeoutReject(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('seminal mining deadline exceeded')), Math.max(ms, 0));
    // Don't hold the event loop after the raced promise wins (script/CLI use).
    (timer as { unref?: () => void }).unref?.();
  });
}

export interface SeminalOutcome {
  entries: PatentSeminalEntry[];
  mined: number;
  note?: string;
}

/**
 * Co-citation mining for foundational prior art: references cited by many
 * of the top granted results are seminal to the query concept even when
 * their own vocabulary predates it (verified: US6261804B1, the Szostak
 * mRNA-display patent, never says "mRNA display" but is cited as
 * WO98/56915 by the top hits). Runs its own PPUBS relevance search
 * (pageCount 100 — the score-desc batch scales with pageCount), fetches
 * backward references of the first MINING_DOC_COUNT granted docs
 * concurrently (the client rate limiter paces them), and optionally
 * resolves WO candidates to US family members via EPO OPS. The entire
 * phase is deadline-bounded and failure-tolerant.
 */
export async function mineSeminalPriorArt(
  query: string,
  visibleResults: PatentSearchResult[],
): Promise<SeminalOutcome> {
  const deadline = Date.now() + SEMINAL_DEADLINE_MS;
  const timeLeft = () => deadline - Date.now();

  const visibleKeys = new Set(
    visibleResults
      .filter(p => p.publication_number && !p._error && !p._note && !p._hint)
      .map(p => parsePatentRef(p.publication_number))
      .filter((c): c is RefCanonical => c !== null)
      .map(refKey),
  );

  const poolResp = await Promise.race([
    ppubsClient.search(query, { start: 0, pageCount: MINING_POOL_PAGECOUNT, sort: 'score desc' }),
    timeoutReject(timeLeft()),
  ]);
  if (poolResp.status !== 200) {
    throw new Error(`PPUBS mining-pool search failed: HTTP ${poolResp.status}`);
  }
  let pool: PpubsPoolRecord[];
  try {
    pool = JSON.parse(poolResp.body).patents || [];
  } catch {
    throw new Error('PPUBS mining-pool search returned malformed JSON.');
  }
  const grants = pool.filter(r => r.guid && r.type === 'USPAT').slice(0, MINING_DOC_COUNT);
  if (grants.length < MIN_GRANTS) {
    return { entries: [], mined: grants.length, note: 'too few granted documents in the top results to mine reliably' };
  }

  const settledDocs = await Promise.race([
    Promise.allSettled(grants.map(g => ppubsClient.getDocument(g.guid!, g.type!))),
    timeoutReject(timeLeft()),
  ]);

  const counts = new Map<string, Candidate>();
  let mined = 0;
  settledDocs.forEach((res, i) => {
    if (res.status !== 'fulfilled' || res.value.status !== 200) return;
    let doc: PpubsDocRecord;
    try {
      doc = JSON.parse(res.value.body);
    } catch {
      return;
    }
    mined++;
    const docId = grants[i].guid!.replace(/-/g, '');
    const refs = new Map<string, RefCanonical>();
    for (const raw of doc.usRefPatentNumber || []) {
      const c = parsePatentRef(raw, 'us');
      if (c) refs.set(refKey(c), c);
    }
    for (const raw of doc.foreignRefPatentNumber || []) {
      const c = parsePatentRef(raw, 'foreign');
      if (c) refs.set(refKey(c), c);
    }
    for (const [key, canonical] of refs) {
      if (visibleKeys.has(key)) continue;
      let cand = counts.get(key);
      if (!cand) {
        cand = { canonical, citedBy: new Set() };
        counts.set(key, cand);
      }
      cand.citedBy.add(docId);
    }
  });

  if (mined < MIN_GRANTS) {
    return { entries: [], mined, note: 'too few granted documents yielded reference data' };
  }

  const threshold = Math.max(3, Math.ceil(0.4 * mined));
  const top = Array.from(counts.values())
    .filter(c => c.citedBy.size >= threshold)
    .sort((a, b) => b.citedBy.size - a.citedBy.size)
    .slice(0, MAX_ENTRIES);
  if (top.length === 0) {
    return { entries: [], mined, note: 'no commonly-cited reference found — the query may be too broad; try quoting an exact concept phrase' };
  }

  const pairs = top.map(c => ({
    canonical: c.canonical,
    entry: {
      publication_number: displayNumber(c.canonical),
      co_cited_by: c.citedBy.size,
      cited_by: Array.from(c.citedBy),
      note: c.canonical.country === 'WO' ? KEYLESS_RESOLUTION_NOTE : undefined,
    } as PatentSeminalEntry,
  }));

  if (hasOpsCredentials() && timeLeft() > RESOLUTION_MIN_REMAINING_MS) {
    try {
      await Promise.race([
        Promise.all(pairs.slice(0, RESOLVE_TOP_N).map(p => resolveEntryUsEquivalent(p.entry, p.canonical, visibleKeys))),
        timeoutReject(timeLeft()),
      ]);
    } catch {
      // keep unresolved WO display forms
    }
  }

  return { entries: pairs.map(p => p.entry), mined };
}
