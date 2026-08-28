// test8b: isolate bedtools 1M OOM — wasm heap vs V8 heap vs output capture
import { loadTool, initShared, run } from './harness.mjs';

const quiet = process.argv.includes('--quiet');
const bed = await loadTool('bedtools', { quiet });
initShared(bed);
const FS = bed.Module.FS;

function genBedSorted(n, file, seed = 1, meanLen = 200, chroms = 24) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const lines = new Array(n);
  let idx = 0;
  for (let c = 1; c <= chroms && idx < n; c++) {
    const cnt = Math.min(Math.ceil(n / chroms), n - idx);
    const starts = Array.from({ length: cnt }, () => (rnd() * 240_000_000) | 0).sort((a, b) => a - b);
    for (const st of starts) {
      if (idx >= n) break;
      lines[idx++] = `chr${c}\t${st}\t${st + 1 + ((rnd() * meanLen) | 0)}\n`;
    }
  }
  const str = lines.join('');
  FS.writeFile(file, new TextEncoder().encode(str));
  return str.length;
}

const N = Number(process.argv.find(a => a.startsWith('--n='))?.slice(4) ?? 1_000_000);
console.log(`N=${(N / 1e6).toFixed(1)}M quiet=${quiet}`);
const t0 = performance.now();
const aSize = genBedSorted(N, '/shared/data/a.bed', 42);
const bSize = genBedSorted(Math.max(1, Math.round(N / 10)), '/shared/data/b.bed', 7);
console.log(`gen ${((performance.now() - t0) / 1000).toFixed(1)}s a=${(aSize / 1048576).toFixed(1)}MB b=${(bSize / 1048576).toFixed(1)}MB v8=${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB rss=${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`);

const samp = { maxV8: 0, maxRss: 0, maxWasm: 0 };
const iv = setInterval(() => {
  const m = process.memoryUsage();
  samp.maxV8 = Math.max(samp.maxV8, m.heapUsed / 1048576);
  samp.maxRss = Math.max(samp.maxRss, m.rss / 1048576);
  samp.maxWasm = Math.max(samp.maxWasm, bed.Module.HEAPU8.length / 1048576);
}, 30);

let r = run(bed, ['intersect', '-sorted', '-a', '/shared/data/a.bed', '-b', '/shared/data/b.bed']);
clearInterval(iv);
console.log(`intersect -sorted: ${r.ms}ms out=${JSON.stringify(r.outStats)} wasmMax=${samp.maxWasm.toFixed(0)}MB v8Max=${samp.maxV8.toFixed(0)}MB rssMax=${samp.maxRss.toFixed(0)}MB err=${r.err.slice(0, 80)}`);

samp.maxV8 = samp.maxRss = samp.maxWasm = 0;
r = run(bed, ['intersect', '-a', '/shared/data/a.bed', '-b', '/shared/data/b.bed']);
clearInterval(iv);
console.log(`intersect default: ${r.ms}ms out=${JSON.stringify(r.outStats)} wasmMax=${samp.maxWasm.toFixed(0)}MB v8Max=${samp.maxV8.toFixed(0)}MB rssMax=${samp.maxRss.toFixed(0)}MB err=${r.err.slice(0, 80)}`);
process.exit(0);
