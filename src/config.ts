/**
 * Build-time application configuration.
 *
 * `ANALYSIS_ENGINE` selects which engine `analyzeReviews()` uses. It is a plain
 * engine *name* (not a secret), so a `VITE_`-prefixed variable is appropriate:
 *   - unset / anything else → "heuristic" (the default; GitHub Pages ships this)
 *   - "claude"              → the Claude-powered engine, via /api/analyze
 *
 * The Claude API key is NEVER read here — it lives only in the server function's
 * environment (see api/analyze.ts). Nothing in this file is secret.
 */
import type { RunEnvironment } from "./services/runEstimator";
export type AnalysisEngine = "heuristic" | "claude";

export const ANALYSIS_ENGINE: AnalysisEngine =
  import.meta.env.VITE_ANALYSIS_ENGINE === "claude" ? "claude" : "heuristic";

/**
 * Which total-run ceiling applies: how large a selection may be submitted at all.
 *
 * Fail-closed, and deliberately so. Only the exact string "local" opts up to the
 * larger ceiling; every other value — unset, misspelt, empty, `"LOCAL"`, a stray
 * `"true"` — resolves to `protected-demo`, the SMALLER one. A misconfiguration
 * should cost an analyst a refusal they can see, not an oversized paid run
 * nobody authorized. This mirrors how ANALYSIS_ENGINE defaults to the engine
 * that spends nothing.
 *
 * Separated from the constant so the rule can be tested directly rather than
 * through whatever `import.meta.env` happens to hold when the suite runs.
 *
 * This is not the per-request row limit and not the planner's batch size. The
 * three answer different questions and must never become interchangeable —
 * see `maxRowsPerAnalysis` in runEstimator.ts.
 */
export function resolveRunEnvironment(value: unknown): RunEnvironment {
  return value === "local" ? "local" : "protected-demo";
}

export const RUN_ENVIRONMENT: RunEnvironment = resolveRunEnvironment(
  import.meta.env.VITE_RUN_ENVIRONMENT,
);
