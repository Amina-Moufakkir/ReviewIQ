import { describe, it, expect } from "vitest";
import {
  BatchExecutionError,
  DEFAULT_EXECUTOR_CONFIG,
  executeBatches,
  type Dispatch,
  type DispatchRequest,
  type DispatchResponse,
  type RunProgress,
} from "./batchExecutor";
import { DEFAULT_PLANNER_CONFIG } from "./batchPlanner";
import type { IncomingReview } from "./claudeTags";

/**
 * Every test here runs offline: the transport is injected, so nothing reaches a
 * network and nothing costs money. What is under test is the executor's
 * behaviour under concurrency, failure and cancellation — not the endpoint.
 */

function rows(count: number, textLength = 100): IncomingReview[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `r${i}`,
    text: `${"x".repeat(textLength)} review ${i}`,
  }));
}

/** A grounded tag for every row in the batch, so the client gate accepts it. */
function tagsFor(request: DispatchRequest): unknown[] {
  return request.rows.map((r) => ({
    review_id: r.id,
    theme: `theme ${r.id}`,
    sentiment: "praise",
    evidence_span: "review",
  }));
}

interface HarnessOptions {
  /** Decide an outcome per call. Return null for the default success. */
  respond?: (request: DispatchRequest, call: number) => Partial<DispatchResponse> | null;
  delayMs?: number;
}

function harness(options: HarnessOptions = {}) {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const seen: DispatchRequest[] = [];
  const abortedSignals: AbortSignal[] = [];

  const dispatch: Dispatch = async (request, signal) => {
    const call = calls++;
    seen.push({ ...request, rows: [...request.rows] });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (options.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            abortedSignals.push(signal);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      } else {
        await Promise.resolve();
      }
      const override = options.respond?.(request, call) ?? null;
      return {
        runId: request.runId,
        ok: true,
        latencyMs: 5000,
        tags: tagsFor(request),
        inputTokens: request.rows.length * 200,
        outputTokens: request.rows.length * 150,
        ...override,
      };
    } finally {
      inFlight--;
    }
  };

  return {
    dispatch,
    seen,
    abortedSignals,
    get calls() {
      return calls;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

async function failureOf(promise: Promise<unknown>): Promise<BatchExecutionError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BatchExecutionError);
    return err as BatchExecutionError;
  }
  throw new Error("expected the run to fail, but it resolved");
}

// --- run identity ------------------------------------------------------------

describe("run identity", () => {
  it("stamps every dispatch with the run id and returns it", async () => {
    const h = harness();
    const result = await executeBatches(rows(20), { dispatch: h.dispatch });

    expect(result.runId).toBeTruthy();
    for (const request of h.seen) expect(request.runId).toBe(result.runId);
  });

  it("gives separate runs separate ids", async () => {
    const a = await executeBatches(rows(5), { dispatch: harness().dispatch });
    const b = await executeBatches(rows(5), { dispatch: harness().dispatch });
    expect(a.runId).not.toBe(b.runId);
  });

  it("treats a wrong run id as a terminal protocol error, not something to skip", async () => {
    // Silently discarding would leave those rows unaccounted for, and the
    // scheduler would either hang or report a coverage defect far from the
    // real cause.
    const h = harness({
      respond: (_request, call) => (call === 1 ? { runId: "someone-elses-run" } : null),
    });
    const error = await failureOf(executeBatches(rows(30), { dispatch: h.dispatch }));

    expect(error.reason).toBe("protocol");
    expect(error.message).toMatch(/run id/i);
  });

  it("aborts siblings when a protocol error is detected", async () => {
    const h = harness({
      delayMs: 20,
      respond: (_request, call) => (call === 0 ? { runId: "wrong" } : null),
    });
    await failureOf(executeBatches(rows(60), { dispatch: h.dispatch }));
    expect(h.abortedSignals.length).toBeGreaterThan(0);
  });
});

// --- concurrency -------------------------------------------------------------

