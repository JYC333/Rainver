import { resolveContentCreationContext } from "../access/creationContext";
import { PgActivityRepository } from "../activity/repository";
import { PgKnowledgeRepository } from "../knowledge/repository";
import { HttpError, withDbTransaction, type Queryable } from "../routeUtils/common";
import { getDbPool, type Pool } from "../../db/pool";
import type { ServerConfig } from "../../config";

export type CaptureDestination =
  | "object_marginalia"
  | "project_marginalia"
  | "project_raw"
  | "personal_inbox";

export interface CaptureResult {
  activity_id: string;
  destination: CaptureDestination;
  space_id: string;
  project_id: string | null;
  visibility: "private" | "space_shared";
  status: "raw" | "processed";
  note_id: string | null;
  note_title: string | null;
  /** The note block this capture became, when it was projected into one. */
  block_id: string | null;
}

export interface CaptureInput {
  userId: string;
  requestSpaceId: string;
  destination: CaptureDestination;
  text: string;
  projectId?: string | null;
  targetId?: string | null;
}

const URL_RE = /^https?:\/\/\S+$/i;

const MARGINALIA_DESTINATIONS: ReadonlySet<CaptureDestination> = new Set([
  "object_marginalia",
  "project_marginalia",
]);

/**
 * The single capture entry point behind one floating affordance.
 *
 * Ownership and pipeline are decoupled here, and that is the point: material
 * pasted into a Project is Project-owned but still raw, while a thought typed
 * against a Thread is Project-scoped but private marginalia. Binding the two
 * together — Project implies shared, personal implies reviewed — privatises
 * external material the user meant to give the team, which is the mirror of
 * what ADR 0013 guards against.
 *
 * Every destination writes an `activity_record` first (B9, B12), so a capture
 * has one identity regardless of where it lands. Marginalia additionally
 * projects into a note inside the same transaction, so the felt latency of
 * capturing inside a Project is what it was before the two entries merged.
 */
export class CaptureService {
  constructor(private readonly pool: Pool) {}

  static fromConfig(config: ServerConfig): CaptureService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new CaptureService(getDbPool(config.databaseUrl));
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    return withDbTransaction(this.pool, (client) => this.captureWithin(client, input));
  }

  /**
   * The same capture, joined to a caller's transaction.
   *
   * Relocation needs to write the new capture and remove the old blocks as one
   * act — a relocation that created the destination and then failed to empty
   * the source would duplicate the user's thought, and one that emptied the
   * source first could lose it outright.
   */
  async captureWithin(client: Queryable, input: CaptureInput): Promise<CaptureResult> {
    const projectId = normalizedId(input.projectId);
    const targetId = normalizedId(input.targetId);
    if (input.destination !== "personal_inbox" && !projectId) {
      throw new HttpError(422, "project_id is required for a Project destination");
    }
    if (input.destination === "object_marginalia" && !targetId) {
      throw new HttpError(422, "target_id is required for object marginalia");
    }
    const marginalia = MARGINALIA_DESTINATIONS.has(input.destination);

    {
      // Resolves the Space and re-checks Project writer authority; the personal
      // destination deliberately ignores the Project the user is standing in,
      // which is what makes "a thought unrelated to this project" expressible.
      const creation = await resolveContentCreationContext(client, {
        userId: input.userId,
        requestSpaceId: input.requestSpaceId,
        projectId: input.destination === "personal_inbox" ? null : projectId,
      });
      // ADR 0013 decision 3a: marginalia takes the Project's scope but not its
      // visibility. Decision 3 alone would publish a margin note to the team on
      // the first keystroke.
      // The resolver only ever returns `private` or `space_shared`; narrowing
      // the third ladder rung to `private` keeps the fallback fail-closed
      // rather than widening a capture on a contract change.
      const contextVisibility = creation.visibility === "space_shared" ? "space_shared" : "private";
      const visibility: "private" | "space_shared" = marginalia ? "private" : contextVisibility;
      const isLink = URL_RE.test(input.text);
      const activity = await new PgActivityRepository(client).create(
        { spaceId: creation.spaceId, userId: input.userId },
        {
          source_type: isLink ? "web_capture" : "user_capture",
          content: input.text,
          title: input.text.slice(0, 80),
          visibility,
          ...(isLink ? { source_url: input.text } : {}),
          ...(creation.projectId ? { project_id: creation.projectId } : {}),
        },
      );
      const activityId = String(activity.id);

      if (!marginalia) {
        return {
          activity_id: activityId,
          destination: input.destination,
          space_id: creation.spaceId,
          project_id: creation.projectId,
          visibility,
          status: "raw" as const,
          note_id: null,
          note_title: null,
          block_id: null,
        };
      }

      if (!creation.projectId) throw new HttpError(422, "Marginalia requires a Project destination");
      const projection = await new PgKnowledgeRepository(client).appendMarginalia(
        { spaceId: creation.spaceId, userId: input.userId },
        {
          projectId: creation.projectId,
          targetId: input.destination === "object_marginalia" ? targetId : null,
          text: input.text,
          activityId,
        },
      );
      // Marginalia has no review step, so the record is not raw material
      // waiting for one. It stays as provenance for the note paragraph, and
      // the note — not this snapshot — is the authority on the content.
      const projectedAt = new Date().toISOString();
      await client.query(
        `UPDATE activity_records
            SET status = 'processed',
                processed_at = $3,
                updated_at = $3,
                payload_json = COALESCE(payload_json, '{}'::jsonb) || $4::jsonb
          WHERE id = $1 AND space_id = $2`,
        [activityId, creation.spaceId, projectedAt, JSON.stringify({
          marginalia: {
            note_id: projection.note_id,
            block_id: projection.block_id,
            target_id: input.destination === "object_marginalia" ? targetId : null,
            projected_at: projectedAt,
          },
        })],
      );

      return {
        activity_id: activityId,
        destination: input.destination,
        space_id: creation.spaceId,
        project_id: creation.projectId,
        visibility,
        status: "processed" as const,
        note_id: projection.note_id,
        note_title: projection.note_title,
        block_id: projection.block_id,
      };
    }
  }
}

function normalizedId(value: string | null | undefined): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return id || null;
}
