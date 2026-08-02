# ADR 0001 — Category-scale Claude analysis

**Status:** approved in direction; revised 2026-08-02 with rolling adaptive
sizing, bounded/hierarchical canonicalization, pre-run cost confirmation, and
browser-orchestration semantics. Nothing implemented.
**Date:** 2026-08-02
**Supersedes:** the single-request Claude path in `api/analyze.ts` + `src/services/claudeEngine.ts`

---

## A. ADR

### Problem

ReviewIQ's product promise is category analysis: select a whole category, get an
evidence-backed report. The Claude engine sends every selected row in one
synchronous request. Benchmarking shows that architecture cannot deliver the
promise at any tuning.

### Benchmark evidence

Measured 2026-08-02 (`bench/DECISION.md`, raw runs in `bench/results/`):

| measurement | value |
| --- | --- |
| Streaming throughput, consistent across datasets | **~110 output tok/s** |
| Output tokens per tag | ~61 |
| Tags per dense Amazon row | ~6.6 |
| Tags per light synthetic row | ~2.2 |
| 5 dense rows | pass, 18.7 s / 20.6 s |
| 10 dense rows | timeout 30 s, 2/2 |
| 20 dense rows | timeout 30 s, 2/2 |
| 100 dense rows | timeout 30 s, 2/2 (both models) |
| 25-row synthetic demo category (2,814 B total) | timeout 30 s, 2/2 |

Timed-out runs streamed 7,000–8,000 characters with ~1 s time-to-first-token, so
nothing stalled — the model generated steadily and had more to emit. **The
constraint is output volume against throughput, not input size.** A 2.8 KB /
25-row request fails while a 4.9 KB / 5-row request passes.

Extrapolated to the product's real unit of work — three of nine top-level Amazon
categories hold 447–526 records:

- 526 rows × 6.6 tags = ~3,470 tags ≈ **212,000 output tokens**
- at 110 tok/s = **~32 minutes**
- `claude-opus-4-8` `max_tokens` ceiling = **128,000**

The request is impossible before it is slow.

### Rejected alternatives

| alternative | why rejected |
| --- | --- |
| Raise the timeout | 300 s buys 33 k tokens ≈ 82 rows, still <1/6 of a category; 128 k output ceiling is absolute; `maxDuration` is 60 s on Hobby; a multi-minute request has no progress and loses everything to one blip |
| Lower the row cap | measured comfortable cap is 3–5 rows ≈ 1% of a category; every category selection becomes an error message; **fails on the deployed 25-row demo dataset too** |
| Faster/cheaper model | fast mode (2.5×) → still 13 min; Haiku (~3×) → still 11 min; the 128 k ceiling is model-independent. Closing the gap needs ~100× |
| Long-running synchronous Vercel function | platform-limited to 60 s on this plan; describing it as production-ready would be false |
| Server-orchestrated background job | correct at scale, but needs durable state + queue/worker; disproportionate for this MVP (see §Execution model) |

### Chosen architecture

**Client-orchestrated bounded batching, with a single label-only
canonicalization pass and deterministic aggregation.**

The browser already selects rows, re-validates tags, and computes every number.
Making it the orchestrator keeps each function invocation short and stateless and
requires no new infrastructure. `/api/analyze` becomes a stateless per-batch
tagger; a new `/api/canonicalize` reconciles theme labels across batches and
never receives review text.

### Consequences

- Category analysis is preserved at real scale, with progress and cancellation.
- Each server invocation stays ~13–15 s, well inside platform limits.
- Wall time: deployed demo ~30–35 s; a local 526-row category ~5.5 min.
- No new infrastructure, no new vendor, no persistence.
- **A page refresh loses an in-flight run.** Acceptable at demo scale; the cost of
  avoiding it is a durable job store (§Storage).
- **Batch boundaries vary between runs**, because sizing adapts to observed
  density. Coverage, order and aggregation stay invariant; reproducible
  boundaries do not.
- **Hierarchical canonicalization may fragment cross-group synonyms**, splitting
  one concept's support across two themes and under-counting both. Grounding is
  unaffected; consolidation is not guaranteed. See the analytical limitation
  under §Cross-batch theme canonicalization.
- One new model-driven step (label grouping) is added — but it replaces an
  *implicit* one that today happens inside every batch prompt, and it is
  separately validated. Net auditability improves.
- Cost becomes proportional to category size (§Cost model), so a run ceiling is
  now a required control rather than a nicety.

### Future work

Durable job API + resume; adaptive per-dataset batch calibration cached across
runs; hierarchical canonicalization for very large label sets; optional
Claude-authored narrative behind aggregate-only validation; cross-run caching of
batch results keyed by content hash.

---

## Stage-by-stage: deterministic vs model-driven

The model is allowed to influence exactly two things: **what a theme is called**,
and **which span of text supports it**. Every number remains TypeScript.

| # | Stage | Nature | Notes |
| --- | --- | --- | --- |
| 1 | `selectForScope` row selection | **deterministic** | unchanged; both engines read identical rows |
| 2 | Density calibration probe | model call | output used only to size batches; contributes no product data |
| 3 | Chunking | **deterministic** | pure function of (rows, density) |
| 4 | Per-batch tagging | **model-driven** | themes, per-mention sentiment, evidence span |
| 5 | Review-id + evidence-span validation | **deterministic** | `validateTags`, both gates, unchanged |
| 6 | Exact-label pre-merge | **deterministic** | `normalizeTheme` (case/whitespace only) |
| 7 | Cross-batch label grouping | **model-driven** | labels only; no text, no counts |
| 8 | Mapping validation | **deterministic** | total, closed, acyclic, no unknown keys |
| 9 | Dedup on canonical key | **deterministic** | |
| 10 | Unique-row counting | **deterministic** | |
| 11 | Percentages | **deterministic** | denominator = full selected row count |
| 12 | Threshold + ordering | **deterministic** | |
| 13 | Quote selection | **deterministic** | pure function of validated tags |
| 14 | Summary text | **deterministic** (MVP) | see §Final summary |

---

## B. Architecture diagram

