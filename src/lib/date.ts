const ISO_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
}

/**
 * Strict calendar validation for a `YYYY-MM-DD` string. Rejects impossible
 * dates (e.g. 2026-02-30, 2026-13-01, 2026-00-10, 2026-04-31) and non-leap
 * Feb 29. Pure and timezone-free — it never constructs a `Date`.
 */
export function isValidIsoDate(value: string): boolean {
  const m = ISO_SHAPE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

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
