export class CsvParser {
  private row: string[] = [];
  private field = '';
  private inQuotes = false;
  private pendingQuote = false;

  push(chunk: string): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (c === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false;
      }
      if (this.inQuotes) {
        if (c === '"') {
          if (i + 1 < chunk.length) {
            if (chunk[i + 1] === '"') {
              this.field += '"';
              i++;
            } else {
              this.inQuotes = false;
            }
          } else {
            this.pendingQuote = true;
          }
        } else {
          this.field += c;
        }
      } else if (c === '"') {
        this.inQuotes = true;
      } else if (c === ',') {
        this.row.push(this.field);
        this.field = '';
      } else if (c === '\n') {
        this.row.push(this.field);
        this.field = '';
        if (this.row.length > 1 || this.row[0] !== '') out.push(this.row);
        this.row = [];
      } else if (c !== '\r') {
        this.field += c;
      }
    }
    return out;
  }

  end(): string[][] {
    const out: string[][] = [];
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.field !== '' || this.row.length > 0) {
      this.row.push(this.field);
      if (this.row.length > 1 || this.row[0] !== '') out.push(this.row);
    }
    this.row = [];
    this.field = '';
    return out;
  }
}

export function parseCsvString(text: string): string[][] {
  const parser = new CsvParser();
  return [...parser.push(text), ...parser.end()];
}

export async function* parseCsvFile(
  path: string,
  options?: { highWaterMark?: number }
): AsyncGenerator<string[]> {
  const { createReadStream } = await import('node:fs');
  const stream = createReadStream(path, {
    encoding: 'utf8',
    highWaterMark: options?.highWaterMark ?? 1 << 21,
  });
  const parser = new CsvParser();
  try {
    for await (const chunk of stream) {
      for (const row of parser.push(chunk as string)) yield row;
    }
    for (const row of parser.end()) yield row;
  } finally {
    stream.destroy();
  }
}
