import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { drugSearch, drugGet } from '../../entities/drug.js';
import { drugToTrials } from '../../entities/cross-entity.js';
import { sliceArraysRecursive } from './utils.js';

const DRUG_SECTIONS = [
  'core', 'us_regulatory', 'eu_regulatory', 'who_regulatory', 'safety', 'targets', 'indications', 'adverse_events', 'all'
] as const;

const DRUG_ALL_SECTIONS = ['us_regulatory', 'eu_regulatory', 'who_regulatory', 'safety', 'targets', 'indications', 'adverse_events'];
const DRUG_STORAGE_KEYS: Record<string, string> = {};
const DRUG_ARRAY_KEYS: Record<string, string[]> = {
  targets: [],
  indications: [],
  adverse_events: ['reactions'],
};

export function registerDrugTools(server: McpServer): void {
  server.registerTool(
    'drug_search',
    {
      description: 'Search for drugs by name, mechanism, or keyword',
      inputSchema: {
        query: z.string().describe('Drug name, mechanism, or keyword to search'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, limit, offset }) => {
      try {
        const results = await drugSearch(query, { limit, offset });
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
        sections: z.array(z.enum(DRUG_SECTIONS)).optional().describe('Sections to include (adverse_events = FDA FAERS adverse reactions ranked by report count; limit applies to reaction rows)'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ name, sections, limit }) => {
      try {
        const result = await drugGet(name, sections, limit);
        const requestedSections = (sections ?? []).includes('all')
          ? DRUG_ALL_SECTIONS
          : (sections ?? []);
        if (result.sections) {
          for (const name_ of requestedSections) {
            const data = result.sections[name_];
            if (!data || typeof data !== 'object') continue;
            if (Array.isArray(data)) {
              result.sections[name_] = data.slice(0, limit);
            } else if (DRUG_ARRAY_KEYS[name_]) {
              const keys = DRUG_ARRAY_KEYS[name_];
              const obj = data as Record<string, unknown>;
              for (const k of keys) {
                if (Array.isArray(obj[k])) obj[k] = obj[k].slice(0, limit);
              }
            } else {
              result.sections[name_] = sliceArraysRecursive(data, limit);
            }
          }
        }
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
    'drug_trials',
    {
      description: 'Find clinical trials for a drug',
      inputSchema: {
        drug: z.string().describe('Drug name'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ drug }) => {
      try {
        const results = await drugToTrials(drug);
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}
