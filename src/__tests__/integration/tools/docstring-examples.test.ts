import { describe, it, expect, afterAll, jest } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { retryOnRateLimit } from '../../helpers/retry.js';
import {
  ARTICLE_ID_RE,
  GENBANK_ACCESSION_RE,
  NCT_ID_RE,
  PREPRINT_DOI_RE,
} from '../../../server/tools/utils.js';

/**
 * Docstring-examples docs-parity harness (issue #160).
 *
 * Tool `.describe()` strings advertise example identifiers ("e.g.
 * NCT01234567", "NC_000023.11, NG_017013.2, …"). When one rots — a retired
 * accession, a renamed record — the tool keeps telling callers to use an id
 * that no longer resolves. This harness enumerates the covered tools via
 * listTools(), extracts example-looking ids from their schema descriptions,
 * and live-verifies every non-placeholder one by calling the tool with it:
 * the in-process harness throws on isError, so a healthy example passes
 * silently while a rotted one fails a test NAMED after the tool + id.
 *
 * ID families reuse the shared schema regex constants exported from
 * src/server/tools/utils.ts (single source of truth); only families those
 * constants do not cover are defined locally below. Extending coverage to a
 * new tool = one COVERED_TOOLS entry (plus its family regex if utils.ts
 * does not have one yet — PATENT_ID_RE / SRA_ACCESSION_RE are already
 * waiting there for patent_get / sra_get).
 */

// ── Local family regexes — only the families the shared constants miss ──

/** Monarch Disease Ontology curie, e.g. MONDO:0007254 (breast carcinoma). */
const MONDO_DISEASE_ID_RE = /^MONDO:\d+$/;
/** Human Disease Ontology curie, e.g. DOID:0060268. */
const DOID_RE = /^DOID:\d+$/;
/** OMIM curie, plain (OMIM:114480) or phenotype-series (OMIM:PS#100070). */
const OMIM_ID_RE = /^OMIM:(?:PS)?#?\d+$/i;
/** UMLS CUI as accepted by disease_get, e.g. C0018794 (mirrors isDiseaseId). */
const UMLS_CUI_RE = /^C\d{7}$/;
/** dbSNP rsID, e.g. rs113488022. */
const RS_ID_RE = /^rs\d+$/i;
/** ClinVar variant accession, e.g. VCV0000013961. */
const CLINVAR_VCV_RE = /^VCV\d+$/i;

interface CoveredToolSpec {
  /** The param advertised ids belong to (attribution fallback — see below). */
  primaryParam: string;
  /**
   * ID families this tool's selector accepts. Families are scoped PER TOOL:
   * a RefSeq transcript token inside a variant HGVS example (NM_000546.5)
   * must not be mistaken for a standalone GenBank accession, so
   * GENBANK_ACCESSION_RE is registered for genbank_get only.
   */
  families: RegExp[];
}

const COVERED_TOOLS: Record<string, CoveredToolSpec> = {
  disease_get: {
    primaryParam: 'disease_id',
    families: [MONDO_DISEASE_ID_RE, DOID_RE, OMIM_ID_RE, UMLS_CUI_RE],
  },
  genbank_get: {
    primaryParam: 'accession',
    families: [GENBANK_ACCESSION_RE],
  },
  article_get: {
    primaryParam: 'id',
    families: [ARTICLE_ID_RE, PREPRINT_DOI_RE],
  },
  trial_get: {
    primaryParam: 'nct_id',
    families: [NCT_ID_RE],
  },
  variant_get: {
    primaryParam: 'id',
    families: [RS_ID_RE, CLINVAR_VCV_RE],
  },
};

// gene_get's advertised ids are HGNC symbols — an open set with (deliberately)
// no regex family — so they are checked against an explicit list instead.
const GENE_SYMBOLS = ['BRAF', 'TP53'];

/**
 * Placeholders that illustrate FORMAT, not resolvable records. Asserted NOT
 * to be live-called, and reconciled against extraction (offline describe
 * below) so a reworded docstring cannot leave a stale entry behind.
 */
