import { mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchManifest, parseManifest, selectLatestRelease, MANIFEST_URL } from './manifest.js';
import { parseDatasetSelection, resolveDatasetFiles } from './datasets.js';
import { ensureRawDir, stagingPlan, statusTable, verifyStaged } from './staging.js';
import {
  createDatabase,
  ingestControls,
  ingestGenes,
  ingestMatrix,
  ingestModels,
  ingestMutations,
  writeMetadata,
  type IngestResult,
} from './ingest.js';

const SCRIPT_VERSION = '1.0.0';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

interface Args {
  datasets?: string;
  rawDir?: string;
  out?: string;
  manifest?: string;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      fail(`Unexpected argument: ${arg}`);
    }
    const flag = arg.slice(2);
    const eq = flag.indexOf('=');
    const name = eq > 0 ? flag.slice(0, eq) : flag;
    if (name === 'list') {
      args.list = true;
      continue;
    }
    let value: string;
    if (eq > 0) {
      value = flag.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[++i];
    } else {
      fail(`Missing value for --${name}`);
    }
    if (!['datasets', 'raw-dir', 'out', 'manifest'].includes(name)) {
      fail(`Unknown flag: --${name}`);
    }
    if (name === 'datasets') args.datasets = value;
    else if (name === 'raw-dir') args.rawDir = value;
    else if (name === 'out') args.out = value;
    else args.manifest = value;
  }
  return args;
}

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let manifestText: string;
  try {
    manifestText = await fetchManifest(args.manifest);
  } catch (error) {
    fail(
      `Failed to load the DepMap manifest (${String(error)})\n` +
      `Either retry later, or pass a previously saved copy: --manifest <downloads.csv>\n` +
      `Manifest endpoint: ${MANIFEST_URL}`,
      3
    );
  }

  let release;
  try {
    release = selectLatestRelease(parseManifest(manifestText));
  } catch (error) {
    fail(`Failed to parse the DepMap manifest: ${String(error)}`, 3);
  }

  let datasets;
  try {
    datasets = parseDatasetSelection(args.datasets);
  } catch (error) {
    fail(String(error));
  }

  let resolved;
  try {
    resolved = resolveDatasetFiles(datasets, release);
  } catch (error) {
    fail(String(error));
  }

  const rawDir = args.rawDir ?? join(SCRIPT_DIR, 'raw', release.shortName);
  ensureRawDir(rawDir);

  const staged = await verifyStaged(
    rawDir,
    resolved.map(r => ({ filename: r.filename, md5: r.md5 }))
  );

  console.log(`Release: ${release.name}${release.date ? ` (${release.date})` : ''}`);
  console.log(`Raw dir: ${rawDir}`);
  console.log('Staging status:');
  console.log(statusTable(staged));

  if (args.list) {
    if (staged.some(s => s.status !== 'ok')) {
      console.log('');
      console.log(stagingPlan(release, staged, rawDir));
    }
    return;
  }

  const missing = staged.filter(s => s.status === 'missing');
  if (missing.length > 0) {
    console.log('');
    console.log(stagingPlan(release, staged, rawDir));
    process.exit(1);
  }
  const mismatch = staged.filter(s => s.status === 'mismatch');
  if (mismatch.length > 0) {
    console.log('');
    console.log(stagingPlan(release, staged, rawDir));
    process.exit(2);
  }

  const outPath = args.out ?? join(SCRIPT_DIR, 'dist', `depmap-${release.shortName}.db`);
  mkdirSync(dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp`;
  try {
    unlinkSync(tmpPath);
  } catch {}

  console.log('');
  console.log(`Building ${outPath} ...`);
  const db = createDatabase(tmpPath);
  const results: IngestResult[] = [];
  const ingestOne = async (filename: string, datasetId: string) => {
    const file = join(rawDir, filename);
    const started = Date.now();
    let result: IngestResult;
    if (datasetId === 'models') result = await ingestModels(db, file);
    else if (datasetId === 'genes') result = await ingestGenes(db, file);
    else if (datasetId === 'mutations') result = await ingestMutations(db, file);
    else if (datasetId === 'common_essentials') {
      const sub = await ingestControls(db, [
        {
          file,
          category: filename.startsWith('AchillesCommon') ? 'common_essential' : 'nonessential',
        },
      ]);
      result = sub[0];
    } else {
      const spec = datasets.find(d => d.id === datasetId)!;
      result = await ingestMatrix(db, file, spec.table, spec.matrix ?? 'positional');
    }
    results.push(result);
    console.log(
      `  ${filename}: ${((Date.now() - started) / 1000).toFixed(1)}s — ${result.rowCount.toLocaleString()} rows (${result.details})`
    );
  };

  try {
    for (const r of resolved) await ingestOne(r.filename, r.dataset.id);
    writeMetadata(
      db,
      {
        release: release.name,
        releaseDate: release.date,
        manifestEndpoint: MANIFEST_URL,
        scriptVersion: SCRIPT_VERSION,
      },
      results.map(r => ({ datasetId: r.datasetId, filename: r.filename, rowCount: r.rowCount }))
    );
  } catch (error) {
    db.close();
    try {
      unlinkSync(tmpPath);
    } catch {}
    fail(`Build failed: ${String(error)}`, 1);
  }
  db.close();

  try {
    unlinkSync(outPath);
  } catch {}
  renameSync(tmpPath, outPath);

  const totalRows = results.reduce((sum, r) => sum + r.rowCount, 0);
  console.log('');
  console.log(`Done: ${outPath}`);
  console.log(`  ${results.length} file(s), ${totalRows.toLocaleString()} total rows`);
  console.log('');
  console.log('Query it with the biomcp database tools:');
  console.log(`  DB_TYPE=sqlite DB_SQLITE_PATH=${outPath} npx .`);
}

main().catch(error => {
  console.error(`Unexpected error: ${String(error)}`);
  process.exit(1);
});
