// test5: samtools on real human BAM (NA12878 chr20 low-coverage WGS, ~312MB)
import { loadTool, initShared, mountHostFile, run, memWatch, report, ioStats, closeAllFds } from './harness.mjs';

const DATA = '/home/administrator/temp/biowasm/data/';
const state = memWatch();
const sam = await loadTool('samtools');
initShared(sam);

mountHostFile(sam.Module, DATA + 'na12878.chr20.bam', '/shared/data/na12878.chr20.bam');
mountHostFile(sam.Module, DATA + 'na12878.chr20.bam.bai', '/shared/data/na12878.chr20.bam.bai');
const FS = sam.Module.FS;
console.log('mounted. bam size:', FS.stat('/shared/data/na12878.chr20.bam').size);

// 1. header only — should read only the first BGZF block(s)
ioStats.reset();
let r = run(sam, ['view', '-H', '/shared/data/na12878.chr20.bam']);
console.log('view -H: lines=', r.out.split('\n').filter(Boolean).length);
report('1 view -H', r, state);

// 2. region query via index — the money test for streaming
ioStats.reset();
r = run(sam, ['view', '-c', '/shared/data/na12878.chr20.bam', '20:10,000,000-10,100,000']);
report('2 region 100kb count=' + r.out.trim(), r, state);

// 3. larger region 5Mb
ioStats.reset();
r = run(sam, ['view', '-c', '/shared/data/na12878.chr20.bam', '20:10,000,000-15,000,000']);
report('3 region 5Mb count=' + r.out.trim(), r, state);

// 4. idxstats — index only
ioStats.reset();
r = run(sam, ['idxstats', '/shared/data/na12878.chr20.bam']);
report('4 idxstats', r, state);
console.log('   ', r.out.trim().split('\n')[0]);

// 5. flagstat — full streaming scan of 312MB BAM
ioStats.reset();
r = run(sam, ['flagstat', '/shared/data/na12878.chr20.bam']);
report('5 flagstat', r, state);
console.log('   total:', r.out.split('\n')[0], '+', r.out.split('\n')[2]);

// 6. full count scan
ioStats.reset();
r = run(sam, ['view', '-c', '/shared/data/na12878.chr20.bam']);
report('6 view -c full count=' + r.out.trim(), r, state);

// 7. region → BAM output, then read output back to host
ioStats.reset();
r = run(sam, ['view', '-b', '/shared/data/na12878.chr20.bam', '20:10,000,000-10,500,000', '-o', '/shared/out/region.bam']);
const sz = FS.stat('/shared/out/region.bam').size;
report(`7 region->BAM out=${(sz/1048576).toFixed(1)}MB`, r, state);
r = run(sam, ['view', '-c', '/shared/out/region.bam']);
console.log('    region.bam count:', r.out.trim());

// 8. mpileup over 1Mb region (compute-heavy path)
ioStats.reset();
r = run(sam, ['mpileup', '-r', '20:10,000,000-10,200,000', '/shared/data/na12878.chr20.bam']);
console.log('8 mpileup 200kb region: out lines=', r.out.split('\n').filter(Boolean).length, 'err head:', r.err.split('\n')[0]);
report('8 mpileup', r, state);

// 9. full-file SAM→BAM conversion streaming into MEMFS output (tests write path + growth)
ioStats.reset();
try {
  r = run(sam, ['view', '-b', '/shared/data/na12878.chr20.bam', '-o', '/shared/out/full.bam']);
  const sz2 = FS.stat('/shared/out/full.bam').size;
  report(`9 full->BAM out=${(sz2/1048576).toFixed(1)}MB`, r, state);
} catch (e) { console.log('9 full->BAM failed:', String(e).slice(0, 120)); }

// cleanup big outputs to free JS heap
try { FS.unlink('/shared/out/full.bam'); } catch {}
closeAllFds();
state.stop = true;
console.log('PEAK RSS MB:', state.peakRssMB.toFixed(0));
process.exit(0);
