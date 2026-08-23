import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { patentSearch, patentGet, PATENT_GET_SECTIONS } from '../../entities/patent/index.js';
import { applyLimit, withToolTimeout } from './utils.js';

const SEARCH_TIMEOUT_MS = 30000;
const GET_TIMEOUT_MS = 120000;

const PATENT_ALL_SECTIONS = ['abstract', 'claims', 'citations', 'family', 'classifications'];
const PATENT_STORAGE_KEYS: Record<string, string> = {};
const PATENT_ARRAY_KEYS: Record<string, string[]> = {
  claims: ['claims'],
  citations: ['backward', 'forward', 'non_patent_literature'],
  family: ['family_members'],
  classifications: ['cpc', 'ipc'],
};

export function registerPatentTools(server: McpServer): void {
  server.registerTool(
    'patent_search',
    {
      description:
        'Search patents worldwide (US, EP, WO, JP, and 100+ authorities). ' +
        'Quote exact multi-word concepts (e.g. "mRNA display") to avoid off-topic matches. ' +
        'Backend characters: ppubs = USPTO Public Search full-text conceptual search (US only, keyless, relevance-ranked; default US backend) | ' +
        'ops = EPO OPS worldwide bibliographic search over titles/abstracts (needs EPO_OPS_CONSUMER_KEY/EPO_OPS_CONSUMER_SECRET) | ' +
        'uspto_odp = US application metadata, bibliographic only but inventor/CPC/continuity-rich (needs USPTO_API_KEY) | ' +
        'google_patents = worldwide best-effort (often unavailable). ' +
        'Auto mode queries worldwide + ppubs concurrently; if ppubs fails hard it falls back to uspto_odp once (tagged with _note). ' +
        'Pass source to force a specific backend. Results are ranked by relevance by default (ppubs sort_by).',
      inputSchema: {
        query: z.string().describe('Free-text query; quote exact multi-word concepts like "mRNA display" for precise matching'),
        assignee: z.string().optional().describe('Filter by assignee/applicant organization, e.g. "Moderna"'),
        inventor: z.string().optional().describe('Filter by inventor name'),
        cpc: z.string().optional().describe('Filter by CPC classification symbol (full symbol, e.g. "C12N15/11")'),
        status: z.enum(['granted', 'application']).optional().describe('Filter by grant status'),
        date_range: z.string().optional().describe('Date range "YYYY-MM-DD/YYYY-MM-DD" (either side may be empty)'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset for pagination'),
        source: z.enum(['ops', 'uspto_odp', 'ppubs', 'google_patents']).optional().describe('Force a specific backend'),
        sort_by: z.enum(['relevance', 'recency'])
          .optional()
          .describe('Result ranking: "relevance" (default, conceptual match ranking) or "recency" (newest first). Currently affects the ppubs backend only'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, assignee, inventor, cpc, status, date_range, limit, offset, source, sort_by }) => {
      try {
        const response = await withToolTimeout(
          patentSearch(query, { assignee, inventor, cpc, status, date_range, limit, offset, source, sort_by }),
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
        sections: z.array(z.enum(PATENT_GET_SECTIONS)).optional().describe('Sections to include (default: core only)'),
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
