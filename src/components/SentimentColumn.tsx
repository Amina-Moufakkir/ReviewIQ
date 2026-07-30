import type { Finding } from "../types";
import { pluralize, scopeLabel, type DatasetUnit } from "../lib/datasetInfo";

interface SentimentColumnProps {
  tone: "praise" | "fault";
  title: string;
  findings: Finding[];
  /** Total matched rows, for the "X of N selected" evidence line. */
  reviewCount: number;
  /** What one analyzed row is — a review, or a product record. */
  unit: DatasetUnit;
  /** Whether the analyzed dataset carried per-review dates. */
  hasDates: boolean;
  /** Where the sentiment in `findings` came from — the text, or the star rating. */
  sentimentSource: "text" | "rating";
}

/** One side of the balance-of-opinion ledger: evidence-backed findings. */
export function SentimentColumn({
  tone,
  title,
  findings,
  reviewCount,
  unit,
  hasDates,
  sentimentSource,
}: SentimentColumnProps) {
  const isPraise = tone === "praise";
  const accent = isPraise ? "text-praise" : "text-fault";
  const topBorder = isPraise ? "border-t-praise" : "border-t-fault";
  // Rating-derived sentiment over product-level rows cannot see what customers
  // wrote: the star value is an average over thousands of them, so a complaint
  // inside a 4-star record never reaches this column. An empty column there is a
  // statement about the ENGINE, not a finding about the product — say so, rather
  // than let silence read as "no complaints".
  const ratingBlind = sentimentSource === "rating" && unit.isProductLevel;

  return (
    <section className={`border-t-2 ${topBorder} bg-card p-5`}>
      <h3 className="mb-4 flex items-baseline gap-2">
        <span className={`font-mono text-xs font-medium uppercase tracking-[0.15em] ${accent}`}>
          {title}
        </span>
        <span className="font-mono text-xs text-ink-soft" aria-hidden="true">
          {findings.length}
        </span>
      </h3>

      {findings.length === 0 ? (
        <p className="text-sm text-ink-soft">
          {ratingBlind ? (
            <>
              Nothing surfaced — but this engine infers sentiment from the averaged product
              rating, not from the review text, so {isPraise ? "praise" : "complaints"} written
              inside these records cannot reach this column. Read that as a limit of the engine,
              not as evidence there {isPraise ? "is none" : "are none"}.
            </>
          ) : (
            <>
              No {isPraise ? "positive" : "negative"} themes have enough evidence{" "}
              {scopeLabel(unit, hasDates)}.
            </>
          )}
        </p>
      ) : (
        <ul className="flex flex-col gap-5">
          {findings.map((f) => (
            <li key={f.label} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <span className={`font-mono ${accent}`} aria-hidden="true">
                  {isPraise ? "+" : "–"}
                </span>
                <span className="text-sm font-medium text-ink">{f.label}</span>
              </div>
              {/* "1 of 1 · 100%" is arithmetically true and reads as unanimity,
                  so a lone row states where the theme was found instead. */}
              <p className="font-mono text-[11px] text-ink-soft">
                {reviewCount === 1 ? (
                  <>Mentioned in the selected {unit.one}</>
                ) : (
                  <>
                    Mentioned in {f.mentions} of {reviewCount} selected{" "}
                    {pluralize(reviewCount, unit)} · {f.percent}%
                  </>
                )}
              </p>
              <blockquote className="border-l border-rule pl-3">
                <p className="text-sm italic leading-relaxed text-ink">“{f.quote}”</p>
                <cite className="mt-1 block font-mono text-[11px] not-italic text-ink-soft">
                  — {f.quoteAuthor}
                </cite>
              </blockquote>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
