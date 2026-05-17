import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { articleSearch, articleGet } from '../../entities/article/index.js';
import { applyLimit } from './utils.js';

const TOOL_TIMEOUT_MS = 30000;

function withToolTimeout<T>(promise: Promise<T>, timeoutMs = TOOL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

const ARTICLE_SECTIONS = ['core', 'oa', 'annotations', 'graph', 'citation', 'all'] as const;

const ARTICLE_ALL_SECTIONS = ['oa', 'annotations', 'graph', 'citation'];
const ARTICLE_STORAGE_KEYS: Record<string, string> = {
  graph: 'citation_graph',
  oa: 'open_access',
  citation: 'citation',
};
const ARTICLE_ARRAY_KEYS: Record<string, string[]> = {
  annotations: [],
  graph: ['citations', 'references'],
  citation: ['forward_citations', 'backward_references'],
};

export function registerArticleTools(server: McpServer): void {
  server.registerTool(
    'article_search',
    {
      description: 'Search literature across multiple backends with federated search and deduplication',
      inputSchema: {
        query: z.string().describe('Search query (title, abstract, or keyword)'),
        source: z.enum(['pubmed', 'europepmc', 'semantic_scholar', 'pubtator', 'litsense']).optional().describe('Specific source to search'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results to return. Applied to final deduplicated results, not per-source. Each source may fetch more internally before deduplication.'),
        offset: z.number().int().min(0).default(0).describe('Result offset'),
        dateRange: z.string()
          .regex(/^(\d{4}-\d{2}-\d{2})?\/(\d{4}-\d{2}-\d{2})?$/,
            'Date range must be YYYY-MM-DD/YYYY-MM-DD (open-ended: YYYY-MM-DD/ or /YYYY-MM-DD)')
          .refine((s: string) => s.split('/').some((p: string) => p.length > 0), 'At least one date endpoint required')
          .optional()
          .describe('Date range as YYYY-MM-DD/YYYY-MM-DD. Open-ended: "2020-01-01/" or "/2023-12-31". Only pubmed, europepmc, semantic_scholar support this.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, source, limit, offset, dateRange }) => {
      try {
        const results = await withToolTimeout(articleSearch(query, { source, limit, offset, dateRange }));
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
    'article_get',
    {
      description: 'Get article by PMID/PMCID/DOI. Citation: fast mode (~4s, auto-fallback to PubMed) or full mode (~15-30s, all 5 providers). Provider coverage depends on ID type.',
      inputSchema: {
        id: z.string().describe('Article identifier: PMID (numeric, e.g. "12345"), PMCID (e.g. "PMC1234567"), or DOI (e.g. "10.1038/s41586-021-03819-2")'),
        sections: z.array(z.enum(ARTICLE_SECTIONS)).optional().describe('Sections to include. Use ["citation"] for citation data, ["all"] for everything.'),
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum items per section (e.g., 20 citations)'),
        citation_mode: z.enum(['fast', 'full']).optional().default('fast').describe(
          'Fast: Europe PMC, Semantic Scholar, Crossref (~4s). Full: All 5 providers (~15-30s). ' +
          'Fast mode auto-falls back to PubMed when other providers return no items.'
        ),
        citation_direction: z.enum(['forward', 'backward', 'both']).optional().default('both').describe('Citation direction: "forward" (articles citing this one), "backward" (references), "both" (default)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ id, sections, limit, citation_mode, citation_direction }) => {
      try {
        const result = await withToolTimeout(articleGet(id, sections, { citationMode: citation_mode, citationDirection: citation_direction, limit }));
        const requestedSections = (sections ?? []).includes('all')
          ? ARTICLE_ALL_SECTIONS
          : (sections ?? []);
        if (result.sections) {
          applyLimit(result.sections, requestedSections, ARTICLE_STORAGE_KEYS, ARTICLE_ARRAY_KEYS, limit);
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
