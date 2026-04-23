import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { trialSearch, trialGet } from '../../entities/trial.js';

const TRIAL_SECTIONS = ['core', 'eligibility', 'locations', 'outcomes', 'all'] as const;

export function registerTrialTools(server: McpServer): void {
  server.registerTool(
    'trial_search',
    {
      description: 'Search clinical trials by condition, intervention, or keyword',
      inputSchema: {
        query: z.string().describe('Condition, intervention, or keyword to search for'),
        status: z.string().optional().describe('Filter by status (Recruiting, Completed, etc.)'),
        phase: z.string().optional().describe('Filter by phase (Phase 1, Phase 2, etc.)'),
        intervention_type: z.string().optional().describe('Filter by intervention type (Drug, Device, etc.)'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, status, phase, intervention_type, limit, offset }) => {
      try {
        const results = await trialSearch(query, { status, phase, intervention_type, limit, offset });
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
    'trial_get',
    {
      description: 'Get detailed trial information by NCT ID',
      inputSchema: {
        nct_id: z.string().describe('NCT ID (e.g., "NCT01234567")'),
        sections: z.array(z.enum(TRIAL_SECTIONS)).optional().describe('Sections to include'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ nct_id, sections }) => {
      try {
        const result = await trialGet(nct_id, sections);
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
    'trial_eligibility',
    {
      description: 'Get eligibility criteria for a trial',
      inputSchema: {
        nct_id: z.string().describe('NCT ID'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ nct_id }) => {
      try {
        const result = await trialGet(nct_id, ['eligibility']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.eligibility) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'trial_locations',
    {
      description: 'Get trial location sites',
      inputSchema: {
        nct_id: z.string().describe('NCT ID'),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ nct_id, limit }) => {
      try {
        const result = await trialGet(nct_id, ['locations']);
        const locations = (result as { sections?: { locations?: Array<{ facility?: string; city?: string }> } }).sections?.locations?.slice(0, limit) || [];
        return { content: [{ type: 'text', text: JSON.stringify(locations) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'trial_outcomes',
    {
      description: 'Get trial outcomes',
      inputSchema: {
        nct_id: z.string().describe('NCT ID'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ nct_id }) => {
      try {
        const result = await trialGet(nct_id, ['outcomes']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.outcomes) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}