```
 BROWSER (orchestrator)                          SERVER (stateless)          ANTHROPIC
 ─────────────────────                           ──────────────────          ─────────
 analyzeReviews(input, dataset, {signal,onProgress})
        │
        ├─ selectForScope ──────────────► rows[]            (deterministic)
        │
        ├─ guard: rows.length <= MAX_ROWS_PER_ANALYSIS
        │         else AnalysisError (names the count; never truncates)
        │
        ├─ estimateRun(rows) ─► { batches, runtime, costUsd }
        │         if costUsd > CONFIRM_ABOVE_USD → await user confirmation
        │
        ├─ runId = randomUUID()   AbortController per run
        │
        ├─ fan-out, concurrency 6           ┌─ rolling resize ─────────────┐
        │     ┌──────────────┐              │ density = EWMA(observed)     │
        │     │ batch 1..N   │───► POST /api/analyze ──► messages.stream   │
        │     └──────────────┘◄── { tags[] } │ latency > 18s ⇒ halve       │
        │            │                      │ applies to UNDISPATCHED only │
        │            │                      └──────────────────────────────┘
        │            ├─ drop if runId ≠ current   (superseded run)
        │            ├─ client re-validation      (gate 2, strict)
        │            └─ held in memory only       ◄── NO PERSISTENCE
        │
        ├─ distinct labels ────────────► POST /api/canonicalize ──► messages.stream
        │            │  ≤300 labels: one pass;  >300: hierarchical, sorted chunks
        │            ◄── { groups: number[][] }   (labels only, no review text)
        │            └─ validate composed map (total / closed / shrinking)
        │
        ├─ apply mapping → dedup(reviewId, canonicalKey, sentiment)
        ├─ count unique supporting rows
        ├─ percent = supportingRows / selectedRows
        ├─ threshold, deterministic ordering, quote selection
        └─ AnalysisResult ───────────► ResultsView / copyReport
```

Failure at any stage ⇒ `AnalysisError` ⇒ existing error UI. No partial report,
no heuristic fallback.

---

## Batching design

### Batch-size rule — output-token budget, not row count

Row count alone is insufficient: the benchmark showed a 25-row / 2.8 KB request
failing while a 5-row / 4.9 KB request passed, because output scales with *how
much each row has to say*, not its length. Measured output density varies ~3×
between datasets (405 output tok/row dense vs ~136 light).

The rule, in priority order:

```
TARGET_OUTPUT_TOKENS = 1400          // ~13 s at 110 tok/s → 2.3x headroom under 30 s

rowsPerBatch = clamp(
  floor(TARGET_OUTPUT_TOKENS / measuredOutputTokPerRow),
  MIN_ROWS = 1,
  MAX_ROWS = 12
)
subject to:  batchTextBytes <= 16 KB     // secondary guard
             batchRows      <= 12        // hard cap, independently enforced server-side
```

#### Rolling adaptive sizing

`measuredOutputTokPerRow` is **re-estimated after every successful batch**, not
measured once. A single up-front calibration assumes a category is uniform, and
categories are not: a run can start on terse listings and reach verbose ones
halfway through, at which point a size fixed by batch 1 is already wrong.

```
seed:      density = 405 tok/row        // conservative dense default
on each successful batch b:
           observed = b.outputTokens / b.rows
           density  = 0.6 * observed + 0.4 * density      // EWMA, recent-weighted
           latency  = 0.6 * b.latencyMs + 0.4 * latency
resize:    next = clamp(floor(TARGET_OUTPUT_TOKENS / density), 1, MAX_ROWS_PER_BATCH)
           next = min(next, ceil(1.5 * currentRows))      // grow slowly
           if latency > LATENCY_SHRINK_MS (18 s):         // proactive, pre-failure
               next = max(1, floor(currentRows / 2))
apply to:  batches not yet dispatched — in-flight batches keep their size
```

The first batch is still deliberately small (2 rows) so the first observation
arrives early and costs little; it is batch 1, not an extra request.

Two signals drive resizing, and the latency one matters most. Token density
tells us what a batch *will* emit; observed latency tells us how close the
current size is running to the 30 s wall. Shrinking when p50 latency crosses 18 s
resizes **before** a batch fails rather than after — which is the difference
between a run that slows down and a run that loses a batch to a timeout.

**Timeout-based halving is retained as the reactive fallback.** If a batch still
returns `stop_reason: "max_tokens"` or times out, halve the size for all
remaining batches and retry that batch once at the smaller size. The rolling
estimate should make this rare; keeping it means an abrupt density change cannot
cascade into repeated failures.

Growth is capped at 1.5× per adjustment so one unusually terse batch cannot
enlarge the next batch into a timeout. Shrinking is not rate-limited — reacting
slowly to a size that is failing has no upside.

#### These constants are provisional, and must stay observable

`SEED_DENSITY`, `DENSITY_EWMA_ALPHA`, `LATENCY_SHRINK_MS` and
`MAX_GROWTH_FACTOR` are **tuning decisions extrapolated from a small benchmark**:
two datasets, one model, a handful of sizes. They are reasonable starting values,
not measured optima, and nothing downstream should treat them as settled. They
belong in configuration, not scattered as literals.

Tuning them later has to be evidence-based rather than another guess, so every
resize decision is logged with the inputs that produced it:

| field | why |
| --- | --- |
| `plannedRows` | what the planner intended for this batch |
| `actualRows` | what was dispatched — divergence means a bound clamped it |
| `observedOutputTokPerRow` | the measurement this batch contributed |
| `densityAfter` | the EWMA value after folding it in |
| `observedLatencyMs` / `latencyAfter` | raw and smoothed latency |
| `nextRows` | the size computed for the following dispatch |
| `resizeReason` | `"ewma"`, `"latency_pressure"`, `"timeout"`, `"truncation"`, or `"unchanged"` |

`resizeReason` is the field that makes the data usable: it separates a size that
drifted down because output genuinely got denser from one that was cut because a
batch was already failing. Without it the log records that a resize happened but
not whether the proactive path was doing any work — which is precisely the
question the next round of tuning has to answer.

### Two ceilings, never interchangeable

The design has two row limits. They are different controls at different layers,
and conflating them would silently change what the system enforces:

| name | layer | means | enforced by |
| --- | --- | --- | --- |
| `MAX_ROWS_PER_ANALYSIS` | run | the largest **category** an analyst may submit at all | client, before any dispatch; a controlled error, never a truncation |
| `MAX_ROWS_PER_BATCH` | request | the most rows sent to Claude in **one HTTP request** | the server, independently of whatever the client believes |

