import { hasOpsCredentials } from '../ops-client.js';
import { hasOdpKey } from '../search/odp.js';
import type {
  PatentClassificationsSection,
  PatentClaimsSection,
  PatentCitationsSection,
  PatentFamilySection,
  PatentResult,
} from '../types.js';
import { isValidPublicationNumber, normalizePublicationNumber } from '../search/dedup.js';

export const PATENT_GET_SECTIONS = ['core', 'abstract', 'claims', 'citations', 'family', 'classifications', 'all'] as const;
export type PatentGetSection = typeof PATENT_GET_SECTIONS[number];

const SECTION_TIMEOUT_MS = 8000;
const CLAIMS_SECTION_TIMEOUT_MS = 15000;

function isUsNumber(pn: string): boolean {
  return /^US/i.test(pn);
}

function isKindStripped(pn: string): boolean {
  return /^[A-Z]{2}(RE|PP|H)?\d+$/.test(pn);
}

/**
 * Build the ordered priority chain of section fetchers for a publication
 * number. Sources whose credentials are absent are skipped silently; hard
 * failures fall through to the next source.
 */
function sectionChains(publicationNumber: string): Record<string, Array<() => Promise<unknown>>> {
  const us = isUsNumber(publicationNumber);
  const chains: Record<string, Array<() => Promise<unknown>>> = {};

  const opsCore = async () => {
    const { fetchOpsBiblio } = await import('./ops.js');
    const biblio = await fetchOpsBiblio(publicationNumber);
    if (isKindStripped(biblio.publication_number)) {
      biblio.publication_number = normalizePublicationNumber(publicationNumber);
    }
    return biblio;
  };
  const gpDetail = async () => {
    const { fetchGooglePatentDetail } = await import('./google-patents.js');
    const parsed = await fetchGooglePatentDetail(publicationNumber);
    const result: PatentResult = {
      publication_number: parsed.publication_number || normalizePublicationNumber(publicationNumber),
      title: parsed.title,
      abstract: parsed.abstract,
      publication_date: parsed.publication_date,
      filing_date: parsed.filing_date,
      priority_date: parsed.priority_date,
      assignee: parsed.assignee && parsed.assignee.length > 0 ? parsed.assignee : undefined,
      inventors: parsed.inventors && parsed.inventors.length > 0 ? parsed.inventors : undefined,
      legal_status: parsed.legal_status,
      cpc: parsed.cpc.length > 0 ? parsed.cpc : undefined,
    };
    return result;
  };
  const ppubsCore = async () => {
    const { fetchPpubsCore } = await import('./ppubs.js');
    return fetchPpubsCore(publicationNumber);
  };

  // core / abstract
  const coreChain: Array<() => Promise<unknown>> = [];
  const abstractChain: Array<() => Promise<unknown>> = [];
  if (hasOpsCredentials()) {
    coreChain.push(opsCore);
    abstractChain.push(async () => {
      const { fetchOpsAbstract } = await import('./ops.js');
      const abstract = await fetchOpsAbstract(publicationNumber);
      if (!abstract) throw new Error('OPS returned empty abstract');
      return abstract;
    });
  }
  coreChain.push(gpDetail);
  abstractChain.push(async () => {
    const { fetchGooglePatentDetail } = await import('./google-patents.js');
    const parsed = await fetchGooglePatentDetail(publicationNumber);
    if (!parsed.abstract) throw new Error('Google Patents detail has no abstract');
    return parsed.abstract;
  });
  if (us) {
    coreChain.push(ppubsCore);
    abstractChain.push(async () => {
      const { fetchPpubsCore } = await import('./ppubs.js');
      const core = await fetchPpubsCore(publicationNumber);
      if (!core.abstract) throw new Error('PPUBS record has no abstract');
      return core.abstract;
    });
  }
  chains.core = coreChain;
  chains.abstract = abstractChain;

  // claims: US → PPUBS first (OPS has no US fulltext), then OPS, then GP
  const ppubsClaims = async () => {
    const { fetchPpubsClaims } = await import('./ppubs.js');
    return fetchPpubsClaims(publicationNumber);
  };
  const opsClaims = async () => {
    const { fetchOpsClaims } = await import('./ops.js');
    return fetchOpsClaims(publicationNumber) as Promise<PatentClaimsSection>;
  };
  const gpClaims = async () => {
    const { fetchGooglePatentDetail } = await import('./google-patents.js');
    const parsed = await fetchGooglePatentDetail(publicationNumber);
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
  };
  chains.claims = us
    ? [ppubsClaims, ...(hasOpsCredentials() ? [opsClaims] : []), gpClaims]
    : [...(hasOpsCredentials() ? [opsClaims] : []), gpClaims];

  // citations: OPS (backward + ct= forward) → GP detail (+PPUBS backward for US)
  const opsCitations = async () => {
    const { fetchOpsCitations } = await import('./ops.js');
    return fetchOpsCitations(publicationNumber) as Promise<PatentCitationsSection>;
  };
  const gpCitations = async () => {
    const { fetchGooglePatentDetail } = await import('./google-patents.js');
    const parsed = await fetchGooglePatentDetail(publicationNumber);
    if (parsed.backward_references.length === 0 && parsed.forward_references.length === 0) {
      throw new Error('No citation data on Google Patents detail');
    }
    return {
      backward: parsed.backward_references,
      forward: parsed.forward_references,
      non_patent_literature: parsed.non_patent_literature.length > 0 ? parsed.non_patent_literature : undefined,
      source: 'google_patents',
    } as PatentCitationsSection;
  };
  const ppubsCitations = async () => {
    const { fetchPpubsCitations } = await import('./ppubs.js');
    const { backward } = await fetchPpubsCitations(publicationNumber);
    if (backward.length === 0) throw new Error('No citation data via PPUBS');
    return { backward, forward: [], source: 'ppubs' } as PatentCitationsSection;
  };
  chains.citations = [
    ...(hasOpsCredentials() ? [opsCitations] : []),
    gpCitations,
    ...(us ? [ppubsCitations] : []),
  ];

  // family: OPS family → GP docdbFamily → PPUBS
  const opsFamily = async () => {
    const { fetchOpsFamily } = await import('./ops.js');
    const fam = await fetchOpsFamily(publicationNumber);
    if (fam.family_members.length === 0) throw new Error('OPS returned empty family');
    return fam as PatentFamilySection;
  };
  const gpFamily = async () => {
    const { fetchGooglePatentDetail } = await import('./google-patents.js');
    const parsed = await fetchGooglePatentDetail(publicationNumber);
    if (parsed.family_members.length === 0) throw new Error('No family data on Google Patents detail');
    return { family_members: parsed.family_members, source: 'google_patents' } as PatentFamilySection;
  };
  const ppubsFamily = async () => {
    const { fetchPpubsCore } = await import('./ppubs.js');
    const core = await fetchPpubsCore(publicationNumber);
    if (!core.family_members || core.family_members.length === 0) throw new Error('No family data via PPUBS');
    return { family_members: core.family_members, source: 'ppubs' } as PatentFamilySection;
  };
  chains.family = [
    ...(hasOpsCredentials() ? [opsFamily] : []),
    gpFamily,
    ...(us ? [ppubsFamily] : []),
  ];

  // classifications: OPS → GP → PPUBS
  const opsClass = async () => {
    const { fetchOpsClassifications } = await import('./ops.js');
    const cls = await fetchOpsClassifications(publicationNumber);
    if (cls.cpc.length === 0 && cls.ipc.length === 0) throw new Error('OPS returned no classifications');
    return cls as PatentClassificationsSection;
  };
  const gpClass = async () => {
    const { fetchGooglePatentDetail } = await import('./google-patents.js');
    const parsed = await fetchGooglePatentDetail(publicationNumber);
    if (parsed.cpc.length === 0) throw new Error('No CPC on Google Patents detail');
    return { cpc: parsed.cpc, ipc: [], source: 'google_patents' } as PatentClassificationsSection;
  };
  const odpClass = async () => {
    const { fetchOdpCore } = await import('./odp.js');
    const core = await fetchOdpCore(publicationNumber);
    if (!core.cpc || core.cpc.length === 0) throw new Error('No CPC via ODP');
    return { cpc: core.cpc, ipc: [], source: 'uspto_odp' } as PatentClassificationsSection;
  };
  chains.classifications = [
    ...(hasOpsCredentials() ? [opsClass] : []),
    gpClass,
    ...(us ? (hasOdpKey() ? [odpClass, ppubsFallbackClass] : [ppubsFallbackClass]) : []),
  ];

  async function ppubsFallbackClass(): Promise<PatentClassificationsSection> {
    const { fetchPpubsCore } = await import('./ppubs.js');
    const core = await fetchPpubsCore(publicationNumber);
    if (!core.cpc || core.cpc.length === 0) throw new Error('No CPC via PPUBS');
    return { cpc: core.cpc, ipc: core.ipc || [], source: 'ppubs' };
  }

  return chains;
}

