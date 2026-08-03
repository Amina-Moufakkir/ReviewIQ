import { AnalysisError } from "./analysisEngine";
import type { IncomingReview } from "./claudeTags";
import {
  executeBatches,
  BatchExecutionError,
  DEFAULT_EXECUTOR_CONFIG,
  type Dispatch,
  type ExecutorConfig,
  type RunTelemetry,
} from "./batchExecutor";
import {
  canonicalizeLabels,
  CanonicalizationError,
  type CanonicalizeDispatch,
} from "./canonicalize";
import { composeCanonicalTags, distinctThemeLabels, type CanonicalTag } from "./canonicalTag";
import { CanonicalizeTransportError } from "./claudeDispatch";

/**
 * The two model-driven stages, run in order, producing tags fit for aggregation.
 *
 * Stage order is a correctness property, not an implementation detail. Labels
 * cannot be canonicalized before they exist, and tags cannot be aggregated
 * before they are canonicalized — so this awaits execution fully, then
 * canonicalizes, then composes. Nothing overlaps, and a failure at any point
 * leaves no result at all.
 *
 * It deliberately stops at `CanonicalTag[]`. No `AnalysisResult` is built here
 * and no engine path is switched; both land in the path-switch commit. What
 * this layer guarantees is that whatever reaches aggregation is complete and
 * canonical, or nothing reaches it.
 */

export interface PipelineResult {
  runId: string;
  rowCount: number;
  /** Canonicalized tags — the only shape final aggregation accepts. */
  tags: CanonicalTag[];
  /** Distinct raw labels submitted for grouping. */
  rawLabelCount: number;
  /** Distinct canonical labels the grouping produced. */
  canonicalLabels: string[];
  /** True when grouping was unnecessary, not when it was skipped after failing. */
  canonicalizationSkipped: boolean;
  execution: RunTelemetry;
}

export interface PipelineOptions {
  analyze: Dispatch;
  canonicalize: CanonicalizeDispatch;
  signal?: AbortSignal;
  executorConfig?: ExecutorConfig;
  makeRunId?: () => string;
}

const EMPTY_TELEMETRY: RunTelemetry = {
  batchCount: 0,
  retriesUsed: 0,
  retryBudget: 0,
  resizes: [],
  totalInputTokens: 0,
  totalOutputTokens: 0,
  wallClockMs: 0,
  maxConcurrentInFlight: 0,
};

export async function runClaudePipeline(
  rows: readonly IncomingReview[],
  options: PipelineOptions,
): Promise<PipelineResult> {
  // The legitimate empty state, and it must cost nothing: an empty window is an
  // answer, not a request. Neither endpoint is contacted.
  if (rows.length === 0) {
    return {
      runId: "",
      rowCount: 0,
      tags: [],
      rawLabelCount: 0,
      canonicalLabels: [],
      canonicalizationSkipped: true,
      execution: EMPTY_TELEMETRY,
    };
  }

  // --- stage 1: tag every row, in bounded batches ---------------------------
  //
  // All-or-nothing. `executeBatches` resolves only when every row was covered by
  // a validated batch, and throws otherwise — so there is no partial tag set to
  // accidentally carry forward.
  let execution;
  try {
    execution = await executeBatches(rows, {
      dispatch: options.analyze,
      signal: options.signal,
      config: options.executorConfig ?? DEFAULT_EXECUTOR_CONFIG,
      makeRunId: options.makeRunId,
    });
  } catch (err) {
    throw analysisErrorFor(err);
  }

  // --- stage 2: reconcile labels across batches -----------------------------
  const labels = distinctThemeLabels(execution.tags);

  // Nothing to reconcile: zero or one distinct label cannot be grouped with
  // anything else, and asking would spend a request to be told so. This is a
  // skipped request, NOT a skipped requirement — it is chosen before any
  // grouping is attempted, never reached by a grouping that failed.
  const skip = labels.length <= 1;

  let mapping: ReadonlyMap<string, string>;
  let canonicalLabels: string[];
  if (skip) {
    mapping = new Map(labels.map((label) => [label, label] as const));
    canonicalLabels = [...labels];
  } else {
    try {
      // The same signal cancels both stages: one cancellation stops the whole
      // run, not just whichever stage happens to be in flight.
      const canonicalization = await canonicalizeLabels(labels, options.canonicalize, {
        signal: options.signal,
      });
      mapping = canonicalization.map;
      canonicalLabels = canonicalization.canonicalLabels;
    } catch (err) {
      // Terminal, with no fallback to raw labels. Reporting on fragmented
      // labels would under-count every theme two batches named differently
      // while looking like a finished analysis — worse than a visible failure,
      // because the analyst cannot tell it happened.
      throw analysisErrorFor(err);
    }
  }

  // --- stage 3: compose, deterministically ----------------------------------
  //
  // No mutation test kills this catch, and that is expected rather than a gap.
  // `canonicalizeLabels` already guarantees what `composeCanonicalTags` checks:
  // the mapping is total over exactly these labels, and every canonical label
  // came from them. So with a correct canonicalizer the throw is unreachable,
  // and forcing it would need a test-only seam through two validated layers.
  //
  // It stays because the guarantee lives in another module. If a future change
  // breaks it, this fails as a controlled AnalysisError rather than surfacing a
  // raw CanonicalizationError to the UI — which is the whole difference between
  // a bad day and an unhandled one.
  let tags: CanonicalTag[];
  try {
    tags = composeCanonicalTags(execution.tags, mapping);
  } catch (err) {
    throw analysisErrorFor(err);
  }

  return {
    runId: execution.runId,
    rowCount: execution.rowCount,
    tags,
    rawLabelCount: labels.length,
    canonicalLabels,
    canonicalizationSkipped: skip,
    execution: execution.telemetry,
  };
}

