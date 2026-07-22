import type { AnalysisInput, AnalysisResult } from "../types";
import { reviews as allReviews } from "../data/reviews";
import { analyze, AnalysisError } from "./analysisEngine";

// Re-export so the UI keeps a single import surface for the analysis boundary.
export { AnalysisError };

/**
 * The single boundary between the UI and the analysis engine.
 *
 * The analysis itself is synchronous, pure, and deterministic (see
 * analysisEngine.ts). This wrapper adds a simulated latency so the loading
 * state is exercised and mirrors a future network call to a real model —
 * swapping in that model means changing only this function.
 */
export async function analyzeReviews(input: AnalysisInput): Promise<AnalysisResult> {
  await delay(900);
  return analyze(input, allReviews);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