async function runChain(steps: Array<() => Promise<unknown>>, timeoutMs: number): Promise<{ value?: unknown; error?: string }> {
  let lastError = 'no source available';
  for (const step of steps) {
    let timer: ReturnType<typeof setTimeout>;
    try {
      const value = await Promise.race([
        step().finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Section fetch timed out after ${timeoutMs}ms. The upstream data source may be slow or unreachable.`)), timeoutMs);
        }),
      ]);
      if (value !== undefined && value !== null) {
        return { value };
      }
      lastError = 'source returned no data';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { error: `All sources failed. Last error: ${lastError}` };
}

/**
 * Fetch a patent by publication number with optional sections. The core
 * record uses the same priority chain; failures degrade per section without
 * failing the whole call.
 */
export async function patentGet(
  publicationNumber: string,
  sections?: string[]
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

  const coreOutcome = await runChain(chains.core, SECTION_TIMEOUT_MS * 3);
  if (coreOutcome.error || coreOutcome.value === undefined) {
    throw new Error(`Patent '${normalized}' could not be fetched: ${coreOutcome.error}`);
  }

  const result = coreOutcome.value as PatentResult;
  result.publication_number = result.publication_number || normalized;

  const requested = sectionConfig.includes('all')
    ? ['abstract', 'claims', 'citations', 'family', 'classifications']
    : sectionConfig.filter(s => s !== 'core');

  if (requested.length > 0) {
    result.sections = {};
    const settled = await Promise.allSettled(
      requested.map(section => {
        const chain = chains[section];
        if (!chain) {
          return Promise.resolve({ error: `Unknown section '${section}'.` });
        }
        const timeout = section === 'claims' ? CLAIMS_SECTION_TIMEOUT_MS * 2 : SECTION_TIMEOUT_MS * 3;
        return runChain(chain, timeout);
      }),
    );

    settled.forEach((outcome, i) => {
      const section = requested[i];
      if (outcome.status === 'fulfilled') {
        if (outcome.value.error) {
          result.sections![section] = { error: outcome.value.error };
        } else {
          result.sections![section] = (outcome.value as { value?: unknown }).value;
        }
      } else {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        result.sections![section] = { error: `Section '${section}' fetch failed: ${reason}` };
      }
    });
  }

  return result;
}
