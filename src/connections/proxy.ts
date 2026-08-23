/**
 * Proxy-aware global fetch.
 *
 * Node's built-in fetch (undici) ignores HTTP(S)_PROXY environment
 * variables — verified live in proxied environments where direct TCP to
 * some hosts (patents.google.com, web.archive.org) times out with ETIMEDOUT
 * while the same requests succeed through the proxy. Installing an
 * EnvHttpProxyAgent as the global dispatcher makes every `fetch` call honor
 * HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy and NO_PROXY/no_proxy.
 *
 * Verified from undici 8.10.0 source: with NO proxy env set, the agent's
 * internal dispatchers alias a plain Agent — behavior is identical to
 * direct fetch, so this is a safe no-op in unproxied environments.
 * EnvHttpProxyAgent ignores ALL_PROXY (socks) — socks-only environments are
 * out of scope (documented in the patent README). Alternative without this
 * module: Node >= 22.15 supports NODE_USE_ENV_PROXY=1.
 *
 * Self-initializes exactly once at module scope (ESM single evaluation).
 * Imported for its side effect by connections/manager.ts, so the server,
 * tests, and any CLI path all get proxy-aware fetch before first use —
 * the proxy environment is read at agent construction time, so this must
 * run before the first outbound fetch.
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

export const proxyStatus: { configured: boolean; detail: string } = {
  configured: false,
  detail: 'no proxy environment variables set — direct fetch',
};

function proxyEnvValue(): string | undefined {
  return (
    process.env.HTTPS_PROXY ?? process.env.https_proxy ??
    process.env.HTTP_PROXY ?? process.env.http_proxy
  );
}

export function configureProxyDispatcher(): void {
  const proxy = proxyEnvValue();
  if (!proxy) return; // plain Agent alias — direct fetch, unchanged behavior
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    proxyStatus.configured = true;
    proxyStatus.detail = `global fetch routed via proxy ${proxy} (NO_PROXY honored)`;
  } catch (err) {
    proxyStatus.detail = `proxy env present (${proxy}) but undici dispatcher setup failed: ${
      err instanceof Error ? err.message : String(err)
    } — fetch remains direct`;
    console.error('[biomcp] proxy init failed:', proxyStatus.detail);
  }
}

configureProxyDispatcher();
