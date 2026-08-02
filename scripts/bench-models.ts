/**
 * Local model benchmark for ReviewIQ's Claude tagging layer.
 *
 * Answers one question: which model should the protected portfolio demo set as
 * `ANTHROPIC_MODEL`? It is NOT a general model evaluation — every metric here is
 * one ReviewIQ actually depends on, and the disqualifiers are the endpoint's own
 * failure modes.
 *
 * Design commitments:
 *  - It sends the SAME prompt and generation parameters the endpoint sends, by
 *    importing them from api/claudePrompt.ts. Nothing is copied.
 *  - It scores with the SAME validator the endpoint uses (validateTags,
 *    normalizeTheme). Grounding is measured, never judged.
 *  - No model grades another model. Every metric is computed in TypeScript from
 *    the tags, which is the same standard the product holds itself to.
 *  - It refuses any fixture the real endpoint would reject, so a result can
 *    never come from a request production could not have made.
 *
 * Local only. Never imported by the app, never run in CI, never deployed.
 *
 * Usage:
 *   node scripts/bench-models.ts            # dry run: real token counts, no generation, no cost
 *   node scripts/bench-models.ts --confirm  # execute (spends money, capped)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import {
  SYSTEM_PROMPT,
  buildUserContent,
  MAX_OUTPUT_TOKENS,
  CLAUDE_TIMEOUT_MS,
} from "../api/claudePrompt.ts";
import {
  validateTags,
  parseTagArray,
  stripCodeFence,
  MAX_REVIEWS_PER_REQUEST,
  MAX_REQUEST_BODY_BYTES,
  MAX_TOTAL_REVIEW_TEXT_BYTES,
  type ValidatedTag,
} from "../src/services/claudeTags.ts";
// The repo's own CSV reader. Fixture C is built with it rather than a
// hand-rolled parser so the text is exactly what the app would see.
import { parseCsv } from "../src/lib/csv.ts";

// --- configuration ----------------------------------------------------------

/**
 * Rates verified against platform.claude.com/docs/en/about-claude/pricing on
 * 2026-08-02, and both model ids verified to resolve against GET /v1/models on
 * the same day (`claude-haiku-4-5` resolves to `claude-haiku-4-5-20251001`).
 * Not taken from memory — re-verify before trusting a stale result file.
 *
 * Note: Claude 4.7-and-later use a newer tokenizer that produces roughly 30%
 * more tokens for the same text than Haiku 4.5's. The cost gap between these
 * two arms is therefore wider than the 5x rate ratio alone implies — which is
 * why every figure below comes from measured `usage`, never from an estimate.
 */
const ARMS = [
  // Cheapest arm first, deliberately: if the budget guard ever halts the run,
  // a complete picture of at least one model survives instead of two partials.
  { model: "claude-haiku-4-5", inputPerMTok: 1, outputPerMTok: 5 },
  { model: "claude-opus-4-8", inputPerMTok: 5, outputPerMTok: 25 },
] as const;

/** Hard ceiling on measured spend. Total spend is provably kept under this. */
const CEILING_USD = 2.0;

/**
 * The 30s abort bounds output far more tightly than MAX_OUTPUT_TOKENS does: a
 * request cannot emit more tokens than the model can stream before the wall.
 * 250 tok/s is a generous ceiling for Opus-class streaming (fixture A measured
 * ~115 tok/s), so this stays conservative while replacing the 16,000-token
 * figure, which a 30s request physically cannot reach. Budgeting against the
 * theoretical maximum would spend the ceiling on an outcome that cannot occur.
 */
const MAX_STREAM_TOKENS_PER_SEC = 250;
const MAX_OUTPUT_TOKENS_IN_WINDOW = Math.min(
  MAX_OUTPUT_TOKENS,
  (CLAUDE_TIMEOUT_MS / 1000) * MAX_STREAM_TOKENS_PER_SEC,
);

/** Conservative ceiling on what one request to `arm` over `inTok` can cost. */
function worstCostFor(arm: (typeof ARMS)[number], inTok: number): number {
  return (inTok / 1e6) * arm.inputPerMTok + (MAX_OUTPUT_TOKENS_IN_WINDOW / 1e6) * arm.outputPerMTok;
}

/**
 * Runs per (model, fixture). Three is the minimum that shows instability; the
 * real-shape fixture gets two because it is ~8x the cost of the others and two
 * runs still yield a stability pair and still expose output truncation.
 */
function runsFor(f: Fixture): number {
  return f.key === "real-shape" ? 2 : 3;
}

const ROOT = new URL("..", import.meta.url).pathname;
/** Authored fixtures — committed, they are the benchmark's ground truth. */
const FIXTURE_DIR = join(ROOT, "bench/fixtures");
/**
 * Timestamped raw output — gitignored. The committed artifact is
 * bench/DECISION.md, which records what was chosen and why; accumulating run
 * files in git would bury that record under noise.
 */
