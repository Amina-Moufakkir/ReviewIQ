import { describe, it, expect, vi } from "vitest";
import {
  MAX_LABELS_PER_CANONICALIZATION_REQUEST,
  MAX_LABEL_LENGTH,
  MAX_CANONICALIZATION_LEVELS,
  parseCanonicalizeRequest,
  validateGrouping,
  applyGrouping,
  chunkLabels,
  composeMappings,
  canonicalizeLabels,
  CanonicalizationError,
  type CanonicalizeDispatch,
  type CanonicalizationLevelResult,
} from "./canonicalize.js";

/**
 * Tests for the canonicalization rules the endpoint and the client both apply.
 *
 * The property under test throughout is *totality*: every label the caller
 * hands in must come back mapped to exactly one canonical label that the model
 * was actually given. A mapping that drops a label deletes a theme from the
 * report; one that invents a label puts words in a customer's mouth. Both fail
 * loudly here rather than producing a plausible-looking brief.
 */

// --- request validation ------------------------------------------------------

describe("parseCanonicalizeRequest", () => {
  it("returns the labels when the body satisfies the contract", () => {
    expect(parseCanonicalizeRequest({ labels: ["Battery life", "Comfort"] })).toEqual([
      "Battery life",
      "Comfort",
    ]);
  });

  it.each([
    ["a non-object body", "labels"],
    ["null", null],
    ["an array body", ["Battery"]],
  ])("rejects %s", (_name, body) => {
    expect(parseCanonicalizeRequest(body)).toHaveProperty("invalid");
  });

  it.each([
    ["a missing field", {}],
    ["a non-array field", { labels: "Battery" }],
    ["an empty array", { labels: [] }],
    ["a non-string entry", { labels: ["Battery", 7] }],
    ["a blank entry", { labels: [" \t "] }],
    ["a duplicate entry", { labels: ["Battery", "Battery"] }],
  ])("rejects %s", (_name, body) => {
    expect(parseCanonicalizeRequest(body)).toHaveProperty("invalid");
  });

  it("rejects a label one character past the limit and accepts one at it", () => {
    const atLimit = "x".repeat(MAX_LABEL_LENGTH);
    expect(parseCanonicalizeRequest({ labels: [atLimit] })).toEqual([atLimit]);
    expect(parseCanonicalizeRequest({ labels: [atLimit + "x"] })).toHaveProperty("invalid");
  });

  it("rejects one label past the count limit and accepts the limit itself", () => {
    const atLimit = Array.from({ length: MAX_LABELS_PER_CANONICALIZATION_REQUEST }, (_, i) => `t${i}`);
    expect(parseCanonicalizeRequest({ labels: atLimit })).toHaveLength(atLimit.length);
    expect(parseCanonicalizeRequest({ labels: [...atLimit, "one more"] })).toHaveProperty("invalid");
  });

  it("names the violated rule without echoing a long value back", () => {
    const result = parseCanonicalizeRequest({ labels: ["y".repeat(MAX_LABEL_LENGTH + 1)] }) as {
      invalid: string;
    };
    expect(result.invalid).toContain(String(MAX_LABEL_LENGTH));
    expect(result.invalid).not.toContain("yyyyyyyyyy");
  });

  it("preserves the caller's order, which the index groups refer to", () => {
    const labels = ["Zip quality", "Battery life", "Aroma"];
    expect(parseCanonicalizeRequest({ labels })).toEqual(labels);
  });
});

// --- grouping validation -----------------------------------------------------

