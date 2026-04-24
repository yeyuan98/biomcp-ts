import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { diseaseSearch, diseaseGet } from '../../entities/disease.js';
import { connectionManager } from '../../connections/manager.js';

const DISEASE_SECTIONS = [
  'core', 'gene_associations', 'phenotypes', 'pathways', 'survival', 'all'
] as const;

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
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ disease_id, sections }) => {
      try {
        const result = await diseaseGet(disease_id, sections);
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
    'disease_genes',
    {
      description: 'Get genes associated with a disease via DisGeNET',
      inputSchema: {
        disease_id: z.string().describe('Disease ID'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ disease_id, limit }) => {
      try {
        const result = await diseaseGet(disease_id, ['gene_associations']);
        const genes = (result as { sections?: { gene_associations?: Array<{ gene_symbol: string; name: string }> } }).sections?.gene_associations?.slice(0, limit) || [];
        return { content: [{ type: 'text', text: JSON.stringify(genes) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'disease_phenotypes',
    {
      description: 'Get HPO phenotypes for a disease',
      inputSchema: {
        disease_id: z.string().describe('Disease ID'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ disease_id, limit }) => {
      try {
        const result = await diseaseGet(disease_id, ['phenotypes']);
        const phenotypesRaw = (result as { sections?: { phenotypes?: unknown } }).sections?.phenotypes;
        const phenotypes = Array.isArray(phenotypesRaw)
          ? (phenotypesRaw as Array<{ hpo_id: string; name: string }>).slice(0, limit)
          : phenotypesRaw;
        return { content: [{ type: 'text', text: JSON.stringify(phenotypes) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
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

        if (disease_id.match(/^(DOID|MONDO|OMIM|OMOPS|ORPHA):/i)) {
          try {
            const { diseaseGet } = await import('../../entities/disease.js');
            const resolved = await diseaseGet(disease_id, []);
            if (resolved.name && resolved.name !== disease_id) {
              searchName = resolved.name;
            }
          } catch {
            searchName = disease_id.replace(/^(DOID|MONDO|OMIM):\d+$/, '');
          }
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