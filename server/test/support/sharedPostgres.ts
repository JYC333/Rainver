import { createHash } from "node:crypto";
import { Pool } from "pg";
import { inject } from "vitest";

export interface SharedPostgresContext {
  available: boolean;
  adminUri?: string;
  templateDatabase?: string;
  runId?: string;
  error?: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    sharedPostgres: SharedPostgresContext;
  }
}

export interface TestPostgresDatabase {
  getConnectionUri(): string;
  stop(): Promise<void>;
}

export class TestPostgresUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TestPostgresUnavailableError";
  }
}

const POSTGRES_CONNECTION_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

export function isTestPostgresUnavailableError(error: unknown): boolean {
  if (error instanceof TestPostgresUnavailableError) return true;
  if (!(error instanceof Error)) return false;

  const code = (error as NodeJS.ErrnoException).code;
  if (code && (POSTGRES_CONNECTION_ERROR_CODES.has(code) || code.startsWith("08"))) return true;
  if (code === "57P01" || code === "57P02" || code === "57P03") return true;
  const nestedErrors = (error as Error & { errors?: unknown[] }).errors;
  if (Array.isArray(nestedErrors) && nestedErrors.some(isTestPostgresUnavailableError)) return true;
  if (error.cause && error.cause !== error) {
    return isTestPostgresUnavailableError(error.cause);
  }
  return false;
}

function databaseUri(adminUri: string, database: string): string {
  const uri = new URL(adminUri);
  uri.pathname = `/${database}`;
  return uri.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function getTestPostgres(
  fileUrl: string,
  options: { empty?: boolean } = {},
): Promise<TestPostgresDatabase> {
  const context = inject("sharedPostgres");
  if (
    !context.available ||
    !context.adminUri ||
    !context.templateDatabase ||
    !context.runId
  ) {
    throw new TestPostgresUnavailableError(
      context.error ?? "Shared Postgres test container is unavailable",
    );
  }

  const fileHash = createHash("sha256").update(fileUrl).digest("hex").slice(0, 12);
  const database = `rainver_test_${context.runId}_${fileHash}`;
  const template = options.empty ? "template0" : context.templateDatabase;
  const admin = new Pool({ connectionString: context.adminUri, max: 1 });

  try {
    await admin.query(
      `CREATE DATABASE ${quoteIdentifier(database)} TEMPLATE ${quoteIdentifier(template)}`,
    );
  } finally {
    await admin.end();
  }

  let stopped = false;
  return {
    getConnectionUri: () => databaseUri(context.adminUri!, database),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      const cleanup = new Pool({ connectionString: context.adminUri, max: 1 });
      try {
        await cleanup.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database],
        );
        // WITH (FORCE) closes the terminate→drop race: a pooled connection
        // from another worker can reattach in between, which intermittently
        // failed whole files with "database is being accessed by other users".
        await cleanup.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
