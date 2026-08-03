import { defineConfig } from "vitest/config";

/**
 * Config for the PAID acceptance gate only.
 *
 * The gate makes real, billable Anthropic requests, so it must never run as
 * part of `npm test`. Two things keep that true: the gate file is named
 * `*.gate.ts` rather than `*.test.ts`, so vitest's default include cannot match
 * it, and this config — which must be passed explicitly — includes nothing
 * else. Removing either one is not enough to run it by accident.
 */
export default defineConfig({
  test: {
    include: ["scripts/acceptance-gate.gate.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
