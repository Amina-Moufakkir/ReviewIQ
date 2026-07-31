import type { AnalysisScope } from "../types";

interface ScopeControlProps {
  kind: AnalysisScope["kind"];
  onChange: (kind: AnalysisScope["kind"]) => void;
  disabled?: boolean;
  /** Hidden when the dataset has no categories to offer. */
  categoryAvailable: boolean;
}

const OPTIONS: { kind: AnalysisScope["kind"]; label: string }[] = [
  { kind: "product", label: "One product" },
  { kind: "category", label: "A category" },
];

/**
 * Chooses what the analysis is about. Two radios rather than a select: there
 * are exactly two choices and both should be visible at once, since the choice
 * changes which picker appears below.
 *
 * Radios (not buttons) so the grouping is announced to assistive tech as one
 * question with two answers, which is what it is.
 */
export function ScopeControl({ kind, onChange, disabled, categoryAvailable }: ScopeControlProps) {
  if (!categoryAvailable) return null;

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 font-mono text-xs font-medium uppercase tracking-[0.15em] text-ink-soft">
        Analyze
      </legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {OPTIONS.map((option) => (
          <label
            key={option.kind}
            className="flex cursor-pointer items-center gap-2 text-sm text-ink has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
          >
            <input
              type="radio"
              name="scope"
              value={option.kind}
              checked={kind === option.kind}
              onChange={() => onChange(option.kind)}
              className="h-3.5 w-3.5 accent-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
