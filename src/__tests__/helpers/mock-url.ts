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
