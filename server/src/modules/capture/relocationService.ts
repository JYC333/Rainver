import { HttpError, withDbTransaction, type Queryable } from "../routeUtils/common.js";
import { getDbPool, type Pool } from "../../db/pool.js";
import type { ServerConfig } from "../../config.js";
import { PgKnowledgeRepository } from "../knowledge/repository.js";
import { noteBlocks, removeBlocks } from "../knowledge/noteBlockIds.js";
import { withNoteWrites } from "../knowledge/noteWriter.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { resolveContentCreationContext } from "../access/creationContext.js";
import { CaptureService, type CaptureDestination } from "./service.js";
import {
  assertRelocationMode,
  canMoveCapture,
  recordEgress,
  relocationCandidates,
  spaceAllowsCopyOut,
  type CaptureRow,
  type RelocationBlock,
  type RelocationMode,
} from "./relocation.js";

export interface RelocationPreview {
  activity_id: string;
  note_id: string;
  blocks: RelocationBlock[];
  can_move: boolean;
  can_copy_out: boolean;
}

export interface RelocationResult {
  activity_id: string;
  destination: CaptureDestination;
  mode: RelocationMode;
  moved_block_ids: string[];
  note_id: string | null;
  block_id: string | null;
}

/**
 * Relocation, and the promotion path that shares its machinery.
 *
 * The two are one mechanism because they are the same act seen from different
 * ends: moving a private margin note into the Project's raw material *is*
 * promoting it to team material. Building them separately would mean two
 * implementations of "take these blocks out of that note and make them
 * something else", which is the part that is hard to get right.
 *
 * Authority on the content is **the note's current text**, never the capture's
 * `activity_record` snapshot. The snapshot is provenance and is allowed to
 * drift; treating it as authority would silently discard every edit the user
 * made after capturing, which is data loss dressed up as a feature.
 */
export class RelocationService {
  constructor(private readonly pool: Pool) {}

