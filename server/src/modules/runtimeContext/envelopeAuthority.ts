import { usesIsolatedAgentContext } from "../agents/projectContextIsolation.js";
import type { ContextItem, ExecutionControlSnapshot, RetrievalObjectType, RuntimeContextEnvelope } from "@rainver/protocol";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/repository.js";
import type { ReleaseGroup } from "../retrieval/releaseClosure.js";
import { isVendorCliAdapter } from "../runtimeAdapters/specs.js";
import { isRoomConversation } from "./productionAcquisition.js";
import { isExplicitReferenceType } from "./workContextService.js";

/**
 * The Projects a Delivery or preview release gate locks, discovered without
 * locks so the gate can share-lock all of them, in id order, before Space,
 * Folder, Room and Run. Project archive takes the Project `FOR UPDATE` and
 * then cancels its workflow Runs `FOR UPDATE`; a Project share taken after
 * the Run share would wait on archive while archive waits on the Run.
 *
 * Mirrors every Project lock the gate's owner checks take after the Run:
 * the Run's and control's Project; the Rooms' Projects (the Room-scoped Agent
 * read); the Projects of the automations whose workflow this Run belongs to;
 * the Agent's content ACL Projects and its Folder's; briefing reference and
 * version closures; Reading Method authority; each Evidence Matrix release
 * closure; Brief/Instruction versions; retrieval items (their own, shared and
 * Folder Projects, a public summary's and a Thread's Project); and, for a
 * preview release, its Work Context's effective Project and its retrieval
 * release closure. A Project the gate reaches that is not in this set is a
 * 409 (`assertProjectHeld`), never a lock taken after the Run.
 */
