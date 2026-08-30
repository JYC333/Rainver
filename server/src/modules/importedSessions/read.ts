/**
 * Reading an imported transcript, as one rule.
 *
 * Two callers need it — the module's own read and the thread-reference
 * resolver that copies a session's records into a conversation — and an
 * earlier version gave them a copy each. A transcript's gate is the kind that gets tightened
 * later; two copies means one of them silently keeps the old rule.
 */

import { contentDecisionFromDb } from "../access/contentAccessQuery.js";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { PgImportedSessionRepository, type ImportedSessionRecordRow, type ImportedSessionRow } from "./repository.js";

export interface ImportedSessionRead {
  session: ImportedSessionRow;
  records: ImportedSessionRecordRow[];
  truncated: boolean;
}

export async function readImportedSessionForViewer(
  db: Queryable,
  identity: SpaceUserIdentity,
  sessionId: string,
  options: { limit?: number; includeOversight?: boolean } = {},
): Promise<ImportedSessionRead> {
  // `full`, not merely "not denied": the gate also grants `summary`, and a
  // transcript is the content itself, so summary access must not open it —
  // the same rule Reader and Sources apply.
  //
  // `full` alone does *not* exclude oversight: an admin in a Space with
  // `oversight_mode` of `content` or `full` reaches `full` on a colleague's
  // private session by oversight. That is correct for a person opening the
  // page — oversight is audit — and wrong for a caller that compiles the
  // transcript into something other people read, which passes
  // `includeOversight: false`.
  const decision = await contentDecisionFromDb(
    db,
    identity,
    "imported_session",
    sessionId,
    { includeOversight: options.includeOversight },
  );
  if (decision !== "full") throw new HttpError(404, "Imported session not found");
  const sessions = new PgImportedSessionRepository(db);
  const session = await sessions.byId(identity.spaceId, sessionId);
  if (!session) throw new HttpError(404, "Imported session not found");
  const page = await sessions.records(identity.spaceId, sessionId, options.limit);
  return { session, records: page.records, truncated: page.truncated };
}
