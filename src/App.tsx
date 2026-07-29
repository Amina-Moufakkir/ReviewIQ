import { useCallback, useEffect, useState } from "react";
import type { Dataset, Review } from "./types";
import { sampleDataset } from "./data/sampleDataset";
import { reviewStatsFor } from "./services/analysisEngine";
import { parseReviewsCsv, loadStatsFor, CsvError, type LoadStats } from "./lib/parseReviews";
import { adaptAmazonCsv } from "./lib/amazonAdapter";
import { AMAZON_DATASET_FILE, AMAZON_DATASET_LABEL, hasDates, unitFor } from "./lib/datasetInfo";
import { useAnalysis } from "./hooks/useAnalysis";
import { AnalyzeForm } from "./components/AnalyzeForm";
import { DataSourceControl } from "./components/DataSourceControl";
import { ResultsView } from "./components/ResultsView";
import { StateMessage } from "./components/StateMessage";

/**
 * Earliest and latest review dates in a dataset, for default range fitting.
 * An undated dataset (every `date` is "") yields an empty span — which is
 * exactly the window that matches every undated review, since the engines
 * filter with `date >= from && date <= to`.
 */
function datasetSpan(reviews: Review[]): { from: string; to: string } {
  const dates = reviews.map((r) => r.date).sort();
  return { from: dates[0] ?? "", to: dates[dates.length - 1] ?? "" };
}

/** The dataset shown before the Amazon fixture finishes loading. */
const EMPTY_DATASET: Dataset = {
  products: [],
  reviews: [],
  source: "amazon",
  label: AMAZON_DATASET_LABEL,
};

/**
 * Fetch and adapt the Amazon fixture. Kept outside the component (and free of
 * state) so the mount effect and the manual reload share one implementation.
 */
async function fetchAmazonDataset() {
  const res = await fetch(`${import.meta.env.BASE_URL}${AMAZON_DATASET_FILE}`);
  if (!res.ok) throw new CsvError(`Could not load the Amazon dataset (HTTP ${res.status}).`);
  return adaptAmazonCsv(await res.text(), AMAZON_DATASET_LABEL);
}

/** User-facing message for a failed dataset load, without leaking internals. */
function loadErrorMessage(err: unknown, fallback: string): string {
  return err instanceof CsvError ? err.message : fallback;
}