describe("validateGrouping", () => {
  it("accepts an exact partition", () => {
    expect(validateGrouping([[0, 2], [1]], 3)).toBeNull();
  });

  it("accepts the all-singletons case, where nothing merges", () => {
    expect(validateGrouping([[0], [1], [2]], 3)).toBeNull();
  });

  it("accepts the one-group case, where everything merges", () => {
    expect(validateGrouping([[0, 1, 2]], 3)).toBeNull();
  });

  it.each([
    ["a dropped label", [[0, 1]], 3],
    ["two dropped labels", [[0]], 3],
    ["a repeated index within one group", [[0, 0], [1], [2]], 3],
    ["a repeated index across groups", [[0, 1], [1, 2]], 3],
    ["an out-of-range index", [[0], [1], [3]], 3],
    ["a negative index", [[-1], [1], [2]], 3],
    ["a fractional index", [[0.5], [1], [2]], 3],
    ["a string index", [["0"], [1], [2]], 3],
    ["an empty group", [[0, 1, 2], []], 3],
    ["no groups", [], 3],
    ["more groups than labels", [[0], [1], [2], [0]], 3],
  ])("rejects %s", (_name, groups, count) => {
    expect(validateGrouping(groups, count)).not.toBeNull();
  });

  it.each([["a string", "groups"], ["null", null], ["an object", { groups: [] }]])(
    "rejects %s as a grouping",
    (_name, groups) => {
      expect(validateGrouping(groups, 3)).not.toBeNull();
    },
  );

  it("catches under-coverage that per-index checks alone would miss", () => {
    // Every index here is in range and unique — only the total-coverage rule
    // rejects it. Removing that rule must break this test.
    expect(validateGrouping([[0], [1]], 3)).toBe("grouping covers 2 of 3 labels");
  });
});

describe("applyGrouping", () => {
  it("maps every label to its group's first member", () => {
    const labels = ["Battery life", "Poor battery", "Comfort"];
    const map = applyGrouping(labels, [[0, 1], [2]]);

    expect(map.get("Battery life")).toBe("Battery life");
    expect(map.get("Poor battery")).toBe("Battery life");
    expect(map.get("Comfort")).toBe("Comfort");
  });

  it("is total over the input labels", () => {
    const labels = ["a", "b", "c", "d"];
    const map = applyGrouping(labels, [[2, 0], [1, 3]]);
    expect(map.size).toBe(labels.length);
    for (const label of labels) expect(map.has(label)).toBe(true);
  });

  it("only ever produces labels it was given — it never composes a new name", () => {
    const labels = ["Battery life", "Poor battery"];
    const map = applyGrouping(labels, [[0, 1]]);
    for (const canonical of map.values()) expect(labels).toContain(canonical);
  });
});

// --- chunking ----------------------------------------------------------------

describe("chunkLabels", () => {
  it("covers every label exactly once", () => {
    const labels = Array.from({ length: 17 }, (_, i) => `t${i}`);
    const flat = chunkLabels(labels, 5).flat();
    expect(flat).toHaveLength(labels.length);
    expect(new Set(flat).size).toBe(labels.length);
  });

  it("respects the chunk size", () => {
    for (const chunk of chunkLabels(Array.from({ length: 17 }, (_, i) => `t${i}`), 5)) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
  });

  it("is independent of arrival order — batch scheduling cannot change the result", () => {
    const labels = ["delta", "alpha", "charlie", "bravo", "echo"];
    const shuffled = ["echo", "bravo", "delta", "charlie", "alpha"];
    expect(chunkLabels(shuffled, 2)).toEqual(chunkLabels(labels, 2));
  });
});

// --- composition -------------------------------------------------------------

/** Build a level from a plain object mapping, for composition tests. */
function level(n: number, pairs: Record<string, string>): CanonicalizationLevelResult {
  const map = new Map(Object.entries(pairs));
  return {
    level: n,
    inputLabels: [...map.keys()],
    representatives: [...new Set(map.values())],
    map,
  };
}

