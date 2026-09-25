import { createAdapterFactory } from "better-auth/adapters";
import type { AdapterFactoryCustomizeAdapterCreator, CleanedWhere, CustomAdapter, DBAdapter, DBTransactionAdapter } from "better-auth/adapters";
import type { BetterAuthOptions } from "better-auth";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./tx.js";
import { hashOpaqueToken } from "../modules/auth/securityPolicy.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type WhereClause = CleanedWhere;
type AdapterDetails = Parameters<AdapterFactoryCustomizeAdapterCreator>[0];
type SessionTokenState = Map<string, string>;
type RainverAdapter = DBAdapter<BetterAuthOptions>;

const TABLES = new Set(["users", "auth_accounts", "user_sessions", "auth_verifications"]);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const OPERATORS = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "in", "not_in"]);

function tableName(model: string): string {
  if (!TABLES.has(model)) throw new Error(`Unsupported Better Auth model: ${model}`);
  return model;
}

function columnName(field: string): string {
  if (!IDENTIFIER.test(field)) throw new Error(`Unsupported Better Auth field: ${field}`);
  return field;
}

function buildWhere(model: string, input: WhereClause[], params: unknown[]): string {
  if (!input.length) return "TRUE";
  return input.map((raw, index) => {
    const clause = raw;
    const operator = clause.operator ?? "eq";
    if (!OPERATORS.has(operator)) throw new Error(`Unsupported Better Auth where operator: ${operator}`);
    const field = columnName(clause.field);
    if (model === "user_sessions" && field === "token_hash" && (operator === "eq" || operator === "in" || operator === "not_in") && (typeof clause.value === "string" || Array.isArray(clause.value))) {
      const rawValues = (Array.isArray(clause.value) ? clause.value : [clause.value]).filter((value): value is string => typeof value === "string");
      if (rawValues.length === 0) return operator === "in" ? "FALSE" : "TRUE";
      const digestPlaceholders = rawValues.map((value) => {
        params.push(hashOpaqueToken(value));
        return `$${params.length}`;
      });
      const idPlaceholders = rawValues.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      const membership = `(token_hash IN (${digestPlaceholders.join(", ")}) OR id IN (${idPlaceholders.join(", ")}))`;
      return operator === "not_in" ? `NOT ${membership}` : membership;
    }
    if (clause.value === null && (operator === "eq" || operator === "ne")) {
      return `${field} IS ${operator === "ne" ? "NOT " : ""}NULL`;
    }
    if ((operator === "in" || operator === "not_in") && Array.isArray(clause.value)) {
      if (clause.value.length === 0) return operator === "in" ? "FALSE" : "TRUE";
      const placeholders = clause.value.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `${field} ${operator === "in" ? "IN" : "NOT IN"} (${placeholders.join(", ")})`;
    }
    params.push(clause.value);
    const sqlOperator = ({ eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as Record<string, string>)[operator];
    const expression = `${field} ${sqlOperator} $${params.length}`;
    return index > 0 && raw.connector === "OR" ? `OR ${expression}` : index > 0 ? `AND ${expression}` : expression;
  }).join(" ");
}

function selectList(select: string[] | undefined, model: string, details: AdapterDetails): string {
  if (!select?.length) return "*";
  return select.map((field) => columnName(details.getFieldName({ model, field }))).join(", ");
}

function scrubRows(model: string, rows: Record<string, unknown>[], candidate?: string): Record<string, unknown>[] {
  if (model !== "user_sessions") return rows;
  // A lookup knows the candidate cookie and can safely restore it for Better
  // Auth's session validator. A list receives the row id as a safe opaque
  // selector; this lets Better Auth revoke listed sessions without ever
  // reconstructing a raw bearer token or exposing the stored digest.
  return rows.map((row) => ({
    ...row,
    token_hash: candidate ?? row.id,
  }));
}

function customAdapter(client: Queryable, details: AdapterDetails, sessionTokens: SessionTokenState): CustomAdapter {
  return {
    create: async <T extends Record<string, any>>({ model, data }: { model: string; data: T }) => {
      const table = tableName(model);
      const entries = Object.entries(data).filter(([, value]) => value !== undefined);
      const values = entries.map(([, value]) => value);
      const columns = entries.map(([field]) => columnName(field));
      const placeholders = values.map((_, index) => `$${index + 1}`);
      const logicalToken = model === "user_sessions"
        ? values[columns.indexOf("token_hash")] as string | undefined
        : undefined;
      if (table === "user_sessions") {
        const tokenIndex = columns.indexOf("token_hash");
        if (tokenIndex >= 0 && typeof values[tokenIndex] === "string") values[tokenIndex] = hashOpaqueToken(values[tokenIndex] as string);
      }
      const result = await client.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`, values);
      return scrubRows(model, result.rows, logicalToken)[0] as T;
    },
    findOne: async <T>({ model, where, select }: { model: string; where: WhereClause[]; select?: string[] }) => {
      const params: unknown[] = [];
      const result = await client.query(`SELECT ${selectList(select, model, details)} FROM ${tableName(model)} WHERE ${buildWhere(model, where, params)} LIMIT 1`, params);
      const candidate = model === "user_sessions"
        ? where.find((clause) => clause.field === "token_hash" && typeof clause.value === "string")?.value as string | undefined
        : undefined;
      const row = scrubRows(model, result.rows, candidate)[0] ?? null;
      if (model === "user_sessions" && row && candidate) sessionTokens.set(String(row.id), candidate);
      return row as T | null;
    },
    findMany: async <T>({ model, where = [], select, limit, sortBy, offset }: { model: string; where?: WhereClause[]; select?: string[]; limit: number; sortBy?: { field: string; direction: "asc" | "desc" }; offset?: number }) => {
      const params: unknown[] = [];
      const order = sortBy
        ? ` ORDER BY ${columnName(details.getFieldName({ model, field: sortBy.field }))} ${sortBy.direction === "desc" ? "DESC" : "ASC"}`
        : "";
      const pagination = ` LIMIT ${Math.max(0, Math.min(limit ?? 100, 1000))} OFFSET ${Math.max(0, offset ?? 0)}`;
      const result = await client.query(`SELECT ${selectList(select, model, details)} FROM ${tableName(model)} WHERE ${buildWhere(model, where, params)}${order}${pagination}`, params);
      return model === "user_sessions"
        ? result.rows.map((row) => ({ ...row, token_hash: sessionTokens.get(String(row.id)) ?? row.id })) as T[]
        : result.rows as T[];
    },
    count: async ({ model, where = [] }: { model: string; where?: WhereClause[] }) => {
      const params: unknown[] = [];
      const result = await client.query(`SELECT count(*)::int AS count FROM ${tableName(model)} WHERE ${buildWhere(model, where, params)}`, params);
      return Number(result.rows[0]?.count ?? 0);
    },
    update: async <T>({ model, where, update }: { model: string; where: WhereClause[]; update: T }) => {
      const entries = Object.entries(update as Record<string, unknown>).filter(([, value]) => value !== undefined);
      if (!entries.length || !where.length) return null;
      const params: unknown[] = [];
      const assignments = entries.map(([field, value]) => {
        const normalized = model === "user_sessions" && field === "token_hash" && typeof value === "string" ? hashOpaqueToken(value) : value;
        params.push(normalized);
        return `${columnName(field)} = $${params.length}`;
      });
      const result = await client.query(`UPDATE ${tableName(model)} SET ${assignments.join(", ")} WHERE ${buildWhere(model, where, params)} RETURNING *`, params);
      const candidate = model === "user_sessions"
        ? where.find((clause) => clause.field === "token_hash" && typeof clause.value === "string")?.value as string | undefined
        : undefined;
      const row = scrubRows(model, result.rows, candidate)[0] ?? null;
      if (model === "user_sessions" && row && candidate) sessionTokens.set(String(row.id), candidate);
      return row as T | null;
    },
    updateMany: async ({ model, where, update }: { model: string; where: WhereClause[]; update: Record<string, any> }) => {
      const entries = Object.entries(update).filter(([, value]) => value !== undefined);
      if (!entries.length) return 0;
      const params: unknown[] = [];
      const assignments = entries.map(([field, value]) => {
        const normalized = model === "user_sessions" && field === "token_hash" && typeof value === "string" ? hashOpaqueToken(value) : value;
        params.push(normalized);
        return `${columnName(field)} = $${params.length}`;
      });
      const result = await client.query(`UPDATE ${tableName(model)} SET ${assignments.join(", ")} WHERE ${buildWhere(model, where, params)}`, params);
      return result.rowCount ?? 0;
    },
    delete: async ({ model, where }: { model: string; where: WhereClause[] }) => {
      const params: unknown[] = [];
      await client.query(`DELETE FROM ${tableName(model)} WHERE ${buildWhere(model, where, params)}`, params);
      if (model === "user_sessions") {
        for (const clause of where) {
          if (clause.field === "id" && typeof clause.value === "string") sessionTokens.delete(clause.value);
        }
      }
    },
    deleteMany: async ({ model, where }: { model: string; where: WhereClause[] }) => {
      const params: unknown[] = [];
      const result = await client.query(`DELETE FROM ${tableName(model)} WHERE ${buildWhere(model, where, params)}`, params);
      return result.rowCount ?? 0;
    },
    consumeOne: async <T>({ model, where }: { model: string; where: WhereClause[] }) => {
      const params: unknown[] = [];
      const result = await client.query(`DELETE FROM ${tableName(model)} WHERE ctid = (SELECT ctid FROM ${tableName(model)} WHERE ${buildWhere(model, where, params)} LIMIT 1) RETURNING *`, params);
      return scrubRows(model, result.rows)[0] as T | null;
    },
    incrementOne: async <T>({ model, where, increment, set }: { model: string; where: WhereClause[]; increment: Record<string, number>; set?: Record<string, unknown> }) => {
      const params: unknown[] = [];
      const assignments = Object.entries(increment).map(([field, value]) => {
        if (!Number.isFinite(value)) throw new Error("Better Auth increment must be finite");
        return `${columnName(field)} = ${columnName(field)} + ${Number(value)}`;
      });
      for (const [field, value] of Object.entries(set ?? {})) {
        params.push(value);
        assignments.push(`${columnName(field)} = $${params.length}`);
      }
      if (!assignments.length) return null;
      const result = await client.query(`UPDATE ${tableName(model)} SET ${assignments.join(", ")} WHERE ${buildWhere(model, where, params)} RETURNING *`, params);
      return scrubRows(model, result.rows)[0] as T | null;
    },
  };
}

function createForClient(client: Queryable, options: BetterAuthOptions, withTransactions: boolean, sessionTokens: SessionTokenState): RainverAdapter {
  return createAdapterFactory({
    config: {
      adapterId: "rainver-pg",
      adapterName: "Rainver PostgreSQL adapter",
      usePlural: true,
      supportsUUIDs: true,
      supportsJSON: true,
      supportsDates: true,
      supportsBooleans: true,
      transaction: withTransactions
        ? async <R>(callback: (transaction: DBTransactionAdapter) => Promise<R>) => withTransaction(client as Pool, async (transactionClient) => callback(createForClient(transactionClient, options, false, sessionTokens)))
        : false,
    },
    adapter: ((details) => customAdapter(client, details, sessionTokens)) satisfies AdapterFactoryCustomizeAdapterCreator,
  })(options);
}

export function rainverPgAdapter(pool: Pool) {
  const sessionTokens: SessionTokenState = new Map();
  return (options: BetterAuthOptions) => createForClient(pool, options, true, sessionTokens);
}
