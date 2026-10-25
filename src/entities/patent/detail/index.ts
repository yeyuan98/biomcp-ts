import { hasOpsCredentials } from '../ops-client.js';
import { hasOdpKey } from '../search/odp.js';
import type {
  PatentClassificationsSection,
  PatentClaimsSection,
  PatentCitationsSection,
  PatentFamilySection,
  PatentResult,
  PatentSource,
} from '../types.js';
import {
  isValidPublicationNumber,
  kindToStatus,
  kindlessPublicationNumber,
  normalizePublicationNumber,
} from '../search/dedup.js';
import { PATENT_GET_BUDGETS_MS } from './budgets.js';

export { PATENT_GET_BUDGETS_MS } from './budgets.js';

export const PATENT_GET_SECTIONS = ['core', 'abstract', 'claims', 'citations', 'family', 'classifications', 'all'] as const;
export type PatentGetSection = typeof PATENT_GET_SECTIONS[number];

const CLAIMS_UNOFFICIAL_WARNING_EP =
  'claims sourced from Google Patents pages (unofficial mirror); configure EPO_OPS_CONSUMER_KEY/EPO_OPS_CONSUMER_SECRET for authoritative fulltext';
// OPS has no US fulltext (verified — fulltext authorities exclude the US),
// so for US numbers the EPO-keys advice is a dead end: PPUBS is the
// authoritative US source and the honest retry path (issue #209).
const CLAIMS_UNOFFICIAL_WARNING_US =
  'US claims fell back to Google Patents (unofficial rendering); USPTO Public Search (PPUBS) is the authoritative US source — retry later if PPUBS was slow or unreachable';

/**
 * Kind-class-aware served-vs-requested identity check (issues #197/#200):
 * Google Patents redirects and OPS kindless lookups can land on a DIFFERENT
 * document of the same family (e.g. requested EP3904939B1, served
 * EP3904939A1 — same disclosure, different legal status: the exact citation
 * hazard). Compare country code and kind CLASS ({A1,A2,…} application vs
 * {B1,B2,…} grant via kindToStatus) rather than the exact kind code —
 * B1↔B2 is the same text re-issued and must not over-warn. Returns warnings
 * to attach to the record; empty when identity holds or either side carries
 * no kind code to compare.
 */
function identityWarnings(requested: string, served: string | undefined): string[] {
  if (!served) return [];
  const req = normalizePublicationNumber(requested);
  const srv = normalizePublicationNumber(served);
  if (req === srv) return [];
  if (req.slice(0, 2) !== srv.slice(0, 2)) {
    return [`requested ${req} but served ${srv} — different publication authority; verify before citing`];
  }
  const reqKind = req.slice(kindlessPublicationNumber(req).length);
  const srvKind = srv.slice(kindlessPublicationNumber(srv).length);
  if (!reqKind || !srvKind) return [];
  const reqClass = kindToStatus(reqKind);
  const srvClass = kindToStatus(srvKind);
  if (reqClass === srvClass) return [];
  const classWord = (status: string) => (status === 'granted' ? 'grant' : status);
  return [
    `requested ${req} (${classWord(reqClass)}) but served ${srv} (${classWord(srvClass)}) — different document in the same family; verify before citing`,
  ];
}

function isUsNumber(pn: string): boolean {
  return /^US/i.test(pn);
}

function isKindStripped(pn: string): boolean {
  return /^[A-Z]{2}(RE|PP|H)?\d+$/.test(pn);
}

/**
 * One source attempt inside a section chain. `name` keys the per-source
 * failover budget in PATENT_GET_BUDGETS_MS; `run` receives the step signal
 * (step failover timer ∪ phase slice ∪ tool signal) so deadline aborts
 * reach the underlying fetches (issue #209).
 */
export interface ChainSource {
  name: PatentSource;
  run: (signal?: AbortSignal) => Promise<unknown>;
}

/**
 * Build the ordered priority chain of section fetchers for a publication
 * number. Sources whose credentials are absent are skipped silently; hard
 * failures (or step-budget expiries) fall through to the next source.
 */