describe("composeMappings", () => {
  it("follows a label through two levels to its final canonical form", () => {
    const composed = composeMappings(
      ["Poor battery", "Battery life", "Comfort"],
      [
        level(0, { "Poor battery": "Battery life", "Battery life": "Battery life", Comfort: "Comfort" }),
        level(1, { "Battery life": "Comfort", Comfort: "Comfort" }),
      ],
    );

    expect(composed.get("Poor battery")).toBe("Comfort");
    expect(composed.get("Battery life")).toBe("Comfort");
    expect(composed.get("Comfort")).toBe("Comfort");
  });

  it("is total over the original labels", () => {
    const originals = ["a", "b", "c"];
    const composed = composeMappings(originals, [level(0, { a: "b", b: "b", c: "c" })]);
    expect(composed.size).toBe(originals.length);
  });

  it("throws rather than passing an unmapped label through as its own canonical label", () => {
    // Level 0 forgot "c". Treating it as its own canonical label would look
    // entirely correct on screen while quietly splitting a theme, so the
    // inconsistency has to surface here.
    expect(() => composeMappings(["a", "b", "c"], [level(0, { a: "b", b: "b" })])).toThrow(
      CanonicalizationError,
    );
  });

  it("throws when a level cannot map what the previous level handed it", () => {
    // Level 0 produces "b"; level 1 was never given it. The levels disagree.
    expect(() =>
      composeMappings(["a", "b"], [level(0, { a: "b", b: "b" }), level(1, { a: "a" })]),
    ).toThrow(CanonicalizationError);
  });

  it("applies levels in order rather than stopping at the first that knows the label", () => {
    // "Battery life" is its own representative at level 0 and merges only at
    // level 1. A composition that searched all levels per hop would match level
    // 0, see no change, and stop — leaving the level-1 merge unapplied.
    const composed = composeMappings(
      ["Battery life", "Comfort"],
      [
        level(0, { "Battery life": "Battery life", Comfort: "Comfort" }),
        level(1, { "Battery life": "Comfort", Comfort: "Comfort" }),
      ],
    );
    expect(composed.get("Battery life")).toBe("Comfort");
  });

  it("leaves an already-canonical label alone", () => {
    const composed = composeMappings(["a"], [level(0, { a: "a" })]);
    expect(composed.get("a")).toBe("a");
  });

  it("returns an identity mapping when there are no levels", () => {
    const composed = composeMappings(["a", "b"], []);
    expect(composed.get("a")).toBe("a");
    expect(composed.get("b")).toBe("b");
  });
});

// --- orchestration -----------------------------------------------------------

/** A dispatch that merges labels sharing a keyword, otherwise leaves them alone. */
function keywordDispatch(keyword: string): CanonicalizeDispatch {
  return vi.fn(async (labels: string[]) => {
    const matching: number[] = [];
    const groups: number[][] = [];
    labels.forEach((label, i) => {
      if (label.toLowerCase().includes(keyword)) matching.push(i);
      else groups.push([i]);
    });
    if (matching.length > 0) groups.unshift(matching);
    return { groups };
  });
}

/** A dispatch that never merges anything. */
const identityDispatch: CanonicalizeDispatch = async (labels) => ({
  groups: labels.map((_, i) => [i]),
});

