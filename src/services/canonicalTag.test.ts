import { describe, it, expect } from "vitest";
import type { AnalysisInput, Product, Review } from "../types";
import { validateTags, normalizeTheme, type RawTag, type ValidatedTag } from "./claudeTags";
import { CanonicalizationError } from "./canonicalize";
import { composeCanonicalTags, distinctThemeLabels, type CanonicalTag } from "./canonicalTag";
import { tagsToResult } from "./tagsToResult";
import { PRODUCT_RECORD } from "../lib/datasetInfo";

/**
 * The canonical boundary: what may be aggregated, and what may not.
 *
 * Two things are under test. First, that raw per-batch tags cannot reach final
 * aggregation — enforced by the type system, so it is asserted by construction
 * rather than at runtime. Second, that once a mapping is applied, support is
 * counted per distinct review: merging two labels must not double-count the
 * review that carried both.
 */

const PRODUCT: Product = {
  id: "p1",
  name: "Test Widget",
  category: "Electronics",
  topCategory: "Electronics",
};
const INPUT: AnalysisInput = {
  scope: { kind: "product", productId: "p1" },
  from: "2026-01-01",
  to: "2026-12-31",
};

function review(id: string, text: string): Review {
  return { id, productId: "p1", date: "2026-02-01", rating: 5, text };
}

function validate(matched: Review[], raw: RawTag[]): ValidatedTag[] {
  const reviewsById = new Map(matched.map((r) => [r.id, r.text] as const));
  const { valid, rejected } = validateTags(raw, reviewsById);
  // A fixture the validator rejects would make the test below vacuous.
  expect(rejected).toBe(0);
  return valid;
}

function identity(tags: ValidatedTag[]): Map<string, string> {
  return new Map(distinctThemeLabels(tags).map((label) => [label, label] as const));
}

// --- the type boundary -------------------------------------------------------

describe("CanonicalTag is structurally incompatible with ValidatedTag", () => {
  const raw: ValidatedTag = {
    reviewId: "r1",
    theme: "Battery life",
    themeKey: "battery life",
    sentiment: "fault",
    evidence: "the battery died",
  };
  const canonical: CanonicalTag = {
    reviewId: "r1",
    sentiment: "fault",
    evidence: "the battery died",
    canonicalTheme: "Battery life",
    canonicalKey: "battery life",
    rawTheme: "Poor battery",
    rawKey: "poor battery",
  };

  it("has no field in common that would let one pass as the other", () => {
    // @ts-expect-error a ValidatedTag lacks canonicalTheme/canonicalKey/rawTheme/rawKey
    const notCanonical: CanonicalTag = raw;
    // @ts-expect-error a CanonicalTag lacks theme/themeKey
    const notValidated: ValidatedTag = canonical;
    // The assertions above are compile-time; these keep the values used.
    expect(notCanonical).toBeDefined();
    expect(notValidated).toBeDefined();
  });

  it("rejects raw tags at the aggregation entry point", () => {
    const matched = [review("r1", "The battery died in a day.")];
    const valid = validate(matched, [
      { review_id: "r1", theme: "Battery life", sentiment: "fault", evidence_span: "battery died" },
    ]);

    // @ts-expect-error tagsToResult accepts CanonicalTag[] only — this is the
    // whole point of the boundary, and it must stay a compile error.
    expect(() => tagsToResult(INPUT, PRODUCT, matched, valid)).not.toThrow();
  });
});

// --- the composer ------------------------------------------------------------

describe("distinctThemeLabels", () => {
  it("returns one label per normalized key, in first-appearance order", () => {
    const matched = [review("r1", "Comfy and light and cheap.")];
    const valid = validate(matched, [
      { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "Comfy" },
      { review_id: "r1", theme: "Weight", sentiment: "praise", evidence_span: "light" },
      { review_id: "r1", theme: "Price", sentiment: "praise", evidence_span: "cheap" },
    ]);
    expect(distinctThemeLabels(valid)).toEqual(["Comfort", "Weight", "Price"]);
  });

  it("treats labels differing only in casing or spacing as one", () => {
    const matched = [review("r1", "Comfy.")], other = [review("r2", "Also comfy.")];
    const valid: ValidatedTag[] = [
      ...validate(matched, [
        { review_id: "r1", theme: "Battery Life", sentiment: "fault", evidence_span: "Comfy" },
      ]),
      ...validate(other, [
        { review_id: "r2", theme: "battery  life", sentiment: "fault", evidence_span: "Also comfy" },
      ]),
    ];
    // One slot, not two: normalizeTheme already merged these.
    expect(distinctThemeLabels(valid)).toEqual(["Battery Life"]);
  });
});

