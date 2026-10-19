import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchArticles, articleGet, fetchPreprintFullText, PREPRINT_FULLTEXT_TOOL_BUDGET_MS } from '../../entities/article/index.js';
import { applyLimit, articleIdParam, preprintDoiParam, withToolTimeout } from './utils.js';

const TOOL_TIMEOUT_MS = 30000;

const ARTICLE_SECTIONS = ['core', 'oa', 'fulltext', 'annotations', 'graph', 'citation', 'all'] as const;

const ARTICLE_ALL_SECTIONS = ['oa', 'annotations', 'graph', 'citation'];
const ARTICLE_STORAGE_KEYS: Record<string, string> = {
  graph: 'citation_graph',
  oa: 'open_access',
  citation: 'citation',
  fulltext: 'fulltext',
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
      description: 'Search literature across multiple backends with federated search and deduplication. Response is an envelope: { results, warnings?, errors? } — per-source failures ride in `errors` (never as items inside `results`), degradation notes (e.g. PubMed dropping unrecognized query terms, LitSense relevance-floor drops) in `warnings`. LitSense rows carry the matched sentence plus PubMed-enriched title/metadata when available.',
      inputSchema: {
        query: z.string().trim().min(1, 'Query must be a non-empty string after trimming').describe('Search query (title, abstract, or keyword). Journal scoping (pubmed/europepmc): a trailing full journal name recognized from the bundled NLM title list is automatically rewritten to the NLM abbreviation (e.g. "... New England Journal of Medicine" → "N Engl J Med[Journal]" / JOURNAL:"N Engl J Med") and disclosed in response warnings; otherwise supply the NLM abbreviation (e.g. "N Engl J Med") or PubMed "Abbr[Journal]" field syntax — full journal names NOT recognized by the NLM list are not matched by PubMed/EuropePMC journal scoping.'),
        source: z.enum(['pubmed', 'europepmc', 'semantic_scholar', 'pubtator', 'litsense', 'preprint_only', 'arxiv']).optional().describe('Specific source to search. "preprint_only" searches ONLY bioRxiv+medRxiv preprints (bioRxiv/medRxiv DOIs, abstracts, citation counts, via Europe PMC\'s preprint index); "arxiv" searches the arXiv preprint server (quotes, parentheses, and field prefixes like ti:/au: are stripped from the query for arXiv only). Default (unset) = federated journal-literature search across PubMed, EuropePMC, Semantic Scholar, arXiv, PubTator, LitSense; bioRxiv/medRxiv preprints are NOT included unless explicitly requested via preprint_only.'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results to return. Applied to final deduplicated results, not per-source. Each source may fetch more internally before deduplication.'),
        offset: z.number().int().min(0).default(0).describe('Result offset. EuropePMC and preprint_only windows are capped at 1000 rows; arXiv clamps the start offset so start + page size stays within its ~30000-result deep-paging ceiling (the API errors past it); use narrower queries or another source for deeper results'),
        dateRange: z.string()
          .regex(/^(\d{4}-\d{2}-\d{2})?\/(\d{4}-\d{2}-\d{2})?$/,
            'Date range must be YYYY-MM-DD/YYYY-MM-DD (open-ended: YYYY-MM-DD/ or /YYYY-MM-DD)')
          .refine((s: string) => s.split('/').some((p: string) => p.length > 0), 'At least one date endpoint required')
          .optional()
          .describe('Date range as YYYY-MM-DD/YYYY-MM-DD. Open-ended: "2020-01-01/" or "/2023-12-31". Only pubmed, europepmc, semantic_scholar, preprint_only, and arxiv support this. On pubmed, the upstream filter matches epub dates (pdat), so results are additionally post-filtered on the displayed publication date.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, source, limit, offset, dateRange }) => {
      try {
        const response = await withToolTimeout(
          searchArticles(query, { source, limit, offset, dateRange }),
          TOOL_TIMEOUT_MS,
        );
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
    'article_get',
    {
      description: 'Get article by PMID/PMCID/DOI. Section response keys differ from request names: "oa" is stored as sections.open_access, "graph" as sections.citation_graph. Preprint DOIs (bioRxiv/medRxiv, e.g. "10.1101/2025.03.05.641768" or new prefix "10.64898/...") return the preprint record: all versions, license, category, funders, JATS full-text URL, published-version mapping, and (with sections=["citation"]) Europe PMC preprint citations. Journal articles, sections=["fulltext"]: returns the ACTUAL full text when freely readable in PMC/Europe PMC (open-access AND free-to-read). fulltext.status is "available" or "unavailable"; when unavailable, fulltext.reason is one of paywalled | no_pmcid | no_machine_readable_xml | not_implemented_for_preprints | fetch_failed (with alternatives in links, e.g. doi_url); a transiently failed OA-status lookup counts as no status info, so a paywalled in-PMC article surfaces as fetch_failed until a retry reclassifies it as paywalled. The five-value open-access vocabulary — open_access | free_to_read | paywalled | not_in_pmc | unknown — is sections.open_access.status (request sections:["oa"]); fulltext.oa_status echoes it so paywalled vs not-in-PMC is visible without the oa section. Default (fulltext_output="file"): the complete text is written to a server-side markdown file and the reply carries file_path plus an outline with per-section line numbers and char counts — Read/Grep the file selectively instead of loading it into context. fulltext_output="inline" (use only if you cannot read server-side files): fulltext.sections is an ordered array of {heading, text, truncated} objects plus char_count/total_char_count/truncated/omitted_sections, capped by fulltext_max_chars. sections=["oa"] returns license/access metadata and links ONLY (pdf_url presence does not by itself mean the text is fetchable — use fulltext for content). "all" = oa+annotations+graph+citation WITHOUT fulltext (request ["fulltext"] separately). oa/fulltext do not apply to preprints (see the jatsxml_url link). Journal-article citation: fast mode (~4s, 4 providers, auto-fallback to PubMed) or full mode (~15-30s, all 5 providers incl. PubMed). Forward citation lists come from Europe PMC, Semantic Scholar, and OpenCitations; Crossref provides counts and references only.',
      inputSchema: {
        id: articleIdParam().describe('Article identifier: PMID (numeric, e.g. "12345"), PMCID (e.g. "PMC1234567"), DOI (e.g. "10.1038/s41586-021-03819-2"), or preprint DOI (e.g. "10.1101/2021.10.25.465764", "10.64898/2026.08.11.744243")'),
        sections: z.array(z.enum(ARTICLE_SECTIONS)).optional().describe('Sections to include. ["fulltext"] = the complete article text (written to a file by default; see fulltext_output). ["oa"] = license/access metadata and links. ["citation"] = citation data. ["all"] = oa+annotations+graph+citation — fulltext is NOT included; request ["fulltext"] separately.'),
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum items per section (e.g., 20 citations)'),
        fulltext_max_chars: z.number().int().min(1000).max(200000).optional().describe('Inline-mode only (fulltext_output="inline"); default 40000. Ignored in file mode — files carry the complete text (2MB safety cap). Truncation is flagged honestly with omitted section names.'),
        fulltext_output: z.enum(['file', 'inline']).optional().describe('Output mode for sections=["fulltext"]. "file" (default): complete text written to a server-side markdown file; the reply carries file_path + outline (headings with line numbers and char counts) — Read/Grep the file selectively. "inline": text returned inline, capped by fulltext_max_chars; use only if you cannot read server-side files.'),
        citation_mode: z.enum(['fast', 'full']).optional().default('fast').describe(
          'Fast: Europe PMC, Semantic Scholar, OpenCitations, Crossref counts/references (~4s). Full: All 5 providers incl. PubMed (~15-30s). ' +
          'Fast mode auto-falls back to PubMed when other providers return no items.'
        ),
        citation_direction: z.enum(['forward', 'backward', 'both']).optional().default('both').describe('Citation direction: "forward" (articles citing this one), "backward" (references), "both" (default); honored for preprint PPR citations too — the skipped direction returns an empty array'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ id, sections, limit, fulltext_max_chars, fulltext_output, citation_mode, citation_direction }) => {
      try {
        // 60s (vs 30s default): the preprint branch may hit api.biorxiv.org
        // twice (biorxiv miss → medrxiv) with per-attempt timeouts + retries;
        // journal paths finish well within this budget regardless.
        const result = await withToolTimeout(articleGet(id, sections, { citationMode: citation_mode, citationDirection: citation_direction, limit, fulltextMaxChars: fulltext_max_chars, fulltextOutput: fulltext_output }), 60000);
        const requestedSections = (sections ?? []).includes('all')
          ? ARTICLE_ALL_SECTIONS
          : (sections ?? []);
        if (result.sections) {
          result.sections = applyLimit(result.sections, requestedSections, ARTICLE_STORAGE_KEYS, ARTICLE_ARRAY_KEYS, limit);
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

  // Separate from article_get on purpose (issue #44): the JATS download is
  // paced (>=3s spacing) and may wait out a cooldown, which cannot fit
  // article_get's 60s cap — and full text for preprints must stay strictly
  // on-demand, never automatic during search/get.
  server.registerTool(
    'preprint_fulltext',
    {
      description: 'On-demand bioRxiv/medRxiv preprint full text (JATS XML, parsed to sections). Input: a preprint DOI (e.g. "10.1101/2025.03.05.641768"), optional version (default: latest). Downloads are strictly on-demand (never run during search), paced, and cached per (doi, version) — JATS per version is immutable, so repeat calls are served from cache without re-downloading. www.biorxiv.org rate-limits aggressively: on a 429/Cloudflare verdict this tool pauses downloads for >=60s (Retry-After honored) and every call during the cooldown returns an honest unavailable/rate_limited envelope with retry_after_sec — cached copies are still served instantly. The per-article license (cc by, cc by-nc-nd, na, ...) rides on every reply and governs reuse; for corpus-scale text mining use the bioRxiv/medRxiv monthly S3 buckets (see https://www.biorxiv.org/tdm). Output "file" (default): complete text written to a server-side markdown file, reply carries file_path + outline (Read/Grep selectively); "inline": capped text sections (fulltext_max_chars, default 40000).',
      inputSchema: {
        id: preprintDoiParam().describe('bioRxiv/medRxiv preprint DOI (e.g. "10.1101/2021.10.25.465764", "10.64898/2026.08.11.744243"); journal-article identifiers are rejected — use article_get for those'),
        version: z.number().int().min(1).optional().describe('Preprint version to fetch (default: latest). Pinned versions are served from cache with zero network when already fetched.'),
        output: z.enum(['file', 'inline']).optional().describe('"file" (default): complete text in a server-side markdown file; the reply carries file_path + outline. "inline": text sections returned inline, capped by fulltext_max_chars.'),
        fulltext_max_chars: z.number().int().min(1000).max(200000).optional().describe('Inline-mode only (output="inline"); default 40000. Ignored in file mode — files carry the complete text (2MB safety cap).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ id, version, output, fulltext_max_chars }) => {
      try {
        const result = await withToolTimeout(
          fetchPreprintFullText(id, { version, output, maxChars: fulltext_max_chars }),
          PREPRINT_FULLTEXT_TOOL_BUDGET_MS
        );
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
