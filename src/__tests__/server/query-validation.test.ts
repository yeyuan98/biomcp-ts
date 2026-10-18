import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

/**
 * Schema-level rejection of empty / whitespace-only inputs (issues #79 and
 * #128): `patent_search({query: ""})` used to execute a real search and
 * return arbitrary patents; `article_search({query: ""})` silently returned
 * []; `variant_search({query: ""})` returned arbitrary unfiltered variants;
 * required selector params (ids, symbols, accessions, …) passed "" straight
 * to the handler, producing not-found messages or empty successes instead of
 * schema errors. Every free-text search `query` now validates
 * `z.string().trim().min(1, ...)` inline and every required selector param
 * uses the shared `requiredString(label)` helper (optional filter-style
 * params use `optionalNonEmptyString`), so the MCP SDK rejects the call with
 * InvalidParams before the handler (and any network) runs.
 *
 * Still excluded by design: `pdb` queries (OPTIONAL filter-style params with
 * a handler-level both-empty check) and other optional falsy-guarded filters
 * (e.g. variant_search `consequence`, gtex_expression `tissue`) where an
 * empty string already no-ops harmlessly rather than broadening the query.
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

/**
 * Required selector params swept to `requiredString(label)` (issue #128):
 * tool, the param under test, and the minimal VALID argument set for the
 * tool (the positive case proves the schema still admits well-formed calls
 * and the handler starts executing).
 */
const SELECTOR_PARAM_CASES = [
  { tool: 'article_get', param: 'id', validArgs: { id: '31672941' } },
  { tool: 'preprint_fulltext', param: 'id', validArgs: { id: '10.1101/2021.10.25.465764' } },
  { tool: 'disease_get', param: 'disease_id', validArgs: { disease_id: 'MONDO:0007254' } },
  { tool: 'disease_drugs', param: 'disease_id', validArgs: { disease_id: 'MONDO:0007254' } },
  { tool: 'disease_trials', param: 'disease_id', validArgs: { disease_id: 'MONDO:0007254' } },
  { tool: 'drug_get', param: 'name', validArgs: { name: 'imatinib' } },
  { tool: 'drug_trials', param: 'drug', validArgs: { drug: 'imatinib' } },
  { tool: 'ensembl_lookup', param: 'gene_or_id', validArgs: { gene_or_id: 'BRAF' } },
  { tool: 'ensembl_homology', param: 'gene', validArgs: { gene: 'BRAF' } },
  { tool: 'ensembl_consequence', param: 'variant', validArgs: { variant: 'NM_004333:c.1799T>A' } },
  { tool: 'ensembl_region', param: 'region', validArgs: { region: '7:140450000-140480000' } },
  { tool: 'gene_get', param: 'symbol', validArgs: { symbol: 'BRAF' } },
  { tool: 'gene_diseases', param: 'symbol', validArgs: { symbol: 'BRAF' } },
  { tool: 'gene_drugs', param: 'symbol', validArgs: { symbol: 'BRAF' } },
  { tool: 'gene_trials', param: 'symbol', validArgs: { symbol: 'BRAF' } },
  { tool: 'gene_articles', param: 'symbol', validArgs: { symbol: 'BRAF' } },
  { tool: 'gtex_expression', param: 'gene', validArgs: { gene: 'TP53' } },
  { tool: 'gtex_eqtl', param: 'gene', validArgs: { gene: 'TP53', tissue: 'Whole_Blood' } },
  { tool: 'gtex_eqtl', param: 'tissue', validArgs: { gene: 'TP53', tissue: 'Whole_Blood' } },
  { tool: 'patent_get', param: 'patent_id', validArgs: { patent_id: 'US11027025B2' } },
  { tool: 'sra_get', param: 'accession', validArgs: { accession: 'SRR14432476' } },
  { tool: 'trial_get', param: 'nct_id', validArgs: { nct_id: 'NCT01234567' } },
  { tool: 'variant_get', param: 'id', validArgs: { id: 'rs113488022' } },
  { tool: 'variant_oncokb', param: 'gene', validArgs: { gene: 'BRAF', protein_change: 'V600E' } },
  { tool: 'variant_oncokb', param: 'protein_change', validArgs: { gene: 'BRAF', protein_change: 'V600E' } },
  { tool: 'variant_trials', param: 'variant', validArgs: { variant: 'rs113488022' } },
  { tool: 'genbank_get', param: 'accession', validArgs: { accession: 'NG_017013.2' } },
  { tool: 'genbank_genes', param: 'accession', validArgs: { accession: 'NG_017013.2' } },
] as const;

