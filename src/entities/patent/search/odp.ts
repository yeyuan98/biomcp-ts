import { connectionManager } from '../../../connections/manager.js';
import { RestConnection } from '../../../connections/rest.js';
import type { PatentSearchOptions, PatentSearchResult } from '../types.js';

export function hasOdpKey(): boolean {
  return !!process.env.USPTO_API_KEY;
}

interface OdpApplicationMetaData {
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
  applicationMetaData?: OdpApplicationMetaData;
}

export function transformOdpWrapper(wrapper: OdpWrapper): PatentSearchResult {
  const md = wrapper.applicationMetaData || {};
  const patentNumber = md.patentNumber ? String(md.patentNumber) : undefined;
  const pub = patentNumber
    ? `US${patentNumber.padStart(8, '0')}`
    : md.earliestPublicationNumber
      ? `US${String(md.earliestPublicationNumber).replace(/^US/, '')}`
      : `US${wrapper.applicationNumberText || ''}`;

  const cpc = (md.cpcClassificationBag?.cpcClassificationBag || [])
    .map(c => c.classification)
    .filter((x): x is string => !!x)
    .slice(0, 10);

  return {
    publication_number: pub,
    title: md.inventionTitle,
    publication_date: md.grantDate || md.earliestPublicationDate,
    filing_date: md.filingDate,
    assignee: md.firstApplicantName ? [md.firstApplicantName] : undefined,
    applicant: md.firstApplicantName ? [md.firstApplicantName] : undefined,
    inventor: md.firstInventorName ? [md.firstInventorName] : undefined,
    cpc_codes: cpc.length > 0 ? cpc : undefined,
    status: patentNumber ? 'granted' : 'application',
    source: 'uspto_odp',
  };
}

function buildLucene(query: string, options: PatentSearchOptions): string {
  const clauses: string[] = [];
  if (query.trim()) clauses.push(`(${query.trim()})`);
  if (options.assignee) clauses.push(`applicationMetaData.firstApplicantName:"${options.assignee.replace(/"/g, '\\"')}"`);
  if (options.inventor) clauses.push(`applicationMetaData.firstInventorName:"${options.inventor.replace(/"/g, '\\"')}"`);
  if (options.date_range) {
    const [from, to] = options.date_range.split('/');
    const start = from || '1790-01-01';
    const end = to || '2100-12-31';
    clauses.push(`applicationMetaData.filingDate:[${start} TO ${end}]`);
  }
  if (clauses.length === 0) clauses.push('(biomedical)');
  return clauses.join(' AND ');
}

export async function searchOdp(
  query: string,
  options: PatentSearchOptions = {}
): Promise<{ patents: PatentSearchResult[]; total?: number }> {
  if (!hasOdpKey()) {
    throw new Error('USPTO Open Data Portal key not configured. Set USPTO_API_KEY environment variable.');
  }

  const conn = connectionManager.getConnection('uspto_odp') as RestConnection;
  const body = {
    q: buildLucene(query, options),
    pagination: { offset: options.offset ?? 0, limit: Math.min(options.limit ?? 10, 100) },
  };

  const raw = await conn.post('/api/v1/patent/applications/search', body) as {
    count?: number;
    patentFileWrapperDataBag?: OdpWrapper[];
  };

  const wrappers = raw.patentFileWrapperDataBag || [];
  let results = wrappers.map(transformOdpWrapper);
  if (options.status) {
    results = results.filter(r => r.status === options.status);
  }

  return { patents: results, total: raw.count };
}
