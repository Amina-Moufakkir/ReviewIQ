import type { AnalysisResult } from "../types";
import { SectionLabel } from "./SectionLabel";
import { SentimentColumn } from "./SentimentColumn";

interface ResultsViewProps {
  result: AnalysisResult;
}

function formatDate(iso: string): string {
  // Parse as local date so the displayed day never shifts by timezone.
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** The full sentiment brief: findings lede, ledger, themes, recommendations. */
export function ResultsView({ result }: ResultsViewProps) {
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
          <SentimentColumn tone="praise" title="What they praise" items={result.loves} />
          <SentimentColumn tone="fault" title="What they fault" items={result.dislikes} />
        </div>
      </div>

      {/* Recurring themes — labels with monospace mention counts. */}
      <div>
        <SectionLabel>Recurring themes</SectionLabel>
        {result.themes.length === 0 ? (
          <p className="text-sm text-ink-soft">No recurring themes surfaced in this range.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {result.themes.map((theme) => (
              <li
                key={theme.label}
                className="flex items-baseline gap-2 border border-rule bg-card px-3 py-1.5"
              >
                <span className="text-sm text-ink">{theme.label}</span>
                <span className="font-mono text-xs text-ink-soft" aria-label={`${theme.mentions} mentions`}>
                  {theme.mentions}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Recommendations — an ordered list where position signals priority. */}
      <div>
        <SectionLabel>Recommended actions</SectionLabel>
        <ol className="border-y border-rule">
          {result.recommendations.map((rec, i) => (
            <li
              key={i}
              className="flex gap-4 border-b border-rule py-3 last:border-b-0"
            >
              <span className="font-mono text-sm tabular-nums text-ink-soft" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="text-sm leading-relaxed text-ink">{rec}</span>
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}
