/**
 * The prompt ReviewIQ sends to Claude — the single source of truth.
 *
 * Server-only: this module is imported by the serverless handler
 * (api/analyze.ts) and by the local model benchmark
 * (scripts/bench-models.ts). It is never bundled into the client.
 *
 * It lives in server/ rather than api/ deliberately. Vercel publishes every
 * file under api/ as a route, so a shared module placed there becomes a public
 * endpoint that 500s on every request — reachable, invocation-consuming, and
 * serving no purpose. Only request handlers belong in api/.
 *
 * It lives apart from the handler so the benchmark can measure the prompt the
 * endpoint actually ships without importing the HTTP layer. A benchmark that
 * copied this text would silently drift from production and would then be
 * measuring something the deployment does not send.
 *
 * The only import is `import type`, which is erased at compile time — so this
 * file has no runtime dependencies and loads identically under Vercel's native
 * ESM build and Node's TypeScript type stripping.
 */
import type { IncomingReview } from "../src/services/claudeTags.js";

/**
 * Generation parameters, alongside the prompt, because the benchmark has to
 * mirror them exactly — output length and the timeout decide whether a model is
 * usable here at all, not just how good its tags are.
 */
/** Fixed output ceiling. Over this the model is truncated and the endpoint 502s. */
export const MAX_OUTPUT_TOKENS = 16000;
/** Hard wall on the Claude call, well inside the function's own maxDuration. */
export const CLAUDE_TIMEOUT_MS = 30_000;

export const SYSTEM_PROMPT = `You are a semantic tagging layer for customer product reviews. You identify themes and assign sentiment; you do NOT write reports or summaries.

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

/**
 * The user turn: reviews as JSON, TEXT ONLY.
 *
 * Star ratings are deliberately absent. This path exists for data whose rating
 * is a product-AVERAGE over thousands of customers, so it describes no single
 * review's text and is evidence about no particular theme. Withholding it makes
 * "sentiment comes from the text" a property of the input rather than a rule
 * the prompt has to ask the model to respect.
 */
export function buildUserContent(reviews: IncomingReview[]): string {
  const payload = reviews.map((r) => ({ review_id: r.id, text: r.text }));
  return `Reviews to tag:\n${JSON.stringify(payload)}`;
}
