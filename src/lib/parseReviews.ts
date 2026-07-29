import type { Dataset, Product, Review } from "../types";
import { parseCsv } from "./csv";
import { isValidIsoDate } from "./date";

/** Thrown when a CSV cannot be turned into a usable dataset. */
export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

const REQUIRED_COLUMNS = [
  "review_id",
  "product_id",
  "product_name",
  "category",
  "rating",
  "review_text",
] as const;

// Optional columns are used when present but never required.
//
// `review_date` is one of them, and it is the only optional column that changes
// how the dataset behaves rather than just what it carries:
//   - present  → every row must hold a valid calendar date, exactly as before.
//                Rows with a bad date are skipped.
//   - absent   → the source has no per-review date at all. Every review gets
//                `date: ""` and the dataset is UNDATED. It is all-or-nothing:
//                a dataset never mixes dated and undated reviews, so the empty
//                window ("" – "") the UI uses for undated data cannot silently
//                exclude anyone. See Review.date in types.ts.

/** Why a row was skipped. Keys are stable so callers can report per-reason counts. */
export type SkipReason =
  | "missing_review_id"
  | "duplicate_review_id"
  | "missing_product_id"
  | "invalid_date"
  | "invalid_rating"
  | "missing_review_text";

export interface ParseResult {
  dataset: Dataset;
  /** Rows that were dropped because they were invalid (bad date/rating/ids). */
  skipped: number;
  /** How many rows each reason accounted for. Sums to `skipped`. */
  skipReasons: Partial<Record<SkipReason, number>>;
}

/**
 * What a load did with the rows it read, for honest reporting in the UI.
 * The invariant `accepted + skipped === parsed` always holds: no row is
 * silently discarded, and every skip is attributed to a reason.
 */
export interface LoadStats {
  /** Data rows the CSV parser produced (header excluded). */
  parsed: number;
  accepted: number;
  skipped: number;
  skipReasons: Partial<Record<string, number>>;
}

/** Derive load stats from a ParseResult (`parsed` = accepted + skipped). */
export function loadStatsFor(result: ParseResult): LoadStats {
  const accepted = result.dataset.reviews.length;
  return {
    parsed: accepted + result.skipped,
    accepted,
    skipped: result.skipped,
    skipReasons: result.skipReasons,
  };
}

/**
 * Parse a raw CSV string into a Dataset. Throws CsvError with a user-facing
 * message when the file is unusable (missing columns, no valid rows).
 * Individual malformed rows are skipped and counted rather than aborting.
 */
export function parseReviewsCsv(text: string, label: string): ParseResult {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new CsvError("The file is empty.");
  }
  return buildDataset(rows, label, "uploaded");
}

/**
 * Turn already-parsed CSV rows (header first) into a Dataset.
 *
 * Shared by `parseReviewsCsv` and the Amazon adapter so there is exactly ONE
 * loader: one column contract, one row-validity rule, one skip counter. An
 * adapter maps a foreign schema into these canonical columns and calls this —
 * it never builds `Review` objects of its own.
 */
export function buildDataset(
  rows: string[][],
  label: string,
  source: Dataset["source"],
): ParseResult {
  if (rows.length === 0) {
    throw new CsvError("The file is empty.");
  }

  const header = rows[0]!.map((h) => h.trim());
  const index: Record<string, number> = {};
  header.forEach((h, i) => {
    index[h] = i;
  });

  const missing = REQUIRED_COLUMNS.filter((c) => !(c in index));
  if (missing.length > 0) {
    throw new CsvError(`Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
  }

  const cell = (row: string[], name: string): string => (row[index[name]!] ?? "").trim();
  const hasDateColumn = "review_date" in index;

  const reviews: Review[] = [];
  const productMap = new Map<string, Product>();
  const seenIds = new Set<string>();
  const skipReasons: Partial<Record<SkipReason, number>> = {};
  let skipped = 0;

  const skip = (reason: SkipReason) => {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    skipped++;
  };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const id = cell(row, "review_id");
    const productId = cell(row, "product_id");
    // Undated sources carry "" — never a stand-in date. See the note above.
    const date = hasDateColumn ? cell(row, "review_date") : "";
    const ratingRaw = cell(row, "rating");
    const textVal = cell(row, "review_text");
    const rating = Number(ratingRaw);

    // Checked in a fixed order so one row always yields the same first reason.
    if (!id) {
      skip("missing_review_id");
      continue;
    }
    if (seenIds.has(id)) {
      skip("duplicate_review_id");
      continue;
    }
    if (!productId) {
      skip("missing_product_id");
      continue;
    }
    if (hasDateColumn && !isValidIsoDate(date)) {
      skip("invalid_date");
      continue;
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      skip("invalid_rating");
      continue;
    }
    if (!textVal) {
      skip("missing_review_text");
      continue;
    }
    seenIds.add(id);

    const productName = cell(row, "product_name") || productId;
    const category = cell(row, "category") || "Uncategorized";
    reviews.push({
      id,
      productId,
      date,
      rating,
      text: textVal,
      title: "review_title" in index ? cell(row, "review_title") || undefined : undefined,
      category,
      verifiedPurchase: "verified_purchase" in index ? cell(row, "verified_purchase") === "true" : undefined,
      country: "country" in index ? cell(row, "country") || undefined : undefined,
      promotion: "promotion" in index ? cell(row, "promotion") || undefined : undefined,
      discountPercent: "discount_percent" in index ? parseDiscount(cell(row, "discount_percent")) : undefined,
    });

    if (!productMap.has(productId)) {
      productMap.set(productId, { id: productId, name: productName, category });
    }
  }

  if (reviews.length === 0) {
    throw new CsvError("No valid review rows were found. Check the date and rating columns.");
  }

  const products = [...productMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    dataset: { products, reviews, source, label },
    skipped,
    skipReasons,
  };
}

/**
 * Parse an optional discount cell into a 0–100 percentage. Blank or malformed
 * values yield `undefined` (the field is optional and never blocks a row).
 */
function parseDiscount(raw: string): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/%$/, ""));
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return n;
}
