import { opsClient, hasOpsCredentials } from '../ops-client.js';
import type {
  PatentCitationEntry,
  PatentClaimsSection,
  PatentClassificationsSection,
  PatentCitationsSection,
  PatentFamilySection,
  PatentResult,
} from '../types.js';

function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function textOf(x: unknown): string | undefined {
  if (x && typeof x === 'object' && '$' in (x as Record<string, unknown>)) {
    return String((x as Record<string, unknown>)['$']);
  }
  return typeof x === 'string' ? x : undefined;
}

interface BadgerFish {
  [key: string]: unknown;
}

function pickEnglish(items: BadgerFish[]): BadgerFish | undefined {
  return items.find(i => i['@lang'] === 'en') || items[0];
}

/** OPS detail paths reject bare kind codes (US11027025B2 → 404); strip it. */
export function stripKindCode(publicationNumber: string): string {
  const m = publicationNumber.toUpperCase().match(/^([A-Z]{2}(?:RE|PP|H)?\d+)/);
  return m ? m[1] : publicationNumber.toUpperCase();
}

function isoDate(yyyymmdd: string | undefined): string | undefined {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function getJson(path: string): Promise<BadgerFish> {
  const resp = await opsClient.get(path);
  if (resp.status !== 200) {
    throw new Error(`EPO OPS request failed (HTTP ${resp.status}): ${path} — ${resp.body.slice(0, 150)}`);
  }
  return JSON.parse(resp.body) as BadgerFish;
}

function exchangeDocumentOf(parsed: BadgerFish): BadgerFish {
  const world = (parsed['ops:world-patent-data'] || {}) as BadgerFish;
  const docs = (world['exchange-documents'] || {}) as BadgerFish;
  const doc = docs['exchange-document'];
  return (asArray(doc as BadgerFish[])[0] || {}) as BadgerFish;
}

export async function fetchOpsBiblio(publicationNumber: string): Promise<PatentResult> {
  if (!hasOpsCredentials()) {
    throw new Error('EPO OPS credentials not configured. Set EPO_OPS_CONSUMER_KEY and EPO_OPS_CONSUMER_SECRET.');
  }
  const pn = stripKindCode(publicationNumber);
  const parsed = await getJson(`/published-data/publication/epodoc/${pn}/biblio`);
  const doc = exchangeDocumentOf(parsed);
  const bib = (doc['bibliographic-data'] || {}) as BadgerFish;

  const titles = asArray(bib['invention-title'] as BadgerFish[]);
  const title = textOf(pickEnglish(titles));

  const parties = (bib['parties'] || {}) as BadgerFish;
  const applicants = asArray((parties['applicants'] as BadgerFish)?.['applicant'] as BadgerFish[])
    .map(a => textOf((a['applicant-name'] as BadgerFish)?.['name']))
    .filter((x): x is string => !!x);
  const inventors = asArray((parties['inventors'] as BadgerFish)?.['inventor'] as BadgerFish[])
    .map(i => textOf((i['inventor-name'] as BadgerFish)?.['name']))
    .filter((x): x is string => !!x);

  let publicationDate: string | undefined;
  let filingDate: string | undefined;
  let priorityDate: string | undefined;

  for (const ref of asArray((bib['publication-reference'] as BadgerFish)?.['document-id'] as BadgerFish[])) {
    if (ref['@document-id-type'] === 'docdb') {
      publicationDate = isoDate(textOf(ref['date']));
      break;
    }
  }
  for (const ref of asArray((bib['application-reference'] as BadgerFish)?.['document-id'] as BadgerFish[])) {
    const d = isoDate(textOf(ref['date']));
    if (d) { filingDate = d; break; }
  }
  for (const pc of asArray((bib['priority-claims'] as BadgerFish)?.['priority-claim'] as BadgerFish[])) {
    for (const ref of asArray(pc['document-id'] as BadgerFish[])) {
      const d = isoDate(textOf(ref['date']));
      if (d) { priorityDate = d; break; }
    }
    if (priorityDate) break;
  }

  const cpc = new Set<string>();
  for (const c of asArray((bib['patent-classifications'] as BadgerFish)?.['patent-classification'] as BadgerFish[])) {
    const section = textOf(c['section']);
    const cls = textOf(c['class']);
    const subclass = textOf(c['subclass']);
    const mainGroup = (textOf(c['main-group']) || '0').replace(/\s+/g, '');
    const subGroup = (textOf(c['subgroup']) || '0').replace(/\s+/g, '');
    if (section && cls && subclass) cpc.add(`${section}${cls}${subclass}${mainGroup}/${subGroup}`);
  }
  const ipc: string[] = [];
  for (const c of asArray((bib['classifications-ipcr'] as BadgerFish)?.['classification-ipcr'] as BadgerFish[])) {
    const t = textOf(c['text']);
    if (t) {
      const m = t.match(/([A-HY]\d{2}\s?[A-Z]\s?\d+\/?\d*)/);
      if (m) ipc.push(m[1].replace(/\s+/g, ''));
    }
  }

  const country = textOf(doc['@country']) || '';
  const docNumber = textOf(doc['@doc-number']) || '';
  const kind = textOf(doc['@kind']) || '';

  return {
    publication_number: `${country}${docNumber}${kind}`,
    title,
    publication_date: publicationDate,
    filing_date: filingDate,
    priority_date: priorityDate,
    assignee: applicants.length > 0 ? applicants : undefined,
    applicant: applicants.length > 0 ? applicants : undefined,
    inventors: inventors.length > 0 ? inventors : undefined,
    legal_status: undefined,
    cpc: cpc.size > 0 ? Array.from(cpc) : undefined,
    ipc: ipc.length > 0 ? Array.from(new Set(ipc)) : undefined,
    family_id: textOf(doc['@family-id']),
  };
}

export async function fetchOpsAbstract(publicationNumber: string): Promise<string | undefined> {
  if (!hasOpsCredentials()) {
    throw new Error('EPO OPS credentials not configured. Set EPO_OPS_CONSUMER_KEY and EPO_OPS_CONSUMER_SECRET.');
  }
  const parsed = await getJson(`/published-data/publication/epodoc/${stripKindCode(publicationNumber)}/abstract`);
  const doc = exchangeDocumentOf(parsed);
  const abstracts = asArray(doc['abstract'] as BadgerFish[]);
  const chosen = pickEnglish(abstracts);
  const p = chosen?.['p'];
  return textOf(p);
}

export async function fetchOpsClaims(publicationNumber: string): Promise<PatentClaimsSection> {
  if (!hasOpsCredentials()) {
    throw new Error('EPO OPS credentials not configured. Set EPO_OPS_CONSUMER_KEY and EPO_OPS_CONSUMER_SECRET.');
  }
  const pn = stripKindCode(publicationNumber);
  const parsed = await getJson(`/published-data/publication/epodoc/${pn}/claims`);
  const world = (parsed['ops:world-patent-data'] || {}) as BadgerFish;
  const ftxt = (world['ftxt:fulltext-documents'] || {}) as BadgerFish;
  const fdoc = (ftxt['ftxt:fulltext-document'] || {}) as BadgerFish;
  const claims = (fdoc['claims'] || {}) as BadgerFish;
  const claimItems = asArray(claims['claim'] as BadgerFish[]);

  const texts = claimItems.map(c => {
    const fragments = asArray(c['claim-text'] as BadgerFish[]).map(textOf);
    return fragments.filter((x): x is string => !!x).join(' ');
  }).filter(t => t.length > 0);

  if (texts.length === 0) {
    throw new Error(`EPO OPS returned no claims text for ${pn} (fulltext may not be available for this authority).`);
  }

  let warn: string | undefined;
  const totalBytes = texts.reduce((sum, t) => sum + t.length, 0);
  let out = texts;
  if (totalBytes > 100_000) {
    const kept: string[] = [];
    let used = 0;
    for (const t of texts) {
      if (used + t.length > 100_000) break;
      kept.push(t);
      used += t.length;
    }
    out = kept;
    warn = `Claims truncated to ${kept.length} of ${texts.length} claims (~100 KB cap).`;
  }

  return { claims: out, number_of_claims: texts.length, source: 'ops', _warn: warn };
}

export async function fetchOpsCitations(publicationNumber: string): Promise<PatentCitationsSection> {
  if (!hasOpsCredentials()) {
    throw new Error('EPO OPS credentials not configured. Set EPO_OPS_CONSUMER_KEY and EPO_OPS_CONSUMER_SECRET.');
  }
  const pn = stripKindCode(publicationNumber);

  // Backward references come from the biblio record.
  const biblio = await getJson(`/published-data/publication/epodoc/${pn}/biblio`);
  const doc = exchangeDocumentOf(biblio);
  const bib = (doc['bibliographic-data'] || {}) as BadgerFish;
  const refsContainer = (bib['references-cited'] || {}) as BadgerFish;
  const citations = asArray(refsContainer['citation'] as BadgerFish[]);

  const backward: PatentCitationEntry[] = [];
  const npl: string[] = [];
  for (const citation of citations) {
    const patcit = citation['patcit'] as BadgerFish | undefined;
    if (patcit) {
      let pubNum: string | undefined;
      for (const ref of asArray(patcit['document-id'] as BadgerFish[])) {
        if (ref['@document-id-type'] === 'epodoc') {
          pubNum = textOf(ref['doc-number']);
          break;
        }
        if (ref['@document-id-type'] === 'docdb') {
          pubNum = `${textOf(ref['country']) || ''}${textOf(ref['doc-number']) || ''}${textOf(ref['kind']) || ''}`;
        }
      }
      if (pubNum) backward.push({ publication_number: pubNum });
    } else {
      const nplcit = citation['nplcit'] as BadgerFish | undefined;
      const text = nplcit ? textOf((nplcit as BadgerFish)['p'] ?? nplcit['text']) : textOf(citation['text']);
      if (text) npl.push(text.slice(0, 500));
    }
  }

  // Forward citations via CQL ct= search.
  const forward: PatentCitationEntry[] = [];
  try {
    const searchResp = await opsClient.get(`/published-data/search?q=${encodeURIComponent(`ct=${pn}`)}&Range=1-100`);
    if (searchResp.status === 200) {
      const parsedSearch = JSON.parse(searchResp.body) as BadgerFish;
      const world = (parsedSearch['ops:world-patent-data'] || {}) as BadgerFish;
      const biblioSearch = (world['ops:biblio-search'] || {}) as BadgerFish;
      const searchResult = (biblioSearch['ops:search-result'] || {}) as BadgerFish;
      const pubRefs = asArray(searchResult['ops:publication-reference'] as BadgerFish[]);
      for (const pr of pubRefs) {
        const docId = (pr['document-id'] || {}) as BadgerFish;
        const pubNum = `${textOf(docId['country']) || ''}${textOf(docId['doc-number']) || ''}${textOf(docId['kind']) || ''}`;
        if (pubNum) forward.push({ publication_number: pubNum });
      }
    }
  } catch {
    // forward citations are best-effort
  }

  return { backward, forward, non_patent_literature: npl.length > 0 ? npl : undefined, source: 'ops' };
}

export async function fetchOpsFamily(publicationNumber: string): Promise<PatentFamilySection> {
  if (!hasOpsCredentials()) {
    throw new Error('EPO OPS credentials not configured. Set EPO_OPS_CONSUMER_KEY and EPO_OPS_CONSUMER_SECRET.');
  }
  const parsed = await getJson(`/family/publication/epodoc/${stripKindCode(publicationNumber)}`);
  const world = (parsed['ops:world-patent-data'] || {}) as BadgerFish;
  const family = (world['ops:patent-family'] || {}) as BadgerFish;
  const members = asArray(family['ops:family-member'] as BadgerFish[]);

  const pubs: string[] = [];
  for (const member of members) {
    for (const ref of asArray((member['publication-reference'] as BadgerFish)?.['document-id'] as BadgerFish[])) {
      if (ref['@document-id-type'] === 'docdb') {
        const pub = `${textOf(ref['country']) || ''}${textOf(ref['doc-number']) || ''}${textOf(ref['kind']) || ''}`;
        if (pub) pubs.push(pub);
      }
    }
  }

  return { family_members: Array.from(new Set(pubs)), source: 'ops' };
}

export async function fetchOpsClassifications(publicationNumber: string): Promise<PatentClassificationsSection> {
  const biblio = await fetchOpsBiblio(publicationNumber);
  return {
    cpc: biblio.cpc || [],
    ipc: biblio.ipc || [],
    source: 'ops',
  };
}
