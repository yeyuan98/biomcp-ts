import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { geoSearch, geoGet } from '../../entities/geo.js';

export function registerGeoTools(server: McpServer): void {
  server.registerTool(
    'geo_search',
    {
      description: `Search NCBI GEO (Gene Expression Omnibus) for functional genomics studies — expression microarrays, RNA-seq, and other high-throughput sequencing series.

Queries accept plain terms ("breast cancer RNA-seq", "melanoma single cell") or NCBI field syntax ("GSE183947[Accession]"). Every result carries accession (→ geo_get for full details), bioproject, and pubmed_ids (→ article_get). sra_project (→ sra_get) appears only when NCBI has linked the SRA study to the series — many newer series lack the link — so geo_get(accession) is the reliable route to SRA accessions (its sra field).`,
      inputSchema: {
        query: z.string().trim().min(1, 'Query must be a non-empty string after trimming').describe('Free-text GEO search terms, e.g. "breast cancer RNA-seq", "melanoma single cell"'),
        entry_type: z.enum(['gse', 'gsm', 'gpl', 'gds']).optional().describe('GEO entry type — gse=study (default), gsm=sample, gpl=platform, gds=curated dataset'),
        organism: z.string().optional().describe('Filter by organism (e.g. "Homo sapiens", "Mus musculus")'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset for pagination'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, entry_type, organism, limit, offset }) => {
      try {
        const results = await geoSearch(query, {
          entryType: entry_type ?? 'gse',
          organism,
          limit,
          offset,
        });
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'geo_get',
    {
      description: `Get the full SOFT record details for a GEO entry: series (GSE...), sample (GSM...), or platform (GPL...).

A series detail includes summary, organisms, platform_ids, a sample preview, supplementary file URLs, and cross-references for chaining: sra → sra_get(SRP.../SRR...), pubmed_ids → article_get, samples → geo_get(GSM...), platform_ids → geo_get(GPL...).

GDS accessions (curated DataSets, not served by SOFT) return structured guidance as data — { accession, guidance, see_also: { series: "GSE…", sample: "GSM…" } } — pointing at the underlying series/sample records; this is a successful result, not an error. Malformed accessions still fail at schema validation.

download=true additionally saves a supplementary file to a local temp path and returns its path, size, and source URL — the pick prefers .gz/.csv/.txt, else the first listed supplementary file (subject to max_bytes).`,
      inputSchema: {
        accession: z.string().regex(/^(GSE|GSM|GPL|GDS)\d+$/i, 'GEO accession like GSE183947, GSM5574685, GPL11154').describe('GEO accession (GSE series, GSM sample, or GPL platform; GDS curated DataSets return structured guidance pointing at the underlying GSE/GSM)'),
        download: z.boolean().optional().describe('Download a supplementary file to a local temp path (prefers .gz/.csv/.txt, else the first listed)'),
        max_bytes: z.number().int().min(1_000_000).optional().describe('Size cap in bytes for the downloaded supplementary file (default 52428800 = 50 MB)'),
      },
      // download=true writes to disk — pdb precedent.
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ accession, download, max_bytes }) => {
      try {
        const detail = await geoGet(accession, { download, maxBytes: max_bytes });
        return { content: [{ type: 'text', text: JSON.stringify(detail) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}