function sectionChains(publicationNumber: string): Record<string, ChainSource[]> {
  const us = isUsNumber(publicationNumber);
  const chains: Record<string, ChainSource[]> = {};

  const opsCore: ChainSource = {
    name: 'ops',
    run: async (signal) => {
      const { fetchOpsBiblio } = await import('./ops.js');
      const biblio = await fetchOpsBiblio(publicationNumber, signal);
      if (isKindStripped(biblio.publication_number)) {
        biblio.publication_number = normalizePublicationNumber(publicationNumber);
      }
      biblio.source = 'ops';
      // OPS is queried kindless, so the served document can be a different
      // kind than requested (e.g. its A1 when B1 was asked for).
      const warnings = identityWarnings(publicationNumber, biblio.publication_number);
      if (warnings.length > 0) biblio._warnings = warnings;
      return biblio;
    },
  };
  const gpDetail: ChainSource = {
    name: 'google_patents',
    run: async (signal) => {
      const { fetchGooglePatentDetail } = await import('./google-patents.js');
      const parsed = await fetchGooglePatentDetail(publicationNumber, signal);
      const warnings = identityWarnings(publicationNumber, parsed.publication_number);
      const result: PatentResult = {
        publication_number: parsed.publication_number || normalizePublicationNumber(publicationNumber),
        source: 'google_patents',
        title: parsed.title,
        abstract: parsed.abstract,
        publication_date: parsed.publication_date,
        filing_date: parsed.filing_date,
        priority_date: parsed.priority_date,
        assignee: parsed.assignee && parsed.assignee.length > 0 ? parsed.assignee : undefined,
        inventors: parsed.inventors && parsed.inventors.length > 0 ? parsed.inventors : undefined,
        legal_status: parsed.legal_status,
        cpc: parsed.cpc.length > 0 ? parsed.cpc : undefined,
        _warnings: warnings.length > 0 ? warnings : undefined,
      };
      return result;
    },
  };
  const ppubsCore: ChainSource = {
    name: 'ppubs',
    run: async (signal) => {
      const { fetchPpubsCore } = await import('./ppubs.js');
      const core = await fetchPpubsCore(publicationNumber, signal);
      core.source = 'ppubs';
      return core;
    },
  };

  // core / abstract
  const coreChain: ChainSource[] = [];
  const abstractChain: ChainSource[] = [];
  if (hasOpsCredentials()) {
    coreChain.push(opsCore);
    abstractChain.push({
      name: 'ops',
      run: async (signal) => {
        const { fetchOpsAbstract } = await import('./ops.js');
        const abstract = await fetchOpsAbstract(publicationNumber, signal);
        if (!abstract) throw new Error('OPS returned empty abstract');
        return abstract;
      },
    });
  }
  coreChain.push(gpDetail);
  abstractChain.push({
    name: 'google_patents',
    run: async (signal) => {
      const { fetchGooglePatentDetail } = await import('./google-patents.js');
      const parsed = await fetchGooglePatentDetail(publicationNumber, signal);
      if (!parsed.abstract) throw new Error('Google Patents detail has no abstract');
      return parsed.abstract;
    },
  });
  if (us) {
    coreChain.push(ppubsCore);
    abstractChain.push({
      name: 'ppubs',
      run: async (signal) => {
        const { fetchPpubsCore } = await import('./ppubs.js');
        const core = await fetchPpubsCore(publicationNumber, signal);
        if (!core.abstract) throw new Error('PPUBS record has no abstract');
        return core.abstract;
      },
    });
  }
  chains.core = coreChain;
  chains.abstract = abstractChain;

  // claims: US → PPUBS first (OPS has no US fulltext), then OPS, then GP
  const ppubsClaims: ChainSource = {
    name: 'ppubs',
    run: async (signal) => {
      const { fetchPpubsClaims } = await import('./ppubs.js');
      return fetchPpubsClaims(publicationNumber, signal);
    },
  };
  const opsClaims: ChainSource = {
    name: 'ops',
    run: async (signal) => {
      const { fetchOpsClaims } = await import('./ops.js');
      return fetchOpsClaims(publicationNumber, signal) as Promise<PatentClaimsSection>;
    },
  };
  const gpClaims: ChainSource = {
    name: 'google_patents',
    run: async (signal) => {
      const { fetchGooglePatentDetail } = await import('./google-patents.js');
      const parsed = await fetchGooglePatentDetail(publicationNumber, signal);
      if (parsed.claims.length === 0) throw new Error('Google Patents detail has no claims markup');
      let warn: string | undefined;
      let claims = parsed.claims.map(c => {
        const stripped = c.text.replace(/^\d+[.)]\s*/, '');
        return `${Number(c.num)}. ${stripped}`;
      });
      const total = claims.reduce((s, c) => s + c.length, 0);
      if (total > 100_000) {
        const kept: string[] = [];
        let used = 0;
        for (const c of claims) {
          if (used + c.length > 100_000) break;
          kept.push(c);
          used += c.length;
        }
        warn = `Claims truncated to ${kept.length} of ${claims.length} claims (~100 KB cap).`;
        claims = kept;
      }
      return { claims, number_of_claims: parsed.claims.length, source: 'google_patents', _warn: warn } as PatentClaimsSection;
    },
  };
  chains.claims = us
    ? [ppubsClaims, ...(hasOpsCredentials() ? [opsClaims] : []), gpClaims]
    : [...(hasOpsCredentials() ? [opsClaims] : []), gpClaims];

  // citations: OPS (backward + ct= forward) → GP detail (+PPUBS backward for US)
  const opsCitations: ChainSource = {
    name: 'ops',
    run: async (signal) => {
      const { fetchOpsCitations } = await import('./ops.js');
      return fetchOpsCitations(publicationNumber, signal) as Promise<PatentCitationsSection>;
    },
  };
  const gpCitations: ChainSource = {
    name: 'google_patents',
    run: async (signal) => {
      const { fetchGooglePatentDetail } = await import('./google-patents.js');
      const parsed = await fetchGooglePatentDetail(publicationNumber, signal);
      if (parsed.backward_references.length === 0 && parsed.forward_references.length === 0) {
        throw new Error('No citation data on Google Patents detail');
      }
      return {
        backward: parsed.backward_references,
        forward: parsed.forward_references,
        non_patent_literature: parsed.non_patent_literature.length > 0 ? parsed.non_patent_literature : undefined,
        source: 'google_patents',
      } as PatentCitationsSection;
    },
  };
  const ppubsCitations: ChainSource = {
    name: 'ppubs',
    run: async (signal) => {
      const { fetchPpubsCitations } = await import('./ppubs.js');
      const { backward } = await fetchPpubsCitations(publicationNumber, signal);
      if (backward.length === 0) throw new Error('No citation data via PPUBS');
      return { backward, forward: [], source: 'ppubs' } as PatentCitationsSection;
    },
  };
  chains.citations = [
    ...(hasOpsCredentials() ? [opsCitations] : []),
    gpCitations,
    ...(us ? [ppubsCitations] : []),
  ];

  // family: OPS family → GP docdbFamily → PPUBS
  const opsFamily: ChainSource = {
    name: 'ops',
    run: async (signal) => {
      const { fetchOpsFamily } = await import('./ops.js');
      const fam = await fetchOpsFamily(publicationNumber, signal);
      if (fam.family_members.length === 0) throw new Error('OPS returned empty family');
      return fam as PatentFamilySection;
    },
  };
  const gpFamily: ChainSource = {
    name: 'google_patents',
    run: async (signal) => {
      const { fetchGooglePatentDetail } = await import('./google-patents.js');
      const parsed = await fetchGooglePatentDetail(publicationNumber, signal);
      if (parsed.family_members.length === 0) throw new Error('No family data on Google Patents detail');
      return { family_members: parsed.family_members, source: 'google_patents' } as PatentFamilySection;
    },
  };
  const ppubsFamily: ChainSource = {
    name: 'ppubs',
    run: async (signal) => {
      const { fetchPpubsCore } = await import('./ppubs.js');
      const core = await fetchPpubsCore(publicationNumber, signal);
      if (!core.family_members || core.family_members.length === 0) throw new Error('No family data via PPUBS');
      return { family_members: core.family_members, source: 'ppubs' } as PatentFamilySection;
    },
  };
  chains.family = [
    ...(hasOpsCredentials() ? [opsFamily] : []),
    gpFamily,
    ...(us ? [ppubsFamily] : []),
  ];

  // classifications: OPS → GP → PPUBS (+ODP for US when keyed)
  const opsClass: ChainSource = {
    name: 'ops',
    run: async (signal) => {
      const { fetchOpsClassifications } = await import('./ops.js');
      const cls = await fetchOpsClassifications(publicationNumber, signal);
      if (cls.cpc.length === 0 && cls.ipc.length === 0) throw new Error('OPS returned no classifications');
      return cls as PatentClassificationsSection;
    },
  };
  const gpClass: ChainSource = {
    name: 'google_patents',
    run: async (signal) => {
      const { fetchGooglePatentDetail } = await import('./google-patents.js');
      const parsed = await fetchGooglePatentDetail(publicationNumber, signal);
      if (parsed.cpc.length === 0) throw new Error('No CPC on Google Patents detail');
      return { cpc: parsed.cpc, ipc: [], source: 'google_patents' } as PatentClassificationsSection;
    },
  };
  const odpClass: ChainSource = {
    name: 'uspto_odp',
    run: async (signal) => {
      const { fetchOdpCore } = await import('./odp.js');
      const core = await fetchOdpCore(publicationNumber, signal);
      if (!core.cpc || core.cpc.length === 0) throw new Error('No CPC via ODP');
      return { cpc: core.cpc, ipc: [], source: 'uspto_odp' } as PatentClassificationsSection;
    },
  };
  async function ppubsFallbackClass(signal?: AbortSignal): Promise<PatentClassificationsSection> {
    const { fetchPpubsCore } = await import('./ppubs.js');
    const core = await fetchPpubsCore(publicationNumber, signal);
    if (!core.cpc || core.cpc.length === 0) throw new Error('No CPC via PPUBS');
    return { cpc: core.cpc, ipc: core.ipc || [], source: 'ppubs' };
  }
  const ppubsClass: ChainSource = { name: 'ppubs', run: ppubsFallbackClass };
  chains.classifications = [
    ...(hasOpsCredentials() ? [opsClass] : []),
    gpClass,
    ...(us ? (hasOdpKey() ? [odpClass, ppubsClass] : [ppubsClass]) : []),
  ];

  return chains;
}

function abortReasonMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (reason !== undefined) return String(reason);
  return 'aborted';
}

/**
 * Run a priority chain with real aborts (issue #209).
 *
 * Each source runs under its own failover budget (from the PATENT_GET_
 * BUDGETS_MS table, keyed by source name) as an AbortController + JS
 * setTimeout composed with the phase signal via AbortSignal.any — NEVER
 * `AbortSignal.timeout()`, whose native timer is invisible to Jest fake
 * timers. On expiry the race settles FIRST with the failover error, THEN
 * the controller aborts (withToolTimeout precedent), so the in-flight
 * step's fetches actually stop instead of lingering on the shared 1 req/s
 * PPUBS token bucket while the chain moves on. Every attempted source's
 * error is collected; the failure message enumerates all of them.
 */
async function runChain(
  sources: ChainSource[],
  phaseSignal?: AbortSignal,
): Promise<{ value?: unknown; error?: string }> {
  const failures: Array<{ name: string; error: string }> = [];
  for (const source of sources) {
    if (phaseSignal?.aborted) {
      // Phase (or tool) deadline already spent: stop failing over. The
      // in-flight step recorded the phase abort as its own failure.
      break;
    }
    const stepBudgetMs = PATENT_GET_BUDGETS_MS.steps[source.name].step;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let phaseListener: (() => void) | undefined;
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => {
          // Settle the race first (documented failover error shape), then
          // abort the loser so its fetches stop consuming resources.
          reject(new Error(`source timed out after ${stepBudgetMs}ms and was aborted; failing over to the next source`));
          controller.abort();
        }, stepBudgetMs);
        if (phaseSignal) {
          phaseListener = () => {
            reject(new Error(abortReasonMessage(phaseSignal)));
            controller.abort(phaseSignal.reason);
          };
          phaseSignal.addEventListener('abort', phaseListener, { once: true });
        }
        const stepSignal = phaseSignal
          ? AbortSignal.any([controller.signal, phaseSignal])
          : controller.signal;
        source.run(stepSignal).then(resolve, reject);
      });
      if (value !== undefined && value !== null) {
        return { value };
      }
      failures.push({ name: source.name, error: 'source returned no data' });
    } catch (err) {
      failures.push({ name: source.name, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (phaseListener && phaseSignal) phaseSignal.removeEventListener('abort', phaseListener);
    }
  }
  if (failures.length === 0) {
    // Only reachable when the phase aborted before the first source ran.
    failures.push({
      name: 'phase',
      error: phaseSignal?.aborted ? abortReasonMessage(phaseSignal) : 'no source available',
    });
  }
  return { error: `All sources failed. ${failures.map(f => `${f.name}: ${f.error}`).join('; ')}` };
}

