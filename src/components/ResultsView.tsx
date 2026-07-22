import type { AnalysisResult, Finding } from "../types";
import { formatDate } from "../lib/date";
import { SectionLabel } from "./SectionLabel";
import { SentimentColumn } from "./SentimentColumn";

interface ResultsViewProps {
  result: AnalysisResult;
}

/** The full sentiment brief: findings lede, ledger, themes, recommendations. */
export function ResultsView({ result }: ResultsViewProps) {
  // Combined at-a-glance theme list, most-mentioned first.
  const themes: Finding[] = [...result.praise, ...result.faults].sort(
    (a, b) => b.mentions - a.mentions || a.label.localeCompare(b.label),
  );

  return (
    <article className="animate-reveal flex flex-col gap-10">
      {/* Findings lede — the answer, up top, set in the display serif. */}
      <header className="border-l-2 border-ink pl-5">
        <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-ink-soft">
          Findings
        </p>
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
