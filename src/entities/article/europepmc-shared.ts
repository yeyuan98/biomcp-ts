import type { CitationRecord } from './citation/types.js';

/** Shared field assumptions for Europe PMC REST (v6.9) response records,
 * used by the search, citation, and citation-count adapters. */

/** resulttype=lite search row */
export interface EuropePMCRecord {
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  journalVolume?: string | null;
  issue?: string | null;
  pageInfo?: string | null;
  firstPublicationDate?: string;
  citedByCount?: number;
  isOpenAccess?: string;
}

/** row from /{source}/{id}/citations and /references lists */
export interface EuropePMCCitationEntry {
  id?: string;
  source?: string;
  title?: string;
  authorString?: string;
  journalAbbreviation?: string;
  journalTitle?: string;
  volume?: string;
  issue?: string;
  pageInfo?: string;
  pubYear?: string | number;
}

export function cleanArticleTitle(title?: string): string | undefined {
  if (!title) return undefined;
  let s = title;
  let prev = '';
  // 1. Normalize sub/inf/sup: both escaped (&lt;sub&gt;...&lt;/sub&gt;) and raw (<sub>...</sub>)
  while (s !== prev) {
    prev = s;
    s = s.replace(/&lt;(?:sub|inf)\b.*?&gt;([\s\S]*?)&lt;\/(?:sub|inf)&gt;/gi, '($1)')
         .replace(/<(?:sub|inf)\b[^>]*>([\s\S]*?)<\/(?:sub|inf)>/gi, '($1)')
         .replace(/&lt;sup\b.*?&gt;([\s\S]*?)&lt;\/sup&gt;/gi, '($1)')
         .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, '($1)');
  }
  // 2. Strip formatting tags: both escaped and raw
  s = s.replace(/&lt;\/?(?:i|b|u|em|strong|small|tt|sc|italic|bold|underline|strike)\b.*?&gt;/gi, '')
       .replace(/<\/?(?:i|b|u|em|strong|small|tt|sc|italic|bold|underline|strike)\b[^>]*>/gi, '');
  // 3. Decode standard XML/HTML entities
  s = s.replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&apos;/g, "'")
       .replace(/&#(\d+);/g, (_, n) => {
         const code = parseInt(n, 10);
         return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
       })
       .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
         const code = parseInt(h, 16);
         return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
       });
  return s.trim() || undefined;
}

export function splitAuthors(authorString?: string): string[] | undefined {
  return authorString ? authorString.split(', ') : undefined;
}

export function parseYear(year?: string | number): number | undefined {
  if (year === undefined) return undefined;
  const parsed = parseInt(String(year), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function transformCitationEntry(entry: EuropePMCCitationEntry): CitationRecord {
  return {
    pmid: entry.source === 'MED' && entry.id !== undefined ? String(entry.id) : undefined,
    title: cleanArticleTitle(entry.title),
    authors: splitAuthors(entry.authorString),
    journal: entry.journalAbbreviation ?? entry.journalTitle,
    volume: entry.volume,
    issue: entry.issue,
    pages: entry.pageInfo,
    year: parseYear(entry.pubYear),
    source: 'europepmc',
  };
}
