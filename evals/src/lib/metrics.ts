/** Nearest-rank percentile (0–100) of a numeric sample; 0 for an empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[rank]!);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** True when a metric meets its threshold: `*Ms`/`*Rate` are upper bounds, everything else a lower bound. */
export function meetsThreshold(key: string, value: number, threshold: number): boolean {
  return key.endsWith("Ms") || key.endsWith("Rate") ? value <= threshold : value >= threshold;
}

export function passesThresholds(
  metrics: Record<string, number>,
  thresholds: Record<string, number>,
): boolean {
  return Object.entries(thresholds).every(([key, threshold]) =>
    meetsThreshold(key, metrics[key] ?? 0, threshold),
  );
}
