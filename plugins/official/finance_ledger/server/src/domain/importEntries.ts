import { createHash } from "node:crypto";
import type { Queryable } from "@rainver/protocol";
import type { LedgerEntry, LedgerError } from "../beancount/entries.js";

/**
 * What became of one parsed entry.
 *
 * - `imported`: its draft rows exist; `directive_id` names the dated directive.
 * - `pending_mapping`: an account or commodity it names is not in this book
 *   as this person sees it. Fixed by mapping the name to an existing account
 *   or by adding the commodity, then retrying.
 * - `needs_review`: another import of this book already holds an entry with
 *   the same content. Whether it is the same transaction is for the importer
 *   to say.
 * - `duplicate`: the importer, or a shared trusted external id, said it is
 *   the same record as `duplicate_of_entry_id`.
 * - `error`: it could not be persisted; `errors_json` says why.
 * - `excluded`: a directive an import never executes (open, close,
 *   commodity, option). The row keeps the diagnosis.
 */
export type ImportEntryStatus =
  | "imported"
  | "pending_mapping"
  | "needs_review"
  | "duplicate"
  | "error"
  | "excluded";

export type ImportEntryIdentityKind = "external_id" | "content_occurrence";

export interface FinanceImportEntryRow {
  id: string;
  import_source_id: string;
  book_id: string;
  space_id: string;
  entry_key: string;
  identity_kind: ImportEntryIdentityKind;
  external_id: string | null;
  content_hash: string;
  occurrence: number;
  entry_type: string;
  entry_date: string | null;
  source_lineno: number;
  raw_text: string;
  status: ImportEntryStatus;
  status_reason: string | null;
  directive_id: string | null;
  duplicate_of_entry_id: string | null;
  missing_accounts: string[];
  missing_commodities: string[];
  account_mapping_json: Record<string, string>;
  mapping_version: number;
  errors_json: LedgerError[];
  created_at: string;
  updated_at: string;
}

/** Metadata key an importer sets when the upstream record has an id of its own. */
export const EXTERNAL_ID_METADATA_KEY = "external_id";

export interface ParsedImportEntry {
  entry: LedgerEntry;
  entryKey: string;
  identityKind: ImportEntryIdentityKind;
  externalId: string | null;
  contentHash: string;
  occurrence: number;
  sourceLineno: number;
  rawText: string;
}

/**
 * Gives every parsed entry a stable identity inside the file.
 *
 * A transaction carrying a trusted external id is that id. Everything else is
 * the hash of its own lines plus how many identical entries came before it in
 * the file, so two genuinely separate transactions that read the same are two
 * records, while the same file uploaded twice names the same records twice.
 */
export function identifyImportEntries(
  text: string,
  entries: readonly LedgerEntry[],
  errors: readonly LedgerError[],
): ParsedImportEntry[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Every point the parser produced something: an entry or an error. An
  // entry's text runs until the next one, so a garbage line is its own span,
  // not the tail of the entry before it — fixing it must not change that
  // entry's identity.
  const boundaries = new Set<number>([lines.length + 1]);
  for (const entry of entries) if (entry.source) boundaries.add(entry.source.lineno);
  for (const error of errors) if (error.source) boundaries.add(error.source.lineno);
  const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
  const occurrences = new Map<string, number>();
  const result: ParsedImportEntry[] = [];
  for (const entry of entries) {
    const lineno = entry.source?.lineno;
    if (!lineno) throw new Error("Parsed entry has no source line");
    const end = sortedBoundaries.find((boundary) => boundary > lineno) ?? lines.length + 1;
    const span = lines.slice(lineno - 1, end - 1).map((line) => line.trimEnd());
    while (span.length > 0 && isIgnorableLine(span.at(-1)!)) span.pop();
    const rawText = span.join("\n");
    const contentHash = createHash("sha256").update(rawText, "utf8").digest("hex");
    const externalId = entry.type === "transaction" ? externalIdOf(entry.meta) : null;
    if (externalId !== null) {
      result.push({
        entry, entryKey: `external:${externalId}`, identityKind: "external_id", externalId,
        contentHash, occurrence: 0, sourceLineno: lineno, rawText,
      });
      continue;
    }
    const occurrence = occurrences.get(contentHash) ?? 0;
    occurrences.set(contentHash, occurrence + 1);
    result.push({
      entry, entryKey: `content:${contentHash}:${occurrence}`, identityKind: "content_occurrence", externalId: null,
      contentHash, occurrence, sourceLineno: lineno, rawText,
    });
  }
  return result;
}

function externalIdOf(meta: Record<string, unknown>): string | null {
  const value = meta[EXTERNAL_ID_METADATA_KEY];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isIgnorableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith(";");
}

const ENTRY_COLUMNS = `id, import_source_id, book_id, space_id, entry_key, identity_kind, external_id,
       content_hash, occurrence, entry_type, entry_date::text, source_lineno, raw_text, status,
       status_reason, directive_id, duplicate_of_entry_id, missing_accounts, missing_commodities,
       account_mapping_json, mapping_version, errors_json, created_at::text, updated_at::text`;

