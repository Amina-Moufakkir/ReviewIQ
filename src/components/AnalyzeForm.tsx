import type { FormEvent } from "react";
import type { Product, ReviewStats } from "../types";
import { dateRangeSuffix, formatCount, type DatasetUnit } from "../lib/datasetInfo";
import { ProductSelect } from "./ProductSelect";
import { DateRangePicker } from "./DateRangePicker";

interface AnalyzeFormProps {
  products: Product[];
  productId: string;
  from: string;
  to: string;
  /** Row count and available date span for the selected product. */
  productStats: ReviewStats;
  /** What one row of the active dataset is — a review, or a product record. */
  unit: DatasetUnit;
  /**
   * Whether the dataset carries per-review dates. When false the window is
   * hidden entirely rather than shown empty or filled with a stand-in range —
   * the data simply has no dates to filter on.
   */
  hasDates: boolean;
  onProductChange: (productId: string) => void;
  onFromChange: (date: string) => void;
  onToChange: (date: string) => void;
  onSubmit: () => void;
  isLoading: boolean;
}

/** The analyst's query panel: product + window + run action. */
export function AnalyzeForm({
  products,
  productId,
  from,
  to,
  productStats,
  unit,
  hasDates,
  onProductChange,
  onFromChange,
  onToChange,
  onSubmit,
  isLoading,
}: AnalyzeFormProps) {
  const rangeError =
    hasDates && from && to && from > to ? "Start date must be on or before the end date." : "";
  const canSubmit = Boolean(
    productId && (!hasDates || (from && to)) && !rangeError && !isLoading,
  );

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSubmit) onSubmit();
  }

  return (
    <form onSubmit={handleSubmit} className="border border-rule bg-card p-6">
      <p className="mb-5 font-mono text-xs font-medium uppercase tracking-[0.2em] text-ink-soft">
        Query
      </p>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <ProductSelect
            products={products}
            value={productId}
            onChange={onProductChange}
            disabled={isLoading}
          />
          {productStats.count > 0 ? (
            <p className="font-mono text-[11px] text-ink-soft">
              {formatCount(productStats.count, unit)}
              {dateRangeSuffix(productStats.from, productStats.to, hasDates)}
            </p>
          ) : null}
        </div>

        {/* No date window for undated data — there is nothing to filter on.
            With no data loaded at all, neither the picker nor the note applies. */}
        {hasDates ? (
          <DateRangePicker
            from={from}
            to={to}
            onFromChange={onFromChange}
            onToChange={onToChange}
            disabled={isLoading}
            error={rangeError}
          />
        ) : products.length > 0 ? (
          <p className="font-mono text-[11px] leading-relaxed text-ink-soft">
            This dataset carries no review dates, so there is no window to select. Every{" "}
            {unit.one} for the chosen product is analyzed.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center justify-center gap-2 self-start rounded-sm bg-ink px-5 py-2.5 font-mono text-xs font-medium uppercase tracking-[0.15em] text-paper transition hover:opacity-90 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isLoading ? (
            <>
              <span
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-paper/40 border-t-paper"
                aria-hidden="true"
              />
              Reading reviews…
            </>
          ) : (
            <>Run analysis →</>
          )}
        </button>

        <p className="font-mono text-[11px] leading-relaxed text-ink-soft">
          Prototype: deterministic analysis over the selected dataset.
        </p>
      </div>
    </form>
  );
}