const ILLUSTRATIVE_ALLOWLIST: Record<string, string[]> = {
  // article_get id description's PMCID shape example. "PMC1234567" is a
  // digit-sequential placeholder (0 hits on Europe PMC). The equally
  // digit-sequential PMID "12345" is NOT a placeholder — it is a real,
  // resolvable record (1976, J Pharm Pharmacol) and is live-checked below.
  article_get: ['PMC1234567'],
  // trial_get nct_id description: NCT + the keyboard-sequential 8-digit run.
  // "NCT01234567" 404s on ClinicalTrials.gov — a shape illustration, not a
  // curated study; the neighboring trial-tools suite live-checks
  // NCT03676114 for real data.
  trial_get: ['NCT01234567'],
};

/**
 * Live-call argument overrides. genbank_get's own description caps
 * whole-record fetches at 2,000,000 bp and REQUIRES a seq_start/seq_stop
 * region for larger records — chromosome-scale NC_000023.11 is advertised
 * as an accession example, and the 100 bp slice below still proves the
 * accession resolves (the neighboring genbank-tools suite asserts the
 * identical region-required error for NC_000001.11 without a slice).
 */
const LIVE_CALL_EXTRA_ARGS: Record<string, Record<string, unknown>> = {
  'genbank_get:NC_000023.11': { seq_start: 1, seq_stop: 100 },
};

/** Shape of one tool as returned by the SDK's listTools(). */
interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, { type?: string | string[]; description?: string }>;
  };
}

interface ExtractedExample {
  id: string;
  param: string;
}

/** Split description text into candidate tokens, stripping wrapping quotes/brackets/punctuation. */
function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((raw) => raw.replace(/^[^\w]+/, '').replace(/[^\w]+$/, ''))
    .filter((token) => token.length > 0);
}

function extractCoveredExamples(tools: ListedTool[]): Record<string, ExtractedExample[]> {
  const result: Record<string, ExtractedExample[]> = {};
  for (const [name, spec] of Object.entries(COVERED_TOOLS)) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`docstring-examples harness: covered tool '${name}' is not registered`);
    }
    const found = new Map<string, ExtractedExample>();

    /**
     * Param-attribution heuristic (issue #160): an extracted id is passed to
     * the tool under the param whose description contained it; ids found only
     * in the tool-level description belong to the tool's primary ID param by
     * construction; and when the same id appears in several descriptions the
     * primary ID param wins (that is the selector the docstring advertises
     * it for). Bare numeric tokens are additionally trusted ONLY on the
     * primary param's own description — everywhere else they are prose
     * counts (article_get's tool description says "All 5 providers"), not
     * advertised PMIDs.
     */
    const record = (id: string, param: string, fromPrimaryParamDescription: boolean) => {
      if (/^\d+$/.test(id) && !fromPrimaryParamDescription) return;
      const prev = found.get(id);
      if (!prev || (param === spec.primaryParam && prev.param !== spec.primaryParam)) {
        found.set(id, { id, param });
      }
    };

    for (const [param, prop] of Object.entries(tool.inputSchema?.properties ?? {})) {
      if (!prop.description) continue;
      // Only string-typed params can receive an id: numeric/array params
      // (limit, offset, sections) carry their own examples ("e.g., 20
      // citations") that would otherwise collide with id families.
      const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
      if (type && type !== 'string') continue;
      for (const token of tokenize(prop.description)) {
        if (spec.families.some((re) => re.test(token))) {
          record(token, param, param === spec.primaryParam);
        }
      }
    }
    // Tool-level description examples advertise the primary ID selector.
    for (const token of tokenize(tool.description ?? '')) {
      if (spec.families.some((re) => re.test(token))) {
        record(token, spec.primaryParam, false);
      }
    }
    result[name] = [...found.values()];
  }
  return result;
}

// Module-scope extraction (top-level await): the live `it`s below must be
// registered with tool + id in their NAMES, so the inventory has to exist at
// describe-registration time. listTools() is in-process — no network — so
// running the offline describe alone stays offline.
const harness = await createMcpTestHarness();
const listedTools = (await harness.listTools()) as { tools: ListedTool[] };
const extracted = extractCoveredExamples(listedTools.tools);

