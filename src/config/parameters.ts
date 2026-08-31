import { z } from 'zod';
import { VERSION } from '../version.js';

/**
 * Single source of truth for every biomcp configuration parameter.
 *
 * Two row kinds:
 * - `file` rows: settable via the `.biomcp.json` project config file (and the
 *   `biomcp_configure` tool). Each maps to one environment variable the
 *   runtime reads; the startup loader fills unset env vars from the file.
 * - `env` rows: environment-only parameters. Strictly query-only — the
 *   `biomcp_configure` tool reports presence/effect but never values.
 *
 * Drift guards:
 * - `src/__tests__/config/handler.test.ts` asserts registry coverage against
 *   docs/ENV-VARS.md and the constraint mirrors in src/db/core/env.ts.
 * - File-backed params may only target env vars read at/after the startup
 *   fill (no lazily-snapshotted auth vars) — permanent invariant.
 */

export const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export type FeatureGroupId = 'database' | 'analysis_r' | 'analysis_biowasm';
export type ParamClassification = 'secret' | 'sensitive' | null;

export interface FileParamRow {
  kind: 'file';
  /** Dotted id, always `features.<group>.<key>`. */
  id: string;
  group: FeatureGroupId;
  /** Leaf key inside the feature section. */
  key: string;
  /** Primary env var written by the loader (fill-if-unset). */
  envVar: string;
  /** Alternate env vars the runtime honors; file never fills when any is set. */
  envVarAliases?: readonly string[];
  schema: z.ZodTypeAny;
  /** Documented default (display only). */
  defaultValue?: string | number | boolean;
  classification: ParamClassification;
  effect: string;
  /** Resolve plain relative values against the config file's directory. */
  isPath?: boolean;
  /** Convert a file value to the env string; default `String(value)`. */
  toEnv?: (value: unknown) => string;
  /** Convert an env string back to the typed value (status display + validation). */
  fromEnv?: (raw: string) => unknown;
}

export interface EnvParamRow {
  kind: 'env';
  /** The environment variable name itself. */
  id: string;
  group: 'api-keys' | 'proxy' | 'biowasm' | 'cache' | 'meta';
  classification: ParamClassification;
  effect: string;
  howToSet: string;
}

export type ParamRow = FileParamRow | EnvParamRow;

const boolish = z.boolean();
const positiveIntMs = z.number().int().positive();
const memLimitMb = z.number().int().min(64).max(65536);

function pathsToEnv(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(',');
  return String(value);
}

/** Trigger-var semantics: analysis features enable with a constant, database with the sibling type value. */
export type TriggerStyle = { kind: 'constant'; value: string } | { kind: 'siblingValue'; sibling: string };

export interface FeatureGroup {
  id: FeatureGroupId;
  label: string;
  /** Env var whose presence (per the gate function's truthiness) enables the feature. */
  triggerVar: string;
  triggerStyle: TriggerStyle;
  tools: readonly string[];
  /** Cheap read-only smoke-test tool called after a restart to verify activation. */
  smokeTestTool: string;
  peerDeps: readonly { package: string; commands: readonly string[]; note: string }[];
  rows: readonly FileParamRow[];
  /** Object-level schema for one feature section of the file (strict: unknown keys reject the whole file). */
  sectionSchema: z.ZodTypeAny;
}

const num = (raw: string): unknown => Number(raw);
const csvPaths = (raw: string): unknown => raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);

const databaseSection = z
  .strictObject({
    enabled: z.boolean().optional(),
    type: z.enum(['mysql', 'sqlite']).optional(),
    sqlite_path: z.union([z.string(), z.array(z.string())]).optional(),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    database: z.string().optional(),
    connection_timeout_ms: positiveIntMs.optional(),
  })
  .superRefine((sec, ctx) => {
    if (sec.enabled !== true) return;
    if (!sec.type) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'features.database.type ("mysql" or "sqlite") is required when enabled.' });
      return;
    }
    if (sec.type === 'sqlite') {
      const paths = Array.isArray(sec.sqlite_path) ? sec.sqlite_path : sec.sqlite_path ? [sec.sqlite_path] : [];
      if (paths.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sqlite_path'],
          message: 'features.database.sqlite_path is required when enabled with type="sqlite" (file or comma list; first entry = main database).',
        });
      }
      if (paths.length > 11) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sqlite_path'],
          message: `Too many SQLite databases: ${paths.length} listed, maximum is 11 (1 main + 10 attached).`,
        });
      }
    } else {
      for (const key of ['user', 'database'] as const) {
        if (!sec[key] || !String(sec[key]).trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `features.database.${key} is required when enabled with type="mysql".`,
          });
        }
      }
    }
  });

