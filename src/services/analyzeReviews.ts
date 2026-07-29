import type { AnalysisInput, AnalysisResult, Dataset } from "../types";
import { analyze, AnalysisError } from "./analysisEngine";
import { analyzeWithClaude } from "./claudeEngine";
import { ANALYSIS_ENGINE } from "../config";
import { unitFor } from "../lib/datasetInfo";

// Re-export so the UI keeps a single import surface for the analysis boundary.
export { AnalysisError };

/**
 * The single boundary between the UI and the analysis engine.
 *
 * The engine is selected by build-time config (ANALYSIS_ENGINE), not by any UI
 * control, so the call sites and the AnalysisResult contract are unchanged:
 *   - "heuristic" (default): the pure, deterministic engine (analysisEngine.ts),
 *     wrapped in a small simulated latency so the loading state is exercised.
 *   - "claude": the Claude-powered engine, which calls the /api/analyze server
 *     function. A Claude failure throws AnalysisError (surfaced by the existing
 *     error path) — it never silently falls back to the heuristic engine.
 */
export async function analyzeReviews(input: AnalysisInput, dataset: Dataset): Promise<AnalysisResult> {
  if (ANALYSIS_ENGINE === "claude") {
    return analyzeWithClaude(input, dataset);
  }
  await delay(700);
  // The dataset knows what one row is; the engine only needs the label.
  return analyze(input, dataset.reviews, dataset.products, unitFor(dataset));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
