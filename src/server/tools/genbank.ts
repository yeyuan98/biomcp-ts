import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { genbankSearch, genbankGet, genbankToGeneIds } from '../../entities/genbank.js';
import type { GenbankRecord } from '../../entities/genbank.js';
import { writeGenbankFile, GENBANK_MAX_FILE_CHARS } from './genbank-store.js';

/** Auto-inline ceiling: records at or under this length are returned inline
 *  as today; anything larger defaults to file mode (full data on disk). */
const SEQUENCE_INLINE_MAX_CHARS = 1_000;
/** Inline-path safety cap (the pre-file-mode behavior, kept for the explicit
 *  sequence_output:"inline" opt-in and for store-failure fallback). */
const SEQUENCE_TEXT_MAX_CHARS = 200_000;

const FILE_NOTE =
  'Full sequence written to file (ephemeral cache; re-call to regenerate; path is server-local). ' +
  'Read LOCUS/FEATURES/ORIGIN via offset or grep.';

/** Output guard for inline mode: whole-record efetch text can be megabytes —
 *  cap what goes back to the LLM and tell it how to get the rest via a
 *  region request. */
function truncateSequenceText(record: GenbankRecord): GenbankRecord {
  const text = record.sequence_text;
  if (text.length <= SEQUENCE_TEXT_MAX_CHARS) return record;
  const omitted = text.length - SEQUENCE_TEXT_MAX_CHARS;
  return {
    ...record,
    sequence_text:
      text.slice(0, SEQUENCE_TEXT_MAX_CHARS) +
      `\n...[truncated ${omitted} of ${text.length} chars — request a seq_start/seq_stop region for the full text]`,
  };
}

/** Inline response: the record (possibly truncated) plus honest counts. */
function inlineResponse(record: GenbankRecord, fallbackReason?: string): Record<string, unknown> {
  const total = record.sequence_text.length;
  const truncated = total > SEQUENCE_TEXT_MAX_CHARS;
  const inline = truncateSequenceText(record);
  const out: Record<string, unknown> = {
    ...inline,
    char_count: inline.sequence_text.length,
    total_char_count: total,
    truncated,
  };
  if (fallbackReason) {
    out.note = `File output was requested but unavailable — returning inline text instead: ${fallbackReason}.`;
  }
  return out;
}

/** File response: metadata plus a handle; sequence_text is omitted (the full
 *  text lives in the file). */
function fileResponse(
  record: GenbankRecord,
  write: { file_path: string; char_count: number; total_char_count: number; truncated: boolean }
): Record<string, unknown> {
  const { sequence_text: _fullText, ...meta } = record;
  const note = write.truncated
    ? `${FILE_NOTE} File truncated at the ${GENBANK_MAX_FILE_CHARS.toLocaleString('en-US')}-char safety cap.`
    : FILE_NOTE;
  return {
    ...meta,
    mode: 'file',
    file_path: write.file_path,
    char_count: write.char_count,
    total_char_count: write.total_char_count,
    truncated: write.truncated,
    note,
  };
}

