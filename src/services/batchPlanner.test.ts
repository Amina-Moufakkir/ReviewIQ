import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLANNER_CONFIG,
  beginPlan,
  nextBatch,
  observe,
  seedDensity,
  textBytesOf,
  checkCoverage,
  type Batch,
  type BatchObservation,
  type PlanState,
  type PlannerConfig,
} from "./batchPlanner";
import type { IncomingReview } from "./claudeTags";

/** Rows of a given text length, ids in order, so coverage is checkable by id. */
function rows(count: number, textLength = 100, prefix = "r"): IncomingReview[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    text: "x".repeat(textLength),
  }));
}

const ok = (over: Partial<BatchObservation> = {}): BatchObservation => ({
  rows: 5,
  outputTokens: 1000,
  latencyMs: 8000,
  outcome: "ok",
  ...over,
});

/**
 * Drain a plan to completion, feeding the same observation after each batch.
 * Returns every batch produced, so coverage can be asserted over the whole run.
 */
function drain(
  state: PlanState,
  observationFor: (batch: Batch) => BatchObservation | null = () => null,
): Batch[] {
  const produced: Batch[] = [];
  let current = state;
  // Bounded so a planning bug fails the test rather than hanging the suite.
  for (let guard = 0; guard < 10_000; guard++) {
    const step = nextBatch(current);
    if (!step) return produced;
    produced.push(step.batch);
    current = step.state;
    const observation = observationFor(step.batch);
    if (observation) current = observe(current, observation).state;
  }
  throw new Error("planner did not terminate");
}

// --- coverage and ordering ---------------------------------------------------

describe("exactly-once coverage", () => {
  it.each([0, 1, 2, 5, 13, 47, 100, 526])("covers %i rows exactly once, in order", (n) => {
    const input = rows(n);
    const batches = drain(beginPlan(input));
    expect(checkCoverage(input, batches)).toBeNull();
    expect(batches.flatMap((b) => b.rows.map((r) => r.id))).toEqual(input.map((r) => r.id));
  });

  it("covers every row even while the size is being resized mid-run", () => {
    const input = rows(200);
    const batches = drain(beginPlan(input), (b) =>
      // Alternate pressure so the planner grows, shrinks and halves during one run.
      b.index % 3 === 0
        ? ok({ rows: b.rows.length, outputTokens: 200, latencyMs: 2000 })
        : b.index % 3 === 1
          ? ok({ rows: b.rows.length, outcome: "timeout", latencyMs: 30_000 })
          : ok({ rows: b.rows.length, outputTokens: 5000, latencyMs: 25_000 }),
    );
    expect(checkCoverage(input, batches)).toBeNull();
  });

  it("assigns sequential batch indices", () => {
    const batches = drain(beginPlan(rows(30)));
    expect(batches.map((b) => b.index)).toEqual(batches.map((_, i) => i));
  });

  it("reports missing, duplicated and reordered rows", () => {
    const input = rows(3);
    expect(checkCoverage(input, [{ index: 0, rows: input.slice(0, 2), textBytes: 0 }])).toMatchObject(
      { missing: ["r2"] },
    );
    expect(
      checkCoverage(input, [{ index: 0, rows: [...input, input[0]!], textBytes: 0 }]),
    ).toMatchObject({ duplicated: ["r0"] });
    expect(
      checkCoverage(input, [{ index: 0, rows: [input[1]!, input[0]!, input[2]!], textBytes: 0 }]),
    ).toMatchObject({ outOfOrder: true });
  });

  it("returns no batches for an empty selection", () => {
    expect(drain(beginPlan([]))).toEqual([]);
    expect(nextBatch(beginPlan([]))).toBeNull();
  });
});

// --- guards ------------------------------------------------------------------

