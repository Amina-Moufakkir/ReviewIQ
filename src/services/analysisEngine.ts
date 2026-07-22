import type { AnalysisInput, AnalysisResult, Finding, Product, Review, ReviewStats, Sentiment } from "../types";
import { THEME_LIBRARY, type ThemeDef } from "./themeLibrary";

/**
 * Pure, synchronous analysis engine. No React, no I/O, no latency — so it is
 * trivially testable and deterministic.
 *
 * It is a HEURISTIC, RATING-ASSISTED engine, not a natural-language sentiment
 * model:
 *   - Theme detection is deterministic keyword matching against a shared,
 *     product-agnostic vocabulary (themeLibrary.ts).
 *   - A mention is treated as praise when the review is rated >= 4, and as a
 *     fault when rated <= 2. Rating 3 is neutral and supports neither.
 *   - A theme only becomes a finding when at least MIN_EVIDENCE same-polarity
 *     reviews support it, and every finding carries a real supporting quote —
 *     sentiment is never asserted from the rating alone.
 *
 * The async boundary (analyzeReviews.ts) wraps this; a future real classifier
 * or model can replace the engine while keeping the AnalysisResult contract.
 */

/** Minimum same-polarity supporting reviews before a theme becomes a finding. */
export const MIN_EVIDENCE = 2;

/** Ratings at or above this count as positive evidence. */
const POSITIVE_RATING = 4;
/** Ratings at or below this count as negative evidence. */
const NEGATIVE_RATING = 2;

/** Error type the UI can distinguish from unexpected runtime failures. */
export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}

