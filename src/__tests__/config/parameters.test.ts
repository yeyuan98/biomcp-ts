import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIOMCP_NPM_PIN, PEER_NPM_PINS, oneShotArgv, oneShotCommand, FEATURE_GROUPS } from '../../config/parameters.js';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
};

function expectedPin(range: string, pkgName: string): string {
  // caret ranges float within the major -> pin the major only ("mysql2@3");
  // bounded ranges (">=0.6.0 <0.7") -> pin the lower-bound minor ("webr@0.6")
  const caret = range.match(/^\^(\d+)\./);
  if (caret) return `${pkgName}@${caret[1]}`;
  const bounded = range.match(/>=?(\d+)\.(\d+)/);
  if (bounded) return `${pkgName}@${bounded[1]}.${bounded[2]}`;
  throw new Error(`cannot derive pin from range: ${range}`);
}

describe('npm pin rendering (single source of truth)', () => {
  it('BIOMCP_NPM_PIN tracks the package version (major.minor)', () => {
    const [major, minor] = pkg.version.split('.');
    expect(BIOMCP_NPM_PIN).toBe(`biomcp@${major}.${minor}`);
  });

  it('peer pins track the package.json peerDependencies ranges', () => {
    expect(PEER_NPM_PINS.webr).toBe(expectedPin(pkg.peerDependencies.webr, 'webr'));
    expect(PEER_NPM_PINS.mysql2).toBe(expectedPin(pkg.peerDependencies.mysql2, 'mysql2'));
  });

  it('oneShotArgv is plain argv (no shell) with the package positional last', () => {
    expect(oneShotArgv()).toEqual(['npx', '-y', '-p', BIOMCP_NPM_PIN, 'biomcp']);
    expect(oneShotArgv('webr')).toEqual(['npx', '-y', '-p', BIOMCP_NPM_PIN, '-p', PEER_NPM_PINS.webr, 'biomcp']);
    expect(oneShotCommand('mysql2')).toBe(oneShotArgv('mysql2').join(' '));
  });

  it('peerDeps commands lead with the one-shot and contain no #-prefixed entries (configure.ts filters those out of agent_steps)', () => {
    for (const group of FEATURE_GROUPS) {
      for (const dep of group.peerDeps) {
        expect(dep.commands.length).toBeGreaterThan(0);
        expect(dep.commands[0]).toBe(oneShotCommand(dep.package as 'webr' | 'mysql2'));
        for (const c of dep.commands) expect(c.startsWith('#')).toBe(false);
      }
    }
  });
});
