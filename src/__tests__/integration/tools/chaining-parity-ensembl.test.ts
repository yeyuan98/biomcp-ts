import { describe, it, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { ENSEMBL_CHAIN_TABLE } from './chains.js';
import { runChain, pinLabel, linkLabel } from './chaining-walk.js';

/**
 * Chaining-parity walker, Ensembl-dependent chains (issue #161): identical
 * enforcement to chaining-parity.test.ts — ensembl_lookup/ensembl_region
 * rows must feed gene_get/variant_get exactly as their docstrings
 * advertise — but these chains' SEARCH leg is Ensembl REST, the #182 known
 * GitHub-runner offender. Ensembl-side degradation leaked into the gating
 * tier through them once (run 39535999218: a thin region page carried no
 * rs-variation row while the same window's ensembl-tools offender-tier
 * test also failed), so ci.yml routes THIS file through the non-gating
 * known-offender tier on GitHub Actions. Local runs stay authoritative:
 * these chains still run and still fail locally on real breakage.
 */

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('chaining-parity walker — Ensembl tier (#161/#182)', () => {
  for (const spec of ENSEMBL_CHAIN_TABLE) {
    it(`${pinLabel(spec)} → ${spec.links.map(linkLabel).join(' + ')}`, async () => {
      await runChain(harness, spec);
    }, 180000);
  }
});
