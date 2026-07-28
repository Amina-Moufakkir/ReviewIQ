# ReviewIQ

**Live demo (GitHub Pages, heuristic) → https://amina-moufakkir.github.io/ReviewIQ/**

**Vercel (same-origin app + `/api`) → https://reviewiq-six.vercel.app/**

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

ReviewIQ has **two analysis engines** behind a single async boundary,
`analyzeReviews()` in `src/services/analyzeReviews.ts`. The UI and the
`AnalysisResult` contract are identical no matter which engine runs — only
the engine that produces the tags changes. Selection is by configuration
(`VITE_ANALYSIS_ENGINE`), not a user-facing toggle.

No backend, database, or accounts are required for either engine's data: reviews
come from the built-in sample or a CSV you provide, and are parsed entirely in
the browser.

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

Each finding's percentage is that theme's supporting reviews as a share of the
reviews in the selected product and window ("N of M selected reviews · P%").
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
- **Vercel** — https://reviewiq-six.vercel.app/ — the frontend and the `/api/analyze`
  function on one origin. The engine is env-controlled: it runs the heuristic engine
  by default and switches to the Claude engine when `VITE_ANALYSIS_ENGINE=claude` +
  `ANTHROPIC_API_KEY` are set. *(Currently deployed in heuristic mode.)*

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

✅ Core MVP complete — CSV upload + a deterministic heuristic engine, plus an
optional Claude-powered semantic-tagging engine behind the same
`analyzeReviews()` boundary (server-side key, controlled errors, identical UI
and `AnalysisResult`). Engine chosen by `VITE_ANALYSIS_ENGINE`.
