import { estimateOutputTokens, type IncomingReview } from "./claudeTags";

/**
 * Deterministic batch planning for category-scale Claude analysis.
 *
 * Pure logic only: no network, no UI, no endpoint knowledge. It answers one
 * question — given the rows still to analyze and what the run has observed so
 * far, how many rows should the next request carry? Everything that *uses* an
 * answer (dispatching, retrying, aggregating) lands in a later change.
 *
 * The problem it exists to solve, from bench/DECISION.md: one synchronous
 * request finishes roughly 5 dense rows before the 30s wall, because what times
 * out is OUTPUT volume — how much the model has to write — not input size. A
 * 2.8 KB / 25-row request fails where a 4.9 KB / 5-row request passes. So batch
 * size has to track output density, and density varies ~3x between datasets and
 * can drift within a single category.
 *
 * Hence: seed an estimate, measure after every batch, and resize the batches
 * that have not been dispatched yet. Two signals drive it — token density says
 * what a batch WILL emit, observed latency says how close the current size is
 * running to the wall. The latency signal matters most, because it shrinks
 * before a batch fails rather than after.
 */

// --- configuration -----------------------------------------------------------

export interface PlannerConfig {
  /** Output tokens a batch should aim to produce (~13s at the measured ~110 tok/s). */
  targetOutputTokens: number;
  /** Weight on the newest observation. Higher tracks drift faster, at the cost of noise. */
  ewmaAlpha: number;
  /** Smoothed latency above this shrinks the next batch, before anything fails. */
  latencyShrinkMs: number;
  /** A batch may not grow by more than this factor in one step. */
  maxGrowthFactor: number;
  maxRowsPerBatch: number;
  minRowsPerBatch: number;
  maxBatchTextBytes: number;
  /** Rows in the first batch — small, so the first measurement arrives early and cheap. */
  calibrationRows: number;
}

/**
 * Defaults derived from measurement, not preference (bench/DECISION.md,
 * 2026-08-02): ~110 output tok/s streaming throughput, so a 30s wall admits
 * ~3,300 output tokens.
 *
 * These are TUNING DECISIONS extrapolated from a small benchmark — two
 * datasets, one model, a handful of sizes. They are starting values, not
 * measured optima. They live here, in configuration, so the next round of
 * tuning is a data exercise rather than a code hunt.
 */
export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  targetOutputTokens: 1400,
  ewmaAlpha: 0.6,
  latencyShrinkMs: 18_000,
  maxGrowthFactor: 1.5,
  maxRowsPerBatch: 12,
  minRowsPerBatch: 1,
  maxBatchTextBytes: 16 * 1024,
  calibrationRows: 2,
};

// --- types -------------------------------------------------------------------

export interface Batch {
  /** Position in the run. Aggregation keys on this, never on completion order. */
  index: number;
  rows: IncomingReview[];
  textBytes: number;
}

/** Why the next batch size changed. The field that makes resize logs tunable. */
export type ResizeReason =
  | "ewma"
  | "latency_pressure"
  | "timeout"
  | "truncation"
  | "unchanged";

/** What a completed batch reported back. Shapes the next size; nothing else. */
export interface BatchObservation {
  rows: number;
  outputTokens: number;
  latencyMs: number;
  /** `max_tokens` means the model was cut off; `timeout` means the wall was hit. */
  outcome: "ok" | "timeout" | "truncation";
}

/**
 * Immutable planner state. Every transition returns a new value, so a plan can
 * be replayed, diffed, or asserted on without a mutation escaping into a test.
 */
export interface PlanState {
  readonly config: PlannerConfig;
  /** Rows not yet placed in a batch, in their original selection order. */
  readonly remaining: readonly IncomingReview[];
  /** Index the next batch will carry. */
  readonly nextIndex: number;
  /** EWMA of output tokens per row. */
  readonly density: number;
  /** EWMA of batch latency, or null before the first observation. */
  readonly latencyMs: number | null;
  /** Rows the next batch should carry, before byte and row guards apply. */
  readonly rowsPerBatch: number;
}

// --- helpers -----------------------------------------------------------------

