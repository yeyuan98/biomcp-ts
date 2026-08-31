import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  cwdRefusal,
  getStatus,
  resetParameters,
  setParameters,
  type SetResult,
  type ValidationIssue,
} from '../../config/handler.js';
import { FEATURE_GROUPS, PROTO_KEYS } from '../../config/parameters.js';

/**
 * `biomcp_configure` — the unified configuration surface. A thin skin over
 * the config handler (src/config/handler.ts): file-backed parameters can be
 * queried, created, modified, and reset (they persist to `.biomcp.json` in
 * the server's working directory and load at server startup); environment
 * parameters are strictly query-only with masked values (presence + effect +
 * fingerprint). The tool never mutates environment variables.
 */

const DESCRIPTION = `Inspect and configure biomcp — unified observability and restricted controllability for every parameter.

**What it covers:** three optional feature groups (database, analysis_r, analysis_biowasm) whose knobs live in the .biomcp.json project config file (written by this tool, loaded at server startup — a restart applies changes), plus every environment-only parameter (API keys, proxy, security boundaries), which is query-only.

**Actions:**
- status (default; call with {}): per-feature running state (with each feature's settable_keys), config file health, conflicts (e.g. an env var vetoing the file), pending-restart flags, dependency prerequisites, and parameter counts. The full parameter catalog is NOT inlined — use filter for detailed rows: 'file', 'env', a feature id ('analysis_r'), or a dotted-id prefix ('features.database').
- set: create/modify file parameters in one atomic batch. Enable/disable is just features.<group>.enabled. null removes a key (restores default). Sensitive keys (connection targets, mirrors) require confirm_sensitive=true. Nothing is written when any key is invalid (dry_run=true validates and diffs without writing).
- reset: remove a feature section (target: feature id) or specific keys (target: [dotted ids]).

**Hard rules:** environment parameters are never settable here (the response tells you how to set them in your client's env block); env var values are never displayed (masked: presence + fingerprint only); the file write is refused when the server's working directory is not a project root — the response then carries a paste-ready env block instead.

**Examples:** {"action":"status"} · {"action":"status","filter":"features.analysis_r"} · {"action":"set","values":{"features.analysis_biowasm.enabled":true}} · {"action":"set","values":{"features.database.enabled":true,"features.database.type":"sqlite","features.database.sqlite_path":["data/geo.db"]}} · {"action":"set","values":{"features.analysis_r.mirror_url":null}} · {"action":"reset","target":"analysis_r"}

Changes apply at server startup: finish dependency prerequisites first (see prerequisites in the response), then restart the client/session once, then re-call this tool with {} to verify running_now.`;