const RESULT_DIR = join(ROOT, "bench/results");

// --- fixtures ---------------------------------------------------------------

interface BenchReview {
  id: string;
  text: string;
}

interface Fixture {
  key: "mixed" | "clusters" | "real-shape";
  label: string;
  reviews: BenchReview[];
  /** Per-review labels, absent for the unlabelled real-shape fixture. */
  mixed?: MixedLabel[];
  clusters?: Map<string, string>;
}

interface MixedLabel {
  id: string;
  kind: "mixed" | "praise-only" | "fault-only";
  praiseClause?: string;
  faultClause?: string;
}

function bodyFor(reviews: BenchReview[]): string {
  // Byte-identical to what claudeEngine.ts posts.
  return JSON.stringify({ reviews: reviews.map((r) => ({ id: r.id, text: r.text })) });
}

function textBytesOf(reviews: BenchReview[]): number {
  return reviews.reduce((n, r) => n + Buffer.byteLength(r.text, "utf8"), 0);
}

/**
 * Reject anything the deployed endpoint would reject. A benchmark result from a
 * request production could not have made would be worse than no result: it
 * would recommend a model on evidence the real system can never reproduce.
 */
function assertEndpointWouldAccept(f: Fixture): void {
  const fail = (why: string) => {
    throw new Error(`Fixture "${f.label}" would be rejected by /api/analyze: ${why}`);
  };
  if (f.reviews.length === 0) fail("reviews must be a non-empty array");
  if (f.reviews.length > MAX_REVIEWS_PER_REQUEST) {
    fail(`${f.reviews.length} rows exceeds MAX_REVIEWS_PER_REQUEST (${MAX_REVIEWS_PER_REQUEST})`);
  }
  const seen = new Set<string>();
  for (const r of f.reviews) {
    if (typeof r.id !== "string" || r.id.trim() === "") fail("each review needs a non-blank string id");
    if (seen.has(r.id)) fail(`duplicate review id: ${r.id}`);
    seen.add(r.id);
    if (typeof r.text !== "string" || r.text.trim() === "") fail("each review needs non-blank text");
  }
  const textBytes = textBytesOf(f.reviews);
  if (textBytes > MAX_TOTAL_REVIEW_TEXT_BYTES) {
    fail(`${textBytes} text bytes exceeds MAX_TOTAL_REVIEW_TEXT_BYTES (${MAX_TOTAL_REVIEW_TEXT_BYTES})`);
  }
  const bodyBytes = Buffer.byteLength(bodyFor(f.reviews), "utf8");
  if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
    fail(`${bodyBytes} body bytes exceeds MAX_REQUEST_BODY_BYTES (${MAX_REQUEST_BODY_BYTES})`);
  }
}

function loadMixedFixture(): Fixture {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, "mixed-sentiment.json"), "utf8"));
  const labels: MixedLabel[] = raw.reviews.map((r: MixedLabel) => ({
    id: r.id,
    kind: r.kind,
    praiseClause: r.praiseClause,
    faultClause: r.faultClause,
  }));
  // Labels must be real substrings, or the anchoring check silently never fires.
  for (const r of raw.reviews) {
    for (const field of ["praiseClause", "faultClause"] as const) {
      const clause = r[field];
      if (clause && !r.text.includes(clause)) {
        throw new Error(`Fixture bug: ${r.id} ${field} is not a substring of its text`);
      }
    }
  }
  return {
    key: "mixed",
    label: "A · mixed sentiment",
    reviews: raw.reviews.map((r: BenchReview) => ({ id: r.id, text: r.text })),
    mixed: labels,
  };
}

function loadClusterFixture(): Fixture {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, "clusters.json"), "utf8"));
  const clusters = new Map<string, string>();
  for (const r of raw.reviews) clusters.set(r.id, r.cluster);
  return {
    key: "clusters",
    label: "B · semantic clustering",
    reviews: raw.reviews.map((r: BenchReview) => ({ id: r.id, text: r.text })),
    clusters,
  };
}

/**
 * Fixture C: real Amazon review text at the production ceiling.
 *
 * Built from the local, gitignored dataset with the repo's own `parseCsv`, then
 * grown row by row until the next row would breach any endpoint limit. It is a
 * SHAPE fixture — realistic text volume for latency, tokens, truncation and
 * cost. It deliberately does not reproduce the adapter's row-skip rules, which
 * decide which listings become rows and have no bearing on any metric here.
 *
 * Returns null when the dataset is absent, which is the normal state on a fresh
 * clone. The run continues without it and says so.
 */
