import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { articleSearch, articleGet } from '../../entities/article.js';

const ARTICLE_SECTIONS = ['core', 'oa', 'annotations', 'graph', 'all'] as const;

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
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, source, limit, offset }) => {
      try {
        const results = await articleSearch(query, { source, limit, offset });
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
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ pmid, sections }) => {
      try {
        const result = await articleGet(pmid, sections);
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
    'article_annotations',
    {
      description: 'Get PubTator annotations for an article',
      inputSchema: {
        pmid: z.string().describe('PubMed ID (PMID)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ pmid }) => {
      try {
        const result = await articleGet(pmid, ['annotations']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.annotations) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'article_citations',
    {
      description: 'Get citation graph for an article',
      inputSchema: {
        pmid: z.string().describe('PubMed ID (PMID)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ pmid }) => {
      try {
        const result = await articleGet(pmid, ['graph']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.citation_graph) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}