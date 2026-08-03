import { validateTags, type IncomingReview, type ValidatedTag } from "./claudeTags";
import {
  DEFAULT_PLANNER_CONFIG,
  beginPlan,
  checkCoverage,
  nextBatch,
  observe,
  type Batch,
  type PlanState,
  type PlannerConfig,
  type ResizeReason,
} from "./batchPlanner";
import { DEFAULT_ESTIMATOR_CONFIG, projectBatchCount } from "./runEstimator";

/**
 * Bounded, cancellable execution of a batched analysis run.
 *
 * This layer proves the run can be executed SAFELY. It does not make the result
 * analytically complete: themes are still per-batch raw labels, nothing is
 * canonicalized, no counts are computed, and no `AnalysisResult` is produced.
 * That is deliberate — canonicalization and aggregation land next, and shipping
 * an aggregate over fragmented labels would look finished while under-counting.
 *
 * The contract is all-or-nothing. A `BatchExecutionResult` exists only when
 * every row was covered by a validated batch. Every failure path throws, so
 * there is no shape in which a caller can accidentally treat a partial run as a
 * whole one.
 */

// --- transport ---------------------------------------------------------------

export interface DispatchRequest {
  runId: string;
  batchIndex: number;
  rows: IncomingReview[];
}

export interface DispatchResponse {
  /** Echoed back by the transport. A mismatch is a protocol violation. */
  runId: string;
  ok: boolean;
  /** Controlled error code from the endpoint when `ok` is false. */
  code?: string;
  latencyMs: number;
  /** Raw, unvalidated tags. The executor applies the client-side gate itself. */
  tags?: unknown[];
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * How a batch reaches the endpoint. Injected so the executor can be exercised
 * end-to-end without a network — every test in this module runs offline.
 */
export type Dispatch = (request: DispatchRequest, signal: AbortSignal) => Promise<DispatchResponse>;

// --- configuration -----------------------------------------------------------

export interface ExecutorConfig {
  concurrency: number;
  /** Share of the projected batch count that may be spent on retries. */
  retryBudgetFraction: number;
  /** Attempts allowed per row. 2 means one original try and one retry. */
  maxAttemptsPerRow: number;
  planner: PlannerConfig;
}

export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  concurrency: 6,
  retryBudgetFraction: 0.1,
  maxAttemptsPerRow: 2,
  planner: DEFAULT_PLANNER_CONFIG,
};

/** Codes worth retrying at a SMALLER size: the batch was too big for the wall. */
const SHRINK_AND_RETRY = new Set(["analysis_timeout", "output_truncated"]);
/** Codes worth retrying unchanged: the provider was briefly unavailable. */
const RETRY_UNCHANGED = new Set(["provider_unavailable", "analysis_busy", "network"]);

// --- result ------------------------------------------------------------------

export interface CompletedBatch {
  index: number;
  rowIds: string[];
  tags: ValidatedTag[];
  attempt: number;
  latencyMs: number;
}

export interface ResizeRecord {
  batchIndex: number;
  plannedRows: number;
  actualRows: number;
  observedOutputTokPerRow: number | null;
  densityAfter: number;
  observedLatencyMs: number;
  latencyAfter: number | null;
  nextRows: number;
  reason: ResizeReason;
}

export interface RunTelemetry {
  batchCount: number;
  retriesUsed: number;
  retryBudget: number;
  resizes: ResizeRecord[];
  totalInputTokens: number;
  totalOutputTokens: number;
  wallClockMs: number;
  maxConcurrentInFlight: number;
}

export interface BatchExecutionResult {
  runId: string;
  rowCount: number;
  /** Validated tags, restored to selection order. Raw labels — not canonicalized. */
  tags: ValidatedTag[];
  batches: CompletedBatch[];
  telemetry: RunTelemetry;
}

export interface RunProgress {
  /**
   * Rows, not batches. Adaptive sizing means the total batch count is not
   * knowable in advance, so a batch-based percentage would move backwards when
   * the planner shrinks. Row count is fixed at the start and only ever rises.
   */
  rowsCompleted: number;
  rowsTotal: number;
  batchesCompleted: number;
}

