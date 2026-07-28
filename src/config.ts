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
export type AnalysisEngine = "heuristic" | "claude";

export const ANALYSIS_ENGINE: AnalysisEngine =
  import.meta.env.VITE_ANALYSIS_ENGINE === "claude" ? "claude" : "heuristic";
