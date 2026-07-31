import { formatCount, type CategorySummary, type DatasetUnit } from "../lib/datasetInfo";

interface CategorySelectProps {
  categories: CategorySummary[];
  value: string;
  unit: DatasetUnit;
  onChange: (category: string) => void;
  disabled?: boolean;
}

/**
 * Accessible native category picker, mirroring ProductSelect.
 *
 * Each option carries its size in the dataset's own noun — "Electronics · 526
 * product records · 490 products". The row count is the number the analyst
 * needs: it is what the engine will read, and under the Claude engine it is
 * what decides whether the category exceeds the per-request cap.
 */
export function CategorySelect({
  categories,
  value,
  unit,
  onChange,
  disabled,
}: CategorySelectProps) {
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="category"
        className="font-mono text-xs font-medium uppercase tracking-[0.15em] text-ink-soft"
      >
        Category
      </label>
      <select
        id="category"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-sm border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none transition focus:border-ink focus:ring-1 focus:ring-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        {categories.map((c) => (
          <option key={c.category} value={c.category}>
            {c.category} · {formatCount(c.rowCount, unit)} · {c.productCount}{" "}
            {c.productCount === 1 ? "product" : "products"}
          </option>
        ))}
      </select>
    </div>
  );
}
