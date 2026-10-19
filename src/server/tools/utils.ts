import { z } from 'zod';

export function sliceArraysRecursive(obj: unknown, limit: number): unknown {
  if (Array.isArray(obj)) return obj.slice(0, limit);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = sliceArraysRecursive(v, limit);
    }
    return result;
  }
  return obj;
}

/**
 * Builds the error used when an externally supplied signal (the MCP
 * request's `extra.signal`) aborts the tool call before the deadline.
 */
function toolAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const detail =
    reason instanceof Error ? `: ${reason.message}` :
    reason !== undefined ? `: ${String(reason)}` :
    '';
  return new Error(`Tool execution aborted by the client${detail}`);
}

/**
 * Race tool work against a deadline, ABORTING the work when it loses.
 *
 * The legacy version raced a bare timer: on timeout the tool call rejected
 * but the underlying fetches kept running (and retrying) in the background,
 * holding connection semaphore slots for minutes (#107 phase 2).
 *
 * - `work` may be a function receiving an AbortSignal that fires on deadline
 *   OR on external cancellation — thread it into entity calls so the loser
 *   actually stops. A bare Promise is still accepted (nothing to abort, the
 *   deadline race alone applies) for call sites whose entity does not take
 *   a signal yet.
 * - `opts.signal` (e.g. the MCP request's `extra.signal`) aborts the work
 *   immediately and rejects with a distinct "aborted by the client" error;
 *   an already-aborted signal rejects without starting the work at all.
 * - The timeout error message matches the pre-existing shape
 *   (`Tool execution timed out after <ms>ms`).
 */
export function withToolTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const external = opts.signal;
  if (external?.aborted) {
    return Promise.reject(toolAbortError(external));
  }

  const controller = new AbortController();
  let workPromise: Promise<T>;
  if (typeof work === 'function') {
    // Invoke synchronously so the work attaches its abort listeners before
    // this tick ends — an external signal aborting right after the wrapper
    // returns must not slip in ahead of the work's own setup.
    try {
      workPromise = work(controller.signal);
    } catch (e) {
      workPromise = Promise.reject(e);
    }
  } else {
    workPromise = work;
  }

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      // Settle the race FIRST so the deadline error (the documented shape)
      // wins; then stop the loser: fetches reject, retries bail, semaphore
      // slots free. (abort() fires the work's listeners synchronously, so
      // aborting first would let the work's own AbortError win the race.)
      reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
      controller.abort();
    }, timeoutMs);
  });

  let abortPromise: Promise<never> | undefined;
  let onExternalAbort: (() => void) | undefined;
  if (external) {
    abortPromise = new Promise<never>((_, reject) => {
      onExternalAbort = () => {
        reject(toolAbortError(external));
        controller.abort(external.reason);
      };
      external.addEventListener('abort', onExternalAbort, { once: true });
    });
  }

  return Promise.race(
    abortPromise ? [workPromise, timeoutPromise, abortPromise] : [workPromise, timeoutPromise],
  ).finally(() => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (external && onExternalAbort) {
      external.removeEventListener('abort', onExternalAbort);
    }
  });
}

/**
 * Structural slice of the SDK request-handler `extra` for cancellation: the
 * SDK passes `extra.signal` (an AbortSignal the transport aborts when the
 * client cancels the request, e.g. an MCP progress-cancel) to every
 * registered tool callback — accepting it and handing it to
 * withToolTimeout's `opts.signal` makes client cancellation actually stop
 * the entity's in-flight requests.
 */
export interface CancellationCapableExtra {
  signal?: AbortSignal;
}

/**
 * Limits top-level arrays in the requested sections and returns the limited
 * sections object WITHOUT mutating the input (copy-on-write: only section
 * entries that actually get an array sliced are replaced on a shallow copy of
 * `sections`; untouched sections keep their identity). Mutating in place
 * previously truncated arrays inside cached results — the federated citation
 * result is shared with the article_get citation-section cache, so in-place
 * slicing permanently corrupted what later callers received.
 */
export function applyLimit(
  sections: Record<string, unknown>,
  requestedNames: string[],
  storageKeyMap: Record<string, string>,
  arrayKeyMap: Record<string, string[]>,
  limit: number,
): Record<string, unknown> {
  let result = sections;
  for (const name of requestedNames) {
    const storedKey = storageKeyMap[name] ?? name;
    const data = sections[storedKey];
    if (!data || typeof data !== 'object') continue;

    const keys = arrayKeyMap[name];
    let replacement: unknown;
    if (Array.isArray(data)) {
      replacement = data.slice(0, limit);
    } else if (keys) {
      const obj = data as Record<string, unknown>;
      let copied: Record<string, unknown> | undefined;
      for (const k of keys) {
        if (Array.isArray(obj[k])) {
          copied ??= { ...obj };
          copied[k] = (obj[k] as unknown[]).slice(0, limit);
        }
      }
      replacement = copied;
    }
    if (replacement !== undefined) {
      result = result === sections ? { ...sections } : result;
      result[storedKey] = replacement;
    }
  }
  return result;
}

