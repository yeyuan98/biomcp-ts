export function memLimitBytes(envVar: string, defaultMb: number): number {
  const v = Number(process.env[envVar]);
  const mb = Number.isFinite(v) && v > 0 ? v : defaultMb;
  return mb * 1024 * 1024;
}

export function assertWithinMemoryLimit(envVar: string, defaultMb: number): void {
  const rss = process.memoryUsage().rss;
  const limit = memLimitBytes(envVar, defaultMb);
  if (rss > limit) {
    throw new Error(
      `Memory usage (${(rss / 1024 / 1024).toFixed(0)} MB) exceeds ${envVar} (${Math.round(limit / 1024 / 1024)} MB); refusing a new analysis.`
    );
  }
}
