# Release checklist

Drift guards in `src/__tests__/config/parameters.test.ts` fail CI if any of the
version-bearing files or doc pins go stale — the tests enforce *correctness*;
this document encodes *order*.

## Bump (on the feature branch)

1. `package.json` — `version` **and** `mcpName` (unchanged after first set).
2. `src/version.ts` — `VERSION`.
3. `server.json` — **both** `version` fields (top-level and `packages[0]`).
4. Doc pins `biomcp@<major.minor>` — README.md, docs/AGENT-INSTALL.md,
   docs/R-ANALYSIS.md, docs/DATABASE.md (regex-safe: two segments only, never
   `biomcp@x.y.z`).
5. `CHANGELOG.md` — new Keep-a-Changelog entry.
6. `package-lock.json` — refresh via `npm install --package-lock-only`.
7. `npm run typecheck && npm test && npm run build`; `node dist/cli.js --version`.
8. Commit `chore(release): vX.Y.Z — …` and let a **human merge the PR**
   (GITHUB_TOKEN merges do not fire push events — r-wasm-mirror.yml). On merge,
   CI auto-creates the GitHub release/tag `vX.Y.Z` with the wasm asset.

## Publish (manual, from merged `main`)

9. `git pull && git status` (clean) → `npm ci` → `npm whoami` →
   `npm pack --dry-run` (expect dist/bundle.js + dist/cli.js, no extras) →
   `npm publish` (`--otp=<code>` if 2FA-forced). Never re-publish a version
   already on npm — duplicate versions are rejected permanently.
10. MCP Registry: `mcp-publisher publish` at repo root (login first with
    `mcp-publisher login github` if the token expired). If publish fails after
    step 9, fix `server.json` on main and re-run **`mcp-publisher publish`
    only** — never npm.
11. Context7 refreshes from GitHub `main` automatically after the first
    submission (context7.com/add-library); submit or refresh only after the
    release commit is merged, so indexed doc pins are current.
