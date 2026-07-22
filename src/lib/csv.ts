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