export interface ImportEntryOutcome {
  status: ImportEntryStatus;
  statusReason?: string | null;
  directiveId?: string | null;
  duplicateOfEntryId?: string | null;
  missingAccounts?: string[];
  missingCommodities?: string[];
  errors?: LedgerError[];
}

export const financeImportEntryRepository = {
  /**
   * The batch's row for this identity, created on first sight. The unique key
   * is what keeps a concurrent retry from creating a second row; the caller
   * holds the book lock, so the conflict branch is a re-read, not a race.
   */
  async ensure(
    db: Queryable,
    input: {
      spaceId: string;
      bookId: string;
      importSourceId: string;
      parsed: ParsedImportEntry;
    },
  ): Promise<FinanceImportEntryRow> {
    const { parsed } = input;
    const entryDate = "date" in parsed.entry ? parsed.entry.date : null;
    const result = await db.query<FinanceImportEntryRow>(
      `INSERT INTO finance_import_entries
         (space_id, book_id, import_source_id, entry_key, identity_kind, external_id, content_hash,
          occurrence, entry_type, entry_date, source_lineno, raw_text, status, status_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, 'error', 'not_attempted')
       ON CONFLICT (import_source_id, entry_key) DO UPDATE
         SET source_lineno = EXCLUDED.source_lineno,
             updated_at = now()
       RETURNING ${ENTRY_COLUMNS}`,
      [
        input.spaceId, input.bookId, input.importSourceId, parsed.entryKey, parsed.identityKind,
        parsed.externalId, parsed.contentHash, parsed.occurrence, parsed.entry.type, entryDate,
        parsed.sourceLineno, parsed.rawText,
      ],
    );
    return result.rows[0]!;
  },

  async setOutcome(db: Queryable, entryId: string, outcome: ImportEntryOutcome): Promise<FinanceImportEntryRow> {
    const result = await db.query<FinanceImportEntryRow>(
      `UPDATE finance_import_entries
          SET status = $2,
              status_reason = $3,
              directive_id = $4,
              duplicate_of_entry_id = $5,
              missing_accounts = $6,
              missing_commodities = $7,
              errors_json = $8::jsonb,
              updated_at = now()
        WHERE id = $1
        RETURNING ${ENTRY_COLUMNS}`,
      [
        entryId, outcome.status, outcome.statusReason ?? null, outcome.directiveId ?? null,
        outcome.duplicateOfEntryId ?? null, outcome.missingAccounts ?? [], outcome.missingCommodities ?? [],
        JSON.stringify(outcome.errors ?? []),
      ],
    );
    if (!result.rows[0]) throw new Error("Import entry not found");
    return result.rows[0];
  },

  async setAccountMapping(
    db: Queryable,
    entryId: string,
    mapping: Record<string, string>,
  ): Promise<FinanceImportEntryRow> {
    const result = await db.query<FinanceImportEntryRow>(
      `UPDATE finance_import_entries
          SET account_mapping_json = $2::jsonb,
              mapping_version = mapping_version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING ${ENTRY_COLUMNS}`,
      [entryId, JSON.stringify(mapping)],
    );
    if (!result.rows[0]) throw new Error("Import entry not found");
    return result.rows[0];
  },

  async find(db: Queryable, spaceId: string, importSourceId: string, entryId: string): Promise<FinanceImportEntryRow | null> {
    const result = await db.query<FinanceImportEntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM finance_import_entries
        WHERE space_id = $1 AND import_source_id = $2 AND id = $3`,
      [spaceId, importSourceId, entryId],
    );
    return result.rows[0] ?? null;
  },

  async listForSource(db: Queryable, spaceId: string, importSourceId: string): Promise<FinanceImportEntryRow[]> {
    const result = await db.query<FinanceImportEntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM finance_import_entries
        WHERE space_id = $1 AND import_source_id = $2
        ORDER BY source_lineno ASC, id ASC`,
      [spaceId, importSourceId],
    );
    return result.rows;
  },

  /**
   * The same identity in another batch of this book. A trusted external id
   * matching an imported record is the same record; a content match is a
   * question for the importer.
   */
  async findInOtherSources(
    db: Queryable,
    spaceId: string,
    bookId: string,
    importSourceId: string,
    entryKey: string,
  ): Promise<FinanceImportEntryRow[]> {
    const result = await db.query<FinanceImportEntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM finance_import_entries
        WHERE space_id = $1 AND book_id = $2 AND import_source_id <> $3 AND entry_key = $4
        ORDER BY created_at ASC, id ASC`,
      [spaceId, bookId, importSourceId, entryKey],
    );
    return result.rows;
  },

  async countByStatus(db: Queryable, spaceId: string, importSourceId: string): Promise<Record<ImportEntryStatus, number>> {
    const result = await db.query<{ status: ImportEntryStatus; count: string }>(
      `SELECT status, count(*)::text AS count FROM finance_import_entries
        WHERE space_id = $1 AND import_source_id = $2
        GROUP BY status`,
      [spaceId, importSourceId],
    );
    const counts = emptyStatusCounts();
    for (const row of result.rows) counts[row.status] = Number(row.count);
    return counts;
  },
};

export function emptyStatusCounts(): Record<ImportEntryStatus, number> {
  return { imported: 0, pending_mapping: 0, needs_review: 0, duplicate: 0, error: 0, excluded: 0 };
}
