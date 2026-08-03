import type { AnalysisPhase, AnalysisProgress } from "../services/analysisProgress";
import { pluralize, type DatasetUnit } from "../lib/datasetInfo";

interface RunProgressPanelProps {
  /**
   * What the run is reporting, or `null` when the engine reports nothing.
   *
   * `null` is not "no progress yet" — it means this engine has no stages to
   * report, which is true of the heuristic one. It is rendered as a plain
   * working message rather than a stalled counter.
   */
  progress: AnalysisProgress | null;
  unit: DatasetUnit;
  /** Omitted when the run cannot be stopped, rather than shown and inert. */
  onCancel?: () => void;
}

/**
 * What the analysis is doing, in the analyst's vocabulary.
 *
 * The stage names describe the work, not the machinery that performs it: an
 * analyst has no way to act on a batch size or a request count, and naming them
 * would turn a status line into an implementation detail they have to decode.
 */
const PHASE_TITLE: Record<AnalysisPhase, string> = {
  preparing: "Preparing analysis…",
  "analyzing-reviews": "Analyzing reviews…",
  "grouping-themes": "Grouping related themes…",
  "building-report": "Building your report…",
};

/**
 * A compact in-place panel, not a blocking overlay.
 *
 * A run can take minutes, and an overlay would make the page unreadable for the
 * whole of it — including the selection the analyst may want to check against
 * what is running.
 */
export function RunProgressPanel({ progress, unit, onCancel }: RunProgressPanelProps) {
  const title = progress ? PHASE_TITLE[progress.phase] : `Analyzing selected ${unit.many}…`;

  return (
    <section className="rounded-sm border border-rule bg-paper p-5" aria-busy="true">
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-soft">In progress</p>
      <h2 className="mt-2 font-display text-xl font-medium leading-snug text-ink">{title}</h2>

      {progress ? (
        <>
          {/*
            Rows, never a percentage of requests. Adaptive sizing means the
            eventual request count is unknown while the run is in flight, so any
            denominator built on it would slide as the planner resizes — a bar
            that goes backwards. The row total is fixed when the run starts.
          */}
          <p className="mt-1 text-sm text-ink-soft">
            {progress.rowsCompleted} of {progress.rowsTotal}{" "}
            {pluralize(progress.rowsTotal, unit)}
          </p>
          <div
            className="mt-3 h-1 w-full overflow-hidden rounded-full bg-rule"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.rowsTotal}
            aria-valuenow={progress.rowsCompleted}
          >
            <div
              className="h-full bg-ink transition-[width] duration-300"
              style={{
                width: `${progress.rowsTotal === 0 ? 0 : (progress.rowsCompleted / progress.rowsTotal) * 100}%`,
              }}
            />
          </div>
        </>
      ) : null}

      {onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          className="mt-5 inline-flex items-center justify-center rounded-sm border border-rule px-4 py-2 font-mono text-xs font-medium uppercase tracking-[0.15em] text-ink transition hover:border-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Cancel analysis
        </button>
      ) : null}
    </section>
  );
}
