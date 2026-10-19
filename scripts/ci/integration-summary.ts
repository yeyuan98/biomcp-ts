/* Build the GitHub Step Summary for the CI integration tier.
 *
 * Usage: node --import tsx scripts/ci/integration-summary.ts <log> \
 *          [--title <header prefix>] [--artifact <name>] [--non-gating]
 *
 * Called twice from the `integration` job in .github/workflows/ci.yml (the
 * two-tier contract of issue #164), after each jest run is teed to a log:
 *  1. gating run   — integration.log (defaults: title "Integration tier",
 *     artifact integration-log, gating semantics with the triage rubric);
 *  2. known-offender run — known-offenders.log with --title
 *     "Known-offender tier (non-gating)" --artifact known-offenders-log
 *     --non-gating (verdict headers say so; the rubric trailer is replaced
 *     by the known-offender note so a flake is never mistaken for a
 *     must-triage regression).
 *
 * Parses the jest output (plain, or timestamp-prefixed raw GitHub job-log
 * form) and appends a summary to $GITHUB_STEP_SUMMARY: verdict header,
 * failed-suite / failed-test table, verbatim totals, and the tier-specific
 * trailer.
 *
 * Robustness contract: a missing, empty, or unparseable log must still
 * produce a summary that says so — this script never throws and never
 * changes the job's exit status (the test step owns pass/fail).
 *
 * Offline validation (2026-10-16, raw CI logs cached under /tmp/cilogs):
 *   run-38768791257.log → ❌ 3 failed / 149 passed; suites patent-tools +
 *     gene-tools; tests: Szostak co_cited_by, placeholder-OPS backoff,
 *     gene_enrich contract (matches audit ground truth).
 *   run-38691862806.log → ❌ 1 failed / 139 passed; suite patent-tools;
 *     test: Szostak co_cited_by (matches audit ground truth).
 *   synthetic all-green log → ✅ N passed / all green, no table.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/** Timestamp prefix of raw GitHub job logs: `2026-10-15T16:27:48.2400576Z `. */
