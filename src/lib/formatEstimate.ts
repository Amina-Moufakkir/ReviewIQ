/**
 * Turning an estimate into something an analyst can weigh.
 *
 * Both figures are deliberately imprecise in their wording. The runtime is a
 * range because it is one, and the cost says "up to about" because it is a
 * conservative ceiling rather than a price — stating either as an exact number
 * would promise a precision the estimator does not have.
 */

/**
 * A runtime range in whichever unit reads naturally for its size.
 *
 * The unit is chosen from the HIGH end, so a 40-second-to-3-minute range does
 * not read as "0–3 minutes" and imply it might be instant.
 */
export function formatRuntimeRange(lowMs: number, highMs: number): string {
  const low = Math.max(0, lowMs);
  const high = Math.max(low, highMs);

  if (high < 90_000) {
    const lowSeconds = Math.max(1, Math.round(low / 1000));
    const highSeconds = Math.max(lowSeconds, Math.round(high / 1000));
    return lowSeconds === highSeconds
      ? `about ${highSeconds} seconds`
      : `${lowSeconds}–${highSeconds} seconds`;
  }

  const lowMinutes = Math.max(1, Math.round(low / 60_000));
  const highMinutes = Math.max(lowMinutes, Math.round(high / 60_000));
  return lowMinutes === highMinutes
    ? `about ${highMinutes} minute${highMinutes === 1 ? "" : "s"}`
    : `${lowMinutes}–${highMinutes} minutes`;
}

/**
 * A cost ceiling, never rounded down.
 *
 * Rounding to the nearest cent could show a figure below what the run may
 * actually cost, which is the one direction a ceiling must never move.
 */
export function formatCostCeiling(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  const cents = Math.ceil(usd * 100);
  if (cents < 1) return "less than $0.01";
  return `$${(cents / 100).toFixed(2)}`;
}
