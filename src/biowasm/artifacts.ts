import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { cacheDir } from '../wasmcore/assets.js';

export const MAX_ARTIFACTS = 200;
const INDEX_FILE = 'index.json';

export interface ArtifactRecord {
  id: string;
  hostPath: string;
  size: number;
  sha256: string | null;
  tool: string;
  createdAt: string;
  description: string;
}

export interface ArtifactRegistration {
  hostPath: string;
  size: number;
  sha256: string | null;
  tool: string;
  description: string;
}

export function biowasmArtifactsDir(): string {
  return join(cacheDir(), 'biowasm-artifacts');
}

function indexFilePath(): string {
  return join(biowasmArtifactsDir(), INDEX_FILE);
}

function isRecord(v: unknown): v is ArtifactRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.hostPath === 'string' && typeof r.size === 'number';
}

function readIndex(): ArtifactRecord[] {
  try {
    const raw = JSON.parse(readFileSync(indexFilePath(), 'utf8')) as { artifacts?: unknown };
    return Array.isArray(raw?.artifacts) ? raw.artifacts.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function writeIndex(records: ArtifactRecord[]): void {
  const dir = biowasmArtifactsDir();
  mkdirSync(dir, { recursive: true });
  const target = indexFilePath();
  const tmp = join(dir, `.${INDEX_FILE}.tmp.${process.pid}.${Date.now()}`);
  writeFileSync(tmp, JSON.stringify({ artifacts: records }, null, 2));
  renameSync(tmp, target);
}

let idSeq = 0;

function nextId(): string {
  idSeq = (idSeq + 1) % 1679616;
  return `bw${Date.now().toString(36)}${idSeq.toString(36).padStart(4, '0')}`;
}

function enforceCap(records: ArtifactRecord[]): void {
  if (records.length <= MAX_ARTIFACTS) return;
  const excess = records.length - MAX_ARTIFACTS;
  const ordered = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const victim of ordered.slice(0, excess)) {
    try {
      rmSync(victim.hostPath, { force: true });
    } catch {
      void 0;
    }
    records.splice(records.indexOf(victim), 1);
  }
}

export function registerArtifact(registration: ArtifactRegistration): ArtifactRecord {
  const dir = resolve(biowasmArtifactsDir());
  const resolvedPath = resolve(registration.hostPath);
  if (!resolvedPath.startsWith(dir + sep)) {
    throw new Error(`Artifact path escapes biowasm artifacts directory: ${resolvedPath}`);
  }

  const records = readIndex().filter((r) => r.hostPath !== registration.hostPath);
  const record: ArtifactRecord = { id: nextId(), createdAt: new Date().toISOString(), ...registration };
  records.push(record);
  enforceCap(records);
  writeIndex(records);
  return record;
}

export function resolveArtifact(id: string): ArtifactRecord | null {
  const hit = readIndex().find((r) => r.id === id);
  if (!hit || !existsSync(hit.hostPath)) return null;
  return hit;
}

export function listArtifacts(): ArtifactRecord[] {
  return readIndex();
}

export function artifactCount(): number {
  return readIndex().length;
}

export interface PurgeResult {
  purgedCount: number;
  reclaimedBytes: number;
}

/**
 * Purges biowasm artifacts older than `maxAgeMs` (default 24 hours).
 *
 * Safety measures:
 * - Unindexed files in `biowasmArtifactsDir` with mtime < 1 hour are preserved
 *   to avoid deleting files actively being written by in-flight workers.
 * - `index.json` and hidden/temporary files are never deleted.
 * - Index is written atomically via temporary file and rename.
 */
export function purgeArtifactsOlderThan(maxAgeMs: number = 24 * 60 * 60 * 1000): PurgeResult {
  const dir = biowasmArtifactsDir();
  if (!existsSync(dir)) {
    return { purgedCount: 0, reclaimedBytes: 0 };
  }

  const now = Date.now();
  const cutoff = now - maxAgeMs;
  const inFlightGraceMs = 60 * 60 * 1000; // 1 hour grace period for active writes
  let purgedCount = 0;
  let reclaimedBytes = 0;

  const records = readIndex();
  const survivingRecords: ArtifactRecord[] = [];
  const indexedPaths = new Set<string>();

  for (const record of records) {
    const recordTime = new Date(record.createdAt).getTime();
    let fileTime = recordTime;
    let fileSize = record.size;
    let fileExisted = false;
    try {
      if (existsSync(record.hostPath)) {
        fileExisted = true;
        const stats = statSync(record.hostPath);
        fileTime = Math.max(recordTime, stats.mtimeMs);
        fileSize = stats.size;
      }
    } catch {
      // If stat fails, rely on recordTime
    }

    if (fileTime < cutoff) {
      try {
        if (fileExisted) {
          rmSync(record.hostPath, { force: true });
        }
      } catch {
        // Ignore removal error
      }
      purgedCount++;
      reclaimedBytes += fileSize;
    } else {
      survivingRecords.push(record);
      indexedPaths.add(record.hostPath);
    }
  }

  // Scan for orphaned files in the directory
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === INDEX_FILE || entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);
      if (indexedPaths.has(fullPath)) continue;

      try {
        const stats = statSync(fullPath);
        const age = now - stats.mtimeMs;
        // In-flight write protection: skip recently modified unindexed files (<1h)
        if (age < inFlightGraceMs) continue;

        if (stats.mtimeMs < cutoff) {
          rmSync(fullPath, { force: true });
          purgedCount++;
          reclaimedBytes += stats.size;
        }
      } catch {
        // Ignore stat or removal errors
      }
    }
  } catch {
    // Ignore directory read errors
  }

  writeIndex(survivingRecords);
  return { purgedCount, reclaimedBytes };
}
