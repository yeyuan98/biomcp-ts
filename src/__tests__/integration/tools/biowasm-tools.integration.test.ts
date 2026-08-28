import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerBiowasmTools } from '../../../server/tools/biowasm.js';
import { biowasmCacheStatePath } from '../../../biowasm/registry.js';
import { shutdownBiowasmEngine } from '../../../biowasm/engine.js';
import { canonicalizeSource } from '../../../biowasm/validate.js';

jest.setTimeout(600_000);

// Same skip pattern as the ranalysis / biowasm engine integration suites: run
// only when a mirror is configured or the asset cache is already populated.
const runCondition = !!process.env.ANALYSIS_BIOWASM_MIRROR_URL || existsSync(biowasmCacheStatePath());
const maybe = runCondition ? describe : describe.skip;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

let callTool: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;

beforeAll(async () => {
  process.env.ANALYSIS_BIOWASM = process.env.ANALYSIS_BIOWASM ?? '1';
  const server = new McpServer({ name: 'test-biomcp', version: '1.0.0' });
  registerBiowasmTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  callTool = async (name, args = {}) => {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  };
}, 60_000);

afterAll(async () => {
  await shutdownBiowasmEngine();
});

function toySam(): string {
  const lines = [
    '@HD\tVN:1.6\tSO:unsorted',
    '@SQ\tSN:chr1\tLN:1000',
    '@SQ\tSN:chr2\tLN:1000',
    '@PG\tID:toy\tPN:toy',
  ];
  const seq = 'ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTAC';
  const reads = [10, 500, 900, 50, 600];
  for (const [chrom] of [['chr1'], ['chr2']] as Array<[string]>) {
    for (let i = 0; i < reads.length; i++) {
      const off = (i * 7) % 20;
      const qual = 'I'.repeat(off) + 'H'.repeat(50 - off);
      lines.push(`r${i}_${chrom}\t0\t${chrom}\t${reads[i]}\t60\t50M\t*\t0\t0\t${seq}\t${qual}`);
    }
  }
  return lines.join('\n') + '\n';
}

function toyVcf(): string {
  return [
    '##fileformat=VCFv4.2',
    '##contig=<ID=chr1,length=1000>',
    '##contig=<ID=chr2,length=1000>',
    '##INFO=<ID=DP,Number=1,Type=Integer,Description="Depth">',
    '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tS1',
    'chr1\t100\t.\tA\tG\t50\tPASS\tDP=10\tGT\t0/1',
    'chr1\t400\t.\tC\tT\t40\tPASS\tDP=8\tGT\t0/0',
    'chr2\t200\t.\tG\tA\t30\tPASS\tDP=5\tGT\t1/1',
  ].join('\n') + '\n';
}

const BED_A = ['chr1\t10\t20', 'chr1\t18\t30', 'chr1\t100\t150', 'chr2\t5\t15'].join('\n') + '\n';
const BED_B = ['chr1\t15\t25', 'chr2\t10\t12'].join('\n') + '\n';

let bamArtifactId = '';

maybe('analysis_biowasm_* tools (integration, real wasm tools)', () => {
  it('analysis_biowasm_convert turns in-band SAM into a BAM artifact', async () => {
    const res = await callTool('analysis_biowasm_convert', {
      source: { content: toySam() },
      to: 'BAM',
    });
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('Converted artifact — sam → BAM');
    expect(text).toMatch(/sha256 \| [0-9a-f]{64}/);
    expect(text).toContain('io_stats');
    bamArtifactId = text.match(/\| artifact_id \| (\S+) \|/)?.[1] ?? '';
    expect(bamArtifactId).toMatch(/^bw/);
  }, 300_000);

  it('analysis_bam_summary summarizes the toy BAM artifact', async () => {
    expect(bamArtifactId).not.toBe('');
    const res = await callTool('analysis_bam_summary', { source: { artifact_id: bamArtifactId } });
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('BAM summary');
    expect(text).toContain('| chr1 | 1000 |');
    expect(text).toContain('| chr2 | 1000 |');
    expect(text).toContain('| in total | 10 + 0 |');
    expect(text).toContain('io_stats');
  }, 300_000);

  it('analysis_bcf_view_region projects and filters a toy VCF', async () => {
    const res = await callTool('analysis_bcf_view_region', {
      source: { content: toyVcf() },
      region: { chrom: 'chr1' },
      projection: { fields: ['CHROM', 'POS', 'REF', 'ALT', 'QUAL', 'DP'] },
      filter: 'QUAL>45',
      top_n: 10,
    });
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('| CHROM | POS | REF | ALT | QUAL | DP |');
    expect(text).toContain('| chr1 | 100 | A | G | 50 | 10 |');
    expect(text).not.toContain('| chr1 | 400');
    expect(text).toContain('QUAL>45');
    expect(text).toContain('io_stats');
  }, 300_000);

  it('analysis_bcf_view_region json format returns structured variants', async () => {
    const res = await callTool('analysis_bcf_view_region', {
      source: { content: toyVcf() },
      region: { chrom: 'chr2' },
      format: 'json',
    });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text) as { variants: Array<Record<string, string>>; io_stats: { bytes_read: number } };
    expect(parsed.variants).toHaveLength(1);
    expect(parsed.variants[0]).toEqual({ CHROM: 'chr2', POS: '200', REF: 'G', ALT: 'A' });
    expect(typeof parsed.io_stats.bytes_read).toBe('number');
  }, 300_000);

  it('analysis_bed_op intersects two in-bed tracks', async () => {
    const res = await callTool('analysis_bed_op', {
      source: { content: BED_A },
      b_source: { content: BED_B },
      op: 'intersect',
    });
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('bedtools intersect');
    expect(text).toContain('| chr1 | 15 | 20 |');
    expect(text).toContain('| chr2 | 10 | 12 |');
    expect(text).toContain('Showing 3 of 3 intervals');
    expect(text).toContain('io_stats');
  }, 300_000);

  it('analysis_bed_op jaccard reports summary statistics', async () => {
    const res = await callTool('analysis_bed_op', {
      source: { content: BED_A },
      b_source: { content: BED_B },
      op: 'jaccard',
    });
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('| jaccard |');
    expect(text).toContain('| intersection |');
  }, 300_000);

  it('analysis_biowasm_session_info reports pinned versions and cache state', async () => {
    const res = await callTool('analysis_biowasm_session_info', {});
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('| samtools version | 1.21 |');
    expect(text).toContain('| bedtools version | 2.31.0 |');
    expect(text).toContain('| bcftools version | 1.10 |');
    expect(text).toContain('asset cache');
    expect(text).toMatch(/artifacts retained \| \d+/);
  }, 120_000);

  it('analysis_biowasm_cli runs an allowlisted subcommand against a staged file', async () => {
    const staged = canonicalizeSource({ content: toySam() });
    const res = await callTool('analysis_biowasm_cli', {
      tool: 'samtools',
      args: ['view', '-H', staged.vfsPath],
    });
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('| exit code | 0 |');
    expect(text).toContain('@HD');
    expect(text).toContain('io_stats');
  }, 120_000);
});
