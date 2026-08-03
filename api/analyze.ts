import { createHash, randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
// Explicit .js extension: the deployed function runs as native ESM (the repo is
// "type": "module"), where extensionless relative imports do not resolve. This
// is the function's only runtime relative import — claudeTags' own `import type`
// of ../types is erased at compile time.
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_ROWS_PER_BATCH_REQUEST,
  MAX_TOTAL_REVIEW_TEXT_BYTES,
  parseReviewRequest,
  toRawTag,
  validateModelResponse,
} from "../src/services/claudeTags.js";
// The prompt lives in its own server-only module so the local benchmark
// (scripts/bench-models.ts) can measure exactly what this handler sends,
// without importing the HTTP layer. It lives OUTSIDE api/ because Vercel turns
// every file in that directory into a public route. See server/claudePrompt.ts.
import {
  SYSTEM_PROMPT,
  buildUserContent,
  MAX_OUTPUT_TOKENS,
  CLAUDE_TIMEOUT_MS,
} from "../server/claudePrompt.js";

// Allow up to the Claude call's own 30s timeout plus response overhead.
export const config = { maxDuration: 60 };

/** Model is overridable via env; defaults to the current Opus per Anthropic guidance. */
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

/**
 * Server-side kill switch. Deliberately strict: only the exact string "true"
 * enables Claude, so a missing, empty, misspelled or partially-deployed variable
 * leaves the endpoint OFF. The default has to be safe, because the failure this
 * guards against is an unattended paid endpoint, and every way of getting the
 * variable wrong should land on "disabled" rather than "spending".
 *
 * Read per request rather than at module load — but NOT because that makes a
 * dashboard change take effect sooner. On Vercel the environment is fixed for
 * the life of a deployment: `process.env` cannot change under a running
 * function, and editing the variable has no effect on any request until the
 * project is redeployed. Reading it here buys deterministic behavior in tests
 * and under `vercel dev`, where the process environment genuinely can differ
 * between calls. The redeploy requirement is documented in README.md so the
 * switch's name does not imply an immediacy it does not have.
 */
