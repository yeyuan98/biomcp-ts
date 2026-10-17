import { connectionManager } from '../../../connections/manager.js';
import { parsePubMedXml } from '../transform/pubmed.js';
import type { Article, ParsedDateRange } from '../types.js';
import { backendErrorRow } from './backend-error.js';
import { rewriteJournalPhrase } from './journal-titles.js';

interface PubMedSearchResponse {
  esearchresult?: {
    idlist?: string[];
    count?: string;
    querytranslation?: string;
    warninglist?: {
      phrasesignored?: string[];
      quotedphrasesnotfound?: string[];
      outputmessages?: string[];
      warnings?: string[];
    };
  };
}

export function formatPubMedDate(isoDate: string): string {
  return isoDate.replace(/-/g, '/');
}

/**
 * Generic English/academic-filler words with essentially no biomedical
 * selectivity: on their own they match hundreds of thousands of unrelated
 * records, so their presence cannot make a degraded match meaningful.
 * Used to decide which query tokens count as "meaningful" when checking
 * whether PubMed's automatic term translation silently dropped the query
 * (issue #78: "qqqzzz impossible term xyzzy" translates to a match on
 * "impossible"/"term" alone and returns ~3300 unrelated papers).
 * Deliberately conservative — domain words (gene, cancer, protein, …)
 * are NOT listed: dropping those from the meaningful set could suppress
 * legitimate queries.
 */
const GENERIC_TOKENS = new Set([
  'a', 'an', 'the', 'and', 'or', 'nor', 'but', 'of', 'in', 'on', 'for', 'to',
  'with', 'by', 'from', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'this', 'that', 'these', 'those', 'it', 'its', 'not', 'no', 'if',
  'then', 'than', 'so', 'such', 'can', 'could', 'may', 'might', 'will',
  'would', 'shall', 'should', 'must', 'do', 'does', 'did', 'have', 'has',
  'had', 'i', 'we', 'you', 'they', 'he', 'she', 'via', 'into', 'onto', 'upon',
  'within', 'without', 'between', 'among', 'during', 'after', 'before',
  'about', 'against', 'through', 'under', 'over', 'more', 'most', 'less',
  'least', 'very', 'both', 'each', 'other', 'others', 'some', 'any', 'all',
  'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how', 'what',
  'using', 'use', 'used', 'uses', 'new', 'novel', 'term', 'terms',
  'impossible', 'possible', 'possibly', 'study', 'studies', 'paper', 'papers',
  'article', 'articles', 'research', 'review', 'reviews', 'method',
  'methods', 'analysis', 'analyses', 'result', 'results', 'effect',
  'effects', 'role', 'roles', 'associated',
]);

/** Lowercased, de-quoted, field-stripped query tokens that carry meaning. */
export function extractMeaningfulTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .map(raw => raw.toLowerCase().replace(/^"+|"+$/g, '').replace(/\[[^\]]*\]$/g, ''))
    .filter(tok => /^[a-z0-9][a-z0-9-]*$/.test(tok) && tok.length >= 2 && !GENERIC_TOKENS.has(tok));
}

/**
 * Detect PubMed's silent query degradation by comparing the query's
 * meaningful tokens against the executed `querytranslation` PubMed echoes
 * back: tokens absent from the translation were dropped as unrecognized,
 * and PubMed matched the residue. Returns the dropped tokens.
 */
export function pubmedDroppedTokens(query: string, translation: string): string[] {
  const lowered = translation.toLowerCase();
  return extractMeaningfulTokens(query).filter(tok => !lowered.includes(tok));
}

/**
 * Out-of-band signal from `searchPubMed` to the federation layer: when
 * PubMed's own term translation could not recognize ANY meaningful token
 * of the query, the query is gibberish relative to the biomedical
 * vocabulary, and the federation layer suppresses the OTHER backends'
 * token-residue matches too (live-verified: arXiv happily matches
 * "impossible term" in physics papers for the issue #78 repro query).
 */
export interface PubMedQueryOutcome {
  suppressedAsGibberish?: boolean;
}

/** PubMed's 3-letter month abbreviations (PubDate Month element), mapped
 * to their month number. */
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

interface DisplayDate {
  year: number;
  month?: number;
  day?: number;
}

