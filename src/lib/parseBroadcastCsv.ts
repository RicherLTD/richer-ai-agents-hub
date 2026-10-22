import { repairSpreadsheetPhone, toCanonicalPhone } from "./phone";

export interface ParsedCsvRecipient {
  /** Canonical `972…` form — exactly what the server will store. */
  phone: string;
  name: string;
  variables: string[];
}

export interface ParseCsvResult {
  rows: ParsedCsvRecipient[];
  errors: string[];
}

/** Matched as a substring, so "מספר טלפון" / "Phone Number" are recognised too. */
const HEADER_TOKENS = ["phone", "tel", "mobile", "טלפון", "נייד", "מספר"];

/**
 * Delimiters we actually receive. Semicolon matters: Excel writes it instead of
 * a comma whenever the OS list separator is semicolon, which is the default in
 * an Israeli/European locale — a whole file then lands in column 1 and every
 * phone is rejected.
 */
const DELIMITERS = [",", ";", "\t"] as const;

/** Most frequent delimiter outside quoted regions; comma when there is none. */
function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    const seen = counts.get(ch);
    if (seen !== undefined) counts.set(ch, seen + 1);
  }
  let best: string = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = counts.get(d) ?? 0;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Quote-aware split of a single line: `"כהן, דנה"` stays one cell and `""`
 * unescapes to a literal quote. A quoted field containing a newline is NOT
 * supported (we split on lines first) — phone lists don't have those.
 */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Canonical phone for a raw first cell, or null if it isn't a usable number. */
function canonicalize(cell: string): string | null {
  return toCanonicalPhone(repairSpreadsheetPhone(cell));
}

/**
 * Pure client-side CSV parse. Columns: phone, name, then any number of variable
 * columns. Comma / semicolon / tab delimited, quoted or bare, with or without a
 * header row.
 *
 * Unlike the first version, this DOES validate the phone: `rows` only ever
 * contains numbers the server will accept (canonical `972…`), and every rejected
 * line comes back in `errors` naming the line and the offending value. The whole
 * point is that a spreadsheet the server would reject wholesale can no longer
 * look like a successfully loaded recipient list.
 */
export function parseBroadcastCsv(text: string): ParseCsvResult {
  const body = text.replace(/^\uFEFF/, "");
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const rows: ParsedCsvRecipient[] = [];
  const errors: string[] = [];
  if (lines.length === 0) return { rows, errors };

  const delimiter = detectDelimiter(body);
  const firstCell = splitLine(lines[0], delimiter)[0] ?? "";
  const firstIsPhone = canonicalize(firstCell) !== null;
  const looksLikeHeaderText = HEADER_TOKENS.some((t) => firstCell.toLowerCase().includes(t));
  const laterLineIsPhone = lines
    .slice(1)
    .some((l) => canonicalize(splitLine(l, delimiter)[0] ?? "") !== null);
  // Skip line 1 only when it can't be a recipient anyway — either it says
  // "phone"/"טלפון", or it isn't a number while a later line is.
  const start = !firstIsPhone && (looksLikeHeaderText || laterLineIsPhone) ? 1 : 0;

  for (let i = start; i < lines.length; i++) {
    const cells = splitLine(lines[i], delimiter);
    const raw = cells[0] ?? "";
    if (!raw) {
      errors.push(`שורה ${i + 1}: חסר מספר טלפון`);
      continue;
    }
    const phone = canonicalize(raw);
    if (!phone) {
      errors.push(`שורה ${i + 1}: מספר טלפון לא תקין — "${raw}"`);
      continue;
    }
    rows.push({ phone, name: cells[1] ?? "", variables: cells.slice(2) });
  }
  return { rows, errors };
}
