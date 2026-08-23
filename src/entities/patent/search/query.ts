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
