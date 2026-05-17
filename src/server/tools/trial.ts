import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { trialSearch, trialGet } from '../../entities/trial.js';
import { applyLimit } from './utils.js';

const TRIAL_SECTIONS = ['core', 'eligibility', 'locations', 'outcomes', 'all'] as const;

const TRIAL_ALL_SECTIONS = ['eligibility', 'locations', 'outcomes'];
const TRIAL_STORAGE_KEYS: Record<string, string> = {};
const TRIAL_ARRAY_KEYS: Record<string, string[]> = {
  locations: [],
  outcomes: ['primary', 'secondary'],
};

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
        page_token: z.string().optional().describe('Page token from previous response for pagination'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, status, phase, intervention_type, limit, page_token }) => {
      try {
        const response = await trialSearch(query, { status, phase, intervention_type, limit, pageToken: page_token });
        return { content: [{ type: 'text', text: JSON.stringify(response) }] };
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
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ nct_id, sections, limit }) => {
      try {
        const result = await trialGet(nct_id, sections);
        const requestedSections = (sections ?? []).includes('all')
          ? TRIAL_ALL_SECTIONS
          : (sections ?? []);
        if (result.sections) {
          applyLimit(result.sections, requestedSections, TRIAL_STORAGE_KEYS, TRIAL_ARRAY_KEYS, limit);
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
}
