import { resolveContentCreationContext } from "../access/creationContext.js";
import { ReaderDocumentNoteCreateSchema } from "@rainver/protocol";
import { randomUUID } from "node:crypto";
import { HttpError, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { PgKnowledgeRepository } from "../knowledge/repository.js";
import { assertDocumentReadable } from "./repository.js";

/** An association, not a second note store. Always gated by both document and
 * canonical Note access. No article text/title or annotation is copied. */
export class ReaderDocumentNotes {
  constructor(private readonly db: Queryable) {}
  async get(identity: SpaceUserIdentity, documentType: string, documentId: string) {
    await assertDocumentReadable(this.db, identity, documentType, documentId);
    const row = (await this.db.query<{ note_id: string; note_space_id: string }>(`SELECT note_id,note_space_id FROM reader_document_notes WHERE space_id=$1 AND user_id=$2 AND document_type=$3 AND document_id=$4`, [identity.spaceId, identity.userId, documentType, documentId])).rows[0];
    if (!row) return { note: null };
    const note = await new PgKnowledgeRepository(this.db).getNote({ spaceId: row.note_space_id, userId: identity.userId }, row.note_id);
    if (!note) throw new HttpError(409, "Your document note is unavailable. Restore its access in Notes before continuing.");
    return { note: { id: String(note.id), space_id: row.note_space_id, status: String(note.status) } };
  }
  async create(identity: SpaceUserIdentity, documentType: string, documentId: string, body: unknown = {}) {
    const parsed = ReaderDocumentNoteCreateSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(422, "Invalid document note title");
    return withQueryableTransaction(this.db, async tx => {
      await assertDocumentReadable(tx, identity, documentType, documentId);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(['reader-document-note', identity.spaceId, identity.userId, documentType, documentId])]);
      const existing = await new ReaderDocumentNotes(tx).get(identity, documentType, documentId);
      if (existing.note) return existing;
      // Explicit user action; reuse the canonical Note writer, revision,
      // private Inbox placement, access gates and later Notes editor.
      const creation = await resolveContentCreationContext(tx, { userId: identity.userId, requestSpaceId: identity.spaceId });
      const note = await new PgKnowledgeRepository(tx).createNote({ spaceId: creation.spaceId, userId: identity.userId }, { title: parsed.data.title ?? 'Document notes', visibility: 'private', content_format: 'prosemirror_json', content_schema_version: 1,
        content_json: { type: 'doc', content: [{ type: 'paragraph' }] }, plain_text: '' });
      await tx.query(`INSERT INTO reader_document_notes(id,space_id,user_id,document_type,document_id,note_id,note_space_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())`, [randomUUID(), identity.spaceId, identity.userId, documentType, documentId, note.id, creation.spaceId]);
      return { note: { id: String(note.id), space_id: creation.spaceId, status: String(note.status) } };
    });
  }
}
