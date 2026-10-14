import { connectionManager } from '../../../connections/manager.js';
import { withTimeout } from '../../../connections/fetch-utils.js';
import { XMLParser } from 'fast-xml-parser';
import type { OpenAccessResult } from './open-access.js';
import { writeFullTextFile } from './fulltext-store.js';
import { FULLTEXT_MAX_FILE_CHARS } from './fulltext-store.js';
import type { OutlineEntry } from './fulltext-store.js';

export type FullTextStatus = 'available' | 'unavailable';
export type FullTextUnavailableReason =
  | 'paywalled'
  | 'no_pmcid'
  | 'no_machine_readable_xml'
  | 'not_implemented_for_preprints'
  | 'fetch_failed';

export interface FullTextSection {
  heading: string;
  text: string;
  truncated: boolean;
}

export interface FullTextLinks {
  doi_url?: string;
  pmc_url?: string;
  epmc_url?: string;
  /** Preprint records: URL of the full-text JATS XML on www.biorxiv.org (link only) */
  jatsxml_url?: string;
}

export interface FullTextResult {
  status: FullTextStatus;
  reason?: FullTextUnavailableReason;
  pmcid?: string;
  pmid?: string;
  title?: string;
  is_open_access?: boolean;
  license?: string;
  source?: 'europepmc' | 'eutils';
  format?: 'jats-xml' | 'markdown';
  /** 'file' (default): body is on disk, reply carries the handle below.
   *  'inline': body is in sections[]. Unavailable results carry neither
   *  and are byte-identical in both modes. */
  mode?: 'file' | 'inline';
  /** file mode only: markdown file with the complete text */
  file_path?: string;
  /** file mode only: navigation for selective Read/Grep (line numbers
   *  are exact for the written file) */
  outline?: OutlineEntry[];
  sections?: FullTextSection[];
  char_count?: number;
  total_char_count?: number;
  /** Inline-mode cap (0 = no cap applies, i.e. file mode). */
  max_chars: number;
  truncated?: boolean;
  omitted_sections?: string[];
  links?: FullTextLinks;
  note: string;
  _error?: string;
}

export interface FullTextOptions {
  maxChars?: number;
  /** Shared oa lookup so oa+fulltext requests issue one Europe PMC search */
  oa?: OpenAccessResult | null;
  doi?: string;
  /** 'file' (default): write markdown to the cache dir, return a handle;
   *  'inline': return capped text sections in the reply. */
  output?: 'file' | 'inline';
  /** Correlation fields echoed on the file handle */
  pmid?: string;
  title?: string;
}

/** Inline-mode cap for an explicit sections=["fulltext"] request. */
export const FULLTEXT_DEFAULT_MAX_CHARS = 40000;
export const FULLTEXT_MAX_CHARS_LIMIT = 200000;

/** Upper bound per upstream leg; keeps the fulltext section inside the
 * 60 s article_get budget even when both legs time out sequentially. */
const FULLTEXT_LEG_TIMEOUT_MS = 15000;

function unavailableNote(reason: FullTextUnavailableReason): string {
  switch (reason) {
    case 'paywalled':
      return 'Full text is in PMC but not free to read; this cannot be fetched here and retrying will not help. Alternatives: the abstract is in the top-level abstract field; the publisher page is links.doi_url (may require a subscription).';
    case 'no_pmcid':
      return 'This article has no PMC record, so no full text can be fetched here; retrying will not help. Alternatives: the abstract is in the top-level abstract field; the publisher page is links.doi_url.';
    case 'no_machine_readable_xml':
      return 'A PMC record exists but carries no machine-readable body (e.g. an author manuscript withdrawn from distribution); retrying will not help. Alternatives: the abstract is in the top-level abstract field; the publisher page is links.doi_url.';
    case 'not_implemented_for_preprints':
      return 'Full-text retrieval is not implemented for preprints (www.biorxiv.org throttles automated downloads). Fetch links.jatsxml_url directly for the JATS XML, or use article_get on the published version of record.';
    case 'fetch_failed':
      return 'Both full-text sources (Europe PMC and PubMed Central E-utilities) failed to answer; this may be transient — one retry is reasonable.';
  }
}

