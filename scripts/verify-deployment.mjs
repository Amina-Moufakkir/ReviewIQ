/**
 * Inspect the DEPLOYMENT artifact — what Vercel will actually publish.
 *
 * This is a different claim from `verify:bundle`, which scans `dist/`, the
 * client bundle. Two things live only here:
 *
 *  - **Serverless functions.** Vercel turns every file under `api/` into a
 *    public route. A shared module or a test file placed there ships as an
 *    anonymously reachable endpoint. `dist/` cannot show that; `.vercel/output`
 *    can, so this asserts an allowlist of routes.
 *  - **Function-side secrets.** A key inlined into a function bundle never
 *    appears in `dist/`.
 *
 * Failures never print a matched value — only the file, the rule, and a count.
 * A scanner that echoes the secret it found has published it to CI logs.
 *
 * Usage:
 *   node scripts/verify-deployment.mjs            # scan existing .vercel/output
 *   node scripts/verify-deployment.mjs --build    # run `vercel build` first
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const OUTPUT = ".vercel/output";

/** Routes this project is allowed to publish. Anything else fails the check. */
const ALLOWED_FUNCTIONS = new Set(["api/analyze"]);

/**
 * Patterns that must never appear in a deployment artifact. Each carries a
 * label only — the matched text is deliberately never surfaced.
 */
const FORBIDDEN = [
  { label: "Anthropic API key literal", re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { label: "generic provider key literal", re: /\bsk-[A-Za-z0-9]{24,}\b/g },
  { label: "inlined ANTHROPIC_API_KEY value", re: /ANTHROPIC_API_KEY\s*[:=]\s*["'][^"']+["']/g },
];

function fail(lines) {
  console.error("verify:deployment FAILED");
  for (const l of lines) console.error(`  - ${l}`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (process.argv.includes("--build")) {
  console.log("Running `vercel build`…");
  try {
    execFileSync("vercel", ["build", "--yes"], { stdio: ["ignore", "inherit", "inherit"] });
  } catch {
    fail(["`vercel build` did not complete."]);
  }
}

// --- the artifact must exist and be non-trivial -----------------------------

if (!existsSync(OUTPUT)) {
  fail([
    `${OUTPUT} not found. Run \`npm run verify:deployment -- --build\`, or \`vercel build\` first.`,
  ]);
}

const files = walk(OUTPUT);
if (files.length === 0) {
  fail([`${OUTPUT} is empty. Refusing to pass vacuously.`]);
}

// --- published routes must match the allowlist ------------------------------

const funcRoot = join(OUTPUT, "functions");
const published = new Set();
if (existsSync(funcRoot)) {
  for (const f of walk(funcRoot)) {
    const rel = relative(funcRoot, f);
    const marker = rel.indexOf(".func");
    if (marker !== -1) published.add(rel.slice(0, marker).replace(/\\/g, "/"));
  }
}

const unexpected = [...published].filter((r) => !ALLOWED_FUNCTIONS.has(r));
const missing = [...ALLOWED_FUNCTIONS].filter((r) => !published.has(r));

const problems = [];
for (const r of unexpected) {
  problems.push(
    `unexpected published route "/${r}" — every file under api/ becomes a public ` +
      `endpoint; move shared code to server/ and tests to test/`,
  );
}
for (const r of missing) {
  problems.push(`expected route "/${r}" is missing from the build output`);
}

// --- no secrets anywhere in the artifact ------------------------------------

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // unreadable/binary — nothing to match
  }
  for (const { label, re } of FORBIDDEN) {
    const hits = text.match(re);
    if (hits) {
      // Count only. The value is never printed, here or anywhere.
      problems.push(`${relative(process.cwd(), file)}: ${label} (${hits.length} occurrence(s))`);
    }
  }
}

if (problems.length > 0) fail(problems);

// --- a build pulls real env vars to disk; say so ----------------------------

const pulled = existsSync(".vercel")
  ? readdirSync(".vercel").filter((f) => f.startsWith(".env") && f.endsWith(".local"))
  : [];
if (pulled.length > 0) {
  console.warn(
    `\n  note: \`vercel build\` wrote ${pulled.join(", ")} under .vercel/ — these hold real\n` +
      `  environment values pulled from the project. .vercel/ is gitignored, but delete them\n` +
      `  if you do not want the demo key sitting on this machine.`,
  );
}

console.log(
  `verify:deployment OK — ${files.length} files scanned, ` +
    `routes published: ${[...published].map((r) => "/" + r).join(", ") || "(none)"}`,
);