function claudeEnabled(): boolean {
  return process.env.CLAUDE_ENABLED === "true";
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const caller = callerHash(req);

  const fail = (status: number, code: string, message: string, extra: Partial<LogFields> = {}) => {
    log({ requestId, caller, status, code, ms: Date.now() - startedAt, ...extra });
    return sendError(res, status, code, message);
  };

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(405, "method_not_allowed", "Only POST is supported.");
  }

  // The kill switch is checked before the body is examined at all. A disabled
  // endpoint should say nothing about the caller's payload — not whether it was
  // well-formed, not whether it was too large — and should reach no code that
  // could touch the provider.
  if (!claudeEnabled()) {
    return fail(503, "analysis_disabled", "AI analysis is temporarily unavailable.");
  }

  // Reject oversized bodies up front (when the client declares a length).
  const declaredLength = Number(req.headers["content-length"] ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    return fail(413, "payload_too_large", "The request body is too large.");
  }

  const parsed = parseReviewRequest(req.body);
  if (!Array.isArray(parsed)) {
    return fail(400, "invalid_request", parsed.invalid, { reviewCount: 0 });
  }
  const reviews = parsed;
  if (reviews.length > MAX_ROWS_PER_BATCH_REQUEST) {
    return fail(
      413,
      "too_many_reviews",
      // Deliberately phrased as a client-contract violation, not analyst
      // guidance: this endpoint takes one batch, and a caller that overshoots
      // is a broken orchestrator, not a user who selected too much.
      `A batch may contain at most ${MAX_ROWS_PER_BATCH_REQUEST} rows.`,
      { reviewCount: reviews.length },
    );
  }
  const inputTextBytes = reviews.reduce((sum, r) => sum + Buffer.byteLength(r.text, "utf8"), 0);
  if (inputTextBytes > MAX_TOTAL_REVIEW_TEXT_BYTES) {
    return fail(413, "payload_too_large", "The selected reviews contain too much text to analyze at once.", {
      reviewCount: reviews.length,
      inputTextBytes,
    });
  }

  // Every later log line carries the request's shape, so usage can be estimated
  // from logs alone without any review text ever being written.
  const shape: Partial<LogFields> = { reviewCount: reviews.length, inputTextBytes, model: MODEL };

  if (!process.env.ANTHROPIC_API_KEY) {
    // Enabled but unconfigured. Distinct from `analysis_disabled` on purpose:
    // one is a decision, the other is a mistake, and an operator reading logs
    // needs to tell them apart.
    return fail(500, "server_misconfigured", "The analysis service is not configured.", shape);
  }

  const client = new Anthropic({ maxRetries: 0 }); // no automatic retries
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

  try {
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(reviews) }],
      },
      { signal: controller.signal },
    );
    const message = await stream.finalMessage();
    const stopReason = message.stop_reason ?? null;

    if (stopReason === "refusal") {
      return fail(502, "analysis_failed", "The analysis engine could not process this request.", {
        ...shape,
        stopReason,
      });
    }
    if (stopReason === "max_tokens") {
      // A distinct code, used for truncation and nothing else. The orchestrator
      // needs to tell "the model was cut off mid-answer" from "the model
      // refused" or "the output was unreadable": only the first is worth
      // retrying, and only by shrinking the batch. Collapsing them into
      // analysis_failed would make that retry a guess.
      return fail(
        502,
        "output_truncated",
        "There were too many reviews to analyze at once. Analyze a smaller selection.",
        { ...shape, stopReason },
      );
    }

    const rawText = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Server-side gate: parse + validate; only a validated payload leaves here.
    const reviewsById = new Map(reviews.map((r) => [r.id, r.text] as const));
    let outcome;
    try {
      outcome = validateModelResponse(rawText, reviewsById);
    } catch {
      // Syntactically invalid JSON → the entire response is unusable.
      return fail(502, "analysis_failed", "The analysis engine returned an unreadable result.", {
        ...shape,
        stopReason,
      });
    }

    // All-rejected gate: the model returned tags but NONE survived validation
    // (fabricated review ids, non-verbatim evidence, bad sentiment). That is a
    // provider-response failure, not a "no themes" result — surface a controlled
    // error rather than an apparently-successful empty payload. A genuinely
    // empty array (rejected === 0) is left to produce an empty result.
    if (outcome.valid.length === 0 && outcome.rejected > 0) {
      return fail(502, "analysis_failed", "The analysis engine returned no usable results. Please try again.", {
        ...shape,
        stopReason,
        accepted: 0,
        rejected: outcome.rejected,
        deduped: outcome.deduped,
      });
    }

    log({
      requestId,
      caller,
      status: 200,
      code: "ok",
      ms: Date.now() - startedAt,
      ...shape,
      stopReason,
      accepted: outcome.valid.length,
      rejected: outcome.rejected,
      deduped: outcome.deduped,
      inputTokens: message.usage?.input_tokens,
      outputTokens: message.usage?.output_tokens,
    });
    res.status(200).json({ tags: outcome.valid.map(toRawTag) });
  } catch (err) {
    const { status, code, message, note } = classifyProviderError(err, controller.signal.aborted);
    return fail(status, code, message, { ...shape, providerNote: note });
  } finally {
    clearTimeout(timer);
  }
}

// --- error classification ---------------------------------------------------

interface ClassifiedError {
  status: number;
  code: string;
  /** Shown to the browser. Never carries a provider body, stack, or key state. */
  message: string;
  /** Logged only. Lets an operator tell these apart without telling the caller. */
  note: string;
}

/**
 * Map a provider failure to a controlled response.
 *
 * Two rules shape this. First, the browser learns only what it can act on — it
 * never sees the provider's error body, our key state, or which upstream
 * condition fired. Second, the log keeps the distinction the caller does not
 * get, because "the demo is out of credit" and "the key is wrong" need
 * different fixes and the operator is the one who has to choose.
 *
 * Billing is reported as unavailability, not as a diagnosis. `billing_error` is
 * a documented provider error type, so it is safe to record it — but a 403 can
 * also be a permissions problem, so nothing user-facing claims to know why.
 */