describe("row and byte guards", () => {
  it("never exceeds maxRowsPerBatch, however large the estimate goes", () => {
    let state = beginPlan(rows(500, 10));
    // Report implausibly cheap batches, which would otherwise grow without bound.
    for (let i = 0; i < 20; i++) {
      state = observe(state, ok({ rows: 4, outputTokens: 1, latencyMs: 100 })).state;
    }
    const batches = drain(state);
    expect(Math.max(...batches.map((b) => b.rows.length))).toBeLessThanOrEqual(
      DEFAULT_PLANNER_CONFIG.maxRowsPerBatch,
    );
  });

  it("keeps a multi-row batch within the byte guard", () => {
    // 4 KB rows: at most 4 fit inside the 16 KB guard.
    const state = beginPlan(rows(40, 4096), { ...DEFAULT_PLANNER_CONFIG, calibrationRows: 12 });
    const batches = drain(state);
    for (const b of batches.filter((x) => x.rows.length > 1)) {
      expect(b.textBytes).toBeLessThanOrEqual(DEFAULT_PLANNER_CONFIG.maxBatchTextBytes);
    }
  });

  it("emits an oversized single row alone rather than stranding it", () => {
    // A row bigger than the whole byte budget must still be covered: dropping it
    // would break exactly-once coverage silently, which is worse than a request
    // the endpoint may reject visibly.
    const huge = DEFAULT_PLANNER_CONFIG.maxBatchTextBytes * 2;
    const input = [
      { id: "small", text: "x".repeat(10) },
      { id: "huge", text: "x".repeat(huge) },
      { id: "small2", text: "x".repeat(10) },
    ];
    const batches = drain(beginPlan(input));
    expect(checkCoverage(input, batches)).toBeNull();
    const hugeBatch = batches.find((b) => b.rows.some((r) => r.id === "huge"))!;
    expect(hugeBatch.rows).toHaveLength(1);
  });

  it("never emits an empty batch", () => {
    for (const b of drain(beginPlan(rows(50, 3000)))) {
      expect(b.rows.length).toBeGreaterThan(0);
    }
  });
});

// --- seeded density ----------------------------------------------------------

describe("seeded density", () => {
  // The seed comes from the byte-aware estimator validated in syncBudget.test.ts,
  // so it must land near the densities actually measured for each dataset shape.
  it("seeds near the measured ~405 tok/row for dense Amazon-shaped rows", () => {
    const dense = rows(5, 970); // ~4,851 bytes total, as measured
    expect(seedDensity(dense)).toBeGreaterThan(360);
    expect(seedDensity(dense)).toBeLessThan(440);
  });

  it("seeds near the measured ~136 tok/row for light synthetic rows", () => {
    const light = rows(25, 113); // ~2,825 bytes total, as measured
    expect(seedDensity(light)).toBeGreaterThan(115);
    expect(seedDensity(light)).toBeLessThan(160);
  });

  it("distinguishes the two, so a flat constant is not silently reintroduced", () => {
    expect(seedDensity(rows(5, 970))).toBeGreaterThan(seedDensity(rows(25, 113)) * 2);
  });

  it("is zero for an empty selection rather than dividing by zero", () => {
    expect(seedDensity([])).toBe(0);
  });
});

// --- resizing ----------------------------------------------------------------

