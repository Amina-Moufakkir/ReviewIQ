import { randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
// Explicit .js extension: the deployed function runs as native ESM (the repo is
// "type": "module"), where extensionless relative imports do not resolve. This
// is the function's only runtime relative import — claudeTags' own `import type`
// of ../types is erased at compile time.
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_REVIEWS_PER_REQUEST,
  MAX_TOTAL_REVIEW_TEXT_BYTES,
  parseReviewRequest,
  toRawTag,
  validateModelResponse,
} from "../src/services/claudeTags.js";
// The prompt lives in its own server-only module so the local benchmark
// (scripts/bench-models.ts) can measure exactly what this handler sends,
// without importing the HTTP layer. See api/claudePrompt.ts.
import {
  SYSTEM_PROMPT,
  buildUserContent,
  MAX_OUTPUT_TOKENS,
  CLAUDE_TIMEOUT_MS,
} from "./claudePrompt.js";

// Allow up to the Claude call's own 30s timeout plus response overhead.
export const config = { maxDuration: 60 };

/** Model is overridable via env; defaults to the current Opus per Anthropic guidance. */
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const requestId = randomUUID();
  const startedAt = Date.now();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "method_not_allowed", "Only POST is supported.");
  }

  // Reject oversized bodies up front (when the client declares a length).
  const declaredLength = Number(req.headers["content-length"] ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    return sendError(res, 413, "payload_too_large", "The request body is too large.");
  }

  const parsed = parseReviewRequest(req.body);
  if (!Array.isArray(parsed)) {
    log(requestId, 0, 400, startedAt, `invalid_request ${parsed.invalid}`);
    return sendError(res, 400, "invalid_request", parsed.invalid);
  }
  const reviews = parsed;
  if (reviews.length > MAX_REVIEWS_PER_REQUEST) {
    return sendError(res, 413, "too_many_reviews", `At most ${MAX_REVIEWS_PER_REQUEST} reviews can be analyzed at once.`);
  }
  const totalTextBytes = reviews.reduce((sum, r) => sum + Buffer.byteLength(r.text, "utf8"), 0);
  if (totalTextBytes > MAX_TOTAL_REVIEW_TEXT_BYTES) {
    return sendError(res, 413, "payload_too_large", "The selected reviews contain too much text to analyze at once.");
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    // Sanitized — never reveals whether/why the key is missing beyond this.
    log(requestId, reviews.length, 500, startedAt, "missing_api_key");
    return sendError(res, 500, "server_misconfigured", "The analysis service is not configured.");
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

    if (message.stop_reason === "refusal") {
      log(requestId, reviews.length, 502, startedAt, "model_refusal");
      return sendError(res, 502, "analysis_failed", "The analysis engine could not process this request.");
    }
    if (message.stop_reason === "max_tokens") {
      log(requestId, reviews.length, 502, startedAt, "output_truncated");
      return sendError(res, 502, "analysis_failed", "There were too many reviews to analyze at once. Narrow the date range and try again.");
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
      log(requestId, reviews.length, 502, startedAt, "unparseable_model_output");
      return sendError(res, 502, "analysis_failed", "The analysis engine returned an unreadable result.");
    }

    // All-rejected gate: the model returned tags but NONE survived validation
    // (fabricated review ids, non-verbatim evidence, bad sentiment). That is a
    // provider-response failure, not a "no themes" result — surface a controlled
    // error rather than an apparently-successful empty payload. A genuinely
    // empty array (rejected === 0) is left to produce an empty result.
    if (outcome.valid.length === 0 && outcome.rejected > 0) {
      log(requestId, reviews.length, 502, startedAt, `all_rejected rejected=${outcome.rejected}`);
      return sendError(res, 502, "analysis_failed", "The analysis engine returned no usable results. Please try again.");
    }

    log(requestId, reviews.length, 200, startedAt, `ok valid=${outcome.valid.length} rejected=${outcome.rejected} deduped=${outcome.deduped}`);
    res.status(200).json({ tags: outcome.valid.map(toRawTag) });
  } catch (err) {
    // Provider failure, timeout, aborted request, or network error — never leak
    // the provider's error body, stack, or API details to the browser.
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    if (aborted) {
      log(requestId, reviews.length, 504, startedAt, "claude_timeout");
      return sendError(res, 504, "analysis_timeout", "The analysis timed out. Try a narrower date range.");
    }
    log(requestId, reviews.length, 502, startedAt, "claude_error");
    return sendError(res, 502, "analysis_failed", "The analysis service is unavailable right now. Please try again.");
  } finally {
    clearTimeout(timer);
  }
}

// --- helpers ----------------------------------------------------------------

function sendError(res: VercelResponse, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Sanitized structured log — no API key, no review text. */
function log(requestId: string, reviewCount: number, status: number, startedAt: number, note: string): void {
  console.log(
    JSON.stringify({
      at: "api/analyze",
      requestId,
      reviewCount,
      status,
      ms: Date.now() - startedAt,
      note,
    }),
  );
}
