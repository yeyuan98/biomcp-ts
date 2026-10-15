import { connectionManager } from '../../../connections/manager.js';
import { parsePubMedXml } from '../transform/pubmed.js';
import type { Article, ParsedDateRange } from '../types.js';
import { backendErrorRow } from './backend-error.js';

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

export async function searchPubMed(
  query: string,
  limit: number,
  offset: number,
  dateRange?: ParsedDateRange,
  warnings?: string[],
  outcome?: PubMedQueryOutcome
): Promise<Article[]> {
  try {
    let searchUrl = `/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retstart=${offset}&retmode=json`;
    if (dateRange?.from || dateRange?.to) {
      // NBK25499: mindate/maxdate must be used together — default the
      // missing bound so esearch always receives a complete range.
      searchUrl += `&datetype=pdat`;
      searchUrl += `&mindate=${dateRange.from ? formatPubMedDate(dateRange.from) : '1600/01/01'}`;
      searchUrl += `&maxdate=${dateRange.to ? formatPubMedDate(dateRange.to) : '3000/12/31'}`;
    }

    // Retry policy lives on the registry 'eutils' source config.
    const conn = connectionManager.getConnection('eutils');
    const searchResponse = await conn.request(searchUrl) as PubMedSearchResponse;
    const esearch = searchResponse.esearchresult;

    // PubMed's translation silently drops unrecognized tokens and matches
    // whatever residue survives (issue #78). The executed query is echoed
    // in `querytranslation`; compare it against the requested tokens and
    // refuse to return residue matches. Conservative by construction:
    // suppression only when EVERY meaningful token was dropped — partial
    // survival (some tokens recognized) still returns results, with an
    // honest warning naming the ignored terms.
    const translation = esearch?.querytranslation;
    if (typeof translation === 'string') {
      const dropped = pubmedDroppedTokens(query, translation);
      const meaningful = extractMeaningfulTokens(query);
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
      `/efetch.fcgi?db=pubmed&id=${ids}&rettype=abstract`
    ) as string;

    return parsePubMedXml(xmlString);
  } catch (error) {
    return backendErrorRow('searchPubMed', error);
  }
}
