import type { PromotionInsight } from "../types";
import { SectionLabel } from "./SectionLabel";

interface PromotionPanelProps {
  insight: PromotionInsight;
}

/** One rating stat block (promoted vs full-price), mirroring the ledger cards. */
function StatCard({ label, count, average }: { label: string; count: number; average: number }) {
  return (
    <div className="border border-rule bg-card p-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-soft">{label}</p>
      <p className="mt-2 font-display text-2xl font-medium text-ink">
        {count === 0 ? "—" : `${average.toFixed(1)}★`}
      </p>
      <p className="font-mono text-[11px] text-ink-soft">
        {count} review{count === 1 ? "" : "s"}
      </p>
    </div>
  );
}

/**
 * Discounts & promotions section: how promoted purchases compare with
 * full-price ones on average rating. Rendered only when the analysis produced a
 * PromotionInsight (i.e. the dataset carries promotion data), so datasets
 * without it simply omit this section.
 */
export function PromotionPanel({ insight }: PromotionPanelProps) {
  const { promoCount, fullPriceCount, promoAverageRating, fullPriceAverageRating, ratingDelta, promotions, comparable, note } =
    insight;

  // Colour the delta by direction: higher = praise, lower = fault, flat = soft.
  const deltaTone =
    !comparable || Math.abs(ratingDelta) < 0.1
      ? "text-ink-soft"
      : ratingDelta > 0
        ? "text-praise"
        : "text-fault";
  const deltaLabel = ratingDelta > 0 ? `+${ratingDelta.toFixed(1)}` : ratingDelta.toFixed(1);

  return (
    <div>
      <SectionLabel>Discounts &amp; promotions</SectionLabel>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Promoted purchases" count={promoCount} average={promoAverageRating} />
        <StatCard label="Full price" count={fullPriceCount} average={fullPriceAverageRating} />
      </div>

      <p className="mt-4 text-sm leading-relaxed text-ink">
        {note}
        {comparable ? (
          <span className={`ml-2 font-mono text-[11px] font-medium ${deltaTone}`}>
            ({deltaLabel}★)
          </span>
        ) : null}
      </p>

      {promotions.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-soft">
            Promotions seen
          </p>
          <ul className="flex flex-wrap gap-2">
            {promotions.map((promo) => (
              <li
                key={promo}
                className="border border-rule bg-card px-3 py-1.5 text-sm text-ink"
              >
                {promo}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
