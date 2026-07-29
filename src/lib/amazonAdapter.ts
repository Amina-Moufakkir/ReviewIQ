import type { Dataset } from "../types";
import { parseCsv } from "./csv";
import { buildDataset, CsvError, type LoadStats, type SkipReason } from "./parseReviews";

/**
 * Deterministic adapter for the Amazon product dataset.
 *
 * It maps Amazon's columns onto ReviewIQ's canonical loader columns and hands
 * them to `buildDataset` — the same loader an uploaded CSV goes through. There
 * is no parallel loader, no second validation rule, and no separate result
 * shape. Parsing uses the existing RFC4180 parser; nothing here splits on ",".
 *
 * WHAT THIS DATA IS (and is not)
 * ------------------------------
 * One Amazon row is a PRODUCT RECORD, not a customer review. It carries a
 * product-average rating and the review text of roughly eight customers
 * concatenated into a single cell. Everything downstream therefore counts
 * product records, not people. The adapter never pretends otherwise:
 *   - `review_content` is used verbatim as the analyzed text. It is NOT split
 *     into individual reviews: the comma-separated segments line up across
 *     `review_id`/`user_id`/`review_title`/`review_content` in only 156 of the
 *     1,465 records, and 233 records contain image URLs mid-text, so any split
 *     would invent review boundaries that the source does not support.
 *   - `about_product` is marketing copy and is never mixed into the text.
 *   - `user_id`/`user_name` are comma-joined lists of several people. They are
 *     NOT a row key and NOT a customer count, so they are dropped entirely
 *     (already excluded from the shipped fixture by scripts/build-amazon-csv.mjs).
 *   - `review_id` is likewise multi-valued and not unique (11,503 tokens,
 *     9,269 distinct), so it cannot key a row. Each record gets a synthetic,
 *     positional id (`amz-0001`…) instead, which is stable across runs.
 *
 * RATING
 * ------
 * Amazon ratings are product-average decimal ratings. ReviewIQ currently
 * requires integer ratings (1–5). The adapter rounds the average rating to the
 * nearest integer for compatibility while preserving the original decimal value
 * in `Review.sourceRating`. This is a compatibility transformation, not a claim
 * that the average rating was originally an integer.
 *
 * DATES
 * -----
 * The dataset has no date field of any kind. No date is invented, derived, or
 * substituted: the canonical rows carry no `review_date` column, so the loader
 * produces undated reviews (`date: ""`) and the UI hides the date window.
 */

/** Amazon columns the adapter cannot work without. */
const REQUIRED_SOURCE_COLUMNS = ["product_id", "product_name", "category", "rating", "review_content"] as const;

/** Canonical loader columns the adapter emits. Deliberately has no review_date. */
const CANONICAL_COLUMNS = ["review_id", "product_id", "product_name", "category", "rating", "review_text"] as const;

/** Why an Amazon record was rejected before it reached the loader. */
export type AmazonSkipReason =
  | "missing_product_id"
  | "missing_review_text"
  | "invalid_rating"
  | SkipReason;

/**
 * Load stats for an Amazon parse. Reasons come from both gates: the adapter's
 * own checks and the shared loader's. `accepted + skipped === parsed`.
 */
export type AmazonStats = LoadStats;

/**
 * Normalized, source-preserving view of one accepted record. Nothing in the MVP
 * renders these yet — they exist so prices, counts and the category hierarchy
 * are available for validation and grouping without re-parsing the CSV, and so
 * the raw strings are never lost behind their normalized values.
 */
export interface AmazonRecord {
  reviewId: string;
  productId: string;
  productName: string;
  /** Full `|`-separated hierarchy, outermost first. */
  categoryPath: string[];
  /** Leaf of `categoryPath` — the value handed to the loader. */
  category: string;
  /** Rating rounded to an integer for the 1–5 contract. */
  rating: number;
  /** The product-average rating exactly as the source recorded it, e.g. 4.2. */
  sourceRating: number;
  /** Rupee amounts and counts with ₹ and thousands separators stripped. */
  discountedPrice?: number;
  actualPrice?: number;
  discountPercent?: number;
  ratingCount?: number;
  /** The source cells, verbatim, exactly as they appeared. */
  raw: {
    discounted_price: string;
    actual_price: string;
    discount_percentage: string;
    rating: string;
    rating_count: string;
    category: string;
  };
}

export interface AmazonAdapterResult {
  dataset: Dataset;
  stats: AmazonStats;
  /** Accepted records, in dataset order, with normalized and raw source values. */
  records: AmazonRecord[];
}

