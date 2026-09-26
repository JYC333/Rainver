import {
  ImportedSessionRecordSchema,
  ImportedSessionSchema,
  type ImportedSession,
  type ImportedSessionRecord,
} from "@rainver/protocol";
import type { ImportedSessionRecordRow, ImportedSessionRow } from "./repository.js";

function wireTimestamp(value: string | Date): string;
function wireTimestamp(value: string | Date | null): string | null;
function wireTimestamp(value: string | Date | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

/** Validate the actual JSON shape at the server's read boundary. */
export function importedSessionToWire(row: ImportedSessionRow): ImportedSession {
  const value = {
    ...row,
    first_record_at: wireTimestamp(row.first_record_at),
    last_record_at: wireTimestamp(row.last_record_at),
    vendor_updated_at: wireTimestamp(row.vendor_updated_at),
    last_synced_at: wireTimestamp(row.last_synced_at),
    last_seen_on_host_at: wireTimestamp(row.last_seen_on_host_at),
    created_at: wireTimestamp(row.created_at),
    updated_at: wireTimestamp(row.updated_at),
  } satisfies ImportedSession;
  return ImportedSessionSchema.parse(value);
}

export function importedSessionRecordToWire(row: ImportedSessionRecordRow): ImportedSessionRecord {
  const value = {
    ...row,
    occurred_at: wireTimestamp(row.occurred_at),
    created_at: wireTimestamp(row.created_at),
  } satisfies ImportedSessionRecord;
  return ImportedSessionRecordSchema.parse(value);
}