`MAX_ROWS_PER_ANALYSIS` is a product and cost decision (60 on the protected
demo, 600 locally). `MAX_ROWS_PER_BATCH` is a safety property of the endpoint —
it bounds the blast radius of a single request and holds even if a client is
buggy, stale, or hostile. One is about how much work a person may ask for; the
other is about how much work one request may carry.

**They must never be aliased, defaulted to one another, or described with the
same word in code, logs, or UI copy.** In particular the user-facing over-limit
message refers to the *analysis* ceiling; the server's 413 refers to the *batch*
ceiling, and no analyst should ever see the latter — reaching it means the
orchestrator is broken, not that the selection was too big.

### Recommended parameters

| parameter | value | derivation |
| --- | --- | --- |
| `TARGET_OUTPUT_TOKENS` | 1,400 | 13 s at measured 110 tok/s |
| `SEED_DENSITY` | 405 tok/row | measured dense-row default, used until batch 1 reports |
| `DENSITY_EWMA_ALPHA` | 0.6 | recent-weighted; tracks drift without chasing one outlier |
| `LATENCY_SHRINK_MS` | 18,000 | 60% of the 30 s wall — shrink before a batch fails |
| `MAX_GROWTH_FACTOR` | 1.5× | one terse batch cannot enlarge the next into a timeout |
| `MAX_ROWS_PER_BATCH` | 12 | server-enforced ceiling |
| `MAX_BATCH_TEXT_BYTES` | 16 KB | secondary guard |
| Concurrency | 6 | ~25 req/min; bounds abort blast radius |
| Per-batch provider timeout | **30 s** (unchanged) | proven; 2.3× headroom vs 13 s target |
| Per-batch orchestrator retry | 1, on timeout/5xx/429 only | never on validation failure — deterministic, would fail again |
| Global retry budget | 10% of batch count | prevents runaway cost from systemic failure |
| Total job timeout | 12 min | 132 batches ÷ 6 × 15 s ≈ 5.5 min + margin |
| `MAX_ROWS_PER_ANALYSIS` | 600 (env-tunable) | cost ceiling; controlled error, never silent truncation |

### Ordering guarantees

Batches carry an index; results are keyed by it. Aggregation never depends on
completion order. Final ordering is a deterministic sort:
`(supportingRows desc, canonicalLabel asc)`. Quote order:
`(evidenceLength desc, rowIndex asc, evidence asc)`.

**What rolling sizing does and does not change.** Batch *boundaries* are no
longer fixed in advance — they depend on observed density, which depends on
model output, so two runs over the same selection may split it differently. What
is invariant regardless:

- rows are consumed in selection order, never reordered or sampled
- every selected row lands in **exactly one** batch (asserted before aggregation)
- the percentage denominator is captured at plan time and never re-derived
- aggregation, thresholds, ordering and quote choice are pure functions of the
  validated tag set

So the report is deterministic given the tags; the batching is adaptive given
the data. Claiming byte-identical reports across runs would be false, and was
already false through model non-determinism in tagging.

### Deduplication across batches

Each row appears in exactly one batch, so pre-canonicalization cross-batch
duplicates are impossible. **After** canonicalization they become possible: two
distinct raw labels from the same review can collapse to one canonical theme with
the same sentiment. Therefore dedup runs **after** mapping, on
`(reviewId, canonicalThemeKey, sentiment)`. Counts of deduped entries are logged,
not treated as errors — unlike the per-batch gate, where any duplicate from our
own trusted server still fails the run.

### Category percentages

```
denominator = selectedRows.length        // FULL selected category row count
numerator   = |{ reviewId : validated tag with (canonicalTheme, sentiment) }|
percent     = round(100 * numerator / denominator)
```

The denominator is the full selection — never tagged rows, never batch rows,
never rows that survived validation. A row that produced no tags still counts in
the denominator, because it was analyzed and had nothing to say.

### Evidence quote selection after aggregation

Pure function of validated tags for `(canonicalTheme, sentiment)`:

1. sort by `(evidence.length desc, rowIndex asc, evidence asc)`
2. take the first `MAX_QUOTES_PER_FINDING`
3. at most one quote per review

Longest-first favours quotes with enough context to stand alone; the tie-breakers
make it deterministic. No model input.

---

## Cross-batch theme canonicalization

### Option A — controlled theme vocabulary

Map model labels into a fixed catalog (the repo already has
`src/services/themeLibrary.ts` for the heuristic engine).

**Pros:** fully deterministic; zero extra model calls; stable across runs and
comparable across categories; trivially testable.

**Cons:** closed-world. It can only recognise themes the catalog already lists,
which destroys the Claude engine's entire differentiator — SPEC requires
"identify specific product themes from the actual language customers use." A
novel complaint would be silently dropped or forced into a wrong bucket, which is
worse than fragmenting it.

**When it works:** narrow domains with a genuinely stable taxonomy, or as a
*post-hoc stabiliser* layered on top of open-vocabulary output.

### Option B — second normalization pass (labels only)

Send the distinct validated labels to Claude; receive a grouping.

**Pros:** preserves open vocabulary; one small bounded request; fully parallel
tagging phase; the model sees **no review text, no counts, no quotes**; output is
small and mechanically checkable; scoreable today against
`bench/fixtures/clusters.json` (true-merge / false-merge).

**Cons:** an extra model dependency and an extra failure mode; grouping quality
varies; it is a place where model judgment affects counts — though that is not
new, since today's prompt already asks for clustering *inside* each batch.

**Output shape.** A per-label mapping is too verbose: ~400 labels would emit
~4,800 tokens ≈ 44 s, over the timeout. Instead the model returns **index
groups** over a numbered label list, with the representative first:

```json
{ "groups": [[3, 17, 42], [0], [8, 11]] }
```

~1,200 tokens for 400 labels ≈ 11 s.

#### Bounded and hierarchical canonicalization

Canonicalization is a Claude request like any other, so it is subject to the same
30 s wall that broke the single-request tagging design. It gets its own explicit
bounds rather than an assumption that the label set stays small.

| bound | value | why |
| --- | --- | --- |
| `MAX_LABELS_PER_REQUEST` | 300 | ~900 output tokens of index groups ≈ 8 s |
| `MAX_LABEL_BYTES_PER_REQUEST` | 24 KB | secondary guard on unusually long labels |
| `MAX_CANONICALIZATION_LEVELS` | 3 | covers ~27,000 raw labels; beyond it, fail |

