import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnalysisInput, AnalysisScope, Dataset, Review } from "./types";
import { sampleDataset } from "./data/sampleDataset";
import { reviewStatsFor } from "./services/analysisEngine";
import { parseReviewsCsv, loadStatsFor, CsvError, type LoadStats } from "./lib/parseReviews";
import { adaptAmazonCsv } from "./lib/amazonAdapter";
import { loadUploadedCsv } from "./lib/loadUploadedCsv";
import {
  AMAZON_DATASET_FILE,
  AMAZON_DATASET_LABEL,
  AMAZON_DEMO_FILE,
  AMAZON_DEMO_LABEL,
  SAMPLE_CSV_FILE,
  categoriesIn,
  hasDates,
  unitFor,
} from "./lib/datasetInfo";
import { useAnalysis } from "./hooks/useAnalysis";
import { ConfirmRunDialog } from "./components/ConfirmRunDialog";
import { RunProgressPanel } from "./components/RunProgressPanel";
import { ANALYSIS_ENGINE } from "./config";
import { AnalyzeForm } from "./components/AnalyzeForm";
import { DataSourceControl } from "./components/DataSourceControl";
import { ResultsView } from "./components/ResultsView";
import { StateMessage } from "./components/StateMessage";

/** What every data source resolves to: a dataset, and what its load did. */
interface LoadedDataset {
  dataset: Dataset;
  stats: LoadStats | null;
}

const AMAZON_LOAD_ERROR = "Could not load the Amazon dataset.";

/**
 * What the active engine derives sentiment from. The Claude engine reads the
 * review text; the heuristic engine infers it from each row's star rating. The
 * UI states which, so a reader knows what an empty findings column means.
 */
const SENTIMENT_SOURCE: "text" | "rating" = ANALYSIS_ENGINE === "claude" ? "text" : "rating";

const MISSING_DATASET_MESSAGE =
  `No Amazon data is available — neither the generated dataset nor the bundled ` +
  `demo fixture could be loaded. See "Amazon dataset" in the README. ` +
  `You can use the built-in sample in the meantime.`;

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

/** The placeholder shown while the default Amazon dataset is still loading. */
const PENDING_AMAZON_DATASET: Dataset = {
  products: [],
  reviews: [],
  source: "amazon",
  label: AMAZON_DATASET_LABEL,
};

/** A file served from public/, under whatever base path the app is hosted at. */
function publicUrl(file: string): string {
  return `${import.meta.env.BASE_URL}${file}`;
}

// The three loaders below share one signature, `() => Promise<LoadedDataset>`,
// so the component can run any of them through the same load/error/finish path.
// They are module-level and state-free, which also lets the mount effect and the
// manual reload share a single implementation.

/**
 * The Amazon source, in order of preference:
 *
 *   1. `public/amazon-products.csv` — the real dataset, generated locally by
 *      `npm run build:amazon`. Not committed, so only a developer who has
 *      downloaded the source has it.
 *   2. `public/amazon-demo.csv` — a committed, fully synthetic stand-in in the
 *      same column shape. This is what deployed builds get.
 *
 * The fallback is deliberately to synthetic *Amazon-shaped* data, never to the
 * ordinary review sample: a visitor exploring the Amazon path must actually be
 * exercising the Amazon adapter, not a different dataset wearing its name. The
 * label says "synthetic" so the two are never confused.
 */
async function fetchAmazonDataset(): Promise<LoadedDataset> {
  const real = await fetchCsv(AMAZON_DATASET_FILE);
  const text = real ?? (await fetchCsv(AMAZON_DEMO_FILE));
  if (text === null) throw new CsvError(MISSING_DATASET_MESSAGE);

  const { dataset, stats } = adaptAmazonCsv(
    text,
    real ? AMAZON_DATASET_LABEL : AMAZON_DEMO_LABEL,
  );
  return { dataset, stats };
}

/**
 * Fetch a CSV from public/, or `null` when it is not there. A dev server
 * answering an unknown path with the SPA's index.html looks like a 200 of
 * HTML, so that counts as absent too.
 */
async function fetchCsv(file: string): Promise<string | null> {
  const res = await fetch(publicUrl(file));
  const servedHtml = (res.headers.get("content-type") ?? "").includes("text/html");
  if (!res.ok || servedHtml) return null;
  return res.text();
}