export function registerConfigureTool(server: McpServer): void {
  server.registerTool(
    'biomcp_configure',
    {
      description: DESCRIPTION,
      inputSchema: {
        action: z.enum(['status', 'set', 'reset']).default('status').describe('status = inspect (default, works with no other arguments); set = create/modify file parameters; reset = remove.'),
        values: z
          .record(
            z.string().max(256).refine((key) => key.split('.').every((seg) => !PROTO_KEYS.has(seg)), 'reserved key segment'),
            z.unknown()
          )
          .refine((map) => Object.keys(map).length <= 32, 'at most 32 keys per call')
          .optional()
          .describe('For set: {"<dotted file-param id>": <value|null>} — e.g. {"features.analysis_r.enabled": true}. null removes the key. Valid ids are listed by status.'),
        target: z
          .union([z.string().max(256), z.array(z.string().max(256)).max(32)])
          .optional()
          .describe('For reset: a feature id ("database" | "analysis_r" | "analysis_biowasm") removes the whole section, or a list of dotted file-param ids removes those keys.'),
        filter: z.string().max(256).optional().describe('For status: "file" | "env" | feature id | dotted-id prefix — returns detailed rows (effects, how-to-set).'),
        dry_run: z.boolean().optional().describe('Validate and diff without writing (set/reset).'),
        confirm_sensitive: z.boolean().optional().describe('Required true when set/reset touches sensitive keys (connection targets, mirrors, credentials).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (raw) => {
      const action = raw.action ?? 'status';
      try {
        if (action === 'status') {
          const result = getStatus({ filter: raw.filter });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        if (action === 'set') {
          const values = raw.values ?? {};
          if (Object.keys(values).length === 0) {
            return validationError('set requires values ({"<dotted id>": value}). Call status first to list valid ids.');
          }
          if (!raw.dry_run) {
            const refusal = cwdRefusal(values);
            if (refusal) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      { error: { code: 'cwd_refused', message: refusal.reason, hints: refusal.hints }, env_block: refusal.env_block },
                      null,
                      2
                    ),
                  },
                ],
                isError: true,
              };
            }
          }
          const result = await setParameters(values, { dryRun: raw.dry_run, confirmSensitive: raw.confirm_sensitive });
          return formatMutation(result, raw.dry_run === true);
        }
        // reset
        const target: { feature?: string; keys?: string[] } = {};
        if (typeof raw.target === 'string') {
          if (FEATURE_GROUPS.some((g) => g.id === raw.target)) target.feature = raw.target;
          else target.keys = [raw.target];
        } else if (Array.isArray(raw.target)) {
          target.keys = raw.target;
        }
        if (target.feature === undefined && target.keys === undefined) {
          return validationError('reset requires target: a feature id or a list of dotted file-param ids.');
        }
        if (!raw.dry_run) {
          const refusal = cwdRefusal({});
          if (refusal) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: { code: 'cwd_refused', message: refusal.reason, hints: refusal.hints } }, null, 2),
                },
              ],
              isError: true,
            };
          }
        }
        const result = await resetParameters(target, { dryRun: raw.dry_run, confirmSensitive: raw.confirm_sensitive });
        return formatMutation(result, raw.dry_run === true);
      } catch (error) {
        return { content: [{ type: 'text', text: String(error instanceof Error ? error.message : error) }], isError: true };
      }
    }
  );
}

function validationError(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code: 'invalid_request', message, hints: [] } }, null, 2) }],
    isError: true,
  };
}

function formatMutation(result: SetResult, dryRun: boolean): { content: { type: 'text'; text: string }[]; isError?: true } {
  if (!result.validation.ok) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: {
                code: 'validation_failed',
                message: result.validation.errors[0]?.message ?? 'validation failed',
                hints: result.validation.errors.map(formatIssue),
              },
              config_path: result.config_path,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  const touchedFeatures = Object.keys(result.pending_restart);
  const missingDeps = result.prerequisites.filter((p) => p['status'] === 'missing');
  const agentSteps: string[] = [];
  const userSteps: string[] = [];

  if (missingDeps.length > 0) {
    for (const dep of missingDeps) {
      agentSteps.push(`Install the missing optional dependency "${dep['dependency']}" BEFORE restart (if you have shell access): ${(dep['commands'] as string[]).filter((c) => !c.startsWith('#')).join(' ; ')}`);
      if (dep['caveat']) userSteps.push(String(dep['caveat']));
    }
  }
  userSteps.push('Restart the MCP client / start a new session so the server reloads tools — configuration is read at server startup, never live.');
  for (const feature of touchedFeatures) {
    const group = FEATURE_GROUPS.find((g) => g.id === feature);
    if (!group) continue;
    agentSteps.push(`After restart, call biomcp_configure with {} and confirm features.${feature}.running_now === true.`);
    agentSteps.push(`Smoke-test the feature with the cheap read-only tool ${group.smokeTestTool}.`);
  }
  if (result.wrote && result.secrets_written.length > 0) {
    agentSteps.push(`A secret was written to ${result.config_path} (${result.secrets_written.join(', ')}); the file is mode 0600 and git-excluded locally — prefer the env var if the project is shared.`);
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ...result,
            dry_run: dryRun,
            wrote: result.wrote && !dryRun,
            agent_steps: agentSteps,
            user_steps: userSteps,
          },
          null,
          2
        ),
      },
    ],
  };
}

function formatIssue(issue: ValidationIssue): string {
  const parts = [`${issue.key || '(request)'} [${issue.code}]: ${issue.message}`];
  if (issue.suggestion) parts.push(`did you mean "${issue.suggestion}"?`);
  if (issue.valid_keys && issue.valid_keys.length > 0) parts.push(`valid keys: ${issue.valid_keys.join(', ')}`);
  if (issue.how_to_set) parts.push(issue.how_to_set);
  return parts.join(' — ');
}
