import { connectionManager } from '../../../connections/manager.js';
import { withTimeout } from '../../../connections/fetch-utils.js';

/** Shared with fulltext.ts semantics: per-leg bound for oa/fulltext
 * lookups (15 s keeps search + two XML legs inside the 60 s tool budget). */
const FULLTEXT_LEG_TIMEOUT_MS = 15000;

export type OpenAccessStatus = 'open_access' | 'free_to_read' | 'paywalled' | 'not_in_pmc' | 'unknown';

export interface OpenAccessLinks {
  /** Browser page for the PMC-hosted article */
  pmc_url?: string;
  /** Programmatically fetchable PDF (publisher/Unpaywall only — PMC and
   * Europe PMC render endpoints answer non-browser clients with 403/HTML) */
  pdf_url?: string;
  /** Browser page for the Europe PMC-hosted article */
  epmc_url?: string;
  /** Publisher page via DOI */
  doi_url?: string;
}

export interface OpenAccessResult {
  pmcid?: string;
  status: OpenAccessStatus;
  /** True only when sections=["fulltext"] is known to return content for
   * this article (status open_access/free_to_read). */
  full_text_available: boolean;
  is_open_access?: boolean;
  license?: string;
  license_url?: string;
  links?: OpenAccessLinks;
  note: string;
  source: 'europepmc';
  _error?: string;
}

export interface EuropePmcCoreRecord {
  pmcid?: string;
  doi?: string;
  isOpenAccess?: string;
  inPMC?: string;
  inEPMC?: string;
  license?: string;
  fullTextUrlList?: {
    fullTextUrl?: Array<{
      availability?: string;
      documentStyle?: string;
      site?: string;
      url?: string;
    }>;
  };
}

/** Europe PMC availability labels that mark a link as free to read
 * (live-verified enum: 'Open access' | 'Free' | 'Subscription required'). */
const FREE_AVAILABILITY = new Set(['Open access', 'Free']);

/**
 * Look up the Europe PMC core record for a PMCID. Returns null when Europe
 * PMC answers successfully but has no record (hitCount 0); transport errors
 * propagate to the caller. Shared by the oa section and the fulltext
 * section so a combined request issues a single search.
 */
export async function fetchEuropePmcCoreRecord(pmcid: string): Promise<EuropePmcCoreRecord | null> {
  const conn = connectionManager.getConnection('europepmc');
  const response = await conn.request(
    `/search?query=${encodeURIComponent(`PMCID:${pmcid}`)}&resultType=core&format=json&pageSize=1`
  ) as { hitCount?: number; resultList?: { result?: EuropePmcCoreRecord[] } };
  const record = response?.resultList?.result?.[0];
  return record ?? null;
}

function isFreeFullTextLink(link: { availability?: string; url?: string }): boolean {
  return !!link.availability && FREE_AVAILABILITY.has(link.availability) && !!link.url;
}

function pickPdfUrl(record: EuropePmcCoreRecord): string | undefined {
  const links = record.fullTextUrlList?.fullTextUrl ?? [];
  // Only Unpaywall-sourced publisher PDFs answer non-browser clients with a
  // real PDF; Europe_PMC (?pdf=render) 403s and PubMedCentral serves an HTML
  // viewer — those stay available as browser links (pmc_url/epmc_url).
  return links.find(l =>
    l.documentStyle === 'pdf' && l.site === 'Unpaywall' && isFreeFullTextLink(l)
  )?.url;
}

function statusNote(status: OpenAccessStatus): string {
  switch (status) {
    case 'open_access':
      return 'Open access (Creative Commons or similar license); fetch the text via sections=["fulltext"]. links.pmc_url/epmc_url are browser pages; pdf_url (when present) is machine-fetchable.';
    case 'free_to_read':
      return 'Free to read, but under publisher copyright (no CC license) — reuse may be restricted. Fetch the text via sections=["fulltext"]. links.pmc_url/epmc_url are browser pages; pdf_url (when present) is machine-fetchable.';
    case 'paywalled':
      return 'A PMC record exists but the full text is not free to read (embargo or subscription); sections=["fulltext"] cannot fetch it. The publisher page is links.doi_url; the abstract is in the top-level abstract field.';
    case 'not_in_pmc':
      return 'No PMC record — no full text to fetch here. The publisher page is links.doi_url; the abstract is in the top-level abstract field.';
    case 'unknown':
      return 'Europe PMC carries no access metadata for this PMC record; try sections=["fulltext"] — the PMC copy may still be retrievable via E-utilities.';
  }
}

