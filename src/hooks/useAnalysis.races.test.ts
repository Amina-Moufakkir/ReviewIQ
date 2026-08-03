// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AnalysisInput, AnalysisResult, Dataset, Product, Review } from "../types";
import type { AnalysisProgress } from "../services/analysisProgress";

/**
 * Race hardening. No new product behaviour — everything here is about what must
 * NOT happen when two runs, or a run and a click, overlap.
 *
 * The failures these prevent all look like the app lying: a report from a run
 * the analyst abandoned, a progress bar sliding backwards, a cancellation
 * silently replaced by the result it was meant to stop. Each is invisible in a
 * screenshot and obvious to whoever has to trust the number.
 *
 * The engine is chosen at module load, so it is mocked rather than configured.
 */
vi.mock("../config", () => ({
  ANALYSIS_ENGINE: "claude",
  RUN_ENVIRONMENT: "protected-demo",
  resolveRunEnvironment: (value: unknown) => (value === "local" ? "local" : "protected-demo"),
}));

const analyzeReviewsMock = vi.hoisted(() => vi.fn());
vi.mock("../services/analyzeReviews", async () => {
  const actual = await vi.importActual<typeof import("../services/analyzeReviews")>(
    "../services/analyzeReviews",
  );
  return { ...actual, analyzeReviews: analyzeReviewsMock };
});

const { useAnalysis } = await import("./useAnalysis");
const { AnalysisError } = await import("../services/analysisEngine");

// --- fixtures ----------------------------------------------------------------

function dataset(rowCount: number, textLength = 900): Dataset {
  const products: Product[] = [
    { id: "p1", name: "Widget", category: "Widgets", topCategory: "Electronics" },
    { id: "p2", name: "Gadget", category: "Widgets", topCategory: "Electronics" },
  ];
  const reviews: Review[] = Array.from({ length: rowCount }, (_, i) => ({
    id: `r${i}`,
    productId: i % 2 === 0 ? "p1" : "p2",
    date: "",
    rating: 4,
    text: "x".repeat(textLength),
  }));
  return { source: "uploaded", label: "x.csv", products, reviews };
}

const cheapQuery: AnalysisInput = {
  scope: { kind: "product", productId: "p1" },
  from: "",
  to: "",
};
const otherQuery: AnalysisInput = {
  scope: { kind: "product", productId: "p2" },
  from: "",
  to: "",
};
const costlyQuery: AnalysisInput = {
  scope: { kind: "category", category: "Electronics" },
  from: "",
  to: "",
};

function result(reviewCount = 3): AnalysisResult {
  return {
    productName: "Widget",
    from: "",
    to: "",
    reviewCount,
    averageRating: 4,
    summary: "s",
    praise: [],
    faults: [],
    recommendations: [],
  };
}

/** A promise the test settles by hand, so two runs can be interleaved. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The onProgress callback the hook handed to a given call. */
function reporterFor(callIndex: number): (p: AnalysisProgress) => void {
  const options = analyzeReviewsMock.mock.calls[callIndex]?.[2] as
    | { onProgress?: (p: AnalysisProgress) => void }
    | undefined;
  return options?.onProgress ?? (() => {});
}

function progress(over: Partial<AnalysisProgress> = {}): AnalysisProgress {
  return {
    phase: "analyzing-reviews",
    rowsCompleted: 5,
    rowsTotal: 10,
    batchesCompleted: 1,
    ...over,
  };
}

