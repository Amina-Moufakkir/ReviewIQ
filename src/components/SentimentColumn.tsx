import type { Finding } from "../types";

interface SentimentColumnProps {
  tone: "praise" | "fault";
  title: string;
  findings: Finding[];
  /** Total matched reviews, for the "X of N reviews" evidence line. */
  reviewCount: number;
}

/** One side of the balance-of-opinion ledger: evidence-backed findings. */
export function SentimentColumn({ tone, title, findings, reviewCount }: SentimentColumnProps) {
  const isPraise = tone === "praise";
  const accent = isPraise ? "text-praise" : "text-fault";
  const topBorder = isPraise ? "border-t-praise" : "border-t-fault";

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
          No {isPraise ? "positive" : "negative"} themes have enough evidence in this window.
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
              <p className="font-mono text-[11px] text-ink-soft">
                Mentioned in {f.mentions} of {reviewCount} selected review
                {reviewCount === 1 ? "" : "s"} · {f.percent}%
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