/** Parse a displayed `publication_date` ("2024 Aug 13", "2024 Aug",
 * "2024") into year/month/day. Returns undefined for anything else —
 * MedlineDate strings ("2024 Jan-Feb", "1975-1980", seasons, …) — so
 * callers can keep unparseable rows instead of dropping them. */
function parseDisplayDate(displayDate: string): DisplayDate | undefined {
  const tokens = displayDate.trim().split(/\s+/);
  if (!/^\d{4}$/.test(tokens[0])) return undefined;
  const year = parseInt(tokens[0], 10);
  if (tokens.length === 1) return { year };
  const monthToken = tokens[1].toLowerCase();
  const month = MONTHS[monthToken] ?? (/^\d{1,2}$/.test(monthToken) ? parseInt(monthToken, 10) : undefined);
  if (month === undefined) return undefined;
  if (tokens.length === 2) return { year, month };
  if (!/^\d{1,2}$/.test(tokens[2])) return undefined;
  return { year, month, day: parseInt(tokens[2], 10) };
}

function parseIsoDate(isoDate: string): DisplayDate {
  const [year, month, day] = isoDate.split('-').map(p => parseInt(p, 10));
  return { year, month, day };
}

/** >= comparison that never rejects on missing granularity: a date that
 * carries no month/day cannot be proven earlier than the bound, so it
 * passes (conservative — never drop what we cannot parse precisely). */
function notBefore(date: DisplayDate, bound: DisplayDate): boolean {
  if (date.year !== bound.year) return date.year > bound.year;
  if (date.month === undefined || bound.month === undefined) return true;
  if (date.month !== bound.month) return date.month > bound.month;
  if (date.day === undefined || bound.day === undefined) return true;
  return date.day >= bound.day;
}

function notAfter(date: DisplayDate, bound: DisplayDate): boolean {
  if (date.year !== bound.year) return date.year < bound.year;
  if (date.month === undefined || bound.month === undefined) return true;
  if (date.month !== bound.month) return date.month < bound.month;
  if (date.day === undefined || bound.day === undefined) return true;
  return date.day <= bound.day;
}

/**
 * Post-filter for the esearch `datetype=pdat` window (issue #120): pdat
 * matches epub dates while rows display the print/issue date from
 * `<PubDate>`, so records outside the requested range leak into results.
 * Compares the DISPLAYED date against the range — year always; month/day
 * only on boundary years, and only when the displayed date carries them.
 * Unparseable/MedlineDate-style dates (and missing dates) PASS
 * conservatively: this filter must never drop a row we cannot date.
 */
export function isWithinDateRange(displayDate: string | undefined, range: ParsedDateRange): boolean {
  if (!displayDate) return true;
  if (!range.from && !range.to) return true;
  const parsed = parseDisplayDate(displayDate);
  if (!parsed) return true;
  if (range.from && !notBefore(parsed, parseIsoDate(range.from))) return false;
  if (range.to && !notAfter(parsed, parseIsoDate(range.to))) return false;
  return true;
}