export async function discoverEnvelopeProjects(
  db: Queryable,
  input: { spaceId: string; invocationId: string; envelope: RuntimeContextEnvelope; viewerUserId?: string | null },
  control: ExecutionControlSnapshot,
  items: readonly ContextItem[],
  run: EnvelopeRun,
  roomIds: readonly string[],
  extra: { retrievalGroups?: readonly ReleaseGroup[]; workContextProject?: string | null } = {},
): Promise<string[]> {
  const { spaceId } = input;
  const projects = new Set<string | null | undefined>([control.project_id, run.project_id, extra.workContextProject]);
  const add = (ids: Iterable<string | null | undefined>) => { for (const id of ids) projects.add(id); };
  if (roomIds.length) {
    add((await db.query<{ project_id: string | null }>(
      `SELECT project_id FROM rooms WHERE space_id=$1 AND id=ANY($2::varchar[])`, [spaceId, [...roomIds]],
    )).rows.map((row) => row.project_id));
  }
  add((await db.query<{ project_id: string | null }>(
    `SELECT automation.project_id FROM workflow_executions execution
       JOIN automations automation ON automation.id=execution.automation_id AND automation.space_id=execution.space_id
      WHERE execution.space_id=$1 AND execution.root_run_id=$2
     UNION
     SELECT automation.project_id FROM workflow_execution_node_runs link
       JOIN workflow_execution_nodes node ON node.id=link.node_id AND node.space_id=link.space_id
       JOIN workflow_executions execution ON execution.id=node.execution_id AND execution.space_id=node.space_id
       JOIN automations automation ON automation.id=execution.automation_id AND automation.space_id=execution.space_id
      WHERE link.space_id=$1 AND link.run_id=$2`,
    [spaceId, input.invocationId],
  )).rows.map((row) => row.project_id));
  const roomUsage = roomIds.length > 0;
  if (control.agent_id && !roomUsage) add(await contentAclProjects(db, spaceId, "agent", control.agent_id));
  if (control.project_folder_id) {
    add((await db.query<{ project_id: string | null }>(
      `SELECT project_id FROM project_folders WHERE space_id=$1 AND id=$2`, [spaceId, control.project_folder_id],
    )).rows.map((row) => row.project_id));
  }
  const briefing = await import("../informationDigest/briefing/referenceDelivery.js");
  const currentRef = input.envelope.turn_request.current_message_ref;
  if (currentRef.type === "message" && isRoomConversation(run.model_override_json)
    && isVendorCliAdapter(run.runtime_key) && run.session_id && run.agent_id) {
    add(await briefing.briefingReferenceProjects(db, spaceId, await briefing.pendingBriefingReferences(db, {
      spaceId, sessionId: run.session_id, currentMessageId: currentRef.id, agentId: run.agent_id,
    })));
  }
  if (currentRef.type === "message" && run.session_id && items.some((item) => item.acquisition === "continuity")) {
    const { loadConversationContinuityThroughMessage } = await import("./conversationContinuity.js");
    const continuity = await loadConversationContinuityThroughMessage(db, {
      spaceId, sessionId: run.session_id,
      workContextScopeId: input.envelope.turn_request.work_context_scope_id, currentMessageId: currentRef.id,
    });
    add(await briefing.briefingReferenceProjects(db, spaceId, continuity.messages));
  }
  const settlement = await import("../informationDigest/briefing/settlement.js");
  const briefingRun = settlement.briefingRunContext(run);
  if (briefingRun) {
    const requester = (await db.query<{ requested_by_user_id: string }>(
      `SELECT requested_by_user_id FROM information_briefings WHERE space_id=$1 AND id=$2`, [spaceId, briefingRun.id],
    )).rows[0]?.requested_by_user_id;
    if (requester) add(await briefing.briefingVersionProjects(db, spaceId, briefingRun.id, requester));
  }
  const workflow = (run.contract_snapshot_json as { workflow_input_json?: Record<string, unknown> } | null)?.workflow_input_json;
  if (workflow?.source_collection || workflow?.reading_method || workflow?.reading_method_trial || workflow?.reading_method_generation) {
    const { PgRunRepository } = await import("../runs/repository.js");
    const full = await new PgRunRepository(db).getRun(spaceId, input.invocationId);
    if (full) add(await readingRunProjects(db, full));
  }
  for (const item of items) {
    if (item.acquisition === "direct" && item.source_ref.type === "project_research_evidence_matrix") {
      const { artifactReleaseAuthority } = await import("../contentAccess/demotionReleaseClosure.js");
      add((await artifactReleaseAuthority(db, spaceId, [item.source_ref.id])).projects);
    } else if (item.acquisition === "retrieval") {
      add(await retrievalItemProjects(db, spaceId, item.source_ref.type as RetrievalObjectType, item.source_ref.id));
    } else if (item.acquisition === "explicit" || (item.acquisition === "direct" && isExplicitReferenceType(item.source_ref.type))) {
      const table = item.source_ref.type === "project_brief_version" ? "project_brief_versions"
        : item.source_ref.type === "project_instruction_version" ? "project_instruction_versions" : null;
      if (table) {
        add((await db.query<{ project_id: string }>(
          `SELECT project_id FROM ${table} WHERE space_id=$1 AND id=$2`, [spaceId, item.source_ref.id],
        )).rows.map((row) => row.project_id));
      }
    }
  }
  if (extra.retrievalGroups?.length) {
    const { retrievalReleaseProjects } = await import("../retrieval/releaseClosure.js");
    add(await retrievalReleaseProjects(db, spaceId, extra.retrievalGroups));
  }
  if (roomUsage && await usesIsolatedAgentContext(db, spaceId, control.agent_id, control.project_id)) {
    if ([...projects].some(project => project && project !== control.project_id)) {
      throw new HttpError(409, "Isolated Room execution cannot receive another Project's context");
    }
  }
  return [...projects].filter((id): id is string => typeof id === "string" && id.length > 0).sort();
}

/** The Run columns the gate reads; discovered once without a lock, then locked. */
export interface EnvelopeRun {
  project_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  runtime_key: string | null;
  model_override_json: unknown;
  prompt: string | null;
  instruction: string | null;
  contract_snapshot_json: unknown;
  root_run_id: string | null;
}

/**
 * The Projects `lockContentAclDependencies` may lock for one content row: its
 * own Project, its mandatory retained access Project, every Project it is shared to (only consulted when it has a
 * Project of its own), and its Folder's Project.
 */
