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
    title: entry.title,
    authors: splitAuthors(entry.authorString),
    journal: entry.journalAbbreviation ?? entry.journalTitle,
    volume: entry.volume,
    issue: entry.issue,
    pages: entry.pageInfo,
    year: parseYear(entry.pubYear),
    source: 'europepmc',
  };
}
