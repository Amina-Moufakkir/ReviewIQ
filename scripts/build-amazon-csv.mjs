/**
 * Build the shipped Amazon dataset fixture from the raw source CSV.
 *
 *   node scripts/build-amazon-csv.mjs
 *   in:  src/amazon.csv              (raw source, NOT committed — 4.5 MB)
 *   out: public/amazon-products.csv  (shipped fixture, ~2.2 MB)
 *
 * This step is PHYSICAL ONLY — it drops columns and rewrites nothing else. No
 * value is normalized, rounded, reordered, or repaired here; every cell it keeps
 * is copied verbatim. All semantic mapping happens at runtime in
 * src/lib/amazonAdapter.ts, against the Amazon column names preserved below, so
 * there is exactly one place where the data's meaning is decided.
 *
 * Columns are dropped for two reasons:
 *   - `user_id`, `user_name`: comma-joined lists of real reviewer identities
 *     (9,269 distinct ids). ReviewIQ never uses them, and they must not be
 *     published in a committed fixture.
 *   - `about_product`, `img_link`, `product_link`, `review_id`, `review_title`:
 *     unused by ReviewIQ. `about_product` alone is ~2 MB of marketing copy;
 *     `review_id`/`review_title` are comma-joined multi-value cells that do not
 *     align with `review_content` and so cannot be split reliably.
 *
 * Re-run this script to regenerate the fixture — the CSV is never hand-edited.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, "../src/amazon.csv");
const OUTPUT = resolve(here, "../public/amazon-products.csv");

/** Amazon columns kept in the shipped fixture, in this order. */
const KEEP = [
  "product_id",
  "product_name",
  "category",
  "discounted_price",
  "actual_price",
  "discount_percentage",
  "rating",
  "rating_count",
  "review_content",
];

/**
 * RFC4180 parser — a copy of src/lib/csv.ts. Duplicated (rather than imported)
 * only because this is a plain-Node build script and the app source is
 * TypeScript; the two must stay behaviourally identical.
 */
function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // ignore; handled by the following \n
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) pushRow();

  return rows;
}

/** Quote a cell only when it needs it, escaping embedded quotes as "". */
function escapeCell(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const raw = readFileSync(SOURCE, "utf8");
const rows = parseCsv(raw);
if (rows.length < 2) {
  throw new Error(`${SOURCE} has no data rows.`);
}

const header = rows[0].map((h) => h.trim());
const missing = KEEP.filter((c) => !header.includes(c));
if (missing.length > 0) {
  throw new Error(`Source CSV is missing expected column(s): ${missing.join(", ")}`);
}

const indexes = KEEP.map((c) => header.indexOf(c));
const lines = [KEEP.join(",")];
for (const row of rows.slice(1)) {
  lines.push(indexes.map((i) => escapeCell(row[i] ?? "")).join(","));
}
const output = `${lines.join("\n")}\n`;
writeFileSync(OUTPUT, output, "utf8");

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(
  [
    `source records: ${rows.length - 1}`,
    `written records: ${lines.length - 1}`,
    `columns: ${header.length} → ${KEEP.length} (dropped: ${header.filter((h) => !KEEP.includes(h)).join(", ")})`,
    `size: ${mb(Buffer.byteLength(raw, "utf8"))} → ${mb(Buffer.byteLength(output, "utf8"))}`,
    `out: ${OUTPUT}`,
  ].join("\n"),
);
