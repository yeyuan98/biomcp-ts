import { jest } from '@jest/globals';

/**
 * URL parsing for jest fetch mocks.
 *
 * Route mocks by EXACT hostname (and pathname prefix) — never by
 * `url.includes('<host>')` substring checks. Substring host matching is an
 * incomplete URL validation pattern that CodeQL flags
 * (js/incomplete-url-substring-sanitization), and it is also weaker test
 * hygiene: a URL like `https://evil.com/?x=api.biorxiv.org` would satisfy a
 * substring check but must not satisfy a mock route.
 *
 * Usage:
 *   const { hostname, pathname } = parseMockUrl(url);
 *   if (hostname === 'api.biorxiv.org' && pathname.startsWith('/details/')) ...
 */
export function parseMockUrl(url: unknown): URL {
  try {
    return new URL(String(url));
  } catch {
    return new URL('https://mock.invalid/');
  }
}

/** One exact-hostname route in a `mockFetchRouter` table. */
export interface MockRoute {
  host: string | string[]; // exact hostname(s)
  path?: string; // optional pathname prefix
  reply: (url: URL) => unknown; // Response/Promise/whatever the mock returns
}

/**
 * Route-table fetch mock for multi-route mocks (>=3 hostname routes): the
 * returned jest.fn dispatches by EXACT hostname (and optional pathname
 * prefix) via parseMockUrl — first matching route wins. Unmatched calls go
 * to `fallback` when provided, otherwise reject with `unexpected url …`.
 * For 1–2 route mocks prefer direct `parseMockUrl()` if-chains.
 */
export function mockFetchRouter(routes: MockRoute[], fallback?: (url: URL) => unknown) {
  return jest.fn().mockImplementation((input: unknown) => {
    const url = parseMockUrl(input);
    for (const route of routes) {
      const hosts = Array.isArray(route.host) ? route.host : [route.host];
      if (hosts.includes(url.hostname) && (!route.path || url.pathname.startsWith(route.path))) {
        return route.reply(url);
      }
    }
    if (fallback) return fallback(url);
    return Promise.reject(new Error(`unexpected url ${url.href}`));
  });
}
