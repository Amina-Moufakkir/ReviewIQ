import { estimateOutputTokens, type IncomingReview } from "./claudeTags";
import {
  DEFAULT_PLANNER_CONFIG,
  beginPlan,
  nextBatch,
  observe,
  textBytesOf,
  type PlannerConfig,
} from "./batchPlanner";

/**
 * Pre-run cost and runtime estimation for category-scale analysis.
 *
 * Pure: no network, no UI, no dispatching. It consumes the planner's projection
 * and returns what an analyst needs to decide whether to start a run — and what
 * the app needs to refuse one that is too large.
 *
 * Cost and runtime are derived DIFFERENTLY, on purpose:
 *
 *  - **Cost is a conservative ceiling.** It assumes a pessimistic operational
 *    batch size, so the batch count — and therefore the per-batch prompt
 *    overhead — is over-stated rather than under-stated. A bill that lands
 *    under the estimate is fine; one that lands over it is a broken promise.
 *  - **Runtime is a realistic range.** It uses the planner's actual projection,
 *    because a wildly pessimistic "this will take twenty minutes" teaches people
 *    to ignore the number, which is worse than not showing one.
 *
 * Both batch counts stay visible in the result so the asymmetry is legible
 * rather than hidden inside one blended figure.
 */

// --- environment -------------------------------------------------------------

export type RunEnvironment = "protected-demo" | "local";

export interface EnvironmentCeiling {
  /** Largest selection that may be submitted at all. Above this: refuse. */
  maxRows: number;
  /** Estimated cost above which the analyst must confirm before the run starts. */
  confirmAboveUsd: number;
}

/**
 * Ceilings differ because the exposures differ, and they are deliberately not
 * derived from one another.
 *
 * The protected demo serves only the 25-row synthetic dataset, so 60 rows is far
 * above anything it can legitimately be asked for; it exists to bound a mistake.
 * Local runs work against the real Amazon dataset, where a 526-record category
 * is the entire point, so the ceiling has to accommodate that while still
 * refusing something absurd.
 */
export const ENVIRONMENT_CEILINGS: Record<RunEnvironment, EnvironmentCeiling> = {
  "protected-demo": { maxRows: 60, confirmAboveUsd: 0.25 },
  local: { maxRows: 600, confirmAboveUsd: 0.5 },
};

// --- configuration -----------------------------------------------------------

export interface EstimatorConfig {
  /** USD per million input tokens for the configured model. */
  inputUsdPerMTok: number;
  /** USD per million output tokens. */
  outputUsdPerMTok: number;
  /**
   * Batch size assumed for COST only. Benchmark-derived and pessimistic.
   *
   * Explicitly NOT the planner's mathematical minimum of 1: a run pinned at one
   * row per batch is a failing run, not a normal one, and pricing every estimate
   * as though it were would inflate the figure until nobody believed it. This is
   * the size the planner settles on for the densest data measured — the target
   * output budget divided by ~405 tok/row — so it is the worst size a healthy
   * run is expected to reach.
   */
  pessimisticRowsPerBatch: number;
  /** Fixed input tokens every request pays for the system prompt. Measured. */
  systemPromptTokens: number;
  /** Estimated input tokens per byte of review text. The higher of the two measured. */
  inputTokensPerTextByte: number;
  /** Estimated output tokens per emitted tag. Measured. */
  outputTokensPerTag: number;
  /** Share of tags expected to be distinct theme labels, for canonicalization sizing. */
  distinctLabelRatio: number;
  /** Max labels one canonicalization request carries, before hierarchy. */
  maxLabelsPerCanonicalizationRequest: number;
  /** Fraction of batches assumed to be retried once. */
  retryAllowance: number;
  /** Measured streaming throughput, output tokens per second. */
  outputTokensPerSecond: number;
  /** Time before the first token, per request. */
  timeToFirstTokenMs: number;
  /** Concurrent in-flight batches. */
  concurrency: number;
  /** Runtime uncertainty band applied to the point estimate. */
  runtimeLowFactor: number;
  runtimeHighFactor: number;
}

/**
 * Defaults from bench/DECISION.md (2026-08-02) and the verified price table.
 *
 * As with the planner's constants, these are tuning decisions extrapolated from
 * a small benchmark — two datasets, one model. They are starting values, not
 * measured optima, and they live in configuration so retuning is a data
 * exercise rather than a code hunt.
 */
