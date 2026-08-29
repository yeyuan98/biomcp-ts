#!/usr/bin/env node
// Publish the agent-test fixtures as ONE public Zenodo dataset and record the
// identifiers. Consumers then download keyless from
//   https://zenodo.org/records/<record_id>/files/<name>?download=1
// (see the resources.download.sh scripts and agent-test/fixtures-manifest.json).
//
// Usage:
//   node agent-test/zenodo-publish.mjs [--sandbox|--prod] [--publish] [--discard]
//       [--data-root DIR] [--verify-download] [--record <id>] [--new-version]
//       [--update-scripts] [--list]
//
// Auth: ZENODO_API (prod) / ZENODO_SANDBOX_API (rehearsal) read from ~/.env —
// scopes deposit:write + deposit:actions; sent ONLY as an Authorization:
// Bearer header, never in URLs, redacted from every error message.
//
// Integrity contract:
//   1. every fixture is sha256-verified against the pins below BEFORE upload;
//   2. every uploaded file's Zenodo-computed md5 is compared with the local
//      md5 of the exact uploaded bytes AFTER upload;
//   3. after --publish, each file is HEAD-checked keyless (content-length vs
//      pinned size) against the PUBLIC record URL;
//   4. --verify-download additionally re-downloads and re-checks sha256.
//
// Safety: default target is the SANDBOX and default action leaves a private
// DRAFT; --prod --publish is the deliberate, irreversible human step. The
// committed fixtures-manifest.json is written only on a successful prod
// publish (sandbox ids are wipeable and must never back the mirror).
//
// Self-contained (node:stdlib + undici, no src/ imports — scripts/ and
// agent-test tooling never depend on server code). Proxy-aware: an
// EnvHttpProxyAgent is installed when HTTP(S)_PROXY is set (repo convention).

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EnvHttpProxyAgent, request as undiciRequest, setGlobalDispatcher } from 'undici';

// ---------------------------------------------------------------------------
// Pins — the SAME authority the download scripts carry (byte-exact public
// twins; provenance in each resources.download.sh header). The publisher
// cross-checks these against the local files before any upload.
// ---------------------------------------------------------------------------

const FIXTURES = [
  {
    name: '1kg.chr22.vcf.gz',
    bytes: 205_612_353,
    sha256: 'a90c16c4ff2b3196476d506ae13cb3047fae8670163c7c932c4b0239aef3daf5',
    fetchedBy: 'biowasm-q01-vcf-orientation/resources.download.sh',
    provenance:
      'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/ALL.chr22.phase3_shapeit2_mvncall_integrated_v5b.20130502.genotypes.vcf.gz',
  },
  {
    name: '1kg.chr22.vcf.gz.tbi',
    bytes: 36_251,
    sha256: '27de6b77af65d300bb968e8e372439deb949389e4395eb0dd251f9ba7d73bbed',
    fetchedBy: 'biowasm-q01-vcf-orientation/resources.download.sh',
    provenance:
      'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/ALL.chr22.phase3_shapeit2_mvncall_integrated_v5b.20130502.genotypes.vcf.gz.tbi',
  },
  {
    name: 'na12878.chr20.bam',
    bytes: 311_550_121,
    sha256: 'dfc164c34dd94e1c46ea94cad915489171ae8913da200ca4e5cae03a554f1996',
    fetchedBy: 'biowasm-q02-bam-orientation/resources.download.sh',
    provenance:
      'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/phase3/data/NA12878/alignment/NA12878.chrom20.ILLUMINA.bwa.CEU.low_coverage.20121211.bam',
  },
  {
    name: 'na12878.chr20.bam.bai',
    bytes: 179_968,
    sha256: '525860a53fa5e8264258006cff2f1f5f275c4014726192989d1dae26dd4810cf',
    fetchedBy: 'biowasm-q02-bam-orientation/resources.download.sh',
    provenance:
      'https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/phase3/data/NA12878/alignment/NA12878.chrom20.ILLUMINA.bwa.CEU.low_coverage.20121211.bam.bai',
  },
];

const MANIFEST_PATH = new URL('./fixtures-manifest.json', import.meta.url).pathname;
// Anchor every repo-relative path to THIS file, not the caller's CWD.
const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const REPO_ROOT = new URL('../', import.meta.url).pathname;
const DOWNLOAD_SCRIPTS = [
  'biowasm-q01-vcf-orientation',
  'biowasm-q02-bam-orientation',
  'biowasm-q03-point-depth',
  'biowasm-q04-contig-trap',
  'biowasm-q06-snp-extraction',
  'biowasm-q07-binned-depth',
  'biowasm-q08-artifact-chain',
  'biowasm-q09-slice-artifact',
  'biowasm-q12-truncation-honesty',
  'biowasm-q13-impossible-task',
].map((d) => join(SCRIPT_DIR, d, 'resources.download.sh'));

