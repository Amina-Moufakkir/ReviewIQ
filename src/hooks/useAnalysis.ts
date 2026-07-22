import { useCallback, useState } from "react";
import type { AnalysisInput, AnalysisResult, Dataset } from "../types";
import { analyzeReviews, AnalysisError } from "../services/analyzeReviews";

/**
 * Discriminated state for the analyze flow. The UI renders exactly one of
 * these at a time, covering the required loading / empty / success / error
 * states. "empty" is a successful run that returned zero reviews.
 */
export type AnalysisState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: AnalysisResult }
  | { status: "empty"; result: AnalysisResult }
  | { status: "error"; message: string };

export function useAnalysis() {
  const [state, setState] = useState<AnalysisState>({ status: "idle" });

  const analyze = useCallback(async (input: AnalysisInput, dataset: Dataset) => {
    setState({ status: "loading" });
    try {
      const result = await analyzeReviews(input, dataset);
      setState(
        result.reviewCount === 0
          ? { status: "empty", result }
          : { status: "success", result },
      );
    } catch (err) {
      const message =
        err instanceof AnalysisError
          ? err.message
          : "Something went wrong while analyzing reviews. Please try again.";
      setState({ status: "error", message });
    }
  }, []);

  // Reset to idle — used when the active dataset changes.
  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, analyze, reset };
}