afterAll(async () => {
  await harness.close();
});

jest.setTimeout(60000);

describe('docstring-example extraction (offline reconciliation)', () => {
  it('extracts the known advertised-example inventory from every covered tool', () => {
    // Full-inventory pin — the docs-parity contract: any docstring edit that
    // adds, removes, or moves an advertised id must consciously update this
    // map, and a newly advertised id then gets live-checked below.
    const inventory: Record<string, string[]> = {};
    for (const tool of Object.keys(COVERED_TOOLS)) {
      inventory[tool] = extracted[tool].map((e) => e.id).sort();
    }
    expect(inventory).toEqual({
      article_get: [
        '10.1038/s41586-021-03819-2',
        '10.1101/2021.10.25.465764',
        '10.1101/2025.03.05.641768',
        '10.64898/2026.08.11.744243',
        '12345',
        'PMC1234567',
      ],
      disease_get: ['C0018794', 'DOID:0060268', 'MONDO:0007254', 'OMIM:114480'],
      genbank_get: ['KJ668569.1', 'NC_000023.11', 'NC_000908.2', 'NG_017013.2'],
      trial_get: ['NCT01234567'],
      variant_get: ['VCV0000013961', 'rs113488022', 'rs28934575'],
    });
  });

  it('attributes every extracted example to its tool primary ID param', () => {
    for (const [tool, spec] of Object.entries(COVERED_TOOLS)) {
      for (const example of extracted[tool]) {
        expect(example.param).toBe(spec.primaryParam);
      }
    }
  });

  it('reconciles the illustrative allowlist against extraction (no stale entries)', () => {
    for (const [tool, ids] of Object.entries(ILLUSTRATIVE_ALLOWLIST)) {
      for (const id of ids) {
        // A reworded docstring that drops a placeholder must delete its
        // allowlist entry too — otherwise the allowlist rots silently.
        expect({ tool, id, seenInExtraction: extracted[tool].some((e) => e.id === id) }).toEqual({
          tool,
          id,
          seenInExtraction: true,
        });
      }
    }
  });

  it('finds every gene_get example symbol in the symbol param description', () => {
    const geneGet = listedTools.tools.find((t) => t.name === 'gene_get');
    expect(geneGet).toBeDefined();
    const desc = geneGet?.inputSchema?.properties?.symbol?.description ?? '';
    for (const symbol of GENE_SYMBOLS) {
      expect(desc).toContain(symbol);
    }
  });
});

describe('docstring-example live verification', () => {
  for (const [tool, spec] of Object.entries(COVERED_TOOLS)) {
    const allowlisted = new Set(ILLUSTRATIVE_ALLOWLIST[tool] ?? []);
    const liveExamples = extracted[tool].filter((e) => !allowlisted.has(e.id));

    describe(tool, () => {
      for (const { id, param } of liveExamples) {
        // Name carries tool + id so a CI failure is immediately actionable.
        // callTool throws on isError, so simply resolving = the advertised
        // example still works against the live source.
        it(`${tool} accepts advertised docstring example ${id} (${param})`, async () => {
          const extraArgs = LIVE_CALL_EXTRA_ARGS[`${tool}:${id}`] ?? {};
          const result = await retryOnRateLimit(() =>
            harness.callTool(tool, { [param]: id, ...extraArgs }),
          );
          expect(result).toBeDefined();
        }, 60000);
      }

      if (liveExamples.length === 0) {
        it(`${tool}: every advertised example is an illustrative placeholder`, () => {
          // trial_get today: its only advertised id is the NCT01234567 shape
          // example. If the docstring grows a real curated id, this guard
          // flips and the loop above starts live-checking it.
          expect(extracted[tool].length).toBeGreaterThan(0);
          expect(liveExamples.length).toBe(0);
        });
      }
    });
  }

  describe('gene_get', () => {
    for (const symbol of GENE_SYMBOLS) {
      it(`gene_get accepts advertised docstring example ${symbol} (symbol)`, async () => {
        const result = await retryOnRateLimit(() =>
          harness.callTool('gene_get', { symbol }),
        );
        expect(result).toBeDefined();
      }, 60000);
    }
  });
});
