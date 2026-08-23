import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../version.js';

describe('VERSION', () => {
  it('matches the version in package.json', () => {
    const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
