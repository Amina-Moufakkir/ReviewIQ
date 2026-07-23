/**
 * Deterministic, case-insensitive keyword matching for theme detection.
 *
 * A single-word keyword matches only as a whole word, so "clean" matches
 * "easy to clean" but not "cleaner teeth" or "cleaning". A multi-word phrase
 * is matched literally with the same boundaries at its ends, so "build quality"
 * matches "the build quality feels sturdy" but not "hard to build".
 *
 * Boundaries treat letters and digits as word characters (not underscore),
 * which keeps hyphenated keywords like "well-made" and "noise-canceling"
 * behaving predictably. Implemented without lookbehind (a leading boundary
 * group + negative lookahead) for broad browser support. No stemming, fuzzy
 * matching, or external deps. Regex metacharacters in keywords are escaped.
 */

const cache = new Map<string, RegExp>();

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toRegex(keyword: string): RegExp {
  const cached = cache.get(keyword);
  if (cached) return cached;
  const normalized = keyword.trim().toLowerCase();
  // Preceded by start-of-string or a non-alphanumeric char, and not followed
  // by an alphanumeric char. Under the "i" flag, [^a-z0-9] also excludes A–Z,
  // so uppercase neighbors count as word characters too.
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(normalized)}(?![a-z0-9])`, "i");
  cache.set(keyword, re);
  return re;
}

/** True when `text` contains `keyword` as a whole word / bounded phrase. */
export function matchesKeyword(text: string, keyword: string): boolean {
  if (!keyword.trim()) return false;
  return toRegex(keyword).test(text);
}
