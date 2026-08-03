import { describe, it, expect, vi } from "vitest";
import type { IncomingReview } from "./claudeTags";
import { AnalysisError } from "./analysisEngine";
import { MAX_ROWS_PER_BATCH_REQUEST } from "./claudeTags";
import { MAX_LABELS_PER_CANONICALIZATION_REQUEST } from "./canonicalize";
import { runClaudePipeline } from "./claudePipeline";
import type { Dispatch, DispatchRequest, DispatchResponse } from "./batchExecutor";
import type { CanonicalizeDispatch } from "./canonicalize";
import { CanonicalizeTransportError } from "./claudeDispatch";
import { isProgressAdvance, phaseIndex, type AnalysisProgress } from "./analysisProgress";

/**
 * The pipeline is where the two model stages meet, so what it is tested for is
 * the seam rather than either stage's internals.
 *
 * The properties that matter here are ordering and all-or-nothing across the
 * boundary: canonicalization cannot begin before tagging finishes, no
 * `CanonicalTag[]` exists unless BOTH stages complete, and a canonicalization
 * failure never quietly degrades into a report built on fragmented labels —
 * which would look finished and under-count every theme two batches happened to
 * name differently.
 */

/** Enough distinct labels to force chunking, derived from the limit itself. */
const TOO_MANY_LABELS = MAX_LABELS_PER_CANONICALIZATION_REQUEST + 1;

function rows(count: number, text = "The battery died in a day."): IncomingReview[] {
  return Array.from({ length: count }, (_, i) => ({ id: `r${i}`, text }));
}

/** A dispatch that tags every row with `theme`, honouring the run id. */
function taggingDispatch(themeFor: (rowId: string) => string, sentiment = "fault"): Dispatch {
  return vi.fn(async (request: DispatchRequest): Promise<DispatchResponse> => {
    return {
      runId: request.runId,
      ok: true,
      latencyMs: 10,
      outputTokens: request.rows.length * 40,
      inputTokens: request.rows.length * 100,
      tags: request.rows.map((row) => ({
        review_id: row.id,
        theme: themeFor(row.id),
        sentiment,
        evidence_span: "battery died",
      })),
    };
  });
}

/** A dispatch that fails every batch with a controlled code. */
function failingDispatch(code: string): Dispatch {
  return vi.fn(async (request: DispatchRequest): Promise<DispatchResponse> => ({
    runId: request.runId,
    ok: false,
    code,
    latencyMs: 5,
  }));
}

/** A canonicalizer that merges everything into the first label. */
const mergeAll: CanonicalizeDispatch = async (labels) => ({
  groups: [labels.map((_, i) => i)],
});

/** A canonicalizer that merges nothing. */
const mergeNone: CanonicalizeDispatch = async (labels) => ({
  groups: labels.map((_, i) => [i]),
});

function run(
  reviewRows: IncomingReview[],
  analyze: Dispatch,
  canonicalize: CanonicalizeDispatch,
  extra: { signal?: AbortSignal } = {},
) {
  return runClaudePipeline(reviewRows, {
    analyze,
    canonicalize,
    makeRunId: () => "run-1",
    ...extra,
  });
}

// --- zero rows ---------------------------------------------------------------

