import type { Dataset } from "../types";
import { parseCsv, readColumns } from "./csv";
import { REQUIRED_SOURCE_COLUMNS, adaptAmazonRows } from "./amazonAdapter";
import {
  CsvError,
  REQUIRED_COLUMNS,
  buildDataset,
  loadStatsFor,
  type LoadStats,
} from "./parseReviews";

/**
 * The ingestion boundary for an uploaded file.
 *
 * ReviewIQ accepts two CSV shapes, and until now the upload control assumed the
 * first: a raw Amazon export was handed to the canonical loader, which rejected
 * it for a missing `review_text` before the Amazon adapter was ever reached.
 * The file was fine; the routing was not.
 *
 * So the header decides. The file is parsed once, its columns are read, and the
 * rows go to whichever existing path recognizes them:
 *
 *   - canonical ReviewIQ columns  → `buildDataset` (the loader an upload always used)
 *   - Amazon source columns       → `adaptAmazonRows` (which then calls that same loader)
 *   - neither                     → a CsvError naming what each shape is missing
 *
 * No parsing, validation or skip-counting is duplicated here: this module only
 * chooses, and both routes converge on the one loader. Detection is by column
 * name only — no sniffing of values, no filename heuristics, nothing that could
 * classify two files with the same header differently.
 */

export interface LoadedCsv {
  dataset: Dataset;
  stats: LoadStats;
}

/**
 * Turn an uploaded file's text into a dataset, choosing the route by header.
 *
 * `label` is what the UI shows as the data source — the file's own name.
 * Throws `CsvError` when the file is empty, matches neither shape, or is
 * rejected by whichever loader claims it.
 */
export function loadUploadedCsv(text: string, label: string): LoadedCsv {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CsvError("The file is empty.");

  const columns = readColumns(rows[0]!);
  const missingCanonical = columns.missing(REQUIRED_COLUMNS);
  const missingAmazon = columns.missing(REQUIRED_SOURCE_COLUMNS);

  // Canonical wins a tie. A file carrying both `review_text` and
  // `review_content` satisfies ReviewIQ's own contract, and reading it as the
  // native format keeps per-row reviews per-row rather than reinterpreting them
  // as product records.
  if (missingCanonical.length === 0) {
    const result = buildDataset(rows, label, "uploaded");
    return { dataset: result.dataset, stats: loadStatsFor(result) };
  }

  if (missingAmazon.length === 0) {
    const { dataset, stats } = adaptAmazonRows(rows, label);
    return { dataset, stats };
  }

  throw new CsvError(
    `This CSV matches neither supported format. As a ReviewIQ review CSV it is missing ` +
      `${missingCanonical.join(", ")}; as an Amazon product export it is missing ` +
      `${missingAmazon.join(", ")}.`,
  );
}
