/* Live acceptance check for the fulltext/oa rebuild.
 * Run: npx tsx scripts/verify-fulltext.ts (from repo root)
 * Covers the 25 user-reported PMIDs plus edge cases. */
import { articleGet } from '../src/entities/article/index.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPORTED = `42796603 42683091 42123314 41181593 40813655 40236530 39547512 36669888 36227917 34985952 34445478 34433568 34301750 34140497 33038326 31009996 30867891 30602453 30121937 29865182 29330463 25875295 25250705 23631917 22027709`.split(/\s+/);

async function one(pmid: string) {
  const r = await articleGet(pmid, ['oa', 'fulltext'], { fulltextMaxChars: 60000, fulltextOutput: 'inline' });
  const oa: any = r.sections?.open_access ?? {};
  const ft: any = r.sections?.fulltext ?? {};
  return {
    pmid,
    pmcid: r.pmcid ?? oa.pmcid ?? '-',
    oa_status: oa.status ?? `ERR:${oa._error?.slice(0, 40)}`,
    oa_ft: oa.full_text_available,
    is_oa: r.is_open_access,
    lic: oa.license ?? '-',
    pdf: oa.links?.pdf_url ? 'yes' : 'no',
    ft_status: ft.status ?? `ERR:${ft._error?.slice(0, 40)}`,
    ft_reason: ft.reason ?? '',
    ft_src: ft.source ?? '-',
    ft_chars: ft.char_count ?? 0,
    ft_secs: ft.sections?.length ?? 0,
    trunc: ft.truncated === true,
  };
}

async function main() {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const rows = [];
  for (const pmid of REPORTED) {
    rows.push(await one(pmid));
    process.stdout.write('.');
    await sleep(400); // politeness: shared eutils budget
  }
  console.log('\n');
  const fmt = (r: any) =>
    `${r.pmid} ${String(r.pmcid).padEnd(13)} oa=${String(r.oa_status).padEnd(12)} ft_avail=${String(r.oa_ft).padEnd(5)} is_oa=${String(r.is_oa).padEnd(5)} lic=${String(r.lic).padEnd(10)} pdf=${r.pdf.padEnd(3)} | ft=${r.ft_status}${r.ft_reason ? '/' + r.ft_reason : ''} src=${r.ft_src} chars=${r.ft_chars} secs=${r.ft_secs} trunc=${r.trunc}`;
  for (const r of rows) console.log(fmt(r));

  const ok = rows.filter(r => ['open_access', 'free_to_read'].includes(r.oa_status) && r.oa_ft === true && r.ft_status === 'available' && r.ft_chars > 1000);
  console.log(`\n${ok.length}/${REPORTED.length} reported PMIDs: open_access + fetchable full text (>1000 chars)`);

  console.log('\n--- edge cases ---');
  for (const [label, pmid] of [['Cell free-not-OA', '41478284'], ['Nature not-in-PMC', '42864440'], ['body-less PMC record', '28542929']] as const) {
    const r = await one(pmid);
    console.log(fmt(r));
    await sleep(400);
  }

  if (ok.length !== REPORTED.length) {
    console.log('\nFAIL: not all reported PMIDs served full text');
    process.exit(1);
  }
  // File mode spot check: one article, handle + real file on disk
  const cacheDir = mkdtempSync(join(tmpdir(), 'biomcp-verify-'));
  const saved = process.env.BIOMCP_CACHE_DIR;
  process.env.BIOMCP_CACHE_DIR = cacheDir;
  try {
    const r: any = await articleGet('25875295', ['fulltext']);
    const ft = r.sections?.fulltext ?? {};
    console.log(`\nfile-mode check 25875295: mode=${ft.mode} path=${ft.file_path ?? 'NONE'} outline=${ft.outline?.length ?? 0} chars=${ft.char_count ?? 0}`);
    if (ft.mode !== 'file' || !existsSync(ft.file_path)) {
      console.log('FAIL: file mode did not produce a readable file');
      process.exit(1);
    }
    if (ft.sections !== undefined) {
      console.log('FAIL: file-mode reply contains body sections');
      process.exit(1);
    }
  } finally {
    if (saved === undefined) delete process.env.BIOMCP_CACHE_DIR;
    else process.env.BIOMCP_CACHE_DIR = saved;
    rmSync(cacheDir, { recursive: true, force: true });
  }

  console.log('\nACCEPTANCE PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
