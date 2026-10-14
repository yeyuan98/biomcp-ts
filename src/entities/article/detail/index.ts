import { connectionManager } from '../../../connections/manager.js';
import { parsePubMedXml } from '../transform/pubmed.js';
import { parseArticleId, resolveToPmid, resolveDoiToPmid, isPreprintDoi } from './id-resolution.js';
import type { ResolvedPmid } from './id-resolution.js';
import { getPreprintArticle } from './preprint.js';
import { fetchOpenAccess } from './open-access.js';
import type { OpenAccessResult } from './open-access.js';
import { fetchFullText, FULLTEXT_DEFAULT_MAX_CHARS, FULLTEXT_ALL_MODE_MAX_CHARS } from './fulltext.js';
import { fetchAnnotations, fetchCitationGraph } from './annotations.js';
import { getCitations } from '../citation/index.js';
import type { ArticleId } from '../citation/types.js';
import type { Article, ArticleResult, ArticleGetOptions } from '../types.js';

async function fetchPubMedArticle(pmid: string): Promise<Article> {
  try {
    const conn = connectionManager.getConnection('eutils');

    const xmlString = await conn.request(
      `/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract`
    ) as string;

    const articles = parsePubMedXml(xmlString);
    return articles[0] || {};
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchPubMedArticle] Error:', error);
    return { _error: `PubMed article fetch failed (source: pubmed): ${msg}. The PMID may be invalid or the data source may be temporarily unavailable.` } as any;
  }
}

async function resolvePmidToIds(pmid: string): Promise<ResolvedPmid | undefined> {
  try {
    const conn = connectionManager.getConnection('ncbi_idconv');
    const response = await conn.request(
      `?ids=${encodeURIComponent(pmid)}&format=json`
    ) as any;
    const record = response.records?.[0];
    if (record && !record.errmsg && record.status !== 'error') {
      return {
        pmid,
        pmcid: record.pmcid,
        doi: record.doi,
      };
    }
  } catch {
    // IDConv is best-effort; PMID-only is acceptable
  }
  return undefined;
}

