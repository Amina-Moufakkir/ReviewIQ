import type { AnalysisInput, AnalysisResult, Dataset } from "../types";
import { analyze, AnalysisError } from "./analysisEngine";

// Re-export so the UI keeps a single import surface for the analysis boundary.
export { AnalysisError };

/**
 * The single boundary between the UI and the analysis engine.
 *
 * The analysis itself is synchronous, pure, and deterministic (see
 * analysisEngine.ts). This wrapper adds a simulated latency so the loading
 * state is exercised and mirrors a future network call to a real model —
 * swapping in that model means changing only this function, not the UI.
 */
export async function analyzeReviews(input: AnalysisInput, dataset: Dataset): Promise<AnalysisResult> {
  await delay(700);
  return analyze(input, dataset.reviews, dataset.products);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
