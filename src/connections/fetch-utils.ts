export async function fetchWithTimeout<T>(fn: (signal?: AbortSignal) => Promise<T>, timeoutMs: number): Promise<{ data?: T; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const data = await fn(controller.signal);
    return { data };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (error.includes('Timeout') || error.includes('timeout') || error.includes('abort') || error.includes('ABORT')) {
      return { error: `Section fetch timed out after ${timeoutMs}ms. The upstream data source may be slow or unreachable. Try again or use a different section.` };
    }
    return { error: `Section fetch failed: ${error}` };
  } finally {
    clearTimeout(timeoutId);
  }
}
