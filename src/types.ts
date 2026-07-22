// Domain model for ReviewIQ. Kept intentionally small — every type here
// supports the single MVP feature: Analyze Product Reviews.

export interface Product {
  id: string;
  name: string;
  category: string;
}

export interface Review {
  id: string;
  productId: string;
  /** ISO date string, e.g. "2026-03-14". */
  date: string;
  /** 1–5 stars. */
  rating: number;
  author: string;
  text: string;
}

export type Sentiment = "positive" | "negative";

/**
 * A theme found in the matched reviews, backed by evidence. Every field is
 * derived from reviews inside the selected product and date range.
 */
export interface Finding {
  label: string;
  sentiment: Sentiment;
  /** How many matched reviews mention this theme. */
  mentions: number;
  /** Share of matched reviews mentioning it, 0–100 (integer). */
  percent: number;
  /** A representative sentence taken from an actual matched review. */
  quote: string;
  quoteAuthor: string;
}

/** The inputs an analyst chooses before running an analysis. */
export interface AnalysisInput {
  productId: string;
  /** Inclusive ISO start date. */
  from: string;
  /** Inclusive ISO end date. */
  to: string;
}

/** Structured output of an analysis run — all derived from matched reviews. */
export interface AnalysisResult {
  productName: string;
  from: string;
  to: string;
  reviewCount: number;
  averageRating: number;
  summary: string;
  praise: Finding[];
  faults: Finding[];
  recommendations: string[];
}

/** Sample-data context for a product, used to guide range selection. */
export interface ReviewStats {
  count: number;
  /** Earliest review date (ISO), or "" if none. */
  from: string;
  /** Latest review date (ISO), or "" if none. */
  to: string;
}
