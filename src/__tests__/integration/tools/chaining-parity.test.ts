import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { retryOnRateLimit } from '../../helpers/retry.js';
import { CHAIN_TABLE, type ChainSpec, type ChainLink } from './chains.js';

/**
 * Chaining-parity walker (issue #161): every row a search tool returns must
 * be consumable by the get-tool its docstring advertises — the invariant
 * that caught #136 (sra_search handing out accessions sra_get rejected).
 *
 * The chain table lives in ./chains.ts (shared with the offline doc/coverage
 * parity test, which fails when a docstring advertises a link this table
 * does not cover). Each entry runs a deterministic pinned query, takes the
 * first row (or the rowMatch-pinned row), and feeds the row's link field
 * into the advertised get tool. Fields documented as legitimately absent
 * (#124) carry optionalIfMissing and pass with a limitation marker instead
 * of failing.
 */

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

/** Pull the result rows out of a tool reply (bare array, keyed envelope, or single record). */
function extractRows(response: unknown, rows: ChainSpec['rows']): Record<string, unknown>[] {
  if (rows === 'array') return Array.isArray(response) ? (response as Record<string, unknown>[]) : [];
  if (rows === 'self') return [response as Record<string, unknown>];
  const envelope = response as Record<string, unknown> | null;
  const list = envelope?.[rows];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/** The row a link reads: the first row, or the rowMatch-pinned row. */
function selectRow(rows: Record<string, unknown>[], link: ChainLink): Record<string, unknown> | undefined {
  const match = link.rowMatch;
  if (!match) return rows[0];
  return rows.find((row) => {
    const value = row?.[match.field];
    if (match.equals !== undefined) return value === match.equals;
    return new RegExp(match.pattern ?? '^$').test(String(value ?? ''));
  });
}

/** The value fed to the get tool: the field itself, or its first element for
 *  array fields (geo pubmed_ids, geo_get detail sra). */
function extractLinkValue(row: Record<string, unknown>, link: ChainLink): unknown {
  const value = row?.[link.field];
  return Array.isArray(value) ? value[0] : value;
}

/** Short pin label for test names, e.g. geo_search{GSE183947}. */
function pinLabel(spec: ChainSpec): string {
  const pin = Object.values(spec.args).find((v) => typeof v === 'string');
  return `${spec.sourceTool}{${typeof pin === 'string' ? pin : ''}}`;
}

function linkLabel(link: ChainLink): string {
  const optional = link.optionalIfMissing ? ` [optional: ${link.optionalIfMissing}]` : '';
  return `${link.getTool}(${link.field}→${link.getArg})${optional}`;
}

describe('chaining-parity walker (#161)', () => {
  for (const spec of CHAIN_TABLE) {
    it(`${pinLabel(spec)} → ${spec.links.map(linkLabel).join(' + ')}`, async () => {
      const response = await retryOnRateLimit(() => harness.callTool(spec.sourceTool, spec.args));
      const rows = extractRows(response, spec.rows);
      if (rows.length === 0) {
        throw new Error(`${spec.sourceTool} returned no rows to walk (expected ${spec.rows})`);
      }

      for (const link of spec.links) {
        const row = selectRow(rows, link);
        if (row === undefined) {
          throw new Error(
            `no row satisfies rowMatch ${JSON.stringify(link.rowMatch ?? null)} for link ` +
              `${spec.sourceTool}.${link.field} → ${link.getTool}`,
          );
        }

        const value = extractLinkValue(row, link);
        if (value === undefined || value === null || value === '') {
          // Documented-limitation path (#124 precedent): pass, but loudly —
          // and only when a marker is actually documented.
          if (!link.optionalIfMissing) {
            throw new Error(
              `${spec.sourceTool} row is missing ${link.field} and no optionalIfMissing marker ` +
                `is documented in chains.ts — either the field or the marker is wrong`,
            );
          }
          console.warn(
            `[chaining-parity] LIMITATION ${spec.sourceTool} row lacks ${link.field} — ${link.getTool} hop skipped (${link.optionalIfMissing})`,
          );
          continue;
        }

        const id = String(value);
        const result = await retryOnRateLimit(() =>
          harness.callTool(link.getTool, { [link.getArg]: id }),
        );
        expect(result).toBeTruthy();
        console.log(`[chaining-parity] ${spec.sourceTool} .${link.field}=${id} → ${link.getTool}(${link.getArg}=${id}) OK`);
      }
    }, 180000);
  }
});
