import { useEffect, useRef, useState } from "react";
import type { AnalysisResult, Finding } from "../types";
import { formatDate } from "../lib/date";
import { generateMarkdownReport } from "../lib/generateMarkdownReport";
import { copyReportToClipboard } from "../lib/copyReport";
import { SectionLabel } from "./SectionLabel";
import { SentimentColumn } from "./SentimentColumn";

interface ResultsViewProps {
  result: AnalysisResult;
}

type Toast = { message: string; tone: "success" | "error" };

/** The full sentiment brief: findings lede, ledger, themes, recommendations. */
export function ResultsView({ result }: ResultsViewProps) {
  // Combined at-a-glance theme list, most-mentioned first.
  const themes: Finding[] = [...result.praise, ...result.faults].sort(
    (a, b) => b.mentions - a.mentions || a.label.localeCompare(b.label),
  );

  const [toast, setToast] = useState<Toast | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // Auto-dismiss the toast; the cleanup makes repeated clicks and unmounts safe.
  useEffect(() => {
    if (!toast) return;
    timerRef.current = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timerRef.current);
  }, [toast]);

  async function handleCopyReport() {
    try {
      await copyReportToClipboard(generateMarkdownReport(result));
      setToast({ message: "Report copied", tone: "success" });
    } catch {
      setToast({ message: "Could not copy report", tone: "error" });
    }
  }

  return (
    <article className="animate-reveal flex flex-col gap-10">
      {/* Findings lede — the answer, up top, set in the display serif. */}
      <header className="border-l-2 border-ink pl-5">
        <div className="flex items-start justify-between gap-4">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-ink-soft">
            Findings
          </p>
          {/* Copy action with feedback anchored right beside it, so the
              confirmation appears where the user is looking. The live region is
              always present for assistive tech; the pill is absolutely
              positioned so it never shifts the header layout. */}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={handleCopyReport}
              className="font-mono text-[11px] uppercase tracking-[0.15em] text-ink underline decoration-rule underline-offset-4 transition hover:decoration-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              Copy report
            </button>
            <span
              aria-live="polite"
              role="status"
              className="pointer-events-none absolute right-0 top-full z-10 mt-2 flex justify-end"
            >
              {toast ? (
                <span
                  className={`whitespace-nowrap border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] shadow-sm ${
                    toast.tone === "error"
                      ? "border-fault bg-card text-fault"
                      : "border-ink bg-ink text-paper"
                  }`}
                >
                  {toast.message}
                </span>
              ) : null}
            </span>
          </div>
        </div>
        <h2 className="mt-2 font-display text-3xl font-medium leading-tight text-ink">
          {result.productName}
        </h2>
        <p className="mt-3 font-mono text-xs text-ink-soft">
          {result.reviewCount} review{result.reviewCount === 1 ? "" : "s"} ·{" "}
          {result.averageRating.toFixed(1)}★ avg · {formatDate(result.from)} – {formatDate(result.to)}
        </p>
        <p className="mt-4 max-w-2xl font-display text-lg leading-relaxed text-ink">
          {result.summary}
        </p>
      </header>

      {/* Signature: the balance of opinion, weighed in two columns. */}
      <div>
        <SectionLabel>The balance of opinion</SectionLabel>
        <div className="grid gap-4 sm:grid-cols-2">
          <SentimentColumn
            tone="praise"
            title="What they praise"
            findings={result.praise}
            reviewCount={result.reviewCount}
          />
          <SentimentColumn
            tone="fault"
            title="What they fault"
            findings={result.faults}
            reviewCount={result.reviewCount}
          />
        </div>
      </div>

      {/* Recurring themes — a quick scan, colored by sentiment. */}
      <div>
        <SectionLabel>Recurring themes</SectionLabel>
        {themes.length === 0 ? (
          <p className="text-sm text-ink-soft">No recurring themes surfaced in this window.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {themes.map((theme) => (
              <li
                key={theme.label}
                className="flex items-baseline gap-2 border border-rule bg-card px-3 py-1.5"
              >
                <span
                  className={`h-1.5 w-1.5 self-center rounded-full ${
                    theme.sentiment === "positive" ? "bg-praise" : "bg-fault"
                  }`}
                  aria-hidden="true"
                />
                <span className="text-sm text-ink">{theme.label}</span>
                <span
                  className="font-mono text-xs text-ink-soft"
                  aria-label={`${theme.mentions} mentions`}
                >
                  {theme.mentions}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Recommendations — ordered by how often the fault appears. */}
      <div>
        <SectionLabel>Recommended actions</SectionLabel>
        {result.recommendations.length === 0 ? (
          <p className="text-sm text-ink-soft">
            No actions recommended — no recurring complaints in this window.
          </p>
        ) : (
          <ol className="border-y border-rule">
            {result.recommendations.map((rec, i) => (
              <li key={i} className="flex gap-4 border-b border-rule py-3 last:border-b-0">
                <span className="font-mono text-sm tabular-nums text-ink-soft" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-sm leading-relaxed text-ink">{rec}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </article>
  );
}
