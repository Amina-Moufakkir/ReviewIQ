import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { AddressInfo } from "node:net";

import analyzeHandler from "../api/analyze";
import canonicalizeHandler from "../api/canonicalize";
import { runClaudePipeline } from "../src/services/claudePipeline";
import { createAnalyzeDispatch, createCanonicalizeDispatch } from "../src/services/claudeDispatch";
import { tagsToResult } from "../src/services/tagsToResult";
import { selectForScope } from "../src/services/analysisEngine";
import { estimateRun } from "../src/services/runEstimator";
import { adaptAmazonCsv } from "../src/lib/amazonAdapter";
import { sampleDataset } from "../src/data/sampleDataset";
import { unitFor } from "../src/lib/datasetInfo";
import type { AnalysisInput, Dataset, Review } from "../src/types";
import { recompute, auditMapping } from "./independentRecompute";

/**
 * THE ACCEPTANCE GATE. This makes real, billable Anthropic requests.
 *
 * It runs the shipped pipeline end to end against the real endpoints, then
 * recomputes every displayed number from the retained tags and the canonical
 * mapping WITHOUT going through the aggregator, and fails on any disagreement.
 *
 * Spend is tracked from the endpoints' own structured logs, which carry the
 * provider's measured token counts, and is enforced against a hard cumulative
 * ceiling. The run aborts the moment the ceiling is reached, mid-analysis if
 * necessary — the ceiling is not a budget to spend up to, it is a stop.
 */

// --- spend control -----------------------------------------------------------

const HARD_CEILING_USD = 2.0;

/**
 * Spend already made by the FIRST gate attempt, which the ceiling must include.
 *
 * That attempt tagged all 31 OfficeProducts records before grouping failed, but
 * its token counts were lost to a logging gap, so this is a deliberate
 * over-estimate rather than a measurement: the estimator's conservative tagging
 * ceiling for that selection ($0.4139) plus its retry allowance and a completed
 * grouping request. Erring high is the only safe direction for a prior you
 * cannot verify — it can only stop the run sooner than necessary.
 */
const PRIOR_ATTEMPT_USD = 0.5;
/** claude-opus-4-8 list price. */
const INPUT_USD_PER_MTOK = 5;
const OUTPUT_USD_PER_MTOK = 25;

const spend = {
  inputTokens: 0,
  outputTokens: 0,
  requests: 0,
  byEndpoint: {} as Record<string, { requests: number; inputTokens: number; outputTokens: number }>,
  /** This attempt only. */
  measuredUsd(): number {
    return (
      (this.inputTokens / 1e6) * INPUT_USD_PER_MTOK +
      (this.outputTokens / 1e6) * OUTPUT_USD_PER_MTOK
    );
  },
  /** What the ceiling is enforced against: this attempt plus the first one. */
  usd(): number {
    return PRIOR_ATTEMPT_USD + this.measuredUsd();
  },
};

/**
 * Every structured log entry both endpoints emitted.
 *
 * Kept because a failure that is only a user-facing message is not diagnosable:
 * "the analysis service returned an invalid response" is deliberately vague for
 * an analyst and useless for a post-mortem. The endpoints already record the
 * controlled code and, for a rejected grouping, exactly which rule it broke.
 */
const endpointLog: Record<string, unknown>[] = [];

/** Aborted as soon as the ceiling is reached, stopping every in-flight request. */
const ceilingController = new AbortController();

let realLog: typeof console.log;

