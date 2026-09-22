import { z } from "zod";
import { SECRET_RESPONSE_FIELDS } from "./common.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

function normalizedFieldName(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

const SECRET_KEYS = new Set<string>([
  ...SECRET_RESPONSE_FIELDS,
  "authorization",
  "cookie",
  "access_token",
  "refresh_token",
  "id_token",
  "password",
  "private_key",
  "client_secret",
  "token",
  "credential",
  "credentials",
  "credential_id",
  "credential_profile_id",
].map(normalizedFieldName));

const SECRET_KEY_SUFFIXES = [
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "client_secret",
  "private_key",
  "credential_secret_ref",
  "credential_profile_id",
  "credential_id",
  "credential",
  "credentials",
  "secret_ref",
  "secret",
  "token",
].map(normalizedFieldName);

function isForbiddenKey(key: string, forbidden: ReadonlySet<string>): boolean {
  const normalized = normalizedFieldName(key);
  if (forbidden.has(normalized)) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

const TRACE_UNSAFE_KEYS = new Set<string>([
  ...SECRET_KEYS,
  "rendered_context",
  "context_text",
  "private_memory_text",
  "raw_private_memory",
  "raw_memory_text",
  "full_patch",
  "patch",
  "diff",
  "file_content",
  "raw_file_content",
  "stdout",
  "stderr",
].map(normalizedFieldName));

function findForbiddenKey(
  value: JsonValue,
  forbidden: ReadonlySet<string>,
  path: string[] = [],
): string[] | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenKey(value[index]!, forbidden, [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (isForbiddenKey(key, forbidden)) return childPath;
    const found = findForbiddenKey(child, forbidden, childPath);
    if (found) return found;
  }
  return null;
}

function secretFree(schemaName: string, forbidden: ReadonlySet<string>) {
  return JsonValueSchema.superRefine((value, ctx) => {
    const path = findForbiddenKey(value, forbidden);
    if (!path) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${schemaName} forbids secret or raw-evidence field '${path.join(".")}'`,
      path,
    });
  });
}

/** JSON value that forbids nested secret-bearing keys. */
export const SecretFreeJsonSchema = secretFree("SecretFreeJson", SECRET_KEYS);
export type SecretFreeJson = z.infer<typeof SecretFreeJsonSchema>;

/** Object-shaped JSON contract for configuration records with no credential material. */
export const SecretFreeJsonRecordSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  const result = SecretFreeJsonSchema.safeParse(value);
  if (result.success) return;
  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message,
      path: issue.path,
    });
  }
});

/** Return a deep copy with every secret-bearing field removed at any depth. */
export function stripSecretFields(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => stripSecretFields(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isForbiddenKey(key, SECRET_KEYS))
      .map(([key, child]) => [key, stripSecretFields(child)]),
  );
}

/** Validate an object-shaped JSON value and return its secret-free projection. */
export function stripSecretFieldsFromRecord(value: unknown): Record<string, JsonValue> {
  const record = z.record(JsonValueSchema).parse(value);
  const projected = stripSecretFields(record);
  if (projected === null || Array.isArray(projected) || typeof projected !== "object") {
    throw new TypeError("Expected an object-shaped JSON record");
  }
  return projected;
}

/** Return the path of the first secret-bearing field in a JSON tree. */
export function findSecretFieldPath(value: JsonValue): string[] | null {
  return findForbiddenKey(value, SECRET_KEYS);
}

/** JSON value safe for traces: credential fields and raw evidence are forbidden. */
export const TraceSafeJsonSchema = secretFree("TraceSafeJson", TRACE_UNSAFE_KEYS);
export type TraceSafeJson = z.infer<typeof TraceSafeJsonSchema>;
