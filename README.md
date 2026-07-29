# ReviewIQ

**Live demo (GitHub Pages, heuristic) → https://amina-moufakkir.github.io/ReviewIQ/**

**Vercel (same-origin app + `/api`) → https://reviewiq-six.vercel.app/**

> The public demo uses a small **synthetic Amazon-style dataset**, so the full
> integration can be explored without redistributing the original data. Local
> developers can download the real dataset and run `npm run build:amazon` to
> replace it. See [Getting the dataset](#getting-the-dataset).

ReviewIQ helps E-commerce Analysts quickly understand customer feedback by turning product reviews into a concise, evidence-backed sentiment brief.

## Problem

Customer insights are buried in thousands of reviews. Analysts spend hours reading and summarizing feedback before they can answer business questions.

## MVP

The core MVP is complete. An analyst can:

- Use the **real Amazon product dataset** (the default), the built-in sample,
  **upload a CSV**, or load the bundled 204-review sample
- Select a product
- Select a date range (for datasets that carry review dates)
- Run the analysis
- View a structured brief: overall summary, what customers praise, what they
  fault, recurring themes, and recommended actions
- See a **discounts & promotions** breakdown when the data supports it —
  how promoted purchases compare with full-price ones on average rating

Every insight — findings, mention counts, percentages, representative quotes,
and the summary — is derived only from the rows inside the selected product
and, where the data carries review dates, the selected date range. The Amazon
dataset has no dates, so a run there covers every product record for the chosen
product.

## CSV upload

Upload a CSV of reviews and ReviewIQ analyzes it in place — no backend. Required
columns: `review_id`, `product_id`, `product_name`, `category`, `rating` (1–5),
`review_text`. Optional: `review_date`, `review_title`, `verified_purchase`,
`country`, `promotion`, `discount_percent`. See [`public/sample-reviews.csv`](public/sample-reviews.csv)
for the exact format.

`review_date` is the one optional column that changes how the dataset behaves:

- **Present** — every row must hold a valid calendar date (`YYYY-MM-DD`). Rows
  with a **strictly-invalid** one (e.g. `2026-02-30`, `2026-13-01`, or a blank
  cell) are skipped and counted, and the date range auto-fits the data.
- **Absent** — the file is treated as **undated**. Every row loads with no date
  and the date window is hidden rather than shown empty; a run covers every row
  for the chosen product. This is how the Amazon dataset loads.

Rows with an out-of-range rating or a duplicate id are skipped and counted
either way. Everything is parsed in the browser — no reviews are uploaded to a
server.

## How the analysis works

ReviewIQ has **two analysis engines** behind a single async boundary,
`analyzeReviews()` in `src/services/analyzeReviews.ts`. The UI and the
`AnalysisResult` contract are identical no matter which engine runs — only
the engine that produces the tags changes. Selection is by configuration
(`VITE_ANALYSIS_ENGINE`), not a user-facing toggle.

No backend, database, or accounts are required for either engine's data: rows
come from the Amazon fixture, the built-in sample, or a CSV you provide, and are
parsed entirely in the browser.

### Engine 1 — Heuristic (default, no backend, fully static)

A deterministic, rating-assisted engine (`src/services/analysisEngine.ts`)
that runs entirely in the browser with no API calls. It:

- **detects themes** by whole-word / bounded-phrase keyword matching against a
  shared vocabulary (`src/services/themeLibrary.ts`, `src/lib/matchKeyword.ts`),
  so `cleaner teeth` does not trigger `Cleaning`;
- **decides sentiment from the star rating** — ≥ 4 is praise, ≤ 2 is a fault,
  3 is neutral;
- only surfaces a theme once a minimum number of same-polarity reviews support
  it, and always attaches a real supporting quote;
- adds a **discounts & promotions** breakdown (`src/services/promotionAnalysis.ts`)
  when the reviews carry promotion data — comparing promoted vs full-price
  purchases on average rating; datasets without it simply omit the section.

Each finding's percentage is that theme's supporting rows as a share of the rows
in the selected product and window ("N of M selected reviews · P%", or "product
records" for undated product-level data such as the Amazon dataset).
Because it needs no server, this engine powers the static **GitHub Pages demo**,
and it is deterministic — the same input always produces the same output.

### Engine 2 — Claude (semantic, server-side)

A Claude-powered engine that understands the actual language of the reviews
rather than matching a fixed keyword list. It:

- identifies themes from the reviews' own wording and clusters semantically
  equivalent phrasings under one canonical label (e.g. "died after a week",
  "won't hold a charge", "battery's useless" → one battery-life theme);
- assigns sentiment from the **review text**, per theme mention — so a 4-star
  review that contains a real complaint is correctly counted as a fault;
- returns only structured tags; **all counts, percentages, and quotes are still
  computed in TypeScript from the real reviews** — never taken from model prose.

So the summary sentence and every number are computed in code under **both**
engines; what the Claude engine changes is *how themes and per-mention sentiment
are detected* (language understanding vs. a fixed keyword list + star rating).

### Security model

The Claude call runs **server-side only**, in a Vercel serverless function at
`api/analyze.ts`. The `ANTHROPIC_API_KEY` lives only in the server environment
(a Vercel Environment Variable), is never bundled into the browser, and is never
prefixed `VITE_`. The browser sends the filtered reviews to `/api/analyze` and
receives back validated tags or a controlled error.

### Selecting an engine

Set `VITE_ANALYSIS_ENGINE` in the environment:

| Value       | Engine    | Where it runs                        |
| ----------- | --------- | ------------------------------------ |
| `heuristic` | Engine 1  | Browser only (GitHub Pages demo)     |
| `claude`    | Engine 2  | Vercel (`api/analyze.ts`) + browser  |

`VITE_ANALYSIS_ENGINE` carries only the engine name — it is **not** a secret and
contains no key. When Claude mode is selected and the call fails, the app
surfaces a controlled error; it does **not** silently fall back to the heuristic
engine.

For the Claude engine's endpoint behavior, request limits, secret configuration,
`vercel dev`, deployment, and cost, see
[Claude engine & Vercel deployment](#claude-engine--vercel-deployment) below.

## Amazon dataset (the default data source)

On load, ReviewIQ analyzes the **Amazon Sales Dataset** — approximately 1,465
real Amazon product listings. It is fetched at runtime from
`public/amazon-products.csv`, parsed by the same RFC 4180 parser and validated
by the same loader as any uploaded CSV, and adapted by
`src/lib/amazonAdapter.ts`.

> **The real dataset is not committed to this repository — you supply it
> locally.** Its license and redistribution terms have not been verified, so
> nothing derived from it is published here. See
> [Getting the dataset](#getting-the-dataset) below.

**The Amazon source resolves in this order:**

1. `public/amazon-products.csv` — the real dataset, generated locally by
   `npm run build:amazon`.
2. `public/amazon-demo.csv` — a committed, fully **synthetic** stand-in in the
   same column shape. This is what deployed builds get.

The fallback is deliberately to synthetic *Amazon-shaped* data and never to the
ordinary review sample: someone exploring the Amazon path should actually be
exercising the Amazon adapter, not a different dataset wearing its name. The
label reads "Amazon demo records (synthetic)" and the app states in place that
the records are invented, so the two can never be confused. The built-in sample
and CSV upload remain separately selectable either way.

Everything the integration does stays visible on the demo data: the adapter
runs, records are undated, the wording says *product records*, the long-title
selector shortening applies, and the parsed/accepted/skipped accounting has real
skips to show.

### What one row actually is

**One row is a product record, not a customer review.** Each row is a product
listing that carries a product-average rating and the review text of roughly
eight customers concatenated into a single cell. Everything the app reports
about this dataset therefore counts *product records*, and the UI says so —
it never labels them "reviews".

### Load accounting

| | |
| --- | --- |
| Parsed records | 1,465 |
| Accepted | 1,464 |
| Skipped | 1 (`invalid_rating` — one row whose `rating` cell is `\|`) |
| Products derived | 1,350 — from 1,351 distinct `product_id`s; the skipped row was the only one for its product |

`accepted + skipped = parsed` always holds, every skip is attributed to a
reason, and both numbers are shown in the app. No row is discarded silently.

### Mapping

| Amazon column | ReviewIQ field | Transformation |
| --- | --- | --- |
| `product_id` | `Review.productId`, `Product.id` | trimmed |
| `product_name` | `Product.name` | trimmed |
| `category` | `Product.category`, `Review.category` | `\|` hierarchy split; leaf used, full path preserved in `AmazonRecord.categoryPath` |
| `review_content` | `Review.text` | **verbatim — never split on commas** |
| `rating` | `Review.rating` + `Review.sourceRating` | rounded to an integer; source decimal preserved |
| *(none)* | `Review.date` | `""` — the dataset has no dates and none are invented |
| *(synthetic)* | `Review.id` | positional `amz-0001`… |
| `discounted_price`, `actual_price`, `discount_percentage`, `rating_count` | *(not used for analysis)* | `₹`, `,` and `%` stripped into numbers; raw strings kept in `AmazonRecord.raw` |
| `user_id`, `user_name`, `about_product`, `img_link`, `product_link`, `review_id`, `review_title` | *(dropped)* | see below |

### Analytical limitations

These are properties of the data, not bugs. They are stated in the app as well
as here, because technical compatibility is not analytical validity.

- **Rounded ratings.** Amazon ratings are product-average decimal ratings.
  ReviewIQ currently requires integer ratings (1–5). The adapter rounds the
  average rating to the nearest integer for compatibility while preserving the
  original decimal value in `Review.sourceRating`. *This is a compatibility
  transformation, not a claim that the average rating was originally an
  integer.* Rounding is not optional: the loader rejects non-integers, and so
  does the `/api/analyze` request contract, and neither may be modified.
- **Praise/fault skew.** The heuristic engine treats `rating >= 4` as praise
  evidence and `rating <= 2` as fault evidence. On this data that is 1,422
  records versus 2 — an artifact of averaging thousands of customers into one
  number, not a finding about the products. Expect a near-empty "what they
  fault" column and few recommendations from the heuristic engine. The Claude
  engine reads the text instead and does surface faults.
- **No dates.** The dataset has no date field of any kind. No date is invented,
  derived, or substituted — records are undated (`date: ""`), and the date
  window is hidden rather than shown empty or pre-filled.
- **Counts are records, not customers.** `reviewCount`, mention counts and
  percentages are shares of product records. `user_id` is a comma-joined list of
  several people and is **never** used as a row key or a customer count.
- **Quotes are drawn from bundled text.** A representative quote comes from a
  cell that concatenates several customers, so it is one person's sentence
  attributed to a record covering many. Some records also embed image URLs
  mid-text.
- **Repeated products.** 92 `product_id`s appear on more than one row, with
  differing prices, counts and text. Rows are not deduplicated; products are
  derived from the first row per id.
- **Currency is ₹ (INR).** Prices are Indian rupees; nothing in the app presents
  them as any other currency.
- **No promotion insight.** `discount_percentage` is a *listing* discount, not a
  promotion the reviewer purchased under, so it is deliberately not mapped to
  `Review.discountPercent` and the promotions panel stays hidden for this data.

### Getting the dataset

Neither the raw source nor the generated fixture is committed. Both are
gitignored and supplied locally:

| Path | What it is | Committed? |
| --- | --- | --- |
| `src/amazon.csv` | raw source, 16 columns, ~4.5 MB — **you download this** | no |
| `public/amazon-products.csv` | generated, 9 columns, ~2.3 MB — preferred at runtime | no |
| `scripts/build-amazon-csv.mjs` | the deterministic generator | **yes** |
| `public/amazon-demo.csv` | 28-row synthetic dataset — what deployed builds serve | **yes** |
| `src/test/fixtures/amazon-mini.csv` | 12-row synthetic fixture — tests only | **yes** |

The two synthetic files are invented in the same style but serve different
purposes and are edited independently: `amazon-demo.csv` supports the deployed
product, `amazon-mini.csv` supports the tests. Application code never imports
from `src/test/fixtures/` — that directory stays test-only.

Two reasons nothing derived from the dataset is published here:

1. **License.** The source is the public *Amazon Sales Dataset* (widely
   mirrored, e.g. on Kaggle). Its redistribution terms have not been verified
   for this repository, so it is not redistributed. Once the license explicitly
   permits redistribution, the generated fixture can be committed with the
   attribution its terms require — nothing else in the setup needs to change.
2. **Personal data.** The raw file's `user_id` and `user_name` columns hold
   9,269 real reviewer identities. The generator drops them (along with unused
   bulk: `about_product`, `img_link`, `product_link`, `review_id`,
   `review_title`), so the generated fixture carries no personal identifiers —
   but it is still derived from the source, so rule 1 governs it too.

To set it up:

```bash
# 1. Download the Amazon Sales Dataset CSV and save it, unmodified, as:
#      src/amazon.csv
# 2. Generate the fixture the app fetches:
npm run build:amazon        # src/amazon.csv → public/amazon-products.csv
```

The CSV is never hand-edited — re-run the script instead. It is a physical
projection only: it drops columns and copies every cell it keeps verbatim, so
all normalization and interpretation stay in the runtime adapter. The fixture is
served from `public/` and fetched at runtime, so it adds nothing to the JS bundle.

**Without the real dataset**, the app falls back to `public/amazon-demo.csv`
automatically — nothing to configure, and the built-in sample and CSV upload keep
working alongside it. Deleting `public/amazon-products.csv` is enough to see
exactly what a deployed build shows.

See [`src/test/fixtures/README.md`](src/test/fixtures/README.md) for what the
test fixture deliberately contains.

## Sample dataset (for CSV-upload development)

A larger synthetic dataset lives at [`public/sample-reviews.csv`](public/sample-reviews.csv)
(204 reviews across 6 products and 5 categories). Load it in the app with
**"Load 204-review sample"**, or upload your own CSV in the same format. It offers
far more variety than the small built-in sample.

Columns:

| Column | Description |
| --- | --- |
| `review_id` | Unique ID, e.g. `hp-0001` |
| `product_id` | Stable product key, e.g. `headphones-01` |
| `product_name` | Display name |
| `category` | Electronics, Kitchen Appliances, Wearables, Home Office, Personal Care |
| `review_date` | ISO date, `YYYY-MM-DD` |
| `rating` | Integer 1–5 |
| `review_title` | Short title |
| `review_text` | Review body |
| `verified_purchase` | `true` or `false` |
| `country` | Short code (US, UK, CA, AU, NZ, IE) |
| `promotion` | *(optional)* Promotion/discount label, e.g. `Spring Sale` |
| `discount_percent` | *(optional)* Discount applied, 0–100 |

It is deliberately designed to exercise product/date filtering, recurring
themes, evidence-backed findings, representative quotes, uneven review volume,
and small vs. large result sets. It also embeds intentional patterns — a
product whose sentiment improves over time, one that worsens, and a temporary
complaint spike in a specific date range.

> **This is synthetic sample data, not real customer reviews.** It is intended
> only for product testing and CSV-upload development, and must not be presented
> as, or mistaken for, genuine customer data.

## Claude engine & Vercel deployment

The optional **Claude engine** uses the Claude API as a *semantic tagging layer*
(not a report generator). For the filtered reviews (selected product, plus the
date range when the data has one) it identifies specific themes from the
language, clusters equivalent
descriptions under one canonical label, and assigns sentiment per theme mention
with the exact supporting text span. **All counts, percentages, thresholds, and
the summary are still computed in TypeScript** — the model judges language, code
computes evidence. Star ratings are passed only as context and never determine
sentiment.

### Architecture (same-origin, key stays server-side)

- **Server function:** [`api/analyze.ts`](api/analyze.ts) is a Vercel serverless
  function. The browser calls it at the relative, same-origin path
  **`/api/analyze`** (so there is no CORS to configure). It receives the filtered
  reviews, calls Claude, validates the response, and returns **only** the
  validated tag payload or a controlled error — never raw provider output.
- **Client engine:** [`src/services/claudeEngine.ts`](src/services/claudeEngine.ts)
  posts to `/api/analyze` and **defensively re-validates** the response before
  building an `AnalysisResult` (two gates: server and client).
- The **`ANTHROPIC_API_KEY` never reaches the browser.** It is read only via
  `process.env` inside the function, is never prefixed `VITE_`, and is never
  committed. A Claude failure surfaces through the normal error UI and **never**
  silently falls back to the heuristic engine.
- **Limits (server-enforced):** at most **100 reviews** and ~**250 KB** request
  body per request, plus a post-parse review-text budget; over-limit returns a
  controlled `413` (never truncated). Model default is `claude-opus-4-8`
  (override with `ANTHROPIC_MODEL`); the Claude call has a ~30s timeout.

### Local development (`vercel dev`)

`npm run dev` (plain Vite) does **not** serve `/api` and does not load the Vercel
environment — use it only for the heuristic engine. For anything touching the
Claude engine, use the Vercel CLI's linked-project workflow:

```bash
npm i -g vercel          # once
vercel link              # link this dir to the Vercel project (creates .vercel/, gitignored)
vercel dev               # runs the frontend + /api together, loads Dev env vars
```

To exercise the Claude engine locally, run with `VITE_ANALYSIS_ENGINE=claude`,
e.g. `VITE_ANALYSIS_ENGINE=claude vercel dev`.

**Where the key must live for `vercel dev`:** the `/api/analyze` **function**
reads `ANTHROPIC_API_KEY` from Vercel's **Development**-scoped environment
variables — set it there (`vercel env add ANTHROPIC_API_KEY development`) and
`vercel dev` injects it into the function automatically. Note that a local
`.env.local` file feeds the **frontend/build** but is **not** injected into the
function runtime; if your key only lives in `.env.local`, load it into the shell
first (`set -a; . ./.env.local; set +a; vercel dev`) or the function will return
the controlled `500 server_misconfigured`.

### Production secret configuration

In the Vercel dashboard → **Settings → Environment Variables**, add
`ANTHROPIC_API_KEY` (mark it **Sensitive**) scoped to **Production**,
**Preview**, and **Development** (Development is what `vercel dev` loads). Also
set `VITE_ANALYSIS_ENGINE=claude` for the Vercel deployment. Copy
[`.env.example`](.env.example) if you keep a local file — it lists only
`ANTHROPIC_API_KEY=` and local `.env*` files are gitignored. **After changing the
production secret, redeploy before testing.**

### Deploy to Vercel

Vercel auto-detects Vite (build `npm run build`, output `dist/`) and auto-deploys
any function under `api/`. Push the branch (or `vercel --prod`) and Vercel builds
the frontend and the function together on the same origin. On Vercel the app is
served at the domain root — `vite.config.ts` sets `base` to `/` automatically
when `VERCEL` is set (and to `/ReviewIQ/` otherwise for GitHub Pages).

### Cost / free-tier notes

Every Claude analysis is one API call over the filtered reviews; input+output
scale with review count (bounded by the 100-review cap). At the default
`claude-opus-4-8`, a large (~100-review) request is roughly on the order of a few
US cents; set `ANTHROPIC_MODEL=claude-haiku-4-5` to cut that substantially. On
Vercel's **Hobby** (free) tier, serverless functions are subject to
execution-time and monthly-invocation limits — fine for a demo, but the Claude
API itself is billed to your Anthropic account regardless of tier.

### Model choice (provisional — benchmark deferred)

The default model is **`claude-opus-4-8`**, overridable per deployment with the
`ANTHROPIC_MODEL` env var. This is a **deliberate but provisional MVP decision**,
not a benchmarked one:

- **Why Opus for now:** it was verified working end-to-end — clean canonical
  theme clustering, correct per-mention sentiment on high-star reviews with real
  complaints, and exact evidence spans. For an MVP the bar is "does it work,"
  which Opus clears.
- **Why it's low-risk to defer optimizing:** production runs the *heuristic*
  engine (no Opus cost today — Claude is opt-in), and the model is a one-line
  `ANTHROPIC_MODEL` override, so choosing a cheaper default later costs nothing
  to change. **`claude-haiku-4-5`** and **`claude-sonnet-5`** are the obvious
  cost/latency candidates.
- **When to revisit:** once the Claude engine carries real traffic, benchmark a
  fixed evaluation set across Haiku / Sonnet / Opus and judge on **canonical
  theme consistency, mixed-sentiment accuracy, evidence-span validity, latency,
  and cost** (evidence-span validity is scored deterministically by the existing
  `validateTags`). That turns the default from an assumption into a measured
  decision against a representative workload — which a small demo eval set can't
  yet stand in for.

### How the two deployments coexist

- **GitHub Pages** — the existing deploy, **heuristic-only** demo. It never sets
  `VITE_ANALYSIS_ENGINE`, so it ships the heuristic engine and never calls
  `/api/analyze`. Unaffected by any of the above.
- **Vercel** — https://reviewiq-six.vercel.app/ — the frontend and the `/api/analyze`
  function on one origin. The engine is env-controlled: it runs the heuristic engine
  by default and switches to the Claude engine when `VITE_ANALYSIS_ENGINE=claude` +
  `ANTHROPIC_API_KEY` are set. *(Currently deployed in heuristic mode.)*

## Tech

React · TypeScript · Vite · Tailwind CSS · Vitest · Vercel Functions · Claude API

## Scripts

```bash
npm run dev             # start the dev server
npm run typecheck       # tsc
npm run lint            # eslint
npm test                # vitest (engines, CSV parsing, Amazon adapter, product labels, query-bound state)
npm run build           # production build
npm run build:amazon    # regenerate public/amazon-products.csv from src/amazon.csv
```

## Status

✅ Core MVP complete — the real Amazon product dataset as the default source,
CSV upload, and a deterministic heuristic engine, plus an optional
Claude-powered semantic-tagging engine behind the same `analyzeReviews()`
boundary (server-side key, controlled errors, identical UI and
`AnalysisResult`). Engine chosen by `VITE_ANALYSIS_ENGINE`.
