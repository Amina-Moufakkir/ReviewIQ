import type { AnalysisInput, AnalysisResult, Finding, Product, Review, ReviewStats, Sentiment } from "../types";
import { THEME_LIBRARY, type ThemeDef } from "./themeLibrary";
import { matchesKeyword } from "../lib/matchKeyword";
import { analyzePromotions } from "./promotionAnalysis";
import { REVIEW, scopeLabel, themePhrase, type DatasetUnit } from "../lib/datasetInfo";
import { lowerFirst } from "../lib/themeLabel";

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
 *   - A theme only becomes a finding when enough same-polarity rows support it
 *     (see minEvidenceFor — two reviews, or one product record, since a record
 *     already bundles many customers), and every finding carries a real
 *     supporting quote — sentiment is never asserted from the rating alone.
 *
 * The async boundary (analyzeReviews.ts) wraps this; a future real classifier
 * or model can replace the engine while keeping the AnalysisResult contract.
 */

/** Minimum same-polarity supporting reviews before a theme becomes a finding. */
export const MIN_EVIDENCE = 2;

/**
 * How many same-polarity rows a theme needs before it becomes a finding.
 *
 * The threshold exists so one person's passing remark is never reported as a
 * theme. That is what two REVIEW rows buy: two separate customers. It is not
 * what two PRODUCT RECORDS buy — one record already bundles roughly eight
 * customers' reviews behind a rating averaged over thousands, so requiring two
 * of them requires the same product to be listed twice on the marketplace,
 * which is an artifact of duplicate listings rather than evidence.
 *
 * On this dataset that mattered: 1,258 of 1,350 products have exactly one
 * record, so every theme in them was found and then discarded, and 88% of
 * products whose text matches a theme reported nothing at all.
 *
 * So the unit decides the threshold. Review data is unchanged at 2; product
 * records need 1, because the aggregation the threshold demands has already
 * happened inside the cell. What a product-level finding then claims is
 * weaker and the UI says so: the theme is *mentioned* in that record, not
 * *recurring* across customers (see `themePhrase`).
 */
export function minEvidenceFor(unit: DatasetUnit): number {
  return unit.isProductLevel ? 1 : MIN_EVIDENCE;
}

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

/**
 * What one analysis run covers: the subject it is about, and the rows it reads.
 *
 * BOTH engines resolve scope through `selectForScope` so they can never disagree
 * about which rows a query selects. The two-engine comparison is only meaningful
 * because they see identical input; duplicating this logic would quietly break
 * that the first time one copy changed.
 */
export interface ScopeSelection {
  /**
   * What the result is about. For product scope this is the real `Product`. For
   * category scope it is synthesized from the category name, so the existing
   * `AnalysisResult` contract and `buildSummary` need no change — the category
   * simply takes the subject's place.
   */
  subject: Product;
  /** The matched rows, oldest first, exactly as the engines consume them. */
  rows: Review[];
}

/**
 * Resolve a query to its subject and its rows.
 *
 * Category scope selects every accepted row belonging to any product whose
 * `topCategory` matches — across all products in that category — and then
 * applies the same date window as product scope. For undated data the window is
 * `"" .. ""`, which matches every undated row, so the behaviour is unchanged.
 *
 * The unit is deliberately absent here: whether a row is a review or a product
 * record is a property of the dataset, not of the scope, and widening the
 * selection must not change it.
 */
