interface SentimentColumnProps {
  tone: "praise" | "fault";
  title: string;
  items: string[];
}

/** One side of the balance-of-opinion ledger: praise or faults. */
export function SentimentColumn({ tone, title, items }: SentimentColumnProps) {
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
          {items.length}
        </span>
      </h3>
      <ul className="flex flex-col gap-3">
        {items.map((item, i) => (
          <li key={i} className="flex gap-3 text-sm leading-relaxed text-ink">
            <span className={`font-mono ${accent}`} aria-hidden="true">
              {isPraise ? "+" : "–"}
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
