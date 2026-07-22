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

/** A recurring topic surfaced across reviews, with how many reviews mention it. */
export interface Theme {
  label: string;
  mentions: number;
}

/** The inputs an analyst chooses before running an analysis. */
export interface AnalysisInput {
  productId: string;
  /** Inclusive ISO start date. */
  from: string;
  /** Inclusive ISO end date. */
  to: string;
}

/** Structured output of an analysis run — the five MVP result sections. */
export interface AnalysisResult {
  productName: string;
  from: string;
  to: string;
  reviewCount: number;
  averageRating: number;
  summary: string;
  loves: string[];
  dislikes: string[];
  themes: Theme[];
  recommendations: string[];
}
