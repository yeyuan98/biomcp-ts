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

  // Granted patents are reachable by patentNumber; applications by earliest
  // publication number via a text search fallback.
  let wrapper: OdpWrapper | undefined;
  try {
    const raw = await conn.post('/api/v1/patent/applications/search', {
      q: `applicationMetaData.patentNumber:"${bare}"`,
      pagination: { offset: 0, limit: 1 },
    }) as { patentFileWrapperDataBag?: OdpWrapper[] };
    wrapper = raw.patentFileWrapperDataBag?.[0];
  } catch {
    // fall through to text search
  }

  if (!wrapper) {
    const raw = await conn.post('/api/v1/patent/applications/search', {
      q: `(${bare})`,
      pagination: { offset: 0, limit: 1 },
    }) as { patentFileWrapperDataBag?: OdpWrapper[] };
    wrapper = raw.patentFileWrapperDataBag?.[0];
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
