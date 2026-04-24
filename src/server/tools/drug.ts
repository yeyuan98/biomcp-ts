import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { drugSearch, drugGet } from '../../entities/drug.js';

const DRUG_SECTIONS = [
  'core', 'us_regulatory', 'eu_regulatory', 'who_regulatory', 'safety', 'targets', 'indications', 'all'
] as const;

export function registerDrugTools(server: McpServer): void {
  server.registerTool(
    'drug_search',
    {
      description: 'Search for drugs by name, mechanism, or keyword',
      inputSchema: {
        query: z.string().describe('Drug name, mechanism, or keyword to search for'),
        drug_type: z.string().optional().describe('Filter by drug type'),
        source: z.string().optional().describe('Filter by source (mychem, chembl, openfda)'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, drug_type, source, limit, offset }) => {
      try {
        const results = await drugSearch(query, { drug_type, source, limit, offset });
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { 
          content: [{ type: 'text', text: String(error) }],
          isError: true 
        };
      }
    }
  );

  server.registerTool(
    'drug_get',
    {
      description: 'Get detailed drug information by name',
      inputSchema: {
        name: z.string().describe('Drug name (e.g., "imatinib", "aspirin")'),
        sections: z.array(z.enum(DRUG_SECTIONS)).optional().describe('Sections to include'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ name, sections }) => {
      try {
        const result = await drugGet(name, sections);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { 
          content: [{ type: 'text', text: String(error) }],
          isError: true 
        };
      }
    }
  );

  server.registerTool(
    'drug_targets',
    {
      description: 'Get drug targets via ChEMBL',
      inputSchema: {
        name: z.string().describe('Drug name'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ name, limit }) => {
      try {
        const result = await drugGet(name, ['targets']);
        const section = result.sections?.targets;
        if (section && typeof section === 'object' && '_error' in section) {
          return { content: [{ type: 'text', text: JSON.stringify(section) }], isError: true };
        }
        const targets = (Array.isArray(section) ? section : []).slice(0, limit) || [];
        return { content: [{ type: 'text', text: JSON.stringify(targets) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'drug_indications',
    {
      description: 'Get drug indications via ChEMBL',
      inputSchema: {
        name: z.string().describe('Drug name'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ name, limit }) => {
      try {
        const result = await drugGet(name, ['indications']);
        const section = result.sections?.indications;
        if (section && typeof section === 'object' && '_error' in section) {
          return { content: [{ type: 'text', text: JSON.stringify(section) }], isError: true };
        }
        const indications = (Array.isArray(section) ? section : []).slice(0, limit) || [];
        return { content: [{ type: 'text', text: JSON.stringify(indications) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'drug_adverse_events',
    {
      description: 'Get adverse events for a drug via OpenFDA',
      inputSchema: {
        name: z.string().describe('Drug name'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ name }) => {
      try {
        const result = await drugGet(name, ['safety']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.safety) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'drug_regulatory',
    {
      description: 'Get FDA regulatory information for a drug',
      inputSchema: {
        name: z.string().describe('Drug name'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ name }) => {
      try {
        const result = await drugGet(name, ['us_regulatory']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.us_regulatory) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}