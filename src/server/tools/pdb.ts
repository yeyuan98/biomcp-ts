import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pdbSearch, pdbGet, pdbDownload } from '../../entities/pdb.js';

const PDB_SECTIONS = [
  'polymer_entities', 'ligands', 'assembly', 'experiment', 'citation', 'all',
] as const;

function sliceArraysRecursive(obj: unknown, limit: number): unknown {
  if (Array.isArray(obj)) return obj.slice(0, limit);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = sliceArraysRecursive(v, limit);
    }
    return result;
  }
  return obj;
}

export function registerPdbTools(server: McpServer): void {
  server.registerTool(
    'pdb',
    {
      description: `Access the Protein Data Bank (RCSB PDB) for macromolecular structure data.

  SEARCH: Provide "query" to find structures (e.g., "kinase inhibitor", "hemoglobin").
  GET: Provide "pdb_id" to retrieve entry metadata with optional detail sections.
  DOWNLOAD: Provide "pdb_id" + download=true to save the structure file and get the file path.`,
      inputSchema: {
        query: z.string().optional().describe(
          'Free-text search query to find PDB entries. Omit pdb_id when searching.'
        ),
        pdb_id: z.string().regex(/^[A-Za-z0-9]{4}$/).optional().describe(
          'PDB identifier (e.g., "1CRN", "4HHB"). Required for get/download.'
        ),
        sections: z.array(z.enum(PDB_SECTIONS)).optional().describe(
          'Metadata sections: polymer_entities (chains and sequences), ligands (small molecules and ions), assembly (biological assembly), experiment (method, resolution), citation (publication). Use "all" for everything. Default: core summary only.'
        ),
        download: z.boolean().default(false).describe(
          'Save the structure file to disk and return the file path. Only used with pdb_id.'
        ),
        format: z.enum(['cif', 'pdb']).default('cif').describe(
          'File format: "cif" (mmCIF, recommended, always available) or "pdb" (legacy format, may not exist for some entries). Only used with download=true.'
        ),
        limit: z.number().int().min(1).max(50).default(10).describe('Max search results'),
        offset: z.number().int().min(0).default(0).describe('Search result offset'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ query, pdb_id, sections, download, format, limit, offset }) => {
      try {
        if (!query && !pdb_id) {
          return {
            content: [{ type: 'text', text: 'Provide either "query" to search or "pdb_id" to get/download.' }],
            isError: true,
          };
        }

        if (pdb_id) {
          const metadata = await pdbGet(pdb_id, sections);

          if (download) {
            const fileInfo = await pdbDownload(pdb_id, format ?? 'cif');
            return { content: [{ type: 'text', text: JSON.stringify({ ...metadata, file: fileInfo }) }] };
          }

          return { content: [{ type: 'text', text: JSON.stringify(metadata) }] };
        }

        const results = await pdbSearch(query!, { limit, offset });
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: String(error) }],
          isError: true,
        };
      }
    }
  );
}
