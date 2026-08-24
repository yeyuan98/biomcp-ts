import { connectionManager } from '../../../connections/manager.js';
import { parsePubMedXml } from '../transform/pubmed.js';
import { parseArticleId, resolveToPmid, resolveDoiToPmid } from './id-resolution.js';
import type { ResolvedPmid } from './id-resolution.js';
import { fetchOpenAccess } from './open-access.js';
import { fetchAnnotations, fetchCitationGraph } from './annotations.js';
import { getCitations } from '../citation/index.js';
import type { ArticleId } from '../citation/types.js';
import type { Article, ArticleResult } from '../types.js';

interface CitationOptions {
  citationMode?: 'fast' | 'full';
  citationDirection?: 'forward' | 'backward' | 'both';
  limit?: number;
}

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
  options?: CitationOptions
): Promise<ArticleResult> {
  const parsed = parseArticleId(identifier);

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

  if (!resolvedIds && parsed.type === 'pmid') {
    const needsCitation = sections?.includes('citation') || sections?.includes('all');
    if (needsCitation) {
      resolvedIds = await resolvePmidToIds(pmid);
    }
  }

  if (resolvedIds) {
    if (!result.pmid) result.pmid = resolvedIds.pmid;
    if (!result.pmcid && resolvedIds.pmcid) result.pmcid = resolvedIds.pmcid;
    if (!result.doi && resolvedIds.doi) result.doi = resolvedIds.doi;
  }

  const sectionsToFetch = sections?.filter(s => s !== 'core') || [];
  const limit = options?.limit ?? 20;

  const sectionPromises: Promise<void>[] = [];

  if (sectionsToFetch.includes('oa') || sectionsToFetch.includes('all')) {
    sectionPromises.push(
      fetchOpenAccess(pmid, resolvedIds?.pmcid).then(r => {
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['open_access'] = r;
      }).catch(e => {
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['open_access'] = { _error: String(e) };
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
        const articleId: ArticleId = { pmid, pmcid: resolvedIds?.pmcid || result.pmcid, doi: result.doi || resolvedIds?.doi };
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
