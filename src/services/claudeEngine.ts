import type { AnalysisInput, AnalysisResult, Dataset } from "../types";
import { AnalysisError } from "./analysisEngine";
import { tagsToResult, zeroResult } from "./tagsToResult";
import { runClaudePipeline } from "./claudePipeline";
import { createAnalyzeDispatch, createCanonicalizeDispatch } from "./claudeDispatch";
import { planClaudeRun } from "./claudeRunPlan";
import type { ProgressReporter } from "./analysisProgress";

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
export interface ClaudeRunOptions {
  signal?: AbortSignal;
  onProgress?: ProgressReporter;
  /**
   * Set when the analyst has already approved this run's estimated cost.
   *
   * It suppresses nothing else. A selection over the ceiling, or one whose
   * themes are projected unreconcilable, is still refused — those are not
   * questions the analyst is being asked, and consent to a price is not consent
   * to a run that cannot finish.
   */
  confirmed?: boolean;
}

export async function analyzeWithClaude(
  input: AnalysisInput,
  dataset: Dataset,
  options: ClaudeRunOptions = {},
): Promise<AnalysisResult> {
  // One planner, shared with the confirmation dialog, so the two can never
  // disagree about whether this run is allowed or what to say if it is not.
  const outcome = planClaudeRun(input, dataset);
  const { subject, matched, rows, unit } = outcome.plan;

  // No reviews in the window: the legitimate empty state, not a fallback, and
  // it must cost nothing.
  if (outcome.decision === "empty") return zeroResult(subject, input, unit);

  if (outcome.decision === "refuse") throw new AnalysisError(outcome.message);

  // Refused here too, not only in the UI. The dialog is a courtesy; this is the
  // guarantee. A caller that skips the dialog does not get to skip the price.
  if (outcome.decision === "confirm" && !options.confirmed) {
    throw new AnalysisError(
      "This analysis needs to be confirmed before it can start. Run it again and confirm the estimate.",
    );
  }

  const result = await runClaudePipeline(rows, {
    analyze: createAnalyzeDispatch(fetch),
    canonicalize: createCanonicalizeDispatch(fetch),
    signal: options.signal,
    onProgress: options.onProgress,
  });

  // Deterministic from here on. `result.tags` are CanonicalTag[], which is the
  // only shape this accepts — raw per-batch tags are a compile error, because
  // aggregating them would under-count every theme two batches named
  // differently. See canonicalTag.ts.
  return tagsToResult(input, subject, matched, result.tags, unit);
}
