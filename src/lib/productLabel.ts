/**
 * Shorten a marketplace product title for display in a picker.
 *
 * PRESENTATION ONLY. The dataset, `Product.name` and every other surface keep
 * the original title verbatim — the Findings header, the Markdown report and
 * the analysis all still show it in full. This exists solely so a dropdown of
 * Amazon titles (median 127 characters, up to 485) can be scanned.
 *
 * Amazon titles share a shape: brand + model + product type, then spec and
 * compatibility clauses introduced by a small set of separators. Cutting at the
 * first of those beats truncating at a fixed length, because it ends on a
 * meaningful phrase rather than mid-word. Truncation is the fallback, not the
 * strategy.
 */

/** Titles at or below this length are already scannable and pass through. */
const MAX_LABEL = 64;

/**
 * A cut must leave at least this much of the title. Without it, an early
 * separator swallows the product: "Amazon Brand - Solimo 65W…" would become
 * "Amazon Brand", and "Tecno Spark 9 (Sky Mirror…" just "Tecno Spark 9".
 */
const MIN_LABEL = 28;

/**
 * Where a spec or compatibility clause typically begins. Ordered alternation
 * does not matter — the regex is scanned for the earliest match position.
 */
const CLAUSE_START = /,|\s*\||\s*\(|\s+[-–—]\s+|\s+with\s+|\s+for\s+/gi;

/** Trailing punctuation left behind by a cut. */
const TRAILING_PUNCTUATION = /[\s,\-–—|]+$/;

/**
 * A concise label for `name`, or `name` itself when it is already short.
 * Deterministic and dependent only on the single title, so the same product
 * always renders the same way.
 */
export function shortProductLabel(name: string): string {
  const full = name.replace(/\s+/g, " ").trim();
  if (full.length <= MAX_LABEL) return full;

  const depth = parenDepths(full);
  CLAUSE_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLAUSE_START.exec(full)) !== null) {
    // Never cut inside a parenthetical: "(Light Blue, 2GB RAM)" holds commas,
    // and stopping at one of them would leave an unbalanced fragment.
    if (depth[match.index] !== 0) continue;

    const head = trimEnd(full.slice(0, match.index));
    if (head.length >= MIN_LABEL) return truncate(head);
  }

  // No separator left enough of the title — e.g. a run-on all-caps title.
  return truncate(full);
}

/** Nesting depth at each character; an opening "(" reads as still outside. */
function parenDepths(text: string): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const char of text) {
    if (char === "(") {
      depths.push(depth);
      depth++;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
      depths.push(depth);
    } else {
      depths.push(depth);
    }
  }
  return depths;
}

function trimEnd(text: string): string {
  return text.replace(TRAILING_PUNCTUATION, "").trim();
}

/** Clip to MAX_LABEL on a word boundary, marking the cut with an ellipsis. */
function truncate(text: string): string {
  if (text.length <= MAX_LABEL) return text;
  const clipped = text.slice(0, MAX_LABEL - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${trimEnd(lastSpace > MIN_LABEL ? clipped.slice(0, lastSpace) : clipped)}…`;
}
