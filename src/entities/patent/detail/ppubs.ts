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

/**
 * Split already-stripped claims text on sequential `N.` claim starts.
 * Markers are only accepted when they continue a 1,2,3... sequence, so
 * references like "of claim 1." inside claim text never split a claim.
 * Returns null when no believable split is found.
 */
export function splitPlainTextClaims(text: string): string[] | null {
  const re = /(?:^|\s)(\d{1,3})[.)](?=\s|$)/g;
  const marks: Array<{ num: number; start: number }> = [];
  let expected = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = Number(m[1]);
    if (num === expected) {
      marks.push({ num, start: m.index + m[0].indexOf(m[1]) });
      expected++;
    }
  }
  if (marks.length < 2) return null;
  const claims: string[] = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const t = text.slice(marks[i].start, end).replace(/\s+/g, ' ').trim();
    if (t) claims.push(t);
  }
  return claims.length >= 2 ? claims : null;
}

/**
 * Split claimsHtml into numbered claims. Fallback chain:
 * 1. `num="N"`-attributed claim divs (canonical PPUBS markup)
 * 2. `id="CLM-NNNNNN"`-attributed divs (older markup)
 * 3. sequential `N.` markers in the stripped plain text
 * 4. single unparsed block (with `_warn`)
 */
function splitClaimsHtml(claimsHtml: string): { claims: string[]; method: 'num' | 'clm-id' | 'text' | 'blob' } {
  const methods: Array<{ method: 'num' | 'clm-id'; re: RegExp }> = [
    { method: 'num', re: /<(?:div|claim)\b[^>]*\snum="(\d+)"[^>]*>/gi },
    { method: 'clm-id', re: /<(?:div|claim|li)\b[^>]*\sid="CLM-(\d+)"[^>]*>/gi },
  ];
  for (const { method, re } of methods) {
    // Slice between marker boundaries (String.split with a capturing regex
    // would splice the captures into the result array).
    const matches = Array.from(claimsHtml.matchAll(re));
    if (matches.length === 0) continue;
    const seen = new Set<string>();
    const claims: string[] = [];
    matches.forEach((m, i) => {
      const num = m[1];
      if (!num || seen.has(num)) return;
      const start = m.index + m[0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : claimsHtml.length;
      const stripped = stripHtml(claimsHtml.slice(start, end)).replace(/^\d+[.)]\s*/, '');
      if (stripped) {
        seen.add(num);
        claims.push(`${Number(num)}. ${stripped}`.trim());
      }
    });
    if (claims.length > 0) return { claims, method };
  }

  const textSplit = splitPlainTextClaims(stripHtml(claimsHtml));
  if (textSplit) return { claims: textSplit, method: 'text' };

  const blob = stripHtml(claimsHtml);
  return { claims: blob ? [blob] : [], method: 'blob' };
}

export async function fetchPpubsClaims(publicationNumber: string): Promise<PatentClaimsSection> {
  const doc = await fetchPpubsDocument(publicationNumber);
  if (!doc.claimsHtml) {
    throw new Error(`No claims text available via USPTO Public Search for ${publicationNumber}.`);
  }

  const { claims: parsedClaims, method } = splitClaimsHtml(doc.claimsHtml);
  if (parsedClaims.length === 0) {
    throw new Error(`No claims text could be parsed via USPTO Public Search for ${publicationNumber}.`);
  }

  // Never report a bogus count: the split path yields the true parsed count;
  // a single unparsed blob trusts the upstream numberOfClaims when finite
  // and reports undefined otherwise.
  const upstreamCount = doc.numberOfClaims != null ? Number(doc.numberOfClaims) : undefined;
  const number_of_claims = method === 'blob'
    ? (Number.isFinite(upstreamCount) ? upstreamCount : undefined)
    : parsedClaims.length;

  let claims = parsedClaims;
  let warn: string | undefined;
  if (method === 'blob') {
    warn = 'Claims could not be split into numbered claims; returning full text as a single block.';
  }
  const totalBytes = claims.reduce((sum, c) => sum + c.length, 0);
  if (totalBytes > CLAIMS_CAP_BYTES) {
    const kept: string[] = [];
    let used = 0;
    for (const c of claims) {
      if (used + c.length > CLAIMS_CAP_BYTES) break;
      kept.push(c);
      used += c.length;
    }
    const truncationWarn = `Claims truncated to ${kept.length} of ${claims.length} claims (~100 KB cap).`;
    warn = warn ? `${warn} ${truncationWarn}` : truncationWarn;
    claims = kept;
  }

  return {
    claims,
    number_of_claims,
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