/**
 * Rename aliased section entries from their STORAGE keys back to the
 * REQUESTED (schema-advertised) names, in place, and return the same
 * sections object (issue #129; batch_get parity is issue #158).
 *
 * The entity layer maps request names to legacy storage keys on input only
 * (gene: clinical_evidence→civic, protein_atlas→hpa, dosage_sensitivity→
 * clingen, disease_associations→disgenet; variant: alphagenome_scores→
 * alphagenome) so it can address them internally — callers must not have to
 * know those internal names. For each requested name with an alias entry
 * whose storage key is present, the entry moves to the requested name;
 * identity sections (no alias entry) and non-aliased keys are untouched.
 * `requestedNames` should already cover the 'all' expansion (pass the
 * all-sections constant), so implicitly requested sections come back under
 * their public names too.
 */
export function remapSectionKeysToRequested(
  sections: Record<string, unknown>,
  requestedNames: string[],
  storageKeys: Record<string, string>,
): Record<string, unknown> {
  for (const name of requestedNames) {
    const storedKey = storageKeys[name];
    if (!storedKey || !(storedKey in sections)) continue;
    sections[name] = sections[storedKey];
    delete sections[storedKey];
  }
  return sections;
}

/**
 * Required non-empty string parameter: trims, then rejects an empty result
 * with a uniform message so empty/whitespace-only selector params (ids,
 * symbols, accessions, …) fail zod schema validation — an MCP -32602-class
 * InvalidParams error — before any handler logic or network call runs
 * (issue #128). The 10 free-text search `query` params use the identical
 * inline pattern (issue #79); this helper extends it to required selectors.
 *
 * Format/regex tightening is deliberately out of scope: only emptiness is
 * rejected here.
 */
export const requiredString = (label: string) =>
  z.string().trim().min(1, `${label} must be a non-empty string after trimming`);

/**
 * ── ID-format regex constants (issue #163) ──────────────────────────────
 *
 * Single source of truth for the accepted SHAPE of each identifier family.
 * Each mirrors its entity-layer counterpart EXACTLY (never stricter — a
 * schema stricter than the entity would reject identifiers the entity
 * layer can serve), so a value passing the schema always reaches the
 * handler. Exported deliberately: the docstring-example harness (issue
 * #160) will import these constants to assert that every example ID
 * advertised in a tool `.describe()` string is accepted by its schema.
 *
 * Case handling: where the consuming handler/entity normalizes case
 * (sra_get uppercases; genbank/patent/article entities are case-blind)
 * the regex is case-INsensitive; where the entity is case-sensitive
 * (isPreprintDoi) the schema stays case-sensitive too.
 */

/** ClinicalTrials.gov registry ID: `NCT` + 8 digits, e.g. NCT01234567. */
export const NCT_ID_RE = /^NCT\d{8}$/i;

/**
 * Article identifier accepted by article_get / parseArticleId: a PMID
 * (numeric), a PMCID (optionally versioned — Europe PMC serves
 * version-suffixed PMCIDs like PMC4712660.1), or a DOI with an optional
 * `doi:` prefix. Mirrors parseArticleId's three patterns (entity uses
 * `10\.\d{4,}` for the prefix — no 9-digit cap — so the schema does too).
 */
export const ARTICLE_ID_RE =
  /^(?:\d+|PMC\d+(?:\.\d+)?|(?:doi:)?10\.\d{4,}\/\S+)$/i;

/**
 * bioRxiv/medRxiv preprint DOI, mirroring the entity's isPreprintDoi
 * EXACTLY (case-sensitive, two alternatives): the strict CSHL date form
 * 10.1101/YYYY.MM.DD.NNNNNN (a bare 10.1101 prefix would misclassify
 * CSHL Press journal articles) or the preprint-only 10.64898 prefix.
 */
export const PREPRINT_DOI_RE =
  /^10\.1101\/\d{4}\.\d{2}\.\d{2}\.\d+$|^10\.64898\/\S+$/;

/**
 * GenBank/RefSeq nucleotide accession, mirroring the entity-layer
 * ACCESSION_RE in src/entities/genbank.ts: 1-6 letters, optional
 * underscore (RefSeq NC_/NG_ vs INSDC KJ668569), digits, optional
 * version suffix. Covers WGS-style ABCD01000001.1.
 */
export const GENBANK_ACCESSION_RE = /^[A-Z]{1,6}_?\d+(?:\.\d+)?$/i;

/**
 * Patent publication number. The entity layer (normalizePublicationNumber
 * in src/entities/patent/search/dedup.ts) strips ALL spaces/slashes and
 * uppercases, then tests PUBLICATION_NUMBER_RE
 * `/^[A-Z]{2}(RE|PP|H)?\d{5,}[A-Z]?\d{0,2}$/`. This schema-level pattern
 * accepts the SAME set by allowing spaces/slashes between tokens — so
 * "US11027025B2", "us11027025b2", "US 11027025 B2", and "WO 2015/006747
 * A2" all pass. Normalization stays in the handler/entity (schema must
 * not mutate).
 */
