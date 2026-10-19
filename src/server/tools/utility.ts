import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { discover, batchGet } from '../../entities/cross-entity.js';
import { GENE_ALL_SECTIONS, GENE_STORAGE_KEYS } from './gene.js';
import { VARIANT_ALL_SECTIONS, VARIANT_STORAGE_KEYS } from './variant.js';
import { remapSectionKeysToRequested } from './utils.js';

/**
 * Per-entity section remap inputs for batch_get (issue #158): the 'all'
 * expansion list and the request-name→storage-key map, shared with the
 * gene_get/variant_get handlers so a batch item and its dedicated tool
 * return the same section keys for the same request.
 */
const BATCH_SECTION_REMAP: Record<string, { all: string[]; storageKeys: Record<string, string> }> = {
  gene: { all: GENE_ALL_SECTIONS, storageKeys: GENE_STORAGE_KEYS },
  variant: { all: VARIANT_ALL_SECTIONS, storageKeys: VARIANT_STORAGE_KEYS },
};

export function registerUtilityTools(server: McpServer): void {
  server.registerTool(
    'discover',
    {
      description: 'Free-text concept resolution - find entities matching a free-text query. Prefers a candidate whose name/symbol exactly matches the query (case-insensitive) over the backend\'s first hit; each result\'s matched_on field reports why it was picked ("exact" or "first")',
      inputSchema: {
        query: z.string().trim().min(1, 'Query must be a non-empty string after trimming').describe('Free-text query (e.g., "BRAF V600E", "lung cancer", "imatinib")'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query }) => {
      try {
        const results = await discover(query);
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'batch_get',
    {
      description: 'Get multiple entities in parallel. Article items return metadata (with inline abstract) by default; for full text pass sections:["fulltext"] on the item — PMC articles then return a small file handle (file_path + outline, never body text inline) while non-PMC articles return an explicit unavailable + reason. Nonexistent PMIDs yield a per-item error and the batch continues. For inline text use article_get with fulltext_output="inline"',
      inputSchema: {
        inputs: z.array(z.object({
          entity: z.enum(['gene', 'variant', 'drug', 'disease', 'trial', 'article', 'patent']),
          id: z.string(),
          sections: z.array(z.string()).optional(),
        })).describe('List of entity requests'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ inputs }) => {
      try {
        const results = await batchGet(inputs);
        // #158: gene/variant items must return sections under the names the
        // caller REQUESTED, mirroring gene_get/variant_get. batchGet
        // dispatches to the entities directly, whose sections ride out under
        // legacy storage keys (civic/hpa/clingen/disgenet/alphagenome);
        // apply the same tool-boundary remap here, expanding a literal
        // 'all' via the shared all-sections constant first. Results are
        // index-aligned with inputs (Promise.allSettled); items that failed
        // carry no data and are skipped. Other entities' items are
        // untouched.
        for (let i = 0; i < results.length && i < inputs.length; i++) {
          const remap = BATCH_SECTION_REMAP[inputs[i].entity];
          const requested = inputs[i].sections;
          if (!remap || !requested || requested.length === 0) continue;
          const data = results[i].data;
          if (!data || typeof data !== 'object') continue;
          const sections = (data as { sections?: Record<string, unknown> }).sections;
          if (!sections) continue;
          const names = requested.includes('all') ? remap.all : requested;
          remapSectionKeysToRequested(sections, names, remap.storageKeys);
        }
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}