export async function contentAclProjects(db: Queryable, spaceId: string, resourceType: string, resourceId: string): Promise<string[]> {
  const definition = contentResourceDefinition(resourceType);
  if (!definition) return [];
  const row = (await db.query<{ project_id: string | null; access_project_id: string | null; project_folder_id: string | null }>(
    `SELECT ${definition.projectColumn ? `${definition.projectColumn} AS project_id` : "NULL::varchar AS project_id"},
            ${definition.accessProjectColumn ? `${definition.accessProjectColumn} AS access_project_id` : "NULL::varchar AS access_project_id"},
            ${definition.projectFolderColumn ? `${definition.projectFolderColumn} AS project_folder_id` : "NULL::varchar AS project_folder_id"}
       FROM ${definition.tableName} WHERE space_id=$1 AND id=$2`,
    [spaceId, resourceId],
  )).rows[0];
  if (!row) return [];
  const out: string[] = row.access_project_id ? [row.access_project_id] : [];
  if (row.project_id) {
    out.push(row.project_id);
    if (definition.projectShare) {
      out.push(...(await db.query<{ project_id: string }>(
        `SELECT ${definition.projectShare.projectColumn} AS project_id FROM ${definition.projectShare.tableName}
          WHERE space_id=$1 AND ${definition.projectShare.resourceColumn}=$2 AND ${definition.projectShare.revokedColumn} IS NULL`,
        [spaceId, resourceId],
      )).rows.map((share) => share.project_id));
    }
  }
  if (row.project_folder_id) {
    const folder = (await db.query<{ project_id: string | null }>(
      `SELECT project_id FROM project_folders WHERE space_id=$1 AND id=$2`, [spaceId, row.project_folder_id],
    )).rows[0];
    if (folder?.project_id) out.push(folder.project_id);
  }
  return out;
}

const RETRIEVAL_CONTENT_TYPES: Partial<Record<RetrievalObjectType, string>> = {
  knowledge_item: "space_object", note: "space_object", source: "space_object", claim: "space_object",
  memory_entry: "memory", source_item: "source_item", extracted_evidence: "extracted_evidence",
};

/** The Projects the retrieval owner check locks for one ranked item. */
export async function retrievalItemProjects(db: Queryable, spaceId: string, objectType: RetrievalObjectType, objectId: string): Promise<string[]> {
  const out: string[] = [];
  if (objectType === "project_public_summary") out.push(objectId);
  const contentType = RETRIEVAL_CONTENT_TYPES[objectType];
  if (contentType) out.push(...await contentAclProjects(db, spaceId, contentType, objectId));
  const own = objectType === "inquiry_thread"
    ? "SELECT project_id FROM inquiry_threads WHERE space_id=$1 AND object_id=$2"
    : objectType === "memory_entry" ? "SELECT project_id FROM memory_entries WHERE space_id=$1 AND id=$2"
    : objectType === "source_item" ? "SELECT project_id FROM source_items WHERE space_id=$1 AND id=$2"
    : objectType === "extracted_evidence" ? "SELECT project_id FROM extracted_evidence WHERE space_id=$1 AND id=$2"
    : contentType === "space_object"
      ? "SELECT folder.project_id FROM space_objects object LEFT JOIN project_folders folder ON folder.id=object.project_folder_id AND folder.space_id=object.space_id WHERE object.space_id=$1 AND object.id=$2"
      : null;
  if (own) {
    const projectId = (await db.query<{ project_id: string | null }>(own, [spaceId, objectId])).rows[0]?.project_id;
    if (projectId) out.push(projectId);
  }
  if (objectType === "extracted_evidence") {
    const evidence = (await db.query<{ source_item_id: string | null; source_snapshot_id: string | null; source_object_id: string | null }>(
      `SELECT COALESCE(source_item_id,origin_source_item_id) AS source_item_id,source_snapshot_id,source_object_id
         FROM extracted_evidence WHERE space_id=$1 AND id=$2`,
      [spaceId, objectId],
    )).rows[0];
    if (evidence?.source_item_id) out.push(...await contentAclProjects(db, spaceId, "source_item", evidence.source_item_id));
    if (evidence?.source_snapshot_id) out.push(...await contentAclProjects(db, spaceId, "source_snapshot", evidence.source_snapshot_id));
    if (evidence?.source_object_id) out.push(...await contentAclProjects(db, spaceId, "space_object", evidence.source_object_id));
  }
  return out;
}

