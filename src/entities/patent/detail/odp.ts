import { connectionManager } from '../../../connections/manager.js';
import { RestConnection } from '../../../connections/rest.js';
import { hasOdpKey } from '../search/odp.js';
import type { PatentResult } from '../types.js';

interface OdpMetaData {
  inventionTitle?: string;
  firstApplicantName?: string;
  firstInventorName?: string;
  filingDate?: string;
  grantDate?: string;
  patentNumber?: string | null;
  applicationStatusDescriptionText?: string;
  earliestPublicationNumber?: string;
  earliestPublicationDate?: string;
  cpcClassificationBag?: { cpcClassificationBag?: Array<{ classification?: string }> };
}

interface OdpWrapper {
  applicationNumberText?: string;
  applicationMetaData?: OdpMetaData;
  parentContinuityBag?: unknown;
  childContinuityBag?: unknown;
  grantDocumentMetaData?: unknown;
}

export async function fetchOdpCore(publicationNumber: string): Promise<PatentResult> {
  if (!hasOdpKey()) {
    throw new Error('USPTO Open Data Portal key not configured. Set USPTO_API_KEY.');
  }

  const bare = publicationNumber.toUpperCase().replace(/^US/, '').replace(/[A-Z]\d?$/, '');
  const conn = connectionManager.getConnection('uspto_odp') as RestConnection;

  // Granted patents are reachable by patentNumber; applications by their
  // earliest publication number; both fall back to a validated text search.
  let wrapper: OdpWrapper | undefined;
  const attempts: Array<() => Promise<{ patentFileWrapperDataBag?: OdpWrapper[] }>> = [
    () => conn.post('/api/v1/patent/applications/search', {
      q: `applicationMetaData.patentNumber:"${bare}"`,
      pagination: { offset: 0, limit: 1 },
    }) as Promise<{ patentFileWrapperDataBag?: OdpWrapper[] }>,
    () => conn.post('/api/v1/patent/applications/search', {
      q: `applicationMetaData.earliestPublicationNumber:"${bare}"`,
      pagination: { offset: 0, limit: 1 },
    }) as Promise<{ patentFileWrapperDataBag?: OdpWrapper[] }>,
    () => conn.post('/api/v1/patent/applications/search', {
      q: `(${bare})`,
      pagination: { offset: 0, limit: 1 },
    }) as Promise<{ patentFileWrapperDataBag?: OdpWrapper[] }>,
  ];

  for (const attempt of attempts) {
    try {
      const raw = await attempt();
      const candidate = raw.patentFileWrapperDataBag?.[0];
      if (candidate?.applicationMetaData) {
        const md = candidate.applicationMetaData;
        const target = bare.replace(/^0+/, '');
        const candidates = [
          md.patentNumber && String(md.patentNumber).replace(/^0+/, ''),
          md.earliestPublicationNumber && String(md.earliestPublicationNumber).replace(/^US|^0+/, ''),
        ].filter(Boolean);
        if (candidates.some(c => c === target)) {
          wrapper = candidate;
          break;
        }
      }
    } catch {
      // try next lookup strategy
    }
  }

  if (!wrapper?.applicationMetaData) {
    throw new Error(`Patent '${publicationNumber}' not found in USPTO Open Data Portal.`);
  }

  const md = wrapper.applicationMetaData;
  const patentNumber = md.patentNumber ? String(md.patentNumber) : undefined;
  const cpc = (md.cpcClassificationBag?.cpcClassificationBag || [])
    .map(c => c.classification)
    .filter((x): x is string => !!x);

  return {
    publication_number: patentNumber
      ? `US${patentNumber.padStart(8, '0')}`
      : `US${bare}`,
    title: md.inventionTitle,
    publication_date: md.grantDate || md.earliestPublicationDate,
    filing_date: md.filingDate,
    assignee: md.firstApplicantName ? [md.firstApplicantName] : undefined,
    inventors: md.firstInventorName ? [md.firstInventorName] : undefined,
    legal_status: md.applicationStatusDescriptionText,
    cpc: cpc.length > 0 ? cpc : undefined,
  };
}