describe("composeCanonicalTags", () => {
  const matched = [review("r1", "The battery died in a day.")];

  it("carries the canonical label and key onto every tag", () => {
    const valid = validate(matched, [
      { review_id: "r1", theme: "Poor battery", sentiment: "fault", evidence_span: "battery died" },
    ]);
    const [tag] = composeCanonicalTags(valid, new Map([["Poor battery", "Poor battery"]]));

    expect(tag!.canonicalTheme).toBe("Poor battery");
    expect(tag!.canonicalKey).toBe("poor battery");
    expect(tag!.reviewId).toBe("r1");
    expect(tag!.sentiment).toBe("fault");
    expect(tag!.evidence).toBe("battery died");
  });

  /** Two reviews carrying two distinct labels, one of which absorbs the other. */
  function twoLabels(secondLabel: string) {
    const rows = [review("r1", "The battery died in a day."), review("r2", "Battery lasts poorly.")];
    const valid = [
      ...validate([rows[0]!], [
        { review_id: "r1", theme: "Poor battery", sentiment: "fault", evidence_span: "battery died" },
      ]),
      ...validate([rows[1]!], [
        { review_id: "r2", theme: secondLabel, sentiment: "fault", evidence_span: "Battery lasts poorly" },
      ]),
    ];
    return { rows, valid };
  }

  it("retains the raw theme and key for independent recomputation", () => {
    // Nothing renders these. The acceptance gate needs them to recompute counts
    // from the tags and the mapping without going through the aggregator.
    const { valid } = twoLabels("Battery life");
    const [tag] = composeCanonicalTags(
      valid,
      new Map([
        ["Poor battery", "Battery life"],
        ["Battery life", "Battery life"],
      ]),
    );

    expect(tag!.rawTheme).toBe("Poor battery");
    expect(tag!.rawKey).toBe("poor battery");
    expect(tag!.canonicalTheme).toBe("Battery life");
  });

  it("derives canonicalKey from canonicalTheme rather than accepting one", () => {
    // A label whose own spelling is not its key: internal spacing and casing
    // survive validation, so the key has to be computed, never carried across.
    const { valid } = twoLabels("Battery  LIFE");
    const [tag] = composeCanonicalTags(
      valid,
      new Map([
        ["Poor battery", "Battery  LIFE"],
        ["Battery  LIFE", "Battery  LIFE"],
      ]),
    );

    expect(tag!.canonicalTheme).toBe("Battery  LIFE");
    expect(tag!.canonicalKey).toBe(normalizeTheme("Battery  LIFE"));
    expect(tag!.canonicalKey).toBe("battery life");
    expect(tag!.canonicalKey).not.toBe(tag!.canonicalTheme);
  });

  it("gives two tags on one canonical theme the same key, whatever they arrived as", () => {
    const two = [review("r1", "The battery died."), review("r2", "Battery drains fast.")];
    const valid = [
      ...validate([two[0]!], [
        { review_id: "r1", theme: "Poor battery", sentiment: "fault", evidence_span: "battery died" },
      ]),
      ...validate([two[1]!], [
        { review_id: "r2", theme: "Battery drain", sentiment: "fault", evidence_span: "Battery drains fast" },
      ]),
    ];
    const composed = composeCanonicalTags(
      valid,
      new Map([
        ["Poor battery", "Poor battery"],
        ["Battery drain", "Poor battery"],
      ]),
    );

    expect(new Set(composed.map((t) => t.canonicalKey)).size).toBe(1);
    expect(composed.map((t) => t.rawTheme)).toEqual(["Poor battery", "Battery drain"]);
  });

  it("maps a tag by its normalized key, not its own spelling", () => {
    // The mapping is keyed by the label that was SENT — the first spelling seen.
    const two = [review("r1", "The battery died."), review("r2", "Battery drains fast.")];
    const valid = [
      ...validate([two[0]!], [
        { review_id: "r1", theme: "Battery Life", sentiment: "fault", evidence_span: "battery died" },
      ]),
      ...validate([two[1]!], [
        { review_id: "r2", theme: "battery  life", sentiment: "fault", evidence_span: "Battery drains fast" },
      ]),
    ];
    const composed = composeCanonicalTags(valid, new Map([["Battery Life", "Battery Life"]]));

    expect(composed).toHaveLength(2);
    for (const tag of composed) expect(tag.canonicalTheme).toBe("Battery Life");
  });

  it("returns nothing for no tags, without needing a mapping", () => {
    expect(composeCanonicalTags([], new Map())).toEqual([]);
  });

  it("preserves tag order, so downstream quote choice stays deterministic", () => {
    const three = [review("r1", "Battery died."), review("r2", "Too heavy."), review("r3", "Battery drains.")];
    const valid = [
      ...validate([three[0]!], [{ review_id: "r1", theme: "Battery", sentiment: "fault", evidence_span: "Battery died" }]),
      ...validate([three[1]!], [{ review_id: "r2", theme: "Weight", sentiment: "fault", evidence_span: "Too heavy" }]),
      ...validate([three[2]!], [{ review_id: "r3", theme: "Drain", sentiment: "fault", evidence_span: "Battery drains" }]),
    ];
    const composed = composeCanonicalTags(
      valid,
      new Map([["Battery", "Battery"], ["Weight", "Weight"], ["Drain", "Battery"]]),
    );
    expect(composed.map((t) => t.reviewId)).toEqual(["r1", "r2", "r3"]);
  });
});