export async function searchPubMed(
  query: string,
  limit: number,
  offset: number,
  dateRange?: ParsedDateRange,
  warnings?: string[],
  outcome?: PubMedQueryOutcome,
  signal?: AbortSignal
): Promise<Article[]> {
  try {
    // Journal-name rewrite (issue #121): PubMed journal scoping only
    // matches NLM abbreviations, so a trailing full journal name would be
    // silently dropped by term translation. When the query ENDS with a
    // known full journal name (bundled NLM title list), hoist it into
    // explicit `<Abbr>[Journal]` field syntax and disclose the rewrite —
    // never silently. The rest of the query is preserved verbatim.
    let searchTerm = query;
    const journalRewrite = rewriteJournalPhrase(query);
    if (journalRewrite) {
      searchTerm = `${journalRewrite.rewrittenQuery} ${journalRewrite.medAbbr}[Journal]`.trim();
      warnings?.push(
        `Journal phrase rewritten: '${journalRewrite.originalPhrase}' → '${journalRewrite.medAbbr}[Journal]'.`
      );
    }
    // pdat (epub) vs displayed print date mismatch (issue #120): when a
    // dateRange is active, overfetch so the client-side displayed-date
    // filter below can drop out-of-window rows and still fill the page.
    const hasDateRange = Boolean(dateRange?.from || dateRange?.to);
    const retmax = hasDateRange ? Math.min(limit * 2, 100) : limit;
    let searchUrl = `/esearch.fcgi?db=pubmed&term=${encodeURIComponent(searchTerm)}&retmax=${retmax}&retstart=${offset}&retmode=json`;
    if (hasDateRange && dateRange) {
      // NBK25499: mindate/maxdate must be used together — default the
      // missing bound so esearch always receives a complete range.
      searchUrl += `&datetype=pdat`;
      searchUrl += `&mindate=${dateRange.from ? formatPubMedDate(dateRange.from) : '1600/01/01'}`;
      searchUrl += `&maxdate=${dateRange.to ? formatPubMedDate(dateRange.to) : '3000/12/31'}`;
    }

    // Retry policy lives on the registry 'eutils' source config.
    const conn = connectionManager.getConnection('eutils');
    const searchResponse = await conn.request(searchUrl, undefined, { signal }) as PubMedSearchResponse;
    const esearch = searchResponse.esearchresult;

    // PubMed's translation silently drops unrecognized tokens and matches
    // whatever residue survives (issue #78). The executed query is echoed
    // in `querytranslation`; compare it against the requested tokens and
    // refuse to return residue matches. Conservative by construction:
    // suppression only when EVERY meaningful token was dropped — partial
    // survival (some tokens recognized) still returns results, with an
    // honest warning naming the ignored terms. The analysis runs against
    // the term ACTUALLY sent (searchTerm): a rewritten-away journal phrase
    // is already disclosed above and must not double-report as "ignored".
    const translation = esearch?.querytranslation;
    if (typeof translation === 'string') {
      const dropped = pubmedDroppedTokens(searchTerm, translation);
      const meaningful = extractMeaningfulTokens(searchTerm);
      if (meaningful.length > 0 && dropped.length === meaningful.length) {
        if (outcome) outcome.suppressedAsGibberish = true;
        warnings?.push(
          `PubMed ignored all meaningful terms (${meaningful.join(', ')}) as unrecognized and ` +
          `matched ${esearch?.count ?? '0'} records on leftover generic words; those matches would be unrelated ` +
          `noise, so no PubMed results are returned. Reformulate the query with scientific terminology.`
        );
        return [];
      }
      if (dropped.length > 0) {
        warnings?.push(
          `PubMed ignored unrecognized terms (${dropped.join(', ')}); results match the remaining terms only.`
        );
      }
    }

    if (!esearch?.idlist?.length) {
      const notFound = esearch?.warninglist?.quotedphrasesnotfound ?? [];
      if (notFound.length > 0) {
        warnings?.push(`PubMed found no matches for: ${notFound.join(', ')}.`);
      }
      return [];
    }

    const ids = esearch.idlist.join(',');
    const xmlString = await conn.request(
      `/efetch.fcgi?db=pubmed&id=${ids}&rettype=abstract`,
      undefined,
      { signal }
    ) as string;

    const articles = parsePubMedXml(xmlString);
    if (!hasDateRange || !dateRange) return articles;

    // pdat is epub-based but rows display the print/issue date (issue
    // #120): re-check the DISPLAYED date and drop out-of-window rows
    // (isWithinDateRange passes unparseable/MedlineDate rows through).
    const inWindow = articles.filter(a => isWithinDateRange(a.publication_date, dateRange));
    const dropped = articles.length - inWindow.length;
    if (dropped === 0) return inWindow.slice(0, limit);
    const rangeStr = `${dateRange.from ?? ''}/${dateRange.to ?? ''}`;
    if (inWindow.length === 0) {
      warnings?.push(
        `0 in-window records in fetched pool (PubMed date-filter mismatch); try a larger limit.`
      );
      return [];
    }
    if (inWindow.length < limit) {
      warnings?.push(
        `Removed ${dropped} records outside date range ${rangeStr} (PubMed date-filter mismatch); ` +
        `${inWindow.length}/${limit} rows returned. More may exist — page with offset or raise limit.`
      );
    } else {
      warnings?.push(
        `Removed ${dropped} records outside your date range (PubMed date-filter mismatch).`
      );
    }
    return inWindow.slice(0, limit);
  } catch (error) {
    return backendErrorRow('searchPubMed', error);
  }
}