export const DEFAULT_ESTIMATOR_CONFIG: EstimatorConfig = {
  // claude-opus-4-8, verified against the published price table 2026-08-02.
  inputUsdPerMTok: 5,
  outputUsdPerMTok: 25,
  // 1,400 target output tokens / ~405 tok/row on the densest measured data.
  pessimisticRowsPerBatch: 3,
  systemPromptTokens: 760,
  // 0.305 measured on dense rows, 0.436 on light. The higher is taken because
  // this figure drives a cost ceiling, and a ceiling must not under-state.
  inputTokensPerTextByte: 0.44,
  outputTokensPerTag: 61,
  // 13.5 distinct themes from 33 tags measured; rounded up for headroom.
  distinctLabelRatio: 0.5,
  maxLabelsPerCanonicalizationRequest: 300,
  retryAllowance: 0.1,
  outputTokensPerSecond: 110,
  timeToFirstTokenMs: 1000,
  concurrency: 6,
  // Judgment informed by the observed spread, not a computed confidence
  // interval — labelled as a range so it is not mistaken for precision.
  runtimeLowFactor: 0.6,
  runtimeHighFactor: 1.75,
};

// --- result ------------------------------------------------------------------

export interface CostBreakdown {
  taggingUsd: number;
  canonicalizationUsd: number;
  retryAllowanceUsd: number;
  /** Conservative ceiling, not an expected price. */
  totalUsd: number;
}

export interface RuntimeRange {
  lowMs: number;
  expectedMs: number;
  highMs: number;
}

export interface RunEstimate {
  environment: RunEnvironment;
  rowCount: number;
  textBytes: number;
  /** What the planner would actually produce, from a dry projection. Drives runtime. */
  projectedBatchCount: number;
  /** Batches at the pessimistic operational size. Drives cost. Never below projected. */
  conservativeBatchCount: number;
  cost: CostBreakdown;
  runtime: RuntimeRange;
  requiresConfirmation: boolean;
  /** True when the selection is larger than this environment permits at all. */
  exceedsCeiling: boolean;
  ceiling: EnvironmentCeiling;
}

// --- projection --------------------------------------------------------------

/**
 * How many batches the planner would produce if reality matched the seeded
 * density estimate.
 *
 * Each projected batch is fed back a synthetic observation derived from the
 * seed, so the planner ramps exactly as it would in a run that behaves as
 * predicted. Draining without feeding anything back would be wrong: the planner
 * only resizes on observation, so it would stay pinned at the small calibration
 * size for the whole projection and report far more batches than a real run
 * makes — modelling a planner that never learns.
 *
 * This is still the OPTIMISTIC count: a real run also shrinks under latency
 * pressure, which the seed cannot anticipate. It is right for runtime, where
 * realism matters, and deliberately not used alone for cost.
 */
export function projectBatchCount(
  rows: readonly IncomingReview[],
  config: EstimatorConfig = DEFAULT_ESTIMATOR_CONFIG,
  plannerConfig: PlannerConfig = DEFAULT_PLANNER_CONFIG,
): number {
  let state = beginPlan(rows, plannerConfig);
  let count = 0;
  // Bounded: a planning defect must fail loudly rather than hang a caller.
  for (let guard = 0; guard <= rows.length + 1; guard++) {
    const step = nextBatch(state);
    if (!step) return count;
    count++;
    const batchRows = step.batch.rows.length;
    const outputTokens = batchRows * state.density;
    state = observe(step.state, {
      rows: batchRows,
      outputTokens,
      latencyMs:
        config.timeToFirstTokenMs + (outputTokens / config.outputTokensPerSecond) * 1000,
      outcome: "ok",
    }).state;
  }
  throw new Error("batch projection did not terminate");
}

// --- estimation --------------------------------------------------------------

function costOfTokens(inputTokens: number, outputTokens: number, c: EstimatorConfig): number {
  return (inputTokens / 1e6) * c.inputUsdPerMTok + (outputTokens / 1e6) * c.outputUsdPerMTok;
}

/**
 * Cost of the canonicalization pass, sized from the tags the run is expected to
 * emit. Labels only — this request never carries review text, which is why its
 * input is a function of label count rather than of selection bytes.
 */
function canonicalizationCost(outputTokens: number, c: EstimatorConfig): number {
  const tags = outputTokens / c.outputTokensPerTag;
  const labels = Math.ceil(tags * c.distinctLabelRatio);
  if (labels === 0) return 0;

  // Above the per-request bound the pass goes hierarchical: chunks, then a pass
  // over the surviving representatives. Charged as both levels.
  const chunks = Math.ceil(labels / c.maxLabelsPerCanonicalizationRequest);
  const requests = chunks > 1 ? chunks + 1 : 1;

  // ~6 input tokens per label, ~3 output tokens per label for the index groups.
  const inputTokens = labels * 6 + requests * c.systemPromptTokens;
  const outputTokensOut = labels * 3;
  return costOfTokens(inputTokens, outputTokensOut, c);
}

