# CI & Dependency Automation

How the continuous-integration wheels fit together in this repo: what runs, what
guards `main`, and how Dependabot PRs flow from alert to auto-merge. For build
and test details see [../DEVELOPMENT.md](../DEVELOPMENT.md); for runtime
configuration see [../ENV-VARS.md](../ENV-VARS.md).

## The moving parts

| Piece | File | Role |
|---|---|---|
| Gate pipeline | `.github/workflows/ci.yml` | Two parallel jobs on every PR and push to `main`: required gate `ci` + advisory `integration` (see below) |
| Auto-merge | `.github/workflows/dependabot-automerge.yml` | Merges qualifying Dependabot PRs after `ci` passes |
| R WASM mirror release | `.github/workflows/r-wasm-mirror.yml` | On version bump to `main`, builds (or copy-forwards) the R-analysis wasm package bundle and publishes it as the release asset end-user servers download at first use; fresh builds are gated by golden numeric validation (`scripts/ranalysis/validate-bundle.mjs`) |
| Dependabot config | `.github/dependabot.yml` | Weekly lockfile-only version updates + grouped security updates |
| Branch ruleset | GitHub UI: "main no delete" | Blocks deletion/force-push; requires a PR + the `ci` check |

## The gate pipeline (`ci.yml`)

Two jobs run in parallel on every PR and push to `main`: the required gate
`ci` (this section) and the advisory `integration` tier (next section).

The gate is a single job, id `ci` — the job id **is** the status-check name
the ruleset requires, so it must not be renamed or matrixed without updating
the ruleset.

Gates in order, each failing the build on error:

1. `npm ci` — installs exactly from `package-lock.json`
2. `make typecheck` — both `src/` and `scripts/` tsconfigs
3. `npm test` — the 1300+ mocked unit tests (integration tests are excluded
   via the npm script; they run in the separate `integration` job)
4. `npm run build` — `tsc` + the two esbuild bundles
5. `npm audit --audit-level=low` — **full** audit, not `--omit=dev`
6. stdio MCP handshake smoke — sends one NDJSON `initialize` request to
   `dist/bundle.js` and requires a `serverInfo` response

**Expected log noise in the unit-test step (not failures):** the suite
intentionally exercises mocked error paths, so `console.error` lines like
`[fetchProtein] Error: UniProt is down`, `Network timeout`, or
`SemanticScholar search timed out after 15000ms` — plus `[retry] Attempt X/Y
failed, retrying in Zms` backoff warnings — are the tests' subject matter,
asserted to degrade gracefully. Other known benign noise: a `glob@10`
deprecation warning at install time (transitive via istanbul/test-exclude,
dev-only, not bundled into `dist/`) and the occasional post-job
`Failed to save: Unable to reserve cache ...` (a `setup-node` cache race
between concurrent runs). The test scripts pass
`--disable-warning=ExperimentalWarning` to suppress Node's VM Modules /
`node:sqlite` warnings, which are inherent to
`node --experimental-vm-modules`.

**Why the full audit:** runtime code is *bundled from devDependencies*
(`fast-xml-parser` and friends end up inside `dist/bundle.js`; the only runtime
`dependencies` entry is `undici`). `npm audit --omit=dev` reports 0 even when a
shipped vulnerability exists, so it is a false-negative gate by construction
here.

**sprintf-js history (no allowlist entry remains):** `GHSA-hp3w-g68c-fv3c`
(sprintf-js DoS) was previously allowlisted — every version of sprintf-js is
vulnerable and the package is abandoned upstream. It was removed from the tree
entirely via the `argparse` npm override in `package.json` (it was reachable
only inside jest's `@istanbuljs/load-nyc-config -> js-yaml@3 -> argparse@1`
chain, whose library paths never load argparse), so the audit now runs
unfiltered and fails on any advisory.

**Why the smoke test uses NDJSON:** MCP over stdio is newline-delimited JSON.
An LSP-style `Content-Length: ...` framed request yields no response and the
test would silently degrade to checking nothing. Keep stdin open briefly
(`sleep 2`) or the server may exit before flushing.

## Integration tier & merge checklist

The same workflow runs a second job, id/name `integration`, in parallel with
`ci` (no `needs` between them). It runs the keyless live-API suites via
`jest.integration.config.ts` with `--runInBand`; env-gated suites (db,
biowasm/ranalysis mirror, depmap) self-skip in CI via `describe.skip`,
exactly as they do locally in a bare environment.

Since #164 the job is **two-tier on GitHub Actions**:

1. **Gating step** — every integration suite *except* four known
   GitHub-runner offenders, still with NO `continue-on-error`: any failure
   here fails the job exactly as before.