const analysisRSection = z.strictObject({
  enabled: z.boolean().optional(),
  timeout_ms: positiveIntMs.optional(),
  mem_limit_mb: memLimitMb.optional(),
  mirror_url: z.string().optional(),
  github_repo: z.string().optional(),
});

const biowasmSection = z.strictObject({
  enabled: z.boolean().optional(),
  timeout_ms: positiveIntMs.optional(),
  max_run_ms: positiveIntMs.optional(),
  mem_limit_mb: memLimitMb.optional(),
  workers: z.number().int().min(1).max(64).optional(),
  mirror_url: z.string().optional(),
});

const LOCAL_TREE_NOTE =
  'MCP clients control the server working directory (OpenCode = its launch directory, Claude Desktop = "/"), so "run npx biomcp from the tree" never reaches the server; peer deps resolve only from the bundle\'s own node_modules tree (https://github.com/yeyuan98/biomcp-ts AGENT-INSTALL.md §1).';

/**
 * Version pins for the recommended one-shot npx client command, rendered from
 * version.ts (NOT hardcoded) so they can never drift from the release. Peer
 * pins mirror package.json peerDependencies ranges (drift-guarded by
 * src/__tests__/config/parameters.test.ts).
 */
export const BIOMCP_NPM_PIN = `biomcp@${VERSION.split('.').slice(0, 2).join('.')}`;
export const PEER_NPM_PINS: Readonly<Record<'webr' | 'mysql2', string>> = { webr: 'webr@0.6', mysql2: 'mysql2@3' };

export type PeerPackageName = 'webr' | 'mysql2';

/** Shell form of the recommended zero-install client command. */
export function oneShotCommand(peer?: PeerPackageName): string {
  return oneShotArgv(peer).join(' ');
}

/** Client command-array form (plain argv, no shell) of the same command. */
export function oneShotArgv(peer?: PeerPackageName): string[] {
  const argv = ['npx', '-y', '-p', BIOMCP_NPM_PIN];
  if (peer) argv.push('-p', PEER_NPM_PINS[peer]);
  argv.push('biomcp');
  return argv;
}