function installSpendMeter() {
  realLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = typeof args[0] === "string" ? args[0] : "";
    if (line.startsWith("{")) {
      try {
        const entry = JSON.parse(line) as {
          at?: string;
          inputTokens?: number;
          outputTokens?: number;
        };
        if (entry.at === "api/analyze" || entry.at === "api/canonicalize") {
          endpointLog.push(entry as Record<string, unknown>);
          const bucket = (spend.byEndpoint[entry.at] ??= {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
          });
          bucket.requests++;
          spend.requests++;
          bucket.inputTokens += entry.inputTokens ?? 0;
          bucket.outputTokens += entry.outputTokens ?? 0;
          spend.inputTokens += entry.inputTokens ?? 0;
          spend.outputTokens += entry.outputTokens ?? 0;
          if (spend.usd() >= HARD_CEILING_USD && !ceilingController.signal.aborted) {
            realLog(`\n!! HARD CEILING REACHED: $${spend.usd().toFixed(4)} — aborting\n`);
            ceilingController.abort();
          }
        }
      } catch {
        // not one of ours
      }
    }
    // Endpoint logs are suppressed from the transcript; they are summarized
    // instead. They carry no secrets, but they are noisy at this volume.
  };
}

function restoreLog() {
  if (realLog) console.log = realLog;
}

function report(...args: unknown[]) {
  (realLog ?? console.log)(...args);
}

// --- a local server running the real handlers --------------------------------

let server: Server;
let origin: string;

function shimResponse(res: import("node:http").ServerResponse) {
  let status = 200;
  return {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return this;
    },
    setHeader(key: string, value: string) {
      res.setHeader(key, value);
      return this;
    },
  };
}

beforeAll(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set; run with --env-file=.env.local");
  }
  // The endpoints are fail-closed; this harness opts in deliberately.
  process.env.CLAUDE_ENABLED = "true";
  installSpendMeter();

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks as unknown as Uint8Array[]).toString("utf8"));
      } catch {
        // An unparseable body is a case the endpoint itself must handle.
      }
      const shimReq = { method: req.method, headers: req.headers, body } as never;
      const handler = req.url?.includes("canonicalize") ? canonicalizeHandler : analyzeHandler;
      void handler(shimReq, shimResponse(res) as never);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  restoreLog();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** fetch bound to the local server, so the real adapters are exercised. */
const gateFetch = (url: string, init?: RequestInit) => fetch(`${origin}${url}`, init);

/**
 * Every request/response pair, recorded as it happens.
 *
 * Tagging is the expensive stage and canonicalization runs after it. Without
 * this, a grouping failure throws away a complete, already-billed tag set and
 * every retry pays for it again — so the record is written before the stage
 * that can fail.
 */
const wire: { url: string; request: unknown; status: number; response: unknown }[] = [];

function recordingFetch(url: string, init?: RequestInit): Promise<Response> {
  return gateFetch(url, init).then(async (res) => {
    const text = await res.clone().text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep the raw text — an unparseable body is itself the finding
    }
    let request: unknown;
    try {
      request = JSON.parse((init?.body as string) ?? "null");
    } catch {
      request = init?.body;
    }
    wire.push({ url, request, status: res.status, response: parsed });
    flushDiagnostics();
    return res;
  });
}

function flushDiagnostics() {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    `${OUT_DIR}/diagnostics.json`,
    JSON.stringify({ endpointLog, wire, spend: spendSnapshot() }, null, 1),
  );
}

function spendSnapshot() {
  return {
    requests: spend.requests,
    inputTokens: spend.inputTokens,
    outputTokens: spend.outputTokens,
    byEndpoint: spend.byEndpoint,
    priorAttemptUsd: PRIOR_ATTEMPT_USD,
    measuredUsd: +spend.measuredUsd().toFixed(4),
    cumulativeUsd: +spend.usd().toFixed(4),
    ceilingUsd: HARD_CEILING_USD,
  };
}

// --- the runs ----------------------------------------------------------------

const OUT_DIR = "bench/gate";

interface GateOutcome {
  name: string;
  rows: number;
  batches: number;
  rawLabels: number;
  canonicalLabels: number;
  usd: number;
  seconds: number;
}

const outcomes: GateOutcome[] = [];

/** OfficeProducts runs only if all three synthetic analyses passed. */
let syntheticPassed = false;

