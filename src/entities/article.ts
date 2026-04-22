import { connectionManager } from '../connections/manager.js';

const SECTION_TIMEOUT_MS = 8000;

export interface ArticleSearchOptions {
  source?: 'pubmed' | 'europepmc' | 'semantic_scholar' | 'pubtator' | 'litsense';
  limit?: number;
  offset?: number;
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
  
  if (source) {
    return searchSingleSource(query, source, limit, offset);
  }
  
  return federatedSearch(query, limit, offset);
}

async function federatedSearch(
  query: string,
  limit: number,
  offset: number
): Promise<Article[]> {
  const backends = [
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
  offset: number
): Promise<Article[]> {
  switch (source) {
    case 'pubmed': return searchPubMed(query, limit, offset);
    case 'europepmc': return searchEuropePMC(query, limit, offset);
    case 'semantic_scholar': return searchSemanticScholar(query, limit, offset);
    case 'pubtator': return searchPubTator(query, limit, offset);
    case 'litsense': return searchLitSense(query, limit, offset);
    default: return [];
  }
}

async function searchPubMed(query: string, limit: number, offset: number): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('pubmed');
    
    const response = await conn.request(
      `/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retstart=${offset}&retmode=json`
    ) as PubMedSearchResponse;
    
    if (!response.esearchresult?.idlist?.length) return [];
    
    const ids = response.esearchresult.idlist.join(',');
    const summaryResponse = await conn.request(
      `/esummary.fcgi?db=pubmed&id=${ids}&retmode=json`
    ) as PubMedSummaryResponse;
    
    return (summaryResponse.result || []).map(transformPubMedArticle);
  } catch {
    return [];
  }
}

async function searchEuropePMC(query: string, limit: number, offset: number): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('europepmc');
    
    const response = await conn.request(
      `/search?query=${encodeURIComponent(query)}&resulttype=lite&format=json&pageSize=${limit}&cursorMark=${offset}`
    ) as EuropePMCResponse;
    
    return (response.resultList?.result || []).map(transformEuropePMC);
  } catch {
    return [];
  }
}

async function searchSemanticScholar(query: string, limit: number, offset: number): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('semantic_scholar');
    
    const response = await conn.request(
      `/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&fields=title,abstract,authors,year,venue,citationCount,isOpenAccess,externalIds`
    ) as SemanticScholarResponse;
    
    return (response.data || []).map(transformSemanticScholar);
  } catch {
    return [];
  }
}

async function searchPubTator(query: string, limit: number, offset: number): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('pubtator');
    
    const response = await conn.request(
      `/search?q=${encodeURIComponent(query)}&format=json&limit=${limit}&offset=${offset}`
    ) as PubTatorResponse;
    
    return (response.results || []).map(transformPubTator);
  } catch {
    return [];
  }
}

