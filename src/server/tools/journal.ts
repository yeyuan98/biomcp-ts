import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { lookupJournalMetrics } from '../../entities/journal/index.js';
import { listEnvelope, requiredString, withToolTimeout, type CancellationCapableExtra } from './utils.js';

// 30s: one OpenAlex roundtrip under the registry's 15s connection timeout
// with retry headroom (registry budget 35s caps the worst case above this).
const TOOL_TIMEOUT_MS = 30000;

export function registerJournalTools(server: McpServer): void {
  server.registerTool(
    'journal_metrics',
    {
      description: 'Journal quality metrics — an open-access alternative to the Clarivate impact factor (IF). Returns the OpenAlex 2-year mean citedness score (an IF-style metric), h-index, i10-index, citation counts, open-access flag (is_oa), and quality-list tiers (e.g. medline, norway-2, jufo-3…). Accepts a journal name, NLM abbreviation (e.g. \'N Engl J Med\'), or ISSN (e.g. \'0028-0836\'; article records carry journal_issn).',
      inputSchema: {
        query: requiredString('Query').describe('Journal name, NLM abbreviation (e.g. "N Engl J Med"), or ISSN (e.g. "0028-0836")'),
        limit: z.number().int().min(1).max(25).default(5).describe('Max results for name searches (exact lookups return one)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }, extra: CancellationCapableExtra) => {
      try {
        const { results, warnings, errors } = await withToolTimeout(
          (signal) => lookupJournalMetrics(query, { limit, signal }),
          TOOL_TIMEOUT_MS,
          { signal: extra?.signal },
        );
        // List-tool envelope (#130): { results, warnings?, errors? }.
        return { content: [{ type: 'text', text: JSON.stringify(listEnvelope(results, warnings, errors)) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: String(error) }],
          isError: true,
        };
      }
    },
  );
}
