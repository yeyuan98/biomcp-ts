import { connectionManager } from '../../../connections/manager.js';
import { XMLParser } from 'fast-xml-parser';
import type { IDConvResponse } from './id-resolution.js';

export interface OpenAccessResult {
  pmcid?: string;
  pdf_url?: string;
  license?: string;
  license_url?: string;
  source?: 'pmc_oa' | 'europepmc';
}

interface EuropePmcSearchResponse {
  resultList?: {
    result?: Array<{
      license?: string;
      isOpenAccess?: string;
      fullTextUrlList?: {
        fullTextUrlList?: Array<{ documentStyle?: string; availability?: string; url?: string }>;
      };
    }>;
  };
}

/**
 * Europe PMC fallback for OA metadata: NCBI's oa.fcgi is unreachable from
 * some networks (datacenter-IP 404s), but Europe PMC carries the same
 * license + full-text link information via its core search records.
 */
async function fetchOaFromEuropePmc(pmcid: string): Promise<OpenAccessResult | null> {
  try {
    const conn = connectionManager.getConnection('europepmc');
    const response = await conn.request(
      `/search?query=${encodeURIComponent(`PMCID:${pmcid}`)}&resultType=core&format=json&pageSize=1`
    ) as EuropePmcSearchResponse;

    const record = response?.resultList?.result?.[0];
    if (!record) return null;

    const result: OpenAccessResult = { pmcid, source: 'europepmc' };
    const links = record.fullTextUrlList?.fullTextUrlList ?? [];
    const pdf = links.find(l => l.documentStyle === 'pdf' && l.availability === 'Open access')
      // Only trust publisher pdf links (no Open-access marker) when Europe
      // PMC itself flags the record as open access — never advertise
      // paywalled full text as OA.
      ?? (record.isOpenAccess === 'Y' ? links.find(l => l.documentStyle === 'pdf') : undefined);
    if (pdf?.url) result.pdf_url = pdf.url;
    if (record.license) {
      result.license = record.license;
      result.license_url = licenseToUrl(record.license);
    }
    // An info-less record (no license, no pdf) is not a usable fallback —
    // returning it would mask the primary source's error with empty data.
    if (!result.license && !result.pdf_url) return null;
    return result;
  } catch {
    return null;
  }
}

export async function fetchOpenAccess(pmid: string, resolvedPmcid?: string): Promise<OpenAccessResult> {
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
      let pmcOaThrew = false;
      let pmcOaError: unknown = null;
      let pmcOaResult: OpenAccessResult | null = null;
      try {
        const pmcConn = connectionManager.getConnection('pmc_oa');
        const oaXml = await pmcConn.request(
          `?id=${pmcid}`
        ) as string;

        const links = parseOaXml(oaXml);
        pmcOaResult = {
          pmcid,
          pdf_url: links.pdf_url,
          license: links.license,
          license_url: links.license_url,
          source: 'pmc_oa',
        };
      } catch (error) {
        pmcOaThrew = true;
        pmcOaError = error;
      }

      // pmc_oa unreachable (e.g. datacenter-IP 404s) OR answered without
      // license/pdf metadata (non-OA PMCID): give Europe PMC a chance — it
      // carries license data for PMC-hosted records either way.
      const pmcOaIsEmpty = !!pmcOaResult && !pmcOaResult.license && !pmcOaResult.pdf_url;
      if (pmcOaThrew || pmcOaIsEmpty) {
        const fallback = await fetchOaFromEuropePmc(pmcid);
        if (fallback) {
          return fallback;
        }
      }

      if (pmcOaThrew) {
        const msg = pmcOaError instanceof Error ? pmcOaError.message : String(pmcOaError);
        return { _error: `Open access lookup failed (source: ncbi_idconv/pmc_oa, fallback: europepmc): ${msg}. The article may not have open access content, or the data sources may be temporarily unavailable.` } as any;
      }

      // Clean pmcid-only result is legitimate for non-OA articles.
      return pmcOaResult!;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchOpenAccess] Error:', error);
    return { _error: `Open access lookup failed (source: ncbi_idconv/pmc_oa): ${msg}. The article may not have open access content, or the data source may be temporarily unavailable.` } as any;
  }
  return {};
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

function licenseToUrl(license: string): string | undefined {
  // Keep the declared version when present ("cc by 3.0" -> .../by/3.0/);
  // default to 4.0 for bare names.
  const match = license.toLowerCase().match(/^(.*?)\s+(\d+(?:\.\d+)?)\s*$/);
  const key = (match ? match[1] : license.toLowerCase()).trim();
  const base = CC_LICENSE_URLS[key];
  if (!base) return undefined;
  const version = match ? match[2] : '4.0';
  return `${base}${version}/`;
}

export function parseOaXml(xml: string): { pdf_url?: string; license?: string; license_url?: string } {
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    const parsed = parser.parse(xml);

    const recordRaw = parsed?.OA?.records?.record
      ?? parsed?.records?.record
      ?? parsed?.OA?.record
      ?? parsed?.record;
    const record = Array.isArray(recordRaw) ? recordRaw[0] : recordRaw;

    const links = record?.link ?? parsed?.link;
    const linkArray = Array.isArray(links) ? links : links ? [links] : [];

    let pdfUrl: string | undefined;
    for (const link of linkArray) {
      const href = link?.['@_href'] || link?.['#text'];
      if (link?.['@_format'] === 'pdf' && href) {
        pdfUrl = href;
        break;
      }
    }
    if (!pdfUrl) {
      for (const link of linkArray) {
        const href = link?.['@_href'] || link?.['#text'];
        if (href) {
          pdfUrl = href;
          break;
        }
      }
    }

    const licenseAttr = record?.['@_license'];
    const result: { pdf_url?: string; license?: string; license_url?: string } = {};
    if (pdfUrl) result.pdf_url = pdfUrl;
    if (licenseAttr) {
      result.license = licenseAttr;
      result.license_url = licenseToUrl(licenseAttr);
    }

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[parseOaXml] Error:', error);
    return { _error: `OA XML parsing failed: ${msg}. The response format may have changed.` } as any;
  }
}
