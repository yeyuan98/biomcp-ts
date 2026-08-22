import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { patentSearch, patentGet } from '../../entities/patent/index.js';
import { applyLimit } from './utils.js';

const SEARCH_TIMEOUT_MS = 30000;
const GET_TIMEOUT_MS = 120000;

function withToolTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

const PATENT_SECTIONS = ['core', 'abstract', 'claims', 'citations', 'family', 'classifications', 'all'] as const;

const PATENT_ALL_SECTIONS = ['abstract', 'claims', 'citations', 'family', 'classifications'];
const PATENT_STORAGE_KEYS: Record<string, string> = {};
const PATENT_ARRAY_KEYS: Record<string, string[]> = {
  claims: ['claims'],
  citations: ['backward', 'forward', 'non_patent_literature'],
  family: [],
  classifications: ['cpc', 'ipc'],
};

export function registerPatentTools(server: McpServer): void {
  server.registerTool(
    'patent_search',
    {
      description:
        'Search patents worldwide (US, EP, WO, JP, and 100+ authorities). ' +
        'Backends are auto-selected: EPO OPS (worldwide, needs EPO_OPS_CONSUMER_KEY/EPO_OPS_CONSUMER_SECRET) + ' +
        'USPTO ODP (US, needs USPTO_API_KEY) or keyless fallbacks (USPTO Public Search, Google Patents best-effort). ' +
        'Pass source to force a specific backend: "ops", "uspto_odp", "ppubs", "google_patents".',
      inputSchema: {
        query: z.string().describe('Free-text query, e.g. "crispr cas9"'),
        assignee: z.string().optional().describe('Filter by assignee/applicant organization, e.g. "Moderna"'),
        inventor: z.string().optional().describe('Filter by inventor name'),
        cpc: z.string().optional().describe('Filter by CPC classification symbol (full symbol, e.g. "C12N15/11")'),
        status: z.enum(['granted', 'application']).optional().describe('Filter by grant status'),
        date_range: z.string().optional().describe('Date range "YYYY-MM-DD/YYYY-MM-DD" (either side may be empty)'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset for pagination'),
        source: z.enum(['ops', 'uspto_odp', 'ppubs', 'google_patents']).optional().describe('Force a specific backend'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, assignee, inventor, cpc, status, date_range, limit, offset, source }) => {
      try {
        const response = await withToolTimeout(
          patentSearch(query, { assignee, inventor, cpc, status, date_range, limit, offset, source }),
          SEARCH_TIMEOUT_MS,
        );
        return { content: [{ type: 'text', text: JSON.stringify(response) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: String(error) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'patent_get',
    {
      description:
        'Get patent details by publication number (e.g. "US11027025B2", "EP3904939B1", "US20260240819A1"). ' +
        'Sections: abstract, claims (US fulltext via USPTO Public Search; EP/WO via EPO OPS), ' +
        'citations (backward + forward), family, classifications.',
      inputSchema: {
        patent_id: z.string().describe('Publication number, e.g. "US11027025B2"'),
        sections: z.array(z.enum(PATENT_SECTIONS)).optional().describe('Sections to include (default: core only)'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max entries per section array'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ patent_id, sections, limit }) => {
      try {
        const result = await withToolTimeout(patentGet(patent_id, sections), GET_TIMEOUT_MS);
        const requestedSections = (sections ?? []).includes('all')
          ? PATENT_ALL_SECTIONS
          : (sections ?? []);
        if (result.sections) {
          applyLimit(result.sections, requestedSections, PATENT_STORAGE_KEYS, PATENT_ARRAY_KEYS, limit);
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: String(error) }],
          isError: true,
        };
      }
    },
  );
}