export const FEATURE_GROUPS: readonly FeatureGroup[] = [
  {
    id: 'database',
    label: 'Database access (read-only SQL over MySQL / SQLite files)',
    triggerVar: 'DB_TYPE',
    triggerStyle: { kind: 'siblingValue', sibling: 'type' },
    tools: ['db_query', 'db_list_tables', 'db_describe_table'],
    smokeTestTool: 'db_list_tables',
    peerDeps: [
      {
        package: 'mysql2',
        commands: [
          oneShotCommand('mysql2'),
          'mkdir biomcp-mysql && cd biomcp-mysql && npm install biomcp mysql2',
          'node <ABS_PATH>/biomcp-mysql/node_modules/biomcp/dist/bundle.js',
        ],
        note:
          'Only for type="mysql" — SQLite uses the built-in node:sqlite. Command 1 is the recommended client command array (zero-install; peer pins are rendered from the release). Commands 2-3 build a local tree; command 3 is its client invocation and must use an ABSOLUTE path. ' +
          LOCAL_TREE_NOTE,
      },
    ],
    sectionSchema: databaseSection,
    rows: [
      { kind: 'file', id: 'features.database.enabled', group: 'database', key: 'enabled', envVar: 'DB_TYPE', schema: boolish, classification: null, effect: 'Master switch for the database tools (db_query, db_list_tables, db_describe_table).' },
      { kind: 'file', id: 'features.database.type', group: 'database', key: 'type', envVar: 'DB_TYPE', schema: z.enum(['mysql', 'sqlite']), classification: null, effect: 'Backend selection; enables as DB_TYPE=<type>.' },
      { kind: 'file', id: 'features.database.sqlite_path', group: 'database', key: 'sqlite_path', envVar: 'DB_SQLITE_PATH', envVarAliases: ['DB_DATABASE'], schema: z.union([z.string(), z.array(z.string())]), classification: 'sensitive', effect: 'SQLite file(s): string or array; first = main database, rest attach read-only (max 11 total). Relative paths resolve against the config file.', isPath: true, toEnv: pathsToEnv, fromEnv: csvPaths },
      { kind: 'file', id: 'features.database.host', group: 'database', key: 'host', envVar: 'DB_HOST', schema: z.string(), classification: 'sensitive', effect: 'MySQL host (default localhost).' },
      { kind: 'file', id: 'features.database.port', group: 'database', key: 'port', envVar: 'DB_PORT', schema: z.number().int().min(1).max(65535), defaultValue: 3306, classification: null, fromEnv: num, effect: 'MySQL port.' },
      { kind: 'file', id: 'features.database.user', group: 'database', key: 'user', envVar: 'DB_USER', envVarAliases: ['DB_USERNAME'], schema: z.string(), classification: 'sensitive', effect: 'MySQL user.' },
      { kind: 'file', id: 'features.database.password', group: 'database', key: 'password', envVar: 'DB_PASSWORD', schema: z.string(), classification: 'secret', effect: 'MySQL password. Prefer the env var over storing it in the file.' },
      { kind: 'file', id: 'features.database.database', group: 'database', key: 'database', envVar: 'DB_DATABASE', classification: 'sensitive', schema: z.string(), effect: 'MySQL database name.' },
      { kind: 'file', id: 'features.database.connection_timeout_ms', group: 'database', key: 'connection_timeout_ms', envVar: 'DB_CONNECTION_TIMEOUT_MS', schema: positiveIntMs, defaultValue: 10000, classification: null, fromEnv: num, effect: 'Connect timeout in ms.' },
    ],
  },
  {
    id: 'analysis_r',
    label: 'R/Bioconductor analysis (DESeq2, edgeR, limma in sandboxed WebAssembly R)',
    triggerVar: 'ANALYSIS_R',
    triggerStyle: { kind: 'constant', value: '1' },
    tools: ['analysis_r_deseq2', 'analysis_r_edger', 'analysis_r_limma', 'analysis_r_session_info'],
    smokeTestTool: 'analysis_r_session_info',
    peerDeps: [
      {
        package: 'webr',
        commands: [
          oneShotCommand('webr'),
          'mkdir biomcp-r && cd biomcp-r && npm install biomcp webr',
          'node <ABS_PATH>/biomcp-r/node_modules/biomcp/dist/bundle.js',
        ],
        note:
          'Command 1 is the recommended client command array (zero-install; peer pins are rendered from the release). Commands 2-3 build a local tree; command 3 is its client invocation and must use an ABSOLUTE path. ' +
          LOCAL_TREE_NOTE,
      },
    ],
    sectionSchema: analysisRSection,
    rows: [
      { kind: 'file', id: 'features.analysis_r.enabled', group: 'analysis_r', key: 'enabled', envVar: 'ANALYSIS_R', schema: boolish, classification: null, effect: 'Master switch for the R analysis tools.' },
      { kind: 'file', id: 'features.analysis_r.timeout_ms', group: 'analysis_r', key: 'timeout_ms', envVar: 'ANALYSIS_R_TIMEOUT_MS', schema: positiveIntMs, defaultValue: 600000, classification: null, fromEnv: num, effect: 'Per-analysis timeout in ms.' },
      { kind: 'file', id: 'features.analysis_r.mem_limit_mb', group: 'analysis_r', key: 'mem_limit_mb', envVar: 'ANALYSIS_R_MEM_LIMIT_MB', schema: memLimitMb, defaultValue: 2048, classification: null, fromEnv: num, effect: 'RSS watermark in MB above which new analyses are refused.' },
      { kind: 'file', id: 'features.analysis_r.mirror_url', group: 'analysis_r', key: 'mirror_url', envVar: 'ANALYSIS_R_MIRROR_URL', classification: 'sensitive', schema: z.string(), effect: 'Override for the wasm package bundle source (.tar.gz path/file://URL/http(s) URL, or a trusted extracted directory).', isPath: true },
      { kind: 'file', id: 'features.analysis_r.github_repo', group: 'analysis_r', key: 'github_repo', envVar: 'ANALYSIS_R_GITHUB_REPO', classification: 'sensitive', schema: z.string(), effect: 'owner/repo to fetch release assets from.' },
    ],
  },
  {
    id: 'analysis_biowasm',
    label: 'Biowasm analysis (samtools/bedtools/bcftools in sandboxed WebAssembly)',
    triggerVar: 'ANALYSIS_BIOWASM',
    triggerStyle: { kind: 'constant', value: '1' },
    tools: [
      'analysis_bam_summary',
      'analysis_bam_view_region',
      'analysis_bcf_summary',
      'analysis_bcf_view_region',
      'analysis_bed_op',
      'analysis_biowasm_convert',
      'analysis_biowasm_session_info',
      'analysis_biowasm_cli',
    ],
    smokeTestTool: 'analysis_biowasm_session_info',
    peerDeps: [],
    sectionSchema: biowasmSection,
    rows: [
      { kind: 'file', id: 'features.analysis_biowasm.enabled', group: 'analysis_biowasm', key: 'enabled', envVar: 'ANALYSIS_BIOWASM', schema: boolish, classification: null, effect: 'Master switch for the biowasm analysis tools.' },
      { kind: 'file', id: 'features.analysis_biowasm.timeout_ms', group: 'analysis_biowasm', key: 'timeout_ms', envVar: 'ANALYSIS_BIOWASM_TIMEOUT_MS', schema: positiveIntMs, defaultValue: 600000, classification: null, fromEnv: num, effect: 'Per-run inactivity timeout in ms (progress resets it).' },
      { kind: 'file', id: 'features.analysis_biowasm.max_run_ms', group: 'analysis_biowasm', key: 'max_run_ms', envVar: 'ANALYSIS_BIOWASM_MAX_RUN_MS', schema: positiveIntMs, defaultValue: 3600000, classification: null, fromEnv: num, effect: 'Absolute per-run ceiling in ms.' },
      { kind: 'file', id: 'features.analysis_biowasm.mem_limit_mb', group: 'analysis_biowasm', key: 'mem_limit_mb', envVar: 'ANALYSIS_BIOWASM_MEM_LIMIT_MB', schema: memLimitMb, defaultValue: 2048, classification: null, fromEnv: num, effect: 'Whole-process RSS watermark in MB.' },
      { kind: 'file', id: 'features.analysis_biowasm.workers', group: 'analysis_biowasm', key: 'workers', envVar: 'ANALYSIS_BIOWASM_WORKERS', schema: z.number().int().min(1).max(64), defaultValue: 1, classification: null, fromEnv: num, effect: 'Worker-pool size (memory: budget ~2 GB per worker).' },
      { kind: 'file', id: 'features.analysis_biowasm.mirror_url', group: 'analysis_biowasm', key: 'mirror_url', envVar: 'ANALYSIS_BIOWASM_MIRROR_URL', classification: 'sensitive', schema: z.string(), effect: 'Override for the wasm asset source.', isPath: true },
    ],
  },
];

