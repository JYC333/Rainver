import { randomUUID } from "node:crypto";
import { HttpError, type Queryable, withQueryableTransaction } from "../routeUtils/common";
import { buildSpaceObjectInsert } from "../../db/spaceObjectWriter";
import { assertProjectWriter } from "../projects/access";
import { RetrievalProjectionService } from "../retrieval";
import { knowledgeRetrievalRegistry } from "./retrievalAdapter";
import { blockIds, withBlockIds } from "./noteBlockIds";
import { normalizePmText, type NoteOp } from "./noteDocument";
import { projectOwningCollection } from "./noteProjectFolders";
import { shareSpaceObjectWithProject } from "./spaceObjectProjectShares";
import { assertNoteProjectRole } from "./noteProjectRoles";
import {
  applyNoteOpsWithConflictFallback,
  insertInitialNoteRevision,
  rollbackNote,
  sha256,
  writeNote,
  type NoteContentRow,
  type NoteRevisionSource,
  type NoteWriteResult,
} from "./noteRevisionService";

/**
 * The one way to create or change a note.
 *
 * `noteRevisionService` already owned note *content* — every version gets a
 * revision row, which is what makes rollback trustworthy. What it did not own
 * was everything around a write, and each caller carried its own copy of that:
 *
 * - Creation existed twice. `PgKnowledgeRepository.createNote` and
 *   `projectResearch/areaService.createProjectNote` each assembled the root
 *   row, the extension row, the first revision, and collection membership by
 *   hand. They had drifted: the project one wrote no `summary` and filed every
 *   note at `sort_order` 0, so a Project's four starter notes were ordered by
 *   tie-break.
 * - Reindexing was the caller's job, and only one caller did it. User saves
 *   went through `createNote`/`updateNote` and refreshed the retrieval
 *   projection; every AI write went through `areaService` and did not. A
 *   "current understanding" note an agent had been maintaining for weeks was
 *   stale in search until a human happened to save it by hand.
 * - The Project role was written from three places, one of which knew about
 *   the registry and about displacing the previous holder, and two of which
 *   did not.
 *
 * This is the same argument the `space_objects` writer settles one level down
 * (B12H): a rule enforced at N call sites is missed at the N+1th, and the miss
 * is silent.
 *
 * **Reindexing runs after the transaction commits, not inside it.** The
 * projection is a derived index that can be rebuilt, so a projection failure
 * must not fail the canonical write; but swallowing a database error inside an
 * open transaction poisons it for every later statement. After commit is the
 * only place both hold.
 */
export interface NoteWriteScope {
  /** The transaction. Use it for writes that belong with the note's own. */
  readonly db: Queryable;
  create(input: NoteInsert): Promise<{ id: string; version: number; blockIds: string[] }>;
  write(input: NoteContentInput): Promise<NoteWriteResult>;
  applyOps(input: NoteOpsInput): Promise<{ note: NoteContentRow; conflict: boolean } | null>;
  rollback(input: NoteRollbackInput): Promise<NoteContentRow>;
  /** Assign or clear the note's Project notebook role (N2/N3). */
  setProjectRole(input: NoteProjectRoleInput): Promise<void>;
  /**
   * Marks a note as changed without writing its content — a rename, an
   * archive, a move. Retrieval indexes the title and the status too, so a
   * metadata-only edit still has to reach the projection.
   */
  touch(spaceId: string, noteId: string): Promise<void>;
}

/**
 * Who is making the write, and therefore whether Project write access has to
 * be proved.
 *
 * `system` is for writes with no acting user — starter-note seeding, a
 * monitoring run's edit. It is a named case rather than a nullable user id so
 * that skipping the Project check is a decision visible at the call site.
 */
export type NoteActor = { readonly userId: string } | { readonly system: true };

function actingUserId(actor: NoteActor): string | null {
  return "userId" in actor ? actor.userId : null;
}

