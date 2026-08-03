import { describe, it, expect } from "vitest";
import {
  DEFAULT_ESTIMATOR_CONFIG,
  ENVIRONMENT_CEILINGS,
  ceilingRefusalMessage,
  estimateRun,
  projectBatchCount,
  projectCanonicalization,
  type EstimatorConfig,
  type RunEnvironment,
} from "./runEstimator";
import { DEFAULT_PLANNER_CONFIG } from "./batchPlanner";
import type { IncomingReview } from "./claudeTags";

function rows(count: number, textLength = 100): IncomingReview[] {
  return Array.from({ length: count }, (_, i) => ({ id: `r${i}`, text: "x".repeat(textLength) }));
}

const cost = (n: number, len = 100, env: RunEnvironment = "local", cfg?: EstimatorConfig) =>
  estimateRun(rows(n, len), env, cfg ?? DEFAULT_ESTIMATOR_CONFIG).cost.totalUsd;

// --- monotonicity ------------------------------------------------------------

describe("cost never decreases as work increases", () => {
  it("is non-decreasing in row count", () => {
    const counts = [0, 1, 5, 10, 25, 50, 100, 250, 500];
    const costs = counts.map((n) => cost(n));
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]!).toBeGreaterThanOrEqual(costs[i - 1]!);
    }
  });

  it("is non-decreasing in text bytes at a fixed row count", () => {
    const lengths = [10, 50, 100, 500, 1000, 4000];
    const costs = lengths.map((len) => cost(50, len));
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]!).toBeGreaterThanOrEqual(costs[i - 1]!);
    }
  });

  it("is non-decreasing in the retry allowance", () => {
    const allowances = [0, 0.05, 0.1, 0.25, 0.5, 1];
    const costs = allowances.map(
      (retryAllowance) => cost(100, 500, "local", { ...DEFAULT_ESTIMATOR_CONFIG, retryAllowance }),
    );
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]!).toBeGreaterThanOrEqual(costs[i - 1]!);
    }
    expect(costs.at(-1)!).toBeGreaterThan(costs[0]!);
  });

  it("is non-decreasing as canonicalization work increases", () => {
    const ratios = [0.1, 0.25, 0.5, 0.75, 1];
    const costs = ratios.map(
      (distinctLabelRatio) =>
        cost(200, 500, "local", { ...DEFAULT_ESTIMATOR_CONFIG, distinctLabelRatio }),
    );
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]!).toBeGreaterThanOrEqual(costs[i - 1]!);
    }
    expect(costs.at(-1)!).toBeGreaterThan(costs[0]!);
  });

  it("is non-decreasing when a smaller batch size forces more prompt overhead", () => {
    // Fewer rows per batch means more batches, and every batch pays the system
    // prompt again. Cost must rise, never fall.
    const sizes = [12, 8, 5, 3, 2, 1];
    const costs = sizes.map(
      (pessimisticRowsPerBatch) =>
        cost(300, 300, "local", { ...DEFAULT_ESTIMATOR_CONFIG, pessimisticRowsPerBatch }),
    );
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]!).toBeGreaterThanOrEqual(costs[i - 1]!);
    }
  });
});

// --- the two batch counts ----------------------------------------------------

describe("projected and conservative batch counts", () => {
  it("exposes both, and the conservative count is never lower", () => {
    for (const [n, len] of [
      [25, 113],
      [100, 500],
      [526, 970],
    ] as const) {
      const e = estimateRun(rows(n, len), "local");
      expect(e.projectedBatchCount).toBeGreaterThan(0);
      expect(e.conservativeBatchCount).toBeGreaterThanOrEqual(e.projectedBatchCount);
    }
  });

  it("derives the conservative count from the pessimistic size, not the planner minimum", () => {
    const e = estimateRun(rows(300, 300), "local");
    expect(e.conservativeBatchCount).toBe(
      Math.max(
        Math.ceil(300 / DEFAULT_ESTIMATOR_CONFIG.pessimisticRowsPerBatch),
        e.projectedBatchCount,
      ),
    );
    // If it used the planner's minimum of 1, this would be 300 — an inflated
    // figure nobody would believe.
    expect(DEFAULT_ESTIMATOR_CONFIG.pessimisticRowsPerBatch).toBeGreaterThan(
      DEFAULT_PLANNER_CONFIG.minRowsPerBatch,
    );
    expect(e.conservativeBatchCount).toBeLessThan(300);
  });

  it("matches a dry planner drain for the projected count", () => {
    expect(estimateRun(rows(90, 400), "local").projectedBatchCount).toBe(
      projectBatchCount(rows(90, 400)),
    );
  });

  it("reports zero batches and zero cost for an empty selection", () => {
    const e = estimateRun([], "local");
    expect(e.projectedBatchCount).toBe(0);
    expect(e.conservativeBatchCount).toBe(0);
    expect(e.cost.totalUsd).toBe(0);
    expect(e.runtime.expectedMs).toBe(0);
    expect(e.requiresConfirmation).toBe(false);
  });

  it("projects a ramping planner, not one pinned at the calibration size", () => {
    // Draining without feeding observations back would leave every batch at the
    // calibration size, over-reporting batches badly. The projection must be
    // meaningfully smaller than that.
    const n = 300;
    const pinned = Math.ceil(n / DEFAULT_PLANNER_CONFIG.calibrationRows);
    expect(projectBatchCount(rows(n, 300))).toBeLessThan(pinned / 2);
  });
});