/** Return reviews for a product within an inclusive date range, oldest first. */
export function filterReviews(
  reviews: Review[],
  productId: string,
  from: string,
  to: string,
): Review[] {
  return reviews
    .filter((r) => r.productId === productId && r.date >= from && r.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Sample-data context for a product (count + available date span). */
export function reviewStatsFor(productId: string, reviews: Review[]): ReviewStats {
  const dates = reviews
    .filter((r) => r.productId === productId)
    .map((r) => r.date)
    .sort();
  return {
    count: dates.length,
    from: dates[0] ?? "",
    to: dates[dates.length - 1] ?? "",
  };
}

/** Run the analysis for a product + date range against a set of reviews. */
export function analyze(input: AnalysisInput, reviews: Review[], products: Product[]): AnalysisResult {
  const { productId, from, to } = input;

  const product = products.find((p) => p.id === productId);
  if (!product) {
    throw new AnalysisError(`Unknown product: ${productId}`);
  }
  if (from > to) {
    throw new AnalysisError("The start date must be on or before the end date.");
  }

  const matched = filterReviews(reviews, productId, from, to);
  const reviewCount = matched.length;
  const averageRating =
    reviewCount === 0 ? 0 : round1(matched.reduce((sum, r) => sum + r.rating, 0) / reviewCount);

  const praise: Finding[] = [];
  const faults: Finding[] = [];
  for (const theme of THEME_LIBRARY) {
    const mentioning = matched.filter((r) => reviewMentions(r, theme));
    if (mentioning.length === 0) continue;

    const positives = mentioning.filter((r) => r.rating >= POSITIVE_RATING);
    const negatives = mentioning.filter((r) => r.rating <= NEGATIVE_RATING);

    // A theme can surface in both columns when opinion is genuinely split.
    if (positives.length >= MIN_EVIDENCE) {
      praise.push(makeFinding(theme, "positive", positives, reviewCount));
    }
    if (negatives.length >= MIN_EVIDENCE) {
      faults.push(makeFinding(theme, "negative", negatives, reviewCount));
    }
  }
  praise.sort(byMentions);
  faults.sort(byMentions);

  // Recommendations only for fault themes present in range, ordered like faults.
  const recByLabel = new Map(THEME_LIBRARY.map((t) => [t.label, t.recommendation]));
  const recommendations = faults
    .map((f) => recByLabel.get(f.label))
    .filter((rec): rec is string => Boolean(rec));

  return {
    productName: product.name,
    from,
    to,
    reviewCount,
    averageRating,
    summary: buildSummary(product, reviewCount, averageRating, praise, faults),
    praise,
    faults,
    recommendations,
  };
}

// --- internal helpers -------------------------------------------------------

function byMentions(a: Finding, b: Finding): number {
  return b.mentions - a.mentions || a.label.localeCompare(b.label);
}

function reviewMentions(review: Review, theme: ThemeDef): boolean {
  const text = review.text.toLowerCase();
  return theme.keywords.some((kw) => text.includes(kw));
}

/** Build an evidence-backed finding from same-polarity supporting reviews. */
function makeFinding(theme: ThemeDef, sentiment: Sentiment, supporting: Review[], reviewCount: number): Finding {
  const representative = pickRepresentative(supporting, sentiment, theme.keywords);
  return {
    label: theme.label,
    sentiment,
    mentions: supporting.length,
    percent: Math.round((supporting.length / reviewCount) * 100),
    quote: extractQuote(representative, theme.keywords),
    quoteAuthor: attribution(representative),
  };
}

/**
 * Choose the review that best represents a finding. First prefer the most
 * on-topic review (most theme keywords mentioned), so the quote clearly
 * illustrates the theme; then by sentiment strength (highest rating for
 * praise, lowest for a fault); then earliest date, so results are
 * deterministic regardless of engine sort stability.
 */
function pickRepresentative(reviews: Review[], sentiment: Sentiment, keywords: string[]): Review {
  return [...reviews].sort((a, b) => {
    const hitsA = keywordHits(a, keywords);
    const hitsB = keywordHits(b, keywords);
    if (hitsA !== hitsB) return hitsB - hitsA;
    if (a.rating !== b.rating) {
      return sentiment === "positive" ? b.rating - a.rating : a.rating - b.rating;
    }
    return a.date.localeCompare(b.date);
  })[0] as Review;
}

/** Count how many distinct theme keywords appear in a review. */
function keywordHits(review: Review, keywords: string[]): number {
  const text = review.text.toLowerCase();
  return keywords.reduce((n, kw) => n + (text.includes(kw) ? 1 : 0), 0);
}

/** Pull the sentence that mentions the theme, so the quote is on-topic. */
function extractQuote(review: Review, keywords: string[]): string {
  const sentences = review.text.split(/(?<=[.!?])\s+/);
  const hit = sentences.find((s) => {
    const lower = s.toLowerCase();
    return keywords.some((kw) => lower.includes(kw));
  });
  return (hit ?? review.text).trim();
}

/** Attribution for a quote — named author if present, else an anonymous label. */
function attribution(review: Review): string {
  if (review.author) return review.author;
  const who = review.verifiedPurchase ? "Verified buyer" : "Buyer";
  return review.country ? `${who} · ${review.country}` : who;
}

function buildSummary(
  product: Product,
  reviewCount: number,
  averageRating: number,
  praise: Finding[],
  faults: Finding[],
): string {
  if (reviewCount === 0) {
    return `No reviews for ${product.name} fall in the selected window.`;
  }

  const rating = averageRating.toFixed(1);
  const base =
    reviewCount === 1
      ? `Based on a single review of ${product.name} (rated ${rating}★), `
      : `Across ${reviewCount} reviews of ${product.name} (averaging ${rating}★), `;

  const top = praise[0];
  const bottom = faults[0];
  const posClause = top
    ? `${lowerFirst(top.label)} draws the most praise (${top.mentions} of ${reviewCount})`
    : "";
  const negClause = bottom
    ? `${lowerFirst(bottom.label)} is the most common complaint (${bottom.mentions} of ${reviewCount})`
    : "";

  if (top && bottom && top.label === bottom.label) {
    return `${base}opinion is most divided on ${lowerFirst(top.label)} (${top.mentions} praise vs ${bottom.mentions} complaints).`;
  }
  if (top && bottom) return `${base}${posClause}, while ${negClause}.`;
  if (top) return `${base}${posClause}. No recurring complaints have enough evidence in this window.`;
  if (bottom) return `${base}${negClause}. Little positive sentiment has enough evidence in this window.`;
  return `${base}no themes reach the evidence threshold — individual reviews vary.`;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
