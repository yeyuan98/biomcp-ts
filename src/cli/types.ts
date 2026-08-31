/**
 * Shared types for the `biomcp` CLI (src/cli). The CLI is a standalone module:
 * it never starts the MCP server and imports only config-facing modules.
 */

export type DoctorBlockerCode =
  | 'NODE_TOO_OLD'
  | 'CONFIG_FILE_IGNORED'
  | 'PEER_DEP_MISSING'
  | 'DB_CONFIG_INCOMPLETE'
  | 'CONFIG_CONFLICT';

export interface DoctorBlocker {
  code: DoctorBlockerCode;
  feature?: string;
  dependency?: string;
  message: string;
  fix_command?: string;
  fix_note?: string;
}

export interface DoctorWarning {
  code: string;
  message: string;
}

export interface DoctorReport {
  schema_version: 1;
  ok: boolean;
  node: { version: string; required: string; ok: boolean };
  server_context: { install_mode: string; bundle_path: string; cwd: string };
  /** install-mode-specific advice, rendered per report (null when unknown mode). */
  mode_advice: string | null;
  invocation: { argv: string[]; note: string };
  startup: {
    config_path: string;
    file_present: boolean;
    ignored_reason: string | null;
    kill_switch: boolean;
    applied_keys: string[];
  };
  features: {
    id: string;
    running_after_restart: boolean;
    prerequisites: Record<string, unknown>[];
  }[];
  /** Env-parameter presence only — values are never echoed. */
  env_masked: { id: string; present: boolean }[];
  blockers: DoctorBlocker[];
  warnings: DoctorWarning[];
  next_steps: string[];
}
