import type { Dispatch, DispatchResponse } from "./batchExecutor";
import { CanonicalizationError, type CanonicalizeDispatch, type GroupingOutcome } from "./canonicalize";

/**
 * Transport adapters for the two server functions.
 *
 * These translate shapes and nothing else: request object in, HTTP out, HTTP
 * back, result object in. They make no decisions about retrying, sizing,
 * grouping, counting, or what the analyst is told — those belong to the
 * executor, the canonicalizer, and the pipeline respectively. Keeping the
 * translation this thin is what lets every one of those be tested offline.
 *
 * Both are injectable so the pipeline can be exercised without a network.
 */

/** Minimal fetch shape, so tests can substitute one without a DOM. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A transport failure carrying the endpoint's own error code.
 *
 * It extends `CanonicalizationError` deliberately. `chooseCause` passes a
 * `CanonicalizationError` through untouched and rewrites anything else to a
 * bare `provider` failure, which would discard the code — and the code is what
 * separates "the service is switched off" from "the service is busy", two
 * things an analyst would act on differently.
 */
export class CanonicalizeTransportError extends CanonicalizationError {
  constructor(readonly code: string) {
    super("provider", `The grouping request failed with "${code}".`);
    this.name = "CanonicalizeTransportError";
  }
}

/**
 * Read the endpoint's controlled error code from a non-2xx response.
 *
 * The body is preferred because the function knows more than the status does.
 * The status fallbacks matter when there is no such body to read: 401/403 come
 * from Vercel's deployment protection at the edge, before the function runs at
 * all, so the response is the platform's sign-in page rather than our JSON.
 */
async function codeForResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    const code = body?.error?.code;
    if (typeof code === "string" && code) return code;
  } catch {
    // fall through to the status-based mapping
  }
  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (response.status === 503) return "analysis_disabled";
  if (response.status === 429) return "analysis_busy";
  if (response.status === 504) return "analysis_timeout";
  if (response.status === 413) return "payload_too_large";
  if (response.status >= 500) return "provider_unavailable";
  return "invalid_request";
}

/**
 * Dispatch one batch to `/api/analyze`.
 *
 * Returns `{ ok: false, code }` for a controlled endpoint failure rather than
 * throwing, because the code is what the executor classifies on — whether to
 * retry smaller, retry unchanged, or stop. A `fetch` rejection is deliberately
 * left to propagate: the executor already distinguishes an abort from a network
 * failure there, and duplicating that judgement here would let the two diverge.
 *
 * `runId` is echoed straight back. The executor treats a mismatch as a protocol
 * violation; the endpoint has no concept of a run, so the adapter's only job is
 * to return the id faithfully rather than to invent one.
 */
export function createAnalyzeDispatch(fetchImpl: FetchLike): Dispatch {
  return async (request, signal): Promise<DispatchResponse> => {
    const startedAt = Date.now();
    const response = await fetchImpl("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Text only, and no subject id: the endpoint reads `reviews` and nothing
      // else, and sentiment on this path comes from the body, not the rating.
      body: JSON.stringify({
        reviews: request.rows.map((row) => ({ id: row.id, text: row.text })),
      }),
      signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return { runId: request.runId, ok: false, code: await codeForResponse(response), latencyMs };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { runId: request.runId, ok: false, code: "invalid_response", latencyMs };
    }

    const tags = (payload as { tags?: unknown })?.tags;
    if (!Array.isArray(tags)) {
      return { runId: request.runId, ok: false, code: "invalid_response", latencyMs };
    }

    // Optional by contract: the provider may omit usage, and a fabricated number
    // would corrupt the planner's density estimate more quietly than a missing
    // one, which the executor already treats as zero.
    const usage = (payload as { usage?: { inputTokens?: unknown; outputTokens?: unknown } })?.usage;
    return {
      runId: request.runId,
      ok: true,
      latencyMs,
      tags,
      inputTokens: numberOrUndefined(usage?.inputTokens),
      outputTokens: numberOrUndefined(usage?.outputTokens),
    };
  };
}

/**
 * Dispatch one label set to `/api/canonicalize`.
 *
 * Rejects rather than returning a failure shape, because canonicalization has
 * no retry ladder to classify on: a level is all-or-nothing, and a rejection is
 * what aborts the sibling chunks.
 */
export function createCanonicalizeDispatch(fetchImpl: FetchLike): CanonicalizeDispatch {
  return async (labels, signal): Promise<GroupingOutcome> => {
    const response = await fetchImpl("/api/canonicalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels }),
      signal,
    });

    if (!response.ok) {
      throw new CanonicalizeTransportError(await codeForResponse(response));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CanonicalizeTransportError("invalid_response");
    }

    // Shape only. Whether the grouping is a valid partition is decided by
    // `validateGrouping`, which the canonicalizer applies to every chunk — the
    // adapter must not pre-judge it or the second gate stops being a gate.
    const groups = (payload as { groups?: unknown })?.groups;
    if (!Array.isArray(groups)) {
      throw new CanonicalizeTransportError("invalid_response");
    }
    return { groups: groups as number[][] };
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