describe("resizing", () => {
  const config: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG, calibrationRows: 6 };

  it("moves density toward the observation without jumping to it", () => {
    const state = beginPlan(rows(100, 970), config);
    const seeded = state.density;
    const next = observe(state, ok({ rows: 6, outputTokens: 600, latencyMs: 5000 })).state;
    const observed = 100;
    expect(next.density).toBeLessThan(seeded);
    expect(next.density).toBeGreaterThan(observed); // smoothed, not replaced
  });

  it("caps growth at maxGrowthFactor even when the budget allows far more", () => {
    const state = beginPlan(rows(100, 10), config);
    const before = state.rowsPerBatch;
    const next = observe(state, ok({ rows: before, outputTokens: 1, latencyMs: 500 })).state;
    expect(next.rowsPerBatch).toBeLessThanOrEqual(Math.ceil(before * config.maxGrowthFactor));
  });

  it("shrinks on latency pressure BEFORE anything fails", () => {
    const state = beginPlan(rows(100, 10), config);
    const result = observe(
      state,
      // Completed successfully, but slowly — the proactive signal.
      ok({ rows: 6, outputTokens: 900, latencyMs: 26_000 }),
    );
    expect(result.reason).toBe("latency_pressure");
    expect(result.state.rowsPerBatch).toBeLessThan(state.rowsPerBatch);
  });

  it("halves on timeout", () => {
    const state = beginPlan(rows(100, 10), config);
    const result = observe(state, ok({ rows: 6, outcome: "timeout", latencyMs: 30_000 }));
    expect(result.reason).toBe("timeout");
    expect(result.state.rowsPerBatch).toBe(Math.floor(state.rowsPerBatch / 2));
  });

  it("halves on truncation", () => {
    const state = beginPlan(rows(100, 10), config);
    const result = observe(state, ok({ rows: 6, outcome: "truncation", latencyMs: 12_000 }));
    expect(result.reason).toBe("truncation");
    expect(result.state.rowsPerBatch).toBe(Math.floor(state.rowsPerBatch / 2));
  });

  it("does not fold a failed batch's partial output into the density estimate", () => {
    const state = beginPlan(rows(100, 970), config);
    const after = observe(state, ok({ rows: 6, outputTokens: 5, outcome: "timeout" })).state;
    // A timed-out batch reports only what it managed to stream; treating that as
    // the density would make the planner grow precisely when it should shrink.
    expect(after.density).toBe(state.density);
  });

  it("never shrinks below one row", () => {
    let state = beginPlan(rows(100, 10), config);
    for (let i = 0; i < 12; i++) {
      state = observe(state, ok({ rows: 1, outcome: "timeout", latencyMs: 30_000 })).state;
    }
    expect(state.rowsPerBatch).toBe(1);
    expect(drain(state).every((b) => b.rows.length >= 1)).toBe(true);
  });

  it("reports 'unchanged' when the size does not move", () => {
    let state = beginPlan(rows(100, 970), config);
    let result = observe(state, ok({ rows: 6, outputTokens: 6 * 300, latencyMs: 9000 }));
    state = result.state;
    result = observe(state, ok({ rows: state.rowsPerBatch, outputTokens: state.rowsPerBatch * 300, latencyMs: 9000 }));
    expect(["unchanged", "ewma"]).toContain(result.reason);
    if (result.state.rowsPerBatch === state.rowsPerBatch) expect(result.reason).toBe("unchanged");
  });
});

// --- calibration and determinism ---------------------------------------------

describe("calibration and determinism", () => {
  it("starts with a small calibration batch so the first measurement is cheap", () => {
    const first = nextBatch(beginPlan(rows(100, 970)))!.batch;
    expect(first.rows).toHaveLength(DEFAULT_PLANNER_CONFIG.calibrationRows);
  });

  it("produces identical plans for identical inputs and observations", () => {
    const input = rows(120, 400);
    const shape = (b: Batch) => `${b.index}:${b.rows.map((r) => r.id).join(",")}`;
    const run = () =>
      drain(beginPlan(input), (b) =>
        ok({ rows: b.rows.length, outputTokens: b.rows.length * 250, latencyMs: 9000 }),
      ).map(shape);
    expect(run()).toEqual(run());
  });

  it("does not mutate the state it is given", () => {
    const state = beginPlan(rows(20));
    const snapshot = JSON.stringify(state);
    nextBatch(state);
    observe(state, ok());
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("computes text bytes as UTF-8, not character count", () => {
    // A planner that counted characters would under-size every non-ASCII batch.
    expect(textBytesOf([{ id: "a", text: "é" }])).toBe(2);
    expect(textBytesOf([{ id: "a", text: "🙂" }])).toBe(4);
  });
});

// --- scope -------------------------------------------------------------------

describe("scope: planning only", () => {
  it("reaches no network and touches no browser globals", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./batchPlanner.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/XMLHttpRequest|localStorage|document\./);
    expect(source).not.toMatch(/\/api\//);
  });
});
