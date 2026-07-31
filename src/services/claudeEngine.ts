import type { AnalysisInput, AnalysisResult, Dataset } from "../types";
import { AnalysisError, selectForScope } from "./analysisEngine";
import { validateTags, MAX_REVIEWS_PER_REQUEST } from "./claudeTags";
import { tagsToResult, zeroResult } from "./tagsToResult";
import { formatCount, pluralize, unitFor, type DatasetUnit } from "../lib/datasetInfo";

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
  // Same resolver the heuristic engine uses, so both engines always read the
  // identical row set for a given query — the premise the comparison rests on.
  const { subject: product, rows: matched } = selectForScope(
    input,
    dataset.reviews,
    dataset.products,
  );
  const unit = unitFor(dataset);
  // No reviews in the window: return the empty result without a network call —
  // this is the legitimate empty state, not a fallback.
  if (matched.length === 0) return zeroResult(product, input, unit);

  // Over-limit is refused here, before the request is built, rather than left
  // to the server's 413. Two reasons: the round trip is pointless, and the
  // server can only say "at most 100 reviews can be analyzed at once", which
  // names no way forward. The client knows the subject, the count, the noun and
  // whether a date window even exists, so it can say what to do instead.
  //
  // This is a real limit on category scope, not a corner case: three of the
  // nine top-level categories in the Amazon dataset hold 447-526 records each.
  if (matched.length > MAX_REVIEWS_PER_REQUEST) {
    throw new AnalysisError(overLimitMessage(product.name, matched.length, unit, input));
  }

  // Text only: sentiment on this path is derived from the review body, so the
  // rating is not sent. See "Which engine for which data" in README.md.
  // No subject id: the endpoint reads `reviews` and nothing else, and a
  // `productId` field would have to carry a category name under category scope.
  const body = JSON.stringify({
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
  // Deliberately says nothing about a date range: undated data has no window
  // to narrow, and this fires only when the endpoint's own message was
  // unreadable, so it cannot know what the caller selected.
  if (response.status === 413) {
    return "That selection is too large for the Claude engine. Analyze a smaller selection, or use the heuristic engine, which has no limit.";
  }
  if (response.status === 504) return "The analysis timed out. Try a narrower date range.";
  return "The analysis service is unavailable right now. Please try again.";
}

/**
 * Why a selection was refused, and what to do about it.
 *
 * Names the subject, the real count in the dataset's own noun, and the cap — an
 * analyst who is told "at most 100" without being told they asked for 526
 * cannot tell whether they were close. The remedies offered are only the ones
 * that actually exist for this query: narrowing a window is useless advice on
 * undated data, and "pick one product" means nothing under product scope.
 */
function overLimitMessage(
  subject: string,
  count: number,
  unit: DatasetUnit,
  input: AnalysisInput,
): string {
  const remedies: string[] = [];
  if (input.scope.kind === "category") remedies.push("analyze a single product instead");
  if (input.from && input.to) remedies.push("narrow the date range");
  remedies.push("or switch to the heuristic engine, which has no limit");

  return (
    `${subject} has ${formatCount(count, unit)}. The Claude engine analyzes at most ` +
    `${MAX_REVIEWS_PER_REQUEST} ${pluralize(MAX_REVIEWS_PER_REQUEST, unit)} at once. ` +
    `You can ${remedies.join(", ")}.`
  );
}