async function fetchSampleCsv(): Promise<LoadedDataset> {
  const res = await fetch(publicUrl(SAMPLE_CSV_FILE));
  if (!res.ok) throw new CsvError(`Could not load the sample file (HTTP ${res.status}).`);
  const result = parseReviewsCsv(await res.text(), SAMPLE_CSV_FILE);
  return { dataset: result.dataset, stats: loadStatsFor(result) };
}

/**
 * An upload may be either supported shape — a ReviewIQ review CSV or a raw
 * Amazon product export — so the header, not the control it arrived through,
 * decides which loader reads it. See lib/loadUploadedCsv.ts.
 */
async function readUploadedCsv(file: File): Promise<LoadedDataset> {
  return loadUploadedCsv(await file.text(), file.name);
}

/** User-facing message for a failed dataset load, without leaking internals. */
function loadErrorMessage(err: unknown, fallback: string): string {
  return err instanceof CsvError ? err.message : fallback;
}

export default function App() {
  const [dataset, setDataset] = useState<Dataset>(PENDING_AMAZON_DATASET);
  const [productId, setProductId] = useState("");
  const [scopeKind, setScopeKind] = useState<AnalysisScope["kind"]>("product");
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Alphabetical, with sizes — the size is the analyst's only warning that a
  // category may exceed the Claude engine's per-request cap.
  const categories = useMemo(() => categoriesIn(dataset), [dataset]);

  // The analyst's live query. Passing it to the hook is what guarantees the
  // visible result always describes the current selection — editing any part
  // of it clears the previous report rather than leaving it stranded.
  const scope: AnalysisScope =
    scopeKind === "category" ? { kind: "category", category } : { kind: "product", productId };
  const query: AnalysisInput = { scope, from, to };
  const { state, analyze, confirmRun, declineRun, cancel, reset } = useAnalysis(query);

  /**
   * Locked while a decision is pending or work is in flight.
   *
   * Both states are "the analyst has committed to this selection": editing it
   * mid-run would leave a report describing rows nobody asked about, and
   * editing it mid-question would answer a question about something else.
   */
  const isBusy = state.status === "confirming" || state.status === "running";

  /**
   * Whether a finished report exists to copy.
   *
   * Derived from the status alone, deliberately. Inferring it from "a result
   * object exists", "no error is showing", or "nothing is loading" would all be
   * true at moments when there is no current report — most dangerously during a
   * new run, when the only report around belongs to the previous one.
   */
  const canCopyReport = state.status === "success";

  const [isLoadingDataset, setIsLoadingDataset] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadStats, setLoadStats] = useState<LoadStats | null>(null);

  const productStats = reviewStatsFor(productId, dataset.reviews);
  const hasReviewDates = hasDates(dataset);
  const unit = unitFor(dataset);

  // Switch the active dataset: reset the product, fit the date range to it,
  // and clear any previous analysis.
  const applyDataset = useCallback(
    ({ dataset: next, stats }: LoadedDataset) => {
      const span = datasetSpan(next.reviews);
      setDataset(next);
      setProductId(next.products[0]?.id ?? "");
      // A new dataset has its own categories; carrying the old selection over
      // would leave a category chosen that nothing in this data belongs to.
      const nextCategories = categoriesIn(next);
      setCategory(nextCategories[0]?.category ?? "");
      if (nextCategories.length === 0) setScopeKind("product");
      setFrom(span.from);
      setTo(span.to);
      setLoadStats(stats);
      setLoadError("");
      reset();
    },
    [reset],
  );

  /**
   * Run a loader and apply whatever it returns. `isStale` lets the mount effect
   * drop a result whose component has since unmounted; user-initiated loads
   * always apply theirs.
   */
  const runLoad = useCallback(
    async (
      load: () => Promise<LoadedDataset>,
      fallbackMessage: string,
      isStale: () => boolean = () => false,
    ) => {
      try {
        const loaded = await load();
        if (!isStale()) applyDataset(loaded);
      } catch (err) {
        if (!isStale()) setLoadError(loadErrorMessage(err, fallbackMessage));
      } finally {
        if (!isStale()) setIsLoadingDataset(false);
      }
    },
    [applyDataset],
  );

  /** Enter the loading state before a user-initiated load. */
  function beginLoad() {
    setIsLoadingDataset(true);
    setLoadError("");
  }

  // The Amazon dataset is the default: load it once on mount. The initial state
  // already says "loading", so the effect touches state only after the fetch
  // resolves — never synchronously during the effect body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await runLoad(fetchAmazonDataset, AMAZON_LOAD_ERROR, () => cancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, [runLoad]);

  function handleLoadAmazon() {
    beginLoad();
    void runLoad(fetchAmazonDataset, AMAZON_LOAD_ERROR);
  }

  function handleLoadSampleCsv() {
    beginLoad();
    void runLoad(fetchSampleCsv, "Could not load the sample file.");
  }

  function handleFile(file: File) {
    beginLoad();
    void runLoad(() => readUploadedCsv(file), "Could not read the file.");
  }

  function handleUseBuiltIn() {
    applyDataset({ dataset: sampleDataset, stats: null });
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
            isLoadingDataset={isLoadingDataset}
            disabled={isBusy}
            error={loadError}
            loadStats={loadStats}
            unit={unit}
            onFile={handleFile}
            onLoadAmazon={handleLoadAmazon}
            onLoadSampleCsv={handleLoadSampleCsv}
            onUseBuiltIn={handleUseBuiltIn}
          />

          <AnalyzeForm
            products={dataset.products}
            productId={productId}
            scopeKind={scopeKind}
            categories={categories}
            category={category}
            onScopeKindChange={setScopeKind}
            onCategoryChange={setCategory}
            from={from}
            to={to}
            productStats={productStats}
            unit={unit}
            hasDates={hasReviewDates}
            onProductChange={setProductId}
            onFromChange={setFrom}
            onToChange={setTo}
            onSubmit={() => analyze(query, dataset)}
            isLoading={state.status === "running"}
            isLocked={isBusy}
            engine={ANALYSIS_ENGINE}
          />

          {/* Single polite live region announcing analysis status and results. */}
          <div aria-live="polite" aria-atomic="false" className="mt-4">
            {state.status === "idle" ? (
              <StateMessage
                tone="idle"
                title="Awaiting your query"
                description={`Choose a product${hasReviewDates ? " and window" : ""} above, then run the analysis.`}
              />
            ) : null}

            {state.status === "confirming" ? (
              <ConfirmRunDialog
                plan={state.plan}
                onConfirm={() => confirmRun(state.plan, query, dataset)}
                onCancel={declineRun}
              />
            ) : null}

            {state.status === "running" ? (
              <RunProgressPanel
                progress={state.progress}
                unit={unit}
                /* Only offered where it can actually stop something. The
                   heuristic engine is pure and in-browser: there is no request
                   to abort, so a Cancel button would be decoration. */
                onCancel={ANALYSIS_ENGINE === "claude" ? cancel : undefined}
              />
            ) : null}

            {state.status === "cancelled" ? (
              <StateMessage
                tone="idle"
                title="Analysis cancelled"
                description="No report was created. Your selection is unchanged — run the analysis again when you are ready."
              />
            ) : null}

            {state.status === "empty" ? (
              <StateMessage
                tone="empty"
                title={`No ${unit.many} to analyze`}
                description={
                  hasReviewDates
                    ? `Nothing was written about ${state.result.productName} between these dates. Try widening the window.`
                    : `There is nothing to analyze for ${state.result.productName}.`
                }
              />
            ) : null}

            {state.status === "error" ? (
              <StateMessage tone="error" title="Analysis failed" description={state.message} />
            ) : null}

            {canCopyReport && state.status === "success" ? (
              <ResultsView
                result={state.result}
                unit={unit}
                hasDates={hasReviewDates}
                scopeKind={scopeKind}
                sentimentSource={SENTIMENT_SOURCE}
              />
            ) : null}
          </div>
        </div>

        <footer className="mt-16 border-t border-rule pt-4">
          <p className="font-mono text-[11px] uppercase leading-relaxed tracking-[0.15em] text-ink-soft">
            ReviewIQ · MVP ·{" "}
            {SENTIMENT_SOURCE === "text"
              ? "Claude, text-based sentiment"
              : "Heuristic, rating-assisted analysis"}{" "}
            over Amazon, sample or uploaded data
          </p>
        </footer>
      </div>
    </div>
  );
}