function loadRealShapeFixture(
  maxRows: number = MAX_REVIEWS_PER_REQUEST,
  csv = "public/amazon-products.csv",
): Fixture | null {
  const path = join(ROOT, csv);
  if (!existsSync(path)) return null;

  const rows = parseCsv(readFileSync(path, "utf8"));
  const header = rows[0] ?? [];
  const idIdx = header.indexOf("product_id");
  const textIdx = header.indexOf("review_content");
  if (idIdx === -1 || textIdx === -1) return null;

  const reviews: BenchReview[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    if (reviews.length >= maxRows) break;
    const id = (row[idIdx] ?? "").trim();
    const text = (row[textIdx] ?? "").trim();
    if (!id || !text || seen.has(id)) continue;

    const candidate = [...reviews, { id, text }];
    if (textBytesOf(candidate) > MAX_TOTAL_REVIEW_TEXT_BYTES) break;
    if (Buffer.byteLength(bodyFor(candidate), "utf8") > MAX_REQUEST_BODY_BYTES) break;

    seen.add(id);
    reviews.push({ id, text });
  }
  if (reviews.length === 0) return null;
  return { key: "real-shape", label: `C · real shape (${reviews.length} rows)`, reviews };
}

// --- scoring ----------------------------------------------------------------

interface RunResult {
  model: string;
  fixture: string;
  run: number;
  rows: number;
  bodyBytes: number;
  textBytes: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  latencyMs: number;
  costUsd: number;
  parseError: boolean;
  tagsEmitted: number;
  tagsValid: number;
  tagsRejected: number;
  tagsDeduped: number;
  evidenceValidity: number | null;
  distinctThemes: number;
  themeKeys: string[];
  /** Hit the endpoint's own 30s wall — the viewer would see 504 analysis_timeout. */
  timedOut: boolean;
  errored: string | null;
  /** Characters streamed before the wall. Turns a timeout into throughput data. */
  partialChars: number;
  /** Time to first streamed character — separates a stall from slow generation. */
  ttftMs: number | null;
  mixedPairRecall?: number;
  misattributed?: number;
  controlViolations?: number;
  trueMergeRate?: number;
  falseMergeRate?: number;
}

function tagsByReview(valid: ValidatedTag[]): Map<string, ValidatedTag[]> {
  const m = new Map<string, ValidatedTag[]>();
  for (const t of valid) {
    const list = m.get(t.reviewId) ?? [];
    list.push(t);
    m.set(t.reviewId, list);
  }
  return m;
}

/**
 * Mixed-sentiment scoring, deliberately label-agnostic: it never asks whether
 * the model picked a theme NAME we expected, only whether it split polarity
 * across two distinct themes and anchored each side in the correct clause.
 * Anchoring is what makes this more than a coin flip — a model that emits one
 * praise and one fault at random will fail the clause check.
 */
function scoreMixed(valid: ValidatedTag[], labels: MixedLabel[]) {
  const byReview = tagsByReview(valid);
  let mixedTotal = 0;
  let mixedHit = 0;
  let misattributed = 0;
  let controlViolations = 0;

  for (const label of labels) {
    const tags = byReview.get(label.id) ?? [];
    if (label.kind === "mixed") {
      mixedTotal++;
      const praise = tags.filter(
        (t) => t.sentiment === "praise" && label.praiseClause!.includes(t.evidence),
      );
      const fault = tags.filter(
        (t) => t.sentiment === "fault" && label.faultClause!.includes(t.evidence),
      );
      const distinct = praise.some((p) => fault.some((f) => p.themeKey !== f.themeKey));
      if (distinct) mixedHit++;

      misattributed += tags.filter(
        (t) =>
          (t.sentiment === "praise" && label.faultClause!.includes(t.evidence)) ||
          (t.sentiment === "fault" && label.praiseClause!.includes(t.evidence)),
      ).length;
    } else if (label.kind === "praise-only") {
      controlViolations += tags.filter((t) => t.sentiment === "fault").length;
    } else {
      controlViolations += tags.filter((t) => t.sentiment === "praise").length;
    }
  }
  return {
    mixedPairRecall: mixedTotal === 0 ? 0 : mixedHit / mixedTotal,
    misattributed,
    controlViolations,
  };
}

/**
 * Clustering scoring over review pairs. Two reviews "merge" when their theme-key
 * sets intersect. Same-cluster merges are wanted; cross-cluster merges are the
 * failure that collapses distinct complaints into one useless theme.
 */
