import { useState } from "react";
import type { Dataset, Review } from "./types";
import { sampleDataset } from "./data/sampleDataset";
import { reviewStatsFor } from "./services/analysisEngine";
import { parseReviewsCsv, CsvError } from "./lib/parseReviews";
import { useAnalysis } from "./hooks/useAnalysis";
import { AnalyzeForm } from "./components/AnalyzeForm";
import { DataSourceControl } from "./components/DataSourceControl";
import { ResultsView } from "./components/ResultsView";
import { StateMessage } from "./components/StateMessage";

/** Earliest and latest review dates in a dataset, for default range fitting. */
function datasetSpan(reviews: Review[]): { from: string; to: string } {
  const dates = reviews.map((r) => r.date).sort();
  return { from: dates[0] ?? "", to: dates[dates.length - 1] ?? "" };
}

const INITIAL_SPAN = datasetSpan(sampleDataset.reviews);

export default function App() {
  const [dataset, setDataset] = useState<Dataset>(sampleDataset);
  const [productId, setProductId] = useState(sampleDataset.products[0]?.id ?? "");
  const [from, setFrom] = useState(INITIAL_SPAN.from);
  const [to, setTo] = useState(INITIAL_SPAN.to);
  const { state, analyze, reset } = useAnalysis();

  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [skipped, setSkipped] = useState(0);

  const sampleStats = reviewStatsFor(productId, dataset.reviews);

  // Switch the active dataset: reset the product, fit the date range to it,
  // and clear any previous analysis.
  function applyDataset(next: Dataset, droppedRows: number) {
    const span = datasetSpan(next.reviews);
    setDataset(next);
    setProductId(next.products[0]?.id ?? "");
    setFrom(span.from);
    setTo(span.to);
    setSkipped(droppedRows);
    setParseError("");
    reset();
  }

  async function handleFile(file: File) {
    setIsParsing(true);
    setParseError("");
    try {
      const text = await file.text();
      const { dataset: next, skipped: dropped } = parseReviewsCsv(text, file.name);
      applyDataset(next, dropped);
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
      const { dataset: next, skipped: dropped } = parseReviewsCsv(text, "sample-reviews.csv");
      applyDataset(next, dropped);
    } catch (err) {
      setParseError(err instanceof CsvError ? err.message : "Could not load the sample file.");
    } finally {
      setIsParsing(false);
    }
  }

  function handleUseBuiltIn() {
    applyDataset(sampleDataset, 0);
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
            Upload your reviews or use the sample. Pick a product and a window, and ReviewIQ reports
            what customers praise, what they fault, and what to do next.
          </p>
        </header>

        <div className="flex flex-col gap-6">
          <DataSourceControl
            dataset={dataset}
            isParsing={isParsing}
            error={parseError}
            skipped={skipped}
            onFile={handleFile}
            onLoadSampleCsv={handleLoadSampleCsv}
            onUseBuiltIn={handleUseBuiltIn}
          />

          <AnalyzeForm
            products={dataset.products}
            productId={productId}
            from={from}
            to={to}
            sampleStats={sampleStats}
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
                title="Reading reviews…"
                description="Weighing customer feedback across the selected window."
              />
            ) : null}

            {state.status === "empty" ? (
              <StateMessage
                tone="empty"
                title="No reviews in this window"
                description={`Nothing was written about ${state.result.productName} between these dates. Try widening the window.`}
              />
            ) : null}

            {state.status === "error" ? (
              <StateMessage tone="error" title="Analysis failed" description={state.message} />
            ) : null}

            {state.status === "success" ? <ResultsView result={state.result} /> : null}
          </div>
        </div>

        <footer className="mt-16 border-t border-rule pt-4">
          <p className="font-mono text-[11px] uppercase leading-relaxed tracking-[0.15em] text-ink-soft">
            ReviewIQ · MVP · Heuristic, rating-assisted analysis over sample or uploaded data
          </p>
        </footer>
      </div>
    </div>
  );
}
