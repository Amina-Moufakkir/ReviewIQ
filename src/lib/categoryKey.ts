/**
 * How a category string is split, in one place, for every data model.
 *
 * The two sources spell categories differently. Amazon ships a pipe hierarchy
 * (`Home&Kitchen|HomeDecor|Lighting`); sample and uploaded review CSVs ship a
 * flat value (`Electronics`). Rather than branch on the source, both go through
 * the same split: a flat value is simply a hierarchy of length one, so its
 * top level and its leaf are both itself.
 *
 * That matters because the two ends of the path answer different questions:
 *   - the LEAF is what a product IS, and is what the picker shows;
 *   - the TOP LEVEL is what a product BELONGS TO, and is the grouping key for
 *     category-scope analysis.
 * On the real dataset the difference is decisive — 207 distinct leaves versus
 * 9 top-level categories. Grouping on leaves would produce mostly groups of one.
 *
 * These are the only two readings of a category string in the app. Both are
 * applied once, in `buildDataset`, so `Product.category` and
 * `Product.topCategory` are settled at load time and nothing downstream re-parses.
 */

/** Split a category cell into its trimmed, non-empty segments, outermost first. */
function segments(value: string): string[] {
  return value
    .split("|")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/**
 * The grouping key: the outermost segment.
 *
 * `"Home&Kitchen|HomeDecor|Lighting"` → `"Home&Kitchen"`
 * `"Electronics"` → `"Electronics"` (flat data is already top level)
 * `""` / `"|"` / `"   "` → `""` (no key; such a row groups under nothing)
 */
export function topLevelCategory(value: string): string {
  return segments(value)[0] ?? "";
}

/**
 * What the product is, for display: the innermost segment.
 *
 * `"Home&Kitchen|HomeDecor|Lighting"` → `"Lighting"`
 * `"Electronics"` → `"Electronics"`
 */
export function leafCategory(value: string): string {
  const parts = segments(value);
  return parts[parts.length - 1] ?? "";
}
