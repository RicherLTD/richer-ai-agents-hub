// Parses a dotenv-style file. Values are never logged anywhere in the
// simulator: this module only returns them to the caller.

export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).replace(/^export\s+/, "").trim();
    env[key] = stripQuotes(line.slice(separator + 1).trim());
  }
  return env;
}

function stripQuotes(value: string): string {
  const isQuoted =
    value.length >= 2 &&
    (value.startsWith('"') || value.startsWith("'")) &&
    value.endsWith(value[0]);
  return isQuoted ? value.slice(1, -1) : value;
}

/** Names of required keys that are missing or empty; never the values. */
export function findMissingKeys(
  env: Record<string, string>,
  required: ReadonlyArray<string>,
): string[] {
  return required.filter((key) => !env[key]);
}