beforeEach(() => {
  analyzeReviewsMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- superseded runs ---------------------------------------------------------

describe("a superseded run cannot change what is on screen", () => {
  it("ignores a late result from the run that was replaced", async () => {
    const first = deferred<AnalysisResult>();
    const second = deferred<AnalysisResult>();
    analyzeReviewsMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result: hook } = renderHook(() => useAnalysis(cheapQuery));
    await act(async () => {
      void hook.current.analyze(cheapQuery, dataset(2));
    });
    await act(async () => {
      void hook.current.analyze(cheapQuery, dataset(2));
    });

    // The second run finishes first; the first then lands with a different
    // answer and must be discarded rather than overwrite it.
    await act(async () => {
      second.resolve(result(7));
      await second.promise;
    });
    await act(async () => {
      first.resolve(result(99));
      await first.promise.catch(() => {});
    });

    expect(hook.current.state.status).toBe("success");
    expect(
      (hook.current.state as { status: "success"; result: AnalysisResult }).result.reviewCount,
    ).toBe(7);
  });

  it("ignores a late failure from the run that was replaced", async () => {
    const first = deferred<AnalysisResult>();
    const second = deferred<AnalysisResult>();
    analyzeReviewsMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result: hook } = renderHook(() => useAnalysis(cheapQuery));
    await act(async () => {
      void hook.current.analyze(cheapQuery, dataset(2));
    });
    await act(async () => {
      void hook.current.analyze(cheapQuery, dataset(2));
    });
    await act(async () => {
      second.resolve(result(4));
      await second.promise;
    });
    await act(async () => {
      first.reject(new AnalysisError("the old run failed"));
      await first.promise.catch(() => {});
    });

    // A newer success must not be replaced by an older error.
    expect(hook.current.state.status).toBe("success");
  });

  it("ignores late progress from the run that was replaced", async () => {
    const first = deferred<AnalysisResult>();
    const second = deferred<AnalysisResult>();
    analyzeReviewsMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result: hook } = renderHook(() => useAnalysis(cheapQuery));
    await act(async () => {
      void hook.current.analyze(cheapQuery, dataset(2));
    });
    const staleReporter = reporterFor(0);
    await act(async () => {
      void hook.current.analyze(cheapQuery, dataset(2));
    });

    await act(async () => {
      reporterFor(1)(progress({ rowsCompleted: 2 }));
    });
    await act(async () => {
      staleReporter(progress({ rowsCompleted: 9 }));
    });

    const state = hook.current.state as { status: "running"; progress: AnalysisProgress | null };
    expect(state.status).toBe("running");
    // The abandoned run was further along; that is exactly why it must not win.
    expect(state.progress?.rowsCompleted).toBe(2);
    void first;
    void second;
  });

  it("clears a pending confirmation when a new run is planned", async () => {
    analyzeReviewsMock.mockImplementation(() => deferred<AnalysisResult>().promise);
    const { result: hook } = renderHook(() => useAnalysis(costlyQuery));

    await act(async () => {
      void hook.current.analyze(costlyQuery, dataset(40));
    });
    expect(hook.current.state.status).toBe("confirming");
    const staleState = hook.current.state as { status: "confirming"; plan: unknown };

    // A different, cheap selection starts immediately and retires the question.
    await act(async () => {
      void hook.current.analyze(cheapQuery, dataset(2));
    });
    expect(hook.current.state.status).not.toBe("confirming");

    // The abandoned dialog's Start must do nothing at all.
    const before = analyzeReviewsMock.mock.calls.length;
    await act(async () => {
      void hook.current.confirmRun(
        staleState.plan as never,
        costlyQuery,
        dataset(40),
      );
    });
    expect(analyzeReviewsMock.mock.calls.length).toBe(before);
  });
});

// --- backward progress -------------------------------------------------------

