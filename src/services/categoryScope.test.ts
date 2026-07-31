import { describe, it, expect } from "vitest";
import type { AnalysisInput, Product, Review } from "../types";
import { analyze, selectForScope, AnalysisError } from "./analysisEngine";
import { categoriesIn, PRODUCT_RECORD, REVIEW } from "../lib/datasetInfo";
import { topLevelCategory } from "../lib/categoryKey";
import { products as builtInProducts } from "../data/products";
import type { Dataset } from "../types";

/**
 * Two products in one category, one in another — the shape category scope
 * exists for. Rows must aggregate ACROSS products within a category, and stop
 * at its boundary.
 */
const PRODUCTS: Product[] = [
  { id: "buds", name: "Earbuds", category: "Audio", topCategory: "Electronics" },
  { id: "dock", name: "Dock", category: "Cables", topCategory: "Electronics" },
  { id: "pan", name: "Frying Pan", category: "Cookware", topCategory: "Kitchen" },
];

function review(id: string, productId: string, date: string, rating: number, text: string): Review {
  return { id, productId, date, rating, text };
}

const REVIEWS: Review[] = [
  review("e1", "buds", "2026-02-01", 5, "The sound quality is superb."),
  review("e2", "dock", "2026-03-01", 5, "Great sound quality from this dock."),
  review("e3", "dock", "2026-06-01", 2, "Connection keeps dropping on calls."),
  review("k1", "pan", "2026-02-15", 5, "The sound quality is superb."),
];

const category = (name: string, from = "", to = ""): AnalysisInput => ({
  scope: { kind: "category", category: name },
  from,
  to,
});
const product = (id: string, from = "", to = ""): AnalysisInput => ({
  scope: { kind: "product", productId: id },
  from,
  to,
});

const WIDE = { from: "2026-01-01", to: "2026-12-31" };

describe("selectForScope — category scope", () => {
  it("selects every row across all products in the category", () => {
    const { rows } = selectForScope(category("Electronics", WIDE.from, WIDE.to), REVIEWS, PRODUCTS);
    expect(rows.map((r) => r.id).sort()).toEqual(["e1", "e2", "e3"]);
  });

  it("selects ONLY that category — rows from another are excluded", () => {
    const { rows } = selectForScope(category("Electronics", WIDE.from, WIDE.to), REVIEWS, PRODUCTS);
    expect(rows.some((r) => r.productId === "pan")).toBe(false);

    const kitchen = selectForScope(category("Kitchen", WIDE.from, WIDE.to), REVIEWS, PRODUCTS);
    expect(kitchen.rows.map((r) => r.id)).toEqual(["k1"]);
  });

  it("groups on the TOP-LEVEL category, never the leaf", () => {
    // "Audio" and "Cables" are leaves inside Electronics; neither is a key.
    expect(() => selectForScope(category("Audio", WIDE.from, WIDE.to), REVIEWS, PRODUCTS)).toThrow(
      AnalysisError,
    );
  });

  it("names the category as the subject, so the result reads about it", () => {
    const { subject } = selectForScope(category("Electronics", WIDE.from, WIDE.to), REVIEWS, PRODUCTS);
    expect(subject.name).toBe("Electronics");
    expect(subject.id).toBe("Electronics");
  });

  it("rejects a category no product belongs to", () => {
    expect(() => selectForScope(category("Garden", WIDE.from, WIDE.to), REVIEWS, PRODUCTS)).toThrow(
      /Unknown category: Garden/,
    );
  });

  it("applies the date window exactly as product scope does", () => {
    const { rows } = selectForScope(
      category("Electronics", "2026-02-01", "2026-03-31"),
      REVIEWS,
      PRODUCTS,
    );
    expect(rows.map((r) => r.id)).toEqual(["e1", "e2"]); // e3 is June
  });

  it("includes every row for undated data, where the window is empty", () => {
    const undated = REVIEWS.map((r) => ({ ...r, date: "" }));
    const { rows } = selectForScope(category("Electronics"), undated, PRODUCTS);
    expect(rows).toHaveLength(3);
  });

  it("rejects an inverted date range, like product scope", () => {
    expect(() =>
      selectForScope(category("Electronics", "2026-05-01", "2026-01-01"), REVIEWS, PRODUCTS),
    ).toThrow(/start date must be on or before/i);
  });
});

describe("selectForScope — product scope is unchanged", () => {
  it("still selects one product's rows only", () => {
    const { rows, subject } = selectForScope(product("dock", WIDE.from, WIDE.to), REVIEWS, PRODUCTS);
    expect(rows.map((r) => r.id)).toEqual(["e2", "e3"]);
    expect(subject.name).toBe("Dock");
  });

  it("still rejects an unknown product", () => {
    expect(() => selectForScope(product("nope", WIDE.from, WIDE.to), REVIEWS, PRODUCTS)).toThrow(
      /Unknown product: nope/,
    );
  });
});

