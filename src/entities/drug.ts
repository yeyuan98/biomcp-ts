import { connectionManager } from '../connections/manager.js';
import { fetchWithTimeout } from '../connections/fetch-utils.js';
import { HttpConnectionError } from '../connections/errors.js';
import { monotonicNowMs } from '../connections/time.js';
// Circular with cross-entity.ts (which imports drug helpers back): both
// sides only reference function declarations at call time, never during
// module evaluation, so the cycle is safe in ESM and CJS alike.
import { clinicalStageRank } from './cross-entity.js';

const SECTION_TIMEOUT_MS = 8000;

/**
 * Sections fetched for `drug_get sections:['all']`. Single source of truth —
 * the tool layer's limit-slicing list must stay identical to this.
 */
export const DRUG_ENTITY_ALL_SECTIONS = [
  'us_regulatory', 'who_regulatory', 'safety', 'targets', 'indications', 'adverse_events',
] as const;

export interface DrugSearchOptions {
  limit?: number;
  offset?: number;
}

export interface DrugSearchResult {
  name: string;
  chembl_id?: string;
  inchi_key?: string;
  synonyms?: string[];
  molecular_formula?: string;
  molecular_weight?: number;
  chebi_id?: string;
  unii?: string;
  cas?: string;
}

export interface DrugResult {
  name: string;
  chembl_id?: string;
  aliases?: string[];
  cas?: string;
  molecular_formula?: string;
  molecular_weight?: number;
  smiles?: string;
  inchi?: string;
  inchi_key?: string;
  /**
   * Raw ChEBI preferred label, exposed verbatim whenever ChEBI provides
   * one — even when it equals `name`. ChEBI labels some molecules with a
   * fully systematic (IUPAC-style) name instead of a common drug name
   * (tetrabenazine), so `drug_get` keeps such strings out of `name` and
   * surfaces them here instead.
   */
  iupac?: string;
  sections?: Record<string, unknown>;
}

export interface DrugSearchResult extends DrugResult {
  _score?: number;
}

/**
 * Trailing salt/counterion tokens stripped when computing a drug identity key.
 * Matched case-insensitively as whole whitespace-delimited words at the END of
 * the name only (never as substrings), and stripped iteratively so stacked
 * salt tokens ("drug sodium phosphate") reduce fully to the base name.
 */
const SALT_SUFFIX_TOKENS: ReadonlySet<string> = new Set([
  'mesylate',
  'methanesulfonate',
  'fumarate',
  'tosylate',
  'hydrochloride',
  'hcl',
  'sulfate',
  'sodium',
  'phosphate',
  'citrate',
  'tartrate',
  'maleate',
  'succinate',
  'acetate',
  'besylate',
]);

/**
 * Strip trailing whole-word salt/counterion tokens from a drug name
 * (case-insensitive, iterated). At least one token is always kept — a name
 * made solely of salt tokens is never reduced to an empty string.
 */
function stripSaltSuffixTokens(name: string): string {
  const tokens = name.trim().split(/\s+/);
  while (tokens.length > 1 && SALT_SUFFIX_TOKENS.has(tokens[tokens.length - 1]!.toLowerCase())) {
    tokens.pop();
  }
  return tokens.join(' ');
}

/**
 * Stable identity key for a drug row: ChEMBL id if present, else InChIKey,
 * else the case-normalized, salt-stripped name. Rows sharing a key are the
 * same chemical entity for dedup purposes — case variants and salt/ester
 * forms of one base name collapse onto a single key, while two different
 * ChEMBL ids never do. Exported for reuse by the cross-entity layer.
 */
export function drugIdentityKey(
  drug: { name?: string; chembl_id?: string; inchi_key?: string }
): string {
  const chemblId = drug.chembl_id?.trim().toLowerCase();
  if (chemblId) return chemblId;
  const inchiKey = drug.inchi_key?.trim().toUpperCase();
  if (inchiKey) return inchiKey;
  return stripSaltSuffixTokens((drug.name ?? '').trim().toLowerCase());
}

function countNonEmptyDrugFields(drug: DrugSearchResult): number {
  let count = 0;
  if (drug.chembl_id) count++;
  if (drug.inchi_key) count++;
  if (drug.chebi_id) count++;
  if (drug.unii) count++;
  if (drug.cas) count++;
  if (drug.molecular_formula) count++;
  if (drug.molecular_weight !== undefined) count++;
  if (drug.synonyms && drug.synonyms.length > 0) count++;
  return count;
}

/**
 * Pick the row with the richest identity to survive a collapse: ChEMBL id
 * present, then InChIKey present, then more populated fields; deterministic
 * tie-breaks (shorter name, then lexicographic order) keep tests stable.
 */
function preferRicherDrugRow(a: DrugSearchResult, b: DrugSearchResult): DrugSearchResult {
  const idRank = (d: DrugSearchResult) => (d.chembl_id ? 2 : 0) + (d.inchi_key ? 1 : 0);
  const rankA = idRank(a);
  const rankB = idRank(b);
  if (rankA !== rankB) return rankA > rankB ? a : b;
  const fieldsA = countNonEmptyDrugFields(a);
  const fieldsB = countNonEmptyDrugFields(b);
  if (fieldsA !== fieldsB) return fieldsA > fieldsB ? a : b;
  if (a.name.length !== b.name.length) return a.name.length < b.name.length ? a : b;
  return a.name <= b.name ? a : b;
}

