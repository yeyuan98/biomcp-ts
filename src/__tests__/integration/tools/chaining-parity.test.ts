import { describe, it, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { CHAIN_TABLE } from './chains.js';
import { runChain, pinLabel, linkLabel } from './chaining-walk.js';

/**
 * Chaining-parity walker (issue #161): every row a search tool returns must
 * be consumable by the get-tool its docstring advertises — the invariant
 * that caught #136 (sra_search handing out accessions sra_get rejected).
 *
 * The chain table lives in ./chains.ts (shared with the offline doc/coverage
 * parity test, which fails when a docstring advertises a link the tables do
 * not cover). Walk mechanics live in ./chaining-walk.ts, shared with the
 * Ensembl-dependent chains in ./chaining-parity-ensembl.test.ts (their
 * search leg is Ensembl REST, a #182 known GitHub-runner offender, so they
 * run in the non-gating CI tier there; this file stays fully gating).
 */

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('chaining-parity walker (#161)', () => {
  for (const spec of CHAIN_TABLE) {
    it(`${pinLabel(spec)} → ${spec.links.map(linkLabel).join(' + ')}`, async () => {
      await runChain(harness, spec);
    }, 180000);
  }
});
