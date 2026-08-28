import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactCount, biowasmArtifactsDir, listArtifacts, MAX_ARTIFACTS, registerArtifact, resolveArtifact } from '../../biowasm/artifacts.js';

const SAVED_CACHE_DIR = process.env.BIOMCP_CACHE_DIR;
const WORK = join(tmpdir(), `biomcp-biowasm-artifacts-${Date.now()}`);

beforeEach(() => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  process.env.BIOMCP_CACHE_DIR = WORK;
});

afterEach(() => {
  if (SAVED_CACHE_DIR === undefined) delete process.env.BIOMCP_CACHE_DIR;
  else process.env.BIOMCP_CACHE_DIR = SAVED_CACHE_DIR;
  rmSync(WORK, { recursive: true, force: true });
});

function writeArtifactFile(name: string, bytes = 'x'): string {
  const dir = biowasmArtifactsDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe('biowasm artifact registry', () => {
  it('round-trips records through the persisted index', () => {
    const hostPath = writeArtifactFile('a.bam', 'BAM');
    const record = registerArtifact({ hostPath, size: 3, sha256: 'deadbeef', tool: 'samtools', description: 'convert SAM -> BAM' });
    expect(record.id).toMatch(/^bw/);
    expect(record.createdAt).toBeTruthy();

    const resolved = resolveArtifact(record.id);
    expect(resolved).toEqual(record);

    const indexFile = join(biowasmArtifactsDir(), 'index.json');
    expect(existsSync(indexFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(indexFile, 'utf8')) as { artifacts: unknown[] };
    expect(persisted.artifacts).toHaveLength(1);
    expect(artifactCount()).toBe(1);
    expect(listArtifacts()).toEqual([record]);
  });

  it('returns null for unknown or vanished artifacts', () => {
    expect(resolveArtifact('nope')).toBeNull();
    const hostPath = writeArtifactFile('gone.bam');
    const record = registerArtifact({ hostPath, size: 1, sha256: null, tool: 'samtools', description: 'x' });
    rmSync(hostPath);
    expect(resolveArtifact(record.id)).toBeNull();
  });

  it('caps the index at MAX_ARTIFACTS and LRU-deletes the oldest files', () => {
    const paths: string[] = [];
    for (let i = 0; i < MAX_ARTIFACTS + 5; i++) {
      const hostPath = writeArtifactFile(`art-${String(i).padStart(3, '0')}.bam`);
      paths.push(hostPath);
      registerArtifact({ hostPath, size: 1, sha256: null, tool: 'samtools', description: `art-${i}` });
    }
    expect(artifactCount()).toBe(MAX_ARTIFACTS);
    const descriptions = listArtifacts().map((r) => r.description);
    expect(descriptions).not.toContain('art-0');
    expect(descriptions).not.toContain('art-4');
    expect(descriptions).toContain(`art-${MAX_ARTIFACTS + 4}`);
    for (let i = 0; i < 5; i++) {
      expect(existsSync(paths[i])).toBe(false);
    }
    for (let i = 5; i < MAX_ARTIFACTS + 5; i++) {
      expect(existsSync(paths[i])).toBe(true);
    }
  });

  it('replaces an existing entry for the same host path', () => {
    const hostPath = writeArtifactFile('once.bam');
    registerArtifact({ hostPath, size: 1, sha256: null, tool: 'samtools', description: 'first' });
    const second = registerArtifact({ hostPath, size: 2, sha256: null, tool: 'bcftools', description: 'second' });
    expect(artifactCount()).toBe(1);
    expect(resolveArtifact(second.id)?.description).toBe('second');
  });
});
