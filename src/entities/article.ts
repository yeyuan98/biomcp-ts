import { connectionManager } from '../connections/manager.js';
import { parsePubMedXml } from '../transform/pubmed.js';
import { XMLParser } from 'fast-xml-parser';

export interface ArticleSearchOptions {
  source?: 'pubmed' | 'europepmc' | 'semantic_scholar' | 'pubtator' | 'litsense';
  limit?: number;
  offset?: number;
  cursorMark?: string;
  dateRange?: string;
}

interface ParsedDateRange {
  from?: string;
  to?: string;
}

export function parseDateRange(dateRange: string): ParsedDateRange {
  const [from, to] = dateRange.split('/');
  return {
    from: from || undefined,
    to: to || undefined,
  };
}

function formatPubMedDate(isoDate: string): string {
  return isoDate.replace(/-/g, '/');
}

export interface Article {
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  abstract?: string;
  authors?: string[];
  journal?: string;
  publication_date?: string;
  cited_by?: number;
  is_open_access?: boolean;
  source?: string;
  score?: number;
  mesh_headings?: string[];
  publication_types?: string[];
  keywords?: string[];
  chemicals?: string[];
}

export interface ArticleGetOptions {
  sections?: string[];
}

export interface ArticleResult extends Article {
  sections?: Record<string, unknown>;
}

export async function articleSearch(
  query: string,
  options: ArticleSearchOptions = {}
): Promise<Article[]> {
  const { source, limit = 10, offset = 0 } = options;
  const dateRange = options.dateRange ? parseDateRange(options.dateRange) : undefined;

  if (source) {
    return searchSingleSource(query, source, limit, offset, options.cursorMark, dateRange);
  }

  return federatedSearch(query, limit, offset, dateRange);
}

async function federatedSearch(
  query: string,
  limit: number,
  offset: number,
  dateRange?: ParsedDateRange
): Promise<Article[]> {
  const backends = dateRange
    ? [
        searchPubMed(query, limit, offset, dateRange),
        searchEuropePMC(query, limit, offset, undefined, dateRange),
        searchSemanticScholar(query, limit, offset, dateRange),
      ]
    : [
        searchPubMed(query, limit, offset),
        searchEuropePMC(query, limit, offset),
        searchSemanticScholar(query, limit, offset),
        searchPubTator(query, limit, offset),
        searchLitSense(query, limit, offset),
      ];

  const results = await Promise.allSettled(backends);
  const allArticles: Article[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allArticles.push(...result.value);
    }
  }

  return deduplicateAndRank(allArticles, limit);
}

async function searchSingleSource(
  query: string,
  source: string,
  limit: number,
  offset: number,
  cursorMark?: string,
  dateRange?: ParsedDateRange
): Promise<Article[]> {
  if (dateRange && (source === 'pubtator' || source === 'litsense')) {
    return [{ _error: `${source} does not support date filtering. Use pubmed, europepmc, or semantic_scholar.` } as any];
  }
  switch (source) {
    case 'pubmed': return searchPubMed(query, limit, offset, dateRange);
    case 'europepmc': return searchEuropePMC(query, limit, offset, cursorMark, dateRange);
    case 'semantic_scholar': return searchSemanticScholar(query, limit, offset, dateRange);
    case 'pubtator': return searchPubTator(query, limit, offset);
    case 'litsense': return searchLitSense(query, limit, offset);
    default: return [];
  }
}