/**
 * Environment-only parameters (query-only; values are never emitted by the
 * tool — presence + effect + fingerprint only).
 */
export const ENV_PARAM_ROWS: readonly EnvParamRow[] = [
  { kind: 'env', id: 'ANALYSIS_BIOWASM_DATA_DIR', group: 'biowasm', classification: 'sensitive', effect: 'Allowlist root for host_path sources (unset = host files denied). Security boundary — operator-set only.', howToSet: 'Set ANALYSIS_BIOWASM_DATA_DIR in the client env block (docs/BIOWASM-ANALYSIS.md).' },
  { kind: 'env', id: 'ANALYSIS_BIOWASM_WORKER_PATH', group: 'biowasm', classification: 'sensitive', effect: 'Explicit path to the biowasm worker bundle (dev mode). Loads and runs code — operator-set only.', howToSet: 'Set ANALYSIS_BIOWASM_WORKER_PATH in the client env block (dev mode only).' },
  { kind: 'env', id: 'NCBI_API_KEY', group: 'api-keys', classification: 'sensitive', effect: 'Higher NCBI E-utilities rate limits (3 → 10 req/s).', howToSet: 'Set NCBI_API_KEY in the client env block.' },
  { kind: 'env', id: 'NCBI_EMAIL', group: 'api-keys', classification: 'sensitive', effect: 'Polite-contact tool/email params on NCBI requests.', howToSet: 'Set NCBI_EMAIL in the client env block.' },
  { kind: 'env', id: 'S2_API_KEY', group: 'api-keys', classification: 'sensitive', effect: 'Higher Semantic Scholar rate limits.', howToSet: 'Set S2_API_KEY in the client env block.' },
  { kind: 'env', id: 'OPENFDA_API_KEY', group: 'api-keys', classification: 'sensitive', effect: 'Higher OpenFDA rate limits.', howToSet: 'Set OPENFDA_API_KEY in the client env block.' },
  { kind: 'env', id: 'ONCOKB_TOKEN', group: 'api-keys', classification: 'secret', effect: 'Required by the variant_oncokb tool (OncoKB annotations).', howToSet: 'Set ONCOKB_TOKEN in the client env block (request access at oncokb.org).' },
  { kind: 'env', id: 'DISGENET_API_KEY', group: 'api-keys', classification: 'secret', effect: 'Required for DisGeNET disease-gene associations (gene_diseases falls back to OpenTargets without it).', howToSet: 'Set DISGENET_API_KEY in the client env block.' },
  { kind: 'env', id: 'CROSSREF_EMAIL', group: 'api-keys', classification: 'sensitive', effect: 'Puts Crossref requests in the polite pool.', howToSet: 'Set CROSSREF_EMAIL in the client env block.' },
  { kind: 'env', id: 'EPO_OPS_CONSUMER_KEY', group: 'api-keys', classification: 'secret', effect: 'Enables the EPO OPS patent backend (with EPO_OPS_CONSUMER_SECRET).', howToSet: 'Set EPO_OPS_CONSUMER_KEY and EPO_OPS_CONSUMER_SECRET in the client env block.' },
  { kind: 'env', id: 'EPO_OPS_CONSUMER_SECRET', group: 'api-keys', classification: 'secret', effect: 'Enables the EPO OPS patent backend (with EPO_OPS_CONSUMER_KEY).', howToSet: 'Set EPO_OPS_CONSUMER_KEY and EPO_OPS_CONSUMER_SECRET in the client env block.' },
  { kind: 'env', id: 'USPTO_API_KEY', group: 'api-keys', classification: 'secret', effect: 'Enables the USPTO Open Data Portal patent backend.', howToSet: 'Set USPTO_API_KEY in the client env block.' },
  { kind: 'env', id: 'HTTPS_PROXY', group: 'proxy', classification: 'sensitive', effect: 'Proxy for HTTPS requests (honored by every upstream fetch).', howToSet: 'Set HTTPS_PROXY/HTTP_PROXY (+NO_PROXY) in the client env block.' },
  { kind: 'env', id: 'HTTP_PROXY', group: 'proxy', classification: 'sensitive', effect: 'Proxy for HTTP requests.', howToSet: 'Set HTTPS_PROXY/HTTP_PROXY (+NO_PROXY) in the client env block.' },
  { kind: 'env', id: 'NO_PROXY', group: 'proxy', classification: null, effect: 'Comma-separated hosts bypassing the proxy.', howToSet: 'Set NO_PROXY in the client env block.' },
  { kind: 'env', id: 'BIOMCP_CACHE_DIR', group: 'cache', classification: null, effect: 'Base directory for the wasm asset cache (default ~/.cache/biomcp).', howToSet: 'Set BIOMCP_CACHE_DIR in the client env block.' },
  { kind: 'env', id: 'BIOMCP_PROJECT_CONFIG', group: 'meta', classification: null, effect: 'Kill switch: 0/false disables loading the .biomcp.json project config file entirely.', howToSet: 'Set BIOMCP_PROJECT_CONFIG=0 in the client env block.' },
];

