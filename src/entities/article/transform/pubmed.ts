import { XMLParser } from 'fast-xml-parser';
import type { Article } from '../types.js';

function cleanInlineXml(text: string): string {
  let prev = '';
  let cur = text;
  while (cur !== prev) {
    prev = cur;
    cur = cur
      .replace(/<(?:sub|inf)\b[^>]*>([\s\S]*?)<\/(?:sub|inf)>/gi, '($1)')
      .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, '($1)');
  }
  return cur.replace(/<\/?(?:i|b|u|em|strong|small|tt|sc|italic|bold|underline|strike)\b[^>]*>/gi, '');
}

export function preprocessPubMedXml(xml: string): string {
  return xml
    .replace(/<ArticleTitle\b([^>]*)>([\s\S]*?)<\/ArticleTitle>/gi, (_, attrs, content) => {
      return `<ArticleTitle${attrs || ''}>${cleanInlineXml(content)}</ArticleTitle>`;
    })
    .replace(/<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/gi, (_, attrs, content) => {
      return `<AbstractText${attrs || ''}>${cleanInlineXml(content)}</AbstractText>`;
    })
    .replace(/<BookTitle\b([^>]*)>([\s\S]*?)<\/BookTitle>/gi, (_, attrs, content) => {
      return `<BookTitle${attrs || ''}>${cleanInlineXml(content)}</BookTitle>`;
    });
}

export function parsePubMedXml(xmlString: string): Article[] {
  const preprocessed = preprocessPubMedXml(xmlString);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    htmlEntities: true,
    isArray: (name: string) => {
      return ['PubmedArticle', 'Author', 'AbstractText', 'MeshHeading', 'PublicationType', 'ArticleId', 'Chemical', 'Keyword'].includes(name);
    },
  });

  let parsed: any;
  try {
    parsed = parser.parse(preprocessed);
  } catch (e) {
    throw new Error(`Failed to parse PubMed XML: ${(e as Error).message}`);
  }

  const articleSet = parsed?.PubmedArticleSet;
  if (!articleSet) return [];

  const articles: PubmedArticle[] = articleSet.PubmedArticle || [];
  return articles.map(extractArticle);
}

interface PubmedArticle {
  MedlineCitation?: {
    PMID?: { '#text': string };
    Article?: {
      Journal?: {
        Title?: string;
        ISOAbbreviation?: string;
        JournalIssue?: {
          Volume?: string;
          Issue?: string;
          PubDate?: {
            Year?: string;
            MedlineDate?: string;
            Month?: string;
            Day?: string;
          };
        };
      };
      ArticleTitle?: string;
      Pagination?: { MedlinePgn?: string; StartPage?: string; EndPage?: string };
      ELocationID?: Array<{ '#text': string; '@_EIdType': string }> | { '#text': string; '@_EIdType': string };
      Abstract?: {
        AbstractText?: Array<{ '#text': string; '@_Label'?: string }> | { '#text': string; '@_Label'?: string } | string;
      };
      AuthorList?: {
        Author?: Array<{
          LastName?: string;
          ForeName?: string;
          Initials?: string;
          AffiliationInfo?: Array<{ Affiliation: string }> | { Affiliation: string };
        }>;
      };
      PublicationTypeList?: {
        PublicationType?: Array<{ '#text': string }>;
      };
      Language?: string;
    };
    ChemicalList?: {
      Chemical?: Array<{
        NameOfSubstance?: { '#text': string };
      }>;
    };
    MeshHeadingList?: {
      MeshHeading?: Array<{
        DescriptorName?: { '#text': string; '@_MajorTopicYN'?: string };
      }>;
    };
    KeywordList?: {
      Keyword?: Array<{ '#text': string }>;
    };
  };
  PubmedData?: {
    ArticleIdList?: {
      ArticleId?: Array<{ '#text': string; '@_IdType': string }>;
    };
    PublicationStatus?: string;
    History?: {
      PubMedPubDate?: Array<{
        '@_PubStatus': string;
        Year: string;
        Month: string;
        Day: string;
      }>;
    };
  };
}

function extractArticle(raw: PubmedArticle): Article {
  const medline = raw.MedlineCitation || {};
  const article = medline.Article || {};
  const pubmedData = raw.PubmedData || {};

  const pmid = medline.PMID?.['#text'] || '';

  const articleIds = extractArticleIds(pubmedData);

  return {
    pmid,
    pmcid: articleIds.pmcid,
    doi: articleIds.doi || extractDoiFromELocation(article),
    title: extractTitle(article),
    abstract: extractAbstract(article),
    authors: extractAuthors(article),
    journal: article.Journal?.ISOAbbreviation || article.Journal?.Title,
    volume: article.Journal?.JournalIssue?.Volume,
    issue: article.Journal?.JournalIssue?.Issue,
    pages: extractPages(article),
    publication_date: extractPubDate(article),
    source: 'pubmed',
    mesh_headings: extractMeshHeadings(medline),
    publication_types: extractPublicationTypes(article),
    keywords: extractKeywords(medline),
    chemicals: extractChemicals(medline),
  };
}

