import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { articleSearch, articleGet } from '../../entities/article.js';

const ARTICLE_SECTIONS = ['core', 'oa', 'annotations', 'graph', 'all'] as const;

function applyLimit(
  sections: Record<string, unknown>,
  requestedNames: string[],
  storageKeyMap: Record<string, string>,
  arrayKeyMap: Record<string, string[]>,
  limit: number,
): void {
  for (const name of requestedNames) {
    const storedKey = storageKeyMap[name] ?? name;
    const data = sections[storedKey];
    if (!data || typeof data !== 'object') continue;

    const keys = arrayKeyMap[name];
    if (Array.isArray(data)) {
      sections[storedKey] = data.slice(0, limit);
    } else if (keys) {
      const obj = data as Record<string, unknown>;
      for (const k of keys) {
        if (Array.isArray(obj[k])) obj[k] = obj[k].slice(0, limit);
      }
    }
  }
}

const ARTICLE_ALL_SECTIONS = ['oa', 'annotations', 'graph'];
const ARTICLE_STORAGE_KEYS: Record<string, string> = {
  graph: 'citation_graph',
  oa: 'open_access',
};
const ARTICLE_ARRAY_KEYS: Record<string, string[]> = {
  annotations: [],
  graph: ['citations', 'references'],
};

export function registerArticleTools(server: McpServer): void {
  server.registerTool(
    'article_search',
    {
      description: 'Search literature across multiple backends with federated search and deduplication',
      inputSchema: {
        query: z.string().describe('Search query (title, abstract, or keyword)'),
        source: z.enum(['pubmed', 'europepmc', 'semantic_scholar', 'pubtator', 'litsense']).optional().describe('Specific source to search'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
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
        const results = await articleSearch(query, { source, limit, offset, dateRange });
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
      description: 'Get detailed article information by PMID',
      inputSchema: {
        pmid: z.string().describe('PubMed ID (PMID)'),
        sections: z.array(z.enum(ARTICLE_SECTIONS)).optional().describe('Sections to include'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ pmid, sections, limit }) => {
      try {
        const result = await articleGet(pmid, sections);
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
