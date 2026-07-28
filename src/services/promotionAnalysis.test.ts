import { describe, it, expect } from "vitest";
import type { Review } from "../types";
import { analyzePromotions, isPromotional } from "./promotionAnalysis";

function review(partial: Partial<Review> & Pick<Review, "id" | "rating">): Review {
  return { productId: "p1", date: "2026-02-01", text: "A review.", ...partial };
}

describe("isPromotional", () => {
  it("is true for a non-empty promotion label", () => {
    expect(isPromotional(review({ id: "a", rating: 5, promotion: "Spring Sale" }))).toBe(true);
  });
  it("is true for a positive discount percent", () => {
    expect(isPromotional(review({ id: "a", rating: 5, discountPercent: 10 }))).toBe(true);
  });
  it("is false for a blank label, zero discount, or no promotion fields", () => {
    expect(isPromotional(review({ id: "a", rating: 5 }))).toBe(false);
    expect(isPromotional(review({ id: "b", rating: 5, promotion: "  " }))).toBe(false);
    expect(isPromotional(review({ id: "c", rating: 5, discountPercent: 0 }))).toBe(false);
  });
});

describe("analyzePromotions", () => {
  it("returns undefined when no matched review is promoted (graceful degrade)", () => {
    const reviews = [review({ id: "a", rating: 5 }), review({ id: "b", rating: 4 })];
    expect(analyzePromotions(reviews)).toBeUndefined();
  });

  it("splits promoted vs full-price and computes averages and delta", () => {
    const reviews = [
      review({ id: "p1", rating: 4, promotion: "Spring Sale" }),
      review({ id: "p2", rating: 2, discountPercent: 20 }),
      review({ id: "f1", rating: 5 }),
      review({ id: "f2", rating: 5 }),
    ];
    const insight = analyzePromotions(reviews)!;
    expect(insight.promoCount).toBe(2);
    expect(insight.fullPriceCount).toBe(2);
    expect(insight.promoAverageRating).toBe(3); // (4 + 2) / 2
    expect(insight.fullPriceAverageRating).toBe(5);
    expect(insight.ratingDelta).toBe(-2); // 3 − 5
    expect(insight.comparable).toBe(true);
    expect(insight.note).toMatch(/lower than full-price/i);
  });

  it("lists distinct promotion labels, sorted, ignoring discount-only reviews", () => {
    const reviews = [
      review({ id: "p1", rating: 4, promotion: "Spring Sale" }),
      review({ id: "p2", rating: 3, promotion: "Launch Offer" }),
      review({ id: "p3", rating: 5, promotion: "Spring Sale" }),
      review({ id: "p4", rating: 5, discountPercent: 10 }), // promoted but unlabeled
      review({ id: "f1", rating: 5 }),
    ];
    const insight = analyzePromotions(reviews)!;
    expect(insight.promotions).toEqual(["Launch Offer", "Spring Sale"]);
    expect(insight.promoCount).toBe(4);
  });

  it("handles an all-promoted window with no full-price comparison", () => {
    const reviews = [
      review({ id: "p1", rating: 4, promotion: "Spring Sale" }),
      review({ id: "p2", rating: 5, promotion: "Spring Sale" }),
    ];
    const insight = analyzePromotions(reviews)!;
    expect(insight.fullPriceCount).toBe(0);
    expect(insight.comparable).toBe(false);
    expect(insight.ratingDelta).toBe(0);
    expect(insight.note).toMatch(/no full-price reviews to compare/i);
  });

  it("reads a small rating gap as 'about the same'", () => {
    const reviews = [
      review({ id: "p1", rating: 4, promotion: "Sale" }),
      review({ id: "f1", rating: 4 }),
    ];
    const insight = analyzePromotions(reviews)!;
    expect(insight.ratingDelta).toBe(0);
    expect(insight.note).toMatch(/about the same/i);
  });
});
