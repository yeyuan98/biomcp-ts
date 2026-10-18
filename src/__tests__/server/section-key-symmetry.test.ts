import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGeneTools } from '../../server/tools/gene.js';
import { registerVariantTools } from '../../server/tools/variant.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';
import { parseMockUrl } from '../helpers/mock-url.js';
import { connectionManager } from '../../connections/manager.js';

/**
 * #129: gene_get/variant_get section response keys must mirror the
 * requested (schema-advertised) section names. The entity layer stores
 * aliased sections under legacy storage keys (civic/hpa/clingen/disgenet/
 * alphagenome); the tool boundary translates back so callers can key on
 * what they asked for. Real tool callbacks + global.fetch mocks only (no
 * jest.mock of source modules) — the same harness as
 * tool-cancellation.test.ts.
 */
type ToolCallback = (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureTools(register: (server: McpServer) => void): Map<string, ToolCallback> {
  const tools = new Map<string, ToolCallback>();
  const server = {
    registerTool: (name: string, _config: unknown, cb: ToolCallback) => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  register(server);
  return tools;
}

/** MyGene.info lookup hit for the gene_get symbol resolution call. */
const MYGENE_LOOKUP_HIT = {
  symbol: 'TP53',
  name: 'Tumor protein p53',
  summary: 'Tumor suppressor.',
};

/**
 * fetch dispatcher keyed on EXACT hostname via parseMockUrl — never on URL
 * substrings (CodeQL js/incomplete-url-substring-sanitization). Route order
 * matters: first match wins, so specific routes (e.g. the mygene GO query)
 * must precede the generic mygene lookup. The default branch answers a
 * plain JSON `{}` with ok/json/text/arrayBuffer so any section fetcher
 * (REST, GraphQL, raw proteinatlas fetch) settles without throwing — the
 * tests below assert response KEYS, not upstream data.
 */
function fetchDispatch(
  routes: Array<{ match: (url: URL) => boolean; body: unknown }>,
): typeof global.fetch {
  return jest.fn<(...args: any[]) => any>().mockImplementation((input: any, init?: any) => {
    const url = parseMockUrl(input ?? init?.url);
    const body = {
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('{}'),
      arrayBuffer: () => Promise.resolve(Buffer.from('{}')),
      headers: new Headers({ 'content-type': 'application/json' }),
    };
    for (const route of routes) {
      if (route.match(url)) {
        const payload =
          typeof route.body === 'function' ? (route.body as () => unknown)() : route.body;
        return Promise.resolve({
          ...body,
          json: () => Promise.resolve(payload),
          text: () => Promise.resolve(JSON.stringify(payload)),
          arrayBuffer: () => Promise.resolve(Buffer.from(JSON.stringify(payload))),
        });
      }
    }
    return Promise.resolve(body);
  }) as any;
}

describe('gene_get/variant_get section response keys mirror requested names (#129)', () => {
  mockGlobalFetch();

  let hadDisgenetKey: string | undefined;
  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
    // DisGeNET must look unconfigured so the disease_associations section
    // settles into its honest _error stub instead of hitting the network.
    hadDisgenetKey = process.env.DISGENET_API_KEY;
    delete process.env.DISGENET_API_KEY;
  });

  afterEach(() => {
    if (hadDisgenetKey !== undefined) process.env.DISGENET_API_KEY = hadDisgenetKey;
    else delete process.env.DISGENET_API_KEY;
  });

  describe('gene_get aliased sections', () => {
    it('clinical_evidence returns sections.clinical_evidence, not civic', async () => {
      global.fetch = fetchDispatch([
        { match: (u) => u.hostname === 'mygene.info', body: { hits: [MYGENE_LOOKUP_HIT] } },
        {
          match: (u) => u.hostname === 'civicdb.org',
          body: {
            data: {
              gene: {
                id: 45,
                name: 'TP53',
                variants: { nodes: [{ id: 12, name: 'V600E' }] },
              },
            },
          },
        },
      ]);
      const tools = captureTools(registerGeneTools);
      const result = await tools.get('gene_get')!({
        symbol: 'TP53',
        sections: ['clinical_evidence'],
        limit: 20,
        smart: false,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(Object.keys(parsed.sections)).toEqual(['clinical_evidence']);
      expect(parsed.sections.clinical_evidence.variants).toEqual([{ name: 'V600E' }]);
      expect(parsed.sections.civic).toBeUndefined();
    });

    it('protein_atlas returns sections.protein_atlas, not hpa', async () => {
      const hpaRow = [{ Gene: 'TP53', 'Subcellular location': ['Nucleus'] }];
      global.fetch = fetchDispatch([
        { match: (u) => u.hostname === 'mygene.info', body: { hits: [MYGENE_LOOKUP_HIT] } },
        { match: (u) => u.hostname === 'www.proteinatlas.org', body: hpaRow },
      ]);
      const tools = captureTools(registerGeneTools);
      const result = await tools.get('gene_get')!({
        symbol: 'TP53',
        sections: ['protein_atlas'],
        limit: 20,
        smart: false,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(Object.keys(parsed.sections)).toEqual(['protein_atlas']);
      expect(parsed.sections.protein_atlas.subcellular).toEqual([
        { location: 'Nucleus', confidence: 'approved' },
      ]);
      expect(parsed.sections.hpa).toBeUndefined();
    });

    it('dosage_sensitivity returns sections.dosage_sensitivity (error stub remapped too), not clingen', async () => {
      // ClinGen has no public API: the entity returns an offline _error
      // stub — it must still land under the requested name.
      global.fetch = fetchDispatch([
        { match: (u) => u.hostname === 'mygene.info', body: { hits: [MYGENE_LOOKUP_HIT] } },
      ]);
      const tools = captureTools(registerGeneTools);
      const result = await tools.get('gene_get')!({
        symbol: 'TP53',
        sections: ['dosage_sensitivity'],
        limit: 20,
        smart: false,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(Object.keys(parsed.sections)).toEqual(['dosage_sensitivity']);
      expect(parsed.sections.dosage_sensitivity).toMatchObject({
        _error: expect.stringContaining('ClinGen'),
      });
      expect(parsed.sections.clingen).toBeUndefined();
    });

    it('disease_associations returns sections.disease_associations, not disgenet', async () => {
      global.fetch = fetchDispatch([
        { match: (u) => u.hostname === 'mygene.info', body: { hits: [MYGENE_LOOKUP_HIT] } },
      ]);
      const tools = captureTools(registerGeneTools);
      const result = await tools.get('gene_get')!({
        symbol: 'TP53',
        sections: ['disease_associations'],
        limit: 20,
        smart: false,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(Object.keys(parsed.sections)).toEqual(['disease_associations']);
      expect(parsed.sections.disease_associations).toMatchObject({
        _error: expect.stringContaining('DISGENET_API_KEY'),
      });
      expect(parsed.sections.disgenet).toBeUndefined();
    });

    it('sections:["all"] returns every advertised public name and no storage keys', async () => {
      // Default `{}` responses let every section fetcher settle (data or
      // _error stub) — the assertion is about which KEYS come back.
      global.fetch = fetchDispatch([
        { match: (u) => u.hostname === 'mygene.info', body: { hits: [MYGENE_LOOKUP_HIT] } },
      ]);
      const tools = captureTools(registerGeneTools);
      const result = await tools.get('gene_get')!({
        symbol: 'TP53',
        sections: ['all'],
        limit: 20,
        smart: false,
      });
      const parsed = JSON.parse(result.content[0].text);
      const keys = Object.keys(parsed.sections);
      for (const publicName of [
        'pathways', 'protein', 'ontology', 'go', 'interactions',
        'clinical_evidence', 'expression', 'protein_atlas',
        'druggability', 'dosage_sensitivity', 'constraint',
        'disease_associations', 'diseases', 'funding',
      ]) {
        expect(keys).toContain(publicName);
      }
      for (const storageKey of ['civic', 'hpa', 'clingen', 'disgenet']) {
        expect(keys).not.toContain(storageKey);
      }
    });

    it('identity section without an alias stays under its own name (go)', async () => {
      global.fetch = fetchDispatch([
        {
          // MyGene hosts BOTH the symbol lookup and the GO query; the GO
          // query is the one asking fields=go.
          match: (u) => u.hostname === 'mygene.info' && u.searchParams.get('fields') === 'go',
          body: { hits: [{ go: { BP: [{ id: 'GO:0006915', term: 'apoptotic process' }] } }] },
        },
        { match: (u) => u.hostname === 'mygene.info', body: { hits: [MYGENE_LOOKUP_HIT] } },
      ]);
      const tools = captureTools(registerGeneTools);
      const result = await tools.get('gene_get')!({
        symbol: 'TP53',
        sections: ['go'],
        limit: 20,
        smart: false,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(Object.keys(parsed.sections)).toEqual(['go']);
      expect(parsed.sections.go).toEqual([
        { id: 'GO:0006915', term: 'apoptotic process', aspect: 'BP' },
      ]);
    });
  });

  describe('variant_get aliased sections', () => {
    const MYVARIANT_DOC = { _id: 'vcf123', dbsnp: { rsid: 'rs123' } };

    it('alphagenome_scores returns sections.alphagenome_scores, not alphagenome', async () => {
      global.fetch = fetchDispatch([
        { match: (u) => u.hostname === 'myvariant.info', body: MYVARIANT_DOC },
      ]);
      const tools = captureTools(registerVariantTools);
      const result = await tools.get('variant_get')!({
        id: 'rs123',
        sections: ['alphagenome_scores'],
        limit: 20,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(Object.keys(parsed.sections)).toEqual(['alphagenome_scores']);
      expect(parsed.sections.alphagenome_scores).toMatchObject({
        _error: expect.stringContaining('temporarily unavailable'),
      });
      expect(parsed.sections.alphagenome).toBeUndefined();
    });

    it('sections:["all"] returns advertised public names and no storage keys', async () => {
      global.fetch = fetchDispatch([
        { match: (u) => u.hostname === 'myvariant.info', body: MYVARIANT_DOC },
      ]);
      const tools = captureTools(registerVariantTools);
      const result = await tools.get('variant_get')!({
        id: 'rs123',
        sections: ['all'],
        limit: 20,
      });
      const parsed = JSON.parse(result.content[0].text);
      const keys = Object.keys(parsed.sections);
      for (const publicName of ['core', 'frequency', 'predictions', 'clinical', 'alphagenome_scores']) {
        expect(keys).toContain(publicName);
      }
      expect(keys).not.toContain('alphagenome');
    });
  });
});
