/**
 * Fail the build if the shipped client bundle carries a secret.
 *
 * The unit guardrail in src/services/noSecretInClient.test.ts checks the
 * SOURCE. This checks the ARTIFACT — what a browser actually downloads — which
 * is the claim the deployment runbook needs to make. They can diverge: a
 * `VITE_`-prefixed variable is inlined at build time and appears in dist/
 * without appearing literally in any source file.
 *
 * Run after `npm run build`. Exits non-zero on the first offender.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";

const FORBIDDEN = [
  { name: "Anthropic key literal", re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: "ANTHROPIC_API_KEY reference", re: /ANTHROPIC_API_KEY/ },
  { name: "Anthropic SDK bundled into the client", re: /@anthropic-ai\/sdk/ },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error(`verify:bundle — ${DIST}/ not found. Run \`npm run build\` first.`);
  process.exit(1);
}

const files = walk(DIST).filter((f) => /\.(js|mjs|cjs|css|html|json|map)$/.test(f));
if (files.length === 0) {
  console.error(`verify:bundle — no build output found under ${DIST}/. Refusing to pass vacuously.`);
  process.exit(1);
}

const offenders = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const { name, re } of FORBIDDEN) {
    if (re.test(text)) offenders.push(`${file}: ${name}`);
  }
}

if (offenders.length > 0) {
  console.error("verify:bundle FAILED — the client bundle contains:");
  for (const o of offenders) console.error(`  - ${o}`);
  process.exit(1);
}

console.log(`verify:bundle OK — scanned ${files.length} files in ${DIST}/, no secrets found.`);