export interface NoteInsert {
  spaceId: string;
  actor: NoteActor;
  title: string;
  summary?: string | null;
  visibility?: "private" | "space_shared";
  doc: Record<string, unknown>;
  plainText?: string | null;
  contentFormat?: string;
  contentSchemaVersion?: number | null;
  /** Attribution for the root row. Defaults to the acting user. */
  ownerUserId?: string | null;
  createdByUserId?: string | null;
  createdByRunId?: string | null;
  primaryProjectId?: string | null;
  projectFolderId?: string | null;
  createdFromActivityId?: string | null;
  collectionId?: string | null;
  projectRole?: string | null;
  /**
   * Marks the note as one member's private marginalia for a Project (ADR 0013
   * decision 3a), which is how the capture path finds the same note again
   * without resolving by title. Set together with `marginaliaOwnerUserId`; a
   * CHECK rejects a half-set pair.
   */
  marginaliaProjectId?: string | null;
  marginaliaOwnerUserId?: string | null;
  /** Null for the Project-level note, set for a note about one object. */
  marginaliaTargetObjectId?: string | null;
  at?: string;
}

export interface NoteContentInput {
  spaceId: string;
  noteId: string;
  expectVersion?: number | null;
  content: { kind: "doc"; doc: Record<string, unknown>; plainText?: string | null } | { kind: "ops"; ops: NoteOp[] };
  source: NoteRevisionSource;
  userId?: string | null;
  runId?: string | null;
  refs?: string[];
  diff?: unknown;
}

export interface NoteOpsInput {
  spaceId: string;
  noteId: string;
  baseVersion: number;
  rawOps: unknown[];
  source: NoteRevisionSource;
  runId: string;
  refs: string[];
}

export interface NoteRollbackInput {
  spaceId: string;
  noteId: string;
  toVersion: number;
  userId: string;
}

export interface NoteProjectRoleInput {
  spaceId: string;
  noteId: string;
  actor: NoteActor;
  /** `null` clears the role. */
  role: string | null;
  /**
   * The Project the role is scoped to. Callers that are assigning a role to an
   * existing note pass nothing and let the note's own `primary_project_id`
   * answer; creation passes the Project it is filing the note under.
   */
  projectId?: string | null;
  at?: string;
}

/**
 * Runs note writes in one transaction and refreshes the retrieval projection
 * for every note they touched.
 *
 * Where the refresh happens depends on who owns the transaction, and both
 * cases are load-bearing:
 *
 * - **Given a pool**, this opens the transaction and reindexes after it
 *   commits, on the pool. A projection failure is then logged and dropped,
 *   which is what we want: the index is derived and rebuildable, so losing a
 *   refresh must not undo a write the user already saw succeed.
 * - **Given an already checked-out client** — `withQueryableTransaction` joins
 *   rather than nests, and several callers (report materialization, area
 *   initialization) are already inside someone's transaction — there is no
 *   "after commit" to wait for. The refresh runs inside that transaction,
 *   where it is *consistent by construction*: the projection lives in the same
 *   database, so a rollback takes the index rows with it. It is wrapped in a
 *   savepoint because the swallow above is otherwise a trap — a caught
 *   database error still leaves the surrounding transaction aborted, and every
 *   later statement in it would fail with the original cause hidden.
 */
export async function withNoteWrites<T>(
  db: Queryable,
  run: (scope: NoteWriteScope) => Promise<T>,
): Promise<T> {
  const pool = db as Queryable & { release?: () => void; connect?: () => Promise<unknown> };
  const joined = typeof pool.release === "function" || typeof pool.connect !== "function";
  const touched = new Map<string, string>();
  const result = await withQueryableTransaction(db, (tx) => run(scopeFor(tx, touched)));
  if (joined) await reindexInTransaction(db, touched);
  else await reindexTouched(db, touched);
  return result;
}

function scopeFor(tx: Queryable, touched: Map<string, string>): NoteWriteScope {
  const track = (noteId: string, spaceId: string): void => {
    touched.set(noteId, spaceId);
  };
  const scope: NoteWriteScope = {
    db: tx,
    async create(input) {
      const created = await insertNote(tx, input);
      track(created.id, input.spaceId);
      return created;
    },
    async write(input) {
      const result = await writeNote(tx, input);
      if (result.outcome === "written") track(input.noteId, input.spaceId);
      return result;
    },
    async applyOps(input) {
      const applied = await applyNoteOpsWithConflictFallback(tx, input);
      if (applied) track(input.noteId, input.spaceId);
      return applied;
    },
    async rollback(input) {
      const note = await rollbackNote(tx, input);
      track(input.noteId, input.spaceId);
      return note;
    },
    async setProjectRole(input) {
      await assignNoteProjectRole(tx, input);
      track(input.noteId, input.spaceId);
    },
    async touch(spaceId, noteId) {
      track(noteId, spaceId);
    },
  };
  return scope;
}

