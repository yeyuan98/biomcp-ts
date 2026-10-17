import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { trialSearch, trialGet } from '../../entities/trial.js';
import { applyLimit, withToolTimeout, type CancellationCapableExtra } from './utils.js';

// Deadline rationale (#107 phase 2): the core ClinicalTrials.gov fetch is
// bounded by its connection budget (15s per attempt x2 attempts + backoff),
// and the section wave carries its own 8s section deadlines running in
// parallel. 45s covers the retry ceiling with headroom while still bounding
// work that ignores the abort (no more zombie fetches past the deadline).
const TRIAL_GET_TIMEOUT_MS = 45000;

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
        query: z.string().trim().min(1, 'Query must be a non-empty string after trimming').describe('Condition, intervention, or keyword to search for'),
        status: z.string().optional().describe('Filter by status (Recruiting, Completed, etc.)'),
        phase: z.string().optional().describe('Filter by phase (Phase 1, Phase 2, etc.). The matched phase(s) are echoed per row in the "phase" array (e.g. ["PHASE1","PHASE2"]) so the filter is verifiable from each result'),
        intervention_type: z.string().optional().describe('Filter by intervention type (Drug, Device, etc.); verifiable per row via the "interventions" strings ("TYPE: name")'),
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
    async ({ nct_id, sections, limit }, extra: CancellationCapableExtra) => {
      try {
        const result = await withToolTimeout(
          (signal) => trialGet(nct_id, sections, signal),
          TRIAL_GET_TIMEOUT_MS,
          { signal: extra?.signal },
        );
        const requestedSections = (sections ?? []).includes('all')
          ? TRIAL_ALL_SECTIONS
          : (sections ?? []);
        if (result.sections) {
          result.sections = applyLimit(result.sections, requestedSections, TRIAL_STORAGE_KEYS, TRIAL_ARRAY_KEYS, limit);
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