/** UTF-8 byte length — the same measure the endpoint's own text budget uses. */
export function textBytesOf(rows: readonly IncomingReview[]): number {
  const encoder = new TextEncoder();
  return rows.reduce((sum, r) => sum + encoder.encode(r.text).length, 0);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Starting output-tokens-per-row for a selection.
 *
 * Seeded from the validated byte-aware estimator rather than a flat constant,
 * because a constant would be wrong by ~3x on one dataset or the other: it
 * yields ~401 tok/row on dense Amazon listings and ~135 on light synthetic
 * rows, matching what was measured for each. Once a real batch reports back,
 * measurement replaces this.
 */
export function seedDensity(rows: readonly IncomingReview[]): number {
  if (rows.length === 0) return 0;
  return estimateOutputTokens(rows.length, textBytesOf(rows)) / rows.length;
}

// --- planning ----------------------------------------------------------------

/**
 * Begin a plan over `rows`, in the order given.
 *
 * Order is preserved exactly. The planner never sorts, samples, dedupes or
 * drops — every row it is handed comes back in exactly one batch, which is what
 * makes the percentage denominator captured by the caller stay honest.
 */
export function beginPlan(
  rows: readonly IncomingReview[],
  config: PlannerConfig = DEFAULT_PLANNER_CONFIG,
): PlanState {
  return {
    config,
    remaining: [...rows],
    nextIndex: 0,
    density: seedDensity(rows),
    latencyMs: null,
    // The first batch is deliberately small: it is the calibration measurement,
    // and it is batch 1 rather than an extra request.
    rowsPerBatch: clamp(config.calibrationRows, config.minRowsPerBatch, config.maxRowsPerBatch),
  };
}

/**
 * Take the next batch, or `null` when every row has been placed.
 *
 * Size is `rowsPerBatch`, then trimmed so the batch stays within the byte
 * guard. One deliberate exception: a single row larger than the whole byte
 * budget is emitted alone rather than skipped. Refusing it would strand that
 * row forever and silently break exactly-once coverage — an oversized batch the
 * endpoint may reject is a visible failure, a missing row is not.
 */
export function nextBatch(state: PlanState): { batch: Batch; state: PlanState } | null {
  if (state.remaining.length === 0) return null;

  const { maxBatchTextBytes, maxRowsPerBatch, minRowsPerBatch } = state.config;
  const want = clamp(state.rowsPerBatch, minRowsPerBatch, maxRowsPerBatch);

  const encoder = new TextEncoder();
  const rows: IncomingReview[] = [];
  let bytes = 0;

  for (const row of state.remaining.slice(0, want)) {
    const rowBytes = encoder.encode(row.text).length;
    // Always take at least one row, however large it is.
    if (rows.length > 0 && bytes + rowBytes > maxBatchTextBytes) break;
    rows.push(row);
    bytes += rowBytes;
  }

  return {
    batch: { index: state.nextIndex, rows, textBytes: bytes },
    state: {
      ...state,
      remaining: state.remaining.slice(rows.length),
      nextIndex: state.nextIndex + 1,
    },
  };
}

/**
 * Fold a completed batch's measurement into the plan, and resize what has not
 * been dispatched.
 *
 * Precedence is deliberate:
 *
 *  1. A batch that timed out or was truncated halves the size immediately. It
 *     is direct evidence the current size does not fit, and it outranks any
 *     smoothed estimate.
 *  2. Smoothed latency over the threshold halves it too — the proactive path,
 *     acting on a trend *before* a batch fails.
 *  3. Otherwise the token budget divided by measured density sets the size,
 *     with growth capped.
 *
 * Growth is capped because one unusually terse batch should not enlarge the
 * next one into a timeout. Shrinking is not rate-limited: reacting slowly to a
 * size that is already failing has no upside.
 */
export function observe(
  state: PlanState,
  observation: BatchObservation,
): { state: PlanState; reason: ResizeReason } {
  const { config } = state;
  const { ewmaAlpha, latencyShrinkMs, maxGrowthFactor, minRowsPerBatch, maxRowsPerBatch } = config;

  const halve = (): number =>
    clamp(Math.floor(state.rowsPerBatch / 2), minRowsPerBatch, maxRowsPerBatch);

  // 1. Direct evidence that the current size does not fit.
  if (observation.outcome !== "ok") {
    return {
      state: { ...state, rowsPerBatch: halve() },
      reason: observation.outcome === "timeout" ? "timeout" : "truncation",
    };
  }

  // Measurements only fold in from batches that actually completed; a timed-out
  // batch reports partial output and would bias the estimate downward.
  const observedDensity =
    observation.rows > 0 ? observation.outputTokens / observation.rows : state.density;
  const density = ewmaAlpha * observedDensity + (1 - ewmaAlpha) * state.density;
  const latencyMs =
    state.latencyMs === null
      ? observation.latencyMs
      : ewmaAlpha * observation.latencyMs + (1 - ewmaAlpha) * state.latencyMs;

  // 2. Proactive: the trend says we are approaching the wall.
  if (latencyMs > latencyShrinkMs) {
    return {
      state: { ...state, density, latencyMs, rowsPerBatch: halve() },
      reason: "latency_pressure",
    };
  }

  // 3. Budget divided by measured density, with growth capped.
  const fromBudget = density > 0 ? Math.floor(config.targetOutputTokens / density) : maxRowsPerBatch;
  const growthCapped = Math.min(fromBudget, Math.ceil(state.rowsPerBatch * maxGrowthFactor));
  const rowsPerBatch = clamp(growthCapped, minRowsPerBatch, maxRowsPerBatch);

  return {
    state: { ...state, density, latencyMs, rowsPerBatch },
    reason: rowsPerBatch === state.rowsPerBatch ? "unchanged" : "ewma",
  };
}

// --- coverage ----------------------------------------------------------------

export interface CoverageProblem {
  missing: string[];
  duplicated: string[];
  outOfOrder: boolean;
}

/**
 * Check that a set of batches covers the original selection exactly once, in
 * order.
 *
 * This is the invariant every downstream count depends on: a missing row
 * silently understates a theme, a duplicated one overstates it, and either
 * produces a report that looks complete and is wrong. It is exported so the
 * orchestrator can assert it before aggregating, not only so tests can.
 */
export function checkCoverage(
  original: readonly IncomingReview[],
  batches: readonly Batch[],
): CoverageProblem | null {
  const flattened = batches.flatMap((b) => b.rows.map((r) => r.id));
  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const id of flattened) {
    if (seen.has(id)) duplicated.push(id);
    seen.add(id);
  }

  const originalIds = original.map((r) => r.id);
  const missing = originalIds.filter((id) => !seen.has(id));
  const outOfOrder =
    flattened.length === originalIds.length && flattened.some((id, i) => id !== originalIds[i]);

  if (missing.length === 0 && duplicated.length === 0 && !outOfOrder) return null;
  return { missing, duplicated, outOfOrder };
}
