import { describe, it, expect } from '@jest/globals';
import { fetchManifest, parseManifest, selectLatestRelease } from '../../../../scripts/external-databases/depmap/manifest.js';

const liveDescribe = process.env.BIOMCP_DEPMAP_IT ? describe : describe.skip;

liveDescribe('depmap manifest (live)', () => {
  it(
    'fetches the official manifest and resolves the latest DepMap Public release',
    async () => {
      const text = await fetchManifest();
      const rows = parseManifest(text);
      expect(rows.length).toBeGreaterThan(100);
      const release = selectLatestRelease(rows);
      expect(release.name).toMatch(/^DepMap Public \d{2}Q[1-4]$/);
      expect(release.files.size).toBeGreaterThan(10);
      for (const md5 of release.files.values()) {
        expect(md5).toMatch(/^[0-9a-f]{32}$/);
      }
    },
    60000
  );
});
