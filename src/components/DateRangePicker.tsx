interface DateRangePickerProps {
  from: string;
  to: string;
  onFromChange: (date: string) => void;
  onToChange: (date: string) => void;
  disabled?: boolean;
  /** Optional inline validation message (e.g. start after end). */
  error?: string;
}

const inputClass =
  "rounded-sm border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none transition focus:border-ink focus:ring-1 focus:ring-ink disabled:cursor-not-allowed disabled:opacity-50";

/** Accessible from/to date range using native date inputs. */
export function DateRangePicker({
  from,
  to,
  onFromChange,
  onToChange,
  disabled,
  error,
}: DateRangePickerProps) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 font-mono text-xs font-medium uppercase tracking-[0.15em] text-ink-soft">
        Window
      </legend>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="from" className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft">
            From
          </label>
          <input
            id="from"
            type="date"
            value={from}
            max={to || undefined}
            disabled={disabled}
            onChange={(e) => onFromChange(e.target.value)}
            aria-invalid={Boolean(error)}
            className={inputClass}
          />
        </div>
        <span className="pb-2 font-mono text-ink-soft" aria-hidden="true">
          →
        </span>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="to" className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft">
            To
          </label>
          <input
            id="to"
            type="date"
            value={to}
            min={from || undefined}
            disabled={disabled}
            onChange={(e) => onToChange(e.target.value)}
            aria-invalid={Boolean(error)}
            className={inputClass}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-1 font-mono text-xs text-fault">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
