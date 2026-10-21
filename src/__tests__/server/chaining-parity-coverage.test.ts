import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';
import {
  ADVERTISED_LINKS,
  INCIDENTAL_MENTIONS,
  CHAIN_TABLE,
  ENSEMBL_CHAIN_TABLE,
} from '../integration/tools/chains.js';

/**
 * Doc/coverage parity for search→get chains (issue #161) — the OFFLINE half.
 * Its live counterpart is src/__tests__/integration/tools/chaining-parity.test.ts;
 * both import the shared chain tables from ../integration/tools/chains.ts (core +
 * Ensembl-tier; the Ensembl-dependent chains run non-gating on GH Actions per #182).
 *
 * The rule: when a tool DESCRIPTION mentions another get-tool, that mention
 * must be classified — either as an advertised chain (ADVERTISED_LINKS, which
 * MUST be walked by the live table) or as an incidental mention
 * (INCIDENTAL_MENTIONS, with an explicit written reason). A newly advertised
 * link therefore fails this unit test until the walker table covers it,
 * which is exactly the drift protection #161 asks for: the hand-written
 * per-case tests that caught #136 (sra_get rejecting sra_search rows,
 * fixed in PR #153) are generalized into a table that must stay in sync
 * with the documentation.
 *
 * This test is pure bookkeeping over listTools() metadata — no network, so
 * it runs in the default unit tier (`npm test`).
 */

/** Tokens that name a get-tool (or gene mapper): geo_get, genbank_genes, … */
const GET_TOOL_TOKEN_RE = /\b[a-z]+_(?:get|genes)\b/g;

let harness: McpTestHarness;
let tools: Array<{ name: string; description?: string }>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
  const list = (await harness.listTools()) as { tools: Array<{ name: string; description?: string }> };
  tools = list.tools;
});

afterAll(async () => {
  await harness.close();
});

function descriptionOf(toolName: string): string {
  const tool = tools.find((t) => t.name === toolName);
  return tool?.description ?? '';
}

describe('chaining-parity doc/coverage parity (#161)', () => {
  it('every get-tool token in a tool description is accounted for', () => {
    const violations: string[] = [];
    for (const tool of tools) {
      const tokens = tool.description?.match(GET_TOOL_TOKEN_RE) ?? [];
      for (const token of new Set(tokens)) {
        const selfRef = token === tool.name;
        const advertised = ADVERTISED_LINKS[tool.name]?.includes(token) ?? false;
        const incidental = INCIDENTAL_MENTIONS[tool.name]?.some((m) => m.token === token) ?? false;
        if (!selfRef && !advertised && !incidental) {
          violations.push(
            `'${tool.name}' description mentions '${token}' — classify it: add ${tool.name}→${token} ` +
              `to ADVERTISED_LINKS in src/__tests__/integration/tools/chains.ts (plus a walker-table ` +
              `entry so the live walker covers it), or add it to INCIDENTAL_MENTIONS with a reason.`,
          );
        }
      }
    }
    expect(violations.join('\n')).toEqual('');
  });

  it('every ADVERTISED_LINKS chain has a matching walker table entry', () => {
    const violations: string[] = [];
    for (const [sourceTool, targets] of Object.entries(ADVERTISED_LINKS)) {
      const entry = [...CHAIN_TABLE, ...ENSEMBL_CHAIN_TABLE].find((c) => c.sourceTool === sourceTool);
      if (!entry) {
        violations.push(
          `ADVERTISED_LINKS has ${sourceTool}→${targets.join('/')} but no walker-table entry ` +
              `walks ${sourceTool} — add one to chains.ts (deterministic pinned query).`,
        );
        continue;
      }
      const walked = entry.links.map((l) => l.getTool);
      for (const target of targets) {
        if (!walked.includes(target)) {
          violations.push(
            `${sourceTool} advertises ${target} but its walker-table entry only walks ${walked.join('/')} — add the link.`,
          );
        }
      }
    }
    expect(violations.join('\n')).toEqual('');
  });

  it('every ADVERTISED_LINKS token actually appears in the source description (no stale entries)', () => {
    const violations: string[] = [];
    for (const [sourceTool, targets] of Object.entries(ADVERTISED_LINKS)) {
      const description = descriptionOf(sourceTool);
      for (const target of targets) {
        if (!description.includes(target)) {
          violations.push(
            `ADVERTISED_LINKS lists ${sourceTool}→${target} but '${sourceTool}'s description no ` +
              `longer mentions ${target} — prune the entry (or restore the docstring link).`,
          );
        }
      }
    }
    expect(violations.join('\n')).toEqual('');
  });

  it('every INCIDENTAL_MENTIONS token still appears in the source description (no stale entries)', () => {
    const violations: string[] = [];
    for (const [sourceTool, mentions] of Object.entries(INCIDENTAL_MENTIONS)) {
      const description = descriptionOf(sourceTool);
      for (const mention of mentions) {
        if (!mention.reason.trim()) {
          violations.push(`INCIDENTAL_MENTIONS ${sourceTool}→${mention.token} has no reason — every incidental mention needs a written justification.`);
        }
        if (!description.includes(mention.token)) {
          violations.push(
            `INCIDENTAL_MENTIONS lists ${sourceTool}→${mention.token} but '${sourceTool}'s description ` +
              `no longer mentions it — prune the entry.`,
          );
        }
      }
    }
    expect(violations.join('\n')).toEqual('');
  });

  it('ADVERTISED_LINKS and INCIDENTAL_MENTIONS are disjoint (no double classification)', () => {
    const violations: string[] = [];
    for (const [sourceTool, targets] of Object.entries(ADVERTISED_LINKS)) {
      for (const target of targets) {
        if (INCIDENTAL_MENTIONS[sourceTool]?.some((m) => m.token === target)) {
          violations.push(
            `${sourceTool}→${target} is classified BOTH advertised and incidental — pick one.`,
          );
        }
      }
    }
    expect(violations.join('\n')).toEqual('');
  });

  it('classifications and the walker table reference registered tools only (rename/remove drift)', () => {
    const registered = new Set(tools.map((t) => t.name));
    const violations: string[] = [];
    for (const tool of [...Object.keys(ADVERTISED_LINKS), ...Object.keys(INCIDENTAL_MENTIONS)]) {
      if (!registered.has(tool)) {
        violations.push(`classification references unknown tool '${tool}'`);
      }
    }
    for (const [sourceTool, targets] of Object.entries(ADVERTISED_LINKS)) {
      for (const target of targets) {
        if (!registered.has(target)) {
          violations.push(`ADVERTISED_LINKS ${sourceTool}→ unknown get-tool '${target}'`);
        }
      }
    }
    for (const entry of [...CHAIN_TABLE, ...ENSEMBL_CHAIN_TABLE]) {
      if (!registered.has(entry.sourceTool)) {
        violations.push(`walker table references unknown source tool '${entry.sourceTool}'`);
      }
      for (const link of entry.links) {
        if (!registered.has(link.getTool)) {
          violations.push(`walker table ${entry.sourceTool} references unknown get-tool '${link.getTool}'`);
        }
        if (!link.getArg.trim()) {
          violations.push(`walker table ${entry.sourceTool}→${link.getTool} has an empty getArg`);
        }
      }
    }
    expect(violations.join('\n')).toEqual('');
  });
});