  static fromConfig(config: ServerConfig): RelocationService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new RelocationService(getDbPool(config.databaseUrl));
  }

  async preview(input: { userId: string; activityId: string }): Promise<RelocationPreview> {
    return withDbTransaction(this.pool, async (client) => {
      const capture = await loadCapture(client, input.userId, input.activityId);
      if (!capture.note_id || !capture.block_id) {
        throw new HttpError(409, "This capture was not projected into a note, so there is nothing to relocate");
      }
      const { blocks, otherAnchors } = await noteState(client, input.userId, capture);
      return {
        activity_id: capture.id,
        note_id: capture.note_id,
        blocks: relocationCandidates(blocks, capture.block_id, otherAnchors),
        can_move: await canMoveCapture(client, capture, input.userId),
        can_copy_out: await spaceAllowsCopyOut(client, capture.space_id),
      };
    });
  }

  async relocate(input: {
    userId: string;
    requestSpaceId: string;
    activityId: string;
    destination: CaptureDestination;
    mode: RelocationMode;
    blockIds: string[];
    projectId?: string | null;
    targetId?: string | null;
  }): Promise<RelocationResult> {
    assertRelocationMode(input.mode);
    if (input.blockIds.length === 0) throw new HttpError(422, "Select at least one block to relocate");

    return withDbTransaction(this.pool, async (client) => {
      const capture = await loadCapture(client, input.userId, input.activityId);
      if (!capture.note_id || !capture.block_id) {
        throw new HttpError(409, "This capture was not projected into a note, so there is nothing to relocate");
      }
      // Locked before its text is read, and held for the rest of the
      // transaction. Reading the blocks unlocked left a window in which a
      // concurrent editor could rewrite the paragraph between the read and the
      // removal: the relocation would carry the *pre-edit* text while deleting
      // the post-edit block, silently losing the other person's edit.
      await lockNote(client, capture);
      const { blocks, otherAnchors } = await noteState(client, input.userId, capture);
      const offered = new Set(
        relocationCandidates(blocks, capture.block_id, otherAnchors).map((block) => block.block_id),
      );
      // Only the blocks the preview offered. Without this the client could name
      // any block in the note — including a colleague's paragraph — and have it
      // carried out of the Space.
      for (const id of input.blockIds) {
        if (!offered.has(id)) throw new HttpError(422, "Block is not part of this capture's selection");
      }

      // Where the content actually lands, resolved before anything is written
      // and before anything is authorised.
      //
      // Gating on the requested *destination name* was wrong in a way that
      // reads as fine: `personal_inbox` is not the only destination that can
      // leave the Space. Every Project destination resolves its Space from the
      // caller-supplied `project_id`, and a caller who belongs to two Spaces
      // could name a Project in the other one — carrying the content across
      // the boundary with the copy-out gate never consulted, because the
      // destination was not called `personal_inbox`. B4 is a property of where
      // the row ends up, so that is what has to be tested.
      const destinationSpaceId = await resolveDestinationSpace(client, input);
      const leavingSpace = destinationSpaceId !== capture.space_id;

      if (input.mode === "move" && !(await canMoveCapture(client, capture, input.userId))) {
        throw new HttpError(403, "Moving this capture requires being its owner or administering the Project");
      }
      // The Space gate applies to *other people's* content, not your own.
      //
      // Taking your own misfiled thought back out is the remedy that makes
      // capture's inferred defaults acceptable in the first place — a paste
      // defaults to the Project's team-visible raw material, and if that guess
      // cannot be undone the guess should never have been made. Gating it
      // behind a Space setting that is off by default would remove exactly the
      // capability the outward direction exists for.
      //
      // Someone else's content is the case the setting is for: a second holder
      // outside the boundary, which is the Space's decision to permit.
      const ownContent = capture.owner_user_id === input.userId;
      if (leavingSpace && !ownContent && !(await spaceAllowsCopyOut(client, capture.space_id))) {
        throw new HttpError(403, "This Space does not allow taking another member's content into a personal Space");
      }

      // The note's current text, not the capture snapshot.
      const selected = blocks.filter((block) => block.id && input.blockIds.includes(block.id));
      const text = selected.map((block) => block.text).filter(Boolean).join("\n\n");
      if (!text) throw new HttpError(422, "The selected blocks are empty");

      const written = await new CaptureService(this.pool).captureWithin(client, {
        userId: input.userId,
        requestSpaceId: input.requestSpaceId,
        destination: input.destination,
        text,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      });
      // The resolver is the authority on the Space, so the prediction the gate
      // ran on is checked against what actually happened rather than trusted.
      if (written.space_id !== destinationSpaceId) {
        throw new HttpError(409, "Relocation destination changed while resolving; retry");
      }

      if (input.mode === "move") {
        await removeFromSourceNote(client, capture, input.blockIds, input.userId);
      }
      // Every crossing is announced, move or copy. A move leaves the Space too
      // — it just also takes the original with it.
      if (leavingSpace) {
        await recordEgress(client, {
          sourceSpaceId: capture.space_id,
          actorUserId: input.userId,
          activityId: capture.id,
          noteId: capture.note_id,
          blockCount: input.blockIds.length,
          at: new Date().toISOString(),
        });
      }

      return {
        activity_id: written.activity_id,
        destination: input.destination,
        mode: input.mode,
        moved_block_ids: input.blockIds,
        note_id: written.note_id,
        block_id: written.block_id,
      };
    });
  }
}

/**
 * The Space the destination resolves to, using the same resolver the write path
 * uses so the gate and the write cannot disagree about where content lands.
 */
async function resolveDestinationSpace(
  db: Queryable,
  input: { userId: string; requestSpaceId: string; destination: CaptureDestination; projectId?: string | null },
): Promise<string> {
  const creation = await resolveContentCreationContext(db, {
    userId: input.userId,
    requestSpaceId: input.requestSpaceId,
    projectId: input.destination === "personal_inbox" ? null : (input.projectId ?? null),
  });
  return creation.spaceId;
}

