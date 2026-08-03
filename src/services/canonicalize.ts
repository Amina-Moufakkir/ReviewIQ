/**
 * Cross-batch theme canonicalization: shared types, strict validation, and the
 * hierarchical orchestration that composes one mapping out of several passes.
 *
 * Batches are tagged independently, so batch 3 may call a theme "battery life"
 * where batch 47 calls it "poor battery". Left alone that splits one concept's
 * support in two and under-counts both — a finding can fall below the evidence
 * threshold and vanish with nothing on screen to say so.
 *
 * The model's only job here is to say which LABELS mean the same thing. It
 * never sees review text, never sees counts, and never renames anything to a
 * string it was not given. Everything numeric stays in TypeScript, as it does
 * for tags.
 *
 * Imported by BOTH the endpoint and the client so the two validation gates use
 * identical rules — the same arrangement as claudeTags.ts.
 */

// --- limits ------------------------------------------------------------------

/**
 * Labels one request may carry. Beyond this the caller must go hierarchical.
 *
 * Sized so the response stays well inside the endpoint's 30s wall: ~300 labels
 * emit roughly 900 output tokens of index groups, about 8s at the measured
 * ~110 tok/s.
 */
export const MAX_LABELS_PER_CANONICALIZATION_REQUEST = 300;

/**
 * Longest single label accepted.
 *
 * This is a structural guard, not a formatting preference. The contract is
 * "labels only, never review text", and a `string[]` cannot express that on its
 * own — nothing stops a caller pasting a review body into the array. A theme
 * label is a handful of words; review text is not. Refusing anything longer
 * makes the boundary enforceable rather than merely documented.
 */
export const MAX_LABEL_LENGTH = 120;

/** Total request bytes, a secondary guard on many short labels. */
export const MAX_CANONICALIZATION_BODY_BYTES = 64 * 1024;

/** Hierarchy depth beyond which the caller must give up rather than loop. */
export const MAX_CANONICALIZATION_LEVELS = 3;

// --- request -----------------------------------------------------------------

/** The wire shape the endpoint accepts. Labels only — there is no text field. */
export interface CanonicalizeRequest {
  labels: string[];
}

/**
 * Validate and narrow an inbound body to its label list.
 *
 * Returns the labels, or `{ invalid: <reason> }` naming the first contract
 * violation. Reasons describe shape only and carry nothing sensitive.
 */
export function parseCanonicalizeRequest(body: unknown): string[] | { invalid: string } {
  if (typeof body !== "object" || body === null) return { invalid: "body must be a JSON object" };
  const raw = (body as { labels?: unknown }).labels;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { invalid: "labels must be a non-empty array" };
  }
  if (raw.length > MAX_LABELS_PER_CANONICALIZATION_REQUEST) {
    return {
      invalid: `at most ${MAX_LABELS_PER_CANONICALIZATION_REQUEST} labels per request`,
    };
  }

  const labels: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") {
      return { invalid: "each label must be a non-blank string" };
    }
    if (item.length > MAX_LABEL_LENGTH) {
      // The guard that keeps review text out of a labels-only endpoint.
      return { invalid: `each label must be at most ${MAX_LABEL_LENGTH} characters` };
    }
    if (seen.has(item)) return { invalid: `duplicate label: ${item}` };
    seen.add(item);
    labels.push(item);
  }
  return labels;
}

// --- grouping validation -----------------------------------------------------

export interface GroupingOutcome {
  /** Index groups, representative first. */
  groups: number[][];
}

/**
 * Validate a grouping against the labels it claims to partition.
 *
 * The rules are all structural, so a bad response fails here rather than
 * quietly producing a mapping that loses or invents a theme:
 *
 *  - every index in range
 *  - every label appears **exactly once** across all groups — a total partition
 *  - no empty group
 *  - the representative is `group[0]`, which is itself one of the given labels,
 *    so a displayed theme name is always something the model was handed rather
 *    than something it composed
 *
 * Returns `null` when valid, or a reason string.
 */
export function validateGrouping(groups: unknown, labelCount: number): string | null {
  if (!Array.isArray(groups)) return "groups must be an array";
  if (groups.length === 0) return "groups must not be empty";
  if (groups.length > labelCount) return "more groups than labels";

  const seen = new Set<number>();
  for (const group of groups) {
    if (!Array.isArray(group) || group.length === 0) return "each group must be a non-empty array";
    for (const index of group) {
      if (typeof index !== "number" || !Number.isInteger(index)) {
        return "each group entry must be an integer index";
      }
      if (index < 0 || index >= labelCount) return `index ${index} is out of range`;
      if (seen.has(index)) return `index ${index} appears in more than one group`;
      seen.add(index);
    }
  }
  if (seen.size !== labelCount) {
    return `grouping covers ${seen.size} of ${labelCount} labels`;
  }
  return null;
}

/** Apply a validated grouping, returning label → representative label. */
export function applyGrouping(labels: readonly string[], groups: number[][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of groups) {
    const representative = labels[group[0]!]!;
    for (const index of group) map.set(labels[index]!, representative);
  }
  return map;
}

// --- hierarchy ---------------------------------------------------------------

export interface CanonicalizationLevelResult {
  level: number;
  inputLabels: string[];
  representatives: string[];
  map: Map<string, string>;
}

