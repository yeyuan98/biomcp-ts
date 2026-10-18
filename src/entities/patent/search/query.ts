/**
 * Backend-agnostic free-text query parsing shared by the search backends.
 *
 * Splits a query into bare terms and explicitly double-quoted phrases so
 * each backend can apply its own semantics (e.g. Lucene AND-joining terms
 * while preserving user phrases verbatim).
 */

export interface QueryToken {
  text: string;
  phrase: boolean;
}

/**
 * Tokenize a free-text query: double-quoted spans become `phrase` tokens
 * (inner text kept verbatim), everything else splits on whitespace.
 */
export function parseQueryTerms(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    if (m[1] !== undefined) {
      if (m[1].trim()) tokens.push({ text: m[1].trim(), phrase: true });
    } else if (m[2]) {
      tokens.push({ text: m[2], phrase: false });
    }
  }
  return tokens;
}

const LUCENE_SPECIALS = /([+\-&|!(){}[\]^"~*?:\\/])/g;

/** Escape a bare Lucene term so special characters match literally. */
export function escapeLuceneTerm(term: string): string {
  return term.replace(LUCENE_SPECIALS, '\\$1');
}

/**
 * Quote + escape a Lucene phrase or field value. Backslash and double-quote
 * are escaped in the same single pass, so a user-supplied trailing `\`
 * cannot escape the closing quote and break out of the phrase.
 */
export function escapeLucenePhrase(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a `date_range` filter before any backend interpolates it into a
 * query language (ODP Lucene, PPUBS `@pd` expressions). Shape:
 * `YYYY-MM-DD/YYYY-MM-DD` with either side optional (`2020-01-01/`,
 * `/2020-12-31`); more than two segments or non-ISO sides are rejected.
 * Throws a descriptive Error; enforced at the patentSearch funnel and at
 * the ODP interpolation site (searchOdp is callable directly).
 */
export function assertValidDateRange(dateRange: string): void {
  const parts = dateRange.split('/');
  if (parts.length > 2 || parts.some(p => p && !ISO_DATE_RE.test(p))) {
    throw new Error(
      `Invalid date_range '${dateRange}': expected YYYY-MM-DD/YYYY-MM-DD ` +
      '(either side may be empty for an open range, e.g. "2020-01-01/").'
    );
  }
}

/**
 * True when the query already contains explicit Lucene/CQL-style syntax
 * (boolean operators, field:value pairs, range brackets, unary +/-/!), in
 * which case backends must pass it through verbatim instead of re-tokenizing.
 */
export function hasExplicitBooleanSyntax(query: string): boolean {
  return (
    /(^|\s)(AND|OR|NOT)(\s|$)/i.test(query) ||
    /[\w."]+\s*:/.test(query) ||
    /\[[^\]]*\sTO\s[^\]]*\]/i.test(query) ||
    /(^|\s)[+\-!]/.test(query) ||
    /[()]/.test(query)
  );
}
