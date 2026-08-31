import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  FEATURE_GROUPS,
  FILE_PARAM_ROWS,
  ENV_PARAM_ROWS,
  PROTO_KEYS,
  closestFileParamId,
  getFileRow,
  getFeatureGroup,
  type FeatureGroup,
  type FileParamRow,
} from './parameters.js';
import { ConfigStoreError, configFilePath, readConfigFile, withStoreMutex, writeConfigFile } from './store.js';
import { isDbConfigured } from '../server/tools/db.js';
import { isAnalysisREnabled } from '../server/tools/ranalysis.js';
import { isBiowasmEnabled } from '../server/tools/biowasm.js';
import { getDbConfigFromEnv } from '../db/core/env.js';

/**
 * The unified configuration handler: the only module with config semantics.
 * - `loadAndApplyToEnv`: startup adapter and the ONLY writer of process.env
 *   (fill-if-unset; env always wins).
 * - `getStatus` / `setParameters` / `resetParameters`: consumed by the
 *   biomcp_configure tool. File params mutate `.biomcp.json`; env params are
 *   strictly query-only and value-masked (presence + fingerprint, never values).
 */

export interface StartupSnapshot {
  path: string;
  filePresent: boolean;
  /** Populated when a file was present but ignored (parse/schema/security refusal). */
  ignoredReason?: string;
  /** Env keys the loader filled from the file. */
  appliedKeys: string[];
  /** The validated features subtree as loaded at startup (drift detection). */
  appliedFeatures: Record<string, Record<string, unknown>> | null;
  killSwitchActive: boolean;
}

let startupSnapshot: StartupSnapshot | null = null;

export function resetLoaderStateForTests(): void {
  startupSnapshot = null;
  probeCache.clear();
}

export function getStartupSnapshot(): StartupSnapshot | null {
  return startupSnapshot;
}

