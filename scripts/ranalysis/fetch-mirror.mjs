#!/usr/bin/env node
// Build the r-wasm-mirror bundle: resolve the dependency closure of the
// analysis packages against the r-universe wasm repos, download binaries,
// self-build locfit via docker when needed, regenerate PACKAGES indexes,
// and emit manifest.json + NOTICE.
//
// Usage: fetch-mirror.mjs --out <dir> [--packages a,b,c] [--locfit-tgz <path>]
//                         [--skip-locfit-build] [--bundle <tarball-path>]
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, existsSync, statSync, readFileSync, copyFileSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sh = (cmd) => {
  const r = spawnSync(cmd, { shell: '/bin/bash', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return (r.stdout ?? '').trim();
};

function parseArgs() {
  const args = { packages: 'DESeq2,edgeR,limma,jsonlite' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--packages') args.packages = argv[++i];
    else if (argv[i] === '--locfit-tgz') args.locfitTgz = argv[++i];
    else if (argv[i] === '--skip-locfit-build') args.skipLocfitBuild = true;
    else if (argv[i] === '--bundle') args.bundle = argv[++i];
  }
  if (!args.out) throw new Error('--out <dir> is required');
  return args;
}

const SOURCES = {
  bioc: 'https://bioc.r-universe.dev/bin/emscripten/contrib/4.6',
  cran: 'https://cran.r-universe.dev/bin/emscripten/contrib/4.6',
};
const CRAN_SRC = 'https://cran.r-project.org/src/contrib';
const BIOC_SRC = 'https://code.bioconductor.org/browse';

function parseDCF(text) {
  const db = {};
  for (const block of text.split(/\n\n+/)) {
    const fields = {};
    let cur = null;
    for (const line of block.split('\n')) {
      if (/^[A-Za-z][A-Za-z0-9.@_-]*:/.test(line)) {
        cur = line.split(':')[0];
        fields[cur] = [line.slice(cur.length + 1).trim()];
      } else if (/^[ \t]/.test(line) && cur) {
        fields[cur].push(line.trim());
      }
    }
    if (!fields.Package) continue;
    const deps = ['Depends', 'Imports', 'LinkingTo']
      .flatMap((k) => fields[k] ?? [])
      .join(',')
      .split(',')
      .map((s) => s.trim().split(/\s*\(/)[0].trim())
      .filter((s) => s && s !== 'R');
    db[fields.Package[0]] = {
      Version: fields.Version?.[0],
      License: fields.License?.[0] ?? 'UNKNOWN',
      Deps: [...new Set(deps)],
    };
  }
  return db;
}

function closureOf(roots, dbs) {
  const closure = [];
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const src = dbs.bioc[p] ? 'bioc' : dbs.cran[p] ? 'cran' : p === 'locfit' ? 'self-built' : null;
    if (!src) {
      log(`  [skip] ${p} (not indexed; base package)`);
      continue;
    }
    closure.push({ pkg: p, version: p === 'locfit' ? '1.5-9.12' : dbs[src][p].Version, src });
    if (src !== 'self-built') queue.push(...dbs[src][p].Deps);
  }
  return closure;
}

function sha256File(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

function walkFiles(dir) {
  const out = [];
  for (const name of sh(`find ${JSON.stringify(dir)} -type f`).split('\n')) {
    if (name) out.push(name);
  }
  return out;
}

const args = parseArgs();
const roots = args.packages.split(',').map((s) => s.trim());
const repoDir = join(args.out, 'repo');
const contribDir = join(repoDir, 'bin', 'emscripten', 'contrib', '4.6');
mkdirSync(contribDir, { recursive: true });

log('fetching repository indexes...');
const dbs = {};
for (const [name, base] of Object.entries(SOURCES)) {
  const idx = sh(`curl -sL --retry 3 --max-time 300 ${JSON.stringify(base + '/PACKAGES')}`);
  if (!idx.includes('Package:')) throw new Error(`failed to fetch ${name} PACKAGES index`);
  dbs[name] = parseDCF(idx);
  log(`  ${name}: ${Object.keys(dbs[name]).length} packages`);
}

const closure = closureOf(roots, dbs);
log(`closure: ${closure.length} packages -> ${closure.map((c) => c.pkg).join(', ')}`);

if (!closure.some((c) => c.pkg === 'locfit')) throw new Error('closure unexpectedly missing locfit');

const locfitTgz = join(contribDir, 'locfit_1.5-9.12.tgz');
if (!existsSync(locfitTgz)) {
  if (args.locfitTgz) {
    copyFileSync(args.locfitTgz, locfitTgz);
    log(`copied locfit from ${args.locfitTgz}`);
  } else if (!args.skipLocfitBuild) {
    log('building locfit via docker (rwasm)...');
    const r = spawnSync('bash', [join(process.cwd(), 'scripts', 'ranalysis', 'build-locfit.sh'), contribDir], {
      stdio: 'inherit',
    });
    if (r.status !== 0 || !existsSync(locfitTgz)) throw new Error('locfit docker build failed');
  } else {
    throw new Error('locfit binary missing; provide --locfit-tgz or drop --skip-locfit-build');
  }
}

const licenses = {};
let total = 0;
for (const { pkg, version, src } of closure) {
  if (pkg === 'locfit') {
    licenses[pkg] = { version, license: 'GPL (>= 2)', source: `${CRAN_SRC}/locfit_${version}.tar.gz` };
    total += statSync(locfitTgz).size;
    continue;
  }
  const base = SOURCES[src];
  const f = join(contribDir, `${pkg}_${version}.tgz`);
  if (!existsSync(f) || statSync(f).size < 2000) {
    sh(`curl -sL --retry 3 --retry-all-errors --speed-limit 1000 --speed-time 30 --max-time 300 ${JSON.stringify(`${base}/${pkg}_${version}.tgz`)} -o ${JSON.stringify(f)}`);
  }
  const sz = statSync(f).size;
  if (sz < 2000) throw new Error(`download failed for ${pkg}_${version} (${sz} bytes)`);
  total += sz;
  const code = sh(`curl -sL -o /dev/null -w "%{http_code}" -r 0-0 --max-time 20 ${JSON.stringify(`${base}/${pkg}_${version}.data`)}`);
  if (code === '200' || code === '206') {
    const dataPath = join(contribDir, `${pkg}_${version}.data`);
    sh(`curl -sL --retry 3 --max-time 300 ${JSON.stringify(`${base}/${pkg}_${version}.data`)} -o ${JSON.stringify(dataPath)}`);
  }
  licenses[pkg] = {
    version,
    license: dbs[src][pkg].License,
    source: src === 'bioc' ? `${BIOC_SRC}/html/${pkg}.html` : `${CRAN_SRC}/${pkg}_${version}.tar.gz`,
  };
  log(`  ok ${pkg}_${version} (${(sz / 1024).toFixed(0)} KB)`);
}
log(`downloaded ${closure.length} packages, ${(total / 1e6).toFixed(1)} MB`);

log('regenerating PACKAGES indexes...');
const keep = ['Package', 'Version', 'Depends', 'Imports', 'LinkingTo'];
let dcf = '';
for (const { pkg, version } of closure) {
  const desc = sh(`tar -xzOf ${JSON.stringify(join(contribDir, `${pkg}_${version}.tgz`))} ${JSON.stringify(`${pkg}/DESCRIPTION`)}`);
  if (!desc.trim()) throw new Error(`no DESCRIPTION in ${pkg} tgz`);
  const fields = {};
  let cur = null;
  for (const line of desc.split('\n')) {
    if (/^[A-Za-z][A-Za-z0-9.@_-]*:/.test(line)) {
      cur = line.split(':')[0];
      fields[cur] = [line.slice(cur.length + 1).trim()];
    } else if (/^[ \t]/.test(line) && cur) {
      fields[cur].push(line.trim());
    }
  }
  if (fields.Package?.[0] !== pkg) throw new Error(`DESCRIPTION/expected package mismatch for ${pkg}`);
  for (const k of keep) if (fields[k]?.length) dcf += `${k}: ${fields[k].join(' ')}\n`;
  dcf += '\n';
}
writeFileSync(join(contribDir, 'PACKAGES'), dcf);
spawnSync('gzip', ['-kf', join(contribDir, 'PACKAGES')]);
log(`PACKAGES written (${closure.length} entries)`);

log('generating PACKAGES.rds via webR...');
const rdsScript = `
db <- read.dcf('/packages.dcf')
db <- db[, intersect(c('Package','Version','Depends','Imports','LinkingTo'), colnames(db)), drop = FALSE]
rownames(db) <- db[, 'Package']
saveRDS(db, '/packages.rds')
paste('RDS_OK', nrow(db))
`;
{
  const { WebR } = await import('webr');
  const webR = new WebR();
  await webR.init();
  webR.FS.writeFile('/packages.dcf', new TextEncoder().encode(dcf));
  const res = await webR.evalR(rdsScript).then((r) => r.toString());
  if (!res.includes('RDS_OK')) throw new Error(`PACKAGES.rds generation failed: ${res}`);
  const rds = await webR.FS.readFile('/packages.rds');
  writeFileSync(join(contribDir, 'PACKAGES.rds'), Buffer.from(rds));
  await webR.close();
  log(`PACKAGES.rds written (${Buffer.from(rds).length} bytes)`);
}

log('writing manifest.json and NOTICE...');
const files = walkFiles(repoDir).map((f) => ({ name: relative(repoDir, f), sha256: sha256File(f) }));
const manifest = {
  created: new Date().toISOString(),
  r_version: '4.6.0',
  packages: Object.fromEntries(Object.entries(licenses).map(([p, m]) => [p, m.version])),
  licenses,
  files,
};
writeFileSync(join(repoDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const noticeLines = [
  '# NOTICE — r-wasm-mirror bundle',
  '',
  `Created: ${manifest.created}`,
  'Runtime: R 4.6.0 compiled to WebAssembly (webR, MIT). R itself is GPL-3: https://www.r-project.org/COPYING',
  '',
  'This bundle is a mere aggregate of independently licensed WebAssembly R package',
  'binaries (analogous to a CRAN mirror). Each package remains under its own license.',
  'Corresponding sources (devel-track, as built by r-universe) are available at the listed URLs.',
  'Common license texts:',
  'https://www.gnu.org/licenses/ , https://www.r-project.org/Licenses/GPL-2,',
  'https://www.r-project.org/Licenses/LGPL-3, https://artistic-license.rtfd.org,',
  'https://opensource.org/licenses/MIT, https://opensource.org/licenses/BSD-3-Clause.',
  '',
  'locfit was cross-compiled for WebAssembly with the rwasm container because no',
  'public wasm build exists; build script: scripts/ranalysis/build-locfit.sh.',
  '',
  '| Package | Version | License | Source |',
  '|---------|---------|---------|--------|',
];
for (const [pkg, m] of Object.entries(licenses).sort(([a], [b]) => a.localeCompare(b))) {
  noticeLines.push(`| ${pkg} | ${m.version} | ${m.license} | ${m.source} |`);
}
writeFileSync(join(repoDir, 'NOTICE'), noticeLines.join('\n') + '\n');

if (args.bundle) {
  log(`bundling ${args.bundle}...`);
  spawnSync('tar', ['-czf', args.bundle, '-C', repoDir, '.'], { stdio: 'inherit' });
  log(`bundle: ${(statSync(args.bundle).size / 1e6).toFixed(1)} MB, sha256 ${sha256File(args.bundle)}`);
}
log('done.');