**Level 0 — deterministic pre-merge.** `normalizeTheme` collapses labels that
differ only in case or whitespace. Free, exact, and typically removes a large
fraction before any model call.

**Single pass.** If distinct labels ≤ `MAX_LABELS_PER_REQUEST`, one request. Done.

**Hierarchical pass.** Otherwise:

```
level 0: sort labels by normalizeTheme ascending      (deterministic partition)
         chunk into ceil(N / 300) groups
         canonicalize each chunk independently, in parallel
         -> representatives R0  (one per group, always an emitted label)
level 1: if |R0| > 300, repeat over R0
...      until |R| <= 300, then one final pass
```

Partitioning sorts before chunking, so the same label set always partitions the
same way **regardless of the order batches happened to complete in**. Chunks are
canonicalized in parallel, since each is independent.

**How an original label maps through multiple levels.** Each level produces a
total function `label -> representative`. The final map is their composition,
applied deterministically:

```
canonical(label) = f_n( ... f_1( f_0(label) ) )
```

Composition is validated, not assumed:

- each level's map is **total** over its own input set (every input has an image)
- each image is a member of that level's input set, so the final canonical label
  is always a **real emitted label** — no display name is invented at any level
- each level's output set is strictly smaller than its input, or the level is a
  fixed point and the walk stops — this is what makes termination provable
  rather than bounded only by the level cap
- the composed map is total over the *original* label set, and every original
  label resolves in ≤ `MAX_CANONICALIZATION_LEVELS` hops
- any violation fails the run

#### Known analytical limitation — not an implementation detail

Two synonyms can land in different level-0 chunks and fail to merge there:
alphabetical order does not group meanings. They merge at level 1 if both survive
as representatives, which is the common case — but not a guarantee, because a
representative is chosen within its own chunk without sight of the others.

**What this does and does not compromise.** Every finding remains fully grounded:
each quote is still a verbatim span of a real row, each count is still unique
supporting rows for the theme as reported, and nothing is invented. What can be
wrong is **consolidation**: one concept may appear as two themes, so its support
is split and each fragment counts lower than the concept deserves. A fragment can
therefore fall under `MIN_EVIDENCE` and disappear from the report entirely — a
finding that should have existed is absent, and nothing on screen indicates that.

This is an **analytical limitation of the method**, not a defect to be fixed in
review. It is accepted for this MVP with two consequences:

- the flat single pass is preferred whenever the label set fits, and the
  hierarchical path is a fallback rather than the default
- **the product must not claim perfect semantic consolidation.** Copy describing
  the Claude engine may say themes are grouped; it may not say they are grouped
  exhaustively or that every mention of a concept is counted together.

Failing the run on a malformed or invalid mapping remains correct and unchanged.
A silent fallback to raw fragmented labels would produce exactly this
under-counting *by default* while presenting a report that looks complete —
turning an occasional, bounded limitation into an unannounced one.

**Validation (all deterministic, any failure fails the run):**

- every index in `[0, labels.length)` — no invented indices
- every label index appears **exactly once** across all groups (total partition)
- each group non-empty; representative = `group[0]`, which must itself be an
  emitted label, so no display name is ever invented
- resulting map is acyclic by construction (representatives map to themselves)
- group count ≤ label count
- canonical labels are only ever *renames*; evidence, counts, and quotes are
  untouched

### Option C — embedding or similarity clustering

