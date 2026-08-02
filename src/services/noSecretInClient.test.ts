import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardrail: nothing under src/ (the client bundle's source) may reference the
 * API secret, import the Anthropic SDK, or carry a key-shaped literal. Those
 * belong only to the server function in api/, which Vite never bundles.
 *
 * This checks the SOURCE. The built bundle is checked separately by
 * `npm run verify:bundle`, which CI runs after the build — source hygiene and
 * shipped-artifact hygiene are different claims, and only the second one
 * describes what a browser actually receives.
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
  // Test files are excluded deliberately and now consistently across both
  // extensions: they legitimately contain key-SHAPED strings as fixtures — a
  // test asserting "we never log sk-ant-" has to name the pattern to check it.
  const srcFiles = walk(join(process.cwd(), "src")).filter(
    (f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
  );

  it("scans a non-trivial number of files, so a broken walk cannot pass silently", () => {
    expect(srcFiles.length).toBeGreaterThan(20);
  });

  it("never references ANTHROPIC_API_KEY in client source", () => {
    const offenders = srcFiles.filter((f) => readFileSync(f, "utf8").includes("ANTHROPIC_API_KEY"));
    expect(offenders, `Found ANTHROPIC_API_KEY in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("never imports the Anthropic SDK in client source", () => {
    const offenders = srcFiles.filter((f) => readFileSync(f, "utf8").includes("@anthropic-ai/sdk"));
    expect(offenders, `Found @anthropic-ai/sdk import in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("never contains an Anthropic-key-shaped literal", () => {
    const offenders = srcFiles.filter((f) => /sk-ant-/.test(readFileSync(f, "utf8")));
    expect(offenders, `Found a key-shaped literal in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("never reads a VITE_-prefixed variable whose name implies a secret", () => {
    // VITE_ variables are inlined into the bundle by Vite, so a secret behind
    // that prefix is a published secret. The engine NAME is fine; a key is not.
    const secretish = /\bimport\.meta\.env\.VITE_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/;
    const offenders = srcFiles.filter((f) => secretish.test(readFileSync(f, "utf8")));
    expect(offenders, `Found a VITE_-prefixed secret in: ${offenders.join(", ")}`).toEqual([]);
  });
});