/** True when the row carries no chemical-identity id at all (name-keyed only). */
function isIdLessDrugRow(row: DrugSearchResult): boolean {
  return !row.chembl_id && !row.inchi_key;
}

/**
 * Normalize and deduplicate drug search rows: drop rows whose name is empty
 * or whitespace (e.g. MyChem records whose only annotation is an FDA orphan
 * designation without a generic name), then collapse case variants and
 * salt/ester forms onto a single row keyed by {@link drugIdentityKey},
 * keeping the record with the richest identity. A second merge pass (issue
 * #83) then absorbs identifier-less rows into an id-bearing row when their
 * salt-stripped lowercase names match — e.g. a sparse "Imatinib Mesylate"
 * row with no ids next to the CHEMBL941/CHEMBL1642 rows is a duplicate of
 * the same chemical identity, but its name-only key could never collide with
 * an id key, so it previously survived as a third, useless row. Never
 * refetches to refill a limit — returning fewer rows than requested is
 * accepted. Exported for reuse by the cross-entity layer.
 */
export function collapseSaltVariants(rows: DrugSearchResult[]): DrugSearchResult[] {
  const byKey = new Map<string, DrugSearchResult>();
  for (const row of rows) {
    if (!row.name || !row.name.trim()) continue;
    const key = drugIdentityKey(row);
    const existing = byKey.get(key);
    byKey.set(key, existing ? preferRicherDrugRow(existing, row) : row);
  }

  // Second pass: an id-less row whose salt-stripped name matches an
  // id-bearing row's is the same chemical entity — merge it in (absorbing
  // any fields the id-bearing row lacks) instead of keeping a sparse
  // duplicate. Id-less rows with no id-bearing namesake survive untouched.
  const keyed = [...byKey.values()];
  const idBearingByName = new Map<string, DrugSearchResult>();
  for (const row of keyed) {
    if (isIdLessDrugRow(row)) continue;
    const nameKey = stripSaltSuffixTokens(row.name.trim().toLowerCase());
    if (!idBearingByName.has(nameKey)) idBearingByName.set(nameKey, row);
  }
  return keyed.filter(row => {
    if (!isIdLessDrugRow(row)) return true;
    const nameKey = stripSaltSuffixTokens(row.name.trim().toLowerCase());
    const idBearing = idBearingByName.get(nameKey);
    if (!idBearing) return true;
    // Absorb any sparse-row fields the surviving row lacks (never overwrite).
    const absorbInto = idBearing as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(row)) {
      if (field !== 'name' && value !== undefined && absorbInto[field] === undefined) {
        absorbInto[field] = value;
      }
    }
    return false;
  });
}

export async function drugSearch(
  query: string,
  options: DrugSearchOptions = {}
): Promise<DrugSearchResult[]> {
  const { limit = 10, offset = 0 } = options;

  const conn = connectionManager.getConnection('mychem');

  const queryParams = new URLSearchParams({
    q: query,
    fields: 'chebi.name,chebi.id,chebi.formula,chebi.mass,chebi.inchikey,unii.smiles,unii.molecular_formula,unii.display_name,unii.unii,unii.registry_number,unichem.chembl,chembl.pref_name,chembl.molecule_chembl_id,chembl.inchi_key,chembl.molecule_properties,ndc.nonproprietaryname,ndc.substancename,fda_orphan_drug',
    size: String(limit),
    from: String(offset),
  });

  const response = await conn.request(`/query?${queryParams.toString()}`) as MyChemSearchResponse;

  return collapseSaltVariants((response.hits || []).map(transformMyChemHit));
}

export interface BestMatchResult {
  hit: Record<string, unknown>;
  score: number;
}

