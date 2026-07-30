import type { AnalysisInput, AnalysisResult, Finding, Product, Review, Sentiment } from "../types";
import type { ValidatedTag } from "./claudeTags";
import { attribution, buildSummary, minEvidenceFor } from "./analysisEngine";
import { REVIEW, pluralize, type DatasetUnit } from "../lib/datasetInfo";

/**
 * Build an `AnalysisResult` from validated Claude tags. All counts, percentages,
 * and thresholds are computed HERE in TypeScript — never taken from a number the
 * model wrote. The result satisfies the same contract the heuristic engine does,
 * so the UI is unchanged.
 *
 * Recommendations are derived from the fault findings (see `recommendationsFor`)
 * rather than written by the model.
 */
export function tagsToResult(
  input: AnalysisInput,
  product: Product,
  matched: Review[],
  tags: ValidatedTag[],
  unit: DatasetUnit = REVIEW,
): AnalysisResult {
  const reviewCount = matched.length;
  if (reviewCount === 0) return zeroResult(product, input, unit);

  const reviewsById = new Map(matched.map((r) => [r.id, r] as const));
  const averageRating = round1(matched.reduce((sum, r) => sum + r.rating, 0) / reviewCount);

  const praise = findingsForSentiment(tags, "praise", reviewCount, reviewsById, unit);
  const faults = findingsForSentiment(tags, "fault", reviewCount, reviewsById, unit);

  return {
    productName: product.name,
    from: input.from,
    to: input.to,
    reviewCount,
    averageRating,
    summary: buildSummary(
      product,
      reviewCount,
      averageRating,
      praise,
      faults,
      unit,
      matched.every((r) => r.date !== ""),
    ),
    praise,
    faults,
    recommendations: recommendationsFor(faults, reviewCount, unit),
  };
}

/** A zero-review result (empty window) — no network call needed to produce it. */
export function zeroResult(product: Product, input: AnalysisInput, unit: DatasetUnit = REVIEW): AnalysisResult {
  return {
    productName: product.name,
    from: input.from,
    to: input.to,
    reviewCount: 0,
    averageRating: 0,
    summary: buildSummary(product, 0, 0, [], [], unit),
    praise: [],
    faults: [],
    recommendations: [],
  };
}

// --- internal helpers -------------------------------------------------------

/**
 * Actions for dynamic themes.
 *
 * The heuristic engine reads a curated line off THEME_LIBRARY, keyed by a fixed
 * label. Claude's themes are free-form ("ray pointer missing"), so that library
 * has no entry for them — which is why this used to return nothing at all, even
 * for a record whose text was full of complaints.
 *
 * The model is NOT asked to write the advice. It is a tagging layer, and prose
 * it invents would be grounded in nothing a customer wrote. Each action is
 * assembled here from values that already passed a gate: the theme label the
 * model assigned to text it had to quote verbatim, and the support count this
 * code computed from unique supporting reviews. Faults arrive sorted by
 * mentions, so actions come out in the order the fault column shows them —
 * best-supported complaint first, which is the order an analyst should work in.
 *
 * These are prompts for an analyst to investigate, not conclusions. That is the
 * same thing THEME_LIBRARY's `recommendation` claims to be.
 */
function recommendationsFor(faults: Finding[], reviewCount: number, unit: DatasetUnit): string[] {
  return faults.map((fault) => {
    const support =
      reviewCount === 1
        ? `the selected ${unit.one}`
        : `${fault.mentions} of ${reviewCount} ${pluralize(reviewCount, unit)}`;
    return `Investigate ${lowerFirst(fault.label)} — raised in ${support}.`;
  });
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

interface Group {
  /** Display label — the first original spelling seen for this normalized key. */
  label: string;
  /** Unique supporting reviews (a review counts at most once). */
  reviewIds: Set<string>;
  /** Representative supporting tags, in submission order. */
  tags: ValidatedTag[];
}

function findingsForSentiment(
  tags: ValidatedTag[],
  sentiment: "praise" | "fault",
  reviewCount: number,
  reviewsById: Map<string, Review>,
  unit: DatasetUnit,
): Finding[] {
  const groups = new Map<string, Group>();
  for (const tag of tags) {
    if (tag.sentiment !== sentiment) continue; // neutral tags produce no finding
    let group = groups.get(tag.themeKey);
    if (!group) {
      group = { label: tag.theme, reviewIds: new Set(), tags: [] };
      groups.set(tag.themeKey, group);
    }
    group.reviewIds.add(tag.reviewId);
    group.tags.push(tag);
  }

  const polarity: Sentiment = sentiment === "praise" ? "positive" : "negative";
  const findings: Finding[] = [];
  for (const group of groups.values()) {
    const mentions = group.reviewIds.size; // unique supporting reviews
    if (mentions < minEvidenceFor(unit)) continue; // same per-unit threshold as the heuristic engine
    const representative = pickRepresentative(group.tags, reviewsById);
    findings.push({
      label: group.label,
      sentiment: polarity,
      mentions,
      percent: Math.round((mentions / reviewCount) * 100),
      quote: representative.evidence,
      quoteAuthor: attribution(reviewsById.get(representative.reviewId)!),
    });
  }

  findings.sort((a, b) => b.mentions - a.mentions || a.label.localeCompare(b.label));
  return findings;
}

/**
 * Choose representative evidence deterministically: the supporting tag whose
 * review appears earliest in the matched (date-sorted) list, then by evidence
 * text, so the same input always yields the same quote.
 */
function pickRepresentative(tags: ValidatedTag[], reviewsById: Map<string, Review>): ValidatedTag {
  const order = new Map([...reviewsById.keys()].map((id, i) => [id, i] as const));
  return [...tags].sort((a, b) => {
    const oa = order.get(a.reviewId) ?? 0;
    const ob = order.get(b.reviewId) ?? 0;
    if (oa !== ob) return oa - ob;
    return a.evidence.localeCompare(b.evidence);
  })[0]!;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