export const FILE_PARAM_ROWS: readonly FileParamRow[] = FEATURE_GROUPS.flatMap((g) => g.rows);
export const PARAM_ROWS: readonly ParamRow[] = [...FILE_PARAM_ROWS, ...ENV_PARAM_ROWS];

const fileRowById = new Map<string, FileParamRow>(FILE_PARAM_ROWS.map((r) => [r.id, r]));
const envRowById = new Map<string, EnvParamRow>(ENV_PARAM_ROWS.map((r) => [r.id, r]));

export function getFileRow(id: string): FileParamRow | undefined {
  return fileRowById.get(id);
}
export function getEnvRow(id: string): EnvParamRow | undefined {
  return envRowById.get(id);
}
export function getFeatureGroup(id: string): FeatureGroup | undefined {
  return FEATURE_GROUPS.find((g) => g.id === id);
}

/** Exact closed-set membership: the only valid `values` keys for set/reset. */
export function isFileParamId(id: string): boolean {
  return fileRowById.has(id);
}

export function closestFileParamId(id: string): string | undefined {
  if (id.length > 64) return undefined; // bound the levenshtein cost on absurd keys
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of fileRowById.keys()) {
    const d = levenshtein(id, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return bestDist <= Math.max(2, Math.floor(id.length / 3)) ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
