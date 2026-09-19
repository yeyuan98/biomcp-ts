import type { Article } from '../types.js';
import { asArray, createXmlParser } from './xml-utils.js';

// Entry <id> values are always http(s) abs URLs, versioned unless the entry
// is the latest version (e.g. "http://arxiv.org/abs/1706.03762v7" — plan D8).
const ENTRY_ID_PATTERN = /^https?:\/\/arxiv\.org\/abs\/(.+)$/;
const VERSION_SUFFIX_PATTERN = /v\d+$/;

interface ArxivAtomLink {
  '@_href'?: string;
  '@_rel'?: string;
  '@_title'?: string;
}

interface ArxivAtomEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  updated?: string;
  author?: Array<{ name?: string; 'arxiv:affiliation'?: unknown }>;
  category?: Array<{ '@_term'?: string }>;
  link?: ArxivAtomLink[];
  'arxiv:primary_category'?: { '@_term'?: string };
  'arxiv:doi'?: string;
  'arxiv:comment'?: string;
  'arxiv:journal_ref'?: string;
}

/**
 * Parse an arXiv Atom Query API response (always XML, never JSON) into
 * Article[] per the plan D7 field map. Throws a descriptive Error on
 * malformed/non-feed input (typically an HTML error or robot-block page —
 * plan D11); a valid feed with zero entries returns [].
 */
export function parseArxivAtomXml(xml: string): Article[] {
  // Strip a UTF-8 BOM and any leading whitespace before sniffing; the
  // `<?xml` declaration and `<feed` root need NOT be adjacent (real arXiv
  // feeds separate them with a newline).
  const sniffable = xml.replace(/^\uFEFF/, '').trimStart();
  if (!sniffable.startsWith('<?xml') || !sniffable.includes('<feed')) {
    throw new Error(
      `Unexpected arXiv response: expected an Atom XML feed but received other content ` +
      `(starts with ${JSON.stringify(sniffable.slice(0, 40))}); likely an HTML error or block page`
    );
  }

  // Mirrors transform/pubmed.ts via the shared xml-utils parser; attributes
  // surface as @_term/@_href/@_rel/@_title. Repeated elements (author,
  // category, link, plus the affiliation children of authors) are forced to
  // arrays so entries with a single child do not collapse to scalar objects.
  const parser = createXmlParser(['entry', 'author', 'category', 'link', 'arxiv:affiliation']);

  let parsed: any;
  try {
    parsed = parser.parse(sniffable);
  } catch (e) {
    throw new Error(`Failed to parse arXiv Atom XML: ${(e as Error).message}`);
  }

  return asArray(parsed?.feed?.entry).map(extractArxivEntry);
}

function extractArxivEntry(entry: ArxivAtomEntry): Article {
  const idMatch = ENTRY_ID_PATTERN.exec(entry.id ?? '');
  const arxivId = idMatch ? idMatch[1].replace(VERSION_SUFFIX_PATTERN, '') : undefined;

  // Affiliations are normalized by the parser (always arrays, including
  // multi-affiliation authors) but deliberately dropped — Article has no
  // affiliation field (plan D7).
  const authors = asArray(entry.author)
    .map(author => (typeof author?.name === 'string' ? author.name : ''))
    .map(name => name.trim())
    .filter(name => name.length > 0);

  const primaryCategory = entry['arxiv:primary_category']?.['@_term'];
  const categories = asArray(entry.category)
    .map(category => category?.['@_term'] || '')
    .filter(term => term.length > 0);
  // arXiv always repeats the primary category inside <category>; drop the
  // duplicate while keeping the primary first.
  const keywords = primaryCategory
    ? [primaryCategory, ...categories.filter(term => term !== primaryCategory)]
    : categories;

  const publishedMatch = /^(\d{4}-\d{2}-\d{2})/.exec(entry.published ?? '');

  return {
    arxiv_id: arxivId,
    // doi comes from <arxiv:doi> (publisher DOI) only — never guessed from
    // license or link shape (plan D7).
    doi: typeof entry['arxiv:doi'] === 'string' ? entry['arxiv:doi'] : undefined,
    title: cleanArxivText(entry.title),
    abstract: cleanArxivText(entry.summary),
    authors: authors.length > 0 ? authors : undefined,
    journal: 'arXiv',
    publication_date: publishedMatch ? publishedMatch[1] : undefined,
    keywords: keywords.length > 0 ? keywords : undefined,
    publication_types: ['preprint'],
    source: 'arxiv',
  };
}

// Trim + entity-unescape: fast-xml-parser already decodes XML/HTML entities
// in text nodes (htmlEntities: true), so only whitespace hygiene remains —
// arXiv pads <summary> with leading/trailing spaces and some author names
// with leading spaces.
function cleanArxivText(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
