import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Endpoint tests for the theme-label canonicalization function.
 *
 * The provider is mocked in every test — nothing here reaches the network or
 * spends money. What is asserted is the endpoint's *contract*: that the kill
 * switch is fail-closed and sits in front of everything, that the request
 * carries labels and nothing that could smuggle review text, that no grouping
 * which fails to partition the labels can leave the handler, and that the logs
 * carry counts rather than content.
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
  class MockAPIConnectionError extends MockAPIError {
    constructor() {
      super(0, "connection_error");
    }
  }
  return { stream: vi.fn(), MockAPIError, MockAPIConnectionError };
});

vi.mock("@anthropic-ai/sdk", () => {
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

const { default: handler } = await import("../../api/canonicalize.js");
const { MAX_LABELS_PER_CANONICALIZATION_REQUEST, MAX_LABEL_LENGTH, MAX_CANONICALIZATION_BODY_BYTES } =
  await import("../../src/services/canonicalize.js");

// --- harness ----------------------------------------------------------------

const SECRET_LOOKING_KEY = "sk-ant-api03-THIS-MUST-NEVER-BE-LOGGED";
const LABELS = ["Battery life", "Poor battery", "Comfort"];

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

function rawStream(text: string, stopReason = "end_turn") {
  return {
    finalMessage: async () => ({
      stop_reason: stopReason,
      content: [{ type: "text", text }],
      usage: { input_tokens: 120, output_tokens: 8 },
    }),
  };
}

/** A provider response whose grouping validates against `LABELS`. */
function goodStream(groups: unknown = [[0, 1], [2]], stopReason = "end_turn") {
  return rawStream(JSON.stringify({ groups }), stopReason);
}

function throwingStream(err: unknown) {
  return {
    finalMessage: async () => {
      throw err;
    },
  };
}

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

function errorMessage(body: unknown): string {
  return (body as { error: { message: string } }).error.message;
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

// --- method and kill switch --------------------------------------------------

describe("method handling", () => {
  it.each(["GET", "PUT", "DELETE", "PATCH"])("rejects %s without reaching the provider", async (method) => {
    const { r, captured } = res();
    await handler(req({ labels: LABELS }, { method }), r);

    expect(captured.status).toBe(405);
    expect(captured.headers.Allow).toBe("POST");
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});

describe("CLAUDE_ENABLED kill switch — default must be safe", () => {
  it("is disabled when CLAUDE_ENABLED is missing entirely", async () => {
    delete process.env.CLAUDE_ENABLED;
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(503);
    expect(errorCode(captured.body)).toBe("analysis_disabled");
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it.each(["false", "TRUE", "True", "1", "yes", "", " true "])(
    "is disabled for the value %j — only the exact string enables it",
    async (value) => {
      process.env.CLAUDE_ENABLED = value;
      const { r, captured } = res();
      await handler(req({ labels: LABELS }), r);

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
    expect(errorCode(captured.body)).toBe("analysis_disabled");
  });

  it("prevents the provider call even when everything else is valid", async () => {
    process.env.CLAUDE_ENABLED = "false";
    mocks.stream.mockReturnValue(goodStream());
    const { r } = res();
    await handler(req({ labels: LABELS }), r);

    expect(mocks.stream).not.toHaveBeenCalled();
  });
});

describe("misconfiguration is distinct from a deliberate disable", () => {
  it("returns server_misconfigured when enabled but the key is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(500);
    expect(errorCode(captured.body)).toBe("server_misconfigured");
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});

// --- the labels-only contract ------------------------------------------------

describe("the request carries labels and nothing else", () => {
  it.each([
    ["a non-object body", "not an object"],
    ["null", null],
    ["a missing labels field", { themes: ["Battery"] }],
    ["a non-array labels field", { labels: "Battery" }],
    ["an empty labels array", { labels: [] }],
    ["a non-string label", { labels: ["Battery", 7] }],
    ["a blank label", { labels: ["Battery", "   "] }],
    ["a duplicate label", { labels: ["Battery", "Battery"] }],
  ])("rejects %s before reaching the provider", async (_name, body) => {
    const { r, captured } = res();
    await handler(req(body), r);

    expect(captured.status).toBe(400);
    expect(errorCode(captured.body)).toBe("invalid_request");
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("rejects a label long enough to hide a review body", async () => {
    // The structural half of "labels only, never review text". A `string[]`
    // cannot express that on its own; the length guard is what enforces it.
    const reviewBody = "x".repeat(MAX_LABEL_LENGTH + 1);
    const { r, captured } = res();
    await handler(req({ labels: ["Battery life", reviewBody] }), r);

    expect(captured.status).toBe(400);
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("accepts a label exactly at the length limit", async () => {
    const atLimit = "b".repeat(MAX_LABEL_LENGTH);
    mocks.stream.mockReturnValue(rawStream(JSON.stringify({ groups: [[0]] })));
    const { r, captured } = res();
    await handler(req({ labels: [atLimit] }), r);

    expect(captured.status).toBe(200);
  });

  it("rejects more labels than one request may carry", async () => {
    const tooMany = Array.from(
      { length: MAX_LABELS_PER_CANONICALIZATION_REQUEST + 1 },
      (_, i) => `theme ${i}`,
    );
    const { r, captured } = res();
    await handler(req({ labels: tooMany }), r);

    expect(captured.status).toBe(400);
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("accepts exactly the maximum number of labels", async () => {
    const atLimit = Array.from(
      { length: MAX_LABELS_PER_CANONICALIZATION_REQUEST },
      (_, i) => `theme ${i}`,
    );
    mocks.stream.mockReturnValue(rawStream(JSON.stringify({ groups: atLimit.map((_, i) => [i]) })));
    const { r, captured } = res();
    await handler(req({ labels: atLimit }), r);

    expect(captured.status).toBe(200);
  });

  it("rejects an oversized body by its declared length, before parsing it", async () => {
    const { r, captured } = res();
    await handler(
      req({ labels: LABELS }, { headers: { "content-length": String(MAX_CANONICALIZATION_BODY_BYTES + 1) } }),
      r,
    );

    expect(captured.status).toBe(413);
    expect(errorCode(captured.body)).toBe("payload_too_large");
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("ignores extra fields rather than forwarding them — review text cannot ride along", async () => {
    mocks.stream.mockReturnValue(goodStream());
    const { r, captured } = res();
    await handler(
      req({ labels: LABELS, reviews: [{ id: "r1", text: "the battery died after two days" }] }),
      r,
    );

    expect(captured.status).toBe(200);
    const sent = JSON.stringify(mocks.stream.mock.calls[0]?.[0]);
    expect(sent).not.toContain("the battery died after two days");
    expect(sent).not.toContain("r1");
  });

  it("sends every given label to the provider and nothing more", async () => {
    mocks.stream.mockReturnValue(goodStream());
    const { r } = res();
    await handler(req({ labels: LABELS }), r);

    const content = String(
      (mocks.stream.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[0]!.content,
    );
    for (const label of LABELS) expect(content).toContain(label);
  });
});

// --- the grouping gate -------------------------------------------------------

describe("only an exact partition of the labels leaves the handler", () => {
  it("returns the grouping when it partitions the labels", async () => {
    mocks.stream.mockReturnValue(goodStream([[0, 1], [2]]));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ groups: [[0, 1], [2]] });
  });

  it.each([
    ["a dropped label", [[0, 1]]],
    ["a duplicated label", [[0, 1], [1, 2]]],
    ["an out-of-range index", [[0, 1], [2], [3]]],
    ["a negative index", [[-1], [0, 1], [2]]],
    ["a non-integer index", [[0.5], [1], [2]]],
    ["an empty group", [[0, 1], [2], []]],
    ["a non-array group", [[0, 1], 2]],
    ["no groups at all", []],
    ["a non-array grouping", { a: 1 }],
  ])("rejects %s rather than passing it downstream", async (_name, groups) => {
    mocks.stream.mockReturnValue(goodStream(groups));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(502);
    expect(errorCode(captured.body)).toBe("invalid_grouping");
    expect(captured.body).not.toHaveProperty("groups");
  });

  it("rejects a missing groups field", async () => {
    mocks.stream.mockReturnValue(rawStream(JSON.stringify({ clusters: [[0, 1], [2]] })));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(502);
    expect(errorCode(captured.body)).toBe("invalid_grouping");
  });

  it("accepts a grouping wrapped in a markdown code fence", async () => {
    mocks.stream.mockReturnValue(
      rawStream("```json\n" + JSON.stringify({ groups: [[0, 1], [2]] }) + "\n```"),
    );
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(200);
  });

  it("returns analysis_failed for unparseable output", async () => {
    mocks.stream.mockReturnValue(rawStream("I grouped them for you!"));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(502);
    expect(errorCode(captured.body)).toBe("analysis_failed");
  });

  it("returns output_truncated when the model hit its token ceiling", async () => {
    mocks.stream.mockReturnValue(goodStream([[0, 1], [2]], "max_tokens"));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    // Distinct from analysis_failed: the caller can retry with fewer labels,
    // which is not true of the generic failure.
    expect(captured.status).toBe(502);
    expect(errorCode(captured.body)).toBe("output_truncated");
  });

  it("returns analysis_failed on a refusal, even though the body would have parsed", async () => {
    mocks.stream.mockReturnValue(goodStream([[0, 1], [2]], "refusal"));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(502);
    expect(errorCode(captured.body)).toBe("analysis_failed");
    expect(captured.body).not.toHaveProperty("groups");
  });
});

// --- provider failures become controlled responses ---------------------------

describe("provider failures", () => {
  it("maps a timeout to 504 analysis_timeout", async () => {
    mocks.stream.mockImplementation((_body: unknown, opts: { signal: AbortSignal }) => {
      return {
        finalMessage: async () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          // Mirror the SDK: the signal is what the handler inspects.
          Object.defineProperty(opts.signal, "aborted", { value: true, configurable: true });
          throw err;
        },
      };
    });
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(504);
    expect(errorCode(captured.body)).toBe("analysis_timeout");
  });

  it("maps a connection error to 502 provider_unavailable", async () => {
    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIConnectionError()));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(502);
    expect(errorCode(captured.body)).toBe("provider_unavailable");
  });

  it("maps 429 to 429 analysis_busy", async () => {
    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(429, "rate_limit_error")));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(429);
    expect(errorCode(captured.body)).toBe("analysis_busy");
  });

  it("maps a billing 403 to provider_unavailable, not a configuration problem", async () => {
    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(403, "billing_error")));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(502);
    expect(errorCode(captured.body)).toBe("provider_unavailable");
    expect(loggedFields().at(-1)?.providerNote).toBe("billing");
  });

  it.each([401, 403, 404])("maps %i to 500 server_misconfigured", async (status) => {
    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(status)));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(500);
    expect(errorCode(captured.body)).toBe("server_misconfigured");
  });

  it.each([500, 503, 529])("maps %i to 502 provider_unavailable", async (status) => {
    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(status)));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(502);
    expect(errorCode(captured.body)).toBe("provider_unavailable");
  });

  it("maps an unrecognised throw to 502 analysis_failed", async () => {
    mocks.stream.mockReturnValue(throwingStream(new Error("something else entirely")));
    const { r, captured } = res();
    await handler(req({ labels: LABELS }), r);

    expect(captured.status).toBe(502);
    expect(errorCode(captured.body)).toBe("analysis_failed");
  });

  it("never forwards the provider's own error text to the caller", async () => {
    for (const err of [
      new mocks.MockAPIError(500),
      new mocks.MockAPIConnectionError(),
      new Error("provider said something we must never forward"),
    ]) {
      mocks.stream.mockReturnValue(throwingStream(err));
      const { r, captured } = res();
      await handler(req({ labels: LABELS }), r);

      expect(errorMessage(captured.body)).not.toContain("must never forward");
    }
  });
});

// --- logs carry counts, not content ------------------------------------------

describe("structured logs", () => {
  it("never records the labels themselves", async () => {
    mocks.stream.mockReturnValue(goodStream());
    const { r } = res();
    await handler(req({ labels: LABELS }), r);

    const lines = loggedLines().join("\n");
    for (const label of LABELS) expect(lines).not.toContain(label);
  });

  it("records counts on success", async () => {
    mocks.stream.mockReturnValue(goodStream([[0, 1], [2]]));
    const { r } = res();
    await handler(req({ labels: LABELS }), r);

    const fields = loggedFields().at(-1)!;
    expect(fields.status).toBe(200);
    expect(fields.labelCount).toBe(3);
    expect(fields.groupCount).toBe(2);
    expect(fields.outputTokens).toBe(8);
  });

  it("never records the API key, under any failure", async () => {
    const cases: (() => void)[] = [
      () => mocks.stream.mockReturnValue(goodStream()),
      () => mocks.stream.mockReturnValue(rawStream("not json")),
      () => mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(500))),
    ];
    for (const setup of cases) {
      setup();
      const { r } = res();
      await handler(req({ labels: LABELS }), r);
    }
    expect(loggedLines().join("\n")).not.toContain(SECRET_LOOKING_KEY);
    expect(loggedLines().join("\n")).not.toContain("sk-ant");
  });

  it("omits the caller hash entirely when LOG_SALT is unset", async () => {
    mocks.stream.mockReturnValue(goodStream());
    const { r } = res();
    await handler(req({ labels: LABELS }, { headers: { "x-forwarded-for": "203.0.113.7" } }), r);

    const fields = loggedFields().at(-1)!;
    expect(fields).not.toHaveProperty("caller");
    expect(loggedLines().join("\n")).not.toContain("203.0.113.7");
  });

  it("records a hash, never the address, when LOG_SALT is set", async () => {
    process.env.LOG_SALT = "salt-for-tests";
    mocks.stream.mockReturnValue(goodStream());
    const { r } = res();
    await handler(req({ labels: LABELS }, { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }), r);

    const fields = loggedFields().at(-1)!;
    expect(typeof fields.caller).toBe("string");
    expect(loggedLines().join("\n")).not.toContain("203.0.113.7");
  });

  it("gives every response a code an operator can group by", async () => {
    mocks.stream.mockReturnValue(throwingStream(new mocks.MockAPIError(429)));
    const { r } = res();
    await handler(req({ labels: LABELS }), r);

    const fields = loggedFields().at(-1)!;
    expect(fields.at).toBe("api/canonicalize");
    expect(fields.code).toBe("analysis_busy");
    expect(typeof fields.requestId).toBe("string");
    expect(typeof fields.ms).toBe("number");
  });
});
