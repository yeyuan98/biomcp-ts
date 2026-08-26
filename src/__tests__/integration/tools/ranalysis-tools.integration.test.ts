import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAnalysisRTools, shutdownREngine } from '../../../server/tools/ranalysis.js';
import { gunzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';

jest.setTimeout(600_000);

const MIRROR_DIR = process.env.ANALYSIS_R_MIRROR_URL ?? '';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

let callTool: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;

const runCondition = MIRROR_DIR !== '' || existsSync(`${process.env.HOME}/.cache/biomcp/r-wasm-mirror-state.json`);
const maybe = runCondition ? describe : describe.skip;

beforeAll(async () => {
  process.env.ANALYSIS_R = process.env.ANALYSIS_R ?? '1';
  if (!process.env.ANALYSIS_R_MIRROR_URL && MIRROR_DIR) {
    process.env.ANALYSIS_R_MIRROR_URL = MIRROR_DIR;
  }
  const server = new McpServer({ name: 'test-biomcp', version: '1.0.0' });
  registerAnalysisRTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  callTool = async (name, args = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    return result;
  };
}, 60_000);

afterAll(async () => {
  await shutdownREngine();
});

const NGENES = 1200;
const SAMPLES = ['c1', 'c2', 'c3', 't1', 't2', 't3'];

function syntheticCounts() {
  const genes = Array.from({ length: NGENES }, (_, i) => `ENSG${String(i + 1).padStart(8, '0')}`);
  const deIdx = new Set(Array.from({ length: 120 }, (_, i) => (i * 11 + 5) % NGENES));
  const matrix: number[][] = [];
  let seed = 2026;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const lib = [1.1, 0.95, 1.05, 1.2, 0.85, 1.0];
  for (let g = 0; g < NGENES; g++) {
    const mu = Math.pow(10, 1 + rand() * 3);
    const row: number[] = [];
    for (let s = 0; s < 6; s++) {
      const fc = s >= 3 && deIdx.has(g) ? 2.5 : 1;
      const m = mu * fc * lib[s];
      row.push(Math.max(0, Math.round(m + Math.sqrt(m) * (rand() - 0.5) * 3)));
    }
    matrix.push(row);
  }
  return { genes, matrix };
}

const { genes, matrix } = syntheticCounts();

const BASE_ARGS = {
  counts: { genes, samples: SAMPLES, matrix },
  coldata: {
    samples: SAMPLES,
    columns: {
      condition: ['control', 'control', 'control', 'treated', 'treated', 'treated'],
      batch: ['b1', 'b2', 'b1', 'b2', 'b1', 'b2'],
    },
  },
  design: 'batch + condition',
  contrast: { variable: 'condition', numerator: 'treated', denominator: 'control' },
  top_n: 10,
};

maybe('analysis_r_* tools (integration, live webR)', () => {
  it('analysis_r_deseq2 runs a real DE analysis with correct directions', async () => {
    const res = await callTool('analysis_r_deseq2', { ...BASE_ARGS, alpha: 0.05 });
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('DESeq2 — differential expression');
    expect(text).toMatch(/n significant \| \d+/);
    const sig = Number(text.match(/n significant \| (\d+)/)?.[1] ?? 0);
    expect(sig).toBeGreaterThan(40);
    expect(text).toContain('condition: treated vs control');
    const firstLfc = Number(text.match(/\| ENSG\d+ \| [\d.]+ \| (-?[\d.]+) \|/)?.[1] ?? 0);
    expect(Math.abs(firstLfc)).toBeGreaterThan(0.5);
  }, 300_000);

  it('analysis_r_edger (qlm) and analysis_r_limma agree on the top gene set', async () => {
    const edger = await callTool('analysis_r_edger', { ...BASE_ARGS, test: 'qlm' });
    const limma = await callTool('analysis_r_limma', BASE_ARGS);
    expect(edger.isError).toBeUndefined();
    expect(limma.isError).toBeUndefined();
    const topGenes = (text: string) =>
      (text.match(/\| (ENSG\d+) \|/g) ?? []).map((m) => m.match(/ENSG\d+/)![0]).slice(0, 5);
    const overlap = topGenes(edger.content[0].text).filter((g) => topGenes(limma.content[0].text).includes(g));
    expect(overlap.length).toBeGreaterThanOrEqual(3);
  }, 300_000);

  it('include_full returns decodable base64(gzip(TSV))', async () => {
    const res = await callTool('analysis_r_limma', { ...BASE_ARGS, include_full: true, top_n: 5 });
    expect(res.isError).toBeUndefined();
    const b64 = res.content[0].text.match(/```\n([A-Za-z0-9+/=]+)\n```/)?.[1];
    expect(b64).toBeTruthy();
    const tsv = gunzipSync(Buffer.from(b64!, 'base64')).toString('utf8');
    const header = tsv.split('\n')[0].split('\t');
    expect(header[0]).toBe('gene');
    expect(header).toContain('padj');
    expect(tsv.split('\n').length).toBeGreaterThan(1000);
  }, 300_000);

  it('limma handles reversed contrasts (reference as numerator)', async () => {
    const res = await callTool('analysis_r_limma', {
      ...BASE_ARGS,
      contrast: { variable: 'condition', numerator: 'control', denominator: 'treated' },
      top_n: 5,
    });
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('condition: control vs treated');
    const firstLfc = Number(text.match(/\| ENSG\d+ \| [\d.]+ \| (-?[\d.]+) \|/)?.[1] ?? 0);
    expect(firstLfc).toBeLessThan(-0.5);
  }, 300_000);

  it('edgeR exact test runs with correct directions', async () => {
    const res = await callTool('analysis_r_edger', { ...BASE_ARGS, test: 'exact' });
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('| test | exact |');
    const firstLfc = Number(text.match(/\| ENSG\d+ \| [\d.]+ \| (-?[\d.]+) \|/)?.[1] ?? 0);
    expect(firstLfc).toBeGreaterThan(0.5);
  }, 300_000);

  it('format=json returns structured output', async () => {
    const res = await callTool('analysis_r_deseq2', { ...BASE_ARGS, format: 'json', top_n: 3 });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.summary.framework).toBe('DESeq2');
    expect(Array.isArray(parsed.top)).toBe(true);
    expect(parsed.top.length).toBe(3);
    expect(parsed.columns[0]).toBe('gene');
  }, 300_000);

  it('DESeq2 coef path tests the requested coefficient, not the last term', async () => {
    const coefRes = await callTool('analysis_r_deseq2', {
      ...BASE_ARGS,
      contrast: undefined,
      coef: 'conditiontreated',
      top_n: 5,
    });
    expect(coefRes.isError).toBeUndefined();
    const defaultRes = await callTool('analysis_r_deseq2', { ...BASE_ARGS, contrast: undefined, top_n: 5 });
    const sig = (t: string) => Number(t.match(/n significant \| (\d+)/)?.[1] ?? -1);
    expect(sig(coefRes.content[0].text)).toBe(sig(defaultRes.content[0].text));
    const batchRes = await callTool('analysis_r_deseq2', {
      ...BASE_ARGS,
      contrast: undefined,
      coef: 'batchb2',
      top_n: 5,
    });
    expect(batchRes.isError).toBeUndefined();
    expect(batchRes.content[0].text).toContain('coef batchb2');
    expect(sig(batchRes.content[0].text)).toBeLessThan(sig(defaultRes.content[0].text));
  }, 300_000);

  it('analysis_r_session_info reports versions', async () => {
    const res = await callTool('analysis_r_session_info', {});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('R version 4.6');
    expect(res.content[0].text).toMatch(/DESeq2 \| 1\.\d+/);
  }, 120_000);

  it('contrast errors are actionable', async () => {
    const res = await callTool('analysis_r_deseq2', {
      ...BASE_ARGS,
      contrast: { variable: 'condition', numerator: 'nope', denominator: 'control' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Contrast level "nope" not found');
  }, 120_000);

  it('coef validation rejects unknown coefficients', async () => {
    const res = await callTool('analysis_r_edger', {
      ...BASE_ARGS,
      contrast: undefined,
      coef: 'nosuchcoef',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/coef 'nosuchcoef' not found/);
  }, 120_000);
});