/**
 * Parse the Amazon CSV into a ReviewIQ dataset.
 *
 * Throws `CsvError` when the file itself is unusable (empty, missing columns,
 * nothing valid left) — the same failure contract as an uploaded CSV.
 */
export function adaptAmazonCsv(text: string, label: string): AmazonAdapterResult {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CsvError("The file is empty.");

  const header = rows[0]!.map((h) => h.trim());
  const index: Record<string, number> = {};
  header.forEach((h, i) => {
    index[h] = i;
  });

  const missing = REQUIRED_SOURCE_COLUMNS.filter((c) => !(c in index));
  if (missing.length > 0) {
    throw new CsvError(
      `The Amazon dataset is missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`,
    );
  }

  const cell = (row: string[], name: string): string =>
    name in index ? (row[index[name]!] ?? "").trim() : "";

  const parsed = rows.length - 1;
  const skipReasons: Partial<Record<AmazonSkipReason, number>> = {};
  const skip = (reason: AmazonSkipReason) => {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  };

  const canonical: string[][] = [[...CANONICAL_COLUMNS]];
  const records: AmazonRecord[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    // Positional id, taken from the source row number so it is stable across
    // runs and independent of how many earlier records were skipped.
    const reviewId = `amz-${String(r).padStart(4, "0")}`;

    const productId = cell(row, "product_id");
    const text_ = cell(row, "review_content");
    const rawRating = cell(row, "rating");
    const sourceRating = Number(rawRating);

    // Fixed order, so a given record always reports the same first reason.
    if (!productId) {
      skip("missing_product_id");
      continue;
    }
    if (!text_) {
      skip("missing_review_text");
      continue;
    }
    // Rejects "|", blanks, NaN and anything that cannot round into 1–5.
    const rating = Math.round(sourceRating);
    if (!Number.isFinite(sourceRating) || rating < 1 || rating > 5) {
      skip("invalid_rating");
      continue;
    }

    const rawCategory = cell(row, "category");
    const categoryPath = rawCategory.split("|").map((p) => p.trim()).filter(Boolean);
    const category = categoryPath[categoryPath.length - 1] ?? "";

    canonical.push([
      reviewId,
      productId,
      cell(row, "product_name"),
      category,
      String(rating),
      text_,
    ]);

    records.push({
      reviewId,
      productId,
      productName: cell(row, "product_name"),
      categoryPath,
      category,
      rating,
      sourceRating,
      discountedPrice: parseAmount(cell(row, "discounted_price")),
      actualPrice: parseAmount(cell(row, "actual_price")),
      discountPercent: parseAmount(cell(row, "discount_percentage")),
      ratingCount: parseAmount(cell(row, "rating_count")),
      raw: {
        discounted_price: cell(row, "discounted_price"),
        actual_price: cell(row, "actual_price"),
        discount_percentage: cell(row, "discount_percentage"),
        rating: rawRating,
        rating_count: cell(row, "rating_count"),
        category: rawCategory,
      },
    });
  }

  // One loader, one set of rules: the canonical rows go through the same
  // validation an uploaded CSV does, and its skips are folded in below.
  const { dataset, skipReasons: loaderReasons } = buildDataset(canonical, label, "amazon");

  for (const [reason, count] of Object.entries(loaderReasons)) {
    const key = reason as SkipReason;
    skipReasons[key] = (skipReasons[key] ?? 0) + (count ?? 0);
  }

  // Attach the preserved decimals to the reviews the loader built. Records are
  // keyed by the synthetic id, so this cannot drift if the loader skips a row.
  const bySourceRating = new Map(records.map((rec) => [rec.reviewId, rec.sourceRating] as const));
  for (const review of dataset.reviews) {
    const source = bySourceRating.get(review.id);
    if (source !== undefined) review.sourceRating = source;
  }

  const accepted = dataset.reviews.length;
  const skipped = parsed - accepted;
  const acceptedIds = new Set(dataset.reviews.map((r) => r.id));

  return {
    dataset,
    stats: { parsed, accepted, skipped, skipReasons },
    records: records.filter((rec) => acceptedIds.has(rec.reviewId)),
  };
}

/**
 * Parse a source amount into a number: strips ₹, thousands separators, % and
 * whitespace. Returns `undefined` for blank or unparseable cells — these fields
 * are informational, so a bad one never rejects a record. The raw string is
 * always kept alongside in `AmazonRecord.raw`.
 */
function parseAmount(raw: string): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[₹,%\s]/g, "");
  if (cleaned === "") return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}