/**
 * Open-access metadata for an article, derived from one Europe PMC core
 * record. Replaces the retired NCBI oa.fcgi service (removed upstream
 * 2026; https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi answers 404).
 */
export async function fetchOpenAccess(pmcid: string | undefined, doi?: string): Promise<OpenAccessResult> {
  if (!pmcid) {
    return {
      status: 'not_in_pmc',
      full_text_available: false,
      links: doi ? { doi_url: `https://doi.org/${doi}` } : undefined,
      note: statusNote('not_in_pmc'),
      source: 'europepmc',
    };
  }

  let record: EuropePmcCoreRecord | null;
  try {
    // Bounded so a stalling search cannot chain into the fulltext legs
    // past the 60 s article_get budget (the connection's own retry x
    // 15 s timeout could otherwise reach ~45 s alone).
    record = await withTimeout(fetchEuropePmcCoreRecord(pmcid), FULLTEXT_LEG_TIMEOUT_MS, { onTimeout: 'null', label: 'europepmc oa search' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchOpenAccess] Error:', error);
    return {
      pmcid,
      status: 'unknown',
      full_text_available: false,
      note: statusNote('unknown'),
      source: 'europepmc',
      _error: `Open access lookup failed (source: europepmc): ${msg}. The data source may be temporarily unavailable.`,
    } as OpenAccessResult;
  }

  const links: OpenAccessLinks = {
    pmc_url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
    epmc_url: `https://europepmc.org/articles/${pmcid}`,
  };
  if (doi) links.doi_url = `https://doi.org/${doi}`;

  if (!record) {
    // PMCID verified via idconv, but Europe PMC has no record for it: this
    // is a data gap, not a transport failure — never report not_in_pmc here.
    return {
      pmcid,
      status: 'unknown',
      full_text_available: false,
      links,
      note: statusNote('unknown'),
      source: 'europepmc',
    };
  }

  const pdfUrl = pickPdfUrl(record);
  if (pdfUrl) links.pdf_url = pdfUrl;

  const fullTextLinks = record.fullTextUrlList?.fullTextUrl ?? [];
  // Any free link — PMC/EPMC-hosted or a free publisher/Unpaywall PDF —
  // marks the record free to read; restricting to PMC-site links would
  // classify some records paywalled while simultaneously advertising a
  // machine-fetchable free pdf_url.
  const hasFreeFullText = fullTextLinks.some(isFreeFullTextLink);

  let status: OpenAccessStatus;
  if (record.isOpenAccess === 'Y') {
    status = 'open_access';
  } else if (hasFreeFullText) {
    status = 'free_to_read';
  } else if (record.inPMC === 'Y' || record.inEPMC === 'Y') {
    status = 'paywalled';
  } else {
    status = 'unknown';
  }

  const result: OpenAccessResult = {
    pmcid,
    status,
    full_text_available: status === 'open_access' || status === 'free_to_read',
    links,
    note: statusNote(status),
    source: 'europepmc',
  };
  if (record.isOpenAccess === 'Y' || record.isOpenAccess === 'N') {
    result.is_open_access = record.isOpenAccess === 'Y';
  }
  if (record.license) {
    result.license = record.license;
    result.license_url = licenseToUrl(record.license);
  }
  return result;
}

const CC_LICENSE_URLS: Record<string, string> = {
  'cc0': 'https://creativecommons.org/publicdomain/zero/',
  'cc by': 'https://creativecommons.org/licenses/by/',
  'cc by-nc': 'https://creativecommons.org/licenses/by-nc/',
  'cc by-nc-nd': 'https://creativecommons.org/licenses/by-nc-nd/',
  'cc by-nc-sa': 'https://creativecommons.org/licenses/by-nc-sa/',
  'cc by-nd': 'https://creativecommons.org/licenses/by-nd/',
  'cc by-sa': 'https://creativecommons.org/licenses/by-sa/',
};

export function licenseToUrl(license: string): string | undefined {
  // Keep the declared version when present ("cc by 3.0" -> .../by/3.0/);
  // default to 4.0 for bare names.
  const match = license.toLowerCase().match(/^(.*?)\s+(\d+(?:\.\d+)?)\s*$/);
  const key = (match ? match[1] : license.toLowerCase()).trim();
  const base = CC_LICENSE_URLS[key];
  if (!base) return undefined;
  const version = match ? match[2] : '4.0';
  return `${base}${version}/`;
}
