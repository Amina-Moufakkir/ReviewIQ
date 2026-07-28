import type { AnalysisInput, AnalysisResult, Dataset } from "../types";
import { AnalysisError, filterReviews } from "./analysisEngine";
import { validateTags } from "./claudeTags";
import { tagsToResult, zeroResult } from "./tagsToResult";

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
  if (matched.length === 0) return zeroResult(product, input);

  const body = JSON.stringify({
    productId: input.productId,
    reviews: matched.map((r) => ({ id: r.id, text: r.text, rating: r.rating })),
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

  // Second gate: re-validate every entry against the reviews we sent. Anything
  // malformed is discarded here, so provider output never reaches the UI raw.
  const reviewsById = new Map(matched.map((r) => [r.id, r.text] as const));
  const { valid } = validateTags(rawTags, reviewsById);

  return tagsToResult(input, product, matched, valid);
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
