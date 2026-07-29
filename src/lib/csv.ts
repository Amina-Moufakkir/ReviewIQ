/**
 * Named-column access to a parsed CSV, built once from its header row. Both the
 * loader and the Amazon adapter read cells by column name, so they share this
 * rather than each rebuilding a name→position map and its own cell accessor.
 */
export interface CsvColumns {
  /** Whether the header carried this column at all. */
  has(name: string): boolean;
  /** Trimmed cell value. "" when the cell is blank or the column is absent. */
  cell(row: string[], name: string): string;
  /** Which of `required` the header does not carry, in the given order. */
  missing(required: readonly string[]): string[];
}

/** Index a header row (names are trimmed) for lookup by column name. */
export function readColumns(header: string[]): CsvColumns {
  const position: Record<string, number> = {};
  header.forEach((name, i) => {
    position[name.trim()] = i;
  });

  const has = (name: string) => name in position;
  return {
    has,
    cell: (row, name) => (has(name) ? (row[position[name]!] ?? "").trim() : ""),
    missing: (required) => required.filter((name) => !has(name)),
  };
}

/**
 * Minimal RFC4180 CSV parser: handles quoted fields, escaped double quotes
 * ("" inside a quoted field), and commas/newlines inside quotes. Returns a
 * matrix of string cells. Blank lines are skipped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    // Skip fully blank rows (a single empty cell from a trailing newline).
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
  // Flush the final field/row if the file did not end with a newline.
  if (field !== "" || row.length > 0) pushRow();

  return rows;
}