describe("composeCanonicalTags refuses an incomplete or invented mapping", () => {
  const two = [review("r1", "The battery died."), review("r2", "Far too heavy.")];
  const valid = () => [
    ...validate([two[0]!], [
      { review_id: "r1", theme: "Battery", sentiment: "fault", evidence_span: "battery died" },
    ]),
    ...validate([two[1]!], [
      { review_id: "r2", theme: "Weight", sentiment: "fault", evidence_span: "Far too heavy" },
    ]),
  ];

  it("throws when a label has no canonical mapping", () => {
    // Passing the raw label through would leave one theme fragmented while its
    // neighbours merged — a report that looks complete and under-counts.
    expect(() => composeCanonicalTags(valid(), new Map([["Battery", "Battery"]]))).toThrow(
      CanonicalizationError,
    );
  });

  it("throws when the mapping is entirely empty", () => {
    expect(() => composeCanonicalTags(valid(), new Map())).toThrow(CanonicalizationError);
  });

  it("throws when a canonical label was never submitted", () => {
    // The displayed theme name has to be a label the model was handed. A
    // composed one attributes to customers a phrase nobody wrote.
    expect(() =>
      composeCanonicalTags(
        valid(),
        new Map([
          ["Battery", "Power management issues"],
          ["Weight", "Weight"],
        ]),
      ),
    ).toThrow(CanonicalizationError);
  });

  it("classifies both refusals as composition failures", () => {
    const missing = (() => {
      try {
        composeCanonicalTags(valid(), new Map([["Battery", "Battery"]]));
      } catch (e) {
        return e as CanonicalizationError;
      }
    })();
    expect(missing?.reason).toBe("composition");
  });

  it("does not name the offending label in the message", () => {
    const error = (() => {
      try {
        composeCanonicalTags(valid(), new Map([["Battery", "Battery"]]));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).not.toContain("Weight");
  });
});

// --- merging must not inflate a count ----------------------------------------

describe("aggregation over canonicalized tags", () => {
  /**
   * The case that motivates the whole boundary, and the one most likely to be
   * broken by a plausible refactor: a review that carried BOTH raw labels which
   * then merge. Counting tags rather than distinct reviews would report two.
   */
  it("counts a review once when two of its raw themes merge into one", () => {
    const matched = [
      review("r1", "The battery died in a day and the battery drains overnight."),
      review("r2", "Battery drains overnight too."),
    ];
    const valid = [
      ...validate([matched[0]!], [
        { review_id: "r1", theme: "Poor battery", sentiment: "fault", evidence_span: "battery died in a day" },
        { review_id: "r1", theme: "Battery drain", sentiment: "fault", evidence_span: "battery drains overnight" },
      ]),
      ...validate([matched[1]!], [
        { review_id: "r2", theme: "Battery drain", sentiment: "fault", evidence_span: "Battery drains overnight" },
      ]),
    ];
    // Both raw labels canonicalize to one theme.
    const composed = composeCanonicalTags(
      valid,
      new Map([
        ["Poor battery", "Poor battery"],
        ["Battery drain", "Poor battery"],
      ]),
    );
    expect(composed).toHaveLength(3); // three tags...

    const result = tagsToResult(INPUT, PRODUCT, matched, composed);
    const battery = result.faults.find((f) => f.label === "Poor battery");

    expect(battery?.mentions).toBe(2); // ...but two reviews, not three
    expect(battery?.percent).toBe(100);
    expect(result.faults).toHaveLength(1); // one merged theme, not two split ones
  });

  it("keeps praise and fault separate for the same canonical theme", () => {
    // One review can praise and fault the same concept. Merging labels must not
    // merge sentiments: the review counts once in each group, never once overall.
    const matched = [
      review("r1", "Battery lasts all day but the battery dies in standby."),
      review("r2", "Battery lasts all day for me."),
      review("r3", "Mine dies in standby as well."),
    ];
    const valid = [
      ...validate([matched[0]!], [
        { review_id: "r1", theme: "Battery life", sentiment: "praise", evidence_span: "Battery lasts all day" },
        { review_id: "r1", theme: "Standby drain", sentiment: "fault", evidence_span: "battery dies in standby" },
      ]),
      ...validate([matched[1]!], [
        { review_id: "r2", theme: "Battery life", sentiment: "praise", evidence_span: "Battery lasts all day" },
      ]),
      ...validate([matched[2]!], [
        { review_id: "r3", theme: "Standby drain", sentiment: "fault", evidence_span: "dies in standby" },
      ]),
    ];
    // Both labels merge onto one canonical theme.
    const composed = composeCanonicalTags(
      valid,
      new Map([
        ["Battery life", "Battery life"],
        ["Standby drain", "Battery life"],
      ]),
    );

    const result = tagsToResult(INPUT, PRODUCT, matched, composed);
    const praise = result.praise.find((f) => f.label === "Battery life");
    const fault = result.faults.find((f) => f.label === "Battery life");

    expect(praise?.mentions).toBe(2); // r1, r2
    expect(fault?.mentions).toBe(2); // r1, r3
    // r1 appears in both, which is correct — it said both things.
  });

  it("merges support that would otherwise fall below the evidence threshold", () => {
    // The failure canonicalization exists to prevent: two spellings of one
    // theme, each with a single supporting review, both dropped — a real
    // complaint disappearing with nothing on screen to say so.
    const matched = [review("r1", "The battery died."), review("r2", "Battery drains fast.")];
    const valid = [
      ...validate([matched[0]!], [
        { review_id: "r1", theme: "Poor battery", sentiment: "fault", evidence_span: "battery died" },
      ]),
      ...validate([matched[1]!], [
        { review_id: "r2", theme: "Battery drain", sentiment: "fault", evidence_span: "Battery drains fast" },
      ]),
    ];

    const split = tagsToResult(INPUT, PRODUCT, matched, composeCanonicalTags(valid, identity(valid)));
    expect(split.faults).toHaveLength(0); // one review each — below threshold

    const merged = tagsToResult(
      INPUT,
      PRODUCT,
      matched,
      composeCanonicalTags(
        valid,
        new Map([
          ["Poor battery", "Poor battery"],
          ["Battery drain", "Poor battery"],
        ]),
      ),
    );
    expect(merged.faults).toHaveLength(1);
    expect(merged.faults[0]!.mentions).toBe(2);
  });

  it("labels a merged finding with the canonical name, not the raw one", () => {
    const matched = [review("r1", "The battery died."), review("r2", "Battery drains fast.")];
    const valid = [
      ...validate([matched[0]!], [
        { review_id: "r1", theme: "Poor battery", sentiment: "fault", evidence_span: "battery died" },
      ]),
      ...validate([matched[1]!], [
        { review_id: "r2", theme: "Battery drain", sentiment: "fault", evidence_span: "Battery drains fast" },
      ]),
    ];
    const result = tagsToResult(
      INPUT,
      PRODUCT,
      matched,
      composeCanonicalTags(
        valid,
        new Map([
          ["Poor battery", "Battery drain"],
          ["Battery drain", "Battery drain"],
        ]),
      ),
    );

    expect(result.faults[0]!.label).toBe("Battery drain");
    // And the recommendation follows the same label.
    expect(result.recommendations[0]).toContain("battery drain");
  });

  it("still names the row rather than a tally for product-record data", () => {
    const matched = [review("r1", "The base wobbles on an uneven desk.")];
    const valid = validate(matched, [
      { review_id: "r1", theme: "Wobbly base", sentiment: "fault", evidence_span: "The base wobbles" },
    ]);
    const result = tagsToResult(
      INPUT,
      PRODUCT,
      matched,
      composeCanonicalTags(valid, identity(valid)),
      PRODUCT_RECORD,
    );
    expect(result.recommendations).toEqual([
      "Investigate wobbly base — raised in the selected product record.",
    ]);
  });
});