export async function articleGet(
  identifier: string,
  sections?: string[],
  options?: ArticleGetOptions
): Promise<ArticleResult> {
  const parsed = parseArticleId(identifier);

  // Preprint DOIs (bioRxiv/medRxiv) have no PMID — bypass PubMed resolution
  // entirely and build the record from the preprint sources.
  if (parsed.type === 'doi' && isPreprintDoi(parsed.value)) {
    return getPreprintArticle(parsed.value, { sections, limit: options?.limit });
  }

  let pmid: string;
  let resolvedIds: ResolvedPmid | undefined;

  if (parsed.type === 'pmid') {
    pmid = parsed.value;
  } else if (parsed.type === 'doi') {
    try {
      resolvedIds = await resolveToPmid(parsed.value, parsed.type);
      pmid = resolvedIds.pmid;
    } catch {
      resolvedIds = await resolveDoiToPmid(parsed.value);
      pmid = resolvedIds.pmid;
    }
  } else {
    resolvedIds = await resolveToPmid(parsed.value, parsed.type);
    pmid = resolvedIds.pmid;
  }

  const article = await fetchPubMedArticle(pmid);

  const result: ArticleResult = {
    ...article,
  };

  if (!result.pmid && !result.title && !result._error) {
    throw new Error(`Could not resolve pmid '${pmid}'. The article may not exist in PubMed.`);
  }

  if (resolvedIds) {
    if (!result.pmid) result.pmid = resolvedIds.pmid;
    if (!result.pmcid && resolvedIds.pmcid) result.pmcid = resolvedIds.pmcid;
    if (!result.doi && resolvedIds.doi) result.doi = resolvedIds.doi;
  }

  const sectionsToFetch = sections?.filter(s => s !== 'core') || [];
  const limit = options?.limit ?? 20;

  // oa/fulltext need a PMCID; citation resolution benefits from the same
  // idconv answer. One lookup serves every section (the DOI→esearch
  // fallback path returns resolvedIds WITHOUT a pmcid, hence the pmcid
  // check rather than a resolvedIds check).
  const needsPmcid = sectionsToFetch.some(s => s === 'oa' || s === 'fulltext' || s === 'citation' || s === 'all');
  if (needsPmcid && !resolvedIds?.pmcid && !result.pmcid) {
    const lateIds = await resolvePmidToIds(pmid);
    if (lateIds) {
      // Pick defined values explicitly: a spread would let an explicit
      // undefined from the earlier resolution overwrite the late pmcid.
      resolvedIds = {
        pmid,
        pmcid: resolvedIds?.pmcid ?? lateIds.pmcid,
        doi: resolvedIds?.doi ?? lateIds.doi,
      };
      if (!result.pmcid && lateIds.pmcid) result.pmcid = lateIds.pmcid;
      if (!result.doi && lateIds.doi) result.doi = lateIds.doi;
    }
  }

  const pmcid = resolvedIds?.pmcid || result.pmcid;
  const doi = result.doi || resolvedIds?.doi;

  const wantsOa = sectionsToFetch.includes('oa') || sectionsToFetch.includes('all');
  const wantsFullText = sectionsToFetch.includes('fulltext') || sectionsToFetch.includes('all');

  // One Europe PMC core record backs both the oa section and the fulltext
  // section (access classification + license header), so oa+fulltext and
  // all-mode requests issue a single search.
  const oaRecordPromise: Promise<OpenAccessResult> | null = (wantsOa || wantsFullText)
    ? fetchOpenAccess(pmcid, doi)
    : null;

  const sectionPromises: Promise<void>[] = [];

  if (oaRecordPromise) {
    sectionPromises.push(
      oaRecordPromise.then(r => {
        if (r.is_open_access !== undefined) result.is_open_access = r.is_open_access;
        if (wantsOa) {
          result.sections = result.sections || {};
          (result.sections as Record<string, unknown>)['open_access'] = r;
        }
      }).catch(e => {
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['open_access'] = { _error: String(e) };
      })
    );
  }

  if (wantsFullText) {
    // An explicit sections=["fulltext"] request gets the full cap; fulltext
    // riding along in ["all"] gets the reduced preview cap (an explicit
    // caller cap, e.g. batch_get's 10000, always wins as an upper bound).
    const fulltextCap = Math.min(
      sectionsToFetch.includes('fulltext')
        ? (options?.fulltextMaxChars ?? FULLTEXT_DEFAULT_MAX_CHARS)
        : FULLTEXT_ALL_MODE_MAX_CHARS,
      options?.fulltextMaxChars ?? Number.MAX_SAFE_INTEGER
    );
    sectionPromises.push(
      (async () => {
        const oa = await (oaRecordPromise
          ? oaRecordPromise.catch(() => null)
          : Promise.resolve(null));
        const r = await fetchFullText(pmcid, { maxChars: fulltextCap, oa, doi });
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['fulltext'] = r;
      })().catch(e => {
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['fulltext'] = { _error: String(e) };
      })
    );
  }

  if (sectionsToFetch.includes('annotations') || sectionsToFetch.includes('all')) {
    sectionPromises.push(
      fetchAnnotations(pmid).then(r => {
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['annotations'] = r;
      }).catch(e => {
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['annotations'] = { _error: String(e) };
      })
    );
  }

  if (sectionsToFetch.includes('graph') || sectionsToFetch.includes('all')) {
    sectionPromises.push(
      fetchCitationGraph(pmid).then(r => {
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['citation_graph'] = r;
      }).catch(e => {
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['citation_graph'] = { _error: String(e) };
      })
    );
  }

  if (sectionsToFetch.includes('citation') || sectionsToFetch.includes('all')) {
    sectionPromises.push(
      (async () => {
        const articleId: ArticleId = { pmid, pmcid, doi };
        const r = await getCitations(articleId, {
          direction: options?.citationDirection ?? 'both',
          full: options?.citationMode === 'full',
          limit,
        });
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['citation'] = r;
      })().catch(e => {
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['citation'] = { _error: String(e) };
      })
    );
  }

  await Promise.allSettled(sectionPromises);

  return result;
}
