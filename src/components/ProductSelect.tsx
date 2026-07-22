import type { Product } from "../types";

interface ProductSelectProps {
  products: Product[];
  value: string;
  onChange: (productId: string) => void;
  disabled?: boolean;
}

/** Accessible native product picker. */
export function ProductSelect({ products, value, onChange, disabled }: ProductSelectProps) {
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="product"
        className="font-mono text-xs font-medium uppercase tracking-[0.15em] text-ink-soft"
      >
        Product
      </label>
      <select
        id="product"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-sm border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none transition focus:border-ink focus:ring-1 focus:ring-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.category}
          </option>
        ))}
      </select>
    </div>
  );
}