// --- failure translation -----------------------------------------------------

/**
 * Turn any pipeline failure into a controlled `AnalysisError`.
 *
 * Two rules govern the copy. It never mentions batches, batch sizes, runs,
 * levels, or chunks: an analyst does not choose those, so naming them is advice
 * they cannot act on and an internal contract that changes whenever the planner
 * is retuned. And it never forwards a provider message, which can carry a URL or
 * a status nobody outside the service can use.
 *
 * What it does say is what the analyst can do next.
 */
function analysisErrorFor(err: unknown): AnalysisError {
  if (err instanceof BatchExecutionError) {
    if (err.reason === "aborted") return new AnalysisError(CANCELLED);
    // A response the client could not trust: wrong run id, unvalidated tags, or
    // rows that did not add up. All are defects rather than conditions the
    // analyst caused, so they read the same.
    if (err.reason === "protocol" || err.reason === "invalid_response" || err.reason === "coverage") {
      return new AnalysisError(INVALID);
    }
    if (err.reason === "over_byte_guard") return new AnalysisError(TOO_LARGE);
    return new AnalysisError(messageForCode(err.code));
  }

  if (err instanceof CanonicalizeTransportError) return new AnalysisError(messageForCode(err.code));

  if (err instanceof CanonicalizationError) {
    if (err.reason === "aborted") return new AnalysisError(CANCELLED);
    if (err.reason === "unsupported") return new AnalysisError(TOO_MANY_THEMES);
    // invalid_grouping and composition are both "the service returned something
    // we will not build a report on".
    return new AnalysisError(INVALID);
  }

  if (err instanceof AnalysisError) return err;
  return new AnalysisError(UNAVAILABLE);
}

const CANCELLED = "The analysis was cancelled.";
const INVALID = "The analysis service returned an invalid response. Please try again.";
const UNAVAILABLE = "The analysis service is unavailable right now. Please try again.";
const BUSY = "The analysis service is busy right now. Please try again in a moment.";
const DISABLED = "AI analysis is temporarily unavailable.";
const MISCONFIGURED = "The analysis service is not configured.";
const SIGN_IN = "This deployment requires sign-in. Sign in to the protected demo and try again.";
const OFFLINE = "Could not reach the analysis service. Check your connection and try again.";
const TIMED_OUT = "The analysis timed out. Analyze a smaller selection and try again.";
const TOO_LARGE = "That selection is too large for the Claude engine. Analyze a smaller selection, or use the heuristic engine, which has no limit.";
const TOO_MANY_THEMES =
  "The selection produced too many distinct themes to group reliably. Analyze a smaller selection, or use the heuristic engine, which has no limit.";

function messageForCode(code: string | undefined): string {
  switch (code) {
    case "analysis_disabled":
      return DISABLED;
    case "analysis_busy":
      return BUSY;
    case "analysis_timeout":
    case "output_truncated":
      return TIMED_OUT;
    case "payload_too_large":
      return TOO_LARGE;
    case "unauthorized":
      return SIGN_IN;
    case "server_misconfigured":
      return MISCONFIGURED;
    case "network":
      return OFFLINE;
    case "provider_unavailable":
      return UNAVAILABLE;
    case "invalid_response":
    case "invalid_request":
    case "invalid_grouping":
      return INVALID;
    default:
      return UNAVAILABLE;
  }
}
