// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

/**
 * The one journey test: load → choose a scope → analyze → read the brief → copy.
 *
 * Every other test in this repo checks a function. This checks that the WIRED
 * APPLICATION still works, which is a different question and the one that kept
 * being answered by hand. Two defects found during development were invisible to
 * unit tests and are pinned here:
 *
 *   - the recommendations section rendering empty while faults existed,
 *   - an empty findings column implying "no complaints" rather than "this
 *     engine cannot detect them".
 *
 * Both are properties of the RENDERED OUTPUT, which no unit test asserts. Each
 * was confirmed by reintroducing the bug and watching this file fail.
 *
 * A third defect — a helper that mangled acronym-leading theme labels — is NOT
 * covered here, and the break-check proved it: this journey stayed green with
 * the bug reintroduced, because heuristic labels come from a fixed vocabulary
 * whose entries all start with an ordinary word. Only a model invents a label
 * like "USB port not working", so that case lives in App.journey.claude.test.tsx.
 *
 * SCOPE, stated honestly: this drives the real component tree in jsdom, not a
 * real browser. It covers wiring, state, rendering and the copied report. It
 * does NOT cover CSS, layout, or a real network — the dataset fetch is stubbed.
 * A browser-driven test (Playwright) would add those; this one runs inside the
 * existing CI in seconds with no browser download, which is why it comes first.
 *
 * Assertions read `article.textContent` rather than querying for single
 * elements. The same phrase legitimately appears in the data-source banner, the
 * summary and a column, and a brittle "expected exactly one match" failure
 * would say nothing about whether the application works.
 */

vi.setConfig({ testTimeout: 20_000 });

// Amazon-shaped, so a run exercises the adapter, product records, the undated
// path and top-level grouping — the widest path through the app. Two products
// in one category, one in another, and a low-rated row so faults are non-empty.
const CSV = [
  "product_id,product_name,category,discounted_price,actual_price,discount_percentage,rating,rating_count,review_content",
  'AAA1,Alpha USB-C Hub,Computers&Accessories|Accessories|USBHubs,"₹1,099","₹1,499",27%,4.5,120,"The USB port is solid and the build quality feels great."',
  'AAA2,Beta Charging Cable,Computers&Accessories|Accessories|Cables,"₹299","₹499",40%,4.2,90,"Charging is fast and the build quality is excellent."',
  'BBB1,Gamma Desk Lamp,Home&Kitchen|HomeDecor|Lighting,"₹899","₹1,299",30%,1.8,45,"The switch stopped working after a week and it feels flimsy."',
].join("\n");

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("amazon-products.csv")
        ? new Response(CSV, { status: 200, headers: { "content-type": "text/csv" } })
        : new Response("not found", { status: 404 }),
    ),
  );
});

afterEach(() => {
  // Not automatic here: auto-cleanup only runs with vitest globals enabled, and
  // this suite imports its helpers explicitly. Without it every render stacks on
  // the last and each query reports "multiple elements".
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The rendered brief, or a clear failure if the analysis produced none. */
function brief(): HTMLElement {
  const article = document.querySelector("article");
  if (!article) throw new Error("no brief rendered");
  return article as HTMLElement;
}

/** Wait for the dataset to load and the product picker to be populated. */
async function loaded(): Promise<HTMLSelectElement> {
  return waitFor(() => {
    const select = screen.getByLabelText(/^product$/i) as HTMLSelectElement;
    expect(select.options.length).toBeGreaterThan(0);
    return select;
  });
}

/** Run the analysis and wait for the brief. The heuristic engine adds ~700ms. */
async function runAnalysis(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: /run analysis/i }));
  await waitFor(() => expect(document.querySelector("article")).not.toBeNull());
}

describe("journey — product scope", () => {
  it("renders a brief whose claim is backed by a quote from the source text", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(await loaded(), "BBB1"); // 1.8★ — has faults
    await runAnalysis(user);

    const text = brief().textContent ?? "";
    // The unit noun follows the data: product records, never "reviews".
    expect(text).toMatch(/product record/i);
    expect(text).not.toMatch(/\b\d+ reviews\b/);
    // Every finding carries a quote lifted verbatim from the row.
    expect(text).toContain("stopped working after a week");
    expect(CSV).toContain("stopped working after a week");
  });

  it("copies a report carrying the same claims that are on screen", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(await loaded(), "BBB1");
    await runAnalysis(user);
    await user.click(screen.getByRole("button", { name: /copy report/i }));

    // user-event installs its own clipboard, so read back through it rather
    // than stubbing over it — this exercises the real copy path.
    const copied = await waitFor(async () => {
      const t = await navigator.clipboard.readText();
      expect(t).not.toBe("");
      return t;
    });

    expect(copied).toContain("# ReviewIQ Report:");
    expect(copied).toContain("**Scope:** Product");
    expect(copied).toContain("Averaged product rating");
    expect(copied).toContain("stopped working after a week");
  });
});

describe("journey — category scope", () => {
  it("aggregates across the products in a category and says so", async () => {
    const user = userEvent.setup();
    render(<App />);
    await loaded();

    await user.click(screen.getByRole("radio", { name: /a category/i }));
    const categories = screen.getByLabelText(/^category$/i) as HTMLSelectElement;

    // Grouping is on the TOP level, so the leaves are never offered as keys.
    const options = [...categories.options].map((o) => o.value);
    expect(options).toContain("Computers&Accessories");
    expect(options).toContain("Home&Kitchen");
    expect(options).not.toContain("USBHubs");
    expect(options).not.toContain("Cables");

    await user.selectOptions(categories, "Computers&Accessories");
    await runAnalysis(user);

    const text = brief().textContent ?? "";
    expect(text).toMatch(/Category ·/);
    expect(text).toMatch(/2 product records/);
    expect(text).toMatch(/shares of the category, not of any one product/i);
  });
});

describe("journey — the honesty guarantees survive the wiring", () => {
  // Bug 3. The heuristic engine reads an averaged rating, so it cannot see a
  // complaint in a 4.5★ record. An empty column must say which of the two it is.
  it("explains an empty column instead of implying a clean bill of health", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(await loaded(), "AAA1"); // 4.5★ — no faults possible
    await runAnalysis(user);

    expect(brief().textContent).toMatch(/limit of the engine, not as evidence/i);
  });

  // A cheap backstop, not a proof: no heuristic label starts with an acronym,
  // so this cannot catch the casing bug — see App.journey.claude.test.tsx for
  // the test that does. It guards against a mangled label reaching the shipped
  // configuration by some other route.
  it("renders no mangled acronym in the shipped configuration", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(await loaded(), "AAA1");
    await runAnalysis(user);

    expect(brief().textContent).not.toMatch(/\buSB\b|\bhDMI\b|\btV\b|\blED\b|\bgaN\b/);
  });

  // Recommendations rendering empty while faults exist. The Claude engine had
  // exactly this bug; this pins the heuristic path, and the Claude journey pins
  // the path where it actually occurred.
  it("offers an action whenever a fault was found", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(await loaded(), "BBB1"); // has faults
    await runAnalysis(user);

    const text = brief().textContent ?? "";
    expect(text).toMatch(/recommended actions/i);
    expect(text).not.toMatch(/No actions recommended/i);
  });
});
