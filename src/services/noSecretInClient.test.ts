import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardrail: nothing under src/ (the client bundle's source) may reference the
 * API secret or import the Anthropic SDK. Those belong only to the server
 * function in api/, which Vite never bundles. This keeps the key and the SDK
 * out of the browser.
 */
function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

describe("client bundle secret hygiene", () => {
  const srcFiles = walk(join(process.cwd(), "src")).filter((f) => !f.endsWith(".test.ts"));

  it("never references ANTHROPIC_API_KEY in client source", () => {
    const offenders = srcFiles.filter((f) => readFileSync(f, "utf8").includes("ANTHROPIC_API_KEY"));
    expect(offenders, `Found ANTHROPIC_API_KEY in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("never imports the Anthropic SDK in client source", () => {
    const offenders = srcFiles.filter((f) => readFileSync(f, "utf8").includes("@anthropic-ai/sdk"));
    expect(offenders, `Found @anthropic-ai/sdk import in: ${offenders.join(", ")}`).toEqual([]);
  });
});
