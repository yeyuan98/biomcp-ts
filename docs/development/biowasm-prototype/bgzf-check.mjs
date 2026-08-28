// Independent BGZF validator (pure Node zlib, no wasm)
import { readFileSync } from 'node:fs';
import { inflateRawSync, crc32 } from 'node:zlib';

const HOST = process.argv[2] ?? '/home/administrator/temp/biowasm/data/na12878.chr20.bam';
const buf = readFileSync(HOST);
console.log('file size:', buf.length);
let off = 0, blocks = 0, bad = [];
while (off < buf.length) {
  const remaining = buf.length - off;
  if (remaining < 18) { console.log('trailing bytes at', off, ':', remaining); break; }
  // gzip header
  if (!(buf[off] === 0x1f && buf[off + 1] === 0x8b)) { bad.push(['magic', off]); break; }
  const bsizeOff = off + 14; // 1f8b(2) FLG.. : magic2 CM1 FLG1 MTIME4 XFL1 OS1 XLEN2 SI1 SI2 SLEN2 BSIZE2 => off+16..17
  const bsize = buf.readUInt16LE(off + 16) + 1;
  if (off + bsize > buf.length) { bad.push(['block-truncated', off]); break; }
  const block = buf.subarray(off, off + bsize);
  // payload: after 18-byte header, before 8-byte footer
  const payload = block.subarray(18, bsize - 8);
  const crc = block.readUInt32LE(bsize - 8);
  const isize = block.readUInt32LE(bsize - 4);
  try {
    const out = inflateRawSync(payload);
    const crcCalc = crc32 ? crc32(out) : null;
    if (out.length !== isize) bad.push(['isize', off, isize, out.length]);
    if (crcCalc !== null && crcCalc !== crc) bad.push(['crc32', off]);
  } catch (e) {
    bad.push(['inflate-fail', off, String(e).slice(0, 60)]);
  }
  blocks++;
  off += bsize;
}
console.log('blocks:', blocks, 'bad:', JSON.stringify(bad.slice(0, 5)));
console.log(bad.length === 0 ? 'FILE VALID (all BGZF blocks pass CRC32+ISIZE)' : 'FILE CORRUPT');
process.exit(bad.length === 0 ? 0 : 1);