describe("progress never moves backward", () => {
  async function startRunning() {
    analyzeReviewsMock.mockImplementation(() => deferred<AnalysisResult>().promise);
    const { result: hook } = renderHook(() => useAnalysis(cheapQuery));
    await act(async () => {
      void hook.current.analyze(cheapQuery, dataset(2));
    });
    return { hook, report: reporterFor(0) };
  }

  function shownProgress(hook: { current: { state: unknown } }) {
    return (hook.current.state as { progress: AnalysisProgress | null }).progress;
  }

  it("rejects a lower row count", async () => {
    const { hook, report } = await startRunning();
    await act(async () => report(progress({ rowsCompleted: 6 })));
    await act(async () => report(progress({ rowsCompleted: 3 })));
    expect(shownProgress(hook)?.rowsCompleted).toBe(6);
  });

  it("rejects an earlier phase", async () => {
    const { hook, report } = await startRunning();
    await act(async () => report(progress({ phase: "grouping-themes", rowsCompleted: 10 })));
    await act(async () => report(progress({ phase: "analyzing-reviews", rowsCompleted: 10 })));
    expect(shownProgress(hook)?.phase).toBe("grouping-themes");
  });

  it("rejects a changed total, which belongs to another selection", async () => {
    const { hook, report } = await startRunning();
    await act(async () => report(progress({ rowsCompleted: 4, rowsTotal: 10 })));
    await act(async () => report(progress({ rowsCompleted: 9, rowsTotal: 20 })));
    expect(shownProgress(hook)?.rowsTotal).toBe(10);
  });

  it.each([
    ["a negative count", { rowsCompleted: -1 }],
    ["more rows than exist", { rowsCompleted: 99 }],
  ])("ignores %s rather than clamping it into something plausible", async (_name, over) => {
    // Clamping would render a defective callback as ordinary progress and hide
    // the pipeline bug that produced it. Showing nothing is the safer lie.
    const { hook, report } = await startRunning();
    await act(async () => report(progress({ rowsCompleted: 4 })));
    await act(async () => report(progress(over)));
    expect(shownProgress(hook)?.rowsCompleted).toBe(4);
  });

  it("accepts the ordinary forward path", async () => {
    const { hook, report } = await startRunning();
    for (const p of [
      progress({ phase: "preparing", rowsCompleted: 0 }),
      progress({ phase: "analyzing-reviews", rowsCompleted: 4 }),
      progress({ phase: "analyzing-reviews", rowsCompleted: 10 }),
      progress({ phase: "grouping-themes", rowsCompleted: 10 }),
      progress({ phase: "building-report", rowsCompleted: 10 }),
    ]) {
      await act(async () => report(p));
    }
    expect(shownProgress(hook)?.phase).toBe("building-report");
  });
});

// --- cancellation races ------------------------------------------------------

describe("cancellation applies only to the active run", () => {
  it("ignores a success that settles just after Cancel", async () => {
    const run = deferred<AnalysisResult>();
    analyzeReviewsMock.mockImplementation(() => run.promise);

    const { result: hook } = renderHook(() => useAnalysis(cheapQuery));
    await act(async () => {
      void hook.current.analyze(cheapQuery, dataset(2));
    });
    act(() => hook.current.cancel());
    expect(hook.current.state.status).toBe("cancelled");

    // The run was already at the finish line. Rendering its report now would
    // hand the analyst exactly the thing they just declined.
    await act(async () => {
      run.resolve(result(5));
      await run.promise;
    });
    expect(hook.current.state.status).toBe("cancelled");
  });

  it("ignores a failure that settles just after Cancel", async () => {
    const run = deferred<AnalysisResult>();
    analyzeReviewsMock.mockImplementation(() => run.promise);

    const { result: hook } = renderHook(() => useAnalysis(cheapQuery));
    await act(async () => {
      void hook.current.analyze(cheapQuery, dataset(2));
    });
    act(() => hook.current.cancel());
    await act(async () => {
      run.reject(new AnalysisError("aborted"));
      await run.promise.catch(() => {});
    });

    // Cancelled, not failed: nothing went wrong.
    expect(hook.current.state.status).toBe("cancelled");
  });

  it("does not erase a report when Cancel arrives after the run has finished", async () => {
    const run = deferred<AnalysisResult>();
    analyzeReviewsMock.mockImplementation(() => run.promise);

    const { result: hook } = renderHook(() => useAnalysis(cheapQuery));
    await act(async () => {
      void hook.current.analyze(cheapQuery, dataset(2));
    });
    await act(async () => {
      run.resolve(result(6));
      await run.promise;
    });
    await waitFor(() => expect(hook.current.state.status).toBe("success"));

    // There is nothing in flight, so this click has nothing to act on.
    act(() => hook.current.cancel());
    expect(hook.current.state.status).toBe("success");
  });

  it("does nothing when nothing has been run", () => {
    const { result: hook } = renderHook(() => useAnalysis(cheapQuery));
    act(() => hook.current.cancel());
    expect(hook.current.state.status).toBe("idle");
  });
});