function classifyProviderError(err: unknown, aborted: boolean): ClassifiedError {
  if (aborted || (err instanceof Error && err.name === "AbortError")) {
    return {
      status: 504,
      code: "analysis_timeout",
      message: "The analysis timed out. Analyze a smaller selection and try again.",
      note: "timeout",
    };
  }

  // APIConnectionError extends APIError in this SDK, so it must be checked first.
  if (err instanceof Anthropic.APIConnectionError) {
    return {
      status: 502,
      code: "provider_unavailable",
      message: "The analysis service is unavailable right now. Please try again.",
      note: "connection",
    };
  }

  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const type = typeof err.type === "string" ? err.type : "";

    if (status === 429) {
      return {
        status: 429,
        code: "analysis_busy",
        message: "The analysis service is busy right now. Please try again in a moment.",
        note: "rate_limited",
      };
    }
    if (status === 403 && type === "billing_error") {
      return {
        status: 502,
        code: "provider_unavailable",
        message: "The analysis service is unavailable right now. Please try again.",
        note: "billing",
      };
    }
    if (status === 401 || status === 403) {
      return {
        status: 500,
        code: "server_misconfigured",
        message: "The analysis service is not configured.",
        note: "provider_auth",
      };
    }
    if (status === 404) {
      return {
        status: 500,
        code: "server_misconfigured",
        message: "The analysis service is not configured.",
        note: "model_not_found",
      };
    }
    if (status >= 500) {
      return {
        status: 502,
        code: "provider_unavailable",
        message: "The analysis service is unavailable right now. Please try again.",
        note: status === 529 ? "overloaded" : "provider_5xx",
      };
    }
    return {
      status: 502,
      code: "analysis_failed",
      message: "The analysis service could not complete this request. Please try again.",
      note: `provider_${status || "error"}`,
    };
  }

  return {
    status: 502,
    code: "analysis_failed",
    message: "The analysis service is unavailable right now. Please try again.",
    note: "unknown",
  };
}

// --- helpers ----------------------------------------------------------------

function sendError(res: VercelResponse, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/**
 * An opaque per-caller marker for log correlation. Operational only.
 *
 * What it is FOR: telling two callers apart while reading usage out of logs, so
 * a spike can be attributed to one source rather than to traffic in general.
 *
 * What it is NOT, and must never be used as:
 *  - **not authentication or authorization.** Nothing is granted or denied on
 *    the strength of this value. Access control is Vercel's deployment
 *    protection, at the edge, before this function runs.
 *  - **not a durable identity.** It is derived from a request header a client
 *    controls the upstream of, changes when the caller's network changes, and
 *    changes for everyone whenever `LOG_SALT` is rotated. It is stable enough to
 *    group requests within a logging window and nothing more.
 *  - **not a quota key.** There is deliberately no per-caller quota; treating
 *    this as one would be trivially evaded.
 *
 * Salted deliberately: a bare SHA-256 of an IP address is reversible by
 * enumerating the address space, so an unsalted hash would be personal data
 * wearing a disguise. With no `LOG_SALT` configured the field is omitted
 * entirely rather than downgraded — a missing field is honest, a weak one is not.
 */
function callerHash(req: VercelRequest): string | undefined {
  const salt = process.env.LOG_SALT;
  if (!salt) return undefined;
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  if (!first) return undefined;
  return createHash("sha256").update(salt).update(first).digest("hex").slice(0, 12);
}

interface LogFields {
  requestId: string;
  caller?: string;
  status: number;
  code: string;
  ms: number;
  reviewCount?: number;
  inputTextBytes?: number;
  model?: string;
  stopReason?: string | null;
  accepted?: number;
  rejected?: number;
  deduped?: number;
  inputTokens?: number;
  outputTokens?: number;
  providerNote?: string;
}

/**
 * Sanitized structured log — one JSON line per request.
 *
 * Carries enough to estimate usage and spot abuse without a dashboard: who
 * (hashed), how much (rows, bytes, tokens), which model, what happened, how
 * long. It carries no review text, no evidence spans, no prompt, no provider
 * output and no key material, and there is no code path that could add one —
 * every field is a number, an enum-like string, or a hash.
 */
function log(fields: LogFields): void {
  console.log(JSON.stringify({ at: "api/analyze", ts: new Date().toISOString(), ...fields }));
}