describe("analyze at category scope — the unit is unchanged by widening", () => {
  // Two DIFFERENT products both mention sound quality positively. Under review
  // data the threshold is 2, so this is only a finding because rows aggregate
  // across products — which is the point of category scope.
  it("meets the review threshold using rows from different products", () => {
    const result = analyze(category("Electronics", WIDE.from, WIDE.to), REVIEWS, PRODUCTS, REVIEW);
    const sound = result.praise.find((f) => f.label === "Sound quality");
    expect(sound?.mentions).toBe(2);
    expect(result.reviewCount).toBe(3);
    expect(result.summary).toMatch(/reviews/);
    expect(result.summary).not.toMatch(/product records/);
  });

  it("counts product records, not reviews, for product-level data", () => {
    const result = analyze(
      category("Electronics", WIDE.from, WIDE.to),
      REVIEWS,
      PRODUCTS,
      PRODUCT_RECORD,
    );
    expect(result.reviewCount).toBe(3);
    expect(result.summary).toMatch(/product records/);
    expect(result.summary).not.toMatch(/\breviews\b/);
  });

  // The per-unit threshold still governs: one supporting row is enough for a
  // product record, not for a review.
  it("keeps the per-unit evidence threshold at category scope", () => {
    const single = [review("k1", "pan", "2026-02-15", 5, "The sound quality is superb.")];
    const asReviews = analyze(category("Kitchen", WIDE.from, WIDE.to), single, PRODUCTS, REVIEW);
    const asRecords = analyze(
      category("Kitchen", WIDE.from, WIDE.to),
      single,
      PRODUCTS,
      PRODUCT_RECORD,
    );
    expect(asReviews.praise).toHaveLength(0); // 1 review < threshold of 2
    expect(asRecords.praise).toHaveLength(1); // 1 record meets the threshold of 1
  });

  it("reports the category as the subject in the result", () => {
    const result = analyze(category("Electronics", WIDE.from, WIDE.to), REVIEWS, PRODUCTS, REVIEW);
    expect(result.productName).toBe("Electronics");
  });
});

/**
 * The built-in catalog is the one place `topCategory` is hand-written rather
 * than derived, so it is the one place it can be wrong. Its categories are flat,
 * which makes the invariant exact: for a flat value the top level IS the value.
 *
 * Without this, adding a product with a piped category — or simply mistyping
 * `topCategory` — would compile, pass every other test, and quietly drop that
 * product out of its category in the picker.
 */
describe("built-in catalog — the hand-written topCategory values", () => {
  it("derives to itself, because its categories are flat", () => {
    for (const product of builtInProducts) {
      expect(product.topCategory, `${product.id}`).toBe(topLevelCategory(product.category));
      expect(product.topCategory, `${product.id}`).toBe(product.category);
    }
  });

  it("gives every product a non-empty key, so none is unreachable by category", () => {
    expect(builtInProducts.every((p) => p.topCategory.trim() !== "")).toBe(true);
  });
});

describe("categoriesIn — what the picker offers", () => {
  const dataset: Dataset = {
    products: PRODUCTS,
    reviews: REVIEWS,
    source: "uploaded",
    label: "t.csv",
  };

  it("lists each top-level category once, alphabetically", () => {
    expect(categoriesIn(dataset).map((c) => c.category)).toEqual(["Electronics", "Kitchen"]);
  });

  it("counts both the products in a category and the rows the engine would read", () => {
    const [electronics, kitchen] = categoriesIn(dataset);
    expect(electronics).toEqual({ category: "Electronics", productCount: 2, rowCount: 3 });
    expect(kitchen).toEqual({ category: "Kitchen", productCount: 1, rowCount: 1 });
  });

  // An unlabelled product cannot be analyzed as part of anything, so offering a
  // blank category would offer a selection that selects nothing coherent.
  it("omits products carrying no category key rather than grouping them under a blank", () => {
    const withBlank: Dataset = {
      ...dataset,
      products: [...PRODUCTS, { id: "x", name: "Loose", category: "", topCategory: "" }],
      reviews: [...REVIEWS, review("x1", "x", "2026-02-01", 5, "Fine.")],
    };
    const keys = categoriesIn(withBlank).map((c) => c.category);
    expect(keys).toEqual(["Electronics", "Kitchen"]);
    expect(keys.every(Boolean)).toBe(true);
  });

  it("returns nothing for an empty dataset, so the scope control can hide", () => {
    expect(categoriesIn({ ...dataset, products: [], reviews: [] })).toEqual([]);
  });
});
