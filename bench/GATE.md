# Acceptance gate — category-scale Claude analysis

Run on 2026-08-03 against the real endpoints and the real Anthropic API, before
activating the batched pipeline. Harness: `scripts/acceptance-gate.gate.ts`,
run with `vitest.gate.config.ts`. It is deliberately excluded from `npm test` —
the file is named `*.gate.ts` so vitest's default include cannot match it, and
the config that runs it must be passed explicitly.

## What was verified

Every number the report displays was recomputed **independently**, by
`scripts/independentRecompute.ts`, which imports nothing from `tagsToResult.ts`
or `analysisEngine.ts`. It restates the rules — distinct-review counting, the
percentage denominator, the evidence threshold, the ordering, and the quote
rule — rather than importing them, so the comparison checks the aggregator
instead of asking it to check itself.

**126 findings compared across 62 rows. Zero mismatches** in label, order,
mentions, percentage, or quote.

Also asserted per run: every selected row analyzed exactly once; every quote
verbatim in its own source row; the canonical mapping total, closed, and
single-valued (no raw label mapping two ways, no canonical label that was never
submitted); one recommendation per fault.

## Results

| Run | Rows | Unit | Batches | Raw → canonical labels | Findings | Time | Cost |
|---|---|---|---|---|---|---|---|
| synthetic:Audio | 11 | review | 6 | 15 → 12 | 4 praise, 1 fault | 5.5 s | $0.0586 |
| synthetic:Outdoor | 10 | review | 5 | 17 → 9 | 4 praise, 2 faults | 5.5 s | $0.0543 |
| synthetic:Kitchen | 10 | review | 5 | 16 → 11 | 4 praise, 1 fault | 8.0 s | $0.0595 |
| amazon:OfficeProducts | 31 | product record | 14 | 169 → 93 | 58 praise, 52 faults | 48.9 s | $0.5153 |

34 requests total (30 tagging, 4 grouping), all HTTP 200, zero retries.
30,668 input and 21,381 output tokens.

**Spend: $0.6879 measured this attempt, $1.1879 cumulative** including a
conservative $0.50 charged for the first attempt (see below). Hard ceiling
$2.00, enforced continuously and never reached.

### The synthetic dataset is 31 rows across three categories

`bench/DECISION.md` records 25 rows because that was the dataset on 2026-08-02;
it has since grown to 31. This does not weaken that benchmark's conclusion — 31
rows sits further past the single-request wall, not closer.

The dataset spans three top categories (Audio 11, Outdoor 10, Kitchen 10) and
the app has no scope that spans categories, by design. So "the complete dataset"
is three category analyses. Their selections were asserted to be an exact
partition of all 31 records **before** anything was billed.

## What the gate demonstrated

Canonicalization is not cosmetic. In the Audio run, three separately-worded
labels for one complaint —

    "Bluetooth connection drops", "bluetooth connection dropouts",
    "connection stability"

— each had exactly **one** supporting review. At the evidence threshold of 2,
all three would have been dropped and the complaint would have vanished with
nothing on screen to say so. Merged, they form a real finding: **3 of 11
reviews, 27%**, verified by hand from the raw tags as well as by the two
computations.

On the Amazon category the effect is larger: 45 of 93 canonical labels absorbed
more than one raw label, e.g. `"value for money"` ← `"worth the money"`,
`"value for price"`, `"price/value"`.

## The first attempt, and a known non-determinism

An earlier attempt on the same OfficeProducts selection **failed at
canonicalization** after tagging completed. The pipeline behaved correctly —
it refused to report on unreconciled labels and produced no partial result —
but the harness had suppressed the endpoint logs, so the controlled code was
lost and the cause could not be established without paying again.

The second attempt on the identical selection succeeded, with 169 labels (well
inside the 300-label request limit) and a maximum label length of 40 characters
(limit 120). **The same selection therefore failed once and passed once**, which
means grouping has a real, non-zero failure rate that these two runs do not
measure. It is a controlled, visible failure, not a silent one — but it is not
yet characterised. That is an open item, not a solved one.

The harness now records every endpoint log entry and every request/response
pair after each request, so a recurrence reports its endpoint code,
`groupingProblem`, label count, label-length distribution, request shape, token
usage, and cumulative spend without a second paid run.

Because those token counts were lost, the first attempt is charged at a
deliberately over-estimated **$0.50** against the cumulative ceiling — erring
high is the only safe direction for a prior that cannot be verified.

## Reproducing

    node --env-file=.env.local ./node_modules/vitest/vitest.mjs run --config vitest.gate.config.ts

Costs real money. Requires `ANTHROPIC_API_KEY`; the harness sets
`CLAUDE_ENABLED=true` itself, since both endpoints are fail-closed.

Per-run artifacts (tags, mapping, both computations, telemetry) are written to
`bench/gate/` and are gitignored: they are regenerable, bulky, and duplicate
review text already in the repo.
