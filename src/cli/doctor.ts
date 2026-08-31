import { totalmem } from 'node:os';
import { loadAndApplyToEnv, getStatus, serverContext } from '../config/handler.js';
import { ENV_PARAM_ROWS, oneShotArgv, oneShotCommand } from '../config/parameters.js';
import { clientSnippets, type ClientId } from './snippets.js';
import type { DoctorBlocker, DoctorReport, DoctorWarning } from './types.js';

/**
 * `biomcp doctor` — offline diagnostic over the SAME config semantics as the
 * server (loadAndApplyToEnv → getStatus). Never starts the MCP server, never
 * touches stdin, never echoes env values. Exit code: 1 iff hard blockers exist.
 *
 * Import context note: the doctor must call loadAndApplyToEnv() against
 * process.env (a throwaway process) because the feature gate functions read
 * process.env directly — a scratch env would misreport running_now/source.
 * Expected side effect: the loader's stderr banners appear; --json consumers
 * read stdout only.
 */

/** Mirrors package.json engines.node (">=22.13.0"); drift-guarded by a test. */
export const REQUIRED_NODE = { major: 22, minor: 13 } as const;

const RAM_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

export function nodeVersionOk(version: string = process.versions.node): boolean {
  const [major, minor] = version.split('.').map(Number);
  if (major === undefined || minor === undefined) return false;
  return major > REQUIRED_NODE.major || (major === REQUIRED_NODE.major && minor >= REQUIRED_NODE.minor);
}

export function buildDoctorReport(dir: string = process.cwd(), client?: ClientId): DoctorReport {
  const startup = loadAndApplyToEnv(dir);
  const context = serverContext();
  const status = getStatus({ dir });
  const env = process.env;

  const nodeOk = nodeVersionOk();
  const blockers: DoctorBlocker[] = [];
  const warnings: DoctorWarning[] = [];

  if (!nodeOk) {
    blockers.push({
      code: 'NODE_TOO_OLD',
      message: `Node ${process.versions.node} is too old — biomcp requires >= ${REQUIRED_NODE.major}.${REQUIRED_NODE.minor} (built-in node:sqlite).`,
      fix_note: `Install Node >= ${REQUIRED_NODE.major}.${REQUIRED_NODE.minor}, then re-run doctor.`,
    });
  }
  if (startup.ignoredReason) {
    blockers.push({
      code: 'CONFIG_FILE_IGNORED',
      message: `${startup.path} is present but ignored: ${startup.ignoredReason}`,
      fix_note: 'Fix or remove the config file — while it is ignored, file-based configuration is silently off.',
    });
  }

  const dbType = env['DB_TYPE']?.trim();
  for (const feature of status['features'] as { id: string; running_now: boolean; prerequisites: Record<string, unknown>[] }[]) {
    if (!feature.running_now) continue;
    for (const dep of feature.prerequisites) {
      if (dep['status'] !== 'missing') continue;
      if (feature.id === 'database' && dbType !== 'mysql') continue; // mysql2 irrelevant for sqlite
      blockers.push({
        code: 'PEER_DEP_MISSING',
        feature: feature.id,
        dependency: String(dep['dependency']),
        message: `${feature.id} is enabled but its peer dependency "${dep['dependency']}" is not resolvable from this install (mode: ${context.install_mode}).`,
        fix_command: oneShotCommand(dep['dependency'] as 'webr' | 'mysql2'),
        fix_note:
          'Use this as your MCP client command array (no install step needed), or install a local tree and point the client at node <tree>/node_modules/biomcp/dist/bundle.js — then restart the client.',
      });
    }
  }

  if (dbType === 'mysql' && (!env['DB_USER']?.trim() || !env['DB_DATABASE']?.trim())) {
    blockers.push({
      code: 'DB_CONFIG_INCOMPLETE',
      feature: 'database',
      message: 'DB_TYPE=mysql requires DB_USER and DB_DATABASE (DB_HOST defaults to localhost).',
      fix_note: 'Set DB_USER/DB_DATABASE in the client env block or the .biomcp.json file, then restart.',
    });
  }

  for (const conflict of status['conflicts'] as { type: string; detail?: string; remediation?: string; message?: string }[]) {
    if (conflict.type === 'config-file-ignored') continue; // already reported as CONFIG_FILE_IGNORED
    blockers.push({
      code: 'CONFIG_CONFLICT',
      message: `${conflict.type}: ${conflict.detail ?? conflict.message ?? 'configuration conflict'}`,
      fix_note: conflict.remediation,
    });
  }

  if (totalmem() < RAM_WARNING_BYTES) {
    warnings.push({
      code: 'LOW_RAM',
      message: `System RAM (${Math.round(totalmem() / 1024 / 1024 / 1024)} GB) is below the ~2 GB watermark the R/biowasm analysis features budget for.`,
    });
  }

  const featureRows = (status['features'] as { id: string; running_now: boolean; prerequisites: Record<string, unknown>[] }[]).map((f) => ({
    id: f.id,
    running_after_restart: f.running_now,
    prerequisites: f.prerequisites,
  }));

  const snippetCommand = analysisRDesired() ? oneShotArgv('webr') : dbType === 'mysql' ? oneShotArgv('mysql2') : ['npx', '-y', 'biomcp'];
  const snippetEnv = Object.fromEntries(ENV_PARAM_ROWS.filter((r) => env[r.id]).map((r) => [r.id, '<set-in-your-client>']));

  const nextSteps: string[] = [];
  for (const blocker of blockers) {
    if (blocker.fix_command) nextSteps.push(`Fix: ${blocker.fix_command}`);
    if (blocker.fix_note) nextSteps.push(`Then: ${blocker.fix_note}`);
  }
  if (blockers.length === 0) {
    nextSteps.push('Restart the MCP client (or start a new session) so configuration changes load at server startup.');
    nextSteps.push('In the client, call biomcp_configure with {} and confirm features.<id>.running_now === true.');
  }
  for (const s of clientSnippets(snippetCommand, snippetEnv, client)) {
    nextSteps.push(`${s.label}:\n${s.snippet}`);
  }

  return {
    schema_version: 1,
    ok: blockers.length === 0,
    node: { version: process.versions.node, required: `>=${REQUIRED_NODE.major}.${REQUIRED_NODE.minor}`, ok: nodeOk },
    server_context: context,
    mode_advice: modeAdvice(context.install_mode),
    invocation: {
      argv: process.argv.slice(1),
      note: 'This report reflects THIS invocation, not your MCP client\'s. To diagnose the client, run doctor exactly as the client launches the server — same command array, same env block (e.g. ANALYSIS_R=1 npx -y -p biomcp@<minor> -p webr@0.6 biomcp doctor).',
    },
    startup: {
      config_path: startup.path,
      file_present: startup.filePresent,
      ignored_reason: startup.ignoredReason ?? null,
      kill_switch: startup.killSwitchActive,
      applied_keys: startup.appliedKeys,
    },
    features: featureRows,
    env_masked: ENV_PARAM_ROWS.map((r) => ({ id: r.id, present: Boolean(env[r.id]) })),
    blockers,
    warnings,
    next_steps: nextSteps,
  };
}