const TS_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z[ \t]/;
/** ANSI SGR (and other CSI) sequences — code frames carry them, results lines can. */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
/** `FAIL src/__tests__/integration/tools/gene-tools.test.ts (20.027 s)` */
const FAIL_LINE = /^FAIL\s+(\S+)(?:\s|\()/;
/** `  ● patent_search › discovers seminal prior art …` (jest failure detail bullet) */
const BULLET = /^\s*●\s+(.+?)\s*$/;
const TOTALS_LINE = /^(Test Suites:|Tests:)\s*(.+)$/;

/** Strip job-log timestamp prefix and ANSI escapes from one line. */
function clean(line: string): string {
  return line.replace(TS_PREFIX, '').replace(ANSI, '');
}

/** Shorten a suite path to `src/__tests__/…` repo-relative form. */
function shorten(path: string): string {
  let p = path.replace(/^\.?\//, '');
  const marker = 'src/__tests__/';
  const i = p.indexOf(marker);
  if (i > 0) p = p.slice(i); // absolute-path / monorepo-prefix safety net
  return p;
}

/** Escape a cell for the Markdown table: backslash first, then `|`, so a
 * crafted `\|` cannot un-escape the pipe and break the row (CodeQL
 * js/incomplete-sanitization). */
function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

interface Parsed {
  failSuites: string[]; // ordered, deduped FAIL paths
  failures: { suite: string; test: string }[]; // deduped (suite, test) pairs
  suiteTotals: string; // verbatim `Test Suites:` line ('' if absent)
  testTotals: string; // verbatim `Tests:` line ('' if absent)
  failedCount: number; // from the Tests: line; -1 when absent
  passedCount: number; // from the Tests: line; -1 when absent
}

function parse(raw: string): Parsed {
  const failSuites: string[] = [];
  const failures: { suite: string; test: string }[] = [];
  const seen = new Set<string>();
  let currentSuite = ''; // most recent FAIL path; bullets belong to it
  let suiteTotals = '';
  let testTotals = '';
  let failedCount = -1;
  let passedCount = -1;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = clean(rawLine);

    const fail = line.match(FAIL_LINE);
    if (fail) {
      const path = shorten(fail[1]);
      currentSuite = path;
      if (!failSuites.includes(path)) failSuites.push(path);
      continue;
    }

    const bullet = line.match(BULLET);
    if (bullet && bullet[1] !== 'Console') {
      // `● Console` bullets are per-suite console output, not failures.
      const suite = currentSuite || '(suite unknown — no FAIL line seen)';
      const key = `${suite}\u0000${bullet[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        failures.push({ suite, test: bullet[1] });
      }
      continue;
    }

    // Keep the LAST totals block (a raw job log may contain the unit-run
    // totals before the integration-run totals; the integration one wins).
    const totals = line.match(TOTALS_LINE);
    if (totals) {
      if (totals[1] === 'Test Suites:') suiteTotals = totals[2].trim();
      else {
        testTotals = totals[2].trim();
        // jest omits the "failed"/"passed" segment when its count is zero,
        // so absence inside a present Tests: line means 0, not "unknown".
        failedCount = Number(testTotals.match(/(\d+)\s+failed/)?.[1] ?? 0);
        passedCount = Number(testTotals.match(/(\d+)\s+passed/)?.[1] ?? 0);
      }
    }
  }
  return { failSuites, failures, suiteTotals, testTotals, failedCount, passedCount };
}

/** Which CI tier a summary describes (two-tier contract, issue #164). */
interface TierOpts {
  /** Header prefix, e.g. `Integration tier` or `Known-offender tier (non-gating)`. */
  title: string;
  /** Artifact name quoted in the trailer (`integration-log`, `known-offenders-log`). */
  artifact: string;
  /** Non-gating tiers swap the triage rubric for a known-offender note. */
  nonGating: boolean;
}

function buildSummary(logPath: string, tier: TierOpts): string {
  const out: string[] = [];

  if (!existsSync(logPath)) {
    out.push(`## ${tier.title}: ⚠️ no log to summarize`, '',
      `Log \`${logPath}\` was not found — the test step may not have run.`,
      'Check the job log directly; the triage checklist still applies:',
      '[docs/development/CI.md](docs/development/CI.md#integration-tier--merge-checklist).');
    return out.join('\n');
  }

  const parsed = parse(readFileSync(logPath, 'utf8'));
  const failSuffix = tier.nonGating ? ' — non-gating, no triage required' : ' — triage before merging';

  // Verdict header: prefer the `Tests:` totals line; fall back to FAIL lines.
  const header =
    parsed.failedCount > 0
      ? `## ${tier.title}: ❌ ${parsed.failedCount} failed${failSuffix}`
      : parsed.failedCount === 0
        ? `## ${tier.title}: ✅ ${parsed.passedCount >= 0 ? `${parsed.passedCount} passed / ` : ''}all green`
        : parsed.failSuites.length > 0
          ? `## ${tier.title}: ❌ ${parsed.failSuites.length} suite${parsed.failSuites.length === 1 ? '' : 's'} failed${failSuffix}`
          : `## ${tier.title}: ✅ no failures detected`;
  out.push(header, '');

  if (parsed.failSuites.length > 0 || parsed.failures.length > 0) {
    out.push('| Suite | Failed test |', '| --- | --- |');
    const rows = parsed.failures.map(f => `| \`${cell(f.suite)}\` | ${cell(f.test)} |`);
    if (rows.length > 0) out.push(...rows);
    else {
      // Suites failed but no `●` bullets were parseable (e.g. suite-level error).
      for (const s of parsed.failSuites) out.push(`| \`${cell(s)}\` | (suite-level failure — see artifact log) |`);
    }
    out.push('');
    if (parsed.suiteTotals || parsed.testTotals) {
      out.push('```', parsed.suiteTotals && `Test Suites: ${parsed.suiteTotals}`,
        parsed.testTotals && `Tests:       ${parsed.testTotals}`, '```', '');
    }
  } else if (parsed.failedCount === 0) {
    if (tier.nonGating) {
      out.push('Both known-offender suites (ensembl-tools, article-tools) passed this',
        'run — the runner IPs got through to Ensembl/arXiv this time.', '');
    } else {
      out.push('All integration suites that ran passed. Env-gated suites (db, biowasm/', 'ranalysis mirror, depmap) self-skip in CI as expected.', '');
    }
  } else {
    out.push('No `FAIL` lines or failure bullets were parseable from the log —', 'inspect the raw output before merging.', '');
  }

  out.push('---', '');
  if (tier.nonGating) {
    out.push('**Known GitHub-runner offenders (issue #164):** these two suites',
      '(`ensembl-tools` — Ensembl REST; `article-tools` arXiv cases) fail',
      'intermittently from GitHub-hosted runner IPs — upstream throttling of',
      'shared runner ranges, not code, and per-run-varying subsets that pass',
      'on rerun. This tier runs best-effort with `continue-on-error`: a red',
      'result here does **not** fail the `integration` job and needs no',
      'per-failure triage.',
      '',
      `The raw log is uploaded as the \`${tier.artifact}\` artifact on every run.`,
      'Local runs remain authoritative for these suites: `make test-integration`',
      'runs them and fails on any failure (local WSL2 clock skew can cause',
      'spurious token-bucket / TLS failures — resync before trusting a local red).');
  } else {
    out.push('**Before merging, bucket every failure (triage rubric — details in',
      '[docs/development/CI.md](docs/development/CI.md#integration-tier--merge-checklist)):**',
      '',
      '- **(a) Upstream** — rate-limit / timeout / geo-block from a live API: note it in the PR.',
      '- **(b) Test-design** — brittle assertion against volatile live data: file an issue.',
      '- **(c) Code defect** — the contract under test is actually broken: fix before merging.',
      '',
      `The raw log is uploaded as the \`${tier.artifact}\` artifact when this job fails.`,
      'Reproduce locally: `make test-integration`. Note: local WSL2 clock skew can',
      'cause spurious token-bucket / TLS failures that never occur on CI runners, so',
      'CI is authoritative when triaging flakes.');
  }
  return out.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  let title = 'Integration tier';
  let artifact = 'integration-log';
  let nonGating = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--title' && i + 1 < args.length) title = String(args[++i]);
    else if (arg === '--artifact' && i + 1 < args.length) artifact = String(args[++i]);
    else if (arg === '--non-gating') nonGating = true;
    else positional.push(arg);
  }
  const logPath = positional[0];
  if (!logPath) {
    console.error('usage: integration-summary.ts <log> [--title <prefix>] [--artifact <name>] [--non-gating]');
    process.exit(0); // never fail the job from the summarizer itself
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY ?? '';
  const body = buildSummary(logPath, { title, artifact, nonGating });
  if (summaryPath) {
    // Append (the file may not exist yet or may already hold earlier content).
    const existing = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
    appendFileSync(summaryPath, (existing && !existing.endsWith('\n') ? '\n\n' : existing ? '\n' : '') + body + '\n');
  }
  // Echo for the job log so the summary is visible even without the UI.
  console.log(body);
}

main();