2. **Best-effort known-offenders step** — ONLY the four pinned offender
   files, run with `continue-on-error: true` (and `if: always()`), teed to
   `known-offenders.log`:

   - `src/__tests__/integration/tools/ensembl-tools.test.ts` — Ensembl REST
     (rest.ensembl.org) intermittently throttles shared GitHub runner IPs;
   - `src/__tests__/integration/tools/article-tools.test.ts` — arXiv cases
     (`searchArxiv` TimeoutError from runner IPs);
   - `src/__tests__/integration/tools/gene-tools.test.ts` — `gene_articles`
     article-source legs return pmid-less rows from runner IPs (#182);
   - `src/__tests__/integration/tools/drug-tools.test.ts` — openfda
     (api.fda.gov) transient 500s, retryable (#182).

   Their intermittent flakes stay visible — own step-summary section
   labeled non-gating, own `known-offenders-log` artifact uploaded on every
   run — but can never fail the job.

The offender list is **pinned in `ci.yml`**: exactly those four paths, no
others. ANY addition requires (1) a GitHub issue with triage evidence per
the rubric below and (2) an explicit maintainer decision — a new flaky
suite still gates and gets triaged like any other failure; per the
2026-10-19 policy (#182), a *confirmed* unstable upstream goes on the list
rather than burning reruns. Timeout
increases are off the table (maintainer decision, 2026-10-18): they are
already generous; the failures are runner-side network conditions.

**Local runs are unchanged and authoritative:** `npm run
test:integration` / `make test-integration` still runs every suite —
offenders included — and fails on any failure. The split exists only
inside the GitHub Actions job, because GitHub-hosted runner IP ranges are
the environmental variable; your machine is not.

What the two checks mean on a PR:

- **`ci`** — the required gate (typecheck / unit / build / audit / smoke).
  Must be green to merge; the ruleset enforces it.
- **`integration`** — **advisory but MANDATORY-REVIEW.** It has no
  `continue-on-error`, so failures render as a red ✗ named `integration` in
  the checks list — impossible to overlook. It is deliberately NOT a required
  check, so it never blocks merge mechanically: shared GitHub runner IPs get
  rate-limited/geo-blocked by upstream biomedical APIs intermittently, and
  hard-failing every PR on that would stall all work. The deal is: the red ✗
  never blocks the merge button, but **no merge happens without triage** of
  every red integration run.

**Standardized pre-merge step (do this on every PR):**

1. Open the `integration` check on the PR's checks list.
2. Read the **Step Summary** — the `Integration failure summary` step renders
   a verdict header (`❌ N failed — triage before merging` or
   `✅ N passed / all green`), a `Suite | Failed test` table, and the verbatim
   jest totals for the gating step, followed by a `Known-offender tier
   (non-gating)` section for the ensembl/arXiv step (informational only).
   The raw jest output is attached as the `integration-log` artifact
   whenever the job fails (the `known-offenders-log` artifact uploads on
   every run), for full context beyond the table.
3. Bucket **every** failure in the **gating** table into exactly one of:

   | Bucket | Meaning | Action |
   |---|---|---|
   | (a) upstream | live API rate-limited / timed out / geo-blocked the runner | note it in the PR and merge |
   | (b) test-design | the assertion is brittle against volatile live data | file an issue, then merge |
   | (c) code defect | the contract under test is genuinely broken | **fix before merging** |

Rubric examples from the 2026-10-15 audit (the incident that created this
checklist — integration failures had hidden behind a green `ci` for six
merges):

- **Upstream (a):** the ensembl 60 s-timeout family — REST/Ensembl endpoints
  slow or refusing runner IPs; the code is fine, the network wasn't.
- **Test-design (b):** patent Szostak `co_cited_by` NaN floor (the live
  patent pool no longer carries ≥2 co-citations for that entry, so
  `Number(undefined) >= 2` fails) and the placeholder-OPS
  `undefined`-vs-`false` assertion (coverage-note shape drifted behind a
  flag neither side asserts deliberately).
- **Code defect (c):** `gene_enrich` reported `genes_overlap: 11` for a
  10-unique-gene input — a dedup invariant violation (issue #85), fixed
  before merge.

**Local reproduction:** `make test-integration` (the npm script needs the
ESM launcher — see [src/__tests__/README.md](../../src/__tests__/README.md)).
Caveat: a local WSL2 clock that has drifted makes token-bucket rate limiters
and TLS certificate checks fail spuriously in ways that never happen on CI
runners — resync the clock (restart WSL / NTP sync) before trusting a local
red run, and treat **CI as authoritative** when deciding whether a flake is
real.

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
npm audit --audit-level=low    # 5. full audit (unfiltered; see sprintf-js history above)
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
