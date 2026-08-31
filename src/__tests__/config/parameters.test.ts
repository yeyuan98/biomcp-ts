import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIOMCP_NPM_PIN, PEER_NPM_PINS, oneShotArgv, oneShotCommand, FEATURE_GROUPS } from '../../config/parameters.js';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
  mcpName?: string;
};

const serverJson = JSON.parse(readFileSync(join(process.cwd(), 'server.json'), 'utf8')) as {
  name: string;
  description: string;
  version: string;
  packages: { version: string }[];
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

describe('release drift guards (version-bearing files must move together)', () => {
  const [major, minor] = pkg.version.split('.');
  const minorPin = `${major}.${minor}`;

  it('server.json versions match package.json (both fields)', () => {
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.packages[0].version).toBe(pkg.version);
  });

  it('package.json mcpName matches server.json name (MCP Registry package validation)', () => {
    expect(pkg.mcpName).toBe(serverJson.name);
    expect(pkg.mcpName).toMatch(/^io\.github\.[^/]+\//);
  });

  it('server.json description stays within the registry schema cap (maxLength 100)', () => {
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
  });

  it('doc pins biomcp@<major.minor> match the package version (and no 3-segment pins exist)', () => {
    // scoped to exactly the four docs carrying client snippets; CHANGELOG.md and
    // src/ are intentionally excluded (historical versions / runtime rendering)
    const docs = ['README.md', 'docs/AGENT-INSTALL.md', 'docs/R-ANALYSIS.md', 'docs/DATABASE.md'];
    for (const doc of docs) {
      const text = readFileSync(join(process.cwd(), doc), 'utf8');
      const pins = [...text.matchAll(/biomcp@\d+\.\d+/g)].map((m) => m[0]);
      expect(pins.length).toBeGreaterThan(0);
      for (const pin of pins) expect(pin).toBe(`biomcp@${minorPin}`);
      // a 3-segment pin (biomcp@0.9.0) would silently freeze patches — forbid it
      expect(text.match(/biomcp@\d+\.\d+\.\d+/)).toBeNull();
    }
  });
});
