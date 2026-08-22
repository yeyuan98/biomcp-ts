import { ppubsClient } from '../ppubs-client.js';
import type { PatentClaimsSection, PatentResult } from '../types.js';

const CLAIMS_CAP_BYTES = 100_000;

interface PpubsDocumentRecord {
  guid?: string;
  type?: string;
  inventionTitle?: string;
  publicationReferenceDocumentNumber?: string;
  datePublished?: string;
  applicationFilingDate?: string[];
  applicantName?: string[] | null;
  assigneeName?: string[] | null;
  inventorsShort?: string;
  inventorNameDerived?: string[];
  abstractHtml?: string | null;
  claimsHtml?: string | null;
  numberOfClaims?: number | null;
  cpcInventiveFlattened?: string | null;
  ipcCodeFlattened?: string | null;
  usRefPatentNumber?: string[] | null;
  usRefIssueDate?: string[] | null;
  usRefPatenteeName?: string[] | null;
  foreignRefPatentNumber?: string[] | null;
  foreignRefPubDate?: string[] | null;
  inventors?: Array<{ inventorName?: { name?: string } }>;
  patentFamilyMembers?: string[] | null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a US publication number to its PPUBS guid + source type via a
 * `("<number>").pn.` search.
 */
export async function resolvePpubsGuid(
  publicationNumber: string
): Promise<{ guid: string; sourceType: string } | null> {
  const number = publicationNumber.toUpperCase().replace(/^US/, '').replace(/[A-Z]\d?$/, '');
  const resp = await ppubsClient.search(`("${number}").pn.`, { pageCount: 1 });
  if (resp.status !== 200) return null;
  let parsed: { patents?: PpubsDocumentRecord[] };
  try {
    parsed = JSON.parse(resp.body);
  } catch {
    return null;
  }
  const hit = (parsed.patents || []).find(p => p.guid);
  if (!hit?.guid) return null;
  return { guid: hit.guid, sourceType: hit.type || 'USPAT' };
}

async function fetchPpubsDocument(publicationNumber: string): Promise<PpubsDocumentRecord> {
  const resolved = await resolvePpubsGuid(publicationNumber);
  if (!resolved) {
    throw new Error(`Patent '${publicationNumber}' not found in USPTO Public Search (PPUBS covers US publications only).`);
  }
  const resp = await ppubsClient.getDocument(resolved.guid, resolved.sourceType);
  if (resp.status !== 200) {
    throw new Error(`USPTO Public Search document fetch failed: HTTP ${resp.status}`);
  }
  try {
    return JSON.parse(resp.body) as PpubsDocumentRecord;
  } catch {
    throw new Error('USPTO Public Search document fetch returned malformed JSON.');
  }
}

export async function fetchPpubsCore(publicationNumber: string): Promise<PatentResult> {
  const doc = await fetchPpubsDocument(publicationNumber);
  const number = (doc.publicationReferenceDocumentNumber || publicationNumber).replace(/^US/, '');
  const kind = doc.guid?.split('-').pop() || '';
  const org = doc.assigneeName?.filter(Boolean) || doc.applicantName?.filter(Boolean) || [];
  const inventors = (doc.inventors || [])
    .map(i => i.inventorName?.name)
    .filter((x): x is string => !!x);

  const cpc = (doc.cpcInventiveFlattened || '').split(';').map(s => s.trim()).filter(Boolean);
  const ipc = (doc.ipcCodeFlattened || '').split(';').map(s => s.trim()).filter(Boolean);

  return {
    publication_number: `US${number}${kind}`,
    title: doc.inventionTitle,
    abstract: doc.abstractHtml ? stripHtml(doc.abstractHtml).slice(0, 5000) : undefined,
    publication_date: doc.datePublished ? doc.datePublished.slice(0, 10) : undefined,
    filing_date: doc.applicationFilingDate?.[0]?.slice(0, 10),
    assignee: org.length > 0 ? org : undefined,
    applicant: doc.applicantName?.filter(Boolean).length ? doc.applicantName!.filter(Boolean) : undefined,
    inventors: inventors.length > 0 ? inventors : undefined,
    cpc: cpc.length > 0 ? cpc : undefined,
    ipc: ipc.length > 0 ? ipc : undefined,
    family_members: doc.patentFamilyMembers?.filter(Boolean) || undefined,
  };
}

export async function fetchPpubsClaims(publicationNumber: string): Promise<PatentClaimsSection> {
  const doc = await fetchPpubsDocument(publicationNumber);
  if (!doc.claimsHtml) {
    throw new Error(`No claims text available via USPTO Public Search for ${publicationNumber}.`);
  }

  // claimsHtml contains numbered claim divs; split on full claim-start tags.
  const CLAIM_START_RE = /<(?:div|claim)\b[^>]*\snum="(\d+)"[^>]*>/gi;
  const numMatches = Array.from(doc.claimsHtml.matchAll(CLAIM_START_RE)).map(m => m[1]);
  const claimBlocks = doc.claimsHtml.split(/<(?:div|claim)\b[^>]*\snum="\d+"[^>]*>/i).slice(1);
  let claims: string[];
  if (claimBlocks.length > 0) {
    claims = claimBlocks.map((block, i) => {
      const stripped = stripHtml(block).replace(/^\d+[.)]\s*/, '');
      return `${numMatches[i] || i + 1}. ${stripped}`.trim();
    });
  } else {
    claims = [stripHtml(doc.claimsHtml)];
  }

  let warn: string | undefined;
  const totalBytes = claims.reduce((sum, c) => sum + c.length, 0);
  if (totalBytes > CLAIMS_CAP_BYTES) {
    const kept: string[] = [];
    let used = 0;
    for (const c of claims) {
      if (used + c.length > CLAIMS_CAP_BYTES) break;
      kept.push(c);
      used += c.length;
    }
    warn = `Claims truncated to ${kept.length} of ${claims.length} claims (~100 KB cap).`;
    claims = kept;
  }

  return {
    claims,
    number_of_claims: doc.numberOfClaims ?? claims.length,
    source: 'ppubs',
    _warn: warn,
  };
}

export async function fetchPpubsCitations(publicationNumber: string) {
  const doc = await fetchPpubsDocument(publicationNumber);
  const backward: Array<{ publication_number?: string; publication_date?: string; assignee?: string }> = [];

  const usNums = doc.usRefPatentNumber || [];
  const usDates = doc.usRefIssueDate || [];
  const usNames = doc.usRefPatenteeName || [];
  for (let i = 0; i < usNums.length; i++) {
    backward.push({
      publication_number: usNums[i],
      publication_date: usDates[i]?.slice(0, 10),
      assignee: usNames[i],
    });
  }

  const foreignNums = doc.foreignRefPatentNumber || [];
  const foreignDates = doc.foreignRefPubDate || [];
  for (let i = 0; i < foreignNums.length; i++) {
    backward.push({
      publication_number: foreignNums[i],
      publication_date: foreignDates[i]?.slice(0, 10),
    });
  }

  return { backward, source: 'ppubs' as const };
}
