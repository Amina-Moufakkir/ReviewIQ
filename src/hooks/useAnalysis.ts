import { useCallback, useState } from "react";
import type { AnalysisInput, AnalysisResult, AnalysisScope, Dataset } from "../types";
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

/** Whether two scopes name the same subject. */
function isSameScope(a: AnalysisScope, b: AnalysisScope): boolean {
  if (a.kind === "product") return b.kind === "product" && a.productId === b.productId;
  return b.kind === "category" && a.category === b.category;
}

/** Whether two queries would select the same reviews. */
export function isSameQuery(a: AnalysisInput, b: AnalysisInput): boolean {
  return isSameScope(a.scope, b.scope) && a.from === b.from && a.to === b.to;
}

/**
 * What the UI may show for `currentQuery`, given a state produced by
 * `analyzedQuery`.
 *
 * A result belongs to the query that produced it. The moment the analyst edits
 * the query, the visible state reverts to idle — so a report for product A can
 * never sit under a form that now reads product B. Nothing re-runs on its own;
 * the analyst clicks Run analysis again.
 *
 * `loading` is filtered the same way: an in-flight run for the old query is no
 * longer what the form is asking, so its spinner goes too, and its result is
 * discarded when it lands. Errors are query-bound as well ("Unknown product",
 * "narrow the date range"), so they clear alongside.
 */
export function stateForQuery(
  state: AnalysisState,
  analyzedQuery: AnalysisInput | null,
  currentQuery: AnalysisInput,
): AnalysisState {
  if (state.status === "idle") return state;
  if (analyzedQuery && isSameQuery(analyzedQuery, currentQuery)) return state;
  return { status: "idle" };
}

/**
 * Owns the analyze flow and ties its outcome to the query that produced it.
 * `currentQuery` is the analyst's live selection; anything the hook returns is
 * guaranteed to describe exactly that.
 */
export function useAnalysis(currentQuery: AnalysisInput) {
  const [state, setState] = useState<AnalysisState>({ status: "idle" });
  const [analyzedQuery, setAnalyzedQuery] = useState<AnalysisInput | null>(null);

  const analyze = useCallback(async (input: AnalysisInput, dataset: Dataset) => {
    setAnalyzedQuery(input);
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

  /**
   * Reset to idle — used when the active dataset changes. Still needed
   * alongside the query check: a new dataset can present an identical query
   * (same first product id, same empty window) whose old result no longer
   * describes the data underneath it.
   */
  const reset = useCallback(() => {
    setState({ status: "idle" });
    setAnalyzedQuery(null);
  }, []);

  return { state: stateForQuery(state, analyzedQuery, currentQuery), analyze, reset };
}
