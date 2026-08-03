import { describe, it, expect } from "vitest";
import { resolveRunEnvironment } from "./config";
import { ENVIRONMENT_CEILINGS, maxRowsPerAnalysis } from "./services/runEstimator";

/**
 * The run-environment boundary, tested as a pure function.
 *
 * It decides how large a selection may be submitted at all, which is the only
 * thing standing between a misconfigured deployment and an oversized paid run.
 * So the rule is fail-closed: ONLY the exact string "local" opts up to the
 * larger ceiling, and everything else — unset, empty, misspelt, differently
 * cased, or an outright wrong type — resolves to the smaller one.
 *
 * Tested directly rather than through `import.meta.env`, which cannot be varied
 * per case at runtime and would leave the interesting values unexercised.
 */

describe("resolveRunEnvironment — only one value opts up", () => {
  it("resolves the exact string to local", () => {
    expect(resolveRunEnvironment("local")).toBe("local");
  });

  it.each([
    ["undefined (variable unset)", undefined],
    ["null", null],
    ["an empty string", ""],
    ["whitespace", " "],
    ["padded", " local "],
    ["uppercase", "LOCAL"],
    ["title case", "Local"],
    ["a near miss", "locale"],
    ["a prefix", "loc"],
    ["a truthy unrelated string", "true"],
    ["the other environment's name", "protected-demo"],
    ["a boolean", true],
    ["a number", 1],
    ["an object", { environment: "local" }],
    ["an array", ["local"]],
  ])("falls closed to protected-demo for %s", (_name, value) => {
    expect(resolveRunEnvironment(value)).toBe("protected-demo");
  });

  it("is pure — the same input always gives the same answer", () => {
    for (const value of ["local", "nonsense", undefined]) {
      expect(resolveRunEnvironment(value)).toBe(resolveRunEnvironment(value));
    }
  });
});

describe("failing closed means the SMALLER ceiling", () => {
  it("resolves an unrecognised value to the more restrictive of the two", () => {
    // The direction is what matters. If protected-demo ever became the larger
    // ceiling, this rule would silently invert from "refuse" to "overspend",
    // and every test above would still pass.
    const fallback = resolveRunEnvironment("nonsense");
    const other = fallback === "local" ? "protected-demo" : "local";

    expect(maxRowsPerAnalysis(fallback)).toBeLessThan(maxRowsPerAnalysis(other));
  });

  it("resolves to the environment with the lower confirmation threshold too", () => {
    expect(ENVIRONMENT_CEILINGS[resolveRunEnvironment(undefined)].confirmAboveUsd).toBeLessThan(
      ENVIRONMENT_CEILINGS.local.confirmAboveUsd,
    );
  });

  it("covers every declared environment, so none can be unreachable", () => {
    const declared = Object.keys(ENVIRONMENT_CEILINGS);
    const reachable = new Set(declared.map((name) => resolveRunEnvironment(name)));
    // Adding an environment to ENVIRONMENT_CEILINGS without teaching this
    // resolver about it would leave it silently unreachable — the deployment
    // would run under a ceiling nobody chose.
    expect([...reachable].sort()).toEqual([...declared].sort());
  });
});