function buildUnavailable(
  reason: FullTextUnavailableReason,
  maxChars: number,
  extra?: { pmcid?: string; oa?: OpenAccessResult | null; doi?: string; links?: FullTextLinks }
): FullTextResult {
  const links: FullTextLinks = { ...(extra?.links ?? {}) };
  if (extra?.pmcid) {
    links.pmc_url = `https://pmc.ncbi.nlm.nih.gov/articles/${extra.pmcid}/`;
    links.epmc_url = `https://europepmc.org/articles/${extra.pmcid}`;
  }
  if (extra?.doi && !links.doi_url) links.doi_url = `https://doi.org/${extra.doi}`;
  let note = unavailableNote(reason);
  if (!links.doi_url) {
    note = note
      .replace(' the publisher page is links.doi_url (may require a subscription).', '')
      .replace(' the publisher page is links.doi_url.', '');
  }
  return {
    status: 'unavailable',
    reason,
    max_chars: maxChars,
    pmcid: extra?.pmcid,
    is_open_access: extra?.oa?.is_open_access,
    license: extra?.oa?.license,
    links,
    note,
  };
}

/**
 * Fetch an article's full text as structured sections.
 *
 * Chain: Europe PMC /{PMCID}/fullTextXML first (serves open-access
 * records), then E-utilities efetch db=pmc (also serves free-to-read PMC
 * records for which the Europe PMC endpoint 500s — live-verified). Both
 * are among the services NCBI/EBI permit for automated retrieval.
 */
export async function fetchFullText(pmcid: string | undefined, options: FullTextOptions = {}): Promise<FullTextResult> {
  const maxChars = Math.max(1000, Math.min(options.maxChars ?? FULLTEXT_DEFAULT_MAX_CHARS, FULLTEXT_MAX_CHARS_LIMIT));

  if (!pmcid) {
    return buildUnavailable('no_pmcid', maxChars, { oa: options.oa, doi: options.doi });
  }

  // The oa lookup already classified this record: never burn requests on a
  // PMC copy that is known to be embargoed/paywalled.
  if (options.oa && options.oa.status === 'paywalled') {
    return buildUnavailable('paywalled', maxChars, { pmcid, oa: options.oa, doi: options.doi });
  }

  // Each leg resolves null on any failure (HTTP error, non-string payload,
  // timeout) so the chain falls through instead of throwing.
  const epmcXml = await withTimeout(
    (async () => {
      try {
        const conn = connectionManager.getConnection('europepmc');
        // Europe PMC signals "no full text here" with HTTP 500 + a JSON
        // body (deterministic, live-verified); the connection layer throws
        // on 5xx, which lands in the catch below.
        const xml = await conn.request(`/${pmcid}/fullTextXML`);
        return typeof xml === 'string' ? xml : null;
      } catch {
        return null;
      }
    })(),
    FULLTEXT_LEG_TIMEOUT_MS,
    { onTimeout: 'null', label: 'europepmc fullTextXML' }
  );

  let xml: string | null = epmcXml;
  let source: 'europepmc' | 'eutils' = 'europepmc';

  if (!xml) {
    xml = await withTimeout(
      (async () => {
        try {
          const conn = connectionManager.getConnection('eutils');
          const result = await conn.request(`/efetch.fcgi?db=pmc&id=${pmcid.replace(/^PMC/i, '')}`);
          return typeof result === 'string' ? result : null;
        } catch {
          return null;
        }
      })(),
      FULLTEXT_LEG_TIMEOUT_MS,
      { onTimeout: 'null', label: 'eutils pmc efetch' }
    );
    source = 'eutils';
  }

  if (!xml) {
    return buildUnavailable('fetch_failed', maxChars, { pmcid, oa: options.oa, doi: options.doi });
  }

  // E-utilities answers some failures as HTTP 200 with an <eFetchResult>
  // ERROR body (e.g. rate limiting), and unknown PMCIDs as an empty
  // <pmc-articleset/> — both are upstream failures, not missing bodies,
  // so they must stay retryable.
  if (isTransientUpstreamError(xml)) {
    return buildUnavailable('fetch_failed', maxChars, { pmcid, oa: options.oa, doi: options.doi });
  }

  const extracted = extractJatsSections(xml);
  if (!extracted) {
    return buildUnavailable('no_machine_readable_xml', maxChars, { pmcid, oa: options.oa, doi: options.doi });
  }

  const output = options.output ?? 'file';
  const licenseNote = options.oa?.status === 'free_to_read'
    ? ' Free to read under publisher copyright (no CC license) — reuse may be restricted.'
    : '';
  const referencesNote = extracted.hasReferences
    ? ' The reference list is omitted; use sections=["citation"] (backward mode) for the references.'
    : '';

  let fileFallbackReason: string | undefined;
  if (output === 'file') {
    const write = writeFullTextFile({
      pmcid,
      pmid: options.pmid,
      doi: options.doi,
      title: options.title,
      license: options.oa?.license,
      is_open_access: options.oa?.is_open_access,
      oa_status: options.oa?.status,
      source,
      sections: extracted.sections,
    });
    if (write.ok) {
      const truncationNote = write.truncated
        ? ` File truncated at the ${FULLTEXT_MAX_FILE_CHARS.toLocaleString('en-US')}-char safety cap (${write.char_count.toLocaleString('en-US')} of ${write.total_char_count.toLocaleString('en-US')} written); omitted: ${write.omitted_sections?.join(', ')}.`
        : '';
      return {
        status: 'available',
        mode: 'file',
        pmcid,
        pmid: options.pmid,
        title: options.title,
        is_open_access: options.oa?.is_open_access,
        license: options.oa?.license,
        source,
        format: 'markdown',
        file_path: write.file_path,
        outline: write.outline,
        char_count: write.char_count,
        total_char_count: write.total_char_count,
        truncated: write.truncated,
        omitted_sections: write.omitted_sections,
        max_chars: 0,
        note: `Full text is in the file above (markdown; each section starts with "## <heading>" at the line numbers in outline — read with offset/limit or grep the file). Files are ephemeral (pruned after ~24h / 200 files); re-call to regenerate. The path is on the server host; re-call with fulltext_output="inline" if you cannot read it.${truncationNote}${referencesNote}${licenseNote}`,
      };
    }
    // Cache trouble must never lose the text: fall back to inline at the
    // default cap, disclosed in the note and logged per house style.
    console.error('[fulltext] file store unavailable, falling back to inline:', write.reason);
    fileFallbackReason = write.reason;
  }

  // The disclosed fallback honors the documented 40000 ceiling even when
  // the caller passed a larger inline cap (caps are ignored in file mode).
  const effectiveMax = fileFallbackReason
    ? Math.min(maxChars, FULLTEXT_DEFAULT_MAX_CHARS)
    : maxChars;
  const parsed = applyCharBudget(extracted, effectiveMax);
  const fallbackNote = fileFallbackReason
    ? ` (File output was requested but unavailable — returning inline text instead: ${fileFallbackReason}.)`
    : '';
  return {
    status: 'available',
    mode: 'inline',
    pmcid,
    pmid: options.pmid,
    title: options.title,
    is_open_access: options.oa?.is_open_access,
    license: options.oa?.license,
    source,
    format: 'jats-xml',
    max_chars: effectiveMax,
    sections: parsed.sections,
    char_count: parsed.char_count,
    total_char_count: parsed.total_char_count,
    truncated: parsed.truncated,
    omitted_sections: parsed.omitted_sections,
    note: `${buildAvailableNote(parsed, options.oa)}${fallbackNote}`,
  };
}