async function runGate(name: string, dataset: Dataset, input: AnalysisInput, expectedRows: number) {
  if (spend.usd() >= HARD_CEILING_USD) {
    throw new Error(`refusing to start "${name}": ceiling already reached at $${spend.usd().toFixed(4)}`);
  }

  const { subject, rows: matched } = selectForScope(input, dataset.reviews, dataset.products);
  const unit = unitFor(dataset);
  expect(matched.length, `${name}: selection size`).toBe(expectedRows);

  const rows = matched.map((r) => ({ id: r.id, text: r.text }));
  const estimate = estimateRun(rows, "local");
  report(
    `\n=== ${name} ===\n` +
      `rows=${matched.length} unit=${unit.one} ` +
      `projectedBatches=${estimate.projectedBatchCount} ` +
      `estCostUsd=${estimate.cost.totalUsd.toFixed(4)} ` +
      `unsupported=${estimate.canonicalization.unsupported}`,
  );
  expect(estimate.canonicalization.unsupported, `${name}: must not be preflight-refused`).toBe(false);

  const startedAt = Date.now();
  const before = spend.usd();

  let pipeline;
  try {
    pipeline = await runClaudePipeline(rows, {
      analyze: createAnalyzeDispatch(recordingFetch),
      canonicalize: createCanonicalizeDispatch(recordingFetch),
      signal: ceilingController.signal,
    });
  } catch (err) {
    reportFailure(name, err);
    throw err;
  }

  const seconds = (Date.now() - startedAt) / 1000;
  const usd = spend.usd() - before;

  // --- the shipped aggregator -----------------------------------------------
  const result = tagsToResult(input, subject, matched, pipeline.tags, unit);

  // --- the independent recomputation ----------------------------------------
  const audit = auditMapping(pipeline.tags);
  const independent = recompute(
    pipeline.tags,
    matched.map((r) => r.id),
    unit.isProductLevel,
  );

  // Artifacts first, so a failure below is still diagnosable.
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    `${OUT_DIR}/${name}.json`,
    JSON.stringify(
      {
        name,
        rows: matched.length,
        unit,
        runId: pipeline.runId,
        rawLabelCount: pipeline.rawLabelCount,
        canonicalLabels: pipeline.canonicalLabels,
        canonicalizationSkipped: pipeline.canonicalizationSkipped,
        telemetry: pipeline.execution,
        tags: pipeline.tags,
        result,
        independent,
        audit,
        usd,
        seconds,
      },
      null,
      1,
    ),
  );

  report(
    `batches=${pipeline.execution.batchCount} retries=${pipeline.execution.retriesUsed} ` +
      `rawLabels=${pipeline.rawLabelCount} canonical=${pipeline.canonicalLabels.length} ` +
      `skipped=${pipeline.canonicalizationSkipped}\n` +
      `actualUsd=${usd.toFixed(4)} cumulative=$${spend.usd().toFixed(4)} seconds=${seconds.toFixed(1)}`,
  );

  // --- assertions -----------------------------------------------------------

  // 1. Coverage: every selected row analyzed, exactly once.
  expect(pipeline.rowCount, "row count").toBe(matched.length);
  const taggedIds = new Set(pipeline.tags.map((t) => t.reviewId));
  for (const id of taggedIds) {
    expect(matched.some((r) => r.id === id), `tag references a selected row: ${id}`).toBe(true);
  }

  // 2. The mapping is a total, closed relabelling.
  expect(audit.problems, "mapping audit").toEqual([]);

  // 3. Grounding: every quote is verbatim in its own review.
  const textById = new Map(matched.map((r) => [r.id, r.text] as const));
  for (const tag of pipeline.tags) {
    expect(
      textById.get(tag.reviewId)?.includes(tag.evidence),
      `evidence is verbatim in ${tag.reviewId}`,
    ).toBe(true);
  }

  // 4. Every displayed number matches the independent recomputation.
  expect(result.reviewCount, "reviewCount").toBe(independent.reviewCount);
  compareFindings(`${name} praise`, result.praise, independent.praise, matched);
  compareFindings(`${name} faults`, result.faults, independent.faults, matched);

  // 5. Recommendations follow the faults, in order.
  expect(result.recommendations.length, "one recommendation per fault").toBe(result.faults.length);

  outcomes.push({
    name,
    rows: matched.length,
    batches: pipeline.execution.batchCount,
    rawLabels: pipeline.rawLabelCount,
    canonicalLabels: pipeline.canonicalLabels.length,
    usd,
    seconds,
  });
}

