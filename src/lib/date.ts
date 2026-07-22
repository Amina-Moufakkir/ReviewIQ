/** Format an ISO date (YYYY-MM-DD) as a short, locale-aware label. */
export function formatDate(iso: string): string {
  // Parse as a local date so the displayed day never shifts by timezone.
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
