import { XMLParser } from 'fast-xml-parser';

/**
 * Normalize a fast-xml-parser child node that may be missing, collapsed to
 * a scalar (single child), or already an array into a T[].
 */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The fast-xml-parser configuration shared by the PubMed and arXiv
 * transforms: surface attributes under the `@_` prefix, keep mixed content
 * in `#text`, leave tag values as raw strings (parseTagValue: false), decode
 * XML/HTML entities, and force the caller's repeated tags to arrays so
 * entries with a single child do not collapse to scalar objects.
 */
export function createXmlParser(repeatedTags: string[]): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    htmlEntities: true,
    isArray: (name: string) => repeatedTags.includes(name),
  });
}
