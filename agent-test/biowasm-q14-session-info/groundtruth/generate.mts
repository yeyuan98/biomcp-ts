// Q14 GT: pinned tool versions from src/biowasm/registry.ts (the session-info source).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { freezeJson, shutdown, REPO } from './common.mts';

const registry: any = await import(join(REPO, 'src/biowasm/registry.js'));
const versions: Record<string, string> = {};
for (const name of registry.BIOWASM_TOOLS_ORDER) versions[name] = registry.BIOWASM_TOOLS[name].version;
mkdirSync('../expected', { recursive: true });
freezeJson('../expected', 'q14-versions.json', {
  tools: versions,
  expected_in_output: '1.21',
});
await shutdown();
process.exit(0);
