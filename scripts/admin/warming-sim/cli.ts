// Command-line flags. Pure so the defaults and bad input are testable.

export const DEFAULT_MAX_COST_USD = 25;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_OUT_DIR = "scripts/admin/warming-sim/out";

export interface CliOptions {
  envFile: string;
  scenariosFile: string | null;
  outDir: string;
  only: string[];
  concurrency: number;
  maxCostUsd: number;
  dryRun: boolean;
}

export class CliUsageError extends Error {}

function readPositiveNumber(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value <= 0) {
    throw new CliUsageError(`${flag} needs a positive number`);
  }
  return value;
}

function readValue(flag: string, raw: string | undefined): string {
  if (!raw || raw.startsWith("--")) throw new CliUsageError(`${flag} needs a value`);
  return raw;
}

export function parseCliArgs(argv: ReadonlyArray<string>): CliOptions {
  const options: CliOptions = {
    envFile: "",
    scenariosFile: null,
    outDir: DEFAULT_OUT_DIR,
    only: [],
    concurrency: DEFAULT_CONCURRENCY,
    maxCostUsd: DEFAULT_MAX_COST_USD,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--env-file") options.envFile = readValue(flag, argv[++i]);
    else if (flag === "--scenarios") options.scenariosFile = readValue(flag, argv[++i]);
    else if (flag === "--out") options.outDir = readValue(flag, argv[++i]);
    else if (flag === "--only") {
      options.only = readValue(flag, argv[++i]).split(",").map((token) => token.trim()).filter(Boolean);
    } else if (flag === "--concurrency") {
      options.concurrency = Math.floor(readPositiveNumber(flag, argv[++i]));
    } else if (flag === "--max-cost-usd") options.maxCostUsd = readPositiveNumber(flag, argv[++i]);
    else throw new CliUsageError(`unknown flag ${flag}`);
  }
  if (!options.envFile) throw new CliUsageError("--env-file <path> is required");
  return options;
}