/**
 * Everything needed to diagnose a failure, without a second paid attempt.
 *
 * The analyst-facing message is deliberately vague — "the analysis service
 * returned an invalid response" covers a rejected grouping, an over-long label,
 * and an unreadable body alike. That is right for the analyst and useless for a
 * post-mortem, so the endpoint's own record is surfaced here instead.
 */
function reportFailure(name: string, err: unknown) {
  const canonicalizeCalls = wire.filter((w) => w.url.includes("/api/canonicalize"));
  const last = canonicalizeCalls[canonicalizeCalls.length - 1];
  const labels = ((last?.request as { labels?: string[] })?.labels ?? []) as string[];
  const lengths = labels.map((l) => l.length).sort((a, b) => a - b);

  const diagnosis = {
    run: name,
    userFacingMessage: (err as Error).message,
    errorName: (err as Error).name,
    endpointLogTail: endpointLog.slice(-8),
    canonicalize: {
      requests: canonicalizeCalls.length,
      lastStatus: last?.status,
      lastResponse: last?.response,
      labelCount: labels.length,
      labelLengths: {
        min: lengths[0],
        median: lengths[Math.floor(lengths.length / 2)],
        max: lengths[lengths.length - 1],
      },
      overLengthLimit: labels.filter((l) => l.length > 120),
      blank: labels.filter((l) => l.trim() === "").length,
      duplicates: labels.length - new Set(labels).size,
      requestBytes: new TextEncoder().encode(JSON.stringify(last?.request ?? {})).length,
      labels,
    },
    spend: spendSnapshot(),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/FAILURE-${name}.json`, JSON.stringify(diagnosis, null, 1));
  report(
    `\n!! FAILED: ${name}\n` +
      `message="${diagnosis.userFacingMessage}"\n` +
      `canonicalizeRequests=${diagnosis.canonicalize.requests} ` +
      `lastStatus=${diagnosis.canonicalize.lastStatus}\n` +
      `lastResponse=${JSON.stringify(diagnosis.canonicalize.lastResponse)}\n` +
      `labelCount=${diagnosis.canonicalize.labelCount} ` +
      `lengths(min/med/max)=${lengths[0]}/${lengths[Math.floor(lengths.length / 2)]}/${lengths[lengths.length - 1]} ` +
      `overLimit=${diagnosis.canonicalize.overLengthLimit.length} ` +
      `blank=${diagnosis.canonicalize.blank} dupes=${diagnosis.canonicalize.duplicates} ` +
      `bytes=${diagnosis.canonicalize.requestBytes}\n` +
      `endpointLogTail=${JSON.stringify(diagnosis.endpointLogTail)}\n` +
      `spend=${JSON.stringify(diagnosis.spend)}\n` +
      `full diagnosis written to ${OUT_DIR}/FAILURE-${name}.json`,
  );
}

function compareFindings(
  label: string,
  shipped: { label: string; mentions: number; percent: number; quote: string; quoteAuthor: string }[],
  independent: { label: string; mentions: number; percent: number; quote: string; quoteReviewId: string }[],
  matched: Review[],
) {
  expect(shipped.map((f) => f.label), `${label}: labels and ORDER`).toEqual(
    independent.map((f) => f.label),
  );
  for (const [i, f] of shipped.entries()) {
    const ind = independent[i]!;
    expect(f.mentions, `${label}[${i}] "${f.label}": mentions`).toBe(ind.mentions);
    expect(f.percent, `${label}[${i}] "${f.label}": percent`).toBe(ind.percent);
    expect(f.quote, `${label}[${i}] "${f.label}": quote`).toBe(ind.quote);
    // The quote must belong to the review the independent pass chose.
    const source = matched.find((r) => r.id === ind.quoteReviewId)!;
    expect(source.text.includes(f.quote), `${label}[${i}]: quote is verbatim in its source`).toBe(true);
  }
}

// --- selections --------------------------------------------------------------

describe("acceptance gate", () => {
  it("run 1 — the complete synthetic demo dataset", async () => {
    // The synthetic dataset spans THREE top categories (Audio, Outdoor,
    // Kitchen), and the app has no scope that spans categories — scope is one
    // product or one category, by design. So "the complete dataset" is three
    // category analyses whose selections partition all 31 rows, not one.
    //
    // It is also fully dated, unlike the Amazon data, so the window has to be
    // real: category scope filters on `date >= from && date <= to`, and an
    // empty `to` excludes every dated row.
    const all: Dataset = { ...sampleDataset };
    const dates = all.reviews.map((r) => r.date).sort();
    const window = { from: dates[0]!, to: dates[dates.length - 1]! };
    const categories = [...new Set(all.products.map((p) => p.topCategory))].sort();

    report(
      `synthetic dataset: ${all.reviews.length} rows across ${categories.length} categories ` +
        `(${categories.join(", ")}), window ${window.from}..${window.to}`,
    );

    // Verified BEFORE anything is billed: the three selections must be an exact
    // partition of the dataset — every row in exactly one, none left over, none
    // counted twice. Asserting coverage afterwards would confirm it only after
    // paying to find out.
    const selections = categories.map((category) => {
      const input: AnalysisInput = { scope: { kind: "category", category }, ...window };
      return { category, input, rows: selectForScope(input, all.reviews, all.products).rows };
    });
    const selectedIds = selections.flatMap((s) => s.rows.map((r) => r.id));
    const allIds = all.reviews.map((r) => r.id);

    expect(selectedIds.length, "no row selected twice").toBe(new Set(selectedIds).size);
    expect([...selectedIds].sort(), "exact partition of all 31 records").toEqual([...allIds].sort());
    expect(selectedIds.length, "all 31 rows covered").toBe(31);
    report(
      `partition verified: ${selections.map((s) => `${s.category}=${s.rows.length}`).join(" + ")} ` +
        `= ${selectedIds.length} of ${allIds.length}`,
    );

    for (const selection of selections) {
      await runGate(`synthetic-${selection.category}`, all, selection.input, selection.rows.length);
    }

    syntheticPassed = true;
  });

  it("run 2 — the complete amazon:OfficeProducts category", async (ctx) => {
    // Sequenced deliberately: the cheap, fully-controlled dataset proves the
    // pipeline before the expensive one is attempted.
    if (!syntheticPassed) {
      report("\n!! SKIPPED amazon:OfficeProducts — the synthetic runs did not all pass");
      ctx.skip();
    }
    const ds = adaptAmazonCsv(
      readFileSync("public/amazon-products.csv", "utf8"),
      "amazon-products.csv",
    ).dataset;
    const input: AnalysisInput = {
      scope: { kind: "category", category: "OfficeProducts" },
      from: "",
      to: "",
    };
    const { rows } = selectForScope(input, ds.reviews, ds.products);
    await runGate("amazon-office-products", ds, input, rows.length);
  });

  it("stayed within the hard ceiling", () => {
    report(
      `\n=== TOTAL ===\n` +
        `requests=${spend.requests} inputTokens=${spend.inputTokens} outputTokens=${spend.outputTokens}\n` +
        `byEndpoint=${JSON.stringify(spend.byEndpoint)}\n` +
        `cumulative=$${spend.usd().toFixed(4)} ceiling=$${HARD_CEILING_USD.toFixed(2)}\n` +
        `outcomes=${JSON.stringify(outcomes, null, 1)}`,
    );
    expect(ceilingController.signal.aborted, "ceiling was not hit").toBe(false);
    expect(spend.usd()).toBeLessThan(HARD_CEILING_USD);
  });
});
