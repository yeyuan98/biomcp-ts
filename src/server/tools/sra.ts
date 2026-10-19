import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sraSearch, sraGet } from '../../entities/sra/index.js';
import { sraAccessionParam } from './utils.js';

export function registerSraTools(server: McpServer): void {
  server.registerTool(
    'sra_search',
    {
      description: `Search NCBI's Sequence Read Archive (SRA) for sequencing experiments and runs.

The query may be free text, an accession (SRP study, SRX experiment, SRR run, SRS sample), or NCBI field syntax ("RNA-SEQ AND Homo sapiens[Organism]"). Results list experiment/study/sample accessions (NCBI S…, European E…, or DDBJ D… prefixes — all resolvable by sra_get), organism, library strategy, run count, and first_run_accession for chaining into sra_get.`,
      inputSchema: {
        query: z.string().trim().min(1, 'Query must be a non-empty string after trimming').describe('Free text or accession — SRP study, SRX experiment, SRR run, SRS sample (ENA/DDBJ ERP/ERX/DRP/DRX… counterparts also work), or terms like "RNA-SEQ AND Homo sapiens[Organism]"'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset for pagination'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit, offset }) => {
      try {
        const results = await sraSearch(query, { limit, offset });
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'sra_get',
    {
      description: `Get full details for an SRA accession indexed by NCBI: run (SRR/ERR/DRR — instrument, spots, bases, size), experiment (SRX/ERX/DRX — library design), study (SRP/ERP/DRP — experiment list), or sample (SRS/ERS/DRS). NCBI SRA indexes NCBI, European (ENA), and DDBJ submissions alike, so accessions returned by sra_search resolve here regardless of prefix.

Chain from geo_get (sra field) or sra_search (experiment_accession / first_run_accession).`,
      inputSchema: {
        accession: sraAccessionParam().describe('SRA accession: run (SRR/ERR/DRR), experiment (SRX/ERX/DRX), study (SRP/ERP/DRP), or sample (SRS/ERS/DRS), e.g. SRR14432476'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accession }) => {
      try {
        // Shape is enforced at the schema level (SRA_ACCESSION_RE, /i —
        // accepts NCBI/European/DDBJ prefixes alike); the handler only
        // normalizes case for the entity call.
        const normalized = accession.trim().toUpperCase();
        const detail = await sraGet(normalized);
        return { content: [{ type: 'text', text: JSON.stringify(detail) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}