async function searchPubMed(query: string, limit: number, offset: number, dateRange?: ParsedDateRange): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('pubmed');

    let searchUrl = `/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retstart=${offset}&retmode=json`;
    if (dateRange?.from || dateRange?.to) {
      searchUrl += `&datetype=pdat`;
      if (dateRange.from) searchUrl += `&mindate=${formatPubMedDate(dateRange.from)}`;
      if (dateRange.to) searchUrl += `&maxdate=${formatPubMedDate(dateRange.to)}`;
    }

    const searchResponse = await conn.request(searchUrl) as PubMedSearchResponse;

    if (!searchResponse.esearchresult?.idlist?.length) return [];

    const ids = searchResponse.esearchresult.idlist.join(',');
    const xmlString = await conn.request(
      `/efetch.fcgi?db=pubmed&id=${ids}&rettype=abstract`
    ) as string;

    return parsePubMedXml(xmlString);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchPubMed] Error:', error);
    return [{ _error: `searchPubMed failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

async function searchEuropePMC(query: string, limit: number, _offset: number, cursorMark?: string, dateRange?: ParsedDateRange): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('europepmc');

    let queryString = query;
    if (dateRange?.from || dateRange?.to) {
      const fromYear = dateRange.from ? dateRange.from.slice(0, 4) : '*';
      const toYear = dateRange.to ? dateRange.to.slice(0, 4) : '*';
      queryString += ` AND pub_year:[${fromYear} TO ${toYear}]`;
    }

    const cursor = cursorMark || '*';
    const response = await conn.request(
      `/search?query=${encodeURIComponent(queryString)}&resulttype=lite&format=json&pageSize=${limit}&cursorMark=${encodeURIComponent(cursor)}`
    ) as EuropePMCResponse;

    return (response.resultList?.result || []).map(transformEuropePMC);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchEuropePMC] Error:', error);
    return [{ _error: `searchEuropePMC failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

async function searchSemanticScholar(query: string, limit: number, offset: number, dateRange?: ParsedDateRange): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('semantic_scholar');

    let searchUrl = `/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&fields=title,abstract,authors,year,venue,citationCount,isOpenAccess,externalIds`;
    if (dateRange?.from || dateRange?.to) {
      const from = dateRange.from || '';
      const to = dateRange.to || '';
      searchUrl += `&publicationDateOrYear=${from}:${to}`;
    }

    const response = await conn.request(searchUrl) as SemanticScholarResponse;

    return (response.data || []).map(transformSemanticScholar);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchSemanticScholar] Error:', error);
    return [{ _error: `searchSemanticScholar failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

async function searchPubTator(query: string, limit: number, offset: number): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('pubtator');

    const response = await conn.request(
      `/search/?text=${encodeURIComponent(query)}`
    ) as PubTatorResponse;

    return (response.results || []).slice(offset, offset + limit).map(transformPubTator);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchPubTator] Error:', error);
    return [{ _error: `searchPubTator failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

async function searchLitSense(query: string, limit: number, _offset: number): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('litsense');

    const response = await conn.request(
      `/sentences/?query=${encodeURIComponent(query)}&size=${limit}`
    ) as LitSenseResponse;

    return (Array.isArray(response) ? response : []).slice(0, limit).map(transformLitSense);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchLitSense] Error:', error);
    return [{ _error: `searchLitSense failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

export function deduplicateAndRank(articles: Article[], limit: number): Article[] {
  const seen = new Map<string, Article>();

  for (const article of articles) {
    const key = article.pmid || article.pmcid || article.doi || '';
    if (key && !seen.has(key)) {
      seen.set(key, article);
    }
  }

  const unique = Array.from(seen.values());

  return unique
    .sort((a, b) => (b.cited_by || 0) - (a.cited_by || 0))
    .slice(0, limit);
}

export function parseArticleId(id: string): { type: 'pmid' | 'pmcid' | 'doi'; value: string } {
  const trimmed = id.trim();
  if (/^\d+$/.test(trimmed)) return { type: 'pmid', value: trimmed };
  if (/^PMC\d+$/i.test(trimmed)) return { type: 'pmcid', value: trimmed };
  const doiMatch = trimmed.match(/^(?:doi:)?(10\.\d{4,}\/\S+)$/i);
  if (doiMatch) return { type: 'doi', value: doiMatch[1] };
  throw new Error(`Unrecognized identifier format: "${id}". Expected PMID (numeric), PMCID (PMC...), or DOI (10.x/...).`);
}

interface ResolvedPmid {
  pmid: string;
  pmcid?: string;
  doi?: string;
}

async function resolveToPmid(id: string, type: 'doi' | 'pmcid'): Promise<ResolvedPmid> {
  try {
    const conn = connectionManager.getConnection('ncbi_idconv');

    const response = await conn.request(
      `?ids=${encodeURIComponent(id)}&format=json`
    ) as IDConvResponse;

    const record = response.records?.[0];
    if (!record) {
      throw new Error(`No record returned for ${type}: "${id}". The identifier may not exist in the NCBI database.`);
    }
    if (record.errmsg || record.status === 'error') {
      throw new Error(`Could not resolve ${type} "${id}": ${record.errmsg || 'Unknown error'}.`);
    }
    if (!record.pmid) {
      throw new Error(`Could not resolve ${type} "${id}" to a PMID. The article may not be indexed in PubMed.`);
    }

    return {
      pmid: String(record.pmid),
      pmcid: record.pmcid,
      doi: record.doi,
    };
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('Could not resolve') || error.message.startsWith('No record'))) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[resolveToPmid] Error:', error);
    throw new Error(`ID resolution failed (source: ncbi_idconv): ${msg}. The data source may be temporarily unavailable.`);
  }
}

async function resolveDoiToPmid(doi: string): Promise<ResolvedPmid> {
  try {
    const conn = connectionManager.getConnection('pubmed');

    const searchResponse = await conn.request(
      `/esearch.fcgi?db=pubmed&term=${encodeURIComponent(doi)}[doi]&retmode=json&retmax=1`
    ) as PubMedSearchResponse;

    const pmid = searchResponse.esearchresult?.idlist?.[0];
    if (!pmid) {
      throw new Error(`Could not resolve doi "${doi}" to a PMID. The DOI may not be indexed in PubMed.`);
    }

    return { pmid, doi };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Could not resolve')) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[resolveDoiToPmid] Error:', error);
    throw new Error(`DOI resolution failed (source: pubmed): ${msg}. The data source may be temporarily unavailable.`);
  }
}

export async function articleGet(
  identifier: string,
  sections?: string[]
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

  if (resolvedIds) {
    if (!result.pmid) result.pmid = resolvedIds.pmid;
    if (!result.pmcid && resolvedIds.pmcid) result.pmcid = resolvedIds.pmcid;
    if (!result.doi && resolvedIds.doi) result.doi = resolvedIds.doi;
  }

  const sectionsToFetch = sections?.filter(s => s !== 'core') || [];

  if (sectionsToFetch.includes('oa') || sectionsToFetch.includes('all')) {
    result.sections = result.sections || {};
    (result.sections as Record<string, unknown>)['open_access'] = await fetchOpenAccess(pmid, resolvedIds?.pmcid);
  }

  if (sectionsToFetch.includes('annotations') || sectionsToFetch.includes('all')) {
    result.sections = result.sections || {};
    (result.sections as Record<string, unknown>)['annotations'] = await fetchAnnotations(pmid);
  }

  if (sectionsToFetch.includes('graph') || sectionsToFetch.includes('all')) {
    result.sections = result.sections || {};
    (result.sections as Record<string, unknown>)['citation_graph'] = await fetchCitationGraph(pmid);
  }

  return result;
}

async function fetchPubMedArticle(pmid: string): Promise<Article> {
  try {
    const conn = connectionManager.getConnection('pubmed');

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

async function fetchOpenAccess(pmid: string, resolvedPmcid?: string): Promise<{ pmcid?: string; pdf_url?: string }> {
  try {
    let pmcid = resolvedPmcid;

    if (!pmcid) {
      const conn = connectionManager.getConnection('ncbi_idconv');

      const response = await conn.request(
        `?ids=${pmid}&format=json`
      ) as IDConvResponse;

      const record = response.records?.[0];
      if (record?.errmsg || record?.status === 'error') {
        return {};
      }
      pmcid = record?.pmcid;
    }

    if (pmcid) {
      const pmcConn = connectionManager.getConnection('pmc_oa');
      const oaXml = await pmcConn.request(
        `?id=${pmcid}`
      ) as string;

      const links = parseOaXml(oaXml);
      return {
        pmcid,
        pdf_url: links.pdfUrl,
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchOpenAccess] Error:', error);
    return { _error: `Open access lookup failed (source: ncbi_idconv/pmc_oa): ${msg}. The article may not have open access content, or the data source may be temporarily unavailable.` } as any;
  }
  return {};
}

function parseOaXml(xml: string): { pdfUrl?: string } {
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    const parsed = parser.parse(xml);

    const links = parsed?.OA?.records?.record?.[0]?.link
      ?? parsed?.records?.record?.[0]?.link
      ?? parsed?.link;

    const linkArray = Array.isArray(links) ? links : links ? [links] : [];

    for (const link of linkArray) {
      if (link?.['@_format'] === 'pdf' && link?.['#text']) {
        return { pdfUrl: link['#text'] };
      }
    }

    for (const link of linkArray) {
      if (link?.['#text']) {
        return { pdfUrl: link['#text'] };
      }
    }

    return {};
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[parseOaXml] Error:', error);
    return { _error: `OA XML parsing failed: ${msg}. The response format may have changed.` } as any;
  }
}

async function fetchAnnotations(pmid: string): Promise<Array<{ type: string; text: string; start: number; end: number }>> {
  try {
    const conn = connectionManager.getConnection('pubtator');

    const response = await conn.request(
      `/publications/export/biocjson?pmids=${pmid}`
    ) as BioCJSONResponse;

    let items: BioCJSONArticle[] = [];
    
    const rawItems = response?.PubTator3 ?? response;
    if (Array.isArray(rawItems)) {
      items = rawItems;
    } else if (rawItems && typeof rawItems === 'object') {
      const wrapper = rawItems as Record<string, unknown>;
      for (const key of Object.keys(wrapper)) {
        if (Array.isArray(wrapper[key])) {
          items = wrapper[key] as BioCJSONArticle[];
          break;
        }
      }
    }

    const annotations: Array<{ type: string; text: string; start: number; end: number }> = [];
    for (const article of items) {
      for (const passage of (article.passages || [])) {
        for (const ann of (passage.annotations || [])) {
          annotations.push({
            type: ann.infons?.type || 'unknown',
            text: ann.text,
            start: ann.locations?.[0]?.offset ?? 0,
            end: (ann.locations?.[0]?.offset ?? 0) + (ann.locations?.[0]?.length ?? 0),
          });
        }
      }
    }

    return annotations;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchAnnotations] Error:', error);
    let hint = ' The data source may be temporarily unavailable.';
    if (msg.includes('400')) {
      hint = ' This article may not yet be indexed by PubTator. Try an older article with an established PMID.';
    } else if (msg.includes('429')) {
      hint = ' Rate limited by PubTator. Wait a few seconds and retry.';
    }
    return [{ _error: `Annotation lookup failed (source: pubtator): ${msg}.${hint}` } as any];
  }
}

async function fetchCitationGraph(pmid: string): Promise<{ citations?: string[]; references?: string[] }> {
  try {
    const conn = connectionManager.getConnection('pubmed');

    const response = await conn.request(
      `/elink.fcgi?dbfrom=pubmed&linkname=pubmed_pubmed_citedin&id=${pmid}&retmode=json`
    ) as PubMedLinkResponse;

    const citations = response.linksets?.[0]?.linksetdbs
      ?.find((l: { linkname: string }) => l.linkname === 'pubmed_pubmed_citedin')
      ?.links?.map((l: string | { id: string }) => typeof l === 'string' ? l : l.id) || [];

    const refsResponse = await conn.request(
      `/elink.fcgi?dbfrom=pubmed&linkname=pubmed_pubmed_refs&id=${pmid}&retmode=json`
    ) as PubMedLinkResponse;

    const references = refsResponse.linksets?.[0]?.linksetdbs
      ?.find((l: { linkname: string }) => l.linkname === 'pubmed_pubmed_refs')
      ?.links?.map((l: string | { id: string }) => typeof l === 'string' ? l : l.id) || [];

    return { citations, references };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchCitationGraph] Error:', error);
    let hint = ' The data source may be temporarily unavailable.';
    if (msg.includes('429')) {
      hint = ' Rate limited by PubMed E-utilities. Wait a few seconds and retry. If persistent, set NCBI_API_KEY for higher rate limits.';
    } else if (msg.includes('400')) {
      hint = ' The PMID may not be recognized by PubMed E-utilities. Verify the PMID is correct.';
    }
    return { _error: `Citation graph lookup failed (source: pubmed): ${msg}.${hint}` } as any;
  }
}

interface PubMedSearchResponse {
  esearchresult?: {
    idlist?: string[];
  };
}

interface EuropePMCResponse {
  resultList?: {
    result?: Array<{
      pubmedId?: string;
      pmcId?: string;
      doi?: string;
      title?: string;
      authorString?: string;
      journalTitle?: string;
      firstPublicationDate?: string;
      citedByCount?: number;
      isOpenAccess?: string;
    }>;
  };
}

interface SemanticScholarResponse {
  data?: Array<{
    paperId?: string;
    title?: string;
    abstract?: string;
    authors?: Array<{ name: string }>;
    year?: number;
    venue?: string;
    citationCount?: number;
    isOpenAccess?: boolean;
    externalIds?: {
      PMID?: string;
      PMCID?: string;
      DOI?: string;
    };
  }>;
}

interface PubTatorResponse {
  results?: Array<{
    _id: string;
    pmid: number;
    pmcid?: string;
    title: string;
    journal?: string;
    authors?: string[];
    date?: string;
    doi?: string;
    score?: number;
  }>;
}

interface LitSenseResponse {
  pmid: number;
  pmcid?: string;
  text: string;
  score: number;
  section: string;
  annotations: string[];
}

interface IDConvResponse {
  status?: string;
  records?: Array<{
    doi?: string;
    pmcid?: string;
    pmid?: number;
    requestedId?: string;
    status?: string;
    errmsg?: string;
  }>;
}

interface BioCJSONResponse {
  PubTator3?: BioCJSONArticle[];
}

interface BioCJSONArticle {
  passages?: Array<{
    text?: string;
    annotations?: Array<{
      infons?: { type?: string; identifier?: string };
      text: string;
      locations?: Array<{ offset: number; length: number }>;
    }>;
  }>;
}

interface PubMedLinkResponse {
  linksets?: Array<{
    linksetdbs?: Array<{
      linkname: string;
      links?: Array<string | { id: string }>;
    }>;
  }>;
}

export function transformEuropePMC(a: EuropePMCResult): Article {
  return {
    pmid: a.pubmedId,
    pmcid: a.pmcId,
    doi: a.doi,
    title: a.title,
    authors: a.authorString?.split(', '),
    journal: a.journalTitle,
    publication_date: a.firstPublicationDate,
    cited_by: a.citedByCount,
    is_open_access: a.isOpenAccess === 'Y',
    source: 'europepmc',
  };
}

export function transformSemanticScholar(a: SemanticScholarPaper): Article {
  return {
    pmid: a.externalIds?.PMID,
    pmcid: a.externalIds?.PMCID,
    doi: a.externalIds?.DOI,
    title: a.title,
    abstract: a.abstract,
    authors: a.authors?.map((au: { name: string }) => au.name),
    journal: a.venue,
    publication_date: a.year ? String(a.year) : undefined,
    cited_by: a.citationCount,
    is_open_access: a.isOpenAccess,
    source: 'semantic_scholar',
  };
}

export function transformPubTator(a: PubTatorResult): Article {
  return {
    pmid: String(a.pmid),
    pmcid: a.pmcid,
    title: a.title,
    authors: a.authors,
    journal: a.journal,
    doi: a.doi,
    publication_date: a.date,
    score: a.score,
    source: 'pubtator',
  };
}

export function transformLitSense(a: LitSenseResult): Article {
  return {
    pmid: String(a.pmid),
    pmcid: a.pmcid,
    abstract: a.text,
    score: a.score,
    source: 'litsense',
  };
}

interface EuropePMCResult {
  pubmedId?: string;
  pmcId?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  firstPublicationDate?: string;
  citedByCount?: number;
  isOpenAccess?: string;
}

interface SemanticScholarPaper {
  title?: string;
  abstract?: string;
  authors?: Array<{ name: string }>;
  year?: number;
  venue?: string;
  citationCount?: number;
  isOpenAccess?: boolean;
  externalIds?: {
    PMID?: string;
    PMCID?: string;
    DOI?: string;
  };
}

interface PubTatorResult {
  _id: string;
  pmid: number;
  pmcid?: string;
  title: string;
  journal?: string;
  authors?: string[];
  date?: string;
  doi?: string;
  score?: number;
}

interface LitSenseResult {
  pmid: number;
  pmcid?: string;
  text: string;
  score: number;
  section: string;
  annotations: string[];
}