interface ExtractedJats {
  sections: FullTextSection[];
  total_char_count: number;
  hasReferences: boolean;
}

interface ParsedFullText {
  sections: FullTextSection[];
  char_count: number;
  total_char_count: number;
  truncated: boolean;
  omitted_sections?: string[];
  hasReferences: boolean;
}

/** Apply the inline char budget to extracted sections (truncation is
 *  flagged honestly; empty sections carry nothing to omit). */
function applyCharBudget(extracted: ExtractedJats, maxChars: number): ParsedFullText {
  const out: FullTextSection[] = [];
  const omitted: string[] = [];
  let budget = maxChars;
  let truncated = false;
  for (const s of extracted.sections) {
    if (!s.text) continue;
    if (budget <= 0) {
      omitted.push(s.heading);
      truncated = true;
      continue;
    }
    if (s.text.length <= budget) {
      out.push(s);
      budget -= s.text.length;
    } else {
      const cut = s.text.slice(0, budget).replace(/\s+\S*$/, '');
      out.push({ heading: s.heading, text: cut ? `${cut}…` : '', truncated: true });
      budget = 0;
      truncated = true;
    }
  }
  return {
    sections: out,
    char_count: out.reduce((sum, s) => sum + s.text.length, 0),
    total_char_count: extracted.total_char_count,
    truncated,
    omitted_sections: omitted.length ? omitted : undefined,
    hasReferences: extracted.hasReferences,
  };
}

