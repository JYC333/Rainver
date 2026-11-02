import type { BriefingFollowUpPreview, ThreadReferencePick } from "@rainver/protocol";
import { dateIso, HttpError, type Queryable, type SpaceUserIdentity } from "../../routeUtils/common.js";
import { fenced, roomAudience, type ResolvedThreadReference } from "../../rooms/threadReferences.js";
import type { BriefingScopeAdapter } from "./contract.js";
import type { BriefingExecution } from "./execution.js";
import { authorizedHighlight, renderHighlight, scopeLabelOf } from "./highlight.js";
import { PgBriefingRepository } from "./repository.js";
import { adapterForRow } from "./settlement.js";

/**
 * Preparing a follow-up on one highlight: the exact text a conversation in
 * the briefing's own scope would receive. Read-only — nothing is written,
 * sent or run; the person reviews it in a draft and sends it themselves.
 */
export async function prepareFollowUp(
  db: Queryable,
  adapter: BriefingScopeAdapter,
  viewerId: string,
  briefingId: string,
  index: number,
): Promise<BriefingFollowUpPreview> {
  const target = await authorizedHighlight(db, adapter, briefingId, index, viewerId);
  return {
    briefing_id: target.row.id,
    highlight: index,
    scope_type: target.row.scope_type,
    project_id: target.row.project_id,
    title: target.highlight.title,
    preview: renderHighlight(target, await scopeLabelOf(db, target.row)),
  };
}

/**
 * The `briefing_highlight` grain of a Thread Reference, resolved once at
 * attach time (the person's explicit send) under the attacher's identity:
 * - the attacher must still read the briefing, and the highlight must still
 *   stand for its whole audience — and its Sources must consent to every
 *   runtime of the Room's Agents, who will read it;
 * - a Project briefing goes only into a Room of the same Project; a personal
 *   briefing only into a Room whose audience is its owner alone. Its audience
 *   may never grow, so `disclosable: false` refuses any wider target instead
 *   of asking for a confirmation;
 * - the copy is fenced as untrusted: it is a model's synthesis of
 *   third-party material, not a colleague's word.
 */
export async function resolveBriefingHighlightReference(
  db: Queryable,
  identity: SpaceUserIdentity,
  pick: ThreadReferencePick,
  room: { id: string; project_id: string; is_mainline: boolean },
  budget: number,
): Promise<ResolvedThreadReference> {
  if (pick.highlight === undefined) throw new HttpError(422, "A briefing reference names its highlight");
  const row = await new PgBriefingRepository(db).get(identity.spaceId, pick.id);
  if (!row) throw new HttpError(404, "The briefing this reference points at is not available", { code: "reference_source_unavailable" });
  const adapter = adapterForRow(row);
  if (row.scope_type === "project" && row.project_id !== room.project_id) {
    throw new HttpError(422, "A Project briefing can only be discussed in a Room of the same Project", { code: "briefing_reference_scope_mismatch" });
  }
  if (row.scope_type === "personal") {
    if (row.owner_user_id !== identity.userId) throw new HttpError(404, "The briefing this reference points at is not available", { code: "reference_source_unavailable" });
    const audience = await roomAudience(db, identity.spaceId, room);
    if (audience.some((userId) => userId !== identity.userId)) {
      throw new HttpError(409, "A personal briefing can only be discussed in a conversation only you can read", { code: "briefing_reference_scope_mismatch" });
    }
  }
  const egress = await roomExecutions(db, identity.spaceId, room.id);
  const target = await authorizedHighlight(db, adapter, row.id, pick.highlight, identity.userId, egress.length ? { egress } : {});
  const header = `Briefing highlight: ${target.highlight.title}`;
  const limit = Math.max(400, budget * 4);
  const body = renderHighlight(target, await scopeLabelOf(db, row));
  const clipped = body.length > limit;
  return {
    content: fenced(header, clipped ? `${body.slice(0, limit - 1)}…` : body, "external_untrusted"),
    provenance: {
      kind: "briefing_highlight",
      source_id: row.id,
      highlight: target.index,
      source_room_id: null,
      source_title: target.highlight.title.slice(0, 200),
      item_ids: target.evidence.map((entry) => entry.source_item_id),
      trust: "external_untrusted",
      clipped,
      attached_by_user_id: identity.userId,
      attached_at: dateIso(new Date().toISOString())!,
    },
    sourceAudienceUserIds: await adapter.audience(db),
    disclosable: false,
  };
}

/**
 * Every runtime an Agent of this Room may answer on now: the text must be
 * allowed to reach each. An active Agent with no enabled runtime Profile has
 * no execution to check against, so the attach is refused rather than passed
 * on a read check alone; a Room with no Agent is a draft only people read.
 * This is the attach-time check only — each Delivery is gated again on the
 * execution it actually runs on (`referenceDelivery.ts`).
 */
async function roomExecutions(db: Queryable, spaceId: string, roomId: string): Promise<BriefingExecution[]> {
  const rows = (await db.query<{ agent_id: string; runtime_profile_id: string | null }>(
    `SELECT member.agent_id, profile.id AS runtime_profile_id
       FROM room_agent_members member
       JOIN agents agent ON agent.id = member.agent_id AND agent.space_id = member.space_id AND agent.status = 'active'
       LEFT JOIN agent_runtime_profiles profile ON profile.agent_id = member.agent_id AND profile.space_id = member.space_id AND profile.enabled = true
      WHERE member.space_id = $1 AND member.room_id = $2 AND member.status = 'active'
      ORDER BY member.agent_id, profile.id`,
    [spaceId, roomId],
  )).rows;
  if (rows.some((row) => !row.runtime_profile_id)) {
    throw new HttpError(409, "An Agent of this conversation has no runtime to check this briefing's Sources against", { code: "briefing_reference_execution_unresolved" });
  }
  return rows.map((row) => ({ agent_id: row.agent_id, runtime_profile_id: row.runtime_profile_id! }));
}
