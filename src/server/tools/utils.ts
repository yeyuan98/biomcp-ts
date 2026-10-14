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

export function withToolTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
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
