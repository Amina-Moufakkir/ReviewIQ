# ReviewIQ Specification

## Vision

Help analysts answer customer feedback questions in seconds instead of hours.

## Problem

E-commerce Analysts struggle to quickly answer business questions about customer
feedback because valuable insights are buried in large volumes of unstructured
review text. They spend hours manually reading reviews instead of providing
timely recommendations that help the business make decisions.

## Solution

The analyst receives a clear summary of the most common complaints and positive
themes, so they spend less time reading reviews and more time making
recommendations to the business. The product removes the reading; the analyst
still makes the call.

## User

Primary:

- E-commerce Analyst

## MVP

User selects:

- Product
- Date range — only for data that carries per-review dates. Datasets without a
  date field (see Data sources) hide the control rather than show an empty or
  invented window.

User clicks Analyze. System returns:

- Short summary
- Top complaints
- Top positive themes
- Recommended actions
- Discounts & promotions — only when the selected data carries promotion or
  discount fields. Omitted entirely otherwise.

Recommended actions are investigation prompts derived from the complaints that
were found — "Investigate X — raised in N of M reviews" — ordered by how much
evidence supports each. They are a starting point, not the recommendation
itself: the analyst still decides what to tell the business.

The analyst can copy the whole result as a Markdown report to the clipboard.

## How findings are produced

Two engines sit behind one boundary (`analyzeReviews()`), selected by build
configuration rather than a user control. Both return the identical result
shape, so the UI does not change between them.

- **Heuristic engine** — deterministic keyword matching for themes, with
  praise/fault inferred from the star rating. Free, offline, reproducible; this
  is what the static demo deployment runs. Its limit is structural: polarity
  comes from the review's rating and applies to every theme that review
  mentions, so one review is all praise or all fault. A review that likes one
  aspect and dislikes another is misfiled, which is a real if modest error rate
  on per-review data and a total failure on product-average data, where one
  rating stands for thousands of customers.
- **Claude engine** — reads the review text and assigns sentiment per theme
  mention, so one review can yield praise for one theme and a fault for another.
  That is the case the rating-based engine cannot represent. Required for data
  whose rating is a product average over many customers, where a rating-based
  engine cannot see a complaint written inside a highly-rated record. Calls a
  server function that holds the API key **in local development only** — the
  deployed function is keyless by decision and answers
  `500 server_misconfigured`.

The Claude engine is currently verified locally only and is not enabled on the
live deployment. The UI states which engine produced a given result, and an
empty findings column says whether nothing was found or the engine could not
look.

## Evidence rules

These hold for both engines and are the product's core claim:

- Every finding carries a quote that is a verbatim substring of a real review,
  with attribution. A finding with no supporting quote is not shown.
- Counts, percentages, ordering and thresholds are computed in TypeScript. No
  number a model produced is ever displayed.
- A theme becomes a finding only when enough same-polarity rows support it.
- No date, rating, review, or theme is invented to fill a gap.

## Data sources

Rows are parsed in the browser. No database, no accounts.

- Built-in sample — per-review, dated, carries promotion fields.
- Bundled sample CSV — per-review, dated.
- Uploaded CSV — accepted in two shapes, routed by header: canonical ReviewIQ
  review columns, or Amazon product-export columns.
- Amazon product dataset — one row is a product listing, not one customer: it
  carries a product-average rating and several customers' reviews in one cell,
  and no dates. Counts over it are counts of records, not people, and the UI
  says so. The real dataset is local-only; deployments fall back to a committed
  synthetic stand-in that is labelled as synthetic.

## Out of Scope

- Dashboards
- Charts
- Notifications
- File downloads, CSV export, scheduled or emailed reports (copying a Markdown
  report to the clipboard is in scope; producing files is not)
- Authentication and user accounts
- Historical analytics — no analysis is stored or compared across runs

## Success

An analyst can answer "What are customers complaining about for Product X?" —
scoped to a date window where the data supports one — in seconds, with a quote
from a real review backing every claim.