/**
 * variant_search's OPTIONAL filter params, swept to `optionalNonEmptyString`
 * (issue #128): an explicitly supplied empty/whitespace value must reject,
 * while OMITTING the filter entirely must still pass the schema — the
 * handler composes a query from whichever filters are present.
 */
const VARIANT_SEARCH_OPTIONAL_FILTERS = ['query', 'gene', 'rsid', 'hgvsp', 'hgvsc'] as const;

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

describe('required selector param validation (issue #128)', () => {
  let harness: McpTestHarness;
  mockGlobalFetch();
  let fetchSentinel: jest.Mock;
  // variant_oncokb's handler throws pre-fetch without a token; the positive
  // schema case needs the handler to run through to the network sentinel.
  const originalOncokbToken = process.env.ONCOKB_TOKEN;

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    connectionManager.closeAll();
    process.env.ONCOKB_TOKEN = 'test-token';
    fetchSentinel = jest.fn(() => Promise.reject(new Error('schema test sentinel: upstream disabled')));
    global.fetch = fetchSentinel as unknown as typeof global.fetch;
  });

  afterEach(() => {
    if (originalOncokbToken) process.env.ONCOKB_TOKEN = originalOncokbToken;
    else delete process.env.ONCOKB_TOKEN;
  });

  it.each(SELECTOR_PARAM_CASES)('$tool rejects an empty $param at the schema level', async ({ tool, param, validArgs }) => {
    await expect(harness.callTool(tool, { ...validArgs, [param]: '' })).rejects.toThrow(
      /must be a non-empty string after trimming/
    );
    expect(fetchSentinel).not.toHaveBeenCalled();
  });

  it.each(SELECTOR_PARAM_CASES)('$tool rejects a whitespace-only $param at the schema level', async ({ tool, param, validArgs }) => {
    await expect(harness.callTool(tool, { ...validArgs, [param]: '   ' })).rejects.toThrow(
      /must be a non-empty string after trimming/
    );
    expect(fetchSentinel).not.toHaveBeenCalled();
  });

  it.each(SELECTOR_PARAM_CASES)('$tool passes schema validation for a non-empty $param', async ({ tool, validArgs }) => {
    // Reaching fetch at all proves the schema accepted the selector and the
    // handler started executing (its outcome is irrelevant under the sentinel).
    await harness.callTool(tool, validArgs).catch(() => undefined);
    expect(fetchSentinel).toHaveBeenCalled();
  });
});

describe('variant_search optional filter validation (issue #128)', () => {
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
    fetchSentinel = jest.fn(() => Promise.reject(new Error('schema test sentinel: upstream disabled')));
    global.fetch = fetchSentinel as unknown as typeof global.fetch;
  });

  it.each(VARIANT_SEARCH_OPTIONAL_FILTERS)('variant_search rejects an explicitly empty %s filter', async (param) => {
    await expect(harness.callTool('variant_search', { [param]: '' })).rejects.toThrow(
      /must be a non-empty string after trimming/
    );
    expect(fetchSentinel).not.toHaveBeenCalled();
  });

  it.each(VARIANT_SEARCH_OPTIONAL_FILTERS)('variant_search rejects a whitespace-only %s filter', async (param) => {
    await expect(harness.callTool('variant_search', { [param]: '   ' })).rejects.toThrow(
      /must be a non-empty string after trimming/
    );
    expect(fetchSentinel).not.toHaveBeenCalled();
  });

  it('variant_search omittable filters still pass the schema when absent', async () => {
    // No filters at all: the call must pass SCHEMA validation (the handler
    // starts and reaches the network sentinel). This pins the regression the
    // empty-`q` fix must not introduce — absence stays a legal call shape.
    await harness.callTool('variant_search', { limit: 1 }).catch(() => undefined);
    expect(fetchSentinel).toHaveBeenCalled();
  });
});