export const PATENT_ID_RE =
  /^[A-Z]{2}(?:RE|PP|H)?(?:[ /]*\d){4,}[ /]*(?:[A-Z][ /]*\d{0,2})?$/i;

/**
 * SRA accession across the three INSDC archives: [EDS]R (NCBI S, ENA E,
 * DDBJ D) + record subfamily [PXRS] (run/experiment/study/sample) +
 * digits, e.g. SRR14432476, ERR2603273, DRR599211. Case-insensitive —
 * sra_get's handler uppercases before use.
 */
export const SRA_ACCESSION_RE = /^[EDS]R[PXRS]\d+$/i;

/**
 * ── Per-family schema builders (issue #163) ─────────────────────────────
 *
 * Each = requiredString + the family regex, with an error message that
 * NAMES THE EXPECTED SHAPE (with examples) so a malformed id fails fast
 * at the zod schema level as an MCP -32602 InvalidParams error — before
 * any handler logic or network call — instead of surfacing as a confusing
 * upstream not-found later. Examples are the REAL ids advertised in the
 * tools' `.describe()` strings.
 */
export const nctIdParam = (label = 'NCT ID') =>
  requiredString(label).regex(NCT_ID_RE, `${label} must be NCT followed by 8 digits, e.g. NCT01234567`);

export const articleIdParam = (label = 'Article ID') =>
  requiredString(label).regex(
    ARTICLE_ID_RE,
    `${label} must be a PMID (numeric, e.g. 12345), a PMCID (e.g. PMC1234567, optionally versioned like PMC4712660.1), or a DOI (e.g. 10.1038/s41586-021-03819-2 or doi:10.1038/s41586-021-03819-2)`,
  );

export const preprintDoiParam = (label = 'Preprint DOI') =>
  requiredString(label).regex(
    PREPRINT_DOI_RE,
    `${label} must be a bioRxiv/medRxiv preprint DOI: 10.1101/YYYY.MM.DD.NNNNNN (e.g. 10.1101/2021.10.25.465764) or the new prefix 10.64898/... (e.g. 10.64898/2026.08.11.744243); journal-article identifiers are rejected — use article_get for those`,
  );

export const genbankAccessionParam = (label = 'Accession') =>
  requiredString(label).regex(
    GENBANK_ACCESSION_RE,
    `${label} must look like NC_000023.11, NG_017013.2, KJ668569.1, or U12345 — 1-6 letters, optional underscore, digits, optional .version suffix`,
  );

export const patentIdParam = (label = 'Patent ID') =>
  requiredString(label).regex(
    PATENT_ID_RE,
    `${label} must be a publication number like US11027025B2, EP3904939B1, or US 11027025 B2 (spaces and case tolerated)`,
  );

export const sraAccessionParam = (label = 'SRA accession') =>
  requiredString(label).regex(
    SRA_ACCESSION_RE,
    `${label} must be like SRR14432476 — run (SRR/ERR/DRR), experiment (SRX/ERX/DRX), study (SRP/ERP/DRP), or sample (SRS/ERS/DRS) followed by digits (case-insensitive)`,
  );

/**
 * Optional filter-style string: ABSENCE still passes schema, but an
 * explicitly supplied empty/whitespace-only value is rejected. An empty
 * filter value would otherwise silently broaden the query — e.g.
 * variant_search's empty `query` used to match everything upstream.
 */
export const optionalNonEmptyString = (label: string) => requiredString(label).optional();

/** One upstream/backend failure inside a list envelope (article_search parity). */
export interface ListEnvelopeError {
  source: string;
  message: string;
  retryable?: boolean;
}

/**
 * Standard list-tool reply shape (issue #130): `results` plus optional
 * `warnings`/`errors` channels. Emission logic mirrors searchArticles
 * (src/entities/article/search/index.ts): the optional channels are
 * attached ONLY when non-empty, so a clean happy path serializes as exactly
 * `{"results":[...]}`.
 */
export interface ListEnvelope<T> {
  results: T[];
  warnings?: string[];
  errors?: ListEnvelopeError[];
}

/**
 * Wrap a list-tool result in the standard `{ results, warnings?, errors? }`
 * envelope (issue #130). Attach `warnings`/`errors` only when non-empty —
 * byte-identical emission logic to searchArticles' envelope construction.
 */
export function listEnvelope<T>(
  results: T[],
  warnings?: string[],
  errors?: ListEnvelopeError[],
): ListEnvelope<T> {
  const envelope: ListEnvelope<T> = { results };
  if (warnings !== undefined && warnings.length > 0) envelope.warnings = warnings;
  if (errors !== undefined && errors.length > 0) envelope.errors = errors;
  return envelope;
}