export function registerGenbankTools(server: McpServer): void {
  server.registerTool(
    'genbank_search',
    {
      description: `Search NCBI nucleotide records (GenBank/RefSeq/INSDC).

Queries may be plain terms, an accession, or NCBI field syntax ("TP53[Gene Name] AND Homo sapiens[Organism]", "BRCA1[Gene Name]"). Results include accession.version, definition, length_bp, organism, and topology — chain accessions into genbank_get or genbank_genes.`,
      inputSchema: {
        query: z.string().trim().min(1, 'Query must be a non-empty string after trimming').describe('Nucleotide query, e.g. "TP53[Gene Name] AND Homo sapiens[Organism]" or an accession'),
        organism: z.string().optional().describe('Filter by organism (e.g. "Homo sapiens")'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset for pagination'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, organism, limit, offset }) => {
      try {
        const results = await genbankSearch(query, { organism, limit, offset });
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'genbank_get',
    {
      description: `Fetch a GenBank/RefSeq nucleotide record as text (GenBank flat file or FASTA).

Whole-record fetches are capped at 2,000,000 bp — larger records require a seq_start/seq_stop region (1-based, inclusive, up to 10 Mb span; set strand=2 for a reverse-strand slice where seq_start > seq_stop — the region field echoes the request as given, while NCBI's text shows complement(min..max)). Output: records up to 1,000 characters are returned inline (sequence_text with char_count/truncated). Anything larger defaults to file mode — the FULL text is written to a server-side cache file and the reply carries mode:"file", file_path, char_count, and total_char_count instead of sequence_text (never truncated); Read/Grep the file selectively. The cache is ephemeral (pruned after ~7 days / 500 files) and the path is server-local; re-call to regenerate. sequence_output:"inline" opts back into inline text capped at 200,000 characters — use it only if you cannot read server-side files.`,
      inputSchema: {
        accession: z.string().describe('GenBank/RefSeq accession, versioned or bare — NC_000023.11, NG_017013.2, KJ668569.1, NC_000908.2'),
        format: z.enum(['genbank', 'fasta']).default('genbank').describe('Record format: genbank flat file (default) or fasta'),
        seq_start: z.number().int().min(1).optional().describe('Region start (1-based, inclusive) — required with seq_stop for records over 2 Mb'),
        seq_stop: z.number().int().min(1).optional().describe('Region stop (1-based, inclusive)'),
        strand: z.union([z.literal(1), z.literal(2)]).optional().describe('Strand: 1=plus (default), 2=minus (reverse slice; allows seq_start > seq_stop)'),
        max_response_bytes: z.number().int().min(1).optional().describe('Hard cap on the raw NCBI response in characters (default 30,000,000) — oversized responses error instead of truncating'),
        sequence_output: z.enum(['file', 'inline']).optional().describe('Output mode: "file" (default) writes records over 1,000 characters whole to a server-side cache file and returns file_path + char counts (full data, never truncated); "inline" returns sequence_text inline, capped at 200,000 characters — use only if you cannot read server-side files'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accession, format, seq_start, seq_stop, strand, max_response_bytes, sequence_output }) => {
      try {
        const record = await genbankGet(accession, {
          format,
          seq_start,
          seq_stop,
          strand,
          maxResponseBytes: max_response_bytes,
        });
        const total = record.sequence_text.length;
        if (sequence_output === 'inline' || total <= SEQUENCE_INLINE_MAX_CHARS) {
          return { content: [{ type: 'text', text: JSON.stringify(inlineResponse(record)) }] };
        }
        const write = writeGenbankFile({
          accession: record.accession,
          format,
          region: record.region,
          text: record.sequence_text,
        });
        if (write.ok) {
          return { content: [{ type: 'text', text: JSON.stringify(fileResponse(record, write)) }] };
        }
        // Cache trouble must never fail or degrade the tool: fall back to the
        // old inline behavior, disclosed in the note and logged per house style.
        console.error('[genbank] file store unavailable, falling back to inline:', write.reason);
        return {
          content: [{ type: 'text', text: JSON.stringify(inlineResponse(record, write.reason)) }],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'genbank_genes',
    {
      description: `Map a GenBank/RefSeq nucleotide accession to its NCBI Gene IDs (elink nuccore→gene).

The returned gene_ids are entrezgene IDs usable directly with MyGene-backed gene tools (gene_get, gene_search). Useful bridge from a sequence record to gene-level annotation.`,
      inputSchema: {
        accession: z.string().describe('GenBank/RefSeq accession, versioned or bare — e.g. NG_017013.2, NC_000023.11'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accession }) => {
      try {
        const geneIds = await genbankToGeneIds(accession);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              gene_ids: geneIds,
              note: 'NCBI Gene IDs — usable as entrezgene IDs with MyGene tools',
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}