const PROD_BASE = 'https://zenodo.org';
const SANDBOX_BASE = 'https://sandbox.zenodo.org';

// ---------------------------------------------------------------------------
// Args + env.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(name);
}
function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const target = flag('--prod') ? 'prod' : flag('--sandbox') ? 'sandbox' : 'sandbox';
const publish = flag('--publish');
const discard = flag('--discard');
const verifyDownload = flag('--verify-download');
const updateScripts = flag('--update-scripts');
const listOnly = flag('--list');
const recordId = opt('--record') ?? opt('--record-id');
const newVersion = flag('--new-version');
const dataRoot = resolve(
  opt('--data-root') ?? process.env.AGENT_TEST_DATA ?? join(REPO_ROOT, 'agent-test', '.runs', 'data'),
);

function readEnvFile() {
  const path = join(homedir(), '.env');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const envFile = readEnvFile();
const token = target === 'prod' ? envFile.ZENODO_API : envFile.ZENODO_SANDBOX_API;
const base = target === 'prod' ? PROD_BASE : SANDBOX_BASE;

function redact(text) {
  return String(text).replaceAll(token ?? '\u0000no-token\u0000', '***');
}

function die(message) {
  console.error(`ERROR: ${redact(message)}`);
  process.exit(1);
}

if (!token && !listOnly && !updateScripts) {
  die(
    `no API token for the ${target} environment in ~/.env (expected ${target === 'prod' ? 'ZENODO_API' : 'ZENODO_SANDBOX_API'}). ` +
      'Create one at https://zenodo.org/account/settings/applications/tokens/new/ (or the sandbox equivalent) with scopes deposit:write + deposit:actions.',
  );
}

// Proxy awareness (repo convention: EnvHttpProxyAgent only when env present).
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
  // Origin only — embedded proxy credentials must never reach the log.
  try {
    console.log(`proxy: routing via ${new URL(proxyUrl).origin}`);
  } catch {
    console.log('proxy: routing via the configured proxy');
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (undici.request so streamed PUTs carry an explicit
// Content-Length — fetch() strips caller-supplied content-length and would
// send chunked TE, which bucket endpoints may reject).
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;

// Zenodo's WAF rejects User-Agent-less requests on the deposit endpoints
// (verified live: identical authenticated POSTs — 403 without a UA, 201 with
// one), and undici sends no UA by default.
const USER_AGENT = 'biomcp-zenodo-publish/1.0 (+https://github.com/yeyuan98/biomcp-ts)';

async function api(method, url, { json, bodyFactory, contentLength, contentType, dieContext = '' } = {}) {
  // `bodyFactory` (not a stream) so a retry gets a FRESH stream — proxied
  // multi-hundred-MB uploads do see transient ECONNRESETs.
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await undiciRequest(url, {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(contentType && !json ? { 'Content-Type': contentType } : {}),
          ...(contentLength !== undefined ? { 'Content-Length': String(contentLength) } : {}),
        },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        ...(bodyFactory !== undefined ? { body: bodyFactory() } : {}),
        // Large proxied transfers: no client-side deadlines.
        headersTimeout: 0,
        bodyTimeout: 0,
      });
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`  ${method} ${redact(url)} network error (${err.message}); retrying with a fresh stream (${attempt}/${MAX_ATTEMPTS - 1})`);
        await sleep(5000 * attempt);
        continue;
      }
      die(`request failed: ${method} ${redact(url)} — ${err.message}${dieContext}`);
    }
    if (res.statusCode === 429 && attempt < MAX_ATTEMPTS) {
      const raw = Number(res.headers['retry-after']);
      const retryAfter = Number.isFinite(raw) && raw >= 0 ? raw : 5;
      console.warn(`  429 rate-limited; sleeping ${retryAfter}s (attempt ${attempt}/${MAX_ATTEMPTS - 1})`);
      res.body.dump?.();
      await sleep(retryAfter * 1000);
      continue;
    }
    const text = await res.body.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.statusCode, headers: res.headers, body: parsed };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Escape EVERY regex metacharacter (incl. backslash) so a string can be
 * interpolated literally into a RegExp source — the dot-only escape this
 * replaces tripped CodeQL's incomplete-sanitization query (backslash was
 * not escaped, so a `\` in the input would have acted as an escape
 * introducer). `/` and `-` are correctly absent: they are special only in
 * regex literals / inside character classes, and this feeds `new RegExp`
 * sources outside classes.
 */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function keylessHead(url) {
  const res = await undiciRequest(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, headersTimeout: 60_000 });
  await res.body.dump?.();
  return { status: res.statusCode, contentLength: Number(res.headers['content-length'] ?? '0') };
}

async function keylessGetSha256(url) {
  const res = await undiciRequest(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT }, headersTimeout: 0, bodyTimeout: 0 });
  if (res.statusCode !== 200) {
    await res.body.dump?.();
    return null;
  }
  const sha = createHash('sha256');
  for await (const chunk of res.body) sha.update(chunk);
  return sha.digest('hex');
}

// ---------------------------------------------------------------------------
// Local fixture staging + one-pass sha256/md5.
// ---------------------------------------------------------------------------

function fetchMissing(fixtures) {
  const byScript = new Map();
  for (const f of fixtures) byScript.set(f.fetchedBy, [...(byScript.get(f.fetchedBy) ?? []), f]);
  for (const [script, files] of byScript) {
    console.log(`fetching via ${script}: ${files.map((f) => f.name).join(', ')}`);
    const r = spawnSync('bash', [join(SCRIPT_DIR, script), dataRoot], { stdio: 'inherit', timeout: 45 * 60_000 });
    if (r.status !== 0 || r.error) {
      die(`download script failed (${script}, exit ${r.status ?? 'null'}${r.error ? `: ${r.error.message}` : ''})`);
    }
  }
}

async function verifyLocal(f) {
  const path = join(dataRoot, f.name);
  const sha = createHash('sha256');
  const md5 = createHash('md5');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      sha.update(chunk);
      md5.update(chunk);
      bytes += chunk.length;
    }
  } catch (err) {
    die(`cannot read local fixture ${path}: ${err.message}`);
  }
  const sha256 = sha.digest('hex');
  if (bytes !== f.bytes || sha256 !== f.sha256) {
    die(
      `local fixture ${f.name} failed pin verification (size ${bytes} != ${f.bytes} or sha256 mismatch) — delete it and re-run; refusing to upload unpinned bytes`,
    );
  }
  return { path, md5: md5.digest('hex'), sha256 };
}

// ---------------------------------------------------------------------------
// Modes.
// ---------------------------------------------------------------------------

if (listOnly) {
  console.log(JSON.stringify({ target, base, dataRoot, recordId, publish, discard, fixtures: FIXTURES }, null, 2));
  process.exit(0);
}

if (updateScripts) {
  const id = recordId ?? (() => {
    if (!existsSync(MANIFEST_PATH)) return undefined;
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).record_id;
  })();
  if (!id) die('--update-scripts needs --record <id> (or a committed fixtures-manifest.json)');
  updateDownloadScripts(String(id));
  console.log(`OK: download scripts now lead with Zenodo record ${id}`);
  process.exit(0);
}

if (discard) {
  const targetId = opt('--record');
  if (targetId) {
    // Discard a SPECIFIC draft (e.g. the one a rehearsal just created):
    // delete it directly, before anything else happens.
    console.log(`--discard: deleting deposition ${targetId}`);
    const del = await api('DELETE', `${base}/api/deposit/depositions/${targetId}`);
    console.log(del.status === 204 ? `OK: deposition ${targetId} deleted` : `WARNING: delete returned ${del.status}`);
    process.exit(0);
  }
  console.log('--discard without --record: creating a fresh draft, then deleting it (API path smoke test)');
  const created = await api('POST', `${base}/api/deposit/depositions`, { json: {} });
  if (created.status !== 201) die(`deposition creation failed (${created.status})`);
  const del = await api('DELETE', `${base}/api/deposit/depositions/${created.body.id}`);
  console.log(del.status === 204 ? `OK: draft ${created.body.id} deleted` : `WARNING: delete returned ${del.status}`);
  process.exit(0);
}

// Stage + verify local fixtures (integrity check #1).
const missing = FIXTURES.filter((f) => !existsSync(join(dataRoot, f.name)));
if (missing.length > 0) {
  console.log(`missing ${missing.length} fixture(s) under ${dataRoot}; fetching via the canonical download scripts`);
  fetchMissing(missing);
}
const local = {};
for (const f of FIXTURES) {
  local[f.name] = await verifyLocal(f);
  console.log(`OK: ${f.name} pin-verified (${f.bytes} B, sha256 ${f.sha256.slice(0, 12)}…, md5 ${local[f.name].md5.slice(0, 12)}…)`);
}

// Resolve the deposition to work on.
let deposition;
if (newVersion) {
  if (!recordId) die('--new-version requires --record <id> (the LATEST version id, not the concept id)');
  console.log(`creating a new version of record ${recordId}…`);
  const nv = await api('POST', `${base}/api/deposit/depositions/${recordId}/actions/newversion`);
  if (nv.status !== 201) die(`newversion failed (${nv.status}): ${JSON.stringify(nv.body).slice(0, 400)}`);
  const draftUrl = nv.body?.links?.latest_draft;
  if (!draftUrl) die('newversion response carried no links.latest_draft');
  const draft = await api('GET', draftUrl);
  if (draft.status !== 200) die(`fetching latest_draft failed (${draft.status})`);
  deposition = draft.body;
  console.log(`OK: draft for the new version is deposition ${deposition.id}`);
} else {
  console.log(`creating a new ${target} draft deposition…`);
  const created = await api('POST', `${base}/api/deposit/depositions`, { json: {} });
  if (created.status !== 201) die(`deposition creation failed (${created.status}): ${JSON.stringify(created.body).slice(0, 400)}`);
  deposition = created.body;
  console.log(`OK: draft ${deposition.id} created (prereserved DOI ${deposition.metadata?.prereserve_doi?.doi ?? 'n/a'})`);
}

const depId = deposition.id;
const bucket = deposition.links?.bucket;
if (!bucket) die('deposition response carried no links.bucket');

// Upload each file with an explicit Content-Length (integrity check #2 = md5).
for (const f of FIXTURES) {
  const url = `${bucket}/${encodeURIComponent(f.name)}`;
  console.log(`uploading ${f.name} (${f.bytes} B)…`);
  const up = await api('PUT', url, {
    bodyFactory: () => createReadStream(local[f.name].path),
    contentLength: f.bytes,
    contentType: 'application/octet-stream',
    dieContext: `\ndraft ${depId} left behind — discard with --discard --record ${depId} and retry`,
  });
  if (up.status !== 200 && up.status !== 201) {
    die(
      `upload failed for ${f.name} (${up.status}): ${JSON.stringify(up.body).slice(0, 400)}\n` +
        `draft ${depId} left behind — inspect ${base}/deposit/${depId}, or discard with --discard --record ${depId}`,
    );
  }
  const remoteMd5 = String(up.body?.checksum ?? '').replace(/^md5:/, '');
  if (remoteMd5 !== local[f.name].md5) {
    die(
      `upload integrity mismatch for ${f.name}: Zenodo md5 ${remoteMd5} != local ${local[f.name].md5}\n` +
        `draft ${depId} left behind — discard with --discard --record ${depId} and retry`,
    );
  }
  console.log(`OK: ${f.name} uploaded, md5 verified (${remoteMd5})`);
}

// Metadata.
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf8')).version;
const gitUser = (() => {
  const r = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'yeyuan98';
})();
const metadata = {
  title: 'biomcp agent-test fixtures — 1000 Genomes public twins (chr22 phase3 VCF, NA12878 chr20 BAM)',
  upload_type: 'dataset',
  description: [
    '<p>Byte-exact test fixtures for the <a href="https://github.com/yeyuan98/biomcp-ts">biomcp-ts</a> agent-test suite (MCP biomedical analysis tools). Each file is a verified public twin of 1000 Genomes Project data, mirrored for fast, reliable, checksum-pinned provisioning.</p>',
    '<p><b>Provenance and verification</b> (sha256 pins enforced at download time by the pinned scripts in the repository):</p>',
    '<ul>',
    ...FIXTURES.map(
      (f) =>
        `<li><code>${f.name}</code> — ${f.bytes} B, sha256 <code>${f.sha256}</code>; canonical source: <a href="${f.provenance}">${f.provenance}</a></li>`,
    ),
    '</ul>',
    '<p><b>Licensing basis:</b> the 1000 Genomes Project data are available without restriction on use and redistribution (IGSR / EMBL-EBI Terms of Use impose no additional restrictions beyond those of the original data owners; attribution expected). This record is therefore published under CC0. Please cite the 1000 Genomes Project (Nature 2010; Nature 2015) and IGSR (Nucleic Acids Research 2020) when using the data.</p>',
    '<p>Files are immutable once published; new versions create a new record under the same concept DOI.</p>',
  ].join('\n'),
  creators: [{ name: gitUser, affiliation: 'biomcp-ts' }],
  keywords: ['1000-genomes', 'VCF', 'BAM', 'genomics', 'test-fixtures', 'MCP', 'biomcp'],
  access_right: 'open',
  license: 'cc-zero',
  version,
  language: 'eng',
  notes: 'Mirrored by agent-test/zenodo-publish.mjs in the biomcp-ts repository; consumers download keyless via https://zenodo.org/records/&lt;id&gt;/files/&lt;name&gt;?download=1.',
};

console.log('attaching metadata…');
const meta = await api('PUT', `${base}/api/deposit/depositions/${depId}`, { json: { metadata } });
if (meta.status !== 200) {
  die(
    `metadata update failed (${meta.status}): ${JSON.stringify(meta.body).slice(0, 600)}\n` +
      `draft ${depId} left behind — fix and retry against it, or discard with --discard --record ${depId}`,
  );
}
console.log('OK: metadata accepted');

if (!publish) {
  console.log(
    `\nDONE (draft): ${target} deposition ${depId} holds all ${FIXTURES.length} files (md5-verified) and its metadata.\n` +
      `Inspect: ${base}/deposit/${depId}\n` +
      `Publish deliberately with: node agent-test/zenodo-publish.mjs --${target === 'prod' ? 'prod' : 'sandbox'} --publish\n` +
      `Or discard the draft:  node agent-test/zenodo-publish.mjs --${target === 'prod' ? 'prod' : 'sandbox'} --discard`,
  );
  process.exit(0);
}

console.log('publishing…');
const pub = await api('POST', `${base}/api/deposit/depositions/${depId}/actions/publish`);
if (pub.status !== 202) {
  die(
    `publish failed (${pub.status}): ${JSON.stringify(pub.body).slice(0, 400)}\n` +
      `draft ${depId} left behind — it is still private; fix and retry, or discard with --discard --record ${depId}`,
  );
}
const recid = pub.body?.record_id ?? pub.body?.id ?? depId;
const doi = pub.body?.doi ?? pub.body?.metadata?.doi;
let conceptDoi = pub.body?.conceptdoi ?? pub.body?.concept_doi;
if (!conceptDoi) {
  const rec = await api('GET', `${base}/api/records/${recid}`);
  conceptDoi = rec.body?.conceptdoi ?? null;
}
console.log(`OK: published — record ${recid}, DOI ${doi}, concept DOI ${conceptDoi ?? 'n/a'}`);

// Integrity check #3: keyless public serving (HEAD content-length parity).
const publicBase = target === 'prod' ? PROD_BASE : SANDBOX_BASE;
for (const f of FIXTURES) {
  const url = `${publicBase}/records/${recid}/files/${encodeURIComponent(f.name)}?download=1`;
  const head = await keylessHead(url);
  if (head.status !== 200) die(`keyless HEAD ${url} -> ${head.status} (expected 200)`);
  if (head.contentLength !== f.bytes) die(`keyless HEAD ${f.name}: content-length ${head.contentLength} != ${f.bytes}`);
  console.log(`OK: keyless HEAD ${f.name} -> 200, ${head.contentLength} B`);
}

if (verifyDownload) {
  for (const f of FIXTURES) {
    const url = `${publicBase}/records/${recid}/files/${encodeURIComponent(f.name)}?download=1`;
    const sha = await keylessGetSha256(url);
    if (sha === null) die(`re-download of ${f.name} failed (non-200) against ${url}`);
    if (sha !== f.sha256) die(`re-downloaded ${f.name} sha256 mismatch (${sha})`);
    console.log(`OK: re-downloaded ${f.name} sha256 verified`);
  }
}

// Committed manifest — prod only (sandbox ids are wipeable).
if (target === 'prod') {
  const manifest = {
    record_id: recid,
    doi,
    concept_doi: conceptDoi,
    published_at: new Date().toISOString(),
    license: 'cc-zero',
    files: FIXTURES.map((f) => ({
      name: f.name,
      bytes: f.bytes,
      sha256: f.sha256,
      md5: local[f.name].md5,
      url: `${publicBase}/records/${recid}/files/${encodeURIComponent(f.name)}?download=1`,
    })),
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`OK: wrote ${MANIFEST_PATH}`);
  console.log(`NEXT: node agent-test/zenodo-publish.mjs --update-scripts   # point the download scripts at record ${recid}`);
} else {
  console.log('NOTE: sandbox publish — the committed manifest is written for PROD only.');
}

