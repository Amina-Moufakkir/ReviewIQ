import type { ChangeEvent } from "react";
import type { Dataset } from "../types";
import type { LoadStats } from "../lib/parseReviews";
import { formatCount, isSyntheticDemo, type DatasetUnit } from "../lib/datasetInfo";

interface DataSourceControlProps {
  dataset: Dataset;
  /** True while a dataset is being fetched or parsed. */
  isLoadingDataset: boolean;
  error: string;
  /** What the last load read, accepted and skipped. Null for the built-in sample. */
  loadStats: LoadStats | null;
  /** What one row of the active dataset is — a review, or a product record. */
  unit: DatasetUnit;
  onFile: (file: File) => void;
  onLoadAmazon: () => void;
  onLoadSampleCsv: () => void;
  onUseBuiltIn: () => void;
}

/** Choose the review dataset: Amazon product records, the sample, or an upload. */
export function DataSourceControl({
  dataset,
  isLoadingDataset,
  error,
  loadStats,
  unit,
  onFile,
  onLoadAmazon,
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
            {" "}· {formatCount(dataset.reviews.length, unit)} ·{" "}
            {dataset.products.length.toLocaleString()} product
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
              disabled={isLoadingDataset}
              onChange={handleChange}
            />
          </label>

          {dataset.source !== "amazon" ? (
            <button type="button" className={linkClass} disabled={isLoadingDataset} onClick={onLoadAmazon}>
              Amazon dataset
            </button>
          ) : null}

          {dataset.source === "sample" ? (
            <button type="button" className={linkClass} disabled={isLoadingDataset} onClick={onLoadSampleCsv}>
              Load 204-review sample
            </button>
          ) : (
            <button type="button" className={linkClass} disabled={isLoadingDataset} onClick={onUseBuiltIn}>
              Use built-in sample
            </button>
          )}
        </div>
      </div>

      {/* What this data actually is — stated wherever it is selected. */}
      {!isLoadingDataset && !error && unit.isProductLevel ? (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          {isSyntheticDemo(dataset) ? (
            <>
              <span className="font-medium text-ink">
                These records are invented, not real customer feedback.
              </span>{" "}
              The real Amazon dataset is not redistributed here, so this synthetic stand-in takes its
              place and exercises the same path.{" "}
            </>
          ) : null}
          Each row is one product listing, not one customer. It carries a product-average rating and
          several customers' reviews concatenated into a single block of text, with no review dates —
          so counts below are counts of product records.
        </p>
      ) : null}

      {isLoadingDataset ? (
        <p className="mt-3 flex items-center gap-2 font-mono text-[11px] text-ink-soft" role="status">
          <span
            className="h-3 w-3 animate-spin rounded-full border-2 border-rule border-t-ink"
            aria-hidden="true"
          />
          Loading data…
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 font-mono text-[11px] text-fault">
          {error}
        </p>
      ) : null}

      {/* Full accounting: every row read is either accepted or attributed to a
          skip reason. Nothing is discarded silently. */}
      {!error && !isLoadingDataset && loadStats ? (
        <p className="mt-3 font-mono text-[11px] leading-relaxed text-ink-soft">
          {loadStats.parsed.toLocaleString()} parsed · {loadStats.accepted.toLocaleString()} accepted ·{" "}
          {loadStats.skipped.toLocaleString()} skipped
          {loadStats.skipped > 0 ? ` (${formatSkipReasons(loadStats.skipReasons)})` : ""}
        </p>
      ) : null}
    </div>
  );
}

/** "invalid rating 1, duplicate review id 2" — reasons in descending count. */
function formatSkipReasons(reasons: Partial<Record<string, number>>): string {
  return Object.entries(reasons)
    .filter((entry): entry is [string, number] => Boolean(entry[1]))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason.replace(/_/g, " ")} ${count.toLocaleString()}`)
    .join(", ");
}
