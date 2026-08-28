#!/usr/bin/env node
// scripts/biowasm/pin-assets.mjs
// Downloads the pinned biowasm tool set from the CDN, validates each file
// (wasm compiles, js glue parses, .data size matches the glue's embedded
// remote_package_size), and prints the PINNED_SHA256 literal for a developer
// to paste into src/biowasm/registry.ts.
//
// Network on this machine occasionally corrupts large transfers, so every file
// is downloaded with retries and full validation before hashing.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDN = 'https://biowasm.com/cdn/v3';
const TOOLS = {
  samtools: { version: '1.21', files: ['samtools.js', 'samtools.wasm', 'samtools.data'] },
  bedtools: { version: '2.31.0', files: ['bedtools.js', 'bedtools.wasm', 'bedtools.data'] },
  bcftools: { version: '1.10', files: ['bcftools.js', 'bcftools.wasm', 'bcftools.data'] },
};
const FETCH_ATTEMPTS = 5;
const FETCH_TIMEOUT_MS = 120_000;

async function fetchWithRetries(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'biomcp-pin-assets' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('empty response body');
      return buf;
    } catch (err) {
      lastError = err;
      process.stderr.write(`  attempt ${attempt}/${FETCH_ATTEMPTS} failed for ${url}: ${String(err.message ?? err)}\n`);
    }
  }
  throw new Error(`download failed after ${FETCH_ATTEMPTS} attempts: ${url} (${String(lastError?.message ?? lastError)})`);
}

function parseRemotePackageSize(js) {
  const m = js.match(/remote_package_size"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

async function validate(tool, file, buf, glueSize) {
  if (buf.length === 0) throw new Error(`${tool}/${file}: empty file`);
  if (file.endsWith('.wasm')) {
    await WebAssembly.compile(buf);
  } else if (file.endsWith('.js')) {
    const text = buf.toString('utf8');
    if (!/loadPackage|Module/.test(text)) throw new Error(`${tool}/${file}: js glue missing loadPackage/Module markers`);
    const size = parseRemotePackageSize(text);
    if (size === null) throw new Error(`${tool}/${file}: cannot parse remote_package_size from glue`);
    glueSize[`${tool}.data`] = size;
  } else if (file.endsWith('.data')) {
    const expected = glueSize[`${tool}.data`];
    if (expected === undefined) throw new Error(`${tool}/${file}: downloaded .data before its .js glue`);
    if (buf.length !== expected) {
      throw new Error(`${tool}/${file}: size ${buf.length} != remote_package_size ${expected} from glue (corrupt transfer)`);
    }
  }
}

const work = join(tmpdir(), `biowasm-pin-${Date.now()}`);
mkdirSync(work, { recursive: true });
const hashes = {};
try {
  for (const [tool, spec] of Object.entries(TOOLS)) {
    const glueSize = {};
    for (const file of spec.files) {
      process.stdout.write(`downloading ${tool} ${spec.version} ${file} ... `);
      const buf = await fetchWithRetries(`${CDN}/${tool}/${spec.version}/${file}`);
      await validate(tool, file, buf, glueSize);
      hashes[file] = createHash('sha256').update(buf).digest('hex');
      writeFileSync(join(work, file), buf);
      process.stdout.write(`ok (${buf.length} bytes)\n`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const width = Object.keys(hashes).sort().reduce((w, k) => Math.max(w, k.length), 0);
console.log('\nPaste into src/biowasm/registry.ts:\n');
console.log('export const PINNED_SHA256: Record<string, string> = {');
for (const key of Object.keys(hashes).sort()) {
  console.log(`  ${key.padEnd(width)}: '${hashes[key]}',`);
}
console.log('};');
