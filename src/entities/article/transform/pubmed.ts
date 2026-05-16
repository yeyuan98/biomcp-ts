import { XMLParser } from 'fast-xml-parser';
import type { Article } from '../types.js';

export function parsePubMedXml(xmlString: string): Article[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    isArray: (name: string) => {
      return ['PubmedArticle', 'Author', 'AbstractText', 'MeshHeading', 'PublicationType', 'ArticleId', 'Chemical', 'Keyword'].includes(name);
    },
  });

  let parsed: any;
  try {
    parsed = parser.parse(xmlString);
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
      Pagination?: { MedlinePgn?: string };
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

function extractDoiFromELocation(article: any): string | undefined {
  const eloc = article?.ELocationID;
  if (!eloc) return undefined;
  const arr = Array.isArray(eloc) ? eloc : [eloc];
  for (const e of arr) {
    if (e['@_EIdType'] === 'doi') return e['#text'];
  }
  return undefined;
}

function flattenHtmlTitle(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';

  const obj = value as Record<string, unknown>;
  let result = '';

  // Handle #text first (main text content)
  if (obj['#text']) {
    result += String(obj['#text']);
  }

  // Handle HTML tags in order (i, b, sub, sup, u, etc.)
  const htmlTags = ['i', 'b', 'sub', 'sup', 'u', 'em', 'strong', 'small', 'tt'];
  for (const tag of htmlTags) {
    const tagValue = obj[tag];
    if (tagValue) {
      const tagContents = Array.isArray(tagValue) ? tagValue : [tagValue];
      for (const content of tagContents) {
        const innerContent = flattenHtmlTitle(content);
        result += `<${tag}>${innerContent}</${tag}>`;
      }
    }
  }

  // Handle any other keys that aren't #text or known HTML tags
  for (const [key, val] of Object.entries(obj)) {
    if (key !== '#text' && !htmlTags.includes(key) && val !== undefined) {
      const innerContent = flattenHtmlTitle(val);
      if (innerContent) {
        result += `<${key}>${innerContent}</${key}>`;
      }
    }
  }

  return result;
}

function extractTitle(article: any): string | undefined {
  const title = article?.ArticleTitle;
  if (!title) return undefined;
  if (typeof title === 'string') return title;
  return flattenHtmlTitle(title);
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
    if (a.ForeName && a.LastName) return `${a.LastName} ${a.ForeName}`;
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
