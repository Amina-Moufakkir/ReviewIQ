import type { Dataset, Product, Review } from "../types";
import { parseCsv, readColumns, type CsvColumns } from "./csv";
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
  return buildDataset(parseCsv(text), label, "uploaded");
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

  const columns = readColumns(rows[0]!);
  const missing = columns.missing(REQUIRED_COLUMNS);
  if (missing.length > 0) {
    throw new CsvError(`Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
  }

  const isDated = columns.has("review_date");
  const reviews: Review[] = [];
  const productMap = new Map<string, Product>();
  const seenIds = new Set<string>();
  const skipReasons: Partial<Record<SkipReason, number>> = {};
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const fields = readRow(rows[r]!, columns, isDated);

    const reason = rejectionFor(fields, isDated, seenIds);
    if (reason) {
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
      skipped++;
      continue;
    }
    seenIds.add(fields.id);

    reviews.push(toReview(fields, rows[r]!, columns));
    if (!productMap.has(fields.productId)) {
      productMap.set(fields.productId, {
        id: fields.productId,
        name: fields.productName || fields.productId,
        category: fields.category,
      });
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

/** The required columns of one row, read and normalized. */
interface RowFields {
  id: string;
  productId: string;
  date: string;
  rating: number;
  text: string;
  productName: string;
  category: string;
}

function readRow(row: string[], columns: CsvColumns, isDated: boolean): RowFields {
  return {
    id: columns.cell(row, "review_id"),
    productId: columns.cell(row, "product_id"),
    // Undated sources carry "" — never a stand-in date. See the note above.
    date: isDated ? columns.cell(row, "review_date") : "",
    rating: Number(columns.cell(row, "rating")),
    text: columns.cell(row, "review_text"),
    productName: columns.cell(row, "product_name"),
    category: columns.cell(row, "category") || "Uncategorized",
  };
}

/**
 * Why a row cannot become a review, or `null` if it can. The checks run in a
 * fixed order so one row always reports the same first reason.
 */
function rejectionFor(fields: RowFields, isDated: boolean, seenIds: Set<string>): SkipReason | null {
  if (!fields.id) return "missing_review_id";
  if (seenIds.has(fields.id)) return "duplicate_review_id";
  if (!fields.productId) return "missing_product_id";
  if (isDated && !isValidIsoDate(fields.date)) return "invalid_date";
  if (!Number.isInteger(fields.rating) || fields.rating < 1 || fields.rating > 5) {
    return "invalid_rating";
  }
  if (!fields.text) return "missing_review_text";
  return null;
}

/** Build a Review from an accepted row, reading optional columns if present. */
function toReview(fields: RowFields, row: string[], columns: CsvColumns): Review {
  const optional = (name: string) => (columns.has(name) ? columns.cell(row, name) || undefined : undefined);
  return {
    id: fields.id,
    productId: fields.productId,
    date: fields.date,
    rating: fields.rating,
    text: fields.text,
    category: fields.category,
    title: optional("review_title"),
    country: optional("country"),
    promotion: optional("promotion"),
    verifiedPurchase: columns.has("verified_purchase")
      ? columns.cell(row, "verified_purchase") === "true"
      : undefined,
    discountPercent: columns.has("discount_percent")
      ? parseDiscount(columns.cell(row, "discount_percent"))
      : undefined,
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
