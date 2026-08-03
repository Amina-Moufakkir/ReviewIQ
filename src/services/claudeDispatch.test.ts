import { describe, it, expect, vi } from "vitest";
import {
  createAnalyzeDispatch,
  createCanonicalizeDispatch,
  CanonicalizeTransportError,
  type FetchLike,
} from "./claudeDispatch";
import { CanonicalizationError } from "./canonicalize";

/**
 * The adapters translate shapes and nothing else.
 *
 * So what is asserted is exactly that: the right URL, the right body, the
 * endpoint's own error code preserved, and no judgement of its own. An adapter
 * that decided whether to retry, or pre-judged a grouping, would move a decision
 * out of the layer that is tested for it.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REQUEST = {
  runId: "run-1",
  batchIndex: 0,
  rows: [
    { id: "r1", text: "The battery died." },
    { id: "r2", text: "Too heavy." },
  ],
};

const TAGS = [
  { review_id: "r1", theme: "Battery", sentiment: "fault", evidence_span: "battery died" },
];

// --- the tagging adapter -----------------------------------------------------

describe("createAnalyzeDispatch", () => {
  it("posts the rows as JSON to the analyze endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tags: TAGS })) as unknown as FetchLike;
    await createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/api/analyze");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      reviews: [
        { id: "r1", text: "The battery died." },
        { id: "r2", text: "Too heavy." },
      ],
    });
  });

  it("sends only ids and text — no ratings, dates, or subject id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tags: TAGS })) as unknown as FetchLike;
    await createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal);

    const body = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body) as string,
    ) as { reviews: Record<string, unknown>[] };
    for (const row of body.reviews) expect(Object.keys(row).sort()).toEqual(["id", "text"]);
    expect(Object.keys(body)).toEqual(["reviews"]);
  });

  it("passes the signal through so the executor can cancel in flight", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => jsonResponse({ tags: TAGS })) as unknown as FetchLike;
    await createAnalyzeDispatch(fetchImpl)(REQUEST, controller.signal);

    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].signal).toBe(
      controller.signal,
    );
  });

  it("echoes the run id back rather than inventing one", async () => {
    // The endpoint has no concept of a run; the executor treats a mismatch as a
    // protocol violation, so the adapter's only job is to return it faithfully.
    const fetchImpl = (async () => jsonResponse({ tags: TAGS })) as FetchLike;
    const response = await createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal);
    expect(response.runId).toBe("run-1");
  });

  it("returns the tags and the measured usage", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ tags: TAGS, usage: { inputTokens: 900, outputTokens: 120 } })) as FetchLike;
    const response = await createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal);

    expect(response.ok).toBe(true);
    expect(response.tags).toEqual(TAGS);
    expect(response.inputTokens).toBe(900);
    expect(response.outputTokens).toBe(120);
  });

  it("leaves usage undefined rather than inventing a number when it is absent", async () => {
    // A fabricated figure would corrupt the planner's density estimate more
    // quietly than a missing one, which the executor already treats as zero.
    const fetchImpl = (async () => jsonResponse({ tags: TAGS })) as FetchLike;
    const response = await createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal);

    expect(response.outputTokens).toBeUndefined();
    expect(response.inputTokens).toBeUndefined();
  });

  it.each([
    ["a non-numeric value", { inputTokens: "lots", outputTokens: null }],
    ["an infinite value", { inputTokens: Infinity, outputTokens: Number.NaN }],
  ])("ignores usage that is %s", async (_name, usage) => {
    const fetchImpl = (async () => jsonResponse({ tags: TAGS, usage })) as FetchLike;
    const response = await createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal);

    expect(response.inputTokens).toBeUndefined();
    expect(response.outputTokens).toBeUndefined();
  });

  it("does not validate the tags itself — that is the executor's gate", async () => {
    // Passing junk through is correct here: the client-side gate lives in one
    // place, and an adapter that pre-filtered would make it two.
    const junk = [{ nonsense: true }];
    const fetchImpl = (async () => jsonResponse({ tags: junk })) as FetchLike;
    const response = await createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal);

    expect(response.ok).toBe(true);
    expect(response.tags).toEqual(junk);
  });

  it("reports a controlled failure instead of throwing, so the executor can classify it", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: { code: "analysis_busy", message: "busy" } }, 429)) as FetchLike;
    const response = await createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal);

    expect(response.ok).toBe(false);
    expect(response.code).toBe("analysis_busy");
  });

  it("prefers the endpoint's own code over the status", async () => {
    // A 502 can mean several things; the function knows which.
    const fetchImpl = (async () =>
      jsonResponse({ error: { code: "output_truncated" } }, 502)) as FetchLike;
    const response = await createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal);
    expect(response.code).toBe("output_truncated");
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [503, "analysis_disabled"],
    [429, "analysis_busy"],
    [504, "analysis_timeout"],
    [413, "payload_too_large"],
    [500, "provider_unavailable"],
    [400, "invalid_request"],
  ])("falls back to a code for status %i when there is no JSON body", async (status, code) => {
    // 401/403 come from Vercel's deployment protection at the edge, before the
    // function runs, so the body is a sign-in page rather than our JSON.
    const fetchImpl = (async () => new Response("<html>sign in</html>", { status })) as FetchLike;
    const response = await createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal);

    expect(response.ok).toBe(false);
    expect(response.code).toBe(code);
  });

  it.each([
    ["an unreadable body", () => new Response("not json", { status: 200 })],
    ["a missing tags field", () => jsonResponse({ usage: {} })],
    ["a non-array tags field", () => jsonResponse({ tags: "Battery" })],
  ])("reports %s as invalid_response", async (_name, make) => {
    const fetchImpl = (async () => make()) as FetchLike;
    const response = await createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal);

    expect(response.ok).toBe(false);
    expect(response.code).toBe("invalid_response");
  });

  it("lets a fetch rejection propagate rather than judging it", async () => {
    // The executor already distinguishes an abort from a network failure.
    // Duplicating that judgement here would let the two diverge.
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as FetchLike;

    await expect(
      createAnalyzeDispatch(fetchImpl)(REQUEST, new AbortController().signal),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

// --- the grouping adapter ----------------------------------------------------

describe("createCanonicalizeDispatch", () => {
  const LABELS = ["Battery life", "Poor battery"];

  it("posts the labels and nothing else", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ groups: [[0, 1]] })) as unknown as FetchLike;
    await createCanonicalizeDispatch(fetchImpl)(LABELS, new AbortController().signal);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/api/canonicalize");
    expect(init.method).toBe("POST");
    // The endpoint rejects any other property; sending one would fail the run.
    expect(JSON.parse(init.body as string)).toEqual({ labels: LABELS });
  });

  it("returns the grouping unchanged", async () => {
    const fetchImpl = (async () => jsonResponse({ groups: [[0], [1]] })) as FetchLike;
    const outcome = await createCanonicalizeDispatch(fetchImpl)(LABELS, new AbortController().signal);
    expect(outcome.groups).toEqual([[0], [1]]);
  });

  it("does not pre-judge whether the grouping is a valid partition", async () => {
    // validateGrouping is the gate, and it is applied per chunk by the
    // canonicalizer. An adapter that checked first would make it two gates in
    // different places, which is how they drift apart.
    const fetchImpl = (async () => jsonResponse({ groups: [[0]] })) as FetchLike;
    const outcome = await createCanonicalizeDispatch(fetchImpl)(LABELS, new AbortController().signal);
    expect(outcome.groups).toEqual([[0]]);
  });

  it("passes the signal through so a sibling failure can cancel it", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => jsonResponse({ groups: [[0, 1]] })) as unknown as FetchLike;
    await createCanonicalizeDispatch(fetchImpl)(LABELS, controller.signal);

    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].signal).toBe(
      controller.signal,
    );
  });

  it("rejects on a failure, carrying the endpoint's code", async () => {
    // Rejecting rather than returning a failure shape is what aborts the
    // sibling chunks — a level is all-or-nothing and has no retry ladder.
    const fetchImpl = (async () =>
      jsonResponse({ error: { code: "analysis_disabled" } }, 503)) as FetchLike;

    const error = await createCanonicalizeDispatch(fetchImpl)(
      LABELS,
      new AbortController().signal,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CanonicalizeTransportError);
    expect((error as CanonicalizeTransportError).code).toBe("analysis_disabled");
  });

  it("rejects with a CanonicalizationError so the cause survives normalization", async () => {
    // chooseCause passes a CanonicalizationError through untouched and rewrites
    // anything else to a bare provider failure, discarding the code.
    const fetchImpl = (async () => jsonResponse({ error: { code: "analysis_busy" } }, 429)) as FetchLike;

    const error = await createCanonicalizeDispatch(fetchImpl)(
      LABELS,
      new AbortController().signal,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CanonicalizationError);
    expect((error as CanonicalizationError).reason).toBe("provider");
  });

  it.each([
    ["an unreadable body", () => new Response("not json", { status: 200 })],
    ["a missing groups field", () => jsonResponse({ clusters: [[0, 1]] })],
    ["a non-array groups field", () => jsonResponse({ groups: "everything" })],
  ])("rejects %s as invalid_response", async (_name, make) => {
    const fetchImpl = (async () => make()) as FetchLike;

    const error = await createCanonicalizeDispatch(fetchImpl)(
      LABELS,
      new AbortController().signal,
    ).catch((e: unknown) => e);

    expect((error as CanonicalizeTransportError).code).toBe("invalid_response");
  });
});
