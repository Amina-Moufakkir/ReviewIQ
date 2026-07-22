import { useState } from "react";
import { products } from "./data/products";
import { useAnalysis } from "./hooks/useAnalysis";
import { AnalyzeForm } from "./components/AnalyzeForm";
import { ResultsView } from "./components/ResultsView";
import { StateMessage } from "./components/StateMessage";

// Defaults chosen to cover the sample data window so the first run succeeds.
const DEFAULT_FROM = "2026-01-01";
const DEFAULT_TO = "2026-07-22";

export default function App() {
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [from, setFrom] = useState(DEFAULT_FROM);
  const [to, setTo] = useState(DEFAULT_TO);
  const { state, analyze } = useAnalysis();

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
            Pick a product and a window. ReviewIQ reads every review in range and reports what
            customers praise, what they fault, and what to do next.
          </p>
        </header>

        <div className="flex flex-col gap-10">
          <AnalyzeForm
            products={products}
            productId={productId}
            from={from}
            to={to}
            onProductChange={setProductId}
            onFromChange={setFrom}
            onToChange={setTo}
            onSubmit={() => analyze({ productId, from, to })}
            isLoading={state.status === "loading"}
          />

          <div>
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
          <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-soft">
            ReviewIQ · MVP · Sample data
          </p>
        </footer>
      </div>
    </div>
  );
}
