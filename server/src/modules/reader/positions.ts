import { lockDocumentVersion } from "./documentVersionLock.js";
import { randomUUID } from "node:crypto";
import { ReaderAppearanceSchema, ReaderPositionWriteSchema, type ReaderAppearance, type ReaderPosition, type ReaderPositionMark } from "@rainver/protocol";
import { HttpError, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { ScopedSettingsStore, defineScopedSetting } from "../settings/scopedSettings.js";
import { PgReaderRepository, assertDocumentReadable } from "./repository.js";
import type { ServerConfig } from "../../config.js";

interface PositionRow {
  content_hash: string;
  structure_hash: string;
  current_json: ReaderPositionMark;
  current_progress: number;
  current_client_at: string;
  furthest_json: ReaderPositionMark | null;
  furthest_progress: number;
  reset_client_at: string | null;
  updated_at: string;
  revision: number;
}

const COLUMNS = `content_hash, structure_hash, current_json, current_progress, current_client_at::text AS current_client_at,
  furthest_json, furthest_progress, reset_client_at::text AS reset_client_at, updated_at::text AS updated_at, revision`;

function out(row: PositionRow | undefined): ReaderPosition | null {
  if (!row) return null;
  return {
    content_hash: row.content_hash, structure_hash: row.structure_hash,
    current: row.current_json, furthest: row.furthest_json,
    current_client_at: new Date(row.current_client_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
    revision: row.revision,
  };
}

/**
 * A person's private reading position in a Reader document (see
 * `ReaderPositionWriteSchema` for the ordering rules). Every read and write
 * first passes the document's own Reader gate, so a person who can no longer
 * read the document can neither see nor move their position in it. Nothing
 * here touches read status, reading origin or topic confirmations.
 */
export class ReaderPositionStore {
  /** `config` is needed only to write (the current document version is read through the Reader resolver). */
  constructor(private readonly db: Queryable, private readonly config?: ServerConfig) {}

  async get(identity: SpaceUserIdentity, documentType: string, documentId: string): Promise<ReaderPosition | null> {
    await assertDocumentReadable(this.db, identity, documentType, documentId);
    const result = await this.db.query<PositionRow>(
      `SELECT ${COLUMNS} FROM reader_positions WHERE space_id=$1 AND user_id=$2 AND document_type=$3 AND document_id=$4`,
      [identity.spaceId, identity.userId, documentType, documentId],
    );
    return out(result.rows[0]);
  }

  async write(identity: SpaceUserIdentity, documentType: string, documentId: string, body: unknown): Promise<{ position: ReaderPosition | null; accepted: boolean }> {
    const parsed = ReaderPositionWriteSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(422, parsed.error.issues[0]?.message ?? "Invalid reading position");
    const input = parsed.data;
    const at = new Date(input.client_at).toISOString();
    // A report from a clock far in the future would freeze the position for everyone else's later reports.
    if (Date.parse(at) > Date.now() + 5 * 60_000) throw new HttpError(422, "Reading position time is in the future");
    const config = this.config;
    if (!config) throw new Error("ReaderPositionStore.write needs the server config");
    return withQueryableTransaction(this.db, async tx => {
      await assertDocumentReadable(tx, identity, documentType, documentId);
      // Lock order: the document's own row (shared), then the position row.
      // Every writer of a document's content updates that row, so while this
      // transaction holds it the version cannot change, and a write that
      // committed before it is seen by the read below.
      await lockDocumentVersion(tx, identity.spaceId, documentType, documentId);
      // The version the document has now, read the way the Reader reads it but without recording an open.
      const document = await new PgReaderRepository(tx, config).getDocument(identity, documentType, documentId, { recordOpen: false });
      if (!document) throw new HttpError(404, "Document not found");
      const onCurrentVersion = document.content_hash === input.content_hash && document.structure_hash === input.structure_hash;
      const key = [identity.spaceId, identity.userId, documentType, documentId];
      const select = () => tx.query<PositionRow>(
        `SELECT ${COLUMNS} FROM reader_positions WHERE space_id=$1 AND user_id=$2 AND document_type=$3 AND document_id=$4 FOR UPDATE`, key,
      );
      // A report measured on a version the document no longer has (an old tab) changes nothing, however late its time.
      if (!onCurrentVersion) return { position: out((await select()).rows[0]), accepted: false };
      const fresh = (dwelled: boolean) => dwelled || input.reset_furthest ? input.current : null;
      const furthest = fresh(input.dwelled);
      const inserted = await tx.query<PositionRow>(
        `INSERT INTO reader_positions(id, space_id, user_id, document_type, document_id, content_hash, structure_hash, current_json, current_progress,
           current_client_at, furthest_json, furthest_progress, reset_client_at, revision, created_at, updated_at)
         VALUES($5,$1,$2,$3,$4,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12,$13,1,now(),now())
         ON CONFLICT (space_id, user_id, document_type, document_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [...key, randomUUID(), input.content_hash, input.structure_hash, JSON.stringify(input.current), input.current.progress, at,
          furthest ? JSON.stringify(furthest) : null, furthest?.progress ?? 0, input.reset_furthest ? at : null],
      );
      if (inserted.rows[0]) return { position: out(inserted.rows[0]), accepted: true };
      // The row exists (possibly created a moment ago by a concurrent first report): apply this one to it, under its lock.
      const existing = (await select()).rows[0]!;

      let next = { ...existing };
      let accepted = false;
      const sameVersion = existing.content_hash === input.content_hash && existing.structure_hash === input.structure_hash;
      if (!sameVersion) {
        // The stored position belongs to an earlier version: the current version starts its own progress.
        next = { ...next, content_hash: input.content_hash, structure_hash: input.structure_hash, current_json: input.current,
          current_progress: input.current.progress, current_client_at: at, furthest_json: furthest, furthest_progress: furthest?.progress ?? 0,
          reset_client_at: input.reset_furthest ? at : null };
        accepted = true;
      } else {
        if (Date.parse(at) > Date.parse(existing.current_client_at)) {
          next = { ...next, current_json: input.current, current_progress: input.current.progress, current_client_at: at };
          accepted = true;
        }
        const afterReset = !next.reset_client_at || Date.parse(at) >= Date.parse(next.reset_client_at);
        if (input.reset_furthest && afterReset) {
          next = { ...next, furthest_json: input.current, furthest_progress: input.current.progress, reset_client_at: at };
          accepted = true;
        } else if (input.dwelled && afterReset && input.current.progress > next.furthest_progress) {
          next = { ...next, furthest_json: input.current, furthest_progress: input.current.progress };
          accepted = true;
        }
      }
      if (!accepted) return { position: out(existing), accepted: false };
      const updated = await tx.query<PositionRow>(
        `UPDATE reader_positions SET content_hash=$5, structure_hash=$6, current_json=$7::jsonb, current_progress=$8, current_client_at=$9,
           furthest_json=$10::jsonb, furthest_progress=$11, reset_client_at=$12, revision=revision+1, updated_at=now()
         WHERE space_id=$1 AND user_id=$2 AND document_type=$3 AND document_id=$4 RETURNING ${COLUMNS}`,
        [...key, next.content_hash, next.structure_hash, JSON.stringify(next.current_json), next.current_progress, next.current_client_at,
          next.furthest_json ? JSON.stringify(next.furthest_json) : null, next.furthest_progress, next.reset_client_at],
      );
      return { position: out(updated.rows[0]), accepted: true };
    });
  }

  /** Progress (current, furthest) for Reading list rows, for source items only, never failing the list. */
  async progressForSourceItems(identity: SpaceUserIdentity, itemIds: string[]): Promise<Map<string, { current: number; furthest: number }>> {
    if (!itemIds.length) return new Map();
    const result = await this.db.query<{ document_id: string; current_progress: number; furthest_progress: number }>(
      `SELECT document_id, current_progress, furthest_progress FROM reader_positions
        WHERE space_id=$1 AND user_id=$2 AND document_type='source_item' AND document_id = ANY($3::varchar[])`,
      [identity.spaceId, identity.userId, itemIds],
    );
    return new Map(result.rows.map(row => [row.document_id, { current: row.current_progress, furthest: row.furthest_progress }]));
  }
}

const appearance = defineScopedSetting({
  key: "reader.appearance",
  scopeType: "user",
  defaults: ReaderAppearanceSchema.parse({}),
  parse: (value: unknown) => ReaderAppearanceSchema.catch(ReaderAppearanceSchema.parse({})).parse(value),
});

/** Reader appearance in the person's own user settings (no Space, Project or document in it). */
export class ReaderAppearanceSettings {
  constructor(private readonly db: Queryable) {}
  async get(identity: SpaceUserIdentity): Promise<ReaderAppearance> {
    return (await new ScopedSettingsStore(this.db).get(appearance, identity.userId)).value;
  }
  async set(identity: SpaceUserIdentity, body: unknown): Promise<ReaderAppearance> {
    const parsed = ReaderAppearanceSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(422, parsed.error.issues[0]?.message ?? "Invalid Reader appearance");
    return (await new ScopedSettingsStore(this.db).upsert(appearance, identity.userId, parsed.data, { updatedByUserId: identity.userId })).value;
  }
}