function buildAvailableNote(parsed: ParsedFullText, oa?: OpenAccessResult | null): string {
  const notes: string[] = [];
  if (parsed.truncated) {
    const omitted = parsed.omitted_sections?.length
      ? `; omitted: ${parsed.omitted_sections.join(', ')}`
      : '';
    notes.push(`Truncated at ${parsed.char_count} of ${parsed.total_char_count} chars${omitted}. Re-call article_get with sections=["fulltext"] and fulltext_max_chars=${FULLTEXT_MAX_CHARS_LIMIT} for the complete text.`);
  }
  if (parsed.hasReferences) {
    notes.push('The reference list is omitted; use sections=["citation"] (backward mode) for the references.');
  }
  if (oa?.status === 'free_to_read') {
    notes.push('Free to read under publisher copyright (no CC license) — reuse may be restricted.');
  }
  if (!notes.length) notes.push('Complete text.');
  return notes.join(' ');
}

// ---------------------------------------------------------------------------
// JATS parsing (preserveOrder mode)
//
// fast-xml-parser's default dict mode groups mixed-content children by tag
// name ("H<sup>+</sup> up to" becomes "Hup to…(+)"), so full-text parsing
// uses preserveOrder: true, whose node arrays keep document order. Node
// shape: { tagName: Node[] } (plus ':@' for attributes when enabled);
// text nodes are { '#text': string }.
// ---------------------------------------------------------------------------

type OrderedNode = Record<string, unknown>;

const orderedParser = new XMLParser({
  ignoreAttributes: true,
  preserveOrder: true,
  htmlEntities: true,
  // Keep whitespace-only text nodes: they are significant around inline
  // markup ("H<sup>+</sup> up" must not collapse to "H(+)up").
  trimValues: false,
});

/** Detect E-utilities failure payloads that arrive with HTTP 200. */
function isTransientUpstreamError(xml: string): boolean {
  if (/<eFetchResult[\s>]/i.test(xml)) return true;
  if (/<ERROR>[\s\S]*<\/ERROR>/i.test(xml)) return true;
  // empty article set: the id resolved to no PMC record at all
  if (xml.includes('pmc-articleset') && !xml.includes('<article')) return true;
  return false;
}

function tagOf(node: OrderedNode): string | undefined {
  for (const key of Object.keys(node)) {
    if (key !== '#text' && key !== ':@') return key;
  }
  return undefined;
}

function childrenOf(node: OrderedNode): OrderedNode[] {
  const tag = tagOf(node);
  if (tag === undefined) return [];
  const children = node[tag];
  return Array.isArray(children) ? (children as OrderedNode[]) : [];
}

