import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeTheme,
  parseReviewRequest,
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

  // The dedup key joins {reviewId, themeKey, sentiment} with U+0000 precisely
  // because that character cannot occur in any of the three: review ids come
  // from the adapter, theme labels are model text that survived validation, and
  // the sentiment is one of three literals. A printable separator such as a
  // space would let distinct triples collide into one key and silently drop a
  // real finding — these two tags share the concatenation "r1 battery life
  // praise" but are NOT the same tag.
  it("uses a separator that cannot collide across the key's three fields", () => {
    const { valid, deduped } = validateTags(
      [
        { review_id: "r1", theme: "battery life", sentiment: "praise", evidence_span: "battery lasts for days" },
        { review_id: "r1 battery", theme: "life", sentiment: "praise", evidence_span: "sturdy little thing" },
      ],
      new Map([
        ["r1", "battery lasts for days"],
        ["r1 battery", "sturdy little thing"],
      ]),
    );
    expect(valid).toHaveLength(2);
    expect(deduped).toBe(0);
  });

  // Guardrail for the separator's ENCODING, not its value. It is written as the
  // escape `\u0000`; if an editor or tool ever rewrites that back to a literal
  // NUL byte, the runtime behaviour is unchanged but git reclassifies the file
  // as binary and every future diff becomes unreviewable.
  it("keeps claudeTags.ts free of literal NUL bytes so it diffs as text", () => {
    const source = readFileSync(join(process.cwd(), "src/services/claudeTags.ts"), "utf8");
    expect(source).toContain("\\u0000");
    expect(source.includes("\u0000")).toBe(false);
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

describe("parseReviewRequest", () => {
  const ok = (...reviews: unknown[]) => parseReviewRequest({ reviews });

  it("accepts a well-formed request and narrows it", () => {
    const result = ok({ id: "r1", text: "Great sound" }, { id: "r2", text: "Meh" });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { id: "r1", text: "Great sound" },
      { id: "r2", text: "Meh" },
    ]);
  });

  it("rejects a non-object body or a missing/empty reviews array", () => {
    expect(parseReviewRequest(null)).toMatchObject({ invalid: expect.any(String) });
    expect(parseReviewRequest("nope")).toMatchObject({ invalid: expect.any(String) });
    expect(parseReviewRequest({})).toMatchObject({ invalid: expect.any(String) });
    expect(parseReviewRequest({ reviews: [] })).toMatchObject({ invalid: expect.any(String) });
    expect(parseReviewRequest({ reviews: "x" })).toMatchObject({ invalid: expect.any(String) });
  });

  it("rejects a non-object review entry", () => {
    expect(ok("just a string")).toMatchObject({ invalid: expect.any(String) });
    expect(ok(null)).toMatchObject({ invalid: expect.any(String) });
  });

  it("rejects blank / whitespace-only / non-string ids and text", () => {
    expect(ok({ id: "", text: "t" })).toMatchObject({ invalid: expect.any(String) });
    expect(ok({ id: "   ", text: "t" })).toMatchObject({ invalid: expect.any(String) }); // whitespace-only id
    expect(ok({ id: 1, text: "t" })).toMatchObject({ invalid: expect.any(String) });
    expect(ok({ id: "r1", text: "" })).toMatchObject({ invalid: expect.any(String) });
    expect(ok({ id: "r1", text: "  \n " })).toMatchObject({ invalid: expect.any(String) }); // whitespace-only text
    expect(ok({ id: "r1", text: 5 })).toMatchObject({ invalid: expect.any(String) });
  });

  it("rejects duplicate review ids", () => {
    const result = ok({ id: "r1", text: "a" }, { id: "r1", text: "b" });
    expect(result).toMatchObject({ invalid: expect.stringContaining("duplicate") });
  });

  // Sentiment on this path comes from the text alone, so a rating is not part of
  // the contract. An older client that still sends one must not be rejected, and
  // the value must not survive into what the model is shown.
  it("drops an inbound rating instead of forwarding or rejecting it", () => {
    for (const rating of [1, 5, 0, 400, 3.5, NaN, Infinity, "5", true, null]) {
      const result = ok({ id: "r1", text: "t", rating });
      expect(Array.isArray(result), `rating=${String(rating)}`).toBe(true);
      expect(result, `rating=${String(rating)}`).toEqual([{ id: "r1", text: "t" }]);
    }
  });
});