// --- environment ceilings ----------------------------------------------------

describe("protected-demo and local ceilings stay separate", () => {
  it("uses different row ceilings and confirmation thresholds", () => {
    expect(ENVIRONMENT_CEILINGS["protected-demo"].maxRows).not.toBe(
      ENVIRONMENT_CEILINGS.local.maxRows,
    );
    expect(ENVIRONMENT_CEILINGS["protected-demo"].confirmAboveUsd).not.toBe(
      ENVIRONMENT_CEILINGS.local.confirmAboveUsd,
    );
    expect(ENVIRONMENT_CEILINGS["protected-demo"].maxRows).toBeLessThan(
      ENVIRONMENT_CEILINGS.local.maxRows,
    );
  });

  it("refuses a selection the demo forbids but local allows", () => {
    const selection = rows(200, 300);
    expect(estimateRun(selection, "protected-demo").exceedsCeiling).toBe(true);
    expect(estimateRun(selection, "local").exceedsCeiling).toBe(false);
  });

  it("reports the ceiling it applied, so the two can never be confused downstream", () => {
    expect(estimateRun(rows(10), "protected-demo").ceiling).toEqual(
      ENVIRONMENT_CEILINGS["protected-demo"],
    );
    expect(estimateRun(rows(10), "local").ceiling).toEqual(ENVIRONMENT_CEILINGS.local);
  });

  it("does not exceed the ceiling exactly at the limit", () => {
    const max = ENVIRONMENT_CEILINGS["protected-demo"].maxRows;
    expect(estimateRun(rows(max), "protected-demo").exceedsCeiling).toBe(false);
    expect(estimateRun(rows(max + 1), "protected-demo").exceedsCeiling).toBe(true);
  });

  it("names the real count and the limit when refusing", () => {
    const e = estimateRun(rows(200, 300), "protected-demo");
    const message = ceilingRefusalMessage(e);
    expect(message).toContain("200");
    expect(message).toContain(String(ENVIRONMENT_CEILINGS["protected-demo"].maxRows));
    expect(message).toMatch(/heuristic engine/);
  });
});

// --- confirmation ------------------------------------------------------------

describe("confirmation threshold", () => {
  it("does not ask for confirmation on the demo's own dataset", () => {
    // The deployed demo's largest category is a handful of light rows.
    const e = estimateRun(rows(9, 110), "protected-demo");
    expect(e.cost.totalUsd).toBeLessThan(ENVIRONMENT_CEILINGS["protected-demo"].confirmAboveUsd);
    expect(e.requiresConfirmation).toBe(false);
  });

  it("asks for confirmation on a large local category", () => {
    const e = estimateRun(rows(526, 970), "local");
    expect(e.requiresConfirmation).toBe(true);
    expect(e.cost.totalUsd).toBeGreaterThan(1);
  });

  it("applies each environment's own threshold to the same selection", () => {
    const selection = rows(40, 400);
    const demo = estimateRun(selection, "protected-demo");
    const local = estimateRun(selection, "local");
    expect(demo.cost.totalUsd).toBeCloseTo(local.cost.totalUsd, 10);
    // Same cost, different gate — the thresholds are genuinely independent.
    expect(demo.requiresConfirmation).toBe(
      demo.cost.totalUsd > ENVIRONMENT_CEILINGS["protected-demo"].confirmAboveUsd,
    );
    expect(local.requiresConfirmation).toBe(
      local.cost.totalUsd > ENVIRONMENT_CEILINGS.local.confirmAboveUsd,
    );
  });
});

