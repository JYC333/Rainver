import { ReaderAnnotationRangeUpdateSchema } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { HttpError, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { PgAnnotationRepository, PgReaderRepository } from "./repository.js";
import { lockDocumentVersion } from "./documentVersionLock.js";

/** Document → annotation lock order, like reading-position writes. No label,
 * visibility, thread or evidence mutation is part of a range replacement. */
export async function replaceAnnotationRange(db: Queryable, config: ServerConfig, identity: SpaceUserIdentity, id: string, body: unknown) {
  const parsed = ReaderAnnotationRangeUpdateSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(422, parsed.error.issues[0]?.message ?? "Invalid annotation range");
  const input = parsed.data;
  return withQueryableTransaction(db, async tx => {
    const target = (await tx.query<{ document_type: string; document_id: string }>(
      "SELECT document_type,document_id FROM reader_annotations WHERE space_id=$1 AND id=$2 AND created_by_user_id=$3",
      [identity.spaceId, id, identity.userId],
    )).rows[0];
    if (!target) throw new HttpError(404, "Annotation not found");
    await lockDocumentVersion(tx, identity.spaceId, target.document_type, target.document_id);
    const document = await new PgReaderRepository(tx, config).getDocument(identity, target.document_type, target.document_id, { recordOpen: false });
    if (!document) throw new HttpError(404, "Document not found");
    if (document.content_hash !== input.content_hash || document.structure_hash !== input.structure_hash) throw new HttpError(409, "The document changed. Reload before adjusting this quote.");
    const ref = input.anchor_json.document_ref;
    if (ref.document_type !== target.document_type || ref.document_id !== target.document_id) throw new HttpError(422, "Replacement belongs to a different document");
    const readable = (await new PgAnnotationRepository(tx).listAnnotations(identity, target.document_type, target.document_id)).find(item => item.id === id);
    if (!readable?.quote_text) throw new HttpError(404, "Annotation not found");
    // CAS on the exact prior anchor/quote. Concurrent edits to labels or comment
    // threads remain untouched. A concurrent archive cannot be resurrected.
    const result = await tx.query(`UPDATE reader_annotations SET quote_text=$4,anchor_json=$5::jsonb,anchor_state='unverified',updated_at=now()
      WHERE space_id=$1 AND id=$2 AND created_by_user_id=$3 AND status='active'
        AND quote_text=$6 AND anchor_json=$7::jsonb RETURNING id`,
      [identity.spaceId, id, identity.userId, input.quote_text, JSON.stringify(input.anchor_json), input.expected_quote_text, JSON.stringify(input.expected_anchor_json)]);
    if (!result.rowCount) throw new HttpError(409, "The annotation changed. Reload before adjusting its range.");
    // Never claim range verification from hashes alone. The Reader relocates it
    // against the actual text/tree, just like an initially unverified annotation.
    const updated = (await new PgAnnotationRepository(tx).listAnnotations(identity, target.document_type, target.document_id)).find(item => item.id === id);
    if (!updated?.quote_text) throw new HttpError(404, "Annotation not found");
    return updated;
  });
}
