// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The same journey under the CLAUDE engine, with `/api/analyze` stubbed.
 *
 * This file exists because of something the heuristic journey could not do.
 * Reintroducing the acronym-casing bug left every heuristic test green: theme
 * labels there come from a fixed vocabulary whose entries all begin with an
 * ordinary word, so no label can start with an acronym and nothing mangles.
 * Only the model invents labels like "USB port not working", so only this path
 * can catch that class of defect — and the same is true of the recommendations
 * bug, which lived in the Claude result-builder specifically.
 *
 * Verified by breaking each fix and watching this file fail, rather than by
 * assuming the assertion covers what its name says.
 *
 * The engine is chosen at module load, so it is mocked rather than configured.
 */
// The whole module is replaced, so every export this path reads must be listed:
// omitting RUN_ENVIRONMENT leaves the run ceiling undefined, which is a broken
// stub rather than a behaviour worth exercising.
vi.mock("./config", () => ({
  ANALYSIS_ENGINE: "claude",
  RUN_ENVIRONMENT: "protected-demo",
  resolveRunEnvironment: (value: unknown) => (value === "local" ? "local" : "protected-demo"),
}));

const { default: App } = await import("./App");

vi.setConfig({ testTimeout: 20_000 });

// One product record whose text carries an acronym-led complaint, so the model
// has something to name "USB port not working".
const CSV = [
  "product_id,product_name,category,discounted_price,actual_price,discount_percentage,rating,rating_count,review_content",
  'AAA1,Alpha USB-C Hub,Computers&Accessories|Accessories|USBHubs,"₹1,099","₹1,499",27%,4.5,120,"The USB port stopped working after a week."',
].join("\n");

// The adapter assigns positional ids, so the first data row is amz-0001.
// `evidence_span` must be an exact substring or both validation gates reject it.
const TAGS = {
  tags: [
    {
      review_id: "amz-0001",
      theme: "USB port not working",
      sentiment: "fault",
      evidence_span: "The USB port stopped working",
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/analyze")) {
        // Answer with only the tags for rows this request actually carried:
        // the pipeline splits a selection across several requests, and a
        // row-agnostic stub would return tags for rows a later batch never
        // received, which the client-side gate rejects as an unknown id.
        const sent = JSON.parse((init?.body as string) ?? "{}") as { reviews?: { id: string }[] };
        const ids = new Set((sent.reviews ?? []).map((r) => r.id));
        const tags = TAGS.tags.filter((t) => ids.has(t.review_id));
        return new Response(
          JSON.stringify({ tags, usage: { inputTokens: 100, outputTokens: ids.size * 40 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/api/canonicalize")) {
        // Each label stands for itself: this journey is about rendering a
        // model-authored label, not about clustering.
        const sent = JSON.parse((init?.body as string) ?? "{}") as { labels?: string[] };
        return new Response(
          JSON.stringify({ groups: (sent.labels ?? []).map((_, i) => [i]) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("amazon-products.csv")) {
        return new Response(CSV, { status: 200, headers: { "content-type": "text/csv" } });
      }
      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function analyzeFirstProduct(): Promise<string> {
  const user = userEvent.setup();
  render(<App />);
  await waitFor(() => {
    const select = screen.getByLabelText(/^product$/i) as HTMLSelectElement;
    expect(select.options.length).toBeGreaterThan(0);
  });
  await user.click(screen.getByRole("button", { name: /run analysis/i }));
  await waitFor(() => expect(document.querySelector("article")).not.toBeNull());
  return document.querySelector("article")!.textContent ?? "";
}

describe("journey — Claude engine", () => {
  it("renders a model-authored theme label without mangling its acronym", async () => {
    const text = await analyzeFirstProduct();
    expect(text).toContain("USB port not working");
    expect(text).not.toMatch(/\buSB\b/);
  });

  it("turns that fault into a recommended action, correctly cased", async () => {
    const text = await analyzeFirstProduct();
    expect(text).toMatch(/recommended actions/i);
    expect(text).toContain("Investigate USB port not working");
    expect(text).not.toMatch(/No actions recommended/i);
  });

  it("shows the quote verbatim and says the rating is context only", async () => {
    const text = await analyzeFirstProduct();
    expect(text).toContain("The USB port stopped working");
    expect(CSV).toContain("The USB port stopped working");
    expect(text).toMatch(/averaged rating above is shown as context only/i);
  });
});

describe("privacy disclosure — Claude engine", () => {
  it("tells the analyst their review text is sent to Anthropic, before they run anything", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/sent to Anthropic for analysis/i)).toBeTruthy();
    });
    expect(screen.getByText(/does not\s+permanently store/i)).toBeTruthy();
  });

  it("does not claim the analysis is deterministic or browser-only on this path", async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/sent to Anthropic for analysis/i));
    expect(screen.queryByText(/deterministic keyword analysis/i)).toBeNull();
    expect(screen.queryByText(/no review text leaves this page/i)).toBeNull();
  });
})
