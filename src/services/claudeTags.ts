/**
 * Shared, framework-agnostic types and validation for the Claude tagging layer.
 *
 * Imported by BOTH the server function (api/analyze.ts) and the client engine
 * (claudeEngine.ts) so the two validation gates use identical rules. It has no
 * dependency on the Anthropic SDK, React, or any runtime — it is pure data +
 * functions, so it is trivially testable and safe to bundle on the client.
 *
 * The model judges language; this code computes evidence. Every rule here is a
 * grounding check — nothing trusts a value the model wrote in prose.
 */

/** Per-mention sentiment the model may assign. Neutral yields no finding. */
export const SENTIMENTS = ["praise", "fault", "neutral"] as const;
export type TagSentiment = (typeof SENTIMENTS)[number];

/** The exact wire shape the model must return, and the endpoint returns. */
export interface RawTag {
  review_id: string;
  theme: string;
  sentiment: TagSentiment;
  evidence_span: string;
}

/** A tag that passed validation, plus a normalized key for dedup/grouping. */
export interface ValidatedTag {
  reviewId: string;
  /** Original (trimmed) label, for display. */
  theme: string;
  /** Normalized label — casing/whitespace only — for dedup and grouping. */
  themeKey: string;
  sentiment: TagSentiment;
  evidence: string;
}

export interface ValidationOutcome {
  valid: ValidatedTag[];
  /** Entries dropped as invalid (bad shape / unknown id / bad evidence). */
  rejected: number;
  /** Entries dropped as duplicates of an already-kept normalized triple. */
  deduped: number;
}

// --- Request limits (server-enforced; named so they can be tuned later) ------

/**
 * Max reviews the ENDPOINT accepts in one request. Over this → 413.
 *
 * This is a **safety limit**, not a statement of capability. It bounds the blast
 * radius of a single request — cost, time, payload — and holds even if a client
 * is buggy, stale, or hostile. It is deliberately far above what the engine can
 * actually complete synchronously; see `SYNC_OUTPUT_TOKEN_BUDGET` for that. The
 * two must never be conflated: one says what a request may carry, the other
 * says what the engine can finish.
 */
export const MAX_REVIEWS_PER_REQUEST = 100;
/** Max serialized request-body size (bytes). Over this → 413. */
export const MAX_REQUEST_BODY_BYTES = 250 * 1024;
/** Max total review text after parsing (bytes). Over this → 413. */
export const MAX_TOTAL_REVIEW_TEXT_BYTES = 200 * 1024;

// --- Synchronous operating capability (client-side) --------------------------
//
// What the engine can actually FINISH in one request, which is far less than
// what the endpoint will accept. The 30s provider timeout admits roughly
// 3,300 output tokens at the measured ~110 tok/s; the budget below leaves
// headroom against that.
//
// Output volume is what times out, and it scales with how much each row has to
// say — not with row count alone and not with byte size alone. Measured on
// 2026-08-02 (bench/DECISION.md): ~405 output tokens/row on dense Amazon
// listings at ~970 B/row, and ~136 output tokens/row on light synthetic rows at
// ~113 B/row. Fitting those two points gives the estimator below.
//
// It is a TWO-POINT FIT, and honest only as an interim guard. It is replaced by
// rolling measured density once batching lands
// (docs/adr/0001-category-scale-claude-analysis.md).

/** Output-token budget for one synchronous request (~20s at ~110 tok/s). */
export const SYNC_OUTPUT_TOKEN_BUDGET = 2200;
/** Fixed output cost per row: the tag scaffolding a row incurs regardless of length. */
export const SYNC_TOKENS_PER_ROW = 100;
/** Marginal output cost per byte of review text. */
export const SYNC_TOKENS_PER_TEXT_BYTE = 0.31;

/**
 * Estimated output tokens for a selection. Validated against every measurement
 * taken: it correctly predicts the 5-row dense pass, the 10- and 20-row dense
 * timeouts, and the 25-row synthetic timeout — whose ~3,400 streamed tokens it
 * estimates at 3,372.
 */
export function estimateOutputTokens(rowCount: number, textBytes: number): number {
  return Math.round(rowCount * SYNC_TOKENS_PER_ROW + textBytes * SYNC_TOKENS_PER_TEXT_BYTE);
}

/** Whether a selection is small enough to finish in one synchronous request. */
export function fitsSyncBudget(rowCount: number, textBytes: number): boolean {
  return estimateOutputTokens(rowCount, textBytes) <= SYNC_OUTPUT_TOKEN_BUDGET;
}

/** A review as accepted by the /api/analyze endpoint. */
export interface IncomingReview {
  id: string;
  text: string;
}

/**
 * Validate and narrow an inbound request body to its review list. The endpoint
 * validates its own assumptions — it does NOT trust that a caller ran the
 * browser CSV parser. Returns the reviews, or `{ invalid: <reason> }` describing
 * the first contract violation (the reason is about request shape only — it
 * carries nothing sensitive).
 *
 * Enforced per review: `id` a non-blank string and unique across the batch, and
 * `text` a non-blank string. Any other property — including a `rating` from an
 * older cached client — is dropped rather than rejected: this path analyzes text
 * only, so a stray rating has nothing left to influence.
 */
