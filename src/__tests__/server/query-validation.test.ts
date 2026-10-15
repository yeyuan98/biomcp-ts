import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

/**
 * Schema-level rejection of empty / whitespace-only free-text queries
 * (GitHub issue #79): `patent_search({query: ""})` used to execute a real
 * search and return arbitrary patents; `article_search({query: ""})` silently
 * returned []. Every search tool with a required free-text `query` param now
 * validates `z.string().trim().min(1, ...)` so the MCP SDK rejects the call
 * with InvalidParams before the handler (and any network) runs.
 *
 * Excluded by design: `pdb` and `variant_search` queries are OPTIONAL
 * filter-style params guarded by their handlers (e.g. the pdb both-empty
 * check), not required free-text searches.
 */
const FREE_TEXT_SEARCH_TOOLS = [
  'article_search',
  'disease_search',
  'drug_search',
  'gene_search',
  'trial_search',
  'patent_search',
  'geo_search',
  'genbank_search',
  'sra_search',
  'discover',
] as const;

type ToolName = (typeof FREE_TEXT_SEARCH_TOOLS)[number];

/** One minimal well-formed query per tool for the positive schema case. */
const VALID_QUERIES: Record<ToolName, string> = {
  article_search: 'BRAF inhibitor',
  disease_search: 'melanoma',
  drug_search: 'imatinib',
  gene_search: 'BRAF',
  trial_search: 'melanoma',
  patent_search: 'mRNA display',
  geo_search: 'breast cancer RNA-seq',
  genbank_search: 'TP53[Gene Name]',
  sra_search: 'RNA-SEQ',
  discover: 'BRAF V600E',
};

describe('free-text search query validation (issue #79)', () => {
  let harness: McpTestHarness;
  mockGlobalFetch();
  let fetchSentinel: jest.Mock;

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    connectionManager.closeAll();
    // Rejecting sentinel: any handler that runs past schema validation will
    // reach the network layer and fail fast/gracefully — the tests below only
    // care about WHETHER it was called, never about the handler's outcome.
    // The message deliberately carries no network-failure signature so the
    // connection retry layer classifies it non-retryable (no backoff sleeps).
    fetchSentinel = jest.fn(() => Promise.reject(new Error('schema test sentinel: upstream disabled')));
    global.fetch = fetchSentinel as unknown as typeof global.fetch;
  });

  it.each(FREE_TEXT_SEARCH_TOOLS)('%s rejects an empty query at the schema level', async (tool) => {
    await expect(harness.callTool(tool, { query: '' })).rejects.toThrow(
      /Query must be a non-empty string after trimming/
    );
    expect(fetchSentinel).not.toHaveBeenCalled();
  });

  it.each(FREE_TEXT_SEARCH_TOOLS)('%s rejects a whitespace-only query at the schema level', async (tool) => {
    await expect(harness.callTool(tool, { query: '   ' })).rejects.toThrow(
      /Query must be a non-empty string after trimming/
    );
    expect(fetchSentinel).not.toHaveBeenCalled();
  });

  it.each(FREE_TEXT_SEARCH_TOOLS)('%s passes schema validation for a non-empty query', async (tool) => {
    // Handler outcome is irrelevant (the fetch sentinel makes every search
    // fail fast without network); reaching fetch at all proves the zod schema
    // accepted the query and the handler started executing.
    await harness.callTool(tool, { query: VALID_QUERIES[tool] }).catch(() => undefined);
    expect(fetchSentinel).toHaveBeenCalled();
  });
});
