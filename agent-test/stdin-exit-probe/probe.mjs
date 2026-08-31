// Stdin-close exit probe (e2e follow-up F5 evidence).
//
// The MCP SDK's stdio transport listens for `data`/`error` only and has no
// exit path. Nuance found while building this probe: with NO background
// handles, Node idles out on its own after stdin closes — the orphan case is
// specifically "background handles (webR worker, in-flight ops) hold the
// event loop". So the faithful reproduction boots the R worker first
// (fast when the wasm bundle is already in ~/.cache/biomcp), then closes
// stdin and watches.
//
// Usage: node probe.mjs <node-bundle-path>
//   env:  PROBE_CALL_R=1      boot the R engine (needs ANALYSIS_R=1 +
//                             reachable/cached wasm bundle) before closing
// Expected: 0.9.0 + PROBE_CALL_R=1 -> LINGER; 0.9.1+ -> EXIT (~2 s grace).

import { spawn } from 'node:child_process';

const bundle = process.argv[2];
if (!bundle) {
  console.error('usage: node probe.mjs <node-bundle-path>');
  process.exit(2);
}

const child = spawn(process.execPath, [bundle], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });

let buf = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});
function rpc(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error('rpc timeout waiting for ' + method)), timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const t0 = Date.now();
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stdin-exit-probe', version: '0' } });
console.log('initialized:', init.serverInfo.name + '@' + init.serverInfo.version);

if (process.env.PROBE_CALL_R === '1') {
  console.log('booting R engine (analysis_r_session_info)…');
  try {
    const res = await rpc('tools/call', { name: 'analysis_r_session_info', arguments: {} }, 180000);
    const text = (res.content ?? []).map((c) => c.text ?? '').join(' ').slice(0, 120);
    console.log('R up:', text.replace(/\s+/g, ' '));
  } catch (e) {
    console.log('R call failed (continuing anyway):', e.message);
  }
}

// Simulate the dead client: close our write end. The server's stdin receives
// FIN and emits 'end' — the 0.9.1 guard exits the process even while the
// webR worker holds the event loop; 0.9.0 lingers.
child.stdin.end();

const verdict = await new Promise((resolve) => {
  const killTimer = setTimeout(() => { console.log('RESULT: LINGER (no exit within 15s)'); child.kill('SIGKILL'); resolve('LINGER'); }, 15000);
  child.on('exit', (code, signal) => { clearTimeout(killTimer); console.log(`RESULT: EXIT (code=${code} signal=${signal})`); resolve('EXIT'); });
});
console.log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(verdict === 'EXIT' ? 0 : 1);

