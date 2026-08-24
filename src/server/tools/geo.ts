import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { geoSearch, geoGet } from '../../entities/geo.js';

export function registerGeoTools(server: McpServer): void {
  server.registerTool(
    'geo_search',
    {
      description: `Search NCBI GEO (Gene Expression Omnibus) for functional genomics studies — expression microarrays, RNA-seq, and other high-throughput sequencing series.

Queries accept plain terms ("breast cancer RNA-seq", "melanoma single cell") or NCBI field syntax ("GSE183947[Accession]"). Each result carries cross-links for chaining: sra_project → sra_get, bioproject, pubmed_ids → article_get, and accession → geo_get for full details.`,
      inputSchema: {
        query: z.string().describe('Free-text GEO search terms, e.g. "breast cancer RNA-seq", "melanoma single cell"'),
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

download=true additionally saves the first supplementary file (.gz/.csv/.txt, subject to max_bytes) to a local temp path and returns its path, size, and source URL.`,
      inputSchema: {
        accession: z.string().regex(/^(GSE|GSM|GPL|GDS)\d+$/, 'GEO accession like GSE183947, GSM5574685, GPL11154').describe('GEO accession (GSE series, GSM sample, or GPL platform; GDS curated DataSets return guidance pointing at the underlying GSE/GSM)'),
        download: z.boolean().optional().describe('Download the first supplementary file (.gz) to a local temp path'),
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
