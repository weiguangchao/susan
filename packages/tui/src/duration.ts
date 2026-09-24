/** `4.4s` below ten seconds, `12s` below a minute, `1m05s` above that. */
export function formatDuration(ms: number): string {
  // Round before choosing a format, so 9.96s reads 10s rather than 10.0s.
  const tenths = Math.round(Math.max(0, ms) / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(tenths / 10);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