/**
 * The capture must be one the caller can actually read, and must be a real
 * capture.
 *
 * The read gate is applied here rather than left to the note read downstream.
 * It was in fact enforced — `noteState` goes through `getNote`, which gates —
 * but by a different module for an unrelated reason, and the "was this ever
 * projected into a note" check runs first, so a colleague's private capture
 * answered 409 where a nonexistent one answered 404. A small oracle, and a real
 * hole the moment a relocation path appears that does not read the note.
 */
async function loadCapture(db: Queryable, userId: string, activityId: string): Promise<CaptureRow> {
  const result = await db.query<CaptureRow & { marginalia: { note_id?: string; block_id?: string } | null }>(
    `SELECT ar.id, ar.space_id, ar.owner_user_id, ar.project_id, ar.content,
            ar.payload_json -> 'marginalia' AS marginalia
       FROM activity_records ar
       JOIN space_memberships membership
         ON membership.space_id = ar.space_id
        AND membership.user_id = $2
        AND membership.status = 'active'
      WHERE ar.id = $1 AND ar.discarded_at IS NULL
        AND ${contentReadSql("activity", "ar", "$2")}
      LIMIT 1
      FOR UPDATE OF ar`,
    [activityId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "Capture not found");
  return {
    id: row.id,
    space_id: row.space_id,
    owner_user_id: row.owner_user_id,
    project_id: row.project_id,
    content: row.content,
    note_id: row.marginalia?.note_id ?? null,
    block_id: row.marginalia?.block_id ?? null,
  };
}

/**
 * The source note's blocks, plus the anchors of every *other* capture in it —
 * the boundary a run of orphan blocks stops at.
 */
async function noteState(db: Queryable, userId: string, capture: CaptureRow) {
  const note = await new PgKnowledgeRepository(db).getNote(
    { spaceId: capture.space_id, userId },
    capture.note_id!,
  );
  if (!note) throw new HttpError(404, "Capture note not found");
  const anchors = await db.query<{ block_id: string }>(
    `SELECT payload_json -> 'marginalia' ->> 'block_id' AS block_id
       FROM activity_records
      WHERE space_id = $1
        AND payload_json -> 'marginalia' ->> 'note_id' = $2
        AND id <> $3
        AND payload_json -> 'marginalia' ->> 'block_id' IS NOT NULL`,
    [capture.space_id, capture.note_id, capture.id],
  );
  return {
    blocks: noteBlocks(note.content_json),
    otherAnchors: new Set(anchors.rows.map((row) => row.block_id)),
  };
}

/** Take the relocated blocks out, leaving every other block byte-identical. */
async function removeFromSourceNote(
  db: Queryable,
  capture: CaptureRow,
  blockIds: string[],
  userId: string,
): Promise<void> {
  await withNoteWrites(db, async (scope) => {
    const current = await scope.db.query<{ content_json: unknown; version: number }>(
      `SELECT content_json, version FROM notes WHERE object_id = $1 AND space_id = $2`,
      [capture.note_id, capture.space_id],
    );
    if (!current.rows[0]) throw new HttpError(404, "Capture note not found");
    const result = await scope.write({
      spaceId: capture.space_id,
      noteId: capture.note_id!,
      // The version is passed rather than omitted. Without it `writeNote` skips
      // the check and can only ever answer "written", which made the conflict
      // branch below unreachable — a guard that reads as protection while
      // protecting nothing.
      expectVersion: current.rows[0].version,
      content: { kind: "doc", doc: removeBlocks(current.rows[0].content_json, blockIds) },
      source: "user_edit",
      userId,
    });
    if (result.outcome !== "written") {
      throw new HttpError(409, "Note changed while relocating; reload and retry", {
        current_version: result.currentVersion,
      });
    }
  });
}

/**
 * Take the source note's row lock for the whole relocation.
 *
 * `getNote` applies the read gate but takes no lock, so this runs first and the
 * lock is held until the transaction ends.
 */
async function lockNote(db: Queryable, capture: CaptureRow): Promise<void> {
  const locked = await db.query(
    `SELECT object_id FROM notes WHERE object_id = $1 AND space_id = $2 FOR UPDATE`,
    [capture.note_id, capture.space_id],
  );
  if (!locked.rows[0]) throw new HttpError(404, "Capture note not found");
}
