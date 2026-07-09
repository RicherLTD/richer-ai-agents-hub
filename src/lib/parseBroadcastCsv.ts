export interface ParsedCsvRecipient {
  phone: string;
  name: string;
  variables: string[];
}

export interface ParseCsvResult {
  rows: ParsedCsvRecipient[];
  errors: string[];
}

const HEADER_TOKENS = new Set(["phone", "טלפון", "tel", "mobile", "נייד"]);

function splitLine(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}

/**
 * Pure client-side CSV parse. Columns: phone, name, then any number of variable
 * columns. Header row is auto-detected (first cell is a known header token).
 * A row with an empty first cell is reported as an error and skipped. This does
 * NOT validate phone format — the server canonicalizes and reports invalids.
 */
export function parseBroadcastCsv(text: string): ParseCsvResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const rows: ParsedCsvRecipient[] = [];
  const errors: string[] = [];
  if (lines.length === 0) return { rows, errors };

  let start = 0;
  const firstCells = splitLine(lines[0]);
  if (firstCells.length > 0 && HEADER_TOKENS.has(firstCells[0].toLowerCase())) {
    start = 1;
  }

  for (let i = start; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const phone = cells[0] ?? "";
    if (!phone) {
      errors.push(`שורה ${i + 1}: חסר מספר טלפון`);
      continue;
    }
    rows.push({ phone, name: cells[1] ?? "", variables: cells.slice(2) });
  }
  return { rows, errors };
}