/**
 * Estimate a run before any request is made.
 *
 * Cost is a ceiling; runtime is a range. Neither is a promise: both rest on a
 * two-point density fit, and a selection whose rows are denser than the fit
 * predicts will cost and take more. The ceilings and the confirmation gate
 * exist because of that, not in spite of it.
 */
export function estimateRun(
  rows: readonly IncomingReview[],
  environment: RunEnvironment,
  config: EstimatorConfig = DEFAULT_ESTIMATOR_CONFIG,
  plannerConfig: PlannerConfig = DEFAULT_PLANNER_CONFIG,
): RunEstimate {
  const ceiling = ENVIRONMENT_CEILINGS[environment];
  const rowCount = rows.length;
  const textBytes = textBytesOf(rows);

  const projectedBatchCount = projectBatchCount(rows, config, plannerConfig);
  // The more pessimistic of the two derivations. Taking the max matters for
  // unusually dense rows, where the planner would settle BELOW the pessimistic
  // operational size and the projection is therefore the higher figure — cost
  // must never rest on the optimistic count in that case.
  const conservativeBatchCount =
    rowCount === 0
      ? 0
      : Math.max(Math.ceil(rowCount / config.pessimisticRowsPerBatch), projectedBatchCount);

  // --- cost: conservative ceiling -------------------------------------------
  const outputTokens = rowCount === 0 ? 0 : estimateOutputTokens(rowCount, textBytes);
  const inputTokens =
    textBytes * config.inputTokensPerTextByte + conservativeBatchCount * config.systemPromptTokens;

  const taggingUsd = costOfTokens(inputTokens, outputTokens, config);
  const canonicalizationUsd = canonicalizationCost(outputTokens, config);
  // Retries re-run tagging work only; canonicalization runs once per run.
  const retryAllowanceUsd = taggingUsd * config.retryAllowance;
  const totalUsd = taggingUsd + canonicalizationUsd + retryAllowanceUsd;

  // --- runtime: realistic range ---------------------------------------------
  const perBatchOutputTokens = projectedBatchCount === 0 ? 0 : outputTokens / projectedBatchCount;
  const perBatchMs =
    projectedBatchCount === 0
      ? 0
      : config.timeToFirstTokenMs + (perBatchOutputTokens / config.outputTokensPerSecond) * 1000;
  const waves = Math.ceil(projectedBatchCount / config.concurrency);

  const canonicalizationLabels = Math.ceil(
    (outputTokens / config.outputTokensPerTag) * config.distinctLabelRatio,
  );
  const canonicalizationMs =
    canonicalizationLabels === 0
      ? 0
      : config.timeToFirstTokenMs + ((canonicalizationLabels * 3) / config.outputTokensPerSecond) * 1000;

  const expectedMs = Math.round(waves * perBatchMs + canonicalizationMs);

  return {
    environment,
    rowCount,
    textBytes,
    projectedBatchCount,
    conservativeBatchCount,
    cost: {
      taggingUsd,
      canonicalizationUsd,
      retryAllowanceUsd,
      totalUsd,
    },
    runtime: {
      lowMs: Math.round(expectedMs * config.runtimeLowFactor),
      expectedMs,
      highMs: Math.round(expectedMs * config.runtimeHighFactor),
    },
    requiresConfirmation: totalUsd > ceiling.confirmAboveUsd,
    exceedsCeiling: rowCount > ceiling.maxRows,
    ceiling,
  };
}

// --- refusal -----------------------------------------------------------------

/**
 * Why a run was refused, for a selection over the environment's ceiling.
 *
 * States the real count against the limit, because "too large" without a number
 * leaves the analyst unable to tell whether they were close. It never truncates
 * silently — refusing and saying so is the whole point of the ceiling.
 */
export function ceilingRefusalMessage(estimate: RunEstimate, unitPlural = "rows"): string {
  return (
    `That selection has ${estimate.rowCount} ${unitPlural}, over the ${estimate.ceiling.maxRows} ` +
    `this deployment allows in one analysis. Analyze a smaller selection, or use the heuristic ` +
    `engine, which has no limit.`
  );
}