function analysisRDesired(): boolean {
  return Boolean(process.env['ANALYSIS_R']?.trim());
}

function modeAdvice(mode: string): string | null {
  switch (mode) {
    case 'npx-cache':
      return 'npx-cache mode: peer deps (webr/mysql2) are ONLY visible via the -p one-shot client command or an absolute node path — bare ["npx","biomcp"] will never see them.';
    case 'local-tree':
      return 'local-tree mode: peer deps resolve from this tree\'s node_modules. Point the client at the ABSOLUTE path: node <bundle_path>. Clients control the server cwd — "cd into the tree" never reaches the server.';
    case 'from-source':
      return 'from-source mode: peer deps resolve from this checkout\'s node_modules.';
    default:
      return null;
  }
}

export function formatDoctorText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`biomcp doctor — ${report.ok ? 'OK' : `${report.blockers.length} blocker(s)`}`);
  lines.push(`node: ${report.node.version} (required ${report.node.required}) ${report.node.ok ? '✓' : '✗'}`);
  lines.push(`install mode: ${report.server_context.install_mode} (${report.server_context.bundle_path})`);
  if (report.mode_advice) lines.push(`mode: ${report.mode_advice}`);
  lines.push(`config: ${report.startup.config_path} ${report.startup.file_present ? (report.startup.ignored_reason ? '(ignored)' : '(loaded)') : '(absent)'}`);
  for (const f of report.features) {
    const deps = f.prerequisites.map((d) => `${d['dependency']}:${d['status']}`).join(', ');
    lines.push(`feature ${f.id}: ${f.running_after_restart ? 'ON' : 'off'}${deps ? ` [${deps}]` : ''}`);
  }
  for (const w of report.warnings) lines.push(`warning [${w.code}] ${w.message}`);
  for (const b of report.blockers) {
    lines.push(`blocker [${b.code}] ${b.message}`);
    if (b.fix_command) lines.push(`  fix: ${b.fix_command}`);
    if (b.fix_note) lines.push(`  note: ${b.fix_note}`);
  }
  lines.push('');
  for (const step of report.next_steps) lines.push(`→ ${step}`);
  return lines.join('\n');
}

export function exitCodeFor(report: DoctorReport): 0 | 1 {
  return report.blockers.length > 0 ? 1 : 0;
}
