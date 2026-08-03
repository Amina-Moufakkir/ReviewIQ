import { useRef } from "react";
import type { PlannedRun } from "../services/claudeRunPlan";
import { formatCount } from "../lib/datasetInfo";
import { formatCostCeiling, formatRuntimeRange } from "../lib/formatEstimate";

interface ConfirmRunDialogProps {
  /** The plan being approved. Rendered as given — nothing here recomputes it. */
  plan: PlannedRun;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Asks before a run large enough to be worth asking about.
 *
 * It renders only from `state.status === "confirming"`, and reaching that state
 * is what guarantees nothing has been dispatched: the planner returns "confirm"
 * *instead of* starting, so this dialog is not a veto over work already in
 * flight — the work does not exist yet.
 *
 * Every number shown comes from the estimate the engine will act on. None is
 * recomputed here, so the dialog cannot describe a run different from the one
 * Start actually begins.
 *
 * The copy names no batches, requests, or stages. What an analyst is deciding
 * is whether this much time and this much money is worth it, and neither
 * depends on how the work is divided up.
 */
export function ConfirmRunDialog({ plan, onConfirm, onCancel }: ConfirmRunDialogProps) {
  const { estimate, matched, subject, unit } = plan;
  /**
   * A second click must not start a second run.
   *
   * The state change to `running` unmounts this, but two clicks dispatched in
   * the same tick both see the old state. Latching here means the guarantee
   * does not depend on how fast React re-renders.
   */
  const started = useRef(false);

  function handleConfirm() {
    if (started.current) return;
    started.current = true;
    onConfirm();
  }

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby="confirm-run-title"
      className="rounded-sm border border-ink bg-paper p-5"
    >
      <h2
        id="confirm-run-title"
        className="font-display text-xl font-medium leading-snug text-ink"
      >
        Analyze {formatCount(matched.length, unit)}?
      </h2>

      {/* The selection stays named, so the decision is never about an unnamed
          "current selection" the analyst has to remember. */}
      <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-soft">
        {subject.name}
      </p>

      <dl className="mt-4 flex flex-col gap-1.5 text-sm text-ink">
        <div className="flex gap-2">
          <dt className="text-ink-soft">Estimated time:</dt>
          <dd>{formatRuntimeRange(estimate.runtime.lowMs, estimate.runtime.highMs)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-ink-soft">Conservative API cost estimate:</dt>
          <dd>up to about {formatCostCeiling(estimate.cost.totalUsd)}</dd>
        </div>
      </dl>

      {/* The all-or-nothing contract, stated before the money is spent rather
          than explained afterwards. */}
      <p className="mt-4 text-sm leading-relaxed text-ink-soft">
        ReviewIQ creates a report only if the full analysis completes and validates successfully.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleConfirm}
          className="inline-flex items-center justify-center rounded-sm bg-ink px-5 py-2.5 font-mono text-xs font-medium uppercase tracking-[0.15em] text-paper transition hover:opacity-90 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Start analysis
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center justify-center rounded-sm border border-rule px-5 py-2.5 font-mono text-xs font-medium uppercase tracking-[0.15em] text-ink transition hover:border-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
