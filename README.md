# ReviewIQ

**Live demo → https://amina-moufakkir.github.io/ReviewIQ/**

ReviewIQ helps E-commerce Analysts quickly understand customer feedback by turning product reviews into a concise, evidence-backed sentiment brief.

## Problem

Customer insights are buried in thousands of reviews. Analysts spend hours reading and summarizing feedback before they can answer business questions.

## MVP

The core MVP is complete. An analyst can:

- Select a product
- Select a date range
- Run the analysis
- View a structured brief: overall summary, what customers praise, what they
  fault, recurring themes, and recommended actions

Every insight — findings, mention counts, percentages, representative quotes,
and the summary — is derived only from the reviews inside the selected product
and date range.

## How the analysis works

- The app ships with **sample review data** (`src/data/`) — no backend, database,
  or accounts.
- The current analysis is **deterministic, not a live AI model**. A pure engine
  (`src/services/analysisEngine.ts`) filters reviews by product and date, then
  aggregates evidence into findings. The same input always produces the same
  output, which keeps it easy to test.
- Summaries are generated from the review data by this deterministic engine —
  they are **not** AI-generated.

### Prepared for a future model

The UI talks to the analysis through a single async boundary,
`analyzeReviews()` in `src/services/analyzeReviews.ts`. Swapping the
deterministic engine for a real model (e.g. the Claude API) means changing only
that function — the `AnalysisResult` contract and the entire UI stay the same.

## Sample dataset (for CSV-upload development)

A larger synthetic dataset lives at [`public/sample-reviews.csv`](public/sample-reviews.csv)
(204 reviews across 6 products and 5 categories). It exists to test the next
version of ReviewIQ — including planned CSV-upload support — with far more
variety than the small built-in sample.

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

It is deliberately designed to exercise product/date filtering, recurring
themes, evidence-backed findings, representative quotes, uneven review volume,
and small vs. large result sets. It also embeds intentional patterns — a
product whose sentiment improves over time, one that worsens, and a temporary
complaint spike in a specific date range.

> **This is synthetic sample data, not real customer reviews.** It is intended
> only for product testing and CSV-upload development, and must not be presented
> as, or mistaken for, genuine customer data.

## Tech

React · TypeScript · Vite · Tailwind CSS · Vitest

## Scripts

```bash
npm run dev        # start the dev server
npm run typecheck  # tsc
npm run lint       # eslint
npm test           # vitest (analysis engine)
npm run build      # production build
```

## Status

✅ Core MVP complete — deterministic analysis over sample data.
