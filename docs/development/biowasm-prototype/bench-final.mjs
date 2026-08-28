// bench-final.mjs — definitive samtools + bcftools benchmarks on real human data
// Proper measurement: /proc VmHWM (kernel peak RSS), quiet stdout, file outputs.
import { loadTool, initShared, mountHostFile, run, ioStats } from './harness.mjs';
import { readFileSync } from 'node:fs';

const DATA = '/home/administrator/temp/biowasm/data/';
const hwm0 = hwm();
function hwm() {
  const st = readFileSync('/proc/self/status', 'utf8');
  return {
    hwm: +(st.match(/VmHWM:\s+(\d+) kB/)?.[1] ?? 0) / 1024,
    rss: +(st.match(/VmRSS:\s+(\d+) kB/)?.[1] ?? 0) / 1024,
  };
}
function show(tag, r) {
  const m = hwm();
  const io = [...ioStats.perFile.entries()].map(([f, s]) => `${f.split('.').slice(-2).join('.').slice(0, 18)}=${(s.bytes / 1048576).toFixed(1)}MB/${s.reads}r`).join(' ');
  console.log(String(tag).padEnd(46) + `${String(r.ms).padStart(6)}ms heap=${String(r.heapMB).padStart(6)}MB peakRSS=${String(m.hwm.toFixed(0)).padStart(5)}MB | ${io}`);
}

const sam = await loadTool('samtools', { quiet: true });
initShared(sam);
const bcf = await loadTool('bcftools', { quiet: true, shareFrom: sam });
const FS = sam.Module.FS;
mountHostFile(sam.Module, DATA + 'na12878.chr20.bam', '/shared/data/na12878.chr20.bam');
mountHostFile(sam.Module, DATA + 'na12878.chr20.bam.bai', '/shared/data/na12878.chr20.bam.bai');
mountHostFile(sam.Module, DATA + '1kg.chr22.vcf.gz', '/shared/data/1kg.chr22.vcf.gz');
mountHostFile(sam.Module, DATA + '1kg.chr22.vcf.gz.tbi', '/shared/data/1kg.chr22.vcf.gz.tbi');
console.log(`baseline peakRSS=${hwm().hwm.toFixed(0)}MB (both runtimes + 518MB of lazily mounted human data)`);

console.log('--- samtools on NA12878 chr20 WGS BAM (312MB, ~6M reads) ---');
ioStats.reset();
let r = run(sam, ['view', '-H', '/shared/data/na12878.chr20.bam']);
show('view -H (header only)', r);
ioStats.reset();
r = run(sam, ['view', '-c', '/shared/data/na12878.chr20.bam', '20:10,000,000-10,100,000']);
console.log('   region 100kb reads =', r.outStats.chars);
show('view -c region 100kb', r);
ioStats.reset();
r = run(sam, ['view', '-c', '/shared/data/na12878.chr20.bam', '20:10,000,000-15,000,000']);
console.log('   region 5Mb reads =', r.outStats.chars);
show('view -c region 5Mb', r);
ioStats.reset();
r = run(sam, ['idxstats', '/shared/data/na12878.chr20.bam']);
show('idxstats (index-only)', r);
ioStats.reset();
r = run(sam, ['flagstat', '/shared/data/na12878.chr20.bam']);
show('flagstat (full 312MB scan)', r);
ioStats.reset();
r = run(sam, ['view', '-c', '/shared/data/na12878.chr20.bam']);
console.log('   total reads =', r.outStats.chars);
show('view -c (full 312MB scan)', r);
ioStats.reset();
r = run(sam, ['view', '-b', '/shared/data/na12878.chr20.bam', '20:10,000,000-15,000,000', '-o', '/shared/out/region5m.bam']);
console.log('   out size =', (FS.stat('/shared/out/region5m.bam').size / 1048576).toFixed(1), 'MB');
show('view -b region 5Mb -> file', r);

console.log('--- bcftools on 1000G chr22 VCF.gz (206MB, 2504 samples) ---');
ioStats.reset();
r = run(bcf, ['view', '-h', '/shared/data/1kg.chr22.vcf.gz']);
show('view -h (header)', r);
ioStats.reset();
r = run(bcf, ['view', '-H', '-r', '22:17000000-17100000', '/shared/data/1kg.chr22.vcf.gz']);
console.log('   region 100kb out chars =', r.outStats.chars);
show('view -H -r 100kb region', r);
ioStats.reset();
r = run(bcf, ['view', '-H', '-r', '22:17000000-18000000', '-v', 'snps', '/shared/data/1kg.chr22.vcf.gz']);
console.log('   1Mb snps-only out chars =', r.outStats.chars);
show('view -H -r 1Mb -v snps', r);
ioStats.reset();
r = run(bcf, ['view', '-H', '-i', 'INFO/AF>0.5', '-r', '22:16000000-18000000', '/shared/data/1kg.chr22.vcf.gz']);
console.log('   filtered AF>0.5 out chars =', r.outStats.chars);
show('view -i AF>0.5 2Mb region', r);
ioStats.reset();
r = run(bcf, ['query', '-f', '%CHROM\t%POS\t%REF\t%ALT\t%AF\n', '-r', '22:17000000-17500000', '/shared/data/1kg.chr22.vcf.gz']);
console.log('   query 500kb out chars =', r.outStats.chars);
show('query -f 500kb region', r);
ioStats.reset();
r = run(bcf, ['view', '-H', '-i', 'INFO/AF>0.3', '-o', '/dev/null', '/shared/data/1kg.chr22.vcf.gz']);
console.log('   FULL-FILE filter AF>0.3 out chars =', r.outStats.chars);
show('view -i AF>0.3 FULL 206MB scan', r);

console.log('--- pipeline: samtools region -> file -> bcftools/bedtools consume ---');
ioStats.reset();
r = run(sam, ['view', '-b', '/shared/data/na12878.chr20.bam', '20:10,000,000-10,500,000', '-o', '/shared/out/p.bam']);
const bamSz = FS.stat('/shared/out/p.bam').size;
r = run(sam, ['index', '/shared/out/p.bam']);
r = run(sam, ['idxstats', '/shared/out/p.bam']);
show('samtools: region->bam + index + idxstats', r);
// depth profile -> file
ioStats.reset();
r = run(sam, ['depth', '-a', '-r', '20:10,000,000-10,010,000', '/shared/data/na12878.chr20.bam', '-o', '/shared/out/depth.txt']);
const d = FS.stat('/shared/out/depth.txt').size;
console.log(`   depth -a 10kb -> ${(d / 1024).toFixed(0)}KB file`);
show('samtools depth -a 10kb -> file', r);
process.exit(0);
