import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  mkdirSync(biowasmArtifactsDir(), { recursive: true });
  writeFileSync(indexFilePath(), JSON.stringify({ artifacts: records }, null, 2));
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
