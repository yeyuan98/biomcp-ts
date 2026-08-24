import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CsvParser, parseCsvFile, parseCsvString } from '../../../../scripts/external-databases/depmap/csv.js';

describe('depmap csv parser', () => {
  it('parses plain rows with CRLF and a trailing row without newline', () => {
    const rows = parseCsvString('a,b,c\r\n1,2,3\r\n4,5,6');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
  });

  it('parses quoted commas, escaped quotes, and quoted newlines', () => {
    const rows = parseCsvString('"x,y","he said ""hi""","line1\nline2",plain');
    expect(rows).toEqual([['x,y', 'he said "hi"', 'line1\nline2', 'plain']]);
  });

  it('skips blank lines but keeps single-column values', () => {
    const rows = parseCsvString('Gene\n\nKRAS (3847)\n\nTP53 (7157)\n');
    expect(rows).toEqual([['Gene'], ['KRAS (3847)'], ['TP53 (7157)']]);
  });

  it('handles an escaped quote split across chunk boundaries', () => {
    const parser = new CsvParser();
    const first = parser.push('"abc"');
    const second = parser.push('"d",x\n');
    const final = parser.end();
    expect([...first, ...second, ...final]).toEqual([['abc"d', 'x']]);
  });

  it('handles a closing quote split across chunks', () => {
    const parser = new CsvParser();
    const rows = [...parser.push('"val'), ...parser.push('ue",next\n'), ...parser.end()];
    expect(rows).toEqual([['value', 'next']]);
  });

  it('parses a file with tiny chunks (forcing boundaries inside quotes)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'depmap-csv-'));
    const file = join(dir, 'fixture.csv');
    writeFileSync(file, 'name,note\n"KRAS","a,""quoted"", comma"\n"TP53","multi\nline"');
    const rows: string[][] = [];
    for await (const row of parseCsvFile(file, { highWaterMark: 3 })) rows.push(row);
    expect(rows).toEqual([
      ['name', 'note'],
      ['KRAS', 'a,"quoted", comma'],
      ['TP53', 'multi\nline'],
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});
