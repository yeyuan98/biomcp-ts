import { ppubsClient } from '../ppubs-client.js';
import { hasOpsCredentials, opsClient } from '../ops-client.js';
import { kindToStatus } from './dedup.js';
import type { PatentSearchResult, PatentSeminalEntry } from '../types.js';

const MINING_POOL_PAGECOUNT = 100;
const MINING_DOC_COUNT = 10;
const MAX_DOCS_PER_ASSIGNEE = 2;
const MIN_GRANTS = 3;
const MAX_ENTRIES = 5;
const RESOLVE_TOP_N = 3;
const RESOLUTION_MIN_REMAINING_MS = 3_000;

/**
 * Overall budget for the whole seminal phase (mining + resolution),
 * independent of (and under) the tool-level timeout — a mining blowup must
 * degrade to a note, never destroy the main search results. Mining alone
 * paces ~10s (1 req/s limiter over 9 calls); OPS/GP resolution needs ~3-6s
 * more, so 20s leaves margin under the 30s tool timeout.
 */
export const SEMINAL_DEADLINE_MS = 20_000;

const KEYLESS_RESOLUTION_NOTE =
  'PCT publication; national-phase equivalents (e.g. US grants) could not be resolved automatically. ' +
  'Try patent_get with "family", patent_search on the inventor name, or search this number externally.';

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
    await enrichFromOpsBiblio(entry, chosen.pub);
    return;
  }
}

async function enrichFromOpsBiblio(entry: PatentSeminalEntry, pub: string): Promise<void> {
  try {
    const { fetchOpsBiblio } = await import('../detail/ops.js');
    const biblio = await fetchOpsBiblio(pub);
    if (biblio.title) entry.title = biblio.title;
    if (biblio.assignee && biblio.assignee.length > 0) entry.assignee = biblio.assignee[0];
  } catch {
    // title/assignee are best-effort enrichments
  }
}

function pickGrantedUsMember(familyMembers: string[]): string | undefined {
  const usMembers = familyMembers.filter(m => /^US[A-Z]{0,2}\d+/i.test(m));
  const kindOf = (pub: string) => pub.match(/([A-Z]\d?)$/)?.[1] || '';
  const granted = usMembers.filter(m => kindToStatus(kindOf(m)) === 'granted');
  return granted[0] || usMembers[0];
}

function kindlessPublicationNumber(pub: string): string {
  // strip trailing kind code (letter + optional digit): US6261804B1 → US6261804
  return pub.toUpperCase().replace(/([A-Z]\d?)$/, '');
}

/**
 * Keyless WO→US resolution via Google Patents detail pages: the PCT page's
 * "Also Published As" (docdbFamily) carries the US national-phase members
 * and the page itself has title + assignee. Depends on Google Patents /
 * Wayback reachability (proxy-aware fetch).
 *
 * Robustness (verified live): kindless WO URLs (`/patent/WO1998056915/en`)
 * sometimes redirect to UNRELATED documents, and Google aggressively
 * 503-blocks detail pages on shared proxy exit IPs. Therefore: (1) try
 * PCT-kind variants (A1, then A2, then kindless); (2) require the fetched
 * page to identify as the requested publication (or list it as a family
 * member) — a mismatched page is rejected, keeping the entry in WO form
 * with an actionable note instead of poisoning it with wrong data.
 */
async function resolveEntryViaGooglePatents(
  entry: PatentSeminalEntry,
  canonical: RefCanonical,
  visibleKeys: Set<string>,
): Promise<void> {
  if (canonical.country !== 'WO' || canonical.year === undefined) return;
  const base = `WO${canonical.year}${canonical.serial.padStart(6, '0')}`;
  const { fetchGooglePatentDetail } = await import('../detail/google-patents.js');
  for (const pn of [`${base}A1`, `${base}A2`, base]) {
    let parsed;
    try {
      parsed = await fetchGooglePatentDetail(pn);
    } catch {
      continue; // blocked/unavailable — try next variant
    }
    const pageIds = new Set<string>([kindlessPublicationNumber(parsed.publication_number || '')]);
    const normalizedFamily = (parsed.family_members || []).map(kindlessPublicationNumber);
    for (const m of normalizedFamily) pageIds.add(m);
    if (!pageIds.has(base)) continue; // page is a different document — reject
    const usMember = pickGrantedUsMember(parsed.family_members);
    const usKey = usMember ? parsePatentRef(usMember) : undefined;
    if (usMember && usKey && visibleKeys.has(refKey(usKey))) return; // already on the visible page
    if (usMember) {
      entry.publication_number = usMember;
      entry.note = `US family member of ${displayNumber(canonical)} (the co-cited PCT form), resolved via Google Patents.`;
    } else {
      entry.note = `${displayNumber(canonical)} (PCT publication; no US family member listed on Google Patents).`;
    }
    if (parsed.title) entry.title = parsed.title;
    if (parsed.assignee && parsed.assignee.length > 0) entry.assignee = parsed.assignee[0];
    return;
  }
}

