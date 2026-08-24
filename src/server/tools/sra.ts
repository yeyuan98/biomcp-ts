import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sraSearch, sraGet } from '../../entities/sra/index.js';

const SRA_ACCESSION_REGEX = /^SR[PXRSZ]\d+$/;
const ENA_DDBJ_ACCESSION_REGEX = /^(ER|DR)[PXRS]\d+$/;

export function registerSraTools(server: McpServer): void {
  server.registerTool(
    'sra_search',
    {
      description: `Search NCBI's Sequence Read Archive (SRA) for sequencing experiments and runs.

The query may be free text, an accession (SRP study, SRX experiment, SRR run, SRS sample), or NCBI field syntax ("RNA-SEQ AND Homo sapiens[Organism]"). Results list experiment/study/sample accessions, organism, library strategy, run count, and first_run_accession for chaining into sra_get.`,
      inputSchema: {
        query: z.string().describe('Free text or accession — SRP study, SRX experiment, SRR run, SRS sample, or terms like "RNA-SEQ AND Homo sapiens[Organism]"'),
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
      description: `Get full details for an NCBI SRA accession: SRR run (instrument, spots, bases, size), SRX experiment (library design), SRP study (experiment list), or SRS sample.

Chain from geo_get (sra field) or sra_search (experiment_accession / first_run_accession). European (ERP/ERR) and DDBJ (DRP/DRR) accessions are NOT indexed in NCBI SRA — use ENA (https://www.ebi.ac.uk/ena) for those.`,
      inputSchema: {
        accession: z.string().describe('NCBI SRA accession: SRP (study), SRX (experiment), SRR (run), SRS (sample), or SRZ (analysis), e.g. SRR14432476'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accession }) => {
      try {
        const normalized = accession.trim().toUpperCase();
        if (ENA_DDBJ_ACCESSION_REGEX.test(normalized)) {
          throw new Error(
            `European/DDBJ accession ${normalized} — use ENA (https://www.ebi.ac.uk/ena) — NCBI SRA does not index it`
          );
        }
        if (!SRA_ACCESSION_REGEX.test(normalized)) {
          throw new Error(
            `Expected NCBI SRA accession SRP/SRX/SRR/SRS/SRZ like SRR14432476 — got "${accession}"`
          );
        }
        const detail = await sraGet(normalized);
        return { content: [{ type: 'text', text: JSON.stringify(detail) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}