/**
 * One phase slice of the tool deadline (core / sections): a JS setTimeout
 * (fake-timer friendly — see runChain) whose abort reason names the phase
 * and budget, composed with the parent (tool) signal so either deadline
 * aborts the phase. `dispose` clears the slice timer once the phase is
 * done — a successful fast call must not leave a pending 72s timer.
 */
function phaseSlice(
  budgetMs: number,
  label: string,
  parent?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`patent_get ${label} deadline (${budgetMs}ms) exceeded`));
  }, budgetMs);
  const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
  return { signal, dispose: () => clearTimeout(timer) };
}

/**
 * Fetch a patent by publication number with optional sections. The core
 * record uses the same priority chain; failures degrade per section without
 * failing the whole call. The returned record carries a top-level `source`
 * (which backend produced the core) and, when the served document differs
 * from the requested one in kind class or country, claims came from
 * unofficial scraping, or a section failed entirely, a top-level
 * `_warnings` list (see identityWarnings).
 *
 * `signal` is the tool deadline (withToolTimeout in server/tools/patent.ts)
 * or an MCP client cancellation; the core and sections phases each get a
 * slice of it (PATENT_GET_BUDGETS_MS), and every chain step composes its
 * failover budget with the slice — so a deadline expiry aborts in-flight
 * fetches instead of merely abandoning the race.
 */
