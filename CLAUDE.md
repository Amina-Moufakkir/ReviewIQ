# CLAUDE.md

## Project Goal

Build the smallest possible MVP that proves AI can summarize customer reviews into actionable insights.

## Principles

- MVP first.
- Do not add features outside the specification.
- Simplicity beats cleverness.
- Prefer hardcoded sample data over infrastructure until the core workflow is proven.
- Every feature must directly support the MVP.

## Code

- React
- TypeScript
- Vite
- Tailwind

## Current MVP

User:

1. Selects a scope — one product, or one whole category. Categories group on the
   top-level category value, the same rule for a pipe hierarchy and a flat one.
   Scope widens which rows are analyzed; it never changes what a row is
2. Selects a date range — only when the data carries per-review dates; the
   control is hidden for undated data rather than shown empty
3. Clicks Analyze
4. Receives a structured brief: summary, top complaints, top positive themes,
   recommended actions, and a promotions panel when the data supports it

The brief is engine-neutral. Two engines produce it — a deterministic heuristic
one and a Claude-powered semantic one — and the UI states which one ran, so
"AI summary" is wrong for the heuristic path, which uses no model.

## Don't Build Yet

- Authentication
- Database
- User accounts
- Dashboards
- Charts
- Cross-category ranking — comparing categories to say which has the most
  complaints. Category-level *theme* analysis is built; ranking is not.
- Notifications
- File export — downloads, DOCX, CSV. (Copying the report as Markdown to the
  clipboard is IN scope and already shipped; see SPEC.md "Out of Scope".)
- Analytics