// --- cost composition --------------------------------------------------------

describe("cost is a ceiling, and its parts are visible", () => {
  it("sums to the total", () => {
    const { cost: c } = estimateRun(rows(150, 600), "local");
    expect(c.taggingUsd + c.canonicalizationUsd + c.retryAllowanceUsd).toBeCloseTo(c.totalUsd, 10);
  });

  it("charges prompt overhead once per conservative batch, exactly", () => {
    // Isolated by varying the batch COUNT rather than the prompt constant:
    // canonicalization also pays systemPromptTokens, so zeroing that constant
    // would move both terms and pass even if tagging overhead were dropped.
    const of = (pessimisticRowsPerBatch: number) =>
      estimateRun(rows(60, 200), "local", {
        ...DEFAULT_ESTIMATOR_CONFIG,
        pessimisticRowsPerBatch,
      });
    const few = of(12);
    const many = of(2);

    expect(many.conservativeBatchCount).toBeGreaterThan(few.conservativeBatchCount);

    const extraBatches = many.conservativeBatchCount - few.conservativeBatchCount;
    const expectedDelta =
      ((extraBatches * DEFAULT_ESTIMATOR_CONFIG.systemPromptTokens) / 1e6) *
      DEFAULT_ESTIMATOR_CONFIG.inputUsdPerMTok;
    // The whole difference must be prompt overhead and nothing else.
    expect(many.cost.taggingUsd - few.cost.taggingUsd).toBeCloseTo(expectedDelta, 10);
    expect(expectedDelta).toBeGreaterThan(0);
  });

  it("charges a second canonicalization level once labels exceed the request bound", () => {
    const small = estimateRun(rows(60, 300), "local").cost.canonicalizationUsd;
    const large = estimateRun(rows(2000, 300), "local").cost.canonicalizationUsd;
    expect(large).toBeGreaterThan(small);
  });

  it("over-states rather than under-states: the conservative count drives cost", () => {
    // Cost computed from the projected count would be lower, because the
    // projection assumes larger batches and therefore less prompt overhead.
    const e = estimateRun(rows(300, 300), "local");
    const overheadConservative = e.conservativeBatchCount * DEFAULT_ESTIMATOR_CONFIG.systemPromptTokens;
    const overheadProjected = e.projectedBatchCount * DEFAULT_ESTIMATOR_CONFIG.systemPromptTokens;
    expect(overheadConservative).toBeGreaterThanOrEqual(overheadProjected);
  });
});

// --- runtime -----------------------------------------------------------------

describe("runtime is a range built from the projection", () => {
  it("returns low <= expected <= high", () => {
    const { runtime } = estimateRun(rows(200, 500), "local");
    expect(runtime.lowMs).toBeLessThanOrEqual(runtime.expectedMs);
    expect(runtime.expectedMs).toBeLessThanOrEqual(runtime.highMs);
  });

  it("grows with the number of concurrency waves", () => {
    const narrow = estimateRun(rows(200, 500), "local", {
      ...DEFAULT_ESTIMATOR_CONFIG,
      concurrency: 1,
    }).runtime.expectedMs;
    const wide = estimateRun(rows(200, 500), "local", {
      ...DEFAULT_ESTIMATOR_CONFIG,
      concurrency: 12,
    }).runtime.expectedMs;
    expect(narrow).toBeGreaterThan(wide);
  });

  it("includes canonicalization time", () => {
    const withCanon = estimateRun(rows(200, 500), "local").runtime.expectedMs;
    const withoutCanon = estimateRun(rows(200, 500), "local", {
      ...DEFAULT_ESTIMATOR_CONFIG,
      distinctLabelRatio: 0,
    }).runtime.expectedMs;
    expect(withCanon).toBeGreaterThan(withoutCanon);
  });

  it("puts the demo's largest category in tens of seconds, not minutes", () => {
    const { runtime } = estimateRun(rows(9, 110), "protected-demo");
    expect(runtime.highMs).toBeLessThan(60_000);
  });
});

// --- scope -------------------------------------------------------------------

describe("scope: estimation only", () => {
  it("reaches no network, no UI, and dispatches nothing", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./runEstimator.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/XMLHttpRequest|localStorage|document\./);
    expect(source).not.toMatch(/\/api\//);
    expect(source).not.toMatch(/Anthropic|anthropic/);
  });
});

// --- hierarchical canonicalization -------------------------------------------

