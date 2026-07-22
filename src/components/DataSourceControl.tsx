import type { ChangeEvent } from "react";
import type { Dataset } from "../types";

interface DataSourceControlProps {
  dataset: Dataset;
  isParsing: boolean;
  error: string;
  /** Rows dropped as invalid on the last successful upload (0 when none). */
  skipped: number;
  onFile: (file: File) => void;
  onLoadSampleCsv: () => void;
  onUseBuiltIn: () => void;
}

/** Choose the review dataset: built-in sample, bundled CSV, or an upload. */
export function DataSourceControl({
  dataset,
  isParsing,
  error,
  skipped,
  onFile,
  onLoadSampleCsv,
  onUseBuiltIn,
}: DataSourceControlProps) {
  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    // Reset so selecting the same file again re-triggers change.
    e.target.value = "";
  }

  const linkClass =
    "font-mono text-[11px] uppercase tracking-[0.15em] text-ink underline decoration-rule underline-offset-4 transition hover:decoration-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="border border-rule bg-card p-5">
      <p className="mb-3 font-mono text-xs font-medium uppercase tracking-[0.2em] text-ink-soft">
        Data source
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink">
          Using <span className="font-medium">{dataset.label}</span>
          <span className="text-ink-soft">
            {" "}· {dataset.reviews.length} reviews · {dataset.products.length} product
            {dataset.products.length === 1 ? "" : "s"}
          </span>
        </p>

        <div className="flex flex-wrap items-center gap-4">
          {/* Accessible file picker: real input inside a styled label. */}
          <label className={`${linkClass} cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink`}>
            Upload CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              disabled={isParsing}
              onChange={handleChange}
            />
          </label>

          {dataset.source === "sample" ? (
            <button type="button" className={linkClass} disabled={isParsing} onClick={onLoadSampleCsv}>
              Load 204-review sample
            </button>
          ) : (
            <button type="button" className={linkClass} disabled={isParsing} onClick={onUseBuiltIn}>
              Use built-in sample
            </button>
          )}
        </div>
      </div>

      {isParsing ? (
        <p className="mt-3 flex items-center gap-2 font-mono text-[11px] text-ink-soft" role="status">
          <span
            className="h-3 w-3 animate-spin rounded-full border-2 border-rule border-t-ink"
            aria-hidden="true"
          />
          Reading file…
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 font-mono text-[11px] text-fault">
          {error}
        </p>
      ) : null}

      {!error && !isParsing && skipped > 0 ? (
        <p className="mt-3 font-mono text-[11px] text-ink-soft">
          Loaded successfully. Skipped {skipped} invalid row{skipped === 1 ? "" : "s"}.
        </p>
      ) : null}
    </div>
  );
}