function textOf(node: OrderedNode): string {
  const value = node['#text'];
  // preserveOrder mode still converts primitive text ("1", "true") to
  // numbers/booleans — citation markers must not be dropped.
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/** Concatenate a mixed-content node sequence in document order, with
 * sub/sup parenthesized per the repo's PubMed-transform convention. */
function inlineText(nodes: OrderedNode[]): string {
  let out = '';
  for (const node of nodes) {
    if ('#text' in node) {
      out += textOf(node);
      continue;
    }
    const tag = tagOf(node);
    if (tag === undefined) continue;
    if (tag === 'fig' || tag === 'table-wrap') {
      out += placeholderFor(node, tag === 'fig' ? 'Figure' : 'Table');
      continue;
    }
    const inner = inlineText(childrenOf(node));
    if (tag === 'sub' || tag === 'sup' || tag === 'inf') {
      out += inner.trim() ? `(${inner.trim()})` : '';
    } else {
      out += inner;
    }
  }
  return out;
}

function labelOf(node: OrderedNode): string {
  for (const child of childrenOf(node)) {
    if (tagOf(child) === 'label') return inlineText(childrenOf(child)).trim();
  }
  return '';
}

/** Flatten a (possibly nested) <list> into "- item" lines. */
function listBlocks(listNode: OrderedNode): string {
  const lines: string[] = [];
  for (const item of childrenOf(listNode)) {
    if (tagOf(item) !== 'list-item') continue;
    const parts: string[] = [];
    for (const part of childrenOf(item)) {
      const tag = tagOf(part);
      if (tag === 'list') {
        const nested = listBlocks(part);
        if (nested) parts.push(nested);
      } else if (tag && tag !== ':@') {
        const text = inlineText([part]).trim();
        if (text) parts.push(text);
      }
    }
    const text = parts.join(' ').trim();
    if (text) lines.push(`- ${text}`);
  }
  return lines.join('\n');
}

function placeholderFor(node: OrderedNode, kind: 'Figure' | 'Table'): string {
  const label = labelOf(node);
  return label ? `[${label}]` : `[${kind}]`;
}

/** Flatten one <sec> (recursively) into heading+text entries; nested
 * sections become "Parent — Child" headings after the parent's content. */
function walkSec(node: OrderedNode, parentHeading: string, out: FullTextSection[]): void {
  const children = childrenOf(node);
  const titleText = children
    .filter(c => tagOf(c) === 'title')
    .map(c => inlineText(childrenOf(c)).trim())
    .join(' ')
    .trim();
  const heading = titleText
    ? (parentHeading ? `${parentHeading} — ${titleText}` : titleText)
    : (parentHeading || 'Untitled section');

  const blocks: string[] = [];
  for (const child of children) {
    const tag = tagOf(child);
    if (tag === 'p') {
      const text = inlineText(childrenOf(child)).trim();
      if (text) blocks.push(text);
    } else if (tag === 'list') {
      const text = listBlocks(child);
      if (text) blocks.push(text);
    } else if (tag === 'fig' || tag === 'table-wrap') {
      blocks.push(placeholderFor(child, tag === 'fig' ? 'Figure' : 'Table'));
    } else if (tag !== 'title' && tag !== 'sec' && tag !== 'label') {
      // disp-quote, def-list, disp-formula, and unknown block-level
      // elements: keep their text rather than dropping it silently
      const text = inlineText(childrenOf(child)).trim();
      if (text) blocks.push(text);
    }
    // nested <sec> handled after the parent's own content
  }

  out.push({ heading, text: blocks.join('\n\n'), truncated: false });

  for (const child of children) {
    if (tagOf(child) === 'sec') walkSec(child, heading, out);
  }
}

/**
 * Parse a JATS full-text XML document (bare <article> from Europe PMC or
 * <pmc-articleset>-wrapped from E-utilities) into heading+text sections,
 * capped at maxChars. Returns null when the document carries no <body>
 * (front-only PMC records have no machine-readable text).
 */
export function parseFullTextJats(xml: string, maxChars: number): ParsedFullText | null {
  const extracted = extractJatsSections(xml);
  return extracted ? applyCharBudget(extracted, maxChars) : null;
}

/**
 * Extract heading+text sections from a JATS full-text XML document (bare
 * <article> from Europe PMC or <pmc-articleset>-wrapped from E-utilities)
 * with NO char budget — file output writes the complete text. Returns
 * null when the document carries no <body> (front-only PMC records have
 * no machine-readable text).
 */
export function extractJatsSections(xml: string): ExtractedJats | null {
  try {
    const root = orderedParser.parse(xml) as OrderedNode[];

    const findDescendant = (nodes: OrderedNode[], name: string): OrderedNode | undefined => {
      for (const node of nodes) {
        if (tagOf(node) === name) return node;
      }
      for (const node of nodes) {
        const found = findDescendant(childrenOf(node), name);
        if (found) return found;
      }
      return undefined;
    };

    const articleSet = root.find(node => tagOf(node) === 'pmc-articleset');
    const article = findDescendant(articleSet ? childrenOf(articleSet) : root, 'article');
    if (!article) return null;

    const body = childrenOf(article).find(node => tagOf(node) === 'body');
    if (!body) return null;

    const extracted: FullTextSection[] = [];

    // Loose lead-in paragraphs (letters/commentaries without sections)
    const leadParas = childrenOf(body)
      .filter(c => tagOf(c) === 'p')
      .map(c => inlineText(childrenOf(c)).trim())
      .filter(t => t.length > 0);
    if (leadParas.length) {
      extracted.push({ heading: 'Body', text: leadParas.join('\n\n'), truncated: false });
    }
    for (const sec of childrenOf(body)) {
      if (tagOf(sec) === 'sec') walkSec(sec, '', extracted);
    }

    // Back matter: acknowledgments etc. follow the body; the reference list
    // is dropped entirely (the note points at sections=["citation"]).
    let hasReferences = false;
    const back = childrenOf(article).find(node => tagOf(node) === 'back');
    if (back) {
      for (const child of childrenOf(back)) {
        const tag = tagOf(child);
        if (tag === 'ref-list') hasReferences = true;
        else if (tag === 'sec' || tag === 'app' || tag === 'app-group') walkSec(child, '', extracted);
      }
    }

    return {
      sections: extracted,
      total_char_count: extracted.reduce((sum, s) => sum + s.text.length, 0),
      hasReferences,
    };
  } catch (error) {
    console.error('[extractJatsSections] Error:', error);
    return null;
  }
}
