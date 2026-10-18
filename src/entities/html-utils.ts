/**
 * Canonical HTML text cleanup shared by entity fetchers.
 *
 * Upstream HTML arrives in two shapes: raw tags (`<b>x</b>`) and
 * entity-encoded tags (`&lt;b&gt;x&lt;/b&gt;`). Only tag-shaped sequences are
 * removed — entity-encoded comparison operators in patent claims
 * (`weight &lt;500 Da … purity &gt;95%`) are plain text and must survive as
 * literal `<`/`>` after decoding. Stripping runs in a convergence loop
 * (handles nested markup), then entities decode in a single pass over the
 * already-stripped text so the decoder never re-decodes its own output
 * (`&amp;lt;` decodes to literal `&lt;`, never to `<`).
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  le: '≤',
  ge: '≥',
  minus: '−',
};

const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|le|ge|minus|#\d+|#x[0-9a-f]+);/gi;

/** Decode HTML entities (named above, plus decimal/hex numeric refs). */
export function decodeHtmlEntities(s: string): string {
  return s.replace(ENTITY_RE, (match) => {
    const body = match.slice(1, -1);
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // Reject out-of-range and lone-surrogate codepoints instead of
      // emitting replacement/invalid characters into scientific text.
      const valid = Number.isFinite(code) && code > 0 && code <= 0x10ffff
        && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

const RAW_TAG_RE = /<[^>]*>/g;
// Entity-encoded tag shape: `&lt;` + optional `/` + tag-name start + tag
// body without `&`/`>` + `&gt;`. Requiring a letter after `&lt;` is what
// keeps comparison operators (`&lt;500`) out of the match. Single star
// only: overlapping star+star classes over the same characters backtrack
// exponentially on unterminated input (applicant-authored claim text).
const ESCAPED_TAG_RE = /&lt;\/?[a-zA-Z][^&>]*&gt;/gi;

/**
 * Strip HTML markup (raw and entity-encoded tag-shaped sequences) and
 * decode entities.
 *
 * - `'inline'` (default): tags are removed with `''`, so inline highlights
 *   like `Interleukin-<b>2</b>` stay joined; whitespace is trimmed only.
 * - `'block'`: tags are removed with `' '` and whitespace runs collapse to
 *   a single space — for block markup (claims sections, patent detail
 *   pages) whose tags separate text.
 */
export function stripHtml(s: string, mode: 'inline' | 'block' = 'inline'): string {
  const tagTo = mode === 'block' ? ' ' : '';
  let prev = '';
  let out = s;
  // Loop to convergence: stripping can expose new tag-shaped sequences
  // (nested or double-encoded markup).
  while (out !== prev) {
    prev = out;
    out = out.replace(RAW_TAG_RE, tagTo).replace(ESCAPED_TAG_RE, tagTo);
  }
  out = decodeHtmlEntities(out);
  return mode === 'block'
    ? out.replace(/\s+/g, ' ').trim()
    : out.trim();
}
