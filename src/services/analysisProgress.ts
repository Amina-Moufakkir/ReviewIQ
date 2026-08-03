/**
 * What an in-flight analysis reports about itself.
 *
 * The pipeline owns phase transitions and the executor owns completed-row
 * counts; nothing here computes either. This module exists so the shape and the
 * ordering rule live in one place rather than being re-derived by whichever
 * component happens to render them.
 */

export type AnalysisPhase =
  | "preparing"
  | "analyzing-reviews"
  | "grouping-themes"
  | "building-report";

/**
 * Phases in the only order they can occur.
 *
 * Declared as data rather than implied by a switch, because the monotonicity
 * rule needs to compare two phases and a comparison is what an ordered list is
 * for. A phase absent from here has no defined position and is rejected.
 */
export const PHASE_ORDER: readonly AnalysisPhase[] = [
  "preparing",
  "analyzing-reviews",
  "grouping-themes",
  "building-report",
];

export interface AnalysisProgress {
  phase: AnalysisPhase;
  /** Rows finished so far. Never decreases within a run. */
  rowsCompleted: number;
  /** Rows selected, fixed when the run starts. */
  rowsTotal: number;
  /**
   * Completed request count, for diagnostics only.
   *
   * Deliberately NOT rendered as a fraction or a percentage: adaptive sizing
   * means the eventual total is unknown while the run is in flight, so any
   * denominator would be a guess that moves as the planner resizes — a progress
   * bar that slides backwards. Rows are known at the start and only ever rise.
   */
  batchesCompleted: number;
}

/** Position of a phase, or -1 if it is not a phase we recognise. */
export function phaseIndex(phase: AnalysisPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

/**
 * Whether `next` may replace `previous` on screen.
 *
 * Progress must never move backward. Two things can push it that way, and both
 * are ordinary rather than exotic: a superseded run whose callback arrives late
 * (handled separately by the run token, but this is the second line), and a
 * within-phase update that races another. So an update is accepted only when it
 * advances the phase, or holds the phase and does not lose ground on rows.
 *
 * `rowsTotal` changing means the update belongs to a different selection
 * entirely and is refused outright.
 */
export function isProgressAdvance(
  previous: AnalysisProgress | null,
  next: AnalysisProgress,
): boolean {
  const nextIndex = phaseIndex(next.phase);
  if (nextIndex < 0) return false;
  if (next.rowsCompleted < 0 || next.rowsCompleted > next.rowsTotal) return false;
  if (previous === null) return true;
  if (previous.rowsTotal !== next.rowsTotal) return false;

  const previousIndex = phaseIndex(previous.phase);
  if (nextIndex > previousIndex) return true;
  if (nextIndex < previousIndex) return false;
  return next.rowsCompleted >= previous.rowsCompleted;
}

/** A callback an engine may use to report progress. Optional at every layer. */
export type ProgressReporter = (progress: AnalysisProgress) => void;
