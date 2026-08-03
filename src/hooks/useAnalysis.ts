import { useCallback, useRef, useState } from "react";
import type { AnalysisInput, AnalysisResult, AnalysisScope, Dataset } from "../types";
import { analyzeReviews, AnalysisError } from "../services/analyzeReviews";
import { isProgressAdvance, type AnalysisProgress } from "../services/analysisProgress";
import { planClaudeRun, type PlannedRun } from "../services/claudeRunPlan";
import { ANALYSIS_ENGINE } from "../config";

/**
 * Discriminated state for the analyze flow. The UI renders exactly one of these
 * at a time.
 *
 * The lifecycle is idle → confirming → running → success | empty | cancelled |
 * error. "running" rather than "loading" because what is happening is a
 * multi-stage analysis the analyst can watch and stop, not a passive fetch.
 * "empty" is a successful run that selected zero rows; "cancelled" is
 * deliberately NOT an error, because nothing went wrong.
 */
export type AnalysisState =
  | { status: "idle" }
  | { status: "confirming"; plan: PlannedRun }
  | { status: "running"; progress: AnalysisProgress | null }
  | { status: "success"; result: AnalysisResult }
  | { status: "empty"; result: AnalysisResult }
  | { status: "cancelled" }
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
 * `running` and `confirming` are filtered the same way: an in-flight run, or an
 * unanswered question, for the old query is no longer what the form is asking.
 * Errors are query-bound as well ("Unknown product", "narrow the date range"),
 * so they clear alongside.
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

  /**
   * Which run the UI currently belongs to.
   *
   * `stateForQuery` already discards results across a QUERY change, but it
   * cannot see a second run of the SAME query superseding the first — to it the
   * two look identical. Every callback captures the token it was born with and
   * is dropped once it no longer matches, so a slow first run cannot repaint
   * over a fast second one.
   */
  const runToken = useRef(0);
  const controller = useRef<AbortController | null>(null);
  /** The run WE aborted, so a cancellation can be told apart from a failure. */
  const cancelledToken = useRef<number | null>(null);
  /** Last accepted progress, for the monotonicity comparison. */
  const lastProgress = useRef<AnalysisProgress | null>(null);

  /** Retire whatever is in flight without starting anything. */
  const supersede = useCallback((input: AnalysisInput) => {
    controller.current?.abort();
    runToken.current++;
    lastProgress.current = null;
    setAnalyzedQuery(input);
  }, []);

  /** Begin a fresh run, superseding and aborting any run already going. */
  const beginRun = useCallback((input: AnalysisInput) => {
    controller.current?.abort();
    const token = ++runToken.current;
    controller.current = new AbortController();
    lastProgress.current = null;
    setAnalyzedQuery(input);
    return { token, signal: controller.current.signal };
  }, []);

  const execute = useCallback(
    async (
      input: AnalysisInput,
      dataset: Dataset,
      token: number,
      signal: AbortSignal,
      confirmed: boolean,
    ) => {
      setState({ status: "running", progress: null });
      try {
        const result = await analyzeReviews(input, dataset, {
          signal,
          confirmed,
          onProgress: (progress) => {
            if (token !== runToken.current) return; // a superseded run
            if (!isProgressAdvance(lastProgress.current, progress)) return;
            lastProgress.current = progress;
            setState({ status: "running", progress });
          },
        });
        if (token !== runToken.current) return;
        setState(
          result.reviewCount === 0 ? { status: "empty", result } : { status: "success", result },
        );
      } catch (err) {
        if (token !== runToken.current) return;
        // Cancelled is decided by what WE did, not by matching the error text.
        // An abort message arriving for a run nobody cancelled is still a
        // failure and should read like one.
        if (cancelledToken.current === token) {
          setState({ status: "cancelled" });
          return;
        }
        const message =
          err instanceof AnalysisError
            ? err.message
            : "Something went wrong while analyzing reviews. Please try again.";
        setState({ status: "error", message });
      }
    },
    [],
  );

  /**
   * Start an analysis, asking first when the estimate warrants it.
   *
   * The question comes from the SHARED planner, never from a second opinion
   * computed here — so the dialog can only offer runs the engine would accept,
   * and can only refuse in the engine's own words.
   */
  const analyze = useCallback(
    async (input: AnalysisInput, dataset: Dataset) => {
      if (ANALYSIS_ENGINE !== "claude") {
        const { token, signal } = beginRun(input);
        return execute(input, dataset, token, signal, false);
      }

      const outcome = planClaudeRun(input, dataset);
      if (outcome.decision === "refuse") {
        supersede(input);
        setState({ status: "error", message: outcome.message });
        return;
      }
      if (outcome.decision === "confirm") {
        // Nothing is dispatched. The run does not exist until it is approved.
        supersede(input);
        setState({ status: "confirming", plan: outcome.plan });
        return;
      }
      const { token, signal } = beginRun(input);
      return execute(input, dataset, token, signal, false);
    },
    [beginRun, execute, supersede],
  );

  /** Approve a pending estimate and start the run it describes. */
  const confirmRun = useCallback(
    async (input: AnalysisInput, dataset: Dataset) => {
      const { token, signal } = beginRun(input);
      return execute(input, dataset, token, signal, true);
    },
    [beginRun, execute],
  );

  /** Decline a pending estimate. Nothing was dispatched, so nothing is stopped. */
  const declineRun = useCallback(() => {
    setState({ status: "idle" });
    setAnalyzedQuery(null);
  }, []);

  /** Stop the run in flight. Produces no result, partial or otherwise. */
  const cancel = useCallback(() => {
    cancelledToken.current = runToken.current;
    controller.current?.abort();
    setState({ status: "cancelled" });
  }, []);

  /**
   * Reset to idle — used when the active dataset changes. Still needed
   * alongside the query check: a new dataset can present an identical query
   * (same first product id, same empty window) whose old result no longer
   * describes the data underneath it.
   */
  const reset = useCallback(() => {
    controller.current?.abort();
    runToken.current++;
    lastProgress.current = null;
    setState({ status: "idle" });
    setAnalyzedQuery(null);
  }, []);

  return {
    state: stateForQuery(state, analyzedQuery, currentQuery),
    analyze,
    confirmRun,
    declineRun,
    cancel,
    reset,
  };
}
