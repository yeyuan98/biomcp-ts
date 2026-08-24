import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { genbankSearch, genbankGet, genbankToGeneIds } from '../../entities/genbank.js';
import type { GenbankRecord } from '../../entities/genbank.js';

const SEQUENCE_TEXT_MAX_CHARS = 200_000;

/** Output guard: whole-record efetch text can be megabytes — cap what goes
 *  back to the LLM and tell it how to get the rest via a region request. */
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

export function registerGenbankTools(server: McpServer): void {
  server.registerTool(
    'genbank_search',
    {
      description: `Search NCBI nucleotide records (GenBank/RefSeq/INSDC).

Queries may be plain terms, an accession, or NCBI field syntax ("TP53[Gene Name] AND Homo sapiens[Organism]", "BRCA1[Gene Name]"). Results include accession.version, definition, length_bp, organism, and topology — chain accessions into genbank_get or genbank_genes.`,
      inputSchema: {
        query: z.string().describe('Nucleotide query, e.g. "TP53[Gene Name] AND Homo sapiens[Organism]" or an accession'),
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

Whole-record fetches are capped at 2,000,000 bp — larger records require a seq_start/seq_stop region (1-based, inclusive, up to 10 Mb span; set strand=2 for a reverse-strand slice where seq_start > seq_stop). Output guard: sequence_text is truncated to its first 200,000 characters when oversized — request a narrower region for the full text.`,
      inputSchema: {
        accession: z.string().describe('GenBank/RefSeq accession, versioned or bare — NC_000023.11, NG_017013.2, KJ668569.2'),
        format: z.enum(['genbank', 'fasta']).default('genbank').describe('Record format: genbank flat file (default) or fasta'),
        seq_start: z.number().int().min(1).optional().describe('Region start (1-based, inclusive) — required with seq_stop for records over 2 Mb'),
        seq_stop: z.number().int().min(1).optional().describe('Region stop (1-based, inclusive)'),
        strand: z.union([z.literal(1), z.literal(2)]).optional().describe('Strand: 1=plus (default), 2=minus (reverse slice; allows seq_start > seq_stop)'),
        max_response_bytes: z.number().int().min(1).optional().describe('Hard cap on the raw NCBI response in characters (default 30,000,000) — oversized responses error instead of truncating'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accession, format, seq_start, seq_stop, strand, max_response_bytes }) => {
      try {
        const record = await genbankGet(accession, {
          format,
          seq_start,
          seq_stop,
          strand,
          maxResponseBytes: max_response_bytes,
        });
        return { content: [{ type: 'text', text: JSON.stringify(truncateSequenceText(record)) }] };
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
