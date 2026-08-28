// test11: production shape — engine in worker_thread, RPC from main, termination of stuck runs
import { Worker } from 'node:worker_threads';

const workerSrc = `
const { parentPort } = require('node:worker_threads');
const { loadTool, initShared, mountHostFile, run } = require('/home/administrator/temp/biowasm/assets/worker-loader.cjs');
(async () => {
  const sam = await loadTool('samtools', { quiet: true });
  initShared(sam);
  mountHostFile(sam.Module, '/home/administrator/temp/biowasm/data/na12878.chr20.bam', '/shared/data/na12878.chr20.bam');
  mountHostFile(sam.Module, '/home/administrator/temp/biowasm/data/na12878.chr20.bam.bai', '/shared/data/na12878.chr20.bam.bai');
  parentPort.on('message', (msg) => {
    if (msg.cmd === 'run') {
      const r = run(sam, msg.args);
      parentPort.postMessage({ id: msg.id, ms: r.ms, outChars: r.outStats.chars, heapMB: r.heapMB });
    } else if (msg.cmd === 'mem') {
      parentPort.postMessage({ id: msg.id, rss: process.memoryUsage().rss });
    }
  });
  parentPort.postMessage({ ready: true });
})();
`;

const { writeFileSync } = await import('node:fs');
writeFileSync('/tmp/opencode/worker-src.cjs', workerSrc);

const worker = new Worker('/tmp/opencode/worker-src.cjs');
const results = await new Promise((resolve) => {
  const pending = new Map();
  let id = 0;
  worker.on('message', (m) => {
    if (m.ready) {
      console.log('[main] worker ready');
      // fire a region query + full scan via RPC
      const send = (args) => new Promise((res) => {
        const mid = ++id;
        pending.set(mid, res);
        worker.postMessage({ cmd: 'run', id: mid, args });
      });
      (async () => {
        const t0 = Date.now();
        let r = await send(['view', '-c', '/shared/data/na12878.chr20.bam', '20:10000000-10100000']);
        console.log('[main] RPC region:', JSON.stringify(r), `roundtrip ${Date.now() - t0}ms`);
        r = await send(['flagstat', '/shared/data/na12878.chr20.bam']);
        console.log('[main] RPC full flagstat:', JSON.stringify(r));
        resolve(pending);
      })();
      // prove main thread is responsive while wasm crunches
      let ticks = 0;
      const iv = setInterval(() => { ticks++; }, 10);
      setTimeout(() => { clearInterval(iv); console.log('[main] event-loop ticks during wasm run:', ticks); }, 3000);
    } else if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
});

// termination test: start a long run, then terminate the worker
const long = new Worker('/tmp/opencode/worker-src.cjs');
await new Promise((res) => long.on('message', (m) => m.ready && res()));
long.postMessage({ cmd: 'run', id: 99, args: ['view', '-i', 'mapq>=0', '/shared/data/na12878.chr20.bam', '-o', '/dev/null'] });
await new Promise((r) => setTimeout(r, 400));
const t0 = Date.now();
await long.terminate();
console.log(`[main] terminate() of mid-run wasm took ${Date.now() - t0}ms — engine discard is viable`);
process.exit(0);
