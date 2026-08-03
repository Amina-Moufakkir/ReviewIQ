import { createHash, randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import {
  MAX_CANONICALIZATION_BODY_BYTES,
  parseCanonicalizeRequest,
  validateGrouping,
} from "../src/services/canonicalize.js";
import { stripCodeFence } from "../src/services/claudeTags.js";
import {
  CANONICALIZE_SYSTEM_PROMPT,
  buildCanonicalizeContent,
  MAX_OUTPUT_TOKENS,
  CLAUDE_TIMEOUT_MS,
} from "../server/claudePrompt.js";

export const config = { maxDuration: 60 };

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

/**
 * The same fail-closed kill switch as `/api/analyze`, for the same reason: this
 * is a second paid endpoint, and every way of getting the variable wrong should
 * land on "disabled" rather than "spending".
 *
 * Read per request rather than at module load — but NOT because that makes a
 * dashboard change take effect sooner. On Vercel the environment is fixed for
 * the life of a deployment: `process.env` cannot change under a running
 * function, and editing the variable has no effect on any request until the
 * project is redeployed. Reading it here buys deterministic behavior in tests
 * and under `vercel dev`, where the process environment genuinely can differ
 * between calls.
 */
function claudeEnabled(): boolean {
  return process.env.CLAUDE_ENABLED === "true";
}

/**
 * Group theme labels that name the same theme.
 *
 * The second Claude surface, and deliberately the narrower one. It receives
 * **labels only** — short strings the tagging pass already produced — and never
 * review text, evidence spans, counts, or quotes. That is a property of the
 * contract rather than a convention: the body has no field for text, and a
 * label long enough to hide a review body is rejected outright.
 *
 * It returns index groups. Only a grouping that partitions the given labels
 * exactly leaves this handler, so a caller can never receive a mapping that
 * silently loses or invents a theme.
 */
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

  if (!claudeEnabled()) {
    return fail(503, "analysis_disabled", "AI analysis is temporarily unavailable.");
  }

  // A cheap early reject on the caller's own claim. It is not the size limit —
  // Content-Length can be absent or simply untrue, so the authoritative check
  // runs against the parsed body below and this only saves work when the header
  // happens to be honest.
  const declaredLength = Number(req.headers["content-length"] ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CANONICALIZATION_BODY_BYTES) {
    return fail(413, "payload_too_large", "The request body is too large.");
  }

  const parsed = parseCanonicalizeRequest(req.body);
  if (!parsed.ok) {
    return parsed.reason === "payload_too_large"
      ? fail(413, "payload_too_large", "The request body is too large.", { labelCount: 0 })
      : fail(400, "invalid_request", parsed.message, { labelCount: 0 });
  }
  const labels = parsed.labels;
  const shape: Partial<LogFields> = { labelCount: labels.length, model: MODEL };

  if (!process.env.ANTHROPIC_API_KEY) {
    return fail(500, "server_misconfigured", "The analysis service is not configured.", shape);
  }

  const client = new Anthropic({ maxRetries: 0 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

  try {
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: CANONICALIZE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildCanonicalizeContent(labels) }],
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
      return fail(502, "output_truncated", "There were too many themes to group at once.", {
        ...shape,
        stopReason,
      });
    }

    const rawText = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    let groups: unknown;
    try {
      groups = (JSON.parse(stripCodeFence(rawText)) as { groups?: unknown }).groups;
    } catch {
      return fail(502, "analysis_failed", "The analysis engine returned an unreadable result.", {
        ...shape,
        stopReason,
      });
    }

    // Server-side gate. A grouping that is not an exact partition of the given
    // labels would silently drop or duplicate a theme downstream, so nothing
    // but a valid one leaves here.
    const problem = validateGrouping(groups, labels.length);
    if (problem) {
      return fail(502, "invalid_grouping", "The analysis engine returned an unusable grouping.", {
        ...shape,
        stopReason,
        groupingProblem: problem,
      });
    }

    const validGroups = groups as number[][];
    log({
      requestId,
      caller,
      status: 200,
      code: "ok",
      ms: Date.now() - startedAt,
      ...shape,
      stopReason,
      groupCount: validGroups.length,
      inputTokens: message.usage?.input_tokens,
      outputTokens: message.usage?.output_tokens,
    });
    res.status(200).json({ groups: validGroups });
  } catch (err) {
    const { status, code, message, note } = classifyProviderError(err, controller.signal.aborted);
    return fail(status, code, message, { ...shape, providerNote: note });
  } finally {
    clearTimeout(timer);
  }
}

// --- shared with api/analyze.ts in behaviour, kept local by design -----------
//
// The two endpoints deliberately do not share a runtime module: Vercel makes
// every file under api/ a public route, so a shared helper would either become
// an endpoint or have to live outside api/ for the sake of two small functions.
// The duplication is a few lines and is covered by both test suites.

interface ClassifiedError {
  status: number;
  code: string;
  message: string;
  note: string;
}

function classifyProviderError(err: unknown, aborted: boolean): ClassifiedError {
  if (aborted || (err instanceof Error && err.name === "AbortError")) {
    return {
      status: 504,
      code: "analysis_timeout",
      message: "Grouping themes timed out. Please try again.",
      note: "timeout",
    };
  }
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
    if (status === 401 || status === 403 || status === 404) {
      return {
        status: 500,
        code: "server_misconfigured",
        message: "The analysis service is not configured.",
        note: status === 404 ? "model_not_found" : "provider_auth",
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

function sendError(res: VercelResponse, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

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
  labelCount?: number;
  groupCount?: number;
  model?: string;
  stopReason?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  providerNote?: string;
  groupingProblem?: string;
}

/**
 * Sanitized structured log. Counts only — never the labels themselves.
 *
 * Labels are not review text, but they are derived from it and a distinctive
 * one could identify a product or a complaint. Nothing here needs their
 * content, so nothing here records it.
 */
function log(fields: LogFields): void {
  console.log(JSON.stringify({ at: "api/canonicalize", ts: new Date().toISOString(), ...fields }));
}
