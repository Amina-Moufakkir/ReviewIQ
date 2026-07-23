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
  "review_date",
  "rating",
  "review_text",
] as const;

// Optional columns are used when present but never required.

export interface ParseResult {
  dataset: Dataset;
  /** Rows that were dropped because they were invalid (bad date/rating/ids). */
  skipped: number;
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

  const reviews: Review[] = [];
  const productMap = new Map<string, Product>();
  const seenIds = new Set<string>();
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const id = cell(row, "review_id");
    const productId = cell(row, "product_id");
    const date = cell(row, "review_date");
    const ratingRaw = cell(row, "rating");
    const textVal = cell(row, "review_text");
    const rating = Number(ratingRaw);

    const valid =
      id &&
      !seenIds.has(id) &&
      productId &&
      isValidIsoDate(date) &&
      Number.isInteger(rating) &&
      rating >= 1 &&
      rating <= 5 &&
      textVal;

    if (!valid) {
      skipped++;
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
    dataset: { products, reviews, source: "uploaded", label },
    skipped,
  };
}