/** Gate semantics reuse — never re-implemented. */
export function featureRunningNow(groupId: string): boolean {
  switch (groupId) {
    case 'database':
      return isDbConfigured();
    case 'analysis_r':
      return isAnalysisREnabled();
    case 'analysis_biowasm':
      return isBiowasmEnabled();
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Startup adapter
// ---------------------------------------------------------------------------

export function loadAndApplyToEnv(dir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): StartupSnapshot {
  const path = configFilePath(dir);
  const base: StartupSnapshot = { path, filePresent: false, appliedKeys: [], appliedFeatures: null, killSwitchActive: false };

  const kill = env.BIOMCP_PROJECT_CONFIG;
  if (kill !== undefined && kill !== '' && (kill === '0' || kill.toLowerCase() === 'false')) {
    const snapshot = { ...base, killSwitchActive: true };
    startupSnapshot = snapshot;
    return snapshot;
  }

  const read = readConfigFile(dir);
  if (read.status === 'missing') {
    startupSnapshot = base;
    return base;
  }
  const present: StartupSnapshot = { ...base, filePresent: true };

  if (read.status === 'error') {
    return ignoreFile(present, read.error.message);
  }

  const proto = findProtoKey(read.doc);
  if (proto) {
    return ignoreFile(present, `${path}: refusing key "${proto}" (prototype-pollution guard).`);
  }

  const featuresRaw = read.doc['features'];
  let features: Record<string, Record<string, unknown>> | null = null;
  if (featuresRaw !== undefined) {
    if (featuresRaw === null || typeof featuresRaw !== 'object' || Array.isArray(featuresRaw)) {
      return ignoreFile(present, `${path}: "features" must be a JSON object.`);
    }
    const unknownGroups = Object.keys(featuresRaw).filter((k) => !FEATURE_GROUPS.some((g) => g.id === k));
    if (unknownGroups.length > 0) {
      return ignoreFile(present, `${path}: unknown feature section(s) under "features": ${unknownGroups.join(', ')}. Only ${FEATURE_GROUPS.map((g) => g.id).join(', ')} are recognized.`);
    }
    for (const group of FEATURE_GROUPS) {
      const section = (featuresRaw as Record<string, unknown>)[group.id];
      if (section === undefined) continue;
      const parsed = group.sectionSchema.safeParse(section);
      if (!parsed.success) {
        return ignoreFile(present, `${path}: invalid features.${group.id} — ${formatZodError(parsed.error)}. File ignored.`);
      }
    }
    features = featuresRaw as Record<string, Record<string, unknown>>;
  }

  const appliedKeys: string[] = [];
  if (features) {
    for (const group of FEATURE_GROUPS) {
      const section = features[group.id];
      if (!section || section.enabled !== true) continue;
      if (!envSet(env, group.triggerVar)) {
        env[group.triggerVar] = triggerValue(group, section);
        appliedKeys.push(group.triggerVar);
      }
      for (const row of group.rows) {
        if (row.key === 'enabled' || row.key === 'type') continue;
        const value = section[row.key];
        if (value === undefined || value === null) continue;
        const vars = [row.envVar, ...(row.envVarAliases ?? [])];
        if (vars.some((v) => envSet(env, v))) continue;
        env[row.envVar] = valueToEnvString(row, value, dir);
        appliedKeys.push(row.envVar);
      }
    }
  }

  const snapshot: StartupSnapshot = { ...present, appliedKeys, appliedFeatures: features };
  startupSnapshot = snapshot;
  if (appliedKeys.length > 0) {
    const enabled = FEATURE_GROUPS.filter((g) => features?.[g.id]?.enabled === true).map((g) => g.id);
    console.error(`[biomcp] project config ${path}: enabled features [${enabled.join(', ')}] (${appliedKeys.length} env keys filled from file; env vars take precedence).`);
  }
  if (featureRunningNow('analysis_biowasm') && env.ANALYSIS_BIOWASM_DATA_DIR?.trim()) {
    console.error(`[biomcp] biowasm host_path allowlist (ANALYSIS_BIOWASM_DATA_DIR): ${env.ANALYSIS_BIOWASM_DATA_DIR} (source: env; security boundary).`);
  }
  return snapshot;
}

function ignoreFile(present: StartupSnapshot, reason: string): StartupSnapshot {
  console.error(`[biomcp] project config ignored: ${reason} (server continues with env-only configuration).`);
  const snapshot = { ...present, ignoredReason: reason };
  startupSnapshot = snapshot;
  return snapshot;
}

function envSet(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = env[key];
  return v !== undefined && v !== '';
}

function triggerValue(group: FeatureGroup, section: Record<string, unknown>): string {
  if (group.triggerStyle.kind === 'constant') return group.triggerStyle.value;
  return String(section[group.triggerStyle.sibling] ?? '');
}

function valueToEnvString(row: FileParamRow, value: unknown, configDir: string): string {
  const v = row.toEnv ? row.toEnv(value) : String(value);
  return row.isPath ? anchorPaths(v, configDir) : v;
}

/** Anchor plain relative paths (no URL scheme) against the config file's directory. */
function anchorPaths(csvOrSingle: string, configDir: string): string {
  return csvOrSingle
    .split(',')
    .map((part) => {
      const t = part.trim();
      if (t.length === 0) return t;
      if (isAbsolute(t) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) return t;
      return resolvePath(configDir, t);
    })
    .join(',');
}

function findProtoKey(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findProtoKey(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (PROTO_KEYS.has(key)) return key;
    const hit = findProtoKey((value as Record<string, unknown>)[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

function formatZodError(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${(i.path as string[]).length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
}

// ---------------------------------------------------------------------------
// Peer-dep probes + server context
// ---------------------------------------------------------------------------

export type ProbeStatus = 'met' | 'missing' | 'unknown';

const probeCache = new Map<string, ProbeStatus>();

export function probePeerDeps(): Record<string, ProbeStatus> {
  const out: Record<string, ProbeStatus> = {};
  for (const group of FEATURE_GROUPS) {
    for (const dep of group.peerDeps) {
      out[dep.package] = probeModule(dep.package);
    }
  }
  return out;
}

/**
 * Best-effort module resolution probe — informational only (availability,
 * not a security assertion). Tries, in order: `import.meta.resolve` (resolves
 * exactly what `await import(name)` would load), then require-resolution
 * anchored at the bundle and at cwd. Reflects THIS process's tree only.
 */
function probeModule(name: string): ProbeStatus {
  const cached = probeCache.get(name);
  if (cached) return cached;

  let attempts = 0;
  let resolved = false;

  const meta = import.meta as { resolve?: (specifier: string, parent?: string) => string };
  if (typeof meta.resolve === 'function') {
    attempts++;
    try {
      meta.resolve(name);
      resolved = true;
    } catch {
      // resolution failed — fall through to require-based anchors
    }
  }
  if (!resolved) {
    const anchors: string[] = [];
    try {
      anchors.push(fileURLToPath(import.meta.url));
    } catch {
      // no bundle anchor
    }
    if (typeof process.cwd === 'function' && process.cwd()) {
      anchors.push(resolvePath(process.cwd(), 'package.json'));
    }
    for (const anchor of anchors) {
      attempts++;
      try {
        createRequire(anchor).resolve(name);
        resolved = true;
        break;
      } catch {
        // try next anchor
      }
    }
  }

  const status: ProbeStatus = attempts === 0 ? 'unknown' : resolved ? 'met' : 'missing';
  probeCache.set(name, status);
  return status;
}

export interface ServerContext {
  bundle_path: string;
  cwd: string;
  install_mode: 'npx-cache' | 'local-tree' | 'from-source' | 'unknown';
}

export function serverContext(): ServerContext {
  let bundlePath = 'unknown';
  try {
    bundlePath = fileURLToPath(import.meta.url);
  } catch {
    // keep 'unknown'
  }
  let mode: ServerContext['install_mode'] = 'unknown';
  if (bundlePath !== 'unknown') {
    if (bundlePath.includes('_npx')) mode = 'npx-cache';
    else if (bundlePath.includes('node_modules')) mode = 'local-tree';
    else mode = 'from-source';
  }
  return { bundle_path: bundlePath, cwd: process.cwd(), install_mode: mode };
}

// ---------------------------------------------------------------------------
// Mutation guard (cwd sanity)
// ---------------------------------------------------------------------------

export interface CwdRefusal {
  reason: string;
  /** Paste-ready env-block translation of the attempted writes. */
  env_block: Record<string, string>;
  hints: string[];
}

/** Hard refusal when the process working directory is not a real project root. */
export function cwdRefusal(values: Record<string, unknown>, cwd: string = process.cwd()): CwdRefusal | null {
  if (cwd === resolvePath('/') || cwd === homedir()) {
    const envBlock: Record<string, string> = {};
    for (const [id, value] of Object.entries(values)) {
      const row = getFileRow(id);
      if (!row || value === null || value === undefined) continue;
      if (row.key === 'enabled') {
        // Trigger rows translate with the loader's sibling semantics (DB_TYPE comes from `type`).
        const group = getFeatureGroup(row.group);
        if (!group) continue;
        if (group.triggerStyle.kind === 'constant') {
          envBlock[group.triggerVar] = group.triggerStyle.value;
        } else {
          const sibling = getFileRow(`features.${row.group}.${group.triggerStyle.sibling}`);
          const siblingValue = sibling ? values[sibling.id] : undefined;
          if (!sibling || siblingValue === undefined || siblingValue === null) continue;
          envBlock[sibling.envVar] = String(siblingValue);
        }
        continue;
      }
      if (row.key === 'type') continue; // already emitted through the enabled translation
      if (row.classification === 'secret') {
        envBlock[row.envVar] = '<set-here>'; // secrets are never echoed into any response
        continue;
      }
      // sensitive values stay paste-usable: they are caller-supplied (already in the request
      // transcript), unlike env/file-stored values which are masked everywhere else.
      envBlock[row.envVar] = row.toEnv ? row.toEnv(value) : String(value);
    }
    return {
      reason: `Refusing to write the project config: the server's working directory is ${cwd} — not a project root. File-based configuration requires running biomcp with a project cwd (e.g. Claude Code .mcp.json at the project root, opencode project config); cwd-less clients (e.g. Claude Desktop) should use the client env block instead.`,
      env_block: envBlock,
      hints: [
        'Claude Desktop / Claude Code .mcp.json: add the pairs in env_block to the "env" object of the biomcp server entry',
        'Codex: [mcp_servers.biomcp.env] table in ~/.codex/config.toml',
        'OpenCode: "environment" object in opencode.json',
        'Full guide: docs/AGENT-INSTALL.md sections 2 and 4',
      ],
    };
  }
  try {
    accessSync(cwd, fsConstants.W_OK);
  } catch {
    return {
      reason: `Refusing to write the project config: ${cwd} is not writable.`,
      env_block: {},
      hints: ['Set configuration via the client env block instead (docs/AGENT-INSTALL.md section 3).'],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusOptions {
  filter?: string;
  env?: NodeJS.ProcessEnv;
  dir?: string;
}

function fingerprint(value: string): string {
  return `len:${value.length},sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

export function getStatus(options: StatusOptions = {}): Record<string, unknown> {
  const env = options.env ?? process.env;
  const dir = options.dir ?? process.cwd();
  const snapshot = startupSnapshot;
  const read = readConfigFile(dir);
  const context = serverContext();

  let fileDoc: Record<string, unknown> = {};
  let fileError: string | null = null;
  if (read.status === 'ok') fileDoc = read.doc;
  else if (read.status === 'error') fileError = read.error.message;

  const fileFeatures = (fileDoc['features'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const appliedFeatures = snapshot?.appliedFeatures ?? null;

  const conflicts: Record<string, unknown>[] = [];
  const features = FEATURE_GROUPS.map((group) => {
    const running = featureRunningNow(group.id);
    const fileEnabled = fileFeatures[group.id]?.enabled === true;
    const appliedByLoader = snapshot?.appliedKeys.includes(group.triggerVar) ?? false;
    const pending =
      fileEnabled !== running ||
      (fileEnabled &&
        running &&
        appliedFeatures !== null &&
        JSON.stringify(appliedFeatures[group.id] ?? {}) !== JSON.stringify(fileFeatures[group.id] ?? {}));
    const vetoed = fileEnabled && !running && envSet(env, group.triggerVar);
    if (vetoed) {
      conflicts.push({
        type: 'env-veto',
        feature: group.id,
        detail: `features.${group.id}.enabled=true in the file, but the running process has a disabling ${group.triggerVar} env value (env wins).`,
        remediation: `Remove or truthy-set ${group.triggerVar} in the client env block, then restart.`,
      });
    }
    return {
      id: group.id,
      label: group.label,
      running_now: running,
      file_enabled: fileEnabled,
      source: running
        ? appliedByLoader
          ? 'config-file (applied at startup)'
          : `env (${group.triggerVar})`
        : fileEnabled
          ? vetoed
            ? 'disabled by env veto'
            : 'file (pending restart)'
          : 'default (off)',
      pending_restart: pending,
      trigger_var: group.triggerVar,
      tools: group.tools,
      settable_keys: group.rows.map((r) => r.key),
      prerequisites: prerequisitesFor(group),
    };
  });

  // Env-side value validation through row schemas (invalid_env conflicts)
  for (const row of FILE_PARAM_ROWS) {
    if (row.key === 'enabled' || row.key === 'type') continue;
    const raw = envSet(env, row.envVar)
      ? env[row.envVar]
      : (row.envVarAliases ?? []).map((a) => env[a]).find((v) => v !== undefined && v !== '');
    if (raw === undefined) continue;
    const converted = row.fromEnv ? row.fromEnv(raw) : raw;
    const parsed = row.schema.safeParse(converted);
    if (!parsed.success) {
      conflicts.push({
        type: 'invalid-env',
        key: row.id,
        env_var: row.envVar,
        detail: `Environment value fails validation: ${formatZodError(parsed.error)}. The feature will error at first use.`,
      });
    }
  }
  if (isDbConfigured()) {
    try {
      getDbConfigFromEnv();
    } catch (err) {
      // Strip any "Entries:" listing — env-side sqlite paths are sensitive and must not surface.
      const detail = String(err instanceof Error ? err.message : err).split('\nEntries:')[0].trim();
      conflicts.push({ type: 'env-parse-error', feature: 'database', detail });
    }
  }

  const filter = options.filter;
  const filtered = filter !== undefined && filter !== 'all';

  const health: Record<string, unknown> = {
    config_path: configFilePath(dir),
    file_present: read.status !== 'missing',
    file_error: fileError,
    loaded_at_startup: snapshot !== null,
    startup_ignored_reason: snapshot?.ignoredReason ?? null,
    kill_switch_active: snapshot?.killSwitchActive ?? false,
    note: snapshot === null ? 'config file is loaded by the server at startup; this process has not run the loader (tests/library use)' : null,
  };
  if (snapshot?.ignoredReason) {
    conflicts.push({ type: 'config-file-ignored', detail: snapshot.ignoredReason });
  }

  return {
    server_context: context,
    config_health: health,
    features,
    conflicts,
    counts: { file_params: FILE_PARAM_ROWS.length, env_params: ENV_PARAM_ROWS.length },
    catalog_hint: filtered
      ? null
      : 'call {"action":"status","filter":"<feature id | file | env | dotted id prefix>"} for that scope\'s detailed rows (effects, defaults, how-to-set) before setting keys',
    // Default (unfiltered) status omits the full parameter catalog — it is ~60%
    // of the payload and never needed to construct a valid `set` call
    // (features[].settable_keys covers that). Detailed rows are one filter away.
    ...(filtered ? { catalog: buildCatalog(filter, env, fileFeatures) } : {}),
  };
}

function buildCatalog(filter: string | undefined, env: NodeJS.ProcessEnv, fileFeatures: Record<string, Record<string, unknown>>): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const wantDetailed = filter !== undefined && filter !== 'all';
  const kindFilter = filter === 'file' || filter === 'env' ? filter : null;
  const matches = (id: string, kind: 'file' | 'env', group?: string): boolean => {
    if (kindFilter !== null) return kind === kindFilter;
    if (filter === undefined || filter === 'all') return true;
    if (group !== undefined && filter === group) return true;
    return id === filter || id.startsWith(filter + '.');
  };

  for (const group of FEATURE_GROUPS) {
    for (const row of group.rows) {
      if (!matches(row.id, 'file', group.id)) continue;
      const section = fileFeatures[group.id] ?? {};
      const fileValue = section[row.key];
      const fromFile = fileValue !== undefined;
      const envRaw = env[row.envVar];
      const appliedByLoader = startupSnapshot?.appliedKeys.includes(row.envVar) ?? false;
      const envEffective = appliedByLoader || (envRaw !== undefined && envRaw !== '');

      let provenance: string;
      let effective: unknown;
      if (row.key === 'enabled') {
        provenance = featureRunningNow(group.id) ? (appliedByLoader ? 'file' : 'env') : fromFile ? 'file (pending restart)' : 'default';
        effective = featureRunningNow(group.id);
      } else if (envEffective) {
        provenance = appliedByLoader ? 'file' : 'env';
        effective = displayFileValue(row, row.fromEnv ? row.fromEnv(envRaw ?? '') : envRaw ?? null, provenance);
      } else if (fromFile) {
        provenance = 'file (pending restart)';
        effective = displayFileValue(row, fileValue, 'file');
      } else {
        provenance = 'default';
        effective = row.defaultValue !== undefined ? row.defaultValue : null;
      }
      rows.push({
        id: row.id,
        kind: 'file',
        group: group.id,
        env_var: row.envVar,
        effective,
        provenance,
        classification: row.classification,
        ...(wantDetailed ? { effect: row.effect, default: row.defaultValue ?? null } : {}),
      });
    }
  }
  for (const row of ENV_PARAM_ROWS) {
    if (!matches(row.id, 'env', row.group)) continue;
    const set = env[row.id] !== undefined && env[row.id] !== '';
    rows.push({
      id: row.id,
      kind: 'env',
      group: row.group,
      set,
      // env row values are never emitted — presence + non-reversible fingerprint only
      fingerprint: set ? fingerprint(env[row.id] as string) : null,
      classification: row.classification,
      ...(wantDetailed ? { effect: row.effect, how_to_set: row.howToSet } : {}),
    });
  }
  return rows;
}

function displayFileValue(row: FileParamRow, value: unknown, provenance: string): unknown {
  if (row.classification === 'secret') return '[redacted]';
  if (row.classification === 'sensitive' && provenance === 'env') return '[masked: env-sourced sensitive value]';
  return value;
}

function prerequisitesFor(group: FeatureGroup): Record<string, unknown>[] {
  const probes = probePeerDeps();
  const context = serverContext();
  return group.peerDeps.map((dep) => {
    const status = probes[dep.package] ?? 'unknown';
    return {
      feature: group.id,
      dependency: dep.package,
      status,
      commands: dep.commands,
      note: dep.note,
      caveat:
        status === 'met'
          ? null
          : context.install_mode === 'npx-cache'
            ? `This server runs from the npx cache (${context.bundle_path}) — bare ["npx","biomcp"] can never see peer deps. Use the pinned one-shot command from "commands" as your client command array (zero install), or a local tree invoked by absolute path: command "node", args ["<tree>/node_modules/biomcp/dist/bundle.js"] — then restart.`
            : 'Probe reflects this process only; a dependency installed elsewhere is invisible until the client repoints and the server restarts.',
      relevant: group.id === 'database' ? 'mysql2 is needed only for type="mysql" (SQLite is built-in)' : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Set / reset
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  key: string;
  code: 'unknown-key' | 'read-only' | 'confirm-required' | 'invalid-value' | 'write-error';
  message: string;
  suggestion?: string;
  valid_keys?: string[];
  how_to_set?: string;
}

export interface SetResult {
  validation: { ok: boolean; errors: ValidationIssue[] };
  wrote: boolean;
  changes: { key: string; op: 'added' | 'changed' | 'removed'; old: unknown; new: unknown }[];
  config_path: string;
  pending_restart: Record<string, boolean>;
  prerequisites: Record<string, unknown>[];
  secrets_written: string[];
  repaired_note: string | null;
}

export interface SetOptions {
  dryRun?: boolean;
  confirmSensitive?: boolean;
  env?: NodeJS.ProcessEnv;
  dir?: string;
}

export async function setParameters(values: Record<string, unknown>, options: SetOptions = {}): Promise<SetResult> {
  const dir = options.dir ?? process.cwd();
  const errors: ValidationIssue[] = [];
  if (Object.keys(values).length === 0) {
    return emptyResult(dir, [{ key: '', code: 'invalid-value', message: 'set requires at least one value: {"<dotted id>": value}.' }]);
  }
  const touchedGroups = new Set<string>();
  const sensitiveTouched: string[] = [];

  for (const [id, value] of Object.entries(values)) {
    if (id.split('.').some((seg) => PROTO_KEYS.has(seg))) {
      errors.push({ key: id, code: 'invalid-value', message: `Refusing reserved key "${id}".` });
      continue;
    }
    const row = getFileRow(id);
    if (!row) {
      const envRow = ENV_PARAM_ROWS.find((r) => r.id === id);
      if (envRow) {
        errors.push({ key: id, code: 'read-only', message: `"${id}" is an environment-only parameter — query-only, never settable via the config file.`, how_to_set: envRow.howToSet });
      } else {
        errors.push({ key: id, code: 'unknown-key', message: `Unknown parameter "${id}".`, suggestion: closestFileParamId(id) });
      }
      continue;
    }
    if (row.classification === 'sensitive' || row.classification === 'secret') sensitiveTouched.push(id);
    if (value !== null) {
      const parsed = row.schema.safeParse(value);
      if (!parsed.success) {
        errors.push({ key: id, code: 'invalid-value', message: `${id}: ${formatZodError(parsed.error)}` });
        continue;
      }
    }
    touchedGroups.add(row.group);
  }

  if (sensitiveTouched.length > 0 && !options.confirmSensitive) {
    errors.unshift({
      key: sensitiveTouched[0],
      code: 'confirm-required',
      message: `Setting sensitive parameter(s) requires confirm_sensitive=true: ${sensitiveTouched.join(', ')}. Sensitive keys choose what the server connects to or loads from.`,
      valid_keys: sensitiveTouched,
    });
  }

  if (errors.length > 0) {
    // Subtree-scoped valid-key hints for unknown keys
    for (const err of errors) {
      if (err.code !== 'unknown-key') continue;
      const segs = err.key.split('.');
      const group = segs.length >= 2 && segs[0] === 'features' ? getFeatureGroup(segs[1]) : undefined;
      err.valid_keys = group ? group.rows.map((r) => r.id) : FEATURE_GROUPS.flatMap((g) => g.rows.map((r) => r.id)).slice(0, 8);
    }
    return emptyResult(dir, errors);
  }

  return withStoreMutex(() => applyPatch(values, { ...options, dir }));
}

function emptyResult(dir: string, errors: ValidationIssue[]): SetResult {
  return {
    validation: { ok: false, errors },
    wrote: false,
    changes: [],
    config_path: configFilePath(dir),
    pending_restart: {},
    prerequisites: [],
    secrets_written: [],
    repaired_note: null,
  };
}

function applyPatch(values: Record<string, unknown>, options: SetOptions & { dir: string }): SetResult {
  const dir = options.dir;
  const read = readConfigFile(dir);
  let doc: Record<string, unknown>;
  let repairedNote: string | null = null;
  if (read.status === 'ok') {
    doc = read.doc;
  } else if (read.status === 'missing') {
    doc = { $schema: 'https://github.com/yeyuan98/biomcp-ts/blob/main/docs/ENV-VARS.md#project-config-file-biomcpjson-alternative-to-env-blocks' };
  } else if (read.error.code === 'unreadable') {
    // invalid JSON / non-object top level → repair by replacing with a fresh document
    doc = {};
    repairedNote = `Previous file was invalid (${read.error.message}); it was replaced.`;
  } else {
    return emptyResult(dir, [{ key: '', code: 'write-error', message: `Cannot write config: ${read.error.message}` }]);
  }

  let features: Record<string, Record<string, unknown>> = {};
  const rawFeatures = doc['features'];
  if (rawFeatures !== undefined && rawFeatures !== null && (typeof rawFeatures !== 'object' || Array.isArray(rawFeatures))) {
    repairedNote = appendNote(repairedNote, 'Previous file had a non-object "features" value; it was replaced.');
  } else if (rawFeatures !== undefined && rawFeatures !== null) {
    for (const [groupId, section] of Object.entries(rawFeatures as Record<string, unknown>)) {
      if (section !== null && typeof section === 'object' && !Array.isArray(section)) {
        features[groupId] = section as Record<string, unknown>;
      } else if (section !== undefined) {
        repairedNote = appendNote(repairedNote, `Previous file had a non-object "features.${groupId}" value; it was replaced.`);
      }
    }
  }
  const before: Record<string, Record<string, unknown>> = deepClone(features) ?? {};

  for (const [id, value] of Object.entries(values)) {
    const row = getFileRow(id);
    if (!row) continue;
    const section = { ...(features[row.group] ?? {}) };
    if (value === null) {
      delete section[row.key];
      if (Object.keys(section).length === 0) delete features[row.group];
      else features[row.group] = section;
    } else {
      section[row.key] = value;
      features[row.group] = section;
    }
  }

  // Group-level validation on touched groups (cross-field rules)
  const errors: ValidationIssue[] = [];
  for (const group of FEATURE_GROUPS) {
    const section = features[group.id];
    if (section === undefined) continue;
    const touched = Object.values(values).length > 0 && Object.keys(values).some((id) => getFileRow(id)?.group === group.id);
    if (!touched) continue;
    const parsed = group.sectionSchema.safeParse(section);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = (issue.path as string[]).join('.') || '(root)';
        errors.push({ key: `features.${group.id}.${path}`, code: 'invalid-value', message: `features.${group.id}.${path}: ${issue.message}` });
      }
    }
  }
  if (errors.length > 0) {
    return { ...emptyResult(dir, errors), repaired_note: repairedNote };
  }

  const changes = diffFeatures(before, features);
  if (!options.dryRun) {
    if (Object.keys(features).length > 0) doc['features'] = features;
    else delete doc['features'];
    writeConfigFile(dir, doc);
  }

  const pendingRestart: Record<string, boolean> = {};
  const prerequisites: Record<string, unknown>[] = [];
  for (const group of FEATURE_GROUPS) {
    if (!Object.keys(values).some((id) => getFileRow(id)?.group === group.id)) continue;
    const fileEnabled = features[group.id]?.enabled === true;
    pendingRestart[group.id] = fileEnabled !== featureRunningNow(group.id);
    prerequisites.push(...prerequisitesFor(group));
  }

  const secretsWritten = options.dryRun
    ? []
    : Object.entries(values)
        .filter(([id, v]) => getFileRow(id)?.classification === 'secret' && v !== null)
        .map(([id]) => id);

  return {
    validation: { ok: true, errors: [] },
    wrote: !options.dryRun,
    changes,
    config_path: configFilePath(dir),
    pending_restart: pendingRestart,
    prerequisites,
    secrets_written: secretsWritten,
    repaired_note: repairedNote,
  };
}

export interface ResetTarget {
  feature?: string;
  keys?: string[];
}

export async function resetParameters(target: ResetTarget, options: SetOptions = {}): Promise<SetResult> {
  const values: Record<string, unknown> = {};
  if (target.feature) {
    const group = getFeatureGroup(target.feature);
    if (!group) {
      return emptyResult(options.dir ?? process.cwd(), [
        { key: target.feature, code: 'unknown-key', message: `Unknown feature "${target.feature}".`, valid_keys: FEATURE_GROUPS.map((g) => g.id) },
      ]);
    }
    for (const row of group.rows) values[row.id] = null;
  }
  if (target.keys) {
    for (const id of target.keys) values[id] = null;
  }
  if (Object.keys(values).length === 0) {
    return emptyResult(options.dir ?? process.cwd(), [{ key: '', code: 'unknown-key', message: 'reset requires feature or keys.' }]);
  }
  return setParameters(values, options);
}

function appendNote(existing: string | null, note: string): string {
  return existing ? `${existing} ${note}` : note;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function diffFeatures(
  before: Record<string, Record<string, unknown>>,
  after: Record<string, Record<string, unknown>>
): { key: string; op: 'added' | 'changed' | 'removed'; old: unknown; new: unknown }[] {
  const changes: { key: string; op: 'added' | 'changed' | 'removed'; old: unknown; new: unknown }[] = [];
  const groups = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const group of groups) {
    const keys = new Set([...Object.keys(before[group] ?? {}), ...Object.keys(after[group] ?? {})]);
    for (const key of keys) {
      const oldValue = before[group]?.[key];
      const newValue = after[group]?.[key];
      const id = `features.${group}.${key}`;
      const row = getFileRow(id);
      const showOld = row?.classification === 'secret' ? '[redacted]' : oldValue;
      const showNew = row?.classification === 'secret' ? '[redacted]' : newValue;
      if (oldValue === undefined && newValue !== undefined) changes.push({ key: id, op: 'added', old: null, new: showNew });
      else if (oldValue !== undefined && newValue === undefined) changes.push({ key: id, op: 'removed', old: showOld, new: null });
      else if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) changes.push({ key: id, op: 'changed', old: showOld, new: showNew });
    }
  }
  return changes;
}

export { ConfigStoreError };
