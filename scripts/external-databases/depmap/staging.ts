import { createReadStream, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ReleaseFiles } from './manifest.js';

export type StagedStatus = 'ok' | 'missing' | 'mismatch';

export interface StagedFile {
  filename: string;
  expectedMd5: string;
  status: StagedStatus;
  sizeBytes: number | null;
}

export interface ExpectedFile {
  filename: string;
  md5: string;
}

export async function md5File(path: string): Promise<string> {
  const hash = createHash('md5');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function verifyStaged(rawDir: string, expected: ExpectedFile[]): Promise<StagedFile[]> {
  const { statSync } = await import('node:fs');
  const results: StagedFile[] = [];
  for (const file of expected) {
    const path = join(rawDir, file.filename);
    let size: number | null = null;
    try {
      size = statSync(path).size;
    } catch {
      results.push({ filename: file.filename, expectedMd5: file.md5, status: 'missing', sizeBytes: null });
      continue;
    }
    const actual = await md5File(path);
    results.push({
      filename: file.filename,
      expectedMd5: file.md5,
      status: actual === file.md5 ? 'ok' : 'mismatch',
      sizeBytes: size,
    });
  }
  return results;
}

export function ensureRawDir(rawDir: string): void {
  mkdirSync(rawDir, { recursive: true });
}

const PORTAL_URL = 'https://depmap.org/portal/data_page/';

export function stagingPlan(release: ReleaseFiles, staged: StagedFile[], rawDir: string): string {
  const missing = staged.filter(s => s.status === 'missing');
  const mismatch = staged.filter(s => s.status === 'mismatch');
  const lines: string[] = [];
  lines.push(`Release ${release.name}${release.date ? ` (${release.date})` : ''} has no direct download URLs —`);
  lines.push('files must be staged manually from the DepMap portal (one-time, per release):');
  lines.push('');
  lines.push(`  1. Open ${PORTAL_URL} in a browser and select the "Current Release" tab.`);
  lines.push('  2. Download the file(s) listed below.');
  lines.push(`  3. Save them into: ${rawDir}`);
  lines.push(`     (mkdir -p "${rawDir}")`);
  lines.push('  4. Re-run this command.');
  lines.push('');
  const entries = missing.length > 0 ? missing : mismatch;
  for (const entry of entries) {
    const label = entry.status === 'missing' ? 'MISSING' : 'MD5 MISMATCH (re-download)';
    lines.push(`  [${label}] ${entry.filename}  (expected md5 ${entry.expectedMd5})`);
  }
  if (mismatch.length > 0 && missing.length === 0) {
    lines.push('');
    lines.push('Md5 mismatches mean the staged file differs from the official release — replace it.');
  }
  return lines.join('\n');
}

export function statusTable(staged: StagedFile[]): string {
  const lines = staged.map(s => {
    const size = s.sizeBytes === null ? '' : `  (${(s.sizeBytes / 1024 / 1024).toFixed(1)} MB)`;
    return `  ${s.status.padEnd(8)} ${s.filename}${size}`;
  });
  return lines.join('\n');
}
