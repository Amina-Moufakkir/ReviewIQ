import type { PromotionInsight, Review } from "../types";

/**
 * Pure, deterministic promotion/discount analysis. It sits alongside the core
 * analysis engine (analysisEngine.ts) rather than inside it, so the engine stays
 * intact and this concern is independently testable.
 *
 * A review counts as a *promoted purchase* when it carries a non-empty
 * `promotion` label or a positive `discountPercent`. The insight compares
 * promoted purchases against full-price ones on average rating.
 *
 * It returns `undefined` when no matched review is promoted — either the dataset
 * has no promotion columns, or none of the reviews in the window were on
 * promotion. Callers treat that as "nothing to show" and degrade gracefully.
 */

/** Whether a review's purchase was made under a promotion or discount. */
export function isPromotional(review: Review): boolean {
  if (review.promotion && review.promotion.trim()) return true;
  return typeof review.discountPercent === "number" && review.discountPercent > 0;
}

export function analyzePromotions(matched: Review[]): PromotionInsight | undefined {
  const promo = matched.filter(isPromotional);
  if (promo.length === 0) return undefined;

  const fullPrice = matched.filter((r) => !isPromotional(r));
  const promoAverageRating = averageRating(promo);
  const fullPriceAverageRating = averageRating(fullPrice);
  const comparable = fullPrice.length > 0;
  const ratingDelta = comparable ? round1(promoAverageRating - fullPriceAverageRating) : 0;

  const promotions = [
    ...new Set(
      promo
        .map((r) => r.promotion?.trim())
        .filter((label): label is string => Boolean(label)),
    ),
  ].sort((a, b) => a.localeCompare(b));

  return {
    promoCount: promo.length,
    fullPriceCount: fullPrice.length,
    promoAverageRating,
    fullPriceAverageRating,
    ratingDelta,
    promotions,
    comparable,
    note: buildNote(promo.length, promoAverageRating, fullPriceAverageRating, comparable, ratingDelta),
  };
}

// --- internal helpers -------------------------------------------------------

/** Ratings within 0.1★ are treated as "about the same" rather than a trend. */
const MEANINGFUL_DELTA = 0.1;

function averageRating(reviews: Review[]): number {
  if (reviews.length === 0) return 0;
  return round1(reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length);
}

function buildNote(
  promoCount: number,
  promoAvg: number,
  fullPriceAvg: number,
  comparable: boolean,
  delta: number,
): string {
  const promoStars = promoAvg.toFixed(1);
  if (!comparable) {
    const n = promoCount === 1 ? "review" : "reviews";
    return `All ${promoCount} ${n} in this window were tied to a promotion (averaging ${promoStars}★); there are no full-price reviews to compare against.`;
  }

  const fullStars = fullPriceAvg.toFixed(1);
  const magnitude = Math.abs(delta).toFixed(1);
  if (delta >= MEANINGFUL_DELTA) {
    return `Promoted purchases rated ${promoStars}★ on average — ${magnitude}★ higher than full-price reviews (${fullStars}★).`;
  }
  if (delta <= -MEANINGFUL_DELTA) {
    return `Promoted purchases rated ${promoStars}★ on average — ${magnitude}★ lower than full-price reviews (${fullStars}★).`;
  }
  return `Promoted and full-price purchases rated about the same (${promoStars}★ vs ${fullStars}★).`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
