import type { AnalysisInput, AnalysisResult, Finding, Product, Review, Sentiment } from "../types";
import type { ValidatedTag } from "./claudeTags";
import { MIN_EVIDENCE, attribution, buildSummary } from "./analysisEngine";

/**
 * Build an `AnalysisResult` from validated Claude tags. All counts, percentages,
 * and thresholds are computed HERE in TypeScript — never taken from a number the
 * model wrote. The result satisfies the same contract the heuristic engine does,
 * so the UI is unchanged.
 *
 * Recommendations are intentionally empty in Claude mode: the engine is a
 * semantic tagging layer, not a report generator, and dynamic themes have no
 * entry in the (heuristic) recommendation library.
 */
export function tagsToResult(
  input: AnalysisInput,
  product: Product,
  matched: Review[],
  tags: ValidatedTag[],
): AnalysisResult {
  const reviewCount = matched.length;
  if (reviewCount === 0) return zeroResult(product, input);

  const reviewsById = new Map(matched.map((r) => [r.id, r] as const));
  const averageRating = round1(matched.reduce((sum, r) => sum + r.rating, 0) / reviewCount);

  const praise = findingsForSentiment(tags, "praise", reviewCount, reviewsById);
  const faults = findingsForSentiment(tags, "fault", reviewCount, reviewsById);

  return {
    productName: product.name,
    from: input.from,
    to: input.to,
    reviewCount,
    averageRating,
    summary: buildSummary(product, reviewCount, averageRating, praise, faults),
    praise,
    faults,
    recommendations: [],
  };
}

/** A zero-review result (empty window) — no network call needed to produce it. */
export function zeroResult(product: Product, input: AnalysisInput): AnalysisResult {
  return {
    productName: product.name,
    from: input.from,
    to: input.to,
    reviewCount: 0,
    averageRating: 0,
    summary: buildSummary(product, 0, 0, [], []),
    praise: [],
    faults: [],
    recommendations: [],
  };
}

// --- internal helpers -------------------------------------------------------

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
    if (mentions < MIN_EVIDENCE) continue; // same minimum-support threshold
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
