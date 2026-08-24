/**
 * Pure parser for NCBI GEO SOFT records (acc.cgi?form=text, targ=self).
 * No I/O — callers fetch the text and pass it in.
 */

export interface SoftRecord {
  entity_type: string;
  accession: string;
  fields: Map<string, string[]>;
  getSingle(key: string): string | undefined;
}

/** First value for a key, or undefined when the key is absent. */
export function getSoftValue(record: SoftRecord, key: string): string | undefined {
  return record.fields.get(key)?.[0];
}

/** All values for a repeated key (empty array when absent). */
export function getSoftValues(record: SoftRecord, key: string): string[] {
  return record.fields.get(key) ?? [];
}

export function parseSoftRecord(text: string): SoftRecord {
  const fields = new Map<string, string[]>();
  let entityType = '';
  let accession = '';
  let currentKey: string | null = null;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    // Continuation: SOFT wraps long values with leading whitespace on the
    // continuation line — append to the previous value line directly.
    if (/^[ \t]+\S/.test(rawLine) && currentKey !== null) {
      const values = fields.get(currentKey);
      if (values && values.length > 0) {
        values[values.length - 1] += rawLine.trim();
      }
      continue;
    }

    const line = rawLine.trimEnd();
    if (line === '') continue;

    if (line.startsWith('^^') || line.startsWith('^!')) continue; // sub-entity lines (never emitted with targ=self)

    if (line.startsWith('^')) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      if (entityType !== '') continue; // targ=self yields one record — ignore later entity headers
      entityType = line.slice(1, eq).trim();
      accession = line.slice(eq + 1).trim();
      currentKey = null;
      continue;
    }

    if (line.startsWith('!')) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(1, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === '') continue;
      const values = fields.get(key);
      if (values) values.push(value);
      else fields.set(key, [value]);
      currentKey = key;
    }
    // Anything else (comments, blank) is skipped.
  }

  return {
    entity_type: entityType,
    accession,
    fields,
    getSingle(key: string): string | undefined {
      return fields.get(key)?.[0];
    },
  };
}
