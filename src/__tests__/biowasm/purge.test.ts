import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactCount,
  biowasmArtifactsDir,
  listArtifacts,
  purgeArtifactsOlderThan,
  registerArtifact,
} from '../../biowasm/artifacts.js';

const SAVED_CACHE_DIR = process.env.BIOMCP_CACHE_DIR;
const WORK = join(tmpdir(), `biomcp-biowasm-purge-${Date.now()}`);

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

describe('purgeArtifactsOlderThan', () => {
  it('purges artifacts older than 24h and preserves recent/in-flight files', () => {
    const dir = biowasmArtifactsDir();
    mkdirSync(dir, { recursive: true });

    const now = Date.now();
    const twentyFiveHoursAgoSec = Math.floor((now - 25 * 60 * 60 * 1000) / 1000);
    const tenMinutesAgoSec = Math.floor((now - 10 * 60 * 1000) / 1000);
    const twoMinutesAgoSec = Math.floor((now - 2 * 60 * 1000) / 1000);

    // 1. Old indexed artifact (25 hours old)
    const oldPath = join(dir, 'old.bam');
    writeFileSync(oldPath, 'OLD_BAM');
    utimesSync(oldPath, twentyFiveHoursAgoSec, twentyFiveHoursAgoSec);
    const oldRecord = registerArtifact({
      hostPath: oldPath,
      size: 7,
      sha256: null,
      tool: 'samtools',
      description: 'old bam',
    });
    // Manually backdate createdAt in index
    oldRecord.createdAt = new Date(twentyFiveHoursAgoSec * 1000).toISOString();
    const indexFile = join(dir, 'index.json');
    writeFileSync(indexFile, JSON.stringify({ artifacts: [oldRecord] }, null, 2));

    // 2. Recent indexed artifact (10 minutes old)
    const recentPath = join(dir, 'recent.bam');
    writeFileSync(recentPath, 'RECENT_BAM');
    utimesSync(recentPath, tenMinutesAgoSec, tenMinutesAgoSec);
    const recentRecord = registerArtifact({
      hostPath: recentPath,
      size: 10,
      sha256: null,
      tool: 'samtools',
      description: 'recent bam',
    });

    // 3. In-flight unindexed file (modified 2 minutes ago)
    const inFlightPath = join(dir, 'active-worker.tmp.bam');
    writeFileSync(inFlightPath, 'IN_FLIGHT_DATA');
    utimesSync(inFlightPath, twoMinutesAgoSec, twoMinutesAgoSec);

    // 4. Stale unindexed orphan file (modified 30 hours ago)
    const orphanPath = join(dir, 'orphan.bam');
    writeFileSync(orphanPath, 'ORPHAN_DATA');
    const thirtyHoursAgoSec = Math.floor((now - 30 * 60 * 60 * 1000) / 1000);
    utimesSync(orphanPath, thirtyHoursAgoSec, thirtyHoursAgoSec);

    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(recentPath)).toBe(true);
    expect(existsSync(inFlightPath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(true);

    // Run 24h purge
    const result = purgeArtifactsOlderThan(24 * 60 * 60 * 1000);

    expect(result.purgedCount).toBe(2); // old indexed + old orphan
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(orphanPath)).toBe(false);

    // Recent indexed must survive
    expect(existsSync(recentPath)).toBe(true);
    // In-flight active file (< 1h) must survive!
    expect(existsSync(inFlightPath)).toBe(true);

    // Index must only contain recent artifact
    expect(artifactCount()).toBe(1);
    const surviving = listArtifacts();
    expect(surviving[0].id).toBe(recentRecord.id);
  });
});