export function selectForScope(
  input: AnalysisInput,
  reviews: Review[],
  products: Product[],
): ScopeSelection {
  const { scope, from, to } = input;

  if (scope.kind === "product") {
    const product = products.find((p) => p.id === scope.productId);
    if (!product) throw new AnalysisError(`Unknown product: ${scope.productId}`);
    assertRange(from, to);
    return { subject: product, rows: filterReviews(reviews, scope.productId, from, to) };
  }

  const inCategory = products.filter((p) => p.topCategory === scope.category);
  if (inCategory.length === 0) throw new AnalysisError(`Unknown category: ${scope.category}`);
  assertRange(from, to);

  const ids = new Set(inCategory.map((p) => p.id));
  return {
    // DELIBERATE, not a bug to tidy up: at category scope every field carries
    // the category label. `name` flows into `AnalysisResult.productName`, so
    // that field holds "Electronics" rather than a product name — a knowing
    // trade for leaving the AnalysisResult contract untouched. Nothing
    // user-facing is ambiguous: the header and the copied report both state the
    // scope. The clean fix, if that contract is ever opened, is an optional
    // `scopeLabel` on AnalysisResult — not a rename here.
    //
    // `category`/`topCategory` are the category itself because a category
    // belongs to nothing above it.
    subject: {
      id: scope.category,
      name: scope.category,
      category: scope.category,
      topCategory: scope.category,
    },
    rows: reviews
      .filter((r) => ids.has(r.productId) && r.date >= from && r.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function assertRange(from: string, to: string): void {
  if (from > to) {
    throw new AnalysisError("The start date must be on or before the end date.");
  }
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

/** Run the analysis for the chosen scope + date range against a set of reviews. */
export function analyze(
  input: AnalysisInput,
  reviews: Review[],
  products: Product[],
  unit: DatasetUnit = REVIEW,
): AnalysisResult {
  const { from, to } = input;
  const { subject: product, rows: matched } = selectForScope(input, reviews, products);
  const reviewCount = matched.length;
  const averageRating =
    reviewCount === 0 ? 0 : round1(matched.reduce((sum, r) => sum + r.rating, 0) / reviewCount);

  const minEvidence = minEvidenceFor(unit);
  const praise: Finding[] = [];
  const faults: Finding[] = [];
  for (const theme of THEME_LIBRARY) {
    const mentioning = matched.filter((r) => reviewMentions(r, theme));
    if (mentioning.length === 0) continue;

    const positives = mentioning.filter((r) => r.rating >= POSITIVE_RATING);
    const negatives = mentioning.filter((r) => r.rating <= NEGATIVE_RATING);

    // A theme can surface in both columns when opinion is genuinely split.
    if (positives.length >= minEvidence) {
      praise.push(makeFinding(theme, "positive", positives, reviewCount));
    }
    if (negatives.length >= minEvidence) {
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
    summary: buildSummary(product, reviewCount, averageRating, praise, faults, unit, datedRows(matched)),
    praise,
    faults,
    recommendations,
    // Optional: present only when the matched reviews carry promotion data.
    promotion: analyzePromotions(matched),
  };
}

// --- internal helpers -------------------------------------------------------

function byMentions(a: Finding, b: Finding): number {
  return b.mentions - a.mentions || a.label.localeCompare(b.label);
}

function reviewMentions(review: Review, theme: ThemeDef): boolean {
  return theme.keywords.some((kw) => matchesKeyword(review.text, kw));
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
  return keywords.reduce((n, kw) => n + (matchesKeyword(review.text, kw) ? 1 : 0), 0);
}

/** Pull the sentence that mentions the theme, so the quote is on-topic. */
function extractQuote(review: Review, keywords: string[]): string {
  const sentences = review.text.split(/([.!?])\s+/).reduce<string[]>((acc, part, i) => {
    // Re-join sentence text with its trailing punctuation (odd indices).
    if (i % 2 === 0) acc.push(part);
    else acc[acc.length - 1] += part;
    return acc;
  }, []);
  const hit = sentences.find((s) => keywords.some((kw) => matchesKeyword(s, kw)));
  return (hit ?? review.text).trim();
}

/**
 * Attribution for a quote — named author if present, else an anonymous label.
 * Exported so the Claude engine can attribute evidence spans the same way.
 */
export function attribution(review: Review): string {
  if (review.author) return review.author;
  const who = review.verifiedPurchase ? "Verified buyer" : "Buyer";
  return review.country ? `${who} · ${review.country}` : who;
}

/**
 * Compose the one-line brief from the findings. Exported so the Claude engine
 * produces an identically-shaped summary from its own findings.
 *
 * `unit` names what one analyzed row is, so the sentence can say "product
 * record" where a row is a product listing rather than one customer's review.
 * It is the same `DatasetUnit` the UI reads, so the two can never disagree, and
 * it is deliberately a generic label: the engine still knows nothing about any
 * particular dataset. It defaults to reviews, which is what an unqualified row
 * is everywhere except a product-level source.
 */
export function buildSummary(
  product: Product,
  reviewCount: number,
  averageRating: number,
  praise: Finding[],
  faults: Finding[],
  unit: DatasetUnit = REVIEW,
  hasReviewDates = true,
): string {
  if (reviewCount === 0) {
    return `No ${unit.many} for ${product.name} fall in the selected window.`;
  }

  const rating = averageRating.toFixed(1);
  const base =
    reviewCount === 1
      ? `Based on a single ${unit.one} of ${product.name} (rated ${rating}★), `
      : `Across ${reviewCount} ${unit.many} of ${product.name} (averaging ${rating}★), `;

  const top = praise[0];
  const bottom = faults[0];
  // "(1 of 1)" is trivially true and reads as unanimity, exactly as it does in
  // the findings column, so a lone row states the theme without the tally.
  const support = (f: Finding) => (reviewCount === 1 ? "" : ` (${f.mentions} of ${reviewCount})`);
  const posClause = top ? `${lowerFirst(top.label)} draws the most praise${support(top)}` : "";
  const negClause = bottom ? `${lowerFirst(bottom.label)} is the most common complaint${support(bottom)}` : "";
  // Undated data has no window to speak of, and one product record cannot make
  // anything recurring — the same rules the rest of the UI follows.
  const scope = scopeLabel(unit, hasReviewDates);

  if (top && bottom && top.label === bottom.label) {
    return `${base}opinion is most divided on ${lowerFirst(top.label)} (${top.mentions} praise vs ${bottom.mentions} complaints).`;
  }
  if (top && bottom) return `${base}${posClause}, while ${negClause}.`;
  if (top) return `${base}${posClause}. No ${themePhrase(unit, "complaints")} have enough evidence ${scope}.`;
  if (bottom) return `${base}${negClause}. Little positive sentiment has enough evidence ${scope}.`;
  return `${base}no themes reach the evidence threshold — individual ${unit.many} vary.`;
}

/**
 * Whether these rows carry dates. Mirrors `hasDates(dataset)` for the matched
 * subset, so the summary never mentions a window the data cannot have.
 */
function datedRows(rows: Review[]): boolean {
  return rows.length > 0 && rows.every((r) => r.date !== "");
}


function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
