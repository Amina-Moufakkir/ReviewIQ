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
  type IncomingReview,
} from "../src/services/claudeTags.js";

// Allow up to the Claude call's own 30s timeout plus response overhead.
export const config = { maxDuration: 60 };

/** Model is overridable via env; defaults to the current Opus per Anthropic guidance. */
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
const MAX_OUTPUT_TOKENS = 16000;
const CLAUDE_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = `You are a semantic tagging layer for customer product reviews. You identify themes and assign sentiment; you do NOT write reports or summaries.

For the batch of reviews given, produce tags. Rules:
- Identify specific product themes from the actual language customers use.
- Cluster semantically equivalent descriptions under ONE concise, human-readable canonical theme label, and use that SAME label consistently across the entire batch (e.g. "died after a week", "won't hold a charge", and "battery's useless" all map to one battery-life theme).
- Assign sentiment to each theme MENTION independently, from the review text: "praise", "fault", or "neutral". Sentiment belongs to the mention, not to the review as a whole — one review may praise one theme and fault another.
- You are given review TEXT only — there are no star ratings in this input. Sentiment must come from the words themselves, and you must NEVER create a theme the text does not support.
- Do not invent themes with no supporting text. Avoid vague labels like "quality", "positive", "negative", "product", or "general experience".
- "evidence_span" MUST be an exact substring copied verbatim from that review's text (same casing and punctuation).
- A single review may produce multiple tags.

Output STRICT JSON only — a single array, no prose, no markdown code fences. Each element:
{"review_id": string, "theme": string, "sentiment": "praise" | "fault" | "neutral", "evidence_span": string}
Output ONLY the JSON array.`;

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

/**
 * The user turn: reviews as JSON, TEXT ONLY.
 *
 * Star ratings are deliberately absent. This path exists for data whose rating
 * is a product-AVERAGE over thousands of customers, so it describes no single
 * review's text and is evidence about no particular theme. Withholding it makes
 * "sentiment comes from the text" a property of the input rather than a rule
 * the prompt has to ask the model to respect.
 */
function buildUserContent(reviews: IncomingReview[]): string {
  const payload = reviews.map((r) => ({ review_id: r.id, text: r.text }));
  return `Reviews to tag:\n${JSON.stringify(payload)}`;
}

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
