import { normalizeTheme, type TagSentiment, type ValidatedTag } from "./claudeTags";
import { CanonicalizationError } from "./canonicalize";

/**
 * The boundary between a raw per-batch tag and one that may be aggregated.
 *
 * Batches are tagged independently, so a `ValidatedTag`'s theme is whatever that
 * batch happened to call it: batch 3's "battery life" and batch 47's "poor
 * battery" are the same concept wearing two labels. Aggregating those directly
 * splits one theme's support in two and under-counts both — a finding can fall
 * below the evidence threshold and vanish with nothing on screen to say so.
 *
 * That mistake is easy to make and impossible to see in a diff, because a raw
 * tag has everything the aggregator needs to *run*. So the two shapes are made
 * structurally incompatible rather than merely documented as different:
 *
 *   ValidatedTag { reviewId, theme, themeKey, sentiment, evidence }
 *   CanonicalTag { reviewId, canonicalTheme, canonicalKey, rawTheme, rawKey, ... }
 *
 * Neither is assignable to the other in either direction — `ValidatedTag` has no
 * `canonicalTheme`, `CanonicalTag` has no `theme` — so passing raw tags into
 * final aggregation is a type error, not a silent under-count. A phantom brand
 * would not do this job: it erases at runtime and a single `as` casts it away.
 */
export interface CanonicalTag {
  reviewId: string;
  sentiment: TagSentiment;
  evidence: string;
  /**
   * Display label for the theme this tag belongs to after canonicalization.
   * Always one of the labels canonicalization was given — never a string
   * composed for the occasion.
   */
  canonicalTheme: string;
  /** Grouping key, derived from `canonicalTheme` by the same rule as `themeKey`. */
  canonicalKey: string;
  /**
   * The label this tag arrived with, retained deliberately.
   *
   * Nothing in the report renders it. It exists so the acceptance gate can
   * recompute every displayed count from raw tags and the canonical mapping
   * without going through the aggregator — an independent recomputation needs
   * the input the aggregator started from, not the output it produced.
   */
  rawTheme: string;
  rawKey: string;
}

/**
 * The distinct theme labels to submit for canonicalization.
 *
 * One label per normalized key, rendered with the first spelling seen for it, in
 * first-appearance order. Tags differing only in casing or spacing are one
 * label: sending "Battery Life" and "battery life" separately would spend a slot
 * asking the model to merge something `normalizeTheme` already merged.
 */
export function distinctThemeLabels(tags: readonly ValidatedTag[]): string[] {
  return [...representativeSpellings(tags).values()];
}

/**
 * Apply a canonical mapping to every tag, producing tags fit for aggregation.
 *
 * Total by construction and checked, not assumed. Two ways this could quietly
 * corrupt a report, both refused here:
 *
 *  - **A missing mapping.** Skipping the tag would drop real evidence; passing
 *    the raw label through would leave one theme fragmented while its neighbours
 *    merged. Either way the report looks complete and under-counts, so an
 *    incomplete mapping fails the run instead.
 *  - **A canonical label that was never offered.** The displayed theme name must
 *    be a label the model was handed, not one it composed — otherwise the report
 *    attributes to customers a phrase none of them, and nothing upstream, wrote.
 *
 * `canonicalize.ts` already guarantees both through `validateGrouping` and
 * `applyGrouping`. This is the second gate: the same two-gate arrangement used
 * between the endpoint and the client, for the same reason — the cost of a
 * silent breach here is a number an analyst would act on.
 */
export function composeCanonicalTags(
  tags: readonly ValidatedTag[],
  mapping: ReadonlyMap<string, string>,
): CanonicalTag[] {
  const spellings = representativeSpellings(tags);
  const offered = new Set(spellings.values());

  return tags.map((tag, index) => {
    // Look up by normalized key, not by the tag's own spelling: the mapping is
    // keyed by the labels that were SENT, one per key.
    const sent = spellings.get(tag.themeKey);
    const canonicalTheme = sent === undefined ? undefined : mapping.get(sent);
    if (canonicalTheme === undefined) {
      throw new CanonicalizationError(
        "composition",
        `Tag ${index} has no canonical mapping for its theme.`,
      );
    }
    if (!offered.has(canonicalTheme)) {
      throw new CanonicalizationError(
        "composition",
        `Tag ${index} was mapped to a label that was never submitted for canonicalization.`,
      );
    }
    return {
      reviewId: tag.reviewId,
      sentiment: tag.sentiment,
      evidence: tag.evidence,
      canonicalTheme,
      // Derived, never supplied: one label always yields one key, so two tags
      // on the same canonical theme cannot land in different groups.
      canonicalKey: normalizeTheme(canonicalTheme),
      rawTheme: tag.theme,
      rawKey: tag.themeKey,
    };
  });
}

/** Normalized key → the first spelling seen for it, in first-appearance order. */
function representativeSpellings(tags: readonly ValidatedTag[]): Map<string, string> {
  const spellings = new Map<string, string>();
  for (const tag of tags) {
    if (!spellings.has(tag.themeKey)) spellings.set(tag.themeKey, tag.theme);
  }
  return spellings;
}
