import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pdbSearch, pdbGet, pdbDownload } from '../../entities/pdb.js';
import { withToolTimeout, type CancellationCapableExtra } from './utils.js';

// Deadline rationale (#107 phase 2): entry metadata (15s), the parallel
// 8s-deadline section wave, and the optional structure download (pdb_files,
// 15s streaming) — 40s covers the per-leg budget ceilings with headroom
// while bounding signal-ignoring stragglers.
const PDB_TOOL_TIMEOUT_MS = 40000;

const PDB_SECTIONS = [
  'core', 'polymer_entities', 'ligands', 'assembly', 'experiment', 'citation', 'all',
] as const;

export function registerPdbTools(server: McpServer): void {
  server.registerTool(
    'pdb',
    {
      description: `Access the Protein Data Bank (RCSB PDB) for macromolecular structure data.

  SEARCH: Provide "query" to find structures (e.g., "kinase inhibitor", "hemoglobin").
  GET: Provide "pdb_id" to retrieve entry metadata with optional detail sections. Sections list per-entity records (polymer_entities, ligands, assembly); when some records fail while siblings succeed, each failure appears as an inline {_error} item AND the response carries a top-level "warnings" array naming the section and failed item.
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
    async ({ query, pdb_id, sections, download, format, limit, offset }, extra: CancellationCapableExtra) => {
      try {
        if (!query && !pdb_id) {
          return {
            content: [{ type: 'text', text: 'Provide either "query" to search or "pdb_id" to get/download.' }],
            isError: true,
          };
        }

        if (pdb_id) {
          const metadata = await withToolTimeout(
            () => pdbGet(pdb_id, sections),
            PDB_TOOL_TIMEOUT_MS,
            { signal: extra?.signal },
          );

          if (download) {
            const fileInfo = await withToolTimeout(
              () => pdbDownload(pdb_id, format ?? 'cif'),
              PDB_TOOL_TIMEOUT_MS,
              { signal: extra?.signal },
            );
            return { content: [{ type: 'text', text: JSON.stringify({ ...metadata, file: fileInfo }) }] };
          }

          return { content: [{ type: 'text', text: JSON.stringify(metadata) }] };
        }

        const results = await withToolTimeout(
          () => pdbSearch(query!, { limit, offset }),
          PDB_TOOL_TIMEOUT_MS,
          { signal: extra?.signal },
        );
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
