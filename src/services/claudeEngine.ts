import type { AnalysisInput, AnalysisResult, Dataset } from "../types";
import { AnalysisError, filterReviews } from "./analysisEngine";
import { validateTags } from "./claudeTags";
import { tagsToResult, zeroResult } from "./tagsToResult";
import { unitFor } from "../lib/datasetInfo";

/**
 * Client-side Claude engine. It filters reviews, calls the same-origin server
 * function (which holds the API key and calls Claude), then defensively
 * validates the endpoint's response — the SECOND of two gates (the server is
 * the first) — before turning it into an `AnalysisResult`.
 *
 * It never calls the Anthropic API directly (no key in the browser) and never
 * falls back to the heuristic engine: any failure throws `AnalysisError`, which
 * the existing error path (useAnalysis) surfaces to the user.
 */
export async function analyzeWithClaude(
  input: AnalysisInput,
  dataset: Dataset,
): Promise<AnalysisResult> {
  const product = dataset.products.find((p) => p.id === input.productId);
  if (!product) throw new AnalysisError(`Unknown product: ${input.productId}`);
  if (input.from > input.to) {
    throw new AnalysisError("The start date must be on or before the end date.");
  }

  const matched = filterReviews(dataset.reviews, input.productId, input.from, input.to);
  // No reviews in the window: return the empty result without a network call —
  // this is the legitimate empty state, not a fallback.
  if (matched.length === 0) return zeroResult(product, input, unitFor(dataset));

  // Text only: sentiment on this path is derived from the review body, so the
  // rating is not sent. See "Which engine for which data" in README.md.
  const body = JSON.stringify({
    productId: input.productId,
    reviews: matched.map((r) => ({ id: r.id, text: r.text })),
  });

  let response: Response;
  try {
    response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch {
    // Network failure, DNS, aborted, offline, etc.
    throw new AnalysisError(
      "Could not reach the analysis service. Check your connection and try again.",
    );
  }

  if (!response.ok) {
    throw new AnalysisError(await messageForStatus(response));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AnalysisError("The analysis service returned an unreadable response.");
  }

  const rawTags = (payload as { tags?: unknown })?.tags;
  if (!Array.isArray(rawTags)) {
    throw new AnalysisError("The analysis service returned an unexpected response.");
  }

  // Second gate — STRICT response integrity. The server is our own trusted
  // boundary: it has already validated and deduplicated tags against these same
  // reviews, so every tag it returns must pass the client's identical checks.
  // If ANY tag is rejected or is a duplicate, that is not ordinary model noise
  // (the server already filtered that) — it signals a server/client version
  // mismatch, a programming defect, or a tampered response. Fail the whole
  // request rather than silently dropping entries and rendering a partial report.
  //
  // This is intentionally stricter than the server's own gate, which is lenient
  // toward the *untrusted* model: it keeps valid tags, discards bad ones, and
  // fails only when they are ALL rejected. An empty `tags` array (no entries)
  // is the legitimate "no themes" signal and is allowed to produce an empty
  // result under both gates.
  const reviewsById = new Map(matched.map((r) => [r.id, r.text] as const));
  const { valid, rejected, deduped } = validateTags(rawTags, reviewsById);
  if (rejected > 0 || deduped > 0) {
    throw new AnalysisError("The analysis service returned an invalid response. Please try again.");
  }

  return tagsToResult(input, product, matched, valid, unitFor(dataset));
}

/** Map a non-2xx endpoint status to a controlled, non-leaky user message. */
async function messageForStatus(response: Response): Promise<string> {
  // Prefer the endpoint's controlled { error: { message } }, if present.
  try {
    const data = (await response.json()) as { error?: { message?: unknown } };
    const message = data?.error?.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // fall through to a generic message
  }
  if (response.status === 413) return "That request is too large. Narrow the date range and try again.";
  if (response.status === 504) return "The analysis timed out. Try a narrower date range.";
  return "The analysis service is unavailable right now. Please try again.";
}