async function searchLitSense(query: string, limit: number, offset: number): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('litsense');
    
    const response = await conn.request(
      `/search?q=${encodeURIComponent(query)}&format=json&limit=${limit}`
    ) as LitSenseResponse;
    
    return (response.results || []).map(transformLitSense);
  } catch {
    return [];
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

export async function articleGet(
  identifier: string,
  sections?: string[]
): Promise<ArticleResult> {
  const isPmid = /^\d+$/.test(identifier);
  
  let article: Article;
  
  if (isPmid) {
    article = await fetchPubMedArticle(identifier);
  } else {
    throw new Error(`Invalid identifier. Use PMID to fetch article details.`);
  }
  
  const result: ArticleResult = {
    ...article,
  };
  
  const sectionsToFetch = sections?.filter(s => s !== 'core') || [];
  
  if (sectionsToFetch.includes('oa') || sectionsToFetch.includes('all')) {
    result.sections = result.sections || {};
    (result.sections as Record<string, unknown>)['open_access'] = await fetchOpenAccess(identifier);
  }
  
  if (sectionsToFetch.includes('annotations') || sectionsToFetch.includes('all')) {
    result.sections = result.sections || {};
    (result.sections as Record<string, unknown>)['annotations'] = await fetchAnnotations(identifier);
  }
  
  if (sectionsToFetch.includes('graph') || sectionsToFetch.includes('all')) {
    result.sections = result.sections || {};
    (result.sections as Record<string, unknown>)['citation_graph'] = await fetchCitationGraph(identifier);
  }
  
  return result;
}

async function fetchPubMedArticle(pmid: string): Promise<Article> {
  try {
    const conn = connectionManager.getConnection('pubmed');
    
    const response = await conn.request(
      `/efetch.fcgi?db=pubmed&id=${pmid}&retmode=json`
    ) as PubMedFetchResponse;
    
    const article = response.result?.[0];
    if (!article) return {};
    
    return {
      pmid: article.uid,
      title: article.title,
      abstract: article.abstract,
      authors: article.authors?.map((a: { name: string }) => a.name),
      journal: article.source,
      publication_date: article.pubdate,
      source: 'pubmed',
    };
  } catch {
    return {};
  }
}

async function fetchOpenAccess(pmid: string): Promise<{ pmcid?: string; pdf_url?: string }> {
  try {
    const conn = connectionManager.getConnection('ncbi_idconv');
    
    const response = await conn.request(
      `?pmid=${pmid}&format=json`
    ) as IDConvResponse;
    
    if (response.pmcid) {
      const pmcConn = connectionManager.getConnection('pmc_oa');
      const oaResponse = await pmcConn.request(
        `?tool=biomcp&format=json`
      ) as OAResponse;
      
      return {
        pmcid: response.pmcid,
        pdf_url: oaResponse.uri,
      };
    }
  } catch {
    return {};
  }
  return {};
}

async function fetchAnnotations(pmid: string): Promise<Array<{ type: string; text: string; start: number; end: number }>> {
  try {
    const conn = connectionManager.getConnection('pubtator');
    
    const response = await conn.request(
      `/annotations?pmids=${pmid}&format=json`
    ) as PubTatorAnnotationsResponse;
    
    return (response.result?.[0]?.annotations || []).map(a => ({
      type: a.annotation_type,
      text: a.text,
      start: a.location.begin,
      end: a.location.end,
    }));
  } catch {
    return [];
  }
}

async function fetchCitationGraph(pmid: string): Promise<{ citations?: string[]; references?: string[] }> {
  try {
    const conn = connectionManager.getConnection('pubmed');
    
    const response = await conn.request(
      `/elink.fcgi?dbfrom=pubmed&linkname=pubmed_pubmed_citedin&id=${pmid}&retmode=json`
    ) as PubMedLinkResponse;
    
    const citations = response.linkset?.[0]?.linksetdb
      ?.find((l: { linkname: string }) => l.linkname === 'pubmed_pubmed_citedin')
      ?.link?.map((l: { id: string }) => l.id) || [];
    
    const refsResponse = await conn.request(
      `/elink.fcgi?dbfrom=pubmed&linkname=pubmed_pubmed_refs&id=${pmid}&retmode=json`
    ) as PubMedLinkResponse;
    
    const references = refsResponse.linkset?.[0]?.linksetdb
      ?.find((l: { linkname: string }) => l.linkname === 'pubmed_pubmed_refs')
      ?.link?.map((l: { id: string }) => l.id) || [];
    
    return { citations, references };
  } catch {
    return {};
  }
}

interface PubMedSearchResponse {
  esearchresult?: {
    idlist?: string[];
  };
}

interface PubMedSummaryResponse {
  result?: Array<{
    uid: string;
    title?: string;
    sortpubdate?: string;
    sortfirstauthor?: string;
    source?: string;
    pubtype?: string[];
  }>;
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
    pmid: string;
    pmcid: string;
    title: string;
    abstract: string;
  }>;
}

interface LitSenseResponse {
  results?: Array<{
    pmid: string;
    title: string;
    abstract: string;
    relevance_score: number;
  }>;
}

interface PubMedFetchResponse {
  result?: Array<{
    uid: string;
    title?: string;
    abstract?: string;
    authors?: Array<{ name: string }>;
    source?: string;
    pubdate?: string;
  }>;
}

interface IDConvResponse {
  pmcid?: string;
}

interface OAResponse {
  uri?: string;
}

interface PubTatorAnnotationsResponse {
  result?: Array<{
    pmid: string;
    annotations?: Array<{
      annotation_type: string;
      text: string;
      location: { begin: number; end: number };
    }>;
  }>;
}

interface PubMedLinkResponse {
  linkset?: Array<{
    linksetdb?: Array<{
      linkname: string;
      link?: Array<{ id: string }>;
    }>;
  }>;
}

export function transformPubMedArticle(a: PubMedSummaryItem): Article {
  return {
    pmid: a.uid,
    title: a.title,
    journal: a.source,
    publication_date: a.sortpubdate,
    source: 'pubmed',
  };
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
    pmid: a.pmid,
    pmcid: a.pmcid,
    title: a.title,
    abstract: a.abstract,
    source: 'pubtator',
  };
}

export function transformLitSense(a: LitSenseResult): Article {
  return {
    pmid: a.pmid,
    title: a.title,
    abstract: a.abstract,
    score: a.relevance_score,
    source: 'litsense',
  };
}

export function transformArticleResponse(data: PubMedFetchItem): Article {
  return {
    pmid: data.uid,
    title: data.title,
    abstract: data.abstract,
    authors: data.authors?.map((a: { name: string }) => a.name),
    journal: data.source,
    publication_date: data.pubdate,
  };
}

interface PubMedSummaryItem {
  uid: string;
  title?: string;
  sortpubdate?: string;
  source?: string;
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
  pmid: string;
  pmcid: string;
  title: string;
  abstract: string;
}

interface LitSenseResult {
  pmid: string;
  title: string;
  abstract: string;
  relevance_score: number;
}

interface PubMedFetchItem {
  uid: string;
  title?: string;
  abstract?: string;
  authors?: Array<{ name: string }>;
  source?: string;
  pubdate?: string;
}