describe("canonicalization is projected level by level", () => {
  const cfg = DEFAULT_ESTIMATOR_CONFIG;
  const bound = cfg.maxLabelsPerCanonicalizationRequest;

  it("uses a single level while the labels fit one request", () => {
    const p = projectCanonicalization(bound, cfg);
    expect(p.levels).toHaveLength(1);
    expect(p.levels[0]!.requests).toBe(1);
    expect(p.levels[0]!.waves).toBe(1);
    expect(p.unsupported).toBe(false);
  });

  it("leaves the single-pass case priced exactly as before", () => {
    // The flat formula the earlier implementation used, which was correct for
    // one level: labels x per-label input + one system prompt, labels x output.
    const labels = bound - 1;
    const p = projectCanonicalization(labels, cfg);
    expect(p.totalInputTokens).toBe(
      labels * cfg.canonicalizationInputTokensPerLabel + cfg.systemPromptTokens,
    );
    expect(p.totalOutputTokens).toBe(labels * cfg.canonicalizationOutputTokensPerLabel);
  });

  it("adds a dependent second level as soon as the one-request bound is crossed", () => {
    const under = projectCanonicalization(bound, cfg);
    const over = projectCanonicalization(bound + 1, cfg);

    expect(under.levels).toHaveLength(1);
    expect(over.levels.length).toBeGreaterThan(1);
    // The second level consumes the first level's representatives.
    expect(over.levels[1]!.inputLabels).toBe(over.levels[0]!.representatives);
    expect(over.totalInputTokens).toBeGreaterThan(under.totalInputTokens);
    expect(over.totalOutputTokens).toBeGreaterThan(under.totalOutputTokens);

    // And the second level is genuinely dependent, so it adds wall-clock too:
    // at the crossing there is no extra parallelism to offset it.
    const runtimeOf = (p: typeof under) =>
      p.levels.reduce((m, l) => {
        const perRequest =
          cfg.timeToFirstTokenMs + (l.outputTokens / l.requests / cfg.outputTokensPerSecond) * 1000;
        return m + l.waves * perRequest;
      }, 0);
    expect(runtimeOf(over)).toBeGreaterThan(runtimeOf(under));
  });

  it("charges label tokens at EVERY level, not just the first", () => {
    const p = projectCanonicalization(bound * 3, cfg);
    expect(p.levels.length).toBeGreaterThan(1);
    for (const level of p.levels) {
      expect(level.inputTokens).toBeGreaterThan(level.requests * cfg.systemPromptTokens);
      expect(level.outputTokens).toBeGreaterThan(0);
    }
    // The regression this exists to prevent: totals must exceed a model that
    // counted only the original label set.
    const firstLevelOnly =
      p.levels[0]!.inputLabels * cfg.canonicalizationInputTokensPerLabel +
      p.levels.reduce((n, l) => n + l.requests, 0) * cfg.systemPromptTokens;
    expect(p.totalInputTokens).toBeGreaterThan(firstLevelOnly);
  });

  it("runs requests concurrently within a level and levels in sequence", () => {
    const p = projectCanonicalization(bound * 10, cfg);
    for (const level of p.levels) {
      expect(level.waves).toBe(Math.ceil(level.requests / cfg.concurrency));
    }
    // Strictly decreasing input across levels: each consumes the last's output.
    for (let i = 1; i < p.levels.length; i++) {
      expect(p.levels[i]!.inputLabels).toBeLessThan(p.levels[i - 1]!.inputLabels);
    }
  });

  it("never reduces COST as more levels are required", () => {
    // Tightening the per-request bound forces deeper hierarchies at fixed labels.
    // Depth cap lifted so every case converges: this measures cost, not depth.
    const bounds = [4000, 2000, 1000, 500, 300, 100];
    const results = bounds.map((maxLabelsPerCanonicalizationRequest) => {
      const c = { ...cfg, maxLabelsPerCanonicalizationRequest, maxCanonicalizationLevels: 10 };
      const p = projectCanonicalization(3000, c);
      expect(p.unsupported).toBe(false);
      return { levels: p.levels.length, input: p.totalInputTokens, output: p.totalOutputTokens };
    });
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.levels).toBeGreaterThanOrEqual(results[i - 1]!.levels);
      expect(results[i]!.input).toBeGreaterThanOrEqual(results[i - 1]!.input);
      expect(results[i]!.output).toBeGreaterThanOrEqual(results[i - 1]!.output);
    }
    expect(results.at(-1)!.levels).toBeGreaterThan(results[0]!.levels);
  });

  // Runtime does NOT share cost's monotonicity, and pretending otherwise would
  // bake a false invariant into the estimator. Requests inside a level run
  // concurrently, so splitting into finer chunks can finish SOONER even though
  // it adds a dependent level and always costs more. Measured: at 475 labels,
  // bound 300 gives 2 levels / 6,840 input tokens / 16.3s, while bound 100
  // gives 3 levels / 13,186 tokens / 10.5s — dearer and faster.
  it("can trade cost for wall-clock: finer chunks cost more and may run faster", () => {
    const of = (bound: number) => {
      const c = { ...cfg, maxLabelsPerCanonicalizationRequest: bound, maxCanonicalizationLevels: 10 };
      const p = projectCanonicalization(475, c);
      const ms = p.levels.reduce((m, l) => {
        const perRequest =
          c.timeToFirstTokenMs + (l.outputTokens / l.requests / c.outputTokensPerSecond) * 1000;
        return m + l.waves * perRequest;
      }, 0);
      return { levels: p.levels.length, input: p.totalInputTokens, ms };
    };
    const coarse = of(300);
    const fine = of(100);

    expect(fine.levels).toBeGreaterThan(coarse.levels);
    expect(fine.input).toBeGreaterThan(coarse.input); // always dearer
    expect(fine.ms).toBeLessThan(coarse.ms); // and, here, faster
  });

  it("reports unsupported when labels do not reduce within the depth cap", () => {
    const p = projectCanonicalization(100_000, { ...cfg, maxCanonicalizationLevels: 2 });
    expect(p.unsupported).toBe(true);
    // Still accounts for the levels it did project, rather than reporting zero.
    expect(p.totalInputTokens).toBeGreaterThan(0);
  });

  it("stops immediately at a fixed point where a level merges nothing", () => {
    // representativeRatio of 1 means no label is ever merged away, so no depth
    // of hierarchy can ever help. The depth cap is lifted deliberately: without
    // the fixed-point check the projection would grind out ten futile levels and
    // charge for every one of them, so this asserts it stops after the first.
    const p = projectCanonicalization(5000, {
      ...cfg,
      representativeRatio: 1,
      maxCanonicalizationLevels: 10,
    });
    expect(p.unsupported).toBe(true);
    expect(p.levels).toHaveLength(1);
    expect(p.levels[0]!.representatives).toBe(p.levels[0]!.inputLabels);
  });

  it("returns an empty projection for no labels", () => {
    const p = projectCanonicalization(0, cfg);
    expect(p.levels).toEqual([]);
    expect(p.totalInputTokens).toBe(0);
    expect(p.unsupported).toBe(false);
  });
});