describe("an empty selection costs nothing", () => {
  it("makes no network call to either endpoint", async () => {
    const analyze = vi.fn(taggingDispatch(() => "Battery"));
    const canonicalize = vi.fn(mergeAll);
    const result = await run([], analyze, canonicalize);

    expect(analyze).not.toHaveBeenCalled();
    expect(canonicalize).not.toHaveBeenCalled();
    expect(result.tags).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("does not start a run at all, rather than starting an empty one", async () => {
    // Asserting "no request was sent" alone does not pin this: an executor
    // handed zero rows also sends nothing, so the guard would look redundant
    // while actually carrying the guarantee. What the guard provides is that an
    // empty window never becomes a run — no id, no telemetry — and therefore
    // does not depend on the executor tolerating an empty input, which it is
    // under no obligation to keep doing.
    const result = await run([], vi.fn(taggingDispatch(() => "Battery")), vi.fn(mergeAll));

    expect(result.runId).toBe("");
    expect(result.execution.batchCount).toBe(0);
    expect(result.execution.wallClockMs).toBe(0);
  });
});

// --- the happy path ----------------------------------------------------------

describe("both stages complete", () => {
  it("returns canonicalized tags covering every row", async () => {
    const result = await run(rows(4), taggingDispatch((id) => `Theme ${id}`), mergeAll);

    expect(result.tags).toHaveLength(4);
    expect(new Set(result.tags.map((t) => t.reviewId))).toEqual(
      new Set(["r0", "r1", "r2", "r3"]),
    );
    // Everything merged onto one canonical label.
    expect(new Set(result.tags.map((t) => t.canonicalKey)).size).toBe(1);
    expect(result.canonicalLabels).toHaveLength(1);
  });

  it("keeps the raw label on every tag for independent recomputation", async () => {
    const result = await run(rows(3), taggingDispatch((id) => `Theme ${id}`), mergeAll);

    expect(result.tags.map((t) => t.rawTheme).sort()).toEqual([
      "Theme r0",
      "Theme r1",
      "Theme r2",
    ]);
    expect(result.rawLabelCount).toBe(3);
  });

  it("splits a selection larger than one request into several", async () => {
    const analyze = taggingDispatch(() => "Battery");
    const rowCount = MAX_ROWS_PER_BATCH_REQUEST * 2 + 3;
    const result = await run(rows(rowCount), analyze, mergeAll);

    expect(result.tags).toHaveLength(rowCount);
    expect((analyze as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    for (const [request] of (analyze as ReturnType<typeof vi.fn>).mock.calls) {
      expect(request.rows.length).toBeLessThanOrEqual(MAX_ROWS_PER_BATCH_REQUEST);
    }
  });

  it("carries execution telemetry without exposing it as a result", async () => {
    const result = await run(rows(4), taggingDispatch(() => "Battery"), mergeAll);
    expect(result.execution.batchCount).toBeGreaterThan(0);
    expect(result.execution.totalOutputTokens).toBeGreaterThan(0);
  });
});

// --- one distinct label ------------------------------------------------------

describe("grouping is skipped only when there is nothing to group", () => {
  it("skips canonicalization for a single distinct label", async () => {
    const canonicalize = vi.fn(mergeNone);
    const result = await run(rows(4), taggingDispatch(() => "Battery"), canonicalize);

    expect(canonicalize).not.toHaveBeenCalled();
    expect(result.canonicalizationSkipped).toBe(true);
    expect(result.canonicalLabels).toEqual(["Battery"]);
    // Still canonical tags — the mapping is trivial, not absent.
    expect(result.tags.every((t) => t.canonicalTheme === "Battery")).toBe(true);
  });

  it("does not skip for two distinct labels", async () => {
    const canonicalize = vi.fn(mergeAll);
    const result = await run(rows(4), taggingDispatch((id) => (id === "r0" ? "A" : "B")), canonicalize);

    expect(canonicalize).toHaveBeenCalledTimes(1);
    expect(result.canonicalizationSkipped).toBe(false);
  });

  it("treats labels differing only in casing as one, and skips", async () => {
    const canonicalize = vi.fn(mergeNone);
    const result = await run(
      rows(4),
      taggingDispatch((id) => (id === "r0" ? "Battery Life" : "battery  life")),
      canonicalize,
    );

    expect(canonicalize).not.toHaveBeenCalled();
    expect(result.rawLabelCount).toBe(1);
  });
});

// --- stage ordering, across the boundary -------------------------------------

describe("stage ordering and all-or-nothing", () => {
  it("does not begin canonicalization until tagging has finished", async () => {
    const order: string[] = [];
    let analyzeInFlight = 0;

    const analyze: Dispatch = async (request) => {
      analyzeInFlight++;
      order.push("analyze:start");
      await new Promise((r) => setTimeout(r, 5));
      analyzeInFlight--;
      order.push("analyze:end");
      return {
        runId: request.runId,
        ok: true,
        latencyMs: 5,
        outputTokens: request.rows.length * 40,
        tags: request.rows.map((row) => ({
          review_id: row.id,
          theme: `Theme ${row.id}`,
          sentiment: "fault",
          evidence_span: "battery died",
        })),
      };
    };
    const canonicalize: CanonicalizeDispatch = async (labels) => {
      order.push("canonicalize:start");
      // The property under test: no tagging request is still open.
      expect(analyzeInFlight).toBe(0);
      return { groups: [labels.map((_, i) => i)] };
    };

    await run(rows(MAX_ROWS_PER_BATCH_REQUEST * 2), analyze, canonicalize);

    expect(order.indexOf("canonicalize:start")).toBeGreaterThan(order.lastIndexOf("analyze:end"));
  });

  it("never starts canonicalization when tagging fails", async () => {
    const canonicalize = vi.fn(mergeAll);
    await expect(run(rows(4), failingDispatch("server_misconfigured"), canonicalize)).rejects.toBeInstanceOf(
      AnalysisError,
    );

    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("returns no tags when canonicalization fails after tagging succeeded", async () => {
    // The case the boundary exists for: stage 1 produced a complete, valid tag
    // set, and it must still yield nothing rather than a report on raw labels.
    const analyze = vi.fn(taggingDispatch((id) => `Theme ${id}`));
    const canonicalize = vi.fn(async () => {
      throw new CanonicalizeTransportError("provider_unavailable");
    });

    const outcome = await run(rows(4), analyze, canonicalize).then(
      (r) => ({ resolved: r }),
      (e: unknown) => ({ rejected: e }),
    );

    expect(analyze).toHaveBeenCalled(); // stage 1 really did run
    expect(canonicalize).toHaveBeenCalled(); // stage 2 really was attempted
    expect(outcome).not.toHaveProperty("resolved");
    expect((outcome as { rejected: unknown }).rejected).toBeInstanceOf(AnalysisError);
  });

  it("does not fall back to raw labels when grouping is refused", async () => {
    // An invalid grouping is a refusal, not a hint to carry on unmerged.
    const canonicalize = vi.fn(async () => ({ groups: [[0]] })); // drops labels
    await expect(
      run(rows(4), taggingDispatch((id) => `Theme ${id}`), canonicalize),
    ).rejects.toBeInstanceOf(AnalysisError);
  });

  it("produces no result when the labels cannot be reduced to one request", async () => {
    // More distinct labels than one grouping request may carry, none of which
    // merge. The canonicalizer gives up rather than chunking forever, and the
    // pipeline must surface that instead of papering over it.
    //
    // The row count is derived from the label limit, not chosen: below it the
    // labels fit in a single chunk and "merge nothing" is a perfectly valid
    // all-singletons grouping, so the run legitimately succeeds.
    const canonicalize = vi.fn(mergeNone);
    await expect(
      run(rows(TOO_MANY_LABELS), taggingDispatch((id) => `Theme ${id}`), canonicalize),
    ).rejects.toBeInstanceOf(AnalysisError);
  });

  it("succeeds when nothing merges but the labels still fit one request", async () => {
    // The counterpart: "merged nothing" is only a failure when chunking forced
    // it. All-singletons within one request is a real answer.
    const result = await run(rows(6), taggingDispatch((id) => `Theme ${id}`), mergeNone);
    expect(result.tags).toHaveLength(6);
    expect(result.canonicalLabels).toHaveLength(6);
  });
});

// --- cancellation ------------------------------------------------------------

describe("one signal cancels the whole run", () => {
  it("stops tagging when cancelled during stage 1", async () => {
    const controller = new AbortController();
    const canonicalize = vi.fn(mergeAll);
    const analyze: Dispatch = async (_request, signal) => {
      controller.abort();
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };

    await expect(
      run(rows(4), analyze, canonicalize, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AnalysisError);
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("stops grouping when cancelled during stage 2", async () => {
    const controller = new AbortController();
    const canonicalize: CanonicalizeDispatch = async (_labels, signal) => {
      controller.abort();
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };

    const error = await run(
      rows(4),
      taggingDispatch((id) => `Theme ${id}`),
      canonicalize,
      { signal: controller.signal },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AnalysisError);
    expect((error as AnalysisError).message).toBe("The analysis was cancelled.");
  });

  it("passes a live signal into the grouping stage", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const canonicalize: CanonicalizeDispatch = async (labels, signal) => {
      seen.push(signal);
      return { groups: [labels.map((_, i) => i)] };
    };

    await run(rows(4), taggingDispatch((id) => `Theme ${id}`), canonicalize, {
      signal: controller.signal,
    });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.aborted).toBe(false);
  });
});

// --- failure messages --------------------------------------------------------

describe("every failure becomes a controlled AnalysisError", () => {
  const CODES = [
    "analysis_disabled",
    "analysis_busy",
    "analysis_timeout",
    "output_truncated",
    "payload_too_large",
    "unauthorized",
    "server_misconfigured",
    "provider_unavailable",
    "invalid_response",
    "network",
    "something_unrecognised",
  ];

  it.each(CODES)("maps the endpoint code %s to an AnalysisError", async (code) => {
    const error = await run(rows(4), failingDispatch(code), mergeAll).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnalysisError);
    expect((error as Error).message).not.toBe("");
  });

  it.each(CODES)("never leaks internal mechanics for code %s", async (code) => {
    const error = await run(rows(4), failingDispatch(code), mergeAll).catch((e: unknown) => e);
    const message = (error as Error).message;

    // An analyst never chooses a batch size, a run, a level, or a chunk.
    expect(message).not.toMatch(/batch/i);
    expect(message).not.toMatch(/chunk/i);
    expect(message).not.toMatch(/\blevel \d/i);
    expect(message).not.toMatch(/run id|runid/i);
    expect(message).not.toContain(String(MAX_ROWS_PER_BATCH_REQUEST));
    expect(message).not.toContain(code);
  });

  it("distinguishes a disabled service from a busy one", async () => {
    const disabled = await run(rows(4), failingDispatch("analysis_disabled"), mergeAll).catch(
      (e: unknown) => (e as Error).message,
    );
    const busy = await run(rows(4), failingDispatch("analysis_busy"), mergeAll).catch(
      (e: unknown) => (e as Error).message,
    );
    expect(disabled).not.toBe(busy);
  });

  it("keeps the grouping endpoint's code meaningful rather than collapsing it", async () => {
    // CanonicalizeTransportError exists so a 503 from the grouping endpoint does
    // not read the same as a generic outage.
    const disabled = await run(
      rows(4),
      taggingDispatch((id) => `Theme ${id}`),
      async () => {
        throw new CanonicalizeTransportError("analysis_disabled");
      },
    ).catch((e: unknown) => (e as Error).message);

    expect(disabled).toBe("AI analysis is temporarily unavailable.");
  });

  it("says what to do when there are too many themes to group", async () => {
    const message = await run(
      rows(TOO_MANY_LABELS),
      taggingDispatch((id) => `Theme ${id}`),
      mergeNone,
    ).catch((e: unknown) => (e as Error).message);
    expect(message).toMatch(/smaller selection/i);
    expect(message).not.toMatch(/batch|chunk|level/i);
  });

  it("never forwards a raw thrown message from the transport", async () => {
    const error = await run(rows(4), taggingDispatch((id) => `Theme ${id}`), async () => {
      throw new TypeError("Failed to fetch https://internal.example.com/v1?key=abc");
    }).catch((e: unknown) => e);

    expect((error as Error).message).not.toContain("internal.example.com");
    expect((error as Error).message).not.toContain("key=abc");
  });
});

// --- progress reporting ------------------------------------------------------

describe("progress reporting", () => {
  /** Collect every progress update a run emits. */
  async function collect(
    reviewRows: IncomingReview[],
    analyze: Dispatch,
    canonicalize: CanonicalizeDispatch,
  ) {
    const updates: AnalysisProgress[] = [];
    const result = await runClaudePipeline(reviewRows, {
      analyze,
      canonicalize,
      makeRunId: () => "run-1",
      onProgress: (p) => updates.push(p),
    });
    return { updates, result };
  }

  it("reports the four phases in order", async () => {
    const { updates } = await collect(
      rows(MAX_ROWS_PER_BATCH_REQUEST * 2),
      taggingDispatch((id) => `Theme ${id}`),
      mergeAll,
    );

    const phases = [...new Set(updates.map((u) => u.phase))];
    expect(phases).toEqual([
      "preparing",
      "analyzing-reviews",
      "grouping-themes",
      "building-report",
    ]);
  });

  it("never moves backward across a whole run", async () => {
    const { updates } = await collect(
      rows(MAX_ROWS_PER_BATCH_REQUEST * 3),
      taggingDispatch((id) => `Theme ${id}`),
      mergeAll,
    );

    let previous: AnalysisProgress | null = null;
    for (const update of updates) {
      expect(isProgressAdvance(previous, update), `${update.phase}@${update.rowsCompleted}`).toBe(
        true,
      );
      previous = update;
    }
    expect(updates.length).toBeGreaterThan(4);
  });

  it("reports the selection size as the total from the very first update", async () => {
    const rowCount = MAX_ROWS_PER_BATCH_REQUEST + 5;
    const { updates } = await collect(
      rows(rowCount),
      taggingDispatch((id) => `Theme ${id}`),
      mergeAll,
    );

    // Fixed at the start, so a percentage built on it cannot slide.
    for (const update of updates) expect(update.rowsTotal).toBe(rowCount);
    expect(updates[0]!.phase).toBe("preparing");
    expect(updates[0]!.rowsCompleted).toBe(0);
  });

  it("holds rows at the total once tagging is done", async () => {
    const rowCount = MAX_ROWS_PER_BATCH_REQUEST * 2;
    const { updates } = await collect(
      rows(rowCount),
      taggingDispatch((id) => `Theme ${id}`),
      mergeAll,
    );

    // Grouping and report-building are not per-row work, so the count must not
    // reset to zero and imply the run started over.
    for (const update of updates) {
      if (phaseIndex(update.phase) >= phaseIndex("grouping-themes")) {
        expect(update.rowsCompleted).toBe(rowCount);
      }
    }
  });

  it("reaches building-report only after grouping has finished", async () => {
    const order: string[] = [];
    const canonicalize: CanonicalizeDispatch = async (labels) => {
      order.push("grouping");
      return { groups: [labels.map((_, i) => i)] };
    };
    const updates: AnalysisProgress[] = [];
    await runClaudePipeline(rows(6), {
      analyze: taggingDispatch((id) => `Theme ${id}`),
      canonicalize,
      makeRunId: () => "run-1",
      onProgress: (p) => {
        if (p.phase === "building-report") order.push("building");
      },
    });
    void updates;
    expect(order).toEqual(["grouping", "building"]);
  });

  it("emits nothing once a stage fails", async () => {
    const updates: AnalysisProgress[] = [];
    await runClaudePipeline(rows(4), {
      analyze: taggingDispatch((id) => `Theme ${id}`),
      canonicalize: async () => {
        throw new CanonicalizeTransportError("provider_unavailable");
      },
      makeRunId: () => "run-1",
      onProgress: (p) => updates.push(p),
    }).catch(() => {});

    // Grouping was reached and failed, so the run never claims to be building a
    // report it will not produce.
    expect(updates.some((u) => u.phase === "grouping-themes")).toBe(true);
    expect(updates.some((u) => u.phase === "building-report")).toBe(false);
  });

  it("runs identically when no reporter is supplied", async () => {
    const withReporter = await collect(
      rows(8),
      taggingDispatch((id) => `Theme ${id}`),
      mergeAll,
    );
    const without = await runClaudePipeline(rows(8), {
      analyze: taggingDispatch((id) => `Theme ${id}`),
      canonicalize: mergeAll,
      makeRunId: () => "run-1",
    });
    expect(without.tags).toEqual(withReporter.result.tags);
  });

  it("reports no progress at all for an empty selection", async () => {
    const { updates } = await collect([], taggingDispatch(() => "T"), mergeAll);
    expect(updates).toEqual([]);
  });
});
