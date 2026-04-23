export async function fetchWithTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<{ data?: T; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const data = await fn(controller.signal);
    return { data };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (error.includes('abort') || error.includes('timeout')) {
      return { error: `Timeout after ${timeoutMs}ms` };
    }
    return { error };
  } finally {
    clearTimeout(timeout);
  }
}