// ---------------------------------------------------------------------------
// Script updater: point the 10 resources.download.sh at a published record.
// ---------------------------------------------------------------------------

function updateDownloadScripts(recordId) {
  const zenodoBase = `https://zenodo.org/records/${recordId}`;
  for (const script of DOWNLOAD_SCRIPTS) {
    if (!existsSync(script)) die(`download script missing: ${script}`);
    let text = readFileSync(script, 'utf8');
    // --- ZENODO= base line: swap an older record id, or insert after the
    //     last mirror-base anchor (EBI=/NCBI=/BASE= block). ---
    if (!text.includes(`ZENODO=${zenodoBase}`)) {
      if (/^ZENODO=https:\/\/zenodo\.org\/records\/\d+.*$/m.test(text)) {
        // Function replacer: the record id (CLI-supplied) must be inserted
        // literally — string replacements interpret $-sequences.
        text = text.replace(/^ZENODO=https:\/\/zenodo\.org\/records\/\d+.*$/m, () => `ZENODO=${zenodoBase}`);
      } else {
        const lines = text.split('\n');
        let insertAt = -1;
        for (let i = 0; i < lines.length; i++) {
          if (/^(EBI|NCBI|BASE)=/.test(lines[i])) insertAt = i + 1;
        }
        if (insertAt < 0) die(`${script}: no mirror-base anchor found for the ZENODO= insertion`);
        lines.splice(
          insertAt,
          0,
          '',
          '# Public Zenodo dataset mirror (keyless; see agent-test/fixtures-manifest.json):',
          `ZENODO=${zenodoBase}`,
        );
        text = lines.join('\n');
      }
    }
    // --- ensure lines: the URL MUST land at the HEAD OF THE URL LIST —
    //     ensure <dest> <sha> <size> <url>... — never in the sha/size slots
    //     (a mis-slotted URL makes verify() compare a sha hex against a URL,
    //     fail, and rm -f a perfectly good cached file). Strip any existing
    //     Zenodo arg first so re-runs and record swaps never double-prepend. ---
    let patched = 0;
    let referenced = 0;
    for (const f of FIXTURES) {
      const esc = escapeRegExp(f.name);
      // dest + sha + size (whitespace-padded alignment tolerated); the URL
      // list starts after the third quoted argument.
      const headOfUrlList = new RegExp(`^(ensure "\\$DIR/${esc}"\\s+"[^"]+"\\s+"[^"]+")`, 'm');
      if (!new RegExp(`^ensure "\\$DIR/${esc}"`, 'm').test(text)) continue;
      referenced += 1;
      // Strip the correctly-slotted form (this updater) …
      text = text.replace(
        new RegExp(`^(ensure "\\$DIR/${esc}"\\s+"[^"]+"\\s+"[^"]+")\\s+"?\\$ZENODO/files/${esc}\\?download=1"?`, 'm'),
        '$1',
      );
      // … and the legacy mis-slotted form (URL right after the dest path).
      text = text.replace(
        new RegExp(`^(ensure "\\$DIR/${esc}")\\s+"?\\$ZENODO/files/${esc}\\?download=1"?`, 'm'),
        '$1',
      );
      if (!headOfUrlList.test(text)) die(`${script}: ensure anchor lost for ${f.name} — refusing a partial edit`);
      // Function replacer: the inserted text is literal regardless of name
      // content (string replacements interpret $-sequences), and the head
      // group is taken from the parameter — never re-emitted as `$1`.
      text = text.replace(headOfUrlList, (_m, head) => `${head} "$ZENODO/files/${f.name}?download=1"`);
      patched += 1;
    }
    if (referenced > 0 && patched !== referenced) {
      die(`${script}: patched ${patched} of ${referenced} fixture ensure lines — refusing a partial edit`);
    }
    // --- curl -L (follow redirects; harmless for EBI/NCBI, future-proofs
    //     the Zenodo mirror). Idempotent, order-tolerant. ---
    text = text.replace(/(\bcurl\b)(?![^\n]*\s-L\b)( --fail)/, '$1 -L$2');
    writeFileSync(script, text);
    console.log(`  ${script}: updated${referenced === 0 ? ' (no fixture ensure lines — base only)' : ` (${patched} ensure line(s))`}`);
  }
}
