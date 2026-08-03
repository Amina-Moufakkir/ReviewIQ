// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The run lifecycle as an analyst experiences it: being asked, watching, and
 * stopping.
 *
 * Every assertion here is about the UI honouring the state machine, never about
 * re-deciding anything. The dialog appears because the planner said "confirm";
 * it dispatches nothing because reaching that state IS the pipeline declining to
 * start. What is worth pinning is that the UI cannot get ahead of it — no
 * request before approval, no report during a run, no stale report under a new
 * one.
 *
 * The engine is chosen at module load, so it is mocked rather than configured.
 */
vi.mock("./config", () => ({
  ANALYSIS_ENGINE: "claude",
  RUN_ENVIRONMENT: "protected-demo",
  resolveRunEnvironment: (value: unknown) => (value === "local" ? "local" : "protected-demo"),
}));

const { default: App } = await import("./App");

vi.setConfig({ testTimeout: 20_000 });

/**
 * Rows dense enough that a whole category costs more than the protected demo
 * allows unasked, so the confirmation path is genuinely exercised.
 *
 * Density is what decides that, not row count: the estimator prices output
 * volume, and short rows produce little of it. These are sized like the real
 * Amazon records the demo actually serves (~1KB each).
 */
function csv(rowCount: number): string {
  const header =
    "product_id,product_name,category,discounted_price,actual_price,discount_percentage,rating,rating_count,review_content";
  const rows = Array.from({ length: rowCount }, (_, i) => {
    const text = (
      "The build quality is poor and the cable frayed near the connector after a fortnight of ordinary use. " +
      "It also runs hot enough to be uncomfortable to hold for long, and the indicator light is hard to see. "
    ).repeat(5);
    return `P${i},Widget ${i},Computers&Accessories|Accessories|Hubs,"₹1,099","₹1,499",27%,4.5,120,"${text}"`;
  });
  return [header, ...rows].join("\n");
}

/** Resolves only when the test releases it, so "running" can be observed. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FetchLog {
  analyze: number;
  canonicalize: number;
  /** Signals the analyze requests were issued with, for cancellation checks. */
  signals: AbortSignal[];
}

let fetchLog: FetchLog;
let gate: ReturnType<typeof deferred<void>> | null;

