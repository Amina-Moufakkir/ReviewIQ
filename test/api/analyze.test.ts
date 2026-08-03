import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Endpoint tests for the Claude tagging function.
 *
 * The provider is mocked in every test — nothing here reaches the network or
 * spends money. What is being asserted is the endpoint's *contract*: that the
 * kill switch is fail-closed and sits in front of everything, that the provider
 * is never reached without passing every gate, that provider failures become
 * controlled responses, and that the logs cannot carry review text or secrets.
 */

const mocks = vi.hoisted(() => {
  class MockAPIError extends Error {
    status: number;
    type: string;
    constructor(status: number, type = "api_error") {
      super("provider said something we must never forward");
      this.status = status;
      this.type = type;
    }
  }
  // Mirrors the real SDK, where APIConnectionError extends APIError — so the
  // handler's "check connection errors first" ordering is genuinely exercised.
  class MockAPIConnectionError extends MockAPIError {
    constructor() {
      super(0, "connection_error");
    }
  }
  return { stream: vi.fn(), MockAPIError, MockAPIConnectionError };
});

vi.mock("@anthropic-ai/sdk", () => {
  // A plain function expression, not an arrow: the handler calls `new Anthropic(...)`.
  const Anthropic = vi.fn(function () {
    return { messages: { stream: mocks.stream } };
  }) as unknown as {
    new (...args: unknown[]): unknown;
    APIError: typeof mocks.MockAPIError;
    APIConnectionError: typeof mocks.MockAPIConnectionError;
  };
  Anthropic.APIError = mocks.MockAPIError;
  Anthropic.APIConnectionError = mocks.MockAPIConnectionError;
  return { default: Anthropic };
});

const { default: handler } = await import("../../api/analyze.js");
const { MAX_ROWS_PER_BATCH_REQUEST } = await import("../../src/services/claudeTags.js");

// --- harness ----------------------------------------------------------------

const REVIEW_TEXT = "Very comfortable to wear but the battery dies quickly.";
const SECRET_LOOKING_KEY = "sk-ant-api03-THIS-MUST-NEVER-BE-LOGGED";

function req(body: unknown, overrides: Record<string, unknown> = {}) {
  return { method: "POST", headers: {}, body, ...overrides } as never;
}

function res() {
  const captured = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const r = {
    status(code: number) {
      captured.status = code;
      return r;
    },
    json(payload: unknown) {
      captured.body = payload;
      return r;
    },
    setHeader(key: string, value: string) {
      captured.headers[key] = value;
      return r;
    },
  };
  return { r: r as never, captured };
}

function validBody(text = REVIEW_TEXT) {
  return { reviews: [{ id: "r1", text }] };
}

/** A provider response whose tags all validate against `validBody()`. */
function goodStream(stopReason = "end_turn") {
  return {
    finalMessage: async () => ({
      stop_reason: stopReason,
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
          ]),
        },
      ],
      usage: { input_tokens: 1234, output_tokens: 56 },
    }),
  };
}

