# CI & Dependency Automation

How the continuous-integration wheels fit together in this repo: what runs, what
guards `main`, and how Dependabot PRs flow from alert to auto-merge. For build
and test details see [../DEVELOPMENT.md](../DEVELOPMENT.md); for runtime
configuration see [../ENV-VARS.md](../ENV-VARS.md).

## The moving parts

| Piece | File | Role |
|---|---|---|
| Gate pipeline | `.github/workflows/ci.yml` | Runs every gate on every PR and push to `main` |
| Auto-merge | `.github/workflows/dependabot-automerge.yml` | Merges qualifying Dependabot PRs after `ci` passes |
| R WASM mirror release | `.github/workflows/r-wasm-mirror.yml` | On version bump to `main`, builds (or copy-forwards) the R-analysis wasm package bundle and publishes it as the release asset end-user servers download at first use; fresh builds are gated by golden numeric validation (`scripts/ranalysis/validate-bundle.mjs`) |
| Dependabot config | `.github/dependabot.yml` | Weekly lockfile-only version updates + grouped security updates |
| Branch ruleset | GitHub UI: "main no delete" | Blocks deletion/force-push; requires a PR + the `ci` check |

## The gate pipeline (`ci.yml`)

Single job, id `ci` — the job id **is** the status-check name the ruleset
requires, so it must not be renamed or matrixed without updating the ruleset.

Gates in order, each failing the build on error:

1. `npm ci` — installs exactly from `package-lock.json`
2. `make typecheck` — both `src/` and `scripts/` tsconfigs
3. `npm test` — the 900+ mocked unit tests (integration tests are excluded via
   the npm script; they hit live biomedical APIs)
4. `npm run build` — `tsc` + the two esbuild bundles
5. `npm audit --audit-level=low` — **full** audit, not `--omit=dev`
6. stdio MCP handshake smoke — sends one NDJSON `initialize` request to
   `dist/bundle.js` and requires a `serverInfo` response

**Why the full audit:** runtime code is *bundled from devDependencies*
(`fast-xml-parser` and friends end up inside `dist/bundle.js`; the only runtime
`dependencies` entry is `undici`). `npm audit --omit=dev` reports 0 even when a
shipped vulnerability exists, so it is a false-negative gate by construction
here.

**Why the smoke test uses NDJSON:** MCP over stdio is newline-delimited JSON.
An LSP-style `Content-Length: ...` framed request yields no response and the
test would silently degrade to checking nothing. Keep stdin open briefly
(`sleep 2`) or the server may exit before flushing.

## Dependabot: two kinds of PR

- **Security updates** — opened automatically whenever a fixable advisory
  exists, even with no config file (this is how the historical PR flood
  started). `.github/dependabot.yml` shapes but cannot disable them; they are
  grouped into one PR by the `security` group.
- **Version updates** — scheduled (Mondays 09:00 Asia/Shanghai), grouped into
  one minor+patch PR; majors always arrive as individual PRs.

`versioning-strategy: lockfile-only` applies to **both** kinds: PRs only touch
`package-lock.json`. Consequence: a fix that would require a `package.json`
range change (typically direct-dep majors) produces **no PR at all** — the
Security tab is the backstop and still needs occasional human eyes.

## Auto-merge safety model

The guarantee is **`ci` completing successfully on the PR**, not the shape of
the diff. A lockfile-only bump can still change shipped behavior (the
`fast-uri` 3.1.6 bump rewrote URI parsing code bundled into `dist/bundle.js`;
the test suite caught its semantics). The workflow's guards — ci run
PR-triggered and green, actor `dependabot[bot]`, files exactly
`{package-lock.json}`, `dependencies` label, merge pinned to the exact head
commit that passed ci (`--match-head-commit`) — just keep automation confined
to the boring cases.

The workflow triggers on **ci's completion** (`workflow_run`), not on the pull
request. This is deliberate: a `pull_request`-triggered job is itself a pending
check on the PR, so watching checks from inside it would deadlock; firing after
ci finishes avoids that, avoids racing check creation, and keeps this workflow
from appearing as a PR check at all. If ci fails, this workflow never runs —
fail-closed.

Known limits, by design:

- Merges via `GITHUB_TOKEN` do not trigger further workflow runs, so the
  push-to-`main` `ci` run skips automerges (the PR-side run already gated
  them).
- Auto-merge requires the repo setting *Settings → General → Pull Requests →
  Allow auto-merge*; without it the merge step fails visibly (red ✗) after a
  green guard — that is the symptom, not a security issue.
- If `Allow auto-merge` is on but the `ci` check is not yet a *required* status
  check in the ruleset, `gh pr merge --auto` can merge immediately once
  requested. ci already passed at that point (that is the trigger), so the
  residual window is only additional, not-yet-configured branch protections.

## Verifying changes locally

Reproduce every CI gate before pushing:

```bash
npm ci                        # 1. install
make typecheck                # 2. typecheck (src + scripts)
npm test                      # 3. unit tests
npm run build                 # 4. bundles
npm audit --audit-level=low   # 5. full audit (expect: 0)
req='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
out=$({ echo "$req"; sleep 2; } | timeout 15 node dist/bundle.js)
echo "$out" | grep -q '"serverInfo"' && echo SMOKE_OK   # 6. stdio smoke
```

To verify the automerge guard logic without a real Dependabot PR, check the
equivalences: guard passes iff `gh api repos/<repo>/pulls/<n>/files` lists only
`package-lock.json` and the PR carries the `dependencies` label.

## Operations & rollback

- **A Dependabot PR was not auto-merged** — check, in order: did `ci` run on
  it at all (automerge only fires after a successful PR-triggered `ci` run)?
  Did the guard fail (non-lockfile files, missing `dependencies` label — check
  the automerge job log)? Is *Allow auto-merge* enabled in repo settings? If
  `ci` is green and the guards pass, merge manually.
- **Red ✗ on the automerge job of every Dependabot PR** — most likely the
  repo's *Allow auto-merge* setting is off (see above), or the PR carries
  non-lockfile changes (e.g. a manifest edit — those are exactly the ones that
  should stay manual).
- **Ruleset blocks your direct push to `main`** — that is the intended end
  state (PR + required `ci`). Emergency escape hatch: an owner can bypass, or
  temporarily disable the ruleset.
- **Disable automation** — delete the two workflow files and/or set
  `open-pull-requests-limit: 0` in `dependabot.yml`; revert lockfile changes
  with `git revert`. All pieces are additive; nothing else persists state.