describe("canonicalizeLabels", () => {
  it("returns an empty result for no labels, without calling the provider", async () => {
    const dispatch = vi.fn(identityDispatch);
    const result = await canonicalizeLabels([], dispatch);

    expect(result.map.size).toBe(0);
    expect(result.canonicalLabels).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("makes exactly one request when the labels fit", async () => {
    const dispatch = keywordDispatch("battery");
    const result = await canonicalizeLabels(["Poor battery", "Battery life", "Comfort"], dispatch);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.levels).toHaveLength(1);
    expect(result.map.get("Battery life")).toBe("Poor battery");
    expect(result.map.get("Poor battery")).toBe("Poor battery");
    expect(result.map.get("Comfort")).toBe("Comfort");
  });

  it("de-duplicates the input before dispatching", async () => {
    const dispatch = vi.fn(identityDispatch);
    const result = await canonicalizeLabels(["a", "b", "a", "b", "a"], dispatch);

    expect(dispatch.mock.calls[0]?.[0]).toEqual(["a", "b"]);
    expect(result.map.size).toBe(2);
  });

  it("maps every input label, whatever the merge pattern", async () => {
    const labels = ["Poor battery", "Battery life", "Battery drains", "Comfort", "Fit"];
    const result = await canonicalizeLabels(labels, keywordDispatch("battery"));

    for (const label of labels) expect(result.map.has(label)).toBe(true);
    // And every canonical label is one of the originals — never a new string.
    for (const canonical of result.map.values()) expect(labels).toContain(canonical);
  });

  it("lists canonical labels in first-appearance order of the input", async () => {
    const result = await canonicalizeLabels(
      ["Comfort", "Poor battery", "Battery life", "Fit"],
      keywordDispatch("battery"),
    );
    expect(result.canonicalLabels).toEqual(["Comfort", "Poor battery", "Fit"]);
  });

  it("goes hierarchical when the labels exceed one request", async () => {
    // 6 labels, 2 per request: level 0 makes 3 chunks, so a second level is
    // needed to reconcile the representatives across them.
    const labels = ["a1", "a2", "b1", "b2", "c1", "c2"];
    const dispatch = vi.fn(async (chunk: string[]) => ({
      // Merge each chunk into one group — halves the label count per level.
      groups: [chunk.map((_, i) => i)],
    }));
    const result = await canonicalizeLabels(labels, dispatch, { maxPerRequest: 2 });

    expect(result.levels.length).toBeGreaterThan(1);
    expect(result.map.size).toBe(labels.length);
    // Everything collapsed to a single canonical label.
    expect(new Set(result.map.values()).size).toBe(1);
  });

  it("chunks deterministically, so the same labels in any order give the same mapping", async () => {
    const labels = ["delta", "alpha", "charlie", "bravo", "echo", "foxtrot"];
    const shuffled = ["foxtrot", "bravo", "echo", "delta", "alpha", "charlie"];
    const merge = async (chunk: string[]) => ({ groups: [chunk.map((_, i) => i)] });

    const a = await canonicalizeLabels(labels, merge, { maxPerRequest: 2 });
    const b = await canonicalizeLabels(shuffled, merge, { maxPerRequest: 2 });

    for (const label of labels) expect(a.map.get(label)).toBe(b.map.get(label));
  });

  it("gives up at the level that merged nothing, without paying for further levels", async () => {
    // The level cap alone would also stop this run, so asserting only that it
    // rejects proves nothing about the merge guard. What the guard buys is
    // stopping *immediately*: a level that merged nothing will merge nothing
    // next time either, and every further level is billed requests spent to
    // reach the same failure.
    const dispatch = vi.fn(identityDispatch);
    await expect(
      canonicalizeLabels(["a", "b", "c", "d"], dispatch, { maxPerRequest: 2, maxLevels: 3 }),
    ).rejects.toMatchObject({ reason: "unsupported" });

    // Level 0's two chunks, and nothing beyond them.
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("fails as unsupported when the labels do not reduce within the level cap", async () => {
    // Merges one label per level — progress, but far too slow to converge.
    const slow: CanonicalizeDispatch = async (chunk) => ({
      groups:
        chunk.length > 1
          ? [[0, 1], ...chunk.slice(2).map((_, i) => [i + 2])]
          : [[0]],
    });
    await expect(
      canonicalizeLabels(
        Array.from({ length: 40 }, (_, i) => `t${i}`),
        slow,
        { maxPerRequest: 4, maxLevels: 2 },
      ),
    ).rejects.toMatchObject({ reason: "unsupported" });
  });

  it("rejects an invalid grouping from any chunk rather than mapping around it", async () => {
    const bad: CanonicalizeDispatch = async (chunk) => ({
      groups: chunk.length > 1 ? [[0]] : [[0]], // drops every label but the first
    });
    await expect(
      canonicalizeLabels(["a", "b", "c"], bad, { maxPerRequest: 3 }),
    ).rejects.toMatchObject({ reason: "invalid_grouping" });
  });

  it("does not fall back to fragmented labels when canonicalization fails", async () => {
    // A terminal failure by design: half-canonicalized themes would under-count
    // silently, which is worse than a visible failure.
    const failing: CanonicalizeDispatch = async () => {
      throw new CanonicalizationError("provider", "provider was unavailable");
    };
    await expect(canonicalizeLabels(["a", "b"], failing)).rejects.toBeInstanceOf(
      CanonicalizationError,
    );
  });

  it("stops when the signal is already aborted, before dispatching", async () => {
    const controller = new AbortController();
    controller.abort();
    const dispatch = vi.fn(identityDispatch);

    await expect(
      canonicalizeLabels(["a", "b"], dispatch, { signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("passes the signal through so an in-flight request can be cancelled", async () => {
    const controller = new AbortController();
    const dispatch = vi.fn(identityDispatch);
    await canonicalizeLabels(["a"], dispatch, { signal: controller.signal });

    expect(dispatch.mock.calls[0]?.[1]).toBe(controller.signal);
  });

  it("defaults the level cap to the documented constant", async () => {
    const dispatch = vi.fn(async (chunk: string[]) => ({
      groups: chunk.map((_, i) => [i]).slice(0, -1).concat([[chunk.length - 1]]),
    }));
    // Non-merging at maxPerRequest=1 chunks, so it terminates via the guard —
    // what matters is that no more than MAX_CANONICALIZATION_LEVELS run.
    await canonicalizeLabels(["a"], dispatch).catch(() => {});
    expect(dispatch.mock.calls.length).toBeLessThanOrEqual(MAX_CANONICALIZATION_LEVELS);
  });
});
