import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Vercel publishes **every file under `api/` as a public route**. A shared
 * module or a test file placed there does not sit quietly beside the handler —
 * it becomes an anonymously reachable endpoint that 500s on every request,
 * consuming function invocations and shipping code that has no business in
 * production.
 *
 * That happened: `api/claudePrompt.ts` and `api/analyze.test.ts` were both live
 * on the public deployment, the latter carrying vitest and a key-shaped test
 * fixture. Neither leaked anything, but neither should have existed.
 *
 * So the rule is structural, not stylistic: `api/` holds request handlers and
 * nothing else. Shared server code lives in `server/`; tests live in `test/`.
 */
const API_DIR = join(process.cwd(), "api");

function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesIn(full));
    else out.push(full);
  }
  return out;
}

describe("api/ contains only deployable route handlers", () => {
  const files = filesIn(API_DIR);

  it("finds at least one route, so a mis-pointed path cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("contains no test files", () => {
    const offenders = files.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
    expect(offenders, `Test files become public endpoints: ${offenders.join(", ")}`).toEqual([]);
  });

  it("every file exports a default handler", () => {
    // A module without a default export still deploys — it just fails at
    // runtime on every request. That is exactly the shape of the bug this
    // guards, so absence of a default export is the signal to catch.
    const offenders = files.filter((f) => !/export default/.test(readFileSync(f, "utf8")));
    expect(
      offenders,
      `Not a request handler, so it must not live in api/: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("contains no non-TypeScript files", () => {
    const offenders = files.filter((f) => !/\.ts$/.test(f));
    expect(offenders, `Unexpected file in api/: ${offenders.join(", ")}`).toEqual([]);
  });
});
