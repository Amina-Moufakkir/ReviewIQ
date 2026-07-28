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
  text: string;
  /** Optional review title (present in uploaded CSV data). */
  title?: string;
  /** Optional named author (built-in sample). Uploaded data is anonymous. */
  author?: string;
  category?: string;
  verifiedPurchase?: boolean;
  /** Short country code, e.g. "US". */
  country?: string;
  /**
   * Promotion or discount label the purchase was made under, e.g. "Spring Sale".
   * Present only when the dataset carries promotion information. A non-empty
   * value (or a positive `discountPercent`) marks the review as a promoted
   * purchase.
   */
  promotion?: string;
  /** Discount applied to the purchase, 0–100. Optional, like `promotion`. */
  discountPercent?: number;
}

/** A set of products and their reviews, from the built-in sample or an upload. */
export interface Dataset {
  products: Product[];
  reviews: Review[];
  source: "sample" | "uploaded";
  /** Human label for the active source, e.g. "Built-in sample" or a filename. */
  label: string;
}

export type Sentiment = "positive" | "negative";

/**
 * A theme found in the matched reviews, backed by evidence. Every field is
 * derived from reviews inside the selected product and date range.
 */
export interface Finding {
  label: string;
  sentiment: Sentiment;
  /** How many matched reviews support this finding (same-polarity mentions). */
  mentions: number;
  /** Share of matched reviews supporting it, 0–100 (integer). */
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

/**
 * How discounts/promotions relate to feedback in the matched reviews. Derived
 * only from reviews that carry promotion data; absent when the dataset has no
 * promotion information (or no promoted purchases in the window), so the UI can
 * degrade gracefully.
 */
export interface PromotionInsight {
  /** Matched reviews whose purchase was under a promotion or discount. */
  promoCount: number;
  /** Matched reviews at full price (no promotion). */
  fullPriceCount: number;
  /** Average rating of promoted-purchase reviews, 1dp (0 when none). */
  promoAverageRating: number;
  /** Average rating of full-price reviews, 1dp (0 when none). */
  fullPriceAverageRating: number;
  /** promoAverageRating − fullPriceAverageRating, 1dp. 0 when not comparable. */
  ratingDelta: number;
  /** Distinct promotion labels among promoted reviews, sorted. */
  promotions: string[];
  /** True when both groups have reviews, so the delta is a real comparison. */
  comparable: boolean;
  /** Short, human-readable relationship note derived from the numbers above. */
  note: string;
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
  /** Discount/promotion relationship, when the data supports it. */
  promotion?: PromotionInsight;
}

/** Sample-data context for a product, used to guide range selection. */
export interface ReviewStats {
  count: number;
  /** Earliest review date (ISO), or "" if none. */
  from: string;
  /** Latest review date (ISO), or "" if none. */
  to: string;
}
