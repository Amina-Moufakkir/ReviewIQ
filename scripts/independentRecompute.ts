import type { CanonicalTag } from "../src/services/canonicalTag";

/**
 * An INDEPENDENT recomputation of every number the report displays.
 *
 * This file deliberately imports nothing from `tagsToResult.ts`, `analysisEngine.ts`,
 * or anything they use. It re-derives mentions, percentages, ordering, the
 * evidence threshold, and quote selection from first principles, so that
 * comparing it against the report checks the aggregator rather than asking the
 * aggregator to check itself.
 *
 * The rules below are restated from the specification, not imported:
 *
 *  - a finding's `mentions` is the count of DISTINCT review ids carrying that
 *    canonical theme with that sentiment — a review that says a thing twice
 *    still says it once
 *  - `percent` is mentions over the number of rows SELECTED, rounded to the
 *    nearest integer — the denominator is the selection, never the number of
 *    tagged rows, or a theme in a quiet window would look universal
 *  - a finding appears only when `mentions >= threshold`, which is 2 for review
 *    data and 1 for product-level data (one product record already aggregates
 *    many customers, so the aggregation the threshold demands has happened
 *    inside the cell)
 *  - findings are ordered by mentions descending, ties broken by label
 *    ascending, so the same input always renders in the same order
 *  - the quote is the evidence of the supporting tag whose review comes first
 *    in the selection order, ties broken by evidence text ascending
 */

export interface RecomputedFinding {
  label: string;
  sentiment: "positive" | "negative";
  mentions: number;
  percent: number;
  quote: string;
  quoteReviewId: string;
  /** Every distinct review id supporting this finding, sorted. */
  supportingReviewIds: string[];
}

export interface RecomputedReport {
  reviewCount: number;
  threshold: number;
  praise: RecomputedFinding[];
  faults: RecomputedFinding[];
  /** Groups that existed but fell below the threshold, for the audit trail. */
  belowThreshold: { label: string; sentiment: string; mentions: number }[];
}

export function recompute(
  tags: readonly CanonicalTag[],
  selectionOrder: readonly string[],
  isProductLevel: boolean,
): RecomputedReport {
  const reviewCount = selectionOrder.length;
  const threshold = isProductLevel ? 1 : 2;
  const position = new Map(selectionOrder.map((id, i) => [id, i] as const));

  const praise: RecomputedFinding[] = [];
  const faults: RecomputedFinding[] = [];
  const belowThreshold: { label: string; sentiment: string; mentions: number }[] = [];

  for (const wanted of ["praise", "fault"] as const) {
    // Group by canonical key, independently of how the aggregator groups.
    const groups = new Map<string, { label: string; tags: CanonicalTag[] }>();
    for (const tag of tags) {
      if (tag.sentiment !== wanted) continue;
      const group = groups.get(tag.canonicalKey);
      if (group) group.tags.push(tag);
      else groups.set(tag.canonicalKey, { label: tag.canonicalTheme, tags: [tag] });
    }

    const built: RecomputedFinding[] = [];
    for (const group of groups.values()) {
      const ids = [...new Set(group.tags.map((t) => t.reviewId))].sort();
      const mentions = ids.length;
      if (mentions < threshold) {
        belowThreshold.push({ label: group.label, sentiment: wanted, mentions });
        continue;
      }
      const chosen = [...group.tags].sort((a, b) => {
        const pa = position.get(a.reviewId) ?? Number.MAX_SAFE_INTEGER;
        const pb = position.get(b.reviewId) ?? Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;
        return a.evidence < b.evidence ? -1 : a.evidence > b.evidence ? 1 : 0;
      })[0]!;

      built.push({
        label: group.label,
        sentiment: wanted === "praise" ? "positive" : "negative",
        mentions,
        percent: Math.round((mentions / reviewCount) * 100),
        quote: chosen.evidence,
        quoteReviewId: chosen.reviewId,
        supportingReviewIds: ids,
      });
    }

    built.sort((a, b) => b.mentions - a.mentions || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    (wanted === "praise" ? praise : faults).push(...built);
  }

  return { reviewCount, threshold, praise, faults, belowThreshold };
}

/**
 * Check the canonical mapping is a total, closed relabelling of the raw tags.
 *
 * Every tag must carry a canonical label drawn from the raw labels actually
 * submitted, and its key must be that label normalized. Restated here rather
 * than imported, so a defect in the composer cannot validate itself.
 */
export function auditMapping(tags: readonly CanonicalTag[]): {
  ok: boolean;
  problems: string[];
  rawLabels: string[];
  canonicalLabels: string[];
} {
  const problems: string[] = [];
  const rawLabels = [...new Set(tags.map((t) => t.rawTheme))].sort();
  const canonicalLabels = [...new Set(tags.map((t) => t.canonicalTheme))].sort();
  const rawKeys = new Set(tags.map((t) => normalize(t.rawTheme)));

  for (const [i, tag] of tags.entries()) {
    if (!tag.canonicalTheme) problems.push(`tag ${i}: empty canonical label`);
    if (tag.canonicalKey !== normalize(tag.canonicalTheme)) {
      problems.push(`tag ${i}: canonical key is not the normalized canonical label`);
    }
    if (tag.rawKey !== normalize(tag.rawTheme)) {
      problems.push(`tag ${i}: raw key is not the normalized raw label`);
    }
    // A canonical label must be one of the labels that went in.
    if (!rawKeys.has(normalize(tag.canonicalTheme))) {
      problems.push(`tag ${i}: canonical label was never among the submitted labels`);
    }
  }

  // The relabelling must be a function: one raw key never maps two ways.
  const byRawKey = new Map<string, Set<string>>();
  for (const tag of tags) {
    const set = byRawKey.get(tag.rawKey) ?? new Set<string>();
    set.add(tag.canonicalKey);
    byRawKey.set(tag.rawKey, set);
  }
  for (const [rawKey, targets] of byRawKey) {
    if (targets.size > 1) problems.push(`raw label "${rawKey}" maps to ${targets.size} canonical labels`);
  }

  return { ok: problems.length === 0, problems, rawLabels, canonicalLabels };
}

/** Casing and whitespace only — restated, not imported. */
function normalize(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}