const LUCENE_SPECIAL = /[+\-&|!(){}\[\]^"~*?:\\]/g;

function escapeLucene(value: string): string {
  return value.replace(LUCENE_SPECIAL, '\\$&');
}

export function resolveBestMatch(
  name: string,
  hits: Array<Record<string, unknown>>
): BestMatchResult | null {
  if (!hits || hits.length === 0) return null;

  const queryLower = name.toLowerCase();

  let bestHit: Record<string, unknown> | null = null;
  let bestScore = -1;

  for (const hit of hits) {
    let score = 0;

    const chebi = hit.chebi as Record<string, unknown> | undefined;
    const unii = hit.unii as Record<string, unknown> | undefined;
    const ndc = hit.ndc as Record<string, unknown> | undefined;
    const chembl = hit.chembl as Record<string, unknown> | undefined;

    const chebiName = (chebi?.name as string) || '';
    const displayName = (unii?.display_name as string) || '';
    const nonPropName = (ndc?.nonproprietaryname as string) || '';
    const chemblName = (chembl?.pref_name as string) || '';

    if (chebiName.toLowerCase() === queryLower || chemblName.toLowerCase() === queryLower) {
      score = 3;
    } else if (
      displayName.toLowerCase() === queryLower ||
      nonPropName.toLowerCase() === queryLower
    ) {
      score = 2;
    } else if (chebiName.toLowerCase().includes(queryLower) || chemblName.toLowerCase().includes(queryLower)) {
      score = 1;
    }

    // Check synonym match when not already matched at a higher level
    if (score < 2) {
      const rawSynonyms = chebi?.name_synonyms;
      const synonyms = Array.isArray(rawSynonyms)
        ? rawSynonyms
        : typeof rawSynonyms === 'string'
          ? [rawSynonyms]
          : [];
      if (synonyms.some(s => typeof s === 'string' && s.toLowerCase() === queryLower)) {
        score = 2;
      }
    }

    // Tie-breaker: prefer hits with ChEMBL ID
    const unichem = hit.unichem as Record<string, unknown> | undefined;
    const hasChembl = Boolean(unichem?.chembl || chembl?.molecule_chembl_id);
    const effectiveScore = score + (hasChembl && score > 0 ? 0.5 : 0);

    if (effectiveScore > bestScore) {
      bestScore = effectiveScore;
      bestHit = hit;
    }
  }

  return bestHit ? { hit: bestHit, score: Math.floor(bestScore) } : null;
}

/** Fields we request from MyChem when resolving a drug by name. */
const DRUG_GET_FIELDS =
  'chebi.name,chebi.formula,chebi.mass,chebi.inchi,chebi.inchikey,chebi.id,chebi.name_synonyms,unii.smiles,unii.molecular_formula,unii.display_name,unii.unii,unii.registry_number,unichem.chembl,chembl.pref_name,chembl.molecule_chembl_id,chembl.smiles,chembl.inchi,chembl.inchi_key,chembl.molecule_properties,ndc.nonproprietaryname,ndc.substancename';

/**
 * Recognize a systematic (IUPAC-style) chemical name — the shape ChEBI
 * occasionally uses as its preferred label (issue #135, live-verified
 * 2026-10-17: tetrabenazine's ChEBI name is the 83-char
 * "9,10-dimethoxy-3-isobutyl-1,3,4,6,7,11b-hexahydro-2H-pyrido[2,1-a]isoquinolin-2-one"
 * while ChEMBL's pref_name is the usable "TETRABENAZINE"). A name is treated
 * as systematic when ANY of:
 *  - length >= 50 (common drug names stay far below; systematic ones run long);
 *  - it contains a bracket locant like "[2,1-a]" (fused-ring nomenclature only);
 *  - it carries >= 3 digit/hyphen locant characters (e.g. "9,10-dimethoxy-3-...").
 * Deliberately strict so real drug names pass through untouched
 * ("acetylsalicylic acid" scores 0, "5-aminolevulinic acid" and "vitamin B12"
 * score 2); a borderline semi-systematic name ("morphine-3-glucuronide", 3)
 * demoting is acceptable — another curated source's display name is still a
 * better `name`. Exported for tests.
 */
export function looksLikeSystematicChemicalName(name: string): boolean {
  if (!name) return false;
  if (name.length >= 50) return true;
  if (/\[\d/.test(name)) return true;
  return (name.match(/[\d-]/g) || []).length >= 3;
}

export async function drugGet(
  name: string,
  sections?: string[],
  limit = 20
): Promise<DrugResult> {
  const sectionConfig = sections || ['core'];

  const conn = connectionManager.getConnection('mychem');

  const escaped = escapeLucene(name);

  // Single combined query covering exact match, synonyms, display names, and broad fallback.
  // resolveBestMatch scores candidates: 3=exact chebi/chembl name, 2=exact synonym/display name, 1=contains, 0=other.
  const q = `chebi.name:"${escaped}" OR chebi.name_synonyms:"${escaped}" OR chembl.pref_name:"${escaped}" OR unii.display_name:"${escaped}" OR ndc.nonproprietaryname:"${escaped}" OR "${escaped}"`;

  const queryParams = new URLSearchParams({
    q,
    fields: DRUG_GET_FIELDS,
    size: '10',
  });

  const response = await conn.request(
    `/query?${queryParams.toString()}`
  ) as MyChemGetResponse;

  const bestMatch = resolveBestMatch(name, response.hits || []);

  if (!bestMatch) {
    throw new Error(`Drug '${name}' not found. Try drug_search to find valid drug names.`);
  }

  const hit = bestMatch.hit;
  const chebi = hit.chebi as Record<string, unknown> | undefined;
  const unii = hit.unii as Record<string, unknown> | undefined;
  const unichem = hit.unichem as Record<string, unknown> | undefined;
  const ndc = hit.ndc as Record<string, unknown> | undefined;
  const chembl = hit.chembl as Record<string, unknown> | undefined;
  const chemblProps = chembl?.molecule_properties as Record<string, unknown> | undefined;

  // Name fallback chain, strongest identity source first — with one guard
  // (issue #135): when ChEBI's preferred label is itself a fully systematic
  // IUPAC-style name, it is demoted out of the chain (it would make
  // `name` useless for name-based joins) and exposed as `iupac` instead;
  // the chain then falls through to the remaining sources unchanged.
  const chebiName = (chebi?.name as string) || '';
  const result: DrugResult = {
    name: (!looksLikeSystematicChemicalName(chebiName) ? chebiName : '') ||
      (unii?.display_name as string) ||
      (chembl?.pref_name as string) ||
      (ndc?.nonproprietaryname as string) ||
      (ndc?.substancename as string) ||
      (unii?.registry_number as string) ||
      name,
    // Raw ChEBI label always exposed verbatim when present (even when it
    // equals `name`) — one predictable contract, no consumer-side diffing.
    iupac: chebiName || undefined,
    chembl_id: (unichem?.chembl as string) || (chembl?.molecule_chembl_id as string) || undefined,
    smiles: (unii?.smiles as string) || (chembl?.smiles as string) || undefined,
    inchi: (chebi?.inchi as string) || (chembl?.inchi as string) || undefined,
    inchi_key: (chebi?.inchikey as string) || (chembl?.inchi_key as string) || undefined,
    molecular_weight: (chebi?.mass as number) || (chemblProps?.full_mwt as number) || undefined,
    molecular_formula: (chebi?.formula as string) || (unii?.molecular_formula as string) || (chemblProps?.full_molformula as string) || undefined,
  };

  // The CAS registry number (unii.registry_number) rides in its own `cas`
  // field (issue #123) — it is not a name synonym, so it no longer pollutes
  // `aliases`, which stays reserved for true synonyms.
  if (unii?.registry_number) {
    result.cas = unii.registry_number as string;
  }

  // Cross-hit field consolidation: if the primary hit is missing chembl_id or
  // cas, backfill from other matching candidate hits in the response.
  for (const other of response.hits || []) {
    if (other === hit) continue;
    const otherScore = resolveBestMatch(name, [other])?.score ?? 0;
    if (otherScore >= 2) {
      if (!result.chembl_id) {
        const otherUnichem = other.unichem as Record<string, unknown> | undefined;
        const otherChembl = other.chembl as Record<string, unknown> | undefined;
        const cId = (otherUnichem?.chembl as string) || (otherChembl?.molecule_chembl_id as string);
        if (cId) result.chembl_id = cId;
      }
      if (!result.cas) {
        const otherUnii = other.unii as Record<string, unknown> | undefined;
        if (otherUnii?.registry_number) {
          result.cas = otherUnii.registry_number as string;
        }
      }
    }
  }

  const sectionsToFetch = sectionConfig.includes('all')
    ? [...DRUG_ENTITY_ALL_SECTIONS]
    : sectionConfig.filter(s => s !== 'core');

  // Use the original user input for external API calls (OpenFDA, OpenTargets)
  // since those databases index drugs by common names, not ChEBI canonical names.
  const lookupName = name;

  if (sectionsToFetch.length > 0) {
    // Pre-resolve shared dependencies to avoid duplicate API calls.
    const needOpenFDA = sectionsToFetch.includes('us_regulatory') || sectionsToFetch.includes('safety');
    const needOpenTargets = sectionsToFetch.includes('targets') || sectionsToFetch.includes('indications');

    const [openFDALabel, chemblId] = await Promise.all([
      needOpenFDA ? fetchOpenFDALabel(lookupName) : Promise.resolve(null),
      needOpenTargets ? (result.chembl_id || resolveDrugChemblId(lookupName)) : Promise.resolve(undefined),
    ]);

    const sectionPromises = sectionsToFetch.map(section => {
      return fetchWithTimeout(async (signal?: AbortSignal) => {
        switch (section) {
          case 'us_regulatory': return { section: 'us_regulatory', data: extractUSRegulatory(openFDALabel) };
          case 'safety': return { section: 'safety', data: extractSafety(openFDALabel) };
          case 'who_regulatory': return { section: 'who_regulatory', data: await fetchWHORegulatory(lookupName, signal) };
          case 'targets': return { section: 'targets', data: await fetchTargets(chemblId ?? null) };
          case 'indications': return { section: 'indications', data: await fetchIndications(chemblId ?? null) };
          case 'adverse_events': return { section: 'adverse_events', data: await fetchAdverseEvents(lookupName, limit) };
          default: return { section, data: null };
        }
      }, SECTION_TIMEOUT_MS);
    });

    const settledResults = await Promise.allSettled(sectionPromises);

    result.sections = {};
    for (let si = 0; si < settledResults.length; si++) {
      const settled = settledResults[si];
      if (settled.status === 'fulfilled' && settled.value.data) {
        const sectionData = settled.value.data as { section: string; data: unknown };
        (result.sections as Record<string, unknown>)[sectionData.section] = sectionData.data;
      } else if (settled.status === 'fulfilled' && settled.value.error) {
        const sectionResult = settled.value as { error?: string };
        (result.sections as Record<string, unknown>)[sectionsToFetch[si]] = {
          _error: sectionResult.error
        };
      } else if (settled.status === 'rejected') {
        const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        (result.sections as Record<string, unknown>)[sectionsToFetch[si]] = {
          _error: `Section '${sectionsToFetch[si]}' fetch failed: ${reason}. The data source may be temporarily unavailable.`
        };
      }
    }
  }

  return result;
}

async function fetchOpenFDALabel(drugName: string): Promise<OpenFDAResponse['results'] | null> {
  try {
    const conn = connectionManager.getConnection('openfda');
    const response = await conn.request(
      `/drug/label.json?search=openfda.generic_name:"${encodeURIComponent(escapeLucenePhrase(drugName))}"&limit=1`
    ) as OpenFDAResponse;
    return response.results || null;
  } catch {
    return null;
  }
}

export interface AdverseEventReaction {
  reaction: string;
  count: number;
  source: 'openfda';
}

export interface AdverseEventsResult {
  total_reports: number;
  reactions: AdverseEventReaction[];
}

// openFDA's event endpoint searches fully-qualified field paths — the
// `openfda.*` shorthand only works on label.json. Ordered by specificity.
const FAERS_SEARCH_FIELDS = [
  'patient.drug.openfda.substance_name',
  'patient.drug.openfda.generic_name',
  'patient.drug.medicinalproduct',
] as const;

/**
 * Escape a value for a Lucene phrase query. Backslash first, then quotes:
 * escaping quotes before backslashes would let a pre-existing backslash
 * escape the closing quote.
 */
function escapeLucenePhrase(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * FDA FAERS adverse reactions for a drug, ranked by report count.
 *
 * Uses the aggregated `count=patient.reaction.reactionmeddrapt.exact`
 * endpoint rather than raw event reports, so the result is a compact
 * ranked list. openFDA answers zero-match searches with HTTP 404, which
 * advances the field fallback chain instead of failing the lookup.
 */
export async function fetchAdverseEvents(drugName: string, limit = 20): Promise<AdverseEventsResult | Array<{ _error: string }>> {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 1000) : 20;
  try {
    const conn = connectionManager.getConnection('openfda');
    const phrase = (field: string) => `${field}:"${escapeLucenePhrase(drugName)}"`;

    for (const field of FAERS_SEARCH_FIELDS) {
      let total: number;
      try {
        const probe = await conn.request(
          `/drug/event.json?search=${encodeURIComponent(phrase(field))}&limit=1`
        ) as { meta?: { results?: { total?: number } } };
        total = probe?.meta?.results?.total ?? 0;
        if (!total) continue;
      } catch (error) {
        if (error instanceof HttpConnectionError && error.status === 404) continue;
        throw error;
      }

      const counts = await conn.request(
        `/drug/event.json?search=${encodeURIComponent(phrase(field))}&count=${encodeURIComponent('patient.reaction.reactionmeddrapt.exact')}&limit=${safeLimit}`
      ) as { results?: Array<{ term?: string; count?: number }> };

      const reactions = (counts?.results ?? [])
        .filter((r): r is { term: string; count: number } => typeof r.term === 'string' && typeof r.count === 'number')
        .map(r => ({ reaction: r.term, count: r.count, source: 'openfda' as const }));

      return { total_reports: total, reactions };
    }

    return { total_reports: 0, reactions: [] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchAdverseEvents] Error:', error);
    return [{ _error: `Adverse event lookup for drug failed (source: openfda): ${msg}. The data source may be temporarily unavailable or the drug name may not match.` }];
  }
}

function extractUSRegulatory(results: OpenFDAResponse['results'] | null): { fda_status?: string; ndc_codes?: string[]; label?: string; _error?: string } {
  if (!results || results.length === 0) return {};
  const label = results[0];
  return {
    fda_status: label.effective_time ? 'approved' : 'unknown',
    ndc_codes: label.openfda?.ndc_code,
    label: label.openfda?.brand_name?.[0],
  };
}

function extractSafety(results: OpenFDAResponse['results'] | null): { box_warning?: string; warnings?: string[]; adverse_reactions?: string[]; _error?: string } {
  if (!results || results.length === 0) return {};
  const label = results[0];
  return {
    box_warning: label.boxed_warning?.[0],
    warnings: label.warnings,
    adverse_reactions: label.adverse_reactions,
  };
}

// ---------------------------------------------------------------------------
// WHO Prequalification lookup (who_regulatory)
//
// eu_regulatory was REMOVED (issue #135 / tracked for re-adding in #138): it
// was a hardcoded `{ authorized: false }` stub — no lookup ever ran — and no
// trustworthy free EMA data path exists today (API hosts are NXDOMAIN; the
// nightly bulk XLSX is bot-blocked from datacenter IPs). who_regulatory was
// the same kind of fake false and is now a real lookup below.
// ---------------------------------------------------------------------------

/**
 * Official anonymous CSV export of WHO-prequalified finished pharmaceutical
 * products (live-verified 2026-10-17: ~655 rows, no auth, no key). Columns:
 * `WHO Reference Number`, `INN, Dosage Form and Strength`, `Product Type`,
 * `Therapeutic Area`, `Applicant`, `Dosage Form`, `Basis of Listing`,
 * `Date of Prequalification`. Several columns (including the header itself)
 * contain commas inside quoted fields, so parsing must be quote-aware.
 */
const WHO_PQ_CSV_URL =
  'https://extranet.who.int/prequal/medicines/prequalified/finished-pharmaceutical-products/export?page&_format=csv';

/** The listing changes slowly; re-fetch at most once per 24h per process. */
const WHO_PQ_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface WhoPqProduct {
  who_ref: string;
  inn_form: string;
  applicant?: string;
  date?: string;
}

export interface WHORegulatoryResult {
  prequalified: boolean;
  /** Matching PQ products; `[]` on a true negative, absent on failure. */
  products?: WhoPqProduct[];
  /** Scope note attached to a true negative (name simply not PQ-listed). */
  note?: string;
  /** True only when the lookup itself failed — never a confident false. */
  unavailable?: boolean;
  _error?: string;
  source?: string;
}

/** Module-level cache: { fetchedAt, rows } — no disk cache needed (simple,
 * adequate for a slowly-changing ~650-row listing). `whoPqInFlight` dedupes
 * concurrent cold fetches. */
let whoPqCache: { fetchedAt: number; rows: string[][] } | null = null;
let whoPqInFlight: Promise<string[][]> | null = null;

export function resetWhoPqCacheForTests(): void {
  whoPqCache = null;
  whoPqInFlight = null;
}

/**
 * Minimal RFC-4180-style CSV parser (no dependencies): double-quoted fields,
 * `""` escapes, commas/line breaks inside quotes, tolerant of CRLF and a
 * leading BOM. A final line without a trailing newline is still emitted.
 */
function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Extract the candidate INN lead-phrases (lowercased) from an
 * `INN, Dosage Form and Strength` value such as
 * "Artemether/Lumefantrine Tablet 20mg/120mg",
 * "Abacavir (sulfate) Solution, Oral 20mg/ml", or
 * "Dolutegravir (sodium) Tablet, Film-coated 50mg".
 *
 * Rule (chosen against the live export's real value shapes):
 *  1. Cut at the FIRST comma — sub-form qualifiers (", Oral", ", hard",
 *     ", Film-coated") always sit after it; the INN always sits before.
 *  2. Split on "/" — fixed-dose combos separate their INNs with slashes
 *     ("Artemether/Lumefantrine"); strength fragments ("120mg") split off
 *     here too and are dropped by step 3.
 *  3. Keep each fragment's LEADING run of purely alphabetic words — a salt
 *     marker ("(sulfate)", "(sodium)") or a strength ("20mg") is the first
 *     non-alpha token and ends the run; dosage-form words ("Tablet",
 *     "Solution") may trail the run and are handled by the caller's
 *     leading-token-run match.
 */
export function innLeadPhrases(innFormValue: string): string[] {
  const head = (innFormValue.split(',')[0] ?? innFormValue).trim();
  const phrases: string[] = [];
  for (const fragment of head.split('/')) {
    const words: string[] = [];
    for (const token of fragment.trim().split(/\s+/)) {
      if (!/^[A-Za-z][A-Za-z-]*$/.test(token)) break;
      words.push(token);
    }
    if (words.length > 0) phrases.push(words.join(' ').toLowerCase());
  }
  return phrases;
}

/**
 * Parse the header row into lowercase trimmed names and resolve the column
 * indices we read. Returns null when the expected columns are absent — the
 * caller treats that as a non-CSV response (e.g. an HTML error page).
 */
function whoPqColumns(headerRow: string[] | undefined): {
  refI: number; innI: number; applicantI: number; dateI: number;
} | null {
  const header = (headerRow ?? []).map(c => c.trim().toLowerCase());
  const refI = header.indexOf('who reference number');
  const innI = header.findIndex(c => c.startsWith('inn'));
  if (refI < 0 || innI < 0) return null;
  return {
    refI,
    innI,
    applicantI: header.indexOf('applicant'),
    dateI: header.indexOf('date of prequalification'),
  };
}

async function loadWhoPqRows(signal?: AbortSignal): Promise<string[][]> {
  if (whoPqCache && monotonicNowMs() - whoPqCache.fetchedAt < WHO_PQ_CACHE_TTL_MS) {
    return whoPqCache.rows;
  }
  if (whoPqInFlight) return whoPqInFlight;
  whoPqInFlight = (async () => {
    const response = await fetch(WHO_PQ_CSV_URL, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = parseCsv(await response.text());
    // Shape sniff before caching: the official export's header names both key
    // columns. Anything else (a proxied error page, a redirect body) is a
    // fetch failure, never a zero-match "false".
    if (!whoPqColumns(rows[0])) throw new Error('response is not the WHO PQ CSV export');
    whoPqCache = { fetchedAt: monotonicNowMs(), rows };
    return rows;
  })();
  try {
    return await whoPqInFlight;
  } finally {
    whoPqInFlight = null;
  }
}

/**
 * WHO Prequalification status for a drug name.
 *
 * Scope: WHO PQ LISTING only (~650 global-health priority products across
 * HIV/TB/malaria/reproductive health) — it is not a general "approved
 * anywhere" registry. Honest semantics both ways: a negative for a name that
 * simply is not in the list carries a scope note, and a failed lookup
 * returns `{ prequalified: false, unavailable: true, _error, source: 'who' }`
 * instead of a fake confident false. Never throws.
 */
export async function fetchWHORegulatory(drugName: string, signal?: AbortSignal): Promise<WHORegulatoryResult> {
  const query = stripSaltSuffixTokens(drugName.trim().toLowerCase());
  try {
    const rows = await loadWhoPqRows(signal);
    const cols = whoPqColumns(rows[0]);
    if (!cols) throw new Error('unexpected CSV layout');
    const { refI, innI, applicantI, dateI } = cols;

    const products: WhoPqProduct[] = [];
    for (const row of rows.slice(1)) {
      const innForm = (row[innI] ?? '').trim();
      // Case-insensitive leading-token-run match: the query equals a lead
      // phrase or is a leading whole-word prefix of one ("lumefantrine"
      // matches "Lumefantrine Tablet"; "tenofovir disoproxil fumarate"
      // matches "Tenofovir disoproxil fumarate Tablet"). Trailing salt
      // tokens on the query were stripped above ("dolutegravir sodium" ->
      // "dolutegravir" matches "Dolutegravir (sodium) Tablet").
      const matched = innLeadPhrases(innForm).some(
        p => p === query || p.startsWith(`${query} `)
      );
      if (!matched) continue;
      const applicant = applicantI >= 0 ? (row[applicantI] ?? '').trim() : '';
      const date = dateI >= 0 ? (row[dateI] ?? '').replace(/\s+/g, ' ').trim() : '';
      products.push({
        who_ref: (row[refI] ?? '').trim(),
        inn_form: innForm,
        applicant: applicant || undefined,
        date: date || undefined,
      });
    }

    if (products.length > 0) return { prequalified: true, products };
    return {
      prequalified: false,
      products: [],
      note: 'Not WHO-prequalified; WHO PQ covers ~650 global-health priority products (HIV/TB/malaria/reproductive health).',
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      prequalified: false,
      unavailable: true,
      _error: `WHO PQ lookup failed: ${msg}. Usually transient — retry later.`,
      source: 'who',
    };
  }
}

async function resolveDrugChemblId(drugName: string): Promise<string | null> {
  try {
    const conn = connectionManager.getConnection('opentargets');
    const query = `query($name: String!) {
      search(queryString: $name, entityNames: ["drug"], page: {index: 0, size: 1}) {
        hits { id name }
      }
    }`;
    const raw = await conn.request(query, { name: drugName }, { rootField: 'search' }) as any;
    const data = JSON.parse(JSON.stringify(raw));
    return data?.data?.search?.hits?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function fetchTargets(chemblId: string | null): Promise<Array<{ gene_symbol: string; name: string; action_type?: string; source: string }>> {
  if (!chemblId) {
    return [{ _error: 'No OpenTargets entry found for this drug. The drug may not be in the OpenTargets database.' } as any];
  }
  try {
    const conn = connectionManager.getConnection('opentargets');
    const query = `query($chemblId: String!) {
      drug(chemblId: $chemblId) {
        id name
        mechanismsOfAction {
          rows { actionType targets { id approvedSymbol } }
          uniqueActionTypes
        }
      }
    }`;

    const raw = await conn.request(query, { chemblId }, { rootField: 'drug' }) as any;
    const data = JSON.parse(JSON.stringify(raw));
    const rows = data?.data?.drug?.mechanismsOfAction?.rows || [];

    const seen = new Set<string>();
    const results: Array<{ gene_symbol: string; name: string; action_type?: string; source: string }> = [];
    for (const row of rows) {
      for (const t of row.targets || []) {
        if (!seen.has(t.approvedSymbol)) {
          seen.add(t.approvedSymbol);
          results.push({
            gene_symbol: t.approvedSymbol || '',
            name: t.approvedSymbol || '',
            action_type: row.actionType || undefined,
            source: 'opentargets',
          });
        }
      }
    }
    return results.slice(0, 20);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Target lookup failed (source: opentargets): ${msg}. The data source may be temporarily unavailable.` } as any];
  }
}

async function fetchIndications(chemblId: string | null): Promise<Array<{ disease_name: string; phase: string; source: string }>> {
  if (!chemblId) {
    return [{ _error: 'No OpenTargets entry found for this drug. The drug may not be in the OpenTargets database.' } as any];
  }
  try {
    const conn = connectionManager.getConnection('opentargets');
    const query = `query($chemblId: String!) {
      drug(chemblId: $chemblId) {
        id name
        indications {
          rows { maxClinicalStage clinicalReports { id } disease { id name } }
        }
      }
    }`;

    const raw = await conn.request(query, { chemblId }, { rootField: 'drug' }) as any;
    const data = JSON.parse(JSON.stringify(raw));
    const rows: Array<{ maxClinicalStage?: string; clinicalReports?: Array<{ id?: string }>; disease?: { name?: string } }> =
      data?.data?.drug?.indications?.rows || [];

    // Rank BEFORE the slice (issue #135): OpenTargets returns indication rows
    // unranked, so slicing the raw order could discard APPROVAL rows below
    // lower-phase ones. Same comparator family the gene_drugs/disease_drugs
    // paths already use (rankOtDrugRows): max-clinical-stage rank descending
    // (clinicalStageRank), then trial-report count descending, then disease
    // name ascending case-insensitively for a deterministic order.
    const reportCount = (r: { clinicalReports?: Array<{ id?: string }> }) =>
      Array.isArray(r.clinicalReports) ? r.clinicalReports.length : 0;
    const ranked = [...rows].sort((a, b) => {
      const stageDiff = clinicalStageRank(b.maxClinicalStage) - clinicalStageRank(a.maxClinicalStage);
      if (stageDiff !== 0) return stageDiff;
      const reportDiff = reportCount(b) - reportCount(a);
      if (reportDiff !== 0) return reportDiff;
      const nameA = (a.disease?.name ?? '').toLowerCase();
      const nameB = (b.disease?.name ?? '').toLowerCase();
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    });

    return ranked.slice(0, 20).map(r => ({
      disease_name: r.disease?.name || '',
      phase: r.maxClinicalStage || '',
      source: 'opentargets',
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Indication lookup failed (source: opentargets): ${msg}. The data source may be temporarily unavailable.` } as any];
  }
}

interface MyChemSearchResponse {
  hits: Array<Record<string, unknown>>;
}

interface MyChemGetResponse {
  hits: Array<Record<string, unknown>>;
}

interface OpenFDAResponse {
  results?: Array<{
    effective_time?: number;
    openfda?: {
      ndc_code?: string[];
      brand_name?: string[];
    };
    boxed_warning?: string[];
    warnings?: string[];
    adverse_reactions?: string[];
  }>;
}

/**
 * First `generic_name` across an `fda_orphan_drug` annotation (an array of
 * orphan-designation records; a single object is tolerated defensively).
 * `trade_name` is deliberately unused — the search `name` field prefers
 * generic identity over brand names.
 */
function orphanGenericName(raw: unknown): string {
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const genericName = (entry as Record<string, unknown>).generic_name;
    if (typeof genericName === 'string' && genericName.trim()) return genericName.trim();
  }
  return '';
}

export function transformMyChemHit(hit: Record<string, unknown>): DrugSearchResult {
  const chebi = hit.chebi as Record<string, unknown> | undefined;
  const unii = hit.unii as Record<string, unknown> | undefined;
  const unichem = hit.unichem as Record<string, unknown> | undefined;
  const ndc = hit.ndc as Record<string, unknown> | undefined;
  const chembl = hit.chembl as Record<string, unknown> | undefined;
  const chemblProps = chembl?.molecule_properties as Record<string, unknown> | undefined;

  // Name fallback chain, strongest identity source first. The orphan
  // designation's generic_name sits after the curated ChEBI/UNII/ChEMBL/NDC
  // names and before the UNII registry number: orphan designation is a
  // weaker identity source than any curated name, but far better than a
  // CAS-style registry number (and than shipping a name-less row).
  return {
    name: (chebi?.name || unii?.display_name || chembl?.pref_name || ndc?.nonproprietaryname || ndc?.substancename || orphanGenericName(hit.fda_orphan_drug) || unii?.registry_number || '') as string,
    chembl_id: (unichem?.chembl as string) || (chembl?.molecule_chembl_id as string) || undefined,
    inchi_key: (chebi?.inchikey as string) || (chembl?.inchi_key as string) || undefined,
    molecular_formula: (chebi?.formula as string) || (unii?.molecular_formula as string) || (chemblProps?.full_molformula as string) || undefined,
    molecular_weight: (chebi?.mass as number) || (chemblProps?.full_mwt as number) || undefined,
    chebi_id: (chebi?.id as string) || undefined,
    // MyChem's unii sub-document carries TWO distinct identifiers (issue
    // #123): `unii` is the FDA UNII, `registry_number` is the CAS registry
    // number. They must never be conflated — a dash-separated CAS is close
    // enough in shape to a UNII that downstream consumers silently join on
    // the wrong identifier.
    unii: (unii?.unii as string) || undefined,
    cas: (unii?.registry_number as string) || undefined,
  };
}

export function transformMyChemResponse(data: Record<string, unknown>): DrugResult {
  const chebi = data.chebi as Record<string, unknown> | undefined;
  const unii = data.unii as Record<string, unknown> | undefined;
  const unichem = data.unichem as Record<string, unknown> | undefined;
  const chembl = data.chembl as Record<string, unknown> | undefined;
  const chemblProps = chembl?.molecule_properties as Record<string, unknown> | undefined;

  return {
    name: (chebi?.name || unii?.display_name || chembl?.pref_name || '') as string,
    chembl_id: (unichem?.chembl as string) || (chembl?.molecule_chembl_id as string) || undefined,
    inchi: (chebi?.inchi as string) || (chembl?.inchi as string) || undefined,
    inchi_key: (chebi?.inchikey as string) || (chembl?.inchi_key as string) || undefined,
    smiles: (unii?.smiles as string) || (chembl?.smiles as string) || undefined,
    molecular_weight: (chebi?.mass as number) || (chemblProps?.full_mwt as number) || undefined,
    molecular_formula: (chebi?.formula as string) || (unii?.molecular_formula as string) || (chemblProps?.full_molformula as string) || undefined,
  };
}