// --- confirmation races ------------------------------------------------------

describe("a stale confirmation cannot start a run", () => {
  it("refuses a plan built for a selection that has since changed", async () => {
    analyzeReviewsMock.mockImplementation(() => deferred<AnalysisResult>().promise);
    const { result: hook, rerender } = renderHook(({ q }) => useAnalysis(q), {
      initialProps: { q: costlyQuery },
    });

    await act(async () => {
      void hook.current.analyze(costlyQuery, dataset(40));
    });
    const stale = (hook.current.state as { status: "confirming"; plan: unknown }).plan;

    // The analyst edits the selection. The dialog for the old one is gone from
    // the screen, but a stale event could still carry its plan.
    rerender({ q: otherQuery });
    await act(async () => {
      void hook.current.analyze(otherQuery, dataset(40));
    });

    const before = analyzeReviewsMock.mock.calls.length;
    await act(async () => {
      void hook.current.confirmRun(stale as never, costlyQuery, dataset(40));
    });
    expect(analyzeReviewsMock.mock.calls.length).toBe(before);
  });

  it("starts the run when the plan is the current one", async () => {
    analyzeReviewsMock.mockImplementation(() => deferred<AnalysisResult>().promise);
    const { result: hook } = renderHook(() => useAnalysis(costlyQuery));

    await act(async () => {
      void hook.current.analyze(costlyQuery, dataset(40));
    });
    const current = (hook.current.state as { status: "confirming"; plan: unknown }).plan;

    await act(async () => {
      void hook.current.confirmRun(current as never, costlyQuery, dataset(40));
    });
    expect(hook.current.state.status).toBe("running");
    expect(analyzeReviewsMock.mock.calls[0]?.[2]).toMatchObject({ confirmed: true });
  });

  it("refuses the same plan twice, so a repeated Start cannot run twice", async () => {
    analyzeReviewsMock.mockImplementation(() => deferred<AnalysisResult>().promise);
    const { result: hook } = renderHook(() => useAnalysis(costlyQuery));

    await act(async () => {
      void hook.current.analyze(costlyQuery, dataset(40));
    });
    const plan = (hook.current.state as { status: "confirming"; plan: unknown }).plan;

    await act(async () => {
      void hook.current.confirmRun(plan as never, costlyQuery, dataset(40));
    });
    const after = analyzeReviewsMock.mock.calls.length;
    await act(async () => {
      void hook.current.confirmRun(plan as never, costlyQuery, dataset(40));
    });
    expect(analyzeReviewsMock.mock.calls.length).toBe(after);
  });

  it("refuses a declined plan if its Start is somehow clicked afterwards", async () => {
    analyzeReviewsMock.mockImplementation(() => deferred<AnalysisResult>().promise);
    const { result: hook } = renderHook(() => useAnalysis(costlyQuery));

    await act(async () => {
      void hook.current.analyze(costlyQuery, dataset(40));
    });
    const plan = (hook.current.state as { status: "confirming"; plan: unknown }).plan;
    act(() => hook.current.declineRun());

    await act(async () => {
      void hook.current.confirmRun(plan as never, costlyQuery, dataset(40));
    });
    expect(analyzeReviewsMock).not.toHaveBeenCalled();
  });
});