**C1, deterministic lexical similarity** (token overlap, stemming, Jaccard,
edit distance). No dependency, fully reproducible — and demonstrably inadequate
here: `bench/fixtures/clusters.json` was authored so paraphrases of one concept
share *no vocabulary* ("died after a week" / "won't hold a charge" / "runs flat
unbelievably quickly"). Lexical similarity scores those near zero. The repo's own
fixture already proves this option fails.

**C2, embeddings.** Would cluster correctly, but Anthropic ships no embeddings
endpoint, so it means a **second AI vendor** (Voyage, OpenAI, …): a new API key,
a new key-handling surface, a second entry in the privacy disclosure, a new
dependency, and a new failure mode — to solve a problem Option B solves with the
provider already in use. Plus a clustering threshold to tune, which is its own
calibration problem.

**Appropriate for this MVP?** No. C1 is provably too weak; C2 is disproportionate.

### Recommendation: **Option B**, with a deterministic pre-merge

1. **Deterministic first:** `normalizeTheme` collapses case/whitespace-identical
   labels for free. This typically removes a large fraction before any model call
   and shrinks the canonicalization request.
2. **Option B for the rest**, with index-group output and the validation above.
3. Option A is not adopted, but the mapping output is a natural place to layer a
   catalog later without changing anything upstream.

**Justification.** It is the only option that preserves the open vocabulary the
product's differentiator depends on, adds no vendor, keeps review text out of the
request entirely, produces output small enough to validate exhaustively in
TypeScript, and is measurable *today* against a fixture that already exists.
Option A trades the differentiator for determinism; Option C1 is refuted by our
own fixture; Option C2 buys the same outcome as B at the price of a second
vendor.

---

## Grounding across batches

| guarantee | mechanism |
| --- | --- |
| Every final theme is supported by validated batch tags | Findings are constructed *only* from `ValidatedTag[]`. A canonical theme with zero surviving tags cannot exist — it has no rows to count. |
| Every quote is an exact substring of its original row | `validateTags` checks `reviewText.includes(evidence)` against **that specific review**, server-side then again client-side. Canonicalization never touches `evidence`. Quotes are selected from validated tags only. |
| A row contributes at most once per normalized theme+sentiment | Dedup on `(reviewId, canonicalThemeKey, sentiment)` **after** mapping. |
| Counts are unique supporting rows | Numerator is the size of a `Set<reviewId>`, not a tag count. |
| Percentages use the full selected row count | Denominator is `selectedRows.length`, captured before batching and independent of tagging outcomes. |
| No final summary invents evidence | MVP summary is generated in TypeScript from aggregated findings only (§Final summary). |
| A batch failure cannot produce a partial report that looks complete | Any batch failure (after its one retry) rejects the whole run with `AnalysisError`. There is no partial-result path in the MVP. `AnalysisResult` is only ever constructed when **every** batch validated and canonicalization succeeded. |

Additional invariant, asserted before building the result:
`union(batch.reviewIds) === set(selectedRows.map(id))` — every selected row was
covered by exactly one batch. A mismatch is a programming defect and fails loudly.

---

## Final summary and recommendations

**Recommendation: TypeScript builds the summary. Claude does not write prose in
the MVP.**

Reasons: the deterministic summary path already exists and already satisfies the
evidence rules; a narrative pass adds a request, a failure mode, and a surface
where a model could imply a count or a theme that the aggregate does not support;
and validating free prose against an aggregate is materially harder than
validating an index-group mapping. The MVP gains nothing a reviewer would value
enough to offset that.

If a Claude narrative is added later, it must:

- receive **only validated aggregate facts** (canonical labels, unique-row
  counts, percentages, thresholds) and **no raw review text**
- be forbidden from introducing themes, counts, quotes, or recommendations not
  present in the aggregate
- be validated: every number in the prose must appear in the aggregate; every
  theme named must exist in the findings; failure ⇒ fall back to the
  deterministic summary (not to silence, and not to the heuristic engine)
- be visually distinguished in the UI from deterministic metrics, and labelled as
  generated prose

---

## Execution model

| | 1. Long-running sync function | 2. **Client-orchestrated fan-out** | 3. Server background job |
| --- | --- | --- | --- |
| Vercel duration | ✗ needs ~5.5 min vs 60 s limit | ✓ each call ~13–15 s | ✓ each worker call short |
| Browser timeout | ✗ minutes-long single request | ✓ many short requests | ✓ short poll requests |
| Category sizes | ✗ fails above ~5 rows | ✓ to `MAX_ROWS_PER_ANALYSIS` | ✓ unbounded |
| Partial failures | ✗ all-or-nothing, no retry unit | ✓ per-batch retry | ✓ per-batch retry + resume |
| Retry behavior | ✗ restart everything | ✓ retry one batch | ✓ retry one batch |
| UX | ✗ no progress | ✓ real progress + cancel | ✓ progress + survives refresh |
| Complexity | low | **low–moderate** | high: durable store, worker, queue, expiry, auth on job reads |
| Cost tracking | per request | per batch, client-aggregated | per batch, server-recorded |

**Recommended: option 2.** It is explicitly *not* a long-running synchronous
Vercel function — no invocation exceeds ~15 s. It reuses the client's existing
role as validator and aggregator, needs no new infrastructure, and gives real
progress and cancellation.

**Honest limitation:** a refresh or tab close loses an in-flight run; there is no
resume. At demo scale (~35 s) that is negligible; at local 526-row scale
(~5.5 min) it is a real annoyance. The fix is option 3, and its cost is a durable
store plus a job API — disproportionate for this MVP, and pre-designed below so
the door stays open.

---

## Browser orchestration semantics

The browser owns the run, so the run's lifecycle rules have to be explicit.

### Run identity

Every run gets a `runId` (`crypto.randomUUID()`). It travels on each batch
request for log correlation, and the orchestrator holds the *current* runId in a
ref. **Any batch result whose runId is not the current one is discarded on
arrival**, before validation and before aggregation. This is what makes a
superseded run harmless rather than a source of mixed results: an in-flight
response from an abandoned run cannot reach the aggregator even if its `fetch`
resolves after the new run has started.

### Cancellation

One `AbortController` per run. Cancelling:

1. aborts every in-flight `fetch`
2. **clears the queue of unscheduled batches** — the scheduler checks
   `signal.aborted` before dispatching each queued batch, so cancellation stops
   *future* spend, not just current requests
3. returns the UI to idle with no result and no error banner

Cancellation is triggered by the Cancel control, by editing the query, and by
starting a new run. It is a cost control as much as a UX affordance: on a
five-minute run, the unscheduled batches are the bulk of the remaining spend.

**Honest limit:** an already-dispatched request continues briefly on the server
and is billed. Abort stops us waiting for it; it does not stop Anthropic
generating it.

### Duplicate submissions

Submit is disabled while `status === "loading"`, so double-clicking cannot start
two runs. If a run is started anyway (programmatically, or from a restored
state), the new run **supersedes**: the previous controller is aborted, a new
runId is minted, and late results from the old run are dropped by the runId
check. Two runs never aggregate into one report.

### Terminal batch failure

The first terminal failure — a batch that exhausted its single retry, or any
validation failure, or a canonicalization failure — immediately:

1. aborts the run's controller, stopping sibling batches and clearing the queue
2. sets `status: "error"` with the controlled message
3. **constructs no `AnalysisResult`**

Sibling batches are cancelled rather than allowed to finish, because their output
can no longer be used and would only add cost.

### Navigation and refresh

Nothing is persisted, so a refresh or tab close loses the run. While
`status === "loading"`, the app registers a `beforeunload` handler so the browser
warns before discarding work in progress; it is removed the moment the run
settles, so it never nags outside an active run. The warning is a mitigation, not
a fix — the fix is the durable job API in *Future work*.

### Report availability

Copy and export are enabled **only** when `status === "success"`. They are
unavailable while loading, on error, and after cancellation. Because the MVP has
no partial-result path, there is no state in which a report exists but is
incomplete — the guarantee is structural rather than a check on a flag.

## Storage decision

**Do intermediate validated tags need temporary persistence?** Only if the
orchestrator is server-side. With client orchestration they live in browser
memory for the duration of the run and are discarded.

| option | durability | cleanup | privacy | cost | complexity | resume |
| --- | --- | --- | --- | --- | --- | --- |
| **In-memory (browser)** | none | automatic on navigation | **best — review text never persisted anywhere** | $0 | lowest | none |
| Vercel KV / Redis | good | TTL required | review text + evidence at rest off-device | free tier, then paid | moderate: provisioning, TTL, key design | yes |
| Database table | best | migrations + retention job | worst — durable PII-adjacent store | paid | high | yes |
| Object storage | good | lifecycle rules | text at rest | low | moderate | yes |
| No persistence, sequential | none | n/a | best | $0 | lowest | none |

Sequential processing is rejected on latency alone: 132 batches × 15 s ≈ 33 min.

**Recommendation: in-memory only.** It is the smallest option that still produces
a trustworthy report, because trustworthiness comes from validation and
all-or-nothing aggregation, not from durability. It also keeps the standing
guarantee — no permanent storage of review text — true by construction rather
than by retention policy, and needs no approval to store anything.

---

## C. API proposal

The job-style API is deliberately **not** proposed for the MVP: with client
orchestration there is no server-side job to create, poll, cancel, or expire. Two
stateless endpoints suffice.

### `POST /api/analyze` — per-batch tagging

```jsonc
// request
{ "runId": "uuid", "batchIndex": 3, "reviews": [{ "id": "...", "text": "..." }] }
// response 200
{ "tags": [{ "review_id": "...", "theme": "...", "sentiment": "praise|fault|neutral",
             "evidence_span": "..." }] }
```

`runId` / `batchIndex` are **log correlation only** — the server holds no state
and treats every request independently.

### `POST /api/canonicalize` — label reconciliation

```jsonc
// request — labels ONLY. Review text is structurally absent from this contract.
{ "runId": "uuid", "labels": ["battery life", "poor battery", "comfort", ...] }
// response 200
{ "groups": [[0, 1], [2]] }   // indices into `labels`; groups[i][0] is the representative
```

### Cross-cutting

| concern | behavior |
| --- | --- |
| Input validation | `parseReviewRequest` unchanged for `/analyze`; labels must be a non-empty array of non-blank strings, ≤ `MAX_LABELS`, deduped by the client |
| Size caps | `/analyze`: ≤ 12 rows, ≤ 16 KB text, ≤ 32 KB body. `/canonicalize`: ≤ 500 labels, ≤ 32 KB body |
| Authentication | Vercel Authentication at the edge (protected preview deployment). No app-level auth. |
| Feature gate | `CLAUDE_ENABLED` fail-closed, checked before any provider call, on both routes |
| Idempotency | Not required: both endpoints are pure functions of their request body with no server state, so a retry is inherently safe |
| Progress reporting | Client-side, from completed batch count. No server progress endpoint |
| Cancellation | Client `AbortSignal` stops issuing new batches and aborts in-flight `fetch`es. **Honest caveat:** an already-dispatched Anthropic call continues briefly server-side and is billed |
| Expiration | N/A — nothing is stored |
| Result retrieval | The result is assembled in the browser; there is nothing to fetch |
| Error model | Unchanged shape `{ error: { code, message } }`; codes below |

### Future job contract (not MVP)

If resume-after-refresh is ever required:

```
POST /api/analysis-jobs        → { jobId }
GET  /api/analysis-jobs/:id    → { status, completedBatches, totalBatches, phase,
                                   result?, error? }
DELETE /api/analysis-jobs/:id  → cancel
```

with a KV store, TTL-based expiry, per-job ownership checks, and server-recorded
cost. Adopting it later requires no change to `AnalysisResult` or the aggregation
code — only to who runs the loop.

---

## Failure semantics

**No silent partial success.** The MVP has no partial-result path at all.

| event | behavior | user sees |
| --- | --- | --- |
| One batch times out | 1 retry (halved size); then fail run | "The analysis timed out partway through. Try a narrower selection." |
| Malformed model output | server returns `analysis_failed`; no retry (deterministic) | "The analysis engine returned an unreadable result." |
| All tags rejected in one batch | fail run — this is a provider-response failure, not "no themes" | "The analysis engine returned no usable results." |
| Provider rate limit (429) | 1 retry after backoff; then fail run | "The analysis service is busy. Please try again shortly." |
| Provider outage (5xx) | 1 retry; then fail run | "The analysis service is unavailable right now." |
| Canonicalization fails or mapping invalid | fail run — fragmented themes would under-count and could hide a finding | "The analysis could not be completed. Please try again." |
| User refresh / tab close | run is lost; nothing persisted; no orphaned server state | fresh idle state |
| Duplicate submission | client disables submit while running; a second run supersedes and aborts the first | — |
| Job expiration | N/A (no jobs) | — |
| Spending limit reached | provider error surfaces as `provider_unavailable`; **never** claimed as a billing cause unless the response safely supports it | "The analysis service is unavailable right now." |

If partial results are ever introduced, they must carry an explicit incomplete
flag, state the covered row count, suppress percentages (whose denominator would
be wrong), and be excluded from copy/export.

---

## Pre-run cost and runtime confirmation

A category run can cost dollars and take minutes. Both are estimated **before any
request is dispatched**, from the row count, the seed density (or the last
density observed for this dataset in this session), the verified price table, and
the concurrency setting:

```
batches      = ceil(rows / rowsPerBatch(SEED_DENSITY))
inputTokens  = rows * inputTokPerRow + batches * PROMPT_OVERHEAD_TOKENS   // 760
outputTokens = rows * SEED_DENSITY
estCostUsd   = inputTokens/1e6 * inRate + outputTokens/1e6 * outRate
estRuntimeMs = ceil(batches / CONCURRENCY) * estBatchLatencyMs
```

### Two ceilings, and the confirmation threshold

| control | protected demo | local | behavior above |
| --- | --- | --- | --- |
| `MAX_ROWS_PER_ANALYSIS` | **60** | **600** | controlled error naming the row count and remedies — never a silent truncation |
| `CONFIRM_ABOVE_USD` | **0.25** | **0.50** | explicit confirmation before dispatching |

The ceilings differ because the exposures differ. The protected demo serves only
the 25-row synthetic dataset, so 60 rows is far above anything it can legitimately
be asked for and exists purely to bound a mistake. Local runs work against the
real dataset, where a 526-row category is the *point*, so the ceiling has to
accommodate it while still refusing something absurd.

Which ceiling applies is a build-time constant, not a runtime negotiation.

### The confirmation

Above the threshold the analyst sees the estimate and must accept it:

```
This category has 526 records. Analysis will run about 132 batches,
take roughly 5-6 minutes, and cost approximately $6.40.

                                        [ Cancel ]  [ Run analysis ]
```

Below the threshold, nothing is shown — a 25-row demo category costs about $0.13
and must not acquire a confirmation dialog it does not need.

### Estimates are labelled, and reconciled

The figures are estimates and say so. After the run, measured token usage is
summed from the per-batch responses and logged alongside the estimate, so the
seed density and the estimator can be corrected against reality instead of
drifting. An estimate that is never checked against the bill is a guess with a
dollar sign in front of it.

## Cost model

Measured inputs: dense rows ~277 input tok/row and ~405 output tok/row; light
synthetic rows ~32 input and ~136 output tok/row; fixed system-prompt overhead
**~760 input tokens per batch**. Prices verified 2026-08-02: Opus 4.8 $5/$25 per
MTok.

| category | batches | input tok | output tok | tagging | canon. | **typical** | worst case (+10% retries) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 25 rows, light (deployed demo) | 7 | 6.1 k | 3.4 k | $0.12 | ~$0.01 | **$0.13** | $0.15 |
| 25 rows, dense | 7 | 12.2 k | 10.1 k | $0.31 | ~$0.01 | **$0.32** | $0.36 |
| 100 rows, dense | 25 | 46.7 k | 40.5 k | $1.24 | ~$0.03 | **$1.27** | $1.40 |
| 500 rows, dense | 125 | 233.5 k | 202.5 k | $6.23 | ~$0.13 | **$6.36** | $7.00 |

An optional Claude summary pass would add ~$0.02 per run — negligible, and not
recommended for other reasons.

**Portfolio-safe limits.** The deployed demo serves only the 25-row synthetic
dataset, so its largest possible category costs **~$0.13**. The $6+ figures apply
only to local runs against the real dataset. Recommended:

- `MAX_ROWS_PER_ANALYSIS` = 600, with a **controlled error** above it that names
  the row count and the remedies — never a silent truncation
- log an estimated cost per run alongside the existing structured fields, so
  spend is observable without a dashboard
- keep `CLAUDE_ENABLED` as the instant off switch

**The $20 account limit is the final backstop, not the control.** It permits ~3
full 500-row local runs, or ~150 deployed-demo category runs. It cannot
distinguish a legitimate run from a loop, which is why the run ceiling and the
kill switch sit in front of it.

---

## UX

Product scope is unchanged and stays fast: a single product is normally 1 batch,
so it behaves exactly as today with no progress chrome.

Category scope, staged progress:

```
Analyzing category…                    (calibrating)
Batch 3 of 12 complete                 (tagging — determinate bar)
Merging themes…                        (canonicalizing)
Building report…                       (aggregating)
```

| aspect | behavior |
| --- | --- |
| Progress state | determinate `completed / total` once planning is done; indeterminate during calibration |
| Pre-run confirmation | above `CONFIRM_ABOVE_USD`, an explicit dialog stating batch count, estimated runtime and estimated cost. Below it, nothing is shown |
| Cancel | a Cancel button beside the progress bar; editing the query or starting a new run also cancels. Aborts in-flight batches **and clears the unscheduled queue** |
| Leaving mid-run | `beforeunload` warns while a run is in flight, and only then — nothing is persisted, so a refresh loses the run |
| Timeout messaging | names the stage reached and suggests a narrower selection; never implies partial results exist |
| Partial-failure messaging | there are none — a failed batch fails the run, stated plainly |
| Success | the existing `ResultsView`, unchanged |
| Copy report | available only on a complete result, exactly as today |

`AnalysisState` gains `{ status: "loading", phase, completed, total }`.
`AnalysisResult` is unchanged.

---

## D. Data model

```ts
// --- planning -------------------------------------------------------------
interface BatchPlan {
  runId: string;
  selectedRowCount: number;        // percentage denominator, fixed at plan time
  /** Rows in selection order. Boundaries are decided as the run proceeds. */
  rows: IncomingReview[];
  estimate: RunEstimate;
}

/** Mutable sizing state, updated after every successful batch. */
interface DensityState {
  outputTokPerRow: number;         // EWMA, seeded at SEED_DENSITY
  latencyMs: number;               // EWMA, drives proactive shrink
  rowsPerBatch: number;            // current size for the NEXT dispatch
}

interface RunEstimate {
  batches: number;
  runtimeMs: number;
  costUsd: number;                 // an estimate, labelled as such in the UI
  requiresConfirmation: boolean;   // costUsd > CONFIRM_ABOVE_USD
}

interface Batch {
  index: number;                   // ordering key; aggregation never uses arrival order
  reviews: IncomingReview[];       // { id, text }
  textBytes: number;
}

// --- execution ------------------------------------------------------------
type BatchOutcome =
  | { index: number; status: "ok"; tags: ValidatedTag[]; outputTokens: number }
  | { index: number; status: "failed"; code: BatchErrorCode; attempts: number };

type BatchErrorCode =
  | "timeout" | "provider_unavailable" | "rate_limited"
  | "invalid_response" | "all_rejected" | "aborted";

// --- existing, unchanged --------------------------------------------------
interface ValidatedTag {
  reviewId: string; theme: string; themeKey: string;
  sentiment: TagSentiment; evidence: string;
}

// --- canonicalization -----------------------------------------------------
interface CanonicalTheme {
  key: string;            // normalizeTheme(label) of the representative
  label: string;          // display label — always an emitted label, never invented
  memberKeys: string[];   // raw themeKeys folded into this theme
}

type ThemeMap = ReadonlyMap<string /* rawThemeKey */, CanonicalTheme>;

// --- progress -------------------------------------------------------------
type AnalysisPhase = "calibrating" | "tagging" | "canonicalizing" | "aggregating";
interface AnalysisProgress { phase: AnalysisPhase; completed: number; total: number }

// --- result ---------------------------------------------------------------
// AnalysisResult: UNCHANGED.
```

---

## Testing strategy

All external calls mocked; no test spends money.

| area | tests |
| --- | --- |
| Batch planning | every row in exactly one batch, selection order preserved; row/byte caps respected; 0 and 1-row edges |
| Rolling sizing | EWMA tracks a density step-change; growth capped at 1.5×; latency over 18s shrinks *before* any failure; truncation/timeout halves and retries once; resize never touches dispatched batches |
| Cost estimation | estimator matches hand-computed values; over-ceiling raises a controlled error naming the count; confirmation fires above threshold and not below; demo and local ceilings differ |
| Hierarchical canonicalization | single pass under the bound; chunked above it; partition is sort-stable regardless of batch completion order; composed map is total, closed and shrinking; level cap exceeded ⇒ fail |
| Orchestration semantics | superseded run's late results are dropped by runId; cancel clears the unscheduled queue; terminal failure aborts siblings; export gated on success |
| Per-batch validation | unchanged grounding tests still pass; unknown review id, non-verbatim evidence, bad sentiment rejected |
| Cross-batch dedup | same review, two raw labels folding to one canonical theme + same sentiment counts **once** |
| Canonicalization validation | valid mapping applied correctly; rejects non-partition, out-of-range index, duplicate index, empty group, invented representative; scored against `bench/fixtures/clusters.json` |
| Unique-row counting | numerator is distinct reviews, not tags |
| Percentage math | denominator is full selection incl. rows that produced no tags; rounding |
| Batch failure | one failed batch ⇒ whole run throws `AnalysisError`; **no** `AnalysisResult` constructed |
| Retry | retried once on timeout/5xx/429; **never** on validation failure; global retry budget enforced |
| No-partial guarantee | property test: for any subset of failing batches, the engine never returns a result |
| Cost estimation | estimator matches hand-computed values for known token counts |
| End-to-end category job | mocked Claude, multi-batch category, progress callbacks in order, final result correct |
| Coverage invariant | `union(batch reviewIds) === selected row ids` |
| Benchmark | one real-shape run via `scripts/bench-models.ts` confirming batches land within the target latency band |

Existing endpoint tests (kill switch, misconfiguration, provider-not-called) carry
over to both routes.

---

## E. Implementation plan

Small, independently reviewable PRs. Each leaves the branch green and shippable.

**PR 0 — endpoint hardening. Shipped** (commits `6750554`, `77fee4e`):
`CLAUDE_ENABLED` fail-closed, provider error taxonomy, structured cost logs,
41 endpoint tests, privacy disclosure, bundle verification in CI. The row cap
was deliberately left at 100 — it belongs with the batching work below, where
its correct value is known.

| PR | Scope | Depends on | Risk |
| --- | --- | --- | --- |
| **1. Batch planner** | `batchPlanner.ts`: seeded density, EWMA update, latency-driven shrink, growth cap, byte/row bounds, coverage invariant. Pure functions, wired to nothing. | — | none |
| **2. Cost estimator + ceilings** | `estimateRun()`, `MAX_ROWS_PER_ANALYSIS` per build target, `CONFIRM_ABOVE_USD`. Controlled over-ceiling error. Still no batching. | 1 | low |
| **3. Per-batch endpoint retarget** | lower the server row cap to 12; update the client over-limit message to reference the run ceiling rather than the per-request cap. | 2 | low |
| **4. Batch execution** | orchestrator in `claudeEngine.ts`: runId, fan-out at concurrency 6, rolling resize between batches, retry, abort, queue clearing, terminal-failure abort. Aggregation still single-theme-space. | 3 | **medium-high** |
| **5. Canonicalization + aggregation** | `api/canonicalize.ts`, index-group output, single-pass and hierarchical paths, composition validation, post-map dedup, unique-row counts, percentages, quote selection. | 4 | **medium-high** |
| **6. Progress + confirmation UI** | `AnalysisState` phases, determinate progress, Cancel, pre-run confirmation dialog, `beforeunload` guard while running. | 4 | low |
| **7. Report/export integration** | copy/export gated on `success`; verify `copyReport` and `ResultsView` against multi-batch results; category-scale thresholds. | 5, 6 | low |
| **8. Observability + docs** | estimate-vs-actual reconciliation logging, runbook, README/SPEC/ADR updates, deployment verification. | 7 | low |

Two changes from the pre-revision sequence: the cost estimator moves **before**
batch execution (PR 2), because the run ceiling and the confirmation gate should
exist before anything can dispatch 132 requests; and the per-batch retarget is
split out (PR 3) so the cap change and the orchestrator land separately and can
be reverted independently.

PRs 4 and 5 carry the real risk and should not be combined.

### Acceptance gate — after PR 5/6, before PR 7

Unit tests prove each stage in isolation. This gate proves they **compose**, on
real runs rather than mocks, and must pass before export integration begins.

Run a full category analysis twice — once over the complete 25-row synthetic demo
category, once over at least one representative local category from the real
Amazon dataset (large enough to force multiple batches and, ideally, hierarchical
canonicalization) — and verify against the retained per-batch tags:

| check | assertion |
| --- | --- |
| Coverage | the union of review ids across all batches equals the selected row set, exactly — no row missing, none duplicated |
| Count integrity | **every displayed count equals the number of distinct validated review ids supporting that canonical theme and sentiment** — recomputed independently from the batch tags, not read from the aggregator |
| Denominator | every percentage divides by the full selected row count, including rows that produced no tags |
| Grounding | every displayed quote is a verbatim substring of the row it is attributed to |
| Dedup | no review contributes twice to one canonical theme + sentiment |
| Canonicalization | the composed map is total over the raw label set; every displayed label is one the model actually emitted |
| All-or-nothing | with one batch forced to fail, no result is produced and export stays unavailable |

The count-integrity check is the point of the gate: it is the one assertion that
fails if batching, canonicalization and aggregation are each individually correct
but wrong in combination — which is exactly the class of defect unit tests miss.

Record the outcome in `bench/DECISION.md` alongside the model decision.

---

## F. MVP recommendation

**The smallest implementation that genuinely preserves category analysis:**

1. Batch planner sized by **measured output density**, re-estimated after every
   successful batch, shrinking proactively on a latency trend and reactively on
   truncation or timeout.
2. `/api/analyze` as a stateless per-batch tagger, capped at 12 rows, fail-closed
   behind `CLAUDE_ENABLED`.
3. Client-orchestrated fan-out at concurrency 6, one retry per batch on transient
   failure, full `AbortSignal` cancellation.
4. Validated tags held **in browser memory only** — no persistence.
5. Label-only canonicalization (Option B) with index-group output, bounded at
   300 labels per request, hierarchical beyond that, with the composed mapping
   validated as total, closed, shrinking and acyclic.
6. Deterministic aggregation: dedup on the canonical key, unique-row counts,
   percentages over the full selection, deterministic ordering and quote choice.
7. TypeScript-authored summary. No Claude narrative.
8. All-or-nothing: any batch or canonicalization failure fails the run. No partial
   reports, no heuristic fallback.
9. Pre-run cost and runtime estimate, with confirmation above a threshold and a
   hard run ceiling that differs between the protected demo and local use.
10. Progress, cancel, `beforeunload` guard, runId-scoped result acceptance, and
    export gated on complete success; `AnalysisResult` contract unchanged.

Explicitly **not** in the MVP: durable job store, resume after refresh, server-side
orchestration, embeddings, theme catalog, Claude narrative, cross-run caching.

This preserves the product promise at real category scale while keeping every
existing guarantee, and it does so without pretending one synchronous call — or
one longer timeout — could ever have been enough.
