import { describe, it, expect } from "vitest";
import {
  normalizeTheme,
  parseTagArray,
  stripCodeFence,
  validateModelResponse,
  validateTags,
} from "./claudeTags";

// Two reviews with distinct text so we can test per-review evidence grounding.
const REVIEWS = new Map<string, string>([
  ["r1", "The battery lasts for days and the sound is crisp."],
  ["r2", "Connection keeps dropping on calls."],
]);

function tag(overrides: Record<string, unknown> = {}) {
  return {
    review_id: "r1",
    theme: "Battery life",
    sentiment: "praise",
    evidence_span: "battery lasts for days",
    ...overrides,
  };
}

describe("validateTags — rejection rules", () => {
  it("rejects entries with unknown review IDs", () => {
    const { valid, rejected } = validateTags([tag({ review_id: "nope" })], REVIEWS);
    expect(valid).toHaveLength(0);
    expect(rejected).toBe(1);
  });

  it("rejects unsupported sentiment values", () => {
    const { valid, rejected } = validateTags([tag({ sentiment: "positive" })], REVIEWS);
    expect(valid).toHaveLength(0);
    expect(rejected).toBe(1);
  });

  it("rejects empty theme labels", () => {
    const { valid, rejected } = validateTags([tag({ theme: "   " })], REVIEWS);
    expect(valid).toHaveLength(0);
    expect(rejected).toBe(1);
  });

  it("rejects evidence that is not a substring of the referenced review", () => {
    const { valid, rejected } = validateTags(
      [tag({ evidence_span: "not present anywhere" })],
      REVIEWS,
    );
    expect(valid).toHaveLength(0);
    expect(rejected).toBe(1);
  });

  it("rejects evidence that only appears in a DIFFERENT review", () => {
    // "keeps dropping" is in r2, but the tag claims r1.
    const { valid, rejected } = validateTags(
      [tag({ review_id: "r1", evidence_span: "keeps dropping" })],
      REVIEWS,
    );
    expect(valid).toHaveLength(0);
    expect(rejected).toBe(1);
  });

  it("keeps a valid tag whose evidence is an exact substring of its own review", () => {
    const { valid, rejected } = validateTags([tag()], REVIEWS);
    expect(rejected).toBe(0);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({ reviewId: "r1", sentiment: "praise" });
  });
});

describe("validateTags — dedup and normalization", () => {
  it("deduplicates by normalized {review_id, theme, sentiment}", () => {
    const { valid, deduped } = validateTags(
      [
        tag({ theme: "Battery life", evidence_span: "battery lasts for days" }),
        tag({ theme: "battery   LIFE", evidence_span: "the sound is crisp" }), // same triple
      ],
      REVIEWS,
    );
    expect(valid).toHaveLength(1);
    expect(deduped).toBe(1);
  });

  it("normalizes theme labels for casing and whitespace only", () => {
    expect(normalizeTheme("Battery Life")).toBe("battery life");
    expect(normalizeTheme("  battery   life ")).toBe("battery life");
    // Not semantic: different words remain different keys.
    expect(normalizeTheme("Battery")).not.toBe(normalizeTheme("Battery life"));
  });

  it("lets one review produce praise for one theme and fault for another", () => {
    const { valid } = validateTags(
      [
        tag({ theme: "Battery life", sentiment: "praise", evidence_span: "battery lasts for days" }),
        tag({ theme: "Sound", sentiment: "fault", evidence_span: "the sound is crisp" }),
      ],
      REVIEWS,
    );
    expect(valid).toHaveLength(2);
    expect(valid.map((t) => t.sentiment).sort()).toEqual(["fault", "praise"]);
  });
});

describe("parseTagArray / stripCodeFence / validateModelResponse", () => {
  it("throws on syntactically invalid JSON", () => {
    expect(() => parseTagArray("{not json")).toThrow();
  });

  it("throws when the top-level JSON is not an array", () => {
    expect(() => parseTagArray('{"tags": []}')).toThrow();
  });

  it("strips an accidental markdown code fence", () => {
    expect(stripCodeFence('```json\n[]\n```')).toBe("[]");
    expect(stripCodeFence("  [] ")).toBe("[]");
  });

  it("validates a raw model response, discarding invalid entries but keeping valid ones", () => {
    const raw = JSON.stringify([
      tag(), // valid
      tag({ review_id: "ghost" }), // unknown id → discarded
    ]);
    const { valid, rejected } = validateModelResponse(raw, REVIEWS);
    expect(valid).toHaveLength(1);
    expect(rejected).toBe(1);
  });

  it("treats invalid JSON as entirely unusable (throws)", () => {
    expect(() => validateModelResponse("garbage, not json", REVIEWS)).toThrow();
  });

  it("reports valid=0, rejected>0 when every entry is invalid (all-rejected signal)", () => {
    // The server's all-rejected gate keys off exactly this: entries present,
    // none valid. Unknown id, bad sentiment, and non-matching evidence.
    const raw = JSON.stringify([
      tag({ review_id: "ghost" }),
      tag({ sentiment: "positive" }),
      tag({ evidence_span: "not in any review" }),
    ]);
    const { valid, rejected } = validateModelResponse(raw, REVIEWS);
    expect(valid).toHaveLength(0);
    expect(rejected).toBe(3);
  });
});