function stubFetch(rowCount: number, options: { holdAnalyze?: boolean } = {}) {
  fetchLog = { analyze: 0, canonicalize: 0, signals: [] };
  gate = options.holdAnalyze ? deferred<void>() : null;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("amazon-products.csv")) {
        return new Response(csv(rowCount), { status: 200, headers: { "content-type": "text/csv" } });
      }
      if (u.includes("/api/canonicalize")) {
        fetchLog.canonicalize++;
        const body = JSON.parse((init?.body as string) ?? "{}") as { labels?: string[] };
        return json({ groups: (body.labels ?? []).map((_, i) => [i]) });
      }
      if (u.includes("/api/analyze")) {
        fetchLog.analyze++;
        if (init?.signal) fetchLog.signals.push(init.signal);
        if (gate) await gate.promise;
        const body = JSON.parse((init?.body as string) ?? "{}") as { reviews?: { id: string }[] };
        const reviews = body.reviews ?? [];
        return json({
          tags: reviews.map((r) => ({
            review_id: r.id,
            theme: "Build quality",
            sentiment: "fault",
            evidence_span: "The build quality is poor",
          })),
          usage: { inputTokens: 100, outputTokens: reviews.length * 40 },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchLog = { analyze: 0, canonicalize: 0, signals: [] };
  gate = null;
});

afterEach(() => {
  gate?.resolve();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Render, wait for the dataset, and select whole-category scope. */
async function openCategoryScope(rowCount: number, options: { holdAnalyze?: boolean } = {}) {
  stubFetch(rowCount, options);
  const user = userEvent.setup();
  render(<App />);
  await waitFor(() => {
    const select = screen.getByLabelText(/^product$/i) as HTMLSelectElement;
    expect(select.options.length).toBeGreaterThan(0);
  });
  await user.click(screen.getByRole("radio", { name: /a category/i }));
  return user;
}

/**
 * The submit button, found by role rather than label.
 *
 * Its label changes while a run is in flight ("Reading reviews…"), so matching
 * on "Run analysis" would silently stop finding it exactly when the locking
 * assertions need it most.
 */
const analyzeButton = () =>
  document.querySelector('button[type="submit"]') as HTMLButtonElement;
const dialog = () => screen.queryByRole("dialog");

// --- the confirmation dialog -------------------------------------------------

describe("confirmation dialog", () => {
  it("appears for a costly selection and dispatches nothing", async () => {
    const user = await openCategoryScope(40);
    await user.click(analyzeButton());

    await waitFor(() => expect(dialog()).not.toBeNull());
    // Reaching "confirming" IS the pipeline declining to start.
    expect(fetchLog.analyze).toBe(0);
    expect(fetchLog.canonicalize).toBe(0);
  });

  it("shows the scope, the row count, a runtime range, a cost ceiling, and the contract", async () => {
    const user = await openCategoryScope(40);
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());

    const panel = within(dialog()!);
    expect(panel.getByText(/Analyze 40 product records\?/i)).toBeTruthy();
    expect(panel.getByText(/Computers&Accessories/)).toBeTruthy();
    expect(panel.getByText(/Estimated time:/i)).toBeTruthy();
    expect(panel.getByText(/(seconds|minutes)/i)).toBeTruthy();
    expect(panel.getByText(/Conservative API cost estimate:/i)).toBeTruthy();
    expect(panel.getByText(/up to about \$\d+\.\d{2}/)).toBeTruthy();
    expect(
      panel.getByText(/creates a report only if the full analysis completes and validates/i),
    ).toBeTruthy();
    expect(panel.getByRole("button", { name: /start analysis/i })).toBeTruthy();
    expect(panel.getByRole("button", { name: /^cancel$/i })).toBeTruthy();
  });

  it("returns to idle on Cancel, with the selection preserved and nothing dispatched", async () => {
    const user = await openCategoryScope(40);
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());

    await user.click(within(dialog()!).getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(dialog()).toBeNull());
    expect(fetchLog.analyze).toBe(0);
    // The category radio is still the chosen scope.
    expect((screen.getByRole("radio", { name: /a category/i }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(analyzeButton()).toBeTruthy();
  });

  it("builds a fresh plan on the next attempt rather than reusing the declined one", async () => {
    const user = await openCategoryScope(40);
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await user.click(within(dialog()!).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(dialog()).toBeNull());

    // Nothing changed, but the plan must be re-derived: the dataset,
    // environment or selection could have moved between attempts, and a
    // remembered estimate would describe a run that no longer exists.
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(within(dialog()!).getByText(/Analyze 40 product records\?/i)).toBeTruthy();
    expect(fetchLog.analyze).toBe(0);
  });

  it("starts exactly one run however many times Start is clicked", async () => {
    const user = await openCategoryScope(40, { holdAnalyze: true });
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());

    const start = within(dialog()!).getByRole("button", { name: /start analysis/i });
    await user.click(start);
    await user.click(start).catch(() => {}); // the dialog is gone by now
    await waitFor(() => expect(dialog()).toBeNull());

    // One run, and its first wave of requests — not two runs' worth.
    await waitFor(() => expect(fetchLog.analyze).toBeGreaterThan(0));
    const afterFirst = fetchLog.analyze;
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchLog.analyze).toBe(afterFirst);
  });

  it("never appears for a selection over the ceiling", async () => {
    // Refused outright — there is no price worth approving for a run that
    // cannot be attempted.
    const user = await openCategoryScope(70);
    await user.click(analyzeButton());

    await waitFor(() =>
      expect(screen.getByText(/over the 60 this deployment allows in one analysis/i)).toBeTruthy(),
    );
    expect(dialog()).toBeNull();
    expect(screen.queryByRole("button", { name: /start analysis/i })).toBeNull();
    expect(fetchLog.analyze).toBe(0);
  });

  it("does not appear for a selection cheap enough to run unasked", async () => {
    const user = await openCategoryScope(40, { holdAnalyze: true });
    // One product is well under the confirmation threshold.
    await user.click(screen.getByRole("radio", { name: /one product/i }));
    await user.click(analyzeButton());

    await waitFor(() => expect(fetchLog.analyze).toBeGreaterThan(0));
    expect(dialog()).toBeNull();
  });
});

// --- the progress panel ------------------------------------------------------

describe("progress panel", () => {
  it("shows row progress and a cancel action while a Claude run is in flight", async () => {
    const user = await openCategoryScope(40, { holdAnalyze: true });
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await user.click(within(dialog()!).getByRole("button", { name: /start analysis/i }));

    await waitFor(() => expect(screen.getByText(/In progress/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /cancel analysis/i })).toBeTruthy();
    expect(screen.getByText(/Preparing analysis…|Analyzing reviews…/)).toBeTruthy();
  });

  it("never shows more completed rows than the selection holds", async () => {
    const user = await openCategoryScope(40, { holdAnalyze: true });
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await user.click(within(dialog()!).getByRole("button", { name: /start analysis/i }));

    const bar = await screen.findByRole("progressbar");
    await waitFor(() => {
      const now = Number(bar.getAttribute("aria-valuenow"));
      const max = Number(bar.getAttribute("aria-valuemax"));
      expect(now).toBeLessThanOrEqual(max);
      expect(now).toBeGreaterThanOrEqual(0);
    });
  });

  it("hides the report and its copy action while a run is in flight", async () => {
    const user = await openCategoryScope(40, { holdAnalyze: true });
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await user.click(within(dialog()!).getByRole("button", { name: /start analysis/i }));
    await waitFor(() => expect(screen.getByText(/In progress/i)).toBeTruthy());

    // A previous report sitting under a live run would read as this run's.
    expect(screen.queryByRole("button", { name: /copy report/i })).toBeNull();
    expect(document.querySelector("article")).toBeNull();
  });

  it("replaces progress with the finished report on success", async () => {
    const user = await openCategoryScope(40);
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await user.click(within(dialog()!).getByRole("button", { name: /start analysis/i }));

    await waitFor(() => expect(document.querySelector("article")).not.toBeNull(), {
      timeout: 15_000,
    });
    expect(screen.queryByText(/In progress/i)).toBeNull();
    expect(screen.getByRole("button", { name: /copy report/i })).toBeTruthy();
  });
});

// --- cancellation ------------------------------------------------------------

describe("cancellation", () => {
  it("stops the run, reports no report was created, and keeps the selection", async () => {
    const user = await openCategoryScope(40, { holdAnalyze: true });
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await user.click(within(dialog()!).getByRole("button", { name: /start analysis/i }));
    await waitFor(() => expect(screen.getByText(/In progress/i)).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /cancel analysis/i }));

    await waitFor(() => expect(screen.getByText(/Analysis cancelled/i)).toBeTruthy());
    expect(screen.getByText(/No report was created/i)).toBeTruthy();
    // Asserted against what actually happened, not against what was rendered:
    // a cancelled banner over requests still in flight would be a lie, and
    // showing the banner is the easy half.
    expect(fetchLog.signals.length).toBeGreaterThan(0);
    for (const signal of fetchLog.signals) expect(signal.aborted).toBe(true);
    // Not an error: nothing went wrong.
    expect(screen.queryByText(/Analysis failed/i)).toBeNull();
    expect(document.querySelector("article")).toBeNull();
    expect(screen.queryByRole("button", { name: /copy report/i })).toBeNull();
    expect((screen.getByRole("radio", { name: /a category/i }) as HTMLInputElement).checked).toBe(
      true,
    );
  });
});