export async function patentGet(
  publicationNumber: string,
  sections?: string[],
  signal?: AbortSignal,
): Promise<PatentResult> {
  const normalized = normalizePublicationNumber(publicationNumber);
  if (!isValidPublicationNumber(normalized)) {
    throw new Error(
      `Invalid patent number '${publicationNumber}'. Expected forms like US11027025B2, EP3904939, US20260240819A1. ` +
      'Use patent_search to find valid publication numbers.',
    );
  }

  const sectionConfig = sections && sections.length > 0 ? sections : ['core'];
  const chains = sectionChains(normalized);

  const coreSlice = phaseSlice(PATENT_GET_BUDGETS_MS.coreSlice, 'core', signal);
  let coreOutcome: { value?: unknown; error?: string };
  try {
    coreOutcome = await runChain(chains.core, coreSlice.signal);
  } finally {
    coreSlice.dispose();
  }
  if (coreOutcome.error || coreOutcome.value === undefined) {
    const pointer = /^US/i.test(normalized)
      ? ''
      : ' Non-US publications need EPO OPS credentials (EPO_OPS_CONSUMER_KEY/EPO_OPS_CONSUMER_SECRET) or Google Patents reachability; PCT numbers (WO…) can also be patent_searched to find their US national-phase members or citing art.';
    throw new Error(
      `Patent '${normalized}' could not be fetched: ${coreOutcome.error}.${pointer}`,
    );
  }

  const result = coreOutcome.value as PatentResult;
  result.publication_number = result.publication_number || normalized;

  const requested = sectionConfig.includes('all')
    ? ['abstract', 'claims', 'citations', 'family', 'classifications']
    : sectionConfig.filter(s => s !== 'core');

  if (requested.length > 0) {
    result.sections = {};
    const sectionsSlice = phaseSlice(PATENT_GET_BUDGETS_MS.sectionsSlice, 'sections', signal);
    const settled = await Promise.allSettled(
      requested.map(section => {
        const chain = chains[section];
        if (!chain) {
          return Promise.resolve({ error: `Unknown section '${section}'.` });
        }
        return runChain(chain, sectionsSlice.signal);
      }),
    ).finally(() => sectionsSlice.dispose());

    // Section-failure warnings (pdb collectSectionWarnings precedent): the
    // inline `{ error }` entries stay (pinned shape), but callers that never
    // walk result.sections still see WHICH sections failed — one short
    // entry per failed section, merged into the top-level _warnings.
    const sectionWarnings: string[] = [];
    settled.forEach((outcome, i) => {
      const section = requested[i];
      if (outcome.status === 'fulfilled') {
        if (outcome.value.error) {
          result.sections![section] = { error: outcome.value.error };
          const summary = outcome.value.error.length > 200
            ? `${outcome.value.error.slice(0, 197)}...`
            : outcome.value.error;
          sectionWarnings.push(`Section '${section}' unavailable: ${summary}`);
        } else {
          result.sections![section] = (outcome.value as { value?: unknown }).value;
        }
      } else {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        result.sections![section] = { error: `Section '${section}' fetch failed: ${reason}` };
        sectionWarnings.push(`Section '${section}' unavailable: ${reason}`);
      }
    });

    // Provenance + merged honesty warnings (issues #197/#200): keep the
    // core record's identity warnings at the top level, flag claims that
    // fell back to unofficial Google Patents scraping (number-type aware —
    // OPS has no US fulltext, so the EPO-keys advice is EP/WO-only), merge
    // any section-level `_warn` string (e.g. claims truncation) and the
    // per-section failure entries above into the same list instead of
    // replacing it.
    const claims = result.sections?.claims as
      | { source?: PatentSource; _warn?: string; error?: string }
      | undefined;
    const merged = [...(result._warnings || [])];
    if (claims && !claims.error) {
      if (claims.source === 'google_patents') {
        merged.push(isUsNumber(normalized) ? CLAIMS_UNOFFICIAL_WARNING_US : CLAIMS_UNOFFICIAL_WARNING_EP);
      }
      if (claims._warn) merged.push(claims._warn);
    }
    merged.push(...sectionWarnings);
    if (merged.length > 0) result._warnings = merged;
  }

  return result;
}
