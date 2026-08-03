// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The heuristic path is unchanged by the run lifecycle, and that is the point.
 *
 * It is pure, synchronous and in-browser: there is no request to abort and no
 * stage to report. So it must never be asked to confirm a cost it does not
 * incur, never offered a Cancel button that could not stop anything, and never
 * shown a row counter it has no way to advance. Offering any of those to make
 * the two engines "look the same" would be describing work that is not
 * happening.
 */
vi.mock("./config", () => ({
  ANALYSIS_ENGINE: "heuristic",
  RUN_ENVIRONMENT: "protected-demo",
  resolveRunEnvironment: (value: unknown) => (value === "local" ? "local" : "protected-demo"),
}));

const { default: App } = await import("./App");

vi.setConfig({ testTimeout: 20_000 });

function csv(rowCount: number): string {
  const header =
    "product_id,product_name,category,discounted_price,actual_price,discount_percentage,rating,rating_count,review_content";
  const text = (
    "The build quality is poor and the cable frayed near the connector after a fortnight of use. " +
    "It also runs hot enough to be uncomfortable to hold for long, and the light is hard to see. "
  ).repeat(5);
  const rows = Array.from(
    { length: rowCount },
    (_, i) =>
      `P${i},Widget ${i},Computers&Accessories|Accessories|Hubs,"₹1,099","₹1,499",27%,4.5,120,"${text}"`,
  );
  return [header, ...rows].join("\n");
}

function stubFetch(rowCount: number) {
  const fn = vi.fn(async (url: string) => {
    if (String(url).includes("amazon-products.csv")) {
      return new Response(csv(rowCount), { status: 200, headers: { "content-type": "text/csv" } });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function analyzeWholeCategory(rowCount: number) {
  const fetchMock = stubFetch(rowCount);
  const user = userEvent.setup();
  render(<App />);
  await waitFor(() => {
    const select = screen.getByLabelText(/^product$/i) as HTMLSelectElement;
    expect(select.options.length).toBeGreaterThan(0);
  });
  await user.click(screen.getByRole("radio", { name: /a category/i }));
  await user.click(document.querySelector('button[type="submit"]') as HTMLButtonElement);
  return { user, fetchMock };
}

describe("the heuristic engine keeps its old, simpler flow", () => {
  it("never asks to confirm, whatever the selection size", async () => {
    // The same 40-record category the Claude path stops to ask about. Nothing
    // is being spent here, so there is nothing to approve.
    await analyzeWholeCategory(40);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /start analysis/i })).toBeNull();
  });

  it("shows a plain working message rather than a fabricated row counter", async () => {
    await analyzeWholeCategory(40);

    await waitFor(() => expect(screen.getByText(/In progress/i)).toBeTruthy());
    expect(screen.getByText(/Analyzing selected product records…/i)).toBeTruthy();
    // No counter and no bar: this engine reports no rows, and inventing them
    // would be a progress story the work does not have.
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("offers no Cancel action, because there is nothing to cancel", async () => {
    await analyzeWholeCategory(40);
    await waitFor(() => expect(screen.getByText(/In progress/i)).toBeTruthy());

    expect(screen.queryByRole("button", { name: /cancel analysis/i })).toBeNull();
  });

  it("still reaches a report, with Copy available only once it exists", async () => {
    await analyzeWholeCategory(40);
    expect(screen.queryByRole("button", { name: /copy report/i })).toBeNull();

    await waitFor(() => expect(document.querySelector("article")).not.toBeNull(), {
      timeout: 15_000,
    });
    expect(screen.getByRole("button", { name: /copy report/i })).toBeTruthy();
    expect(screen.queryByText(/In progress/i)).toBeNull();
  });

  it("sends nothing to either analysis endpoint", async () => {
    const { fetchMock } = await analyzeWholeCategory(40);
    await waitFor(() => expect(document.querySelector("article")).not.toBeNull(), {
      timeout: 15_000,
    });

    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toMatch(/\/api\//);
    }
  });

  it("names no machinery in its progress copy", async () => {
    await analyzeWholeCategory(40);
    await waitFor(() => expect(screen.getByText(/In progress/i)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toMatch(
      /\bbatch|\bchunk|hierarch|retry|endpoint|run id|runid|\/api\//i,
    );
  });
});
