import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { diseaseSearch, diseaseGet } from '../../entities/disease.js';
import { connectionManager } from '../../connections/manager.js';
import { applyLimit } from './utils.js';

const DISEASE_SECTIONS = [
  'core', 'gene_associations', 'phenotypes', 'pathways', 'survival', 'all'
] as const;

const DISEASE_ALL_SECTIONS = ['gene_associations', 'phenotypes', 'pathways', 'survival'];
const DISEASE_STORAGE_KEYS: Record<string, string> = {};
const DISEASE_ARRAY_KEYS: Record<string, string[]> = {
  gene_associations: [],
  phenotypes: [],
  pathways: [],
};

interface ClinicalTrialsDiseaseResponse {
  studies?: Array<{
    protocolSection?: {
      identificationModule?: {
        nctId?: string;
        briefTitle?: string;
      };
      statusModule?: {
        overallStatus?: string;
      };
    };
  }>;
}

function isDiseaseId(input: string): boolean {
  if (/^(DOID|MONDO|OMIM|OMOPS|ORPHA|Orphanet|EFO)[:_]/i.test(input)) return true;
  if (/^C\d{7}$/.test(input)) return true;
  return false;
}

export function registerDiseaseTools(server: McpServer): void {
  server.registerTool(
    'disease_search',
    {
      description: 'Search for diseases by name, phenotype, or keyword',
      inputSchema: {
        query: z.string().describe('Disease name, phenotype, or keyword to search for'),
        disease_type: z.string().optional().describe('Filter by disease type'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, disease_type, limit, offset }) => {
      try {
        const results = await diseaseSearch(query, { disease_type, limit, offset });
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
    'disease_get',
    {
      description: 'Get detailed disease information by ID',
      inputSchema: {
        disease_id: z.string().describe('Disease ID (e.g., "DOID:0060268", "C0018794")'),
        sections: z.array(z.enum(DISEASE_SECTIONS)).optional().describe('Sections to include'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ disease_id, sections, limit }) => {
      try {
        const result = await diseaseGet(disease_id, sections);
        const requestedSections = (sections ?? []).includes('all')
          ? DISEASE_ALL_SECTIONS
          : (sections ?? []);
        if (result.sections) {
          applyLimit(result.sections, requestedSections, DISEASE_STORAGE_KEYS, DISEASE_ARRAY_KEYS, limit);
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
    'disease_drugs',
    {
      description: 'Get drugs for a disease via OpenTargets',
      inputSchema: {
        disease_id: z.string().describe('Disease ID'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ disease_id, limit }) => {
      try {
        const { diseaseToDrugs } = await import('../../entities/cross-entity.js');
        const drugs = await diseaseToDrugs(disease_id);
        return { content: [{ type: 'text', text: JSON.stringify(drugs.slice(0, limit)) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'disease_trials',
    {
      description: 'Get clinical trials for a disease',
      inputSchema: {
        disease_id: z.string().describe('Disease ID'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ disease_id, limit }) => {
      try {
        let searchName = disease_id;

        if (isDiseaseId(disease_id)) {
          try {
            const { diseaseGet } = await import('../../entities/disease.js');
            const resolved = await diseaseGet(disease_id, []);
            if (resolved.name && resolved.name !== disease_id) {
              searchName = resolved.name;
            }
          } catch {
            return { 
              content: [{ type: 'text', text: JSON.stringify({ 
                _error: `Disease '${disease_id}' not found. Try disease_search to find valid disease IDs. Supported ID formats: MONDO:XXXXXXX, DOID:XXXXXXX, OMIM:XXXXXX.` 
              }) }],
              isError: true 
            };
          }
        }

        if (!searchName || searchName.trim() === '') {
          return { 
            content: [{ type: 'text', text: JSON.stringify({ 
              _error: `Disease '${disease_id}' could not be resolved to a valid search term. Try disease_search to find valid disease IDs.` 
            }) }],
            isError: true 
          };
        }

        const conn = connectionManager.getConnection('clinicaltrials');
        const response = await conn.request(
          `/studies?query.cond=${encodeURIComponent(searchName)}&pageSize=${limit}&format=json`
        ) as ClinicalTrialsDiseaseResponse;
        const trials = (response.studies || []).map(s => ({
          nct_id: s.protocolSection?.identificationModule?.nctId,
          title: s.protocolSection?.identificationModule?.briefTitle,
          status: s.protocolSection?.statusModule?.overallStatus,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(trials) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}