export type ExecutionFailure =
  | "aborted"
  | "protocol"
  | "over_byte_guard"
  | "terminal_batch_failure"
  /** This batch's rows already used their one retry. */
  | "attempts_exhausted"
  /** The run-wide retry allowance is spent, whatever any single row has used. */
  | "retry_budget_exhausted"
  | "invalid_response"
  | "coverage";

export class BatchExecutionError extends Error {
  constructor(
    readonly reason: ExecutionFailure,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BatchExecutionError";
  }
}

export interface RunOptions {
  dispatch: Dispatch;
  signal?: AbortSignal;
  onProgress?: (progress: RunProgress) => void;
  config?: ExecutorConfig;
  /** Injectable for deterministic tests. */
  makeRunId?: () => string;
}

// --- execution ---------------------------------------------------------------

/**
 * Execute a selection as a series of bounded batches.
 *
 * Resolves only when every row has been covered by a validated batch. Throws
 * `BatchExecutionError` on abort, protocol violation, terminal batch failure,
 * exhausted retry budget, or a coverage defect — never returning a partial run.
 */
export async function executeBatches(
  rows: readonly IncomingReview[],
  options: RunOptions,
): Promise<BatchExecutionResult> {
  const config = options.config ?? DEFAULT_EXECUTOR_CONFIG;
  const runId = (options.makeRunId ?? (() => crypto.randomUUID()))();
  const startedAt = Date.now();

  // One controller for the whole run. The caller's signal is linked into it, so
  // a terminal failure and an external cancel both stop the same things: the
  // in-flight requests AND the scheduler, which is where the remaining spend is.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }

  const rowIndex = new Map(rows.map((r, i) => [r.id, i] as const));
  const textById = new Map(rows.map((r) => [r.id, r.text] as const));
  const attempts = new Map<string, number>();

  let planState: PlanState = beginPlan(rows, config.planner);
  const completed: CompletedBatch[] = [];
  const resizes: ResizeRecord[] = [];
  const inFlight = new Map<number, Promise<void>>();

  let retriesUsed = 0;
  let batchIndex = 0;
  let rowsCompleted = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let maxConcurrentInFlight = 0;
  let failure: BatchExecutionError | null = null;
  /**
   * A hard ceiling for the NEXT batch drawn, set when rows are requeued after a
   * timeout or truncation.
   *
   * Halving the planner's size is not sufficient on its own: under concurrency
   * the sibling batches already in flight complete moments later, and their
   * successful observations grow the size straight back before the requeued
   * rows are taken. Measured, a 2-row batch that timed out was re-dispatched at
   * 2 rows — the shrink erased by the very requests that were running when it
   * failed. This carries the reduction with the rows themselves, so a retry is
   * strictly smaller than the attempt that failed whatever the siblings report.
   */
  let retryRowCap: number | null = null;
  /**
   * How many rows at the FRONT of `remaining` are requeued rather than fresh.
   *
   * A draw never mixes the two. Per-row attempt counting stops fresh rows being
   * mis-stamped, but on its own it does not help them: a batch holding one
   * exhausted row cannot be retried, so any fresh row sharing that draw is
   * dragged down with it. Keeping requeued rows in their own batches means a
   * row's fate depends only on its own history.
   */
  let requeuedRows = 0;

  // Projected with the planner this run will actually use. Defaulting here
  // would size the allowance for a different batch shape than the one being
  // executed: a smaller configured batch means more batches, and a budget
  // computed from the default would be too small to cover them.
  const retryBudget = Math.max(
    1,
    Math.ceil(
      projectBatchCount(rows, DEFAULT_ESTIMATOR_CONFIG, config.planner) *
        config.retryBudgetFraction,
    ),
  );

  const fail = (error: BatchExecutionError) => {
    // First failure wins, and it stops everything: siblings are aborted and the
    // scheduler stops taking new work.
    if (!failure) failure = error;
    abort();
  };

  /** Push rows back to the FRONT so a retry re-splits them at the current size. */
  const requeue = (batch: Batch) => {
    planState = { ...planState, remaining: [...batch.rows, ...planState.remaining] };
    requeuedRows += batch.rows.length;
  };

  const runBatch = async (batch: Batch): Promise<void> => {
    // Counted PER ROW, never batch-wide.
    //
    // A retry draw can mix requeued rows with fresh ones: the one-shot ceiling
    // covers only the next draw, so the draw after it takes the rest of the
    // requeued rows plus whatever fresh rows fit. Taking max(attempts) + 1 for
    // the batch and stamping it on every row would mark those fresh rows as
    // already retried before their first attempt had finished, and a later
    // transient failure would terminate the run instead of retrying them.
    for (const row of batch.rows) attempts.set(row.id, (attempts.get(row.id) ?? 0) + 1);
    const attempt = Math.max(...batch.rows.map((r) => attempts.get(r.id) ?? 1));

    let response: DispatchResponse;
    try {
      response = await options.dispatch(
        { runId, batchIndex: batch.index, rows: batch.rows },
        controller.signal,
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      response = {
        runId,
        ok: false,
        code: "network",
        latencyMs: 0,
      };
      void err;
    }

    if (controller.signal.aborted) return;

    // A response carrying another run's id inside a live run is a protocol
    // violation, not noise to skip. Ignoring it would leave these rows
    // unaccounted for with no diagnosable cause — the scheduler would either
    // hang or report a coverage defect far from the real problem.
    if (response.runId !== runId) {
      fail(
        new BatchExecutionError(
          "protocol",
          `Batch ${batch.index} answered with run id "${response.runId}", expected "${runId}".`,
        ),
      );
      return;
    }

    if (!response.ok) {
      const code = response.code ?? "unknown";
      // Three distinct reasons a failure is not retried, kept apart because
      // they call for different fixes: the error is deterministic, this batch
      // has already had its retry, or the run has spent its whole allowance.
      // Collapsing them would leave an operator unable to tell a broken request
      // from a run that simply gave up.
      const retryable = SHRINK_AND_RETRY.has(code) || RETRY_UNCHANGED.has(code);
      // Exhausted only if some row in THIS batch has personally used its
      // attempts — not because a neighbour in the same draw has.
      const anyRowExhausted = batch.rows.some(
        (r) => (attempts.get(r.id) ?? 0) >= config.maxAttemptsPerRow,
      );
      const reason: ExecutionFailure | null = !retryable
        ? "terminal_batch_failure"
        : anyRowExhausted
          ? "attempts_exhausted"
          : retriesUsed >= retryBudget
            ? "retry_budget_exhausted"
            : null;

      if (reason) {
        fail(
          new BatchExecutionError(reason, `Batch ${batch.index} failed with "${code}".`, code),
        );
        return;
      }

      retriesUsed++;
      if (SHRINK_AND_RETRY.has(code)) {
        // Shrink first, then requeue: the rows are re-split at the new size,
        // which is what makes this a smaller retry rather than the same one.
        const outcome = code === "analysis_timeout" ? "timeout" : "truncation";
        const before = planState.rowsPerBatch;
        const result = observe(planState, {
          rows: batch.rows.length,
          outputTokens: 0,
          latencyMs: response.latencyMs,
          outcome,
        });
        planState = result.state;
        resizes.push({
          batchIndex: batch.index,
          plannedRows: before,
          actualRows: batch.rows.length,
          observedOutputTokPerRow: null,
          densityAfter: planState.density,
          observedLatencyMs: response.latencyMs,
          latencyAfter: planState.latencyMs,
          nextRows: planState.rowsPerBatch,
          reason: result.reason,
        });
      }
      if (SHRINK_AND_RETRY.has(code)) {
        retryRowCap = Math.max(1, Math.floor(batch.rows.length / 2));
      }
      requeue(batch);
      return;
    }

    // Client-side gate. The server has already validated against these same
    // rows, so anything rejected here is a version mismatch, a defect, or a
    // tampered response — not ordinary model noise.
    const reviewsById = new Map(batch.rows.map((r) => [r.id, textById.get(r.id) ?? ""] as const));
    const { valid, rejected, deduped } = validateTags(response.tags ?? [], reviewsById);
    if (rejected > 0 || deduped > 0) {
      fail(
        new BatchExecutionError(
          "invalid_response",
          `Batch ${batch.index} returned ${rejected} invalid and ${deduped} duplicate tags.`,
        ),
      );
      return;
    }

    completed.push({
      index: batch.index,
      rowIds: batch.rows.map((r) => r.id),
      tags: valid,
      attempt,
      latencyMs: response.latencyMs,
    });
    rowsCompleted += batch.rows.length;
    totalInputTokens += response.inputTokens ?? 0;
    totalOutputTokens += response.outputTokens ?? 0;

    const before = planState.rowsPerBatch;
    const observed = response.outputTokens ?? 0;
    const result = observe(planState, {
      rows: batch.rows.length,
      outputTokens: observed,
      latencyMs: response.latencyMs,
      outcome: "ok",
    });
    planState = result.state;
    resizes.push({
      batchIndex: batch.index,
      plannedRows: before,
      actualRows: batch.rows.length,
      observedOutputTokPerRow: batch.rows.length > 0 ? observed / batch.rows.length : null,
      densityAfter: planState.density,
      observedLatencyMs: response.latencyMs,
      latencyAfter: planState.latencyMs,
      nextRows: planState.rowsPerBatch,
      reason: result.reason,
    });

    options.onProgress?.({
      rowsCompleted,
      rowsTotal: rows.length,
      batchesCompleted: completed.length,
    });
  };

  // Scheduler: fill to the concurrency limit, then wait for any slot to free.
  while (!failure) {
    while (
      !controller.signal.aborted &&
      inFlight.size < config.concurrency &&
      planState.remaining.length > 0
    ) {
      // Apply the retry ceiling for this draw only, then restore the planner's
      // own learned size so one retry does not permanently pin the run small.
      const learnedRows = planState.rowsPerBatch;
      let drawRows = retryRowCap === null ? learnedRows : Math.min(learnedRows, retryRowCap);
      // Never let a draw straddle the requeued/fresh boundary.
      if (requeuedRows > 0) drawRows = Math.min(drawRows, requeuedRows);

      const step = nextBatch({ ...planState, rowsPerBatch: drawRows });
      if (!step) break;
      retryRowCap = null;
      requeuedRows = Math.max(0, requeuedRows - step.batch.rows.length);
      planState = { ...step.state, rowsPerBatch: learnedRows };
      const batch = { ...step.batch, index: batchIndex++ };

      // Refused before dispatch: an oversized batch would be rejected by the
      // endpoint, and spending the request to discover that is pointless.
      if (batch.overByteGuard) {
        fail(
          new BatchExecutionError(
            "over_byte_guard",
            `Batch ${batch.index} is ${batch.textBytes} bytes, over the per-batch limit.`,
          ),
        );
        break;
      }

      const slot = batch.index;
      inFlight.set(
        slot,
        runBatch(batch).finally(() => inFlight.delete(slot)),
      );
      maxConcurrentInFlight = Math.max(maxConcurrentInFlight, inFlight.size);
    }

    if (inFlight.size === 0) break;
    await Promise.race(inFlight.values());
  }

  await Promise.allSettled(inFlight.values());
  if (options.signal) options.signal.removeEventListener("abort", abort);

  if (failure) throw failure;
  if (controller.signal.aborted) {
    throw new BatchExecutionError("aborted", "The analysis was cancelled.");
  }

  // Coverage is the invariant every later count depends on: a missing row
  // understates a theme, a duplicate overstates it, and both produce a report
  // that looks complete and is wrong.
  const ordered = [...completed].sort((a, b) => a.index - b.index);
  const problem = checkCoverage(
    rows,
    ordered.map((b) => ({
      index: b.index,
      rows: b.rowIds.map((id) => ({ id, text: textById.get(id) ?? "" })),
      textBytes: 0,
      overByteGuard: false,
    })),
  );
  // Dispatch order is not selection order once a batch has been requeued, so
  // only missing and duplicated rows are defects here; ordering is restored
  // below by sorting on the original index.
  if (problem && (problem.missing.length > 0 || problem.duplicated.length > 0)) {
    throw new BatchExecutionError(
      "coverage",
      `Coverage defect: ${problem.missing.length} missing, ${problem.duplicated.length} duplicated.`,
    );
  }

  const tags = ordered
    .flatMap((b) => b.tags)
    .sort((a, b) => (rowIndex.get(a.reviewId) ?? 0) - (rowIndex.get(b.reviewId) ?? 0));

  return {
    runId,
    rowCount: rows.length,
    tags,
    batches: ordered,
    telemetry: {
      batchCount: ordered.length,
      retriesUsed,
      retryBudget,
      resizes,
      totalInputTokens,
      totalOutputTokens,
      wallClockMs: Date.now() - startedAt,
      maxConcurrentInFlight,
    },
  };
}