// --- control locking ---------------------------------------------------------

describe("controls are locked while a decision is pending or work is running", () => {
  async function expectControlsLocked() {
    expect((screen.getByLabelText(/^category$/i) as HTMLSelectElement).disabled).toBe(true);
    // The scope radios are disabled by their enclosing fieldset. `input.disabled`
    // reflects only the element's OWN attribute, so asserting it would report
    // false for a control that is genuinely unusable.
    const radio = screen.getByRole("radio", { name: /one product/i });
    expect((radio.closest("fieldset") as HTMLFieldSetElement | null)?.disabled).toBe(true);
    expect(analyzeButton().disabled).toBe(true);
    for (const name of [/use built-in sample/i, /upload csv/i]) {
      const control = screen.queryByRole("button", { name });
      if (control) expect((control as HTMLButtonElement).disabled).toBe(true);
    }
  }

  it("locks them while the confirmation is pending, with the selection still visible", async () => {
    const user = await openCategoryScope(40);
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());

    await expectControlsLocked();
    // Still visible, so the analyst can see what they are approving.
    expect((screen.getByLabelText(/^category$/i) as HTMLSelectElement).value).toBeTruthy();
  });

  it("locks them while a run is in flight", async () => {
    const user = await openCategoryScope(40, { holdAnalyze: true });
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await user.click(within(dialog()!).getByRole("button", { name: /start analysis/i }));
    await waitFor(() => expect(screen.getByText(/In progress/i)).toBeTruthy());

    await expectControlsLocked();
  });

  it("renders no engine control at all, so there is none to switch mid-run", async () => {
    // The engine is build-time configuration, not a UI choice. Asserting its
    // absence is honest; adding a disabled control to satisfy a checklist would
    // not be.
    await openCategoryScope(40);
    expect(screen.queryByLabelText(/engine/i)).toBeNull();
    expect(screen.queryByRole("radio", { name: /claude|heuristic/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /engine/i })).toBeNull();
  });
});

// --- copy hygiene ------------------------------------------------------------

describe("visible copy never names the machinery", () => {
  const FORBIDDEN = /\bbatch|\bchunk|hierarch|retry|endpoint|run id|runid|\/api\//i;

  it("says nothing internal while confirming", async () => {
    const user = await openCategoryScope(40);
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(document.body.textContent ?? "").not.toMatch(FORBIDDEN);
  });

  it("says nothing internal while running", async () => {
    const user = await openCategoryScope(40, { holdAnalyze: true });
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await user.click(within(dialog()!).getByRole("button", { name: /start analysis/i }));
    await waitFor(() => expect(screen.getByText(/In progress/i)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toMatch(FORBIDDEN);
  });

  it("says nothing internal when refusing an oversized selection", async () => {
    const user = await openCategoryScope(70);
    await user.click(analyzeButton());
    await waitFor(() =>
      expect(screen.getByText(/over the 60 this deployment allows in one analysis/i)).toBeTruthy(),
    );
    expect(document.body.textContent ?? "").not.toMatch(FORBIDDEN);
  });

  it("says nothing internal after cancelling", async () => {
    const user = await openCategoryScope(40, { holdAnalyze: true });
    await user.click(analyzeButton());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await user.click(within(dialog()!).getByRole("button", { name: /start analysis/i }));
    await waitFor(() => expect(screen.getByText(/In progress/i)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /cancel analysis/i }));
    await waitFor(() => expect(screen.getByText(/Analysis cancelled/i)).toBeTruthy());
    expect(document.body.textContent ?? "").not.toMatch(FORBIDDEN);
  });
});