export default function App() {
  const [dataset, setDataset] = useState<Dataset>(EMPTY_DATASET);
  const [productId, setProductId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { state, analyze, reset } = useAnalysis();

  const [isParsing, setIsParsing] = useState(true);
  const [parseError, setParseError] = useState("");
  const [stats, setStats] = useState<LoadStats | null>(null);

  const productStats = reviewStatsFor(productId, dataset.reviews);
  const dated = hasDates(dataset);
  const unit = unitFor(dataset);

  // Switch the active dataset: reset the product, fit the date range to it,
  // and clear any previous analysis.
  const applyDataset = useCallback(
    (next: Dataset, loadStats: LoadStats | null) => {
      const span = datasetSpan(next.reviews);
      setDataset(next);
      setProductId(next.products[0]?.id ?? "");
      setFrom(span.from);
      setTo(span.to);
      setStats(loadStats);
      setParseError("");
      reset();
    },
    [reset],
  );

  async function handleLoadAmazon() {
    setIsParsing(true);
    setParseError("");
    try {
      const { dataset: next, stats: loadStats } = await fetchAmazonDataset();
      applyDataset(next, loadStats);
    } catch (err) {
      setParseError(loadErrorMessage(err, "Could not load the Amazon dataset."));
    } finally {
      setIsParsing(false);
    }
  }

  // The Amazon dataset is the default: load it once on mount. `isParsing`
  // already starts true, so the effect touches state only after the fetch
  // resolves — never synchronously during the effect body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { dataset: next, stats: loadStats } = await fetchAmazonDataset();
        if (!cancelled) applyDataset(next, loadStats);
      } catch (err) {
        if (!cancelled) setParseError(loadErrorMessage(err, "Could not load the Amazon dataset."));
      } finally {
        if (!cancelled) setIsParsing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyDataset]);

  async function handleFile(file: File) {
    setIsParsing(true);
    setParseError("");
    try {
      const text = await file.text();
      const result = parseReviewsCsv(text, file.name);
      applyDataset(result.dataset, loadStatsFor(result));
    } catch (err) {
      setParseError(err instanceof CsvError ? err.message : "Could not read the file.");
    } finally {
      setIsParsing(false);
    }
  }

  async function handleLoadSampleCsv() {
    setIsParsing(true);
    setParseError("");
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}sample-reviews.csv`);
      if (!res.ok) throw new CsvError(`Could not load the sample file (HTTP ${res.status}).`);
      const text = await res.text();
      const result = parseReviewsCsv(text, "sample-reviews.csv");
      applyDataset(result.dataset, loadStatsFor(result));
    } catch (err) {
      setParseError(err instanceof CsvError ? err.message : "Could not load the sample file.");
    } finally {
      setIsParsing(false);
    }
  }

  function handleUseBuiltIn() {
    applyDataset(sampleDataset, null);
  }

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-3xl px-5 py-8 sm:py-12">
        {/* Masthead */}
        <div className="flex items-baseline justify-between border-b border-ink pb-3">
          <span className="font-mono text-sm font-medium uppercase tracking-[0.3em] text-ink">
            ReviewIQ
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-soft">
            Customer sentiment brief
          </span>
        </div>

        {/* Hero thesis — the analyst's actual question. */}
        <header className="mt-10 mb-10">
          <h1 className="max-w-2xl font-display text-4xl font-medium leading-[1.1] text-ink sm:text-5xl">
            What are customers really saying about your products?
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-ink-soft">
            Analyze the Amazon product dataset, upload your own reviews, or use the sample. Pick a
            product and ReviewIQ reports what customers praise, what they fault, and what to do next.
          </p>
        </header>

        <div className="flex flex-col gap-6">
          <DataSourceControl
            dataset={dataset}
            isParsing={isParsing}
            error={parseError}
            stats={stats}
            unit={unit}
            onFile={handleFile}
            onLoadAmazon={handleLoadAmazon}
            onLoadSampleCsv={handleLoadSampleCsv}
            onUseBuiltIn={handleUseBuiltIn}
          />

          <AnalyzeForm
            products={dataset.products}
            productId={productId}
            from={from}
            to={to}
            productStats={productStats}
            unit={unit}
            hasDates={dated}
            onProductChange={setProductId}
            onFromChange={setFrom}
            onToChange={setTo}
            onSubmit={() => analyze({ productId, from, to }, dataset)}
            isLoading={state.status === "loading"}
          />

          {/* Single polite live region announcing analysis status and results. */}
          <div aria-live="polite" aria-atomic="false" className="mt-4">
            {state.status === "idle" ? (
              <StateMessage
                tone="idle"
                title="Awaiting your query"
                description="Choose a product and window above, then run the analysis."
              />
            ) : null}

            {state.status === "loading" ? (
              <StateMessage
                tone="loading"
                title={`Reading ${unit.many}…`}
                description="Weighing customer feedback across the current selection."
              />
            ) : null}

            {state.status === "empty" ? (
              <StateMessage
                tone="empty"
                title={`No ${unit.many} to analyze`}
                description={
                  dated
                    ? `Nothing was written about ${state.result.productName} between these dates. Try widening the window.`
                    : `There is nothing to analyze for ${state.result.productName}.`
                }
              />
            ) : null}

            {state.status === "error" ? (
              <StateMessage tone="error" title="Analysis failed" description={state.message} />
            ) : null}

            {state.status === "success" ? (
              <ResultsView result={state.result} unit={unit} hasDates={dated} />
            ) : null}
          </div>
        </div>

        <footer className="mt-16 border-t border-rule pt-4">
          <p className="font-mono text-[11px] uppercase leading-relaxed tracking-[0.15em] text-ink-soft">
            ReviewIQ · MVP · Heuristic, rating-assisted analysis over Amazon, sample or uploaded data
          </p>
        </footer>
      </div>
    </div>
  );
}
