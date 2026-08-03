import type { AnalysisInput, Dataset, Product, Review } from "../types";
import { selectForScope } from "./analysisEngine";
import type { IncomingReview } from "./claudeTags";
import {
  ceilingRefusalMessage,
  estimateRun,
  unsupportedGroupingMessage,
  type RunEstimate,
} from "./runEstimator";
import { RUN_ENVIRONMENT } from "../config";
import { unitFor, pluralize, type DatasetUnit } from "../lib/datasetInfo";

/**
 * Decide, before anything is dispatched, whether a Claude run may start — and
 * whether the analyst should be asked first.
 *
 * This exists so there is exactly ONE answer to that question. The confirmation
 * dialog and the engine's own preflight both call it, so a run the dialog
 * offered can never be one the engine would refuse, and a refusal can never be
 * worded differently depending on which of them noticed.
 *
 * It computes nothing itself: the ceiling, the projection, the cost and the
 * refusal wording all come from the estimator unchanged.
 */

export interface PlannedRun {
  subject: Product;
  matched: Review[];
  rows: IncomingReview[];
  unit: DatasetUnit;
  estimate: RunEstimate;
}

export type RunPlan =
  /** Cannot run at all. The message is analyst-facing and final. */
  | { decision: "refuse"; message: string; plan: PlannedRun }
  /** May run, but costs enough that the analyst should say so first. */
  | { decision: "confirm"; plan: PlannedRun }
  /** May run immediately. */
  | { decision: "go"; plan: PlannedRun }
  /** Nothing selected — the legitimate empty state, which costs nothing. */
  | { decision: "empty"; plan: PlannedRun };

export function planClaudeRun(input: AnalysisInput, dataset: Dataset): RunPlan {
  const { subject, rows: matched } = selectForScope(input, dataset.reviews, dataset.products);
  const unit = unitFor(dataset);
  const rows: IncomingReview[] = matched.map((r) => ({ id: r.id, text: r.text }));
  const estimate = estimateRun(rows, RUN_ENVIRONMENT);
  const plan: PlannedRun = { subject, matched, rows, unit, estimate };

  if (matched.length === 0) return { decision: "empty", plan };

  // Order matters and mirrors the engine exactly: too large to attempt, then
  // predicted unable to finish, then affordable enough to start unasked.
  if (estimate.exceedsCeiling) {
    return {
      decision: "refuse",
      message: ceilingRefusalMessage(estimate, pluralize(matched.length, unit), remediesFor(input)),
      plan,
    };
  }
  if (estimate.canonicalization.unsupported) {
    return { decision: "refuse", message: unsupportedGroupingMessage(remediesFor(input)), plan };
  }
  return { decision: estimate.requiresConfirmation ? "confirm" : "go", plan };
}

/**
 * Narrowings that actually exist for this query.
 *
 * Advice has to be followable. Undated data has no window to narrow, so offering
 * that would send the analyst after a control that is not on screen; and "pick
 * one product" means nothing when a single product is already the scope.
 */
export function remediesFor(input: AnalysisInput): string[] {
  const remedies: string[] = [];
  if (input.scope.kind === "category") remedies.push("analyze a single product instead");
  if (input.from && input.to) remedies.push("narrow the date range");
  return remedies;
}
