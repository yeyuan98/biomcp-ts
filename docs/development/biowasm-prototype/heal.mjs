// heal.mjs — patch corrupt BGZF blocks via ranged re-fetch until file validates
import { readFileSync, writeFileSync, openSync, readSync, closeSync, statSync, read } from 'node:fs';
import { inflateRawSync, crc32 } from 'node:zlib';
import { execSync } from 'node:child_process';

const HOST = process.argv[2];
const URL = process.argv[3];

function validateBuffer(buf, startOff = 0, endOff = buf.length) {
  let off = startOff, bad = null;
  while (off < endOff) {
    const remaining = endOff - off;
    if (remaining < 18) break;
    if (!(buf[off] === 0x1f && buf[off + 1] === 0x8b)) return { bad: off, why: 'magic' };
    const bsize = buf.readUInt16LE(off + 16) + 1;
    if (off + bsize > endOff) return { bad: off, why: 'truncated' };
    const block = buf.subarray(off, off + bsize);
    const payload = block.subarray(18, bsize - 8);
    const crc = block.readUInt32LE(bsize - 8);
    const isize = block.readUInt32LE(bsize - 4);
    try {
      const out = inflateRawSync(payload);
      if (out.length !== isize || (crc32 && crc32(out) !== crc)) return { bad: off, why: `bad-block@${off}` };
    } catch { return { bad: off, why: `inflate@${off}` }; }
    off += bsize;
  }
  return { bad: null, blocks: Math.round((off - startOff) / 65536) };
}

let buf = readFileSync(HOST);
for (let round = 1; round <= 20; round++) {
  const v = validateBuffer(buf);
  if (!v.bad) { console.log('VALID after', round - 1, 'patches; size', buf.length); writeFileSync(HOST, buf); process.exit(0); }
  console.log(`round ${round}: corrupt at ${v.bad} (${v.why}); fetching range ${v.bad}-${v.bad + 65535}`);
  const range = execSync(`curl -s -r ${v.bad}-${v.bad + 65535} "${URL}"`);
  console.log('  got', range.length, 'bytes');
  buf.set(range.subarray(0, Math.min(range.length, buf.length - v.bad)), v.bad);
}
console.log('FAILED after 20 rounds');
process.exit(1);
