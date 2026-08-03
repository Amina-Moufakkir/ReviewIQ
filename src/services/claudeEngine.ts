import type { AnalysisInput, AnalysisResult, Dataset } from "../types";
import { AnalysisError, selectForScope } from "./analysisEngine";
import {
  validateTags,
  estimateOutputTokens,
  withinEstimatedSyncBudget,
  MAX_ROWS_PER_BATCH_REQUEST,
  SYNC_OUTPUT_TOKEN_BUDGET,
} from "./claudeTags";
import { tagsToResult, zeroResult } from "./tagsToResult";
import { composeCanonicalTags, distinctThemeLabels } from "./canonicalTag";
import { formatCount, unitFor, type DatasetUnit } from "../lib/datasetInfo";

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

  // Refused here, before the request is built, against what the engine can
  // actually FINISH — not against the endpoint's 100-row safety limit.
  //
  // Those are different numbers and conflating them was a real defect: the
  // endpoint accepts 100 rows, but one synchronous request completes roughly
  // 5 dense rows before hitting the 30s wall. A selection of 30 sailed past the
  // old check, then timed out — the app promising twenty times what it could
  // deliver, and the analyst paying for the discovery in a 30-second wait.
  //
  // The estimate is deliberately conservative and is a stopgap. Batching removes
  // this ceiling; see docs/adr/0001-category-scale-claude-analysis.md.
  //
  // Two conditions, because the endpoint now takes one BATCH rather than a
  // whole selection. The budget alone is not sufficient: on light rows it
  // admits ~16, while the server accepts 12, which would send a request
  // guaranteed to be refused. Until the executor lands and splits selections
  // into batches, this path must send only what one batch may carry.
  const textBytes = matched.reduce((sum, r) => sum + byteLength(r.text), 0);
  const fitsOneRequest =
    matched.length <= MAX_ROWS_PER_BATCH_REQUEST &&
    withinEstimatedSyncBudget(matched.length, textBytes);
  if (!fitsOneRequest) {
    throw new AnalysisError(
      overLimitMessage(product.name, matched.length, textBytes, unit, input),
    );
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

  // An identity mapping, and correct here rather than a stopgap: this path sends
  // the whole selection as ONE request, so every tag came from a single labeling
  // pass and the model already used one label per concept across it. There is no
  // cross-batch fragmentation to reconcile, because there are no other batches.
  //
  // It is built inline instead of behind a shared "identity mapping" helper on
  // purpose. Such a helper is exactly the shape a fragmented-label fallback
  // would take, and canonicalization failure must stay terminal.
  const identity = new Map(distinctThemeLabels(valid).map((label) => [label, label] as const));

  return tagsToResult(input, product, matched, composeCanonicalTags(valid, identity), unitFor(dataset));
}

/**
 * Map a non-2xx endpoint status to a controlled, non-leaky user message.
 *
 * The endpoint's own `{ error: { message } }` is preferred, because it knows
 * more than the status code does. The fallbacks below matter for the cases
 * where there is no such body to read: `401`/`403` come from Vercel's
 * deployment protection at the edge, before the function runs at all, so the
 * response is the platform's sign-in page rather than our JSON.
 */
async function messageForStatus(response: Response): Promise<string> {
  // Prefer the endpoint's controlled { error: { message } }, if present.
  try {
    const data = (await response.json()) as { error?: { message?: unknown } };
    const message = data?.error?.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // fall through to a generic message
  }
  // Blocked at the edge, not by the function: this deployment is access
  // controlled and the browser is not signed in (or the session lapsed).
  if (response.status === 401 || response.status === 403) {
    return "This deployment requires sign-in. Sign in to the protected demo and try again.";
  }
  if (response.status === 503) return "AI analysis is temporarily unavailable.";
  if (response.status === 429) {
    return "The analysis service is busy right now. Please try again in a moment.";
  }
  // Deliberately says nothing about a date range: undated data has no window
  // to narrow, and this fires only when the endpoint's own message was
  // unreadable, so it cannot know what the caller selected.
  if (response.status === 413) {
    return "That selection is too large for the Claude engine. Analyze a smaller selection, or use the heuristic engine, which has no limit.";
  }
  if (response.status === 504) {
    return "The analysis timed out. Analyze a smaller selection and try again.";
  }
  return "The analysis service is unavailable right now. Please try again.";
}

/** UTF-8 byte length, the same measure the endpoint's own text budget uses. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Why a selection was refused, and what to do about it.
 *
 * States the limit as what it is — how much this engine can finish in one
 * request — rather than quoting a fixed row cap it cannot honour. A fixed
 * number would be wrong in both directions: 30 light rows may be fine while 10
 * dense ones are not, because what times out is how much the model has to write.
 *
 * The remedies offered are only the ones that actually exist for this query:
 * narrowing a window is useless advice on undated data, and "pick one product"
 * means nothing under product scope.
 */
function overLimitMessage(
  subject: string,
  count: number,
  textBytes: number,
  unit: DatasetUnit,
  input: AnalysisInput,
): string {
  const remedies: string[] = [];
  if (input.scope.kind === "category") remedies.push("analyze a single product instead");
  if (input.from && input.to) remedies.push("narrow the date range");
  remedies.push("or switch to the heuristic engine, which has no limit");

  const over = Math.round(estimateOutputTokens(count, textBytes) / SYNC_OUTPUT_TOKEN_BUDGET);

  return (
    `${subject} has ${formatCount(count, unit)} — roughly ${over}x more than the Claude ` +
    `engine can analyze in one pass. It reads every ${unit.one} and writes up a theme for ` +
    `each, and one request has to finish inside 30 seconds. You can ${remedies.join(", ")}.`
  );
}
