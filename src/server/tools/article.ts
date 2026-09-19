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
        query: z.string().describe('Search query (title, abstract, or keyword). Journal scoping: PubMed matches full journal names and NLM abbreviations; EuropePMC JOURNAL:"..." filters require the NLM abbreviation (e.g. "N Engl J Med")'),
        source: z.enum(['pubmed', 'europepmc', 'semantic_scholar', 'pubtator', 'litsense', 'preprint_only', 'arxiv']).optional().describe('Specific source to search. "preprint_only" searches ONLY bioRxiv+medRxiv preprints (bioRxiv/medRxiv DOIs, abstracts, citation counts, via Europe PMC\'s preprint index); "arxiv" searches the arXiv preprint server (quotes, parentheses, and field prefixes like ti:/au: are stripped from the query for arXiv only). Default (unset) = federated journal-literature search across PubMed, EuropePMC, Semantic Scholar, arXiv, PubTator, LitSense; bioRxiv/medRxiv preprints are NOT included unless explicitly requested via preprint_only.'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results to return. Applied to final deduplicated results, not per-source. Each source may fetch more internally before deduplication.'),
        offset: z.number().int().min(0).default(0).describe('Result offset. EuropePMC and preprint_only windows are capped at 1000 rows; use narrower queries or another source for deeper results'),
        dateRange: z.string()
          .regex(/^(\d{4}-\d{2}-\d{2})?\/(\d{4}-\d{2}-\d{2})?$/,
            'Date range must be YYYY-MM-DD/YYYY-MM-DD (open-ended: YYYY-MM-DD/ or /YYYY-MM-DD)')
          .refine((s: string) => s.split('/').some((p: string) => p.length > 0), 'At least one date endpoint required')
          .optional()
          .describe('Date range as YYYY-MM-DD/YYYY-MM-DD. Open-ended: "2020-01-01/" or "/2023-12-31". Only pubmed, europepmc, semantic_scholar, preprint_only, and arxiv support this.'),
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
      description: 'Get article by PMID/PMCID/DOI. Preprint DOIs (bioRxiv/medRxiv, e.g. "10.1101/2025.03.05.641768" or new prefix "10.64898/...") return the preprint record: all versions, license, category, funders, JATS full-text URL, published-version mapping, and (with sections=["citation"]) Europe PMC preprint citations. Journal-article citation: fast mode (~4s, 4 providers, auto-fallback to PubMed) or full mode (~15-30s, all 5 providers incl. PubMed). Forward citation lists come from Europe PMC, Semantic Scholar, and OpenCitations; Crossref provides counts and references only.',
      inputSchema: {
        id: z.string().describe('Article identifier: PMID (numeric, e.g. "12345"), PMCID (e.g. "PMC1234567"), DOI (e.g. "10.1038/s41586-021-03819-2"), or preprint DOI (e.g. "10.1101/2021.10.25.465764", "10.64898/2026.08.11.744243")'),
        sections: z.array(z.enum(ARTICLE_SECTIONS)).optional().describe('Sections to include. Use ["citation"] for citation data, ["all"] for everything.'),
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum items per section (e.g., 20 citations)'),
        citation_mode: z.enum(['fast', 'full']).optional().default('fast').describe(
          'Fast: Europe PMC, Semantic Scholar, OpenCitations, Crossref counts/references (~4s). Full: All 5 providers incl. PubMed (~15-30s). ' +
          'Fast mode auto-falls back to PubMed when other providers return no items.'
        ),
        citation_direction: z.enum(['forward', 'backward', 'both']).optional().default('both').describe('Citation direction: "forward" (articles citing this one), "backward" (references), "both" (default)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ id, sections, limit, citation_mode, citation_direction }) => {
      try {
        // 60s (vs 30s default): the preprint branch may hit api.biorxiv.org
        // twice (biorxiv miss → medrxiv) with per-attempt timeouts + retries;
        // journal paths finish well within this budget regardless.
        const result = await withToolTimeout(articleGet(id, sections, { citationMode: citation_mode, citationDirection: citation_direction, limit }), 60000);
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