export interface CanonicalizationResult {
  levels: CanonicalizationLevelResult[];
  /** Composed mapping from every original label to its final canonical label. */
  map: Map<string, string>;
  /** Distinct canonical labels, in first-appearance order of the input. */
  canonicalLabels: string[];
}

export type CanonicalizeDispatch = (
  labels: string[],
  signal: AbortSignal,
) => Promise<GroupingOutcome>;

export class CanonicalizationError extends Error {
  constructor(
    readonly reason:
      | "unsupported"
      | "invalid_grouping"
      | "composition"
      | "provider"
      | "aborted",
    message: string,
  ) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/** Deterministic chunking: sort, then slice. Independent of arrival order. */
export function chunkLabels(labels: readonly string[], size: number): string[][] {
  const sorted = [...labels].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const chunks: string[][] = [];
  for (let i = 0; i < sorted.length; i += size) chunks.push(sorted.slice(i, i + size));
  return chunks;
}

/**
 * Compose per-level mappings into one label → canonical mapping.
 *
 * Levels are sequential passes, not a pool to look a label up in: level 0 maps
 * every distinct label to a representative, level 1 maps *those
 * representatives* onward, and so on. So each label is walked through the
 * levels **in order**, applying each exactly once. Searching all levels per hop
 * instead would stop the walk early — a label that is its own representative at
 * level 0 matches there and never reaches level 1, silently leaving a theme
 * un-merged.
 *
 * Validated rather than assumed: every level must map the value the previous
 * level handed it, and the composition must be total over the original labels.
 * A level that cannot is inconsistent with the one before it, and a mapping
 * that quietly dropped a label would delete a theme from the report with
 * nothing on screen to say so.
 *
 * Error messages carry level indices, never label text.
 */
export function composeMappings(
  originalLabels: readonly string[],
  levels: readonly CanonicalizationLevelResult[],
): Map<string, string> {
  const composed = new Map<string, string>();
  for (const label of originalLabels) {
    let current = label;
    for (const [index, level] of levels.entries()) {
      const next = level.map.get(current);
      if (next === undefined) {
        throw new CanonicalizationError(
          "composition",
          `Level ${index} did not map a label carried forward from the previous level.`,
        );
      }
      current = next;
    }
    composed.set(label, current);
  }
  if (composed.size !== new Set(originalLabels).size) {
    throw new CanonicalizationError("composition", "Composed mapping is not total.");
  }
  return composed;
}

/**
 * Canonicalize a label set, going hierarchical when it exceeds one request.
 *
 * A single pass whenever the labels fit — the flat case is preferred, because
 * chunking can separate two synonyms into different level-0 groups and they
 * only re-merge at the next level if both survive as representatives. Where
 * they do not, one concept stays split and its support is under-counted. That
 * is a known analytical limitation of the method, not a defect to review away,
 * and it is the reason chunking is a fallback rather than the default.
 */
export async function canonicalizeLabels(
  labels: readonly string[],
  dispatch: CanonicalizeDispatch,
  options: { signal?: AbortSignal; maxLevels?: number; maxPerRequest?: number } = {},
): Promise<CanonicalizationResult> {
  const maxLevels = options.maxLevels ?? MAX_CANONICALIZATION_LEVELS;
  const maxPerRequest = options.maxPerRequest ?? MAX_LABELS_PER_CANONICALIZATION_REQUEST;
  const signal = options.signal ?? new AbortController().signal;

  const distinct = [...new Set(labels)];
  if (distinct.length === 0) {
    return { levels: [], map: new Map(), canonicalLabels: [] };
  }

  const levels: CanonicalizationLevelResult[] = [];
  let current = distinct;

  for (let level = 0; level < maxLevels; level++) {
    if (signal.aborted) throw new CanonicalizationError("aborted", "Canonicalization was cancelled.");

    const chunks =
      current.length <= maxPerRequest ? [[...current]] : chunkLabels(current, maxPerRequest);

    // Chunks are independent; levels are not.
    const outcomes = await Promise.all(chunks.map((chunk) => dispatch(chunk, signal)));

    const levelMap = new Map<string, string>();
    const representatives: string[] = [];
    chunks.forEach((chunk, i) => {
      const problem = validateGrouping(outcomes[i]!.groups, chunk.length);
      if (problem) {
        throw new CanonicalizationError("invalid_grouping", `Level ${level}: ${problem}`);
      }
      const map = applyGrouping(chunk, outcomes[i]!.groups);
      for (const [from, to] of map) {
        levelMap.set(from, to);
        if (from === to) representatives.push(to);
      }
    });

    levels.push({ level, inputLabels: current, representatives, map: levelMap });

    if (chunks.length === 1) {
      const map = composeMappings(distinct, levels);
      return { levels, map, canonicalLabels: canonicalOrder(distinct, map) };
    }
    if (representatives.length >= current.length) {
      throw new CanonicalizationError(
        "unsupported",
        `Level ${level} merged nothing: ${representatives.length} representatives from ${current.length} labels.`,
      );
    }
    current = representatives;
  }

  throw new CanonicalizationError(
    "unsupported",
    `Labels did not reduce to a single request within ${maxLevels} levels.`,
  );
}

/** Canonical labels in first-appearance order of the original input. */
function canonicalOrder(labels: readonly string[], map: Map<string, string>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const label of labels) {
    const canonical = map.get(label);
    if (canonical !== undefined && !seen.has(canonical)) {
      seen.add(canonical);
      order.push(canonical);
    }
  }
  return order;
}
