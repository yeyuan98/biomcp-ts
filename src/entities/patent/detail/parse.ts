const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&hellip;': '…',
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
};

export function decodeHtmlEntities(s: string): string {
  let out = s;
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ParsedGooglePatent {
  title?: string;
  publication_number?: string;
  publication_date?: string;
  filing_date?: string;
  priority_date?: string;
  assignee?: string[];
  inventors?: string[];
  legal_status?: string;
  abstract?: string;
  claims: Array<{ num: string; text: string }>;
  backward_references: Array<{ publication_number?: string; title?: string; publication_date?: string; assignee?: string }>;
  forward_references: Array<{ publication_number?: string; title?: string; publication_date?: string; assignee?: string }>;
  non_patent_literature: string[];
  cpc: string[];
  family_members: string[];
}

function matchAll(re: RegExp, html: string): RegExpMatchArray[] {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  return Array.from(html.matchAll(new RegExp(re.source, flags)));
}

function allMetaContents(html: string, name: string, scheme?: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = scheme
    ? new RegExp(`<meta\\s+name="${escaped}"\\s+content="([^"]*)"[^>]*scheme="${scheme}"`, 'gi')
    : new RegExp(`<meta\\s+name="${escaped}"\\s+content="([^"]*)"`, 'gi');
  return Array.from(html.matchAll(re)).map(m => decodeHtmlEntities(m[1]));
}

function metaContent(html: string, name: string, scheme?: string): string | undefined {
  const all = allMetaContents(html, name, scheme);
  return all.length > 0 ? all[0] : undefined;
}

function textAfterTag(html: string, itemprop: string): string | undefined {
  const m = html.match(new RegExp(`itemprop="${itemprop}"[^>]*>\\s*([^<]+)<`, 'i'));
  return m ? decodeHtmlEntities(m[1].trim()) : undefined;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

/**
 * Parse a Google Patents detail page (live or Wayback snapshot).
 *
 * Verified structure (2026-08-22, live + Wayback): Dublin Core meta for
 * title/dates/contributors; itemprop spans for dates/status; claims as
 * `[num]`-attributed elements inside `section itemprop="claims"` (US:
 * `<div id="CLM-00001" num="00001">`; EP/WO variants exist); citations as
 * `<tr itemprop="backwardReferences|forwardReferences">` rows; family as
 * `<tr itemprop="docdbFamily">` rows; CPC as hierarchical `itemprop="Code"`
 * values. Layout varies by jurisdiction — every field is optional.
 */
export function parseGooglePatentHtml(html: string): ParsedGooglePatent {
  const result: ParsedGooglePatent = {
    claims: [],
    backward_references: [],
    forward_references: [],
    non_patent_literature: [],
    cpc: [],
    family_members: [],
  };

  const dcTitle = metaContent(html, 'DC.title');
  if (dcTitle) result.title = dcTitle;

  const issued = metaContent(html, 'DC.date', 'issue');
  const submitted = metaContent(html, 'DC.date', 'dateSubmitted');
  if (issued) result.publication_date = issued;
  if (submitted) result.filing_date = submitted;

  result.inventors = allMetaContents(html, 'DC.contributor', 'inventor');
  result.assignee = allMetaContents(html, 'DC.contributor', 'assignee');

  const pubNumber = textAfterTag(html, 'publicationNumber');
  if (pubNumber) result.publication_number = pubNumber.replace(/\s+/g, '');
  const pubDate = textAfterTag(html, 'publicationDate');
  if (pubDate) result.publication_date = pubDate;
  const priorityDate = textAfterTag(html, 'priorityDate');
  if (priorityDate) result.priority_date = priorityDate;
  const filingDate = textAfterTag(html, 'filingDate');
  if (filingDate) result.filing_date = filingDate;
  const status = textAfterTag(html, 'status');
  if (status) result.legal_status = status;

  const abstractMatch = html.match(/<div[^>]*class="[^"]*abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/i);
  if (abstractMatch) {
    const abstractText = stripTags(abstractMatch[1]).slice(0, 5000);
    if (abstractText) result.abstract = abstractText;
  }

  // Claims: [num]-attributed container elements inside the claims section.
  const claimsSectionMatch = html.match(/itemprop="claims"[^>]*>([\s\S]*?)(?:<\/section>|<section\s+itemprop=)/i);
  if (claimsSectionMatch) {
    const seen = new Set<string>();
    const claimMatches = matchAll(/<(?:div|claim|li)\b[^>]*\snum="(\d+)"[^>]*>([\s\S]*?)<\/(?:div|claim|li)>/i, claimsSectionMatch[1]);
    for (const m of claimMatches) {
      if (seen.has(m[1])) continue;
      const text = stripTags(m[2]);
      if (text) {
        seen.add(m[1]);
        result.claims.push({ num: m[1], text });
      }
    }
  }

  for (const direction of ['backwardReferences', 'forwardReferences'] as const) {
    const rows = matchAll(new RegExp(`<tr[^>]*itemprop="${direction}"[^>]*>([\\s\\S]*?)<\\/tr>`, 'i'), html);
    for (const row of rows) {
      const entry = {
        publication_number: textAfterTag(row[1], 'publicationNumber')?.replace(/\s+/g, ''),
        title: textAfterTag(row[1], 'title'),
        publication_date: textAfterTag(row[1], 'publicationDate'),
        assignee: textAfterTag(row[1], 'assigneeOriginal'),
      };
      if (entry.publication_number || entry.title) {
        (direction === 'backwardReferences' ? result.backward_references : result.forward_references).push(entry);
      }
    }
  }

  const nplRows = matchAll(/itemprop="detailedNonPatentLiterature"[^>]*>([\s\S]*?)<\/tr>/i, html);
  for (const row of nplRows) {
    const text = stripTags(row[1]);
    if (text) result.non_patent_literature.push(text.slice(0, 500));
  }

  // CPC: hierarchical Code values ("A", "A61", "A61K", "A61K48/00", "A61K48/0055").
  const codeValues = matchAll(/itemprop="Code"[^>]*>\s*([^<]+)</i, html).map(m => m[1].trim());
  const cpcSymbols = codeValues.filter(c =>
    /^[A-HY]\d{2}[A-Z]\d+\/\d+$/.test(c) || /^[A-HY]\d{2}[A-Z]\d+$/.test(c)
  );
  // Keep only maximal symbols (drop ancestor levels like "A61K48/00" when a longer "A61K48/0055" exists).
  const maximal = cpcSymbols.filter(c => !cpcSymbols.some(other => other !== c && other.startsWith(c)));
  result.cpc = unique(maximal).slice(0, 50);

  // Family: "Also Published As" rows.
  const familyRows = matchAll(/itemprop="docdbFamily"[^>]*>([\s\S]*?)<\/tr>/i, html);
  for (const row of familyRows) {
    const num = textAfterTag(row[1], 'publicationNumber')?.replace(/\s+/g, '');
    if (num) result.family_members.push(num);
  }

  return result;
}
