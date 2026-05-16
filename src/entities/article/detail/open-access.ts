import { connectionManager } from '../../../connections/manager.js';
import { XMLParser } from 'fast-xml-parser';
import type { IDConvResponse } from './id-resolution.js';

export async function fetchOpenAccess(pmid: string, resolvedPmcid?: string): Promise<{ pmcid?: string; pdf_url?: string; license?: string; license_url?: string }> {
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
        pdf_url: links.pdf_url,
        license: links.license,
        license_url: links.license_url,
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchOpenAccess] Error:', error);
    return { _error: `Open access lookup failed (source: ncbi_idconv/pmc_oa): ${msg}. The article may not have open access content, or the data source may be temporarily unavailable.` } as any;
  }
  return {};
}

const CC_LICENSE_URLS: Record<string, string> = {
  'cc0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'cc by': 'https://creativecommons.org/licenses/by/4.0/',
  'cc by-nc': 'https://creativecommons.org/licenses/by-nc/4.0/',
  'cc by-nc-nd': 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
  'cc by-nc-sa': 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  'cc by-nd': 'https://creativecommons.org/licenses/by-nd/4.0/',
  'cc by-sa': 'https://creativecommons.org/licenses/by-sa/4.0/',
};

function licenseToUrl(license: string): string | undefined {
  const normalized = license.toLowerCase().replace(/\s+\d+(?:\.\d+)?\s*$/, '').trim();
  return CC_LICENSE_URLS[normalized];
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
