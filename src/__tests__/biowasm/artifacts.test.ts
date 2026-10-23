import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactCount, biowasmArtifactsDir, listArtifacts, MAX_ARTIFACTS, registerArtifact, resolveArtifact } from '../../biowasm/artifacts.js';
import type { ArtifactRecord } from '../../biowasm/artifacts.js';

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
    // Flake-tail conversion (#187 rule 2; two dated hits 2026-10-20). The
    // original form registered all MAX_ARTIFACTS+5 artifacts through
    // registerArtifact — each call re-reads and rewrites the entire
    // index.json (O(n^2) sync FS churn) and orders eviction by wall-clock
    // createdAt stamped inside the loop, so a WSL2 guest-clock backward
    // jump mid-loop inverted the victim order. Deterministic form: seed the
    // index DIRECTLY (on-disk shape pinned by the round-trip test above;
    // isRecord() requires string id, string hostPath, number size) with
    // MAX_ARTIFACTS records carrying explicit past-anchored, strictly
    // increasing createdAt strings, then register only the 5 extras.
    //
    // Menu correction vs the #187 tracker: enforceCap orders on the
    // PERSISTED createdAt string, not file mtime (mtime only feeds
    // purgeArtifactsOlderThan, determinized in purge.test.ts via
    // utimesSync) — so seeded timestamps, not fs.utimes, are the right
    // determinizer for this class. The 5 live registrations keep their
    // wall-clock createdAt per the #185 rule (persisted values stay
    // wall-clock); they only need to be NEWER than the 2020-anchored
    // seeds, which holds by years.
    const SEED_EPOCH_MS = Date.parse('2020-01-01T00:00:00.000Z');
    const dir = biowasmArtifactsDir();
    mkdirSync(dir, { recursive: true });

    const paths: string[] = [];
    const seedRecords: ArtifactRecord[] = [];
    for (let i = 0; i < MAX_ARTIFACTS + 5; i++) {
      const hostPath = writeArtifactFile(`art-${String(i).padStart(3, '0')}.bam`);
      paths.push(hostPath);
      if (i < MAX_ARTIFACTS) {
        seedRecords.push({
          id: `seed-${String(i).padStart(3, '0')}`,
          hostPath,
          size: 1,
          sha256: null,
          tool: 'samtools',
          createdAt: new Date(SEED_EPOCH_MS + i * 1000).toISOString(),
          description: `art-${i}`,
        });
      }
    }
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ artifacts: seedRecords }, null, 2));
    expect(artifactCount()).toBe(MAX_ARTIFACTS);

    // Register the last 5 sequentially, exactly like the original: each
    // pushes the index past the cap, so each call evicts exactly one
    // victim — the 5 oldest seeds (art-0..art-4) across the 5 calls.
    for (let i = MAX_ARTIFACTS; i < MAX_ARTIFACTS + 5; i++) {
      registerArtifact({ hostPath: paths[i], size: 1, sha256: null, tool: 'samtools', description: `art-${i}` });
    }

    expect(artifactCount()).toBe(MAX_ARTIFACTS);
    const descriptions = listArtifacts().map((r) => r.description);
    for (let i = 0; i < 5; i++) {
      expect(descriptions).not.toContain(`art-${i}`);
    }
    expect(descriptions).toContain('art-5'); // oldest survivor boundary
    expect(descriptions).toContain(`art-${MAX_ARTIFACTS + 4}`); // newest retained
    for (let i = 0; i < 5; i++) {
      expect(existsSync(paths[i])).toBe(false); // LRU-deleted from disk
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
