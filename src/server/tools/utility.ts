import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connectionManager } from '../../connections/manager.js';

export function registerUtilityTools(server: McpServer): void {
  server.registerTool(
    'biomcp_health',
    {
      description: 'Check connectivity to upstream data sources',
      inputSchema: {
        apis_only: z.boolean().default(false).describe('Check only APIs, skip local file sources'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ apis_only }) => {
      const sourcesToCheck = [
        'mygene',
        'myvariant',
        'pubmed',
        'uniprot',
        'clinicaltrials',
      ];
      
      const results: Array<{ name: string; status: string; latency_ms?: number; error?: string }> = [];
      
      for (const sourceId of sourcesToCheck) {
        const start = Date.now();
        try {
          const conn = connectionManager.getConnection(sourceId);
          const healthy = await conn.healthCheck();
          results.push({
            name: sourceId,
            status: healthy ? 'ok' : 'error',
            latency_ms: Date.now() - start,
          });
        } catch (error) {
          results.push({
            name: sourceId,
            status: 'error',
            latency_ms: Date.now() - start,
            error: String(error),
          });
        }
      }
      
      const allOk = results.every(r => r.status === 'ok');
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: allOk ? 'ok' : 'degraded',
            sources: results,
          })
        }]
      };
    }
  );

  server.registerTool(
    'biomcp_list',
    {
      description: 'List available entities, tools, and operations',
      inputSchema: {
        entity: z.string().optional().describe('Entity to get details for'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ entity }) => {
      const entities = {
        gene: {
          operations: ['search', 'get', 'pathways', 'diseases'],
          description: 'Gene information from MyGene.info, UniProt, Reactome, etc.',
        },
        variant: {
          operations: ['search', 'get'],
          description: 'Variant information from MyVariant.info, ClinVar, gnomAD, etc.',
        },
        drug: {
          operations: ['search', 'get'],
          description: 'Drug information from MyChem, ChEMBL, OpenFDA, etc.',
        },
        disease: {
          operations: ['search', 'get'],
          description: 'Disease information from MyDisease, Monarch, OpenTargets, etc.',
        },
        article: {
          operations: ['search', 'get'],
          description: 'Literature from PubMed, EuropePMC, Semantic Scholar, etc.',
        },
        trial: {
          operations: ['search', 'get'],
          description: 'Clinical trials from ClinicalTrials.gov and NCI CTS',
        },
        pathway: {
          operations: ['search', 'get'],
          description: 'Pathways from Reactome, KEGG, WikiPathways',
        },
      };
      
      const toolList = [
        'gene_search', 'gene_get', 'gene_pathways', 'gene_diseases', 'gene_go_enrichment',
        'gene_interactions', 'gene_expression', 'gene_constraint', 'gene_druggability', 'gene_clingen',
        'variant_search', 'variant_get',
        'drug_search', 'drug_get',
        'disease_search', 'disease_get',
        'article_search', 'article_get',
        'trial_search', 'trial_get',
        'gene_drugs', 'gene_trials', 'gene_articles',
        'variant_trials',
        'drug_genes', 'drug_trials',
        'gene_enrich', 'discover', 'search_all', 'batch_get',
        'biomcp_health', 'biomcp_list', 'version',
      ];
      
      const output = entity && entities[entity as keyof typeof entities]
        ? entities[entity as keyof typeof entities]
        : { entities, tools: toolList };
      
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }]
      };
    }
  );

  server.registerTool(
    'version',
    {
      description: 'Get BioMCP server version',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            name: 'biomcp',
            version: '1.0.0',
            description: 'BioMCP - Biomedical MCP Server',
            sdk: '@modelcontextprotocol/sdk v1.x',
          })
        }]
      };
    }
  );
}