function rawStream(text: string, stopReason = "end_turn") {
  return {
    finalMessage: async () => ({
      stop_reason: stopReason,
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  };
}

function throwingStream(err: unknown) {
  return {
    finalMessage: async () => {
      throw err;
    },
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.CLAUDE_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = SECRET_LOOKING_KEY;
  delete process.env.LOG_SALT;
});

afterEach(() => {
  logSpy.mockRestore();
  process.env = { ...ORIGINAL_ENV };
});

function loggedLines(): string[] {
  return logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
}

function loggedFields(): Record<string, unknown>[] {
  return loggedLines().map((l) => JSON.parse(l) as Record<string, unknown>);
}

// --- kill switch ------------------------------------------------------------

describe("CLAUDE_ENABLED kill switch — default must be safe", () => {
  it("is disabled when CLAUDE_ENABLED is missing entirely", async () => {
    delete process.env.CLAUDE_ENABLED;
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(503);
    expect((captured.body as { error: { code: string } }).error.code).toBe("analysis_disabled");
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("is disabled when CLAUDE_ENABLED is false", async () => {
    process.env.CLAUDE_ENABLED = "false";
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(503);
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it.each(["TRUE", "True", "1", "yes", "", " true "])(
    "is disabled for the near-miss value %j — only the exact string enables it",
    async (value) => {
      process.env.CLAUDE_ENABLED = value;
      const { r, captured } = res();
      await handler(req(validBody()), r);

      expect(captured.status).toBe(503);
      expect(mocks.stream).not.toHaveBeenCalled();
    },
  );

  it("refuses before inspecting the body, so a disabled endpoint reveals nothing about the request", async () => {
    process.env.CLAUDE_ENABLED = "false";
    const { r, captured } = res();
    await handler(req({ nonsense: true }), r);

    // Not 400 invalid_request — the caller learns only that analysis is off.
    expect(captured.status).toBe(503);
    expect((captured.body as { error: { code: string } }).error.code).toBe("analysis_disabled");
  });

  it("prevents the provider call even when everything else is valid", async () => {
    process.env.CLAUDE_ENABLED = "false";
    mocks.stream.mockReturnValue(goodStream());
    const { r } = res();
    await handler(req(validBody()), r);

    expect(mocks.stream).not.toHaveBeenCalled();
  });
});

// --- configuration ----------------------------------------------------------

describe("misconfiguration is distinct from a deliberate disable", () => {
  it("returns server_misconfigured when enabled but the key is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(500);
    expect((captured.body as { error: { code: string } }).error.code).toBe("server_misconfigured");
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("logs the two states under different codes so an operator can tell them apart", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await handler(req(validBody()), res().r);
    delete process.env.CLAUDE_ENABLED;
    await handler(req(validBody()), res().r);

    expect(loggedFields().map((f) => f.code)).toEqual(["server_misconfigured", "analysis_disabled"]);
  });
});

// --- request gates ----------------------------------------------------------

describe("the provider is never reached from an invalid request", () => {
  it("rejects a non-POST method", async () => {
    const { r, captured } = res();
    await handler(req(validBody(), { method: "GET" }), r);

    expect(captured.status).toBe(405);
    expect(captured.headers.Allow).toBe("POST");
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-object body", "not an object"],
    ["a missing reviews array", { nope: [] }],
    ["an empty reviews array", { reviews: [] }],
    ["a blank id", { reviews: [{ id: "  ", text: "hello" }] }],
    ["blank text", { reviews: [{ id: "r1", text: "   " }] }],
    ["a duplicate id", { reviews: [{ id: "r1", text: "a" }, { id: "r1", text: "b" }] }],
  ])("rejects %s without calling the provider", async (_label, body) => {
    const { r, captured } = res();
    await handler(req(body), r);

    expect(captured.status).toBe(400);
    expect((captured.body as { error: { code: string } }).error.code).toBe("invalid_request");
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("accepts a batch exactly at the per-request row limit", async () => {
    mocks.stream.mockReturnValue(rawStream("[]"));
    const reviews = Array.from({ length: MAX_ROWS_PER_BATCH_REQUEST }, (_, i) => ({
      id: `r${i}`,
      text: "ok",
    }));
    const { r, captured } = res();
    await handler(req({ reviews }), r);

    expect(captured.status).toBe(200);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it("rejects one row over the limit, before the provider is reached", async () => {
    const reviews = Array.from({ length: MAX_ROWS_PER_BATCH_REQUEST + 1 }, (_, i) => ({
      id: `r${i}`,
      text: "ok",
    }));
    const { r, captured } = res();
    await handler(req({ reviews }), r);

    expect(captured.status).toBe(413);
    expect((captured.body as { error: { code: string } }).error.code).toBe("too_many_reviews");
    // The point of the gate: nothing is spent discovering the overshoot.
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("enforces the text-byte limit independently of the row limit", async () => {
    // Few enough rows to pass the row gate, far too much text to pass the byte
    // gate. One limit must not stand in for the other.
    const reviews = [{ id: "r1", text: "x".repeat(300_000) }];
    const { r, captured } = res();
    await handler(req({ reviews }), r);

    expect(reviews.length).toBeLessThanOrEqual(MAX_ROWS_PER_BATCH_REQUEST);
    expect(captured.status).toBe(413);
    expect((captured.body as { error: { code: string } }).error.code).toBe("payload_too_large");
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("enforces the declared body-size limit independently of the row limit", async () => {
    const { r, captured } = res();
    await handler(
      req({ reviews: [{ id: "r1", text: "ok" }] }, {
        headers: { "content-length": String(10 * 1024 * 1024) },
      }),
      r,
    );

    expect(captured.status).toBe(413);
    expect(mocks.stream).not.toHaveBeenCalled();
  });

});

// --- success ----------------------------------------------------------------

describe("success path", () => {
  it("returns only validated tags", async () => {
    mocks.stream.mockReturnValue(goodStream());
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({
      tags: [
        { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
      ],
    });
  });

  it("drops tags the model invented, keeping the grounded ones", async () => {
    mocks.stream.mockReturnValue(
      rawStream(
        JSON.stringify([
          { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
          { review_id: "ghost", theme: "Speed", sentiment: "praise", evidence_span: "comfortable to wear" },
          { review_id: "r1", theme: "Fit", sentiment: "praise", evidence_span: "text that is not in the review" },
        ]),
      ),
    );
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(200);
    expect((captured.body as { tags: unknown[] }).tags).toHaveLength(1);
  });

  it("records usage and validation counts in the log", async () => {
    mocks.stream.mockReturnValue(goodStream());
    await handler(req(validBody()), res().r);

    const entry = loggedFields()[0]!;
    expect(entry).toMatchObject({
      at: "api/analyze",
      code: "ok",
      status: 200,
      reviewCount: 1,
      accepted: 1,
      rejected: 0,
      deduped: 0,
      inputTokens: 1234,
      outputTokens: 56,
      stopReason: "end_turn",
    });
    expect(entry.model).toBeTypeOf("string");
    expect(entry.inputTextBytes).toBe(Buffer.byteLength(REVIEW_TEXT, "utf8"));
    expect(entry.ts).toBeTypeOf("string");
  });
});

// --- provider response failures ---------------------------------------------

describe("provider response failures are controlled", () => {
  it("fails when the model refuses", async () => {
    mocks.stream.mockReturnValue(goodStream("refusal"));
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(502);
    expect((captured.body as { error: { code: string } }).error.code).toBe("analysis_failed");
  });

  it("fails when output was truncated", async () => {
    mocks.stream.mockReturnValue(goodStream("max_tokens"));
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(502);
    expect(loggedFields()[0]!.stopReason).toBe("max_tokens");
  });

  it("fails when the output is not parseable JSON", async () => {
    mocks.stream.mockReturnValue(rawStream("I'm afraid I can't do that."));
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(502);
  });

  it("fails when every tag is rejected rather than returning an empty success", async () => {
    mocks.stream.mockReturnValue(
      rawStream(
        JSON.stringify([
          { review_id: "ghost", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
        ]),
      ),
    );
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(502);
    expect(loggedFields()[0]).toMatchObject({ accepted: 0, rejected: 1 });
  });

  it("treats a genuinely empty tag array as a legitimate empty success", async () => {
    mocks.stream.mockReturnValue(rawStream("[]"));
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ tags: [] });
  });
});

// --- provider error taxonomy ------------------------------------------------

describe("provider error taxonomy", () => {
  it("maps an abort to a timeout", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    mocks.stream.mockReturnValue(throwingStream(abort));
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(504);
    expect((captured.body as { error: { code: string } }).error.code).toBe("analysis_timeout");
  });

  it("maps 429 to a distinct busy status", async () => {
    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(429, "rate_limit_error")));
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(429);
    expect((captured.body as { error: { code: string } }).error.code).toBe("analysis_busy");
    expect(loggedFields()[0]!.providerNote).toBe("rate_limited");
  });

  it("maps a provider auth failure to misconfiguration, never to a key hint", async () => {
    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(401, "authentication_error")));
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(500);
    expect((captured.body as { error: { code: string } }).error.code).toBe("server_misconfigured");
    expect(loggedFields()[0]!.providerNote).toBe("provider_auth");
  });

  it("reports billing exhaustion as unavailability to the caller, but records it in the log", async () => {
    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(403, "billing_error")));
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(502);
    const body = captured.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("provider_unavailable");
    // The caller is never told a billing cause.
    expect(body.error.message).not.toMatch(/billing|credit|quota|spend/i);
    expect(loggedFields()[0]!.providerNote).toBe("billing");
  });

  it("maps provider 5xx and overload to unavailability", async () => {
    for (const [status, note] of [
      [500, "provider_5xx"],
      [529, "overloaded"],
    ] as const) {
      vi.clearAllMocks();
      mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(status)));
      const { r, captured } = res();
      await handler(req(validBody()), r);

      expect(captured.status).toBe(502);
      expect((captured.body as { error: { code: string } }).error.code).toBe("provider_unavailable");
      expect(loggedFields()[0]!.providerNote).toBe(note);
    }
  });

  it("maps a network failure to unavailability", async () => {
    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIConnectionError()));
    const { r, captured } = res();
    await handler(req(validBody()), r);

    expect(captured.status).toBe(502);
    expect(loggedFields()[0]!.providerNote).toBe("connection");
  });

  it("never forwards the provider's own error text", async () => {
    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(500)));
    const { r, captured } = res();
    await handler(req(validBody()), r);

    const serialized = JSON.stringify(captured.body);
    expect(serialized).not.toMatch(/must never forward/);
  });
});

// --- log hygiene ------------------------------------------------------------

describe("logs carry no review text and no secrets", () => {
  it("never writes review text, evidence spans, or the API key", async () => {
    mocks.stream.mockReturnValue(goodStream());
    await handler(req(validBody()), res().r);

    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(500)));
    await handler(req(validBody()), res().r);

    const all = loggedLines().join("\n");
    expect(all).not.toContain(REVIEW_TEXT);
    expect(all).not.toContain("comfortable to wear");
    expect(all).not.toContain(SECRET_LOOKING_KEY);
    expect(all).not.toMatch(/sk-ant-/);
  });

  it("logs only primitive, non-textual fields", async () => {
    mocks.stream.mockReturnValue(goodStream());
    await handler(req(validBody()), res().r);

    const allowed = new Set([
      "at", "ts", "requestId", "caller", "status", "code", "ms", "reviewCount",
      "inputTextBytes", "model", "stopReason", "accepted", "rejected", "deduped",
      "inputTokens", "outputTokens", "providerNote",
    ]);
    for (const key of Object.keys(loggedFields()[0]!)) {
      expect(allowed, `unexpected log field: ${key}`).toContain(key);
    }
  });

  it("omits the caller hash entirely when no salt is configured", async () => {
    mocks.stream.mockReturnValue(goodStream());
    await handler(req(validBody(), { headers: { "x-forwarded-for": "203.0.113.9" } }), res().r);

    expect(loggedFields()[0]).not.toHaveProperty("caller");
  });

  it("hashes the caller rather than logging the address, and is stable per address", async () => {
    process.env.LOG_SALT = "a-salt";
    mocks.stream.mockReturnValue(goodStream());
    const headers = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" };
    await handler(req(validBody(), { headers }), res().r);
    await handler(req(validBody(), { headers }), res().r);
    await handler(req(validBody(), { headers: { "x-forwarded-for": "198.51.100.4" } }), res().r);

    const entries = loggedFields();
    expect(entries[0]!.caller).toBeTypeOf("string");
    expect(loggedLines().join("\n")).not.toContain("203.0.113.9");
    expect(entries[0]!.caller).toBe(entries[1]!.caller);
    expect(entries[0]!.caller).not.toBe(entries[2]!.caller);
  });

  it("changes the hash when the salt changes, so it is not a bare address digest", async () => {
    mocks.stream.mockReturnValue(goodStream());
    const headers = { "x-forwarded-for": "203.0.113.9" };

    process.env.LOG_SALT = "salt-one";
    await handler(req(validBody(), { headers }), res().r);
    process.env.LOG_SALT = "salt-two";
    await handler(req(validBody(), { headers }), res().r);

    const [a, b] = loggedFields();
    expect(a!.caller).not.toBe(b!.caller);
  });
});
