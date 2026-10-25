/**
 * Proxy-aware, Happy-Eyeballs-tuned global fetch.
 *
 * A global undici dispatcher is ALWAYS installed — for two independent
 * reasons:
 *
 * 1. Proxy env (the original motivation): Node's built-in fetch (undici)
 *    ignores HTTP(S)_PROXY environment variables — verified live in proxied
 *    environments where direct TCP to some hosts (patents.google.com,
 *    web.archive.org) times out with ETIMEDOUT while the same requests
 *    succeed through the proxy. An EnvHttpProxyAgent as the global
 *    dispatcher makes every `fetch` call honor
 *    HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy and NO_PROXY/no_proxy.
 *    EnvHttpProxyAgent ignores ALL_PROXY (socks) — socks-only environments
 *    are out of scope (documented in the patent README). Alternative
 *    without this module: Node >= 22.15 supports NODE_USE_ENV_PROXY=1.
 *
 * 2. Happy Eyeballs attempt budget (the 2026-10 fix): Node >= 22 defaults
 *    `autoSelectFamily` (RFC 8305 IPv6/IPv4 racing) ON with a 250 ms
 *    per-attempt timeout. Networks where TCP handshakes to dual-stack
 *    Cloudflare edges (reactome.org, www.biorxiv.org, www.medrxiv.org)
 *    take 250-450 ms+ get every IPv4 attempt HE-aborted at 250 ms
 *    (ETIMEDOUT) while the IPv6 attempt fails instantly (ENETUNREACH);
 *    undici normalizes the AggregateError to ConnectTimeoutError →
 *    `UND_ERR_CONNECT_TIMEOUT` after ~0.5 s. IPv4-only hosts never race,
 *    which is why only some sources broke. The installed Agent raises the
 *    per-attempt budget to 2000 ms (BIOMCP_CONNECT_ATTEMPT_TIMEOUT_MS,
 *    clamped 250-10000) — fast-fail is preserved, slow-but-working edges
 *    are tolerated, and the worst case stays bounded by undici's default
 *    10 s overall connectTimeout. The knob covers direct traffic only:
 *    with a proxy set, the origin connect is the proxy's job (undici's
 *    ProxyAgent ignores `connect` opts).
 *
 * Always installed via `setGlobalDispatcher` — never a manual
 * `globalThis[Symbol.for('undici.globalDispatcher.1')]` assignment, which
 * Node's built-in fetch would bypass (it needs the Dispatcher1Wrapper that
 * setGlobalDispatcher installs). Side effect of that wrapper: it forces
 * `allowH2: false`, pinning built-in fetch to HTTP/1 in all environments —
 * explicitly what undici's default already was (`allowH2` defaults to
 * false), so the pin is now guaranteed rather than incidental; no
 * biomcp-ts upstream requires HTTP/2.
 *
 * Self-initializes exactly once at module scope (ESM single evaluation).
 * Imported for its side effect by connections/manager.ts, so the server,
 * tests, and any CLI path all get the tuned dispatcher before first use —
 * the environment is read at agent construction time, so this must run
 * before the first outbound fetch. On constructor/install failure the
 * undici defaults are left in place and a warning is surfaced on stderr.
 */
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

export const proxyStatus: { configured: boolean; detail: string } = {
  configured: false,
  detail: 'global dispatcher not yet installed',
};

const DEFAULT_ATTEMPT_TIMEOUT_MS = 2000;
const MIN_ATTEMPT_TIMEOUT_MS = 250;
const MAX_ATTEMPT_TIMEOUT_MS = 10000;

function proxyEnvValue(): string | undefined {
  return (
    process.env.HTTPS_PROXY ?? process.env.https_proxy ??
    process.env.HTTP_PROXY ?? process.env.http_proxy
  );
}

/** Per-attempt connect budget from BIOMCP_CONNECT_ATTEMPT_TIMEOUT_MS — invalid/non-numeric falls back to the default, valid values clamp to [250, 10000]. */
function connectAttemptTimeoutMs(): number {
  const raw = process.env.BIOMCP_CONNECT_ATTEMPT_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.min(MAX_ATTEMPT_TIMEOUT_MS, Math.max(MIN_ATTEMPT_TIMEOUT_MS, parsed));
    }
  }
  return DEFAULT_ATTEMPT_TIMEOUT_MS;
}

/**
 * Install the global dispatcher (idempotent; re-reads the environment, so
 * re-invoking after an env change re-tunes the connect opts).
 */
export function configureGlobalDispatcher(): void {
  const attemptTimeoutMs = connectAttemptTimeoutMs();
  const connect = { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: attemptTimeoutMs };
  const proxy = proxyEnvValue();
  try {
    if (proxy) {
      setGlobalDispatcher(new EnvHttpProxyAgent({ connect }));
      proxyStatus.configured = true;
      proxyStatus.detail =
        `global fetch routed via proxy ${proxy} (NO_PROXY honored; ` +
        `connect attempt timeout ${attemptTimeoutMs}ms — proxied connects are the proxy's job)`;
    } else {
      setGlobalDispatcher(new Agent({ connect }));
      proxyStatus.configured = false;
      proxyStatus.detail =
        `no proxy environment variables set — direct fetch through tuned global dispatcher ` +
        `(Happy Eyeballs connect attempt timeout ${attemptTimeoutMs}ms)`;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (proxy) {
      proxyStatus.detail = `proxy env present (${proxy}) but undici dispatcher setup failed: ${reason} — fetch remains direct`;
      console.error('[biomcp] proxy init failed:', proxyStatus.detail);
    } else {
      proxyStatus.detail = `no proxy env, but tuned Agent dispatcher setup failed: ${reason} — fetch remains on undici defaults`;
      console.error('[biomcp] dispatcher init failed:', proxyStatus.detail);
    }
  }
}

/** Previous name kept as an alias for existing importers. */
export const configureProxyDispatcher = configureGlobalDispatcher;

configureGlobalDispatcher();