describe("the run estimate consumes the canonicalization projection", () => {
  it("surfaces the projection, including the unsupported flag", () => {
    const e = estimateRun(rows(50, 300), "local");
    expect(e.canonicalization.levels.length).toBeGreaterThan(0);
    expect(e.canonicalization.unsupported).toBe(false);
  });

  it("prices a hierarchical run above a single-pass one", () => {
    const single = estimateRun(rows(300, 300), "local");
    const hierarchical = estimateRun(rows(300, 300), "local", {
      ...DEFAULT_ESTIMATOR_CONFIG,
      maxLabelsPerCanonicalizationRequest: 20,
      maxCanonicalizationLevels: 10,
    });
    expect(hierarchical.canonicalization.levels.length).toBeGreaterThan(
      single.canonicalization.levels.length,
    );
    expect(hierarchical.cost.canonicalizationUsd).toBeGreaterThan(single.cost.canonicalizationUsd);
    expect(hierarchical.cost.totalUsd).toBeGreaterThan(single.cost.totalUsd);
  });

  it("adds runtime when a run first crosses into a second level", () => {
    // A selection whose labels sit just past the one-request bound pays for a
    // dependent level with no extra parallelism to absorb it.
    const c = DEFAULT_ESTIMATOR_CONFIG;
    const under = estimateRun(rows(300, 300), "local", {
      ...c,
      maxLabelsPerCanonicalizationRequest: 10_000,
    });
    const over = estimateRun(rows(300, 300), "local", {
      ...c,
      maxLabelsPerCanonicalizationRequest: 300,
    });
    expect(under.canonicalization.levels).toHaveLength(1);
    expect(over.canonicalization.levels.length).toBeGreaterThan(1);
    expect(over.runtime.expectedMs).toBeGreaterThan(under.runtime.expectedMs);
  });
});
