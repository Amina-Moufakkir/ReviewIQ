# ReviewIQ Specification

## Vision

Help analysts answer customer feedback questions in seconds instead of hours.

## Problem

E-commerce Analysts struggle to answer business questions because valuable insights are buried in unstructured review text.

## User

Primary:

- E-commerce Analyst

## MVP

User selects:

- Product
- Date range

System returns:

- Top complaints
- Top positive themes
- Short summary
- Recommended actions

Recommended actions are investigation prompts derived from the complaints that
were found — "Investigate X — raised in N of M reviews", ordered by how much
evidence supports each one. They are a starting point for the analyst, not the
recommendation itself: the analyst still decides what to tell the business. The
product's job is to remove the hours of reading that used to come first.

Nothing in this list is written by the model. Themes and per-mention sentiment
come from the analysis engine; counts, ordering and wording are computed in
TypeScript from findings that already passed the evidence gate.

## Out of Scope

- Dashboards
- Charts
- Notifications
- Exports
- Authentication
- Historical analytics

## Success

An analyst can answer:

"What are customers complaining about for Product X this month?"

within seconds.