export function parseReviewRequest(body: unknown): IncomingReview[] | { invalid: string } {
  if (typeof body !== "object" || body === null) return { invalid: "body must be a JSON object" };
  const raw = (body as { reviews?: unknown }).reviews;
  if (!Array.isArray(raw) || raw.length === 0) return { invalid: "reviews must be a non-empty array" };

  const reviews: IncomingReview[] = [];
  const seenIds = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { invalid: "each review must be an object" };
    const r = item as Record<string, unknown>;

    if (typeof r.id !== "string" || r.id.trim() === "") return { invalid: "each review needs a non-blank string id" };
    if (seenIds.has(r.id)) return { invalid: `duplicate review id: ${r.id}` };
    seenIds.add(r.id);

    if (typeof r.text !== "string" || r.text.trim() === "") return { invalid: "each review needs non-blank text" };

    reviews.push({ id: r.id, text: r.text });
  }
  return reviews;
}

/**
 * Normalize a theme label for **casing and surrounding/internal whitespace
 * only**. No semantic clustering happens in code — Claude is responsible for
 * assigning the same canonical label to equivalent mentions across the batch.
 */
export function normalizeTheme(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function isSentiment(value: unknown): value is TagSentiment {
  return typeof value === "string" && (SENTIMENTS as readonly string[]).includes(value);
}

/**
 * Parse a raw JSON string into an array of unknown entries. Throws if the JSON
 * is syntactically invalid or is not a top-level array — callers treat a throw
 * as "the entire response is unusable".
 */
export function parseTagArray(raw: string): unknown[] {
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("Expected a top-level JSON array.");
  return data;
}

/**
 * Strip a single surrounding Markdown code fence if present, then trim. The
 * model is instructed to emit raw JSON; this only tolerates an accidental
 * ```json … ``` wrapper. It does not otherwise alter or "repair" the content —
 * anything still non-JSON afterwards is treated as unusable by the caller.
 */
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fence ? fence[1]! : trimmed).trim();
}

/**
 * Validate a list of unknown entries against the reviews they claim to tag.
 * Applies, in order: shape check, unknown-id rejection, sentiment/theme checks,
 * exact evidence-span grounding against the SPECIFIC referenced review, and
 * dedup by normalized {review_id, theme, sentiment}. Invalid entries are
 * discarded and counted; valid ones are retained.
 */
export function validateTags(
  entries: unknown[],
  reviewsById: Map<string, string>,
): ValidationOutcome {
  const valid: ValidatedTag[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  let deduped = 0;

  for (const entry of entries) {
    const tag = coerceTag(entry, reviewsById);
    if (!tag) {
      rejected++;
      continue;
    }
    const key = `${tag.reviewId}\u0000${tag.themeKey}\u0000${tag.sentiment}`;
    if (seen.has(key)) {
      // A review may mention the same theme repeatedly; it contributes at most
      // once to the count for that theme-sentiment pair.
      deduped++;
      continue;
    }
    seen.add(key);
    valid.push(tag);
  }

  return { valid, rejected, deduped };
}

function coerceTag(entry: unknown, reviewsById: Map<string, string>): ValidatedTag | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;

  const reviewId = e.review_id;
  const theme = e.theme;
  const sentiment = e.sentiment;
  const evidence = e.evidence_span;

  if (typeof reviewId !== "string" || reviewId === "") return null;
  if (typeof theme !== "string" || theme.trim() === "") return null;
  if (!isSentiment(sentiment)) return null;
  if (typeof evidence !== "string" || evidence === "") return null;

  const reviewText = reviewsById.get(reviewId);
  if (reviewText === undefined) return null; // unknown review id
  // Evidence must be an exact substring of THAT review — matching a different
  // review is not sufficient.
  if (!reviewText.includes(evidence)) return null;

  return {
    reviewId,
    theme: theme.trim(),
    themeKey: normalizeTheme(theme),
    sentiment,
    evidence,
  };
}

/**
 * Turn a raw model response string into validated tags: tolerate an accidental
 * code fence, parse strictly (throws on invalid JSON / non-array), then
 * validate each entry. Used server-side so only a validated payload — never raw
 * provider output — leaves the function.
 */
export function validateModelResponse(
  rawText: string,
  reviewsById: Map<string, string>,
): ValidationOutcome {
  const entries = parseTagArray(stripCodeFence(rawText));
  return validateTags(entries, reviewsById);
}

/** Serialize a validated tag back to the wire shape returned by the endpoint. */
export function toRawTag(tag: ValidatedTag): RawTag {
  return {
    review_id: tag.reviewId,
    theme: tag.theme,
    sentiment: tag.sentiment,
    evidence_span: tag.evidence,
  };
}