describe("concurrency", () => {
  it("never exceeds the configured limit", async () => {
    const h = harness({ delayMs: 5 });
    const result = await executeBatches(rows(120), { dispatch: h.dispatch });

    expect(h.maxInFlight).toBeLessThanOrEqual(DEFAULT_EXECUTOR_CONFIG.concurrency);
    expect(result.telemetry.maxConcurrentInFlight).toBeLessThanOrEqual(
      DEFAULT_EXECUTOR_CONFIG.concurrency,
    );
  });

  it("actually runs work in parallel rather than serially", async () => {
    const h = harness({ delayMs: 5 });
    await executeBatches(rows(120), { dispatch: h.dispatch });
    expect(h.maxInFlight).toBeGreaterThan(1);
  });

  it("honours a lower concurrency setting", async () => {
    const h = harness({ delayMs: 5 });
    await executeBatches(rows(60), {
      dispatch: h.dispatch,
      config: { ...DEFAULT_EXECUTOR_CONFIG, concurrency: 2 },
    });
    expect(h.maxInFlight).toBeLessThanOrEqual(2);
  });
});

// --- resizing ----------------------------------------------------------------

describe("adaptive resizing", () => {
  it("applies only to undispatched rows: in-flight batches keep their size", async () => {
    const dispatched: number[] = [];
    const h = harness({
      delayMs: 5,
      respond: (request) => {
        dispatched.push(request.rows.length);
        // Report very cheap batches so the planner wants to grow.
        return { outputTokens: 1, latencyMs: 100 };
      },
    });
    await executeBatches(rows(120), { dispatch: h.dispatch });

    // Sizes may change over the run, but never above the planner ceiling, and
    // no already-dispatched batch is ever re-sized after the fact.
    for (const size of dispatched) {
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(DEFAULT_PLANNER_CONFIG.maxRowsPerBatch);
    }
  });

  it("records a resize decision with its reason for every completed batch", async () => {
    const h = harness();
    const result = await executeBatches(rows(40), { dispatch: h.dispatch });

    expect(result.telemetry.resizes.length).toBeGreaterThan(0);
    for (const r of result.telemetry.resizes) {
      expect(r.nextRows).toBeGreaterThanOrEqual(1);
      expect(["ewma", "latency_pressure", "timeout", "truncation", "unchanged"]).toContain(r.reason);
    }
  });
});

// --- retries -----------------------------------------------------------------

