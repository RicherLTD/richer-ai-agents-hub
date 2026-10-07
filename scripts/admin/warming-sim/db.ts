// Read-only access to the production database through the Supabase
// Management API. The simulator must never write, so every statement is
// checked before it leaves the process.

const FORBIDDEN_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|merge|vacuum|lock|set|do)\b/i;

export class ReadOnlyViolationError extends Error {}

/** Only a single SELECT statement may pass. */
export function assertReadOnlySql(sql: string): void {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(statement)) {
    throw new ReadOnlyViolationError("only SELECT statements are allowed");
  }
  if (statement.includes(";")) {
    throw new ReadOnlyViolationError("multiple statements are not allowed");
  }
  if (FORBIDDEN_KEYWORDS.test(statement)) {
    throw new ReadOnlyViolationError("statement contains a write keyword");
  }
}

export interface DbConfig {
  projectRef: string;
  accessToken: string;
}

export interface ReadOnlyDb {
  query<T>(sql: string): Promise<T[]>;
}

export function createReadOnlyDb(
  config: DbConfig,
  fetchImpl: typeof fetch = fetch,
): ReadOnlyDb {
  return {
    async query<T>(sql: string): Promise<T[]> {
      assertReadOnlySql(sql);
      const response = await fetchImpl(
        `https://api.supabase.com/v1/projects/${config.projectRef}/database/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: sql }),
        },
      );
      // Status only: the body may echo query text and we never print secrets.
      if (!response.ok) {
        throw new Error(`database query failed with HTTP ${response.status}`);
      }
      return (await response.json()) as T[];
    },
  };
}
