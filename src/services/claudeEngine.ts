import type { AnalysisInput, AnalysisResult, Dataset } from "../types";
import { AnalysisError, selectForScope } from "./analysisEngine";
import type { IncomingReview } from "./claudeTags";
import { tagsToResult, zeroResult } from "./tagsToResult";
import { runClaudePipeline } from "./claudePipeline";
import { createAnalyzeDispatch, createCanonicalizeDispatch } from "./claudeDispatch";
import { ceilingRefusalMessage, estimateRun } from "./runEstimator";
import { RUN_ENVIRONMENT } from "../config";
import { unitFor, pluralize } from "../lib/datasetInfo";

/**
 * Client-side Claude engine, running the batched pipeline.
 *
 * It filters reviews, then hands them to the pipeline, which tags them in
 * bounded batches against `/api/analyze`, reconciles the resulting theme labels
 * against `/api/canonicalize`, and returns canonicalized tags. Only then are
 * counts, percentages, ordering, quotes, the summary, and the recommendations
 * computed — all in TypeScript, from the tags, never from a number the model
 * wrote.
 *
 * It never calls the Anthropic API directly (no key in the browser) and never
 * falls back to the heuristic engine. Any failure throws `AnalysisError`, which
 * the existing error path (useAnalysis) surfaces to the user.
 *
 * There is no partial success. This returns only when batch execution,
 * canonicalization, AND aggregation have all completed; a failure in any of
 * them produces no result at all, rather than a report that looks finished
 * while resting on rows that were never analyzed or themes that were never
 * reconciled.
 */
export async function analyzeWithClaude(
  input: AnalysisInput,
  dataset: Dataset,
  signal?: AbortSignal,
): Promise<AnalysisResult> {
  // Same resolver the heuristic engine uses, so both engines always read the
  // identical row set for a given query — the premise the comparison rests on.
  const { subject: product, rows: matched } = selectForScope(
    input,
    dataset.reviews,
    dataset.products,
  );
  const unit = unitFor(dataset);
  // No reviews in the window: the legitimate empty state, not a fallback, and it
  // must cost nothing.
  //
  // No mutation test kills this line, and that is expected: the pipeline has its
  // own zero-row guard and `tagsToResult` returns `zeroResult` for an empty
  // selection, so removing this produces the identical value by a longer route.
  // It stays because it states the intent where the decision belongs, and keeps
  // the guarantee from resting on two downstream layers continuing to special-
  // case zero — neither of which is obliged to.
  if (matched.length === 0) return zeroResult(product, input, unit);

  // Text only: sentiment on this path is derived from the review body, so the
  // rating is not sent. See "Which engine for which data" in README.md.
  const rows: IncomingReview[] = matched.map((r) => ({ id: r.id, text: r.text }));

  // The one client-side limit, and it is about the whole analysis rather than
  // any single request: how large a selection this deployment permits at all.
  //
  // Batching removed the old ceiling, which asked whether a selection could be
  // finished in ONE request and refused a 25-row category over a 30-second
  // wall. That question no longer decides anything — the pipeline splits the
  // selection — so what remains is the question an analyst can actually act on.
  const estimate = estimateRun(rows, RUN_ENVIRONMENT);
  if (estimate.exceedsCeiling) {
    throw new AnalysisError(
      ceilingRefusalMessage(estimate, pluralize(matched.length, unit), remediesFor(input)),
    );
  }

  const result = await runClaudePipeline(rows, {
    analyze: createAnalyzeDispatch(fetch),
    canonicalize: createCanonicalizeDispatch(fetch),
    signal,
  });

  // Deterministic from here on. `result.tags` are CanonicalTag[], which is the
  // only shape this accepts — raw per-batch tags are a compile error, because
  // aggregating them would under-count every theme two batches named
  // differently. See canonicalTag.ts.
  return tagsToResult(input, product, matched, result.tags, unit);
}

/**
 * Narrowings that actually exist for this query.
 *
 * Advice has to be followable. Undated data has no window to narrow, so offering
 * that would send the analyst after a control that is not on screen; and "pick
 * one product" means nothing when a single product is already the scope.
 */
function remediesFor(input: AnalysisInput): string[] {
  const remedies: string[] = [];
  if (input.scope.kind === "category") remedies.push("analyze a single product instead");
  if (input.from && input.to) remedies.push("narrow the date range");
  return remedies;
}