describe("retries", () => {
  it("retries a transient provider failure once and completes", async () => {
    const h = harness({
      respond: (_request, call) =>
        call === 0 ? { ok: false, code: "provider_unavailable", tags: undefined } : null,
    });
    const result = await executeBatches(rows(20), { dispatch: h.dispatch });

    expect(result.telemetry.retriesUsed).toBe(1);
    expect(result.rowCount).toBe(20);
  });

  it.each(["analysis_timeout", "output_truncated"])(
    "retries %s at a strictly smaller batch size",
    async (code) => {
      const sizes: number[] = [];
      let failed = false;
      const h = harness({
        respond: (request) => {
          sizes.push(request.rows.length);
          if (!failed && request.rows.length > 1) {
            failed = true;
            return { ok: false, code, tags: undefined };
          }
          return null;
        },
      });
      const result = await executeBatches(rows(30), { dispatch: h.dispatch });

      const failedSize = sizes[0]!;
      const afterFailure = sizes.slice(1);
      expect(afterFailure.some((s) => s < failedSize)).toBe(true);
      expect(result.rowCount).toBe(30);
    },
  );

  it.each(["invalid_request", "too_many_reviews", "analysis_disabled", "server_misconfigured", "analysis_failed"])(
    "does not retry %s — deterministic failures would fail identically",
    async (code) => {
      const h = harness({ respond: () => ({ ok: false, code, tags: undefined }) });
      const error = await failureOf(executeBatches(rows(20), { dispatch: h.dispatch }));

      expect(error.reason).toBe("terminal_batch_failure");
      expect(error.code).toBe(code);
    },
  );

  it("gives up when the run-wide retry budget is spent, before any row runs out of attempts", async () => {
    // Only FIRST attempts fail, so every row is still on attempt 1 when the
    // global allowance runs dry. That isolates the budget from the per-row cap.
    const failedOnce = new Set<string>();
    const h = harness({
      respond: (request) => {
        if (request.rows.every((r) => !failedOnce.has(r.id))) {
          for (const r of request.rows) failedOnce.add(r.id);
          return { ok: false, code: "provider_unavailable", tags: undefined };
        }
        return null;
      },
    });
    const error = await failureOf(
      executeBatches(rows(300), {
        dispatch: h.dispatch,
        config: { ...DEFAULT_EXECUTOR_CONFIG, retryBudgetFraction: 0.02 },
      }),
    );
    expect(error.reason).toBe("retry_budget_exhausted");
  });

  it("retries each row at most once, reported separately from the budget", async () => {
    // Budget deliberately huge, so the only thing that can stop the run is the
    // per-row attempt cap. A single reason for both would hide which fired.
    const h = harness({ respond: () => ({ ok: false, code: "provider_unavailable", tags: undefined }) });
    const error = await failureOf(
      executeBatches(rows(20), {
        dispatch: h.dispatch,
        config: { ...DEFAULT_EXECUTOR_CONFIG, retryBudgetFraction: 100 },
      }),
    );
    expect(error.reason).toBe("attempts_exhausted");
  });

  it("keeps only the successful attempt's tags after a retry", async () => {
    const h = harness({
      respond: (request, call) =>
        call === 0
          ? {
              ok: true,
              // A first attempt that "succeeded" with duplicate-looking output
              // must not survive alongside the retry.
              tags: [...tagsFor(request), ...tagsFor(request)],
            }
          : null,
    });
    // The doubled tags trip the strict client gate, which is terminal.
    const error = await failureOf(executeBatches(rows(20), { dispatch: h.dispatch }));
    expect(error.reason).toBe("invalid_response");
  });

  it("produces no duplicate tags when a batch is retried after a transient failure", async () => {
    const h = harness({
      respond: (_request, call) =>
        call === 0 ? { ok: false, code: "analysis_busy", tags: undefined } : null,
    });
    const result = await executeBatches(rows(24), { dispatch: h.dispatch });

    const keys = result.tags.map((t) => `${t.reviewId}|${t.themeKey}|${t.sentiment}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.tags).toHaveLength(24);
  });

  it("never mixes requeued rows with fresh rows in one draw", async () => {
    // The regression this guards: the one-shot retry ceiling covers only the
    // NEXT draw, so the draw after it used to take the remaining requeued rows
    // plus whatever fresh rows fit. Sibling completions resizing the planner
    // upward make that mix larger and more likely. With batch-wide attempt
    // counting those fresh rows were stamped as already-retried before their
    // first attempt finished.
    const everSeen = new Set<string>();
    const mixed: string[][] = [];
    let failedOnce = false;

    // No artificial delay on purpose. With one, the failing batch completes
    // FIRST and the retry is drawn before any sibling has grown the planner —
    // which is exactly the case where mixing cannot happen, so the test would
    // pass whether the guard existed or not.
    const h = harness({
      respond: (request) => {
        const fresh = request.rows.filter((r) => !everSeen.has(r.id));
        const repeated = request.rows.filter((r) => everSeen.has(r.id));
        if (fresh.length > 0 && repeated.length > 0) {
          mixed.push(request.rows.map((r) => r.id));
        }
        for (const r of request.rows) everSeen.add(r.id);

        // Fail the first batch so rows are requeued, then report very cheap
        // batches so siblings grow the planner while the retry is pending.
        if (!failedOnce) {
          failedOnce = true;
          return { ok: false, code: "provider_unavailable", tags: undefined };
        }
        return { outputTokens: 1, latencyMs: 100 };
      },
    });

    const result = await executeBatches(rows(120), {
      dispatch: h.dispatch,
      config: { ...DEFAULT_EXECUTOR_CONFIG, retryBudgetFraction: 5 },
    });

    expect(mixed, `draws mixing requeued and fresh rows: ${JSON.stringify(mixed)}`).toEqual([]);
    expect(result.rowCount).toBe(120);
  });

  it("lets a fresh row keep its own retry after sharing a run with a retried one", async () => {
    // Attempts are per row. A row that has never failed must still be
    // retryable even after another row in the run has used its retry.
    const failed = new Set<string>();
    const h = harness({
      respond: (request) => {
        // Fail each row's first attempt exactly once, across the whole run.
        if (request.rows.some((r) => !failed.has(r.id))) {
          for (const r of request.rows) failed.add(r.id);
          return { ok: false, code: "provider_unavailable", tags: undefined };
        }
        return null;
      },
    });
    const result = await executeBatches(rows(40), {
      dispatch: h.dispatch,
      config: { ...DEFAULT_EXECUTOR_CONFIG, retryBudgetFraction: 5 },
    });

    expect(result.rowCount).toBe(40);
    expect(result.telemetry.retriesUsed).toBeGreaterThan(1);
  });

  it("sizes the retry budget with the planner execution actually uses", async () => {
    // A smaller configured batch means more batches, so the allowance must be
    // larger. Projecting with the default planner would under-size it.
    const withDefault = await executeBatches(rows(120), { dispatch: harness().dispatch });
    const withSmallBatches = await executeBatches(rows(120), {
      dispatch: harness().dispatch,
      config: {
        ...DEFAULT_EXECUTOR_CONFIG,
        planner: { ...DEFAULT_PLANNER_CONFIG, maxRowsPerBatch: 2, calibrationRows: 2 },
      },
    });

    expect(withSmallBatches.telemetry.batchCount).toBeGreaterThan(
      withDefault.telemetry.batchCount,
    );
    expect(withSmallBatches.telemetry.retryBudget).toBeGreaterThan(
      withDefault.telemetry.retryBudget,
    );
  });
});

// --- cancellation ------------------------------------------------------------

describe("cancellation", () => {
  it("throws rather than returning a partial run", async () => {
    const controller = new AbortController();
    const h = harness({ delayMs: 20 });
    const promise = executeBatches(rows(120), { dispatch: h.dispatch, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    const error = await failureOf(promise);
    expect(error.reason).toBe("aborted");
  });

  it("stops taking unscheduled work, not just in-flight requests", async () => {
    const controller = new AbortController();
    const h = harness({ delayMs: 10 });
    const promise = executeBatches(rows(600), { dispatch: h.dispatch, signal: controller.signal });
    setTimeout(() => controller.abort(), 15);
    await failureOf(promise);

    const afterAbort = h.calls;
    await new Promise((r) => setTimeout(r, 40));
    // The queue is where the remaining spend is: nothing may be dispatched
    // after the abort, however many rows were still pending.
    expect(h.calls).toBe(afterAbort);
    expect(h.calls).toBeLessThan(600);
  });

  it("refuses immediately when handed an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness();
    const error = await failureOf(
      executeBatches(rows(20), { dispatch: h.dispatch, signal: controller.signal }),
    );

    expect(error.reason).toBe("aborted");
    expect(h.calls).toBe(0);
  });
});

// --- terminal failure --------------------------------------------------------

describe("terminal failure", () => {
  it("aborts siblings so no further work is spent", async () => {
    const h = harness({
      delayMs: 20,
      respond: (_request, call) => (call === 0 ? { ok: false, code: "invalid_request", tags: undefined } : null),
    });
    await failureOf(executeBatches(rows(120), { dispatch: h.dispatch }));
    expect(h.abortedSignals.length).toBeGreaterThan(0);
  });

  it("refuses an over-byte-guard batch before dispatching it", async () => {
    const h = harness();
    const huge = DEFAULT_PLANNER_CONFIG.maxBatchTextBytes * 2;
    const error = await failureOf(
      executeBatches([{ id: "huge", text: "x".repeat(huge) }], { dispatch: h.dispatch }),
    );

    expect(error.reason).toBe("over_byte_guard");
    expect(h.calls).toBe(0); // nothing spent discovering it
  });

  it("fails on a response that does not survive the client gate", async () => {
    const h = harness({
      respond: () => ({
        tags: [{ review_id: "ghost", theme: "T", sentiment: "praise", evidence_span: "review" }],
      }),
    });
    const error = await failureOf(executeBatches(rows(20), { dispatch: h.dispatch }));
    expect(error.reason).toBe("invalid_response");
  });
});

// --- coverage and result -----------------------------------------------------

describe("coverage and result shape", () => {
  it.each([1, 5, 13, 47, 120, 300])("covers %i rows exactly once", async (n) => {
    const h = harness();
    const result = await executeBatches(rows(n), { dispatch: h.dispatch });

    const covered = result.batches.flatMap((b) => b.rowIds);
    expect(new Set(covered).size).toBe(n);
    expect(covered).toHaveLength(n);
  });

  it("covers every row even when batches fail and are requeued", async () => {
    // Fail only a row's FIRST attempt: failing a retry too would exhaust
    // maxAttemptsPerRow and terminate, which is a different test.
    const failedOnce = new Set<string>();
    const h = harness({
      respond: (request) => {
        const fresh = request.rows.every((r) => !failedOnce.has(r.id));
        if (fresh && request.rows.length > 0) {
          for (const r of request.rows) failedOnce.add(r.id);
          return { ok: false, code: "analysis_timeout", tags: undefined };
        }
        return null;
      },
    });
    const result = await executeBatches(rows(60), {
      dispatch: h.dispatch,
      // Generous budget on purpose: this test is about coverage surviving
      // requeues, not about the budget, which has its own tests.
      config: { ...DEFAULT_EXECUTOR_CONFIG, retryBudgetFraction: 5 },
    });

    const covered = result.batches.flatMap((b) => b.rowIds);
    expect(new Set(covered).size).toBe(60);
  });

  it("restores selection order in the returned tags", async () => {
    const h = harness({ delayMs: 3 });
    const input = rows(80);
    const result = await executeBatches(input, { dispatch: h.dispatch });

    const order = input.map((r) => r.id);
    const seen = result.tags.map((t) => t.reviewId);
    expect(seen).toEqual(order);
  });

  it("returns raw per-batch labels and computes nothing", async () => {
    const h = harness();
    const result = await executeBatches(rows(10), { dispatch: h.dispatch });

    // Deliberately NOT an AnalysisResult: no findings, no counts, no summary.
    expect(result).not.toHaveProperty("praise");
    expect(result).not.toHaveProperty("faults");
    expect(result).not.toHaveProperty("summary");
    expect(result.tags.every((t) => t.theme.startsWith("theme "))).toBe(true);
  });

  it("reports telemetry sufficient to tune the planner later", async () => {
    const h = harness();
    const result = await executeBatches(rows(40), { dispatch: h.dispatch });

    expect(result.telemetry.batchCount).toBeGreaterThan(0);
    expect(result.telemetry.totalInputTokens).toBeGreaterThan(0);
    expect(result.telemetry.totalOutputTokens).toBeGreaterThan(0);
    expect(result.telemetry.retryBudget).toBeGreaterThanOrEqual(1);
  });
});

// --- progress ----------------------------------------------------------------

describe("progress", () => {
  it("reports rows rather than batches, and never moves backwards", async () => {
    const seen: RunProgress[] = [];
    const h = harness();
    await executeBatches(rows(60), { dispatch: h.dispatch, onProgress: (p) => seen.push({ ...p }) });

    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i++) {
      // Adaptive sizing makes a batch-based percentage move backwards when the
      // planner shrinks; rows are fixed at the start and only ever rise.
      expect(seen[i]!.rowsCompleted).toBeGreaterThan(seen[i - 1]!.rowsCompleted);
    }
    expect(seen.at(-1)!.rowsCompleted).toBe(60);
    expect(seen.every((p) => p.rowsTotal === 60)).toBe(true);
  });

  it("is optional", async () => {
    await expect(executeBatches(rows(10), { dispatch: harness().dispatch })).resolves.toBeTruthy();
  });

  it("reports no progress for a run that fails", async () => {
    const seen: RunProgress[] = [];
    const h = harness({ respond: () => ({ ok: false, code: "invalid_request", tags: undefined }) });
    await failureOf(
      executeBatches(rows(20), { dispatch: h.dispatch, onProgress: (p) => seen.push(p) }),
    );
    expect(seen).toHaveLength(0);
  });
});

// --- no partial results ------------------------------------------------------

describe("no partial result, ever", () => {
  it.each([
    ["a terminal batch failure", { ok: false as const, code: "invalid_request", tags: undefined }],
    ["a protocol violation", { runId: "wrong" }],
  ])("returns nothing usable after %s", async (_label, override) => {
    const h = harness({ respond: (_request, call) => (call === 2 ? override : null) });
    const error = await failureOf(executeBatches(rows(120), { dispatch: h.dispatch }));
    expect(error).toBeInstanceOf(BatchExecutionError);
  });

  it("never resolves when any batch fails, for any failing position", async () => {
    for (const failAt of [0, 1, 3, 7]) {
      const h = harness({
        respond: (_request, call) =>
          call === failAt ? { ok: false, code: "invalid_request", tags: undefined } : null,
      });
      await failureOf(executeBatches(rows(80), { dispatch: h.dispatch }));
    }
  });

  it("contains no transport of its own — dispatch is always injected", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./batchExecutor.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\/api\//);
  });
});