function scoreClusters(valid: ValidatedTag[], clusters: Map<string, string>) {
  const byReview = tagsByReview(valid);
  const keysFor = (id: string) => new Set((byReview.get(id) ?? []).map((t) => t.themeKey));
  const ids = [...clusters.keys()];

  let sameTotal = 0;
  let sameMerged = 0;
  let crossTotal = 0;
  let crossMerged = 0;

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = keysFor(ids[i]!);
      const b = keysFor(ids[j]!);
      const intersects = [...a].some((k) => b.has(k));
      if (clusters.get(ids[i]!) === clusters.get(ids[j]!)) {
        sameTotal++;
        if (intersects) sameMerged++;
      } else {
        crossTotal++;
        if (intersects) crossMerged++;
      }
    }
  }
  return {
    trueMergeRate: sameTotal === 0 ? 0 : sameMerged / sameTotal,
    falseMergeRate: crossTotal === 0 ? 0 : crossMerged / crossTotal,
  };
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  const inter = [...sa].filter((k) => sb.has(k)).length;
  return inter / (sa.size + sb.size - inter);
}

// --- execution --------------------------------------------------------------

const client = new Anthropic({ maxRetries: 0 });

async function countInputTokens(model: string, reviews: BenchReview[]): Promise<number> {
  const res = await client.messages.countTokens({
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserContent(reviews) }],
  });
  return res.input_tokens;
}

