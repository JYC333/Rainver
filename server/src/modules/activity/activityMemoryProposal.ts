/**
 * What an Activity record becomes in Memory, shared by the capture endpoint
 * and the batch consolidation run so the two cannot drift.
 *
 * A personal record becomes the owner's private Memory. A Project's record
 * becomes Project Memory — there is no private Memory under a Project — and
 * only when every reader of the Project can already read the record; the
 * owner shares it with the Project first otherwise. The canonical applier
 * asks the audience question again when the proposal is accepted.
 */
import { sourcesUnreadableBy } from "../memory/memoryAudience.js";
import { projectReaderIds } from "../projects/access.js";
import type { InsertProposalRowInput } from "../proposals/reviewPackets.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";

export interface ConsolidatedActivity {
  id: string;
  user_id: string | null;
  owner_user_id: string | null;
  subject_user_id: string | null;
  project_folder_id: string | null;
  project_id: string | null;
  activity_type: string;
  title: string | null;
  content: string | null;
  source_trust: string | null;
  source_url: string | null;
}

/** Trust implied by an activity type when the record does not carry one. */
export const TRUST_BY_SOURCE_TYPE: Record<string, string> = {
  user_capture: "user_confirmed",
  chat_message: "user_confirmed",
  external_chat: "user_confirmed",
  file_import: "user_confirmed",
  web_capture: "untrusted_external",
  run_event: "internal_system",
  project_folder_event: "internal_system",
  system_event: "internal_system",
  external_source: "untrusted_external",
  source: "internal_system",
};

/** How many of the Project's readers cannot read the record; 0 when none. */
export async function projectReadersMissingActivity(
  db: Queryable,
  spaceId: string,
  activity: Pick<ConsolidatedActivity, "id" | "project_id">,
): Promise<number> {
  if (!activity.project_id) return 0;
  const readers = await projectReaderIds(db, spaceId, activity.project_id);
  const unreadable = await sourcesUnreadableBy(db, spaceId, [{ source_type: "activity", source_id: activity.id }], readers);
  return unreadable[0]?.reader_user_ids.length ?? 0;
}

export function activityMemoryProposal(
  identity: SpaceUserIdentity,
  activity: ConsolidatedActivity,
): InsertProposalRowInput {
  const sourceTrust = activity.source_trust ?? TRUST_BY_SOURCE_TYPE[activity.activity_type] ?? "untrusted_external";
  const placement = activity.project_id
    ? { target_scope: "project", target_visibility: "space_shared", project_id: activity.project_id }
    : {
        target_scope: "user",
        target_visibility: "private",
        owner_user_id: activity.owner_user_id ?? activity.user_id ?? identity.userId,
      };
  return {
    spaceId: identity.spaceId,
    proposalType: "memory_create",
    title: activity.title || `Activity: ${(activity.content ?? "").slice(0, 80)}`,
    rationale: "Activity consolidation generated a memory proposal.",
    payload: {
      operation: "create",
      proposed_content: activity.content ?? "",
      memory_type: "experience",
      target_namespace: "activity.consolidation",
      ...placement,
      subject_user_id: activity.subject_user_id ?? activity.user_id ?? identity.userId,
      source_activity_id: activity.id,
      activity_source_trust: sourceTrust,
      provenance_entries: [
        {
          source_type: "activity",
          source_id: activity.id,
          source_trust: sourceTrust,
          evidence_json: { activity_type: activity.activity_type, source_url: activity.source_url },
        },
      ],
    },
    createdByUserId: identity.userId,
    projectFolderId: activity.project_folder_id,
    projectId: activity.project_id,
    // Project Memory is decided by the Project's reviewers, who can all read
    // the record it comes from; a personal one is the owner's alone.
    visibility: activity.project_id ? "space_shared" : "private",
    riskLevel: "low",
  };
}
