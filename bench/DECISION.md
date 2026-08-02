# Benchmark decision record

What the local model benchmark measured, what it decided, and what it left open.
Raw timestamped runs live in `bench/results/` and are gitignored — regenerate
them with `scripts/bench-models.ts` rather than reading a stale file.

Everything here was measured on **2026-08-02**. Model ids were verified against
`GET /v1/models` and prices against the published pricing page on the same day;
neither was taken from memory.

## How it was measured

The harness imports the endpoint's real prompt and generation parameters from
`api/claudePrompt.ts` and scores with the endpoint's own `validateTags`, so it
cannot drift from what production sends. It refuses any fixture `/api/analyze`
would reject. No model grades another model — every metric is computed in
TypeScript, the same standard the product holds itself to.

Fixtures: `bench/fixtures/mixed-sentiment.json` (12 authored reviews, 8 mixed
plus 4 single-polarity controls) and `bench/fixtures/clusters.json` (16 reviews,
4 concepts, 4 non-overlapping paraphrases each). Real-shape fixtures are built at
run time from whichever CSV is passed and are never committed.

## Decision 1 — model: `claude-opus-4-8` (settled)

| | opus-4-8 | haiku-4-5 |
| --- | --- | --- |
| Evidence-span validity | 100% | 100% |
| Mixed-sentiment pair recall | 63% | 58% |
| Misattributed / control violations | 0 / 0 | 0 / 0 |
| Cluster true-merge | **100%** | 88% |
| Cluster false-merge | 0% | 0% |
| Distinct themes (ground truth 4) | **4.0** | 5.3 |
| Run-to-run theme stability | **79% / 100%** | 23% / 28% |
| Cost per run (fixture A) | $0.0428 | $0.0065 |

Grounding ties at 100% — both models honour the product's core claim, so it is
not a differentiator. Mixed sentiment is near-tied. Opus wins clustering and wins
run-to-run stability by a wide margin, and stability is what a viewer notices:
at 23–28% overlap the same input yields largely different themes on each click.

Haiku is ~6.6x cheaper per request, wider than the 5x rate ratio because Claude
4.7-and-later use a newer tokenizer — the same fixture measured 53,913 input
tokens on Opus against 39,042 on Haiku. That cost argument was priced off
100-row requests, which turn out not to complete on either model (below), so the
expensive scenario does not exist. At the sizes that do run, Opus costs cents.

Recorded honestly: the pre-registered rule said "take the cheaper unless the
pricier wins mixed-recall or false-merge by >=10 points," and by that letter it
pointed at Haiku. The rule omitted stability, which it listed as a metric. The
omission was a defect in the rule, not a reason to reinterpret it after the fact.

## Decision 2 — request cap: OPEN

`MAX_REVIEWS_PER_REQUEST` is 100. Nothing near it completes.

| dataset | rows | review text | outcome |
| --- | --- | --- | --- |
| real Amazon | 100 | 154,044 B | timeout 30s, 2/2 (both models) |
| real Amazon | 20 | 19,604 B | timeout 30s, 2/2 |
| real Amazon | 10 | 12,129 B | timeout 30s, 2/2 |
| real Amazon | 5 | 4,851 B | **pass**, 18.7s / 20.6s |
| synthetic demo | 25 | 2,814 B | timeout 30s, 2/2 |

The synthetic demo dataset is the important row: 25 rows and only 2,814 bytes of
text — 8.7x lighter per row than the real one — and it still times out. So the
constraint is **not input size**. Timed-out runs streamed 7,000–8,000 characters
before the wall with time-to-first-token around 1s, meaning the model was
generating steadily throughout and simply had more to emit.

The binding constraint is **output volume against streaming throughput**:

- measured throughput, consistent across every run: **~110 output tok/s**
- a 30s window therefore admits **~3,300 output tokens**
- tags cost ~61 tokens each, and dense records yield ~6.6 tags per row
- so 30s buys roughly **50 tags ≈ 5–8 rows**, depending on how much each row
  has to say — not on how long it is

Five rows is the only value validated by measurement, and at 20.6s worst case it
has little headroom against a 22s target. A cap that small changes what the
Claude engine is: not a bulk analysis path, but a demonstration over a handful of
records. That is a product decision, not a tuning constant, so it is left open
rather than chosen here.

Options identified, none yet measured:

- accept a cap around 5 and reframe the Claude engine accordingly
- Opus 4.8 fast mode (`speed: "fast"`, up to 2.5x output throughput, $10/$50 per
  MTok, Claude API only) — attacks the binding constraint directly
- raise `CLAUDE_TIMEOUT_MS` toward the 60s `maxDuration`, at the cost of a slow
  demo
- re-open the model choice on throughput rather than quality grounds

## Spend

Model comparison $1.8201 nominal; cap sweeps $0.5510 and $0.3949 nominal. These
figures deliberately **overstate** real billing: a timed-out stream bills for
what it generated and the harness cannot read that back, so timeouts are charged
at a conservative ceiling. Completed-request spend across the model comparison
was $0.2429. The Console holds the true totals.

The harness enforces its ceiling by a provable bound — it halts at
`ceiling - worst-case-single-request`, so the total cannot exceed the ceiling.
The worst-case figure is derived from streaming throughput within the timeout
window, not from `MAX_OUTPUT_TOKENS`, because a 30s request cannot physically
emit 16,000 tokens.