function extractArticleIds(pubmedData: any): { doi?: string; pmcid?: string } {
  const ids = pubmedData?.ArticleIdList?.ArticleId;
  if (!ids) return {};
  const idArray = Array.isArray(ids) ? ids : [ids];
  const result: { doi?: string; pmcid?: string } = {};
  for (const id of idArray) {
    if (id['@_IdType'] === 'doi') result.doi = id['#text'];
    if (id['@_IdType'] === 'pmc') result.pmcid = id['#text'];
  }
  return result;
}

function extractELocationByType(article: any, idType: string): string | undefined {
  const eloc = article?.ELocationID;
  if (!eloc) return undefined;
  const arr = Array.isArray(eloc) ? eloc : [eloc];
  for (const e of arr) {
    if (e['@_EIdType'] === idType) return e['#text'];
  }
  return undefined;
}

function extractDoiFromELocation(article: any): string | undefined {
  return extractELocationByType(article, 'doi');
}

function extractPages(article: any): string | undefined {
  const pagination = article?.Pagination;
  if (pagination?.MedlinePgn) return pagination.MedlinePgn;
  if (pagination?.StartPage) {
    return pagination.EndPage ? `${pagination.StartPage}-${pagination.EndPage}` : pagination.StartPage;
  }
  return extractELocationByType(article, 'pii');
}

function extractTitle(article: any): string | undefined {
  const title = article?.ArticleTitle;
  if (!title) return undefined;
  if (typeof title === 'string') return title;
  if (typeof title === 'object' && title !== null) {
    if (title['#text']) return String(title['#text']);
  }
  return String(title);
}

function extractAbstract(article: any): string | undefined {
  const abstractEl = article?.Abstract?.AbstractText;
  if (!abstractEl) return undefined;

  if (typeof abstractEl === 'string') return abstractEl;

  const parts = Array.isArray(abstractEl) ? abstractEl : [abstractEl];
  return parts
    .map((p: any) => {
      const text = typeof p === 'string' ? p : (p['#text'] || '');
      const label = p['@_Label'];
      return label ? `${label}: ${text}` : text;
    })
    .join(' ');
}

function extractAuthors(article: any): string[] | undefined {
  const authors = article?.AuthorList?.Author;
  if (!authors) return undefined;
  const arr = Array.isArray(authors) ? authors : [authors];
  return arr.map((a: any) => {
    const given = a.ForeName || a.Initials;
    if (a.LastName && given) return `${a.LastName} ${given}`;
    return a.LastName || a.CollectiveName || '';
  }).filter((n: string) => n.length > 0);
}

function extractPubDate(article: any): string | undefined {
  const date = article?.Journal?.JournalIssue?.PubDate;
  if (!date) return undefined;
  if (date.MedlineDate) return date.MedlineDate;
  const parts = [date.Year, date.Month, date.Day].filter(Boolean);
  return parts.join(' ') || undefined;
}

function extractMeshHeadings(medline: any): string[] | undefined {
  const headings = medline?.MeshHeadingList?.MeshHeading;
  if (!headings) return undefined;
  const arr = Array.isArray(headings) ? headings : [headings];
  return arr.map((h: any) => {
    const dn = h.DescriptorName;
    return typeof dn === 'string' ? dn : (dn?.['#text'] || '');
  }).filter((s: string) => s);
}

function extractPublicationTypes(article: any): string[] | undefined {
  const types = article?.PublicationTypeList?.PublicationType;
  if (!types) return undefined;
  const arr = Array.isArray(types) ? types : [types];
  return arr.map((t: any) => typeof t === 'string' ? t : (t?.['#text'] || '')).filter((s: string) => s);
}

function extractKeywords(medline: any): string[] | undefined {
  const kw = medline?.KeywordList?.Keyword;
  if (!kw) return undefined;
  const arr = Array.isArray(kw) ? kw : [kw];
  return arr.map((k: any) => typeof k === 'string' ? k : (k?.['#text'] || '')).filter((s: string) => s);
}

function extractChemicals(medline: any): string[] | undefined {
  const chemicals = medline?.ChemicalList?.Chemical;
  if (!chemicals) return undefined;
  const arr = Array.isArray(chemicals) ? chemicals : [chemicals];
  return arr.map((c: any) => {
    const ns = c.NameOfSubstance;
    return typeof ns === 'string' ? ns : (ns?.['#text'] || '');
  }).filter((s: string) => s);
}
