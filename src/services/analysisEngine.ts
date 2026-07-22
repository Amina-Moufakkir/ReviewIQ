import type {
  AnalysisInput,
  AnalysisResult,
  Finding,
  Product,
  Review,
  ReviewStats,
  Sentiment,
} from "../types";
import { getProduct } from "../data/products";

/**
 * Pure, synchronous analysis engine. No React, no I/O, no latency — so it is
 * trivially testable and deterministic. The async service boundary
 * (analyzeReviews.ts) wraps this; a future real model would replace the wrapper
 * while keeping this contract.
 *
 * Everything the engine returns is derived from the reviews that fall inside
 * the selected product and date range. Nothing is hardcoded per product except
 * the theme vocabulary (keywords + the action to recommend for a negative
 * theme) — the findings themselves only exist when reviews support them.
 */

/** Error type the UI can distinguish from unexpected runtime failures. */
export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}

interface ThemeDef {
  label: string;
  sentiment: Sentiment;
  /** Lowercase keywords; a review mentions the theme if its text includes any. */
  keywords: string[];
  /** Action to recommend when a negative theme appears in range. */
  recommendation?: string;
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
export function analyze(input: AnalysisInput, reviews: Review[]): AnalysisResult {
  const { productId, from, to } = input;

  const product = getProduct(productId);
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

  const themes = THEME_CATALOG[productId] ?? [];
  const findings = themes
    .map((theme) => buildFinding(theme, matched))
    .filter((f): f is Finding => f !== null);

  const praise = findings.filter((f) => f.sentiment === "positive").sort(byMentions);
  const faults = findings.filter((f) => f.sentiment === "negative").sort(byMentions);

  // Recommendations only for negative themes that actually appear, ordered to
  // match the faults (most-mentioned first).
  const recByLabel = new Map(
    themes.filter((t) => t.recommendation).map((t) => [t.label, t.recommendation as string]),
  );
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

/** Build a finding for a theme, or null when no matched review mentions it. */
function buildFinding(theme: ThemeDef, matched: Review[]): Finding | null {
  const mentioning = matched.filter((r) => reviewMentions(r, theme));
  if (mentioning.length === 0) return null;

  const representative = pickRepresentative(mentioning, theme);
  return {
    label: theme.label,
    sentiment: theme.sentiment,
    mentions: mentioning.length,
    percent: Math.round((mentioning.length / matched.length) * 100),
    quote: extractQuote(representative, theme.keywords),
    quoteAuthor: representative.author,
  };
}

/**
 * Choose the review that best represents a theme. First prefer the most
 * on-topic review (most theme keywords mentioned), so the quote clearly
 * illustrates the theme; then by sentiment strength (highest rating for
 * praise, lowest for a fault); then earliest date, so results are
 * deterministic regardless of engine sort stability.
 */
function pickRepresentative(reviews: Review[], theme: ThemeDef): Review {
  return [...reviews].sort((a, b) => {
    const hitsA = keywordHits(a, theme.keywords);
    const hitsB = keywordHits(b, theme.keywords);
    if (hitsA !== hitsB) return hitsB - hitsA;
    if (a.rating !== b.rating) {
      return theme.sentiment === "positive" ? b.rating - a.rating : a.rating - b.rating;
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

  if (top && bottom) return `${base}${posClause}, while ${negClause}.`;
  if (top) return `${base}${posClause}. No recurring complaints surface in this window.`;
  if (bottom) return `${base}${negClause}. Little positive sentiment surfaces in this window.`;
  return `${base}no recurring themes surface — individual reviews vary.`;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Theme vocabulary per product. Keywords are matched case-insensitively as
 * substrings of review text. Negative themes carry the action to recommend
 * when they appear. This is the only per-product knowledge in the engine — the
 * findings are still built solely from reviews in range.
 */
const THEME_CATALOG: Record<string, ThemeDef[]> = {
  "aurora-earbuds": [
    { label: "Sound quality", sentiment: "positive", keywords: ["sound", "bass", "crisp", "audio"] },
    { label: "Battery life", sentiment: "positive", keywords: ["battery"] },
    { label: "Noise cancellation", sentiment: "positive", keywords: ["noise cancellation", "noise"] },
    { label: "Comfort & fit", sentiment: "positive", keywords: ["comfortable", "comfort", "fit", "secure"] },
    {
      label: "Connectivity",
      sentiment: "negative",
      keywords: ["connection", "bluetooth", "dropping", "stutter"],
      recommendation:
        "Investigate the Bluetooth stack for the pocket/occlusion signal drops reported on calls.",
    },
    {
      label: "Touch controls",
      sentiment: "negative",
      keywords: ["touch controls", "controls", "touch", "pausing"],
      recommendation: "Add a setting to lower touch sensitivity or disable tap-to-pause.",
    },
    {
      label: "Charging case",
      sentiment: "negative",
      keywords: ["case", "charging"],
      recommendation: "Review charging-case contact reliability and build quality with the manufacturer.",
    },
  ],
  "trailpeak-backpack": [
    { label: "Comfort", sentiment: "positive", keywords: ["comfortable", "comfort", "straps", "hip belt", "padded"] },
    { label: "Durability", sentiment: "positive", keywords: ["durable", "tough", "durability"] },
    { label: "Storage", sentiment: "positive", keywords: ["storage", "pockets", "roomy", "spacious", "capacity"] },
    {
      label: "Zippers",
      sentiment: "negative",
      keywords: ["zipper", "zippers"],
      recommendation: "Source higher-grade zippers or offer a warranty-backed replacement.",
    },
    {
      label: "Water resistance",
      sentiment: "negative",
      keywords: ["rain", "waterproof", "damp", "storm"],
      recommendation: "Bundle a rain cover or improve out-of-the-box water resistance.",
    },
  ],
  "brewmaster-espresso": [
    { label: "Espresso quality", sentiment: "positive", keywords: ["espresso", "crema", "shots", "shot"] },
    { label: "Milk frother", sentiment: "positive", keywords: ["frother", "froth", "latte"] },
    {
      label: "Cleaning",
      sentiment: "negative",
      keywords: ["cleaning", "clean", "maintain", "maintenance", "tedious"],
      recommendation: "Simplify cleaning with a removable, dishwasher-safe drip tray and portafilter.",
    },
    {
      label: "Reliability",
      sentiment: "negative",
      keywords: ["pressure", "leaking", "leak", "stopped", "reliability"],
      recommendation: "Investigate pressure-loss and leaking failures reported within the first months.",
    },
    {
      label: "Noise & learning curve",
      sentiment: "negative",
      keywords: ["loud", "learning curve"],
      recommendation: "Ship a quick-start guide and investigate operating noise.",
    },
  ],
};
