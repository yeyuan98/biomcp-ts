import { expect } from '@jest/globals';
import { retryOnRateLimit } from '../../helpers/retry.js';
import type { ChainSpec, ChainLink } from './chains.js';

/**
 * Shared walker mechanics for the chaining-parity suites (issue #161):
 * row extraction, rowMatch selection, link-value handling, and the
 * per-chain walk. Split out when the Ensembl-dependent chains moved to
 * their own non-gating file (chaining-parity-ensembl.test.ts) so both
 * suites run identical logic.
 */

export type McpHarness = Awaited<ReturnType<typeof import('../../helpers/mcp-harness.js').createMcpTestHarness>>;

/** Pull the result rows out of a tool reply (bare array, keyed envelope, or single record). */
export function extractRows(response: unknown, rows: ChainSpec['rows']): Record<string, unknown>[] {
  if (rows === 'array') return Array.isArray(response) ? (response as Record<string, unknown>[]) : [];
  if (rows === 'self') return [response as Record<string, unknown>];
  const envelope = response as Record<string, unknown> | null;
  const list = envelope?.[rows];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/** The row a link reads: the first row, or the rowMatch-pinned row. */
export function selectRow(rows: Record<string, unknown>[], link: ChainLink): Record<string, unknown> | undefined {
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
export function extractLinkValue(row: Record<string, unknown>, link: ChainLink): unknown {
  const value = row?.[link.field];
  return Array.isArray(value) ? value[0] : value;
}

/** Short pin label for test names, e.g. geo_search{GSE183947}. */
export function pinLabel(spec: ChainSpec): string {
  const pin = Object.values(spec.args).find((v) => typeof v === 'string');
  return `${spec.sourceTool}{${typeof pin === 'string' ? pin : ''}}`;
}

export function linkLabel(link: ChainLink): string {
  const optional = link.optionalIfMissing ? ` [optional: ${link.optionalIfMissing}]` : '';
  return `${link.getTool}(${link.field}→${link.getArg})${optional}`;
}

/** Walk one chain spec: pinned search, row selection per link, get-tool hop. */
export async function runChain(harness: McpHarness, spec: ChainSpec): Promise<void> {
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
}