/**
 * Everything `lockReadingRunAuthority` locks for a Reading Run, read without
 * locks: the Evolution asset, the deep read original, every dependency, the
 * Following goal refs and the Project audiences in their canonical order.
 */
export async function readingRunAuthority(db: Queryable, full: RunRecord) {
  const reading = await import("../prompts/reading/dispatch.js");
  const generation = await import("../prompts/reading/generationContract.js");
  const ref = generation.generationOf(full);
  const runs = await reading.readingDependencyRuns(db, full);
  let assetId: string | null = null;
  if (ref || runs.length > 1) {
    const { readingAsset } = await import("../prompts/reading/access.js");
    const asset = await readingAsset(db, { spaceId: full.space_id, userId: full.instructed_by_user_id! }, false,
      ref?.target_key ?? (full.contract_snapshot_json as { workflow_input_json?: { reading_method_trial?: { target_key?: string } } })?.workflow_input_json?.reading_method_trial?.target_key);
    assetId = asset.id;
  }
  const { followingRefOf } = await import("../sources/readingMethods/followingContext.js");
  const following = runs.map(followingRefOf).filter((r): r is NonNullable<typeof r> => !!r).sort((a, b) => a.goal_id.localeCompare(b.goal_id));
  const dependencies: Array<{ itemId: string | null; projectId: string | null; connectionId: string | null; artifactId: string | null; caseId: string | null; readerUserId?:string }> = [];
  for (const run of runs) { const deps = await reading.readingRunDependencies(db, run); if (deps) dependencies.push(deps); }
  const annotation=(await import('../sourceAnnotation/dispatch.js')).annotationRunContext(full);
  for(const item of annotation?.items??[])dependencies.push({itemId:item.id,connectionId:item.connection_id,readerUserId:item.responsible_user_id,projectId:null,artifactId:null,caseId:null});
  const deep = (await import("../sources/index.js")).deepReadOf(full);
  if (deep?.following) dependencies.push({ itemId: null, projectId: deep.project_id, connectionId: deep.following.connection_id, artifactId: null, caseId: null });
  const goalProjects = following.length
    ? (await db.query<{ project_id: string | null }>(`SELECT project_id FROM source_goals WHERE space_id=$1 AND id=ANY($2::varchar[])`, [full.space_id, following.map((r) => r.goal_id)])).rows.map((r) => r.project_id)
    : [];
  const audienceProjects = [...new Set([...dependencies.map((d) => d.projectId), ...goalProjects].filter((id): id is string => !!id))].sort();
  dependencies.sort((a, b) => (a.itemId ?? a.connectionId ?? "").localeCompare(b.itemId ?? b.connectionId ?? ""));
  return { assetId, deep, following, dependencies, audienceProjects };
}

/** Every Project `lockReadingRunAuthority` locks: the audiences and the dependencies' content ACL Projects. */
async function readingRunProjects(db: Queryable, full: RunRecord): Promise<string[]> {
  const authority = await readingRunAuthority(db, full);
  const out = [...authority.audienceProjects];
  for (const deps of authority.dependencies) {
    if (deps.itemId) out.push(...await contentAclProjects(db, full.space_id, "source_item", deps.itemId));
    if (deps.connectionId) out.push(...await contentAclProjects(db, full.space_id, "source_connection", deps.connectionId));
    if (deps.artifactId) out.push(...await contentAclProjects(db, full.space_id, "artifact", deps.artifactId));
  }
  return out;
}

/** Refuses, before any lock, a Room this gate did not take before its Run. */
export function assertRoomsHeld(rooms: readonly (string | null)[], held: readonly string[]): void {
  if (rooms.some((room) => room && !held.includes(room))) {
    throw new HttpError(409, "Invocation Delivery Room authority changed; read again");
  }
}