// ---------- co-citation mining ----------

interface PpubsPoolRecord {
  guid?: string;
  type?: string;
  assigneeName?: string[] | null;
  applicantName?: string[] | null;
}

interface PpubsDocRecord {
  usRefPatentNumber?: string[] | null;
  foreignRefPatentNumber?: string[] | null;
}

interface Candidate {
  canonical: RefCanonical;
  citedBy: Set<string>;
  citedByAssignees: Set<string>;
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
 * Diversity sampling: at most MAX_DOCS_PER_ASSIGNEE granted docs per
 * assignee. Verified live: without this, one patent family's 4+ top hits
 * dominate the first 8 grants and their block-cited reference blob (30+
 * refs at count 3 within ONE family) drowns the true foundational art,
 * which is cited once per family but ACROSS many families (the Szostak
 * mRNA-display PCT WO98/31700: count 2/8 under naive top-8, but count 4
 * across 3 distinct assignees under diversity sampling — rank #1).
 */
function sampleDiverseGrants(pool: PpubsPoolRecord[], maxDocs: number): PpubsPoolRecord[] {
  const grants = pool.filter(r => r.guid && r.type === 'USPAT');
  // Defensive: if the pool carries NO assignee metadata at all (not expected
  // — live ppubs records include assigneeName), the per-assignee cap would
  // collapse everything into one 'unknown' bucket; fall back to naive top-N.
  const anyAssignee = grants.some(r => r.assigneeName?.find(Boolean) || r.applicantName?.find(Boolean));
  if (!anyAssignee) return grants.slice(0, maxDocs);
  const perAssignee = new Map<string, number>();
  const sampled: PpubsPoolRecord[] = [];
  for (const r of grants) {
    const assignee = (r.assigneeName?.find(Boolean) || r.applicantName?.find(Boolean) || 'unknown')
      .toLowerCase().slice(0, 40);
    const n = perAssignee.get(assignee) || 0;
    if (n >= MAX_DOCS_PER_ASSIGNEE) continue;
    perAssignee.set(assignee, n + 1);
    sampled.push(r);
    if (sampled.length >= maxDocs) break;
  }
  return sampled;
}

function assigneeOf(record: PpubsPoolRecord): string {
  return (record.assigneeName?.find(Boolean) || record.applicantName?.find(Boolean) || 'unknown')
    .toLowerCase().slice(0, 40);
}

/**
 * Co-citation mining for foundational prior art: references cited by many
 * of the top granted results are seminal to the query concept even when
 * their own vocabulary predates it (verified: the Szostak mRNA-display
 * patent family never says "mRNA display"). Runs its own PPUBS relevance
 * search (pageCount 100 — the score-desc batch scales with pageCount),
 * diversity-samples granted docs (max 2 per assignee), fetches their
 * backward references concurrently (the client rate limiter paces them),
 * and surfaces references cited by >= 3 sampled docs from >= 2 distinct
 * assignees — cross-assignee co-citation, which suppresses single-family
 * block-citation blobs. WO candidates resolve to US family members via
 * EPO OPS (creds) or Google Patents (keyless). The entire phase is
 * deadline-bounded and failure-tolerant.
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
  const grants = sampleDiverseGrants(pool, MINING_DOC_COUNT);
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
    const docAssignee = assigneeOf(grants[i]);
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
        cand = { canonical, citedBy: new Set(), citedByAssignees: new Set() };
        counts.set(key, cand);
      }
      cand.citedBy.add(docId);
      cand.citedByAssignees.add(docAssignee);
    }
  });

  if (mined < MIN_GRANTS) {
    return { entries: [], mined, note: 'too few granted documents yielded reference data' };
  }

  // Cross-assignee co-citation: >= 3 citing docs AND >= 2 distinct assignees
  // (a single family block-citing 30 refs never qualifies). Rank by
  // distinct-assignee breadth first, then raw count.
  const top = Array.from(counts.values())
    .filter(c => c.citedBy.size >= 3 && c.citedByAssignees.size >= 2)
    .sort((a, b) => b.citedByAssignees.size - a.citedByAssignees.size || b.citedBy.size - a.citedBy.size)
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
  // Keyless fallback (and OPS-miss fallback): Google Patents detail pages
  // carry the US family members plus title/assignee. Only entries still in
  // WO display form are attempted.
  if (timeLeft() > RESOLUTION_MIN_REMAINING_MS) {
    const unresolved = pairs
      .slice(0, RESOLVE_TOP_N)
      .filter(p => p.canonical.country === 'WO' && p.entry.publication_number.startsWith('WO'));
    if (unresolved.length > 0) {
      try {
        await Promise.race([
          Promise.all(unresolved.map(p => resolveEntryViaGooglePatents(p.entry, p.canonical, visibleKeys))),
          timeoutReject(timeLeft()),
        ]);
      } catch {
        // keep WO display form + actionable note
      }
    }
  }

  return { entries: pairs.map(p => p.entry), mined };
}