/**
 * A projection failure is logged, not raised: `retrieval_objects` is derived
 * from the canonical tables and rebuildable, so losing an index refresh must
 * not undo a write the user already saw succeed.
 */
async function reindexTouched(db: Queryable, touched: Map<string, string>): Promise<void> {
  if (touched.size === 0) return;
  const projection = new RetrievalProjectionService(db, knowledgeRetrievalRegistry);
  for (const [noteId, spaceId] of touched) {
    try {
      await projection.reindex(spaceId, "note", noteId);
    } catch (error) {
      process.stderr.write(
        `[knowledge.retrieval] note reindex failed after commit (${noteId}): ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }
}

/**
 * The joined case: same work, behind a savepoint so a failure is contained.
 *
 * The savepoint is also the capability check. A `Queryable` that is not
 * actually inside a transaction — a test double, or a pool handed in by a
 * caller that only looked like a client — cannot take one, and without one a
 * projection failure would abort whatever transaction *is* open. Skipping the
 * refresh is the safe answer there: the index is rebuildable, the canonical
 * write is not.
 */
async function reindexInTransaction(tx: Queryable, touched: Map<string, string>): Promise<void> {
  if (touched.size === 0) return;
  const projection = new RetrievalProjectionService(tx, knowledgeRetrievalRegistry);
  for (const [noteId, spaceId] of touched) {
    try {
      await tx.query("SAVEPOINT note_reindex");
    } catch (error) {
      process.stderr.write(
        `[knowledge.retrieval] note reindex skipped, no savepoint available (${noteId}): ${String((error as Error)?.message ?? error)}\n`,
      );
      return;
    }
    try {
      await projection.reindex(spaceId, "note", noteId);
      await tx.query("RELEASE SAVEPOINT note_reindex");
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT note_reindex").catch(() => {});
      await tx.query("RELEASE SAVEPOINT note_reindex").catch(() => {});
      process.stderr.write(
        `[knowledge.retrieval] note reindex failed inside caller transaction (${noteId}): ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }
}

/**
 * Creates the root row, the extension row, the first revision, and — when
 * asked — collection membership and a Project role, in that order.
 */
async function insertNote(
  db: Queryable,
  input: NoteInsert,
): Promise<{ id: string; version: number; blockIds: string[] }> {
  const at = input.at ?? new Date().toISOString();
  const actorUserId = actingUserId(input.actor);
  const projectId = input.primaryProjectId ?? null;
  // The rule the Project role made load-bearing: binding a note to a Project
  // is a write to that Project. Before this, any member of the Space could
  // file a note under any Project and then claim its baseline role, which
  // displaces the note the Project's research monitoring reads. A `system`
  // actor has no user to check and is trusted by construction.
  if (projectId && actorUserId) {
    await assertProjectWriter(db, input.spaceId, projectId, actorUserId);
  }
  const objectId = randomUUID();
  // Creation does not pass through `writeNote`, so it stamps its own ids —
  // otherwise a note's first blocks would be the only ones in the system
  // without identity, and a capture that creates its marginalia note would
  // have nothing to anchor on.
  const doc = withBlockIds(input.doc);
  const plainText = input.plainText !== undefined ? input.plainText : normalizePmText(doc);
  const ownerUserId = input.ownerUserId !== undefined ? input.ownerUserId : actorUserId;
  const createdByUserId = input.createdByUserId !== undefined ? input.createdByUserId : actorUserId;
  const object = buildSpaceObjectInsert({
    id: objectId,
    spaceId: input.spaceId,
    objectType: "note",
    title: input.title,
    summary: input.summary ?? (plainText ? plainText.slice(0, 280) : null),
    visibility: input.visibility,
    ownerUserId,
    primaryProjectId: projectId,
    projectFolderId: input.projectFolderId ?? null,
    createdByUserId,
    createdByRunId: input.createdByRunId ?? null,
    createdAt: at,
  });
  const n = object.params.length;
  await db.query(
    `WITH obj AS (
       ${object.sql}
     )
     INSERT INTO notes (
       object_id, space_id, status, content_json, content_format, content_schema_version,
       plain_text, created_from_activity_id, version, content_hash,
       marginalia_project_id, marginalia_owner_user_id, marginalia_target_object_id
     ) VALUES (
       $${n + 1}, $${n + 2}, 'active', $${n + 3}::jsonb, $${n + 4}, COALESCE($${n + 5}::int, 1),
       $${n + 6}, $${n + 7}, 1, $${n + 8},
       $${n + 9}, $${n + 10}, $${n + 11}
     )`,
    [
      ...object.params,
      objectId,
      input.spaceId,
      JSON.stringify(doc),
      input.contentFormat ?? "prosemirror_json",
      input.contentSchemaVersion ?? null,
      plainText,
      input.createdFromActivityId ?? null,
      sha256(plainText ?? ""),
      input.marginaliaProjectId ?? null,
      input.marginaliaOwnerUserId ?? null,
      input.marginaliaTargetObjectId ?? null,
    ],
  );
  await insertInitialNoteRevision(db, {
    spaceId: input.spaceId,
    noteId: objectId,
    doc,
    at,
    userId: createdByUserId,
  });
  if (input.collectionId) {
    await moveNoteToCollection(db, input.spaceId, objectId, input.collectionId, input.actor);
  }
  if (input.projectRole) {
    await assignNoteProjectRole(db, {
      spaceId: input.spaceId,
      noteId: objectId,
      actor: input.actor,
      role: input.projectRole,
      projectId,
      at,
    });
  }
  return { id: objectId, version: 1, blockIds: blockIds(doc).filter((id): id is string => id !== null) };
}

/**
 * Moves a note into a collection, **replacing every existing placement**.
 *
 * This is the "file it here" write behind note creation and an explicit
 * `collection_id` on a note update. Adding a note to a further folder without
 * removing it from the ones it is already in is a different action with
 * different intent — {@link addNotePlacement} — and conflating the two is how
 * a multi-placement schema ends up behaving as if it were single-placement.
 */
export async function moveNoteToCollection(
  db: Queryable,
  spaceId: string,
  noteId: string,
  collectionId: string,
  actor: NoteActor = { system: true },
): Promise<void> {
  await requireNoteCollectionRow(db, spaceId, collectionId);
  const currentPlacements = await db.query<{ collection_id: string }>(
    `SELECT collection_id FROM note_collection_items
      WHERE note_id = $1 AND space_id = $2
      FOR UPDATE`,
    [noteId, spaceId],
  );
  for (const placement of currentPlacements.rows) {
    await assertNoteCollectionProjectWriter(db, spaceId, placement.collection_id, actor);
  }
  await bindNoteToPlacementProject(db, { spaceId, noteId, collectionId, actor });
  await db.query(`DELETE FROM note_collection_items WHERE note_id = $1 AND space_id = $2`, [noteId, spaceId]);
  await insertNotePlacement(db, spaceId, noteId, collectionId);
}

/**
 * Places a note in an *additional* collection, keeping the ones it is already
 * in. `note_collection_items` is unique on `(collection_id, note_id, space_id)`,
 * so the same folder twice is a conflict rather than a second row.
 */
export async function addNotePlacement(
  db: Queryable,
  spaceId: string,
  noteId: string,
  collectionId: string,
  actor: NoteActor = { system: true },
  /**
   * Confirms the cross-Project case: the caller has been told that this also
   * makes the note readable by the other Project's members, and said yes (U8).
   * Absent, a placement into another Project's subtree is still refused.
   */
  shareWithProject = false,
): Promise<void> {
  await requireNoteCollectionRow(db, spaceId, collectionId);
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM note_collection_items WHERE space_id = $1 AND collection_id = $2 AND note_id = $3`,
    [spaceId, collectionId, noteId],
  );
  if (existing.rows[0]) throw new HttpError(409, "This note is already in that folder");
  await bindNoteToPlacementProject(db, { spaceId, noteId, collectionId, actor, shareWithProject });
  await insertNotePlacement(db, spaceId, noteId, collectionId);
}

/**
 * Governance ownership follows the *first* placement into a Project's subtree
 * (U7), and never moves after that.
 *
 * Display ownership is by placement and may be plural: a note in two Projects'
 * folders shows up in both views. `primary_project_id` is not — it is the
 * declaration every `space_objects` subtype inherits, and the read gate
 * (`contentAccessSql`) evaluates it as a hard AND before visibility and grants.
 * So the two rules here:
 *
 * - **No Project yet** → this placement binds the note to that Project, and
 *   binding a note to a Project is a write to it, so a user actor has to be
 *   able to write to it.
 * - **A different Project** → refused *unless the caller confirms a share*.
 *   `primary_project_id` never moves: it is governance ownership and stays with
 *   the first Project. What the confirmation adds is a
 *   `space_object_project_shares` row, which widens the scope half of the read
 *   gate so the second Project's members can actually see what was placed in
 *   their tree. Without it the placement would be a silent absence rather than a
 *   placement, which is why the refusal remains the default (U8: never silent
 *   widening).
 *
 * A Project change also invalidates any baseline role scoped to the old one —
 * a note cannot hold a slot in a Project it no longer belongs to. That guard
 * used to run only when `primary_project_id` was set explicitly through the
 * note update, so a drag carried the role along; it runs here too now.
 */
/**
 * The client's cue to ask rather than to show an error: it re-issues the
 * placement with the share confirmed. A code because matching on prose is how
 * error handling rots.
 */
export const NOTE_CROSS_PROJECT_SHARE_REQUIRED = "note_cross_project_share_required";

export async function bindNoteToPlacementProject(
  db: Queryable,
  input: {
    spaceId: string;
    noteId: string;
    collectionId: string;
    actor: NoteActor;
    shareWithProject?: boolean;
  },
): Promise<void> {
  const placementProjectId = await assertNoteCollectionProjectWriter(
    db,
    input.spaceId,
    input.collectionId,
    input.actor,
  );
  if (!placementProjectId) return;
  const current = await db.query<{ primary_project_id: string | null }>(
    `SELECT primary_project_id FROM space_objects
      WHERE id = $1 AND space_id = $2 AND object_type = 'note' FOR UPDATE`,
    [input.noteId, input.spaceId],
  );
  const currentProjectId = current.rows[0]?.primary_project_id ?? null;
  if (currentProjectId === placementProjectId) return;
  if (currentProjectId) {
    const actorUserId = actingUserId(input.actor);
    if (!input.shareWithProject || !actorUserId) {
      // A machine-readable code, because the client's answer to this is to ask
      // the user rather than to show an error: it re-issues with the share
      // confirmed. Prose alone would make that a string match.
      // `responseBody` replaces the default `{ detail }`, so the prose has to
      // be repeated inside it or the client is left with a bare status.
      const detail = "This note belongs to another project. Placing it here also makes it readable by this project's members.";
      throw new HttpError(409, detail, {
        detail,
        code: NOTE_CROSS_PROJECT_SHARE_REQUIRED,
        owner_project_id: currentProjectId,
      });
    }
    await shareSpaceObjectWithProject(db, {
      spaceId: input.spaceId,
      objectId: input.noteId,
      projectId: placementProjectId,
      ownerProjectId: currentProjectId,
      userId: actorUserId,
    });
    return;
  }
  await db.query(
    `UPDATE space_objects SET primary_project_id = $3 WHERE id = $1 AND space_id = $2`,
    [input.noteId, input.spaceId, placementProjectId],
  );
  await db.query(
    `UPDATE notes SET project_role = NULL, role_project_id = NULL
      WHERE object_id = $1 AND space_id = $2
        AND project_role IS NOT NULL AND role_project_id IS DISTINCT FROM $3`,
    [input.noteId, input.spaceId, placementProjectId],
  );
}

/**
 * A placement inside a Project changes that Project's visible notes tree even
 * when the note was already bound to the same Project. Readers may read the
 * tree, but only Project writers may change that structure.
 */
export async function assertNoteCollectionProjectWriter(
  db: Queryable,
  spaceId: string,
  collectionId: string,
  actor: NoteActor,
): Promise<string | null> {
  const projectId = await projectOwningCollection(db, spaceId, collectionId);
  const actorUserId = actingUserId(actor);
  if (projectId && actorUserId) {
    await assertProjectWriter(db, spaceId, projectId, actorUserId);
  }
  return projectId;
}

/**
 * Removes one placement. Removing the last one is refused rather than silently
 * turning the note into something no tree can show: losing a note is a
 * different decision from taking it out of a folder, and has its own action.
 */
export async function removeNotePlacement(
  db: Queryable,
  spaceId: string,
  noteId: string,
  collectionId: string,
  actor: NoteActor = { system: true },
): Promise<void> {
  await assertNoteCollectionProjectWriter(db, spaceId, collectionId, actor);
  const placements = await db.query<{ collection_id: string }>(
    `SELECT collection_id FROM note_collection_items WHERE space_id = $1 AND note_id = $2 FOR UPDATE`,
    [spaceId, noteId],
  );
  if (!placements.rows.some((row) => row.collection_id === collectionId)) {
    throw new HttpError(404, "This note is not in that folder");
  }
  if (placements.rows.length <= 1) {
    throw new HttpError(422, "A note must stay in at least one folder; delete the note instead");
  }
  await db.query(
    `DELETE FROM note_collection_items WHERE space_id = $1 AND collection_id = $2 AND note_id = $3`,
    [spaceId, collectionId, noteId],
  );
}

async function requireNoteCollectionRow(db: Queryable, spaceId: string, collectionId: string): Promise<void> {
  const exists = await db.query<{ id: string }>(
    `SELECT id FROM note_collections WHERE id = $1 AND space_id = $2`,
    [collectionId, spaceId],
  );
  if (!exists.rows[0]) throw new HttpError(404, "Note collection not found");
}

/**
 * The sort order is `MAX + 1` rather than 0, so a note filed into an ordered
 * folder lands after what is already there instead of jumping to the front —
 * and so a Project's starter notes do not all share order 0 and fall back to
 * whatever tie-break the query happens to produce.
 */
async function insertNotePlacement(
  db: Queryable,
  spaceId: string,
  noteId: string,
  collectionId: string,
): Promise<void> {
  const next = await db.query<{ next_sort_order: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
       FROM note_collection_items WHERE space_id=$1 AND collection_id=$2`,
    [spaceId, collectionId],
  );
  await db.query(
    `INSERT INTO note_collection_items (id, space_id, collection_id, note_id, sort_order, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), spaceId, collectionId, noteId, Number(next.rows[0]?.next_sort_order ?? 0), new Date().toISOString()],
  );
}

/**
 * Assigns or clears a note's Project notebook role (N2/N3).
 *
 * Three code paths used to write `notes.project_role`: this one, the starter
 * note creator, and the one-shot title adoption. Only this one validated the
 * role against the registry and displaced the previous holder, which the
 * partial unique index would otherwise reject — and a silent second baseline
 * is exactly the failure the marker exists to prevent. All three now come
 * here.
 *
 * The role needs a Project: a note with no `primary_project_id` has no
 * Project to hold a role in. Displacing the previous holder is a write to
 * that Project's research baseline, so a user actor has to be able to write
 * to it.
 */
export async function assignNoteProjectRole(db: Queryable, input: NoteProjectRoleInput): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  const role = input.role === null || input.role === undefined || input.role === "" ? null : input.role;
  if (role === null) {
    await db.query(
      `UPDATE notes SET project_role = NULL, role_project_id = NULL WHERE object_id = $1 AND space_id = $2`,
      [input.noteId, input.spaceId],
    );
    return;
  }
  assertNoteProjectRole(role);
  const projectId = input.projectId ?? (await noteProjectId(db, input.spaceId, input.noteId));
  if (!projectId) throw new HttpError(422, "A note must belong to a project before it can hold a project role");
  const actorUserId = actingUserId(input.actor);
  if (actorUserId) {
    await assertProjectWriter(db, input.spaceId, projectId, actorUserId);
  }
  await db.query(
    `UPDATE notes SET project_role = NULL, role_project_id = NULL
      WHERE space_id = $1 AND role_project_id = $2 AND project_role = $3 AND object_id <> $4`,
    [input.spaceId, projectId, role, input.noteId],
  );
  await db.query(
    `UPDATE notes SET project_role = $3, role_project_id = $2 WHERE object_id = $4 AND space_id = $1`,
    [input.spaceId, projectId, role, input.noteId],
  );
  await db.query(
    `UPDATE space_objects SET updated_at = $3 WHERE id = $1 AND space_id = $2`,
    [input.noteId, input.spaceId, at],
  );
}

async function noteProjectId(db: Queryable, spaceId: string, noteId: string): Promise<string | null> {
  const result = await db.query<{ primary_project_id: string | null }>(
    `SELECT primary_project_id FROM space_objects WHERE id = $1 AND space_id = $2 AND object_type = 'note'`,
    [noteId, spaceId],
  );
  return result.rows[0]?.primary_project_id ?? null;
}
