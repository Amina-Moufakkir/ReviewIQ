# ReviewIQ

**Live demo → https://amina-moufakkir.github.io/ReviewIQ/**

ReviewIQ helps E-commerce Analysts quickly understand customer feedback by turning product reviews into a concise, evidence-backed sentiment brief.

## Problem

Customer insights are buried in thousands of reviews. Analysts spend hours reading and summarizing feedback before they can answer business questions.

## MVP

The core MVP is complete. An analyst can:

- Use the built-in sample, **upload a CSV**, or load the bundled 204-review sample
- Select a product
- Select a date range
- Run the analysis
- View a structured brief: overall summary, what customers praise, what they
  fault, recurring themes, and recommended actions
- See a **discounts & promotions** breakdown when the data supports it —
  how promoted purchases compare with full-price ones on average rating

Every insight — findings, mention counts, percentages, representative quotes,
and the summary — is derived only from the reviews inside the selected product
and date range.

## CSV upload

Upload a CSV of reviews and ReviewIQ analyzes it in place — no backend. Required
columns: `review_id`, `product_id`, `product_name`, `category`, `review_date`
(`YYYY-MM-DD`), `rating` (1–5), `review_text`. Optional: `review_title`,
`verified_purchase`, `country`, `promotion`, `discount_percent`. See [`public/sample-reviews.csv`](public/sample-reviews.csv)
for the exact format. Rows with a **strictly-invalid calendar date** (e.g.
`2026-02-30`, `2026-13-01`), an out-of-range rating, or a duplicate id are
skipped and counted; the date range auto-fits the uploaded data. Everything is
parsed in the browser — no reviews are uploaded to a server.

## How the analysis works

- No backend, database, or accounts. Data comes from the built-in sample or a CSV
  you provide, and is parsed entirely in the browser.
- The current analysis is a **deterministic, heuristic, rating-assisted engine —
  not a natural-language sentiment model and not a live AI model.** A pure engine
  (`src/services/analysisEngine.ts`) filters reviews by product and date, then:
  - **detects themes** by deterministic keyword matching against a shared,
    product-agnostic vocabulary (`src/services/themeLibrary.ts`). Matching is
    **whole-word for single tokens and bounded-phrase for multi-word keywords**
    (`src/lib/matchKeyword.ts`), so `cleaner teeth` does not trigger `Cleaning`
    and `hard to build` does not trigger `Build quality`;
  - **decides sentiment from the star rating** — a mention in a review rated ≥ 4
    is praise, ≤ 2 is a fault, and 3 is neutral;
  - only surfaces a theme once at least a **minimum number of same-polarity
    reviews** support it, and always attaches a real supporting quote — sentiment
    is never asserted from the rating alone.
- Each finding's percentage is **that theme's supporting reviews as a share of
  the reviews in the selected product and window** (shown as "N of M selected
  reviews · P%") — not a share of all customers, all mentions, or overall
  sentiment.
- **Discounts & promotions** (`src/services/promotionAnalysis.ts`) is a separate,
  additive step over the same matched reviews. A review counts as a *promoted
  purchase* when it has a non-empty `promotion` label or a positive
  `discount_percent`; the section compares promoted vs full-price purchases on
  average rating. It appears **only when the matched reviews carry promotion
  data** — datasets without it (including the bundled CSV) simply omit the
  section, so nothing breaks.
- The same input always produces the same output, which keeps it easy to test.
- Summaries are generated from the review data by this engine — they are
  **not** AI-generated.

### Two engines behind one boundary

The UI talks to the analysis through a single async boundary,
`analyzeReviews()` in `src/services/analyzeReviews.ts`. There are now **two**
engines behind it, selected by build-time config (`VITE_ANALYSIS_ENGINE`), with
no UI toggle:

- **`heuristic`** (default) — the deterministic engine described above.
- **`claude`** — a Claude-powered **semantic tagging** engine (see below).

Both return the same `AnalysisResult`, so the entire UI is unchanged. See
[Claude engine & Vercel deployment](#claude-engine--vercel-deployment).

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
(not a report generator). For the filtered reviews (selected product + date
range) it identifies specific themes from the language, clusters equivalent
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

### How the two deployments coexist

- **GitHub Pages** — the existing deploy, **heuristic-only** demo. It never sets
  `VITE_ANALYSIS_ENGINE`, so it ships the heuristic engine and never calls
  `/api/analyze`. Unaffected by any of the above.
- **Vercel** — the **full app** with the Claude engine (`VITE_ANALYSIS_ENGINE=claude`
  + `ANTHROPIC_API_KEY`), frontend and function on one origin.

## Tech

React · TypeScript · Vite · Tailwind CSS · Vitest · Vercel Functions · Claude API

## Scripts

```bash
npm run dev        # start the dev server
npm run typecheck  # tsc
npm run lint       # eslint
npm test           # vitest (engine, keyword matching, date validation, CSV parsing)
npm run build      # production build
```

## Status

✅ Core MVP complete — CSV upload + deterministic, heuristic analysis over
sample or uploaded data.