async function runOnce(
  arm: (typeof ARMS)[number],
  fixture: Fixture,
  run: number,
  inTokEstimate: number,
  worstPerRun: number,
): Promise<RunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  const startedAt = Date.now();
  let partialChars = 0;
  let ttftMs: number | null = null;

  /**
   * A request that hits the endpoint's own 30s wall is a RESULT, not a crash:
   * it is exactly what a viewer would experience as `504 analysis_timeout`, and
   * a model that does it on a legal 100-row request is unusable here whatever
   * its tags look like. Cost is charged at worst case because an aborted stream
   * bills for whatever it generated and we cannot read that back — overcharging
   * ourselves keeps the budget bound sound.
   */
  const failed = (kind: "timeout" | "error", detail: string | null): RunResult => ({
    model: arm.model,
    fixture: fixture.label,
    run,
    rows: fixture.reviews.length,
    bodyBytes: Buffer.byteLength(bodyFor(fixture.reviews), "utf8"),
    textBytes: textBytesOf(fixture.reviews),
    inputTokens: inTokEstimate,
    outputTokens: 0,
    stopReason: kind,
    latencyMs: Date.now() - startedAt,
    costUsd: worstPerRun,
    parseError: false,
    tagsEmitted: 0,
    tagsValid: 0,
    tagsRejected: 0,
    tagsDeduped: 0,
    evidenceValidity: null,
    distinctThemes: 0,
    themeKeys: [],
    timedOut: kind === "timeout",
    errored: detail,
    partialChars,
    ttftMs,
  });

  try {
    // Identical call shape to api/analyze.ts: streaming, fixed max_tokens,
    // no thinking, no effort, no caching. Anything else would measure a
    // configuration the endpoint never uses.
    const stream = client.messages.stream(
      {
        model: arm.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(fixture.reviews) }],
      },
      { signal: controller.signal },
    );
    stream.on("text", (delta: string) => {
      if (ttftMs === null) ttftMs = Date.now() - startedAt;
      partialChars += delta.length;
    });
    const message = await stream.finalMessage();
    const latencyMs = Date.now() - startedAt;

    const rawText = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    let entries: unknown[] = [];
    let parseError = false;
    try {
      entries = parseTagArray(stripCodeFence(rawText));
    } catch {
      parseError = true;
    }

    const reviewsById = new Map(fixture.reviews.map((r) => [r.id, r.text] as const));
    const { valid, rejected, deduped } = validateTags(entries, reviewsById);

    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const costUsd =
      (inputTokens / 1e6) * arm.inputPerMTok + (outputTokens / 1e6) * arm.outputPerMTok;

    const themeKeys = [...new Set(valid.map((t) => t.themeKey))];
    const scored = entries.length + rejected;

    const result: RunResult = {
      model: arm.model,
      fixture: fixture.label,
      run,
      rows: fixture.reviews.length,
      bodyBytes: Buffer.byteLength(bodyFor(fixture.reviews), "utf8"),
      textBytes: textBytesOf(fixture.reviews),
      inputTokens,
      outputTokens,
      stopReason: message.stop_reason,
      latencyMs,
      costUsd,
      parseError,
      tagsEmitted: entries.length,
      tagsValid: valid.length,
      tagsRejected: rejected,
      tagsDeduped: deduped,
      evidenceValidity: scored === 0 ? null : valid.length / (valid.length + rejected),
      distinctThemes: themeKeys.length,
      themeKeys,
      timedOut: false,
      errored: null,
      partialChars,
      ttftMs,
    };

    if (fixture.mixed) Object.assign(result, scoreMixed(valid, fixture.mixed));
    if (fixture.clusters) Object.assign(result, scoreClusters(valid, fixture.clusters));
    return result;
  } catch (err) {
    const aborted =
      controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    if (aborted) return failed("timeout", null);
    return failed("error", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${(n * 100).toFixed(0)}%`;
}

/**
 * Cap sweep: find the largest row cap that finishes with practical headroom
 * under the endpoint's unchanged 30s timeout.
 *
 * "Under 30s" is not the bar — a request that lands at 28s is a demo that looks
 * broken and fails the moment the dataset or the network is slightly worse. The
 * bar is TARGET_MS, and a size only earns a look at the next size up if it comes
 * in under COMFORTABLE_MS.
 */
const SWEEP_CEILING_USD = 1.0;
const SWEEP_TARGET_MS = 22_000;
const SWEEP_COMFORTABLE_MS = 20_000;
const SWEEP_RUNS = 2;

function csvArgLabel(): string {
  const a = process.argv.find((x) => x.startsWith("--csv="));
  return a ? a.slice("--csv=".length) : "public/amazon-products.csv";
}

async function sweep(confirmed: boolean) {
  const arm = ARMS.find((a) => a.model === "claude-opus-4-8")!;
  const sizesArg = process.argv.find((a) => a.startsWith("--sizes="));
  const sizes = sizesArg
    ? sizesArg.slice("--sizes=".length).split(",").map(Number)
    : [20, 40, 60];

  console.log(
    `Cap sweep · ${arm.model} · timeout unchanged at ${CLAUDE_TIMEOUT_MS / 1000}s · ${csvArgLabel()}`,
  );
  console.log(
    `Selection bar: both runs end_turn AND max latency <= ${SWEEP_TARGET_MS / 1000}s.\n` +
      `80 rows is tested only if 60 comes in under ${SWEEP_COMFORTABLE_MS / 1000}s.\n`,
  );

  const csvArg = process.argv.find((a) => a.startsWith("--csv="));
  const csv = csvArg ? csvArg.slice("--csv=".length) : "public/amazon-products.csv";
  const fixtureFor = (n: number) => {
    const f = loadRealShapeFixture(n, csv);
    if (!f) throw new Error(`${csv} not found or has no usable rows — cannot run the cap sweep.`);
    assertEndpointWouldAccept(f);
    return f;
  };

  // Free pre-flight: real input tokens, so the budget bound is not a guess.
  const preflight = new Map<number, { fixture: Fixture; inTok: number; worstPerRun: number }>();
  for (const n of [...new Set([...sizes, ...(csv.includes("demo") ? [] : [80])])]) {
    const f = fixtureFor(n);
    const inTok = await countInputTokens(arm.model, f.reviews);
    const worstPerRun = worstCostFor(arm, inTok);
    preflight.set(n, { fixture: f, inTok, worstPerRun });
    console.log(
      `  ${String(n).padStart(3)} rows  text=${String(textBytesOf(f.reviews)).padStart(6)}B  ` +
        `in=${String(inTok).padStart(6)} tok  worst/run=${fmtUsd(worstPerRun)}`,
    );
  }
  console.log(`\n  Hard ceiling: ${fmtUsd(SWEEP_CEILING_USD)}`);

  if (!confirmed) {
    console.log("\nDry run only. Nothing was billed. Re-run with --confirm.");
    return;
  }

  const results: RunResult[] = [];
  let spent = 0;
  const perSize = new Map<number, RunResult[]>();

  const queue = [...sizes];
  while (queue.length > 0) {
    const n = queue.shift()!;
    const { fixture, inTok, worstPerRun } = preflight.get(n)!;
    const softBudget = SWEEP_CEILING_USD - worstPerRun;

    if (spent > softBudget) {
      console.error(
        `\nHALT before ${n} rows: spent ${fmtUsd(spent)} exceeds the ${fmtUsd(softBudget)} threshold ` +
          `that keeps total under ${fmtUsd(SWEEP_CEILING_USD)}.`,
      );
      break;
    }

    const runs: RunResult[] = [];
    for (let run = 1; run <= SWEEP_RUNS; run++) {
      const r = await runOnce(arm, fixture, run, inTok, worstPerRun);
      spent += r.costUsd;
      results.push(r);
      runs.push(r);
      console.log(
        `  ${String(n).padStart(3)} rows  run ${run}  ${String(r.latencyMs).padStart(6)}ms  ` +
          `out=${String(r.outputTokens).padStart(5)}  stop=${String(r.stopReason).padEnd(9)} ` +
          `${fmtUsd(r.costUsd)}  valid=${r.tagsValid}/${r.tagsValid + r.tagsRejected}  ` +
          `themes=${String(r.distinctThemes).padStart(3)}  ` +
          `ttft=${r.ttftMs === null ? "n/a" : r.ttftMs + "ms"}  chars=${r.partialChars}  ` +
          `[spent ${fmtUsd(spent)}]`,
      );
    }
    perSize.set(n, runs);

    const clean = runs.every((r) => r.stopReason === "end_turn");
    const maxMs = Math.max(...runs.map((r) => r.latencyMs));
    if (!clean) {
      console.log(`  -> ${n} rows FAILED (not all runs completed cleanly). Stopping the sweep.`);
      break;
    }
    console.log(
      `  -> ${n} rows clean, max ${maxMs}ms ` +
        (maxMs <= SWEEP_TARGET_MS ? "(within target)" : "(OVER target)"),
    );
    if (maxMs > SWEEP_TARGET_MS) break;
    if (n === 60 && maxMs <= SWEEP_COMFORTABLE_MS) {
      console.log(`  -> 60 rows comfortable; adding 80 rows.`);
      queue.push(80);
    }
  }

  // Largest size meeting the bar.
  let chosen: number | null = null;
  for (const [n, runs] of [...perSize.entries()].sort((a, b) => a[0] - b[0])) {
    const clean = runs.every((r) => r.stopReason === "end_turn");
    const maxMs = Math.max(...runs.map((r) => r.latencyMs));
    if (clean && maxMs <= SWEEP_TARGET_MS) chosen = n;
  }

  console.log(`\n${"=".repeat(96)}`);
  console.log(`TOTAL MEASURED SPEND: ${fmtUsd(spent)} of ${fmtUsd(SWEEP_CEILING_USD)} ceiling`);
  console.log("=".repeat(96));
  console.log(
    "\n" +
      "rows".padEnd(7) +
      "runs".padEnd(6) +
      "max ms".padEnd(9) +
      "stop".padEnd(11) +
      "out tok".padEnd(9) +
      "evid".padEnd(7) +
      "themes".padEnd(8) +
      "$/run".padEnd(10) +
      "verdict",
  );
  console.log("-".repeat(96));
  for (const [n, runs] of [...perSize.entries()].sort((a, b) => a[0] - b[0])) {
    const clean = runs.every((r) => r.stopReason === "end_turn");
    const maxMs = Math.max(...runs.map((r) => r.latencyMs));
    const avgOut = runs.reduce((s, r) => s + r.outputTokens, 0) / runs.length;
    const avgCost = runs.reduce((s, r) => s + r.costUsd, 0) / runs.length;
    const evid = runs.map((r) => r.evidenceValidity).filter((v): v is number => v !== null);
    console.log(
      String(n).padEnd(7) +
        String(runs.length).padEnd(6) +
        String(maxMs).padEnd(9) +
        [...new Set(runs.map((r) => r.stopReason))].join(",").padEnd(11) +
        avgOut.toFixed(0).padEnd(9) +
        (evid.length ? pct(evid.reduce((a, b) => a + b, 0) / evid.length) : "—").padEnd(7) +
        (runs.reduce((s, r) => s + r.distinctThemes, 0) / runs.length).toFixed(1).padEnd(8) +
        fmtUsd(avgCost).padEnd(10) +
        (clean && maxMs <= SWEEP_TARGET_MS ? "PASS" : clean ? "over target" : "FAILED"),
    );
  }
  console.log(
    `\nRecommended MAX_REVIEWS_PER_REQUEST: ${chosen ?? "none of the tested sizes met the bar"}`,
  );

  finish(results, spent, false, "cap-sweep");
}

async function main() {
  const confirmed = process.argv.includes("--confirm");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. Run:  set -a && . ./.env.local && set +a && node scripts/bench-models.ts",
    );
    process.exit(1);
  }

  if (process.argv.includes("--sweep")) return sweep(confirmed);

  const fixtures: Fixture[] = [loadMixedFixture(), loadClusterFixture()];
  const real = loadRealShapeFixture();
  if (real) {
    fixtures.push(real);
  } else {
    console.log(
      "! public/amazon-products.csv not found — skipping fixture C.\n" +
        "  Latency, truncation and cost at the 100-row ceiling will NOT be measured.\n",
    );
  }
  for (const f of fixtures) assertEndpointWouldAccept(f);

  console.log("Fixtures (all verified against the endpoint's own limits):");
  for (const f of fixtures) {
    console.log(
      `  ${f.label.padEnd(34)} rows=${String(f.reviews.length).padStart(3)}  ` +
        `text=${String(textBytesOf(f.reviews)).padStart(6)}B  ` +
        `body=${String(Buffer.byteLength(bodyFor(f.reviews), "utf8")).padStart(6)}B`,
    );
  }
  console.log(
    `  limits: rows<=${MAX_REVIEWS_PER_REQUEST}  text<=${MAX_TOTAL_REVIEW_TEXT_BYTES}B  body<=${MAX_REQUEST_BODY_BYTES}B\n`,
  );

  // Real token counts, free, before any generation is billed.
  console.log("Measuring input tokens per arm (count_tokens is free)…\n");
  const plan: { arm: (typeof ARMS)[number]; fixture: Fixture; inTok: number; worstPerRun: number }[] =
    [];
  for (const arm of ARMS) {
    for (const f of fixtures) {
      const inTok = await countInputTokens(arm.model, f.reviews);
      const worstPerRun = worstCostFor(arm, inTok);
      plan.push({ arm, fixture: f, inTok, worstPerRun });
      console.log(
        `  ${arm.model.padEnd(18)} ${f.label.padEnd(34)} in=${String(inTok).padStart(6)} tok  ` +
          `worst/run=${fmtUsd(worstPerRun)}  x${runsFor(f)}`,
      );
    }
  }

  /**
   * The ceiling is enforced by a provable bound, not by a guess about output
   * length. Spend is checked after every request and the run halts the moment it
   * passes SOFT_BUDGET, so the most that can ever be spent is SOFT_BUDGET plus
   * one more request — and SOFT_BUDGET is defined so that sum stays under the
   * ceiling. Worst case per run assumes a response that maxes out the 16k output
   * ceiling, which real tagging output does not approach on the small fixtures;
   * gating the whole run on that sum would refuse a run that will cost cents.
   */
  const maxSingle = Math.max(...plan.map((p) => p.worstPerRun));
  const softBudget = CEILING_USD - maxSingle;
  const worstWholeRun = plan.reduce((n, p) => n + p.worstPerRun * runsFor(p.fixture), 0);

  console.log(`\n  Theoretical worst case if every response maxed out: ${fmtUsd(worstWholeRun)}`);
  console.log(`  Most expensive single request:                      ${fmtUsd(maxSingle)}`);
  console.log(`  Halt threshold (measured spend):                    ${fmtUsd(softBudget)}`);
  console.log(
    `  => provable maximum total spend: ${fmtUsd(softBudget)} + ${fmtUsd(maxSingle)} = ${fmtUsd(softBudget + maxSingle)}  (ceiling ${fmtUsd(CEILING_USD)})`,
  );

  if (maxSingle > CEILING_USD) {
    console.error(
      `\nRefusing to start: a single request could cost ${fmtUsd(maxSingle)}, over the ${fmtUsd(CEILING_USD)} ceiling.`,
    );
    process.exit(1);
  }

  if (!confirmed) {
    console.log("\nDry run only. No generation requests were made and nothing was billed.");
    console.log("Re-run with --confirm to execute.");
    return;
  }

  console.log("\nExecuting…\n");
  const results: RunResult[] = [];
  let spent = 0;

  for (const { arm, fixture, inTok, worstPerRun } of plan) {
    for (let run = 1; run <= runsFor(fixture); run++) {
      if (spent > softBudget) {
        console.error(
          `\nABORT: measured spend ${fmtUsd(spent)} passed the ${fmtUsd(softBudget)} halt threshold.`,
        );
        console.error("Partial results are being written.");
        return finish(results, spent, true);
      }

      const r = await runOnce(arm, fixture, run, inTok, worstPerRun);
      spent += r.costUsd;
      results.push(r);
      console.log(
        `  ${arm.model.padEnd(18)} ${fixture.label.padEnd(34)} run ${run}  ` +
          `${String(r.latencyMs).padStart(6)}ms  in=${String(r.inputTokens).padStart(6)} ` +
          `out=${String(r.outputTokens).padStart(5)}  stop=${String(r.stopReason).padEnd(9)} ` +
          `${fmtUsd(r.costUsd)}  valid=${r.tagsValid}/${r.tagsValid + r.tagsRejected}  ` +
          `[spent ${fmtUsd(spent)}, worst/run ${fmtUsd(worstPerRun)}]`,
      );
    }
  }
  finish(results, spent, false);
}

function finish(results: RunResult[], spent: number, aborted: boolean, tag = "compare") {
  mkdirSync(RESULT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(RESULT_DIR, `${tag}-${stamp}.json`);

  // Aggregate per (model, fixture).
  const groups = new Map<string, RunResult[]>();
  for (const r of results) {
    const k = `${r.model}||${r.fixture}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const summary = [...groups.entries()].map(([k, runs]) => {
    const [model = "", fixture = ""] = k.split("||");
    const avg = (f: (r: RunResult) => number | null | undefined) => {
      const vals = runs.map(f).filter((v): v is number => typeof v === "number");
      return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    // Pairwise Jaccard of theme-key sets across runs: same input, same themes?
    // Only over runs that actually produced tags — two timed-out runs both yield
    // empty sets, which would score a meaningless perfect 1.0.
    const scorable = runs.filter((r) => !r.timedOut && r.errored === null && r.themeKeys.length > 0);
    const pairs: number[] = [];
    for (let i = 0; i < scorable.length; i++) {
      for (let j = i + 1; j < scorable.length; j++) {
        pairs.push(jaccard(scorable[i]!.themeKeys, scorable[j]!.themeKeys));
      }
    }
    return {
      model,
      fixture,
      runs: runs.length,
      rows: runs[0]!.rows,
      textBytes: runs[0]!.textBytes,
      bodyBytes: runs[0]!.bodyBytes,
      avgInputTokens: avg((r) => r.inputTokens),
      avgOutputTokens: avg((r) => r.outputTokens),
      stopReasons: [...new Set(runs.map((r) => r.stopReason))],
      truncated: runs.filter((r) => r.stopReason === "max_tokens").length,
      timeouts: runs.filter((r) => r.timedOut).length,
      errors: runs.filter((r) => r.errored !== null).length,
      parseErrors: runs.filter((r) => r.parseError).length,
      p50LatencyMs: [...runs.map((r) => r.latencyMs)].sort((a, b) => a - b)[
        Math.floor(runs.length / 2)
      ],
      maxLatencyMs: Math.max(...runs.map((r) => r.latencyMs)),
      avgCostUsd: avg((r) => r.costUsd),
      evidenceValidity: avg((r) => r.evidenceValidity),
      avgDistinctThemes: avg((r) => r.distinctThemes),
      stability: pairs.length === 0 ? null : pairs.reduce((a, b) => a + b, 0) / pairs.length,
      mixedPairRecall: avg((r) => r.mixedPairRecall),
      misattributed: avg((r) => r.misattributed),
      controlViolations: avg((r) => r.controlViolations),
      trueMergeRate: avg((r) => r.trueMergeRate),
      falseMergeRate: avg((r) => r.falseMergeRate),
    };
  });

  writeFileSync(
    path,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        aborted,
        totalSpendUsd: Number(spent.toFixed(6)),
        ceilingUsd: CEILING_USD,
        runsPerCell: { "mixed/clusters": 3, "real-shape": 2 },
        arms: ARMS,
        pricingVerifiedOn: "2026-08-02",
        callShape: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeoutMs: CLAUDE_TIMEOUT_MS,
          streaming: true,
          maxRetries: 0,
          thinking: "not set (mirrors api/analyze.ts)",
          promptCaching: "not used (mirrors api/analyze.ts)",
        },
        summary,
        runs: results,
      },
      null,
      2,
    ),
  );

  console.log(`\n${"=".repeat(112)}`);
  console.log(`TOTAL MEASURED SPEND: ${fmtUsd(spent)} of ${fmtUsd(CEILING_USD)} ceiling${aborted ? "  (ABORTED)" : ""}`);
  console.log(`Results: ${path}`);
  console.log("=".repeat(112));

  const col = (s: string, n: number) => s.padEnd(n);
  console.log(
    "\n" +
      col("model", 18) +
      col("fixture", 34) +
      col("evid", 7) +
      col("stab", 7) +
      col("themes", 8) +
      col("p50 ms", 9) +
      col("out tok", 9) +
      col("$/run", 10) +
      col("trunc", 7) +
      col("t/out", 6),
  );
  console.log("-".repeat(120));
  for (const s of summary) {
    console.log(
      col(s.model, 18) +
        col(s.fixture, 34) +
        col(pct(s.evidenceValidity), 7) +
        col(pct(s.stability), 7) +
        col((s.avgDistinctThemes ?? 0).toFixed(1), 8) +
        col(String(s.p50LatencyMs ?? "—"), 9) +
        col((s.avgOutputTokens ?? 0).toFixed(0), 9) +
        col(fmtUsd(s.avgCostUsd ?? 0), 10) +
        col(`${s.truncated}/${s.runs}`, 7) +
        col(`${s.timeouts}/${s.runs}`, 6),
    );
  }

  console.log("\nFixture A · mixed sentiment");
  console.log(col("model", 18) + col("pair recall", 14) + col("misattributed", 16) + col("control violations", 20));
  console.log("-".repeat(112));
  for (const s of summary.filter((x) => x.fixture?.startsWith("A "))) {
    console.log(
      col(s.model, 18) +
        col(pct(s.mixedPairRecall), 14) +
        col((s.misattributed ?? 0).toFixed(1), 16) +
        col((s.controlViolations ?? 0).toFixed(1), 20),
    );
  }

  console.log("\nFixture B · semantic clustering");
  console.log(col("model", 18) + col("true merge", 14) + col("false merge", 14) + col("distinct themes (want 4)", 26));
  console.log("-".repeat(112));
  for (const s of summary.filter((x) => x.fixture?.startsWith("B "))) {
    console.log(
      col(s.model, 18) +
        col(pct(s.trueMergeRate), 14) +
        col(pct(s.falseMergeRate), 14) +
        col((s.avgDistinctThemes ?? 0).toFixed(1), 26),
    );
  }
}

main().catch((err) => {
  console.error("\nBenchmark failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
